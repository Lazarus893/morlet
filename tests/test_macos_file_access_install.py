"""Installer boundaries; does not open a picker or change OS permissions."""
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "file_access_installer", Path(__file__).resolve().parents[1] / "scripts/install-macos-file-access.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class NativeFileAccessInstallation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        (self.root / "scripts/macos-file-access.swift").write_text("fixture source")
        self.calls = []

    def fake_run(self, command):
        self.calls.append(command)
        if command[0] == "/usr/bin/xcrun":
            Path(command[-1]).write_bytes(b"fixture binary")

    def test_signed_sandboxed_install_and_unchanged_reinstall(self):
        with patch.object(installer.sys, "platform", "darwin"), patch.object(installer, "run", self.fake_run):
            binary = installer.install(self.root)
            self.assertTrue(binary.is_file())
            app = binary.parents[2]
            info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
            self.assertEqual(info["CFBundleIdentifier"], "com.xiaoman.file-access")
            sign = next(row for row in self.calls if "--sign" in row)
            self.assertIn("--entitlements", sign)
            self.assertTrue(installer.ENTITLEMENTS["com.apple.security.app-sandbox"])
            self.assertTrue(installer.ENTITLEMENTS["com.apple.security.files.user-selected.read-only"])
            self.assertNotIn("com.apple.security.files.user-selected.read-write", installer.ENTITLEMENTS)
            first_stat = binary.stat()
            self.calls.clear()
            self.assertEqual(installer.install(self.root), binary)
            self.assertEqual(binary.stat().st_ino, first_stat.st_ino)
            self.assertEqual(len(self.calls), 2)
            self.assertIn("--verify", self.calls[0])
            self.assertEqual(self.calls[1], [installer.LSREGISTER, "-f", str(app)])
            self.assertFalse(any("authorize" in row for row in self.calls))
            metadata = app.parent / "installation.json"
            self.assertEqual(metadata.stat().st_mode & 0o777, 0o600)
            self.assertEqual(app.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(json.loads(metadata.read_text())["signing"], "ad-hoc-local")

    def test_sign_failure_keeps_previous_working_app(self):
        with patch.object(installer.sys, "platform", "darwin"), patch.object(installer, "run", self.fake_run):
            binary = installer.install(self.root)
        (self.root / "scripts/macos-file-access.swift").write_text("new source")

        def failure(command):
            self.fake_run(command)
            if "--sign" in command:
                raise subprocess.CalledProcessError(1, command)

        with patch.object(installer.sys, "platform", "darwin"), patch.object(installer, "run", failure):
            with self.assertRaises(subprocess.CalledProcessError):
                installer.install(self.root)
        self.assertEqual(binary.read_bytes(), b"fixture binary")
        self.assertFalse(list(binary.parents[3].glob("previous-*.app")))

    def test_not_a_mac_has_no_artifacts_or_commands(self):
        with patch.object(installer.sys, "platform", "linux"), patch.object(installer, "run", self.fake_run):
            with self.assertRaises(ValueError):
                installer.install(self.root)
        self.assertFalse((self.root / ".runtime").exists())
        self.assertEqual(self.calls, [])

    def test_registration_failure_does_not_rebuild_signed_app(self):
        with patch.object(installer.sys, "platform", "darwin"), patch.object(installer, "run", self.fake_run):
            binary = installer.install(self.root)
        before = binary.stat().st_ino
        self.calls.clear()

        def failure(command):
            self.fake_run(command)
            if command[0] == installer.LSREGISTER:
                raise subprocess.CalledProcessError(1, command)

        with patch.object(installer.sys, "platform", "darwin"), patch.object(installer, "run", failure):
            with self.assertRaises(subprocess.CalledProcessError):
                installer.install(self.root)
        self.assertEqual(binary.stat().st_ino, before)
        self.assertFalse(any(command[0] == "/usr/bin/xcrun" or "--sign" in command for command in self.calls))


if __name__ == "__main__":
    unittest.main()
