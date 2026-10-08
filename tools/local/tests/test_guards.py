"""Safety oracles exercise real files; Git, apps and downloads are isolated fakes."""
from __future__ import annotations

import ast
import hashlib
import io
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build
import core
import deploy
import dev
import download
import staging

FORK = "1" * 40
BASE = "2" * 40
HEAD = "3" * 40
FIRST = "4" * 40
LOCAL = "5" * 40


def completed(args=(), output="", code=0):
    return subprocess.CompletedProcess(args, code, output, "")


class FakeContext(core.Context):
    def __init__(self, root):
        super().__init__(root)
        self.calls = []
        self.status = ""
        self.head = FORK
        self.worktree_head = LOCAL
        self.snapshot_value = {"source_sha": FORK, "branch": "forkdev", "status": "",
                               "tracked_diff_sha256": hashlib.sha256(b"").hexdigest()}

    def free_space(self, needed=0):
        pass

    def sha(self, cwd=None):
        return self.worktree_head if cwd else self.head

    def snapshot(self, cwd=None):
        return dict(self.snapshot_value, source_sha=self.head, status=self.status)

    def git(self, *args, cwd=None, check=True):
        self.calls.append((args, cwd))
        if args[0] == "rev-parse":
            return completed(args, HEAD + "\n")
        if args[0] == "merge-base" and len(args) == 3:
            return completed(args, BASE + "\n")
        if args[0] == "rev-list":
            return completed(args, FIRST + "\n" + HEAD + "\n")
        if args[0] == "status":
            return completed(args, "" if cwd else self.status)
        if args[0] == "diff":
            return completed(args, "diff --git a/src/test b/src/test\n")
        if args[0] == "worktree":
            Path(args[-2]).mkdir(parents=True)
        if args[:2] == ("merge", "--ff-only"):
            self.head = args[-1]
        return completed(args)


class SandboxTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "checkout"
        self.root.mkdir()
        self.ctx = FakeContext(self.root)

    def tearDown(self):
        for path in [self.base, *self.base.rglob("*")]:
            if not path.is_symlink():
                try:
                    os.chmod(path, path.stat().st_mode | 0o700)
                except FileNotFoundError:
                    pass
        self.temp.cleanup()

    def profile(self):
        path = self.ctx.local / "profiles" / "playground"
        path.mkdir(parents=True)
        core.atomic_json(path / "zen-playground.json", {"schema_version": 1,
                         "root": str(self.root), "marker": build.MARKER})
        return path

    def installation(self):
        app = self.base / "main-app"
        app.mkdir()
        (app / "zen").write_bytes(b"dummy browser executable")
        os.chmod(app / "zen", 0o755)
        (app / "application.ini").write_text("[App]\nSourceStamp=%s\n" % FORK)
        registry = self.base / "main-registry"
        profile = registry / "Profiles" / "personal"
        profile.mkdir(parents=True, mode=0o700)
        os.chmod(profile, 0o700)
        (profile / "prefs.js").write_text("dummy personal settings\n")
        os.chmod(profile / "prefs.js", 0o600)
        (registry / "profiles.ini").write_text("[Profile0]\nName=Personal\nIsRelative=1\nPath=Profiles/personal\nDefault=1\n")
        (registry / "installs.ini").write_text("[fake-install]\nDefault=Profiles/personal\n")
        os.chmod(registry / "profiles.ini", 0o600)
        return app, registry, profile


