"""重复文件详情探测与安全缩略图生成。"""

from __future__ import annotations

import mimetypes
import warnings
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Any

from . import image_support
from .constants import IMAGE_EXTENSIONS
from .models import StrEnum

# 限制解码后的像素数量，避免压缩率极高的图片耗尽内存。
MAX_THUMBNAIL_PIXELS = 80_000_000


class ThumbnailStatus(StrEnum):
    """缩略图生成结果。"""

    READY = "ready"
    NOT_IMAGE = "not-image"
    UNSUPPORTED = "unsupported"
    CORRUPT = "corrupt"
    MISSING = "missing"
    TOO_LARGE = "too-large"


@dataclass(frozen=True, slots=True)
class DuplicateFileDetails:
    """重复项详情面板所需的只读文件信息。"""

    path: Path
    exists: bool
    size_bytes: int | None
    modified_at: datetime | None
    mime_type: str | None
    declared_extension: str
    decoded_format: str | None
    raw_size: tuple[int, int] | None
    display_size: tuple[int, int] | None
    frame_count: int | None
    error: str | None


@dataclass(frozen=True, slots=True)
class ThumbnailResult:
    """与 Tk 无关的缩略图结果，GUI 可在主线程中把 PNG 字节转换为图像。"""

    status: ThumbnailStatus
    png_bytes: bytes | None
    decoded_format: str | None
    raw_size: tuple[int, int] | None
    display_size: tuple[int, int] | None
    thumbnail_size: tuple[int, int] | None
    error: str | None


def inspect_duplicate_file(path: Path | str) -> DuplicateFileDetails:
    """读取一个重复文件的基础属性和可用图片信息，任何错误都转为结果字段。"""

    file_path = _coerce_path(path)
    mime_type = _guess_mime(file_path)
    extension = file_path.suffix.casefold()
    exists = False
    size_bytes: int | None = None
    modified_at: datetime | None = None

    try:
        exists = file_path.exists()
        if not file_path.is_file():
            message = "文件不存在" if not exists else "路径不是普通文件"
            return DuplicateFileDetails(
                file_path,
                exists,
                None,
                None,
                mime_type,
                extension,
                None,
                None,
                None,
                None,
                message,
            )
        stat = file_path.stat()
        size_bytes = stat.st_size
        try:
            modified_at = datetime.fromtimestamp(stat.st_mtime)
        except (OSError, OverflowError, ValueError):
            modified_at = None
    except Exception as exc:
        return DuplicateFileDetails(
            file_path,
            exists,
            size_bytes,
            modified_at,
            mime_type,
            extension,
            None,
            None,
            None,
            None,
            _error_text("读取文件属性失败", exc),
        )

    if not _is_declared_image(file_path, mime_type):
        return DuplicateFileDetails(
            file_path,
            True,
            size_bytes,
            modified_at,
            mime_type,
            extension,
            None,
            None,
            None,
            None,
            None,
        )

    pillow, pillow_error = _load_pillow()
    if pillow is None:
        return DuplicateFileDetails(
            file_path,
            True,
            size_bytes,
            modified_at,
            mime_type,
            extension,
            None,
            None,
            None,
            None,
            pillow_error,
        )
    Image, _ImageOps, UnidentifiedImageError = pillow
    if not _is_supported_extension(extension, Image):
        reason = image_support.decoder_unavailable_reason(file_path, Image)
        return DuplicateFileDetails(
            file_path,
            True,
            size_bytes,
            modified_at,
            mime_type,
            extension,
            None,
            None,
            None,
            None,
            reason or f"Pillow 当前不支持 {extension or '该'} 图片格式",
        )

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(file_path) as image:
                decoded_format = _format_name(image.format)
                raw_size = _integer_size(image.size)
                frame_count = max(int(getattr(image, "n_frames", 1) or 1), 1)
                display_size = _oriented_size(image, raw_size)
                error = None
                if _pixel_count(raw_size) > MAX_THUMBNAIL_PIXELS:
                    error = _too_large_message(raw_size)
                return DuplicateFileDetails(
                    file_path,
                    True,
                    size_bytes,
                    modified_at,
                    mime_type,
                    extension,
                    decoded_format,
                    raw_size,
                    display_size,
                    frame_count,
                    error,
                )
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        error = _error_text("图片像素过大，已拒绝解码", exc)
    except UnidentifiedImageError as exc:
        error = image_support.heif_decode_failure_reason(file_path, exc) or _error_text(
            "无法识别图片内容",
            exc,
        )
    except Exception as exc:
        error = _error_text("无法解码图片", exc)
    return DuplicateFileDetails(
        file_path,
        True,
        size_bytes,
        modified_at,
        mime_type,
        extension,
        None,
        None,
        None,
        None,
        error,
    )


