/**
 * 日期修复页面（对应 历史 Python v4.1 参考实现 的 fix 页）。
 *
 * 不重组目录；递归推断日期并修改文件最后修改时间，可选按拍摄日期修正
 * 严格日期型文件名。支持“仅预演”，第一次使用建议先预演核对。
 */

import { openDirPicker } from "../dir-picker.js";
import { alertDialog, confirmDanger } from "../confirm.js";
import * as controller from "../controller.js";
import { byId } from "../dom.js";
import { formatCount, escapeHtml } from "../format.js";
import { hydrateIcons, icon } from "../icons.js";

const page = { starting: false };

let bound = false;
let formSaveTimer = null;

function switchMarkup(id, label, checked) {
  return `
    <label class="g-switch">
      <input type="checkbox" id="${id}" ${checked ? "checked" : ""}>
      <span class="g-switch__track"></span>
      <span class="g-switch__text">${label}</span>
    </label>`;
}

function buildMarkup() {
  return `
  <div class="glass-header page-header">
    <div class="glass-header__text">
      <h1 class="glass-title">修复文件拍摄日期</h1>
      <p class="glass-subtitle">不重组目录；修正媒体修改时间，也可安全修正错误的日期型文件名。</p>
    </div>
  </div>

  <div class="card glass-card path-card">
    <div class="path-row">
      <div class="path-row__label">${icon("folder")}<span>待修复媒体目录</span></div>
      <input class="g-input g-input--mono" id="fix-dir" type="text" spellcheck="false" autocomplete="off" placeholder="选择需要修复日期的媒体目录" />
      <button class="g-btn g-btn--secondary g-btn--sm path-row__browse" type="button" id="btn-browse-fix">浏览…</button>
    </div>
  </div>

  <div class="fix-grid">
    <div class="card glass-card fix-card">
      <div class="card-head"><div class="card-head__title">日期来源</div></div>
      <div class="fix-card__body">
        ${switchMarkup("fix-use-json", "读取 Google Photos JSON", true)}
        ${switchMarkup("fix-use-exif", "读取照片 EXIF", true)}
        ${switchMarkup("fix-use-filename", "从文件名识别日期", true)}
        ${switchMarkup("fix-aggressive", "启用深度 JSON 匹配", true)}
        ${switchMarkup("fix-use-mtime", "最后使用文件原修改时间", false)}
      </div>
    </div>

    <div class="card glass-card fix-card">
      <div class="card-head"><div class="card-head__title">执行方式</div></div>
      <div class="fix-card__body">
        ${switchMarkup("fix-recursive", "递归处理所有子目录", true)}
        ${switchMarkup("fix-dry-run", "仅预演，不修改任何文件", false)}
        ${switchMarkup("fix-hidden", "包含隐藏文件与隐藏目录", false)}
        <label class="g-check" style="margin-top:2px">
          <input type="checkbox" id="fix-correct-date">
          <span class="g-check__box"></span>
          <span class="g-check__text"><span class="g-check__label">按拍摄日期修正日期型文件名</span></span>
        </label>
        <div class="fix-rule-note">
          重命名仅针对完整日期型名称 YYYY-MM-DD(编号)，保留编号和扩展名；建议首次先启用“仅预演”。
        </div>
      </div>
    </div>
  </div>

  <div class="card glass-card fix-summary-card">
    <div class="card-head">
      <div class="card-head__title">任务摘要</div>
      <div class="g-spacer"></div>
      <div class="card-head__hint" id="fix-hint">等待任务开始</div>
    </div>
    <div class="fix-summary" id="fix-summary">等待任务开始。</div>
  </div>

  <div class="card glass-card controls-card">
    <div class="controls-status">
      <div class="controls-status__text" id="fix-status">准备就绪</div>
      <div class="g-progress g-progress--sm" aria-hidden="true">
        <div class="g-progress__bar" id="fix-progress-bar" style="--value:0%"></div>
      </div>
    </div>
    <div class="controls-buttons">
      <button class="g-btn g-btn--primary" type="button" id="btn-start-fix">开始修复</button>
      <button class="g-btn g-btn--ghost" type="button" id="btn-fix-cancel" disabled>取消</button>
    </div>
  </div>`;
}

export function initFixPage() {
  const host = byId("page-fix");
  if (!host) {
    return;
  }
  host.innerHTML = buildMarkup();
  hydrateIcons(host);
  applySettings();
  if (!bound) {
    bound = true;
    bindEvents();
    bindController();
  }
  updateButtons();
}

