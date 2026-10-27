import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { createConnectionManager } from '../plugins/connections/manager.mjs';
import { createRoutineController, routineTool } from '../plugins/agent-hub/routines.mjs';
import { normalizeRoutineScope, bindRoutineScope, assertRoutineScopeCurrent, assertRoutineSourceAccess, routineSourceInventory } from '../plugins/agent-hub/routine-scope.mjs';
import { statusTool } from '../plugins/agent-hub/status.mjs';
import { sourcesTool } from '../plugins/agent-hub/sources.mjs';
import { routedSourcesTool } from '../plugins/agent-hub/source-bridge.mjs';
import { nativeActionPolicy, assertRoutineToolAccess } from '../plugins/agent-hub/actions.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-routine-scope-'))); let now = Date.parse('2026-10-27T00:00:00Z');
  const hub = new AgentHub(root, { now: () => now }), store = new JournalStore(root, { now: () => now });
  const connections = createConnectionManager({ root, now: () => now });
  const mutate = (operation, id, values) => connections.mutate({ operation, id, values, revision: connections.snapshot().revision });
  const bridge = mutate('pair', undefined, { name: 'Fixture source' });
  const connect = (id, account = null) => {
    mutate(id === 'files' ? 'grant' : 'connect', id, id === 'files' ? { scope: 'common-folders' } : id === 'google' ? { account } : undefined);
    const desired = connections.bridgeSnapshot(bridge.token).desired.find(item => item.id === id);
    connections.reportBridge(bridge.token, { reports: [{ id, generation: desired.generation, state: 'connected', code: 'ok', account, permissions: [{ id: id === 'files' ? 'readable' : id === 'github' ? 'repos' : 'gmail', granted: true, verified: true }] }] });
  };
  const pair = hub.pair({ label: 'Scope runner' });
  const routines = createRoutineController({ hub, journal: { store } });
  const values = extra => ({ title: '关注一个项目', instruction: '只检查约定的资料。', endpointId: pair.endpointId, schedule: { time: '09:00', timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5, 6, 7] }, trigger: { condition: '有新版本', mode: 'changed' }, ...extra });
  const create = extra => routines.action({ operation: 'create', requestId: crypto.randomUUID(), values: values(extra) });
  const start = async routine => { await routines.action({ operation: 'run_now', id: routine.id, version: routine.version, requestId: crypto.randomUUID() }); return hub.poll(pair.token, { runnerId: 'scoped', routineGuardVersion: 1 }).job; };
  const tool = (job, args, routed = false) => (routed ? routedSourcesTool : sourcesTool)({ root, hub, token: pair.token, input: { runId: job.id, lease: job.lease, callId: crypto.randomUUID(), arguments: args } });
  t.after(() => { connections.close(); hub.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, hub, store, pair, routines, connections, mutate, connect, create, start, tool, setNow: value => { now = value; } };
}
const repoScope = { publicWeb: false, sources: [{ operation: 'github_updates', filter: { repo: 'example/one' } }] };

test('omitted scope is public Web only, grants use valid operations and file roots must be explicit', () => {
  assert.deepEqual(normalizeRoutineScope(), { publicWeb: true, sources: [] });
  assert.throws(() => normalizeRoutineScope({ publicWeb: true, sources: [{ operation: 'mail_read', filter: { command: 'read all' } }] }), { code: 'INVALID_INPUT' });
  assert.throws(() => normalizeRoutineScope({ publicWeb: false, sources: [{ operation: 'file_read' }] }), { code: 'ROUTINE_SCOPE_REQUIRED' });
  assert.throws(() => normalizeRoutineScope({ publicWeb: true, sources: [{ operation: 'unknown' }] }), { code: 'INVALID_INPUT' });
});

