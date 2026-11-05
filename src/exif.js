/**
 * EXIF 日期与方向读取（Node.js 实现，无 Python 对应文件）。
 *
 * 支持两条读取路径：
 * 1. `sharp` 的 `metadata()`：JPEG/PNG/WebP/GIF/TIFF/AVIF 等 Pillow 也能打开的
 *    栅格格式。`metadata.exif` 是带 "Exif\0\0" 前缀或直接以 TIFF 头开始的
 *    Buffer，统一交给下方 TIFF IFD 解析器。
 * 2. 纯 JS 的 ISO-BMFF（HEIC/HEIF）解析器：读取顶层 meta 盒 → iinf 找到
 *    `Exif` 项 → iloc 定位数据 → 4 字节 TIFF 头偏移 → TIFF IFD 解析。
 *    这样即使 sharp 的预编译 libvips 不支持 HEVC 像素解码，也仍能读到 EXIF。
 *
 * 解析规则与 历史 Python v4.1 参考实现 完全一致：
 * - 标签优先级 306 (DateTime) > 36867 (DateTimeOriginal) > 36868 (DateTimeDigitized)；
 * - 每个标签先在主 IFD（root）后找 EXIF 子 IFD（0x8769）；
 * - 日期文本使用 `_EXIF_DATE_PATTERN` 的宽松分隔符与前缀匹配规则；
 * - 坏文件返回 null 并附带 error 信息，绝不抛异常（与 Python 的逐文件隔离一致）。
 */

import fs from "node:fs";

import { HEIF_EXTENSIONS, inspectHeifSignature } from "./image-support.js";
import { dateToParts, isValidDate } from "./time.js";

/** EXIF 标签编号：优先级与原 Dart 版一致。 */
export const EXIF_DATE_TAGS = Object.freeze([306, 36867, 36868]);
/** EXIF 子 IFD 指针。 */
export const EXIF_IFD_POINTER = 34665;
/** Orientation 标签。 */
export const EXIF_ORIENTATION_TAG = 274;

/**
 * 与 Python `_EXIF_DATE_PATTERN` 完全相同的正则。
 * `re.match` 是前缀匹配（不使用 `$`），因此允许后续时区/小数秒文本。
 */
export const EXIF_DATE_PATTERN = new RegExp(
  "^\\s*(?<year>[0-9]{4})\\s*[:/\\\\.\\-]\\s*" +
    "(?<month>[0-9]{1,2})\\s*[:/\\\\.\\-]\\s*" +
    "(?<day>[0-9]{1,2})" +
    "(?:[ T]\\s*(?<hour>[0-9]{1,2})" +
    "(?:\\s*:\\s*(?<minute>[0-9]{1,2})" +
    "(?:\\s*:\\s*(?<second>[0-9]{1,2}))?)?)?",
  "u",
);

const TIFF_TYPE_SIZES = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};
// Pillow 对 ASCII/UNDEFINED/BYTE 标签会返回可直接解码的 bytes，其余数值类型
// 即使被强转成 str() 也几乎不可能匹配日期正则，故只解码这三类。
const EXIF_TEXT_TYPES = new Set([1, 2, 7]);
const MAX_IFD_ENTRIES = 4096;
const MAX_EXIF_TEXT_BYTES = 4096;
const MAX_META_BOX_BYTES = 64 * 1024 * 1024;
const MAX_BOX_SCAN = 10000;
// TIFF 把 EXIF 标签直接放在 IFD0 中（不是 APP1/eXIf 块），sharp 的
// metadata.exif 为 null，需要直接解析文件头；为避免读入超大文件设置上限。
const MAX_DIRECT_TIFF_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 文本与日期解析（与 date_extractors 的 _coerce_exif_text/_parse_exif_datetime 一致）
// ---------------------------------------------------------------------------

let utf8FatalDecoder = null;

/**
 * 把 EXIF 可能返回的 bytes/字符串值整理为可解析文本。
 *
 * 对应 Python `_coerce_exif_text`：bytes 依次尝试 utf-8/ascii/latin-1
 * （后两者在本实现中等价：非 UTF-8 时直接按 latin-1 解码）。
 */
