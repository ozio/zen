#!/usr/bin/env python3
"""One portable, profile-safe entrypoint for a personal Zen source checkout."""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

import build as builds
import deploy
import staging
from core import Context, DevError, host_platform, pid_alive, toolchains


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2],
                     help="source checkout (defaults to this script's checkout)")
    cli.add_argument("--toolchains", type=Path,
                     help="read managed tools from this directory; caches/profiles remain under --root")
    sub = cli.add_subparsers(dest="command", required=True)
    check = sub.add_parser("doctor", help="read-only toolchain, source, disk and runtime inventory")
    check.add_argument("--json", action="store_true", help="emit JSON (other commands also emit JSON receipts)")
    setup = sub.add_parser("bootstrap", help="install locked npm dependencies, verify source archive, import, bootstrap")
    setup.add_argument("--skip-engine", action="store_true", help="install only locked npm dependencies")
    setup.add_argument("--skip-system-bootstrap", action="store_true", help="skip mach's native dependency provisioning")
    compile_ = sub.add_parser("build", help="build source with pinned tools and updater disabled")
    compile_.add_argument("--ui", action="store_true", help="mach build faster; requires a prior native build")
    compile_.add_argument("--jobs", type=int, default=8, help="parallel build jobs (default: 8)")
    archive = sub.add_parser("package", help="mach package then seal standalone artifact at its committed source SHA")
    archive.add_argument("--bundle", help="select a built app/directory below engine when multiple object dirs exist")
    archive.add_argument("--signing-identity", help="macOS codesigning identity: exact certificate SHA-1 or '-' for local ad hoc (default)")
    playground_archive = sub.add_parser("package-playground", help="macOS: derive and seal the distinct Playground app from a verified main package")
    playground_archive.add_argument("--sha", help="full packaged source SHA (default: current HEAD)")
    run = sub.add_parser("run", help="launch the clean playground using an immutable standalone artifact")
    run.add_argument("target", choices=["playground"])
    run.add_argument("--sha", help="full artifact source SHA (default: current HEAD)")
    run.add_argument("--port", type=int, default=2828, help="localhost Marionette port (default: 2828)")
    run.add_argument("--in-artifact", action="store_true", help="macOS: run inside the artifact instead of staging /Applications/Zen Playground.app")
    reset = sub.add_parser("reset-playground", help="plan deletion of only the stopped, recognized clean profile")
    reset.add_argument("--apply", action="store_true", help="delete profile after containment/identity/process checks")
    pr = sub.add_parser("stage-pr", help="pin GitHub PR evidence and create a detached experiment from our fork HEAD")
    pr.add_argument("url", help="canonical https://github.com/OWNER/REPO/pull/NUMBER")
    pr.add_argument("--apply", action="store_true", help="apply reviewed pinned PR commits to the detached copy")
    pr.add_argument("--reviewed-head", help="exact full PR head SHA whose snapshot/diff you reviewed")
    pr.add_argument("--commit", action="append", default=[], help="select reviewed linear commit SHA; repeat in PR order")
    upstream = sub.add_parser("sync-upstream", help="preview/stage pinned upstream merge; explicitly accept a reviewed copy")
    upstream.add_argument("--ref", default="dev", help="upstream branch (default: dev)")
    upstream.add_argument("--stage", action="store_true", help="merge on detached worktree only")
    upstream.add_argument("--accept", help="successful staged experiment manifest; dry-run unless --apply")
    upstream.add_argument("--reviewed-result", help="exact reviewed staged HEAD including repairs or conflict resolution")
    upstream.add_argument("--apply", action="store_true", help="fast-forward existing clean branch to accepted staged commit")
    main = sub.add_parser("install-main", help="plan standalone installation after compatibility proof and consistent backup")
    main.add_argument("--sha", help="full packaged SHA (default: current HEAD)")
    main.add_argument("--app", help="main bundle directory (macOS default: /Applications/Zen.app)")
    main.add_argument("--profile-root", help="directory containing main profiles.ini and installs.ini")
    main.add_argument("--profile", help="explicit existing registered main profile if registry is ambiguous")
    main.add_argument("--compatibility", help="real matching proof JSON (default: .zen-local/compatibility/<SHA>.json)")
    main.add_argument("--apply", action="store_true", help="back up stopped main app/profile/registry and install")
    recover = sub.add_parser("rollback", help="plan restoring an integrity-checked original app/profile snapshot")
    recover.add_argument("--backup", help="backup ID (default: last installation's original backup)")
    recover.add_argument("--restore-profile-snapshot", action="store_true",
                         help="explicitly restore original profile if current profile/registries evolved; newer data is backed up")
    recover.add_argument("--apply", action="store_true", help="preserve current snapshot, then restore original app/profile/registry")
    return cli


def doctor(ctx: Context, args: Any) -> Dict[str, Any]:
    chain = toolchains(ctx, required=False)
    problems = list(chain["errors"])
    if platform.system() == "Darwin" and not shutil.which("gtar"):
        problems.append("Missing GNU tar (gtar), required for Surfer source extraction")
    state = builds.playground_state(ctx)
    runtime = None
    if state:
        runtime = {"pid": state.get("pid"), "running": pid_alive(state["pid"]),
                   "binary": state.get("binary"), "profile": state.get("profile"),
                   "source_sha": state.get("source_sha"), "marionette_port": state.get("marionette_port")}
    snapshot = ctx.snapshot()
    return {"schema_version": 1, "root": str(ctx.root), "platform": host_platform(),
            "source_sha": snapshot["source_sha"], "branch": snapshot["branch"],
            "dirty": bool(snapshot["status"]), "toolchains": chain, "problems": problems,
            "free_gib": round(shutil.disk_usage(ctx.root).free / 1024 ** 3, 1),
            "engine_ready": (ctx.root / "engine" / "mach").is_file(),
            "playground": runtime, "ready": not problems,
            "runtime_proof": "Only a real host run and compatibility receipt establish runtime compatibility."}


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parser().parse_args(argv)
    ctx = Context(args.root, toolchain_root=args.toolchains)
    handlers = {"doctor": doctor, "bootstrap": builds.bootstrap, "build": builds.build,
                "package": builds.package, "package-playground": builds.package_playground, "run": builds.run_playground,
                "reset-playground": builds.reset_playground, "stage-pr": staging.stage_pr,
                "sync-upstream": staging.sync_upstream, "install-main": deploy.install_main,
                "rollback": deploy.rollback}
    try:
        if args.command == "sync-upstream":
            if args.stage and args.accept:
                raise DevError("--stage and --accept are separate phases")
            if args.reviewed_result and not args.accept:
                raise DevError("--reviewed-result requires --accept MANIFEST")
        result = handlers[args.command](ctx, args)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if args.command != "doctor" or result["ready"] else 2
    except (DevError, OSError) as error:
        print("zen-local: %s" % error, file=sys.stderr)
        return 1
    except (KeyError, TypeError, ValueError) as error:
        print("zen-local: invalid metadata or receipt: %s" % error, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("zen-local: interrupted; local state/logs retained for inspection", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
