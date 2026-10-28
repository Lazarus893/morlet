import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { createFirstTaskFlow, firstTaskTool, FIRST_TASK_TOOL, firstTaskForRun } from '../plugins/agent-hub/first-task.mjs';
import { journalTool } from '../plugins/agent-hub/journal.mjs';
import { createJournalControl } from '../plugins/webui/journal-control.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { AgentCompanion } from '../plugins/agent-hub/companion.mjs';
import { reminderTool } from '../plugins/agent-hub/reminders.mjs';

const plan = () => ({ title: '周日生日准备', kind: 'arrangement', date: '2026-10-18T12:00:00.000Z', note: '给妈妈准备生日。五位，预算300元；地点尚未确定，订购由用户确认。', steps: [{ id: 'cake', label: '选蛋糕', done: false }, { id: 'place', label: '确定地点', done: false }], taskType: 'prep' });
const code = value => error => error.code === value;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pa-first-task-')), hubs = [];
  let now = Date.parse('2026-10-14T03:00:00.000Z');
  const open = () => { const hub = new AgentHub(root, { now: () => now }); hubs.push(hub); return hub; };
  const hub = open(), pairing = hub.pair({ label: 'Test Chief' });
  hub.poll(pairing.token, { runnerId: 'test-chief', claim: false });
  const settings = { revision: 'test', installed: false, config: { agent: { provider: 'disabled' }, im: { provider: 'disabled' }, proactive: { timezone: 'Asia/Shanghai' } } };
  const journal = createJournalControl({ root, readSettings: async () => settings, rpc: async () => { throw new Error('offline fixture'); } });
  const controller = createFirstTaskFlow({ hub });
  t.after(async () => { await journal.close(); for (const h of hubs) h.close(); await rm(root, { recursive: true, force: true }); });
  const action = (operation, extra = {}) => {
    const flow = controller.snapshot().flow;
    return controller.action({ operation, requestId: randomUUID(), ...(flow ? { flowId: flow.id, version: flow.version } : {}), ...extra });
  };
  const start = (text = '帮我准备周日的生日') => action('start', { text, endpointId: pairing.endpointId });
  const poll = () => hub.poll(pairing.token, { runnerId: 'test-chief' }).job;
  const tool = (job, args, callId = randomUUID(), more = {}) => firstTaskTool({ hub, token: pairing.token, input: { runId: job.id, lease: job.lease, callId, arguments: args }, read: async () => settings, ...more });
  const finish = (job, type = 'completed', value = '这一轮整理结束') => hub.event(pairing.token, { runId: job.id, lease: job.lease, seq: hub.get('run', job.id).seq + 1, type, value });
  const prepare = async () => { start(); const job = poll(); await tool(job, { operation: 'propose', proposal: plan() }); finish(job); action('confirm', { proposalVersion: controller.snapshot().flow.proposal.version }); return poll(); };
  const save = (job, args, callId = randomUUID(), overrides = {}) => journalTool({ hub, journal, firstTasks: controller, token: pairing.token, read: async () => settings, input: { runId: job.id, lease: job.lease, callId, arguments: args }, ...overrides });
  return { root, hub, open, controller, pairing, journal, settings, action, start, poll, tool, finish, prepare, save, advance: ms => { now += ms; } };
}

test('draft is durable across fresh SQLite handles and never creates a run, conversation or delivery', async t => {
  const f = await fixture(t);
  const first = f.action('draft', { text: '帮我准备周日的生日', endpointId: f.pairing.endpointId });
  const reopened = createFirstTaskFlow({ hub: f.open() }).snapshot();
  assert.equal(reopened.flow.id, first.flowId); assert.equal(reopened.flow.draft, '帮我准备周日的生日');
  assert.equal(reopened.flow.stage, 'draft'); assert.equal(reopened.flow.conversationId, null);
  assert.deepEqual(f.hub.all('run'), []); assert.deepEqual(f.hub.all('conversation'), []); assert.deepEqual(f.hub.all('delivery'), []);
});

test('start consumes only explicit submission, is request-id idempotent, rejects conflicting parameters and stale CAS', async t => {
  const f = await fixture(t);
  f.action('draft', { text: '帮我准备周日的生日', endpointId: f.pairing.endpointId });
  const flow = f.controller.snapshot().flow, input = { operation: 'start', flowId: flow.id, version: flow.version, requestId: 'start-one' };
  const result = f.controller.action(input);
  assert.deepEqual(f.controller.action(input), result);
  assert.equal(f.hub.all('run').length, 1); assert.equal(f.hub.all('message').length, 1); assert.equal(result.flow.draft, '');
  assert.equal(f.hub.all('run')[0].prompt, '帮我准备周日的生日');
  assert.equal(f.hub.all('run')[0].firstTaskId, result.flowId); assert.equal(f.hub.all('run')[0].source.channel, 'web');
  assert.throws(() => f.controller.action({ ...input, text: '不同请求' }), code('CONFLICT'));
  assert.throws(() => f.controller.action({ ...input, requestId: 'stale' }), code('VERSION_CONFLICT'));
  assert.deepEqual(f.hub.all('binding'), []); assert.deepEqual(f.hub.all('delivery'), []);
});

