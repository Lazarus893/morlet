"""Permission evidence and explicit settings contracts; no physical device calls."""
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
sys.path.insert(0, str(ROOT / 'scripts'))
from phone_permissions import ADB, PACKAGE, RECORD_STATE, adb_read, inspect_permissions, open_settings
from web_config import execute

CFG = {'device_type': 'adb', 'device_id': 'PRIVATE_DEVICE', 'wda_url': ''}
SHELL = 'requested permissions:\n  android.permission.INJECT_EVENTS\ninstall permissions:\n  android.permission.INJECT_EVENTS: granted=true\nruntime permissions:\n  android.permission.INJECT_EVENTS: granted=true\n'
PROJECTION = 'MEDIA PROJECTION MANAGER (dumpsys media_projection)\nMedia Projection:\n  (com.agent.helper, uid=10001): TYPE_SCREEN_CAPTURE\n'


class PhonePermissionsTests(unittest.TestCase):
    def inspect(self, shell=SHELL, installed='package:/private/app/base.apk\n', status=None, projection=PROJECTION):
        status = {'authorized': True, 'recording': False, 'taskId': 'PRIVATE_TASK', 'segments': ['PRIVATE_PATH']} if status is None else status
        raw = status if isinstance(status, str) else json.dumps(status)
        with patch('phone_permissions.adb_read', side_effect=[shell, installed, raw, projection]) as reader:
            result = inspect_permissions(CFG, 'connected', time.monotonic() + 17)
        self.assertNotIn('PRIVATE', json.dumps(result))
        return {row['id']: row for row in result}, reader

    def test_granted_input_and_live_projection_are_verified_without_recording_a_task(self):
        result, reader = self.inspect()
        self.assertTrue(all(row['verified'] for row in result.values()))
        self.assertEqual([call.args[1] for call in reader.call_args_list], [
            ['shell', 'dumpsys', 'package', 'com.android.shell'], ['shell', 'pm', 'path', PACKAGE],
            ['shell', 'cat', RECORD_STATE], ['shell', 'dumpsys', 'media_projection']])

    def test_record_state_alone_is_not_proof(self):
        for projection, reason in [('Media Projection:\n  null', 'projection_inactive'),
                                   ('Media Projection:\n  (com.other.app, uid=10001)', 'projection_inactive'),
                                   ('historic com.agent.helper entry', 'projection_inactive'), (None, 'unverified')]:
            with self.subTest(reason=reason):
                result, _reader = self.inspect(projection=projection)
                self.assertFalse(result['recording']['verified'])
                self.assertEqual(result['recording']['reason'], reason)

    def test_revoked_authorization_does_not_use_other_projection(self):
        result, reader = self.inspect(status={'authorized': False, 'recording': False, 'error': 'PRIVATE_ERROR'})
        self.assertEqual(result['recording']['reason'], 'needs_authorization')
        self.assertFalse(result['recording']['granted'])
        self.assertEqual(reader.call_count, 3)

    def test_requested_or_conflicting_input_permissions_never_count_as_granted(self):
        for shell, reason in [('android.permission.INJECT_EVENTS', 'unverified'),
                              (SHELL + ' android.permission.INJECT_EVENTS: granted=false', 'denied'),
                              ('android.permission.INJECT_EVENTS: granted=TRUE', 'unverified'), (None, 'unverified')]:
            with self.subTest(shell=shell):
                result, _reader = self.inspect(shell=shell)
                self.assertFalse(result['automation']['verified'])
                self.assertEqual(result['automation']['reason'], reason)

    def test_missing_helper_does_not_read_state(self):
        result, reader = self.inspect(installed='')
        self.assertEqual(result['recording']['reason'], 'helper_missing')
        self.assertEqual(reader.call_count, 2)

    def test_malformed_state_and_missing_tool_are_unknown(self):
        for status in ['PRIVATE_ERROR', 'null', '[]', '{}',
                       {'authorized': 'true', 'recording': False}, {'authorized': True, 'recording': 0}]:
            with self.subTest(status=status):
                result, _reader = self.inspect(status=status)
                self.assertEqual(result['recording']['reason'], 'unverified')
                self.assertFalse(result['recording']['verified'])
        for installed in [None, 'Error: PRIVATE_ERROR']:
            result, reader = self.inspect(installed=installed)
            self.assertEqual(result['recording']['reason'], 'unverified')
            self.assertEqual(reader.call_count, 2)

    def test_offline_unconfigured_and_ios_never_start_adb(self):
        with patch('phone_permissions.subprocess.run') as cli:
            for state in ['absent', 'unauthorized', 'unconfigured', 'disabled']:
                self.assertTrue(all(not row['verified'] for row in inspect_permissions(CFG, state, time.monotonic() + 17)))
            ios = inspect_permissions({'device_type': 'ios'}, 'connected', time.monotonic() + 17)
            self.assertTrue(all(row['reason'] == 'unsupported' for row in ios))
            cli.assert_not_called()

    def test_deadline_prevents_commands_and_shares_remaining_budget(self):
        clock = [100]
        def run(command, **kwargs):
            self.assertLessEqual(kwargs['timeout'], 1)
            clock[0] += kwargs['timeout']
            return subprocess.CompletedProcess(command, 0, stdout=SHELL, stderr='')
        with patch('phone_permissions.time.monotonic', side_effect=lambda: clock[0]), patch('phone_permissions.subprocess.run', side_effect=run) as cli:
            result = inspect_permissions(CFG, 'connected', 101)
            self.assertEqual(cli.call_count, 1)
            self.assertTrue(result[0]['verified'])
            self.assertFalse(result[1]['verified'])

    def test_cli_is_shell_free_bounded_and_errors_are_not_exposed(self):
        response = subprocess.CompletedProcess([], 0, stdout='safe', stderr='')
        with patch('phone_permissions.subprocess.run', return_value=response) as cli:
            self.assertEqual(adb_read('PRIVATE_DEVICE', ['shell', 'pm', 'path', PACKAGE], time.monotonic() + 17), 'safe')
            self.assertEqual(cli.call_args.args[0], [ADB, '-s', 'PRIVATE_DEVICE', 'shell', 'pm', 'path', PACKAGE])
            self.assertNotIn('shell', cli.call_args.kwargs)
            self.assertLessEqual(cli.call_args.kwargs['timeout'], 2)
        for failure in [FileNotFoundError('PRIVATE_ERROR'), subprocess.CalledProcessError(1, 'fixture'), subprocess.TimeoutExpired('fixture', 2)]:
            with patch('phone_permissions.subprocess.run', side_effect=failure):
                self.assertIsNone(adb_read('fixture', [], time.monotonic() + 17))

    def test_system_package_dump_has_a_separate_bounded_local_budget(self):
        # Actual Android package metadata exceeds 64 KiB; no raw dump is reported.
        with patch('phone_permissions.subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout=SHELL + 'x' * 114000, stderr='')):
            rows = inspect_permissions(CFG, 'connected', time.monotonic() + 17)
            self.assertTrue(rows[0]['verified'])
            self.assertNotIn('x' * 100, json.dumps(rows))
        with patch('phone_permissions.subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout=SHELL + 'x' * 262144, stderr='')):
            rows = inspect_permissions(CFG, 'connected', time.monotonic() + 17)
            self.assertFalse(rows[0]['verified'])
        for stdout, stderr in [('x' * 65537, ''), ('Starting: Intent', 'Error: activity missing'), ('SecurityException PRIVATE', '')]:
            with patch('phone_permissions.subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout=stdout, stderr=stderr)):
                self.assertIsNone(adb_read('fixture', [], time.monotonic() + 17))

    def test_explicit_settings_opens_activity_without_grant_or_record_actions(self):
        with patch('phone_permissions.adb_read', side_effect=['package:/private/app.apk', 'Starting: Intent\nStatus: ok', '12345']) as reader:
            self.assertTrue(open_settings(CFG, time.monotonic() + 17))
            self.assertEqual(reader.call_args_list[1].args[1], ['shell', 'am', 'start', '-W', '-n', PACKAGE + '/.SettingsActivity'])
            self.assertEqual(reader.call_args.args[1], ['shell', 'pidof', PACKAGE])
        with patch('phone_permissions.adb_read', return_value='') as reader:
            self.assertFalse(open_settings(CFG, time.monotonic() + 17))
            self.assertEqual(reader.call_count, 1)

    def test_activity_start_receipt_without_a_live_process_is_not_opened(self):
        for running in ['', None, 'PRIVATE_ERROR']:
            with patch('phone_permissions.adb_read', side_effect=['package:/private/app.apk', 'Starting: Intent', running]):
                self.assertFalse(open_settings(CFG, time.monotonic() + 17))

    def test_web_settings_uses_saved_device_and_cannot_open_locked_phone(self):
        config = {'device': {'provider': 'android', 'id': 'PRIVATE_DEVICE', 'wda_url': ''}}
        for state, expected in [('connected', True), ('locked', False), ('absent', False)]:
            with self.subTest(state=state), patch('web_config.load_config', return_value=config), patch('devices.probe_device', return_value={'state': state}), patch('phone_permissions.open_settings', return_value=True) as opener, patch('web_config.phone_status', return_value={'state': state, 'permissions': []}):
                result = execute({'action': 'phone-settings'})
                self.assertEqual(result['settingsOpened'], expected)
                if expected:
                    self.assertEqual(opener.call_args.args[0], CFG)
                else:
                    opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()
