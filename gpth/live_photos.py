"""Apple 实况照片的安全识别、元数据校验与成组目标规划。"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO

from .file_utils import conflict_key
from .models import ConflictMode, LivePhotoMetadataStatus, MediaRecord, TaskContext

# Apple Live Photo 的静态半部通常是 HEIC/HEIF 或 JPEG。其它图片即使同名，
# 也不自动和视频配对，避免把普通截图、封面图误判为实况照片。
LIVE_PHOTO_STILL_EXTENSIONS: frozenset[str] = frozenset({".jpg", ".jpeg", ".jpe", ".heic", ".heif"})
KNOWN_MOTION_EXTENSIONS: frozenset[str] = frozenset({".mov", ".mp4", ".m4v"})
SUSPECT_MOTION_EXTENSIONS: frozenset[str] = frozenset({"", ".mp", ".mp3"})

# Apple 的配对标识和视频轨信息位于 ISO-BMFF 的 ``moov/meta`` 等元数据盒，
# 大体积像素/视频数据则位于 ``mdat``。探测时结构化跳过 mdat，只读首尾小窗口
# 和元数据盒，避免上千个片段累计产生十几 GiB 的无效磁盘读取。
# Apple HEIC 的内容标识有时作为 item 数据落在 mdat 开头（真实样本约 96 KiB
# 偏移），因此保留 256 KiB 边缘窗口；仍远小于旧实现的首尾各 8 MiB。
_EDGE_PROBE_BYTES = 256 * 1024
_MAX_METADATA_BOX_BYTES = 8 * 1024 * 1024
_MAX_TOP_LEVEL_BOXES = 4096
_UUID_PATTERN = re.compile(
    rb"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    rb"[0-9a-f]{4}-[0-9a-f]{12}"
)
_CONTENT_IDENTIFIER_KEY = b"com.apple.quicktime.content.identifier"
_STILL_IMAGE_TIME_KEY = b"com.apple.quicktime.still-image-time"


@dataclass(frozen=True, slots=True)
class MotionProbe:
    """动态片段的容器、视频轨和 Apple 元数据探测结果。"""

    major_brand: bytes
    content_identifier: str | None
    has_still_image_time: bool

    @property
    def canonical_suffix(self) -> str:
        """仅用于修复明显错误后缀，不对媒体做任何转码。"""

        return ".mov" if self.major_brand == b"qt  " else ".mp4"


@dataclass(frozen=True, slots=True)
class LivePhotoMatch:
    """同一目录内经内容确认的静态图和动态片段。"""

    still: Path
    motion: Path
    metadata_status: LivePhotoMetadataStatus
    evidence: str
    output_motion_suffix: str
    repaired_suffix: bool


@dataclass(frozen=True, slots=True)
class LivePhotoScanResult:
    """一个来源目录的配对结果与拒绝自动判断的歧义数量。"""

    matches: dict[Path, LivePhotoMatch]
    ambiguous: int = 0
    rejected: int = 0
    # 包含所有已经按文件内容确认、且扩展名需要修复的视频，不局限于成功配对项。
    # 扫描器据此保证歧义组里的无后缀视频也不会被静默漏掉。
    repaired_motion_suffixes: dict[Path, str] = field(default_factory=dict)

    @property
    def motion_paths(self) -> frozenset[Path]:
        return frozenset(match.motion for match in self.matches.values())


def discover_live_photo_pairs(
    paths: list[Path], context: TaskContext | None = None
) -> LivePhotoScanResult:
    """按同目录同基名生成候选，并用容器签名和视频轨确认动态半部。

    同名只是候选条件。动态文件还必须包含 ISO-BMFF ``ftyp`` 盒和
    ``vide`` 处理器；因此真正的 MP3 音频不会被改名或误配。
    """

    stills: dict[str, list[Path]] = {}
    others: dict[str, list[Path]] = {}
    for path in paths:
        suffix = path.suffix.casefold()
        key = _normalised_stem(path)
        if suffix in LIVE_PHOTO_STILL_EXTENSIONS:
            stills.setdefault(key, []).append(path)
        elif suffix in KNOWN_MOTION_EXTENSIONS | SUSPECT_MOTION_EXTENSIONS:
            others.setdefault(key, []).append(path)

    # 对可疑后缀（无后缀、.mp、.mp3）即使没有同名静态图也做一次内容探测，
    # 否则一个真实视频会被普通扩展名过滤器直接漏掉。标准视频只在存在同名
    # 静态候选时探测，避免对无关视频增加扫描成本。
    probes: dict[Path, MotionProbe] = {}
    for stem_key, candidates in others.items():
        for motion in candidates:
            if motion.suffix.casefold() not in SUSPECT_MOTION_EXTENSIONS and stem_key not in stills:
                continue
            probe = probe_motion_file(motion)
            if probe is not None:
                probes[motion] = probe

    repaired_motion_suffixes = {
        motion: probe.canonical_suffix
        for motion, probe in probes.items()
        if _needs_suffix_repair(motion, probe)
    }
    matches: dict[Path, LivePhotoMatch] = {}
    ambiguous = 0
    rejected = 0
    ambiguity_details: list[str] = []
    rejection_details: list[str] = []
    for stem_key, image_candidates in stills.items():
        motion_candidates = [
            (motion, probes[motion])
            for motion in others.get(stem_key, [])
            if motion in probes
        ]

        if not motion_candidates:
            continue
        if len(image_candidates) != 1 or len(motion_candidates) != 1:
            ambiguous += 1
            ambiguity_details.append(
                _ambiguity_description(image_candidates, motion_candidates)
            )
            continue

        still = image_candidates[0]
        motion, probe = motion_candidates[0]
        metadata_status = verify_apple_pair_metadata(still, probe)
        evidence = _evidence_text(metadata_status)
        if metadata_status is LivePhotoMetadataStatus.CONFLICT:
            rejected += 1
            rejection_details.append(f"{still.name} + {motion.name}")
            continue
        repaired = _needs_suffix_repair(motion, probe)
        matches[still] = LivePhotoMatch(
            still=still,
            motion=motion,
            metadata_status=metadata_status,
            evidence=evidence,
            output_motion_suffix=(probe.canonical_suffix if repaired else motion.suffix),
            repaired_suffix=repaired,
        )
    if context is not None:
        _log_discovery_summary(
            context,
            repaired_motion_suffixes,
            probes,
            ambiguity_details,
            rejection_details,
        )
    return LivePhotoScanResult(
        matches=matches,
        ambiguous=ambiguous,
        rejected=rejected,
        repaired_motion_suffixes=repaired_motion_suffixes,
    )


def _needs_suffix_repair(path: Path, probe: MotionProbe) -> bool:
    """判断目标文件名是否需要按已确认容器补后缀。"""

    suffix = path.suffix.casefold()
    return suffix not in KNOWN_MOTION_EXTENSIONS or (
        suffix == ".mp4" and probe.major_brand == b"qt  "
    )


def _ambiguity_description(
    images: list[Path], motions: list[tuple[Path, MotionProbe]]
) -> str:
    """生成足以解释多候选根因的紧凑明细。"""

    stem_path = images[0].parent / images[0].stem
    image_text = "、".join(_file_summary(path) for path in images)
    motion_text = "、".join(
        f"{_file_summary(path)} / 容器 "
        f"{probe.major_brand.decode('ascii', 'replace').strip() or '未知'}"
        f" / Apple ID {'有' if probe.content_identifier else '无'}"
        for path, probe in motions
    )
    return (
        f"{stem_path}：静态候选 {len(images)} 个 [{image_text}]；"
        f"视频候选 {len(motions)} 个 [{motion_text}]"
    )


def _file_summary(path: Path) -> str:
    try:
        size = path.stat().st_size
        return f"{path.name}（{size / (1024 * 1024):.2f} MiB）"
    except OSError:
        return f"{path.name}（大小不可读）"


def _log_discovery_summary(
    context: TaskContext,
    repaired: dict[Path, str],
    probes: dict[Path, MotionProbe],
    ambiguities: list[str],
    rejections: list[str],
) -> None:
    """按目录批量写日志，避免数百次 UI 文本更新放大扫描卡顿。"""

    if repaired:
        details = "\n".join(
            f"  - {path}：原扩展名 {path.suffix or '（无）'}，"
            f"容器 {probes[path].major_brand.decode('ascii', 'replace').strip() or '未知'}，"
            f"输出补为 {suffix}"
            for path, suffix in repaired.items()
        )
        context.log(
            "INFO",
            f"检测到 {len(repaired)} 个内容为真实视频但扩展名缺失或错误的文件。"
            "源文件字节不会改变；仅给输出副本/移动目标补正确后缀：\n"
            f"{details}",
        )
    if ambiguities:
        context.log(
            "WARNING",
            f"检测到 {len(ambiguities)} 组实况照片多候选歧义。该判断发生在内容去重前，"
            "与去重无关；现有 Apple 标识不足以形成唯一配对，因此全部按独立媒体保留：\n"
            + "\n".join(f"  - {detail}" for detail in ambiguities),
        )
    if rejections:
        context.log(
            "WARNING",
            f"检测到 {len(rejections)} 组 Apple 内容标识冲突，已拒绝自动配对并按独立媒体保留：\n"
            + "\n".join(f"  - {detail}" for detail in rejections),
        )


def probe_motion_file(path: Path) -> MotionProbe | None:
    """确认文件是含视频轨的 MOV/MP4，并读取可见的 Apple 配对元数据。"""

    data = _container_metadata_sample(path)
    if data is None:
        return None
    head, sample = data
    major_brand = _find_ftyp_brand(head[: 64 * 1024])
    if major_brand is None or not _contains_video_handler(sample):
        return None

    identifier = _quicktime_content_identifier(sample)
    return MotionProbe(
        major_brand=major_brand,
        content_identifier=identifier,
        has_still_image_time=_STILL_IMAGE_TIME_KEY in sample,
    )


def verify_apple_pair_metadata(still: Path, motion_probe: MotionProbe) -> LivePhotoMetadataStatus:
    """只读核对 Apple 内容标识与关键帧元数据，不修改媒体字节。"""

    motion_identifier = motion_probe.content_identifier
    if motion_identifier is None:
        return LivePhotoMetadataStatus.MISSING
    still_identifiers = _file_uuids(still)
    if not still_identifiers:
        return LivePhotoMetadataStatus.MISSING
    if motion_identifier.casefold() not in still_identifiers:
        return LivePhotoMetadataStatus.CONFLICT
    if not motion_probe.has_still_image_time:
        return LivePhotoMetadataStatus.UNKNOWN
    return LivePhotoMetadataStatus.VERIFIED


def preferred_motion_suffix(path: Path) -> str:
    """返回动态片段目标后缀；只有错误/缺失后缀才按内容修复。"""

    suffix = path.suffix.casefold()
    if suffix in KNOWN_MOTION_EXTENSIONS and suffix != ".mp4":
        return path.suffix
    probe = probe_motion_file(path)
    if probe is None:
        return path.suffix
    if suffix == ".mp4" and probe.major_brand != b"qt  ":
        return path.suffix
    return probe.canonical_suffix


def record_source_paths(item: MediaRecord) -> tuple[Path, ...]:
    """返回用于整组大小和摘要的主来源路径，静态图始终排在前面。"""

    album = next(iter(item.locations))
    companion = item.companion_for(album)
    return (item.first_file, companion) if companion is not None else (item.first_file,)


def record_total_size(item: MediaRecord) -> int:
    """计算复合媒体资产的物理总大小。"""

    return sum(path.stat().st_size for path in record_source_paths(item))


def available_live_photo_targets(
    still: Path,
    motion: Path,
    folder: Path,
    mode: ConflictMode,
    reserved: set[Path],
    normalized_reserved: set[str],
    *,
    output_motion_suffix: str | None = None,
    output_stem: str | None = None,
) -> tuple[Path, Path, bool]:
    """为静态图和动态片段共同选择一个无冲突基名。

    任一半冲突时，两半必须一起重命名或一起跳过，绝不产生
    ``IMG_1.HEIC + IMG_1(1).MOV`` 这样的断裂配对。
    """

    still_suffix = still.suffix
    # 扫描阶段已经完成容器探测时直接复用结果，避免规划阶段再次读取大文件。
    motion_suffix = output_motion_suffix or preferred_motion_suffix(motion)
    base_stem = output_stem or still.stem

    def candidates(number: int | None) -> tuple[Path, Path]:
        stem = base_stem if number is None else f"{base_stem}({number})"
        return folder / f"{stem}{still_suffix}", folder / f"{stem}{motion_suffix}"

    desired = candidates(None)
    occupied, planned = _pair_occupancy(desired, normalized_reserved)
    if not occupied or (mode is ConflictMode.OVERWRITE and not planned):
        _reserve_pair(desired, reserved, normalized_reserved)
        return desired[0], desired[1], False
    if mode is ConflictMode.SKIP:
        return desired[0], desired[1], True

    number = 1
    while True:
        pair = candidates(number)
        pair_occupied, _pair_planned = _pair_occupancy(pair, normalized_reserved)
        if not pair_occupied:
            _reserve_pair(pair, reserved, normalized_reserved)
            return pair[0], pair[1], False
        number += 1


def _pair_occupancy(pair: tuple[Path, Path], normalized_reserved: set[str]) -> tuple[bool, bool]:
    keys = tuple(conflict_key(path) for path in pair)
    planned = any(key in normalized_reserved for key in keys)
    occupied = planned or any(path.exists() or path.is_symlink() for path in pair)
    return occupied, planned


def _reserve_pair(
    pair: tuple[Path, Path], reserved: set[Path], normalized_reserved: set[str]
) -> None:
    for path in pair:
        reserved.add(path)
        normalized_reserved.add(conflict_key(path))


def _normalised_stem(path: Path) -> str:
    return unicodedata.normalize("NFC", path.stem).casefold()


def _find_ftyp_brand(data: bytes) -> bytes | None:
    """在顶层头部寻找有效 ``ftyp`` 盒并返回 major brand。"""

    offset = 0
    limit = len(data)
    while offset + 12 <= limit:
        box_size = int.from_bytes(data[offset : offset + 4], "big")
        box_type = data[offset + 4 : offset + 8]
        if box_type == b"ftyp" and box_size >= 16 and offset + box_size <= limit:
            return data[offset + 8 : offset + 12]
        if box_size == 1 and offset + 16 <= limit:
            box_size = int.from_bytes(data[offset + 8 : offset + 16], "big")
        if box_size < 8:
            # 部分 QuickTime 文件在 ftyp 前有少量非盒前缀；有限搜索仍要求
            # 前四字节构成合理盒长，避免把普通音频中的文本误认成视频。
            break
        offset += box_size

    for index in range(4, min(limit - 8, 4096)):
        if data[index : index + 4] != b"ftyp":
            continue
        start = index - 4
        box_size = int.from_bytes(data[start:index], "big")
        if box_size >= 16 and start + box_size <= limit:
            return data[index + 4 : index + 8]
    return None


def _contains_video_handler(data: bytes) -> bool:
    """查找 ISO-BMFF ``hdlr`` 盒中明确的 ``vide`` handler type。"""

    start = 0
    while True:
        index = data.find(b"hdlr", start)
        if index < 0:
            return False
        if index + 16 <= len(data) and data[index + 12 : index + 16] == b"vide":
            return True
        start = index + 4


def _quicktime_content_identifier(data: bytes) -> str | None:
    key_index = data.find(_CONTENT_IDENTIFIER_KEY)
    if key_index < 0:
        return None
    window = data[key_index : key_index + 16 * 1024]
    match = _UUID_PATTERN.search(window)
    return match.group().decode("ascii") if match else None


def _file_uuids(path: Path) -> set[str]:
    sampled = _container_metadata_sample(path)
    if sampled is None:
        return set()
    _head, data = sampled
    return {match.group().decode("ascii").casefold() for match in _UUID_PATTERN.finditer(data)}


def _container_metadata_sample(path: Path) -> tuple[bytes, bytes] | None:
    """结构化读取容器元数据；普通 JPEG 等格式安全退化为首尾探针。"""

    try:
        size = path.stat().st_size
        if size < 12:
            return None
        with path.open("rb") as stream:
            edge_size = min(size, _EDGE_PROBE_BYTES)
            head = stream.read(edge_size)
            chunks = [head]
            if size > edge_size:
                stream.seek(max(size - _EDGE_PROBE_BYTES, 0))
                chunks.append(stream.read(_EDGE_PROBE_BYTES))

            # 只有顶层 ftyp 盒成立时才按 BMFF 结构跳转；JPEG/其它静态图只用
            # 首尾样本，绝不会把随机四字节解释成超大 seek。
            if _find_ftyp_brand(head) is not None:
                for box_type, offset, box_size in _top_level_boxes(stream, size):
                    if box_type in {b"mdat", b"free", b"skip", b"wide"}:
                        continue
                    chunks.extend(_read_box_sample(stream, offset, box_size))
    except OSError:
        return None
    return head, b"".join(chunks)


def _top_level_boxes(
    stream: BinaryIO, file_size: int
) -> Iterator[tuple[bytes, int, int]]:
    """只遍历 ISO-BMFF 顶层盒头；通过 seek 跳过媒体载荷。"""

    offset = 0
    for _number in range(_MAX_TOP_LEVEL_BOXES):
        if offset + 8 > file_size:
            return
        stream.seek(offset)
        header = stream.read(16)
        if len(header) < 8:
            return
        box_size = int.from_bytes(header[:4], "big")
        box_type = header[4:8]
        header_size = 8
        if box_size == 1:
            if len(header) < 16:
                return
            box_size = int.from_bytes(header[8:16], "big")
            header_size = 16
        elif box_size == 0:
            box_size = file_size - offset
        if box_size < header_size or offset + box_size > file_size:
            return
        yield box_type, offset, box_size
        offset += box_size


def _read_box_sample(stream: BinaryIO, offset: int, box_size: int) -> list[bytes]:
    """小元数据盒完整读取，异常大的盒只取两端以限制内存与 I/O。"""

    if box_size <= _MAX_METADATA_BOX_BYTES:
        stream.seek(offset)
        return [stream.read(box_size)]
    stream.seek(offset)
    first = stream.read(_MAX_METADATA_BOX_BYTES // 2)
    stream.seek(offset + box_size - _MAX_METADATA_BOX_BYTES // 2)
    last = stream.read(_MAX_METADATA_BOX_BYTES // 2)
    return [first, last]


def _evidence_text(status: LivePhotoMetadataStatus) -> str:
    if status is LivePhotoMetadataStatus.VERIFIED:
        return "同目录同名，Apple 内容标识与关键帧元数据已验证"
    if status is LivePhotoMetadataStatus.CONFLICT:
        return "同目录同名且含视频轨，但 Apple 内容标识冲突"
    if status is LivePhotoMetadataStatus.UNKNOWN:
        return "Apple 内容标识匹配，但未确认动态片段关键帧元数据"
    return "同目录同名且含视频轨；Apple 配对元数据缺失或不可读"


__all__ = [
    "LivePhotoMatch",
    "LivePhotoScanResult",
    "available_live_photo_targets",
    "discover_live_photo_pairs",
    "preferred_motion_suffix",
    "probe_motion_file",
    "record_source_paths",
    "record_total_size",
    "verify_apple_pair_metadata",
]
