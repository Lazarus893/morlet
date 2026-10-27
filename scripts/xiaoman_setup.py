#!/usr/bin/env python3
"""Install one private Xiaoman instance using an existing local Agent login.

Standard library only: this file can run directly from the distributed skill.
It never imports the user's Agent configuration or copies its credentials.
"""
import argparse
import contextlib
import fcntl
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import unicodedata
import zipfile

VERSION = 1
MAX_BYTES = 100 * 1024 * 1024
FORBIDDEN = {'.runtime', '.git', '.venv', 'node_modules', 'memory', '_temp', '__pycache__',
             '.gradle', 'build', 'local.properties', '.DS_Store', '.credentials.yaml',
             'local-skills', 'personalization'}


class SetupError(ValueError):
    def __init__(self, message, *, code=None):
        super().__init__(message)
        self.code = code


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.setup-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        Path(name).replace(path)
        path.chmod(0o600)
    finally:
        Path(name).unlink(missing_ok=True)


def relative_path(name):
    if not isinstance(name, str) or not name or '\\' in name or any(ord(c) < 32 for c in name):
        raise SetupError('Invalid archive path')
    path = PurePosixPath(name)
    if path.is_absolute() or path.as_posix() != name or any(p in {'', '.', '..'} for p in path.parts):
        raise SetupError('Invalid archive path')
    if any(p in FORBIDDEN or (p.startswith('.env') and p != '.env.example') for p in path.parts):
        raise SetupError('Private files are not allowed in the framework')
    if path.parts[0] == 'dist':
        raise SetupError('Generated distribution outputs cannot be framework sources')
    if path.suffix in {'.pyc', '.log', '.jks', '.keystore', '.db', '.sqlite', '.sqlite3'} or '.local.' in path.name:
        raise SetupError('Private or generated file types are not allowed')
    return path


def verified_entries(entries):
    """Verify hashes AND the explicit product allowlist, with no extra payloads."""
    manifest_bytes = entries.get('SOURCE_MANIFEST.json', (b'', 0))[0]
    try:
        manifest = json.loads(manifest_bytes)
        distribution = json.loads(entries['config/distribution.json'][0])
    except (ValueError, KeyError, UnicodeError):
        raise SetupError('Framework manifests are missing or invalid') from None
    if not isinstance(manifest, list) or distribution.get('version') != 1:
        raise SetupError('Invalid framework manifest')
    names = distribution.get('files')
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names) or len(names) != len(set(names)):
        raise SetupError('Invalid explicit distribution allowlist')
    rows = {}
    for row in manifest:
        if not isinstance(row, dict) or set(row) != {'path', 'bytes', 'sha256'}:
            raise SetupError('Invalid source manifest entry')
        name = row['path']
        relative_path(name)
        if name in rows or type(row['bytes']) is not int or row['bytes'] < 0 or not re.fullmatch(r'[0-9a-f]{64}', str(row['sha256'])):
            raise SetupError('Invalid source manifest entry')
        rows[name] = row
    if set(rows) != set(names) or 'config/distribution.json' not in rows or set(entries) != set(rows) | {'SOURCE_MANIFEST.json'}:
        raise SetupError('Framework does not match its explicit allowlist')
    canonical_names = [unicodedata.normalize('NFC', name).casefold() for name in entries]
    if len(canonical_names) != len(set(canonical_names)):
        raise SetupError('Framework paths collide on a macOS filesystem')
    for name, row in rows.items():
        data, mode = entries[name]
        if len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
            raise SetupError('Framework integrity check failed: ' + name)
        if stat.S_IFMT(mode) not in {0, stat.S_IFREG}:
            raise SetupError('Framework entries must be regular files')
    return entries


def read_archive(path):
    entries, total = {}, 0
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > 10000:
            raise SetupError('Framework has too many entries')
        for info in infos:
            path = relative_path(info.filename)
            if path.parts[0] != 'personal-agent' or len(path.parts) < 2 or info.is_dir():
                raise SetupError('Unexpected archive root or directory entry')
            name = PurePosixPath(*path.parts[1:]).as_posix()
            if name in entries or stat.S_ISLNK(info.external_attr >> 16):
                raise SetupError('Duplicate or symbolic archive entry')
            total += info.file_size
            if total > MAX_BYTES or info.file_size > MAX_BYTES:
                raise SetupError('Framework archive is too large')
            entries[name] = (archive.read(info), info.external_attr >> 16)
    return verified_entries(entries)


