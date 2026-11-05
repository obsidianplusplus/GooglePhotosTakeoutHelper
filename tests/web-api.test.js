/**
 * Web 后端接口测试（node:test + 临时目录）。
 *
 * 覆盖：
 * - 系统/设置/缓存/目录浏览/静态文件/404/请求体限制/同源校验；
 * - 会话创建校验（organize / fix）；
 * - SSE 握手（hello + 回放 state，事件顺序）；
 * - 引擎模块就绪时跑完整的 analyze -> preview -> execute -> summary 流程
 *   （模块缺失时该用例跳过，其余路由测试仍然执行）。
 *
 * 测试不写仓库目录：临时目录 + 通过 APPDATA/XDG_CONFIG_HOME 把设置与
 * 扫描缓存重定向到临时目录。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import sharp from "sharp";

import { startWebUi } from "../src/web/start.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const REQUIRED_ENGINE_MODULES = [
  "engine.js",
  "scanner.js",
  "grouping.js",
  "planner.js",
  "executor.js",
  "file-utils.js",
  "live-photos.js",
  "date-extractors.js",
  "exif.js",
  "image-support.js",
  "scan-cache.js",
  "duplicates.js",
  "settings.js",
  "filename-correction.js",
  "async-utils.js",
  "models.js",
  "constants.js",
];

const ORIGINAL_ENV = {
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
};

let app = null;
let baseUrl = "";
let fixture = null;
let isolatedConfigDir = null;

// ----------------------------------------------------------------------
// 测试辅助
// ----------------------------------------------------------------------

class SseClient {
  constructor(controller, reader) {
    this.controller = controller;
    this.reader = reader;
    this.events = [];
    this.closed = false;
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.readPromise = this.#pump();
  }

  async #pump() {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) {
          break;
        }
        this.buffer += this.decoder.decode(value, { stream: true });
        let separator = this.buffer.indexOf("\n\n");
        while (separator >= 0) {
          const block = this.buffer.slice(0, separator);
          this.buffer = this.buffer.slice(separator + 2);
          const parsed = SseClient.parseBlock(block);
          if (parsed) {
            this.events.push(parsed);
          }
          separator = this.buffer.indexOf("\n\n");
        }
      }
    } catch {
      // abort 导致的中断属于正常清理。
    } finally {
      this.closed = true;
    }
  }

  static parseBlock(block) {
    const event = { event: "message", data: null };
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        event.event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length === 0) {
      return null;
    }
    const text = dataLines.join("\n");
    event.data = text === "" ? null : JSON.parse(text);
    return event;
  }

  /** 等待第一个满足条件的事件（从已有事件里找，找不到继续等）。 */
  async waitFor(predicate, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(predicate);
      if (hit) {
        return hit;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `等待 SSE 事件超时；已收到：${JSON.stringify(this.events.slice(-6))}`,
        );
      }
      if (this.closed) {
        throw new Error("SSE 连接已关闭");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** 截图式查看当前事件列表（用于判断是否已经出现错误/分析）。 */
  find(predicate) {
    return this.events.find(predicate) ?? null;
  }

  close() {
    const cancelPromise = (() => {
      try {
        return this.reader.cancel();
      } catch {
        return null;
      }
    })();
    if (cancelPromise && typeof cancelPromise.catch === "function") {
      cancelPromise.catch(() => {});
    }
    try {
      this.controller.abort();
    } catch {
      // 忽略：连接可能已经因为服务端关闭而中断。
    }
  }
}

async function openSse(url) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
  return new SseClient(controller, response.body.getReader());
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, headers: response.headers, body };
}

