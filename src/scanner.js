/**
 * Google Takeout 目录分类与媒体扫描（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * discoverTakeout 是 async，但内部使用同步 fs（与 Python 一样在 worker 线程中运行，
 * 不会阻塞 Web UI 主线程）。
 */

import fs from "node:fs";
import path from "node:path";

import { isHidden, isMediaFile, isRelativeTo, preloadWindowsHiddenAttributes } from "./file-utils.js";
import { discoverLivePhotoPairs } from "./live-photos.js";
import { MediaRecord, Phase } from "./models.js";

export const YEAR_FOLDER_RE = new RegExp(String.raw`^Photos from (?:20|19|18)\d{2}$`);

/** 保持原版规则：英文 `Photos from YYYY`，年份为 1800—2099。 */
export function isYearFolder(dirPath) {
  return YEAR_FOLDER_RE.test(path.basename(dirPath));
}

/**
 * 寻找年份目录与同级相册目录，并生成初始媒体记录。
 *
 * @param {import("./models.js").OrganizeOptions} options
 * @param {import("./models.js").TaskContext} context
 */
export async function discoverTakeout(options, context) {
  const inputDir = options.inputDir;
  const outputDir = options.outputDir;
  const directories = [];
  context.progress(Phase.SCANNING, 0, 0, "正在分析目录结构…");
  // Windows 上批量预载 FILE_ATTRIBUTE_HIDDEN（一次 cmd 枚举），保持与 Python 相同的隐藏过滤；
  // 非 Windows 或枚举不可用时自动退化为点号规则。
  if (!options.includeHidden) {
    preloadWindowsHiddenAttributes(inputDir);
  }

  const outputInsideInput = isRelativeTo(outputDir, inputDir);
  walkTree(inputDir, (child) => {
    context.checkCancelled();
    if (isRelativeTo(child, outputDir) && outputInsideInput) {
      return false;
    }
    if (!options.includeHidden && isHidden(child)) {
      return false;
    }
    directories.push(child);
    return true;
  });

  const yearFolders = directories.filter((item) => isYearFolder(item)).sort(bySortKey);
  const parentsWithYears = new Set(
    yearFolders.map((item) => resolvedPath(path.dirname(item))),
  );
  const albumFolders = directories
    .filter(
      (item) =>
        !isYearFolder(item) && parentsWithYears.has(resolvedPath(path.dirname(item))),
    )
    .sort(bySortKey);

  /** @type {import("./models.js").MediaRecord[]} */
  let records = [];
  let ambiguousLivePhotos = 0;
  let rejectedLivePhotos = 0;
  const sourceFolders = [
    ...yearFolders.map((folder) => [folder, null]),
    ...albumFolders.map((folder) => [folder, path.basename(folder).trim() || "未命名相册"]),
  ];
  for (let index = 0; index < sourceFolders.length; index += 1) {
    const [folder, album] = sourceFolders[index];
    context.checkCancelled();
    context.progress(
      Phase.SCANNING,
      index + 1,
      sourceFolders.length,
      `扫描：${path.basename(folder)}`,
    );
    let children;
    try {
      children = fs.readdirSync(folder).map((name) => path.join(folder, name));
    } catch (error) {
      context.log("WARNING", `无法读取目录 ${folder}：${errorText(error)}`);
      continue;
    }
    children.sort(bySortKey);
    const [folderRecords, ambiguous, rejected] = _recordsFromPaths(
      children,
      album,
      options,
      context,
    );
    records.push(...folderRecords);
    ambiguousLivePhotos += ambiguous;
    rejectedLivePhotos += rejected;
  }

  let usedFallback = false;
  if (records.length === 0 && options.scanAllIfNoTakeout) {
    usedFallback = true;
    context.log("WARNING", "未识别到标准年份目录，已按设置回退为全目录媒体扫描");
    [records, ambiguousLivePhotos, rejectedLivePhotos] = _scanAllMedia(options, context);
  }
  return {
    media: records,
    yearFolders,
    albumFolders,
    usedFallbackScan: usedFallback,
    livePhotoAmbiguous: ambiguousLivePhotos,
    livePhotoRejected: rejectedLivePhotos,
  };
}

/**
 * 供日期修复模式使用的通用媒体扫描（对应 Path.rglob / Path.iterdir 语义）。
 *
 * @param {string} root
 * @param {boolean} recursive
 * @param {boolean} includeHidden
 * @param {import("./models.js").TaskContext} context
 * @returns {Promise<string[]>}
 */
