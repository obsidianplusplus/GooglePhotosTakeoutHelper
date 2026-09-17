"""处理引擎使用的数据模型与选项。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from threading import Event, Lock
from typing import Any

from .constants import (
    DEFAULT_ALL_PHOTOS_FOLDER,
    DEFAULT_HASH_CHUNK_SIZE,
    DEFAULT_MAX_EXIF_BYTES,
    DEFAULT_UNKNOWN_DATE_FOLDER,
)


class StrEnum(str, Enum):
    """兼容 JSON 和 argparse 的字符串枚举。"""

    def __str__(self) -> str:
        return self.value


class OperationMode(StrEnum):
    COPY = "copy"
    MOVE = "move"


class AlbumMode(StrEnum):
    SHORTCUT = "shortcut"
    DUPLICATE_COPY = "duplicate-copy"
    JSON = "json"
    NOTHING = "nothing"


class DateDivision(StrEnum):
    FLAT = "flat"
    YEAR = "year"
    YEAR_MONTH = "year-month"


class ConflictMode(StrEnum):
    RENAME = "rename"
    SKIP = "skip"
    OVERWRITE = "overwrite"


class UnknownDateMode(StrEnum):
    FOLDER = "folder"
    ROOT = "root"
    SKIP = "skip"


class LivePhotoTarget(StrEnum):
    """实况照片整理后的官方导入路径。"""

    APPLE = "apple"
    COLOROS16 = "coloros16"


class LivePhotoMetadataStatus(StrEnum):
    """Apple 实况照片配对元数据的只读校验结果。"""

    VERIFIED = "verified"
    MISSING = "missing"
    CONFLICT = "conflict"
    UNKNOWN = "unknown"


class LivePhotoRole(StrEnum):
    """实况照片组合中的物理文件角色。"""

    STILL = "still"
    MOTION = "motion"


class DateSource(StrEnum):
    JSON = "json"
    EXIF = "exif"
    FILENAME = "filename"
    AGGRESSIVE_JSON = "aggressive-json"
    FILE_MTIME = "file-mtime"


class ActionKind(StrEnum):
    COPY = "copy"
    MOVE = "move"
    SHORTCUT = "shortcut"
    SKIP = "skip"


class ActionStatus(StrEnum):
    PLANNED = "planned"
    SUCCESS = "success"
    SKIPPED = "skipped"
    FAILED = "failed"


class Phase(StrEnum):
    SCANNING = "scanning"
    DEDUPLICATING = "deduplicating"
    DATING = "dating"
    MERGING_ALBUMS = "merging-albums"
    PLANNING = "planning"
    EXECUTING = "executing"
    FIXING = "fixing"
    FINISHED = "finished"


@dataclass(slots=True)
class OrganizeOptions:
    """一次整理任务的完整配置。"""

    input_dir: Path
    output_dir: Path
    operation: OperationMode = OperationMode.COPY
    album_mode: AlbumMode = AlbumMode.SHORTCUT
    date_division: DateDivision = DateDivision.YEAR_MONTH
    conflict_mode: ConflictMode = ConflictMode.RENAME
    unknown_date_mode: UnknownDateMode = UnknownDateMode.FOLDER
    skip_extras: bool = False
    use_json: bool = True
    use_exif: bool = True
    use_filename: bool = True
    aggressive_json: bool = True
    use_file_mtime: bool = False
    set_file_mtime: bool = True
    scan_all_if_no_takeout: bool = True
    include_hidden: bool = False
    write_report: bool = True
    use_hash_cache: bool = True
    recognize_live_photos: bool = False
    live_photo_target: LivePhotoTarget = LivePhotoTarget.APPLE
    correct_date_filenames: bool = False
    all_photos_folder: str = DEFAULT_ALL_PHOTOS_FOLDER
    unknown_date_folder: str = DEFAULT_UNKNOWN_DATE_FOLDER
    workers: int = 4
    max_exif_bytes: int = DEFAULT_MAX_EXIF_BYTES
    hash_chunk_size: int = DEFAULT_HASH_CHUNK_SIZE

    def normalized(self) -> OrganizeOptions:
        """返回路径已展开、数值已限幅的配置副本。"""

        values = asdict(self)
        values["input_dir"] = Path(self.input_dir).expanduser().resolve()
        values["output_dir"] = Path(self.output_dir).expanduser().resolve()
        values["operation"] = OperationMode(self.operation)
        values["album_mode"] = AlbumMode(self.album_mode)
        values["date_division"] = DateDivision(self.date_division)
        values["conflict_mode"] = ConflictMode(self.conflict_mode)
        values["unknown_date_mode"] = UnknownDateMode(self.unknown_date_mode)
        values["live_photo_target"] = LivePhotoTarget(self.live_photo_target)
        values["workers"] = min(max(int(self.workers), 1), 32)
        values["hash_chunk_size"] = max(int(self.hash_chunk_size), 64 * 1024)
        values["all_photos_folder"] = _safe_folder_name(
            self.all_photos_folder, DEFAULT_ALL_PHOTOS_FOLDER
        )
        values["unknown_date_folder"] = _safe_folder_name(
            self.unknown_date_folder, DEFAULT_UNKNOWN_DATE_FOLDER
        )
        return OrganizeOptions(**values)

    def validate(self) -> list[str]:
        """返回配置错误；空列表表示可以执行。"""

        errors: list[str] = []
        try:
            options = self.normalized()
        except (OSError, ValueError) as exc:
            return [f"路径或选项无效：{exc}"]
        if not options.input_dir.is_dir():
            errors.append("输入目录不存在或不是文件夹")
        if options.input_dir == options.output_dir:
            errors.append("输入目录与输出目录不能相同")
        if options.output_dir.exists() and not options.output_dir.is_dir():
            errors.append("输出路径已存在，但它不是文件夹")
        if not any(
            (options.use_json, options.use_exif, options.use_filename, options.use_file_mtime)
        ):
            errors.append("至少需要启用一种日期来源")
        return errors


def _safe_folder_name(value: str, fallback: str) -> str:
    """清理用户可编辑的单层目录名，防止意外越出输出目录。"""

    value = str(value).strip().strip(". ")
    if not value:
        return fallback
    forbidden = '<>:"/\\|?*'
    cleaned = "".join("_" if char in forbidden else char for char in value)
    return cleaned[:120] or fallback


@dataclass(slots=True)
class MediaRecord:
    """同一媒体在年份目录和多个相册中的位置集合。"""

    locations: dict[str | None, Path]
    size: int | None = None
    digest: str | None = None
    date_taken: datetime | None = None
    date_source: DateSource | None = None
    date_accuracy: int | None = None
    # 与 locations 使用同一相册键；开启实况识别后，动态片段不再作为
    # 独立媒体，而是和静态图共同参与去重、命名与执行。
    live_photo_companions: dict[str | None, Path] = field(default_factory=dict)
    live_photo_metadata: dict[str | None, LivePhotoMetadataStatus] = field(default_factory=dict)
    live_photo_evidence: dict[str | None, str] = field(default_factory=dict)
    live_photo_repaired_suffix: dict[str | None, bool] = field(default_factory=dict)
    live_photo_output_motion_suffixes: dict[str | None, str] = field(default_factory=dict)
    # 对已通过容器签名确认、但源文件没有扩展名或被误写成 .mp/.mp3 的
    # 独立视频，记录安全的输出后缀。这里只影响目标文件名，不会转码或改写源文件。
    output_suffixes: dict[str | None, str] = field(default_factory=dict)

    @property
    def first_file(self) -> Path:
        return next(iter(self.locations.values()))

    @property
    def albums(self) -> list[str]:
        return sorted(key for key in self.locations if key is not None)

    @property
    def has_timeline_copy(self) -> bool:
        return None in self.locations

    @property
    def is_live_photo(self) -> bool:
        """是否至少有一个来源包含经过确认的动态片段。"""

        return bool(self.live_photo_companions)

    def companion_for(self, album: str | None) -> Path | None:
        """返回指定来源的实况动态片段。"""

        return self.live_photo_companions.get(album)

    def output_motion_suffix_for(self, album: str | None) -> str | None:
        """返回扫描阶段按容器确认的动态片段输出后缀。"""

        return self.live_photo_output_motion_suffixes.get(album)

    def output_suffix_for(self, album: str | None) -> str | None:
        """返回独立媒体经内容确认后的输出后缀。"""

        return self.output_suffixes.get(album)


class DuplicateDisposition(StrEnum):
    """重复成员在本次分析中的处理方式。"""

    PRIMARY = "primary"
    ALBUM_COPY = "album-copy"
    SKIPPED = "skipped"
    FILTERED = "filtered"


@dataclass(frozen=True, slots=True)
class DuplicateMember:
    """重复组中的一个原始物理文件。"""

    path: Path
    album: str | None
    size: int
    digest: str
    modified_ns: int | None = None
    disposition: DuplicateDisposition = DuplicateDisposition.SKIPPED
    reason: str = ""
    companion_path: Path | None = None


@dataclass(frozen=True, slots=True)
class DuplicateGroup:
    """内容完全相同的一组文件，供只读对比预览使用。"""

    digest: str
    size: int
    members: tuple[DuplicateMember, ...]
    primary_path: Path | None = None
    date_taken: datetime | None = None
    date_source: DateSource | None = None
    is_live_photo: bool = False

    @property
    def redundant_count(self) -> int:
        """除主文件之外的物理副本数量。"""

        return max(len(self.members) - 1, 0)

    @property
    def skipped_count(self) -> int:
        """因同来源内容重复而不会进入计划的文件数。"""

        return sum(member.disposition is DuplicateDisposition.SKIPPED for member in self.members)

    @property
    def album_copy_count(self) -> int:
        """为保留相册关系而存在的同内容来源数。"""

        return sum(member.disposition is DuplicateDisposition.ALBUM_COPY for member in self.members)

    @property
    def reclaimable_bytes(self) -> int:
        """原去重逻辑跳过的副本大小；不把相册副本误算为空间收益。"""

        return self.skipped_count * self.size


@dataclass(slots=True)
class ProgressUpdate:
    phase: Phase
    current: int
    total: int
    message: str


@dataclass(slots=True)
class RunStatistics:
    discovered: int = 0
    after_deduplication: int = 0
    duplicates_removed: int = 0
    duplicate_groups: int = 0
    duplicate_files: int = 0
    hash_cache_hits: int = 0
    hash_cache_misses: int = 0
    live_photo_pairs: int = 0
    live_photo_metadata_verified: int = 0
    live_photo_repaired_extensions: int = 0
    live_photo_ambiguous: int = 0
    live_photo_rejected: int = 0
    extras_removed: int = 0
    album_groups_merged: int = 0
    dated: int = 0
    unknown_dates: int = 0
    planned_actions: int = 0
    copied: int = 0
    moved: int = 0
    shortcuts: int = 0
    skipped: int = 0
    failed: int = 0
    bytes_copied: int = 0
    started_at: datetime = field(default_factory=datetime.now)
    finished_at: datetime | None = None


@dataclass(slots=True)
class AnalysisResult:
    options: OrganizeOptions
    media: list[MediaRecord]
    statistics: RunStatistics
    year_folders: list[Path] = field(default_factory=list)
    album_folders: list[Path] = field(default_factory=list)
    used_fallback_scan: bool = False
    duplicate_groups: list[DuplicateGroup] = field(default_factory=list)


@dataclass(slots=True)
class PlanAction:
    kind: ActionKind
    source: Path | None
    target: Path | None
    media: MediaRecord
    album: str | None = None
    reason: str = ""
    fallback_source: Path | None = None
    fallback_target: Path | None = None
    status: ActionStatus = ActionStatus.PLANNED
    actual_kind: ActionKind | None = None
    error: str = ""
    bundle_id: str | None = None
    live_photo_role: LivePhotoRole | None = None
    size_bytes: int | None = None


@dataclass(slots=True)
class ExecutionResult:
    analysis: AnalysisResult
    actions: list[PlanAction]
    errors: list[str] = field(default_factory=list)


@dataclass(slots=True)
class FixDateOptions:
    input_dir: Path
    recursive: bool = True
    use_json: bool = True
    use_exif: bool = True
    use_filename: bool = True
    aggressive_json: bool = True
    use_file_mtime: bool = False
    dry_run: bool = False
    include_hidden: bool = False
    correct_date_filenames: bool = False
    max_exif_bytes: int = DEFAULT_MAX_EXIF_BYTES


@dataclass(slots=True)
class FixDateResult:
    """日期修复任务结果。"""

    total: int = 0
    updated: int = 0
    unchanged: int = 0
    failed: int = 0
    rename_candidates: int = 0
    renamed: int = 0
    errors: list[str] = field(default_factory=list)


ProgressCallback = Callable[[ProgressUpdate], None]
LogCallback = Callable[[str, str], None]


class CancelledError(RuntimeError):
    """用户主动取消任务。"""


@dataclass(slots=True)
class TaskContext:
    """线程安全的取消、进度与日志通道。"""

    cancel_event: Event = field(default_factory=Event)
    progress_callback: ProgressCallback | None = None
    log_callback: LogCallback | None = None
    # JSON 边车索引只在当前任务中存活，避免模块级缓存跨扫描失效。值的具体
    # 结构由 date_extractors 管理；锁保证多提取线程只扫描同一目录一次。
    _sidecar_directory_indexes: dict[str, Any] = field(
        default_factory=dict,
        init=False,
        repr=False,
        compare=False,
    )
    _sidecar_directory_index_lock: Any = field(
        default_factory=Lock,
        init=False,
        repr=False,
        compare=False,
    )
    # 同类 EXIF 环境诊断在一次扫描中只显示一次，避免大量 HEIC 缺解码器时
    # 日志洪泛。集合随 TaskContext 生命周期结束，不会跨扫描隐藏新问题。
    _exif_notices: set[str] = field(
        default_factory=set,
        init=False,
        repr=False,
        compare=False,
    )

    def check_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise CancelledError("任务已由用户取消")

    def progress(self, phase: Phase, current: int, total: int, message: str) -> None:
        if self.progress_callback:
            try:
                self.progress_callback(ProgressUpdate(phase, current, total, message))
            except Exception:
                # 展示层回调不能让已经开始的文件事务半途失败。
                pass

    def log(self, level: str, message: str) -> None:
        if self.log_callback:
            try:
                self.log_callback(level, message)
            except Exception:
                pass


def enum_value(value: Any) -> Any:
    """供报告序列化使用：递归转换枚举和路径。"""

    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): enum_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [enum_value(item) for item in value]
    return value
