"""Offline skill packaging and resumable setup; no accounts or real services."""
import hashlib
import errno
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import plistlib
import stat
import socket
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import zipfile


class FakeLaunchd:
    """Exact-job launchctl/ps fixture; never executes either system command."""
    def __init__(self, target, state):
        self.target, self.state = target, state
        self.loaded, self.enabled, self.pid = False, True, 54000
        self.calls, self.alive = [], {}
        self.fail_bootstrap = False
        self.fail_bootstrap_for_node = None
        self.keep_web_alive_after_bootout = False
        self.stale_pid_reports_after_bootout = 0

    def spawn(self):
        self.pid += 1
        data = plistlib.loads(setup.service_paths(self.target)[1].read_bytes())
        self.alive = {self.pid: ' '.join(data['ProgramArguments'])}

    def __call__(self, command, **kwargs):
        if command[0] == '/bin/ps':
            pid = int(command[command.index('-p') + 1])
            if pid not in self.alive:
                raise subprocess.CalledProcessError(1, command)
            return SimpleNamespace(returncode=0, stdout=self.alive[pid] + '\n', stderr='')
        if command[0] != '/bin/launchctl':
            raise AssertionError('No real command is permitted: ' + command[0])
        self.calls.append(command[1:])
        label, path, identity = setup.service_paths(self.target)
        operation = command[1]
        if operation in {'print', 'enable', 'disable', 'bootout', 'kickstart'}:
            assert command[2] == identity
        if operation == 'print':
            if not self.loaded and not self.stale_pid_reports_after_bootout:
                return SimpleNamespace(returncode=113, stdout='', stderr='Could not find service')
            if not self.loaded:
                self.stale_pid_reports_after_bootout -= 1
            data = plistlib.loads(path.read_bytes())
            return SimpleNamespace(returncode=0, stderr='', stdout=(identity + ' = {\n' +
                '\tpath = ' + str(path) + '\n\tprogram = ' + data['ProgramArguments'][0] + '\n' +
                '\tstate = ' + ('running' if self.loaded else 'SIGTERMed') + '\n\tpid = ' + str(self.pid) + '\n}\n'))
        if operation == 'bootstrap':
            assert command[2:] == [f'gui/{setup.os.getuid()}', str(path)]
            definition = plistlib.loads(path.read_bytes())
            if self.fail_bootstrap or definition['ProgramArguments'][0] == self.fail_bootstrap_for_node:
                return SimpleNamespace(returncode=5, stdout='', stderr='fixture bootstrap failure')
            self.loaded = True
            self.spawn()
        elif operation == 'enable':
            self.enabled = True
        elif operation == 'disable':
            self.enabled = False
        elif operation == 'bootout':
            self.loaded = False
            if not self.keep_web_alive_after_bootout:
                self.alive.clear()
        elif operation == 'kickstart':
            self.spawn()
        else:
            raise AssertionError('Unexpected launchctl operation')
        return SimpleNamespace(returncode=0, stdout='', stderr='')


class FakeManagedAPI:
    def __init__(self, target):
        self.running, self.managed, self.calls = True, True, []
        self.desired = 'running'
        self.instance_id = hashlib.sha256(str(target.resolve()).encode()).hexdigest()[:20]
        self.start_error_once = None
        self.busy_starts = 0
        self.control_only = False
        self.starting_host_alive = False

    def snapshot(self):
        return {'service': {'managed': self.managed, 'instanceId': self.instance_id, 'desired': self.desired, 'controlOnly': self.control_only},
                'runtime': {'state': 'running' if self.running else 'offline', 'managed': self.managed, 'owned': True}}

    def connect(self):
        return self.snapshot()

    def request(self, path, value=None):
        self.calls.append((path, value))
        if path == '/api/start':
            if self.busy_starts:
                self.busy_starts -= 1
                raise setup.SetupError('Local API refused operation: BUSY', code='BUSY')
            self.running = True
            self.desired = 'running'
            if self.start_error_once:
                code, self.start_error_once = self.start_error_once, None
                raise setup.SetupError('The verified host control socket is still starting', code=code)
            return {'accepted': True}
        if path == '/api/stop':
            self.running = False
            self.desired = 'stopped'
            self.starting_host_alive = False
            return {'accepted': True}
        assert path == '/api/state'
        return self.snapshot()

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import xiaoman_setup as setup
import package_skills as bundle