test('an actual file read is bounded by the selected root and exact resource at both tool entries', async t => {
  const f = fixture(t); f.connect('files');
  const directory = join(f.root, 'material'); mkdirSync(directory);
  writeFileSync(join(directory, 'allowed.txt'), 'Allowed evidence'); writeFileSync(join(directory, 'other.txt'), 'PRIVATE OTHER ITEM');
  writeFileSync(join(f.root, '.runtime/local-sources.json'), JSON.stringify({ version: 1, roots: [{ id: 'material', label: '材料', path: directory }, { id: 'other', label: '其他', path: directory }] }), { mode: 0o600 });
  const scope = { publicWeb: false, sources: [{ operation: 'file_read', filter: { rootId: 'material', relativePath: 'allowed.txt' } }] };
  const { routine } = await f.create({ scope }), job = await f.start(routine);
  const read = await f.tool(job, { operation: 'file_read', rootId: 'material', relativePath: 'allowed.txt' });
  assert.equal(read.text, 'Allowed evidence');
  for (const routed of [false, true]) {
    await assert.rejects(f.tool(job, { operation: 'file_read', rootId: 'material', relativePath: 'other.txt' }, routed), { code: 'SOURCE_SCOPE_DENIED' });
    await assert.rejects(f.tool(job, { operation: 'file_read', rootId: 'other', relativePath: 'allowed.txt' }, routed), { code: 'SOURCE_SCOPE_DENIED' });
    await assert.rejects(f.tool(job, { operation: 'mail_read', messageId: 'abcdef' }, routed), { code: 'SOURCE_SCOPE_DENIED' });
  }
  const inventory = await f.tool(job, { operation: 'list' });
  assert.deepEqual(inventory.actions, ['list', 'file_read']); assert.deepEqual(inventory.roots, [{ id: 'material', label: '材料' }]);
  f.mutate('disconnect', 'files');
  await assert.rejects(f.tool(job, { operation: 'file_read', rootId: 'material', relativePath: 'allowed.txt' }), { code: 'SOURCE_REVOKED' });
  assert.equal(f.routines.snapshot().routines[0].nextRunAt, null);
});

test('scope pins authorization generation/account; an ordinary update cannot silently renew it', async t => {
  const f = fixture(t); f.connect('github', 'FixtureOwner');
  let { routine } = await f.create({ scope: repoScope });
  assert.equal(routine.scopeBindings[0].account, 'fixtureowner'); assert.deepEqual(routine.connectionIds, ['github']);
  f.mutate('disconnect', 'github'); assert.throws(() => assertRoutineScopeCurrent(f.hub, routine), { code: 'SOURCE_REVOKED' });
  f.connect('github', 'AnotherOwner');
  assert.throws(() => assertRoutineScopeCurrent(f.hub, routine), { code: 'SOURCE_AUTHORITY_CHANGED' });
  const savedBinding = routine.scopeBindings;
  ({ routine } = await f.routines.action({ operation: 'update', id: routine.id, version: routine.version, requestId: 'same-scope', values: { title: '新标题', scope: repoScope } }));
  assert.deepEqual(routine.scopeBindings, savedBinding); assert.equal(routine.scopeStatus.error, 'SOURCE_AUTHORITY_CHANGED'); assert.equal(routine.nextRunAt, null);
  await assert.rejects(f.start(routine), { code: 'SOURCE_AUTHORITY_CHANGED' });
  ({ routine } = await f.routines.action({ operation: 'authorize_scope', id: routine.id, version: routine.version, requestId: 'owner-accepts-new-account' }));
  assert.equal(routine.scopeBindings[0].account, 'anotherowner'); assert.equal(routine.scopeStatus.blocked, false);
  const job = await f.start(routine);
  assert.doesNotThrow(() => assertRoutineSourceAccess(f.hub, job, { operation: 'github_updates', repo: 'example/one' }));
  assert.throws(() => assertRoutineSourceAccess(f.hub, job, { operation: 'github_updates', repo: 'example/two' }), { code: 'SOURCE_SCOPE_DENIED' });
});

