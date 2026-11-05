/**
 * 低层文件操作：媒体识别、哈希、安全复制和快捷方式（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * 与 Python 参考实现的行为差异（Node 平台限制，均是有意为之且可安全降级）：
 *
 * 1. Windows 隐藏属性：Node 的 fs.stat 不暴露 st_file_attributes。为保持与 Python
 *    一致的行为，扫描器在开始遍历前对每个扫描根调用一次
 *    preloadWindowsHiddenAttributes()：用单个 `cmd /c dir /s /b /a:h` 进程批量建立
 *    隐藏路径索引（绝不逐文件起进程），之后 isHidden() 以 O(1) 查询。
 *    枚举不可用（无 cmd、权限受限等）时静默退化为“只识别点号文件”；在写入控制台
 *    代码页不支持的平台上前者可能漏检少数非 ASCII 隐藏文件名，但点号规则与 Python
 *    完全一致。
 * 2. str.casefold()：JS 没有 casefold()，冲突键使用 toLowerCase()。ASCII 路径完全
 *    一致；ß、希腊字母等极少数非 ASCII 字符在大小写不敏感卷上的冲突键可能与 Python 不同。
 * 3. shutil.copystat：Node 无法无损复制全部元数据，这里只复制权限位与 atime/mtime；
 *    与 Python 一样，元数据复制失败不会让照片实体复制失败。
 * 4. os.utime(path, (stamp, stamp)) 使用秒级浮点时间戳，这里保持一致。
 */

import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { MEDIA_EXTENSIONS } from "./constants.js";
import { CancelledError, ConflictMode, ValidationError } from "./models.js";

const IS_WINDOWS = process.platform === "win32";
const IS_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

// Windows 控制台输出代码页 -> WHATWG TextDecoder 标签（用于解析 cmd 的 OEM 字节流）。
const WINDOWS_OEM_DECODERS = Object.freeze({
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1200: "utf-16le",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  65001: "utf-8",
  54936: "gb18030",
});

// Windows 隐藏属性批量索引（小写绝对路径）。
const windowsHiddenPaths = new Set();
const windowsHiddenRoots = new Set();
let windowsHiddenEnumerationUnavailable = false;


// Python mimetypes 的默认映射里会判定为 image/* 或 video/* 的扩展名。
// 部分扩展名已在 MEDIA_EXTENSIONS 中显式列出（constants.js 注释说明了原因），
// 这里保留它们是忠实移植：mimetypes 是扩展名集合之外的补充。
const IMAGE_VIDEO_MIME_TYPES = Object.freeze({
  ".avi": "video/x-msvideo",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/vnd.microsoft.icon",
  ".ief": "image/ief",
  ".jpe": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpg",
  ".m1v": "video/mpeg",
  ".mov": "video/quicktime",
  ".movie": "video/x-sgi-movie",
  ".mp4": "video/mp4",
  ".mpa": "video/mpeg",
  ".mpe": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".pbm": "image/x-portable-bitmap",
  ".pct": "image/pict",
  ".pgm": "image/x-portable-graymap",
  ".pic": "image/pict",
  ".pict": "image/pict",
  ".png": "image/png",
  ".pnm": "image/x-portable-anymap",
  ".ppm": "image/x-portable-pixmap",
  ".qt": "video/quicktime",
  ".ras": "image/x-cmu-raster",
  ".rgb": "image/x-rgb",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xbm": "image/x-xbitmap",
  ".xpm": "image/x-xpixmap",
  ".xwd": "image/x-xwindowdump",
});

// Python mimetypes 的复合后缀与压缩后缀处理（只影响 guess_type 的输入归一）。
const MIMETYPE_SUFFIX_MAP = Object.freeze({
  ".svgz": ".svg.gz",
  ".tgz": ".tar.gz",
  ".taz": ".tar.gz",
  ".tz": ".tar.gz",
  ".tbz2": ".tar.bz2",
  ".txz": ".tar.xz",
});
const MIMETYPE_ENCODING_MAP = Object.freeze({
  ".gz": "gzip",
  ".Z": "compress",
  ".bz2": "bzip2",
  ".xz": "xz",
  ".br": "br",
});

/** 成组事务失败，且至少一项回滚或清理操作也未完成。 */
export class BundleTransactionError extends Error {
  /**
   * @param {unknown} cause 触发失败的错误
   * @param {string[]} recoveryErrors 未能完成的恢复操作明细
   */
  constructor(cause, recoveryErrors) {
    const recovery = [...recoveryErrors];
    super(`${errorText(cause)}；事务恢复未完全完成：${recovery.join("；")}`);
    this.name = "BundleTransactionError";
    this.cause = cause;
    this.recoveryErrors = recovery;
  }
}

/** 移动源文件的最终状态；moved 为 null 表示无法确认完成。 */
export class MoveSourceOutcome {
  /**
   * @param {boolean|null} moved
   * @param {string} message
   */
  constructor(moved, message = "") {
    this.moved = moved;
    this.message = message;
  }
}

