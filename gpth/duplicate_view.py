"""重复文件的只读对比预览弹窗。"""

from __future__ import annotations

import logging
import os
import queue
import threading
from collections import OrderedDict
from concurrent.futures import CancelledError as FutureCancelledError
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from functools import partial
from io import BytesIO
from pathlib import Path
from tkinter import ttk
from typing import Any

import customtkinter as ctk
from PIL import Image

from .constants import VIDEO_EXTENSIONS
from .duplicates import (
    DuplicateFileDetails,
    ThumbnailResult,
    ThumbnailStatus,
    build_thumbnail,
    inspect_duplicate_file,
)
from .models import DateSource, DuplicateDisposition, DuplicateGroup, DuplicateMember

LOGGER = logging.getLogger(__name__)

PRIMARY = "#4F46E5"
PRIMARY_HOVER = "#4338CA"
CARD_COLOR = ("#FFFFFF", "#172033")
PANEL_COLOR = ("#F7F8FA", "#111827")
WINDOW_COLOR = ("#EEF2F7", "#0B1220")
MUTED_TEXT = ("#667085", "#AAB3C2")
BODY_TEXT = ("#273142", "#F2F4F7")
SOFT_BORDER = ("#E4E7EC", "#344054")

GREEN_BG = ("#E7F8F1", "#173E35")
GREEN_TEXT = ("#087A58", "#72E0BD")
AMBER_BG = ("#FFF3D6", "#493719")
AMBER_TEXT = ("#9A5B00", "#F6C96B")
RED_BG = ("#FDEBEC", "#482327")
RED_TEXT = ("#B42318", "#FDA29B")
BLUE_BG = ("#E9EDFF", "#29325B")
BLUE_TEXT = ("#3E49B8", "#C7D2FE")
GRAY_BG = ("#EEF1F5", "#273142")
GRAY_TEXT = ("#475467", "#D0D5DD")

THUMBNAIL_BOUNDS = (360, 240)
CACHE_MAX_ENTRIES = 64
CACHE_MAX_PNG_BYTES = 24 * 1024 * 1024

DISPOSITION_LABELS = {
    DuplicateDisposition.PRIMARY: "主文件",
    DuplicateDisposition.ALBUM_COPY: "相册来源",
    DuplicateDisposition.SKIPPED: "同来源跳过",
    DuplicateDisposition.FILTERED: "额外版本过滤",
}

DATE_SOURCE_LABELS = {
    DateSource.JSON: "Google Photos JSON",
    DateSource.EXIF: "照片 EXIF",
    DateSource.FILENAME: "文件名推断",
    DateSource.AGGRESSIVE_JSON: "深度匹配 JSON",
    DateSource.FILE_MTIME: "文件修改时间",
}


@dataclass(frozen=True, slots=True)
class _CacheKey:
    """缓存键包含当前文件快照，文件变化后会自然失效。"""

    path: str
    size: int | None
    modified_ns: int | None
    bounds: tuple[int, int]


@dataclass(frozen=True, slots=True)
class _RequestKey:
    """进行中请求按路径和目标尺寸合并，避免重复解码同一文件。"""

    path: str
    bounds: tuple[int, int]


@dataclass(frozen=True, slots=True)
class _CachedPreview:
    """只缓存与 Tk 无关的文件详情和 PNG 字节。"""

    details: DuplicateFileDetails
    thumbnail: ThumbnailResult

    @property
    def png_bytes(self) -> int:
        return len(self.thumbnail.png_bytes or b"")


@dataclass(frozen=True, slots=True)
class _Waiter:
    """共享文件请求完成后需要通知的某一侧最新请求。"""

    side: str
    token: int
    group_index: int
    member_key: tuple[Any, ...]
    member: DuplicateMember


@dataclass(slots=True)
class _PendingLoad:
    """一个后台 Future 及复用它的左右侧请求。"""

    future: Future[_CachedPreview]
    waiters: list[_Waiter]


@dataclass(frozen=True, slots=True)
class _LoadedPreview:
    """等待主线程渲染的一侧最终结果。"""

    side: str
    token: int
    group_index: int
    member_key: tuple[Any, ...]
    member: DuplicateMember
    cached: _CachedPreview
    stale_state: str
    stale_message: str
    worker_error: str = ""


class _BoundedPreviewCache:
    """按条目数和 PNG 总字节双重约束的线程安全 LRU。"""

    def __init__(self, max_entries: int, max_png_bytes: int) -> None:
        self.max_entries = max(int(max_entries), 1)
        self.max_png_bytes = max(int(max_png_bytes), 0)
        self._items: OrderedDict[_CacheKey, _CachedPreview] = OrderedDict()
        self._png_bytes = 0
        self._closed = False
        self._lock = threading.Lock()

    def get(self, key: _CacheKey) -> _CachedPreview | None:
        with self._lock:
            if self._closed:
                return None
            value = self._items.get(key)
            if value is not None:
                self._items.move_to_end(key)
            return value

    def put(self, key: _CacheKey, value: _CachedPreview) -> None:
        with self._lock:
            if self._closed:
                return
            old = self._items.pop(key, None)
            if old is not None:
                self._png_bytes -= old.png_bytes
            # 单张 PNG 已超过总预算时不缓存，仍可正常返回本次结果。
            if value.png_bytes > self.max_png_bytes and value.png_bytes > 0:
                return
            self._items[key] = value
            self._png_bytes += value.png_bytes
            while self._items and (
                len(self._items) > self.max_entries or self._png_bytes > self.max_png_bytes
            ):
                _discarded_key, discarded = self._items.popitem(last=False)
                self._png_bytes -= discarded.png_bytes

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._png_bytes = 0

    def close(self) -> None:
        """清空缓存并禁止关闭后仍在运行的 worker 重新写入。"""

        with self._lock:
            self._closed = True
            self._items.clear()
            self._png_bytes = 0

    def snapshot(self) -> tuple[int, int]:
        """返回测试和诊断所需的条目数与 PNG 总字节。"""

        with self._lock:
            return len(self._items), self._png_bytes


