"""Wire existing connection/notice runners to one installed instance."""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import subprocess
import sys
import time

from xiaoman_setup import LocalAPI, SetupError, private_json, state_path, launchctl, write_service, run_step

RUNNERS = {
    'connections': ('connection-companion.mjs', '.runtime/connection-companion.json'),
    'pet': ('pet-host.mjs', '.runtime/pet-host.json'),
    'notices': ('personal-notice-worker.mjs', '.runtime/personal-notices/worker.json'),
}


def service_paths(target, kind):
    if kind not in RUNNERS:
        raise SetupError('Unknown instance service')
    identity = hashlib.sha256(str(target.resolve()).encode()).hexdigest()[:20]
    label = 'com.xiaoman.' + kind + '-' + identity
    return label, Path.home() / 'Library/LaunchAgents' / (label + '.plist'), f'gui/{os.getuid()}/{label}'


def definition(target, kind, node):
    script, config = RUNNERS[kind]
    label, _, _ = service_paths(target, kind)
    log = str(target / '.runtime/logs/setup' / (kind + '.log'))
    return {'Label': label, 'ProgramArguments': [node, str(target / 'scripts' / script), '--config', str(target / config)],
            'WorkingDirectory': str(target), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30,
            'ExitTimeOut': 25, 'ProcessType': 'Background',
            'EnvironmentVariables': {'PATH': os.pathsep.join([str(Path(node).parent), os.environ.get('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')])},
            'StandardOutPath': log, 'StandardErrorPath': log}


def read_definition(target, kind):
    label, path, _ = service_paths(target, kind)
    if not path.exists():
        return None
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
        raise SetupError('Instance companion service must be private and owned by this user')
    data = plistlib.loads(path.read_bytes())
    args = data.get('ProgramArguments', [])
    script, config = RUNNERS[kind]
    if (len(args) != 4 or not isinstance(args[0], str) or not Path(args[0]).is_absolute() or
            args[1:] != [str(target / 'scripts' / script), '--config', str(target / config)] or
            data.get('Label') != label or data.get('WorkingDirectory') != str(target)):
        raise SetupError('Companion belongs to another instance; no service was changed')
    return data


def service_status(target, kind):
    data = read_definition(target, kind)
    if data is None:
        return {'installed': False, 'running': False}
    label, path, identity = service_paths(target, kind)
    status = launchctl(['print', identity])
    if status.returncode:
        if status.returncode not in (3, 113):
            raise SetupError('Could not inspect instance companion')
        return {'installed': True, 'running': False, 'label': label}
    if not re.search(r'^\s*path = ' + re.escape(str(path)) + r'\s*$', status.stdout, re.M):
        raise SetupError('Loaded companion identity differs from this instance')
    found = re.search(r'^\s*pid = (\d+)\s*$', status.stdout, re.M)
    pid = int(found.group(1)) if found else None
    running = False
    if pid:
        # launchd can expose its child PID just before exec has installed the
        # final argv. Wait for exact ownership; never control a mismatched PID.
        for attempt in range(21):
            actual = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True, timeout=5)
            running = actual.returncode == 0 and actual.stdout.strip() == ' '.join(data['ProgramArguments'])
            if running or actual.returncode != 0 or not actual.stdout.strip():
                break
            if attempt == 20:
                raise SetupError('Companion PID belongs to a different command; no process was changed')
            time.sleep(.05)
    return {'installed': True, 'running': running, 'label': label, **({'pid': pid} if running else {})}


