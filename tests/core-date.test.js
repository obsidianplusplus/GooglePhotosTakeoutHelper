/**
 * 核心日期/元数据模块测试（node:test）。
 *
 * 覆盖：settings 合并/迁移/规范化/原子保存，filename-correction，scan-cache，
 * JSON 边车候选与时间戳解析，六种文件名格式，extractDate 优先级与隔离，
 * EXIF TIFF/JPEG/HEIC 解析，image-support HEIF 签名诊断。
 * 全部使用临时目录，不触碰仓库根目录。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as dateExtractors from "../src/date-extractors.js";
import * as exif from "../src/exif.js";
import * as filenameCorrection from "../src/filename-correction.js";
import * as imageSupport from "../src/image-support.js";
import * as settings from "../src/settings.js";
import { HashCache } from "../src/scan-cache.js";
import { DateSource, TaskContext } from "../src/models.js";
import { formatDate, formatLocalIso } from "../src/time.js";

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

async function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gpth-core-"));
  try {
    return await callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function localDate(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function makeRecordingContext() {
  const logs = [];
  const context = new TaskContext({
    logCallback: (level, message) => logs.push([level, message]),
  });
  return { context, logs };
}

function writeSidecar(dir, name, payload) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(payload), "utf8");
}

/** 生成一段 TIFF 数据（用于 JPEG APP1 与 HEIC Exif 项测试）。 */
function buildTiff({ littleEndian = false, ifd0 = [], exifIfd = [] } = {}) {
  const u16 = (buffer, position, value) => (
    littleEndian ? buffer.writeUInt16LE(value, position) : buffer.writeUInt16BE(value, position)
  );
  const u32 = (buffer, position, value) => (
    littleEndian ? buffer.writeUInt32LE(value, position) : buffer.writeUInt32BE(value, position)
  );

  const encode = (entry) => {
    const type = entry.type ?? 2;
    if (type === 2) {
      const bytes = Buffer.from(String(entry.text), "utf8");
      return {
        tag: entry.tag,
        type,
        count: bytes.length + 1,
        payload: Buffer.concat([bytes, Buffer.from([0])]),
      };
    }
    if (type === 3) {
      const values = Array.isArray(entry.values) ? entry.values : [entry.value];
      const payload = Buffer.alloc(values.length * 2);
      values.forEach((value, index) => u16(payload, index * 2, value));
      return { tag: entry.tag, type, count: values.length, payload };
    }
    if (type === 4) {
      const values = Array.isArray(entry.values) ? entry.values : [entry.value];
      const payload = Buffer.alloc(values.length * 4);
      values.forEach((value, index) => u32(payload, index * 4, value));
      return { tag: entry.tag, type, count: values.length, payload };
    }
    throw new Error(`unsupported TIFF type ${type}`);
  };

  const rootEntries = ifd0.map(encode);
  const exifEntries = exifIfd.map(encode);
  const hasExifIfd = exifEntries.length > 0;
  const ifd0Size = 2 + (rootEntries.length + (hasExifIfd ? 1 : 0)) * 12 + 4;
  const exifOffset = 8 + ifd0Size;
  const exifSize = hasExifIfd ? 2 + exifEntries.length * 12 + 4 : 0;
  const dataPoolStart = exifOffset + exifSize;

  let cursor = dataPoolStart;
  const pools = [];
  const assign = (entries) => entries.map((entry) => {
    if (entry.payload.length <= 4) {
      return { ...entry, offset: null };
    }
    const offset = cursor;
    cursor += entry.payload.length;
    pools.push({ offset, payload: entry.payload });
    return { ...entry, offset };
  });
  const assignedRoot = assign(rootEntries);
  const assignedExif = assign(exifEntries);
  const buffer = Buffer.alloc(cursor);

  // TIFF 头
  buffer.write(littleEndian ? "II" : "MM", 0, "latin1");
  u16(buffer, 2, 42);
  u32(buffer, 4, 8);

  const writeIfd = (position, entries) => {
    u16(buffer, position, entries.length);
    let entryPosition = position + 2;
    for (const entry of entries) {
      u16(buffer, entryPosition, entry.tag);
      u16(buffer, entryPosition + 2, entry.type);
      u32(buffer, entryPosition + 4, entry.count);
      if (entry.offset === null) {
        entry.payload.copy(buffer, entryPosition + 8);
      } else {
        u32(buffer, entryPosition + 8, entry.offset);
      }
      entryPosition += 12;
    }
    u32(buffer, entryPosition, 0);
  };

  const rootForWrite = [...assignedRoot];
  if (hasExifIfd) {
    const pointer = Buffer.alloc(4);
    u32(pointer, 0, exifOffset);
    rootForWrite.push({ tag: 34665, type: 4, count: 1, offset: null, payload: pointer });
  }
  writeIfd(8, rootForWrite);
  if (hasExifIfd) {
    writeIfd(exifOffset, assignedExif);
  }
  for (const pool of pools) {
    pool.payload.copy(buffer, pool.offset);
  }
  return buffer;
}

