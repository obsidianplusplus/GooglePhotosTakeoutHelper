/**
 * scan-live 层测试：文件操作原语、实况照片探测与 Takeout 扫描。
 *
 * 全部使用系统临时目录，不触碰仓库文件；合成 ISO-BMFF 动态片段用于验证
 * ftyp/hdlr/UUID/still-image-time 探测，不依赖真实媒体样本。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  atomicCopy,
  atomicCopyBundle,
  availableTarget,
  BundleTransactionError,
  conflictKey,
  createShortcut,
  isHidden,
  isMediaFile,
  isRelativeTo,
  OutputDirectoryLock,
  preloadWindowsHiddenAttributes,
  prepareFileTarget,
  renameFileNoReplace,
  renameFilesNoReplace,
  retireSourcesForMove,
  safeMove,
  setFileTime,
  sha256File,
} from "../src/file-utils.js";
import {
  availableLivePhotoTargets,
  discoverLivePhotoPairs,
  KNOWN_MOTION_EXTENSIONS,
  LIVE_PHOTO_STILL_EXTENSIONS,
  LivePhotoScanResult,
  preferredMotionSuffix,
  probeMotionFile,
  recordSourcePaths,
  recordTotalSize,
  verifyApplePairMetadata,
} from "../src/live-photos.js";
import {
  _recordsFromPaths,
  _scanAllMedia,
  discoverTakeout,
  isYearFolder,
  YEAR_FOLDER_RE,
  scanMediaFolder,
} from "../src/scanner.js";
import {
  CancelledError,
  ConflictMode,
  LivePhotoMetadataStatus,
  MediaRecord,
  OrganizeOptions,
  TaskContext,
} from "../src/models.js";

// ---------------------------------------------------------------------------
// 测试基础设施
// ---------------------------------------------------------------------------

function makeTempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gpth-scan-live-"));
  t.after(() => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows 上偶发的句柄延迟不应让测试失败。
    }
  });
  return directory;
}

function writeFile(filePath, content = "data") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function contextCancellingAfter(count) {
  const context = new TaskContext();
  let calls = 0;
  context.checkCancelled = () => {
    calls += 1;
    if (calls >= count) {
      throw new CancelledError("已取消");
    }
  };
  return context;
}

function recordingContext() {
  const logs = [];
  const progress = [];
  const context = new TaskContext({
    logCallback: (level, message) => logs.push([level, message]),
    progressCallback: (update) => progress.push(update),
  });
  return { context, logs, progress };
}

function listDirectory(directory) {
  return fs.readdirSync(directory).sort();
}

function findGpthTemporaryFiles(directory) {
  return fs
    .readdirSync(directory, { recursive: true })
    .map((name) => String(name))
    .filter((name) => name.includes(".gpth-"));
}

/** 临时替换 fs/promises 的方法（用于确定性模拟 EXDEV/回滚失败）。 */
async function withPatchedFsPromises(patches, run) {
  const originals = new Map();
  for (const [name, makeReplacement] of Object.entries(patches)) {
    originals.set(name, fsp[name]);
    fsp[name] = makeReplacement(originals.get(name));
  }
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) {
      fsp[name] = original;
    }
  }
}

function fsError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// 合成 ISO-BMFF 媒体
// ---------------------------------------------------------------------------

function makeBox(type, payload) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length, 0);
  return Buffer.concat([size, Buffer.from(type, "latin1"), payload]);
}

/**
 * 构造一个最小可探测动态片段：ftyp + hdlr(vide) + meta(Apple 键) + mdat。
 * @param {{brand?: string, uuid?: string|null, stillImageTime?: boolean, handler?: string,
 *          mdatBytes?: number}} [options]
 */
function makeMotionBuffer({
  brand = "qt  ",
  uuid = null,
  stillImageTime = true,
  handler = "vide",
  mdatBytes = 2048,
} = {}) {
  const ftyp = makeBox(
    "ftyp",
    Buffer.concat([
      Buffer.from(brand.padEnd(4, " "), "latin1"),
      Buffer.alloc(4),
      Buffer.from("qt  ", "latin1"),
    ]),
  );
  const hdlr = makeBox(
    "hdlr",
    Buffer.concat([
      Buffer.alloc(4),
      Buffer.alloc(4),
      Buffer.from(handler.padEnd(4, " "), "latin1"),
      Buffer.alloc(12),
    ]),
  );
  const metaParts = [];
  if (uuid !== null) {
    metaParts.push(Buffer.from("com.apple.quicktime.content.identifier", "latin1"));
    metaParts.push(Buffer.from(uuid, "latin1"));
  }
  if (stillImageTime) {
    metaParts.push(Buffer.from("com.apple.quicktime.still-image-time", "latin1"));
  }
  const meta = makeBox("meta", Buffer.concat(metaParts));
  const mdat = makeBox("mdat", Buffer.alloc(mdatBytes, 0x5a));
  return Buffer.concat([ftyp, hdlr, meta, mdat]);
}

/** 构造一个 HEIC 风格的静态图容器（ftyp + meta，meta 内含 UUID）。 */
function makeHeicBuffer(uuid) {
  const ftyp = makeBox(
    "ftyp",
    Buffer.concat([
      Buffer.from("heic", "latin1"),
      Buffer.alloc(4),
      Buffer.from("mif1", "latin1"),
    ]),
  );
  const meta = makeBox(
    "meta",
    Buffer.concat([
      Buffer.from("com.apple.quicktime.content.identifier", "latin1"),
      Buffer.from(uuid, "latin1"),
    ]),
  );
  return Buffer.concat([ftyp, meta, Buffer.alloc(4096, 0x11)]);
}

const LIVE_UUID = "12345678-90ab-cdef-1234-567890abcdef";
const OTHER_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ---------------------------------------------------------------------------
// file-utils：基础判断与哈希
// ---------------------------------------------------------------------------

test("isMediaFile 使用扩展名集合与 MIME 类型", () => {
  assert.equal(isMediaFile("photo.JPG"), true);
  assert.equal(isMediaFile("clip.mov"), true);
  assert.equal(isMediaFile("vector.svg"), true); // mimetypes: image/svg+xml
  assert.equal(isMediaFile("notes.txt"), false);
  assert.equal(isMediaFile("song.mp3"), false); // audio/* 不算媒体
  assert.equal(isMediaFile("no-extension"), false);
  assert.equal(isMediaFile("archive.tar.gz"), false);
});

test("isHidden 识别点号文件（Windows 隐藏属性为文档化差异）", () => {
  assert.equal(isHidden(path.join("dir", ".hidden.jpg")), true);
  assert.equal(isHidden(path.join("dir", "visible.jpg")), false);
});

test("Windows 隐藏属性通过一次批量枚举建立索引", (t) => {
  if (process.platform !== "win32") {
    t.skip("仅 Windows 有 FILE_ATTRIBUTE_HIDDEN");
    return;
  }
  const root = makeTempDir(t);
  const hiddenFile = path.join(root, "hidden-attr.jpg");
  fs.writeFileSync(hiddenFile, "x");
  const hiddenDirectory = path.join(root, "hidden-album");
  fs.mkdirSync(hiddenDirectory);
  const visible = path.join(root, "visible.jpg");
  fs.writeFileSync(visible, "y");
  execFileSync("cmd.exe", ["/c", "attrib", "+h", hiddenFile], { windowsHide: true });
  execFileSync("cmd.exe", ["/c", "attrib", "+h", hiddenDirectory], { windowsHide: true });

  assert.equal(preloadWindowsHiddenAttributes(root), true);
  assert.equal(isHidden(hiddenFile), true);
  assert.equal(isHidden(hiddenDirectory), true);
  assert.equal(isHidden(visible), false);
  // 已覆盖的根不会重复起进程
  assert.equal(preloadWindowsHiddenAttributes(path.join(root, "nested")), true);
});

