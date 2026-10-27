import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { routedSourcesTool, sourceBridgeRPC, sourceBridgeInventory, connectedServiceStatus } from '../plugins/agent-hub/source-bridge.mjs';
import { readLocalSource, sourceAuthorizationSnapshot } from '../plugins/agent-hub/sources.mjs';
import { SourceCompanion, sourceTransport } from '../plugins/agent-hub/source-companion.mjs';
import { createConnectionManager } from '../plugins/connections/manager.mjs';
import { createWebUI } from '../plugins/webui/server.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xiaoman-source-bridge-')), mac = join(root, 'mac'); mkdirSync(mac);
  let now = Date.now();
  const hub = new AgentHub(root, { now: () => now }), local = hub.pair({ label: 'Paired Mac' });
  const cloud = { id: 'cloud', label: 'Cloud', provider: 'dsh' }, token = 'x'.repeat(48);
  hub.registerHost(cloud, token);
  const c = hub.newConversation({ endpointId: 'cloud' }); hub.submit({ conversationId: c.id, content: '看看我关注的 GitHub 仓库更新', requestId: 'fixture' });
  const job = hub.poll(token, { runnerId: 'cloud-runner' }).job;
  const config = { version: 1, agents: [], roles: {}, sourceBridge: { endpointId: local.endpointId, operations: ['github_repositories', 'github_updates', 'review_requests'] } };
  const save = () => writeFileSync(join(root, '.runtime/agent-hub.json'), JSON.stringify(config), { mode: 0o600 }); save();
  const connections = createConnectionManager({ root, now: () => now });
  const mutate = (operation, id, values) => connections.mutate({ operation, id, values, revision: connections.snapshot().revision });
  const pair = mutate('pair', undefined, { name: 'Mac' }); mutate('connect', 'github');
  const verifyConnection = () => {
    const item = connections.bridgeSnapshot(pair.token).desired.find(i => i.id === 'github');
    connections.reportBridge(pair.token, { reports: [{ id: 'github', generation: item.generation, state: 'connected', code: 'ok', account: 'FixtureOwner', permissions: [{ id: 'repos', granted: true, verified: true }] }] });
  }; verifyConnection();
  const connectSource = (id, permissions, account = null) => {
    mutate(id === 'files' ? 'grant' : 'connect', id, id === 'files' ? { scope: 'common-folders' } : id === 'google' ? { account } : undefined);
    const item = connections.bridgeSnapshot(pair.token).desired.find(i => i.id === id);
    connections.reportBridge(pair.token, { reports: [{ id, generation: item.generation, state: 'connected', code: 'ok', account,
      permissions: permissions.map(id => ({ id, granted: true, verified: true })) }] });
  };
  const rpc = (operation, input) => sourceBridgeRPC(hub, local.token, operation, input);
  const companion = (options = {}) => new SourceCompanion({ root: mac, statePath: join(mac, 'sources.json'), now: () => now, transport: async (op, input) => rpc(op, input), authorizationSnapshot: async () => 'fixture-authorization',
    readSource: async ({ args, expectedAccount, authorize }) => { assert.equal(expectedAccount, args.operation === 'list' ? null : 'fixtureowner'); await authorize(); return { operation: args.operation, untrusted: true, configured: true, actions: ['list', 'github_repositories', 'mail_read'], roots: [{ id: 'secret-root' }] }; }, ...options });
  const call = (args = { operation: 'list' }, callId = 'call-1') => routedSourcesTool({ root, hub, token, input: { runId: job.id, lease: job.lease, callId, arguments: args } });
  t.after(() => { connections.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, mac, hub, local, token, c, job, config, save, connections, mutate, verifyConnection, connectSource, rpc, companion, call, advance: ms => { now += ms; } };
}