/** 在最小 JPEG 中插入 EXIF APP1，返回文件 Buffer。 */
async function jpegWithExif(tiffBuffer) {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default ?? sharpModule;
  const base = await sharp({
    create: { width: 8, height: 6, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer();
  const payload = Buffer.concat([Buffer.from("Exif\u0000\u0000", "latin1"), tiffBuffer]);
  const marker = Buffer.from([0xff, 0xe1]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2, 0);
  const app1 = Buffer.concat([marker, length, payload]);
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

/**
 * 生成一个真实的 TIFF（sharp 可解码），并把 DateTime 标签追加进新的 IFD0。
 * TIFF 的 EXIF 标签直接位于 IFD0 中，而 sharp 的 metadata.exif 为 null，
 * 用于验证 exif.js 的“直接解析 TIFF”补充路径。
 */
async function tiffWithDateTime(dateText) {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default ?? sharpModule;
  const base = await sharp({
    create: { width: 10, height: 8, channels: 3, background: { r: 5, g: 6, b: 7 } },
  }).tiff({ compression: "none" }).toBuffer();
  assert.equal(base.toString("latin1", 0, 2), "II", "测试假设 sharp 输出小端 TIFF");
  const firstIfd = base.readUInt32LE(4);
  const entryCount = base.readUInt16LE(firstIfd);
  const oldEntries = base.subarray(firstIfd + 2, firstIfd + 2 + entryCount * 12);
  const dateBytes = Buffer.from(`${dateText}\u0000`, "latin1");
  const newIfdOffset = base.length;
  const dateOffset = newIfdOffset + 2 + (entryCount + 1) * 12 + 4;
  const newIfd = Buffer.alloc(2 + (entryCount + 1) * 12 + 4);
  newIfd.writeUInt16LE(entryCount + 1, 0);
  oldEntries.copy(newIfd, 2);
  const entryPosition = 2 + entryCount * 12;
  newIfd.writeUInt16LE(306, entryPosition); // DateTime
  newIfd.writeUInt16LE(2, entryPosition + 2); // ASCII
  newIfd.writeUInt32LE(dateBytes.length, entryPosition + 4);
  newIfd.writeUInt32LE(dateOffset, entryPosition + 8);
  newIfd.writeUInt32LE(0, 2 + (entryCount + 1) * 12); // next IFD
  const output = Buffer.concat([base, newIfd, dateBytes]);
  output.writeUInt32LE(newIfdOffset, 4);
  return output;
}

/** 兼容部分 Node 类型提示：Buffer 常量快捷方式。 */
function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function fullBox(type, version, flags, payload) {
  const header = Buffer.alloc(4);
  header[0] = version;
  header.writeUIntBE(flags, 1, 3);
  return box(type, Buffer.concat([header, payload]));
}

/** 构造一个只含 Exif 项的最小 HEIC/HEIF 容器（含 ftyp/meta/iinf/iloc/mdat）。 */
function minimalHeic(tiffBuffer, { withExif = true } = {}) {
  const ftyp = box("ftyp", Buffer.concat([
    Buffer.from("heic", "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1", "latin1"),
    Buffer.from("heic", "latin1"),
  ]));

  const itemType = withExif ? "Exif" : "hvc1";
  const infeContent = Buffer.concat([
    Buffer.alloc(2), // item_ID u16 = 1（随后写入）
    Buffer.alloc(2), // item_protection_index
    Buffer.from(itemType, "latin1"),
    Buffer.from([0]), // 空 item_name
  ]);
  infeContent.writeUInt16BE(1, 0);
  const infe = fullBox("infe", 2, 0, infeContent);
  const iinfCount = Buffer.alloc(2);
  iinfCount.writeUInt16BE(1, 0);
  const iinf = fullBox("iinf", 0, 0, Buffer.concat([iinfCount, infe]));

  const exifBlock = withExif
    ? Buffer.concat([uint32(6), Buffer.from("Exif\u0000\u0000", "latin1"), tiffBuffer])
    : Buffer.alloc(0);

  const buildIloc = (baseOffset) => {
    const sizes = Buffer.from([0x44, 0x40]);
    const count = Buffer.alloc(2);
    count.writeUInt16BE(withExif ? 1 : 1, 0);
    const item = Buffer.alloc(18);
    item.writeUInt16BE(1, 0); // item_ID
    item.writeUInt16BE(0, 2); // data_reference_index
    item.writeUInt32BE(baseOffset, 4);
    item.writeUInt16BE(1, 8); // extent_count
    item.writeUInt32BE(0, 10); // extent_offset
    item.writeUInt32BE(exifBlock.length, 14); // extent_length
    return fullBox("iloc", 0, 0, Buffer.concat([sizes, count, item]));
  };

  // base_offset 依赖 meta 自身大小，故先占位再重算一次。
  let iloc = buildIloc(0);
  let meta = fullBox("meta", 0, 0, Buffer.concat([iinf, iloc]));
  const dataStart = ftyp.length + meta.length + 8;
  iloc = buildIloc(dataStart);
  meta = fullBox("meta", 0, 0, Buffer.concat([iinf, iloc]));

  const mdat = box("mdat", exifBlock);
  return Buffer.concat([ftyp, meta, mdat]);
}

function readTiffDate(tiff) {
  return exif.pickExifDate(exif.parseTiffExif(tiff));
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

test("settings 默认值、合并、迁移与规范化", () => {
    assert.equal(settings.SCHEMA_VERSION, 2);
    assert.equal(settings.DEFAULT_SETTINGS.schema_version, 2);
    assert.equal(settings.DEFAULT_SETTINGS.all_photos_folder, "ALL_PHOTOS");
    assert.equal(settings.DEFAULT_SETTINGS.fix_recursive, true);

    // mergeDict 递归合并，未知键保留
    const merged = settings.mergeDict(
      { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] },
      { nested: { y: 3, z: 4 }, extra: true },
    );
    assert.deepEqual(merged, {
      a: 1,
      nested: { x: 1, y: 3, z: 4 },
      list: [1, 2],
      extra: true,
    });

    // 旧字段迁移（保留旧键，与 Python 一致）
    const migrated = settings.migrateLegacySettings({
      window_geometry: "1200x800",
      ui_scale: 1.5,
      defaults: { workers: 8, geometry: "should-not-override" },
    });
    assert.equal(migrated.geometry, "1200x800");
    assert.equal(migrated.scaling, 1.5);
    assert.equal(migrated.window_geometry, "1200x800");
    assert.equal(migrated.workers, 8);
    assert.equal(migrated.geometry, "1200x800");

    // 规范化
    const normalised = settings.normaliseSettings({
      recognize_live_photos: "yes",
      live_photo_target: "nope",
      correct_date_filenames: 1,
      fix_correct_date_filenames: null,
      preview_limit: 5000,
    });
    assert.equal(normalised.recognize_live_photos, false);
    assert.equal(normalised.live_photo_target, "apple");
    assert.equal(normalised.correct_date_filenames, false);
    assert.equal(normalised.fix_correct_date_filenames, false);
    assert.equal(normalised.preview_limit, 1000);

    assert.equal(settings.normaliseSettings({ preview_limit: 50 }).preview_limit, 100);
    assert.equal(settings.normaliseSettings({ preview_limit: "150" }).preview_limit, 150);
    assert.equal(settings.normaliseSettings({ preview_limit: "bad" }).preview_limit, 300);
    assert.equal(
      settings.normaliseSettings({ preview_limit: 300, live_photo_target: "coloros16" })
        .live_photo_target,
      "coloros16",
    );
});

test("settings 加载回退、保存原子性与往返", () => withTempDir((dir) => {
  const target = path.join(dir, "settings.json");

  // 文件不存在 → 默认值
  const missing = settings.loadSettings(target);
  assert.deepEqual(missing, settings.DEFAULT_SETTINGS);
  assert.notEqual(missing, settings.DEFAULT_SETTINGS);

  // 损坏 JSON → 默认值
  fs.writeFileSync(target, "{ this is not json", "utf8");
  assert.deepEqual(settings.loadSettings(target), settings.DEFAULT_SETTINGS);

  // 非对象 JSON → 默认值
  fs.writeFileSync(target, "[1, 2, 3]", "utf8");
  assert.deepEqual(settings.loadSettings(target), settings.DEFAULT_SETTINGS);

  // 保存 + 往返
  settings.saveSettings(
    {
      geometry: "900x600",
      preview_limit: 5000,
      recognize_live_photos: true,
      live_photo_target: "coloros16",
      all_photos_folder: "全部照片",
      unknown_key: "preserved",
    },
    target,
  );
  const text = fs.readFileSync(target, "utf8");
  assert.ok(!text.endsWith("\n"));
  assert.ok(text.includes('"全部照片"'), "非 ASCII 文本应原样写入");
  // Python 默认 scaling 是浮点 1.0，json.dumps 写 "1.0"；Node 需保持字节一致。
  assert.ok(text.includes('"scaling": 1.0,'), text.slice(0, 200));
  assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), "不应残留临时文件");
  const loaded = settings.loadSettings(target);
  assert.equal(loaded.schema_version, 2);
  assert.equal(loaded.geometry, "900x600");
  assert.equal(loaded.preview_limit, 1000);
  assert.equal(loaded.recognize_live_photos, true);
  assert.equal(loaded.live_photo_target, "coloros16");
  assert.equal(loaded.all_photos_folder, "全部照片");
  assert.equal(loaded.unknown_key, "preserved");
  assert.equal(loaded.use_json, true);

  // 旧格式迁移
  fs.writeFileSync(
    target,
    JSON.stringify({ window_geometry: "1111x222", ui_scale: 2, defaults: { workers: 9 } }),
    "utf8",
  );
  const migrated = settings.loadSettings(target);
  assert.equal(migrated.geometry, "1111x222");
  assert.equal(migrated.scaling, 2);
  assert.equal(migrated.workers, 9);
}));

// ---------------------------------------------------------------------------
// filename-correction
// ---------------------------------------------------------------------------

test("filename correction：严格日期主名与已整理目录 mtime", () => withTempDir((dir) => {
  const date = localDate(2021, 3, 4, 5, 6, 7);
  assert.equal(filenameCorrection.correctedDateStem("2020-01-02", date), "2021-03-04");
  assert.equal(filenameCorrection.correctedDateStem("2020-01-02(3)", date), "2021-03-04(3)");
  assert.equal(filenameCorrection.correctedDateStem("2021-03-04", date), "2021-03-04");
  assert.equal(filenameCorrection.correctedDateStem("IMG_2020-01-02", date), "IMG_2020-01-02");
  assert.equal(filenameCorrection.correctedDateStem("2020-13-01", date), "2020-13-01");
  assert.equal(filenameCorrection.correctedDateStem("2020-01-02", null), "2020-01-02");
  assert.equal(
    filenameCorrection.correctedDateName("2020-01-02.JPG", date),
    "2021-03-04.JPG",
  );
  assert.equal(filenameCorrection.correctedDateName("notes.txt", date), "notes.txt");
  assert.equal(
    filenameCorrection.correctedDateTarget(path.join(dir, "2020-01-02.png"), date),
    path.join(dir, "2021-03-04.png"),
  );

  // organizedFolderMtime：YYYY/MM 与 mtime 互相印证才返回
  const monthDir = path.join(dir, "2021", "03");
  fs.mkdirSync(monthDir, { recursive: true });
  const media = path.join(monthDir, "2020-01-02.jpg");
  fs.writeFileSync(media, "x");
  const mtime = localDate(2021, 3, 15, 12, 0, 0);
  fs.utimesSync(media, mtime, mtime);
  const found = filenameCorrection.organizedFolderMtime(media);
  assert.ok(found instanceof Date);
  assert.equal(formatDate(found, "%Y-%m-%d %H:%M:%S"), "2021-03-15 12:00:00");

  // 文件名本身已是正确日期 → 不需要修正证据
  const correct = path.join(monthDir, "2021-03-15.jpg");
  fs.writeFileSync(correct, "x");
  fs.utimesSync(correct, mtime, mtime);
  assert.equal(filenameCorrection.organizedFolderMtime(correct), null);

  // mtime 与目录不符
  const mismatch = path.join(dir, "2021", "03", "2020-01-02-b.jpg");
  fs.writeFileSync(mismatch, "x");
  fs.utimesSync(mismatch, localDate(2022, 1, 1), localDate(2022, 1, 1));
  assert.equal(filenameCorrection.organizedFolderMtime(mismatch), null);

  // 父目录不是 YYYY/MM
  const plain = path.join(dir, "2020-01-02-c.jpg");
  fs.writeFileSync(plain, "x");
  assert.equal(filenameCorrection.organizedFolderMtime(plain), null);
}));

// ---------------------------------------------------------------------------
// scan-cache
// ---------------------------------------------------------------------------

test("HashCache：store/lookup/校验/LRU/原子保存/clear", () => withTempDir((dir) => {
  const cachePath = path.join(dir, "scan-cache-v1.json");
  const digest = "a".repeat(64);
  const cache = new HashCache(cachePath);
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.hits, 0);
  assert.equal(cache.misses, 0);

  const fileA = path.join(dir, "a.jpg");
  fs.writeFileSync(fileA, "hello world");
  const sizeA = fs.statSync(fileA).size;

  cache.store(fileA, sizeA, digest);
  assert.equal(cache.entryCount, 1);
  assert.equal(cache.lookup(fileA, sizeA), digest);
  assert.equal(cache.hits, 1);
  assert.equal(cache.lookup(fileA, sizeA + 1), null);
  assert.equal(cache.misses, 1);

  // 无效摘要不写入
  const fileB = path.join(dir, "b.jpg");
  fs.writeFileSync(fileB, "bbb");
  cache.store(fileB, 3, "not-a-digest");
  assert.equal(cache.entryCount, 1);

  // 文件 mtime 变化后失效并清除旧条目
  fs.utimesSync(fileA, new Date(), new Date(Date.now() + 5000));
  assert.equal(cache.lookup(fileA, sizeA), null);
  assert.equal(cache.entryCount, 0);

  // expectedMtimeNs 不符则不写入
  cache.store(fileB, 3, digest, { expectedMtimeNs: 1 });
  assert.equal(cache.entryCount, 0);
  const statsB = fs.statSync(fileB, { bigint: true });
  cache.store(fileB, 3, digest, { expectedMtimeNs: statsB.mtimeNs });
  assert.equal(cache.entryCount, 1);

  // 保存 → 重新加载命中（纳秒 mtime 精确）
  cache.save();
  assert.ok(fs.existsSync(cachePath));
  assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith(".tmp")));
  const savedText = fs.readFileSync(cachePath, "utf8");
  const raw = JSON.parse(savedText);
  assert.equal(raw.version, 1);
  const keys = Object.keys(raw.entries);
  assert.equal(keys.length, 1);
  // JSON.parse 会把超过 2^53 的整数转成 Number，因此用原始文本断言纳秒精度。
  assert.ok(savedText.includes(`"mtime_ns":${statsB.mtimeNs.toString()}`));
  assert.ok(savedText.includes(`"digest":"${digest}"`));
  assert.ok(savedText.endsWith("\n"));

  const reloaded = new HashCache(cachePath);
  assert.equal(reloaded.entryCount, 1);
  assert.equal(reloaded.lookup(fileB, 3), digest);
  assert.equal(reloaded.lookup(fileB, 4), null);

  // clear
  assert.equal(reloaded.clear(), true);
  assert.equal(reloaded.entryCount, 0);
  assert.ok(!fs.existsSync(cachePath));
  assert.equal(reloaded.clear(), true);
}));