test("isRelativeTo 解析真实路径且包含自身", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gpth-rel-"));
  try {
    const child = path.join(directory, "a", "b");
    fs.mkdirSync(child, { recursive: true });
    assert.equal(isRelativeTo(child, directory), true);
    assert.equal(isRelativeTo(directory, directory), true);
    assert.equal(isRelativeTo(directory, child), false);
    assert.equal(isRelativeTo(path.join(os.tmpdir(), "other-place"), directory), false);

    // Path.resolve(strict=False) 语义：不存在的尾部按字面拼接
    const missingParent = path.join(directory, "new", "out");
    assert.equal(isRelativeTo(path.join(missingParent, "x.jpg"), missingParent), true);
    assert.equal(isRelativeTo(path.join(directory, "new", "other.jpg"), missingParent), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("isRelativeTo 对存在的父级符号链接做真实路径解析", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gpth-rel-link-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const realParent = path.join(directory, "real");
  fs.mkdirSync(realParent);
  const linkPath = path.join(directory, "link");
  try {
    if (process.platform === "win32") {
      fs.symlinkSync(realParent, linkPath, "junction");
    } else {
      fs.symlinkSync(realParent, linkPath, "dir");
    }
  } catch {
    t.skip("当前环境不允许创建目录符号链接");
    return;
  }
  const missingUnderLink = path.join(linkPath, "future", "out");
  // 链接本身存在，尾部缺失部分按字面拼接 → 解析结果确实位于真实父目录之下。
  assert.equal(isRelativeTo(missingUnderLink, realParent), true);
  assert.equal(isRelativeTo(path.join(directory, "elsewhere.jpg"), realParent), false);
  assert.equal(isRelativeTo(path.join(linkPath, "future"), linkPath), true);
  const concrete = writeFile(path.join(linkPath, "future", "photo.jpg"), "x");
  assert.equal(isRelativeTo(concrete, realParent), true);
});

test("conflictKey 为绝对路径并在 win32/darwin 上小写", () => {
  const relative = path.join("some", "Dir", "File.JPG");
  const expected = path.resolve(relative);
  const key = conflictKey(relative);
  if (process.platform === "win32" || process.platform === "darwin") {
    assert.equal(key, expected.toLowerCase());
  } else {
    assert.equal(key, expected);
  }
});

test("sha256File 流式哈希且在块边界响应取消", async (t) => {
  const directory = makeTempDir(t);
  const filePath = writeFile(path.join(directory, "payload.bin"), "hello world");
  const expected = crypto.createHash("sha256").update("hello world").digest("hex");
  assert.equal(await sha256File(filePath, new TaskContext(), 3), expected);

  const cancelled = contextCancellingAfter(2);
  await assert.rejects(
    () => sha256File(filePath, cancelled, 2),
    (error) => error instanceof CancelledError,
  );
});

// ---------------------------------------------------------------------------
// file-utils：availableTarget
// ---------------------------------------------------------------------------

test("availableTarget 处理 rename/skip/overwrite 与已规划键", (t) => {
  const directory = makeTempDir(t);
  const existing = writeFile(path.join(directory, "IMG_1.jpg"), "original");

  // rename 模式：既有文件让位给 (1)
  const reserved = new Set();
  const normalized = new Set();
  const first = availableTarget(existing, ConflictMode.RENAME, reserved, normalized);
  assert.equal(first.target, path.join(directory, "IMG_1(1).jpg"));
  assert.equal(first.skipped, false);
  assert.equal(reserved.has(first.target), true);
  assert.equal(normalized.has(conflictKey(first.target)), true);

  // 连续规划不得复用同一目标
  const second = availableTarget(existing, ConflictMode.RENAME, reserved, normalized);
  assert.equal(second.target, path.join(directory, "IMG_1(2).jpg"));

  // skip 模式：直接跳过
  const skipped = availableTarget(existing, ConflictMode.SKIP, new Set(), new Set());
  assert.deepEqual(skipped, { target: existing, skipped: true });

  // overwrite 模式：只覆盖运行前已有文件
  const overwriteReserved = new Set();
  const overwriteNormalized = new Set();
  const overwritten = availableTarget(
    existing,
    ConflictMode.OVERWRITE,
    overwriteReserved,
    overwriteNormalized,
  );
  assert.deepEqual(overwritten, { target: existing, skipped: false });
  // 同一计划中再次出现同名时不可互相覆盖
  const replanned = availableTarget(
    existing,
    ConflictMode.OVERWRITE,
    overwriteReserved,
    overwriteNormalized,
  );
  assert.equal(replanned.target, path.join(directory, "IMG_1(1).jpg"));
});

test("availableTarget 未提供 normalizedReserved 时从 reserved 派生", (t) => {
  const directory = makeTempDir(t);
  const target = path.join(directory, "free.jpg");
  const reserved = new Set([target]);
  const result = availableTarget(target, ConflictMode.RENAME, reserved);
  assert.equal(result.skipped, false);
  assert.match(path.basename(result.target), /^free\(1\)\.jpg$/);
});

// ---------------------------------------------------------------------------
// file-utils：原子复制
// ---------------------------------------------------------------------------

test("atomicCopy 复制内容与元数据且不残留暂存文件", async (t) => {
  const directory = makeTempDir(t);
  const source = writeFile(path.join(directory, "source.bin"), Buffer.alloc(64 * 1024, 7));
  const target = path.join(directory, "target.bin");
  const stamp = new Date("2021-06-01T12:00:00Z");
  fs.utimesSync(source, stamp, stamp);
  const sourceStat = fs.statSync(source);

  await atomicCopy(source, target, new TaskContext(), 16 * 1024);
  assert.equal(fs.readFileSync(target).equals(fs.readFileSync(source)), true);
  const targetStat = fs.statSync(target);
  assert.ok(Math.abs(targetStat.mtimeMs - sourceStat.mtimeMs) < 2000);
  assert.deepEqual(findGpthTemporaryFiles(directory), []);
});

test("atomicCopy 默认不覆盖既有目标", async (t) => {
  const directory = makeTempDir(t);
  const source = writeFile(path.join(directory, "source.bin"), "new");
  const target = writeFile(path.join(directory, "target.bin"), "old");

  await assert.rejects(
    () => atomicCopy(source, target, new TaskContext(), 1024),
    (error) => error.code === "EEXIST" && error.message.includes("执行期间目标已被其它程序占用"),
  );
  assert.equal(fs.readFileSync(target, "utf8"), "old");
  assert.deepEqual(findGpthTemporaryFiles(directory), []);
});

test("atomicCopy 覆盖模式与目录目标拒绝", async (t) => {
  const directory = makeTempDir(t);
  const source = writeFile(path.join(directory, "source.bin"), "new");
  const target = writeFile(path.join(directory, "target.bin"), "old");

  await atomicCopy(source, target, new TaskContext(), 1024, { allowOverwrite: true });
  assert.equal(fs.readFileSync(target, "utf8"), "new");

  const directoryTarget = path.join(directory, "a-directory");
  fs.mkdirSync(directoryTarget);
  await assert.rejects(
    () => atomicCopy(source, directoryTarget, new TaskContext(), 1024, { allowOverwrite: true }),
    (error) => error.code === "EISDIR" && error.message.includes("目标位置是目录，无法覆盖"),
  );
});

test("atomicCopy 取消后不留下半成品", async (t) => {
  const directory = makeTempDir(t);
  const source = writeFile(path.join(directory, "source.bin"), Buffer.alloc(4096, 3));
  const target = path.join(directory, "target.bin");

  await assert.rejects(
    () => atomicCopy(source, target, contextCancellingAfter(3), 64),
    (error) => error instanceof CancelledError,
  );
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(findGpthTemporaryFiles(directory), []);
});

test("atomicCopyBundle 成组提交成功", async (t) => {
  const directory = makeTempDir(t);
  const first = writeFile(path.join(directory, "one.src"), "one");
  const second = writeFile(path.join(directory, "two.src"), "two");
  const targetOne = path.join(directory, "out", "one.bin");
  const targetTwo = path.join(directory, "out", "two.bin");

  await atomicCopyBundle(
    [
      [first, targetOne],
      [second, targetTwo],
    ],
    new TaskContext(),
    1024,
  );
  assert.equal(fs.readFileSync(targetOne, "utf8"), "one");
  assert.equal(fs.readFileSync(targetTwo, "utf8"), "two");
  assert.deepEqual(findGpthTemporaryFiles(directory), []);
});

test("atomicCopyBundle 目标重复时拒绝", async (t) => {
  const directory = makeTempDir(t);
  const first = writeFile(path.join(directory, "one.src"), "one");
  const second = writeFile(path.join(directory, "two.src"), "two");
  const target = path.join(directory, "same.bin");
  await assert.rejects(
    () =>
      atomicCopyBundle(
        [
          [first, target],
          [second, target],
        ],
        new TaskContext(),
        1024,
      ),
    (error) => error.message === "成组事务的目标路径必须彼此唯一",
  );
});

test("atomicCopyBundle 提交前发现占用时清理暂存并回滚", async (t) => {
  const directory = makeTempDir(t);
  const first = writeFile(path.join(directory, "one.src"), "one");
  const second = writeFile(path.join(directory, "two.src"), "two");
  const targetOne = path.join(directory, "out", "one.bin");
  const targetTwo = writeFile(path.join(directory, "out", "two.bin"), "occupied");

  await assert.rejects(
    () =>
      atomicCopyBundle(
        [
          [first, targetOne],
          [second, targetTwo],
        ],
        new TaskContext(),
        1024,
      ),
    (error) => error.code === "EEXIST",
  );
  assert.equal(fs.existsSync(targetOne), false);
  assert.equal(fs.readFileSync(targetTwo, "utf8"), "occupied");
  assert.deepEqual(findGpthTemporaryFiles(path.join(directory, "out")), []);
});

test("atomicCopyBundle 覆盖模式先备份旧目标并在成功后清理", async (t) => {
  const directory = makeTempDir(t);
  const first = writeFile(path.join(directory, "one.src"), "new-one");
  const second = writeFile(path.join(directory, "two.src"), "new-two");
  const targetOne = writeFile(path.join(directory, "out", "one.bin"), "old-one");
  const targetTwo = writeFile(path.join(directory, "out", "two.bin"), "old-two");

  await atomicCopyBundle(
    [
      [first, targetOne],
      [second, targetTwo],
    ],
    new TaskContext(),
    1024,
    { allowOverwrite: true },
  );
  assert.equal(fs.readFileSync(targetOne, "utf8"), "new-one");
  assert.equal(fs.readFileSync(targetTwo, "utf8"), "new-two");
  assert.deepEqual(findGpthTemporaryFiles(path.join(directory, "out")), []);
});

test("atomicCopyBundle 提交阶段失败时回滚已占有目标", async (t) => {
  const directory = makeTempDir(t);
  const first = writeFile(path.join(directory, "one.src"), "one");
  const second = writeFile(path.join(directory, "two.src"), "two");
  const targetOne = path.join(directory, "out", "one.bin");
  const targetTwo = path.join(directory, "out", "two.bin");
  fs.mkdirSync(path.join(directory, "out"), { recursive: true });

  await withPatchedFsPromises(
    {
      rename: (originalRename) => async (source, target, ...rest) => {
        if (target === targetTwo && String(source).includes(".gpth-part")) {
          throw fsError("EIO", "simulated commit failure");
        }
        return originalRename(source, target, ...rest);
      },
    },
    async () => {
      await assert.rejects(
        () =>
          atomicCopyBundle(
            [
              [first, targetOne],
              [second, targetTwo],
            ],
            new TaskContext(),
            1024,
          ),
        (error) => error.code === "EIO" && !(error instanceof BundleTransactionError),
      );
    },
  );
  assert.equal(fs.existsSync(targetOne), false);
  assert.equal(fs.existsSync(targetTwo), false);
  assert.deepEqual(findGpthTemporaryFiles(path.join(directory, "out")), []);
});

test("atomicCopyBundle 回滚也失败时抛出 BundleTransactionError 并列出路径", async (t) => {
  const directory = makeTempDir(t);
  const first = writeFile(path.join(directory, "one.src"), "one");
  const second = writeFile(path.join(directory, "two.src"), "two");
  const targetOne = path.join(directory, "out", "one.bin");
  const targetTwo = path.join(directory, "out", "two.bin");
  fs.mkdirSync(path.join(directory, "out"), { recursive: true });
  const { context, logs } = recordingContext();

  let failure;
  await withPatchedFsPromises(
    {
      rename: (originalRename) => async (source, target, ...rest) => {
        if (target === targetTwo && String(source).includes(".gpth-part")) {
          throw fsError("EIO", "simulated commit failure");
        }
        return originalRename(source, target, ...rest);
      },
      unlink: (originalUnlink) => async (target, ...rest) => {
        if (target === targetOne) {
          throw fsError("EACCES", "simulated rollback failure");
        }
        return originalUnlink(target, ...rest);
      },
    },
    async () => {
      try {
        await atomicCopyBundle(
          [
            [first, targetOne],
            [second, targetTwo],
          ],
          context,
          1024,
        );
        assert.fail("应当抛出 BundleTransactionError");
      } catch (error) {
        failure = error;
      }
    },
  );
  assert.ok(failure instanceof BundleTransactionError);
  assert.equal(failure.cause.code, "EIO");
  assert.equal(failure.recoveryErrors.length >= 1, true);
  assert.ok(failure.recoveryErrors[0].includes("回滚已提交目标失败"));
  assert.match(failure.message, /事务恢复未完全完成/);
  assert.equal(
    logs.some(([level, message]) => level === "ERROR" && message.includes("回滚已提交目标失败")),
    true,
  );
  // 回滚失败的目标仍存在，便于人工核验；测试结束前清理。
  fs.rmSync(path.join(directory, "out"), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// file-utils：改名与移动
// ---------------------------------------------------------------------------

test("renameFileNoReplace 拒绝覆盖与跨目录改名", async (t) => {
  const directory = makeTempDir(t);
  const source = writeFile(path.join(directory, "a.txt"), "a");
  const existing = writeFile(path.join(directory, "b.txt"), "b");

  await assert.rejects(
    () => renameFileNoReplace(source, existing, new TaskContext()),
    (error) => error.code === "EEXIST" && error.message.includes("执行期间目标已被其它程序占用"),
  );
  assert.equal(fs.readFileSync(source, "utf8"), "a");
  assert.equal(fs.readFileSync(existing, "utf8"), "b");

  fs.mkdirSync(path.join(directory, "other"));
  await assert.rejects(
    () => renameFileNoReplace(source, path.join(directory, "other", "c.txt"), new TaskContext()),
    (error) => error.message === "文件名修正只允许在原目录内进行",
  );

  await renameFileNoReplace(source, path.join(directory, "c.txt"), new TaskContext());
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(directory, "c.txt"), "utf8"), "a");
});

test("renameFilesNoReplace 中途失败时恢复已改名成员", async (t) => {
  const directory = makeTempDir(t);
  const first = writeFile(path.join(directory, "a.txt"), "a");
  const second = writeFile(path.join(directory, "b.txt"), "b");
  const occupied = writeFile(path.join(directory, "d.txt"), "d");

  await assert.rejects(
    () =>
      renameFilesNoReplace(
        [
          [first, path.join(directory, "c.txt")],
          [second, occupied],
        ],
        new TaskContext(),
      ),
    (error) => error.code === "EEXIST",
  );
  assert.equal(fs.existsSync(path.join(directory, "c.txt")), false);
  assert.equal(fs.readFileSync(first, "utf8"), "a");
  assert.equal(fs.readFileSync(second, "utf8"), "b");
  assert.equal(fs.readFileSync(occupied, "utf8"), "d");
});

test("retireSourcesForMove 成功退役源文件", async (t) => {
  const directory = makeTempDir(t);
  const first = writeFile(path.join(directory, "a.src"), "a");
  const second = writeFile(path.join(directory, "b.src"), "b");

  const outcomes = await retireSourcesForMove([first, second], new TaskContext());
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].moved, true);
  assert.equal(outcomes[1].moved, true);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
  assert.deepEqual(findGpthTemporaryFiles(directory), []);
});

test("retireSourcesForMove 源路径重复与取消语义", async (t) => {
  const directory = makeTempDir(t);
  const source = writeFile(path.join(directory, "a.src"), "a");
  await assert.rejects(
    () => retireSourcesForMove([source, source], new TaskContext()),
    (error) => error.message === "MOVE 成组事务的源路径必须彼此唯一",
  );

  // 第一次取消检查即抛错：改名阶段尚未开始，源文件必须原样保留。
  await assert.rejects(
    () => retireSourcesForMove([source], contextCancellingAfter(1)),
    (error) => error instanceof CancelledError,
  );
  assert.equal(fs.readFileSync(source, "utf8"), "a");
  assert.deepEqual(findGpthTemporaryFiles(directory), []);
});

test("safeMove 同卷直接改名并返回 false", async (t) => {
  const directory = makeTempDir(t);
  const source = writeFile(path.join(directory, "a.bin"), "move-me");
  const target = path.join(directory, "nested", "b.bin");
  const crossVolume = await safeMove(source, target, new TaskContext(), 1024);
  assert.equal(crossVolume, false);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(target, "utf8"), "move-me");
});

