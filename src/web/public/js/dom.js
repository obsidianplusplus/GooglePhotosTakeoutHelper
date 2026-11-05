/** 轻量 DOM 工具（无框架、无依赖）。 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function byId(id) {
  return document.getElementById(id);
}

/** 创建元素：h("div", {class:"x", onclick:fn, text:"…"}, ...children) */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined) {
      continue;
    }
    if (key === "class" || key === "className") {
      node.className = value;
    } else if (key === "text") {
      node.textContent = value;
    } else if (key === "html") {
      node.innerHTML = value;
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else if (value !== false) {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
  return node;
}

export function replaceChildren(node, children) {
  clear(node);
  appendChildren(node, children);
  return node;
}

export function on(node, event, handler, options) {
  node.addEventListener(event, handler, options);
  return () => node.removeEventListener(event, handler, options);
}

export function delegate(root, event, selector, handler) {
  const listener = (nativeEvent) => {
    const target = nativeEvent.target instanceof Element ? nativeEvent.target.closest(selector) : null;
    if (target && root.contains(target)) {
      handler(nativeEvent, target);
    }
  };
  root.addEventListener(event, listener);
  return () => root.removeEventListener(event, listener);
}

export function setText(node, text) {
  if (node && node.textContent !== text) {
    node.textContent = text;
  }
}

export function setHidden(node, hidden) {
  if (node) {
    node.hidden = Boolean(hidden);
  }
}

export function toggleClass(node, name, force) {
  if (node) {
    node.classList.toggle(name, force);
  }
}

export function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}

export function debounce(fn, wait = 220) {
  let timer = null;
  return (...args) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/** 给元素内的 [data-icon] 注入图标（延迟导入，避免循环依赖）。 */
export async function hydrate(root = document) {
  const { hydrateIcons } = await import("./icons.js");
  hydrateIcons(root);
}