test('ask/propose uses the current authenticated lease and durable callId digest without pretending to confirm or save', async t => {
  const f = await fixture(t); f.start(); const job = f.poll();
  const ask = { operation: 'ask', message: '先确认三件事', questions: [{ id: 'person', label: '给谁过生日？' }, { id: 'time', label: '周日几点，几位参加？', hint: '可以一句话回答' }, { id: 'budget', label: '预算是多少？' }] };
  const receipt = await f.tool(job, ask, 'ask-one'); assert.deepEqual(await f.tool(job, ask, 'ask-one'), receipt);
  assert.equal(f.controller.snapshot().flow.stage, 'awaiting_answer'); assert.equal(f.controller.snapshot().flow.questions.length, 3);
  assert.equal(f.controller.snapshot().flow.confirmedProposal, null); assert.equal(f.journal.store.snapshot().items.length, 0);
  await assert.rejects(f.tool(job, { ...ask, message: '另一句' }, 'ask-one'), code('CONFLICT'));
  await assert.rejects(f.tool({ ...job, lease: 'old' }, ask), code('FORBIDDEN'));
  const wrong = f.hub.pair({ label: 'Other Chief' });
  await assert.rejects(f.tool(job, ask, 'wrong-endpoint', { token: wrong.token }), code('FORBIDDEN'));
  await assert.rejects(f.tool(job, { operation: 'confirm', proposal: plan() }), code('INVALID_INPUT'));
  assert.deepEqual(FIRST_TASK_TOOL.inputSchema.properties.operation.enum, ['ask', 'propose', 'blocked']);
});

test('answer is a natural sentence on the same Web conversation; current run and CAS fence stale tools', async t => {
  const f = await fixture(t); f.start(); const first = f.poll();
  await f.tool(first, { operation: 'ask', questions: [{ id: 'who', label: '给谁过生日？' }] });
  assert.throws(() => f.action('send', { text: '妈妈，五位，晚上八点' }), code('FIRST_TASK_BUSY'));
  f.finish(first);
  const draft = f.action('draft', { text: '妈妈，五位，晚上八点，预算三百' });
  const input = { operation: 'send', flowId: draft.flowId, version: draft.version, requestId: 'answer-once' };
  const answer = f.controller.action(input); assert.deepEqual(f.controller.action(input), answer);
  assert.equal(f.hub.all('conversation').length, 1); assert.equal(f.hub.all('run').length, 2);
  assert.equal(answer.flow.runIds.length, 2); assert.equal(answer.flow.draft, ''); assert.deepEqual(answer.flow.questions, []);
  await assert.rejects(f.tool(first, { operation: 'propose', proposal: plan() }), code('FORBIDDEN'));
  const second = f.poll(); assert.equal(second.conversationId, first.conversationId);
  await f.tool(second, { operation: 'propose', proposal: plan(), summary: '先记录计划，地点待定' });
  f.finish(second); assert.equal(f.controller.snapshot().flow.stage, 'awaiting_confirmation');
  assert.equal(f.hub.all('delivery').length, 0);
});

test('unconfirmed journal writes are refused; explicit exact proposal confirmation alone queues a save run', async t => {
  const f = await fixture(t); f.start(); const job = f.poll();
  await assert.rejects(f.save(job, { operation: 'add', revision: 0, values: plan() }), code('FIRST_TASK_CONFIRM_REQUIRED'));
  const listed = await f.save(job, { operation: 'list' }); assert.equal(listed.revision, 0);
  assert.equal(listed.firstTask.phase, 'clarify'); assert.equal(listed.firstTask.confirmed, false);
  assert.equal(listed.firstTask.confirmedProposal, null); assert.equal(listed.firstTask.timezone, 'Asia/Shanghai');
  await f.tool(job, { operation: 'propose', proposal: plan() }); f.finish(job);
  assert.equal(f.hub.all('run').length, 1); assert.equal(f.journal.store.snapshot().items.length, 0);
  assert.throws(() => f.action('confirm', { proposalVersion: 500 }), code('VERSION_CONFLICT'));
  const flow = f.controller.snapshot().flow, input = { operation: 'confirm', flowId: flow.id, version: flow.version, proposalVersion: flow.proposal.version, requestId: 'confirmation-once' };
  const accepted = f.controller.action(input); assert.deepEqual(f.controller.action(input), accepted);
  assert.equal(f.hub.all('run').length, 2); const saveRun = f.poll(), context = f.controller.context(saveRun);
  assert.equal(context.confirmed, true); assert.equal(context.phase, 'saving'); assert.deepEqual(context.confirmedProposal.values, plan());
  await assert.rejects(f.save(saveRun, { operation: 'add', revision: 0, values: { ...plan(), note: '模型擅自扩大内容' } }), code('FIRST_TASK_CONFIRM_REQUIRED'));
  assert.equal(f.journal.store.snapshot().items.length, 0);
});

