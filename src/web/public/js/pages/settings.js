/**
 * 设置与关于页面（对应 历史 Python v4.1 参考实现 的 settings 页）。
 *
 * 界面外观、缩放、预览批量、扫描指纹缓存清理、记住目录，以及关于与安全建议。
 */

import { api } from "../api.js";
import { alertDialog, confirmDialog } from "../confirm.js";
import * as controller from "../controller.js";
import { byId } from "../dom.js";
import { formatCount, formatBytes } from "../format.js";
import { hydrateIcons } from "../icons.js";

const APPEARANCE_OPTIONS = [
  { value: "System", label: "跟随系统" },
  { value: "Light", label: "浅色" },
  { value: "Dark", label: "深色" },
];
const SCALING_OPTIONS = ["90", "100", "110", "125"];
const PREVIEW_LIMIT_OPTIONS = [
  { value: "100", label: "100 行" },
  { value: "300", label: "300 行" },
  { value: "500", label: "500 行" },
  { value: "1000", label: "1000 行" },
];

const page = {
  cacheEntries: 0,
  cachePath: "",
};

let bound = false;

function selectMarkup(id, options, value, style = "") {
  const items = options.map((item) =>
    typeof item === "string"
      ? `<option value="${item}"${item === String(value) ? " selected" : ""}>${item}%</option>`
      : `<option value="${item.value}"${item.value === value ? " selected" : ""}>${item.label}</option>`,
  );
  return `<select class="g-select" id="${id}"${style ? ` style="${style}"` : ""}>${items.join("")}</select>`;
}

function buildMarkup() {
  const version = controller.state.system?.version ?? "5.0.0";
  const previewLimit = controller.state.settings?.preview_limit ?? 300;
  const scaling = Math.round((controller.state.settings?.scaling ?? 1) * 100);
  const appearance = controller.state.settings?.appearance ?? "System";
  const remember = Boolean(controller.state.settings?.remember_paths);
  return `
  <div class="glass-header page-header">
    <div class="glass-header__text">
      <h1 class="glass-title">设置与关于</h1>
      <p class="glass-subtitle">个性化界面，并了解本工具如何保护你的照片。</p>
    </div>
  </div>

  <div class="settings-grid">
    <div class="card glass-card settings-card">
      <div class="card-head"><div class="card-head__title">界面设置</div></div>
      <div class="settings-row">
        <div class="settings-row__label">外观模式</div>
        ${selectMarkup("set-appearance", APPEARANCE_OPTIONS, appearance)}
      </div>
      <div class="settings-row">
        <div class="settings-row__label">界面缩放</div>
        ${selectMarkup(
          "set-scaling",
          SCALING_OPTIONS,
          String(SCALING_OPTIONS.includes(String(scaling)) ? scaling : 100),
        )}
      </div>
      <div class="settings-row">
        <div class="settings-row__label">每批预览行数</div>
        ${selectMarkup(
          "set-preview-limit",
          PREVIEW_LIMIT_OPTIONS,
          String(PREVIEW_LIMIT_OPTIONS.some((item) => item.value === String(previewLimit)) ? previewLimit : "300"),
        )}
      </div>
      <div class="settings-row">
        <div class="settings-row__label">扫描指纹缓存</div>
        <div class="cache-row">
          <span class="cache-row__hint" id="cache-hint">仅保存路径、文件状态与 SHA-256</span>
          <button class="g-btn g-btn--secondary g-btn--sm" type="button" id="btn-clear-cache">清理</button>
        </div>
      </div>
      <div class="settings-row settings-row--switch">
        <div class="settings-row__label">记住最近使用的目录</div>
        <label class="g-switch">
          <input type="checkbox" id="set-remember-paths" ${remember ? "checked" : ""}>
          <span class="g-switch__track"></span>
        </label>
      </div>
    </div>

    <div class="card glass-card settings-card">
      <div class="card-head"><div class="card-head__title">关于 PhotoTakeout Studio</div></div>
      <div class="about-body">
        <div class="version-line"><strong>版本 ${version}</strong><span class="g-badge is-accent">Node.js 版</span></div>
        <div class="about-meta">
          <span class="g-tag">Google Photos Takeout</span>
          <span class="g-tag">SHA-256 去重</span>
          <span class="g-tag">Apple 实况照片</span>
          <span class="g-tag">Liquid Glass UI</span>
        </div>
        <p>用于整理 Google Photos Takeout 导出的照片和视频。支持相册关系、重复项识别、日期恢复、预览与取消。</p>
        <p>本工具不会上传照片；所有扫描与复制均在本机执行。媒体处理引擎与命令行工具由 Node.js 实现。</p>
      </div>
    </div>
  </div>

  <div class="card glass-card settings-card">
    <div class="card-head"><div class="card-head__title">使用建议</div></div>
    <div class="about-body">
      <ul class="safety-list">
        <li><span data-icon="check"></span>首次使用请选择“复制”，并保留 Google Takeout 原始压缩包。</li>
        <li><span data-icon="check"></span>先运行“扫描预览”，重点检查未知日期、跳过项与目标路径。</li>
        <li><span data-icon="check"></span>移动和覆盖模式会改变现有文件；确认输出无误后再清理原文件。</li>
        <li><span data-icon="check"></span>任务取消后，已完成的独立文件会保留；日志会说明停止位置。</li>
        <li><span data-icon="check"></span>扫描指纹缓存只保存在本机用户配置目录，清理不会删除任何照片。</li>
      </ul>
    </div>
  </div>`;
}