def read_source(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise SetupError('Source must be a real, clean framework directory')
    # Never traverse an author's checkout or private runtime, even if unlisted.
    entries, total = {}, 0
    for path in root.rglob('*'):
        if path.is_symlink():
            raise SetupError('Source directory must not contain symlinks')
        if path.is_file():
            name = path.relative_to(root).as_posix()
            relative_path(name)
            total += path.stat().st_size
            if total > MAX_BYTES or len(entries) >= 10000:
                raise SetupError('Framework source is too large')
            entries[name] = (path.read_bytes(), path.stat().st_mode)
    return verified_entries(entries)


def source_digest(entries):
    return hashlib.sha256(entries['SOURCE_MANIFEST.json'][0]).hexdigest()


def resolve_agent(provider, command=None):
    if provider not in {'codex', 'workbuddy'}:
        raise SetupError('Only existing Codex and WorkBuddy installations are supported')
    if command is not None and (not command.strip() or any(c in command for c in ('\x00', '\n', '\r'))):
        raise SetupError('Agent command must be one executable path, without arguments')
    choices = [command] if command else (['codex'] if provider == 'codex' else ['codebuddy', 'cbc'])
    for name in choices:
        resolved = shutil.which(os.path.expanduser(name))
        if resolved:
            return str(Path(resolved).resolve())
    if not command and provider == 'workbuddy':
        bundled = Path('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy')
        if bundled.is_file() and os.access(bundled, os.X_OK):
            return str(bundled)
    raise SetupError('Existing Agent CLI not found; install or select its executable first')


def preflight(provider, command=None):
    if sys.version_info < (3, 12):
        raise SetupError('Python 3.12 or newer is required (Octop Memory)')
    if sys.platform != 'darwin':
        raise SetupError('This installer currently supports macOS only')
    node, npm = shutil.which('node'), shutil.which('npm')
    if not node or not npm:
        raise SetupError('Install Node.js 22.19 or newer with npm first')
    try:
        result = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=10, check=True)
        match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)\s*', result.stdout)
        if not match or tuple(map(int, match.groups())) < (22, 19, 0):
            raise SetupError('Node.js 22.19 or newer is required')
    except (OSError, subprocess.SubprocessError):
        raise SetupError('Could not run the installed Node.js') from None
    agent = resolve_agent(provider, command)
    return {'platform': 'macOS', 'python': sys.executable, 'node': node, 'npm': npm,
            'provider': provider, 'agentCommand': agent, 'agentLogin': 'not_verified',
            'note': 'Executable discovery is not a login or model-execution check.'}


def validate_target(target):
    raw = Path(target).expanduser().absolute()
    for path in (raw, *raw.parents):
        if path.is_symlink():
            # macOS exposes its standard temporary directories through these
            # operating-system aliases. User-created symlinks remain forbidden.
            system_aliases = {Path('/var'): Path('/private/var'), Path('/tmp'): Path('/private/tmp')}
            if path not in system_aliases or path.resolve() != system_aliases[path]:
                raise SetupError('Installation target and parents must not be symlinks')
    canonical = raw.resolve()
    if canonical == Path.home().resolve() or canonical == Path(canonical.anchor):
        raise SetupError('Choose a dedicated installation directory')
    return canonical


def state_path(target):
    return target / '.runtime/setup-state.json'


def load_state(target):
    path = state_path(target)
    if path.parent.is_symlink() or path.is_symlink() or not path.is_file():
        raise SetupError('No resumable Xiaoman installation at this target')
    state = json.loads(path.read_text())
    if not isinstance(state, dict) or state.get('version') != VERSION or state.get('target') != str(target):
        raise SetupError('Setup state belongs to another installation')
    if (state.get('provider') not in {'codex', 'workbuddy'} or not isinstance(state.get('agentCommand'), str) or
            not state['agentCommand'] or any(c in state['agentCommand'] for c in '\x00\r\n') or
            type(state.get('port')) is not int or type(state.get('runtimePort')) is not int or
            not 1024 <= state['port'] <= 65535 or not 1024 <= state['runtimePort'] <= 65535 or
            state['port'] == state['runtimePort'] or not isinstance(state.get('steps'), dict) or
            any((name not in {'source', 'dependencies', 'configuration', 'agent-check', 'pet-dependencies', 'start'} and
                 re.fullmatch(r'sources-[0-9a-f]{16}', name) is None) or
                value not in {'done', 'running', 'failed', 'stopped'} for name, value in state['steps'].items()) or
            state['steps'].get('source') != 'done' or
            not re.fullmatch('[0-9a-f]{64}', str(state.get('sourceDigest', '')))):
        raise SetupError('Setup state is damaged; retain this directory and inspect its private evidence')
    return state


def new_install(target, entries, provider, command, port, runtime_port=None):
    target = validate_target(target)
    runtime_port = port + 1 if runtime_port is None else runtime_port
    if (type(port) is not int or type(runtime_port) is not int or not 1024 <= port <= 65535 or
            not 1024 <= runtime_port <= 65535 or port == runtime_port):
        raise SetupError('Web and runtime ports must be distinct integers from 1024 to 65535')
    if target.exists() and any(target.iterdir()):
        raise SetupError('Target is not empty; use continue for its existing installation')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.xiaoman-install-', dir=target.parent) as temporary:
        staged = Path(temporary) / 'instance'
        staged.mkdir(mode=0o700)
        for name, (data, mode) in entries.items():
            path = staged / relative_path(name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o700 if mode & 0o111 else 0o600)
        state = {'version': VERSION, 'target': str(target), 'sourceDigest': source_digest(entries),
                 'provider': provider, 'agentCommand': command, 'port': port, 'runtimePort': runtime_port,
                 'steps': {'source': 'done'}, 'agentLogin': 'not_verified', 'createdAt': int(time.time())}
        private_json(state_path(staged), state)
        if target.exists():
            target.rmdir()  # Still empty; an existing instance is never merged or overwritten.
        staged.rename(target)
    return state


def run_step(target, state, name, commands):
    if state['steps'].get(name) == 'done':
        return
    state['steps'][name] = 'running'
    state.pop('failure', None)
    private_json(state_path(target), state)
    log = target / '.runtime/logs/setup' / (name + '.log')
    log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        with log.open('ab') as out:
            log.chmod(0o600)
            for command in commands:
                subprocess.run(command, cwd=target, stdout=out, stderr=out, check=True, timeout=1800,
                               env={**os.environ, 'OPENUI_TELEMETRY_DISABLED': '1'})
    except (OSError, subprocess.SubprocessError):
        state['steps'][name] = 'failed'
        state['failure'] = {'step': name, 'log': str(log), 'code': 'COMMAND_FAILED'}
        private_json(state_path(target), state)
        raise SetupError('Setup stopped at ' + name + '; private evidence: ' + str(log)) from None
    state['steps'][name] = 'done'
    private_json(state_path(target), state)


