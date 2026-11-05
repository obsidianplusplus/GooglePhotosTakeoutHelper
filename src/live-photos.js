/**
 * Apple 实况照片的安全识别、元数据校验与成组目标规划（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * 探测策略与 Python 版本完全一致：只读文件首尾 256 KiB 边缘窗口，并按 ISO-BMFF
 * 顶层盒结构跳过 mdat/free/skip/wide，仅完整读取体积有限的元数据盒（大盒只取两端）。
 * 这样上千个动态片段不会累计产生十几 GiB 的无效磁盘读取。
 */

import fs from "node:fs";
import path from "node:path";

import { conflictKey, _pathStem, _pathSuffix } from "./file-utils.js";
import { ConflictMode, LivePhotoMetadataStatus } from "./models.js";

// Apple Live Photo 的静态半部通常是 HEIC/HEIF 或 JPEG。其它图片即使同名，
// 也不自动和视频配对，避免把普通截图、封面图误判为实况照片。
export const LIVE_PHOTO_STILL_EXTENSIONS = new Set([".jpg", ".jpeg", ".jpe", ".heic", ".heif"]);
export const KNOWN_MOTION_EXTENSIONS = new Set([".mov", ".mp4", ".m4v"]);
export const SUSPECT_MOTION_EXTENSIONS = new Set(["", ".mp", ".mp3"]);

// Apple 的配对标识和视频轨信息位于 ISO-BMFF 的 moov/meta 等元数据盒，
// 大体积像素/视频数据则位于 mdat。Apple HEIC 的内容标识有时作为 item 数据
// 落在 mdat 开头（真实样本约 96 KiB 偏移），因此保留 256 KiB 边缘窗口。
const EDGE_PROBE_BYTES = 256 * 1024;
const MAX_METADATA_BOX_BYTES = 8 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 4096;
const UUID_PATTERN_SOURCE = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
const UUID_PATTERN = new RegExp(UUID_PATTERN_SOURCE, "i");
// re.I/bytes 的等价物：作用在 latin1 文本上，只匹配 ASCII 十六进制字符。
const UUID_PATTERN_GLOBAL = new RegExp(UUID_PATTERN_SOURCE, "gi");
const CONTENT_IDENTIFIER_KEY = Buffer.from("com.apple.quicktime.content.identifier", "latin1");
const STILL_IMAGE_TIME_KEY = Buffer.from("com.apple.quicktime.still-image-time", "latin1");
const FTYP_BOX = Buffer.from("ftyp", "latin1");
const HDLR_BOX = Buffer.from("hdlr", "latin1");
const VIDE_HANDLER = Buffer.from("vide", "latin1");
const QT_MAJOR_BRAND = Buffer.from("qt  ", "latin1");
const SKIPPED_BOX_TYPES = [
  Buffer.from("mdat", "latin1"),
  Buffer.from("free", "latin1"),
  Buffer.from("skip", "latin1"),
  Buffer.from("wide", "latin1"),
];
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** 动态片段的容器、视频轨和 Apple 元数据探测结果。 */
export class MotionProbe {
  /**
   * @param {Buffer} majorBrand 4 字节 major brand
   * @param {string|null} contentIdentifier
   * @param {boolean} hasStillImageTime
   */
  constructor(majorBrand, contentIdentifier, hasStillImageTime) {
    this.majorBrand = majorBrand;
    this.contentIdentifier = contentIdentifier;
    this.hasStillImageTime = hasStillImageTime;
  }

  /** 仅用于修复明显错误后缀，不对媒体做任何转码。 */
  get canonicalSuffix() {
    return this.majorBrand.equals(QT_MAJOR_BRAND) ? ".mov" : ".mp4";
  }
}

/** 同一目录内经内容确认的静态图和动态片段。 */
export class LivePhotoMatch {
  /**
   * @param {{still: string, motion: string, metadataStatus: string, evidence: string,
   *          outputMotionSuffix: string, repairedSuffix: boolean}} init
   */
  constructor(init = {}) {
    this.still = init.still;
    this.motion = init.motion;
    this.metadataStatus = init.metadataStatus;
    this.evidence = init.evidence;
    this.outputMotionSuffix = init.outputMotionSuffix;
    this.repairedSuffix = Boolean(init.repairedSuffix);
  }
}

