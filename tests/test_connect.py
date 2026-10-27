"""Connection entry points with isolated HTTP and tools, no real accounts or services."""
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("connect", ROOT / "scripts/connect.py")
connect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connect)


class ConnectTests(unittest.TestCase):
    def test_local_setup_and_imessage_contracts(self):
        result = subprocess.run(["node", "--test", "tests/local_agent_setup.test.mjs", "tests/imessage_setup.test.mjs"],
                                cwd=ROOT, capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_discovery_does_not_spawn_or_check_login(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(connect, "ROOT", Path(directory)), \
                patch.object(connect.shutil, "which", side_effect=lambda name: "/fixture/" + name), \
                patch.object(connect.subprocess, "run", side_effect=AssertionError("must not run")):
            result = connect.discover()
        self.assertEqual([a["provider"] for a in result["agents"]], ["codex", "workbuddy"])
        self.assertTrue(all(a["login"] == "unchecked" for a in result["agents"]))

    def test_local_install_rejects_remote_and_credential_urls_before_network(self):
        for url in ["https://example.invalid", "http://localhost:3083", "http://127.0.0.1:3083/path", "http://user:pass@127.0.0.1:3083", "http://127.0.0.1:3083?secret=x"]:
            with self.subTest(url=url), patch.object(connect, "build_opener", side_effect=AssertionError("must not connect")):
                with self.assertRaises(ValueError):
                    connect.local_agent(url, "codex")

    def test_local_install_uses_page_session_csrf_and_only_selected_provider(self):
        calls = []
        class Response:
            def __init__(self, content): self.content = content
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return self.content
        class Client:
            def open(self, request, **kwargs):
                calls.append(request)
                if request.full_url.endswith("/api/state"):
                    return Response(json.dumps({"ok": True, "data": {"csrf": "fixture-csrf"}}).encode())
                if request.full_url.endswith("/api/local-agents"):
                    return Response(json.dumps({"ok": True, "data": {"installed": True}}).encode())
                return Response(b"page")
        with patch.object(connect, "build_opener", return_value=Client()):
            connect.local_agent("http://127.0.0.1:3083", "codex")
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[-1].get_header("X-pa-csrf"), "fixture-csrf")
        self.assertEqual(json.loads(calls[-1].data), {"provider": "codex", "workspace": None})


if __name__ == "__main__":
    unittest.main()
