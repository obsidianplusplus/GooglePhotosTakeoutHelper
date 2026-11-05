/**
 * 桌面界面设置的持久化存储（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * 磁盘格式、默认值、递归合并、旧字段迁移与规范化规则全部与 Python 保持一致：
 * - 损坏/不可读/非对象 JSON 回退默认值；
 * - 旧版 `window_geometry`/`ui_scale`/`defaults` 嵌套字段迁移为新扁平字段；
 * - 未知键保留（向前兼容）；
 * - 保存时使用同目录临时文件 + 原子 rename，避免强制关机损坏设置。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { settingsPath } from "./constants.js";

export const SCHEMA_VERSION = 2;

export const DEFAULT_SETTINGS = {
  schema_version: SCHEMA_VERSION,
  appearance: "System",
  scaling: 1.0,
  geometry: "1180x760",
  // 此值现在表示渐进加载的单批行数，不再截断执行计划。
  preview_limit: 300,
  remember_paths: false,
  operation: "copy",
  album_mode: "shortcut",
  date_division: "year-month",
  conflict_mode: "rename",
  unknown_date_mode: "folder",
  skip_extras: false,
  set_file_mtime: true,
  use_json: true,
  use_exif: true,
  use_filename: true,
  aggressive_json: true,
  use_file_mtime: false,
  scan_all_if_no_takeout: true,
  include_hidden: false,
  write_report: true,
  use_hash_cache: true,
  recognize_live_photos: false,
  live_photo_target: "apple",
  // 仅在用户明确启用时，才按拍摄日期修正完整日期型文件名。
  correct_date_filenames: false,
  workers: 4,
  all_photos_folder: "ALL_PHOTOS",
  unknown_date_folder: "date-unknown",
  fix_recursive: true,
  fix_json: true,
  fix_exif: true,
  fix_filename: true,
  fix_aggressive: true,
  fix_file_mtime: false,
  fix_include_hidden: false,
  fix_dry_run: false,
  fix_correct_date_filenames: false,
  input_dir: "",
  output_dir: "",
  fix_dir: "",
};

/** 是否为 JSON 风格的普通对象（对应 Python 的 isinstance(value, dict)）。 */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 递归深拷贝 JSON 风格的值（对应 Python copy.deepcopy）。 */
export function deepCopyValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => deepCopyValue(item));
  }
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = deepCopyValue(item);
    }
    return output;
  }
  return value;
}

/**
 * 只递归合并字典，未知键保留以便未来版本向前兼容。
 * 直接修改并返回 base（与 Python `_merge_dict` 一致）。
 */
export function mergeDict(base, incoming) {
  if (!isPlainObject(base) || !isPlainObject(incoming)) {
    return base;
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      base[key] = mergeDict(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/**
 * 把早期设置模块的嵌套字段迁移为桌面界面使用的扁平字段。
 * 与 Python 相同：迁移后的旧键仍保留在结果中。
 */
export function migrateLegacySettings(loaded) {
  const migrated = deepCopyValue(loaded);
  if (!Object.prototype.hasOwnProperty.call(migrated, "geometry") &&
      Object.prototype.hasOwnProperty.call(migrated, "window_geometry")) {
    migrated.geometry = migrated.window_geometry;
  }
  if (!Object.prototype.hasOwnProperty.call(migrated, "scaling") &&
      Object.prototype.hasOwnProperty.call(migrated, "ui_scale")) {
    migrated.scaling = migrated.ui_scale;
  }

  const legacyDefaults = migrated.defaults;
  if (isPlainObject(legacyDefaults)) {
    for (const [key, value] of Object.entries(legacyDefaults)) {
      if (!Object.prototype.hasOwnProperty.call(migrated, key)) {
        migrated[key] = value;
      }
    }
  }
  return migrated;
}

/**
 * Python `int()` 的接近实现：布尔按 0/1、浮点向零截断、数字字符串严格解析。
 * 解析失败时返回 fallback（Python 这里会抛 TypeError/ValueError 并被上层捕获）。
 */
function coercePythonInt(value, fallback) {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = value.trim().replaceAll("_", "");
    if (!/^[+-]?\d+$/.test(text)) {
      return fallback;
    }
    const parsed = Number.parseInt(text, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * 对安全敏感的新字段做类型与枚举收敛，损坏值回退到兼容默认值。
 * 与 Python `_normalise_settings` 一样原地修改并返回 values。
 */
export function normaliseSettings(values) {
  if (!isPlainObject(values)) {
    return values;
  }
  if (typeof values.recognize_live_photos !== "boolean") {
    values.recognize_live_photos = false;
  }
  // Python 使用 `not in {"apple", "coloros16"}`；这里显式按字符串比较，
  // 避免 Python 中不可哈希值会抛 TypeError 的边角行为影响设置加载。
  if (values.live_photo_target !== "apple" && values.live_photo_target !== "coloros16") {
    values.live_photo_target = "apple";
  }
  for (const key of ["correct_date_filenames", "fix_correct_date_filenames"]) {
    if (typeof values[key] !== "boolean") {
      values[key] = false;
    }
  }
  const previewBatchSize = coercePythonInt(values.preview_limit ?? 300, 300);
  values.preview_limit = Math.min(Math.max(previewBatchSize, 100), 1000);
  return values;
}

/**
 * 读取设置；损坏或旧格式时保留可识别字段并回退默认值。
 * `filePath` 为 null 时使用 constants.settingsPath()。
 */
export function loadSettings(filePath = null) {
  const target = filePath === null || filePath === undefined ? settingsPath() : String(filePath);
  const defaults = deepCopyValue(DEFAULT_SETTINGS);
  try {
    const text = fs.readFileSync(target, "utf8");
    const loaded = JSON.parse(text);
    if (!isPlainObject(loaded)) {
      return defaults;
    }
    return normaliseSettings(mergeDict(defaults, migrateLegacySettings(loaded)));
  } catch {
    // Python 捕获 OSError / UnicodeError / JSONDecodeError；Node 的
    // fs 错误（.code）与 JSON.parse SyntaxError 都在这里按默认值回退。
    return defaults;
  }
}

/**
 * 采用临时文件原子写入，避免强制关机破坏设置。
 * `filePath` 为 null 时使用 constants.settingsPath()。
 */
export function saveSettings(values, filePath = null) {
  const target = filePath === null || filePath === undefined ? settingsPath() : String(filePath);
  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true });
  const data = normaliseSettings(mergeDict(deepCopyValue(DEFAULT_SETTINGS), values ?? {}));
  data.schema_version = SCHEMA_VERSION;
  // Python json.dumps(..., ensure_ascii=False, indent=2) 与 JSON.stringify(..., 2)
  // 的空白布局一致（无末尾换行，非 ASCII 原样保留）。
  let payload = JSON.stringify(data, null, 2);
  // JS 无法区分 1 与 1.0（都是 number），而 Python 的默认 scaling 是浮点 1.0，
  // json.dumps 会写成 "1.0"。为保持默认设置文件的字节级输出一致，这里把整数值
  // 的 scaling 补成 Python 的浮点写法（用户自定义非整值不受影响）。
  payload = payload.replace(/("scaling": )(-?\d+)([,\n])/, "$1$2.0$3");
  const temporary = path.join(
    targetDir,
    `.${path.basename(target)}.${crypto.randomUUID().replaceAll("-", "")}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, payload, "utf8");
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // 对应 Python temporary.unlink(missing_ok=True)。
    }
  }
}
