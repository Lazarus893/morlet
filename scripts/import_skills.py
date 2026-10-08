#!/usr/bin/env python3
"""Explicitly copy selected local skills into the standalone project."""
import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("names", nargs="+")
    parser.add_argument("--source", type=Path, default=Path.home() / ".codex/skills")
    args = parser.parse_args()
    for name in args.names:
        if Path(name).name != name or name in {".", ".."}:
            parser.error("Use a skill directory name, without path components")
        source = args.source.expanduser() / name
        destination = ROOT / "skills" / name
        if not (source / "SKILL.md").is_file():
            parser.error(f"SKILL.md not found: {source}")
        if destination.exists():
            parser.error(f"Already bundled: {name}; review its files before replacing it")
        shutil.copytree(source, destination, ignore=shutil.ignore_patterns(
            ".git", "node_modules", "__pycache__", ".env", ".env.*", "*.pyc", "*.log", ".credentials.yaml"))
        print("Imported:", name)
    print("Run ./scripts/pa.sh check before submitting newly imported skills.")
