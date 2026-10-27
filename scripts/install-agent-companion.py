#!/usr/bin/env python3
"""Import a downloaded private configuration and run the local Mac companion."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import sys
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
from pa_config import agent_command


def prepare(source, kind, protect_source=True):
    source = Path(source).expanduser().resolve()
    if not source.is_file() or source.stat().st_uid != os.getuid() or source.stat().st_size > 16000:
        raise ValueError("Choose the configuration downloaded for this Mac.")
    value = json.loads(source.read_text())
    if not isinstance(value, dict):
        raise ValueError("Choose a valid connection configuration.")
    url = urlparse(value.get("endpoint", ""))
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"}):
        raise ValueError("Use HTTPS or a local SSH tunnel.")
    if kind == "agent":
        provider = value.get("provider")
        if provider not in {"codex", "workbuddy"}:
            raise ValueError("Choose Codex or WorkBuddy.")
        workspace = Path(value.get("workspace", "")).expanduser().resolve()
        if not value.get("workspace") or not workspace.is_dir():
            raise ValueError("Choose an existing local workspace.")
        value["workspace"] = str(workspace)
        requested = value.get("command") or ""
        if requested in ({"codex"} if provider == "codex" else {"codebuddy"}):
            requested = ""
        command = agent_command({"agent": {"provider": provider, "command": requested}}, ROOT)
        executable = shutil.which(command)
        if not executable:
            raise ValueError("Install and sign in to the selected local Agent first.")
        value["command"] = executable
    else:
        command = value.get("command") or "imsg"
        executable = shutil.which(command)
        if not executable and command == "imsg":
            bundled = ROOT / ".runtime" / "bin" / "imsg"
            if bundled.is_file() and os.access(bundled, os.X_OK):
                executable = str(bundled.resolve())
        if not executable:
            raise ValueError("Install imsg, sign in to Messages, and grant its host Full Disk Access and Messages Automation first.")
        value["command"] = executable
    if protect_source:
        source.chmod(0o600)
    return value


def validate(value, kind, node, temporary):
    module = ROOT / "plugins/agent-hub" / ("companion.mjs" if kind == "agent" else "imessage.mjs")
    loader = "loadAgentConfig" if kind == "agent" else "loadMessageConfig"
    probe = ", checkMessageChat, resolveMessageChat" if kind == "imessage" else ""
    resolve = ("const raw = JSON.parse(readFileSync(process.argv[1], 'utf8')); "
               "raw.chatId = await resolveMessageChat(raw); writeFileSync(process.argv[1], JSON.stringify(raw)); ") if kind == "imessage" else ""
    check = "await checkMessageChat(config);" if kind == "imessage" else ""
    validation = ("import { readFileSync, writeFileSync } from 'node:fs'; "
                  f"import {{ {loader}{probe} }} from {json.dumps(module.as_uri())}; "
                  f"try {{ {resolve} const config = {loader}(process.argv[1]); {check} }} "
                  "catch (error) { console.error(error.code || 'INVALID_CONFIG'); process.exitCode = 1; }")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    result = subprocess.run([node, "--input-type=module", "-e", validation, str(temporary)], capture_output=True, timeout=40)
    if result.returncode:
        code = getattr(result, "stderr", b"").decode(errors="replace").strip().splitlines()[-1:]
        messages = {
            "IMESSAGE_IDENTITIES_REQUIRED": "请分别填写小满的收信地址和你自己的发信地址；两者必须不同。",
            "IMESSAGE_ACCOUNT_MISMATCH": "该私聊的收信地址与小满账号不符。请在信息设置核对小满地址，并从你的手机向它发信后重试。",
            "IMESSAGE_CHAT_ACCESS_REQUIRED": "Cannot read this Messages chat. Grant the running host Full Disk Access, restart it, and check the chat ID.",
            "IMESSAGE_DIRECT_CHAT_REQUIRED": "Choose an existing direct chat with exactly one other participant.",
            "IMESSAGE_SERVICE_REQUIRED": "Choose an iMessage chat; SMS is not supported.",
            "IMESSAGE_PEER_MISMATCH": "The chat participant does not match the configured sender. Check the number or email.",
            "IMESSAGE_NOT_INSTALLED": "The configured imsg executable is unavailable.",
            "IMESSAGE_CHAT_NOT_FOUND": "未找到该联系人的近期 iMessage 私聊。先向小满发一条消息，再重试；或在高级设置指定 chat ID。",
            "IMESSAGE_CHAT_AMBIGUOUS": "该联系人对应多个私聊。请在高级设置指定 chat ID，不会自动选取。",
        }
        raise ValueError(messages.get(code[0] if code else "", "The downloaded connection settings are invalid."))


def check_config(source, kind):
    value = prepare(source, kind, protect_source=False)
    node = shutil.which("node")
    if not node:
        raise ValueError("Node.js 22.19 or newer is required.")
    with tempfile.TemporaryDirectory(prefix="xiaoman-preflight-") as directory:
        temporary = Path(directory) / "config.json"
        temporary.touch(mode=0o600)
        validate(value, kind, node, temporary)
    return {"valid": True, "kind": kind, "login": "unchecked", "delivery": "unchecked"}


def install(args):
    if os.uname().sysname != "Darwin":
        raise ValueError("This installer requires macOS; use the Node runner directly on other systems.")
    value = prepare(args.config, args.kind)
    node = shutil.which("node")
    if not node:
        raise ValueError("Node.js 22.19 or newer is required.")
    directory = ROOT / ".runtime"
    directory.mkdir(exist_ok=True, mode=0o700)
    identity = value.get("endpointId" if args.kind == "agent" else "channelId", "")
    if identity and not re.fullmatch(r"[a-f0-9-]{36}", identity):
        raise ValueError("Invalid connection identity.")
    suffix = "-" + identity if identity else ""
    target = directory / f"{args.kind}-companion{suffix}.json"
    label = f"com.xiaoman.{args.kind}-companion{suffix}"
    logs = directory / "logs" / "agents"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    logs.chmod(0o700)
    log = logs / f"{label}.log"
    log.touch(mode=0o600, exist_ok=True)
    log.chmod(0o600)
    agents = Path.home() / "Library/LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    path = agents / f"{label}.plist"
    previous_config = target.read_bytes() if target.exists() else None
    previous_service = path.read_bytes() if path.exists() else None
    fd, temporary_name = tempfile.mkstemp(prefix=target.stem + "-", suffix=".tmp", dir=directory)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        validate(value, args.kind, node, temporary)
        data = {"Label": label, "ProgramArguments": [node, str(ROOT / "scripts" / f"{args.kind}-companion.mjs"), str(target)],
                "WorkingDirectory": str(ROOT), "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 20,
                "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin")},
                "StandardOutPath": str(log), "StandardErrorPath": str(log)}
        domain = f"gui/{os.getuid()}"
        changed = False
        try:
            temporary.replace(target)
            changed = True
            path.write_bytes(plistlib.dumps(data))
            path.chmod(0o600)
            subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], capture_output=True, timeout=10)
            subprocess.run(["launchctl", "bootstrap", domain, str(path)], check=True, capture_output=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            if changed:
                try:
                    subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], capture_output=True, timeout=10)
                except (OSError, subprocess.SubprocessError):
                    pass
                for file, previous in ((target, previous_config), (path, previous_service)):
                    if previous is None:
                        file.unlink(missing_ok=True)
                    else:
                        file.write_bytes(previous)
                        file.chmod(0o600)
                if previous_service is not None:
                    try:
                        subprocess.run(["launchctl", "bootstrap", domain, str(path)], capture_output=True, timeout=15)
                    except (OSError, subprocess.SubprocessError):
                        pass
            raise ValueError("连接服务安装失败，已恢复原配置；请检查 LaunchAgent 状态后重试。") from None
    finally:
        temporary.unlink(missing_ok=True)
    print("Local companion installed. Return to Xiaoman and wait for its online status.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--kind", choices=["agent", "imessage"], default="agent")
    try:
        install(parser.parse_args())
    except (ValueError, TypeError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else "Installation failed; check the local file and LaunchAgent status.")