/** 阻止两个 GPTH 任务同时写入同一输出目录（对应 Python OutputDirectoryLock）。 */
export class OutputDirectoryLock {
  /** @param {string} outputDir */
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.path = path.join(outputDir, ".gpth-task.lock");
    this.token = crypto.randomBytes(16).toString("hex");
    this._acquired = false;
  }

  /**
   * 同步取得锁；失败时抛中文错误（与 Python __enter__ 相同）。
   * @returns {OutputDirectoryLock}
   */
  acquire() {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const payload = Buffer.from(
      JSON.stringify({
        pid: process.pid,
        token: this.token,
        started_at: localIsoWithMicroseconds(new Date()),
      }),
      "utf8",
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let descriptor;
      try {
        descriptor = fs.openSync(this.path, "wx");
      } catch (error) {
        if (error && error.code === "EEXIST") {
          if (this._removeStaleLock()) {
            continue;
          }
          throw new Error(
            `另一个整理任务正在使用输出目录：${this.outputDir}\n锁文件：${this.path}`,
          );
        }
        throw error;
      }
      try {
        fs.writeSync(descriptor, payload);
        fs.fsyncSync(descriptor);
      } catch (error) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // 关闭失败的原始错误优先抛出。
        }
        try {
          fs.unlinkSync(this.path);
        } catch {
          // missing_ok=True 语义。
        }
        throw error;
      }
      fs.closeSync(descriptor);
      this._acquired = true;
      return this;
    }
    throw new Error(`无法取得输出目录任务锁：${this.path}`);
  }

  /** 只删除 token 属于自己的锁。 */
  release() {
    if (!this._acquired) {
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.path, "utf8"));
      if (data && data.token === this.token) {
        try {
          fs.unlinkSync(this.path);
        } catch (error) {
          if (!error || error.code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch {
      // 只删除仍属于自己的锁；无法确认时保留，避免误解锁其它任务。
    } finally {
      this._acquired = false;
    }
  }

  /** 锁所属进程已退出时清理残留；无法判断时按仍在运行处理。 */
  _removeStaleLock() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.path, "utf8"));
    } catch {
      return false;
    }
    const pid = toIntegerOrZero(data && data.pid);
    if (pid > 0 && processIsAlive(pid)) {
      return false;
    }
    try {
      fs.unlinkSync(this.path);
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return true;
      }
      return false;
    }
  }
}

