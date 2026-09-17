"""无界面环境和自动化脚本使用的命令行入口。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .engine import TakeoutEngine
from .models import (
    AlbumMode,
    CancelledError,
    ConflictMode,
    DateDivision,
    FixDateOptions,
    LivePhotoTarget,
    OperationMode,
    OrganizeOptions,
    Phase,
    TaskContext,
    UnknownDateMode,
)


class ConsoleReporter:
    """紧凑输出阶段进度，避免每个文件刷满终端。"""

    def __init__(self) -> None:
        self._last: tuple[Phase, int] | None = None

    def progress(self, update) -> None:
        percent = int(update.current * 100 / update.total) if update.total else 0
        key = (update.phase, percent // 5)
        if key != self._last:
            self._last = key
            print(f"[{update.phase.value:>18}] {percent:3d}%  {update.message}", file=sys.stderr)

    @staticmethod
    def log(level: str, message: str) -> None:
        print(f"[{level}] {message}", file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gpth",
        description="整理 Google Photos Takeout，并恢复照片/视频的原始修改日期。",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command")

    organize = subparsers.add_parser("organize", help="分析并整理 Google Takeout")
    _add_organize_arguments(organize, safe_defaults=True)

    fix = subparsers.add_parser("fix", help="仅修复任意媒体目录的修改日期")
    _add_fix_arguments(fix)

    subparsers.add_parser("gui", help="启动桌面界面")
    return parser


def _add_organize_arguments(parser: argparse.ArgumentParser, *, safe_defaults: bool) -> None:
    parser.add_argument(
        "-i", "--input", required=True, type=Path, help="已解压并合并的 Takeout 目录"
    )
    parser.add_argument("-o", "--output", required=True, type=Path, help="整理结果目录")
    parser.add_argument(
        "--operation",
        choices=[value.value for value in OperationMode],
        default="copy" if safe_defaults else "move",
        help="复制会保留输入；移动可节省空间",
    )
    parser.add_argument(
        "--albums", choices=[value.value for value in AlbumMode], default="shortcut"
    )
    parser.add_argument(
        "--divide",
        choices=[value.value for value in DateDivision],
        default="year-month" if safe_defaults else "flat",
    )
    parser.add_argument(
        "--conflict", choices=[value.value for value in ConflictMode], default="rename"
    )
    parser.add_argument(
        "--unknown", choices=[value.value for value in UnknownDateMode], default="folder"
    )
    parser.add_argument("--skip-extras", action="store_true", help="忽略 edited 等多语言编辑副本")
    parser.add_argument("--no-json", action="store_true", help="不读取 Takeout JSON sidecar")
    parser.add_argument("--no-exif", action="store_true", help="不读取图片 EXIF")
    parser.add_argument("--no-filename", action="store_true", help="不从文件名猜测日期")
    parser.add_argument(
        "--no-aggressive-json", action="store_true", help="禁用激进 JSON 文件名匹配"
    )
    parser.add_argument(
        "--use-mtime", action="store_true", help="其它来源失败时使用现有文件修改时间"
    )
    parser.add_argument("--no-set-mtime", action="store_true", help="输出后不重设修改时间")
    parser.add_argument(
        "--correct-date-filenames",
        action="store_true",
        help=(
            "按拍摄日期修正完整日期型文件名 YYYY-MM-DD(编号)；保留编号和扩展名"
        ),
    )
    parser.add_argument(
        "--no-fallback-scan", action="store_true", help="没有标准年份目录时不扫描全部媒体"
    )
    parser.add_argument("--include-hidden", action="store_true", help="包括隐藏文件和目录")
    parser.add_argument("--no-report", action="store_true", help="不生成结构化运行报告")
    parser.add_argument(
        "--no-hash-cache", action="store_true", help="不复用未变化文件的 SHA-256 扫描缓存"
    )
    parser.add_argument(
        "--recognize-live-photos",
        action="store_true",
        help=("按内容识别同目录静态图与动态片段（含误命名为 .mp3 的视频）；真 MP3 不纳入整理"),
    )
    parser.add_argument(
        "--live-photo-target",
        choices=[value.value for value in LivePhotoTarget],
        default=None,
        help=(
            "后续导入方式；指定此项会自动启用实况识别。两项均输出 Apple 原始双文件，"
            "coloros16 需经 O+ 互联"
        ),
    )
    parser.add_argument("--all-photos-folder", default="ALL_PHOTOS", help="总照片目录名")
    parser.add_argument("--unknown-folder", default="date-unknown", help="未知日期目录名")
    parser.add_argument("--workers", type=int, default=4, help="预留并发数（1—32）")
    parser.add_argument("--dry-run", action="store_true", help="仅分析并展示计划，不写入输出")
    parser.add_argument("--plan-json", type=Path, help="把预览计划导出为 JSON")


def _add_fix_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("path", type=Path, help="需要修复日期的媒体目录")
    parser.add_argument("--no-recursive", action="store_true", help="只处理目录直属文件")
    parser.add_argument("--no-json", action="store_true")
    parser.add_argument("--no-exif", action="store_true")
    parser.add_argument("--no-filename", action="store_true")
    parser.add_argument("--no-aggressive-json", action="store_true")
    parser.add_argument("--use-mtime", action="store_true")
    parser.add_argument("--include-hidden", action="store_true")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只统计可修复时间和文件名，不写入任何改动",
    )
    parser.add_argument(
        "--correct-date-filenames",
        action="store_true",
        help=(
            "按拍摄日期修正完整日期型文件名 YYYY-MM-DD(编号)；保留编号和扩展名"
        ),
    )


def main(argv: list[str] | None = None) -> int:
    """解析现代及 v3 兼容参数并返回进程退出码。"""

    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        return launch_gui()
    if argv == ["gui"] or "--interactive" in argv:
        return launch_gui()

    if argv[0] not in {"organize", "fix", "gui"} and _looks_like_legacy(argv):
        return _run_legacy(argv)

    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "gui":
        return launch_gui()
    if args.command == "organize":
        return _run_organize(args)
    if args.command == "fix":
        return _run_fix(args)
    parser.print_help()
    return 0


def _run_organize(args: argparse.Namespace) -> int:
    recognize_live_photos, live_photo_target, target_auto_enabled = _resolve_live_photo_cli_options(
        args
    )
    options = OrganizeOptions(
        input_dir=args.input,
        output_dir=args.output,
        operation=OperationMode(args.operation),
        album_mode=AlbumMode(args.albums),
        date_division=DateDivision(args.divide),
        conflict_mode=ConflictMode(args.conflict),
        unknown_date_mode=UnknownDateMode(args.unknown),
        skip_extras=args.skip_extras,
        use_json=not args.no_json,
        use_exif=not args.no_exif,
        use_filename=not args.no_filename,
        aggressive_json=not args.no_aggressive_json,
        use_file_mtime=args.use_mtime,
        set_file_mtime=not args.no_set_mtime,
        correct_date_filenames=bool(getattr(args, "correct_date_filenames", False)),
        scan_all_if_no_takeout=not args.no_fallback_scan,
        include_hidden=args.include_hidden,
        write_report=not args.no_report,
        use_hash_cache=not args.no_hash_cache,
        recognize_live_photos=recognize_live_photos,
        live_photo_target=live_photo_target,
        all_photos_folder=args.all_photos_folder,
        unknown_date_folder=args.unknown_folder,
        workers=args.workers,
    )
    reporter = ConsoleReporter()
    if target_auto_enabled:
        reporter.log(
            "INFO",
            "已因指定后续导入方式自动启用实况照片识别；输出仍为 Apple 原始双文件。",
        )
    context = TaskContext(progress_callback=reporter.progress, log_callback=reporter.log)
    engine = TakeoutEngine()
    try:
        analysis = engine.analyze(options, context)
        actions = engine.build_plan(analysis, context)
        if args.plan_json:
            _write_plan(args.plan_json, actions)
        if args.dry_run:
            _print_preview(analysis, actions)
            return 0
        result = engine.execute(analysis, actions, context)
        _print_result(result)
        return 1 if result.errors else 0
    except CancelledError:
        print("任务已取消", file=sys.stderr)
        return 130
    except FileNotFoundError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 13
    except ValueError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 11
    except Exception as exc:
        print(f"未处理错误：{exc}", file=sys.stderr)
        return 1


def _resolve_live_photo_cli_options(
    args: argparse.Namespace,
) -> tuple[bool, LivePhotoTarget, bool]:
    """解析可独立指定的平台参数，并标记是否需要说明自动启用。"""

    raw_target = getattr(args, "live_photo_target", None)
    explicit_target = raw_target is not None
    target = LivePhotoTarget(raw_target or LivePhotoTarget.APPLE.value)
    explicitly_enabled = bool(getattr(args, "recognize_live_photos", False))
    return explicitly_enabled or explicit_target, target, explicit_target and not explicitly_enabled


def _run_fix(args: argparse.Namespace) -> int:
    options = FixDateOptions(
        input_dir=args.path,
        recursive=not args.no_recursive,
        use_json=not args.no_json,
        use_exif=not args.no_exif,
        use_filename=not args.no_filename,
        aggressive_json=not args.no_aggressive_json,
        use_file_mtime=args.use_mtime,
        dry_run=args.dry_run,
        include_hidden=args.include_hidden,
        correct_date_filenames=bool(getattr(args, "correct_date_filenames", False)),
    )
    reporter = ConsoleReporter()
    context = TaskContext(progress_callback=reporter.progress, log_callback=reporter.log)
    try:
        result = TakeoutEngine().fix_dates(options, context)
        rename_count = (
            int(getattr(result, "rename_candidates", 0))
            if args.dry_run
            else int(getattr(result, "renamed", 0))
        )
        print(
            f"扫描 {result.total} 个媒体；可修复/已修复 {result.updated}；"
            f"{'预计可重命名' if args.dry_run else '已重命名'} {rename_count}；"
            f"无可用日期 {result.unchanged}；失败 {result.failed}"
        )
        return 1 if result.failed else 0
    except ValueError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 11


def _looks_like_legacy(argv: list[str]) -> bool:
    return any(value in argv for value in ("--fix", "--input", "-i", "--output", "-o"))


def _run_legacy(argv: list[str]) -> int:
    """兼容 Dart v3 常用顶层参数；无参数仍直接启动 GUI。"""

    parser = argparse.ArgumentParser(prog="gpth", description="v3 参数兼容模式")
    parser.add_argument("--fix", type=Path)
    parser.add_argument("-i", "--input", type=Path)
    parser.add_argument("-o", "--output", type=Path)
    parser.add_argument(
        "--albums", choices=[value.value for value in AlbumMode], default="shortcut"
    )
    parser.add_argument("--divide-to-dates", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--skip-extras", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--guess-from-name", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--copy", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument(
        "--recognize-live-photos",
        action="store_true",
        help="识别并成组整理 Apple 实况照片",
    )
    parser.add_argument(
        "--live-photo-target",
        choices=[value.value for value in LivePhotoTarget],
        default=None,
        help="后续导入方式；指定后自动启用实况识别",
    )
    parser.add_argument("--interactive", action="store_true")
    args = parser.parse_args(argv)
    if args.interactive:
        return launch_gui()
    if args.fix:
        fix_args = argparse.Namespace(
            path=args.fix,
            no_recursive=False,
            no_json=False,
            no_exif=False,
            no_filename=not args.guess_from_name,
            no_aggressive_json=False,
            use_mtime=False,
            include_hidden=False,
            dry_run=False,
            correct_date_filenames=False,
        )
        return _run_fix(fix_args)
    if not args.input or not args.output:
        parser.error("整理模式必须同时提供 --input 和 --output")
    modern = argparse.Namespace(
        input=args.input,
        output=args.output,
        operation="copy" if args.copy else "move",
        albums=args.albums,
        divide="year-month" if args.divide_to_dates else "flat",
        conflict="rename",
        unknown="folder",
        skip_extras=args.skip_extras,
        no_json=False,
        no_exif=False,
        no_filename=not args.guess_from_name,
        no_aggressive_json=False,
        use_mtime=False,
        no_set_mtime=False,
        correct_date_filenames=False,
        no_fallback_scan=True,
        include_hidden=False,
        no_report=False,
        no_hash_cache=False,
        recognize_live_photos=args.recognize_live_photos,
        live_photo_target=args.live_photo_target,
        all_photos_folder="ALL_PHOTOS",
        unknown_folder="date-unknown",
        workers=4,
        dry_run=False,
        plan_json=None,
    )
    return _run_organize(modern)


def _write_plan(path: Path, actions) -> None:
    rows = [
        {
            "kind": action.kind.value,
            "source": str(action.source) if action.source else None,
            "target": str(action.target) if action.target else None,
            "album": action.album,
            "bundle_id": action.bundle_id,
            "live_photo_role": (action.live_photo_role.value if action.live_photo_role else None),
            "reason": action.reason,
        }
        for action in actions
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def _print_preview(analysis, actions) -> None:
    stats = analysis.statistics
    cache_text = (
        f"，缓存命中 {stats.hash_cache_hits} / 需计算 {stats.hash_cache_misses}"
        if analysis.options.use_hash_cache
        else "，指纹缓存已关闭"
    )
    live_photo_text = _format_live_photo_preview(stats, analysis.options.recognize_live_photos)
    print(
        f"预览完成：发现 {stats.discovered}，重复组 {stats.duplicate_groups}，"
        f"同来源跳过 {stats.duplicates_removed}，"
        f"编辑副本 {stats.extras_removed}，唯一媒体 {len(analysis.media)}，"
        f"日期未知 {stats.unknown_dates}，计划操作 {len(actions)}"
        f"{cache_text}{live_photo_text}"
    )


def _format_live_photo_preview(stats, enabled: bool) -> str:
    """为终端摘要展示完整配对、扩展名恢复和歧义候选数量。"""

    if not enabled:
        return "，实况照片识别已关闭"
    pairs = max(int(stats.live_photo_pairs), 0)
    verified = min(max(int(stats.live_photo_metadata_verified), 0), pairs)
    incomplete = max(pairs - verified, 0)
    repaired = max(int(stats.live_photo_repaired_extensions), 0)
    ambiguous = max(int(stats.live_photo_ambiguous), 0)
    rejected = max(int(getattr(stats, "live_photo_rejected", 0)), 0)
    warning = "，需检查" if incomplete or ambiguous or rejected else ""
    return (
        f"，实况照片 {pairs} 组（Apple 元数据完整 {verified}/{pairs}，"
        f"不完整 {incomplete}，后缀恢复 {repaired}，歧义 {ambiguous}，"
        f"标识冲突拒绝 {rejected}{warning}）"
    )


def _print_result(result) -> None:
    stats = result.analysis.statistics
    print(
        f"完成：复制 {stats.copied}，移动 {stats.moved}，快捷方式 {stats.shortcuts}，"
        f"跳过 {stats.skipped}，失败 {stats.failed}"
    )


def launch_gui() -> int:
    """延迟导入 UI，保证 NAS/服务器执行 CLI 时无需图形环境。"""

    try:
        from .ui import run_app

        run_app()
        return 0
    except ImportError as exc:
        print(
            f"无法启动桌面界面：{exc}\n"
            "请执行 pip install -e . 安装 UI 依赖，或使用 gpth organize。",
            file=sys.stderr,
        )
        return 69


if __name__ == "__main__":
    raise SystemExit(main())
