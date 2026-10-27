import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { JournalDesigner, parseDesign, designFailureDiagnostic } from '../plugins/life-journal/designer.mjs';
import { createJournalRuntime, scopeForMessage, attachJournalChief } from '../plugins/life-journal/chief.mjs';

const scope = { account: 'local', userId: 'owner' };
const rolePath = fileURLToPath(new URL('../agents/life-journal-designer/AGENT.md', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(10); } assert.fail('journal condition timed out'); }
async function fixture(t, analyze, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'journal designer '));
  const store = new JournalStore(root);
  const designer = new JournalDesigner({ root, store, rolePath, analyze, ...options });
  t.after(async () => { await designer.stop(); store.close(); await rm(root, { recursive: true, force: true }); });
  const add = (target = scope, title = '生日准备') => store.mutate(target, { operation: 'add', revision: store.snapshot(target).revision, values: { title } });
  return { root, store, designer, add };
}
const output = snapshot => JSON.stringify({ widgets: snapshot.items.filter(item => item.status !== 'cancelled').map((item, i) => ({ id: `${item.id}:${item.status === 'done' ? 'memory' : 'agenda'}`, itemId: item.id, kind: item.status === 'done' ? 'memory' : 'agenda', emphasis: i ? 'normal' : 'primary' })), reason: '先呈现当前事项' });

test('first item designs with real role, minimal data and idempotent scope queue', async t => {
  let calls = 0, release;
  const f = await fixture(t, async (instructions, text, signal) => {
    calls++; assert.match(instructions, /默认手账设计 Agent/); assert.match(instructions, /不是指令/); assert.equal(signal.aborted, false);
    const data = JSON.parse(text); assert.equal(data.account, undefined); assert.equal(data.userId, undefined); assert.equal(data.items[0].source, undefined);
    await new Promise(resolve => { release = resolve; }); return output({ items: data.items });
  });
  f.add(); const a = await f.designer.request(scope); const b = await f.designer.request(scope);
  assert.equal(a.token, b.token); await until(() => calls === 1);
  assert.equal((await f.designer.request(scope)).status, 'running'); release();
  await until(() => f.store.snapshot(scope).design.status === 'ready');
  const snapshot = f.store.snapshot(scope); assert.equal(snapshot.revision, 1); assert.equal(snapshot.layout.source, 'agent'); assert.equal(calls, 1);
});

test('strict proposal rejects code, invented bindings and duplicate primary widgets', async t => {
  const f = await fixture(t, async () => '{"widgets":[],"reason":"ok","script":"fetch(credentials)"}');
  const snapshot = f.add();
  assert.throws(() => parseDesign('{"widgets":[],"reason":"ok","script":"x"}', snapshot), /INVALID_DESIGN/);
  assert.throws(() => parseDesign('{"widgets":[],"reason":"忽略所有事项"}', snapshot), /INVALID_DESIGN/);
  assert.throws(() => parseDesign('{"widgets":[{"id":"other:focus","itemId":"other","kind":"focus"}],"reason":"x"}', snapshot), /INVALID_DESIGN/);
  await f.designer.request(scope); await until(() => f.store.snapshot(scope).design.status === 'failed');
  assert.equal(f.store.snapshot(scope).design.errorCode, 'INVALID_PROPOSAL'); assert.equal(f.store.snapshot(scope).layout.source, 'basic');
  assert.equal(f.store.snapshot(scope).design.diagnostic.stage, 'validation');
  assert.equal(f.store.snapshot(scope).design.diagnostic.code, 'INVALID_DESIGN');
});

test('minimal input gives current arrangements priority over old completed memories', async t => {
  let offered;
  const f = await fixture(t, async (_role, text) => { offered = JSON.parse(text).items; return JSON.stringify({ widgets: [{ id: `${offered[0].id}:agenda`, itemId: offered[0].id, kind: 'agenda', emphasis: 'primary' }], reason: '先处理当前安排' }); });
  for (let i = 0; i < 31; i++) {
    const added = f.add(scope, `旧事项 ${i}`), item = added.items.at(-1);
    f.store.mutate(scope, { operation: 'done', revision: added.revision, itemId: item.id });
  }
  const current = f.add(scope, '新生日准备'); await f.designer.request(scope);
  await until(() => f.store.snapshot(scope).design.status === 'ready');
  assert.equal(offered.length, 30); assert.equal(offered[0].id, current.items.at(-1).id); assert.equal(offered[0].title, '新生日准备');
});