test('an empty scope can be saved to withdraw all reads but never schedules or dispatches a check', async t => {
  for (const mode of ['create', 'withdraw']) await t.test(mode, async t => {
    const f = fixture(t), empty = { publicWeb: false, sources: [] };
    let routine;
    if (mode === 'withdraw') {
      f.connect('github', 'FixtureOwner');
      ({ routine } = await f.create({ scope: repoScope }));
      await f.routines.action({ operation: 'run_now', id: routine.id, version: routine.version, requestId: 'queued-before-withdrawal' });
      f.mutate('disconnect', 'github');
      ({ routine } = await f.routines.action({ operation: 'update', id: routine.id, version: routine.version, requestId: 'withdraw-all-reads', values: { scope: empty } }));
    } else ({ routine } = await f.create({ scope: empty }));
    assert.deepEqual(routine.scope, empty);
    assert.deepEqual(routine.scopeBindings, []);
    assert.deepEqual(routine.scopeStatus, { blocked: true, error: 'ROUTINE_SCOPE_EMPTY' });
    assert.equal(routine.nextRunAt, null);
    await assert.rejects(f.start(routine), { code: 'ROUTINE_SCOPE_EMPTY' });
    const count = f.hub.all('run').length;
    f.setNow(f.hub.now() + 2 * 60 * 60000);
    await f.routines.tick();
    assert.equal(f.hub.all('run').length, count, 'A due timer cannot enqueue work with no readable sources');
    assert.equal(f.hub.poll(f.pair.token, { runnerId: 'scoped', routineGuardVersion: 1 }).job, null);
    const listed = (await f.routines.action({ operation: 'list' })).routines[0];
    assert.equal(listed.scopeStatus.error, 'ROUTINE_SCOPE_EMPTY');
    assert.equal(listed.nextRunAt, null);
  });
});

test('revocation while a run is active cancels it, blocks result submission and suppresses publication', async t => {
  const f = fixture(t); f.connect('github', 'FixtureOwner');
  const { routine } = await f.create({ scope: repoScope }), job = await f.start(routine);
  f.mutate('disconnect', 'github'); await f.routines.tick();
  assert.equal(f.hub.get('run', job.id).status, 'cancelling');
  await assert.rejects(routineTool({ hub: f.hub, routines: f.routines, token: f.pair.token, input: { runId: job.id, lease: job.lease, callId: 'late', arguments: { operation: 'result', outcome: 'checked', matched: true, summary: 'late', checks: [], facts: [] } } }), { code: 'FORBIDDEN' });
  f.hub.event(f.pair.token, { runId: job.id, lease: job.lease, seq: 1, type: 'stopped', value: 'cancelled' });
  await f.routines.tick(); assert.equal(f.hub.get('run', job.id).routinePublished, false);
});

test('end is durable and cannot be resumed; expiry stops a running occurrence and hides next time', async t => {
  const f = fixture(t); let { routine } = await f.create();
  const end = { operation: 'end', id: routine.id, version: 1, requestId: 'end-once' };
  const first = await f.routines.action(end); assert.deepEqual(await f.routines.action(end), first);
  assert.equal(first.routine.ended, true); assert.equal(first.routine.nextRunAt, null);
  for (const operation of ['resume', 'run_now', 'update']) await assert.rejects(f.routines.action({ operation, id: routine.id, version: 2, requestId: operation, values: { enabled: true } }), { code: 'ROUTINE_ENDED' });
  const deadline = f.hub.now() + 60000;
  ({ routine } = await f.create({ endsAt: deadline })); const job = await f.start(routine);
  f.setNow(deadline); await f.routines.tick();
  const ended = f.routines.snapshot().routines.find(row => row.id === routine.id);
  assert.equal(ended.ended, true); assert.equal(ended.endReason, 'expired'); assert.equal(ended.enabled, false); assert.equal(ended.nextRunAt, null);
  assert.equal(f.hub.get('run', job.id).status, 'cancelling');
});

test('a client without a current scope guard handshake never receives a background job', async t => {
  const f = fixture(t); const { routine } = await f.create();
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'old-client' });
  const response = f.hub.poll(f.pair.token, { runnerId: 'old-client' });
  assert.equal(response.job, null); assert.equal(f.hub.all('run')[0].error, 'ROUTINE_SCOPE_UNSUPPORTED');
  assert.equal(f.routines.snapshot().routines[0].lastStatus, 'failed');
});