class LocalAPI:
    def __init__(self, port):
        self.origin = f'http://127.0.0.1:{port}'
        # Avoid proxy environment variables: the installer only talks to loopback.
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                                 urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf = None

    def connect(self):
        with self.client.open(self.origin + '/', timeout=10) as response:
            if response.status != 200:
                raise SetupError('Local Web UI did not start')
        data = self.request('/api/state')
        self.csrf = data['csrf']
        return data

    def request(self, path, value=None):
        headers = {'Accept': 'application/json'}
        data = None
        if value is not None:
            headers.update({'Content-Type': 'application/json', 'Origin': self.origin, 'X-PA-CSRF': self.csrf})
            data = json.dumps(value).encode()
        request = urllib.request.Request(self.origin + path, data=data, headers=headers)
        try:
            with self.client.open(request, timeout=60) as response:
                value = json.loads(response.read(2 * 1024 * 1024))
        except urllib.error.HTTPError as error:
            try:
                failure = json.loads(error.read(65536))
                code = failure.get('error') if isinstance(failure, dict) else None
            except (ValueError, OSError):
                code = None
            if not isinstance(code, str) or not re.fullmatch(r'[A-Z_]{3,80}', code):
                code = 'LOCAL_API_FAILED'
            raise SetupError('Local API refused operation: ' + code, code=code) from None
        if value.get('ok') is not True:
            code = value.get('error')
            if not isinstance(code, str) or not re.fullmatch(r'[A-Z_]{3,80}', code):
                code = 'LOCAL_API_FAILED'
            raise SetupError('Local API refused operation: ' + code, code=code)
        return value['data']


def owned_process(target, state):
    pid = state.get('webPid')
    if type(pid) is not int or pid <= 1:
        return False
    try:
        result = subprocess.run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'command='], capture_output=True,
                                text=True, check=True, timeout=5)
        # Exact argv rendering plus the per-instance script/port guard against PID
        # reuse; an arbitrary command merely mentioning this path is not owned.
        expected = state.get('webCommand')
        return (isinstance(expected, str) and
                expected.endswith(str(target / 'scripts/webui.mjs') + ' --port ' + str(state['port'])) and
                result.stdout.strip() == expected)
    except (OSError, subprocess.SubprocessError):
        return False


def process_exists(pid):
    # Signal 0 only probes existence. Permission errors are not proof of exit.
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def assert_free(port):
    with socket.socket() as sock:
        # Match Node's restart semantics: old closed connections may remain in
        # TIME_WAIT, while a live listener must still prevent a second service.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            raise SetupError(f'Port {port} is already in use; no existing service was touched') from None


def service_paths(target):
    label = 'com.xiaoman.web-' + hashlib.sha256(str(target.resolve()).encode()).hexdigest()[:20]
    directory = validate_target(Path.home() / 'Library/LaunchAgents')
    return label, directory / (label + '.plist'), f'gui/{os.getuid()}/{label}'


def has_service(target, state):
    _, path, _ = service_paths(target)
    return bool(state.get('service')) or path.exists() or path.is_symlink()


@contextlib.contextmanager
def service_lock(target):
    path = target / '.runtime/setup-service.lock'
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise SetupError('Service control requires a private same-owner lock file')
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('Another process is controlling this instance service') from None
        yield


def launchctl(arguments):
    try:
        return subprocess.run(['/bin/launchctl', *arguments], capture_output=True, text=True, timeout=35, check=False)
    except (OSError, subprocess.SubprocessError):
        raise SetupError('The macOS user service manager could not be reached') from None


def launch_action(arguments):
    if launchctl(arguments).returncode:
        raise SetupError('The macOS user service operation failed; private instance data was retained')


def service_definition(target, state, node):
    label, _, _ = service_paths(target)
    if not Path(node).is_absolute() or any(c in node for c in '\r\n\0'):
        raise SetupError('Choose an absolute Node.js executable for the user service')
    log = target / '.runtime/logs/setup/service.log'
    path = os.pathsep.join([str(target / '.venv/bin'), str(target / 'node_modules/.bin'),
                           str(Path(node).parent), os.environ.get('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')])
    return {'Label': label, 'ProgramArguments': [node, str(target / 'scripts/webui.mjs'), '--port', str(state['port'])],
            'WorkingDirectory': str(target), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 15,
            'ExitTimeOut': 25, 'ProcessType': 'Background',
            'EnvironmentVariables': {'PATH': path, 'PA_WEB_MANAGED': '1', 'PA_WEB_PORT': str(state['port']),
                                     'XIAOMAN_PORT': str(state['runtimePort'])},
            'StandardOutPath': str(log), 'StandardErrorPath': str(log)}


