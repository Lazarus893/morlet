#!/usr/bin/env python3
"""Build a source ZIP from an explicit allowlist, excluding all runtime data."""
import argparse
import hashlib
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path
from check import check
from source_files import source_files

ROOT = Path(__file__).resolve().parents[1]


def package(root, output):
    if not check(root):
        raise ValueError("Source check failed; archive was not created")
    files = list(source_files(root))
    if output.resolve() in {p.resolve() for p in files}:
        raise ValueError("Archive output must not overwrite a framework file")
    # Hash and archive the same bytes, independent of files edited during ZIP creation.
    entries = [(p, p.read_bytes()) for p in files]
    manifest = [{"path": p.relative_to(root).as_posix(), "bytes": len(data),
                 "sha256": hashlib.sha256(data).hexdigest()} for p, data in entries]
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".framework-", suffix=".zip", dir=output.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            for path, data in entries:
                info = zipfile.ZipInfo.from_file(path, "personal-agent/" + path.relative_to(root).as_posix())
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
            archive.writestr("personal-agent/SOURCE_MANIFEST.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Packaged {len(files)} source files: {output} ({output.stat().st_size:,} bytes)")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist/personal-agent-source.zip")
    args = parser.parse_args()
    try:
        package(ROOT, args.output.resolve())
    except ValueError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
