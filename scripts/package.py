#!/usr/bin/env python3
"""Build a source ZIP from an explicit allowlist, excluding all runtime data."""
import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path
from check import check
from source_files import source_files

ROOT = Path(__file__).resolve().parents[1]


def package(root, output):
    if not check(root):
        raise ValueError("Source check failed; archive was not created")
    files = list(source_files(root))
    manifest = [{"path": p.relative_to(root).as_posix(), "bytes": p.stat().st_size,
                 "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, "personal-agent/" + path.relative_to(root).as_posix())
        archive.writestr("personal-agent/SOURCE_MANIFEST.json", json.dumps(manifest, ensure_ascii=False, indent=2))
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