/** 只查询进程是否存在，不向进程发送终止信号。 */
function processIsAlive(pid) {
  if (pid === process.pid) {
    return true;
  }
  // Node 在所有平台都支持 signal 0：进程存在时返回，不存在时抛 ESRCH；
  // 权限不足时抛 EPERM，同样说明 PID 存在（对应 Python 的 GetLastError()==5）。
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

/** 依据扩展名和 MIME 判断照片或视频，不读取整个文件。 */
export function isMediaFile(filePath) {
  const suffix = pathSuffix(filePath).toLowerCase();
  if (MEDIA_EXTENSIONS.has(suffix)) {
    return true;
  }
  const mime = guessMimeType(path.basename(filePath));
  return Boolean(mime && (mime.startsWith("image/") || mime.startsWith("video/")));
}

/**
 * Python pathlib.Path.suffix 的等价物（供内部模块复用）。
 * 与 node:path.extname 的差异：文件名以点结尾时 Python 返回空后缀。
 */
export function _pathSuffix(filePath) {
  return pathSuffix(filePath);
}

/** Python pathlib.Path.stem 的等价物。 */
export function _pathStem(filePath) {
  const name = path.basename(filePath);
  const suffix = pathSuffix(filePath);
  return suffix ? name.slice(0, name.length - suffix.length) : name;
}

/**
 * 同时识别点号文件和 Windows hidden 属性。
 *
 * Windows 上 st_file_attributes 不可直接读取，扫描器会先调用
 * preloadWindowsHiddenAttributes() 建立批量索引；未预载时这里只识别点号文件。
 */
export function isHidden(filePath) {
  if (path.basename(filePath).startsWith(".")) {
    return true;
  }
  if (IS_WINDOWS && windowsHiddenPaths.size > 0) {
    return windowsHiddenPaths.has(path.resolve(filePath).toLowerCase());
  }
  return false;
}

/**
 * Windows 专用：一次枚举扫描根下的所有隐藏文件/目录并缓存绝对路径。
 *
 * 进程开销固定为每个扫描根 1 次（cmd + dir，均为原生程序），绝不逐文件起进程；
 * 非 Windows、已覆盖的根或枚举不可用时返回 false，调用方继续使用点号规则。
 * 必须在遍历/过滤任何候选路径之前调用。
 */
export function preloadWindowsHiddenAttributes(rootDir) {
  if (!IS_WINDOWS || windowsHiddenEnumerationUnavailable) {
    return false;
  }
  let absoluteRoot;
  try {
    absoluteRoot = path.resolve(rootDir);
  } catch {
    return false;
  }
  for (const indexedRoot of windowsHiddenRoots) {
    if (isPathInside(absoluteRoot, indexedRoot)) {
      return true;
    }
  }
  let entries;
  try {
    entries = enumerateWindowsHiddenEntries(absoluteRoot);
  } catch {
    windowsHiddenEnumerationUnavailable = true;
    return false;
  }
  if (entries === null) {
    windowsHiddenEnumerationUnavailable = true;
    return false;
  }
  for (const entry of entries) {
    windowsHiddenPaths.add(entry);
  }
  windowsHiddenRoots.add(absoluteRoot);
  return true;
}

/**
 * 用单个 cmd 进程枚举隐藏条目。返回小写绝对路径数组；
 * cmd 不可用时返回 null（调用方退化为点号规则）。
 */
function enumerateWindowsHiddenEntries(absoluteRoot) {
  let codePage = 0;
  try {
    const chcp = execFileSync("cmd.exe", ["/d", "/s", "/c", "chcp"], {
      encoding: "latin1",
      windowsHide: true,
      timeout: 10_000,
      // execFileSync 默认会把子进程 stderr 转发到父进程；显式捕获，避免
      // `dir /a:h` 在“没有隐藏条目”（退出码 1）时污染 CLI/服务端日志。
      stdio: ["ignore", "pipe", "pipe"],
    });
    const match = /(\d{2,6})/.exec(chcp);
    if (match) {
      codePage = Number(match[1]);
    }
  } catch {
    // 取不到代码页时按 ASCII/UTF-8 处理；纯 ASCII 路径不受影响。
  }
  let raw;
  try {
    raw = execFileSync(
      "cmd.exe",
      ["/d", "/s", "/c", 'dir /s /b /a:h "%GPTH_HIDDEN_ROOT%"'],
      {
        env: { ...process.env, GPTH_HIDDEN_ROOT: absoluteRoot },
        windowsHide: true,
        windowsVerbatimArguments: true,
        timeout: 120_000,
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    // dir 在“没有匹配的隐藏条目”时以退出码 1 结束；其 stdout 为空，按空结果处理。
    if (error && Buffer.isBuffer(error.stdout)) {
      raw = error.stdout;
    } else if (error && typeof error.stdout === "string") {
      raw = Buffer.from(error.stdout, "latin1");
    } else {
      return [];
    }
  }
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    return [];
  }
  const decoderLabel = WINDOWS_OEM_DECODERS[codePage];
  let text = null;
  if (decoderLabel) {
    try {
      text = new TextDecoder(decoderLabel).decode(raw);
    } catch {
      text = null;
    }
  }
  if (text === null) {
    text = raw.toString("utf8");
  }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(path.resolve(trimmed).toLowerCase());
    } catch {
      // 无法解析的路径行直接忽略。
    }
  }
  return entries;
}

/** candidate 是否等于 parent 或位于其下（Windows 大小写不敏感）。 */
function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  if (relative === "") {
    return true;
  }
  return !(
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  );
}

/** 兼容大小写文件系统的路径包含判断（对应 Path.resolve().relative_to()）。 */
export function isRelativeTo(filePath, parentPath) {
  const target = resolveRealPath(filePath);
  const parent = resolveRealPath(parentPath);
  if (target === null || parent === null) {
    return false;
  }
  try {
    const relative = path.relative(parent, target);
    if (relative === "") {
      return true;
    }
    return !(
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    );
  } catch {
    return false;
  }
}

