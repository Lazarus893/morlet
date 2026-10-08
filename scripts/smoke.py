#!/usr/bin/env python3
"""Start an isolated web smoke test, fetch its page, then stop only that process."""
import http.cookiejar
import os
import re
import signal
import socket
import subprocess
import time
import urllib.request
from pathlib import Path
from configure import configure, control_socket

ROOT = Path(__file__).resolve().parents[1]


def main():
    configure()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = dict(os.environ)
    for name in ("DEEPSEEK_API_KEY", "WEIXIN_ILINK_CREDENTIAL", "PHONE_AGENT_API_KEY"):
        env.pop(name, None)
    env.update({"DSH_HOME": str(ROOT / ".runtime/dsh"),
                "XIAOMAN_PROJECT_ROOT": str(ROOT),
                "XIAOMAN_STATUS_SCRIPT": str(ROOT / "bin/status_report.py"),
                "DSH_LOG_FILE": str(ROOT / ".runtime/logs/cordis.log")})
    log_path = ROOT / ".runtime/logs/smoke.log"
    with log_path.open("w") as log:
        process = subprocess.Popen([str(ROOT / "node_modules/.bin/dsh"), "--profile", "wx-life",
            "--no-open", "--port", str(port)], cwd=ROOT / ".runtime/workspace",
            env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            deadline = time.monotonic() + 45
            url = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("dsh exited; inspect .runtime/logs/smoke.log")
                match = re.search(r"http://127\.0\.0\.1:\d+/\?token=[^\s]+", log_path.read_text())
                if match:
                    url = match.group(0)
                    break
                time.sleep(0.2)
            if not url:
                raise TimeoutError("dsh did not announce its local URL")
            transport = control_socket(ROOT)
            if not transport.is_socket():
                raise RuntimeError("Weixin control socket did not start")
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(2)
                client.connect(str(transport))
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            with opener.open(url, timeout=30) as response:
                body = response.read()
                if response.status != 200 or b"<!doctype html" not in body.lower():
                    raise RuntimeError("Unexpected web response")
                print(f"Web smoke passed: authenticated HTTP 200, {len(body):,} HTML bytes; Weixin socket connected")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


if __name__ == "__main__":
    main()
