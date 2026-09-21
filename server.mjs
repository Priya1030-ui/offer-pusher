import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "web");
const CONFIG_FILE = path.join(ROOT, "config.local.json");
const PORT = Number(process.env.PORT || 8787);
const execFileAsync = promisify(execFile);
const LARK_CLI = process.env.LARK_CLI_PATH || "lark-cli";
const DEFAULT_PREVIEW_OPEN_ID = process.env.FEISHU_PREVIEW_OPEN_ID || "";
const DEFAULT_WIKI_URL = process.env.FEISHU_WIKI_URL || "";
const DEFAULT_TABLE_ID = process.env.FEISHU_TABLE_ID || "";
const DEFAULT_VIEW_ID = process.env.FEISHU_VIEW_ID || "";
const LOGIN_REQUIRED = process.env.FEISHU_LOGIN_REQUIRED === "true";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const oauthStates = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const session = getSession(request);

    if (request.method === "GET" && url.pathname === "/api/me") {
      return sendJson(response, {
        ok: true,
        loginRequired: LOGIN_REQUIRED,
        user: session?.user || null,
      });
    }

    if (request.method === "GET" && url.pathname === "/login") {
      return redirectToFeishuLogin(request, response);
    }

    if (request.method === "GET" && url.pathname === "/auth/callback") {
      return handleFeishuCallback(url, request, response);
    }

    if (request.method === "GET" && url.pathname === "/logout") {
      clearSession(request, response);
      response.writeHead(302, { Location: "/" });
      response.end();
      return;
    }

    if (LOGIN_REQUIRED && !session && isProtectedPath(url.pathname)) {
      if (url.pathname.startsWith("/api/")) {
        return sendJson(response, { ok: false, error: "请先用飞书账号登录。" }, 401);
      }
      response.writeHead(302, { Location: "/login" });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return sendJson(response, publicConfig(loadConfig()));
    }

    if (request.method === "GET" && url.pathname === "/api/local-offers") {
      return sendJson(response, {
        ok: true,
        rows: readLocalOffers(),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/config") {
      if (LOGIN_REQUIRED && process.env.ALLOW_CONFIG_EDIT !== "true") {
        return sendJson(response, { ok: false, error: "公网模式不允许从页面修改应用配置。" }, 403);
      }
      const nextConfig = await readJson(request);
      const currentConfig = loadConfig();
      const merged = {
        ...currentConfig,
        ...cleanConfig(nextConfig),
      };
      if (!nextConfig.appSecret && currentConfig.appSecret) {
        merged.appSecret = currentConfig.appSecret;
      }
      saveConfig(merged);
      return sendJson(response, publicConfig(merged));
    }

    if (request.method === "POST" && url.pathname === "/api/sync") {
      const input = await readJson(request);
      const config = mergeRequestConfig(input.config);
      const result = await syncRecords(config);
      if (result.appToken) config.appToken = result.appToken;
      saveConfig(config);
      return sendJson(response, result);
    }

    if (request.method === "POST" && url.pathname === "/api/send") {
      const input = await readJson(request);
      const config = mergeRequestConfig(input.config);
      const rows = Array.isArray(input.rows) ? input.rows : [];
      const target = input.target || {};

      if (!rows.length) {
        throw userError("请先选择至少一行数据。");
      }

      const card = buildOfferCard(rows, {
        titlePrefix: config.titlePrefix || "校招Offer开奖参考",
        dateText: normalizeDate(input.dateText || todayInShanghai()),
        isPreview: target.kind === "self",
        sourceText:
          config.sourceText || "整理自Offershow等校招薪资分享中高可信度及热门案例",
      });

      const sent = await sendCard(config, card, target);
      saveConfig(config);
      return sendJson(response, { ok: true, sent });
    }

    if (request.method === "GET") {
      return serveStatic(url.pathname, response);
    }

    response.writeHead(405);
    response.end("Method Not Allowed");
  } catch (error) {
    const status = error.expose ? 400 : 500;
    sendJson(response, { ok: false, error: error.message }, status);
  }
});

server.listen(PORT, () => {
  console.log(`Offer 推送控制台已启动：http://localhost:${PORT}`);
});

function isProtectedPath(pathname) {
  return pathname === "/" || pathname.startsWith("/api/") || pathname.endsWith(".html");
}

