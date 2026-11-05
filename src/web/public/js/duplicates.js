/**
 * 重复项只读对比（移植 历史 Python v4.1 参考实现 的交互语义）。
 *
 * 左侧为按“可回收空间 → 副本数 → 摘要”排序的重复组列表；右侧固定显示主文件，
 * 并可逐个切换同组其它副本。缩略图按需加载，失败时显示不依赖图标字体的信息卡。
 * 任何操作都不会删除/替换文件；此窗口仅用于核对。
 */

import { api } from "./api.js";
import { closeModal, isModalOpen, openModal } from "./confirm.js";
import { byId, replaceChildren } from "./dom.js";
import {
  dateSourceLabel,
  defaultReason,
  dispositionLabel,
  formatBytes,
  formatDateTime,
  formatCount,
  dateTimeText,
} from "./format.js";
import { icon } from "./icons.js";
import { VirtualList } from "./virtual.js";

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".3gp",
  ".3g2", ".mts", ".m2ts", ".mpeg", ".mpg", ".vob", ".ts", ".ogv", ".asf",
]);

const THUMB_BOUNDS = [360, 240];
const GROUP_BATCH = 500;

const state = {
  sessionId: null,
  groups: [],
  groupIndex: 0,
  memberIndex: 0,
  list: null,
  tokens: { primary: 0, compare: 0 },
  objectUrls: { primary: null, compare: null },
  initialized: false,
  loading: false,
};

function el(id) {
  return byId(id);
}

