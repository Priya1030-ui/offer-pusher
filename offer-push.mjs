import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

loadDotenv(path.join(ROOT, ".env"));

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"] || args.preview);
const dateText = normalizeDate(args.date || todayInShanghai());
const dataFile = args.file || process.env.OFFER_DATA_FILE || "offers.tsv";
const limit = Number(args.limit || process.env.OFFER_LIMIT || 0);

const offers = readOffers(path.resolve(ROOT, dataFile));
const selectedOffers = limit > 0 ? offers.slice(0, limit) : offers;
const card = buildOfferCard(selectedOffers, {
  titlePrefix: process.env.OFFER_TITLE_PREFIX || "校招Offer开奖参考",
  dateText,
  isPreview: true,
  sourceText:
    process.env.OFFER_SOURCE_TEXT ||
    "整理自Offershow等校招薪资分享中高可信度及热门案例",
});

if (dryRun) {
  console.log(renderMarkdownPreview(selectedOffers, dateText));
  console.log("\n--- Feishu card JSON ---");
  console.log(JSON.stringify({ msg_type: "interactive", card }, null, 2));
} else {
  await sendCard(card);
}

function loadDotenv(file) {
  if (!fs.existsSync(file)) return;

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function todayInShanghai() {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  return `${parts.year}${parts.month}${parts.day}`;
}

function normalizeDate(input) {
  const compact = String(input).replace(/\D/g, "");
  if (compact.length !== 8) {
    throw new Error("日期请使用 YYYYMMDD 或 YYYY-MM-DD，例如 20260911");
  }
  return compact;
}

function readOffers(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到数据文件：${file}`);
  }

  const rows = fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("\t").map((cell) => cell.trim()));

  const header = rows.shift();
  const required = ["公司", "序列", "岗位", "学历", "薪资", "备注"];
  const indexes = Object.fromEntries(required.map((name) => [name, header.indexOf(name)]));
  const missing = required.filter((name) => indexes[name] < 0);
  if (missing.length) {
    throw new Error(`数据文件缺少列：${missing.join("、")}`);
  }

  return rows
    .filter((row) => row.some(Boolean))
    .map((row) => ({
      company: row[indexes["公司"]] || "",
      track: row[indexes["序列"]] || "",
      role: row[indexes["岗位"]] || "",
      degree: row[indexes["学历"]] || "",
      salary: row[indexes["薪资"]] || "",
      note: row[indexes["备注"]] || "",
    }));
}

function buildOfferCard(items, options) {
  const elements = [];

  items.forEach((item, index) => {
    if (index > 0) {
      elements.push({ tag: "hr" });
    }

    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          `**<font color='blue'>${index + 1}.</font> ${escapeMd(item.company)} · ${escapeMd(item.role)}**`,
          "",
          `📌 序列： ${escapeMd(item.track)}   🎓 学历： ${escapeMd(item.degree)}`,
          `💰 薪资： <font color='red'>**${escapeMd(formatSalary(item.salary))}**</font>`,
          `✍️ 备注： ${escapeMd(item.note)}`,
        ].join("\n"),
      },
    });
  });

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: options.sourceText,
      },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: "wathet",
      title: {
        tag: "plain_text",
        content: `${options.titlePrefix}-${options.dateText}期 ${options.isPreview ? "本人预览" : ""}`.trim(),
      },
    },
    elements,
  };
}

function renderMarkdownPreview(items, dateText) {
  const lines = [`校招Offer开奖参考-${dateText}期 本人预览`, ""];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.company} · ${item.role}`);
    lines.push(`📌 序列： ${item.track}   🎓 学历： ${item.degree}`);
    lines.push(`💰 薪资： ${formatSalary(item.salary)}`);
    lines.push(`✍️ 备注： ${item.note}`);
    lines.push("");
  });
  lines.push(process.env.OFFER_SOURCE_TEXT || "整理自Offershow等校招薪资分享中高可信度及热门案例");
  return lines.join("\n");
}

function escapeMd(value) {
  return String(value).replace(/[\\`*_{}\[\]()#+\-.!|]/g, "\\$&");
}

function formatSalary(value) {
  return String(value).replace(/\*/g, "×").replace(/x/gi, "×");
}

async function sendCard(card) {
  const webhookUrls = splitEnvList(process.env.FEISHU_WEBHOOK_URLS);
  const appTargets = [
    [process.env.FEISHU_PREVIEW_OPEN_ID, "open_id"],
    [process.env.FEISHU_GROUP_CHAT_ID, "chat_id"],
  ].filter(([id]) => id);

  if (!webhookUrls.length && !appTargets.length) {
    throw new Error("没有配置推送目标。请先在 .env 填 FEISHU_WEBHOOK_URLS 或飞书自建应用收件人。");
  }

  for (const webhookUrl of webhookUrls) {
    await postJson(webhookUrl, { msg_type: "interactive", card });
    console.log(`已推送到群机器人：${mask(webhookUrl)}`);
  }

  if (appTargets.length) {
    const token = await getTenantAccessToken();
    for (const [receiveId, receiveIdType] of appTargets) {
      await postJson(
        `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
        {
          receive_id: receiveId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
        {
          Authorization: `Bearer ${token}`,
        },
      );
      console.log(`已通过自建应用推送：${receiveIdType} ${mask(receiveId)}`);
    }
  }
}

async function getTenantAccessToken() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("要发给本人或指定群聊，需要配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。");
  }

  const response = await postJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: appId,
    app_secret: appSecret,
  });

  if (!response.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败：${JSON.stringify(response)}`);
  }
  return response.tenant_access_token;
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok || (payload.code && payload.code !== 0)) {
    throw new Error(`飞书接口返回异常：HTTP ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

function splitEnvList(value) {
  return (value || "")
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mask(value) {
  const text = String(value);
  if (text.length <= 10) return "***";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}
