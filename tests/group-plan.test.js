/**
 * grouping / planner / duplicates 的移植测试（node:test + 临时目录）。
 *
 * 覆盖：
 * - findDuplicateRecords：同大小 + SHA-256 分组、实况照片复合摘要、不可读文件唯一键、
 *   指纹缓存命中/未命中的进度文案；
 * - snapshotDuplicateGroups / removeDuplicates / removeExtras / mergeAlbums /
 *   finalizeDuplicateGroups：主文件、相册副本、跳过去重、编辑副本四种 disposition；
 * - buildPlan：四种相册模式、三种日期划分、三种未知日期策略、三种冲突策略、
 *   实况照片成组、快捷方式兜底字段、按拍摄日期修正文件名、安全相册名；
 * - duplicates：对生成的 JPEG/PNG 做 inspect 与缩略图，以及缺失/非图片/非法边界等状态。
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import zlib from "node:zlib";

import sharp from "sharp";

import { EXTRA_SUFFIXES } from "../src/constants.js";
import {
  buildThumbnail,
  inspectDuplicateFile,
  MAX_THUMBNAIL_PIXELS,
  ThumbnailStatus,
} from "../src/duplicates.js";
import {
  finalizeDuplicateGroups,
  findDuplicateRecords,
  mergeAlbums,
  removeDuplicates,
  removeExtras,
  snapshotDuplicateGroups,
} from "../src/grouping.js";
import {
  ActionKind,
  AlbumMode,
  AnalysisResult,
  ConflictMode,
  DateDivision,
  DuplicateDisposition,
  LivePhotoRole,
  LivePhotoTarget,
  MediaRecord,
  OperationMode,
  OrganizeOptions,
  Phase,
  RunStatistics,
  TaskContext,
  UnknownDateMode,
} from "../src/models.js";
import { buildPlan } from "../src/planner.js";

const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 创建并登记一个临时目录。 */
function makeTempDir(prefix = "gpth-group-plan-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/** 写文件（自动创建父目录），返回路径。 */
function writeFile(filePath, data = "x") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
  return filePath;
}

/** 计算 Buffer/字符串的 SHA-256 十六进制摘要。 */
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** 生成一个带进度/日志捕获的 TaskContext。 */
function makeContext() {
  const logs = [];
  const progress = [];
  const context = new TaskContext({
    logCallback: (level, message) => logs.push({ level, message }),
    progressCallback: (update) => progress.push(update),
  });
  context.logs = logs;
  context.progressUpdates = progress;
  return context;
}

/** 构造一个 MediaRecord；locations 用 [album, path] 数组保持插入顺序。 */
function makeRecord({
  locations = [[null, null]],
  size = null,
  digest = null,
  dateTaken = null,
  dateSource = null,
  dateAccuracy = null,
  companions = null,
  metadata = null,
  evidence = null,
  repairedSuffix = null,
  outputMotionSuffixes = null,
  outputSuffixes = null,
} = {}) {
  const locationMap = new Map(locations);
  return new MediaRecord(locationMap, {
    size,
    digest,
    dateTaken,
    dateSource,
    dateAccuracy,
    livePhotoCompanions: companions === null ? new Map() : new Map(companions),
    livePhotoMetadata: metadata === null ? new Map() : new Map(metadata),
    livePhotoEvidence: evidence === null ? new Map() : new Map(evidence),
    livePhotoRepairedSuffix: repairedSuffix === null ? new Map() : new Map(repairedSuffix),
    livePhotoOutputMotionSuffixes:
      outputMotionSuffixes === null ? new Map() : new Map(outputMotionSuffixes),
    outputSuffixes: outputSuffixes === null ? new Map() : new Map(outputSuffixes),
  });
}

/** 构造 normalized 后的 OrganizeOptions。 */
function makeOptions(inputDir, outputDir, overrides = {}) {
  return new OrganizeOptions({ inputDir, outputDir, ...overrides }).normalized();
}

/** 构造 AnalysisResult（statistics 必须是 RunStatistics 实例）。 */
function makeAnalysis(media, { inputDir, outputDir, options = {} } = {}) {
  return new AnalysisResult({
    options: makeOptions(inputDir, outputDir, options),
    media,
    statistics: new RunStatistics(),
  });
}

/** 仅用于 grouping 的默认分块大小。 */
const CHUNK = 64 * 1024;

// ---------------------------------------------------------------------------
// grouping：findDuplicateRecords
// ---------------------------------------------------------------------------

test("findDuplicateRecords 按大小与 SHA-256 分组并写入 digest/size", async () => {
  const root = makeTempDir();
  const a = writeFile(path.join(root, "a.bin"), "same-content");
  const b = writeFile(path.join(root, "b.bin"), "same-content");
  const c = writeFile(path.join(root, "c.bin"), "different-content");
  const records = [
    makeRecord({ locations: [[null, a]] }),
    makeRecord({ locations: [[null, b]] }),
    makeRecord({ locations: [[null, c]] }),
  ];
  const context = makeContext();

  const groups = await findDuplicateRecords(records, context, CHUNK);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].map((record) => record.firstFile),
    [a, b],
  );
  const expectedDigest = sha256Hex("same-content");
  assert.equal(groups[0][0].digest, expectedDigest);
  assert.equal(groups[0][1].digest, expectedDigest);
  assert.equal(groups[0][0].size, Buffer.byteLength("same-content"));
  // 只有参与摘要计算（大小相同的候选组）的记录才有进度。
  assert.equal(context.progressUpdates.length, 2);
  for (const update of context.progressUpdates) {
    assert.equal(update.phase, Phase.DEDUPLICATING);
    assert.match(update.message, /^计算内容指纹：/);
    assert.equal(update.total, 2);
  }
  // 唯一大小（没有候选）的文件不做摘要计算，保持 digest === null。
  assert.equal(records[2].digest, null);
});

test("findDuplicateRecords 实况照片使用静态图 + 动态片段复合摘要", async () => {
  const root = makeTempDir();
  const stillA = writeFile(path.join(root, "stillA.jpg"), "STILL");
  const motionA = writeFile(path.join(root, "stillA.mov"), "MOTION1");
  const stillB = writeFile(path.join(root, "stillB.jpg"), "STILL");
  const motionB = writeFile(path.join(root, "stillB.mov"), "MOTION1");
  const stillC = writeFile(path.join(root, "stillC.jpg"), "STILL");
  const motionC = writeFile(path.join(root, "stillC.mov"), "MOTION2");
  const records = [
    makeRecord({ locations: [[null, stillA]], companions: [[null, motionA]] }),
    makeRecord({ locations: [[null, stillB]], companions: [[null, motionB]] }),
    makeRecord({ locations: [[null, stillC]], companions: [[null, motionC]] }),
  ];
  const context = makeContext();

  const groups = await findDuplicateRecords(records, context, CHUNK);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].map((record) => record.firstFile),
    [stillA, stillB],
  );
  const combined = crypto.createHash("sha256");
  combined.update(Buffer.from("gpth-live-photo-v1\0", "utf8"));
  combined.update(Buffer.from(sha256Hex("STILL"), "hex"));
  combined.update(Buffer.from(sha256Hex("MOTION1"), "hex"));
  assert.equal(groups[0][0].digest, combined.digest("hex"));
  assert.equal(records[0].size, Buffer.byteLength("STILL") + Buffer.byteLength("MOTION1"));
  assert.notEqual(records[2].digest, groups[0][0].digest);
});

