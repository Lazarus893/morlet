"""Validated, portable configuration. Secrets remain in the user's environment."""
import json
import hashlib
import fcntl
import tempfile
import os
import shutil
import sys
import re
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ROOT = Path(__file__).resolve().parents[1]


def load_config(root=ROOT):
    path = root / ".runtime/pa.json"
    cfg = json.loads((path if path.exists() else root / "config/pa.example.json").read_text())
    if not path.exists() and (root / ".runtime/dsh/profiles/wx-life/cordis.patch.yml").is_file():
        # The original deployment predates pa.json. Do not enable pushes on upgrade.
        cfg["proactive"]["enabled"] = False
    # New installations start with Day 1. An existing configuration needs opt-in.
    if "proactive" not in cfg:
        cfg["proactive"] = dict(json.loads((root / "config/pa.example.json").read_text())["proactive"], enabled=False)
    if "persona" not in cfg:
        cfg["persona"] = json.loads((root / "config/pa.example.json").read_text())["persona"]
        # Existing deployments keep their chosen prompt when gaining local overrides.
        generated = root / ".runtime/dsh/profiles/wx-life/cordis.patch.yml"
        if generated.exists():
            rows = json.loads(generated.read_text())
            prompt = next((row.get("config", {}) for row in rows if row.get("id") == "system-prompt"), {})
            for field, key in (("prefix", "personaPrefix"), ("suffix", "personaSuffix")):
                if isinstance(prompt.get(key), str): cfg["persona"][field] = prompt[key]
    validate(cfg)
    return cfg


