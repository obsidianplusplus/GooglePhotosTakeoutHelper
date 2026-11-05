/**
 * 内容去重、编辑副本过滤和跨相册合并（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * 移植约定：
 * - 哈希计算是异步的（sha256File 返回 Promise），因此
 *   findDuplicateRecords / removeDuplicates / mergeAlbums 都是 async；
 * - 其余函数（snapshotDuplicateGroups / removeExtras / finalizeDuplicateGroups）
 *   保持同步，与 Python 调用方式一致；
 * - 原地修改数组时使用 `array.splice(0, length, ...kept)`，保留调用方持有的
 *   数组身份（对应 Python 的 `media[:] = ...`）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { EXTRA_SUFFIXES } from "./constants.js";
import { sha256File } from "./file-utils.js";
import { recordSourcePaths, recordTotalSize } from "./live-photos.js";
import {
  DuplicateDisposition,
  DuplicateGroup,
  DuplicateMember,
  Phase,
} from "./models.js";

// 每个 MediaRecord 的稳定唯一编号，用于构造不可读文件的唯一摘要键。
// Python 用 id(item)（活对象地址唯一）；Node 用 WeakMap 保证同一对象稳定、
// 不同对象不冲突，且不会阻止对象被回收。
const recordIdentifiers = new WeakMap();
let nextRecordIdentifier = 1;

/** 返回记录的稳定唯一编号。 */
function recordIdentifier(item) {
  let identifier = recordIdentifiers.get(item);
  if (identifier === undefined) {
    identifier = nextRecordIdentifier;
    nextRecordIdentifier += 1;
    recordIdentifiers.set(item, identifier);
  }
  return identifier;
}

/** 文件系统错误（对应 Python 的 OSError）：Node 的 fs 错误都带 code。 */
function isFileSystemError(error) {
  return Boolean(error) && typeof error.code === "string";
}

/** 把异常转换为日志文本（对应 Python 的 str(exc)）。 */
function errorText(error) {
  const detail = String(error && error.message !== undefined ? error.message : error).trim();
  return detail || String(error && error.name ? error.name : error);
}

/** pathlib.PurePath.suffix 的语义。 */
function pySuffix(name) {
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index) : "";
}

/** pathlib.PurePath.stem 的语义。 */
function pyStem(name) {
  const suffix = pySuffix(name);
  return suffix ? name.slice(0, -suffix.length) : name;
}

/** 取路径最后一段（等价 pathlib.name）。 */
function baseName(filePath) {
  return path.basename(String(filePath));
}

/**
 * Python str 比较按 Unicode 码点；显式按码点比较以匹配排序结果。
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
 * 先大写再小写覆盖绝大多数常见折叠，只有极少数特殊字符与 Python 有差异。
 *
 * @param {string} text
 * @returns {string}
 */
function casefold(text) {
  return String(text).toUpperCase().toLowerCase();
}

/**
 * 比较两个单值排序键（大小写折叠后按码点）。
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareCasefold(left, right) {
  return compareCodePoints(casefold(left), casefold(right));
}

/**
 * 返回记录的“首个来源”键（对应 next(iter(item.locations))）。
 *
 * @param {import("./models.js").MediaRecord} item
 * @returns {string|null}
 */
function firstLocationKey(item) {
  const iterator = item.locations.keys().next();
  return iterator.done ? null : iterator.value;
}

/**
 * 一次性找出所有全局内容重复组，后续去重与相册合并复用哈希。
 *
 * @param {import("./models.js").MediaRecord[]} media
 * @param {import("./models.js").TaskContext} context
 * @param {number} chunkSize
 * @param {import("./scan-cache.js").HashCache|null} hashCache
 * @returns {Promise<import("./models.js").MediaRecord[][]>}
 */
export async function findDuplicateRecords(media, context, chunkSize, hashCache = null) {
  const groups = [];
  const allGroups = await _identicalGroups(media, context, chunkSize, {
    reportProgress: true,
    hashCache,
  });
  for (const group of allGroups) {
    if (
      group.length > 1 &&
      group[0].digest &&
      !group[0].digest.startsWith("unreadable:")
    ) {
      groups.push(group);
    }
  }
  for (const group of groups) {
    group.sort((left, right) =>
      compareMemberSortKey(
        firstLocationKey(left),
        left.firstFile,
        firstLocationKey(right),
        right.firstFile,
      ),
    );
  }
  groups.sort((left, right) => {
    const digestOrder = compareCodePoints(left[0].digest || "", right[0].digest || "");
    if (digestOrder !== 0) {
      return digestOrder;
    }
    const leftSize = left[0].size || 0;
    const rightSize = right[0].size || 0;
    if (leftSize !== rightSize) {
      return leftSize < rightSize ? -1 : 1;
    }
    return compareCasefold(left[0].firstFile, right[0].firstFile);
  });
  return groups;
}