def read_service(target, state):
    label, path, _ = service_paths(target)
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536):
            raise SetupError('The instance LaunchAgent must be private, regular and owned by the current user')
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as source:
            opened = os.fstat(source.fileno())
            if opened.st_ino != info.st_ino or opened.st_dev != info.st_dev:
                raise SetupError('The instance LaunchAgent changed while being read')
            value = plistlib.loads(source.read(65537))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, plistlib.InvalidFileException):
        raise SetupError('The instance LaunchAgent could not be read safely') from None
    args = value.get('ProgramArguments') if isinstance(value, dict) else None
    env = value.get('EnvironmentVariables') if isinstance(value, dict) else None
    if (not isinstance(args, list) or len(args) != 4 or not isinstance(args[0], str) or not Path(args[0]).is_absolute() or
            any(c in args[0] for c in '\r\n\0') or args[1:] != [str(target / 'scripts/webui.mjs'), '--port', str(state['port'])] or
            value.get('Label') != label or value.get('WorkingDirectory') != str(target) or
            value.get('KeepAlive') is not True or value.get('RunAtLoad') is not True or
            not isinstance(env, dict) or set(env) != {'PATH', 'PA_WEB_MANAGED', 'PA_WEB_PORT', 'XIAOMAN_PORT'} or
            env.get('PA_WEB_MANAGED') != '1' or env.get('PA_WEB_PORT') != str(state['port']) or
            env.get('XIAOMAN_PORT') != str(state['runtimePort']) or not isinstance(env.get('PATH'), str) or
            len(env['PATH']) > 16000 or any(c in env['PATH'] for c in '\r\n\0')):
        raise SetupError('LaunchAgent identity does not match this instance; no other service was touched')
    log = str(target / '.runtime/logs/setup/service.log')
    if (set(value) != {'Label', 'ProgramArguments', 'WorkingDirectory', 'RunAtLoad', 'KeepAlive', 'ThrottleInterval',
                      'ExitTimeOut', 'ProcessType', 'EnvironmentVariables', 'StandardOutPath', 'StandardErrorPath'} or
            value.get('ThrottleInterval') != 15 or value.get('ExitTimeOut') != 25 or value.get('ProcessType') != 'Background' or
            value.get('StandardOutPath') != log or value.get('StandardErrorPath') != log):
        raise SetupError('LaunchAgent settings differ from the instance service contract')
    return value


def service_status(target, state):
    definition = read_service(target, state)
    if definition is None:
        return {'installed': False, 'loaded': False, 'running': False}
    label, path, identity = service_paths(target)
    result = launchctl(['print', identity])
    if result.returncode:
        if result.returncode not in {3, 113} and not re.search(r'could not find service|service not found', result.stderr or '', re.I):
            raise SetupError('Could not verify this instance LaunchAgent status')
        return {'installed': True, 'loaded': False, 'running': False, 'label': label}
    text = result.stdout
    if (not text.lstrip().startswith(identity + ' = {') or
            not re.search(r'^\s*path = ' + re.escape(str(path)) + r'\s*$', text, re.M) or
            not re.search(r'^\s*program = ' + re.escape(definition['ProgramArguments'][0]) + r'\s*$', text, re.M)):
        raise SetupError('Loaded user service does not match this instance LaunchAgent')
    found = re.search(r'^\s*pid = (\d+)\s*$', text, re.M)
    pid = int(found.group(1)) if found else None
    phase = re.search(r'^\s*state = ([^\n]+)', text, re.M)
    phase = phase.group(1).strip() if phase else 'unknown'
    running = False
    if pid:
        running = owned_process(target, dict(state, webPid=pid, webCommand=' '.join(definition['ProgramArguments'])))
        if not running:
            # During bootout macOS may show SIGTERMed + a live zombie PID whose
            # argv has already collapsed to "(node)". Wait briefly for reaping,
            # but never treat that text or the phase alone as ownership proof.
            for attempt in range(21 if phase == 'SIGTERMed' else 1):
                if not process_exists(pid):
                    break
                if phase != 'SIGTERMed' or attempt == 20:
                    raise SetupError('Loaded service PID does not belong to this instance Web process')
                time.sleep(0.05)
        # launchctl can briefly retain the exited PID while bootout is still
        # unloading the job. Keep loaded=True and let the stop loop wait; an
        # absent process is not an identity mismatch or proof of full shutdown.
    return {'installed': True, 'loaded': True, 'running': running, 'label': label,
            'phase': phase, **({'pid': pid} if pid else {})}


def verify_managed_snapshot(target, current):
    expected = hashlib.sha256(str(target.resolve()).encode()).hexdigest()[:20]
    if current.get('service', {}).get('instanceId') != expected:
        raise SetupError('The local Web response belongs to another or unsupported instance; no host operation was sent')
    if current.get('runtime', {}).get('managed') is not True:
        raise SetupError('The installed Web runtime does not support managed supervision; update this instance first')


def save_service_state(target, state, definition, desired):
    state['service'] = {'version': 1, 'label': definition['Label'], 'desired': desired}
    private_json(state_path(target), state)


def managed_operation(target, api, operation):
    """BUSY rejects before mutation; wait for the supervisor's current operation."""
    for attempt in range(80):
        verify_managed_snapshot(target, api.request('/api/state'))
        try:
            return api.request(operation, {})
        except SetupError as error:
            if error.code != 'BUSY' or attempt == 79:
                raise
        time.sleep(0.5)


def managed_start(target, state):
    definition = read_service(target, state)
    if definition is None:
        raise SetupError('Service definition is missing; run service-install to restore it')
    _, path, identity = service_paths(target)
    status = service_status(target, state)
    if not status['running']:
        assert_free(state['port'])
    launch_action(['enable', identity])
    if not status['loaded']:
        launch_action(['bootstrap', f'gui/{os.getuid()}', str(path)])
    elif not status['running']:
        launch_action(['kickstart', identity])
    save_service_state(target, state, definition, 'running')
    api, last = LocalAPI(state['port']), None
    for _ in range(120):
        try:
            status = service_status(target, state)
            if status['running']:
                state['webPid'] = status['pid']
                state['webCommand'] = ' '.join(definition['ProgramArguments'])
                private_json(state_path(target), state)
                current = api.connect()
        except (OSError, ValueError) as error:
            last = error
        else:
            if status['running']:
                verify_managed_snapshot(target, current)
                break
        time.sleep(0.25)
    else:
        raise SetupError('Managed Web did not become reachable; inspect .runtime/logs/setup/service.log') from last
    # This explicit owner operation clears a persisted manual runtime pause.
    try:
        managed_operation(target, api, '/api/start')
    except SetupError as error:
        # A verified host may still be opening its control socket after Web was
        # replaced. The supervisor keeps desired=running and owns recovery.
        if error.code != 'RUNTIME_CONTROL_UNAVAILABLE':
            raise
    for _ in range(90):
        current = api.request('/api/state')
        if current.get('runtime', {}).get('state') == 'running':
            state['steps']['start'] = 'done'
            state.pop('failure', None)
            private_json(state_path(target), state)
            return api
        time.sleep(0.5)
    raise SetupError('Managed Web is running but its WeChat host is unavailable; inspect the private service log')


