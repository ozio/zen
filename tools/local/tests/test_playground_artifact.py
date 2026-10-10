"""Derived-package provenance, branding, refusal and real macOS signing tests."""
from __future__ import annotations

import plistlib
import shutil
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_guards import BASE, FORK, SandboxTest, completed
import build
import core
import deploy
import dev

ICON_SOURCE = Path(__file__).resolve().parents[3] / build.MAC_PLAYGROUND_ICON


def base_artifact(test, sha=FORK, real_signature=False, identity="-"):
    root = test.ctx.local / "artifacts" / sha
    bundle = root / "bundle" / "Zen.app"
    binary = bundle / "Contents" / "MacOS" / "zen"
    binary.parent.mkdir(parents=True)
    if real_signature:
        shutil.copyfile("/bin/echo", binary)
        helper = binary.with_name("helper.sh")
        helper.write_text("#!/bin/sh\nexit 0\n")
        helper.chmod(0o755)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(helper)],
                       check=True, capture_output=True)
    else:
        binary.write_bytes(b"synthetic main browser")
    binary.chmod(0o755)
    (bundle / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleExecutable": "zen", "CFBundlePackageType": "APPL",
        "CFBundleIdentifier": "app.zen-browser.zen", "CFBundleName": "Zen",
        "CFBundleDisplayName": "Zen", "CFBundleIconFile": "firefox.icns",
        "CFBundleIconName": "AppIcon",
        "CFBundleURLTypes": [{"CFBundleURLSchemes": ["http", "https", "file"]}],
        "CFBundleDocumentTypes": [{"CFBundleTypeExtensions": ["html"]}],
        "NSUserActivityTypes": ["NSUserActivityTypeBrowsingWeb"],
        "LSMinimumSystemVersion": "10.15"}))
    resources = bundle / "Contents" / "Resources"
    resources.mkdir()
    with zipfile.ZipFile(resources / "omni.ja", "w") as archive:
        archive.writestr("chrome.manifest", "# synthetic GRE archive")
    (resources / "application.ini").write_text("[App]\nSourceStamp=%s\n" % sha)
    (resources / "firefox.icns").write_bytes(b"original main icon")
    if real_signature:
        entitlements = test.root / "synthetic-entitlements.plist"
        entitlements.write_bytes(plistlib.dumps({"com.apple.security.cs.allow-jit": True}))
        test.ctx.runner.run(["/usr/bin/codesign", "--force", "--deep", "--options", "runtime",
                             "--entitlements", str(entitlements), "--sign", identity, str(bundle)], test.root)
        core.verify_mac_signature(test.ctx, bundle, required=True)
    records = core.tree_inventory(bundle)
    manifest = {"schema_version": 1, "source_sha": sha, "platform": core.host_platform(),
                "bundle": str(bundle), "binary": str(binary), "binary_sha256": core.sha256_file(binary),
                "tree_sha256": core.inventory_digest(records), "files": records, "updater_disabled": True,
                "code_signing": {"identity": identity, "kind": "ad-hoc" if identity == "-" else "certificate",
                                 "verified": True, "verification": "codesign --verify --deep --strict", "notarized": False}}
    core.atomic_json(root / "manifest.json", manifest)
    core.make_read_only(root)
    icon = test.root / build.MAC_PLAYGROUND_ICON
    icon.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ICON_SOURCE, icon)
    return manifest


def edit_receipt(path, changes):
    parent_mode = path.parent.stat().st_mode
    path.parent.chmod(parent_mode | 0o200)
    path.chmod(0o600)
    value = core.read_json(path)
    value.update(changes)
    try:
        core.atomic_json(path, value)
        path.chmod(0o400)
    finally:
        path.parent.chmod(parent_mode)
    return value