test("findDuplicateRecords 对不可读文件使用唯一键并记录警告", async () => {
  const root = makeTempDir();
  const readable = writeFile(path.join(root, "readable.bin"), "same-content");
  const missing = path.join(root, "missing.bin");
  const readableRecord = makeRecord({ locations: [[null, readable]] });
  const missingRecord = makeRecord({ locations: [[null, missing]], size: 12 });
  const context = makeContext();

  const groups = await findDuplicateRecords([missingRecord, readableRecord], context, CHUNK);

  assert.equal(groups.length, 0);
  assert.match(missingRecord.digest, /^unreadable:\d+$/);
  assert.equal(readableRecord.digest, sha256Hex("same-content"));
  assert.ok(
    context.logs.some(
      (entry) =>
        entry.level === "WARNING" && entry.message.startsWith("无法计算复合媒体哈希"),
    ),
  );
});

test("findDuplicateRecords 复用指纹缓存并输出“复用内容指纹”进度", async () => {
  const root = makeTempDir();
  const a = writeFile(path.join(root, "a.bin"), "cached-content");
  const b = writeFile(path.join(root, "b.bin"), "cached-content");
  const cachedDigest = sha256Hex("cached-content");
  class FakeHashCache {
    constructor() {
      this.entries = new Map([
        [a, cachedDigest],
        [b, cachedDigest],
      ]);
      this.hits = 0;
      this.misses = 0;
      this.stored = [];
    }

    lookup(filePath, size) {
      const found = this.entries.get(filePath);
      if (found === undefined) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return found;
    }

    store(filePath, size, digest, options) {
      this.stored.push({ filePath, size, digest, options });
      this.entries.set(filePath, digest);
    }
  }
  const cache = new FakeHashCache();
  const records = [
    makeRecord({ locations: [[null, a]] }),
    makeRecord({ locations: [[null, b]] }),
  ];
  const context = makeContext();

  const groups = await findDuplicateRecords(records, context, CHUNK, cache);

  assert.equal(groups.length, 1);
  assert.equal(cache.hits, 2);
  assert.equal(cache.misses, 0);
  assert.equal(cache.stored.length, 0);
  assert.ok(context.progressUpdates.some((update) => update.message === "复用内容指纹：a.bin"));
});

test("findDuplicateRecords 响应取消", async () => {
  const root = makeTempDir();
  const file = writeFile(path.join(root, "a.bin"), "content");
  const context = makeContext();
  context.cancel();

  await assert.rejects(
    () => findDuplicateRecords([makeRecord({ locations: [[null, file]] })], context, CHUNK),
    (error) => error.name === "CancelledError",
  );
});

// ---------------------------------------------------------------------------
// grouping：snapshot / removeDuplicates / removeExtras / mergeAlbums / finalize
// ---------------------------------------------------------------------------

test("snapshotDuplicateGroups 记录每个物理副本的 stat 与相册信息", async () => {
  const root = makeTempDir();
  const a = writeFile(path.join(root, "a.jpg"), "duplicate-bytes");
  const b = writeFile(path.join(root, "b.jpg"), "duplicate-bytes");
  const records = [
    makeRecord({ locations: [[null, a]] }),
    makeRecord({ locations: [["albumA", b]] }),
  ];
  const context = makeContext();
  const groups = await findDuplicateRecords(records, context, CHUNK);

  const snapshots = snapshotDuplicateGroups(groups);

  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.equal(snapshot.digest, sha256Hex("duplicate-bytes"));
  assert.equal(snapshot.size, Buffer.byteLength("duplicate-bytes"));
  assert.equal(snapshot.isLivePhoto, false);
  assert.equal(snapshot.members.length, 2);
  const [timelineMember, albumMember] = snapshot.members;
  assert.equal(timelineMember.path, a);
  assert.equal(timelineMember.album, null);
  assert.equal(timelineMember.size, Buffer.byteLength("duplicate-bytes"));
  assert.equal(timelineMember.digest, snapshot.digest);
  assert.ok(timelineMember.modifiedNs > 0);
  assert.equal(timelineMember.companionPath, null);
  assert.equal(albumMember.path, b);
  assert.equal(albumMember.album, "albumA");
  assert.equal(snapshot.redundantCount, 1);
});

test("snapshotDuplicateGroups 在 stat 失败时退回记录大小", async () => {
  const root = makeTempDir();
  const a = writeFile(path.join(root, "a.jpg"), "bytes-for-snapshot");
  const b = writeFile(path.join(root, "b.jpg"), "bytes-for-snapshot");
  const records = [
    makeRecord({ locations: [[null, a]] }),
    makeRecord({ locations: [[null, b]] }),
  ];
  const context = makeContext();
  const groups = await findDuplicateRecords(records, context, CHUNK);
  // 快照前删除其中一个物理文件：stat 失败必须退回记录大小且 modifiedNs 为 null。
  fs.rmSync(b);

  const snapshots = snapshotDuplicateGroups(groups);

  assert.equal(snapshots.length, 1);
  const removedMember = snapshots[0].members.find((member) => member.path === b);
  assert.equal(removedMember.modifiedNs, null);
  assert.equal(removedMember.size, Buffer.byteLength("bytes-for-snapshot"));
});

test("removeDuplicates 只删除同一来源内的重复，保留跨相册副本", async () => {
  const root = makeTempDir();
  const a = writeFile(path.join(root, "a.jpg"), "same-bytes");
  const b = writeFile(path.join(root, "b.jpg"), "same-bytes");
  const c = writeFile(path.join(root, "c.jpg"), "same-bytes");
  const timelineWorse = makeRecord({
    locations: [[null, a]],
    dateAccuracy: 2,
    dateTaken: new Date(2020, 0, 1),
  });
  const timelineBest = makeRecord({
    locations: [[null, b]],
    dateAccuracy: 0,
    dateTaken: new Date(2021, 0, 1),
  });
  const albumCopy = makeRecord({ locations: [["albumA", c]], dateAccuracy: 1 });
  const media = [timelineWorse, timelineBest, albumCopy];
  const context = makeContext();
  const groups = await findDuplicateRecords(media, context, CHUNK);

  const removed = await removeDuplicates(media, context, CHUNK, groups);

  assert.equal(removed, 1);
  assert.equal(media.length, 2);
  // 同一来源内质量更好的记录获胜（dateAccuracy 0）。
  assert.equal(media[0], timelineBest);
  // 跨相册副本承担相册关系，不能被移除。
  assert.equal(media[1], albumCopy);
  assert.equal(timelineWorse.dateTaken instanceof Date, true);
});

test("removeDuplicates 在未提供 identicalGroups 时自行计算", async () => {
  const root = makeTempDir();
  const a = writeFile(path.join(root, "a.jpg"), "same-bytes");
  const b = writeFile(path.join(root, "bb.jpg"), "same-bytes");
  const first = makeRecord({ locations: [[null, a]] });
  const second = makeRecord({ locations: [[null, b]] });
  const media = [first, second];
  const context = makeContext();

  const removed = await removeDuplicates(media, context, CHUNK);

  assert.equal(removed, 1);
  assert.equal(media.length, 1);
  // 质量相同时短名称获胜。
  assert.equal(media[0], first);
});

