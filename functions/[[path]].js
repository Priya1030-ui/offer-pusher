const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  try {
    const session = await getSession(request, env);
    const loginRequired = env.FEISHU_LOGIN_REQUIRED === "true";

    if (request.method === "GET" && url.pathname === "/api/me") {
      return json({
        ok: true,
        loginRequired,
        user: session?.user || null,
      });
    }

    if (request.method === "GET" && url.pathname === "/login") {
      return redirectToFeishuLogin(request, env);
    }

    if (request.method === "GET" && url.pathname === "/auth/callback") {
      return handleFeishuCallback(request, env);
    }

    if (request.method === "GET" && url.pathname === "/logout") {
      return redirect("/", [
        cookie("offer_session", "", request, { maxAge: 0 }),
        cookie("oauth_state", "", request, { maxAge: 0 }),
      ]);
    }

    if (loginRequired && !session && isProtectedPath(url.pathname)) {
      if (url.pathname.startsWith("/api/")) {
        return json({ ok: false, error: "请先用飞书账号登录。" }, 401);
      }
      return redirect("/login");
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return json(publicConfig(loadConfig(env), env));
    }

    if (request.method === "GET" && url.pathname === "/api/local-offers") {
      return json({ ok: true, rows: [] });
    }

    if (request.method === "POST" && url.pathname === "/api/config") {
      return json({ ok: false, error: "公网模式不允许从页面修改应用配置。" }, 403);
    }

    if (request.method === "POST" && url.pathname === "/api/sync") {
      const input = await request.json();
      const config = mergeRequestConfig(input.config, env);
      const result = await syncRecords(config);
      return json(result);
    }

    if (request.method === "POST" && url.pathname === "/api/send") {
      const input = await request.json();
      const config = mergeRequestConfig(input.config, env);
      const rows = Array.isArray(input.rows) ? input.rows : [];
      const target = input.target || {};

      if (!rows.length) throw userError("请先选择至少一行数据。");

      const card = buildOfferCard(rows, {
        titlePrefix: config.titlePrefix || "校招Offer开奖参考",
        dateText: normalizeDate(input.dateText || todayInShanghai()),
        isPreview: target.kind === "self",
        sourceText: config.sourceText || "整理自Offershow等校招薪资分享中高可信度及热门案例",
      });

      const sent = await sendCard(config, card, target);
      return json({ ok: true, sent });
    }

    if (request.method === "GET") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Method Not Allowed", { status: 405 });
  } catch (error) {
    return json({ ok: false, error: error.message || String(error) }, error.expose ? 400 : 500);
  }
}

function isProtectedPath(pathname) {
  return pathname === "/" || pathname.startsWith("/api/") || pathname.endsWith(".html");
}

function loadConfig(env) {
  return {
    baseUrl: env.FEISHU_BASE_URL || "https://open.feishu.cn",
    appId: env.FEISHU_APP_ID || "",
    appSecret: env.FEISHU_APP_SECRET || "",
    appToken: env.FEISHU_APP_TOKEN || "",
    wikiUrl: env.FEISHU_WIKI_URL || "",
    tableId: env.FEISHU_TABLE_ID || "",
    viewId: env.FEISHU_VIEW_ID || "",
    previewOpenId: env.FEISHU_PREVIEW_OPEN_ID || "",
    chatId: env.FEISHU_GROUP_CHAT_ID || "",
    titlePrefix: env.OFFER_TITLE_PREFIX || "校招Offer开奖参考",
    sourceText: env.OFFER_SOURCE_TEXT || "整理自Offershow等校招薪资分享中高可信度及热门案例",
  };
}

function publicConfig(config, env) {
  if (env.FEISHU_LOGIN_REQUIRED === "true") {
    return {
      baseUrl: config.baseUrl,
      wikiUrl: "",
      appId: "",
      appToken: "",
      tableId: "",
      viewId: "",
      previewOpenId: "",
      chatId: config.chatId || "",
      titlePrefix: config.titlePrefix,
      sourceText: config.sourceText,
      hasAppSecret: Boolean(config.appSecret),
    };
  }

  const { appSecret, ...safe } = config;
  return { ...safe, hasAppSecret: Boolean(appSecret) };
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
      .filter((key) => config?.[key] !== undefined)
      .map((key) => [key, String(config[key] ?? "").trim()]),
  );
}

function mergeRequestConfig(config, env) {
  return {
    ...loadConfig(env),
    ...cleanConfig(config || {}),
    appId: env.FEISHU_APP_ID || "",
    appSecret: env.FEISHU_APP_SECRET || "",
    appToken: env.FEISHU_APP_TOKEN || "",
    wikiUrl: env.FEISHU_WIKI_URL || "",
    tableId: env.FEISHU_TABLE_ID || "",
    viewId: env.FEISHU_VIEW_ID || "",
    previewOpenId: env.FEISHU_PREVIEW_OPEN_ID || "",
    chatId: env.FEISHU_GROUP_CHAT_ID || cleanConfig(config || {}).chatId || "",
  };
}