test('cloud tool runs on the paired Mac and results survive duplicate calls and separate DB handles', async t => {
  const f = fixture(t), worker = f.companion(); await worker.tick();
  const first = f.call(), duplicate = f.call();
  await worker.tick(); await worker.execution; await worker.tick();
  const result = await first; assert.deepEqual(await duplicate, result);
  assert.deepEqual(result.actions, ['list', 'github_repositories']); assert.deepEqual(result.roots, []);
  assert.equal(result.execution.location, 'paired_local_agent');
  assert.equal(result.observedAt, new Date(f.hub.all('sourceRequest')[0].finishedAt).toISOString());
  const reopened = new AgentHub(f.root); assert.equal(reopened.all('sourceRequest').length, 1); reopened.close();
  assert.equal(f.hub.all('sourceRequest')[0].status, 'completed'); await worker.stop();
});

test('source receipts survive body retention while the parent run can resume, then prune after completion', async t => {
  const f = fixture(t), worker = f.companion();
  await worker.tick();
  const read = f.call();
  await worker.tick(); await worker.execution; await worker.tick(); await read;
  await worker.stop();
  const receipt = f.hub.all('sourceRequest')[0];
  assert.equal(receipt.status, 'completed');
  f.advance(12 * 60000 + 1);
  for (const status of ['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling']) {
    f.hub.put('run', { ...f.hub.get('run', f.job.id), status, heartbeat: f.hub.now() });
    f.rpc('source-poll', { runnerId: 'retention-review' });
    assert.deepEqual(f.hub.get('sourceRequest', receipt.id), receipt, `${status} execution still needs its original source receipts`);
  }
  const reopened = new AgentHub(f.root);
  assert.deepEqual(reopened.get('sourceRequest', receipt.id), receipt, 'Source evidence remains durable across reopening');
  reopened.close();
  f.hub.put('run', { ...f.hub.get('run', f.job.id), status: 'running' });
  f.hub.event(f.token, { runId: f.job.id, lease: f.job.lease, seq: 1, type: 'completed', value: '隔离读取已完成' });
  f.rpc('source-poll', { runnerId: 'retention-review' });
  assert.equal(f.hub.get('sourceRequest', receipt.id), null, 'Terminal execution still honors the original retention deadline');
});

test('only explicit route, permitted GitHub reads, paired endpoint and current user lease can request data', async t => {
  const f = fixture(t), worker = f.companion();
  await assert.rejects(f.call(), { code: 'SOURCE_BRIDGE_OFFLINE' }); await worker.tick();
  await assert.rejects(f.call({ operation: 'mail_read', messageId: 'abc' }), { code: 'SOURCE_NOT_CONFIGURED' });
  await assert.rejects(f.call({ operation: 'list', command: 'anything' }), { code: 'INVALID_INPUT' });
  assert.throws(() => sourceBridgeRPC(f.hub, f.token, 'source-result', { runnerId: 'r', requestId: 'x', lease: 'y' }), { code: 'FORBIDDEN' });
  assert.throws(() => f.rpc('source-check', { runnerId: 'r' }), { code: 'INVALID_INPUT' });
  f.hub.cancel(f.job.id); await assert.rejects(f.call(), { code: 'FORBIDDEN' });
  assert.equal(f.hub.all('sourceRequest').length, 1);
  assert.equal(f.hub.all('sourceRequest')[0].error, 'SOURCE_NOT_CONFIGURED');
  assert.equal(f.hub.all('sourceRequest')[0].arguments.operation, 'mail_read');
  await worker.stop();
});

test('authenticated route failures leave failed read evidence while invalid leases and inventory do not', async t => {
  const f = fixture(t), args = { operation: 'github_updates', repo: 'example/project' };
  await assert.rejects(f.call(), { code: 'SOURCE_BRIDGE_OFFLINE' });
  assert.equal(f.hub.all('sourceRequest').length, 0);
  await assert.rejects(f.call(args, 'offline-read'), { code: 'SOURCE_BRIDGE_OFFLINE' });
  const failed = f.hub.all('sourceRequest')[0];
  assert.equal(failed.runId, f.job.id); assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'SOURCE_BRIDGE_OFFLINE'); assert.equal(failed.result, undefined);
  await assert.rejects(routedSourcesTool({ root: f.root, hub: f.hub, token: f.token,
    input: { runId: f.job.id, lease: 'wrong-lease', callId: 'wrong-lease-read', arguments: args } }), { code: 'FORBIDDEN' });
  await assert.rejects(f.call({ ...args, unexpected: true }, 'bad-arguments'), { code: 'INVALID_INPUT' });
  assert.equal(f.hub.all('sourceRequest').length, 1);
});