function publicBaseUrl(request) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
  const proto = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return `${proto}://${host}`;
}

function redirectToFeishuLogin(request, response) {
  const config = loadConfig();
  ensure(config.appId, "请配置 FEISHU_APP_ID。");

  const state = crypto.randomBytes(18).toString("base64url");
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const redirectUri = `${publicBaseUrl(request)}/auth/callback`;
  const loginUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/index");
  loginUrl.searchParams.set("app_id", config.appId);
  loginUrl.searchParams.set("redirect_uri", redirectUri);
  loginUrl.searchParams.set("state", state);

  response.writeHead(302, {
    Location: loginUrl.toString(),
    "Set-Cookie": serializeCookie("oauth_state", state, {
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(request),
      maxAge: 10 * 60,
    }),
  });
  response.end();
}

async function handleFeishuCallback(url, request, response) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.cookie || "");

  if (!code) throw userError("飞书登录失败：缺少授权码。");
  if (!state || cookies.oauth_state !== state || !oauthStates.has(state)) {
    throw userError("飞书登录失败：state 校验不通过，请重新登录。");
  }
  oauthStates.delete(state);

  const config = loadConfig();
  const redirectUri = `${publicBaseUrl(request)}/auth/callback`;
  const user = await getFeishuLoginUser(config, code, redirectUri);
  assertAllowedUser(user);

  const sessionId = crypto.randomBytes(32).toString("base64url");
  sessions.set(sessionId, {
    user,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  response.writeHead(302, {
    Location: "/",
    "Set-Cookie": [
      serializeCookie("offer_sid", sessionId, {
        httpOnly: true,
        sameSite: "Lax",
        secure: isHttps(request),
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      }),
      serializeCookie("oauth_state", "", {
        httpOnly: true,
        sameSite: "Lax",
        secure: isHttps(request),
        maxAge: 0,
      }),
    ],
  });
  response.end();
}

async function getFeishuLoginUser(config, code, redirectUri) {
  const appTokenPayload = await fetchJson(`${config.baseUrl || "https://open.feishu.cn"}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    body: {
      app_id: config.appId,
      app_secret: config.appSecret,
    },
  });
  const appAccessToken = appTokenPayload.app_access_token;
  ensure(appAccessToken, "获取飞书 app_access_token 失败。");

  const tokenPayload = await fetchJson(`${config.baseUrl || "https://open.feishu.cn"}/open-apis/authen/v1/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appAccessToken}`,
    },
    body: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    },
  });
  const loginData = tokenPayload.data || tokenPayload;
  const userAccessToken = loginData.access_token;
  ensure(userAccessToken, "获取飞书用户 access_token 失败。");

  const userInfoPayload = await fetchJson(`${config.baseUrl || "https://open.feishu.cn"}/open-apis/authen/v1/user_info`, {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
    },
  });
  const info = userInfoPayload.data || userInfoPayload;
  return {
    openId: info.open_id || loginData.open_id || "",
    unionId: info.union_id || loginData.union_id || "",
    name: info.name || info.en_name || "飞书用户",
    avatarUrl: info.avatar_url || "",
  };
}

function assertAllowedUser(user) {
  const allowed = splitEnvList(process.env.FEISHU_ALLOWED_OPEN_IDS);
  if (allowed.length && !allowed.includes(user.openId)) {
    throw userError("你的飞书账号不在允许访问名单里。");
  }
}

function getSession(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  const sessionId = cookies.offer_sid;
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function clearSession(request, response) {
  const cookies = parseCookies(request.headers.cookie || "");
  if (cookies.offer_sid) sessions.delete(cookies.offer_sid);
  response.setHeader(
    "Set-Cookie",
    serializeCookie("offer_sid", "", {
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(request),
      maxAge: 0,
    }),
  );
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  parts.push("Path=/");
  return parts.join("; ");
}

function isHttps(request) {
  return request.headers["x-forwarded-proto"] === "https";
}

function serveStatic(requestPath, response) {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end("Not Found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(response);
}

function readLocalOffers() {
  const file = path.join(ROOT, "offers.tsv");
  if (!fs.existsSync(file)) return [];

  const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const header = rows.shift().split("\t");
  const index = Object.fromEntries(header.map((name, column) => [name, column]));

  return rows
    .filter(Boolean)
    .map((line, rowIndex) => {
      const cells = line.split("\t");
      return {
        id: `local-${rowIndex + 1}`,
        company: cells[index["公司"]] || "",
        track: cells[index["序列"]] || "",
        role: cells[index["岗位"]] || "",
        degree: cells[index["学历"]] || "",
        salary: cells[index["薪资"]] || "",
        note: cells[index["备注"]] || "",
      };
    });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      baseUrl: process.env.FEISHU_BASE_URL || "https://open.feishu.cn",
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      appToken: process.env.FEISHU_APP_TOKEN || "",
      previewOpenId: process.env.FEISHU_PREVIEW_OPEN_ID || DEFAULT_PREVIEW_OPEN_ID,
      chatId: process.env.FEISHU_GROUP_CHAT_ID || "",
      tableId: process.env.FEISHU_TABLE_ID || DEFAULT_TABLE_ID,
      viewId: process.env.FEISHU_VIEW_ID || DEFAULT_VIEW_ID,
      wikiUrl: process.env.FEISHU_WIKI_URL || DEFAULT_WIKI_URL,
      titlePrefix: process.env.OFFER_TITLE_PREFIX || "校招Offer开奖参考",
      sourceText:
        process.env.OFFER_SOURCE_TEXT ||
        "整理自Offershow等校招薪资分享中高可信度及热门案例",
    };
  }
  return applyEnvDefaults(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cleanConfig(config), null, 2)}\n`, "utf8");
}