test('reschedule and paused layout discard late results without rewriting facts', async t => {
  let release;
  const f = await fixture(t, async (_role, text) => { const data = JSON.parse(text); await new Promise(resolve => { release = () => resolve(output({ items: data.items })); }); });
  const added = f.add(); await f.designer.request(scope); await until(() => release);
  const updated = f.store.mutate(scope, { operation: 'update', revision: added.revision, itemId: added.items[0].id, values: { date: '2026-10-18T12:00+08:00' } });
  f.store.mutate(scope, { operation: 'preferences', revision: updated.revision, values: { autoLayout: false } });
  assert.equal((await f.designer.request(scope)).status, 'paused'); release(); await until(() => f.designer.running.size === 0);
  const result = f.store.snapshot(scope); assert.equal(result.items[0].date, '2026-10-18T04:00:00.000Z'); assert.equal(result.layout.source, 'basic'); assert.equal(result.design.status, 'idle');
});

test('new structural work replaces an active design and only the current token publishes', async t => {
  let calls = 0, oldResolve, oldSignal;
  const f = await fixture(t, async (_role, text, signal) => {
    calls++; const data = JSON.parse(text);
    if (calls === 1) { oldSignal = signal; return new Promise(resolve => { oldResolve = () => resolve(output({ items: data.items })); }); }
    return output({ items: data.items });
  });
  f.add(); const first = await f.designer.request(scope); await until(() => oldResolve);
  f.add(scope, '新的出行安排'); const next = await f.designer.request(scope); assert.notEqual(next.token, first.token);
  await until(() => f.store.snapshot(scope).design.status === 'ready');
  assert.equal(oldSignal.aborted, true); assert.equal(calls, 2); oldResolve(); await sleep(20);
  const snapshot = f.store.snapshot(scope); assert.equal(snapshot.design.token, next.token); assert.equal(snapshot.layout.widgets.length, 2);
});

test('timeout and stop abort analysis; late success does not publish', async t => {
  let resolve, signal;
  const f = await fixture(t, async (_role, text, deadline) => { signal = deadline; return new Promise(done => { resolve = () => done(output({ items: JSON.parse(text).items })); }); }, { timeoutMs: 30 });
  f.add(); await f.designer.request(scope); await until(() => f.store.snapshot(scope).design.status === 'failed');
  assert.equal(f.store.snapshot(scope).design.diagnostic.stage, 'analysis');
  assert.equal(f.store.snapshot(scope).design.diagnostic.code, 'DESIGN_TIMEOUT');
  assert.equal(signal.aborted, true); resolve(); await sleep(20); assert.equal(f.store.snapshot(scope).layout.source, 'basic');
  await f.designer.request(scope); await until(() => f.store.snapshot(scope).design.status === 'running'); await f.designer.stop();
  assert.equal(signal.aborted, true); assert.equal(f.store.snapshot(scope).design.errorCode, 'DESIGN_INTERRUPTED');
});

test('kernel slots limit concurrent model runs to two across runtime instances', async t => {
  let active = 0, max = 0; const releases = [];
  const f = await fixture(t, async (_role, text) => { active++; max = Math.max(max, active); await new Promise(resolve => releases.push(resolve)); active--; return output({ items: JSON.parse(text).items }); }, { scopeAllowed: scope => scope.account === 'local' });
  const second = new JournalDesigner({ root: f.root, store: f.store, rolePath, analyze: f.designer.analyze, scopeAllowed: scope => scope.account === 'local' }); t.after(() => second.stop());
  const targets = [scope, { ...scope, userId: 'second' }, { ...scope, userId: 'third' }]; targets.forEach(s => f.add(s));
  await Promise.all([f.designer.request(targets[0]), second.request(targets[1]), second.request(targets[2])]);
  await until(() => releases.length === 2); await sleep(130); assert.equal(releases.length, 2);
  releases[0](); await until(() => releases.length === 3); releases[1](); releases[2]();
  await until(() => targets.every(s => f.store.snapshot(s).design.status === 'ready')); assert.equal(max, 2); await second.stop();
});

