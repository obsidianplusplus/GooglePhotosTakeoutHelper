"""执行预览过的文件计划，并生成相册索引与运行报告。"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from .constants import ALBUM_INFO_NAME, DEFAULT_REPORT_NAME
from .file_utils import (
    OutputDirectoryLock,
    atomic_copy,
    available_target,
    conflict_key,
    create_shortcut,
    prepare_file_target,
    safe_move,
    set_file_time,
)
from .models import (
    ActionKind,
    ActionStatus,
    AlbumMode,
    AnalysisResult,
    CancelledError,
    ConflictMode,
    ExecutionResult,
    Phase,
    PlanAction,
    TaskContext,
    enum_value,
)


def execute_plan(
    analysis: AnalysisResult, actions: list[PlanAction], context: TaskContext
) -> ExecutionResult:
    """逐项执行计划；单文件错误会记录并继续，不中止整批任务。"""

    with OutputDirectoryLock(analysis.options.output_dir):
        return _execute_plan_locked(analysis, actions, context)


def _execute_plan_locked(
    analysis: AnalysisResult, actions: list[PlanAction], context: TaskContext
) -> ExecutionResult:
    """在已持有输出目录锁的前提下执行计划。"""

    options = analysis.options
    statistics = analysis.statistics
    # AnalysisResult 可被 API 调用方复用；每次执行前重置执行期统计和动作状态。
    for field_name in ("copied", "moved", "shortcuts", "skipped", "failed", "bytes_copied"):
        setattr(statistics, field_name, 0)
    statistics.finished_at = None
    for action in actions:
        action.status = ActionStatus.PLANNED
        action.actual_kind = None
        action.error = ""
    errors: list[str] = []
    successful_actions: list[PlanAction] = []
    successful_targets: set[Path] = set()
    reserved_targets = {action.target for action in actions if action.target is not None}
    reserved_target_keys = {conflict_key(target) for target in reserved_targets}
    options.output_dir.mkdir(parents=True, exist_ok=True)

    for index, action in enumerate(actions, start=1):
        context.check_cancelled()
        name = action.source.name if action.source else action.reason
        context.progress(Phase.EXECUTING, index - 1, len(actions), f"正在处理：{name}")
        # 进度回调本身可能正是 UI 发出取消的时刻。
        context.check_cancelled()
        if action.kind is ActionKind.SKIP:
            action.status = ActionStatus.SKIPPED
            action.actual_kind = ActionKind.SKIP
            statistics.skipped += 1
            context.progress(Phase.EXECUTING, index, len(actions), f"已处理 {index}/{len(actions)}")
            continue
        if action.source is None or action.target is None:
            message = f"操作缺少源或目标：{action}"
            action.status = ActionStatus.FAILED
            action.error = message
            errors.append(message)
            statistics.failed += 1
            context.log("ERROR", message)
            context.progress(Phase.EXECUTING, index, len(actions), f"已处理 {index}/{len(actions)}")
            continue
        try:
            if action.kind is ActionKind.COPY:
                atomic_copy(
                    action.source,
                    action.target,
                    context,
                    options.hash_chunk_size,
                    allow_overwrite=options.conflict_mode is ConflictMode.OVERWRITE,
                )
                statistics.copied += 1
                statistics.bytes_copied += action.media.size or 0
                action.actual_kind = ActionKind.COPY
            elif action.kind is ActionKind.MOVE:
                copied_across_volumes = safe_move(
                    action.source,
                    action.target,
                    context,
                    options.hash_chunk_size,
                    allow_overwrite=options.conflict_mode is ConflictMode.OVERWRITE,
                )
                statistics.moved += 1
                statistics.bytes_copied += action.media.size or 0 if copied_across_volumes else 0
                action.actual_kind = ActionKind.MOVE
            elif action.kind is ActionKind.SHORTCUT:
                if action.source not in successful_targets:
                    actual_kind, copied_bytes = _shortcut_fallback(
                        action,
                        analysis,
                        context,
                        reserved_targets,
                        reserved_target_keys,
                    )
                    statistics.copied += int(actual_kind is ActionKind.COPY)
                    statistics.moved += int(actual_kind is ActionKind.MOVE)
                    statistics.bytes_copied += action.media.size or 0 if copied_bytes else 0
                    action.actual_kind = actual_kind
                    context.log(
                        "WARNING",
                        f"主文件未能成功输出，已在相册中改用实体文件：{action.target.name}",
                    )
                else:
                    # RENAME/SKIP 计划后若有外部程序占用目标，宁可报冲突也不能
                    # 静默删除；只有用户明确选择 OVERWRITE 才允许替换。
                    if action.target.exists() or action.target.is_symlink():
                        if options.conflict_mode is ConflictMode.OVERWRITE:
                            prepare_file_target(action.target)
                        else:
                            raise FileExistsError(f"执行期间快捷方式目标已被占用：{action.target}")
                    try:
                        create_shortcut(action.target, action.source, context)
                        statistics.shortcuts += 1
                        action.actual_kind = ActionKind.SHORTCUT
                    except CancelledError:
                        raise
                    except Exception as shortcut_error:
                        actual_kind, copied_bytes = _shortcut_fallback(
                            action,
                            analysis,
                            context,
                            reserved_targets,
                            reserved_target_keys,
                        )
                        statistics.copied += int(actual_kind is ActionKind.COPY)
                        statistics.moved += int(actual_kind is ActionKind.MOVE)
                        statistics.bytes_copied += action.media.size or 0 if copied_bytes else 0
                        action.actual_kind = actual_kind
                        context.log(
                            "WARNING",
                            "快捷方式创建失败，已改用实体文件："
                            f"{action.target.name}（{shortcut_error}）",
                        )

            action.status = ActionStatus.SUCCESS
            successful_actions.append(action)
            successful_targets.add(action.target)

            if options.set_file_mtime and action.target.exists():
                _apply_media_time(action, context)
        except CancelledError:
            raise
        except Exception as exc:
            message = f"处理 {action.source} → {action.target} 失败：{exc}"
            action.status = ActionStatus.FAILED
            action.error = str(exc)
            errors.append(message)
            statistics.failed += 1
            context.log("ERROR", message)
        finally:
            context.progress(Phase.EXECUTING, index, len(actions), f"已处理 {index}/{len(actions)}")

    context.check_cancelled()
    if options.album_mode is AlbumMode.JSON:
        _write_album_info(analysis, successful_actions, errors, context)
    context.check_cancelled()
    statistics.finished_at = datetime.now()
    if options.write_report:
        report_error = _write_report(analysis, actions, errors, context)
        if report_error:
            errors.append(report_error)
            statistics.failed += 1
    context.check_cancelled()
    context.progress(Phase.FINISHED, len(actions), len(actions), "整理完成")
    return ExecutionResult(analysis, actions, errors)


def _shortcut_fallback(
    action: PlanAction,
    analysis: AnalysisResult,
    context: TaskContext,
    reserved_targets: set[Path],
    reserved_target_keys: set[str],
) -> tuple[ActionKind, bool]:
    """快捷方式不可用时，使用相册中的原实体文件兜底。"""

    source = action.fallback_source
    shortcut_target = action.target
    desired_target = action.fallback_target or action.target
    if source is None or desired_target is None:
        raise OSError("没有可用于快捷方式兜底的源文件")
    # 清理由快捷方式工具留下的半成品，再切换到预留的实体文件目标。
    if shortcut_target and (shortcut_target.exists() or shortcut_target.is_symlink()):
        prepare_file_target(shortcut_target)
    if shortcut_target is not None:
        reserved_targets.discard(shortcut_target)
        reserved_target_keys.discard(conflict_key(shortcut_target))
    target, _ = available_target(
        desired_target,
        ConflictMode.RENAME,
        reserved_targets,
        reserved_target_keys,
    )
    action.target = target
    if analysis.options.operation.value == "copy":
        atomic_copy(source, target, context, analysis.options.hash_chunk_size)
        return ActionKind.COPY, True
    else:
        copied_across_volumes = safe_move(source, target, context, analysis.options.hash_chunk_size)
        return ActionKind.MOVE, copied_across_volumes


def _apply_media_time(action: PlanAction, context: TaskContext) -> None:
    """已知日期用提取值；未知日期保留源文件原始 mtime。"""

    if action.target is None:
        return
    value = action.media.date_taken
    # 未知日期时复制/移动本身已经保留源 mtime，不把它错误改成运行时刻。
    if value is not None:
        try:
            set_file_time(action.target, value, context)
        except (OSError, NotImplementedError, OverflowError, ValueError) as exc:
            context.log("WARNING", f"无法设置修改时间 {action.target}：{exc}")


def _write_album_info(
    analysis: AnalysisResult,
    actions: list[PlanAction],
    errors: list[str],
    context: TaskContext,
) -> None:
    """生成兼容 basename 键；重名时自动升级为相对路径键，避免记录覆盖。"""

    output_actions: list[tuple[PlanAction, Path]] = []
    for action in actions:
        if action.target is not None and action.kind is not ActionKind.SKIP:
            output_actions.append((action, action.target))
    name_counts: dict[str, int] = {}
    for _action, target in output_actions:
        name_counts[target.name] = name_counts.get(target.name, 0) + 1
    data: dict[str, list[str]] = {}
    for action, target in output_actions:
        key = target.name
        if name_counts[key] > 1:
            key = target.relative_to(analysis.options.output_dir).as_posix()
        data[key] = action.media.albums
    try:
        _atomic_write_json(analysis.options.output_dir / ALBUM_INFO_NAME, data)
    except OSError as exc:
        message = f"写入 {ALBUM_INFO_NAME} 失败：{exc}"
        errors.append(message)
        analysis.statistics.failed += 1
        context.log("ERROR", message)


def _write_report(
    analysis: AnalysisResult,
    actions: list[PlanAction],
    errors: list[str],
    context: TaskContext,
) -> str | None:
    report = {
        "version": 1,
        "options": enum_value(asdict(analysis.options)),
        "statistics": enum_value(asdict(analysis.statistics)),
        "actions": [
            {
                "planned_kind": action.kind.value,
                "actual_kind": action.actual_kind.value if action.actual_kind else None,
                "status": action.status.value,
                "source": str(action.source) if action.source else None,
                "target": str(action.target) if action.target else None,
                "album": action.album,
                "date": action.media.date_taken.isoformat() if action.media.date_taken else None,
                "date_source": action.media.date_source.value if action.media.date_source else None,
                "reason": action.reason,
                "error": action.error or None,
            }
            for action in actions
        ],
        "errors": errors,
    }
    try:
        _atomic_write_json(analysis.options.output_dir / DEFAULT_REPORT_NAME, report)
    except OSError as exc:
        message = f"运行报告写入失败：{exc}"
        context.log("ERROR", message)
        return message
    return None


def _atomic_write_json(path: Path, data: object) -> None:
    """同目录临时写入后替换，避免程序中断留下半份 JSON。"""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink(missing_ok=True)
