/**
 * 重复文件详情探测与安全缩略图生成（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * Node 的解码能力与 Pillow 不同：
 * - `sharp` 解码 JPEG/PNG/WebP/GIF/TIFF/AVIF（SVG 视构建而定），不解码 HEIC/HEIF；
 * - HEIC/HEIF 由 `heic-decode`（libheif WASM）解码为 RGBA，再交给 sharp 缩放到 PNG。
 * 因此少量“仅 Pillow 支持的格式”（如 BMP/ICO）在 Node 会返回 UNSUPPORTED，
 * 这属于 INTERFACES 允许的平台相关诊断差异，不是文件损坏。
 */

import fs from "node:fs";
import path from "node:path";

import { IMAGE_EXTENSIONS } from "./constants.js";
import { readExifOrientation } from "./exif.js";
import {
  HEIF_EXTENSIONS,
  decoderUnavailableReason,
  ensureHeifDecoder,
  heifDecodeFailureReason,
  isDecodableImageExtension,
} from "./image-support.js";
import { expandUserPath } from "./models.js";

// 限制解码后的像素数量，避免压缩率极高的图片耗尽内存。
export const MAX_THUMBNAIL_PIXELS = 80_000_000;

/** 缩略图生成结果状态（对应 Python ThumbnailStatus）。 */
export const ThumbnailStatus = Object.freeze({
  READY: "ready",
  NOT_IMAGE: "not-image",
  UNSUPPORTED: "unsupported",
  CORRUPT: "corrupt",
  MISSING: "missing",
  TOO_LARGE: "too-large",
});

/**
 * 重复项详情面板所需的只读文件信息（对应 Python DuplicateFileDetails）。
 */
export class DuplicateFileDetails {
  constructor(init = {}) {
    this.path = init.path ?? null;
    this.exists = Boolean(init.exists);
    this.sizeBytes = init.sizeBytes ?? null;
    this.modifiedAt = init.modifiedAt ?? null;
    this.mimeType = init.mimeType ?? null;
    this.declaredExtension = init.declaredExtension ?? "";
    this.decodedFormat = init.decodedFormat ?? null;
    this.rawSize = init.rawSize ?? null;
    this.displaySize = init.displaySize ?? null;
    this.frameCount = init.frameCount ?? null;
    this.error = init.error ?? null;
  }
}

/**
 * 与界面无关的缩略图结果（对应 Python ThumbnailResult）。
 */
export class ThumbnailResult {
  constructor(init = {}) {
    this.status = init.status ?? ThumbnailStatus.CORRUPT;
    this.pngBytes = init.pngBytes ?? null;
    this.decodedFormat = init.decodedFormat ?? null;
    this.rawSize = init.rawSize ?? null;
    this.displaySize = init.displaySize ?? null;
    this.thumbnailSize = init.thumbnailSize ?? null;
    this.error = init.error ?? null;
  }
}

// PNG/JPEG 等常见扩展名的 MIME 映射。Python 使用系统 mimetypes 数据库，
// 其结果随操作系统变化；这里使用标准 IANA 映射作为跨平台等价物。
const MIME_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".jfif": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".hif": "image/heif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".jxl": "image/jxl",
  ".ico": "image/x-icon",
  ".cur": "image/x-icon",
  ".dng": "image/x-adobe-dng",
  ".raw": "image/x-raw",
  ".cr2": "image/x-canon-cr2",
  ".cr3": "image/x-canon-cr3",
  ".nef": "image/x-nikon-nef",
  ".arw": "image/x-sony-arw",
  ".orf": "image/x-olympus-orf",
  ".rw2": "image/x-panasonic-rw2",
  ".pef": "image/x-pentax-pef",
  ".srw": "image/x-samsung-srw",
  ".raf": "image/x-fuji-raf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".vob": "video/dvd",
  ".ts": "video/mp2t",
  ".ogv": "video/ogg",
  ".asf": "video/x-ms-asf",
});

// 明确“无法识别内容”的 sharp/libvips 错误特征（对应 Pillow 的 UnidentifiedImageError）。
const UNIDENTIFIED_ERROR_PATTERN =
  /(unsupported image format|not a known file format|unknown file format|unrecognized image format|unable to load image|badseek)/i;
