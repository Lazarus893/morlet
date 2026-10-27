"""Offline checks for the portable default journal designer registration."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "bin"))
from source_files import source_files
from configure import configure
from pa_config import write_config


class JournalConfigTests(unittest.TestCase):
    def test_shared_runtime_module_link_tracks_the_active_release(self):
        with tempfile.TemporaryDirectory(prefix="shared journal ") as temporary:
            base = Path(temporary)
            shared = base / "runtime"
            shared.mkdir()
            for name in ("release-a", "release-b"):
                root = base / name
                root.mkdir()
                for source in source_files(ROOT):
                    target = root / source.relative_to(ROOT)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.read_bytes())
                (root / "node_modules").mkdir()
                (root / ".runtime").symlink_to(shared, target_is_directory=True)
                configure(root)
                link = shared / "dsh/profiles/wx-life/node_modules"
                self.assertTrue(link.is_symlink())
                self.assertEqual(link.resolve(), (root / "node_modules").resolve())
                self.assertTrue(link.exists())

    def test_default_role_survives_source_copy_and_is_registered_for_each_provider(self):
        sources = list(source_files(ROOT))
        self.assertIn("agents/life-journal-designer/AGENT.md", [str(p.relative_to(ROOT)) for p in sources])
        with tempfile.TemporaryDirectory(prefix="portable journal ") as temporary:
            root = Path(temporary)
            for source in sources:
                target = root / source.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
            for provider in ("dsh", "codex", "workbuddy"):
                cfg = json.loads((root / "config/pa.example.json").read_text())
                cfg["agent"]["provider"] = provider
                write_config(cfg, root)
                configure(root)
                registration = json.loads((root / ".runtime/proactive.json").read_text())
                self.assertEqual(registration["journal_root"], str(root))
                role = Path(registration["journal_role"])
                self.assertTrue(role.is_relative_to(root))
                self.assertIn("默认手账设计 Agent", role.read_text())
                self.assertNotIn(".codex", role.read_text())
                instructions = (root / ".runtime/workspace/AGENTS.md").read_text()
                self.assertIn("默认手账设计 Agent", instructions)
                self.assertIn("不要声称普通聊天已自动写入手账", instructions)


if __name__ == "__main__":
    unittest.main()
