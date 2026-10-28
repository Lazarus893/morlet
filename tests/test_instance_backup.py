import json
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from instance_backup import backup, restore


class InstanceBackupTest(unittest.TestCase):
    def test_backup_rejects_a_state_directory_pointing_outside_the_instance(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); runtime = base / "source/.runtime"; runtime.mkdir(parents=True)
            outside = base / "outside"; outside.mkdir(); (outside / "private.txt").write_text("not part of this instance")
            (runtime / "hub").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError): backup(base / "source", base / "archive.zip")
            self.assertFalse((base / "archive.zip").exists())

    def test_private_sqlite_state_roundtrips_without_overwriting_an_instance(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); source = base / "source"; runtime = source / ".runtime"
            (runtime / "hub").mkdir(parents=True)
            (runtime / "pa.json").write_text('{"owner":"fixture"}')
            with sqlite3.connect(runtime / "hub/hub.sqlite") as db:
                db.execute("CREATE TABLE tasks (id INTEGER, title TEXT)")
                db.execute("INSERT INTO tasks VALUES(1, '待跟进')")
            archive = base / "private.zip"; self.assertEqual(backup(source, archive), 2)
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            target = base / "restored"; self.assertEqual(restore(archive, target), 2)
            with sqlite3.connect(target / ".runtime/hub/hub.sqlite") as db:
                self.assertEqual(db.execute("SELECT title FROM tasks").fetchone()[0], "待跟进")
            with self.assertRaises(ValueError): restore(archive, target)
            with self.assertRaises(ValueError): backup(source, archive)

    def test_tampered_or_escaping_archive_never_creates_instance_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            for name in [".runtime/../escape", ".runtime/pa.json"]:
                archive = base / "invalid.zip"
                with zipfile.ZipFile(archive, "w") as z:
                    z.writestr(name, "changed")
                    z.writestr("manifest.json", json.dumps({"version": 1, "files": [{"path": name, "bytes": 7, "sha256": "wrong"}]}))
                with self.assertRaises(ValueError): restore(archive, base / "target")
                self.assertFalse((base / "target/.runtime").exists())
