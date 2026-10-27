"""Explicit phone binding contracts. All devices and CLI responses are fixtures."""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
sys.path.insert(0, str(ROOT / "scripts"))
from devices import ADB, IOSDevice, discover_android_device, probe_device
from pa_config import config_revision, load_config, write_config
from web_config import execute


class DeviceConnectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pa-phone-fixture-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "config").mkdir()
        shutil.copy2(ROOT / "config/pa.example.json", self.root / "config/pa.example.json")
        self.cfg = load_config(self.root)
        self.cfg["owner"] = "PRIVATE_OWNER_FIXTURE"
        write_config(self.cfg, self.root)
        self.path = self.root / ".runtime/pa.json"
        permissions = patch('web_config.phone_permissions', return_value=[
            {'id': name, 'granted': False, 'verified': False, 'reason': 'unverified'}
            for name in ('automation', 'recording')])
        permissions.start()
        self.addCleanup(permissions.stop)

    @staticmethod
    def response(stdout):
        return subprocess.CompletedProcess([], 0, stdout=stdout, stderr="PRIVATE_STDERR_FIXTURE")

    def save_device(self, provider, device_id=""):
        self.cfg["device"].update(provider=provider, id=device_id)
        write_config(self.cfg, self.root)

    def assert_safe(self, result):
        self.assertEqual(set(result), {"state", "provider", "detail", "permissions"})
        for value in ("PRIVATE_SERIAL_FIXTURE", "PRIVATE_OWNER_FIXTURE", "PRIVATE_STDOUT_FIXTURE", "PRIVATE_STDERR_FIXTURE"):
            self.assertNotIn(value, json.dumps(result))

    def test_unique_authorized_device_is_bound_with_cas_and_private_mode(self):
        revision = config_revision(self.cfg)
        self.path.chmod(0o644)
        responses = [self.response("List of devices attached\nPRIVATE_SERIAL_FIXTURE\tdevice\n"),
                     self.response(b"device\n"), self.response(b"mDreamingLockscreen=false")]
        with patch("devices.subprocess.run", side_effect=responses) as cli, patch("web_config.write_config", wraps=write_config) as save:
            result = execute({"action": "connect-device"}, self.root)
        self.assertEqual(result["state"], "connected")
        self.assertEqual(result["provider"], "adb")
        self.assert_safe(result)
        expected = copy.deepcopy(self.cfg)
        expected["device"].update(provider="android", id="PRIVATE_SERIAL_FIXTURE")
        self.assertEqual(load_config(self.root), expected)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(save.call_args.kwargs["expected_revision"], revision)
        self.assertEqual([call.args[0] for call in cli.call_args_list],
                         [[ADB, "devices"], [ADB, "-s", "PRIVATE_SERIAL_FIXTURE", "get-state"],
                          [ADB, "-s", "PRIVATE_SERIAL_FIXTURE", "shell", "dumpsys", "window"]])

    def test_missing_private_config_is_created_from_template(self):
        self.path.unlink()
        with patch("devices.subprocess.run", side_effect=[self.response("List of devices attached\nPRIVATE_SERIAL_FIXTURE\tdevice\n"),
                                                          self.response(b"device"), self.response(b"isStatusBarKeyguard=true")]):
            result = execute({"action": "connect-device"}, self.root)
        self.assertEqual(result["state"], "locked")
        self.assertEqual(load_config(self.root)["device"]["provider"], "android")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assert_safe(result)

    def test_multiple_devices_never_choose_or_save(self):
        before = self.path.read_bytes()
        for output in ("List of devices attached\nfirst\tdevice\nsecond\tdevice\n",
                       "List of devices attached\nfirst\tdevice\nsecond\tunauthorized\n"):
            with self.subTest(output=output), patch("devices.subprocess.run", return_value=self.response(output)) as cli, patch("web_config.write_config") as save:
                result = execute({"action": "connect-device"}, self.root)
            self.assertEqual(result["state"], "multiple")
            self.assert_safe(result)
            self.assertEqual(cli.call_count, 1)
            save.assert_not_called()
            self.assertEqual(self.path.read_bytes(), before)

    def test_unauthorized_offline_and_absent_never_save(self):
        before = self.path.read_bytes()
        cases = (("List of devices attached\nPRIVATE_SERIAL_FIXTURE\tunauthorized\n", "unauthorized"),
                 ("List of devices attached\nPRIVATE_SERIAL_FIXTURE\toffline\n", "absent"),
                 ("List of devices attached\n\n", "absent"))
        for output, expected in cases:
            with self.subTest(expected=expected), patch("devices.subprocess.run", return_value=self.response(output)), patch("web_config.write_config") as save:
                result = execute({"action": "connect-device"}, self.root)
            self.assertEqual(result["state"], expected)
            self.assert_safe(result)
            save.assert_not_called()
            self.assertEqual(self.path.read_bytes(), before)

    def test_missing_tool_failed_cli_and_timeout_never_save(self):
        failures = (FileNotFoundError("PRIVATE_STDERR_FIXTURE"),
                    subprocess.CalledProcessError(1, [ADB, "devices"], output="PRIVATE_STDOUT_FIXTURE", stderr="PRIVATE_STDERR_FIXTURE"),
                    subprocess.TimeoutExpired([ADB, "devices"], 6, output="PRIVATE_STDOUT_FIXTURE"))
        before = self.path.read_bytes()
        for failure in failures:
            with self.subTest(error=type(failure).__name__), patch("devices.subprocess.run", side_effect=failure), patch("web_config.write_config") as save:
                result = execute({"action": "connect-device"}, self.root)
            self.assertEqual(result["state"], "unconfigured")
            self.assert_safe(result)
            save.assert_not_called()
            self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_output_is_rejected_without_raw_data(self):
        cases = ("", "PRIVATE_STDOUT_FIXTURE", "List of devices attached\nerror: PRIVATE_STDOUT_FIXTURE\n",
                 "List of devices attached\nPRIVATE_SERIAL_FIXTURE\tdevice unexpected\n",
                 "List of devices attached\nPRIVATE_SERIAL_FIXTURE\tunknown\n",
                 "List of devices attached\nPRIVATE_SERIAL_FIXTURE\tdevice\nPRIVATE_SERIAL_FIXTURE\tdevice\n")
        before = self.path.read_bytes()
        for output in cases:
            with self.subTest(output=output), patch("devices.subprocess.run", return_value=self.response(output)), patch("web_config.write_config") as save:
                result = execute({"action": "connect-device"}, self.root)
            self.assertEqual(result["state"], "unconfigured")
            self.assert_safe(result)
            save.assert_not_called()
            self.assertEqual(self.path.read_bytes(), before)

    def test_android_without_id_can_be_discovered(self):
        self.save_device("android")
        with patch("devices.subprocess.run", side_effect=[self.response("List of devices attached\nPRIVATE_SERIAL_FIXTURE\tdevice\n"),
                                                          self.response(b"device"), self.response(b"")]):
            result = execute({"action": "connect-device"}, self.root)
        self.assertEqual(result["state"], "connected")
        self.assertEqual(load_config(self.root)["device"]["id"], "PRIVATE_SERIAL_FIXTURE")
        self.assert_safe(result)

    def test_existing_android_binding_is_preferred_over_discovery_and_environment(self):
        self.save_device("android", "configured-device-fixture")
        before = self.path.read_bytes()
        with patch.dict(os.environ, {"PHONE_AGENT_DEVICE_ID": "OTHER_DEVICE_FIXTURE"}), patch("devices.subprocess.run", side_effect=[self.response(b"device"), self.response(b"")]) as cli, patch("web_config.write_config") as save:
            result = execute({"action": "connect-device"}, self.root)
        self.assertEqual(result["state"], "connected")
        self.assertTrue(all(call.args[0][:3] == [ADB, "-s", "configured-device-fixture"] for call in cli.call_args_list))
        save.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)
        self.assert_safe(result)

    def test_existing_ios_binding_only_reads_configured_wda(self):
        self.save_device("ios")
        before = self.path.read_bytes()
        with patch.object(IOSDevice, "get", side_effect=[{"value": {"ready": True}}, {"value": False}]) as wda, patch("devices.subprocess.run") as cli, patch("web_config.write_config") as save:
            result = execute({"action": "connect-device"}, self.root)
        self.assertEqual(result["state"], "connected")
        self.assertEqual(result["provider"], "ios")
        self.assertEqual([call.args[0] for call in wda.call_args_list], ["/status", "/wda/locked"])
        self.assertTrue(all(0 < call.kwargs["timeout"] <= 5 for call in wda.call_args_list))
        cli.assert_not_called()
        save.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)
        self.assert_safe(result)

    def test_configuration_changed_during_discovery_rejects_stale_binding(self):
        def discover(_command, **_kwargs):
            changed = copy.deepcopy(self.cfg)
            changed["owner"] = "new-owner-fixture"
            write_config(changed, self.root)
            return self.response("List of devices attached\nPRIVATE_SERIAL_FIXTURE\tdevice\n")
        with patch("devices.subprocess.run", side_effect=discover) as cli:
            with self.assertRaisesRegex(ValueError, "^CONFLICT$"):
                execute({"action": "connect-device"}, self.root)
        self.assertEqual(cli.call_count, 1)
        saved = load_config(self.root)
        self.assertEqual(saved["owner"], "new-owner-fixture")
        self.assertEqual(saved["device"], self.cfg["device"])

    def test_unplug_after_discovery_cannot_report_connected(self):
        with patch("devices.subprocess.run", side_effect=[self.response("List of devices attached\nPRIVATE_SERIAL_FIXTURE\tdevice\n"),
                                                          subprocess.CalledProcessError(1, [ADB, "get-state"], stderr="PRIVATE_STDERR_FIXTURE")]):
            result = execute({"action": "connect-device"}, self.root)
        self.assertEqual(result["state"], "absent")
        self.assert_safe(result)

    def test_regular_probe_never_discovers_or_modifies_configuration(self):
        for provider, device_id in (("none", ""), ("android", "configured-device-fixture"), ("android", "")):
            self.save_device(provider, device_id)
            before = self.path.read_bytes()
            with self.subTest(provider=provider, device_id=device_id), patch.dict(os.environ, {}, clear=True), patch("devices.subprocess.run", side_effect=[self.response(b"device"), self.response(b"")]) as cli, patch("web_config.write_config") as save:
                result = execute({"action": "device"}, self.root)
            self.assertTrue(all(call.args[0][1] == "-s" for call in cli.call_args_list))
            save.assert_not_called()
            self.assertEqual(self.path.read_bytes(), before)
            self.assert_safe(result)

    def test_discovery_and_probe_share_a_bounded_deadline(self):
        clock = [100.0]
        timeouts = []
        responses = iter([self.response("List of devices attached\nPRIVATE_SERIAL_FIXTURE\tdevice\n"),
                          self.response(b"device"), self.response(b"")])
        def run(_command, **kwargs):
            timeouts.append(kwargs["timeout"])
            clock[0] += kwargs["timeout"]
            return next(responses)
        with patch("devices.time.monotonic", side_effect=lambda: clock[0]), patch("devices.subprocess.run", side_effect=run):
            result = execute({"action": "connect-device"}, self.root)
        self.assertEqual(result["state"], "connected")
        self.assertEqual(timeouts, [6, 10, 1])
        self.assertLessEqual(sum(timeouts), 18)

    def test_probe_does_not_start_another_command_after_budget_expires(self):
        clock = [100.0]
        def run(_command, **kwargs):
            clock[0] += kwargs["timeout"]
            return self.response(b"device")
        with patch("devices.time.monotonic", side_effect=lambda: clock[0]), patch("devices.subprocess.run", side_effect=run) as cli:
            result = probe_device({"device_type": "adb", "device_id": "PRIVATE_SERIAL_FIXTURE"}, timeout=1)
        self.assertEqual(result["state"], "absent")
        self.assertEqual(cli.call_count, 1)

    def test_device_probe_does_not_echo_unexpected_adb_state(self):
        self.save_device("android", "PRIVATE_SERIAL_FIXTURE")
        with patch("devices.subprocess.run", return_value=self.response(b"PRIVATE_STDOUT_FIXTURE")):
            result = execute({"action": "connect-device"}, self.root)
        self.assertEqual(result["state"], "absent")
        self.assert_safe(result)


if __name__ == "__main__":
    unittest.main()