// 明确“像素过大”的错误特征（对应 Pillow 的 DecompressionBombError）。
const PIXEL_LIMIT_ERROR_PATTERN = /(exceeds pixel limit|pixel limit|decompression bomb)/i;

// sharp 与 heic-decode 延迟加载，保证依赖异常时模块本身仍可被 UI 导入。
let sharpPromise = null;
let heicDecodePromise = null;

/** 动态加载 sharp（只尝试一次）。 */
async function loadSharpModule() {
  if (sharpPromise === null) {
    sharpPromise = import("sharp").then((module) => module.default ?? module);
  }
  return sharpPromise;
}

/** 动态加载 heic-decode（只尝试一次）。 */
async function loadHeicDecoder() {
  if (heicDecodePromise === null) {
    heicDecodePromise = import("heic-decode").then((module) =>
      typeof module.default === "function" ? module.default : module,
    );
  }
  return heicDecodePromise;
}

/** 取路径最后一段（pathlib.PurePath.name 的语义）。 */
function baseName(filePath) {
  return path.basename(String(filePath));
}

/** pathlib.PurePath.suffix 的语义（最后一个点号必须在首尾之外）。 */
function pySuffix(name) {
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index) : "";
}

/** 把 UI 传入的路径转换为字符串并展开用户目录，异常值也不向外抛出。 */
function coercePath(value) {
  try {
    return expandUserPath(String(value));
  } catch {
    return String(value);
  }
}

/** Python datetime.fromtimestamp 的 Node 等价：本地时间 Date，无效返回 null。 */
function dateFromStat(stat) {
  try {
    const value = new Date(stat.mtimeMs);
    return Number.isNaN(value.getTime()) ? null : value;
  } catch {
    return null;
  }
}

/** str(exc).strip()；空时退回异常类型名（对应 Python _exception_text 风格）。 */
function exceptionText(error) {
  if (error === null || error === undefined) {
    return "";
  }
  const detail = String(error.message !== undefined ? error.message : error).trim();
  if (detail) {
    return detail;
  }
  return String(error.name ?? error);
}

/** 对应 Python `_error_text(prefix, exc)`。 */
function errorText(prefix, error) {
  const detail = exceptionText(error);
  return detail ? `${prefix}：${detail}` : prefix;
}

/** 文件系统错误（Node 的 fs 错误都带 code，对应 Python 的 OSError）。 */
function isFileSystemError(error) {
  return Boolean(error) && typeof error.code === "string";
}

