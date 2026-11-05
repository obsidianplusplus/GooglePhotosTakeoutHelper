/**
 * Web UI 启动入口。
 *
 * - `startWebUi({ host, port, open, quiet })`：被 src/cli.js 的 `web`/`gui` 子命令复用；
 * - `node src/web/start.js [--port 8788] [--host 127.0.0.1] [--no-open] [--quiet]`：
 *   直接启动。
 *
 * 默认端口 8788；被占用时依次尝试 +1..+20，仍失败则交给系统分配（port 0）。
 * 返回 { url, port, server, close }。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { APP_DISPLAY_NAME } from "../constants.js";
import { createWebServer, listenOn } from "./server.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const PORT_FALLBACK_RANGE = 20;
const STARTUP_LOG_PREFIX = `${APP_DISPLAY_NAME} 已启动：`;

/** 打印 URL 的展示主机名：绑定通配地址时回退到 127.0.0.1。 */
function displayHost(host) {
  if (!host || host === "0.0.0.0" || host === "::" || host === "::0") {
    return "127.0.0.1";
  }
  return host;
}

/**
 * 依次尝试目标端口；全部占用时用 0（系统分配）。
 * @returns {Promise<number>} 实际监听端口
 */
async function listenWithFallback(server, host, desiredPort) {
  const port = Number(desiredPort);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`端口无效：${desiredPort}`);
  }
  if (port === 0) {
    await listenOn(server, host, 0);
    return server.address().port;
  }
  const lastCandidate = Math.min(port + PORT_FALLBACK_RANGE, 65535);
  for (let candidate = port; candidate <= lastCandidate; candidate += 1) {
    try {
      await listenOn(server, host, candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") {
        throw error;
      }
    }
  }
  await listenOn(server, host, 0);
  return server.address().port;
}

/** 用系统默认浏览器打开 URL；失败静默忽略（headless/无桌面环境）。 */
export function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === "win32") {
    // 空字符串是 `start` 的窗口标题占位参数，避免 URL 里带 & 等字符时被当成标题。
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 打不开浏览器不影响服务本身。
  }
}

/**
 * 启动 Web UI。
 *
 * @param {{host?: string, port?: number, open?: boolean, quiet?: boolean}} [options]
 * @returns {Promise<{url: string, port: number, host: string,
 *   server: import("node:http").Server, manager: object, close: () => Promise<void>}>}
 */
export async function startWebUi({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  open = true,
  quiet = false,
} = {}) {
  const bindHost = host === undefined || host === null || String(host).trim() === ""
    ? DEFAULT_HOST
    : String(host).trim();
  const { server, manager, close } = createWebServer({ quiet });
  let actualPort;
  try {
    actualPort = await listenWithFallback(server, bindHost, port);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  const url = `http://${displayHost(bindHost)}:${actualPort}`;
  if (!quiet) {
    console.log(`${STARTUP_LOG_PREFIX}${url}`);
  }
  if (open) {
    openBrowser(url);
  }
  let closed = false;
  const closeWebUi = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await close();
  };
  return {
    url,
    port: actualPort,
    host: bindHost,
    server,
    manager,
    close: closeWebUi,
  };
}

// ----------------------------------------------------------------------
// 直接运行入口
// ----------------------------------------------------------------------

function parsePortArgument(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

/** 解析 `--port --host --no-open --quiet --help`。 */
export function parseStartArguments(argv = []) {
  const parsed = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    open: true,
    quiet: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] ?? "");
    if (argument === "--no-open") {
      parsed.open = false;
    } else if (argument === "--open") {
      parsed.open = true;
    } else if (argument === "--quiet" || argument === "-q") {
      parsed.quiet = true;
    } else if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--host") {
      parsed.host = argv[index + 1] ?? parsed.host;
      index += 1;
    } else if (argument.startsWith("--host=")) {
      parsed.host = argument.slice("--host=".length);
    } else if (argument === "--port") {
      parsed.port = parsePortArgument(argv[index + 1], parsed.port);
      index += 1;
    } else if (argument.startsWith("--port=")) {
      parsed.port = parsePortArgument(argument.slice("--port=".length), parsed.port);
    }
  }
  return parsed;
}

function printStartUsage() {
  console.log(
    [
      `${APP_DISPLAY_NAME} Web UI`,
      "",
      "用法：node src/web/start.js [选项]",
      "",
      "选项：",
      `  --port <端口>    监听端口（默认 ${DEFAULT_PORT}，被占用时自动顺延）`,
      `  --host <地址>    监听地址（默认 ${DEFAULT_HOST}）`,
      "  --no-open        启动后不自动打开浏览器",
      "  --quiet          不输出启动信息",
      "  -h, --help       显示帮助",
    ].join("\n"),
  );
}

/**
 * 直接运行时的主函数（server.js 也复用）。
 * 返回 0；进程因监听中的 HTTP 服务保持运行，Ctrl+C 优雅关闭。
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseStartArguments(argv);
  if (args.help) {
    printStartUsage();
    return 0;
  }
  const app = await startWebUi({
    host: args.host,
    port: args.port,
    open: args.open,
    quiet: args.quiet,
  });
  const shutdown = () => {
    void app
      .close()
      .catch(() => {})
      .finally(() => {
        process.exit(0);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (!args.quiet) {
    console.log("按 Ctrl+C 停止服务。");
  }
  return 0;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[web] 启动失败：${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