def write_service(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix='.xiaoman-service-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as out:
            os.fchmod(out.fileno(), 0o600)
            out.write(plistlib.dumps(value)); out.flush(); os.fsync(out.fileno())
        Path(name).replace(path)
    finally:
        Path(name).unlink(missing_ok=True)


def prepare_service_log(target):
    log = target / '.runtime/logs/setup/service.log'
    validate_target(log.parent)
    log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(log, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise SetupError('The private service log must be a same-owner regular file')
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)


def existing_runtime_intent(target, status):
    """Observe Node's stop intent; only Node's owner API may change it."""
    if status['running']:
        try:
            current = LocalAPI(status['port']).connect()
        except OSError:
            pass
        else:
            verify_managed_snapshot(target, current)
            desired = current.get('service', {}).get('desired')
            if desired not in {'running', 'stopped'}:
                raise SetupError('The existing supervisor did not return a valid stop intent; its service was left unchanged')
            return desired
    path = target / '.runtime/web-service.json'
    try:
        before = path.lstat()
    except FileNotFoundError:
        return 'running'  # Node's documented initial intent for a missing file.
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or
            stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > 16384):
        raise SetupError('The existing supervisor intent is not private and verifiable; its service was left unchanged')
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if info.st_dev != before.st_dev or info.st_ino != before.st_ino:
                raise SetupError('The existing supervisor intent changed while being read')
            raw = source.read(16385)
            if len(raw) > 16384:
                raise SetupError('The existing supervisor intent exceeds the supported size')
            value = json.loads(raw)
    except (OSError, ValueError):
        raise SetupError('The existing supervisor intent could not be verified; its service was left unchanged') from None
    if (not isinstance(value, dict) or set(value) != {'version', 'desired'} or type(value['version']) is not int or
            value['version'] != 1 or value['desired'] not in {'running', 'stopped'}):
        raise SetupError('The existing supervisor intent has an unsupported format; its service was left unchanged')
    return value['desired']


def service_install(target, state, tools):
    if sys.platform != 'darwin':
        raise SetupError('macOS user LaunchAgents are supported only on macOS')
    if any(state['steps'].get(name) != 'done' for name in ('dependencies', 'configuration')):
        raise SetupError('Complete installation before registering this instance service')
    with service_lock(target):
        prior = read_service(target, state)
        definition = service_definition(target, state, tools['node'])
        _, path, identity = service_paths(target)
        before = json.loads(json.dumps(state))
        if prior is not None and prior['ProgramArguments'] == definition['ProgramArguments']:
            return managed_start(target, state)
        prior_status = service_status(target, state) if prior is not None else None
        prior_loaded = prior_status is not None and prior_status['loaded']
        prior_intent = existing_runtime_intent(target, {**prior_status, 'port': state['port']}) if prior is not None else None
        if prior is not None:
            managed_stop(target, state)
        else:
            # A missing plist is not permission to replace a loaded foreign job
            # which happens to use our deterministic label.
            existing = launchctl(['print', identity])
            if existing.returncode == 0:
                raise SetupError('A service with this identity is already loaded without a verified definition; it was left untouched')
            if existing.returncode not in {3, 113} and not re.search(r'could not find service|service not found', existing.stderr or '', re.I):
                raise SetupError('Could not verify whether this service identity is already in use')
            # Upgrade an old detached instance without leaving a second owner.
            stop_detached(target)
            state.update(load_state(target))
        prepare_service_log(target)
        try:
            write_service(path, definition)
            return managed_start(target, state)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            cause = getattr(error, 'code', None) or type(error).__name__
            private_json(target / '.runtime/logs/setup/service-failure.json',
                         {'code': cause, 'message': str(error)})
            cleanup = 'STOPPED'
            # Disable the new exact job before restoring its old definition.
            try:
                managed_stop(target, state)
            except (OSError, ValueError, subprocess.SubprocessError):
                cleanup = 'STOP_UNCONFIRMED'
            try:
                launchctl(['disable', identity]); launchctl(['bootout', identity])
            except SetupError:
                pass
            if prior is None:
                path.unlink(missing_ok=True)
            else:
                write_service(path, prior)
            state.clear(); state.update(before)
            recovery = 'NOT_RUNNING_BEFORE'
            if prior_loaded:
                try:
                    if prior_intent == 'running':
                        # managed_stop persisted stopped through Node. Reusing
                        # the same owner start path restores the real old intent.
                        private_json(state_path(target), state)
                        managed_start(target, state)
                        recovery = 'RESTORED_RUNNING'
                    else:
                        # Preserve the old management Web without clearing its
                        # intentional runtime pause. Never send /api/start here.
                        launch_action(['enable', identity])
                        launch_action(['bootstrap', f'gui/{os.getuid()}', str(path)])
                        recovery = 'RESTORED_PAUSED'
                except (OSError, ValueError, subprocess.SubprocessError):
                    recovery = 'RESTORE_FAILED'
            state['failure'] = {'step': 'start', 'code': 'SERVICE_INSTALL_FAILED',
                                'cause': cause, 'log': '.runtime/logs/setup/service-failure.json',
                                'cleanup': cleanup, 'recovery': recovery}
            private_json(state_path(target), state)
            raise SetupError('User service installation failed (' + cause + '); prior configuration and private data were retained. Inspect .runtime/logs/setup/service-failure.json, then run continue.', code='SERVICE_INSTALL_FAILED') from None


