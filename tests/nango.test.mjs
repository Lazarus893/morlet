import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNangoClient, loadNangoConfig } from '../plugins/connections/nango.mjs';

const secret = 'test-nango-secret-not-for-snapshots';
const env = { NANGO_SECRET_KEY: secret };
const timestamp = Date.parse('2026-10-23T00:00:00Z');
const attempt = 'attempt-123', owner = 'owner', instance = 'instance-test';
const ownerTag = value => createHash('sha256').update(instance + '\0' + value).digest('hex');
const baseConfig = () => ({ instanceId: instance, integrations: { github: { integrationId: 'github-readonly' }, google: { integrationId: 'google-suite' }, x: { integrationId: 'x-read' } } });
const response = (value, status = 200, headers) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const connection = (extra = {}) => ({ connection_id: 'connection-1', provider_config_key: 'github-readonly', provider: 'github', errors: [], tags: { end_user_id: ownerTag(owner), xiaoman_instance: instance, xiaoman_attempt: attempt }, credentials: { access_token: 'PRIVATE_ACCESS_TOKEN', raw: { scope: 'read:user,repo' } }, ...extra });
const args = () => ({ service: 'github', ownerId: owner, connectionId: 'connection-1' });
const session = () => ({ data: { token: 'ephemeral-session', connect_link: 'https://connect.nango.dev/?session_token=ephemeral-session', expires_at: new Date(timestamp + 30 * 60_000).toISOString() } });

function fixture({ config = baseConfig(), handle, record = connection() } = {}) {
  const calls = [];
  const client = createNangoClient({ config, env, now: () => timestamp, fetchImpl: async (url, options) => {
    const req = { url: new URL(url), ...options, json: options.body ? JSON.parse(options.body) : undefined };
    calls.push(req);
    if (handle) { const result = await handle(req, calls); if (result) return result; }
    if (req.url.pathname === '/connect/sessions' || req.url.pathname === '/connect/sessions/reconnect') return response(session(), 201);
    if (req.url.pathname === '/connections') return response({ connections: [record] });
    if (req.url.pathname === '/connections/connection-1' && req.method === 'DELETE') return response({ success: true });
    if (req.url.pathname === '/connections/connection-1') return response(record);
    if (req.url.pathname.startsWith('/proxy/')) return response({ result: 'readable' });
    throw new Error('Unexpected route');
  } });
  return { client, calls };
}

test('private config is optional; invalid, public and symlink files fail closed; keys are not serializable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nango-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(loadNangoConfig(root, { env }), null);
  const folder = join(root, '.runtime/connections'), file = join(folder, 'nango.json');
  await mkdir(folder, { recursive: true });
  await writeFile(file, JSON.stringify(baseConfig()), { mode: 0o600 });
  const loaded = loadNangoConfig(root, { env });
  assert.ok(!JSON.stringify(loaded).includes(secret));
  assert.deepEqual(createNangoClient({ config: loaded }).services(), ['github', 'google', 'x']);
  assert.throws(() => loadNangoConfig(root, { env: {} }), { code: 'NANGO_SECRET_MISSING' });
  await chmod(file, 0o644);
  assert.throws(() => loadNangoConfig(root, { env }), { code: 'NANGO_PRIVATE_CONFIG_REQUIRED' });
  await chmod(file, 0o600); await writeFile(file, '{broken');
  assert.throws(() => loadNangoConfig(root, { env }), { code: 'NANGO_INVALID_CONFIGURATION' });
  await rm(file); await writeFile(join(folder, 'other.json'), JSON.stringify(baseConfig())); await symlink(join(folder, 'other.json'), file);
  assert.throws(() => loadNangoConfig(root, { env }), { code: 'NANGO_PRIVATE_CONFIG_REQUIRED' });
});

test('configuration rejects remote HTTP, URL credentials, inline secrets and broad custom rules', () => {
  for (const extra of [{ baseUrl: 'http://nango.internal' }, { baseUrl: 'https://user:pass@nango.example' }, { baseUrl: 'https://nango.example/evil' }, { secretKey: secret }, { instanceId: '' }]) {
    assert.throws(() => createNangoClient({ config: { ...baseConfig(), ...extra }, env }), { code: 'NANGO_INVALID_CONFIGURATION' });
  }
  for (const readRule of [{ path: 'https://evil.example/a' }, { path: '/v1/items', method: 'POST' }, { path: '/v1/items', headers: { Authorization: 'Bearer no' } }, { path: '/v1/items', baseUrl: 'http://127.0.0.1' }]) {
    assert.throws(() => createNangoClient({ config: { ...baseConfig(), integrations: { custom: { integrationId: 'custom', readRules: [{ baseUrl: 'https://api.example.com', ...readRule }] } } }, env }), { code: 'NANGO_INVALID_CONFIGURATION' });
  }
});

