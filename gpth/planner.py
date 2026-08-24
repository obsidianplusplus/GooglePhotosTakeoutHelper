"""将分析结果转换为无副作用、可预览的文件操作计划。"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

from .file_utils import available_target
from .models import (
    ActionKind,
    AlbumMode,
    AnalysisResult,
    DateDivision,
    OperationMode,
    Phase,
    PlanAction,
    TaskContext,
    UnknownDateMode,
)


def build_plan(analysis: AnalysisResult, context: TaskContext) -> list[PlanAction]:
    """创建完整计划；此函数不创建目录，也不修改任何文件。"""

    options = analysis.options
    actions: list[PlanAction] = []
    reserved: set[Path] = set()
    normalized_reserved: set[str] = set()
    total = len(analysis.media)

    for index, item in enumerate(analysis.media, start=1):
        context.check_cancelled()
        context.progress(Phase.PLANNING, index, total, f"规划输出：{item.first_file.name}")
        if item.date_taken is None and options.unknown_date_mode is UnknownDateMode.SKIP:
            actions.append(
                PlanAction(
                    ActionKind.SKIP, item.first_file, None, item, reason="日期未知，按设置跳过"
                )
            )
            continue

        entries = _entries_for_item(item.locations, options.album_mode)
        main_target: Path | None = None
        for album, source in entries:
            folder = _output_folder(analysis, album, item.date_taken)
            if folder is None:
                actions.append(
                    PlanAction(ActionKind.SKIP, source, None, item, album, "没有可用输出目录")
                )
                continue

            if options.album_mode is AlbumMode.SHORTCUT and album is not None and main_target:
                name = main_target.name + (".lnk" if sys.platform == "win32" else "")
                target, skipped = available_target(
                    folder / name,
                    options.conflict_mode,
                    reserved,
                    normalized_reserved,
                )
                if skipped:
                    actions.append(
                        PlanAction(
                            ActionKind.SKIP, main_target, target, item, album, "快捷方式同名冲突"
                        )
                    )
                else:
                    # 兜底只有在快捷方式真正失败时才会发生。这里只记录理想位置，
                    # 执行时再结合其余计划动态改名，避免“幽灵预留”误伤正常媒体。
                    fallback_target = folder / source.name
                    actions.append(
                        PlanAction(
                            ActionKind.SHORTCUT,
                            main_target,
                            target,
                            item,
                            album,
                            fallback_source=source,
                            fallback_target=fallback_target,
                        )
                    )
                continue

            target, skipped = available_target(
                folder / source.name,
                options.conflict_mode,
                reserved,
                normalized_reserved,
            )
            if skipped:
                action = PlanAction(
                    ActionKind.SKIP, source, target, item, album, "目标同名，按设置跳过"
                )
            else:
                kind = (
                    ActionKind.COPY if options.operation is OperationMode.COPY else ActionKind.MOVE
                )
                action = PlanAction(kind, source, target, item, album)
            actions.append(action)
            if album is None and not skipped:
                # 只有本次计划确实会生成主文件时才创建相册快捷方式。冲突跳过的
                # 既有同名文件可能内容完全不同，绝不能把相册指向它。
                main_target = target

    analysis.statistics.planned_actions = len(actions)
    return actions


def _entries_for_item(
    locations: dict[str | None, Path], album_mode: AlbumMode
) -> list[tuple[str | None, Path]]:
    """根据四种相册策略选出需要输出的位置及顺序。"""

    if album_mode is AlbumMode.JSON:
        return [(None, next(iter(locations.values())))]
    if album_mode is AlbumMode.NOTHING:
        return [(None, locations[None])] if None in locations else []
    return sorted(locations.items(), key=lambda entry: (entry[0] is not None, entry[0] or ""))


def _output_folder(
    analysis: AnalysisResult, album: str | None, date_taken: datetime | None
) -> Path | None:
    options = analysis.options
    component = options.all_photos_folder if album is None else _safe_album_name(album)
    base = options.output_dir / component
    if date_taken is None:
        if options.unknown_date_mode is UnknownDateMode.SKIP:
            return None
        if options.unknown_date_mode is UnknownDateMode.FOLDER:
            return base / options.unknown_date_folder
        return base
    if options.date_division is DateDivision.YEAR:
        return base / f"{date_taken.year:04d}"
    if options.date_division is DateDivision.YEAR_MONTH:
        return base / f"{date_taken.year:04d}" / f"{date_taken.month:02d}"
    return base


def _safe_album_name(name: str) -> str:
    """相册名来自真实目录，但输出到另一平台前仍需替换保留字符。"""

    forbidden = '<>:"/\\|?*'
    cleaned = "".join("_" if char in forbidden else char for char in name.strip())
    return cleaned.strip(". ")[:120] or "未命名相册"