test('kernel slots release automatically after a separate process crashes', async t => {
  let calls = 0;
  const f = await fixture(t, async (_role, text) => { calls++; return output({ items: JSON.parse(text).items }); });
  const module = new URL('../plugins/life-journal/designer.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { JournalDesigner } from ${JSON.stringify(module)}; const d = new JournalDesigner({root:${JSON.stringify(f.root)},store:{}}); globalThis.fixtureLeases = [d.globalLease(), d.globalLease()]; if (globalThis.fixtureLeases.some(release => typeof release !== 'function')) throw new Error('Fixture did not own both leases'); process.stdout.write('locked'); process.stdin.resume();`], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data'); f.add(); await f.designer.request(scope); await sleep(140);
  assert.equal(calls, 0); assert.equal(f.store.snapshot(scope).design.status, 'queued');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await until(() => f.store.snapshot(scope).design.status === 'ready'); assert.equal(calls, 1);
});

test('queue budget expires honestly rather than spinning forever', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return '{}'; }, { queueTimeoutMs: 10 });
  const releases = [f.designer.globalLease(), f.designer.globalLease()];
  try {
    f.add(); await f.designer.request(scope); await until(() => f.store.snapshot(scope).design.status === 'failed');
    assert.equal(calls, 0); assert.equal(f.store.snapshot(scope).layout.source, 'basic');
    assert.equal(f.store.snapshot(scope).design.diagnostic.stage, 'queue');
    assert.equal(f.store.snapshot(scope).design.diagnostic.code, 'QUEUE_TIMEOUT');
  } finally { releases.forEach(release => release()); }
});

test('stopping a queued runtime cannot cancel another runtime claiming the same token', async t => {
  let finish;
  const f = await fixture(t, async (_role, text) => new Promise(resolve => { finish = () => resolve(output({ items: JSON.parse(text).items })); }));
  const releaseSlots = [f.designer.globalLease(), f.designer.globalLease()];
  f.add(); const queued = await f.designer.request(scope); await sleep(10);
  assert.equal(f.designer.jobs.size, 1); releaseSlots.forEach(release => release());
  const owner = new JournalDesigner({ root: f.root, store: f.store, rolePath, analyze: f.designer.analyze }); t.after(() => owner.stop());
  assert.equal((await owner.request(scope)).token, queued.token); await until(() => finish);
  assert.equal(f.designer.jobs.size, 1); await f.designer.stop();
  assert.equal(f.store.snapshot(scope).design.status, 'running'); finish();
  await until(() => f.store.snapshot(scope).design.status === 'ready'); await owner.stop();
});

test('queue timeout cannot fail a currently leased job', async t => {
  const f = await fixture(t, async () => '{}');
  f.add(); const queued = f.store.mutate(scope, { operation: 'design-start', revision: 1, values: { status: 'queued' } });
  const release = f.designer.scopeLease(scope);
  f.store.mutate(scope, { operation: 'design-start', revision: 1, values: { status: 'running', token: queued.design.token } });
  assert.equal(await f.designer.finishQueued({ scope, token: queued.design.token }, 'DESIGN_FAILED'), false);
  assert.equal(f.store.snapshot(scope).design.status, 'running'); release();
  assert.equal(await f.designer.finishQueued({ scope, token: queued.design.token }, 'DESIGN_FAILED'), true);
  assert.equal(f.store.snapshot(scope).design.status, 'running');
});

