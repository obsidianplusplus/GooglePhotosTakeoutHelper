/** 定高行虚拟滚动列表：用于重复组导航等可能上千条的场景。 */

import { rafThrottle } from "./dom.js";

export class VirtualList {
  /**
   * @param {HTMLElement} container 滚动容器
   * @param {{rowHeight?: number, overscan?: number, render: (item:any, index:number) => HTMLElement, onReachEnd?: () => void}} options
   */
  constructor(container, options) {
    this.container = container;
    this.rowHeight = options.rowHeight ?? 52;
    this.overscan = options.overscan ?? 8;
    this.render = options.render;
    this.onReachEnd = options.onReachEnd ?? null;
    this.items = [];
    this.selectedIndex = -1;
    this.inner = document.createElement("div");
    this.inner.className = "virtual-inner";
    this.inner.style.position = "relative";
    this.inner.style.width = "100%";
    container.append(this.inner);
    this.onScroll = rafThrottle(() => this.renderWindow());
    container.addEventListener("scroll", this.onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.renderWindow());
      this.resizeObserver.observe(container);
    }
    this.renderedStart = -1;
    this.renderedEnd = -1;
  }

  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    this.inner.style.height = `${this.items.length * this.rowHeight}px`;
    this.renderedStart = -1;
    this.renderedEnd = -1;
    const maxScroll = Math.max(0, this.items.length * this.rowHeight - this.container.clientHeight);
    if (this.container.scrollTop > maxScroll) {
      this.container.scrollTop = maxScroll;
    }
    this.renderWindow();
  }

  setSelected(index) {
    this.selectedIndex = index;
    this.renderWindow(true);
  }

  scrollToIndex(index) {
    const top = Math.max(0, index * this.rowHeight - this.container.clientHeight * 0.35);
    this.container.scrollTop = top;
    this.renderWindow(true);
  }

  renderWindow(force = false) {
    const total = this.items.length;
    if (!total) {
      this.inner.replaceChildren();
      this.renderedStart = -1;
      this.renderedEnd = -1;
      return;
    }
    const viewport = this.container.clientHeight || 400;
    const start = Math.max(0, Math.floor(this.container.scrollTop / this.rowHeight) - this.overscan);
    const end = Math.min(total, Math.ceil((this.container.scrollTop + viewport) / this.rowHeight) + this.overscan);
    if (!force && start === this.renderedStart && end === this.renderedEnd) {
      return;
    }
    this.renderedStart = start;
    this.renderedEnd = end;
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      let row;
      try {
        row = this.render(this.items[index], index);
      } catch (error) {
        console.error("虚拟列表行渲染失败", index, error);
        continue;
      }
      if (!row) {
        continue;
      }
      row.style.position = "absolute";
      row.style.top = `${index * this.rowHeight}px`;
      row.style.left = "0";
      row.style.right = "0";
      row.style.height = `${this.rowHeight}px`;
      row.dataset.index = String(index);
      if (index === this.selectedIndex) {
        row.classList.add("is-selected");
      }
      fragment.append(row);
    }
    this.inner.replaceChildren(fragment);
    if (this.onReachEnd && end >= total - this.overscan) {
      this.onReachEnd();
    }
  }

  destroy() {
    this.container.removeEventListener("scroll", this.onScroll);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.inner.remove();
  }
}