/** 一个来源目录的配对结果与拒绝自动判断的歧义数量。 */
export class LivePhotoScanResult {
  /**
   * @param {{matches?: Map<string, LivePhotoMatch>, ambiguous?: number, rejected?: number,
   *          repairedMotionSuffixes?: Map<string, string>}} init
   */
  constructor(init = {}) {
    this.matches = init.matches ?? new Map();
    this.ambiguous = init.ambiguous ?? 0;
    this.rejected = init.rejected ?? 0;
    // 包含所有已经按文件内容确认、且扩展名需要修复的视频，不局限于成功配对项。
    // 扫描器据此保证歧义组里的无后缀视频也不会被静默漏掉。
    this.repairedMotionSuffixes = init.repairedMotionSuffixes ?? new Map();
  }

  get motionPaths() {
    return new Set([...this.matches.values()].map((match) => match.motion));
  }
}

/**
 * 按同目录同基名生成候选，并用容器签名和视频轨确认动态半部。
 *
 * 同名只是候选条件。动态文件还必须包含 ISO-BMFF ftyp 盒和 vide 处理器；
 * 因此真正的 MP3 音频不会被改名或误配。
 *
 * @param {string[]} paths
 * @param {{log: (level: string, message: string) => void}|null} [context]
 * @returns {LivePhotoScanResult}
 */
export function discoverLivePhotoPairs(paths, context = null) {
  /** @type {Map<string, string[]>} */
  const stills = new Map();
  /** @type {Map<string, string[]>} */
  const others = new Map();
  for (const filePath of paths) {
    const suffix = _pathSuffix(filePath).toLowerCase();
    const key = normalisedStem(filePath);
    if (LIVE_PHOTO_STILL_EXTENSIONS.has(suffix)) {
      const list = stills.get(key);
      if (list) {
        list.push(filePath);
      } else {
        stills.set(key, [filePath]);
      }
    } else if (KNOWN_MOTION_EXTENSIONS.has(suffix) || SUSPECT_MOTION_EXTENSIONS.has(suffix)) {
      const list = others.get(key);
      if (list) {
        list.push(filePath);
      } else {
        others.set(key, [filePath]);
      }
    }
  }

  // 对可疑后缀（无后缀、.mp、.mp3）即使没有同名静态图也做一次内容探测，
  // 否则一个真实视频会被普通扩展名过滤器直接漏掉。标准视频只在存在同名
  // 静态候选时探测，避免对无关视频增加扫描成本。
  /** @type {Map<string, MotionProbe>} */
  const probes = new Map();
  for (const [stemKey, candidates] of others) {
    for (const motion of candidates) {
      if (!SUSPECT_MOTION_EXTENSIONS.has(_pathSuffix(motion).toLowerCase()) && !stills.has(stemKey)) {
        continue;
      }
      const probe = probeMotionFile(motion);
      if (probe !== null) {
        probes.set(motion, probe);
      }
    }
  }

  /** @type {Map<string, string>} */
  const repairedMotionSuffixes = new Map();
  for (const [motion, probe] of probes) {
    if (needsSuffixRepair(motion, probe)) {
      repairedMotionSuffixes.set(motion, probe.canonicalSuffix);
    }
  }

  /** @type {Map<string, LivePhotoMatch>} */
  const matches = new Map();
  let ambiguous = 0;
  let rejected = 0;
  const ambiguityDetails = [];
  const rejectionDetails = [];
  for (const [stemKey, imageCandidates] of stills) {
    const motionCandidates = [];
    for (const motion of others.get(stemKey) ?? []) {
      if (probes.has(motion)) {
        motionCandidates.push([motion, probes.get(motion)]);
      }
    }

    if (motionCandidates.length === 0) {
      continue;
    }
    if (imageCandidates.length !== 1 || motionCandidates.length !== 1) {
      ambiguous += 1;
      ambiguityDetails.push(ambiguityDescription(imageCandidates, motionCandidates));
      continue;
    }

    const still = imageCandidates[0];
    const [motion, probe] = motionCandidates[0];
    const metadataStatus = verifyApplePairMetadata(still, probe);
    const evidence = evidenceText(metadataStatus);
    if (metadataStatus === LivePhotoMetadataStatus.CONFLICT) {
      rejected += 1;
      rejectionDetails.push(`${path.basename(still)} + ${path.basename(motion)}`);
      continue;
    }
    const repaired = needsSuffixRepair(motion, probe);
    matches.set(
      still,
      new LivePhotoMatch({
        still,
        motion,
        metadataStatus,
        evidence,
        outputMotionSuffix: repaired ? probe.canonicalSuffix : _pathSuffix(motion),
        repairedSuffix: repaired,
      }),
    );
  }
  if (context !== null && context !== undefined) {
    logDiscoverySummary(context, repairedMotionSuffixes, probes, ambiguityDetails, rejectionDetails);
  }
  return new LivePhotoScanResult({
    matches,
    ambiguous,
    rejected,
    repairedMotionSuffixes,
  });
}

