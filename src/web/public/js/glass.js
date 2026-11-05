/* ============================================================================
 * PhotoTakeout Studio · Liquid Glass 交互层（零依赖 vanilla ES module）
 * ----------------------------------------------------------------------------
 * 功能：
 *   · 指针镜面高光跟踪（单个 pointermove 监听 + rAF 节流，写入
 *     --mx / --my / --mxp / --myp 四个 CSS 变量）
 *   · 分段控件滑块（自动测量宽度与位移，派发 change CustomEvent）
 *   · 模态框（焦点陷阱、Esc、点击遮罩关闭、背景 inert、焦点恢复、滚动锁定）
 *   · Toast / Tooltip / Tabs / 折叠面板 / 进度 / 滑块 / 日志过滤
 *   · 主题切换（light / dark / system，localStorage 持久化）
 *   · 内联 SVG sprite 自动注入（无需外部文件，file:// 可用）
 *
 * 用法：
 *   <script type="module" src="/js/glass.js"></script>
 *   <script type="module">
 *     import { init, toast } from '/js/glass.js';
 *     init(); // 自动执行；也可在局部刷新后手动调用
 *     toast('任务已完成', { type: 'success' });
 *   </script>
 *   兼容全局：window.Glass.toast(...) / window.Glass.openModal(...)
 * ========================================================================= */

/* --------------------------------------------------------------------------
 * 1. 图标库（与 assets/icons.svg 保持同源）
 * ------------------------------------------------------------------------ */