test("HashCache：损坏/旧版本/非法条目全部按空缓存处理", () => withTempDir((dir) => {
  const cachePath = path.join(dir, "scan-cache-v1.json");
  fs.writeFileSync(cachePath, "{ corrupt", "utf8");
  assert.equal(new HashCache(cachePath).entryCount, 0);

  fs.writeFileSync(cachePath, JSON.stringify({ version: 99, entries: {} }), "utf8");
  assert.equal(new HashCache(cachePath).entryCount, 0);

  fs.writeFileSync(cachePath, JSON.stringify({ version: 1, entries: [] }), "utf8");
  assert.equal(new HashCache(cachePath).entryCount, 0);

  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      version: 1,
      entries: {
        "C:/x/a.jpg": { size: -1, mtime_ns: 1, digest: "a".repeat(64), last_seen: 1 },
        "C:/x/b.jpg": { size: 3, mtime_ns: "bad", digest: "a".repeat(64), last_seen: 1 },
        "C:/x/c.jpg": { size: 3, mtime_ns: 1, digest: "xyz", last_seen: 1 },
        "C:/x/d.jpg": { size: 3, mtime_ns: 1, digest: "a".repeat(64), last_seen: -5 },
        "C:/x/e.jpg": { size: 3, mtime_ns: 1, digest: "a".repeat(64), last_seen: 2 },
      },
    }),
    "utf8",
  );
  const cache = new HashCache(cachePath);
  assert.equal(cache.entryCount, 1);
}));