export function coerceExifText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  let text;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    try {
      if (utf8FatalDecoder === null) {
        utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });
      }
      text = utf8FatalDecoder.decode(bytes);
    } catch {
      text = bytes.toString("latin1");
    }
  } else if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value)) {
    // 近似 Python 的 str(tuple)：(1, 2, 3)。该路径不会匹配日期正则。
    text = `(${value.map((item) => String(item)).join(", ")})`;
  } else {
    text = String(value);
  }
  text = text.trim();
  text = text.replace(/^[\x00]+|[\x00]+$/g, "");
  text = text.trim();
  return text || null;
}

/**
 * 由 EXIF 各字段构造严格校验的本地 Date（对应 Python datetime(...) 的 ValueError 行为）。
 * 使用 setFullYear 以正确处理 1..99 这样的大整数年份。
 */
function localDateFromFields(year, month, day, hour, minute, second) {
  if (year < 1 || year > 9999) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  if (!isValidDate(date)) {
    return null;
  }
  const check = dateToParts(date);
  if (
    check.year !== year ||
    check.month !== month ||
    check.day !== day ||
    check.hour !== hour ||
    check.minute !== minute ||
    check.second !== second
  ) {
    return null;
  }
  return date;
}

/**
 * 解析常见 EXIF 日期，并兼容原版接受的多种日期分隔符。
 * 解析失败返回 null（对应 Python `_parse_exif_datetime`）。
 *
 * @param {string|Buffer|Uint8Array|null} value
 * @returns {Date|null}
 */
export function parseExifDateTime(value) {
  const text = coerceExifText(value);
  if (text === null) {
    return null;
  }
  const match = EXIF_DATE_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const groups = match.groups ?? {};
  const year = Number.parseInt(groups.year ?? "", 10);
  const month = Number.parseInt(groups.month ?? "", 10);
  const day = Number.parseInt(groups.day ?? "", 10);
  const hour = groups.hour === undefined ? 0 : Number.parseInt(groups.hour, 10);
  const minute = groups.minute === undefined ? 0 : Number.parseInt(groups.minute, 10);
  const second = groups.second === undefined ? 0 : Number.parseInt(groups.second, 10);
  if (![year, month, day, hour, minute, second].every((item) => Number.isFinite(item))) {
    return null;
  }
  return localDateFromFields(year, month, day, hour, minute, second);
}

// ---------------------------------------------------------------------------
// TIFF IFD 解析
// ---------------------------------------------------------------------------

function readU16(buffer, position, littleEndian) {
  if (position < 0 || position + 2 > buffer.length) {
    return null;
  }
  return littleEndian ? buffer.readUInt16LE(position) : buffer.readUInt16BE(position);
}

function readU32(buffer, position, littleEndian) {
  if (position < 0 || position + 4 > buffer.length) {
    return null;
  }
  return littleEndian ? buffer.readUInt32LE(position) : buffer.readUInt32BE(position);
}

/** 在可能带 "Exif\0\0" 前缀的 Buffer 中定位 TIFF 头；找不到返回 -1。 */
export function locateTiffHeader(buffer) {
  if (!buffer || buffer.length < 8) {
    return -1;
  }
  const isTiffAt = (offset) => {
    if (offset < 0 || offset + 8 > buffer.length) {
      return false;
    }
    const first = buffer[offset];
    const second = buffer[offset + 1];
    if (first === 0x49 && second === 0x49) {
      return readU16(buffer, offset + 2, true) === 42;
    }
    if (first === 0x4d && second === 0x4d) {
      return readU16(buffer, offset + 2, false) === 42;
    }
    return false;
  };
  if (isTiffAt(0)) {
    return 0;
  }
  if (buffer.length > 6 && buffer.toString("latin1", 0, 6) === "Exif\u0000\u0000" && isTiffAt(6)) {
    return 6;
  }
  for (const needle of [
    Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a]),
  ]) {
    const offset = buffer.indexOf(needle);
    if (offset >= 0 && isTiffAt(offset)) {
      return offset;
    }
  }
  return -1;
}