export function initDuplicates() {
  if (state.initialized) {
    return;
  }
  state.initialized = true;
  el("dup-prev-group").addEventListener("click", () => changeGroup(-1));
  el("dup-next-group").addEventListener("click", () => changeGroup(1));
  el("dup-prev-member").addEventListener("click", () => changeMember(-1));
  el("dup-next-member").addEventListener("click", () => changeMember(1));
  el("dup-group-list").addEventListener("click", (event) => {
    const item = event.target instanceof Element ? event.target.closest(".dup-group-item") : null;
    if (!item) {
      return;
    }
    const index = Number(item.dataset.index);
    if (Number.isInteger(index) && index !== state.groupIndex) {
      selectGroup(index);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!isModalOpen("modal-duplicates")) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      changeMember(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      changeMember(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      changeGroup(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      changeGroup(1);
    }
  });
  window.addEventListener("beforeunload", releaseObjectUrls);
}

function releaseObjectUrls() {
  for (const side of ["primary", "compare"]) {
    if (state.objectUrls[side]) {
      URL.revokeObjectURL(state.objectUrls[side]);
      state.objectUrls[side] = null;
    }
  }
}

/** 打开对比窗口并（分批）拉取全部重复组摘要。 */
export async function openDuplicates({ sessionId }) {
  initDuplicates();
  state.sessionId = sessionId;
  state.groups = [];
  state.groupIndex = 0;
  state.memberIndex = 0;
  state.tokens = { primary: 0, compare: 0 };
  releaseObjectUrls();
  showEmptyState("正在加载重复组…");
  openModal("modal-duplicates");
  if (state.list) {
    state.list.destroy();
    state.list = null;
  }
  await loadGroups(sessionId);
}

export function closeDuplicates() {
  closeModal("modal-duplicates");
  releaseObjectUrls();
  state.loading = false;
  state.groups = [];
  if (state.list) {
    state.list.destroy();
    state.list = null;
  }
}

async function loadGroups(sessionId) {
  state.loading = true;
  const loadingNode = el("dup-group-loading");
  loadingNode.hidden = false;
  loadingNode.textContent = "正在加载重复组…";
  const all = [];
  try {
    let offset = 0;
    let total = null;
    for (;;) {
      const result = await api.duplicates(sessionId, offset, GROUP_BATCH);
      if (state.sessionId !== sessionId) {
        return;
      }
      total = result.total ?? total;
      const rows = result.rows ?? [];
      all.push(...rows);
      offset = (result.offset ?? offset) + rows.length;
      loadingNode.textContent = `正在加载重复组 ${formatCount(offset)} / ${formatCount(total ?? offset)}…`;
      if (rows.length === 0 || (total !== null && offset >= total)) {
        break;
      }
    }
  } catch (error) {
    loadingNode.textContent = `重复组加载失败：${error.message}`;
    state.loading = false;
    showEmptyState(`无法加载重复组：${error.message}`);
    return;
  }
  state.loading = false;
  state.groups = sortGroups(all);
  loadingNode.hidden = true;
  renderSummary();
  if (!state.groups.length) {
    showEmptyState("本次分析没有可对比的重复组");
    return;
  }
  const listContainer = el("dup-group-list");
  state.list = new VirtualList(listContainer, {
    rowHeight: 54,
    render: (group, index) => renderGroupItem(group, index),
  });
  state.list.setItems(state.groups);
  selectGroup(0);
}

function sortGroups(groups) {
  return groups.slice().sort((left, right) => {
    const reclaim = (right.reclaimable_bytes ?? 0) - (left.reclaimable_bytes ?? 0);
    if (reclaim !== 0) {
      return reclaim;
    }
    const redundant = (right.redundant_count ?? 0) - (left.redundant_count ?? 0);
    if (redundant !== 0) {
      return redundant;
    }
    return String(left.digest ?? "").localeCompare(String(right.digest ?? ""));
  });
}

function renderSummary() {
  const groupCount = state.groups.length;
  let copies = 0;
  let skipped = 0;
  for (const group of state.groups) {
    copies += group.redundant_count ?? 0;
    skipped += group.skipped_count ?? 0;
  }
  el("dup-summary-groups").textContent = formatCount(groupCount);
  el("dup-summary-copies").textContent = formatCount(copies);
  el("dup-summary-skipped").textContent = formatCount(skipped);
}

function renderGroupItem(group, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dup-group-item";
  button.dataset.index = String(index);
  const albumNames = [...new Set((group.members ?? []).map((member) => member.album).filter(Boolean))].sort();
  const source =
    albumNames.length === 1
      ? albumNames[0]
      : albumNames.length === 0
        ? "时间线"
        : `${albumNames.length} 个相册`;
  const title = document.createElement("div");
  title.className = "dup-group-item__title";
  title.textContent = `#${String(index + 1).padStart(3, "0")}  ${(group.members ?? []).length} 个文件`;
  const meta = document.createElement("div");
  meta.className = "dup-group-item__meta";
  meta.textContent = `${formatBytes(group.size)} · ${source}`;
  button.append(title, meta);
  return button;
}

function splitGroup(group) {
  const members = group.members ?? [];
  let primary = members.find((member) => member.path === group.primary_path) ?? null;
  if (!primary) {
    primary = members.find((member) => member.disposition === "primary") ?? members[0] ?? null;
  }
  const comparisons = members.filter((member) => member !== primary);
  return { primary, comparisons };
}

function selectGroup(index) {
  if (!state.groups.length) {
    return;
  }
  const target = Math.min(Math.max(index, 0), state.groups.length - 1);
  state.groupIndex = target;
  state.memberIndex = 0;
  const group = state.groups[target];
  const { primary, comparisons } = splitGroup(group);
  if (state.list) {
    state.list.setSelected(target);
    state.list.scrollToIndex(target);
  }
  el("dup-group-position").textContent = `${target + 1} / ${state.groups.length}`;
  el("dup-prev-group").disabled = target <= 0;
  el("dup-next-group").disabled = target >= state.groups.length - 1;
  el("dup-group-summary").textContent =
    `重复组 #${String(target + 1).padStart(3, "0")}  ·  ${(group.members ?? []).length} 个物理文件  ·  ` +
    `${group.is_live_photo ? "单组" : "单文件"} ${formatBytes(group.size)}  ·  ` +
    `同来源跳过 ${group.skipped_count ?? 0} 个`;
  updateMemberNav(comparisons);
  if (!primary) {
    showSideMessage("primary", "未记录主文件", "该重复组缺少可对比的主文件。");
  }
  if (!comparisons.length) {
    showSideMessage("compare", "没有其它副本", "该重复组没有可显示的对比成员。");
  }
  const loads = [];
  if (primary) {
    loads.push(loadSide("primary", primary, group));
  } else {
    setPendingState("primary");
  }
  if (comparisons.length) {
    loads.push(loadSide("compare", comparisons[0], group));
  } else {
    setPendingState("compare");
  }
  Promise.allSettled(loads);
}

function updateMemberNav(comparisons) {
  const total = comparisons.length;
  el("dup-member-position").textContent = total ? `${state.memberIndex + 1} / ${total}` : "0 / 0";
  el("dup-prev-member").disabled = state.memberIndex <= 0;
  el("dup-next-member").disabled = state.memberIndex >= total - 1;
}

function changeGroup(delta) {
  if (state.loading) {
    return;
  }
  selectGroup(state.groupIndex + delta);
}

function changeMember(delta) {
  const group = state.groups[state.groupIndex];
  if (!group) {
    return;
  }
  const { comparisons } = splitGroup(group);
  if (!comparisons.length) {
    return;
  }
  state.memberIndex = Math.min(Math.max(state.memberIndex + delta, 0), comparisons.length - 1);
  updateMemberNav(comparisons);
  loadSide("compare", comparisons[state.memberIndex], group);
}

function showEmptyState(message) {
  el("dup-group-position").textContent = "0 / 0";
  el("dup-prev-group").disabled = true;
  el("dup-next-group").disabled = true;
  el("dup-group-summary").textContent = message;
  const listHost = el("dup-group-list");
  if (!state.list) {
    listHost.replaceChildren();
  }
  if (state.groups.length === 0) {
    showSideMessage("primary", "没有重复项", "完成一次扫描后，可在这里核对主文件。");
    showSideMessage("compare", "没有重复项", "重复副本不会在此窗口中被修改或删除。");
  }
}

/* ------------------------------- 单侧渲染 -------------------------------- */

function sideElements(side) {
  return {
    thumb: el(`dup-${side === "primary" ? "primary" : "compare"}-thumb`),
    details: el(`dup-${side === "primary" ? "primary" : "compare"}-details`),
    freshness: el(`dup-${side === "primary" ? "primary" : "compare"}-freshness`),
  };
}

function setFreshness(side, stateName, text) {
  const node = sideElements(side).freshness;
  node.className = "g-badge";
  if (stateName === "fresh") {
    node.classList.add("is-success");
    node.textContent = "与扫描时一致";
  } else if (stateName === "stale") {
    node.classList.add("is-warning");
    node.textContent = "扫描后已变化";
  } else if (stateName === "missing") {
    node.classList.add("is-error");
    node.textContent = "文件已不存在";
  } else if (stateName === "pending") {
    node.classList.add("is-info");
    node.textContent = "正在检查…";
  } else {
    node.classList.add("is-muted");
    node.textContent = "无法确认新旧";
  }
  if (text) {
    node.title = text;
  } else {
    node.removeAttribute("title");
  }
}

function thumbPlaceholder(html) {
  const node = document.createElement("div");
  node.className = "dup-thumb-placeholder";
  node.innerHTML = html;
  return node;
}

function setPendingState(side) {
  const { thumb, details } = sideElements(side);
  replaceChildren(thumb, [thumbPlaceholder("…\n正在生成预览")]);
  replaceChildren(details, []);
  setFreshness(side, "pending");
}

function showSideMessage(side, title, message) {
  releaseObjectUrl(side);
  const { thumb, details, freshness } = sideElements(side);
  replaceChildren(thumb, [thumbPlaceholder(`${escapeText(message)}`)]);
  replaceChildren(details, []);
  freshness.className = "g-badge is-muted";
  freshness.textContent = "无可用文件";
  freshness.title = title;
}

function escapeText(value) {
  const node = document.createElement("span");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

function releaseObjectUrl(side) {
  if (state.objectUrls[side]) {
    URL.revokeObjectURL(state.objectUrls[side]);
    state.objectUrls[side] = null;
  }
}

async function loadSide(side, member, group) {
  const token = ++state.tokens[side];
  releaseObjectUrl(side);
  const { thumb, details } = sideElements(side);
  setPendingState(side);
  replaceChildren(details, [
    detailRow("文件", member.path.split(/[\\/]/).pop(), { strong: true }),
    detailRow("完整路径", member.path, { wrap: true }),
  ]);
  if (!member || !member.path) {
    showSideMessage(side, "没有对比成员", "该重复组没有可显示的对比成员。");
    return;
  }

  const [infoSettled, thumbSettled] = await Promise.allSettled([
    api.previewInfo(member.path),
    fetchThumbnail(member.path),
  ]);
  if (token !== state.tokens[side]) {
    return;
  }
  const info = infoSettled.status === "fulfilled" ? infoSettled.value : null;
  const infoError = infoSettled.status === "rejected" ? infoSettled.reason?.message : "";
  const thumbResult = thumbSettled.status === "fulfilled" ? thumbSettled.value : { ok: false, meta: {} };
  const detailsData = info ?? {
    path: member.path,
    exists: false,
    sizeBytes: null,
    mtimeMs: null,
    mimeType: null,
    decodedFormat: null,
    rawSize: null,
    displaySize: null,
    frameCount: null,
    error: infoError || "无法读取文件信息",
  };

  const { staleState, staleMessage } = detectStale(member, detailsData);
  setFreshness(side, staleState, staleMessage);
  renderThumbnail(side, member, detailsData, thumbResult);
  renderDetails(side, member, group, detailsData, thumbResult, staleMessage);
}

async function fetchThumbnail(path) {
  let response;
  try {
    response = await fetch(api.thumbUrl(path, THUMB_BOUNDS[0], THUMB_BOUNDS[1]));
  } catch (error) {
    return { ok: false, meta: { status: "corrupt", error: `无法请求缩略图：${error.message}` } };
  }
  if (response.ok) {
    try {
      const blob = await response.blob();
      return { ok: true, blob };
    } catch (error) {
      return { ok: false, meta: { status: "corrupt", error: `无法读取缩略图：${error.message}` } };
    }
  }
  let meta = {};
  try {
    meta = await response.json();
  } catch {
    meta = { status: "corrupt", error: `缩略图请求失败（HTTP ${response.status}）` };
  }
  return { ok: false, meta };
}

function renderThumbnail(side, member, details, thumbResult) {
  const { thumb } = sideElements(side);
  if (thumbResult.ok && thumbResult.blob) {
    releaseObjectUrl(side);
    const url = URL.createObjectURL(thumbResult.blob);
    state.objectUrls[side] = url;
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.loading = "eager";
    img.addEventListener("error", () => {
      replaceChildren(thumb, [thumbPlaceholder(escapeText(placeholderText(member, details, thumbResult.meta, "")))]);
    });
    img.src = url;
    replaceChildren(thumb, [img]);
    return;
  }
  const placeholder = placeholderText(member, details, thumbResult.meta, thumbResult.meta?.error ?? "");
  const node = thumbPlaceholder("");
  const iconName = iconForPlaceholder(member, thumbResult.meta);
  node.innerHTML = `${icon(iconName)}<span>${escapeText(placeholder)}</span>`;
  node.style.gap = "10px";
  replaceChildren(thumb, [node]);
}

function iconForPlaceholder(member, meta) {
  const suffix = extensionOf(member.path);
  if (VIDEO_EXTENSIONS.has(suffix) || meta?.status === "not-image") {
    return "play";
  }
  if (meta?.status === "missing") {
    return "warning";
  }
  if (meta?.status === "unsupported") {
    return "photo";
  }
  return "error";
}

function extensionOf(path) {
  const name = String(path ?? "");
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function placeholderText(member, details, meta, imageError) {
  const suffix = extensionOf(member.path).replace(".", "").toUpperCase() || "未知格式";
  if (imageError) {
    return `图片预览不可用\n${imageError}`;
  }
  const status = meta?.status ?? "";
  if (status === "missing") {
    return "文件已不存在\n无法生成预览";
  }
  if (VIDEO_EXTENSIONS.has(extensionOf(member.path)) || status === "not-image") {
    return `▶\n${suffix} 视频 / 媒体文件\n内置预览不解码视频`;
  }
  if (status === "unsupported") {
    return `${suffix} 图片\n当前图像解码器不支持预览\n文件仍可正常参与哈希比较`;
  }
  if (status === "too-large") {
    return `图片尺寸过大\n为保护内存已跳过预览\n${meta.error ?? ""}`.trim();
  }
  if (status === "corrupt") {
    return `图片损坏或无法解码\n${meta.error ?? "无法生成安全缩略图"}`;
  }
  return meta?.error || "此文件无法生成内置预览";
}

function detectStale(member, details) {
  if (!details.exists) {
    return { staleState: "missing", staleMessage: "文件在扫描后已被移动、删除或当前不可访问。" };
  }
  const changes = [];
  const currentSize = details.sizeBytes ?? details.size ?? null;
  if (currentSize !== null && currentSize !== member.size) {
    changes.push(`大小从 ${formatBytes(member.size)} 变为 ${formatBytes(currentSize)}`);
  }
  const currentMtimeMs = details.mtimeMs ?? null;
  if (member.modified_ns !== null && member.modified_ns !== undefined && currentMtimeMs !== null) {
    const scannedMs = member.modified_ns / 1e6;
    if (Math.abs(currentMtimeMs - scannedMs) > 1) {
      changes.push("最后修改时间发生变化");
    }
  }
  if (changes.length) {
    return {
      staleState: "stale",
      staleMessage: `已${changes.join("；")}。扫描时的 SHA-256 可能已不再代表当前内容。`,
    };
  }
  if (member.modified_ns === null || member.modified_ns === undefined) {
    return {
      staleState: "unknown",
      staleMessage: "扫描时未记录纳秒修改时间；当前大小仍与扫描快照一致。",
    };
  }
  return { staleState: "fresh", staleMessage: "文件大小和纳秒修改时间均与扫描快照一致。" };
}

function detailRow(label, value, options = {}) {
  const row = document.createElement("div");
  row.className = "g-detail-row";
  const labelNode = document.createElement("span");
  labelNode.className = "g-detail-row__label";
  labelNode.textContent = label;
  const valueNode = document.createElement("div");
  valueNode.className = "g-detail-row__value";
  if (options.strong) {
    valueNode.style.fontWeight = "650";
  }
  if (options.mono) {
    valueNode.style.fontFamily = "var(--font-mono)";
    valueNode.style.fontSize = "10.5px";
    valueNode.style.overflowWrap = "anywhere";
  }
  if (options.warning) {
    valueNode.style.color = "var(--warning)";
  }
  valueNode.textContent = value ?? "";
  row.append(labelNode, valueNode);
  return row;
}

function renderDetails(side, member, group, details, thumbResult, staleMessage) {
  const { details: host } = sideElements(side);
  const rows = [];
  rows.push(detailRow("文件名", basename(member.path), { strong: true }));
  rows.push(detailRow("完整路径", member.path, { wrap: true }));
  const companionRow = document.createElement("div");
  if (member.companion_path) {
    companionRow.className = "g-detail-row";
    companionRow.innerHTML = `<span class="g-detail-row__label">实况动态片段</span><div class="g-detail-row__value">${escapeText(member.companion_path)}\n大小：<span data-companion-size>读取中…</span></div>`;
    rows.push(companionRow);
  }
  rows.push(detailRow("来源相册", member.album || "时间线 / 年份目录"));
  const currentSize = details.sizeBytes ?? details.size ?? member.size;
  let sizeText = formatBytes(currentSize);
  if (details.sizeBytes != null && details.sizeBytes !== member.size) {
    sizeText += `（扫描时 ${formatBytes(member.size)}）`;
  }
  rows.push(detailRow("文件大小", sizeText));
  const fallbackFormat = extensionOf(member.path).replace(".", "").toUpperCase() || "未知";
  const decodedFormat =
    thumbResult.meta?.decodedFormat ?? details.decodedFormat ?? details.mimeType ?? fallbackFormat;
  const displaySize = thumbResult.meta?.displaySize ?? details.displaySize;
  const dimensions = Array.isArray(displaySize) && displaySize.length >= 2 ? `${displaySize[0]} × ${displaySize[1]}` : "不可用";
  rows.push(detailRow("格式 / 分辨率", `${decodedFormat} · ${dimensions}`));

  let modifiedText = "不可用";
  if (details.mtimeMs != null) {
    modifiedText = formatDateTime(new Date(details.mtimeMs));
  }
  if (member.modified_ns != null) {
    const scannedDate = new Date(member.modified_ns / 1e6);
    const scannedText = formatDateTime(scannedDate);
    if (details.mtimeMs == null || Math.abs(details.mtimeMs - member.modified_ns / 1e6) > 1) {
      modifiedText += `\n扫描时：${scannedText}`;
    }
  }
  rows.push(detailRow("修改时间", modifiedText, { wrap: true }));

  const dateText = group.date_taken ? dateTimeText(group.date_taken) : "未知";
  rows.push(
    detailRow("采用拍摄日期", `${dateText}\n来源：${group.date_source ? dateSourceLabel(group.date_source) : "无"}`, {
      wrap: true,
    }),
  );
  rows.push(
    detailRow(group.is_live_photo ? "复合 SHA-256" : "完整 SHA-256", group.digest, { mono: true, wrap: true }),
  );
  const reason = String(member.reason ?? "").trim() || defaultReason(member.disposition);
  rows.push(detailRow("处理状态", `${dispositionLabel(member.disposition)}\n${reason}`, { wrap: true }));
  rows.push(detailRow("陈旧检测", staleMessage, { wrap: true }));
  if (details.error) {
    rows.push(detailRow("文件检查", details.error, { wrap: true, warning: true }));
  }
  if (thumbResult.meta?.error && !thumbResult.ok) {
    rows.push(detailRow("预览说明", thumbResult.meta.error, { wrap: true, warning: true }));
  }
  replaceChildren(host, rows);

  if (member.companion_path) {
    api
      .previewInfo(member.companion_path)
      .then((companionInfo) => {
        const target = dataOwner(companionRow, "companionSize");
        if (!target) {
          return;
        }
        target.textContent = companionInfo?.exists ? formatBytes(companionInfo.size ?? companionInfo.sizeBytes) : "不可用";
      })
      .catch(() => {
        const target = dataOwner(companionRow, "companionSize");
        if (target) {
          target.textContent = "不可用";
        }
      });
  }
}

function dataOwner(node, name) {
  return node.querySelector(`[data-${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}]`);
}

function basename(path) {
  const value = String(path ?? "");
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return index >= 0 ? value.slice(index + 1) : value;
}

export { basename };
