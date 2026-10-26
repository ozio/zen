"""The release pin and retained legacy candidates must select one exact Rust."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import DevError, rust_toolchain_pin


class RustPinTests(unittest.TestCase):
    def test_canonical_toml_and_legacy_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".rust-toolchain").write_text("1.95.0\n")
            self.assertEqual(rust_toolchain_pin(root), "1.95.0")
            (root / "rust-toolchain.toml").write_text('[toolchain]\nchannel = "1.95.0"\n')
            self.assertEqual(rust_toolchain_pin(root), "1.95.0")
            (root / ".rust-toolchain").unlink()
            self.assertEqual(rust_toolchain_pin(root), "1.95.0")

    def test_conflicting_pins_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".rust-toolchain").write_text("1.94.0")
            (root / "rust-toolchain.toml").write_text('[toolchain]\nchannel = "1.95.0"\n')
            with self.assertRaisesRegex(DevError, "Conflicting"):
                rust_toolchain_pin(root)

    def test_unpinned_or_malformed_channels_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for text in ['[toolchain]\nchannel = "stable"', '[toolchain]\nchannel = 195',
                         '[toolchain]\nchannel = "1.95.0', '[other]\nchannel = "1.95.0"']:
                (root / "rust-toolchain.toml").write_text(text)
                with self.assertRaises(DevError):
                    rust_toolchain_pin(root)
