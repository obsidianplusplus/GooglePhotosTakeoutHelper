/**
 * 模态框、Toast 与 iOS 风格警告/确认对话框。
 *
 * 若设计系统的 glass.js 提供了 window.Glass，则优先复用其动画与焦点管理；
 * 否则使用本文件的兜底实现，保证界面在任一模块缺失时仍可工作。
 */

import { byId, h, replaceChildren, $ } from "./dom.js";
import { icon } from "./icons.js";

let modalFallbackBound = false;

function glass() {
  return typeof window !== "undefined" ? window.Glass : null;
}

function bindFallbackModal() {
  if (modalFallbackBound) {
    return;
  }
  modalFallbackBound = true;
  document.addEventListener("click", (event) => {
    const closer = event.target instanceof Element ? event.target.closest("[data-modal-close], [data-alert-cancel]") : null;
    if (closer) {
      const modal = closer.closest(".g-modal");
      if (modal) {
        closeModal(modal);
        if (modal.id === "modal-alert") {
          resolveAlert(false);
        }
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // glass.js 正常加载时它会先关闭并派发 glass:modal-close；这里处理兜底路径。
      if (alertResolve) {
        resolveAlert(false);
        return;
      }
      const open = document.querySelector(".g-modal.is-open");
      if (open) {
        closeModal(open);
      }
    }
  });
}

export function openModal(target) {
  bindFallbackModal();
  const element = typeof target === "string" ? byId(target) : target;
  if (!element) {
    return;
  }
  const api = glass();
  if (api?.openModal) {
    api.openModal(element);
  } else {
    element.classList.add("is-open");
    element.setAttribute("aria-hidden", "false");
    document.body.classList.add("has-modal");
  }
}

export function closeModal(target) {
  const element = typeof target === "string" ? byId(target) : target;
  if (!element) {
    return;
  }
  const api = glass();
  if (api?.closeModal) {
    api.closeModal(element);
  } else {
    element.classList.remove("is-open");
    element.setAttribute("aria-hidden", "true");
    if (!document.querySelector(".g-modal.is-open")) {
      document.body.classList.remove("has-modal");
    }
  }
}

export function isModalOpen(target) {
  const element = typeof target === "string" ? byId(target) : target;
  return Boolean(element?.classList.contains("is-open"));
}

/* --------------------------------- toast --------------------------------- */

export function toast(message, options = {}) {
  const api = glass();
  if (api?.toast) {
    api.toast(message, options);
    return;
  }
  const host = byId("toast-host");
  if (!host) {
    return;
  }
  const node = h("div", { class: "g-toast", style: { opacity: "1", transform: "translateY(0)" } }, String(message));
  node.addEventListener("transitionend", () => node.remove());
  host.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(8px)";
    setTimeout(() => node.remove(), 400);
  }, options.duration ?? 2800);
}

/* ------------------------------- alert modal ------------------------------ */

let alertResolve = null;
let alertBound = false;

function resolveAlert(value) {
  const resolve = alertResolve;
  alertResolve = null;
  closeModal("modal-alert");
  if (resolve) {
    resolve(value);
  }
}

function bindAlert() {
  if (alertBound) {
    return;
  }
  alertBound = true;
  byId("alert-confirm")?.addEventListener("click", () => resolveAlert(true));
  byId("alert-cancel")?.addEventListener("click", () => resolveAlert(false));
  // glass.js 会先移除 .is-open 再派发 glass:modal-close（Esc / 遮罩点击）。
  // 必须在事件里结算 Promise，否则 alertDialog 会永久挂起。
  byId("modal-alert")?.addEventListener("glass:modal-close", () => {
    if (alertResolve) {
      const resolve = alertResolve;
      alertResolve = null;
      resolve(false);
    }
  });
}

/**
 * 显示警告/确认对话框。
 * @returns {Promise<boolean>} 确认返回 true；取消/ESC/点击遮罩返回 false。
 */
export function alertDialog(options = {}) {
  bindAlert();
  const {
    title = "提示",
    message = "",
    content = null,
    tone = "info", // info | warning | danger | success
    confirmText = "确定",
    cancelText = null,
    danger = false,
  } = options;
  const modal = byId("modal-alert");
  if (!modal) {
    // 极端兜底：模态框缺失时退回原生对话框。
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  byId("alert-title").textContent = title;
  const iconBox = byId("alert-icon");
  const iconName =
    tone === "danger" ? "error" : tone === "warning" ? "warning" : tone === "success" ? "check" : "info";
  iconBox.className = `alert-icon${tone === "warning" ? " is-warning" : tone === "danger" ? " is-danger" : ""}`;
  iconBox.innerHTML = icon(iconName);
  iconBox.hidden = false;
  const messageBox = byId("alert-message");
  if (content instanceof Node) {
    replaceChildren(messageBox, [content]);
  } else if (typeof content === "string") {
    messageBox.innerHTML = content;
  } else {
    messageBox.textContent = message;
  }
  const confirmButton = byId("alert-confirm");
  confirmButton.textContent = confirmText;
  confirmButton.className = danger ? "g-btn g-btn--danger" : "g-btn g-btn--primary";
  const cancelButton = byId("alert-cancel");
  cancelButton.hidden = cancelText === null;
  cancelButton.textContent = cancelText ?? "取消";
  openModal(modal);
  return new Promise((resolve) => {
    alertResolve = resolve;
    setTimeout(() => confirmButton.focus(), 60);
  });
}

export function confirmDialog(options = {}) {
  return alertDialog({
    confirmText: "继续",
    cancelText: "取消",
    ...options,
  });
}

/** 确认危险操作：默认焦点落在取消按钮上，降低误触。 */
export function confirmDanger(options = {}) {
  return alertDialog({
    confirmText: "确定继续",
    cancelText: "取消",
    tone: "warning",
    danger: true,
    ...options,
  });
}

export { $ };
