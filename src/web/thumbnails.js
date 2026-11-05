/**
 * 缩略图与重复项详情服务（主线程）。
 *
 * - LRU 内存缓存：最多 200 条 / 64MB，键 = 路径 + 文件大小 + mtime + 宽高；
 * - 并发限制 4：sharp / heic-decode 的解码由原生线程池或 WASM 执行，
 *   这里限制同时解码数，避免大量缩略图请求占满线程池；
 * - duplicates.js 可能在并行移植中尚未就绪，因此延迟动态 import：
 *   模块缺失只影响缩略图接口（返回失败状态），不会让 HTTP 服务启动失败。
 *
 * 契约（docs/ARCHITECTURE.md 的 Web 架构）：
 * - GET /api/thumb?path&w&h -> 成功 image/png；失败 404 JSON
 *   { status, error, decodedFormat, rawSize, displaySize }
 * - GET /api/preview-info?path -> { path, exists, size, mtimeMs, mimeType,
 *   decodedFormat, rawSize, displaySize, frameCount, error }
 */

import fsp from "node:fs/promises";

import { resolveUserPath } from "../models.js";

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BOUNDS = [360, 240];
const MIN_BOUND = 16;
const MAX_BOUND = 4096;

let duplicatesModulePromise = null;

/** 延迟加载 duplicates.js；失败不缓存，模块就绪后下一次请求可重试。 */
function loadDuplicatesModule() {
  if (!duplicatesModulePromise) {
    duplicatesModulePromise = import("../duplicates.js").catch((error) => {
      duplicatesModulePromise = null;
      throw error;
    });
  }
  return duplicatesModulePromise;
}

function toSizePair(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const width = Math.trunc(Number(value[0]));
  const height = Math.trunc(Number(value[1]));
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return [width, height];
}

function unavailableThumbnail(error) {
  return {
    status: "unsupported",
    pngBytes: null,
    decodedFormat: null,
    rawSize: null,
    displaySize: null,
    thumbnailSize: null,
    error: `缩略图模块尚未就绪：${error?.message ?? error}`,
  };
}

function normalizeBounds(width, height) {
  const toBound = (value, fallback) => {
    const number = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.max(MIN_BOUND, Math.min(MAX_BOUND, number));
  };
  return [toBound(width, DEFAULT_BOUNDS[0]), toBound(height, DEFAULT_BOUNDS[1])];
}

/** 把 duplicates.buildThumbnail 的返回值规整成普通对象。 */
function normalizeThumbnailResult(result) {
  return {
    status: typeof result?.status === "string" ? result.status : "corrupt",
    pngBytes: result?.pngBytes ?? null,
    decodedFormat: result?.decodedFormat ?? null,
    rawSize: toSizePair(result?.rawSize),
    displaySize: toSizePair(result?.displaySize),
    thumbnailSize: toSizePair(result?.thumbnailSize),
    error: result?.error ?? null,
  };
}

/** 简单并发限制器：最多 limit 个任务同时跑。 */
class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = Math.max(1, Math.trunc(limit) || 1);
    this.active = 0;
    this.queue = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.active += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            const next = this.queue.shift();
            if (next) {
              next();
            }
          });
      };
      if (this.active < this.limit) {
        start();
      } else {
        this.queue.push(start);
      }
    });
  }
}

/**
 * GET /api/preview-info 的响应体：duplicates.inspectDuplicateFile -> 契约字段。
 */
export function serializeFileInfo(details, requestedPath) {
  const modifiedAt = details?.modifiedAt;
  let mtimeMs = null;
  if (modifiedAt instanceof Date && !Number.isNaN(modifiedAt.getTime())) {
    mtimeMs = modifiedAt.getTime();
  } else if (typeof modifiedAt === "number" && Number.isFinite(modifiedAt)) {
    mtimeMs = modifiedAt;
  }
  return {
    path: requestedPath ?? (details?.path === undefined ? null : String(details.path)),
    exists: Boolean(details?.exists),
    size: details?.sizeBytes === undefined || details?.sizeBytes === null ? null : Number(details.sizeBytes),
    mtimeMs,
    mimeType: details?.mimeType ?? null,
    decodedFormat: details?.decodedFormat ?? null,
    rawSize: toSizePair(details?.rawSize),
    displaySize: toSizePair(details?.displaySize),
    frameCount:
      details?.frameCount === undefined || details?.frameCount === null
        ? null
        : Number(details.frameCount),
    error: details?.error ?? null,
  };
}

