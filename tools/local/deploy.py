"""Guarded main installation and rollback; no profile is ever copied to playground."""
from __future__ import annotations

import configparser
import os
import platform
import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from build import verify_artifact
from core import (Context, DevError, assert_stopped, atomic_json, browser_binary, copy_tree,
                  host_platform, inventory_digest, is_link, make_read_only, no_symlink_ancestors,
                  read_json, require_sha, sha256_file, source_stamp, tree_inventory, utc_now, verify_mac_signature)

REQUIRED_CHECKS = ("standalone", "profile_isolation", "extensions", "cookies_sessions", "enpass_native_host")


def compatibility(ctx: Context, manifest: Dict[str, Any], receipt_path: Path) -> Dict[str, Any]:
    receipt = read_json(receipt_path)
    expected = {"schema_version": 1, "source_sha": manifest["source_sha"],
                "artifact_manifest": str(ctx.local / "artifacts" / manifest["source_sha"] / "manifest.json"),
                "binary_sha256": manifest["binary_sha256"], "platform": host_platform(),
                "profile": str(ctx.local / "profiles" / "playground"), "result": "pass"}
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise DevError("Compatibility proof does not match this standalone binary, SHA, host and clean profile")
    checks = receipt.get("checks", {})
    if not isinstance(checks, dict) or any(checks.get(name) is not True for name in REQUIRED_CHECKS):
        raise DevError("Compatibility proof must pass standalone, isolation, extensions, sessions and real Enpass native exchange")
    from datetime import datetime, timezone
    try:
        verified = datetime.fromisoformat(receipt["verified_at"].replace("Z", "+00:00"))
        if verified.tzinfo is None or (verified - datetime.now(timezone.utc)).total_seconds() > 300:
            raise ValueError("invalid verification time")
    except (KeyError, ValueError, TypeError) as error:
        raise DevError("Compatibility proof requires an actual UTC verification timestamp") from error
    return receipt


def default_profile_root() -> Path:
    system = platform.system()
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "zen"
    if system == "Linux":
        return Path.home() / ".zen"
    if system == "Windows" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "zen"
    raise DevError("Cannot discover profile registry root on this host; specify --profile-root")


def select_profile(root: Path, explicit: Optional[str] = None) -> Path:
    root = root.absolute()
    no_symlink_ancestors(root)
    parser = configparser.ConfigParser(interpolation=None)
    try:
        with (root / "profiles.ini").open(encoding="utf-8") as source:
            parser.read_file(source)
    except (OSError, configparser.Error) as error:
        raise DevError("Cannot read main profiles.ini: %s" % error) from error
    profiles = []
    defaults = []
    for section in parser.sections():
        if not section.startswith("Profile") or not parser.has_option(section, "Path"):
            continue
        text = parser.get(section, "Path")
        path = Path(text)
        if parser.get(section, "IsRelative", fallback="1") == "1":
            path = root / path
            if not path.resolve().is_relative_to(root.resolve()):
                raise DevError("Relative registry profile escapes profile root")
        path = path.absolute()
        no_symlink_ancestors(path)
        path = path.resolve()
        if not path.is_dir():
            continue
        profiles.append(path)
        if parser.get(section, "Default", fallback="0") == "1":
            defaults.append(path)
    if explicit:
        target = Path(explicit).absolute()
        no_symlink_ancestors(target)
        target = target.resolve()
        if target not in profiles:
            raise DevError("Explicit main profile is not a registered existing profile")
        return target
    selected = set(defaults if defaults else profiles)
    if len(selected) != 1:
        raise DevError("Main profile is ambiguous; specify --profile PATH from profiles.ini")
    return selected.pop()


def deployment_paths(ctx: Context, args: Any) -> Tuple[Path, Path, Path]:
    if args.app:
        app = Path(args.app).absolute()
    elif platform.system() == "Darwin":
        app = Path("/Applications/Zen.app")
    else:
        raise DevError("Linux/Windows installation needs explicit --app BUNDLE_DIRECTORY")
    root = Path(args.profile_root).absolute() if args.profile_root else default_profile_root()
    for path in (app, root):
        no_symlink_ancestors(path)
        if path.resolve().is_relative_to(ctx.local):
            raise DevError("Main app/profile registry must be separate from local development state")
    if not app.is_dir():
        raise DevError("Main app must already exist so it can be consistently backed up: %s" % app)
    browser_binary(app)
    profile = select_profile(root, args.profile)
    if profile.resolve().is_relative_to(ctx.local):
        raise DevError("Main profile cannot be the playground or another managed development directory")
    if app.resolve().is_relative_to(root.resolve()) or root.resolve().is_relative_to(app.resolve()):
        raise DevError("Main app and profile registry must be separate directories")
    return app, root, profile