/** 根据文件名猜测 MIME 类型；未知返回 null。 */
function guessMime(filePath) {
  try {
    return MIME_TYPES[pySuffix(baseName(filePath)).toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

/** 是否为“声明为图片”的文件（扩展名集合或 image/* MIME）。 */
function isDeclaredImage(filePath, mimeType) {
  const extension = pySuffix(baseName(filePath)).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) || Boolean(mimeType && mimeType.startsWith("image/"));
}

/** 对应 Python `_pixel_count`。 */
function pixelCount(size) {
  if (size === null || size === undefined) {
    return 0;
  }
  return Math.max(size[0], 0) * Math.max(size[1], 0);
}

/** 对应 Python `_too_large_message`。 */
function tooLargeMessage(size) {
  return `图片分辨率 ${size[0]}×${size[1]} 超过安全缩略图上限`;
}

/** 对应 Python `_oriented_size`：只按 EXIF Orientation 交换显示宽高。 */
function orientedSize(rawSize, orientation) {
  if (rawSize === null || rawSize === undefined) {
    return null;
  }
  return [5, 6, 7, 8].includes(orientation) ? [rawSize[1], rawSize[0]] : rawSize;
}

/** 读取 EXIF Orientation；坏文件返回 null，不抛异常。 */
async function exifOrientation(filePath) {
  try {
    return await readExifOrientation(filePath);
  } catch {
    return null;
  }
}

/**
 * 判断一个“声明为图片”的扩展名在当前 Node 环境是否有解码器。
 * 不在 IMAGE_EXTENSIONS 中的扩展名（如 .svg）交给解码器自行尝试，与 Python 一致。
 *
 * @returns {Promise<{supported: boolean, reason: string|null}>}
 */
async function extensionSupport(extension, filePath) {
  if (!IMAGE_EXTENSIONS.has(extension)) {
    return { supported: true, reason: null };
  }
  if (HEIF_EXTENSIONS.has(extension)) {
    let available = false;
    try {
      const status = await ensureHeifDecoder();
      available = Boolean(status && status.available);
    } catch {
      available = false;
    }
    if (available) {
      return { supported: true, reason: null };
    }
    const reason = decoderUnavailableReason(filePath);
    return {
      supported: false,
      reason: reason || `图像解码器当前不支持 ${extension || "该"} 图片格式`,
    };
  }
  if (!isDecodableImageExtension(extension)) {
    const reason = decoderUnavailableReason(filePath);
    return {
      supported: false,
      reason: reason || `图像解码器当前不支持 ${extension || "该"} 图片格式`,
    };
  }
  return { supported: true, reason: null };
}

/** sharp 的格式名转成 Pillow 风格大写（jpeg -> JPEG）。 */
function formatName(format) {
  return format ? String(format).toUpperCase() : null;
}

/**
 * 读取 sharp 可解码图片的头部信息。
 *
 * @returns {Promise<{decodedFormat: string|null, rawSize: [number, number], frameCount: number}>}
 */
async function sharpImageMetadata(filePath) {
  const sharp = await loadSharpModule();
  const metadata = await sharp(filePath).metadata();
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("无法识别图片内容");
  }
  return {
    decodedFormat: formatName(metadata.format),
    rawSize: [Math.trunc(width), Math.trunc(height)],
    frameCount: Math.max(Math.trunc(Number(metadata.pages ?? 1) || 1), 1),
  };
}

/**
 * 用 heic-decode 解码 HEIC/HEIF 主图像。
 *
 * @returns {Promise<{decodedFormat: string, rawSize: [number, number], frameCount: number, rgba: Uint8ClampedArray}>}
 */
async function decodeHeif(filePath) {
  const decode = await loadHeicDecoder();
  const buffer = await fs.promises.readFile(filePath);
  const image = await decode({ buffer });
  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("无法识别图片内容");
  }
  return {
    decodedFormat: "HEIF",
    rawSize: [Math.trunc(width), Math.trunc(height)],
    frameCount: 1,
    rgba: image.data,
  };
}

/** 按 EXIF Orientation 应用 sharp 变换（HEIC 原始像素没有 EXIF，需要手动应用）。 */
function applyOrientation(pipeline, orientation) {
  switch (orientation) {
    case 2:
      return pipeline.flop();
    case 3:
      return pipeline.rotate(180);
    case 4:
      return pipeline.flip();
    case 5:
      return pipeline.rotate(90).flop();
    case 6:
      return pipeline.rotate(90);
    case 7:
      return pipeline.rotate(90).flip();
    case 8:
      return pipeline.rotate(270);
    default:
      return pipeline;
  }
}

/**
 * 计算 Pillow Image.thumbnail 的最终尺寸（Pillow 12 的 preserve_aspect_ratio 语义）。
 *
 * Pillow 会在 floor/ceil 之间选择更接近原始宽高比的一个；sharp 默认的
 * fit:inside 对极端宽高比会差 1 像素，因此这里显式复刻 Python 的取整规则。
 *
 * @param {[number, number]|null} imageSize 已应用 EXIF 方向后的尺寸
 * @param {[number, number]} bounds 整数化后的边界
 * @returns {[number, number]|null} null 表示无需缩放（不放大）
 */
