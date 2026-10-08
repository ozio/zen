"""Build, package and launch only a dedicated local playground."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from core import (Context, DevError, assert_stopped, atomic_json, browser_binary, copy_tree,
                  build_env, host_platform, inventory_digest, is_link, make_read_only,
                  no_symlink_ancestors, port_available, read_json, require_sha,
                  sha256_file, source_stamp, toolchains, tree_inventory, utc_now, verify_mac_signature)
from download import prefetch_firefox
from imports import prepare_external_overlays

MARKER = "ZEN PLAYGROUND"
MAC_PLAYGROUND_APP = Path("/Applications/Zen Playground.app")
MAC_PLAYGROUND_BUNDLE_ID = "io.ozio.zen.playground"
MAC_PLAYGROUND_ICON = Path("configs/playground-branding/zen-playground.icns")
MAC_PLAYGROUND_ICON_NAME = "zen-playground.icns"
MAC_PLAYGROUND_HANDLER_KEYS = ("CFBundleURLTypes", "CFBundleDocumentTypes", "NSUserActivityTypes")
MAC_LSREGISTER = Path("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
MANAGED_CONFIG = ("# Personal native development build; upstream source remains unchanged.\n"
                  'mk_add_options MOZ_MAKE_FLAGS="-j8"\n'
                  "ac_add_options --disable-debug-symbols\n"
                  "ac_add_options --disable-debug\n"
                  "ac_add_options --enable-optimize\n"
                  "ac_add_options --disable-updater\n")


def surfer(ctx: Context, chain: Dict[str, Any], *args: str) -> list:
    script = ctx.root / "node_modules" / "@zen-browser" / "surfer" / "dist" / "index.js"
    if not script.is_file():
        raise DevError("Surfer is missing; run bootstrap first")
    return [chain["node"]["path"], str(script), *args]


def configure(ctx: Context, chain: Dict[str, Any], env: Dict[str, str], jobs: int) -> None:
    path = ctx.root / "mozconfig"
    no_symlink_ancestors(path)
    if not path.exists():
        path.write_text(MANAGED_CONFIG.replace('"-j8"', '"-j%s"' % jobs), encoding="utf-8")
    elif path.read_text(encoding="utf-8") != MANAGED_CONFIG:
        print("Preserving custom root mozconfig; updater is disabled in the generated engine config.")
    for key, value in [("brand", "release"), ("buildMode", "dev")]:
        ctx.runner.run(surfer(ctx, chain, "set", key, value), ctx.root, env=env)
    generation_env = dict(env, SURFER_MOZCONFIG_ONLY="1")
    log = ctx.managed(ctx.local / "logs" / "configure.log", create_parent=True)
    ctx.runner.logged(surfer(ctx, chain, "build"), ctx.root, generation_env, log)
    generated = ctx.root / "engine" / "mozconfig"
    no_symlink_ancestors(generated)
    with generated.open("a", encoding="utf-8") as output:
        output.write('\n# Isolated local CLI safeguards\nac_add_options --disable-updater\n')
        output.write('export MOZ_SOURCE_REPO=https://github.com/ozio/zen\n')
        output.write('mk_add_options MOZ_MAKE_FLAGS="-j%s"\n' % jobs)
        if shutil.which("sccache", path=env["PATH"]):
            output.write("ac_add_options --with-ccache=sccache\n")


def bootstrap(ctx: Context, args: Any) -> Dict[str, Any]:
    chain = toolchains(ctx)
    env = build_env(ctx, chain)
    for path in (ctx.root / "engine", ctx.root / "node_modules", ctx.root / ".surfer"):
        no_symlink_ancestors(path)
    engine = ctx.root / "engine"
    if not args.skip_engine and engine.is_dir() and any(engine.iterdir()) and not (engine / "toolkit" / "moz.build").is_file():
        raise DevError("Nonempty engine is incomplete; preserve/inspect it before retrying source extraction")
    reserve = getattr(args, "disk_reserve_gib", 15)
    native_incremental = getattr(args, "native_incremental", False)
    if native_incremental and (args.skip_engine or not args.skip_system_bootstrap):
        raise DevError("--native-incremental import requires an existing engine and --skip-system-bootstrap")
    baseline = incremental_disk_baseline(ctx, chain, reserve, native_incremental=native_incremental)
    ctx.free_space(reserve * 1024 ** 3)
    if platform.system() == "Darwin" and not args.skip_engine and not shutil.which("gtar", path=env["PATH"]):
        raise DevError("Surfer extraction requires GNU tar (gtar) on macOS. Install gnu-tar first.")
    node = Path(chain["node"]["path"])
    npm = node.parent.parent / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if platform.system() == "Windows":
        npm = node.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if not npm.is_file():
        raise DevError("Managed Node does not include npm-cli.js: %s" % npm)
    with ctx.lock():
        ctx.runner.logged([str(node), str(npm), "ci"], ctx.root, env,
                          ctx.managed(ctx.local / "logs" / "npm-ci.log", create_parent=True))
        if not args.skip_engine:
            for key, value in [("brand", "release"), ("buildMode", "dev")]:
                ctx.runner.run(surfer(ctx, chain, "set", key, value), ctx.root, env=env)
            env.pop("SURFER_FORCE_CANDIDATE", None)
            source_download = prefetch_firefox(ctx)
            ctx.runner.logged([str(node), str(npm), "run", "download"], ctx.root, env,
                              ctx.managed(ctx.local / "logs" / "download.log"))
            if not args.skip_system_bootstrap:
                ctx.runner.logged([chain["python"]["path"], str(ctx.root / "engine" / "mach"),
                                   "--no-interactive", "bootstrap", "--application-choice=browser"],
                                  ctx.root / "engine", env,
                                  ctx.managed(ctx.local / "logs" / "bootstrap.log"))
            import_preparation = prepare_external_overlays(ctx, env)
            ctx.runner.logged([str(node), str(npm), "run", "import"], ctx.root, env,
                              ctx.managed(ctx.local / "logs" / "import.log"))
            # The upstream all-languages shell script mutates global Git and ~/tools.
            # A native baseline needs only the checked-in en-US files in this engine.
            locale_source = ctx.root / "locales" / "en-US" / "browser"
            locale_target = ctx.root / "engine" / "browser" / "locales" / "en-US"
            no_symlink_ancestors(locale_source)
            no_symlink_ancestors(locale_target)
            if not locale_source.is_dir():
                raise DevError("Checked-in en-US locale source is missing")
            shutil.copytree(locale_source, locale_target, dirs_exist_ok=True)
            configure(ctx, chain, env, 8)
        receipt = {"schema_version": 1, "created_at": utc_now(), "source_sha": ctx.sha(),
                   "toolchains": chain, "engine": not args.skip_engine,
                   "disk_reserve_gib": reserve, "incremental_native_baseline": baseline,
                   "native_incremental": native_incremental,
                   "system_bootstrap": not args.skip_engine and not args.skip_system_bootstrap}
        if not args.skip_engine:
            receipt["source_download"] = source_download
            receipt["import_preparation"] = import_preparation
        atomic_json(ctx.managed(ctx.local / "bootstrap.json"), receipt)
    return receipt


def native_object_dirs(ctx: Context) -> list:
    candidates = []
    for obj in (ctx.root / "engine").glob("obj-*"):
        no_symlink_ancestors(obj)
        if not obj.is_dir() or not (obj / "config.status").is_file():
            continue
        binaries = [obj / "dist" / "bin" / name for name in ("zen", "zen.exe", "firefox", "firefox.exe")]
        bundles = list((obj / "dist").glob("*.app"))
        if any(path.is_file() for path in binaries) or any(path.is_dir() for path in bundles):
            candidates.append(str(obj.absolute()))
    return sorted(candidates)


def require_prior_native_build(ctx: Context) -> None:
    objects = native_object_dirs(ctx)
    for path in (ctx.local / "builds").glob("*/build.json"):
        ctx.managed(path)
        receipt = read_json(path)
        if (receipt.get("result") == "pass" and receipt.get("ui_only") is False
                and receipt.get("platform") == host_platform()
                and receipt.get("engine") == str(ctx.root / "engine")
                and objects and receipt.get("object_dirs") == objects):
            return
    raise DevError("--ui needs a prior successful full CLI build on this host and existing native object tree")


def incremental_disk_baseline(ctx: Context, chain: Dict[str, Any], reserve: int,
                              *, native_incremental: bool = False) -> Optional[str]:
    """A lower explicit reserve is allowed only for a native-compatible rebuild.

    It still runs the full mach build. Native source/preferences/configuration
    changes, tool changes and an unprepared tree retain the normal 15 GiB floor.
    An explicit macOS-only exception permits the three Cocoa window/router
    files with >=8 GiB and a full matching object tree. Build still runs full
    mach dependency analysis; IDL, Rust, prefs, configuration and other native
    targets are refused, rather than guessing their compilation footprint.
    """
    if not 4 <= reserve <= 1024:
        raise DevError("Build disk reserve must be between 4 and 1024 GiB")
    if native_incremental and (reserve < 8 or host_platform()["system"] != "Darwin"):
        raise DevError("Cocoa incremental mode requires macOS and at least 8 GiB")
    if reserve >= 15:
        return None
    if ctx.snapshot()["status"]:
        raise DevError("A reduced reserve requires clean, committed source")
    objects = native_object_dirs(ctx)
    config = ctx.root / "engine" / "mozconfig"
    if not objects or not config.is_file():
        raise DevError("A reduced reserve requires an existing native build")
    roots = ("src", "prefs", "configs", "surfer.json", ".nvmrc", ".rust-toolchain",
             ".python-version", "package.json", "package-lock.json")
    ui_suffixes = (".js", ".mjs", ".css", ".ftl", ".html", ".xhtml", ".svg")
    cocoa_targets = {"widget/cocoa/nsCocoaWindow.h", "widget/cocoa/nsCocoaWindow.mm",
                     "widget/cocoa/nsAppShell.mm"}
    for path in sorted((ctx.local / "builds").glob("*/build.json"),
                       key=lambda p:p.stat().st_mtime, reverse=True):
        ctx.managed(path)
        receipt = read_json(path)
        if not (receipt.get("result") == "pass" and receipt.get("ui_only") is False
                and receipt.get("source_snapshot", {}).get("status") == ""
                and receipt.get("platform") == host_platform()
                and receipt.get("engine") == str(ctx.root / "engine")
                and receipt.get("object_dirs") == objects
                and receipt.get("toolchains") == chain
                and receipt.get("mozconfig_sha256") == sha256_file(config)):
            continue
        sha = require_sha(receipt.get("source_sha"))
        result = ctx.git("diff", "--name-only", sha, "HEAD", "--", *roots, check=False)
        if result.returncode:
            continue
        compatible = True
        for name in result.stdout.splitlines():
            source = ctx.root / name
            if not name.startswith("src/") or not source.is_file():
                compatible = False
                break
            if source.suffix == ".patch":
                targets = re.findall(r"^\+\+\+ b/(.+)$", source.read_text(), re.MULTILINE)
                if not targets or not all(t.endswith(ui_suffixes) or
                                          (native_incremental and t in cocoa_targets)
                                          for t in targets):
                    compatible = False
                    break
            elif not name.endswith(ui_suffixes):
                compatible = False
                break
        if compatible:
            return sha
    raise DevError("A reduced reserve needs a successful matching full build with unchanged native inputs; use 15 GiB")


def build(ctx: Context, args: Any) -> Dict[str, Any]:
    if not 1 <= args.jobs <= 128:
        raise DevError("Build jobs must be between 1 and 128")
    native_incremental = getattr(args, "native_incremental", False)
    if native_incremental and (args.ui or args.jobs > 2):
        raise DevError("Cocoa incremental mode requires a full mach build with at most 2 jobs")
    chain = toolchains(ctx)
    env = build_env(ctx, chain)
    reserve = getattr(args, "disk_reserve_gib", 15)
    baseline = incremental_disk_baseline(ctx, chain, reserve, native_incremental=native_incremental)
    if native_incremental:
        env["SCCACHE_CACHE_SIZE"] = "128M"
    ctx.free_space(reserve * 1024 ** 3)
    mach = ctx.root / "engine" / "mach"
    no_symlink_ancestors(mach)
    if not mach.is_file():
        raise DevError("engine/mach is missing; run bootstrap first")
    with ctx.lock():
        if args.ui:
            require_prior_native_build(ctx)
        before = ctx.snapshot()
        configure(ctx, chain, env, args.jobs)
        argv = [chain["python"]["path"], str(mach), "build"]
        if args.ui:
            argv.append("faster")
        argv.append("-j%s" % args.jobs)
        path = ctx.managed(ctx.local / "logs" / ("build-ui.log" if args.ui else "build.log"), create_parent=True)
        ctx.runner.logged(argv, ctx.root / "engine", env, path)
        ctx.assert_snapshot(before)
        objects = native_object_dirs(ctx)
        if not objects:
            raise DevError("Build command exited successfully without a native object tree/binary; no build receipt recorded")
        receipt = {"schema_version": 1, "result": "pass", "created_at": utc_now(),
                   "source_sha": before["source_sha"], "source_snapshot": before,
                   "ui_only": args.ui, "platform": host_platform(), "toolchains": chain,
                   "engine": str(ctx.root / "engine"), "object_dirs": objects,
                   "mozconfig_sha256": sha256_file(ctx.root / "engine" / "mozconfig"),
                   "disk_reserve_gib": reserve, "incremental_native_baseline": baseline,
                   "native_incremental": native_incremental,
                   "log": str(path)}
        name = "ui.json" if args.ui else "build.json"
        atomic_json(ctx.managed(ctx.local / "builds" / before["source_sha"] / name), receipt)
    return receipt


def discover_bundle(ctx: Context) -> Path:
    engine = ctx.root / "engine"
    candidates = []
    for obj in sorted(engine.glob("obj-*")):
        dist = obj / "dist"
        candidates.extend(path for path in dist.glob("*.app") if path.is_dir())
        for name in ("zen", "firefox"):
            path = dist / name
            if path.is_dir() and (path / (name + (".exe" if platform.system() == "Windows" else ""))).is_file():
                candidates.append(path)
    if len(candidates) != 1:
        raise DevError("Expected one built bundle, found %s. Select it with --bundle PATH." % len(candidates))
    return candidates[0]


def verify_artifact(ctx: Context, sha: str) -> Dict[str, Any]:
    sha = require_sha(sha)
    root = ctx.managed(ctx.local / "artifacts" / sha)
    manifest_path = ctx.managed(root / "manifest.json")
    manifest = read_json(manifest_path)
    if manifest.get("schema_version") != 1 or manifest.get("source_sha") != sha:
        raise DevError("Artifact source stamp/schema mismatch")
    if manifest.get("variant", "main") != "main":
        raise DevError("Main artifact cannot be a Playground variant")
    bundle = ctx.managed(Path(manifest.get("bundle", "")))
    binary = ctx.managed(Path(manifest.get("binary", "")))
    if not bundle.is_relative_to(root / "bundle") or not binary.is_relative_to(bundle):
        raise DevError("Artifact paths escape their immutable SHA directory")
    if str(browser_binary(bundle)) != str(binary) or source_stamp(bundle) != sha:
        raise DevError("Artifact binary/source stamp differs from its manifest")
    files = tree_inventory(bundle)
    if files != manifest.get("files") or inventory_digest(files) != manifest.get("tree_sha256"):
        raise DevError("Immutable artifact files changed")
    if sha256_file(binary) != manifest.get("binary_sha256"):
        raise DevError("Immutable binary changed")
    if manifest.get("platform") != host_platform():
        raise DevError("Artifact was built for a different host platform")
    # POSIX write bits reveal accidental mutation even if contents happen to match.
    if platform.system() != "Windows" and any(path.stat().st_mode & 0o222 for path in [root, *root.rglob("*")]):
        raise DevError("Artifact has writable files; expected a sealed standalone package")
    signing = manifest.get("code_signing", {})
    if not isinstance(signing, dict):
        raise DevError("Artifact signing metadata must be a dictionary")
    if signing.get("verified") is True:
        verify_mac_signature(ctx, bundle, required=True)
    return manifest


def playground_artifact_path(ctx: Context, sha: str) -> Path:
    return ctx.managed(ctx.local / "playground-artifacts" / require_sha(sha) / "manifest.json")


def _playground_signing(base: Dict[str, Any]) -> Dict[str, Any]:
    signing = base.get("code_signing", {})
    identity = signing.get("identity") if isinstance(signing, dict) else None
    if (not isinstance(identity, str) or (identity != "-" and not re.fullmatch(r"[0-9a-fA-F]{40}", identity))
            or signing.get("verified") is not True
            or signing.get("kind") != ("ad-hoc" if identity == "-" else "certificate")):
        raise DevError("Playground derivation needs the base package's verified exact macOS signing identity")
    # No identity selection at this step: reuse only the choice made for the base.
    return dict(signing, notarized=False)


def _playground_plist(bundle: Path) -> Dict[str, Any]:
    try:
        value = plistlib.loads((bundle / "Contents" / "Info.plist").read_bytes())
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        raise DevError("Playground package has an invalid Info.plist") from error
    if not isinstance(value, dict):
        raise DevError("Playground Info.plist must be a dictionary")
    return value


def _require_main_bundle_identity(bundle: Path) -> None:
    identifier = _playground_plist(bundle).get("CFBundleIdentifier")
    if not isinstance(identifier, str) or not identifier or identifier == MAC_PLAYGROUND_BUNDLE_ID:
        raise DevError("Playground must derive from a separately identified main package")


def _validate_playground_icon(data: bytes) -> None:
    if len(data) <= 8 or data[:4] != b"icns" or int.from_bytes(data[4:8], "big") != len(data):
        raise DevError("Playground icon must be a complete macOS .icns asset")
    offset = 8
    image_found = False
    while offset < len(data):
        if len(data) - offset < 8:
            raise DevError("Playground icon has a truncated .icns record")
        record_type = data[offset:offset + 4]
        length = int.from_bytes(data[offset + 4:offset + 8], "big")
        if length <= 8 or offset + length > len(data):
            raise DevError("Playground icon has an invalid .icns record length")
        # The supplied iconutil asset contains PNG and ARGB representations.
        if record_type in (b"ic04", b"ic05", b"ic07", b"ic08", b"ic09", b"ic10",
                           b"ic11", b"ic12", b"ic13", b"ic14", b"icp4", b"icp5", b"icp6"):
            image_found = True
        offset += length
    if not image_found:
        raise DevError("Playground .icns asset contains no application icon representations")


def _verify_playground_branding(bundle: Path, branding: Dict[str, Any]) -> None:
    if not isinstance(branding, dict):
        raise DevError("Playground branding receipt is missing")
    info = _playground_plist(bundle)
    expected = {"CFBundleIdentifier": MAC_PLAYGROUND_BUNDLE_ID,
                "CFBundleName": "Zen Playground", "CFBundleDisplayName": "Zen Playground",
                "CFBundleIconFile": MAC_PLAYGROUND_ICON_NAME}
    if any(info.get(key) != value for key, value in expected.items()):
        raise DevError("Playground application identity/icon differs from its variant")
    if any(key in info for key in MAC_PLAYGROUND_HANDLER_KEYS):
        raise DevError("Playground must not register URL, document or user activity handlers")
    if "CFBundleIconName" in info:
        raise DevError("Playground must use its dedicated icon file instead of a named asset catalog icon")
    if branding.get("bundle_id") != MAC_PLAYGROUND_BUNDLE_ID or branding.get("bundle_name") != "Zen Playground":
        raise DevError("Playground branding receipt identity differs")
    icon = bundle / "Contents" / "Resources" / MAC_PLAYGROUND_ICON_NAME
    if not icon.is_file() or sha256_file(icon) != branding.get("icon_sha256"):
        raise DevError("Playground icon differs from the sealed branding receipt")
    _validate_playground_icon(icon.read_bytes())


def verify_playground_artifact(ctx: Context, sha: str) -> Dict[str, Any]:
    """Verify the separately sealed macOS variant and its immutable main origin."""
    if platform.system() != "Darwin":
        raise DevError("Playground application branding is supported only on macOS")
    sha = require_sha(sha)
    base = verify_artifact(ctx, sha)
    _require_main_bundle_identity(Path(base["bundle"]))
    path = playground_artifact_path(ctx, sha)
    root = path.parent
    manifest = read_json(path)
    expected = {"schema_version": 1, "variant": "playground", "source_sha": sha,
                "base_artifact_manifest": str(ctx.local / "artifacts" / sha / "manifest.json"),
                "base_binary_sha256": base["binary_sha256"], "base_tree_sha256": base["tree_sha256"],
                "platform": host_platform(), "code_signing": _playground_signing(base)}
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise DevError("Playground variant provenance/signing differs from its verified main artifact")
    bundle = ctx.managed(Path(manifest.get("bundle", "")))
    binary = ctx.managed(Path(manifest.get("binary", "")))
    if bundle != root / "bundle" / "Zen Playground.app" or not binary.is_relative_to(bundle):
        raise DevError("Playground artifact paths escape their immutable SHA directory")
    if browser_binary(bundle) != binary or source_stamp(bundle) != sha:
        raise DevError("Playground binary/source stamp differs from its manifest")
    files = tree_inventory(bundle)
    if files != manifest.get("files") or inventory_digest(files) != manifest.get("tree_sha256"):
        raise DevError("Immutable Playground artifact files changed")
    if sha256_file(binary) != manifest.get("binary_sha256"):
        raise DevError("Immutable Playground binary changed")
    if any(item.stat().st_mode & 0o222 for item in [root, *root.rglob("*")]):
        raise DevError("Playground artifact has writable files; expected a sealed standalone package")
    branding = manifest.get("branding", {})
    if not isinstance(branding, dict) or branding.get("icon_source") != str(ctx.root / MAC_PLAYGROUND_ICON):
        raise DevError("Playground branding source is not this checkout's dedicated icon")
    _verify_playground_branding(bundle, branding)
    if list(bundle.rglob(".purgecaches")):
        raise DevError("Playground package contains consumable Gecko cache sentinels")
    verify_mac_signature(ctx, bundle, required=True)
    return manifest


def prepare_playground_artifact(ctx: Context, sha: str) -> Dict[str, Any]:
    """Derive once from a verified main app. Caller owns the operation lock."""
    if platform.system() != "Darwin":
        raise DevError("Playground application branding is supported only on macOS")
    sha = require_sha(sha)
    base = verify_artifact(ctx, sha)
    _require_main_bundle_identity(Path(base["bundle"]))
    signing = _playground_signing(base)
    icon = ctx.root / MAC_PLAYGROUND_ICON
    no_symlink_ancestors(icon)
    if not icon.is_file():
        raise DevError("Playground icon is missing: %s" % icon)
    icon_bytes = icon.read_bytes()
    _validate_playground_icon(icon_bytes)
    icon_digest = hashlib.sha256(icon_bytes).hexdigest()
    final = playground_artifact_path(ctx, sha).parent
    if final.exists():
        existing = verify_playground_artifact(ctx, sha)
        if existing["branding"]["icon_sha256"] != icon_digest:
            raise DevError("An immutable Playground artifact with a different icon exists for this SHA")
        return existing
    ctx.free_space(2 * 1024 ** 3)
    pending = ctx.managed(final.with_name(".pending-" + uuid.uuid4().hex), create_parent=True)
    target = pending / "bundle" / "Zen Playground.app"
    target.parent.mkdir(parents=True, mode=0o700)
    copy_tree(Path(base["bundle"]), target)
    if tree_inventory(target) != base["files"]:
        raise DevError("Playground base copy is incomplete; pending app retained for inspection")
    verify_mac_signature(ctx, target, required=True)
    for item in [target, *target.rglob("*")]:
        if not is_link(item):
            os.chmod(item, item.stat().st_mode | 0o200 | (0o100 if item.is_dir() else 0))
    info = _playground_plist(target)
    info.update(CFBundleIdentifier=MAC_PLAYGROUND_BUNDLE_ID, CFBundleName="Zen Playground",
                CFBundleDisplayName="Zen Playground", CFBundleIconFile=MAC_PLAYGROUND_ICON_NAME)
    for key in MAC_PLAYGROUND_HANDLER_KEYS:
        info.pop(key, None)
    info.pop("CFBundleIconName", None)
    (target / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info, sort_keys=False))
    (target / "Contents" / "Resources" / MAC_PLAYGROUND_ICON_NAME).write_bytes(icon_bytes)
    for sentinel in target.rglob(".purgecaches"):
        sentinel.unlink()
    # Keep nested entitlements and hardened-runtime flags, but let the designated
    # requirement use the new bundle ID instead of inheriting the main app's ID.
    ctx.runner.run(["/usr/bin/codesign", "--force", "--deep", "--preserve-metadata=entitlements,flags,runtime",
                    "--sign", signing["identity"], str(target)], ctx.root)
    verify_mac_signature(ctx, target, required=True)
    branding = {"bundle_id": MAC_PLAYGROUND_BUNDLE_ID, "bundle_name": "Zen Playground",
                "icon_source": str(icon), "icon_sha256": icon_digest}
    _verify_playground_branding(target, branding)
    binary = browser_binary(target)
    records = tree_inventory(target)
    manifest = {"schema_version": 1, "variant": "playground", "source_sha": sha,
                "created_at": utc_now(), "platform": host_platform(),
                "base_artifact_manifest": str(ctx.local / "artifacts" / sha / "manifest.json"),
                "base_binary_sha256": base["binary_sha256"], "base_tree_sha256": base["tree_sha256"],
                "bundle": str(final / "bundle" / target.name),
                "binary": str(final / binary.relative_to(pending)),
                "binary_sha256": sha256_file(binary), "tree_sha256": inventory_digest(records),
                "files": records, "code_signing": signing, "branding": branding,
                "updater_disabled": base.get("updater_disabled") is True}
    # Read back the immutable base again before publishing the derivative.
    if verify_artifact(ctx, sha) != base:
        raise DevError("Main artifact changed during Playground packaging; pending variant retained")
    atomic_json(pending / "manifest.json", manifest)
    make_read_only(pending)
    os.replace(pending, final)
    return verify_playground_artifact(ctx, sha)


def package_playground(ctx: Context, args: Any) -> Dict[str, Any]:
    if platform.system() != "Darwin":
        raise DevError("Playground application branding is supported only on macOS")
    with ctx.lock():
        return prepare_playground_artifact(ctx, require_sha(args.sha or ctx.sha()))


def package(ctx: Context, args: Any) -> Dict[str, Any]:
    chain = toolchains(ctx)
    env = build_env(ctx, chain)
    signing_identity = getattr(args, "signing_identity", None)
    if signing_identity is not None and platform.system() != "Darwin":
        raise DevError("--signing-identity is a macOS option")
    if platform.system() == "Darwin":
        signing_identity = signing_identity or "-"
        if signing_identity != "-" and not re.fullmatch(r"[0-9a-fA-F]{40}", signing_identity):
            raise DevError("Select an exact 40-character certificate fingerprint, or '-' for local ad hoc signing")
    ctx.free_space(2 * 1024 ** 3)
    with ctx.lock():
        before = ctx.snapshot()
        sha = before["source_sha"]
        if before["status"]:
            raise DevError("Commit all nonignored source changes/new files before publishing an immutable SHA artifact")
        build_path = ctx.managed(ctx.local / "builds" / sha / "build.json")
        build_receipt = read_json(build_path)
        if (build_receipt.get("result") != "pass" or build_receipt.get("ui_only") is not False
                or build_receipt.get("source_sha") != sha
                or build_receipt.get("source_snapshot", {}).get("tracked_diff_sha256") != before["tracked_diff_sha256"]):
            raise DevError("Package needs a successful full build of the exact committed source")
        final = ctx.managed(ctx.local / "artifacts" / sha)
        if final.exists():
            existing = verify_artifact(ctx, sha)
            if platform.system() == "Darwin" and existing.get("code_signing", {}).get("identity") != signing_identity:
                raise DevError("An immutable artifact with different signing already exists for this source SHA; preserve it before preparing a distinct candidate")
            return existing
        bundle = Path(args.bundle).absolute() if args.bundle else discover_bundle(ctx)
        if not bundle.resolve().is_relative_to((ctx.root / "engine").resolve()):
            raise DevError("Package input must be this checkout's built engine bundle")
        # Avoid release MAR/signing scripts: ordinary mach package produces the standalone distribution.
        ctx.runner.logged([chain["python"]["path"], str(ctx.root / "engine" / "mach"), "package"],
                          ctx.root / "engine", env,
                          ctx.managed(ctx.local / "logs" / "package.log", create_parent=True))
        ctx.assert_snapshot(before)
        pending = ctx.managed(ctx.local / "artifacts" / (".pending-" + uuid.uuid4().hex), create_parent=True)
        target = pending / "bundle" / bundle.name
        target.parent.mkdir(parents=True, mode=0o700)
        # Developer dist bundles use symlinks into the object/source tree. Materialize every file.
        shutil.copytree(bundle, target, symlinks=False)
        # Gecko consumes these development sentinels at startup. Signing them as
        # resources would invalidate a writable installed app's signature on launch.
        if platform.system() == "Darwin":
            for sentinel in target.rglob(".purgecaches"):
                sentinel.unlink()
        binary = browser_binary(target)
        if source_stamp(target) != sha:
            raise DevError("Built bundle SourceStamp is not current source SHA; artifact left pending")
        signing = None
        if platform.system() == "Darwin":
            # Seal the materialized distribution, not symlinks into the build tree.
            # Ad hoc signing uses no private key and makes no notarization claim.
            ctx.runner.run(["codesign", "--force", "--deep", "--sign", signing_identity, str(target)], ctx.root, env=env)
            ctx.runner.run(["codesign", "--verify", "--deep", "--strict", str(target)], ctx.root, env=env)
            signing = {"identity":signing_identity, "kind":"ad-hoc" if signing_identity == "-" else "certificate",
                       "verification":"codesign --verify --deep --strict", "verified":True, "notarized":False}
        records = tree_inventory(target)
        manifest = {"schema_version": 1, "source_sha": sha, "created_at": utc_now(),
                    "platform": host_platform(), "bundle": str(final / "bundle" / bundle.name),
                    "binary": str(final / binary.relative_to(pending)),
                    "binary_sha256": sha256_file(binary), "tree_sha256": inventory_digest(records),
                    "files": records, "build_receipt": str(build_path), "updater_disabled": True}
        if signing:
            manifest["code_signing"] = signing
        atomic_json(pending / "manifest.json", manifest)
        make_read_only(pending)
        os.replace(pending, final)
        return verify_artifact(ctx, sha)


def playground_state(ctx: Context) -> Optional[Dict[str, Any]]:
    path = ctx.managed(ctx.local / "state.json")
    if not path.exists():
        return None
    state = read_json(path)
    if state.get("schema_version") != 1 or not isinstance(state.get("playground"), dict):
        raise DevError("Unknown playground state schema")
    value = state["playground"]
    if value.get("profile") != str(ctx.local / "profiles" / "playground"):
        raise DevError("Receipt profile is not this checkout's clean playground")
    return value


def validate_profile(ctx: Context, existing_required: bool = False) -> Path:
    profile = ctx.managed(ctx.local / "profiles" / "playground")
    marker = profile / "zen-playground.json"
    if profile.exists():
        ctx.managed(marker)
        data = read_json(marker)
        if data.get("schema_version") != 1 or data.get("marker") != MARKER or data.get("root") != str(ctx.root):
            raise DevError("Directory is not a recognized clean playground profile")
    elif existing_required:
        raise DevError("Playground does not exist")
    return profile


def launch_argv(binary: Path, profile: Path, home: Path) -> list:
    return [str(binary), "--no-remote", "--profile", str(profile), "--marionette",
            "--remote-allow-system-access", "--new-window", home.as_uri()]


def _playground_provenance(ctx: Context, manifest: Dict[str, Any]) -> Dict[str, Any]:
    return {"variant": "playground", "artifact_manifest": str(playground_artifact_path(ctx, manifest["source_sha"])),
            "base_artifact_manifest": manifest["base_artifact_manifest"],
            "base_binary_sha256": manifest["base_binary_sha256"], "base_tree_sha256": manifest["base_tree_sha256"],
            "binary_sha256": manifest["binary_sha256"], "tree_sha256": manifest["tree_sha256"],
            "code_signing": manifest["code_signing"]}


def _register_mac_playground(ctx: Context, target: Path, register: bool) -> None:
    # Scope LaunchServices changes to the already verified secondary application.
    # Never reset its database or change any user's default-handler selection.
    if target != MAC_PLAYGROUND_APP:
        raise DevError("LaunchServices registration target is not the owned Playground app")
    ctx.runner.run([str(MAC_LSREGISTER), "-f" if register else "-u", str(target)], ctx.root)


def stage_mac_playground(ctx: Context, manifest: Dict[str, Any]) -> Dict[str, str]:
    """Install only the verified variant, or migrate an owned legacy main copy."""
    sha = require_sha(manifest.get("source_sha"))
    verified = verify_playground_artifact(ctx, sha)
    if manifest != verified:
        raise DevError("Playground staging input differs from its sealed variant manifest")
    target = MAC_PLAYGROUND_APP
    no_symlink_ancestors(target)
    assert_stopped([target], ctx.runner)
    current = ctx.managed(ctx.local / "deployments" / "playground" / "current.json", create_parent=True)
    receipt_path = current.with_name(sha + ".json")
    binary = target / Path(manifest["binary"]).relative_to(Path(manifest["bundle"]))
    old_receipt = None
    old = None
    if target.exists():
        if not current.is_file():
            raise DevError("Existing Zen Playground.app has no ownership receipt; refusing to replace it")
        old_receipt = read_json(current)
        if (old_receipt.get("root") != str(ctx.root) or old_receipt.get("bundle") != str(target)
                or old_receipt.get("binary") != str(binary)):
            raise DevError("Existing playground application belongs to another checkout")
        old_sha = require_sha(old_receipt.get("source_sha"))
        if old_receipt.get("variant") == "playground":
            old = verify_playground_artifact(ctx, old_sha)
            expected = _playground_provenance(ctx, old)
        elif "variant" not in old_receipt:
            old = verify_artifact(ctx, old_sha)
            expected = {"artifact_manifest": str(ctx.local / "artifacts" / old_sha / "manifest.json"),
                        "binary_sha256": old["binary_sha256"], "tree_sha256": old["tree_sha256"]}
        else:
            raise DevError("Unknown Playground deployment variant")
        if (old_receipt.get("schema_version") != 1
                or any(old_receipt.get(key) != value for key, value in expected.items())):
            raise DevError("Existing playground ownership receipt differs from its artifact")
        if tree_inventory(target) != old["files"] or sha256_file(binary) != old["binary_sha256"]:
            raise DevError("Existing playground app differs from its owned artifact; preserve and inspect it")
        if old.get("code_signing", {}).get("verified") is True:
            verify_mac_signature(ctx, target, required=True)
        if old["source_sha"] == sha and old_receipt.get("variant") == "playground":
            if not receipt_path.is_file() or read_json(receipt_path) != old_receipt:
                raise DevError("Playground deployment receipt is inconsistent")
            _register_mac_playground(ctx, target, register=True)
            return {"binary":str(binary), "bundle":str(target), "deployment_manifest":str(receipt_path)}
    if not os.access(target.parent, os.W_OK):
        raise DevError("Applications folder is not writable. Use run playground --in-artifact; Enpass may require an Applications-folder installation.")
    pending = target.with_name(".zen-playground-pending-" + uuid.uuid4().hex + ".app")
    previous = target.with_name(".zen-playground-previous-" + uuid.uuid4().hex + ".app")
    copy_tree(Path(manifest["bundle"]), pending)
    if tree_inventory(pending) != manifest["files"]:
        raise DevError("Secondary playground copy is incomplete; pending app retained for inspection")
    verify_mac_signature(ctx, pending, required=True)
    moved_old = False
    moved_new = False
    old_unregistered = False
    new_registration_attempted = False
    try:
        assert_stopped([target], ctx.runner)
        if old_receipt is None:
            if target.exists():
                raise DevError("An unowned Playground application appeared during copying; preserving it")
        elif (not target.is_dir() or read_json(current) != old_receipt
              or tree_inventory(target) != old["files"]):
            raise DevError("Owned Playground app or receipt changed during copying; preserving it")
        elif old.get("code_signing", {}).get("verified") is True:
            verify_mac_signature(ctx, target, required=True)
        if target.exists():
            old_unregistered = True
            _register_mac_playground(ctx, target, register=False)
            os.replace(target, previous)
            moved_old = True
        os.replace(pending, target)
        moved_new = True
        if (source_stamp(target) != sha or sha256_file(binary) != manifest["binary_sha256"]
                or tree_inventory(target) != manifest["files"]):
            raise DevError("Secondary application identity mismatch")
        _verify_playground_branding(target, manifest["branding"])
        verify_mac_signature(ctx, target, required=True)
        new_registration_attempted = True
        _register_mac_playground(ctx, target, register=True)
        receipt = {"schema_version":1, "root":str(ctx.root), "source_sha":sha,
                   "bundle":str(target), "binary":str(binary), "created_at":utc_now(),
                   **_playground_provenance(ctx, manifest)}
        atomic_json(ctx.managed(receipt_path), receipt)
        atomic_json(current, receipt)
    except BaseException as error:
        registration_errors = []
        if moved_new and target.exists():
            if new_registration_attempted:
                try:
                    _register_mac_playground(ctx, target, register=False)
                except DevError as registration_error:
                    registration_errors.append(str(registration_error))
            os.replace(target, pending)
        if moved_old:
            os.replace(previous, target)
        if old_unregistered and target.exists():
            try:
                _register_mac_playground(ctx, target, register=True)
            except DevError as registration_error:
                registration_errors.append(str(registration_error))
        if registration_errors:
            raise DevError("Playground staging failed and restored files, but LaunchServices recovery failed: %s" %
                           "; ".join(registration_errors)) from error
        raise
    if moved_old:
        # This exact old copy was verified above; the immutable source is kept.
        for path in [previous, *previous.rglob("*")]:
            if not is_link(path):
                os.chmod(path, path.stat().st_mode | 0o200)
        shutil.rmtree(previous)
    return {"binary":str(binary), "bundle":str(target), "deployment_manifest":str(receipt_path)}


def run_playground(ctx: Context, args: Any) -> Dict[str, Any]:
    with ctx.lock():
        sha = require_sha(args.sha or ctx.sha())
        manifest = (prepare_playground_artifact(ctx, sha) if platform.system() == "Darwin"
                    else verify_artifact(ctx, sha))
        profile = validate_profile(ctx)
        previous = playground_state(ctx)
        assert_stopped([profile, Path(manifest["binary"])], ctx.runner, previous)
        port_available(args.port)
        deployment = None
        if platform.system() == "Darwin" and not getattr(args, "in_artifact", False):
            deployment = stage_mac_playground(ctx, manifest)
        binary = Path(deployment["binary"] if deployment else manifest["binary"])
        profile.mkdir(parents=True, exist_ok=True, mode=0o700)
        session = str(uuid.uuid4())
        atomic_json(profile / "zen-playground.json", {"schema_version": 1, "marker": MARKER,
                                                     "root": str(ctx.root), "session_id": session})
        prefs = {"marionette.enabled": True, "marionette.port": args.port,
                 "marionette.host": "127.0.0.1", "marionette.debugging.clicktostart": False,
                 "remote.allowSystemAccess": True, "zen.playground.marker": MARKER,
                 "zen.playground.session_id": session, "app.update.auto": False,
                 "app.update.enabled": False, "browser.shell.checkDefaultBrowser": False,
                 "browser.startup.homepage_override.mstone": "ignore",
                 "browser.startup.homepage": "about:blank", "datareporting.policy.dataSubmissionEnabled": False}
        userjs = profile / "user.js"
        ctx.managed(userjs)
        userjs.write_text("// Managed clean playground; never point this at a personal profile.\n" +
                          "".join("user_pref(%s, %s);\n" % (json.dumps(key), json.dumps(value))
                                  for key, value in prefs.items()), encoding="utf-8")
        home = ctx.managed(ctx.local / "playground.html")
        home.write_text('<!doctype html><meta charset="utf-8"><title>ZEN PLAYGROUND — %s</title>'
                        '<style>body{font:20px system-ui;background:#172130;color:#e8f0ff;padding:3rem}</style>'
                        '<h1>ZEN PLAYGROUND</h1><p>Fresh isolated profile. Source %s.</p>' % (sha[:12], sha),
                        encoding="utf-8")
        log = ctx.managed(ctx.local / "logs" / "playground.log", create_parent=True)
        env = dict(os.environ, MOZ_NO_REMOTE="1", MOZ_MARIONETTE="1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1",
                   MOZ_CRASHREPORTER_DISABLE="1")
        env.pop("MOZ_PROFILE", None)
        argv = launch_argv(binary, profile, home)
        with log.open("wb") as output:
            os.chmod(log, 0o600)
            options = {"cwd": str(binary.parent), "env": env, "stdout": output, "stderr": subprocess.STDOUT}
            if platform.system() == "Windows":
                options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                options["start_new_session"] = True
            process = subprocess.Popen(argv, **options)
        value = {"binary": str(binary), "app_bundle": deployment["bundle"] if deployment else manifest["bundle"], "profile": str(profile),
                 "pid": process.pid, "source_sha": sha, "marionette_host": "127.0.0.1",
                 "marionette_port": args.port, "started_at": utc_now(), "marker": MARKER,
                 "session_id": session, "artifact_manifest": str(ctx.local / "artifacts" / sha / "manifest.json")}
        if platform.system() == "Darwin":
            value.update(_playground_provenance(ctx, manifest))
        if deployment:
            value["deployment_manifest"] = deployment["deployment_manifest"]
        atomic_json(ctx.managed(ctx.local / "state.json"), {"schema_version": 1, "playground": value})
        deadline = time.monotonic() + 30
        ready = False
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise DevError("Playground exited early (%s); see %s" % (process.returncode, log))
            try:
                with socket.create_connection(("127.0.0.1", args.port), timeout=0.5) as connection:
                    greeting = connection.recv(2048)
                    ready = b'"marionetteProtocol"' in greeting
            except OSError:
                pass
            if ready:
                break
            time.sleep(0.25)
        if not ready:
            raise DevError("Launched PID %s but Marionette did not become ready; state retained for inspection" % process.pid)
        if platform.system() == "Darwin":
            verify_mac_signature(ctx, Path(value["app_bundle"]), required=True)
        return value


def reset_playground(ctx: Context, args: Any) -> Dict[str, Any]:
    profile = validate_profile(ctx)
    state = playground_state(ctx)
    assert_stopped([profile], ctx.runner, state)
    result = {"action": "reset-playground", "profile": str(profile), "apply": args.apply,
              "exists": profile.exists()}
    if not args.apply:
        return result
    with ctx.lock():
        profile = validate_profile(ctx)
        assert_stopped([profile], ctx.runner, state)
        if profile.exists():
            if any(is_link(path) for path in profile.rglob("*")):
                raise DevError("Refusing reset of a profile containing symlinks; inspect them first")
            shutil.rmtree(profile)
        state_path = ctx.managed(ctx.local / "state.json")
        if state_path.exists():
            state_path.unlink()
    return result