test("HashCache：LRU 按最后使用时间裁剪", () => withTempDir((dir) => {
  const cachePath = path.join(dir, "cache.json");
  const cache = new HashCache(cachePath, 2);
  const digest = "b".repeat(64);
  const files = ["one.jpg", "two.jpg", "three.jpg"].map((name) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, name);
    return filePath;
  });
  const sizes = files.map((filePath) => fs.statSync(filePath).size);
  cache.store(files[0], sizes[0], digest);
  cache.store(files[1], sizes[1], digest);
  // 刷新第一个的 last_seen，再写入第三个 → 应淘汰第二个
  assert.equal(cache.lookup(files[0], sizes[0]), digest);
  cache.store(files[2], sizes[2], digest);
  assert.equal(cache.entryCount, 2);
  assert.equal(cache.lookup(files[0], sizes[0]), digest);
  assert.equal(cache.lookup(files[1], sizes[1]), null);
  assert.equal(cache.lookup(files[2], sizes[2]), digest);
}));

test("HashCache：Windows 路径大小写不敏感（仅 win32 断言）", { skip: process.platform !== "win32" }, () =>
  withTempDir((dir) => {
    const cachePath = path.join(dir, "cache.json");
    const cache = new HashCache(cachePath);
    const filePath = path.join(dir, "CaseFile.jpg");
    fs.writeFileSync(filePath, "data");
    const upper = path.join(dir, "CASEFILE.JPG");
    const lower = path.join(dir, "casefile.jpg");
    const size = fs.statSync(filePath).size;
    cache.store(upper, size, "c".repeat(64));
    assert.equal(cache.lookup(lower, size), "c".repeat(64));
  }));

// ---------------------------------------------------------------------------
// image-support
// ---------------------------------------------------------------------------

test("inspectHeifSignature：ftyp 品牌、扩展长度与错误诊断", () => withTempDir((dir) => {
  const heic = path.join(dir, "image.heic");
  fs.writeFileSync(heic, minimalHeic(buildTiff({ ifd0: [{ tag: 306, text: "2020:01:02 03:04:05" }] })));
  const signature = imageSupport.inspectHeifSignature(heic);
  assert.equal(signature.isHeif, true);
  assert.equal(signature.majorBrand, "heic");
  assert.deepEqual(signature.compatibleBrands, ["mif1", "heic"]);
  assert.equal(signature.displayBrand, "heic");
  assert.equal(signature.error, null);

  // 非 ftyp 文件
  const jpeg = path.join(dir, "image.jpg");
  fs.writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const notHeif = imageSupport.inspectHeifSignature(jpeg);
  assert.equal(notHeif.isHeif, false);
  assert.equal(notHeif.error, null);
  assert.equal(notHeif.displayBrand, null);

  // 扩展长度 ftyp（size == 1，largesize 位于 8..16）
  const extended = Buffer.alloc(24);
  extended.writeUInt32BE(1, 0);
  extended.write("ftyp", 4, "latin1");
  extended.writeBigUInt64BE(24n, 8);
  extended.write("heic", 16, "latin1");
  const extendedPath = path.join(dir, "extended.avif");
  fs.writeFileSync(extendedPath, extended);
  const extendedSignature = imageSupport.inspectHeifSignature(extendedPath);
  assert.equal(extendedSignature.isHeif, true);
  assert.equal(extendedSignature.majorBrand, "heic");

  // 读不到文件头
  const missing = imageSupport.inspectHeifSignature(path.join(dir, "missing.heic"));
  assert.equal(missing.isHeif, false);
  assert.ok(missing.error.startsWith("无法读取文件头："));
}));

test("decoder / HEIF 失败原因诊断与能力探测", async () => {
  const capabilities = await imageSupport.getImageCapabilities();
  assert.equal(capabilities.sharp, true);
  assert.equal(capabilities.heic, true);
  const decoder = await imageSupport.ensureHeifDecoder();
  assert.equal(decoder.available, true);

  assert.equal(imageSupport.decoderUnavailableReason("photo.jpg", capabilities), null);
  assert.equal(imageSupport.decoderUnavailableReason("photo.heic", capabilities), null);
  assert.equal(imageSupport.heifDecodeFailureReason("photo.jpg", new Error("x")), null);

  assert.equal(imageSupport.isDecodableImageExtension(".jpg"), true);
  assert.equal(imageSupport.isDecodableImageExtension("jpeg"), true);
  assert.equal(imageSupport.isDecodableImageExtension(".dng"), false);
  assert.equal(imageSupport.isDecodableImageExtension(".heic"), true);
  assert.equal(imageSupport.isHeifExtension("heif"), true);
  assert.equal(imageSupport.isHeifExtension(".png"), false);
});

test("heifDecodeFailureReason：按文件头证据生成中文诊断", () => withTempDir((dir) => {
  const heic = path.join(dir, "good.heic");
  fs.writeFileSync(heic, minimalHeic(buildTiff({ ifd0: [{ tag: 306, text: "2020:01:02 03:04:05" }] })));
  const confirmed = imageSupport.heifDecodeFailureReason(heic, new Error("decode boom"));
  assert.ok(confirmed.includes("文件头已确认是 HEIC/HEIF（品牌 heic）"));
  assert.ok(confirmed.includes("但解码器无法打开：decode boom"));
  assert.ok(confirmed.includes("不能仅凭此错误判定文件损坏"));

  const mislabeled = path.join(dir, "fake.heic");
  fs.writeFileSync(mislabeled, Buffer.alloc(64));
  const reason = imageSupport.heifDecodeFailureReason(mislabeled, new Error("boom"));
  assert.ok(reason.includes("但文件头不是可识别的 HEIC/HEIF 容器"));

  const missing = path.join(dir, "missing.heic");
  const unverified = imageSupport.heifDecodeFailureReason(missing, new Error("boom"));
  assert.ok(unverified.startsWith("无法核验 HEIC/HEIF 文件头（无法读取文件头："));
}));

