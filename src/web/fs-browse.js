/**
 * 目录浏览：Web 端替代 Tk 的 askdirectory。
 *
 * 契约（docs/ARCHITECTURE.md 的 Web 架构）：
 * - GET /api/fs/roots -> { roots:[{name,path}], quickAccess:[{name,path,kind}] }
 * - GET /api/fs/list?path=<abs>&showHidden=0&type=dir|all
 *     -> { path, name, parent, entries:[{name,path,type,size,mtimeMs,isHidden}], quickAccess }
 * - 不可读路径抛 BrowseError（400，错误对象里带 parent）。
 *
 * Windows 上 Node 的 fs.stat 不暴露 st_file_attributes，隐藏属性只能“尽力而为”：
 * 每次目录列举额外调用一次 attrib（目录浏览是用户触发的低频操作，可接受），
 * 失败时静默退化为仅识别点号隐藏文件。禁止逐文件起进程。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveUserPath } from "../models.js";

const execFileAsync = promisify(execFile);
const collator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base", numeric: true });
const WINDOWS_HIDDEN_CACHE_LIMIT = 100;

/** attrib 结果缓存：目录路径（小写）+ 目录 mtime -> 隐藏项名称集合。 */
const windowsHiddenCache = new Map();

/** 目录浏览错误；server.js 统一映射为 400，并把 parent 放进错误响应。 */
export class BrowseError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "BrowseError";
    this.code = code;
    this.extra = extra;
  }
}

function toBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(text)) {
    return false;
  }
  return fallback;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Windows：枚举存在的盘符（A-Z）。 */
function windowsDriveRoots() {
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const rootPath = `${letter}:\\`;
    if (isDirectory(rootPath)) {
      roots.push({ name: `${letter}:`, path: rootPath, kind: "drive" });
    }
  }
  return roots;
}

/** 系统级根目录（非 Windows）。 */
function posixRoots() {
  const roots = [{ name: "/", path: "/", kind: "root" }];
  if (process.platform === "darwin") {
    for (const entry of ["/Volumes", "/Users"]) {
      if (isDirectory(entry)) {
        roots.push({ name: path.basename(entry), path: entry, kind: "root" });
      }
    }
  } else {
    for (const entry of ["/home", "/mnt", "/media"]) {
      if (isDirectory(entry)) {
        roots.push({ name: path.basename(entry), path: entry, kind: "root" });
      }
    }
  }
  return roots;
}

/** 主目录/桌面/下载/图片/文档等快捷入口（只返回真实存在的目录）。 */
export function quickAccessEntries() {
  const home = os.homedir();
  const candidates = [
    { name: "主目录", path: home, kind: "home" },
    { name: "桌面", path: path.join(home, "Desktop"), kind: "desktop" },
    { name: "下载", path: path.join(home, "Downloads"), kind: "downloads" },
    { name: "图片", path: path.join(home, "Pictures"), kind: "pictures" },
    { name: "文档", path: path.join(home, "Documents"), kind: "documents" },
  ];
  const seen = new Set();
  return candidates.filter((entry) => {
    const key = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return isDirectory(entry.path);
  });
}

/** GET /api/fs/roots。 */
export async function getRoots() {
  const roots = process.platform === "win32" ? windowsDriveRoots() : posixRoots();
  return { roots, quickAccess: quickAccessEntries() };
}

/**
 * 解析 attrib 输出中的隐藏项（Windows 隐藏属性，尽力而为）。
 * 输出示例：`A    H       C:\photos\secret.jpg`。
 */
function parseAttribHidden(stdout) {
  const hidden = new Set();
  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }
    const match = /^([A-Za-z ]{1,24}?)\s+([A-Za-z]:[\\/].*|\\\\[^\\/].*)$/u.exec(line);
    if (!match) {
      continue;
    }
    // attrib 会把属性字母（含 H=隐藏）写在路径前；只关心是否含 H。
    if (!match[1].includes("H") && !match[1].includes("h")) {
      continue;
    }
    const basename = path.basename(match[2].trim());
    if (basename) {
      hidden.add(basename.toLowerCase());
    }
  }
  return hidden;
}

