/**
 * 整理 Takeout 页面。
 *
 * 功能与 历史 Python v4.1 参考实现 的 organise 页一一对应：目录选择、全部基础/高级选项、
 * 扫描预览统计、分批渐进式计划预览（虚拟滚动）、重复项对比入口、执行前确认、
 * 移动/覆盖风险提示、取消与任务结果反馈。
 */

import { api } from "../api.js";
import { openDirPicker } from "../dir-picker.js";
import { openDuplicates } from "../duplicates.js";
import { alertDialog, confirmDanger } from "../confirm.js";
import * as controller from "../controller.js";
import { byId, nextFrame, on, rafThrottle, toggleClass } from "../dom.js";
import {
  ALBUM_OPTIONS,
  CONFLICT_OPTIONS,
  DIVISION_OPTIONS,
  LIVE_PHOTO_TARGET_OPTIONS,
  UNKNOWN_OPTIONS,
  actionLabel,
  albumLabel,
  conflictLabel,
  divisionLabel,
  escapeHtml,
  formatCount,
  formatPercent,
  liveTargetLabel,
  truncateMiddle,
  unknownLabel,
} from "../format.js";
import { hydrateIcons, icon } from "../icons.js";

const ROW_HEIGHT = 34;
const PREVIEW_BATCH_MIN = 100;
const PREVIEW_BATCH_MAX = 1000;
const PREVIEW_BATCH_DEFAULT = 300;

const page = {
  optionsCollapsed: false,
  starting: false,
  scanOptions: null,
  previewRows: [],
  previewTotal: 0,
  previewLoaded: 0,
  previewGeneration: 0,
  visibleStart: -1,
  visibleEnd: -1,
};

let bound = false;
let formSaveTimer = null;

/* ------------------------------- 标记构建 -------------------------------- */

function switchMarkup(id, label, checked, extraClass = "") {
  return `
    <label class="g-switch ${extraClass}" title="">
      <input type="checkbox" id="${id}" ${checked ? "checked" : ""}>
      <span class="g-switch__track"></span>
      <span class="g-switch__text">${label}</span>
    </label>`;
}

function checkMarkup(id, label, checked) {
  return `
    <label class="g-check">
      <input type="checkbox" id="${id}" ${checked ? "checked" : ""}>
      <span class="g-check__box"></span>
      <span class="g-check__text"><span class="g-check__label">${label}</span></span>
    </label>`;
}

function selectMarkup(id, options, value) {
  return `<select class="g-select" id="${id}">${options
    .map(
      (item) =>
        `<option value="${escapeHtml(item.value)}"${item.value === value ? " selected" : ""}>${escapeHtml(item.label)}</option>`,
    )
    .join("")}</select>`;
}

function fieldMarkup(label, control) {
  return `<div class="opt-field"><label class="opt-field__label">${label}</label>${control}</div>`;
}

function statsMarkup() {
  const items = [
    ["discovered", "发现媒体", "photo", "is-info"],
    ["unique", "去重后", "layers", "is-success"],
    ["duplicates", "重复组", "repeat", "is-warning"],
    ["unknown", "日期未知", "calendar", "is-muted"],
    ["actions", "计划动作", "list", "is-info"],
  ];
  return items
    .map(
      ([key, label, iconName, iconClass]) => `
      <div class="g-stat glass-card" data-stat-card="${key}">
        <div class="g-stat__head">
          <span class="g-stat__label">${label}</span>
          <span class="g-stat__icon ${iconClass}">${icon(iconName)}</span>
        </div>
        <div class="g-stat__value" data-stat="${key}">—</div>
      </div>`,
    )
    .join("");
}

