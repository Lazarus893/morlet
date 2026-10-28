#!/usr/bin/env python3
"""Private instance state backup; restore only into an unused instance."""
import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
STATE_DIRS = ("hub", "connections", "owner", "proactive", "memory", "agents", "personalization", "local-skills")
LIMIT = 1024 * 1024 * 1024


def candidates(root):
    runtime = root / ".runtime"
    if any((runtime / name).is_symlink() for name in STATE_DIRS):
        raise ValueError("State contains a symlink; inspect it before backup")
    paths = list(runtime.glob("*.json")) + list(runtime.glob("*.sqlite"))
    paths += [p for name in STATE_DIRS for p in (runtime / name).rglob("*")]
    if (root / ".env").exists(): paths.append(root / ".env")
    result = []
    for path in sorted(paths):
        if path.is_symlink(): raise ValueError("State contains a symlink; inspect it before backup")
        if path.is_file() and not path.name.endswith(("-wal", "-shm", "-journal")) and path.name != "admin.sqlite": result.append(path)
    return result


def backup(root, output):
    if output.exists(): raise ValueError("Backup destination already exists")
    paths = candidates(root)
    if not paths: raise ValueError("No instance state found")
    if len(paths) > 10000 or sum(p.stat().st_size for p in paths) > LIMIT: raise ValueError("State exceeds backup limit")
    stamps = {p: (p.stat().st_mtime_ns, p.stat().st_size) for p in paths}
    output.parent.mkdir(parents=True, exist_ok=True)
    databases = []
    try:
        with tempfile.TemporaryDirectory(prefix="xiaoman-backup-") as temporary:
            directory = Path(temporary); entries = []
            for index, path in enumerate(paths):
                target = directory / str(index)
                if path.suffix == ".sqlite":
                    source = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2)
                    version = source.execute("PRAGMA data_version").fetchone()[0]
                    databases.append((source, version))
                    with sqlite3.connect(target) as dest: source.backup(dest)
                else: target.write_bytes(path.read_bytes())
                entries.append({"path": path.relative_to(root).as_posix(), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "bytes": target.stat().st_size, "executable": bool(path.stat().st_mode & 0o100)})
            if paths != candidates(root) or any((p.stat().st_mtime_ns, p.stat().st_size) != stamps[p] for p in paths) or any(db.execute("PRAGMA data_version").fetchone()[0] != version for db, version in databases):
                raise ValueError("Instance changed during backup; pause writers and retry")
            descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as stream, zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr("manifest.json", json.dumps({"version": 1, "files": entries}, ensure_ascii=False))
                    for index, entry in enumerate(entries): archive.write(directory / str(index), entry["path"])
            except BaseException:
                output.unlink(missing_ok=True)
                raise
            return len(entries)
    finally:
        for database, _ in databases: database.close()


def restore(archive_path, root):
    if any(os.path.lexists(root / name) for name in (".runtime", ".env")): raise ValueError("Restore requires an unused instance: .runtime and .env must not exist")
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive, tempfile.TemporaryDirectory(prefix=".restore-", dir=root) as temporary:
        infos = archive.infolist()
        if len(infos) > 10001 or len({i.filename for i in infos}) != len(infos) or sum(i.file_size for i in infos) > LIMIT: raise ValueError("Invalid archive size or duplicate paths")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("version") != 1: raise ValueError("Unknown backup version")
        entries = manifest["files"]
        if set(archive.namelist()) != {"manifest.json", *(entry["path"] for entry in entries)}: raise ValueError("Unexpected archive entry")
        directory = Path(temporary)
        for entry in entries:
            relative = PurePosixPath(entry["path"])
            if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative) or str(relative) != entry["path"] or (str(relative) != ".env" and (len(relative.parts) < 2 or relative.parts[0] != ".runtime")): raise ValueError("Invalid restore path")
            data = archive.read(entry["path"])
            if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]: raise ValueError("Backup checksum mismatch")
            target = directory / relative; target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            target.write_bytes(data); target.chmod(0o700 if entry.get("executable") else 0o600)
            if target.suffix == ".sqlite":
                with sqlite3.connect(target) as db:
                    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok": raise ValueError("Database integrity check failed")
        # Validate first, then publish with exclusive creation. Never replace an
        # existing file, including one created while the archive was validated.
        # A concurrent writer may leave a partial fresh restore; retry elsewhere.
        (root / ".runtime").mkdir(mode=0o700)
        for entry in entries:
            target = root / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.link(directory / entry["path"], target)
    return len(entries)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["backup", "restore"])
    parser.add_argument("archive", type=Path)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        count = backup(args.root.resolve(), args.archive.resolve()) if args.operation == "backup" else restore(args.archive.resolve(), args.root.resolve())
        print(f"{args.operation}: {count} private files verified. Keep this archive private; it contains credentials.")
    except (OSError, ValueError, KeyError, sqlite3.Error, zipfile.BadZipFile) as error:
        raise SystemExit(str(error))
