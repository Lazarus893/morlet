"""Optional existing-source registration; all CLI checks are fakes, no network."""
import fcntl
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('existing_sources', ROOT / 'scripts/configure-existing-sources.py')
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class ExistingSourcesConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='existing sources ')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.target = self.root / 'independent instance'
        self.runtime = self.target / '.runtime'
        self.runtime.mkdir(parents=True, mode=0o700)
        self.state = {'version': 1, 'target': str(self.target), 'steps': {'configuration': 'done'}}
        self.write('setup-state.json', self.state)
        self.write('pa.json', {'version': 1, 'agent': {'provider': 'codex'}})
        self.gog = self.root / 'existing-gog'
        self.gh = self.root / 'existing-gh'
        for path in [self.gog, self.gh]:
            path.write_text('#!/bin/sh\nexit 99\n')
            path.chmod(0o700)
        self.accounts = [{'email': 'Owner@example.test', 'valid': True, 'services': ['gmail', 'drive', 'calendar'],
                          'scopes': ['https://www.googleapis.com/auth/' + name + '.readonly' for name in ['gmail', 'drive', 'calendar']],
                          'refresh_token': 'never-copy-private-token'}]
        self.calls = []

    def write(self, name, value):
        path = self.runtime / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return path

    def runner(self, command, **options):
        self.calls.append((command, options))
        if command[0] == str(self.gog):
            return SimpleNamespace(returncode=0, stdout=json.dumps({'accounts': self.accounts}), stderr='private stderr not exposed')
        if command[0] == str(self.gh):
            return SimpleNamespace(returncode=0, stdout='ExistingOwner\n', stderr='')
        self.fail('No unexpected CLI or real network operation is allowed')

    def configure(self, **options):
        return sources.configure_sources(self.target, gog_command=str(self.gog) if options.get('reuse_google') else None,
                                         gh_command=str(self.gh) if options.get('reuse_github') else None,
                                         runner=self.runner, **options)

    def test_reuses_only_checked_identities_and_supported_services_without_credentials_or_stdout_identifiers(self):
        result = self.configure(reuse_google=True, reuse_github=True)
        profile = json.loads((self.runtime / 'local-sources.json').read_text())
        self.assertEqual(profile, {'version': 1, 'google': {'account': 'owner@example.test', 'command': str(self.gog), 'services': ['calendar', 'gmail', 'drive']},
                                   'github': {'account': 'ExistingOwner', 'command': str(self.gh)}})
        self.assertEqual((self.runtime / 'local-sources.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.calls[0][0][1:], ['auth', 'list', '--check', '--json', '--no-input', '--timeout=8s'])
        self.assertEqual(self.calls[1][0][1:], ['api', 'user', '--hostname', 'github.com', '--jq', '.login'])
        self.assertEqual(self.calls[0][1]['timeout'], 12)
        serialized = json.dumps(result)
        for private in ['owner@example.test', 'ExistingOwner', str(self.target), str(self.gog), 'never-copy-private-token']:
            self.assertNotIn(private, serialized)
        self.assertNotIn('never-copy-private-token', json.dumps(profile))
        self.assertEqual(result['config'], '.runtime/local-sources.json')
        self.assertIn('mail_read', result['capabilities']['actions'])

    def test_multiple_accounts_need_explicit_selection_and_expired_accounts_are_not_reused(self):
        self.accounts += [{'email': 'Other@example.test', 'valid': True, 'services': ['calendar'], 'scopes': ['https://www.googleapis.com/auth/calendar.readonly']},
                          {'email': 'Expired@example.test', 'valid': False, 'services': ['gmail']}]
        with self.assertRaises(sources.SourceError) as error:
            self.configure(reuse_google=True)
        self.assertEqual(error.exception.code, 'GOOGLE_ACCOUNT_REQUIRED')
        self.assertFalse((self.runtime / 'local-sources.json').exists())
        result = self.configure(reuse_google=True, google_account='OTHER@example.test')
        self.assertEqual(result['capabilities']['googleServices'], ['calendar'])
        self.assertNotIn('mail_read', result['capabilities']['actions'])
        with self.assertRaises(sources.SourceError) as error:
            self.configure(reuse_google=True, google_account='Expired@example.test', replace=True)
        self.assertEqual(error.exception.code, 'GOOGLE_ACCOUNT_UNAVAILABLE')

    def test_malformed_or_unchecked_google_identity_never_creates_a_profile(self):
        for row in [{'email': 'owner@example.test', 'services': ['gmail']},
                    {'email': 'owner@example.test', 'valid': 'true', 'services': ['gmail']},
                    {'email': 'owner@example.test', 'valid': True, 'services': [123]},
                    {'email': '-unsafe@example.test', 'valid': True, 'services': ['gmail']}]:
            self.accounts = [row]
            with self.subTest(row=row), self.assertRaises(sources.SourceError):
                self.configure(reuse_google=True)
            self.assertFalse((self.runtime / 'local-sources.json').exists())

    def test_idempotent_registration_preserves_bytes_and_mtime_and_differences_need_explicit_replace(self):
        self.configure(reuse_google=True)
        path = self.runtime / 'local-sources.json'
        before = (path.read_bytes(), path.stat().st_mtime_ns)
        self.assertFalse(self.configure(reuse_google=True)['changed'])
        self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before)
        with self.assertRaises(sources.SourceError) as error:
            self.configure(reuse_github=True)
        self.assertEqual(error.exception.code, 'REPLACE_REQUIRED')
        self.assertEqual(path.read_bytes(), before[0])
        self.assertTrue(self.configure(reuse_github=True, replace=True)['changed'])
        self.assertNotIn('google', json.loads(path.read_text()))

    def test_common_folders_register_only_downloads_and_documents_without_reading_any_file(self):
        home = self.root / 'home'
        for name in ['Downloads', 'Documents']:
            directory = home / name
            directory.mkdir(parents=True)
            (directory / 'private-content.txt').write_text('must-not-read-private-body')
        extra = self.root / 'chosen folder'
        extra.mkdir()
        with patch.object(sources.Path, 'home', return_value=home):
            result = self.configure(common_folders=True, roots=[('chosen', '用户指定', str(extra))])
        profile = json.loads((self.runtime / 'local-sources.json').read_text())
        self.assertEqual([entry['id'] for entry in profile['roots']], ['chosen', 'documents', 'downloads'])
        self.assertEqual(result['capabilities']['folderCount'], 3)
        self.assertNotIn('must-not-read-private-body', json.dumps(profile))
        self.assertNotIn(str(home), json.dumps(result))
        self.assertEqual(self.calls, [])

    def test_missing_instance_or_unsafe_private_state_refuses_all_source_checks_and_writes(self):
        unknown = self.root / 'not-installed'
        unknown.mkdir()
        with self.assertRaises(sources.SourceError):
            sources.configure_sources(unknown, reuse_google=True, runner=self.runner)
        self.assertFalse((unknown / '.runtime').exists())
        state = self.runtime / 'setup-state.json'
        state.chmod(0o644)
        with self.assertRaises(sources.SourceError):
            self.configure(reuse_google=True)
        self.assertEqual(self.calls, [])
        state.chmod(0o600)
        self.write('setup-state.json', {**self.state, 'target': str(unknown)})
        with self.assertRaises(sources.SourceError):
            self.configure(reuse_google=True)
        self.assertEqual(self.calls, [])

    def test_symlink_profile_permissive_mode_oversize_and_unknown_fields_are_never_overwritten_even_with_replace(self):
        profile = self.runtime / 'local-sources.json'
        outside = self.root / 'keep-private.json'
        outside.write_text('{"keep":"original"}')
        outside.chmod(0o600)
        profile.symlink_to(outside)
        with self.assertRaises(sources.SourceError):
            self.configure(reuse_github=True, replace=True)
        self.assertEqual(outside.read_text(), '{"keep":"original"}')
        profile.unlink()
        for contents, mode in [('{}', 0o644), (' ' * 16385, 0o600),
                               (json.dumps({'version': 1, 'token': 'not-allowed'}), 0o600)]:
            profile.write_text(contents)
            profile.chmod(mode)
            with self.subTest(mode=mode, bytes=len(contents)), self.assertRaises(sources.SourceError):
                self.configure(reuse_github=True, replace=True)
            self.assertEqual(profile.read_text(), contents)

    def test_root_symlinks_duplicates_relative_paths_and_excess_scope_are_refused(self):
        directory = self.root / 'allowed'
        directory.mkdir()
        link = self.root / 'linked'
        link.symlink_to(directory, target_is_directory=True)
        for roots in [[('link', '链接目录', str(link))], [('relative', '相对目录', 'relative')],
                      [('same', '一', str(directory)), ('same', '二', str(directory))],
                      [(f'root{i}', '目录', str(directory)) for i in range(17)]]:
            with self.subTest(roots=len(roots)), self.assertRaises(sources.SourceError):
                self.configure(roots=roots)
        self.assertFalse((self.runtime / 'local-sources.json').exists())

    def test_failed_auth_checks_are_sanitized_and_do_not_start_login_or_change_configuration(self):
        def failed(command, **kwargs):
            self.calls.append(command)
            return SimpleNamespace(returncode=1, stdout='owner@example.test', stderr='private-token-do-not-print')
        with self.assertRaises(sources.SourceError) as error:
            sources.configure_sources(self.target, reuse_google=True, gog_command=str(self.gog), runner=failed)
        for private in ['owner@example.test', 'private-token-do-not-print', str(self.target)]:
            self.assertNotIn(private, str(error.exception))
        self.assertFalse(any('login' in command or 'add' in command for command in self.calls))
        self.assertFalse((self.runtime / 'local-sources.json').exists())

    def test_concurrent_profile_writer_is_refused_without_changing_existing_data(self):
        self.configure(reuse_github=True)
        path = self.runtime / 'local-sources.json'
        before = path.read_bytes()
        with (self.runtime / 'local-sources.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(sources.SourceError) as error:
                self.configure(reuse_github=True)
        self.assertEqual(error.exception.code, 'CONFIG_BUSY')
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(list(self.runtime.glob('.local-sources-*')))

    def test_all_six_existing_google_services_require_real_scopes_and_enable_only_read_operations(self):
        self.accounts[0]['services'] = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts']
        self.accounts[0]['scopes'] = ['https://www.googleapis.com/auth/' + name + '.readonly'
                                      for name in ['gmail', 'calendar', 'drive', 'documents', 'spreadsheets', 'contacts']]
        result = self.configure(reuse_google=True)
        profile = json.loads((self.runtime / 'local-sources.json').read_text())
        self.assertEqual(profile['google']['services'], ['calendar', 'gmail', 'drive', 'docs', 'sheets', 'contacts'])
        self.assertTrue({'drive_recent', 'drive_search', 'drive_metadata', 'docs_read', 'sheets_metadata', 'sheets_read', 'contacts_search'} <= set(result['capabilities']['actions']))
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn('scopes', profile['google'])
        for forbidden in ['send', 'create', 'update', 'append', 'delete', 'export']:
            self.assertFalse(any(forbidden in operation for operation in result['capabilities']['actions']))

    def test_service_labels_without_matching_scopes_are_never_registered_as_readable(self):
        self.accounts[0]['services'] = ['drive', 'docs', 'sheets', 'contacts']
        self.accounts[0]['scopes'] = ['https://www.googleapis.com/auth/drive.readonly']
        result = self.configure(reuse_google=True)
        self.assertEqual(result['capabilities']['googleServices'], ['drive'])
        self.assertNotIn('docs_read', result['capabilities']['actions'])
        self.assertNotIn('sheets_read', result['capabilities']['actions'])
        self.assertNotIn('contacts_search', result['capabilities']['actions'])
        self.accounts[0]['scopes'] = []
        before = (self.runtime / 'local-sources.json').read_bytes()
        with self.assertRaises(sources.SourceError) as error:
            self.configure(reuse_google=True, replace=True)
        self.assertEqual(error.exception.code, 'GOOGLE_SCOPE_MISSING')
        self.assertEqual((self.runtime / 'local-sources.json').read_bytes(), before)

    def test_optional_source_summary_includes_existing_github_and_bounded_file_search_actions(self):
        directory = self.root / 'notes'
        directory.mkdir()
        result = self.configure(reuse_github=True, roots=[('notes', '生活资料', str(directory))])
        self.assertTrue({'review_requests', 'github_repositories', 'github_updates', 'recent_files', 'file_search', 'file_read'} <= set(result['capabilities']['actions']))
        self.assertNotIn(str(directory), json.dumps(result))


if __name__ == '__main__':
    unittest.main()
