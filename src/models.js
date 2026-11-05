/**
 * 处理引擎使用的数据模型与选项（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * 设计约定（所有移植模块必须遵守）：
 * - 路径使用普通字符串；需要文件系统对象的调用方自行 path.dirname() 等；
 * - 字符串枚举用 Object.freeze 的常量表表示，比较一律使用 ===；
 * - 拍摄日期使用“本地墙上时间”的 Date 对象（见 time.js）；
 * - 记录中的多个来源位置使用 Map，键为相册名（string）或 null（时间线）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CancelledError } from "./async-utils.js";
import {
  DEFAULT_ALL_PHOTOS_FOLDER,
  DEFAULT_HASH_CHUNK_SIZE,
  DEFAULT_MAX_EXIF_BYTES,
  DEFAULT_UNKNOWN_DATE_FOLDER,
} from "./constants.js";
import { formatLocalIso } from "./time.js";

export { CancelledError };

/** 配置/输入不合法；CLI 映射为退出码 11。 */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/** 输入目录没有可处理的媒体；CLI 映射为退出码 13。 */
export class InputNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputNotFoundError";
  }
}

/** 构造字符串枚举常量表。 */
function stringEnum(values) {
  const target = {};
  for (const value of values) {
    target[value.toUpperCase().replaceAll("-", "_")] = value;
  }
  return Object.freeze(target);
}

export const OperationMode = stringEnum(["copy", "move"]);
export const AlbumMode = stringEnum(["shortcut", "duplicate-copy", "json", "nothing"]);
export const DateDivision = stringEnum(["flat", "year", "year-month"]);
export const ConflictMode = stringEnum(["rename", "skip", "overwrite"]);
export const UnknownDateMode = stringEnum(["folder", "root", "skip"]);
export const LivePhotoTarget = stringEnum(["apple", "coloros16"]);
export const LivePhotoMetadataStatus = stringEnum(["verified", "missing", "conflict", "unknown"]);
export const LivePhotoRole = stringEnum(["still", "motion"]);
export const DateSource = stringEnum(["json", "exif", "filename", "aggressive-json", "file-mtime"]);
export const ActionKind = stringEnum(["copy", "move", "shortcut", "skip"]);
export const ActionStatus = stringEnum(["planned", "success", "skipped", "failed"]);
export const Phase = stringEnum([
  "scanning",
  "deduplicating",
  "dating",
  "merging-albums",
  "planning",
  "executing",
  "fixing",
  "finished",
]);
export const DuplicateDisposition = stringEnum(["primary", "album-copy", "skipped", "filtered"]);

/** 校验枚举值，不合法时抛出 ValidationError（对应 Python Enum(...) 的 ValueError）。 */
export function enumValueOf(enumTable, value, label) {
  const allowed = Object.values(enumTable);
  if (!allowed.includes(value)) {
    throw new ValidationError(`${label} 选项无效：${String(value)}`);
  }
  return value;
}