function pillowThumbnailSize(imageSize, bounds) {
  if (imageSize === null || imageSize === undefined) {
    return null;
  }
  const [width, height] = imageSize;
  const providedWidth = Math.floor(bounds[0]);
  const providedHeight = Math.floor(bounds[1]);
  if (providedWidth >= width && providedHeight >= height) {
    return null;
  }
  const aspect = width / height;
  const roundAspect = (number, key) => {
    const low = Math.floor(number);
    const high = Math.ceil(number);
    const candidate = key(low) <= key(high) ? low : high;
    return Math.max(candidate, 1);
  };
  if (providedWidth / providedHeight >= aspect) {
    return [
      roundAspect(providedHeight * aspect, (n) => Math.abs(aspect - n / providedHeight)),
      providedHeight,
    ];
  }
  return [
    providedWidth,
    roundAspect(providedWidth / aspect, (n) =>
      n === 0 ? 0 : Math.abs(aspect - providedWidth / n),
    ),
  ];
}

/** 生成 sharp 管道：方向 -> Pillow 等价缩放 -> PNG。 */
function thumbnailPipeline(pipeline, bounds, imageSize) {
  const target = pillowThumbnailSize(imageSize, bounds);
  let output = pipeline;
  if (target !== null) {
    // fit: "fill" 才能强制得到 Pillow 选出的精确尺寸（差异至多 1 像素）。
    output = output.resize({ width: target[0], height: target[1], fit: "fill" });
  }
  return output.png({ compressionLevel: 9 });
}

/** 对应 Python `_normalize_bounds`。 */
function normalizeBounds(bounds) {
  try {
    let width;
    let height;
    if (Array.isArray(bounds) || (bounds !== null && typeof bounds === "object" && "length" in bounds)) {
      width = bounds[0];
      height = bounds[1];
    } else {
      return null;
    }
    const widthValue = coercePositiveInt(width);
    const heightValue = coercePositiveInt(height);
    if (widthValue === null || heightValue === null) {
      return null;
    }
    return [widthValue, heightValue];
  } catch {
    return null;
  }
}

/** Python int() 语义的近似：接受整数数字、整数文本与布尔值。 */
function coercePositiveInt(value) {
  let number;
  if (typeof value === "boolean") {
    number = value ? 1 : 0;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    number = Math.trunc(value);
  } else if (typeof value === "bigint") {
    number = Number(value);
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) {
      return null;
    }
    number = Number.parseInt(text, 10);
  } else {
    return null;
  }
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** 构造一个失败状态的 ThumbnailResult。 */
function thumbnailError(status, error, extra = {}) {
  return new ThumbnailResult({ status, pngBytes: null, error, ...extra });
}

/** 判断异常是否代表“像素过大”。 */
function isPixelLimitError(error) {
  return PIXEL_LIMIT_ERROR_PATTERN.test(exceptionText(error));
}

/** 判断异常是否代表“无法识别图片内容”。 */
function isUnidentifiedError(error) {
  return UNIDENTIFIED_ERROR_PATTERN.test(exceptionText(error));
}

/**
 * 读取一个重复文件的基础属性和可用图片信息，任何错误都转为结果字段。
 *
 * @param {string|import("node:path").PathLike} filePath
 * @returns {Promise<DuplicateFileDetails>}
 */