/** 以固定内存流式计算 SHA-256，并在块边界响应取消。 */
export async function sha256File(filePath, context, chunkSize) {
  const digest = crypto.createHash("sha256");
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(normaliseChunkSize(chunkSize));
    for (;;) {
      checkCancelled(context);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

/** Windows/macOS 常见大小写不敏感卷上的冲突键。 */
export function conflictKey(filePath) {
  const absolute = path.resolve(filePath);
  return IS_CASE_INSENSITIVE ? absolute.toLowerCase() : absolute;
}

/**
 * 解析冲突目标；返回最终路径及是否因 skip 被跳过。
 *
 * overwrite 只覆盖运行前已有文件；同一计划中的两个文件绝不能互相覆盖。
 */
export function availableTarget(targetPath, mode, reserved, normalizedReserved = null) {
  const normalized = conflictKey(targetPath);
  const reservedKeys =
    normalizedReserved !== null
      ? normalizedReserved
      : new Set([...reserved].map((item) => conflictKey(item)));
  const planned = reservedKeys.has(normalized);
  const occupied = pathExists(targetPath) || planned;
  if (!occupied || (mode === ConflictMode.OVERWRITE && !planned)) {
    reserved.add(targetPath);
    if (normalizedReserved !== null) {
      normalizedReserved.add(normalized);
    }
    return { target: targetPath, skipped: false };
  }
  if (mode === ConflictMode.SKIP) {
    return { target: targetPath, skipped: true };
  }

  const { stem, suffix } = splitStemSuffix(targetPath);
  let number = 1;
  for (;;) {
    const candidate = path.join(path.dirname(targetPath), `${stem}(${number})${suffix}`);
    const normalizedCandidate = conflictKey(candidate);
    if (!pathExists(candidate) && !reservedKeys.has(normalizedCandidate)) {
      reserved.add(candidate);
      if (normalizedReserved !== null) {
        normalizedReserved.add(normalizedCandidate);
      }
      return { target: candidate, skipped: false };
    }
    number += 1;
  }
}

/** 先复制到同目录临时文件，完成后原子替换，取消时不留下半文件。 */
export async function atomicCopy(
  source,
  target,
  context,
  chunkSize,
  { allowOverwrite = false } = {},
) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const part = partPath(target);
  try {
    await streamCopyFile(source, part, context, chunkSize);
    await copyStatBestEffort(source, part);
    checkCancelled(context);
    if (allowOverwrite) {
      if (pathExists(target) && isDirectory(target) && !isSymlink(target)) {
        throw isADirectoryError(`目标位置是目录，无法覆盖：${target}`);
      }
    } else if (pathExists(target) || isSymlink(target)) {
      throw fileExistsError(`执行期间目标已被其它程序占用：${target}`);
    }
    await fsp.rename(part, target);
  } finally {
    if (pathExists(part)) {
      try {
        fs.unlinkSync(part);
      } catch {
        // 清理失败不应掩盖原始错误。
      }
    }
  }
}

/**
 * 先完整暂存一组文件，再以无替换占位共同提交。
 *
 * 覆盖模式会先把已有目标改名为同目录备份。提交或取消失败时会尽力删除本次输出
 * 并恢复旧目标；若文件系统同时拒绝回滚，BundleTransactionError 会列出未恢复的
 * 精确路径，不会假称已完全回滚。
 */
export async function atomicCopyBundle(
  pairs,
  context,
  chunkSize,
  { allowOverwrite = false } = {},
) {
  const targetKeys = pairs.map((pair) => conflictKey(pair[1]));
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new ValidationError("成组事务的目标路径必须彼此唯一");
  }

  /** @type {Array<[string, string]>} */
  const staged = [];
  /** @type {Array<[string, string]>} */
  const backups = [];
  /** @type {Array<[string, PathIdentity]>} */
  const claimed = [];
  try {
    for (const [source, target] of pairs) {
      checkCancelled(context);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const part = partPath(target);
      staged.push([part, target]);
      await streamCopyFile(source, part, context, chunkSize);
      await copyStatBestEffort(source, part);
    }

    checkCancelled(context);
    for (const [, target] of staged) {
      const occupied = pathExists(target) || isSymlink(target);
      if (occupied && isDirectory(target) && !isSymlink(target)) {
        throw isADirectoryError(`目标位置是目录，无法覆盖：${target}`);
      }
      if (occupied && !allowOverwrite) {
        throw fileExistsError(`执行期间目标已被其它程序占用：${target}`);
      }
    }

    if (allowOverwrite) {
      for (const [, target] of staged) {
        checkCancelled(context);
        if (!(pathExists(target) || isSymlink(target))) {
          continue;
        }
        if (isDirectory(target) && !isSymlink(target)) {
          throw isADirectoryError(`目标位置是目录，无法覆盖：${target}`);
        }
        const backup = path.join(
          path.dirname(target),
          `.${path.basename(target)}.${uuidHex()}.gpth-backup`,
        );
        await fsp.rename(target, backup);
        backups.push([backup, target]);
        checkCancelled(context);
      }
    }

    for (const [part, target] of staged) {
      checkCancelled(context);
      const identity = await claimTargetNoReplace(part, target);
      claimed.push([target, identity]);
      checkCancelled(context);
      // hardlink 已经是完整目标；这次 replace 只会消耗本事务自己的同 inode
      // 暂存名。占位回退路径则在这里用完整文件替换本事务的空占位，不会覆盖
      // 外部新占用。
      if (!sameIdentity(await pathIdentity(target), identity)) {
        throw fileExistsError(`目标在提交期间已被外部替换：${target}`);
      }
      await fsp.rename(part, target);
      claimed[claimed.length - 1] = [target, await pathIdentity(target)];
      checkCancelled(context);
    }
  } catch (error) {
    const recoveryErrors = await rollbackCopyBundle(claimed, backups, context);
    recoveryErrors.push(...(await cleanupStagedFiles(staged, context, "ERROR")));
    staged.length = 0;
    if (recoveryErrors.length > 0) {
      throw new BundleTransactionError(error, recoveryErrors);
    }
    throw error;
  } finally {
    for (const [part] of staged) {
      try {
        removeFileIfExistsSync(part);
      } catch {
        // missing_ok=True 语义。
      }
    }
  }

  // 成功路径：清理覆盖备份（失败只警告，不回滚已提交的照片）。
  for (const [backup] of backups) {
    try {
      await fsp.unlink(backup);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        context.log("WARNING", `清理实况照片覆盖备份失败 ${backup}：${errorText(error)}`);
      }
    }
  }
}

