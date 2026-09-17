"""面向 UI 与 CLI 的统一业务编排入口。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .executor import execute_plan
from .file_utils import available_target, rename_file_no_replace, rename_files_no_replace
from .filename_correction import (
    corrected_date_stem,
    corrected_date_target,
    organized_folder_mtime,
)
from .grouping import (
    finalize_duplicate_groups,
    find_duplicate_records,
    merge_albums,
    remove_duplicates,
    remove_extras,
    snapshot_duplicate_groups,
)
from .models import (
    AnalysisResult,
    ConflictMode,
    DateSource,
    FixDateOptions,
    FixDateResult,
    LivePhotoMetadataStatus,
    LivePhotoTarget,
    OrganizeOptions,
    Phase,
    RunStatistics,
    TaskContext,
)
from .planner import build_plan as create_plan
from .scan_cache import HashCache
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

        (
            media,
            year_folders,
            album_folders,
            fallback,
            live_photo_ambiguous,
            live_photo_rejected,
        ) = discover_takeout(normalized, context)
        if not media:
            raise FileNotFoundError("输入目录中没有发现受支持的照片或视频")
        statistics.discovered = len(media)
        statistics.live_photo_pairs = sum(len(item.live_photo_companions) for item in media)
        statistics.live_photo_metadata_verified = sum(
            status is LivePhotoMetadataStatus.VERIFIED
            for item in media
            for status in item.live_photo_metadata.values()
        )
        statistics.live_photo_repaired_extensions = sum(
            repaired for item in media for repaired in item.live_photo_repaired_suffix.values()
        ) + sum(bool(suffix) for item in media for suffix in item.output_suffixes.values())
        statistics.live_photo_ambiguous = live_photo_ambiguous
        statistics.live_photo_rejected = live_photo_rejected
        context.log("INFO", f"已发现 {len(media)} 个媒体文件")
        if normalized.recognize_live_photos:
            context.log(
                "INFO",
                f"已识别 {statistics.live_photo_pairs:,} 组实况照片；"
                f"Apple 配对元数据完整 {statistics.live_photo_metadata_verified:,} 组；"
                f"标识冲突拒绝 {statistics.live_photo_rejected:,} 组",
            )
            if normalized.live_photo_target is LivePhotoTarget.COLOROS16:
                context.log(
                    "INFO",
                    "ColorOS 16 采用 OPPO 官方 O+ 互联路径：程序保留 Apple 原始配对，"
                    "不伪造未公开的 ColorOS 本地封装。",
                )

        hash_cache: HashCache | None = None
        if normalized.use_hash_cache:
            try:
                hash_cache = HashCache()
            except Exception as exc:
                context.log("WARNING", f"扫描指纹缓存不可用，已改为完整计算：{exc}")
        try:
            identical_records = find_duplicate_records(
                media,
                context,
                normalized.hash_chunk_size,
                hash_cache=hash_cache,
            )
        finally:
            if hash_cache is not None:
                statistics.hash_cache_hits = hash_cache.hits
                statistics.hash_cache_misses = hash_cache.misses
                try:
                    hash_cache.save()
                except Exception as exc:
                    context.log("WARNING", f"扫描指纹缓存保存失败：{exc}")
        if hash_cache is not None:
            context.log(
                "INFO",
                f"扫描指纹缓存命中 {hash_cache.hits:,}，需计算 {hash_cache.misses:,}",
            )
        duplicate_snapshots = snapshot_duplicate_groups(identical_records)
        statistics.duplicates_removed = remove_duplicates(
            media,
            context,
            normalized.hash_chunk_size,
            identical_groups=identical_records,
        )
        retained_after_deduplication = {path for item in media for path in item.locations.values()}
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
        duplicate_groups = finalize_duplicate_groups(
            duplicate_snapshots, media, retained_after_deduplication
        )
        statistics.duplicate_groups = len(duplicate_groups)
        statistics.duplicate_files = sum(group.redundant_count for group in duplicate_groups)
        context.progress(Phase.MERGING_ALBUMS, len(media), len(media), "相册关系已合并")
        return AnalysisResult(
            options=normalized,
            media=media,
            statistics=statistics,
            year_folders=year_folders,
            album_folders=album_folders,
            used_fallback_scan=fallback,
            duplicate_groups=duplicate_groups,
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
        """递归修复媒体 mtime，并可安全修正严格日期型文件名。"""

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
        from .date_extractors import (
            FILE_MTIME_ACCURACY,
            DateExtractionResult,
            extract_date,
        )
        from .file_utils import set_file_time

        reserved_targets: set[Path] = set()
        normalized_reserved_targets: set[str] = set()
        extracted_by_path = {}

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
            if options.correct_date_filenames:
                organized_date = organized_folder_mtime(path)
                if organized_date is not None and (
                    extracted is None or extracted.source is DateSource.FILENAME
                ):
                    # 文件名本身就是已知错误来源时，只有 YYYY/MM 目录与 mtime
                    # 互相印证才使用它；普通目录和 date-unknown 绝不会走此分支。
                    extracted = DateExtractionResult(
                        organized_date,
                        DateSource.FILE_MTIME,
                        FILE_MTIME_ACCURACY,
                    )
            extracted_by_path[path] = extracted
            context.progress(Phase.DATING, index, len(files), f"提取日期：{path.name}")

        confirmed_live_matches = []
        if options.correct_date_filenames:
            # 已整理目录中的实况静态图通常有 EXIF，而 MOV 只能从旧文件名得到
            # 错误日期。只对内容确认的一一配对共享更可靠的日期，保证两半同名。
            from collections import defaultdict

            from .live_photos import available_live_photo_targets, discover_live_photo_pairs

            files_by_parent: dict[Path, list[Path]] = defaultdict(list)
            for path in files:
                files_by_parent[path.parent].append(path)
            for parent_files in files_by_parent.values():
                live_scan = discover_live_photo_pairs(parent_files)
                for still, match in live_scan.matches.items():
                    confirmed_live_matches.append(match)
                    candidates = [
                        value
                        for value in (
                            extracted_by_path.get(still),
                            extracted_by_path.get(match.motion),
                        )
                        if value is not None
                    ]
                    if not candidates:
                        continue
                    best = min(candidates, key=lambda value: value.accuracy)
                    extracted_by_path[still] = best
                    extracted_by_path[match.motion] = best

            # 先规划全部目标，再改任何文件。确认的实况照片使用成组冲突策略，
            # 即使只有一半目标被占用，两半也会共同追加同一个编号。
            rename_targets: dict[Path, Path] = {}
            rename_bundles: list[list[tuple[Path, Path]]] = []
            paired_paths: set[Path] = set()
            for match in confirmed_live_matches:
                extracted = extracted_by_path.get(match.still)
                if extracted is None:
                    continue
                output_stem = corrected_date_stem(match.still.stem, extracted.value)
                if output_stem == match.still.stem:
                    continue
                still_target, motion_target, _skipped = available_live_photo_targets(
                    match.still,
                    match.motion,
                    match.still.parent,
                    ConflictMode.RENAME,
                    reserved_targets,
                    normalized_reserved_targets,
                    output_motion_suffix=match.motion.suffix,
                    output_stem=output_stem,
                )
                bundle = [(match.still, still_target), (match.motion, motion_target)]
                rename_bundles.append(bundle)
                rename_targets.update(bundle)
                paired_paths.update((match.still, match.motion))

            for path in files:
                if path in paired_paths:
                    continue
                extracted = extracted_by_path[path]
                if extracted is None:
                    continue
                desired = corrected_date_target(path, extracted.value)
                if desired == path:
                    continue
                target, _skipped = available_target(
                    desired,
                    ConflictMode.RENAME,
                    reserved_targets,
                    normalized_reserved_targets,
                )
                rename_targets[path] = target
        else:
            rename_targets = {}
            rename_bundles = []

        result.rename_candidates = len(rename_targets)
        rename_examples = list(rename_targets.items())[:50]

        for index, path in enumerate(files, start=1):
            context.check_cancelled()
            extracted = extracted_by_path[path]
            try:
                if extracted is None:
                    result.unchanged += 1
                else:
                    if not options.dry_run:
                        set_file_time(path, extracted.value, context)
                    result.updated += 1
            except (OSError, ValueError) as exc:
                message = f"无法修复 {path}：{exc}"
                result.errors.append(message)
                result.failed += 1
                context.log("ERROR", message)
            context.progress(Phase.FIXING, index, len(files), f"修复日期：{path.name}")
            context.check_cancelled()

        if not options.dry_run:
            bundled_paths: set[Path] = set()
            for bundle in rename_bundles:
                context.check_cancelled()
                try:
                    rename_files_no_replace(bundle, context)
                except (OSError, ValueError) as exc:
                    message = f"无法成组修正实况照片文件名：{exc}"
                    result.errors.append(message)
                    result.failed += len(bundle)
                    context.log("ERROR", message)
                else:
                    result.renamed += len(bundle)
                bundled_paths.update(source for source, _target in bundle)
            for source, target in rename_targets.items():
                if source in bundled_paths:
                    continue
                context.check_cancelled()
                try:
                    rename_file_no_replace(source, target, context)
                except (OSError, ValueError) as exc:
                    message = f"无法修正文件名 {source}：{exc}"
                    result.errors.append(message)
                    result.failed += 1
                    context.log("ERROR", message)
                else:
                    result.renamed += 1
        context.check_cancelled()
        if result.rename_candidates:
            mode = "预计可修正" if options.dry_run else "已修正"
            rename_count = result.rename_candidates if options.dry_run else result.renamed
            details = "\n".join(
                f"  - {source.name} → {target.name}" for source, target in rename_examples
            )
            omitted = rename_count - len(rename_examples)
            suffix = f"\n  - 另有 {omitted:,} 个文件" if omitted > 0 else ""
            context.log(
                "INFO",
                f"日期型错误文件名{mode} {rename_count:,} 个"
                + (f"：\n{details}{suffix}" if details else ""),
            )
        context.progress(Phase.FINISHED, len(files), len(files), "日期修复完成")
        return result
