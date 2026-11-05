/**
 * 后端 API 访问层 + SSE 会话事件流。
 *
 * 所有接口遵循 docs/ARCHITECTURE.md 的 Web 架构。
 */

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.code = options.code ?? "request-failed";
    this.status = options.status ?? 0;
    this.details = options.details ?? null;
    this.errors = options.errors ?? null;
  }
}

async function request(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError(`无法连接本机服务：${error.message}`, { code: "network-error" });
  }
  const contentType = response.headers.get("content-type") ?? "";
  let payload = null;
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(error.message ?? `请求失败（HTTP ${response.status}）`, {
      code: error.code ?? `http-${response.status}`,
      status: response.status,
      details: error.details ?? null,
      errors: error.errors ?? payload?.errors ?? null,
    });
  }
  return payload;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  del: (path) => request("DELETE", path),

  health: () => request("GET", "/api/health"),
  system: () => request("GET", "/api/system"),
  getSettings: () => request("GET", "/api/settings"),
  saveSettings: (settings) => request("PUT", "/api/settings", { settings }),
  getCache: () => request("GET", "/api/cache"),
  clearCache: () => request("POST", "/api/cache/clear"),
  fsRoots: () => request("GET", "/api/fs/roots"),
  fsList: (path, { showHidden = false, type = "dir" } = {}) => {
    const params = new URLSearchParams({ path, type });
    if (showHidden) {
      params.set("showHidden", "1");
    }
    return request("GET", `/api/fs/list?${params.toString()}`);
  },
  createSession: (type, options) => request("POST", "/api/session", { type, options }),
  executeSession: (sessionId, options) =>
    request("POST", `/api/session/${encodeURIComponent(sessionId)}/execute`, { options }),
  cancelSession: (sessionId) =>
    request("POST", `/api/session/${encodeURIComponent(sessionId)}/cancel`),
  deleteSession: (sessionId) =>
    request("DELETE", `/api/session/${encodeURIComponent(sessionId)}`),
  summary: (sessionId) => request("GET", `/api/session/${encodeURIComponent(sessionId)}/summary`),
  preview: (sessionId, offset, limit) =>
    request(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/preview?offset=${offset}&limit=${limit}`,
    ),
  duplicates: (sessionId, offset, limit) =>
    request(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/duplicates?offset=${offset}&limit=${limit}`,
    ),
  previewInfo: (path) =>
    request("GET", `/api/preview-info?path=${encodeURIComponent(path)}`),
  thumbUrl: (path, width = 360, height = 240) =>
    `/api/thumb?path=${encodeURIComponent(path)}&w=${width}&h=${height}`,
};

const SESSION_EVENTS = [
  "hello",
  "state",
  "progress",
  "log",
  "analysis",
  "execution",
  "fix",
  "cancelled",
  "error",
];

/**
 * 一个会话的事件流。服务端在连接建立时会重放已缓冲事件，因此重连是安全的。
 * 回调注册：on(eventName, handler)；未注册的事件会被忽略。
 */
export class SessionStream {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.handlers = new Map();
    this.source = null;
    this.closed = false;
    this.connected = false;
    this.reconnectTimer = null;
  }

  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event).add(handler);
    return this;
  }

  emit(event, data) {
    const handlers = this.handlers.get(event);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error("会话事件处理失败", event, error);
      }
    }
  }

  connect() {
    this.close(false);
    this.closed = false;
    const source = new EventSource(`/api/session/${encodeURIComponent(this.sessionId)}/events`);
    this.source = source;
    source.addEventListener("open", () => {
      this.connected = true;
      this.emit("__connection", { connected: true });
    });
    source.addEventListener("error", () => {
      this.connected = false;
      this.emit("__connection", { connected: false });
      // EventSource 会自动重连；若已被服务端关闭则这里保持静默等待。
    });
    for (const name of SESSION_EVENTS) {
      source.addEventListener(name, (message) => {
        let payload = null;
        try {
          payload = message.data ? JSON.parse(message.data) : null;
        } catch (error) {
          console.error("无法解析 SSE 数据", name, error);
          return;
        }
        this.emit(name, payload);
      });
    }
    return this;
  }

  close(emit = true) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    const wasConnected = this.connected;
    this.connected = false;
    if (emit && wasConnected) {
      this.emit("__connection", { connected: false });
    }
  }
}

/** 删除会话（页面关闭时用 keepalive 尽力送达）。 */
export function deleteSessionKeepalive(sessionId) {
  try {
    fetch(`/api/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      keepalive: true,
    });
  } catch {
    // 页面卸载途中的失败无需处理。
  }
}
