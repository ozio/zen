"""Portable primitives for the isolated Zen development workflow (Python 3.9+)."""
from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence


class DevError(RuntimeError):
    """An operation cannot be proved safe or did not succeed."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_sha(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", value or ""):
        raise DevError("Expected a full lowercase 40-character source SHA")
    return value


def is_link(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
    except FileNotFoundError:
        return False
    # Python 3.9 has no Path.is_junction; reject NTFS reparse points explicitly.
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def no_symlink_ancestors(path: Path) -> None:
    path = path.absolute()
    for part in [*reversed(path.parents), path]:
        if is_link(part):
            raise DevError("Refusing a symlink in managed path: %s" % part)


def read_json(path: Path) -> Dict[str, Any]:
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DevError("Cannot read JSON receipt %s: %s" % (path, error)) from error
    if not isinstance(result, dict):
        raise DevError("JSON receipt must be an object: %s" % path)
    return result


def atomic_json(path: Path, value: Any) -> None:
    no_symlink_ancestors(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    pending = path.with_name(path.name + ".pending-" + uuid.uuid4().hex)
    try:
        with pending.open("x", encoding="utf-8") as output:
            os.chmod(pending, 0o600)
            json.dump(value, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(pending, path)
    finally:
        if pending.exists():
            pending.unlink()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_inventory(root: Path, allow_links: bool = False) -> List[Dict[str, Any]]:
    if not root.is_dir():
        raise DevError("Expected a directory: %s" % root)
    records = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if is_link(path):
            if not allow_links:
                raise DevError("Standalone bundle still contains a symlink: %s" % path)
            records.append({"path": relative, "link": os.readlink(path)})
        elif path.is_file():
            records.append({"path": relative, "size": path.stat().st_size,
                            "sha256": sha256_file(path),
                            "executable": bool(path.stat().st_mode & 0o111)})
        elif not path.is_dir():
            raise DevError("Refusing special file: %s" % path)
    return records


def inventory_digest(records: List[Dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(records, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def make_read_only(root: Path) -> None:
    for path in root.rglob("*"):
        if not is_link(path):
            # Never broaden permissions on backups containing personal profile data.
            os.chmod(path, path.stat().st_mode & 0o777 & ~0o222)
    os.chmod(root, root.stat().st_mode & 0o777 & ~0o222)


class Runner:
    """No shell interpolation; long builds stream to a capped local log."""

    def run(self, argv: Sequence[str], cwd: Path, env: Optional[Dict[str, str]] = None,
            check: bool = True) -> subprocess.CompletedProcess:
        try:
            result = subprocess.run([str(arg) for arg in argv], cwd=str(cwd), env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, encoding="utf-8", errors="replace")
        except OSError as error:
            raise DevError("Cannot execute %s: %s" % (argv[0], error)) from error
        if check and result.returncode:
            raise DevError("%s exited %s:\n%s" % (argv[0], result.returncode,
                                                  (result.stderr or result.stdout)[-4000:]))
        return result

    def logged(self, argv: Sequence[str], cwd: Path, env: Dict[str, str], log: Path) -> None:
        no_symlink_ancestors(log)
        log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            process = subprocess.Popen([str(arg) for arg in argv], cwd=str(cwd), env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        except OSError as error:
            raise DevError("Cannot execute %s: %s" % (argv[0], error)) from error
        limit = 20 * 1024 * 1024
        with log.open("wb") as output:
            os.chmod(log, 0o600)
            assert process.stdout is not None
            try:
                for block in iter(lambda: process.stdout.read(8192), b""):
                    sys.stdout.buffer.write(block)
                    sys.stdout.buffer.flush()
                    if output.tell() + len(block) > limit:
                        output.seek(0)
                        output.truncate()
                        output.write(b"[Earlier log output discarded at 20 MiB cap]\n")
                    output.write(block)
                code = process.wait()
            except BaseException:
                process.terminate()
                process.wait()
                raise
        if code:
            raise DevError("Command failed (%s); log: %s" % (code, log))


class Context:
    def __init__(self, root: Path, runner: Optional[Runner] = None, toolchain_root: Optional[Path] = None):
        self.root = root.resolve()
        self.local = self.root / ".zen-local"
        self.toolchain_root = (toolchain_root or self.local / "toolchains").absolute()
        self.runner = runner or Runner()

    def managed(self, path: Path, create_parent: bool = False) -> Path:
        path = path.absolute()
        no_symlink_ancestors(path)
        path = path.resolve()
        if path == self.local or not path.is_relative_to(self.local):
            raise DevError("Path must stay below %s: %s" % (self.local, path))
        if create_parent:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path

    def git(self, *args: str, cwd: Optional[Path] = None, check: bool = True) -> subprocess.CompletedProcess:
        return self.runner.run(["git", *args], cwd or self.root, check=check)

    def sha(self, cwd: Optional[Path] = None) -> str:
        return require_sha(self.git("rev-parse", "HEAD", cwd=cwd).stdout.strip())

    def snapshot(self, cwd: Optional[Path] = None) -> Dict[str, Any]:
        return {"source_sha": self.sha(cwd),
                "branch": self.git("symbolic-ref", "--quiet", "--short", "HEAD", cwd=cwd,
                                   check=False).stdout.strip() or None,
                "status": self.git("status", "--porcelain=v1", "--untracked-files=all", cwd=cwd).stdout,
                "tracked_diff_sha256": hashlib.sha256(
                    self.git("diff", "--binary", "HEAD", "--", cwd=cwd).stdout.encode()).hexdigest()}

    def assert_snapshot(self, expected: Dict[str, Any], cwd: Optional[Path] = None) -> None:
        if self.snapshot(cwd) != expected:
            raise DevError("Source checkout changed during operation; preserved it and stopped")

    @contextmanager
    def lock(self) -> Iterator[None]:
        path = self.managed(self.local / "operation.lock", create_parent=True)
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as error:
            raise DevError("Another operation (or interrupted operation) owns %s. Inspect before removing it." % path) from error
        try:
            with os.fdopen(fd, "w") as output:
                json.dump({"pid": os.getpid(), "created_at": utc_now()}, output)
            yield
        finally:
            path.unlink(missing_ok=True)

    def free_space(self, needed: int = 15 * 1024 ** 3) -> None:
        available = shutil.disk_usage(self.root).free
        if available < needed:
            raise DevError("Only %.1f GiB free; need %.1f GiB for this operation" %
                           (available / 1024 ** 3, needed / 1024 ** 3))


def _candidate(ctx: Context, names: Sequence[str], fallback: Optional[str] = None) -> Optional[Path]:
    for name in names:
        path = ctx.toolchain_root / name
        if path.is_file():
            return path.absolute()
    found = shutil.which(fallback) if fallback else None
    return Path(found).absolute() if found else None


def toolchains(ctx: Context, required: bool = True) -> Dict[str, Any]:
    node_pin = (ctx.root / ".nvmrc").read_text().strip()
    python_pin = (ctx.root / ".python-version").read_text().strip()
    rust_pin = (ctx.root / ".rust-toolchain").read_text().strip()
    node = _candidate(ctx, ["node/bin/node", "node/node.exe"])
    python = _candidate(ctx, ["python/bin/python3", "python/bin/python", "python/python.exe"])
    if python is None and shutil.which("uv"):
        found = ctx.runner.run(["uv", "python", "find", "--managed-python", python_pin],
                               ctx.root, check=False)
        if not found.returncode and found.stdout.strip():
            python = Path(found.stdout.strip()).absolute()
    rustc = _candidate(ctx, ["rust/bin/rustc", "rust/bin/rustc.exe", "cargo/bin/rustc",
                            "cargo/bin/rustc.exe"], "rustc")
    result = {"pins": {"node": node_pin, "python": python_pin, "rust": rust_pin}, "errors": []}
    for name, executable in [("node", node), ("python", python), ("rust", rustc)]:
        if not executable:
            result["errors"].append("Missing managed %s %s" % (name, result["pins"][name]))
            continue
        env = dict(os.environ, RUSTUP_TOOLCHAIN=rust_pin)
        version = ctx.runner.run([str(executable), "--version"], ctx.root, env=env, check=False)
        text = version.stdout.strip() or version.stderr.strip()
        expected = {"node": r"v%s\." % re.escape(node_pin),
                    "python": r"Python %s(?:\.|$)" % re.escape(python_pin),
                    "rust": r"rustc %s(?:\s|$)" % re.escape(rust_pin)}[name]
        if version.returncode or not re.match(expected, text):
            result["errors"].append("%s pin mismatch: %s" % (name, text))
        result[name] = {"path": str(executable), "version": text}
    if required and result["errors"]:
        raise DevError("; ".join(result["errors"]) + ". Provision project toolchains; global defaults are never changed.")
    return result


def build_env(ctx: Context, chain: Dict[str, Any]) -> Dict[str, str]:
    env = dict(os.environ)
    prefixes = [str(Path(chain[name]["path"]).parent) for name in ("node", "python", "rust")]
    sccache_directory = ctx.local / "mozbuild" / "sccache"
    if sccache_directory.is_dir():
        prefixes.insert(0, str(sccache_directory))
    env["PATH"] = os.pathsep.join(prefixes + [env.get("PATH", "")])
    env.update({"RUSTUP_TOOLCHAIN": chain["pins"]["rust"],
                "MOZBUILD_STATE_PATH": str(ctx.local / "mozbuild"),
                "UV_CACHE_DIR": str(ctx.local / "cache" / "uv"),
                "CARGO_HOME": str(ctx.local / "cache" / "cargo"),
                "npm_config_cache": str(ctx.local / "cache" / "npm"),
                "SCCACHE_DIR": str(ctx.local / "cache" / "sccache"),
                "SCCACHE_CACHE_SIZE": "4G", "MOZ_CRASHREPORTER_DISABLE": "1"})
    sccache = shutil.which("sccache", path=env["PATH"])
    if sccache:
        env["RUSTC_WRAPPER"] = sccache
    for name in ("ZEN_RELEASE", "MOZ_AUTOMATION", "MOZ_MAR_SIGNING_KEY_FILE",
                 "MAR_PRIVATE_KEY", "MOZ_SIGNING_SERVERS"):
        env.pop(name, None)
    # An inherited virtual environment must not override the managed build Python.
    env.pop("VIRTUAL_ENV", None)
    return env


def process_list(runner: Optional[Runner] = None) -> List[Dict[str, Any]]:
    runner = runner or Runner()
    if platform.system() == "Windows":
        script = ("$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | "
                  "Select-Object ProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress")
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        result = runner.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], Path.cwd())
        try:
            records = json.loads(result.stdout)
        except ValueError as error:
            raise DevError("Cannot inventory Windows processes") from error
        if isinstance(records, dict):
            records = [records]
        return [{"pid": item["ProcessId"], "binary": item.get("ExecutablePath"), "name": item.get("Name"),
                 "command": item.get("CommandLine") or ""} for item in records]
    result = runner.run(["ps", "-axo", "pid=,command="], Path.cwd())
    processes = []
    native = None
    if platform.system() == "Darwin":
        try:
            native = ctypes.CDLL("/usr/lib/libproc.dylib")
            native.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
            native.proc_pidpath.restype = ctypes.c_int
        except OSError:
            pass
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[0].isdigit():
            pid = int(fields[0])
            binary = None
            if native is not None:
                buffer = ctypes.create_string_buffer(4096)
                if native.proc_pidpath(pid, buffer, len(buffer)) > 0:
                    binary = buffer.value.decode("utf-8", errors="replace")
            elif platform.system() == "Linux":
                try:
                    binary = os.readlink("/proc/%s/exe" % pid)
                except OSError:
                    pass
            processes.append({"pid": pid, "command": fields[1], "binary": binary})
    return processes


def pid_alive(pid: int) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise DevError("Invalid PID in receipt")
    if platform.system() == "Windows":
        # Windows os.kill uses TerminateProcess for non-console signals; never probe with it.
        return any(item["pid"] == pid for item in process_list())
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        if platform.system() == "Windows":
            return any(item["pid"] == pid for item in process_list())
        raise
    return True


def assert_stopped(paths: Sequence[Path], runner: Optional[Runner] = None,
                   state: Optional[Dict[str, Any]] = None) -> None:
    if state and state.get("pid") is not None and pid_alive(state["pid"]):
        raise DevError("Recorded browser PID %s is still running" % state["pid"])
    canonical = [str(path.resolve()).casefold() for path in paths]
    for process in process_list(runner):
        if process["pid"] == os.getpid():
            continue
        command = process["command"].casefold()
        binary = (process.get("binary") or "").casefold()
        known_browser = Path(binary).name in ("zen", "zen.exe", "zen-bin", "firefox", "firefox.exe", "firefox-bin")
        if any(binary == path or binary.startswith(path + os.sep)
               or command.startswith(path + os.sep) or command.startswith(path + " ")
               or (known_browser and path in command) for path in canonical):
            raise DevError("Browser/profile is in use by PID %s; close it normally first" % process["pid"])
        if (process.get("name") or "").casefold() in ("zen.exe", "firefox.exe") and not binary:
            raise DevError("Cannot identify a running browser process; stopped state cannot be proved")
    # Firefox leaves a regular lock file after clean exit. Test its actual OS lock without truncating it.
    for path in paths:
        if path.is_dir():
            for name in ("parent.lock", ".parentlock", "lock"):
                lock = path / name
                if lock.exists() or lock.is_symlink():
                    assert_profile_unlocked(lock)


def assert_profile_unlocked(lock: Path) -> None:
    if is_link(lock) or not lock.is_file():
        raise DevError("Refusing unresolved symlink/special profile lock: %s" % lock)
    if platform.system() == "Windows":
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        create = kernel.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                           wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        close = kernel.CloseHandle
        close.argtypes = [wintypes.HANDLE]
        close.restype = wintypes.BOOL
        # OPEN_EXISTING + no sharing checks the same exclusive handle Firefox holds, without changing data.
        handle = create(str(lock), 0x80000000 | 0x40000000, 0, None, 3, 0, None)
        if handle == ctypes.c_void_p(-1).value:
            raise DevError("Profile lock is held or unreadable: %s (Windows error %s)" % (lock, ctypes.get_last_error()))
        close(handle)
        return
    import fcntl
    descriptor = None
    try:
        descriptor = os.open(lock, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
        fcntl.lockf(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB, 0, 0, os.SEEK_SET)
        fcntl.lockf(descriptor, fcntl.LOCK_UN, 0, 0, os.SEEK_SET)
    except OSError as error:
        raise DevError("Profile lock is held or cannot be proved unlocked: %s" % lock) from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def port_available(port: int) -> None:
    if not 1024 <= port <= 65535:
        raise DevError("Use an unprivileged localhost port (1024–65535)")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as error:
            raise DevError("127.0.0.1:%s is already occupied" % port) from error


def browser_binary(bundle: Path) -> Path:
    if bundle.suffix == ".app":
        import plistlib
        try:
            info = plistlib.loads((bundle / "Contents" / "Info.plist").read_bytes())
            name = info["CFBundleExecutable"]
        except (OSError, ValueError, KeyError) as error:
            raise DevError("Invalid app bundle: %s" % bundle) from error
        if not isinstance(name, str) or Path(name).name != name:
            raise DevError("Invalid CFBundleExecutable")
        binary = bundle / "Contents" / "MacOS" / name
    else:
        candidates = [bundle / name for name in ("zen", "zen.exe", "firefox", "firefox.exe")]
        found = [path for path in candidates if path.is_file()]
        if len(found) != 1:
            raise DevError("Cannot uniquely identify browser executable in %s" % bundle)
        binary = found[0]
    if not binary.is_file() or not binary.resolve().is_relative_to(bundle.resolve()):
        raise DevError("Browser executable escapes bundle or is missing")
    return binary.absolute()


def source_stamp(bundle: Path) -> str:
    import configparser
    candidates = [bundle / "application.ini", bundle / "Contents" / "Resources" / "application.ini"]
    for path in candidates:
        if path.is_file():
            parser = configparser.ConfigParser(interpolation=None)
            parser.read(path, encoding="utf-8")
            return require_sha(parser.get("App", "SourceStamp", fallback=""))
    raise DevError("Bundle has no application.ini source stamp")


def host_platform() -> Dict[str, str]:
    return {"system": platform.system(), "machine": platform.machine()}