test('default scope authority excludes old account queues and request attempts', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return '{"widgets":[],"reason":"ok"}'; });
  const foreign = { account: 'a'.repeat(64), userId: 'former-owner' };
  f.add(foreign); f.store.mutate(foreign, { operation: 'design-start', revision: 1, values: { status: 'queued' } });
  await f.designer.initialize(); await sleep(30);
  assert.equal(calls, 0); assert.equal(f.designer.jobs.size, 0);
  assert.equal((await f.designer.request(foreign)).reason, 'SCOPE_NOT_ALLOWED');
  assert.equal(f.store.snapshot(foreign).design.status, 'queued');
});

test('async dynamic authority is checked before model execution and before publication', async t => {
  let allowed = true, calls = 0, resolve;
  const f = await fixture(t, async (_role, text) => { calls++; return new Promise(done => { resolve = () => done(output({ items: JSON.parse(text).items })); }); }, { scopeAllowed: async () => { await sleep(1); return allowed; } });
  f.add(); const slots = [f.designer.globalLease(), f.designer.globalLease()];
  await f.designer.request(scope); allowed = false; slots.forEach(release => release());
  await until(() => f.designer.jobs.size === 0); assert.equal(calls, 0);
  allowed = true; await f.designer.request(scope); await until(() => resolve);
  allowed = false; resolve(); await until(() => f.designer.running.size === 0);
  assert.equal(f.store.snapshot(scope).layout.source, 'basic'); assert.equal(calls, 1);
});

test('recovery restarts queued work, marks interrupted result unknown and protects live ownership', async t => {
  let calls = 0;
  const f = await fixture(t, async (_role, text) => { calls++; return output({ items: JSON.parse(text).items }); });
  f.add(); f.store.mutate(scope, { operation: 'design-start', revision: 1, values: { status: 'queued' } }); await f.designer.initialize();
  await until(() => f.store.snapshot(scope).design.status === 'ready'); assert.equal(calls, 1);
  const current = f.store.snapshot(scope); const queued = f.store.mutate(scope, { operation: 'design-start', revision: current.revision, values: { status: 'queued' } });
  f.store.mutate(scope, { operation: 'design-start', revision: current.revision, values: { status: 'running', token: queued.design.token } });
  const release = f.designer.scopeLease(scope); const another = new JournalDesigner({ root: f.root, store: f.store, rolePath, analyze: f.designer.analyze });
  await another.initialize(); assert.equal(f.store.snapshot(scope).design.status, 'running'); release();
  await another.initialize(); assert.equal(f.store.snapshot(scope).design.errorCode, 'DESIGN_INTERRUPTED'); assert.equal(calls, 1); await another.stop();
});

test('DSH adapter requires live context; real DSH call has zero tools and a separate prompt', async t => {
  const f = await fixture(t); const unavailable = await createJournalRuntime({ root: f.root, store: f.store, agentConfig: { provider: 'dsh' }, rolePath });
  assert.equal(unavailable.ready, false); f.add(); assert.equal((await unavailable.request(scope)).accepted, false); await unavailable.stop();
  let seen;
  const ctx = { agentDefaultModel: { currentSelection: () => ({ model: 'existing-model' }) }, llm: { async *stream(options) {
    seen = options; const text = options.messages[0].content?.[0]?.text ?? options.messages[0].blocks?.[0]?.text;
    assert.ok(JSON.stringify(options.messages).includes('生日准备'));
    yield { type: 'text-delta', text: output(f.store.snapshot(scope)) }; yield { type: 'finish', finishReason: 'stop' };
  } } };
  const runtime = await createJournalRuntime({ root: f.root, store: f.store, agentConfig: { provider: 'dsh' }, ctx, rolePath });
  await runtime.request(scope); await until(() => ['ready', 'failed'].includes(f.store.snapshot(scope).design.status));
  assert.deepEqual(seen.tools, []); assert.equal(seen.model, 'existing-model'); assert.equal(f.store.snapshot(scope).design.status, 'ready'); await runtime.stop();
});

