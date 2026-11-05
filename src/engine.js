/**
 * 面向 UI 与 CLI 的统一业务编排入口（历史 Python v4.1 参考实现 的 Node 移植）。
 *
 * 分析阶段的顺序与 Python 严格一致：
 * 校验 → 规范化 → 扫描 → 哈希去重（含扫描指纹缓存）→ 过滤编辑副本 →
 * 并发提取日期 → 合并相册 → 回填重复组。
 * 日期修复阶段先规划全部改名目标，再写任何文件，避免半途失败留下断裂的
 * 实况照片配对。
 */

import fs from "node:fs";
import path from "node:path";

import { mapConcurrent } from "./async-utils.js";
import { FILE_MTIME_ACCURACY, DateExtractionResult, extractDate } from "./date-extractors.js";
import { executePlan } from "./executor.js";
import {
  availableTarget,
  renameFileNoReplace,
  renameFilesNoReplace,
  setFileTime,
} from "./file-utils.js";
import {
  correctedDateStem,
  correctedDateTarget,
  organizedFolderMtime,
} from "./filename-correction.js";
import {
  finalizeDuplicateGroups,
  findDuplicateRecords,
  mergeAlbums,
  removeDuplicates,
  removeExtras,
  snapshotDuplicateGroups,
} from "./grouping.js";
import { availableLivePhotoTargets, discoverLivePhotoPairs } from "./live-photos.js";
import {
  AnalysisResult,
  CancelledError,
  ConflictMode,
  DateSource,
  FixDateResult,
  InputNotFoundError,
  LivePhotoMetadataStatus,
  LivePhotoTarget,
  Phase,
  RunStatistics,
  TaskContext,
  ValidationError,
  resolveUserPath,
} from "./models.js";
import { buildPlan as createPlan } from "./planner.js";
import { HashCache } from "./scan-cache.js";
import { discoverTakeout, scanMediaFolder } from "./scanner.js";