/**
 * 扫描单个 IFD，收集日期文本标签、Orientation 与 EXIF 子 IFD 指针。
 * 所有越界/坏偏移都会安全跳过（对应 Pillow 的容错行为）。
 */
function scanIfd(buffer, tiffStart, ifdOffset, littleEndian) {
  const output = {
    texts: new Map(),
    orientation: null,
    childOffsets: [],
  };
  if (ifdOffset === null || ifdOffset < 0) {
    return output;
  }
  const ifdPosition = tiffStart + ifdOffset;
  if (ifdPosition + 2 > buffer.length) {
    return output;
  }
  const entryCount = readU16(buffer, ifdPosition, littleEndian);
  if (entryCount === null || entryCount > MAX_IFD_ENTRIES) {
    return output;
  }
  for (let index = 0; index < entryCount; index += 1) {
    const entryPosition = ifdPosition + 2 + index * 12;
    if (entryPosition + 12 > buffer.length) {
      break;
    }
    const tag = readU16(buffer, entryPosition, littleEndian);
    const type = readU16(buffer, entryPosition + 2, littleEndian);
    const count = readU32(buffer, entryPosition + 4, littleEndian);
    if (tag === null || type === null || count === null) {
      break;
    }
    const typeSize = TIFF_TYPE_SIZES[type] ?? 0;
    if (typeSize === 0 || count > 1_000_000) {
      continue;
    }
    const byteLength = typeSize * count;
    let valuePosition;
    if (byteLength <= 4) {
      valuePosition = entryPosition + 8;
    } else {
      const relative = readU32(buffer, entryPosition + 8, littleEndian);
      valuePosition = relative === null ? null : tiffStart + relative;
    }
    if (valuePosition === null || valuePosition < 0 || valuePosition > buffer.length) {
      continue;
    }
    const available = Math.min(byteLength, buffer.length - valuePosition);

    if (EXIF_DATE_TAGS.includes(tag)) {
      if (!EXIF_TEXT_TYPES.has(type) || output.texts.has(tag)) {
        continue;
      }
      const raw = buffer.subarray(
        valuePosition,
        valuePosition + Math.min(available, MAX_EXIF_TEXT_BYTES),
      );
      const text = coerceExifText(raw);
      if (text !== null) {
        output.texts.set(tag, text);
      }
    } else if (tag === EXIF_ORIENTATION_TAG) {
      let orientation = null;
      if (type === 3) {
        orientation = readU16(buffer, valuePosition, littleEndian);
      } else if (type === 4) {
        orientation = readU32(buffer, valuePosition, littleEndian);
      } else if (type === 1 && available >= 1) {
        orientation = buffer[valuePosition];
      }
      if (orientation !== null && Number.isInteger(orientation)) {
        output.orientation = orientation;
      }
    } else if (tag === EXIF_IFD_POINTER) {
      if (type !== 4 && type !== 13) {
        continue;
      }
      for (let item = 0; item < Math.min(count, 8); item += 1) {
        const offset = readU32(buffer, valuePosition + item * 4, littleEndian);
        if (offset !== null && offset > 0) {
          output.childOffsets.push(offset);
        }
      }
    }
  }
  return output;
}

/**
 * 解析一段 TIFF（可带 "Exif\0\0" 前缀）。
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{tiffOffset: number, mappings: Map<number,string>[], orientation: number|null, error: string|null}}
 *   - `mappings[0]` 是主 IFD；`mappings[1]` 是 EXIF 子 IFD（存在时）；
 *     顺序与 Python `_exif_mappings` 的“主 IFD 优先”一致。
 */
