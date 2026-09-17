"""将分析结果转换为无副作用、可预览的文件操作计划。"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

from .file_utils import available_target
from .filename_correction import corrected_date_name, corrected_date_stem
from .live_photos import available_live_photo_targets
from .models import (
    ActionKind,
    AlbumMode,
    AnalysisResult,
    DateDivision,
    LivePhotoRole,
    LivePhotoTarget,
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
    live_photo_bundle_number = 0

    for index, item in enumerate(analysis.media, start=1):
        context.check_cancelled()
        context.progress(Phase.PLANNING, index, total, f"规划输出：{item.first_file.name}")
        if (
            item.date_taken is None
            and options.unknown_date_mode is UnknownDateMode.SKIP
            and not item.is_live_photo
        ):
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
            source_album = next(
                (key for key, value in item.locations.items() if value == source),
                album,
            )
            companion = item.companion_for(source_album)
            if companion is not None:
                live_photo_bundle_number += 1
                bundle_id = f"live-photo-{live_photo_bundle_number:06d}"
                if folder is None:
                    for role, component in (
                        (LivePhotoRole.STILL, source),
                        (LivePhotoRole.MOTION, companion),
                    ):
                        actions.append(
                            PlanAction(
                                ActionKind.SKIP,
                                component,
                                None,
                                item,
                                album,
                                "日期未知，整组实况照片按设置跳过",
                                bundle_id=bundle_id,
                                live_photo_role=role,
                                size_bytes=_safe_size(component),
                            )
                        )
                    continue

                still_target, motion_target, skipped = available_live_photo_targets(
                    source,
                    companion,
                    folder,
                    options.conflict_mode,
                    reserved,
                    normalized_reserved,
                    output_motion_suffix=item.output_motion_suffix_for(source_album),
                    output_stem=(
                        corrected_date_stem(source.stem, item.date_taken)
                        if options.correct_date_filenames
                        else None
                    ),
                )
                reason = (
                    "实况照片任一半发生同名冲突，已整组跳过"
                    if skipped
                    else (
                        "实况照片保留原始配对；可导入 Apple 照片后通过 O+ 互联发送到 OPPO"
                        if options.live_photo_target is LivePhotoTarget.COLOROS16
                        else (
                            "实况照片为保持设备可导入配对，使用同目录同基名实体文件"
                            if album is not None and options.album_mode is AlbumMode.SHORTCUT
                            else "实况照片静态图与动态片段成组输出，供 Apple 照片共同导入"
                        )
                    )
                )
                if (
                    not skipped
                    and options.correct_date_filenames
                    and corrected_date_stem(source.stem, item.date_taken) != source.stem
                ):
                    reason += "；文件名日期已按拍摄日期修正"
                kind = (
                    ActionKind.SKIP
                    if skipped
                    else (
                        ActionKind.COPY
                        if options.operation is OperationMode.COPY
                        else ActionKind.MOVE
                    )
                )
                for role, component, target in (
                    (LivePhotoRole.STILL, source, still_target),
                    (LivePhotoRole.MOTION, companion, motion_target),
                ):
                    actions.append(
                        PlanAction(
                            kind,
                            component,
                            target,
                            item,
                            album,
                            reason,
                            bundle_id=bundle_id,
                            live_photo_role=role,
                            size_bytes=_safe_size(component),
                        )
                    )
                if album is None and not skipped:
                    main_target = still_target
                continue

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
                    fallback_target = folder / _output_name(
                        source,
                        item.output_suffix_for(source_album),
                        item.date_taken,
                        options.correct_date_filenames,
                    )
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

            output_name = _output_name(
                source,
                item.output_suffix_for(source_album),
                item.date_taken,
                options.correct_date_filenames,
            )
            target, skipped = available_target(
                folder / output_name,
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
                action.size_bytes = _safe_size(source)
                if output_name != _output_name(
                    source,
                    item.output_suffix_for(source_album),
                    item.date_taken,
                    False,
                ):
                    action.reason = "文件名日期已按拍摄日期修正"
            actions.append(action)
            if album is None and not skipped:
                # 只有本次计划确实会生成主文件时才创建相册快捷方式。冲突跳过的
                # 既有同名文件可能内容完全不同，绝不能把相册指向它。
                main_target = target

    analysis.statistics.planned_actions = len(actions)
    return actions


def _safe_size(path: Path) -> int | None:
    """在只读规划阶段记录组件大小，执行后源文件移动也不影响统计。"""

    try:
        return path.stat().st_size
    except OSError:
        return None


def _output_name(
    source: Path,
    suffix_override: str | None,
    date_taken: datetime | None,
    correct_date_filenames: bool,
) -> str:
    """补全容器后缀，并按可选规则修正严格日期型文件名。"""

    if not suffix_override:
        name = source.name
    else:
        suffix = suffix_override if suffix_override.startswith(".") else f".{suffix_override}"
        name = (
            source.name
            if source.suffix.casefold() == suffix.casefold()
            else f"{source.stem}{suffix}"
        )
    return corrected_date_name(name, date_taken) if correct_date_filenames else name


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
