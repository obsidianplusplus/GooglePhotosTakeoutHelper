/**
 * 应用入口：启动流程、导航、主题、连接状态与全局生命周期。
 */

import * as controller from "./controller.js";
import { alertDialog } from "./confirm.js";
import { initDirPicker } from "./dir-picker.js";
import { initDuplicates } from "./duplicates.js";
import { byId, $$ } from "./dom.js";
import { hydrateIcons } from "./icons.js";
import { initOrganize } from "./pages/organize.js";
import { initFixPage } from "./pages/fix.js";
import { initLogsPage } from "./pages/logs.js";
import { initSettingsPage } from "./pages/settings.js";

const PAGES = ["organize", "fix", "logs", "settings"];
let currentPage = "organize";

function readHashPage() {
  const key = window.location.hash.replace(/^#\/?/, "");
  return PAGES.includes(key) ? key : "organize";
}

function showPage(key) {
  if (!PAGES.includes(key)) {
    key = "organize";
  }
  currentPage = key;
  for (const page of PAGES) {
    const node = byId(`page-${page}`);
    if (node) {
      node.hidden = page !== key;
    }
  }
  for (const button of $$(".glass-nav-item[data-page]")) {
    button.classList.toggle("is-active", button.dataset.page === key);
  }
  if (key === "logs") {
    resetLogBadge();
  }
  if (window.location.hash !== `#/${key}`) {
    history.replaceState(null, "", `#/${key}`);
  }
  window.scrollTo({ top: 0 });
}

/* --------------------------------- 日志徽标 ------------------------------- */

let logBadgeCount = 0;

function updateLogBadge() {
  const badge = byId("nav-log-badge");
  if (!badge) {
    return;
  }
  if (logBadgeCount > 0 && currentPage !== "logs") {
    badge.hidden = false;
    badge.textContent = logBadgeCount > 99 ? "99+" : String(logBadgeCount);
  } else {
    badge.hidden = true;
  }
}

function resetLogBadge() {
  logBadgeCount = 0;
  updateLogBadge();
}

/* -------------------------------- 连接状态 ------------------------------- */

function setConnection(connected, serverInfo = null) {
  const status = byId("conn-status");
  const text = byId("conn-status-text");
  if (status) {
    status.className = `g-status${connected ? " is-live" : " is-busy"}`;
  }
  if (text) {
    text.textContent = connected ? "已连接" : "连接中断，正在重连…";
  }
  const sub = byId("server-status-sub");
  if (sub) {
    sub.textContent = connected
      ? serverInfo
        ? `本机服务 · Node ${serverInfo.node ?? ""}`.trim()
        : "本机服务已连接"
      : "正在尝试重新连接…";
  }
}

function bindConnectionEvents() {
  controller.on("connection", (payload) => setConnection(Boolean(payload?.connected)));
  controller.on("system", (system) => {
    setConnection(true, system);
    const versionNode = document.querySelector(".glass-sidebar__version span");
    if (versionNode && system?.version) {
      versionNode.textContent = `v${system.version}`;
    }
  });
}

/* --------------------------------- 启动 ---------------------------------- */

async function boot() {
  bindConnectionEvents();
  bindNavigation();
  bindGlobalActions();
  try {
    await controller.initialize();
  } catch (error) {
    setConnection(false);
    await alertDialog({
      title: "无法连接本机服务",
      message:
        `前端无法访问 Node.js 后端接口：\n${error.message}\n\n` +
        "请确认服务已启动（node src/cli.js web），然后刷新页面。",
      tone: "danger",
      confirmText: "知道了",
      cancelText: null,
    });
    return;
  }
  controller.updateThemeButton(controller.state.settings?.appearance ?? "System");
  setConnection(true, controller.state.system);

  initDirPicker();
  initDuplicates();
  initOrganize();
  initFixPage();
  initLogsPage();
  initSettingsPage();
  hydrateIcons(document);
  try {
    window.Glass?.init?.(document);
  } catch (error) {
    console.error("设计系统初始化失败", error);
  }
  showPage(readHashPage());
  window.addEventListener("hashchange", () => showPage(readHashPage()));

  controller.on("log", (record) => {
    if (record.level === "ERROR" && currentPage !== "logs") {
      logBadgeCount += 1;
      updateLogBadge();
    }
  });
  controller.on("session-created", () => {
    // 新任务开始时日志徽标保持可读
    updateLogBadge();
  });

  window.addEventListener("beforeunload", (event) => {
    if (controller.state.busy) {
      event.preventDefault();
      event.returnValue = "";
    }
    controller.disposeSession({ notifyServer: true });
  });
}

function bindNavigation() {
  for (const button of $$(".glass-nav-item[data-page]")) {
    button.addEventListener("click", () => showPage(button.dataset.page));
  }
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    const map = { 1: "organize", 2: "fix", 3: "logs", 4: "settings" };
    const target = map[event.key];
    if (target) {
      event.preventDefault();
      showPage(target);
    }
  });
}

function bindGlobalActions() {
  byId("btn-theme").addEventListener("click", () => {
    const mode = controller.cycleAppearance();
    const select = byId("set-appearance");
    if (select) {
      select.value = mode;
    }
  });
}

function start() {
  boot().catch((error) => {
    console.error("应用启动失败", error);
    alertDialog({
      title: "应用启动失败",
      message: String(error?.message ?? error),
      tone: "danger",
      confirmText: "知道了",
      cancelText: null,
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

// 便于调试与自动化验收脚本切换页面。
window.showPage = showPage;

export { showPage };