class ContainmentTests(SandboxTest):
    def test_canonical_escape_and_symlink_ancestor_refused(self):
        for path in (self.base / "outside", self.ctx.local / ".." / "personal"):
            with self.assertRaises(core.DevError):
                self.ctx.managed(path)
        outside = self.base / "outside"
        outside.mkdir()
        self.ctx.local.mkdir()
        (self.ctx.local / "profiles").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(core.DevError):
            self.ctx.managed(self.ctx.local / "profiles" / "playground")

    @patch("core.process_list", return_value=[])
    def test_reset_dry_run_preserves_profile_and_other_data(self, _processes):
        profile = self.profile()
        personal = self.root / "personal"
        personal.mkdir()
        (personal / "cookies.sqlite").write_text("dummy")
        result = build.reset_playground(self.ctx, SimpleNamespace(apply=False))
        self.assertFalse(result["apply"])
        self.assertTrue(profile.exists())
        build.reset_playground(self.ctx, SimpleNamespace(apply=True))
        self.assertFalse(profile.exists())
        self.assertTrue((personal / "cookies.sqlite").exists())

    @patch("core.process_list", return_value=[])
    def test_reset_refuses_nested_symlink_and_unrecognized_profile(self, _processes):
        profile = self.profile()
        outside = self.base / "outside"
        outside.mkdir()
        (profile / "external").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(core.DevError):
            build.reset_playground(self.ctx, SimpleNamespace(apply=True))
        self.assertTrue(profile.exists())
        (profile / "external").unlink()
        (profile / "zen-playground.json").unlink()
        with self.assertRaises(core.DevError):
            build.reset_playground(self.ctx, SimpleNamespace(apply=True))

    @patch("core.process_list", return_value=[])
    @patch("core.pid_alive", return_value=True)
    def test_recorded_running_pid_blocks_reset(self, _alive, _processes):
        profile = self.profile()
        core.atomic_json(self.ctx.local / "state.json", {"schema_version": 1,
                         "playground": {"pid": 123, "profile": str(profile)}})
        with self.assertRaisesRegex(core.DevError, "still running"):
            build.reset_playground(self.ctx, SimpleNamespace(apply=True))
        self.assertTrue(profile.exists())

    @patch("core.platform.system", return_value="Windows")
    @patch("core.process_list", return_value=[{"pid": 42}])
    @patch("core.os.kill")
    def test_windows_liveness_probe_never_sends_kill(self, kill, _processes, _system):
        self.assertTrue(core.pid_alive(42))
        self.assertFalse(core.pid_alive(43))
        kill.assert_not_called()

    @unittest.skipIf(core.platform.system() == "Windows", "POSIX fcntl lock oracle")
    @patch("core.process_list", return_value=[])
    def test_regular_firefox_lock_can_remain_unlocked_but_held_lock_refuses(self, _processes):
        profile = self.profile()
        lock = profile / ".parentlock"
        lock.write_text("preserve-lock-contents")
        core.assert_stopped([profile])
        self.assertEqual(lock.read_text(), "preserve-lock-contents")
        code = ("import fcntl,sys,time; f=open(sys.argv[1],'r+'); "
                "fcntl.lockf(f,fcntl.LOCK_EX); print('LOCKED',flush=True); time.sleep(10)")
        child = subprocess.Popen([sys.executable, "-c", code, str(lock)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "LOCKED")
            with self.assertRaisesRegex(core.DevError, "lock is held"):
                core.assert_stopped([profile])
        finally:
            child.terminate()
            child.wait(timeout=5)
            child.stdout.close()
        core.assert_stopped([profile])
        self.assertEqual(lock.read_text(), "preserve-lock-contents")

    def test_shell_command_mention_is_not_mistaken_for_browser(self):
        profile = self.profile()
        shell = {"pid": 555, "binary": "/bin/zsh", "command": "zsh -c python dev.py --profile " + str(profile)}
        with patch("core.process_list", return_value=[shell]):
            core.assert_stopped([profile])
        browser = dict(shell, binary="/tmp/zen", command="/tmp/zen --profile " + str(profile))
        with patch("core.process_list", return_value=[browser]):
            with self.assertRaisesRegex(core.DevError, "in use"):
                core.assert_stopped([profile])

    def test_launcher_arguments_and_receipt_are_explicit(self):
        binary = self.ctx.local / "artifacts" / FORK / "bundle" / "zen"
        manifest = {"binary": str(binary), "bundle": str(binary.parent)}
        process = SimpleNamespace(pid=1234, poll=lambda: None)
        connection = SimpleNamespace(__enter__=lambda _: None)
        with patch("build.verify_artifact", return_value=manifest), patch("build.assert_stopped"), \
                patch("build.platform.system", return_value="Linux"), \
                patch("build.port_available"), patch("build.subprocess.Popen", return_value=process) as launch, \
                patch("build.socket.create_connection") as connect:
            connect.return_value.__enter__.return_value.recv.return_value = b'50:{"marionetteProtocol":3}'
            receipt = build.run_playground(self.ctx, SimpleNamespace(sha=FORK, port=2828, in_artifact=True))
        argv = launch.call_args.args[0]
        profile = self.ctx.local / "profiles" / "playground"
        self.assertEqual(argv[:5], [str(binary), "--no-remote", "--profile", str(profile), "--marionette"])
        self.assertIn("--remote-allow-system-access", argv)
        self.assertEqual(receipt["profile"], str(profile))
        self.assertEqual(receipt["pid"], 1234)
        self.assertEqual(receipt["marionette_host"], "127.0.0.1")
        self.assertEqual(str(uuid.UUID(receipt["session_id"])), receipt["session_id"])
        userjs = (profile / "user.js").read_text()
        self.assertIn('"zen.playground.session_id", "%s"' % receipt["session_id"], userjs)
        self.assertIn('"app.update.auto", false', userjs)
        self.assertFalse((profile / "cookies.sqlite").exists())


class MacPlaygroundTests(SandboxTest):
    @unittest.skipUnless(sys.platform == "darwin", "macOS package signing regression")
    def test_real_signed_package_omits_consumed_gecko_cache_sentinels(self):
        source = self.root / "engine" / "dist" / "Zen.app"
        binary = source / "Contents" / "MacOS" / "zen"
        binary.parent.mkdir(parents=True)
        shutil.copyfile("/bin/echo", binary)
        binary.chmod(0o755)
        (source / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleExecutable": "zen", "CFBundleIdentifier": "test.zen.local",
            "CFBundlePackageType": "APPL"}))
        resources = source / "Contents" / "Resources"
        (resources / "browser").mkdir(parents=True)
        (resources / "application.ini").write_text("[App]\nSourceStamp=%s\n" % FORK)
        for root in (resources, resources / "browser"):
            (root / ".purgecaches").write_text("\n")
        (resources / "browser" / "keep.txt").write_text("preserve")
        receipt = self.ctx.local / "builds" / FORK / "build.json"
        core.atomic_json(receipt, {"result": "pass", "ui_only": False, "source_sha": FORK,
                                  "source_snapshot": self.ctx.snapshot()})
        with patch("build.toolchains", return_value={"python": {"path": sys.executable}}), \
                patch("build.build_env", return_value=dict(os.environ)), \
                patch.object(self.ctx.runner, "logged"):
            manifest = build.package(self.ctx, SimpleNamespace(bundle=str(source), signing_identity="-"))
        copied = Path(manifest["bundle"])
        self.assertEqual(list(copied.rglob(".purgecaches")), [])
        self.assertEqual((copied / "Contents/Resources/browser/keep.txt").read_text(), "preserve")
        self.assertTrue((resources / "browser/.purgecaches").exists())
        self.assertTrue(core.verify_mac_signature(self.ctx, copied, required=True))

    @unittest.skipUnless(sys.platform == "darwin", "macOS signing xattr regression")
    def test_signed_non_macho_metadata_survives_application_copy(self):
        source = self.base / "Source.app"
        source.mkdir()
        script = source / "helper.sh"
        script.write_text("#!/bin/sh\nexit 0\n")
        script.chmod(0o755)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(script)], check=True, capture_output=True)
        destination = self.base / "Copied.app"
        deploy._writable_copy(source, destination)
        verified = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(destination / "helper.sh")], capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)

    def setUp(self):
        super().setUp()
        self.applications = self.base / "Applications"
        self.applications.mkdir()
        self.target = self.applications / "Zen Playground.app"
        self.patch_target = patch("build.MAC_PLAYGROUND_APP", self.target)
        self.patch_target.start()
        self.addCleanup(self.patch_target.stop)
        self.patch_processes = patch("core.process_list", return_value=[])
        self.patch_processes.start()
        self.addCleanup(self.patch_processes.stop)
        self.patch_platform = patch("build.platform.system", return_value="Darwin")
        self.patch_platform.start()
        self.addCleanup(self.patch_platform.stop)
        self.patch_signature = patch("build.verify_mac_signature", return_value=True)
        self.patch_signature.start()
        self.addCleanup(self.patch_signature.stop)
        self.patch_registration = patch("build._register_mac_playground")
        self.patch_registration.start()
        self.addCleanup(self.patch_registration.stop)
        icon = self.root / build.MAC_PLAYGROUND_ICON
        icon.parent.mkdir(parents=True)
        icon.write_bytes((Path(__file__).resolve().parents[3] / build.MAC_PLAYGROUND_ICON).read_bytes())

    def artifact(self, sha=FORK):
        root = self.ctx.local / "artifacts" / sha
        bundle = root / "bundle" / "Zen.app"
        binary = bundle / "Contents" / "MacOS" / "zen"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(("synthetic executable " + sha).encode())
        binary.chmod(0o755)
        (bundle / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleExecutable": "zen", "CFBundleIdentifier": "app.zen-browser.zen",
            "CFBundleURLTypes": [{"CFBundleURLSchemes": ["http", "https"]}],
            "CFBundleDocumentTypes": [{"CFBundleTypeExtensions": ["html"]}],
            "NSUserActivityTypes": ["NSUserActivityTypeBrowsingWeb"], "CFBundleIconFile": "firefox.icns"}))
        resources = bundle / "Contents" / "Resources"
        resources.mkdir()
        (resources / "application.ini").write_text("[App]\nSourceStamp=%s\n" % sha)
        (resources / "firefox.icns").write_bytes(b"original icon")
        files = core.tree_inventory(bundle)
        result = {"schema_version":1, "source_sha":sha, "bundle":str(bundle), "binary":str(binary),
                  "files":files, "tree_sha256":core.inventory_digest(files),
                  "binary_sha256":core.sha256_file(binary), "platform":core.host_platform(),
                  "code_signing": {"identity": "-", "kind": "ad-hoc", "verified": True,
                                   "verification": "codesign --verify --deep --strict", "notarized": False}}
        core.atomic_json(root / "manifest.json", result)
        core.make_read_only(root)
        with patch.object(self.ctx.runner, "run", return_value=completed()):
            return build.prepare_playground_artifact(self.ctx, sha)

    def test_secondary_copy_is_identical_owned_and_reusable(self):
        manifest = self.artifact()
        result = build.stage_mac_playground(self.ctx, manifest)
        self.assertEqual(core.tree_inventory(self.target), manifest["files"])
        receipt = core.read_json(Path(result["deployment_manifest"]))
        self.assertEqual(receipt["source_sha"], FORK)
        self.assertEqual(receipt["artifact_manifest"], str(self.ctx.local / "playground-artifacts" / FORK / "manifest.json"))
        self.assertEqual(receipt["base_artifact_manifest"], str(self.ctx.local / "artifacts" / FORK / "manifest.json"))
        self.assertEqual(receipt["variant"], "playground")
        with patch("build.shutil.copytree") as copy:
            self.assertEqual(build.stage_mac_playground(self.ctx, manifest), result)
            copy.assert_not_called()

    def test_unowned_existing_app_is_preserved(self):
        manifest = self.artifact()
        self.target.mkdir()
        (self.target / "unrelated").write_text("preserve")
        with self.assertRaisesRegex(core.DevError, "no ownership receipt"):
            build.stage_mac_playground(self.ctx, manifest)
        self.assertEqual((self.target / "unrelated").read_text(), "preserve")

    def test_modified_owned_app_is_preserved_and_refuses_update(self):
        build.stage_mac_playground(self.ctx, self.artifact())
        binary = self.target / "Contents" / "MacOS" / "zen"
        binary.chmod(0o755)
        binary.write_bytes(b"unexpected modification")
        with self.assertRaisesRegex(core.DevError, "differs from its owned artifact"):
            build.stage_mac_playground(self.ctx, self.artifact(HEAD))
        self.assertEqual(binary.read_bytes(), b"unexpected modification")

    def test_receipt_failure_restores_previous_app_and_ownership(self):
        old = self.artifact()
        build.stage_mac_playground(self.ctx, old)
        current = self.ctx.local / "deployments" / "playground" / "current.json"
        before = current.read_bytes()
        candidate = self.artifact(HEAD)
        with patch("build.atomic_json", side_effect=OSError("receipt failure")):
            with self.assertRaisesRegex(OSError, "receipt failure"):
                build.stage_mac_playground(self.ctx, candidate)
        self.assertEqual(current.read_bytes(), before)
        self.assertEqual(core.tree_inventory(self.target), old["files"])
        self.assertEqual(len(list(self.applications.glob(".zen-playground-pending-*.app"))), 1)

    def test_failed_first_install_keeps_candidate_without_claiming_ownership(self):
        manifest = self.artifact()
        with patch("build.atomic_json", side_effect=OSError("receipt failure")):
            with self.assertRaises(OSError):
                build.stage_mac_playground(self.ctx, manifest)
        self.assertFalse(self.target.exists())
        self.assertFalse((self.ctx.local / "deployments" / "playground" / "current.json").exists())
        self.assertEqual(len(list(self.applications.glob(".zen-playground-pending-*.app"))), 1)

    def test_copy_signature_failure_preserves_existing_app_and_receipt(self):
        old = self.artifact()
        build.stage_mac_playground(self.ctx, old)
        current = self.ctx.local / "deployments" / "playground" / "current.json"
        before = current.read_bytes()
        candidate = self.artifact(HEAD)
        with patch("build.verify_mac_signature", side_effect=core.DevError("signature metadata missing")):
            with self.assertRaisesRegex(core.DevError, "signature metadata missing"):
                build.stage_mac_playground(self.ctx, candidate)
        self.assertEqual(current.read_bytes(), before)
        self.assertEqual(core.tree_inventory(self.target), old["files"])


