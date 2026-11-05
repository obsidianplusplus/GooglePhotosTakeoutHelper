/**
 * PhotoTakeout Studio Web 后端 HTTP 服务。
 *
 * 职责：
 * - 静态文件（src/web/public，前端由设计/Lead 维护）；
 * - JSON API（docs/ARCHITECTURE.md 的 Web 架构 / 16.2 / 16.3 / 16.4）；
 * - SSE：/api/session/:id/events；
 * - 缩略图与目录浏览；
 * - 同源校验、请求体大小限制、统一错误结构。
 *
 * 引擎任务全部在 worker_threads 中运行（见 jobs.js），本文件不直接调用引擎。
 */

import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  APP_DISPLAY_NAME,
  APP_NAME,
  APP_VERSION,
  scanCachePath,
  settingsPath,
} from "../constants.js";
import { getRoots, listDirectory, BrowseError } from "./fs-browse.js";
import { SessionManager, WebError } from "./jobs.js";
import { ThumbnailService } from "./thumbnails.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.join(MODULE_DIR, "public");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const JSON_TYPE = "application/json; charset=utf-8";

const MIME_TYPES = new Map(
  Object.entries({
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  }),
);

const SESSION_ACTION_RE = /^\/api\/session\/([^/]+)\/(events|execute|cancel|preview|duplicates|summary)$/u;
const SESSION_ITEM_RE = /^\/api\/session\/([^/]+)$/u;

// ----------------------------------------------------------------------
// 通用工具
// ----------------------------------------------------------------------

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new WebError("invalid-path", "请求路径包含非法编码。", 400);
  }
}

function truthyFlag(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  const text = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}

function assertMethod(method, allowed) {
  if (!allowed.includes(method)) {
    throw new WebError("method-not-allowed", `不支持的请求方法：${method}`, 405);
  }
}

function sendJson(res, status, payload, { head = false, headers = {} } = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": JSON_TYPE,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  if (head) {
    res.end();
    return;
  }
  res.end(body);
}

/** 读取并解析 JSON 请求体；限制 2MB，空 body 视为 {}。 */
async function readJsonBody(req) {
  const contentLength = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new WebError("payload-too-large", "请求体过大（上限 2MB）。", 413);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new WebError("payload-too-large", "请求体过大（上限 2MB）。", 413);
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    return {};
  }
  const rawContentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const isJsonType = rawContentType === "application/json" || rawContentType.endsWith("+json");
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not-object");
    }
    return parsed;
  } catch {
    if (!isJsonType) {
      throw new WebError("unsupported-media-type", "请求体必须是 application/json。", 415);
    }
    throw new WebError("invalid-json", "请求体不是合法的 JSON 对象。", 400);
  }
}

/** POST/PUT/DELETE 同源校验：带 Origin 时必须是当前服务来源。 */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"];
  if (!origin) {
    if (fetchSite === "cross-site") {
      throw new WebError("forbidden-origin", "跨站请求已被拒绝。", 403);
    }
    return;
  }
  if (String(origin) === "null") {
    throw new WebError("forbidden-origin", "跨站请求已被拒绝。", 403);
  }
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    throw new WebError("forbidden-origin", "请求来源无效。", 403);
  }
  const host = String(req.headers.host ?? "").toLowerCase();
  if (!host || parsed.host.toLowerCase() !== host) {
    throw new WebError("forbidden-origin", "仅允许同一来源的请求。", 403);
  }
}

// ----------------------------------------------------------------------
// 延迟加载的引擎周边模块（settings / scan-cache / image-support）
// 这些模块由其他移植者并行编写，缺失时只让对应接口返回 503。
// ----------------------------------------------------------------------

let settingsModulePromise = null;
let scanCacheModulePromise = null;
let imageSupportModulePromise = null;

function loadSettingsModule() {
  if (!settingsModulePromise) {
    settingsModulePromise = import("../settings.js").catch((error) => {
      settingsModulePromise = null;
      throw error;
    });
  }
  return settingsModulePromise;
}

function loadScanCacheModule() {
  if (!scanCacheModulePromise) {
    scanCacheModulePromise = import("../scan-cache.js").catch((error) => {
      scanCacheModulePromise = null;
      throw error;
    });
  }
  return scanCacheModulePromise;
}