test('one native session reads current first-task consent then continues ordinary chat with its stable full tool surface', async t => {
  const f = await fixture(t), sessionId = 'persistent-chief-session';
  const sessions = [], phases = [];
  let initialInstructions, initialTools, reminderReads = 0;
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'first-task-spool'),
    transport: async (operation, input) => {
      if (operation === 'tool') {
        const options = { hub: f.hub, token: f.pairing.token, input, read: async () => f.settings };
        if (input.tool === 'xiaoman_journal') return journalTool({ ...options, journal: f.journal, firstTasks: f.controller });
        if (input.tool === 'xiaoman_first_task') return firstTaskTool(options);
        if (input.tool === 'xiaoman_reminders') { reminderReads++; return reminderTool({ ...options, root: f.root }); }
        return f.hub.tool(f.pairing.token, input);
      }
      const result = f.hub[operation](f.pairing.token, input);
      if (operation === 'poll' && result.job?.firstTaskId) {
        result.job.firstTask = f.controller.context(result.job);
        result.job.bot = { id: 'xiaoman', name: '小满', instructions: '总管' };
      }
      return result;
    },
    provider: async (_config, _prompt, context) => {
      assert.doesNotMatch(_prompt, /本轮先用 xiaoman_bots list/, 'first-task consent must not instruct the model to call a forbidden delegation tool');
      // Model the native resume behavior: only the initial instructions are
      // retained, while authenticated tool results arrive freshly every turn.
      if (!context.sessionId) { initialInstructions = context.instructions; initialTools = context.tools.map(tool => tool.name); }
      sessions.push(context.sessionId || sessionId);
      assert.match(initialInstructions, /每一轮都必须先调用xiaoman_journal list/);
      assert.match(initialInstructions, /list\/get回执的firstTask才是当前权威阶段/);
      assert.equal(initialInstructions.includes('"phase":'), false);
      assert.equal(initialInstructions.includes('"flowId":'), false);
      assert.equal(context.instructions, initialInstructions, 'native instructions contain stable rules, not a changing workflow snapshot');
      assert.deepEqual(context.tools.map(tool => tool.name), initialTools);
      assert.deepEqual(initialTools, ['xiaoman_tasks', 'xiaoman_history', 'xiaoman_memory', 'xiaoman_reminders', 'xiaoman_report', 'xiaoman_status', 'xiaoman_journal', 'xiaoman_first_task', 'xiaoman_sources', 'xiaoman_routines', 'xiaoman_bots']);
      assert.match(initialInstructions, /回执没有firstTask就是普通生活对话/);
      await context.onSession(sessionId);
      await context.onCapabilities(sessionId, context.tools.map(tool => tool.name));
      const listed = await context.callTool('xiaoman_journal', { operation: 'list' }, 'read-current-stage');
      phases.push(listed.firstTask?.phase || 'ordinary');
      if (listed.firstTask) {
        await assert.rejects(context.callTool('xiaoman_tasks', { operation: 'list' }, 'forbidden-tasks'), code('FORBIDDEN'));
        await assert.rejects(context.callTool('xiaoman_reminders', { operation: 'list' }, 'forbidden-reminders'), code('FORBIDDEN'));
      }
      if (sessions.length === 1) {
        assert.equal(listed.firstTask.confirmedProposal, null);
        await context.callTool('xiaoman_first_task', { operation: 'ask', questions: [{ id: 'who', label: '给谁准备生日？' }] }, 'ask-person');
      } else if (sessions.length === 2) {
        assert.equal(context.sessionId, sessionId); assert.equal(listed.firstTask.confirmed, false);
        await context.callTool('xiaoman_first_task', { operation: 'propose', proposal: plan() }, 'propose-plan');
      } else if (sessions.length === 3) {
        assert.equal(context.sessionId, sessionId); assert.equal(listed.firstTask.confirmed, true);
        assert.equal(listed.firstTask.savedItemId, null);
        assert.deepEqual(listed.firstTask.confirmedProposal.values, plan());
        const saved = await context.callTool('xiaoman_journal', { operation: 'add', revision: listed.revision, values: listed.firstTask.confirmedProposal.values }, 'save-confirmed-plan');
        const current = await context.callTool('xiaoman_journal', { operation: 'get', itemId: saved.item.id }, 'read-saved-plan');
        assert.equal(current.firstTask.phase, 'saving'); assert.equal(current.firstTask.savedItemId, saved.item.id);
        assert.equal(current.firstTask.stage, 'recorded'); assert.deepEqual(current.firstTask.itemIds, [saved.item.id]);
      } else {
        assert.equal(context.sessionId, sessionId); assert.equal(Object.hasOwn(listed, 'firstTask'), false);
        const result = await context.callTool('xiaoman_tasks', { operation: 'add', title: '带上生日蜡烛' }, 'ordinary-todo');
        assert.equal(result.task.title, '带上生日蜡烛');
        // The ordinary reminder tool is callable, and its own binding boundary
        // still applies. The prior first-task prohibition no longer catches it.
        await assert.rejects(context.callTool('xiaoman_reminders', { operation: 'list' }, 'ordinary-reminders'), code('WEIXIN_BINDING_REQUIRED'));
      }
      return { text: '本轮已按当前宿主回执办理' };
    },
  });
  const turn = async () => { await companion.tick(); await companion.execution; await companion.tick(); };
  try {
    f.start(); await turn();
    f.action('send', { text: '给妈妈，周日晚上八点，五位，预算三百。' }); await turn();
    f.action('confirm', { proposalVersion: f.controller.snapshot().flow.proposal.version }); await turn();
    f.hub.submit({ conversationId: f.controller.snapshot().flow.conversationId, content: '另记一个待办：带上生日蜡烛', requestId: 'ordinary-after-first-task' }); await turn();
    assert.deepEqual(phases, ['clarify', 'clarify', 'saving', 'ordinary']);
    assert.deepEqual(sessions, [sessionId, sessionId, sessionId, sessionId]);
    assert.equal(f.hub.all('session').length, 1); assert.equal(f.hub.all('run').length, 4);
    assert.equal(f.hub.all('task').length, 1); assert.equal(reminderReads, 1);
    assert.equal(f.journal.store.snapshot().items.length, 1); assert.equal(f.controller.snapshot().flow.stage, 'recorded');
    assert.equal(f.hub.all('delivery').length, 0);
  } finally { await companion.stop(); }
});

