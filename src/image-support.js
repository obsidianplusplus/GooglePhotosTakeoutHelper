/**
 * 图像解码能力探测、HEIF 容器签名识别与中文诊断
 * （历史 Python v4.1 参考实现 的 Node.js 移植，按 Node 的能力适配）。
 *
 * 与 Python 的对应关系：
 * - Python 用 Pillow + pillow-heif 解码；Node 用 sharp（JPEG/PNG/WebP/GIF/
 *   TIFF/AVIF/SVG 等）与 heic-decode（WASM HEIC/HEIF 解码）组合。
 * - 因此“解码器不可用”的诊断文案从 pillow-heif 改写为 heic-decode / Node
 *   图像解码器，但结构（文件头证据 + 原因 + 处理建议 + “这不表示文件损坏”）
 *   与 Python 完全一致。
 * - heic-decode 采用懒加载：缺失时只有相关格式受影响，不会在模块导入时抛错。
 */

import fs from "node:fs";
import path from "node:path";

export const HEIF_EXTENSIONS = new Set([".heic", ".heif", ".hif"]);

// ISO BMFF 中可用于标识 HEIF/HEIC 静态图像的常见品牌。这里只读取文件头，
// 不尝试解码像素，因此即使缺少 heic-decode 也能区分“缺解码器”和“文件头不符”。
const HEIF_BRAND_NAMES = [
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
];
const HEIF_BRAND_BUFFERS = HEIF_BRAND_NAMES.map((brand) => Buffer.from(brand, "latin1"));
const SIGNATURE_READ_BYTES = 256;

// sharp 能读取像素/元数据的静态栅格格式（构建相关，保守取官方支持列表）。
const SHARP_RASTER_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".jpe",
  ".jfif",
  ".png",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".avif",
  ".svg",
]);

/** 把 Node 错误整理为与 Python `str(exc)` 相似的短文本。 */
function exceptionText(error) {
  const detail = String(error?.message ?? error ?? "").trim();
  return detail || String(error?.name ?? "Error");
}

/**
 * 从 ISO BMFF 文件头得到的轻量 HEIF 识别结果（对应 Python HeifSignature）。
 */
export class HeifSignature {
  constructor(isHeif, majorBrand, compatibleBrands, error = null) {
    this.isHeif = Boolean(isHeif);
    this.majorBrand = majorBrand ?? null;
    this.compatibleBrands = Array.isArray(compatibleBrands) ? compatibleBrands : [];
    this.error = error ?? null;
    Object.freeze(this.compatibleBrands);
  }

  /** 返回最适合日志展示的品牌。 */
  get displayBrand() {
    if (this.majorBrand) {
      return this.majorBrand;
    }
    return this.compatibleBrands.length > 0 ? this.compatibleBrands[0] : null;
  }
}

/** 安全展示 ISO BMFF 四字符品牌（对应 Python `_decode_brand`）。 */
function decodeBrand(value) {
  let text = "";
  for (const byte of value) {
    text += byte < 0x80 ? String.fromCharCode(byte) : "\uFFFD";
  }
  text = text.replace(/^[\x00 ]+|[\x00 ]+$/g, "");
  return text || "未知";
}