test('Connect creates real POST contract restricted to one integration and server-derived owner/attempt tags', async () => {
  const { client, calls } = fixture();
  const value = await client.beginConnect({ service: 'github', ownerId: owner, attemptId: attempt });
  assert.deepEqual(calls[0].json, { allowed_integrations: ['github-readonly'], tags: { end_user_id: ownerTag(owner), xiaoman_instance: instance, xiaoman_attempt: attempt } });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + secret);
  assert.equal(calls[0].redirect, 'manual');
  assert.deepEqual(Object.keys(value), ['connectUrl', 'expiresAt']);
  assert.ok(!JSON.stringify(value).includes(secret));
});

test('Connect rejects unexpected connect origin and stale expiration', async () => {
  for (const data of [{ ...session().data, connect_link: 'https://evil.example/?session_token=private' }, { ...session().data, expires_at: new Date(timestamp - 1).toISOString() }]) {
    const { client } = fixture({ handle: req => req.url.pathname === '/connect/sessions' && response({ data }) });
    await assert.rejects(client.beginConnect({ service: 'github', ownerId: owner, attemptId: attempt }), { code: 'NANGO_INVALID_RESPONSE' });
  }
});

test('self-hosted Connect uses the official browser API override from trusted deployment configuration', async () => {
  const config = { ...baseConfig(), baseUrl: 'http://127.0.0.1:3303', publicApiOrigin: 'http://127.0.0.1:3403', connectOrigin: 'http://127.0.0.1:3409' };
  const f = fixture({ config, handle: req => req.url.pathname === '/connect/sessions' ? response({ data: { ...session().data, connect_link: 'http://127.0.0.1:3409/?session_token=ephemeral-session&apiURL=https://untrusted.example' } }) : undefined });
  const value = await f.client.beginConnect({ service: 'github', ownerId: owner, attemptId: attempt });
  const url = new URL(value.connectUrl);
  assert.equal(url.searchParams.get('apiURL'), 'http://127.0.0.1:3403'); assert.equal(url.origin, config.connectOrigin);
  assert.equal(f.calls[0].url.origin, config.baseUrl);
  for (const publicApiOrigin of ['http://remote.example', 'https://secret@example.test', 'https://example.test/path', 'https://example.test/?token=value']) assert.throws(() => createNangoClient({ config: { ...config, publicApiOrigin }, env }), { code: 'NANGO_INVALID_CONFIGURATION' });
});