const ICONS = {
  folder:
    '<path d="M3.25 7.7c0-1.08.87-1.95 1.95-1.95h3.3c.58 0 1.13.26 1.5.71l1.05 1.29h7.75c1.08 0 1.95.87 1.95 1.95v7.6c0 1.08-.87 1.95-1.95 1.95H5.2c-1.08 0-1.95-.87-1.95-1.95z"/>',
  file: '<path d="M13.6 3.5H7.1c-.94 0-1.7.76-1.7 1.7v13.6c0 .94.76 1.7 1.7 1.7h9.8c.94 0 1.7-.76 1.7-1.7V8.4z"/><path d="M13.6 3.5v4.9h5"/>',
  photo:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="3.2"/><circle cx="15.6" cy="8.9" r="1.35"/><path d="M5 16.4l3.9-3.5c.6-.54 1.52-.5 2.06.1l3.02 3.32 1.42-1.3c.56-.51 1.42-.48 1.95.06l1.65 1.72"/>',
  video:
    '<rect x="3.2" y="5.4" width="17.6" height="13.2" rx="3.4"/><path d="M10.4 9.4v5.2l4.4-2.6z"/>',
  sparkles:
    '<path d="M12 3.2l1.72 4.6 4.6 1.72-4.6 1.72L12 15.84l-1.72-4.6-4.6-1.72 4.6-1.72z"/><path d="M18.7 14.9l.68 1.82 1.82.68-1.82.68-.68 1.82-.68-1.82-1.82-.68 1.82-.68z"/><path d="M5.4 15.6l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>',
  repeat:
    '<path d="M16.3 3.9l3.3 3.3-3.3 3.3"/><path d="M19.6 7.2H7.6a3 3 0 0 0-3 3v1.4"/><path d="M7.7 20.1l-3.3-3.3 3.3-3.3"/><path d="M4.4 16.8h12a3 3 0 0 0 3-3v-1.4"/>',
  copy: '<rect x="8.6" y="8.6" width="11" height="11" rx="2.8"/><path d="M15.4 8.6V6.2c0-1.5-1.2-2.7-2.7-2.7H6.2c-1.5 0-2.7 1.2-2.7 2.7v6.5c0 1.5 1.2 2.7 2.7 2.7h2.4"/>',
  move: '<path d="M12 3.6v16.8M3.6 12h16.8"/><path d="M9.4 6.2L12 3.6l2.6 2.6M9.4 17.8L12 20.4l2.6-2.6M6.2 9.4L3.6 12l2.6 2.6M17.8 9.4L20.4 12l-2.6 2.6"/>',
  play: '<path d="M8.3 5.7v12.6c0 .92 1.01 1.47 1.78.96l9.2-6.3c.7-.48.7-1.49 0-1.97l-9.2-6.3c-.77-.52-1.78.04-1.78.96z"/>',
  pause:
    '<rect x="7.4" y="5" width="3.2" height="14" rx="1.3"/><rect x="13.4" y="5" width="3.2" height="14" rx="1.3"/>',
  x: '<path d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8"/>',
  "chevron-left": '<path d="M14.6 5.4L8 12l6.6 6.6"/>',
  "chevron-right": '<path d="M9.4 5.4L16 12l-6.6 6.6"/>',
  "chevron-down": '<path d="M6 9.4L12 15.4l6-6"/>',
  "arrow-right": '<path d="M4.6 12h14.8M13.5 6.1L19.4 12l-5.9 5.9"/>',
  "arrow-up": '<path d="M12 19V5M6.2 10.8L12 5l5.8 5.8"/>',
  "arrow-down": '<path d="M12 5v14M6.2 13.2L12 19l5.8-5.8"/>',
  check: '<path d="M4.6 12.7l4.7 4.7L19.6 7"/>',
  "check-circle": '<circle cx="12" cy="12" r="8.6"/><path d="M8.3 12.3l2.5 2.5 5.1-5.3"/>',
  warning:
    '<path d="M10.35 4.3L2.9 17.1c-.6 1.04.15 2.34 1.35 2.34h15.5c1.2 0 1.95-1.3 1.35-2.34L13.65 4.3c-.6-1.04-2.7-1.04-3.3 0z"/><path d="M12 9v4.6"/><path d="M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="8.6"/><path d="M9.1 9.1l5.8 5.8M14.9 9.1l-5.8 5.8"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5"/><path d="M12 8h.01"/>',
  gear: '<path d="M19.1 12c0-.42-.05-.83-.13-1.22l2-1.55-2-3.46-2.36.95c-.6-.5-1.3-.9-2.06-1.15L14.2 3h-4.4l-.35 2.57c-.76.25-1.46.65-2.06 1.15l-2.36-.95-2 3.46 2 1.55c-.08.39-.13.8-.13 1.22s.05.83.13 1.22l-2 1.55 2 3.46 2.36-.95c.6.5 1.3.9 2.06 1.15L9.8 21h4.4l.35-2.57c.76-.25 1.46-.65 2.06-1.15l2.36.95 2-3.46-2-1.55c.08-.39.13-.8.13-1.22z"/><circle cx="12" cy="12" r="3.1"/>',
  list: '<path d="M8.6 6.6h11M8.6 12h11M8.6 17.4h11"/><path d="M4.7 6.6h.01M4.7 12h.01M4.7 17.4h.01"/>',
  wand: '<path d="M4.4 19.6l9-9"/><path d="M15.2 3.5l.85 2.25L18.3 6.6l-2.25.85-.85 2.25-.85-2.25-2.25-.85 2.25-.85z"/><path d="M18.5 13.6l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z"/>',
  "external-link":
    '<path d="M14.2 4.5h5.3v5.3"/><path d="M19.5 4.5L11 13"/><path d="M18.4 14v3.6c0 1.05-.85 1.9-1.9 1.9H5.9c-1.05 0-1.9-.85-1.9-1.9V7.1c0-1.05.85-1.9 1.9-1.9h3.9"/>',
  refresh:
    '<path d="M4.8 12a7.2 7.2 0 0 1 12.3-5.1l2.5 2.5"/><path d="M19.6 4.6v4.8h-4.8"/><path d="M19.2 12a7.2 7.2 0 0 1-12.3 5.1l-2.5-2.5"/><path d="M4.4 19.4v-4.8h4.8"/>',
  trash:
    '<path d="M4.6 7h14.8M9.6 7V5.5c0-.8.65-1.45 1.45-1.45h1.9c.8 0 1.45.65 1.45 1.45V7"/><path d="M6.5 7l.85 11.5c.06.8.72 1.4 1.52 1.4h6.26c.8 0 1.46-.6 1.52-1.4L17.5 7"/><path d="M10.2 11v4.6M13.8 11v4.6"/>',
  search: '<circle cx="11" cy="11" r="6.3"/><path d="M15.6 15.6L20 20"/>',
  link: '<path d="M10.3 13.7a3.9 3.9 0 0 0 5.52 0l2.6-2.6a3.9 3.9 0 1 0-5.52-5.52l-1.3 1.3"/><path d="M13.7 10.3a3.9 3.9 0 0 0-5.52 0l-2.6 2.6a3.9 3.9 0 1 0 5.52 5.52l1.3-1.3"/>',
  eye: '<path d="M2.9 12S6.5 5.9 12 5.9 21.1 12 21.1 12 17.5 18.1 12 18.1 2.9 12 2.9 12z"/><circle cx="12" cy="12" r="3"/>',
  bookmark:
    '<path d="M6.6 4.6h10.8c.5 0 .9.4.9.9v14.9L12 16.2l-6.3 4.2V5.5c0-.5.4-.9.9-.9z"/>',
  timeline:
    '<path d="M3.8 12h16.4"/><circle cx="7.6" cy="12" r="2.2"/><circle cx="16.4" cy="12" r="2.2"/><path d="M7.6 9.8V5.5M16.4 18.5v-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.35 5.35l1.55 1.55M17.1 17.1l1.55 1.55M18.65 5.35L17.1 6.9M6.9 17.1l-1.55 1.55"/>',
  moon: '<path d="M20 14.4A8.5 8.5 0 0 1 9.6 4a8.5 8.5 0 1 0 10.4 10.4z"/>',
  monitor:
    '<rect x="3" y="4.4" width="18" height="12.6" rx="2.6"/><path d="M9.5 20.5h5M12 17v3.5"/>',
  shield:
    '<path d="M12 3.2l7.2 2.8v5.6c0 4.3-3 7.5-7.2 9.3-4.2-1.8-7.2-5-7.2-9.3V6z"/><path d="M9 12l2.2 2.2 4.2-4.4"/>',
  "hard-drive":
    '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.8 13.6h16.4"/><path d="M7 17h.01M10 17h.01"/>',
  sliders:
    '<path d="M4.5 8h7.5M17 8h2.5M4.5 16h2.5M12 16h7.5"/><circle cx="14.5" cy="8" r="2.2"/><circle cx="9.5" cy="16" r="2.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  more: '<path d="M5.6 12h.01M12 12h.01M18.4 12h.01" stroke-width="2.6"/>',
  scan: '<path d="M3.8 9V6.4c0-1.43 1.17-2.6 2.6-2.6H9M15 3.8h2.6c1.43 0 2.6 1.17 2.6 2.6V9M20.2 15v2.6c0 1.43-1.17 2.6-2.6 2.6H15M9 20.2H6.4c-1.43 0-2.6-1.17-2.6-2.6V15"/><path d="M3.8 12h16.4"/>',
  layers:
    '<path d="M12 3.5l8.4 4.6L12 12.7 3.6 8.1z"/><path d="M3.6 12.2l8.4 4.6 8.4-4.6"/><path d="M3.6 16.3l8.4 4.6 8.4-4.6"/>',
  calendar:
    '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.8 9.6h16.4M8 3.2v3.6M16 3.2v3.6"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3 1.9"/>',
  upload:
    '<path d="M12 15.5V4.6M7.5 9.1L12 4.6l4.5 4.5"/><path d="M4.5 14.6v2.9c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2v-2.9"/>',
  download:
    '<path d="M12 4.6v10.9M7.5 11L12 15.5l4.5-4.5"/><path d="M4.5 14.6v2.9c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2v-2.9"/>',
  filter: '<path d="M4 6.2h16l-6.2 7.3v5.2l-3.6 1.9v-7.1z"/>',
  grid: '<rect x="3.8" y="3.8" width="7" height="7" rx="2"/><rect x="13.2" y="3.8" width="7" height="7" rx="2"/><rect x="3.8" y="13.2" width="7" height="7" rx="2"/><rect x="13.2" y="13.2" width="7" height="7" rx="2"/>',
  home:
    '<path d="M4 10.6l8-6.4 8 6.4v8.3c0 .9-.73 1.6-1.6 1.6H5.6c-.87 0-1.6-.7-1.6-1.6z"/><path d="M9.6 20.5v-6.2h4.8v6.2"/>',
  archive:
    '<rect x="3.5" y="4.2" width="17" height="4.6" rx="1.8"/><path d="M5.2 8.8v9.4c0 1.1.9 2 2 2h9.6c1.1 0 2-.9 2-2V8.8"/><path d="M10 12.6h4"/>',
  lock: '<rect x="4.8" y="10.2" width="14.4" height="10.2" rx="3"/><path d="M8.2 10.2V7.6a3.8 3.8 0 0 1 7.6 0v2.6"/><path d="M12 14.4v2.2"/>',
  zap: '<path d="M13.2 2.8L5.2 13.4h5.4l-.8 7.8 8-10.6h-5.4z"/>',
};