def validate(cfg):
    if not isinstance(cfg, dict) or any(not isinstance(cfg.get(name), dict) for name in ("agent", "im", "device", "capabilities")):
        raise ValueError("pa.json must contain agent, im, device and capabilities objects")
    if cfg.get("version") != 1:
        raise ValueError("pa.json version must be 1")
    if cfg.get("agent", {}).get("provider") not in {"dsh", "codex", "workbuddy"}:
        raise ValueError("agent.provider must be dsh, codex or workbuddy")
    if cfg.get("im", {}).get("provider") not in {"weixin", "disabled"}:
        raise ValueError("im.provider must be weixin or disabled")
    if cfg.get("device", {}).get("provider") not in {"none", "android", "ios"}:
        raise ValueError("device.provider must be none, android or ios")
    if cfg["im"].get("access_policy") not in {"allowlist", "disabled"}:
        raise ValueError("im.access_policy must be allowlist or disabled")
    for values in (cfg["im"].get("allow_from"), cfg.get("capabilities", {}).get("disabled"),
                   cfg.get("capabilities", {}).get("extra_skills")):
        if not isinstance(values, list) or not all(isinstance(v, str) and v.strip() for v in values):
            raise ValueError("allow_from, disabled and extra_skills must be lists of non-empty strings")
    for name in cfg["capabilities"]["extra_skills"] + cfg["capabilities"]["disabled"]:
        if Path(name).name != name or name in {".", ".."} or "\\" in name:
            raise ValueError("skill names must be directory names, not paths")
    timeout = cfg["agent"].get("timeout_seconds", 300)
    if type(timeout) is not int or not 10 <= timeout <= 1800:
        raise ValueError("agent.timeout_seconds must be an integer between 10 and 1800")
    for value in (cfg.get("owner"), cfg["agent"].get("command"), cfg["agent"].get("model"),
                  cfg["device"].get("id"), cfg["device"].get("wda_url")):
        if not isinstance(value, str) or any(character in value for character in ("\x00", "\n", "\r")):
            raise ValueError("owner/command/model/device fields must be single-line strings")
    if not cfg["owner"].strip():
        raise ValueError("owner cannot be empty")
    if cfg["agent"]["provider"] == "dsh" and cfg["agent"]["command"]:
        raise ValueError("DSH 通道宿主使用项目锁定版本；command 仅用于外部 Codex/WorkBuddy CLI")
    model_provider = cfg["agent"].get("model_provider", "deepseek-official")
    if not isinstance(model_provider, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", model_provider):
        raise ValueError("agent.model_provider must be a registered DSH model provider name")
    if "persona" in cfg:
        persona = cfg["persona"]
        if not isinstance(persona, dict) or set(persona) != {"prefix", "suffix"} or any(
                not isinstance(value, str) or len(value) > 16000 or "\x00" in value for value in persona.values()):
            raise ValueError("persona must contain bounded prefix and suffix strings")
    if cfg["device"]["provider"] == "ios":
        from urllib.parse import urlparse
        url = urlparse(cfg["device"]["wda_url"])
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("device.wda_url must be an HTTP(S) WDA endpoint without credentials/query")
    proactive = cfg.get("proactive")
    if not isinstance(proactive, dict) or type(proactive.get("enabled")) is not bool:
        raise ValueError("proactive.enabled must be a boolean")
    for field in ("quiet_start", "quiet_end"):
        if not isinstance(proactive.get(field), str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", proactive[field]):
            raise ValueError(f"proactive.{field} must be HH:MM")
    if proactive["quiet_start"] == proactive["quiet_end"]:
        raise ValueError("quiet_start and quiet_end must differ")
    timezone = proactive.get("timezone")
    if not isinstance(timezone, str):
        raise ValueError("proactive.timezone must be local or an IANA timezone")
    if timezone != "local":
        try: ZoneInfo(timezone)
        except (ZoneInfoNotFoundError, ValueError): raise ValueError("unknown proactive timezone") from None
    for field, low, high in (("max_daily", 1, 10), ("min_gap_minutes", 5, 1440),
                             ("idle_minutes", 1, 60), ("day1_delay_minutes", 1, 1440),
                             ("max_chars", 100, 500), ("max_observations_daily", 1, 200),
                             ("context_ttl_hours", 1, 24)):
        if type(proactive.get(field)) is not int or not low <= proactive[field] <= high:
            raise ValueError(f"proactive.{field} must be an integer between {low} and {high}")
    return cfg


def config_revision(cfg):
    return hashlib.sha256(json.dumps(cfg, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def write_config(cfg, root=ROOT, expected_revision=None):
    validate(cfg)
    path = root / ".runtime/pa.json"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (path.parent / "pa.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        if expected_revision is not None and config_revision(load_config(root)) != expected_revision:
            raise ValueError("CONFLICT")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix="pa-", suffix=".tmp", delete=False) as out:
                temporary = Path(out.name)
                out.write(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
                out.flush(); os.fsync(out.fileno())
            temporary.replace(path)
            descriptor = os.open(path.parent, os.O_RDONLY)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)
        finally:
            if temporary and temporary.exists(): temporary.unlink()
    return config_revision(cfg)


def agent_command(cfg, root=ROOT):
    agent = cfg["agent"]
    if agent["command"]:
        return os.path.expanduser(agent["command"])
    if agent["provider"] == "dsh":
        return str(root / "node_modules/.bin/dsh")
    if agent["provider"] == "codex":
        return shutil.which("codex") or "codex"
    # WorkBuddy ships CodeBuddy CLI. Prefer PATH, then a standard macOS app bundle.
    for name in ("codebuddy", "cbc"):
        if shutil.which(name):
            return shutil.which(name)
    bundled = Path("/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy")
    return str(bundled) if bundled.is_file() else "codebuddy"


def skill_directory(name, root=ROOT):
    local = root / ".runtime/local-skills" / name
    return local if local.is_dir() else root / "skills" / name


def capabilities(cfg, root=ROOT):
    manifest = json.loads((root / "config/capabilities.json").read_text())
    for name in cfg["capabilities"]["extra_skills"]:
        manifest.setdefault(name, {})
    result = []
    for name, spec in manifest.items():
        reasons = []
        if name in cfg["capabilities"]["disabled"]:
            reasons.append("配置中已停用")
        if spec.get("platforms") and sys.platform not in spec["platforms"]:
            reasons.append("当前操作系统不支持")
        for binary in spec.get("bins", []):
            if not shutil.which(binary):
                reasons.append(f"缺少命令 {binary}")
        for env in spec.get("env", []):
            if not os.environ.get(env):
                reasons.append(f"未设置 {env}")
        if spec.get("device") and cfg["device"]["provider"] == "none":
            reasons.append("未启用移动设备")
        if not (skill_directory(name, root) / "SKILL.md").is_file():
            reasons.append("缺少项目内 SKILL.md")
        result.append({"id": name, "available": not reasons, "reasons": reasons})
    return result


def device_config(root=ROOT):
    cfg = load_config(root)
    path = root / ".runtime/phone.json"
    phone = json.loads(path.read_text()).get("device_config", {}) if path.exists() else {}
    dev = cfg["device"]
    phone.update(device_type={"android": "adb", "ios": "ios", "none": "none"}[dev["provider"]],
                 device_id=dev["id"], wda_url=dev["wda_url"])
    for key in ("device_id", "base_url", "model", "api_key"):
        phone[key] = os.environ.get("PHONE_AGENT_" + key.upper()) or phone.get(key, "")
    phone["model"] = phone.get("model") or "autoglm-phone"
    phone["api_key"] = phone.get("api_key") or "EMPTY"
    return phone
