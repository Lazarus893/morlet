import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { createConnectionManager } from '../plugins/connections/manager.mjs';
import { routedSourcesTool, sourceBridgeInventory } from '../plugins/agent-hub/source-bridge.mjs';
import { readLocalSource, validateSourceArguments } from '../plugins/agent-hub/sources.mjs';
import { cloudSourceInventory, readCloudSource, readCloudMail } from '../plugins/agent-hub/cloud-source-routing.mjs';
import { sourceCoverage } from '../plugins/agent-hub/reports.mjs';

const env = { NANGO_SECRET_KEY: 'fixture-private-server-key' };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const paused = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), release: () => resolve() }; };

function fixture(t, { paired = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xiaoman-cloud-source-'));
  let now = Date.now();
  const hub = new AgentHub(root, { now: () => now }), token = 't'.repeat(48);
  hub.registerHost({ id: 'server', label: 'Server', provider: 'dsh' }, token);
  const conversation = hub.newConversation({ endpointId: 'server' });
  hub.submit({ conversationId: conversation.id, content: 'Read connected data', requestId: 'request' });
  const job = hub.poll(token, { runnerId: 'runner' }).job;
  if (paired) {
    const local = hub.pair({ label: 'Offline Mac' });
    writeFileSync(join(root, '.runtime/agent-hub.json'), JSON.stringify({ version: 1, agents: [], roles: {}, sourceBridge: { endpointId: local.endpointId, operations: ['review_requests', 'github_repositories', 'mail_read'] } }), { mode: 0o600 });
  }
  const manager = createConnectionManager({ root, now: () => now, cloudServices: ['github', 'google', 'x'] });
  const config = { instanceId: 'fixture', integrations: { github: { integrationId: 'github-pat' }, google: { integrationId: 'google-suite' }, x: { integrationId: 'x-read' } } };
  writeFileSync(join(root, '.runtime/connections/nango.json'), JSON.stringify(config), { mode: 0o600 });
  const connect = (id, account, permissions, scopes = []) => {
    const { item } = manager.cloudBegin({ id, operation: 'connect', revision: manager.snapshot().revision });
    manager.cloudUpdate(id, item.generation, { binding: { service: id, ownerId: 'owner', connectionId: id + '-connection', integrationId: config.integrations[id].integrationId, scopes },
      account, permissions: permissions.map(id => ({ id, granted: true, verified: true })), state: 'connected', checkedAt: new Date(now).toISOString() });
  };
  connect('github', 'FixtureOwner', ['repos']);
  const calls = []; let intercept;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname, request = { path, url: new URL(url), options }; calls.push(request);
    if (intercept) { const response = await intercept(request); if (response) return response; }
    const service = options.headers['Provider-Config-Key'] === 'google-suite' ? 'google' : options.headers['Provider-Config-Key'] === 'x-read' ? 'x' :
      path.includes('google-connection') || new URL(url).searchParams.get('connectionId') === 'google-connection' ? 'google' :
      path.includes('x-connection') || new URL(url).searchParams.get('connectionId') === 'x-connection' ? 'x' : 'github';
    const record = { connection_id: service + '-connection', provider_config_key: config.integrations[service].integrationId, provider: service === 'github' ? 'github-pat' : service,
      tags: { end_user_id: createHash('sha256').update('fixture\0owner').digest('hex'), xiaoman_instance: 'fixture' }, errors: [],
      credentials: { api_key: 'UPSTREAM-PRIVATE', scope: service === 'google' ? 'https://www.googleapis.com/auth/gmail.readonly' : service === 'x' ? 'tweet.read' : '' } };
    if (path === '/connections') return reply({ connections: [record] });
    if (path.startsWith('/connections/')) return reply(record);
    if (path === '/proxy/user') return reply({ login: 'FixtureOwner' });
    if (path === '/proxy/search/issues') return reply({ items: [], total_count: 0, incomplete_results: false });
    if (path === '/proxy/oauth2/v2/userinfo') return reply({ email: 'fixture@example.test', verified_email: true });
    if (path === '/proxy/gmail/v1/users/me/messages') return reply({ messages: [{ id: 'abc', threadId: 'def' }] });
    if (path === '/proxy/gmail/v1/users/me/messages/abc') return reply({ id: 'abc', threadId: 'def', internalDate: String(now), payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Real fixture body' }, { name: 'From', value: 'sender@example.test' }], body: { data: Buffer.from('Readable full text').toString('base64url'), size: 18 } } });
    if (path === '/proxy/notifications') return reply([]);
    if (path === '/proxy/2/users/me') return reply({ data: { id: '123', username: 'fixture' } });
    if (path === '/proxy/2/users/123/timelines/reverse_chronological') return reply({ data: [], meta: { result_count: 0 } });
    throw new Error('Unexpected mocked REST endpoint');
  };
  const call = (args = { operation: 'review_requests' }, callId = 'call-1', extra = {}) => routedSourcesTool({ root, hub, token, env, fetchImpl, input: { runId: job.id, lease: job.lease, callId, arguments: args }, ...extra });
  const disconnect = (id = 'github') => manager.cloudBegin({ id, operation: 'disconnect', revision: manager.snapshot().revision });
  t.after(() => { manager.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, hub, manager, job, config, calls, call, connect, disconnect, fetchImpl, intercept: fn => { intercept = fn; }, advance: ms => { now += ms; } };
}

test('Nango uses actual REST transport, skips offline Mac and persists a reusable source receipt', async t => {
  const f = fixture(t, { paired: true });
  const [a, b] = await Promise.all([f.call(), f.call()]);
  assert.deepEqual(a, b); assert.equal(a.execution.location, 'nango');
  assert.equal(f.calls.filter(c => c.path === '/proxy/search/issues').length, 1);
  assert.equal(f.hub.all('sourceRequest').length, 1);
  const record = f.hub.all('sourceRequest')[0]; assert.equal(record.status, 'completed'); assert.equal(record.endpointId, null);
  const reopened = new AgentHub(f.root); assert.deepEqual(reopened.get('sourceRequest', record.id), record); reopened.close();
  const requests = f.calls.length; assert.deepEqual(await f.call(), a); assert.equal(f.calls.length, requests);
  const json = JSON.stringify(record);
  for (const privateValue of ['fixture-private-server-key', 'UPSTREAM-PRIVATE', 'github-connection', 'FixtureOwner']) assert.ok(!json.includes(privateValue));
});

test('cloud inventory is independent of Mac heartbeat and combines local root labels without credentials', async t => {
  const f = fixture(t, { paired: true });
  const inventory = await f.call({ operation: 'list' });
  assert.ok(inventory.actions.includes('github_notifications')); assert.ok(!inventory.actions.includes('mail_read'));
  assert.equal(inventory.locations.find(l => l.location === 'paired_local_agent').error, 'SOURCE_BRIDGE_OFFLINE');
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(inventory).includes('github-connection'));
  assert.ok(cloudSourceInventory(f.root, { env }).actions.includes('review_requests'));
  assert.ok(sourceBridgeInventory(f.hub, { env }).actions.includes('review_requests'));
});

test('mixed same-host list retains granted local files while hiding the replaced local GitHub login', async t => {
  const f = fixture(t), folder = join(f.root, 'documents'); mkdirSync(folder);
  writeFileSync(join(f.root, '.runtime/local-sources.json'), JSON.stringify({ version: 1, github: { account: 'OldLocalOwner', command: '/must-never-run' }, roots: [{ id: 'docs', label: 'Documents', path: folder }] }), { mode: 0o600 });
  const inventory = await f.call({ operation: 'list' });
  assert.deepEqual(inventory.roots, [{ id: 'docs', label: 'Documents' }]); assert.ok(inventory.actions.includes('file_read'));
  assert.equal(inventory.actions.filter(a => a === 'review_requests').length, 1);
  let invoked = false;
  await assert.rejects(readLocalSource({ root: f.root, args: { operation: 'review_requests' }, authorize: () => true, runner: async () => { invoked = true; } }), { code: 'SOURCE_PROVIDER_CHANGED' });
  assert.equal(invoked, false);
});

test('disconnect during provider I/O discards content and fails its durable receipt', async t => {
  const f = fixture(t), gate = paused(), entered = paused();
  f.intercept(async request => { if (request.path === '/proxy/search/issues') { entered.release(); await gate.promise; } });
  const call = f.call(), failed = assert.rejects(call, { code: 'SOURCE_REVOKED' });
  await entered.promise; f.disconnect(); gate.release(); await failed;
  const record = f.hub.all('sourceRequest')[0]; assert.equal(record.status, 'failed'); assert.equal(record.result, undefined);
  const before = f.calls.length; await assert.rejects(f.call(), { code: 'SOURCE_REVOKED' }); assert.equal(f.calls.length, before);
});

test('revocation before queued work starts records failure without starting network I/O', async t => {
  const f = fixture(t), request = f.call(); f.disconnect();
  await assert.rejects(request, { code: 'SOURCE_REVOKED' });
  assert.equal(f.calls.length, 0); assert.equal(f.hub.all('sourceRequest')[0].status, 'failed');
});

test('list rechecks cloud grants after an asynchronous settings read', async t => {
  const f = fixture(t);
  const result = await f.call({ operation: 'list' }, 'list', { read: async () => { f.disconnect(); return {}; } });
  assert.deepEqual(result.actions, ['list']);
});

test('revocation after Nango ownership lookup prevents the following credential/proxy request', async t => {
  const f = fixture(t);
  f.intercept(async request => { if (request.path === '/connections') f.disconnect(); });
  await assert.rejects(f.call(), { code: 'SOURCE_REVOKED' });
  assert.deepEqual(f.calls.map(r => r.path), ['/connections']);
});

test('same-account reconnect, lease replacement and owner changes fence late results', async t => {
  for (const change of ['reconnect', 'lease', 'owner']) {
    const f = fixture(t), entered = paused(), gate = paused();
    f.intercept(async req => { if (req.path === '/proxy/search/issues') { entered.release(); await gate.promise; } });
    const promise = f.call(), rejected = assert.rejects(promise, { code: change === 'reconnect' ? 'SOURCE_AUTHORITY_CHANGED' : 'FORBIDDEN' });
    await entered.promise;
    if (change === 'reconnect') { f.disconnect(); f.connect('github', 'FixtureOwner', ['repos']); }
    else if (change === 'lease') f.hub.put('run', { ...f.hub.get('run', f.job.id), lease: 'replacement' });
    else { const run = f.hub.get('run', f.job.id), conversation = f.hub.get('conversation', run.conversationId); f.hub.put('conversation', { ...conversation, ownerId: 'someone-else' }); }
    gate.release(); await rejected;
    assert.equal(f.hub.all('sourceRequest')[0].result, undefined);
  }
});

test('cloud selection never falls back when configuration, binding or authorization is unavailable', async t => {
  const f = fixture(t, { paired: true });
  rmSync(join(f.root, '.runtime/connections/nango.json'));
  await assert.rejects(f.call(), { code: 'SOURCE_NOT_CONFIGURED' }); assert.equal(f.calls.length, 0);
  const rows = f.hub.all('sourceRequest');
  assert.equal(rows.length, 1, 'the authenticated failed read remains evidence');
  const [receipt] = rows;
  assert.equal(receipt.id, createHash('sha256').update(JSON.stringify([f.job.id, f.job.lease, 'call-1'])).digest('hex'));
  assert.equal(receipt.runId, f.job.id); assert.equal(receipt.runLease, f.job.lease);
  assert.deepEqual(receipt.arguments, { operation: 'review_requests' });
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.error, 'SOURCE_NOT_CONFIGURED');
  assert.equal(receipt.result, undefined); assert.equal(receipt.endpointId, null);
  assert.equal(rows.some(row => ['queued', 'running'].includes(row.status)), false, 'no request is dispatched to the paired Mac');
});

test('call identity conflicts, cached revoked results, deadlines and unfinished process receipts fail explicitly', async t => {
  const f = fixture(t); await f.call();
  await assert.rejects(f.call({ operation: 'review_requests', max: 1 }), { code: 'CONFLICT' });
  f.advance(120001); await assert.rejects(f.call(), { code: 'SOURCE_TIMEOUT' });
  await f.call({ operation: 'review_requests' }, 'fresh');
  const row = f.hub.all('sourceRequest').find(row => row.arguments.operation === 'review_requests' && row.deadlineAt > f.hub.now());
  f.hub.put('sourceRequest', { ...row, status: 'running', result: undefined });
  await assert.rejects(f.call({ operation: 'review_requests' }, 'fresh'), { code: 'SOURCE_EXECUTION_INTERRUPTED' });
  f.disconnect(); await assert.rejects(f.call(), { code: 'SOURCE_REVOKED' });
});

test('Google MIME body and search receipts retain the existing reporting coverage fields', async t => {
  const f = fixture(t); f.connect('google', 'fixture@example.test', ['gmail']);
  const search = await f.call({ operation: 'mail_search', query: 'newer_than:2d' }, 'search');
  const body = await f.call({ operation: 'mail_read', messageId: 'abc' }, 'body');
  assert.equal(search.messages[0].id, 'abc'); assert.equal(search.truncated, false);
  assert.equal(body.text, 'Readable full text'); assert.equal(body.complete, true);
  assert.deepEqual(f.hub.all('sourceRequest').map(row => [row.arguments.operation, row.status]), [['mail_search', 'completed'], ['mail_read', 'completed']]);
  assert.match(sourceCoverage(f.job.id, f.hub.all('sourceRequest')), /完整正文1封、部分正文0封/);
});

test('scheduled read helpers preserve task authority, expected account/generation and complete MIME contract', async t => {
  const f = fixture(t); f.connect('google', 'fixture@example.test', ['gmail']);
  const item = f.manager.cloudState('google'), options = { env, fetchImpl: f.fetchImpl, authorize: () => true, generation: item.generation, account: item.account };
  const raw = await readCloudMail(f.root, { messageId: 'abc' }, options);
  assert.equal(raw.body, 'Readable full text'); assert.equal(raw.bodyComplete, true);
  await assert.rejects(readCloudSource(f.root, { operation: 'mail_read', messageId: 'abc' }, { ...options, generation: item.generation + 1 }), { code: 'SOURCE_AUTHORITY_CHANGED' });
  await assert.rejects(readCloudMail(f.root, { messageId: 'abc' }, { ...options, authorize: () => false }), { code: 'SOURCE_REVOKED' });
});

test('new notification and X actions validate bounded inputs and execute only connected providers', async t => {
  const f = fixture(t); f.connect('x', 'fixture', ['read']);
  assert.equal((await f.call({ operation: 'github_notifications', since: '2026-10-22T00:00:00Z' }, 'notifications')).onlyPublic, true);
  assert.equal((await f.call({ operation: 'x_timeline', max: 5 }, 'timeline')).complete, true);
  for (const args of [{ operation: 'x_timeline', max: 1 }, { operation: 'github_notifications', since: 'yesterday' }, { operation: 'github_notifications', since: '2026-10-22T00:00:00Z', ids: ['../a'] }]) assert.throws(() => validateSourceArguments(args), { code: 'INVALID_INPUT' });
});
