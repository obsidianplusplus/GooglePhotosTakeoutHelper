/**
 * 内联 SVG 图标（SF Symbols 风格的线性图标，避免外部图标字体/网络依赖）。
 * 通过 data-icon 占位符在页面初始化时注入，尺寸由 CSS 的 .g-icon 控制。
 */

const PATHS = {
  sparkles:
    '<path d="M12 3l1.6 4.2L18 9l-4.4 1.8L12 15l-1.6-4.2L6 9l4.4-1.8L12 3Z"/><path d="M18.5 14.5l.8 2.1 2.2.9-2.2.9-.8 2.1-.8-2.1-2.2-.9 2.2-.9.8-2.1Z"/><path d="M5.5 14.5l.6 1.6 1.7.7-1.7.7-.6 1.6-.6-1.6-1.7-.7 1.7-.7.6-1.6Z"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l3 1.8"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.4 6h.01M4.4 12h.01M4.4 18h.01"/>',
  gear:
    '<circle cx="12" cy="12" r="3.1"/><path d="M19.2 12a7.2 7.2 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7.3 7.3 0 0 0-2.1-1.2L14.4 3h-4l-.3 2.6a7.3 7.3 0 0 0-2.1 1.2l-2.3-.9-2 3.4 2 1.5a7.2 7.2 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7.3 7.3 0 0 0 2.1 1.2l.3 2.6h4l.3-2.6a7.3 7.3 0 0 0 2.1-1.2l2.3.9 2-3.4-2-1.5c.06-.4.1-.8.1-1.2Z"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  moon: '<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.4 8.4 0 1 0 20 14.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.2M12 19v2.2M2.8 12h2.2M19 12h2.2M5.5 5.5l1.6 1.6M16.9 16.9l1.6 1.6M18.5 5.5l-1.6 1.6M7.1 16.9l-1.6 1.6"/>',
  folder:
    '<path d="M3 6.8A1.8 1.8 0 0 1 4.8 5h4.05c.55 0 1.07.25 1.42.68L11.5 7.2h7.7A1.8 1.8 0 0 1 21 9v8.2a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 17.2V6.8Z"/>',
  "folder-open":
    '<path d="M3 7.2A1.6 1.6 0 0 1 4.6 5.6h4.2c.5 0 .98.23 1.3.62l1.1 1.38h7.2A1.6 1.6 0 0 1 20 9.2v.9"/><path d="M3.4 10.2h17.5c.83 0 1.4.8 1.16 1.58l-1.5 5.1a2.2 2.2 0 0 1-2.1 1.62H5.3a2.2 2.2 0 0 1-2.1-1.62l-1.4-4.8a1.5 1.5 0 0 1 1.45-1.88Z"/>',
  photo:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><circle cx="9" cy="10" r="1.7"/><path d="M4.5 17.5l4-4.1 3.2 3.1 2.8-2.7 4.9 4.8"/>',
  video: '<rect x="3.5" y="5.5" width="12.5" height="13" rx="2.2"/><path d="M16 10l4.5-2.8v9.6L16 14"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  move: '<path d="M12 3.5v17M3.5 12h17M12 3.5l-3 3M12 3.5l3 3M12 20.5l-3-3M12 20.5l3-3M3.5 12l3-3M3.5 12l3 3M20.5 12l-3-3M20.5 12l-3 3"/>',
  link: '<path d="M9.5 14.5l5-5"/><path d="M11 6.5l1.8-1.8a4 4 0 1 1 5.6 5.6L16.5 12"/><path d="M13 17.5l-1.8 1.8a4 4 0 1 1-5.6-5.6L7.5 12"/>',
  skip: '<circle cx="12" cy="12" r="8.2"/><path d="M9 9.5h6M9 12.5h4"/>',
  "chevron-left": '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  "chevron-right": '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
  "chevron-up": '<path d="M5.5 14.5L12 8l6.5 6.5"/>',
  "chevron-down": '<path d="M5.5 9.5L12 16l6.5-6.5"/>',
  "arrow-right": '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  "arrow-up": '<path d="M12 19.5v-15M6 10.5l6-6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.5 4.5v4.8h-4.8"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5.2a1.7 1.7 0 0 1 1.7-1.7h1.6a1.7 1.7 0 0 1 1.7 1.7V7"/><path d="M6.5 7l.8 12.1a1.9 1.9 0 0 0 1.9 1.9h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7M10.2 11v6M13.8 11v6"/>',
  download: '<path d="M12 3.5v11.5M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 18.5v.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-.5"/>',
  upload: '<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M4.5 18.5v.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-.5"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.5 15.5l5 5"/>',
  warning: '<path d="M12 4.2l9 16.3H3l9-16.3Z"/><path d="M12 10v4.3M12 17.4h.01"/>',
  error: '<circle cx="12" cy="12" r="8.4"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 10.8v5M12 7.9h.01"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5V5.5Z"/>',
  wand: '<path d="M4 20l10-10M13.5 5.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z"/><path d="M18.5 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z"/>',
  external: '<path d="M13 4.5h6.5V11M19 5l-8 8"/><path d="M18 13.5v5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V7.5A1.5 1.5 0 0 1 5.5 6h5"/>',
  eye: '<path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/>',
  home: '<path d="M4.5 11l7.5-6.5 7.5 6.5"/><path d="M6.5 9.5V19a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9.5"/><path d="M10 20v-5h4v5"/>',
  desktop: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M8.5 20h7M12 16v4"/>',
  downloads: '<path d="M12 4v10M8.5 10.5L12 14l3.5-3.5"/><path d="M5 16.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1.5"/>',
  pictures: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><path d="M4.5 16.5l4.5-4.5 3.5 3.5 2.8-2.8 4.2 4.1"/><circle cx="9" cy="9.5" r="1.4"/>',
  documents: '<path d="M6 3.5h7l5 5v12H6a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6 3.5Z"/><path d="M13 3.5V9h5"/>',
  database: '<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  shield: '<path d="M12 3.5l7 2.6v5.4c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6.1l7-2.6Z"/><path d="M9 11.8l2.2 2.2 4-4.2"/>',
  repeat: '<path d="M4 8.5h13.5A2.5 2.5 0 0 1 20 11v1"/><path d="M7 5.5L4 8.5l3 3"/><path d="M20 15.5H6.5A2.5 2.5 0 0 1 4 13v-1"/><path d="M17 12.5l3 3-3 3"/>',
  hash: '<path d="M9.5 3.5L7.8 20.5M16.2 3.5l-1.7 17M4 8.5h16M3.5 15.5h16"/>',
  calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-.9 2-1.9 0-1.2-.9-1.7-.9-2.6 0-.9.8-1.5 1.8-1.5h1.6a4 4 0 0 0 4-4c0-4-3.8-7-8.5-7Z"/><circle cx="7.6" cy="10.2" r="1"/><circle cx="10.2" cy="6.9" r="1"/><circle cx="14.6" cy="7.1" r="1"/><circle cx="17.2" cy="10.4" r="1"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 12h4M12 12h8M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  layers: '<path d="M12 3.5l8.5 4.5L12 12.5 3.5 8 12 3.5Z"/><path d="M3.5 12.2L12 16.7l8.5-4.5M3.5 16.2L12 20.7l8.5-4.5"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-9.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 3C19.5 15.4 12 20 12 20Z"/>',
  zap: '<path d="M13 2.5L4.5 13.5H11l-1 8 9-11.5h-6.5l.5-7.5Z"/>',
  "eye-off": '<path d="M4 4l16 16"/><path d="M9.9 5.6A9.6 9.6 0 0 1 12 5.3c6.1 0 9.5 6 9.5 6a17 17 0 0 1-3 3.7M6.4 7.5A16.6 16.6 0 0 0 2.5 11.3s3.4 6 9.5 6a9.4 9.4 0 0 0 4.3-1"/><path d="M10.3 10.5a2.4 2.4 0 0 0 3.3 3.3"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  "minus": '<path d="M5 12h14"/>',
  "plus": '<path d="M12 5v14M5 12h14"/>',
  "type": '<path d="M4.5 6.5V4.5h15v2M12 4.5v15M8.5 19.5h7"/>',
  monitor:
    '<rect x="2.5" y="3.5" width="19" height="13" rx="2.2"/><path d="M8 20.5h8M12 16.5v4"/><path d="M6.5 7.2h4M6.5 10h7"/>',
  "filter": '<path d="M4 5.5h16l-6 6.8V19l-4 1.5v-8.2L4 5.5Z"/>',
  "sort": '<path d="M7 4.5v15M4 16.5L7 19.5l3-3M17 19.5v-15M14 7.5l3-3 3 3"/>',
  "loader": '<path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9L18 18M18 6l-2.1 2.1M8.1 15.9L6 18"/>',
};

/** 返回一个 SVG 图标字符串。 */
export function icon(name, extraClass = "") {
  const paths = PATHS[name];
  if (!paths) {
    return "";
  }
  const cls = `g-icon${extraClass ? ` ${extraClass}` : ""}`;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/** 把 root 内所有 [data-icon] 占位符替换为内联 SVG。 */
export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((node) => {
    const name = node.getAttribute("data-icon");
    if (!name) {
      return;
    }
    node.innerHTML = icon(name);
    node.removeAttribute("data-icon");
    node.classList.add("has-icon");
  });
}

export function iconEl(name, extraClass = "") {
  const span = document.createElement("span");
  span.className = "icon-slot";
  span.innerHTML = icon(name, extraClass);
  return span.firstElementChild ?? span;
}

export const ICON_NAMES = Object.keys(PATHS);