test('a repeated read that fails routing cannot retain its previous completed source evidence', async t => {
  const f = fixture(t), worker = f.companion(); await worker.tick();
  const args = { operation: 'github_updates', repo: 'example/project' };
  const pending = f.call(args, 'repeat-route-read');
  await worker.tick(); await worker.execution; await worker.tick(); await pending;
  const row = f.hub.all('sourceRequest')[0]; assert.equal(row.status, 'completed');
  await worker.stop(); f.mutate('disconnect', 'github');
  await assert.rejects(f.call(args, 'repeat-route-read'), { code: 'SOURCE_REVOKED' });
  assert.equal(f.hub.get('sourceRequest', row.id).status, 'failed');
  assert.equal(f.hub.get('sourceRequest', row.id).result, undefined);
  await assert.rejects(f.call({ ...args, repo: 'example/other' }, 'repeat-route-read'), { code: 'CONFLICT' });
});

test('revoking GitHub while a Mac read is active discards the returned content', async t => {
  const f = fixture(t); let release; const gate = new Promise(resolve => { release = resolve; });
  const worker = f.companion({ readSource: async ({ authorize }) => { await gate; await authorize(); return { untrusted: true, operation: 'list', actions: [] }; } });
  await worker.tick(); const result = f.call(); const rejected = assert.rejects(result, { code: 'SOURCE_AUTHORITY_CHANGED' });
  await worker.tick(); f.mutate('disconnect', 'github'); release(); await worker.execution;
  await rejected;
  assert.equal(f.hub.all('sourceRequest')[0].result, undefined); await worker.stop();
});

test('changing route generation, account or the parent lease cannot expose a stale result', async t => {
  const f = fixture(t), worker = f.companion(); await worker.tick();
  const pending = f.call(); const rejected = assert.rejects(pending, { code: 'SOURCE_AUTHORITY_CHANGED' });
  await worker.tick(); await worker.execution;
  f.config.sourceBridge.operations = ['github_repositories']; f.save();
  await worker.tick(); await rejected;
  assert.equal(f.hub.all('sourceRequest')[0].result, undefined); await worker.stop();
});

test('a lost result acknowledgement retries the durable result without re-reading or duplicate records', async t => {
  const f = fixture(t); let reads = 0, lose = true;
  let worker = f.companion({ readSource: async () => { reads++; return { operation: 'list', untrusted: true, actions: ['list'], roots: [] }; },
    transport: async (op, input) => { const result = f.rpc(op, input); if (op === 'source-result' && lose) { lose = false; throw new Error('lost reply'); } return result; } });
  await worker.tick(); const response = f.call(); await worker.tick(); await worker.execution;
  await assert.rejects(worker.tick(), /lost reply/); await worker.stop();
  worker = f.companion({ readSource: async () => { throw new Error('must not re-read'); } });
  await worker.tick(); assert.equal((await response).configured, undefined);
  assert.equal(reads, 1); assert.equal(f.hub.all('sourceRequest').length, 1); await worker.stop();
});

test('Mac restart resumes a read-only request, while deadlines and cancellation stay authoritative', async t => {
  const f = fixture(t); let release; const gate = new Promise(resolve => { release = resolve; });
  let worker = f.companion({ readSource: async ({ authorize }) => { await gate; await authorize(); return { operation: 'list', untrusted: true, actions: [] }; } });
  await worker.tick(); const pending = f.call(); await worker.tick();
  const stopped = worker.stop(); release(); await stopped;
  worker = f.companion(); await worker.tick(); await worker.execution; await worker.tick();
  assert.equal((await pending).execution.location, 'paired_local_agent');
  const timeout = f.call({ operation: 'list' }, 'deadline'); const rejected = assert.rejects(timeout, { code: 'SOURCE_BRIDGE_TIMEOUT' });
  f.advance(120001); await rejected; await worker.stop();
});

