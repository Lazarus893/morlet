"""Verify relocation and exclusion of private runtime data from distributions."""
import importlib.util
import hashlib
import json
import shutil
import sys
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from configure import configure
from source_files import source_files
from pa_config import load_config, write_config, capabilities
from import_skills import import_skill
from render_deployment import render as render_deployment, validate as validate_deployment


def manifest(root, names):
    path = root / "config/distribution.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "files": ["config/distribution.json", *names]}))


def copy_framework(root):
    for source in source_files(ROOT):
        target = root / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


class DistributionTests(unittest.TestCase):
    def test_public_fetch_limits_reach_generated_profile_without_transport_overrides(self):
        with tempfile.TemporaryDirectory(prefix="xiaoman fetch bounds ") as temporary:
            root = Path(temporary)
            copy_framework(root)
            for _ in range(2):
                configure(root)
                profile = root / ".runtime/dsh/profiles/wx-life"
                rows = json.loads((profile / "cordis.patch.yml").read_text())
                fetch = [row for row in rows if row.get("id") == "web-fetch-http"]
                tool = [row for row in rows if row.get("id") == "tool-web"]
                self.assertEqual(len(fetch), 1)
                self.assertEqual(len(tool), 1)
                self.assertEqual(fetch[0]["config"], {"maxBodyChars": 1000000})
                self.assertEqual(tool[0]["config"], {"fetchMaxOutputChars": 1000000})
                preset = json.loads((root / ".runtime/dsh/.agent-presets/xiaoman/agent.cordis.yml").read_text())
                native_tool = [row for row in preset if row.get("id") == "tool-web"]
                self.assertEqual(len(native_tool), 1)
                self.assertEqual(native_tool[0]["config"]["fetchMaxOutputChars"], 1000000)
                self.assertTrue(native_tool[0]["config"]["fetch"])
                settings = json.loads((profile / "settings.yaml").read_text())
                self.assertNotIn("web-fetch-http", settings)
                self.assertNotIn("tool-web", settings)

    def test_relocated_configuration_and_mutable_data(self):
        with tempfile.TemporaryDirectory(prefix="xiaoman move ") as temporary:
            root = Path(temporary) / "another checkout"
            for source in source_files(ROOT):
                target = root / source.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
            configure(root)
            profile = root / ".runtime/dsh/profiles/wx-life"
            patch = json.loads((profile / "cordis.patch.yml").read_text())
            policy = next(row for row in patch if row.get("id") == "sandbox-policy")
            self.assertEqual(policy["config"]["workspaceRoot"], str(root / ".runtime/workspace"))
            self.assertNotIn(str(ROOT), json.dumps(patch))
            channel = next(row for row in patch if row.get("id") == "weixin-channel")
            self.assertLess(len(channel["config"]["controlSocketPath"].encode()), 100)
            learned = root / ".runtime/workspace/phone-refs/apps/美团.md"
            learned.write_text("new local learning")
            configure(root)
            self.assertEqual(learned.read_text(), "new local learning")
            self.assertEqual((profile / "node_modules").resolve(), (root / "node_modules").resolve())

    def test_private_data_and_build_outputs_are_excluded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixtures = ("README.md", "config/phone.example.json", ".env", ".env.backup",
                        ".runtime/dsh/.credentials.yaml", "memory/2026-10-08.md",
                        "android/local.properties", "android/app/build/debug.apk",
                        "vendor/auto-phone/__pycache__/test.pyc", "skills/foo/.env",
                        "node_modules/some-package/index.js", "config/private.json",
                        "docs/private-deployment.md", "skills/my-private-skill/SKILL.md",
                        "scripts/local-setup.py", ".runtime/personalization/AGENTS.md")
            for name in fixtures:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("test")
            manifest(root, ["README.md", "config/phone.example.json"])
            selected = {p.relative_to(root).as_posix() for p in source_files(root)}
            self.assertEqual(selected, {"README.md", "config/phone.example.json", "config/distribution.json"})

    def test_external_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "skills").mkdir()
            (root / "skills/external").symlink_to(ROOT / "skills/phone", target_is_directory=True)
            manifest(root, ["skills/external/SKILL.md"])
            with self.assertRaises(ValueError):
                list(source_files(root))

    def test_manifest_rejects_private_paths_traversal_and_missing_files(self):
        for name in (".runtime/pa.json", ".env", "config/account.local.json", "config/state.sqlite",
                     "../outside", "/absolute", "config/../outside", "scripts/missing.py"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                manifest(root, [name])
                with self.assertRaises(ValueError): list(source_files(root))

    def test_personal_prompts_and_models_survive_regeneration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_framework(root)
            cfg = load_config(root)
            cfg["agent"].update(model="selected-model", model_provider="selected-provider")
            cfg["persona"] = {"prefix": "My chosen role\n{{model}}", "suffix": "My style"}
            write_config(cfg, root)
            configure(root)
            custom = root / ".runtime/personalization/AGENTS.md"
            role = root / ".runtime/personalization/life-journal-designer.md"
            custom.write_text("Private preference")
            role.write_text("Private designer role")
            routing = root / ".runtime/agent-hub.json"
            routing_value = json.loads(routing.read_text())
            routing_value["agents"][0]["label"] = "Private agent name"
            routing_value["roles"]["conversation"] = None
            routing.write_text(json.dumps(routing_value))
            configure(root)
            self.assertEqual(json.loads(routing.read_text()), routing_value)
            self.assertEqual(routing.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(routing, list(source_files(root)))
            preset = json.loads((root / ".runtime/dsh/.agent-presets/xiaoman/agent.cordis.yml").read_text())
            self.assertEqual(next(r["config"] for r in preset if r.get("id") == "persona"), cfg["persona"])
            profile = root / ".runtime/dsh/profiles/wx-life"
            rows = json.loads((profile / "cordis.patch.yml").read_text())
            prompt = next(r["config"] for r in rows if r.get("id") == "system-prompt")
            self.assertEqual(prompt["personaPrefix"], cfg["persona"]["prefix"])
            model = next(r["config"] for r in rows if r.get("id") == "agent-default-model")
            self.assertEqual(model, {"provider": "selected-provider", "model": "selected-model"})
            self.assertEqual(json.loads((profile / "settings.yaml").read_text())["agent-default-model"], model)
            self.assertTrue((root / ".runtime/workspace/AGENTS.md").read_text().startswith("Private preference"))
            self.assertEqual(role.read_text(), "Private designer role")
            self.assertEqual(custom.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(custom, list(source_files(root)))

    def test_existing_persona_is_preserved_on_first_private_initialization(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_framework(root)
            configure(root)
            cfg = load_config(root)
            del cfg["persona"]
            write_config(cfg, root)
            profile = root / ".runtime/dsh/profiles/wx-life/cordis.patch.yml"
            rows = json.loads(profile.read_text())
            next(r["config"] for r in rows if r.get("id") == "system-prompt")["personaPrefix"] = "Existing local role"
            profile.write_text(json.dumps(rows))
            (root / ".runtime/personalization/AGENTS.md").unlink()
            (root / ".runtime/workspace/AGENTS.md").write_text("Existing personal instructions\n\n## 本机配置（自动生成）\nold paths")
            configure(root)
            self.assertEqual(load_config(root)["persona"]["prefix"], "Existing local role")
            self.assertEqual((root / ".runtime/personalization/AGENTS.md").read_text(), "Existing personal instructions")

    def test_imported_skills_stay_private_and_activate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "app"
            copy_framework(root)
            source = Path(temporary) / "personal-skills"
            (source / "custom").mkdir(parents=True)
            (source / "custom/SKILL.md").write_text("Personal instructions")
            (source / "custom/.env").write_text("PRIVATE=fixture")
            destination = import_skill(source, "custom", root)
            self.assertFalse((root / "skills/custom").exists())
            self.assertFalse((destination / ".env").exists())
            self.assertEqual((destination / "SKILL.md").stat().st_mode & 0o777, 0o600)
            self.assertTrue(next(row for row in capabilities(load_config(root), root) if row["id"] == "custom")["available"])
            configure(root)
            self.assertEqual((root / ".runtime/workspace/skills/custom/SKILL.md").read_text(), "Personal instructions")
            self.assertNotIn(destination / "SKILL.md", list(source_files(root)))

    def test_package_is_clean_and_bootstraps_an_independent_instance(self):
        from package import package
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "author"
            copy_framework(root)
            secret = uuid.uuid4().hex
            cfg = load_config(root)
            cfg["owner"] = secret
            cfg["im"]["allow_from"] = [secret]
            write_config(cfg, root)
            configure(root)
            for name in ("config/private.json", "docs/deployment-notes.md", "skills/private/SKILL.md", ".runtime/local-skills/private/SKILL.md"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(secret)
            archive = package(root, Path(temporary) / "framework.zip")
            with zipfile.ZipFile(archive) as bundle:
                names = set(bundle.namelist())
                expected = {"personal-agent/" + p.relative_to(root).as_posix() for p in source_files(root)}
                self.assertEqual(names, expected | {"personal-agent/SOURCE_MANIFEST.json"})
                for name in names: self.assertNotIn(secret.encode(), bundle.read(name))
                for item in json.loads(bundle.read("personal-agent/SOURCE_MANIFEST.json")):
                    content = bundle.read("personal-agent/" + item["path"])
                    self.assertEqual(hashlib.sha256(content).hexdigest(), item["sha256"])
                    self.assertEqual(len(content), item["bytes"])
                self.assertTrue((bundle.getinfo("personal-agent/scripts/pa.sh").external_attr >> 16) & 0o111)
                bundle.extractall(Path(temporary) / "recipient")
            recipient = Path(temporary) / "recipient/personal-agent"
            configure(recipient)
            self.assertEqual(load_config(recipient)["owner"], "用户")
            self.assertEqual(load_config(recipient)["im"]["allow_from"], [])
            self.assertFalse((recipient / ".runtime/connection-companion.json").exists())
            self.assertEqual(load_config(root)["owner"], secret)

    def test_deployment_values_are_rendered_only_to_private_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_framework(root)
            with self.assertRaises(ValueError): render_deployment(root)
            config = root / ".runtime/deployment.json"
            cfg = json.loads(config.read_text())
            cfg.update(install_dir="/srv/fixture-agent", public_host="fixture.example", public_port=4101, web_port=4102, dsh_port=4103, service_user="fixture", node_command="/opt/node/bin/node")
            config.write_text(json.dumps(cfg))
            self.assertEqual(len(render_deployment(root)), 4)
            nginx = (root / ".runtime/deployment/nginx.conf").read_text()
            service = (root / ".runtime/deployment/xiaoman-web.service").read_text()
            self.assertIn("listen 4101;", nginx)
            self.assertIn("127.0.0.1:4102", nginx)
            self.assertIn("PA_WEB_ORIGIN=http://fixture.example:4101", service)
            self.assertIn("ExecStart=/opt/node/bin/node /srv/fixture-agent/current/scripts/webui.mjs", service)
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(config, list(source_files(root)))
            tls = dict(cfg, tls_certificate="/srv/tls/fullchain.pem", tls_certificate_key="/srv/tls/private.key")
            config.write_text(json.dumps(tls))
            render_deployment(root)
            secure_nginx = (root / ".runtime/deployment/nginx.conf").read_text()
            self.assertIn("listen 4101 ssl;", secure_nginx)
            self.assertIn("ssl_certificate /srv/tls/fullchain.pem;", secure_nginx)
            self.assertIn("PA_WEB_ORIGIN=https://fixture.example:4101", (root / ".runtime/deployment/xiaoman-web.service").read_text())
            for invalid in (dict(cfg, tls_certificate="/srv/tls/cert"), dict(tls, tls_certificate_key="/srv/../key"), dict(tls, tls_certificate="/srv/cert;return 200;")):
                with self.assertRaises(ValueError): validate_deployment(invalid)
            for key, value in (("public_host", "host; injected"), ("install_dir", "/srv/../private"), ("service_user", "user\nroot"), ("web_port", 4101)):
                with self.subTest(key=key), self.assertRaises(ValueError): validate_deployment(dict(cfg, **{key: value}))

    def test_custom_intent_endpoint_does_not_reuse_existing_provider_key(self):
        import intent_route
        with patch.object(intent_route, "API", "https://model.example/v1/chat/completions"), patch.dict(
                "os.environ", {"DEEPSEEK_API_KEY": "provider-only"}, clear=True), patch.object(Path, "read_text") as read:
            self.assertIsNone(intent_route.load_key())
            read.assert_not_called()
            with patch.dict("os.environ", {"INTENT_API_KEY": "explicit-key"}):
                self.assertEqual(intent_route.load_key(), "explicit-key")


if __name__ == "__main__":
    unittest.main()
