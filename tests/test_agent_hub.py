"""Shared middleware contracts, including the installed DSH runtime with fake model output."""
import subprocess
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

class AgentHubTests(unittest.TestCase):
    def test_hub_and_native_dsh_contracts(self):
        result = subprocess.run(['node', '--test', str(ROOT / 'tests/agent_hub.test.mjs'), str(ROOT / 'tests/dsh_hub.test.mjs')],
                                cwd=ROOT, capture_output=True, text=True, timeout=150)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