test("safeMove 在 EXDEV 时退化为复制后删除源文件", async (t) => {
  const directory = makeTempDir(t);
  const source = writeFile(path.join(directory, "a.bin"), "cross-volume");
  const target = path.join(directory, "b.bin");

  let fallbackUsed = false;
  await withPatchedFsPromises(
    {
      rename: (originalRename) => async (renameSource, renameTarget, ...rest) => {
        if (renameSource === source) {
          fallbackUsed = true;
          throw fsError("EXDEV", "simulated cross-device rename");
        }
        return originalRename(renameSource, renameTarget, ...rest);
      },
    },
    async () => {
      const crossVolume = await safeMove(source, target, new TaskContext(), 1024);
      assert.equal(crossVolume, true);
    },
  );
  assert.equal(fallbackUsed, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(target, "utf8"), "cross-volume");
  assert.deepEqual(findGpthTemporaryFiles(directory), []);
});

test("safeMove 默认不覆盖既有目标", async (t) => {
  const directory = makeTempDir(t);
  const source = writeFile(path.join(directory, "a.bin"), "new");
  const target = writeFile(path.join(directory, "b.bin"), "old");
  await assert.rejects(
    () => safeMove(source, target, new TaskContext(), 1024),
    (error) => error.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(source, "utf8"), "new");
  assert.equal(fs.readFileSync(target, "utf8"), "old");
});

