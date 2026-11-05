#!/usr/bin/env node
/**
 * 命令行入口（历史 Python v4.1 参考实现 的 Node.js 移植）。
 *
 * 设计要点：
 * - 不依赖第三方 argparse 库，手写解析器复刻 Python argparse 的行为：
 *   `organize` / `fix` / `gui`（并新增 `web` 别名）子命令、v3 顶层兼容参数、
 *   `--help`/`--version`、非法参数退出码 2；
 * - ConsoleReporter 精确复刻 Python 的终端输出格式：
 *   `[<phase 右对齐 18>] NNN%  message` 与 `[LEVEL] message`，均写 stderr；
 * - 面向用户的 stdout 文本与 Python 逐字一致；
 * - 无参数 / `gui` / `web` / `--interactive` 启动 Web UI（src/web/start.js），
 *   该模块由 Lead 维护：接口为 `startWebUi({host, port, open, quiet})`。
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { APP_VERSION } from "./constants.js";
import {
  AlbumMode,
  CancelledError,
  ConflictMode,
  DateDivision,
  FixDateOptions,
  InputNotFoundError,
  LivePhotoTarget,
  OperationMode,
  OrganizeOptions,
  Phase,
  TaskContext,
  UnknownDateMode,
  ValidationError,
} from "./models.js";

const PROG = "gpth";

// ---------------------------------------------------------------------------
// 帮助文本
// ---------------------------------------------------------------------------

const ROOT_USAGE =
  "gpth [-h] [--version] [--port PORT] [--host HOST] [--no-open] " +
  "{organize,fix,gui,web} ...";

const ROOT_HELP = `usage: ${ROOT_USAGE}

整理 Google Photos Takeout，并恢复照片/视频的原始修改日期。

positional arguments:
  {organize,fix,gui,web}
    organize            分析并整理 Google Takeout
    fix                 仅修复任意媒体目录的修改日期
    gui                 启动 Web 界面（同 web）
    web                 启动 Web 界面

options:
  -h, --help            show this help message and exit
  --version             show program's version number and exit
  --port PORT           Web 界面监听端口（0 表示自动选择可用端口）
  --host HOST           Web 界面监听地址（默认 127.0.0.1）
  --no-open             启动 Web 界面时不自动打开浏览器

使用 "gpth organize --help" 或 "gpth fix --help" 查看子命令参数。`;

const ORGANIZE_USAGE =
  "gpth organize [-h] -i INPUT -o OUTPUT [--operation {copy,move}]\n" +
  "                     [--albums {shortcut,duplicate-copy,json,nothing}]\n" +
  "                     [--divide {flat,year,year-month}]\n" +
  "                     [--conflict {rename,skip,overwrite}]\n" +
  "                     [--unknown {folder,root,skip}] [--skip-extras] [--no-json]\n" +
  "                     [--no-exif] [--no-filename] [--no-aggressive-json]\n" +
  "                     [--use-mtime] [--no-set-mtime] [--correct-date-filenames]\n" +
  "                     [--no-fallback-scan] [--include-hidden] [--no-report]\n" +
  "                     [--no-hash-cache] [--recognize-live-photos]\n" +
  "                     [--live-photo-target {apple,coloros16}]\n" +
  "                     [--all-photos-folder ALL_PHOTOS]\n" +
  "                     [--unknown-folder DATE_UNKNOWN] [--workers WORKERS]\n" +
  "                     [--dry-run] [--plan-json PLAN_JSON]";

const ORGANIZE_HELP = `usage: ${ORGANIZE_USAGE}

分析并整理 Google Takeout

options:
  -h, --help            show this help message and exit
  -i INPUT, --input INPUT
                        已解压并合并的 Takeout 目录
  -o OUTPUT, --output OUTPUT
                        整理结果目录
  --operation {copy,move}
                        复制会保留输入；移动可节省空间
  --albums {shortcut,duplicate-copy,json,nothing}
  --divide {flat,year,year-month}
  --conflict {rename,skip,overwrite}
  --unknown {folder,root,skip}
  --skip-extras         忽略 edited 等多语言编辑副本
  --no-json             不读取 Takeout JSON sidecar
  --no-exif             不读取图片 EXIF
  --no-filename         不从文件名猜测日期
  --no-aggressive-json  禁用激进 JSON 文件名匹配
  --use-mtime           其它来源失败时使用现有文件修改时间
  --no-set-mtime        输出后不重设修改时间
  --correct-date-filenames
                        按拍摄日期修正完整日期型文件名 YYYY-MM-DD(编号)；保留编号和扩展名
  --no-fallback-scan    没有标准年份目录时不扫描全部媒体
  --include-hidden      包括隐藏文件和目录
  --no-report           不生成结构化运行报告
  --no-hash-cache       不复用未变化文件的 SHA-256 扫描缓存
  --recognize-live-photos
                        按内容识别同目录静态图与动态片段（含误命名为 .mp3 的视频）；真 MP3 不纳入整理
  --live-photo-target {apple,coloros16}
                        后续导入方式；指定此项会自动启用实况识别。两项均输出 Apple 原始双文件，
                        coloros16 需经 O+ 互联
  --all-photos-folder ALL_PHOTOS
                        总照片目录名
  --unknown-folder DATE_UNKNOWN
                        未知日期目录名
  --workers WORKERS     预留并发数（1—32）
  --dry-run             仅分析并展示计划，不写入输出
  --plan-json PLAN_JSON
                        把预览计划导出为 JSON`;

const FIX_USAGE =
  "gpth fix [-h] [--no-recursive] [--no-json] [--no-exif] [--no-filename]\n" +
  "                 [--no-aggressive-json] [--use-mtime] [--include-hidden]\n" +
  "                 [--dry-run] [--correct-date-filenames] PATH";

const FIX_HELP = `usage: ${FIX_USAGE}

仅修复任意媒体目录的修改日期

positional arguments:
  PATH                  需要修复日期的媒体目录

options:
  -h, --help            show this help message and exit
  --no-recursive        只处理目录直属文件
  --no-json
  --no-exif
  --no-filename
  --no-aggressive-json
  --use-mtime
  --include-hidden
  --dry-run             只统计可修复时间和文件名，不写入任何改动
  --correct-date-filenames
                        按拍摄日期修正完整日期型文件名 YYYY-MM-DD(编号)；保留编号和扩展名`;

const WEB_USAGE =
  "gpth {gui,web} [-h] [--port PORT] [--host HOST] [--no-open]";

const WEB_HELP = `usage: ${WEB_USAGE}

启动 Web 界面

options:
  -h, --help            show this help message and exit
  --port PORT           Web 界面监听端口（0 表示自动选择可用端口）
  --host HOST           Web 界面监听地址（默认 127.0.0.1）
  --no-open             启动 Web 界面时不自动打开浏览器`;

const LEGACY_USAGE =
  "gpth [-h] [--fix FIX] [-i INPUT] [-o OUTPUT]\n" +
  "                    [--albums {shortcut,duplicate-copy,json,nothing}]\n" +
  "                    [--divide-to-dates | --no-divide-to-dates]\n" +
  "                    [--skip-extras | --no-skip-extras]\n" +
  "                    [--guess-from-name | --no-guess-from-name]\n" +
  "                    [--copy | --no-copy] [--recognize-live-photos]\n" +
  "                    [--live-photo-target {apple,coloros16}] [--interactive]";

const LEGACY_HELP = `usage: ${LEGACY_USAGE}

v3 参数兼容模式

options:
  -h, --help            show this help message and exit
  --fix FIX
  -i INPUT, --input INPUT
  -o OUTPUT, --output OUTPUT
  --albums {shortcut,duplicate-copy,json,nothing}
  --divide-to-dates, --no-divide-to-dates
  --skip-extras, --no-skip-extras
  --guess-from-name, --no-guess-from-name
  --copy, --no-copy
  --recognize-live-photos
                        识别并成组整理 Apple 实况照片
  --live-photo-target {apple,coloros16}
                        后续导入方式；指定后自动启用实况识别
  --interactive`;

// ---------------------------------------------------------------------------
// 输出与退出码
// ---------------------------------------------------------------------------

function writeStdout(text) {
  process.stdout.write(`${text}\n`);
}

function writeStderr(text) {
  process.stderr.write(`${text}\n`);
}

/** 统一的 argparse 风格错误输出；返回退出码 2。 */
function reportParserError(usage, message) {
  writeStderr(`usage: ${usage}`);
  writeStderr(`${PROG}: error: ${message}`);
  return 2;
}