/**
 * 在输出已落盘后成组退役 MOVE 源文件。
 *
 * 先把每个源原子改名到同目录临时保留名；只有全部改名完成后才删除保留文件。
 * 改名阶段失败会回滚并把整组降级为 COPY。删除阶段的单项失败会优先恢复原路径，
 * 返回每一半的真实结果。
 */
export async function retireSourcesForMove(sources, context) {
  const sourceKeys = sources.map((source) => conflictKey(source));
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new ValidationError("MOVE 成组事务的源路径必须彼此唯一");
  }

  const holds = sources.map((source) =>
    path.join(path.dirname(source), `.${path.basename(source)}.${uuidHex()}.gpth-move-hold`),
  );
  /** @type {Array<[string, string]>} */
  const renamed = [];
  try {
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      const hold = holds[index];
      checkCancelled(context);
      await fsp.rename(source, hold);
      renamed.push([source, hold]);
      checkCancelled(context);
    }
  } catch (error) {
    const recoveryErrors = await restoreMoveHolds(renamed, context);
    if (recoveryErrors.length > 0) {
      throw new BundleTransactionError(error, recoveryErrors);
    }
    if (error instanceof CancelledError) {
      throw error;
    }
    const message = `源文件无法安全成组移除，输出已降级为复制：${errorText(error)}`;
    return sources.map(
      (source) => new MoveSourceOutcome(pathExists(source) || isSymlink(source) ? false : null, message),
    );
  }

  /** @type {MoveSourceOutcome[]} */
  const outcomes = [];
  // 进入删除阶段后不再响应取消，避免主动中断造成半组源文件。
  for (const [source, hold] of renamed) {
    let deleteError = null;
    try {
      await fsp.unlink(hold);
    } catch (error) {
      deleteError = error;
    }
    if (deleteError === null) {
      outcomes.push(new MoveSourceOutcome(true));
      continue;
    }
    let restoreError = null;
    try {
      await movePathNoReplace(hold, source);
    } catch (error) {
      restoreError = error;
    }
    if (restoreError === null) {
      outcomes.push(
        new MoveSourceOutcome(
          false,
          `无法删除源文件保留项，已恢复原路径并降级为复制：${source}（${errorText(deleteError)}）`,
        ),
      );
    } else {
      const message =
        "目标已输出，但源文件保留项无法删除或恢复：" +
        `原路径 ${source}；保留路径 ${hold}；` +
        `删除错误 ${errorText(deleteError)}；恢复错误 ${errorText(restoreError)}`;
      outcomes.push(new MoveSourceOutcome(null, message));
    }
  }
  return outcomes;
}

/** 在同一文件系统内安全改名，执行期间出现同名文件也绝不覆盖。 */
export async function renameFileNoReplace(source, target, context) {
  checkCancelled(context);
  if (samePathLexical(source, target)) {
    return;
  }
  if (!sameDirectory(path.dirname(source), path.dirname(target))) {
    throw new ValidationError("文件名修正只允许在原目录内进行");
  }
  await movePathNoReplace(source, target);
}

/** 原子语义地改名一组同目录文件；中途失败时恢复已经改名的成员。 */
export async function renameFilesNoReplace(pairs, context) {
  /** @type {Array<[string, string]>} */
  const completed = [];
  try {
    for (const [source, target] of pairs) {
      await renameFileNoReplace(source, target, context);
      completed.push([source, target]);
    }
  } catch (error) {
    const recoveryErrors = [];
    for (let index = completed.length - 1; index >= 0; index -= 1) {
      const [source, target] = completed[index];
      try {
        await movePathNoReplace(target, source);
      } catch (restoreError) {
        recoveryErrors.push(`${target} → ${source}：${errorText(restoreError)}`);
      }
    }
    if (recoveryErrors.length > 0) {
      const failure = new Error(
        `成组改名失败：${errorText(error)}；并且回滚不完整：${recoveryErrors.join("；")}`,
      );
      failure.cause = error;
      throw failure;
    }
    throw error;
  }
}