def control_service(target, kind, action, node=None):
    label, path, identity = service_paths(target, kind)
    old = read_definition(target, kind)
    if action == 'status':
        return service_status(target, kind)
    if action == 'stop' and old is None:
        return {'installed': False, 'running': False}
    if action == 'start' and old is None and node is None:
        return {'installed': False, 'running': False}
    if action == 'start' and old is None:
        current = launchctl(['print', identity])
        if current.returncode not in (3, 113):
            raise SetupError('Companion identity is already loaded or could not be verified; it was left untouched')
    changed = node is not None and old != definition(target, kind, node)
    if action == 'stop' or changed:
        if old:
            service_status(target, kind)  # Validate the loaded job before touching it.
            if action == 'stop' and launchctl(['disable', identity]).returncode:
                raise SetupError('Could not disable this instance companion')
            launchctl(['bootout', identity])
            for _ in range(40):
                if launchctl(['print', identity]).returncode in (3, 113):
                    break
                time.sleep(.25)
            else:
                raise SetupError('Companion shutdown is pending; its files were kept')
        if action == 'stop':
            return service_status(target, kind)
    if changed:
        data = definition(target, kind, node)
        log = Path(data['StandardOutPath']); log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        log.touch(mode=0o600, exist_ok=True); log.chmod(0o600)
        write_service(path, data)
    if launchctl(['enable', identity]).returncode:
        raise SetupError('Could not enable this instance companion')
    current = service_status(target, kind)
    if not current['running']:
        # An already-loaded job may be throttling; do not load a duplicate.
        if launchctl(['print', identity]).returncode in (3, 113):
            if launchctl(['bootstrap', f'gui/{os.getuid()}', str(path)]).returncode:
                raise SetupError('Could not start this instance companion; configuration was retained')
        else:
            launchctl(['kickstart', identity])
        for _ in range(30):
            current = service_status(target, kind)
            if current['running']:
                return current
            time.sleep(.2)
        raise SetupError('Companion did not become reachable; inspect its private setup log')
    return current


def control_all(target, action):
    if action == 'start' and (target / '.runtime/pet-host.json').exists():
        ensure_socket_dir(target)
    kinds = reversed(RUNNERS) if action == 'stop' else RUNNERS
    return {kind: control_service(target, kind, action) for kind in kinds}


def private_config(path):
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 16384:
        raise SetupError('Instance configuration must be private and owned by this user')
    return json.loads(path.read_text())


def ensure_socket_dir(target):
    identity = hashlib.sha256(str(target).encode()).hexdigest()[:20]
    path = Path('/tmp') / f'xiaoman-{os.getuid()}-{identity}'
    path.mkdir(mode=0o700, exist_ok=True)
    st = path.lstat()
    if path.is_symlink() or not path.is_dir() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise SetupError('Pet socket directory must be private and owned by this user')
    return path


def configure_pet(target, state, tools, api):
    """Install the pinned official standalone package; pair only this instance."""
    package = target / '.runtime/pet-package'
    package.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('package.json', 'pnpm-lock.yaml', '.npmrc', 'patches/dsh-pet@0.3.7.patch'):
        dest = package / name
        dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = (target / 'config/pet-host' / name).read_bytes()
        if dest.exists() and dest.read_bytes() != data:
            raise SetupError('Pet package configuration changed; keep it for review before upgrading')
        if not dest.exists():
            dest.write_bytes(data); dest.chmod(0o600)
    run_step(target, state, 'pet-dependencies', [[tools['npm'], 'exec', '--yes', '--package=pnpm@9.15.0', '--', 'pnpm',
             '--dir', str(package), 'install', '--frozen-lockfile', '--ignore-scripts', '--reporter=append-only']])
    home = target / '.runtime/pet-home'
    config = home / 'dsh-pet/main-config.jsonc'
    if not config.exists():
        private_json(config, {'notificationsEnabled': False, 'pets': [{'id': 'main', 'name': '小满', 'size': 300,
            'display': 'desktop', 'balanceEnabled': False, 'whisperEnabled': False, 'workStatusEnabled': False,
            'fixedEnabled': True, 'position': {'corner': 'bottom-right', 'marginX': 24, 'marginY': 60}}]})
    host_path = target / '.runtime/pet-host.json'
    if not host_path.exists():
        # Reuse the official runtime if already installed; otherwise upstream
        # downloads its pinned Electron into this instance on first launch.
        relative = Path('electron/Electron.app/Contents/MacOS/Electron')
        existing = Path.home() / '.dsh' / relative
        electron = existing if existing.is_file() and os.access(existing, os.X_OK) else home / relative
        private_json(host_path, {'home': str(home), 'electron': str(electron)})
    host = private_config(host_path)
    pet_path = target / '.runtime/personal-notices/pet.json'
    chat_path = home / 'dsh-pet/xiaoman-chat.json'
    pairing_path = target / '.runtime/personal-notices/pet-pairing.json'
    if not pairing_path.exists():
        conversation = api.request('/api/hub', {'operation': 'new', 'title': '和小满聊聊'})
        paired = api.request('/api/hub', {'operation': 'pair-desktop-pet', 'label': '桌面小满', 'petId': 'main', 'conversationId': conversation['id']})
        private_json(pairing_path, paired)
    paired = private_config(pairing_path)
    if not chat_path.exists():
        socket_dir = ensure_socket_dir(target)
        private_json(chat_path, {'petId': 'main', 'socketPath': str(socket_dir / 'chat.sock'), 'token': secrets.token_urlsafe(32)})
    pet = {'endpoint': api.origin, 'publicOrigin': api.origin, 'token': paired['token'], 'petId': 'main',
           'hostExecutable': tools['node'], 'hostArguments': [str(target / 'scripts/pet-host.mjs'), '--config', str(host_path)],
           'helperExecutable': host['electron'], 'chatConfig': str(chat_path)}
    if pet_path.exists() and private_config(pet_path) != pet:
        raise SetupError('Pet pairing differs from this instance; existing configuration was kept')
    private_json(pet_path, pet)
    control_service(target, 'pet', 'start', tools['node'])
    api.request('/api/hub', {'operation': 'enable-pet-chat', 'channelId': paired['channelId'], 'enabled': True})
    return {'config': str(pet_path), 'channelId': paired['channelId']}


