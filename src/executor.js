/**
 * 执行预览过的文件计划，并生成相册索引与运行报告（历史 Python v4.1 参考实现 的 Node 移植）。
 *
 * 安全语义与 Python 完全一致：
 * - 整批任务持有输出目录锁；
 * - 单个文件错误只记录并继续，不中止整批；
 * - 实况照片两半始终成组提交，任一半冲突时整组跳过；
 * - MOVE 源文件退役失败时按真实结果降级为 COPY 或标记失败；
 * - 运行报告与相册索引都使用同目录临时文件 + 原子替换。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ALBUM_INFO_NAME, DEFAULT_REPORT_NAME } from "./constants.js";
import {
  OutputDirectoryLock,
  atomicCopy,
  atomicCopyBundle,
  availableTarget,
  conflictKey,
  createShortcut,
  prepareFileTarget,
  retireSourcesForMove,
  safeMove,
  setFileTime,
} from "./file-utils.js";
import {
  ActionKind,
  ActionStatus,
  AlbumMode,
  CancelledError,
  ConflictMode,
  ExecutionResult,
  LivePhotoRole,
  Phase,
  enumValue,
} from "./models.js";
import { formatLocalIso } from "./time.js";

// ---------------------------------------------------------------------------
// 小工具（路径保持字符串；Python Path 的常用语义在这里等价实现）
// ---------------------------------------------------------------------------

function exists(target) {
  return fs.existsSync(target);
}

function isSymlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 对应 Python `path.exists() or path.is_symlink()`（断链也算占用）。 */
function existsOrSymlink(target) {
  return exists(target) || isSymlink(target);
}

/** 对应 Python `f"{value}"`：None 输出 "None" 而不是 "null"。 */
function pyStr(value) {
  if (value === null || value === undefined) {
    return "None";
  }
  return String(value);
}

/** 对应 Python `str(exc)`：Node 的 Error 只取 message。 */
function errorText(error) {
  if (error === null || error === undefined) {
    return String(error);
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message ? error.message : String(error);
  }
  return String(error);
}

/** 对应 Python `Path.relative_to(...).as_posix()`。 */
function relativePosix(target, parent) {
  const relative = path.relative(parent, target);
  return relative.split(path.sep).join("/");
}

/** 计划动作的可读描述；对应 Python dataclass repr 的常用字段（内部错误信息用）。 */
function describeAction(action) {
  const fields = [
    `kind=${pyStr(action.kind)}`,
    `source=${pyStr(action.source)}`,
    `target=${pyStr(action.target)}`,
    `album=${pyStr(action.album)}`,
    `reason=${pyStr(action.reason)}`,
    `bundle_id=${pyStr(action.bundleId)}`,
  ];
  return `PlanAction(${fields.join(", ")})`;
}

// ---------------------------------------------------------------------------
// 执行入口
// ---------------------------------------------------------------------------

/**
 * 逐项执行计划；单文件错误会记录并继续，不中止整批任务。
 *
 * @param {import("./models.js").AnalysisResult} analysis
 * @param {import("./models.js").PlanAction[]} actions
 * @param {import("./models.js").TaskContext} context
 * @returns {Promise<import("./models.js").ExecutionResult>}
 */
export async function executePlan(analysis, actions, context) {
  const lock = new OutputDirectoryLock(analysis.options.outputDir).acquire();
  try {
    return await _executePlanLocked(analysis, actions, context);
  } finally {
    lock.release();
  }
}

