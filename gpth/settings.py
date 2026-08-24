"""桌面界面设置的持久化存储。"""

from __future__ import annotations

import json
import os
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

from .constants import settings_path

SCHEMA_VERSION = 1
DEFAULT_SETTINGS: dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    "appearance": "system",
    "accent": "blue",
    "ui_scale": 1.0,
    "window_geometry": "1180x760",
    "remember_paths": False,
    "input_dir": "",
    "output_dir": "",
    "defaults": {
        "operation": "copy",
        "album_mode": "shortcut",
        "date_division": "year-month",
        "conflict_mode": "rename",
        "unknown_date_mode": "folder",
        "workers": 4,
    },
}


def load_settings(path: Path | None = None) -> dict[str, Any]:
    """读取设置；损坏或旧格式时保留可识别字段并回退默认值。"""

    target = path or settings_path()
    defaults = deepcopy(DEFAULT_SETTINGS)
    try:
        loaded = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            return defaults
        return _merge_dict(defaults, loaded)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return defaults


def save_settings(values: dict[str, Any], path: Path | None = None) -> None:
    """采用临时文件原子写入，避免强制关机破坏设置。"""

    target = path or settings_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    data = _merge_dict(deepcopy(DEFAULT_SETTINGS), values)
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
