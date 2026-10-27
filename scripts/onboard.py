"""Configure adapters and diagnose dependencies without contacting accounts/devices."""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
from pa_config import config_revision, load_config, write_config, agent_command, capabilities, device_config


def doctor(cfg, root=ROOT):
    command = agent_command(cfg, root)
    resolved = shutil.which(command)
    checks = [{"id": "agent", "ok": bool(resolved), "detail": f"{cfg['agent']['provider']}: {command}"},
              {"id": "channel-runtime", "ok": (root / "node_modules/.bin/dsh").is_file(), "detail": "微信宿主依赖；setup 安装"},
              {"id": "weixin-access", "ok": cfg["im"]["provider"] == "disabled" or bool(cfg["im"]["allow_from"]),
               "detail": "微信只接受 allow_from 中的用户；未配置时拒绝所有消息"}]
    if resolved and cfg["agent"]["provider"] != "dsh":
        try:
            args = [resolved, "app-server", "--help"] if cfg["agent"]["provider"] == "codex" else [resolved, "--help"]
            result = subprocess.run(args, capture_output=True, text=True, timeout=15)
            expected = ("stdio",) if cfg["agent"]["provider"] == "codex" else ("--input-format", "--output-format", "--permission-mode")
            checks.append({"id": "agent-protocol", "ok": result.returncode == 0 and all(flag in result.stdout + result.stderr for flag in expected),
                           "detail": "本机 CLI 协议检查（仅 --help，不检查登录、不调用模型）"})
        except (OSError, subprocess.SubprocessError):
            checks.append({"id": "agent-protocol", "ok": False, "detail": "CLI 帮助检查失败或超时"})
    if cfg["device"]["provider"] == "android":
        checks.append({"id": "adb", "ok": bool(shutil.which(os.environ.get("ADB", "adb"))), "detail": "需要 Android platform-tools"})
        checks.append({"id": "device-id", "ok": bool(os.environ.get("PHONE_AGENT_DEVICE_ID") or cfg["device"]["id"]), "detail": "需要明确的 Android device ID"})
    if cfg["device"]["provider"] != "none":
        checks.append({"id": "phone-model", "ok": bool(device_config(root).get("base_url")), "detail": "手机视觉模型 PHONE_AGENT_BASE_URL / phone.json；连通性未探测"})
    return {"checks": checks, "capabilities": capabilities(cfg, root), "device": cfg["device"]["provider"],
            "note": "doctor 只检查本机安装和配置。账号登录、微信送达、模型和真机需要另行验收。"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "doctor", "capabilities", "device-status", "pending-users"])
    parser.add_argument("--agent", choices=["dsh", "codex", "workbuddy"])
    parser.add_argument("--agent-command", help="可执行文件路径，不能包含命令参数")
    parser.add_argument("--model", help="所选 Agent 的模型名称；留空使用默认值")
    parser.add_argument("--model-provider", help="DSH 中已注册的模型提供方名称")
    parser.add_argument("--owner")
    parser.add_argument("--device", choices=["none", "android", "ios"])
    parser.add_argument("--device-id")
    parser.add_argument("--wda-url")
    parser.add_argument("--allow-from", action="append", help="允许的微信 user ID，可重复；传入时替换原列表")
    parser.add_argument("--im", choices=["weixin", "disabled"])
    parser.add_argument("--proactive", choices=["on", "off"], help="启用/关闭主动跟进；已存在配置默认关闭")
    parser.add_argument("--timezone", help="提醒使用的 IANA 时区，如 Asia/Shanghai；默认 local")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.action == "pending-users":
        records = [json.loads(path.read_text()) for path in sorted((ROOT / ".runtime/pairing").glob("*.json"))]
        print(json.dumps(records, ensure_ascii=False, indent=2))
        print("核对发信人后，用 init --allow-from <userId> 设置白名单；配置重载或重启后生效。", file=sys.stderr)
        return
    cfg = load_config()
    revision = config_revision(cfg)
    if args.action == "init":
        if args.agent: cfg["agent"]["provider"] = args.agent; cfg["agent"]["command"] = ""
        if args.agent_command is not None: cfg["agent"]["command"] = args.agent_command
        if args.model is not None: cfg["agent"]["model"] = args.model
        if args.model_provider is not None: cfg["agent"]["model_provider"] = args.model_provider
        if args.owner is not None: cfg["owner"] = args.owner
        if args.device: cfg["device"]["provider"] = args.device
        if args.device_id is not None: cfg["device"]["id"] = args.device_id
        if args.wda_url: cfg["device"]["wda_url"] = args.wda_url
        if args.allow_from is not None: cfg["im"]["allow_from"] = args.allow_from
        if args.im: cfg["im"]["provider"] = args.im
        if args.proactive: cfg["proactive"]["enabled"] = args.proactive == "on"
        if args.timezone: cfg["proactive"]["timezone"] = args.timezone
        write_config(cfg, expected_revision=revision)
        print("已保存 .runtime/pa.json；运行 configure 生成配置，start 启动。")
        return
    if args.action == "device-status":
        from pa_config import device_config
        from devices import probe_device
        report = probe_device(device_config())
    elif args.action == "capabilities":
        report = capabilities(cfg)
    else:
        report = doctor(cfg)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.action == "doctor" and any(not row["ok"] for row in report["checks"]):
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print(f"配置错误：{error}", file=sys.stderr)
        sys.exit(2)