class PlaygroundArtifactTests(SandboxTest):
    def setUp(self):
        super().setUp()
        for target, options in [("build.platform.system", {"return_value": "Darwin"}),
                                ("build.verify_mac_signature", {"return_value": True})]:
            mock = patch(target, **options)
            mock.start()
            self.addCleanup(mock.stop)

    def derive(self, sha=FORK):
        with patch.object(self.ctx.runner, "run", return_value=completed()):
            return build.prepare_playground_artifact(self.ctx, sha)

    def test_separate_sealed_manifest_preserves_every_main_byte_and_permission(self):
        base = base_artifact(self)
        root = self.ctx.local / "artifacts" / FORK
        before = {str(item.relative_to(root)): (item.read_bytes() if item.is_file() else None, item.stat().st_mode)
                  for item in [root, *root.rglob("*")]}
        variant = self.derive()
        after = {str(item.relative_to(root)): (item.read_bytes() if item.is_file() else None, item.stat().st_mode)
                 for item in [root, *root.rglob("*")]}
        self.assertEqual(before, after)
        self.assertEqual(build.verify_artifact(self.ctx, FORK), base)
        self.assertEqual(variant["variant"], "playground")
        self.assertEqual(variant["base_binary_sha256"], base["binary_sha256"])
        self.assertEqual(variant["base_tree_sha256"], base["tree_sha256"])
        self.assertNotEqual(variant["tree_sha256"], base["tree_sha256"])
        self.assertEqual(variant["base_artifact_manifest"], str(root / "manifest.json"))
        info = plistlib.loads((Path(variant["bundle"]) / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], "io.ozio.zen.playground")
        self.assertEqual(info["CFBundleName"], "Zen Playground")
        self.assertEqual(info["CFBundleDisplayName"], "Zen Playground")
        self.assertNotIn("CFBundleIconName", info)
        self.assertEqual(info["LSMinimumSystemVersion"], "10.15")
        for key in build.MAC_PLAYGROUND_HANDLER_KEYS:
            self.assertNotIn(key, info)
        icon = Path(variant["bundle"]) / "Contents/Resources/zen-playground.icns"
        self.assertEqual(icon.read_bytes(), ICON_SOURCE.read_bytes())
        self.assertEqual(variant["branding"]["icon_sha256"], core.sha256_file(ICON_SOURCE))
        variant_root = build.playground_artifact_path(self.ctx, FORK).parent
        self.assertTrue(all(not item.stat().st_mode & 0o222 for item in [variant_root, *variant_root.rglob("*")]))

    def test_exact_authorized_certificate_reused_after_identity_and_icon_edits(self):
        identity = "A" * 40
        base_artifact(self, identity=identity)

        def sign(args, _cwd):
            self.assertEqual(args[:6], ["/usr/bin/codesign", "--force", "--deep",
                                       "--preserve-metadata=entitlements,flags,runtime", "--sign", identity])
            pending = Path(args[-1])
            info = plistlib.loads((pending / "Contents/Info.plist").read_bytes())
            self.assertEqual(info["CFBundleIdentifier"], build.MAC_PLAYGROUND_BUNDLE_ID)
            self.assertEqual((pending / "Contents/Resources/zen-playground.icns").read_bytes(), ICON_SOURCE.read_bytes())
            for key in build.MAC_PLAYGROUND_HANDLER_KEYS:
                self.assertNotIn(key, info)
            return completed()

        with patch.object(self.ctx.runner, "run", side_effect=sign) as signer:
            variant = build.prepare_playground_artifact(self.ctx, FORK)
        self.assertEqual(signer.call_count, 1)
        self.assertEqual(variant["code_signing"]["identity"], identity)

    def test_reuses_existing_variant_without_copy_or_sign(self):
        base_artifact(self)
        variant = self.derive()
        with patch("build.copy_tree") as copy, patch.object(self.ctx.runner, "run") as sign:
            self.assertEqual(build.prepare_playground_artifact(self.ctx, FORK), variant)
        copy.assert_not_called()
        sign.assert_not_called()

    def test_same_sha_with_different_icon_is_refused_without_overwrite(self):
        base_artifact(self)
        self.derive()
        manifest_path = build.playground_artifact_path(self.ctx, FORK)
        before = manifest_path.read_bytes()
        icon = self.root / build.MAC_PLAYGROUND_ICON
        # A differently encoded, structurally complete icon with the same header.
        data = bytearray(icon.read_bytes())
        data[-1] ^= 1
        icon.write_bytes(data)
        with self.assertRaisesRegex(core.DevError, "different icon"):
            build.prepare_playground_artifact(self.ctx, FORK)
        self.assertEqual(manifest_path.read_bytes(), before)

    def test_base_mutation_refused_before_copy_or_sign(self):
        base = base_artifact(self)
        binary = Path(base["binary"])
        binary.chmod(0o755)
        binary.write_bytes(b"modified base")
        with patch("build.copy_tree") as copy, patch.object(self.ctx.runner, "run") as sign:
            with self.assertRaisesRegex(core.DevError, "Immutable artifact files changed"):
                build.prepare_playground_artifact(self.ctx, FORK)
        copy.assert_not_called()
        sign.assert_not_called()

    def test_failed_resigning_retains_pending_and_preserves_main(self):
        base = base_artifact(self)
        before = core.tree_inventory(Path(base["bundle"]))
        with patch.object(self.ctx.runner, "run", side_effect=core.DevError("signing failed")):
            with self.assertRaisesRegex(core.DevError, "signing failed"):
                build.prepare_playground_artifact(self.ctx, FORK)
        self.assertFalse(build.playground_artifact_path(self.ctx, FORK).exists())
        self.assertEqual(core.tree_inventory(Path(base["bundle"])), before)
        self.assertEqual(len(list((self.ctx.local / "playground-artifacts").glob(".pending-*"))), 1)

    def test_missing_unverified_or_unpinned_base_identity_refused(self):
        base_artifact(self)
        path = self.ctx.local / "artifacts" / FORK / "manifest.json"
        for metadata in [{}, {"identity": "friendly certificate", "kind": "certificate", "verified": True},
                         {"identity": "-", "kind": "ad-hoc", "verified": False},
                         {"identity": "-", "kind": "certificate", "verified": True}]:
            with self.subTest(metadata=metadata):
                edit_receipt(path, {"code_signing": metadata})
                with self.assertRaisesRegex(core.DevError, "verified exact macOS signing identity"):
                    self.derive()
        self.assertFalse(build.playground_artifact_path(self.ctx, FORK).exists())

    def test_foreign_base_signing_or_variant_provenance_is_refused(self):
        base_artifact(self)
        self.derive()
        path = build.playground_artifact_path(self.ctx, FORK)
        original = core.read_json(path)
        for changes in [{"base_artifact_manifest": "/foreign/manifest.json"}, {"base_binary_sha256": "0" * 64},
                        {"base_tree_sha256": "0" * 64}, {"variant": "main"},
                        {"code_signing": dict(original["code_signing"], identity="B" * 40)}]:
            with self.subTest(changes=changes):
                edit_receipt(path, dict(original, **changes))
                with self.assertRaisesRegex(core.DevError, "provenance/signing"):
                    build.verify_playground_artifact(self.ctx, FORK)

    def test_handler_or_main_identifier_refused_even_with_refreshed_inventory(self):
        base_artifact(self)
        variant = self.derive()
        bundle = Path(variant["bundle"])
        plist = bundle / "Contents/Info.plist"
        original = plist.read_bytes()
        for change in [{"CFBundleIdentifier": "app.zen-browser.zen"},
                       {"CFBundleURLTypes": []}, {"CFBundleDocumentTypes": []}, {"NSUserActivityTypes": []}]:
            with self.subTest(change=change):
                plist.chmod(0o600)
                info = plistlib.loads(original)
                info.update(change)
                plist.write_bytes(plistlib.dumps(info))
                plist.chmod(0o400)
                records = core.tree_inventory(bundle)
                edit_receipt(build.playground_artifact_path(self.ctx, FORK),
                             {"files": records, "tree_sha256": core.inventory_digest(records)})
                with self.assertRaisesRegex(core.DevError, "identity/icon|must not register"):
                    build.verify_playground_artifact(self.ctx, FORK)

    def test_variant_paths_and_writable_files_are_refused(self):
        base = base_artifact(self)
        variant = self.derive()
        path = build.playground_artifact_path(self.ctx, FORK)
        edit_receipt(path, {"bundle": base["bundle"], "binary": base["binary"]})
        with self.assertRaisesRegex(core.DevError, "paths escape"):
            build.verify_playground_artifact(self.ctx, FORK)
        edit_receipt(path, variant)
        Path(variant["binary"]).chmod(0o755)
        with self.assertRaisesRegex(core.DevError, "writable files"):
            build.verify_playground_artifact(self.ctx, FORK)

    def test_symlinked_icon_or_artifact_directory_refused(self):
        base_artifact(self)
        icon = self.root / build.MAC_PLAYGROUND_ICON
        icon.unlink()
        icon.symlink_to(ICON_SOURCE)
        with self.assertRaisesRegex(core.DevError, "symlink"):
            self.derive()
        icon.unlink()
        shutil.copyfile(ICON_SOURCE, icon)
        foreign = self.base / "foreign-artifacts"
        foreign.mkdir()
        (self.ctx.local / "playground-artifacts").symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(core.DevError, "symlink"):
            self.derive()

    def test_missing_or_truncated_icon_refused_before_copy_and_sign(self):
        base_artifact(self)
        icon = self.root / build.MAC_PLAYGROUND_ICON
        with patch("build.copy_tree") as copy, patch.object(self.ctx.runner, "run") as sign:
            icon.unlink()
            with self.assertRaisesRegex(core.DevError, "icon is missing"):
                build.prepare_playground_artifact(self.ctx, FORK)
            for data in [b"not an icon", b"icns\x00\x00\x00\x08", b"icns\x00\x00\x00\x09x",
                         b"icns\x00\x00\x00\x10ic10\x00\x00\x00\x30"]:
                icon.write_bytes(data)
                with self.assertRaisesRegex(core.DevError, "icon"):
                    build.prepare_playground_artifact(self.ctx, FORK)
        copy.assert_not_called()
        sign.assert_not_called()
        self.assertFalse(build.playground_artifact_path(self.ctx, FORK).exists())

    def test_consumable_cache_markers_removed_only_from_derived_copy(self):
        base = base_artifact(self)
        resources = Path(base["bundle"]) / "Contents/Resources"
        resources.chmod(0o700)
        (resources / ".purgecaches").write_text("development marker")
        records = core.tree_inventory(Path(base["bundle"]))
        edit_receipt(self.ctx.local / "artifacts" / FORK / "manifest.json",
                     {"files": records, "tree_sha256": core.inventory_digest(records)})
        core.make_read_only(self.ctx.local / "artifacts" / FORK)
        variant = self.derive()
        self.assertTrue((resources / ".purgecaches").exists())
        self.assertEqual(list(Path(variant["bundle"]).rglob(".purgecaches")), [])

    def test_main_installer_never_accepts_playground_manifest_or_digest_as_base_proof(self):
        base = base_artifact(self)
        variant = self.derive()
        proof = self.ctx.local / "compatibility" / (FORK + ".json")
        core.atomic_json(proof, {"schema_version": 1, "source_sha": FORK, "result": "pass",
                                "artifact_manifest": str(build.playground_artifact_path(self.ctx, FORK)),
                                "binary_sha256": variant["binary_sha256"], "platform": core.host_platform(),
                                "profile": str(self.ctx.local / "profiles/playground")})
        with self.assertRaisesRegex(core.DevError, "does not match"):
            deploy.compatibility(self.ctx, base, proof)
        main_path = self.ctx.local / "artifacts" / FORK / "manifest.json"
        edit_receipt(main_path, {"variant": "playground"})
        with self.assertRaisesRegex(core.DevError, "Main artifact cannot"):
            build.verify_artifact(self.ctx, FORK)

    def test_compatibility_links_distinct_variant_and_base_without_changing_legacy_receipts(self):
        base = base_artifact(self)

        def changed_signature(args, _cwd):
            binary = Path(args[-1]) / "Contents/MacOS/zen"
            binary.write_bytes(binary.read_bytes() + b"new signature bytes")
            return completed()

        with patch.object(self.ctx.runner, "run", side_effect=changed_signature):
            variant = build.prepare_playground_artifact(self.ctx, FORK)
        self.assertNotEqual(base["binary_sha256"], variant["binary_sha256"])
        proof = self.ctx.local / "compatibility" / (FORK + ".json")
        receipt = {"schema_version": 1, "source_sha": FORK, "result": "pass",
                   "artifact_manifest": str(self.ctx.local / "artifacts" / FORK / "manifest.json"),
                   "binary_sha256": base["binary_sha256"], "platform": core.host_platform(),
                   "profile": str(self.ctx.local / "profiles/playground"), "verified_at": core.utc_now(),
                   "checks": {key: True for key in deploy.REQUIRED_CHECKS}}
        core.atomic_json(proof, receipt)
        self.assertEqual(deploy.compatibility(self.ctx, base, proof), receipt)
        tested = {"artifact_manifest": str(build.playground_artifact_path(self.ctx, FORK)),
                  "binary_sha256": variant["binary_sha256"], "tree_sha256": variant["tree_sha256"],
                  "base_artifact_manifest": receipt["artifact_manifest"], "base_binary_sha256": base["binary_sha256"],
                  "base_tree_sha256": base["tree_sha256"]}
        receipt["tested_playground"] = tested
        core.atomic_json(proof, receipt)
        self.assertEqual(deploy.compatibility(self.ctx, base, proof), receipt)
        for field in tested:
            with self.subTest(field=field):
                wrong = dict(tested, **{field: "wrong manifest or digest"})
                core.atomic_json(proof, dict(receipt, tested_playground=wrong))
                with self.assertRaisesRegex(core.DevError, "Tested Playground proof does not match"):
                    deploy.compatibility(self.ctx, base, proof)
        for wrong in [None, [], dict(tested, artifact_manifest=receipt["artifact_manifest"]),
                      dict(tested, binary_sha256=base["binary_sha256"])]:
            with self.subTest(wrong=wrong):
                core.atomic_json(proof, dict(receipt, tested_playground=wrong))
                with self.assertRaisesRegex(core.DevError, "Tested Playground proof does not match"):
                    deploy.compatibility(self.ctx, base, proof)
        for wrong in [{"artifact_manifest": tested["artifact_manifest"]},
                      {"binary_sha256": variant["binary_sha256"]}]:
            with self.subTest(top_level=wrong):
                core.atomic_json(proof, dict(receipt, **wrong))
                with self.assertRaisesRegex(core.DevError, "Compatibility proof does not match"):
                    deploy.compatibility(self.ctx, base, proof)

    def test_staging_refuses_a_main_manifest_even_when_variant_exists(self):
        base = base_artifact(self)
        self.derive()
        with patch("build.copy_tree") as copy, patch("build.assert_stopped") as stopped:
            with self.assertRaisesRegex(core.DevError, "staging input differs"):
                build.stage_mac_playground(self.ctx, base)
        copy.assert_not_called()
        stopped.assert_not_called()

    def test_owned_legacy_copy_migrates_to_variant_with_same_source_sha(self):
        base = base_artifact(self)
        variant = self.derive()
        applications = self.base / "Applications"
        applications.mkdir()
        target = applications / "Zen Playground.app"
        core.copy_tree(Path(base["bundle"]), target)
        current = self.ctx.local / "deployments/playground/current.json"
        old = {"schema_version": 1, "source_sha": FORK, "root": str(self.root),
               "bundle": str(target), "binary": str(target / "Contents/MacOS/zen"),
               "artifact_manifest": str(self.ctx.local / "artifacts" / FORK / "manifest.json"),
               "binary_sha256": base["binary_sha256"], "tree_sha256": base["tree_sha256"]}
        core.atomic_json(current, old)
        core.atomic_json(current.with_name(FORK + ".json"), old)
        with patch("build.MAC_PLAYGROUND_APP", target), patch("build.assert_stopped"), \
                patch("build._register_mac_playground") as register:
            deployed = build.stage_mac_playground(self.ctx, variant)
        receipt = core.read_json(Path(deployed["deployment_manifest"]))
        self.assertEqual(receipt["variant"], "playground")
        self.assertEqual(receipt["base_artifact_manifest"], old["artifact_manifest"])
        self.assertEqual(core.tree_inventory(target), variant["files"])
        self.assertEqual(core.read_json(current), receipt)
        self.assertEqual([call.kwargs["register"] for call in register.call_args_list], [False, True])

    def test_launchservices_registration_failure_restores_old_copy_and_receipt(self):
        base_artifact(self)
        old = self.derive()
        base_artifact(self, sha=BASE)
        candidate = self.derive(BASE)
        applications = self.base / "Applications"
        applications.mkdir()
        target = applications / "Zen Playground.app"
        with patch("build.MAC_PLAYGROUND_APP", target), patch("build.assert_stopped"), \
                patch("build._register_mac_playground"):
            build.stage_mac_playground(self.ctx, old)
        current = self.ctx.local / "deployments/playground/current.json"
        before = current.read_bytes()
        events = []

        def register(_ctx, path, *, register):
            events.append((register, plistlib.loads((path / "Contents/Info.plist").read_bytes())["CFBundleIdentifier"]))
            if len(events) == 2:
                raise core.DevError("new LS registration failed")

        with patch("build.MAC_PLAYGROUND_APP", target), patch("build.assert_stopped"), \
                patch("build._register_mac_playground", side_effect=register):
            with self.assertRaisesRegex(core.DevError, "new LS registration failed"):
                build.stage_mac_playground(self.ctx, candidate)
        self.assertEqual([event[0] for event in events], [False, True, False, True])
        self.assertEqual(current.read_bytes(), before)
        self.assertEqual(core.tree_inventory(target), old["files"])
        self.assertEqual(len(list(applications.glob(".zen-playground-pending-*.app"))), 1)

    def test_launchservices_unregistration_failure_preserves_owned_app(self):
        base = base_artifact(self)
        candidate = self.derive()
        applications = self.base / "Applications"
        applications.mkdir()
        target = applications / "Zen Playground.app"
        core.copy_tree(Path(base["bundle"]), target)
        current = self.ctx.local / "deployments/playground/current.json"
        receipt = {"schema_version": 1, "source_sha": FORK, "root": str(self.root),
                   "bundle": str(target), "binary": str(target / "Contents/MacOS/zen"),
                   "artifact_manifest": str(self.ctx.local / "artifacts" / FORK / "manifest.json"),
                   "binary_sha256": base["binary_sha256"], "tree_sha256": base["tree_sha256"]}
        core.atomic_json(current, receipt)
        before = current.read_bytes()
        with patch("build.MAC_PLAYGROUND_APP", target), patch("build.assert_stopped"), \
                patch("build._register_mac_playground", side_effect=[core.DevError("unregister failed"), None]) as register:
            with self.assertRaisesRegex(core.DevError, "unregister failed"):
                build.stage_mac_playground(self.ctx, candidate)
        self.assertEqual([call.kwargs["register"] for call in register.call_args_list], [False, True])
        self.assertEqual(core.tree_inventory(target), base["files"])
        self.assertEqual(current.read_bytes(), before)

    def test_launchservices_command_is_scoped_and_never_changes_default_handler(self):
        with patch.object(self.ctx.runner, "run", return_value=completed()) as run:
            build._register_mac_playground(self.ctx, build.MAC_PLAYGROUND_APP, register=False)
            build._register_mac_playground(self.ctx, build.MAC_PLAYGROUND_APP, register=True)
        self.assertEqual([call.args[0] for call in run.call_args_list],
                         [[str(build.MAC_LSREGISTER), "-u", str(build.MAC_PLAYGROUND_APP)],
                          [str(build.MAC_LSREGISTER), "-f", str(build.MAC_PLAYGROUND_APP)]])
        with self.assertRaisesRegex(core.DevError, "not the owned Playground"):
            build._register_mac_playground(self.ctx, Path("/Applications/Zen.app"), register=True)

    def test_copy_corruption_is_refused_before_changing_owned_app_or_launchservices(self):
        base_artifact(self)
        variant = self.derive()
        applications = self.base / "Applications"
        applications.mkdir()
        target = applications / "Zen Playground.app"

        def broken_copy(source, destination):
            core.copy_tree(source, destination)
            binary = destination / "Contents/MacOS/zen"
            binary.chmod(0o755)
            binary.write_bytes(b"corrupted copy")

        with patch("build.MAC_PLAYGROUND_APP", target), patch("build.assert_stopped"), \
                patch("build.copy_tree", side_effect=broken_copy), patch("build._register_mac_playground") as register:
            with self.assertRaisesRegex(core.DevError, "copy is incomplete"):
                build.stage_mac_playground(self.ctx, variant)
        register.assert_not_called()
        self.assertFalse(target.exists())
        self.assertFalse((self.ctx.local / "deployments/playground/current.json").exists())

    def test_unowned_app_appearing_during_copy_is_preserved_without_registration(self):
        base_artifact(self)
        variant = self.derive()
        applications = self.base / "Applications"
        applications.mkdir()
        target = applications / "Zen Playground.app"

        def copy_with_race(source, destination):
            core.copy_tree(source, destination)
            target.mkdir()
            (target / "unrelated.txt").write_text("preserve unrelated app")

        with patch("build.MAC_PLAYGROUND_APP", target), patch("build.assert_stopped"), \
                patch("build.copy_tree", side_effect=copy_with_race), patch("build._register_mac_playground") as register:
            with self.assertRaisesRegex(core.DevError, "unowned Playground application appeared"):
                build.stage_mac_playground(self.ctx, variant)
        register.assert_not_called()
        self.assertEqual((target / "unrelated.txt").read_text(), "preserve unrelated app")
        self.assertFalse((self.ctx.local / "deployments/playground/current.json").exists())

    def test_launchservices_recovery_failure_reports_unsatisfied_routing(self):
        base_artifact(self)
        old = self.derive()
        base_artifact(self, sha=BASE)
        candidate = self.derive(BASE)
        applications = self.base / "Applications"
        applications.mkdir()
        target = applications / "Zen Playground.app"
        with patch("build.MAC_PLAYGROUND_APP", target), patch("build.assert_stopped"), \
                patch("build._register_mac_playground"):
            build.stage_mac_playground(self.ctx, old)
        current = self.ctx.local / "deployments/playground/current.json"
        before = current.read_bytes()
        with patch("build.MAC_PLAYGROUND_APP", target), patch("build.assert_stopped"), \
                patch("build._register_mac_playground", side_effect=[None, core.DevError("new registration failed"),
                                                                     None, core.DevError("old registration failed")]):
            with self.assertRaisesRegex(core.DevError, "restored files, but LaunchServices recovery failed"):
                build.stage_mac_playground(self.ctx, candidate)
        self.assertEqual(current.read_bytes(), before)
        self.assertEqual(core.tree_inventory(target), old["files"])

    def test_launch_in_artifact_records_both_manifests_and_postlaunch_signature(self):
        base_artifact(self)
        variant = self.derive()
        process = SimpleNamespace(pid=1234, poll=lambda: None)
        with patch("build.assert_stopped"), patch("build.port_available"), \
                patch("build.subprocess.Popen", return_value=process) as launch, \
                patch("build.socket.create_connection") as connect, \
                patch("build.verify_mac_signature", return_value=True) as signatures:
            connect.return_value.__enter__.return_value.recv.return_value = b'50:{"marionetteProtocol":3}'
            receipt = build.run_playground(self.ctx, SimpleNamespace(sha=FORK, port=2828, in_artifact=True))
        self.assertEqual(launch.call_args.args[0][0], variant["binary"])
        for key in ["base_artifact_manifest", "base_binary_sha256", "base_tree_sha256",
                    "binary_sha256", "tree_sha256", "code_signing"]:
            self.assertEqual(receipt[key], variant[key])
        self.assertEqual(receipt["artifact_manifest"], str(build.playground_artifact_path(self.ctx, FORK)))
        self.assertEqual(receipt["variant"], "playground")
        self.assertEqual(signatures.call_args.args[1], Path(variant["bundle"]))
        self.assertEqual(build.playground_state(self.ctx), receipt)

    def test_non_mac_preparation_refuses_without_creating_local_paths(self):
        with patch("build.platform.system", return_value="Linux"):
            with self.assertRaisesRegex(core.DevError, "only on macOS"):
                build.package_playground(self.ctx, SimpleNamespace(sha=FORK))
        self.assertFalse(self.ctx.local.exists())

    def test_explicit_cli_uses_existing_sha_and_exposes_no_new_signing_selection(self):
        args = dev.parser().parse_args(["package-playground", "--sha", BASE])
        self.assertEqual(args.sha, BASE)
        self.assertEqual(args.command, "package-playground")
        self.assertNotIn("signing_identity", vars(args))


