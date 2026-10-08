#!/usr/bin/env python3
"""Generate machine-local dsh configuration without touching the live profile."""
import json
import sys
import os
import shutil
import shlex
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
from runtime_paths import control_socket


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
    home = runtime / "dsh"
    profile = home / "profiles/wx-life"
    workspace = runtime / "workspace"
    for directory in (profile / "weixin", workspace / "memory", runtime / "logs",
                      workspace / "phone-logs", *(workspace / "shared" / d for d in
                      ("to-phone", "from-phone", "notes"))):
        directory.mkdir(parents=True, exist_ok=True)
    variables = {"ROOT": root, "PROFILE": profile, "WORKSPACE": workspace, "SOCKET": control_socket(root)}
    patch = render(json.loads((root / "config/profile.patch.json").read_text()), variables)
    (profile / "cordis.patch.yml").write_text(json.dumps(patch, ensure_ascii=False, indent=2) + "\n")
    (profile / "cordis.yml").write_text("[]\n")
    shutil.copy2(root / "config/settings.yaml", profile / "settings.yaml")
    package = {"name": "xiaoman-profile", "private": True, "dsh": {"profile": {
        "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "deepseek-harness-weixin"],
        "patchReload": "live"}}}
    (profile / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    # Resolving packages from the generated profile must use this checkout's install.
    link = profile / "node_modules"
    if not link.exists() and not link.is_symlink():
        link.symlink_to(os.path.relpath(root / "node_modules", profile), target_is_directory=True)
    preset = home / ".agent-presets/xiaoman"
    preset.mkdir(parents=True, exist_ok=True)
    entries = render(json.loads((root / "config/agent.preset.json").read_text()), variables)
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
    print("Generated isolated runtime:", runtime, file=sys.stderr)
    return runtime


if __name__ == "__main__":
    configure()
