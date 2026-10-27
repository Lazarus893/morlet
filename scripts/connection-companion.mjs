#!/usr/bin/env node
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { readFile, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalProbes } from '../plugins/connections/local-probes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IDS = new Set(['google', 'files', 'phone', 'github', 'x']);
const failure = code => Object.assign(new Error(code), { code });

export async function loadCompanionConfig(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > 8192) throw failure('PRIVATE_CONFIG_REQUIRED');
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw failure('INVALID_CONFIG'); }
  let endpoint, origin;
  try { endpoint = new URL(value.endpoint); origin = new URL(value.publicOrigin); } catch { throw failure('INVALID_CONFIG'); }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw failure('INVALID_CONFIG');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw failure('INVALID_CONFIG');
  if (Object.keys(value).some(key => !['endpoint', 'publicOrigin', 'token', 'intervalMs'].includes(key)) || !/^[A-Za-z0-9_-]{32,256}$/.test(value.token)) throw failure('INVALID_CONFIG');
  if (value.intervalMs !== undefined && (!Number.isInteger(value.intervalMs) || value.intervalMs < 1000 || value.intervalMs > 60000)) throw failure('INVALID_CONFIG');
  return { endpoint: endpoint.origin, publicOrigin: origin.origin, token: value.token, intervalMs: value.intervalMs || 15000 };
}

/** Authentication only traverses the local SSH tunnel, with the deployed Host header. */
export function createBridgeTransport(config) {
  return (path, body, signal) => new Promise((resolveRequest, reject) => {
    if (!['/api/connections/bridge', '/api/connections/bridge/report'].includes(path)) return reject(failure('INVALID_ROUTE'));
    const url = new URL(path, config.endpoint);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (url.protocol === 'https:' ? secureRequest : request)(url, {
      method: payload === undefined ? 'GET' : 'POST', signal,
      headers: { Host: new URL(config.publicOrigin).host, 'X-PA-Bridge-Token': config.token, ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
    }, response => {
      let text = '', bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) return req.destroy(failure('INVALID_RESPONSE'));
        text += chunk.toString('utf8');
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(failure(response.statusCode === 401 || response.statusCode === 403 ? 'BRIDGE_AUTH_REQUIRED' : 'BRIDGE_UNAVAILABLE'));
        try {
          const data = JSON.parse(text);
          if (data?.ok !== true || !data.data || typeof data.data !== 'object') throw failure('INVALID_RESPONSE');
          resolveRequest(data.data);
        } catch { reject(failure('INVALID_RESPONSE')); }
      });
      response.on('error', () => reject(failure('BRIDGE_UNAVAILABLE')));
    });
    req.setTimeout(10000, () => req.destroy(failure('BRIDGE_UNAVAILABLE')));
    req.on('error', error => reject(failure(error.code === 'ABORT_ERR' ? 'ABORTED' : ['INVALID_RESPONSE', 'BRIDGE_UNAVAILABLE'].includes(error.code) ? error.code : 'BRIDGE_UNAVAILABLE')));
    req.end(payload);
  });
}

function parseSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.desired) || snapshot.desired.length > 5 || !Array.isArray(snapshot.commands) || snapshot.commands.length > 100) throw failure('INVALID_RESPONSE');
  const ids = new Set();
  for (const row of snapshot.desired) {
    if (!row || !IDS.has(row.id) || ids.has(row.id) || typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.generation) || row.generation < 0 || (row.account != null && (typeof row.account !== 'string' || row.account.length > 254)) || (row.scope != null && (typeof row.scope !== 'string' || row.scope.length > 100))) throw failure('INVALID_RESPONSE');
    if (row.oauthApp !== undefined && (row.id !== 'x' || !row.oauthApp || Object.keys(row.oauthApp).some(key => !['clientId', 'redirectUri'].includes(key)) || !/^[A-Za-z0-9_:.+=\/-]{8,256}$/.test(row.oauthApp.clientId || '') || row.oauthApp.redirectUri !== 'http://127.0.0.1:3094/oauth/x/callback')) throw failure('INVALID_RESPONSE');
    ids.add(row.id);
  }
  for (const command of snapshot.commands) {
    if (!command || !IDS.has(command.id) || !['connect', 'grant', 'settings', 'check', 'disconnect'].includes(command.kind) || command.kind === 'settings' && !['files', 'phone'].includes(command.id) || !/^[A-Za-z0-9_-]{1,100}$/.test(command.commandId) || !Number.isSafeInteger(command.generation) || command.generation < 0) throw failure('INVALID_RESPONSE');
  }
  return snapshot;
}