@dataclass(slots=True)
class _SideWidgets:
    """一侧预览卡片中需要动态更新的控件与图像引用。"""

    title: ctk.CTkLabel
    position: ctk.CTkLabel
    previous_button: ctk.CTkButton | None
    next_button: ctk.CTkButton | None
    freshness: ctk.CTkLabel
    preview: ctk.CTkLabel
    details: ctk.CTkScrollableFrame
    image_ref: ctk.CTkImage | None = None


class DuplicatePreviewDialog(ctk.CTkToplevel):
    """以固定主文件和当前副本双栏显示重复组，且不修改任何数据。"""

    def __init__(self, master: Any, groups: list[DuplicateGroup]) -> None:
        super().__init__(master)
        self.title("重复项对比 · PhotoTakeout Studio")
        self.geometry("1060x700")
        self.minsize(900, 600)
        self.configure(fg_color=WINDOW_COLOR)
        self.transient(master)

        self._groups = tuple(
            sorted(
                groups,
                key=lambda group: (
                    -group.reclaimable_bytes,
                    -group.redundant_count,
                    group.digest,
                ),
            )
        )
        self._group_index = 0
        self._member_index = 0
        self._closed = False
        self._suppress_tree_event = False
        self._result_queue: queue.Queue[_LoadedPreview] = queue.Queue()
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="duplicate-preview")
        self._futures: set[Future[_CachedPreview]] = set()
        self._pending: dict[_RequestKey, _PendingLoad] = {}
        self._side_tokens = {"primary": 0, "compare": 0}
        self._side_member_keys: dict[str, tuple[Any, ...] | None] = {
            "primary": None,
            "compare": None,
        }
        self._cache = _BoundedPreviewCache(CACHE_MAX_ENTRIES, CACHE_MAX_PNG_BYTES)
        # Future.cancel() 可能同步触发回调；使用可重入锁避免取消路径自锁。
        self._state_lock = threading.RLock()
        self._poll_after_id: str | None = None
        self._side_widgets: dict[str, _SideWidgets] = {}

        self._build_ui()
        self._configure_tree_style()
        self._populate_groups()
        self.protocol("WM_DELETE_WINDOW", self.close)
        self.bind("<Escape>", lambda _event: self.close())

        self._poll_after_id = self.after(60, self._drain_results)
        if self._groups:
            self.after(20, lambda: self._select_group(0))
        else:
            self._show_empty_state()
        try:
            self.grab_set()
            self.focus_force()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # 页面结构
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)

        header = ctk.CTkFrame(self, fg_color=CARD_COLOR, corner_radius=0)
        header.grid(row=0, column=0, sticky="ew")
        header.grid_columnconfigure(0, weight=1)

        title_area = ctk.CTkFrame(header, fg_color="transparent")
        title_area.grid(row=0, column=0, padx=(24, 14), pady=17, sticky="w")
        ctk.CTkLabel(
            title_area,
            text="重复项对比",
            font=ctk.CTkFont(size=23, weight="bold"),
            text_color=BODY_TEXT,
        ).pack(anchor="w")
        ctk.CTkLabel(
            title_area,
            text="内容指纹完全相同；此窗口仅供核对，不会删除或更换主文件。",
            font=ctk.CTkFont(size=11),
            text_color=MUTED_TEXT,
        ).pack(anchor="w", pady=(3, 0))

        summary = ctk.CTkFrame(header, fg_color="transparent")
        summary.grid(row=0, column=1, padx=(0, 16), pady=12, sticky="e")
        group_count = len(self._groups)
        copy_count = sum(group.redundant_count for group in self._groups)
        skipped_count = sum(group.skipped_count for group in self._groups)
        for column, (value, label) in enumerate(
            ((group_count, "重复组"), (copy_count, "重复副本"), (skipped_count, "同来源跳过"))
        ):
            self._summary_card(summary, column, value, label)

        close_button = ctk.CTkButton(
            header,
            text="关闭",
            width=72,
            height=34,
            fg_color="transparent",
            hover_color=("#EEF1F5", "#273142"),
            border_width=1,
            border_color=SOFT_BORDER,
            text_color=BODY_TEXT,
            command=self.close,
        )
        close_button.grid(row=0, column=2, padx=(0, 22), pady=17)

        body = ctk.CTkFrame(self, fg_color="transparent")
        body.grid(row=1, column=0, padx=18, pady=16, sticky="nsew")
        body.grid_rowconfigure(0, weight=1)
        body.grid_columnconfigure(0, minsize=244)
        body.grid_columnconfigure(1, weight=1)

        self._build_group_navigation(body)
        self._build_comparison(body)

        footer = ctk.CTkFrame(self, fg_color=CARD_COLOR, corner_radius=0)
        footer.grid(row=2, column=0, sticky="ew")
        footer.grid_columnconfigure(0, weight=1)
        self.footer_label = ctk.CTkLabel(
            footer,
            text="完整 SHA-256 相同。复制模式不会删除源文件，移动模式也只执行已生成的整理计划。",
            font=ctk.CTkFont(size=10),
            text_color=MUTED_TEXT,
            anchor="w",
        )
        self.footer_label.grid(row=0, column=0, padx=22, pady=10, sticky="ew")

    @staticmethod
    def _summary_card(parent: ctk.CTkFrame, column: int, value: int, label: str) -> None:
        card = ctk.CTkFrame(parent, fg_color=PANEL_COLOR, corner_radius=10)
        card.grid(row=0, column=column, padx=4, sticky="ew")
        ctk.CTkLabel(
            card,
            text=f"{value:,}",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color=BODY_TEXT,
        ).pack(padx=16, pady=(7, 0))
        ctk.CTkLabel(card, text=label, font=ctk.CTkFont(size=9), text_color=MUTED_TEXT).pack(
            padx=16, pady=(0, 7)
        )

    def _build_group_navigation(self, parent: ctk.CTkFrame) -> None:
        navigation = ctk.CTkFrame(parent, width=244, fg_color=CARD_COLOR, corner_radius=14)
        navigation.grid(row=0, column=0, padx=(0, 10), sticky="nsew")
        navigation.grid_propagate(False)
        navigation.grid_columnconfigure(0, weight=1)
        navigation.grid_rowconfigure(2, weight=1)

        ctk.CTkLabel(
            navigation,
            text="重复组",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color=BODY_TEXT,
        ).grid(row=0, column=0, padx=14, pady=(14, 7), sticky="w")

        nav_controls = ctk.CTkFrame(navigation, fg_color="transparent")
        nav_controls.grid(row=1, column=0, padx=12, pady=(0, 9), sticky="ew")
        nav_controls.grid_columnconfigure(1, weight=1)
        self.previous_group_button = self._arrow_button(
            nav_controls, "‹", lambda: self._change_group(-1)
        )
        self.previous_group_button.grid(row=0, column=0)
        self.group_position = ctk.CTkLabel(
            nav_controls,
            text="0 / 0",
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color=MUTED_TEXT,
        )
        self.group_position.grid(row=0, column=1, padx=6)
        self.next_group_button = self._arrow_button(
            nav_controls, "›", lambda: self._change_group(1)
        )
        self.next_group_button.grid(row=0, column=2)

        tree_host = ctk.CTkFrame(navigation, fg_color="transparent")
        tree_host.grid(row=2, column=0, padx=10, pady=(0, 12), sticky="nsew")
        tree_host.grid_columnconfigure(0, weight=1)
        tree_host.grid_rowconfigure(0, weight=1)
        self.group_tree = ttk.Treeview(
            tree_host,
            show="tree",
            selectmode="browse",
            style="Duplicate.Treeview",
        )
        self.group_tree.column("#0", width=198, minwidth=160, stretch=True, anchor="w")
        self.group_tree.bind("<<TreeviewSelect>>", self._on_group_selected)
        self.group_scrollbar = ctk.CTkScrollbar(
            tree_host,
            orientation="vertical",
            command=self.group_tree.yview,
            width=12,
            fg_color="transparent",
            button_color=("#C7CDD8", "#475467"),
            button_hover_color=("#98A2B3", "#667085"),
        )
        self.group_tree.configure(yscrollcommand=self.group_scrollbar.set)
        self.group_tree.grid(row=0, column=0, sticky="nsew")
        self.group_scrollbar.grid(row=0, column=1, padx=(4, 0), sticky="ns")

    def _build_comparison(self, parent: ctk.CTkFrame) -> None:
        comparison = ctk.CTkFrame(parent, fg_color="transparent")
        comparison.grid(row=0, column=1, sticky="nsew")
        comparison.grid_rowconfigure(1, weight=1)
        comparison.grid_columnconfigure((0, 1), weight=1, uniform="comparison")

        self.group_summary = ctk.CTkLabel(
            comparison,
            text="请选择重复组",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=MUTED_TEXT,
            anchor="w",
        )
        self.group_summary.grid(row=0, column=0, columnspan=2, padx=5, pady=(0, 7), sticky="ew")

        self._side_widgets["primary"] = self._build_side_card(comparison, 0, "主文件", False)
        self._side_widgets["compare"] = self._build_side_card(comparison, 1, "当前对比副本", True)

    def _build_side_card(
        self,
        parent: ctk.CTkFrame,
        column: int,
        title: str,
        allow_member_navigation: bool,
    ) -> _SideWidgets:
        card = ctk.CTkFrame(parent, fg_color=CARD_COLOR, corner_radius=14)
        card.grid(row=1, column=column, padx=(0, 5) if column == 0 else (5, 0), sticky="nsew")
        card.grid_columnconfigure(0, weight=1)
        card.grid_rowconfigure(3, weight=1)

        card_header = ctk.CTkFrame(card, fg_color="transparent")
        card_header.grid(row=0, column=0, padx=14, pady=(12, 7), sticky="ew")
        card_header.grid_columnconfigure(0, weight=1)
        title_label = ctk.CTkLabel(
            card_header,
            text=title,
            font=ctk.CTkFont(size=14, weight="bold"),
            text_color=BODY_TEXT,
            anchor="w",
        )
        title_label.grid(row=0, column=0, sticky="w")

        previous_button: ctk.CTkButton | None = None
        next_button: ctk.CTkButton | None = None
        position = ctk.CTkLabel(
            card_header,
            text="",
            font=ctk.CTkFont(size=10, weight="bold"),
            text_color=MUTED_TEXT,
        )
        if allow_member_navigation:
            previous_button = self._arrow_button(
                card_header, "‹", lambda: self._change_member(-1), width=28
            )
            previous_button.grid(row=0, column=1, padx=(4, 2))
            position.grid(row=0, column=2, padx=3)
            next_button = self._arrow_button(
                card_header, "›", lambda: self._change_member(1), width=28
            )
            next_button.grid(row=0, column=3, padx=(2, 0))

        freshness = ctk.CTkLabel(
            card,
            text="等待检查",
            height=25,
            corner_radius=7,
            fg_color=GRAY_BG,
            text_color=GRAY_TEXT,
            font=ctk.CTkFont(size=10, weight="bold"),
        )
        freshness.grid(row=1, column=0, padx=14, pady=(0, 8), sticky="w")

        preview_host = ctk.CTkFrame(
            card,
            height=252,
            fg_color=PANEL_COLOR,
            corner_radius=11,
            border_width=1,
            border_color=SOFT_BORDER,
        )
        preview_host.grid(row=2, column=0, padx=14, pady=(0, 9), sticky="ew")
        preview_host.grid_propagate(False)
        preview_host.grid_columnconfigure(0, weight=1)
        preview_host.grid_rowconfigure(0, weight=1)
        preview = ctk.CTkLabel(
            preview_host,
            text="尚未加载",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=12),
        )
        preview.grid(row=0, column=0, padx=8, pady=6, sticky="nsew")

        details = ctk.CTkScrollableFrame(
            card,
            fg_color="transparent",
            corner_radius=0,
            scrollbar_fg_color="transparent",
            scrollbar_button_color=("#C7CDD8", "#475467"),
            scrollbar_button_hover_color=("#98A2B3", "#667085"),
        )
        details.grid(row=3, column=0, padx=(14, 5), pady=(0, 12), sticky="nsew")
        details.grid_columnconfigure(1, weight=1)

        return _SideWidgets(
            title_label,
            position,
            previous_button,
            next_button,
            freshness,
            preview,
            details,
        )

    @staticmethod
    def _arrow_button(
        parent: Any,
        text: str,
        command: Any,
        *,
        width: int = 32,
    ) -> ctk.CTkButton:
        return ctk.CTkButton(
            parent,
            text=text,
            width=width,
            height=28,
            corner_radius=8,
            fg_color=("#EEF1F5", "#273142"),
            hover_color=("#DDE2EA", "#344054"),
            text_color=BODY_TEXT,
            font=ctk.CTkFont(size=18),
            command=command,
        )

    # ------------------------------------------------------------------
    # 重复组与成员导航
    # ------------------------------------------------------------------

    def _populate_groups(self) -> None:
        for index, group in enumerate(self._groups):
            album_names = sorted({member.album for member in group.members if member.album})
            source = (
                album_names[0]
                if len(album_names) == 1
                else (f"{len(album_names)} 个相册" if album_names else "时间线")
            )
            text = (
                f"#{index + 1:03d}  {len(group.members)} 个文件\n"
                f"{_format_bytes(group.size)} · {source}"
            )
            self.group_tree.insert("", "end", iid=f"group-{index}", text=text)

    def _select_group(self, index: int, *, from_tree: bool = False) -> None:
        if self._closed or not self._groups:
            return
        index = min(max(index, 0), len(self._groups) - 1)
        self._group_index = index
        self._member_index = 0
        group = self._groups[index]
        primary, comparisons = _split_group(group)

        if not from_tree:
            self._suppress_tree_event = True
            try:
                iid = f"group-{index}"
                self.group_tree.selection_set(iid)
                self.group_tree.focus(iid)
                self.group_tree.see(iid)
            finally:
                self._suppress_tree_event = False

        self.group_position.configure(text=f"{index + 1} / {len(self._groups)}")
        self.previous_group_button.configure(state="normal" if index > 0 else "disabled")
        self.next_group_button.configure(
            state="normal" if index < len(self._groups) - 1 else "disabled"
        )
        self.group_summary.configure(
            text=(
                f"重复组 #{index + 1:03d}  ·  {len(group.members)} 个物理文件  ·  "
                f"{'单组' if group.is_live_photo else '单文件'} {_format_bytes(group.size)}  ·  "
                f"同来源跳过 {group.skipped_count} 个"
            )
        )
        self._update_member_navigation(comparisons)

        if primary is None:
            self._show_side_message("primary", "未记录主文件", "该重复组缺少可对比的主文件。")
        if not comparisons:
            self._show_side_message("compare", "没有其它副本", "该重复组没有可显示的对比成员。")

        members: list[tuple[str, DuplicateMember]] = []
        if primary is not None:
            members.append(("primary", primary))
        if comparisons:
            members.append(("compare", comparisons[0]))
        self._schedule_previews(members, reset_sides=("primary", "compare"))

    def _change_group(self, delta: int) -> None:
        self._select_group(self._group_index + delta)

    def _on_group_selected(self, _event: Any) -> None:
        if self._suppress_tree_event or self._closed:
            return
        selection = self.group_tree.selection()
        if not selection:
            return
        try:
            index = int(selection[0].split("-", 1)[1])
        except (IndexError, ValueError):
            return
        if index != self._group_index:
            self._select_group(index, from_tree=True)

    def _change_member(self, delta: int) -> None:
        if not self._groups:
            return
        group = self._groups[self._group_index]
        _primary, comparisons = _split_group(group)
        if not comparisons:
            return
        self._member_index = min(max(self._member_index + delta, 0), len(comparisons) - 1)
        self._update_member_navigation(comparisons)
        # 成员导航只刷新右侧，主文件既不会失效，也不会重复解码。
        self._schedule_previews([("compare", comparisons[self._member_index])])

    def _update_member_navigation(self, comparisons: list[DuplicateMember]) -> None:
        widgets = self._side_widgets["compare"]
        total = len(comparisons)
        widgets.position.configure(text=f"{self._member_index + 1} / {total}" if total else "0 / 0")
        if widgets.previous_button is not None:
            widgets.previous_button.configure(
                state="normal" if self._member_index > 0 else "disabled"
            )
        if widgets.next_button is not None:
            widgets.next_button.configure(
                state="normal" if self._member_index < total - 1 else "disabled"
            )

    def _show_empty_state(self) -> None:
        self.group_position.configure(text="0 / 0")
        self.previous_group_button.configure(state="disabled")
        self.next_group_button.configure(state="disabled")
        self.group_summary.configure(text="本次分析没有可对比的重复组")
        self._show_side_message("primary", "没有重复项", "完成一次扫描后，可在这里核对主文件。")
        self._show_side_message("compare", "没有重复项", "重复副本不会在此窗口中被修改或删除。")

    # ------------------------------------------------------------------
    # 后台加载与主线程渲染
    # ------------------------------------------------------------------

    def _schedule_previews(
        self,
        members: list[tuple[str, DuplicateMember]],
        *,
        reset_sides: tuple[str, ...] | None = None,
    ) -> None:
        """为指定侧创建独立令牌，并复用相同路径的进行中请求。"""

        by_side = dict(members)
        sides = reset_sides or tuple(by_side)
        waiters: list[_Waiter] = []
        with self._state_lock:
            if self._closed:
                return
            for side in sides:
                self._side_tokens[side] += 1
                member = by_side.get(side)
                try:
                    member_key = _member_key(member) if member is not None else None
                except Exception:
                    # 即使一个异常路径无法规范化，也要先使旧请求失效并继续处理另一侧。
                    member_key = ("invalid-member", side, self._side_tokens[side])
                self._side_member_keys[side] = member_key
                if member is not None and member_key is not None:
                    waiters.append(
                        _Waiter(
                            side,
                            self._side_tokens[side],
                            self._group_index,
                            member_key,
                            member,
                        )
                    )
            self._prune_pending_locked()

        # 必须先分别清空两侧旧内容，再提交任务；任何一侧 UI 异常不能阻断另一侧。
        for waiter in waiters:
            try:
                self._prepare_side_loading(waiter.side, waiter.member)
            except Exception as exc:
                LOGGER.exception("准备%s侧重复项预览失败", waiter.side)
                self._show_side_failure(
                    waiter.side,
                    waiter.member,
                    f"切换预览时界面更新失败：{exc}",
                )

        for waiter in waiters:
            try:
                self._request_preview(waiter)
            except Exception as exc:
                LOGGER.exception("提交%s侧重复项预览失败", waiter.side)
                self._queue_waiter_failure(waiter, f"无法启动预览任务：{exc}")

    def _request_preview(self, waiter: _Waiter) -> None:
        request_key = _request_key(waiter.member.path, THUMBNAIL_BOUNDS)
        callback_future: Future[_CachedPreview] | None = None
        with self._state_lock:
            if self._closed or not self._is_waiter_current_locked(waiter):
                return
            pending = self._pending.get(request_key)
            if pending is not None:
                pending.waiters.append(waiter)
                return
            try:
                future = self._executor.submit(
                    _load_cached_preview,
                    self._cache,
                    waiter.member.path,
                    THUMBNAIL_BOUNDS,
                )
            except Exception as exc:
                self._queue_waiter_failure(waiter, f"无法提交预览任务：{exc}")
                return
            self._pending[request_key] = _PendingLoad(future, [waiter])
            self._futures.add(future)
            callback_future = future
        if callback_future is not None:
            callback_future.add_done_callback(partial(self._preview_finished, request_key))

    def _preview_finished(
        self,
        request_key: _RequestKey,
        future: Future[_CachedPreview],
    ) -> None:
        worker_error = ""
        try:
            cached = future.result()
        except FutureCancelledError:
            cached = _failed_cached_preview(request_key_to_path(request_key), "预览请求已取消")
            worker_error = "预览请求已取消"
        except Exception as exc:
            worker_error = f"后台预览异常：{exc}"
            cached = _failed_cached_preview(request_key_to_path(request_key), worker_error)

        with self._state_lock:
            self._futures.discard(future)
            pending = self._pending.pop(request_key, None)
            if pending is None or self._closed:
                return
            active_waiters = [
                waiter for waiter in pending.waiters if self._is_waiter_current_locked(waiter)
            ]
            for waiter in active_waiters:
                try:
                    stale_state, stale_message = _detect_stale(waiter.member, cached.details)
                except Exception as exc:
                    stale_state = "unknown"
                    stale_message = f"陈旧状态检查失败：{exc}"
                    worker_error = worker_error or stale_message
                self._result_queue.put(
                    _LoadedPreview(
                        waiter.side,
                        waiter.token,
                        waiter.group_index,
                        waiter.member_key,
                        waiter.member,
                        cached,
                        stale_state,
                        stale_message,
                        worker_error,
                    )
                )

    def _queue_waiter_failure(self, waiter: _Waiter, message: str) -> None:
        """把提交或调度异常转换为该侧可消费的终态结果。"""

        failed = _failed_cached_preview(waiter.member.path, message)
        try:
            stale_state, stale_message = _detect_stale(waiter.member, failed.details)
        except Exception as exc:
            stale_state, stale_message = "unknown", f"陈旧状态检查失败：{exc}"
        with self._state_lock:
            if self._closed or not self._is_waiter_current_locked(waiter):
                return
        self._result_queue.put(
            _LoadedPreview(
                waiter.side,
                waiter.token,
                waiter.group_index,
                waiter.member_key,
                waiter.member,
                failed,
                stale_state,
                stale_message,
                message,
            )
        )

    def _is_waiter_current_locked(self, waiter: _Waiter) -> bool:
        return (
            waiter.group_index == self._group_index
            and self._side_tokens.get(waiter.side) == waiter.token
            and self._side_member_keys.get(waiter.side) == waiter.member_key
        )

    def _prune_pending_locked(self) -> None:
        """取消已排队且不再服务任何当前侧的任务，避免快速导航造成积压。"""

        for key, pending in tuple(self._pending.items()):
            pending.waiters[:] = [
                waiter for waiter in pending.waiters if self._is_waiter_current_locked(waiter)
            ]
            if pending.waiters or not pending.future.cancel():
                continue
            self._pending.pop(key, None)
            self._futures.discard(pending.future)

    def _drain_results(self) -> None:
        if self._closed:
            return
        # 一次清空队列并仅保留每侧的当前结果。快速切换数千组时，旧结果不会
        # 堵在最终结果前方，引用的 PNG 字节也可立即释放或回到有界缓存管理。
        current_results: dict[str, _LoadedPreview] = {}
        try:
            while True:
                try:
                    loaded = self._result_queue.get_nowait()
                except queue.Empty:
                    break
                with self._state_lock:
                    current = (
                        not self._closed
                        and loaded.group_index == self._group_index
                        and self._side_tokens.get(loaded.side) == loaded.token
                        and self._side_member_keys.get(loaded.side) == loaded.member_key
                    )
                if not current:
                    continue
                current_results[loaded.side] = loaded
            for side in ("primary", "compare"):
                current_loaded = current_results.get(side)
                if current_loaded is None:
                    continue
                try:
                    self._render_loaded_preview(current_loaded)
                except Exception as exc:
                    LOGGER.exception("渲染%s侧重复项预览失败", side)
                    self._show_side_failure(
                        side,
                        current_loaded.member,
                        f"显示预览结果失败：{exc}",
                    )
        finally:
            # 某一侧渲染失败也必须继续轮询，否则另一侧会永久停在加载状态。
            if not self._closed:
                try:
                    self._poll_after_id = self.after(60, self._drain_results)
                except Exception:
                    self._poll_after_id = None

    def _prepare_side_loading(self, side: str, member: DuplicateMember) -> None:
        widgets = self._side_widgets[side]
        self._release_side_image(side)
        widgets.title.configure(
            text=(
                "主文件"
                if member.disposition is DuplicateDisposition.PRIMARY
                else (
                    "参考文件（无主项）"
                    if side == "primary"
                    else DISPOSITION_LABELS.get(member.disposition, "当前对比副本")
                )
            )
        )
        widgets.freshness.configure(
            text="正在检查文件…",
            fg_color=GRAY_BG,
            text_color=GRAY_TEXT,
        )
        widgets.preview.configure(text="…\n正在生成预览")
        self._clear_detail_frame(widgets.details)
        self._detail_row(widgets.details, 0, "文件", member.path.name, strong=True)
        self._detail_row(widgets.details, 1, "完整路径", str(member.path), wrap=True)

    def _render_loaded_preview(self, loaded: _LoadedPreview) -> None:
        side = loaded.side
        widgets = self._side_widgets[side]
        self._release_side_image(side)
        self._configure_freshness(widgets.freshness, loaded.stale_state, loaded.stale_message)

        thumbnail = loaded.cached.thumbnail
        image_error = loaded.worker_error
        if thumbnail.status is ThumbnailStatus.READY and thumbnail.png_bytes:
            display_image: Image.Image | None = None
            try:
                # 后台只产生 PNG 字节；主线程再构建 CTkImage。CTkImage 会按
                # Windows 的显示缩放重新生成底层 PhotoImage，避免 HighDPI 下
                # tkinter.PhotoImage 尺寸固定并触发 CustomTkinter 告警。
                with Image.open(BytesIO(thumbnail.png_bytes)) as decoded:
                    has_alpha = "A" in decoded.getbands() or (
                        decoded.mode == "P" and "transparency" in decoded.info
                    )
                    display_image = decoded.convert("RGBA" if has_alpha else "RGB")
                    display_image.load()
                logical_size = thumbnail.thumbnail_size or tuple(display_image.size)
                image = ctk.CTkImage(light_image=display_image, size=logical_size)
                widgets.image_ref = image
                widgets.preview.configure(image=image, text="")
            except Exception as exc:
                if display_image is not None:
                    display_image.close()
                image_error = f"缩略图已生成，但界面无法显示：{exc}"
                widgets.preview.configure(
                    text=_placeholder_text(loaded.member.path, thumbnail, image_error),
                )
        else:
            widgets.preview.configure(
                text=_placeholder_text(loaded.member.path, thumbnail, image_error),
            )

        self._render_details(widgets.details, loaded, image_error)

    def _render_details(
        self,
        parent: ctk.CTkScrollableFrame,
        loaded: _LoadedPreview,
        image_error: str,
    ) -> None:
        self._clear_detail_frame(parent)
        member = loaded.member
        details = loaded.cached.details
        thumbnail = loaded.cached.thumbnail
        group = self._groups[loaded.group_index]
        row = 0
        self._detail_row(parent, row, "文件名", member.path.name, strong=True)
        row += 1
        self._detail_row(parent, row, "完整路径", str(member.path), wrap=True)
        row += 1
        if member.companion_path is not None:
            companion = member.companion_path
            try:
                companion_size = companion.stat().st_size
            except OSError:
                companion_size = None
            self._detail_row(
                parent,
                row,
                "实况动态片段",
                f"{companion}\n大小：{_format_bytes(companion_size)}",
                wrap=True,
            )
            row += 1
        self._detail_row(parent, row, "来源相册", member.album or "时间线 / 年份目录")
        row += 1
        current_size = details.size_bytes if details.size_bytes is not None else member.size
        size_text = _format_bytes(current_size)
        if details.size_bytes is not None and details.size_bytes != member.size:
            size_text += f"（扫描时 {_format_bytes(member.size)}）"
        self._detail_row(parent, row, "文件大小", size_text)
        row += 1

        decoded_format = (
            thumbnail.decoded_format
            or details.decoded_format
            or details.mime_type
            or member.path.suffix.lstrip(".").upper()
            or "未知"
        )
        display_size = thumbnail.display_size or details.display_size
        dimensions = f"{display_size[0]} × {display_size[1]}" if display_size else "不可用"
        self._detail_row(parent, row, "格式 / 分辨率", f"{decoded_format} · {dimensions}")
        row += 1

        current_modified = (
            details.modified_at.strftime("%Y-%m-%d %H:%M:%S")
            if details.modified_at is not None
            else "不可用"
        )
        if member.modified_ns is not None:
            try:
                scanned = datetime.fromtimestamp(member.modified_ns / 1_000_000_000)
                if (
                    details.modified_at is None
                    or abs(details.modified_at.timestamp() - scanned.timestamp()) > 0.001
                ):
                    current_modified += f"\n扫描时：{scanned:%Y-%m-%d %H:%M:%S}"
            except (OSError, OverflowError, ValueError):
                pass
        self._detail_row(parent, row, "修改时间", current_modified, wrap=True)
        row += 1

        date_text = group.date_taken.strftime("%Y-%m-%d %H:%M:%S") if group.date_taken else "未知"
        source_text = DATE_SOURCE_LABELS[group.date_source] if group.date_source else "无"
        self._detail_row(
            parent,
            row,
            "采用拍摄日期",
            f"{date_text}\n来源：{source_text}",
            wrap=True,
        )
        row += 1
        self._detail_row(
            parent,
            row,
            "复合 SHA-256" if group.is_live_photo else "完整 SHA-256",
            group.digest,
            wrap=True,
            monospace=True,
        )
        row += 1

        disposition = DISPOSITION_LABELS.get(member.disposition, str(member.disposition))
        reason = member.reason.strip() or _default_reason(member.disposition)
        self._detail_row(parent, row, "处理状态", f"{disposition}\n{reason}", wrap=True)
        row += 1
        self._detail_row(parent, row, "陈旧检测", loaded.stale_message, wrap=True)
        if details.error:
            row += 1
            self._detail_row(parent, row, "文件检查", details.error, wrap=True, warning=True)
        if image_error:
            row += 1
            self._detail_row(parent, row, "预览说明", image_error, wrap=True, warning=True)

    @staticmethod
    def _detail_row(
        parent: ctk.CTkScrollableFrame,
        row: int,
        key: str,
        value: str,
        *,
        wrap: bool = False,
        strong: bool = False,
        monospace: bool = False,
        warning: bool = False,
    ) -> None:
        parent.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(
            parent,
            text=key,
            width=88,
            anchor="nw",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=10),
        ).grid(row=row, column=0, padx=(0, 8), pady=4, sticky="nw")
        font: Any
        if monospace:
            font = ("Cascadia Mono", 9)
        else:
            font = ctk.CTkFont(size=10, weight="bold" if strong else "normal")
        ctk.CTkLabel(
            parent,
            text=value,
            anchor="nw",
            justify="left",
            wraplength=300 if wrap else 0,
            text_color=AMBER_TEXT if warning else BODY_TEXT,
            font=font,
        ).grid(row=row, column=1, padx=(0, 8), pady=4, sticky="ew")

    @staticmethod
    def _clear_detail_frame(parent: ctk.CTkScrollableFrame) -> None:
        for child in parent.winfo_children():
            child.destroy()

    def _show_side_message(self, side: str, title: str, message: str) -> None:
        widgets = self._side_widgets[side]
        self._release_side_image(side)
        widgets.title.configure(text=title)
        widgets.freshness.configure(text="无可用文件", fg_color=GRAY_BG, text_color=GRAY_TEXT)
        widgets.preview.configure(text=message)
        self._clear_detail_frame(widgets.details)

    def _show_side_failure(self, side: str, member: DuplicateMember, message: str) -> None:
        """尽最大努力清除旧内容并把单侧异常显示为明确终态。"""

        widgets = self._side_widgets.get(side)
        if widgets is None:
            return
        self._release_side_image(side)
        try:
            widgets.title.configure(text="主文件" if side == "primary" else "当前对比副本")
        except Exception:
            pass
        try:
            widgets.freshness.configure(text="预览失败", fg_color=RED_BG, text_color=RED_TEXT)
        except Exception:
            pass
        try:
            widgets.preview.configure(text=f"预览无法显示\n{message}")
        except Exception:
            pass
        try:
            self._clear_detail_frame(widgets.details)
            self._detail_row(widgets.details, 0, "文件", member.path.name, strong=True)
            self._detail_row(widgets.details, 1, "完整路径", str(member.path), wrap=True)
            self._detail_row(widgets.details, 2, "错误", message, wrap=True, warning=True)
        except Exception:
            pass

    @staticmethod
    def _configure_freshness(label: ctk.CTkLabel, state: str, _message: str) -> None:
        if state == "fresh":
            label.configure(text="与扫描时一致", fg_color=GREEN_BG, text_color=GREEN_TEXT)
        elif state == "stale":
            label.configure(text="扫描后已变化", fg_color=AMBER_BG, text_color=AMBER_TEXT)
        elif state == "missing":
            label.configure(text="文件已不存在", fg_color=RED_BG, text_color=RED_TEXT)
        else:
            label.configure(text="无法确认新旧", fg_color=GRAY_BG, text_color=GRAY_TEXT)
        label.configure(cursor="arrow")

    def _release_side_image(self, side: str) -> None:
        widgets = self._side_widgets.get(side)
        if widgets is None:
            return
        # CTkLabel 对 image=None 不会主动清除内部 tk.Label 的已缩放图片；必须
        # 在释放 CTkImage 前显式置空，否则下次切换可能引用已回收的 pyimage。
        inner_label = getattr(widgets.preview, "_label", None)
        if inner_label is not None:
            try:
                inner_label.configure(image="")
            except Exception:
                pass
        try:
            # 原生标签已清空；这里仅把 CTkLabel 自身的图片状态同步为 None。
            widgets.preview.configure(image=None)
        except Exception:
            pass
        # 内部控件已不再引用图片，此时释放 CTkImage 及其缩放缓存才是安全的。
        widgets.image_ref = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def close(self) -> None:
        """幂等关闭弹窗，并取消后台工作、释放全部图片和 Tk 资源。"""

        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            self._side_tokens["primary"] += 1
            self._side_tokens["compare"] += 1
            self._side_member_keys["primary"] = None
            self._side_member_keys["compare"] = None
            futures = tuple(self._futures)
            self._pending.clear()
            self._futures.clear()
        # 先关闭缓存，避免仍在运行的 worker 在清空后重新写入 PNG。
        self._cache.close()
        for future in futures:
            future.cancel()
        self._executor.shutdown(wait=False, cancel_futures=True)

        if self._poll_after_id is not None:
            try:
                self.after_cancel(self._poll_after_id)
            except Exception:
                pass
            self._poll_after_id = None
        while True:
            try:
                self._result_queue.get_nowait()
            except queue.Empty:
                break
        self._release_side_image("primary")
        self._release_side_image("compare")
        try:
            self.grab_release()
        except Exception:
            pass
        try:
            self.destroy()
        except Exception:
            pass

    def _configure_tree_style(self) -> None:
        dark = ctk.get_appearance_mode().lower() == "dark"
        background = "#111827" if dark else "#F8FAFC"
        foreground = "#E5E7EB" if dark else "#273142"
        selected = "#3942A3" if dark else "#DDE3FF"
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure(
            "Duplicate.Treeview",
            background=background,
            fieldbackground=background,
            foreground=foreground,
            borderwidth=0,
            relief="flat",
            rowheight=48,
            font=("Microsoft YaHei UI", 10),
        )
        style.map(
            "Duplicate.Treeview",
            background=[("selected", selected)],
            foreground=[("selected", foreground)],
        )


