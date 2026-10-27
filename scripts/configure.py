#!/usr/bin/env python3
"""Generate machine-local dsh configuration without touching the live profile."""
import json
import sys
import os
import shutil
import shlex
import fcntl
import tempfile
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
from runtime_paths import control_socket
from pa_config import config_revision, load_config, write_config, capabilities, agent_command, skill_directory


def render(value, variables):
    if isinstance(value, str):
        for key, replacement in variables.items():
            value = value.replace("{{" + key + "}}", str(replacement))
        return value
    if isinstance(value, list):
        return [render(item, variables) for item in value]
    if isinstance(value, dict):
        return {key: render(item, variables) for key, item in value.items()}
    return value


def configure(root=ROOT):
    runtime = root / ".runtime"
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (runtime / "configure.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _configure(root)


def _configure(root):
    cfg = load_config(root)
    if not (root / ".runtime/pa.json").exists() or "persona" not in json.loads((root / ".runtime/pa.json").read_text()):
        write_config(cfg, root, expected_revision=config_revision(cfg))
    runtime = root / ".runtime"
    home = runtime / "dsh"
    profile = home / "profiles/wx-life"
    workspace = runtime / "workspace"
    for directory in (profile / "weixin", workspace / "memory", runtime / "logs",
                      workspace / "phone-logs", *(workspace / "shared" / d for d in
                      ("to-phone", "from-phone", "notes"))):
        directory.mkdir(parents=True, exist_ok=True)
    variables = {"ROOT": root, "PROFILE": profile, "WORKSPACE": workspace, "SOCKET": control_socket(root)}
    patch = render(json.loads((root / "config/profile.patch.json").read_text()), variables)
    prompt = next(row for row in patch if row.get("id") == "system-prompt")["config"]
    prompt.update(personaPrefix=cfg["persona"]["prefix"], personaSuffix=cfg["persona"]["suffix"])
    model = next(row for row in patch if row.get("id") == "agent-default-model")["config"]
    model["provider"] = cfg["agent"].get("model_provider", "deepseek-official")
    if cfg["agent"]["provider"] == "dsh" and cfg["agent"]["model"]:
        model["model"] = cfg["agent"]["model"]
    channel = next(row for row in patch if row.get("id") == "weixin-channel")
    channel["disabled"] = cfg["im"]["provider"] == "disabled"
    channel["config"].update(accessPolicy=cfg["im"]["access_policy"], allowFrom=cfg["im"]["allow_from"],
                             pairingRequestPath=str(runtime / "pairing"),
                             paConfigRevision=config_revision(cfg), paProvider=cfg["agent"]["provider"])
    channel["config"].update(proactiveModule=str(root / "plugins/proactive/index.mjs"),
                             proactiveConfigPath=str(runtime / "proactive.json"))
    channel["config"].update(hubModule=str(root / "plugins/agent-hub/channel.mjs"), hubRoot=str(root))
    if cfg["agent"]["provider"] != "dsh":
        channel["config"].update(agentAdapterModule=str(root / "plugins/agent-bridge/index.mjs"),
                                 responseTimeoutMs=(cfg["agent"]["timeout_seconds"] + 10) * 1000,
                                 approvalTimeoutMs=min(240, cfg["agent"]["timeout_seconds"] - 5) * 1000)
    hub_config = runtime / "agent-hub.json"
    if not hub_config.exists():
        initial_hub = json.loads((root / "config/agent-hub.example.json").read_text())
        if cfg["agent"]["provider"] in ("codex", "workbuddy"):
            provider = cfg["agent"]["provider"]
            endpoint = "local-" + provider
            initial_hub = {"version": 1, "agents": [{"id": endpoint,
                "label": "Local " + ("Codex" if provider == "codex" else "WorkBuddy"),
                "provider": provider, "command": agent_command(cfg, root),
                "workspace": str(runtime / "workspace"), "timeout_seconds": cfg["agent"]["timeout_seconds"]}],
                "roles": dict.fromkeys(("conversation", "observer", "followup", "journalDesigner"), endpoint)}
        with hub_config.open("x") as output:
            json.dump(initial_hub, output, ensure_ascii=False, indent=2)
        hub_config.chmod(0o600)
    patch.append({"insert": [{"id": "xiaoman-agent-hub", "name": str(root / "plugins/agent-hub/host.mjs"),
                             "config": {"root": str(root), "revision": hashlib.sha256(hub_config.read_bytes()).hexdigest()}}]})
    (profile / "cordis.yml").write_text("[]\n")
    # JSON is also YAML; both DSH inputs must agree on the user's model choice.
    settings = {"agent-default-model": dict(model), "agent-presets": {"default": "xiaoman"}}
    (profile / "settings.yaml").write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
    package = {"name": "xiaoman-profile", "private": True, "dsh": {"profile": {
        "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "deepseek-harness-weixin"],
        "patchReload": "live"}}}
    (profile / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    # Resolving packages from the generated profile must use this checkout's install.
    link = profile / "node_modules"
    modules = (root / "node_modules").resolve()
    if link.is_symlink() and link.resolve() != modules:
        link.unlink()
    if not link.exists() and not link.is_symlink():
        link.symlink_to(os.path.relpath(modules, profile.resolve()), target_is_directory=True)
    preset = home / ".agent-presets/xiaoman"
    preset.mkdir(parents=True, exist_ok=True)
    entries = render(json.loads((root / "config/agent.preset.json").read_text()), variables)
    next(row for row in entries if row.get("id") == "persona")["config"] = dict(cfg["persona"])
    next(row for row in entries if row.get("id") == "agent-instructions")["config"]["dshHome"] = str(runtime / "personalization")
    available = capabilities(cfg, root)
    # The same active skill directory is visible to every agent provider.
    active_skills = workspace / "skills"
    active_skills.mkdir(exist_ok=True)
    active_names = {row["id"] for row in available if row["available"]}
    for child in active_skills.iterdir():
        if child.name not in active_names:
            if child.is_symlink() or child.is_file():
                child.unlink()
            else:
                shutil.rmtree(child)
    for name in active_names:
        shutil.copytree(skill_directory(name, root), active_skills / name, dirs_exist_ok=True)
    skill_plugin = next(row for row in entries if row.get("id") == "skill-filesystem")
    skill_plugin["config"]["customSkillDirs"] = [str(active_skills)]
    (preset / "agent.cordis.yml").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n")
    (preset / "preset.yml").write_text("name: 小满生活助理\ndescription: 项目内的生活助理配置和技能\norder: 9\n")
    hooks = {"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command",
        "command": shlex.quote(str(root / "scripts/pa.sh")) + " intent", "timeout": 20}]}]}}
    (profile / "hooks.json").write_text(json.dumps(hooks, ensure_ascii=False, indent=2) + "\n")
    phone = runtime / "phone.json"
    if not phone.exists():
        phone.write_text((root / "config/phone.example.json").read_text())
    # Mutable learning lives in the sandbox, seeded once from versioned references.
    for name, source in (("apps", root / "skills/phone/references/apps"),
                         ("experiences", root / "phone-refs/experiences")):
        destination = workspace / "phone-refs" / name
        if not destination.exists():
            shutil.copytree(source, destination)
    memory = workspace / "MEMORY.md"
    if not memory.exists():
        memory.write_text("# 生活助理记忆\n\n用户偏好在使用中记录。\n")
    personal = runtime / "personalization"
    personal.mkdir(exist_ok=True, mode=0o700)
    personal.chmod(0o700)
    instructions_path = personal / "AGENTS.md"
    if not instructions_path.exists():
        previous = workspace / "AGENTS.md"
        seed = previous.read_text().split("\n\n## 本机配置（自动生成）", 1)[0] if previous.exists() else (root / "home/AGENTS.md").read_text()
        with instructions_path.open("x") as output: output.write(seed)
    instructions_path.chmod(0o600)
    instructions = instructions_path.read_text()
    instructions += "\n\n## 本机配置（自动生成）\n"
    instructions += f"称呼：{cfg['owner']}。设备类型：{cfg['device']['provider']}。\n"
    instructions += "可用技能：" + "、".join(sorted(active_names)) + "。先阅读工作区 skills/<名称>/SKILL.md，再操作。\n"
    instructions += "不可用技能：" + "；".join(row["id"] + "（" + "、".join(row["reasons"]) + "）" for row in available if not row["available"]) + "。\n"
    instructions += '统一工具入口：' + shlex.quote(str(root / "scripts/pa.sh")) + '。手机任务用 phone 子命令；不要直接操作 ADB/WDA 绕过检查点。\n'
    instructions += '生活手账与微信共用正式账本。显式 /journal add 标题、/journal done|cancel|undo 编号由管家入口确定性处理；默认手账设计 Agent 只读最小事项，按需生成受约束看板，不发消息、不控制手机。不要声称普通聊天已自动写入手账。\n'
    (workspace / "AGENTS.md").write_text(instructions)
    runtime_agent = dict(cfg["agent"], command=agent_command(cfg, root),
                         workspace=str(workspace), state_dir=str(runtime / "agents"),
                         instructions=str(workspace / "AGENTS.md"))
    (runtime / "agent.json").write_text(json.dumps(runtime_agent, ensure_ascii=False, indent=2) + "\n")
    (runtime / "agent.json").chmod(0o600)
    role = personal / "life-journal-designer.md"
    if not role.exists():
        with role.open("x") as output: output.write((root / "agents/life-journal-designer/AGENT.md").read_text())
    role.chmod(0o600)
    proactive = dict(cfg["proactive"], state_dir=str(runtime / "proactive"),
                     agent_config=str(runtime / "agent.json"), hub_root=str(root), journal_root=str(root),
                     journal_role=str(role))
    (runtime / "proactive.json").write_text(json.dumps(proactive, ensure_ascii=False, indent=2) + "\n")
    (runtime / "proactive.json").chmod(0o600)
    # Publish the reload trigger only after all inputs are ready.
    with tempfile.NamedTemporaryFile(mode="w", dir=profile, suffix=".tmp", delete=False) as out:
        out.write(json.dumps(patch, ensure_ascii=False, indent=2) + "\n")
        out.flush(); os.fsync(out.fileno())
    Path(out.name).replace(profile / "cordis.patch.yml")
    print("Generated isolated runtime:", runtime, file=sys.stderr)
    return runtime


if __name__ == "__main__":
    configure()