async function _executePlanLocked(analysis, actions, context) {
  const options = analysis.options;
  const statistics = analysis.statistics;
  // AnalysisResult 可被 API 调用方复用；每次执行前重置执行期统计和动作状态。
  statistics.copied = 0;
  statistics.moved = 0;
  statistics.shortcuts = 0;
  statistics.skipped = 0;
  statistics.failed = 0;
  statistics.bytesCopied = 0;
  statistics.finishedAt = null;
  for (const action of actions) {
    action.status = ActionStatus.PLANNED;
    action.actualKind = null;
    action.error = "";
  }
  const errors = [];
  const successfulActions = [];
  const successfulTargets = new Set();
  const reservedTargets = new Set();
  for (const action of actions) {
    if (action.target !== null && action.target !== undefined) {
      reservedTargets.add(action.target);
    }
  }
  const reservedTargetKeys = new Set();
  for (const target of reservedTargets) {
    reservedTargetKeys.add(conflictKey(target));
  }
  fs.mkdirSync(options.outputDir, { recursive: true });

  const bundledActions = new Map();
  for (const action of actions) {
    if (action.bundleId !== null && action.bundleId !== undefined) {
      const existing = bundledActions.get(action.bundleId);
      if (existing === undefined) {
        bundledActions.set(action.bundleId, [action]);
      } else {
        existing.push(action);
      }
    }
  }
  const handledBundles = new Set();
  const total = actions.length;

  for (let index = 1; index <= total; index += 1) {
    const action = actions[index - 1];
    if (action.bundleId !== null && action.bundleId !== undefined) {
      if (handledBundles.has(action.bundleId)) {
        continue;
      }
      handledBundles.add(action.bundleId);
      const bundle = bundledActions.get(action.bundleId);
      const name = action.source ? path.basename(action.source) : action.reason;
      context.progress(Phase.EXECUTING, index - 1, total, `正在成组处理实况照片：${name}`);
      context.checkCancelled();
      const bundleSuccesses = await _executeLivePhotoBundle(bundle, analysis, context, errors);
      for (const item of bundleSuccesses) {
        successfulActions.push(item);
        if (item.target !== null && item.target !== undefined) {
          successfulTargets.add(item.target);
        }
      }
      const bundleEnd = Math.min(index + bundle.length - 1, total);
      context.progress(Phase.EXECUTING, bundleEnd, total, `已处理 ${bundleEnd}/${total}`);
      continue;
    }

    context.checkCancelled();
    const name = action.source ? path.basename(action.source) : action.reason;
    context.progress(Phase.EXECUTING, index - 1, total, `正在处理：${name}`);
    // 进度回调本身可能正是 UI 发出取消的时刻。
    context.checkCancelled();
    if (action.kind === ActionKind.SKIP) {
      action.status = ActionStatus.SKIPPED;
      action.actualKind = ActionKind.SKIP;
      statistics.skipped += 1;
      context.progress(Phase.EXECUTING, index, total, `已处理 ${index}/${total}`);
      continue;
    }
    if (
      action.source === null ||
      action.source === undefined ||
      action.target === null ||
      action.target === undefined
    ) {
      const message = `操作缺少源或目标：${describeAction(action)}`;
      action.status = ActionStatus.FAILED;
      action.error = message;
      errors.push(message);
      statistics.failed += 1;
      context.log("ERROR", message);
      context.progress(Phase.EXECUTING, index, total, `已处理 ${index}/${total}`);
      continue;
    }
    try {
      if (action.kind === ActionKind.COPY) {
        await atomicCopy(action.source, action.target, context, options.hashChunkSize, {
          allowOverwrite: options.conflictMode === ConflictMode.OVERWRITE,
        });
        statistics.copied += 1;
        statistics.bytesCopied += _actionSize(action);
        action.actualKind = ActionKind.COPY;
      } else if (action.kind === ActionKind.MOVE) {
        const copiedAcrossVolumes = await safeMove(
          action.source,
          action.target,
          context,
          options.hashChunkSize,
          { allowOverwrite: options.conflictMode === ConflictMode.OVERWRITE },
        );
        statistics.moved += 1;
        statistics.bytesCopied += copiedAcrossVolumes ? _actionSize(action) : 0;
        action.actualKind = ActionKind.MOVE;
      } else if (action.kind === ActionKind.SHORTCUT) {
        if (!successfulTargets.has(action.source)) {
          const [actualKind, copiedBytes] = await _shortcutFallback(
            action,
            analysis,
            context,
            reservedTargets,
            reservedTargetKeys,
          );
          statistics.copied += actualKind === ActionKind.COPY ? 1 : 0;
          statistics.moved += actualKind === ActionKind.MOVE ? 1 : 0;
          statistics.bytesCopied += copiedBytes ? _actionSize(action) : 0;
          action.actualKind = actualKind;
          context.log(
            "WARNING",
            `主文件未能成功输出，已在相册中改用实体文件：${path.basename(action.target)}`,
          );
        } else {
          // RENAME/SKIP 计划后若有外部程序占用目标，宁可报冲突也不能
          // 静默删除；只有用户明确选择 OVERWRITE 才允许替换。
          if (existsOrSymlink(action.target)) {
            if (options.conflictMode === ConflictMode.OVERWRITE) {
              prepareFileTarget(action.target);
            } else {
              throw new Error(`执行期间快捷方式目标已被占用：${action.target}`);
            }
          }
          try {
            await createShortcut(action.target, action.source, context);
            statistics.shortcuts += 1;
            action.actualKind = ActionKind.SHORTCUT;
          } catch (shortcutError) {
            if (shortcutError instanceof CancelledError) {
              throw shortcutError;
            }
            const [actualKind, copiedBytes] = await _shortcutFallback(
              action,
              analysis,
              context,
              reservedTargets,
              reservedTargetKeys,
            );
            statistics.copied += actualKind === ActionKind.COPY ? 1 : 0;
            statistics.moved += actualKind === ActionKind.MOVE ? 1 : 0;
            statistics.bytesCopied += copiedBytes ? _actionSize(action) : 0;
            action.actualKind = actualKind;
            context.log(
              "WARNING",
              `快捷方式创建失败，已改用实体文件：${path.basename(action.target)}（${errorText(
                shortcutError,
              )}）`,
            );
          }
        }
      }

      action.status = ActionStatus.SUCCESS;
      successfulActions.push(action);
      successfulTargets.add(action.target);

      if (options.setFileMtime && exists(action.target)) {
        _applyMediaTime(action, context);
      }
    } catch (error) {
      if (error instanceof CancelledError) {
        throw error;
      }
      const message = `处理 ${action.source} → ${action.target} 失败：${errorText(error)}`;
      action.status = ActionStatus.FAILED;
      action.error = errorText(error);
      errors.push(message);
      statistics.failed += 1;
      context.log("ERROR", message);
    } finally {
      context.progress(Phase.EXECUTING, index, total, `已处理 ${index}/${total}`);
    }
  }

  context.checkCancelled();
  if (options.albumMode === AlbumMode.JSON) {
    _writeAlbumInfo(analysis, successfulActions, errors, context);
  }
  context.checkCancelled();
  statistics.finishedAt = new Date();
  if (options.writeReport) {
    const reportError = _writeReport(analysis, actions, errors, context);
    if (reportError) {
      errors.push(reportError);
      statistics.failed += 1;
    }
  }
  context.checkCancelled();
  context.progress(Phase.FINISHED, total, total, "整理完成");
  return new ExecutionResult({ analysis, actions, errors });
}