/** 把 Node 异常转成 Python `str(exc)` 风格的紧凑文本。 */
function errorText(error) {
  if (error === null || error === undefined) {
    return String(error);
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message ? error.message : String(error);
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// 手写 argparse 等价解析器
// ---------------------------------------------------------------------------

/**
 * @typedef {{dest: string, names?: string[], kind?: "flag"|"value",
 *            booleanOptional?: boolean, type?: "string"|"path"|"int",
 *            choices?: string[], default?: any, required?: boolean,
 *            metavar?: string}} OptionSpec
 */

function buildOptionIndex(options) {
  const index = new Map();
  for (const option of options) {
    for (const name of option.names ?? []) {
      index.set(name, { option, flagValue: true });
    }
    if (option.booleanOptional) {
      for (const name of option.names ?? []) {
        if (!name.startsWith("--")) {
          continue;
        }
        index.set(`--no-${name.slice(2)}`, { option, flagValue: false });
      }
    }
  }
  return index;
}

function convertValue(spec, raw, label) {
  let value = raw;
  if (spec.type === "int") {
    if (!/^[+-]?\d+$/.test(String(raw).trim())) {
      return { error: `argument ${label}: invalid int value: '${raw}'` };
    }
    value = Number.parseInt(String(raw).trim(), 10);
  }
  if (spec.choices && !spec.choices.includes(value)) {
    const choices = spec.choices.map((choice) => `'${choice}'`).join(", ");
    return { error: `argument ${label}: invalid choice: '${raw}' (choose from ${choices})` };
  }
  return { value };
}

/** argparse 的“负数看起来像值而不是选项”启发式。 */
function looksLikeNegativeNumber(token) {
  return /^-\d+(?:\.\d+)?$/.test(token);
}

/**
 * 解析一个（子）命令的参数。返回：
 * - `{kind: "ok", values}`：解析成功；
 * - `{kind: "help"}`：遇到 `-h/--help`；
 * - `{kind: "error", message}`：参数错误（调用方打印 usage 并返回 2）。
 */
export function parseArgs(tokens, spec) {
  const options = spec.options ?? [];
  const positionals = spec.positionals ?? [];
  const index = buildOptionIndex(options);
  const values = {};
  for (const option of options) {
    if (Object.prototype.hasOwnProperty.call(option, "default")) {
      values[option.dest] = option.default;
    }
  }
  let positionalIndex = 0;
  for (let cursor = 0; cursor < tokens.length; ) {
    const token = tokens[cursor];
    if (token === "--") {
      for (const rest of tokens.slice(cursor + 1)) {
        if (positionalIndex >= positionals.length) {
          return { kind: "error", message: `unrecognized arguments: ${rest}` };
        }
        const positional = positionals[positionalIndex];
        values[positional.dest] = rest;
        positionalIndex += 1;
      }
      break;
    }
    if (token === "-h" || token === "--help") {
      return { kind: "help" };
    }
    if (token.startsWith("-") && token !== "-" && !looksLikeNegativeNumber(token)) {
      let name = token;
      let inline = null;
      const equals = token.indexOf("=");
      if (equals > 0) {
        name = token.slice(0, equals);
        inline = token.slice(equals + 1);
      }
      const entry = index.get(name);
      if (entry === undefined) {
        return { kind: "error", message: `unrecognized arguments: ${token}` };
      }
      const { option, flagValue } = entry;
      const kind = option.kind ?? (option.booleanOptional ? "flag" : "value");
      if (kind === "flag") {
        if (inline !== null) {
          return {
            kind: "error",
            message: `argument ${name}: ignored explicit argument '${inline}'`,
          };
        }
        values[option.dest] = flagValue;
        cursor += 1;
        continue;
      }
      let raw;
      if (inline !== null) {
        raw = inline;
        cursor += 1;
      } else {
        if (cursor + 1 >= tokens.length) {
          return { kind: "error", message: `argument ${name}: expected one argument` };
        }
        raw = tokens[cursor + 1];
        // argparse：值位置上如果出现另一个已知选项则报“缺少参数”；
        // 负数（如 --workers -1）会被当作值。
        if (
          index.has(raw) ||
          (raw.startsWith("-") && raw !== "-" && !looksLikeNegativeNumber(raw))
        ) {
          return { kind: "error", message: `argument ${name}: expected one argument` };
        }
        cursor += 2;
      }
      const converted = convertValue(option, raw, name);
      if (converted.error !== undefined) {
        return { kind: "error", message: converted.error };
      }
      values[option.dest] = converted.value;
      continue;
    }
    if (positionalIndex >= positionals.length) {
      return { kind: "error", message: `unrecognized arguments: ${token}` };
    }
    const positional = positionals[positionalIndex];
    const converted = convertValue(positional, token, positional.metavar ?? positional.dest);
    if (converted.error !== undefined) {
      return { kind: "error", message: converted.error };
    }
    values[positional.dest] = converted.value;
    positionalIndex += 1;
    cursor += 1;
  }
  const missing = [];
  for (const option of options) {
    if (option.required && values[option.dest] === undefined) {
      missing.push((option.names ?? [option.dest]).join("/"));
    }
  }
  for (const positional of positionals) {
    if (positional.required && values[positional.dest] === undefined) {
      missing.push(positional.metavar ?? positional.dest);
    }
  }
  if (missing.length > 0) {
    return { kind: "error", message: `the following arguments are required: ${missing.join(", ")}` };
  }
  return { kind: "ok", values };
}

// ---------------------------------------------------------------------------
// 子命令参数定义
// ---------------------------------------------------------------------------

const CHOICES = {
  operation: Object.values(OperationMode),
  albums: Object.values(AlbumMode),
  divide: Object.values(DateDivision),
  conflict: Object.values(ConflictMode),
  unknown: Object.values(UnknownDateMode),
  livePhotoTarget: Object.values(LivePhotoTarget),
};

function organizeSpec() {
  return {
    options: [
      { names: ["-i", "--input"], dest: "input", kind: "value", type: "path", required: true, metavar: "INPUT" },
      { names: ["-o", "--output"], dest: "output", kind: "value", type: "path", required: true, metavar: "OUTPUT" },
      { names: ["--operation"], dest: "operation", kind: "value", choices: CHOICES.operation, default: OperationMode.COPY },
      { names: ["--albums"], dest: "albums", kind: "value", choices: CHOICES.albums, default: AlbumMode.SHORTCUT },
      { names: ["--divide"], dest: "divide", kind: "value", choices: CHOICES.divide, default: DateDivision.YEAR_MONTH },
      { names: ["--conflict"], dest: "conflict", kind: "value", choices: CHOICES.conflict, default: ConflictMode.RENAME },
      { names: ["--unknown"], dest: "unknown", kind: "value", choices: CHOICES.unknown, default: UnknownDateMode.FOLDER },
      { names: ["--skip-extras"], dest: "skipExtras", kind: "flag", default: false },
      { names: ["--no-json"], dest: "noJson", kind: "flag", default: false },
      { names: ["--no-exif"], dest: "noExif", kind: "flag", default: false },
      { names: ["--no-filename"], dest: "noFilename", kind: "flag", default: false },
      { names: ["--no-aggressive-json"], dest: "noAggressiveJson", kind: "flag", default: false },
      { names: ["--use-mtime"], dest: "useMtime", kind: "flag", default: false },
      { names: ["--no-set-mtime"], dest: "noSetMtime", kind: "flag", default: false },
      { names: ["--correct-date-filenames"], dest: "correctDateFilenames", kind: "flag", default: false },
      { names: ["--no-fallback-scan"], dest: "noFallbackScan", kind: "flag", default: false },
      { names: ["--include-hidden"], dest: "includeHidden", kind: "flag", default: false },
      { names: ["--no-report"], dest: "noReport", kind: "flag", default: false },
      { names: ["--no-hash-cache"], dest: "noHashCache", kind: "flag", default: false },
      { names: ["--recognize-live-photos"], dest: "recognizeLivePhotos", kind: "flag", default: false },
      { names: ["--live-photo-target"], dest: "livePhotoTarget", kind: "value", choices: CHOICES.livePhotoTarget, default: null },
      { names: ["--all-photos-folder"], dest: "allPhotosFolder", kind: "value", type: "string", default: "ALL_PHOTOS" },
      { names: ["--unknown-folder"], dest: "unknownFolder", kind: "value", type: "string", default: "date-unknown" },
      { names: ["--workers"], dest: "workers", kind: "value", type: "int", default: 4 },
      { names: ["--dry-run"], dest: "dryRun", kind: "flag", default: false },
      { names: ["--plan-json"], dest: "planJson", kind: "value", type: "path", default: null },
    ],
    positionals: [],
  };
}

function fixSpec() {
  return {
    options: [
      { names: ["--no-recursive"], dest: "noRecursive", kind: "flag", default: false },
      { names: ["--no-json"], dest: "noJson", kind: "flag", default: false },
      { names: ["--no-exif"], dest: "noExif", kind: "flag", default: false },
      { names: ["--no-filename"], dest: "noFilename", kind: "flag", default: false },
      { names: ["--no-aggressive-json"], dest: "noAggressiveJson", kind: "flag", default: false },
      { names: ["--use-mtime"], dest: "useMtime", kind: "flag", default: false },
      { names: ["--include-hidden"], dest: "includeHidden", kind: "flag", default: false },
      { names: ["--dry-run"], dest: "dryRun", kind: "flag", default: false },
      { names: ["--correct-date-filenames"], dest: "correctDateFilenames", kind: "flag", default: false },
    ],
    positionals: [{ dest: "path", required: true, metavar: "PATH", type: "path" }],
  };
}

function webSpec() {
  return {
    options: [
      { names: ["--port"], dest: "port", kind: "value", type: "int", default: null },
      { names: ["--host"], dest: "host", kind: "value", type: "string", default: "127.0.0.1" },
      { names: ["--no-open"], dest: "open", kind: "flag", default: true },
    ],
    positionals: [],
  };
}

function legacySpec() {
  return {
    options: [
      { names: ["--fix"], dest: "fix", kind: "value", type: "path", default: null },
      { names: ["-i", "--input"], dest: "input", kind: "value", type: "path", default: null },
      { names: ["-o", "--output"], dest: "output", kind: "value", type: "path", default: null },
      { names: ["--albums"], dest: "albums", kind: "value", choices: CHOICES.albums, default: AlbumMode.SHORTCUT },
      { names: ["--divide-to-dates"], dest: "divideToDates", kind: "flag", booleanOptional: true, default: false },
      { names: ["--skip-extras"], dest: "skipExtras", kind: "flag", booleanOptional: true, default: false },
      { names: ["--guess-from-name"], dest: "guessFromName", kind: "flag", booleanOptional: true, default: true },
      { names: ["--copy"], dest: "copy", kind: "flag", booleanOptional: true, default: false },
      { names: ["--recognize-live-photos"], dest: "recognizeLivePhotos", kind: "flag", default: false },
      { names: ["--live-photo-target"], dest: "livePhotoTarget", kind: "value", choices: CHOICES.livePhotoTarget, default: null },
      { names: ["--interactive"], dest: "interactive", kind: "flag", booleanOptional: true, default: false },
    ],
    positionals: [],
  };
}

/** 顶层解析：命令、`--version`/`--help` 以及 Web 命令的可选参数。 */
function parseRoot(tokens) {
  const web = { host: "127.0.0.1", port: null, open: true };
  let cursor = 0;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === "-h" || token === "--help") {
      return { kind: "help" };
    }
    if (token === "--version") {
      return { kind: "version" };
    }
    if (token === "--port" || token === "--host" || token.startsWith("--port=") || token.startsWith("--host=")) {
      let name = token;
      let raw = null;
      const equals = token.indexOf("=");
      if (equals > 0) {
        name = token.slice(0, equals);
        raw = token.slice(equals + 1);
        cursor += 1;
      } else {
        if (cursor + 1 >= tokens.length) {
          return { kind: "error", message: `argument ${token}: expected one argument` };
        }
        raw = tokens[cursor + 1];
        cursor += 2;
      }
      const converted = convertValue({ type: name === "--port" ? "int" : "string" }, raw, name);
      if (converted.error !== undefined) {
        return { kind: "error", message: converted.error };
      }
      if (name === "--port") {
        web.port = converted.value;
      } else {
        web.host = converted.value;
      }
      continue;
    }
    if (token === "--no-open") {
      web.open = false;
      cursor += 1;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      return { kind: "error", message: `unrecognized arguments: ${token}` };
    }
    return { command: token, rest: tokens.slice(cursor + 1), web };
  }
  return { command: null, rest: [], web };
}

