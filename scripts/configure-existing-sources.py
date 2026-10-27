#!/usr/bin/env python3
"""Register explicitly requested, existing local read sources for one Xiaoman instance."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

LIMIT = 16384
PROFILE = '.runtime/local-sources.json'
EMAIL = re.compile(r'^[^\s@<>-][^\s@<>]*@[^\s@<>]+\.[^\s@<>]+$')
LOGIN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}$')
IDENTIFIER = re.compile(r'^[a-z][a-z0-9_-]{0,63}$')
GOOGLE_SCOPES = {
    'calendar': {'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'},
    'gmail': {'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'},
    'drive': {'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive'},
    'docs': {'https://www.googleapis.com/auth/documents.readonly', 'https://www.googleapis.com/auth/documents'},
    'sheets': {'https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/spreadsheets'},
    'contacts': {'https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/contacts'},
}


class SourceError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise SourceError(code, message)


def no_symlinks(path):
    path = Path(path).expanduser().absolute()
    aliases = {Path('/var'): Path('/private/var'), Path('/tmp'): Path('/private/tmp')}
    for part in (path, *path.parents):
        if part.is_symlink() and (part not in aliases or part.resolve() != aliases[part]):
            fail('SYMLINK_FORBIDDEN', 'Choose a real local directory; symbolic links are not followed.')
    return path.resolve()


def private_file(path):
    """Read a bounded, same-owner 0600 regular file without following links."""
    try:
        before = path.lstat()
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or
                stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > LIMIT):
            fail('PRIVATE_CONFIG_REQUIRED', 'Instance configuration must be private, bounded and owned by the current user.')
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as source:
            after = os.fstat(source.fileno())
            if (after.st_ino != before.st_ino or after.st_dev != before.st_dev or
                    not stat.S_ISREG(after.st_mode) or after.st_uid != os.getuid() or
                    stat.S_IMODE(after.st_mode) != 0o600 or after.st_size > LIMIT):
                fail('PRIVATE_CONFIG_REQUIRED', 'Instance configuration changed while being opened.')
            raw = source.read(LIMIT + 1)
        if len(raw) > LIMIT:
            fail('CONFIG_TOO_LARGE', 'Instance configuration exceeds the supported size.')
        return json.loads(raw)
    except SourceError:
        raise
    except (OSError, ValueError, UnicodeError):
        fail('INSTANCE_CONFIG_UNAVAILABLE', 'Could not read the private instance configuration; no source profile was changed.')


def installed_target(target):
    target = no_symlinks(target)
    runtime = target / '.runtime'
    try:
        info = runtime.lstat()
    except OSError:
        fail('INSTANCE_REQUIRED', 'Choose an installed independent Xiaoman instance.')
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
        fail('PRIVATE_CONFIG_REQUIRED', 'The instance runtime must be a private directory owned by the current user.')
    state, pa = private_file(runtime / 'setup-state.json'), private_file(runtime / 'pa.json')
    if (not isinstance(state, dict) or type(state.get('version')) is not int or state.get('version') != 1 or state.get('target') != str(target) or
            not isinstance(state.get('steps'), dict) or state['steps'].get('configuration') != 'done' or
            not isinstance(pa, dict) or type(pa.get('version')) is not int or pa.get('version') != 1 or
            not isinstance(pa.get('agent'), dict) or pa['agent'].get('provider') not in {'codex', 'workbuddy'}):
        fail('INSTANCE_REQUIRED', 'Finish this independent local-Agent installation before registering optional sources.')
    return target


def executable(value, default):
    name = default if value is None else value
    if not isinstance(name, str) or not name.strip() or len(name) > 4096 or any(c in name for c in '\r\n\0'):
        fail('INVALID_COMMAND', 'Select one existing executable, without extra arguments.')
    selected = shutil.which(os.path.expanduser(name))
    if not selected:
        fail('TOOL_MISSING', 'The requested existing source CLI is not installed or executable.')
    return str(Path(selected).resolve())


def run_read(runner, command, arguments):
    try:
        result = runner([command, *arguments], capture_output=True, text=True, timeout=12, check=False)
    except (OSError, subprocess.SubprocessError):
        fail('SOURCE_CHECK_FAILED', 'The existing source could not be checked; no login or authorization was started.')
    if result.returncode != 0 or not isinstance(result.stdout, str) or len(result.stdout.encode('utf-8')) > 512000:
        fail('SOURCE_CHECK_FAILED', 'The existing source could not be checked; inspect its local CLI before retrying.')
    return result.stdout


def google_profile(runner, command, account):
    if account is not None and (not isinstance(account, str) or len(account) > 254 or not EMAIL.fullmatch(account)):
        fail('INVALID_GOOGLE_ACCOUNT', 'Choose an exact existing Google account.')
    raw = run_read(runner, command, ['auth', 'list', '--check', '--json', '--no-input', '--timeout=8s'])
    try:
        data = json.loads(raw)
    except ValueError:
        fail('INVALID_GOOGLE_RESPONSE', 'The existing Google CLI returned an unsupported response.')
    if not isinstance(data, dict) or not isinstance(data.get('accounts'), list) or len(data['accounts']) > 100:
        fail('INVALID_GOOGLE_RESPONSE', 'The existing Google CLI returned an unsupported account list.')
    valid = []
    for row in data['accounts']:
        if not isinstance(row, dict) or type(row.get('valid')) is not bool:
            fail('INVALID_GOOGLE_RESPONSE', 'Google account validity was not verified by the existing CLI.')
        if not row['valid']:
            continue
        email, services, scopes = row.get('email'), row.get('services'), row.get('scopes')
        if (not isinstance(email, str) or len(email) > 254 or not EMAIL.fullmatch(email) or
                not isinstance(services, list) or len(services) > 100 or any(not isinstance(service, str) for service in services) or
                not isinstance(scopes, list) or len(scopes) > 100 or any(not isinstance(scope, str) for scope in scopes)):
            fail('INVALID_GOOGLE_RESPONSE', 'The existing Google account or granted services could not be verified.')
        if account is None or account.lower() == email.lower():
            valid.append(row)
    if not valid:
        fail('GOOGLE_ACCOUNT_UNAVAILABLE', 'No matching valid existing Google login was found; this command does not start OAuth.')
    if len(valid) != 1:
        fail('GOOGLE_ACCOUNT_REQUIRED', 'More than one existing Google login is available; select one with --google-account.')
    row = valid[0]
    services = [name for name, scopes in GOOGLE_SCOPES.items() if name in row['services'] and scopes.intersection(row['scopes'])]
    if not services:
        fail('GOOGLE_SCOPE_MISSING', 'No supported existing read scope was verified; this command does not request authorization.')
    return {'account': row['email'].lower(), 'command': command, 'services': services}


def github_profile(runner, command):
    # Fix the host to match the GitHub adapter; never switch gh's active account.
    login = run_read(runner, command, ['api', 'user', '--hostname', 'github.com', '--jq', '.login']).strip()
    if not LOGIN.fullmatch(login):
        fail('INVALID_GITHUB_RESPONSE', 'The current GitHub identity could not be verified.')
    return {'account': login, 'command': command}


def root_profile(identity, label, path):
    if (not isinstance(identity, str) or not IDENTIFIER.fullmatch(identity) or not isinstance(label, str) or
            not label.strip() or len(label) > 80 or any(ord(c) < 32 or ord(c) == 127 for c in label)):
        fail('INVALID_ROOT', 'Source roots need a unique simple ID and a short readable label.')
    if (not isinstance(path, (str, Path)) or not str(path) or len(str(path)) > 4096 or
            any(ord(c) < 32 or ord(c) == 127 for c in str(path)) or not Path(path).expanduser().is_absolute()):
        fail('INVALID_ROOT', 'Select an explicit absolute local directory for each source root.')
    directory = no_symlinks(path)
    if not directory.is_dir():
        fail('ROOT_UNAVAILABLE', 'An explicitly requested source folder is unavailable; no file contents were scanned.')
    return {'id': identity, 'label': label.strip(), 'path': str(directory)}


def validate_profile(value):
    if (not isinstance(value, dict) or set(value) - {'version', 'google', 'github', 'roots'} or
            type(value.get('version')) is not int or value.get('version') != 1):
        fail('INVALID_PROFILE', 'The existing optional-source profile has an unsupported format.')
    google = value.get('google')
    if 'google' in value and (not isinstance(google, dict) or set(google) != {'account', 'command', 'services'} or
            not isinstance(google['account'], str) or len(google['account']) > 254 or not EMAIL.fullmatch(google['account']) or
            not isinstance(google['services'], list) or any(not isinstance(s, str) or s not in GOOGLE_SCOPES for s in google['services']) or
            len(set(google['services'])) != len(google['services'])):
        fail('INVALID_PROFILE', 'The existing Google source profile has an unsupported format.')
    github = value.get('github')
    if 'github' in value and (not isinstance(github, dict) or set(github) != {'account', 'command'} or
            not isinstance(github['account'], str) or not LOGIN.fullmatch(github['account'])):
        fail('INVALID_PROFILE', 'The existing GitHub source profile has an unsupported format.')
    for item in (google, github):
        if item is not None and (not isinstance(item.get('command'), str) or not Path(item['command']).is_absolute() or
                                len(item['command']) > 4096 or any(c in item['command'] for c in '\r\n\0')):
            fail('INVALID_PROFILE', 'The existing source executable must be an absolute path.')
    roots = value.get('roots', [])
    if not isinstance(roots, list) or len(roots) > 16:
        fail('INVALID_PROFILE', 'The optional-source profile supports at most 16 explicit folders.')
    identities = []
    for entry in roots:
        if not isinstance(entry, dict) or set(entry) != {'id', 'label', 'path'}:
            fail('INVALID_PROFILE', 'The existing folder source has an unsupported format.')
        # Existing profile validation does not enumerate or reopen private roots.
        if (not isinstance(entry['id'], str) or not IDENTIFIER.fullmatch(entry['id']) or
                not isinstance(entry['label'], str) or not entry['label'].strip() or len(entry['label']) > 80 or
                any(ord(c) < 32 or ord(c) == 127 for c in entry['label']) or
                not isinstance(entry['path'], str) or not Path(entry['path']).is_absolute() or
                len(entry['path']) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in entry['path'])):
            fail('INVALID_PROFILE', 'The existing folder source has an unsupported format.')
        identities.append(entry['id'])
    if len(set(identities)) != len(identities):
        fail('INVALID_ROOT', 'Each optional folder source must have a unique ID.')
    return value


def atomic_profile(path, value):
    encoded = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode()
    if len(encoded) > LIMIT:
        fail('CONFIG_TOO_LARGE', 'The optional-source profile exceeds 16 KiB.')
    descriptor, name = tempfile.mkstemp(prefix='.local-sources-', dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(encoded)
            output.flush(); os.fsync(output.fileno())
        Path(name).replace(path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(name).unlink(missing_ok=True)


def configure_sources(target, *, reuse_google=False, google_account=None, reuse_github=False,
                      common_folders=False, roots=(), gog_command=None, gh_command=None,
                      replace=False, runner=subprocess.run):
    target = installed_target(target)
    if (google_account is not None or gog_command is not None) and not reuse_google or gh_command is not None and not reuse_github:
        fail('INVALID_OPTIONS', 'Account and executable options require the corresponding explicit reuse flag.')
    if not (reuse_google or reuse_github or common_folders or roots):
        fail('SOURCE_SELECTION_REQUIRED', 'Explicitly select at least one optional existing source.')
    profile = {'version': 1}
    if reuse_google:
        profile['google'] = google_profile(runner, executable(gog_command, 'gog'), google_account)
    if reuse_github:
        profile['github'] = github_profile(runner, executable(gh_command, 'gh'))
    requested = list(roots)
    if common_folders:
        requested = [('downloads', '下载', Path.home() / 'Downloads'), ('documents', '文档', Path.home() / 'Documents'), *requested]
    if requested:
        if len(requested) > 16:
            fail('INVALID_ROOT', 'At most 16 explicit local folders can be registered.')
        if any(not isinstance(entry, (tuple, list)) or len(entry) != 3 for entry in requested):
            fail('INVALID_ROOT', 'Each explicit folder needs an ID, label and local path.')
        profile['roots'] = sorted([root_profile(*entry) for entry in requested], key=lambda entry: entry['id'])
    validate_profile(profile)
    path = target / PROFILE
    lock = path.parent / 'local-sources.lock'
    try:
        descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'a') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                fail('PRIVATE_CONFIG_REQUIRED', 'The optional-source lock must be a private same-owner regular file.')
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fail('CONFIG_BUSY', 'Another process is configuring optional sources for this instance.')
            # Revalidate the instance after authentication checks and under lock.
            installed_target(target)
            existing = validate_profile(private_file(path)) if path.exists() or path.is_symlink() else None
            changed = existing != profile
            if existing is not None and changed and not replace:
                fail('REPLACE_REQUIRED', 'A different optional-source profile exists; inspect it privately and use --replace to change it.')
            if changed:
                atomic_profile(path, profile)
    except SourceError:
        raise
    except OSError:
        fail('CONFIG_WRITE_FAILED', 'Could not safely write optional-source configuration; inspect the private instance and retry.')
    actions = ['list']
    if 'calendar' in profile.get('google', {}).get('services', []):
        actions.append('calendar_events')
    if 'gmail' in profile.get('google', {}).get('services', []):
        actions.extend(['mail_search', 'mail_read'])
    for service, operations in [('drive', ['drive_recent', 'drive_search', 'drive_metadata']), ('docs', ['docs_read']),
                                ('sheets', ['sheets_metadata', 'sheets_read']), ('contacts', ['contacts_search'])]:
        if service in profile.get('google', {}).get('services', []):
            actions.extend(operations)
    if profile.get('github'):
        actions.extend(['review_requests', 'github_repositories', 'github_updates'])
    if profile.get('roots'):
        actions.extend(['recent_files', 'file_search', 'file_read'])
    return {'configured': True, 'changed': changed, 'config': PROFILE,
            'capabilities': {'actions': actions, 'googleServices': profile.get('google', {}).get('services', []),
                             'github': 'github' in profile, 'folderCount': len(profile.get('roots', []))},
            'note': 'Existing logins were checked and folder scopes registered. No file bodies were scanned, no OAuth was started, and no requested business action was completed.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--reuse-google', action='store_true')
    parser.add_argument('--google-account')
    parser.add_argument('--gog-command')
    parser.add_argument('--reuse-github', action='store_true')
    parser.add_argument('--gh-command')
    parser.add_argument('--common-folders', action='store_true')
    parser.add_argument('--root', nargs=3, action='append', metavar=('ID', 'LABEL', 'PATH'), default=[])
    parser.add_argument('--replace', action='store_true')
    args = parser.parse_args(argv)
    return configure_sources(args.target, reuse_google=args.reuse_google, google_account=args.google_account,
                             gog_command=args.gog_command, reuse_github=args.reuse_github, gh_command=args.gh_command,
                             common_folders=args.common_folders, roots=args.root, replace=args.replace)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False, indent=2))
    except SourceError as error:
        print(json.dumps({'ok': False, 'code': error.code, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, UnicodeError):
        print(json.dumps({'ok': False, 'code': 'SOURCE_CONFIG_FAILED',
                          'error': 'Optional-source configuration failed; retain the instance and inspect its private local state.'}), file=sys.stderr)
        sys.exit(1)