def build_thumbnail(
    path: Path | str,
    bounds: tuple[int, int] = (360, 240),
) -> ThumbnailResult:
    """生成保持比例且不放大的 PNG 缩略图，失败时返回可展示的状态。"""

    file_path = _coerce_path(path)
    normalized_bounds = _normalize_bounds(bounds)
    if normalized_bounds is None:
        return _thumbnail_error(ThumbnailStatus.CORRUPT, "缩略图尺寸必须是两个正整数")
    try:
        if not file_path.is_file():
            return _thumbnail_error(ThumbnailStatus.MISSING, "文件不存在或不是普通文件")
    except Exception as exc:
        return _thumbnail_error(
            ThumbnailStatus.MISSING,
            _error_text("无法访问文件", exc),
        )

    mime_type = _guess_mime(file_path)
    extension = file_path.suffix.casefold()
    if not _is_declared_image(file_path, mime_type):
        return _thumbnail_error(ThumbnailStatus.NOT_IMAGE, "该文件不是受支持的图片")

    pillow, pillow_error = _load_pillow()
    if pillow is None:
        return _thumbnail_error(
            ThumbnailStatus.UNSUPPORTED,
            pillow_error or "Pillow 不可用",
        )
    Image, ImageOps, UnidentifiedImageError = pillow
    if not _is_supported_extension(extension, Image):
        reason = image_support.decoder_unavailable_reason(file_path, Image)
        return _thumbnail_error(
            ThumbnailStatus.UNSUPPORTED,
            reason or f"Pillow 当前不支持 {extension or '该'} 图片格式",
        )

    decoded_format: str | None = None
    raw_size: tuple[int, int] | None = None
    display_size: tuple[int, int] | None = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(file_path) as image:
                decoded_format = _format_name(image.format)
                raw_size = _integer_size(image.size)
                if _pixel_count(raw_size) > MAX_THUMBNAIL_PIXELS:
                    return ThumbnailResult(
                        ThumbnailStatus.TOO_LARGE,
                        None,
                        decoded_format,
                        raw_size,
                        _oriented_size(image, raw_size),
                        None,
                        _too_large_message(raw_size),
                    )

                # 动画只使用第一帧，避免预览一个文件时解码整段动画。
                try:
                    image.seek(0)
                except (AttributeError, EOFError):
                    pass
                transposed = ImageOps.exif_transpose(image)
                try:
                    display_size = _integer_size(transposed.size)
                    thumbnail = transposed.copy()
                finally:
                    if transposed is not image:
                        transposed.close()

                try:
                    thumbnail.thumbnail(
                        normalized_bounds,
                        Image.Resampling.LANCZOS,
                        reducing_gap=2.0,
                    )
                    has_alpha = "A" in thumbnail.getbands() or (
                        thumbnail.mode == "P" and "transparency" in thumbnail.info
                    )
                    converted = thumbnail.convert("RGBA" if has_alpha else "RGB")
                    try:
                        buffer = BytesIO()
                        converted.save(buffer, format="PNG")
                        png_bytes = buffer.getvalue()
                    finally:
                        converted.close()
                    thumbnail_size = _integer_size(thumbnail.size)
                finally:
                    thumbnail.close()
        return ThumbnailResult(
            ThumbnailStatus.READY,
            png_bytes,
            decoded_format,
            raw_size,
            display_size,
            thumbnail_size,
            None,
        )
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        return ThumbnailResult(
            ThumbnailStatus.TOO_LARGE,
            None,
            decoded_format,
            raw_size,
            display_size,
            None,
            _error_text("图片像素过大，已拒绝解码", exc),
        )
    except UnidentifiedImageError as exc:
        heif_reason = image_support.heif_decode_failure_reason(file_path, exc)
        return ThumbnailResult(
            ThumbnailStatus.UNSUPPORTED if heif_reason else ThumbnailStatus.CORRUPT,
            None,
            decoded_format,
            raw_size,
            display_size,
            None,
            heif_reason or _error_text("无法识别图片内容", exc),
        )
    except Exception as exc:
        return ThumbnailResult(
            ThumbnailStatus.CORRUPT,
            None,
            decoded_format,
            raw_size,
            display_size,
            None,
            _error_text("生成缩略图失败", exc),
        )