export function initSettingsPage() {
  const host = byId("page-settings");
  if (!host) {
    return;
  }
  host.innerHTML = buildMarkup();
  hydrateIcons(host);
  bindEvents();
  applyScalingFromSettings();
  refreshCacheInfo();
}

function bindEvents() {
  if (bound) {
    return;
  }
  bound = true;
  byId("set-appearance").addEventListener("change", (event) => {
    const mode = event.target.value;
    controller.saveSettings({ appearance: mode });
    controller.applyTheme(mode, { silent: true });
    controller.updateThemeButton(mode);
  });
  byId("set-scaling").addEventListener("change", (event) => {
    const value = Number.parseInt(event.target.value, 10) || 100;
    applyScaling(value);
    controller.saveSettings({ scaling: value / 100 });
  });
  byId("set-preview-limit").addEventListener("change", (event) => {
    const value = Number.parseInt(event.target.value, 10) || 300;
    controller.saveSettings({ preview_limit: value });
  });
  byId("set-remember-paths").addEventListener("change", (event) => {
    controller.saveSettings({ remember_paths: Boolean(event.target.checked) });
  });
  byId("btn-clear-cache").addEventListener("click", () => clearCache());
  controller.on("busy", () => {
    const button = byId("btn-clear-cache");
    if (button) {
      button.disabled = controller.state.busy;
    }
  });
}

function applyScaling(value) {
  const scale = Math.min(Math.max(value, 80), 150);
  document.documentElement.style.zoom = scale === 100 ? "" : String(scale / 100);
}

function applyScalingFromSettings() {
  const scaling = Math.round((controller.state.settings?.scaling ?? 1) * 100);
  applyScaling(scaling);
}

async function refreshCacheInfo() {
  try {
    const info = await api.getCache();
    page.cacheEntries = Number(info?.entries ?? info?.entryCount ?? 0);
    page.cachePath = info?.path ?? "";
    const hint = byId("cache-hint");
    if (hint) {
      hint.textContent = page.cacheEntries
        ? `已缓存 ${formatCount(page.cacheEntries)} 条文件指纹`
        : "仅保存路径、文件状态与 SHA-256";
      hint.title = page.cachePath ? `缓存文件：${page.cachePath}` : "";
    }
  } catch {
    // 缓存信息只用于提示，失败时保留默认文案。
  }
}

async function clearCache() {
  let entries = page.cacheEntries;
  if (!entries) {
    try {
      const info = await api.getCache();
      entries = Number(info?.entries ?? info?.entryCount ?? 0);
      page.cacheEntries = entries;
    } catch (error) {
      alertDialog({
        title: "清理失败",
        message: `无法读取扫描缓存：${error.message}`,
        tone: "danger",
        confirmText: "知道了",
        cancelText: null,
      });
      return;
    }
  }
  if (!entries) {
    byId("cache-hint").textContent = "缓存当前为空";
    alertDialog({
      title: "扫描缓存",
      message: "当前没有可清理的文件指纹缓存。",
      tone: "info",
      confirmText: "知道了",
      cancelText: null,
    });
    return;
  }
  const confirmed = await confirmDialog({
    title: "清理扫描缓存",
    message: `将清理 ${formatCount(entries)} 条文件指纹记录。照片和扫描结果不会被删除；下次扫描会重新计算。`,
    confirmText: "清理",
    cancelText: "取消",
  });
  if (!confirmed) {
    return;
  }
  try {
    const result = await api.clearCache();
    const cleared = Number(result?.cleared ?? entries);
    page.cacheEntries = 0;
    byId("cache-hint").textContent = `已清理 ${formatCount(cleared)} 条指纹记录`;
    controller.addLog("INFO", `已清理 ${formatCount(cleared)} 条扫描指纹缓存`);
    controller.refreshSystem();
    controller.toast("扫描缓存已清理", { type: "success" });
  } catch (error) {
    byId("cache-hint").textContent = "缓存文件当前无法删除";
    alertDialog({
      title: "清理失败",
      message: "缓存文件可能正被占用或配置目录不可写。请关闭其它任务后重试。",
      tone: "danger",
      confirmText: "知道了",
      cancelText: null,
    });
  }
}

export { page as settingsState, formatBytes };
