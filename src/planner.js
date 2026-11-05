/**
 * 将分析结果转换为无副作用、可预览的文件操作计划（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * `buildPlan` 是同步函数：只做纯计算与只读 stat，不创建目录、不修改任何文件。
 * Python 的 Path.name/stem/suffix 语义与 node:path 存在少量差异（例如结尾点号），
 * 因此这里保留一组 pathlib 兼容的小工具，保证目标文件名逐字节一致。
 */

import fs from "node:fs";
import path from "node:path";

import { availableTarget } from "./file-utils.js";
import { correctedDateName, correctedDateStem } from "./filename-correction.js";
import { availableLivePhotoTargets } from "./live-photos.js";
import {
  ActionKind,
  AlbumMode,
  DateDivision,
  LivePhotoRole,
  LivePhotoTarget,
  OperationMode,
  Phase,
  PlanAction,
  UnknownDateMode,
} from "./models.js";

/**
 * 取路径最后一段（等价 pathlib.PurePath.name）。
 *
 * @param {string} filePath
 * @returns {string}
 */
function baseName(filePath) {
  return path.basename(String(filePath));
}

/**
 * pathlib.PurePath.suffix 的语义：最后一个点号必须存在且不在首尾。
 *
 * @param {string} name
 * @returns {string}
 */
function pySuffix(name) {
  const index = name.lastIndexOf(".");
  if (index > 0 && index < name.length - 1) {
    return name.slice(index);
  }
  return "";
}

/**
 * pathlib.PurePath.stem 的语义（`foo.` 的 stem 仍是 `foo.`）。
 *
 * @param {string} name
 * @returns {string}
 */
function pyStem(name) {
  const suffix = pySuffix(name);
  return suffix ? name.slice(0, -suffix.length) : name;
}

/**
 * Python str 比较按 Unicode 码点；JS 的 `<` 按 UTF-16 代码单元，
 * 对增补平面字符顺序可能不同，因此显式按码点比较。
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareCodePoints(left, right) {
  const a = String(left);
  const b = String(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const codeA = a.codePointAt(index);
    const codeB = b.codePointAt(index);
    if (codeA !== codeB) {
      return codeA < codeB ? -1 : 1;
    }
    if (codeA > 0xffff) {
      index += 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

/**
 * Python `str.casefold()` 的近似实现（JS 没有原生 casefold）。
 *
 * 先 toUpperCase 再 toLowerCase 可以覆盖绝大多数常见折叠（如 ß→ss），
 * 与 Python 完整 Unicode CaseFolding 只在极少数特殊字符上有差异。
 *
 * @param {string} text
 * @returns {string}
 */
function casefold(text) {
  return String(text).toUpperCase().toLowerCase();
}

/**
 * 创建完整计划；此函数不创建目录，也不修改任何文件。
 *
 * @param {import("./models.js").AnalysisResult} analysis
 * @param {import("./models.js").TaskContext} context
 * @returns {import("./models.js").PlanAction[]}
 */