function applySettings() {
  const settings = controller.state.settings ?? {};
  byId("fix-dir").value = settings.fix_dir ?? "";
  setCheck("fix-use-json", settings.fix_json ?? true);
  setCheck("fix-use-exif", settings.fix_exif ?? true);
  setCheck("fix-use-filename", settings.fix_filename ?? true);
  setCheck("fix-aggressive", settings.fix_aggressive ?? true);
  setCheck("fix-use-mtime", settings.fix_file_mtime ?? false);
  setCheck("fix-recursive", settings.fix_recursive ?? true);
  setCheck("fix-dry-run", settings.fix_dry_run ?? false);
  setCheck("fix-hidden", settings.fix_include_hidden ?? false);
  setCheck("fix-correct-date", settings.fix_correct_date_filenames ?? false);
}

function setCheck(id, value) {
  const node = byId(id);
  if (node) {
    node.checked = Boolean(value);
  }
}

function readCheck(id) {
  return Boolean(byId(id)?.checked);
}

function bindEvents() {
  byId("btn-browse-fix").addEventListener("click", () => {
    openDirPicker({
      title: "选择需要修复日期的媒体目录",
      subtitle: "将递归推断拍摄日期并修改文件最后修改时间",
      initial: byId("fix-dir").value || controller.state.settings?.fix_dir || "",
      onSelect: (path) => {
        byId("fix-dir").value = path;
        schedulePersist();
      },
    });
  });
  byId("fix-dir").addEventListener("change", schedulePersist);
  for (const id of [
    "fix-use-json",
    "fix-use-exif",
    "fix-use-filename",
    "fix-aggressive",
    "fix-use-mtime",
    "fix-recursive",
    "fix-dry-run",
    "fix-hidden",
    "fix-correct-date",
  ]) {
    byId(id)?.addEventListener("change", schedulePersist);
  }
  byId("btn-start-fix").addEventListener("click", () => startFix());
  byId("btn-fix-cancel").addEventListener("click", () => {
    controller.cancelCurrent();
    setStatus("正在安全取消，等待当前文件处理结束…", "warning");
    byId("btn-fix-cancel").disabled = true;
  });
}

function bindController() {
  controller.on("progress", (update) => {
    if (controller.state.activeTask !== "fix") {
      return;
    }
    setStatus(controller.progressText(update));
    setProgress(controller.progressRatio(update));
    byId("btn-fix-cancel").disabled = false;
  });
  controller.on("busy", (payload) => {
    page.starting = false;
    updateButtons();
    if (!payload.busy) {
      byId("btn-fix-cancel").disabled = true;
    }
  });
  controller.on("fix", (payload) => onFixResult(payload));
  controller.on("cancelled", (payload) => {
    if (controller.state.sessionType !== "fix") {
      return;
    }
    setStatus("任务已取消", "warning");
    alertDialog({
      title: "任务已取消",
      message: payload?.message || "任务已安全停止。已完成的独立文件会保留。",
      tone: "warning",
      confirmText: "知道了",
      cancelText: null,
    });
    updateButtons();
  });
  controller.on("error", (payload) => {
    if (controller.state.sessionType !== "fix") {
      return;
    }
    setStatus("任务失败，请查看日志", "error");
    alertDialog({
      title: "任务失败",
      message: `${payload?.message ?? "未知错误"}\n\n详细信息已写入日志页。`,
      tone: "danger",
      confirmText: "知道了",
      cancelText: null,
    });
    updateButtons();
  });
}

function schedulePersist() {
  if (formSaveTimer) {
    clearTimeout(formSaveTimer);
  }
  formSaveTimer = setTimeout(() => {
    formSaveTimer = null;
    const patch = {
      fix_dir: byId("fix-dir").value,
      fix_json: readCheck("fix-use-json"),
      fix_exif: readCheck("fix-use-exif"),
      fix_filename: readCheck("fix-use-filename"),
      fix_aggressive: readCheck("fix-aggressive"),
      fix_file_mtime: readCheck("fix-use-mtime"),
      fix_recursive: readCheck("fix-recursive"),
      fix_dry_run: readCheck("fix-dry-run"),
      fix_include_hidden: readCheck("fix-hidden"),
      fix_correct_date_filenames: readCheck("fix-correct-date"),
    };
    if (controller.state.settings?.remember_paths) {
      patch.fix_dir = byId("fix-dir").value;
    }
    controller.saveSettings(patch);
  }, 420);
}

