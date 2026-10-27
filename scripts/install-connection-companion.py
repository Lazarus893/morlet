#!/usr/bin/env python3
"""Install this Mac's companion and encrypted SSH tunnel using private local config."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


def install(args):
    if os.uname().sysname != "Darwin":
        raise ValueError("The companion installer runs on the paired Mac.")
    config_path = ROOT / ".runtime/connection-companion.json"
    if not config_path.exists():
        raise ValueError("Create the private .runtime/connection-companion.json before installing.")
    config = json.loads(config_path.read_text())
    endpoint = urlparse(config.get("endpoint", ""))
    if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port:
        raise ValueError("The installed tunnel requires a loopback HTTP endpoint.")
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+", args.ssh_host):
        raise ValueError("Invalid SSH host.")
    if not 1 <= args.ssh_port <= 65535 or not 1 <= args.remote_port <= 65535:
        raise ValueError("Invalid SSH port.")
    node = shutil.which("node")
    if not node:
        raise ValueError("Node.js is required.")
    subprocess.run([sys.executable, str(ROOT / 'scripts/install-macos-file-access.py')], check=True)
    config_path.chmod(0o600)
    agents = Path.home() / "Library/LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    logs = ROOT / ".runtime/logs/connections"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    logs.chmod(0o700)
    tunnel = ["/usr/bin/ssh", "-N", "-L", f"127.0.0.1:{endpoint.port}:127.0.0.1:{args.remote_port}", "-p", str(args.ssh_port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", args.ssh_host]
    commands = {
        "com.xiaoman.connection-tunnel": tunnel,
        "com.xiaoman.connection-companion": [node, str(ROOT / "scripts/connection-companion.mjs")],
    }
    domain = f"gui/{os.getuid()}"
    for label, command in commands.items():
        path = agents / f"{label}.plist"
        data = {"Label": label, "ProgramArguments": command, "WorkingDirectory": str(ROOT),
                "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 15,
                "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin"),
                                         **({"TZ": os.environ["TZ"]} if os.environ.get("TZ") else {})},
                "StandardOutPath": str(logs / f"{label}.log"), "StandardErrorPath": str(logs / f"{label}.log")}
        path.write_bytes(plistlib.dumps(data)); path.chmod(0o600)
        log = logs / f"{label}.log"
        log.touch(mode=0o600, exist_ok=True); log.chmod(0o600)
        subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        subprocess.run(["launchctl", "bootstrap", domain, str(path)], check=True)
    print("Installed Mac connection companion and SSH tunnel. Credentials stay in the private local config.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--ssh-port", type=int, default=22)
    parser.add_argument("--remote-port", type=int, default=3083)
    try:
        install(parser.parse_args())
    except (ValueError, OSError, subprocess.CalledProcessError):
        raise SystemExit("Companion install failed. Check the private config, SSH access and LaunchAgent status.")