function spriteMarkup() {
  const symbols = Object.entries(ICONS)
    .map(
      ([name, body]) =>
        `<symbol id="gi-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`
    )
    .join("");
  return `<svg id="glass-sprite" class="g-sprite" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><defs>${symbols}</defs></svg>`;
}

/** 返回内联 SVG 图标字符串，可直接 innerHTML 使用。 */
function icon(name, extraClass = "") {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg class="g-icon${extraClass ? " " + extraClass : ""}" aria-hidden="true" focusable="false"><use href="#gi-${name}"></use></svg>`;
}

function mountSprite(root = document) {
  if (document.getElementById("glass-sprite")) return;
  const host = root.body || document.body;
  if (!host) return;
  host.insertAdjacentHTML("afterbegin", spriteMarkup());
}

/* --------------------------------------------------------------------------
 * 2. 小工具
 * ------------------------------------------------------------------------ */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const THEME_KEY = "glass-theme";
const state = {
  theme: "system",
  hoveredGlass: null,
  modalStack: [],
  toastRegion: null,
  tooltip: null,
  tooltipTarget: null,
  tooltipTimer: 0,
  lastFocus: null,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function emit(target, name, detail) {
  target.dispatchEvent(new CustomEvent(name, { bubbles: true, cancelable: false, detail }));
}

/* --------------------------------------------------------------------------
 * 3. 镜面高光跟踪（单个 pointermove + rAF 节流）
 * ------------------------------------------------------------------------ */

function updateSpecularVars(glass, clientX, clientY) {
  const rect = glass.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = clamp(clientX - rect.left, 0, rect.width);
  const y = clamp(clientY - rect.top, 0, rect.height);
  glass.style.setProperty("--mx", `${x.toFixed(1)}px`);
  glass.style.setProperty("--my", `${y.toFixed(1)}px`);
  glass.style.setProperty("--mxp", `${((x / rect.width) * 100).toFixed(2)}%`);
  glass.style.setProperty("--myp", `${((y / rect.height) * 100).toFixed(2)}%`);
}

let specularRaf = 0;
let specularPending = null;

function onPointerMove(event) {
  const target = event.target instanceof Element ? event.target : null;
  const glass = target ? target.closest(".g-glass") : null;
  if (!glass) return;
  specularPending = { glass, x: event.clientX, y: event.clientY };
  if (specularRaf) return;
  specularRaf = window.requestAnimationFrame(() => {
    specularRaf = 0;
    if (!specularPending) return;
    updateSpecularVars(specularPending.glass, specularPending.x, specularPending.y);
    specularPending = null;
  });
}

function onPointerOver(event) {
  const target = event.target instanceof Element ? event.target : null;
  const glass = target ? target.closest(".g-glass") : null;
  if (!glass || glass === state.hoveredGlass) return;
  if (state.hoveredGlass) state.hoveredGlass.classList.remove("is-hover");
  state.hoveredGlass = glass;
  glass.classList.add("is-hover");
}

function onPointerOut(event) {
  const target = event.target instanceof Element ? event.target : null;
  const glass = target ? target.closest(".g-glass") : null;
  if (!glass) return;
  const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
  if (related && glass.contains(related)) return;
  glass.classList.remove("is-hover");
  if (state.hoveredGlass === glass) state.hoveredGlass = null;
}

function onPointerDown(event) {
  const target = event.target instanceof Element ? event.target : null;
  const glass = target ? target.closest(".g-glass") : null;
  if (glass) glass.classList.add("is-pressed");
  const surface = target ? target.closest(".g-btn, .glass-nav-item, .g-chip, .g-segment") : null;
  if (surface) surface.classList.add("is-pressed");
}

function onPointerUp() {
  document.querySelectorAll(".g-glass.is-pressed, .is-pressed").forEach((el) => {
    el.classList.remove("is-pressed");
  });
}

/* --------------------------------------------------------------------------
 * 4. 玻璃表面自动标记
 * ------------------------------------------------------------------------ */

const GLASS_SURFACE_SELECTOR = [
  ".glass-panel",
  ".glass-card",
  ".glass-sidebar",
  ".glass-main",
  ".glass-toolbar",
  ".g-modal__sheet",
  ".g-sheet",
  ".g-list",
  ".g-compare__side",
  ".g-empty",
  ".g-stat",
  ".g-btn--secondary",
  ".g-btn--icon",
  ".g-toast",
].join(",");

function ensureGlass(root = document) {
  root.querySelectorAll(GLASS_SURFACE_SELECTOR).forEach((el) => {
    if (!el.classList.contains("g-glass")) el.classList.add("g-glass");
  });
  root.querySelectorAll(".g-glass").forEach((el) => {
    if (!el.dataset.glassBound) {
      el.dataset.glassBound = "1";
    }
  });
}

/* --------------------------------------------------------------------------
 * 5. 分段控件
 * ------------------------------------------------------------------------ */

function moveSegmentedThumb(seg) {
  const thumb = seg.querySelector(".g-segmented__thumb");
  if (!thumb) return;
  const selected = seg.querySelector(".g-segment.is-selected") || seg.querySelector(".g-segment");
  if (!selected) {
    thumb.style.opacity = "0";
    return;
  }
  const segRect = seg.getBoundingClientRect();
  const rect = selected.getBoundingClientRect();
  if (!rect.width) {
    // 元素被隐藏或尚未布局，下一帧再试
    window.requestAnimationFrame(() => moveSegmentedThumb(seg));
    return;
  }
  thumb.style.opacity = "1";
  thumb.style.width = `${rect.width}px`;
  thumb.style.transform = `translate3d(${(rect.left - segRect.left).toFixed(1)}px, 0, 0)`;
}

function enhanceSegmented(seg) {
  if (!seg.querySelector(".g-segmented__thumb")) {
    const thumb = document.createElement("span");
    thumb.className = "g-segmented__thumb";
    thumb.setAttribute("aria-hidden", "true");
    seg.insertBefore(thumb, seg.firstChild);
  }
  seg.classList.add("is-enhanced");
  seg.setAttribute("role", "tablist");
  seg.querySelectorAll(".g-segment").forEach((segment) => {
    segment.setAttribute("role", "tab");
    segment.setAttribute("aria-selected", segment.classList.contains("is-selected") ? "true" : "false");
    segment.tabIndex = segment.classList.contains("is-selected") ? 0 : -1;
  });
  const selected = seg.querySelector(".g-segment.is-selected");
  if (selected) seg.dataset.value = selected.dataset.value ?? selected.textContent.trim();
  moveSegmentedThumb(seg);
  if (!seg.dataset.enhanced) {
    seg.dataset.enhanced = "1";
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => moveSegmentedThumb(seg));
      ro.observe(seg);
      seg.querySelectorAll(".g-segment").forEach((segment) => ro.observe(segment));
    }
  }
}

function selectSegment(seg, segment, options = {}) {
  if (!seg || !segment || !seg.contains(segment)) return;
  const segments = [...seg.querySelectorAll(".g-segment")];
  segments.forEach((item) => {
    const active = item === segment;
    item.classList.toggle("is-selected", active);
    item.setAttribute("aria-selected", active ? "true" : "false");
    item.tabIndex = active ? 0 : -1;
  });
  const value = segment.dataset.value ?? segment.dataset.segValue ?? segment.textContent.trim();
  seg.dataset.value = value;
  moveSegmentedThumb(seg);
  if (options.emit !== false) {
    emit(seg, "change", { value, segment, label: segment.textContent.trim() });
    emit(seg, "glass:segment-change", { value, segment });
  }
  if (options.focus) segment.focus({ preventScroll: true });
}

function initSegmented(root = document) {
  root.querySelectorAll(".g-segmented").forEach(enhanceSegmented);
}

/* --------------------------------------------------------------------------
 * 6. Tabs
 * ------------------------------------------------------------------------ */

function selectTab(tab, options = {}) {
  if (!tab) return;
  const tabs = tab.closest(".g-tabs");
  if (!tabs) return;
  const all = [...tabs.querySelectorAll(".g-tab")];
  const value = tab.dataset.tab ?? tab.dataset.value ?? tab.textContent.trim();
  all.forEach((item) => {
    const active = item === tab;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", active ? "true" : "false");
    item.tabIndex = active ? 0 : -1;
  });
  tabs.dataset.value = value;
  const anchor = tabs.dataset.tabScope;
  const scope = anchor ? document.querySelector(anchor) || document : tabs.parentElement || document;
  scope.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    const active = panel.dataset.tabPanel === value;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  if (options.emit !== false) {
    emit(tabs, "change", { value, tab });
    emit(tabs, "glass:tab-change", { value, tab });
  }
  if (options.focus) tab.focus({ preventScroll: true });
}

function initTabs(root = document) {
  root.querySelectorAll(".g-tabs").forEach((tabs) => {
    tabs.setAttribute("role", "tablist");
    const all = [...tabs.querySelectorAll(".g-tab")];
    all.forEach((tab) => {
      tab.setAttribute("role", "tab");
      const active = tab.classList.contains("is-active") || (all.length && tab === all[0] && !tabs.querySelector(".g-tab.is-active"));
      if (active) tab.classList.add("is-active");
      tab.setAttribute("aria-selected", tab.classList.contains("is-active") ? "true" : "false");
      tab.tabIndex = tab.classList.contains("is-active") ? 0 : -1;
    });
    const active = tabs.querySelector(".g-tab.is-active");
    if (active && tabs.dataset.value === undefined) {
      selectTab(active, { emit: false });
    }
  });
}

/* --------------------------------------------------------------------------
 * 7. 模态框
 * ------------------------------------------------------------------------ */

function resolveElement(ref, fallbackStack = false) {
  if (ref instanceof Element) return ref;
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    try {
      return document.querySelector(trimmed) || document.getElementById(trimmed.replace(/^#/, ""));
    } catch {
      return document.getElementById(trimmed.replace(/^#/, ""));
    }
  }
  if (fallbackStack) return state.modalStack[state.modalStack.length - 1] || null;
  return null;
}

function focusFirst(modal) {
  const preferred = modal.querySelector("[data-autofocus]");
  const sheet = modal.querySelector(".g-modal__sheet");
  const target =
    preferred ||
    (modal.dataset.focus === "sheet" && sheet) ||
    (sheet && sheet.querySelector(FOCUSABLE)) ||
    sheet ||
    modal.querySelector(FOCUSABLE);
  if (target) {
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* noop */
    }
  }
}

function inertBackground(modal) {
  const inerted = [];
  [...document.body.children].forEach((el) => {
    if (el === modal || el.classList.contains("g-modal")) return;
    if (el.classList.contains("g-toast-region") || el.classList.contains("g-tooltip") || el.id === "glass-sprite") return;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "LINK") return;
    inerted.push({
      el,
      inert: el.hasAttribute("inert"),
      ariaHidden: el.getAttribute("aria-hidden"),
    });
    el.setAttribute("inert", "");
    el.setAttribute("aria-hidden", "true");
  });
  modal._glassInerted = inerted;
}

function restoreBackground(modal) {
  (modal._glassInerted || []).forEach(({ el, inert, ariaHidden }) => {
    if (!inert) el.removeAttribute("inert");
    if (ariaHidden === null) el.removeAttribute("aria-hidden");
    else el.setAttribute("aria-hidden", ariaHidden);
  });
  modal._glassInerted = null;
}

function lockScroll() {
  if (state.modalStack.length !== 1) return;
  const gap = window.innerWidth - document.documentElement.clientWidth;
  document.body.classList.add("g-scroll-lock");
  if (gap > 0) document.body.style.paddingRight = `${gap}px`;
}

function unlockScroll() {
  if (state.modalStack.length > 0) return;
  document.body.classList.remove("g-scroll-lock");
  document.body.style.paddingRight = "";
}

function openModal(ref) {
  const modal = resolveElement(ref);
  if (!modal || !modal.classList.contains("g-modal")) return null;
  if (modal.classList.contains("is-open")) {
    focusFirst(modal);
    return modal;
  }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal._glassReturnFocus = previous;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  state.modalStack.push(modal);
  lockScroll();
  if (state.modalStack.length === 1) inertBackground(modal);
  window.requestAnimationFrame(() => focusFirst(modal));
  emit(modal, "glass:modal-open", { modal });
  return modal;
}

function closeModal(ref) {
  const modal = resolveElement(ref, true);
  if (!modal) return;
  const index = state.modalStack.indexOf(modal);
  if (index === -1) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  state.modalStack.splice(index, 1);
  restoreBackground(modal);
  unlockScroll();
  const previous = modal._glassReturnFocus;
  modal._glassReturnFocus = null;
  if (previous && document.contains(previous) && typeof previous.focus === "function") {
    window.setTimeout(() => previous.focus({ preventScroll: true }), 30);
  }
  emit(modal, "glass:modal-close", { modal });
}

function initModals(root = document) {
  root.querySelectorAll(".g-modal").forEach((modal) => {
    if (modal.dataset.glassInit === "1") return;
    modal.dataset.glassInit = "1";
    /* 若页面已在 sheet 上声明 role="dialog"，则不重复给根节点加 dialog 语义 */
    const sheet = modal.querySelector(".g-modal__sheet");
    const hasSheetDialog = Boolean(sheet && sheet.getAttribute("role") === "dialog");
    if (!hasSheetDialog) {
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
    }
    if (!modal.hasAttribute("aria-hidden")) modal.setAttribute("aria-hidden", "true");
    if (!modal.querySelector(".g-modal__backdrop")) {
      const backdrop = document.createElement("div");
      backdrop.className = "g-modal__backdrop";
      modal.insertBefore(backdrop, modal.firstChild);
    }
    if (sheet && !sheet.hasAttribute("tabindex")) sheet.setAttribute("tabindex", "-1");
    modal.querySelectorAll("[data-modal-close]").forEach((btn) => {
      if (!btn.hasAttribute("type")) btn.setAttribute("type", "button");
    });
  });
}

function trapFocus(event) {
  if (event.key !== "Tab" || state.modalStack.length === 0) return;
  const modal = state.modalStack[state.modalStack.length - 1];
  const focusables = [...modal.querySelectorAll(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
  if (focusables.length === 0) {
    event.preventDefault();
    const sheet = modal.querySelector(".g-modal__sheet");
    if (sheet) sheet.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* --------------------------------------------------------------------------
 * 8. Toast
 * ------------------------------------------------------------------------ */

const TOAST_ICONS = { success: "check-circle", warning: "warning", error: "error", info: "info" };

function ensureToastRegion() {
  if (state.toastRegion && document.contains(state.toastRegion)) return state.toastRegion;
  let region = document.querySelector(".g-toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "g-toast-region";
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "false");
    document.body.append(region);
  }
  state.toastRegion = region;
  return region;
}

function toast(message, options = {}) {
  const opts = typeof options === "string" ? { type: options } : options || {};
  const type = opts.type || "info";
  const region = ensureToastRegion();
  const el = document.createElement("div");
  el.className = `g-toast is-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  const title = opts.title ? `<div class="g-toast__title">${escapeHtml(opts.title)}</div>` : "";
  el.innerHTML =
    `<span class="g-toast__icon">${icon(TOAST_ICONS[type] || "info")}</span>` +
    `<div class="g-toast__content">${title}<div class="g-toast__msg">${escapeHtml(message)}</div></div>`;
  region.append(el);
  while (region.children.length > 4) region.firstElementChild.remove();
  window.requestAnimationFrame(() => el.classList.add("is-visible"));
  const duration = typeof opts.duration === "number" ? opts.duration : 3200;
  const dismiss = () => {
    el.classList.remove("is-visible");
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), 320);
  };
  const timer = window.setTimeout(dismiss, duration);
  el.addEventListener("click", () => {
    window.clearTimeout(timer);
    dismiss();
  });
  return el;
}