test("prepareFileTarget 只删除文件/链接，从不递归删除目录", (t) => {
  const directory = makeTempDir(t);
  const filePath = writeFile(path.join(directory, "a.bin"), "x");
  prepareFileTarget(filePath);
  assert.equal(fs.existsSync(filePath), false);

  const directoryPath = path.join(directory, "dir");
  fs.mkdirSync(directoryPath);
  assert.throws(
    () => prepareFileTarget(directoryPath),
    (error) => error.code === "EISDIR" && error.message.includes("目标位置是目录，无法覆盖"),
  );
  assert.equal(fs.existsSync(directoryPath), true);
});

// ---------------------------------------------------------------------------
// file-utils：锁、快捷方式、时间
// ---------------------------------------------------------------------------

test("OutputDirectoryLock 取得/释放与并发拒绝", (t) => {
  const parent = makeTempDir(t);
  const outputDir = path.join(parent, "out");
  const lock = new OutputDirectoryLock(outputDir);
  assert.equal(lock.acquire(), lock);
  assert.equal(fs.existsSync(lock.path), true);
  const payload = JSON.parse(fs.readFileSync(lock.path, "utf8"));
  assert.equal(payload.token, lock.token);
  assert.equal(payload.pid, process.pid);

  const second = new OutputDirectoryLock(outputDir);
  assert.throws(
    () => second.acquire(),
    (error) =>
      error.message.includes("另一个整理任务正在使用输出目录") &&
      error.message.includes(lock.path),
  );

  lock.release();
  assert.equal(fs.existsSync(lock.path), false);
});

test("OutputDirectoryLock 清理已退出进程的残留锁", (t) => {
  const parent = makeTempDir(t);
  const outputDir = path.join(parent, "out");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, ".gpth-task.lock"),
    JSON.stringify({ pid: 99999999, token: "stale-token", started_at: "2000-01-01T00:00:00" }),
    "utf8",
  );
  const lock = new OutputDirectoryLock(outputDir);
  try {
    lock.acquire();
    assert.equal(fs.existsSync(lock.path), true);
    assert.equal(JSON.parse(fs.readFileSync(lock.path, "utf8")).token, lock.token);
  } finally {
    lock.release();
  }
});

test("OutputDirectoryLock 只删除 token 属于自己的锁文件", (t) => {
  const parent = makeTempDir(t);
  const outputDir = path.join(parent, "out");
  const lock = new OutputDirectoryLock(outputDir);
  lock.acquire();
  try {
    // 模拟另一个任务抢写锁文件：token 不同，release 必须保留文件。
    fs.writeFileSync(
      lock.path,
      JSON.stringify({ pid: process.pid, token: "another-task-token", started_at: "2024-01-01T00:00:00" }),
      "utf8",
    );
    lock.release();
    assert.equal(fs.existsSync(lock.path), true);
  } finally {
    fs.rmSync(lock.path, { force: true });
  }
});

test("createShortcut 在 Windows 创建 .lnk，在其它平台创建相对符号链接", async (t) => {
  const directory = makeTempDir(t);
  const target = writeFile(path.join(directory, "media", "photo.jpg"), "jpeg");
  const linkPath = path.join(directory, "album", "photo.jpg.lnk");
  await createShortcut(linkPath, target, new TaskContext());
  assert.equal(fs.existsSync(linkPath), true);
  if (process.platform !== "win32") {
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(linkPath), fs.realpathSync(target));
  } else {
    assert.ok(fs.statSync(linkPath).size > 0);
  }
});

test("setFileTime 设置本地时间并在 Windows 上钳制 1970 年前日期", (t) => {
  const directory = makeTempDir(t);
  const filePath = writeFile(path.join(directory, "photo.jpg"), "x");
  const value = new Date(2020, 4, 6, 7, 8, 9);
  const actual = setFileTime(filePath, value, new TaskContext());
  assert.equal(actual.getTime(), value.getTime());
  const stat = fs.statSync(filePath);
  assert.equal(Math.round(stat.mtimeMs / 1000), Math.round(value.getTime() / 1000));

  if (process.platform === "win32") {
    const { context, logs } = recordingContext();
    const ancient = new Date(1960, 0, 2, 3, 4, 5);
    const clamped = setFileTime(filePath, ancient, context);
    assert.equal(clamped.getTime(), new Date(1970, 0, 1).getTime());
    assert.equal(
      logs.some(
        ([level, message]) =>
          level === "WARNING" && message === "photo.jpg 的日期早于 1970，Windows 上已改为 1970-01-01",
      ),
      true,
    );
  }
});