test("removeExtras 识别多语言编辑副本后缀与结尾编号", () => {
  const root = makeTempDir();
  const keep = [
    writeFile(path.join(root, "keep.jpg")),
    writeFile(path.join(root, "keep-editedx.jpg")),
  ];
  const removedNames = [
    "a-edited.jpg",
    "b-EDITED(2).jpg",
    "c-edytowane.jpg",
    "d-bearbeitet.jpg",
    "e-bewerkt.jpg",
    "f-編集済み.jpg",
    "g-modificato.jpg",
    "h-modifié.jpg",
    "i-ha editado.jpg",
    "j-editat.jpg",
    "k-effects(12).jpg",
    "l-smile.jpg",
    "m-mix.jpg",
  ];
  const removed = removedNames.map((name) => writeFile(path.join(root, name)));
  const media = [...keep, ...removed].map((filePath) =>
    makeRecord({ locations: [[null, filePath]] }),
  );

  const count = removeExtras(media);

  assert.equal(count, removedNames.length);
  assert.equal(media.length, keep.length);
  assert.deepEqual(
    media.map((record) => path.basename(record.firstFile)),
    ["keep.jpg", "keep-editedx.jpg"],
  );
  // 后缀清单本身也是公共常量，避免测试与实现漂移。
  assert.ok(EXTRA_SUFFIXES.includes("-edytowane"));
});

test("mergeAlbums 按内容合并位置、选择最可靠日期并合并映射", async () => {
  const root = makeTempDir();
  const timelineFile = writeFile(path.join(root, "a.jpg"), "merged-bytes");
  const albumFile = writeFile(path.join(root, "b.jpg"), "merged-bytes");
  const timelineMotion = writeFile(path.join(root, "a.mov"), "MOTION");
  const albumMotion = writeFile(path.join(root, "b.mov"), "MOTION");
  const better = makeRecord({
    locations: [["albumA", albumFile]],
    dateAccuracy: 0,
    dateTaken: new Date(2021, 4, 6, 1, 2, 3),
    dateSource: "json",
    companions: [["albumA", albumMotion]],
    outputSuffixes: [["albumA", ".mp4"]],
  });
  const worse = makeRecord({
    locations: [[null, timelineFile]],
    dateAccuracy: 2,
    dateTaken: new Date(2019, 0, 1),
    dateSource: "filename",
    companions: [[null, timelineMotion]],
    repairedSuffix: [[null, true]],
  });
  const media = [worse, better];
  const context = makeContext();
  const groups = await findDuplicateRecords(media, context, CHUNK);

  const removed = await mergeAlbums(media, context, CHUNK);

  assert.equal(removed, 1);
  assert.equal(media.length, 1);
  const merged = media[0];
  assert.equal(merged, better);
  // 时间线位置必须排在首位，JSON 模式选取的首个文件才稳定。
  assert.deepEqual([...merged.locations.keys()], [null, "albumA"]);
  assert.equal(merged.firstFile, timelineFile);
  assert.equal(merged.dateAccuracy, 0);
  assert.equal(merged.dateTaken.getFullYear(), 2021);
  assert.equal(merged.dateSource, "json");
  // 实况照片与输出后缀映射全部合并。
  assert.deepEqual(
    [...merged.livePhotoCompanions.keys()].sort(),
    ["albumA", null].sort(),
  );
  assert.equal(merged.outputSuffixFor("albumA"), ".mp4");
  assert.equal(merged.livePhotoRepairedSuffix.get(null), true);
  assert.ok(groups.length >= 1);
});

test("finalizeDuplicateGroups 回填四种 disposition 与中文原因", async () => {
  const root = makeTempDir();
  // 1) 同来源重复：一个进入计划，另一个被去重跳过。
  const timelineA = writeFile(path.join(root, "a.jpg"), "same-source-bytes");
  const timelineB = writeFile(path.join(root, "b.jpg"), "same-source-bytes");
  // 2) 跨相册重复：承担相册关系，最终成为相册副本。
  const crossTimeline = writeFile(path.join(root, "c.jpg"), "cross-album-bytes");
  const crossAlbum = writeFile(path.join(root, "d.jpg"), "cross-album-bytes");
  // 3) 被“跳过编辑副本”规则排除：保留在去重前后集合中，但不是最终记录。
  const editedKeep = writeFile(path.join(root, "e.jpg"), "edited-bytes");
  const editedRemoved = writeFile(path.join(root, "f-edited.jpg"), "edited-bytes");

  const sameWorse = makeRecord({
    locations: [[null, timelineA]],
    dateAccuracy: 2,
    dateTaken: new Date(2018, 0, 1),
  });
  const sameBest = makeRecord({
    locations: [[null, timelineB]],
    dateAccuracy: 0,
    dateTaken: new Date(2022, 1, 2),
    dateSource: "exif",
  });
  const crossTimelineRecord = makeRecord({ locations: [[null, crossTimeline]], dateAccuracy: 1 });
  const crossAlbumRecord = makeRecord({ locations: [["albumA", crossAlbum]], dateAccuracy: 1 });
  const editedKeepRecord = makeRecord({ locations: [[null, editedKeep]], dateAccuracy: 1 });
  const editedRemovedRecord = makeRecord({
    locations: [["albumB", editedRemoved]],
    dateAccuracy: 1,
  });

  const media = [
    sameWorse,
    sameBest,
    crossTimelineRecord,
    crossAlbumRecord,
    editedKeepRecord,
    editedRemovedRecord,
  ];
  const context = makeContext();
  const groups = await findDuplicateRecords(media, context, CHUNK);
  const snapshots = snapshotDuplicateGroups(groups);
  assert.equal(snapshots.length, 3);

  const removedByDedupe = await removeDuplicates(media, context, CHUNK, groups);
  assert.equal(removedByDedupe, 1);
  const retainedAfterDeduplication = new Set(
    media.flatMap((record) => [...record.locations.values()]),
  );
  assert.equal(retainedAfterDeduplication.size, 5);
  const extrasRemoved = removeExtras(media);
  assert.equal(extrasRemoved, 1);
  await mergeAlbums(media, context, CHUNK);

  const finalized = finalizeDuplicateGroups(snapshots, media, retainedAfterDeduplication);
  assert.equal(finalized.length, 3);

  const byDigest = new Map(finalized.map((group) => [group.digest, group]));
  const sameGroup = byDigest.get(sha256Hex("same-source-bytes"));
  const sameByPath = new Map(sameGroup.members.map((member) => [member.path, member]));
  assert.equal(sameByPath.get(timelineB).disposition, DuplicateDisposition.PRIMARY);
  assert.equal(sameByPath.get(timelineB).reason, "作为主文件进入整理计划");
  assert.equal(sameByPath.get(timelineA).disposition, DuplicateDisposition.SKIPPED);
  assert.equal(
    sameByPath.get(timelineA).reason,
    "同一来源中已有完全相同文件；不进入输出计划，源文件不会被删除",
  );
  assert.equal(sameGroup.primaryPath, timelineB);
  assert.equal(sameGroup.dateSource, "exif");
  assert.equal(sameGroup.skippedCount, 1);

  const crossGroup = byDigest.get(sha256Hex("cross-album-bytes"));
  const crossByPath = new Map(crossGroup.members.map((member) => [member.path, member]));
  assert.equal(crossByPath.get(crossTimeline).disposition, DuplicateDisposition.PRIMARY);
  assert.equal(crossByPath.get(crossAlbum).disposition, DuplicateDisposition.ALBUM_COPY);
  assert.equal(
    crossByPath.get(crossAlbum).reason,
    "保留相册关系；按相册模式生成快捷方式、索引或实体副本",
  );
  assert.equal(crossGroup.albumCopyCount, 1);

  const editedGroup = byDigest.get(sha256Hex("edited-bytes"));
  const editedByPath = new Map(editedGroup.members.map((member) => [member.path, member]));
  assert.equal(editedByPath.get(editedKeep).disposition, DuplicateDisposition.PRIMARY);
  assert.equal(editedByPath.get(editedRemoved).disposition, DuplicateDisposition.FILTERED);
  assert.equal(
    editedByPath.get(editedRemoved).reason,
    "已按“跳过编辑副本”规则排除；源文件不会被删除",
  );
  // 成员排序：PRIMARY(0) -> ALBUM_COPY(1) -> SKIPPED(2) -> FILTERED(3)。
  for (const group of finalized) {
    const order = group.members.map((member) =>
      ({
        [DuplicateDisposition.PRIMARY]: 0,
        [DuplicateDisposition.ALBUM_COPY]: 1,
        [DuplicateDisposition.SKIPPED]: 2,
        [DuplicateDisposition.FILTERED]: 3,
      })[member.disposition],
    );
    assert.deepEqual(order, [...order].sort((left, right) => left - right));
  }
});

