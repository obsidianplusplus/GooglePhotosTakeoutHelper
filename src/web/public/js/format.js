/**
 * 中文标签与格式化辅助。
 * 标签文本与 Python 桌面版 历史 Python v4.1 参考实现、历史 Python v4.1 参考实现 保持一致。
 */

export const ALBUM_OPTIONS = [
  { value: "shortcut", label: "快捷方式（推荐，节省空间）" },
  { value: "duplicate-copy", label: "复制到每个相册（最兼容）" },
  { value: "json", label: "单目录 + 相册 JSON" },
  { value: "nothing", label: "忽略相册，仅保留时间线" },
];

export const DIVISION_OPTIONS = [
  { value: "year-month", label: "年 / 月目录" },
  { value: "year", label: "仅按年份" },
  { value: "flat", label: "全部放在同一目录" },
];

export const CONFLICT_OPTIONS = [
  { value: "rename", label: "自动重命名（推荐）" },
  { value: "skip", label: "跳过同名文件" },
  { value: "overwrite", label: "覆盖同名文件（危险）" },
];

export const UNKNOWN_OPTIONS = [
  { value: "folder", label: "放入 date-unknown" },
  { value: "root", label: "放在相册根目录" },
  { value: "skip", label: "跳过未知日期文件" },
];

export const LIVE_PHOTO_TARGET_OPTIONS = [
  { value: "apple", label: "Apple 照片（原始双文件）" },
  { value: "coloros16", label: "OPPO ColorOS 16（经 O+ 互联）" },
];

export const ACTION_LABELS = {
  copy: "复制",
  move: "移动",
  shortcut: "快捷方式",
  skip: "跳过",
};

export const PHASE_LABELS = {
  scanning: "扫描媒体",
  deduplicating: "查找重复项",
  dating: "提取拍摄日期",
  "merging-albums": "合并相册关系",
  planning: "生成执行计划",
  executing: "写入输出目录",
  fixing: "修复文件日期",
  finished: "任务完成",
};

export const DATE_SOURCE_LABELS = {
  json: "Google Photos JSON",
  exif: "照片 EXIF",
  filename: "文件名推断",
  "aggressive-json": "深度匹配 JSON",
  "file-mtime": "文件修改时间",
};

export const DISPOSITION_LABELS = {
  primary: "主文件",
  "album-copy": "相册来源",
  skipped: "同来源跳过",
  filtered: "额外版本过滤",
};

export const LEVEL_LABELS = {
  INFO: "信息",
  WARNING: "警告",
  ERROR: "错误",
  DEBUG: "调试",
};

const MAPS = {
  album: new Map(ALBUM_OPTIONS.map((item) => [item.value, item.label])),
  division: new Map(DIVISION_OPTIONS.map((item) => [item.value, item.label])),
  conflict: new Map(CONFLICT_OPTIONS.map((item) => [item.value, item.label])),
  unknown: new Map(UNKNOWN_OPTIONS.map((item) => [item.value, item.label])),
  liveTarget: new Map(LIVE_PHOTO_TARGET_OPTIONS.map((item) => [item.value, item.label])),
};

export function albumLabel(value) {
  return MAPS.album.get(value) ?? value;
}

export function divisionLabel(value) {
  return MAPS.division.get(value) ?? value;
}

export function conflictLabel(value) {
  return MAPS.conflict.get(value) ?? value;
}

export function unknownLabel(value) {
  return MAPS.unknown.get(value) ?? value;
}

export function liveTargetLabel(value) {
  return MAPS.liveTarget.get(value) ?? value;
}

export function actionLabel(row) {
  let label = ACTION_LABELS[row.kind] ?? row.kind;
  if (row.role === "still") {
    label += " · 实况静态图";
  } else if (row.role === "motion") {
    label += " · 动态片段";
  }
  return label;
}

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] ?? phase;
}

export function dateSourceLabel(value) {
  return DATE_SOURCE_LABELS[value] ?? (value ?? "无");
}

export function dispositionLabel(value) {
  return DISPOSITION_LABELS[value] ?? value;
}

export function defaultReason(disposition) {
  switch (disposition) {
    case "primary":
      return "作为该内容组的主要输出来源。";
    case "album-copy":
      return "内容相同，但保留此来源以维持相册关系。";
    case "skipped":
      return "与同一来源中的主文件内容完全相同，因此不重复进入计划。";
    case "filtered":
      return "按额外版本过滤规则从整理计划中排除。";
    default:
      return "按当前分析规则处理。";
  }
}

/** 与 Python f"{n:,}" 一致的千分位。 */
export function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "—";
  }
  return Math.trunc(number).toLocaleString("en-US");
}

/** 与 duplicate_view._format_bytes 一致的二进制单位。 */
export function formatBytes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "未知";
  }
  let amount = Math.max(Number(value), 0);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = units[0];
  for (const candidate of units) {
    unit = candidate;
    if (amount < 1024 || candidate === units[units.length - 1]) {
      break;
    }
    amount /= 1024;
  }
  if (unit === "B") {
    return `${formatCount(amount)} B`;
  }
  return `${amount.toFixed(2)} ${unit}`;
}

export function formatPercent(value, total) {
  const ratio = total > 0 ? Math.min(Math.max(value / total, 0), 1) : 0;
  return `${Math.round(ratio * 100)}%`;
}

/** 把 Date 格式化为本地 YYYY-MM-DD HH:MM:SS（与桌面版一致，不使用 UTC）。 */
export function formatDateTime(value) {
  if (!value) {
    return "不可用";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "不可用";
  }
  const pad = (number) => String(number).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 把后端/扫描时间格式化为表格文本。 */
export function dateTimeText(value) {
  if (!value) {
    return "未知";
  }
  // 后端 PreviewRow 已是 "YYYY-MM-DD HH:MM:SS"；重复组日期为本地 isoformat。
  if (typeof value === "string") {
    return value.replace("T", " ").slice(0, 19);
  }
  return String(value);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 文件大小用于列表的紧凑格式。 */
export function formatBytesShort(value) {
  if (value === null || value === undefined) {
    return "—";
  }
  const text = formatBytes(value);
  return text.replace(".00 ", " ");
}

export function truncateMiddle(text, max = 60) {
  const value = String(text ?? "");
  if (value.length <= max) {
    return value;
  }
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}
