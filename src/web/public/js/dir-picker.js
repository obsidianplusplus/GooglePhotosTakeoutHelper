/**
 * 目录选择器（Web 版 tkinter filedialog.askdirectory）。
 *
 * 支持：Windows 盘符 / 常用位置快捷入口、路径输入、上一级、显示隐藏目录、
 * 不可读目录提示，以及为尚未创建的输出目录直接输入路径。
 */

import { api } from "./api.js";
import { byId } from "./dom.js";
import { icon } from "./icons.js";
import { closeModal, openModal } from "./confirm.js";

const state = {
  initialized: false,
  onSelect: null,
  currentPath: "",
  showHidden: false,
  rootsLoaded: null,
  requestSeq: 0,
};

function el(id) {
  return byId(id);
}

export function initDirPicker() {
  if (state.initialized) {
    return;
  }
  state.initialized = true;

  el("dir-picker-context-close");
  el("dir-picker-up").addEventListener("click", () => {
    const parent = parentOf(state.currentPath);
    if (parent) {
      navigate(parent);
    }
  });
  el("dir-picker-go").addEventListener("click", () => {
    const value = el("dir-picker-path").value.trim();
    if (value) {
      navigate(value);
    }
  });
  el("dir-picker-path").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = el("dir-picker-path").value.trim();
      if (value) {
        navigate(value);
      }
    }
  });
  el("dir-picker-showhidden").addEventListener("change", () => {
    state.showHidden = el("dir-picker-showhidden").checked;
    if (state.currentPath) {
      navigate(state.currentPath);
    }
  });
  el("dir-picker-confirm").addEventListener("click", () => {
    const value = el("dir-picker-path").value.trim();
    if (!value) {
      showError("请先选择一个文件夹");
      return;
    }
    const callback = state.onSelect;
    state.onSelect = null;
    closeModal("modal-dir-picker");
    if (callback) {
      callback(value);
    }
  });
  el("dir-picker-list").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      el("dir-picker-confirm").click();
    }
  });
}

function parentOf(path) {
  if (!path) {
    return null;
  }
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index < 0) {
    return null;
  }
  if (index === 0) {
    return normalized.slice(0, 1);
  }
  // Windows 盘符根目录 C:\ 没有父级
  if (index === 2 && normalized[1] === ":") {
    const rest = normalized.slice(0, 3);
    return rest;
  }
  return normalized.slice(0, index);
}

function showError(message) {
  const node = el("dir-picker-error");
  node.textContent = message ?? "";
  node.hidden = !message;
}

function renderQuickAccess(payload) {
  const host = el("dir-picker-quick");
  host.replaceChildren();
  const items = [];
  for (const root of payload?.roots ?? []) {
    items.push({ name: root.name ?? root.path, path: root.path, icon: "desktop" });
  }
  for (const quick of payload?.quickAccess ?? []) {
    items.push({ name: quick.name, path: quick.path, icon: quick.kind === "home" ? "home" : quickIcon(quick.kind) });
  }
  for (const item of items) {
    if (!item.path) {
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dir-picker-chip";
    button.innerHTML = `${icon(item.icon)}<span></span>`;
    button.querySelector("span").textContent = item.name;
    button.title = item.path;
    button.addEventListener("click", () => navigate(item.path));
    host.append(button);
  }
}

function quickIcon(kind) {
  switch (kind) {
    case "desktop":
      return "desktop";
    case "downloads":
      return "downloads";
    case "pictures":
      return "pictures";
    case "documents":
      return "documents";
    default:
      return "folder";
  }
}

async function loadRoots() {
  if (!state.rootsLoaded) {
    state.rootsLoaded = api.fsRoots().catch((error) => {
      state.rootsLoaded = null;
      throw error;
    });
  }
  try {
    const payload = await state.rootsLoaded;
    renderQuickAccess(payload);
  } catch (error) {
    renderQuickAccess({ roots: [], quickAccess: [] });
  }
}

function renderEntries(payload) {
  const host = el("dir-picker-list");
  host.replaceChildren();
  const entries = payload?.entries ?? [];
  const parent = payload?.parent ?? parentOf(payload?.path ?? state.currentPath);

  if (parent) {
    const up = document.createElement("button");
    up.type = "button";
    up.className = "dir-entry";
    up.innerHTML = `<span class="dir-entry__icon is-up">${icon("chevron-left")}</span><span class="dir-entry__name">..（上一级）</span>`;
    up.addEventListener("click", () => navigate(parent));
    host.append(up);
  }

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "dir-entry is-disabled";
    empty.style.cursor = "default";
    empty.innerHTML = `<span class="dir-entry__icon is-up">${icon("folder")}</span><span class="dir-entry__name">该目录下没有子文件夹</span>`;
    host.append(empty);
  }

  for (const entry of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dir-entry";
    row.dataset.path = entry.path;
    const badge = entry.isDir ? icon("folder") : icon("photo");
    row.innerHTML = `<span class="dir-entry__icon${entry.isDir ? "" : " is-up"}">${badge}</span><span class="dir-entry__name"></span>`;
    row.querySelector(".dir-entry__name").textContent = entry.name;
    row.title = entry.path;
    if (entry.isDir) {
      row.addEventListener("click", () => navigate(entry.path));
    } else {
      row.addEventListener("click", () => {
        el("dir-picker-path").value = entry.path;
        updateSelected(entry.path);
      });
    }
    host.append(row);
  }
  host.scrollTop = 0;
}

function updateSelected(path) {
  el("dir-picker-selected").textContent = path || "未选择文件夹";
  el("dir-picker-selected").title = path || "";
}

async function navigate(path, { quiet = false } = {}) {
  const seq = ++state.requestSeq;
  showError("");
  if (!quiet) {
    el("dir-picker-path").value = path;
  }
  let payload;
  try {
    payload = await api.fsList(path, { showHidden: state.showHidden, type: "dir" });
  } catch (error) {
    if (seq !== state.requestSeq) {
      return;
    }
    showError(error.message ?? "无法读取该目录");
    // 仍允许用户直接使用输入的路径（输出目录可能尚未创建）。
    updateSelected(path);
    return;
  }
  if (seq !== state.requestSeq) {
    return;
  }
  state.currentPath = payload.path ?? path;
  el("dir-picker-path").value = state.currentPath;
  updateSelected(state.currentPath);
  renderEntries(payload);
  el("dir-picker-up").disabled = !payload.parent;
}

export async function openDirPicker(options = {}) {
  initDirPicker();
  const {
    title = "选择文件夹",
    subtitle = "浏览本机目录",
    initial = "",
    onSelect = null,
  } = options;
  el("dir-picker-title").textContent = title;
  el("dir-picker-subtitle").textContent = subtitle;
  state.onSelect = onSelect;
  state.showHidden = false;
  el("dir-picker-showhidden").checked = false;
  el("dir-picker-path").value = initial ?? "";
  updateSelected(initial ?? "");
  openModal("modal-dir-picker");
  loadRoots();
  const startPath = initial?.trim() || "";
  if (startPath) {
    await navigate(startPath, { quiet: true });
  } else {
    try {
      const payload = await api.fsRoots();
      const first = payload?.quickAccess?.[0]?.path ?? payload?.roots?.[0]?.path;
      if (first) {
        await navigate(first, { quiet: true });
      }
    } catch (error) {
      showError(error.message ?? "无法读取本机目录");
    }
  }
  setTimeout(() => el("dir-picker-path")?.focus(), 80);
}

export function closeDirPicker() {
  state.onSelect = null;
  closeModal("modal-dir-picker");
}
