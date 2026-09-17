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
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .constants import MEDIA_EXTENSIONS
from .models import CancelledError, ConflictMode, TaskContext


class BundleTransactionError(RuntimeError):
    """成组事务失败，且至少一项回滚或清理操作也未完成。"""

    def __init__(self, cause: BaseException, recovery_errors: list[str]) -> None:
        self.cause = cause
        self.recovery_errors = tuple(recovery_errors)
        details = "；".join(recovery_errors)
        super().__init__(f"{cause}；事务恢复未完全完成：{details}")


@dataclass(frozen=True, slots=True)
class MoveSourceOutcome:
    """移动源文件的最终状态；``moved`` 为 None 表示无法确认完成。"""

    moved: bool | None
    message: str = ""


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


def atomic_copy_bundle(
    pairs: list[tuple[Path, Path]],
    context: TaskContext,
    chunk_size: int,
    *,
    allow_overwrite: bool = False,
) -> None:
    """先完整暂存一组文件，再以无替换占位共同提交。

    覆盖模式会先把已有目标改名为同目录备份。提交或取消失败时
    会尽力删除本次输出并恢复旧目标；若文件系统同时拒绝回滚，
    :class:`BundleTransactionError` 会列出未恢复的精确路径，不会假称已完全回滚。
    """

    target_keys = [conflict_key(target) for _source, target in pairs]
    if len(set(target_keys)) != len(target_keys):
        raise ValueError("成组事务的目标路径必须彼此唯一")

    staged: list[tuple[Path, Path]] = []
    backups: list[tuple[Path, Path]] = []
    # 目标从“原子占位”开始就属于本事务，记录文件身份可避免
    # 回滚时删除被外部程序换入的新文件。
    claimed: list[tuple[Path, tuple[int, int, int, int]]] = []
    try:
        for source, target in pairs:
            context.check_cancelled()
            target.parent.mkdir(parents=True, exist_ok=True)
            part = target.with_name(f".{target.name}.{uuid.uuid4().hex}.gpth-part")
            staged.append((part, target))
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
                pass

        context.check_cancelled()
        for _part, target in staged:
            occupied = target.exists() or target.is_symlink()
            if occupied and target.is_dir() and not target.is_symlink():
                raise IsADirectoryError(f"目标位置是目录，无法覆盖：{target}")
            if occupied and not allow_overwrite:
                raise FileExistsError(f"执行期间目标已被其它程序占用：{target}")

        if allow_overwrite:
            for _part, target in staged:
                context.check_cancelled()
                if not (target.exists() or target.is_symlink()):
                    continue
                if target.is_dir() and not target.is_symlink():
                    raise IsADirectoryError(f"目标位置是目录，无法覆盖：{target}")
                backup = target.with_name(f".{target.name}.{uuid.uuid4().hex}.gpth-backup")
                os.replace(target, backup)
                backups.append((backup, target))
                context.check_cancelled()

        for part, target in staged:
            context.check_cancelled()
            identity = _claim_target_no_replace(part, target)
            claimed.append((target, identity))
            context.check_cancelled()
            # hardlink 已经是完整目标；这次 replace 只会消耗本事务
            # 自己的同 inode 暂存名。占位回退路径则在这里用完整文件
            # 替换本事务的空占位，不会覆盖外部新占用。
            if _path_identity(target) != identity:
                raise FileExistsError(f"目标在提交期间已被外部替换：{target}")
            os.replace(part, target)
            claimed[-1] = (target, _path_identity(target))
            context.check_cancelled()
    except Exception as exc:
        recovery_errors = _rollback_copy_bundle(claimed, backups, context)
        recovery_errors.extend(_cleanup_staged_files(staged, context, error_level="ERROR"))
        staged.clear()
        if recovery_errors:
            raise BundleTransactionError(exc, recovery_errors) from exc
        raise
    else:
        for backup, _target in backups:
            try:
                backup.unlink(missing_ok=True)
            except OSError as exc:
                context.log("WARNING", f"清理实况照片覆盖备份失败 {backup}：{exc}")
    finally:
        for part, _target in staged:
            try:
                part.unlink(missing_ok=True)
            except OSError:
                pass