test('native and managed tools cannot route around a routine scope', async t => {
  const f = fixture(t); f.connect('github', 'FixtureOwner');
  const { routine } = await f.create({ scope: repoScope }), job = await f.start(routine);
  for (const name of ['read_file', 'Read', 'Glob', 'Grep', 'Bash']) assert.equal(nativeActionPolicy(name, {}, job.routine), 'blocked');
  assert.equal(nativeActionPolicy('web_fetch', { url: 'https://example.com' }, job.routine), 'blocked');
  assert.equal(nativeActionPolicy('web_fetch', { url: 'https://example.com' }, { scope: { publicWeb: true } }), 'read');
  for (const name of ['xiaoman_memory', 'xiaoman_history', 'xiaoman_tasks']) assert.throws(() => assertRoutineToolAccess(job, name, { operation: 'list' }), { code: 'FORBIDDEN' });
  assert.throws(() => assertRoutineToolAccess(job, 'xiaoman_journal', { operation: 'get', itemId: 'other' }), { code: 'FORBIDDEN' });
  const input = arguments_ => ({ runId: job.id, lease: job.lease, callId: crypto.randomUUID(), arguments: arguments_ });
  const own = await routineTool({ hub: f.hub, routines: f.routines, token: f.pair.token, input: input({ operation: 'list' }) });
  assert.equal(own.routines.length, 1); assert.deepEqual(own.sourcesAvailable, []);
  await assert.rejects(routineTool({ hub: f.hub, routines: f.routines, token: f.pair.token, input: input({ operation: 'get', id: 'other' }) }), { code: 'FORBIDDEN' });
  await assert.rejects(f.tool(job, { operation: 'mail_read', messageId: 'abc' }), { code: 'SOURCE_SCOPE_DENIED' });
});

test('internal approval fence runs after asynchronous settings and before source binding', async t => {
  const f = fixture(t); f.connect('github', 'FixtureOwner');
  let resume; const wait = new Promise(resolve => { resume = resolve; });
  const controller = createRoutineController({ hub: f.hub, journal: { store: f.store }, read: async () => { await wait; return { config: {} }; } });
  const expected = bindRoutineScope(f.hub, repoScope);
  const pending = controller.action({ operation: 'create', requestId: 'proposal', values: { title: '待接管', instruction: '检查项目', schedule: { time: '09:00', timezone: 'Asia/Shanghai', days: [1] }, trigger: { condition: '更新', mode: 'changed' }, scope: repoScope } }, { beforeMutation: () => assertRoutineScopeCurrent(f.hub, expected) });
  f.mutate('disconnect', 'github'); f.connect('github', 'OtherOwner'); resume();
  await assert.rejects(pending, { code: 'SOURCE_AUTHORITY_CHANGED' }); assert.equal(f.hub.all('routine').length, 0);
});

test('background sessions and comparison keys never inherit human chat or an older private scope', async t => {
  const f = fixture(t), { routine } = await f.create();
  const sessionKey = JSON.stringify([routine.conversationId, f.pair.endpointId]);
  f.hub.put('session', { id: sessionKey, conversationId: routine.conversationId, endpointId: f.pair.endpointId, nativeSessionId: 'human-session', tools: ['xiaoman_journal'] });
  f.hub.message(routine.conversationId, 'user', 'PRIVATE HUMAN CHAT', { channel: 'web' }, null);
  f.hub.put('routineFact', { id: 'old-private-fact', routineId: routine.id, key: 'PRIVATE_OLD_SOURCE_KEY', scopeHash: 'old-scope' });
  const job = await f.start(routine);
  assert.equal(job.sessionId, null); assert.deepEqual(job.sessionTools, []); assert.deepEqual(job.context, []); assert.equal(job.continuation, null);
  assert.doesNotMatch(job.prompt, /PRIVATE/);
  f.hub.event(f.pair.token, { runId: job.id, lease: job.lease, seq: 1, type: 'session', value: 'background-session' });
  f.hub.event(f.pair.token, { runId: job.id, lease: job.lease, seq: 2, type: 'capabilities', value: { sessionId: 'background-session', tools: ['xiaoman_routines'] } });
  assert.equal(f.hub.get('session', sessionKey).nativeSessionId, 'human-session');
  assert.deepEqual(f.hub.get('session', sessionKey).tools, ['xiaoman_journal']);
  assert.equal(f.hub.get('run', job.id).nativeSessionId, 'background-session');
});