export function buildPlan(analysis, context) {
  const options = analysis.options;
  /** @type {import("./models.js").PlanAction[]} */
  const actions = [];
  /** @type {Set<string>} */
  const reserved = new Set();
  /** @type {Set<string>} */
  const normalizedReserved = new Set();
  const total = analysis.media.length;
  let livePhotoBundleNumber = 0;

  for (let index = 0; index < analysis.media.length; index += 1) {
    const item = analysis.media[index];
    const position = index + 1;
    context.checkCancelled();
    context.progress(Phase.PLANNING, position, total, `规划输出：${baseName(item.firstFile)}`);

    if (
      item.dateTaken === null &&
      options.unknownDateMode === UnknownDateMode.SKIP &&
      !item.isLivePhoto
    ) {
      actions.push(
        new PlanAction({
          kind: ActionKind.SKIP,
          source: item.firstFile,
          target: null,
          media: item,
          reason: "日期未知，按设置跳过",
        }),
      );
      continue;
    }

    const entries = entriesForItem(item.locations, options.albumMode);
    /** @type {string|null} */
    let mainTarget = null;
    for (const [album, source] of entries) {
      const folder = outputFolder(analysis, album, item.dateTaken);
      const sourceAlbum = firstKeyWithValue(item.locations, source, album);
      const companion = item.companionFor(sourceAlbum);

      if (companion !== null) {
        livePhotoBundleNumber += 1;
        const bundleId = `live-photo-${String(livePhotoBundleNumber).padStart(6, "0")}`;
        if (folder === null) {
          for (const [role, component] of [
            [LivePhotoRole.STILL, source],
            [LivePhotoRole.MOTION, companion],
          ]) {
            actions.push(
              new PlanAction({
                kind: ActionKind.SKIP,
                source: component,
                target: null,
                media: item,
                album,
                reason: "日期未知，整组实况照片按设置跳过",
                bundleId,
                livePhotoRole: role,
                sizeBytes: safeSize(component),
              }),
            );
          }
          continue;
        }

        const liveTargets = availableLivePhotoTargets(
          source,
          companion,
          folder,
          options.conflictMode,
          reserved,
          normalizedReserved,
          {
            outputMotionSuffix: item.outputMotionSuffixFor(sourceAlbum),
            outputStem: options.correctDateFilenames
              ? correctedDateStem(pyStem(baseName(source)), item.dateTaken)
              : null,
          },
        );
        const stillTarget = liveTargets.stillTarget;
        const motionTarget = liveTargets.motionTarget;
        const skipped = liveTargets.skipped;
        let reason = skipped
          ? "实况照片任一半发生同名冲突，已整组跳过"
          : options.livePhotoTarget === LivePhotoTarget.COLOROS16
            ? "实况照片保留原始配对；可导入 Apple 照片后通过 O+ 互联发送到 OPPO"
            : album !== null && options.albumMode === AlbumMode.SHORTCUT
              ? "实况照片为保持设备可导入配对，使用同目录同基名实体文件"
              : "实况照片静态图与动态片段成组输出，供 Apple 照片共同导入";
        if (
          !skipped &&
          options.correctDateFilenames &&
          correctedDateStem(pyStem(baseName(source)), item.dateTaken) !== pyStem(baseName(source))
        ) {
          reason += "；文件名日期已按拍摄日期修正";
        }
        const kind = skipped
          ? ActionKind.SKIP
          : options.operation === OperationMode.COPY
            ? ActionKind.COPY
            : ActionKind.MOVE;
        for (const [role, component, target] of [
          [LivePhotoRole.STILL, source, stillTarget],
          [LivePhotoRole.MOTION, companion, motionTarget],
        ]) {
          actions.push(
            new PlanAction({
              kind,
              source: component,
              target,
              media: item,
              album,
              reason,
              bundleId,
              livePhotoRole: role,
              sizeBytes: safeSize(component),
            }),
          );
        }
        if (album === null && !skipped) {
          mainTarget = stillTarget;
        }
        continue;
      }

      if (folder === null) {
        actions.push(
          new PlanAction({
            kind: ActionKind.SKIP,
            source,
            target: null,
            media: item,
            album,
            reason: "没有可用输出目录",
          }),
        );
        continue;
      }

      if (options.albumMode === AlbumMode.SHORTCUT && album !== null && mainTarget) {
        const name = baseName(mainTarget) + (process.platform === "win32" ? ".lnk" : "");
        const shortcutTarget = availableTarget(
          path.join(folder, name),
          options.conflictMode,
          reserved,
          normalizedReserved,
        );
        if (shortcutTarget.skipped) {
          actions.push(
            new PlanAction({
              kind: ActionKind.SKIP,
              source: mainTarget,
              target: shortcutTarget.target,
              media: item,
              album,
              reason: "快捷方式同名冲突",
            }),
          );
        } else {
          // 兜底只有在快捷方式真正失败时才会发生。这里只记录理想位置，
          // 执行时再结合其余计划动态改名，避免“幽灵预留”误伤正常媒体。
          const fallbackTarget = path.join(
            folder,
            outputName(
              source,
              item.outputSuffixFor(sourceAlbum),
              item.dateTaken,
              options.correctDateFilenames,
            ),
          );
          actions.push(
            new PlanAction({
              kind: ActionKind.SHORTCUT,
              source: mainTarget,
              target: shortcutTarget.target,
              media: item,
              album,
              fallbackSource: source,
              fallbackTarget,
            }),
          );
        }
        continue;
      }

      const name = outputName(
        source,
        item.outputSuffixFor(sourceAlbum),
        item.dateTaken,
        options.correctDateFilenames,
      );
      const plannedTarget = availableTarget(
        path.join(folder, name),
        options.conflictMode,
        reserved,
        normalizedReserved,
      );
      let action;
      if (plannedTarget.skipped) {
        action = new PlanAction({
          kind: ActionKind.SKIP,
          source,
          target: plannedTarget.target,
          media: item,
          album,
          reason: "目标同名，按设置跳过",
        });
      } else {
        const kind =
          options.operation === OperationMode.COPY ? ActionKind.COPY : ActionKind.MOVE;
        action = new PlanAction({
          kind,
          source,
          target: plannedTarget.target,
          media: item,
          album,
        });
        action.sizeBytes = safeSize(source);
        if (
          name !==
          outputName(source, item.outputSuffixFor(sourceAlbum), item.dateTaken, false)
        ) {
          action.reason = "文件名日期已按拍摄日期修正";
        }
      }
      actions.push(action);
      if (album === null && !plannedTarget.skipped) {
        // 只有本次计划确实会生成主文件时才创建相册快捷方式。冲突跳过的
        // 既有同名文件可能内容完全不同，绝不能把相册指向它。
        mainTarget = plannedTarget.target;
      }
    }
  }

  analysis.statistics.plannedActions = actions.length;
  return actions;
}