/**
 * 在任何记录被过滤前保存稳定、只读的物理文件清单。
 *
 * @param {import("./models.js").MediaRecord[][]} recordGroups
 * @returns {import("./models.js").DuplicateGroup[]}
 */
export function snapshotDuplicateGroups(recordGroups) {
  const snapshots = [];
  for (const records of recordGroups) {
    const digest = records[0].digest;
    const size = records[0].size;
    if (!digest || size === null || size === undefined) {
      continue;
    }
    const members = [];
    for (const record of records) {
      for (const [album, filePath] of record.locations.entries()) {
        let modifiedNs = null;
        let memberSize = size;
        try {
          const stat = fs.statSync(filePath, { bigint: true });
          modifiedNs = Number(stat.mtimeNs);
          memberSize = Number(stat.size);
        } catch {
          modifiedNs = null;
          memberSize = size;
        }
        members.push(
          new DuplicateMember({
            path: filePath,
            album,
            size: memberSize,
            digest,
            modifiedNs,
            companionPath: record.companionFor(album),
          }),
        );
      }
    }
    members.sort((left, right) =>
      compareMemberSortKey(left.album, left.path, right.album, right.path),
    );
    snapshots.push(
      new DuplicateGroup({
        digest,
        size,
        members,
        isLivePhoto: records[0].isLivePhoto,
      }),
    );
  }
  return snapshots;
}

/**
 * 在每个来源范围内去重，避免提前吞掉其它相册关系。
 *
 * 原地过滤 `media` 并返回移除数量。
 *
 * @param {import("./models.js").MediaRecord[]} media
 * @param {import("./models.js").TaskContext} context
 * @param {number} chunkSize
 * @param {import("./models.js").MediaRecord[][]|null} identicalGroups
 * @returns {Promise<number>}
 */
export async function removeDuplicates(media, context, chunkSize, identicalGroups = null) {
  /** @type {Set<import("./models.js").MediaRecord>} */
  const removed = new Set();
  /** @type {import("./models.js").MediaRecord[][]} */
  let sourceGroups;
  if (identicalGroups === null || identicalGroups === undefined) {
    const byAlbum = new Map();
    for (const item of media) {
      const album = firstLocationKey(item);
      const bucket = byAlbum.get(album);
      if (bucket === undefined) {
        byAlbum.set(album, [item]);
      } else {
        bucket.push(item);
      }
    }
    sourceGroups = [];
    for (const albumRecords of byAlbum.values()) {
      const groups = await _identicalGroups(albumRecords, context, chunkSize, {
        reportProgress: true,
      });
      sourceGroups.push(...groups);
    }
  } else {
    sourceGroups = [];
    // 全局内容组需要再次按逻辑来源拆分；跨相册副本承担相册关系，不能移除。
    for (const identical of identicalGroups) {
      const byAlbum = new Map();
      for (const item of identical) {
        const album = firstLocationKey(item);
        const bucket = byAlbum.get(album);
        if (bucket === undefined) {
          byAlbum.set(album, [item]);
        } else {
          bucket.push(item);
        }
      }
      sourceGroups.push(...byAlbum.values());
    }
  }

  for (const identical of sourceGroups) {
    if (identical.length <= 1) {
      continue;
    }
    identical.sort(compareQuality);
    for (const item of identical.slice(1)) {
      removed.add(item);
    }
  }

  if (removed.size > 0) {
    const retained = media.filter((item) => !removed.has(item));
    media.splice(0, media.length, ...retained);
  }
  return removed.size;
}

/**
 * 删除内置多语言后缀标记的编辑版，兼容结尾 `(1)`。
 *
 * @param {import("./models.js").MediaRecord[]} media
 * @returns {number}
 */
