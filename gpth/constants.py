"""项目公共常量。"""

from __future__ import annotations

from pathlib import Path

APP_NAME = "Google Photos Takeout Helper"
APP_DISPLAY_NAME = "PhotoTakeout Studio"

# 原版支持的“编辑后副本”后缀；匹配前统一转为小写和 NFC。
EXTRA_SUFFIXES: tuple[str, ...] = (
    "-edited",
    "-effects",
    "-smile",
    "-mix",
    "-edytowane",
    "-bearbeitet",
    "-bewerkt",
    "-編集済み",
    "-modificato",
    "-modifié",
    "-ha editado",
    "-editat",
)

# mimetypes 在不同系统上的数据库并不一致，因此显式补齐常见媒体扩展名。
IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".jpe",
        ".png",
        ".gif",
        ".bmp",
        ".tif",
        ".tiff",
        ".webp",
        ".heic",
        ".heif",
        ".avif",
        ".dng",
        ".raw",
        ".cr2",
        ".cr3",
        ".nef",
        ".arw",
        ".orf",
        ".rw2",
        ".pef",
        ".srw",
        ".raf",
        ".ico",
    }
)
VIDEO_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".mp4",
        ".m4v",
        ".mov",
        ".avi",
        ".mkv",
        ".webm",
        ".wmv",
        ".flv",
        ".3gp",
        ".3g2",
        ".mts",
        ".m2ts",
        ".mpeg",
        ".mpg",
        ".vob",
        ".ts",
        ".ogv",
        ".asf",
    }
)
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS

DEFAULT_ALL_PHOTOS_FOLDER = "ALL_PHOTOS"
DEFAULT_UNKNOWN_DATE_FOLDER = "date-unknown"
DEFAULT_REPORT_NAME = "gpth-run-report.json"
ALBUM_INFO_NAME = "albums-info.json"

# EXIF 读取只需解析图像头部，但某些解码器仍会展开数据；保留合理上限以规避坏文件。
DEFAULT_MAX_EXIF_BYTES = 256 * 1024 * 1024
DEFAULT_HASH_CHUNK_SIZE = 4 * 1024 * 1024


def settings_path() -> Path:
    """返回跨平台的用户设置文件路径。"""

    import os
    import sys

    if sys.platform == "win32":
        root = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support"
    else:
        root = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "GooglePhotosTakeoutHelper" / "settings.json"
