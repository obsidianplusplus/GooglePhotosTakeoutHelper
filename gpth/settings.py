"""桌面界面设置的持久化存储。"""

from __future__ import annotations

import json
import os
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

from .constants import settings_path

SCHEMA_VERSION = 2
DEFAULT_SETTINGS: dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    "appearance": "System",
    "scaling": 1.0,
    "geometry": "1180x760",
    # 此值现在表示渐进加载的单批行数，不再截断执行计划。
    "preview_limit": 300,
    "remember_paths": False,
    "operation": "copy",
    "album_mode": "shortcut",
    "date_division": "year-month",
    "conflict_mode": "rename",
    "unknown_date_mode": "folder",
    "skip_extras": False,
    "set_file_mtime": True,
    "use_json": True,
    "use_exif": True,
    "use_filename": True,
    "aggressive_json": True,
    "use_file_mtime": False,
    "scan_all_if_no_takeout": True,
    "include_hidden": False,
    "write_report": True,
    "use_hash_cache": True,
    "recognize_live_photos": False,
    "live_photo_target": "apple",
    # 仅在用户明确启用时，才按拍摄日期修正完整日期型文件名。
    "correct_date_filenames": False,
    "workers": 4,
    "all_photos_folder": "ALL_PHOTOS",
    "unknown_date_folder": "date-unknown",
    "fix_recursive": True,
    "fix_json": True,
    "fix_exif": True,
    "fix_filename": True,
    "fix_aggressive": True,
    "fix_file_mtime": False,
    "fix_include_hidden": False,
    "fix_dry_run": False,
    "fix_correct_date_filenames": False,
    "input_dir": "",
    "output_dir": "",
    "fix_dir": "",
}


def load_settings(path: Path | None = None) -> dict[str, Any]:
    """读取设置；损坏或旧格式时保留可识别字段并回退默认值。"""

    target = path or settings_path()
    defaults = deepcopy(DEFAULT_SETTINGS)
    try:
        loaded = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            return defaults
        return _normalise_settings(_merge_dict(defaults, _migrate_legacy_settings(loaded)))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return defaults


def save_settings(values: dict[str, Any], path: Path | None = None) -> None:
    """采用临时文件原子写入，避免强制关机破坏设置。"""

    target = path or settings_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    data = _normalise_settings(_merge_dict(deepcopy(DEFAULT_SETTINGS), values))
    data["schema_version"] = SCHEMA_VERSION
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _merge_dict(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """只递归合并字典，未知键保留以便未来版本向前兼容。"""

    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = _merge_dict(base[key], value)
        else:
            base[key] = value
    return base


def _migrate_legacy_settings(loaded: dict[str, Any]) -> dict[str, Any]:
    """把早期设置模块的嵌套字段迁移为桌面界面使用的扁平字段。"""

    migrated = deepcopy(loaded)
    if "geometry" not in migrated and "window_geometry" in migrated:
        migrated["geometry"] = migrated["window_geometry"]
    if "scaling" not in migrated and "ui_scale" in migrated:
        migrated["scaling"] = migrated["ui_scale"]

    legacy_defaults = migrated.get("defaults")
    if isinstance(legacy_defaults, dict):
        for key, value in legacy_defaults.items():
            migrated.setdefault(key, value)
    return migrated


def _normalise_settings(values: dict[str, Any]) -> dict[str, Any]:
    """对安全敏感的新字段做类型与枚举收敛，损坏值回退到兼容默认值。"""

    if not isinstance(values.get("recognize_live_photos"), bool):
        values["recognize_live_photos"] = False
    if values.get("live_photo_target") not in {"apple", "coloros16"}:
        values["live_photo_target"] = "apple"
    for key in ("correct_date_filenames", "fix_correct_date_filenames"):
        if not isinstance(values.get(key), bool):
            values[key] = False
    try:
        preview_batch_size = int(values.get("preview_limit", 300))
    except (TypeError, ValueError):
        preview_batch_size = 300
    values["preview_limit"] = min(max(preview_batch_size, 100), 1000)
    return values