// ---------------------------------------------------------------------------
// 实况照片成组执行
// ---------------------------------------------------------------------------

async function _executeLivePhotoBundle(bundle, analysis, context, errors) {
  const statistics = analysis.statistics;
  if (!bundle || bundle.length === 0) {
    return [];
  }

  const validationError = _validateLivePhotoBundle(bundle);
  if (validationError) {
    _markBundleFailed(bundle, validationError, errors, statistics);
    context.log("ERROR", validationError);
    return [];
  }

  if (bundle.every((action) => action.kind === ActionKind.SKIP)) {
    for (const action of bundle) {
      action.status = ActionStatus.SKIPPED;
      action.actualKind = ActionKind.SKIP;
    }
    statistics.skipped += bundle.length;
    return [];
  }

  const kinds = new Set(bundle.map((action) => action.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : null;
  if (kind === null || (kind !== ActionKind.COPY && kind !== ActionKind.MOVE)) {
    const message = `实况照片计划包含不一致操作：${pyStr(bundle[0].bundleId)}`;
    _markBundleFailed(bundle, message, errors, statistics);
    context.log("ERROR", message);
    return [];
  }

  const pairs = [];
  for (const action of bundle) {
    if (
      action.source !== null &&
      action.source !== undefined &&
      action.target !== null &&
      action.target !== undefined
    ) {
      pairs.push([action.source, action.target]);
    }
  }
  try {
    await atomicCopyBundle(pairs, context, analysis.options.hashChunkSize, {
      allowOverwrite: analysis.options.conflictMode === ConflictMode.OVERWRITE,
    });
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    const sourceText = pairs.map(([source]) => String(source)).join(" + ");
    const message = `成组处理实况照片 ${sourceText} 失败：${errorText(error)}`;
    _markBundleFailed(bundle, message, errors, statistics, errorText(error));
    context.log("ERROR", message);
    return [];
  }

  // 成组输出始终是实体复制；即使后续 MOVE 源退役失败，
  // 报告也应记录已经写入的实际字节数。
  statistics.bytesCopied += bundle.reduce((sum, action) => sum + _actionSize(action), 0);

  if (kind === ActionKind.COPY) {
    for (const action of bundle) {
      action.status = ActionStatus.SUCCESS;
      action.actualKind = ActionKind.COPY;
      if (analysis.options.setFileMtime && action.target !== null && action.target !== undefined) {
        _applyMediaTime(action, context);
      }
    }
    statistics.copied += bundle.length;
    return [...bundle];
  }

  let outcomes;
  try {
    outcomes = await retireSourcesForMove(
      pairs.map(([source]) => source),
      context,
    );
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    const sourceText = pairs.map(([source]) => String(source)).join(" + ");
    const message = `实况照片目标已输出，但 MOVE 源文件事务失败 ${sourceText}：${errorText(error)}`;
    _markBundleFailed(bundle, message, errors, statistics, errorText(error));
    context.log("ERROR", message);
    return [];
  }

  const successful = [];
  const reportedMessages = new Set();
  for (let index = 0; index < bundle.length; index += 1) {
    const action = bundle[index];
    const outcome = outcomes[index];
    if (outcome.moved === true) {
      action.status = ActionStatus.SUCCESS;
      action.actualKind = ActionKind.MOVE;
      statistics.moved += 1;
      successful.push(action);
    } else if (outcome.moved === false) {
      action.status = ActionStatus.SUCCESS;
      action.actualKind = ActionKind.COPY;
      action.error = outcome.message ?? "";
      statistics.copied += 1;
      successful.push(action);
      if (!reportedMessages.has(outcome.message)) {
        const warning = `MOVE 已安全降级为 COPY：${outcome.message}`;
        errors.push(warning);
        context.log("WARNING", warning);
        reportedMessages.add(outcome.message);
      }
    } else {
      action.status = ActionStatus.FAILED;
      action.actualKind = null;
      action.error = outcome.message ?? "";
      statistics.failed += 1;
      if (!reportedMessages.has(outcome.message)) {
        errors.push(outcome.message);
        context.log("ERROR", outcome.message);
        reportedMessages.add(outcome.message);
      }
    }

    if (action.status === ActionStatus.SUCCESS && analysis.options.setFileMtime) {
      _applyMediaTime(action, context);
    }
  }
  return successful;
}

function _validateLivePhotoBundle(bundle) {
  const bundleId = bundle[0].bundleId;
  if (
    bundleId === null ||
    bundleId === undefined ||
    bundle.length !== 2 ||
    bundle.some((action) => action.bundleId !== bundleId)
  ) {
    return `实况照片成组计划必须恰好包含两项：${pyStr(bundleId)}`;
  }
  const roles = new Set(bundle.map((action) => action.livePhotoRole));
  if (
    roles.size !== 2 ||
    !roles.has(LivePhotoRole.STILL) ||
    !roles.has(LivePhotoRole.MOTION)
  ) {
    return `实况照片成组计划必须同时包含静态图和动态片段：${pyStr(bundleId)}`;
  }
  if (bundle.some((action) => action.source === null || action.source === undefined)) {
    return `实况照片计划缺少源文件：${pyStr(bundleId)}`;
  }

  const sourceKeys = bundle
    .filter((action) => action.source !== null && action.source !== undefined)
    .map((action) => conflictKey(action.source));
  if (new Set(sourceKeys).size !== 2) {
    return `实况照片两半的源路径必须彼此唯一：${pyStr(bundleId)}`;
  }

  if (bundle.every((action) => action.kind === ActionKind.SKIP)) {
    return null;
  }
  if (bundle.some((action) => action.target === null || action.target === undefined)) {
    return `实况照片计划缺少目标文件：${pyStr(bundleId)}`;
  }

  const targetKeys = bundle
    .filter((action) => action.target !== null && action.target !== undefined)
    .map((action) => conflictKey(action.target));
  if (new Set(targetKeys).size !== 2) {
    return `实况照片两半的目标路径必须彼此唯一：${pyStr(bundleId)}`;
  }
  const sourceKeySet = new Set(sourceKeys);
  if (targetKeys.some((key) => sourceKeySet.has(key))) {
    return `实况照片的源路径与目标路径不能重叠：${pyStr(bundleId)}`;
  }
  return null;
}

function _markBundleFailed(bundle, message, errors, statistics, detail = null) {
  for (const action of bundle) {
    action.status = ActionStatus.FAILED;
    action.error = detail || message;
  }
  errors.push(message);
  statistics.failed += bundle.length;
}

function _actionSize(action) {
  if (action.sizeBytes !== null && action.sizeBytes !== undefined) {
    return action.sizeBytes;
  }
  return action.media?.size ?? 0;
}

/**
 * 快捷方式不可用时，使用相册中的原实体文件兜底。
 *
 * @returns {Promise<[string, boolean]>} [实际动作类型, 是否发生实体复制字节]
 */
async function _shortcutFallback(action, analysis, context, reservedTargets, reservedTargetKeys) {
  const source = action.fallbackSource;
  const shortcutTarget = action.target;
  const desiredTarget = action.fallbackTarget ?? action.target;
  if (source === null || source === undefined || desiredTarget === null || desiredTarget === undefined) {
    throw new Error("没有可用于快捷方式兜底的源文件");
  }
  // 清理由快捷方式工具留下的半成品，再切换到预留的实体文件目标。
  if (shortcutTarget && existsOrSymlink(shortcutTarget)) {
    prepareFileTarget(shortcutTarget);
  }
  if (shortcutTarget !== null && shortcutTarget !== undefined) {
    reservedTargets.delete(shortcutTarget);
    reservedTargetKeys.delete(conflictKey(shortcutTarget));
  }
  const { target } = availableTarget(
    desiredTarget,
    ConflictMode.RENAME,
    reservedTargets,
    reservedTargetKeys,
  );
  action.target = target;
  if (analysis.options.operation === "copy") {
    await atomicCopy(source, target, context, analysis.options.hashChunkSize);
    return [ActionKind.COPY, true];
  }
  const copiedAcrossVolumes = await safeMove(
    source,
    target,
    context,
    analysis.options.hashChunkSize,
  );
  return [ActionKind.MOVE, copiedAcrossVolumes];
}

/** 已知日期用提取值；未知日期保留源文件原始 mtime。 */
function _applyMediaTime(action, context) {
  if (action.target === null || action.target === undefined) {
    return;
  }
  const value = action.media.dateTaken;
  // 未知日期时复制/移动本身已经保留源 mtime，不把它错误改成运行时刻。
  if (value !== null && value !== undefined) {
    try {
      setFileTime(action.target, value, context);
    } catch (error) {
      if (error instanceof CancelledError) {
        throw error;
      }
      context.log("WARNING", `无法设置修改时间 ${action.target}：${errorText(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 相册索引与运行报告
// ---------------------------------------------------------------------------

/** 生成兼容 basename 键；重名时自动升级为相对路径键，避免记录覆盖。 */
function _writeAlbumInfo(analysis, actions, errors, context) {
  const outputActions = [];
  for (const action of actions) {
    if (
      action.target !== null &&
      action.target !== undefined &&
      action.kind !== ActionKind.SKIP
    ) {
      outputActions.push([action, action.target]);
    }
  }
  const nameCounts = new Map();
  for (const [, target] of outputActions) {
    const name = path.basename(target);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const data = {};
  for (const [action, target] of outputActions) {
    let key = path.basename(target);
    if (nameCounts.get(key) > 1) {
      key = relativePosix(target, analysis.options.outputDir);
    }
    data[key] = action.media.albums;
  }
  try {
    _atomicWriteJson(path.join(analysis.options.outputDir, ALBUM_INFO_NAME), data);
  } catch (error) {
    const message = `写入 ${ALBUM_INFO_NAME} 失败：${errorText(error)}`;
    errors.push(message);
    analysis.statistics.failed += 1;
    context.log("ERROR", message);
  }
}

/**
 * 生成 version 1 运行报告。成功返回 null，失败返回错误消息（由调用方累计）。
 */
function _writeReport(analysis, actions, errors, context) {
  const livePhotos = [];
  for (const item of analysis.media) {
    for (const [album, companion] of item.livePhotoCompanions.entries()) {
      const still = item.locations.get(album) ?? item.firstFile;
      livePhotos.push({
        album,
        still: String(still),
        motion: String(companion),
        metadata_status: enumValue(item.livePhotoMetadata.get(album) ?? null),
        evidence: item.livePhotoEvidence.get(album) ?? null,
        repaired_suffix: item.livePhotoRepairedSuffix.get(album, false),
        date: item.dateTaken ? formatLocalIso(item.dateTaken) : null,
      });
    }
  }
  const report = {
    version: 1,
    options: enumValue(analysis.options.toJSON()),
    statistics: enumValue(analysis.statistics.toJSON()),
    duplicate_groups: enumValue(analysis.duplicateGroups.map((group) => group.toJSON())),
    live_photos: livePhotos,
    actions: actions.map((action) => ({
      planned_kind: action.kind,
      actual_kind: action.actualKind ?? null,
      status: action.status,
      source: action.source ? String(action.source) : null,
      target: action.target ? String(action.target) : null,
      album: action.album,
      date: action.media.dateTaken ? formatLocalIso(action.media.dateTaken) : null,
      date_source: action.media.dateSource ?? null,
      bundle_id: action.bundleId,
      live_photo_role: action.livePhotoRole ?? null,
      size_bytes: action.sizeBytes,
      reason: action.reason,
      error: action.error ? action.error : null,
    })),
    errors,
  };
  try {
    _atomicWriteJson(path.join(analysis.options.outputDir, DEFAULT_REPORT_NAME), report);
  } catch (error) {
    const message = `运行报告写入失败：${errorText(error)}`;
    context.log("ERROR", message);
    return message;
  }
  return null;
}

/**
 * 同目录临时写入后替换，避免程序中断留下半份 JSON。
 *
 * 与 Python 一致：文件内容为 `json.dumps(data, ensure_ascii=False, indent=2)`，
 * 键顺序即对象插入顺序。
 */
function _atomicWriteJson(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporary = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID().replaceAll("-", "")}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(temporary, targetPath);
  } finally {
    try {
      if (fs.existsSync(temporary)) {
        fs.rmSync(temporary, { force: true });
      }
    } catch {
      // 清理失败不应覆盖原始写入错误。
    }
  }
}

// 供测试与诊断使用（不改变执行语义）。
export const __test__ = {
  _atomicWriteJson,
  _executeLivePhotoBundle,
  _markBundleFailed,
  _validateLivePhotoBundle,
  _writeAlbumInfo,
  _writeReport,
  describeAction,
};
