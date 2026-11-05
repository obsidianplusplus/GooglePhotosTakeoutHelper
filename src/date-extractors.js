/**
 * 从 Google Takeout 元数据、EXIF、文件名或文件时间提取拍摄日期
 * （历史 Python v4.1 参考实现 的 Node.js 移植，837 行完整行为）。
 *
 * 保留 Dart 版本的日期来源优先级和 JSON 文件名修正规则，同时保留 Python
 * 版本的桌面增强：所有错误都限制在当前文件、文件名统一按 NFC 比较、支持
 * 新版 ``.supplemental-metadata.json`` 边车文件、EXIF 解码器懒加载。模块返回
 * 的日期均是不带时区的“本地墙上时间”Date，配合 src/time.js 的格式化函数使用。
 */

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_MAX_EXIF_BYTES, EXTRA_SUFFIXES, IMAGE_EXTENSIONS } from "./constants.js";
import { TaskContext } from "./models.js";
import { CancelledError, DateSource } from "./models.js";
import { parseDateTimeStrict, isValidDate } from "./time.js";
import * as exif from "./exif.js";
import * as imageSupport from "./image-support.js";

// 与 Dart 入口中的提取器顺序严格对应；数值越小，来源越可信。
export const JSON_ACCURACY = 0;
export const EXIF_ACCURACY = 1;
export const FILENAME_ACCURACY = 2;
export const AGGRESSIVE_JSON_ACCURACY = 3;
export const FILE_MTIME_ACCURACY = 4;

export const DATE_ACCURACY = Object.freeze({
  [DateSource.JSON]: JSON_ACCURACY,
  [DateSource.EXIF]: EXIF_ACCURACY,
  [DateSource.FILENAME]: FILENAME_ACCURACY,
  [DateSource.AGGRESSIVE_JSON]: AGGRESSIVE_JSON_ACCURACY,
  [DateSource.FILE_MTIME]: FILE_MTIME_ACCURACY,
});

// EXIF 解析规则与标签顺序在 src/exif.js 中实现；这里重新导出以保持 Python
// 模块的公开面（_EXIF_DATE_PATTERN/_parse_exif_datetime 的等价物）。
export const EXIF_DATE_PATTERN = exif.EXIF_DATE_PATTERN;
export const parseExifDateTime = exif.parseExifDateTime;
export { DEFAULT_MAX_EXIF_BYTES };

/**
 * 一次成功的日期提取结果。
 *
 * ``metadataPath`` 仅在日期来自 JSON 时填写，方便报告和问题诊断。对象可以
 * 通过 `asTuple()` 解包为 `[Date, DateSource, accuracy]`，同时保留具名字段。
 */
export class DateExtractionResult {
  constructor(value, source, accuracy, metadataPath = null) {
    this.value = value;
    this.source = source;
    this.accuracy = accuracy;
    this.metadataPath = metadataPath;
  }

  /** `value` 的语义化别名。 */
  get date() {
    return this.value;
  }

  /** 便于直接写入 MediaRecord 的别名。 */
  get dateTaken() {
    return this.value;
  }

  /** 返回不含诊断字段的三元组。 */
  asTuple() {
    return [this.value, this.source, this.accuracy];
  }

  [Symbol.iterator]() {
    return this.asTuple()[Symbol.iterator]();
  }

  get length() {
    return 3;
  }

  at(index) {
    return this.asTuple()[index];
  }
}

/** JSON 边车文件候选；`aggressive` 标记其是否来自激进规则。 */
class SidecarCandidate {
  constructor(name, aggressive) {
    this.name = name;
    this.aggressive = aggressive;
  }
}

// 原版六种文件名格式。正则故意不加单词边界，以保留“从长文件名中寻找日期
// 子串”的行为；真正的日历范围交给 datetime 校验。
const MONTH = "(?:01|02|03|04|05|06|07|08|09|10|11|12)";
const YEAR = "(?:20|19|18)[0-9]{2}";
const FILENAME_PATTERNS = [
  [new RegExp(`(${YEAR}${MONTH}[0-3][0-9]-[0-9]{6})`), "%Y%m%d-%H%M%S"],
  [new RegExp(`(${YEAR}${MONTH}[0-3][0-9]_[0-9]{6})`), "%Y%m%d_%H%M%S"],
  [
    new RegExp(`(${YEAR}-${MONTH}-[0-3][0-9]-[0-9]{2}-[0-9]{2}-[0-9]{2})`),
    "%Y-%m-%d-%H-%M-%S",
  ],
  [new RegExp(`(${YEAR}-${MONTH}-[0-3][0-9]-[0-9]{6})`), "%Y-%m-%d-%H%M%S"],
  [new RegExp(`(${YEAR}${MONTH}[0-3][0-9][0-9]{6})`), "%Y%m%d%H%M%S"],
  [
    new RegExp(`(${YEAR}_${MONTH}_[0-3][0-9]_[0-9]{2}_[0-9]{2}_[0-9]{2})`),
    "%Y_%m_%d_%H_%M_%S",
  ],
];

