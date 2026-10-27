"""Device adapters. Probes are read-only; creating an agent requires an explicit run."""
import base64
import json
import re
import subprocess
import time
import urllib.request
from pathlib import Path

from runtime_paths import ADB


def _remaining_timeout(deadline, maximum):
    remaining = maximum if deadline is None else min(maximum, deadline - time.monotonic())
    if remaining <= 0:
        raise TimeoutError("device probe deadline expired")
    return remaining


def discover_android_device(timeout=6):
    """Enumerate only; a caller must explicitly persist the unique authorized device."""
    result = {"provider": "adb"}
    try:
        output = subprocess.run([ADB, "devices"], capture_output=True, text=True,
                                timeout=timeout, check=True).stdout
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        if not lines or lines[0] != "List of devices attached":
            raise ValueError("invalid adb devices header")
        devices = []
        for line in lines[1:]:
            match = re.fullmatch(r"([A-Za-z0-9._:-]{1,256})\s+(device|unauthorized|offline|recovery|sideload|bootloader)", line)
            if not match:
                raise ValueError("invalid adb devices row")
            devices.append(match.groups())
        if len({device_id for device_id, _state in devices}) != len(devices):
            raise ValueError("duplicate adb device")
    except subprocess.TimeoutExpired:
        return dict(result, state="unconfigured", detail="手机检测超时，请重试")
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError):
        return dict(result, state="unconfigured", detail="无法检测 Android 手机，请检查 ADB 安装和连接")
    if len(devices) > 1:
        return dict(result, state="multiple", detail="检测到多台手机，请只保留要连接的一台")
    if not devices:
        return dict(result, state="absent", detail="未检测到手机，请检查 USB 连接")
    device_id, state = devices[0]
    if state == "unauthorized":
        return dict(result, state="unauthorized", detail="请在手机上允许 USB 调试")
    if state != "device":
        return dict(result, state="absent", detail="手机尚未就绪，请检查连接")
    # This ID stays inside the local helper and private configuration.
    return dict(result, state="connected", detail="ADB 已连接", id=device_id)


class AndroidDevice:
    companion = True

    def __init__(self, cfg):
        self.cfg = cfg
        self.id = cfg["device_id"]

    def command(self, *args, timeout=10):
        return subprocess.run([ADB, "-s", self.id, *args], capture_output=True,
                              timeout=timeout, check=True).stdout

    def probe(self, deadline=None):
        if not self.id:
            return {"state": "unconfigured", "detail": "请配置 Android device ID"}
        try:
            state = self.command("get-state", timeout=_remaining_timeout(deadline, 10)).decode().strip()
            if state != "device":
                return {"state": "absent", "detail": "手机尚未就绪，请检查连接"}
            win = self.command("shell", "dumpsys", "window", timeout=_remaining_timeout(deadline, 10)).decode(errors="replace")
            locked = "mDreamingLockscreen=true" in win or "isStatusBarKeyguard=true" in win
            return {"state": "locked" if locked else "connected", "detail": "请解锁手机" if locked else "ADB 已连接"}
        except (OSError, subprocess.SubprocessError, UnicodeError, TimeoutError):
            return {"state": "absent", "detail": "检查 adb、USB 调试授权和连接"}

    def screenshot(self, path):
        data = self.command("exec-out", "screencap", "-p")
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("ADB 未返回有效截图")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def create_agent(self, model, max_steps, experiences, confirm, takeover):
        from phone_agent import PhoneAgent
        from phone_agent.agent import AgentConfig
        from phone_agent.device_factory import DeviceType, set_device_type
        set_device_type(DeviceType.ADB)
        return PhoneAgent(model_config=model, agent_config=AgentConfig(
            max_steps=max_steps, device_id=self.id, verbose=False, lang="cn",
            planning_enabled=True, reflection_interval=5, experiences_dir=str(experiences)),
            confirmation_callback=confirm, takeover_callback=takeover)


class IOSDevice:
    companion = False

    def __init__(self, cfg):
        self.cfg = cfg
        self.id = cfg.get("device_id", "")
        self.url = cfg["wda_url"].rstrip("/")

    def get(self, endpoint, timeout=5):
        # WDA is a user-configured device endpoint; do not route it via system proxies.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(self.url + endpoint, timeout=timeout) as response:
            return json.load(response)

    def probe(self, deadline=None):
        def get(endpoint):
            if deadline is None:
                return self.get(endpoint)
            return self.get(endpoint, timeout=_remaining_timeout(deadline, 5))

        try:
            value = get("/status").get("value", {})
            if not isinstance(value, dict) or not ("ready" in value or "build" in value or "os" in value):
                raise ValueError("响应不是 WDA status")
            if value.get("ready") is False:
                return {"state": "absent", "detail": "WDA 未就绪"}
            locked = get("/wda/locked").get("value")
            if not isinstance(locked, bool):
                raise ValueError("无法确认 iPhone 锁屏状态")
            return {"state": "locked" if locked else "connected", "detail": "请解锁 iPhone" if locked else "WDA 已连接"}
        except Exception as error:
            return {"state": "absent", "detail": f"WDA 检查失败（{type(error).__name__}）；检查签名、开发者模式及 WDA 地址"}

    def screenshot(self, path):
        data = base64.b64decode(self.get("/screenshot")["value"], validate=True)
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("WDA 未返回有效截图")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def create_agent(self, model, max_steps, experiences, confirm, takeover):
        from phone_agent.agent_ios import IOSAgentConfig, IOSPhoneAgent
        from phone_agent.xctest.device import screen_scale
        screen_scale(self.url)  # Verify geometry before allowing any action.
        agent = IOSPhoneAgent(model_config=model, agent_config=IOSAgentConfig(
            max_steps=max_steps, device_id=self.id or None, wda_url=self.url, verbose=False),
            confirmation_callback=confirm, takeover_callback=takeover)
        if not agent.agent_config.session_id:
            raise RuntimeError("WDA session creation failed; no device action started")
        return agent


DEVICE_ADAPTERS = {"adb": AndroidDevice, "ios": IOSDevice}


def get_device(cfg):
    provider = cfg.get("device_type", "none")
    if provider not in DEVICE_ADAPTERS:
        raise ValueError("移动设备未启用；运行 pa.sh init --device android 或 --device ios")
    return DEVICE_ADAPTERS[provider](cfg)


def probe_device(cfg, timeout=None):
    if cfg.get("device_type") == "none":
        return {"state": "disabled", "detail": "未启用移动设备", "provider": "none", "id": ""}
    device = get_device(cfg)
    result = device.probe() if timeout is None else device.probe(deadline=time.monotonic() + timeout)
    result.update(provider=cfg["device_type"], id=cfg.get("device_id", ""))
    return result