def _normalise_path(path: Path | str) -> str:
    """生成 Windows 大小写不敏感、绝对化的稳定路径键。"""

    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _request_key(path: Path | str, bounds: tuple[int, int]) -> _RequestKey:
    return _RequestKey(_normalise_path(path), bounds)


def request_key_to_path(key: _RequestKey) -> Path:
    """把进行中请求键还原为只读文件路径。"""

    return Path(key.path)


def _member_key(member: DuplicateMember | None) -> tuple[Any, ...] | None:
    """侧请求身份包含扫描快照，避免同路径新成员误收旧结果。"""

    if member is None:
        return None
    return (
        _normalise_path(member.path),
        member.album,
        member.size,
        member.modified_ns,
        member.digest,
        member.disposition.value,
        _normalise_path(member.companion_path) if member.companion_path else None,
    )


def _cache_key(path: Path, bounds: tuple[int, int]) -> _CacheKey:
    """使用文件的当前大小和纳秒修改时间构造自然失效的缓存键。"""

    try:
        stat = path.stat()
    except OSError:
        size: int | None = None
        modified_ns: int | None = None
    else:
        size = stat.st_size
        modified_ns = stat.st_mtime_ns
    return _CacheKey(_normalise_path(path), size, modified_ns, bounds)


def _load_cached_preview(
    cache: _BoundedPreviewCache,
    path: Path,
    bounds: tuple[int, int],
) -> _CachedPreview:
    """在线程池读取详情及缩略图；缓存中不保存任何 Tk/Pillow 对象。"""

    before = _cache_key(path, bounds)
    cached = cache.get(before)
    if cached is not None:
        return cached

    details = inspect_duplicate_file(path)
    thumbnail = build_thumbnail(path, bounds)
    loaded = _CachedPreview(details, thumbnail)
    after = _cache_key(path, bounds)
    # 文件在检查期间变化时不缓存本次快照，下一次请求将重新读取。
    if before == after:
        cache.put(after, loaded)
    return loaded