/** 安全移动并返回是否发生了跨卷实体复制。 */
export async function safeMove(
  source,
  target,
  context,
  chunkSize,
  { allowOverwrite = false } = {},
) {
  checkCancelled(context);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  checkCancelled(context);
  try {
    if (allowOverwrite) {
      if (pathExists(target) && isDirectory(target) && !isSymlink(target)) {
        throw isADirectoryError(`目标位置是目录，无法覆盖：${target}`);
      }
    } else if (pathExists(target) || isSymlink(target)) {
      throw fileExistsError(`执行期间目标已被其它程序占用：${target}`);
    }
    await fsp.rename(source, target);
    return false;
  } catch (error) {
    if (!error || !["EXDEV", "EACCES", "EPERM"].includes(error.code)) {
      throw error;
    }
  }

  // Windows 跨卷常返回 EACCES/EPERM；复制完成并落盘后才删除源文件。
  await atomicCopy(source, target, context, chunkSize, { allowOverwrite });
  checkCancelled(context);
  await fsp.unlink(source);
  return true;
}

/** 公开的单文件覆盖准备函数，主要供快捷方式执行器使用。 */
export function prepareFileTarget(targetPath) {
  if (isSymlink(targetPath) || isFile(targetPath)) {
    fs.unlinkSync(targetPath);
  } else if (pathExists(targetPath)) {
    throw isADirectoryError(`目标位置是目录，无法覆盖：${targetPath}`);
  }
}

/** Unix 创建相对符号链接，Windows 创建 .lnk。 */
export async function createShortcut(linkPath, targetPath, context) {
  checkCancelled(context);
  await fsp.mkdir(path.dirname(linkPath), { recursive: true });
  if (!IS_WINDOWS) {
    const relative = path.relative(path.dirname(linkPath), targetPath);
    await fsp.symlink(relative, linkPath);
    return;
  }

  // 通过环境变量传递 Unicode 路径，路径本身不会拼进 PowerShell 代码。
  const script =
    "$w=New-Object -ComObject WScript.Shell;" +
    "$s=$w.CreateShortcut($env:GPTH_LINK);" +
    "$s.TargetPath=$env:GPTH_TARGET;" +
    "$s.WorkingDirectory=$env:GPTH_WORKDIR;" +
    "$s.Save()";
  const environment = {
    ...process.env,
    GPTH_LINK: linkPath,
    // 保持原版的相对目标，整体搬移输出目录后快捷方式仍有机会可用。
    GPTH_TARGET: path.relative(path.dirname(linkPath), targetPath),
    GPTH_WORKDIR: path.dirname(linkPath),
  };
  const result = await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: environment,
        windowsHide: true, // subprocess.CREATE_NO_WINDOW 的等价物
        timeout: 30_000,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => resolve({ error, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
  });
  checkCancelled(context);
  const failure = result.error;
  // 启动失败（找不到 powershell.exe）或超时：Python 会原样抛出 OSError/TimeoutExpired。
  if (failure && (failure.killed || typeof failure.code !== "number")) {
    throw failure;
  }
  const exitCode = failure ? failure.code : 0;
  if (exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "未知 PowerShell 错误";
    throw new Error(`创建 Windows 快捷方式失败：${detail}`);
  }
}

/** 设置访问/修改时间；Windows 不支持 1970 年前时间时进行兼容钳制。 */
export function setFileTime(filePath, value, context) {
  checkCancelled(context);
  let actual = value;
  if (IS_WINDOWS && value.getTime() < new Date(1970, 0, 1).getTime()) {
    actual = new Date(1970, 0, 1);
    context.log(
      "WARNING",
      `${path.basename(filePath)} 的日期早于 1970，Windows 上已改为 1970-01-01`,
    );
  }
  const stamp = actual.getTime() / 1000;
  try {
    if (!IS_WINDOWS) {
      // Python os.utime(..., follow_symlinks=False)：POSIX 上不跟随链接。
      fs.lutimesSync(filePath, stamp, stamp);
    } else {
      // Windows 的 CPython 不支持 follow_symlinks=False，会退化为 os.utime(path,...)；
      // .lnk 本身是普通文件，直接调用不会跟随快捷方式。
      fs.utimesSync(filePath, stamp, stamp);
    }
  } catch (error) {
    if (
      IS_WINDOWS &&
      (error instanceof TypeError ||
        error.code === "ENOSYS" ||
        error.code === "ERR_METHOD_NOT_IMPLEMENTED")
    ) {
      fs.utimesSync(filePath, stamp, stamp);
    } else {
      throw error;
    }
  }
  return actual;
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** @typedef {{ dev: bigint, ino: bigint, size: bigint, ctimeNs: bigint }} PathIdentity */

/** 原子占有不存在的目标；既有目标永远不会被此函数覆盖。 */
async function claimTargetNoReplace(source, target) {
  try {
    await fsp.link(source, target);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw fileExistsError(`执行期间目标已被其它程序占用：${target}`);
    }
    // FAT/exFAT 等文件系统不支持 hardlink。用 O_EXCL 先原子占位，
    // 后续 rename 只替换我们自己创建的占位文件。
    let descriptor;
    try {
      descriptor = await fsp.open(target, "wx", 0o600);
    } catch (openError) {
      if (openError && openError.code === "EEXIST") {
        throw fileExistsError(`执行期间目标已被其它程序占用：${target}`);
      }
      throw openError;
    }
    await descriptor.close();
  }
  return pathIdentity(target);
}

