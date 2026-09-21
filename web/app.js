const state = {
  rows: [],
  selected: new Set(),
  config: {},
};

const fields = [
  "appId",
  "appSecret",
  "wikiUrl",
  "appToken",
  "tableId",
  "viewId",
  "previewOpenId",
  "chatId",
  "titlePrefix",
  "sourceText",
];

const els = Object.fromEntries(
  [
    ...fields,
    "dateText",
    "targetChatId",
    "syncButton",
    "selectAllButton",
    "clearButton",
    "sendSelfButton",
    "sendChatButton",
    "rows",
    "rowCount",
    "syncStatus",
    "selectedCount",
    "preview",
    "toast",
    "loginStatus",
  ].map((id) => [id, document.getElementById(id)]),
);

init();

async function init() {
  els.dateText.value = todayText();
  await loadMe();
  await loadConfig();
  await loadLocalOffers();
  wireEvents();
  render();
}

async function loadMe() {
  const result = await api("/api/me");
  if (!result.loginRequired) {
    els.loginStatus.textContent = "";
    return;
  }
  els.loginStatus.innerHTML = result.user
    ? `已登录：${escapeHtml(result.user.name || "飞书用户")} · <a href="/logout">退出</a>`
    : `<a href="/login">飞书登录</a>`;
}

async function loadConfig() {
  const config = await api("/api/config");
  state.config = config;
  for (const field of fields) {
    if (field === "appSecret") continue;
    els[field].value = config[field] || "";
  }
  if (config.hasAppSecret) {
    els.appSecret.placeholder = "已保存，留空不改";
  }
  els.targetChatId.value = config.chatId || "";
}

async function loadLocalOffers() {
  const result = await api("/api/local-offers");
  state.rows = result.rows || [];
  state.selected = new Set(state.rows.slice(0, 2).map((row) => row.id));
  els.syncStatus.textContent = state.rows.length ? "可直接看预览，也可同步实时数据" : "等待同步";
}

function wireEvents() {
  els.syncButton.addEventListener("click", syncRows);
  els.wikiUrl.addEventListener("change", applyLinkParts);
  els.selectAllButton.addEventListener("click", () => {
    state.rows.forEach((row) => state.selected.add(row.id));
    render();
  });
  els.clearButton.addEventListener("click", () => {
    state.selected.clear();
    render();
  });
  els.sendSelfButton.addEventListener("click", () => send("self"));
  els.sendChatButton.addEventListener("click", () => send("chat"));
  els.rows.addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[type='checkbox']");
    if (!checkbox) return;
    if (checkbox.checked) state.selected.add(checkbox.value);
    else state.selected.delete(checkbox.value);
    render();
  });

  for (const input of document.querySelectorAll("input")) {
    input.addEventListener("input", () => {
      if (input.id === "chatId" && !els.targetChatId.value) {
        els.targetChatId.value = input.value;
      }
      renderPreview();
    });
  }
}

function applyLinkParts() {
  try {
    const url = new URL(els.wikiUrl.value.trim());
    const parts = url.pathname.split("/").filter(Boolean);
    const tableId = url.searchParams.get("table");
    const viewId = url.searchParams.get("view");
    if (parts[0] === "base" && parts[1] && !els.appToken.value) {
      els.appToken.value = parts[1];
    }
    if (tableId) els.tableId.value = tableId;
    if (viewId) els.viewId.value = viewId;
  } catch {
    // Not a URL yet; keep the user's typed value untouched.
  }
}

async function syncRows() {
  await withBusy(els.syncButton, "同步中", async () => {
    const config = getConfig();
    const result = await api("/api/sync", { config });
    state.rows = result.rows;
    state.selected = new Set(result.rows.slice(0, 2).map((row) => row.id));
    if (result.appToken) els.appToken.value = result.appToken;
    els.syncStatus.textContent = `已同步 ${formatTime(result.syncedAt)}`;
    toast(`同步完成：${result.rows.length} 条`);
    render();
  });
}

