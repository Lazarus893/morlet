"""Phone execution contracts; every device and model boundary is replaced by a fake."""
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
import phone_task
from phone_agent.xctest import device, screenshot, http


class PhoneRuntimeTests(unittest.TestCase):
    def test_ios_task_state_and_resume_without_android_calls(self):
        cfg = {"device_type": "ios", "device_id": "fixture", "wda_url": "http://127.0.0.1:8100",
               "base_url": "http://model.invalid", "api_key": "fixture", "model": "fixture"}
        agent = SimpleNamespace(_step_count=0, _context=[])
        def step(task=None):
            agent._step_count += 1
            agent._context.append({"role": "user", "content": task})
            return SimpleNamespace(thinking="", action={"action": "finish"}, success=True, finished=True, message="fixture done")
        agent.step = step
        adapter = Mock(companion=False)
        adapter.create_agent.return_value = agent
        adapter.screenshot.return_value = None
        with tempfile.TemporaryDirectory() as temporary, patch("phone_task.get_device", return_value=adapter), \
             patch("phone_task.adb") as adb, patch("phone_task.pull_from_phone") as pull, \
             patch("phone_task.broadcast_status") as broadcast:
            path = Path(temporary)
            bridge = phone_task.Bridge(path, cfg, {"screenshotEvery": 0}, 3, 0, 10, True)
            self.assertFalse(bridge.record)
            status, result, _ = bridge.run_segment("fixture task")
            self.assertEqual((status, result), ("completed", "fixture done"))
            state = json.loads((path / "state.json").read_text())
            self.assertEqual(state["device"]["device_type"], "ios")
            self.assertNotIn("api_key", state["device"])
            self.assertEqual(state["task"], "fixture task")
            adb.assert_not_called(); pull.assert_not_called(); broadcast.assert_not_called()

    def test_resume_rejects_changed_device_before_connecting(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            (path / "state.json").write_text(json.dumps({"device": {"device_type": "ios", "device_id": "a", "wda_url": "http://a"}}))
            with patch("phone_task.load_device_cfg", return_value={"device_type": "adb", "device_id": "b"}), \
                 patch("phone_task.get_device") as get, patch("phone_task.print_status_report"):
                with self.assertRaises(SystemExit): phone_task.prepare(SimpleNamespace(), path)
                get.assert_not_called()

    def test_confirmation_is_single_use_and_matches_pending_description(self):
        bridge = object.__new__(phone_task.Bridge)
        bridge.agent_log = io.StringIO(); bridge.approved_confirmation = "exact action"
        self.assertFalse(bridge._on_confirmation("different action"))
        self.assertTrue(bridge._on_confirmation("exact action"))
        self.assertFalse(bridge._on_confirmation("exact action"))

    def test_iphone_coordinates_follow_device_scale(self):
        for scale in (2, 3):
            device.screen_scale.cache_clear()
            response = Mock(); response.json.return_value = {"value": {"scale": scale}}
            with patch.object(http, "get", return_value=response), patch.object(http, "post") as post:
                device.tap(300, 600, wda_url="http://fixture", session_id="fixture", delay=0)
                point = post.call_args.kwargs["json"]["actions"][0]["actions"][0]
                self.assertEqual((point["x"], point["y"]), (300 / scale, 600 / scale))

    def test_failed_wda_action_and_screenshot_are_not_success(self):
        device.screen_scale.cache_clear()
        response = Mock(); response.json.return_value = {"value": {"scale": 2}}
        with patch.object(http, "get", return_value=response), patch.object(http, "post", side_effect=RuntimeError):
            with self.assertRaises(RuntimeError): device.tap(10, 20, delay=0)
        with patch.object(screenshot, "_get_screenshot_wda", return_value=None):
            with self.assertRaises(RuntimeError): screenshot.get_screenshot()

    def test_back_gesture_uses_actual_window_geometry(self):
        response = Mock(status_code=200); response.json.return_value = {"value": {"width": 375, "height": 667}}
        with patch.object(http, "get", return_value=response), patch.object(http, "post") as post:
            device.back(wda_url="http://fixture", session_id="fixture", delay=0)
            gesture = post.call_args.kwargs["json"]
            self.assertEqual(gesture["fromY"], 333.5)
            self.assertEqual(gesture["toX"], 300)
        self.assertFalse(device.launch_app("unmapped fixture application"))


if __name__ == "__main__": unittest.main()