test('findConnection polls by owner + attempt, checks returned identity, and strips credentials', async () => {
  const { client, calls } = fixture();
  const result = await client.findConnection({ service: 'github', ownerId: owner, attemptId: attempt });
  assert.equal(calls[0].url.searchParams.get('tags[end_user_id]'), ownerTag(owner));
  assert.equal(calls[0].url.searchParams.get('tags[xiaoman_attempt]'), attempt);
  assert.equal(calls.at(-1).url.searchParams.get('provider_config_key'), 'github-readonly');
  assert.deepEqual(result.scopes, ['read:user', 'repo']);
  assert.equal(result.account, null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_ACCESS_TOKEN'));
  assert.ok(!JSON.stringify(result).includes('credentials'));
  const pending = fixture({ handle: req => req.url.pathname === '/connections' && response({ connections: [] }) });
  assert.equal(await pending.client.findConnection({ service: 'github', ownerId: owner, attemptId: attempt }), null);
});

test('connection lookup starts at the zero-based first page of the real Nango API', async () => {
  const records = [connection()];
  const { client, calls } = fixture({ handle: req => {
    if (req.url.pathname !== '/connections') return;
    const offset = Number(req.url.searchParams.get('page') || 0) * Number(req.url.searchParams.get('limit') || 100);
    return response({ connections: records.slice(offset, offset + 100) });
  } });
  const result = await client.findConnection({ service: 'github', ownerId: owner, attemptId: attempt });
  assert.equal(result.connectionId, 'connection-1');
  assert.equal(calls[0].url.searchParams.get('page'), '0');
  await client.verifyConnection(args());
});

test('another owner, instance, or authorization attempt cannot bind even when Nango list filters are ignored', async () => {
  for (const tags of [{ end_user_id: ownerTag('other') }, { xiaoman_instance: 'other-instance' }, { xiaoman_attempt: 'old-attempt' }]) {
    const { client, calls } = fixture({ record: connection({ tags: { ...connection().tags, ...tags } }) });
    await assert.rejects(client.findConnection({ service: 'github', ownerId: owner, attemptId: attempt }), { code: 'NANGO_OWNER_MISMATCH' });
    assert.equal(calls.length, 1);
  }
  const { client, calls } = fixture();
  await assert.rejects(client.proxy({ ...args(), ownerId: 'another', endpoint: '/user' }), { code: 'NANGO_OWNER_MISMATCH' });
  assert.equal(calls.length, 1);
});

test('ambiguous connection results fail instead of picking an arbitrary account', async () => {
  const { client } = fixture({ handle: req => req.url.pathname === '/connections' && response({ connections: [connection(), connection({ connection_id: 'other' })] }) });
  await assert.rejects(client.findConnection({ service: 'github', ownerId: owner, attemptId: attempt }), { code: 'NANGO_AMBIGUOUS_CONNECTION' });
});

test('candidate discovery preserves all owned attempts without requesting expired credentials', async () => {
  const records = [connection({ created: '2026-10-23T00:01:00Z' }), connection({ connection_id: 'older', created: '2026-10-23T00:00:00Z', errors: [{ type: 'auth' }] })];
  const { client, calls } = fixture({ handle: req => req.url.pathname === '/connections' && response({ connections: records }) });
  const values = await client.findConnections({ service: 'github', ownerId: owner, attemptId: attempt });
  assert.equal(values.length, 2); assert.equal(values[1].state, 'expired');
  assert.equal(values[0].attemptId, attempt);
  assert.equal(values[0].createdAt, '2026-10-23T00:01:00.000Z');
  assert.equal(calls.length, 1); assert.doesNotMatch(JSON.stringify(values), /PRIVATE_ACCESS_TOKEN|credentials/);
  records[1].tags.xiaoman_attempt = 'another-attempt';
  await assert.rejects(client.findConnections({ service: 'github', ownerId: owner, attemptId: attempt }), { code: 'NANGO_OWNER_MISMATCH' });
});

test('stale-attempt cleanup and newly protected bindings cannot revoke a reconnected ID', async () => {
  const record = connection(); let protectedNow = false;
  const { client, calls } = fixture({ record, handle: req => {
    if (req.url.pathname !== '/connections') return;
    const wanted = req.url.searchParams.get('tags[xiaoman_attempt]');
    if (wanted && wanted !== record.tags.xiaoman_attempt) return response({ connections: [] });
    if (wanted) protectedNow = true;
  } });
  await client.disconnect({ ...args(), attemptId: 'old-attempt' });
  await assert.rejects(client.disconnect({ ...args(), attemptId: attempt }, { authorize: () => !protectedNow }), { code: 'NANGO_CONNECTION_PROTECTED' });
  assert.equal(calls.some(value => value.method === 'DELETE'), false);
  await client.verifyConnection(args());
  let checks = 0;
  await assert.rejects(client.disconnect({ ...args(), attemptId: attempt }, { authorize: () => ++checks < 3 }), { code: 'NANGO_CONNECTION_PROTECTED' });
  assert.equal(calls.some(value => value.method === 'DELETE'), false);
  await client.verifyConnection(args());
});

test('Proxy uses fixed provider base, allowed paths/query, no retry, and authenticated connection', async () => {
  const { client, calls } = fixture();
  assert.deepEqual(await client.proxy({ ...args(), endpoint: '/repos/org/project/commits', query: { per_page: 3, page: 1 } }), { result: 'readable' });
  const req = calls.at(-1);
  assert.equal(req.url.pathname, '/proxy/repos/org/project/commits');
  assert.equal(req.url.search, '?per_page=3&page=1');
  assert.equal(req.headers['Base-Url-Override'], 'https://api.github.com');
  assert.equal(req.headers['Provider-Config-Key'], 'github-readonly');
  assert.equal(req.headers['Connection-Id'], 'connection-1');
  assert.equal(req.headers.Retries, '0');
  assert.equal(calls.length, 3);
});

test('Proxy blocks arbitrary methods, provider URLs, encoded traversal, auth/query overrides and unknown service before network', async () => {
  const { client, calls } = fixture();
  const invalid = [
    { endpoint: 'https://evil.example/user' }, { endpoint: '//evil.example/user' },
    { endpoint: '/user/../user' }, { endpoint: '/repos/a/%2e%2e' }, { endpoint: '/repos/a/%252e%252e' }, { endpoint: '/repos/a/%2fuser' },
    { endpoint: '/user?x=1' }, { endpoint: '/repos/a/b/hooks' }, { endpoint: '/user', method: 'POST' },
    { endpoint: '/user', query: { access_token: 'injected' } }, { endpoint: '/user', headers: { Authorization: 'evil' } },
    { endpoint: '/user', service: 'missing' }, { endpoint: '/user', api: 'gmail' },
  ];
  for (const input of invalid) await assert.rejects(client.proxy({ ...args(), ...input }), e => /^NANGO_(OPERATION_FORBIDDEN|INVALID_REQUEST|SERVICE_NOT_CONFIGURED)$/.test(e.code));
  assert.equal(calls.length, 0);
});

test('Google APIs choose fixed distinct hosts and preserve encoded calendar IDs and sheet ranges', async () => {
  for (const [api, endpoint, query, base] of [
    ['gmail', '/gmail/v1/users/me/threads/abc', { format: 'full' }, 'https://gmail.googleapis.com'],
    ['calendar', '/calendar/v3/calendars/user%40example.com/events', { singleEvents: true }, 'https://www.googleapis.com'],
    ['drive', '/drive/v3/files/abc', { fields: 'id,name' }, 'https://www.googleapis.com'],
    ['docs', '/v1/documents/abc', {}, 'https://docs.googleapis.com'],
    ['sheets', '/v4/spreadsheets/abc/values/Sheet1!A1%3AB10', {}, 'https://sheets.googleapis.com'],
    ['people', '/v1/people:searchContacts', { query: 'Tony', readMask: 'names,emailAddresses' }, 'https://people.googleapis.com'],
  ]) {
    const { client, calls } = fixture({ record: connection({ provider_config_key: 'google-suite', provider: 'google' }) });
    await client.proxy({ ...args(), service: 'google', api, endpoint, query });
    assert.equal(calls.at(-1).headers['Base-Url-Override'], base);
  }
});

test('Google service-specific integration cannot call another Google API', async () => {
  const config = { instanceId: instance, integrations: { 'google-mail': { integrationId: 'gmail-only' } } };
  const { client, calls } = fixture({ config, record: connection({ provider_config_key: 'gmail-only', provider: 'google-mail' }) });
  await client.proxy({ ...args(), service: 'google-mail', api: 'gmail', endpoint: '/gmail/v1/users/me/profile' });
  const count = calls.length;
  await assert.rejects(client.proxy({ ...args(), service: 'google-mail', api: 'drive', endpoint: '/drive/v3/files' }), { code: 'NANGO_OPERATION_FORBIDDEN' });
  assert.equal(calls.length, count);
});

test('X timeline path and query are available without granting write APIs', async () => {
  const { client, calls } = fixture({ record: connection({ provider_config_key: 'x-read', provider: 'twitter-v2' }) });
  await client.proxy({ ...args(), service: 'x', endpoint: '/2/users/123/timelines/reverse_chronological', query: { max_results: 5, 'post.fields': 'created_at,text', expansions: 'author_id' } });
  assert.equal(calls.at(-1).headers['Base-Url-Override'], 'https://api.x.com');
  await assert.rejects(client.proxy({ ...args(), service: 'x', endpoint: '/2/tweets', method: 'POST', body: { text: 'no' } }), { code: 'NANGO_OPERATION_FORBIDDEN' });
});

test('custom integrations allow only explicitly configured GET paths and headers', async () => {
  const config = { instanceId: instance, integrations: { custom: { integrationId: 'custom-api', readRules: [{ baseUrl: 'https://api.example.com', path: '/v1/items/:id', query: ['fields'], headers: { 'Example-Version': '2026-01-01' } }] } } };
  const { client, calls } = fixture({ config, record: connection({ provider_config_key: 'custom-api', provider: 'custom' }) });
  await client.proxy({ ...args(), service: 'custom', endpoint: '/v1/items/123', query: { fields: 'title' } });
  assert.equal(calls.at(-1).headers['Base-Url-Override'], 'https://api.example.com');
  assert.equal(calls.at(-1).headers['Example-Version'], '2026-01-01');
  await assert.rejects(client.proxy({ ...args(), service: 'custom', endpoint: '/v1/admin' }), { code: 'NANGO_OPERATION_FORBIDDEN' });
});

test('configured write routes require the server-side exact-action approval callback', async () => {
  const config = { instanceId: instance, integrations: { github: { integrationId: 'github-readonly', writeRules: [{ baseUrl: 'https://api.github.com', path: '/repos/:owner/:repo/issues', method: 'POST' }] } } };
  const { client, calls } = fixture({ config });
  await assert.rejects(client.proxy({ ...args(), endpoint: '/repos/org/project/issues', method: 'POST', body: { title: 'Draft' }, approval: true }), { code: 'NANGO_APPROVAL_REQUIRED' });
  assert.equal(calls.filter(c => c.url.pathname.startsWith('/proxy')).length, 0);
  let approved;
  const authorized = createNangoClient({ config, env, authorizeWrite: action => { approved = action; return action.approval === 'ledger-approved-exact-action'; }, fetchImpl: async (url, options) => {
    if (url.includes('/proxy/')) return response({ id: 1 });
    return response(new URL(url).pathname === '/connections' ? { connections: [connection()] } : connection());
  } });
  await authorized.proxy({ ...args(), endpoint: '/repos/org/project/issues', method: 'POST', body: { title: 'Draft' }, approval: 'ledger-approved-exact-action' });
  assert.equal(approved.ownerId, owner);
  assert.deepEqual(approved.body, { title: 'Draft' });
});

test('approval sees all repeated query values and cannot mutate the already captured write payload', async () => {
  let action, sent;
  const config = { instanceId: instance, integrations: { custom: { integrationId: 'github-readonly', writeRules: [{ baseUrl: 'https://api.example.com', path: '/items', query: ['id'], method: 'POST' }] } } };
  const client = createNangoClient({ config, env, authorizeWrite: value => { action = structuredClone(value); value.body.title = 'mutated'; return true; }, fetchImpl: async (url, options) => {
    if (url.includes('/proxy/')) { sent = JSON.parse(options.body); return response({ ok: true }); }
    return response(new URL(url).pathname === '/connections' ? { connections: [connection()] } : connection());
  } });
  await client.proxy({ ...args(), service: 'custom', endpoint: '/items', method: 'POST', query: { id: ['one', 'two'] }, body: { title: 'approved' } });
  assert.deepEqual(action.query, { id: ['one', 'two'] }); assert.deepEqual(sent, { title: 'approved' });
});

test('expired connections fail reads but allow owned reconnect without exporting credentials', async () => {
  const { client, calls } = fixture({ record: connection({ errors: [{ type: 'auth' }] }) });
  await assert.rejects(client.proxy({ ...args(), endpoint: '/user' }), { code: 'NANGO_AUTH_REQUIRED' });
  assert.equal(calls.filter(c => c.url.pathname.startsWith('/proxy')).length, 0);
  const result = await client.reconnect({ ...args(), attemptId: 'new-attempt' });
  assert.ok(result.connectUrl);
  assert.equal(calls.at(-1).url.pathname, '/connect/sessions/reconnect');
  assert.equal(calls.at(-1).json.connection_id, 'connection-1');
  assert.equal(calls.at(-1).json.tags.xiaoman_attempt, 'new-attempt');
});

test('upstream auth/rate-limit/network errors are classified without exposing bodies, URLs or keys', async () => {
  for (const [status, code] of [[401, 'NANGO_AUTH_REQUIRED'], [403, 'NANGO_FORBIDDEN'], [424, 'NANGO_AUTH_REQUIRED'], [429, 'NANGO_RATE_LIMITED'], [500, 'NANGO_UNAVAILABLE']]) {
    const { client } = fixture({ handle: req => req.url.pathname.startsWith('/proxy/') && response({ error: { message: secret + ' provider-private-data' } }, status, { 'retry-after': '12' }) });
    await assert.rejects(client.proxy({ ...args(), endpoint: '/user' }), error => {
      assert.equal(error.code, code); assert.equal(error.status, status);
      assert.ok(!String(error).includes(secret)); assert.ok(!JSON.stringify(error).includes('provider-private-data'));
      if (status === 429) assert.equal(error.retryAfterSeconds, 12);
      return true;
    });
  }
  const network = fixture({ handle: () => { throw new Error(secret); } });
  await assert.rejects(network.client.verifyConnection(args()), { code: 'NANGO_UNAVAILABLE', message: 'NANGO_UNAVAILABLE' });
});

test('response bounds and redirects reject before data reaches the caller', async () => {
  for (const result of [new Response('x', { status: 302, headers: { location: 'https://evil.example' } }), response({ data: 'x'.repeat(1100) }), new Response('not-json')]) {
    const { client } = fixture({ config: { ...baseConfig(), maxResponseBytes: 1024 }, handle: req => req.url.pathname.startsWith('/proxy/') && result });
    await assert.rejects(client.proxy({ ...args(), endpoint: '/user' }), e => ['NANGO_REDIRECT_REJECTED', 'NANGO_RESPONSE_TOO_LARGE', 'NANGO_INVALID_RESPONSE'].includes(e.code));
  }
});

test('provider API-disabled and credits errors stay distinct without copying upstream details', async () => {
  const disabled = fixture({ handle: req => req.url.pathname.startsWith('/proxy/') && response({ error: { message: 'private project details', details: [{ reason: 'SERVICE_DISABLED' }] } }, 403) });
  await assert.rejects(disabled.client.proxy({ ...args(), endpoint: '/user' }), { code: 'NANGO_API_DISABLED', message: 'NANGO_API_DISABLED' });
  const credits = fixture({ handle: req => req.url.pathname.startsWith('/proxy/') && response({ detail: 'private billing details' }, 402) });
  await assert.rejects(credits.client.proxy({ ...args(), endpoint: '/user' }), { code: 'NANGO_CREDITS_REQUIRED', message: 'NANGO_CREDITS_REQUIRED' });
});

test('timeout and caller cancellation abort fetch without automatic retry', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const { client, calls } = fixture({ config: { ...baseConfig(), timeoutMs: 10 }, handle: req => new Promise((resolve, reject) => {
      req.signal.addEventListener('abort', () => reject(new Error('aborted private details')), { once: true });
      if (cancel) controller.abort();
    }) });
    await assert.rejects(client.verifyConnection({ ...args(), signal: controller.signal }), { code: cancel ? 'NANGO_CANCELLED' : 'NANGO_TIMEOUT' });
    assert.equal(calls.length, 1);
  }
});

