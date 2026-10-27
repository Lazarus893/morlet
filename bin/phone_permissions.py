"""Read-only phone permission evidence. No screen content or device IDs escape."""
import json
import re
import subprocess
import time

from runtime_paths import ADB

PACKAGE = 'com.agent.helper'
RECORD_STATE = '/sdcard/Android/data/com.agent.helper/files/record-status.json'


def permission(name, granted=False, verified=False, reason='unverified'):
    return {'id': name, 'granted': granted, 'verified': granted and verified, 'reason': reason}


def adb_read(device_id, args, deadline, maximum=2, output_limit=65536):
    remaining = min(maximum, deadline - time.monotonic())
    if remaining <= 0:
        return None
    try:
        value = subprocess.run([ADB, '-s', device_id, *args], capture_output=True,
                               text=True, timeout=remaining, check=True)
        if len(value.stdout.encode('utf-8')) + len(value.stderr.encode('utf-8')) > output_limit or re.search(r'(?im)^\s*(?:error|exception):|SecurityException|Permission Denial', value.stdout + '\n' + value.stderr):
            return None
        return value.stdout
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return None


def inspect_permissions(cfg, state, deadline):
    result = [permission('automation'), permission('recording')]
    if cfg['device_type'] == 'none' or state not in {'connected', 'locked'}:
        return result
    if cfg['device_type'] != 'adb':
        return [permission('automation', reason='unsupported'), permission('recording', reason='unsupported')]
    device_id = cfg['device_id']
    if not device_id:
        return result
    shell = adb_read(device_id, ['shell', 'dumpsys', 'package', 'com.android.shell'], deadline, output_limit=262144)
    if shell is not None:
        values = re.findall(r'(?m)^\s*android\.permission\.INJECT_EVENTS:\s*granted=(true|false)\b', shell)
        if values:
            granted = all(value == 'true' for value in values)
            result[0] = permission('automation', granted, granted, 'authorized' if granted else 'denied')
    installed = adb_read(device_id, ['shell', 'pm', 'path', PACKAGE], deadline)
    if installed is None:
        return result
    if not installed.strip():
        result[1] = permission('recording', reason='helper_missing')
        return result
    if not all(line.startswith('package:') for line in installed.splitlines() if line.strip()):
        return result
    raw = adb_read(device_id, ['shell', 'cat', RECORD_STATE], deadline)
    try:
        status = json.loads(raw) if raw is not None else None
    except (ValueError, TypeError):
        return result
    if not isinstance(status, dict) or type(status.get('authorized')) is not bool or type(status.get('recording')) is not bool:
        return result
    if not status['authorized']:
        result[1] = permission('recording', reason='needs_authorization')
        return result
    # A saved status file alone cannot prove that a live MediaProjection exists.
    projection = adb_read(device_id, ['shell', 'dumpsys', 'media_projection'], deadline)
    if projection is None:
        return result
    active = bool(re.search(r'Media Projection:\s*\n\s*\(com\.agent\.helper,\s*uid=\d+\)', projection))
    result[1] = permission('recording', active, active, 'authorized' if active else 'projection_inactive')
    return result


def open_settings(cfg, deadline):
    if cfg['device_type'] != 'adb' or not cfg.get('device_id'):
        return False
    installed = adb_read(cfg['device_id'], ['shell', 'pm', 'path', PACKAGE], deadline)
    if not installed or not all(line.startswith('package:') for line in installed.splitlines() if line.strip()):
        return False
    # Only an explicit Web action calls this; never grant or start capture here.
    opened = adb_read(cfg['device_id'], ['shell', 'am', 'start', '-W', '-n', PACKAGE + '/.SettingsActivity'], deadline, maximum=4)
    if opened is None or not ('Starting: Intent' in opened or 'Activity not started, intent has been delivered' in opened):
        return False
    # A start receipt does not prove the app survived its first render.
    running = adb_read(cfg['device_id'], ['shell', 'pidof', PACKAGE], deadline)
    return running is not None and bool(re.fullmatch(r'\d+(?:\s+\d+)*', running.strip()))
