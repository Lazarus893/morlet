#!/usr/bin/env python3
"""Render private service files; never install, reload or contact a server."""
import argparse
import json
import os
import re
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate(value):
    required = {"install_dir", "service_user", "service_group", "nginx_user", "node_command", "nginx_command",
                "public_host", "public_port", "web_port", "dsh_port"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("Deployment config fields must match deployment.example.json")
    for key in ("install_dir", "node_command", "nginx_command"):
        path = value[key]
        if not isinstance(path, str) or not re.fullmatch(r"/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", path) or any(p in {".", ".."} for p in Path(path).parts):
            raise ValueError("Deployment paths must be absolute without whitespace or traversal")
    for key in ("service_user", "service_group", "nginx_user"):
        if not isinstance(value[key], str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", value[key]):
            raise ValueError("Invalid deployment service identity")
    if not isinstance(value["public_host"], str) or len(value["public_host"]) > 253 or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", value["public_host"]):
        raise ValueError("Invalid public host")
    ports = [value[key] for key in ("public_port", "web_port", "dsh_port")]
    if any(type(port) is not int or not 1024 <= port <= 65535 for port in ports) or len(set(ports)) != 3:
        raise ValueError("Choose three distinct unprivileged ports")
    return value


def write_private(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".render-")
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(content)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def render(root=ROOT):
    path = root / ".runtime/deployment.json"
    if not path.exists():
        write_private(path, (root / "config/deployment.example.json").read_text())
        raise ValueError("Created .runtime/deployment.json; set your deployment values before rendering")
    cfg = validate(json.loads(path.read_text()))
    if cfg["public_host"].endswith(".invalid"):
        raise ValueError("Replace the example host in .runtime/deployment.json")
    variables = {key.upper(): str(value) for key, value in cfg.items()}
    variables["PUBLIC_ORIGIN"] = f"http://{cfg['public_host']}:{cfg['public_port']}"
    rendered = {}
    for template in sorted((root / "config/deployment").glob("*.in")):
        content = template.read_text()
        for key, value in variables.items(): content = content.replace("{{" + key + "}}", value)
        if "{{" in content: raise ValueError("Unresolved deployment template variable")
        rendered[template.stem] = content
    for name, content in rendered.items():
        write_private(root / ".runtime/deployment" / name, content)
    path.chmod(0o600)
    return list(rendered)


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        files = render()
        print(f"Rendered {len(files)} private files in .runtime/deployment; nothing installed or restarted.")
    except (ValueError, OSError):
        raise SystemExit("Check .runtime/deployment.json and the deployment guide; no services were changed.")
