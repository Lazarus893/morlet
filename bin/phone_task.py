#!/usr/bin/env python3
"""小满 → 手机执行器（Open-AutoGLM phone_agent）的桥接 runner。

子命令：
  run "任务描述" [--max-steps N] [--checkpoint-every N] [--timeout S] [--no-record]
  resume <task-id|last> [--approve] [--note "补充指令"] [--max-steps N] [--timeout S]
  status [<task-id>|last]

一次 run/resume 是一个「段」：跑到任务完成、到达检查点（每 N 步）、需要 Tony 接管、
需要 Tony 批准敏感操作、超步数或超时为止。段结束时保存完整上下文（state.json），
resume 从同一上下文接着跑，所以不会丢失前面看过的页面。

退出码：0 完成 / 2 手机或环境问题 / 3 没做完（出错、超步数、超时）
        4 到检查点暂停 / 5 需要 Tony 接管 / 6 需要 Tony 批准敏感操作
日志目录默认在项目 .runtime/workspace/phone-logs/<task-id>/ 下（dsh 沙箱只允许写工作目录；微信也只外发工作目录内的文件）。
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from runtime_paths import AUTO_PHONE, PHONE_PROFILE as PROFILE, ADB, WORKSPACE
HELPER_PKG = "com.agent.helper"
HELPER_FILES = f"/sdcard/Android/data/{HELPER_PKG}/files"
DEVICE_REC_ROOT = "/sdcard/phone-agent/rec"
PHONE_SHARED_DIR = "/sdcard/Download/小满"   # 手机侧共享目录：Mac push 过去的文件在这，执行器保存的图片/文件也让它存这

# 执行器经验库放在工作区里（phone-refs/experiences/），小满在沙箱里能直接改；auto-phone 自带的那份只是初始拷贝
EXPERIENCES_DIR = Path(os.environ.get("PHONE_EXPERIENCES_DIR", str(WORKSPACE / "phone-refs/experiences")))

DEFAULT_SETTINGS = {
    "record": True,
    "checkpointEvery": 8,
    "screenshotEvery": 3,
    "maxSteps": 30,
    "bubble": True,
    "overlay": False,
}

sys.path.insert(0, str(AUTO_PHONE))
from phone_agent import PhoneAgent  # noqa: E402
from phone_agent.agent import AgentConfig  # noqa: E402
from phone_agent.device_factory import DeviceType, set_device_type  # noqa: E402
from phone_agent.model import ModelConfig  # noqa: E402


# ───────────────────────── 基础工具 ─────────────────────────
def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def adb(device_id: str, *args: str, timeout: int = 20, binary: bool = False):
    cmd = [ADB, "-s", device_id, *args]
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return None if binary else f"<adb error: {e}>"
    if binary:
        return res.stdout
    return (res.stdout.decode("utf-8", "replace") + res.stderr.decode("utf-8", "replace")).strip()


STATUS_SCRIPT = Path(__file__).with_name("status_report.py")


def print_status_report() -> None:
    """失败时附上各设备 online/offline，便于定位（不只说「出错」）。"""
    try:
        out = subprocess.run(["/usr/bin/env", "python3", str(STATUS_SCRIPT), "--fast"], capture_output=True, text=True, timeout=15).stdout.strip()
        if out:
            print(out)
    except Exception:  # noqa: BLE001
        pass


def fail(msg: str, code: int = 2) -> None:
    print(f"失败：{msg}")
    print_status_report()
    sys.exit(code)


def log_root_default() -> Path:
    env = os.environ.get("PHONE_LOG_ROOT")
    return Path(env) if env else WORKSPACE / "phone-logs"


def resolve_task_dir(root: Path, task_ref: str) -> Path:
    if task_ref == "last":
        dirs = sorted((d for d in root.iterdir() if d.is_dir() and (d / "state.json").exists()), key=lambda d: d.stat().st_mtime)
        if not dirs:
            fail(f"{root} 下没有可续跑的任务", 3)
        return dirs[-1]
    d = root / task_ref
    if not (d / "state.json").exists():
        fail(f"找不到任务 {task_ref}（{d}/state.json 不存在）", 3)
    return d


# ───────────────────────── 手机侧 ─────────────────────────
def check_device(device_id: str) -> None:
    out = adb(device_id, "get-state")
    if "device" not in (out or ""):
        listing = subprocess.run([ADB, "devices"], capture_output=True, text=True).stdout
        if device_id in listing and "unauthorized" in listing:
            fail(f"手机 {device_id} 还没授权 USB 调试，请 Tony 在手机上点「允许」。")
        fail(f"手机 {device_id} 没有连在 Mac 上（adb 看不到）。请 Tony 用数据线把手机接到 Mac，并确认 USB 调试打开。")
    adb(device_id, "shell", "input", "keyevent", "KEYCODE_WAKEUP")
    time.sleep(0.4)
    win = adb(device_id, "shell", "dumpsys", "window", timeout=15) or ""
    if "mDreamingLockscreen=true" in win:
        fail("手机现在是锁屏状态，我解不了锁。请 Tony 先解锁手机再让我试。")


def phone_settings(device_id: str) -> dict:
    s = dict(DEFAULT_SETTINGS)
    raw = adb(device_id, "shell", "cat", f"{HELPER_FILES}/settings.json", timeout=10) or ""
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            for k in DEFAULT_SETTINGS:
                if k in data:
                    s[k] = data[k]
        except json.JSONDecodeError:
            pass
    return s


def takeover_requested(device_id: str) -> bool:
    raw = adb(device_id, "shell", "cat", f"{HELPER_FILES}/control.json", timeout=10) or ""
    if not raw.startswith("{"):
        return False
    try:
        requested = bool(json.loads(raw).get("takeover"))
    except json.JSONDecodeError:
        requested = False
    if requested:
        adb(device_id, "shell", "rm", "-f", f"{HELPER_FILES}/control.json", timeout=10)
    return requested


def broadcast_status(device_id: str, state: str, step: int, text: str) -> None:
    # ColorOS 会把退到后台的 com.agent.helper 冻住，广播被扣住不送达；紧跟一次 dumpsys meminfo 能让它在 0.2s 内解冻收到
    adb(
        device_id, "shell",
        f"am broadcast -a {HELPER_PKG}.TASK_STATUS -p {HELPER_PKG} --es state {state} --ei step {step} --es text {shlex.quote(text[:80])} >/dev/null 2>&1; "
        f"dumpsys meminfo {HELPER_PKG} >/dev/null 2>&1",
        timeout=15,
    )


def screenshot(device_id: str, path: Path) -> Path | None:
    data = adb(device_id, "exec-out", "screencap", "-p", timeout=20, binary=True)
    if not data or len(data) < 1000:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def shared_root() -> Path:
    env = os.environ.get("PHONE_SHARED_ROOT")
    return Path(env) if env else WORKSPACE / "shared"


def push_to_phone(device_id: str, files: list[Path]) -> list[str]:
    """把文件推到手机的 Download/小满/，并触发媒体扫描让相册和 App 看得到。"""
    adb(device_id, "shell", "mkdir", "-p", PHONE_SHARED_DIR)
    done = []
    for f in files:
        if not f.is_file():
            print(f"跳过（不是文件）：{f}")
            continue
        remote = f"{PHONE_SHARED_DIR}/{f.name}"
        out = adb(device_id, "push", str(f), remote, timeout=120) or ""
        if "pushed" in out:
            adb(device_id, "shell", f"am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://{shlex.quote(remote)} >/dev/null 2>&1", timeout=10)
            done.append(remote)
        else:
            print(f"推送失败：{f.name}  {out[-200:]}")
    return done


def pull_from_phone(device_id: str, dest: Path, quiet: bool = False) -> list[Path]:
    """把手机 Download/小满/ 里 Mac 这边还没有的文件拉回 shared/from-phone/。"""
    listing = adb(device_id, "shell", "ls", "-1", PHONE_SHARED_DIR, timeout=15) or ""
    if "No such file" in listing or listing.startswith("<adb error"):
        return []
    dest.mkdir(parents=True, exist_ok=True)
    pulled: list[Path] = []
    for name in (l.strip() for l in listing.splitlines()):
        if not name or (dest / name).exists():
            continue
        out = adb(device_id, "pull", f"{PHONE_SHARED_DIR}/{name}", str(dest / name), timeout=180) or ""
        if (dest / name).exists():
            pulled.append(dest / name)
            if not quiet:
                print(f"从手机拉回：shared/from-phone/{name}")
    return pulled


def record_status(device_id: str) -> dict:
    raw = adb(device_id, "shell", "cat", f"{HELPER_FILES}/record-status.json", timeout=10) or ""
    if not raw.startswith("{"):
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


class AppRecorder:
    """让「小满手机助手」用 MediaProjection 录屏：Mac 只发 start/stop 广播，结束后把分段 mp4 拉回来。"""

    def __init__(self, device_id: str, task_id: str, log_dir: Path):
        self.device_id = device_id
        self.task_id = task_id
        self.local_dir = log_dir / "recordings"
        self.index_file = self.local_dir / "index.json"
        self.remote_dir = f"{HELPER_FILES}/rec/{task_id}"
        self.unavailable = False
        self.reason = ""
        self.started_at = 0.0
        self.segments: list[dict] = []
        if self.index_file.exists():
            try:
                self.segments = json.loads(self.index_file.read_text())
            except json.JSONDecodeError:
                self.segments = []

    @staticmethod
    def authorized(device_id: str) -> bool:
        return bool(record_status(device_id).get("authorized"))

    def _send(self, action: str) -> None:
        adb(self.device_id, "shell",
            f"am broadcast -a {HELPER_PKG}.RECORD -p {HELPER_PKG} --es action {action} --es task_id {shlex.quote(self.task_id)} >/dev/null 2>&1; "
            f"dumpsys meminfo {HELPER_PKG} >/dev/null 2>&1", timeout=15)

    def start(self) -> None:
        self.local_dir.mkdir(parents=True, exist_ok=True)
        self.started_at = time.time()
        self._send("start")
        time.sleep(1.5)
        st = record_status(self.device_id)
        if not st.get("recording"):
            self.unavailable = True
            self.reason = st.get("error") or ("App 没拿到录屏授权" if not st.get("authorized") else "App 没开始录")

    def stop(self) -> list[Path]:
        if self.unavailable:
            return []
        self._send("stop")
        deadline = time.time() + 12
        st = {}
        while time.time() < deadline:
            st = record_status(self.device_id)
            if st.get("taskId") == self.task_id and not st.get("recording"):
                break
            time.sleep(0.5)
        names = [Path(x).name for x in (st.get("segments") or [])]
        if not names:
            listing = adb(self.device_id, "shell", "ls", "-1", self.remote_dir, timeout=10) or ""
            names = [l.strip() for l in listing.splitlines() if l.strip().endswith(".mp4")]
        done: list[Path] = []
        base = len(self.segments)
        for i, name in enumerate(sorted(names)):
            local = self.local_dir / f"seg_{base + i:02d}.mp4"
            adb(self.device_id, "pull", f"{self.remote_dir}/{name}", str(local), timeout=300)
            if local.exists() and local.stat().st_size > 0:
                done.append(local)
                self.segments.append({"file": local.name, "start": self.started_at + 180 * i, "end": min(self.started_at + 180 * (i + 1), time.time()), "source": "app"})
            else:
                local.unlink(missing_ok=True)
        adb(self.device_id, "shell", "rm", "-rf", self.remote_dir, timeout=20)
        self.index_file.write_text(json.dumps(self.segments, ensure_ascii=False, indent=1))
        return done


class Recorder:
    """录屏：screenrecord 的 h264 流直接通过 adb exec-out 流回 Mac（不占手机存储，不需要手机侧写权限），
    单段上限 180s，自动接段；停止后用 ffmpeg 封装成 mp4 放到 log_dir/recordings/。
    ColorOS 开着「权限监控」时 screenrecord 会被拦（输出 0 字节），6 秒内检测到就放弃并提示。"""

    def __init__(self, device_id: str, task_id: str, log_dir: Path):
        self.device_id = device_id
        self.local_dir = log_dir / "recordings"
        self.index_file = self.local_dir / "index.json"
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._proc: subprocess.Popen | None = None
        self.unavailable = False
        self.segments: list[dict] = []
        if self.index_file.exists():
            try:
                self.segments = json.loads(self.index_file.read_text())
            except json.JSONDecodeError:
                self.segments = []

    def start(self) -> None:
        self.local_dir.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        n = len(self.segments)
        while not self._stop.is_set():
            raw = self.local_dir / f"seg_{n:02d}.h264"
            started = time.time()
            with raw.open("wb") as fh:
                self._proc = subprocess.Popen(
                    [ADB, "-s", self.device_id, "exec-out", "screenrecord", "--time-limit", "180",
                     "--bit-rate", "3000000", "--size", "720x1584", "--output-format=h264", "-"],
                    stdout=fh, stderr=subprocess.DEVNULL,
                )
                # 健康检查：6 秒还没有字节就是被手机拦了
                healthy = False
                while self._proc.poll() is None and not self._stop.is_set():
                    time.sleep(0.5)
                    if not healthy and time.time() - started > 6:
                        if raw.stat().st_size > 0:
                            healthy = True
                        else:
                            self.unavailable = True
                            self._proc.terminate()
                            break
                if self._proc.poll() is None:
                    self._proc.terminate()
                    try:
                        self._proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self._proc.kill()
            if raw.stat().st_size == 0:
                raw.unlink(missing_ok=True)
                break
            self.segments.append({"raw": raw.name, "file": f"seg_{n:02d}.mp4", "start": started, "end": time.time()})
            n += 1
            if self.unavailable or self._stop.is_set():
                break

    def stop(self) -> list[Path]:
        self._stop.set()
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
        adb(self.device_id, "shell", "pkill", "-l", "INT", "screenrecord", timeout=10)
        if self._thread:
            self._thread.join(timeout=20)
        done: list[Path] = []
        for seg in self.segments:
            mp4 = self.local_dir / seg["file"]
            raw = self.local_dir / seg.get("raw", "")
            if mp4.exists():
                done.append(mp4)
                continue
            if raw.exists() and raw.stat().st_size > 0:
                ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
                try:
                    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-framerate", "30", "-f", "h264", "-i", str(raw), "-c", "copy", str(mp4)], check=True, timeout=120, capture_output=True)
                    raw.unlink(missing_ok=True)
                    done.append(mp4)
                except Exception:  # noqa: BLE001
                    pass
        self.index_file.write_text(json.dumps(self.segments, ensure_ascii=False, indent=1))
        return done


# ───────────────────────── 执行器 ─────────────────────────
def describe_action(action) -> str:
    if not isinstance(action, dict):
        return str(action)[:120]
    kind = action.get("action") or action.get("_metadata") or action.get("type") or "?"
    parts = [str(kind)]
    for key in ("app", "text", "content", "message", "element", "start", "end", "duration"):
        if key in action and action[key] not in (None, ""):
            v = action[key]
            if isinstance(v, str) and len(v) > 60:
                v = v[:60] + "…"
            parts.append(f"{key}={v}")
    return " ".join(parts)


class Bridge:
    def __init__(self, log_dir: Path, device_cfg: dict, settings: dict, max_steps: int,
                 checkpoint_every: int, timeout: int, record: bool):
        self.log_dir = log_dir
        self.task_id = log_dir.name
        self.device_id = device_cfg["device_id"]
        self.settings = settings
        self.max_steps = max_steps
        self.checkpoint_every = checkpoint_every
        self.timeout = timeout
        self.record = record
        self.pending_confirmation: str | None = None
        self.pending_takeover: str | None = None
        self.approve_once = False
        self.initial_task: str | None = None
        self.agent_log = (log_dir / "agent.log").open("a", encoding="utf-8")

        set_device_type({"adb": DeviceType.ADB, "hdc": DeviceType.HDC, "ios": DeviceType.IOS}.get(device_cfg.get("device_type", "adb"), DeviceType.ADB))
        model_config = ModelConfig(base_url=device_cfg["base_url"], model_name=device_cfg.get("model", "autoglm-phone"), api_key=device_cfg.get("api_key", "EMPTY"))
        agent_config = AgentConfig(max_steps=max_steps, device_id=self.device_id, verbose=False, lang="cn", planning_enabled=True, reflection_interval=5,
                                   experiences_dir=str(EXPERIENCES_DIR) if EXPERIENCES_DIR.exists() else None)
        self.agent = PhoneAgent(model_config=model_config, agent_config=agent_config,
                                confirmation_callback=self._on_confirmation, takeover_callback=self._on_takeover)

    # 回调：敏感操作 / 接管
    def _on_confirmation(self, message: str) -> bool:
        if self.approve_once:
            self.approve_once = False
            self.agent_log.write(f"{now_iso()} 敏感操作已按 Tony 批准执行：{message}\n")
            return True
        self.pending_confirmation = message
        return False

    def _on_takeover(self, message: str) -> None:
        self.pending_takeover = message

    # 状态持久化
    def save_state(self, status: str, final_message: str | None = None, extra: dict | None = None) -> None:
        a = self.agent
        state = {
            "task_id": self.task_id,
            "task": a._task or getattr(self, "initial_task", None),
            "status": status,
            "updated_at": now_iso(),
            "step_count": a._step_count,
            "loop_count": a._consecutive_loop_count,
            "context": a._context,
            "action_history": a._action_history,
            "final_message": final_message,
            "pending_confirmation": self.pending_confirmation,
            "pending_takeover": self.pending_takeover,
            "settings": self.settings,
        }
        if extra:
            state.update(extra)
        tmp = self.log_dir / "state.json.tmp"
        tmp.write_text(json.dumps(state, ensure_ascii=False))
        tmp.replace(self.log_dir / "state.json")

    def load_state(self) -> dict:
        state = json.loads((self.log_dir / "state.json").read_text())
        a = self.agent
        a._task = state["task"]
        a._context = state["context"]
        a._step_count = state["step_count"]
        a._action_history = state.get("action_history", [])
        a._consecutive_loop_count = state.get("loop_count", 0)
        return state

    def add_user_note(self, text: str) -> None:
        self.agent._context.append({"role": "user", "content": [{"type": "text", "text": text}]})

    def shot(self, label: str) -> Path | None:
        return screenshot(self.device_id, self.log_dir / "screenshots" / f"{self.agent._step_count:03d}_{label}.png")

    # 主循环：跑一段
    def run_segment(self, task: str | None) -> tuple[str, str | None, Path | None]:
        steps_file = (self.log_dir / "steps.jsonl").open("a", encoding="utf-8")
        started = time.time()
        steps_this_run = 0
        status = "running"
        final_message = None
        last_shot: Path | None = None
        recorder = None
        if self.record:
            recorder = AppRecorder(self.device_id, self.task_id, self.log_dir) if AppRecorder.authorized(self.device_id) else Recorder(self.device_id, self.task_id, self.log_dir)
        if recorder:
            recorder.start()
        if task:
            self.initial_task = task
        adb(self.device_id, "shell", "rm", "-f", f"{HELPER_FILES}/control.json", timeout=10)  # 开跑前的「接管」是过期请求，清掉
        broadcast_status(self.device_id, "running", self.agent._step_count, (task or self.agent._task or "")[:60])
        if self.agent._step_count == 0:
            last_shot = self.shot("start")
        try:
            while True:
                if time.time() - started > self.timeout:
                    status = "timeout"
                    break
                if takeover_requested(self.device_id):
                    status = "needs_takeover"
                    self.pending_takeover = "Tony 在手机上按了「我来接管」"
                    break
                if self.agent._step_count >= self.max_steps:
                    status = "max_steps_reached"
                    break
                self.pending_confirmation = None
                self.pending_takeover = None
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                    result = self.agent.step(task) if (task and self.agent._step_count == 0) else self.agent.step()
                self.agent_log.write(buf.getvalue())
                steps_this_run += 1
                n = self.agent._step_count
                think = (result.thinking or "").replace("\n", " ").strip()
                rec = {"step": n, "ts": now_iso(), "action": result.action, "thinking": think[:300],
                       "success": result.success, "finished": result.finished, "message": result.message}
                steps_file.write(json.dumps(rec, ensure_ascii=False) + "\n")
                steps_file.flush()
                print(f"[{n}] {describe_action(result.action)}" + (f"  —  {think[:90]}" if think else ""))
                broadcast_status(self.device_id, "running", n, describe_action(result.action)[:60])

                if self.pending_confirmation:
                    status = "needs_confirmation"
                    last_shot = self.shot("confirm")
                    break
                if self.pending_takeover:
                    status = "needs_takeover"
                    last_shot = self.shot("takeover")
                    break
                if result.finished:
                    if result.message and str(result.message).startswith("Model error"):
                        status = "error"
                        final_message = str(result.message)
                    else:
                        status = "completed"
                        final_message = result.message
                    last_shot = self.shot("final")
                    break
                every = self.settings.get("screenshotEvery") or 0
                if every and n % every == 0:
                    last_shot = self.shot(f"step_{n}")
                if self.checkpoint_every and steps_this_run % self.checkpoint_every == 0:
                    status = "checkpoint"
                    last_shot = self.shot("checkpoint")
                    break
        except KeyboardInterrupt:
            status = "interrupted"
        except Exception as e:  # noqa: BLE001
            status = "error"
            final_message = f"{type(e).__name__}: {e}"
        finally:
            steps_file.close()
            if recorder:
                recorder.stop()
                if recorder.unavailable:
                    if isinstance(recorder, AppRecorder):
                        print(f"注意：录屏没录上（{recorder.reason}）。请 Tony 打开「小满手机助手」点一下「授权录屏」。")
                    else:
                        print("注意：录屏没录上：小满手机助手还没授权录屏。请 Tony 打开 App 点「授权录屏」（adb 录屏被 ColorOS 拦了）。")
            if last_shot is None:
                last_shot = self.shot(status)
            try:
                pulled = pull_from_phone(self.device_id, shared_root() / "from-phone", quiet=True)
                if pulled:
                    print("手机侧新文件已拉回：" + "、".join(f"shared/from-phone/{p.name}" for p in pulled))
            except Exception:  # noqa: BLE001
                pass
            broadcast_status(self.device_id, "finished" if status == "completed" else ("paused" if status in ("checkpoint", "needs_takeover", "needs_confirmation") else "error"), self.agent._step_count, status)
            self.save_state(status, final_message, {"last_screenshot": str(last_shot) if last_shot else None, "elapsed": int(time.time() - started)})
            self.agent_log.close()
        return status, final_message, last_shot


# ───────────────────────── 输出 ─────────────────────────
LABELS = {
    "completed": "✅ 完成",
    "checkpoint": "⏸ 到检查点，先暂停给 Tony 看一眼",
    "needs_takeover": "🙋 需要 Tony 接管手机",
    "needs_confirmation": "⚠️ 遇到敏感操作，等 Tony 批准",
    "max_steps_reached": "⏸ 到步数上限，没做完",
    "timeout": "⏱ 超时，已中止",
    "error": "❌ 出错",
    "interrupted": "⏹ 被中断",
}


def print_summary(bridge: Bridge, status: str, final_message: str | None, last_shot: Path | None, state: dict | None = None) -> None:
    print("—" * 20)
    print(f"结果：{LABELS.get(status, status)}")
    if final_message:
        print(f"手机端汇报：{final_message}")
    if status == "needs_confirmation":
        print(f"敏感操作：{bridge.pending_confirmation}")
        print(f"Tony 批准后续跑：phone_task.py resume {bridge.task_id} --approve")
        print(f"Tony 不批准：phone_task.py resume {bridge.task_id} --note \"不要做这个操作，换个方式或直接汇报\"")
    elif status == "needs_takeover":
        print(f"接管原因：{bridge.pending_takeover}")
        print(f"Tony 在手机上处理完后续跑：phone_task.py resume {bridge.task_id}")
    elif status == "checkpoint":
        print(f"继续：phone_task.py resume {bridge.task_id}   （可加 --note \"补充指令\"）")
    elif status in ("max_steps_reached", "timeout"):
        print(f"还想继续：phone_task.py resume {bridge.task_id} --max-steps {bridge.max_steps + 15}")
    if last_shot and last_shot.exists():
        try:
            rel = last_shot.relative_to(Path.cwd())
        except ValueError:
            rel = last_shot
        print(f"最后截图：{rel}")
    print(f"已走步数：{bridge.agent._step_count}   日志：{bridge.log_dir}")
    if status in ("error", "timeout", "interrupted"):
        print_status_report()
    sys.exit({"completed": 0, "checkpoint": 4, "needs_takeover": 5, "needs_confirmation": 6}.get(status, 3))


# ───────────────────────── 入口 ─────────────────────────
def load_device_cfg() -> dict:
    if not PROFILE.exists():
        fail(f"缺少 {PROFILE}，auto-phone 环境不完整")
    cfg = json.loads(PROFILE.read_text()).get("device_config", {})
    cfg["device_id"] = os.environ.get("PHONE_AGENT_DEVICE_ID") or cfg.get("device_id") or ""
    cfg["base_url"] = os.environ.get("PHONE_AGENT_BASE_URL") or cfg.get("base_url") or ""
    cfg["model"] = os.environ.get("PHONE_AGENT_MODEL") or cfg.get("model") or "autoglm-phone"
    cfg["api_key"] = os.environ.get("PHONE_AGENT_API_KEY") or cfg.get("api_key") or "EMPTY"
    if not cfg.get("device_id") or not cfg.get("base_url"):
        fail("profile.json 的 device_config 缺 device_id 或 base_url")
    return cfg


def prepare(args, task_dir: Path | None) -> tuple[Bridge, dict]:
    cfg = load_device_cfg()
    check_device(cfg["device_id"])
    settings = phone_settings(cfg["device_id"])
    max_steps = args.max_steps or int(settings.get("maxSteps") or 30)
    checkpoint_every = args.checkpoint_every if args.checkpoint_every is not None else int(settings.get("checkpointEvery") or 0)
    record = (not getattr(args, "no_record", False)) and bool(settings.get("record", True))
    root = Path(args.log_root) if args.log_root else log_root_default()
    if task_dir is None:
        task_dir = root / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4])
    try:
        task_dir.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        fallback = Path(os.environ.get("TMPDIR") or "/tmp") / "phone-logs" / task_dir.name
        print(f"注意：{task_dir.parent} 不可写，日志改放 {fallback}（截图将无法通过微信发出）")
        task_dir = fallback
        task_dir.mkdir(parents=True, exist_ok=True)
    bridge = Bridge(task_dir, cfg, settings, max_steps, checkpoint_every, args.timeout, record)
    return bridge, settings


def cmd_run(args) -> None:
    task = " ".join(args.task).strip()
    if not task:
        fail("任务描述为空")
    bridge, settings = prepare(args, None)
    print(f"任务：{task}")
    print(f"手机：{bridge.device_id}  步数上限：{bridge.max_steps}  检查点：每 {bridge.checkpoint_every or '∞'} 步  录屏：{'开' if bridge.record else '关'}")
    print(f"日志：{bridge.log_dir}")
    print("—" * 20)
    status, final_message, last_shot = bridge.run_segment(task)
    print_summary(bridge, status, final_message, last_shot)


def cmd_resume(args) -> None:
    root = Path(args.log_root) if args.log_root else log_root_default()
    task_dir = resolve_task_dir(root, args.task_id)
    bridge, settings = prepare(args, task_dir)
    state = bridge.load_state()
    prev = state.get("status")
    if prev == "completed":
        fail(f"任务 {bridge.task_id} 已经完成过了，重新 run 一个新任务吧", 3)
    fresh = (state.get("step_count") or 0) == 0
    if fresh:
        # 一步都没走过：不能往空上下文里塞消息（执行器会以为不是第一步而跳过系统提示），把补充拼进任务文本
        extra = []
        if args.note:
            extra.append(f"Tony 的补充：{args.note.strip()}")
        first_task = (state.get("task") or "") + ("\n" + "\n".join(extra) if extra else "")
        print(f"续跑：{bridge.task_id}  任务：{state.get('task')}")
        print(f"上次状态：{LABELS.get(prev, prev)}  还没走过步数，从头开始  本次上限 {bridge.max_steps}  检查点：每 {bridge.checkpoint_every or '∞'} 步")
        print("—" * 20)
        status, final_message, last_shot = bridge.run_segment(first_task)
        print_summary(bridge, status, final_message, last_shot)
        return
    if prev == "needs_confirmation":
        if args.approve:
            bridge.approve_once = True
            bridge.add_user_note(f"上一步的敏感操作「{state.get('pending_confirmation') or ''}」Tony 已经批准，请重新执行该操作并继续任务。")
        else:
            bridge.add_user_note(f"上一步的敏感操作「{state.get('pending_confirmation') or ''}」Tony 没有批准。不要再做这个操作，换一种不涉及它的方式完成任务；做不到就用 finish 汇报目前拿到的信息。")
    elif prev == "needs_takeover":
        bridge.add_user_note("Tony 已经在手机上手动处理完了，请看当前屏幕继续任务。")
    if args.note:
        bridge.add_user_note(f"Tony 的补充指令：{args.note.strip()}")
    print(f"续跑：{bridge.task_id}  任务：{state.get('task')}")
    print(f"上次状态：{LABELS.get(prev, prev)}  已走 {state.get('step_count')} 步  本次上限 {bridge.max_steps}  检查点：每 {bridge.checkpoint_every or '∞'} 步")
    print("—" * 20)
    status, final_message, last_shot = bridge.run_segment(None)
    print_summary(bridge, status, final_message, last_shot)


def cmd_status(args) -> None:
    root = Path(args.log_root) if args.log_root else log_root_default()
    if not root.exists():
        fail("还没有任何手机任务记录", 3)
    task_dir = resolve_task_dir(root, args.task_id or "last")
    state = json.loads((task_dir / "state.json").read_text())
    print(f"任务 {state['task_id']}：{state.get('task')}")
    print(f"状态：{LABELS.get(state.get('status'), state.get('status'))}  步数：{state.get('step_count')}  更新：{state.get('updated_at')}")
    if state.get("final_message"):
        print(f"手机端汇报：{state['final_message']}")
    if state.get("pending_confirmation"):
        print(f"待批准的敏感操作：{state['pending_confirmation']}")
    if state.get("last_screenshot"):
        print(f"最后截图：{state['last_screenshot']}")
    steps = task_dir / "steps.jsonl"
    if steps.exists():
        lines = steps.read_text().strip().splitlines()[-5:]
        for line in lines:
            try:
                rec = json.loads(line)
                print(f"[{rec['step']}] {describe_action(rec.get('action'))}  —  {(rec.get('thinking') or '')[:80]}")
            except json.JSONDecodeError:
                pass
    print(f"日志：{task_dir}")


def cmd_check(args) -> None:
    """只看手机连没连、锁没锁，不动手机。给小满在 Tony 说「连好了」之后复核用。"""
    cfg = load_device_cfg()
    did = cfg["device_id"]
    listing = subprocess.run([ADB, "devices"], capture_output=True, text=True).stdout
    rows = {l.split()[0]: l.split()[1] for l in listing.splitlines()[1:] if len(l.split()) >= 2}
    st = rows.get(did)
    if st is None:
        print(f"手机 {did}：没连在 Mac 上。请 Tony 用数据线接上，USB 调试打开。"); sys.exit(2)
    if st != "device":
        print(f"手机 {did}：状态 {st}，还没授权 USB 调试，请 Tony 在手机弹窗点「允许」。"); sys.exit(2)
    win = adb(did, "shell", "dumpsys", "window", timeout=15) or ""
    if "mDreamingLockscreen=true" in win:
        print(f"手机 {did}：连着，但锁屏了，请 Tony 解锁。"); sys.exit(2)
    print(f"手机 {did}：已连接、已解锁，可以跑。")
    rs = record_status(did)
    print("录屏授权：" + ("已授权" if rs.get("authorized") else "未授权（不影响跑任务，只是没有录像）"))


def cmd_push(args) -> None:
    cfg = load_device_cfg()
    check_device(cfg["device_id"])
    files = [Path(f).expanduser() for f in args.files]
    done = push_to_phone(cfg["device_id"], files)
    for r in done:
        print(f"已推到手机：{r}")
    sys.exit(0 if len(done) == len(files) else 3)


def cmd_pull(args) -> None:
    cfg = load_device_cfg()
    check_device(cfg["device_id"])
    pulled = pull_from_phone(cfg["device_id"], shared_root() / "from-phone")
    print(f"拉回 {len(pulled)} 个新文件" if pulled else "手机那边没有新文件")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log-root", default=None, help="日志根目录（默认 项目 .runtime/workspace/phone-logs）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="开始一个新任务")
    p_run.add_argument("task", nargs="+")
    p_run.add_argument("--max-steps", type=int, default=None, help="总步数上限（默认取手机 App 设置里的 maxSteps，否则 30）")
    p_run.add_argument("--checkpoint-every", type=int, default=None, help="每 N 步暂停一次给 Tony 看截图（默认取 App 设置，0 表示不暂停）")
    p_run.add_argument("--timeout", type=int, default=300, help="本段墙钟上限（秒）")
    p_run.add_argument("--no-record", action="store_true", help="本次不录屏")
    p_run.set_defaults(func=cmd_run)

    p_res = sub.add_parser("resume", help="从上次暂停处继续")
    p_res.add_argument("task_id", help="任务 id 或 last")
    p_res.add_argument("--approve", action="store_true", help="批准上次停下的那个敏感操作（只批一次）")
    p_res.add_argument("--note", default=None, help="Tony 的补充指令")
    p_res.add_argument("--max-steps", type=int, default=None)
    p_res.add_argument("--checkpoint-every", type=int, default=None)
    p_res.add_argument("--timeout", type=int, default=300)
    p_res.add_argument("--no-record", action="store_true")
    p_res.set_defaults(func=cmd_resume)

    p_chk = sub.add_parser("check", help="只看手机连没连、锁没锁")
    p_chk.set_defaults(func=cmd_check)

    p_push = sub.add_parser("push", help="把文件推到手机的 Download/小满/（给 App 用：发图、传文件）")
    p_push.add_argument("files", nargs="+")
    p_push.set_defaults(func=cmd_push)

    p_pull = sub.add_parser("pull", help="把手机 Download/小满/ 里的新文件拉回 shared/from-phone/")
    p_pull.set_defaults(func=cmd_pull)

    p_st = sub.add_parser("status", help="看某个任务（默认最近一个）的状态")
    p_st.add_argument("task_id", nargs="?", default=None)
    p_st.set_defaults(func=cmd_status)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
