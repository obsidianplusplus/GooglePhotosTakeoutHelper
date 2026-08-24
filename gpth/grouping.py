"""内容去重、编辑副本过滤和跨相册合并。"""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from pathlib import Path

from .constants import EXTRA_SUFFIXES
from .file_utils import sha256_file
from .models import MediaRecord, Phase, TaskContext


def remove_duplicates(media: list[MediaRecord], context: TaskContext, chunk_size: int) -> int:
    """在每个来源范围内去重，避免提前吞掉其它相册关系。"""

    by_album: dict[str | None, list[MediaRecord]] = defaultdict(list)
    for item in media:
        by_album[next(iter(item.locations))].append(item)

    removed: set[int] = set()
    for album_records in by_album.values():
        for identical in _identical_groups(album_records, context, chunk_size):
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
    for group in _identical_groups(media, context, chunk_size):
        context.check_cancelled()
        if len(group) == 1:
            merged.append(group[0])
            continue
        group.sort(key=_quality_key)
        winner = group[0]
        locations: dict[str | None, Path] = {}
        # 先放时间线位置，确保 JSON 模式选取的首个文件最稳定。
        for item in sorted(
            group, key=lambda value: (None not in value.locations, _quality_key(value))
        ):
            locations.update(item.locations)
        winner.locations = dict(locations)
        merged.append(winner)
        removed_count += len(group) - 1
    media[:] = merged
    return removed_count


def _identical_groups(
    media: list[MediaRecord], context: TaskContext, chunk_size: int
) -> list[list[MediaRecord]]:
    """先按大小缩小候选，仅为同大小组计算完整流式哈希。"""

    by_size: dict[int, list[MediaRecord]] = defaultdict(list)
    for item in media:
        context.check_cancelled()
        if item.size is None:
            item.size = item.first_file.stat().st_size
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
            if item.digest is None:
                try:
                    item.digest = sha256_file(item.first_file, context, chunk_size)
                except OSError as exc:
                    # 无法读取的文件使用唯一错误键，避免错误合并。
                    item.digest = f"unreadable:{id(item)}"
                    context.log("WARNING", f"无法计算哈希 {item.first_file}：{exc}")
            by_digest[item.digest].append(item)
            completed += 1
            context.progress(
                Phase.DEDUPLICATING,
                completed,
                candidates,
                f"计算内容指纹：{item.first_file.name}",
            )
        output.extend(by_digest.values())
    return output


def _quality_key(item: MediaRecord) -> tuple[int, int, str]:
    """准确度优先，其次选择短名称以提高 sidecar 配对成功率。"""

    return (
        item.date_accuracy if item.date_accuracy is not None else 999,
        len(item.first_file.name),
        item.first_file.name.casefold(),
    )