function loadImageSupportModule() {
  if (!imageSupportModulePromise) {
    imageSupportModulePromise = import("../image-support.js").catch((error) => {
      imageSupportModulePromise = null;
      throw error;
    });
  }
  return imageSupportModulePromise;
}

function moduleUnavailable(moduleLabel, error) {
  return new WebError(
    "unavailable",
    `${moduleLabel}模块尚未就绪：${error?.message ?? error}`,
    503,
  );
}

async function loadSettingsModuleOrThrow() {
  try {
    return await loadSettingsModule();
  } catch (error) {
    throw moduleUnavailable("设置", error);
  }
}

async function createHashCache() {
  try {
    const module = await loadScanCacheModule();
    if (typeof module.HashCache !== "function") {
      throw new Error("HashCache 未导出");
    }
    return new module.HashCache();
  } catch (error) {
    if (error instanceof WebError) {
      throw error;
    }
    throw moduleUnavailable("扫描缓存", error);
  }
}

async function getCacheInfoSafe() {
  try {
    const cache = await createHashCache();
    return { entries: cache.entryCount ?? 0, path: cache.path ?? scanCachePath() };
  } catch (error) {
    return {
      entries: 0,
      path: scanCachePath(),
      available: false,
      error: error?.message ?? String(error),
    };
  }
}

async function getImageCapabilitiesSafe() {
  try {
    const module = await loadImageSupportModule();
    if (typeof module.getImageCapabilities !== "function") {
      throw new Error("getImageCapabilities 未导出");
    }
    const capabilities = await module.getImageCapabilities();
    return { sharp: Boolean(capabilities?.sharp), heic: Boolean(capabilities?.heic) };
  } catch (error) {
    return { sharp: false, heic: false, available: false, error: error?.message ?? String(error) };
  }
}

// ----------------------------------------------------------------------
// API 路由
// ----------------------------------------------------------------------

async function handleHealth(req, res) {
  assertMethod(req.method, ["GET", "HEAD"]);
  sendJson(
    res,
    200,
    {
      ok: true,
      app: { name: APP_NAME, displayName: APP_DISPLAY_NAME, version: APP_VERSION },
      platform: process.platform,
      node: process.version,
      pid: process.pid,
    },
    { head: req.method === "HEAD" },
  );
}

async function handleSystem(req, res) {
  assertMethod(req.method, ["GET", "HEAD"]);
  const [cache, imageCapabilities] = await Promise.all([
    getCacheInfoSafe(),
    getImageCapabilitiesSafe(),
  ]);
  sendJson(
    res,
    200,
    {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      version: APP_VERSION,
      settingsPath: settingsPath(),
      scanCachePath: scanCachePath(),
      cache,
      imageCapabilities,
    },
    { head: req.method === "HEAD" },
  );
}

async function handleSettingsGet(req, res) {
  assertMethod(req.method, ["GET", "HEAD"]);
  const { loadSettings } = await loadSettingsModuleOrThrow();
  if (typeof loadSettings !== "function") {
    throw new WebError("unavailable", "设置模块接口缺失（loadSettings）。", 503);
  }
  const settings = await loadSettings();
  sendJson(res, 200, { settings }, { head: req.method === "HEAD" });
}

async function handleSettingsPut(req, res) {
  assertMethod(req.method, ["PUT", "POST"]);
  const body = await readJsonBody(req);
  const incoming = body?.settings;
  if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw new WebError("invalid-settings", "请求体必须包含 settings 对象。", 400);
  }
  const module = await loadSettingsModuleOrThrow();
  const { loadSettings, saveSettings, mergeDict } = module;
  if (typeof loadSettings !== "function" || typeof saveSettings !== "function") {
    throw new WebError("unavailable", "设置模块接口缺失。", 503);
  }
  const current = await loadSettings();
  const merged =
    typeof mergeDict === "function"
      ? mergeDict({ ...(current ?? {}) }, incoming)
      : { ...(current ?? {}), ...incoming };
  try {
    await saveSettings(merged);
  } catch (error) {
    throw new WebError(
      "settings-save-failed",
      `设置保存失败：${error?.message ?? error}`,
      500,
    );
  }
  const settings = await loadSettings();
  sendJson(res, 200, { ok: true, settings });
}

async function handleCacheGet(req, res) {
  assertMethod(req.method, ["GET", "HEAD"]);
  const cache = await createHashCache();
  sendJson(
    res,
    200,
    { entries: cache.entryCount ?? 0, path: cache.path ?? scanCachePath() },
    { head: req.method === "HEAD" },
  );
}

