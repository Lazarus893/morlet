import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../plugins/webui/public/transport.js', import.meta.url), 'utf8');
const reply = value => ({ ok: true, json: async () => value });
function client(fetch, options = {}, timers = {}) {
  const context = vm.createContext({ window: {}, AbortController, setTimeout, clearTimeout, ...timers });
  vm.runInContext(source, context);
  return context.window.PATransport.create({ fetch, ...options });
}

test('request IDs work on intranet HTTP without crypto.randomUUID', () => {
  const context = vm.createContext({ window: {}, crypto: { getRandomValues: bytes => webcrypto.getRandomValues(bytes) } });
  vm.runInContext(source, context);
  const ids = Array.from({ length: 100 }, () => context.window.PATransport.requestId());
  assert.equal(context.crypto.randomUUID, undefined);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)));
});

test('a restarted page session recovers through reads and refreshes CSRF without reloading the page', async () => {
  const calls = [], sessions = []; let restored = false;
  const c = client(async (path, options) => {
    calls.push({ path, options });
    if (path === '/') { restored = true; return { ok: true }; }
    return reply(restored ? { ok: true, data: { csrf: 'fresh-page-token', runtime: { state: 'running' } } } : { ok: false, error: 'FORBIDDEN' });
  }, { onSession: state => sessions.push(state) });
  assert.equal((await c.api('state')).csrf, 'fresh-page-token');
  assert.equal(sessions.length, 1);
  assert.deepEqual(calls.map(x => x.path), ['/api/state', '/', '/api/state']);
  assert.ok(calls.every(x => x.options.credentials === 'same-origin' && !x.options.method));
});

test('concurrent expired reads share one page handshake and retry only their own reads', async () => {
  const calls = []; let restored = false;
  const c = client(async path => {
    calls.push(path);
    if (path === '/') { await new Promise(resolve => setImmediate(resolve)); restored = true; return { ok: true }; }
    if (path === '/api/state') return reply({ ok: true, data: { csrf: 'fresh' } });
    return reply(restored ? { ok: true, data: { path } } : { ok: false, error: 'FORBIDDEN' });
  });
  const results = await Promise.all([c.api('hub'), c.api('journal')]);
  assert.deepEqual(results.map(x => x.path), ['/api/hub', '/api/journal']);
  assert.equal(calls.filter(x => x === '/').length, 1);
  assert.equal(calls.filter(x => x === '/api/state').length, 1);
});

test('a forbidden write is never replayed or silently converted into a successful save', async () => {
  const calls = [];
  const c = client(async (path, options) => { calls.push({ path, options }); return reply({ ok: false, error: 'FORBIDDEN' }); }, { getCSRF: () => 'original-csrf' });
  await assert.rejects(c.api('hub', { operation: 'send', requestId: 'same-request' }), error => error.code === 'FORBIDDEN');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-PA-CSRF'], 'original-csrf');
  assert.equal(JSON.parse(calls[0].options.body).requestId, 'same-request');
});

test('a lost write response reports uncertainty without making a second request', async () => {
  let posts = 0;
  const c = client(async () => { posts++; throw new TypeError('Network response lost'); });
  await assert.rejects(c.api('hub', { operation: 'send', requestId: 'stable-key' }), error => error.code === 'NETWORK_UNAVAILABLE' && error.message.includes('尚未确认'));
  assert.equal(posts, 1);
});

test('a timed-out read aborts its actual fetch and permits a later fresh read', async () => {
  let fail = true, observedAbort = false;
  const c = client(async (_path, options) => {
    if (!fail) return reply({ ok: true, data: { recovered: true } });
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { observedAbort = true; reject(new DOMException('aborted', 'AbortError')); }, { once: true }));
  }, {}, { setTimeout: fn => setTimeout(fn, 5) });
  await assert.rejects(c.api('state'), error => error.code === 'REQUEST_TIMEOUT');
  assert.equal(observedAbort, true); fail = false;
  assert.equal((await c.api('state')).recovered, true);
});

test('an invalid recovery response never refreshes page authority or retries a write', async () => {
  let sessions = 0;
  const c = client(async path => path === '/' ? { ok: true } : reply(path === '/api/state' ? { ok: true, data: { csrf: '' } } : { ok: false, error: 'FORBIDDEN' }), { onSession: () => sessions++ });
  await assert.rejects(c.api('hub'), error => error.code === 'FORBIDDEN');
  assert.equal(sessions, 0);
});