// ---------------------------------------------------------------------------
// planner：输出目录 / 相册模式 / 日期划分 / 未知日期 / 冲突
// ---------------------------------------------------------------------------

/** 创建一个源文件并返回路径。 */
function makeSource(root, relativePath, data = "media-bytes") {
  return writeFile(path.join(root, relativePath), data);
}

/** 取 action 的关键字段快照，便于断言。 */
function actionSummary(action) {
  return {
    kind: action.kind,
    source: action.source,
    target: action.target,
    album: action.album,
    reason: action.reason,
    status: action.status,
    bundleId: action.bundleId,
    livePhotoRole: action.livePhotoRole,
    sizeBytes: action.sizeBytes,
  };
}

test("buildPlan 默认 year-month 划分、ALL_PHOTOS 与 size_bytes", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const source = makeSource(sourceDir, "a.jpg", "abc");
  const dateTaken = new Date(2021, 4, 6, 12, 30, 0);
  const media = [makeRecord({ locations: [[null, source]], dateTaken })];
  const context = makeContext();
  const analysis = makeAnalysis(media, { inputDir: sourceDir, outputDir });

  const actions = buildPlan(analysis, context);

  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, ActionKind.COPY);
  assert.equal(actions[0].source, source);
  assert.equal(
    actions[0].target,
    path.join(outputDir, "ALL_PHOTOS", "2021", "05", "a.jpg"),
  );
  assert.equal(actions[0].album, null);
  assert.equal(actions[0].sizeBytes, 3);
  assert.equal(actions[0].reason, "");
  assert.equal(analysis.statistics.plannedActions, 1);
  assert.equal(context.progressUpdates[0].phase, Phase.PLANNING);
  assert.equal(context.progressUpdates[0].message, "规划输出：a.jpg");
});

test("buildPlan 支持 year / flat 日期划分", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const source = makeSource(sourceDir, "a.jpg");
  const dateTaken = new Date(2021, 10, 9);
  const context = makeContext();

  const yearAnalysis = makeAnalysis(
    [makeRecord({ locations: [[null, source]], dateTaken })],
    { inputDir: sourceDir, outputDir, options: { dateDivision: DateDivision.YEAR } },
  );
  const yearActions = buildPlan(yearAnalysis, context);
  assert.equal(yearActions[0].target, path.join(outputDir, "ALL_PHOTOS", "2021", "a.jpg"));

  const flatAnalysis = makeAnalysis(
    [makeRecord({ locations: [[null, source]], dateTaken })],
    { inputDir: sourceDir, outputDir, options: { dateDivision: DateDivision.FLAT } },
  );
  const flatActions = buildPlan(flatAnalysis, context);
  assert.equal(flatActions[0].target, path.join(outputDir, "ALL_PHOTOS", "a.jpg"));
});

test("buildPlan JSON 模式只取首个位置且进入时间线目录", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const albumFirst = makeSource(sourceDir, "album/album-file.jpg");
  const timeline = makeSource(sourceDir, "timeline/timeline-file.jpg");
  const dateTaken = new Date(2020, 3, 4);
  const record = makeRecord({
    locations: [
      ["albumA", albumFirst],
      [null, timeline],
    ],
    dateTaken,
  });
  const context = makeContext();
  const analysis = makeAnalysis([record], {
    inputDir: sourceDir,
    outputDir,
    options: { albumMode: AlbumMode.JSON },
  });

  const actions = buildPlan(analysis, context);

  assert.equal(actions.length, 1);
  // JSON 模式返回 next(iter(locations.values()))，即插入顺序中的第一个值。
  assert.equal(actions[0].source, albumFirst);
  assert.equal(actions[0].album, null);
  assert.equal(actions[0].target, path.join(outputDir, "ALL_PHOTOS", "2020", "04", "album-file.jpg"));
});

test("buildPlan NOTHING 模式只输出时间线位置", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const album = makeSource(sourceDir, "album/album-file.jpg");
  const timeline = makeSource(sourceDir, "timeline/timeline-file.jpg");
  const dateTaken = new Date(2020, 3, 4);
  const context = makeContext();

  const withTimeline = makeAnalysis(
    [makeRecord({ locations: [["albumA", album], [null, timeline]], dateTaken })],
    { inputDir: sourceDir, outputDir, options: { albumMode: AlbumMode.NOTHING } },
  );
  const actions = buildPlan(withTimeline, context);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].source, timeline);
  assert.equal(actions[0].album, null);

  const albumOnly = makeAnalysis(
    [makeRecord({ locations: [["albumA", album]], dateTaken })],
    { inputDir: sourceDir, outputDir, options: { albumMode: AlbumMode.NOTHING } },
  );
  assert.equal(buildPlan(albumOnly, context).length, 0);
});

test("buildPlan shortcut 模式为相册生成快捷方式与兜底字段", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const album = makeSource(sourceDir, "album/album-file.jpg");
  const timeline = makeSource(sourceDir, "timeline/timeline-file.jpg");
  const dateTaken = new Date(2020, 3, 4);
  // 相册位置先插入、时间线后插入，验证排序仍以时间线优先。
  const record = makeRecord({
    locations: [
      ["albumA", album],
      [null, timeline],
    ],
    dateTaken,
  });
  const context = makeContext();
  const analysis = makeAnalysis([record], {
    inputDir: sourceDir,
    outputDir,
    options: { albumMode: AlbumMode.SHORTCUT },
  });

  const actions = buildPlan(analysis, context);

  assert.equal(actions.length, 2);
  const timelineAction = actions[0];
  assert.equal(timelineAction.kind, ActionKind.COPY);
  assert.equal(timelineAction.source, timeline);
  assert.equal(timelineAction.album, null);
  const shortcutAction = actions[1];
  assert.equal(shortcutAction.kind, ActionKind.SHORTCUT);
  assert.equal(shortcutAction.source, timelineAction.target);
  assert.equal(shortcutAction.album, "albumA");
  assert.equal(shortcutAction.fallbackSource, album);
  assert.equal(
    shortcutAction.fallbackTarget,
    path.join(outputDir, "albumA", "2020", "04", "album-file.jpg"),
  );
  const expectedLinkName =
    path.basename(timelineAction.target) + (process.platform === "win32" ? ".lnk" : "");
  assert.equal(shortcutAction.target, path.join(outputDir, "albumA", "2020", "04", expectedLinkName));
});

