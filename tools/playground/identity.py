"""Fail-closed process, path, artifact and browser identity validation."""

import ctypes
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import struct
import subprocess
import sys
import uuid

MAC_PLAYGROUND_APP = Path("/Applications/Zen Playground.app")
MAC_PLAYGROUND_BUNDLE_ID = "io.ozio.zen.playground"
MAC_PLAYGROUND_ICON = "zen-playground.icns"


class Refusal(RuntimeError):
    pass


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refusal("Duplicate JSON key")
        result[key] = value
    return result


def canonical(path, directory=False):
    """Require absolute, normalized paths with no symlink/reparse-point components."""
    if not isinstance(path, (str, Path)) or not str(path):
        raise Refusal("Missing path")
    candidate = Path(path)
    if not candidate.is_absolute() or str(candidate) != os.path.normpath(str(path)):
        raise Refusal("Path must be absolute and normalized")
    current = Path(candidate.anchor)
    for part in candidate.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except OSError as exc:
            raise Refusal("Required path is missing") from exc
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise Refusal("Symlinks and reparse points are refused")
    if candidate.resolve() != candidate:
        raise Refusal("Path is not canonical")
    if directory and not candidate.is_dir():
        raise Refusal("Expected a directory")
    if not directory and not candidate.is_file():
        raise Refusal("Expected a regular file")
    return candidate


def load_json(path, max_size=256 * 1024):
    checked = canonical(path)
    info = checked.stat()
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise Refusal("Identity file belongs to another user")
    if os.name != "nt" and info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise Refusal("Identity file is writable by another user")
    if info.st_size > max_size:
        raise Refusal("Identity file exceeds size limit")
    try:
        with checked.open("r", encoding="utf-8") as stream:
            value = json.load(stream, object_pairs_hook=no_duplicates,
                              parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise Refusal("Invalid identity JSON") from exc
    if not isinstance(value, dict):
        raise Refusal("Identity file must contain an object")
    return value


def _mac_process(pid):
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    pathbuf = ctypes.create_string_buffer(4096)
    if libproc.proc_pidpath(pid, pathbuf, len(pathbuf)) <= 0:
        raise Refusal("Cannot read process executable")
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    size = ctypes.c_size_t(0)
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
        raise Refusal("Cannot read process arguments")
    if size.value > 4 * 1024 * 1024:
        raise Refusal("Process arguments exceed limit")
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        raise Refusal("Cannot read process arguments")
    data = buffer.raw[:size.value]
    argc = struct.unpack_from("i", data)[0]
    offset = data.find(b"\0", 4) + 1
    if offset <= 4 or not 1 <= argc <= 65536:
        raise Refusal("Invalid process arguments")
    while offset < len(data) and data[offset] == 0:
        offset += 1
    argv = data[offset:].split(b"\0")[:argc]
    if len(argv) != argc:
        raise Refusal("Truncated process arguments")
    uid = subprocess.run(["ps", "-p", str(pid), "-o", "uid="], capture_output=True, text=True, check=True, timeout=5)
    return {"binary": os.fsdecode(pathbuf.value), "argv": [os.fsdecode(arg) for arg in argv], "uid": int(uid.stdout.strip())}


def _windows_process(pid):
    command = ("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
               "Get-CimInstance Win32_Process -Filter 'ProcessId = %d' | "
               "Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress") % pid
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                            capture_output=True, encoding="utf-8", check=True, timeout=10)
    record = json.loads(result.stdout)
    if not record or not record.get("ExecutablePath") or not record.get("CommandLine"):
        raise Refusal("Cannot read process identity")
    count = ctypes.c_int()
    parse = ctypes.windll.shell32.CommandLineToArgvW
    parse.restype = ctypes.POINTER(ctypes.c_wchar_p)
    parse.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    args = parse(record["CommandLine"], ctypes.byref(count))
    if not args:
        raise Refusal("Cannot parse process arguments")
    try:
        argv = [args[i] for i in range(count.value)]
    finally:
        release = ctypes.windll.kernel32.LocalFree
        release.argtypes = [ctypes.c_void_p]
        release.restype = ctypes.c_void_p
        release(ctypes.cast(args, ctypes.c_void_p))
    return {"binary": record["ExecutablePath"], "argv": argv}


