#!/usr/bin/env python3
"""Guided connection entry points. Checks never send messages or run model tasks."""
import argparse
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlparse
from urllib.request import build_opener, HTTPCookieProcessor, HTTPRedirectHandler, ProxyHandler, Request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
from pa_config import agent_command


def discover():
    agents = []
    for provider in ("codex", "workbuddy"):
        command = agent_command({"agent": {"provider": provider, "command": ""}}, ROOT)
        executable = shutil.which(command)
        agents.append({"provider": provider, "installed": bool(executable), "command": executable,
                       "login": "unchecked", "next": "在本机 CLI 完成登录；连接在线后再发起第一条任务。"})
    return {"platform": sys.platform, "agents": agents,
            "node": shutil.which("node"), "imsg": shutil.which("imsg") or
            (str(ROOT / ".runtime/bin/imsg") if os.access(ROOT / ".runtime/bin/imsg", os.X_OK) else None),
            "note": "仅检查可执行文件；不代表账号已登录、系统已授权或消息可收发。"}


def installer():
    spec = importlib.util.spec_from_file_location("local_installer", ROOT / "scripts/install-agent-companion.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("连接地址发生跳转，请使用小满页面的直接地址。")


def local_agent(url, provider, workspace=None):
    target = urlparse(url)
    if target.scheme != "http" or target.hostname != "127.0.0.1" or target.path not in ("", "/") or target.query or target.fragment or target.username or target.password:
        raise ValueError("同机绑定只支持 http://127.0.0.1:端口；服务器部署请下载配置后使用 --config。")
    origin = url.rstrip("/")
    client = build_opener(ProxyHandler({}), HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect())
    def request(path, payload=None, csrf=None):
        headers = {"Origin": origin}
        if payload is not None:
            headers.update({"Content-Type": "application/json", "X-PA-CSRF": csrf})
        req = Request(origin + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
        with client.open(req, timeout=120) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("小满返回的数据过大。")
        if path == "/":
            return
        value = json.loads(raw)
        if not value.get("ok"):
            raise ValueError("本地连接未完成，请在 Web 查看状态后重试。")
        return value["data"]
    request("/")
    state = request("/api/state")
    result = request("/api/local-agents", {"provider": provider, "workspace": workspace}, state["csrf"])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("已找到现有配对；请在 Web 核对在线状态。" if result.get("reused") else
          "连接助手已安装。返回「消息与任务」等待在线，再发送第一条任务验证登录。")


def choose_config():
    if sys.platform != "darwin":
        raise ValueError("请用 --config 指定从小满下载的配置。")
    result = subprocess.run(["osascript", "-e", 'POSIX path of (choose file with prompt "选择从小满下载的私密连接配置" of type {"public.json"})'],
                            capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise ValueError("已取消选择，未安装连接助手。")
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description="小满连接向导：微信、iMessage、本地 Agent")
    sub = parser.add_subparsers(dest="target", required=True)
    probe = sub.add_parser("discover", help="只读发现本机工具，不检查登录或发送消息")
    probe.add_argument("--json", action="store_true")
    weixin = sub.add_parser("weixin", help="打开微信扫码与身份确认页面")
    weixin.add_argument("--url", default=os.environ.get("PA_WEB_ORIGIN") or "http://127.0.0.1:" + os.environ.get("PA_WEB_PORT", "3083"))
    weixin.add_argument("--no-open", action="store_true")
    for name in ("agent", "imessage"):
        item = sub.add_parser(name, help="预检或安装本地连接助手")
        item.add_argument("--config", help="从 Web 下载的私密连接配置")
        item.add_argument("--check", action="store_true", help="仅预检配置；不安装服务、不领取任务、不发消息")
        if name == "agent":
            item.add_argument("--provider", choices=["codex", "workbuddy"], default="codex")
            item.add_argument("--workspace", help="已有工作目录；默认使用小满的专用目录")
            item.add_argument("--url", default="http://127.0.0.1:" + os.environ.get("PA_WEB_PORT", "3083"))
    sub.add_parser("install", help="Mac 文件选择器：安装下载的 Agent 或 iMessage 配置")
    args = parser.parse_args()
    if args.target == "discover":
        print(json.dumps(discover(), ensure_ascii=False, indent=2))
    elif args.target == "weixin":
        url = urlparse(args.url)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
            raise ValueError("请提供小满 Web 的 HTTP(S) 地址。")
        print("1. 打开「连接」→ 微信，启用入口并启动服务。\n2. 点击扫码登录，用手机微信完成确认。\n3. 给机器人发一条文字；回页面核对发信时间与身份，点击允许。\n4. 应用配置后重新发送 /bot-ping，再发送一条普通文字验证 Agent。")
        print("扫码只完成账号连接；允许身份、服务生效、实际回复需分别确认。")
        print(args.url)
        if not args.no_open:
            webbrowser.open(args.url)
    else:
        if args.target == "install":
            config = choose_config()
            path = Path(config)
            if path.stat().st_size > 16000:
                raise ValueError("请选择小满下载的连接配置。")
            value = json.loads(path.read_text())
            if not isinstance(value, dict) or ("endpointId" in value) == ("channelId" in value):
                raise ValueError("无法识别配置类型。")
            args = argparse.Namespace(config=config, kind="agent" if "endpointId" in value else "imessage", check=False)
        else:
            args.kind = args.target
        if args.config:
            module = installer()
            if args.check:
                module.check_config(args.config, args.kind)
                print("预检通过；未安装或启动服务。账号登录、后台权限、上线和真实收发仍需分别验证。")
            else:
                module.install(args)
        elif args.target == "agent" and not args.check:
            local_agent(args.url, args.provider, args.workspace)
        else:
            print(json.dumps(discover(), ensure_ascii=False, indent=2))
            print("iMessage：请在专用 macOS 用户登录「信息」，授权实际宿主完整磁盘访问，向 bot 发一条私聊；从 Web 下载配置，再执行 connect imessage --config <文件>。" if args.target == "imessage" else "从 Web 下载配置，用 connect agent --config <文件> --check 预检。")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, OSError, subprocess.SubprocessError):
        # Avoid echoing HTTP bodies, private tokens, or native account diagnostics.
        error = sys.exc_info()[1]
        print(str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else
              "连接未完成：检查配置文件、小满服务和本机工具后重试。未验证真实收发。", file=sys.stderr)
        sys.exit(2)
