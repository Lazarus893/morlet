import { ownerSession } from './owner-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createWebUI } from '../plugins/webui/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'connections-http-'));
  const app = createWebUI({ root, helper: async () => ({ revision: 'test', socket: join(root, 'offline.sock'), pending: [], capabilities: [], config: { agent: { provider: 'dsh' }, im: { provider: 'disabled' }, proactive: { enabled: false } } }), rpc: async () => { throw new Error('offline'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const home = await ownerSession(root, origin), cookie = home.headers.get('set-cookie').split(';')[0];
  const initial = await fetch(origin + '/api/state', { headers: { Cookie: cookie } }).then(r => r.json());
  assert.equal(initial.ok, true);
  const request = async (route, input, headers = {}, authenticated = true) => {
    const res = await fetch(origin + route, { method: input === undefined ? 'GET' : 'POST', headers: { ...(authenticated ? { Cookie: cookie, Origin: origin, 'X-PA-CSRF': initial.data.csrf } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: res.status, ...await res.json() };
  };
  t.after(async () => { await app.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { origin, request };
}

test('connection writes require the browser session and CSRF; pairing secret is returned once', async t => {
  const f = await fixture(t);
  const initial = await f.request('/api/connections');
  assert.equal(initial.data.items.length, 5);
  const pair = { operation: 'pair', revision: initial.data.revision, values: { name: '当前 Mac' } };
  assert.equal((await f.request('/api/connections', pair, {}, false)).status, 403);
  assert.equal((await f.request('/api/connections', pair, { 'X-PA-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/connections', pair, { Origin: 'https://evil.invalid' })).status, 403);
  const result = await f.request('/api/connections', pair);
  assert.equal(result.status, 200); assert.match(result.data.token, /^[a-f0-9]{64}$/);
  assert.equal((await f.request('/api/connections', pair)).status, 409);
  const snapshot = await f.request('/api/connections');
  assert.ok(!JSON.stringify(snapshot).includes(result.data.token));
  assert.ok(!JSON.stringify(snapshot).includes('hash'));
});

test('bridge credential remains scoped and is revoked by unpair', async t => {
  const f = await fixture(t);
  const pair = await f.request('/api/connections', { operation: 'pair', revision: 0, values: { name: 'Mac' } });
  const headers = { 'X-PA-Bridge-Token': pair.data.token };
  assert.equal((await f.request('/api/connections/bridge', undefined, {}, false)).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(f.origin + '/api/connections/bridge', { headers: { ...headers, Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.request('/api/connections/bridge', undefined, headers, false)).status, 200);
  assert.equal((await f.request('/api/state', undefined, headers, false)).status, 403);
  assert.equal((await f.request('/api/config', {}, headers, false)).status, 403);
  assert.equal((await f.request('/api/device', {}, headers, false)).status, 403);
  assert.equal((await f.request('/api/connections/bridge/report', { reports: [], ack: [] }, headers, false)).status, 200);
  assert.equal((await f.request('/api/connections')).data.bridge.online, true);
  await f.request('/api/connections', { operation: 'unpair', revision: 1 });
  assert.equal((await f.request('/api/connections/bridge', undefined, headers, false)).status, 403);
});

test('file grant requires explicit scope, late reports cannot restore revoked authorization', async t => {
  const f = await fixture(t);
  const paired = await f.request('/api/connections', { operation: 'pair', revision: 0, values: { name: 'Mac' } });
  const headers = { 'X-PA-Bridge-Token': paired.data.token };
  assert.equal((await f.request('/api/connections', { operation: 'connect', id: 'files', revision: 1 })).status, 400);
  const granted = await f.request('/api/connections', { operation: 'grant', id: 'files', revision: 1, values: { scope: 'all-readable-files' } });
  assert.equal(granted.status, 200);
  const desired = (await f.request('/api/connections/bridge', undefined, headers, false)).data.desired.find(item => item.id === 'files');
  await f.request('/api/connections', { operation: 'disconnect', id: 'files', revision: granted.data.revision });
  const report = { id: 'files', generation: desired.generation, state: 'connected', code: 'ok', permissions: [{ id: 'readable', granted: true, verified: true }] };
  assert.equal((await f.request('/api/connections/bridge/report', { reports: [report] }, headers, false)).status, 200);
  const current = (await f.request('/api/connections')).data.items.find(item => item.id === 'files');
  assert.equal(current.state, 'revoked'); assert.equal(current.permissions.some(permission => permission.verified), false);
  assert.equal((await f.request('/api/connections/bridge/report', { reports: [{ ...report, code: 'SECRET_RAW_ERROR' }] }, headers, false)).status, 400);
});
