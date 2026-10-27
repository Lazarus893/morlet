#!/usr/bin/env python3
"""Bind one existing local CLI to this instance's hosted roles; never copy login data."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
from pa_config import load_config, write_config, config_revision, agent_command
from configure import configure


def bind_local_agent(root, provider, command=None, workspace=None):
    if provider not in ('codex', 'workbuddy'):
        raise ValueError('Choose an existing Codex or WorkBuddy CLI.')
    runtime = root / '.runtime'
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (runtime / 'local-agent-configuration.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        fresh = not (runtime / 'pa.json').exists()
        cfg = load_config(root)
        revision = config_revision(cfg)
        candidate = command or (cfg['agent'].get('command') if cfg['agent']['provider'] == provider else None)
        if not candidate:
            probe = dict(cfg, agent=dict(cfg['agent'], provider=provider, command=''))
            candidate = agent_command(probe, root)
        if not isinstance(candidate, str) or any(c in candidate for c in '\r\n\0'):
            raise ValueError('The CLI command must be one executable path.')
        executable = shutil.which(os.path.expanduser(candidate))
        if not executable or not Path(executable).is_file():
            raise ValueError('Install the selected CLI and sign in before connecting it.')
        executable = str(Path(executable).absolute())
        directory = Path(workspace).expanduser() if workspace else runtime / 'workspace'
        if not directory.is_absolute():
            raise ValueError('The workspace must be an absolute path.')
        directory = directory.resolve()
        # The package owns only its own workspace; never rewrite another project's instructions.
        if directory != (runtime / 'workspace').resolve():
            raise ValueError('Use the instance workspace; existing personal projects remain unchanged.')
        endpoint = 'local-' + provider
        roles = dict.fromkeys(('conversation', 'observer', 'followup', 'journalDesigner'), endpoint)
        hub = {'version': 1, 'agents': [{'id': endpoint, 'label': 'Local ' + ('Codex' if provider == 'codex' else 'WorkBuddy'),
                'provider': provider, 'command': executable, 'workspace': str(directory), 'timeout_seconds': 300}], 'roles': roles}
        path = runtime / 'agent-hub.json'
        if path.exists() and (path.stat().st_mode & 0o077 or path.stat().st_size > 65536):
            raise ValueError('Existing role configuration must be private and bounded.')
        prior = json.loads(path.read_text()) if path.exists() else None
        template = json.loads((root / 'config/agent-hub.example.json').read_text())
        if prior and prior != hub:
            if prior != template or (runtime / 'hub/hub.sqlite').exists():
                raise ValueError('This instance already has Agent roles. Keep them or explicitly configure a new instance.')
        if prior is None and (runtime / 'hub/hub.sqlite').exists():
            raise ValueError('Keep existing instance data; configure a new instance explicitly.')
        cfg['agent'].update(provider=provider, command=executable)
        if fresh:
            cfg['device']['provider'] = 'none'
            cfg['proactive']['enabled'] = False
        # A model selected for a previous runtime is not a CLI login or model choice.
        if prior != hub:
            cfg['agent']['model'] = ''
        write_config(cfg, root, expected_revision=revision)
        if prior != hub:
            fd, temporary = tempfile.mkstemp(prefix='.agent-hub-', dir=runtime)
            try:
                with os.fdopen(fd, 'w') as output:
                    json.dump(hub, output, ensure_ascii=False, indent=2)
                    output.flush(); os.fsync(output.fileno())
                os.replace(temporary, path)
            finally:
                Path(temporary).unlink(missing_ok=True)
        configure(root)
        return {'configured': True, 'endpointId': endpoint, 'provider': provider, 'workspace': str(directory),
                'roles': roles, 'cliInstalled': True, 'login': 'not_verified'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', required=True, choices=('codex', 'workbuddy'))
    parser.add_argument('--agent-command')
    parser.add_argument('--workspace')
    args = parser.parse_args()
    print(json.dumps(bind_local_agent(ROOT, args.provider, args.agent_command, args.workspace)))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
