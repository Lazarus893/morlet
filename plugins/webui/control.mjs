import { connect } from 'node:net';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Ledger } from '../proactive/store.mjs';
import { snapshot, changeUser, failure } from '../proactive/management.mjs';

export function control(socket, request, timeout = 5000, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('CONTROL_CANCELLED'));
    const client = connect(socket); client.setEncoding('utf8'); let input = '', connected = false, done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); client.destroy(); error ? reject(error) : resolve(value); };
    const abort = () => finish(failure('CONTROL_CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => finish(failure('CONTROL_TIMEOUT')), timeout);
    client.on('connect', () => { connected = true; client.write(JSON.stringify(request) + '\n'); });
    client.on('error', error => finish(failure(!connected && ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'OFFLINE' : 'CONTROL_FAILED')));
    client.on('end', () => { if (!done) finish(failure('CONTROL_FAILED')); });
    client.on('data', chunk => {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 2 * 1024 * 1024) return finish(failure('RESPONSE_TOO_LARGE'));
      if (!input.includes('\n')) return;
      try {
        const result = JSON.parse(input.split('\n')[0]);
        if (!result.ok) return finish(failure(/^[A-Z_]{3,60}$/.test(result.error) ? result.error : 'CONTROL_FAILED'));
        finish(null, result);
      } catch { finish(failure('CONTROL_FAILED')); }
    });
  });
}
export function policy(config) {
  return { ...config.proactive, timezone: config.proactive.timezone === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : config.proactive.timezone };
}
const allowed = config => id => config.im.provider === 'weixin' && config.im.access_policy === 'allowlist' && config.im.allow_from.includes(id);
export async function offlineAccounts(root, config) {
  const directory = join(root, '.runtime/proactive');
  const names = await readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const accounts = [];
  for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    const path = join(directory, name);
    if ((await stat(path)).size > 8 * 1024 * 1024) throw failure('STATE_UNAVAILABLE');
    const data = JSON.parse(await readFile(path, 'utf8'));
    accounts.push({ account: name.slice(0, -5), users: snapshot(data, policy(config), { allowed: allowed(config) }), live: false });
  }
  return accounts;
}
export async function getRuntime(root, settings, rpc = control) {
  try {
    const result = await rpc(settings.socket, { command: 'pa', operation: 'snapshot' });
    if (result.kind !== 'pa' || result.data?.protocol !== 1) throw failure('CONTROL_FAILED');
    return { ...result.data, state: 'running', accounts: result.data.account ? [{ account: result.data.account, users: result.data.users, live: true }] : [] };
  } catch (error) {
    if (error.code !== 'OFFLINE') return { state: 'unavailable', error: error.code || 'CONTROL_FAILED', accounts: [] };
    return { state: 'offline', connected: false, accounts: await offlineAccounts(root, settings.config) };
  }
}
export async function manage(root, settings, request, rpc = control) {
  if (!/^[a-f0-9]{64}$/.test(request.account || '') || typeof request.userId !== 'string') throw failure('INVALID_INPUT');
  if (!allowed(settings.config)(request.userId)) throw failure('USER_NOT_FOUND');
  // Only a failed connection before any request was written allows offline editing.
  // A timeout has an unknown outcome and must never replay a mutation.
  try {
    const result = await rpc(settings.socket, { ...request, command: 'pa' });
    if (result.kind !== 'pa') throw failure('CONTROL_FAILED');
    return result.data;
  } catch (error) { if (error.code !== 'OFFLINE') throw error; }
  const ledger = new Ledger(join(root, '.runtime/proactive'), request.account, { hashed: true });
  try {
    await stat(ledger.path); // Web management cannot invent users or account ledgers.
    await ledger.initialize(allowed(settings.config), { managementOnly: true });
    return await ledger.update(data => {
      changeUser(data, policy(settings.config), request, { allowed: allowed(settings.config) });
      return { users: snapshot(data, policy(settings.config), { allowed: allowed(settings.config) }) };
    });
  } catch (error) {
    if (error.message === 'PROACTIVE_ALREADY_RUNNING') throw failure('LEDGER_BUSY');
    if (error.code === 'ENOENT') throw failure('USER_NOT_FOUND');
    throw error;
  } finally { await ledger.close(); }
}
