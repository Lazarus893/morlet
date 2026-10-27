#!/usr/bin/env python3
"""Private, bounded JSON interface for the local Web UI. No credentials in output."""
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
from pa_config import load_config, write_config, config_revision, agent_command, capabilities
from runtime_paths import control_socket


def connect_device(root=ROOT):
    from devices import discover_android_device, probe_device
    # Leave a second for interpreter startup and JSON output within the bridge's 18s budget.
    deadline = time.monotonic() + 17
    cfg = load_config(root)
    revision = config_revision(cfg)
    device = cfg['device']
    if device['provider'] == 'none' or (device['provider'] == 'android' and not device['id']):
        discovered = discover_android_device(timeout=min(6, max(0.001, deadline - time.monotonic())))
        if discovered['state'] != 'connected':
            value = {key: value for key, value in discovered.items() if key in {'state', 'provider', 'detail'}}
            value['permissions'] = phone_permissions({'device_type': 'adb', 'device_id': ''}, discovered['state'], deadline)
            return value
        device.update(provider='android', id=discovered['id'])
        write_config(cfg, root, expected_revision=revision)
    # Probe the saved endpoint, without environment or model settings overriding its identity.
    probe_cfg = {'device_type': {'android': 'adb', 'ios': 'ios'}[device['provider']],
                 'device_id': device['id'], 'wda_url': device['wda_url']}
    return phone_status(probe_cfg, deadline)


def phone_permissions(cfg, state, deadline):
    from phone_permissions import inspect_permissions
    return inspect_permissions(cfg, state, deadline)


def phone_status(cfg, deadline):
    from devices import probe_device
    result = probe_device(cfg, timeout=max(0, deadline - time.monotonic()))
    value = {key: value for key, value in result.items() if key in {'state', 'provider', 'detail'}}
    value['permissions'] = phone_permissions(cfg, result['state'], deadline)
    return value


def saved_phone_config(root):
    device = load_config(root)['device']
    return {'device_type': {'android': 'adb', 'ios': 'ios', 'none': 'none'}[device['provider']],
            'device_id': device['id'], 'wda_url': device['wda_url']}


def read(root=ROOT):
    cfg = load_config(root)
    pending = []
    for path in sorted((root / '.runtime/pairing').glob('*.json'))[:100]:
        try:
            row = json.loads(path.read_text())
            if isinstance(row.get('userId'), str) and row['userId'] not in cfg['im']['allow_from']:
                pending.append({'userId': row['userId'], 'receivedAt': row.get('receivedAt')})
        except (ValueError, OSError):
            continue
    return {'config': cfg, 'revision': config_revision(cfg), 'socket': str(control_socket(root)),
            'installed': bool(shutil.which(agent_command(cfg, root))),
            'agentCommand': agent_command(cfg, root),
            'runtimeInstalled': (root / 'node_modules/.bin/dsh').is_file(),
            'pending': pending, 'capabilities': capabilities(cfg, root)}


def execute(request, root=ROOT):
    action = request.get('action')
    if action == 'read': return read(root)
    if action == 'save':
        cfg = load_config(root)
        patch = request.get('patch')
        template = json.loads((root / 'config/pa.example.json').read_text())
        if not isinstance(patch, dict) or not isinstance(request.get('revision'), str):
            raise ValueError('INVALID_INPUT')
        for key, value in patch.items():
            if key not in template or key == 'version': raise ValueError('INVALID_INPUT')
            if isinstance(template[key], dict):
                if not isinstance(value, dict) or any(k not in template[key] for k in value): raise ValueError('INVALID_INPUT')
                cfg[key].update(value)
            else:
                cfg[key] = value
        write_config(cfg, root, expected_revision=request['revision'])
        return read(root)
    if action == 'apply':
        if request.get('revision') != config_revision(load_config(root)): raise ValueError('CONFLICT')
        from configure import configure
        configure(root)
        return read(root)
    if action == 'doctor':
        from onboard import doctor
        return doctor(load_config(root), root)
    if action == 'device':
        return phone_status(saved_phone_config(root), time.monotonic() + 17)
    if action == 'connect-device':
        return connect_device(root)
    if action == 'phone-settings':
        from phone_permissions import open_settings
        from devices import probe_device
        cfg = saved_phone_config(root)
        deadline = time.monotonic() + 17
        ready = probe_device(cfg, timeout=max(0, deadline - time.monotonic()))
        opened = ready['state'] == 'connected' and open_settings(cfg, deadline)
        value = phone_status(cfg, deadline)
        value['settingsOpened'] = opened
        return value
    raise ValueError('INVALID_INPUT')


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.read(65537))
        result = execute(request)
        print(json.dumps({'ok': True, 'data': result}, ensure_ascii=False))
    except ValueError as error:
        print(json.dumps({'ok': False, 'error': 'CONFLICT' if str(error) == 'CONFLICT' else 'INVALID_INPUT'}))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'CONFIG_UNAVAILABLE'}))
