"""Exact, reviewed file list for the application framework distribution."""
import json
from pathlib import Path, PurePosixPath

MANIFEST = "config/distribution.json"
EXCLUDED = {
    "node_modules", ".git", ".gradle", "build", "__pycache__", ".venv",
    ".runtime", "memory", "_temp", "local.properties", ".DS_Store",
    ".credentials.yaml", "local-skills", "personalization",
}


def source_files(root: Path):
    root = Path(root)
    manifest = root / MANIFEST
    if manifest.is_symlink() or manifest.parent.is_symlink():
        raise ValueError("Distribution manifest must not be a symlink")
    data = json.loads(manifest.read_text())
    names = data.get("files")
    if data.get("version") != 1 or not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise ValueError("Invalid distribution manifest")
    if MANIFEST not in names or len(set(names)) != len(names):
        raise ValueError("Distribution manifest must include itself and contain no duplicates")
    for name in sorted(names):
        relative = PurePosixPath(name)
        if relative.is_absolute() or relative.as_posix() != name or ".." in relative.parts or "\\" in name:
            raise ValueError("Invalid distribution path")
        if relative.parts[0] == "dist" or any(part in EXCLUDED or part.startswith(".env") and part != ".env.example" for part in relative.parts):
            raise ValueError("Private or generated data cannot be distributed")
        if relative.suffix in {".pyc", ".log", ".jks", ".keystore", ".db", ".sqlite", ".sqlite3"} or ".orig-" in relative.name or ".local." in relative.name:
            raise ValueError("Private or generated data cannot be distributed")
        path = root
        for part in relative.parts:
            path = path / part
            if path.is_symlink():
                raise ValueError("Distribution files and directories must not be symlinks")
        if not path.is_file():
            raise ValueError(f"Missing framework file: {name}")
        yield path