def managed_stop(target, state):
    definition = read_service(target, state)
    if definition is None:
        raise SetupError('Service definition is missing; retain instance data and inspect its user service')
    _, _, identity = service_paths(target)
    status = service_status(target, state)
    verified_host_stopped = False
    if status['running']:
        try:
            api = LocalAPI(state['port']); api.connect()
            verify_managed_snapshot(target, api.request('/api/state'))
            managed_operation(target, api, '/api/stop')
            after = api.request('/api/state')
            verified_host_stopped = after.get('runtime', {}).get('state') == 'offline' and after.get('service', {}).get('desired') == 'stopped'
        except (OSError, ValueError):
            # Keep manual stop authoritative even if Web is unresponsive. A
            # control-only process below can stop a host still opening its socket.
            pass
    launch_action(['disable', identity])
    if status['loaded']:
        launch_action(['bootout', identity])
    exiting = dict(state, webPid=status.get('pid'), webCommand=' '.join(definition['ProgramArguments']))
    for _ in range(120):
        if not service_status(target, state)['loaded'] and not owned_process(target, exiting):
            break
        time.sleep(0.25)
    else:
        raise SetupError('The instance service or its verified Web process is still stopping; no stopped state was recorded')
    if not verified_host_stopped:
        # Node owns its private host-record evidence. Control-only mode never
        # auto-starts business execution and closes its temporary Web afterward.
        stop_detached(target, control_only=True)
        state.update(load_state(target))
    state.pop('webPid', None)
    state['steps']['start'] = 'stopped'
    save_service_state(target, state, definition, 'stopped')
    return report(target)


def connect_web(target, state, tools, *, control_only=False):
    if not owned_process(target, state):
        assert_free(state['port'])
        log = target / '.runtime/logs/setup/web.log'
        log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        env = dict(os.environ, XIAOMAN_PORT=str(state['runtimePort']), PA_WEB_PORT=str(state['port']))
        env.pop('PA_WEB_ORIGIN', None)
        env.pop('PA_WEB_MANAGED', None)
        env.pop('PA_WEB_CONTROL_ONLY', None)
        if control_only:
            env.update(PA_WEB_MANAGED='1', PA_WEB_CONTROL_ONLY='1')
        env['PATH'] = str(target / '.venv/bin') + os.pathsep + env.get('PATH', '')
        with log.open('ab') as out:
            log.chmod(0o600)
            command = [tools['node'], str(target / 'scripts/webui.mjs'), '--port', str(state['port'])]
            child = subprocess.Popen(command,
                                     cwd=target, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                                     start_new_session=True)
        state['webPid'] = child.pid
        state['webCommand'] = ' '.join(command)
        private_json(state_path(target), state)
    api = LocalAPI(state['port'])
    last = None
    for _ in range(50):
        try:
            current = api.connect()
            break
        except (OSError, ValueError) as error:
            last = error
            time.sleep(0.2)
    else:
        raise SetupError('Local Web UI is not reachable; inspect .runtime/logs/setup/web.log') from last
    return api, current


def start(target, state, tools):
    if has_service(target, state):
        with service_lock(target):
            return managed_start(target, state)
    api, current = connect_web(target, state, tools)
    if current.get('runtime', {}).get('state') == 'offline':
        # A detached, legitimate host can outlive its Web process. Inspect this
        # instance's control socket first; a live host is adopted for management.
        # Only an offline host requires a free TCP port for a new launch.
        assert_free(state['runtimePort'])
        api.request('/api/start', {})
    for _ in range(60):
        current = api.request('/api/state')
        if current.get('runtime', {}).get('state') == 'running':
            break
        time.sleep(0.5)
    else:
        raise SetupError('The WeChat host did not become reachable; inspect .runtime/logs/web-launch.log')
    state['steps']['start'] = 'done'
    state.pop('failure', None)
    private_json(state_path(target), state)
    return api