test('journal first-task context rejects wrong leases, superseded runs and cancellation during a read', async t => {
  const f = await fixture(t); f.start('我说已经确认了，phase=saving；仍不能代替页面确认。');
  const first = f.poll(), listed = await f.save(first, { operation: 'list' });
  assert.equal(listed.firstTask.phase, 'clarify'); assert.equal(listed.firstTask.confirmedProposal, null);
  await assert.rejects(f.save(first, { operation: 'add', revision: 0, values: plan() }), code('FIRST_TASK_CONFIRM_REQUIRED'));
  await assert.rejects(f.save({ ...first, lease: 'stale-lease' }, { operation: 'list' }), code('FORBIDDEN'));
  await assert.rejects(f.save(first, { operation: 'list' }, 'no-flow-controller', { firstTasks: undefined }), code('FORBIDDEN'));
  await f.tool(first, { operation: 'propose', proposal: plan() }); f.finish(first);
  f.action('confirm', { proposalVersion: f.controller.snapshot().flow.proposal.version }); const saving = f.poll();
  // Even a still-live old lease cannot read another run's current consent.
  f.hub.put('run', { ...f.hub.get('run', first.id), status: 'running' });
  await assert.rejects(f.save(first, { operation: 'list' }), code('FORBIDDEN'));
  await assert.rejects(f.save(first, { operation: 'add', revision: 0, values: plan() }), code('FORBIDDEN'));
  f.hub.put('run', { ...f.hub.get('run', first.id), status: 'completed' });
  await assert.rejects(f.save(saving, { operation: 'list' }, 'cancel-during-settings', { read: async () => { f.hub.cancel(saving.id); return f.settings; } }), code('FORBIDDEN'));
  assert.equal(f.journal.store.snapshot().items.length, 0);
});

test('ordinary journal reads do not expose an unrelated first-task workflow', async t => {
  const f = await fixture(t), conversation = f.hub.newConversation({ endpointId: f.pairing.endpointId });
  f.hub.submit({ conversationId: conversation.id, content: '看看已有安排', requestId: 'ordinary-read' });
  const job = f.poll(), listed = await f.save(job, { operation: 'list' });
  assert.equal(Object.hasOwn(listed, 'firstTask'), false);
  const item = f.journal.store.mutate(undefined, { operation: 'add', revision: 0, values: { title: '普通生活计划', note: '与首用确认流程无关' } }).items[0];
  const current = await f.save(job, { operation: 'get', itemId: item.id });
  assert.equal(Object.hasOwn(current, 'firstTask'), false); assert.equal(current.item.id, item.id);
});

test('real journalTool receipt binds an exact new item, normal call replay works, new add cannot duplicate it', async t => {
  const f = await fixture(t), job = await f.prepare(), args = { operation: 'add', revision: 0, values: plan() };
  const saved = await f.save(job, args, 'save-once');
  assert.equal(saved.saved, true); assert.equal(f.journal.store.snapshot().items.length, 1);
  const replay = await f.save(job, args, 'save-once'); assert.equal(replay.item.id, saved.item.id);
  const flow = f.controller.snapshot({ journal: f.journal.store.snapshot() }).flow;
  assert.deepEqual(flow.itemIds, [saved.item.id]); assert.equal(flow.itemRecords[0].status, 'planned'); assert.equal(flow.stage, 'recorded');
  assert.notEqual(flow.design.state, 'ready'); assert.equal(flow.runSummary.status, 'running');
  await assert.rejects(f.save(job, { ...args, revision: saved.revision }, 'another-add'), code('FIRST_TASK_ALREADY_SAVED'));
  assert.equal(f.journal.store.snapshot().items.length, 1); f.finish(job);
  const reopened = createFirstTaskFlow({ hub: f.open() }).snapshot({ journal: f.journal.store.snapshot() });
  assert.deepEqual(reopened.flow.itemIds, [saved.item.id]); assert.equal(reopened.flow.runSummary.status, 'completed');
});

