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
        "--no-fallback-scan", action="store_true", help="没有标准年份目录时不扫描全部媒体"
    )
    parser.add_argument("--include-hidden", action="store_true", help="包括隐藏文件和目录")
    parser.add_argument("--no-report", action="store_true", help="不生成结构化运行报告")
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
    parser.add_argument("--dry-run", action="store_true", help="只统计可修复文件，不改时间")


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
        scan_all_if_no_takeout=not args.no_fallback_scan,
        include_hidden=args.include_hidden,
        write_report=not args.no_report,
        all_photos_folder=args.all_photos_folder,
        unknown_date_folder=args.unknown_folder,
        workers=args.workers,
    )
    reporter = ConsoleReporter()
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
    )
    reporter = ConsoleReporter()
    context = TaskContext(progress_callback=reporter.progress, log_callback=reporter.log)
    try:
        result = TakeoutEngine().fix_dates(options, context)
        print(
            f"扫描 {result.total} 个媒体；可修复/已修复 {result.updated}；"
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
        no_fallback_scan=True,
        include_hidden=False,
        no_report=False,
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
            "reason": action.reason,
        }
        for action in actions
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def _print_preview(analysis, actions) -> None:
    stats = analysis.statistics
    print(
        f"预览完成：发现 {stats.discovered}，去重 {stats.duplicates_removed}，"
        f"编辑副本 {stats.extras_removed}，唯一媒体 {len(analysis.media)}，"
        f"日期未知 {stats.unknown_dates}，计划操作 {len(actions)}"
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
