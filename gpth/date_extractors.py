"""从 Google Takeout 元数据、EXIF、文件名或文件时间提取拍摄日期。

本模块保留 Dart 版本的日期来源优先级和 JSON 文件名修正规则，同时做了几项
适合桌面应用的增强：所有错误都限制在当前文件、文件名统一按 NFC 比较、支持
新版 ``.supplemental-metadata.json`` 边车文件，并且仅在真正读取 EXIF 时导入
Pillow。模块返回的日期均是不带 ``tzinfo`` 的本地时间，以便与原版 Dart 的
``DateTime`` 行为以及本地文件修改时间保持一致。
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import unicodedata
import warnings
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any

from . import image_support
from .constants import DEFAULT_MAX_EXIF_BYTES, EXTRA_SUFFIXES, IMAGE_EXTENSIONS
from .models import CancelledError, DateSource, OrganizeOptions, TaskContext

# 与 Dart 入口中的提取器顺序严格对应；数值越小，来源越可信。
JSON_ACCURACY = 0
EXIF_ACCURACY = 1
FILENAME_ACCURACY = 2
AGGRESSIVE_JSON_ACCURACY = 3
FILE_MTIME_ACCURACY = 4

DATE_ACCURACY: Mapping[DateSource, int] = {
    DateSource.JSON: JSON_ACCURACY,
    DateSource.EXIF: EXIF_ACCURACY,
    DateSource.FILENAME: FILENAME_ACCURACY,
    DateSource.AGGRESSIVE_JSON: AGGRESSIVE_JSON_ACCURACY,
    DateSource.FILE_MTIME: FILE_MTIME_ACCURACY,
}

PathLike = str | os.PathLike[str]


@dataclass(frozen=True, slots=True)
class DateExtractionResult:
    """一次成功的日期提取结果。

    ``metadata_path`` 仅在日期来自 JSON 时填写，方便报告和问题诊断。对象可以
    直接解包为 ``(datetime, DateSource, accuracy)``，从而同时兼容偏好元组的
    调用方和偏好具名字段的调用方。
    """

    value: datetime
    source: DateSource
    accuracy: int
    metadata_path: Path | None = None

    @property
    def date(self) -> datetime:
        """``value`` 的语义化别名。"""

        return self.value

    @property
    def date_taken(self) -> datetime:
        """便于直接写入 :class:`~gpth.models.MediaRecord` 的别名。"""

        return self.value

    def as_tuple(self) -> tuple[datetime, DateSource, int]:
        """返回不含诊断字段的三元组。"""

        return self.value, self.source, self.accuracy

    def __iter__(self) -> Iterator[datetime | DateSource | int]:
        return iter(self.as_tuple())

    def __len__(self) -> int:
        return 3

    def __getitem__(self, index: int) -> datetime | DateSource | int:
        return self.as_tuple()[index]


@dataclass(frozen=True, slots=True)
class _SidecarCandidate:
    """JSON 边车文件候选；``aggressive`` 标记其是否来自激进规则。"""

    name: str
    aggressive: bool


# 原版六种文件名格式。正则故意不加单词边界，以保留“从长文件名中寻找日期
# 子串”的行为；真正的日历范围交给 datetime 校验。
_MONTH = r"(?:01|02|03|04|05|06|07|08|09|10|11|12)"
_YEAR = r"(?:20|19|18)[0-9]{2}"
_FILENAME_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(rf"({_YEAR}{_MONTH}[0-3][0-9]-[0-9]{{6}})"), "%Y%m%d-%H%M%S"),
    (re.compile(rf"({_YEAR}{_MONTH}[0-3][0-9]_[0-9]{{6}})"), "%Y%m%d_%H%M%S"),
    (
        re.compile(rf"({_YEAR}-{_MONTH}-[0-3][0-9]-[0-9]{{2}}-[0-9]{{2}}-[0-9]{{2}})"),
        "%Y-%m-%d-%H-%M-%S",
    ),
    (
        re.compile(rf"({_YEAR}-{_MONTH}-[0-3][0-9]-[0-9]{{6}})"),
        "%Y-%m-%d-%H%M%S",
    ),
    (re.compile(rf"({_YEAR}{_MONTH}[0-3][0-9][0-9]{{6}})"), "%Y%m%d%H%M%S"),
    (
        re.compile(rf"({_YEAR}_{_MONTH}_[0-3][0-9]_[0-9]{{2}}_[0-9]{{2}}_[0-9]{{2}})"),
        "%Y_%m_%d_%H_%M_%S",
    ),
)

# EXIF 标签编号：优先级与原 Dart 版一致，先 Image DateTime，再 Original，
# 最后 Digitized。Pillow 版本之间标签名称 API 有差异，使用稳定的数字编号。
_EXIF_DATE_TAGS = (306, 36867, 36868)
_EXIF_IFD_POINTER = 34665
_EXIF_DATE_PATTERN = re.compile(
    r"^\s*(?P<year>[0-9]{4})\s*[:/\\.\-]\s*"
    r"(?P<month>[0-9]{1,2})\s*[:/\\.\-]\s*"
    r"(?P<day>[0-9]{1,2})"
    r"(?:[ T]\s*(?P<hour>[0-9]{1,2})"
    r"(?:\s*:\s*(?P<minute>[0-9]{1,2})"
    r"(?:\s*:\s*(?P<second>[0-9]{1,2}))?)?)?"
)

_SIDECAR_SUFFIXES = (".json", ".supplemental-metadata.json")

# Pillow 只在第一次需要 EXIF 时加载。锁保证多工作线程不会同时初始化。
_PIL_LOCK = Lock()
_PIL_ATTEMPTED = False
_PIL_MODULES: tuple[Any, Any] | None = None
_PIL_IMPORT_ERROR: BaseException | None = None
_PIL_ERROR_REPORTED = False

# 同一次扫描遇到成千上万个 HEIC 时，相同的环境错误只提示一次；集合放在
# TaskContext 实例上，下一轮扫描使用新上下文后仍会重新给出诊断。
_EXIF_NOTICE_LOCK = Lock()


def _nfc(value: str) -> str:
    """统一 Unicode 组合形式，解决 macOS 常见的 NFD 文件名问题。"""

    return unicodedata.normalize("NFC", value)


def _check_cancelled(context: TaskContext | None) -> None:
    """取消异常必须越过逐文件隔离并由任务调度层处理。"""

    if context is not None:
        context.check_cancelled()


def _log(context: TaskContext | None, level: str, message: str) -> None:
    """日志回调本身异常时不影响媒体处理。"""

    if context is None:
        return
    try:
        context.log(level, message)
    except Exception:
        pass


def _option_value(options: object | None, name: str, default: Any) -> Any:
    """同时支持 dataclass 配置、普通对象和字典式配置。"""

    if options is None:
        return default
    if isinstance(options, Mapping):
        return options.get(name, default)
    return getattr(options, name, default)


def _resolved_bool(explicit: bool | None, options: object | None, name: str, default: bool) -> bool:
    value = _option_value(options, name, default) if explicit is None else explicit
    return bool(value)


def _shorten_name(filename: str) -> str:
    """复刻 Google 旧式 JSON 文件名总长最多 51 个字符的截断规则。"""

    return filename[: 51 - len(".json")] if len(filename + ".json") > 51 else filename


def _bracket_swap(filename: str) -> str:
    """把 ``image(11).jpg`` 转成 Google 使用的 ``image.jpg(11)``。"""

    matches = list(re.finditer(r"\([0-9]+\)(?=\.)", filename))
    if not matches:
        return filename
    match = matches[-1]
    bracket = match.group(0)
    return filename[: match.start()] + filename[match.end() :] + bracket


def _remove_known_extra(filename: str) -> str:
    """删除原版白名单中的编辑后缀，匹配时忽略大小写并使用 NFC。"""

    normalized = _nfc(filename)
    lowered = normalized.lower()
    for suffix in EXTRA_SUFFIXES:
        suffix = _nfc(suffix)
        index = lowered.rfind(suffix.lower())
        if index >= 0:
            return normalized[:index] + normalized[index + len(suffix) :]
    return normalized


def _without_extension(filename: str) -> str:
    """仅移除最后一个扩展名；隐藏文件名保持不变。"""

    dot = filename.rfind(".")
    return filename[:dot] if dot > 0 else filename


def _remove_unknown_extra(filename: str) -> str:
    """激进规则：删除扩展名前未知的 ``-文字`` 后缀。"""

    # [^\W\d_] 在 Unicode 模式下表示字母，兼容原版拉丁字符范围并扩展至
    # 日文等脚本；数字括号由单个数字增强为任意位数。
    matches = list(
        re.finditer(
            r"(?P<extra>-[^\W\d_]+(?:\([0-9]+\))?)(?=\.[^\s.]+$)",
            _nfc(filename),
        )
    )
    if len(matches) != 1:
        return filename
    match = matches[0]
    return filename[: match.start("extra")] + filename[match.end("extra") :]


def _remove_copy_number(filename: str) -> str:
    """激进规则：删除扩展名前的 ``(数字)``；支持多位数字。"""

    return re.sub(r"\([0-9]+\)(?=\.)", "", filename)


def _sidecar_candidates(
    media_path: Path,
    *,
    include_safe: bool,
    include_aggressive: bool,
) -> tuple[_SidecarCandidate, ...]:
    """按 Dart 原版顺序生成边车文件名，并为每项加入新版后缀。

    安全顺序为：原名、51 字符截断、括号换位、删除已知编辑后缀、删除媒体
    扩展名。激进顺序为：删除未知编辑后缀、删除副本编号。所有变换互相独立，
    不组合使用，这一点也与原版一致。
    """

    filename = _nfc(media_path.name)
    candidates: list[_SidecarCandidate] = []
    seen: set[tuple[str, bool]] = set()

    safe_names = (
        filename,
        _shorten_name(filename),
        _bracket_swap(filename),
        _remove_known_extra(filename),
        _without_extension(filename),
    )
    aggressive_names = (
        _remove_unknown_extra(filename),
        _remove_copy_number(filename),
    )

    def append_names(names: tuple[str, ...], aggressive: bool) -> None:
        for base in names:
            for suffix in _SIDECAR_SUFFIXES:
                item = (_nfc(base + suffix), aggressive)
                if item in seen:
                    continue
                seen.add(item)
                candidates.append(_SidecarCandidate(*item))

    if include_safe:
        append_names(safe_names, False)
    if include_aggressive:
        append_names(aggressive_names, True)
    return tuple(candidates)


def json_sidecar_candidates(media_path: PathLike, *, aggressive: bool = False) -> tuple[Path, ...]:
    """公开候选列表，便于 UI 预览、测试和问题诊断。"""

    path = Path(media_path)
    return tuple(
        path.parent / candidate.name
        for candidate in _sidecar_candidates(path, include_safe=True, include_aggressive=aggressive)
    )


_SidecarDirectoryIndex = tuple[
    dict[str, Path],
    dict[str, Path],
    dict[str, Path],
]


def _build_sidecar_directory_index(
    parent: Path,
    context: TaskContext | None,
) -> _SidecarDirectoryIndex:
    """一次扫描目录，建立原名、NFC 名称与忽略大小写三层索引。"""

    raw: dict[str, Path] = {}
    normalized: dict[str, Path] = {}
    folded: dict[str, Path] = {}
    try:
        for number, entry in enumerate(parent.iterdir()):
            if number % 256 == 0:
                _check_cancelled(context)
            if not entry.name.casefold().endswith(".json"):
                continue
            try:
                if not entry.is_file():
                    continue
            except OSError:
                continue
            normalized_name = _nfc(entry.name)
            raw.setdefault(entry.name, entry)
            normalized.setdefault(normalized_name, entry)
            folded.setdefault(normalized_name.casefold(), entry)
    except CancelledError:
        raise
    except OSError:
        # 失败也缓存为空索引；同一次扫描中反复访问不可读目录没有意义。
        pass
    return raw, normalized, folded


def _sidecar_directory_index(
    parent: Path,
    context: TaskContext | None,
) -> _SidecarDirectoryIndex:
    """返回任务级目录索引；同一 TaskContext 中每个目录最多枚举一次。"""

    if context is None:
        return _build_sidecar_directory_index(parent, None)

    # normcase 兼容 Windows 大小写不敏感路径；绝对路径避免同一目录因相对写法
    # 不同而建立多份索引。缓存跟随 TaskContext 生命周期，不会跨扫描陈旧。
    cache_key = os.path.normcase(os.path.abspath(os.fspath(parent)))
    with context._sidecar_directory_index_lock:
        cached = context._sidecar_directory_indexes.get(cache_key)
        if cached is not None:
            return cached
        index = _build_sidecar_directory_index(parent, context)
        context._sidecar_directory_indexes[cache_key] = index
        return index


def _existing_sidecars(
    parent: Path,
    candidates: tuple[_SidecarCandidate, ...],
    context: TaskContext | None,
) -> list[tuple[Path, bool]]:
    """从任务级目录索引中按候选优先级查找实际存在的边车文件。"""

    raw, normalized, folded = _sidecar_directory_index(parent, context)
    found: list[tuple[Path, bool]] = []
    found_paths: set[Path] = set()
    for candidate in candidates:
        matched = (
            raw.get(candidate.name)
            or normalized.get(candidate.name)
            or folded.get(candidate.name.casefold())
        )
        if matched is not None and matched not in found_paths:
            found.append((matched, candidate.aggressive))
            found_paths.add(matched)
    return found


def _timestamp_to_local_datetime(value: Any) -> datetime | None:
    """解析 Google 时间戳，并统一成不带时区的本地时间。"""

    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not text:
        return None

    try:
        number = float(text)
    except (TypeError, ValueError, OverflowError):
        number = math.nan
    if math.isfinite(number):
        # Google 当前使用秒；兼容某些第三方修复工具写入的毫秒时间戳。
        if abs(number) >= 100_000_000_000:
            number /= 1000.0
        try:
            return datetime.fromtimestamp(number)
        except (OSError, OverflowError, ValueError):
            return None

    # 非标准边车有时直接写 ISO 8601；标准 Takeout 不受此增强影响。
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def _read_json_datetime(sidecar: Path) -> datetime | None:
    """读取 ``photoTakenTime.timestamp``；格式不符时返回 ``None``。"""

    with sidecar.open("r", encoding="utf-8-sig") as stream:
        data = json.load(stream)
    if not isinstance(data, Mapping):
        return None
    photo_time = data.get("photoTakenTime")
    if not isinstance(photo_time, Mapping):
        return None
    return _timestamp_to_local_datetime(photo_time.get("timestamp"))


def _extract_json(
    media_path: Path,
    *,
    include_safe: bool,
    include_aggressive: bool,
    context: TaskContext | None,
) -> DateExtractionResult | None:
    """JSON 提取内部实现，可让总调度器把激进规则放到文件名规则之后。"""

    try:
        _check_cancelled(context)
        candidates = _sidecar_candidates(
            media_path,
            include_safe=include_safe,
            include_aggressive=include_aggressive,
        )
        for sidecar, aggressive in _existing_sidecars(
            media_path.parent,
            candidates,
            context,
        ):
            _check_cancelled(context)
            try:
                value = _read_json_datetime(sidecar)
            except CancelledError:
                raise
            except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
                _log(context, "warning", f"无法读取元数据 {sidecar}：{exc}")
                continue
            except Exception as exc:
                _log(context, "warning", f"解析元数据 {sidecar} 时发生异常：{exc}")
                continue
            if value is None:
                _log(context, "warning", f"元数据缺少有效拍摄时间：{sidecar}")
                continue
            source = DateSource.AGGRESSIVE_JSON if aggressive else DateSource.JSON
            return DateExtractionResult(value, source, DATE_ACCURACY[source], sidecar)
        return None
    except CancelledError:
        raise
    except Exception as exc:
        _log(context, "warning", f"为 {media_path} 查找 JSON 日期失败：{exc}")
        return None


def json_extractor(
    media_path: PathLike,
    *,
    aggressive: bool = False,
    tryhard: bool | None = None,
    context: TaskContext | None = None,
) -> DateExtractionResult | None:
    """从相邻 JSON 边车文件提取拍摄时间。

    ``tryhard`` 是对 Dart 原接口的兼容别名。激进模式仍先尝试全部安全候选；
    返回来源和准确度会根据真正命中的候选自动确定。
    """

    if tryhard is not None:
        aggressive = bool(tryhard)
    return _extract_json(
        Path(media_path),
        include_safe=True,
        include_aggressive=aggressive,
        context=context,
    )


def _is_image_path(path: Path) -> bool:
    """以扩展名为主、mimetypes 为辅判断是否值得尝试 Pillow。"""

    if path.suffix.casefold() in IMAGE_EXTENSIONS:
        return True
    mime, _ = mimetypes.guess_type(str(path))
    return bool(mime and mime.startswith("image/"))


def _load_pillow(context: TaskContext | None) -> tuple[Any, Any] | None:
    """延迟加载 Pillow；缺少依赖时让 JSON/文件名等来源继续工作。"""

    global _PIL_ATTEMPTED, _PIL_MODULES, _PIL_IMPORT_ERROR, _PIL_ERROR_REPORTED
    with _PIL_LOCK:
        if not _PIL_ATTEMPTED:
            _PIL_ATTEMPTED = True
            try:
                from PIL import ExifTags, Image

                # 注册函数自身有全局锁；日期提取和重复预览即使并发初始化，
                # 也只会真正调用 pillow-heif 一次。
                image_support.ensure_pillow_heif()
                _PIL_MODULES = (Image, ExifTags)
            # 某些损坏的二进制 Pillow 安装会抛出 RuntimeError 等异常；仍然只
            # 禁用 EXIF，不应连带禁用 JSON、文件名和 mtime 提取。
            except Exception as exc:
                _PIL_IMPORT_ERROR = exc
        modules = _PIL_MODULES
        if modules is None and context is not None and not _PIL_ERROR_REPORTED:
            _PIL_ERROR_REPORTED = True
            _log(context, "warning", f"Pillow 不可用，已跳过 EXIF：{_PIL_IMPORT_ERROR}")
        return modules


def _log_exif_notice_once(
    context: TaskContext | None,
    key: str,
    message: str,
) -> None:
    """同一任务的同类环境问题只记录一次，避免日志洪泛拖慢界面。"""

    if context is None:
        return
    with _EXIF_NOTICE_LOCK:
        if key in context._exif_notices:
            return
        context._exif_notices.add(key)
    _log(context, "warning", message)


def _coerce_exif_text(value: Any) -> str | None:
    """把 Pillow 可能返回的 bytes/字符串值整理为可解析文本。"""

    if value is None:
        return None
    if isinstance(value, bytes):
        for encoding in ("utf-8", "ascii", "latin-1"):
            try:
                value = value.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            return None
    text = str(value).strip().strip("\x00").strip()
    return text or None


def _parse_exif_datetime(value: Any) -> datetime | None:
    """解析常见 EXIF 日期，并兼容原版接受的多种日期分隔符。"""

    text = _coerce_exif_text(value)
    if text is None:
        return None
    match = _EXIF_DATE_PATTERN.match(text)
    if match is None:
        return None
    groups = match.groupdict()
    try:
        return datetime(
            int(groups["year"]),
            int(groups["month"]),
            int(groups["day"]),
            int(groups["hour"] or 0),
            int(groups["minute"] or 0),
            int(groups["second"] or 0),
        )
    except (TypeError, ValueError, OverflowError):
        return None


def _exif_mappings(image: Any) -> tuple[Mapping[int, Any], ...]:
    """兼容 Pillow 新旧版本，收集主 IFD 与 Exif 子 IFD。"""

    mappings: list[Mapping[int, Any]] = []
    try:
        root = image.getexif()
    except (AttributeError, OSError, ValueError):
        root = None
    if root:
        mappings.append(root)
        try:
            child = root.get_ifd(_EXIF_IFD_POINTER)
            if child:
                mappings.append(child)
        except (AttributeError, KeyError, OSError, TypeError, ValueError):
            pass

    # Pillow 旧版本的 _getexif() 可能比 getexif() 暴露更多标签。
    try:
        legacy = image._getexif()  # noqa: SLF001 - 第三方兼容分支
        if legacy:
            mappings.append(legacy)
    except (AttributeError, OSError, TypeError, ValueError):
        pass
    return tuple(mappings)


def exif_extractor(
    media_path: PathLike,
    *,
    max_exif_bytes: int | None = DEFAULT_MAX_EXIF_BYTES,
    context: TaskContext | None = None,
) -> DateExtractionResult | None:
    """用 Pillow 提取图片 EXIF 日期；任何坏文件只影响当前媒体。"""

    path = Path(media_path)
    try:
        _check_cancelled(context)
        if not _is_image_path(path):
            return None
        if max_exif_bytes is not None:
            limit = max(0, int(max_exif_bytes))
            if path.stat().st_size > limit:
                _log(context, "info", f"图片超过 EXIF 读取上限，已跳过：{path}")
                return None
        modules = _load_pillow(context)
        if modules is None:
            return None
        Image, _ExifTags = modules
        unavailable_reason = image_support.decoder_unavailable_reason(path, Image)
        if unavailable_reason is not None:
            _log_exif_notice_once(
                context,
                f"decoder-unavailable:{path.suffix.casefold()}",
                f"读取 {path} 的 EXIF 已跳过：{unavailable_reason}"
                "（本次扫描中同类原因仅提示一次）",
            )
            return None
        _check_cancelled(context)
        try:
            # EXIF 只读取容器元数据，不展开整张像素图。局部隐藏 Pillow 的
            # DecompressionBombWarning 可避免超高分辨率全景图污染控制台；
            # MAX_IMAGE_PIXELS 未被修改，超过硬上限的 DecompressionBombError
            # 仍会被拒绝，因此没有关闭 Pillow 的安全保护。
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    mappings = _exif_mappings(image)
                    for tag in _EXIF_DATE_TAGS:
                        for mapping in mappings:
                            value = _parse_exif_datetime(mapping.get(tag))
                            if value is not None:
                                return DateExtractionResult(
                                    value,
                                    DateSource.EXIF,
                                    EXIF_ACCURACY,
                                )
        except Image.DecompressionBombError as exc:
            _log(
                context,
                "warning",
                f"读取 {path} 的 EXIF 已拒绝：图片像素数超过 Pillow 安全硬上限（{exc}）",
            )
            return None
        except Image.UnidentifiedImageError as exc:
            reason = image_support.heif_decode_failure_reason(path, exc)
            if reason is None:
                reason = f"Pillow 无法识别图片内容：{exc}"
            _log(context, "warning", f"读取 {path} 的 EXIF 失败，已跳过：{reason}")
            return None
        return None
    except CancelledError:
        raise
    except Exception as exc:
        _log(context, "warning", f"读取 {path} 的 EXIF 失败，已跳过：{exc}")
        return None


def filename_extractor(
    media_path: PathLike,
    *,
    context: TaskContext | None = None,
) -> DateExtractionResult | None:
    """从六种常见相机/截图文件名格式猜测本地拍摄时间。"""

    path = Path(media_path)
    try:
        _check_cancelled(context)
        filename = _nfc(path.name)
        for pattern, date_format in _FILENAME_PATTERNS:
            match = pattern.search(filename)
            if match is None:
                continue
            try:
                value = datetime.strptime(match.group(1), date_format)
            except (OverflowError, ValueError):
                continue
            return DateExtractionResult(value, DateSource.FILENAME, FILENAME_ACCURACY)
        return None
    except CancelledError:
        raise
    except Exception as exc:
        _log(context, "warning", f"从文件名推断 {path} 的日期失败：{exc}")
        return None


# 保留 Dart 函数名，便于迁移测试和第三方调用代码。
guess_extractor = filename_extractor


def mtime_extractor(
    media_path: PathLike,
    *,
    context: TaskContext | None = None,
) -> DateExtractionResult | None:
    """使用文件系统修改时间作为最低可信度的兜底日期。"""

    path = Path(media_path)
    try:
        _check_cancelled(context)
        value = datetime.fromtimestamp(path.stat().st_mtime)
        return DateExtractionResult(value, DateSource.FILE_MTIME, FILE_MTIME_ACCURACY)
    except CancelledError:
        raise
    except Exception as exc:
        _log(context, "warning", f"读取 {path} 的修改时间失败：{exc}")
        return None


def extract_date(
    media_path: PathLike,
    options: OrganizeOptions | object | None = None,
    context: TaskContext | None = None,
    *,
    use_json: bool | None = None,
    use_exif: bool | None = None,
    use_filename: bool | None = None,
    aggressive_json: bool | None = None,
    use_file_mtime: bool | None = None,
    max_exif_bytes: int | None = None,
) -> DateExtractionResult | None:
    """按可信度顺序为一个媒体文件提取日期。

    可以传入 :class:`~gpth.models.OrganizeOptions`、``FixDateOptions``、具有同名
    属性的普通对象或字典；关键字布尔参数会覆盖配置对象。为保持原版语义，激进
    JSON 仅在普通 JSON 启用时生效，并且排在文件名猜测之后。
    """

    # 允许简洁写法 extract_date(path, context)，同时不牺牲标准配置接口。
    if isinstance(options, TaskContext) and context is None:
        context = options
        options = None

    path = Path(media_path)
    json_enabled = _resolved_bool(use_json, options, "use_json", True)
    exif_enabled = _resolved_bool(use_exif, options, "use_exif", True)
    filename_enabled = _resolved_bool(use_filename, options, "use_filename", True)
    aggressive_enabled = _resolved_bool(aggressive_json, options, "aggressive_json", True)
    mtime_enabled = _resolved_bool(use_file_mtime, options, "use_file_mtime", False)
    if max_exif_bytes is None:
        configured_limit = _option_value(options, "max_exif_bytes", DEFAULT_MAX_EXIF_BYTES)
        try:
            max_exif_bytes = int(configured_limit)
        except (TypeError, ValueError, OverflowError):
            max_exif_bytes = DEFAULT_MAX_EXIF_BYTES
            _log(context, "warning", "EXIF 大小上限无效，已恢复默认值")

    try:
        _check_cancelled(context)
        if json_enabled:
            result = _extract_json(
                path,
                include_safe=True,
                include_aggressive=False,
                context=context,
            )
            if result is not None:
                return result

        if exif_enabled:
            result = exif_extractor(path, max_exif_bytes=max_exif_bytes, context=context)
            if result is not None:
                return result

        if filename_enabled:
            result = filename_extractor(path, context=context)
            if result is not None:
                return result

        if json_enabled and aggressive_enabled:
            result = _extract_json(
                path,
                include_safe=False,
                include_aggressive=True,
                context=context,
            )
            if result is not None:
                return result

        if mtime_enabled:
            return mtime_extractor(path, context=context)
        return None
    except CancelledError:
        raise
    except Exception as exc:
        # 各提取器已有自己的隔离；这里再做最后一道防线，确保工作线程不会因
        # 单个不可预期的文件或第三方库异常而退出。
        _log(context, "warning", f"提取 {path} 的日期失败，已隔离：{exc}")
        return None


# 语义更明确的别名，供引擎或外部调用方选择。
extract_best_date = extract_date


__all__ = [
    "AGGRESSIVE_JSON_ACCURACY",
    "DATE_ACCURACY",
    "DateExtractionResult",
    "EXIF_ACCURACY",
    "FILE_MTIME_ACCURACY",
    "FILENAME_ACCURACY",
    "JSON_ACCURACY",
    "exif_extractor",
    "extract_best_date",
    "extract_date",
    "filename_extractor",
    "guess_extractor",
    "json_extractor",
    "json_sidecar_candidates",
    "mtime_extractor",
]