function buildMarkup() {
  const albumOptions = ALBUM_OPTIONS;
  return `
  <div class="glass-header page-header">
    <div class="glass-header__text">
      <h1 class="glass-title">整理 <em>Google Photos Takeout</em></h1>
      <p class="glass-subtitle">选择目录、调整规则，先预览再执行。所有处理均在本机完成。</p>
    </div>
    <div class="page-head-actions">
      <button class="g-btn g-btn--secondary g-btn--sm" type="button" id="btn-toggle-options">收起选项</button>
    </div>
  </div>

  <div class="card glass-card path-card">
    <div class="path-row">
      <div class="path-row__label">${icon("folder")}<span>Takeout 输入目录</span></div>
      <input class="g-input g-input--mono" id="input-dir" type="text" spellcheck="false" autocomplete="off" placeholder="选择已合并解压的 Google Takeout 目录" />
      <button class="g-btn g-btn--secondary g-btn--sm path-row__browse" type="button" id="btn-browse-input">浏览…</button>
    </div>
    <div class="path-row">
      <div class="path-row__label">${icon("folder")}<span>整理结果输出目录</span></div>
      <input class="g-input g-input--mono" id="output-dir" type="text" spellcheck="false" autocomplete="off" placeholder="选择整理结果输出目录（不能与输入目录相同）" />
      <button class="g-btn g-btn--secondary g-btn--sm path-row__browse" type="button" id="btn-browse-output">浏览…</button>
    </div>
  </div>

  <div class="card glass-card options-card" id="options-card">
    <div class="options-tabs">
      <div class="g-tabs" data-tab-scope="#options-card">
        <button class="g-tab is-active" type="button" data-tab="basic">基础选项</button>
        <button class="g-tab" type="button" data-tab="advanced">高级选项</button>
      </div>
      <span class="inline-hint">所有选项在扫描时生效；修改后请重新扫描预览。</span>
    </div>

    <div class="options-body" data-tab-panel="basic" id="options-basic">
      <div class="opt-grid opt-grid--basic">
        ${fieldMarkup(
          "处理方式",
          `<div class="g-segmented g-segmented--block" id="seg-operation">
             <button class="g-segment is-selected" type="button" data-value="copy">复制（推荐）</button>
             <button class="g-segment" type="button" data-value="move">移动</button>
           </div>`,
        )}
        ${fieldMarkup("相册处理", selectMarkup("sel-album", albumOptions, "shortcut"))}
        ${fieldMarkup("目录结构", selectMarkup("sel-division", DIVISION_OPTIONS, "year-month"))}
      </div>
      <div class="opt-switches">
        ${switchMarkup("sw-skip-extras", "跳过编辑版、特效版等额外副本", false)}
        ${switchMarkup("sw-set-mtime", "写入正确的文件修改时间", true)}
        ${switchMarkup("sw-write-report", "生成 JSON 运行报告", true)}
      </div>
      <div class="correct-name-row">
        ${checkMarkup("chk-correct-date", "按拍摄日期修正日期型文件名", false)}
        <span class="inline-hint">仅处理完整日期型名称 YYYY-MM-DD(编号)，保留编号和扩展名；默认关闭。</span>
      </div>
    </div>

    <div class="options-body" data-tab-panel="advanced" id="options-advanced" hidden>
      <div class="opt-grid opt-grid--advanced">
        ${fieldMarkup("同名文件", selectMarkup("sel-conflict", CONFLICT_OPTIONS, "rename"))}
        ${fieldMarkup("未知日期", selectMarkup("sel-unknown", UNKNOWN_OPTIONS, "folder"))}
        ${fieldMarkup("并发线程", selectMarkup("sel-workers", [1, 2, 4, 6, 8, 12, 16].map((n) => ({ value: String(n), label: String(n) })), "4"))}
        <div class="opt-field opt-folder-fields">
          <div class="opt-folder-row"><label for="inp-all-photos">总照片目录</label><input class="g-input" id="inp-all-photos" type="text" value="ALL_PHOTOS" spellcheck="false"></div>
          <div class="opt-folder-row"><label for="inp-unknown-folder">未知日期目录</label><input class="g-input" id="inp-unknown-folder" type="text" value="date-unknown" spellcheck="false"></div>
        </div>
      </div>
      <div class="opt-checks">
        ${switchMarkup("sw-use-json", "JSON", true)}
        ${switchMarkup("sw-use-exif", "EXIF", true)}
        ${switchMarkup("sw-use-filename", "文件名", true)}
        ${switchMarkup("sw-aggressive-json", "深度匹配 JSON", true)}
        ${switchMarkup("sw-use-mtime", "文件原修改时间", false)}
        ${switchMarkup("sw-scan-fallback", "无 Takeout 结构时扫描全部", true)}
        ${switchMarkup("sw-include-hidden", "包含隐藏文件", false)}
        ${switchMarkup("sw-hash-cache", "复用未变化文件指纹", true)}
      </div>
      <div class="live-photo-row">
        ${switchMarkup("sw-live-photo", "识别并配对实况照片（Live Photo）", false)}
        <div class="live-photo-target">
          <label for="sel-live-target">后续导入方式</label>
          ${selectMarkup("sel-live-target", LIVE_PHOTO_TARGET_OPTIONS, "apple")}
        </div>
        <div class="live-photo-hint" id="live-photo-hint">
          两项均输出 Apple 原始双文件；不转码，真 MP3 只做内容探测且不纳入整理。Apple“照片”需同时导入两半。
        </div>
      </div>
    </div>
  </div>

  <div class="stat-row">${statsMarkup()}</div>

  <div class="card glass-card preview-card">
    <div class="preview-head">
      <div class="card-head__title">执行计划预览</div>
      <button class="g-btn g-btn--secondary g-btn--sm" type="button" id="btn-duplicates" disabled>重复项对比</button>
      <div class="g-spacer"></div>
      <div class="preview-head__hint" id="preview-hint">尚未扫描</div>
    </div>
    <div class="preview-table-wrap" id="preview-scroll">
      <table class="preview-table g-table">
        <colgroup>
          <col style="width:132px"><col><col><col style="width:170px"><col style="width:132px">
        </colgroup>
        <thead>
          <tr><th>动作</th><th>源文件</th><th>目标文件</th><th>拍摄日期</th><th>相册</th></tr>
        </thead>
        <tbody id="preview-tbody">
          <tr><td colspan="5" class="preview-table__empty">尚未扫描。配置好选项后点击“扫描预览”生成执行计划。</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="card glass-card controls-card">
    <div class="controls-status">
      <div class="controls-status__text" id="organize-status">准备就绪</div>
      <div class="g-progress g-progress--sm" aria-hidden="true">
        <div class="g-progress__bar" id="organize-progress-bar" style="--value:0%"></div>
      </div>
    </div>
    <div class="controls-buttons">
      <button class="g-btn g-btn--secondary" type="button" id="btn-analyze">扫描预览</button>
      <button class="g-btn g-btn--primary" type="button" id="btn-execute">开始整理</button>
      <button class="g-btn g-btn--ghost" type="button" id="btn-cancel" disabled>取消</button>
    </div>
  </div>`;
}