def retire_sources_for_move(sources: list[Path], context: TaskContext) -> list[MoveSourceOutcome]:
    """在输出已落盘后成组退役 MOVE 源文件。

    先把每个源原子改名到同目录临时保留名；只有全部改名完成后
    才删除保留文件。改名阶段失败会回滚并把整组降级为 COPY。
    删除阶段的单项失败会优先恢复原路径，返回每一半的真实结果。
    """

    source_keys = [conflict_key(source) for source in sources]
    if len(set(source_keys)) != len(source_keys):
        raise ValueError("MOVE 成组事务的源路径必须彼此唯一")

    holds = [
        source.with_name(f".{source.name}.{uuid.uuid4().hex}.gpth-move-hold") for source in sources
    ]
    renamed: list[tuple[Path, Path]] = []
    try:
        for source, hold in zip(sources, holds, strict=True):
            context.check_cancelled()
            os.replace(source, hold)
            renamed.append((source, hold))
            context.check_cancelled()
    except Exception as exc:
        recovery_errors = _restore_move_holds(renamed, context)
        if recovery_errors:
            raise BundleTransactionError(exc, recovery_errors) from exc
        if isinstance(exc, CancelledError):
            raise
        message = f"源文件无法安全成组移除，输出已降级为复制：{exc}"
        return [
            MoveSourceOutcome(False if source.exists() or source.is_symlink() else None, message)
            for source in sources
        ]

    outcomes: list[MoveSourceOutcome] = []
    # 进入删除阶段后不再响应取消，避免主动中断造成半组源文件。
    for source, hold in renamed:
        try:
            hold.unlink()
        except OSError as exc:
            try:
                _move_path_no_replace(hold, source)
            except Exception as restore_exc:
                message = (
                    f"目标已输出，但源文件保留项无法删除或恢复："
                    f"原路径 {source}；保留路径 {hold}；"
                    f"删除错误 {exc}；恢复错误 {restore_exc}"
                )
                outcomes.append(MoveSourceOutcome(None, message))
            else:
                outcomes.append(
                    MoveSourceOutcome(
                        False,
                        f"无法删除源文件保留项，已恢复原路径并降级为复制：{source}（{exc}）",
                    )
                )
        else:
            outcomes.append(MoveSourceOutcome(True))
    return outcomes


def _claim_target_no_replace(source: Path, target: Path) -> tuple[int, int, int, int]:
    """原子占有不存在的目标；既有目标永远不会被此函数覆盖。"""

    try:
        os.link(source, target, follow_symlinks=False)
    except FileExistsError:
        raise FileExistsError(f"执行期间目标已被其它程序占用：{target}") from None
    except OSError:
        # FAT/exFAT 等文件系统不支持 hardlink。用 O_EXCL 先原子占位，
        # 后续 os.replace 只替换我们自己创建的占位文件。
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        flags |= getattr(os, "O_BINARY", 0)
        try:
            descriptor = os.open(target, flags, 0o600)
        except FileExistsError:
            raise FileExistsError(f"执行期间目标已被其它程序占用：{target}") from None
        else:
            os.close(descriptor)
    return _path_identity(target)


def _move_path_no_replace(source: Path, target: Path) -> None:
    """不覆盖任何新占用地恢复一个备份或 MOVE 保留文件。"""

    identity = _claim_target_no_replace(source, target)
    try:
        if _path_identity(target) != identity:
            raise FileExistsError(f"恢复期间目标已被外部替换：{target}")
        os.replace(source, target)
    except Exception:
        # replace 失败时只清理仍属于本次占位的目标，
        # 不触碰被外部程序换入的文件。
        try:
            if _path_identity(target) == identity:
                target.unlink()
        except OSError:
            pass
        raise

    # POSIX rename 在源和目标是同一 inode 的 hardlink 时可能是空操作；
    # 显式清理旧名，确保备份或 hold 不会被误报为已消费。
    if source.exists() or source.is_symlink():
        try:
            source.unlink()
        except OSError as exc:
            raise OSError(f"目标已恢复，但无法清理保留路径 {source}：{exc}") from exc