test("buildPlan duplicate-copy 模式为每个相册输出实体副本", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const albumA = makeSource(sourceDir, "albumA/a.jpg");
  const albumB = makeSource(sourceDir, "albumB/b.jpg");
  const timeline = makeSource(sourceDir, "timeline/t.jpg");
  const dateTaken = new Date(2020, 3, 4);
  const record = makeRecord({
    locations: [
      ["albumB", albumB],
      [null, timeline],
      ["albumA", albumA],
    ],
    dateTaken,
  });
  const context = makeContext();
  const analysis = makeAnalysis([record], {
    inputDir: sourceDir,
    outputDir,
    options: { albumMode: AlbumMode.DUPLICATE_COPY },
  });

  const actions = buildPlan(analysis, context);

  assert.equal(actions.length, 3);
  assert.deepEqual(
    actions.map((action) => action.album),
    [null, "albumA", "albumB"],
  );
  for (const action of actions) {
    assert.equal(action.kind, ActionKind.COPY);
  }
  assert.equal(actions[0].target, path.join(outputDir, "ALL_PHOTOS", "2020", "04", "t.jpg"));
  assert.equal(actions[1].target, path.join(outputDir, "albumA", "2020", "04", "a.jpg"));
  assert.equal(actions[2].target, path.join(outputDir, "albumB", "2020", "04", "b.jpg"));
});

test("buildPlan 安全替换相册名中的 Windows 保留字符并回退未命名相册", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const source = makeSource(sourceDir, "a.jpg");
  const dateTaken = new Date(2020, 3, 4);
  const context = makeContext();

  const forbidden = makeAnalysis(
    [makeRecord({ locations: [["a<>:\"/\\|?*b", source]], dateTaken })],
    { inputDir: sourceDir, outputDir, options: { albumMode: AlbumMode.DUPLICATE_COPY } },
  );
  const forbiddenActions = buildPlan(forbidden, context);
  assert.equal(
    forbiddenActions[0].target,
    path.join(outputDir, "a_________b", "2020", "04", "a.jpg"),
  );

  const trimmed = makeAnalysis(
    [makeRecord({ locations: [["  .album.  ", source]], dateTaken })],
    { inputDir: sourceDir, outputDir, options: { albumMode: AlbumMode.DUPLICATE_COPY } },
  );
  assert.equal(
    buildPlan(trimmed, context)[0].target,
    path.join(outputDir, "album", "2020", "04", "a.jpg"),
  );

  const unnamed = makeAnalysis(
    [makeRecord({ locations: [["...", source]], dateTaken })],
    { inputDir: sourceDir, outputDir, options: { albumMode: AlbumMode.DUPLICATE_COPY } },
  );
  assert.equal(
    buildPlan(unnamed, context)[0].target,
    path.join(outputDir, "未命名相册", "2020", "04", "a.jpg"),
  );
});

test("buildPlan unknown-date folder / root / skip 三种策略", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const source = makeSource(sourceDir, "unknown.jpg");
  const context = makeContext();

  const folderAnalysis = makeAnalysis([makeRecord({ locations: [[null, source]] })], {
    inputDir: sourceDir,
    outputDir,
    options: { unknownDateMode: UnknownDateMode.FOLDER, unknownDateFolder: "date-unknown" },
  });
  const folderActions = buildPlan(folderAnalysis, context);
  assert.equal(
    folderActions[0].target,
    path.join(outputDir, "ALL_PHOTOS", "date-unknown", "unknown.jpg"),
  );

  const rootAnalysis = makeAnalysis([makeRecord({ locations: [[null, source]] })], {
    inputDir: sourceDir,
    outputDir,
    options: { unknownDateMode: UnknownDateMode.ROOT },
  });
  const rootActions = buildPlan(rootAnalysis, context);
  assert.equal(rootActions[0].target, path.join(outputDir, "ALL_PHOTOS", "unknown.jpg"));

  const skipAnalysis = makeAnalysis([makeRecord({ locations: [[null, source]] })], {
    inputDir: sourceDir,
    outputDir,
    options: { unknownDateMode: UnknownDateMode.SKIP },
  });
  const skipActions = buildPlan(skipAnalysis, context);
  assert.equal(skipActions.length, 1);
  assert.equal(skipActions[0].kind, ActionKind.SKIP);
  assert.equal(skipActions[0].target, null);
  assert.equal(skipActions[0].reason, "日期未知，按设置跳过");
});

test("buildPlan 未知日期的实况照片整组跳过并共享 bundle id", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const still = makeSource(sourceDir, "live.jpg", "STILL");
  const motion = makeSource(sourceDir, "live.mov", "MOTION");
  const record = makeRecord({
    locations: [[null, still]],
    companions: [[null, motion]],
  });
  const context = makeContext();
  const analysis = makeAnalysis([record], {
    inputDir: sourceDir,
    outputDir,
    options: { albumMode: AlbumMode.NOTHING, unknownDateMode: UnknownDateMode.SKIP },
  });

  const actions = buildPlan(analysis, context);

  assert.equal(actions.length, 2);
  assert.deepEqual(
    actions.map((action) => action.livePhotoRole),
    [LivePhotoRole.STILL, LivePhotoRole.MOTION],
  );
  assert.deepEqual(
    actions.map((action) => action.source),
    [still, motion],
  );
  assert.deepEqual(
    actions.map((action) => action.kind),
    [ActionKind.SKIP, ActionKind.SKIP],
  );
  assert.equal(actions[0].bundleId, "live-photo-000001");
  assert.equal(actions[1].bundleId, "live-photo-000001");
  assert.equal(actions[0].reason, "日期未知，整组实况照片按设置跳过");
  assert.equal(actions[0].sizeBytes, Buffer.byteLength("STILL"));
  assert.equal(actions[1].sizeBytes, Buffer.byteLength("MOTION"));
});

test("buildPlan 实况照片成组输出、Apple/ColorOS 原因与 bundle 编号", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const still = makeSource(sourceDir, "live.jpg", "STILL");
  const motion = makeSource(sourceDir, "live.mov", "MOTION");
  const dateTaken = new Date(2021, 0, 2);
  const context = makeContext();

  const appleAnalysis = makeAnalysis(
    [makeRecord({ locations: [[null, still]], companions: [[null, motion]], dateTaken })],
    { inputDir: sourceDir, outputDir, options: { albumMode: AlbumMode.NOTHING } },
  );
  const appleActions = buildPlan(appleAnalysis, context);
  assert.equal(appleActions.length, 2);
  assert.deepEqual(
    appleActions.map((action) => action.kind),
    [ActionKind.COPY, ActionKind.COPY],
  );
  assert.equal(appleActions[0].bundleId, "live-photo-000001");
  assert.equal(appleActions[1].bundleId, "live-photo-000001");
  assert.equal(appleActions[0].target, path.join(outputDir, "ALL_PHOTOS", "2021", "01", "live.jpg"));
  assert.equal(appleActions[1].target, path.join(outputDir, "ALL_PHOTOS", "2021", "01", "live.mov"));
  assert.equal(
    appleActions[0].reason,
    "实况照片静态图与动态片段成组输出，供 Apple 照片共同导入",
  );

  const colorosAnalysis = makeAnalysis(
    [makeRecord({ locations: [[null, still]], companions: [[null, motion]], dateTaken })],
    {
      inputDir: sourceDir,
      outputDir,
      options: { albumMode: AlbumMode.NOTHING, livePhotoTarget: LivePhotoTarget.COLOROS16 },
    },
  );
  const colorosActions = buildPlan(colorosAnalysis, context);
  assert.equal(
    colorosActions[0].reason,
    "实况照片保留原始配对；可导入 Apple 照片后通过 O+ 互联发送到 OPPO",
  );
});