/* -------------------------------- 初始化 --------------------------------- */

export function initOrganize() {
  const host = byId("page-organize");
  if (!host) {
    return;
  }
  host.innerHTML = buildMarkup();
  hydrateIcons(host);
  bindEvents();
  bindController();
  applySettingsToForm(controller.state.settings ?? {});
  updateLivePhotoControls();
  updateButtons();
  renderPreviewWindow();
  window.addEventListener(
    "resize",
    rafThrottle(() => renderPreviewWindow(true)),
    { passive: true },
  );
}

function bindEvents() {
  if (bound) {
    return;
  }
  bound = true;

  byId("btn-browse-input").addEventListener("click", () => {
    openDirPicker({
      title: "选择已合并解压的 Google Takeout 目录",
      subtitle: "应包含 Takeout/ 目录树或 Photos from YYYY 年份目录",
      initial: byId("input-dir").value || controller.state.settings?.input_dir || "",
      onSelect: (path) => {
        byId("input-dir").value = path;
        schedulePersist();
      },
    });
  });
  byId("btn-browse-output").addEventListener("click", () => {
    openDirPicker({
      title: "选择整理结果输出目录",
      subtitle: "输出目录不能与输入目录相同；尚未创建的目录也可以直接输入路径",
      initial: byId("output-dir").value || controller.state.settings?.output_dir || "",
      onSelect: (path) => {
        byId("output-dir").value = path;
        schedulePersist();
      },
    });
  });

  for (const id of ["input-dir", "output-dir"]) {
    byId(id).addEventListener("change", schedulePersist);
  }

  byId("btn-toggle-options").addEventListener("click", () => {
    page.optionsCollapsed = !page.optionsCollapsed;
    toggleClass(byId("options-card"), "is-hidden", page.optionsCollapsed);
    byId("options-card").style.display = page.optionsCollapsed ? "none" : "";
    byId("btn-toggle-options").textContent = page.optionsCollapsed ? "展开选项" : "收起选项";
  });

  byId("btn-analyze").addEventListener("click", () => startAnalysis());
  byId("btn-execute").addEventListener("click", () => startExecution());
  byId("btn-cancel").addEventListener("click", () => cancelTask());
  byId("btn-duplicates").addEventListener("click", () => {
    if (!controller.state.sessionId) {
      return;
    }
    openDuplicates({ sessionId: controller.state.sessionId });
  });

  byId("sw-live-photo").addEventListener("change", () => {
    updateLivePhotoControls();
    schedulePersist();
  });
  byId("sel-live-target").addEventListener("change", () => {
    updateLivePhotoControls();
    schedulePersist();
  });

  const optionIds = [
    "sel-album",
    "sel-division",
    "sel-conflict",
    "sel-unknown",
    "sel-workers",
    "inp-all-photos",
    "inp-unknown-folder",
    "sw-skip-extras",
    "sw-set-mtime",
    "sw-write-report",
    "chk-correct-date",
    "sw-use-json",
    "sw-use-exif",
    "sw-use-filename",
    "sw-aggressive-json",
    "sw-use-mtime",
    "sw-scan-fallback",
    "sw-include-hidden",
    "sw-hash-cache",
    "sel-live-target",
  ];
  for (const id of optionIds) {
    byId(id)?.addEventListener("change", schedulePersist);
  }

  byId("seg-operation").addEventListener("change", (event) => {
    const value = event.detail?.value;
    if (value) {
      byId("seg-operation").dataset.value = value;
    }
    schedulePersist();
  });

  const scroller = byId("preview-scroll");
  scroller.addEventListener(
    "scroll",
    rafThrottle(() => renderPreviewWindow()),
    { passive: true },
  );
}