/** 确认文件是含视频轨的 MOV/MP4，并读取可见的 Apple 配对元数据。 */
export function probeMotionFile(filePath) {
  const data = containerMetadataSample(filePath);
  if (data === null) {
    return null;
  }
  const [head, sample] = data;
  const majorBrand = findFtypBrand(head.subarray(0, 64 * 1024));
  if (majorBrand === null || !containsVideoHandler(sample)) {
    return null;
  }

  const identifier = quicktimeContentIdentifier(sample);
  return new MotionProbe(majorBrand, identifier, sample.indexOf(STILL_IMAGE_TIME_KEY) >= 0);
}

/** 只读核对 Apple 内容标识与关键帧元数据，不修改媒体字节。 */
export function verifyApplePairMetadata(stillPath, motionProbe) {
  const motionIdentifier = motionProbe.contentIdentifier;
  if (motionIdentifier === null || motionIdentifier === undefined) {
    return LivePhotoMetadataStatus.MISSING;
  }
  const stillIdentifiers = fileUuids(stillPath);
  if (stillIdentifiers.size === 0) {
    return LivePhotoMetadataStatus.MISSING;
  }
  if (!stillIdentifiers.has(motionIdentifier.toLowerCase())) {
    return LivePhotoMetadataStatus.CONFLICT;
  }
  if (!motionProbe.hasStillImageTime) {
    return LivePhotoMetadataStatus.UNKNOWN;
  }
  return LivePhotoMetadataStatus.VERIFIED;
}

/** 返回动态片段目标后缀；只有错误/缺失后缀才按内容修复。 */
export function preferredMotionSuffix(filePath) {
  const suffix = _pathSuffix(filePath).toLowerCase();
  if (KNOWN_MOTION_EXTENSIONS.has(suffix) && suffix !== ".mp4") {
    return _pathSuffix(filePath);
  }
  const probe = probeMotionFile(filePath);
  if (probe === null) {
    return _pathSuffix(filePath);
  }
  if (suffix === ".mp4" && !probe.majorBrand.equals(QT_MAJOR_BRAND)) {
    return _pathSuffix(filePath);
  }
  return probe.canonicalSuffix;
}

/** 返回用于整组大小和摘要的主来源路径，静态图始终排在前面。 */
export function recordSourcePaths(mediaRecord) {
  const locations = mediaRecord.locations;
  const album = locations.keys().next().value;
  const companion =
    typeof mediaRecord.companionFor === "function"
      ? mediaRecord.companionFor(album)
      : mediaRecord.livePhotoCompanions?.get(album) ?? null;
  const firstFile =
    mediaRecord.firstFile ??
    mediaRecord.first_file ??
    locations.values().next().value;
  return companion !== null && companion !== undefined ? [firstFile, companion] : [firstFile];
}

/** 计算复合媒体资产的物理总大小。 */
export function recordTotalSize(mediaRecord) {
  let total = 0;
  for (const sourcePath of recordSourcePaths(mediaRecord)) {
    total += fs.statSync(sourcePath).size;
  }
  return total;
}

/**
 * 为静态图和动态片段共同选择一个无冲突基名。
 *
 * 任一半冲突时，两半必须一起重命名或一起跳过，绝不产生
 * IMG_1.HEIC + IMG_1(1).MOV 这样的断裂配对。
 */