export function removeExtras(media) {
  const escaped = EXTRA_SUFFIXES.map((value) =>
    String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|");
  const pattern = new RegExp(`(?:${escaped})(?:\\(\\d+\\))?$`, "iu");
  const before = media.length;
  const retained = media.filter((item) => {
    const stem = pyStem(baseName(item.firstFile));
    return !pattern.test(stem.normalize("NFC").toLowerCase());
  });
  media.splice(0, media.length, ...retained);
  return before - media.length;
}

/**
 * 按内容合并时间线及所有相册位置，并选择最可靠的日期。
 *
 * @param {import("./models.js").MediaRecord[]} media
 * @param {import("./models.js").TaskContext} context
 * @param {number} chunkSize
 * @returns {Promise<number>}
 */
export async function mergeAlbums(media, context, chunkSize) {
  /** @type {import("./models.js").MediaRecord[]} */
  const merged = [];
  let removedCount = 0;
  const groups = await _identicalGroups(media, context, chunkSize, {
    reportProgress: false,
  });
  for (const group of groups) {
    context.checkCancelled();
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    group.sort(compareQuality);
    const winner = group[0];
    /** @type {Map<string|null, string>} */
    const locations = new Map();
    /** @type {Map<string|null, string>} */
    const companions = new Map();
    /** @type {Map<string|null, *>} */
    const metadata = new Map();
    /** @type {Map<string|null, string>} */
    const evidence = new Map();
    /** @type {Map<string|null, boolean>} */
    const repairedSuffix = new Map();
    /** @type {Map<string|null, string>} */
    const outputMotionSuffixes = new Map();
    /** @type {Map<string|null, string>} */
    const outputSuffixes = new Map();
    // 先放时间线位置，确保 JSON 模式选取的首个文件最稳定。
    const ordered = group.slice().sort((left, right) => {
      const leftHasTimeline = left.locations.has(null);
      const rightHasTimeline = right.locations.has(null);
      if (leftHasTimeline !== rightHasTimeline) {
        return leftHasTimeline ? -1 : 1;
      }
      return compareQuality(left, right);
    });
    for (const item of ordered) {
      for (const [key, value] of item.locations.entries()) {
        locations.set(key, value);
      }
      for (const [key, value] of item.livePhotoCompanions.entries()) {
        companions.set(key, value);
      }
      for (const [key, value] of item.livePhotoMetadata.entries()) {
        metadata.set(key, value);
      }
      for (const [key, value] of item.livePhotoEvidence.entries()) {
        evidence.set(key, value);
      }
      for (const [key, value] of item.livePhotoRepairedSuffix.entries()) {
        repairedSuffix.set(key, value);
      }
      for (const [key, value] of item.livePhotoOutputMotionSuffixes.entries()) {
        outputMotionSuffixes.set(key, value);
      }
      for (const [key, value] of item.outputSuffixes.entries()) {
        outputSuffixes.set(key, value);
      }
    }
    winner.locations = locations;
    winner.livePhotoCompanions = companions;
    winner.livePhotoMetadata = metadata;
    winner.livePhotoEvidence = evidence;
    winner.livePhotoRepairedSuffix = repairedSuffix;
    winner.livePhotoOutputMotionSuffixes = outputMotionSuffixes;
    winner.outputSuffixes = outputSuffixes;
    merged.push(winner);
    removedCount += group.length - 1;
  }
  media.splice(0, media.length, ...merged);
  return removedCount;
}

/**
 * 根据最终媒体记录回填主文件、相册副本和过滤原因。
 *
 * @param {import("./models.js").DuplicateGroup[]} snapshots
 * @param {import("./models.js").MediaRecord[]} media
 * @param {Set<string>} retainedAfterDeduplication
 * @returns {import("./models.js").DuplicateGroup[]}
 */
export function finalizeDuplicateGroups(snapshots, media, retainedAfterDeduplication) {
  const finalByDigest = new Map();
  for (const item of media) {
    if (item.digest !== null && item.digest !== undefined && !item.digest.startsWith("unreadable:")) {
      finalByDigest.set(item.digest, item);
    }
  }
  const dispositionOrder = {
    [DuplicateDisposition.PRIMARY]: 0,
    [DuplicateDisposition.ALBUM_COPY]: 1,
    [DuplicateDisposition.SKIPPED]: 2,
    [DuplicateDisposition.FILTERED]: 3,
  };
  const output = [];
  for (const snapshot of snapshots) {
    const finalRecord = finalByDigest.get(snapshot.digest);
    const primaryPath = finalRecord !== undefined ? finalRecord.firstFile : null;
    const finalPaths = new Set(finalRecord !== undefined ? finalRecord.locations.values() : []);
    const members = [];
    for (const member of snapshot.members) {
      let disposition;
      let reason;
      if (member.path === primaryPath) {
        disposition = DuplicateDisposition.PRIMARY;
        reason = "作为主文件进入整理计划";
      } else if (finalPaths.has(member.path)) {
        disposition = DuplicateDisposition.ALBUM_COPY;
        reason = "保留相册关系；按相册模式生成快捷方式、索引或实体副本";
      } else if (!retainedAfterDeduplication.has(member.path)) {
        disposition = DuplicateDisposition.SKIPPED;
        reason = "同一来源中已有完全相同文件；不进入输出计划，源文件不会被删除";
      } else {
        disposition = DuplicateDisposition.FILTERED;
        reason = "已按“跳过编辑副本”规则排除；源文件不会被删除";
      }
      members.push(
        new DuplicateMember({
          path: member.path,
          album: member.album,
          size: member.size,
          digest: member.digest,
          modifiedNs: member.modifiedNs,
          disposition,
          reason,
          companionPath: member.companionPath,
        }),
      );
    }
    members.sort((left, right) => {
      const order =
        (dispositionOrder[left.disposition] ?? 0) - (dispositionOrder[right.disposition] ?? 0);
      if (order !== 0) {
        return order;
      }
      return compareMemberSortKey(left.album, left.path, right.album, right.path);
    });
    output.push(
      new DuplicateGroup({
        digest: snapshot.digest,
        size: snapshot.size,
        members,
        primaryPath,
        dateTaken: finalRecord !== undefined ? finalRecord.dateTaken : null,
        dateSource: finalRecord !== undefined ? finalRecord.dateSource : null,
        isLivePhoto: snapshot.isLivePhoto,
      }),
    );
  }
  return output;
}

/**
 * 先按复合资产总大小缩小候选，再计算完整流式哈希。
 *
 * 实况照片使用静态图与动态片段的双摘要组合键；只有两半都完全一致才会
 * 被视为重复项，避免“静态图相同、动态片段不同”时误删其中一组。
 *
 * @param {import("./models.js").MediaRecord[]} media
 * @param {import("./models.js").TaskContext} context
 * @param {number} chunkSize
 * @param {{reportProgress?: boolean, hashCache?: import("./scan-cache.js").HashCache|null}} [options]
 * @returns {Promise<import("./models.js").MediaRecord[][]>}
 */
async function _identicalGroups(
  media,
  context,
  chunkSize,
  { reportProgress = true, hashCache = null } = {},
) {
  /** @type {Map<number, import("./models.js").MediaRecord[]>} */
  const bySize = new Map();
  for (const item of media) {
    context.checkCancelled();
    if (item.size === null || item.size === undefined || item.isLivePhoto) {
      item.size = recordTotalSize(item);
    }
    const bucket = bySize.get(item.size);
    if (bucket === undefined) {
      bySize.set(item.size, [item]);
    } else {
      bucket.push(item);
    }
  }

  /** @type {import("./models.js").MediaRecord[][]} */
  const output = [];
  let candidates = 0;
  for (const group of bySize.values()) {
    if (group.length > 1) {
      candidates += group.length;
    }
  }
  let completed = 0;
  for (const sameSize of bySize.values()) {
    if (sameSize.length === 1) {
      output.push(sameSize);
      continue;
    }
    /** @type {Map<string, import("./models.js").MediaRecord[]>} */
    const byDigest = new Map();
    for (const item of sameSize) {
      context.checkCancelled();
      const itemSize = item.size;
      if (itemSize === null || itemSize === undefined) {
        item.size = recordTotalSize(item);
      }
      let usedCache = false;
      if (item.digest === null || item.digest === undefined) {
        try {
          const [digest, cacheHit] = await _recordDigest(item, context, chunkSize, hashCache);
          item.digest = digest;
          usedCache = cacheHit;
        } catch (error) {
          if (!isFileSystemError(error)) {
            throw error;
          }
          // 无法读取的文件使用唯一错误键，避免错误合并。
          item.digest = `unreadable:${recordIdentifier(item)}`;
          context.log("WARNING", `无法计算复合媒体哈希 ${item.firstFile}：${errorText(error)}`);
        }
      }
      const digestBucket = byDigest.get(item.digest);
      if (digestBucket === undefined) {
        byDigest.set(item.digest, [item]);
      } else {
        digestBucket.push(item);
      }
      completed += 1;
      if (reportProgress) {
        context.progress(
          Phase.DEDUPLICATING,
          completed,
          candidates,
          `${usedCache ? "复用" : "计算"}内容指纹：${baseName(item.firstFile)}`,
        );
      }
    }
    output.push(...byDigest.values());
  }
  return output;
}

/** 读取文件大小与纳秒修改时间（跟随符号链接，与 Python stat 一致）。 */
function statSnapshot(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return { size: Number(stat.size), mtimeNs: stat.mtimeNs };
}

/**
 * 计算普通媒体或实况照片整组摘要，并复用每个物理文件的缓存。
 *
 * @param {import("./models.js").MediaRecord} item
 * @param {import("./models.js").TaskContext} context
 * @param {number} chunkSize
 * @param {import("./scan-cache.js").HashCache|null} hashCache
 * @returns {Promise<[string, boolean]>}
 */
async function _recordDigest(item, context, chunkSize, hashCache) {
  const componentDigests = [];
  let allCached = true;
  for (const filePath of recordSourcePaths(item)) {
    const [digest, usedCache] = await _pathDigest(filePath, context, chunkSize, hashCache);
    componentDigests.push(digest);
    allCached = allCached && usedCache;
  }
  if (componentDigests.length === 1) {
    return [componentDigests[0], allCached];
  }

  const combined = crypto.createHash("sha256");
  combined.update(Buffer.from("gpth-live-photo-v1\0", "utf8"));
  for (const digest of componentDigests) {
    combined.update(Buffer.from(digest, "hex"));
  }
  return [combined.digest("hex"), allCached];
}

/**
 * 安全计算单个物理文件摘要；缓存异常只会退化为重新读取。
 *
 * @param {string} filePath
 * @param {import("./models.js").TaskContext} context
 * @param {number} chunkSize
 * @param {import("./scan-cache.js").HashCache|null} hashCache
 * @returns {Promise<[string, boolean]>}
 */
async function _pathDigest(filePath, context, chunkSize, hashCache) {
  const before = statSnapshot(filePath);
  const size = before.size;
  if (hashCache !== null && hashCache !== undefined) {
    let cached = null;
    let lookupFailed = false;
    try {
      cached = hashCache.lookup(filePath, size);
    } catch (error) {
      lookupFailed = true;
      context.log("WARNING", `读取指纹缓存失败，已重新计算 ${baseName(filePath)}：${errorText(error)}`);
    }
    if (!lookupFailed && cached !== null && cached !== undefined) {
      return [cached, true];
    }
  }

  const digest = await sha256File(filePath, context, chunkSize);
  let after;
  try {
    after = statSnapshot(filePath);
  } catch (error) {
    if (!isFileSystemError(error)) {
      throw error;
    }
    context.log("WARNING", `哈希完成后无法确认文件状态，未写入缓存：${filePath}`);
    return [digest, false];
  }
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    context.log("WARNING", `哈希期间文件发生变化，未写入缓存：${filePath}`);
    return [digest, false];
  }
  if (hashCache !== null && hashCache !== undefined) {
    try {
      hashCache.store(filePath, size, digest, { expectedMtimeNs: after.mtimeNs });
    } catch (error) {
      context.log("WARNING", `写入指纹缓存失败：${errorText(error)}`);
    }
  }
  return [digest, false];
}