test('a real transaction version conflict is proved zero-write; same call keeps the error and fresh revision may save the confirmed plan', async t => {
  const f = await fixture(t), job = await f.prepare();
  const unrelated = f.journal.store.mutate(undefined, { operation: 'add', revision: 0, values: { title: '另一件旧计划', note: '不可冒充首用成功' } });
  const stale = { operation: 'add', revision: 0, values: plan() };
  await assert.rejects(f.save(job, stale, 'stale-version'), code('VERSION_CONFLICT'));
  assert.equal(f.hub.get('effect', 'journal:' + job.id + ':stale-version').state, 'failed');
  assert.equal(f.journal.store.snapshot().items.length, 1); assert.deepEqual(f.controller.snapshot().flow.itemIds, []);
  await assert.rejects(f.save(job, stale, 'stale-version'), code('VERSION_CONFLICT'));
  const saved = await f.save(job, { ...stale, revision: unrelated.revision }, 'fresh-version');
  assert.equal(f.journal.store.snapshot().items.length, 2); assert.notEqual(saved.item.id, unrelated.items[0].id);
  assert.deepEqual(f.controller.snapshot().flow.itemIds, [saved.item.id]);
});

test('a secureFiles failure after real COMMIT preserves the saved record and blocks a new call rather than treating it as zero-write', async t => {
  const f = await fixture(t), job = await f.prepare(), store = f.journal.store;
  const secureFiles = store.secureFiles, exec = store.db.exec.bind(store.db), statements = [];
  const original = Object.assign(new Error('post-commit file permission failure'), { code: 'EACCES' });
  store.db.exec = statement => { statements.push(statement); return exec(statement); };
  store.secureFiles = () => { throw original; };
  try {
    await assert.rejects(f.save(job, { operation: 'add', revision: 0, values: plan() }, 'committed-then-permissions'), error => error === original && error.journalCommitted === true);
    assert.equal(store.snapshot().items.length, 1, 'the SQLite commit is already durable');
    assert.equal(statements.includes('COMMIT'), true); assert.equal(statements.includes('ROLLBACK'), false);
    assert.equal(f.hub.get('effect', 'journal:' + job.id + ':committed-then-permissions').state, 'uncertain');
    assert.deepEqual(f.controller.snapshot().flow.itemIds, [], 'no receipt is invented from a matching title');
  } finally { store.secureFiles = secureFiles; store.db.exec = exec; }
  const reopened = new JournalStore(f.root); t.after(() => reopened.close());
  assert.equal(reopened.snapshot().items.length, 1, 'a separate database handle sees the saved record');
  await assert.rejects(f.save(job, { operation: 'add', revision: 0, values: plan() }, 'committed-then-permissions'), code('FIRST_TASK_WRITE_UNCERTAIN'));
  await assert.rejects(f.save(job, { operation: 'add', revision: store.snapshot().revision, values: plan() }, 'unsafe-new-call'), code('FIRST_TASK_WRITE_UNCERTAIN'));
  assert.equal(store.snapshot().items.length, 1);
});

test('a failed ROLLBACK keeps the original exception and an unknown effect even when the operation had a zero-write marker', async t => {
  const f = await fixture(t), job = await f.prepare(), store = f.journal.store;
  const apply = store.apply, exec = store.db.exec.bind(store.db);
  const original = Object.assign(new Error('original mutation failure'), { code: 'MUTATION_FAILED', journalCommitted: false });
  store.apply = () => { throw original; };
  store.db.exec = statement => { if (statement === 'ROLLBACK') throw new Error('rollback also failed'); return exec(statement); };
  try {
    await assert.rejects(f.save(job, { operation: 'add', revision: 0, values: plan() }, 'rollback-not-confirmed'), error => error === original && error.journalCommitted === undefined);
    assert.equal(f.hub.get('effect', 'journal:' + job.id + ':rollback-not-confirmed').state, 'uncertain');
  } finally { store.apply = apply; store.db.exec = exec; exec('ROLLBACK'); }
  await assert.rejects(f.save(job, { operation: 'add', revision: 0, values: plan() }, 'unsafe-after-rollback-failure'), code('FIRST_TASK_WRITE_UNCERTAIN'));
  assert.equal(store.snapshot().items.length, 0);
});

test('real SQLite BEGIN contention keeps STORAGE_BUSY with a proved zero-write outcome, then allows a fresh explicit call', async t => {
  const f = await fixture(t), job = await f.prepare(), store = f.journal.store;
  const holder = new JournalStore(f.root); t.after(() => holder.close());
  store.db.exec('PRAGMA busy_timeout = 1'); holder.db.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(f.save(job, { operation: 'add', revision: 0, values: plan() }, 'busy-start'), error => error.code === 'STORAGE_BUSY' && error.journalCommitted === false && [5, 6].includes(error.cause?.errcode));
    assert.equal(f.hub.get('effect', 'journal:' + job.id + ':busy-start').state, 'failed');
    assert.equal(store.snapshot().items.length, 0);
  } finally { holder.db.exec('ROLLBACK'); }
  const saved = await f.save(job, { operation: 'add', revision: 0, values: plan() }, 'after-busy');
  assert.equal(saved.saved, true); assert.equal(store.snapshot().items.length, 1);
});