class StagingTests(SandboxTest):
    def metadata(self, ctx, endpoint, paginate=False):
        if "/pulls/" in endpoint and "?" not in endpoint and endpoint.count("/") == 4:
            return {"head": {"sha": HEAD}, "base": {"sha": BASE}}
        return {}

    def pages(self, ctx, endpoint):
        if "/commits?" in endpoint:
            return [{"sha": FIRST, "parents": [{"sha": BASE}]},
                    {"sha": HEAD, "parents": [{"sha": FIRST}]}]
        return []

    def pr_args(self, **kwargs):
        return SimpleNamespace(**dict({"url": "https://github.com/zen-browser/desktop/pull/12",
                                      "apply": False, "reviewed_head": None, "commit": []}, **kwargs))

    def test_canonical_url_parser_rejects_shell_and_foreign_hosts(self):
        self.assertEqual(staging.parse_pr_url("https://github.com/ozio/zen/pull/10"), ("ozio", "zen", 10))
        for url in ["http://github.com/o/r/pull/1", "https://github.com.evil/o/r/pull/1",
                    "https://github.com/o/r/pull/1?x=1", "https://u@github.com/o/r/pull/1",
                    "https://github.com/o/r/pull/1/files", "https://github.com/o/r/pull/1#review",
                    "https://github.com/o/r/pull/0", "https://github.com/o/r;touch/pull/1"]:
            with self.assertRaises(core.DevError):
                staging.parse_pr_url(url)

    def test_pr_review_stage_preserves_dirty_main_and_starts_from_our_head(self):
        self.ctx.status = " M src/user-work.js\n"
        with patch("staging.gh_json", side_effect=self.metadata), patch("staging.gh_list", side_effect=self.pages), \
                patch("staging.review_threads", return_value={"threads": []}):
            result = staging.stage_pr(self.ctx, self.pr_args())
        self.assertEqual(result["state"], "awaiting-review")
        manifest = core.read_json(Path(result["manifest"]))
        self.assertEqual(manifest["source_fork_sha"], FORK)
        self.assertEqual(manifest["head_sha"], HEAD)
        self.assertEqual(manifest["base_sha"], BASE)
        self.assertTrue((Path(result["manifest"]).parent / "changes.diff").exists())
        self.assertTrue((Path(result["manifest"]).parent / "metadata.json").exists())
        self.assertIn(("worktree", "add", "--detach", result["worktree"], FORK), [call[0] for call in self.ctx.calls])
        self.assertFalse(any("cherry-pick" in call[0] for call in self.ctx.calls))
        self.assertEqual(self.ctx.status, " M src/user-work.js\n")
        self.assertFalse(any(call[0][0] in ("reset", "stash", "checkout", "push") for call in self.ctx.calls))

    def test_apply_requires_reviewed_exact_head(self):
        with self.assertRaises(core.DevError):
            staging.stage_pr(self.ctx, self.pr_args(apply=True))
        with patch("staging.gh_json", side_effect=self.metadata):
            with self.assertRaisesRegex(core.DevError, "head changed"):
                staging.stage_pr(self.ctx, self.pr_args(apply=True, reviewed_head=FIRST))
        self.assertFalse(any("cherry-pick" in call[0] for call in self.ctx.calls))

    def test_only_selected_pinned_commits_apply_to_detached_worktree(self):
        with patch("staging.gh_json", side_effect=self.metadata), patch("staging.gh_list", side_effect=self.pages), \
                patch("staging.review_threads", return_value={"threads": []}):
            result = staging.stage_pr(self.ctx, self.pr_args(apply=True, reviewed_head=HEAD, commit=[FIRST]))
        self.assertEqual(result["state"], "staged")
        picks = [call for call in self.ctx.calls if "cherry-pick" in call[0]]
        self.assertEqual(len(picks), 1)
        self.assertEqual(picks[0][0][-1], FIRST)
        self.assertEqual(str(picks[0][1]), result["worktree"])
        manifest = core.read_json(Path(result["manifest"]))
        self.assertEqual(manifest["applied_commits"], [{"original_sha": FIRST, "local_sha": LOCAL}])
        self.assertEqual(self.ctx.head, FORK)

    def test_head_race_aborts_before_creating_or_applying_worktree(self):
        count = 0
        def changed(ctx, endpoint, paginate=False):
            nonlocal count
            result = self.metadata(ctx, endpoint, paginate)
            if "head" in result:
                count += 1
                if count > 1:
                    result["head"]["sha"] = FIRST
            return result
        with patch("staging.gh_json", side_effect=changed), patch("staging.gh_list", side_effect=self.pages), \
                patch("staging.review_threads", return_value={"threads": []}):
            with self.assertRaisesRegex(core.DevError, "PR moved"):
                staging.stage_pr(self.ctx, self.pr_args(apply=True, reviewed_head=HEAD))
        self.assertFalse(any(call[0][0] == "worktree" or "cherry-pick" in call[0] for call in self.ctx.calls))

    def staged_upstream(self):
        worktree = self.ctx.local / "worktrees" / "upstream-test"
        worktree.mkdir(parents=True)
        path = self.ctx.local / "experiments" / "upstream-test" / "manifest.json"
        core.atomic_json(path, {"schema_version": 1, "kind": "upstream", "state": "staged",
                         "root": str(self.root), "source_fork_sha": FORK, "upstream_sha": HEAD,
                         "result_sha": LOCAL, "worktree": str(worktree), "source_snapshot": self.ctx.snapshot()})
        return path

    def test_upstream_accept_refuses_dirty_main_and_preview_does_not_merge(self):
        path = self.staged_upstream()
        args = SimpleNamespace(accept=str(path), apply=True, reviewed_result=None)
        self.ctx.status = " M user-work\n"
        with self.assertRaisesRegex(core.DevError, "committed"):
            staging.accept_upstream(self.ctx, args)
        self.assertFalse(any(call[0][:2] == ("merge", "--ff-only") for call in self.ctx.calls))
        self.ctx.status = ""
        args.apply = False
        staging.accept_upstream(self.ctx, args)
        self.assertEqual(self.ctx.head, FORK)
        args.apply = True
        staging.accept_upstream(self.ctx, args)
        self.assertEqual(self.ctx.head, LOCAL)

    def test_upstream_preview_and_stage_preserve_dirty_main_and_merge_only_copy(self):
        self.ctx.status = " M unrelated-work.js\n"
        args = SimpleNamespace(accept=None, apply=False, ref="dev", stage=False, reviewed_result=None)
        preview = staging.sync_upstream(self.ctx, args)
        self.assertEqual(preview["state"], "preview")
        self.assertIsNone(preview["worktree"])
        self.assertFalse(any("merge" in call[0] for call in self.ctx.calls))
        args.stage = True
        result = staging.sync_upstream(self.ctx, args)
        merges = [call for call in self.ctx.calls if "merge" in call[0]]
        self.assertEqual(len(merges), 1)
        self.assertEqual(str(merges[0][1]), result["worktree"])
        self.assertEqual(self.ctx.head, FORK)
        self.assertEqual(self.ctx.status, " M unrelated-work.js\n")
        self.assertEqual(result["result_sha"], LOCAL)

    def test_unpinned_commit_cannot_be_applied_even_with_reviewed_head(self):
        with patch("staging.gh_json", side_effect=self.metadata), patch("staging.gh_list", side_effect=self.pages), \
                patch("staging.review_threads", return_value={"threads": []}):
            with self.assertRaisesRegex(core.DevError, "pinned PR commit"):
                staging.stage_pr(self.ctx, self.pr_args(apply=True, reviewed_head=HEAD, commit=[BASE]))
        self.assertFalse(any("cherry-pick" in call[0] for call in self.ctx.calls))