def rename_file_no_replace(source: Path, target: Path, context: TaskContext) -> None:
    """在同一文件系统内安全改名，执行期间出现同名文件也绝不覆盖。"""

    context.check_cancelled()
    if source == target:
        return
    if source.parent != target.parent:
        raise ValueError("文件名修正只允许在原目录内进行")
    _move_path_no_replace(source, target)


def rename_files_no_replace(
    pairs: list[tuple[Path, Path]], context: TaskContext
) -> None:
    """原子语义地改名一组同目录文件；中途失败时恢复已经改名的成员。"""

    completed: list[tuple[Path, Path]] = []
    try:
        for source, target in pairs:
            rename_file_no_replace(source, target, context)
            completed.append((source, target))
    except Exception as exc:
        recovery_errors: list[str] = []
        for source, target in reversed(completed):
            try:
                _move_path_no_replace(target, source)
            except Exception as restore_exc:
                recovery_errors.append(f"{target} → {source}：{restore_exc}")
        if recovery_errors:
            raise OSError(
                f"成组改名失败：{exc}；并且回滚不完整：{'；'.join(recovery_errors)}"
            ) from exc
        raise


def _rollback_copy_bundle(
    claimed: list[tuple[Path, tuple[int, int, int, int]]],
    backups: list[tuple[Path, Path]],
    context: TaskContext,
) -> list[str]:
    """回滚已占有的目标并恢复覆盖备份，返回所有二次失败。"""

    errors: list[str] = []
    for target, identity in reversed(claimed):
        try:
            current = _path_identity(target)
        except FileNotFoundError:
            continue
        except OSError as exc:
            message = f"无法检查已提交目标 {target}：{exc}"
            errors.append(message)
            context.log("ERROR", message)
            continue
        if current != identity:
            message = f"已提交目标被外部替换，未删除：{target}"
            errors.append(message)
            context.log("ERROR", message)
            continue
        try:
            target.unlink()
        except OSError as exc:
            message = f"回滚已提交目标失败 {target}：{exc}"
            errors.append(message)
            context.log("ERROR", message)

    for backup, target in reversed(backups):
        try:
            _move_path_no_replace(backup, target)
        except Exception as exc:
            message = f"恢复覆盖备份失败：备份 {backup}；目标 {target}；{exc}"
            errors.append(message)
            context.log("ERROR", message)
    return errors


def _restore_move_holds(renamed: list[tuple[Path, Path]], context: TaskContext) -> list[str]:
    """将尚未删除的 MOVE 保留文件恢复到原路径。"""

    errors: list[str] = []
    for source, hold in reversed(renamed):
        try:
            _move_path_no_replace(hold, source)
        except Exception as exc:
            message = f"MOVE 回滚失败：保留 {hold}；原路径 {source}；{exc}"
            errors.append(message)
            context.log("ERROR", message)
    return errors


def _cleanup_staged_files(
    staged: list[tuple[Path, Path]], context: TaskContext, *, error_level: str
) -> list[str]:
    """清理暂存文件并返回无法清理的精确路径。"""

    errors: list[str] = []
    for part, _target in staged:
        try:
            part.unlink(missing_ok=True)
        except OSError as exc:
            message = f"清理成组暂存文件失败 {part}：{exc}"
            errors.append(message)
            context.log(error_level, message)
    return errors


def _path_identity(path: Path) -> tuple[int, int, int, int]:
    """返回足以识别本次占位文件的不跟随链接身份。"""

    info = path.stat(follow_symlinks=False)
    return info.st_dev, info.st_ino, info.st_size, info.st_ctime_ns


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