export function availableLivePhotoTargets(
  still,
  motion,
  folder,
  mode,
  reserved,
  normalizedReserved,
  { outputMotionSuffix = null, outputStem = null } = {},
) {
  const stillSuffix = _pathSuffix(still);
  // 扫描阶段已经完成容器探测时直接复用结果，避免规划阶段再次读取大文件。
  const motionSuffix = outputMotionSuffix || preferredMotionSuffix(motion);
  const baseStem = outputStem || _pathStem(still);

  const candidates = (number) => {
    const stem = number === null || number === undefined ? baseStem : `${baseStem}(${number})`;
    return [
      path.join(folder, `${stem}${stillSuffix}`),
      path.join(folder, `${stem}${motionSuffix}`),
    ];
  };

  const desired = candidates(null);
  let [occupied, planned] = pairOccupancy(desired, normalizedReserved);
  if (!occupied || (mode === ConflictMode.OVERWRITE && !planned)) {
    reservePair(desired, reserved, normalizedReserved);
    return { stillTarget: desired[0], motionTarget: desired[1], skipped: false };
  }
  if (mode === ConflictMode.SKIP) {
    return { stillTarget: desired[0], motionTarget: desired[1], skipped: true };
  }

  let number = 1;
  for (;;) {
    const pair = candidates(number);
    [occupied] = pairOccupancy(pair, normalizedReserved);
    if (!occupied) {
      reservePair(pair, reserved, normalizedReserved);
      return { stillTarget: pair[0], motionTarget: pair[1], skipped: false };
    }
    number += 1;
  }
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** 判断目标文件名是否需要按已确认容器补后缀。 */
function needsSuffixRepair(filePath, probe) {
  const suffix = _pathSuffix(filePath).toLowerCase();
  return (
    !KNOWN_MOTION_EXTENSIONS.has(suffix) ||
    (suffix === ".mp4" && probe.majorBrand.equals(QT_MAJOR_BRAND))
  );
}

/** 生成足以解释多候选根因的紧凑明细。 */
function ambiguityDescription(images, motions) {
  const stemPath = path.join(path.dirname(images[0]), _pathStem(images[0]));
  const imageText = images.map(fileSummary).join("、");
  const motionText = motions
    .map(
      ([filePath, probe]) =>
        `${fileSummary(filePath)} / 容器 ${decodeBrand(probe.majorBrand) || "未知"}` +
        ` / Apple ID ${probe.contentIdentifier ? "有" : "无"}`,
    )
    .join("、");
  return (
    `${stemPath}：静态候选 ${images.length} 个 [${imageText}]；` +
    `视频候选 ${motions.length} 个 [${motionText}]`
  );
}

function fileSummary(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    return `${path.basename(filePath)}（${(size / (1024 * 1024)).toFixed(2)} MiB）`;
  } catch {
    return `${path.basename(filePath)}（大小不可读）`;
  }
}

/** 按目录批量写日志，避免数百次 UI 文本更新放大扫描卡顿。 */
function logDiscoverySummary(context, repaired, probes, ambiguities, rejections) {
  if (repaired.size > 0) {
    const details = [...repaired]
      .map(
        ([filePath, suffix]) =>
          `  - ${filePath}：原扩展名 ${_pathSuffix(filePath) || "（无）"}，` +
          `容器 ${decodeBrand(probes.get(filePath).majorBrand) || "未知"}，输出补为 ${suffix}`,
      )
      .join("\n");
    context.log(
      "INFO",
      `检测到 ${repaired.size} 个内容为真实视频但扩展名缺失或错误的文件。` +
        "源文件字节不会改变；仅给输出副本/移动目标补正确后缀：\n" +
        details,
    );
  }
  if (ambiguities.length > 0) {
    context.log(
      "WARNING",
      `检测到 ${ambiguities.length} 组实况照片多候选歧义。该判断发生在内容去重前，` +
        "与去重无关；现有 Apple 标识不足以形成唯一配对，因此全部按独立媒体保留：\n" +
        ambiguities.map((detail) => `  - ${detail}`).join("\n"),
    );
  }
  if (rejections.length > 0) {
    context.log(
      "WARNING",
      `检测到 ${rejections.length} 组 Apple 内容标识冲突，已拒绝自动配对并按独立媒体保留：\n` +
        rejections.map((detail) => `  - ${detail}`).join("\n"),
    );
  }
}