class DeploymentTests(SandboxTest):
    def proof(self, **overrides):
        manifest = {"source_sha": FORK, "binary_sha256": "a" * 64}
        receipt = {"schema_version": 1, "source_sha": FORK,
                   "artifact_manifest": str(self.ctx.local / "artifacts" / FORK / "manifest.json"),
                   "binary_sha256": "a" * 64, "platform": core.host_platform(),
                   "profile": str(self.ctx.local / "profiles" / "playground"), "result": "pass",
                   "checks": {name: True for name in deploy.REQUIRED_CHECKS}, "verified_at": core.utc_now()}
        receipt.update(overrides)
        path = self.ctx.local / "compatibility" / (FORK + ".json")
        core.atomic_json(path, receipt)
        return manifest, path

    def test_compatibility_exact_binary_host_profile_and_real_native_exchange(self):
        manifest, path = self.proof()
        deploy.compatibility(self.ctx, manifest, path)
        bad = [{"source_sha": BASE}, {"binary_sha256": "b" * 64}, {"profile": str(self.base / "personal")},
               {"platform": {"system": "Imaginary", "machine": "fake"}},
               {"checks": {name: True for name in deploy.REQUIRED_CHECKS if name != "enpass_native_host"}}]
        for override in bad:
            manifest, path = self.proof(**override)
            with self.assertRaises(core.DevError):
                deploy.compatibility(self.ctx, manifest, path)

    def test_registry_escape_and_ambiguous_profile_refused(self):
        app, registry, profile = self.installation()
        self.assertEqual(deploy.select_profile(registry), profile)
        (registry / "profiles.ini").write_text("[Profile0]\nIsRelative=1\nPath=../../outside\nDefault=1\n")
        with self.assertRaisesRegex(core.DevError, "escapes"):
            deploy.select_profile(registry)

    @patch("deploy.assert_stopped")
    def test_main_dry_run_does_not_copy_or_change_personal_data(self, _stopped):
        app, registry, profile = self.installation()
        manifest, proof = self.proof()
        manifest["bundle"] = str(self.ctx.local / "artifacts" / FORK / "bundle" / "candidate")
        before = (profile / "prefs.js").read_bytes()
        args = SimpleNamespace(sha=FORK, compatibility=str(proof), app=str(app), profile_root=str(registry),
                               profile=str(profile), apply=False)
        with patch("deploy.verify_artifact", return_value=manifest), patch("deploy.create_backup") as backup:
            result = deploy.install_main(self.ctx, args)
        self.assertFalse(result["apply"])
        backup.assert_not_called()
        self.assertEqual((profile / "prefs.js").read_bytes(), before)

    @patch("deploy.assert_stopped")
    def test_consistent_backup_is_sealed_and_restore_preserves_private_modes(self, _stopped):
        app, registry, profile = self.installation()
        directory, manifest = deploy.create_backup(self.ctx, app, registry, profile, "test")
        self.assertEqual(deploy.verify_backup(self.ctx, directory), manifest)
        if core.platform.system() != "Windows":
            self.assertFalse((directory / "manifest.json").stat().st_mode & 0o222)
            self.assertFalse(directory.stat().st_mode & 0o077)
            self.assertFalse((directory / "profile" / "prefs.js").stat().st_mode & 0o077)
        restored = self.base / "restored-profile"
        deploy._writable_copy(directory / "profile", restored, preserve_links=True)
        deploy._restore_modes(restored, manifest["profile_modes"])
        self.assertEqual(restored.stat().st_mode & 0o777, 0o700)
        self.assertEqual((restored / "prefs.js").stat().st_mode & 0o777, 0o600)
        altered = directory / "profile" / "prefs.js"
        os.chmod(altered, 0o600)
        altered.write_text("changed")
        os.chmod(altered, 0o400)
        with self.assertRaisesRegex(core.DevError, "integrity"):
            deploy.verify_backup(self.ctx, directory)

    @patch("deploy.assert_stopped")
    def test_external_profile_link_blocks_backup_before_main_change(self, _stopped):
        app, registry, profile = self.installation()
        outside = self.base / "unbacked-data"
        outside.mkdir()
        (profile / "external-storage").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(core.DevError, "not standalone"):
            deploy.create_backup(self.ctx, app, registry, profile, "test")
        self.assertFalse((self.ctx.local / "backups").exists())
        self.assertTrue((app / "zen").exists())

    @patch("deploy.assert_stopped")
    def test_rollback_preserves_evolved_profile_before_restoring_original(self, _stopped):
        app, registry, profile = self.installation()
        original_data = (profile / "prefs.js").read_text()
        directory, _manifest = deploy.create_backup(self.ctx, app, registry, profile, "before-install")
        (profile / "prefs.js").write_text("new session data")
        args = SimpleNamespace(backup=directory.name, apply=True, restore_profile_snapshot=False)
        with self.assertRaisesRegex(core.DevError, "Profile evolved"):
            deploy.rollback(self.ctx, args)
        self.assertEqual((profile / "prefs.js").read_text(), "new session data")
        args.restore_profile_snapshot = True
        result = deploy.rollback(self.ctx, args)
        self.assertEqual((profile / "prefs.js").read_text(), original_data)
        current = Path(result["preserved_current_backup"])
        self.assertEqual((current / "profile" / "prefs.js").read_text(), "new session data")
        self.assertEqual(deploy.verify_backup(self.ctx, current)["result"], "complete")