// ---------------------------------------------------------------------------
// ConsoleReporter
// ---------------------------------------------------------------------------

/**
 * 紧凑输出阶段进度，避免每个文件刷满终端（对应 Python ConsoleReporter）。
 *
 * 每 5% 输出一次，格式严格为：
 *   `[<phase 右对齐 18>] NNN%  message`
 */
export class ConsoleReporter {
  constructor() {
    this.lastKey = null;
  }

  progress(update) {
    const total = Number(update.total) || 0;
    const current = Number(update.current) || 0;
    const percent = total ? Math.trunc((current * 100) / total) : 0;
    const key = `${update.phase}|${Math.trunc(percent / 5)}`;
    if (key === this.lastKey) {
      return;
    }
    this.lastKey = key;
    const phaseText = String(update.phase).padStart(18);
    const percentText = String(percent).padStart(3);
    writeStderr(`[${phaseText}] ${percentText}%  ${update.message}`);
  }

  log(level, message) {
    writeStderr(`[${level}] ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 实况照片 CLI 选项
// ---------------------------------------------------------------------------

/** 解析可独立指定的平台参数，并标记是否需要说明自动启用。 */
function resolveLivePhotoCliOptions(args) {
  const rawTarget = args.livePhotoTarget ?? null;
  const explicitTarget = rawTarget !== null && rawTarget !== undefined;
  const target = rawTarget ?? LivePhotoTarget.APPLE;
  const explicitlyEnabled = Boolean(args.recognizeLivePhotos);
  return {
    recognizeLivePhotos: explicitlyEnabled || explicitTarget,
    livePhotoTarget: target,
    targetAutoEnabled: explicitTarget && !explicitlyEnabled,
  };
}

// ---------------------------------------------------------------------------
// 引擎懒加载（保证 --help/--version/参数错误不依赖尚未就绪的模块）
// ---------------------------------------------------------------------------

let engineModulePromise = null;

function loadEngineModule() {
  if (engineModulePromise === null) {
    engineModulePromise = import("./engine.js");
  }
  return engineModulePromise;
}

// ---------------------------------------------------------------------------
// 计划导出与预览文本
// ---------------------------------------------------------------------------

function writePlan(planPath, actions) {
  const rows = actions.map((action) => ({
    kind: action.kind,
    source: action.source ? String(action.source) : null,
    target: action.target ? String(action.target) : null,
    album: action.album,
    bundle_id: action.bundleId,
    live_photo_role: action.livePhotoRole ?? null,
    reason: action.reason,
  }));
  const parent = path.dirname(planPath);
  if (parent && parent !== ".") {
    fs.mkdirSync(parent, { recursive: true });
  }
  fs.writeFileSync(planPath, JSON.stringify(rows, null, 2), "utf8");
}

/** 为终端摘要展示完整配对、扩展名恢复和歧义候选数量。 */
function formatLivePhotoPreview(stats, enabled) {
  if (!enabled) {
    return "，实况照片识别已关闭";
  }
  const pairs = Math.max(Math.trunc(Number(stats.livePhotoPairs) || 0), 0);
  const verified = Math.min(Math.max(Math.trunc(Number(stats.livePhotoMetadataVerified) || 0), 0), pairs);
  const incomplete = Math.max(pairs - verified, 0);
  const repaired = Math.max(Math.trunc(Number(stats.livePhotoRepairedExtensions) || 0), 0);
  const ambiguous = Math.max(Math.trunc(Number(stats.livePhotoAmbiguous) || 0), 0);
  const rejected = Math.max(Math.trunc(Number(stats.livePhotoRejected) || 0), 0);
  const warning = incomplete || ambiguous || rejected ? "，需检查" : "";
  return (
    `，实况照片 ${pairs} 组（Apple 元数据完整 ${verified}/${pairs}，` +
    `不完整 ${incomplete}，后缀恢复 ${repaired}，歧义 ${ambiguous}，` +
    `标识冲突拒绝 ${rejected}${warning}）`
  );
}

function printPreview(analysis, actions) {
  const stats = analysis.statistics;
  const cacheText = analysis.options.useHashCache
    ? `，缓存命中 ${stats.hashCacheHits} / 需计算 ${stats.hashCacheMisses}`
    : "，指纹缓存已关闭";
  const livePhotoText = formatLivePhotoPreview(stats, analysis.options.recognizeLivePhotos);
  writeStdout(
    `预览完成：发现 ${stats.discovered}，重复组 ${stats.duplicateGroups}，` +
      `同来源跳过 ${stats.duplicatesRemoved}，` +
      `编辑副本 ${stats.extrasRemoved}，唯一媒体 ${analysis.media.length}，` +
      `日期未知 ${stats.unknownDates}，计划操作 ${actions.length}` +
      `${cacheText}${livePhotoText}`,
  );
}

function printResult(result) {
  const stats = result.analysis.statistics;
  writeStdout(
    `完成：复制 ${stats.copied}，移动 ${stats.moved}，快捷方式 ${stats.shortcuts}，` +
      `跳过 ${stats.skipped}，失败 ${stats.failed}`,
  );
}

// ---------------------------------------------------------------------------
// organize / fix / legacy 流程
// ---------------------------------------------------------------------------

/**
 * 把运行期异常映射为 CLI 退出码（与 Python cli.py 的 except 分支一致）。
 *
 * - `CancelledError` → 130（"任务已取消"）；
 * - `InputNotFoundError` → 13（organize）/ 11（fix，Python fix_dates 抛 ValueError）；
 * - `ValidationError` → 11；
 * - 其它 → 1（"未处理错误："）。
 *
 * 独立成纯函数便于测试，CLI 行为不变。
 *
 * @param {unknown} error
 * @param {"organize"|"fix"} [mode]
 * @returns {{code: number, message: string}}
 */
export function classifyCliError(error, mode = "organize") {
  if (error instanceof CancelledError) {
    return { code: 130, message: "任务已取消" };
  }
  if (error instanceof InputNotFoundError) {
    return { code: mode === "fix" ? 11 : 13, message: `错误：${errorText(error)}` };
  }
  if (error instanceof ValidationError) {
    return { code: 11, message: `错误：${errorText(error)}` };
  }
  return { code: 1, message: `未处理错误：${errorText(error)}` };
}

async function runOrganize(args) {
  const resolved = resolveLivePhotoCliOptions(args);
  const options = new OrganizeOptions({
    inputDir: args.input,
    outputDir: args.output,
    operation: args.operation,
    albumMode: args.albums,
    dateDivision: args.divide,
    conflictMode: args.conflict,
    unknownDateMode: args.unknown,
    skipExtras: args.skipExtras,
    useJson: !args.noJson,
    useExif: !args.noExif,
    useFilename: !args.noFilename,
    aggressiveJson: !args.noAggressiveJson,
    useFileMtime: args.useMtime,
    setFileMtime: !args.noSetMtime,
    correctDateFilenames: Boolean(args.correctDateFilenames),
    scanAllIfNoTakeout: !args.noFallbackScan,
    includeHidden: args.includeHidden,
    writeReport: !args.noReport,
    useHashCache: !args.noHashCache,
    recognizeLivePhotos: resolved.recognizeLivePhotos,
    livePhotoTarget: resolved.livePhotoTarget,
    allPhotosFolder: args.allPhotosFolder,
    unknownDateFolder: args.unknownFolder,
    workers: args.workers,
  });
  const reporter = new ConsoleReporter();
  if (resolved.targetAutoEnabled) {
    reporter.log(
      "INFO",
      "已因指定后续导入方式自动启用实况照片识别；输出仍为 Apple 原始双文件。",
    );
  }
  const context = new TaskContext({
    progressCallback: (update) => reporter.progress(update),
    logCallback: (level, message) => reporter.log(level, message),
  });
  try {
    const { TakeoutEngine } = await loadEngineModule();
    const engine = new TakeoutEngine();
    const analysis = await engine.analyze(options, context);
    const actions = engine.buildPlan(analysis, context);
    if (args.planJson) {
      writePlan(args.planJson, actions);
    }
    if (args.dryRun) {
      printPreview(analysis, actions);
      return 0;
    }
    const result = await engine.execute(analysis, actions, context);
    printResult(result);
    return result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    const failure = classifyCliError(error, "organize");
    writeStderr(failure.message);
    return failure.code;
  }
}

async function runFix(args) {
  const options = new FixDateOptions({
    inputDir: args.path,
    recursive: !args.noRecursive,
    useJson: !args.noJson,
    useExif: !args.noExif,
    useFilename: !args.noFilename,
    aggressiveJson: !args.noAggressiveJson,
    useFileMtime: args.useMtime,
    dryRun: args.dryRun,
    includeHidden: args.includeHidden,
    correctDateFilenames: Boolean(args.correctDateFilenames),
  });
  const reporter = new ConsoleReporter();
  const context = new TaskContext({
    progressCallback: (update) => reporter.progress(update),
    logCallback: (level, message) => reporter.log(level, message),
  });
  try {
    const { TakeoutEngine } = await loadEngineModule();
    const result = await new TakeoutEngine().fixDates(options, context);
    const renameCount = args.dryRun
      ? Math.trunc(Number(result.renameCandidates) || 0)
      : Math.trunc(Number(result.renamed) || 0);
    writeStdout(
      `扫描 ${result.total} 个媒体；可修复/已修复 ${result.updated}；` +
        `${args.dryRun ? "预计可重命名" : "已重命名"} ${renameCount}；` +
        `无可用日期 ${result.unchanged}；失败 ${result.failed}`,
    );
    return result.failed ? 1 : 0;
  } catch (error) {
    const failure = classifyCliError(error, "fix");
    writeStderr(failure.message);
    return failure.code;
  }
}

function looksLikeLegacy(argv) {
  return argv.some((value) => ["--fix", "--input", "-i", "--output", "-o"].includes(value));
}

async function runLegacy(argv) {
  const parsed = parseArgs(argv, legacySpec());
  if (parsed.kind === "help") {
    writeStdout(LEGACY_HELP);
    return 0;
  }
  if (parsed.kind === "error") {
    return reportParserError(LEGACY_USAGE, parsed.message);
  }
  const args = parsed.values;
  // 与 Python 一致：`--interactive` 任意位置都优先启动界面（main 已提前处理，
  // 这里保留兜底）。
  if (args.interactive) {
    return launchGui({ open: true });
  }
  if (args.fix) {
    const fixArgs = {
      path: args.fix,
      noRecursive: false,
      noJson: false,
      noExif: false,
      noFilename: !args.guessFromName,
      noAggressiveJson: false,
      useMtime: false,
      includeHidden: false,
      dryRun: false,
      correctDateFilenames: false,
    };
    return runFix(fixArgs);
  }
  if (!args.input || !args.output) {
    return reportParserError(LEGACY_USAGE, "整理模式必须同时提供 --input 和 --output");
  }
  const modern = {
    input: args.input,
    output: args.output,
    operation: args.copy ? OperationMode.COPY : OperationMode.MOVE,
    albums: args.albums,
    divide: args.divideToDates ? DateDivision.YEAR_MONTH : DateDivision.FLAT,
    conflict: ConflictMode.RENAME,
    unknown: UnknownDateMode.FOLDER,
    skipExtras: args.skipExtras,
    noJson: false,
    noExif: false,
    noFilename: !args.guessFromName,
    noAggressiveJson: false,
    useMtime: false,
    noSetMtime: false,
    correctDateFilenames: false,
    noFallbackScan: true,
    includeHidden: false,
    noReport: false,
    noHashCache: false,
    recognizeLivePhotos: args.recognizeLivePhotos,
    livePhotoTarget: args.livePhotoTarget,
    allPhotosFolder: "ALL_PHOTOS",
    unknownFolder: "date-unknown",
    workers: 4,
    dryRun: false,
    planJson: null,
  };
  return runOrganize(modern);
}

// ---------------------------------------------------------------------------
// Web UI 启动（src/web/start.js 由 Lead 维护）
// ---------------------------------------------------------------------------

/**
 * 启动 Web UI。
 *
 * 契约（docs/ARCHITECTURE.md 的 Web 架构）：
 *   `startWebUi({ host, port, open, quiet }) -> Promise<{ url, port, server, close }>`
 *
 * 模块尚未就绪时返回退出码 1，并打印清晰的中文错误，而不是抛出堆栈。
 */
export async function launchGui(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? null;
  const open = options.open ?? true;
  const quiet = options.quiet ?? false;
  let startWebUi;
  try {
    const module = await import("./web/start.js");
    startWebUi = module.startWebUi;
    if (typeof startWebUi !== "function") {
      throw new Error("模块 src/web/start.js 未导出 startWebUi");
    }
  } catch (error) {
    writeStderr(
      `无法启动 Web 界面：${errorText(error)}\n` +
        "请确认 Web 界面模块已就绪，或使用 gpth organize / gpth fix 命令行模式。",
    );
    return 1;
  }
  try {
    // 未显式指定端口时交给 startWebUi 的默认策略（默认端口 + 占用顺延）。
    const payload = { host, open, quiet };
    if (port !== null) {
      payload.port = port;
    }
    await startWebUi(payload);
    // HTTP 监听句柄会让进程保持运行；命令本身启动成功即返回 0。
    return 0;
  } catch (error) {
    writeStderr(`无法启动 Web 界面：${errorText(error)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * 解析现代及 v3 兼容参数并返回进程退出码（对应 Python main）。
 *
 * @param {string[]} [argv]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
  const args = (argv ?? []).map((value) => String(value));
  if (args.length === 0) {
    return launchGui({ open: true });
  }
  if (args.length === 1 && (args[0] === "gui" || args[0] === "web")) {
    return launchGui({ open: true });
  }
  if (args.includes("--interactive")) {
    return launchGui({ open: true });
  }
  // 与 Python 一致：非子命令形式且含 v3 顶层参数时优先走兼容模式。
  if (!["organize", "fix", "gui", "web"].includes(args[0]) && looksLikeLegacy(args)) {
    return runLegacy(args);
  }

  const root = parseRoot(args);
  if (root.kind === "help") {
    writeStdout(ROOT_HELP);
    return 0;
  }
  if (root.kind === "version") {
    writeStdout(`${PROG} ${APP_VERSION}`);
    return 0;
  }
  if (root.kind === "error") {
    return reportParserError(ROOT_USAGE, root.message);
  }

  const command = root.command;
  const webOptions = {
    host: root.web.host,
    port: root.web.port,
    open: root.web.open,
  };

  if (command === null) {
    // 仅带 Web 参数（如 `gpth --port 9000`）：启动 Web UI。
    return launchGui(webOptions);
  }

  if (command === "gui" || command === "web") {
    if (root.rest.length > 0 && root.rest[0] === "-h") {
      writeStdout(WEB_HELP);
      return 0;
    }
    const parsed = parseArgs(root.rest, webSpec());
    if (parsed.kind === "help") {
      writeStdout(WEB_HELP);
      return 0;
    }
    if (parsed.kind === "error") {
      return reportParserError(WEB_USAGE, parsed.message);
    }
    return launchGui({
      host: parsed.values.host,
      port: parsed.values.port,
      open: parsed.values.open,
    });
  }

  if (command === "organize") {
    const parsed = parseArgs(root.rest, organizeSpec());
    if (parsed.kind === "help") {
      writeStdout(ORGANIZE_HELP);
      return 0;
    }
    if (parsed.kind === "error") {
      return reportParserError(ORGANIZE_USAGE, parsed.message);
    }
    return runOrganize(parsed.values);
  }

  if (command === "fix") {
    const parsed = parseArgs(root.rest, fixSpec());
    if (parsed.kind === "help") {
      writeStdout(FIX_HELP);
      return 0;
    }
    if (parsed.kind === "error") {
      return reportParserError(FIX_USAGE, parsed.message);
    }
    return runFix(parsed.values);
  }

  // v3 兼容模式：顶层参数没有子命令时按旧版解析。
  if (looksLikeLegacy(args)) {
    return runLegacy(args);
  }
  return reportParserError(
    ROOT_USAGE,
    `argument command: invalid choice: '${command}' (choose from 'organize', 'fix', 'gui', 'web')`,
  );
}

// 供测试/诊断使用：不改变 CLI 行为。
export const __test__ = {
  buildOptionIndex,
  convertValue,
  formatLivePhotoPreview,
  looksLikeLegacy,
  printPreview,
  printResult,
  resolveLivePhotoCliOptions,
  writePlan,
  ORGANIZE_HELP,
  ROOT_HELP,
  FIX_HELP,
  WEB_HELP,
  LEGACY_HELP,
  Phase,
};

// ---------------------------------------------------------------------------
// 直接运行入口
// ---------------------------------------------------------------------------

function isDirectRun() {
  const entry = process.argv[1];
  if (entry === undefined || entry === "") {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    writeStderr(`未处理错误：${errorText(error)}`);
    process.exitCode = 1;
  }
}
