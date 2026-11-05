/**
 * 会话工作线程：在 worker_threads 中运行引擎，HTTP/SSE 主线程保持响应。
 *
 * 协议（内部约定，主线程见 jobs.js）：
 *   worker -> 主线程
 *     { type:'event', event:'progress'|'log', data }
 *     { type:'state', data:{ state, busy, canExecute } }
 *     { type:'analysis', data:{ summary, previewTotal, duplicateTotal } }
 *     { type:'execution', data:{ summary } }
 *     { type:'fix', data:{ result } }
 *     { type:'cancelled', data:{ message } }
 *     { type:'error', data:{ message, name, code, stack } }
 *     { type:'reply', requestId, ok:true, data } | { requestId, ok:false, error }
 *   主线程 -> worker
 *     { type:'execute', options }
 *     { type:'cancel' }
 *     { type:'preview', requestId, offset, limit }
 *     { type:'duplicates', requestId, offset, limit }
 *     { type:'shutdown' }
 *
 * 关键约束：
 * - 分析结果与计划常驻本线程内存，执行时不重新扫描；
 * - 只向主线程推送摘要，预览/重复组由主线程按需拉取切片；
 * - 引擎模块可能仍在并行移植中，因此用动态 import：模块缺失只产生 error 事件，
 *   不会让 worker 在模块加载阶段直接崩溃（那样的错误没有机会被序列化）。
 */

import { parentPort, workerData } from "node:worker_threads";

import {
  CancelledError,
  FixDateOptions,
  OrganizeOptions,
  TaskContext,
  optionsEqual,
} from "../models.js";
import {
  serializeAnalysisSummary,
  serializeDuplicatePage,
  serializeExecutionSummary,
  serializeFixResult,
  serializeLog,
  serializePreviewPage,
  serializeProgress,
} from "./serialize.js";

const sessionId = typeof workerData?.sessionId === "string" ? workerData.sessionId : "";
const sessionType = workerData?.type === "fix" ? "fix" : "organize";
const initialOptions = workerData?.options ?? {};

const state = {
  engine: null,
  currentContext: null,
  analysis: null,
  actions: null,
  scanOptions: null,
  fixOptions: null,
  cancelRequested: false,
  executing: false,
  shuttingDown: false,
  loading: true,
};

function postMessageSafe(message) {
  if (!parentPort) {
    return;
  }
  try {
    parentPort.postMessage(message);
  } catch {
    // worker 已经被主线程 terminate，忽略写入失败。
  }
}

function emitEvent(event, data) {
  postMessageSafe({ type: "event", event, data });
}

function emitState(stateName, busy, canExecute) {
  postMessageSafe({
    type: "state",
    data: { state: stateName, busy: Boolean(busy), canExecute: Boolean(canExecute) },
  });
}

function emitCancelled(error) {
  postMessageSafe({
    type: "cancelled",
    data: { message: error?.message ? String(error.message) : "任务已由用户取消" },
  });
}

function errorPayload(error) {
  return {
    message: error?.message === undefined ? String(error) : String(error.message),
    name: error?.name ?? "Error",
    code: error?.code === undefined ? null : String(error.code),
    stack: error?.stack === undefined ? null : String(error.stack),
  };
}

function emitError(error) {
  postMessageSafe({ type: "error", data: errorPayload(error) });
}

function reply(requestId, ok, payload) {
  if (requestId === undefined) {
    return;
  }
  if (ok) {
    postMessageSafe({ type: "reply", requestId, ok: true, data: payload });
  } else {
    postMessageSafe({ type: "reply", requestId, ok: false, error: payload });
  }
}

function replyFailure(requestId, code, message) {
  reply(requestId, false, { code, message });
}

function isCancelledError(error) {
  return error instanceof CancelledError || error?.name === "CancelledError";
}

/** 创建转发进度/日志的 TaskContext；取消请求会在创建时立即生效。 */
function createTaskContext() {
  const context = new TaskContext({
    progressCallback: (update) => emitEvent("progress", serializeProgress(update)),
    logCallback: (level, message) => emitEvent("log", serializeLog(level, message)),
  });
  if (state.cancelRequested) {
    context.cancel();
  }
  state.currentContext = context;
  return context;
}

async function loadEngine() {
  const engineModule = await import("../engine.js");
  if (typeof engineModule.TakeoutEngine !== "function") {
    throw new Error("引擎模块接口缺失：TakeoutEngine");
  }
  return new engineModule.TakeoutEngine();
}

function normalizePage(offset, limit, total, defaultLimit) {
  const parsedOffset = Number.parseInt(String(offset ?? "0"), 10);
  const parsedLimit = Number.parseInt(String(limit ?? String(defaultLimit)), 10);
  const pageOffset = Math.max(0, Number.isFinite(parsedOffset) ? parsedOffset : 0);
  const pageLimit = Math.max(1, Math.min(Number.isFinite(parsedLimit) ? parsedLimit : defaultLimit, 1000));
  return { offset: Math.min(pageOffset, total), limit: pageLimit };
}