class DownloadTests(SandboxTest):
    def setUp(self):
        super().setUp()
        (self.root / "surfer.json").write_text(json.dumps({"version": {"version": "157.0.1"}}))
        self.content = b"a complete fake Firefox source archive"
        self.hash = hashlib.sha512(self.content).hexdigest()
        self.sums = (self.hash + "  source/firefox-157.0.1.source.tar.xz\n").encode()

    def response(self, content, length=None):
        stream = io.BytesIO(content)
        stream.headers = {"Content-Length": str(len(content) if length is None else length)}
        return stream

    def test_checksum_verified_atomic_download_replaces_only_exact_cache(self):
        target = self.root / ".surfer" / "engine" / "firefox-157.0.1.source.tar.xz"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"truncated")
        unrelated = target.parent / "keep-me"
        unrelated.write_bytes(b"keep")
        with patch("download._official_response", side_effect=[self.response(self.sums), self.response(self.content)]):
            result = download.prefetch_firefox(self.ctx)
        self.assertFalse(result["cached"])
        self.assertEqual(target.read_bytes(), self.content)
        self.assertEqual(unrelated.read_bytes(), b"keep")
        self.assertFalse(list(target.parent.glob("*.part-*")))

    def test_truncated_network_stream_never_replaces_cache(self):
        target = self.root / ".surfer" / "engine" / "firefox-157.0.1.source.tar.xz"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"old incomplete download")
        with patch("download._official_response", side_effect=[self.response(self.sums), self.response(self.content[:-1], len(self.content))]):
            with self.assertRaisesRegex(core.DevError, "incomplete"):
                download.prefetch_firefox(self.ctx)
        self.assertEqual(target.read_bytes(), b"old incomplete download")
        self.assertFalse(list(target.parent.glob("*.part-*")))