function publicConfig(config) {
  const { appSecret, ...safe } = config;
  if (LOGIN_REQUIRED) {
    return {
      baseUrl: safe.baseUrl,
      wikiUrl: "",
      appId: "",
      appToken: "",
      tableId: "",
      viewId: "",
      previewOpenId: "",
      chatId: safe.chatId || "",
      titlePrefix: safe.titlePrefix,
      sourceText: safe.sourceText,
      hasAppSecret: Boolean(appSecret || process.env.FEISHU_APP_SECRET),
    };
  }
  return {
    ...safe,
    hasAppSecret: Boolean(appSecret),
  };
}

function cleanConfig(config) {
  const allowed = [
    "baseUrl",
    "appId",
    "appSecret",
    "appToken",
    "wikiUrl",
    "tableId",
    "viewId",
    "previewOpenId",
    "chatId",
    "titlePrefix",
    "sourceText",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, String(config[key] ?? "").trim()]),
  );
}

function mergeRequestConfig(config) {
  const current = loadConfig();
  const incoming = cleanConfig(config || {});
  const merged = { ...current, ...incoming };
  if (!incoming.appSecret && current.appSecret) {
    merged.appSecret = current.appSecret;
  }
  merged.appId ||= process.env.FEISHU_APP_ID || "";
  merged.appSecret ||= process.env.FEISHU_APP_SECRET || "";
  merged.appToken ||= process.env.FEISHU_APP_TOKEN || "";
  merged.previewOpenId ||= process.env.FEISHU_PREVIEW_OPEN_ID || DEFAULT_PREVIEW_OPEN_ID;
  merged.chatId ||= process.env.FEISHU_GROUP_CHAT_ID || "";
  merged.tableId ||= process.env.FEISHU_TABLE_ID || DEFAULT_TABLE_ID;
  merged.viewId ||= process.env.FEISHU_VIEW_ID || DEFAULT_VIEW_ID;
  merged.wikiUrl ||= process.env.FEISHU_WIKI_URL || DEFAULT_WIKI_URL;
  return merged;
}

