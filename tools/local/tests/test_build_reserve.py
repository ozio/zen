"""A low-space UI rebuild must never permit new native inputs or a clean build."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import incremental_disk_baseline, dynamic_pip_preferences
from core import Context, DevError, host_platform, sha256_file


class BuildReserveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.root / ".gitignore").write_text("engine/\n.zen-local/\n")
        self.write("src/feature.mjs", "export const value = 1;\n")
        self.commit()
        self.ctx = Context(self.root)
        self.base = self.ctx.sha()
        self.chain = {"pins": {"rust": "fixture"}}
        self.obj = self.root / "engine/obj-fixture"
        self.write("engine/obj-fixture/config.status", "fixture\n")
        self.write("engine/obj-fixture/dist/bin/zen", "fixture\n")
        self.write("engine/mozconfig", "unchanged native config\n")
        self.receipt = self.root / ".zen-local/builds" / self.base / "build.json"
        self.write(str(self.receipt.relative_to(self.root)), json.dumps({
            "result": "pass", "ui_only": False, "source_sha": self.base,
            "source_snapshot": {"status": ""}, "platform": host_platform(),
            "engine": str(self.root / "engine"), "object_dirs": [str(self.obj)],
            "toolchains": self.chain, "mozconfig_sha256": sha256_file(self.root / "engine/mozconfig"),
        }))

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def test_committed_js_change_can_use_matching_full_baseline(self):
        self.write("src/feature.mjs", "export const value = 2;\n")
        self.commit()
        self.assertEqual(incremental_disk_baseline(self.ctx, self.chain, 4), self.base)

    def test_native_patch_cannot_hide_under_ui_filename(self):
        self.write("src/innocent-js.patch", "--- a/widget/native.mm\n+++ b/widget/native.mm\n@@ -1 +1 @@\n-old\n+new\n")
        self.commit()
        with self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 4)

    def cocoa_patch(self, target="widget/cocoa/nsCocoaWindow.mm"):
        self.write("src/widget/cocoa/native.patch",
                   "--- a/%s\n+++ b/%s\n@@ -1 +1 @@\n-old\n+new\n" % (target, target))
        self.commit()

    def cocoa_baseline(self):
        receipt = json.loads(self.receipt.read_text())
        receipt["platform"] = {"system": "Darwin", "machine": "arm64"}
        self.receipt.write_text(json.dumps(receipt))
        return patch("build.host_platform", return_value=receipt["platform"])

    def test_explicit_cocoa_incremental_requires_eight_gib_and_matching_full_baseline(self):
        self.cocoa_patch()
        with self.cocoa_baseline():
            self.assertEqual(incremental_disk_baseline(self.ctx, self.chain, 8,
                                                      native_incremental=True), self.base)
            with self.assertRaises(DevError):
                incremental_disk_baseline(self.ctx, self.chain, 8)
            with self.assertRaises(DevError):
                incremental_disk_baseline(self.ctx, self.chain, 7, native_incremental=True)
            with self.assertRaises(DevError):
                incremental_disk_baseline(self.ctx, {"pins": {"rust": "changed"}}, 8,
                                          native_incremental=True)

    def test_other_native_patch_targets_are_refused_even_under_cocoa_filename(self):
        self.cocoa_patch("dom/bindings/native.cpp")
        with self.cocoa_baseline(), self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 8, native_incremental=True)

    def test_idl_and_configuration_changes_still_require_normal_reserve(self):
        self.cocoa_patch()
        self.write("src/dom/native.patch", "--- a/dom/webidl/Window.webidl\n+++ b/dom/webidl/Window.webidl\n@@ -1 +1 @@\n-old\n+new\n")
        self.commit()
        with self.cocoa_baseline(), self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 8, native_incremental=True)

    def test_cocoa_incremental_rejects_non_mac_platform(self):
        self.cocoa_patch()
        with patch("build.host_platform", return_value={"system": "Linux", "machine": "x86_64"}), self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 8, native_incremental=True)

    def test_cocoa_incremental_rejects_ui_build_and_excess_parallelism(self):
        from types import SimpleNamespace
        from build import build
        for ui, jobs in ((True, 1), (False, 3)):
            with self.assertRaisesRegex(DevError, "full mach build"):
                build(self.ctx, SimpleNamespace(ui=ui, jobs=jobs, native_incremental=True))

    def test_fresh_import_source_stamp_is_metadata_but_other_config_changes_are_refused(self):
        self.write("engine/mozconfig", "export MOZ_SOURCE_CHANGESET=%s\nunchanged native config\n" % self.base)
        receipt = json.loads(self.receipt.read_text())
        receipt["mozconfig_sha256"] = sha256_file(self.root / "engine/mozconfig")
        self.receipt.write_text(json.dumps(receipt))
        self.cocoa_patch()
        self.write("engine/mozconfig", "export MOZ_SOURCE_CHANGESET=%s\nunchanged native config\n" % self.ctx.sha())
        with self.cocoa_baseline():
            self.assertEqual(incremental_disk_baseline(self.ctx, self.chain, 8,
                                                      native_incremental=True), self.base)
            self.write("engine/mozconfig", "export MOZ_SOURCE_CHANGESET=%s\nchanged compiler flag\n" % self.ctx.sha())
            with self.assertRaises(DevError):
                incremental_disk_baseline(self.ctx, self.chain, 8, native_incremental=True)

    def test_ambiguous_source_stamp_is_not_ignored(self):
        self.write("engine/mozconfig", "export MOZ_SOURCE_CHANGESET=%s\n" % self.base)
        receipt = json.loads(self.receipt.read_text())
        receipt["mozconfig_sha256"] = sha256_file(self.root / "engine/mozconfig")
        self.receipt.write_text(json.dumps(receipt))
        self.cocoa_patch()
        self.write("engine/mozconfig", "export MOZ_SOURCE_CHANGESET=%s\nexport MOZ_SOURCE_CHANGESET=%s\n" % (self.ctx.sha(), self.ctx.sha()))
        with self.cocoa_baseline(), self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 8, native_incremental=True)

    def test_preferences_need_normal_reserve(self):
        self.write("prefs/zen/test.yaml", "- name: zen.test\n  value: true\n")
        self.commit()
        with self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 4)

    def pip_baseline(self):
        self.pip_text = "- name: zen.pip.trackpad.enabled\n  value: true\n"
        for name, value in (("fling-speed",1200),("fling-distance",24),("snap-duration-ms",180)):
            self.pip_text += "- name: zen.pip.trackpad.%s\n  value: %s\n" % (name,value)
        self.write("prefs/zen/pip.yaml", self.pip_text)
        self.commit()
        receipt = json.loads(self.receipt.read_text())
        self.base = self.ctx.sha()
        receipt["source_sha"] = self.base
        self.receipt = self.root / ".zen-local/builds" / self.base / "build.json"
        self.write(str(self.receipt.relative_to(self.root)), json.dumps(receipt))

    def test_only_known_dynamic_pip_values_can_share_cocoa_incremental_baseline(self):
        self.pip_baseline()
        tuned = self.pip_text.replace("1200", "650").replace("24", "12")
        tuned += "- name: zen.pip.trackpad.edge-padding\n  value: 16\n"
        self.write("prefs/zen/pip.yaml", tuned)
        self.commit()
        with self.cocoa_baseline():
            self.assertEqual(incremental_disk_baseline(self.ctx,self.chain,8,native_incremental=True),self.base)
            with self.assertRaises(DevError):
                incremental_disk_baseline(self.ctx,self.chain,8)

    def test_static_rust_unknown_and_duplicate_prefs_cannot_use_runtime_exception(self):
        self.pip_baseline()
        for extra in ("  type: static\n", "  type: rust\n", "  mirror: always\n",
                      "- name: zen.pip.trackpad.native\n  value: 1\n",
                      "- name: zen.pip.trackpad.enabled\n  value: true\n"):
            self.assertFalse(dynamic_pip_preferences(self.pip_text+extra))
        self.write("prefs/zen/pip.yaml",self.pip_text+"  type: static\n")
        self.commit()
        with self.cocoa_baseline(), self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx,self.chain,8,native_incremental=True)

    def test_other_pref_file_and_native_pip_baseline_still_require_normal_reserve(self):
        self.pip_baseline()
        self.write("prefs/zen/other.yaml","- name: zen.other\n  value: true\n")
        self.commit()
        with self.cocoa_baseline(), self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx,self.chain,8,native_incremental=True)

    def test_dynamic_pref_parser_rejects_executable_or_wrong_type_values(self):
        self.pip_baseline()
        for value in ("\"650\"", "-1", "2147483648", "650\n  type: static", "true"):
            self.assertFalse(dynamic_pip_preferences(self.pip_text.replace("1200",value)))
        self.assertFalse(dynamic_pip_preferences(self.pip_text.replace("true","1")))

    def test_missing_objects_changed_config_or_tools_are_refused(self):
        with self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, {"pins": {"rust": "different"}}, 4)
        self.write("engine/mozconfig", "changed native config\n")
        with self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 4)
        (self.obj / "dist/bin/zen").unlink()
        with self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 4)

    def test_dirty_source_and_zero_reserve_are_refused(self):
        self.write("src/feature.mjs", "uncommitted\n")
        with self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 4)
        with self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 0)
        self.assertIsNone(incremental_disk_baseline(self.ctx, self.chain, 15))


if __name__ == "__main__":
    unittest.main()