export async function scanMediaFolder(root, recursive, includeHidden, context) {
  /** @type {string[]} */
  const output = [];
  // 与 Python 一致：非递归模式下 root 不可读会直接抛错，递归模式（pathlib.rglob）
  // 会静默跳过不可读目录。
  const candidates = recursive
    ? rglobPaths(root)
    : fs.readdirSync(root).map((name) => path.join(root, name));
  if (!includeHidden) {
    preloadWindowsHiddenAttributes(root);
  }
  for (const filePath of candidates) {
    context.checkCancelled();
    try {
      if (!includeHidden) {
        const relativeParts = relativePartsOf(root, filePath);
        if (relativeParts.some((part) => part.startsWith(".")) || isHidden(filePath)) {
          continue;
        }
      }
      if (!isSymlink(filePath) && isFile(filePath) && isMediaFile(filePath)) {
        output.push(filePath);
      }
    } catch (error) {
      context.log("WARNING", `跳过无法访问的路径 ${filePath}：${errorText(error)}`);
    }
  }
  output.sort(bySortKey);
  return output;
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/**
 * 非标准 Takeout 的安全回退：所有媒体均视为时间线文件。
 *
 * @param {import("./models.js").OrganizeOptions} options
 * @param {import("./models.js").TaskContext} context
 * @returns {[import("./models.js").MediaRecord[], number, number]}
 */
export function _scanAllMedia(options, context) {
  /** @type {import("./models.js").MediaRecord[]} */
  const records = [];
  let ambiguousLivePhotos = 0;
  let rejectedLivePhotos = 0;
  if (!options.includeHidden) {
    preloadWindowsHiddenAttributes(options.inputDir);
  }
  const outputInsideInput = isRelativeTo(options.outputDir, options.inputDir);
  const tree = walkTree(options.inputDir, (child) => {
    if (!(options.includeHidden || !isHidden(child))) {
      return false;
    }
    if (isRelativeTo(child, options.outputDir) && outputInsideInput) {
      return false;
    }
    return true;
  });
  for (const [rootDir, , fileNames] of tree) {
    context.checkCancelled();
    const paths = fileNames.map((name) => path.join(rootDir, name));
    const [folderRecords, ambiguous, rejected] = _recordsFromPaths(
      paths,
      null,
      options,
      context,
    );
    records.push(...folderRecords);
    ambiguousLivePhotos += ambiguous;
    rejectedLivePhotos += rejected;
  }
  return [records, ambiguousLivePhotos, rejectedLivePhotos];
}

/**
 * 扫描一个真实目录；实况照片的两半在这里首次形成复合资产。
 *
 * @param {string[]} paths
 * @param {string|null} album
 * @param {import("./models.js").OrganizeOptions} options
 * @param {import("./models.js").TaskContext} context
 * @returns {[import("./models.js").MediaRecord[], number, number]}
 */
export function _recordsFromPaths(paths, album, options, context) {
  /** @type {string[]} */
  const accessible = [];
  for (const filePath of paths) {
    context.checkCancelled();
    try {
      if (isSymlink(filePath) || !isFile(filePath)) {
        continue;
      }
      if (!options.includeHidden && isHidden(filePath)) {
        continue;
      }
      accessible.push(filePath);
    } catch (error) {
      context.log("WARNING", `跳过无法访问的文件 ${filePath}：${errorText(error)}`);
    }
  }

  const liveScan = options.recognizeLivePhotos
    ? discoverLivePhotoPairs(accessible, context)
    : null;
  const matches = liveScan !== null ? liveScan.matches : new Map();
  /** @type {Map<string, import("./models.js").MediaRecord>} */
  const pairRecords = new Map();
  const consumedMotionPaths = new Set();
  const forcedOrdinaryPaths = new Set();
  const repairedMotionSuffixes =
    liveScan !== null ? liveScan.repairedMotionSuffixes : new Map();
  // 即使候选因一对多或 Apple 标识冲突而不能自动配对，已经按内容确认的
  // 无后缀/.mp/.mp3 视频也必须作为独立媒体进入计划，不能被扩展名过滤器漏掉。
  for (const motionPath of repairedMotionSuffixes.keys()) {
    forcedOrdinaryPaths.add(motionPath);
  }

  // 先验证复合记录的两半都可读取；只有成功构建后才消费动态片段。
  // 任一 stat 失败时回退为独立媒体，后续循环仍会分别尝试保留两者。
  for (const [still, match] of matches) {
    context.checkCancelled();
    let stillSize;
    let motionSize;
    try {
      stillSize = fs.statSync(still).size;
      motionSize = fs.statSync(match.motion).size;
    } catch (error) {
      forcedOrdinaryPaths.add(still);
      forcedOrdinaryPaths.add(match.motion);
      context.log(
        "WARNING",
        `无法建立实况照片复合记录，已退化为独立媒体：${still} + ${match.motion}（${errorText(error)}）`,
      );
      continue;
    }
    pairRecords.set(
      still,
      new MediaRecord(new Map([[album, still]]), {
        size: stillSize + motionSize,
        livePhotoCompanions: new Map([[album, match.motion]]),
        livePhotoMetadata: new Map([[album, match.metadataStatus]]),
        livePhotoEvidence: new Map([[album, match.evidence]]),
        livePhotoRepairedSuffix: new Map([[album, match.repairedSuffix]]),
        livePhotoOutputMotionSuffixes: new Map([[album, match.outputMotionSuffix]]),
      }),
    );
    consumedMotionPaths.add(match.motion);
  }

  /** @type {import("./models.js").MediaRecord[]} */
  const records = [];
  for (const filePath of accessible) {
    context.checkCancelled();
    if (consumedMotionPaths.has(filePath)) {
      continue;
    }
    const pairRecord = pairRecords.get(filePath);
    if (pairRecord !== undefined) {
      records.push(pairRecord);
      continue;
    }
    if (!forcedOrdinaryPaths.has(filePath) && !isMediaFile(filePath)) {
      continue;
    }
    try {
      const outputSuffix = repairedMotionSuffixes.get(filePath);
      records.push(
        new MediaRecord(new Map([[album, filePath]]), {
          size: fs.statSync(filePath).size,
          outputSuffixes: outputSuffix
            ? new Map([[album, outputSuffix]])
            : new Map(),
        }),
      );
    } catch (error) {
      context.log("WARNING", `跳过无法访问的文件 ${filePath}：${errorText(error)}`);
    }
  }
  const ambiguous = liveScan !== null ? liveScan.ambiguous : 0;
  const rejected = liveScan !== null ? liveScan.rejected : 0;
  return [records, ambiguous, rejected];
}

/** 递归遍历目录（os.walk 语义，followlinks=False）；过滤回调决定是否下钻。 */
function walkTree(rootDir, keepChild) {
  /** @type {Array<[string, string[], string[]]>} */
  const output = [];
  const visit = (current) => {
    const { childNames, descendableNames, fileNames } = readDirectoryEntries(current);
    output.push([current, childNames, fileNames]);
    // os.walk(followlinks=False)：符号链接目录会出现在 dirnames 里交给调用方，
    // 但永不递归进入（避免循环链接与重复扫描）。
    const descendable = new Set(descendableNames);
    const kept = keepChild
      ? childNames.filter((name) => keepChild(path.join(current, name)))
      : childNames;
    for (const name of kept) {
      if (descendable.has(name)) {
        visit(path.join(current, name));
      }
    }
  };
  visit(rootDir);
  return output;
}

/**
 * 读取一个目录：子目录名（跟随符号链接判断，与 os.walk 的 dirnames 一致）、
 * 可安全递归的真实子目录名与文件名；无法读取时静默返回空。
 */
function readDirectoryEntries(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { childNames: [], descendableNames: [], fileNames: [] };
  }
  const childNames = [];
  const descendableNames = [];
  const fileNames = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      childNames.push(entry.name);
      descendableNames.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink()) {
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(path.join(dirPath, entry.name)).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (isDirectory) {
        childNames.push(entry.name);
        continue;
      }
    }
    fileNames.push(entry.name);
  }
  return { childNames, descendableNames, fileNames };
}

/** Path.rglob("*") 的等价物：不跟随符号链接目录，不可读目录静默跳过。 */
function* rglobPaths(rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(rootDir, entry.name);
    yield child;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      yield* rglobPaths(child);
    }
  }
}

/** path.relative_to(root).parts 的等价物。 */
function relativePartsOf(root, filePath) {
  return path
    .relative(root, filePath)
    .split(path.sep)
    .filter((part) => part !== "" && part !== ".");
}

function bySortKey(left, right) {
  const leftKey = left.toLowerCase();
  const rightKey = right.toLowerCase();
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return 0;
}

/** Path.resolve() 的等价物：尽量解析符号链接，失败时退回字面绝对路径。 */
function resolvedPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function errorText(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}