def fixture_entries(extra=None):
    data = {'scripts/xiaoman_setup.py': b'# fixture installer\n',
            'scripts/configure-local-agent.py': b'# fixture configuration\n',
            'scripts/configure.py': b'# fixture renderer\n',
            'scripts/webui.mjs': b'// fixture web\n',
            'scripts/pa.sh': b'#!/bin/sh\n', 'requirements.txt': b'',
            'skills/xiaoman-setup/SKILL.md': b'---\nname: xiaoman-setup\n---\nSetup',
            'skills/xiaoman-journal-design/SKILL.md': b'---\nname: xiaoman-journal-design\n---\nDesign'}
    data.update(extra or {})
    data['config/distribution.json'] = json.dumps({'version': 1, 'files': sorted([*data, 'config/distribution.json']), 'skillGeneratedFiles': list(bundle.GENERATED)}).encode()
    manifest = [{'path': name, 'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()}
                for name, value in sorted(data.items())]
    data['SOURCE_MANIFEST.json'] = json.dumps(manifest).encode()
    return {name: (value, stat.S_IFREG | (0o755 if name.endswith('pa.sh') else 0o644)) for name, value in data.items()}


def write_archive(path, entries, extra=()):
    with zipfile.ZipFile(path, 'w') as archive:
        for name, (value, mode) in entries.items():
            info = zipfile.ZipInfo('personal-agent/' + name)
            info.external_attr = mode << 16
            archive.writestr(info, value)
        for name, value, mode in extra:
            info = zipfile.ZipInfo(name)
            info.external_attr = mode << 16
            archive.writestr(info, value)
    return path


class SkillBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='xiaoman new user ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.target = self.root / 'my instance'
        self.entries = fixture_entries()
        self.archive = write_archive(self.root / 'framework.zip', self.entries)
        self.tools = {'node': '/fixture/node', 'npm': '/fixture/npm', 'agentCommand': '/fixture/codex'}

    def create(self):
        return setup.new_install(self.target, setup.read_archive(self.archive), 'codex', '/fixture/codex', 43383)

    @contextlib.contextmanager
    def managed_fixture(self):
        state = self.create()
        state['steps'].update(dependencies='done', configuration='done')
        setup.private_json(setup.state_path(self.target), state)
        home = self.root / 'user home'
        home.mkdir()
        manager, api = FakeLaunchd(self.target, state), FakeManagedAPI(self.target)
        with patch.object(setup.sys, 'platform', 'darwin'), \
                patch.object(setup.Path, 'home', return_value=home), \
                patch.object(setup.subprocess, 'run', side_effect=manager), \
                patch.object(setup, 'LocalAPI', return_value=api), \
                patch.object(setup, 'stop_detached', return_value={}) as detached, \
                patch.object(setup.os, 'kill') as kill, \
                patch.object(setup.subprocess, 'Popen') as popen, \
                patch.object(setup.time, 'sleep'):
            yield state, manager, api, detached, kill, popen

    def test_verified_install_is_relocated_private_and_does_not_copy_credentials(self):
        state = self.create()
        self.assertEqual(state['target'], str(self.target))
        self.assertEqual(state['runtimePort'], 43384)
        self.assertEqual(set(state['steps']), {'source'})
        self.assertEqual(setup.load_state(self.target)['agentLogin'], 'not_verified')
        self.assertEqual(setup.state_path(self.target).stat().st_mode & 0o777, 0o600)
        self.assertTrue((self.target / 'scripts/pa.sh').stat().st_mode & 0o100)
        self.assertFalse((self.target / '.env').exists())
        self.assertFalse((self.target / '.runtime/agent-companion.json').exists())
        with self.assertRaisesRegex(setup.SetupError, 'not empty'):
            self.create()

    def test_service_install_writes_a_private_per_instance_job_without_copying_environment_secrets(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen), \
                patch.dict(setup.os.environ, {'MODEL_PRIVATE_KEY': 'must-not-copy-this'}):
            setup.service_install(self.target, state, self.tools)
            label, path, identity = setup.service_paths(self.target)
            definition = plistlib.loads(path.read_bytes())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(definition['ProgramArguments'], ['/fixture/node', str(self.target / 'scripts/webui.mjs'), '--port', '43383'])
            self.assertTrue(definition['RunAtLoad']); self.assertTrue(definition['KeepAlive'])
            self.assertEqual(definition['ThrottleInterval'], 15)
            self.assertEqual(definition['EnvironmentVariables']['PA_WEB_MANAGED'], '1')
            self.assertEqual(definition['EnvironmentVariables']['XIAOMAN_PORT'], '43384')
            self.assertNotIn('must-not-copy-this', path.read_text())
            log = self.target / '.runtime/logs/setup/service.log'
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
            self.assertEqual(state['service']['desired'], 'running')
            self.assertEqual(state['webPid'], manager.pid)
            self.assertEqual(api.calls[0], ('/api/state', None))
            self.assertIn(('/api/start', {}), api.calls)
            detached.assert_called_once_with(self.target)
            kill.assert_not_called(); popen.assert_not_called()
            other = self.root / 'another instance'
            self.assertNotEqual(setup.service_paths(other)[0], label)
            self.assertTrue(all(identity in call or call[0] == 'bootstrap' for call in manager.calls))

    def test_service_pid_refresh_and_stop_disable_prevent_keepalive_from_undoing_manual_stop(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            old_pid = state['webPid']
            manager.spawn()  # launchd restarted the process; persisted PID is stale.
            current = setup.report(self.target)
            self.assertTrue(current['web']['running'])
            self.assertEqual(current['service']['pid'], manager.pid)
            self.assertNotEqual(manager.pid, old_pid)
            current = setup.stop(self.target)
            self.assertFalse(manager.loaded); self.assertFalse(manager.enabled)
            self.assertEqual(current['service']['desired'], 'stopped')
            self.assertFalse(current['web']['running'])
            self.assertEqual(api.calls[-2:], [('/api/stop', {}), ('/api/state', None)])
            self.assertIn('disable', [call[0] for call in manager.calls])
            self.assertIn('bootout', [call[0] for call in manager.calls])
            # An explicit start re-enables/bootstrap and clears the runtime pause.
            state = setup.load_state(self.target)
            setup.start(self.target, state, self.tools)
            self.assertTrue(manager.loaded); self.assertTrue(manager.enabled)
            self.assertTrue(api.running)
            self.assertEqual(api.calls[-2:], [('/api/start', {}), ('/api/state', None)])
            self.assertEqual(state['service']['desired'], 'running')
            kill.assert_not_called(); popen.assert_not_called()

    def test_service_install_is_idempotent_without_interrupting_an_already_running_instance(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            with patch.dict(setup.os.environ, {'PATH': '/another/shell/path'}):
                setup.service_install(self.target, state, self.tools)
            before_pid = manager.pid
            manager.calls.clear(); api.calls.clear(); detached.reset_mock()
            setup.service_install(self.target, state, self.tools)
            self.assertEqual(manager.pid, before_pid)
            self.assertNotIn('bootout', [call[0] for call in manager.calls])
            self.assertNotIn('bootstrap', [call[0] for call in manager.calls])
            self.assertNotIn('kickstart', [call[0] for call in manager.calls])
            detached.assert_not_called()
            self.assertEqual(api.calls[0], ('/api/state', None))
            self.assertIn(('/api/start', {}), api.calls)

    def test_stop_waits_through_launchd_retaining_an_exited_pid_without_weakening_identity_checks(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            manager.stale_pid_reports_after_bootout = 2
            def probe(pid, number):
                self.assertEqual(number, 0, 'No signal may be sent when a PID has already exited')
                self.assertEqual(pid, manager.pid)
                if pid not in manager.alive:
                    raise ProcessLookupError()
            kill.side_effect = probe
            result = setup.stop(self.target)
            self.assertEqual(result['service']['desired'], 'stopped')
            self.assertFalse(result['service']['loaded'])
            self.assertFalse(result['web']['running'])
            self.assertEqual(kill.call_count, 2)
            self.assertFalse(manager.enabled)
            popen.assert_not_called()

    def test_sigtermed_zombie_with_lost_argv_must_be_reaped_before_stop_can_finish(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            manager.stale_pid_reports_after_bootout = 1
            probes = 0
            def zombie_then_reaped(pid, number):
                nonlocal probes
                self.assertEqual(number, 0); self.assertEqual(pid, manager.pid)
                probes += 1
                if probes >= 3:
                    raise ProcessLookupError()
            kill.side_effect = zombie_then_reaped
            result = setup.stop(self.target)
            self.assertEqual(probes, 3)
            self.assertEqual(result['service']['desired'], 'stopped')
            self.assertFalse(result['service']['loaded'])
            self.assertFalse(result['web']['running'])
            popen.assert_not_called()

    def test_sigtermed_phase_cannot_justify_accepting_an_unverified_pid_that_remains_alive(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            manager.stale_pid_reports_after_bootout = 1
            with self.assertRaisesRegex(setup.SetupError, 'PID does not belong'):
                setup.stop(self.target)
            self.assertNotEqual(setup.load_state(self.target)['steps']['start'], 'stopped')
            self.assertEqual(kill.call_count, 21)
            self.assertTrue(all(call.args == (manager.pid, 0) for call in kill.call_args_list))
            popen.assert_not_called()

    def test_a_live_reused_launchd_pid_still_blocks_stop_before_any_service_operation(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            manager.alive[manager.pid] = '/another/instance/node scripts/webui.mjs --port 9999'
            manager.calls.clear(); api.calls.clear()
            with self.assertRaisesRegex(setup.SetupError, 'PID does not belong'):
                setup.stop(self.target)
            self.assertEqual([call[0] for call in manager.calls], ['print'])
            self.assertEqual(api.calls, [])
            kill.assert_called_once_with(manager.pid, 0)
            self.assertTrue(manager.enabled); self.assertTrue(manager.loaded)
            popen.assert_not_called()
            # Lack of permission to inspect the live PID must not become an
            # "already exited" proof or authorize controlling the job.
            manager.calls.clear(); kill.reset_mock(); kill.side_effect = PermissionError()
            with self.assertRaisesRegex(setup.SetupError, 'PID does not belong'):
                setup.stop(self.target)
            self.assertEqual([call[0] for call in manager.calls], ['print'])
            self.assertEqual(api.calls, [])
            kill.assert_called_once_with(manager.pid, 0)

    def test_managed_service_rejects_another_instances_http_response_without_host_operations(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            api.instance_id = 'another-instance'
            with self.assertRaisesRegex(setup.SetupError, 'installation failed'):
                setup.service_install(self.target, state, self.tools)
            self.assertFalse(any(path in {'/api/start', '/api/stop'} for path, _ in api.calls))
            kill.assert_not_called(); popen.assert_not_called()

    def test_starting_control_socket_waits_for_supervisor_without_spawning_or_replaying_start(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            api.start_error_once = 'RUNTIME_CONTROL_UNAVAILABLE'
            setup.service_install(self.target, state, self.tools)
            self.assertEqual([path for path, _ in api.calls].count('/api/start'), 1)
            self.assertEqual(state['steps']['start'], 'done')
            self.assertTrue(manager.loaded)
            kill.assert_not_called(); popen.assert_not_called()

    def test_existing_loaded_identity_without_private_definition_is_not_touched(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen), \
                patch.object(setup, 'launchctl', return_value=SimpleNamespace(returncode=0, stdout='foreign job', stderr='')) as control:
            with self.assertRaisesRegex(setup.SetupError, 'already loaded without a verified definition'):
                setup.service_install(self.target, state, self.tools)
            self.assertEqual(control.call_count, 1)
            self.assertEqual(control.call_args.args[0][0], 'print')
            detached.assert_not_called()
            self.assertFalse(setup.service_paths(self.target)[1].exists())
            kill.assert_not_called(); popen.assert_not_called()

    def test_supervisor_busy_during_first_install_is_retried_without_rollback(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            api.busy_starts = 3
            api.running, api.desired = False, 'stopped'
            setup.service_install(self.target, state, self.tools)
            self.assertEqual([path for path, _ in api.calls].count('/api/start'), 4)
            self.assertNotIn('bootout', [call[0] for call in manager.calls])
            self.assertEqual(state['steps']['start'], 'done')
            self.assertEqual(api.desired, 'running')

    def test_persistent_busy_preserves_cause_through_continue_and_stops_owned_host(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen), \
                patch.object(setup, 'preflight', return_value=self.tools), \
                patch.object(setup, 'verify_agent'):
            api.busy_starts = 1000
            with self.assertRaisesRegex(setup.SetupError, 'BUSY'):
                setup.continue_install(self.target)
            failure = setup.load_state(self.target)['failure']
            self.assertEqual(failure['code'], 'SERVICE_INSTALL_FAILED')
            self.assertEqual(failure['cause'], 'BUSY')
            self.assertEqual(failure['cleanup'], 'STOPPED')
            self.assertFalse(api.running); self.assertFalse(manager.loaded)
            log = self.target / failure['log']
            self.assertEqual(json.loads(log.read_text())['code'], 'BUSY')
            self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)

    def test_standalone_skill_uses_its_own_payload_and_missing_or_mixed_resources_fail(self):
        skill = self.root / 'copied standalone skill'
        script = skill / 'scripts/xiaoman_setup.py'
        script.parent.mkdir(parents=True)
        script.write_text('# fixture installer\n')
        (skill / 'assets').mkdir()
        with patch.object(setup, '__file__', str(script)), patch.object(setup, 'preflight', return_value=self.tools):
            with self.assertRaisesRegex(setup.SetupError, 'payload is missing'):
                setup.main(['check', '--provider', 'codex'])
            write_archive(skill / 'assets/framework.zip', self.entries)
            self.assertTrue(setup.main(['check', '--provider', 'codex'])['resources']['verified'])
            with patch.object(setup, 'continue_install', return_value={'installed': True}):
                setup.main(['install', '--provider', 'codex', '--target', str(self.target)])
            self.assertEqual(setup.load_state(self.target)['steps']['source'], 'done')
            script.write_text('# mismatched installer\n')
            with self.assertRaisesRegex(setup.SetupError, 'installer and framework differ'):
                setup.main(['check', '--provider', 'codex'])

    def test_service_stop_waits_for_verified_web_exit_and_does_not_falsely_record_stopped(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            manager.keep_web_alive_after_bootout = True
            with self.assertRaisesRegex(setup.SetupError, 'still stopping'):
                setup.stop(self.target)
            persisted = setup.load_state(self.target)
            self.assertNotEqual(persisted['steps']['start'], 'stopped')
            self.assertTrue(setup.report(self.target)['web']['running'])
            self.assertFalse(manager.enabled)
            kill.assert_not_called(); popen.assert_not_called()

    def test_unreachable_managed_web_uses_control_only_fallback_for_starting_host_records(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            detached.reset_mock()
            with patch.object(api, 'connect', side_effect=OSError('fixture Web unreachable')):
                setup.stop(self.target)
            detached.assert_called_once_with(self.target, control_only=True)
            self.assertFalse(manager.loaded); self.assertFalse(manager.enabled)
            kill.assert_not_called(); popen.assert_not_called()

    def test_control_only_stop_always_asks_node_to_stop_even_when_control_socket_is_offline(self):
        self.create()
        api = FakeManagedAPI(self.target)
        api.control_only, api.running, api.starting_host_alive = True, False, True
        state = setup.load_state(self.target)
        state['webPid'] = 54321
        setup.private_json(setup.state_path(self.target), state)
        with patch.object(setup, 'connect_web', return_value=(api, api.snapshot())) as connect, \
                patch.object(setup.shutil, 'which', return_value='/fixture/node'), \
                patch.object(setup, 'owned_process', side_effect=[True, False, False]), \
                patch.object(setup.os, 'kill') as kill:
            result = setup.stop_detached(self.target, control_only=True)
        self.assertEqual(connect.call_args.kwargs, {'control_only': True})
        self.assertEqual(api.calls, [('/api/stop', {}), ('/api/state', None)])
        self.assertFalse(api.starting_host_alive)
        self.assertFalse(any(path == '/api/start' for path, _ in api.calls))
        self.assertEqual(result['steps']['start'], 'stopped')
        kill.assert_called_once_with(54321, setup.signal.SIGTERM)

    def test_service_install_failure_keeps_private_data_and_can_be_retried(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            note = self.target / '.runtime/user-note.txt'
            note.write_text('preserve my private record')
            manager.fail_bootstrap = True
            with self.assertRaisesRegex(setup.SetupError, 'installation failed'):
                setup.service_install(self.target, state, self.tools)
            self.assertFalse(setup.service_paths(self.target)[1].exists())
            self.assertEqual(setup.load_state(self.target)['failure']['code'], 'SERVICE_INSTALL_FAILED')
            self.assertEqual(note.read_text(), 'preserve my private record')
            self.assertFalse(manager.loaded)
            manager.fail_bootstrap = False
            setup.service_install(self.target, state, self.tools)
            self.assertTrue(manager.loaded)
            self.assertNotIn('failure', setup.load_state(self.target))
            kill.assert_not_called(); popen.assert_not_called()

    def test_failed_service_definition_update_restores_the_previously_running_runtime_intent(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            original = setup.service_paths(self.target)[1].read_bytes()
            api.calls.clear()
            manager.fail_bootstrap_for_node = '/fixture/replacement-node'
            with self.assertRaisesRegex(setup.SetupError, 'installation failed'):
                setup.service_install(self.target, state, {**self.tools, 'node': '/fixture/replacement-node'})
            self.assertEqual(setup.service_paths(self.target)[1].read_bytes(), original)
            self.assertTrue(manager.loaded); self.assertTrue(manager.enabled)
            self.assertEqual(api.desired, 'running'); self.assertTrue(api.running)
            self.assertIn(('/api/stop', {}), api.calls)
            self.assertEqual([path for path, _ in api.calls].count('/api/start'), 1)
            restored = setup.load_state(self.target)
            self.assertEqual(restored['failure']['recovery'], 'RESTORED_RUNNING')
            self.assertEqual(restored['failure']['code'], 'SERVICE_INSTALL_FAILED')
            self.assertEqual(restored['service']['desired'], 'running')
            self.assertEqual(restored['steps']['start'], 'done')
            kill.assert_not_called(); popen.assert_not_called()

    def test_failed_service_definition_update_keeps_a_previously_paused_runtime_paused(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            original = setup.service_paths(self.target)[1].read_bytes()
            api.running, api.desired = False, 'stopped'  # Owner paused via Web.
            api.calls.clear()
            manager.fail_bootstrap_for_node = '/fixture/replacement-node'
            with self.assertRaisesRegex(setup.SetupError, 'installation failed'):
                setup.service_install(self.target, state, {**self.tools, 'node': '/fixture/replacement-node'})
            self.assertEqual(setup.service_paths(self.target)[1].read_bytes(), original)
            self.assertTrue(manager.loaded)  # The original management Web remains.
            self.assertEqual(api.desired, 'stopped'); self.assertFalse(api.running)
            self.assertFalse(any(path == '/api/start' for path, _ in api.calls))
            restored = setup.load_state(self.target)
            self.assertEqual(restored['failure']['recovery'], 'RESTORED_PAUSED')
            kill.assert_not_called(); popen.assert_not_called()

    def test_service_identity_mismatch_is_rejected_before_controlling_any_job(self):
        with self.managed_fixture() as (state, manager, api, detached, kill, popen):
            setup.service_install(self.target, state, self.tools)
            path = setup.service_paths(self.target)[1]
            definition = plistlib.loads(path.read_bytes())
            definition['ProgramArguments'][1] = '/another/instance/scripts/webui.mjs'
            path.write_bytes(plistlib.dumps(definition))
            manager.calls.clear()
            with self.assertRaisesRegex(setup.SetupError, 'identity does not match'):
                setup.stop(self.target)
            self.assertEqual(manager.calls, [])
            kill.assert_not_called(); popen.assert_not_called()

    def test_default_continue_installs_service_and_no_start_never_registers_one(self):
        self.create()
        with patch.object(setup, 'preflight', return_value=self.tools), \
                patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
                patch.object(setup, 'owned_process', return_value=False), \
                patch.object(setup, 'verify_agent'), \
                patch.object(setup, 'service_install') as install:
            setup.continue_install(self.target, no_start=True)
            install.assert_not_called()
            setup.continue_install(self.target)
            install.assert_called_once()

    def test_new_setup_steps_survive_a_real_state_reload(self):
        state = self.create()
        for name in ('agent-check', 'pet-dependencies', 'sources-0123456789abcdef'):
            state['steps'][name] = 'done'
        setup.private_json(setup.state_path(self.target), state)
        self.assertEqual(setup.load_state(self.target)['steps'], state['steps'])
        state['steps']['unknown-step'] = 'done'
        setup.private_json(setup.state_path(self.target), state)
        with self.assertRaisesRegex(setup.SetupError, 'damaged'):
            setup.load_state(self.target)

    def test_archive_integrity_allowlist_and_path_attacks_are_rejected(self):
        for name, value, mode in [('personal-agent/../escape', b'bad', stat.S_IFREG),
                                  ('/absolute', b'bad', stat.S_IFREG),
                                  ('personal-agent/.runtime/pa.json', b'private', stat.S_IFREG),
                                  ('personal-agent/scripts/link.py', b'outside', stat.S_IFLNK | 0o777),
                                  ('personal-agent/extra.json', b'private', stat.S_IFREG)]:
            with self.subTest(name=name):
                write_archive(self.archive, self.entries, [(name, value, mode)])
                with self.assertRaises(setup.SetupError):
                    setup.read_archive(self.archive)
        changed = dict(self.entries)
        changed['scripts/pa.sh'] = (b'changed', stat.S_IFREG)
        write_archive(self.archive, changed)
        with self.assertRaisesRegex(setup.SetupError, 'integrity'):
            setup.read_archive(self.archive)

    def test_duplicate_zip_member_is_rejected(self):
        with self.assertWarns(UserWarning):
            write_archive(self.archive, self.entries,
                          [('personal-agent/requirements.txt', b'', stat.S_IFREG)])
        with self.assertRaisesRegex(setup.SetupError, 'Duplicate'):
            setup.read_archive(self.archive)

    def test_case_and_unicode_collisions_cannot_overwrite_verified_files_on_macos(self):
        for extra in [{'scripts/PA.sh': b'other'}, {'docs/\u00e9.md': b'one', 'docs/e\u0301.md': b'two'}]:
            with self.subTest(extra=list(extra)):
                write_archive(self.archive, fixture_entries(extra))
                with self.assertRaisesRegex(setup.SetupError, 'collide'):
                    setup.read_archive(self.archive)

    def test_clean_source_requires_same_exact_manifest_and_no_symlinks(self):
        source = self.root / 'source'
        source.mkdir()
        for name, (data, mode) in self.entries.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.assertEqual(setup.source_digest(setup.read_source(source)), setup.source_digest(self.entries))
        (source / '.runtime').mkdir()
        (source / '.runtime/private.json').write_text('{}')
        with self.assertRaises(setup.SetupError):
            setup.read_source(source)
        (source / '.runtime/private.json').unlink()
        (source / '.runtime').rmdir()
        (source / 'link').symlink_to(self.archive)
        with self.assertRaisesRegex(setup.SetupError, 'symlinks'):
            setup.read_source(source)

    def test_target_symlink_and_existing_instance_are_preserved(self):
        actual = self.root / 'actual'
        actual.mkdir()
        self.target.symlink_to(actual, target_is_directory=True)
        with self.assertRaisesRegex(setup.SetupError, 'symlinks'):
            self.create()
        self.assertEqual(list(actual.iterdir()), [])
        self.target.unlink()
        self.target.mkdir()
        important = self.target / 'AGENTS.md'
        important.write_text('User instructions')
        with self.assertRaisesRegex(setup.SetupError, 'not empty'):
            self.create()
        self.assertEqual(important.read_text(), 'User instructions')

    def test_interrupted_dependency_install_continues_and_keeps_private_records(self):
        self.create()
        calls = []
        def fail_once(command, **kwargs):
            calls.append(command)
            if len(calls) == 2:
                raise subprocess.CalledProcessError(1, command)
            return SimpleNamespace(returncode=0)
        with patch.object(setup, 'preflight', return_value=self.tools), \
                patch.object(setup.subprocess, 'run', side_effect=fail_once):
            with self.assertRaisesRegex(setup.SetupError, 'dependencies'):
                setup.continue_install(self.target, no_start=True)
        failed = setup.load_state(self.target)
        self.assertEqual(failed['steps']['dependencies'], 'failed')
        self.assertTrue(Path(failed['failure']['log']).is_file())
        private = self.target / '.runtime/user-note.txt'
        private.write_text('keep my data')
        calls.clear()
        with patch.object(setup, 'preflight', return_value=self.tools), \
                patch.object(setup, 'owned_process', return_value=False), \
                patch.object(setup.subprocess, 'run', side_effect=lambda command, **kw: calls.append(command)), \
                patch.object(setup, 'verify_agent'):
            result = setup.continue_install(self.target, no_start=True)
            first_count = len(calls)
            setup.continue_install(self.target, no_start=True)
        self.assertEqual(first_count, 5)
        self.assertEqual(len(calls), first_count)
        self.assertEqual(private.read_text(), 'keep my data')
        self.assertEqual(result['agentLogin'], 'not_verified')
        self.assertFalse(result['ready'])
        self.assertFalse(any('imessage' in str(c) or 'launchctl' in str(c) for c in calls))
        self.assertEqual(calls[-1][1], str(self.target / 'scripts/configure-local-agent.py'))
        self.assertIn('--proactive', calls[-2])

    def test_pid_reuse_cannot_stop_an_unrelated_process(self):
        state = self.create()
        state.update(webPid=54321, webCommand='/fixture/node ' + str(self.target / 'scripts/webui.mjs') + ' --port 43383')
        setup.private_json(setup.state_path(self.target), state)
        with patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(stdout='python something-else\n')), \
                patch.object(setup, 'connect_web', return_value=(Mock(), {'runtime': {'state': 'offline'}})), \
                patch.object(setup.os, 'kill') as kill:
            self.assertFalse(setup.owned_process(self.target, state))
            setup.stop(self.target)
            kill.assert_not_called()

    def test_start_uses_existing_hosted_roles_and_waits_for_real_host_control(self):
        state = self.create()
        api = Mock()
        api.connect.return_value = {'csrf': 'fixture', 'runtime': {'state': 'offline'}}
        api.request.side_effect = [{'accepted': True}, {'runtime': {'state': 'offline'}},
                                   {'runtime': {'state': 'running', 'connected': False}}]
        child = SimpleNamespace(pid=54321)
        with patch.object(setup, 'owned_process', return_value=False), \
                patch.object(setup, 'assert_free') as free, \
                patch.object(setup, 'LocalAPI', return_value=api), \
                patch.object(setup.subprocess, 'Popen', return_value=child) as popen, \
                patch.object(setup.time, 'sleep'):
            setup.start(self.target, state, self.tools)
        self.assertEqual(free.call_count, 2)
        self.assertEqual(popen.call_args.args[0][1], str(self.target / 'scripts/webui.mjs'))
        self.assertEqual(popen.call_args.kwargs['env']['XIAOMAN_PORT'], '43384')
        self.assertEqual(api.request.call_args_list[0].args, ('/api/start', {}))
        self.assertFalse(any(call.args[0] == '/api/local-agents' for call in api.request.call_args_list))
        self.assertEqual(setup.load_state(self.target)['steps']['start'], 'done')
        self.assertEqual(state['agentLogin'], 'not_verified')

    def test_occupied_port_does_not_start_or_stop_anything(self):
        state = self.create()
        with patch.object(setup, 'owned_process', return_value=False), \
                patch.object(setup, 'assert_free', side_effect=setup.SetupError('Port is already in use')), \
                patch.object(setup.subprocess, 'Popen') as popen:
            with self.assertRaisesRegex(setup.SetupError, 'already in use'):
                setup.start(self.target, state, self.tools)
            popen.assert_not_called()

    def test_closed_connection_time_wait_does_not_block_a_web_restart(self):
        # Mirror Node's SO_REUSEADDR listener and actively close the server side,
        # leaving real TCP TIME_WAIT after every fixture socket has been closed.
        # No Xiaoman service, user account or fixed production port is involved.
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            listener.listen(1)
            with socket.create_connection(('127.0.0.1', port), timeout=3) as client:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(3)
                    connection.shutdown(socket.SHUT_WR)
                    self.assertEqual(client.recv(1), b'')
                    client.shutdown(socket.SHUT_WR)
                    self.assertEqual(connection.recv(1), b'')
        # Establish that the fixture really produced the original failure.
        with socket.socket() as naive:
            with self.assertRaises(OSError) as failed:
                naive.bind(('127.0.0.1', port))
            self.assertEqual(failed.exception.errno, errno.EADDRINUSE)
        setup.assert_free(port)

    def test_reuse_address_still_rejects_a_live_listener(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            listener.listen(1)
            with self.assertRaisesRegex(setup.SetupError, 'already in use'):
                setup.assert_free(port)

    def test_unavailable_host_is_not_reported_as_success(self):
        state = self.create()
        api = Mock()
        api.connect.return_value = {'runtime': {'state': 'unavailable'}}
        api.request.return_value = {'runtime': {'state': 'unavailable'}}
        with patch.object(setup, 'owned_process', return_value=True), \
                patch.object(setup, 'LocalAPI', return_value=api), patch.object(setup.time, 'sleep'):
            with self.assertRaisesRegex(setup.SetupError, 'did not become reachable'):
                setup.start(self.target, state, self.tools)
        self.assertNotIn('start', state['steps'])

    def test_lost_web_reconnects_to_this_instances_surviving_host_without_port_conflict(self):
        state = self.create()
        api = Mock()
        api.connect.return_value = {'runtime': {'state': 'running', 'owned': False, 'pid': 12345}}
        api.request.return_value = {'runtime': {'state': 'running', 'owned': False, 'pid': 12345}}
        with patch.object(setup, 'owned_process', return_value=False), \
                patch.object(setup, 'assert_free') as free, \
                patch.object(setup, 'LocalAPI', return_value=api), \
                patch.object(setup.subprocess, 'Popen', return_value=SimpleNamespace(pid=54321)):
            setup.start(self.target, state, self.tools)
        self.assertEqual([call.args[0] for call in free.call_args_list], [43383])
        self.assertFalse(any(call.args[0] == '/api/start' for call in api.request.call_args_list))
        self.assertEqual(state['steps']['start'], 'done')

    def test_stop_restores_management_web_then_stops_only_the_proven_surviving_host(self):
        state = self.create()
        runtime = {'protocol': 1, 'state': 'running', 'owned': False, 'pid': 12345}
        api = Mock()
        api.request.side_effect = [{'runtime': runtime}, {'runtime': {'state': 'offline'}}]
        def connect(target, value, tools):
            value['webPid'] = 54321
            value['webCommand'] = '/fixture/node ' + str(target / 'scripts/webui.mjs') + ' --port 43383'
            return api, {'runtime': runtime}
        with patch.object(setup, 'owned_process', side_effect=[False, True, False, False]), \
                patch.object(setup, 'connect_web', side_effect=connect) as restored, \
                patch.object(setup, 'owned_runtime', return_value=True), \
                patch.object(setup.shutil, 'which', return_value='/fixture/node'), \
                patch.object(setup.os, 'kill') as kill:
            result = setup.stop(self.target)
        restored.assert_called_once()
        self.assertEqual([call.args[0] for call in kill.call_args_list], [12345, 54321])
        self.assertFalse(any(call.args[0] == '/api/start' for call in api.request.call_args_list))
        self.assertEqual(result['steps']['start'], 'stopped')
        self.assertNotIn('webPid', setup.load_state(self.target))

    def test_stop_does_not_claim_success_or_kill_when_surviving_host_identity_is_unknown(self):
        state = self.create()
        runtime = {'protocol': 1, 'state': 'running', 'owned': False, 'pid': 12345}
        with patch.object(setup, 'owned_process', return_value=False), \
                patch.object(setup, 'connect_web', return_value=(Mock(), {'runtime': runtime})), \
                patch.object(setup, 'owned_runtime', return_value=False), \
                patch.object(setup.shutil, 'which', return_value='/fixture/node'), \
                patch.object(setup.os, 'kill') as kill:
            with self.assertRaisesRegex(setup.SetupError, 'ownership could not be proven'):
                setup.stop(self.target)
        kill.assert_not_called()
        self.assertNotEqual(setup.load_state(self.target)['steps'].get('start'), 'stopped')

    def test_orphan_host_proof_requires_private_socket_exact_cli_arguments_and_instance_cwd(self):
        state = self.create()
        runtime = {'protocol': 1, 'state': 'running', 'pid': 12345}
        command = 'node ' + str(self.target / 'node_modules/.bin/dsh') + ' --profile wx-life --no-open --port 43384'
        details = SimpleNamespace(stdout=str(setup.os.getuid()) + ' ' + command + '\n')
        cwd = SimpleNamespace(stdout='p12345\nfcwd\nn' + str(self.target / '.runtime/workspace') + '\n')
        private_socket = SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600, st_uid=setup.os.getuid())
        with patch.object(setup.Path, 'lstat', return_value=private_socket), \
                patch.object(setup.shutil, 'which', return_value='/fixture/node'), \
                patch.object(setup.subprocess, 'run', side_effect=[details, cwd]):
            self.assertTrue(setup.owned_runtime(self.target, state, runtime))
        for detail, directory in [(details, SimpleNamespace(stdout='p12345\nfcwd\nn/another/instance\n')),
                                  (SimpleNamespace(stdout=str(setup.os.getuid()) + ' ' + command + ' extra-arg\n'), cwd)]:
            with patch.object(setup.Path, 'lstat', return_value=private_socket), \
                    patch.object(setup.shutil, 'which', return_value='/fixture/node'), \
                    patch.object(setup.subprocess, 'run', side_effect=[detail, directory]):
                self.assertFalse(setup.owned_runtime(self.target, state, runtime))

    def test_local_api_uses_cookie_origin_csrf_and_only_the_loopback_server(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path == '/':
                    self.send_response(200)
                    self.send_header('Set-Cookie', 'pa_session=fixture; HttpOnly; SameSite=Strict; Path=/')
                    self.end_headers()
                    self.wfile.write(b'fixture')
                    return
                received.append((self.path, dict(self.headers)))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'ok': True, 'data': {'csrf': 'fixture-csrf'}}).encode())

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append((self.path, dict(self.headers), body))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"ok":true,"data":{"accepted":true}}')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            api = setup.LocalAPI(server.server_address[1])
            api.connect()
            self.assertTrue(api.request('/api/start', {})['accepted'])
            self.assertEqual(received[0][1]['Cookie'], 'pa_session=fixture')
            self.assertEqual(received[1][1]['Origin'], api.origin)
            self.assertEqual(received[1][1]['X-Pa-Csrf'], 'fixture-csrf')
            self.assertEqual(received[1][2], {})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())

    def test_runtime_symlink_and_invalid_ports_fail_without_modifying_files(self):
        for ports in [(3383, 3383), (80, 3384), (65535, None)]:
            with self.subTest(ports=ports), self.assertRaises(setup.SetupError):
                setup.new_install(self.target, self.entries, 'codex', '/fixture/codex', *ports)
            self.assertFalse(self.target.exists())
        state = self.create()
        runtime = self.target / '.runtime'
        moved = self.root / 'private-runtime'
        runtime.rename(moved)
        runtime.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(setup.SetupError):
            setup.load_state(self.target)

    def test_preflight_checks_executable_without_claiming_login_or_running_model(self):
        with patch.object(setup.sys, 'platform', 'darwin'), \
                patch.object(setup.shutil, 'which', side_effect=lambda name: '/fixture/' + name), \
                patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(stdout='v22.19.0\n')) as run:
            result = setup.preflight('codex')
        self.assertEqual(result['agentLogin'], 'not_verified')
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][-1], '--version')
        with patch.object(setup.sys, 'platform', 'linux'), self.assertRaisesRegex(setup.SetupError, 'macOS'):
            setup.preflight('codex')

    def test_package_has_two_discoverable_skills_and_one_nonrecursive_verified_payload(self):
        author = self.root / 'author'
        author.mkdir()
        for name, (data, mode) in self.entries.items():
            if name == 'SOURCE_MANIFEST.json':
                continue
            path = author / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (author / '.runtime').mkdir()
        (author / '.runtime/private').write_text('private-owner-token')
        output = self.root / 'skills.zip'
        def package_framework(root, target):
            return write_archive(target, self.entries)
        with patch.object(bundle, 'package_framework', side_effect=package_framework):
            bundle.package_skills(author, output)
        with zipfile.ZipFile(output) as archive:
            names = archive.namelist()
            self.assertIn('skills/xiaoman-setup/SKILL.md', names)
            self.assertIn('skills/xiaoman-journal-design/SKILL.md', names)
            self.assertIn('skills/xiaoman-setup/scripts/xiaoman_setup.py', names)
            self.assertNotIn('skills/xiaoman-setup/assets/framework.zip', self.entries)
            payload = self.root / 'inner.zip'
            payload.write_bytes(archive.read('skills/xiaoman-setup/assets/framework.zip'))
            setup.read_archive(payload)
            for name in bundle.GENERATED:
                self.assertEqual((author / name).read_bytes(), archive.read(name))
            manifest = json.loads(archive.read('BUNDLE_MANIFEST.json'))
            self.assertEqual(hashlib.sha256(payload.read_bytes()).hexdigest(), manifest['frameworkSha256'])
            for name in names:
                self.assertNotIn(b'private-owner-token', archive.read(name))


if __name__ == '__main__':
    unittest.main()