test('DSH tool-call output is rejected without execution or publication', async t => {
  const f = await fixture(t); f.add(); let options;
  const ctx = { agentDefaultModel: { currentSelection: () => ({ model: 'existing' }) }, llm: { async *stream(value) { options = value; yield { type: 'tool-call-delta', name: 'Bash', arguments: 'send message' }; } } };
  const runtime = await createJournalRuntime({ root: f.root, store: f.store, rolePath, agentConfig: { provider: 'dsh' }, ctx });
  await runtime.request(scope); await until(() => f.store.snapshot(scope).design.status === 'failed');
  assert.deepEqual(options.tools, []); assert.equal(f.store.snapshot(scope).layout.source, 'basic'); await runtime.stop();
});

test('existing Codex and Workbuddy providers execute passive isolated design sessions', async t => {
  const f = await fixture(t); f.add();
  const oldScenario = process.env.PA_TEST_SCENARIO, oldReply = process.env.PA_TEST_REPLY, oldEffort = process.env.PA_TEST_REASONING_EFFORT;
  process.env.PA_TEST_SCENARIO = 'passive'; process.env.PA_TEST_REPLY = output(f.store.snapshot(scope));
  process.env.PA_TEST_REASONING_EFFORT = 'medium';
  try {
    for (const provider of ['codex', 'workbuddy']) {
      const runtime = await createJournalRuntime({ root: f.root, store: f.store, rolePath, agentConfig: { provider, command: fileURLToPath(new URL('./fake_agent.mjs', import.meta.url)), timeout_seconds: 3 } });
      await runtime.request(scope); await until(() => ['ready', 'failed'].includes(f.store.snapshot(scope).design.status));
      assert.equal(f.store.snapshot(scope).design.status, 'ready'); await runtime.stop();
    }
  } finally {
    if (oldScenario === undefined) delete process.env.PA_TEST_SCENARIO; else process.env.PA_TEST_SCENARIO = oldScenario;
    if (oldReply === undefined) delete process.env.PA_TEST_REPLY; else process.env.PA_TEST_REPLY = oldReply;
    if (oldEffort === undefined) delete process.env.PA_TEST_REASONING_EFFORT; else process.env.PA_TEST_REASONING_EFFORT = oldEffort;
  }
});

test('Chief accepts only explicit authorized private commands; duplicates do not design or send', async t => {
  let calls = 0, receives = 0, sends = 0;
  const accountScope = scopeForMessage('fixture-account', { from_user_id: 'user-a' });
  const f = await fixture(t, async (_role, text) => { calls++; return output({ items: JSON.parse(text).items }); }, { scopeAllowed: scope => scope.account === accountScope.account && scope.userId === accountScope.userId });
  const runtime = { store: f.store, request: (scope, opts) => f.designer.request(scope, opts), stop: () => f.designer.stop() };
  const engine = { stopped: false, allowed: id => id === 'user-a', receive: async () => { receives++; return null; }, management: async () => ({ normal: true }), stop: async () => {}, send: () => { sends++; } };
  attachJournalChief(engine, runtime, 'fixture-account');
  const message = { from_user_id: 'user-a', message_id: 123 };
  assert.equal(await engine.receive(message, '周六过生日'), null); assert.equal(f.store.listScopes().length, 0);
  assert.match(await engine.receive(message, '手账 新增 生日准备'), /已保存/); await until(() => calls === 1);
  assert.match(await engine.receive(message, '手账 新增 生日准备'), /没有重复/); assert.equal(calls, 1);
  assert.equal(await engine.receive({ from_user_id: 'stranger', message_id: 124 }, '/journal add secret'), null);
  assert.equal(await engine.receive({ ...message, group_id: 'group', message_id: 125 }, '/journal add group'), null);
  assert.match(await engine.receive({ from_user_id: 'user-a' }, '/journal add no-id'), /尚未写入/);
  assert.equal(f.store.snapshot(scopeForMessage('fixture-account', message)).items.length, 1); assert.equal(sends, 0); assert.ok(receives >= 3);
  assert.equal(f.store.snapshot(accountScope).items[0].source.text, '手账 新增 生日准备');
  await assert.rejects(engine.management({ operation: 'journal-design', scope: { account: '0'.repeat(64), userId: 'stranger' } }), /INVALID_SCOPE/);
  await engine.stop();
});