function applyEnvDefaults(config) {
  return {
    ...config,
    baseUrl: config.baseUrl || process.env.FEISHU_BASE_URL || "https://open.feishu.cn",
    appId: config.appId || process.env.FEISHU_APP_ID || "",
    appSecret: config.appSecret || process.env.FEISHU_APP_SECRET || "",
    appToken: config.appToken || process.env.FEISHU_APP_TOKEN || "",
    previewOpenId: config.previewOpenId || process.env.FEISHU_PREVIEW_OPEN_ID || DEFAULT_PREVIEW_OPEN_ID,
    chatId: config.chatId || process.env.FEISHU_GROUP_CHAT_ID || "",
    tableId: config.tableId || process.env.FEISHU_TABLE_ID || DEFAULT_TABLE_ID,
    viewId: config.viewId || process.env.FEISHU_VIEW_ID || DEFAULT_VIEW_ID,
    wikiUrl: config.wikiUrl || process.env.FEISHU_WIKI_URL || DEFAULT_WIKI_URL,
    titlePrefix: config.titlePrefix || process.env.OFFER_TITLE_PREFIX || "校招Offer开奖参考",
    sourceText:
      config.sourceText ||
      process.env.OFFER_SOURCE_TEXT ||
      "整理自Offershow等校招薪资分享中高可信度及热门案例",
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function syncRecords(config) {
  if (!config.appSecret && fs.existsSync(LARK_CLI)) {
    return syncRecordsWithCli(config);
  }

  ensure(config.appId, "请填写飞书 App ID。");
  ensure(config.appSecret, "请填写飞书 App Secret。");
  ensure(config.tableId, "请填写表格 table_id。");

  const token = await getTenantAccessToken(config);
  const appToken = config.appToken || (await resolveAppToken(config, token));
  ensure(appToken, "请填写 app_token，或填写可解析的飞书多维表格/wiki 链接。");

  const records = [];
  let pageToken = "";
  do {
    const url = new URL(
      `${config.baseUrl || "https://open.feishu.cn"}/open-apis/bitable/v1/apps/${appToken}/tables/${config.tableId}/records`,
    );
    url.searchParams.set("page_size", "500");
    if (config.viewId) url.searchParams.set("view_id", config.viewId);
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const payload = await getJson(url, token);
    const data = payload.data || {};
    records.push(...(data.items || []));
    pageToken = data.page_token || "";
    if (!data.has_more) break;
  } while (pageToken);

  const rows = records.map((record) => normalizeRecord(record));
  return {
    ok: true,
    appToken,
    rows,
    syncedAt: new Date().toISOString(),
  };
}

async function syncRecordsWithCli(config) {
  ensure(config.wikiUrl, "请保留飞书多维表格链接。");

  const resolved = await runLarkCliJson([
    "base",
    "+url-resolve",
    "--url",
    config.wikiUrl,
    "--as",
    "user",
    "--json",
  ]);
  const coordinates = extractBaseCoordinates(resolved, config);
  ensure(coordinates.baseToken, "CLI 没能从链接解析出 base_token。");
  ensure(coordinates.tableId, "CLI 没能从链接解析出 table_id。");

  const args = [
    "base",
    "+record-list",
    "--base-token",
    coordinates.baseToken,
    "--table-id",
    coordinates.tableId,
    "--field-id",
    "公司",
    "--field-id",
    "序列",
    "--field-id",
    "岗位",
    "--field-id",
    "学历",
    "--field-id",
    "薪资",
    "--field-id",
    "其他备注",
    "--json",
    "--as",
    "user",
  ];
  if (coordinates.viewId || config.viewId) {
    args.splice(6, 0, "--view-id", coordinates.viewId || config.viewId);
  }

  const payload = await runLarkCliJson(args);
  const rows = normalizeCliRecordList(payload);

  return {
    ok: true,
    via: "lark-cli",
    appToken: coordinates.baseToken,
    rows,
    syncedAt: new Date().toISOString(),
  };
}

async function runLarkCliJson(args) {
  try {
    const { stdout } = await execFileAsync(LARK_CLI, args, {
      cwd: ROOT,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    return JSON.parse(stdout || "{}");
  } catch (error) {
    const text = error.stdout || error.stderr || error.message;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw userError(text);
    }

    const detail = payload.error || payload;
    if (detail.subtype === "token_missing" || /need_user_authorization/.test(detail.message || "")) {
      throw userError(
        "飞书 CLI 还没有完成用户授权。请在终端运行：lark-cli auth login --scope \"base:block:read base:field:read base:record:read wiki:node:retrieve\" --no-wait --json",
      );
    }
    throw userError(detail.message || JSON.stringify(payload));
  }
}

function extractBaseCoordinates(payload, fallback) {
  const candidates = [payload, payload.data, payload.resource, payload.data?.resource].filter(Boolean);
  const merged = Object.assign({}, ...candidates);
  return {
    baseToken: merged.base_token || merged.app_token || merged.token || fallback.appToken,
    tableId: merged.table_id || fallback.tableId,
    viewId: merged.view_id || fallback.viewId,
  };
}

function normalizeCliRecord(record, index) {
  const fields = record.fields || record.record?.fields || record;
  return {
    id: record.record_id || record.id || `cli-${index + 1}`,
    company: fieldText(fields["公司"]),
    track: fieldText(fields["序列"]),
    role: fieldText(fields["岗位"]),
    degree: fieldText(fields["学历"]),
    salary: fieldText(fields["薪资"]),
    note: fieldText(fields["备注"]),
    raw: fields,
  };
}

function normalizeCliRecordList(payload) {
  const data = payload.data || {};
  if (Array.isArray(data.data) && Array.isArray(data.fields)) {
    const fieldIndex = Object.fromEntries(data.fields.map((name, index) => [name, index]));
    return data.data.map((cells, index) => ({
      id: data.record_id_list?.[index] || `cli-${index + 1}`,
      company: cells[fieldIndex["公司"]] || "",
      track: cells[fieldIndex["序列"]] || "",
      role: cells[fieldIndex["岗位"]] || "",
      degree: cells[fieldIndex["学历"]] || "",
      salary: cells[fieldIndex["薪资"]] || "",
      note: cells[fieldIndex["备注"]] || cells[fieldIndex["其他备注"]] || "",
    }));
  }

  const items = data.items || data.records || [];
  return items.map((record, index) => normalizeCliRecord(record, index));
}

async function resolveAppToken(config, token) {
  const parsed = parseFeishuUrl(config.wikiUrl || "");
  if (parsed.appToken) return parsed.appToken;
  if (!parsed.wikiToken) return "";

  const url = new URL(`${config.baseUrl || "https://open.feishu.cn"}/open-apis/wiki/v2/spaces/get_node`);
  url.searchParams.set("token", parsed.wikiToken);
  const payload = await getJson(url, token);
  const node = payload.data?.node || payload.data || {};
  if (node.obj_type && node.obj_type !== "bitable") {
    throw userError(`这个 Wiki 节点类型是 ${node.obj_type}，不是多维表格。请直接填写 app_token。`);
  }
  return node.obj_token || "";
}

function parseFeishuUrl(value) {
  if (!value) return {};
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const tableId = url.searchParams.get("table") || "";
    const viewId = url.searchParams.get("view") || "";
    if (parts[0] === "base" && parts[1]) {
      return { appToken: parts[1], tableId, viewId };
    }
    if (parts[0] === "wiki" && parts[1]) {
      return { wikiToken: parts[1], tableId, viewId };
    }
  } catch {
    return {};
  }
  return {};
}

function normalizeRecord(record) {
  const fields = record.fields || {};
  return {
    id: record.record_id,
    company: fieldText(fields["公司"]),
    track: fieldText(fields["序列"]),
    role: fieldText(fields["岗位"]),
    degree: fieldText(fields["学历"]),
    salary: fieldText(fields["薪资"]),
    note: fieldText(fields["备注"] ?? fields["其他备注"]),
    raw: fields,
  };
}

function fieldText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => fieldText(item)).filter(Boolean).join("、");
  }
  if (typeof value === "object") {
    return (
      value.text ||
      value.name ||
      value.en_name ||
      value.email ||
      value.link ||
      value.url ||
      Object.values(value).map((item) => fieldText(item)).filter(Boolean).join("、")
    );
  }
  return String(value);
}

