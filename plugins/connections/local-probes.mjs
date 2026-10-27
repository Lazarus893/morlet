import { spawn } from 'node:child_process';
import * as fileSystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createOAuthConnections } from './oauth.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GOOGLE_SCOPES = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'],
  calendar: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'],
  drive: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive'],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/contacts'],
};
const EMAIL = /^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const STATES = { auth_required: 'awaiting_authorization', authorizing: 'awaiting_authorization' };
const CODES = { VERIFIED: 'ok', PARTIAL_PERMISSION: 'partial', AUTH_REQUIRED: 'not_authenticated', ACCOUNT_REQUIRED: 'permission_required', NO_CLIENT: 'setup_required', PERMISSION_DENIED: 'permission_required', DEVICE_OFFLINE: 'device_missing', DEVICE_LOCKED: 'device_unauthorized', DEVICE_UNCONFIGURED: 'setup_required', MISSING_TOOL: 'tool_missing', NETWORK_ERROR: 'network_error', INVALID_RESPONSE: 'probe_failed', AUTH_PENDING: 'auth_pending', PERMISSION_REQUIRED: 'permission_required', OS_READABLE_ONLY: 'partial', ABORTED: 'probe_failed', DISABLED: 'not_authenticated' };
const report = (state, code, extra = {}) => ({ state: STATES[state] || state, code: CODES[code] || code, ...extra });

/** Bounded, shell-free subprocess. Raw output stays in this process, never in reports. */
export function runCLI(command, args, { signal, timeoutMs = 12000, input = '', onOutput, cwd = ROOT, maxBytes = 65536 } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 2 * 1024 * 1024) throw new Error('INVALID_OUTPUT_LIMIT');
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ exitCode: null, errorCode: 'ABORTED', stdout: '', stderr: '' });
    let stdout = '', stderr = '', settled = false, errorCode, outputBytes = 0;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' } });
    let killTimer;
    const stop = code => {
      errorCode = code;
      child.kill('SIGTERM');
      killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    const abort = () => stop('ABORTED');
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const finish = exitCode => {
      if (settled) return;
      settled = true;
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end();
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve({ exitCode, stdout, stderr, ...(errorCode ? { errorCode } : {}) });
    };
    const append = (which, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) return stop('INVALID_RESPONSE');
      const decoded = decoders[which].write(chunk);
      if (which === 'stdout') stdout += decoded; else stderr += decoded;
      try { onOutput?.(stdout + '\n' + stderr); } catch { stop('INVALID_RESPONSE'); }
    };
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => { errorCode = error.code === 'ENOENT' ? 'MISSING_TOOL' : 'NETWORK_ERROR'; finish(null); });
    child.on('close', finish);
    child.stdin.end(input);
  });
}

function failure(result) {
  if (result.errorCode === 'MISSING_TOOL') return report('setup_required', 'MISSING_TOOL');
  if (result.errorCode === 'ABORTED') return report('offline', 'ABORTED');
  if (result.errorCode === 'INVALID_RESPONSE') return report('error', 'INVALID_RESPONSE');
  if (result.errorCode === 'TIMEOUT') return report('offline', 'NETWORK_ERROR');
  const error = String(result.stderr || '').toLowerCase();
  if (/credentials\.json|oauth client|client credentials|no credentials|missing client/.test(error)) return report('setup_required', 'NO_CLIENT');
  if (/permission denied|operation not permitted|keychain|interaction is not allowed/.test(error)) return report('limited', 'PERMISSION_DENIED');
  if (/access_denied|authorization denied/.test(error)) return report('awaiting_authorization', 'auth_denied');
  if (/invalid_grant|token expired|expired token/.test(error)) return report('expired', 'credential_expired');
  if (/invalid_grant|unauthorized|not logged|authenticate|authentication|login|missing required credentials|no accounts|no token|credentials/.test(error)) return report('auth_required', 'AUTH_REQUIRED');
  return report('offline', 'NETWORK_ERROR');
}