/* --------------------------------------------------------------------------
 * 9. Tooltip
 * ------------------------------------------------------------------------ */

function ensureTooltip() {
  if (state.tooltip && document.contains(state.tooltip)) return state.tooltip;
  const el = document.createElement("div");
  el.className = "g-tooltip";
  el.setAttribute("role", "tooltip");
  el.setAttribute("aria-hidden", "true");
  document.body.append(el);
  state.tooltip = el;
  return el;
}

function positionTooltip(target) {
  const el = ensureTooltip();
  const rect = target.getBoundingClientRect();
  const tipRect = el.getBoundingClientRect();
  const side = target.dataset.tooltipSide || "top";
  let left = rect.left + rect.width / 2;
  let top = side === "bottom" ? rect.bottom + 9 : rect.top - tipRect.height - 9;
  if (side !== "bottom" && top < 8) {
    top = rect.bottom + 9;
    el.dataset.side = "bottom";
  } else if (side === "bottom" && top + tipRect.height > window.innerHeight - 8) {
    top = rect.top - tipRect.height - 9;
    el.dataset.side = "top";
  } else {
    el.dataset.side = side;
  }
  left = clamp(left, tipRect.width / 2 + 8, window.innerWidth - tipRect.width / 2 - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showTooltip(target) {
  if (!target.dataset.tooltip) return;
  state.tooltipTarget = target;
  const el = ensureTooltip();
  el.textContent = target.dataset.tooltip;
  el.setAttribute("aria-hidden", "false");
  window.clearTimeout(state.tooltipTimer);
  state.tooltipTimer = window.setTimeout(() => {
    if (state.tooltipTarget !== target) return;
    positionTooltip(target);
    el.classList.add("is-visible");
    target.setAttribute("aria-describedby", "glass-tooltip");
    el.id = "glass-tooltip";
  }, 120);
}

function hideTooltip(target) {
  if (target && state.tooltipTarget !== target) return;
  state.tooltipTarget = null;
  window.clearTimeout(state.tooltipTimer);
  if (state.tooltip) state.tooltip.classList.remove("is-visible");
}

/* --------------------------------------------------------------------------
 * 10. 折叠 / 进度 / 滑块 / 日志过滤
 * ------------------------------------------------------------------------ */

function toggleCollapse(button) {
  const selector = button.dataset.collapse;
  const target = selector ? resolveElement(selector) : null;
  if (!target) return;
  const open = !target.classList.contains("is-open");
  target.classList.toggle("is-open", open);
  button.setAttribute("aria-expanded", open ? "true" : "false");
  const caret = button.querySelector(".g-caret");
  if (caret) caret.classList.toggle("is-open", open);
  emit(target, "glass:collapse", { open, button });
}

function setProgress(target, value, total) {
  const el = resolveElement(target);
  if (!el) return;
  const max = Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : 100;
  const current = clamp(Number(value) || 0, 0, max);
  const percent = max === 100 ? current : (current / max) * 100;
  el.style.setProperty("--value", `${percent.toFixed(2)}%`);
  if (!el.hasAttribute("role")) el.setAttribute("role", "progressbar");
  el.setAttribute("aria-valuemin", "0");
  el.setAttribute("aria-valuemax", String(Math.round(max)));
  el.setAttribute("aria-valuenow", String(Math.round(current)));
  const bar = el.querySelector(".g-progress__bar");
  if (bar) bar.style.width = `${percent.toFixed(2)}%`;
  const valueEl = el.querySelector(".g-progress__value");
  if (valueEl) valueEl.textContent = `${Math.round(percent)}%`;
  return percent;
}

function initProgress(root = document) {
  root.querySelectorAll("[data-progress]").forEach((el) => {
    const raw = el.dataset.progress;
    const total = el.dataset.progressTotal ? Number(el.dataset.progressTotal) : 100;
    setProgress(el, Number(raw) || 0, total);
  });
  root.querySelectorAll("[data-progress-ring]").forEach((ring) => {
    const value = clamp(Number(ring.dataset.progressRing) || 0, 0, 100);
    ring.style.setProperty("--value", String(value));
    const label = ring.querySelector(".g-progress-ring__label");
    if (label) label.textContent = `${Math.round(value)}%`;
  });
}

function syncSlider(slider) {
  const min = Number(slider.min || 0);
  const max = Number(slider.max || 100);
  const value = Number(slider.value || 0);
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  slider.style.setProperty("--fill", `${percent.toFixed(2)}%`);
  const output = slider.dataset.sliderOutput
    ? document.querySelector(slider.dataset.sliderOutput)
    : null;
  if (output) output.textContent = slider.dataset.sliderSuffix ? `${value}${slider.dataset.sliderSuffix}` : String(value);
}

function initSliders(root = document) {
  root.querySelectorAll(".g-slider").forEach(syncSlider);
}

function applyLogFilter(control) {
  const level = control.dataset.logFilter;
  const group = control.closest("[data-log-filter-group]") || control.parentElement;
  if (group) {
    group.querySelectorAll("[data-log-filter]").forEach((btn) => {
      btn.classList.toggle("is-active", btn === control);
      btn.setAttribute("aria-pressed", btn === control ? "true" : "false");
    });
  }
  const scopeSelector = control.dataset.logTarget;
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
  if (!scope) return;
  scope.querySelectorAll(".g-log__line").forEach((line) => {
    const show =
      level === "all" ||
      level === "" ||
      line.classList.contains(`is-${level}`) ||
      (level === "error" && line.classList.contains("is-error"));
    line.classList.toggle("is-hidden", !show);
  });
  emit(scope, "glass:log-filter", { level });
}

/* --------------------------------------------------------------------------
 * 11. 主题
 * ------------------------------------------------------------------------ */

function systemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function effectiveTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return systemTheme();
}

function syncThemeButtons() {
  const effective = effectiveTheme();
  document.querySelectorAll("[data-theme-set]").forEach((btn) => {
    const value = btn.dataset.themeSet;
    const active = value === "system" ? state.theme === "system" : state.theme === value;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const themeName = state.theme === "system" ? "system" : state.theme;
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    const use = btn.querySelector("use");
    if (use) {
      const iconName = effective === "dark" ? "moon" : "sun";
      use.setAttribute("href", `#gi-${iconName}`);
    }
    btn.setAttribute("aria-label", `切换主题（当前：${themeName}）`);
  });
  document.querySelectorAll("[data-theme-label]").forEach((label) => {
    label.textContent = { light: "浅色", dark: "深色", system: "跟随系统" }[state.theme] || "跟随系统";
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", effective === "dark" ? "#05070f" : "#eef1f9");
  document.documentElement.dataset.effectiveTheme = effective;
}

function setTheme(mode, options = {}) {
  const next = mode === "light" || mode === "dark" ? mode : "system";
  state.theme = next;
  if (next === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", next);
  try {
    if (next === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, next);
  } catch {
    /* localStorage 可能被禁用 */
  }
  syncThemeButtons();
  if (options.emit !== false) {
    emit(document.documentElement, "glass:theme", { theme: next, effective: effectiveTheme() });
  }
  return next;
}

function getTheme() {
  return state.theme;
}

function initTheme() {
  if (state.themeBound) {
    syncThemeButtons();
    return;
  }
  state.themeBound = true;
  let mode = "system";
  const query = new URLSearchParams(window.location.search).get("theme");
  if (query === "light" || query === "dark") {
    mode = query;
  } else {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") mode = stored;
    } catch {
      /* noop */
    }
    if (mode === "system") {
      const current = document.documentElement.getAttribute("data-theme");
      if (current === "light" || current === "dark") mode = current;
    }
  }
  setTheme(mode, { emit: false });
  if (window.matchMedia) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (state.theme === "system") {
        syncThemeButtons();
        emit(document.documentElement, "glass:theme", {
          theme: "system",
          effective: systemTheme(),
        });
      }
    };
    if (media.addEventListener) media.addEventListener("change", handler);
    else if (media.addListener) media.addListener(handler);
  }
  /* 供外部脚本读取：当前实际生效的明暗与设置来源 */
  document.documentElement.dataset.glassTheme = state.theme;
}

/* --------------------------------------------------------------------------
 * 12. 复制文本
 * ------------------------------------------------------------------------ */

async function copyText(text, options = {}) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    if (options.toast !== false) toast(options.message || "已复制到剪贴板", { type: "success" });
    return true;
  } catch {
    if (options.toast !== false) toast("复制失败，请手动选择文本", { type: "error" });
    return false;
  }
}