const SIDECAR_SUFFIXES = [".json", ".supplemental-metadata.json"];

// Python `mimetypes.guess_type` 的 Node 近似：显式补齐常见的 image/* 扩展名。
const IMAGE_MIME_OVERRIDES = new Map([
  [".jfif", "image/jpeg"],
  [".pjpeg", "image/jpeg"],
  [".pjp", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".svgz", "image/svg+xml"],
  [".psd", "image/vnd.adobe.photoshop"],
  [".jxl", "image/jxl"],
  [".apng", "image/apng"],
]);

// Pillow 只在第一次需要 EXIF 时加载；Node 对应地只探测一次图像解码能力。
let decodersAttempted = false;
let decodersPromise = null;
let decoderErrorReported = false;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 统一 Unicode 组合形式，解决 macOS 常见的 NFD 文件名问题。 */
function nfc(value) {
  return String(value).normalize("NFC");
}

/**
 * Python `str.casefold()` 的近似实现。
 * JS 没有完整的 Unicode casefold；这里覆盖最常见的 ß/ẞ/ς 差异。
 */
function caseFold(value) {
  return String(value)
    .toLowerCase()
    .replaceAll("\u00df", "ss")
    .replaceAll("\u1e9e", "ss")
    .replaceAll("\u03c2", "\u03c3");
}

/** 取路径的基础文件名（对应 Python Path(...).name）。 */
function baseName(mediaPath) {
  return path.basename(String(mediaPath));
}

/** 取路径的父目录（对应 Python Path(...).parent）。 */
function parentDir(mediaPath) {
  return path.dirname(String(mediaPath));
}