async function redirectToFeishuLogin(request, env) {
  const config = loadConfig(env);
  ensure(config.appId, "请配置 FEISHU_APP_ID。");

  const state = randomToken();
  const redirectUri = `${publicBaseUrl(request, env)}/auth/callback`;
  const loginUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/index");
  loginUrl.searchParams.set("app_id", config.appId);
  loginUrl.searchParams.set("redirect_uri", redirectUri);
  loginUrl.searchParams.set("state", state);

  return redirect(loginUrl.toString(), [cookie("oauth_state", state, request, { maxAge: 10 * 60 })]);
}

async function handleFeishuCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.get("cookie") || "");

  if (!code) throw userError("飞书登录失败：缺少授权码。");
  if (!state || cookies.oauth_state !== state) {
    throw userError("飞书登录失败：state 校验不通过，请重新登录。");
  }

  const config = loadConfig(env);
  const redirectUri = `${publicBaseUrl(request, env)}/auth/callback`;
  const user = await getFeishuLoginUser(config, code, redirectUri);
  const access = getAccessDecision(user, env);
  if (!access.allowed) {
    return sendAccessDenied(access, user);
  }

  const session = {
    user,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  return redirect("/", [
    cookie("offer_session", await signSession(session, env), request, {
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    }),
    cookie("oauth_state", "", request, { maxAge: 0 }),
  ]);
}