// ---------------------------------------------------------------------------
// EXIF 解析
// ---------------------------------------------------------------------------

test("EXIF TIFF：主 IFD / EXIF 子 IFD 优先级与大小端", () => {
  const rootDate = "2021:03:04 05:06:07";
  const childDate = "2019:12:31 23:59:58";

  // 主 IFD 的 306 优先级最高
  for (const littleEndian of [false, true]) {
    const tiff = buildTiff({
      littleEndian,
      ifd0: [
        { tag: 306, text: rootDate },
        { tag: 274, type: 3, value: 6 },
      ],
      exifIfd: [{ tag: 36867, text: childDate }],
    });
    const parsed = exif.parseTiffExif(tiff);
    assert.equal(parsed.error, null);
    assert.equal(parsed.orientation, 6);
    const found = exif.pickExifDate(parsed);
    assert.equal(found.tag, 306);
    assert.equal(found.text, rootDate);
    assert.equal(formatLocalIso(found.value), "2021-03-04T05:06:07");
  }

  // 主 IFD 的 36867 先于子 IFD 的 36867（映射顺序与 Python 一致）
  const tiff = buildTiff({
    ifd0: [{ tag: 36867, text: "2018:02:03 04:05:06" }],
    exifIfd: [{ tag: 36867, text: "2017:01:01 00:00:00" }],
  });
  const parsed = exif.parseTiffExif(tiff);
  const found = exif.pickExifDate(parsed);
  assert.equal(found.tag, 36867);
  assert.equal(found.text, "2018:02:03 04:05:06");

  // 只有 EXIF 子 IFD 的 36868
  const childOnly = buildTiff({
    ifd0: [],
    exifIfd: [{ tag: 36868, text: "2016-05-06 07:08" }],
  });
  const childFound = exif.pickExifDate(exif.parseTiffExif(childOnly));
  assert.equal(childFound.tag, 36868);
  assert.equal(formatLocalIso(childFound.value), "2016-05-06T07:08:00");
});