/** 把 Node 错误整理为与 Python `str(exc)` 相似的文本（不含 "Error: " 前缀）。 */
function exceptionText(error) {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

/** 取消异常必须越过逐文件隔离并由任务调度层处理。 */
function checkCancelled(context) {
  if (context !== null && context !== undefined) {
    context.checkCancelled();
  }
}

/** 日志回调本身异常时不影响媒体处理。 */
function log(context, level, message) {
  if (context === null || context === undefined) {
    return;
  }
  try {
    context.log(level, message);
  } catch {
    // 展示层回调异常必须吞掉。
  }
}

function snakeToCamel(name) {
  return String(name).replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

/** 同时支持 dataclass 配置、普通对象和字典式配置（snake/camel 键均接受）。 */
function optionValue(options, name, defaultValue) {
  if (options === null || options === undefined) {
    return defaultValue;
  }
  if (options instanceof Map) {
    for (const key of [name, snakeToCamel(name)]) {
      if (options.has(key)) {
        return options.get(key);
      }
    }
    return defaultValue;
  }
  if (typeof options !== "object") {
    return defaultValue;
  }
  for (const key of [name, snakeToCamel(name)]) {
    if (key in options && options[key] !== undefined) {
      return options[key];
    }
  }
  return defaultValue;
}

/** 显式覆盖参数为 null/undefined 时才回退配置对象值。 */
function resolvedBool(explicit, options, name, defaultValue) {
  const value = explicit === null || explicit === undefined
    ? optionValue(options, name, defaultValue)
    : explicit;
  return Boolean(value);
}

/** Python `int()` 的严格实现：失败抛错（对应 exif_extractor 的 int() 语义）。 */
function pythonIntStrict(value) {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`无法把 ${String(value)} 转换为整数`);
    }
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = value.trim().replaceAll("_", "");
    if (!/^[+-]?\d+$/.test(text)) {
      throw new Error(`无法把 ${String(value)} 转换为整数`);
    }
    return Number.parseInt(text, 10);
  }
  throw new Error(`无法把 ${String(value)} 转换为整数`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 文件系统错误（带 .code）按 Python OSError 处理。 */
function isFileSystemError(error) {
  return Boolean(error) && typeof error.code === "string";
}

// ---------------------------------------------------------------------------
// JSON 边车候选
// ---------------------------------------------------------------------------

/** 复刻 Google 旧式 JSON 文件名总长最多 51 个字符的截断规则。 */
function shortenName(filename) {
  const characters = Array.from(filename);
  return characters.length + ".json".length > 51
    ? characters.slice(0, 51 - ".json".length).join("")
    : filename;
}

/** 把 ``image(11).jpg`` 转成 Google 使用的 ``image.jpg(11)``。 */
function bracketSwap(filename) {
  const matches = [...filename.matchAll(/\([0-9]+\)(?=\.)/g)];
  if (matches.length === 0) {
    return filename;
  }
  const match = matches[matches.length - 1];
  const bracket = match[0];
  const start = match.index;
  const end = start + bracket.length;
  return filename.slice(0, start) + filename.slice(end) + bracket;
}

/** 删除原版白名单中的编辑后缀，匹配时忽略大小写并使用 NFC。 */
function removeKnownExtra(filename) {
  const normalized = nfc(filename);
  const lowered = normalized.toLowerCase();
  for (const suffix of EXTRA_SUFFIXES) {
    const normalizedSuffix = nfc(suffix);
    const index = lowered.lastIndexOf(normalizedSuffix.toLowerCase());
    if (index >= 0) {
      return normalized.slice(0, index) + normalized.slice(index + normalizedSuffix.length);
    }
  }
  return normalized;
}

/** 仅移除最后一个扩展名；隐藏文件名保持不变。 */
function withoutExtension(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** 激进规则：删除扩展名前未知的 ``-文字`` 后缀。 */
function removeUnknownExtra(filename) {
  // [^\W\d_] 在 Unicode 模式下表示字母，兼容原版拉丁字符范围并扩展至
  // 日文等脚本；数字括号由单个数字增强为任意位数。
  const matches = [
    ...nfc(filename).matchAll(/-([^\W\d_]+(?:\([0-9]+\))?)(?=\.[^\s.]+$)/gu),
  ];
  if (matches.length !== 1) {
    return filename;
  }
  // 与 Python 相同：位置来自 NFC 文本，但切片作用在原始 filename 上。
  const match = matches[0];
  const start = match.index;
  const end = start + match[0].length;
  return filename.slice(0, start) + filename.slice(end);
}

/** 激进规则：删除扩展名前的 ``(数字)``；支持多位数字。 */
function removeCopyNumber(filename) {
  return filename.replace(/\([0-9]+\)(?=\.)/g, "");
}

/**
 * 按 Dart 原版顺序生成边车文件名，并为每项加入新版后缀。
 *
 * 安全顺序为：原名、51 字符截断、括号换位、删除已知编辑后缀、删除媒体
 * 扩展名。激进顺序为：删除未知编辑后缀、删除副本编号。所有变换互相独立，
 * 不组合使用，这一点也与原版一致。
 */
function sidecarCandidates(mediaPath, { includeSafe, includeAggressive }) {
  const filename = nfc(baseName(mediaPath));
  const candidates = [];
  const seen = new Set();

  const safeNames = [
    filename,
    shortenName(filename),
    bracketSwap(filename),
    removeKnownExtra(filename),
    withoutExtension(filename),
  ];
  const aggressiveNames = [removeUnknownExtra(filename), removeCopyNumber(filename)];

  const appendNames = (names, aggressive) => {
    for (const base of names) {
      for (const suffix of SIDECAR_SUFFIXES) {
        const name = nfc(base + suffix);
        const key = `${aggressive ? "1" : "0"}\u0000${name}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        candidates.push(new SidecarCandidate(name, aggressive));
      }
    }
  };

  if (includeSafe) {
    appendNames(safeNames, false);
  }
  if (includeAggressive) {
    appendNames(aggressiveNames, true);
  }
  return candidates;
}

/**
 * 公开候选列表，便于 UI 预览、测试和问题诊断。
 *
 * @param {string} mediaPath
 * @param {{aggressive?: boolean}} [options]
 * @returns {string[]}
 */
export function jsonSidecarCandidates(mediaPath, { aggressive = false } = {}) {
  const parent = parentDir(mediaPath);
  return sidecarCandidates(mediaPath, {
    includeSafe: true,
    includeAggressive: aggressive,
  }).map((candidate) => path.join(parent, candidate.name));
}

// ---------------------------------------------------------------------------
// 任务级边车目录索引
// ---------------------------------------------------------------------------

/**
 * 一次扫描目录，建立原名、NFC 名称与忽略大小写三层索引。
 * 返回 {raw, normalized, folded}，值为完整路径字符串。
 */
function buildSidecarDirectoryIndex(parent, context) {
  const raw = new Map();
  const normalized = new Map();
  const folded = new Map();
  try {
    const entries = fs.readdirSync(parent, { withFileTypes: true });
    for (let number = 0; number < entries.length; number += 1) {
      if (number % 256 === 0) {
        checkCancelled(context);
      }
      const entry = entries[number];
      if (!caseFold(entry.name).endsWith(".json")) {
        continue;
      }
      let isFile = false;
      try {
        if (entry.isFile()) {
          isFile = true;
        } else if (entry.isSymbolicLink()) {
          // Python 的 Path.is_file() 会跟随符号链接。
          isFile = fs.statSync(path.join(parent, entry.name)).isFile();
        }
      } catch {
        continue;
      }
      if (!isFile) {
        continue;
      }
      const fullPath = path.join(parent, entry.name);
      const normalizedName = nfc(entry.name);
      if (!raw.has(entry.name)) {
        raw.set(entry.name, fullPath);
      }
      if (!normalized.has(normalizedName)) {
        normalized.set(normalizedName, fullPath);
      }
      const foldedName = caseFold(normalizedName);
      if (!folded.has(foldedName)) {
        folded.set(foldedName, fullPath);
      }
    }
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    if (!isFileSystemError(error)) {
      throw error;
    }
    // 失败也缓存空索引；同一次扫描中反复访问不可读目录没有意义。
  }
  return { raw, normalized, folded };
}

/** 返回任务级目录索引；同一 TaskContext 中每个目录最多枚举一次。 */
function sidecarDirectoryIndex(parent, context) {
  if (context === null || context === undefined) {
    return buildSidecarDirectoryIndex(parent, null);
  }
  // normcase 兼容 Windows 大小写不敏感路径；绝对路径避免同一目录因相对写法
  // 不同而建立多份索引。缓存跟随 TaskContext 生命周期，不会跨扫描陈旧。
  const absolute = path.resolve(parent);
  const cacheKey = nfc(process.platform === "win32" ? absolute.toLowerCase() : absolute);
  if (!(context.sidecarDirectoryIndexes instanceof Map)) {
    context.sidecarDirectoryIndexes = new Map();
  }
  const cached = context.sidecarDirectoryIndexes.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const index = buildSidecarDirectoryIndex(parent, context);
  context.sidecarDirectoryIndexes.set(cacheKey, index);
  return index;
}

/** 从任务级目录索引中按候选优先级查找实际存在的边车文件。 */
function existingSidecars(parent, candidates, context) {
  const { raw, normalized, folded } = sidecarDirectoryIndex(parent, context);
  const found = [];
  const foundPaths = new Set();
  for (const candidate of candidates) {
    const matched = raw.get(candidate.name)
      ?? normalized.get(candidate.name)
      ?? folded.get(caseFold(candidate.name));
    if (matched !== undefined && !foundPaths.has(matched)) {
      found.push({ path: matched, aggressive: candidate.aggressive });
      foundPaths.add(matched);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// JSON 时间戳解析
// ---------------------------------------------------------------------------

/** Python float(str) 的近似实现；无法解析或非有限时返回 NaN。 */
function pythonFloat(text) {
  let valueText = String(text).trim();
  if (valueText === "") {
    return Number.NaN;
  }
  if (/^[+-]?(?:inf(?:inity)?|nan)$/i.test(valueText)) {
    return Number.NaN;
  }
  if (valueText.includes("_")) {
    if (!/^[+-]?[\d_]+(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?$/.test(valueText)) {
      return Number.NaN;
    }
    valueText = valueText.replaceAll("_", "");
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(valueText)) {
    return Number.NaN;
  }
  const value = Number(valueText);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** 由各字段构造严格校验的本地 Date（对应 Python datetime(...) 的 ValueError 行为）。 */
function localDateFromFields(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }
  if (ms < 0 || ms > 999) {
    return null;
  }
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, ms);
  if (!isValidDate(date)) {
    return null;
  }
  const parts = {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    ms: date.getMilliseconds(),
  };
  if (
    parts.year !== year ||
    parts.month !== month ||
    parts.day !== day ||
    parts.hour !== hour ||
    parts.minute !== minute ||
    parts.second !== second ||
    parts.ms !== ms
  ) {
    return null;
  }
  return date;
}

const ISO_EXTENDED_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:([+-])(\d{2}):?(\d{2})?)?$/;
const ISO_BASIC_PATTERN =
  /^(\d{4})(\d{2})(\d{2})(?:[T ](\d{2})(\d{2})(?::?(\d{2})(?:\.(\d+))?)?)?(?:([+-])(\d{2}):?(\d{2})?)?$/;

/**
 * Python `datetime.fromisoformat` 的常用子集：日期、日期时间、空格/T 分隔、
 * 小数秒与 ±HH:MM/±HHMM/±HH 时区。
 */
function parseIsoDateTimeFallback(text) {
  let match = ISO_EXTENDED_PATTERN.exec(text);
  if (match === null) {
    match = ISO_BASIC_PATTERN.exec(text);
  }
  if (match === null) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = match[4] === undefined ? 0 : Number.parseInt(match[4], 10);
  const minute = match[5] === undefined ? 0 : Number.parseInt(match[5], 10);
  const second = match[6] === undefined ? 0 : Number.parseInt(match[6], 10);
  const fraction = match[7] === undefined ? "" : match[7];
  const ms = fraction === "" ? 0 : Number.parseInt(fraction.slice(0, 3).padEnd(3, "0"), 10);
  const sign = match[8];
  const offsetHours = match[9] === undefined ? 0 : Number.parseInt(match[9], 10);
  const offsetMinutes = match[10] === undefined ? 0 : Number.parseInt(match[10], 10);
  if (offsetHours > 23 || offsetMinutes > 59) {
    return null;
  }
  if (sign === undefined) {
    return localDateFromFields(year, month, day, hour, minute, second, ms);
  }
  const offsetSign = sign === "-" ? -1 : 1;
  const offsetMs = offsetSign * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
  const instant = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMs,
  );
  if (!isValidDate(instant)) {
    return null;
  }
  // Python：aware datetime 先 astimezone() 转本地时区再去掉 tzinfo，
  // 因此这里保留“瞬时”的 Date，后续用本地 getter 读取墙上时间。
  return instant;
}

/**
 * 解析 Google 时间戳，并统一成不带时区的本地时间（对应 `_timestamp_to_local_datetime`）。
 */
function timestampToLocalDate(value) {
  if (value === null || value === undefined || typeof value === "boolean") {
    return null;
  }
  const text = String(value).trim();
  if (text === "") {
    return null;
  }

  const number = pythonFloat(text);
  if (Number.isFinite(number)) {
    // Google 当前使用秒；兼容某些第三方修复工具写入的毫秒时间戳。
    const seconds = Math.abs(number) >= 100_000_000_000 ? number / 1000.0 : number;
    try {
      const date = new Date(seconds * 1000);
      if (!isValidDate(date)) {
        return null;
      }
      // Python datetime 只支持 1..9999 年，超出范围时 fromtimestamp() 抛错 → null。
      const year = date.getFullYear();
      if (year < 1 || year > 9999) {
        return null;
      }
      // 平台差异：Windows 的本地时间转换（localtime_s）不接受 1970 之前的
      // 负时间戳，Python datetime.fromtimestamp(-1) 会抛 OSError；POSIX 下
      // Python 仍可表示，因此只在 win32 上保持这种“无效”→null 的行为。
      if (process.platform === "win32" && seconds < 0) {
        return null;
      }
      return date;
    } catch {
      return null;
    }
  }

  // 非标准边车有时直接写 ISO 8601；标准 Takeout 不受此增强影响。
  return parseIsoDateTimeFallback(text.replaceAll("Z", "+00:00"));
}

/** 读取 ``photoTakenTime.timestamp``；格式不符时返回 null。 */
function readJsonDatetime(sidecarPath) {
  let text = fs.readFileSync(sidecarPath, "utf8");
  // Python 使用 encoding="utf-8-sig"，会去掉 UTF-8 BOM。
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const data = JSON.parse(text);
  if (!isPlainObject(data)) {
    return null;
  }
  const photoTime = data.photoTakenTime;
  if (!isPlainObject(photoTime)) {
    return null;
  }
  return timestampToLocalDate(photoTime.timestamp);
}

/**
 * JSON 提取内部实现，可让总调度器把激进规则放到文件名规则之后。
 *
 * @returns {Promise<DateExtractionResult|null>}
 */
async function extractJson(mediaPath, { includeSafe, includeAggressive, context = null }) {
  try {
    checkCancelled(context);
    const candidates = sidecarCandidates(mediaPath, {
      includeSafe,
      includeAggressive,
    });
    const parent = parentDir(mediaPath);
    for (const found of existingSidecars(parent, candidates, context)) {
      checkCancelled(context);
      let value;
      try {
        value = readJsonDatetime(found.path);
      } catch (error) {
        if (error instanceof CancelledError) {
          throw error;
        }
        // Python 第一段捕获 (OSError, UnicodeError, JSONDecodeError, TypeError,
        // ValueError)；Node 对应 JSON.parse 的 SyntaxError、类型错误与带 code
        // 的文件系统错误。
        const readable = error instanceof SyntaxError
          || error instanceof TypeError
          || isFileSystemError(error);
        if (readable) {
          log(context, "warning", `无法读取元数据 ${found.path}：${exceptionText(error)}`);
        } else {
          log(context, "warning", `解析元数据 ${found.path} 时发生异常：${exceptionText(error)}`);
        }
        continue;
      }
      if (value === null) {
        log(context, "warning", `元数据缺少有效拍摄时间：${found.path}`);
        continue;
      }
      const source = found.aggressive ? DateSource.AGGRESSIVE_JSON : DateSource.JSON;
      return new DateExtractionResult(value, source, DATE_ACCURACY[source], found.path);
    }
    return null;
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    log(context, "warning", `为 ${mediaPath} 查找 JSON 日期失败：${exceptionText(error)}`);
    return null;
  }
}

/**
 * 从相邻 JSON 边车文件提取拍摄时间。
 *
 * ``tryhard`` 是对 Dart 原接口的兼容别名。激进模式仍先尝试全部安全候选；
 * 返回来源和准确度会根据真正命中的候选自动确定。
 *
 * @param {string} mediaPath
 * @param {{aggressive?: boolean, tryhard?: boolean|null, context?: TaskContext|null}} [options]
 * @returns {Promise<DateExtractionResult|null>}
 */
export async function jsonExtractor(
  mediaPath,
  { aggressive = false, tryhard = null, context = null } = {},
) {
  if (tryhard !== null && tryhard !== undefined) {
    aggressive = Boolean(tryhard);
  }
  return extractJson(String(mediaPath), {
    includeSafe: true,
    includeAggressive: aggressive,
    context,
  });
}

// ---------------------------------------------------------------------------
// EXIF
// ---------------------------------------------------------------------------

/** 以扩展名为主、mimetypes 为辅判断是否值得尝试图像解码器。 */
function isImagePath(mediaPath) {
  const target = String(mediaPath);
  const suffix = path.extname(target).toLowerCase();
  if (IMAGE_EXTENSIONS.has(suffix)) {
    return true;
  }
  const mime = IMAGE_MIME_OVERRIDES.get(suffix);
  return Boolean(mime && mime.startsWith("image/"));
}

/**
 * 延迟探测图像解码能力；缺少依赖时让 JSON/文件名等来源继续工作。
 * 对应 Python `_load_pillow`。
 */
async function loadImageDecoders(context) {
  if (!decodersAttempted) {
    decodersAttempted = true;
    decodersPromise = (async () => {
      const capabilities = await imageSupport.getImageCapabilities();
      // Python 导入 Pillow 时顺带注册 pillow-heif；Node 对应预热 heic-decode。
      await imageSupport.ensureHeifDecoder();
      return capabilities;
    })();
  }
  const capabilities = await decodersPromise;
  if (!capabilities.sharp && context !== null && context !== undefined && !decoderErrorReported) {
    decoderErrorReported = true;
    log(
      context,
      "warning",
      // 平台差异：Python 这里提示 “Pillow 不可用，已跳过 EXIF”；Node 的 EXIF
      // 解码器是 sharp（HEIC 走纯 JS 容器解析器），故改写为“图像解码器”。
      `图像解码器不可用，已跳过 EXIF：${exceptionText(capabilities.sharpError)}`,
    );
  }
  return capabilities;
}

/** 同类环境问题只记录一次，避免日志洪泛（对应 `_log_exif_notice_once`）。 */
function logExifNoticeOnce(context, key, message) {
  if (context === null || context === undefined) {
    return;
  }
  if (!(context.exifNotices instanceof Set)) {
    context.exifNotices = new Set();
  }
  if (context.exifNotices.has(key)) {
    return;
  }
  context.exifNotices.add(key);
  log(context, "warning", message);
}

/**
 * 用 sharp/HEIC 容器解析器提取图片 EXIF 日期；任何坏文件只影响当前媒体。
 * 对应 Python `exif_extractor`。
 *
 * @param {string} mediaPath
 * @param {{maxExifBytes?: number|null, context?: TaskContext|null}} [options]
 * @returns {Promise<DateExtractionResult|null>}
 */
export async function exifExtractor(
  mediaPath,
  { maxExifBytes = DEFAULT_MAX_EXIF_BYTES, context = null } = {},
) {
  const target = String(mediaPath);
  try {
    checkCancelled(context);
    if (!isImagePath(target)) {
      return null;
    }
    if (maxExifBytes !== null && maxExifBytes !== undefined) {
      const limit = Math.max(0, pythonIntStrict(maxExifBytes));
      if (fs.statSync(target).size > limit) {
        log(context, "info", `图片超过 EXIF 读取上限，已跳过：${target}`);
        return null;
      }
    }
    const capabilities = await loadImageDecoders(context);
    checkCancelled(context);

    const heifExtension = imageSupport.HEIF_EXTENSIONS.has(path.extname(target).toLowerCase());
    // Python：Pillow 自己不可用时直接返回（上面已给出一次性提示）。Node 的
    // HEIC EXIF 由纯 JS 容器解析器读取，因此 HEIF 文件仍可继续尝试（平台差异）。
    if (!capabilities.sharp && !heifExtension) {
      return null;
    }

    // Python 的“Pillow 已加载但 pillow-heif 缺失”分支：Node 对应 heic-decode
    // 缺失。保留同样的“本次扫描中同类原因仅提示一次”语义。
    const unavailableReason = imageSupport.decoderUnavailableReason(target, capabilities);
    if (unavailableReason !== null) {
      logExifNoticeOnce(
        context,
        `decoder-unavailable:${path.extname(target).toLowerCase()}`,
        `读取 ${target} 的 EXIF 已跳过：${unavailableReason}（本次扫描中同类原因仅提示一次）`,
      );
      return null;
    }

    const metadata = await exif.readExifMetadata(target);
    if (metadata.value !== null) {
      return new DateExtractionResult(metadata.value, DateSource.EXIF, EXIF_ACCURACY);
    }
    if (metadata.unavailable) {
      return null;
    }
    if (metadata.error !== null) {
      let reason;
      if (metadata.heifSignature?.isHeif || heifExtension) {
        reason = imageSupport.heifDecodeFailureReason(target, metadata.error)
          ?? `图像解码器无法识别图片内容：${exceptionText(metadata.error)}`;
      } else {
        // 平台差异：Python 这里是 “Pillow 无法识别图片内容”；Node 换成图像解码器。
        reason = `图像解码器无法识别图片内容：${exceptionText(metadata.error)}`;
      }
      log(context, "warning", `读取 ${target} 的 EXIF 失败，已跳过：${reason}`);
      return null;
    }
    return null;
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    log(context, "warning", `读取 ${target} 的 EXIF 失败，已跳过：${exceptionText(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 文件名与修改时间
// ---------------------------------------------------------------------------

/**
 * 从六种常见相机/截图文件名格式猜测本地拍摄时间。
 * 同步函数（与 Python 一致）。
 *
 * @param {string} mediaPath
 * @param {{context?: TaskContext|null}} [options]
 * @returns {DateExtractionResult|null}
 */
export function filenameExtractor(mediaPath, { context = null } = {}) {
  const target = String(mediaPath);
  try {
    checkCancelled(context);
    const filename = nfc(baseName(target));
    for (const [pattern, dateFormat] of FILENAME_PATTERNS) {
      const match = pattern.exec(filename);
      if (match === null) {
        continue;
      }
      const value = parseDateTimeStrict(match[1], dateFormat);
      if (value === null) {
        continue;
      }
      return new DateExtractionResult(value, DateSource.FILENAME, FILENAME_ACCURACY);
    }
    return null;
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    log(context, "warning", `从文件名推断 ${target} 的日期失败：${exceptionText(error)}`);
    return null;
  }
}

// 保留 Dart 函数名，便于迁移测试和第三方调用代码。
export const guessExtractor = filenameExtractor;

/**
 * 使用文件系统修改时间作为最低可信度的兜底日期。
 * 同步函数（与 Python 一致）。
 *
 * @param {string} mediaPath
 * @param {{context?: TaskContext|null}} [options]
 * @returns {DateExtractionResult|null}
 */
export function mtimeExtractor(mediaPath, { context = null } = {}) {
  const target = String(mediaPath);
  try {
    checkCancelled(context);
    // Python datetime.fromtimestamp()：本地墙上时间；new Date(ms) 的本地 getter
    // 读取结果与之一致。
    const value = new Date(fs.statSync(target).mtimeMs);
    if (!isValidDate(value)) {
      throw new Error("修改时间超出可表示范围");
    }
    return new DateExtractionResult(value, DateSource.FILE_MTIME, FILE_MTIME_ACCURACY);
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    log(context, "warning", `读取 ${target} 的修改时间失败：${exceptionText(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 总调度
// ---------------------------------------------------------------------------

/**
 * 按可信度顺序为一个媒体文件提取日期。
 *
 * 可以传入 OrganizeOptions、FixDateOptions、具有同名属性的普通对象或
 * Map；`overrides` 中的布尔值会覆盖配置对象。为保持原版语义，激进 JSON
 * 仅在普通 JSON 启用时生效，并且排在文件名猜测之后。
 *
 * @param {string} filePath
 * @param {object|TaskContext|null} [optionsOrContext]
 * @param {TaskContext|null} [context]
 * @param {{useJson?: boolean, useExif?: boolean, useFilename?: boolean,
 *   aggressiveJson?: boolean, useFileMtime?: boolean,
 *   maxExifBytes?: number|null}} [overrides]
 * @returns {Promise<DateExtractionResult|null>}
 */
export async function extractDate(
  filePath,
  optionsOrContext = null,
  context = null,
  overrides = {},
) {
  // 允许简洁写法 extractDate(path, context)，同时不牺牲标准配置接口。
  let options = optionsOrContext;
  if (optionsOrContext instanceof TaskContext && (context === null || context === undefined)) {
    context = optionsOrContext;
    options = null;
  }
  const target = String(filePath);
  const overrideValues = overrides ?? {};
  const override = (camel, snake) => {
    if (overrideValues[camel] !== undefined) {
      return overrideValues[camel];
    }
    if (overrideValues[snake] !== undefined) {
      return overrideValues[snake];
    }
    return undefined;
  };

  const jsonEnabled = resolvedBool(override("useJson", "use_json"), options, "use_json", true);
  const exifEnabled = resolvedBool(override("useExif", "use_exif"), options, "use_exif", true);
  const filenameEnabled = resolvedBool(
    override("useFilename", "use_filename"),
    options,
    "use_filename",
    true,
  );
  const aggressiveEnabled = resolvedBool(
    override("aggressiveJson", "aggressive_json"),
    options,
    "aggressive_json",
    true,
  );
  const mtimeEnabled = resolvedBool(
    override("useFileMtime", "use_file_mtime"),
    options,
    "use_file_mtime",
    false,
  );

  let maxExifBytes;
  const maxOverride = override("maxExifBytes", "max_exif_bytes");
  if (maxOverride === undefined || maxOverride === null) {
    const configuredLimit = optionValue(options, "max_exif_bytes", DEFAULT_MAX_EXIF_BYTES);
    try {
      maxExifBytes = pythonIntStrict(configuredLimit);
    } catch {
      maxExifBytes = DEFAULT_MAX_EXIF_BYTES;
      log(context, "warning", "EXIF 大小上限无效，已恢复默认值");
    }
  } else {
    maxExifBytes = maxOverride;
  }

  try {
    checkCancelled(context);
    if (jsonEnabled) {
      const result = await extractJson(target, {
        includeSafe: true,
        includeAggressive: false,
        context,
      });
      if (result !== null) {
        return result;
      }
    }

    if (exifEnabled) {
      const result = await exifExtractor(target, { maxExifBytes, context });
      if (result !== null) {
        return result;
      }
    }

    if (filenameEnabled) {
      const result = filenameExtractor(target, { context });
      if (result !== null) {
        return result;
      }
    }

    if (jsonEnabled && aggressiveEnabled) {
      const result = await extractJson(target, {
        includeSafe: false,
        includeAggressive: true,
        context,
      });
      if (result !== null) {
        return result;
      }
    }

    if (mtimeEnabled) {
      return mtimeExtractor(target, { context });
    }
    return null;
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    // 各提取器已有自己的隔离；这里再做最后一道防线，确保工作线程不会因
    // 单个不可预期的文件或第三方库异常而退出。
    log(context, "warning", `提取 ${target} 的日期失败，已隔离：${exceptionText(error)}`);
    return null;
  }
}

// 语义更明确的别名，供引擎或外部调用方选择。
export const extractBestDate = extractDate;