def _load_pillow() -> tuple[tuple[Any, Any, type[Exception]] | None, str | None]:
    """延迟加载 Pillow，确保依赖损坏时模块本身仍可被 UI 导入。"""

    try:
        from PIL import Image, ImageOps, UnidentifiedImageError

        # 与日期提取共享一次性注册状态，避免每次切换重复项都重复初始化插件。
        image_support.ensure_pillow_heif()
        return (Image, ImageOps, UnidentifiedImageError), None
    except Exception as exc:
        return None, _error_text("Pillow 不可用", exc)


def _coerce_path(path: Path | str) -> Path:
    """把 UI 传入的路径转换为 Path，异常值也不向外抛出。"""

    try:
        return Path(path).expanduser()
    except Exception:
        return Path(str(path))


def _guess_mime(path: Path) -> str | None:
    try:
        return mimetypes.guess_type(path.name)[0]
    except Exception:
        return None


def _is_declared_image(path: Path, mime_type: str | None) -> bool:
    return path.suffix.casefold() in IMAGE_EXTENSIONS or bool(
        mime_type and mime_type.startswith("image/")
    )


def _is_supported_extension(extension: str, image_module: Any) -> bool:
    """已声明的图片扩展必须有当前 Pillow 构建提供的解码器。"""

    if extension not in IMAGE_EXTENSIONS:
        return True
    try:
        return extension in image_module.registered_extensions()
    except Exception:
        return False


def _normalize_bounds(bounds: tuple[int, int]) -> tuple[int, int] | None:
    try:
        width, height = bounds
        width, height = int(width), int(height)
    except Exception:
        return None
    return (width, height) if width > 0 and height > 0 else None


def _integer_size(value: Any) -> tuple[int, int]:
    width, height = value
    return int(width), int(height)


def _pixel_count(size: tuple[int, int]) -> int:
    return max(size[0], 0) * max(size[1], 0)


def _oriented_size(image: Any, raw_size: tuple[int, int]) -> tuple[int, int]:
    """不解码完整像素，仅依据 EXIF Orientation 计算显示分辨率。"""

    try:
        orientation = image.getexif().get(274)
    except Exception:
        orientation = None
    return (raw_size[1], raw_size[0]) if orientation in {5, 6, 7, 8} else raw_size


def _format_name(value: Any) -> str | None:
    return str(value).upper() if value else None


def _too_large_message(size: tuple[int, int]) -> str:
    return f"图片分辨率 {size[0]}×{size[1]} 超过安全缩略图上限"


def _error_text(prefix: str, exc: BaseException) -> str:
    detail = str(exc).strip()
    return f"{prefix}：{detail}" if detail else prefix


def _thumbnail_error(status: ThumbnailStatus, error: str) -> ThumbnailResult:
    return ThumbnailResult(status, None, None, None, None, None, error)


__all__ = [
    "DuplicateFileDetails",
    "ThumbnailResult",
    "ThumbnailStatus",
    "build_thumbnail",
    "inspect_duplicate_file",
]