/** 结构化读取容器元数据；普通 JPEG 等格式安全退化为首尾探针。 */
function containerMetadataSample(filePath) {
  let descriptor = null;
  try {
    const size = fs.statSync(filePath).size;
    if (size < 12) {
      return null;
    }
    descriptor = fs.openSync(filePath, "r");
    const edgeSize = Math.min(size, EDGE_PROBE_BYTES);
    const head = readAt(descriptor, 0, edgeSize);
    const chunks = [head];
    if (size > edgeSize) {
      const position = Math.max(size - EDGE_PROBE_BYTES, 0);
      chunks.push(readAt(descriptor, position, EDGE_PROBE_BYTES));
    }

    // 只有顶层 ftyp 盒成立时才按 BMFF 结构跳转；JPEG/其它静态图只用
    // 首尾样本，绝不会把随机四字节解释成超大 seek。
    if (findFtypBrand(head) !== null) {
      for (const [boxType, offset, boxSize] of topLevelBoxes(descriptor, size)) {
        if (SKIPPED_BOX_TYPES.some((skipped) => skipped.equals(boxType))) {
          continue;
        }
        chunks.push(...readBoxSample(descriptor, offset, boxSize));
      }
    }
    return [head, Buffer.concat(chunks)];
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // 与 with 语义一致：关闭失败不影响已有结果。
      }
    }
  }
}

/** 只遍历 ISO-BMFF 顶层盒头；通过 seek 跳过媒体载荷。 */
function* topLevelBoxes(descriptor, fileSize) {
  let offset = 0;
  for (let number = 0; number < MAX_TOP_LEVEL_BOXES; number += 1) {
    if (offset + 8 > fileSize) {
      return;
    }
    const header = readAt(descriptor, offset, 16);
    if (header.length < 8) {
      return;
    }
    let boxSize = header.readUInt32BE(0);
    const boxType = header.subarray(4, 8);
    let headerSize = 8;
    if (boxSize === 1) {
      if (header.length < 16) {
        return;
      }
      boxSize = readUInt64AsNumber(header, 8);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = fileSize - offset;
    }
    if (boxSize < headerSize || offset + boxSize > fileSize) {
      return;
    }
    yield [boxType, offset, boxSize];
    offset += boxSize;
  }
}

/** 小元数据盒完整读取，异常大的盒只取两端以限制内存与 I/O。 */
function readBoxSample(descriptor, offset, boxSize) {
  if (boxSize <= MAX_METADATA_BOX_BYTES) {
    return [readAt(descriptor, offset, boxSize)];
  }
  const half = MAX_METADATA_BOX_BYTES / 2;
  const first = readAt(descriptor, offset, half);
  const last = readAt(descriptor, offset + boxSize - half, half);
  return [first, last];
}

/** 从指定偏移读取至多 length 字节（对应 Python stream.read）。 */
function readAt(descriptor, position, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(descriptor, buffer, total, length - total, position + total);
    } catch (error) {
      if (total > 0 && (error.code === "EOF" || error.code === "EISDIR")) {
        break;
      }
      throw error;
    }
    if (bytesRead <= 0) {
      break;
    }
    total += bytesRead;
  }
  return total === length ? buffer : buffer.subarray(0, total);
}

/** 读取大端 64 位盒长；超出 JS 安全整数范围时按无穷大处理。 */
function readUInt64AsNumber(buffer, offset) {
  const value = buffer.readBigUInt64BE(offset);
  if (value > MAX_SAFE_BIGINT) {
    return Number.POSITIVE_INFINITY;
  }
  return Number(value);
}