test("buildPlan shortcut 模式下的相册实况照片使用同目录同基名实体文件", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const timelineStill = makeSource(sourceDir, "tl.jpg", "STILL");
  const timelineMotion = makeSource(sourceDir, "tl.mov", "MOTION");
  const albumStill = makeSource(sourceDir, "al.jpg", "STILL");
  const albumMotion = makeSource(sourceDir, "al.mov", "MOTION");
  const dateTaken = new Date(2021, 0, 2);
  const record = makeRecord({
    locations: [
      [null, timelineStill],
      ["albumA", albumStill],
    ],
    companions: [
      [null, timelineMotion],
      ["albumA", albumMotion],
    ],
    dateTaken,
  });
  const context = makeContext();
  const analysis = makeAnalysis([record], {
    inputDir: sourceDir,
    outputDir,
    options: { albumMode: AlbumMode.SHORTCUT },
  });

  const actions = buildPlan(analysis, context);

  // 时间线成组 2 个动作 + 相册成组 2 个动作（相册实况照片必须实体文件）。
  assert.equal(actions.length, 4);
  assert.deepEqual(
    actions.map((action) => action.bundleId),
    ["live-photo-000001", "live-photo-000001", "live-photo-000002", "live-photo-000002"],
  );
  const albumActions = actions.slice(2);
  assert.equal(albumActions[0].album, "albumA");
  assert.equal(albumActions[0].kind, ActionKind.COPY);
  assert.equal(
    albumActions[0].reason,
    "实况照片为保持设备可导入配对，使用同目录同基名实体文件",
  );
  assert.equal(
    albumActions[0].target,
    path.join(outputDir, "albumA", "2021", "01", "al.jpg"),
  );
  assert.equal(
    albumActions[1].target,
    path.join(outputDir, "albumA", "2021", "01", "al.mov"),
  );
});

test("buildPlan 实况照片同名冲突在 rename/skip/overwrite 下的成组行为", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const still = makeSource(sourceDir, "live.jpg", "STILL");
  const motion = makeSource(sourceDir, "live.mov", "MOTION");
  const dateTaken = new Date(2021, 0, 2);
  const conflictDir = path.join(outputDir, "ALL_PHOTOS", "2021", "01");
  fs.mkdirSync(conflictDir, { recursive: true });
  // overwrite 模式只覆盖“运行前已存在”的文件，因此每个模式使用独立输出目录。
  const context = makeContext();

  writeFile(path.join(conflictDir, "live.jpg"), "existing-still");
  const renameOut = path.join(root, "out-rename");
  const renameAnalysis = makeAnalysis(
    [makeRecord({ locations: [[null, still]], companions: [[null, motion]], dateTaken })],
    {
      inputDir: sourceDir,
      outputDir: renameOut,
      options: { albumMode: AlbumMode.NOTHING, conflictMode: ConflictMode.RENAME },
    },
  );
  fs.mkdirSync(path.join(renameOut, "ALL_PHOTOS", "2021", "01"), { recursive: true });
  writeFile(path.join(renameOut, "ALL_PHOTOS", "2021", "01", "live.jpg"), "existing-still");
  const renameActions = buildPlan(renameAnalysis, context);
  assert.equal(renameActions[0].kind, ActionKind.COPY);
  assert.equal(
    renameActions[0].target,
    path.join(renameOut, "ALL_PHOTOS", "2021", "01", "live(1).jpg"),
  );
  assert.equal(
    renameActions[1].target,
    path.join(renameOut, "ALL_PHOTOS", "2021", "01", "live(1).mov"),
  );

  const skipOut = path.join(root, "out-skip");
  const skipAnalysis = makeAnalysis(
    [makeRecord({ locations: [[null, still]], companions: [[null, motion]], dateTaken })],
    {
      inputDir: sourceDir,
      outputDir: skipOut,
      options: { albumMode: AlbumMode.NOTHING, conflictMode: ConflictMode.SKIP },
    },
  );
  fs.mkdirSync(path.join(skipOut, "ALL_PHOTOS", "2021", "01"), { recursive: true });
  writeFile(path.join(skipOut, "ALL_PHOTOS", "2021", "01", "live.jpg"), "existing-still");
  const skipActions = buildPlan(skipAnalysis, context);
  assert.deepEqual(
    skipActions.map((action) => action.kind),
    [ActionKind.SKIP, ActionKind.SKIP],
  );
  assert.equal(skipActions[0].reason, "实况照片任一半发生同名冲突，已整组跳过");

  const overwriteOut = path.join(root, "out-overwrite");
  const overwriteAnalysis = makeAnalysis(
    [makeRecord({ locations: [[null, still]], companions: [[null, motion]], dateTaken })],
    {
      inputDir: sourceDir,
      outputDir: overwriteOut,
      options: { albumMode: AlbumMode.NOTHING, conflictMode: ConflictMode.OVERWRITE },
    },
  );
  fs.mkdirSync(path.join(overwriteOut, "ALL_PHOTOS", "2021", "01"), { recursive: true });
  writeFile(path.join(overwriteOut, "ALL_PHOTOS", "2021", "01", "live.jpg"), "existing-still");
  const overwriteActions = buildPlan(overwriteAnalysis, context);
  assert.equal(overwriteActions[0].kind, ActionKind.COPY);
  assert.equal(
    overwriteActions[0].target,
    path.join(overwriteOut, "ALL_PHOTOS", "2021", "01", "live.jpg"),
  );
});

test("buildPlan 普通文件同名冲突在 rename/skip/overwrite 下的目标", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const source = makeSource(sourceDir, "photo.jpg", "NEW");
  const dateTaken = new Date(2021, 0, 2);
  const context = makeContext();

  const renameOut = path.join(root, "rename-out");
  writeFile(path.join(renameOut, "ALL_PHOTOS", "2021", "01", "photo.jpg"), "OLD");
  const renameAnalysis = makeAnalysis([makeRecord({ locations: [[null, source]], dateTaken })], {
    inputDir: sourceDir,
    outputDir: renameOut,
    options: { conflictMode: ConflictMode.RENAME },
  });
  const renameActions = buildPlan(renameAnalysis, context);
  assert.equal(
    renameActions[0].target,
    path.join(renameOut, "ALL_PHOTOS", "2021", "01", "photo(1).jpg"),
  );

  const skipOut = path.join(root, "skip-out");
  writeFile(path.join(skipOut, "ALL_PHOTOS", "2021", "01", "photo.jpg"), "OLD");
  const skipAnalysis = makeAnalysis([makeRecord({ locations: [[null, source]], dateTaken })], {
    inputDir: sourceDir,
    outputDir: skipOut,
    options: { conflictMode: ConflictMode.SKIP },
  });
  const skipActions = buildPlan(skipAnalysis, context);
  assert.equal(skipActions[0].kind, ActionKind.SKIP);
  assert.equal(skipActions[0].reason, "目标同名，按设置跳过");
  assert.equal(skipActions[0].target, path.join(skipOut, "ALL_PHOTOS", "2021", "01", "photo.jpg"));
  assert.equal(skipActions[0].sizeBytes, null);

  const overwriteOut = path.join(root, "overwrite-out");
  writeFile(path.join(overwriteOut, "ALL_PHOTOS", "2021", "01", "photo.jpg"), "OLD");
  const overwriteAnalysis = makeAnalysis(
    [makeRecord({ locations: [[null, source]], dateTaken })],
    {
      inputDir: sourceDir,
      outputDir: overwriteOut,
      options: { conflictMode: ConflictMode.OVERWRITE, operation: OperationMode.MOVE },
    },
  );
  const overwriteActions = buildPlan(overwriteAnalysis, context);
  assert.equal(overwriteActions[0].kind, ActionKind.MOVE);
  assert.equal(
    overwriteActions[0].target,
    path.join(overwriteOut, "ALL_PHOTOS", "2021", "01", "photo.jpg"),
  );
});