def continue_install(target, no_start=False):
    target = validate_target(target)
    state = load_state(target)
    lock = target / '.runtime/setup.lock'
    with lock.open('a') as handle:
        lock.chmod(0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('Another setup process is working on this instance') from None
        tools = preflight(state['provider'], state['agentCommand'])
        run_step(target, state, 'dependencies', [[tools['npm'], 'ci', '--no-audit', '--no-fund'],
                  [sys.executable, '-m', 'venv', str(target / '.venv')],
                  [str(target / '.venv/bin/python'), '-m', 'pip', 'install', '-r', str(target / 'requirements.txt')]])
        run_step(target, state, 'configuration', [[sys.executable, str(target / 'scripts/onboard.py'), 'init',
                  '--agent', state['provider'], '--agent-command', state['agentCommand'],
                  '--device', 'none', '--im', 'weixin', '--proactive', 'off', '--timezone', 'local'],
                  [sys.executable, str(target / 'scripts/configure-local-agent.py'),
                   '--provider', state['provider'], '--agent-command', state['agentCommand']]])
        verify_agent(target, state, tools)
        if not no_start:
            try:
                service_install(target, state, tools)
                if state.get('automation', {}).get('configured'):
                    automation_module(target).control_all(target, 'start')
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                state['steps']['start'] = 'failed'
                if state.get('failure', {}).get('code') != 'SERVICE_INSTALL_FAILED':
                    code = getattr(error, 'code', None) or 'LOCAL_START_FAILED'
                    log = '.runtime/logs/setup/service-failure.json'
                    private_json(target / log, {'code': code, 'message': str(error)})
                    state['failure'] = {'step': 'start', 'code': code, 'log': log}
                private_json(state_path(target), state)
                raise SetupError(str(error)) from None
    return report(target)


def verify_agent(target, state, tools):
    """Only a real, tool-free model response verifies the selected local Agent."""
    run_step(target, state, 'agent-check', [[tools['node'], str(target / 'scripts/verify-local-agent.mjs')]])
    evidence = target / '.runtime/setup-agent-check.json'
    if not evidence.is_file() or evidence.stat().st_mode & 0o077:
        raise SetupError('Agent verification evidence is missing; continue installation.', code='AGENT_CHECK_MISSING')
    checked = json.loads(evidence.read_text())
    if checked.get('verified') is not True or checked.get('provider') != state['provider']:
        raise SetupError('The selected Agent has not completed verification.', code='AGENT_CHECK_FAILED')
    state['agentLogin'] = 'verified'
    state['agentCheck'] = checked
    private_json(state_path(target), state)


def owned_runtime(target, state, runtime):
    """Prove an orphan host belongs to this instance before sending one signal."""
    pid = runtime.get('pid')
    if runtime.get('protocol') != 1 or runtime.get('state') != 'running' or type(pid) is not int or pid <= 1:
        return False
    identity = hashlib.sha256(str(target.resolve()).encode()).hexdigest()[:12]
    control = Path('/tmp') / f'xiaoman-{os.getuid()}-{identity}.sock'
    try:
        info = control.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            return False
        details = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'uid=', '-o', 'command='],
                                 capture_output=True, text=True, check=True, timeout=5).stdout.strip().split(None, 1)
        if len(details) != 2 or details[0] != str(os.getuid()):
            return False
        node = shutil.which('node')
        executables = {'node'} | ({node, str(Path(node).resolve())} if node else set())
        scripts = {str(target / 'node_modules/.bin/dsh'),
                   str(target / 'node_modules/@deepseek-ai/dsh/lib/bin.js')}
        args = f" --profile wx-life --no-open --port {state['runtimePort']}"
        if details[1] not in {executable + ' ' + script + args for executable in executables for script in scripts}:
            return False
        cwd = subprocess.run(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'],
                             capture_output=True, text=True, check=True, timeout=5).stdout.splitlines()
        directories = [line[1:] for line in cwd if line.startswith('n')]
        return directories == [str(target / '.runtime/workspace')]
    except (OSError, subprocess.SubprocessError):
        return False


def stop_orphan_runtime(target, state, api, runtime):
    if not owned_runtime(target, state, runtime):
        raise SetupError('The surviving host ownership could not be proven; it was left running. Inspect this instance Web UI and private control socket.')
    current = api.request('/api/state').get('runtime', {})
    if current.get('state') == 'offline':
        return
    if current.get('pid') != runtime['pid'] or not owned_runtime(target, state, current):
        raise SetupError('Host identity changed during shutdown; no signal was sent')
    try:
        os.kill(runtime['pid'], signal.SIGTERM)
    except ProcessLookupError:
        pass
    for _ in range(60):
        if api.request('/api/state').get('runtime', {}).get('state') == 'offline':
            return
        time.sleep(0.25)
    raise SetupError('The surviving host has not confirmed shutdown; its management Web was retained')