/** 不覆盖任何新占用地恢复一个备份或 MOVE 保留文件。 */
async function movePathNoReplace(source, target) {
  const identity = await claimTargetNoReplace(source, target);
  try {
    if (!sameIdentity(await pathIdentity(target), identity)) {
      throw fileExistsError(`恢复期间目标已被外部替换：${target}`);
    }
    await fsp.rename(source, target);
  } catch (error) {
    // replace 失败时只清理仍属于本次占位的目标，不触碰被外部程序换入的文件。
    try {
      if (sameIdentity(await pathIdentity(target), identity)) {
        await fsp.unlink(target);
      }
    } catch {
      // 目标可能已不存在。
    }
    throw error;
  }

  // POSIX rename 在源和目标是同一 inode 的 hardlink 时可能是空操作；
  // 显式清理旧名，确保备份或 hold 不会被误报为已消费。
  if (pathExists(source) || isSymlink(source)) {
    try {
      await fsp.unlink(source);
    } catch (error) {
      throw new Error(`目标已恢复，但无法清理保留路径 ${source}：${errorText(error)}`);
    }
  }
}

/** 回滚已占有的目标并恢复覆盖备份，返回所有二次失败。 */
async function rollbackCopyBundle(claimed, backups, context) {
  const errors = [];
  for (let index = claimed.length - 1; index >= 0; index -= 1) {
    const [target, identity] = claimed[index];
    let current;
    try {
      current = await pathIdentity(target);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      const message = `无法检查已提交目标 ${target}：${errorText(error)}`;
      errors.push(message);
      context.log("ERROR", message);
      continue;
    }
    if (!sameIdentity(current, identity)) {
      const message = `已提交目标被外部替换，未删除：${target}`;
      errors.push(message);
      context.log("ERROR", message);
      continue;
    }
    try {
      await fsp.unlink(target);
    } catch (error) {
      const message = `回滚已提交目标失败 ${target}：${errorText(error)}`;
      errors.push(message);
      context.log("ERROR", message);
    }
  }

  for (let index = backups.length - 1; index >= 0; index -= 1) {
    const [backup, target] = backups[index];
    try {
      await movePathNoReplace(backup, target);
    } catch (error) {
      const message = `恢复覆盖备份失败：备份 ${backup}；目标 ${target}；${errorText(error)}`;
      errors.push(message);
      context.log("ERROR", message);
    }
  }
  return errors;
}

/** 将尚未删除的 MOVE 保留文件恢复到原路径。 */
async function restoreMoveHolds(renamed, context) {
  const errors = [];
  for (let index = renamed.length - 1; index >= 0; index -= 1) {
    const [source, hold] = renamed[index];
    try {
      await movePathNoReplace(hold, source);
    } catch (error) {
      const message = `MOVE 回滚失败：保留 ${hold}；原路径 ${source}；${errorText(error)}`;
      errors.push(message);
      context.log("ERROR", message);
    }
  }
  return errors;
}

/** 清理暂存文件并返回无法清理的精确路径。 */
async function cleanupStagedFiles(staged, context, errorLevel) {
  const errors = [];
  for (const [part] of staged) {
    try {
      await fsp.unlink(part);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      const message = `清理成组暂存文件失败 ${part}：${errorText(error)}`;
      errors.push(message);
      context.log(errorLevel, message);
    }
  }
  return errors;
}

/** 返回足以识别本次占位文件的不跟随链接身份。 */
async function pathIdentity(filePath) {
  const info = await fsp.lstat(filePath, { bigint: true });
  return { dev: info.dev, ino: info.ino, size: info.size, ctimeNs: info.ctimeNs };
}

/** @param {PathIdentity} left @param {PathIdentity} right */
function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs
  );
}

/** 先以 "xb" 打开暂存文件，流式写入后 fsync。 */
async function streamCopyFile(source, part, context, chunkSize) {
  const sourceHandle = await fsp.open(source, "r");
  let destHandle = null;
  try {
    destHandle = await fsp.open(part, "wx");
  } catch (error) {
    await sourceHandle.close().catch(() => {});
    throw error;
  }
  try {
    const buffer = Buffer.allocUnsafe(normaliseChunkSize(chunkSize));
    for (;;) {
      checkCancelled(context);
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      await destHandle.write(buffer, 0, bytesRead);
    }
    // Python: dst.flush() + os.fsync(dst.fileno())。
    await destHandle.sync();
  } finally {
    await destHandle.close().catch(() => {});
    await sourceHandle.close().catch(() => {});
  }
}