/** 缩略图服务：LRU 缓存 + 并发限制 + 延迟加载解码模块。 */
export class ThumbnailService {
  constructor({
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    concurrency = DEFAULT_CONCURRENCY,
  } = {}) {
    this.maxEntries = Math.max(1, maxEntries);
    this.maxBytes = Math.max(1024 * 1024, maxBytes);
    this.cache = new Map();
    this.cacheBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.limiter = new ConcurrencyLimiter(concurrency);
    this.inflight = new Map();
  }

  get entryCount() {
    return this.cache.size;
  }

  clear() {
    this.cache.clear();
    this.cacheBytes = 0;
    this.inflight.clear();
  }

  #touch(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    // 重新插入以刷新 LRU 顺序。
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  #store(key, result) {
    const bytes = result?.pngBytes?.length ?? 0;
    if (bytes <= 0 || bytes > this.maxBytes) {
      return;
    }
    const existing = this.cache.get(key);
    if (existing) {
      this.cacheBytes -= existing.bytes;
      this.cache.delete(key);
    }
    this.cache.set(key, { result, bytes });
    this.cacheBytes += bytes;
    while (this.cache.size > this.maxEntries || this.cacheBytes > this.maxBytes) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.cacheBytes -= oldest?.bytes ?? 0;
    }
  }

  /**
   * 生成/读取缩略图。
   *
   * @param {string} filePath
   * @param {number|string} width
   * @param {number|string} height
   * @returns {Promise<{status:string,pngBytes:Buffer|null,decodedFormat:string|null,
   *   rawSize:number[]|null,displaySize:number[]|null,thumbnailSize:number[]|null,error:string|null}>}
   */
  async get(filePath, width, height) {
    if (filePath === undefined || filePath === null || String(filePath).trim() === "") {
      return {
        status: "missing",
        pngBytes: null,
        decodedFormat: null,
        rawSize: null,
        displaySize: null,
        thumbnailSize: null,
        error: "缺少 path 参数",
      };
    }
    const resolvedPath = resolveUserPath(String(filePath).trim());
    const bounds = normalizeBounds(width, height);

    let stat;
    try {
      stat = await fsp.stat(resolvedPath);
    } catch {
      return {
        status: "missing",
        pngBytes: null,
        decodedFormat: null,
        rawSize: null,
        displaySize: null,
        thumbnailSize: null,
        error: "文件不存在或不是普通文件",
      };
    }
    if (!stat.isFile()) {
      return {
        status: "missing",
        pngBytes: null,
        decodedFormat: null,
        rawSize: null,
        displaySize: null,
        thumbnailSize: null,
        error: "文件不存在或不是普通文件",
      };
    }

    const key = `${resolvedPath.toLowerCase()}\u0000${stat.size}\u0000${Math.round(stat.mtimeMs)}\u0000${bounds[0]}x${bounds[1]}`;
    const cached = this.#touch(key);
    if (cached) {
      this.hits += 1;
      return cached.result;
    }
    const inflight = this.inflight.get(key);
    if (inflight) {
      return inflight;
    }
    this.misses += 1;
    const promise = this.limiter
      .run(async () => {
        const duplicates = await loadDuplicatesModule();
        if (typeof duplicates.buildThumbnail !== "function") {
          throw new Error("duplicates.buildThumbnail 不存在");
        }
        return normalizeThumbnailResult(await duplicates.buildThumbnail(resolvedPath, bounds));
      })
      .then((result) => {
        if (result.status === "ready" && result.pngBytes) {
          this.#store(key, result);
        }
        return result;
      })
      .catch((error) => unavailableThumbnail(error))
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * GET /api/preview-info：文件基础属性 + 可解码图片信息。
   *
   * @param {string} filePath
   */
  async getInfo(filePath) {
    if (filePath === undefined || filePath === null || String(filePath).trim() === "") {
      throw Object.assign(new Error("缺少 path 参数。"), { code: "invalid-path" });
    }
    const resolvedPath = resolveUserPath(String(filePath).trim());
    let duplicates;
    try {
      duplicates = await loadDuplicatesModule();
    } catch (error) {
      throw Object.assign(
        new Error(`重复项详情模块尚未就绪：${error?.message ?? error}`),
        { code: "unavailable" },
      );
    }
    if (typeof duplicates.inspectDuplicateFile !== "function") {
      throw Object.assign(new Error("重复项详情模块接口缺失（inspectDuplicateFile）。"), {
        code: "unavailable",
      });
    }
    const details = await duplicates.inspectDuplicateFile(resolvedPath);
    return serializeFileInfo(details, resolvedPath);
  }
}

/** 供 server.js 共享的单例（延迟创建，便于测试替换）。 */
let sharedService = null;

export function getThumbnailService() {
  if (!sharedService) {
    sharedService = new ThumbnailService();
  }
  return sharedService;
}

export function resetThumbnailService() {
  sharedService?.clear();
  sharedService = null;
}