/** 只读取文件前 N 字节；失败时抛错由调用方转成诊断。（对应 Python 128 行附近） */
function readHeaderBytes(filePath, length) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(descriptor, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * 只读文件头判断其是否为 HEIF/HEIC 容器，不解码任何图像数据。
 * 同步函数（与 Python 一致）。
 *
 * @param {string} filePath
 * @returns {HeifSignature}
 */
export function inspectHeifSignature(filePath) {
  let header;
  try {
    header = readHeaderBytes(String(filePath), SIGNATURE_READ_BYTES);
  } catch (error) {
    return new HeifSignature(false, null, [], `无法读取文件头：${exceptionText(error)}`);
  }

  // 标准 HEIF 文件以 ISO BMFF 的 ftyp box 开始。盒长度限制了解析范围，避免
  // 把后续媒体数据里偶然出现的四字节文本误判为兼容品牌。
  if (header.length < 12 || header.toString("latin1", 4, 8) !== "ftyp") {
    return new HeifSignature(false, null, []);
  }
  const boxSize = header.readUInt32BE(0);
  let brandOffset;
  let availableEnd;
  if (boxSize === 1) {
    // 扩展长度的 ftyp 很少见；当前短探针只需识别其品牌起始偏移。
    if (header.length < 20) {
      return new HeifSignature(false, null, []);
    }
    brandOffset = 16;
    const largeSize = header.readBigUInt64BE(8);
    availableEnd = largeSize > BigInt(header.length) ? header.length : Number(largeSize);
  } else {
    brandOffset = 8;
    availableEnd = Math.min(boxSize || header.length, header.length);
  }
  if (availableEnd < brandOffset + 4) {
    return new HeifSignature(false, null, []);
  }

  const majorRaw = header.subarray(brandOffset, brandOffset + 4);
  const compatibleOffset = brandOffset + 8; // 主品牌后还有 4 字节 minor version。
  const compatibleRaw = [];
  for (let offset = compatibleOffset; offset < availableEnd - 3; offset += 4) {
    compatibleRaw.push(header.subarray(offset, offset + 4));
  }
  const allBrands = [majorRaw, ...compatibleRaw];
  const isHeif = allBrands.some((brand) =>
    HEIF_BRAND_BUFFERS.some((known) => known.equals(brand)),
  );
  return new HeifSignature(
    isHeif,
    decodeBrand(majorRaw),
    compatibleRaw.map((brand) => decodeBrand(brand)),
  );
}

// ---------------------------------------------------------------------------
// 解码器懒加载（对应 Python 的 ensure_pillow_heif / 一次性注册）
// ---------------------------------------------------------------------------

let heifDecoderPromise = null;
/** @type {{available: boolean, error: Error|null}|null} */
let heifDecoderStatus = null;
let capabilitiesPromise = null;

/**
 * 最多尝试加载一次 heic-decode（WASM），并让所有调用方共享结果。
 * 插件异常不能连带禁用 sharp 的 JPEG/PNG 等原生格式，因此错误通过返回值
 * 交给调用方按具体文件说明，而不是在导入阶段向外抛出。
 *
 * @returns {Promise<{available: boolean, error: Error|null}>}
 */
export function ensureHeifDecoder() {
  if (heifDecoderPromise === null) {
    heifDecoderPromise = (async () => {
      try {
        const module = await import("heic-decode");
        const decoder = module.default ?? module;
        const available =
          typeof decoder === "function" ||
          typeof module.all === "function" ||
          typeof module.one === "function";
        if (!available) {
          throw new Error("heic-decode 模块未导出可用的解码函数");
        }
        heifDecoderStatus = { available: true, error: null };
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        heifDecoderStatus = { available: false, error: wrapped };
      }
      return heifDecoderStatus;
    })();
  }
  return heifDecoderPromise;
}

/**
 * 返回 Node 图像解码能力；sharp 与 heic-decode 均只做一次特性探测并缓存。
 *
 * 与 INTERFACES.md 的差异：额外返回 `heicError`，便于调用方给出与 Python
 * 一致的具体失败原因；原有三个字段保持不变。
 *
 * @returns {Promise<{sharp: boolean, heic: boolean, sharpError: Error|null, heicError: Error|null}>}
 */
export function getImageCapabilities() {
  if (capabilitiesPromise === null) {
    capabilitiesPromise = (async () => {
      let sharpAvailable = false;
      let sharpError = null;
      try {
        const module = await import("sharp");
        const sharp = module.default ?? module;
        sharpAvailable = typeof sharp === "function";
        if (!sharpAvailable) {
          sharpError = new Error("sharp 模块未导出可用的图像处理函数");
        }
      } catch (error) {
        sharpError = error instanceof Error ? error : new Error(String(error));
      }
      const heicStatus = await ensureHeifDecoder();
      return {
        sharp: sharpAvailable,
        heic: heicStatus.available,
        sharpError,
        heicError: heicStatus.error,
      };
    })();
  }
  return capabilitiesPromise;
}

// ---------------------------------------------------------------------------
// 中文诊断
// ---------------------------------------------------------------------------

/** 把文件头证据转换为简短中文（对应 Python `_signature_evidence`）。 */
function signatureEvidence(extension, signature) {
  if (signature.isHeif) {
    return `文件头已确认是 HEIC/HEIF（品牌 ${signature.displayBrand || "未知"}）`;
  }
  if (signature.error) {
    return `文件扩展名为 ${extension}，但${signature.error}`;
  }
  return `文件扩展名为 ${extension}，文件头未识别为 HEIC/HEIF`;
}

/**
 * 当 Node 没有可用的 HEIF 像素解码器时，返回比“文件损坏”更准确的原因。
 *
 * 该函数在 Python 中用于 EXIF 跳过诊断；Node 的 EXIF 读取由纯 JS 容器解析器
 * 完成（不依赖 heic-decode），所以本函数主要供缩略图/重复预览等像素解码
 * 场景使用，语义与 Python 保持一致。
 *
 * @param {string} filePath
 * @param {{heic: boolean, heicError?: Error|null, sharp?: boolean}|null} [capabilities]
 * @returns {string|null}
 */
export function decoderUnavailableReason(filePath, capabilities = null) {
  const target = String(filePath);
  const extension = path.extname(target).toLowerCase();
  if (!HEIF_EXTENSIONS.has(extension)) {
    return null;
  }
  const status = capabilities === null || capabilities === undefined
    ? heifDecoderStatus
    : { available: Boolean(capabilities.heic), error: capabilities.heicError ?? heifDecoderStatus?.error ?? null };
  // 尚未探测、或已经可用：与 Python “扩展名已注册”分支一致，不报不可用。
  if (status === null || status.available) {
    return null;
  }

  const signature = inspectHeifSignature(target);
  const evidence = signatureEvidence(extension, signature);
  const error = status.error;
  let cause;
  let action;
  const detail = error === null || error === undefined ? "" : exceptionText(error);
  if (error === null || error === undefined) {
    cause = "当前 Node 图像解码器不支持 HEIC/HEIF 解码";
    action = "请安装完整的项目图像依赖";
  } else if (error.code === "ERR_MODULE_NOT_FOUND") {
    cause = "当前 Node 环境未安装 heic-decode，因而无法解码 HEIC/HEIF";
    action = "请重新安装项目依赖（npm install）";
  } else if (detail.includes("heic-decode")) {
    cause = `Node 当前不支持 HEIC/HEIF 解码，因为 heic-decode 已找到但加载或注册失败：${detail}`;
    action = "请重新安装与当前 Node 版本匹配的 heic-decode";
  } else {
    cause = `Node 当前不支持 HEIC/HEIF 解码，因为 heic-decode 已找到但加载失败：${detail}`;
    action = "请重新安装与当前 Node 版本匹配的 heic-decode";
  }
  return `${evidence}；${cause}，因此无法读取。${action}。这不表示文件损坏。`;
}

/**
 * 为“已注册解码器但打开失败”的 HEIF 文件补充不武断的诊断。
 * 中文文案与 Python 逐字一致（平台差异只在“解码器”的具体指代上）。
 *
 * @param {string} filePath
 * @param {Error|unknown} error
 * @returns {string|null}
 */
export function heifDecodeFailureReason(filePath, error) {
  const target = String(filePath);
  const extension = path.extname(target).toLowerCase();
  if (!HEIF_EXTENSIONS.has(extension)) {
    return null;
  }
  const signature = inspectHeifSignature(target);
  const detail = exceptionText(error);
  if (signature.isHeif) {
    const brand = signature.displayBrand || "未知";
    return (
      `文件头已确认是 HEIC/HEIF（品牌 ${brand}），但解码器无法打开：${detail}。` +
      "可能原因是该文件使用了解码器暂不支持的编码特性、文件内容不完整，" +
      "或本机图像插件异常；不能仅凭此错误判定文件损坏"
    );
  }
  if (signature.error) {
    return `无法核验 HEIC/HEIF 文件头（${signature.error}），解码器错误：${detail}`;
  }
  return (
    `扩展名是 ${path.extname(target) || ".heic"}，但文件头不是可识别的 HEIC/HEIF ` +
    `容器；解码器错误：${detail}。可能是扩展名错误或文件内容不完整`
  );
}

/** 扩展名是否属于 HEIF 家族（不包含前导点的写法也接受）。 */
export function isHeifExtension(extension) {
  let value = String(extension ?? "").toLowerCase();
  if (value && !value.startsWith(".")) {
    value = `.${value}`;
  }
  return HEIF_EXTENSIONS.has(value);
}

/**
 * 当前环境下该扩展名是否可解码为像素。
 *
 * HEIF 在 wasm 可用时为 true（异步探测尚未完成时按“预期可用”处理，
 * 需要精确判断的调用方应先 await getImageCapabilities()）。
 *
 * @param {string} extension 带或不带前导点
 * @returns {boolean}
 */
export function isDecodableImageExtension(extension) {
  let value = String(extension ?? "").toLowerCase();
  if (value && !value.startsWith(".")) {
    value = `.${value}`;
  }
  if (SHARP_RASTER_EXTENSIONS.has(value)) {
    return true;
  }
  if (HEIF_EXTENSIONS.has(value)) {
    return heifDecoderStatus === null ? true : heifDecoderStatus.available;
  }
  return false;
}