async function handleCacheClear(req, res) {
  assertMethod(req.method, ["POST"]);
  const cache = await createHashCache();
  const count = cache.entryCount ?? 0;
  let cleared = false;
  try {
    cleared = Boolean(cache.clear());
  } catch (error) {
    throw new WebError("cache-clear-failed", `清理扫描缓存失败：${error?.message ?? error}`, 500);
  }
  // cleared 为实际清理的条目数（前端按数字展示“已清理 N 条”）；失败时为 0。
  sendJson(res, 200, { ok: true, cleared: cleared ? count : 0 });
}

async function handleFsRoots(req, res) {
  assertMethod(req.method, ["GET", "HEAD"]);
  try {
    const roots = await getRoots();
    sendJson(res, 200, roots, { head: req.method === "HEAD" });
  } catch (error) {
    if (error instanceof BrowseError) {
      throw new WebError(error.code, error.message, 400, error.extra);
    }
    throw error;
  }
}

async function handleFsList(req, res, url) {
  assertMethod(req.method, ["GET", "HEAD"]);
  const params = {
    dirPath: url.searchParams.get("path") ?? "",
    showHidden: url.searchParams.get("showHidden") ?? "0",
    type: url.searchParams.get("type") ?? "dir",
  };
  try {
    const listing = await listDirectory(params);
    sendJson(res, 200, listing, { head: req.method === "HEAD" });
  } catch (error) {
    if (error instanceof BrowseError) {
      // 契约：不可读路径返回 400，但 parent 仍可用于界面回退。
      throw new WebError(error.code, error.message, 400, error.extra);
    }
    throw error;
  }
}

async function handleThumb(req, res, url, context) {
  assertMethod(req.method, ["GET", "HEAD"]);
  const filePath = url.searchParams.get("path");
  if (!filePath || String(filePath).trim() === "") {
    throw new WebError("invalid-path", "缺少 path 参数。", 400);
  }
  const result = await context.thumbnails.get(
    filePath,
    url.searchParams.get("w"),
    url.searchParams.get("h"),
  );
  if (result.status === "ready" && result.pngBytes) {
    const buffer = Buffer.isBuffer(result.pngBytes) ? result.pngBytes : Buffer.from(result.pngBytes);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": buffer.length,
      "Cache-Control": "private, max-age=3600",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(buffer);
    return;
  }
  sendJson(
    res,
    404,
    {
      status: result.status,
      error: result.error ?? null,
      decodedFormat: result.decodedFormat ?? null,
      rawSize: result.rawSize ?? null,
      displaySize: result.displaySize ?? null,
    },
    { head: req.method === "HEAD" },
  );
}

async function handlePreviewInfo(req, res, url, context) {
  assertMethod(req.method, ["GET", "HEAD"]);
  const filePath = url.searchParams.get("path");
  if (!filePath || String(filePath).trim() === "") {
    throw new WebError("invalid-path", "缺少 path 参数。", 400);
  }
  try {
    const info = await context.thumbnails.getInfo(filePath);
    sendJson(res, 200, info, { head: req.method === "HEAD" });
  } catch (error) {
    if (error?.code === "invalid-path") {
      throw new WebError("invalid-path", error.message, 400);
    }
    throw new WebError(
      "preview-info-unavailable",
      `无法读取预览信息：${error?.message ?? error}`,
      503,
    );
  }
}

async function handleSessionCreate(req, res, context) {
  assertMethod(req.method, ["POST"]);
  const body = await readJsonBody(req);
  const created = context.manager.createSession({ type: body?.type, options: body?.options });
  sendJson(res, 200, created);
}

async function handleSessionEvents(req, res, sessionId, context) {
  assertMethod(req.method, ["GET"]);
  const session = context.manager.getSession(sessionId);
  context.manager.subscribe(session.id, req, res);
}

async function handleSessionExecute(req, res, sessionId, context) {
  assertMethod(req.method, ["POST"]);
  const body = await readJsonBody(req);
  const result = context.manager.executeSession(sessionId, body?.options);
  sendJson(res, 200, result);
}

async function handleSessionCancel(req, res, sessionId, context) {
  assertMethod(req.method, ["POST"]);
  await readJsonBody(req);
  const result = context.manager.cancelSession(sessionId);
  sendJson(res, 200, result);
}