def connect(target, state, tools, **options):
    descriptor = os.open(target / '.runtime/setup.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('Another setup process is working on this instance') from None
        return _connect(target, state, tools, **options)


def _connect(target, state, tools, *, sources, google_account=None, topics=(), desktop_pet=False):
    if not sources or len(set(sources)) != len(sources) or any(s not in ('google', 'github', 'x') for s in sources):
        raise SetupError('Choose one or more sources: google, github, x')
    if len(topics) > 12 or any(not isinstance(t, str) or not t.strip() or len(t) > 100 for t in topics):
        raise SetupError('Use up to twelve short topic names')
    if 'google' in sources and (not isinstance(google_account, str) or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', google_account)):
        raise SetupError('Choose the Google account you want to authorize; no password is needed')
    missing = [command for source, command in (('google', 'gog'), ('github', 'gh')) if source in sources and not shutil.which(command)]
    if missing:
        raise SetupError('Install the official source CLI first: ' + ', '.join(missing))
    api = LocalAPI(state['port']); api.connect()
    origin = api.origin
    # Persist intent before the first external job starts, so stop/retry works
    # even if authorization or a dependency install is interrupted.
    state['automation'] = {**state.get('automation', {}), 'configured': True, 'sources': sources,
                           'googleAccount': google_account, 'desktopPet': desktop_pet or state.get('automation', {}).get('desktopPet', False)}
    private_json(state_path(target), state)
    path = target / '.runtime/connection-companion.json'
    snapshot = api.request('/api/connections')
    if not path.exists():
        if snapshot['bridge']['paired']:
            raise SetupError('This instance already has a paired Mac; recover its configuration instead of replacing it')
        paired = api.request('/api/connections', {'operation': 'pair', 'revision': snapshot['revision'], 'values': {'name': '当前 Mac'}})
        private_json(path, {'endpoint': origin, 'publicOrigin': origin, 'token': paired['token']})
    else:
        paired = private_config(path)
        if paired.get('endpoint') != origin or paired.get('publicOrigin') != origin:
            raise SetupError('Connection configuration does not belong to this local instance')
    control_service(target, 'connections', 'start', tools['node'])
    for source in sources:
        snapshot = api.request('/api/connections')
        item = next(i for i in snapshot['items'] if i['id'] == source)
        if source == 'google' and item.get('account') and item['account'].lower() != google_account.lower():
            raise SetupError('A different Google account is already selected; change it in Xiaoman Connections first')
        if item['state'] in ('connected', 'checking', 'awaiting_authorization'):
            continue
        values = {'account': google_account} if source == 'google' else {}
        api.request('/api/connections', {'operation': 'connect', 'id': source, 'revision': snapshot['revision'], 'values': values})
    # Automatic content reuses the same persisted journal and learned preferences.
    content_sources = ['google-mail' if s == 'google' else s for s in sources]
    content = api.request('/api/automatic-content')
    effective_topics = list(dict.fromkeys(topics)) if topics else content['configuredTopics']
    api.request('/api/automatic-content', {'operation': 'configure', 'revision': content['revision'], 'enabled': True,
                'discovery': content['discovery'], 'maxDaily': content['maxDaily'],
                'topics': effective_topics,
                'sources': content_sources, 'readingGuidance': content['readingGuidance']})
    config = target / '.runtime/personal-notices/worker.json'
    previous = private_config(config) if config.exists() else {}
    timezone = api.request('/api/reach-out')['policy']['timezone']
    worker = {**previous, 'connectionConfig': str(path), 'timezone': timezone, 'interests': effective_topics,
              'reading': previous.get('reading', {'publisherHosts': ['github.com'], 'primaryHosts': ['github.com'],
                         'topics': [], 'maxEmails': 8, 'maxArticles': 6, 'reasoningEffort': 'low'})}
    if state['automation']['desktopPet']:
        pet = configure_pet(target, state, tools, api)
        worker['petConfig'] = pet['config']
        policy = api.request('/api/reach-out')['policy']
        if policy['mode'] == 'Off':
            api.request('/api/reach-out', {'revision': policy['revision'], 'mode': 'Digest'})
        api.request('/api/personal-notices', {'operation': 'configure', 'enabled': True,
                    'channelId': pet['channelId'], 'sources': content_sources, 'timezone': timezone})
    if previous != worker:
        control_service(target, 'notices', 'stop')
        private_json(config, worker)
    control_service(target, 'notices', 'start', tools['node'])
    selected_local = [source for source in sources if source in ('google', 'github')]
    connected = {item['id'] for item in api.request('/api/connections')['items'] if item['state'] == 'connected'}
    if selected_local and set(selected_local) <= connected:
        # Same registration tool used by the skill's existing-source flow.
        # It refuses to replace a different user-created scope configuration.
        command = [sys.executable, str(target / 'scripts/configure-existing-sources.py'), '--target', str(target)]
        if 'google' in selected_local:
            command += ['--reuse-google', '--google-account', google_account]
        if 'github' in selected_local:
            command += ['--reuse-github']
        registration_key = hashlib.sha256(json.dumps([selected_local, google_account]).encode()).hexdigest()[:16]
        run_step(target, state, 'sources-' + registration_key, [command])
    private_json(state_path(target), state)
    return status(target, state)


def status(target, state):
    api = LocalAPI(state['port']); api.connect()
    connections = api.request('/api/connections')
    content = api.request('/api/automatic-content')
    notices = api.request('/api/personal-notices')
    selected = state.get('automation', {}).get('sources', [])
    authorized = bool(selected) and all(any(i['id'] == s and i['state'] == 'connected' for i in connections['items']) for s in selected)
    submitted = [n for n in notices['notices'] if n.get('channelId') == notices.get('channelId') and n.get('state') in ('submitted', 'delivered', 'read')]
    ready = bool(authorized and content['entries'] and notices['channelReady'] and submitted and (notices.get('worker') or {}).get('online'))
    return {'services': control_all(target, 'status'), 'connections': connections,
            'content': {'enabled': content['enabled'], 'today': content['today'], 'maxDaily': content['maxDaily']},
            'notices': {'enabled': notices['enabled'], 'channelReady': notices['channelReady'], 'worker': notices['worker']},
            'ready': ready, 'evidence': {'authorized': authorized, 'automaticEntries': len(content['entries']), 'submittedNotifications': len(submitted)},
            'note': 'Submitted means host acceptance; visible pet output and user feedback require separate observation.'}
