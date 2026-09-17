"""Google Photos Takeout Helper 的现代中文桌面界面。"""

from __future__ import annotations

import inspect
import queue
import sys
import threading
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Any

import customtkinter as ctk

from . import __version__
from .constants import APP_DISPLAY_NAME, APP_NAME
from .duplicate_view import DuplicatePreviewDialog
from .models import (
    ActionKind,
    AlbumMode,
    AnalysisResult,
    CancelledError,
    ConflictMode,
    DateDivision,
    FixDateOptions,
    LivePhotoRole,
    LivePhotoTarget,
    OperationMode,
    OrganizeOptions,
    Phase,
    PlanAction,
    ProgressUpdate,
    TaskContext,
    UnknownDateMode,
)
from .settings import load_settings, save_settings

APP_VERSION = __version__
WINDOW_SIZE = "1180x760"
MIN_WINDOW_SIZE = (980, 640)

PRIMARY = "#4F46E5"
PRIMARY_HOVER = "#4338CA"
SUCCESS = "#0F9F74"
WARNING = "#D97706"
DANGER = "#DC2626"
DANGER_HOVER = "#B91C1C"

CARD_COLOR = ("#FFFFFF", "#172033")
SIDEBAR_COLOR = ("#F4F6FB", "#111827")
MUTED_TEXT = ("#526071", "#B8C1D0")
SIDEBAR_TEXT = ("#263043", "#F2F4F7")
SIDEBAR_MUTED_TEXT = ("#475467", "#CBD5E1")

# 次要控件使用低饱和中性色，把主紫色留给真正的主要操作。
OPTION_MENU_STYLE = {
    "fg_color": ("#F8FAFC", "#273142"),
    "button_color": ("#E4E7EC", "#344054"),
    "button_hover_color": ("#D0D5DD", "#475467"),
    "text_color": ("#263043", "#F2F4F7"),
    "dropdown_fg_color": ("#FFFFFF", "#1F2937"),
    "dropdown_hover_color": ("#EEF2FF", "#303A5E"),
    "dropdown_text_color": ("#263043", "#F2F4F7"),
    "corner_radius": 8,
}
CHECKBOX_STYLE = {
    "fg_color": PRIMARY,
    "hover_color": ("#E0E7FF", "#3D4670"),
    "border_color": ("#667085", "#98A2B3"),
    "border_width": 1,
    "checkmark_color": "#FFFFFF",
}
TABVIEW_STYLE = {
    "segmented_button_fg_color": ("#E9EDF3", "#222C3D"),
    "segmented_button_selected_color": ("#DDE3FF", "#3942A3"),
    "segmented_button_selected_hover_color": ("#CDD5FF", "#4650B5"),
    "segmented_button_unselected_color": ("#F8FAFC", "#222C3D"),
    "segmented_button_unselected_hover_color": ("#E1E6EE", "#2B374B"),
    "text_color": ("#273142", "#F2F4F7"),
}
SEGMENTED_BUTTON_STYLE = {
    "selected_color": ("#C7D2FE", "#3942A3"),
    "selected_hover_color": ("#B4C2FC", "#4650B5"),
    "unselected_color": ("#EAECF0", "#273142"),
    "unselected_hover_color": ("#D0D5DD", "#344054"),
    "text_color": ("#273142", "#F2F4F7"),
}
SECONDARY_BUTTON_STYLE = {
    "fg_color": ("#FFFFFF", "#202A3A"),
    "hover_color": ("#EEF2FF", "#303A5E"),
    "border_width": 1,
    "border_color": (PRIMARY, "#818CF8"),
    "text_color": ("#3730A3", "#E0E7FF"),
    "text_color_disabled": ("#475467", "#98A2B3"),
}
PROGRESS_STYLE = {
    "height": 5,
    "corner_radius": 0,
    "border_width": 0,
    "fg_color": ("#D0D5DD", "#344054"),
    "progress_color": PRIMARY,
    "mode": "determinate",
}
SCROLLBAR_STYLE = {
    "width": 12,
    "corner_radius": 6,
    "border_spacing": 2,
    "minimum_pixel_length": 32,
    "fg_color": "transparent",
    "button_color": ("#667085", "#667085"),
    "button_hover_color": ("#475467", "#98A2B3"),
}

ALBUM_LABELS = {
    "快捷方式（推荐，节省空间）": AlbumMode.SHORTCUT,
    "复制到每个相册（最兼容）": AlbumMode.DUPLICATE_COPY,
    "单目录 + 相册 JSON": AlbumMode.JSON,
    "忽略相册，仅保留时间线": AlbumMode.NOTHING,
}
ALBUM_VALUES = {value.value: label for label, value in ALBUM_LABELS.items()}

DIVISION_LABELS = {
    "年 / 月目录": DateDivision.YEAR_MONTH,
    "仅按年份": DateDivision.YEAR,
    "全部放在同一目录": DateDivision.FLAT,
}
DIVISION_VALUES = {value.value: label for label, value in DIVISION_LABELS.items()}

CONFLICT_LABELS = {
    "自动重命名（推荐）": ConflictMode.RENAME,
    "跳过同名文件": ConflictMode.SKIP,
    "覆盖同名文件（危险）": ConflictMode.OVERWRITE,
}
CONFLICT_VALUES = {value.value: label for label, value in CONFLICT_LABELS.items()}

UNKNOWN_LABELS = {
    "放入 date-unknown": UnknownDateMode.FOLDER,
    "放在相册根目录": UnknownDateMode.ROOT,
    "跳过未知日期文件": UnknownDateMode.SKIP,
}
UNKNOWN_VALUES = {value.value: label for label, value in UNKNOWN_LABELS.items()}

LIVE_PHOTO_TARGET_LABELS = {
    "Apple 照片（原始双文件）": LivePhotoTarget.APPLE,
    "OPPO ColorOS 16（经 O+ 互联）": LivePhotoTarget.COLOROS16,
}
LIVE_PHOTO_TARGET_VALUES = {value.value: label for label, value in LIVE_PHOTO_TARGET_LABELS.items()}

ACTION_LABELS = {
    ActionKind.COPY.value: "复制",
    ActionKind.MOVE.value: "移动",
    ActionKind.SHORTCUT.value: "快捷方式",
    ActionKind.SKIP.value: "跳过",
}

PHASE_LABELS = {
    Phase.SCANNING.value: "扫描媒体",
    Phase.DEDUPLICATING.value: "查找重复项",
    Phase.DATING.value: "提取拍摄日期",
    Phase.MERGING_ALBUMS.value: "合并相册关系",
    Phase.PLANNING.value: "生成执行计划",
    Phase.EXECUTING.value: "写入输出目录",
    Phase.FIXING.value: "修复文件日期",
    Phase.FINISHED.value: "任务完成",
}

PREVIEW_BATCH_DEFAULT = 300
PREVIEW_BATCH_MINIMUM = 100
PREVIEW_BATCH_MAXIMUM = 1000


def _format_live_photo_status(statistics: Any) -> tuple[str, str]:
    """生成实况照片摘要；存在不可确认配对或歧义候选时使用警告色。"""

    pairs = max(int(getattr(statistics, "live_photo_pairs", 0)), 0)
    verified = min(max(int(getattr(statistics, "live_photo_metadata_verified", 0)), 0), pairs)
    incomplete = max(pairs - verified, 0)
    repaired = max(int(getattr(statistics, "live_photo_repaired_extensions", 0)), 0)
    ambiguous = max(int(getattr(statistics, "live_photo_ambiguous", 0)), 0)
    rejected = max(int(getattr(statistics, "live_photo_rejected", 0)), 0)
    headline = f"实况 {pairs:,} 组" if pairs else "未发现可可靠配对的实况照片"
    color = WARNING if incomplete or ambiguous or rejected else SUCCESS
    return (
        f" · {headline} · 完整 {verified:,}/{pairs:,} · 不完整 {incomplete:,}"
        f" · 后缀恢复 {repaired:,} · 歧义 {ambiguous:,} · 标识冲突拒绝 {rejected:,}",
        color,
    )


@dataclass(slots=True)
class _UiEvent:
    """后台线程发送给主线程的轻量事件。"""

    kind: str
    payload: Any = None