function bindController() {
  controller.on("analysis", onAnalysis);
  controller.on("progress", onProgress);
  controller.on("busy", onBusy);
  controller.on("execution", onExecution);
  controller.on("cancelled", onCancelled);
  controller.on("error", onError);
  controller.on("session-state", () => updateButtons());
  controller.on("session-reset", () => {
    page.scanOptions = null;
    clearPreview("尚未扫描");
    updateButtons();
  });
}

/* ------------------------------ 设置 <-> 表单 ----------------------------- */

function applySettingsToForm(settings) {
  if (!settings) {
    return;
  }
  const value = (key, fallback) => settings[key] ?? fallback;
  byId("input-dir").value = value("input_dir", "");
  byId("output-dir").value = value("output_dir", "");
  byId("sel-album").value = value("album_mode", "shortcut");
  byId("sel-division").value = value("date_division", "year-month");
  byId("sel-conflict").value = value("conflict_mode", "rename");
  byId("sel-unknown").value = value("unknown_date_mode", "folder");
  const workers = String(value("workers", 4));
  byId("sel-workers").value = workers;
  if (byId("sel-workers").value !== workers) {
    byId("sel-workers").value = "4";
  }
  byId("inp-all-photos").value = value("all_photos_folder", "ALL_PHOTOS");
  byId("inp-unknown-folder").value = value("unknown_date_folder", "date-unknown");
  setCheck("sw-skip-extras", value("skip_extras", false));
  setCheck("sw-set-mtime", value("set_file_mtime", true));
  setCheck("sw-write-report", value("write_report", true));
  setCheck("chk-correct-date", value("correct_date_filenames", false));
  setCheck("sw-use-json", value("use_json", true));
  setCheck("sw-use-exif", value("use_exif", true));
  setCheck("sw-use-filename", value("use_filename", true));
  setCheck("sw-aggressive-json", value("aggressive_json", true));
  setCheck("sw-use-mtime", value("use_file_mtime", false));
  setCheck("sw-scan-fallback", value("scan_all_if_no_takeout", true));
  setCheck("sw-include-hidden", value("include_hidden", false));
  setCheck("sw-hash-cache", value("use_hash_cache", true));
  setCheck("sw-live-photo", value("recognize_live_photos", false));
  byId("sel-live-target").value = value("live_photo_target", "apple");
  const operation = value("operation", "copy");
  const segment = byId("seg-operation");
  segment.querySelectorAll(".g-segment").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.value === operation);
  });
  segment.dataset.value = operation;
  if (window.Glass?.selectSegment) {
    const target = segment.querySelector(`.g-segment[data-value="${operation}"]`);
    if (target) {
      window.Glass.selectSegment(segment, target, { emit: false });
    }
  }
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

function currentOperation() {
  return byId("seg-operation").dataset.value || "copy";
}

function collectOptions({ silent = false } = {}) {
  const inputDir = byId("input-dir").value.trim();
  const outputDir = byId("output-dir").value.trim();
  if (!inputDir || !outputDir) {
    if (!silent) {
      alertDialog({
        title: "目录不完整",
        message: "请先选择输入目录和输出目录。",
        tone: "warning",
        confirmText: "知道了",
        cancelText: null,
      });
    }
    return null;
  }
  const options = {
    inputDir,
    outputDir,
    operation: currentOperation(),
    albumMode: byId("sel-album").value,
    dateDivision: byId("sel-division").value,
    conflictMode: byId("sel-conflict").value,
    unknownDateMode: byId("sel-unknown").value,
    skipExtras: readCheck("sw-skip-extras"),
    useJson: readCheck("sw-use-json"),
    useExif: readCheck("sw-use-exif"),
    useFilename: readCheck("sw-use-filename"),
    aggressiveJson: readCheck("sw-aggressive-json"),
    useFileMtime: readCheck("sw-use-mtime"),
    setFileMtime: readCheck("sw-set-mtime"),
    scanAllIfNoTakeout: readCheck("sw-scan-fallback"),
    includeHidden: readCheck("sw-include-hidden"),
    writeReport: readCheck("sw-write-report"),
    useHashCache: readCheck("sw-hash-cache"),
    recognizeLivePhotos: readCheck("sw-live-photo"),
    livePhotoTarget: byId("sel-live-target").value,
    correctDateFilenames: readCheck("chk-correct-date"),
    allPhotosFolder: byId("inp-all-photos").value.trim(),
    unknownDateFolder: byId("inp-unknown-folder").value.trim(),
    workers: Number.parseInt(byId("sel-workers").value, 10) || 4,
  };
  if (!(options.useJson || options.useExif || options.useFilename || options.useFileMtime)) {
    if (!silent) {
      showBlockingErrors(["至少需要启用一种日期来源"]);
    }
    return null;
  }
  if (sameLocalPath(inputDir, outputDir)) {
    if (!silent) {
      showBlockingErrors(["输入目录与输出目录不能相同"]);
    }
    return null;
  }
  return options;
}