/**
 * 准确度优先，其次选择短名称以提高 sidecar 配对成功率。
 *
 * @param {import("./models.js").MediaRecord} left
 * @param {import("./models.js").MediaRecord} right
 * @returns {number}
 */
function compareQuality(left, right) {
  const leftAccuracy = left.dateAccuracy !== null && left.dateAccuracy !== undefined
    ? left.dateAccuracy
    : 999;
  const rightAccuracy = right.dateAccuracy !== null && right.dateAccuracy !== undefined
    ? right.dateAccuracy
    : 999;
  if (leftAccuracy !== rightAccuracy) {
    return leftAccuracy < rightAccuracy ? -1 : 1;
  }
  const leftName = baseName(left.firstFile);
  const rightName = baseName(right.firstFile);
  if (leftName.length !== rightName.length) {
    return leftName.length - rightName.length;
  }
  return compareCasefold(leftName, rightName);
}

/**
 * 时间线优先，再按相册与完整路径稳定排序。
 *
 * 返回 Python 元组 `(album is not None, (album or "").casefold(), str(path).casefold())`
 * 的比较结果。
 *
 * @param {string|null} leftAlbum
 * @param {string} leftPath
 * @param {string|null} rightAlbum
 * @param {string} rightPath
 * @returns {number}
 */
function compareMemberSortKey(leftAlbum, leftPath, rightAlbum, rightPath) {
  const leftHasAlbum = leftAlbum !== null && leftAlbum !== undefined;
  const rightHasAlbum = rightAlbum !== null && rightAlbum !== undefined;
  if (leftHasAlbum !== rightHasAlbum) {
    return leftHasAlbum ? 1 : -1;
  }
  const albumOrder = compareCasefold(leftAlbum ?? "", rightAlbum ?? "");
  if (albumOrder !== 0) {
    return albumOrder;
  }
  return compareCasefold(String(leftPath), String(rightPath));
}
