"""面向 UI 与 CLI 的统一业务编排入口。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .executor import execute_plan
from .grouping import merge_albums, remove_duplicates, remove_extras
from .models import (
    AnalysisResult,
    FixDateOptions,
    FixDateResult,
    OrganizeOptions,
    Phase,
    RunStatistics,
    TaskContext,
)
from .planner import build_plan as create_plan
from .scanner import discover_takeout, scan_media_folder


class TakeoutEngine:
    """无界面依赖的 Takeout 处理引擎。"""

    def analyze(
        self, options: OrganizeOptions, context: TaskContext | None = None
    ) -> AnalysisResult:
        """扫描、去重、取时并合并相册，不改动输入输出文件。"""

        context = context or TaskContext()
        errors = options.validate()
        if errors:
            raise ValueError("；".join(errors))
        normalized = options.normalized()
        statistics = RunStatistics()

        media, year_folders, album_folders, fallback = discover_takeout(normalized, context)
        if not media:
            raise FileNotFoundError("输入目录中没有发现受支持的照片或视频")
        statistics.discovered = len(media)
        context.log("INFO", f"已发现 {len(media)} 个媒体文件")

        statistics.duplicates_removed = remove_duplicates(
            media, context, normalized.hash_chunk_size
        )
        if normalized.skip_extras:
            statistics.extras_removed = remove_extras(media)
        statistics.after_deduplication = len(media)

        # 日期提取器独立成模块，Pillow 也只在实际需要 EXIF 时加载。
        from .date_extractors import extract_date

        # JSON/EXIF 解析主要受磁盘等待影响，使用用户配置的小型线程池可显著
        # 缩短大相册扫描时间；所有结果仍只写回各自的 MediaRecord。
        with ThreadPoolExecutor(
            max_workers=normalized.workers, thread_name_prefix="gpth-date"
        ) as pool:
            futures = {
                pool.submit(extract_date, item.first_file, normalized, context): item
                for item in media
            }
            completed = 0
            try:
                for future in as_completed(futures):
                    context.check_cancelled()
                    item = futures[future]
                    result = future.result()
                    if result is not None:
                        item.date_taken = result.value
                        item.date_source = result.source
                        item.date_accuracy = result.accuracy
                    completed += 1
                    context.progress(
                        Phase.DATING,
                        completed,
                        len(media),
                        f"提取日期：{item.first_file.name}",
                    )
            except Exception:
                for future in futures:
                    future.cancel()
                raise

        context.progress(Phase.MERGING_ALBUMS, 0, len(media), "正在合并相册关系…")
        statistics.album_groups_merged = merge_albums(media, context, normalized.hash_chunk_size)
        statistics.dated = sum(item.date_taken is not None for item in media)
        statistics.unknown_dates = len(media) - statistics.dated
        context.progress(Phase.MERGING_ALBUMS, len(media), len(media), "相册关系已合并")
        return AnalysisResult(
            normalized,
            media,
            statistics,
            year_folders,
            album_folders,
            fallback,
        )

    def build_plan(self, analysis: AnalysisResult, context: TaskContext | None = None):
        """依据分析结果创建可预览计划。"""

        return create_plan(analysis, context or TaskContext())

    def execute(self, analysis, actions, context: TaskContext | None = None):
        """执行既有计划，不重新扫描。"""

        return execute_plan(analysis, actions, context or TaskContext())

    def run(self, options: OrganizeOptions, context: TaskContext | None = None):
        """一次完成分析、计划和执行。"""

        context = context or TaskContext()
        analysis = self.analyze(options, context)
        actions = self.build_plan(analysis, context)
        return self.execute(analysis, actions, context)

    def fix_dates(
        self, options: FixDateOptions, context: TaskContext | None = None
    ) -> FixDateResult:
        """递归修复任意媒体目录的 mtime，不整理或移动文件。"""

        context = context or TaskContext()
        root = Path(options.input_dir).expanduser().resolve()
        if not root.is_dir():
            raise ValueError("日期修复目录不存在或不是文件夹")
        if not any(
            (options.use_json, options.use_exif, options.use_filename, options.use_file_mtime)
        ):
            raise ValueError("日期修复至少需要启用一种日期来源")
        files = scan_media_folder(root, options.recursive, options.include_hidden, context)
        result = FixDateResult(total=len(files))
        from .date_extractors import extract_date
        from .file_utils import set_file_time

        for index, path in enumerate(files, start=1):
            context.check_cancelled()
            extracted = extract_date(
                path,
                None,
                context,
                use_json=options.use_json,
                use_exif=options.use_exif,
                use_filename=options.use_filename,
                aggressive_json=options.aggressive_json,
                use_file_mtime=options.use_file_mtime,
                max_exif_bytes=options.max_exif_bytes,
            )
            try:
                if extracted is None:
                    result.unchanged += 1
                elif options.dry_run:
                    result.updated += 1
                else:
                    set_file_time(path, extracted.value, context)
                    result.updated += 1
            except OSError as exc:
                message = f"无法修复 {path}：{exc}"
                result.errors.append(message)
                result.failed += 1
                context.log("ERROR", message)
            context.progress(Phase.FIXING, index, len(files), f"修复日期：{path.name}")
            context.check_cancelled()
        context.check_cancelled()
        context.progress(Phase.FINISHED, len(files), len(files), "日期修复完成")
        return result