for (const restart of [false, true]) test(`cached source result rechecks local authorization before upload${restart ? ' after restart' : ''}`, async t => {
  const f = fixture(t); let authorization = 'original', uploads = [];
  const options = { authorizationSnapshot: async () => authorization,
    transport: async (op, input) => { if (op === 'source-result') uploads.push(input); return f.rpc(op, input); } };
  let worker = f.companion(options); await worker.tick();
  const response = f.call(); const rejected = assert.rejects(response, { code: 'SOURCE_AUTHORITY_CHANGED' });
  await worker.tick(); await worker.execution;
  authorization = 'revoked-or-replaced';
  if (restart) { await worker.stop(); worker = f.companion(options); }
  await worker.tick(); await rejected;
  assert.equal(uploads.length, 1); assert.equal(uploads[0].result, undefined);
  assert.equal(uploads[0].error, 'SOURCE_AUTHORITY_CHANGED'); await worker.stop();
});

test('oversize Unicode results fail boundedly and a restart can process the next source job', async t => {
  const f = fixture(t); let worker = f.companion({ readSource: async () => ({ operation: 'github_updates', untrusted: true, text: '😀'.repeat(200000) }) });
  await worker.tick(); const response = f.call({ operation: 'github_updates', repo: 'owner/repo' });
  const rejected = assert.rejects(response, { code: 'SOURCE_RESPONSE_TOO_LARGE' });
  await worker.tick(); await worker.execution; await worker.stop();
  worker = f.companion(); await worker.tick(); await rejected;
  const next = f.call({ operation: 'list' }, 'after-large'); await worker.tick(); await worker.execution; await worker.tick();
  assert.equal((await next).execution.location, 'paired_local_agent'); await worker.stop();
});

test('permanent upload rejection replaces cached content with a bounded failure instead of blocking the lane', async t => {
  const f = fixture(t); let uploads = 0;
  const worker = f.companion({ transport: async (op, input) => {
    if (op === 'source-result' && input.result) { uploads++; throw Object.assign(new Error(), { code: 'BODY_TOO_LARGE' }); }
    return f.rpc(op, input);
  } });
  await worker.tick(); const response = f.call(); const rejected = assert.rejects(response, { code: 'SOURCE_RESPONSE_REJECTED' });
  await worker.tick(); await worker.execution; await worker.tick(); await worker.tick(); await rejected;
  assert.equal(uploads, 1); assert.equal(worker.state.active, null); await worker.stop();
});

test('source bridge HTTP uses its paired credential, correct Host and bounded large results', async t => {
  const f = fixture(t);
  const app = createWebUI({ root: f.root, helper: async () => ({ revision: 'test', socket: join(f.root, 'offline.sock'), pending: [], capabilities: [], config: { agent: { provider: 'dsh' }, im: { provider: 'disabled' }, proactive: { enabled: false } } }), rpc: async () => { throw new Error('offline'); } });
  f.verifyConnection();
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.shutdown());
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  const transport = sourceTransport({ endpoint, publicOrigin: endpoint, token: f.local.token });
  const worker = f.companion({ transport, readSource: async () => ({ operation: 'github_updates', untrusted: true, text: 'a'.repeat(90000) }) });
  await worker.tick(); const pending = f.call({ operation: 'github_updates', repo: 'owner/repository' });
  await worker.tick(); await worker.execution; await worker.tick(); assert.equal((await pending).text.length, 90000);
  const wrong = sourceTransport({ endpoint, publicOrigin: 'http://wrong.invalid', token: f.local.token });
  await assert.rejects(wrong('source-poll', { runnerId: 'wrong' }));
  const unauthenticated = await fetch(endpoint + '/api/agent-bridge/source-poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runnerId: 'r' }) }).then(r => r.json());
  assert.equal(unauthenticated.ok, false);
  await worker.stop();
});