/**
 * 返回 locations 中第一个取值为 source 的键；没有匹配时返回 fallback。
 *
 * @param {Map<string|null, string>} locations
 * @param {string} source
 * @param {string|null} fallback
 * @returns {string|null}
 */
function firstKeyWithValue(locations, source, fallback) {
  for (const [key, value] of locations.entries()) {
    if (value === source) {
      return key;
    }
  }
  return fallback;
}

/**
 * 在只读规划阶段记录组件大小，执行后源文件移动也不影响统计。
 *
 * @param {string} filePath
 * @returns {number|null}
 */
function safeSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * 补全容器后缀，并按可选规则修正严格日期型文件名。
 *
 * @param {string} source
 * @param {string|null} suffixOverride
 * @param {Date|null} dateTaken
 * @param {boolean} correctDateFilenames
 * @returns {string}
 */
function outputName(source, suffixOverride, dateTaken, correctDateFilenames) {
  const sourceName = baseName(source);
  let name;
  if (!suffixOverride) {
    name = sourceName;
  } else {
    const suffix = suffixOverride.startsWith(".") ? suffixOverride : `.${suffixOverride}`;
    name =
      casefold(pySuffix(sourceName)) === casefold(suffix)
        ? sourceName
        : `${pyStem(sourceName)}${suffix}`;
  }
  return correctDateFilenames ? correctedDateName(name, dateTaken) : name;
}

/**
 * 根据四种相册策略选出需要输出的位置及顺序。
 *
 * @param {Map<string|null, string>} locations
 * @param {string} albumMode
 * @returns {Array<[string|null, string]>}
 */
function entriesForItem(locations, albumMode) {
  if (albumMode === AlbumMode.JSON) {
    return [[null, locations.values().next().value]];
  }
  if (albumMode === AlbumMode.NOTHING) {
    return locations.has(null) ? [[null, locations.get(null)]] : [];
  }
  const entries = [...locations.entries()];
  entries.sort((left, right) => {
    const leftHasAlbum = left[0] !== null;
    const rightHasAlbum = right[0] !== null;
    if (leftHasAlbum !== rightHasAlbum) {
      return leftHasAlbum ? 1 : -1;
    }
    return compareCodePoints(left[0] ?? "", right[0] ?? "");
  });
  return entries;
}

/**
 * 计算一个输出位置对应的目标目录；日期未知且设置为 skip 时返回 null。
 *
 * @param {import("./models.js").AnalysisResult} analysis
 * @param {string|null} album
 * @param {Date|null} dateTaken
 * @returns {string|null}
 */
function outputFolder(analysis, album, dateTaken) {
  const options = analysis.options;
  const component = album === null ? options.allPhotosFolder : safeAlbumName(album);
  const base = path.join(options.outputDir, component);
  if (dateTaken === null) {
    if (options.unknownDateMode === UnknownDateMode.SKIP) {
      return null;
    }
    if (options.unknownDateMode === UnknownDateMode.FOLDER) {
      return path.join(base, options.unknownDateFolder);
    }
    return base;
  }
  if (options.dateDivision === DateDivision.YEAR) {
    return path.join(base, zeroPad(dateTaken.getFullYear(), 4));
  }
  if (options.dateDivision === DateDivision.YEAR_MONTH) {
    return path.join(
      base,
      zeroPad(dateTaken.getFullYear(), 4),
      zeroPad(dateTaken.getMonth() + 1, 2),
    );
  }
  return base;
}

/**
 * 相册名来自真实目录，但输出到另一平台前仍需替换保留字符。
 *
 * @param {string} name
 * @returns {string}
 */
function safeAlbumName(name) {
  const forbidden = '<>:"/\\|?*';
  let cleaned = "";
  for (const char of String(name).trim()) {
    cleaned += forbidden.includes(char) ? "_" : char;
  }
  cleaned = cleaned.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  return cleaned.slice(0, 120) || "未命名相册";
}

/**
 * 左侧补零。
 *
 * @param {number} value
 * @param {number} width
 * @returns {string}
 */
function zeroPad(value, width) {
  return String(value).padStart(width, "0");
}