async function sendCard(config, card, target) {
  if (!config.appSecret && fs.existsSync(LARK_CLI)) {
    return sendCardWithCli(config, card, target);
  }

  ensure(config.appId, "请填写飞书 App ID。");
  ensure(config.appSecret, "请填写飞书 App Secret。");

  const token = await getTenantAccessToken(config);
  const receiveIdType = target.kind === "self" ? "open_id" : "chat_id";
  const receiveId = target.kind === "self" ? config.previewOpenId : target.chatId || config.chatId;
  ensure(receiveId, target.kind === "self" ? "请填写本人 open_id。" : "请填写群聊 chat_id。");

  const payload = await postJson(
    `${config.baseUrl || "https://open.feishu.cn"}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    token,
    {
      receive_id: receiveId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  );

  return {
    receiveIdType,
    receiveId: mask(receiveId),
    messageId: payload.data?.message_id || "",
  };
}

async function sendCardWithCli(config, card, target) {
  const receiveId = target.kind === "self" ? config.previewOpenId || (await getCliOpenId()) : target.chatId || config.chatId;
  ensure(receiveId, target.kind === "self" ? "未识别到本人 open_id，请先完成飞书 CLI 授权。" : "请填写群聊 chat_id。");

  const args = [
    "im",
    "+messages-send",
    target.kind === "self" ? "--user-id" : "--chat-id",
    receiveId,
    "--msg-type",
    "interactive",
    "--content",
    JSON.stringify(card),
    "--as",
    "bot",
    "--json",
  ];
  const payload = await runLarkCliJson(args);
  return {
    via: "lark-cli",
    receiveIdType: target.kind === "self" ? "open_id" : "chat_id",
    receiveId: mask(receiveId),
    messageId: payload.data?.message_id || payload.message_id || "",
  };
}

async function getCliOpenId() {
  const status = await runLarkCliJson(["auth", "status"]);
  return status.identities?.user?.openId || "";
}

async function getTenantAccessToken(config) {
  const payload = await fetchJson(`${config.baseUrl || "https://open.feishu.cn"}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    body: {
      app_id: config.appId,
      app_secret: config.appSecret,
    },
  });

  if (!payload.tenant_access_token) {
    throw userError(`获取 tenant_access_token 失败：${payload.msg || JSON.stringify(payload)}`);
  }
  return payload.tenant_access_token;
}

