"""Google Takeout 目录分类与媒体扫描。"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .file_utils import is_hidden, is_media_file, is_relative_to
from .live_photos import discover_live_photo_pairs
from .models import MediaRecord, OrganizeOptions, Phase, TaskContext

YEAR_FOLDER_RE = re.compile(r"^Photos from (?:20|19|18)\d{2}$")


def is_year_folder(path: Path) -> bool:
    """保持原版规则：英文 `Photos from YYYY`，年份为 1800—2099。"""

    return bool(YEAR_FOLDER_RE.fullmatch(path.name))


def discover_takeout(
    options: OrganizeOptions, context: TaskContext
) -> tuple[list[MediaRecord], list[Path], list[Path], bool, int, int]:
    """寻找年份目录与同级相册目录，并生成初始媒体记录。"""

    input_dir = options.input_dir
    output_dir = options.output_dir
    directories: list[Path] = []
    context.progress(Phase.SCANNING, 0, 0, "正在分析目录结构…")

    for root_text, child_names, _ in os.walk(input_dir, topdown=True, followlinks=False):
        context.check_cancelled()
        root = Path(root_text)
        kept_children: list[str] = []
        for name in child_names:
            child = root / name
            if is_relative_to(child, output_dir) and is_relative_to(output_dir, input_dir):
                continue
            if not options.include_hidden and is_hidden(child):
                continue
            kept_children.append(name)
            directories.append(child)
        child_names[:] = kept_children

    year_folders = sorted((path for path in directories if is_year_folder(path)), key=_sort_key)
    parents_with_years = {path.parent.resolve() for path in year_folders}
    album_folders = sorted(
        (
            path
            for path in directories
            if not is_year_folder(path) and path.parent.resolve() in parents_with_years
        ),
        key=_sort_key,
    )

    records: list[MediaRecord] = []
    ambiguous_live_photos = 0
    rejected_live_photos = 0
    source_folders: list[tuple[Path, str | None]] = [
        *((path, None) for path in year_folders),
        *((path, path.name.strip() or "未命名相册") for path in album_folders),
    ]
    for index, (folder, album) in enumerate(source_folders, start=1):
        context.check_cancelled()
        context.progress(Phase.SCANNING, index, len(source_folders), f"扫描：{folder.name}")
        try:
            children = sorted(folder.iterdir(), key=_sort_key)
        except OSError as exc:
            context.log("WARNING", f"无法读取目录 {folder}：{exc}")
            continue
        folder_records, ambiguous, rejected = _records_from_paths(children, album, options, context)
        records.extend(folder_records)
        ambiguous_live_photos += ambiguous
        rejected_live_photos += rejected

    used_fallback = False
    if not records and options.scan_all_if_no_takeout:
        used_fallback = True
        context.log("WARNING", "未识别到标准年份目录，已按设置回退为全目录媒体扫描")
        records, ambiguous_live_photos, rejected_live_photos = _scan_all_media(options, context)
    return (
        records,
        year_folders,
        album_folders,
        used_fallback,
        ambiguous_live_photos,
        rejected_live_photos,
    )


def scan_media_folder(
    root: Path, recursive: bool, include_hidden: bool, context: TaskContext
) -> list[Path]:
    """供日期修复模式使用的通用媒体扫描。"""

    output: list[Path] = []
    iterator = root.rglob("*") if recursive else root.iterdir()
    for path in iterator:
        context.check_cancelled()
        try:
            if not include_hidden:
                relative_parts = path.relative_to(root).parts
                if any(part.startswith(".") for part in relative_parts) or is_hidden(path):
                    continue
            if not path.is_symlink() and path.is_file() and is_media_file(path):
                output.append(path)
        except OSError as exc:
            context.log("WARNING", f"跳过无法访问的路径 {path}：{exc}")
    output.sort(key=_sort_key)
    return output


def _scan_all_media(
    options: OrganizeOptions, context: TaskContext
) -> tuple[list[MediaRecord], int, int]:
    """非标准 Takeout 的安全回退：所有媒体均视为时间线文件。"""

    records: list[MediaRecord] = []
    ambiguous_live_photos = 0
    rejected_live_photos = 0
    for root_text, child_names, file_names in os.walk(
        options.input_dir, topdown=True, followlinks=False
    ):
        context.check_cancelled()
        root = Path(root_text)
        child_names[:] = [
            name
            for name in child_names
            if (options.include_hidden or not is_hidden(root / name))
            and not (
                is_relative_to(root / name, options.output_dir)
                and is_relative_to(options.output_dir, options.input_dir)
            )
        ]
        paths = [root / name for name in file_names]
        folder_records, ambiguous, rejected = _records_from_paths(paths, None, options, context)
        records.extend(folder_records)
        ambiguous_live_photos += ambiguous
        rejected_live_photos += rejected
    return records, ambiguous_live_photos, rejected_live_photos


def _records_from_paths(
    paths: list[Path],
    album: str | None,
    options: OrganizeOptions,
    context: TaskContext,
) -> tuple[list[MediaRecord], int, int]:
    """扫描一个真实目录；实况照片的两半在这里首次形成复合资产。"""

    accessible: list[Path] = []
    for path in paths:
        context.check_cancelled()
        try:
            if path.is_symlink() or not path.is_file():
                continue
            if not options.include_hidden and is_hidden(path):
                continue
            accessible.append(path)
        except OSError as exc:
            context.log("WARNING", f"跳过无法访问的文件 {path}：{exc}")

    live_scan = (
        discover_live_photo_pairs(accessible, context) if options.recognize_live_photos else None
    )
    matches = live_scan.matches if live_scan is not None else {}
    pair_records: dict[Path, MediaRecord] = {}
    consumed_motion_paths: set[Path] = set()
    forced_ordinary_paths: set[Path] = set()
    repaired_motion_suffixes = (
        live_scan.repaired_motion_suffixes if live_scan is not None else {}
    )
    # 即使候选因一对多或 Apple 标识冲突而不能自动配对，已经按内容确认的
    # 无后缀/.mp/.mp3 视频也必须作为独立媒体进入计划，不能被扩展名过滤器漏掉。
    forced_ordinary_paths.update(repaired_motion_suffixes)

    # 先验证复合记录的两半都可读取；只有成功构建后才消费动态片段。
    # 任一 stat 失败时回退为独立媒体，后续循环仍会分别尝试保留两者。
    for still, match in matches.items():
        context.check_cancelled()
        try:
            still_size = still.stat().st_size
            motion_size = match.motion.stat().st_size
        except OSError as exc:
            forced_ordinary_paths.update((still, match.motion))
            context.log(
                "WARNING",
                f"无法建立实况照片复合记录，已退化为独立媒体：{still} + {match.motion}（{exc}）",
            )
            continue
        pair_records[still] = MediaRecord(
            {album: still},
            size=still_size + motion_size,
            live_photo_companions={album: match.motion},
            live_photo_metadata={album: match.metadata_status},
            live_photo_evidence={album: match.evidence},
            live_photo_repaired_suffix={album: match.repaired_suffix},
            live_photo_output_motion_suffixes={album: match.output_motion_suffix},
        )
        consumed_motion_paths.add(match.motion)

    records: list[MediaRecord] = []
    for path in accessible:
        context.check_cancelled()
        if path in consumed_motion_paths:
            continue
        pair_record = pair_records.get(path)
        if pair_record is not None:
            records.append(pair_record)
            continue
        if path not in forced_ordinary_paths and not is_media_file(path):
            continue
        try:
            output_suffix = repaired_motion_suffixes.get(path)
            records.append(
                MediaRecord(
                    {album: path},
                    size=path.stat().st_size,
                    output_suffixes=({album: output_suffix} if output_suffix else {}),
                )
            )
        except OSError as exc:
            context.log("WARNING", f"跳过无法访问的文件 {path}：{exc}")
    ambiguous = live_scan.ambiguous if live_scan is not None else 0
    rejected = live_scan.rejected if live_scan is not None else 0
    return records, ambiguous, rejected


def _sort_key(path: Path) -> str:
    return str(path).casefold()
