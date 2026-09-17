"""按可靠拍摄日期修正 Google Takeout 生成的错误日期型文件名。"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

# 只接受“完整日期 + 可选 Takeout 冲突编号”。范围刻意很窄，避免把
# IMG_2025-11-09_trip、相机流水号或用户自定义名称误改。
_DATE_STEM_PATTERN = re.compile(
    r"^(?P<date>(?:18|19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))"
    r"(?P<number>\(\d+\))?$"
)


def corrected_date_stem(stem: str, date_taken: datetime | None) -> str:
    """返回修正后的文件主名；不符合严格日期型规则时原样返回。"""

    if date_taken is None:
        return stem
    match = _DATE_STEM_PATTERN.fullmatch(stem)
    if match is None:
        return stem
    actual_date = date_taken.strftime("%Y-%m-%d")
    if match.group("date") == actual_date:
        return stem
    return f"{actual_date}{match.group('number') or ''}"


def corrected_date_name(name: str, date_taken: datetime | None) -> str:
    """修正一个文件名中的完整日期主名，并保留扩展名大小写。"""

    path = Path(name)
    stem = corrected_date_stem(path.stem, date_taken)
    return name if stem == path.stem else f"{stem}{path.suffix}"


def corrected_date_target(path: Path, date_taken: datetime | None) -> Path:
    """返回与源文件同目录的安全候选名；函数本身不改动文件。"""

    return path.with_name(corrected_date_name(path.name, date_taken))


def organized_folder_mtime(path: Path) -> datetime | None:
    """在 ``YYYY/MM`` 目录与 mtime 相互印证时返回本地修改时间。

    该证据只供已整理目录中的严格日期型错误名修正使用；任一条件不符就
    返回 ``None``，不会在普通目录里擅自把复制时间当成拍摄日期。
    """

    try:
        year_text = path.parent.parent.name
        month_text = path.parent.name
        if not re.fullmatch(r"(?:18|19|20)\d{2}", year_text):
            return None
        if not re.fullmatch(r"(?:0[1-9]|1[0-2])", month_text):
            return None
        value = datetime.fromtimestamp(path.stat().st_mtime)
        if (value.year, value.month) != (int(year_text), int(month_text)):
            return None
        # 只有 mtime 确实会改变严格日期型文件名时才把它作为修正证据。
        return value if corrected_date_target(path, value) != path else None
    except (OSError, OverflowError, ValueError):
        return None


__all__ = [
    "corrected_date_name",
    "corrected_date_stem",
    "corrected_date_target",
    "organized_folder_mtime",
]