def process_identity(pid):
    try:
        if sys.platform == "darwin":
            return _mac_process(pid)
        if sys.platform.startswith("linux"):
            proc = Path("/proc") / str(pid)
            argv = (proc / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
            info = (proc / "exe").stat()
            return {"binary": os.readlink(str(proc / "exe")), "argv": [os.fsdecode(arg) for arg in argv],
                    "uid": proc.stat().st_uid, "executable_inode":(info.st_dev, info.st_ino)}
        if os.name == "nt":
            return _windows_process(pid)
        raise Refusal("Unsupported host: cannot prove process identity")
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise Refusal("Cannot prove process identity") from exc


def digest(path):
    sha = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


class Guard:
    def __init__(self, repo, process_reader=None):
        self.repo = canonical(Path(repo), directory=True)
        self.state_path = self.repo / ".zen-local" / "state.json"
        self.process_reader = process_reader or process_identity
        self._hash_cache = None
        self._artifact_hash_cache = {}

    def _check_digest(self, path, expected):
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise Refusal("Artifact digest is missing or invalid")
        info = path.stat()
        key = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, expected)
        if self._artifact_hash_cache.get(str(path)) != key:
            if digest(path) != expected:
                raise Refusal("Playground artifact hash does not match its source receipt")
            self._artifact_hash_cache[str(path)] = key

    def _variant(self, record, manifest_path, manifest):
        """Bind a branded derivative to this SHA's separately sealed main origin."""
        sha = record["source_sha"]
        root = self.repo / ".zen-local" / "playground-artifacts" / sha
        base_path = self.repo / ".zen-local" / "artifacts" / sha / "manifest.json"
        if (sys.platform != "darwin" or manifest_path != root / "manifest.json"
                or manifest.get("variant") != "playground" or record.get("variant") != "playground"
                or canonical(manifest.get("base_artifact_manifest")) != base_path):
            raise Refusal("Playground variant provenance is not this source's macOS derivative")
        base = load_json(base_path, max_size=16 * 1024 * 1024)
        if (type(base.get("schema_version")) is not int or base["schema_version"] != 1
                or base.get("source_sha") != sha or base.get("variant", "main") != "main"):
            raise Refusal("Playground variant base manifest has a different source identity")
        for key in ("binary_sha256", "tree_sha256"):
            if (not isinstance(base.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", base[key])
                    or manifest.get("base_" + key) != base[key]):
                raise Refusal("Playground variant base digests do not match its source")
        base_binary = canonical(base.get("binary"))
        try:
            base_binary.relative_to(base_path.parent / "bundle")
        except ValueError as exc:
            raise Refusal("Playground variant base executable escapes its source artifact") from exc
        self._check_digest(base_binary, base["binary_sha256"])
        signing = base.get("code_signing")
        if (not isinstance(signing, dict) or signing.get("verified") is not True
                or not isinstance(signing.get("identity"), str)
                or (signing["identity"] != "-" and not re.fullmatch(r"[0-9a-fA-F]{40}", signing["identity"]))
                or signing.get("kind") != ("ad-hoc" if signing["identity"] == "-" else "certificate")
                or manifest.get("code_signing") != dict(signing, notarized=False)):
            raise Refusal("Playground variant signing does not match its verified base")
        for key in ("base_artifact_manifest", "base_binary_sha256", "base_tree_sha256",
                    "binary_sha256", "tree_sha256", "code_signing"):
            if record.get(key) != manifest.get(key):
                raise Refusal("Launcher variant provenance differs from its artifact")
        expected_bundle = root / "bundle" / "Zen Playground.app"
        if (canonical(manifest.get("bundle"), directory=True) != expected_bundle
                or canonical(manifest.get("binary")) != expected_bundle / "Contents" / "MacOS" / "zen"):
            raise Refusal("Playground variant bundle is outside its exact artifact")
        return root

    def _branding(self, bundle, manifest):
        branding = manifest.get("branding", {})
        if (not isinstance(branding, dict) or branding.get("bundle_id") != MAC_PLAYGROUND_BUNDLE_ID
                or branding.get("bundle_name") != "Zen Playground"):
            raise Refusal("Playground variant branding receipt is invalid")
        path = canonical(bundle / "Contents" / "Info.plist")
        try:
            info = plistlib.loads(path.read_bytes())
        except (OSError, ValueError, plistlib.InvalidFileException) as exc:
            raise Refusal("Playground Info.plist is invalid") from exc
        expected = {"CFBundleIdentifier": MAC_PLAYGROUND_BUNDLE_ID, "CFBundleName": "Zen Playground",
                    "CFBundleDisplayName": "Zen Playground", "CFBundleIconFile": MAC_PLAYGROUND_ICON}
        if (not isinstance(info, dict) or any(info.get(key) != value for key, value in expected.items())
                or "CFBundleIconName" in info
                or any(key in info for key in ("CFBundleURLTypes", "CFBundleDocumentTypes", "NSUserActivityTypes"))):
            raise Refusal("Playground bundle identity or URL handlers changed")
        self._check_digest(canonical(bundle / "Contents" / "Resources" / MAC_PLAYGROUND_ICON), branding.get("icon_sha256"))

    def validate(self):
        state = load_json(self.state_path)
        record = state.get("playground")
        if type(state.get("schema_version")) is not int or state["schema_version"] != 1 or not isinstance(record, dict):
            raise Refusal("No launcher playground state v1")
        if type(record.get("pid")) is not int or record["pid"] <= 0:
            raise Refusal("Missing exact playground PID")
        if not isinstance(record.get("source_sha"), str) or not re.fullmatch(r"[0-9a-f]{40}", record["source_sha"]):
            raise Refusal("Missing exact source SHA")
        if record.get("marker") != "ZEN PLAYGROUND":
            raise Refusal("Missing playground marker")
        try:
            session = uuid.UUID(record.get("session_id", ""))
            if record["session_id"] not in (str(session), session.hex):
                raise ValueError()
        except (ValueError, TypeError, AttributeError) as exc:
            raise Refusal("Missing per-launch session ID") from exc
        if record.get("marionette_host") != "127.0.0.1" or type(record.get("marionette_port")) is not int or not 1 <= record["marionette_port"] <= 65535:
            raise Refusal("Only a local Marionette endpoint is allowed")
        profile = canonical(record.get("profile"), directory=True)
        if profile != self.repo / ".zen-local" / "profiles" / "playground":
            raise Refusal("Profile is not this repository's clean playground")
        marker = load_json(profile / "zen-playground.json")
        if (type(marker.get("schema_version")) is not int or marker["schema_version"] != 1
                or marker.get("root") != str(self.repo) or marker.get("marker") != record["marker"]
                or marker.get("session_id") != record["session_id"]):
            raise Refusal("Profile ownership marker does not match this launch")
        for name in ("user.js", "prefs.js", "compatibility.ini"):
            candidate = profile / name
            if candidate.exists() or candidate.is_symlink():
                canonical(candidate)
        binary = canonical(record.get("binary"))
        artifacts = self.repo / ".zen-local" / "artifacts" / record["source_sha"]
        manifest_path = canonical(record.get("artifact_manifest"))
        manifest = load_json(manifest_path, max_size=16 * 1024 * 1024)
        if (type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1 or manifest.get("source_sha") != record["source_sha"]
                or not isinstance(manifest.get("binary_sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", manifest["binary_sha256"])):
            raise Refusal("Artifact manifest does not match launcher identity")
        variant = manifest.get("variant") == "playground"
        if variant:
            artifacts = self._variant(record, manifest_path, manifest)
        elif (manifest_path != artifacts / "manifest.json" or record.get("variant", "main") != "main"
              or manifest.get("variant", "main") != "main"):
            raise Refusal("Executable or manifest is outside the exact source artifact")
        origin_binary = canonical(manifest.get("binary"))
        try:
            origin_binary.relative_to(artifacts)
        except ValueError as exc:
            raise Refusal("Artifact executable is outside its source directory") from exc
        if binary != origin_binary:
            expected = MAC_PLAYGROUND_APP / "Contents" / "MacOS" / "zen"
            receipt_path = self.repo / ".zen-local" / "deployments" / "playground" / (record["source_sha"] + ".json")
            if sys.platform != "darwin" or binary != expected or canonical(record.get("deployment_manifest")) != receipt_path:
                raise Refusal("Executable is outside the exact source artifact or owned macOS playground application")
            deployment = load_json(receipt_path)
            if (type(deployment.get("schema_version")) is not int or deployment["schema_version"] != 1
                    or deployment.get("root") != str(self.repo) or deployment.get("source_sha") != record["source_sha"]
                    or deployment.get("bundle") != str(MAC_PLAYGROUND_APP) or deployment.get("binary") != str(binary)
                    or deployment.get("artifact_manifest") != str(manifest_path)
                    or deployment.get("binary_sha256") != manifest["binary_sha256"]
                    or deployment.get("tree_sha256") != manifest.get("tree_sha256")):
                raise Refusal("Secondary playground deployment does not match its immutable source artifact")
            if variant and any(deployment.get(key) != record.get(key) for key in (
                    "variant", "base_artifact_manifest", "base_binary_sha256", "base_tree_sha256", "code_signing")):
                raise Refusal("Secondary playground deployment variant provenance differs")
        if variant:
            self._branding(Path(manifest["bundle"]), manifest)
            if binary != origin_binary:
                self._branding(MAC_PLAYGROUND_APP, manifest)
        info = binary.stat()
        cache_key = (str(binary), info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, manifest["binary_sha256"])
        if self._hash_cache != cache_key:
            if digest(binary) != manifest["binary_sha256"]:
                raise Refusal("Playground executable hash does not match its source artifact")
            self._hash_cache = cache_key
        process = self.process_reader(record["pid"])
        if Path(process["binary"]) != binary or not process.get("argv") or Path(process["argv"][0]) != binary:
            raise Refusal("PID is not running the recorded playground executable")
        if "executable_inode" in process and process["executable_inode"] != (info.st_dev, info.st_ino):
            raise Refusal("Process is running a replaced executable")
        if hasattr(os, "getuid") and process.get("uid") != os.getuid():
            raise Refusal("Playground process belongs to another user")
        argv = process["argv"][1:]
        if "--no-remote" not in argv or "--marionette" not in argv:
            raise Refusal("Process lacks explicit isolated Marionette launch flags")
        profile_flags = [i for i, arg in enumerate(argv) if arg.lower() in ("--profile", "-profile")]
        if len(profile_flags) != 1 or profile_flags[0] + 1 >= len(argv) or argv[profile_flags[0] + 1] != str(profile):
            raise Refusal("Process command does not specify the exact playground profile")
        if any(arg.lower() in ("-p", "--p") or arg.lower().startswith(("--profile=", "-profile=", "--profilemanager", "-profilemanager")) for arg in argv):
            raise Refusal("Conflicting profile launch arguments")
        return record

    @staticmethod
    def capabilities(record, caps):
        # Validate before SetContext or any privileged script can reach a socket.
        if type(caps.get("moz:processID")) is not int or caps["moz:processID"] != record["pid"] or caps.get("moz:profile") != record["profile"]:
            raise Refusal("Marionette socket belongs to another PID or profile")

    @staticmethod
    def browser(record, identity):
        if (not isinstance(identity, dict) or type(identity.get("pid")) is not int or identity["pid"] != record["pid"]
                or identity.get("profile") != record["profile"] or identity.get("binary") != record["binary"]
                or identity.get("session_id") != record["session_id"] or identity.get("marker") != record["marker"]
                or identity.get("system_access") is not True or identity.get("port") != record["marionette_port"]):
            raise Refusal("In-browser playground identity or system access does not match launcher")
