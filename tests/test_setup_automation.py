"""Fresh setup regression checks; no accounts, processes or notifications."""
import json
import os
from pathlib import Path
import plistlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import setup_automation as automation
import xiaoman_setup as setup


class AutomationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / '.runtime').mkdir(mode=0o700)
        self.state = {'port': 12345, 'steps': {}}

    def test_partial_connect_can_be_stopped_after_first_service_fails(self):
        class API:
            origin = 'http://127.0.0.1:12345'
            def __init__(self, port): pass
            def connect(self): pass
            def request(self, path, value=None):
                return {'token': 'fake'} if value else {'bridge': {'paired': False}, 'revision': 0}
        with patch.object(automation, 'LocalAPI', API), patch.object(automation.shutil, 'which', return_value='/fixture/gh'), \
                patch.object(automation, 'control_service', side_effect=setup.SetupError('interrupted')):
            with self.assertRaisesRegex(setup.SetupError, 'interrupted'):
                automation.connect(self.root, self.state, {'node': '/fixture/node'}, sources=['github'])
        saved = json.loads(setup.state_path(self.root).read_text())
        self.assertTrue(saved['automation']['configured'])
        self.assertTrue((self.root / '.runtime/connection-companion.json').exists())

    def test_null_worker_and_empty_journal_never_claim_ready(self):
        snapshots = {'/api/connections': {'items': [{'id': 'github', 'state': 'connected'}]},
                     '/api/automatic-content': {'entries': [], 'enabled': True, 'today': 0, 'maxDaily': 18},
                     '/api/personal-notices': {'notices': [], 'enabled': True, 'channelReady': True, 'worker': None}}
        class API:
            def __init__(self, port): pass
            def connect(self): pass
            def request(self, path): return snapshots[path]
        self.state['automation'] = {'sources': ['github']}
        with patch.object(automation, 'LocalAPI', API), patch.object(automation, 'control_all', return_value={}):
            result = automation.status(self.root, self.state)
        self.assertFalse(result['ready'])
        self.assertTrue(result['evidence']['authorized'])

    def test_foreign_plist_cannot_stop_another_instance(self):
        path = self.root / 'service.plist'
        data = automation.definition(self.root, 'pet', '/fixture/node')
        data['ProgramArguments'][1] = '/another-instance/scripts/pet-host.mjs'
        path.write_bytes(plistlib.dumps(data)); path.chmod(0o600)
        with patch.object(automation, 'service_paths', return_value=(data['Label'], path, 'fixture')), \
                patch.object(automation, 'launchctl') as control:
            with self.assertRaisesRegex(setup.SetupError, 'another instance'):
                automation.control_service(self.root, 'pet', 'stop')
            control.assert_not_called()

    def test_stop_order_stops_delivery_before_pet_and_connections(self):
        with patch.object(automation, 'control_service', return_value={}) as control:
            automation.control_all(self.root, 'stop')
        self.assertEqual([c.args[1] for c in control.call_args_list], ['notices', 'pet', 'connections'])

    def test_launchd_child_must_finish_exec_before_claiming_ownership(self):
        data = automation.definition(self.root, 'pet', '/fixture/node')
        output = SimpleNamespace(returncode=0, stdout='path = /fixture/job.plist\npid = 123\n')
        actual = [SimpleNamespace(returncode=0, stdout='(node)'),
                  SimpleNamespace(returncode=0, stdout=' '.join(data['ProgramArguments']))]
        with patch.object(automation, 'read_definition', return_value=data), \
                patch.object(automation, 'service_paths', return_value=('label', Path('/fixture/job.plist'), 'job')), \
                patch.object(automation, 'launchctl', return_value=output), \
                patch.object(automation.subprocess, 'run', side_effect=actual), patch.object(automation.time, 'sleep'):
            self.assertTrue(automation.service_status(self.root, 'pet')['running'])

    def test_private_config_rejects_symlink(self):
        target = self.root / 'real.json'; setup.private_json(target, {})
        link = self.root / 'link.json'; link.symlink_to(target)
        with self.assertRaises(setup.SetupError): automation.private_config(link)

    def test_model_check_needs_execution_evidence(self):
        with patch.object(setup, 'run_step'):
            with self.assertRaisesRegex(setup.SetupError, 'evidence is missing'):
                setup.verify_agent(self.root, {'provider': 'codex'}, {'node': '/fixture/node'})
        setup.private_json(self.root / '.runtime/setup-agent-check.json', {'verified': True, 'provider': 'codex', 'model': 'fixture'})
        state = {'provider': 'codex'}
        with patch.object(setup, 'run_step'):
            setup.verify_agent(self.root, state, {'node': '/fixture/node'})
        self.assertEqual(state['agentLogin'], 'verified')