async function probeWindowsHidden(dirPath, dirMtimeMs) {
  if (process.platform !== "win32") {
    return new Set();
  }
  const cacheKey = `${dirPath.toLowerCase()}|${Math.round(Number(dirMtimeMs) || 0)}`;
  const cached = windowsHiddenCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const options = { windowsHide: true, timeout: 3000, maxBuffer: 4 * 1024 * 1024 };
  const hidden = new Set();
  try {
    const results = await Promise.allSettled([
      execFileAsync("attrib", [path.join(dirPath, "*")], options),
      execFileAsync("attrib", [path.join(dirPath, "*"), "/d"], options),
    ]);
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const name of parseAttribHidden(result.value.stdout)) {
          hidden.add(name);
        }
      }
    }
  } catch {
    // 隐藏属性探测失败不影响目录浏览，静默退化为仅识别点号文件。
  }
  windowsHiddenCache.set(cacheKey, hidden);
  while (windowsHiddenCache.size > WINDOWS_HIDDEN_CACHE_LIMIT) {
    const oldest = windowsHiddenCache.keys().next().value;
    windowsHiddenCache.delete(oldest);
  }
  return hidden;
}

function parentOf(resolvedPath) {
  const parent = path.dirname(resolvedPath);
  if (!parent || parent === resolvedPath) {
    return null;
  }
  return parent;
}

function isHiddenEntry(name, windowsHiddenNames) {
  if (name.startsWith(".")) {
    return true;
  }
  return windowsHiddenNames.has(name.toLowerCase());
}

/**
 * GET /api/fs/list。
 *
 * @param {{dirPath?: string, showHidden?: string|boolean, type?: string}} params
 */
export async function listDirectory(params = {}) {
  const requested = params.dirPath;
  const rawPath =
    requested === undefined || requested === null || String(requested).trim() === ""
      ? os.homedir()
      : String(requested).trim();
  let resolvedPath;
  try {
    resolvedPath = resolveUserPath(rawPath);
  } catch (error) {
    throw new BrowseError("invalid-path", `目录路径无效：${error.message}`, {
      parent: null,
      path: rawPath,
    });
  }
  const showHidden = toBooleanFlag(params.showHidden, false);
  const includeFiles = String(params.type ?? "dir").trim().toLowerCase() === "all";

  let dirStat;
  try {
    dirStat = fs.statSync(resolvedPath);
  } catch (error) {
    throw new BrowseError("unreadable", `无法读取目录：${resolvedPath}`, {
      parent: parentOf(resolvedPath),
      path: resolvedPath,
      reason: error?.code ?? null,
    });
  }
  if (!dirStat.isDirectory()) {
    throw new BrowseError("unreadable", `路径不是文件夹：${resolvedPath}`, {
      parent: parentOf(resolvedPath),
      path: resolvedPath,
    });
  }

  let dirents;
  try {
    dirents = fs.readdirSync(resolvedPath, { withFileTypes: true });
  } catch (error) {
    throw new BrowseError("unreadable", `无法读取目录：${resolvedPath}`, {
      parent: parentOf(resolvedPath),
      path: resolvedPath,
      reason: error?.code ?? null,
    });
  }

  // 即使 showHidden=1 也探测隐藏属性，这样条目上的 isHidden 标记始终正确；
  // 非 Windows 下探测直接返回空集，开销可忽略。
  const windowsHiddenNames = await probeWindowsHidden(resolvedPath, dirStat.mtimeMs);

  const entries = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    const fullPath = path.join(resolvedPath, name);
    let stat = null;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      // 断链/无权限条目仍然展示（类型按 dirent 推断），避免整个目录列举失败。
      stat = null;
    }
    const type = stat
      ? stat.isDirectory()
        ? "dir"
        : stat.isFile()
          ? "file"
          : "other"
      : dirent.isDirectory()
        ? "dir"
        : "file";
    if (!includeFiles && type !== "dir") {
      continue;
    }
    if (type === "other") {
      continue;
    }
    const hidden = isHiddenEntry(name, windowsHiddenNames);
    if (!showHidden && hidden) {
      continue;
    }
    entries.push({
      name,
      path: fullPath,
      type,
      // type 是契约字段；isDir/isFile 是给前端直接判断用的便利别名（额外字段）。
      isDir: type === "dir",
      isFile: type === "file",
      size: type === "file" && stat ? stat.size : null,
      mtimeMs: stat ? Math.round(stat.mtimeMs) : null,
      isHidden: hidden,
    });
  }

  entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "dir" ? -1 : 1;
    }
    return collator.compare(left.name, right.name);
  });

  const root = path.parse(resolvedPath).root;
  const name = resolvedPath === root ? resolvedPath : path.basename(resolvedPath);
  return {
    path: resolvedPath,
    name,
    parent: parentOf(resolvedPath),
    entries,
    quickAccess: quickAccessEntries(),
  };
}
