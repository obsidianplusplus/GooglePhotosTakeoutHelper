/**
 * 应用控制器：设置、主题、日志、后台任务（扫描/执行/日期修复）与会话事件流。
 *
 * 页面模块只通过 controller 暴露的方法和事件工作，避免直接操作 SSE 和全局状态。
 */

import { ApiError, api, SessionStream, deleteSessionKeepalive } from "./api.js";
import { toast } from "./confirm.js";
import { formatCount, formatPercent, phaseLabel } from "./format.js";

const MAX_LOGS = 2000;

const handlers = new Map();

export const state = {
  settings: null,
  system: null,
  sessionId: null,
  sessionType: null,
  sessionState: "idle",
  busy: false,
  activeTask: null,
  analysis: null,
  canExecute: false,
  previewTotal: 0,
  duplicateTotal: 0,
  progress: null,
  logs: [],
  connection: { connected: true },
};

let stream = null;

/* -------------------------------- 事件总线 ------------------------------- */

export function on(event, handler) {
  if (!handlers.has(event)) {
    handlers.set(event, new Set());
  }
  handlers.get(event).add(handler);
  return () => handlers.get(event)?.delete(handler);
}

export function emit(event, payload) {
  const set = handlers.get(event);
  if (!set) {
    return;
  }
  for (const handler of set) {
    try {
      handler(payload);
    } catch (error) {
      console.error("控制器事件处理失败", event, error);
    }
  }
}

/* ------------------------------- 初始化 ---------------------------------- */

export async function initialize() {
  const [settingsPayload, systemPayload] = await Promise.all([
    api.getSettings(),
    api.system().catch(() => null),
  ]);
  state.settings = settingsPayload.settings ?? settingsPayload;
  state.system = systemPayload;
  // 调试/截图便捷入口：?theme=dark|light 临时覆盖当前外观，不写回设置。
  try {
    const forcedTheme = new URLSearchParams(window.location.search).get("theme");
    if (forcedTheme === "dark" || forcedTheme === "light") {
      state.settings.appearance = forcedTheme === "dark" ? "Dark" : "Light";
    }
  } catch {
    // URLSearchParams 在极旧环境中才会缺失。
  }
  applyTheme(state.settings.appearance ?? "System", { silent: true });
  emit("settings", state.settings);
  emit("system", state.system);
  return state.settings;
}

export async function refreshSystem() {
  try {
    state.system = await api.system();
    emit("system", state.system);
  } catch {
    // 系统信息只用于展示，失败无需打断用户。
  }
  return state.system;
}

export async function refreshCacheInfo() {
  try {
    const info = await api.getCache();
    if (state.system) {
      state.system.cache = info;
      emit("system", state.system);
    }
    return info;
  } catch {
    return null;
  }
}

/* ------------------------------- 设置/主题 -------------------------------- */

export async function saveSettings(patch, { silent = true } = {}) {
  state.settings = { ...state.settings, ...patch };
  emit("settings", state.settings);
  try {
    const payload = await api.saveSettings(patch);
    state.settings = payload.settings ?? state.settings;
    emit("settings", state.settings);
  } catch (error) {
    if (!silent) {
      toast(`保存设置失败：${error.message}`, { type: "error" });
    }
  }
  return state.settings;
}

function appearanceToGlass(mode) {
  if (mode === "Light") {
    return "light";
  }
  if (mode === "Dark") {
    return "dark";
  }
  return "system";
}

