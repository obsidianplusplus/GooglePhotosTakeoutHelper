"""可持久化的媒体 SHA-256 扫描缓存。

缓存只把路径、大小、纳秒修改时间和已经计算出的摘要写入用户配置目录。
任何缓存损坏或文件系统错误都只会退化为未命中，不影响正常扫描。
"""

from __future__ import annotations

import json
import os
import re
import stat
import threading
import time
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .constants import settings_path

CACHE_VERSION = 1
CACHE_FILE_NAME = "scan-cache-v1.json"
_MAX_CACHE_FILE_BYTES = 256 * 1024 * 1024
_DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}\Z")


@dataclass(slots=True)
class _CacheEntry:
    """内存中的单条缓存记录。"""

    size: int
    mtime_ns: int
    digest: str
    last_seen: int


class HashCache:
    """按文件身份校验并持久化 SHA-256 摘要。

    ``lookup`` 每次都会重新读取文件状态；只有路径、调用方提供的大小、当前
    ``st_size``、当前 ``st_mtime_ns`` 和合法摘要全部一致时才会命中。
    类内使用可重入锁，便于以后从并发哈希工作线程安全调用。
    """

    def __init__(self, path: Path | None = None, max_entries: int = 200_000) -> None:
        self.path = Path(path) if path is not None else settings_path().with_name(CACHE_FILE_NAME)
        try:
            configured_limit = int(max_entries)
        except (TypeError, ValueError):
            configured_limit = 200_000
        self.max_entries = max(configured_limit, 1)
        self._entries: dict[str, _CacheEntry] = {}
        self._hits = 0
        self._misses = 0
        self._last_seen = 0
        self._lock = threading.RLock()
        self._load()

    @property
    def hits(self) -> int:
        """返回本实例生命周期内的命中次数。"""

        with self._lock:
            return self._hits

    @property
    def misses(self) -> int:
        """返回本实例生命周期内的未命中次数。"""

        with self._lock:
            return self._misses

    @property
    def entry_count(self) -> int:
        """返回当前内存中的有效条目数。"""

        with self._lock:
            return len(self._entries)

    def lookup(self, path: Path, size: int) -> str | None:
        """查询摘要；文件状态或缓存字段有任何异常时均安全返回 ``None``。"""

        key = _normalize_path(path)
        expected_size = _coerce_size(size)
        if key is None or expected_size is None:
            self._record_miss()
            return None

        try:
            current = Path(path).stat()
        except (OSError, ValueError):
            # 文件消失时顺便清理旧键，避免以后重复访问无效条目。
            with self._lock:
                self._entries.pop(key, None)
            self._record_miss()
            return None
        if not stat.S_ISREG(current.st_mode):
            self._record_miss()
            return None

        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                self._misses += 1
                return None

            cache_stale = current.st_size != entry.size or current.st_mtime_ns != entry.mtime_ns
            if cache_stale:
                self._entries.pop(key, None)
                self._misses += 1
                return None
            if expected_size != entry.size or not _valid_digest(entry.digest):
                self._misses += 1
                return None

            entry.last_seen = self._next_last_seen_locked()
            self._hits += 1
            return entry.digest

    def store(
        self,
        path: Path,
        size: int,
        digest: str,
        *,
        expected_mtime_ns: int | None = None,
    ) -> None:
        """保存一条摘要；参数或文件状态不可信时忽略本次写入。"""

        key = _normalize_path(path)
        expected_size = _coerce_size(size)
        if key is None or expected_size is None or not _valid_digest(digest):
            return
        try:
            current = Path(path).stat()
        except (OSError, ValueError):
            return
        # 哈希结束后文件大小若已经变化，摘要可能对应旧内容，绝不能缓存。
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_size != expected_size
            or (expected_mtime_ns is not None and current.st_mtime_ns != expected_mtime_ns)
        ):
            return

        with self._lock:
            self._entries[key] = _CacheEntry(
                size=expected_size,
                mtime_ns=current.st_mtime_ns,
                digest=digest,
                last_seen=self._next_last_seen_locked(),
            )
            self._trim_locked()

    def save(self) -> None:
        """使用同目录临时文件和原子替换保存缓存；失败时静默保留内存数据。"""

        with self._lock:
            self._trim_locked()
            entries = {
                key: {
                    "size": entry.size,
                    "mtime_ns": entry.mtime_ns,
                    "digest": entry.digest,
                    "last_seen": entry.last_seen,
                }
                for key, entry in sorted(self._entries.items())
            }
        payload = {"version": CACHE_VERSION, "entries": entries}
        temporary: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except (OSError, UnicodeError, TypeError, ValueError):
            # 缓存属于可选加速层，写入失败不能中断照片扫描。
            pass
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def clear(self) -> bool:
        """清空内存和磁盘缓存，并返回磁盘操作是否成功。"""

        with self._lock:
            self._entries.clear()
            self._last_seen = 0
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            return False
        return True

    def _load(self) -> None:
        """读取并逐项校验缓存，损坏、旧版本或 I/O 错误均按空缓存处理。"""

        try:
            if self.path.stat().st_size > _MAX_CACHE_FILE_BYTES:
                return
            raw: Any = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
            return
        if not isinstance(raw, dict) or type(raw.get("version")) is not int:
            return
        if raw["version"] != CACHE_VERSION or not isinstance(raw.get("entries"), dict):
            return

        loaded: dict[str, _CacheEntry] = {}
        for raw_path, value in raw["entries"].items():
            if not isinstance(raw_path, str) or not isinstance(value, dict):
                continue
            key = _normalize_path(Path(raw_path))
            size = _coerce_size(value.get("size"))
            mtime_ns = value.get("mtime_ns")
            digest = value.get("digest")
            last_seen = value.get("last_seen")
            if (
                key is None
                or size is None
                or type(mtime_ns) is not int
                or not isinstance(digest, str)
                or not _valid_digest(digest)
                or type(last_seen) is not int
                or last_seen < 0
            ):
                continue
            candidate = _CacheEntry(size, mtime_ns, digest, last_seen)
            existing = loaded.get(key)
            if existing is None or candidate.last_seen > existing.last_seen:
                loaded[key] = candidate

        with self._lock:
            self._entries = loaded
            self._last_seen = max((entry.last_seen for entry in loaded.values()), default=0)
            self._trim_locked()

    def _record_miss(self) -> None:
        """线程安全地累计一次未命中并返回 ``None``。"""

        with self._lock:
            self._misses += 1
        return None

    def _next_last_seen_locked(self) -> int:
        """生成严格递增的时间戳，避免高频访问时 LRU 顺序打平。"""

        self._last_seen = max(time.time_ns(), self._last_seen + 1)
        return self._last_seen

    def _trim_locked(self) -> None:
        """按最后使用时间移除最旧记录，并用路径处理时间戳并列。"""

        excess = len(self._entries) - self.max_entries
        if excess <= 0:
            return
        oldest = sorted(
            self._entries,
            key=lambda key: (self._entries[key].last_seen, key),
        )[:excess]
        for key in oldest:
            self._entries.pop(key, None)


def _normalize_path(path: Path) -> str | None:
    """生成不解析符号链接的绝对路径键，并统一分隔符、大小写和 Unicode。"""

    try:
        expanded = Path(path).expanduser()
        normalized = os.path.normpath(os.path.abspath(os.fspath(expanded)))
        # Windows 文件路径默认不区分大小写；POSIX 必须保留大小写语义。
        normalized = os.path.normcase(normalized)
        return unicodedata.normalize("NFC", normalized)
    except (OSError, RuntimeError, TypeError, ValueError):
        return None


def _coerce_size(value: Any) -> int | None:
    """只接受非负普通整数，避免布尔值或字符串污染 JSON schema。"""

    if type(value) is not int or value < 0:
        return None
    return value


def _valid_digest(value: str) -> bool:
    """SHA-256 必须是恰好 64 位的小写十六进制文本。"""

    return bool(_DIGEST_PATTERN.fullmatch(value))