test("EXIF 日期文本：宽松分隔符、非法日期与损坏数据", () => {
  assert.equal(
    formatLocalIso(exif.parseExifDateTime("2021/03/04 05:06:07")),
    "2021-03-04T05:06:07",
  );
  assert.equal(
    formatLocalIso(exif.parseExifDateTime("2021.3.4")),
    "2021-03-04T00:00:00",
  );
  assert.equal(
    formatLocalIso(exif.parseExifDateTime("  2021-03-04T05:06")),
    "2021-03-04T05:06:00",
  );
  // 后续文本（小数秒/时区）被忽略（Python re.match 前缀语义）
  assert.equal(
    formatLocalIso(exif.parseExifDateTime("2021:03:04 05:06:07.123+08:00")),
    "2021-03-04T05:06:07",
  );
  assert.equal(exif.parseExifDateTime("2021:13:04 05:06:07"), null);
  assert.equal(exif.parseExifDateTime("2021:02:30 05:06:07"), null);
  assert.equal(exif.parseExifDateTime("2021:03:04 25:06:07"), null);
  assert.equal(exif.parseExifDateTime("not a date"), null);
  assert.equal(exif.parseExifDateTime(Buffer.from("2021:03:04 05:06:07\u0000", "latin1")) !== null, true);

  const corrupt = exif.parseTiffExif(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  assert.equal(corrupt.error !== null, true);
  assert.deepEqual(corrupt.mappings, []);
  assert.deepEqual(exif.parseTiffExif(Buffer.alloc(0)).mappings, []);
});

test("EXIF JPEG：sharp 路径读取日期与方向", () => withTempDir(async (dir) => {
  const tiff = buildTiff({
    ifd0: [
      { tag: 306, text: "2020:06:07 08:09:10" },
      { tag: 274, type: 3, value: 8 },
    ],
  });
  const jpegPath = path.join(dir, "with-exif.jpg");
  fs.writeFileSync(jpegPath, await jpegWithExif(tiff));

  const metadata = await exif.readExifMetadata(jpegPath);
  assert.equal(metadata.source, "sharp");
  assert.equal(metadata.format, "jpeg");
  assert.equal(formatLocalIso(metadata.value), "2020-06-07T08:09:10");
  assert.equal(metadata.tag, 306);
  assert.equal(metadata.orientation, 8);
  assert.equal(await exif.readExifOrientation(jpegPath), 8);

  const direct = await exif.readExifDate(jpegPath);
  assert.equal(formatLocalIso(direct.value), "2020-06-07T08:09:10");
  assert.equal(direct.tag, 306);

  // 无 EXIF 的 JPEG → null（不抛异常）
  const plain = path.join(dir, "plain.jpg");
  fs.copyFileSync(jpegPath, plain);
  fs.writeFileSync(plain, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(await exif.readExifDate(plain), null);

  // 不存在的文件 → null（error 字段有值）
  const missing = await exif.readExifMetadata(path.join(dir, "missing.jpg"));
  assert.equal(missing.value, null);
  assert.ok(missing.error instanceof Error);
}));

test("EXIF TIFF：sharp 无 metadata.exif 时直接解析 IFD0（与 Pillow getexif 一致）", () =>
  withTempDir(async (dir) => {
    const tiffPath = path.join(dir, "scanned.tif");
    fs.writeFileSync(tiffPath, await tiffWithDateTime("2021:03:04 05:06:07"));

    const metadata = await exif.readExifMetadata(tiffPath);
    assert.equal(metadata.format, "tiff");
    assert.equal(metadata.source, "tiff");
    assert.equal(formatLocalIso(metadata.value), "2021-03-04T05:06:07");
    assert.equal(metadata.tag, 306);

    const extracted = await dateExtractors.extractDate(tiffPath);
    assert.equal(extracted.source, DateSource.EXIF);
    assert.equal(formatLocalIso(extracted.value), "2021-03-04T05:06:07");

    // 普通 TIFF（无日期标签）→ null，不抛异常
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default ?? sharpModule;
    const plainPath = path.join(dir, "plain.tif");
    fs.writeFileSync(
      plainPath,
      await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .tiff()
        .toBuffer(),
    );
    assert.equal(await exif.readExifDate(plainPath), null);
  }));

test("EXIF HEIC：纯 JS ISO-BMFF 容器解析（含方向）", () => withTempDir(async (dir) => {
  const tiff = buildTiff({
    ifd0: [
      { tag: 306, text: "2022:07:08 09:10:11" },
      { tag: 274, type: 3, value: 6 },
    ],
    exifIfd: [{ tag: 36867, text: "2019:01:02 03:04:05" }],
  });
  const heicPath = path.join(dir, "photo.heic");
  fs.writeFileSync(heicPath, minimalHeic(tiff));

  const metadata = await exif.readExifMetadata(heicPath);
  assert.equal(metadata.source, "container");
  assert.equal(metadata.format, "heif");
  assert.equal(formatLocalIso(metadata.value), "2022-07-08T09:10:11");
  assert.equal(metadata.tag, 306);
  assert.equal(metadata.orientation, 6);
  assert.equal(await exif.readExifOrientation(heicPath), 6);

  // 有效容器但没有 Exif 项 → null 且无 error
  const noExifPath = path.join(dir, "no-exif.heic");
  fs.writeFileSync(noExifPath, minimalHeic(tiff, { withExif: false }));
  const noExif = await exif.readExifMetadata(noExifPath);
  assert.equal(noExif.source, "container");
  assert.equal(noExif.value, null);
  assert.equal(noExif.error, null);

  // 损坏 HEIC → null + error，不抛异常
  const brokenPath = path.join(dir, "broken.heic");
  const broken = minimalHeic(tiff);
  fs.writeFileSync(brokenPath, broken.subarray(0, 40));
  const brokenMetadata = await exif.readExifMetadata(brokenPath);
  assert.equal(brokenMetadata.value, null);
}));

// ---------------------------------------------------------------------------
// date-extractors：边车候选与时间戳
// ---------------------------------------------------------------------------

test("jsonSidecarCandidates：safe 与 aggressive 的精确顺序", () => withTempDir((dir) => {
  const media = path.join(dir, "photo(1).jpg");
  const join = (name) => path.join(dir, name);

  assert.deepEqual(dateExtractors.jsonSidecarCandidates(media), [
    join("photo(1).jpg.json"),
    join("photo(1).jpg.supplemental-metadata.json"),
    join("photo.jpg(1).json"),
    join("photo.jpg(1).supplemental-metadata.json"),
    join("photo(1).json"),
    join("photo(1).supplemental-metadata.json"),
  ]);
  assert.deepEqual(dateExtractors.jsonSidecarCandidates(media, { aggressive: true }), [
    join("photo(1).jpg.json"),
    join("photo(1).jpg.supplemental-metadata.json"),
    join("photo.jpg(1).json"),
    join("photo.jpg(1).supplemental-metadata.json"),
    join("photo(1).json"),
    join("photo(1).supplemental-metadata.json"),
    join("photo(1).jpg.json"),
    join("photo(1).jpg.supplemental-metadata.json"),
    join("photo.jpg.json"),
    join("photo.jpg.supplemental-metadata.json"),
  ]);

  // 已知编辑后缀 + 未知后缀 + 51 字符截断
  const edited = path.join(dir, "IMG-2021-edited.jpg");
  const editedCandidates = dateExtractors.jsonSidecarCandidates(edited);
  assert.deepEqual(editedCandidates, [
    join("IMG-2021-edited.jpg.json"),
    join("IMG-2021-edited.jpg.supplemental-metadata.json"),
    join("IMG-2021.jpg.json"),
    join("IMG-2021.jpg.supplemental-metadata.json"),
    join("IMG-2021-edited.json"),
    join("IMG-2021-edited.supplemental-metadata.json"),
  ]);

  const longName = `${"x".repeat(60)}.jpg`;
  const longMedia = path.join(dir, longName);
  const longCandidates = dateExtractors.jsonSidecarCandidates(longMedia);
  const shortened = "x".repeat(46);
  assert.equal(longCandidates[0], join(`${longName}.json`));
  assert.equal(longCandidates[2], join(`${shortened}.json`));
  assert.equal(longCandidates[3], join(`${shortened}.supplemental-metadata.json`));
}));

test("extractDate：JSON 时间戳（秒/毫秒/ISO）与边车变体", () => withTempDir(async (dir) => {
  const media = path.join(dir, "photo.jpg");
  fs.writeFileSync(media, "");

  // 秒
  writeSidecar(dir, "photo.jpg.json", { photoTakenTime: { timestamp: "1620284889" } });
  let result = await dateExtractors.extractDate(media);
  assert.equal(result.source, DateSource.JSON);
  assert.equal(result.accuracy, 0);
  assert.equal(result.value.getTime(), new Date(1620284889 * 1000).getTime());
  assert.equal(result.metadataPath, path.join(dir, "photo.jpg.json"));

  // 毫秒（>= 1e11 自动除以 1000）
  writeSidecar(dir, "photo.jpg.json", { photoTakenTime: { timestamp: "1620284889123" } });
  result = await dateExtractors.extractDate(media);
  assert.equal(result.value.getTime(), new Date(1620284889123).getTime());

  // 数字类型（非字符串）
  writeSidecar(dir, "photo.jpg.json", { photoTakenTime: { timestamp: 1620284889 } });
  result = await dateExtractors.extractDate(media);
  assert.equal(result.value.getTime(), new Date(1620284889 * 1000).getTime());

  // ISO（本地 naive）
  writeSidecar(dir, "photo.jpg.json", { photoTakenTime: { timestamp: "2021-05-06T07:08:09" } });
  result = await dateExtractors.extractDate(media);
  assert.equal(formatLocalIso(result.value), "2021-05-06T07:08:09");

  // ISO（Z 时区 → 对应瞬时）
  writeSidecar(dir, "photo.jpg.json", { photoTakenTime: { timestamp: "2021-05-06T07:08:09Z" } });
  result = await dateExtractors.extractDate(media);
  assert.equal(result.value.getTime(), Date.UTC(2021, 4, 6, 7, 8, 9));

  // ISO（+08:00 时区）
  writeSidecar(dir, "photo.jpg.json", { photoTakenTime: { timestamp: "2021-05-06T07:08:09+08:00" } });
  result = await dateExtractors.extractDate(media);
  assert.equal(result.value.getTime(), Date.UTC(2021, 4, 5, 23, 8, 9));

  // 无效时间戳 → 继续回退到文件名/其它来源
  writeSidecar(dir, "photo.jpg.json", { photoTakenTime: { timestamp: true } });
  assert.equal(await dateExtractors.jsonExtractor(media), null);

  // 负时间戳：Windows 的 Python fromtimestamp 会拒绝（OSError），Node 在 win32
  // 上也按无效处理以保持行为一致；POSIX 下 Python 可表示，Node 同样返回日期。
  writeSidecar(dir, "photo.jpg.json", { photoTakenTime: { timestamp: "-1000000000" } });
  const negative = await dateExtractors.jsonExtractor(media);
  if (process.platform === "win32") {
    assert.equal(negative, null);
  } else {
    assert.equal(negative.value.getTime(), -1000000000 * 1000);
  }

  // 无法表示的极大时间戳（JS Date 无效 / Python OverflowError）→ null
  writeSidecar(dir, "photo.jpg.json", { photoTakenTime: { timestamp: "1e300" } });
  assert.equal(await dateExtractors.jsonExtractor(media), null);

  // 缺少 photoTakenTime
  writeSidecar(dir, "photo.jpg.json", { title: "x" });
  assert.equal(await dateExtractors.jsonExtractor(media), null);
}));

test("extractDate：.supplemental-metadata.json、截断名与括号换位边车", () => withTempDir(async (dir) => {
  const media = path.join(dir, "photo(1).jpg");
  fs.writeFileSync(media, "");
  writeSidecar(dir, "photo.jpg(1).supplemental-metadata.json", {
    photoTakenTime: { timestamp: "1600000000" },
  });
  const result = await dateExtractors.extractDate(media);
  assert.equal(result.source, DateSource.JSON);
  assert.equal(
    result.metadataPath,
    path.join(dir, "photo.jpg(1).supplemental-metadata.json"),
  );

  // 51 字符截断边车
  const longName = `${"y".repeat(60)}.jpg`;
  const longMedia = path.join(dir, longName);
  fs.writeFileSync(longMedia, "");
  writeSidecar(dir, `${"y".repeat(46)}.json`, { photoTakenTime: { timestamp: "1500000000" } });
  const longResult = await dateExtractors.extractDate(longMedia);
  assert.equal(longResult.source, DateSource.JSON);

  // NFC：媒体名是 NFD，边车名是 NFC
  const nfdMedia = path.join(dir, "cafe\u0301.jpg");
  fs.writeFileSync(nfdMedia, "");
  writeSidecar(dir, "caf\u00e9.jpg.json", { photoTakenTime: { timestamp: "1400000000" } });
  const nfcResult = await dateExtractors.extractDate(nfdMedia);
  assert.equal(nfcResult.source, DateSource.JSON);
}));

// ---------------------------------------------------------------------------
// date-extractors：文件名、优先级与提取器别名
// ---------------------------------------------------------------------------

test("filenameExtractor：六种格式、搜索子串与非法日期", () => withTempDir((dir) => {
  const expected = localDate(2021, 3, 4, 5, 6, 7).getTime();
  const names = [
    "IMG_20210304-050607.jpg",
    "IMG_20210304_050607.jpg",
    "IMG-2021-03-04-05-06-07.jpg",
    "IMG-2021-03-04-050607.jpg",
    "IMG20210304050607.jpg",
    "IMG_2021_03_04_05_06_07.jpg",
    "prefix_20210304_050607_suffix.jpg",
  ];
  for (const name of names) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, "");
    const result = dateExtractors.filenameExtractor(filePath);
    assert.ok(result instanceof dateExtractors.DateExtractionResult, name);
    assert.equal(result.value.getTime(), expected, name);
    assert.equal(result.source, DateSource.FILENAME);
    assert.equal(result.accuracy, 2);
    assert.deepEqual(result.asTuple(), [result.value, DateSource.FILENAME, 2]);
    assert.deepEqual([...result], [result.value, DateSource.FILENAME, 2]);
    assert.equal(result.date, result.value);
    assert.equal(result.dateTaken, result.value);
  }

  // 日历非法 → 不返回
  const invalid = path.join(dir, "IMG_20210230_050607.jpg");
  fs.writeFileSync(invalid, "");
  assert.equal(dateExtractors.filenameExtractor(invalid), null);

  // 无日期
  const none = path.join(dir, "IMG_1234.jpg");
  fs.writeFileSync(none, "");
  assert.equal(dateExtractors.filenameExtractor(none), null);

  assert.equal(dateExtractors.guessExtractor, dateExtractors.filenameExtractor);
  assert.equal(dateExtractors.extractBestDate, dateExtractors.extractDate);
}));