export function parseGoogleAccounts(stdout, account, { liveCheck = false } = {}) {
  let data;
  try { data = JSON.parse(stdout); } catch { return report('error', 'INVALID_RESPONSE'); }
  if (!data || !Array.isArray(data.accounts) || data.accounts.length > 100) return report('error', 'INVALID_RESPONSE');
  if (!EMAIL.test(account || '') || account.startsWith('-') || account.length > 254) return report('auth_required', 'ACCOUNT_REQUIRED');
  const row = data.accounts.find(value => typeof value?.email === 'string' && value.email.toLowerCase() === account.toLowerCase());
  if (!row) return report('auth_required', 'AUTH_REQUIRED');
  if (typeof liveCheck !== 'boolean' || row.valid !== undefined && typeof row.valid !== 'boolean' || row.error !== undefined && typeof row.error !== 'string' || !Array.isArray(row.services) || row.services.some(value => typeof value !== 'string') || row.scopes !== undefined && (!Array.isArray(row.scopes) || row.scopes.some(value => typeof value !== 'string'))) return report('error', 'INVALID_RESPONSE');
  // gog 0.9 emits valid/error for --check but has no checked field. Trust the
  // command invocation context, never a boolean supplied by parsed account JSON.
  if (!liveCheck) return report('auth_required', 'AUTH_REQUIRED', { account: row.email });
  if (typeof row.valid !== 'boolean') return report('error', 'INVALID_RESPONSE');
  if (!row.valid) {
    const value = failure({ stderr: row.error || 'authentication required' });
    return { ...value, account: row.email };
  }
  // These checks verify the saved OAuth scopes + refresh exchange, not service API health.
  const permissions = Object.entries(GOOGLE_SCOPES).map(([id, scopes]) => ({ id, label: id + ' OAuth scope', granted: row.services.includes(id), verified: row.services.includes(id) && scopes.some(scope => row.scopes?.includes(scope)) }));
  const complete = permissions.every(value => value.granted && value.verified);
  return report(complete ? 'connected' : 'limited', complete ? 'VERIFIED' : 'PARTIAL_PERMISSION', { account: row.email, permissions });
}
export function createLocalProbes({ runner = runCLI, fs = fileSystem, home = homedir(), root = ROOT, now = Date.now, oauth, fileCheckTimeoutMs = 1200, fileProbeTimeoutMs = 6000 } = {}) {
  const officialOAuth = { ...createOAuthConnections({ runner, root, now, openURL: async (url, signal) => {
    const value = await runner('/usr/bin/open', [url], { signal, timeoutMs: 10000 });
    if (value.errorCode || value.exitCode !== 0) throw Object.assign(new Error('probe_failed'), { code: 'probe_failed' });
  } }), ...oauth };
  const nativeFilePath = join(root, '.runtime/macos-file-access/Xiaoman File Access.app/Contents/MacOS/xiaoman-file-access');
  const nativeFiles = async (action, signal) => {
    const value = await runner(nativeFilePath, [action], { signal, timeoutMs: ['authorize', 'authorize-defaults'].includes(action) ? 180000 : 12000 });
    if (value.errorCode === 'MISSING_TOOL') return report('setup_required', 'native_helper_missing');
    if (value.errorCode || value.exitCode !== 0) return failure(value);
    let data;
    try { data = JSON.parse(value.stdout); } catch { return report('error', 'INVALID_RESPONSE'); }
    if (data?.version !== 1 || !['connected', 'limited', 'awaiting_authorization', 'setup_required', 'error', 'offline'].includes(data.state) || !['ok', 'permission_required', 'not_authenticated', 'auth_denied', 'auth_expired', 'probe_failed', 'full_disk_manual'].includes(data.code) || !Number.isInteger(data.selectedCount) || data.selectedCount < 0 || data.selectedCount > 32 || !Number.isInteger(data.accessibleCount) || data.accessibleCount < 0 || data.accessibleCount > data.selectedCount || !Array.isArray(data.permissions) || data.permissions.length !== 2 || data.permissions.some(permission => !['readable', 'full_disk'].includes(permission.id) || typeof permission.granted !== 'boolean' || typeof permission.verified !== 'boolean') || new Set(data.permissions.map(permission => permission.id)).size !== 2) return report('error', 'INVALID_RESPONSE');
    const permissions = data.permissions.map(({ id, granted, verified }) => ({ id, granted, verified: granted && verified }));
    if (permissions.some(permission => permission.id === 'full_disk' && (permission.granted || permission.verified))) return report('error', 'INVALID_RESPONSE');
    if (data.state === 'connected' && (!data.accessibleCount || data.accessibleCount !== data.selectedCount || !permissions.find(permission => permission.id === 'readable' && permission.granted && permission.verified))) return report('error', 'INVALID_RESPONSE');
    return report(data.code === 'auth_denied' ? 'error' : data.code === 'auth_expired' ? 'expired' : data.code === 'not_authenticated' ? 'setup_required' : data.state, data.code, { permissions });
  };
  const pendingFileChecks = new Set();
  const boundedFileCheck = (key, operation, signal, onLate) => new Promise((resolve, reject) => {
    const failed = code => Object.assign(new Error(code), { code });
    if (signal.aborted) return reject(failed('ABORTED'));
    // A pending OS/TCC call cannot be cancelled. Do not stack another call on each heartbeat.
    if (pendingFileChecks.has(key)) return reject(failed('PROBE_TIMEOUT'));
    pendingFileChecks.add(key);
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        if (!error && onLate) Promise.resolve().then(() => onLate(value)).catch(() => {});
        return;
      }
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(failed('ABORTED'));
    const timer = setTimeout(() => finish(failed('PROBE_TIMEOUT')), fileCheckTimeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(value => finish(null, value), error => finish(error)).finally(() => pendingFileChecks.delete(key));
  });
  const google = async (desired, signal) => {
    const result = await runner('gog', ['auth', 'list', '--check', '--json', '--no-input', '--timeout=8s'], { signal, timeoutMs: 12000 });
    return result.exitCode === 0 && !result.errorCode ? parseGoogleAccounts(result.stdout, desired.account, { liveCheck: true }) : failure(result);
  };
  const github = async (_desired, signal) => {
    const result = await runner('gh', ['api', 'user', '--hostname', 'github.com', '--jq', '.login'], { signal, timeoutMs: 12000 });
    if (result.exitCode !== 0 || result.errorCode) return failure(result);
    const account = result.stdout.trim();
    if (!LOGIN.test(account)) return report('error', 'INVALID_RESPONSE');
    // Prove the granted repository API can be read, without returning repository names.
    const repositories = await runner('gh', ['api', 'user/repos?per_page=1', '--hostname', 'github.com', '--jq', 'length'], { signal, timeoutMs: 12000 });
    const readable = !repositories.errorCode && repositories.exitCode === 0 && /^[01]$/.test(repositories.stdout.trim());
    return report(readable ? 'connected' : 'limited', readable ? 'VERIFIED' : 'PARTIAL_PERMISSION', { account, permissions: [{ id: 'profile', label: '读取 GitHub 账号身份', granted: true, verified: true }, { id: 'repos', label: '仓库列表读取', granted: readable, verified: readable }] });
  };
  const x = async (desired, signal) => officialOAuth.xProbe(desired, { signal });
  const files = async (desired, signal) => {
    if (desired.scope === 'common-folders') return nativeFiles('probe-defaults', signal);
    if (desired.scope === 'selected-files') return nativeFiles('probe', signal);
    if (desired.scope !== 'all-readable-files') return report('setup_required', 'PERMISSION_REQUIRED');
    if (signal?.aborted) return report('offline', 'ABORTED');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, fileProbeTimeoutMs);
    const targets = [{ id: 'filesystem', label: '系统可读文件', path: '/' }, { id: 'home', label: '用户主目录', path: home }, ...['Desktop', 'Documents', 'Downloads', 'Library/Mail', 'Library/Messages', 'Library/Safari'].map(name => ({ id: name.toLowerCase().replaceAll('/', '-'), label: name, path: join(home, name), optional: true }))];
    const checks = [];
    try {
      for (const target of targets) {
        if (controller.signal.aborted) break;
        try {
          await boundedFileCheck('access:' + target.path, () => fs.access(target.path, constants.R_OK), controller.signal);
          // No directory enumeration; even a late TCC result has its handle closed.
          const directory = await boundedFileCheck('open:' + target.path, () => fs.opendir(target.path), controller.signal, handle => handle.close());
          // Schedule closure even if cancellation arrives immediately after the open completes.
          const closing = Promise.resolve().then(() => directory.close());
          closing.catch(() => {});
          await boundedFileCheck('close:' + target.path, () => closing, controller.signal);
          checks.push({ id: target.id, granted: true });
        } catch (error) {
          if (target.optional && error.code === 'ENOENT') continue;
          checks.push({ id: target.id, granted: false });
        }
      }
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    if (signal?.aborted) return report('offline', 'ABORTED');
    // Sampling permission boundaries cannot prove the readability of every file on a Mac.
    const readable = ['filesystem', 'home'].every(id => checks.some(value => value.id === id && value.granted));
    return report('limited', controller.signal.aborted || checks.some(value => !value.granted) ? 'PERMISSION_DENIED' : 'OS_READABLE_ONLY', { permissions: [{ id: 'readable', label: '系统与主目录只读访问', granted: readable, verified: true }, { id: 'full_disk', label: '所有文件权限尚未完整验证', granted: false, verified: false }] });
  };
  const phone = async (_desired, signal, action = 'device') => {
    const result = await runner('python3', [join(root, 'scripts/web_config.py')], { input: JSON.stringify({ action }), cwd: root, signal, timeoutMs: 18000 });
    if (result.exitCode !== 0 || result.errorCode) return failure(result);
    let value;
    try { value = JSON.parse(result.stdout); } catch { return report('error', 'INVALID_RESPONSE'); }
    if (value?.ok !== true || !value.data || !['adb', 'ios', 'none'].includes(value.data.provider)) return report('error', 'INVALID_RESPONSE');
    const states = { connected: ['connected', 'VERIFIED'], locked: ['limited', 'phone_locked'], absent: ['offline', 'DEVICE_OFFLINE'], unauthorized: ['awaiting_authorization', 'DEVICE_LOCKED'], multiple: ['setup_required', 'device_multiple'], unconfigured: ['setup_required', 'DEVICE_UNCONFIGURED'], disabled: ['setup_required', 'DEVICE_UNCONFIGURED'] };
    const status = states[value.data.state];
    if (!status) return report('error', 'INVALID_RESPONSE');
    const evidence = value.data.permissions, paired = ['connected', 'locked'].includes(value.data.state);
    const reasons = { automation: ['authorized', 'denied', 'unverified', 'unsupported'], recording: ['authorized', 'needs_authorization', 'projection_inactive', 'helper_missing', 'unverified', 'unsupported'] };
    if (!Array.isArray(evidence) || evidence.length !== 2 || new Set(evidence.map(row => row?.id)).size !== 2 || evidence.some(row => !row || !reasons[row.id]?.includes(row.reason) || typeof row.granted !== 'boolean' || typeof row.verified !== 'boolean' || row.granted !== row.verified || row.granted !== (row.reason === 'authorized') || row.granted && (!paired || value.data.provider !== 'adb')) || paired && value.data.provider === 'none' || action === 'phone-settings' && typeof value.data.settingsOpened !== 'boolean') return report('error', 'INVALID_RESPONSE');
    const automation = evidence.find(row => row.id === 'automation'), recording = evidence.find(row => row.id === 'recording');
    if (value.data.state === 'connected' && !evidence.every(row => row.verified)) {
      status[0] = 'limited';
      status[1] = recording.reason === 'helper_missing' ? 'phone_helper_missing' : evidence.some(row => row.reason === 'unsupported') ? 'phone_permissions_unsupported' : automation.reason === 'denied' ? 'phone_automation_required' : automation.reason === 'unverified' || recording.reason === 'unverified' ? 'phone_permission_unverified' : 'phone_recording_required';
    }
    if (action === 'phone-settings' && value.data.state === 'connected' && !recording.verified && !['helper_missing', 'unsupported'].includes(recording.reason)) status[1] = value.data.settingsOpened ? 'phone_settings_opened' : 'phone_settings_failed';
    return report(...status, { permissions: [{ id: 'paired', granted: paired, verified: paired }, { id: 'device', granted: value.data.state === 'connected', verified: value.data.state === 'connected' }, ...evidence.map(({ id, granted, verified }) => ({ id, granted, verified }))] });
  };
  const probes = { google, github, x, files, phone };
  return {
    async probe(desired, signal) {
      if (!desired?.enabled) return report('offline', 'DISABLED');
      if (!probes[desired.id]) return report('error', 'INVALID_RESPONSE');
      try { return await probes[desired.id](desired, signal); } catch { return report('offline', 'NETWORK_ERROR'); }
    },
    async connect(desired, { signal, kind = 'connect', onProgress = () => {} } = {}) {
      if (!desired?.enabled || !probes[desired.id]) return report('offline', 'DISABLED');
      if (signal?.aborted) return report('offline', 'ABORTED');
      if (desired.id === 'files' && kind === 'settings') return nativeFiles('settings', signal);
      if (desired.id === 'files' && desired.scope === 'common-folders') {
        onProgress(report('authorizing', 'AUTH_PENDING'));
        return nativeFiles('authorize-defaults', signal);
      }
      if (desired.id === 'files' && desired.scope === 'selected-files') {
        onProgress(report('authorizing', 'AUTH_PENDING'));
        return nativeFiles('authorize', signal);
      }
      if (desired.id === 'google') return officialOAuth.googleConnect(desired, { signal, onProgress, probe: () => google(desired, signal) });
      if (desired.id === 'x') return officialOAuth.xConnect(desired, { signal, onProgress });
      if (desired.id === 'phone') return phone(desired, signal, kind === 'settings' ? 'phone-settings' : 'connect-device');
      if (desired.id === 'github') {
        onProgress(report('authorizing', 'AUTH_PENDING'));
        let lastCode;
        const result = await runner('gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key'], {
          signal, timeoutMs: 180000, input: '\n',
          onOutput(output) {
            const match = output.match(/(?:one-time code|device code)[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})(?:\s|$)/i);
            if (match && match[1] !== lastCode) {
              lastCode = match[1];
              onProgress(report('authorizing', 'AUTH_PENDING', { auth: { verificationUrl: 'https://github.com/login/device', code: lastCode, expiresAt: now() + 180000 } }));
            }
          },
        });
        if (result.errorCode === 'TIMEOUT') return report('expired', 'auth_expired');
        return result.exitCode === 0 && !result.errorCode ? this.probe(desired, signal) : failure(result);
      }
      return this.probe(desired, signal);
    },
  };
}
