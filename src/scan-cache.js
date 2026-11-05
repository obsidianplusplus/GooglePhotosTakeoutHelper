/**
 * 可持久化的媒体 SHA-256 扫描缓存（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * 缓存只把路径、大小、纳秒修改时间和已经计算出的摘要写入用户配置目录。
 * 任何缓存损坏或文件系统错误都只会退化为未命中，不影响正常扫描。
 *
 * 与 Python 的差异仅在并发原语：Node 主线程是单线程事件循环，因此不再需要
 * RLock；其余语义（纳秒级 mtime、LRU、原子写、逐项校验）保持一致。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scanCachePath } from "./constants.js";
import { expandUserPath } from "./models.js";

export const CACHE_VERSION = 1;
export const CACHE_FILE_NAME = "scan-cache-v1.json";
const MAX_CACHE_FILE_BYTES = 256 * 1024 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** 是否为 JSON 风格的普通对象。 */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 生成不解析符号链接的绝对路径键，并统一分隔符、大小写和 Unicode。
 * 对应 Python `_normalize_path`；失败时返回 null。
 */
function normalizePath(filePath) {
  if (typeof filePath !== "string") {
    return null;
  }
  try {
    const expanded = expandUserPath(filePath);
    let normalized = path.normalize(path.resolve(expanded));
    // Windows 文件路径默认不区分大小写；POSIX 必须保留大小写语义。
    if (process.platform === "win32") {
      normalized = normalized.toLowerCase();
    }
    return normalized.normalize("NFC");
  } catch {
    return null;
  }
}