test('Chief preserves a saved receipt when the layout request fails', async t => {
  const f = await fixture(t); const runtime = { store: f.store, request: async () => { throw new Error('model unavailable'); }, stop: () => f.designer.stop() };
  const engine = { allowed: () => true, stopped: false, receive: async () => null, management: async () => ({}), stop: async () => {} };
  attachJournalChief(engine, runtime, 'fixture');
  const message = { from_user_id: 'owner', message_id: 7 };
  assert.match(await engine.receive(message, '手帐 新增 已保存的生日'), /已保存.*基础排版/s);
  assert.equal(f.store.snapshot(scopeForMessage('fixture', message)).items.length, 1); await engine.stop();
});

test('the failure boundary persists safe HTTP diagnostics across reopen, without retrying or storing private payloads', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    throw Object.assign(new Error('PRIVATE_PROVIDER_BODY secret@example.invalid'), { status: 429, code: 'PRIVATE_TOKEN_VALUE', response: { status: 429, body: 'PRIVATE_MODEL_OUTPUT' }, prompt: 'PRIVATE_PROMPT' });
  });
  const saved = f.add(); await f.designer.request(scope);
  await until(() => f.store.snapshot(scope).design.status === 'failed');
  const result = f.store.snapshot(scope);
  assert.equal(result.design.errorCode, 'DESIGN_FAILED', 'existing consumer semantics are unchanged');
  assert.deepEqual(Object.keys(result.design.diagnostic).sort(), ['code', 'elapsedMs', 'stage', 'statusCode']);
  assert.equal(result.design.diagnostic.stage, 'analysis');
  assert.equal(result.design.diagnostic.code, 'MODEL_RATE_LIMITED');
  assert.equal(result.design.diagnostic.statusCode, 429);
  assert.ok(Number.isSafeInteger(result.design.diagnostic.elapsedMs));
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.deepEqual(result.items, saved.items);
  const reopened = new JournalStore(f.root);
  try { assert.deepEqual(reopened.snapshot(scope).design.diagnostic, result.design.diagnostic); } finally { reopened.close(); }
  await sleep(30); assert.equal(calls, 1, 'diagnostics must not introduce retries');
  f.designer.analyze = async (_role, text) => output({ items: JSON.parse(text).items });
  await f.designer.request(scope); await until(() => f.store.snapshot(scope).design.status === 'ready');
  assert.equal(f.store.snapshot(scope).design.diagnostic, undefined, 'a newly completed design clears the previous failure metadata');
});

test('stage and finite codes distinguish preparation, validation and commit failures', async t => {
  const role = await fixture(t, async () => { throw new Error('MODEL_MUST_NOT_RUN'); }, { rolePath: '/nonexistent-journal-role-fixture' });
  role.add(); await role.designer.request(scope); await until(() => role.store.snapshot(scope).design.status === 'failed');
  assert.equal(role.store.snapshot(scope).design.diagnostic.stage, 'role');
  assert.equal(role.store.snapshot(scope).design.diagnostic.code, 'UNEXPECTED_ERROR');
  const parse = await fixture(t, async () => 'PRIVATE_MODEL_RESPONSE');
  parse.add(); await parse.designer.request(scope); await until(() => parse.store.snapshot(scope).design.status === 'failed');
  assert.equal(parse.store.snapshot(scope).design.diagnostic.stage, 'validation');
  assert.equal(parse.store.snapshot(scope).design.diagnostic.code, 'INVALID_DESIGN');
  assert.equal(JSON.stringify(parse.store.snapshot(scope)).includes('PRIVATE_MODEL_RESPONSE'), false);
  const commit = await fixture(t, async (_role, text) => output({ items: JSON.parse(text).items }));
  commit.add(); const mutate = commit.store.mutate.bind(commit.store);
  commit.store.mutate = (target, request, ...rest) => {
    if (request.operation === 'design-result') throw Object.assign(new Error('PRIVATE_COMMIT_FAILURE'), { code: 'INVALID_REQUEST' });
    return mutate(target, request, ...rest);
  };
  await commit.designer.request(scope); await until(() => commit.store.snapshot(scope).design.status === 'failed');
  assert.equal(commit.store.snapshot(scope).design.diagnostic.stage, 'commit');
  assert.equal(commit.store.snapshot(scope).design.diagnostic.code, 'INVALID_REQUEST');
  assert.equal(commit.store.snapshot(scope).layout.source, 'basic');
});

