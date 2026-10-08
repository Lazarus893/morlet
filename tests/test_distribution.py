"""Verify relocation and exclusion of private runtime data from distributions."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from configure import configure
from source_files import source_files


class DistributionTests(unittest.TestCase):
    def test_relocated_configuration_and_mutable_data(self):
        with tempfile.TemporaryDirectory(prefix="xiaoman move ") as temporary:
            root = Path(temporary) / "another checkout"
            for source in source_files(ROOT):
                target = root / source.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
            configure(root)
            profile = root / ".runtime/dsh/profiles/wx-life"
            patch = json.loads((profile / "cordis.patch.yml").read_text())
            policy = next(row for row in patch if row.get("id") == "sandbox-policy")
            self.assertEqual(policy["config"]["workspaceRoot"], str(root / ".runtime/workspace"))
            self.assertNotIn(str(ROOT), json.dumps(patch))
            channel = next(row for row in patch if row.get("id") == "weixin-channel")
            self.assertLess(len(channel["config"]["controlSocketPath"].encode()), 100)
            learned = root / ".runtime/workspace/phone-refs/apps/美团.md"
            learned.write_text("new local learning")
            configure(root)
            self.assertEqual(learned.read_text(), "new local learning")
            self.assertEqual((profile / "node_modules").resolve(), (root / "node_modules").resolve())

    def test_private_data_and_build_outputs_are_excluded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixtures = ("README.md", "config/phone.example.json", ".env", ".env.backup",
                        ".runtime/dsh/.credentials.yaml", "memory/2026-10-08.md",
                        "android/local.properties", "android/app/build/debug.apk",
                        "vendor/auto-phone/__pycache__/test.pyc", "skills/foo/.env",
                        "node_modules/some-package/index.js")
            for name in fixtures:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("test")
            selected = {p.relative_to(root).as_posix() for p in source_files(root)}
            self.assertEqual(selected, {"README.md", "config/phone.example.json"})

    def test_external_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "skills").mkdir()
            (root / "skills/external").symlink_to(ROOT / "skills/phone", target_is_directory=True)
            with self.assertRaises(ValueError):
                list(source_files(root))


if __name__ == "__main__":
    unittest.main()
