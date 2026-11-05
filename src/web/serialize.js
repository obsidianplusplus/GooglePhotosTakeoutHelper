/**
 * Web 后端数据序列化。
 *
 * worker 线程与主线程之间只通过可结构化克隆的普通对象通信：
 * - 分析摘要（AnalysisSummary）、预览行（PreviewRow）、重复组（DuplicateGroup）
 *   都在 worker 线程里用本模块序列化成契约中的 JSON 形状；
 * - 主线程不再接触引擎对象，只转发 SSE 事件与摘要。
 *
 * 字段与文案遵守 docs/ARCHITECTURE.md 的 Web 架构。
 */

import { formatDateTime, formatTime } from "../time.js";

function toInteger(value, fallback = 0) {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toText(value, fallback = "") {
  return value === null || value === undefined ? fallback : String(value);
}

function toSizePair(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const width = toInteger(value[0], NaN);
  const height = toInteger(value[1], NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return [width, height];
}

/** 计算 0-100 的整数百分比（Python UI 用 ratio，SSE 契约用整数百分比）。 */
export function percent(current, total) {
  const done = toInteger(current, 0);
  const overall = toInteger(total, 0);
  if (overall <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((done / overall) * 100)));
}

/** 计划动作里展示用的本地时间文本；未知日期返回 null（契约：前端显示“未知”）。 */
export function formatActionDate(dateTaken) {
  if (!(dateTaken instanceof Date) || Number.isNaN(dateTaken.getTime())) {
    return null;
  }
  return formatDateTime(dateTaken) || null;
}

/** ProgressUpdate -> SSE progress 事件 payload。 */
export function serializeProgress(update) {
  const current = Math.max(toInteger(update?.current, 0), 0);
  const total = Math.max(toInteger(update?.total, 0), 0);
  return {
    phase: toText(update?.phase),
    current,
    total,
    message: toText(update?.message),
    percent: percent(current, total),
  };
}

/** context.log(level, message) -> SSE log 事件 payload（level 统一大写，与桌面 UI 一致）。 */
export function serializeLog(level, message) {
  return {
    time: formatTime(new Date()),
    level: toText(level, "INFO").toUpperCase(),
    message: toText(message),
  };
}

/**
 * AnalysisResult + PlanAction[] -> AnalysisSummary。
 *
 * @param {object|null} analysis
 * @param {Array<object>|null} actions
 * @returns {object}
 */
export function serializeAnalysisSummary(analysis, actions) {
  const statistics = analysis?.statistics ?? null;
  const media = Array.isArray(analysis?.media) ? analysis.media : [];
  const duplicateGroups = Array.isArray(analysis?.duplicateGroups) ? analysis.duplicateGroups : [];
  const actionList = Array.isArray(actions) ? actions : [];
  const options = analysis?.options ?? {};
  const statisticsJson =
    statistics && typeof statistics.toJSON === "function" ? statistics.toJSON() : {};
  const discovered =
    statistics?.discovered !== undefined ? toInteger(statistics.discovered, media.length) : media.length;
  const plannedActions =
    toInteger(statistics?.plannedActions, 0) > 0
      ? toInteger(statistics?.plannedActions, 0)
      : actionList.length;
  const unknownDates =
    statistics?.unknownDates !== undefined
      ? toInteger(statistics.unknownDates, 0)
      : Math.max(media.length - toInteger(statistics?.dated, 0), 0);
  return {
    discovered,
    unique: media.length,
    duplicateGroups: duplicateGroups.length,
    unknownDates,
    plannedActions,
    hashCacheHits: toInteger(statistics?.hashCacheHits, 0),
    usedFallbackScan: Boolean(analysis?.usedFallbackScan),
    statistics: statisticsJson,
    livePhoto: {
      pairs: toInteger(statistics?.livePhotoPairs, 0),
      verified: toInteger(statistics?.livePhotoMetadataVerified, 0),
      repaired: toInteger(statistics?.livePhotoRepairedExtensions, 0),
      ambiguous: toInteger(statistics?.livePhotoAmbiguous, 0),
      rejected: toInteger(statistics?.livePhotoRejected, 0),
      complete: true,
    },
    outputDirectory: options.outputDir === undefined ? null : options.outputDir,
    operation: toText(options.operation, "copy"),
    albumMode: toText(options.albumMode, "shortcut"),
    dateDivision: toText(options.dateDivision, "year-month"),
    conflictMode: toText(options.conflictMode, "rename"),
    unknownDateMode: toText(options.unknownDateMode, "folder"),
    recognizeLivePhotos: Boolean(options.recognizeLivePhotos),
    correctDateFilenames: Boolean(options.correctDateFilenames),
  };
}

/** PlanAction + 下标 -> PreviewRow。 */
export function serializePreviewRow(action, index) {
  return {
    index: toInteger(index, 0),
    kind: toText(action?.kind, "skip"),
    role: action?.livePhotoRole === null || action?.livePhotoRole === undefined
      ? null
      : toText(action.livePhotoRole),
    source: action?.source === undefined ? null : action.source,
    target: action?.target === undefined ? null : action.target,
    date: formatActionDate(action?.media?.dateTaken ?? null),
    album: action?.album === undefined ? null : action.album,
    bundleId: action?.bundleId === undefined ? null : action.bundleId,
    reason: toText(action?.reason),
    sizeBytes:
      action?.sizeBytes === null || action?.sizeBytes === undefined
        ? null
        : toInteger(action.sizeBytes, 0),
    status: toText(action?.status, "planned"),
  };
}

/** 动作切片 -> 渐进式预览分页。 */
export function serializePreviewPage(actions, offset, limit) {
  const list = Array.isArray(actions) ? actions : [];
  const total = list.length;
  const pageOffset = Math.max(0, Math.min(toInteger(offset, 0), total));
  const pageLimit = Math.max(1, toInteger(limit, 300));
  const end = Math.min(pageOffset + pageLimit, total);
  const rows = [];
  for (let index = pageOffset; index < end; index += 1) {
    rows.push(serializePreviewRow(list[index], index));
  }
  return { total, offset: pageOffset, limit: pageLimit, rows };
}

/**
 * DuplicateGroup -> 契约中的蛇形 JSON（在 models.DuplicateGroup.toJSON 的基础上
 * 补齐 redundant_count / skipped_count / album_copy_count / reclaimable_bytes）。
 */
export function serializeDuplicateGroup(group) {
  if (!group || typeof group !== "object") {
    return null;
  }
  const base = typeof group.toJSON === "function" ? group.toJSON() : { ...group };
  const members = Array.isArray(base.members) ? base.members : [];
  const redundantCount =
    typeof group.redundantCount === "number"
      ? group.redundantCount
      : Math.max(members.length - 1, 0);
  const skippedCount =
    typeof group.skippedCount === "number"
      ? group.skippedCount
      : members.filter((member) => member?.disposition === "skipped").length;
  const albumCopyCount =
    typeof group.albumCopyCount === "number"
      ? group.albumCopyCount
      : members.filter((member) => member?.disposition === "album-copy").length;
  const reclaimableBytes =
    typeof group.reclaimableBytes === "number"
      ? group.reclaimableBytes
      : skippedCount * toInteger(base.size, 0);
  return {
    ...base,
    redundant_count: redundantCount,
    skipped_count: skippedCount,
    album_copy_count: albumCopyCount,
    reclaimable_bytes: reclaimableBytes,
  };
}

/** 重复组切片 -> 分页。 */
export function serializeDuplicatePage(groups, offset, limit) {
  const list = Array.isArray(groups) ? groups : [];
  const total = list.length;
  const pageOffset = Math.max(0, Math.min(toInteger(offset, 0), total));
  const pageLimit = Math.max(1, toInteger(limit, 200));
  const end = Math.min(pageOffset + pageLimit, total);
  const rows = [];
  for (let index = pageOffset; index < end; index += 1) {
    const row = serializeDuplicateGroup(list[index]);
    if (row) {
      rows.push(row);
    }
  }
  return { total, offset: pageOffset, limit: pageLimit, rows };
}

/** ExecutionResult -> ExecutionSummary（SSE execution 事件 payload.summary）。 */
export function serializeExecutionSummary(result) {
  const analysis = result?.analysis ?? null;
  const statistics = analysis?.statistics ?? null;
  const actions = Array.isArray(result?.actions) ? result.actions : [];
  const derive = (predicate) => actions.filter(predicate).length;
  const count = (name, fallback) => {
    const value = statistics?.[name];
    return value === undefined || value === null ? fallback : toInteger(value, fallback);
  };
  const errors = Array.isArray(result?.errors) ? result.errors.map((item) => toText(item)) : [];
  return {
    copied: count(
      "copied",
      derive((action) => action?.status === "success" && action?.kind === "copy"),
    ),
    moved: count(
      "moved",
      derive((action) => action?.status === "success" && action?.kind === "move"),
    ),
    shortcuts: count(
      "shortcuts",
      derive((action) => action?.status === "success" && action?.kind === "shortcut"),
    ),
    skipped: count(
      "skipped",
      derive((action) => action?.status === "skipped" || action?.kind === "skip"),
    ),
    failed: count("failed", derive((action) => action?.status === "failed")),
    bytesCopied: count("bytesCopied", 0),
    errors,
    outputDirectory:
      analysis?.options?.outputDir === undefined ? null : analysis.options.outputDir,
  };
}

/** FixDateResult -> FixResult（SSE fix 事件 payload.result）。 */
export function serializeFixResult(result, { dryRun = false } = {}) {
  const errors = Array.isArray(result?.errors) ? result.errors.map((item) => toText(item)) : [];
  return {
    total: toInteger(result?.total, 0),
    updated: toInteger(result?.updated, 0),
    unchanged: toInteger(result?.unchanged, 0),
    failed: toInteger(result?.failed, 0),
    renameCandidates: toInteger(result?.renameCandidates, 0),
    renamed: toInteger(result?.renamed, 0),
    errors,
    dryRun: Boolean(dryRun),
  };
}

/** 缩略图/详情结果里的尺寸字段统一成 [width, height] | null。 */
export { toSizePair };