/** 在顶层头部寻找有效 ftyp 盒并返回 major brand。 */
function findFtypBrand(data) {
  let offset = 0;
  const limit = data.length;
  while (offset + 12 <= limit) {
    let boxSize = data.readUInt32BE(offset);
    const boxType = data.subarray(offset + 4, offset + 8);
    if (boxType.equals(FTYP_BOX) && boxSize >= 16 && offset + boxSize <= limit) {
      return data.subarray(offset + 8, offset + 12);
    }
    if (boxSize === 1 && offset + 16 <= limit) {
      boxSize = readUInt64AsNumber(data, offset + 8);
    }
    if (boxSize < 8) {
      // 部分 QuickTime 文件在 ftyp 前有少量非盒前缀；有限搜索仍要求
      // 前四字节构成合理盒长，避免把普通音频中的文本误认成视频。
      break;
    }
    offset += boxSize;
  }

  const scanLimit = Math.min(limit - 8, 4096);
  for (let index = 4; index < scanLimit; index += 1) {
    if (!data.subarray(index, index + 4).equals(FTYP_BOX)) {
      continue;
    }
    const start = index - 4;
    const boxSize = data.readUInt32BE(start);
    if (boxSize >= 16 && start + boxSize <= limit) {
      return data.subarray(index + 4, index + 8);
    }
  }
  return null;
}

/** 查找 ISO-BMFF hdlr 盒中明确的 vide handler type。 */
function containsVideoHandler(data) {
  let start = 0;
  for (;;) {
    const index = data.indexOf(HDLR_BOX, start);
    if (index < 0) {
      return false;
    }
    if (index + 16 <= data.length && data.subarray(index + 12, index + 16).equals(VIDE_HANDLER)) {
      return true;
    }
    start = index + 4;
  }
}

/** 在内容标识键之后 16 KiB 窗口内寻找 UUID。 */
function quicktimeContentIdentifier(data) {
  const keyIndex = data.indexOf(CONTENT_IDENTIFIER_KEY);
  if (keyIndex < 0) {
    return null;
  }
  const window = data.subarray(keyIndex, keyIndex + 16 * 1024);
  const match = window.toString("latin1").match(UUID_PATTERN);
  return match ? match[0] : null;
}

/** 收集文件元数据样本中的全部 UUID（小写）。 */
function fileUuids(filePath) {
  const sampled = containerMetadataSample(filePath);
  if (sampled === null) {
    return new Set();
  }
  const text = sampled[1].toString("latin1");
  const uuids = new Set();
  const pattern = new RegExp(UUID_PATTERN_GLOBAL.source, "gi");
  for (const match of text.matchAll(pattern)) {
    uuids.add(match[0].toLowerCase());
  }
  return uuids;
}

function pairOccupancy(pair, normalizedReserved) {
  const keys = pair.map((filePath) => conflictKey(filePath));
  const planned = keys.some((key) => normalizedReserved.has(key));
  // 与 Python 一致：悬空符号链接也算占用（path.exists() or path.is_symlink()）。
  const occupied = planned || pair.some((filePath) => pathExists(filePath) || isSymlink(filePath));
  return [occupied, planned];
}

function reservePair(pair, reserved, normalizedReserved) {
  for (const filePath of pair) {
    reserved.add(filePath);
    normalizedReserved.add(conflictKey(filePath));
  }
}

/** NFC + casefold 的同名基名比较键。 */
function normalisedStem(filePath) {
  return _pathStem(filePath).normalize("NFC").toLowerCase();
}

/** Python bytes.decode('ascii', 'replace').strip()。 */
function decodeBrand(buffer) {
  let text = "";
  for (const byte of buffer) {
    text += byte < 0x80 ? String.fromCharCode(byte) : "\uFFFD";
  }
  return text.trim();
}

function evidenceText(status) {
  if (status === LivePhotoMetadataStatus.VERIFIED) {
    return "同目录同名，Apple 内容标识与关键帧元数据已验证";
  }
  if (status === LivePhotoMetadataStatus.CONFLICT) {
    return "同目录同名且含视频轨，但 Apple 内容标识冲突";
  }
  if (status === LivePhotoMetadataStatus.UNKNOWN) {
    return "Apple 内容标识匹配，但未确认动态片段关键帧元数据";
  }
  return "同目录同名且含视频轨；Apple 配对元数据缺失或不可读";
}

function pathExists(filePath) {
  return fs.existsSync(filePath);
}

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}