// ---------------------------------------------------------------------------
// live-photos：探测与配对
// ---------------------------------------------------------------------------

test("probeMotionFile 识别 QuickTime/MP4 容器、视频轨与 Apple 元数据", (t) => {
  const directory = makeTempDir(t);
  const mov = writeFile(path.join(directory, "IMG_1.MOV"), makeMotionBuffer({ uuid: LIVE_UUID }));
  const probe = probeMotionFile(mov);
  assert.ok(probe);
  assert.equal(probe.majorBrand.toString("latin1"), "qt  ");
  assert.equal(probe.contentIdentifier, LIVE_UUID);
  assert.equal(probe.hasStillImageTime, true);
  assert.equal(probe.canonicalSuffix, ".mov");

  const mp4 = writeFile(
    path.join(directory, "VID_2.mp4"),
    makeMotionBuffer({ brand: "mp42", uuid: OTHER_UUID, stillImageTime: false }),
  );
  const mp4Probe = probeMotionFile(mp4);
  assert.ok(mp4Probe);
  assert.equal(mp4Probe.canonicalSuffix, ".mp4");
  assert.equal(mp4Probe.hasStillImageTime, false);

  // 没有 ftyp 的普通文件（JPEG）不是动态片段
  const still = writeFile(path.join(directory, "IMG_3.jpg"), "not-a-container");
  assert.equal(probeMotionFile(still), null);

  // 有 ftyp 但没有 vide handler（例如 M4A 音频）不是动态片段
  const audio = writeFile(
    path.join(directory, "audio.m4a"),
    makeMotionBuffer({ brand: "M4A ", handler: "soun" }),
  );
  assert.equal(probeMotionFile(audio), null);
});

test("discoverLivePhotoPairs 验证一一配对、证据文本与输出后缀", (t) => {
  const directory = makeTempDir(t);
  const still = writeFile(path.join(directory, "IMG_0001.HEIC"), makeHeicBuffer(LIVE_UUID));
  const motion = writeFile(
    path.join(directory, "IMG_0001.MOV"),
    makeMotionBuffer({ uuid: LIVE_UUID }),
  );
  const { context, logs } = recordingContext();
  const scan = discoverLivePhotoPairs([still, motion], context);
  assert.ok(scan instanceof LivePhotoScanResult);
  assert.equal(scan.matches.size, 1);
  const match = scan.matches.get(still);
  assert.ok(match);
  assert.equal(match.motion, motion);
  assert.equal(match.metadataStatus, LivePhotoMetadataStatus.VERIFIED);
  assert.equal(match.evidence, "同目录同名，Apple 内容标识与关键帧元数据已验证");
  assert.equal(match.outputMotionSuffix, ".MOV");
  assert.equal(match.repairedSuffix, false);
  assert.deepEqual([...scan.motionPaths], [motion]);
  assert.equal(scan.repairedMotionSuffixes.size, 0);
  // 成功配对不产生警告日志
  assert.equal(logs.filter(([level]) => level === "WARNING").length, 0);
});

test("discoverLivePhotoPairs 对 Apple 内容标识冲突拒绝配对", (t) => {
  const directory = makeTempDir(t);
  const still = writeFile(path.join(directory, "IMG_0002.JPG"), makeHeicBuffer(LIVE_UUID));
  const motion = writeFile(
    path.join(directory, "IMG_0002.MOV"),
    makeMotionBuffer({ uuid: OTHER_UUID }),
  );
  const { context, logs } = recordingContext();
  const scan = discoverLivePhotoPairs([still, motion], context);
  assert.equal(scan.matches.size, 0);
  assert.equal(scan.rejected, 1);
  assert.equal(scan.ambiguous, 0);
  assert.equal(
    logs.some(
      ([level, message]) =>
        level === "WARNING" &&
        message.includes("检测到 1 组 Apple 内容标识冲突，已拒绝自动配对并按独立媒体保留"),
    ),
    true,
  );
  assert.equal(
    logs.some(([, message]) => message.includes("IMG_0002.JPG + IMG_0002.MOV")),
    true,
  );
});

test("discoverLivePhotoPairs 统计多候选歧义", (t) => {
  const directory = makeTempDir(t);
  const stillA = writeFile(path.join(directory, "IMG_0003.HEIC"), makeHeicBuffer(LIVE_UUID));
  const stillB = writeFile(path.join(directory, "IMG_0003.JPG"), makeHeicBuffer(OTHER_UUID));
  const motion = writeFile(
    path.join(directory, "IMG_0003.MOV"),
    makeMotionBuffer({ uuid: LIVE_UUID }),
  );
  const { context, logs } = recordingContext();
  const scan = discoverLivePhotoPairs([stillA, stillB, motion], context);
  assert.equal(scan.matches.size, 0);
  assert.equal(scan.ambiguous, 1);
  assert.equal(scan.rejected, 0);
  const warning = logs.find(
    ([level, message]) =>
      level === "WARNING" && message.includes("检测到 1 组实况照片多候选歧义"),
  );
  assert.ok(warning);
  assert.match(warning[1], /静态候选 2 个/);
  assert.match(warning[1], /视频候选 1 个/);
});

test("discoverLivePhotoPairs 对无后缀/错误后缀视频补输出后缀", (t) => {
  const directory = makeTempDir(t);
  // 没有同名静态图也必须探测可疑后缀
  const withoutExtension = writeFile(
    path.join(directory, "VID_0004"),
    makeMotionBuffer({ uuid: LIVE_UUID }),
  );
  // .mp3 内容实际是 MOV 的视频
  const mislabelled = writeFile(
    path.join(directory, "VID_0005.mp3"),
    makeMotionBuffer({ uuid: OTHER_UUID }),
  );
  const { context, logs } = recordingContext();
  const scan = discoverLivePhotoPairs([withoutExtension, mislabelled], context);
  assert.equal(scan.matches.size, 0);
  assert.equal(scan.repairedMotionSuffixes.get(withoutExtension), ".mov");
  assert.equal(scan.repairedMotionSuffixes.get(mislabelled), ".mov");
  assert.equal(
    logs.some(
      ([level, message]) =>
        level === "INFO" &&
        message.includes("检测到 2 个内容为真实视频但扩展名缺失或错误的文件"),
    ),
    true,
  );
  const info = logs.find(([level]) => level === "INFO")[1];
  assert.match(info, /原扩展名 （无）/); // Python: path.suffix or '（无）'
});

