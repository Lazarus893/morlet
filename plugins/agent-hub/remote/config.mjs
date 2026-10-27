import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class DshRemoteError extends Error {
  constructor(code, { uncertain = false } = {}) {
    super(code);
    this.name = 'DshRemoteError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

export function privateJson(path, maxBytes = 65536) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077 || st.size > maxBytes) throw new DshRemoteError('DSH_REMOTE_PRIVATE_FILE_REQUIRED');
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new DshRemoteError('DSH_REMOTE_INVALID_CONFIG'); }
}

export function validateDshRemoteConfig(value, root = process.cwd()) {
  if (!value || value.version !== 1 || value.dedicatedClient !== true ||
      typeof value.baseUrl !== 'string' || typeof value.credentialFile !== 'string' || !value.credentialFile ||
      value.targetDeviceId !== undefined && (typeof value.targetDeviceId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.targetDeviceId)) ||
      Object.keys(value).some(key => !['version', 'baseUrl', 'credentialFile', 'targetDeviceId', 'dedicatedClient', 'allowSessionControl', 'timeoutMs'].includes(key)) ||
      value.allowSessionControl !== undefined && typeof value.allowSessionControl !== 'boolean') throw new DshRemoteError('DSH_REMOTE_INVALID_CONFIG');
  let url;
  try { url = new URL(value.baseUrl); } catch { throw new DshRemoteError('DSH_REMOTE_INVALID_CONFIG'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol === 'http:' && !local) throw new DshRemoteError('DSH_REMOTE_SECURE_TRANSPORT_REQUIRED');
  const timeoutMs = value.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120000) throw new DshRemoteError('DSH_REMOTE_INVALID_CONFIG');
  return Object.freeze({ ...value, baseUrl: url.origin, timeoutMs, allowSessionControl: value.allowSessionControl === true,
    credentialFile: isAbsolute(value.credentialFile) ? value.credentialFile : resolve(root, value.credentialFile) });
}

export function loadDshRemoteConfig(root) {
  let value;
  try { value = privateJson(join(root, '.runtime/dsh-remote.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return validateDshRemoteConfig(value, root);
}

// The authenticated controller verifies membership with devices() before calling
// this persistence helper. A saved target is not itself a device authorization.
export function saveDshRemoteTarget(root, targetDeviceId) {
  if (typeof targetDeviceId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(targetDeviceId)) throw new DshRemoteError('DSH_REMOTE_INVALID_CONFIG');
  const path = join(root, '.runtime/dsh-remote.json');
  const original = lstatSync(path);
  if (typeof process.getuid === 'function' && original.uid !== process.getuid()) throw new DshRemoteError('DSH_REMOTE_PRIVATE_FILE_REQUIRED');
  const value = privateJson(path);
  validateDshRemoteConfig({ ...value, targetDeviceId }, root);
  const temporary = join(dirname(path), `.dsh-remote-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ ...value, targetDeviceId }, null, 2) + '\n');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { targetDeviceId };
}

export const DSH_REMOTE_UPSTREAM = Object.freeze({
  package: 'ds-harness-remote', version: '0.5.18', license: 'MIT',
  url: 'https://github.com/liguobao/ds-harness-remote',
  interface: 'authenticated-client-control-and-native-typert',
});