def _registry_inventory(root: Path) -> Dict[str, Any]:
    records = {}
    for name in ("profiles.ini", "installs.ini"):
        path = root / name
        no_symlink_ancestors(path)
        if path.exists():
            if not path.is_file():
                raise DevError("Profile registry is not a regular file: %s" % path)
            records[name] = {"present": True, "sha256": sha256_file(path), "size": path.stat().st_size}
        else:
            records[name] = {"present": False}
    return records


def _snapshot(app: Path, root: Path, profile: Path) -> Dict[str, Any]:
    return {"app_files": tree_inventory(app, allow_links=True),
            "profile_files": tree_inventory(profile, allow_links=True),
            "app_modes": _modes(app), "profile_modes": _modes(profile),
            "registry_modes": {name: (root / name).stat().st_mode & 0o777
                               for name in ("profiles.ini", "installs.ini") if (root / name).is_file()},
            "registry": _registry_inventory(root)}


def _modes(root: Path) -> Dict[str, int]:
    return {path.relative_to(root).as_posix(): path.stat().st_mode & 0o777
            for path in [root, *root.rglob("*")] if not path.is_symlink()}


def _standalone_links(root: Path) -> None:
    for path in root.rglob("*"):
        if is_link(path) and not path.is_symlink():
            raise DevError("Snapshot contains an unsupported filesystem reparse point: %s" % path)
        if path.is_symlink() and (Path(os.readlink(path)).is_absolute() or not path.resolve().is_relative_to(root.resolve())):
            raise DevError("Snapshot is not standalone (external/absolute link): %s" % path)


def _restore_modes(root: Path, modes: Dict[str, int]) -> None:
    for relative, mode in modes.items():
        path = root / relative
        if not path.absolute().is_relative_to(root.absolute()) or path.is_symlink():
            raise DevError("Invalid permissions target in backup")
        os.chmod(path, mode)


def create_backup(ctx: Context, app: Path, root: Path, profile: Path,
                  reason: str, candidate_sha: Optional[str] = None) -> Tuple[Path, Dict[str, Any]]:
    assert_stopped([app, profile], ctx.runner)
    before = _snapshot(app, root, profile)
    signed_app = verify_mac_signature(ctx, app)
    _standalone_links(app)
    _standalone_links(profile)
    needed = sum(item.get("size", 0) for item in before["app_files"] + before["profile_files"])
    ctx.free_space(needed + 1024 ** 3)
    ident = utc_now().replace(":", "-").replace("+", "_") + "-" + uuid.uuid4().hex[:8]
    directory = ctx.managed(ctx.local / "backups" / ident, create_parent=True)
    directory.mkdir(mode=0o700)
    backup_app = directory / "app" / app.name
    backup_app.parent.mkdir(mode=0o700)
    # App snapshot is standalone, profile snapshot retains authored links without following them.
    copy_tree(app, backup_app, preserve_links=True)
    shutil.copytree(profile, directory / "profile", symlinks=True)
    registry = directory / "registry"
    registry.mkdir(mode=0o700)
    for name, record in before["registry"].items():
        if record["present"]:
            shutil.copy2(root / name, registry / name)
    assert_stopped([app, profile], ctx.runner)
    if _snapshot(app, root, profile) != before:
        raise DevError("Main app/profile changed while backing up; incomplete backup retained, deployment stopped")
    binary = browser_binary(backup_app)
    _standalone_links(backup_app)
    app_files = tree_inventory(backup_app, allow_links=True)
    profile_files = tree_inventory(directory / "profile", allow_links=True)
    if (app_files != before["app_files"] or profile_files != before["profile_files"]
            or _registry_inventory(registry) != before["registry"]):
        raise DevError("Backup verification failed; deployment stopped")
    if signed_app:
        verify_mac_signature(ctx, backup_app, required=True)
    manifest = {"schema_version": 1, "id": ident, "created_at": utc_now(), "reason": reason,
                "platform": host_platform(), "original_app": str(app), "profile_root": str(root),
                "original_profile": str(profile), "app": str(backup_app),
                "source_sha": source_stamp(backup_app), "binary_sha256": sha256_file(binary),
                "app_files": app_files, "app_tree_sha256": inventory_digest(app_files),
                "app_modes": before["app_modes"], "profile_modes": before["profile_modes"],
                "registry_modes": before["registry_modes"],
                "profile_files": profile_files, "profile_tree_sha256": inventory_digest(profile_files),
                "registry": before["registry"], "candidate_sha": candidate_sha,
                "mac_code_signature_verified": signed_app, "result": "complete"}
    atomic_json(directory / "manifest.json", manifest)
    make_read_only(directory)
    return directory, manifest