export async function inspectDuplicateFile(filePath) {
  const file = coercePath(filePath);
  const mimeType = guessMime(file);
  const extension = pySuffix(baseName(file)).toLowerCase();
  let exists = false;
  let sizeBytes = null;
  let modifiedAt = null;

  try {
    exists = fs.existsSync(file);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    if (stat === null || !stat.isFile()) {
      const message = exists ? "路径不是普通文件" : "文件不存在";
      return new DuplicateFileDetails({
        path: file,
        exists,
        mimeType,
        declaredExtension: extension,
        error: message,
      });
    }
    sizeBytes = stat.size;
    modifiedAt = dateFromStat(stat);
  } catch (error) {
    return new DuplicateFileDetails({
      path: file,
      exists,
      sizeBytes,
      modifiedAt,
      mimeType,
      declaredExtension: extension,
      error: errorText("读取文件属性失败", error),
    });
  }

  if (!isDeclaredImage(file, mimeType)) {
    return new DuplicateFileDetails({
      path: file,
      exists: true,
      sizeBytes,
      modifiedAt,
      mimeType,
      declaredExtension: extension,
    });
  }

  let sharp = null;
  try {
    sharp = await loadSharpModule();
  } catch (error) {
    return new DuplicateFileDetails({
      path: file,
      exists: true,
      sizeBytes,
      modifiedAt,
      mimeType,
      declaredExtension: extension,
      error: errorText("图像解码器（sharp）不可用", error),
    });
  }
  const support = await extensionSupport(extension, file);
  if (!support.supported) {
    return new DuplicateFileDetails({
      path: file,
      exists: true,
      sizeBytes,
      modifiedAt,
      mimeType,
      declaredExtension: extension,
      error: support.reason,
    });
  }

  try {
    let decodedFormat = null;
    let rawSize = null;
    let frameCount = null;
    if (HEIF_EXTENSIONS.has(extension)) {
      const decoded = await decodeHeif(file);
      decodedFormat = decoded.decodedFormat;
      rawSize = decoded.rawSize;
      frameCount = decoded.frameCount;
    } else {
      const metadata = await sharpImageMetadata(file);
      decodedFormat = metadata.decodedFormat;
      rawSize = metadata.rawSize;
      frameCount = metadata.frameCount;
    }
    const orientation = await exifOrientation(file);
    const displaySize = orientedSize(rawSize, orientation);
    const error =
      pixelCount(rawSize) > MAX_THUMBNAIL_PIXELS ? tooLargeMessage(rawSize) : null;
    return new DuplicateFileDetails({
      path: file,
      exists: true,
      sizeBytes,
      modifiedAt,
      mimeType,
      declaredExtension: extension,
      decodedFormat,
      rawSize,
      displaySize,
      frameCount,
      error,
    });
  } catch (error) {
    return new DuplicateFileDetails({
      path: file,
      exists: true,
      sizeBytes,
      modifiedAt,
      mimeType,
      declaredExtension: extension,
      error: inspectDecodeErrorText(file, extension, error),
    });
  }
}

/** inspect 阶段的解码错误文本（对应 Python 三个 except 分支）。 */
function inspectDecodeErrorText(filePath, extension, error) {
  if (HEIF_EXTENSIONS.has(extension)) {
    const heifReason = heifDecodeFailureReason(filePath, error);
    if (heifReason) {
      return heifReason;
    }
  }
  if (isPixelLimitError(error)) {
    return errorText("图片像素过大，已拒绝解码", error);
  }
  if (isUnidentifiedError(error)) {
    return errorText("无法识别图片内容", error);
  }
  return errorText("无法解码图片", error);
}

/**
 * 生成保持比例且不放大的 PNG 缩略图，失败时返回可展示的状态。
 *
 * @param {string} filePath
 * @param {[number, number]|number[]} bounds
 * @returns {Promise<ThumbnailResult>}
 */