/** 展开用户目录（~ 与 ~/xxx）。 */
export function expandUserPath(value) {
  let text = String(value ?? "");
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

/** 展开并解析为绝对路径。 */
export function resolveUserPath(value) {
  return path.resolve(expandUserPath(value));
}

/** 清理用户可编辑的单层目录名，防止意外越出输出目录。 */
export function safeFolderName(value, fallback) {
  let text = String(value ?? "").trim().replace(/^[. ]+|[. ]+$/g, "");
  if (!text) {
    return fallback;
  }
  const forbidden = '<>:"/\\|?*';
  let cleaned = "";
  for (const char of text) {
    cleaned += forbidden.includes(char) ? "_" : char;
  }
  cleaned = cleaned.slice(0, 120);
  return cleaned || fallback;
}

/** 两个路径是否表示同一目录（Windows 大小写不敏感）。 */
export function samePath(first, second) {
  const normalize = (value) => {
    const resolved = resolveUserPath(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(first) === normalize(second);
}

/**
 * 一次整理任务的完整配置（对应 Python OrganizeOptions dataclass）。
 * 构造参数同时接受驼峰和 Python 风格的蛇形键名，方便 CLI/Web API 复用。
 */
export class OrganizeOptions {
  constructor(init = {}) {
    const get = (camel, snake) => {
      if (init[camel] !== undefined) return init[camel];
      if (snake !== undefined && init[snake] !== undefined) return init[snake];
      return undefined;
    };
    const inputDir = get("inputDir", "input_dir");
    const outputDir = get("outputDir", "output_dir");
    if (inputDir === undefined || String(inputDir).trim() === "") {
      throw new ValidationError("缺少输入目录");
    }
    if (outputDir === undefined || String(outputDir).trim() === "") {
      throw new ValidationError("缺少输出目录");
    }
    this.inputDir = String(inputDir);
    this.outputDir = String(outputDir);
    this.operation = get("operation") ?? OperationMode.COPY;
    this.albumMode = get("albumMode", "album_mode") ?? AlbumMode.SHORTCUT;
    this.dateDivision = get("dateDivision", "date_division") ?? DateDivision.YEAR_MONTH;
    this.conflictMode = get("conflictMode", "conflict_mode") ?? ConflictMode.RENAME;
    this.unknownDateMode = get("unknownDateMode", "unknown_date_mode") ?? UnknownDateMode.FOLDER;
    this.skipExtras = Boolean(get("skipExtras", "skip_extras") ?? false);
    this.useJson = Boolean(get("useJson", "use_json") ?? true);
    this.useExif = Boolean(get("useExif", "use_exif") ?? true);
    this.useFilename = Boolean(get("useFilename", "use_filename") ?? true);
    this.aggressiveJson = Boolean(get("aggressiveJson", "aggressive_json") ?? true);
    this.useFileMtime = Boolean(get("useFileMtime", "use_file_mtime") ?? false);
    this.setFileMtime = Boolean(get("setFileMtime", "set_file_mtime") ?? true);
    this.scanAllIfNoTakeout = Boolean(get("scanAllIfNoTakeout", "scan_all_if_no_takeout") ?? true);
    this.includeHidden = Boolean(get("includeHidden", "include_hidden") ?? false);
    this.writeReport = Boolean(get("writeReport", "write_report") ?? true);
    this.useHashCache = Boolean(get("useHashCache", "use_hash_cache") ?? true);
    this.recognizeLivePhotos = Boolean(get("recognizeLivePhotos", "recognize_live_photos") ?? false);
    this.livePhotoTarget = get("livePhotoTarget", "live_photo_target") ?? LivePhotoTarget.APPLE;
    this.correctDateFilenames = Boolean(
      get("correctDateFilenames", "correct_date_filenames") ?? false,
    );
    this.allPhotosFolder = get("allPhotosFolder", "all_photos_folder") ?? DEFAULT_ALL_PHOTOS_FOLDER;
    this.unknownDateFolder =
      get("unknownDateFolder", "unknown_date_folder") ?? DEFAULT_UNKNOWN_DATE_FOLDER;
    this.workers = get("workers") ?? 4;
    this.maxExifBytes = get("maxExifBytes", "max_exif_bytes") ?? DEFAULT_MAX_EXIF_BYTES;
    this.hashChunkSize = get("hashChunkSize", "hash_chunk_size") ?? DEFAULT_HASH_CHUNK_SIZE;
  }

  /** 返回路径已展开、数值已限幅的配置副本（对应 Python normalized()）。 */
  normalized() {
    const options = Object.assign(Object.create(OrganizeOptions.prototype), this);
    options.inputDir = resolveUserPath(this.inputDir);
    options.outputDir = resolveUserPath(this.outputDir);
    options.operation = enumValueOf(OperationMode, this.operation, "operation");
    options.albumMode = enumValueOf(AlbumMode, this.albumMode, "albums");
    options.dateDivision = enumValueOf(DateDivision, this.dateDivision, "divide");
    options.conflictMode = enumValueOf(ConflictMode, this.conflictMode, "conflict");
    options.unknownDateMode = enumValueOf(UnknownDateMode, this.unknownDateMode, "unknown");
    options.livePhotoTarget = enumValueOf(
      LivePhotoTarget,
      this.livePhotoTarget,
      "live-photo-target",
    );
    const workers = Number.parseInt(this.workers, 10);
    options.workers = Math.min(Math.max(Number.isFinite(workers) ? workers : 4, 1), 32);
    const chunk = Number.parseInt(this.hashChunkSize, 10);
    options.hashChunkSize = Math.max(Number.isFinite(chunk) ? chunk : DEFAULT_HASH_CHUNK_SIZE, 64 * 1024);
    const exifLimit = Number.parseInt(this.maxExifBytes, 10);
    options.maxExifBytes = Number.isFinite(exifLimit) && exifLimit >= 0 ? exifLimit : DEFAULT_MAX_EXIF_BYTES;
    options.allPhotosFolder = safeFolderName(this.allPhotosFolder, DEFAULT_ALL_PHOTOS_FOLDER);
    options.unknownDateFolder = safeFolderName(this.unknownDateFolder, DEFAULT_UNKNOWN_DATE_FOLDER);
    return options;
  }

  /** 返回配置错误；空数组表示可以执行（对应 Python validate()）。 */
  validate() {
    let options;
    try {
      options = this.normalized();
    } catch (error) {
      if (error instanceof ValidationError) {
        return [`路径或选项无效：${error.message}`];
      }
      return [`路径或选项无效：${error.message}`];
    }
    const errors = [];
    try {
      if (!fs.statSync(options.inputDir).isDirectory()) {
        errors.push("输入目录不存在或不是文件夹");
      }
    } catch {
      errors.push("输入目录不存在或不是文件夹");
    }
    if (samePath(options.inputDir, options.outputDir)) {
      errors.push("输入目录与输出目录不能相同");
    }
    try {
      if (fs.existsSync(options.outputDir) && !fs.statSync(options.outputDir).isDirectory()) {
        errors.push("输出路径已存在，但它不是文件夹");
      }
    } catch {
      errors.push("输出路径已存在，但它不是文件夹");
    }
    if (
      !(
        options.useJson ||
        options.useExif ||
        options.useFilename ||
        options.useFileMtime
      )
    ) {
      errors.push("至少需要启用一种日期来源");
    }
    return errors;
  }

  /** 运行报告中的 options 字段（Python asdict 形状，路径为字符串）。 */
  toJSON() {
    return {
      input_dir: this.inputDir,
      output_dir: this.outputDir,
      operation: this.operation,
      album_mode: this.albumMode,
      date_division: this.dateDivision,
      conflict_mode: this.conflictMode,
      unknown_date_mode: this.unknownDateMode,
      skip_extras: this.skipExtras,
      use_json: this.useJson,
      use_exif: this.useExif,
      use_filename: this.useFilename,
      aggressive_json: this.aggressiveJson,
      use_file_mtime: this.useFileMtime,
      set_file_mtime: this.setFileMtime,
      scan_all_if_no_takeout: this.scanAllIfNoTakeout,
      include_hidden: this.includeHidden,
      write_report: this.writeReport,
      use_hash_cache: this.useHashCache,
      recognize_live_photos: this.recognizeLivePhotos,
      live_photo_target: this.livePhotoTarget,
      correct_date_filenames: this.correctDateFilenames,
      all_photos_folder: this.allPhotosFolder,
      unknown_date_folder: this.unknownDateFolder,
      workers: this.workers,
      max_exif_bytes: this.maxExifBytes,
      hash_chunk_size: this.hashChunkSize,
    };
  }
}

/**
 * 同一媒体在年份目录和多个相册中的位置集合（对应 Python MediaRecord）。
 *
 * locations 使用 Map：键为相册名（string）或 null（主时间线）。
 */
export class MediaRecord {
  constructor(locations, init = {}) {
    this.locations = locations instanceof Map ? locations : new Map(Object.entries(locations ?? {}));
    this.size = init.size ?? null;
    this.digest = init.digest ?? null;
    this.dateTaken = init.dateTaken ?? null;
    this.dateSource = init.dateSource ?? null;
    this.dateAccuracy = init.dateAccuracy ?? null;
    // 与 locations 使用同一相册键；开启实况识别后，动态片段不再作为
    // 独立媒体，而是和静态图共同参与去重、命名与执行。
    this.livePhotoCompanions = init.livePhotoCompanions ?? new Map();
    this.livePhotoMetadata = init.livePhotoMetadata ?? new Map();
    this.livePhotoEvidence = init.livePhotoEvidence ?? new Map();
    this.livePhotoRepairedSuffix = init.livePhotoRepairedSuffix ?? new Map();
    this.livePhotoOutputMotionSuffixes = init.livePhotoOutputMotionSuffixes ?? new Map();
    // 对已通过容器签名确认、但源文件没有扩展名或被误写成 .mp/.mp3 的
    // 独立视频，记录安全的输出后缀。这里只影响目标文件名，不会转码或改写源文件。
    this.outputSuffixes = init.outputSuffixes ?? new Map();
  }

  get firstFile() {
    return this.locations.values().next().value;
  }

  get firstAlbumKey() {
    return this.locations.keys().next().value;
  }

  get albums() {
    return [...this.locations.keys()]
      .filter((key) => key !== null)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  get hasTimelineCopy() {
    return this.locations.has(null);
  }

  get isLivePhoto() {
    return this.livePhotoCompanions.size > 0;
  }

  /** 返回指定来源的实况动态片段。 */
  companionFor(album) {
    return this.livePhotoCompanions.get(album) ?? null;
  }

  /** 返回扫描阶段按容器确认的动态片段输出后缀。 */
  outputMotionSuffixFor(album) {
    return this.livePhotoOutputMotionSuffixes.get(album) ?? null;
  }

  /** 返回独立媒体经内容确认后的输出后缀。 */
  outputSuffixFor(album) {
    return this.outputSuffixes.get(album) ?? null;
  }
}

/** 重复组中的一个原始物理文件。 */
export class DuplicateMember {
  constructor(init = {}) {
    this.path = init.path;
    this.album = init.album ?? null;
    this.size = init.size ?? 0;
    this.digest = init.digest ?? "";
    this.modifiedNs = init.modifiedNs ?? null;
    this.disposition = init.disposition ?? DuplicateDisposition.SKIPPED;
    this.reason = init.reason ?? "";
    this.companionPath = init.companionPath ?? null;
  }

  toJSON() {
    return {
      path: this.path,
      album: this.album,
      size: this.size,
      digest: this.digest,
      modified_ns: this.modifiedNs,
      disposition: this.disposition,
      reason: this.reason,
      companion_path: this.companionPath,
    };
  }
}

/** 内容完全相同的一组文件，供只读对比预览使用。 */
export class DuplicateGroup {
  constructor(init = {}) {
    this.digest = init.digest ?? "";
    this.size = init.size ?? 0;
    this.members = init.members ?? [];
    this.primaryPath = init.primaryPath ?? null;
    this.dateTaken = init.dateTaken ?? null;
    this.dateSource = init.dateSource ?? null;
    this.isLivePhoto = Boolean(init.isLivePhoto);
  }

  /** 除主文件之外的物理副本数量。 */
  get redundantCount() {
    return Math.max(this.members.length - 1, 0);
  }

  /** 因同来源内容重复而不会进入计划的文件数。 */
  get skippedCount() {
    return this.members.filter((member) => member.disposition === DuplicateDisposition.SKIPPED)
      .length;
  }

  /** 为保留相册关系而存在的同内容来源数。 */
  get albumCopyCount() {
    return this.members.filter((member) => member.disposition === DuplicateDisposition.ALBUM_COPY)
      .length;
  }

  /** 原去重逻辑跳过的副本大小；不把相册副本误算为空间收益。 */
  get reclaimableBytes() {
    return this.skippedCount * this.size;
  }

  toJSON() {
    return {
      digest: this.digest,
      size: this.size,
      members: this.members.map((member) => member.toJSON()),
      primary_path: this.primaryPath,
      date_taken: formatLocalIso(this.dateTaken),
      date_source: this.dateSource,
      is_live_photo: this.isLivePhoto,
    };
  }
}

/** 阶段进度。 */
export class ProgressUpdate {
  constructor(phase, current, total, message) {
    this.phase = phase;
    this.current = current;
    this.total = total;
    this.message = message;
  }
}

/** 一次运行的全部统计（对应 Python RunStatistics 默认值）。 */
export class RunStatistics {
  constructor() {
    this.discovered = 0;
    this.afterDeduplication = 0;
    this.duplicatesRemoved = 0;
    this.duplicateGroups = 0;
    this.duplicateFiles = 0;
    this.hashCacheHits = 0;
    this.hashCacheMisses = 0;
    this.livePhotoPairs = 0;
    this.livePhotoMetadataVerified = 0;
    this.livePhotoRepairedExtensions = 0;
    this.livePhotoAmbiguous = 0;
    this.livePhotoRejected = 0;
    this.extrasRemoved = 0;
    this.albumGroupsMerged = 0;
    this.dated = 0;
    this.unknownDates = 0;
    this.plannedActions = 0;
    this.copied = 0;
    this.moved = 0;
    this.shortcuts = 0;
    this.skipped = 0;
    this.failed = 0;
    this.bytesCopied = 0;
    this.startedAt = new Date();
    this.finishedAt = null;
  }

  toJSON() {
    return {
      discovered: this.discovered,
      after_deduplication: this.afterDeduplication,
      duplicates_removed: this.duplicatesRemoved,
      duplicate_groups: this.duplicateGroups,
      duplicate_files: this.duplicateFiles,
      hash_cache_hits: this.hashCacheHits,
      hash_cache_misses: this.hashCacheMisses,
      live_photo_pairs: this.livePhotoPairs,
      live_photo_metadata_verified: this.livePhotoMetadataVerified,
      live_photo_repaired_extensions: this.livePhotoRepairedExtensions,
      live_photo_ambiguous: this.livePhotoAmbiguous,
      live_photo_rejected: this.livePhotoRejected,
      extras_removed: this.extrasRemoved,
      album_groups_merged: this.albumGroupsMerged,
      dated: this.dated,
      unknown_dates: this.unknownDates,
      planned_actions: this.plannedActions,
      copied: this.copied,
      moved: this.moved,
      shortcuts: this.shortcuts,
      skipped: this.skipped,
      failed: this.failed,
      bytes_copied: this.bytesCopied,
      started_at: formatLocalIso(this.startedAt),
      finished_at: formatLocalIso(this.finishedAt),
    };
  }
}

/** 分析结果。 */
export class AnalysisResult {
  constructor(init = {}) {
    this.options = init.options;
    this.media = init.media ?? [];
    this.statistics = init.statistics ?? new RunStatistics();
    this.yearFolders = init.yearFolders ?? [];
    this.albumFolders = init.albumFolders ?? [];
    this.usedFallbackScan = Boolean(init.usedFallbackScan);
    this.duplicateGroups = init.duplicateGroups ?? [];
  }
}

/** 计划中的一个文件操作。 */
export class PlanAction {
  constructor(init = {}) {
    this.kind = init.kind ?? ActionKind.SKIP;
    this.source = init.source ?? null;
    this.target = init.target ?? null;
    this.media = init.media;
    this.album = init.album ?? null;
    this.reason = init.reason ?? "";
    this.fallbackSource = init.fallbackSource ?? null;
    this.fallbackTarget = init.fallbackTarget ?? null;
    this.status = init.status ?? ActionStatus.PLANNED;
    this.actualKind = init.actualKind ?? null;
    this.error = init.error ?? "";
    this.bundleId = init.bundleId ?? null;
    this.livePhotoRole = init.livePhotoRole ?? null;
    this.sizeBytes = init.sizeBytes ?? null;
  }
}

/** 执行结果。 */
export class ExecutionResult {
  constructor(init = {}) {
    this.analysis = init.analysis;
    this.actions = init.actions ?? [];
    this.errors = init.errors ?? [];
  }
}

/** 日期修复任务配置（对应 Python FixDateOptions）。 */
export class FixDateOptions {
  constructor(init = {}) {
    const get = (camel, snake) => {
      if (init[camel] !== undefined) return init[camel];
      if (snake !== undefined && init[snake] !== undefined) return init[snake];
      return undefined;
    };
    const inputDir = get("inputDir", "input_dir");
    if (inputDir === undefined || String(inputDir).trim() === "") {
      throw new ValidationError("缺少待修复媒体目录");
    }
    this.inputDir = String(inputDir);
    this.recursive = Boolean(get("recursive") ?? true);
    this.useJson = Boolean(get("useJson", "use_json") ?? true);
    this.useExif = Boolean(get("useExif", "use_exif") ?? true);
    this.useFilename = Boolean(get("useFilename", "use_filename") ?? true);
    this.aggressiveJson = Boolean(get("aggressiveJson", "aggressive_json") ?? true);
    this.useFileMtime = Boolean(get("useFileMtime", "use_file_mtime") ?? false);
    this.dryRun = Boolean(get("dryRun", "dry_run") ?? false);
    this.includeHidden = Boolean(get("includeHidden", "include_hidden") ?? false);
    this.correctDateFilenames = Boolean(
      get("correctDateFilenames", "correct_date_filenames") ?? false,
    );
    this.maxExifBytes = get("maxExifBytes", "max_exif_bytes") ?? DEFAULT_MAX_EXIF_BYTES;
  }

  normalized() {
    const options = Object.assign(Object.create(FixDateOptions.prototype), this);
    options.inputDir = resolveUserPath(this.inputDir);
    return options;
  }
}

/** 日期修复任务结果。 */
export class FixDateResult {
  constructor(init = {}) {
    this.total = init.total ?? 0;
    this.updated = init.updated ?? 0;
    this.unchanged = init.unchanged ?? 0;
    this.failed = init.failed ?? 0;
    this.renameCandidates = init.renameCandidates ?? 0;
    this.renamed = init.renamed ?? 0;
    this.errors = init.errors ?? [];
  }
}

/**
 * 线程安全的取消、进度与日志通道（对应 Python TaskContext）。
 *
 * Node 版本使用普通回调 + 取消标志；检查点抛出 CancelledError。
 */
export class TaskContext {
  constructor(init = {}) {
    this.cancelEvent = init.cancelEvent ?? { flag: false };
    this.progressCallback = init.progressCallback ?? null;
    this.logCallback = init.logCallback ?? null;
    // JSON 边车索引只在当前任务中存活，避免模块级缓存跨扫描失效。
    this.sidecarDirectoryIndexes = new Map();
    // 同类 EXIF 环境诊断在一次扫描中只显示一次，避免大量 HEIC 缺解码器时日志洪泛。
    this.exifNotices = new Set();
  }

  /** 请求取消（可被 UI/CLI/worker 消息调用）。 */
  cancel() {
    this.cancelEvent.flag = true;
  }

  get isCancelled() {
    return Boolean(this.cancelEvent.flag);
  }

  checkCancelled() {
    if (this.isCancelled) {
      throw new CancelledError("任务已由用户取消");
    }
  }

  progress(phase, current, total, message) {
    if (!this.progressCallback) {
      return;
    }
    try {
      this.progressCallback(new ProgressUpdate(phase, current, total, message));
    } catch {
      // 展示层回调不能让已经开始的文件事务半途失败。
    }
  }

  log(level, message) {
    if (!this.logCallback) {
      return;
    }
    try {
      this.logCallback(level, message);
    } catch {
      // 同上：日志回调异常必须被吞掉。
    }
  }
}

/**
 * 供报告序列化使用：递归转换枚举、日期与 Map（对应 Python enum_value）。
 * - Date -> 本地 isoformat 字符串
 * - Map -> 普通对象（键用 String()）
 * - 数组 -> 逐项转换
 */
export function enumValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return formatLocalIso(value);
  }
  if (value instanceof Map) {
    const output = {};
    for (const [key, item] of value.entries()) {
      output[String(key)] = enumValue(item);
    }
    return output;
  }
  if (Array.isArray(value)) {
    return value.map((item) => enumValue(item));
  }
  if (typeof value === "object") {
    if (typeof value.toJSON === "function") {
      return enumValue(value.toJSON());
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[String(key)] = enumValue(item);
    }
    return output;
  }
  return value;
}

/** 比较两份组织选项是否等价（UI 复用已生成预览的判定）。 */
export function optionsEqual(left, right) {
  if (!left || !right) {
    return false;
  }
  return JSON.stringify(left.toJSON()) === JSON.stringify(right.toJSON());
}