def verify_backup(ctx: Context, directory: Path) -> Dict[str, Any]:
    directory = ctx.managed(directory)
    if not directory.is_relative_to(ctx.local / "backups"):
        raise DevError("Rollback input is not a managed backup")
    manifest = read_json(directory / "manifest.json")
    if (manifest.get("schema_version") != 1 or manifest.get("result") != "complete"
            or manifest.get("platform") != host_platform() or manifest.get("id") != directory.name):
        raise DevError("Backup is incomplete or belongs to another host platform")
    if platform.system() != "Windows" and any(path.stat().st_mode & 0o222 for path in [directory, *directory.rglob("*")]
                                               if not path.is_symlink()):
        raise DevError("Backup is not sealed read-only")
    app = ctx.managed(Path(manifest["app"]))
    if not app.is_relative_to(directory / "app"):
        raise DevError("Backup app escapes its snapshot directory")
    binary = browser_binary(app)
    if source_stamp(app) != manifest["source_sha"] or sha256_file(binary) != manifest["binary_sha256"]:
        raise DevError("Backup binary/source stamp changed")
    _standalone_links(app)
    _standalone_links(directory / "profile")
    app_files = tree_inventory(app, allow_links=True)
    profile_files = tree_inventory(directory / "profile", allow_links=True)
    if (app_files != manifest["app_files"] or inventory_digest(app_files) != manifest["app_tree_sha256"]
            or profile_files != manifest["profile_files"]
            or inventory_digest(profile_files) != manifest["profile_tree_sha256"]
            or _registry_inventory(directory / "registry") != manifest["registry"]):
        raise DevError("Backup integrity check failed")
    verify_mac_signature(ctx, app, required=manifest.get("mac_code_signature_verified") is True)
    return manifest


def _writable_copy(source: Path, destination: Path, preserve_links: bool = False) -> None:
    copy_tree(source, destination, preserve_links=preserve_links)
    # Snapshot files are sealed. Restore owner writes without granting extra group/other access.
    for path in [destination, *destination.rglob("*")]:
        if not path.is_symlink():
            os.chmod(path, path.stat().st_mode | 0o200 | (0o100 if path.is_dir() else 0))


def _replace_directory(candidate: Path, target: Path) -> Path:
    previous = target.with_name("." + target.name + ".zen-previous-" + uuid.uuid4().hex[:8])
    no_symlink_ancestors(target)
    os.replace(target, previous)
    try:
        os.replace(candidate, target)
    except BaseException:
        os.replace(previous, target)
        raise
    return previous


def install_main(ctx: Context, args: Any) -> Dict[str, Any]:
    sha = require_sha(args.sha or ctx.sha())
    manifest = verify_artifact(ctx, sha)
    proof = Path(args.compatibility).absolute() if args.compatibility else ctx.local / "compatibility" / (sha + ".json")
    compatibility(ctx, manifest, proof)
    app, root, profile = deployment_paths(ctx, args)
    assert_stopped([app, profile], ctx.runner)
    output = {"action": "install-main", "apply": args.apply, "source_sha": sha,
              "candidate": manifest["bundle"], "app": str(app), "profile": str(profile),
              "profile_root": str(root), "compatibility": str(proof)}
    if not args.apply:
        return output
    with ctx.lock():
        manifest = verify_artifact(ctx, sha)
        compatibility(ctx, manifest, proof)
        assert_stopped([app, profile], ctx.runner)
        backup, old = create_backup(ctx, app, root, profile, "before-install", sha)
        pending = app.with_name("." + app.name + ".zen-next-" + uuid.uuid4().hex[:8])
        _writable_copy(Path(manifest["bundle"]), pending)
        if tree_inventory(pending) != manifest["files"]:
            raise DevError("Candidate changed while copying; existing main app preserved")
        if manifest.get("code_signing", {}).get("verified") is True:
            verify_mac_signature(ctx, pending, required=True)
        assert_stopped([app, profile], ctx.runner)
        previous = _replace_directory(pending, app)
        try:
            if source_stamp(app) != sha or sha256_file(browser_binary(app)) != manifest["binary_sha256"]:
                raise DevError("Installed app read-back differs from candidate")
            if manifest.get("code_signing", {}).get("verified") is True:
                verify_mac_signature(ctx, app, required=True)
            if tree_inventory(profile, allow_links=True) != old["profile_files"] or _registry_inventory(root) != old["registry"]:
                raise DevError("Main profile/registries changed during installation")
        except BaseException:
            rejected = app.with_name("." + app.name + ".zen-rejected-" + uuid.uuid4().hex[:8])
            os.replace(app, rejected)
            os.replace(previous, app)
            raise
        shutil.rmtree(previous)
        output["backup"] = str(backup)
        output["installed_at"] = utc_now()
        atomic_json(ctx.managed(ctx.local / "main-install.json"), output)
    return output