async function handleSessionDelete(req, res, sessionId, context) {
  assertMethod(req.method, ["DELETE"]);
  req.resume();
  const result = await context.manager.deleteSession(sessionId);
  sendJson(res, 200, result);
}

async function handleSessionPreview(req, res, sessionId, url, context) {
  assertMethod(req.method, ["GET", "HEAD"]);
  const page = await context.manager.getPreviewPage(sessionId, {
    offset: url.searchParams.get("offset") ?? "0",
    limit: url.searchParams.get("limit") ?? "300",
  });
  sendJson(res, 200, page, { head: req.method === "HEAD" });
}

async function handleSessionDuplicates(req, res, sessionId, url, context) {
  assertMethod(req.method, ["GET", "HEAD"]);
  const page = await context.manager.getDuplicatesPage(sessionId, {
    offset: url.searchParams.get("offset") ?? "0",
    limit: url.searchParams.get("limit") ?? "200",
  });
  sendJson(res, 200, page, { head: req.method === "HEAD" });
}

async function handleSessionSummary(req, res, sessionId, context) {
  assertMethod(req.method, ["GET", "HEAD"]);
  const summary = context.manager.getSummary(sessionId);
  sendJson(res, 200, summary, { head: req.method === "HEAD" });
}

async function handleApi(req, res, url, context) {
  const method = req.method ?? "GET";
  const pathname = safeDecode(url.pathname);

  if (pathname === "/api/health") {
    return handleHealth(req, res);
  }
  if (pathname === "/api/system") {
    return handleSystem(req, res);
  }
  if (pathname === "/api/settings") {
    return method === "PUT" || method === "POST"
      ? handleSettingsPut(req, res)
      : handleSettingsGet(req, res);
  }
  if (pathname === "/api/cache") {
    return handleCacheGet(req, res);
  }
  if (pathname === "/api/cache/clear") {
    return handleCacheClear(req, res);
  }
  if (pathname === "/api/fs/roots") {
    return handleFsRoots(req, res);
  }
  if (pathname === "/api/fs/list") {
    return handleFsList(req, res, url);
  }
  if (pathname === "/api/thumb") {
    return handleThumb(req, res, url, context);
  }
  if (pathname === "/api/preview-info") {
    return handlePreviewInfo(req, res, url, context);
  }
  if (pathname === "/api/session") {
    return handleSessionCreate(req, res, context);
  }

  const actionMatch = SESSION_ACTION_RE.exec(pathname);
  if (actionMatch) {
    const sessionId = safeDecode(actionMatch[1]);
    const action = actionMatch[2];
    if (action === "events") {
      return handleSessionEvents(req, res, sessionId, context);
    }
    if (action === "execute") {
      return handleSessionExecute(req, res, sessionId, context);
    }
    if (action === "cancel") {
      return handleSessionCancel(req, res, sessionId, context);
    }
    if (action === "preview") {
      return handleSessionPreview(req, res, sessionId, url, context);
    }
    if (action === "duplicates") {
      return handleSessionDuplicates(req, res, sessionId, url, context);
    }
    if (action === "summary") {
      return handleSessionSummary(req, res, sessionId, context);
    }
  }

  const itemMatch = SESSION_ITEM_RE.exec(pathname);
  if (itemMatch) {
    const sessionId = safeDecode(itemMatch[1]);
    if (method === "DELETE") {
      return handleSessionDelete(req, res, sessionId, context);
    }
    throw new WebError("method-not-allowed", `不支持的请求方法：${method}`, 405);
  }

  throw new WebError("not-found", `接口不存在：${method} ${pathname}`, 404);
}

// ----------------------------------------------------------------------
// 静态文件
// ----------------------------------------------------------------------