def _failed_cached_preview(path: Path, message: str) -> _CachedPreview:
    """把任何意外异常转换为可渲染的终态，杜绝永久“加载中”。"""

    try:
        exists = path.is_file()
    except OSError:
        exists = False
    details = DuplicateFileDetails(
        path=path,
        exists=exists,
        size_bytes=None,
        modified_at=None,
        mime_type=None,
        declared_extension=path.suffix.casefold(),
        decoded_format=None,
        raw_size=None,
        display_size=None,
        frame_count=None,
        error=message,
    )
    thumbnail = ThumbnailResult(
        status=ThumbnailStatus.CORRUPT,
        png_bytes=None,
        decoded_format=None,
        raw_size=None,
        display_size=None,
        thumbnail_size=None,
        error=message,
    )
    return _CachedPreview(details, thumbnail)


def _detect_stale(
    member: DuplicateMember,
    details: DuplicateFileDetails,
) -> tuple[str, str]:
    """比较扫描快照和当前文件属性，不重新计算昂贵的完整哈希。"""

    if not details.exists:
        return "missing", "文件在扫描后已被移动、删除或当前不可访问。"
    try:
        stat = member.path.stat()
    except OSError as exc:
        return "unknown", f"无法重新读取文件属性：{exc}"

    changes: list[str] = []
    if stat.st_size != member.size:
        changes.append(f"大小从 {_format_bytes(member.size)} 变为 {_format_bytes(stat.st_size)}")
    if member.modified_ns is not None and stat.st_mtime_ns != member.modified_ns:
        changes.append("最后修改时间发生变化")
    if changes:
        return "stale", "；".join(changes) + "。扫描时的 SHA-256 可能已不再代表当前内容。"
    if member.modified_ns is None:
        return "unknown", "扫描时未记录纳秒修改时间；当前大小仍与扫描快照一致。"
    return "fresh", "文件大小和纳秒修改时间均与扫描快照一致。"


