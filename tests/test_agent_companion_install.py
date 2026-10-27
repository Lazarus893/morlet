"""Installation contracts; launchctl is replaced, no real services or messages."""
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import subprocess
import sys
import shlex
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "agent_installer", Path(__file__).resolve().parents[1] / "scripts/install-agent-companion.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class AgentCompanionInstallation(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "download.json"
        self.value = {"endpoint": "http://127.0.0.1:3093", "publicOrigin": "https://example.invalid",
                      "token": "a" * 43, "endpointId": "11111111-1111-1111-1111-111111111111",
                      "provider": "codex", "command": "codex", "workspace": str(self.root),
                      "timeout_seconds": 300}
        self.source.write_text(json.dumps(self.value))
        self.calls = []

    def invoke(self, validation_result=0, kind="agent", validation_error=b"", bootstrap_fail=False):
        def run(command, **kwargs):
            self.calls.append(command)
            if command[0] == "/fixture/node":
                config = Path(command[-1])
                self.assertEqual(config.stat().st_mode & 0o777, 0o600)
                self.assertIn("loadAgentConfig" if kind == "agent" else "checkMessageChat(config)", command[-2])
                return SimpleNamespace(returncode=validation_result, stderr=validation_error)
            if bootstrap_fail and command[:2] == ["launchctl", "bootstrap"] and kwargs.get("check"):
                raise subprocess.CalledProcessError(1, command)
            return SimpleNamespace(returncode=0)
        with patch.object(installer, "ROOT", self.root), patch.object(installer.Path, "home", return_value=self.root), \
                patch.object(installer.os, "uname", return_value=SimpleNamespace(sysname="Darwin")), \
                patch.object(installer.shutil, "which", side_effect=lambda name: "/fixture/" + name), \
                patch.object(installer.subprocess, "run", side_effect=run):
            installer.install(SimpleNamespace(config=str(self.source), kind=kind))

    def test_private_import_and_independent_service_per_endpoint(self):
        self.invoke()
        self.value["endpointId"] = "22222222-2222-2222-2222-222222222222"
        self.source.write_text(json.dumps(self.value))
        self.invoke()
        configs = list((self.root / ".runtime").glob("agent-companion-*.json"))
        services = list((self.root / "Library/LaunchAgents").glob("*.plist"))
        self.assertEqual(len(configs), 2)
        self.assertEqual(len(services), 2)
        self.assertEqual(self.source.stat().st_mode & 0o777, 0o600)
        for config in configs:
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        for service in services:
            data = plistlib.loads(service.read_bytes())
            self.assertEqual(data["ProgramArguments"][0], "/fixture/node")
            self.assertNotIn(self.value["token"], service.read_text())
            self.assertEqual(service.stat().st_mode & 0o777, 0o600)

    def test_invalid_config_preserves_previous_connection_without_launchctl(self):
        self.invoke()
        target = next((self.root / ".runtime").glob("agent-companion-*.json"))
        original = target.read_bytes()
        self.calls.clear()
        with self.assertRaises(ValueError):
            self.invoke(validation_result=1)
        self.assertEqual(target.read_bytes(), original)
        self.assertFalse(list((self.root / ".runtime").glob("*.tmp")))
        self.assertFalse(any(command[0] == "launchctl" for command in self.calls))

    def test_plain_http_remote_fails_before_any_command(self):
        self.value["endpoint"] = "http://example.invalid"
        self.source.write_text(json.dumps(self.value))
        with self.assertRaises(ValueError):
            self.invoke()
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / ".runtime").exists())

    def test_bootstrap_failure_restores_previous_private_files(self):
        self.invoke()
        target = next((self.root / ".runtime").glob("agent-companion-*.json"))
        service = next((self.root / "Library/LaunchAgents").glob("*.plist"))
        before = (target.read_bytes(), service.read_bytes())
        self.value["label"] = "changed"
        self.source.write_text(json.dumps(self.value))
        with self.assertRaisesRegex(ValueError, "恢复原配置"):
            self.invoke(bootstrap_fail=True)
        self.assertEqual((target.read_bytes(), service.read_bytes()), before)

    def test_first_bootstrap_failure_leaves_no_new_service_or_active_config(self):
        with self.assertRaises(ValueError):
            self.invoke(bootstrap_fail=True)
        self.assertEqual(list((self.root / ".runtime").glob("agent-companion-*.json")), [])
        self.assertEqual(list((self.root / "Library/LaunchAgents").glob("*.plist")), [])

    def test_preflight_does_not_change_download_permissions_or_install_service(self):
        self.source.chmod(0o644)
        def run(command, **kwargs):
            self.assertEqual(command[0], "/fixture/node")
            self.assertEqual(Path(command[-1]).stat().st_mode & 0o777, 0o600)
            return SimpleNamespace(returncode=0)
        with patch.object(installer, "ROOT", self.root), \
                patch.object(installer.shutil, "which", side_effect=lambda name: "/fixture/" + name), \
                patch.object(installer.subprocess, "run", side_effect=run):
            self.assertTrue(installer.check_config(self.source, "agent")["valid"])
        self.assertEqual(self.source.stat().st_mode & 0o777, 0o644)
        self.assertFalse((self.root / ".runtime").exists())

    def test_real_node_validation_discovers_chat_and_persists_resolved_id(self):
        # Execute the production Node resolver against a fake imsg executable.
        # Never access the user's Messages database or launch a real service.
        source_root = Path(__file__).resolve().parents[1]
        (self.root / "plugins").symlink_to(source_root / "plugins", target_is_directory=True)
        imsg = self.root / "imsg"
        fixture_script = self.root / "imsg fixture.py"
        fixture_script.write_text("import json,sys\n" +
                        "assert sys.argv[1] in ['chats','group']\n" +
                        "print(json.dumps({'id': 42, 'service': 'iMessage', 'is_group': False, 'participants': ['owner@example.invalid'], 'last_addressed_handle': 'bot@example.invalid'}))\n")
        imsg.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(fixture_script)) + ' "$@"\n')
        imsg.chmod(0o700)
        self.value.update({"command": str(imsg), "channelId": self.value.pop("endpointId"), "peer": "owner@example.invalid", "botAddress": "bot@example.invalid"})
        self.source.write_text(json.dumps(self.value))
        real_run = subprocess.run
        def run(command, **kwargs):
            if command[0] == "launchctl":
                self.calls.append(command)
                return SimpleNamespace(returncode=0)
            return real_run(command, **kwargs)
        with patch.object(installer, "ROOT", self.root), patch.object(installer.Path, "home", return_value=self.root), \
                patch.object(installer.os, "uname", return_value=SimpleNamespace(sysname="Darwin")), \
                patch.object(installer.subprocess, "run", side_effect=run):
            installer.check_config(self.source, "imessage")
            self.assertNotIn("chatId", json.loads(self.source.read_text()))
            installer.install(SimpleNamespace(config=str(self.source), kind="imessage"))
        target = next((self.root / ".runtime").glob("imessage-companion-*.json"))
        self.assertEqual(json.loads(target.read_text())["chatId"], 42)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_imessage_uses_verified_project_local_install_when_not_on_path(self):
        binary = self.root / ".runtime/bin/imsg"
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\nexit 0\n")
        binary.chmod(0o700)
        self.value["command"] = "imsg"
        self.source.write_text(json.dumps(self.value))
        with patch.object(installer, "ROOT", self.root), patch.object(installer.shutil, "which", return_value=None):
            value = installer.prepare(self.source, "imessage")
        self.assertEqual(value["command"], str(binary.resolve()))
        # An explicitly chosen missing executable must not silently use another binary.
        self.value["command"] = "missing-imsg"
        self.source.write_text(json.dumps(self.value))
        with patch.object(installer, "ROOT", self.root), patch.object(installer.shutil, "which", return_value=None):
            with self.assertRaises(ValueError):
                installer.prepare(self.source, "imessage")

    def test_imessage_permission_failure_leaves_previous_config_and_service_alone(self):
        self.value.update({"command": "imsg", "channelId": self.value.pop("endpointId"),
                           "chatId": 42, "peer": "owner@example.invalid", "botAddress": "bot@example.invalid"})
        self.source.write_text(json.dumps(self.value))
        self.invoke(kind="imessage")
        target = next((self.root / ".runtime").glob("imessage-companion-*.json"))
        original = target.read_bytes()
        self.calls.clear()
        with self.assertRaisesRegex(ValueError, "Full Disk Access"):
            self.invoke(1, "imessage", b"IMESSAGE_CHAT_ACCESS_REQUIRED\n")
        self.assertEqual(target.read_bytes(), original)
        self.assertFalse(list((self.root / ".runtime").glob("*.tmp")))
        self.assertFalse(any(command[0] == "launchctl" for command in self.calls))


if __name__ == "__main__":
    unittest.main()