/** shutil.copystat 的最佳努力等价物：权限位 + atime/mtime，失败静默。 */
async function copyStatBestEffort(source, destination) {
  let info;
  try {
    info = await fsp.stat(source);
  } catch {
    return;
  }
  try {
    await fsp.chmod(destination, info.mode & 0o7777);
  } catch {
    // 与 Python 一样：元数据失败不影响照片实体复制。
  }
  try {
    await fsp.utimes(destination, info.atimeMs / 1000, info.mtimeMs / 1000);
  } catch {
    // 同上。
  }
}

/** Python mimetypes.guess_type 的 image/* video/* 子集。 */
function guessMimeType(fileName) {
  let split = splitExtension(String(fileName));
  let ext = split.suffix;
  while (Object.hasOwn(MIMETYPE_SUFFIX_MAP, ext.toLowerCase())) {
    split = splitExtension(split.stem + MIMETYPE_SUFFIX_MAP[ext.toLowerCase()]);
    ext = split.suffix;
  }
  if (Object.hasOwn(MIMETYPE_ENCODING_MAP, ext)) {
    split = splitExtension(split.stem);
    ext = split.suffix;
  }
  return IMAGE_VIDEO_MIME_TYPES[ext.toLowerCase()] ?? null;
}

/** posixpath.splitext 的等价实现（输入是 basename）。 */
function splitExtension(name) {
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return { stem: name.slice(0, dot), suffix: name.slice(dot) };
  }
  return { stem: name, suffix: "" };
}

/** Path.stem / Path.suffix 分离（suffix 含前导点）。 */
function splitStemSuffix(filePath) {
  const name = path.basename(filePath);
  const suffix = pathSuffix(filePath);
  return { stem: suffix ? name.slice(0, name.length - suffix.length) : name, suffix };
}

/** Python Path.suffix：末尾的点不构成后缀。 */
function pathSuffix(filePath) {
  const name = path.basename(filePath);
  const index = name.lastIndexOf(".");
  if (index > 0 && index < name.length - 1) {
    return name.slice(index);
  }
  return "";
}

/**
 * 解析符号链接尽可能多的部分；失败时模仿 Path.resolve(strict=False)：
 * 解析仍然存在的父级前缀，剩余部分按字面拼接。
 */
function resolveRealPath(filePath) {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    let prefix = absolute;
    const remainder = [];
    for (;;) {
      const parent = path.dirname(prefix);
      if (parent === prefix) {
        break;
      }
      remainder.unshift(path.basename(prefix));
      prefix = parent;
      try {
        const resolvedPrefix = fs.realpathSync(prefix);
        return path.join(resolvedPrefix, ...remainder);
      } catch {
        // 继续向上寻找存在的最长前缀。
      }
    }
    return absolute;
  }
}

/** 取消检查：仅在 context 提供 checkCancelled 时调用。 */
function checkCancelled(context) {
  if (context && typeof context.checkCancelled === "function") {
    context.checkCancelled();
  }
}

/** 生成同目录暂存文件名：.<name>.<uuid>.gpth-part。 */
function partPath(target) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${uuidHex()}.gpth-part`,
  );
}

/** uuid.uuid4().hex 的等价物：32 位小写十六进制。 */
function uuidHex() {
  return crypto.randomBytes(16).toString("hex");
}

/** 块大小归一：Python read() 需要正整数。 */
function normaliseChunkSize(chunkSize) {
  const value = typeof chunkSize === "bigint" ? Number(chunkSize) : Number(chunkSize);
  if (!Number.isFinite(value) || value <= 0) {
    return 64 * 1024;
  }
  return Math.max(1, Math.trunc(value));
}

/** 构建带 errno 风格 code 的文件系统错误（与 Node 原生错误同构）。 */
function fsErrorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fileExistsError(message) {
  return fsErrorWithCode(message, "EEXIST");
}

function isADirectoryError(message) {
  return fsErrorWithCode(message, "EISDIR");
}

/** 把异常变成可拼接的用户文本（对应 Python str(exc)）。 */
function errorText(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

/** 本地时间 + 微秒的 isoformat（与 Python datetime.now().isoformat() 形状一致）。 */
function localIsoWithMicroseconds(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const year = pad(date.getFullYear(), 4);
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  const microseconds = date.getMilliseconds() * 1000;
  const base = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  return microseconds === 0 ? base : `${base}.${pad(microseconds, 6)}`;
}

function toIntegerOrZero(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : 0;
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

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/** 文件系统路径是否表示同一目录：与 pathlib 一致，仅 Windows 大小写不敏感。 */
function sameDirectory(first, second) {
  if (IS_WINDOWS) {
    return first.toLowerCase() === second.toLowerCase();
  }
  return first === second;
}

/** PurePath 相等语义：仅 Windows 上大小写不敏感。 */
function samePathLexical(first, second) {
  if (IS_WINDOWS) {
    return first.toLowerCase() === second.toLowerCase();
  }
  return first === second;
}

function removeFileIfExistsSync(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }
}