test('Google and files use their own authority, while disconnected services stay absent from inventory', async t => {
  const f = fixture(t);
  f.config.sourceBridge.operations.push('mail_search', 'mail_read', 'calendar_events', 'drive_search', 'docs_read', 'sheets_read', 'contacts_search', 'recent_files', 'file_read'); f.save();
  f.connectSource('google', ['gmail', 'calendar', 'drive'], 'owner@example.com');
  f.connectSource('files', ['readable']);
  const seen = [];
  const worker = f.companion({ readSource: async ({ args, expectedAccount, expectedAccounts, authorize }) => {
    await authorize(); seen.push({ args, expectedAccount, expectedAccounts });
    return args.operation === 'list' ? { operation: 'list', untrusted: true, configured: true,
      actions: ['list', ...f.config.sourceBridge.operations], roots: [{ id: 'documents', label: 'Documents' }] }
      : { operation: args.operation, untrusted: true, text: 'bounded source body' };
  } });
  await worker.tick();
  const cycle = async (args, id) => { const pending = f.call(args, id); await worker.tick(); await worker.execution; await worker.tick(); return pending; };
  const listed = await cycle({ operation: 'list' }, 'catalog');
  assert.ok(listed.actions.includes('mail_read')); assert.ok(!listed.actions.includes('contacts_search'));
  assert.deepEqual(listed.roots, [{ id: 'documents', label: 'Documents' }]);
  assert.deepEqual(seen[0].expectedAccounts, { github: 'fixtureowner', google: 'owner@example.com' });
  const mail = await cycle({ operation: 'mail_read', messageId: 'abcd' }, 'mail');
  assert.equal(mail.text, 'bounded source body'); assert.equal(seen[1].expectedAccount, 'owner@example.com');
  await cycle({ operation: 'file_read', rootId: 'documents', relativePath: 'notes.md' }, 'file');
  assert.equal(seen[2].expectedAccount, null);
  await assert.rejects(f.call({ operation: 'contacts_search', query: 'Sam' }, 'not-granted'), { code: 'SOURCE_NOT_CONFIGURED' });
  const catalog = sourceBridgeInventory(f.hub); assert.equal(catalog.location, 'paired_local_agent'); assert.ok(catalog.actions.includes('calendar_events'));
  const services = connectedServiceStatus(f.root); assert.equal(services.find(s => s.id === 'phone').state, 'unlinked');
  assert.ok(!JSON.stringify(services).includes('owner@example.com'));
  f.mutate('disconnect', 'google');
  const after = await cycle({ operation: 'list' }, 'after-revoke');
  assert.ok(!after.actions.includes('mail_read')); assert.ok(after.actions.includes('github_updates')); assert.ok(after.actions.includes('file_read'));
  await worker.stop();
});

for (const id of ['google', 'files']) test(`revoking ${id} after a cached body discards it, even on Mac restart`, async t => {
  const f = fixture(t), operation = id === 'google' ? 'mail_read' : 'file_read';
  f.config.sourceBridge.operations.push(operation); f.save();
  f.connectSource(id, [id === 'google' ? 'gmail' : 'readable'], id === 'google' ? 'owner@example.com' : null);
  let worker = f.companion({ readSource: async ({ args }) => ({ operation: args.operation, untrusted: true, text: 'private body must be discarded' }) });
  await worker.tick();
  const response = f.call(id === 'google' ? { operation, messageId: 'abcd' } : { operation, rootId: 'documents', relativePath: 'memo.txt' });
  const rejected = assert.rejects(response, { code: 'SOURCE_REVOKED' });
  await worker.tick(); await worker.execution; await worker.stop();
  f.mutate('disconnect', id); worker = f.companion(); await worker.tick(); await rejected;
  assert.equal(f.hub.all('sourceRequest')[0].result, undefined); assert.equal(worker.state.active, null); await worker.stop();
});