export function applyTheme(appearanceMode, { persist = false, silent = false } = {}) {
  const mode = appearanceToGlass(appearanceMode);
  try {
    window.Glass?.setTheme?.(mode);
  } catch {
    // 设计系统未加载时退回 data-theme 手动设置。
    const dark =
      mode === "dark" ||
      (mode === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }
  try {
    localStorage.setItem("gpth-theme", mode);
    localStorage.setItem("gpth-appearance", appearanceMode);
  } catch {
    // 隐私模式下 localStorage 可能不可写。
  }
  if (persist) {
    saveSettings(
      { appearance: appearanceMode },
      { silent: true },
    );
  }
  emit("appearance", appearanceMode);
  if (!silent) {
    const labels = { System: "跟随系统", Light: "浅色", Dark: "深色" };
    toast(`外观：${labels[appearanceMode] ?? appearanceMode}`, { type: "info", duration: 1600 });
  }
}

/** 标题栏按钮：在 跟随系统 → 浅色 → 深色 之间循环。 */
export function cycleAppearance() {
  const order = ["System", "Light", "Dark"];
  const current = state.settings?.appearance ?? "System";
  const next = order[(order.indexOf(current) + 1) % order.length] ?? "System";
  saveSettings({ appearance: next });
  applyTheme(next, { silent: false });
  updateThemeButton(next);
  return next;
}

export function updateThemeButton(appearanceMode) {
  const button = document.getElementById("btn-theme");
  if (!button) {
    return;
  }
  const name = appearanceMode === "Dark" ? "sun" : appearanceMode === "Light" ? "moon" : "monitor";
  const label = { System: "跟随系统", Light: "浅色", Dark: "深色" }[appearanceMode] ?? appearanceMode;
  button.innerHTML = "";
  const span = document.createElement("span");
  span.dataset.icon = name;
  button.append(span);
  import("./icons.js").then(({ hydrateIcons }) => hydrateIcons(button));
  button.dataset.tooltip = `外观：${label}（点击切换）`;
}

/* --------------------------------- 日志 ---------------------------------- */

function nowTimeText() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function addLog(level, message) {
  const normalized = String(level ?? "INFO").toUpperCase();
  const record = { time: nowTimeText(), level: normalized, message: String(message ?? "") };
  state.logs.push(record);
  if (state.logs.length > MAX_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_LOGS);
  }
  emit("log", record);
  return record;
}

export function clearLogs() {
  state.logs = [];
  emit("logs-cleared");
}

/* ------------------------------ 任务状态机 -------------------------------- */

function setBusy(busy, task = null) {
  state.busy = Boolean(busy);
  state.activeTask = busy ? task : null;
  emit("busy", { busy: state.busy, task: state.activeTask });
}

function disposeStream() {
  if (stream) {
    stream.close();
    stream = null;
  }
}

export function disposeSession({ notifyServer = true } = {}) {
  disposeStream();
  if (notifyServer && state.sessionId) {
    deleteSessionKeepalive(state.sessionId);
  }
  state.sessionId = null;
  state.sessionType = null;
  state.sessionState = "idle";
  state.analysis = null;
  state.canExecute = false;
  state.previewTotal = 0;
  state.duplicateTotal = 0;
  state.progress = null;
  emit("session-reset");
}

function attachStream(sessionId) {
  disposeStream();
  stream = new SessionStream(sessionId);
  stream.on("__connection", (payload) => {
    state.connection = { connected: payload.connected };
    emit("connection", payload);
  });
  stream.on("hello", () => {
    emit("session-hello", { sessionId });
  });
  stream.on("state", (payload) => {
    applyServerState(payload);
  });
  stream.on("progress", (payload) => {
    state.progress = payload;
    emit("progress", payload);
  });
  stream.on("log", (record) => {
    addLog(record.level, record.message);
  });
  stream.on("analysis", (payload) => {
    state.analysis = payload;
    state.previewTotal = payload.previewTotal ?? payload.summary?.plannedActions ?? 0;
    state.duplicateTotal = payload.duplicateTotal ?? 0;
    state.canExecute = state.previewTotal > 0;
    setBusy(false);
    emit("analysis", payload);
    addLog("INFO", `预览已生成，共 ${formatCount(state.previewTotal)} 个计划动作`);
  });
  stream.on("execution", (payload) => {
    setBusy(false);
    state.sessionState = "done";
    state.canExecute = false;
    state.analysis = null;
    emit("execution", payload);
    emit("session-state", { state: "done" });
  });
  stream.on("fix", (payload) => {
    setBusy(false);
    state.sessionState = "fixed";
    emit("fix", payload);
    emit("session-state", { state: "fixed" });
  });
  stream.on("cancelled", (payload) => {
    setBusy(false);
    state.sessionState = "cancelled";
    state.canExecute = false;
    emit("cancelled", payload);
    addLog("WARNING", payload?.message || "任务已取消");
    emit("session-state", { state: "cancelled" });
  });
  stream.on("error", (payload) => {
    setBusy(false);
    state.sessionState = "error";
    emit("error", payload);
    addLog("ERROR", payload?.message ?? "任务失败");
    if (payload?.stack) {
      addLog("DEBUG", String(payload.stack));
    }
    emit("session-state", { state: "error" });
  });
  stream.connect();
}