export function parseTiffExif(buffer) {
  const result = { tiffOffset: -1, mappings: [], orientation: null, error: null };
  try {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
    if (data.length < 8) {
      result.error = "EXIF 数据过短";
      return result;
    }
    const tiffOffset = locateTiffHeader(data);
    if (tiffOffset < 0) {
      result.error = "未找到 TIFF 头";
      return result;
    }
    result.tiffOffset = tiffOffset;
    const littleEndian = data[tiffOffset] === 0x49;
    if (readU16(data, tiffOffset + 2, littleEndian) !== 42) {
      result.error = "TIFF 魔数无效";
      return result;
    }
    const firstIfdOffset = readU32(data, tiffOffset + 4, littleEndian);
    if (firstIfdOffset === null) {
      result.error = "TIFF IFD 偏移无效";
      return result;
    }

    const root = scanIfd(data, tiffOffset, firstIfdOffset, littleEndian);
    result.mappings.push(root.texts);
    result.orientation = root.orientation;
    if (root.childOffsets.length > 0) {
      const childTexts = new Map();
      let childOrientation = null;
      for (const childOffset of root.childOffsets) {
        const child = scanIfd(data, tiffOffset, childOffset, littleEndian);
        for (const [tag, text] of child.texts.entries()) {
          if (!childTexts.has(tag)) {
            childTexts.set(tag, text);
          }
        }
        if (childOrientation === null && child.orientation !== null) {
          childOrientation = child.orientation;
        }
      }
      result.mappings.push(childTexts);
      if (result.orientation === null) {
        result.orientation = childOrientation;
      }
    }
    return result;
  } catch (error) {
    result.error = String(error?.message ?? error);
    return result;
  }
}

/**
 * 按 Python exif_extractor 的优先级从 TIFF 解析结果中选日期：
 * 对每个标签 306→36867→36868，依次检查主 IFD、EXIF 子 IFD。
 */