test('disconnect fences in-flight reads immediately and stays revoked if remote deletion fails', async () => {
  let started, finish;
  const running = new Promise(resolve => { started = resolve; });
  const { client, calls } = fixture({ handle: req => {
    if (req.url.pathname.startsWith('/proxy/')) { started(); return new Promise(resolve => { finish = () => resolve(response({ private: 'late result' })); }); }
    if (req.method === 'DELETE') return response({ error: { message: 'unavailable' } }, 503);
  } });
  const read = client.proxy({ ...args(), endpoint: '/user' });
  await running;
  await assert.rejects(client.disconnect(args()), { code: 'NANGO_UNAVAILABLE' });
  finish();
  await assert.rejects(read, { code: 'NANGO_CONNECTION_REVOKED' });
  const count = calls.length;
  await assert.rejects(client.proxy({ ...args(), endpoint: '/user' }), { code: 'NANGO_CONNECTION_REVOKED' });
  assert.equal(calls.length, count);
});

test('disconnect verifies owner before deleting and treats an already missing connection as removed', async () => {
  const wrong = fixture();
  await assert.rejects(wrong.client.disconnect({ ...args(), ownerId: 'other' }), { code: 'NANGO_OWNER_MISMATCH' });
  assert.equal(wrong.calls.some(c => c.method === 'DELETE'), false);
  const missing = fixture({ handle: req => req.url.pathname === '/connections' && response({ connections: [] }) });
  assert.deepEqual(await missing.client.disconnect(args()), { disconnected: true });
  const { client, calls } = fixture();
  assert.deepEqual(await client.disconnect(args()), { disconnected: true });
  assert.equal(calls.at(-1).url.searchParams.get('provider_config_key'), 'github-readonly');
  assert.equal(calls.at(-1).method, 'DELETE');
});