async function getJson(url, token) {
  return fetchJson(String(url), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

async function postJson(url, token, body) {
  return fetchJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok || (payload.code && payload.code !== 0)) {
    throw userError(payload.msg || `接口返回异常：HTTP ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

function buildOfferCard(items, options) {
  const elements = [];

  items.forEach((item, index) => {
    if (index > 0) elements.push({ tag: "hr", margin: "6px 0" });
    elements.push(
      {
        tag: "markdown",
        text_size: "offer_title",
        margin: "0px",
        content: [
          `**<font color='blue'>${index + 1}.</font> ${escapeMd(item.company)} · ${escapeMd(item.role)}**`,
        ].join("\n"),
      },
      {
        tag: "markdown",
        text_size: "normal",
        margin: "-2px 0 0 0",
        content: [
          `📌 序列： ${escapeMd(item.track)}   🎓 学历： ${escapeMd(item.degree)}`,
          `💰 薪资： <font color='red'>**${escapeMd(formatSalary(item.salary))}**</font>`,
          item.note ? `✍️ 备注： ${escapeMd(item.note)}` : "",
        ].filter(Boolean).join("\n"),
      },
    );
  });

  elements.push({
    tag: "markdown",
    text_size: "caption",
    margin: "8px 0 0 0",
    content: `<font color='grey'>${escapeMd(options.sourceText)}</font>`,
  });

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      style: {
        text_size: {
          offer_title: {
            default: "heading-4",
            pc: "heading-4",
            mobile: "heading-4",
          },
          body: {
            default: "normal",
            pc: "normal",
            mobile: "normal",
          },
          caption: {
            default: "notation",
            pc: "notation",
            mobile: "notation",
          },
        },
      },
    },
    header: {
      template: "wathet",
      title: {
        tag: "plain_text",
        content: `${options.titlePrefix}-${options.dateText}期`,
      },
      text_tag_list: options.isPreview
        ? [
            {
              tag: "text_tag",
              text: {
                tag: "plain_text",
                content: "本人预览",
              },
              color: "blue",
            },
          ]
        : [],
    },
    body: {
      direction: "vertical",
      padding: "16px 20px 18px 20px",
      vertical_spacing: "small",
      elements,
    },
  };
}

function todayInShanghai() {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function normalizeDate(input) {
  const compact = String(input).replace(/\D/g, "");
  if (compact.length !== 8) throw userError("日期请使用 YYYYMMDD 或 YYYY-MM-DD。");
  return compact;
}

function escapeMd(value) {
  return String(value ?? "").replace(/[\\`*_{}\[\]()#+\-.!|]/g, "\\$&");
}

function formatSalary(value) {
  return String(value ?? "").replace(/\*/g, "×").replace(/x/gi, "×");
}

function splitEnvList(value) {
  return (value || "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function ensure(value, message) {
  if (!value) throw userError(message);
}

function userError(message) {
  const error = new Error(message);
  error.expose = true;
  return error;
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function mask(value) {
  const text = String(value);
  if (text.length <= 10) return "***";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}