def rollback(ctx: Context, args: Any) -> Dict[str, Any]:
    if args.backup:
        if Path(args.backup).name != args.backup:
            raise DevError("--backup takes a backup ID, not an arbitrary path")
        directory = ctx.managed(ctx.local / "backups" / args.backup)
    else:
        installed = read_json(ctx.managed(ctx.local / "main-install.json"))
        directory = ctx.managed(Path(installed.get("backup", "")))
    original = verify_backup(ctx, directory)
    app = Path(original["original_app"])
    root = Path(original["profile_root"])
    profile = Path(original["original_profile"])
    for path in (app, root, profile):
        no_symlink_ancestors(path)
        if path.resolve().is_relative_to(ctx.local):
            raise DevError("Backup targets cannot point into development state")
    if select_profile(root, str(profile)) != profile or not app.is_dir():
        raise DevError("Original installation/profile registry has changed")
    assert_stopped([app, profile], ctx.runner)
    profile_changed = (tree_inventory(profile, True) != original["profile_files"]
                       or _registry_inventory(root) != original["registry"])
    output = {"action": "rollback", "apply": args.apply, "backup": str(directory),
              "source_sha": original["source_sha"], "app": str(app), "profile": str(profile),
              "restore_profile_snapshot": True, "preserve_current_snapshot": True,
              "profile_changed": profile_changed,
              "requires_restore_profile_snapshot": profile_changed and not args.restore_profile_snapshot}
    if not args.apply:
        return output
    if profile_changed and not args.restore_profile_snapshot:
        raise DevError("Profile evolved after installation. Review the dry-run, then explicitly use --restore-profile-snapshot; current data will be preserved in a separate backup.")
    with ctx.lock():
        original = verify_backup(ctx, directory)
        assert_stopped([app, profile], ctx.runner)
        current_backup, current = create_backup(ctx, app, root, profile, "before-rollback", original["source_sha"])
        if not args.restore_profile_snapshot and (current["profile_files"] != original["profile_files"]
                or current["registry"] != original["registry"]):
            raise DevError("Profile changed during preparation; current snapshot preserved; use --restore-profile-snapshot after review")
        app_pending = app.with_name("." + app.name + ".zen-restore-" + uuid.uuid4().hex[:8])
        profile_pending = profile.with_name("." + profile.name + ".zen-restore-" + uuid.uuid4().hex[:8])
        _writable_copy(Path(original["app"]), app_pending, preserve_links=True)
        _writable_copy(directory / "profile", profile_pending, preserve_links=True)
        _restore_modes(app_pending, original["app_modes"])
        _restore_modes(profile_pending, original["profile_modes"])
        if tree_inventory(app_pending, True) != original["app_files"] or tree_inventory(profile_pending, True) != original["profile_files"]:
            raise DevError("Restored snapshot copy does not match backup; main unchanged")
        verify_mac_signature(ctx, app_pending, required=original.get("mac_code_signature_verified") is True)
        assert_stopped([app, profile], ctx.runner)
        app_previous = _replace_directory(app_pending, app)
        profile_previous = None
        try:
            profile_previous = _replace_directory(profile_pending, profile)
            for name, record in original["registry"].items():
                target = root / name
                if record["present"]:
                    pending = root / ("." + name + ".zen-restore-" + uuid.uuid4().hex[:8])
                    shutil.copy2(directory / "registry" / name, pending)
                    os.chmod(pending, original["registry_modes"][name])
                    os.replace(pending, target)
                else:
                    target.unlink(missing_ok=True)
            if (tree_inventory(app, True) != original["app_files"]
                    or tree_inventory(profile, True) != original["profile_files"]
                    or _registry_inventory(root) != original["registry"]):
                raise DevError("Rollback read-back differs from original snapshot")
            verify_mac_signature(ctx, app, required=original.get("mac_code_signature_verified") is True)
        except BaseException:
            if profile_previous:
                rejected = profile.with_name("." + profile.name + ".zen-rejected-" + uuid.uuid4().hex[:8])
                os.replace(profile, rejected)
                os.replace(profile_previous, profile)
            rejected = app.with_name("." + app.name + ".zen-rejected-" + uuid.uuid4().hex[:8])
            os.replace(app, rejected)
            os.replace(app_previous, app)
            for name, record in current["registry"].items():
                if record["present"]:
                    shutil.copy2(current_backup / "registry" / name, root / name)
                    os.chmod(root / name, current["registry_modes"][name])
                else:
                    (root / name).unlink(missing_ok=True)
            raise
        shutil.rmtree(app_previous)
        if profile_previous:
            shutil.rmtree(profile_previous)
        output["preserved_current_backup"] = str(current_backup)
        output["restored_at"] = utc_now()
        atomic_json(ctx.managed(ctx.local / "rollback.json"), output)
    return output