test('an independent beforeCommit gate failure is proved zero-write without changing store transaction evidence', async t => {
  const f = await fixture(t), job = await f.prepare();
  const original = Object.assign(new Error('write gate refused'), { code: 'FORBIDDEN' });
  const journal = { snapshot: (...args) => f.journal.snapshot(...args), mutate: (request, settings, options) => f.journal.mutate(request, settings, { ...options, beforeCommit: () => { throw original; } }) };
  await assert.rejects(f.save(job, { operation: 'add', revision: 0, values: plan() }, 'gate-refused', { journal }), error => error === original && error.journalCommitted === false);
  assert.equal(f.journal.store.snapshot().items.length, 0);
  assert.equal(f.hub.get('effect', 'journal:' + job.id + ':gate-refused').state, 'failed');
  const saved = await f.save(job, { operation: 'add', revision: 0, values: plan() }, 'gate-open');
  assert.equal(saved.saved, true); assert.equal(f.journal.store.snapshot().items.length, 1);
});

test('old owner records never constitute first-task success, and completed text without tool outcome is incomplete', async t => {
  const f = await fixture(t);
  f.journal.store.mutate(undefined, { operation: 'add', revision: 0, values: { title: '已有生日', note: '旧手账' } });
  f.start(); const job = f.poll(); f.finish(job, 'completed', '文字声称已保存');
  const snapshot = f.controller.snapshot({ journal: f.journal.store.snapshot() });
  assert.equal(snapshot.flow.stage, 'incomplete'); assert.deepEqual(snapshot.flow.itemIds, []); assert.deepEqual(snapshot.flow.itemRecords, []);
  assert.equal(snapshot.flow.design.state, 'not_requested'); assert.equal(snapshot.flow.nextAction.kind, 'retry');
  assert.equal(f.hub.all('run').length, 1, 'snapshot does not retry a job');
});

test('repeated read snapshots preserve uncertain execution and block both send and replacing the current flow', async t => {
  const f = await fixture(t); f.start(); f.poll(); f.advance(46000);
  const uncertain = f.controller.snapshot(); assert.equal(uncertain.flow.stage, 'uncertain');
  for (let i = 0; i < 5; i++) assert.equal(f.controller.snapshot().flow.currentRunId, uncertain.flow.currentRunId);
  assert.equal(f.hub.all('run').length, 1);
  assert.throws(() => f.action('send', { text: '继续' }), code('FIRST_TASK_RECOVERY_REQUIRED'));
  assert.throws(() => f.action('new'), code('FIRST_TASK_RECOVERY_REQUIRED'));
  assert.throws(() => f.controller.action({ operation: 'new', requestId: 'bypass' }), code('FIRST_TASK_FLOW_REQUIRED'));
  const cancelling = f.action('cancel-run'); assert.equal(cancelling.flow.stage, 'cancelling');
  assert.throws(() => f.action('send', { text: '继续' }), code('FIRST_TASK_RECOVERY_REQUIRED'));
  const cancelled = f.action('cancel-run', { confirmStopped: true }); assert.equal(cancelled.flow.stage, 'cancelled');
  assert.equal(f.hub.all('run').length, 1);
});

test('a pending or uncertain write blocks a different callId and later runs rather than duplicating a lost receipt', async t => {
  const f = await fixture(t), job = await f.prepare();
  f.hub.put('effect', { id: 'journal:' + job.id + ':interrupted', state: 'pending', digest: 'private' });
  await assert.rejects(f.save(job, { operation: 'add', revision: 0, values: plan() }, 'different-call'), code('FIRST_TASK_WRITE_UNCERTAIN'));
  f.hub.put('effect', { id: 'journal:' + job.id + ':interrupted', state: 'uncertain', digest: 'private', error: 'EXECUTION_UNCERTAIN' });
  f.finish(job, 'failed', 'AGENT_FAILED');
  f.action('send', { text: '请核对后继续同一件事' }); const clarify = f.poll();
  await f.tool(clarify, { operation: 'propose', proposal: plan() }); f.finish(clarify);
  f.action('confirm', { proposalVersion: f.controller.snapshot().flow.proposal.version }); const retry = f.poll();
  await assert.rejects(f.save(retry, { operation: 'add', revision: 0, values: plan() }), code('FIRST_TASK_WRITE_UNCERTAIN'));
  assert.equal(f.journal.store.snapshot().items.length, 0);
});