test("buildPlan 计划内的第二个同名文件在 overwrite 模式下仍会改名", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const first = makeSource(sourceDir, "one/photo.jpg");
  const second = makeSource(sourceDir, "two/photo.jpg");
  const dateTaken = new Date(2021, 0, 2);
  const context = makeContext();
  const analysis = makeAnalysis(
    [
      makeRecord({ locations: [[null, first]], dateTaken }),
      makeRecord({ locations: [[null, second]], dateTaken }),
    ],
    { inputDir: sourceDir, outputDir, options: { conflictMode: ConflictMode.OVERWRITE } },
  );

  const actions = buildPlan(analysis, context);

  assert.equal(actions.length, 2);
  assert.equal(actions[0].target, path.join(outputDir, "ALL_PHOTOS", "2021", "01", "photo.jpg"));
  assert.equal(
    actions[1].target,
    path.join(outputDir, "ALL_PHOTOS", "2021", "01", "photo(1).jpg"),
  );
});

test("buildPlan 按拍摄日期修正严格日期型文件名并记录原因", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const source = makeSource(sourceDir, "2020-01-02.jpg");
  const dateTaken = new Date(2021, 4, 6);
  const context = makeContext();
  const analysis = makeAnalysis([makeRecord({ locations: [[null, source]], dateTaken })], {
    inputDir: sourceDir,
    outputDir,
    options: { correctDateFilenames: true },
  });

  const actions = buildPlan(analysis, context);

  assert.equal(actions[0].target, path.join(outputDir, "ALL_PHOTOS", "2021", "05", "2021-05-06.jpg"));
  assert.equal(actions[0].reason, "文件名日期已按拍摄日期修正");
});

test("buildPlan 输出后缀覆盖与日期修正组合", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const source = makeSource(sourceDir, "2020-01-02.xyz");
  const dateTaken = new Date(2021, 4, 6);
  const context = makeContext();
  const record = makeRecord({
    locations: [[null, source]],
    dateTaken,
    outputSuffixes: [[null, "mp4"]],
  });
  const analysis = makeAnalysis([record], {
    inputDir: sourceDir,
    outputDir,
    options: { correctDateFilenames: true },
  });

  const actions = buildPlan(analysis, context);

  assert.equal(
    actions[0].target,
    path.join(outputDir, "ALL_PHOTOS", "2021", "05", "2021-05-06.mp4"),
  );
  assert.equal(actions[0].reason, "文件名日期已按拍摄日期修正");
});

test("buildPlan 实况照片按拍摄日期修正时原因追加提示", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const still = makeSource(sourceDir, "2020-01-02.jpg", "STILL");
  const motion = makeSource(sourceDir, "2020-01-02.mov", "MOTION");
  const dateTaken = new Date(2021, 4, 6);
  const context = makeContext();
  const analysis = makeAnalysis(
    [makeRecord({ locations: [[null, still]], companions: [[null, motion]], dateTaken })],
    {
      inputDir: sourceDir,
      outputDir,
      options: { albumMode: AlbumMode.NOTHING, correctDateFilenames: true },
    },
  );

  const actions = buildPlan(analysis, context);

  assert.equal(actions.length, 2);
  assert.equal(actions[0].target, path.join(outputDir, "ALL_PHOTOS", "2021", "05", "2021-05-06.jpg"));
  // 动态片段后缀沿用源文件（扫描阶段会补 output_motion_suffix，这里没有）。
  assert.equal(actions[1].target, path.join(outputDir, "ALL_PHOTOS", "2021", "05", "2021-05-06.mov"));
  assert.equal(
    actions[0].reason,
    "实况照片静态图与动态片段成组输出，供 Apple 照片共同导入；文件名日期已按拍摄日期修正",
  );
});

test("buildPlan 在相册条目没有可用输出目录时给出跳过原因", () => {
  const root = makeTempDir();
  const sourceDir = path.join(root, "src");
  const outputDir = path.join(root, "out");
  const still = makeSource(sourceDir, "timeline.jpg");
  const motion = makeSource(sourceDir, "timeline.mov");
  const album = makeSource(sourceDir, "album.jpg");
  // 实况照片只与时间线配对；相册位置是没有动态片段的独立文件。
  // 未知日期 + skip 时，时间线分支整组跳过，相册分支落到“没有可用输出目录”。
  const record = makeRecord({
    locations: [
      [null, still],
      ["albumA", album],
    ],
    companions: [[null, motion]],
  });
  const context = makeContext();
  const analysis = makeAnalysis([record], {
    inputDir: sourceDir,
    outputDir,
    options: { albumMode: AlbumMode.DUPLICATE_COPY, unknownDateMode: UnknownDateMode.SKIP },
  });

  const actions = buildPlan(analysis, context);

  assert.equal(actions.length, 3);
  assert.deepEqual(
    actions.map((action) => action.kind),
    [ActionKind.SKIP, ActionKind.SKIP, ActionKind.SKIP],
  );
  assert.deepEqual(
    actions.map((action) => action.reason),
    [
      "日期未知，整组实况照片按设置跳过",
      "日期未知，整组实况照片按设置跳过",
      "没有可用输出目录",
    ],
  );
  assert.equal(actions[2].album, "albumA");
  assert.equal(actions[2].source, album);
});

// ---------------------------------------------------------------------------
// duplicates：inspect / thumbnail
// ---------------------------------------------------------------------------

/** 用 sharp 生成一张纯色 JPEG。 */
async function createJpeg(filePath, { width = 120, height = 60, orientation = null } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  }).jpeg();
  if (orientation !== null) {
    pipeline = pipeline.withMetadata({ orientation });
  }
  await pipeline.toFile(filePath);
  return filePath;
}

/** 用 sharp 生成一张带 alpha 的 PNG。 */
async function createPng(filePath, { width = 80, height = 40 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 100, b: 50, alpha: 0.5 },
    },
  })
    .png()
    .toFile(filePath);
  return filePath;
}

