import difflib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import Context, DevError
from imports import prepare_external_overlays


class ImportPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zen-import-order-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.engine = self.root / "engine"
        self.engine.mkdir()
        subprocess.run(["git", "init", "-q", str(self.engine)], check=True)
        self.ctx = Context(self.root)
        self.env = dict(os.environ)
        self.file = self.engine / "sample.js"
        self.base = "\n".join(["first", "second", "third", "fourth", *[f"line {i}" for i in range(30)]]) + "\n"
        self.external = self.base.replace("second\n", "second\nexternal change\n")
        self.final = self.external.replace("third\n", "canonical overlay\nthird\n")
        self.ext_patch = self.write_patch("src/external-patches/fix.patch", self.base, self.external)
        self.overlay_patch = self.write_patch("src/toolkit/overlay.patch", self.external, self.final)

    def write_patch(self, name, old, new):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("diff --git a/sample.js b/sample.js\n" + "".join(difflib.unified_diff(
            old.splitlines(True), new.splitlines(True), fromfile="a/sample.js", tofile="b/sample.js")))
        return path

    def apply(self, patch, reverse=False, check=False):
        return subprocess.run(["git", "apply", *( ["-R"] if reverse else []),
                               *( ["--check"] if check else []), str(patch)], cwd=self.engine, capture_output=True)

    def test_prepared_engine_reverses_overlay_preserves_other_work_and_reimports_both(self):
        authored = self.final.replace("line 29", "unrelated authored line")
        self.file.write_text(authored)
        # Positive control: the actual overlapping layer breaks a direct reverse.
        self.assertNotEqual(self.apply(self.ext_patch, reverse=True, check=True).returncode, 0)
        receipt = prepare_external_overlays(self.ctx, self.env)
        self.assertEqual(receipt["reversed"], ["src/toolkit/overlay.patch"])
        self.assertEqual((Path(receipt["source_snapshot"]) / "sample.js").read_text(), authored)
        self.assertIn("unrelated authored line", self.file.read_text())
        # Perform Surfer's external reverse/forward, followed by canonical apply.
        self.assertEqual(self.apply(self.ext_patch, reverse=True).returncode, 0)
        self.assertEqual(self.apply(self.ext_patch).returncode, 0)
        self.assertEqual(self.apply(self.overlay_patch).returncode, 0)
        self.assertEqual(self.file.read_text(), authored)

    def test_fresh_engine_without_overlay_is_preserved(self):
        self.file.write_text(self.external)
        receipt = prepare_external_overlays(self.ctx, self.env)
        self.assertEqual(receipt["reversed"], [])
        self.assertEqual(receipt["absent"], ["src/toolkit/overlay.patch"])
        self.assertEqual(self.file.read_text(), self.external)

    def test_fresh_engine_without_external_layer_waits_for_ordered_import(self):
        self.file.write_text(self.base)
        self.assertNotEqual(self.apply(self.overlay_patch, check=True).returncode, 0)
        receipt = prepare_external_overlays(self.ctx, self.env)
        self.assertEqual(receipt["reversed"], [])
        self.assertEqual(receipt["awaiting_external"], ["src/toolkit/overlay.patch"])
        self.assertEqual(self.file.read_text(), self.base)
        self.assertEqual(self.apply(self.ext_patch).returncode, 0)
        self.assertEqual(self.apply(self.overlay_patch).returncode, 0)
        self.assertEqual(self.file.read_text(), self.final)

    def test_conflicting_engine_work_is_retained_and_refused(self):
        authored = self.final.replace("canonical overlay", "unexported modified overlay")
        self.file.write_text(authored)
        with self.assertRaisesRegex(DevError, "neither applied nor unapplied"):
            prepare_external_overlays(self.ctx, self.env)
        self.assertEqual(self.file.read_text(), authored)
        snapshots = list((self.ctx.local / "import-preparation").glob("*/source/sample.js"))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].read_text(), authored)

    def test_symlink_target_refuses_without_touching_external_file(self):
        other = self.root / "unrelated.js"
        other.write_text(self.final)
        self.file.symlink_to(other)
        with self.assertRaisesRegex(DevError, "symlink"):
            prepare_external_overlays(self.ctx, self.env)
        self.assertEqual(other.read_text(), self.final)