class InterfaceTests(unittest.TestCase):
    def test_lightweight_cli_parses_as_python39_and_exposes_full_command_suite(self):
        for path in Path(dev.__file__).parent.glob("*.py"):
            ast.parse(path.read_text(), feature_version=9)
        text = dev.parser().format_help()
        for command in ("doctor", "bootstrap", "build", "package", "run", "reset-playground", "stage-pr", "sync-upstream", "install-main", "rollback"):
            self.assertIn(command, text)
        args = dev.parser().parse_args(["--root", "/candidate", "--toolchains", "/original/.zen-local/toolchains", "build", "--ui"])
        self.assertTrue(args.ui)
        self.assertEqual(args.toolchains, Path("/original/.zen-local/toolchains"))


class BuildProvenanceTests(SandboxTest):
    def native_tree(self):
        obj = self.root / "engine" / "obj-native"
        (obj / "dist" / "bin").mkdir(parents=True)
        (obj / "dist" / "bin" / "zen").write_bytes(b"native binary")
        (obj / "config.status").write_text("configured")
        return obj

    def test_first_ui_build_refuses_even_if_a_binary_has_no_full_receipt(self):
        self.native_tree()
        with self.assertRaisesRegex(core.DevError, "prior successful full"):
            build.require_prior_native_build(self.ctx)

    def test_prior_receipt_must_match_host_engine_and_object_tree(self):
        obj = self.native_tree()
        receipt = {"result": "pass", "ui_only": False, "platform": core.host_platform(),
                   "engine": str(self.root / "engine"), "object_dirs": [str(obj)]}
        path = self.ctx.local / "builds" / BASE / "build.json"
        core.atomic_json(path, receipt)
        build.require_prior_native_build(self.ctx)
        receipt["platform"] = {"system": "Foreign", "machine": "Foreign"}
        core.atomic_json(path, receipt)
        with self.assertRaises(core.DevError):
            build.require_prior_native_build(self.ctx)

    def test_package_refuses_untracked_new_source_before_mach_or_copy(self):
        self.ctx.status = "?? src/uncommitted.cpp\n"
        with patch("build.toolchains", return_value={}), patch("build.build_env", return_value={}), \
                patch.object(self.ctx.runner, "logged") as mach:
            with self.assertRaisesRegex(core.DevError, "Commit all nonignored"):
                build.package(self.ctx, SimpleNamespace(bundle=None))
        mach.assert_not_called()


if __name__ == "__main__":
    unittest.main()