test("verifyApplePairMetadata 返回全部四种状态", (t) => {
  const directory = makeTempDir(t);
  const stillWithUuid = writeFile(
    path.join(directory, "IMG_6.HEIC"),
    makeHeicBuffer(LIVE_UUID),
  );
  const stillWithoutUuid = writeFile(path.join(directory, "IMG_7.HEIC"), Buffer.from("no uuid here"));
  const motionNoId = probeMotionFile(
    writeFile(path.join(directory, "IMG_6-noid.MOV"), makeMotionBuffer({ uuid: null })),
  );
  const motionOther = probeMotionFile(
    writeFile(path.join(directory, "IMG_6-other.MOV"), makeMotionBuffer({ uuid: OTHER_UUID })),
  );
  const motionNoStillTime = probeMotionFile(
    writeFile(
      path.join(directory, "IMG_6-notime.MOV"),
      makeMotionBuffer({ uuid: LIVE_UUID, stillImageTime: false }),
    ),
  );
  const motionVerified = probeMotionFile(
    writeFile(path.join(directory, "IMG_6-ok.MOV"), makeMotionBuffer({ uuid: LIVE_UUID })),
  );

  assert.equal(verifyApplePairMetadata(stillWithUuid, motionNoId), LivePhotoMetadataStatus.MISSING);
  assert.equal(
    verifyApplePairMetadata(stillWithoutUuid, motionVerified),
    LivePhotoMetadataStatus.MISSING,
  );
  assert.equal(
    verifyApplePairMetadata(stillWithUuid, motionOther),
    LivePhotoMetadataStatus.CONFLICT,
  );
  assert.equal(
    verifyApplePairMetadata(stillWithUuid, motionNoStillTime),
    LivePhotoMetadataStatus.UNKNOWN,
  );
  assert.equal(
    verifyApplePairMetadata(stillWithUuid, motionVerified),
    LivePhotoMetadataStatus.VERIFIED,
  );
});

test("preferredMotionSuffix 只修复明显错误的后缀", (t) => {
  const directory = makeTempDir(t);
  const mov = writeFile(path.join(directory, "a.MOV"), makeMotionBuffer({ uuid: LIVE_UUID }));
  assert.equal(preferredMotionSuffix(mov), ".MOV");

  const noExtension = writeFile(path.join(directory, "b"), makeMotionBuffer({ uuid: LIVE_UUID }));
  assert.equal(preferredMotionSuffix(noExtension), ".mov");

  // .mp4 但容器是 QuickTime 时需要修复
  const qtAsMp4 = writeFile(
    path.join(directory, "c.mp4"),
    makeMotionBuffer({ brand: "qt  ", uuid: LIVE_UUID }),
  );
  assert.equal(preferredMotionSuffix(qtAsMp4), ".mov");

  // 真 MP4 保持原样
  const mp4 = writeFile(
    path.join(directory, "d.mp4"),
    makeMotionBuffer({ brand: "mp42", uuid: LIVE_UUID }),
  );
  assert.equal(preferredMotionSuffix(mp4), ".mp4");

  // 非容器文件退回原始后缀
  const jpeg = writeFile(path.join(directory, "e.JPG"), "jpeg-bytes");
  assert.equal(preferredMotionSuffix(jpeg), ".JPG");
});

test("availableLivePhotoTargets 成组冲突语义", (t) => {
  const directory = makeTempDir(t);
  const folder = path.join(directory, "out");
  const still = path.join(directory, "IMG_8.HEIC");
  const motion = path.join(directory, "IMG_8.MOV");

  // 无冲突：两半保持同名
  const reserved = new Set();
  const normalized = new Set();
  const free = availableLivePhotoTargets(
    still,
    motion,
    folder,
    ConflictMode.RENAME,
    reserved,
    normalized,
    { outputMotionSuffix: ".MOV" },
  );
  assert.deepEqual(free, {
    stillTarget: path.join(folder, "IMG_8.HEIC"),
    motionTarget: path.join(folder, "IMG_8.MOV"),
    skipped: false,
  });

  // 任一半被占用：两半共同追加编号
  writeFile(path.join(folder, "IMG_8.HEIC"), "occupied");
  const moved = availableLivePhotoTargets(
    still,
    motion,
    folder,
    ConflictMode.RENAME,
    new Set(),
    new Set(),
    { outputMotionSuffix: ".MOV" },
  );
  assert.deepEqual(moved, {
    stillTarget: path.join(folder, "IMG_8(1).HEIC"),
    motionTarget: path.join(folder, "IMG_8(1).MOV"),
    skipped: false,
  });

  // skip 模式：整组跳过
  const skipped = availableLivePhotoTargets(
    still,
    motion,
    folder,
    ConflictMode.SKIP,
    new Set(),
    new Set(),
    { outputMotionSuffix: ".MOV" },
  );
  assert.equal(skipped.skipped, true);

  // overwrite：只覆盖运行前已有文件；同计划第二次出现时改名
  const overwriteReserved = new Set();
  const overwriteNormalized = new Set();
  const first = availableLivePhotoTargets(
    still,
    motion,
    folder,
    ConflictMode.OVERWRITE,
    overwriteReserved,
    overwriteNormalized,
    { outputMotionSuffix: ".MOV" },
  );
  assert.equal(first.skipped, false);
  assert.equal(first.stillTarget, path.join(folder, "IMG_8.HEIC"));
  const second = availableLivePhotoTargets(
    still,
    motion,
    folder,
    ConflictMode.OVERWRITE,
    overwriteReserved,
    overwriteNormalized,
    { outputMotionSuffix: ".MOV" },
  );
  assert.deepEqual(second, {
    stillTarget: path.join(folder, "IMG_8(1).HEIC"),
    motionTarget: path.join(folder, "IMG_8(1).MOV"),
    skipped: false,
  });

  // outputStem 允许按日期修正后的基名成组输出
  const renamed = availableLivePhotoTargets(
    still,
    motion,
    folder,
    ConflictMode.RENAME,
    new Set(),
    new Set(),
    { outputMotionSuffix: ".mov", outputStem: "2020-01-02 11.22.33" },
  );
  assert.equal(renamed.stillTarget, path.join(folder, "2020-01-02 11.22.33.HEIC"));
  assert.equal(renamed.motionTarget, path.join(folder, "2020-01-02 11.22.33.mov"));
});

test("recordSourcePaths / recordTotalSize 包含实况动态半部", (t) => {
  const directory = makeTempDir(t);
  const still = writeFile(path.join(directory, "IMG_9.HEIC"), Buffer.alloc(10));
  const motion = writeFile(path.join(directory, "IMG_9.MOV"), Buffer.alloc(25));
  const record = new MediaRecord(new Map([[null, still]]), {
    livePhotoCompanions: new Map([[null, motion]]),
  });
  assert.deepEqual(recordSourcePaths(record), [still, motion]);
  assert.equal(recordTotalSize(record), 35);
  assert.deepEqual(recordSourcePaths(new MediaRecord(new Map([[null, still]]))), [still]);
});

test("实况扩展名常量与原版一致", () => {
  assert.deepEqual([...LIVE_PHOTO_STILL_EXTENSIONS].sort(), [".heic", ".heif", ".jpe", ".jpeg", ".jpg"]);
  assert.deepEqual([...KNOWN_MOTION_EXTENSIONS].sort(), [".m4v", ".mov", ".mp4"]);
});

// ---------------------------------------------------------------------------
// scanner
// ---------------------------------------------------------------------------

function organizeOptions(inputDir, outputDir, overrides = {}) {
  return new OrganizeOptions({ inputDir, outputDir, ...overrides });
}

test("isYearFolder 使用英文年份目录规则", () => {
  assert.equal(isYearFolder(path.join("root", "Photos from 2020")), true);
  assert.equal(isYearFolder(path.join("root", "Photos from 1800")), true);
  assert.equal(isYearFolder(path.join("root", "Photos from 2099")), true);
  assert.equal(isYearFolder(path.join("root", "Photos from 2100")), false);
  assert.equal(isYearFolder(path.join("root", "Photos from 202")), false);
  assert.equal(isYearFolder(path.join("root", "Photos from 2020 ")), false);
  assert.equal(YEAR_FOLDER_RE.test("Photos from 1999"), true);
});