test("inspectDuplicateFile 读取 JPEG 基础信息", async () => {
  const root = makeTempDir();
  const filePath = await createJpeg(path.join(root, "photo.jpg"), { width: 120, height: 60 });

  const details = await inspectDuplicateFile(filePath);

  assert.equal(details.path, filePath);
  assert.equal(details.exists, true);
  assert.equal(details.sizeBytes, fs.statSync(filePath).size);
  assert.ok(details.modifiedAt instanceof Date);
  assert.equal(details.mimeType, "image/jpeg");
  assert.equal(details.declaredExtension, ".jpg");
  assert.equal(details.decodedFormat, "JPEG");
  assert.deepEqual(details.rawSize, [120, 60]);
  assert.deepEqual(details.displaySize, [120, 60]);
  assert.equal(details.frameCount, 1);
  assert.equal(details.error, null);
});

test("inspectDuplicateFile 按 EXIF Orientation 计算显示分辨率", async () => {
  const root = makeTempDir();
  const filePath = await createJpeg(path.join(root, "rotated.jpg"), {
    width: 120,
    height: 60,
    orientation: 6,
  });

  const details = await inspectDuplicateFile(filePath);

  assert.deepEqual(details.rawSize, [120, 60]);
  assert.deepEqual(details.displaySize, [60, 120]);
  assert.equal(details.error, null);
});

test("inspectDuplicateFile 处理缺失路径、目录与非图片文件", async () => {
  const root = makeTempDir();

  const missing = await inspectDuplicateFile(path.join(root, "none.jpg"));
  assert.equal(missing.exists, false);
  assert.equal(missing.error, "文件不存在");
  assert.equal(missing.decodedFormat, null);

  const directory = await inspectDuplicateFile(root);
  assert.equal(directory.exists, true);
  assert.equal(directory.error, "路径不是普通文件");

  const textFile = writeFile(path.join(root, "note.txt"), "hello");
  const textDetails = await inspectDuplicateFile(textFile);
  assert.equal(textDetails.error, null);
  assert.equal(textDetails.decodedFormat, null);
  assert.equal(textDetails.declaredExtension, ".txt");
});

test("inspectDuplicateFile 对伪造 HEIC 给出可操作诊断", async () => {
  const root = makeTempDir();
  const filePath = writeFile(path.join(root, "fake.heic"), "not a real heic file");

  const details = await inspectDuplicateFile(filePath);

  assert.equal(details.declaredExtension, ".heic");
  assert.ok(typeof details.error === "string" && details.error.length > 0);
  assert.match(details.error, /HEIC\/HEIF/);
});

test("buildThumbnail 生成保持比例且不放大的 PNG", async () => {
  const root = makeTempDir();
  const filePath = await createJpeg(path.join(root, "photo.jpg"), { width: 120, height: 60 });

  const result = await buildThumbnail(filePath, [360, 240]);

  assert.equal(result.status, ThumbnailStatus.READY);
  assert.ok(Buffer.isBuffer(result.pngBytes));
  assert.deepEqual([...result.pngBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(result.decodedFormat, "JPEG");
  assert.deepEqual(result.rawSize, [120, 60]);
  assert.deepEqual(result.displaySize, [120, 60]);
  // bounds 比图片大：不放大。
  assert.deepEqual(result.thumbnailSize, [120, 60]);
  assert.equal(result.error, null);

  const pngMeta = await sharp(result.pngBytes).metadata();
  assert.equal(pngMeta.width, 120);
  assert.equal(pngMeta.height, 60);

  const smaller = await buildThumbnail(filePath, [50, 50]);
  assert.equal(smaller.status, ThumbnailStatus.READY);
  assert.deepEqual(smaller.thumbnailSize, [50, 25]);
});

test("buildThumbnail 对 PNG（含 alpha）与 EXIF 旋转图片正确输出", async () => {
  const root = makeTempDir();
  const pngPath = await createPng(path.join(root, "image.png"), { width: 80, height: 40 });

  const pngResult = await buildThumbnail(pngPath, [360, 240]);
  assert.equal(pngResult.status, ThumbnailStatus.READY);
  assert.equal(pngResult.decodedFormat, "PNG");
  assert.deepEqual(pngResult.rawSize, [80, 40]);
  assert.deepEqual(pngResult.thumbnailSize, [80, 40]);

  const rotatedPath = await createJpeg(path.join(root, "rotated.jpg"), {
    width: 120,
    height: 60,
    orientation: 6,
  });
  const rotatedResult = await buildThumbnail(rotatedPath, [360, 240]);
  assert.equal(rotatedResult.status, ThumbnailStatus.READY);
  assert.deepEqual(rotatedResult.rawSize, [120, 60]);
  assert.deepEqual(rotatedResult.displaySize, [60, 120]);
  assert.deepEqual(rotatedResult.thumbnailSize, [60, 120]);
});

test("buildThumbnail 复刻 Pillow 的宽高比取整规则", async () => {
  const root = makeTempDir();
  // 1000x250（宽高比 4）在 50x50 边界下：Pillow 12 选择 13 而不是 12，
  // 因为 50/13 比 50/12 更接近原始宽高比。
  const filePath = await createJpeg(path.join(root, "wide.jpg"), { width: 1000, height: 250 });

  const result = await buildThumbnail(filePath, [50, 50]);

  assert.equal(result.status, ThumbnailStatus.READY);
  assert.deepEqual(result.thumbnailSize, [50, 13]);
  const pngMeta = await sharp(result.pngBytes).metadata();
  assert.deepEqual([pngMeta.width, pngMeta.height], [50, 13]);
});

test("buildThumbnail 对缺失、非图片与非法边界返回稳定状态", async () => {
  const root = makeTempDir();
  const missing = await buildThumbnail(path.join(root, "none.jpg"));
  assert.equal(missing.status, ThumbnailStatus.MISSING);
  assert.equal(missing.pngBytes, null);
  assert.equal(missing.error, "文件不存在或不是普通文件");

  const textFile = writeFile(path.join(root, "note.txt"), "hello");
  const notImage = await buildThumbnail(textFile);
  assert.equal(notImage.status, ThumbnailStatus.NOT_IMAGE);
  assert.equal(notImage.error, "该文件不是受支持的图片");

  const jpegPath = await createJpeg(path.join(root, "photo.jpg"));
  const invalidBounds = await buildThumbnail(jpegPath, [0, 240]);
  assert.equal(invalidBounds.status, ThumbnailStatus.CORRUPT);
  assert.equal(invalidBounds.error, "缩略图尺寸必须是两个正整数");
});

test("MAX_THUMBNAIL_PIXELS 为 80M 且超限图片返回 TOO_LARGE", async () => {
  assert.equal(MAX_THUMBNAIL_PIXELS, 80_000_000);
  const root = makeTempDir();
  const filePath = await createPng(path.join(root, "tiny.png"), { width: 1, height: 1 });
  // 直接改写 PNG IHDR 中的宽高并修复 CRC：不真正分配 90M 像素。
  const buffer = fs.readFileSync(filePath);
  buffer.writeUInt32BE(10000, 16);
  buffer.writeUInt32BE(9000, 20);
  const crc = zlib.crc32(buffer.subarray(12, 29)) >>> 0;
  buffer.writeUInt32BE(crc, 29);
  writeFile(filePath, buffer);

  const details = await inspectDuplicateFile(filePath);
  assert.equal(details.error, "图片分辨率 10000×9000 超过安全缩略图上限");
  assert.deepEqual(details.rawSize, [10000, 9000]);

  const result = await buildThumbnail(filePath, [360, 240]);
  assert.equal(result.status, ThumbnailStatus.TOO_LARGE);
  assert.equal(result.error, "图片分辨率 10000×9000 超过安全缩略图上限");
  assert.equal(result.pngBytes, null);
});