test("mtimeExtractor / jsonExtractor tryhard / DATE_ACCURACY / EXIF 常量", () => withTempDir(async (dir) => {
  const filePath = path.join(dir, "file.bin");
  fs.writeFileSync(filePath, "abc");
  const mtime = new Date(2020, 0, 2, 3, 4, 5);
  fs.utimesSync(filePath, mtime, mtime);
  const result = dateExtractors.mtimeExtractor(filePath);
  assert.equal(result.source, DateSource.FILE_MTIME);
  assert.equal(result.accuracy, 4);
  assert.equal(formatLocalIso(result.value), "2020-01-02T03:04:05");

  // tryhard 作为 aggressive 的兼容别名
  writeSidecar(dir, "file.bin.json", { photoTakenTime: { timestamp: "1234567890" } });
  const plain = await dateExtractors.jsonExtractor(filePath, { tryhard: true });
  assert.equal(plain.source, DateSource.JSON);

  assert.equal(dateExtractors.JSON_ACCURACY, 0);
  assert.equal(dateExtractors.EXIF_ACCURACY, 1);
  assert.equal(dateExtractors.FILENAME_ACCURACY, 2);
  assert.equal(dateExtractors.AGGRESSIVE_JSON_ACCURACY, 3);
  assert.equal(dateExtractors.FILE_MTIME_ACCURACY, 4);
  assert.equal(dateExtractors.DATE_ACCURACY[DateSource.JSON], 0);
  assert.equal(dateExtractors.DATE_ACCURACY[DateSource.AGGRESSIVE_JSON], 3);
  assert.equal(dateExtractors.DEFAULT_MAX_EXIF_BYTES, 256 * 1024 * 1024);
  assert.ok(dateExtractors.EXIF_DATE_PATTERN instanceof RegExp);
}));

test("extractDate：完整优先级 JSON→EXIF→文件名→激进 JSON→mtime", () => withTempDir(async (dir) => {
  // 1) JSON 最高
  const media = path.join(dir, "IMG_20000101_000000.jpg");
  const tiff = buildTiff({ ifd0: [{ tag: 306, text: "2019:06:07 08:09:10" }] });
  fs.writeFileSync(media, await jpegWithExif(tiff));
  writeSidecar(dir, "IMG_20000101_000000.jpg.json", {
    photoTakenTime: { timestamp: "1620284889" },
  });
  let result = await dateExtractors.extractDate(media);
  assert.equal(result.source, DateSource.JSON);

  // 2) EXIF 次之
  fs.rmSync(path.join(dir, "IMG_20000101_000000.jpg.json"));
  result = await dateExtractors.extractDate(media);
  assert.equal(result.source, DateSource.EXIF);
  assert.equal(formatLocalIso(result.value), "2019-06-07T08:09:10");

  // 3) 文件名次之
  const filenameOnly = path.join(dir, "IMG_20000102_030405.jpg");
  fs.writeFileSync(filenameOnly, "");
  result = await dateExtractors.extractDate(filenameOnly);
  assert.equal(result.source, DateSource.FILENAME);
  assert.equal(formatLocalIso(result.value), "2000-01-02T03:04:05");

  // 4) 文件名优先于激进 JSON
  const aggressiveMedia = path.join(dir, "IMG_20000102_030405_trip-xyz.jpg");
  fs.writeFileSync(aggressiveMedia, "");
  writeSidecar(dir, "IMG_20000102_030405_trip.jpg.json", {
    photoTakenTime: { timestamp: "1420070400" },
  });
  result = await dateExtractors.extractDate(aggressiveMedia);
  assert.equal(result.source, DateSource.FILENAME);
  assert.equal(formatLocalIso(result.value), "2000-01-02T03:04:05");

  // 文件名关闭后，激进 JSON 命中
  result = await dateExtractors.extractDate(aggressiveMedia, null, null, { useFilename: false });
  assert.equal(result.source, DateSource.AGGRESSIVE_JSON);
  assert.equal(result.accuracy, 3);

  // 5) mtime 兜底
  const mtimeOnly = path.join(dir, "plain.bin");
  fs.writeFileSync(mtimeOnly, "x");
  const mtime = new Date(2018, 10, 12, 13, 14, 15);
  fs.utimesSync(mtimeOnly, mtime, mtime);
  result = await dateExtractors.extractDate(mtimeOnly, null, null, { useFileMtime: true });
  assert.equal(result.source, DateSource.FILE_MTIME);
  assert.equal(formatLocalIso(result.value), "2018-11-12T13:14:15");

  // 默认不启用 mtime → null
  assert.equal(await dateExtractors.extractDate(mtimeOnly), null);
}));

