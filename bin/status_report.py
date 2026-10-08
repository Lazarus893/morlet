#!/usr/bin/env python3
"""各设备在线状态一览：出错时用它代替「发生错误」，让 Tony 一眼定位。

用法：status_report.py [--error CODE] [--json] [--fast]
  --error CODE  在报告开头写上这轮的错误码和一句定位提示
  --fast        跳过模型 API 探测（省 1–3 秒）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from runtime_paths import ADB, DSH_HOME, PHONE_PROFILE as PROFILE_JSON, PROFILE_DIR, WORKSPACE, PORT, CONTROL_SOCKET
CRED = DSH_HOME / ".credentials.yaml"
WXDIR = PROFILE_DIR / "weixin"
HELPER_PKG = "com.agent.helper"
HELPER_FILES = f"/sdcard/Android/data/{HELPER_PKG}/files"

HINTS = {
    "REQUEST_EXTENSION": "dsh 的 DeepSeek 请求扩展准备失败：多半是 profile 里某个本地插件的 package.json 缺 name/version，或扩展提供方异常；看 .runtime/logs/cordis.log。",
    "TOOL_TIMEOUT": "工具调用超时：手机任务跑太久，或 bash timeoutMs 没设够（应 ≥ 400000）。",
    "LLM": "模型请求失败：看下面「模型 API」是否在线，密钥是否过期，网络是否通。",
    "SANDBOX": "沙箱拒绝了写操作：路径在工作区之外；手机任务日志应在工作区 phone-logs/ 下。",
    "ABORTED": "这轮被取消了（/bot-cancel 或超时）。",
}


def sh(cmd: list[str], timeout: float = 6) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.stdout + r.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return f"<err {type(e).__name__}>"


def check_dsh() -> dict:
    pid = sh(["/usr/sbin/lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN", "-t"]).split("\n")[0].strip()
    if not pid.isdigit():
        return {"online": False, "detail": f"端口 {PORT} 没有监听"}
    started = sh(["ps", "-o", "lstart=", "-p", pid]).strip()
    return {"online": True, "detail": f"pid {pid}，启动于 {started}"}


def check_model(fast: bool) -> dict:
    if fast:
        return {"online": None, "detail": "未探测（--fast）"}
    key = os.environ.get("DEEPSEEK_API_KEY")
    try:
        m = re.search(r"^\s*DEEPSEEK_API_KEY:\s*['\"]?([^'\"\n]+)", CRED.read_text(), re.M)
        key = key or (m.group(1).strip() if m else None)
    except OSError:
        pass
    if not key:
        return {"online": False, "detail": "凭证文件里没有 DEEPSEEK_API_KEY"}
    req = urllib.request.Request("https://api.deepseek.com/models", headers={"Authorization": f"Bearer {key}"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            ok = resp.status == 200
        return {"online": ok, "detail": f"HTTP {resp.status}，{int((time.time() - t0) * 1000)} ms"}
    except Exception as e:  # noqa: BLE001
        return {"online": False, "detail": f"{type(e).__name__}: {str(e)[:80]}"}


def check_phone() -> dict:
    did = os.environ.get("PHONE_AGENT_DEVICE_ID", "")
    try:
        did = did or json.loads(PROFILE_JSON.read_text()).get("device_config", {}).get("device_id", "")
    except Exception:  # noqa: BLE001
        pass
    out = sh([ADB, "devices", "-l"])
    rows = {l.split()[0]: l for l in out.splitlines()[1:] if l.strip()}
    row = rows.get(did)
    if row is None:
        return {"online": False, "detail": f"{did or '?'} 未连接（adb 看不到）", "id": did, "state": "absent"}
    state = row.split()[1]
    if state != "device":
        return {"online": False, "detail": f"{did} 状态 {state}（未授权 USB 调试或离线）", "id": did, "state": state}
    model = re.search(r"model:(\S+)", row)
    win = sh([ADB, "-s", did, "shell", "dumpsys window | grep -m1 mDreamingLockscreen"], 8)
    locked = "mDreamingLockscreen=true" in win
    return {"online": True, "detail": f"{did}（{model.group(1) if model else '?'}）{'锁屏中' if locked else '已解锁'}", "id": did, "state": "locked" if locked else "connected"}


def check_app(phone: dict) -> dict:
    if not phone.get("online"):
        return {"online": None, "detail": "手机不在线，无法确认"}
    did = phone["id"]
    pkg = sh([ADB, "-s", did, "shell", f"pm list packages {HELPER_PKG}"])
    if HELPER_PKG not in pkg:
        return {"online": False, "detail": "小满手机助手未安装"}
    ver = re.search(r"versionName=(\S+)", sh([ADB, "-s", did, "shell", f"dumpsys package {HELPER_PKG} | grep -m1 versionName"], 8))
    rec = sh([ADB, "-s", did, "shell", f"cat {HELPER_FILES}/record-status.json 2>/dev/null"])
    try:
        rj = json.loads(rec)
        recording = "录屏已授权" + ("，正在录" if rj.get("recording") else "") if rj.get("authorized") else "录屏未授权"
    except json.JSONDecodeError:
        recording = "录屏状态未知"
    ctl = sh([ADB, "-s", did, "shell", f"cat {HELPER_FILES}/control.json 2>/dev/null"])
    takeover = "，有未消费的「我来接管」" if '"takeover":true' in ctl.replace(" ", "") else ""
    proj = sh([ADB, "-s", did, "shell", "dumpsys media_projection | grep -m1 'uid='"], 8)
    cast = "投屏开着（%s）" % (re.search(r"\(([^,]+),", proj).group(1) if re.search(r"\(([^,]+),", proj) else proj.strip()) if "uid=" in proj else "投屏关着"
    return {"online": True, "detail": f"已安装 v{ver.group(1) if ver else '?'}，{recording}，{cast}{takeover}"}


def check_weixin() -> dict:
    sync = WXDIR / "sync.json"
    sock = CONTROL_SOCKET
    if not sock.exists():
        return {"online": False, "detail": "控制 socket 不存在，通道插件没起来"}
    try:
        age = int(time.time() - sync.stat().st_mtime)
        return {"online": True, "detail": f"iLink 游标 {age // 60} 分钟前更新"}
    except OSError:
        return {"online": True, "detail": "socket 在，游标文件缺失（还没收过消息）"}


def check_router() -> dict:
    log = WORKSPACE / "shared/intent-log.jsonl"
    try:
        last = log.read_text().strip().splitlines()[-1]
        j = json.loads(last)
        if j.get("error"):
            return {"online": False, "detail": f"上次分流失败：{j['error'][:80]}（{j['ts']}）"}
        return {"online": True, "detail": f"上次 {j['ts']} route={j.get('result', {}).get('route')} {j.get('ms')} ms"}
    except Exception:  # noqa: BLE001
        return {"online": None, "detail": "还没有分流记录"}


def mark(v) -> str:
    return "online" if v is True else ("offline" if v is False else "未知")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--error", default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--fast", action="store_true")
    args = ap.parse_args()
    phone = check_phone()
    report = {
        f"小满（Mac dsh {PORT}）": check_dsh(),
        "模型 API（DeepSeek）": check_model(args.fast),
        "手机": phone,
        "小满手机助手": check_app(phone),
        "微信通道（iLink）": check_weixin(),
        "意图分流器": check_router(),
    }
    if args.json:
        print(json.dumps({"error": args.error, "report": report}, ensure_ascii=False, indent=1))
        return
    lines = []
    if args.error:
        code = args.error.strip()
        hint = next((h for k, h in HINTS.items() if k in code.upper()), "没有现成的定位提示，先看下面哪一项 offline。")
        lines.append(f"这轮没处理成功：{code}")
        lines.append(f"定位：{hint}")
        lines.append("")
    lines.append("设备状态：")
    for name, r in report.items():
        lines.append(f"- {name}：{mark(r.get('online'))}，{r.get('detail')}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
