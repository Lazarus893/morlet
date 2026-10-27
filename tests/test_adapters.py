"""Offline configuration, transport and device adapter contracts."""
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
from pa_config import validate, capabilities, load_config, write_config
from devices import IOSDevice, AndroidDevice, get_device, probe_device


class AdapterTests(unittest.TestCase):
    def config(self):
        return json.loads((ROOT / "config/pa.example.json").read_text())

    def test_invalid_providers_and_skill_escape_rejected(self):
        for section, value in (("agent", "shell"), ("device", "hdc"), ("im", "unknown")):
            cfg = self.config(); cfg[section]["provider"] = value
            with self.assertRaises(ValueError): validate(cfg)
        cfg = self.config(); cfg["capabilities"]["extra_skills"] = ["../private"]
        with self.assertRaises(ValueError): validate(cfg)
        cfg = self.config(); cfg["im"]["access_policy"] = "open"
        with self.assertRaises(ValueError): validate(cfg)

    def test_optional_tools_do_not_become_required(self):
        with patch("pa_config.shutil.which", return_value=None), patch.dict(os.environ, {}, clear=True):
            rows = {row["id"]: row for row in capabilities(self.config())}
        self.assertFalse(rows["apple-notes"]["available"])
        self.assertFalse(rows["phone"]["available"])
        self.assertFalse(rows["goplaces"]["available"])

    def test_private_config_roundtrip(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_config(self.config(), root)
            self.assertEqual(load_config(root), self.config())
            self.assertEqual((root / ".runtime/pa.json").stat().st_mode & 0o777, 0o600)

    def test_ios_probe_never_uses_adb_or_creates_session(self):
        ios = IOSDevice({"wda_url": "http://127.0.0.1:8100", "device_id": "fixture"})
        with patch.object(ios, "get", side_effect=[{"value": {"ready": True}}, {"value": False}]) as get, patch("devices.subprocess.run") as adb:
            self.assertEqual(ios.probe()["state"], "connected")
            self.assertEqual([call.args[0] for call in get.call_args_list], ["/status", "/wda/locked"])
            adb.assert_not_called()
        with patch.object(ios, "get", side_effect=[{"value": {"ready": True}}, {"value": True}]):
            self.assertEqual(ios.probe()["state"], "locked")
        with patch.object(ios, "get", return_value={"value": {"anything": True}}):
            self.assertEqual(ios.probe()["state"], "absent")

    def test_disabled_device_does_not_probe(self):
        with patch("devices.subprocess.run") as process:
            self.assertEqual(probe_device({"device_type": "none"})["state"], "disabled")
            process.assert_not_called()
        with self.assertRaises(ValueError): get_device({"device_type": "typo"})

    def test_android_locked_and_missing(self):
        android = AndroidDevice({"device_id": "fixture"})
        with patch.object(android, "command", side_effect=[b"device", b"mDreamingLockscreen=true"]):
            self.assertEqual(android.probe()["state"], "locked")
        with patch.object(android, "command", side_effect=FileNotFoundError):
            self.assertEqual(android.probe()["state"], "absent")

    def test_all_cores_generate_channel_and_skill_configuration(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        from configure import configure
        from source_files import source_files
        with tempfile.TemporaryDirectory(prefix="pa adapters ") as temporary:
            root = Path(temporary)
            for source in source_files(ROOT):
                target = root / source.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
            for provider in ("codex", "workbuddy", "dsh"):
                cfg = self.config(); cfg["agent"]["provider"] = provider
                cfg["owner"] = "测试用户"; cfg["im"]["allow_from"] = ["fixture-user"]
                cfg["device"]["provider"] = "ios"
                write_config(cfg, root); configure(root)
                generated = json.loads((root / ".runtime/dsh/profiles/wx-life/cordis.patch.yml").read_text())
                channel = next(row for row in generated if row.get("id") == "weixin-channel")
                self.assertEqual(channel["config"]["accessPolicy"], "allowlist")
                self.assertEqual(channel["config"]["allowFrom"], ["fixture-user"])
                self.assertEqual(bool(channel["config"].get("agentAdapterModule")), provider != "dsh")
                runtime = json.loads((root / ".runtime/agent.json").read_text())
                self.assertEqual(runtime["provider"], provider)
                self.assertIn("测试用户", (root / ".runtime/workspace/AGENTS.md").read_text())
                self.assertTrue((root / ".runtime/workspace/skills/phone/SKILL.md").is_file())

    def test_ios_invalid_screenshot_cannot_look_successful(self):
        ios = IOSDevice({"wda_url": "http://127.0.0.1:8100"})
        with tempfile.TemporaryDirectory() as temporary, patch.object(ios, "get", return_value={"value": "bm90LWFuLWltYWdl"}):
            path = Path(temporary) / "screen.png"
            with self.assertRaises(RuntimeError): ios.screenshot(path)
            self.assertFalse(path.exists())

    def test_cli_protocol_suite(self):
        result = subprocess.run(["node", "--test", str(ROOT / "tests/agent_bridge.test.mjs")],
                                cwd=ROOT, capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_phone_execution_suite(self):
        python = ROOT / ".venv/bin/python"
        result = subprocess.run([str(python) if python.exists() else sys.executable,
                                 str(ROOT / "tests/phone_runtime_cases.py"), "-v"],
                                cwd=ROOT, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_proactive_suite(self):
        result = subprocess.run(["node", "--test", str(ROOT / "tests/proactive.test.mjs")],
                                cwd=ROOT, capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_proactive_configuration_and_existing_install_opt_in(self):
        cfg = load_config()
        for field, bad in (("quiet_start", "25:00"), ("timezone", "Not/AZone"),
                           ("max_daily", -1), ("enabled", "yes"), ("context_ttl_hours", 48)):
            broken = json.loads(json.dumps(cfg))
            broken["proactive"][field] = bad
            with self.assertRaises(ValueError): validate(broken)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config").mkdir()
            (root / ".runtime").mkdir()
            shutil.copy2(ROOT / "config/pa.example.json", root / "config/pa.example.json")
            self.assertTrue(load_config(root)["proactive"]["enabled"])
            del cfg["proactive"]
            (root / ".runtime/pa.json").write_text(json.dumps(cfg))
            self.assertFalse(load_config(root)["proactive"]["enabled"])
            (root / ".runtime/pa.json").unlink()
            legacy = root / ".runtime/dsh/profiles/wx-life/cordis.patch.yml"
            legacy.parent.mkdir(parents=True)
            legacy.write_text("[]")
            self.assertFalse(load_config(root)["proactive"]["enabled"])


if __name__ == "__main__": unittest.main()