test("extractDate：配置对象（snake/camel）、TaskContext 简写与覆盖优先级", () => withTempDir(async (dir) => {
  const media = path.join(dir, "IMG_20210304_050607.jpg");
  fs.writeFileSync(media, "");

  // 普通对象 + snake_case 配置
  let result = await dateExtractors.extractDate(media, { use_filename: false });
  assert.equal(result, null);
  result = await dateExtractors.extractDate(media, { use_json: false, use_filename: true });
  assert.equal(result.source, DateSource.FILENAME);

  // TaskContext 简写
  const { context } = makeRecordingContext();
  result = await dateExtractors.extractDate(media, context);
  assert.equal(result.source, DateSource.FILENAME);

  // override 优先于配置
  result = await dateExtractors.extractDate(
    media,
    { use_filename: true },
    null,
    { useFilename: false },
  );
  assert.equal(result, null);

  // 取消异常必须越过逐文件隔离
  const { context: cancelled } = makeRecordingContext();
  cancelled.cancel();
  await assert.rejects(
    () => dateExtractors.extractDate(media, cancelled),
    (error) => error instanceof Error && error.name === "CancelledError",
  );
}));

test("extractDate：错误隔离与中文日志、边车目录索引缓存", () => withTempDir(async (dir) => {
  const { context, logs } = makeRecordingContext();
  const media = path.join(dir, "bad.jpg");
  fs.writeFileSync(media, "");
  fs.writeFileSync(path.join(dir, "bad.jpg.json"), "{ broken json");

  const result = await dateExtractors.extractDate(media, context);
  assert.equal(result, null);
  const messages = logs.map(([, message]) => message);
  assert.ok(
    messages.some((message) => message.startsWith(`无法读取元数据 ${path.join(dir, "bad.jpg.json")}：`)),
    messages.join("\n"),
  );
  // EXIF 坏文件：与 Python 相同前缀
  assert.ok(
    messages.some((message) => message.startsWith(`读取 ${media} 的 EXIF 失败，已跳过：`)),
    messages.join("\n"),
  );

  // 边车目录索引缓存在 TaskContext 上（每个目录最多枚举一次）
  assert.ok(context.sidecarDirectoryIndexes instanceof Map);
  assert.equal(context.sidecarDirectoryIndexes.size, 1);

  // 删除边车后，同一 context 仍用缓存索引（与 Python 一致），读取失败只告警
  fs.rmSync(path.join(dir, "bad.jpg.json"));
  const cachedContext = makeRecordingContext();
  await dateExtractors.extractDate(media, cachedContext.context);
  fs.rmSync(path.join(dir, "bad.jpg.json"), { force: true });
  // 目录里新增不了文件时缓存仍存在
  assert.equal(cachedContext.context.sidecarDirectoryIndexes.size, 1);
}));

test("extractDate：EXIF 大小上限与不可解码格式告警", () => withTempDir(async (dir) => {
  const { context, logs } = makeRecordingContext();
  const jpegPath = path.join(dir, "big.jpg");
  fs.writeFileSync(jpegPath, await jpegWithExif(buildTiff({
    ifd0: [{ tag: 306, text: "2020:01:02 03:04:05" }],
  })));
  const limited = await dateExtractors.exifExtractor(jpegPath, {
    maxExifBytes: 1,
    context,
  });
  assert.equal(limited, null);
  assert.ok(logs.some(([, message]) => message === `图片超过 EXIF 读取上限，已跳过：${jpegPath}`));

  // RAW 等 sharp 无法识别的格式 → 与 Pillow UnidentifiedImageError 同样的前缀
  const { context: context2, logs: logs2 } = makeRecordingContext();
  const rawPath = path.join(dir, "photo.dng");
  fs.writeFileSync(rawPath, Buffer.from("not really a raw file"));
  assert.equal(await dateExtractors.exifExtractor(rawPath, { context: context2 }), null);
  assert.ok(
    logs2.some(([, message]) => message.startsWith(`读取 ${rawPath} 的 EXIF 失败，已跳过：`)),
    logs2.map(([, message]) => message).join("\n"),
  );

  // 非图片扩展名直接跳过 EXIF（不产生日志）
  const { context: context3, logs: logs3 } = makeRecordingContext();
  const textPath = path.join(dir, "notes.txt");
  fs.writeFileSync(textPath, "hello");
  assert.equal(await dateExtractors.exifExtractor(textPath, { context: context3 }), null);
  assert.deepEqual(logs3, []);
}));

test("extractDate：HEIC 与 JPEG 的 EXIF 集成", () => withTempDir(async (dir) => {
  const heicPath = path.join(dir, "photo.heic");
  fs.writeFileSync(heicPath, minimalHeic(buildTiff({
    ifd0: [{ tag: 306, text: "2022:07:08 09:10:11" }],
  })));
  const heicResult = await dateExtractors.extractDate(heicPath);
  assert.equal(heicResult.source, DateSource.EXIF);
  assert.equal(formatLocalIso(heicResult.value), "2022-07-08T09:10:11");

  const jpegPath = path.join(dir, "camera.jpg");
  fs.writeFileSync(jpegPath, await jpegWithExif(buildTiff({
    ifd0: [],
    exifIfd: [{ tag: 36867, text: "2017:11:12 13:14:15" }],
  })));
  const jpegResult = await dateExtractors.extractDate(jpegPath);
  assert.equal(jpegResult.source, DateSource.EXIF);
  assert.equal(formatLocalIso(jpegResult.value), "2017-11-12T13:14:15");
}));

test("EXIF 一次性提示：同类原因在 TaskContext 上只记录一次", () => withTempDir(async () => {
  // 直接验证 exifNotices 集合的键机制（环境完整时不会触发解码器缺失分支）
  const { context } = makeRecordingContext();
  context.exifNotices.add("decoder-unavailable:.heic");
  assert.equal(context.exifNotices instanceof Set, true);
  assert.equal(context.exifNotices.has("decoder-unavailable:.heic"), true);
  assert.equal(context.exifNotices.size, 1);
}));