function applyServerState(payload) {
  state.sessionState = payload.state ?? state.sessionState;
  state.canExecute = Boolean(payload.canExecute);
  if (typeof payload.busy === "boolean") {
    setBusy(payload.busy, state.activeTask);
  }
  if (["analysed", "done", "cancelled", "error", "fixed"].includes(state.sessionState)) {
    if (state.sessionState !== "analysed") {
      setBusy(false);
    }
  }
  emit("session-state", payload);
}

async function createSession(type, options) {
  disposeStream();
  const payload = await api.createSession(type, options);
  state.sessionId = payload.sessionId;
  state.sessionType = type;
  state.sessionState = payload.state ?? "running";
  state.analysis = null;
  state.canExecute = false;
  state.previewTotal = 0;
  state.duplicateTotal = 0;
  state.progress = null;
  setBusy(true, type);
  attachStream(state.sessionId);
  emit("session-created", { sessionId: state.sessionId, type });
  return payload;
}

/** 扫描预览。ApiError 会携带 errors 数组供页面展示。 */
export async function startAnalysis(options) {
  addLog("INFO", "开始扫描预览");
  return createSession("organize", options);
}

/** 只修复日期。 */
export async function startFix(options) {
  addLog("INFO", "开始日期修复");
  return createSession("fix", options);
}

/** 执行已生成的计划（不重新扫描）。 */
export async function startExecution(options) {
  if (!state.sessionId || state.sessionState !== "analysed") {
    throw new ApiError("尚未生成预览，或预览后修改了选项。", { code: "stale-preview" });
  }
  addLog("INFO", "开始整理任务");
  setBusy(true, "execute");
  state.sessionState = "executing";
  emit("session-state", { state: "executing", busy: true, canExecute: false });
  try {
    await api.executeSession(state.sessionId, options);
  } catch (error) {
    setBusy(false);
    state.sessionState = "analysed";
    emit("session-state", { state: "analysed", busy: false, canExecute: true });
    throw error;
  }
}

export async function cancelCurrent() {
  if (!state.sessionId || !state.busy) {
    return;
  }
  try {
    await api.cancelSession(state.sessionId);
  } catch (error) {
    toast(`取消请求失败：${error.message}`, { type: "error" });
    return;
  }
  addLog("WARNING", "用户请求取消当前任务");
  emit("cancelling");
}

/** 进度条与状态文本需要的格式化摘要。 */
export function progressText(progress) {
  if (!progress) {
    return "";
  }
  const phase = phaseLabel(progress.phase);
  const current = Math.max(Number(progress.current) || 0, 0);
  const total = Math.max(Number(progress.total) || 0, 0);
  const ratio = total ? Math.min(current / total, 1) : 0;
  const suffix = total ? ` · ${formatCount(current)} / ${formatCount(total)} · ${formatPercent(current, total)}` : "";
  return `${phase} · ${progress.message ?? ""}${suffix}`;
}

export function progressRatio(progress) {
  if (!progress) {
    return 0;
  }
  const current = Math.max(Number(progress.current) || 0, 0);
  const total = Math.max(Number(progress.total) || 0, 0);
  return total ? Math.min(current / total, 1) : 0;
}

export { toast };
