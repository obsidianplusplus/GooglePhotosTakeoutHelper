/**
 * 执行层（executor）/ 编排层（engine）/ CLI 的集成测试。
 *
 * 全部使用系统临时目录，不触碰仓库根目录；CLI 场景通过
 * `child_process.spawnSync(process.execPath, ...)` 以真实进程验证退出码与输出。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import { classifyCliError } from "../src/cli.js";
import { DEFAULT_REPORT_NAME, ALBUM_INFO_NAME } from "../src/constants.js";
import { TakeoutEngine } from "../src/engine.js";
import { executePlan } from "../src/executor.js";
import {
  ActionKind,
  ActionStatus,
  AlbumMode,
  AnalysisResult,
  CancelledError,
  ConflictMode,
  DateDivision,
  FixDateOptions,
  InputNotFoundError,
  LivePhotoMetadataStatus,
  LivePhotoRole,
  MediaRecord,
  OperationMode,
  OrganizeOptions,
  Phase,
  PlanAction,
  RunStatistics,
  TaskContext,
  UnknownDateMode,
  ValidationError,
} from "../src/models.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TESTS_DIR, "..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "cli.js");

const TEMP_ROOTS = [];

after(() => {
  for (const root of TEMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 上偶发占用时忽略清理失败。
    }
  }
});

function makeTempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gpth-exec-${label}-`));
  TEMP_ROOTS.push(root);
  return root;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function walkRelative(root) {
  const output = [];
  const stack = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop();
    const absoluteDir = path.join(root, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(relative);
      } else {
        output.push(relative);
      }
    }
  }
  return output.sort();
}

function mtimeSeconds(filePath) {
  return fs.statSync(filePath).mtimeMs / 1000;
}

function localDate(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function makeContext() {
  const progress = [];
  const logs = [];
  const context = new TaskContext({
    progressCallback: (update) => progress.push(update),
    logCallback: (level, message) => logs.push([level, message]),
  });
  return { context, progress, logs };
}

function makeMediaRecord(source, { album = null, dateTaken = null } = {}) {
  const record = new MediaRecord(new Map([[album, source]]));
  if (dateTaken !== null) {
    record.dateTaken = dateTaken;
  }
  return record;
}

function makeExecutorAnalysis(outputDir, optionOverrides = {}, analysisInit = {}) {
  const options = new OrganizeOptions({
    inputDir: path.dirname(outputDir),
    outputDir,
    ...optionOverrides,
  });
  return new AnalysisResult({
    options,
    media: analysisInit.media ?? [],
    statistics: new RunStatistics(),
    duplicateGroups: analysisInit.duplicateGroups ?? [],
  });
}

function makeAction(init) {
  const {
    kind,
    source = null,
    target = null,
    media = null,
    album = null,
    reason = "",
    bundleId = null,
    livePhotoRole = null,
    fallbackSource = null,
    fallbackTarget = null,
    sizeBytes = null,
  } = init;
  const record = media ?? makeMediaRecord(source, { album });
  return new PlanAction({
    kind,
    source,
    target,
    media: record,
    album,
    reason,
    bundleId,
    livePhotoRole,
    fallbackSource,
    fallbackTarget,
    sizeBytes,
  });
}

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error ?? null,
  };
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

test("executor: COPY/SKIP 与单文件失败隔离，并写出运行报告", async () => {
  const root = makeTempRoot("exec-basic");
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const first = path.join(input, "a.jpg");
  const second = path.join(input, "b.jpg");
  const third = path.join(input, "c.jpg");
  writeFile(first, "AAA");
  writeFile(second, "BBB");
  writeFile(third, "CCC");
  const missing = path.join(input, "missing.jpg");

  const analysis = makeExecutorAnalysis(output);
  const actions = [
    makeAction({ kind: ActionKind.COPY, source: first, target: path.join(output, "a.jpg") }),
    makeAction({ kind: ActionKind.SKIP, source: second, reason: "日期未知，按设置跳过" }),
    makeAction({ kind: ActionKind.COPY, source: missing, target: path.join(output, "missing.jpg") }),
    makeAction({ kind: ActionKind.COPY, source: third, target: path.join(output, "c.jpg") }),
  ];
  const { context, progress, logs } = makeContext();
  const result = await executePlan(analysis, actions, context);

  assert.equal(result.analysis, analysis);
  assert.equal(result.actions, actions);
  assert.equal(fs.readFileSync(path.join(output, "a.jpg"), "utf8"), "AAA");
  assert.equal(fs.readFileSync(path.join(output, "c.jpg"), "utf8"), "CCC");
  assert.equal(fs.existsSync(path.join(output, "missing.jpg")), false);

  assert.equal(analysis.statistics.copied, 2);
  assert.equal(analysis.statistics.skipped, 1);
  assert.equal(analysis.statistics.failed, 1);
  assert.equal(analysis.statistics.moved, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^处理 .*missing\.jpg → .*missing\.jpg 失败：/);

  assert.equal(actions[0].status, ActionStatus.SUCCESS);
  assert.equal(actions[0].actualKind, ActionKind.COPY);
  assert.equal(actions[1].status, ActionStatus.SKIPPED);
  assert.equal(actions[1].actualKind, ActionKind.SKIP);
  assert.equal(actions[2].status, ActionStatus.FAILED);
  assert.ok(actions[2].error.length > 0);
  assert.equal(actions[3].status, ActionStatus.SUCCESS);
  assert.ok(actions[3].error === "");

  // 输出目录锁在结束时被释放。
  assert.equal(fs.existsSync(path.join(output, ".gpth-task.lock")), false);
  // 进度与日志文本和 Python 一致。
  assert.ok(progress.some((update) => update.message === "正在处理：a.jpg"));
  assert.ok(progress.some((update) => update.message === "已处理 4/4"));
  assert.equal(progress[progress.length - 1].message, "整理完成");
  assert.equal(progress[progress.length - 1].phase, Phase.FINISHED);
  assert.ok(logs.some(([level, message]) => level === "ERROR" && /失败：/.test(message)));

  const report = readJson(path.join(output, DEFAULT_REPORT_NAME));
  assert.equal(report.version, 1);
  assert.equal(report.options.input_dir, analysis.options.inputDir);
  assert.equal(report.options.operation, "copy");
  assert.equal(report.statistics.copied, 2);
  assert.equal(report.statistics.skipped, 1);
  assert.equal(report.statistics.failed, 1);
  assert.equal(report.actions.length, 4);
  assert.deepEqual(
    report.actions.map((action) => [action.planned_kind, action.status]),
    [
      ["copy", "success"],
      ["skip", "skipped"],
      ["copy", "failed"],
      ["copy", "success"],
    ],
  );
  assert.equal(report.actions[1].target, null);
  assert.equal(report.actions[1].actual_kind, "skip");
  assert.equal(report.actions[3].error, null);
  assert.ok(Array.isArray(report.errors));
  assert.equal(report.errors.length, 1);
  assert.equal(typeof report.statistics.started_at, "string");
  assert.match(
    report.statistics.started_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{6})?$/,
  );
});

test("executor: 已知日期写入提取 mtime，未知日期保留源文件 mtime", async () => {
  const root = makeTempRoot("exec-mtime");
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const dated = path.join(input, "dated.jpg");
  const undated = path.join(input, "undated.jpg");
  writeFile(dated, "D");
  writeFile(undated, "U");
  const sourceMtime = localDate(2001, 2, 3, 4, 5, 6);
  fs.utimesSync(dated, sourceMtime, sourceMtime);
  fs.utimesSync(undated, sourceMtime, sourceMtime);

  const takenAt = localDate(2020, 1, 2, 3, 4, 5);
  const analysis = makeExecutorAnalysis(output);
  const actions = [
    makeAction({
      kind: ActionKind.COPY,
      source: dated,
      target: path.join(output, "dated.jpg"),
      media: makeMediaRecord(dated, { dateTaken: takenAt }),
    }),
    makeAction({
      kind: ActionKind.COPY,
      source: undated,
      target: path.join(output, "undated.jpg"),
      media: makeMediaRecord(undated),
    }),
  ];
  const { context } = makeContext();
  await executePlan(analysis, actions, context);

  assert.ok(Math.abs(mtimeSeconds(path.join(output, "dated.jpg")) - takenAt.getTime() / 1000) < 2);
  assert.ok(
    Math.abs(mtimeSeconds(path.join(output, "undated.jpg")) - sourceMtime.getTime() / 1000) < 2,
  );
});

test("executor: 实况照片 COPY 成组输出、报告与 mtime", async () => {
  const root = makeTempRoot("exec-live-copy");
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const still = path.join(input, "IMG_0001.HEIC");
  const motion = path.join(input, "IMG_0001.MOV");
  writeFile(still, "STILL");
  writeFile(motion, "MOTION");
  const takenAt = localDate(2020, 1, 2, 3, 4, 5);

  const media = new MediaRecord(new Map([[null, still]]), {
    dateTaken: takenAt,
    livePhotoCompanions: new Map([[null, motion]]),
    livePhotoMetadata: new Map([[null, LivePhotoMetadataStatus.VERIFIED]]),
    livePhotoEvidence: new Map([[null, "同目录同名，Apple 内容标识与关键帧元数据已验证"]]),
    livePhotoRepairedSuffix: new Map([[null, false]]),
  });
  const analysis = makeExecutorAnalysis(output, {}, { media: [media] });
  const stillTarget = path.join(output, "ALL_PHOTOS", "2020", "01", "IMG_0001.HEIC");
  const motionTarget = path.join(output, "ALL_PHOTOS", "2020", "01", "IMG_0001.MOV");
  const actions = [
    makeAction({
      kind: ActionKind.COPY,
      source: still,
      target: stillTarget,
      media,
      bundleId: "live-photo-000001",
      livePhotoRole: LivePhotoRole.STILL,
      sizeBytes: 5,
    }),
    makeAction({
      kind: ActionKind.COPY,
      source: motion,
      target: motionTarget,
      media,
      bundleId: "live-photo-000001",
      livePhotoRole: LivePhotoRole.MOTION,
      sizeBytes: 6,
    }),
  ];
  const { context, progress } = makeContext();
  const result = await executePlan(analysis, actions, context);

  assert.equal(result.errors.length, 0);
  assert.equal(fs.readFileSync(stillTarget, "utf8"), "STILL");
  assert.equal(fs.readFileSync(motionTarget, "utf8"), "MOTION");
  assert.equal(analysis.statistics.copied, 2);
  assert.equal(analysis.statistics.moved, 0);
  assert.equal(analysis.statistics.bytesCopied, 11);
  assert.equal(actions[0].status, ActionStatus.SUCCESS);
  assert.equal(actions[1].status, ActionStatus.SUCCESS);
  assert.ok(progress.some((update) => update.message === "正在成组处理实况照片：IMG_0001.HEIC"));
  assert.ok(progress.some((update) => update.message === "已处理 2/2"));

  assert.ok(Math.abs(mtimeSeconds(stillTarget) - takenAt.getTime() / 1000) < 2);
  assert.ok(Math.abs(mtimeSeconds(motionTarget) - takenAt.getTime() / 1000) < 2);

  const report = readJson(path.join(output, DEFAULT_REPORT_NAME));
  assert.equal(report.live_photos.length, 1);
  const livePhoto = report.live_photos[0];
  assert.equal(livePhoto.album, null);
  assert.equal(livePhoto.still, still);
  assert.equal(livePhoto.motion, motion);
  assert.equal(livePhoto.metadata_status, "verified");
  assert.equal(livePhoto.repaired_suffix, false);
  assert.equal(livePhoto.date, "2020-01-02T03:04:05");
  assert.equal(report.actions[0].bundle_id, "live-photo-000001");
  assert.equal(report.actions[0].live_photo_role, "still");
  assert.equal(report.actions[1].live_photo_role, "motion");
});

test("executor: 实况照片 MOVE 成组输出后退役源文件", async () => {
  const root = makeTempRoot("exec-live-move");
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const still = path.join(input, "IMG_0002.HEIC");
  const motion = path.join(input, "IMG_0002.MOV");
  writeFile(still, "STILL2");
  writeFile(motion, "MOTION2");

  const media = new MediaRecord(new Map([[null, still]]), {
    livePhotoCompanions: new Map([[null, motion]]),
    livePhotoMetadata: new Map([[null, LivePhotoMetadataStatus.MISSING]]),
    livePhotoEvidence: new Map([[null, "同目录同名且含视频轨；Apple 配对元数据缺失或不可读"]]),
    livePhotoRepairedSuffix: new Map([[null, false]]),
  });
  const analysis = makeExecutorAnalysis(output, { operation: OperationMode.MOVE }, { media: [media] });
  const stillTarget = path.join(output, "ALL_PHOTOS", "IMG_0002.HEIC");
  const motionTarget = path.join(output, "ALL_PHOTOS", "IMG_0002.MOV");
  const actions = [
    makeAction({
      kind: ActionKind.MOVE,
      source: still,
      target: stillTarget,
      media,
      bundleId: "live-photo-000002",
      livePhotoRole: LivePhotoRole.STILL,
    }),
    makeAction({
      kind: ActionKind.MOVE,
      source: motion,
      target: motionTarget,
      media,
      bundleId: "live-photo-000002",
      livePhotoRole: LivePhotoRole.MOTION,
    }),
  ];
  const { context } = makeContext();
  const result = await executePlan(analysis, actions, context);

  assert.equal(result.errors.length, 0);
  assert.equal(analysis.statistics.moved, 2);
  assert.equal(analysis.statistics.copied, 0);
  assert.equal(actions[0].actualKind, ActionKind.MOVE);
  assert.equal(actions[1].actualKind, ActionKind.MOVE);
  assert.equal(fs.existsSync(still), false);
  assert.equal(fs.existsSync(motion), false);
  assert.equal(fs.readFileSync(stillTarget, "utf8"), "STILL2");
  assert.equal(fs.readFileSync(motionTarget, "utf8"), "MOTION2");
});

test("executor: 实况照片成组失败时两半一起标记失败", async () => {
  const root = makeTempRoot("exec-live-fail");
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const still = path.join(input, "IMG_0003.HEIC");
  const missingMotion = path.join(input, "IMG_0003.MOV");
  writeFile(still, "STILL3");

  const media = new MediaRecord(new Map([[null, still]]), {
    livePhotoCompanions: new Map([[null, missingMotion]]),
  });
  const analysis = makeExecutorAnalysis(output, {}, { media: [media] });
  const actions = [
    makeAction({
      kind: ActionKind.COPY,
      source: still,
      target: path.join(output, "IMG_0003.HEIC"),
      media,
      bundleId: "live-photo-000003",
      livePhotoRole: LivePhotoRole.STILL,
    }),
    makeAction({
      kind: ActionKind.COPY,
      source: missingMotion,
      target: path.join(output, "IMG_0003.MOV"),
      media,
      bundleId: "live-photo-000003",
      livePhotoRole: LivePhotoRole.MOTION,
    }),
  ];
  const { context, logs } = makeContext();
  const result = await executePlan(analysis, actions, context);

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^成组处理实况照片 .* 失败：/);
  assert.equal(analysis.statistics.failed, 2);
  assert.equal(analysis.statistics.copied, 0);
  assert.ok(actions.every((action) => action.status === ActionStatus.FAILED));
  assert.equal(fs.existsSync(path.join(output, "IMG_0003.HEIC")), false);
  assert.equal(fs.existsSync(path.join(output, "IMG_0003.MOV")), false);
  assert.ok(logs.some(([level, message]) => level === "ERROR" && /成组处理实况照片/.test(message)));
});

test("executor: 相册 JSON 模式下 basename 重名升级为相对路径键", async () => {
  const root = makeTempRoot("exec-album");
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const firstSource = path.join(input, "album-one.jpg");
  const secondSource = path.join(input, "album-two.jpg");
  const thirdSource = path.join(input, "album-three.jpg");
  writeFile(firstSource, "1");
  writeFile(secondSource, "2");
  writeFile(thirdSource, "3");

  const analysis = makeExecutorAnalysis(output, { albumMode: AlbumMode.JSON });
  const firstTarget = path.join(output, "ALL_PHOTOS", "albums", "one", "IMG_1.jpg");
  const secondTarget = path.join(output, "ALL_PHOTOS", "albums", "two", "IMG_1.jpg");
  const thirdTarget = path.join(output, "ALL_PHOTOS", "IMG_2.jpg");
  const firstMedia = makeMediaRecord(firstSource, { album: "相册一" });
  const secondMedia = makeMediaRecord(secondSource, { album: "相册二" });
  const thirdMedia = makeMediaRecord(thirdSource, { album: "相册三" });
  const actions = [
    makeAction({ kind: ActionKind.COPY, source: firstSource, target: firstTarget, media: firstMedia, album: "相册一" }),
    makeAction({ kind: ActionKind.COPY, source: secondSource, target: secondTarget, media: secondMedia, album: "相册二" }),
    makeAction({ kind: ActionKind.COPY, source: thirdSource, target: thirdTarget, media: thirdMedia, album: "相册三" }),
  ];
  const { context } = makeContext();
  await executePlan(analysis, actions, context);

  const albumInfo = readJson(path.join(output, ALBUM_INFO_NAME));
  assert.deepEqual(Object.keys(albumInfo).sort(), [
    "ALL_PHOTOS/albums/one/IMG_1.jpg",
    "ALL_PHOTOS/albums/two/IMG_1.jpg",
    "IMG_2.jpg",
  ]);
  assert.deepEqual(albumInfo["ALL_PHOTOS/albums/one/IMG_1.jpg"], ["相册一"]);
  assert.deepEqual(albumInfo["ALL_PHOTOS/albums/two/IMG_1.jpg"], ["相册二"]);
  assert.deepEqual(albumInfo["IMG_2.jpg"], ["相册三"]);
});

test("executor: 主文件失败时快捷方式回退为实体文件并告警", async () => {
  const root = makeTempRoot("exec-shortcut");
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const albumSource = path.join(input, "album", "photo.jpg");
  const missingMainSource = path.join(input, "photo.jpg");
  writeFile(albumSource, "ALBUM");

  const media = makeMediaRecord(albumSource, { album: "相册" });
  const analysis = makeExecutorAnalysis(output, {}, { media: [media] });
  const mainTarget = path.join(output, "ALL_PHOTOS", "photo.jpg");
  const albumTarget = path.join(output, "相册", "photo.jpg");
  const actions = [
    makeAction({ kind: ActionKind.COPY, source: missingMainSource, target: mainTarget, media }),
    makeAction({
      kind: ActionKind.SHORTCUT,
      source: mainTarget,
      target: albumTarget,
      media,
      album: "相册",
      fallbackSource: albumSource,
      fallbackTarget: albumTarget,
    }),
  ];
  const { context, logs } = makeContext();
  const result = await executePlan(analysis, actions, context);

  assert.equal(actions[0].status, ActionStatus.FAILED);
  assert.equal(actions[1].status, ActionStatus.SUCCESS);
  assert.equal(actions[1].actualKind, ActionKind.COPY);
  assert.equal(fs.readFileSync(albumTarget, "utf8"), "ALBUM");
  assert.ok(
    logs.some(
      ([level, message]) =>
        level === "WARNING" &&
        message === "主文件未能成功输出，已在相册中改用实体文件：photo.jpg",
    ),
  );
});

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

function writeTakeoutFixture(root) {
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const mediaPath = path.join(input, "Photos from 2023", "IMG_001.jpg");
  writeFile(mediaPath, "JPEG-BYTES");
  const takenAt = localDate(2023, 5, 2, 10, 30, 0);
  writeFile(
    `${mediaPath}.json`,
    JSON.stringify({
      photoTakenTime: { timestamp: String(Math.floor(takenAt.getTime() / 1000)) },
    }),
  );
  return { input, output, mediaPath, takenAt };
}

function makeObjectOptions(init) {
  return new OrganizeOptions(init);
}

test("engine: 端到端 analyze → buildPlan → execute（JSON 日期、复制、报告）", async () => {
  const root = makeTempRoot("engine-e2e");
  const { input, output, mediaPath, takenAt } = writeTakeoutFixture(root);

  const engine = new TakeoutEngine();
  const options = makeObjectOptions({
    inputDir: input,
    outputDir: output,
    operation: OperationMode.COPY,
    albumMode: AlbumMode.NOTHING,
    dateDivision: DateDivision.YEAR_MONTH,
    unknownDateMode: UnknownDateMode.FOLDER,
    conflictMode: ConflictMode.RENAME,
    useJson: true,
    useExif: false,
    useFilename: false,
    aggressiveJson: false,
    useHashCache: false,
    writeReport: true,
    workers: 2,
  });
  const { context, logs } = makeContext();
  const analysis = await engine.analyze(options, context);

  assert.equal(analysis.media.length, 1);
  assert.equal(analysis.statistics.discovered, 1);
  assert.equal(analysis.statistics.afterDeduplication, 1);
  assert.equal(analysis.statistics.dated, 1);
  assert.equal(analysis.statistics.unknownDates, 0);
  assert.equal(analysis.usedFallbackScan, false);
  assert.ok(logs.some(([level, message]) => level === "INFO" && message === "已发现 1 个媒体文件"));

  const media = analysis.media[0];
  assert.equal(media.firstFile, mediaPath);
  assert.equal(media.dateTaken.getTime(), takenAt.getTime());

  const actions = engine.buildPlan(analysis, context);
  assert.equal(actions.length, 1);
  const expectedTarget = path.join(
    output,
    "ALL_PHOTOS",
    String(takenAt.getFullYear()),
    String(takenAt.getMonth() + 1).padStart(2, "0"),
    "IMG_001.jpg",
  );
  assert.equal(actions[0].kind, ActionKind.COPY);
  assert.equal(actions[0].target, expectedTarget);
  assert.equal(analysis.statistics.plannedActions, 1);

  const result = await engine.execute(analysis, actions, context);
  assert.equal(result.errors.length, 0);
  assert.equal(fs.readFileSync(expectedTarget, "utf8"), "JPEG-BYTES");
  assert.equal(analysis.statistics.copied, 1);
  assert.ok(Math.abs(mtimeSeconds(expectedTarget) - takenAt.getTime() / 1000) < 2);
  assert.deepEqual(walkRelative(output), [
    `ALL_PHOTOS/${takenAt.getFullYear()}/${String(takenAt.getMonth() + 1).padStart(2, "0")}/IMG_001.jpg`,
    DEFAULT_REPORT_NAME,
  ]);
  const report = readJson(path.join(output, DEFAULT_REPORT_NAME));
  assert.equal(report.version, 1);
  assert.equal(report.statistics.copied, 1);
  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].status, "success");
  assert.equal(report.actions[0].target, expectedTarget);
  assert.equal(report.actions[0].date, "2023-05-02T10:30:00");
});

test("engine: 校验错误与空输入分别抛 ValidationError / InputNotFoundError", async () => {
  const engine = new TakeoutEngine();
  const root = makeTempRoot("engine-errors");
  const missingInput = path.join(root, "does-not-exist");
  const output = path.join(root, "output");
  const options = makeObjectOptions({ inputDir: missingInput, outputDir: output });
  await assert.rejects(engine.analyze(options, makeContext().context), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.message, "输入目录不存在或不是文件夹");
    return true;
  });

  const emptyInput = path.join(root, "empty-input");
  fs.mkdirSync(emptyInput, { recursive: true });
  const emptyOptions = makeObjectOptions({
    inputDir: emptyInput,
    outputDir: output,
    useHashCache: false,
  });
  await assert.rejects(engine.analyze(emptyOptions, makeContext().context), (error) => {
    assert.ok(error instanceof InputNotFoundError);
    assert.equal(error.message, "输入目录中没有发现受支持的照片或视频");
    return true;
  });
});

test("cli: 取消任务沿引擎抛出 CancelledError 并映射为退出码 130", async () => {
  const root = makeTempRoot("cli-cancel");
  const input = path.join(root, "input");
  writeFile(path.join(input, "Photos from 2023", "a.jpg"), "JPEG");
  const output = path.join(root, "output");
  const engine = new TakeoutEngine();
  const options = makeObjectOptions({ inputDir: input, outputDir: output, useHashCache: false });
  const { context } = makeContext();
  context.cancel();
  await assert.rejects(engine.analyze(options, context), (error) => {
    assert.ok(error instanceof CancelledError, `expected CancelledError, got ${error}`);
    assert.deepEqual(classifyCliError(error), { code: 130, message: "任务已取消" });
    return true;
  });
});

// ---------------------------------------------------------------------------
// engine.fixDates
// ---------------------------------------------------------------------------

function writeJsonSidecar(mediaPath, takenAt) {
  writeFile(
    `${mediaPath}.json`,
    JSON.stringify({
      photoTakenTime: { timestamp: String(Math.floor(takenAt.getTime() / 1000)) },
    }),
  );
}

test("engine.fixDates: dry-run 只统计，真实运行改名并写入 mtime", async () => {
  const root = makeTempRoot("fix-dates");
  const mediaPath = path.join(root, "2020-01-02.jpg");
  writeFile(mediaPath, "MEDIA");
  const takenAt = localDate(2021, 3, 4, 5, 6, 7);
  writeJsonSidecar(mediaPath, takenAt);
  const originalMtime = localDate(2001, 1, 1, 0, 0, 0);
  fs.utimesSync(mediaPath, originalMtime, originalMtime);

  const engine = new TakeoutEngine();
  const dryOptions = new FixDateOptions({
    inputDir: root,
    dryRun: true,
    correctDateFilenames: true,
    useExif: false,
  });
  const dryResult = await engine.fixDates(dryOptions, makeContext().context);
  assert.equal(dryResult.total, 1);
  assert.equal(dryResult.updated, 1);
  assert.equal(dryResult.unchanged, 0);
  assert.equal(dryResult.renameCandidates, 1);
  assert.equal(dryResult.renamed, 0);
  assert.equal(fs.existsSync(mediaPath), true);
  assert.ok(Math.abs(mtimeSeconds(mediaPath) - originalMtime.getTime() / 1000) < 2);

  const realOptions = new FixDateOptions({
    inputDir: root,
    dryRun: false,
    correctDateFilenames: true,
    useExif: false,
  });
  const { context, logs } = makeContext();
  const result = await engine.fixDates(realOptions, context);
  assert.equal(result.total, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.renameCandidates, 1);
  assert.equal(result.renamed, 1);
  assert.equal(result.failed, 0);
  const renamedPath = path.join(root, "2021-03-04.jpg");
  assert.equal(fs.existsSync(mediaPath), false);
  assert.equal(fs.existsSync(renamedPath), true);
  assert.ok(Math.abs(mtimeSeconds(renamedPath) - takenAt.getTime() / 1000) < 2);
  assert.ok(
    logs.some(
      ([level, message]) =>
        level === "INFO" &&
        message === "日期型错误文件名已修正 1 个：\n  - 2020-01-02.jpg → 2021-03-04.jpg",
    ),
  );
});

test("engine.fixDates: YYYY/MM 目录与 mtime 互相印证时才作为修正证据", async () => {
  const root = makeTempRoot("fix-organized");
  const mediaPath = path.join(root, "2024", "06", "2023-05-01.jpg");
  writeFile(mediaPath, "MEDIA");
  const folderDate = localDate(2024, 6, 5, 12, 0, 0);
  fs.utimesSync(mediaPath, folderDate, folderDate);

  const engine = new TakeoutEngine();
  const options = new FixDateOptions({
    inputDir: root,
    dryRun: false,
    correctDateFilenames: true,
    useJson: true,
    useExif: false,
    useFilename: true,
    aggressiveJson: false,
  });
  const result = await engine.fixDates(options, makeContext().context);
  assert.equal(result.total, 1);
  assert.equal(result.renameCandidates, 1);
  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(mediaPath), false);
  assert.equal(fs.existsSync(path.join(root, "2024", "06", "2024-06-05.jpg")), true);
});

// ---------------------------------------------------------------------------
// CLI（真实子进程）
// ---------------------------------------------------------------------------

test("cli: --version / --help / 参数错误退出码", () => {
  const version = runCli(["--version"]);
  assert.equal(version.spawnError, null);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "gpth 5.0.0");

  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /organize/);
  assert.match(help.stdout, /--port/);

  const organizeHelp = runCli(["organize", "--help"]);
  assert.equal(organizeHelp.status, 0);
  assert.match(organizeHelp.stdout, /--plan-json/);
  assert.match(organizeHelp.stdout, /--recognize-live-photos/);

  const unknown = runCli(["nonsense"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /invalid choice/);

  const badChoice = runCli(["organize", "-i", "a", "-o", "b", "--operation", "nope"]);
  assert.equal(badChoice.status, 2);
  assert.match(badChoice.stderr, /invalid choice: 'nope'/);

  const missingRequired = runCli(["organize"]);
  assert.equal(missingRequired.status, 2);
  assert.match(missingRequired.stderr, /the following arguments are required/);
});

test("cli: organize --dry-run --plan-json 输出合法计划 JSON", () => {
  const root = makeTempRoot("cli-dry");
  const { input, output, mediaPath, takenAt } = writeTakeoutFixture(root);
  const planPath = path.join(root, "plan.json");
  const result = runCli([
    "organize",
    "-i",
    input,
    "-o",
    output,
    "--dry-run",
    "--plan-json",
    planPath,
    "--albums",
    "nothing",
    "--no-exif",
    "--no-filename",
    "--no-aggressive-json",
    "--no-hash-cache",
  ]);
  assert.equal(result.spawnError, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^预览完成：发现 1，/);
  assert.match(result.stdout, /唯一媒体 1/);
  assert.match(result.stdout, /计划操作 1/);
  assert.match(result.stdout, /，指纹缓存已关闭，实况照片识别已关闭\n?$/);

  const rows = readJson(planPath);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), [
    "kind",
    "source",
    "target",
    "album",
    "bundle_id",
    "live_photo_role",
    "reason",
  ]);
  assert.equal(rows[0].kind, "copy");
  assert.equal(rows[0].source, mediaPath);
  assert.match(rows[0].target, /ALL_PHOTOS/);
  assert.match(
    rows[0].target,
    new RegExp(`${takenAt.getFullYear()}[/\\\\]${String(takenAt.getMonth() + 1).padStart(2, "0")}`),
  );

  // 进度输出格式与 Python 一致。
  assert.match(result.stderr, /\[ *scanning\] +\d+% +正在分析目录结构…/);
  assert.match(result.stderr, /\[ *planning\] +\d+% +规划输出：IMG_001\.jpg/);
});

test("cli: 缺失输入目录退出码 11，空输入目录退出码 13", () => {
  const root = makeTempRoot("cli-errors");
  const output = path.join(root, "output");
  const missing = runCli(["organize", "-i", path.join(root, "nope"), "-o", output]);
  assert.equal(missing.status, 11);
  assert.match(missing.stderr, /错误：输入目录不存在或不是文件夹/);

  const emptyInput = path.join(root, "empty");
  fs.mkdirSync(emptyInput, { recursive: true });
  const empty = runCli([
    "organize",
    "-i",
    emptyInput,
    "-o",
    path.join(root, "output-empty"),
    "--no-hash-cache",
  ]);
  assert.equal(empty.status, 13);
  assert.match(empty.stderr, /错误：输入目录中没有发现受支持的照片或视频/);
});

test("cli: v3 兼容参数（--copy/-i/-o/--divide-to-dates）执行整理", () => {
  const root = makeTempRoot("cli-legacy");
  const { input, output } = writeTakeoutFixture(root);
  // v3 兼容模式没有 --no-hash-cache 开关；把 APPDATA 指向临时目录，
  // 避免扫描指纹缓存写进真实用户配置目录。
  const result = runCli(
    ["-i", input, "-o", output, "--copy", "--divide-to-dates", "--albums", "nothing"],
    { env: { APPDATA: path.join(root, "appdata") } },
  );
  assert.equal(result.spawnError, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /完成：复制 1，移动 0，快捷方式 0，跳过 0，失败 0/);
  const files = walkRelative(output).filter((file) => !file.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^ALL_PHOTOS[/\\]\d{4}[/\\]\d{2}[/\\]IMG_001\.jpg$/);
});

test("cli: v3 兼容参数 --fix 执行日期修复", () => {
  const root = makeTempRoot("cli-legacy-fix");
  const mediaPath = path.join(root, "2020-01-02.jpg");
  writeFile(mediaPath, "MEDIA");
  writeJsonSidecar(mediaPath, localDate(2021, 3, 4, 5, 6, 7));
  const result = runCli(["--fix", root]);
  assert.equal(result.spawnError, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^扫描 1 个媒体；可修复\/已修复 1；已重命名 0；/);
});

test("cli: 运行期异常到退出码映射（含取消 130）", () => {
  assert.deepEqual(classifyCliError(new CancelledError("已取消")), {
    code: 130,
    message: "任务已取消",
  });
  assert.deepEqual(classifyCliError(new InputNotFoundError("没有媒体")), {
    code: 13,
    message: "错误：没有媒体",
  });
  // 日期修复模式与 Python 一致：目录/输入问题按 ValueError 处理，退出码 11。
  assert.deepEqual(classifyCliError(new InputNotFoundError("没有媒体"), "fix"), {
    code: 11,
    message: "错误：没有媒体",
  });
  assert.deepEqual(classifyCliError(new ValidationError("选项无效")), {
    code: 11,
    message: "错误：选项无效",
  });
  assert.deepEqual(classifyCliError(new Error("boom")), {
    code: 1,
    message: "未处理错误：boom",
  });
});