/** 对应 Python f-string 的 `{value:,}` 千分位格式。 */
function formatComma(value) {
  const number = Math.trunc(Number(value) || 0);
  const text = String(number);
  const sign = text.startsWith("-") ? "-" : "";
  const digits = sign ? text.slice(1) : text;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 对应 Python `str(exc)`。 */
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

/** 对应 Python `Path.stem`。 */
function fileStem(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

/** 对应 Python `Path.suffix`（保留大小写与点号）。 */
function fileSuffix(filePath) {
  return path.extname(filePath);
}

/**
 * 无界面依赖的 Takeout 处理引擎（对应 Python TakeoutEngine）。
 */
export class TakeoutEngine {
  /**
   * 扫描、去重、取时并合并相册，不改动输入输出文件。
   *
   * @param {import("./models.js").OrganizeOptions} options
   * @param {import("./models.js").TaskContext|null} [context]
   * @returns {Promise<import("./models.js").AnalysisResult>}
   */
  async analyze(options, context = null) {
    context = context ?? new TaskContext();
    const errors = options.validate();
    if (errors.length > 0) {
      throw new ValidationError(errors.join("；"));
    }
    const normalized = options.normalized();
    const statistics = new RunStatistics();

    const discovery = await discoverTakeout(normalized, context);
    const media = discovery.media;
    if (media.length === 0) {
      throw new InputNotFoundError("输入目录中没有发现受支持的照片或视频");
    }
    statistics.discovered = media.length;
    statistics.livePhotoPairs = 0;
    statistics.livePhotoMetadataVerified = 0;
    statistics.livePhotoRepairedExtensions = 0;
    for (const item of media) {
      statistics.livePhotoPairs += item.livePhotoCompanions.size;
      for (const status of item.livePhotoMetadata.values()) {
        if (status === LivePhotoMetadataStatus.VERIFIED) {
          statistics.livePhotoMetadataVerified += 1;
        }
      }
      for (const repaired of item.livePhotoRepairedSuffix.values()) {
        if (repaired) {
          statistics.livePhotoRepairedExtensions += 1;
        }
      }
      for (const suffix of item.outputSuffixes.values()) {
        if (suffix) {
          statistics.livePhotoRepairedExtensions += 1;
        }
      }
    }
    statistics.livePhotoAmbiguous = discovery.livePhotoAmbiguous;
    statistics.livePhotoRejected = discovery.livePhotoRejected;
    context.log("INFO", `已发现 ${media.length} 个媒体文件`);
    if (normalized.recognizeLivePhotos) {
      context.log(
        "INFO",
        `已识别 ${formatComma(statistics.livePhotoPairs)} 组实况照片；` +
          `Apple 配对元数据完整 ${formatComma(statistics.livePhotoMetadataVerified)} 组；` +
          `标识冲突拒绝 ${formatComma(statistics.livePhotoRejected)} 组`,
      );
      if (normalized.livePhotoTarget === LivePhotoTarget.COLOROS16) {
        context.log(
          "INFO",
          "ColorOS 16 采用 OPPO 官方 O+ 互联路径：程序保留 Apple 原始配对，" +
            "不伪造未公开的 ColorOS 本地封装。",
        );
      }
    }

    let hashCache = null;
    if (normalized.useHashCache) {
      try {
        hashCache = new HashCache();
      } catch (error) {
        context.log("WARNING", `扫描指纹缓存不可用，已改为完整计算：${errorText(error)}`);
      }
    }
    let identicalRecords;
    try {
      identicalRecords = await findDuplicateRecords(
        media,
        context,
        normalized.hashChunkSize,
        hashCache,
      );
    } finally {
      if (hashCache !== null) {
        statistics.hashCacheHits = hashCache.hits;
        statistics.hashCacheMisses = hashCache.misses;
        try {
          hashCache.save();
        } catch (error) {
          context.log("WARNING", `扫描指纹缓存保存失败：${errorText(error)}`);
        }
      }
    }
    if (hashCache !== null) {
      context.log(
        "INFO",
        `扫描指纹缓存命中 ${formatComma(hashCache.hits)}，需计算 ${formatComma(hashCache.misses)}`,
      );
    }
    const duplicateSnapshots = snapshotDuplicateGroups(identicalRecords);
    statistics.duplicatesRemoved = await removeDuplicates(
      media,
      context,
      normalized.hashChunkSize,
      identicalRecords,
    );
    const retainedAfterDeduplication = new Set();
    for (const item of media) {
      for (const locationPath of item.locations.values()) {
        retainedAfterDeduplication.add(locationPath);
      }
    }
    if (normalized.skipExtras) {
      statistics.extrasRemoved = removeExtras(media);
    }
    statistics.afterDeduplication = media.length;

    // JSON/EXIF 解析主要受磁盘等待影响；固定并发处理，所有结果仍只写回各自的 MediaRecord。
    await mapConcurrent(
      media,
      normalized.workers,
      async (item) => {
        const result = await extractDate(item.firstFile, normalized, context);
        if (result !== null && result !== undefined) {
          item.dateTaken = result.value;
          item.dateSource = result.source;
          item.dateAccuracy = result.accuracy;
        }
      },
      {
        checkCancelled: () => context.checkCancelled(),
        onProgress: (item, _index, completed) => {
          context.progress(
            Phase.DATING,
            completed,
            media.length,
            `提取日期：${path.basename(item.firstFile)}`,
          );
        },
      },
    );

    context.progress(Phase.MERGING_ALBUMS, 0, media.length, "正在合并相册关系…");
    statistics.albumGroupsMerged = await mergeAlbums(media, context, normalized.hashChunkSize);
    statistics.dated = media.filter((item) => item.dateTaken !== null && item.dateTaken !== undefined)
      .length;
    statistics.unknownDates = media.length - statistics.dated;
    const duplicateGroups = finalizeDuplicateGroups(
      duplicateSnapshots,
      media,
      retainedAfterDeduplication,
    );
    statistics.duplicateGroups = duplicateGroups.length;
    statistics.duplicateFiles = duplicateGroups.reduce(
      (sum, group) => sum + group.redundantCount,
      0,
    );
    context.progress(Phase.MERGING_ALBUMS, media.length, media.length, "相册关系已合并");
    return new AnalysisResult({
      options: normalized,
      media,
      statistics,
      yearFolders: discovery.yearFolders,
      albumFolders: discovery.albumFolders,
      usedFallbackScan: discovery.usedFallbackScan,
      duplicateGroups,
    });
  }

  /**
   * 依据分析结果创建可预览计划（同步包装 planner.buildPlan）。
   */
  buildPlan(analysis, context = null) {
    return createPlan(analysis, context ?? new TaskContext());
  }

  /**
   * 执行既有计划，不重新扫描。
   */
  async execute(analysis, actions, context = null) {
    return executePlan(analysis, actions, context ?? new TaskContext());
  }

  /**
   * 一次完成分析、计划和执行。
   */
  async run(options, context = null) {
    context = context ?? new TaskContext();
    const analysis = await this.analyze(options, context);
    const actions = this.buildPlan(analysis, context);
    return this.execute(analysis, actions, context);
  }

  /**
   * 递归修复媒体 mtime，并可安全修正严格日期型文件名。
   *
   * @param {import("./models.js").FixDateOptions} options
   * @param {import("./models.js").TaskContext|null} [context]
   * @returns {Promise<import("./models.js").FixDateResult>}
   */
  async fixDates(options, context = null) {
    context = context ?? new TaskContext();
    const root = resolveUserPath(options.inputDir);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(root).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new ValidationError("日期修复目录不存在或不是文件夹");
    }
    if (
      !(options.useJson || options.useExif || options.useFilename || options.useFileMtime)
    ) {
      throw new ValidationError("日期修复至少需要启用一种日期来源");
    }
    const files = await scanMediaFolder(root, options.recursive, options.includeHidden, context);
    const result = new FixDateResult({ total: files.length });

    const reservedTargets = new Set();
    const normalizedReservedTargets = new Set();
    const extractedByPath = new Map();

    for (let index = 1; index <= files.length; index += 1) {
      const filePath = files[index - 1];
      context.checkCancelled();
      const extracted = await extractDate(filePath, null, context, {
        useJson: options.useJson,
        useExif: options.useExif,
        useFilename: options.useFilename,
        aggressiveJson: options.aggressiveJson,
        useFileMtime: options.useFileMtime,
        maxExifBytes: options.maxExifBytes,
      });
      let value = extracted;
      if (options.correctDateFilenames) {
        const organizedDate = organizedFolderMtime(filePath);
        if (
          organizedDate !== null &&
          (value === null || value === undefined || value.source === DateSource.FILENAME)
        ) {
          // 文件名本身就是已知错误来源时，只有 YYYY/MM 目录与 mtime
          // 互相印证才使用它；普通目录和 date-unknown 绝不会走此分支。
          value = new DateExtractionResult(
            organizedDate,
            DateSource.FILE_MTIME,
            FILE_MTIME_ACCURACY,
          );
        }
      }
      extractedByPath.set(filePath, value);
      context.progress(Phase.DATING, index, files.length, `提取日期：${path.basename(filePath)}`);
    }

    let renameTargets;
    const renameBundles = [];
    let renameExamples = [];
    if (options.correctDateFilenames) {
      // 已整理目录中的实况静态图通常有 EXIF，而 MOV 只能从旧文件名得到
      // 错误日期。只对内容确认的一一配对共享更可靠的日期，保证两半同名。
      const confirmedLiveMatches = [];
      const filesByParent = new Map();
      for (const filePath of files) {
        const parent = path.dirname(filePath);
        const collected = filesByParent.get(parent);
        if (collected === undefined) {
          filesByParent.set(parent, [filePath]);
        } else {
          collected.push(filePath);
        }
      }
      for (const parentFiles of filesByParent.values()) {
        const liveScan = discoverLivePhotoPairs(parentFiles);
        for (const [still, match] of liveScan.matches.entries()) {
          confirmedLiveMatches.push(match);
          const candidates = [];
          const stillExtracted = extractedByPath.get(still);
          if (stillExtracted !== null && stillExtracted !== undefined) {
            candidates.push(stillExtracted);
          }
          const motionExtracted = extractedByPath.get(match.motion);
          if (motionExtracted !== null && motionExtracted !== undefined) {
            candidates.push(motionExtracted);
          }
          if (candidates.length === 0) {
            continue;
          }
          let best = candidates[0];
          for (const candidate of candidates) {
            if (candidate.accuracy < best.accuracy) {
              best = candidate;
            }
          }
          extractedByPath.set(still, best);
          extractedByPath.set(match.motion, best);
        }
      }

      // 先规划全部目标，再改任何文件。确认的实况照片使用成组冲突策略，
      // 即使只有一半目标被占用，两半也会共同追加同一个编号。
      renameTargets = new Map();
      const pairedPaths = new Set();
      for (const match of confirmedLiveMatches) {
        const extracted = extractedByPath.get(match.still);
        if (extracted === null || extracted === undefined) {
          continue;
        }
        const outputStem = correctedDateStem(fileStem(match.still), extracted.value);
        if (outputStem === fileStem(match.still)) {
          continue;
        }
        const [stillTarget, motionTarget] = availableLivePhotoTargets(
          match.still,
          match.motion,
          path.dirname(match.still),
          ConflictMode.RENAME,
          reservedTargets,
          normalizedReservedTargets,
          {
            outputMotionSuffix: fileSuffix(match.motion),
            outputStem,
          },
        );
        const bundle = [
          [match.still, stillTarget],
          [match.motion, motionTarget],
        ];
        renameBundles.push(bundle);
        renameTargets.set(match.still, stillTarget);
        renameTargets.set(match.motion, motionTarget);
        pairedPaths.add(match.still);
        pairedPaths.add(match.motion);
      }

      for (const filePath of files) {
        if (pairedPaths.has(filePath)) {
          continue;
        }
        const extracted = extractedByPath.get(filePath);
        if (extracted === null || extracted === undefined) {
          continue;
        }
        const desired = correctedDateTarget(filePath, extracted.value);
        if (desired === filePath) {
          continue;
        }
        const { target } = availableTarget(
          desired,
          ConflictMode.RENAME,
          reservedTargets,
          normalizedReservedTargets,
        );
        renameTargets.set(filePath, target);
      }
    } else {
      renameTargets = new Map();
    }

    result.renameCandidates = renameTargets.size;
    renameExamples = [...renameTargets.entries()].slice(0, 50);

    for (let index = 1; index <= files.length; index += 1) {
      const filePath = files[index - 1];
      context.checkCancelled();
      const extracted = extractedByPath.get(filePath);
      try {
        if (extracted === null || extracted === undefined) {
          result.unchanged += 1;
        } else {
          if (!options.dryRun) {
            setFileTime(filePath, extracted.value, context);
          }
          result.updated += 1;
        }
      } catch (error) {
        if (error instanceof CancelledError) {
          throw error;
        }
        const message = `无法修复 ${filePath}：${errorText(error)}`;
        result.errors.push(message);
        result.failed += 1;
        context.log("ERROR", message);
      }
      context.progress(Phase.FIXING, index, files.length, `修复日期：${path.basename(filePath)}`);
      context.checkCancelled();
    }

    if (!options.dryRun) {
      const bundledPaths = new Set();
      for (const bundle of renameBundles) {
        context.checkCancelled();
        try {
          await renameFilesNoReplace(bundle, context);
          result.renamed += bundle.length;
        } catch (error) {
          if (error instanceof CancelledError) {
            throw error;
          }
          const message = `无法成组修正实况照片文件名：${errorText(error)}`;
          result.errors.push(message);
          result.failed += bundle.length;
          context.log("ERROR", message);
        }
        for (const [source] of bundle) {
          bundledPaths.add(source);
        }
      }
      for (const [source, target] of renameTargets.entries()) {
        if (bundledPaths.has(source)) {
          continue;
        }
        context.checkCancelled();
        try {
          await renameFileNoReplace(source, target, context);
          result.renamed += 1;
        } catch (error) {
          if (error instanceof CancelledError) {
            throw error;
          }
          const message = `无法修正文件名 ${source}：${errorText(error)}`;
          result.errors.push(message);
          result.failed += 1;
          context.log("ERROR", message);
        }
      }
    }
    context.checkCancelled();
    if (result.renameCandidates) {
      const mode = options.dryRun ? "预计可修正" : "已修正";
      const renameCount = options.dryRun ? result.renameCandidates : result.renamed;
      const details = renameExamples
        .map(([source, target]) => `  - ${path.basename(source)} → ${path.basename(target)}`)
        .join("\n");
      const omitted = renameCount - renameExamples.length;
      const suffix = omitted > 0 ? `\n  - 另有 ${formatComma(omitted)} 个文件` : "";
      context.log(
        "INFO",
        `日期型错误文件名${mode} ${formatComma(renameCount)} 个` +
          (details ? `：\n${details}${suffix}` : ""),
      );
    }
    context.progress(Phase.FINISHED, files.length, files.length, "日期修复完成");
    return result;
  }
}
