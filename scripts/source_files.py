"""Allowlist for the standalone source distribution."""
import os
from pathlib import Path

ROOT_FILES = {
    "README.md", "AGENTS.md", "THIRD_PARTY_NOTICES.md", "package.json",
    "package-lock.json", "requirements.txt", ".env.example", ".gitignore",
}
SOURCE_DIRS = {
    "android", "bin", "config", "docs", "home", "phone-refs", "plugins",
    "scripts", "skills", "tests", "vendor",
}
EXCLUDED = {
    "node_modules", ".git", ".gradle", "build", "__pycache__", ".venv",
    ".runtime", "local.properties", ".DS_Store", ".credentials.yaml",
}


def source_files(root: Path):
    candidates = [root / name for name in sorted(ROOT_FILES) if (root / name).exists()]
    for name in sorted(SOURCE_DIRS):
        directory = root / name
        if not directory.exists():
            continue
        if directory.is_symlink():
            raise ValueError(f"Source must be self-contained, found symlink: {directory}")
        for current, directories, files in os.walk(directory):
            for child in directories:
                if child not in EXCLUDED and (Path(current) / child).is_symlink():
                    raise ValueError(f"Source must be self-contained, found symlink: {Path(current) / child}")
            directories[:] = sorted(d for d in directories if d not in EXCLUDED)
            candidates.extend(Path(current) / filename for filename in sorted(files))
    for path in candidates:
        relative = path.relative_to(root)
        parts = relative.parts
        if parts[0] not in SOURCE_DIRS and relative.as_posix() not in ROOT_FILES:
            continue
        if any(part in EXCLUDED or part.startswith(".env") and part != ".env.example"
               for part in parts):
            continue
        if path.suffix in {".pyc", ".log", ".jks", ".keystore"} or ".orig-" in path.name:
            continue
        if path.is_symlink():
            raise ValueError(f"Source must be self-contained, found symlink: {relative}")
        if path.is_file():
            yield path
