"""低层文件操作：媒体识别、哈希、安全复制和快捷方式。"""

from __future__ import annotations

import errno
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

from .constants import MEDIA_EXTENSIONS
from .models import ConflictMode, TaskContext


class OutputDirectoryLock:
    """阻止两个 GPTH 任务同时写入同一输出目录。"""

    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.path = output_dir / ".gpth-task.lock"
        self.token = uuid.uuid4().hex
        self._acquired = False

    def __enter__(self) -> OutputDirectoryLock:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {"pid": os.getpid(), "token": self.token, "started_at": datetime.now().isoformat()},
            ensure_ascii=False,
        ).encode("utf-8")
        for _ in range(3):
            try:
                descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if self._remove_stale_lock():
                    continue
                raise RuntimeError(
                    f"另一个整理任务正在使用输出目录：{self.output_dir}\n锁文件：{self.path}"
                ) from None
            try:
                os.write(descriptor, payload)
                os.fsync(descriptor)
            except Exception:
                os.close(descriptor)
                self.path.unlink(missing_ok=True)
                raise
            else:
                os.close(descriptor)
            self._acquired = True
            return self
        raise RuntimeError(f"无法取得输出目录任务锁：{self.path}")

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        if not self._acquired:
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if data.get("token") == self.token:
                self.path.unlink(missing_ok=True)
        except (OSError, UnicodeError, json.JSONDecodeError):
            # 只删除仍属于自己的锁；无法确认时保留，避免误解锁其它任务。
            pass
        finally:
            self._acquired = False

    def _remove_stale_lock(self) -> bool:
        """锁所属进程已退出时清理残留；无法判断时按仍在运行处理。"""

        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            pid = int(data.get("pid", 0))
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            return False
        if pid > 0 and _process_is_alive(pid):
            return False
        try:
            self.path.unlink()
            return True
        except FileNotFoundError:
            return True
        except OSError:
            return False


def _process_is_alive(pid: int) -> bool:
    """只查询进程是否存在，不向进程发送终止信号。"""

    if pid == os.getpid():
        return True
    if sys.platform == "win32":
        try:
            import ctypes

            process_query = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(process_query, False, pid)
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                return True
            # 访问被拒绝也表示 PID 存在，只是无权查询。
            return ctypes.windll.kernel32.GetLastError() == 5
        except (AttributeError, OSError):
            return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def is_media_file(path: Path) -> bool:
    """依据扩展名和 MIME 判断照片或视频，不读取整个文件。"""

    if path.suffix.lower() in MEDIA_EXTENSIONS:
        return True
    mime, _ = mimetypes.guess_type(path.name)
    return bool(mime and (mime.startswith("image/") or mime.startswith("video/")))


def is_hidden(path: Path) -> bool:
    """同时识别点号文件和 Windows hidden 属性。"""

    if path.name.startswith("."):
        return True
    if sys.platform == "win32":
        try:
            return bool(path.stat().st_file_attributes & 0x2)
        except (AttributeError, OSError):
            return False
    return False


def is_relative_to(path: Path, parent: Path) -> bool:
    """兼容大小写文件系统的路径包含判断。"""

    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except (OSError, ValueError):
        return False


def sha256_file(path: Path, context: TaskContext, chunk_size: int) -> str:
    """以固定内存流式计算 SHA-256，并在块边界响应取消。"""

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            context.check_cancelled()
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def available_target(
    path: Path,
    mode: ConflictMode,
    reserved: set[Path],
    normalized_reserved: set[str] | None = None,
) -> tuple[Path, bool]:
    """解析冲突目标；返回最终路径及是否因 skip 被跳过。"""

    normalized = conflict_key(path)
    # 大型 Takeout 可有数十万文件；调用方可复用规范化集合，把规划从 O(n²)
    # 降为近似 O(n)。未提供时保持原有易用接口。
    reserved_keys = (
        normalized_reserved
        if normalized_reserved is not None
        else {conflict_key(item) for item in reserved}
    )
    planned = normalized in reserved_keys
    occupied = path.exists() or planned
    # overwrite 只覆盖运行前已有文件；同一计划中的两个文件绝不能互相覆盖。
    if not occupied or (mode is ConflictMode.OVERWRITE and not planned):
        reserved.add(path)
        if normalized_reserved is not None:
            normalized_reserved.add(normalized)
        return path, False
    if mode is ConflictMode.SKIP:
        return path, True

    stem, suffix = path.stem, path.suffix
    number = 1
    while True:
        candidate = path.with_name(f"{stem}({number}){suffix}")
        normalized_candidate = conflict_key(candidate)
        if not candidate.exists() and normalized_candidate not in reserved_keys:
            reserved.add(candidate)
            if normalized_reserved is not None:
                normalized_reserved.add(normalized_candidate)
            return candidate, False
        number += 1


def conflict_key(path: Path) -> str:
    """Windows/macOS 常见大小写不敏感卷上的冲突键。"""

    absolute = str(path.absolute())
    return absolute.casefold() if sys.platform in {"win32", "darwin"} else absolute


