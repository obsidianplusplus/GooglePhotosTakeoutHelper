"""Google Takeout 目录分类与媒体扫描。"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .file_utils import is_hidden, is_media_file, is_relative_to
from .models import MediaRecord, OrganizeOptions, Phase, TaskContext

YEAR_FOLDER_RE = re.compile(r"^Photos from (?:20|19|18)\d{2}$")


def is_year_folder(path: Path) -> bool:
    """保持原版规则：英文 `Photos from YYYY`，年份为 1800—2099。"""

    return bool(YEAR_FOLDER_RE.fullmatch(path.name))


def discover_takeout(
    options: OrganizeOptions, context: TaskContext
) -> tuple[list[MediaRecord], list[Path], list[Path], bool]:
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
        for path in children:
            context.check_cancelled()
            try:
                if path.is_symlink() or not path.is_file() or not is_media_file(path):
                    continue
                records.append(MediaRecord({album: path}, size=path.stat().st_size))
            except OSError as exc:
                context.log("WARNING", f"跳过无法访问的文件 {path}：{exc}")

    used_fallback = False
    if not records and options.scan_all_if_no_takeout:
        used_fallback = True
        context.log("WARNING", "未识别到标准年份目录，已按设置回退为全目录媒体扫描")
        records = _scan_all_media(options, context)
    return records, year_folders, album_folders, used_fallback


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


def _scan_all_media(options: OrganizeOptions, context: TaskContext) -> list[MediaRecord]:
    """非标准 Takeout 的安全回退：所有媒体均视为时间线文件。"""

    records: list[MediaRecord] = []
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
        for name in file_names:
            path = root / name
            try:
                if (
                    path.is_symlink()
                    or (not options.include_hidden and is_hidden(path))
                    or not is_media_file(path)
                ):
                    continue
                records.append(MediaRecord({None: path}, size=path.stat().st_size))
            except OSError as exc:
                context.log("WARNING", f"跳过无法访问的文件 {path}：{exc}")
    return records


def _sort_key(path: Path) -> str:
    return str(path).casefold()