@unittest.skipUnless(sys.platform == "darwin", "real macOS ad hoc signed derivative fixture")
class NativePlaygroundSigningTests(SandboxTest):
    def test_real_variant_signature_nested_metadata_and_main_immutability(self):
        base = base_artifact(self, real_signature=True)
        before = (self.ctx.local / "artifacts" / FORK / "manifest.json").read_bytes()
        with self.ctx.lock():
            variant = build.prepare_playground_artifact(self.ctx, FORK)
        self.assertTrue(core.verify_mac_signature(self.ctx, Path(variant["bundle"]), required=True))
        shown = self.ctx.runner.run(["/usr/bin/codesign", "--display", "--verbose=4", variant["bundle"]], self.root)
        self.assertIn("Identifier=io.ozio.zen.playground", shown.stderr)
        self.assertIn("runtime", shown.stderr)
        for bundle in [base["bundle"], variant["bundle"]]:
            entitlements = self.ctx.runner.run(["/usr/bin/codesign", "--display", "--entitlements", "-", "--xml", bundle], self.root)
            self.assertEqual(plistlib.loads(entitlements.stdout.encode()), {"com.apple.security.cs.allow-jit": True})
        helper = Path(variant["bundle"]) / "Contents/MacOS/helper.sh"
        self.ctx.runner.run(["/usr/bin/codesign", "--verify", "--strict", str(helper)], self.root)
        self.assertNotEqual(variant["binary_sha256"], base["binary_sha256"])
        self.assertEqual((self.ctx.local / "artifacts" / FORK / "manifest.json").read_bytes(), before)
        self.assertEqual(build.verify_artifact(self.ctx, FORK), base)
        applications = self.base / "Applications"
        applications.mkdir()
        target = applications / "Zen Playground.app"
        with patch("build.MAC_PLAYGROUND_APP", target), patch("build.assert_stopped"), \
                patch("build._register_mac_playground"):
            deployed = build.stage_mac_playground(self.ctx, variant)
        self.assertTrue(core.verify_mac_signature(self.ctx, Path(deployed["bundle"]), required=True))
        self.ctx.runner.run(["/usr/bin/codesign", "--verify", "--strict", str(target / "Contents/MacOS/helper.sh")], self.root)
        self.assertEqual(core.tree_inventory(target), variant["files"])


if __name__ == "__main__":
    unittest.main()