/* --------------------------------------------------------------------------
 * 13. 全局事件绑定（只安装一次）
 * ------------------------------------------------------------------------ */

let globalBound = false;

function onDocumentClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const modalOpen = target.closest("[data-modal-open]");
  if (modalOpen) {
    event.preventDefault();
    openModal(modalOpen.dataset.modalOpen);
    return;
  }

  const modalClose = target.closest("[data-modal-close]");
  if (modalClose) {
    event.preventDefault();
    const modal = modalClose.closest(".g-modal");
    closeModal(modal || undefined);
    return;
  }

  const themeSet = target.closest("[data-theme-set]");
  if (themeSet) {
    setTheme(themeSet.dataset.themeSet);
    return;
  }

  const themeToggle = target.closest("[data-theme-toggle]");
  if (themeToggle) {
    const order = { system: "light", light: "dark", dark: "system" };
    setTheme(order[state.theme] || "light");
    return;
  }

  const collapseBtn = target.closest("[data-collapse]");
  if (collapseBtn) {
    event.preventDefault();
    toggleCollapse(collapseBtn);
    return;
  }

  const segment = target.closest(".g-segment");
  if (segment) {
    const seg = segment.closest(".g-segmented");
    if (seg) {
      selectSegment(seg, segment);
      return;
    }
  }

  const tab = target.closest(".g-tab");
  if (tab) {
    selectTab(tab);
    return;
  }

  const logFilter = target.closest("[data-log-filter]");
  if (logFilter) {
    applyLogFilter(logFilter);
    return;
  }

  const copyBtn = target.closest("[data-copy]");
  if (copyBtn) {
    event.preventDefault();
    copyText(copyBtn.dataset.copy || copyBtn.textContent.trim());
    return;
  }

  const backdrop = target.closest(".g-modal__backdrop");
  if (backdrop) {
    const modal = backdrop.closest(".g-modal");
    if (modal && modal.dataset.backdropClose !== "false") closeModal(modal);
    return;
  }

  // 点击模态外部（sheet 之外的 modal 空白区）
  if (target.classList.contains("g-modal") && target.classList.contains("is-open")) {
    if (target.dataset.backdropClose !== "false") closeModal(target);
  }
}