/** 初始任务：organize = analyze + buildPlan；fix = fixDates。 */
async function runInitialTask() {
  state.engine = await loadEngine();
  state.loading = false;
  if (sessionType === "organize") {
    const parsed = new OrganizeOptions(initialOptions);
    state.scanOptions = parsed.normalized();
    emitState("analysing", true, false);
    const context = createTaskContext();
    const analysis = await state.engine.analyze(state.scanOptions, context);
    const actions = state.engine.buildPlan(analysis, context);
    if (Array.isArray(actions)) {
      state.actions = actions;
    } else if (actions && typeof actions[Symbol.iterator] === "function") {
      state.actions = Array.from(actions);
    } else {
      state.actions = [];
    }
    state.analysis = analysis;
    if (state.cancelRequested) {
      // 取消可能恰好在引擎返回后到达：仍然按取消处理，避免把已完成任务当成功。
      throw new CancelledError("任务已由用户取消");
    }
    const groups = Array.isArray(analysis?.duplicateGroups) ? analysis.duplicateGroups : [];
    postMessageSafe({
      type: "analysis",
      data: {
        summary: serializeAnalysisSummary(analysis, state.actions),
        previewTotal: state.actions.length,
        duplicateTotal: groups.length,
      },
    });
    return;
  }

  const parsed = new FixDateOptions(initialOptions);
  state.fixOptions = parsed.normalized();
  emitState("fixing", true, false);
  const context = createTaskContext();
  const result = await state.engine.fixDates(state.fixOptions, context);
  if (state.cancelRequested) {
    throw new CancelledError("任务已由用户取消");
  }
  postMessageSafe({
    type: "fix",
    data: { result: serializeFixResult(result, { dryRun: Boolean(state.fixOptions.dryRun) }) },
  });
}

function handleTaskFailure(error) {
  if (state.shuttingDown) {
    return;
  }
  if (isCancelledError(error)) {
    emitCancelled(error);
    return;
  }
  emitError(error);
}

async function handleExecute(message) {
  if (state.executing) {
    emitError(Object.assign(new Error("任务正在执行，请稍候。"), { code: "busy" }));
    return;
  }
  if (!state.analysis || !state.actions) {
    emitError(
      Object.assign(new Error("分析结果尚未就绪，无法执行整理任务。"), {
        code: "analysis-not-ready",
      }),
    );
    return;
  }
  if (state.shuttingDown) {
    return;
  }
  state.executing = true;
  try {
    const requested = new OrganizeOptions(message?.options ?? {});
    const normalized = requested.normalized();
    if (!optionsEqual(normalized, state.scanOptions)) {
      emitError(
        Object.assign(
          new Error("尚未生成预览，或预览后修改了选项。"),
          { code: "stale-preview" },
        ),
      );
      return;
    }
    if (state.actions.length === 0) {
      emitError(
        Object.assign(
          new Error("当前计划为空，请调整选项或输入目录后重新扫描。"),
          { code: "empty-plan" },
        ),
      );
      return;
    }
    emitState("executing", true, false);
    const context = createTaskContext();
    const result = await state.engine.execute(state.analysis, state.actions, context);
    postMessageSafe({ type: "execution", data: { summary: serializeExecutionSummary(result) } });
  } catch (error) {
    handleTaskFailure(error);
  } finally {
    state.executing = false;
  }
}

function handlePreview(message) {
  const requestId = message?.requestId;
  if (!state.actions) {
    replyFailure(
      requestId,
      "analysis-not-ready",
      state.loading ? "分析尚未完成，请稍后再试。" : "分析结果不可用，请重新创建会话。",
    );
    return;
  }
  const total = state.actions.length;
  const { offset, limit } = normalizePage(message?.offset, message?.limit, total, 300);
  reply(requestId, true, serializePreviewPage(state.actions, offset, limit));
}

function handleDuplicates(message) {
  const requestId = message?.requestId;
  const groups = Array.isArray(state.analysis?.duplicateGroups)
    ? state.analysis.duplicateGroups
    : null;
  if (!groups) {
    replyFailure(
      requestId,
      "analysis-not-ready",
      state.loading ? "分析尚未完成，请稍后再试。" : "分析结果不可用，请重新创建会话。",
    );
    return;
  }
  const total = groups.length;
  const { offset, limit } = normalizePage(message?.offset, message?.limit, total, 200);
  reply(requestId, true, serializeDuplicatePage(groups, offset, limit));
}

function handleCancel() {
  state.cancelRequested = true;
  if (state.currentContext) {
    state.currentContext.cancel();
  }
}

function handleShutdown() {
  state.shuttingDown = true;
  if (state.currentContext) {
    state.currentContext.cancel();
  }
  try {
    parentPort?.removeAllListeners?.();
  } catch {
    // 忽略：即将退出。
  }
  try {
    parentPort?.close?.();
  } catch {
    // 忽略：即将退出。
  }
}

if (parentPort) {
  parentPort.on("message", (message) => {
    const type = message?.type;
    // cancel / shutdown / 预览拉取必须立即处理：不能排在长时间执行任务后面，
    // 否则取消要等到当前文件处理完才会被看到。
    if (type === "cancel") {
      handleCancel();
      return;
    }
    if (type === "shutdown") {
      handleShutdown();
      return;
    }
    if (type === "preview") {
      handlePreview(message);
      return;
    }
    if (type === "duplicates") {
      handleDuplicates(message);
      return;
    }
    if (type === "execute") {
      void handleExecute(message);
      return;
    }
  });

  runInitialTask().catch(handleTaskFailure);
}
