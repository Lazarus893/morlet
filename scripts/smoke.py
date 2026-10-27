#!/usr/bin/env python3
"""Boot an isolated, unbound web host. Never reuse the live runtime or credentials."""
import http.cookiejar
import json
import os
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from configure import configure, control_socket
from source_files import source_files
from pa_config import load_config, write_config, config_revision

ROOT = Path(__file__).resolve().parents[1]


def smoke(root):
    configure(root)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = dict(os.environ)
    for name in ("DEEPSEEK_API_KEY", "WEIXIN_ILINK_CREDENTIAL", "PHONE_AGENT_API_KEY", "PHONE_AGENT_DEVICE_ID"):
        env.pop(name, None)
    env.update({"DSH_HOME": str(root / ".runtime/dsh"),
                "XIAOMAN_PROJECT_ROOT": str(root),
                "XIAOMAN_STATUS_SCRIPT": str(root / "bin/status_report.py"),
                "DSH_LOG_FILE": str(root / ".runtime/logs/cordis.log")})
    log_path = root / ".runtime/logs/smoke.log"
    with log_path.open("w") as log:
        process = subprocess.Popen([str(root / "node_modules/.bin/dsh"), "--profile", "wx-life",
            "--no-open", "--port", str(port)], cwd=root / ".runtime/workspace",
            env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            deadline = time.monotonic() + 45
            url = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("Isolated dsh exited before becoming ready")
                match = re.search(r"http://127\.0\.0\.1:\d+/\?token=[^\s]+", log_path.read_text())
                if match:
                    url = match.group(0)
                    break
                time.sleep(0.2)
            if not url:
                raise TimeoutError("dsh did not announce its local URL")
            transport = control_socket(root)
            if not transport.is_socket():
                raise RuntimeError("Weixin control socket did not start")
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(2)
                client.connect(str(transport))
            def management():
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(3)
                    client.connect(str(transport))
                    client.sendall(b'{"command":"pa","operation":"snapshot"}\n')
                    data = b""
                    while b"\n" not in data:
                        chunk = client.recv(65536)
                        if not chunk: raise RuntimeError("Management socket closed early")
                        data += chunk
                    return json.loads(data.split(b"\n")[0])["data"]
            initial = management()
            if initial["protocol"] != 1 or initial["configRevision"] != config_revision(load_config(root)):
                raise RuntimeError("Management revision did not match generated configuration")
            cfg = load_config(root)
            cfg["owner"] = "隔离重载测试"
            write_config(cfg, root)
            configure(root)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    if management()["configRevision"] == config_revision(cfg): break
                except (OSError, KeyError, RuntimeError): pass
                time.sleep(0.2)
            else: raise RuntimeError("Live profile reload did not adopt the saved configuration")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            with opener.open(url, timeout=30) as response:
                body = response.read()
                if response.status != 200 or b"<!doctype html" not in body.lower():
                    raise RuntimeError("Unexpected web response")
                print(f"Isolated web smoke passed: HTTP 200, {len(body):,} HTML bytes; management protocol and live configuration reload verified")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def main():
    if not (ROOT / "node_modules/.bin/dsh").is_file():
        raise SystemExit("Run pa.sh setup first")
    with tempfile.TemporaryDirectory(prefix="pa-smoke-") as temporary:
        root = Path(temporary)
        for source in source_files(ROOT):
            target = root / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        smoke(root)


if __name__ == "__main__":
    main()