test("discoverTakeout 识别年份目录与同级相册目录", async (t) => {
  const input = makeTempDir(t);
  const output = path.join(input, "..", "gpth-out-" + path.basename(input));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));

  const year2020 = writeFile(path.join(input, "Photos from 2020", "b.jpg"), "b");
  const year2021 = writeFile(path.join(input, "Photos from 2021", "a.jpg"), "a");
  const album = writeFile(path.join(input, "Album A", "x.jpg"), "x");
  const notYear = writeFile(path.join(input, "Random", "y.jpg"), "y");
  writeFile(path.join(input, "Random", "notes.txt"), "ignored");

  const { context, logs, progress } = recordingContext();
  const result = await discoverTakeout(organizeOptions(input, path.resolve(output)), context);

  assert.deepEqual(
    result.yearFolders.map((item) => path.basename(item)),
    ["Photos from 2020", "Photos from 2021"],
  );
  // 年份目录的同级非年份目录都视为相册目录（与 Python 一致，与目录名无关）。
  assert.deepEqual(
    result.albumFolders.map((item) => path.basename(item)),
    ["Album A", "Random"],
  );
  assert.equal(result.usedFallbackScan, false);
  assert.equal(result.media.length, 4);

  const timelineFiles = result.media
    .filter((record) => record.locations.has(null))
    .map((record) => record.firstFile)
    .sort();
  assert.deepEqual(timelineFiles, [year2021, year2020].sort());
  const albumRecord = result.media.find((record) => record.albums.includes("Album A"));
  assert.ok(albumRecord);
  assert.deepEqual(albumRecord.albums, ["Album A"]);
  assert.equal(albumRecord.firstFile, album);
  assert.equal(notYear === albumRecord.firstFile, false);
  const randomRecord = result.media.find((record) => record.albums.includes("Random"));
  assert.ok(randomRecord);
  assert.equal(randomRecord.firstFile, notYear);

  assert.equal(logs.length, 0);
  assert.equal(progress[0].phase, "scanning");
  assert.equal(progress[0].message, "正在分析目录结构…");
  assert.equal(
    progress.some((update) => update.message === "扫描：Photos from 2020"),
    true,
  );
});

test("discoverTakeout 默认过滤点号文件与目录", async (t) => {
  const input = makeTempDir(t);
  const output = path.join(input, "out");
  const visible = writeFile(path.join(input, "Photos from 2020", "visible.jpg"), "v");
  writeFile(path.join(input, "Photos from 2020", ".hidden.jpg"), "h");
  writeFile(path.join(input, "Photos from 2020", "sidecar.jpg.json"), "{}");
  writeFile(path.join(input, "Photos from 2020", "IMG_2-edited.jpg"), "e");
  writeFile(path.join(input, ".hidden-dir", "Photos from 2020", "inside.jpg"), "i");

  const hiddenResult = await discoverTakeout(
    organizeOptions(input, path.resolve(output)),
    new TaskContext(),
  );
  assert.equal(
    hiddenResult.yearFolders.some((item) => item.includes(".hidden-dir")),
    false,
  );
  const hiddenFiles = hiddenResult.media.map((record) => path.basename(record.firstFile)).sort();
  assert.deepEqual(hiddenFiles, ["IMG_2-edited.jpg", "visible.jpg"]);

  const includeResult = await discoverTakeout(
    organizeOptions(input, path.resolve(output), { includeHidden: true }),
    new TaskContext(),
  );
  const includeFiles = includeResult.media.map((record) => path.basename(record.firstFile)).sort();
  // 隐藏目录本身会作为相册目录出现，且其内部年份目录也会被发现。
  assert.deepEqual(includeFiles, [
    ".hidden.jpg",
    "IMG_2-edited.jpg",
    "inside.jpg",
    "visible.jpg",
  ]);
  // 隐藏目录里的年份目录也会被发现
  assert.equal(
    includeResult.yearFolders.some((item) => path.basename(item) === "Photos from 2020") &&
      includeResult.yearFolders.length === 2,
    true,
  );
  assert.equal(visible.length > 0, true);
});

test("discoverTakeout 跳过输入目录内的输出目录", async (t) => {
  const input = makeTempDir(t);
  const output = path.join(input, "out");
  writeFile(path.join(input, "Photos from 2022", "kept.jpg"), "k");
  writeFile(path.join(output, "Photos from 2022", "skipped.jpg"), "s");

  const result = await discoverTakeout(organizeOptions(input, output), new TaskContext());
  assert.deepEqual(
    result.yearFolders.map((item) => path.basename(item)),
    ["Photos from 2022"],
  );
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].firstFile, path.join(input, "Photos from 2022", "kept.jpg"));
});

test("discoverTakeout 无年份目录时回退全目录扫描", async (t) => {
  const input = makeTempDir(t);
  const output = path.join(input, "out");
  const nested = writeFile(path.join(input, "nested", "a.jpg"), "a");
  const rootFile = writeFile(path.join(input, "root.bmp"), "b");
  writeFile(path.join(output, "b.jpg"), "output-must-be-skipped");

  const { context, logs } = recordingContext();
  const result = await discoverTakeout(organizeOptions(input, output), context);
  assert.equal(result.usedFallbackScan, true);
  assert.deepEqual(
    result.media.map((record) => record.firstFile).sort(),
    [nested, rootFile].sort(),
  );
  assert.equal(
    logs.some(
      ([level, message]) => level === "WARNING" && message === "未识别到标准年份目录，已按设置回退为全目录媒体扫描",
    ),
    true,
  );
});

test("discoverTakeout 在 scanAllIfNoTakeout=false 时不回退", async (t) => {
  const input = makeTempDir(t);
  writeFile(path.join(input, "nested", "a.jpg"), "a");
  const result = await discoverTakeout(
    organizeOptions(input, path.join(input, "out"), { scanAllIfNoTakeout: false }),
    new TaskContext(),
  );
  assert.equal(result.usedFallbackScan, false);
  assert.equal(result.media.length, 0);
});

test("discoverTakeout 把确认的实况照片形成复合记录", async (t) => {
  const input = makeTempDir(t);
  const folder = path.join(input, "Photos from 2023");
  const still = writeFile(path.join(folder, "IMG_0001.HEIC"), makeHeicBuffer(LIVE_UUID));
  const motion = writeFile(path.join(folder, "IMG_0001.MOV"), makeMotionBuffer({ uuid: LIVE_UUID }));
  const plain = writeFile(path.join(folder, "IMG_0002.jpg"), "plain");

  const result = await discoverTakeout(
    organizeOptions(input, path.join(input, "out"), { recognizeLivePhotos: true }),
    new TaskContext(),
  );
  assert.equal(result.media.length, 2);
  assert.equal(result.livePhotoAmbiguous, 0);
  assert.equal(result.livePhotoRejected, 0);

  const composite = result.media.find((record) => record.isLivePhoto);
  assert.ok(composite);
  assert.equal(composite.firstFile, still);
  assert.equal(composite.companionFor(null), motion);
  assert.equal(composite.size, fs.statSync(still).size + fs.statSync(motion).size);
  assert.equal(composite.livePhotoMetadata.get(null), LivePhotoMetadataStatus.VERIFIED);
  assert.equal(composite.outputMotionSuffixFor(null), ".MOV");
  assert.equal(
    result.media.filter((record) => record.locations.has(motion)).length,
    0,
    "动态片段不应作为独立媒体出现",
  );
  assert.equal(
    result.media.some((record) => record.firstFile === plain),
    true,
  );
});