def atomic_copy(
    source: Path,
    target: Path,
    context: TaskContext,
    chunk_size: int,
    *,
    allow_overwrite: bool = False,
) -> None:
    """先复制到同目录临时文件，完成后原子替换，取消时不留下半文件。"""

    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(f".{target.name}.{uuid.uuid4().hex}.gpth-part")
    try:
        with source.open("rb") as src, part.open("xb") as dst:
            while True:
                context.check_cancelled()
                chunk = src.read(chunk_size)
                if not chunk:
                    break
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        try:
            shutil.copystat(source, part, follow_symlinks=True)
        except OSError:
            # 元数据复制失败不应让照片实体复制失败。
            pass
        context.check_cancelled()
        if allow_overwrite:
            if target.exists() and target.is_dir() and not target.is_symlink():
                raise IsADirectoryError(f"目标位置是目录，无法覆盖：{target}")
        elif target.exists() or target.is_symlink():
            raise FileExistsError(f"执行期间目标已被其它程序占用：{target}")
        os.replace(part, target)
    finally:
        if part.exists():
            try:
                part.unlink()
            except OSError:
                pass


def safe_move(
    source: Path,
    target: Path,
    context: TaskContext,
    chunk_size: int,
    *,
    allow_overwrite: bool = False,
) -> bool:
    """安全移动并返回是否发生了跨卷实体复制。"""

    context.check_cancelled()
    target.parent.mkdir(parents=True, exist_ok=True)
    context.check_cancelled()
    try:
        if allow_overwrite:
            if target.exists() and target.is_dir() and not target.is_symlink():
                raise IsADirectoryError(f"目标位置是目录，无法覆盖：{target}")
        elif target.exists() or target.is_symlink():
            raise FileExistsError(f"执行期间目标已被其它程序占用：{target}")
        os.replace(source, target)
        return False
    except OSError as exc:
        if exc.errno not in {errno.EXDEV, errno.EACCES, errno.EPERM}:
            raise

    # Windows 跨卷常返回 EACCES/EPERM；复制完成并落盘后才删除源文件。
    atomic_copy(
        source,
        target,
        context,
        chunk_size,
        allow_overwrite=allow_overwrite,
    )
    context.check_cancelled()
    source.unlink()
    return True


def _prepare_overwrite_target(target: Path) -> None:
    """仅删除与明确目标同名的文件/链接，绝不递归删除目录。"""

    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.exists():
        raise IsADirectoryError(f"目标位置是目录，无法覆盖：{target}")


def prepare_file_target(target: Path) -> None:
    """公开的单文件覆盖准备函数，主要供快捷方式执行器使用。"""

    _prepare_overwrite_target(target)


def create_shortcut(link_path: Path, target: Path, context: TaskContext) -> None:
    """Unix 创建相对符号链接，Windows 创建 `.lnk`。"""

    context.check_cancelled()
    link_path.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform != "win32":
        relative = os.path.relpath(target, start=link_path.parent)
        link_path.symlink_to(relative)
        return

    # 通过环境变量传递 Unicode 路径，路径本身不会拼进 PowerShell 代码。
    script = (
        "$w=New-Object -ComObject WScript.Shell;"
        "$s=$w.CreateShortcut($env:GPTH_LINK);"
        "$s.TargetPath=$env:GPTH_TARGET;"
        "$s.WorkingDirectory=$env:GPTH_WORKDIR;"
        "$s.Save()"
    )
    environment = os.environ.copy()
    environment.update(
        {
            "GPTH_LINK": str(link_path),
            # 保持原版的相对目标，整体搬移输出目录后快捷方式仍有机会可用。
            "GPTH_TARGET": os.path.relpath(target, start=link_path.parent),
            "GPTH_WORKDIR": str(link_path.parent),
        }
    )
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    result = subprocess.run(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
        creationflags=creation_flags,
        check=False,
    )
    context.check_cancelled()
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "未知 PowerShell 错误"
        raise OSError(f"创建 Windows 快捷方式失败：{detail}")


def set_file_time(path: Path, value: datetime, context: TaskContext) -> datetime:
    """设置访问/修改时间；Windows 不支持 1970 年前时间时进行兼容钳制。"""

    context.check_cancelled()
    actual = value
    if sys.platform == "win32" and value < datetime(1970, 1, 1):
        actual = datetime(1970, 1, 1)
        context.log("WARNING", f"{path.name} 的日期早于 1970，Windows 上已改为 1970-01-01")
    stamp = actual.timestamp()
    try:
        os.utime(path, (stamp, stamp), follow_symlinks=False)
    except (NotImplementedError, TypeError):
        # Windows 的 CPython 不支持 follow_symlinks=False；.lnk 本身是普通文件，
        # 直接调用不会跟随快捷方式，实体媒体也可安全使用这一分支。
        os.utime(path, (stamp, stamp))
    return actual