function sameLocalPath(left, right) {
  const normalize = (value) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  if (/^[a-zA-Z]:/.test(a) && /^[a-zA-Z]:/.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function settingsPatchFromForm() {
  const patch = {
    operation: currentOperation(),
    album_mode: byId("sel-album").value,
    date_division: byId("sel-division").value,
    conflict_mode: byId("sel-conflict").value,
    unknown_date_mode: byId("sel-unknown").value,
    skip_extras: readCheck("sw-skip-extras"),
    set_file_mtime: readCheck("sw-set-mtime"),
    write_report: readCheck("sw-write-report"),
    correct_date_filenames: readCheck("chk-correct-date"),
    use_json: readCheck("sw-use-json"),
    use_exif: readCheck("sw-use-exif"),
    use_filename: readCheck("sw-use-filename"),
    aggressive_json: readCheck("sw-aggressive-json"),
    use_file_mtime: readCheck("sw-use-mtime"),
    scan_all_if_no_takeout: readCheck("sw-scan-fallback"),
    include_hidden: readCheck("sw-include-hidden"),
    use_hash_cache: readCheck("sw-hash-cache"),
    recognize_live_photos: readCheck("sw-live-photo"),
    live_photo_target: byId("sel-live-target").value,
    workers: Number.parseInt(byId("sel-workers").value, 10) || 4,
    all_photos_folder: byId("inp-all-photos").value,
    unknown_date_folder: byId("inp-unknown-folder").value,
  };
  if (controller.state.settings?.remember_paths) {
    patch.input_dir = byId("input-dir").value;
    patch.output_dir = byId("output-dir").value;
  }
  return patch;
}

function schedulePersist() {
  if (formSaveTimer) {
    clearTimeout(formSaveTimer);
  }
  formSaveTimer = setTimeout(() => {
    formSaveTimer = null;
    const patch = settingsPatchFromForm();
    const current = controller.state.settings ?? {};
    const changed = Object.entries(patch).some(([key, value]) => current[key] !== value);
    if (changed) {
      controller.saveSettings(patch);
    }
  }, 420);
}

/* -------------------------------- 交互逻辑 -------------------------------- */

function updateLivePhotoControls() {
  const enabled = readCheck("sw-live-photo");
  const busy = controller.state.busy;
  byId("sw-live-photo").disabled = busy;
  const target = byId("sel-live-target");
  target.disabled = !enabled || busy;
  const hint = byId("live-photo-hint");
  if (hint) {
    const apple = byId("sel-live-target").value === "apple";
    hint.textContent = apple
      ? "两项均输出 Apple 原始双文件；不转码，真 MP3 只做内容探测且不纳入整理。Apple“照片”需同时导入两半。"
      : "两项均输出 Apple 原始双文件；不转码，真 MP3 只做内容探测且不纳入整理。ColorOS 需经 O+ 互联传输。";
    hint.style.opacity = enabled && !busy ? "1" : "0.6";
  }
}

function updateButtons() {
  const busy = controller.state.busy || page.starting;
  const analysing = controller.state.sessionState === "analysed";
  byId("btn-analyze").disabled = busy;
  byId("btn-execute").disabled = busy;
  byId("btn-cancel").disabled = !(controller.state.busy && !page.starting);
  const duplicateButton = byId("btn-duplicates");
  const duplicateCount = controller.state.duplicateTotal ?? 0;
  duplicateButton.disabled = busy || duplicateCount <= 0;
  duplicateButton.textContent = duplicateCount > 0
    ? `重复项对比 · ${formatCount(duplicateCount)} 组`
    : "重复项对比";
  duplicateButton.hidden = false;
  updateLivePhotoControls();
}

function onBusy() {
  page.starting = false;
  updateButtons();
}

function setStatus(text, tone = "") {
  const node = byId("organize-status");
  node.textContent = text;
  node.className = "controls-status__text";
  if (tone) {
    node.classList.add(`is-${tone}`);
  }
}

function setProgress(ratio) {
  const bar = byId("organize-progress-bar");
  bar.style.setProperty("--value", `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`);
}

function showBlockingErrors(errors) {
  const list = document.createElement("div");
  for (const item of errors) {
    const line = document.createElement("div");
    line.textContent = `• ${item}`;
    list.append(line);
  }
  return alertDialog({
    title: "无法开始",
    content: list,
    tone: "warning",
    confirmText: "知道了",
    cancelText: null,
  });
}

function handleApiError(error, title = "任务失败") {
  if (error?.errors?.length) {
    showBlockingErrors(error.errors);
    return;
  }
  alertDialog({
    title,
    message: `${error?.message ?? "未知错误"}\n\n详细信息已写入日志页。`,
    tone: "danger",
    confirmText: "知道了",
    cancelText: null,
  });
}

async function startAnalysis() {
  const options = collectOptions();
  if (!options) {
    return;
  }
  page.scanOptions = options;
  page.starting = true;
  updateButtons();
  clearPreview("正在生成预览…");
  setStatus("正在创建扫描任务…");
  setProgress(0);
  try {
    await controller.startAnalysis(options);
  } catch (error) {
    page.starting = false;
    updateButtons();
    setStatus("任务失败，请查看日志", "error");
    handleApiError(error, "无法开始");
  }
}

async function startExecution() {
  const options = collectOptions();
  if (!options) {
    return;
  }
  if (options.operation === "move") {
    const confirmed = await confirmDanger({
      title: "确认移动模式",
      message: "移动会改变输入目录。建议先使用复制模式验证结果。\n\n确定继续吗？",
      confirmText: "确定继续",
      cancelText: "取消",
    });
    if (!confirmed) {
      return;
    }
  }
  if (options.conflictMode === "overwrite") {
    const confirmed = await confirmDanger({
      title: "确认覆盖同名文件",
      message: "覆盖模式可能永久替换输出目录中的同名文件。\n\n确定继续吗？",
      confirmText: "确定继续",
      cancelText: "取消",
    });
    if (!confirmed) {
      return;
    }
  }

  const reusable =
    Boolean(controller.state.sessionId) &&
    controller.state.sessionState === "analysed" &&
    page.scanOptions !== null &&
    JSON.stringify(options) === JSON.stringify(page.scanOptions);
  if (!reusable) {
    await alertDialog({
      title: "需要最新预览",
      message:
        "尚未生成预览，或预览后修改了选项。\n现在将先扫描并生成新的执行计划；检查无误后请再次点击“开始整理”。",
      tone: "info",
      confirmText: "开始扫描",
      cancelText: null,
    });
    startAnalysis();
    return;
  }
  if (!(controller.state.previewTotal > 0)) {
    await alertDialog({
      title: "没有可执行动作",
      message: "当前计划为空，请调整选项或输入目录后重新扫描。",
      tone: "info",
      confirmText: "知道了",
      cancelText: null,
    });
    return;
  }
  try {
    await controller.startExecution(options);
  } catch (error) {
    handleApiError(error, "任务失败");
  }
}

function cancelTask() {
  controller.cancelCurrent();
  setStatus("正在安全取消，等待当前文件处理结束…", "warning");
  byId("btn-cancel").disabled = true;
}

/* ------------------------------- 预览渲染 -------------------------------- */

function clearPreview(hint = "尚未扫描") {
  page.previewGeneration += 1;
  page.previewRows = [];
  page.previewTotal = 0;
  page.previewLoaded = 0;
  page.visibleStart = -1;
  page.visibleEnd = -1;
  for (const node of document.querySelectorAll("[data-stat]")) {
    node.textContent = "—";
  }
  const duplicateButton = byId("btn-duplicates");
  duplicateButton.disabled = true;
  duplicateButton.textContent = "重复项对比";
  byId("preview-hint").textContent = hint;
  byId("preview-scroll").scrollTop = 0;
  renderEmptyTable(hint === "正在生成预览…" ? "正在生成预览…" : hint);
  setProgress(0);
  updateButtons();
}

function renderEmptyTable(text) {
  const tbody = byId("preview-tbody");
  tbody.innerHTML = `<tr><td colspan="5" class="preview-table__empty">${escapeHtml(text)}</td></tr>`;
}

function onProgress(update) {
  if (controller.state.activeTask === "fix") {
    return;
  }
  setStatus(controller.progressText(update));
  setProgress(controller.progressRatio(update));
  byId("btn-cancel").disabled = false;
}

function onAnalysis(payload) {
  if (controller.state.sessionType && controller.state.sessionType !== "organize") {
    return;
  }
  page.starting = false;
  page.previewTotal = payload.previewTotal ?? payload.summary?.plannedActions ?? 0;
  const summary = payload.summary ?? {};
  const statistics = summary.statistics ?? {};
  const unique = summary.unique ?? statistics.after_deduplication ?? 0;
  const duplicateGroups = summary.duplicateGroups ?? summary.duplicate_groups ?? 0;
  const unknown = summary.unknownDates ?? summary.unknown_dates ?? 0;
  const discovered = summary.discovered ?? statistics.discovered ?? 0;
  const planned = summary.plannedActions ?? summary.planned_actions ?? page.previewTotal;
  setStat("discovered", formatCount(discovered));
  setStat("unique", formatCount(unique));
  setStat("duplicates", `${formatCount(duplicateGroups)} 组`);
  setStat("unknown", formatCount(unknown));
  setStat("actions", formatCount(planned));

  const duplicateButton = byId("btn-duplicates");
  duplicateButton.disabled = (controller.state.duplicateTotal ?? 0) <= 0;
  duplicateButton.textContent =
    (controller.state.duplicateTotal ?? 0) > 0
      ? `重复项对比 · ${formatCount(controller.state.duplicateTotal)} 组`
      : "重复项对比";
  duplicateButton.hidden = false;

  const cacheHits = summary.hashCacheHits ?? statistics.hash_cache_hits ?? 0;
  let cacheSuffix = cacheHits ? ` · 缓存复用 ${formatCount(cacheHits)}` : "";
  let liveSuffix = "";
  let tone = "success";
  if (summary.recognizeLivePhotos || controller.state.settings?.recognize_live_photos) {
    const live = summary.livePhoto ?? {};
    const pairs = Math.max(Number(live.pairs) || 0, 0);
    const verified = Math.min(Math.max(Number(live.verified) || 0, 0), pairs);
    const incomplete = Math.max(pairs - verified, 0);
    const repaired = Math.max(Number(live.repaired) || 0, 0);
    const ambiguous = Math.max(Number(live.ambiguous) || 0, 0);
    const rejected = Math.max(Number(live.rejected) || 0, 0);
    const headline = pairs ? `实况 ${formatCount(pairs)} 组` : "未发现可可靠配对的实况照片";
    liveSuffix =
      ` · ${headline} · 完整 ${formatCount(verified)}/${formatCount(pairs)} · 不完整 ${formatCount(incomplete)}` +
      ` · 后缀恢复 ${formatCount(repaired)} · 歧义 ${formatCount(ambiguous)} · 标识冲突拒绝 ${formatCount(rejected)}`;
    if (incomplete || ambiguous || rejected) {
      tone = "warning";
    }
  }
  setStatus(`预览完成${cacheSuffix}${liveSuffix}`, tone);
  setProgress(1);
  collapseOptions(true);
  page.previewGeneration += 1;
  page.previewRows = [];
  page.previewLoaded = 0;
  loadPreviewRows(controller.state.sessionId, page.previewGeneration);
}

function setStat(key, text) {
  const node = document.querySelector(`[data-stat="${key}"]`);
  if (node) {
    node.textContent = text;
  }
}

function collapseOptions(collapsed) {
  page.optionsCollapsed = collapsed;
  const card = byId("options-card");
  card.style.display = collapsed ? "none" : "";
  byId("btn-toggle-options").textContent = collapsed ? "展开选项" : "收起选项";
}

async function loadPreviewRows(sessionId, generation) {
  const settings = controller.state.settings ?? {};
  const batch = clamp(
    Number.parseInt(settings.preview_limit, 10) || PREVIEW_BATCH_DEFAULT,
    PREVIEW_BATCH_MIN,
    PREVIEW_BATCH_MAX,
  );
  const total = page.previewTotal;
  page.previewRows = [];
  page.previewLoaded = 0;
  if (total <= 0) {
    byId("preview-hint").textContent = "共 0 项";
    renderEmptyTable("当前计划中没有文件操作。");
    return;
  }
  renderEmptyTable("正在载入计划…");
  byId("preview-hint").textContent = `正在载入 0 / ${formatCount(total)} 项…`;
  let offset = 0;
  while (offset < total) {
    let response;
    try {
      response = await api.preview(sessionId, offset, batch);
    } catch (error) {
      if (generation === page.previewGeneration) {
        byId("preview-hint").textContent = `预览载入失败：${error.message}`;
      }
      return;
    }
    if (generation !== page.previewGeneration) {
      return;
    }
    const rows = response.rows ?? [];
    page.previewRows.push(...rows);
    page.previewLoaded = page.previewRows.length;
    offset = (response.offset ?? offset) + rows.length;
    byId("preview-hint").textContent = `正在载入 ${formatCount(page.previewLoaded)} / ${formatCount(total)} 项…`;
    page.visibleStart = -1;
    renderPreviewWindow(true);
    if (rows.length === 0) {
      break;
    }
    await nextFrame();
  }
  if (generation !== page.previewGeneration) {
    return;
  }
  page.previewTotal = page.previewRows.length;
  byId("preview-hint").textContent = `共 ${formatCount(page.previewRows.length)} 项，已全部载入`;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function previewRowHtml(row) {
  const kind = String(row.kind ?? "");
  const actionText = escapeHtml(actionLabel(row));
  const fullSource = row.source ?? "—";
  const fullTarget = row.target ?? "—";
  const source = escapeHtml(truncateMiddle(fullSource, 56));
  const target = escapeHtml(truncateMiddle(fullTarget, 56));
  const dateText = row.date ? escapeHtml(row.date) : "未知";
  const album = row.album === null || row.album === undefined ? "时间线" : escapeHtml(row.album);
  return `<tr>
    <td><span class="kind-pill is-${escapeHtml(kind)}">${actionText}</span></td>
    <td class="cell-path" title="${escapeHtml(fullSource)}">${source}</td>
    <td class="cell-path" title="${escapeHtml(fullTarget)}">${target}</td>
    <td class="cell-date">${dateText}</td>
    <td>${album}</td>
  </tr>`;
}

function renderPreviewWindow(force = false) {
  const scroller = byId("preview-scroll");
  const tbody = byId("preview-tbody");
  if (!scroller || !tbody) {
    return;
  }
  const rows = page.previewRows;
  if (!rows.length) {
    return;
  }
  const viewport = scroller.clientHeight || 420;
  const start = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - 6);
  const end = Math.min(rows.length, Math.ceil((scroller.scrollTop + viewport) / ROW_HEIGHT) + 6);
  if (!force && start === page.visibleStart && end === page.visibleEnd) {
    return;
  }
  page.visibleStart = start;
  page.visibleEnd = end;
  const topSpacer = start > 0 ? `<tr class="row-spacer"><td colspan="5" style="height:${start * ROW_HEIGHT}px"></td></tr>` : "";
  const bottomCount = Math.max(rows.length - end, 0);
  const bottomSpacer =
    bottomCount > 0
      ? `<tr class="row-spacer"><td colspan="5" style="height:${bottomCount * ROW_HEIGHT}px"></td></tr>`
      : "";
  let body = "";
  for (let index = start; index < end; index += 1) {
    body += previewRowHtml(rows[index]);
  }
  tbody.innerHTML = topSpacer + body + bottomSpacer;
}

/* ------------------------------- 结果反馈 -------------------------------- */

function onExecution(payload) {
  if (controller.state.sessionType && controller.state.sessionType !== "organize") {
    return;
  }
  const summary = payload?.summary ?? {};
  const copied = Number(summary.copied) || 0;
  const moved = Number(summary.moved) || 0;
  const shortcuts = Number(summary.shortcuts) || 0;
  const skipped = Number(summary.skipped) || 0;
  const failed = Number(summary.failed) || 0;
  const errors = summary.errors ?? [];
  const success = copied + moved + shortcuts;
  let text = `完成 ${formatCount(success)} 项，跳过 ${formatCount(skipped)} 项，失败 ${formatCount(failed)} 项`;
  if (errors.length) {
    text += `，另有 ${formatCount(errors.length)} 条错误`;
    controller.addLog("ERROR", errors.join("\n"));
  }
  setStatus(text, errors.length ? "warning" : "success");
  setProgress(1);
  controller.addLog("INFO", text);
  page.scanOptions = null;
  byId("btn-duplicates").disabled = true;
  byId("btn-duplicates").textContent = "重复项对比";
  updateButtons();
  const outputDir = summary.outputDirectory ?? controller.state.settings?.output_dir ?? "";
  alertDialog({
    title: "整理完成",
    message: `${text}\n\n输出目录：\n${outputDir}`,
    tone: errors.length ? "warning" : "success",
    confirmText: "知道了",
    cancelText: null,
  });
}

function onCancelled(payload) {
  if (controller.state.sessionType && controller.state.sessionType !== "organize") {
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
}

function onError(payload) {
  if (controller.state.sessionType && controller.state.sessionType !== "organize") {
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
}

export { page as organizeState };
