/**
 * 运行日志页面：级别过滤、清空、导出 .log 文件。
 */

import * as controller from "../controller.js";
import { byId } from "../dom.js";
import { escapeHtml } from "../format.js";

const page = { filter: "全部" };

let bound = false;

const LEVEL_CLASS = {
  INFO: "is-info",
  WARNING: "is-warning",
  ERROR: "is-error",
  DEBUG: "is-debug",
};

function buildMarkup() {
  return `
  <div class="glass-header page-header">
    <div class="glass-header__text">
      <h1 class="glass-title">运行日志</h1>
      <p class="glass-subtitle">查看扫描、日期提取、复制和错误详情。</p>
    </div>
    <div class="page-head-actions">
      <span class="g-badge is-muted" id="log-count">0 条</span>
    </div>
  </div>

  <div class="card glass-card log-toolbar">
    <span class="inline-hint">显示级别</span>
    <select class="g-select" id="log-filter" style="width:132px;height:32px">
      <option value="全部">全部</option>
      <option value="INFO">INFO</option>
      <option value="WARNING">WARNING</option>
      <option value="ERROR">ERROR</option>
      <option value="DEBUG">DEBUG</option>
    </select>
    <div class="g-spacer"></div>
    <button class="g-btn g-btn--secondary g-btn--sm" type="button" id="btn-clear-logs">清空</button>
    <button class="g-btn g-btn--primary g-btn--sm" type="button" id="btn-export-logs">导出日志</button>
  </div>

  <div class="card glass-card log-card">
    <div class="g-log g-scroll" id="log-content">
      <div class="g-log__empty">暂无日志。开始扫描预览或整理后，这里会显示详细过程。</div>
    </div>
  </div>`;
}

function logLineMarkup(record) {
  const levelClass = LEVEL_CLASS[record.level] ?? "is-info";
  return `<div class="g-log__line ${levelClass}">
    <span class="g-log__time">${escapeHtml(record.time)}</span>
    <span class="g-log__level">${escapeHtml(record.level)}</span>
    <span class="g-log__msg">${escapeHtml(record.message)}</span>
  </div>`;
}

function renderAll() {
  const host = byId("log-content");
  const records = controller.state.logs.filter(
    (record) => page.filter === "全部" || record.level === page.filter,
  );
  if (!records.length) {
    host.innerHTML = `<div class="g-log__empty">暂无日志。开始扫描预览或整理后，这里会显示详细过程。</div>`;
  } else {
    host.innerHTML = records.map(logLineMarkup).join("");
    host.scrollTop = host.scrollHeight;
  }
  byId("log-count").textContent = `${records.length} 条`;
}

function appendLog(record) {
  if (page.filter !== "全部" && record.level !== page.filter) {
    return;
  }
  const host = byId("log-content");
  const empty = host.querySelector(".g-log__empty");
  if (empty) {
    empty.remove();
  }
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 80;
  host.insertAdjacentHTML("beforeend", logLineMarkup(record));
  if (nearBottom) {
    host.scrollTop = host.scrollHeight;
  }
  const count = controller.state.logs.filter(
    (item) => page.filter === "全部" || item.level === page.filter,
  ).length;
  byId("log-count").textContent = `${count} 条`;
}

export function initLogsPage() {
  const host = byId("page-logs");
  if (!host) {
    return;
  }
  host.innerHTML = buildMarkup();
  byId("log-filter").addEventListener("change", (event) => {
    page.filter = event.target.value;
    renderAll();
  });
  byId("btn-clear-logs").addEventListener("click", () => {
    controller.clearLogs();
  });
  byId("btn-export-logs").addEventListener("click", () => exportLogs());
  if (!bound) {
    bound = true;
    controller.on("log", (record) => appendLog(record));
    controller.on("logs-cleared", () => renderAll());
  }
  renderAll();
}

function exportLogs() {
  const records = controller.state.logs;
  if (!records.length) {
    controller.toast("当前没有可导出的日志。", { type: "info" });
    return;
  }
  const content =
    records
      .map((record) => `[${record.time}] [${record.level.padEnd(7, " ")}] ${record.message}`)
      .join("\n") + "\n";
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gpth-${stamp}.log`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  controller.addLog("INFO", `已导出运行日志（${records.length} 条）`);
  controller.toast("日志已导出", { type: "success" });
}

export { page as logsState };