async function send(kind) {
  const rows = selectedRows();
  const config = getConfig();
  const target =
    kind === "self"
      ? { kind: "self" }
      : { kind: "chat", chatId: els.targetChatId.value.trim() || config.chatId };

  await withBusy(kind === "self" ? els.sendSelfButton : els.sendChatButton, "发送中", async () => {
    const result = await api("/api/send", {
      config,
      rows,
      target,
      dateText: els.dateText.value,
    });
    toast(`智能体发送成功：${result.sent.receiveIdType} ${result.sent.receiveId}`);
  });
}

function getConfig() {
  return Object.fromEntries(fields.map((field) => [field, els[field].value.trim()]));
}

function render() {
  els.rowCount.textContent = `${state.rows.length} 条数据`;
  renderRows();
  renderPreview();
}

function renderRows() {
  if (!state.rows.length) {
    els.rows.innerHTML = `<tr><td colspan="7" class="empty">点击“同步表格”获取实时数据。</td></tr>`;
    return;
  }

  els.rows.innerHTML = state.rows
    .map((row) => {
      const selected = state.selected.has(row.id);
      return `
        <tr class="${selected ? "selected" : ""}">
          <td><input type="checkbox" value="${escapeHtml(row.id)}" ${selected ? "checked" : ""}></td>
          <td>${escapeHtml(row.company)}</td>
          <td>${escapeHtml(row.track)}</td>
          <td>${escapeHtml(row.role)}</td>
          <td>${escapeHtml(row.degree)}</td>
          <td class="salary">${escapeHtml(formatSalary(row.salary))}</td>
          <td>${escapeHtml(row.note)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderPreview() {
  const rows = selectedRows();
  els.selectedCount.textContent = rows.length ? `已选择 ${rows.length} 条` : "未选择";

  if (!rows.length) {
    els.preview.innerHTML = `<div class="empty">勾选左侧数据后，这里会显示将要发送的卡片。</div>`;
    return;
  }

  const title = `${els.titlePrefix.value || "校招Offer开奖参考"}-${normalizeDateForDisplay(els.dateText.value)}期`;
  els.preview.innerHTML = `
    <div class="card-title">
      <span>${escapeHtml(title)}</span>
      <span class="preview-badge">本人预览</span>
    </div>
    ${rows
      .map(
        (row, index) => `
          <section class="offer-item">
            <div class="offer-main"><span class="index">${index + 1}.</span> ${escapeHtml(row.company)} · ${escapeHtml(row.role)}</div>
            <div class="offer-line">📌 序列： ${escapeHtml(row.track)} &nbsp;&nbsp; 🎓 学历： ${escapeHtml(row.degree)}</div>
            <div class="offer-line">💰 薪资： <span class="salary">${escapeHtml(formatSalary(row.salary))}</span></div>
            ${row.note ? `<div class="offer-line">✍️ 备注： ${escapeHtml(row.note)}</div>` : ""}
          </section>
        `,
      )
      .join("")}
    <div class="source">${escapeHtml(els.sourceText.value || "整理自Offershow等校招薪资分享中高可信度及热门案例")}</div>
  `;
}

function selectedRows() {
  return state.rows.filter((row) => state.selected.has(row.id));
}

async function api(url, body) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

async function withBusy(button, busyText, task) {
  const original = button.textContent;
  try {
    button.disabled = true;
    button.textContent = busyText;
    await task();
  } catch (error) {
    toast(error.message || String(error), true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.style.background = isError ? "#a52626" : "#172033";
  els.toast.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

function todayText() {
  const date = new Date();
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function normalizeDateForDisplay(value) {
  const compact = String(value || todayText()).replace(/\D/g, "");
  return compact.length === 8 ? compact : todayText();
}

function formatSalary(value) {
  return String(value || "").replace(/\*/g, "×").replace(/x/gi, "×");
}

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