function onDocumentKeydown(event) {
  if (event.key === "Escape" && state.modalStack.length > 0) {
    event.preventDefault();
    closeModal();
    return;
  }

  trapFocus(event);

  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const segment = target.closest(".g-segment");
  if (segment && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    const seg = segment.closest(".g-segmented");
    if (!seg) return;
    const segments = [...seg.querySelectorAll(".g-segment")];
    const dir = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    let nextIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = segments.length - 1;
    else nextIndex = (segments.indexOf(segment) + dir + segments.length) % segments.length;
    event.preventDefault();
    selectSegment(seg, segments[nextIndex], { focus: true });
    return;
  }

  const tab = target.closest(".g-tab");
  if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    const tabs = tab.closest(".g-tabs");
    if (!tabs) return;
    const all = [...tabs.querySelectorAll(".g-tab")];
    const dir = event.key === "ArrowLeft" ? -1 : 1;
    let nextIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = all.length - 1;
    else nextIndex = (all.indexOf(tab) + dir + all.length) % all.length;
    event.preventDefault();
    selectTab(all[nextIndex], { focus: true });
  }
}

function onDocumentPointerOverTooltip(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const tip = target.closest("[data-tooltip]");
  if (tip) {
    showTooltip(tip);
    return;
  }
  if (state.tooltipTarget && !target.closest("[data-tooltip]")) hideTooltip();
}

