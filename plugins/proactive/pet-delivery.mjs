import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { bridgeTransport, validateBridgeConfig } from '../agent-hub/companion.mjs';

const exec = promisify(execFile);
const failure = code => Object.assign(new Error(code), { code });
const hash = text => createHash('sha256').update(text).digest('hex');
const validPet = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
function privateJSON(path) {
  const s = statSync(path);
  if (!s.isFile() || s.mode & 0o077 || s.uid !== process.getuid() || s.size > 16384) throw failure('PRIVATE_CONFIG_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function loadPetConfig(path) {
  const c = privateJSON(path);
  if (Object.keys(c).some(k => !['endpoint', 'publicOrigin', 'token', 'petId', 'hostExecutable', 'hostArguments', 'helperExecutable', 'chatConfig'].includes(k)) || !validPet(c.petId)
    || c.hostArguments !== undefined && (!Array.isArray(c.hostArguments) || !c.hostArguments.length || c.hostArguments.length > 8 || c.hostArguments.some(a => typeof a !== 'string' || !a || a.length > 2048 || /[\x00-\x1f]/.test(a)) || !isAbsolute(c.hostArguments[0]))
    || c.chatConfig !== undefined && (typeof c.chatConfig !== 'string' || !isAbsolute(c.chatConfig))
    || ![c.hostExecutable, c.helperExecutable].every(p => typeof p === 'string' && isAbsolute(p) && p.length < 1024)) throw failure('INVALID_CONFIG');
  return { ...c, ...validateBridgeConfig(c) };
}

// Discover the existing DSH desktop listener after every restart. Do not scan
// arbitrary ports or loosen DSH's browser access gate when it refuses a request.
export async function discoverPetOrigin(config, { execute = exec, uid = process.getuid() } = {}) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'uid=,pid=,comm='], { timeout: 5000, maxBuffer: 512000 });
  const processes = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(m => m && Number(m[1]) === uid);
  if (!processes.some(m => m[3] === config.helperExecutable)) throw failure('PET_OFFLINE');
  const hosts = processes.filter(m => m[3] === config.hostExecutable);
  const origins = new Set();
  for (const host of hosts) {
    if (config.hostArguments) {
      const actual = await execute('/bin/ps', ['-p', host[2], '-o', 'command='], { timeout: 5000 });
      if (actual.stdout.trim() !== [config.hostExecutable, ...config.hostArguments].join(' ')) continue;
      let ownHelper = false;
      for (const helper of processes.filter(m => m[3] === config.helperExecutable)) {
        const parent = await execute('/bin/ps', ['-p', helper[2], '-o', 'ppid='], { timeout: 5000 });
        if (parent.stdout.trim() === host[2]) ownHelper = true;
      }
      if (!ownHelper) continue;
    }
    let output;
    try { output = await execute('/usr/sbin/lsof', ['-a', '-p', host[2], '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-Fn'], { timeout: 5000, maxBuffer: 16384 }); }
    catch (error) { if (error.code === 1 && !error.stdout?.trim()) continue; throw failure('PET_UNAVAILABLE'); }
    for (const line of output.stdout.split('\n')) {
      const match = /^n127\.0\.0\.1:(\d+)$/.exec(line);
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) origins.add('http://127.0.0.1:' + match[1]);
    }
  }
  if (origins.size !== 1) throw failure('PET_OFFLINE');
  return [...origins][0];
}

export async function petRequest(origin, route, { method = 'GET', body, signal, fetcher = fetch } = {}) {
  const base = new URL(origin);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw failure('INVALID_CONFIG');
  if (!/^\/(config|state|broadcast\?pet=[a-zA-Z0-9_-]{1,80})$/.test(route)) throw failure('INVALID_ROUTE');
  const response = await fetcher(new URL('/dsh-pet-7340' + route, base), { method, redirect: 'error',
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]),
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw failure('PET_UNAVAILABLE'); }
  let bytes = 0, chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw failure('PET_UNAVAILABLE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('PET_UNAVAILABLE'); }
}

