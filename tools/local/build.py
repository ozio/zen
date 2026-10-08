"""Build, package and launch only a dedicated local playground."""
from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from core import (Context, DevError, assert_stopped, atomic_json, browser_binary,
                  build_env, host_platform, inventory_digest, is_link, make_read_only,
                  no_symlink_ancestors, port_available, read_json, require_sha,
                  sha256_file, source_stamp, toolchains, tree_inventory, utc_now)
from download import prefetch_firefox

MARKER = "ZEN PLAYGROUND"
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
    ctx.free_space()
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
                   "system_bootstrap": not args.skip_engine and not args.skip_system_bootstrap}
        if not args.skip_engine:
            receipt["source_download"] = source_download
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


def build(ctx: Context, args: Any) -> Dict[str, Any]:
    if not 1 <= args.jobs <= 128:
        raise DevError("Build jobs must be between 1 and 128")
    chain = toolchains(ctx)
    env = build_env(ctx, chain)
    ctx.free_space()
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
    return manifest


def package(ctx: Context, args: Any) -> Dict[str, Any]:
    chain = toolchains(ctx)
    env = build_env(ctx, chain)
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
            return verify_artifact(ctx, sha)
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
        binary = browser_binary(target)
        if source_stamp(target) != sha:
            raise DevError("Built bundle SourceStamp is not current source SHA; artifact left pending")
        records = tree_inventory(target)
        manifest = {"schema_version": 1, "source_sha": sha, "created_at": utc_now(),
                    "platform": host_platform(), "bundle": str(final / "bundle" / bundle.name),
                    "binary": str(final / binary.relative_to(pending)),
                    "binary_sha256": sha256_file(binary), "tree_sha256": inventory_digest(records),
                    "files": records, "build_receipt": str(build_path), "updater_disabled": True}
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


def run_playground(ctx: Context, args: Any) -> Dict[str, Any]:
    with ctx.lock():
        sha = require_sha(args.sha or ctx.sha())
        manifest = verify_artifact(ctx, sha)
        binary = Path(manifest["binary"])
        profile = validate_profile(ctx)
        previous = playground_state(ctx)
        assert_stopped([profile, binary], ctx.runner, previous)
        port_available(args.port)
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
        value = {"binary": str(binary), "app_bundle": manifest["bundle"], "profile": str(profile),
                 "pid": process.pid, "source_sha": sha, "marionette_host": "127.0.0.1",
                 "marionette_port": args.port, "started_at": utc_now(), "marker": MARKER,
                 "session_id": session, "artifact_manifest": str(ctx.local / "artifacts" / sha / "manifest.json")}
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
