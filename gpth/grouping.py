"""内容去重、编辑副本过滤和跨相册合并。"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import TYPE_CHECKING

from .constants import EXTRA_SUFFIXES
from .file_utils import sha256_file
from .live_photos import record_source_paths, record_total_size
from .models import (
    DuplicateDisposition,
    DuplicateGroup,
    DuplicateMember,
    MediaRecord,
    Phase,
    TaskContext,
)

if TYPE_CHECKING:
    from .scan_cache import HashCache


def find_duplicate_records(
    media: list[MediaRecord],
    context: TaskContext,
    chunk_size: int,
    hash_cache: HashCache | None = None,
) -> list[list[MediaRecord]]:
    """一次性找出所有全局内容重复组，后续去重与相册合并复用哈希。"""

    groups = [
        group
        for group in _identical_groups(
            media,
            context,
            chunk_size,
            report_progress=True,
            hash_cache=hash_cache,
        )
        if len(group) > 1 and group[0].digest and not group[0].digest.startswith("unreadable:")
    ]
    for group in groups:
        group.sort(key=lambda item: _member_sort_key(next(iter(item.locations)), item.first_file))
    groups.sort(
        key=lambda group: (
            group[0].digest or "",
            group[0].size or 0,
            str(group[0].first_file).casefold(),
        )
    )
    return groups


def snapshot_duplicate_groups(record_groups: list[list[MediaRecord]]) -> list[DuplicateGroup]:
    """在任何记录被过滤前保存稳定、只读的物理文件清单。"""

    snapshots: list[DuplicateGroup] = []
    for records in record_groups:
        digest = records[0].digest
        size = records[0].size
        if not digest or size is None:
            continue
        members: list[DuplicateMember] = []
        for record in records:
            for album, path in record.locations.items():
                try:
                    stat = path.stat()
                    modified_ns = stat.st_mtime_ns
                    member_size = stat.st_size
                except OSError:
                    modified_ns = None
                    member_size = size
                members.append(
                    DuplicateMember(
                        path=path,
                        album=album,
                        size=member_size,
                        digest=digest,
                        modified_ns=modified_ns,
                        companion_path=record.companion_for(album),
                    )
                )
        members.sort(key=lambda member: _member_sort_key(member.album, member.path))
        snapshots.append(
            DuplicateGroup(
                digest=digest,
                size=size,
                members=tuple(members),
                is_live_photo=records[0].is_live_photo,
            )
        )
    return snapshots


def remove_duplicates(
    media: list[MediaRecord],
    context: TaskContext,
    chunk_size: int,
    identical_groups: list[list[MediaRecord]] | None = None,
) -> int:
    """在每个来源范围内去重，避免提前吞掉其它相册关系。"""

    removed: set[int] = set()
    if identical_groups is None:
        by_album: dict[str | None, list[MediaRecord]] = defaultdict(list)
        for item in media:
            by_album[next(iter(item.locations))].append(item)
        source_groups = [
            group
            for album_records in by_album.values()
            for group in _identical_groups(album_records, context, chunk_size, report_progress=True)
        ]
    else:
        source_groups = []
        # 全局内容组需要再次按逻辑来源拆分；跨相册副本承担相册关系，不能移除。
        for identical in identical_groups:
            by_album = defaultdict(list)
            for item in identical:
                by_album[next(iter(item.locations))].append(item)
            source_groups.extend(by_album.values())

    for identical in source_groups:
        if len(identical) <= 1:
            continue
        identical.sort(key=_quality_key)
        removed.update(id(item) for item in identical[1:])

    if removed:
        media[:] = [item for item in media if id(item) not in removed]
    return len(removed)


def remove_extras(media: list[MediaRecord]) -> int:
    """删除内置多语言后缀标记的编辑版，兼容结尾 `(1)`。"""

    escaped = "|".join(re.escape(value) for value in EXTRA_SUFFIXES)
    pattern = re.compile(rf"(?:{escaped})(?:\(\d+\))?$", re.IGNORECASE)
    before = len(media)
    media[:] = [
        item
        for item in media
        if not pattern.search(unicodedata.normalize("NFC", item.first_file.stem).lower())
    ]
    return before - len(media)


def merge_albums(media: list[MediaRecord], context: TaskContext, chunk_size: int) -> int:
    """按内容合并时间线及所有相册位置，并选择最可靠的日期。"""

    merged: list[MediaRecord] = []
    removed_count = 0
    for group in _identical_groups(media, context, chunk_size, report_progress=False):
        context.check_cancelled()
        if len(group) == 1:
            merged.append(group[0])
            continue
        group.sort(key=_quality_key)
        winner = group[0]
        locations: dict[str | None, Path] = {}
        companions: dict[str | None, Path] = {}
        metadata = {}
        evidence: dict[str | None, str] = {}
        repaired_suffix: dict[str | None, bool] = {}
        output_motion_suffixes: dict[str | None, str] = {}
        output_suffixes: dict[str | None, str] = {}
        # 先放时间线位置，确保 JSON 模式选取的首个文件最稳定。
        for item in sorted(
            group, key=lambda value: (None not in value.locations, _quality_key(value))
        ):
            locations.update(item.locations)
            companions.update(item.live_photo_companions)
            metadata.update(item.live_photo_metadata)
            evidence.update(item.live_photo_evidence)
            repaired_suffix.update(item.live_photo_repaired_suffix)
            output_motion_suffixes.update(item.live_photo_output_motion_suffixes)
            output_suffixes.update(item.output_suffixes)
        winner.locations = dict(locations)
        winner.live_photo_companions = dict(companions)
        winner.live_photo_metadata = dict(metadata)
        winner.live_photo_evidence = dict(evidence)
        winner.live_photo_repaired_suffix = dict(repaired_suffix)
        winner.live_photo_output_motion_suffixes = dict(output_motion_suffixes)
        winner.output_suffixes = dict(output_suffixes)
        merged.append(winner)
        removed_count += len(group) - 1
    media[:] = merged
    return removed_count


def finalize_duplicate_groups(
    snapshots: list[DuplicateGroup],
    media: list[MediaRecord],
    retained_after_deduplication: set[Path],
) -> list[DuplicateGroup]:
    """根据最终媒体记录回填主文件、相册副本和过滤原因。"""

    final_by_digest = {
        item.digest: item
        for item in media
        if item.digest is not None and not item.digest.startswith("unreadable:")
    }
    output: list[DuplicateGroup] = []
    disposition_order = {
        DuplicateDisposition.PRIMARY: 0,
        DuplicateDisposition.ALBUM_COPY: 1,
        DuplicateDisposition.SKIPPED: 2,
        DuplicateDisposition.FILTERED: 3,
    }
    for snapshot in snapshots:
        final_record = final_by_digest.get(snapshot.digest)
        primary_path = final_record.first_file if final_record is not None else None
        final_paths = set(final_record.locations.values()) if final_record is not None else set()
        members: list[DuplicateMember] = []
        for member in snapshot.members:
            if member.path == primary_path:
                disposition = DuplicateDisposition.PRIMARY
                reason = "作为主文件进入整理计划"
            elif member.path in final_paths:
                disposition = DuplicateDisposition.ALBUM_COPY
                reason = "保留相册关系；按相册模式生成快捷方式、索引或实体副本"
            elif member.path not in retained_after_deduplication:
                disposition = DuplicateDisposition.SKIPPED
                reason = "同一来源中已有完全相同文件；不进入输出计划，源文件不会被删除"
            else:
                disposition = DuplicateDisposition.FILTERED
                reason = "已按“跳过编辑副本”规则排除；源文件不会被删除"
            members.append(
                DuplicateMember(
                    path=member.path,
                    album=member.album,
                    size=member.size,
                    digest=member.digest,
                    modified_ns=member.modified_ns,
                    disposition=disposition,
                    reason=reason,
                    companion_path=member.companion_path,
                )
            )
        members.sort(
            key=lambda member: (
                disposition_order[member.disposition],
                *_member_sort_key(member.album, member.path),
            )
        )
        output.append(
            DuplicateGroup(
                digest=snapshot.digest,
                size=snapshot.size,
                members=tuple(members),
                primary_path=primary_path,
                date_taken=final_record.date_taken if final_record is not None else None,
                date_source=final_record.date_source if final_record is not None else None,
                is_live_photo=snapshot.is_live_photo,
            )
        )
    return output


def _identical_groups(
    media: list[MediaRecord],
    context: TaskContext,
    chunk_size: int,
    *,
    report_progress: bool = True,
    hash_cache: HashCache | None = None,
) -> list[list[MediaRecord]]:
    """先按复合资产总大小缩小候选，再计算完整流式哈希。

    实况照片使用静态图与动态片段的双摘要组合键；只有两半都完全一致才会
    被视为重复项，避免“静态图相同、动态片段不同”时误删其中一组。
    """

    by_size: dict[int, list[MediaRecord]] = defaultdict(list)
    for item in media:
        context.check_cancelled()
        if item.size is None or item.is_live_photo:
            item.size = record_total_size(item)
        by_size[item.size].append(item)

    output: list[list[MediaRecord]] = []
    candidates = sum(len(group) for group in by_size.values() if len(group) > 1)
    completed = 0
    for same_size in by_size.values():
        if len(same_size) == 1:
            output.append(same_size)
            continue
        by_digest: dict[str, list[MediaRecord]] = defaultdict(list)
        for item in same_size:
            context.check_cancelled()
            item_size = item.size
            if item_size is None:
                item_size = record_total_size(item)
                item.size = item_size
            used_cache = False
            if item.digest is None:
                try:
                    item.digest, used_cache = _record_digest(
                        item,
                        context,
                        chunk_size,
                        hash_cache,
                    )
                except OSError as exc:
                    # 无法读取的文件使用唯一错误键，避免错误合并。
                    item.digest = f"unreadable:{id(item)}"
                    context.log("WARNING", f"无法计算复合媒体哈希 {item.first_file}：{exc}")
            by_digest[item.digest].append(item)
            completed += 1
            if report_progress:
                context.progress(
                    Phase.DEDUPLICATING,
                    completed,
                    candidates,
                    f"{'复用' if used_cache else '计算'}内容指纹：{item.first_file.name}",
                )
        output.extend(by_digest.values())
    return output


def _record_digest(
    item: MediaRecord,
    context: TaskContext,
    chunk_size: int,
    hash_cache: HashCache | None,
) -> tuple[str, bool]:
    """计算普通媒体或实况照片整组摘要，并复用每个物理文件的缓存。"""

    component_digests: list[str] = []
    all_cached = True
    for path in record_source_paths(item):
        digest, used_cache = _path_digest(path, context, chunk_size, hash_cache)
        component_digests.append(digest)
        all_cached = all_cached and used_cache
    if len(component_digests) == 1:
        return component_digests[0], all_cached

    combined = hashlib.sha256(b"gpth-live-photo-v1\0")
    for digest in component_digests:
        combined.update(bytes.fromhex(digest))
    return combined.hexdigest(), all_cached


def _path_digest(
    path: Path,
    context: TaskContext,
    chunk_size: int,
    hash_cache: HashCache | None,
) -> tuple[str, bool]:
    """安全计算单个物理文件摘要；缓存异常只会退化为重新读取。"""

    before = path.stat()
    size = before.st_size
    if hash_cache is not None:
        try:
            cached = hash_cache.lookup(path, size)
        except Exception as exc:
            context.log("WARNING", f"读取指纹缓存失败，已重新计算 {path.name}：{exc}")
        else:
            if cached is not None:
                return cached, True

    digest = sha256_file(path, context, chunk_size)
    try:
        after = path.stat()
    except OSError:
        context.log("WARNING", f"哈希完成后无法确认文件状态，未写入缓存：{path}")
        return digest, False
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        context.log("WARNING", f"哈希期间文件发生变化，未写入缓存：{path}")
        return digest, False
    if hash_cache is not None:
        try:
            hash_cache.store(
                path,
                size,
                digest,
                expected_mtime_ns=after.st_mtime_ns,
            )
        except Exception as exc:
            context.log("WARNING", f"写入指纹缓存失败：{exc}")
    return digest, False


def _quality_key(item: MediaRecord) -> tuple[int, int, str]:
    """准确度优先，其次选择短名称以提高 sidecar 配对成功率。"""

    return (
        item.date_accuracy if item.date_accuracy is not None else 999,
        len(item.first_file.name),
        item.first_file.name.casefold(),
    )


def _member_sort_key(album: str | None, path: Path) -> tuple[bool, str, str]:
    """时间线优先，再按相册与完整路径稳定排序。"""

    return album is not None, (album or "").casefold(), str(path).casefold()
