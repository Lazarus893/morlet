"""Fresh-instance role setup; no login, model, message or device operations."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'bin'))
from source_files import source_files
from pa_config import load_config, write_config
from configure import configure

spec = importlib.util.spec_from_file_location('configure_local_agent', ROOT / 'scripts/configure-local-agent.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class LocalAgentConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='new local agent ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for source in source_files(ROOT):
            target = self.root / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())

    def test_existing_cli_binds_all_roles_and_repeated_setup_preserves_preferences(self):
        result = helper.bind_local_agent(self.root, 'codex', sys.executable)
        self.assertEqual(result['login'], 'not_verified')
        hub = json.loads((self.root / '.runtime/agent-hub.json').read_text())
        self.assertEqual(set(hub['roles'].values()), {'local-codex'})
        self.assertEqual(hub['agents'][0]['provider'], 'codex')
        cfg = load_config(self.root)
        self.assertFalse(cfg['proactive']['enabled'])
        self.assertEqual(cfg['device']['provider'], 'none')
        self.assertFalse((self.root / '.runtime/imessage-companion.json').exists())
        cfg['owner'] = 'Chosen name'
        cfg['proactive']['enabled'] = True
        write_config(cfg, self.root)
        helper.bind_local_agent(self.root, 'codex', sys.executable)
        self.assertEqual(load_config(self.root)['owner'], 'Chosen name')
        self.assertTrue(load_config(self.root)['proactive']['enabled'])

    def test_fresh_standard_configuration_uses_the_selected_cli_without_dsh_roles(self):
        cfg = load_config(self.root)
        cfg['agent'].update(provider='workbuddy', command=sys.executable)
        write_config(cfg, self.root)
        configure(self.root)
        hub = json.loads((self.root / '.runtime/agent-hub.json').read_text())
        self.assertEqual(set(hub['roles'].values()), {'local-workbuddy'})
        self.assertEqual(hub['agents'][0]['command'], sys.executable)

    def test_existing_roles_and_business_data_cannot_be_replaced_by_installer(self):
        configure(self.root)
        hub_path = self.root / '.runtime/agent-hub.json'
        cfg_path = self.root / '.runtime/pa.json'
        before = (hub_path.read_bytes(), cfg_path.read_bytes())
        database = self.root / '.runtime/hub/hub.sqlite'
        database.parent.mkdir()
        database.write_bytes(b'existing instance marker')
        with self.assertRaisesRegex(ValueError, 'already has Agent roles'):
            helper.bind_local_agent(self.root, 'codex', sys.executable)
        self.assertEqual((hub_path.read_bytes(), cfg_path.read_bytes()), before)

    def test_invalid_cli_or_external_workspace_does_not_change_saved_settings(self):
        configure(self.root)
        path = self.root / '.runtime/pa.json'
        before = path.read_bytes()
        for command, workspace in [('/missing/cli', None), (sys.executable, str(self.root / 'personal-project'))]:
            with self.assertRaises(ValueError):
                helper.bind_local_agent(self.root, 'codex', command, workspace)
            self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