def stop_detached(target, *, control_only=False):
    state = load_state(target)
    try:
        if control_only:
            node = shutil.which('node')
            if not node:
                raise SetupError('Node.js is needed to restore this instance control Web before stopping its host')
            api, current = connect_web(target, state, {'node': node}, control_only=True)
            verify_managed_snapshot(target, current)
            if current.get('service', {}).get('controlOnly') is not True:
                raise SetupError('The temporary Web does not support control-only management; no host operation was sent')
            # Always ask Node to stop, even when its socket appears offline:
            # its private host record can still identify a starting process.
            api.request('/api/stop', {})
            current = api.request('/api/state')
            if current.get('runtime', {}).get('state') != 'offline' or current.get('service', {}).get('desired') != 'stopped':
                raise SetupError('The control Web has not confirmed a stopped host; its management process was retained')
        elif owned_process(target, state):
            api = LocalAPI(state['port'])
            current = api.connect()
        else:
            node = shutil.which('node')
            if not node:
                raise SetupError('Node.js is needed to restore this instance management Web before stopping its surviving host')
            # Recreate only the management process. Do not launch a new host.
            api, current = connect_web(target, state, {'node': node})
        if not control_only:
            runtime = current.get('runtime', {})
            if runtime.get('owned'):
                api.request('/api/stop', {})
            elif runtime.get('state') == 'running':
                stop_orphan_runtime(target, state, api, runtime)
            elif runtime.get('state') != 'offline':
                raise SetupError('Host state is unavailable; management Web was retained for inspection')
    except (OSError, ValueError) as error:
        raise SetupError(str(error)) from None
    if owned_process(target, state):
        try:
            os.kill(state['webPid'], signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(40):
            if not owned_process(target, state):
                break
            time.sleep(0.25)
        else:
            raise SetupError('Web shutdown is still pending; its PID was kept for a safe retry')
    state.pop('webPid', None)
    state['steps']['start'] = 'stopped'
    private_json(state_path(target), state)
    return report(target)


def stop(target):
    state = load_state(target)
    if state.get('automation', {}).get('configured'):
        automation_module(target).control_all(target, 'stop')
    if has_service(target, state):
        with service_lock(target):
            return managed_stop(target, state)
    return stop_detached(target)


def report(target):
    state = load_state(target)
    service = service_status(target, state) if has_service(target, state) else None
    running = service['running'] or owned_process(target, state) if service else owned_process(target, state)
    actions = []
    if any(state['steps'].get(n) != 'done' for n in ('dependencies', 'configuration')):
        actions.append({'id': 'continue', 'text': 'Continue installation; completed steps and private data are preserved.'})
    if not running:
        actions.append({'id': 'start', 'text': 'Start this instance using the setup start command.'})
    if not state.get('automation', {}).get('configured'):
        actions.append({'id': 'connect', 'text': 'Choose authorized sources and topics, then run setup connect to enable automatic journal collection.'})
    automation = automation_module(target).status(target, state) if running and state.get('automation', {}).get('configured') else None
    actions.extend([{'id': 'weixin', 'url': f"http://127.0.0.1:{state['port']}/#onboarding",
                     'text': 'Optional: connect WeChat by QR login and confirm your sender identity.'},
                    {'id': 'first-task', 'text': 'Verify a real automatically collected journal entry, visible pet delivery and reply; do not inject a test notice.'}])
    return {'target': str(target), 'provider': state['provider'], 'steps': state['steps'],
            'web': {'running': running, 'url': f"http://127.0.0.1:{state['port']}/"},
            **({'service': {**service, 'desired': state.get('service', {}).get('desired', 'unknown')}} if service else {}),
            'agentLogin': state.get('agentLogin', 'not_verified'),
            'installationReady': bool(running and state.get('agentLogin') == 'verified'),
            'ready': bool(automation and automation['ready']),
            **({'agentCheck': state['agentCheck']} if state.get('agentCheck') else {}),
            **({'automation': automation} if automation else {}),
            'note': 'Ready reports source, journal and delivery receipts. Visible pet output and user replies still need direct observation; optional WeChat needs separate QR acceptance.',
            'nextActions': actions, **({'failure': state['failure']} if state.get('failure') else {})}


def automation_module(target):
    # The distributed entry point lives in the skill, while executable modules
    # belong to the verified installation. Never import from the author's checkout.
    import importlib.util
    module_path = target / 'scripts/setup_automation.py'
    if not module_path.is_file() or module_path.is_symlink():
        raise SetupError('Install the complete current skill release first')
    spec = importlib.util.spec_from_file_location('xiaoman_instance_automation', module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault('xiaoman_setup', sys.modules[__name__])
    spec.loader.exec_module(module)
    return module


def installation_material(args):
    if args.source:
        return read_source(args.source)
    archive = args.archive or Path(__file__).resolve().parents[1] / 'assets/framework.zip'
    if not archive.is_file():
        raise SetupError('Installation payload is missing: install the complete xiaoman-setup skill directory including scripts/ and assets/framework.zip, or supply --archive / --source.', code='PACKAGE_RESOURCE_MISSING')
    entries = read_archive(archive)
    if not args.archive and entries.get('scripts/xiaoman_setup.py', (None,))[0] != Path(__file__).read_bytes():
        raise SetupError('The bundled installer and framework differ; reinstall the complete skill release.', code='PACKAGE_RESOURCE_MISMATCH')
    return entries


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'install', 'continue', 'status', 'start', 'stop', 'service-install', 'connect', 'automation-status'])
    parser.add_argument('--target', type=Path)
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--archive', type=Path)
    source.add_argument('--source', type=Path)
    parser.add_argument('--provider', choices=['codex', 'workbuddy'])
    parser.add_argument('--agent-command')
    parser.add_argument('--port', type=int, default=3383)
    parser.add_argument('--runtime-port', type=int, help='WeChat host port; defaults to Web port + 1')
    parser.add_argument('--no-start', action='store_true')
    parser.add_argument('--sources', help='Comma-separated sources explicitly chosen by the user: google,github,x')
    parser.add_argument('--google-account', help='Google account to authorize; never a password')
    parser.add_argument('--desktop-pet', action='store_true', help='Install the official standalone pet and enable replies and feedback')
    parser.add_argument('--topic', action='append', default=[], help='A user-selected reading topic; repeat as needed')
    args = parser.parse_args(argv)
    if args.action == 'check':
        if not args.provider:
            parser.error('check requires --provider')
        entries = installation_material(args)
        return {**preflight(args.provider, args.agent_command),
                'resources': {'verified': True, 'files': len(entries) - 1}}
    if args.target is None:
        parser.error('--target is required')
    target = validate_target(args.target)
    if args.action == 'install':
        if not args.provider:
            parser.error('install requires --provider')
        entries = installation_material(args)
        tools = preflight(args.provider, args.agent_command)
        new_install(target, entries, args.provider, tools['agentCommand'], args.port, args.runtime_port)
        return continue_install(target, args.no_start)
    if args.action == 'continue':
        return continue_install(target, args.no_start)
    if args.action == 'status':
        return report(target)
    if args.action == 'stop':
        return stop(target)
    state = load_state(target)
    if any(state['steps'].get(n) != 'done' for n in ('dependencies', 'configuration')):
        raise SetupError('Installation is incomplete; use continue first')
    if args.action == 'automation-status':
        return automation_module(target).status(target, state)
    if args.action == 'connect':
        if state.get('agentLogin') != 'verified':
            verify_agent(target, state, preflight(state['provider'], state['agentCommand']))
        return automation_module(target).connect(target, state, preflight(state['provider'], state['agentCommand']),
                sources=(args.sources or '').split(','), google_account=args.google_account, topics=args.topic, desktop_pet=args.desktop_pet)
    if args.action == 'service-install':
        service_install(target, state, preflight(state['provider'], state['agentCommand']))
        if state.get('automation', {}).get('configured'):
            automation_module(target).control_all(target, 'start')
        return report(target)
    start(target, state, preflight(state['provider'], state['agentCommand']))
    if state.get('automation', {}).get('configured'):
        automation_module(target).control_all(target, 'start')
    return report(target)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False, indent=2))
    except (SetupError, OSError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
