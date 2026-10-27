#!/usr/bin/env python3
"""Install the paired Mac's private background observer, without a chat scheduler."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LABEL = 'com.xiaoman.personal-notices'


def install():
    if os.uname().sysname != 'Darwin':
        raise ValueError('Install on the paired Mac.')
    config_path = ROOT / '.runtime/personal-notices/worker.json'
    if config_path.stat().st_mode & 0o077:
        raise ValueError('The private worker configuration must have mode 0600.')
    config = json.loads(config_path.read_text())
    for key in ('connectionConfig', 'agentConfig'):
        path = Path(config[key])
        if not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError('Existing private companion configurations are required.')
    node = shutil.which('node')
    if not node:
        raise ValueError('Node.js is required.')
    logs = ROOT / '.runtime/logs/personal-notices'
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    log = logs / 'worker.log'
    log.touch(mode=0o600, exist_ok=True)
    log.chmod(0o600)
    agents = Path.home() / 'Library/LaunchAgents'
    agents.mkdir(parents=True, exist_ok=True)
    path = agents / (LABEL + '.plist')
    previous = path.read_bytes() if path.exists() else None
    document = {'Label': LABEL, 'ProgramArguments': [node, str(ROOT / 'scripts/personal-notice-worker.mjs'), '--config', str(config_path)],
                'WorkingDirectory': str(ROOT), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30,
                'EnvironmentVariables': {'PATH': os.environ.get('PATH', '/opt/homebrew/bin:/usr/bin:/bin'), 'TZ': config['timezone']},
                'StandardOutPath': str(log), 'StandardErrorPath': str(log)}
    domain = f'gui/{os.getuid()}'
    path.write_bytes(plistlib.dumps(document))
    path.chmod(0o600)
    subprocess.run(['launchctl', 'bootout', f'{domain}/{LABEL}'], check=False, capture_output=True)
    try:
        subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True)
    except subprocess.CalledProcessError:
        if previous:
            path.write_bytes(previous)
            subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=False, capture_output=True)
        else:
            path.unlink(missing_ok=True)
        raise
    print('Installed Xiaoman background observer. No chat automation is used.')


if __name__ == '__main__':
    try:
        install()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