export function createPetClient(config, { discover = () => discoverPetOrigin(config), request = petRequest } = {}) {
  return {
    async probe(signal) {
      const origin = await discover(), cfg = await request(origin, '/config', { signal });
      const pets = Object.values(cfg).flatMap(entry => Array.isArray(entry?.pets) ? entry.pets : []);
      if (!pets.some(p => p.id === config.petId && ['desktop', 'both'].includes(p.display))) throw failure('PET_OFFLINE');
      return origin;
    },
    async broadcast(origin, message, signal) {
      const text = '小满 · ' + message;
      const before = await request(origin, '/state', { signal });
      // The official host starts with pets: {} and creates say on first use.
      if (!before.pets || typeof before.pets !== 'object' || Array.isArray(before.pets)) throw failure('PET_UNAVAILABLE');
      const previous = before.pets[config.petId]?.say;
      const counter = previous === undefined ? 0 : previous.counter;
      if (!Number.isSafeInteger(counter) || counter < 0) throw failure('PET_UNAVAILABLE');
      const receipt = await request(origin, '/broadcast?pet=' + config.petId, { method: 'POST', body: { text }, signal });
      if (receipt.ok !== true) return { state: 'failed' };
      const after = await request(origin, '/state', { signal });
      const say = after.pets?.[config.petId]?.say;
      // This is host acceptance only; the pet API has no renderer/read receipt.
      return say?.data?.text === text && Number.isSafeInteger(say.counter) && say.counter > counter
        ? { state: 'submitted', counter: say.counter, textHash: hash(text) } : { state: 'unknown' };
    },
  };
}

export class PetDelivery {
  constructor({ config, statePath, client = createPetClient(config), transport = bridgeTransport(config, { operations: ['status', 'poll', 'ack'], prefix: '/api/message-bridge/', header: 'X-PA-Channel-Token' }), now = Date.now }) {
    Object.assign(this, { config, statePath, client, transport, now });
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    this.state = { pending: null };
    try { this.state = privateJSON(statePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const p = this.state.pending;
    if (p && (typeof p.id !== 'string' || p.id.length > 100 || !['unknown', 'submitted', 'failed'].includes(p.state))) throw failure('PRIVATE_STATE_REQUIRED');
  }
  save() { writeFileSync(this.statePath + '.tmp', JSON.stringify(this.state), { mode: 0o600 }); renameSync(this.statePath + '.tmp', this.statePath); }
  async ack(signal) {
    if (!this.state.pending) return;
    await this.transport('ack', { deliveryId: this.state.pending.id, state: this.state.pending.state }, signal);
    this.state.pending = null; this.save();
  }
  async tick(signal) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.ack(signal);
      let origin;
      try { origin = await this.client.probe(signal); }
      catch {
        await this.transport('status', { ready: false, peer: this.config.petId, error: 'PET_OFFLINE' }, signal); return;
      }
      await this.transport('status', { ready: true, peer: this.config.petId }, signal);
      const { delivery } = await this.transport('poll', {}, signal);
      if (!delivery) return;
      if (delivery.peer !== this.config.petId || typeof delivery.id !== 'string' || delivery.id.length > 100 || typeof delivery.text !== 'string' || !delivery.text.trim() || delivery.text.length > 16000) throw failure('INVALID_DELIVERY');
      // The upstream broadcast API is not idempotent. Persist uncertainty before
      // calling it; after crashes/timeouts only acknowledge, never broadcast again.
      this.state.pending = { id: delivery.id, state: 'unknown' }; this.save();
      let result;
      const characters = Array.from(delivery.text);
      const bubble = characters.length > 500 ? characters.slice(0, 420).join('') + '…\n完整回复在小满「消息与任务」。' : delivery.text;
      try { result = await this.client.broadcast(origin, bubble, signal); }
      catch { result = { state: 'unknown' }; }
      this.state.pending = { id: delivery.id, ...result };
      this.state.last = { ...this.state.pending, at: this.now() }; this.save();
      appendFileSync(this.statePath + '.jsonl', JSON.stringify(this.state.last) + '\n', { mode: 0o600 });
      await this.ack(signal);
    } finally { this.ticking = false; }
  }
  async stop() { await this.transport('status', { ready: false, peer: this.config.petId, error: 'PET_BRIDGE_STOPPED' }); }
}
