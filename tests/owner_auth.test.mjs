import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWebUI } from '../plugins/webui/server.mjs';
import { setOwnerPassword, OWNER_EMAIL } from '../plugins/webui/owner-auth.mjs';

test('owner login gates private data, persists across restart, rejects signup and revokes sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-auth-'));
  const options = { root, helper: async () => ({ revision: 'test', config: { agent: { provider: 'dsh' }, im: { provider: 'disabled', allow_from: [] }, proactive: { enabled: false } } }), rpc: async () => { throw new Error('offline'); } };
  let app, origin;
  const start = async () => { app = createWebUI(options); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); origin = 'http://127.0.0.1:' + app.server.address().port; };
  await start(); t.after(async () => { await app.shutdown(); await rm(root, { recursive: true, force: true }); });
  const home = await fetch(origin); assert.equal(home.headers.get('set-cookie'), null); assert.match(await home.text(), /主人密码/);
  const state = cookie => fetch(origin + '/api/state', { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal((await state()).status, 403);
  const post = (path, data = {}, cookie, extra = {}) => fetch(origin + '/api/auth/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie && { Cookie: cookie }), ...extra }, body: JSON.stringify(data) });
  assert.equal((await post('sign-up/email', { email: OWNER_EMAIL, password: 'takeover-password-1234', name: 'attacker' })).status, 404);
  const password = 'owner-fixture-password-1234'; await setOwnerPassword({ root, password });
  assert.equal((await post('sign-in/email', { email: OWNER_EMAIL, password }, null, { Origin: 'https://evil.invalid' })).status, 403);
  const login = async () => { const response = await post('sign-in/email', { email: OWNER_EMAIL, password }); assert.equal(response.status, 200, await response.clone().text()); return response.headers.get('set-cookie').split(';')[0]; };
  const first = await login(), second = await login(); assert.equal((await state(first)).status, 200);
  assert.equal((await post('revoke-other-sessions', {}, first)).status, 200);
  assert.equal((await state(second)).status, 403); assert.equal((await state(first)).status, 200);
  await app.shutdown(); await start(); assert.equal((await state(first)).status, 200, 'restart must not require an unauthenticated root cookie');
  assert.equal((await post('sign-out', {}, first)).status, 200); assert.equal((await state(first)).status, 403);
  const third = await login(); await setOwnerPassword({ root, password: 'new-fixture-password-2345', reset: true });
  assert.equal((await state(third)).status, 403, 'local password recovery revokes every old session');
});

test('login is throttled using the socket address, not forged forwarding headers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-limit-'));
  const app = createWebUI({ root }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.shutdown(); await rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  for (let n = 0; n < 7; n++) {
    const r = await fetch(origin + '/api/auth/sign-in/email', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.' + n, 'X-PA-Client-Address': '10.1.0.' + n }, body: JSON.stringify({ email: OWNER_EMAIL, password: 'wrong-password-1234' }) });
    if (n >= 5) assert.equal(r.status, 429);
  }
});

test('a remote plaintext deployment cannot accept a password', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-http-'));
  const publicOrigin = 'http://fixture.example:3083', app = createWebUI({ root, publicOrigin });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.shutdown(); await rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const response = await fetch(origin + '/api/auth/sign-in/email', { method: 'POST', headers: { Host: 'fixture.example:3083', Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: 'unused-fixture-password' }) });
  assert.equal(response.status, 403); assert.equal(response.headers.get('set-cookie'), null);
});
