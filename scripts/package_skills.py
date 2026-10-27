#!/usr/bin/env python3
"""Build a portable Xiaoman skill bundle with a verified, private-data-free payload."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile

from package import package as package_framework
from source_files import source_files
from xiaoman_setup import read_archive

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ('xiaoman-setup', 'xiaoman-journal-design')
GENERATED = ('skills/xiaoman-setup/scripts/xiaoman_setup.py',
             'skills/xiaoman-setup/assets/framework.zip')


def package_skills(root, output):
    root, output = Path(root), Path(output).resolve()
    files = list(source_files(root))
    distribution = json.loads((root / 'config/distribution.json').read_text())
    if set(distribution.get('skillGeneratedFiles', [])) != set(GENERATED):
        raise ValueError('Generated skill resources must be explicitly registered in config/distribution.json')
    for name in GENERATED:
        path = root / name
        if path in files or path.resolve() != root.resolve() / name:
            raise ValueError('Generated skill resource must not be a source file or symlink: ' + name)
    if output in {path.resolve() for path in files} | {root.resolve() / name for name in GENERATED}:
        raise ValueError('Skill bundle output must not overwrite a framework file')
    selected = [path for path in files if path.relative_to(root).parts[:2] in
                {('skills', name) for name in SKILLS}]
    for name in SKILLS:
        if root / 'skills' / name / 'SKILL.md' not in selected:
            raise ValueError('Skill is missing from the explicit framework distribution: ' + name)
    installer = root / 'scripts/xiaoman_setup.py'
    if installer not in files:
        raise ValueError('Installer must be included in the explicit framework distribution')
    entries = {path.relative_to(root).as_posix(): path.read_bytes() for path in selected}
    script_name, payload_name = GENERATED
    if payload_name in entries:
        raise ValueError('Generated framework payload must not be included in its own source distribution')
    # Capture the source once in package.py, then verify the archived bytes before embedding.
    with tempfile.TemporaryDirectory(prefix='xiaoman-skill-build-') as temporary:
        framework = package_framework(root, Path(temporary) / 'framework.zip')
        verified = read_archive(framework)
        for path in selected:
            name = path.relative_to(root).as_posix()
            if verified[name][0] != entries[name]:
                raise ValueError('Sources changed during skill packaging; retry the build')
        entries[script_name] = verified['scripts/xiaoman_setup.py'][0]
        entries[payload_name] = framework.read_bytes()
    manifest = {'version': 1, 'skills': list(SKILLS),
                'frameworkSha256': hashlib.sha256(entries[payload_name]).hexdigest(),
                'files': [{'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                          for name, data in sorted(entries.items())]}
    entries['BUNDLE_MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.xiaoman-skills-', suffix='.zip', dir=output.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(entries.items()):
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = (0o100700 if name == script_name else 0o100600) << 16
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    # Publish the same verified bytes beside SKILL.md, so copying/installing
    # that directory alone is a complete release, without a repo-relative lookup.
    for name in GENERATED:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, staging = tempfile.mkstemp(prefix='.skill-resource-', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as out:
                os.fchmod(out.fileno(), 0o700 if name == script_name else 0o600)
                out.write(entries[name]); out.flush(); os.fsync(out.fileno())
            Path(staging).replace(path)
        finally:
            Path(staging).unlink(missing_ok=True)
    print(f'Packaged {len(SKILLS)} skills and verified framework payload: {output}')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/xiaoman-skills.zip')
    args = parser.parse_args()
    try:
        package_skills(ROOT, args.output)
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