class _LatestProgressSlot:
    """只保留后台任务最新的一次进度，避免高频回调塞满界面队列。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value: ProgressUpdate | None = None

    def publish(self, update: ProgressUpdate) -> None:
        """后台线程写入时直接覆盖旧值；日志和结果事件仍走普通队列。"""

        with self._lock:
            self._value = update

    def take(self) -> ProgressUpdate | None:
        """主线程原子取走当前最新值。"""

        with self._lock:
            value = self._value
            self._value = None
        return value

    def clear(self) -> None:
        """结果事件到达后清空旧进度，防止完成状态被迟到消息覆盖。"""

        with self._lock:
            self._value = None


@dataclass(slots=True)
class _PreviewBatchCursor:
    """记录渐进式预览的下一段范围，所有动作最终都会被载入。"""

    total: int
    batch_size: int
    index: int = 0

    def take(self) -> tuple[int, int]:
        start = min(max(self.index, 0), self.total)
        end = min(start + max(self.batch_size, 1), self.total)
        self.index = end
        return start, end

    @property
    def finished(self) -> bool:
        return self.index >= self.total


class PhotoTakeoutApp(ctk.CTk):
    """应用主窗口，负责页面状态和后台任务协调。"""

    def __init__(self) -> None:
        self._settings = self._load_settings()
        appearance = str(self._settings.get("appearance", "System")).title()
        if appearance not in {"System", "Light", "Dark"}:
            appearance = "System"
        self._settings["appearance"] = appearance
        ctk.set_appearance_mode(appearance)
        ctk.set_default_color_theme("blue")
        # CustomTkinter 默认使用 Roboto，缺少中文字形时 Windows 会回退到宋体。
        # 在控件创建前换成平台原生中文无衬线字体，标题和正文会更统一清晰。
        cjk_font = {
            "win32": "Microsoft YaHei UI",
            "darwin": "PingFang SC",
        }.get(sys.platform, "Noto Sans CJK SC")
        ctk.ThemeManager.theme["CTkFont"]["family"] = cjk_font
        try:
            initial_scaling = float(self._settings.get("scaling", 1.0))
        except (TypeError, ValueError):
            initial_scaling = 1.0
        self._initial_scaling = min(max(initial_scaling, 0.8), 1.5)
        ctk.set_widget_scaling(self._initial_scaling)

        super().__init__()
        self.title(f"{APP_DISPLAY_NAME} · {APP_NAME}")
        self.geometry(self._settings.get("geometry", WINDOW_SIZE))
        self.minsize(*MIN_WINDOW_SIZE)
        self.configure(fg_color=("#EEF2F7", "#0B1220"))

        self._events: queue.Queue[_UiEvent] = queue.Queue()
        self._latest_progress = _LatestProgressSlot()
        self._ui_busy = False
        self._worker: threading.Thread | None = None
        self._task_context: TaskContext | None = None
        self._active_task: str | None = None
        self._analysis: AnalysisResult | None = None
        self._plan: list[PlanAction] = []
        self._preview_options: OrganizeOptions | None = None
        self._duplicate_dialog: DuplicatePreviewDialog | None = None
        self._log_records: list[tuple[str, str, str]] = []
        self._pages: dict[str, ctk.CTkFrame] = {}
        self._nav_buttons: dict[str, ctk.CTkButton] = {}
        self._stat_values: dict[str, ctk.CTkLabel] = {}
        self._options_expanded = True
        self._preview_render_generation = 0
        self._preview_render_actions: list[PlanAction] = []
        self._preview_batch_cursor: _PreviewBatchCursor | None = None

        self._create_variables()
        self._build_shell()
        self._build_organize_page()
        self._build_fix_page()
        self._build_log_page()
        self._build_settings_page()
        self._configure_tree_style()
        self._show_page("organize")

        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(70, self._poll_events)

    # ------------------------------------------------------------------
    # 初始化与页面框架
    # ------------------------------------------------------------------

    def _create_variables(self) -> None:
        """从持久化设置创建所有 Tk 变量。"""

        remember_paths = bool(self._settings.get("remember_paths", False))
        saved_input = self._settings.get("input_dir", "") if remember_paths else ""
        saved_output = self._settings.get("output_dir", "") if remember_paths else ""
        saved_fix = self._settings.get("fix_dir", "") if remember_paths else ""

        self.input_var = ctk.StringVar(value=saved_input)
        self.output_var = ctk.StringVar(value=saved_output)
        self.fix_dir_var = ctk.StringVar(value=saved_fix)

        operation = self._settings.get("operation", OperationMode.COPY.value)
        self.operation_var = ctk.StringVar(value="移动" if operation == "move" else "复制（推荐）")
        album_mode = self._settings.get("album_mode", AlbumMode.SHORTCUT.value)
        self.album_var = ctk.StringVar(value=ALBUM_VALUES.get(album_mode, next(iter(ALBUM_LABELS))))
        division = self._settings.get("date_division", DateDivision.YEAR_MONTH.value)
        self.division_var = ctk.StringVar(
            value=DIVISION_VALUES.get(division, next(iter(DIVISION_LABELS)))
        )
        conflict = self._settings.get("conflict_mode", ConflictMode.RENAME.value)
        self.conflict_var = ctk.StringVar(
            value=CONFLICT_VALUES.get(conflict, next(iter(CONFLICT_LABELS)))
        )
        unknown = self._settings.get("unknown_date_mode", UnknownDateMode.FOLDER.value)
        self.unknown_var = ctk.StringVar(
            value=UNKNOWN_VALUES.get(unknown, next(iter(UNKNOWN_LABELS)))
        )

        self.skip_extras_var = ctk.BooleanVar(value=bool(self._settings.get("skip_extras", False)))
        self.set_mtime_var = ctk.BooleanVar(value=bool(self._settings.get("set_file_mtime", True)))
        self.use_json_var = ctk.BooleanVar(value=bool(self._settings.get("use_json", True)))
        self.use_exif_var = ctk.BooleanVar(value=bool(self._settings.get("use_exif", True)))
        self.use_filename_var = ctk.BooleanVar(value=bool(self._settings.get("use_filename", True)))
        self.aggressive_json_var = ctk.BooleanVar(
            value=bool(self._settings.get("aggressive_json", True))
        )
        self.use_file_mtime_var = ctk.BooleanVar(
            value=bool(self._settings.get("use_file_mtime", False))
        )
        self.scan_fallback_var = ctk.BooleanVar(
            value=bool(self._settings.get("scan_all_if_no_takeout", True))
        )
        self.include_hidden_var = ctk.BooleanVar(
            value=bool(self._settings.get("include_hidden", False))
        )
        self.write_report_var = ctk.BooleanVar(value=bool(self._settings.get("write_report", True)))
        self.use_hash_cache_var = ctk.BooleanVar(
            value=bool(self._settings.get("use_hash_cache", True))
        )
        self.recognize_live_photos_var = ctk.BooleanVar(
            value=bool(self._settings.get("recognize_live_photos", False))
        )
        self.correct_date_filenames_var = ctk.BooleanVar(
            value=bool(self._settings.get("correct_date_filenames", False))
        )
        live_photo_target = self._settings.get("live_photo_target", LivePhotoTarget.APPLE.value)
        self.live_photo_target_var = ctk.StringVar(
            value=LIVE_PHOTO_TARGET_VALUES.get(
                str(live_photo_target), next(iter(LIVE_PHOTO_TARGET_LABELS))
            )
        )
        self.workers_var = ctk.StringVar(value=str(self._settings.get("workers", 4)))
        self.all_photos_var = ctk.StringVar(
            value=self._settings.get("all_photos_folder", "ALL_PHOTOS")
        )
        self.unknown_folder_var = ctk.StringVar(
            value=self._settings.get("unknown_date_folder", "date-unknown")
        )

        self.fix_recursive_var = ctk.BooleanVar(
            value=bool(self._settings.get("fix_recursive", True))
        )
        self.fix_json_var = ctk.BooleanVar(value=bool(self._settings.get("fix_json", True)))
        self.fix_exif_var = ctk.BooleanVar(value=bool(self._settings.get("fix_exif", True)))
        self.fix_filename_var = ctk.BooleanVar(value=bool(self._settings.get("fix_filename", True)))
        self.fix_aggressive_var = ctk.BooleanVar(
            value=bool(self._settings.get("fix_aggressive", True))
        )
        self.fix_file_mtime_var = ctk.BooleanVar(
            value=bool(self._settings.get("fix_file_mtime", False))
        )
        self.fix_hidden_var = ctk.BooleanVar(
            value=bool(self._settings.get("fix_include_hidden", False))
        )
        self.fix_dry_run_var = ctk.BooleanVar(value=bool(self._settings.get("fix_dry_run", False)))
        self.fix_correct_date_filenames_var = ctk.BooleanVar(
            value=bool(self._settings.get("fix_correct_date_filenames", False))
        )

        self.appearance_var = ctk.StringVar(value=self._settings.get("appearance", "System"))
        self.scaling_var = ctk.StringVar(value=f"{int(self._initial_scaling * 100)}%")
        self.preview_limit_var = ctk.StringVar(
            value=str(self._settings.get("preview_limit", PREVIEW_BATCH_DEFAULT))
        )
        self.remember_paths_var = ctk.BooleanVar(value=remember_paths)
        self.log_filter_var = ctk.StringVar(value="全部")

    def _build_shell(self) -> None:
        """构建侧栏和页面容器。"""

        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        sidebar = ctk.CTkFrame(self, width=218, corner_radius=0, fg_color=SIDEBAR_COLOR)
        sidebar.grid(row=0, column=0, sticky="nsew")
        sidebar.grid_propagate(False)
        sidebar.grid_rowconfigure(8, weight=1)

        brand = ctk.CTkFrame(sidebar, fg_color="transparent")
        brand.grid(row=0, column=0, padx=20, pady=(26, 28), sticky="ew")
        badge = ctk.CTkLabel(
            brand,
            text="PT",
            width=42,
            height=42,
            corner_radius=12,
            fg_color=PRIMARY,
            text_color="white",
            font=ctk.CTkFont(size=16, weight="bold"),
        )
        badge.grid(row=0, column=0, rowspan=2, padx=(0, 10))
        ctk.CTkLabel(
            brand,
            text="PhotoTakeout",
            font=ctk.CTkFont(size=17, weight="bold"),
            anchor="w",
        ).grid(row=0, column=1, sticky="sw")
        ctk.CTkLabel(
            brand,
            text="Studio",
            text_color=SIDEBAR_MUTED_TEXT,
            font=ctk.CTkFont(size=12),
            anchor="w",
        ).grid(row=1, column=1, sticky="nw")

        nav_items = (
            ("organize", "整理 Takeout"),
            ("fix", "修复文件日期"),
            ("logs", "运行日志"),
            ("settings", "设置与关于"),
        )
        for index, (key, text) in enumerate(nav_items, start=1):
            button = ctk.CTkButton(
                sidebar,
                text=text,
                height=42,
                corner_radius=10,
                anchor="w",
                border_spacing=14,
                fg_color="transparent",
                hover_color=("#E5E9F2", "#1F2937"),
                text_color=SIDEBAR_TEXT,
                font=ctk.CTkFont(size=14, weight="bold"),
                command=lambda page=key: self._show_page(page),
            )
            button.grid(row=index, column=0, padx=12, pady=4, sticky="ew")
            self._nav_buttons[key] = button

        footer = ctk.CTkFrame(sidebar, fg_color="transparent")
        footer.grid(row=9, column=0, padx=18, pady=18, sticky="sew")
        ctk.CTkLabel(
            footer,
            text="安全整理 · 本地处理",
            text_color=SIDEBAR_MUTED_TEXT,
            font=ctk.CTkFont(size=12),
        ).pack(anchor="w")
        ctk.CTkLabel(
            footer,
            text=f"v{APP_VERSION}",
            text_color=SIDEBAR_MUTED_TEXT,
            font=ctk.CTkFont(size=12),
        ).pack(anchor="w", pady=(3, 0))

        self.page_host = ctk.CTkFrame(self, corner_radius=0, fg_color="transparent")
        self.page_host.grid(row=0, column=1, sticky="nsew")
        self.page_host.grid_rowconfigure(0, weight=1)
        self.page_host.grid_columnconfigure(0, weight=1)

    def _new_page(self, key: str) -> ctk.CTkFrame:
        page = ctk.CTkFrame(self.page_host, fg_color="transparent")
        page.grid(row=0, column=0, sticky="nsew")
        self._pages[key] = page
        return page

    def _show_page(self, key: str) -> None:
        """切换页面并同步侧栏高亮。"""

        page = self._pages.get(key)
        if page is None:
            return
        page.tkraise()
        for name, button in self._nav_buttons.items():
            if name == key:
                button.configure(fg_color=PRIMARY, hover_color=PRIMARY_HOVER, text_color="white")
            else:
                button.configure(
                    fg_color="transparent",
                    hover_color=("#E5E9F2", "#1F2937"),
                    text_color=SIDEBAR_TEXT,
                )

    # ------------------------------------------------------------------
    # 整理页面
    # ------------------------------------------------------------------

    def _build_organize_page(self) -> None:
        """构建 Takeout 整理、预览与执行页面。"""

        page = self._new_page("organize")
        page.grid_columnconfigure(0, weight=1)
        page.grid_rowconfigure(4, weight=1)

        header = ctk.CTkFrame(page, fg_color="transparent")
        header.grid(row=0, column=0, padx=28, pady=(22, 12), sticky="ew")
        header.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(
            header,
            text="整理 Google Photos Takeout",
            font=ctk.CTkFont(size=25, weight="bold"),
            anchor="w",
        ).grid(row=0, column=0, sticky="w")
        ctk.CTkLabel(
            header,
            text="选择目录、调整规则，先预览再执行。所有处理均在本机完成。",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=13),
            anchor="w",
        ).grid(row=1, column=0, pady=(4, 0), sticky="w")
        self.options_toggle_button = ctk.CTkButton(
            header,
            text="收起选项",
            width=96,
            height=32,
            **SECONDARY_BUTTON_STYLE,
            command=self._toggle_options,
        )
        self.options_toggle_button.grid(row=0, column=1, rowspan=2, padx=(12, 0), sticky="e")

        path_card = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        path_card.grid(row=1, column=0, padx=28, pady=(0, 10), sticky="ew")
        path_card.grid_columnconfigure(1, weight=1)
        self._path_row(path_card, 0, "Takeout 输入目录", self.input_var, self._choose_input)
        self._path_row(path_card, 1, "整理结果输出目录", self.output_var, self._choose_output)

        options = ctk.CTkTabview(
            page,
            height=244,
            corner_radius=14,
            fg_color=CARD_COLOR,
            **TABVIEW_STYLE,
        )
        options.grid(row=2, column=0, padx=28, pady=(0, 10), sticky="ew")
        basic = options.add("基础选项")
        advanced = options.add("高级选项")
        self._build_basic_options(basic)
        self._build_advanced_options(advanced)
        options.set("基础选项")
        self.organize_options = options

        stats = ctk.CTkFrame(page, fg_color="transparent")
        stats.grid(row=3, column=0, padx=28, pady=(0, 10), sticky="ew")
        for column in range(5):
            stats.grid_columnconfigure(column, weight=1, uniform="stat")
        stat_specs = (
            ("discovered", "发现媒体"),
            ("unique", "去重后"),
            ("duplicates", "重复组"),
            ("unknown", "日期未知"),
            ("actions", "计划动作"),
        )
        for column, (key, title) in enumerate(stat_specs):
            card = ctk.CTkFrame(stats, fg_color=CARD_COLOR, corner_radius=12)
            card.grid(
                row=0,
                column=column,
                padx=(0 if column == 0 else 5, 0 if column == 4 else 5),
                sticky="ew",
            )
            ctk.CTkLabel(card, text=title, text_color=MUTED_TEXT, font=ctk.CTkFont(size=11)).pack(
                anchor="w", padx=14, pady=(9, 0)
            )
            value = ctk.CTkLabel(card, text="—", font=ctk.CTkFont(size=19, weight="bold"))
            value.pack(anchor="w", padx=14, pady=(0, 8))
            self._stat_values[key] = value

        preview_card = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        preview_card.grid(row=4, column=0, padx=28, pady=(0, 10), sticky="nsew")
        preview_card.grid_columnconfigure(0, weight=1)
        preview_card.grid_rowconfigure(1, weight=1)
        preview_head = ctk.CTkFrame(preview_card, fg_color="transparent")
        preview_head.grid(row=0, column=0, padx=15, pady=(10, 4), sticky="ew")
        preview_head.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(
            preview_head,
            text="执行计划预览",
            font=ctk.CTkFont(size=14, weight="bold"),
        ).grid(row=0, column=0, sticky="w")
        self.preview_hint = ctk.CTkLabel(
            preview_head,
            text="尚未扫描",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=11),
        )
        self.duplicate_button = ctk.CTkButton(
            preview_head,
            text="重复项对比",
            width=126,
            height=30,
            state="disabled",
            **SECONDARY_BUTTON_STYLE,
            command=self._open_duplicate_comparison,
        )
        self.duplicate_button.grid(row=0, column=1, padx=(10, 12), sticky="e")
        self.preview_hint.grid(row=0, column=2, sticky="e")

        table_frame = ctk.CTkFrame(preview_card, fg_color="transparent")
        table_frame.grid(row=1, column=0, padx=14, pady=(0, 12), sticky="nsew")
        table_frame.grid_columnconfigure(0, weight=1)
        table_frame.grid_rowconfigure(0, weight=1)
        columns = ("action", "source", "target", "date", "album")
        self.preview_tree = ttk.Treeview(
            table_frame,
            columns=columns,
            show="headings",
            style="GPTH.Treeview",
            selectmode="browse",
        )
        headings = {
            "action": ("动作", 86, False),
            "source": ("源文件", 250, True),
            "target": ("目标文件", 280, True),
            "date": ("拍摄日期", 142, False),
            "album": ("相册", 130, False),
        }
        for key, (title, width, stretch) in headings.items():
            self.preview_tree.heading(key, text=title)
            self.preview_tree.column(key, width=width, minwidth=70, stretch=stretch, anchor="w")
        self.preview_scrollbar = ctk.CTkScrollbar(
            table_frame,
            orientation="vertical",
            command=self.preview_tree.yview,
            **SCROLLBAR_STYLE,
        )
        self.preview_x_scrollbar = ctk.CTkScrollbar(
            table_frame,
            orientation="horizontal",
            command=self.preview_tree.xview,
            height=12,
            **SCROLLBAR_STYLE,
        )
        self.preview_tree.configure(
            yscrollcommand=self.preview_scrollbar.set,
            xscrollcommand=self.preview_x_scrollbar.set,
        )
        self.preview_tree.grid(row=0, column=0, sticky="nsew")
        self.preview_scrollbar.grid(row=0, column=1, padx=(4, 0), sticky="ns")
        self.preview_x_scrollbar.grid(row=1, column=0, pady=(4, 0), sticky="ew")

        controls = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        controls.grid(row=5, column=0, padx=28, pady=(0, 22), sticky="ew")
        controls.grid_columnconfigure(0, weight=1)
        progress_area = ctk.CTkFrame(controls, fg_color="transparent")
        progress_area.grid(row=0, column=0, padx=16, pady=12, sticky="ew")
        progress_area.grid_columnconfigure(0, weight=1)
        self.organize_status = ctk.CTkLabel(
            progress_area,
            text="准备就绪",
            text_color=MUTED_TEXT,
            anchor="w",
            justify="left",
            wraplength=330,
            font=ctk.CTkFont(size=11),
        )
        self.organize_status.grid(row=0, column=0, sticky="ew")
        self.organize_progress = ctk.CTkProgressBar(
            progress_area,
            **PROGRESS_STYLE,
        )
        self.organize_progress.grid(row=1, column=0, pady=(6, 0), sticky="ew")
        self.organize_progress.set(0)

        button_area = ctk.CTkFrame(controls, fg_color="transparent")
        button_area.grid(row=0, column=1, padx=(4, 16), pady=12, sticky="e")
        self.analyze_button = ctk.CTkButton(
            button_area,
            text="扫描预览",
            width=104,
            height=38,
            **SECONDARY_BUTTON_STYLE,
            command=self._start_analysis,
        )
        self.analyze_button.grid(row=0, column=0, padx=4)
        self.execute_button = ctk.CTkButton(
            button_area,
            text="开始整理",
            width=104,
            height=38,
            fg_color=PRIMARY,
            hover_color=PRIMARY_HOVER,
            command=self._start_execution,
        )
        self.execute_button.grid(row=0, column=1, padx=4)
        self.cancel_button = ctk.CTkButton(
            button_area,
            text="取消",
            width=76,
            height=38,
            fg_color="transparent",
            border_width=1,
            border_color=("#D0D5DD", "#475467"),
            text_color=("#344054", "#E5E7EB"),
            hover_color=("#F2F4F7", "#273142"),
            state="disabled",
            command=self._cancel_task,
        )
        self.cancel_button.grid(row=0, column=2, padx=(4, 0))

    def _toggle_options(self) -> None:
        """让用户随时展开或收起整理选项。"""

        self._set_options_expanded(not self._options_expanded)

    def _set_options_expanded(self, expanded: bool) -> None:
        """收起固定高度选项区，为执行计划表释放垂直空间。"""

        self._options_expanded = bool(expanded)
        if self._options_expanded:
            self.organize_options.grid()
            self.options_toggle_button.configure(text="收起选项")
        else:
            # grid_remove 会保留原网格参数，重新展开时不会发生布局跳位。
            self.organize_options.grid_remove()
            self.options_toggle_button.configure(text="展开选项")

    def _path_row(
        self,
        parent: ctk.CTkFrame,
        row: int,
        title: str,
        variable: ctk.StringVar,
        command: Callable[[], None],
    ) -> None:
        ctk.CTkLabel(
            parent,
            text=title,
            width=145,
            anchor="w",
            font=ctk.CTkFont(size=12, weight="bold"),
        ).grid(
            row=row,
            column=0,
            padx=(16, 8),
            pady=(13 if row == 0 else 5, 13 if row == 1 else 5),
            sticky="w",
        )
        ctk.CTkEntry(
            parent,
            textvariable=variable,
            height=35,
            border_width=1,
            border_color=("#D0D5DD", "#344054"),
        ).grid(row=row, column=1, pady=(13 if row == 0 else 5, 13 if row == 1 else 5), sticky="ew")
        ctk.CTkButton(
            parent,
            text="浏览…",
            width=78,
            height=35,
            fg_color=("#EEF0F5", "#273142"),
            hover_color=("#E1E5EC", "#344054"),
            text_color=("#344054", "#F2F4F7"),
            command=command,
        ).grid(row=row, column=2, padx=12, pady=(13 if row == 0 else 5, 13 if row == 1 else 5))

    def _build_basic_options(self, parent: ctk.CTkFrame) -> None:
        parent.grid_columnconfigure((0, 1, 2), weight=1, uniform="basic")
        self._option_label(parent, "处理方式", 0, 0)
        ctk.CTkSegmentedButton(
            parent,
            values=["复制（推荐）", "移动"],
            variable=self.operation_var,
            height=34,
            **SEGMENTED_BUTTON_STYLE,
        ).grid(row=1, column=0, padx=(14, 7), pady=(3, 5), sticky="ew")

        self._option_label(parent, "相册处理", 0, 1)
        ctk.CTkOptionMenu(
            parent,
            values=list(ALBUM_LABELS),
            variable=self.album_var,
            height=34,
            **OPTION_MENU_STYLE,
        ).grid(row=1, column=1, padx=7, pady=(3, 5), sticky="ew")

        self._option_label(parent, "目录结构", 0, 2)
        ctk.CTkOptionMenu(
            parent,
            values=list(DIVISION_LABELS),
            variable=self.division_var,
            height=34,
            **OPTION_MENU_STYLE,
        ).grid(row=1, column=2, padx=(7, 14), pady=(3, 5), sticky="ew")

        ctk.CTkSwitch(
            parent,
            text="跳过编辑版、特效版等额外副本",
            variable=self.skip_extras_var,
            progress_color=PRIMARY,
            font=ctk.CTkFont(size=11),
        ).grid(row=2, column=0, padx=14, pady=(8, 10), sticky="w")
        ctk.CTkSwitch(
            parent,
            text="写入正确的文件修改时间",
            variable=self.set_mtime_var,
            progress_color=PRIMARY,
            font=ctk.CTkFont(size=11),
        ).grid(row=2, column=1, padx=10, pady=(8, 10), sticky="w")
        ctk.CTkSwitch(
            parent,
            text="生成 JSON 运行报告",
            variable=self.write_report_var,
            progress_color=PRIMARY,
            font=ctk.CTkFont(size=11),
        ).grid(row=2, column=2, padx=10, pady=(8, 10), sticky="w")

        ctk.CTkCheckBox(
            parent,
            text="按拍摄日期修正日期型文件名",
            variable=self.correct_date_filenames_var,
            checkbox_width=18,
            checkbox_height=18,
            font=ctk.CTkFont(size=11, weight="bold"),
            **CHECKBOX_STYLE,
        ).grid(row=3, column=0, padx=14, pady=(2, 0), sticky="w")
        ctk.CTkLabel(
            parent,
            text="仅处理完整日期型名称 YYYY-MM-DD(编号)，保留编号和扩展名；默认关闭。",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=10),
            anchor="w",
        ).grid(row=3, column=1, columnspan=2, padx=(10, 14), pady=(2, 0), sticky="w")

    def _build_advanced_options(self, parent: ctk.CTkFrame) -> None:
        parent.grid_columnconfigure((0, 1, 2, 3), weight=1, uniform="advanced")

        self._option_label(parent, "同名文件", 0, 0)
        ctk.CTkOptionMenu(
            parent,
            values=list(CONFLICT_LABELS),
            variable=self.conflict_var,
            height=32,
            **OPTION_MENU_STYLE,
        ).grid(row=1, column=0, padx=(14, 6), sticky="ew")
        self._option_label(parent, "未知日期", 0, 1)
        ctk.CTkOptionMenu(
            parent,
            values=list(UNKNOWN_LABELS),
            variable=self.unknown_var,
            height=32,
            **OPTION_MENU_STYLE,
        ).grid(row=1, column=1, padx=6, sticky="ew")
        self._option_label(parent, "并发线程", 0, 2)
        ctk.CTkOptionMenu(
            parent,
            values=["1", "2", "4", "6", "8", "12", "16"],
            variable=self.workers_var,
            height=32,
            **OPTION_MENU_STYLE,
        ).grid(row=1, column=2, padx=6, sticky="ew")

        folder_names = ctk.CTkFrame(parent, fg_color="transparent")
        folder_names.grid(row=0, column=3, rowspan=2, padx=(6, 14), sticky="nsew")
        folder_names.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(
            folder_names, text="总照片目录", text_color=MUTED_TEXT, font=ctk.CTkFont(size=10)
        ).grid(row=0, column=0, padx=(0, 5), pady=(2, 3), sticky="w")
        ctk.CTkEntry(folder_names, textvariable=self.all_photos_var, height=27).grid(
            row=0, column=1, pady=(2, 3), sticky="ew"
        )
        ctk.CTkLabel(
            folder_names, text="未知日期目录", text_color=MUTED_TEXT, font=ctk.CTkFont(size=10)
        ).grid(row=1, column=0, padx=(0, 5), pady=(3, 0), sticky="w")
        ctk.CTkEntry(folder_names, textvariable=self.unknown_folder_var, height=27).grid(
            row=1, column=1, pady=(3, 0), sticky="ew"
        )

        sources = ctk.CTkFrame(parent, fg_color="transparent")
        sources.grid(row=2, column=0, columnspan=4, padx=14, pady=(10, 8), sticky="ew")
        sources.grid_columnconfigure((0, 1, 2, 3), weight=1, uniform="sources")
        source_specs = (
            ("JSON", self.use_json_var),
            ("EXIF", self.use_exif_var),
            ("文件名", self.use_filename_var),
            ("深度匹配 JSON", self.aggressive_json_var),
            ("文件原修改时间", self.use_file_mtime_var),
            ("无 Takeout 结构时扫描全部", self.scan_fallback_var),
            ("包含隐藏文件", self.include_hidden_var),
            ("复用未变化文件指纹", self.use_hash_cache_var),
        )
        for index, (text, variable) in enumerate(source_specs):
            ctk.CTkCheckBox(
                sources,
                text=text,
                variable=variable,
                width=20,
                checkbox_width=18,
                checkbox_height=18,
                corner_radius=5,
                font=ctk.CTkFont(size=10),
                **CHECKBOX_STYLE,
            ).grid(
                row=index // 4,
                column=index % 4,
                padx=(0, 18),
                pady=(0, 7) if index < 4 else 0,
                sticky="w",
            )

        self.live_photo_checkbox = ctk.CTkCheckBox(
            sources,
            text="识别并配对实况照片（Live Photo）",
            variable=self.recognize_live_photos_var,
            width=20,
            checkbox_width=18,
            checkbox_height=18,
            corner_radius=5,
            font=ctk.CTkFont(size=10, weight="bold"),
            command=self._sync_live_photo_controls,
            **CHECKBOX_STYLE,
        )
        self.live_photo_checkbox.grid(
            row=2, column=0, columnspan=2, padx=(0, 18), pady=(9, 0), sticky="w"
        )

        target_controls = ctk.CTkFrame(sources, fg_color="transparent")
        target_controls.grid(row=2, column=2, columnspan=2, padx=(0, 0), pady=(9, 0), sticky="ew")
        target_controls.grid_columnconfigure(1, weight=1)
        self.live_photo_target_label = ctk.CTkLabel(
            target_controls,
            text="后续导入方式",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=9),
        )
        self.live_photo_target_label.grid(row=0, column=0, padx=(0, 8), sticky="w")
        self.live_photo_target_menu = ctk.CTkOptionMenu(
            target_controls,
            values=list(LIVE_PHOTO_TARGET_LABELS),
            variable=self.live_photo_target_var,
            height=29,
            font=ctk.CTkFont(size=10),
            command=lambda _value: self._sync_live_photo_controls(),
            **OPTION_MENU_STYLE,
        )
        self.live_photo_target_menu.grid(
            row=0,
            column=1,
            padx=0,
            pady=0,
            sticky="ew",
        )
        self.live_photo_hint = ctk.CTkLabel(
            sources,
            text="按内容识别；不转码、不把真 MP3 当动态片段",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=9),
            anchor="w",
            justify="left",
            wraplength=610,
        )
        self.live_photo_hint.grid(row=3, column=0, columnspan=4, padx=0, pady=(6, 0), sticky="ew")
        self._sync_live_photo_controls()

    def _sync_live_photo_controls(self) -> None:
        """勾选关闭时弱化目标选择，但保留用户上次的平台。"""

        enabled = self.recognize_live_photos_var.get()
        busy = self._ui_busy
        if hasattr(self, "live_photo_checkbox"):
            self.live_photo_checkbox.configure(state="disabled" if busy else "normal")
        if hasattr(self, "live_photo_target_menu"):
            self.live_photo_target_menu.configure(
                state="normal" if enabled and not busy else "disabled"
            )
        if hasattr(self, "live_photo_hint"):
            target = LIVE_PHOTO_TARGET_LABELS.get(
                self.live_photo_target_var.get(), LivePhotoTarget.APPLE
            )
            hint = (
                "两项均输出 Apple 原始双文件；不转码，真 MP3 只做内容探测且不纳入整理。"
                "Apple“照片”需同时导入两半。"
                if target is LivePhotoTarget.APPLE
                else "两项均输出 Apple 原始双文件；不转码，真 MP3 只做内容探测且不纳入整理。"
                "ColorOS 需经 O+ 互联传输。"
            )
            self.live_photo_hint.configure(
                text=hint,
                text_color=(MUTED_TEXT if enabled and not busy else ("#667085", "#7C8798")),
            )

    @staticmethod
    def _option_label(parent: ctk.CTkFrame, text: str, row: int, column: int) -> None:
        ctk.CTkLabel(
            parent,
            text=text,
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=11, weight="bold"),
            anchor="w",
        ).grid(row=row, column=column, padx=14, pady=(4, 0), sticky="w")

    # ------------------------------------------------------------------
    # 日期修复页面
    # ------------------------------------------------------------------

    def _build_fix_page(self) -> None:
        """构建修改文件时间及可选修正日期型文件名的独立页面。"""

        page = self._new_page("fix")
        page.grid_columnconfigure(0, weight=1)
        page.grid_rowconfigure(3, weight=1)

        self._page_header(
            page,
            "修复文件拍摄日期",
            "不重组目录；修正媒体修改时间，也可安全修正错误的日期型文件名。",
        )

        path_card = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        path_card.grid(row=1, column=0, padx=28, pady=(0, 12), sticky="ew")
        path_card.grid_columnconfigure(1, weight=1)
        self._path_row(path_card, 0, "待修复媒体目录", self.fix_dir_var, self._choose_fix_dir)

        content = ctk.CTkFrame(page, fg_color="transparent")
        content.grid(row=2, column=0, padx=28, pady=(0, 12), sticky="ew")
        content.grid_columnconfigure((0, 1), weight=1, uniform="fix")

        rules = ctk.CTkFrame(content, fg_color=CARD_COLOR, corner_radius=14)
        rules.grid(row=0, column=0, padx=(0, 6), sticky="nsew")
        ctk.CTkLabel(rules, text="日期来源", font=ctk.CTkFont(size=15, weight="bold")).pack(
            anchor="w", padx=18, pady=(15, 9)
        )
        rule_specs = (
            ("读取 Google Photos JSON", self.fix_json_var),
            ("读取照片 EXIF", self.fix_exif_var),
            ("从文件名识别日期", self.fix_filename_var),
            ("启用深度 JSON 匹配", self.fix_aggressive_var),
            ("最后使用文件原修改时间", self.fix_file_mtime_var),
        )
        for text, variable in rule_specs:
            ctk.CTkCheckBox(
                rules,
                text=text,
                variable=variable,
                checkbox_width=19,
                checkbox_height=19,
                font=ctk.CTkFont(size=12),
                **CHECKBOX_STYLE,
            ).pack(anchor="w", padx=18, pady=5)
        ctk.CTkFrame(rules, height=8, fg_color="transparent").pack()

        behavior = ctk.CTkFrame(content, fg_color=CARD_COLOR, corner_radius=14)
        behavior.grid(row=0, column=1, padx=(6, 0), sticky="nsew")
        ctk.CTkLabel(behavior, text="执行方式", font=ctk.CTkFont(size=15, weight="bold")).pack(
            anchor="w", padx=18, pady=(15, 9)
        )
        ctk.CTkSwitch(
            behavior,
            text="递归处理所有子目录",
            variable=self.fix_recursive_var,
            progress_color=PRIMARY,
        ).pack(anchor="w", padx=18, pady=8)
        ctk.CTkSwitch(
            behavior,
            text="仅预演，不修改任何文件",
            variable=self.fix_dry_run_var,
            progress_color=WARNING,
        ).pack(anchor="w", padx=18, pady=8)
        ctk.CTkSwitch(
            behavior,
            text="包含隐藏文件与隐藏目录",
            variable=self.fix_hidden_var,
            progress_color=PRIMARY,
        ).pack(anchor="w", padx=18, pady=8)
        ctk.CTkCheckBox(
            behavior,
            text="按拍摄日期修正日期型文件名",
            variable=self.fix_correct_date_filenames_var,
            checkbox_width=19,
            checkbox_height=19,
            font=ctk.CTkFont(size=12, weight="bold"),
            **CHECKBOX_STYLE,
        ).pack(anchor="w", padx=18, pady=(8, 3))
        ctk.CTkLabel(
            behavior,
            text=(
                "重命名仅针对完整日期型名称 YYYY-MM-DD(编号)，\n"
                "保留编号和扩展名；建议首次先启用“仅预演”。"
            ),
            justify="left",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=11),
        ).pack(anchor="w", padx=18, pady=(16, 12))

        result_card = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        result_card.grid(row=3, column=0, padx=28, pady=(0, 12), sticky="nsew")
        result_card.grid_columnconfigure(0, weight=1)
        result_card.grid_rowconfigure(1, weight=1)
        ctk.CTkLabel(
            result_card,
            text="任务摘要",
            font=ctk.CTkFont(size=15, weight="bold"),
        ).grid(row=0, column=0, padx=18, pady=(15, 5), sticky="w")
        self.fix_summary = ctk.CTkTextbox(
            result_card,
            corner_radius=10,
            border_width=0,
            fg_color=("#F7F8FA", "#111827"),
            font=("Microsoft YaHei UI", 12),
            wrap="word",
        )
        self.fix_summary.grid(row=1, column=0, padx=16, pady=(5, 12), sticky="nsew")
        self.fix_summary.insert("end", "等待任务开始。")
        self.fix_summary.configure(state="disabled")

        controls = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        controls.grid(row=4, column=0, padx=28, pady=(0, 22), sticky="ew")
        controls.grid_columnconfigure(0, weight=1)
        status_area = ctk.CTkFrame(controls, fg_color="transparent")
        status_area.grid(row=0, column=0, padx=16, pady=12, sticky="ew")
        status_area.grid_columnconfigure(0, weight=1)
        self.fix_status = ctk.CTkLabel(
            status_area, text="准备就绪", text_color=MUTED_TEXT, anchor="w"
        )
        self.fix_status.grid(row=0, column=0, sticky="ew")
        self.fix_progress = ctk.CTkProgressBar(status_area, **PROGRESS_STYLE)
        self.fix_progress.grid(row=1, column=0, pady=(6, 0), sticky="ew")
        self.fix_progress.set(0)

        self.fix_button = ctk.CTkButton(
            controls,
            text="开始修复",
            width=108,
            height=38,
            fg_color=PRIMARY,
            hover_color=PRIMARY_HOVER,
            command=self._start_fix_dates,
        )
        self.fix_button.grid(row=0, column=1, padx=4, pady=12)
        self.fix_cancel_button = ctk.CTkButton(
            controls,
            text="取消",
            width=76,
            height=38,
            fg_color="transparent",
            border_width=1,
            border_color=("#D0D5DD", "#475467"),
            text_color=("#344054", "#E5E7EB"),
            state="disabled",
            command=self._cancel_task,
        )
        self.fix_cancel_button.grid(row=0, column=2, padx=(4, 16), pady=12)

    # ------------------------------------------------------------------
    # 日志与设置页面
    # ------------------------------------------------------------------

    def _build_log_page(self) -> None:
        page = self._new_page("logs")
        page.grid_columnconfigure(0, weight=1)
        page.grid_rowconfigure(2, weight=1)
        self._page_header(page, "运行日志", "查看扫描、日期提取、复制和错误详情。")

        toolbar = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        toolbar.grid(row=1, column=0, padx=28, pady=(0, 10), sticky="ew")
        toolbar.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(toolbar, text="显示级别", text_color=MUTED_TEXT).grid(
            row=0, column=0, padx=(16, 7), pady=11, sticky="e"
        )
        ctk.CTkOptionMenu(
            toolbar,
            values=["全部", "INFO", "WARNING", "ERROR", "DEBUG"],
            variable=self.log_filter_var,
            width=116,
            height=32,
            command=lambda _value: self._render_logs(),
            **OPTION_MENU_STYLE,
        ).grid(row=0, column=1, padx=5, pady=11)
        ctk.CTkButton(
            toolbar,
            text="清空",
            width=72,
            height=32,
            fg_color=("#EEF0F5", "#273142"),
            hover_color=("#E1E5EC", "#344054"),
            text_color=("#344054", "#F2F4F7"),
            command=self._clear_logs,
        ).grid(row=0, column=2, padx=5, pady=11)
        ctk.CTkButton(
            toolbar,
            text="导出日志",
            width=90,
            height=32,
            fg_color=PRIMARY,
            hover_color=PRIMARY_HOVER,
            command=self._export_logs,
        ).grid(row=0, column=3, padx=(5, 16), pady=11)

        log_card = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        log_card.grid(row=2, column=0, padx=28, pady=(0, 22), sticky="nsew")
        log_card.grid_columnconfigure(0, weight=1)
        log_card.grid_rowconfigure(0, weight=1)
        self.log_text = ctk.CTkTextbox(
            log_card,
            corner_radius=10,
            border_width=0,
            fg_color=("#F7F8FA", "#0E1625"),
            font=("Cascadia Mono", 11),
            wrap="word",
        )
        self.log_text.grid(row=0, column=0, padx=14, pady=14, sticky="nsew")
        self.log_text.configure(state="disabled")

    def _build_settings_page(self) -> None:
        page = self._new_page("settings")
        page.grid_columnconfigure((0, 1), weight=1, uniform="settings")
        page.grid_rowconfigure(2, weight=1)
        self._page_header(
            page, "设置与关于", "个性化界面，并了解本工具如何保护你的照片。", columnspan=2
        )

        settings_card = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        settings_card.grid(row=1, column=0, padx=(28, 7), pady=(0, 12), sticky="nsew")
        settings_card.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(settings_card, text="界面设置", font=ctk.CTkFont(size=16, weight="bold")).grid(
            row=0, column=0, columnspan=2, padx=18, pady=(16, 14), sticky="w"
        )
        self._settings_row(settings_card, 1, "外观模式")
        ctk.CTkOptionMenu(
            settings_card,
            values=["System", "Light", "Dark"],
            variable=self.appearance_var,
            command=self._change_appearance,
            **OPTION_MENU_STYLE,
        ).grid(row=1, column=1, padx=18, pady=7, sticky="ew")
        self._settings_row(settings_card, 2, "界面缩放")
        ctk.CTkOptionMenu(
            settings_card,
            values=["90%", "100%", "110%", "125%"],
            variable=self.scaling_var,
            command=self._change_scaling,
            **OPTION_MENU_STYLE,
        ).grid(row=2, column=1, padx=18, pady=7, sticky="ew")
        self._settings_row(settings_card, 3, "每批预览行数")
        ctk.CTkOptionMenu(
            settings_card,
            values=["100", "300", "500", "1000"],
            variable=self.preview_limit_var,
            **OPTION_MENU_STYLE,
        ).grid(row=3, column=1, padx=18, pady=7, sticky="ew")
        self._settings_row(settings_card, 4, "扫描指纹缓存")
        cache_controls = ctk.CTkFrame(settings_card, fg_color="transparent")
        cache_controls.grid(row=4, column=1, padx=18, pady=7, sticky="ew")
        cache_controls.grid_columnconfigure(0, weight=1)
        self.cache_status_label = ctk.CTkLabel(
            cache_controls,
            text="仅保存路径、文件状态与 SHA-256",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=10),
            anchor="w",
        )
        self.cache_status_label.grid(row=0, column=0, padx=(0, 8), sticky="ew")
        self.clear_cache_button = ctk.CTkButton(
            cache_controls,
            text="清理",
            width=62,
            height=28,
            **SECONDARY_BUTTON_STYLE,
            command=self._clear_hash_cache,
        )
        self.clear_cache_button.grid(row=0, column=1, sticky="e")
        ctk.CTkSwitch(
            settings_card,
            text="记住最近使用的目录",
            variable=self.remember_paths_var,
            progress_color=PRIMARY,
        ).grid(row=5, column=0, columnspan=2, padx=18, pady=(14, 18), sticky="w")

        about_card = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        about_card.grid(row=1, column=1, padx=(7, 28), pady=(0, 12), sticky="nsew")
        ctk.CTkLabel(
            about_card, text="关于 PhotoTakeout Studio", font=ctk.CTkFont(size=16, weight="bold")
        ).pack(anchor="w", padx=18, pady=(16, 9))
        ctk.CTkLabel(
            about_card,
            text=(
                f"版本 {APP_VERSION}\n\n"
                "用于整理 Google Photos Takeout 导出的照片和视频。\n"
                "支持相册关系、重复项识别、日期恢复、预览与取消。\n\n"
                "本工具不会上传照片；所有扫描与复制均在本机执行。"
            ),
            justify="left",
            anchor="nw",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=12),
        ).pack(fill="both", expand=True, padx=18, pady=(0, 18))

        safety = ctk.CTkFrame(page, fg_color=CARD_COLOR, corner_radius=14)
        safety.grid(row=2, column=0, columnspan=2, padx=28, pady=(0, 22), sticky="nsew")
        ctk.CTkLabel(safety, text="使用建议", font=ctk.CTkFont(size=16, weight="bold")).pack(
            anchor="w", padx=18, pady=(16, 8)
        )
        ctk.CTkLabel(
            safety,
            text=(
                "• 首次使用请选择“复制”，并保留 Google Takeout 原始压缩包。\n"
                "• 先运行“扫描预览”，重点检查未知日期、跳过项与目标路径。\n"
                "• 移动和覆盖模式会改变现有文件；确认输出无误后再清理原文件。\n"
                "• 任务取消后，已完成的独立文件会保留；日志会说明停止位置。"
            ),
            justify="left",
            anchor="nw",
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=12),
        ).pack(fill="x", padx=18, pady=(0, 18))

    def _page_header(
        self,
        page: ctk.CTkFrame,
        title: str,
        subtitle: str,
        *,
        columnspan: int = 1,
    ) -> None:
        header = ctk.CTkFrame(page, fg_color="transparent")
        header.grid(row=0, column=0, columnspan=columnspan, padx=28, pady=(22, 16), sticky="ew")
        ctk.CTkLabel(header, text=title, font=ctk.CTkFont(size=25, weight="bold"), anchor="w").pack(
            anchor="w"
        )
        ctk.CTkLabel(
            header,
            text=subtitle,
            text_color=MUTED_TEXT,
            font=ctk.CTkFont(size=13),
            anchor="w",
        ).pack(anchor="w", pady=(4, 0))

    @staticmethod
    def _settings_row(parent: ctk.CTkFrame, row: int, text: str) -> None:
        ctk.CTkLabel(parent, text=text, text_color=MUTED_TEXT, anchor="w").grid(
            row=row, column=0, padx=18, pady=7, sticky="w"
        )

    # ------------------------------------------------------------------
    # 选项收集与目录选择
    # ------------------------------------------------------------------

    def _choose_input(self) -> None:
        path = filedialog.askdirectory(title="选择已合并解压的 Google Takeout 目录")
        if path:
            self.input_var.set(path)

    def _choose_output(self) -> None:
        path = filedialog.askdirectory(title="选择整理结果输出目录", mustexist=False)
        if path:
            self.output_var.set(path)

    def _choose_fix_dir(self) -> None:
        path = filedialog.askdirectory(title="选择需要修复日期的媒体目录")
        if path:
            self.fix_dir_var.set(path)

    def _collect_organize_options(self) -> OrganizeOptions | None:
        """把界面状态转换为经过校验的引擎选项。"""

        if not self.input_var.get().strip() or not self.output_var.get().strip():
            messagebox.showwarning("目录不完整", "请先选择输入目录和输出目录。", parent=self)
            return None
        try:
            options = OrganizeOptions(
                input_dir=Path(self.input_var.get().strip()),
                output_dir=Path(self.output_var.get().strip()),
                operation=OperationMode.COPY
                if self.operation_var.get() == "复制（推荐）"
                else OperationMode.MOVE,
                album_mode=ALBUM_LABELS[self.album_var.get()],
                date_division=DIVISION_LABELS[self.division_var.get()],
                conflict_mode=CONFLICT_LABELS[self.conflict_var.get()],
                unknown_date_mode=UNKNOWN_LABELS[self.unknown_var.get()],
                skip_extras=self.skip_extras_var.get(),
                use_json=self.use_json_var.get(),
                use_exif=self.use_exif_var.get(),
                use_filename=self.use_filename_var.get(),
                aggressive_json=self.aggressive_json_var.get(),
                use_file_mtime=self.use_file_mtime_var.get(),
                set_file_mtime=self.set_mtime_var.get(),
                correct_date_filenames=self.correct_date_filenames_var.get(),
                scan_all_if_no_takeout=self.scan_fallback_var.get(),
                include_hidden=self.include_hidden_var.get(),
                write_report=self.write_report_var.get(),
                use_hash_cache=self.use_hash_cache_var.get(),
                recognize_live_photos=self.recognize_live_photos_var.get(),
                live_photo_target=LIVE_PHOTO_TARGET_LABELS[self.live_photo_target_var.get()],
                all_photos_folder=self.all_photos_var.get(),
                unknown_date_folder=self.unknown_folder_var.get(),
                workers=int(self.workers_var.get()),
            ).normalized()
        except (KeyError, OSError, ValueError) as exc:
            messagebox.showerror("选项无效", f"无法读取当前选项：{exc}", parent=self)
            return None

        errors = options.validate()
        if errors:
            messagebox.showerror("无法开始", "\n".join(f"• {item}" for item in errors), parent=self)
            return None
        return options

    def _collect_fix_options(self) -> FixDateOptions | None:
        if not self.fix_dir_var.get().strip():
            messagebox.showwarning("请选择目录", "请选择需要修复日期的媒体目录。", parent=self)
            return None
        path = Path(self.fix_dir_var.get().strip()).expanduser()
        if not path.is_dir():
            messagebox.showerror("目录无效", "所选目录不存在或不是文件夹。", parent=self)
            return None
        if not any(
            (
                self.fix_json_var.get(),
                self.fix_exif_var.get(),
                self.fix_filename_var.get(),
                self.fix_file_mtime_var.get(),
            )
        ):
            messagebox.showwarning("缺少日期来源", "请至少启用一种日期来源。", parent=self)
            return None
        return FixDateOptions(
            input_dir=path.resolve(),
            recursive=self.fix_recursive_var.get(),
            use_json=self.fix_json_var.get(),
            use_exif=self.fix_exif_var.get(),
            use_filename=self.fix_filename_var.get(),
            aggressive_json=self.fix_aggressive_var.get(),
            use_file_mtime=self.fix_file_mtime_var.get(),
            dry_run=self.fix_dry_run_var.get(),
            include_hidden=self.fix_hidden_var.get(),
            correct_date_filenames=self.fix_correct_date_filenames_var.get(),
        )

    # ------------------------------------------------------------------
    # 后台任务与引擎对接
    # ------------------------------------------------------------------

    def _start_analysis(self) -> None:
        options = self._collect_organize_options()
        if options is None:
            return

        self._clear_preview()

        def work(context: TaskContext) -> None:
            engine = self._new_engine()
            analysis = self._invoke_engine(engine.analyze, options, context)
            actions = list(self._invoke_engine(engine.build_plan, analysis, context))
            self._events.put(_UiEvent("analysis_result", (analysis, actions, options)))

        self._launch_task("analyze", work)

    def _start_execution(self) -> None:
        options = self._collect_organize_options()
        if options is None:
            return
        if options.operation is OperationMode.MOVE:
            if not messagebox.askyesno(
                "确认移动模式",
                "移动会改变输入目录。建议先使用复制模式验证结果。\n\n确定继续吗？",
                icon="warning",
                parent=self,
            ):
                return
        if options.conflict_mode is ConflictMode.OVERWRITE:
            if not messagebox.askyesno(
                "确认覆盖同名文件",
                "覆盖模式可能永久替换输出目录中的同名文件。\n\n确定继续吗？",
                icon="warning",
                parent=self,
            ):
                return

        reusable = self._analysis is not None and self._preview_options == options
        if not reusable:
            messagebox.showinfo(
                "需要最新预览",
                "尚未生成预览，或预览后修改了选项。\n现在将先扫描并生成新的执行计划；检查无误后请再次点击“开始整理”。",
                parent=self,
            )
            self._start_analysis()
            return
        if not self._plan:
            messagebox.showinfo(
                "没有可执行动作", "当前计划为空，请调整选项或输入目录后重新扫描。", parent=self
            )
            return

        def work(context: TaskContext) -> None:
            engine = self._new_engine()
            result = self._invoke_engine(engine.execute, self._analysis, self._plan, context)
            self._events.put(_UiEvent("execution_result", result))

        self._launch_task("execute", work)

    def _start_fix_dates(self) -> None:
        options = self._collect_fix_options()
        if options is None:
            return
        if not options.dry_run:
            if not messagebox.askyesno(
                "确认修改文件时间",
                "此操作会修改目录内媒体文件的最后修改时间。\n建议先启用“仅预演”。\n\n确定继续吗？",
                icon="warning",
                parent=self,
            ):
                return

        def work(context: TaskContext) -> None:
            engine = self._new_engine()
            result = self._invoke_engine(engine.fix_dates, options, context)
            self._events.put(_UiEvent("fix_result", result))

        self._launch_task("fix", work)

    @staticmethod
    def _new_engine() -> Any:
        """延迟导入引擎，避免界面模块参与核心层初始化。"""

        from .engine import TakeoutEngine

        return TakeoutEngine()

    @staticmethod
    def _invoke_engine(method: Callable[..., Any], *args: Any) -> Any:
        """兼容仍在演进中的可选 context 参数，同时不吞掉业务 TypeError。"""

        signature = inspect.signature(method)
        candidates: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        if args and isinstance(args[-1], TaskContext):
            context = args[-1]
            positional = args[:-1]
            candidates.append((positional, {"context": context}))
            candidates.append((args, {}))
            candidates.append((positional, {}))
        else:
            candidates.append((args, {}))
        for positional, keywords in candidates:
            try:
                signature.bind(*positional, **keywords)
            except TypeError:
                continue
            return method(*positional, **keywords)
        raise TypeError(f"引擎方法签名与界面约定不兼容：{method.__qualname__}{signature}")

    def _launch_task(self, name: str, work: Callable[[TaskContext], None]) -> None:
        """启动唯一后台任务，并把所有回调转入线程安全队列。"""

        if self._worker is not None and self._worker.is_alive():
            messagebox.showinfo(
                "任务正在运行", "请等待当前任务结束，或先取消当前任务。", parent=self
            )
            return

        # 进度只需要显示最新值；逐条入队会在数万文件时拖慢 Tk 主线程。
        self._latest_progress.clear()
        context = TaskContext(
            progress_callback=self._latest_progress.publish,
            log_callback=lambda level, message: self._events.put(_UiEvent("log", (level, message))),
        )
        self._task_context = context
        self._active_task = name
        self._set_busy(True)
        self._append_log(
            "INFO",
            {"analyze": "开始扫描预览", "execute": "开始整理任务", "fix": "开始日期修复"}[name],
        )

        def runner() -> None:
            try:
                work(context)
            except CancelledError as exc:
                self._events.put(_UiEvent("cancelled", str(exc)))
            except Exception as exc:
                self._events.put(_UiEvent("error", (str(exc), traceback.format_exc())))
            finally:
                self._events.put(_UiEvent("task_finished", name))

        self._worker = threading.Thread(target=runner, name=f"gpth-{name}", daemon=True)
        self._worker.start()

    def _cancel_task(self) -> None:
        if self._task_context is None or self._worker is None or not self._worker.is_alive():
            return
        self._task_context.cancel_event.set()
        self.organize_status.configure(
            text="正在安全取消，等待当前文件处理结束…", text_color=WARNING
        )
        self.fix_status.configure(text="正在安全取消，等待当前文件处理结束…", text_color=WARNING)
        self.cancel_button.configure(state="disabled")
        self.fix_cancel_button.configure(state="disabled")
        self._append_log("WARNING", "用户请求取消当前任务")

    # ------------------------------------------------------------------
    # 事件处理、预览与结果展示
    # ------------------------------------------------------------------

    def _poll_events(self) -> None:
        """仅在 Tk 主线程消费后台消息并更新控件。"""

        try:
            latest_progress = self._latest_progress.take()
            if latest_progress is not None and self._ui_busy:
                self._update_progress(latest_progress)
            for _ in range(250):
                try:
                    event = self._events.get_nowait()
                except queue.Empty:
                    break
                self._handle_event(event)
        finally:
            if self.winfo_exists():
                self.after(70, self._poll_events)

    def _handle_event(self, event: _UiEvent) -> None:
        if event.kind == "log":
            level, message = event.payload
            self._append_log(str(level), str(message))
        elif event.kind == "analysis_result":
            self._latest_progress.clear()
            analysis, actions, options = event.payload
            self._analysis = analysis
            self._plan = list(actions)
            self._preview_options = options
            self._show_analysis(analysis, self._plan)
            self._append_log("INFO", f"预览已生成，共 {len(self._plan)} 个计划动作")
        elif event.kind == "execution_result":
            self._latest_progress.clear()
            self._show_execution_result(event.payload)
        elif event.kind == "fix_result":
            self._latest_progress.clear()
            self._show_fix_result(event.payload)
        elif event.kind == "cancelled":
            self._latest_progress.clear()
            self.organize_status.configure(text="任务已取消", text_color=WARNING)
            self.fix_status.configure(text="任务已取消", text_color=WARNING)
            self._append_log("WARNING", str(event.payload) or "任务已取消")
            messagebox.showinfo(
                "任务已取消", "任务已安全停止。已完成的独立文件会保留。", parent=self
            )
        elif event.kind == "error":
            self._latest_progress.clear()
            message, details = event.payload
            self.organize_status.configure(text="任务失败，请查看日志", text_color=DANGER)
            self.fix_status.configure(text="任务失败，请查看日志", text_color=DANGER)
            self._append_log("ERROR", f"{message}\n{details}")
            messagebox.showerror("任务失败", f"{message}\n\n详细信息已写入日志页。", parent=self)
        elif event.kind == "task_finished":
            self._latest_progress.clear()
            self._set_busy(False)

    def _update_progress(self, update: ProgressUpdate) -> None:
        phase_value = getattr(update.phase, "value", str(update.phase))
        phase = PHASE_LABELS.get(phase_value, phase_value)
        current = max(int(update.current), 0)
        total = max(int(update.total), 0)
        ratio = min(current / total, 1.0) if total else 0.0
        suffix = f" · {current:,} / {total:,} · {ratio:.0%}" if total else ""
        text = f"{phase} · {update.message}{suffix}"
        if self._active_task == "fix":
            self.fix_progress.set(ratio)
            self.fix_status.configure(text=text, text_color=MUTED_TEXT)
        else:
            self.organize_progress.set(ratio)
            self.organize_status.configure(text=text, text_color=MUTED_TEXT)

    def _show_analysis(self, analysis: AnalysisResult, actions: list[PlanAction]) -> None:
        statistics = analysis.statistics
        self._stat_values["discovered"].configure(text=f"{statistics.discovered:,}")
        self._stat_values["unique"].configure(text=f"{len(analysis.media):,}")
        duplicate_groups = list(analysis.duplicate_groups)
        self._stat_values["duplicates"].configure(text=f"{len(duplicate_groups):,} 组")
        self._stat_values["unknown"].configure(text=f"{statistics.unknown_dates:,}")
        planned = statistics.planned_actions or len(actions)
        self._stat_values["actions"].configure(text=f"{planned:,}")
        self.duplicate_button.configure(
            text=f"重复项对比 · {len(duplicate_groups):,} 组",
            state="normal" if duplicate_groups else "disabled",
        )

        self._start_preview_render(actions)
        self.organize_progress.set(1)
        cache_suffix = (
            f" · 缓存复用 {statistics.hash_cache_hits:,}" if statistics.hash_cache_hits else ""
        )
        live_photo_suffix = ""
        status_color = SUCCESS
        if analysis.options.recognize_live_photos:
            live_photo_suffix, status_color = _format_live_photo_status(statistics)
        self.organize_status.configure(
            text=(f"预览完成{cache_suffix}{live_photo_suffix}"),
            text_color=status_color,
        )
        # 扫描结束默认释放 244px 高度，执行计划在常见窗口尺寸下可完整显示。
        self._set_options_expanded(False)

    def _start_preview_render(self, actions: list[PlanAction]) -> None:
        """分批载入全部计划，避免一次插入上万行时冻结 Tk。"""

        self._preview_render_generation += 1
        generation = self._preview_render_generation
        self._preview_render_actions = actions
        batch_size = self._bounded_int(
            self.preview_limit_var.get(),
            PREVIEW_BATCH_DEFAULT,
            PREVIEW_BATCH_MINIMUM,
            PREVIEW_BATCH_MAXIMUM,
        )
        self._preview_batch_cursor = _PreviewBatchCursor(len(actions), batch_size)
        self._clear_tree(cancel_render=False)
        if not actions:
            self.preview_hint.configure(text="共 0 项")
            return
        self.preview_hint.configure(text=f"正在载入 0 / {len(actions):,} 项…")
        self.after(1, lambda: self._render_preview_batch(generation))

    def _render_preview_batch(self, generation: int) -> None:
        """在短小的主线程切片中写入一批行，然后把控制权还给事件循环。"""

        if generation != self._preview_render_generation:
            return
        cursor = self._preview_batch_cursor
        if cursor is None:
            return
        start, end = cursor.take()
        for index in range(start, end):
            self._insert_preview_action(index, self._preview_render_actions[index])

        total = cursor.total
        if cursor.finished:
            self.preview_hint.configure(text=f"共 {total:,} 项，已全部载入")
            self._preview_render_actions = []
            self._preview_batch_cursor = None
            return

        self.preview_hint.configure(text=f"正在载入 {end:,} / {total:,} 项…")
        self.after(1, lambda: self._render_preview_batch(generation))

    def _insert_preview_action(self, index: int, action: PlanAction) -> None:
        """把单个计划动作转换为表格行。"""

        kind = getattr(action.kind, "value", str(action.kind))
        action_label = ACTION_LABELS.get(kind, kind)
        if action.live_photo_role is LivePhotoRole.STILL:
            action_label += " · 实况静态图"
        elif action.live_photo_role is LivePhotoRole.MOTION:
            action_label += " · 动态片段"
        source = str(action.source or "—")
        target = str(action.target or "—")
        date_taken = getattr(action.media, "date_taken", None)
        date_text = date_taken.strftime("%Y-%m-%d %H:%M:%S") if date_taken else "未知"
        album = action.album or "时间线"
        self.preview_tree.insert(
            "",
            "end",
            iid=f"plan-{index}",
            values=(action_label, source, target, date_text, album),
        )

    def _open_duplicate_comparison(self) -> None:
        """打开当前扫描结果的只读重复文件对比窗口。"""

        groups = list(self._analysis.duplicate_groups) if self._analysis is not None else []
        if not groups:
            messagebox.showinfo("没有重复项", "当前扫描结果中没有内容完全相同的文件。", parent=self)
            return
        dialog = self._duplicate_dialog
        if dialog is not None:
            try:
                if dialog.winfo_exists():
                    dialog.deiconify()
                    dialog.lift()
                    dialog.focus_force()
                    return
            except Exception:
                pass
        self._duplicate_dialog = DuplicatePreviewDialog(self, groups)

    def _close_duplicate_dialog(self) -> None:
        """使重复项窗口与当前分析结果保持一致。"""

        dialog = self._duplicate_dialog
        self._duplicate_dialog = None
        if dialog is None:
            return
        try:
            dialog.close()
        except Exception:
            # 主窗口关闭或重新扫描不能被一个已经销毁的子窗口阻塞。
            pass

    def _show_execution_result(self, result: Any) -> None:
        analysis = getattr(result, "analysis", self._analysis)
        statistics = getattr(analysis, "statistics", None)
        errors = list(getattr(result, "errors", []) or [])
        if statistics is not None:
            success = (
                int(getattr(statistics, "copied", 0))
                + int(getattr(statistics, "moved", 0))
                + int(getattr(statistics, "shortcuts", 0))
            )
            failed = int(getattr(statistics, "failed", 0))
            skipped = int(getattr(statistics, "skipped", 0))
            summary = f"完成 {success:,} 项，跳过 {skipped:,} 项，失败 {failed:,} 项"
        else:
            summary = "整理任务已完成"
        if errors:
            summary += f"，另有 {len(errors):,} 条错误"
            self._append_log("ERROR", "\n".join(str(item) for item in errors))
        self.organize_progress.set(1)
        self.organize_status.configure(text=summary, text_color=WARNING if errors else SUCCESS)
        self._append_log("INFO", summary)
        output_dir = getattr(
            getattr(analysis, "options", None), "output_dir", self.output_var.get()
        )
        # 执行后源目录可能已因“移动”发生变化，旧计划不能再次复用。
        self._close_duplicate_dialog()
        self._analysis = None
        self._plan = []
        self._preview_options = None
        self.duplicate_button.configure(text="重复项对比", state="disabled")
        messagebox.showinfo("整理完成", f"{summary}\n\n输出目录：\n{output_dir}", parent=self)

    def _show_fix_result(self, result: Any) -> None:
        total = int(getattr(result, "total", 0))
        updated = int(getattr(result, "updated", 0))
        unchanged = int(getattr(result, "unchanged", 0))
        failed = int(getattr(result, "failed", 0))
        renamed = int(getattr(result, "renamed", 0))
        rename_candidates = int(getattr(result, "rename_candidates", 0))
        errors = list(getattr(result, "errors", []) or [])
        text = (
            f"扫描文件：{total:,}\n"
            f"{'预计可更新' if self.fix_dry_run_var.get() else '已更新时间'}：{updated:,}\n"
            f"{'预计可重命名' if self.fix_dry_run_var.get() else '已重命名'}："
            f"{rename_candidates if self.fix_dry_run_var.get() else renamed:,}\n"
            f"保持不变：{unchanged:,}\n"
            f"失败：{failed:,}"
        )
        if errors:
            text += "\n\n部分错误：\n" + "\n".join(f"• {item}" for item in errors[:20])
            self._append_log("ERROR", "\n".join(str(item) for item in errors))
        self.fix_summary.configure(state="normal")
        self.fix_summary.delete("1.0", "end")
        self.fix_summary.insert("end", text)
        self.fix_summary.configure(state="disabled")
        self.fix_progress.set(1)
        self.fix_status.configure(
            text="日期修复任务已完成", text_color=WARNING if errors else SUCCESS
        )
        self._append_log("INFO", text.replace("\n", "；"))
        messagebox.showinfo("日期修复完成", text.split("\n\n", 1)[0], parent=self)

    def _clear_preview(self) -> None:
        self._close_duplicate_dialog()
        self._analysis = None
        self._plan = []
        self._preview_options = None
        self._clear_tree()
        self.preview_hint.configure(text="正在生成预览…")
        self.duplicate_button.configure(text="重复项对比", state="disabled")
        for label in self._stat_values.values():
            label.configure(text="—")

    def _clear_tree(self, *, cancel_render: bool = True) -> None:
        if cancel_render:
            # 旧 after 回调可能仍在事件队列中；代次变化后它会自行退出。
            self._preview_render_generation += 1
            self._preview_render_actions = []
            self._preview_batch_cursor = None
        children = self.preview_tree.get_children()
        if children:
            self.preview_tree.delete(*children)

    def _set_busy(self, busy: bool) -> None:
        self._ui_busy = busy
        state = "disabled" if busy else "normal"
        self.analyze_button.configure(state=state)
        self.execute_button.configure(state=state)
        self.fix_button.configure(state=state)
        self.clear_cache_button.configure(state=state)
        self._sync_live_photo_controls()
        has_duplicates = bool(self._analysis and self._analysis.duplicate_groups)
        self.duplicate_button.configure(
            state="disabled" if busy or not has_duplicates else "normal"
        )
        self.cancel_button.configure(state="normal" if busy else "disabled")
        self.fix_cancel_button.configure(state="normal" if busy else "disabled")
        if not busy:
            self._latest_progress.clear()
            self._task_context = None
            self._active_task = None

    # ------------------------------------------------------------------
    # 日志、主题与持久化
    # ------------------------------------------------------------------

    def _append_log(self, level: str, message: str) -> None:
        timestamp = datetime.now().strftime("%H:%M:%S")
        normalized = level.upper()
        self._log_records.append((timestamp, normalized, message))
        selected = self.log_filter_var.get()
        if selected not in ("全部", normalized):
            return
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{timestamp}] [{normalized:<7}] {message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _render_logs(self) -> None:
        selected = self.log_filter_var.get()
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        for timestamp, level, message in self._log_records:
            if selected in ("全部", level):
                self.log_text.insert("end", f"[{timestamp}] [{level:<7}] {message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _clear_logs(self) -> None:
        self._log_records.clear()
        self._render_logs()

    def _export_logs(self) -> None:
        if not self._log_records:
            messagebox.showinfo("没有日志", "当前没有可导出的日志。", parent=self)
            return
        path = filedialog.asksaveasfilename(
            title="导出运行日志",
            defaultextension=".log",
            filetypes=[("日志文件", "*.log"), ("文本文件", "*.txt"), ("所有文件", "*.*")],
            initialfile=f"gpth-{datetime.now():%Y%m%d-%H%M%S}.log",
        )
        if not path:
            return
        try:
            content = "\n".join(
                f"[{time}] [{level:<7}] {message}" for time, level, message in self._log_records
            )
            Path(path).write_text(content + "\n", encoding="utf-8")
        except OSError as exc:
            messagebox.showerror("导出失败", str(exc), parent=self)
            return
        messagebox.showinfo("导出完成", f"日志已保存到：\n{path}", parent=self)

    def _clear_hash_cache(self) -> None:
        """清理可重新生成的文件指纹缓存，不接触任何照片。"""

        from .scan_cache import HashCache

        cache = HashCache()
        count = cache.entry_count
        if count <= 0:
            self.cache_status_label.configure(text="缓存当前为空")
            messagebox.showinfo("扫描缓存", "当前没有可清理的文件指纹缓存。", parent=self)
            return
        if not messagebox.askyesno(
            "清理扫描缓存",
            f"将清理 {count:,} 条文件指纹记录。照片和扫描结果不会被删除；下次扫描会重新计算。",
            parent=self,
        ):
            return
        if not cache.clear():
            self.cache_status_label.configure(text="缓存文件当前无法删除")
            messagebox.showerror(
                "清理失败",
                "缓存文件可能正被占用或配置目录不可写。请关闭其它任务后重试。",
                parent=self,
            )
            return
        self.cache_status_label.configure(text=f"已清理 {count:,} 条指纹记录")
        self._append_log("INFO", f"已清理 {count:,} 条扫描指纹缓存")

    def _change_appearance(self, value: str) -> None:
        ctk.set_appearance_mode(value)
        self.after(40, self._configure_tree_style)

    def _change_scaling(self, value: str) -> None:
        try:
            ctk.set_widget_scaling(int(value.rstrip("%")) / 100)
        except ValueError:
            return

    def _configure_tree_style(self) -> None:
        dark = ctk.get_appearance_mode().lower() == "dark"
        background = "#111827" if dark else "#F8FAFC"
        heading = "#273142" if dark else "#EEF1F6"
        foreground = "#E5E7EB" if dark else "#273142"
        selected = "#3942A3" if dark else "#DDE3FF"
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure(
            "GPTH.Treeview",
            background=background,
            fieldbackground=background,
            foreground=foreground,
            borderwidth=0,
            relief="flat",
            rowheight=29,
            font=("Microsoft YaHei UI", 10),
        )
        style.configure(
            "GPTH.Treeview.Heading",
            background=heading,
            foreground=foreground,
            relief="flat",
            borderwidth=0,
            font=("Microsoft YaHei UI", 10, "bold"),
        )
        style.map(
            "GPTH.Treeview",
            background=[("selected", selected)],
            foreground=[("selected", foreground)],
        )
        style.map("GPTH.Treeview.Heading", background=[("active", heading)])

    @staticmethod
    def _load_settings() -> dict[str, Any]:
        return load_settings()

    @staticmethod
    def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
        """设置页允许输入文本，关闭窗口时始终回退到安全数值。"""

        try:
            return min(max(int(value), minimum), maximum)
        except (TypeError, ValueError):
            return default

    def _save_settings(self) -> None:
        """通过统一设置模块原子保存界面状态。"""

        geometry = self.geometry()
        data: dict[str, Any] = {
            "geometry": geometry,
            "appearance": self.appearance_var.get(),
            "scaling": self._bounded_int(self.scaling_var.get().rstrip("%"), 100, 80, 150) / 100,
            "preview_limit": self._bounded_int(
                self.preview_limit_var.get(),
                PREVIEW_BATCH_DEFAULT,
                PREVIEW_BATCH_MINIMUM,
                PREVIEW_BATCH_MAXIMUM,
            ),
            "remember_paths": self.remember_paths_var.get(),
            "operation": OperationMode.COPY.value
            if self.operation_var.get() == "复制（推荐）"
            else OperationMode.MOVE.value,
            "album_mode": ALBUM_LABELS[self.album_var.get()].value,
            "date_division": DIVISION_LABELS[self.division_var.get()].value,
            "conflict_mode": CONFLICT_LABELS[self.conflict_var.get()].value,
            "unknown_date_mode": UNKNOWN_LABELS[self.unknown_var.get()].value,
            "skip_extras": self.skip_extras_var.get(),
            "set_file_mtime": self.set_mtime_var.get(),
            "use_json": self.use_json_var.get(),
            "use_exif": self.use_exif_var.get(),
            "use_filename": self.use_filename_var.get(),
            "aggressive_json": self.aggressive_json_var.get(),
            "use_file_mtime": self.use_file_mtime_var.get(),
            "scan_all_if_no_takeout": self.scan_fallback_var.get(),
            "include_hidden": self.include_hidden_var.get(),
            "write_report": self.write_report_var.get(),
            "use_hash_cache": self.use_hash_cache_var.get(),
            "recognize_live_photos": self.recognize_live_photos_var.get(),
            "live_photo_target": LIVE_PHOTO_TARGET_LABELS[self.live_photo_target_var.get()].value,
            "correct_date_filenames": self.correct_date_filenames_var.get(),
            "workers": self._bounded_int(self.workers_var.get(), 4, 1, 32),
            "all_photos_folder": self.all_photos_var.get(),
            "unknown_date_folder": self.unknown_folder_var.get(),
            "fix_recursive": self.fix_recursive_var.get(),
            "fix_json": self.fix_json_var.get(),
            "fix_exif": self.fix_exif_var.get(),
            "fix_filename": self.fix_filename_var.get(),
            "fix_aggressive": self.fix_aggressive_var.get(),
            "fix_file_mtime": self.fix_file_mtime_var.get(),
            "fix_include_hidden": self.fix_hidden_var.get(),
            "fix_dry_run": self.fix_dry_run_var.get(),
            "fix_correct_date_filenames": self.fix_correct_date_filenames_var.get(),
        }
        if self.remember_paths_var.get():
            data.update(
                {
                    "input_dir": self.input_var.get(),
                    "output_dir": self.output_var.get(),
                    "fix_dir": self.fix_dir_var.get(),
                }
            )
        try:
            save_settings(data)
        except OSError:
            pass

    def _on_close(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            if not messagebox.askyesno(
                "任务仍在运行",
                "关闭窗口会请求取消当前任务。确定退出吗？",
                icon="warning",
                parent=self,
            ):
                return
            if self._task_context is not None:
                self._task_context.cancel_event.set()
        self._close_duplicate_dialog()
        self._save_settings()
        self.destroy()


def main() -> None:
    """启动桌面应用。"""

    app = PhotoTakeoutApp()
    app.mainloop()


def run_app() -> None:
    """为 CLI 启动器保留语义明确的桌面入口。"""

    main()


if __name__ == "__main__":
    main()