export async function buildThumbnail(filePath, bounds = [360, 240]) {
  const file = coercePath(filePath);
  const normalizedBounds = normalizeBounds(bounds);
  if (normalizedBounds === null) {
    return thumbnailError(ThumbnailStatus.CORRUPT, "缩略图尺寸必须是两个正整数");
  }
  let stat = null;
  let statError = null;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    statError = error;
  }
  if (statError !== null) {
    // Python pathlib 的 is_file() 对不存在/不可访问路径返回 False，不抛异常；
    // 只有非文件系统异常才会进入“无法访问文件”诊断分支。
    return thumbnailError(
      ThumbnailStatus.MISSING,
      isFileSystemError(statError)
        ? "文件不存在或不是普通文件"
        : errorText("无法访问文件", statError),
    );
  }
  if (!stat.isFile()) {
    return thumbnailError(ThumbnailStatus.MISSING, "文件不存在或不是普通文件");
  }

  const mimeType = guessMime(file);
  const extension = pySuffix(baseName(file)).toLowerCase();
  if (!isDeclaredImage(file, mimeType)) {
    return thumbnailError(ThumbnailStatus.NOT_IMAGE, "该文件不是受支持的图片");
  }

  let sharp = null;
  try {
    sharp = await loadSharpModule();
  } catch (error) {
    return thumbnailError(
      ThumbnailStatus.UNSUPPORTED,
      errorText("图像解码器（sharp）不可用", error) || "图像解码器不可用",
    );
  }
  const support = await extensionSupport(extension, file);
  if (!support.supported) {
    return thumbnailError(ThumbnailStatus.UNSUPPORTED, support.reason || "图像解码器不可用");
  }

  let decodedFormat = null;
  let rawSize = null;
  let displaySize = null;
  try {
    if (HEIF_EXTENSIONS.has(extension)) {
      const decoded = await decodeHeif(file);
      decodedFormat = decoded.decodedFormat;
      rawSize = decoded.rawSize;
      const orientation = await exifOrientation(file);
      displaySize = orientedSize(rawSize, orientation);
      if (pixelCount(rawSize) > MAX_THUMBNAIL_PIXELS) {
        return new ThumbnailResult({
          status: ThumbnailStatus.TOO_LARGE,
          decodedFormat,
          rawSize,
          displaySize,
          error: tooLargeMessage(rawSize),
        });
      }
      const rgba = decoded.rgba;
      const source = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      let pipeline = sharp(source, {
        raw: { width: rawSize[0], height: rawSize[1], channels: 4 },
      });
      pipeline = applyOrientation(pipeline, orientation);
      const output = await thumbnailPipeline(pipeline, normalizedBounds, displaySize).toBuffer({
        resolveWithObject: true,
      });
      return new ThumbnailResult({
        status: ThumbnailStatus.READY,
        pngBytes: output.data,
        decodedFormat,
        rawSize,
        displaySize,
        thumbnailSize: [output.info.width, output.info.height],
      });
    }

    const metadata = await sharpImageMetadata(file);
    decodedFormat = metadata.decodedFormat;
    rawSize = metadata.rawSize;
    const orientation = await exifOrientation(file);
    displaySize = orientedSize(rawSize, orientation);
    if (pixelCount(rawSize) > MAX_THUMBNAIL_PIXELS) {
      return new ThumbnailResult({
        status: ThumbnailStatus.TOO_LARGE,
        decodedFormat,
        rawSize,
        displaySize,
        error: tooLargeMessage(rawSize),
      });
    }
    // 动画只使用第一帧（sharp 默认只读第一页）；rotate() 自动应用 EXIF 方向。
    let pipeline = sharp(file).rotate();
    const output = await thumbnailPipeline(pipeline, normalizedBounds, displaySize).toBuffer({
      resolveWithObject: true,
    });
    return new ThumbnailResult({
      status: ThumbnailStatus.READY,
      pngBytes: output.data,
      decodedFormat,
      rawSize,
      displaySize,
      thumbnailSize: [output.info.width, output.info.height],
    });
  } catch (error) {
    if (HEIF_EXTENSIONS.has(extension)) {
      const heifReason = heifDecodeFailureReason(file, error);
      if (heifReason) {
        return new ThumbnailResult({
          status: ThumbnailStatus.UNSUPPORTED,
          decodedFormat,
          rawSize,
          displaySize,
          error: heifReason,
        });
      }
    }
    if (isPixelLimitError(error)) {
      return new ThumbnailResult({
        status: ThumbnailStatus.TOO_LARGE,
        decodedFormat,
        rawSize,
        displaySize,
        error: errorText("图片像素过大，已拒绝解码", error),
      });
    }
    if (isUnidentifiedError(error)) {
      return new ThumbnailResult({
        status: ThumbnailStatus.CORRUPT,
        decodedFormat,
        rawSize,
        displaySize,
        error: errorText("无法识别图片内容", error),
      });
    }
    return new ThumbnailResult({
      status: ThumbnailStatus.CORRUPT,
      decodedFormat,
      rawSize,
      displaySize,
      error: errorText("生成缩略图失败", error),
    });
  }
}

/** 显式异步别名（供 Web 后端按需使用，与 INTERFACES 的异步签名一致）。 */
export const inspectDuplicateFileAsync = inspectDuplicateFile;
export const buildThumbnailAsync = buildThumbnail;

export default {
  MAX_THUMBNAIL_PIXELS,
  ThumbnailStatus,
  DuplicateFileDetails,
  ThumbnailResult,
  inspectDuplicateFile,
  buildThumbnail,
  inspectDuplicateFileAsync,
  buildThumbnailAsync,
};