test('editing a recorded plan requires another proposal and confirmation, then updates the exact linked item', async t => {
  const f = await fixture(t), first = await f.prepare();
  const saved = await f.save(first, { operation: 'add', revision: 0, values: plan() }); f.finish(first);
  f.action('send', { text: '改到下周日' }); const clarify = f.poll();
  const revised = { ...plan(), date: '2026-10-25T12:00:00.000Z', note: '用户改到下周日；其他约定继续' };
  await f.tool(clarify, { operation: 'propose', proposal: revised }); f.finish(clarify);
  f.action('confirm', { proposalVersion: f.controller.snapshot().flow.proposal.version }); const job = f.poll();
  assert.equal(f.controller.context(job).savedItemId, saved.item.id);
  await assert.rejects(f.save(job, { operation: 'add', revision: saved.revision, values: revised }), code('FIRST_TASK_ITEM_MISMATCH'));
  await assert.rejects(f.save(job, { operation: 'update', revision: saved.revision, itemId: 'other-record', itemVersion: saved.item.version, values: revised }), code('FIRST_TASK_ITEM_MISMATCH'));
  const updated = await f.save(job, { operation: 'update', revision: saved.revision, itemId: saved.item.id, itemVersion: saved.item.version, values: revised });
  assert.equal(updated.item.id, saved.item.id); assert.equal(updated.item.date, revised.date); assert.equal(f.journal.store.snapshot().items.length, 1);
});

test('a read-only followup completes on the same item after a real current-run read and completed report', async t => {
  const f = await fixture(t), saveRun = await f.prepare();
  const saved = await f.save(saveRun, { operation: 'add', revision: 0, values: plan() }); f.finish(saveRun);
  f.journal.store.mutate(undefined, { operation: 'update', revision: saved.revision, itemId: saved.item.id, itemVersion: saved.item.version, values: { steps: [{ id: 'cake', label: '选蛋糕', done: true }, { id: 'place', label: '确定地点', done: false }] } });
  f.action('send', { text: '查看最新时间与还没做的事，不修改' }); const job = f.poll();
  assert.equal(f.controller.context(job).phase, 'followup');
  const latest = await f.save(job, { operation: 'get', itemId: saved.item.id });
  assert.equal(latest.item.steps[0].done, true);
  await assert.rejects(f.save(job, { operation: 'update', revision: latest.revision, itemId: saved.item.id, itemVersion: latest.item.version, values: { title: '不应修改' } }), code('FIRST_TASK_CONFIRM_REQUIRED'));
  f.hub.tool(f.pairing.token, { tool: 'xiaoman_report', runId: job.id, lease: job.lease, callId: 'report', arguments: { summary: '已选蛋糕，还需确定地点', outcome: 'completed' } });
  f.finish(job, 'completed', '已选蛋糕，还需确定地点');
  const result = createFirstTaskFlow({ hub: f.open() }).snapshot({ journal: f.journal.store.snapshot() }).flow;
  assert.equal(result.stage, 'recorded'); assert.equal(result.followupAnswer, '已选蛋糕，还需确定地点');
  assert.equal(result.nextAction.kind, 'view'); assert.deepEqual(result.itemIds, [saved.item.id]);
  assert.equal(f.journal.store.snapshot().items.length, 1); assert.equal(result.itemRecords[0].version, latest.item.version);
});

test('followup text alone, partial reports, failed runs, and missing linked records never become success', async t => {
  for (const scenario of ['no-read', 'partial', 'failed', 'missing-record']) {
    await t.test(scenario, async t => {
      const f = await fixture(t), saveRun = await f.prepare();
      const saved = await f.save(saveRun, { operation: 'add', revision: 0, values: plan() }); f.finish(saveRun);
      f.action('send', { text: '还没做哪些事' }); const job = f.poll();
      if (scenario !== 'no-read') await f.save(job, { operation: 'get', itemId: saved.item.id });
      f.hub.tool(f.pairing.token, { tool: 'xiaoman_report', runId: job.id, lease: job.lease, callId: 'report', arguments: { summary: '回答内容', outcome: scenario === 'partial' ? 'partial' : 'completed' } });
      f.finish(job, scenario === 'failed' ? 'failed' : 'completed', '回答内容');
      const journal = f.journal.store.snapshot();
      if (scenario === 'missing-record') journal.items = [];
      const result = f.controller.snapshot({ journal }).flow;
      assert.equal(result.stage, scenario === 'failed' ? 'failed' : 'incomplete');
      assert.equal(result.followupAnswer, null);
    });
  }
});

test('success after commit still binds the real receipt when cancellation occurs before the host returns', async t => {
  const f = await fixture(t), job = await f.prepare();
  const journal = { snapshot: (...args) => f.journal.snapshot(...args), mutate: async (...args) => { const result = await f.journal.mutate(...args); f.hub.cancel(job.id); return result; } };
  const saved = await f.save(job, { operation: 'add', revision: 0, values: plan() }, 'commit-then-cancel', { journal });
  const snapshot = f.controller.snapshot({ journal: f.journal.store.snapshot() });
  assert.deepEqual(snapshot.flow.itemIds, [saved.item.id]); assert.equal(snapshot.flow.stage, 'recorded');
  assert.equal(snapshot.flow.runSummary.status, 'cancelling'); assert.equal(snapshot.flow.nextAction.kind, 'wait');
  assert.equal(f.journal.store.snapshot().items.length, 1);
});

