#!/usr/bin/env python3
"""Offline source and packaging checks; no accounts or phones are operated."""
import json
import re
import subprocess
import sys
from pathlib import Path
from source_files import source_files

ROOT = Path(__file__).resolve().parents[1]


def check(root=ROOT):
    files = list(source_files(root))
    errors = []
    secret = re.compile(r"sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
    for path in files:
        relative = path.relative_to(root)
        if path.suffix == ".py":
            try:
                compile(path.read_text(), str(relative), "exec")
            except (SyntaxError, UnicodeError) as error:
                errors.append(f"{relative}: {error}")
        try:
            content = path.read_text()
        except UnicodeError:
            continue
        if secret.search(content):
            errors.append(f"{relative}: possible secret material (value withheld)")
        if re.search(r"/(?:Users|home)/[^/\s]+/", content):
            errors.append(f"{relative}: machine-specific home path")
        if path.suffix == ".json":
            try:
                json.loads(content)
            except json.JSONDecodeError as error:
                errors.append(f"{relative}: {error}")
    for path in (root / "scripts/pa.sh", root / "bin/shared_sync.sh"):
        result = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
        if result.returncode:
            errors.append(result.stderr)
    if not (root / "package-lock.json").exists():
        errors.append("package-lock.json missing; npm ci cannot reproduce this install")
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        return False
    print(f"Source check passed: {len(files)} files, Python/JSON/shell valid, no home paths or detected secret patterns.")
    return True


if __name__ == "__main__":
    sys.exit(0 if check() else 1)
