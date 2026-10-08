"""A low-space UI rebuild must never permit new native inputs or a clean build."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import incremental_disk_baseline
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

    def test_preferences_need_normal_reserve(self):
        self.write("prefs/zen/test.yaml", "- name: zen.test\n  value: true\n")
        self.commit()
        with self.assertRaises(DevError):
            incremental_disk_baseline(self.ctx, self.chain, 4)

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