test('changing a Google account invalidates Google work without invalidating an active GitHub read', async t => {
  const f = fixture(t); f.config.sourceBridge.operations.push('mail_read'); f.save();
  f.connectSource('google', ['gmail'], 'first@example.com');
  const worker = f.companion({ readSource: async ({ args }) => ({ operation: args.operation, untrusted: true, text: 'body' }) });
  await worker.tick();
  const pending = f.call({ operation: 'mail_read', messageId: 'abcd' }, 'mail');
  const rejected = assert.rejects(pending, { code: 'SOURCE_AUTHORITY_CHANGED' });
  await worker.tick(); await worker.execution;
  f.connectSource('google', ['gmail'], 'second@example.com'); await worker.tick(); await rejected;
  const github = f.call({ operation: 'github_updates', repo: 'owner/repo' }, 'github');
  await worker.tick(); await worker.execution; f.mutate('disconnect', 'google'); await worker.tick();
  assert.equal((await github).text, 'body'); await worker.stop();
});


test('real Mac source reader and authorization snapshot carry Gmail bodies and files through the cloud bridge', async t => {
  const f = fixture(t), runtime = join(f.mac, '.runtime'), folder = join(f.mac, 'documents');
  mkdirSync(runtime, { mode: 0o700 }); mkdirSync(folder);
  writeFileSync(join(folder, 'week.md'), 'A concrete local planning note.');
  const profile = { version: 1, google: { account: 'owner@example.com', command: 'fixture-gog', services: ['gmail'] },
    roots: [{ id: 'documents', label: 'Documents', path: realpathSync(folder) }] };
  writeFileSync(join(runtime, 'local-sources.json'), JSON.stringify(profile), { mode: 0o600 });
  f.config.sourceBridge.operations.push('mail_read', 'file_read'); f.save();
  f.connectSource('google', ['gmail'], 'owner@example.com'); f.connectSource('files', ['readable']);
  const commands = [];
  const runner = async (command, argv) => {
    commands.push([command, argv]);
    assert.equal(argv[argv.indexOf('--account') + 1], 'owner@example.com');
    const data = argv[0] === 'auth' ? { accounts: [{ email: 'owner@example.com', valid: true, services: ['gmail'], scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }] }
      : { message: { id: 'abc' }, headers: { subject: 'Planning' }, body: 'Read the full message body, not just its subject.' };
    return { exitCode: 0, stdout: JSON.stringify(data) };
  };
  const worker = f.companion({ authorizationSnapshot: sourceAuthorizationSnapshot, readSource: options => readLocalSource({ ...options, runner }) });
  await worker.tick();
  const cycle = async (args, id) => { const pending = f.call(args, id); await worker.tick(); await worker.execution; await worker.tick(); return pending; };
  const mail = await cycle({ operation: 'mail_read', messageId: 'abc' }, 'actual-mail');
  assert.equal(mail.text, 'Read the full message body, not just its subject.'); assert.equal(mail.complete, true);
  assert.equal(commands.filter(([, args]) => args[0] === 'auth').length, 2);
  const file = await cycle({ operation: 'file_read', rootId: 'documents', relativePath: 'week.md' }, 'actual-file');
  assert.equal(file.text, 'A concrete local planning note.'); assert.ok(file.execution.requestId);
  profile.google.account = 'different@example.com';
  profile.roots.push({ id: 'gone', label: 'Removed folder', path: join(folder, 'missing') });
  writeFileSync(join(runtime, 'local-sources.json'), JSON.stringify(profile), { mode: 0o600 });
  const listed = await cycle({ operation: 'list' }, 'actual-list');
  assert.ok(!listed.actions.includes('mail_read')); assert.ok(listed.actions.includes('file_read'));
  assert.ok(!JSON.stringify(listed).includes(folder));
  await worker.stop();
});