test('in-flight local source reads discard bytes after permission is revoked', async t => {
  const f = fixture(t); f.connect('github', 'FixtureOwner');
  writeFileSync(join(f.root, '.runtime/local-sources.json'), JSON.stringify({ version: 1, github: { account: 'FixtureOwner', command: 'gh' } }), { mode: 0o600 });
  const { routine } = await f.create({ scope: { publicWeb: false, sources: [{ operation: 'github_repositories', filter: { kind: 'all' } }] } }), job = await f.start(routine);
  let release, started; const wait = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; }); let reads = 0;
  const reading = sourcesTool({ root: f.root, hub: f.hub, token: f.pair.token,
    input: { runId: job.id, lease: job.lease, callId: 'in-flight', arguments: { operation: 'github_repositories', kind: 'all' } },
    runner: async () => { reads++; started(); await wait; return { exitCode: 0, stdout: JSON.stringify({ login: 'FixtureOwner' }) }; } });
  await entered; f.mutate('disconnect', 'github'); release();
  await assert.rejects(reading, { code: 'SOURCE_REVOKED' });
  assert.equal(reads, 1); const receipt = f.hub.all('sourceRequest')[0]; assert.equal(receipt.status, 'failed'); assert.equal(receipt.result, undefined);
});

test('routine status cannot reveal older same-conversation task bodies or approvals', async t => {
  const f = fixture(t), { routine } = await f.create(), job = await f.start(routine);
  f.hub.put('run', { id: 'private-old-job', conversationId: routine.conversationId, status: 'uncertain', title: 'PRIVATE TITLE', report: { summary: 'PRIVATE BODY' }, issue: { state: 'resolved', resolution: 'PRIVATE RESOLUTION' } });
  f.hub.put('approval', { id: 'private-approval', conversationId: routine.conversationId, runId: 'private-old-job', state: 'pending', action: { preview: 'PRIVATE PREVIEW' } });
  const status = await statusTool({ root: f.root, hub: f.hub, token: f.pair.token, read: async () => assert.fail('Background status must not inspect global runtime'), input: { runId: job.id, lease: job.lease, arguments: {} } });
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE/); assert.deepEqual(status.waiting, []); assert.deepEqual(status.sources.actions, ['list']);
  assert.equal(status.currentRun.id, job.id);
});

test('claim-time authorization rejects a queued private prompt after revoke, account change or expiry without a scheduler tick', async t => {
  for (const change of ['revoke', 'account', 'expiry']) {
    await t.test(change, async t => {
      const f = fixture(t); f.connect('github', 'FixtureOwner');
      const { routine } = await f.create({ scope: repoScope, endsAt: f.hub.now() + 60000 });
      const { run } = await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'queued-before-change' });
      if (change === 'expiry') f.setNow(routine.endsAt);
      else { f.mutate('disconnect', 'github'); if (change === 'account') f.connect('github', 'OtherOwner'); }
      const result = f.hub.poll(f.pair.token, { runnerId: 'new-client', routineGuardVersion: 1 });
      assert.equal(result.job, null, 'No prior private prompt may cross the claim boundary');
      assert.equal(f.hub.get('run', run.runId).status, 'failed');
      assert.equal(f.hub.get('run', run.runId).error, change === 'revoke' ? 'SOURCE_REVOKED' : change === 'account' ? 'SOURCE_AUTHORITY_CHANGED' : 'ROUTINE_ENDED');
    });
  }
});