function setStatus(text, tone = "") {
  const node = byId("fix-status");
  node.textContent = text;
  node.className = "controls-status__text";
  if (tone) {
    node.classList.add(`is-${tone}`);
  }
}

function setProgress(ratio) {
  byId("fix-progress-bar").style.setProperty(
    "--value",
    `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`,
  );
}

function updateButtons() {
  const busy = controller.state.busy || page.starting;
  byId("btn-start-fix").disabled = busy;
  byId("btn-fix-cancel").disabled = !(controller.state.busy && !page.starting);
}

function collectOptions() {
  const inputDir = byId("fix-dir").value.trim();
  if (!inputDir) {
    alertDialog({
      title: "请选择目录",
      message: "请选择需要修复日期的媒体目录。",
      tone: "warning",
      confirmText: "知道了",
      cancelText: null,
    });
    return null;
  }
  const options = {
    inputDir,
    recursive: readCheck("fix-recursive"),
    useJson: readCheck("fix-use-json"),
    useExif: readCheck("fix-use-exif"),
    useFilename: readCheck("fix-use-filename"),
    aggressiveJson: readCheck("fix-aggressive"),
    useFileMtime: readCheck("fix-use-mtime"),
    dryRun: readCheck("fix-dry-run"),
    includeHidden: readCheck("fix-hidden"),
    correctDateFilenames: readCheck("fix-correct-date"),
  };
  if (!(options.useJson || options.useExif || options.useFilename || options.useFileMtime)) {
    alertDialog({
      title: "缺少日期来源",
      message: "请至少启用一种日期来源。",
      tone: "warning",
      confirmText: "知道了",
      cancelText: null,
    });
    return null;
  }
  return options;
}

async function startFix() {
  const options = collectOptions();
  if (!options) {
    return;
  }
  if (!options.dryRun) {
    const confirmed = await confirmDanger({
      title: "确认修改文件时间",
      message: "此操作会修改目录内媒体文件的最后修改时间。\n建议先启用“仅预演”。\n\n确定继续吗？",
      confirmText: "确定继续",
      cancelText: "取消",
    });
    if (!confirmed) {
      return;
    }
  }
  page.starting = true;
  updateButtons();
  setStatus("正在创建修复任务…");
  setProgress(0);
  setSummary("等待任务开始。");
  try {
    await controller.startFix(options);
  } catch (error) {
    page.starting = false;
    updateButtons();
    setStatus("任务失败，请查看日志", "error");
    alertDialog({
      title: "无法开始",
      message: error?.errors?.length
        ? error.errors.map((item) => `• ${item}`).join("\n")
        : `${error.message}\n\n详细信息已写入日志页。`,
      tone: "danger",
      confirmText: "知道了",
      cancelText: null,
    });
  }
}

function setSummary(text) {
  byId("fix-summary").textContent = text;
}

function onFixResult(payload) {
  const result = payload?.result ?? payload ?? {};
  const dryRun = Boolean(result.dryRun ?? result.dry_run ?? readCheck("fix-dry-run"));
  const total = Number(result.total) || 0;
  const updated = Number(result.updated) || 0;
  const unchanged = Number(result.unchanged) || 0;
  const failed = Number(result.failed) || 0;
  const renamed = Number(result.renamed) || 0;
  const renameCandidates = Number(result.renameCandidates ?? result.rename_candidates) || 0;
  const errors = result.errors ?? [];
  let text =
    `扫描文件：${formatCount(total)}\n` +
    `${dryRun ? "预计可更新" : "已更新时间"}：${formatCount(updated)}\n` +
    `${dryRun ? "预计可重命名" : "已重命名"}：${formatCount(dryRun ? renameCandidates : renamed)}\n` +
    `保持不变：${formatCount(unchanged)}\n` +
    `失败：${formatCount(failed)}`;
  if (errors.length) {
    text += `\n\n部分错误：\n${errors
      .slice(0, 20)
      .map((item) => `• ${item}`)
      .join("\n")}`;
    controller.addLog("ERROR", errors.join("\n"));
  }
  setSummary(text);
  setProgress(1);
  setStatus("日期修复任务已完成", errors.length ? "warning" : "success");
  controller.addLog("INFO", text.replaceAll("\n", "；"));
  byId("fix-hint").textContent = dryRun ? "预演结果（未修改任何文件）" : "已完成";
  alertDialog({
    title: "日期修复完成",
    message: text.split("\n\n")[0],
    tone: errors.length ? "warning" : "success",
    confirmText: "知道了",
    cancelText: null,
  });
  updateButtons();
}

export { page as fixState };
