#!/usr/bin/env python3
"""Import user skills into private instance data, never the product sources."""
import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
from pa_config import load_config, write_config, config_revision


def import_skill(source_root, name, root=ROOT):
    if Path(name).name != name or name in {".", ".."} or "\\" in name:
        raise ValueError("Use a skill directory name, without path components")
    source = Path(source_root).expanduser() / name
    destination = root / ".runtime/local-skills" / name
    if not (source / "SKILL.md").is_file():
        raise ValueError("SKILL.md not found in the selected directory")
    if destination.exists() or (root / "skills" / name).exists():
        raise ValueError("Skill already exists; choose a distinct local name")
    if source.is_symlink() or any(path.is_symlink() for path in source.rglob("*")):
        raise ValueError("Local skill imports must not contain symlinks")
    cfg = load_config(root)
    revision = config_revision(cfg)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.parent.chmod(0o700)
    temporary = Path(tempfile.mkdtemp(prefix=".import-", dir=destination.parent))
    try:
        shutil.copytree(source, temporary, dirs_exist_ok=True, ignore=shutil.ignore_patterns(
            ".git", "node_modules", "__pycache__", ".env", ".env.*", "*.pyc", "*.log", ".credentials.yaml"))
        for current, directories, files in os.walk(temporary):
            Path(current).chmod(0o700)
            for filename in files:
                path = Path(current) / filename
                path.chmod(0o700 if path.stat().st_mode & 0o111 else 0o600)
        temporary.rename(destination)
    finally:
        if temporary.exists(): shutil.rmtree(temporary)
    if name not in cfg["capabilities"]["extra_skills"]:
        cfg["capabilities"]["extra_skills"].append(name)
    write_config(cfg, root, expected_revision=revision)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("names", nargs="+")
    parser.add_argument("--source", type=Path, default=Path.home() / ".codex/skills")
    args = parser.parse_args()
    for name in args.names:
        try:
            import_skill(args.source, name)
        except ValueError as error:
            parser.error(str(error))
        print("Imported:", name)
    print("Saved locally in .runtime/local-skills; run configure to activate. Imports are excluded from packages.")