async function getFeishuLoginUser(config, code, redirectUri) {
  const appTokenPayload = await fetchJson(`${config.baseUrl}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    body: {
      app_id: config.appId,
      app_secret: config.appSecret,
    },
  });
  const appAccessToken = appTokenPayload.app_access_token;
  ensure(appAccessToken, "获取飞书 app_access_token 失败。");

  const tokenPayload = await fetchJson(`${config.baseUrl}/open-apis/authen/v1/access_token`, {
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

  const userInfoPayload = await fetchJson(`${config.baseUrl}/open-apis/authen/v1/user_info`, {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
    },
  });
  const info = userInfoPayload.data || userInfoPayload;
  return {
    openId: info.open_id || loginData.open_id || "",
    unionId: info.union_id || loginData.union_id || "",
    tenantKey: info.tenant_key || loginData.tenant_key || info.tenant?.tenant_key || info.tenant?.key || "",
    name: info.name || info.en_name || "飞书用户",
    avatarUrl: info.avatar_url || "",
  };
}

function getAccessDecision(user, env) {
  const allowedTenants = splitEnvList(env.FEISHU_ALLOWED_TENANT_KEYS || env.FEISHU_ALLOWED_TENANT_KEY);
  const allowedOpenIds = splitEnvList(env.FEISHU_ALLOWED_OPEN_IDS);

  if (!allowedTenants.length && !allowedOpenIds.length) {
    return {
      allowed: false,
      reason: "未配置允许访问的飞书企业。",
      setupHint: user.tenantKey
        ? `请在 Cloudflare Pages 添加环境变量 FEISHU_ALLOWED_TENANT_KEYS=${user.tenantKey}`
        : "飞书登录未返回企业标识，请确认应用已开启网页应用登录能力。",
    };
  }

  if (allowedTenants.length) {
    if (!user.tenantKey) {
      return {
        allowed: false,
        reason: "飞书登录未返回企业标识，无法确认是否属于公司组织。",
      };
    }
    if (!allowedTenants.includes(user.tenantKey)) {
      return {
        allowed: false,
        reason: "当前飞书账号不属于允许访问的公司组织。",
      };
    }
    return { allowed: true };
  }

  if (allowedOpenIds.length && !allowedOpenIds.includes(user.openId)) {
    return {
      allowed: false,
      reason: "你的飞书账号不在允许访问名单里。",
    };
  }
  return { allowed: true };
}

function sendAccessDenied(access, user) {
  return new Response(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>无法访问</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fa; color: #1f2329; }
      main { width: min(560px, calc(100vw - 32px)); background: #fff; border: 1px solid #dee0e3; border-radius: 8px; padding: 28px; box-shadow: 0 16px 48px rgba(31,35,41,.08); }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 10px 0; line-height: 1.7; color: #4e5969; }
      code { display: block; margin-top: 8px; padding: 10px 12px; border-radius: 6px; background: #f2f3f5; color: #245bdb; overflow-wrap: anywhere; }
      a { color: #245bdb; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>无法访问小推送助手</h1>
      <p>${escapeHtml(access.reason)}</p>
      ${access.setupHint ? `<p>管理员配置提示：<code>${escapeHtml(access.setupHint)}</code></p>` : ""}
      ${user.tenantKey ? `<p>当前飞书企业标识：<code>${escapeHtml(user.tenantKey)}</code></p>` : ""}
      <p><a href="/logout">重新登录</a></p>
    </main>
  </body>
</html>`, {
    status: 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  if (!cookies.offer_session) return null;
  return readSignedSession(cookies.offer_session, env);
}

async function signSession(session, env) {
  const payload = btoaUtf8(JSON.stringify(session));
  return `${payload}.${await hmac(payload, sessionSecret(env))}`;
}

async function readSignedSession(value, env) {
  const secret = sessionSecret(env);
  if (!value || !secret) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature || signature !== await hmac(payload, secret)) return null;

  try {
    const session = JSON.parse(atobUtf8(payload));
    if (!session?.user || !session.expiresAt || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function sessionSecret(env) {
  return env.SESSION_SECRET || env.FEISHU_APP_SECRET || "";
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

function btoaUtf8(value) {
  return base64Url(new TextEncoder().encode(value));
}

function atobUtf8(value) {
  return new TextDecoder().decode(base64UrlDecode(value));
}

function base64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function syncRecords(config) {
  ensure(config.appId, "请配置飞书 App ID。");
  ensure(config.appSecret, "请配置飞书 App Secret。");
  ensure(config.tableId, "请配置表格 table_id。");

  const token = await getTenantAccessToken(config);
  const appToken = config.appToken || (await resolveAppToken(config, token));
  ensure(appToken, "请配置 app_token，或配置可解析的飞书多维表格/wiki 链接。");

  const records = [];
  let pageToken = "";
  do {
    const url = new URL(`${config.baseUrl}/open-apis/bitable/v1/apps/${appToken}/tables/${config.tableId}/records`);
    url.searchParams.set("page_size", "500");
    if (config.viewId) url.searchParams.set("view_id", config.viewId);
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const payload = await getJson(url, token);
    const data = payload.data || {};
    records.push(...(data.items || []));
    pageToken = data.page_token || "";
    if (!data.has_more) break;
  } while (pageToken);

  return {
    ok: true,
    appToken,
    rows: records.map((record) => normalizeRecord(record)),
    syncedAt: new Date().toISOString(),
  };
}

async function resolveAppToken(config, token) {
  const parsed = parseFeishuUrl(config.wikiUrl || "");
  if (parsed.appToken) return parsed.appToken;
  if (!parsed.wikiToken) return "";

  const url = new URL(`${config.baseUrl}/open-apis/wiki/v2/spaces/get_node`);
  url.searchParams.set("token", parsed.wikiToken);
  const payload = await getJson(url, token);
  const node = payload.data?.node || payload.data || {};
  if (node.obj_type && node.obj_type !== "bitable") {
    throw userError(`这个 Wiki 节点类型是 ${node.obj_type}，不是多维表格。请直接配置 app_token。`);
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
    if (parts[0] === "base" && parts[1]) return { appToken: parts[1], tableId, viewId };
    if (parts[0] === "wiki" && parts[1]) return { wikiToken: parts[1], tableId, viewId };
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
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => fieldText(item)).filter(Boolean).join("、");
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
  ensure(config.appId, "请配置飞书 App ID。");
  ensure(config.appSecret, "请配置飞书 App Secret。");

  const token = await getTenantAccessToken(config);
  const receiveIdType = target.kind === "self" ? "open_id" : "chat_id";
  const receiveId = target.kind === "self" ? config.previewOpenId : target.chatId || config.chatId;
  ensure(receiveId, target.kind === "self" ? "请配置本人 open_id。" : "请填写群聊 chat_id。");

  const payload = await postJson(`${config.baseUrl}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, token, {
    receive_id: receiveId,
    msg_type: "interactive",
    content: JSON.stringify(card),
  });

  return {
    receiveIdType,
    receiveId: mask(receiveId),
    messageId: payload.data?.message_id || "",
  };
}

async function getTenantAccessToken(config) {
  const payload = await fetchJson(`${config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
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
        content: `**<font color='blue'>${index + 1}.</font> ${escapeMd(item.company)} · ${escapeMd(item.role)}**`,
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

function publicBaseUrl(request, env) {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location });
  cookies.forEach((value) => headers.append("Set-Cookie", value));
  return new Response(null, { status: 302, headers });
}

function cookie(name, value, request, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (new URL(request.url).protocol === "https:") parts.push("Secure");
  parts.push("Path=/");
  return parts.join("; ");
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

function randomToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function mask(value) {
  const text = String(value);
  if (text.length <= 10) return "***";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}