function isInsideDirectory(parentDirectory, candidate) {
  const relative = path.relative(parentDirectory, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function cacheControlFor(extension) {
  if ([".html", ".htm", ".css", ".js", ".mjs", ".json", ".map"].includes(extension)) {
    return "no-cache";
  }
  return "public, max-age=3600";
}

function staticNotFound(res, requestPath, { head = false } = {}) {
  sendJson(
    res,
    404,
    { error: { code: "not-found", message: `资源不存在：${requestPath}` } },
    { head },
  );
}

async function serveStatic(req, res, url, context) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new WebError("method-not-allowed", "静态资源仅支持 GET/HEAD。", 405);
  }
  const head = req.method === "HEAD";
  let pathname = safeDecode(url.pathname);
  if (pathname === "/") {
    pathname = "/index.html";
  }
  const publicDir = context.publicDir;
  const target = path.resolve(publicDir, `.${pathname}`);
  if (target !== publicDir && !isInsideDirectory(publicDir, target)) {
    throw new WebError("forbidden", "非法的静态资源路径。", 403);
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    stat = null;
  }
  let filePath = target;
  if (stat?.isDirectory()) {
    filePath = path.join(target, "index.html");
    try {
      stat = await fsp.stat(filePath);
    } catch {
      stat = null;
    }
  }
  if (!stat || !stat.isFile()) {
    if (filePath.endsWith(`${path.sep}index.html`) || pathname === "/index.html") {
      context.warnMissingIndex(publicDir);
    }
    staticNotFound(res, pathname, { head });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME_TYPES.get(extension) ?? "application/octet-stream",
    "Cache-Control": cacheControlFor(extension),
    "Last-Modified": stat.mtime.toUTCString(),
    ETag: etag,
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let body;
  try {
    body = await fsp.readFile(filePath);
  } catch (error) {
    throw new WebError(
      "static-read-failed",
      `读取静态资源失败：${error?.message ?? error}`,
      500,
    );
  }
  res.writeHead(200, { ...headers, "Content-Length": body.length });
  if (head) {
    res.end();
    return;
  }
  res.end(body);
}

// ----------------------------------------------------------------------
// 服务创建
// ----------------------------------------------------------------------

/**
 * 创建（尚未 listen 的）Web 服务。
 *
 * @param {{quiet?: boolean, publicDir?: string, manager?: SessionManager,
 *   thumbnails?: ThumbnailService}} [options]
 * @returns {{server: http.Server, manager: SessionManager,
 *   thumbnails: ThumbnailService, publicDir: string, close: () => Promise<void>}}
 */
export function createWebServer(options = {}) {
  const quiet = Boolean(options.quiet);
  const manager = options.manager ?? new SessionManager();
  const thumbnails = options.thumbnails ?? new ThumbnailService();
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const sockets = new Set();
  let closing = false;
  let wroteMissingIndexWarning = false;

  const context = {
    manager,
    thumbnails,
    publicDir,
    quiet,
    warnMissingIndex(directory) {
      if (wroteMissingIndexWarning || quiet) {
        return;
      }
      wroteMissingIndexWarning = true;
      console.warn(
        `[web] 前端页面尚未就绪：${path.join(directory, "index.html")} 不存在。` +
          " 请等待前端文件生成后刷新页面。",
      );
    },
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, context);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (error, socket) => {
    try {
      if (socket.writable) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      }
    } catch {
      // 客户端已经断开。
    }
  });

  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await manager.close();
    thumbnails.clear?.();
    const closed = new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // 忽略。
      }
    }
    sockets.clear();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000).unref?.())]);
  };

  return { server, manager, thumbnails, publicDir, close };
}

async function handleRequest(req, res, context) {
  try {
    const host = String(req.headers.host ?? "127.0.0.1");
    const url = new URL(String(req.url ?? "/"), `http://${host}`);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        assertSameOrigin(req);
      }
      await handleApi(req, res, url, context);
      return;
    }
    await serveStatic(req, res, url, context);
  } catch (error) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // 已经断开。
      }
      return;
    }
    let status = 500;
    let code = "internal";
    let message = "服务器内部错误。";
    let extra = null;
    if (error instanceof WebError || error instanceof BrowseError) {
      status = error instanceof WebError ? error.status : 400;
      code = error.code;
      message = error.message;
      extra = error.extra ?? null;
    } else {
      console.error("[web] 请求处理失败：", error);
      message = `服务器内部错误：${error?.message ?? error}`;
    }
    sendJson(res, status, { error: { code, message, ...(extra ?? {}) } });
  }
}

/** 供 start.js 复用的监听辅助（端口冲突时抛 EADDRINUSE）。 */
export function listenOn(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

// node src/web/server.js 直接启动时转交给 start.js，避免维护两份启动逻辑。
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  void (async () => {
    try {
      const { main } = await import("./start.js");
      process.exitCode = await main(process.argv.slice(2));
    } catch (error) {
      console.error(`[web] 启动失败：${error?.message ?? error}`);
      process.exitCode = 1;
    }
  })();
}