export class ConnectionCompanion {
  constructor({ transport, probes = createLocalProbes(), statePath, intervalMs = 15000, now = Date.now, onStatus = () => {} }) {
    this.transport = transport; this.probes = probes; this.statePath = statePath;
    this.intervalMs = intervalMs; this.onStatus = onStatus;
    this.now = now; this.probed = new Map();
    this.desired = new Map(); this.running = new Map(); this.reports = new Map(); this.ack = new Set(); this.seen = new Set();
    this.closed = false; this.polling = false; this.controller = new AbortController();
  }
  async initialize() {
    if (!this.statePath) return;
    try {
      const info = await stat(this.statePath);
      if (info.size > 20000 || (info.mode & 0o077) !== 0) throw failure('PRIVATE_STATE_REQUIRED');
      const data = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (!Array.isArray(data.seen) || data.seen.length > 128 || data.seen.some(id => !/^[A-Za-z0-9_-]{1,100}$/.test(id))) throw failure('INVALID_STATE');
      this.seen = new Set(data.seen);
    } catch (error) { if (error.code !== 'ENOENT') throw failure('INVALID_STATE'); }
  }
  async remember(commandId) {
    this.seen.add(commandId);
    while (this.seen.size > 128) this.seen.delete(this.seen.values().next().value);
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = this.statePath + '.tmp';
    await writeFile(temporary, JSON.stringify({ seen: [...this.seen] }), { mode: 0o600 });
    await rename(temporary, this.statePath);
  }
  queue(desired, value) {
    const current = this.desired.get(desired.id);
    if (this.closed || !current?.enabled || current.generation !== desired.generation) return;
    this.reports.set(desired.id, { ...value, id: desired.id, generation: desired.generation });
  }
  authorize(desired, kind = 'connect') {
    if (this.running.has(desired.id)) return;
    const controller = new AbortController();
    const job = { generation: desired.generation, controller };
    this.running.set(desired.id, job);
    this.queue(desired, { state: 'awaiting_authorization', code: 'auth_pending' });
    job.promise = Promise.resolve().then(() => this.probes.connect(desired, { signal: controller.signal, kind, onProgress: value => this.queue(desired, value) }))
      .then(value => { if (!controller.signal.aborted) this.queue(desired, value); })
      .catch(() => { if (!controller.signal.aborted) this.queue(desired, { state: 'error', code: 'network_error' }); })
      .finally(() => { if (this.running.get(desired.id) === job) this.running.delete(desired.id); });
  }
  async tick() {
    if (this.closed || this.polling) return false;
    this.polling = true;
    try {
      const snapshot = parseSnapshot(await this.transport('/api/connections/bridge', undefined, this.controller.signal));
      this.desired = new Map(snapshot.desired.map(row => [row.id, row]));
      const forced = new Set();
      for (const [id, job] of this.running) {
        const desired = this.desired.get(id);
        if (!desired?.enabled || desired.generation !== job.generation) { job.controller.abort(); this.running.delete(id); }
      }
      for (const [id, value] of this.reports) {
        const desired = this.desired.get(id);
        if (!desired?.enabled || desired.generation !== value.generation) this.reports.delete(id);
      }
      for (const command of snapshot.commands) {
        this.ack.add(command.commandId);
        if (this.seen.has(command.commandId)) continue;
        await this.remember(command.commandId);
        const desired = this.desired.get(command.id);
        if (!desired?.enabled || desired.generation !== command.generation) continue;
        if (['connect', 'grant', 'settings'].includes(command.kind)) this.authorize(desired, command.kind);
        if (command.kind === 'check') forced.add(command.id);
        if (command.kind === 'disconnect') { this.running.get(command.id)?.controller.abort(); this.running.delete(command.id); }
      }
      // Independent probes run concurrently, but a service never overlaps its OAuth job.
      await Promise.all([...this.desired.values()].filter(row => {
        if (!row.enabled || this.running.has(row.id) || this.reports.has(row.id)) return false;
        const previous = this.probed.get(row.id), period = row.id === 'x' ? Math.max(60000, this.intervalMs) : this.intervalMs;
        return forced.has(row.id) || !previous || previous.generation !== row.generation || this.now() - previous.at >= period;
      }).map(async desired => {
        this.probed.set(desired.id, { generation: desired.generation, at: this.now() });
        try { this.queue(desired, await this.probes.probe(desired, this.controller.signal)); }
        catch { this.queue(desired, { state: 'error', code: 'network_error' }); }
      }));
      if (this.closed) return false;
      const reports = [...this.reports.values()], ack = [...this.ack];
      await this.transport('/api/connections/bridge/report', { reports, ack }, this.controller.signal);
      for (const value of reports) if (this.reports.get(value.id) === value) this.reports.delete(value.id);
      for (const id of ack) this.ack.delete(id);
      this.onStatus('CONNECTED');
      return true;
    } catch (error) { if (!this.closed) this.onStatus(['INVALID_RESPONSE', 'BRIDGE_AUTH_REQUIRED'].includes(error.code) ? error.code : 'BRIDGE_UNAVAILABLE'); return false; }
    finally { this.polling = false; }
  }
  async start() {
    await this.initialize();
    const loop = async () => {
      await this.tick();
      if (!this.closed) this.timer = setTimeout(loop, Math.min(2000, this.intervalMs));
    };
    await loop();
  }
  async stop() {
    this.closed = true; clearTimeout(this.timer); this.controller.abort();
    const jobs = [...this.running.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.promise));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((value, index) => value !== '--once' && value !== '--config' && args[index - 1] !== '--config') || (args.includes('--config') && !args[args.indexOf('--config') + 1])) throw failure('INVALID_ARGUMENTS');
  const configPath = args.includes('--config') ? resolve(args[args.indexOf('--config') + 1]) : join(ROOT, '.runtime/connection-companion.json');
  const config = await loadCompanionConfig(configPath);
  let lastStatus;
  const companion = new ConnectionCompanion({ transport: createBridgeTransport(config), intervalMs: config.intervalMs, statePath: join(dirname(configPath), 'connection-companion-state.json'), onStatus: status => {
    if (status !== lastStatus) { process.stdout.write('connection_companion ' + status + '\n'); lastStatus = status; }
  } });
  const stop = () => companion.stop().finally(() => process.exit(0));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  if (args.includes('--once')) { await companion.initialize(); const ok = await companion.tick(); await companion.stop(); if (!ok) process.exitCode = 1; }
  else await companion.start();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('connection_companion START_FAILED\n'); process.exitCode = 1; });
