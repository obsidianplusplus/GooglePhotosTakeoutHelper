/**
 * Web 会话管理器：把引擎任务放进 worker_threads，主线程只做 HTTP/SSE。
 *
 * 一个会话 = 一个 worker 线程 + 有界 SSE 事件缓冲 + 日志环形缓冲。
 * worker 持有 AnalysisResult / PlanAction[]，浏览器通过 `/preview`、`/duplicates`
 * 按页拉取，避免十万级动作一次性跨线程复制。
 *
 * 状态机（docs/ARCHITECTURE.md 的 Web 架构）：
 *   organize: analysing -> analysed -> executing -> done
 *   fix:      fixing -> fixed
 *   任意 -> cancelled / error
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { Worker } from "node:worker_threads";

import { FixDateOptions, OrganizeOptions, optionsEqual } from "../models.js";

/** 统一的 HTTP 错误：server.js 直接映射为 { error:{ code, message, ...extra } }。 */
export class WebError extends Error {
  constructor(code, message, status = 400, extra = null) {
    super(message);
    this.name = "WebError";
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const WORKER_URL = new URL("./job-worker.js", import.meta.url);

const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_EVENT_BUFFER_SIZE = 4000;
const DEFAULT_LOG_BUFFER_SIZE = 2000;
const MAX_PREVIEW_LIMIT = 1000;
const MAX_DUPLICATES_LIMIT = 500;
const TERMINAL_STATES = new Set(["done", "cancelled", "error", "fixed"]);

function toInt(value, fallback) {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function clampPage(params = {}, { defaultOffset = 0, defaultLimit = 300, maxLimit = MAX_PREVIEW_LIMIT } = {}) {
  const offset = Math.max(toInt(params.offset, defaultOffset), 0);
  const limit = Math.max(1, Math.min(toInt(params.limit, defaultLimit), maxLimit));
  return { offset, limit };
}

function optionsError(errors) {
  return new WebError("invalid-options", errors.join("；"), 400, { errors });
}

/**
 * 校验并规范化 organize 选项（镜像桌面 UI 的 _collect_organize_options）。
 * @returns {{ options: OrganizeOptions, optionsJson: object }}
 */
function validateOrganizeOptions(rawOptions) {
  if (rawOptions === null || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw optionsError(["请求缺少 options 对象。"]);
  }
  let options;
  try {
    options = new OrganizeOptions(rawOptions);
  } catch (error) {
    throw optionsError([error?.message ?? String(error)]);
  }
  const errors = options.validate();
  if (errors.length > 0) {
    throw optionsError(errors);
  }
  return { options, optionsJson: options.normalized().toJSON() };
}

function fixOptionsToJson(options) {
  return {
    inputDir: options.inputDir,
    recursive: options.recursive,
    useJson: options.useJson,
    useExif: options.useExif,
    useFilename: options.useFilename,
    aggressiveJson: options.aggressiveJson,
    useFileMtime: options.useFileMtime,
    dryRun: options.dryRun,
    includeHidden: options.includeHidden,
    correctDateFilenames: options.correctDateFilenames,
    maxExifBytes: options.maxExifBytes,
  };
}

/**
 * 校验 fix 选项（镜像桌面 UI 的 _collect_fix_options）。
 * @returns {{ options: FixDateOptions, optionsJson: object }}
 */
function validateFixOptions(rawOptions) {
  if (rawOptions === null || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw optionsError(["请求缺少 options 对象。"]);
  }
  let options;
  try {
    options = new FixDateOptions(rawOptions).normalized();
  } catch (error) {
    throw optionsError([error?.message ?? String(error)]);
  }
  const errors = [];
  try {
    if (!fs.statSync(options.inputDir).isDirectory()) {
      errors.push("所选目录不存在或不是文件夹。");
    }
  } catch {
    errors.push("所选目录不存在或不是文件夹。");
  }
  if (!(options.useJson || options.useExif || options.useFilename || options.useFileMtime)) {
    errors.push("请至少启用一种日期来源。");
  }
  if (errors.length > 0) {
    throw optionsError(errors);
  }
  return { options, optionsJson: fixOptionsToJson(options) };
}

/** 会话状态 + 控制位 -> SSE state 事件 payload。 */
function statePayload(session) {
  return { state: session.state, busy: session.busy, canExecute: session.canExecute };
}

export class SessionManager {
  constructor({
    idleMs = DEFAULT_IDLE_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    eventBufferSize = DEFAULT_EVENT_BUFFER_SIZE,
    logBufferSize = DEFAULT_LOG_BUFFER_SIZE,
  } = {}) {
    this.idleMs = Math.max(idleMs, 60_000);
    this.requestTimeoutMs = Math.max(requestTimeoutMs, 1000);
    this.eventBufferSize = Math.max(eventBufferSize, 100);
    this.logBufferSize = Math.max(logBufferSize, 100);
    this.sessions = new Map();
    this.requestCounter = 0;
    this.closed = false;
    this.gcTimer = setInterval(() => this.#collectIdleSessions(), 60_000);
    this.gcTimer.unref?.();
  }

  get sessionCount() {
    return this.sessions.size;
  }

  /**
   * 创建会话并启动 worker。
   *
   * @param {{type: string, options: object}} params
   * @returns {{sessionId: string, type: "organize"|"fix", state: string}}
   */
  createSession({ type, options } = {}) {
    const sessionType = type === "fix" ? "fix" : type === "organize" ? "organize" : null;
    if (!sessionType) {
      throw new WebError("invalid-type", "会话类型必须是 organize 或 fix。", 400);
    }
    const normalized =
      sessionType === "organize"
        ? validateOrganizeOptions(options)
        : validateFixOptions(options);

    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const session = {
      id: sessionId,
      type: sessionType,
      state: sessionType === "organize" ? "analysing" : "fixing",
      busy: true,
      canExecute: false,
      optionsJson: normalized.optionsJson,
      worker: null,
      workerFailed: false,
      terminating: false,
      cancelRequested: false,
      summary: null,
      previewTotal: null,
      duplicateTotal: null,
      events: [],
      logs: [],
      subscribers: new Set(),
      pending: new Map(),
      createdAt: now,
      lastActivity: now,
    };
    this.sessions.set(sessionId, session);

    let worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: {
          sessionId,
          type: sessionType,
          options: normalized.optionsJson,
        },
        name: `gpth-web-${sessionType}-${sessionId.slice(0, 8)}`,
        // node:test 等场景会在 execArgv 里带测试参数，worker 只继承显式设置，避免重复跑测试。
        execArgv: [],
      });
    } catch (error) {
      this.sessions.delete(sessionId);
      throw new WebError(
        "worker-start-failed",
        `无法启动后台任务线程：${error?.message ?? error}`,
        500,
      );
    }
    session.worker = worker;
    worker.on("message", (message) => this.#handleWorkerMessage(session, message));
    worker.on("error", (error) => this.#handleWorkerFailure(session, error));
    worker.on("exit", (code) => this.#handleWorkerExit(session, code));

    // 立即广播初始状态：即使前端在 worker 第一条消息之前连上 SSE，也能拿到确定状态。
    this.#recordEvent(session, "state", statePayload(session));
    return { sessionId, type: sessionType, state: session.state };
  }

  /** 取会话并刷新活跃时间；不存在抛 404。 */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new WebError("session-not-found", "会话不存在或已过期。", 404);
    }
    session.lastActivity = Date.now();
    return session;
  }

  /** GET /api/session/:id/summary */
  getSummary(sessionId) {
    const session = this.getSession(sessionId);
    return {
      state: session.state,
      summary: session.summary,
      previewTotal: session.previewTotal,
      duplicateTotal: session.duplicateTotal,
    };
  }

  /** GET /api/session/:id/preview */
  async getPreviewPage(sessionId, params = {}) {
    const session = this.getSession(sessionId);
    if (session.type !== "organize") {
      throw new WebError("not-supported", "日期修复会话没有整理预览。", 400);
    }
    if (session.previewTotal === null) {
      throw new WebError("analysis-not-ready", "分析尚未完成，请稍后再试。", 409);
    }
    const { offset, limit } = clampPage(params, { defaultLimit: 300 });
    const page = await this.#request(session, { type: "preview", offset, limit });
    return page;
  }

  /** GET /api/session/:id/duplicates */
  async getDuplicatesPage(sessionId, params = {}) {
    const session = this.getSession(sessionId);
    if (session.type !== "organize") {
      throw new WebError("not-supported", "日期修复会话没有重复项列表。", 400);
    }
    if (session.previewTotal === null) {
      throw new WebError("analysis-not-ready", "分析尚未完成，请稍后再试。", 409);
    }
    const { offset, limit } = clampPage(params, {
      defaultLimit: 200,
      maxLimit: MAX_DUPLICATES_LIMIT,
    });
    const page = await this.#request(session, { type: "duplicates", offset, limit });
    return page;
  }

  /**
   * POST /api/session/:id/execute
   * 仅当 state=analysed 且选项与扫描时完全一致才允许执行；否则 409。
   */
  executeSession(sessionId, rawOptions) {
    const session = this.getSession(sessionId);
    if (session.type !== "organize") {
      throw new WebError("not-supported", "日期修复会话不支持执行整理计划。", 409);
    }
    if (session.state === "executing" || session.busy) {
      throw new WebError("busy", "任务正在运行，请稍候。", 409);
    }
    if (session.state !== "analysed") {
      throw new WebError("stale-preview", "尚未生成预览，或预览后修改了选项。", 409);
    }
    if (rawOptions === null || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
      throw optionsError(["请求缺少 options 对象。"]);
    }
    let requested;
    try {
      requested = new OrganizeOptions(rawOptions).normalized();
    } catch {
      throw new WebError("stale-preview", "尚未生成预览，或预览后修改了选项。", 409);
    }
    let scanned;
    try {
      // 重新构造扫描时选项以做等价比较（路径都已 normalized）。
      scanned = new OrganizeOptions(session.optionsJson).normalized();
    } catch {
      scanned = null;
    }
    if (!scanned || !optionsEqual(requested, scanned)) {
      throw new WebError("stale-preview", "尚未生成预览，或预览后修改了选项。", 409);
    }
    if (session.previewTotal === 0) {
      throw new WebError(
        "empty-plan",
        "当前计划为空，请调整选项或输入目录后重新扫描。",
        409,
      );
    }
    this.#applyState(session, "executing", true, false);
    try {
      session.worker.postMessage({ type: "execute", options: session.optionsJson });
    } catch (error) {
      this.#applyState(session, "analysed", false, true);
      throw new WebError(
        "worker-unavailable",
        `后台任务线程不可用：${error?.message ?? error}`,
        500,
      );
    }
    return { ok: true };
  }

  /** POST /api/session/:id/cancel：请求取消，worker 在下一个检查点结束并推送 cancelled。 */
  cancelSession(sessionId) {
    const session = this.getSession(sessionId);
    if (TERMINAL_STATES.has(session.state) || !session.busy) {
      return { ok: true };
    }
    session.cancelRequested = true;
    try {
      session.worker.postMessage({ type: "cancel" });
    } catch {
      // worker 已退出时由 exit 处理器写入 error 事件，这里不重复报错。
    }
    return { ok: true };
  }

  /** DELETE /api/session/:id：终止 worker 并释放会话。 */
  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: true };
    }
    this.sessions.delete(sessionId);
    session.terminating = true;
    this.#rejectPending(session, new WebError("session-closed", "会话已关闭。", 404));
    this.#closeSubscribers(session);
    if (session.busy && session.worker) {
      // 先礼貌地请求取消（让引擎在检查点停下），再强制终止线程。
      try {
        session.worker.postMessage({ type: "cancel" });
      } catch {
        // 线程可能已经退出，忽略。
      }
    }
    try {
      await session.worker?.terminate();
    } catch {
      // 已退出时 terminate 会 reject，忽略。
    }
    return { ok: true };
  }

  /**
   * GET /api/session/:id/events（SSE）。
   * 连接时先发 hello，再重放有界事件缓冲，最后补发当前状态；随后实时推送。
   */
  subscribe(sessionId, req, res) {
    const session = this.getSession(sessionId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const subscriber = { req, res, timer: null, closed: false, cleanup: null };
    const cleanup = () => {
      if (subscriber.closed) {
        return;
      }
      subscriber.closed = true;
      if (subscriber.timer) {
        clearInterval(subscriber.timer);
      }
      session.subscribers.delete(subscriber);
      try {
        res.end();
      } catch {
        // 客户端已经断开。
      }
    };
    subscriber.cleanup = cleanup;
    session.subscribers.add(subscriber);

    res.write("retry: 3000\n\n");
    this.#writeEvent(subscriber, "hello", { sessionId: session.id, type: session.type });
    for (const entry of session.events) {
      this.#writeEvent(subscriber, entry.event, entry.data);
    }
    // 事件缓冲有界，早期 analysis 可能已被挤出；连接时补发摘要兜底。
    if (session.summary && !session.events.some((entry) => entry.event === "analysis")) {
      this.#writeEvent(subscriber, "analysis", {
        summary: session.summary,
        previewTotal: session.previewTotal,
        duplicateTotal: session.duplicateTotal,
      });
    }
    const currentState = statePayload(session);
    const lastReplayedState = [...session.events].reverse().find((entry) => entry.event === "state");
    const stateUnchanged =
      lastReplayedState &&
      lastReplayedState.data?.state === currentState.state &&
      lastReplayedState.data?.busy === currentState.busy &&
      lastReplayedState.data?.canExecute === currentState.canExecute;
    if (!stateUnchanged) {
      // 补发当前状态；若缓冲里最后一条 state 已经与当前状态一致则不重复。
      this.#writeEvent(subscriber, "state", currentState);
    }

    const timer = setInterval(() => {
      if (subscriber.closed) {
        return;
      }
      // 有页面连着就认为会话活跃，避免被空闲回收。
      session.lastActivity = Date.now();
      try {
        res.write(": ping\n\n");
      } catch {
        cleanup();
      }
    }, 15_000);
    timer.unref?.();
    subscriber.timer = timer;

    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    return subscriber;
  }

  /** 关闭所有会话与定时器（HTTP 服务关闭时调用）。 */
  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const terminations = [];
    for (const session of sessions) {
      session.terminating = true;
      this.#rejectPending(session, new WebError("session-closed", "会话已关闭。", 404));
      this.#closeSubscribers(session);
      try {
        if (session.worker) {
          terminations.push(session.worker.terminate());
        }
      } catch {
        // 忽略：worker 已退出。
      }
    }
    await Promise.allSettled(terminations);
  }

  // ------------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------------

  #collectIdleSessions() {
    if (this.closed) {
      return;
    }
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.subscribers.size > 0) {
        continue;
      }
      if (now - session.lastActivity >= this.idleMs) {
        void this.deleteSession(session.id).catch(() => {});
      }
    }
  }

  #statePayload(session) {
    return statePayload(session);
  }

  #applyState(session, nextState, busy, canExecute) {
    const nextBusy = Boolean(busy);
    const nextCanExecute = Boolean(canExecute);
    if (
      session.state === nextState &&
      session.busy === nextBusy &&
      session.canExecute === nextCanExecute
    ) {
      return;
    }
    session.state = nextState;
    session.busy = nextBusy;
    session.canExecute = nextCanExecute;
    this.#recordEvent(session, "state", statePayload(session));
  }

  #recordEvent(session, event, data) {
    const entry = { event: String(event ?? "message"), data };
    session.events.push(entry);
    if (entry.event === "log") {
      // 日志环形缓冲：始终保留最近 N 条（超过时丢弃最旧的）。
      session.logs.push(data);
      if (session.logs.length > this.logBufferSize) {
        session.logs.splice(0, session.logs.length - this.logBufferSize);
      }
    }
    if (session.events.length > this.eventBufferSize) {
      session.events.splice(0, session.events.length - this.eventBufferSize);
    }
    session.lastActivity = Date.now();
    for (const subscriber of [...session.subscribers]) {
      this.#writeEvent(subscriber, entry.event, entry.data);
    }
  }

  #writeEvent(subscriber, event, data) {
    if (subscriber.closed) {
      return;
    }
    let serialized;
    try {
      serialized = JSON.stringify(data === undefined ? null : data);
    } catch {
      serialized = "null";
    }
    const name = String(event ?? "message").replace(/[^A-Za-z0-9_-]/gu, "") || "message";
    try {
      subscriber.res.write(`event: ${name}\ndata: ${serialized}\n\n`);
    } catch {
      subscriber.cleanup?.();
    }
  }

  #closeSubscribers(session) {
    for (const subscriber of [...session.subscribers]) {
      subscriber.cleanup?.();
    }
    session.subscribers.clear();
  }

  #rejectPending(session, error) {
    for (const [requestId, entry] of [...session.pending.entries()]) {
      clearTimeout(entry.timer);
      session.pending.delete(requestId);
      try {
        entry.reject(error);
      } catch {
        // Promise 已 settle，忽略。
      }
    }
  }

  #request(session, message) {
    return new Promise((resolve, reject) => {
      if (!session.worker) {
        reject(new WebError("worker-unavailable", "后台任务线程不可用。", 503));
        return;
      }
      this.requestCounter += 1;
      const requestId = `req-${this.requestCounter}`;
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        reject(
          new WebError(
            "worker-timeout",
            "后台任务响应超时，请重试。",
            504,
          ),
        );
      }, this.requestTimeoutMs);
      timer.unref?.();
      session.pending.set(requestId, { resolve, reject, timer });
      try {
        session.worker.postMessage({ ...message, requestId });
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(requestId);
        reject(
          new WebError(
            "worker-unavailable",
            `后台任务线程不可用：${error?.message ?? error}`,
            500,
          ),
        );
      }
    });
  }

  #handleReply(session, message) {
    const entry = session.pending.get(message.requestId);
    if (!entry) {
      return;
    }
    session.pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.data);
      return;
    }
    const code = message.error?.code ?? "worker-error";
    const status = code === "analysis-not-ready" ? 409 : 500;
    entry.reject(
      new WebError(code, message.error?.message ?? "后台任务返回错误。", status),
    );
  }

  #handleWorkerMessage(session, message) {
    if (!message || typeof message !== "object") {
      return;
    }
    session.lastActivity = Date.now();
    switch (message.type) {
      case "event": {
        this.#recordEvent(session, message.event, message.data);
        break;
      }
      case "state": {
        const data = message.data ?? {};
        this.#applyState(
          session,
          data.state ?? session.state,
          data.busy ?? session.busy,
          data.canExecute ?? session.canExecute,
        );
        break;
      }
      case "analysis": {
        const data = message.data ?? {};
        session.summary = data.summary ?? null;
        session.previewTotal = toInt(data.previewTotal, 0);
        session.duplicateTotal = toInt(data.duplicateTotal, 0);
        this.#recordEvent(session, "analysis", {
          summary: session.summary,
          previewTotal: session.previewTotal,
          duplicateTotal: session.duplicateTotal,
        });
        this.#applyState(session, "analysed", false, true);
        break;
      }
      case "execution": {
        this.#recordEvent(session, "execution", message.data ?? { summary: null });
        this.#applyState(session, "done", false, false);
        break;
      }
      case "fix": {
        this.#recordEvent(session, "fix", message.data ?? { result: null });
        this.#applyState(session, "fixed", false, false);
        break;
      }
      case "cancelled": {
        this.#recordEvent(session, "cancelled", message.data ?? { message: "任务已由用户取消" });
        this.#applyState(session, "cancelled", false, false);
        break;
      }
      case "error": {
        this.#recordEvent(session, "error", message.data ?? { message: "任务失败。" });
        this.#applyState(session, "error", false, false);
        break;
      }
      case "reply": {
        this.#handleReply(session, message);
        break;
      }
      default:
        break;
    }
  }

  #handleWorkerFailure(session, error) {
    if (session.terminating || !this.sessions.has(session.id) || session.workerFailed) {
      return;
    }
    session.workerFailed = true;
    this.#recordEvent(session, "error", {
      message: `后台任务线程异常：${error?.message ?? error}`,
      stack: error?.stack ?? null,
    });
    this.#applyState(session, "error", false, false);
    this.#rejectPending(
      session,
      new WebError("worker-failed", "后台任务线程异常退出。", 500),
    );
  }

  #handleWorkerExit(session, code) {
    if (session.terminating || !this.sessions.has(session.id) || session.workerFailed) {
      return;
    }
    this.#rejectPending(
      session,
      new WebError("worker-exited", "后台工作线程已退出。", 500),
    );
    if (TERMINAL_STATES.has(session.state)) {
      return;
    }
    session.workerFailed = true;
    this.#recordEvent(session, "error", {
      message: `后台工作线程意外退出（退出码 ${code}）。`,
      stack: null,
    });
    this.#applyState(session, "error", false, false);
  }
}

export { validateOrganizeOptions, validateFixOptions, statePayload };