/** 只接受非负普通整数，避免布尔值或字符串污染 JSON schema。 */
function coerceSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/** SHA-256 必须是恰好 64 位的小写十六进制文本。 */
function validDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/** 恢复成 BigInt；非法时返回 null。 */
function coerceBigInt(value) {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 读取文件状态；返回 {isFile, size, mtimeNs} 或 null。
 * Python 使用 st_size/st_mtime_ns；Node 需要 bigint:true 才能拿到完整纳秒。
 */
function statInfo(filePath) {
  try {
    const stats = fs.statSync(filePath, { bigint: true });
    return {
      isFile: stats.isFile(),
      size: Number(stats.size),
      mtimeNs: stats.mtimeNs,
    };
  } catch {
    return null;
  }
}

/** 按 Unicode 码位比较字符串（与 Python str 排序一致）。 */
function compareStrings(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const ca = a[index].codePointAt(0);
    const cb = b[index].codePointAt(0);
    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/**
 * 读取缓存 JSON，并把 mtime_ns/last_seen 保留为精确整数。
 * JSON.parse 会把超过 2^53 的整数舍入，因此先给这两个字段加引号再交给 BigInt。
 */
function parseCacheJson(text) {
  const prepared = text
    .replace(/("mtime_ns"\s*:\s*)(-?\d+)/g, '$1"$2"')
    .replace(/("last_seen"\s*:\s*)(-?\d+)/g, '$1"$2"');
  return JSON.parse(prepared);
}

/**
 * 按文件身份校验并持久化 SHA-256 摘要。
 *
 * ``lookup`` 每次都会重新读取文件状态；只有路径、调用方提供的大小、当前
 * ``st_size``、当前 ``st_mtime_ns`` 和合法摘要全部一致时才会命中。
 */
export class HashCache {
  /**
   * @param {string|null} filePath 默认使用用户配置目录下的 scan-cache-v1.json
   * @param {number} maxEntries
   */
  constructor(filePath = null, maxEntries = 200_000) {
    this.path = filePath === null || filePath === undefined
      ? scanCachePath()
      : String(filePath);
    const configuredLimit = Number(maxEntries);
    this.maxEntries = Math.max(
      Number.isFinite(configuredLimit) ? Math.trunc(configuredLimit) : 200_000,
      1,
    );
    this._entries = new Map();
    this._hits = 0;
    this._misses = 0;
    this._lastSeen = 0n;
    this._load();
  }

  /** 返回本实例生命周期内的命中次数。 */
  get hits() {
    return this._hits;
  }

  /** 返回本实例生命周期内的未命中次数。 */
  get misses() {
    return this._misses;
  }

  /** 返回当前内存中的有效条目数。 */
  get entryCount() {
    return this._entries.size;
  }

  /**
   * 查询摘要；文件状态或缓存字段有任何异常时均安全返回 null。
   *
   * @param {string} filePath
   * @param {number} size
   * @returns {string|null}
   */
  lookup(filePath, size) {
    const key = normalizePath(filePath);
    const expectedSize = coerceSize(size);
    if (key === null || expectedSize === null) {
      this._misses += 1;
      return null;
    }

    const current = statInfo(filePath);
    if (current === null) {
      // 文件消失时顺便清理旧键，避免以后重复访问无效条目。
      this._entries.delete(key);
      this._misses += 1;
      return null;
    }
    if (!current.isFile) {
      this._misses += 1;
      return null;
    }

    const entry = this._entries.get(key);
    if (entry === undefined) {
      this._misses += 1;
      return null;
    }
    const cacheStale = current.size !== entry.size || current.mtimeNs !== entry.mtimeNs;
    if (cacheStale) {
      this._entries.delete(key);
      this._misses += 1;
      return null;
    }
    if (expectedSize !== entry.size || !validDigest(entry.digest)) {
      this._misses += 1;
      return null;
    }

    entry.lastSeen = this._nextLastSeen();
    this._hits += 1;
    return entry.digest;
  }

  /**
   * 保存一条摘要；参数或文件状态不可信时忽略本次写入。
   *
   * @param {string} filePath
   * @param {number} size
   * @param {string} digest
   * @param {{expectedMtimeNs?: number|bigint|null}} [options]
   */
  store(filePath, size, digest, { expectedMtimeNs = null } = {}) {
    const key = normalizePath(filePath);
    const expectedSize = coerceSize(size);
    if (key === null || expectedSize === null || !validDigest(digest)) {
      return;
    }
    const current = statInfo(filePath);
    if (current === null) {
      return;
    }
    const expectedMtime = coerceBigInt(expectedMtimeNs);
    // 哈希结束后文件大小若已经变化，摘要可能对应旧内容，绝不能缓存。
    if (
      !current.isFile ||
      current.size !== expectedSize ||
      (expectedMtimeNs !== null && expectedMtimeNs !== undefined && current.mtimeNs !== expectedMtime)
    ) {
      return;
    }

    this._entries.set(key, {
      size: expectedSize,
      mtimeNs: current.mtimeNs,
      digest,
      lastSeen: this._nextLastSeen(),
    });
    this._trim();
  }

  /** 使用同目录临时文件和原子替换保存缓存；失败时静默保留内存数据。 */
  save() {
    this._trim();
    const keys = [...this._entries.keys()].sort(compareStrings);
    const pieces = keys.map((key) => {
      const entry = this._entries.get(key);
      return (
        `${JSON.stringify(key)}:{"size":${entry.size},` +
        `"mtime_ns":${entry.mtimeNs.toString()},` +
        `"digest":${JSON.stringify(entry.digest)},` +
        `"last_seen":${entry.lastSeen.toString()}}`
      );
    });
    // Python 使用 json.dump(..., ensure_ascii=False, separators=(",", ":")) 再补一个
    // 换行；这里手工拼出同样的紧凑 JSON，并保留纳秒整数的完整精度。
    const payload = `{"version":${CACHE_VERSION},"entries":{${pieces.join(",")}}}\n`;
    let temporary = null;
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      temporary = path.join(
        path.dirname(this.path),
        `.${path.basename(this.path)}.${crypto.randomUUID().replaceAll("-", "")}.tmp`,
      );
      const handle = fs.openSync(temporary, "w");
      try {
        fs.writeFileSync(handle, payload, "utf8");
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(temporary, this.path);
      temporary = null;
    } catch {
      // 缓存属于可选加速层，写入失败不能中断照片扫描。
    } finally {
      if (temporary !== null) {
        try {
          fs.unlinkSync(temporary);
        } catch {
          // 对应 Python 的 missing_ok=True。
        }
      }
    }
  }

  /** 清空内存和磁盘缓存，并返回磁盘操作是否成功。 */
  clear() {
    this._entries.clear();
    this._lastSeen = 0n;
    try {
      fs.unlinkSync(this.path);
    } catch (error) {
      // Python unlink(missing_ok=True)：文件本来不存在也算成功。
      return error?.code === "ENOENT";
    }
    return true;
  }

  /** 读取并逐项校验缓存，损坏、旧版本或 I/O 错误均按空缓存处理。 */
  _load() {
    let raw;
    try {
      const stats = fs.statSync(this.path);
      if (Number(stats.size) > MAX_CACHE_FILE_BYTES) {
        return;
      }
      raw = parseCacheJson(fs.readFileSync(this.path, "utf8"));
    } catch {
      return;
    }
    if (!isPlainObject(raw) || typeof raw.version !== "number" || !Number.isInteger(raw.version)) {
      return;
    }
    if (raw.version !== CACHE_VERSION || !isPlainObject(raw.entries)) {
      return;
    }

    const loaded = new Map();
    for (const [rawPath, value] of Object.entries(raw.entries)) {
      if (typeof rawPath !== "string" || !isPlainObject(value)) {
        continue;
      }
      const key = normalizePath(rawPath);
      const size = coerceSize(value.size);
      const mtimeNs = coerceBigInt(value.mtime_ns);
      const digest = value.digest;
      const lastSeen = coerceBigInt(value.last_seen);
      if (
        key === null ||
        size === null ||
        mtimeNs === null ||
        typeof digest !== "string" ||
        !validDigest(digest) ||
        lastSeen === null ||
        lastSeen < 0n
      ) {
        continue;
      }
      const candidate = { size, mtimeNs, digest, lastSeen };
      const existing = loaded.get(key);
      if (existing === undefined || candidate.lastSeen > existing.lastSeen) {
        loaded.set(key, candidate);
      }
    }

    this._entries = loaded;
    let newest = 0n;
    for (const entry of loaded.values()) {
      if (entry.lastSeen > newest) {
        newest = entry.lastSeen;
      }
    }
    this._lastSeen = newest;
    this._trim();
  }

  /** 生成严格递增的时间戳，避免高频访问时 LRU 顺序打平。 */
  _nextLastSeen() {
    const wallClock = BigInt(Date.now()) * 1_000_000n;
    const next = this._lastSeen + 1n;
    this._lastSeen = wallClock > next ? wallClock : next;
    return this._lastSeen;
  }

  /** 按最后使用时间移除最旧记录，并用路径处理时间戳并列。 */
  _trim() {
    const excess = this._entries.size - this.maxEntries;
    if (excess <= 0) {
      return;
    }
    const oldest = [...this._entries.entries()]
      .sort((left, right) => {
        if (left[1].lastSeen !== right[1].lastSeen) {
          return left[1].lastSeen < right[1].lastSeen ? -1 : 1;
        }
        return compareStrings(left[0], right[0]);
      })
      .slice(0, excess);
    for (const [key] of oldest) {
      this._entries.delete(key);
    }
  }
}