def _split_group(
    group: DuplicateGroup,
) -> tuple[DuplicateMember | None, list[DuplicateMember]]:
    """稳健选出主文件，并保持其余成员的原始分析顺序。"""

    primary = next(
        (member for member in group.members if member.path == group.primary_path),
        None,
    )
    if primary is None:
        primary = next(
            (
                member
                for member in group.members
                if member.disposition is DuplicateDisposition.PRIMARY
            ),
            group.members[0] if group.members else None,
        )
    comparisons = [member for member in group.members if member is not primary]
    return primary, comparisons


def _placeholder_text(
    path: Path,
    thumbnail: ThumbnailResult,
    image_error: str,
) -> str:
    """为视频、RAW、损坏或缺失文件生成不依赖图标字体的占位文字。"""

    suffix = path.suffix.upper().lstrip(".") or "未知格式"
    if image_error:
        return f"图片预览不可用\n{image_error}"
    if thumbnail.status is ThumbnailStatus.MISSING:
        return "文件已不存在\n无法生成预览"
    if path.suffix.casefold() in VIDEO_EXTENSIONS or thumbnail.status is ThumbnailStatus.NOT_IMAGE:
        return f"▶\n{suffix} 视频 / 媒体文件\n内置预览不解码视频"
    if thumbnail.status is ThumbnailStatus.UNSUPPORTED:
        return f"{suffix} 图片\n当前 Pillow 解码器不支持预览\n文件仍可正常参与哈希比较"
    if thumbnail.status is ThumbnailStatus.TOO_LARGE:
        return f"图片尺寸过大\n为保护内存已跳过预览\n{thumbnail.error or ''}".strip()
    if thumbnail.status is ThumbnailStatus.CORRUPT:
        return f"图片损坏或无法解码\n{thumbnail.error or '无法生成安全缩略图'}"
    return thumbnail.error or "此文件无法生成内置预览"


def _default_reason(disposition: DuplicateDisposition) -> str:
    if disposition is DuplicateDisposition.PRIMARY:
        return "作为该内容组的主要输出来源。"
    if disposition is DuplicateDisposition.ALBUM_COPY:
        return "内容相同，但保留此来源以维持相册关系。"
    if disposition is DuplicateDisposition.SKIPPED:
        return "与同一来源中的主文件内容完全相同，因此不重复进入计划。"
    if disposition is DuplicateDisposition.FILTERED:
        return "按额外版本过滤规则从整理计划中排除。"
    return "按当前分析规则处理。"


def _format_bytes(value: int | None) -> str:
    if value is None:
        return "未知"
    amount = float(max(value, 0))
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    unit = units[0]
    for candidate in units:
        unit = candidate
        if amount < 1024 or candidate == units[-1]:
            break
        amount /= 1024
    if unit == "B":
        return f"{int(amount):,} {unit}"
    return f"{amount:.2f} {unit}"


__all__ = ["DuplicatePreviewDialog"]
