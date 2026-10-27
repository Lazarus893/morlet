"""Web management contracts; no live accounts, phone control or model calls."""
import concurrent.futures
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
from pa_config import load_config, config_revision, write_config


class WebUITests(unittest.TestCase):
    def test_web_management_contracts(self):
        result = subprocess.run(['node', '--test', str(ROOT / 'tests/webui.test.mjs')], cwd=ROOT,
                                capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_concurrent_configuration_save_rejects_lost_update(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cfg = json.loads((ROOT / 'config/pa.example.json').read_text())
            write_config(cfg, root)
            revision = config_revision(cfg)
            def attempt(owner):
                changed = dict(cfg, owner=owner)
                try:
                    write_config(changed, root, expected_revision=revision)
                    return True
                except ValueError as error:
                    self.assertEqual(str(error), 'CONFLICT')
                    return False
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(attempt, ['一号用户', '二号用户']))
            self.assertEqual(sorted(results), [False, True])
            self.assertIn(load_config(root)['owner'], ['一号用户', '二号用户'])