function onDocumentPointerOutTooltip(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const tip = target.closest("[data-tooltip]");
  if (!tip) return;
  const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
  if (related && tip.contains(related)) return;
  hideTooltip(tip);
}

function onDocumentFocusIn(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const tip = target.closest("[data-tooltip]");
  if (tip) showTooltip(tip);
}

function onDocumentFocusOut(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const tip = target.closest("[data-tooltip]");
  if (tip) hideTooltip(tip);
}

function bindGlobals() {
  if (globalBound) return;
  globalBound = true;
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerover", onPointerOver, { passive: true });
  document.addEventListener("pointerout", onPointerOut, { passive: true });
  document.addEventListener("pointerdown", onPointerDown, { passive: true });
  document.addEventListener("pointerup", onPointerUp, { passive: true });
  document.addEventListener("pointercancel", onPointerUp, { passive: true });
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);
  document.addEventListener("pointerover", onDocumentPointerOverTooltip, { passive: true });
  document.addEventListener("pointerout", onDocumentPointerOutTooltip, { passive: true });
  document.addEventListener("focusin", onDocumentFocusIn);
  document.addEventListener("focusout", onDocumentFocusOut);
  document.addEventListener("input", (event) => {
    const slider = event.target instanceof Element ? event.target.closest(".g-slider") : null;
    if (slider) syncSlider(slider);
  });
  document.addEventListener(
    "scroll",
    () => hideTooltip(),
    { passive: true, capture: true }
  );
  window.addEventListener("resize", () => {
    hideTooltip();
    document.querySelectorAll(".g-segmented.is-enhanced").forEach(moveSegmentedThumb);
  });
}

/* --------------------------------------------------------------------------
 * 14. 初始化 / 公共 API
 * ------------------------------------------------------------------------ */

function init(root = document) {
  if (typeof document === "undefined") return;
  mountSprite(document);
  bindGlobals();
  ensureGlass(root);
  initSegmented(root);
  initTabs(root);
  initModals(root);
  initProgress(root);
  initSliders(root);
  initTheme();
  document.documentElement.classList.add("glass-ready");
  window.requestAnimationFrame(() => {
    root.querySelectorAll?.(".g-segmented").forEach(moveSegmentedThumb);
  });
}

const Glass = {
  init,
  toast,
  openModal,
  closeModal,
  setTheme,
  getTheme,
  effectiveTheme,
  setProgress,
  icon,
  sprite: spriteMarkup,
  copyText,
  selectSegment,
  selectSegmented: selectSegment,
  selectTab,
};

if (typeof window !== "undefined") {
  window.Glass = Glass;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => init(), { once: true });
  } else {
    init();
  }
}

export {
  init,
  toast,
  openModal,
  closeModal,
  setTheme,
  getTheme,
  effectiveTheme,
  setProgress,
  icon,
  copyText,
  selectSegment as selectSegmented,
  selectTab,
};
export default Glass;
