"""为 Pillow 统一注册 HEIC/HEIF 解码器并生成可操作的中文诊断。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any

HEIF_EXTENSIONS: frozenset[str] = frozenset({".heic", ".heif", ".hif"})

# ISO BMFF 中可用于标识 HEIF/HEIC 静态图像的常见品牌。这里只读取文件头，
# 不尝试解码像素，因此即使缺少 pillow-heif 也能区分“缺解码器”和“文件头不符”。
_HEIF_BRANDS: frozenset[bytes] = frozenset(
    {
        b"heic",
        b"heix",
        b"hevc",
        b"hevx",
        b"heim",
        b"heis",
        b"hevm",
        b"hevs",
        b"mif1",
        b"msf1",
    }
)
_SIGNATURE_READ_BYTES = 256


@dataclass(frozen=True, slots=True)
class HeifRegistrationStatus:
    """pillow-heif 的一次性注册结果。"""

    available: bool
    error: BaseException | None = None


@dataclass(frozen=True, slots=True)
class HeifSignature:
    """从 ISO BMFF 文件头得到的轻量 HEIF 识别结果。"""

    is_heif: bool
    major_brand: str | None
    compatible_brands: tuple[str, ...]
    error: str | None = None

    @property
    def display_brand(self) -> str | None:
        """返回最适合日志展示的品牌。"""

        if self.major_brand:
            return self.major_brand
        return self.compatible_brands[0] if self.compatible_brands else None


_REGISTER_LOCK = Lock()
_REGISTER_ATTEMPTED = False
_REGISTER_STATUS = HeifRegistrationStatus(False, None)


def ensure_pillow_heif() -> HeifRegistrationStatus:
    """最多注册一次 pillow-heif，并让其他 Pillow 调用方共享结果。

    插件异常不能连带禁用 JPEG/PNG 等 Pillow 原生格式，因此错误通过返回值
    交给调用方按具体文件说明，而不是在导入阶段向外抛出。
    """

    global _REGISTER_ATTEMPTED, _REGISTER_STATUS
    with _REGISTER_LOCK:
        if not _REGISTER_ATTEMPTED:
            _REGISTER_ATTEMPTED = True
            try:
                from pillow_heif import register_heif_opener  # type: ignore[import-untyped]

                # 日期和预览都不需要 HEIF 内嵌缩略图；关闭该分支可减少扫描时
                # 的额外解析与内存占用，原始主图和 EXIF 读取不受影响。
                register_heif_opener(thumbnails=False)
            except Exception as exc:
                _REGISTER_STATUS = HeifRegistrationStatus(False, exc)
            else:
                _REGISTER_STATUS = HeifRegistrationStatus(True, None)
        return _REGISTER_STATUS


def inspect_heif_signature(path: Path | str) -> HeifSignature:
    """只读文件头判断其是否为 HEIF/HEIC 容器，不解码任何图像数据。"""

    file_path = Path(path)
    try:
        with file_path.open("rb") as stream:
            header = stream.read(_SIGNATURE_READ_BYTES)
    except OSError as exc:
        detail = str(exc).strip()
        return HeifSignature(False, None, (), f"无法读取文件头：{detail or type(exc).__name__}")

    # 标准 HEIF 文件以 ISO BMFF 的 ftyp box 开始。盒长度限制了解析范围，避免
    # 把后续媒体数据里偶然出现的四字节文本误判为兼容品牌。
    if len(header) < 12 or header[4:8] != b"ftyp":
        return HeifSignature(False, None, ())
    box_size = int.from_bytes(header[:4], "big", signed=False)
    if box_size == 1:
        # 扩展长度的 ftyp 很少见；当前短探针只需识别其品牌起始偏移。
        if len(header) < 20:
            return HeifSignature(False, None, ())
        brand_offset = 16
        available_end = min(int.from_bytes(header[8:16], "big", signed=False), len(header))
    else:
        brand_offset = 8
        available_end = min(box_size or len(header), len(header))
    if available_end < brand_offset + 4:
        return HeifSignature(False, None, ())

    major_raw = header[brand_offset : brand_offset + 4]
    compatible_offset = brand_offset + 8  # 主品牌后还有 4 字节 minor version。
    compatible_raw = tuple(
        header[offset : offset + 4]
        for offset in range(compatible_offset, available_end - 3, 4)
    )
    all_brands = (major_raw, *compatible_raw)
    is_heif = any(brand in _HEIF_BRANDS for brand in all_brands)
    return HeifSignature(
        is_heif,
        _decode_brand(major_raw),
        tuple(_decode_brand(brand) for brand in compatible_raw),
    )


def decoder_unavailable_reason(path: Path | str, image_module: Any) -> str | None:
    """当 Pillow 没有声明格式解码器时，返回比“文件损坏”更准确的原因。"""

    file_path = Path(path)
    extension = file_path.suffix.casefold()
    try:
        registered = extension in image_module.registered_extensions()
    except Exception:
        registered = False
    if registered or extension not in HEIF_EXTENSIONS:
        return None

    status = ensure_pillow_heif()
    signature = inspect_heif_signature(file_path)
    evidence = _signature_evidence(extension, signature)
    if _is_missing_plugin(status.error):
        cause = "当前 Python 环境未安装 pillow-heif，Pillow 因而不支持 HEIC/HEIF 解码"
        action = "请重新安装项目依赖（python -m pip install -e .）"
    elif status.error is not None:
        cause = (
            "Pillow 当前不支持 HEIC/HEIF 解码，因为 pillow-heif 已找到但加载或注册失败："
            f"{_exception_text(status.error)}"
        )
        action = "请重新安装与当前 Python/Pillow 匹配的 pillow-heif"
    elif status.available:
        cause = "pillow-heif 已加载，但当前 Pillow 仍不支持该扩展名的解码"
        action = "请升级或重新安装 Pillow 与 pillow-heif"
    else:
        cause = "当前 Pillow 不支持 HEIC/HEIF 解码"
        action = "请安装完整的项目图像依赖"
    return f"{evidence}；{cause}，因此无法读取。{action}。这不表示文件损坏。"


def heif_decode_failure_reason(path: Path | str, exc: BaseException) -> str | None:
    """为“已注册解码器但打开失败”的 HEIF 文件补充不武断的诊断。"""

    file_path = Path(path)
    if file_path.suffix.casefold() not in HEIF_EXTENSIONS:
        return None
    signature = inspect_heif_signature(file_path)
    detail = _exception_text(exc)
    if signature.is_heif:
        brand = signature.display_brand or "未知"
        return (
            f"文件头已确认是 HEIC/HEIF（品牌 {brand}），但解码器无法打开：{detail}。"
            "可能原因是该文件使用了解码器暂不支持的编码特性、文件内容不完整，"
            "或本机图像插件异常；不能仅凭此错误判定文件损坏"
        )
    if signature.error:
        return f"无法核验 HEIC/HEIF 文件头（{signature.error}），解码器错误：{detail}"
    return (
        f"扩展名是 {file_path.suffix or '.heic'}，但文件头不是可识别的 HEIC/HEIF "
        f"容器；解码器错误：{detail}。可能是扩展名错误或文件内容不完整"
    )


def _signature_evidence(extension: str, signature: HeifSignature) -> str:
    """把文件头证据转换为简短中文。"""

    if signature.is_heif:
        return f"文件头已确认是 HEIC/HEIF（品牌 {signature.display_brand or '未知'}）"
    if signature.error:
        return f"文件扩展名为 {extension}，但{signature.error}"
    return f"文件扩展名为 {extension}，文件头未识别为 HEIC/HEIF"


def _decode_brand(value: bytes) -> str:
    """安全展示 ISO BMFF 四字符品牌。"""

    return value.decode("ascii", errors="replace").strip("\x00 ") or "未知"


def _is_missing_plugin(exc: BaseException | None) -> bool:
    """仅把 pillow_heif 自身缺失识别为“未安装”，依赖 DLL 错误另行说明。"""

    if not isinstance(exc, ModuleNotFoundError):
        return False
    name = getattr(exc, "name", "") or ""
    return name == "pillow_heif" or name.startswith("pillow_heif.")


def _exception_text(exc: BaseException) -> str:
    detail = str(exc).strip()
    return detail or type(exc).__name__


__all__ = [
    "HEIF_EXTENSIONS",
    "HeifRegistrationStatus",
    "HeifSignature",
    "decoder_unavailable_reason",
    "ensure_pillow_heif",
    "heif_decode_failure_reason",
    "inspect_heif_signature",
]