export function pickExifDate(tiff) {
  const mappings = tiff?.mappings ?? [];
  for (const tag of EXIF_DATE_TAGS) {
    for (const mapping of mappings) {
      const text = mapping.get(tag);
      if (text === undefined) {
        continue;
      }
      const value = parseExifDateTime(text);
      if (value !== null) {
        return { value, tag, text };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HEIC/HEIF ISO-BMFF 容器中的 Exif 项
// ---------------------------------------------------------------------------

function readAt(descriptor, position, length) {
  if (!Number.isInteger(position) || !Number.isInteger(length) || position < 0 || length < 0) {
    throw new Error("读取位置越界");
  }
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const read = fs.readSync(descriptor, buffer, total, length - total, position + total);
    if (read <= 0) {
      break;
    }
    total += read;
  }
  return total === length ? buffer : buffer.subarray(0, total);
}

/** 遍历文件顶层的 ISO BMFF 盒；visitor 返回 false 提前结束。 */
function scanTopLevelBoxes(descriptor, fileSize, visitor) {
  let position = 0;
  let guard = 0;
  while (position + 8 <= fileSize && guard < MAX_BOX_SCAN) {
    guard += 1;
    const header = readAt(descriptor, position, 16);
    if (header.length < 8) {
      break;
    }
    let size = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) {
        break;
      }
      size = Number(header.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - position;
    }
    if (size < headerSize || position + size > fileSize) {
      break;
    }
    const box = {
      type,
      start: position,
      end: position + size,
      contentStart: position + headerSize,
      size,
    };
    if (visitor(box) === false) {
      return;
    }
    position += size;
  }
}

/** 解析内存 Buffer 中一段连续盒；返回盒描述数组。 */
function parseBufferBoxes(buffer, start, end) {
  const boxes = [];
  let position = start;
  let guard = 0;
  while (position + 8 <= end && guard < MAX_BOX_SCAN) {
    guard += 1;
    let size = buffer.readUInt32BE(position);
    const type = buffer.toString("latin1", position + 4, position + 8);
    let headerSize = 8;
    if (size === 1) {
      if (position + 16 > end) {
        break;
      }
      size = Number(buffer.readBigUInt64BE(position + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - position;
    }
    if (size < headerSize || position + size > end) {
      break;
    }
    boxes.push({
      type,
      start: position,
      end: position + size,
      contentStart: position + headerSize,
      size,
    });
    position += size;
  }
  return boxes;
}

/** 解析 iinf 盒，返回 item_ID → item_type 映射。 */
function parseItemInfo(buffer) {
  const items = new Map();
  if (buffer === null || buffer.length < 8) {
    return items;
  }
  const version = buffer[0];
  let position = 4;
  const entryCount = version === 0
    ? readU16(buffer, position, false)
    : readU32(buffer, position, false);
  if (entryCount === null) {
    return items;
  }
  position += version === 0 ? 2 : 4;
  for (const box of parseBufferBoxes(buffer, position, buffer.length)) {
    if (box.type !== "infe") {
      continue;
    }
    const content = buffer.subarray(box.contentStart, box.end);
    if (content.length < 8) {
      continue;
    }
    const infeVersion = content[0];
    if (infeVersion < 2) {
      // version 0/1 没有 item_type 字段，HEIF Exif 项使用 version>=2。
      continue;
    }
    let cursor = 4;
    const itemId = infeVersion >= 3
      ? readU32(content, cursor, false)
      : readU16(content, cursor, false);
    cursor += infeVersion >= 3 ? 4 : 2;
    if (itemId === null) {
      continue;
    }
    cursor += 2; // item_protection_index
    if (cursor + 4 > content.length) {
      continue;
    }
    const itemType = content.toString("latin1", cursor, cursor + 4);
    items.set(itemId, itemType);
  }
  return items;
}

/** 解析 iloc 盒，返回 item_ID → {method, baseOffset, extents} 映射。 */
function parseItemLocations(buffer) {
  const locations = new Map();
  if (buffer === null || buffer.length < 8) {
    return locations;
  }
  const version = buffer[0];
  let position = 4;
  const sizes = buffer[position];
  position += 1;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 0x0f;
  const baseAndIndex = buffer[position];
  position += 1;
  const baseOffsetSize = baseAndIndex >> 4;
  const indexSize = version === 1 || version === 2 ? baseAndIndex & 0x0f : 0;
  const itemCount = version < 2
    ? readU16(buffer, position, false)
    : readU32(buffer, position, false);
  if (itemCount === null) {
    return locations;
  }
  position += version < 2 ? 2 : 4;

  const readUnsigned = (size) => {
    if (size === 0) {
      return 0;
    }
    if (position + size > buffer.length) {
      throw new Error("iloc 数据越界");
    }
    let value = 0n;
    for (let index = 0; index < size; index += 1) {
      value = (value << 8n) | BigInt(buffer[position + index]);
    }
    position += size;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("iloc 偏移超出安全整数范围");
    }
    return Number(value);
  };

  for (let index = 0; index < itemCount; index += 1) {
    const itemId = version < 2
      ? readU16(buffer, position, false)
      : readU32(buffer, position, false);
    if (itemId === null) {
      break;
    }
    position += version < 2 ? 2 : 4;
    let method = 0;
    if (version === 1 || version === 2) {
      const methodField = readU16(buffer, position, false);
      if (methodField === null) {
        break;
      }
      position += 2;
      method = methodField & 0x0f;
    }
    if (position + 2 > buffer.length) {
      break;
    }
    position += 2; // data_reference_index
    const baseOffset = readUnsigned(baseOffsetSize);
    const extentCount = readU16(buffer, position, false);
    if (extentCount === null) {
      break;
    }
    position += 2;
    const extents = [];
    for (let extent = 0; extent < extentCount; extent += 1) {
      if ((version === 1 || version === 2) && indexSize > 0) {
        readUnsigned(indexSize);
      }
      extents.push({ offset: readUnsigned(offsetSize), length: readUnsigned(lengthSize) });
    }
    locations.set(itemId, { method, baseOffset, extents });
  }
  return locations;
}

/**
 * 从 HEIC/HEIF 容器中取出 Exif 项原始数据。
 *
 * @param {string} filePath
 * @returns {{exifBuffer: Buffer|null, error: Error|null}}
 */
export function readHeicExifBuffer(filePath) {
  const target = String(filePath);
  let descriptor = null;
  try {
    const stats = fs.statSync(target, { bigint: true });
    if (!stats.isFile()) {
      return { exifBuffer: null, error: null };
    }
    const fileSize = Number(stats.size);
    descriptor = fs.openSync(target, "r");

    let metaBox = null;
    let moovBox = null;
    scanTopLevelBoxes(descriptor, fileSize, (box) => {
      if (box.type === "meta") {
        metaBox = box;
        return false;
      }
      if (box.type === "moov") {
        moovBox = box;
      }
      return true;
    });
    if (metaBox === null && moovBox !== null) {
      // 少数封装器把 meta 放在 moov 里；按 Python 读容器的方式做一次兜底。
      const moovSize = moovBox.end - moovBox.contentStart;
      if (moovSize > 0 && moovSize <= MAX_META_BOX_BYTES) {
        const moovBuffer = readAt(descriptor, moovBox.contentStart, moovSize);
        const child = parseBufferBoxes(moovBuffer, 0, moovBuffer.length).find(
          (box) => box.type === "meta",
        );
        if (child !== undefined) {
          metaBox = {
            type: "meta",
            start: moovBox.contentStart + child.start,
            end: moovBox.contentStart + child.end,
            contentStart: moovBox.contentStart + child.contentStart,
            size: child.size,
          };
        }
      }
    }
    if (metaBox === null) {
      return { exifBuffer: null, error: new Error("HEIC 容器缺少 meta 盒") };
    }
    const metaSize = metaBox.end - metaBox.contentStart;
    if (metaSize <= 4 || metaSize > MAX_META_BOX_BYTES) {
      return { exifBuffer: null, error: new Error("HEIC meta 盒大小异常") };
    }
    const metaBuffer = readAt(descriptor, metaBox.contentStart, metaSize);
    const children = parseBufferBoxes(metaBuffer, 4, metaBuffer.length);
    const iinfBox = children.find((box) => box.type === "iinf");
    const ilocBox = children.find((box) => box.type === "iloc");
    if (iinfBox === undefined || ilocBox === undefined) {
      return { exifBuffer: null, error: new Error("HEIC meta 盒缺少 iinf/iloc") };
    }
    const itemTypes = parseItemInfo(
      metaBuffer.subarray(iinfBox.contentStart, iinfBox.end),
    );
    let exifItemId = null;
    for (const [itemId, itemType] of itemTypes.entries()) {
      if (itemType === "Exif") {
        exifItemId = itemId;
        break;
      }
    }
    if (exifItemId === null) {
      // 有效容器但确实没有 Exif 项：与 Pillow 打开成功但没有日期标签一致。
      return { exifBuffer: null, error: null };
    }
    const locations = parseItemLocations(
      metaBuffer.subarray(ilocBox.contentStart, ilocBox.end),
    );
    const location = locations.get(exifItemId);
    if (location === undefined) {
      return { exifBuffer: null, error: new Error("HEIC iloc 中缺少 Exif 项") };
    }
    const idatBox = children.find((box) => box.type === "idat");
    const chunks = [];
    for (const extent of location.extents) {
      let absolute;
      if (location.method === 0) {
        absolute = location.baseOffset + extent.offset;
      } else if (location.method === 1 && idatBox !== undefined) {
        absolute =
          metaBox.contentStart + idatBox.contentStart + location.baseOffset + extent.offset;
      } else {
        return {
          exifBuffer: null,
          error: new Error(`不支持的 HEIC Exif 数据构造方式：${location.method}`),
        };
      }
      if (absolute < 0 || extent.length < 0 || absolute + extent.length > fileSize) {
        return { exifBuffer: null, error: new Error("HEIC Exif 数据越界") };
      }
      chunks.push(readAt(descriptor, absolute, extent.length));
    }
    const exifBuffer = Buffer.concat(chunks);
    if (exifBuffer.length < 8) {
      return { exifBuffer: null, error: new Error("HEIC Exif 数据过短") };
    }
    // ExifDataBlock = 4 字节 TIFF 头偏移 + 数据。不同封装器对偏移基准理解
    // 不同，这里依次尝试 4+offset、offset、搜索 TIFF 头，任一命中即采用。
    const offset = exifBuffer.readUInt32BE(0);
    const isTiffAt = (position) => {
      if (position < 0 || position + 8 > exifBuffer.length) {
        return false;
      }
      const first = exifBuffer[position];
      const second = exifBuffer[position + 1];
      if (first === 0x49 && second === 0x49) {
        return exifBuffer.readUInt16LE(position + 2) === 42;
      }
      if (first === 0x4d && second === 0x4d) {
        return exifBuffer.readUInt16BE(position + 2) === 42;
      }
      return false;
    };
    if (!isTiffAt(4 + offset) && !isTiffAt(offset) && locateTiffHeader(exifBuffer) < 0) {
      return { exifBuffer: null, error: new Error("HEIC Exif 数据缺少 TIFF 头") };
    }
    return { exifBuffer, error: null };
  } catch (error) {
    return {
      exifBuffer: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // 关闭失败不影响已读取的数据。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// sharp 路径与公开 API
// ---------------------------------------------------------------------------

let sharpModulePromise = null;

/** 懒加载 sharp；失败时缓存错误而不是抛出（与 Python 的延迟导入一致的降级语义）。 */
function loadSharpModule() {
  if (sharpModulePromise === null) {
    sharpModulePromise = (async () => {
      try {
        const module = await import("sharp");
        const sharp = module.default ?? module;
        if (typeof sharp !== "function") {
          return { sharp: null, error: new Error("sharp 模块未导出可用的图像处理函数") };
        }
        return { sharp, error: null };
      } catch (error) {
        return {
          sharp: null,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    })();
  }
  return sharpModulePromise;
}

/**
 * 公开的 EXIF 读取结果（在 INTERFACES.md 约定的 {value, tag} 之外附带诊断字段，
 * 供 date-extractors 生成与 Python 一致的中文日志；调用方可以只读 value/tag）。
 *
 * @typedef {object} ExifMetadata
 * @property {Date|null} value
 * @property {number|null} tag
 * @property {string|null} text
 * @property {number|null} orientation
 * @property {string|null} format
 * @property {"sharp"|"container"|null} source
 * @property {Error|null} error
 * @property {boolean} unavailable
 * @property {import("./image-support.js").HeifSignature|null} heifSignature
 * @property {{tiffOffset: number, mappings: Map<number,string>[], orientation: number|null, error: string|null}|null} tiff
 */

function blankMetadata() {
  return {
    value: null,
    tag: null,
    text: null,
    orientation: null,
    format: null,
    source: null,
    error: null,
    unavailable: false,
    heifSignature: null,
    tiff: null,
  };
}

/** 把一段已解析 TIFF 的日期/方向写入统一结果对象。 */
function applyTiffResult(tiff, result) {
  if (tiff === null || tiff === undefined) {
    return;
  }
  result.tiff = tiff;
  if (tiff.orientation !== null) {
    result.orientation = tiff.orientation;
  }
  const found = pickExifDate(tiff);
  if (found !== null) {
    result.value = found.value;
    result.tag = found.tag;
    result.text = found.text;
  }
}

/** 把 sharp metadata 的 EXIF 解析结果写入统一结果对象。 */
function applySharpMetadata(metadata, result) {
  if (metadata === null || typeof metadata !== "object") {
    return;
  }
  result.format = metadata.format ?? result.format;
  result.source = "sharp";
  // sharp 已经把 Orientation 规范化到 metadata.orientation。
  if (typeof metadata.orientation === "number") {
    result.orientation = metadata.orientation;
  }
  if (!metadata.exif || metadata.exif.length === 0) {
    return;
  }
  applyTiffResult(parseTiffExif(metadata.exif), result);
}

/**
 * TIFF 文件的 EXIF 标签直接位于 IFD0 中，sharp 的 metadata.exif 为 null。
 * 直接把文件当作 TIFF 解析（文件本身就是一个裸 TIFF 结构），仅在文件头部
 * 可解析且体积合理时进行；找不到日期就返回 null。
 */
function readDirectTiff(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return null;
    }
    const size = Number(stats.size);
    if (size < 8 || size > MAX_DIRECT_TIFF_BYTES) {
      return null;
    }
    return parseTiffExif(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

async function trySharpMetadata(target) {
  const { sharp, error: importError } = await loadSharpModule();
  if (sharp === null) {
    return { metadata: null, error: null, unavailable: true, importError };
  }
  try {
    const metadata = await sharp(target).metadata();
    return { metadata, error: null, unavailable: false, importError: null };
  } catch (error) {
    return {
      metadata: null,
      error: error instanceof Error ? error : new Error(String(error)),
      unavailable: false,
      importError: null,
    };
  }
}

/**
 * 读取 EXIF 元数据（日期 + Orientation），永不抛异常。
 *
 * @param {string} filePath
 * @returns {Promise<ExifMetadata>}
 */
export async function readExifMetadata(filePath) {
  const target = String(filePath);
  const result = blankMetadata();
  try {
    const extension = target.slice(target.lastIndexOf(".")).toLowerCase();
    if (HEIF_EXTENSIONS.has(extension) || target.toLowerCase().endsWith(".heif")) {
      const signature = inspectHeifSignature(target);
      result.heifSignature = signature;
      if (signature.isHeif) {
        const container = readHeicExifBuffer(target);
        result.format = "heif";
        result.source = "container";
        if (container.error === null) {
          if (container.exifBuffer !== null) {
            const tiff = parseTiffExif(container.exifBuffer);
            result.tiff = tiff;
            result.orientation = tiff.orientation;
            const found = pickExifDate(tiff);
            if (found !== null) {
              result.value = found.value;
              result.tag = found.tag;
              result.text = found.text;
              return result;
            }
          }
          // 容器解析成功但没拿到可解析日期：仅当 sharp 也读不到日期时才保持
          // “无 EXIF”结论（避免容器解析器的边角遗漏导致行为退步）。
          const sharpAttempt = await trySharpMetadata(target);
          if (sharpAttempt.metadata !== null) {
            applySharpMetadata(sharpAttempt.metadata, result);
            if (result.value !== null) {
              return result;
            }
            result.source = "container";
          }
          result.error = null;
          return result;
        }
        // 容器解析失败：sharp 可能仍能打开（例如 EXT 布局差异），先兜底再报错。
        const sharpAttempt = await trySharpMetadata(target);
        if (sharpAttempt.metadata !== null) {
          applySharpMetadata(sharpAttempt.metadata, result);
          result.error = null;
          return result;
        }
        result.error = container.error;
        return result;
      }
      // 扩展名是 HEIC 但文件头不是 HEIF：交给 sharp 按内容识别（例如误命名 JPEG）。
    }

    const sharpAttempt = await trySharpMetadata(target);
    if (sharpAttempt.metadata !== null) {
      applySharpMetadata(sharpAttempt.metadata, result);
      // TIFF 把 EXIF 直接放在 IFD0，sharp metadata.exif 不可用；Python Pillow
      // 的 getexif() 仍能读到，因此这里按裸 TIFF 结构补一次解析。
      if (result.value === null && result.format === "tiff") {
        const directTiff = readDirectTiff(target);
        if (directTiff !== null) {
          applyTiffResult(directTiff, result);
          if (result.source === "sharp") {
            // 诊断字段：日期来自直接 TIFF 解析而不是 sharp 的 EXIF 块。
            result.source = "tiff";
          }
        }
      }
      return result;
    }
    if (sharpAttempt.error !== null) {
      result.error = sharpAttempt.error;
      return result;
    }
    // sharp 不可用（依赖缺失或加载失败）：由调用方决定如何诊断。
    result.unavailable = true;
    result.error = null;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error : new Error(String(error));
    return result;
  }
}

/**
 * 读取 EXIF 拍摄日期。优先级：306 (DateTime) > 36867 (DateTimeOriginal)
 * > 36868 (DateTimeDigitized)；每个标签先主 IFD 后 EXIF 子 IFD。
 * 坏文件返回 null，不抛异常。
 *
 * @param {string} filePath
 * @returns {Promise<{value: Date, tag: number, text: string}|null>}
 */
export async function readExifDate(filePath) {
  const metadata = await readExifMetadata(filePath);
  if (metadata.value === null || metadata.tag === null) {
    return null;
  }
  return { value: metadata.value, tag: metadata.tag, text: metadata.text };
}

/**
 * 读取 EXIF Orientation（用于重复预览的显示尺寸）；没有时返回 null。
 *
 * @param {string} filePath
 * @returns {Promise<number|null>}
 */
export async function readExifOrientation(filePath) {
  const metadata = await readExifMetadata(filePath);
  return metadata.orientation ?? null;
}