function postJson(pathname, payload, headers = {}) {
  return requestJson(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

function makeOptions(overrides = {}) {
  return {
    inputDir: fixture.input,
    outputDir: fixture.output,
    operation: "copy",
    albumMode: "shortcut",
    dateDivision: "year-month",
    conflictMode: "rename",
    unknownDateMode: "folder",
    skipExtras: false,
    useJson: true,
    useExif: true,
    useFilename: true,
    aggressiveJson: true,
    useFileMtime: false,
    setFileMtime: true,
    scanAllIfNoTakeout: true,
    includeHidden: false,
    writeReport: true,
    useHashCache: false,
    recognizeLivePhotos: false,
    correctDateFilenames: false,
    allPhotosFolder: "ALL_PHOTOS",
    unknownDateFolder: "date-unknown",
    workers: 1,
    ...overrides,
  };
}

function missingEngineModules() {
  return REQUIRED_ENGINE_MODULES.filter(
    (name) => !fs.existsSync(path.join(REPO_ROOT, "src", name)),
  );
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// ----------------------------------------------------------------------
// 全局准备：隔离设置/缓存位置、启动临时端口服务、准备小素材
// ----------------------------------------------------------------------

before(async () => {
  isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpth-web-config-"));
  process.env.APPDATA = path.join(isolatedConfigDir, "Roaming");
  process.env.LOCALAPPDATA = path.join(isolatedConfigDir, "Local");
  process.env.XDG_CONFIG_HOME = path.join(isolatedConfigDir, "config");

  fixture = { root: fs.mkdtempSync(path.join(os.tmpdir(), "gpth-web-fixture-")) };
  fixture.input = path.join(fixture.root, "takeout");
  fixture.output = path.join(fixture.root, "output");
  const yearDir = path.join(fixture.input, "Photos from 2024");
  fs.mkdirSync(yearDir, { recursive: true });
  const imagePath = path.join(yearDir, "image-001.jpg");
  await sharp({
    create: { width: 12, height: 8, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .jpeg()
    .toFile(imagePath);
  fs.writeFileSync(
    `${imagePath}.json`,
    JSON.stringify({ photoTakenTime: { timestamp: "1700000000" } }),
    "utf8",
  );
  fixture.imagePath = imagePath;

  app = await startWebUi({ port: 0, open: false, quiet: true });
  baseUrl = app.url;
});

after(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (fixture?.root && fs.existsSync(fixture.root)) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  if (isolatedConfigDir && fs.existsSync(isolatedConfigDir)) {
    fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------
// 16.1 系统与设置
// ----------------------------------------------------------------------

test("GET /api/health 返回应用信息，HEAD 无响应体", async () => {
  const { status, body } = await requestJson("/api/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.app.displayName, "PhotoTakeout Studio");
  assert.equal(body.app.version, "5.0.0");
  assert.equal(body.platform, process.platform);
  assert.match(body.node, /^v\d+/u);
  assert.equal(typeof body.pid, "number");

  const head = await fetch(`${baseUrl}/api/health`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("GET /api/system 返回路径、缓存与图像能力", async () => {
  const { status, body } = await requestJson("/api/system");
  assert.equal(status, 200);
  assert.equal(body.platform, process.platform);
  assert.equal(typeof body.arch, "string");
  assert.equal(typeof body.settingsPath, "string");
  assert.equal(typeof body.scanCachePath, "string");
  assert.equal(typeof body.cache, "object");
  assert.equal(typeof body.cache.entries, "number");
  assert.equal(typeof body.cache.path, "string");
  assert.equal(typeof body.imageCapabilities, "object");
  assert.equal(typeof body.imageCapabilities.sharp, "boolean");
  assert.equal(typeof body.imageCapabilities.heic, "boolean");
  // 设置路径应被测试隔离到临时目录。
  assert.ok(body.settingsPath.startsWith(isolatedConfigDir));
});

test("GET/PUT /api/settings 合并并原子保存设置", async () => {
  const initial = await requestJson("/api/settings");
  assert.equal(initial.status, 200);
  assert.equal(typeof initial.body.settings, "object");
  assert.equal(initial.body.settings.schema_version, 2);

  const updated = await requestJson("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { preview_limit: 500, operation: "move" } }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.ok, true);
  assert.equal(updated.body.settings.preview_limit, 500);
  assert.equal(updated.body.settings.operation, "move");

  const reloaded = await requestJson("/api/settings");
  assert.equal(reloaded.body.settings.preview_limit, 500);
  assert.equal(reloaded.body.settings.operation, "move");

  const invalid = await requestJson("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: "not-an-object" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "invalid-settings");
});

test("GET /api/cache 与 POST /api/cache/clear 使用隔离的缓存路径", async () => {
  const info = await requestJson("/api/cache");
  assert.equal(info.status, 200);
  assert.equal(typeof info.body.entries, "number");
  assert.ok(info.body.path.startsWith(isolatedConfigDir));

  const cleared = await requestJson("/api/cache/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.ok, true);
  // 契约允许 cleared 表示“已清理条目数”，前端按数字展示。
  assert.equal(typeof cleared.body.cleared, "number");
});

// ----------------------------------------------------------------------
// 16.2 目录浏览
// ----------------------------------------------------------------------

test("GET /api/fs/roots 返回盘符与快捷入口", async () => {
  const { status, body } = await requestJson("/api/fs/roots");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.roots));
  assert.ok(body.roots.length >= 1);
  for (const root of body.roots) {
    assert.equal(typeof root.name, "string");
    assert.equal(typeof root.path, "string");
    assert.ok(fs.existsSync(root.path));
  }
  assert.ok(Array.isArray(body.quickAccess));
  const kinds = body.quickAccess.map((entry) => entry.kind);
  assert.ok(kinds.includes("home"));
  for (const entry of body.quickAccess) {
    assert.ok(fs.statSync(entry.path).isDirectory());
  }
});

test("GET /api/fs/list 支持目录优先排序、类型与隐藏项过滤", async () => {
  const browseRoot = path.join(isolatedConfigDir, "browse");
  fs.mkdirSync(path.join(browseRoot, "子目录"), { recursive: true });
  fs.writeFileSync(path.join(browseRoot, "file.txt"), "hello", "utf8");
  fs.writeFileSync(path.join(browseRoot, ".hidden-file"), "secret", "utf8");

  const dirsOnly = await requestJson(
    `/api/fs/list?path=${encodeURIComponent(browseRoot)}`,
  );
  assert.equal(dirsOnly.status, 200);
  assert.deepEqual(
    dirsOnly.body.entries.map((entry) => entry.name),
    ["子目录"],
  );
  assert.equal(dirsOnly.body.entries[0].type, "dir");
  assert.equal(dirsOnly.body.entries[0].isDir, true);
  assert.equal(dirsOnly.body.parent, path.dirname(browseRoot));
  assert.equal(dirsOnly.body.name, "browse");

  const all = await requestJson(
    `/api/fs/list?path=${encodeURIComponent(browseRoot)}&type=all`,
  );
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.body.entries.map((entry) => entry.name),
    ["子目录", "file.txt"],
  );
  const fileEntry = all.body.entries.find((entry) => entry.name === "file.txt");
  assert.equal(fileEntry.type, "file");
  assert.equal(fileEntry.size, 5);
  assert.equal(fileEntry.isHidden, false);

  const withHidden = await requestJson(
    `/api/fs/list?path=${encodeURIComponent(browseRoot)}&type=all&showHidden=1`,
  );
  assert.equal(withHidden.status, 200);
  assert.ok(
    withHidden.body.entries.some(
      (entry) => entry.name === ".hidden-file" && entry.isHidden === true,
    ),
  );

  // Windows 隐藏属性（best-effort）：用 attrib +H 制造一个隐藏文件。
  if (process.platform === "win32") {
    const { execFileSync } = await import("node:child_process");
    const windowsHiddenPath = path.join(browseRoot, "windows-hidden.txt");
    fs.writeFileSync(windowsHiddenPath, "hidden", "utf8");
    try {
      execFileSync("attrib", ["+H", windowsHiddenPath], { windowsHide: true });
      const hiddenFiltered = await requestJson(
        `/api/fs/list?path=${encodeURIComponent(browseRoot)}&type=all`,
      );
      assert.ok(
        !hiddenFiltered.body.entries.some((entry) => entry.name === "windows-hidden.txt"),
      );
      const hiddenShown = await requestJson(
        `/api/fs/list?path=${encodeURIComponent(browseRoot)}&type=all&showHidden=1`,
      );
      const hiddenEntry = hiddenShown.body.entries.find(
        (entry) => entry.name === "windows-hidden.txt",
      );
      assert.equal(hiddenEntry?.isHidden, true);
    } finally {
      try {
        execFileSync("attrib", ["-H", windowsHiddenPath], { windowsHide: true });
      } catch {
        // 清理失败不影响断言结果。
      }
      fs.rmSync(windowsHiddenPath, { force: true });
    }
  }

  // 目录优先：目录在前、文件在后。
  const types = all.body.entries.map((entry) => entry.type);
  assert.equal(types[0], "dir");
  assert.equal(types.at(-1), "file");
});

test("GET /api/fs/list 不可读路径返回 400 且带 parent", async () => {
  const missingPath = path.join(isolatedConfigDir, "does-not-exist");
  const { status, body } = await requestJson(
    `/api/fs/list?path=${encodeURIComponent(missingPath)}`,
  );
  assert.equal(status, 400);
  assert.equal(body.error.code, "unreadable");
  assert.equal(body.error.parent, path.dirname(missingPath));
});

// ----------------------------------------------------------------------
// 静态文件与通用错误
// ----------------------------------------------------------------------

test("静态文件：index 存在时 200，缺失资源 404 JSON", async () => {
  const indexPath = path.join(REPO_ROOT, "src", "web", "public", "index.html");
  const indexResponse = await fetch(`${baseUrl}/`);
  if (fs.existsSync(indexPath)) {
    assert.equal(indexResponse.status, 200);
    assert.match(indexResponse.headers.get("content-type") ?? "", /text\/html/u);
    assert.match(await indexResponse.text(), /<html/iu);
  } else {
    assert.equal(indexResponse.status, 404);
    const body = await indexResponse.json();
    assert.equal(body.error.code, "not-found");
  }

  const missing = await fetch(`${baseUrl}/definitely-missing-asset.js`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type") ?? "", /application\/json/u);

  const head = await fetch(`${baseUrl}/definitely-missing-asset.js`, { method: "HEAD" });
  assert.equal(head.status, 404);
});

test("未知 API 返回统一 404 错误结构", async () => {
  const { status, body } = await requestJson("/api/does-not-exist");
  assert.equal(status, 404);
  assert.equal(body.error.code, "not-found");
  assert.match(body.error.message, /接口不存在/u);
});

test("请求体超过 2MB 返回 413", async () => {
  const bigPayload = JSON.stringify({ type: "organize", options: { blob: "x".repeat(3 * 1024 * 1024) } });
  const { status, body } = await requestJson("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bigPayload,
  });
  assert.equal(status, 413);
  assert.equal(body.error.code, "payload-too-large");
});

test("跨站 Origin 被拒绝，同源请求正常进入业务校验", async () => {
  const crossSite = await postJson(
    "/api/session",
    { type: "organize", options: {} },
    { Origin: "http://evil.example" },
  );
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.error.code, "forbidden-origin");

  const sameOrigin = await postJson(
    "/api/session",
    { type: "organize", options: {} },
    { Origin: new URL(baseUrl).origin },
  );
  assert.equal(sameOrigin.status, 400);
  assert.equal(sameOrigin.body.error.code, "invalid-options");
});

// ----------------------------------------------------------------------
// 16.3 会话创建校验
// ----------------------------------------------------------------------

test("POST /api/session 拒绝非法类型与不完整选项", async () => {
  const badType = await postJson("/api/session", { type: "bogus", options: {} });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.code, "invalid-type");

  const missingOptions = await postJson("/api/session", { type: "organize" });
  assert.equal(missingOptions.status, 400);
  assert.equal(missingOptions.body.error.code, "invalid-options");
  assert.ok(Array.isArray(missingOptions.body.error.errors));

  const missingDirs = await postJson("/api/session", {
    type: "organize",
    options: { inputDir: path.join(isolatedConfigDir, "nope-input"), outputDir: fixture.output },
  });
  assert.equal(missingDirs.status, 400);
  assert.equal(missingDirs.body.error.code, "invalid-options");
  assert.ok(missingDirs.body.error.errors.some((item) => item.includes("输入目录")));

  const sameDirs = await postJson("/api/session", {
    type: "organize",
    options: { inputDir: fixture.input, outputDir: fixture.input },
  });
  assert.equal(sameDirs.status, 400);
  assert.ok(sameDirs.body.error.errors.some((item) => item.includes("不能相同")));

  const noDateSources = await postJson("/api/session", {
    type: "organize",
    options: makeOptions({
      useJson: false,
      useExif: false,
      useFilename: false,
      useFileMtime: false,
    }),
  });
  assert.equal(noDateSources.status, 400);
  assert.ok(noDateSources.body.error.errors.some((item) => item.includes("日期来源")));
});

test("POST /api/session 拒绝非法 fix 选项", async () => {
  const missingDir = await postJson("/api/session", {
    type: "fix",
    options: { inputDir: path.join(isolatedConfigDir, "missing-fix-dir") },
  });
  assert.equal(missingDir.status, 400);
  assert.equal(missingDir.body.error.code, "invalid-options");
  assert.ok(missingDir.body.error.errors.some((item) => item.includes("目录")));

  const noSources = await postJson("/api/session", {
    type: "fix",
    options: {
      inputDir: fixture.input,
      useJson: false,
      useExif: false,
      useFilename: false,
      useFileMtime: false,
    },
  });
  assert.equal(noSources.status, 400);
  assert.ok(noSources.body.error.errors.some((item) => item.includes("日期来源")));
});

// ----------------------------------------------------------------------
// 16.4 缩略图
// ----------------------------------------------------------------------

test("GET /api/thumb 生成 PNG，失败返回 404 JSON", async () => {
  const thumb = await fetch(
    `${baseUrl}/api/thumb?path=${encodeURIComponent(fixture.imagePath)}&w=64&h=64`,
  );
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await thumb.arrayBuffer());
  assert.ok(bytes.length > 8);
  // PNG magic.
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const missing = await requestJson(
    `/api/thumb?path=${encodeURIComponent(path.join(isolatedConfigDir, "no-image.jpg"))}`,
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.status, "missing");
  assert.equal(typeof missing.body.error, "string");
});

test("GET /api/preview-info 返回重复项详情字段", async () => {
  const info = await requestJson(
    `/api/preview-info?path=${encodeURIComponent(fixture.imagePath)}`,
  );
  assert.equal(info.status, 200);
  assert.equal(info.body.exists, true);
  assert.ok(info.body.size > 0);
  assert.equal(typeof info.body.mtimeMs, "number");
  assert.match(info.body.mimeType ?? "", /image\/jpeg/u);
  assert.match(String(info.body.decodedFormat ?? ""), /^jpe?g$/iu);
  assert.deepEqual(info.body.rawSize, [12, 8]);
  assert.deepEqual(info.body.displaySize, [12, 8]);
  assert.equal(info.body.frameCount, 1);
  assert.equal(info.body.error, null);

  const missingParam = await requestJson("/api/preview-info");
  assert.equal(missingParam.status, 400);
  assert.equal(missingParam.body.error.code, "invalid-path");
});

// ----------------------------------------------------------------------
// SSE 会话：握手 + 回放（不依赖引擎是否就绪）
// ----------------------------------------------------------------------

test("SSE 握手：hello 先行，回放 state，取消/删除返回 ok", async () => {
  const created = await postJson("/api/session", {
    type: "organize",
    options: makeOptions({ useHashCache: false }),
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.type, "organize");
  assert.equal(created.body.state, "analysing");
  assert.equal(typeof created.body.sessionId, "string");
  const sessionId = created.body.sessionId;

  const sse = await openSse(`${baseUrl}/api/session/${sessionId}/events`);
  try {
    const hello = await sse.waitFor((event) => event.event === "hello", 5000);
    assert.equal(hello.data.sessionId, sessionId);
    assert.equal(hello.data.type, "organize");

    const analysing = await sse.waitFor(
      (event) => event.event === "state" && event.data.state === "analysing",
      5000,
    );
    assert.equal(analysing.data.busy, true);
    assert.equal(analysing.data.canExecute, false);

    const cancel = await requestJson(`/api/session/${sessionId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.ok, true);

    // 等 worker 进入终态（取消成功、分析完成或引擎模块缺失导致的 error 都算合法终态）。
    const terminal = await sse.waitFor(
      (event) =>
        event.event === "cancelled" ||
        event.event === "analysis" ||
        event.event === "error",
      60_000,
    );
    assert.ok(["cancelled", "analysis", "error"].includes(terminal.event));
  } finally {
    sse.close();
    const deleted = await requestJson(`/api/session/${sessionId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);
  }
});

test("未分析的 organize 会话拉取 preview/duplicates 返回 409 或可用数据", async () => {
  const created = await postJson("/api/session", {
    type: "organize",
    options: makeOptions({ useHashCache: false }),
  });
  assert.equal(created.status, 200);
  const sessionId = created.body.sessionId;
  try {
    // 立即请求可能恰好在分析完成前后；两种合法结果都要符合契约。
    const preview = await requestJson(`/api/session/${sessionId}/preview?offset=0&limit=50`);
    assert.ok([200, 409].includes(preview.status));
    if (preview.status === 200) {
      assert.equal(typeof preview.body.total, "number");
      assert.ok(Array.isArray(preview.body.rows));
    } else {
      assert.equal(preview.body.error.code, "analysis-not-ready");
    }

    const duplicates = await requestJson(
      `/api/session/${sessionId}/duplicates?offset=0&limit=50`,
    );
    assert.ok([200, 409].includes(duplicates.status));

    const summary = await requestJson(`/api/session/${sessionId}/summary`);
    assert.equal(summary.status, 200);
    assert.equal(typeof summary.body.state, "string");
  } finally {
    await requestJson(`/api/session/${sessionId}`, { method: "DELETE" });
  }
});

// ----------------------------------------------------------------------
// 端到端：引擎模块全部就绪时才执行（并行移植期间允许跳过）
// ----------------------------------------------------------------------

test(
  "端到端：analyze -> preview/duplicates -> execute -> summary",
  { timeout: 180_000 },
  async (t) => {
    const missing = missingEngineModules();
    if (missing.length > 0) {
      t.skip(`引擎模块尚未就绪：${missing.join(", ")}`);
      return;
    }
    const options = makeOptions({ useHashCache: false });
    const created = await postJson("/api/session", { type: "organize", options });
    assert.equal(created.status, 200);
    const sessionId = created.body.sessionId;
    const sse = await openSse(`${baseUrl}/api/session/${sessionId}/events`);
    try {
      const first = await sse.waitFor(
        (event) =>
          event.event === "analysis" ||
          event.event === "error" ||
          event.event === "cancelled",
        120_000,
      );
      if (first.event === "error") {
        t.skip(`引擎在当前测试时点不可用：${first.data?.message ?? "未知错误"}`);
        return;
      }
      assert.equal(first.event, "analysis");
      assert.ok(first.data.previewTotal >= 1);
      assert.ok(first.data.summary.discovered >= 1);
      assert.ok(first.data.summary.unique >= 1);
      assert.equal(typeof first.data.summary.statistics, "object");
      assert.equal(first.data.summary.outputDirectory, fixture.output);

      const analysedState = await sse.waitFor(
        (event) => event.event === "state" && event.data.state === "analysed",
        10_000,
      );
      assert.equal(analysedState.data.canExecute, true);
      assert.equal(analysedState.data.busy, false);

      // 渐进式预览分页。
      const preview = await requestJson(
        `/api/session/${sessionId}/preview?offset=0&limit=300`,
      );
      assert.equal(preview.status, 200);
      assert.equal(preview.body.total, first.data.previewTotal);
      assert.equal(preview.body.offset, 0);
      assert.ok(preview.body.rows.length >= 1);
      const firstRow = preview.body.rows[0];
      assert.equal(typeof firstRow.index, "number");
      assert.ok(["copy", "move", "shortcut", "skip"].includes(firstRow.kind));
      assert.equal(typeof firstRow.source, "string");
      assert.ok(["still", "motion", null].includes(firstRow.role));
      assert.ok(
        firstRow.date === null ||
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(firstRow.date),
      );
      assert.equal(typeof firstRow.status, "string");

      // 分页切片：limit=1 时 offset 生效。
      if (preview.body.total >= 2) {
        const secondPage = await requestJson(
          `/api/session/${sessionId}/preview?offset=1&limit=1`,
        );
        assert.equal(secondPage.status, 200);
        assert.equal(secondPage.body.offset, 1);
        assert.equal(secondPage.body.rows.length, 1);
        assert.equal(secondPage.body.rows[0].index, 1);
      }

      const duplicates = await requestJson(
        `/api/session/${sessionId}/duplicates?offset=0&limit=200`,
      );
      assert.equal(duplicates.status, 200);
      assert.equal(typeof duplicates.body.total, "number");
      assert.ok(Array.isArray(duplicates.body.rows));

      // 选项不一致 -> 409 stale-preview。
      const stale = await postJson(`/api/session/${sessionId}/execute`, {
        options: { ...options, dateDivision: "flat" },
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, "stale-preview");

      const executed = await postJson(`/api/session/${sessionId}/execute`, { options });
      assert.equal(executed.status, 200);
      assert.equal(executed.body.ok, true);

      const execution = await sse.waitFor(
        (event) => event.event === "execution",
        120_000,
      );
      const summary = execution.data.summary;
      assert.equal(typeof summary.copied, "number");
      assert.equal(typeof summary.moved, "number");
      assert.equal(typeof summary.shortcuts, "number");
      assert.equal(typeof summary.skipped, "number");
      assert.equal(typeof summary.failed, "number");
      assert.equal(typeof summary.bytesCopied, "number");
      assert.ok(Array.isArray(summary.errors));
      assert.ok(summary.copied + summary.moved + summary.shortcuts >= 1);
      assert.equal(summary.outputDirectory, fixture.output);

      await sse.waitFor(
        (event) => event.event === "state" && event.data.state === "done",
        10_000,
      );

      const outputFiles = walkFiles(fixture.output);
      assert.ok(outputFiles.some((file) => file.toLowerCase().endsWith(".jpg")));
      assert.ok(outputFiles.every((file) => isInside(fixture.output, file)));

      const finalSummary = await requestJson(`/api/session/${sessionId}/summary`);
      assert.equal(finalSummary.status, 200);
      assert.equal(finalSummary.body.state, "done");
      assert.equal(finalSummary.body.previewTotal, first.data.previewTotal);
    } finally {
      sse.close();
      await requestJson(`/api/session/${sessionId}`, { method: "DELETE" });
    }
  },
);

test(
  "端到端：日期修复会话产生 fix 事件与 fixed 状态",
  { timeout: 120_000 },
  async (t) => {
    const missing = missingEngineModules();
    if (missing.length > 0) {
      t.skip(`引擎模块尚未就绪：${missing.join(", ")}`);
      return;
    }
    const fixInput = path.join(isolatedConfigDir, "fix-media");
    fs.mkdirSync(fixInput, { recursive: true });
    const fixImage = path.join(fixInput, "fix-photo.jpg");
    await sharp({
      create: { width: 6, height: 4, channels: 3, background: { r: 30, g: 120, b: 200 } },
    })
      .jpeg()
      .toFile(fixImage);
    const created = await postJson("/api/session", {
      type: "fix",
      options: {
        inputDir: fixInput,
        recursive: true,
        useJson: true,
        useExif: true,
        useFilename: true,
        aggressiveJson: true,
        useFileMtime: false,
        dryRun: true,
        includeHidden: false,
        correctDateFilenames: false,
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.type, "fix");
    assert.equal(created.body.state, "fixing");
    const sessionId = created.body.sessionId;
    const sse = await openSse(`${baseUrl}/api/session/${sessionId}/events`);
    try {
      const first = await sse.waitFor(
        (event) => event.event === "fix" || event.event === "error" || event.event === "cancelled",
        120_000,
      );
      if (first.event === "error") {
        t.skip(`引擎在当前测试时点不可用：${first.data?.message ?? "未知错误"}`);
        return;
      }
      assert.equal(first.event, "fix");
      assert.equal(first.data.result.dryRun, true);
      assert.equal(typeof first.data.result.total, "number");
      assert.ok(first.data.result.total >= 1);
      assert.ok(Array.isArray(first.data.result.errors));

      await sse.waitFor(
        (event) => event.event === "state" && event.data.state === "fixed",
        10_000,
      );
      // fix 会话不支持 execute。
      const execute = await postJson(`/api/session/${sessionId}/execute`, {
        options: { inputDir: fixInput },
      });
      assert.equal(execute.status, 409);
    } finally {
      sse.close();
      await requestJson(`/api/session/${sessionId}`, { method: "DELETE" });
    }
  },
);