test('a confirmed saving run may describe a blocker but cannot revise the confirmed plan or ask away its consent', async t => {
  const f = await fixture(t), job = await f.prepare();
  const accepted = await f.tool(job, { operation: 'blocked', reason: '尚未拿到成功保存回执', nextAction: '先核对保存状态，暂不重新保存' });
  assert.equal(accepted.stage, 'blocked'); assert.equal(f.controller.snapshot().flow.blocked.reason, '尚未拿到成功保存回执');
  await assert.rejects(f.tool(job, { operation: 'ask', questions: [{ id: 'confirm', label: '当作又确认了一次' }] }), code('FIRST_TASK_CONFIRM_REQUIRED'));
  await assert.rejects(f.tool(job, { operation: 'propose', proposal: plan() }), code('FIRST_TASK_CONFIRM_REQUIRED'));
  assert.equal(f.journal.store.snapshot().items.length, 0);
});

test('draft preserves natural typing whitespace and does not replace the latest explicit action receipt', async t => {
  const f = await fixture(t); const started = f.start();
  const drafted = f.action('draft', { text: '妈妈，五位。  \n' });
  assert.equal(drafted.flow.draft, '妈妈，五位。  \n');
  assert.equal(drafted.flow.lastRequest.operation, 'start'); assert.equal(drafted.flow.lastRequest.version, started.version);
  assert.equal(drafted.flow.lastDraftRequest.operation, 'draft');
});

test('invalid or non-owner/bound conversations, old runs, and model-supplied completed plan fields cannot escape the guided boundary', async t => {
  const f = await fixture(t); f.start(); const job = f.poll();
  await assert.rejects(f.tool(job, { operation: 'propose', proposal: { ...plan(), steps: [{ label: '已经买好', done: true }] } }), code('INVALID_INPUT'));
  await assert.rejects(f.tool(job, { operation: 'propose', proposal: { title: '只有标题' } }), code('FIRST_TASK_PLAN_REQUIRED'));
  await assert.rejects(f.tool(job, { operation: 'ask', questions: Array.from({ length: 4 }, (_, i) => ({ id: 'q' + i, label: '问题' })) }), code('INVALID_INPUT'));
  f.hub.bind({ channel: 'weixin', account: 'test-account', peer: 'test-peer', conversationId: job.conversationId });
  await assert.rejects(f.tool(job, { operation: 'blocked', reason: '失去独立Web绑定', nextAction: '核对会话' }), code('FORBIDDEN'));
  assert.throws(() => firstTaskForRun(f.hub, job), code('FORBIDDEN'));
});

test('snapshot exposes only necessary flow evidence, keeps failed context and preserves history on explicit new', async t => {
  const f = await fixture(t); f.start(); const job = f.poll(); f.finish(job, 'failed', 'AGENT_AUTH_REQUIRED');
  const snapshot = f.controller.snapshot(), serialized = JSON.stringify(snapshot);
  for (const secret of [f.pairing.token, job.lease, 'tokenHash', 'runnerId', 'firstTaskMode']) assert.equal(serialized.includes(secret), false);
  assert.equal(snapshot.flow.stage, 'failed'); assert.equal(snapshot.flow.messages[0].text, '帮我准备周日的生日');
  const newFlow = f.action('new'); assert.notEqual(newFlow.flowId, snapshot.flow.id);
  assert.equal(f.controller.snapshot().history.length, 2); assert.equal(f.hub.all('conversation').length, 1); assert.equal(f.hub.all('run').length, 1);
  assert.throws(() => f.controller.action({ operation: 'draft', flowId: snapshot.flow.id, version: snapshot.flow.version, requestId: 'old-flow', text: '覆盖当前流程' }), code('FIRST_TASK_FLOW_REQUIRED'));
});

test('approval decisions are current-flow scoped, preserve request idempotency, and never create delivery', async t => {
  const f = await fixture(t); f.start(); const job = f.poll();
  f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'approval', value: { id: 'approve-first', toolName: 'read', reason: '核对只读材料' } });
  const flow = f.controller.snapshot().flow;
  assert.equal(flow.approvals.length, 1); assert.equal(flow.runSummary.status, 'waiting_approval');
  const input = { operation: 'decide', flowId: flow.id, version: flow.version, requestId: 'decision-once', approvalId: 'approve-first', allow: false };
  const decided = f.controller.action(input); assert.deepEqual(f.controller.action(input), decided);
  assert.equal(f.hub.get('approval', 'approve-first').state, 'rejected'); assert.equal(f.hub.get('run', job.id).status, 'running');
  assert.equal(f.hub.all('delivery').length, 0);
  const other = f.hub.newConversation({ endpointId: f.pairing.endpointId }), otherRun = f.hub.submit({ conversationId: other.id, content: '其他办理', requestId: 'other' }).run;
  f.hub.put('approval', { id: 'approve-other', runId: otherRun.id, conversationId: other.id, state: 'pending', expiresAt: f.hub.now() + 20000 });
  assert.throws(() => f.action('decide', { approvalId: 'approve-other', allow: true }), code('FORBIDDEN'));
});