test("discoverTakeout 上报实况照片歧义与冲突数量", async (t) => {
  const input = makeTempDir(t);
  const folder = path.join(input, "Photos from 2024");
  // 歧义：两个静态候选
  writeFile(path.join(folder, "AMB.HEIC"), makeHeicBuffer(LIVE_UUID));
  writeFile(path.join(folder, "AMB.JPG"), makeHeicBuffer(OTHER_UUID));
  writeFile(path.join(folder, "AMB.MOV"), makeMotionBuffer({ uuid: LIVE_UUID }));
  // 冲突：内容标识不同
  writeFile(path.join(folder, "BAD.JPG"), makeHeicBuffer(LIVE_UUID));
  writeFile(path.join(folder, "BAD.MOV"), makeMotionBuffer({ uuid: OTHER_UUID }));

  const result = await discoverTakeout(
    organizeOptions(input, path.join(input, "out"), { recognizeLivePhotos: true }),
    new TaskContext(),
  );
  assert.equal(result.livePhotoAmbiguous, 1);
  assert.equal(result.livePhotoRejected, 1);
  assert.equal(result.media.length, 5); // 3 个歧义半部 + 2 个冲突半部，全部按独立媒体保留
});

test("discoverTakeout 保留无后缀真实视频作为独立媒体", async (t) => {
  const input = makeTempDir(t);
  const folder = path.join(input, "Photos from 2025");
  const noExtension = writeFile(path.join(folder, "VID_0001"), makeMotionBuffer({ uuid: LIVE_UUID }));
  const result = await discoverTakeout(
    organizeOptions(input, path.join(input, "out"), { recognizeLivePhotos: true }),
    new TaskContext(),
  );
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].firstFile, noExtension);
  assert.equal(result.media[0].outputSuffixFor(null), ".mov");
});

test("discoverTakeout 过滤 Windows hidden 属性文件与目录", async (t) => {
  if (process.platform !== "win32") {
    t.skip("仅 Windows 有 FILE_ATTRIBUTE_HIDDEN");
    return;
  }
  const input = makeTempDir(t);
  const folder = path.join(input, "Photos from 2023");
  fs.mkdirSync(folder, { recursive: true });
  const visible = path.join(folder, "visible.jpg");
  fs.writeFileSync(visible, "v");
  const hiddenFile = path.join(folder, "hidden-attr.jpg");
  fs.writeFileSync(hiddenFile, "h");
  execFileSync("cmd.exe", ["/c", "attrib", "+h", hiddenFile], { windowsHide: true });
  const hiddenAlbum = path.join(input, "HiddenAlbum");
  fs.mkdirSync(hiddenAlbum);
  fs.writeFileSync(path.join(hiddenAlbum, "album.jpg"), "a");
  execFileSync("cmd.exe", ["/c", "attrib", "+h", hiddenAlbum], { windowsHide: true });
  const hiddenParent = path.join(input, "HiddenParent");
  fs.mkdirSync(hiddenParent);
  execFileSync("cmd.exe", ["/c", "attrib", "+h", hiddenParent], { windowsHide: true });
  writeFile(path.join(hiddenParent, "Photos from 2024", "inside.jpg"), "i");

  const result = await discoverTakeout(
    organizeOptions(input, path.join(input, "out")),
    new TaskContext(),
  );
  assert.equal(result.yearFolders.length, 1);
  assert.deepEqual(result.albumFolders, []);
  assert.deepEqual(
    result.media.map((record) => path.basename(record.firstFile)).sort(),
    ["visible.jpg"],
  );

  const includeResult = await discoverTakeout(
    organizeOptions(input, path.join(input, "out"), { includeHidden: true }),
    new TaskContext(),
  );
  const includeNames = includeResult.media
    .map((record) => path.basename(record.firstFile))
    .sort();
  assert.deepEqual(includeNames, [
    "album.jpg",
    "hidden-attr.jpg",
    "inside.jpg",
    "visible.jpg",
  ]);
});

test("scanMediaFolder 过滤 Windows hidden 属性（日期修复模式）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("仅 Windows 有 FILE_ATTRIBUTE_HIDDEN");
    return;
  }
  const root = makeTempDir(t);
  const visible = path.join(root, "visible.jpg");
  fs.writeFileSync(visible, "v");
  const hiddenFile = path.join(root, "hidden-attr.jpg");
  fs.writeFileSync(hiddenFile, "h");
  execFileSync("cmd.exe", ["/c", "attrib", "+h", hiddenFile], { windowsHide: true });

  assert.deepEqual(await scanMediaFolder(root, true, false, new TaskContext()), [visible]);
  assert.deepEqual(
    (await scanMediaFolder(root, true, true, new TaskContext())).sort(),
    [visible, hiddenFile].sort(),
  );
});

test("scanMediaFolder 递归/非递归、隐藏过滤与排序", async (t) => {
  const root = makeTempDir(t);
  const top = writeFile(path.join(root, "B.jpg"), "b");
  const nested = writeFile(path.join(root, "nested", "a.png"), "a");
  writeFile(path.join(root, "nested", ".secret.jpg"), "s");
  writeFile(path.join(root, ".hidden-dir", "c.jpg"), "c");
  writeFile(path.join(root, "nested", "notes.txt"), "t");

  const recursive = await scanMediaFolder(root, true, false, new TaskContext());
  assert.deepEqual(recursive, [nested, top].sort());

  const topLevel = await scanMediaFolder(root, false, false, new TaskContext());
  assert.deepEqual(topLevel, [top]);

  const includeHidden = await scanMediaFolder(root, true, true, new TaskContext());
  assert.equal(includeHidden.includes(path.join(root, "nested", ".secret.jpg")), true);
  assert.equal(includeHidden.includes(path.join(root, ".hidden-dir", "c.jpg")), true);
  assert.equal(includeHidden.includes(top), true);
});

test("_recordsFromPaths 过滤非媒体并按字典序保留来源顺序", async (t) => {
  const directory = makeTempDir(t);
  const first = writeFile(path.join(directory, "A.jpg"), "a");
  const second = writeFile(path.join(directory, "b.jpg"), "b");
  writeFile(path.join(directory, "c.txt"), "c");
  const [records, ambiguous, rejected] = _recordsFromPaths(
    [first, second, path.join(directory, "c.txt")],
    "Album",
    organizeOptions(directory, path.join(directory, "out")),
    new TaskContext(),
  );
  assert.equal(ambiguous, 0);
  assert.equal(rejected, 0);
  assert.deepEqual(
    records.map((record) => record.firstFile),
    [first, second],
  );
  assert.equal(records[0].size, 1);
  assert.deepEqual(records[0].albums, ["Album"]);
});

test("discoverTakeout 不递归进入符号链接目录（os.walk followlinks=False）", async (t) => {
  const input = makeTempDir(t);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "gpth-link-target-"));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  writeFile(path.join(external, "Photos from 2020", "external.jpg"), "x");
  const linkPath = path.join(input, "linked");
  try {
    if (process.platform === "win32") {
      fs.symlinkSync(external, linkPath, "junction");
    } else {
      fs.symlinkSync(external, linkPath, "dir");
    }
  } catch {
    t.skip("当前环境不允许创建目录符号链接");
    return;
  }
  const real = writeFile(path.join(input, "real.jpg"), "r");
  const result = await discoverTakeout(
    organizeOptions(input, path.join(input, "out")),
    new TaskContext(),
  );
  assert.equal(result.usedFallbackScan, true);
  assert.deepEqual(
    result.media.map((record) => record.firstFile),
    [real],
  );
});

test("_scanAllMedia 把所有媒体视为时间线文件", async (t) => {
  const input = makeTempDir(t);
  const first = writeFile(path.join(input, "a.jpg"), "a");
  const nested = writeFile(path.join(input, "deep", "b.png"), "b");
  writeFile(path.join(input, "deep", "c.txt"), "c");
  const [records, ambiguous, rejected] = _scanAllMedia(
    organizeOptions(input, path.join(input, "out")),
    new TaskContext(),
  );
  assert.equal(ambiguous, 0);
  assert.equal(rejected, 0);
  assert.deepEqual(
    records.map((record) => record.firstFile).sort(),
    [first, nested].sort(),
  );
  assert.equal(records.every((record) => record.locations.has(null)), true);
});