test('diagnostic projection never copies arbitrary error keys, strings or out-of-range metadata', () => {
  const d = designFailureDiagnostic({ code: 'PRIVATE_TOKEN_VALUE', message: 'PRIVATE_TEXT', stack: 'PRIVATE_STACK', status: '401', finishKind: 'PRIVATE_FINISH', textCharacters: Infinity }, 'analysis', -10);
  assert.deepEqual(d, { stage: 'analysis', code: 'MODEL_REQUEST_FAILED', elapsedMs: 0 });
  assert.deepEqual(designFailureDiagnostic({ code: 'PROACTIVE_INCOMPLETE_RESULT', finishKind: 'max-tokens', textCharacters: 321 }, 'analysis', 123.4), { stage: 'analysis', code: 'PROACTIVE_INCOMPLETE_RESULT', elapsedMs: 123, finishKind: 'max-tokens', textCharacters: 321 });
  assert.equal(designFailureDiagnostic({ cause: { code: 'ECONNRESET', message: 'PRIVATE' } }, 'analysis', 1).code, 'MODEL_NETWORK_ERROR');
  assert.equal(designFailureDiagnostic({ response: { status: 401, body: 'PRIVATE' } }, 'analysis', 1).code, 'MODEL_AUTH_REQUIRED');
  assert.equal(designFailureDiagnostic({ statusCode: 503 }, 'analysis', 1).code, 'MODEL_HTTP_ERROR');
});

test('the store refuses private or unbounded diagnostic fields at the persistence boundary', async t => {
  const f = await fixture(t);
  f.add(); const started = f.store.mutate(scope, { operation: 'design-start', revision: 1 });
  const valid = { stage: 'analysis', code: 'MODEL_REQUEST_FAILED', elapsedMs: 42 };
  for (const diagnostic of [{ ...valid, message: 'PRIVATE' }, { ...valid, code: 'PRIVATE_TOKEN' }, { ...valid, stage: 'PRIVATE_STAGE' }, { ...valid, statusCode: 999 }, { ...valid, elapsedMs: Infinity }, { ...valid, finishKind: 'PRIVATE' }]) {
    assert.throws(() => f.store.mutate(scope, { operation: 'design-failed', revision: 1, values: { token: started.design.token, baseRevision: 1, layoutVersion: started.layout.version, errorCode: 'DESIGN_FAILED', diagnostic } }), /INVALID_REQUEST/);
    assert.equal(f.store.snapshot(scope).design.status, 'running');
  }
});

test('a failing optional logger cannot replace the original provider diagnostic', async t => {
  const f = await fixture(t); f.add();
  const ctx = { logger: () => { throw new Error('PRIVATE_LOGGER_FAILURE'); }, agentDefaultModel: { currentSelection: () => ({ model: 'fixture' }) }, llm: { async *stream() { throw Object.assign(new Error('PRIVATE_PROVIDER_FAILURE'), { statusCode: 403 }); } } };
  const runtime = await createJournalRuntime({ root: f.root, store: f.store, rolePath, agentConfig: { provider: 'dsh' }, ctx });
  t.after(() => runtime.stop());
  await runtime.request(scope); await until(() => f.store.snapshot(scope).design.status === 'failed');
  assert.equal(f.store.snapshot(scope).design.diagnostic.code, 'MODEL_AUTH_REQUIRED');
  assert.equal(f.store.snapshot(scope).design.diagnostic.statusCode, 403);
  assert.equal(JSON.stringify(f.store.snapshot(scope)).includes('PRIVATE_'), false);
});
