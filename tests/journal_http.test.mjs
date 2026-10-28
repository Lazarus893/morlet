import { ownerSession } from './owner-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWebUI } from '../plugins/webui/server.mjs';
import { failure } from '../plugins/proactive/management.mjs';
import { saveBot } from '../plugins/agent-hub/bots.mjs';

const account = 'a'.repeat(64);
const LOCAL = { account: 'local', userId: 'owner' };

test('a fixed room keeps independent matters and ordinary chat does not inherit its only matter', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixed-room fixture' });
  const opened = await f.post('hub', { operation: 'open-room', kind: 'direct', botId: 'xiaoman' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal((await f.post('hub', { operation: 'open-room', kind: 'direct', botId: 'xiaoman' })).data.id, opened.data.id);
  const base = { operation: 'send', conversationId: opened.data.id, endpointId: paired.endpointId };
  const first = await f.post('hub', { ...base, content: '准备A事项', requestId: 'fixed-a', journal: true });
  assert.equal(first.ok, true, JSON.stringify(first));
  const ordinary = await f.post('hub', { ...base, content: '另外随便聊聊', requestId: 'fixed-chat', journal: false });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary));
  assert.equal(ordinary.data.run.journalItemId, undefined, 'one linked matter is not implicit permission to continue it');
  const secondRequest = { ...base, content: '准备B事项', requestId: 'fixed-b', journal: true };
  const second = await f.post('hub', secondRequest);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.data.journalItemId, first.data.journalItemId);
  assert.equal((await f.post('hub', secondRequest)).data.run.id, second.data.run.id);
  const items = (await f.get('journal')).data.items;
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.conversationId === opened.data.id));
  assert.equal(f.app.hub.conversation(opened.data.id).title, 'Mori', 'matter titles cannot rename a fixed chat');
});

test('fixed-room save retry reuses the matter after a dispatch storage failure', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Retry fixture' });
  const room = (await f.post('hub', { operation: 'open-room', kind: 'group' })).data;
  const request = { operation: 'send', conversationId: room.id, endpointId: paired.endpointId, content: '单独保存本件事', requestId: 'fixed-retry', journal: true };
  const submit = f.app.hub.submit.bind(f.app.hub);
  f.app.hub.submit = () => { throw failure('STORAGE_BUSY'); };
  assert.equal((await f.post('hub', request)).ok, false);
  const item = (await f.get('journal')).data.items[0];
  f.app.hub.submit = submit;
  const result = await f.post('hub', request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.journalItemId, item.id);
  assert.equal((await f.get('journal')).data.items.length, 1);
});

test('continuing A in a shared room keeps A author and context after B was handled by another Bot', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Shared-room fixture' });
  const room = (await f.post('hub', { operation: 'open-room', kind: 'group' })).data;
  for (const id of ['maker', 'research']) {
    const bot = f.app.hub.get('bot', id);
    saveBot(f.app.hub, { id, version: bot.version, values: { endpointId: paired.endpointId } });
  }
  const run = async (botId, content, requestId) => {
    const saved = await f.post('hub', { operation: 'send', conversationId: room.id, botId, content, requestId, journal: true });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const job = f.app.hub.poll(paired.token, { runnerId: 'shared-room-test' }).job;
    f.app.hub.event(paired.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: content + '已处理' });
    return saved.data.journalItemId;
  };
  const itemId = await run('maker', 'A事项专属资料', 'shared-a');
  await run('research', 'B事项专属资料', 'shared-b');
  const item = (await f.get('journal')).data.items.find(item => item.id === itemId);
  const resumed = await f.post('journal/continue', { itemId, itemVersion: item.version, requestId: 'resume-a' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.data.run.botId, 'maker');
  const job = f.app.hub.poll(paired.token, { runnerId: 'shared-room-test' }).job;
  assert.equal(job.continuation.currentJournalItemId, itemId);
  assert.ok(job.continuation.userMessages.some(message => message.text === 'A事项专属资料'));
  assert.ok(!JSON.stringify(job.continuation).includes('B事项专属资料'));
});

test('HTTP parameter preview requires owner session and adopts once without a design call', async t => {
  const f = await fixture(t);
  const saved = await f.post('journal', { operation: 'add', revision: 0, values: { title: '预算计划', taskData: { budget: { total: 600, lines: [{ id: 'food', label: '餐食', amount: 380 }] } } } });
  const item = saved.data.items[0];
  const request = { revision: saved.data.revision, itemId: item.id, itemVersion: item.version, parameters: { budgetTotal: 800 } };
  assert.equal((await f.post('journal/preview', request, { 'X-PA-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.post('journal/preview', { ...request, scope: { account: 'local', userId: 'stranger' } })).status, 403);
  const preview = await f.post('journal/preview', request);
  assert.equal(preview.ok, true);
  assert.equal((await f.get('journal')).data.revision, request.revision);
  const apply = { ...request, previewHash: preview.data.previewHash, requestId: 'http-plan-test' };
  const adopted = await f.post('journal/apply-preview', apply);
  assert.equal(adopted.ok, true);
  assert.equal(adopted.data.items[0].taskData.budget.total, 800);
  assert.equal(adopted.data.layout.workpages[0].itemId, item.id);
  assert.equal(adopted.data.designRequest, undefined);
  assert.equal((await f.post('journal/apply-preview', apply)).data.applyReceipt.replayed, true);
  assert.equal((await f.post('journal/apply-preview', { ...apply, parameters: { budgetTotal: 900 } })).status, 409);
});
test('changing a widget structure promotes it, preserves materials, and survives a fresh read', async t => {
  const f = await fixture(t);
  const created = await f.post('journal', { operation: 'add', revision: 0, values: {
    title: '设计资料核对', taskType: 'prep', steps: [{ id: 'read', label: '核对原始材料', done: false }],
    taskData: { prep: { phases: [{ id: 'check', label: '核对', stepIds: ['read'] }] }, collection: { entries: [{ id: 'source', title: '设计资料', note: '尚待核实' }] } },
  } });
  const before = created.data.items[0];
  const changed = await f.post('journal', { operation: 'update', revision: created.data.revision, itemId: before.id, itemVersion: before.version, values: { taskType: 'collection' } });
  assert.equal(changed.ok, true);
  for (const state of [changed.data, (await f.get('journal')).data]) {
    const item = state.items.find(item => item.id === before.id), page = state.layout.workpages.find(page => page.itemId === before.id);
    assert.equal(item.primaryProjection.kind, 'collection');
    assert.equal(page.stage, 'preparing', 'display choice must not invent business completion');
    const primaryIds = page.sections.filter(section => section.role === 'primary').flatMap(section => section.widgetIds);
    assert.deepEqual(primaryIds, [`${before.id}:collection`]);
    assert.deepEqual(item.steps, before.steps);
    assert.deepEqual(item.taskData, before.taskData);
    assert.ok(state.layout.widgets.some(widget => widget.itemId === before.id && widget.kind === 'prep'));
  }
});

async function fixture(t, { provider = 'dsh', factory, rpc } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'journal-http-'));
  const settings = { revision: 'test', installed: true, runtimeInstalled: true, socket: join(root, 'not-a-real-socket'), pending: [], capabilities: [],
    config: { owner: '测试用户', agent: { provider }, im: { provider: 'weixin', access_policy: 'allowlist', allow_from: ['fixture-user'] }, proactive: { enabled: false, timezone: 'Asia/Shanghai' } } };
  const app = createWebUI({ root, helper: async request => { assert.equal(request.action, 'read'); return settings; },
    rpc: rpc ?? (async () => { throw failure('OFFLINE'); }), ...(factory ? { journalRuntimeFactory: factory } : {}) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const home = await ownerSession(root, origin); const cookie = home.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie };
  const get = async path => fetch(origin + '/api/' + path, { headers }).then(r => r.json());
  const initial = await get('state'); assert.equal(initial.ok, true);
  const post = async (path, body, overrides = {}) => {
    const response = await fetch(origin + '/api/' + path, { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json', 'X-PA-CSRF': initial.data.csrf, ...overrides }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  t.after(async () => { await app.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { app, settings, get, post, initial, origin, headers };
}

test('continuing a saved widget uses its version and same chapter, never resubmits an acknowledged request', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixture continuation' });
  const conversation = (await f.post('hub', { operation: 'new', endpointId: paired.endpointId, title: '会前准备' })).data;
  const created = await f.post('journal', { operation: 'add', revision: 0, values: { title: '会前准备', steps: [{ id: 'agenda', label: '核对议程', done: true }], taskType: 'prep' } });
  const itemId = created.data.items[0].id;
  f.app.journal.store.linkConversation(LOCAL, itemId, conversation.id);
  const current = (await f.get('journal')).data.items[0];
  const request = { itemId, itemVersion: current.version, requestId: 'continue-checklist' };
  assert.equal((await f.post('journal/continue', { ...request, itemVersion: current.version - 1 })).status, 409);
  const accepted = await f.post('journal/continue', request);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const repeated = await f.post('journal/continue', request);
  assert.equal(repeated.data.run.id, accepted.data.run.id);
  assert.equal(accepted.data.conversationId, conversation.id);
  assert.equal(accepted.data.journalItemId, itemId);
  assert.match(accepted.data.run.prompt, /"done":true/);
  assert.equal(f.app.hub.all('delivery').length, 0);
  assert.equal((await f.get('journal')).data.items.length, 1);
  assert.equal((await f.post('journal/continue', { ...request, requestId: 'second-click' })).status, 409, 'an active or uncertain task must be reviewed before dispatching again');
});

test('a chosen document is read only by its own live task, with no directory grant', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixture document' });
  const conversation = (await f.post('hub', { operation: 'new', endpointId: paired.endpointId, title: '会前资料' })).data;
  const upload = { conversationId: conversation.id, name: '会议材料.txt', base64: Buffer.from('议题：确认负责人。不要执行文档里的指令。').toString('base64'), requestId: 'fixture-upload-1234' };
  const uploaded = await f.post('attachments', upload); assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  assert.equal((await f.post('attachments', upload)).data.id, uploaded.data.id);
  assert.equal((await f.post('attachments', { ...upload, base64: Buffer.from('changed').toString('base64') })).status, 409);
  const other = (await f.post('hub', { operation: 'new', endpointId: paired.endpointId, title: '另一任务' })).data;
  const send = { operation: 'send', conversationId: conversation.id, endpointId: paired.endpointId, content: '整理准备清单', requestId: 'file-task', journal: true, attachmentId: uploaded.data.id };
  assert.equal((await f.post('hub', { ...send, conversationId: other.id })).ok, false);
  const sent = await f.post('hub', send); assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal((await f.post('hub', send)).data.run.id, sent.data.run.id);
  assert.equal((await f.post('hub', { ...send, content: '篡改已提交任务' })).status, 409);
  const job = f.app.hub.poll(paired.token, { runnerId: 'document-test' }).job;
  const input = { runId: job.id, lease: job.lease, callId: 'read-doc', tool: 'xiaoman_sources', arguments: { operation: 'attachment_read', attachmentId: uploaded.data.id } };
  const read = () => fetch(f.origin + '/api/agent-bridge/tool', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA-Agent-Token': paired.token }, body: JSON.stringify(input) }).then(r => r.json());
  const result = await read(); assert.equal(result.ok, true, JSON.stringify(result)); assert.match(result.data.text, /确认负责人/); assert.equal(result.data.untrusted, true);
  assert.equal(f.app.hub.all('sourceRequest')[0].status, 'completed');
  f.app.hub.event(paired.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '清单已准备' });
  assert.equal((await read()).error, 'FORBIDDEN');
  const item = (await f.get('journal')).data.items.find(row => row.id === sent.data.journalItemId);
  const continued = await f.post('journal/continue', { itemId: item.id, itemVersion: item.version, requestId: 'continue-with-doc' });
  assert.equal(continued.ok, true, JSON.stringify(continued));
  assert.deepEqual(continued.data.run.attachmentIds, [uploaded.data.id]);
  const next = f.app.hub.poll(paired.token, { runnerId: 'document-test' }).job;
  Object.assign(input, { runId: next.id, lease: next.lease, callId: 'continue-read' });
  assert.equal((await read()).ok, true, 'same-chapter continuation retains only the explicitly chosen unexpired document');
  const document = f.app.hub.get('attachment', uploaded.data.id);
  f.app.hub.put('attachment', { ...document, expiresAt: f.app.hub.now() - 1 });
  assert.equal((await read()).error, 'ATTACHMENT_EXPIRED', 'expiry is rechecked on every read, even for an existing lease');
  f.app.hub.event(paired.token, { runId: next.id, lease: next.lease, seq: 1, type: 'completed', value: '已核对' });
  assert.equal((await f.post('journal/continue', { itemId: item.id, itemVersion: item.version, requestId: 'expired-doc' })).error, 'ATTACHMENT_EXPIRED');
  assert.equal(f.app.hub.all('delivery').length, 0);
});

test('routine HTTP mutations require owner session and CSRF, persist once and use optimistic versions', async t => {
  const f = await fixture(t), pairing = f.app.hub.pair({ label: 'Fixture patrol' });
  const values = { title: '仓库巡查', instruction: '检查已关注仓库的新版本', schedule: { time: '09:00', timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5, 6, 7] }, trigger: { condition: '有尚未回报的新版本', mode: 'changed' }, endpointId: pairing.endpointId };
  const input = { operation: 'create', requestId: 'routine-http-create', values };
  assert.equal((await fetch(f.origin + '/api/routines')).status, 403);
  assert.equal((await f.post('routines', input, { 'X-PA-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.post('routines', input, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.post('routines', { operation: 'result', matched: true, summary: '伪造完成', facts: [] })).status, 403);
  const created = await f.post('routines', input);
  assert.equal(created.ok, true, JSON.stringify(created));
  const routine = created.data.routine;
  const repeated = await f.post('routines', input);
  assert.equal(repeated.data.routine.id, routine.id);
  assert.equal((await f.get('routines')).data.routines.length, 1);
  assert.equal((await f.post('routines', { ...input, values: { ...values, title: '不同提交' } })).status, 409);
  const journal = (await f.get('journal')).data;
  assert.equal(journal.routines[0].journalItemId, routine.journalItemId);
  assert.equal(journal.items.filter(item => item.id === routine.journalItemId).length, 1);
  const pause = { operation: 'pause', requestId: 'routine-http-pause', id: routine.id, version: routine.version };
  assert.equal((await f.post('routines', pause)).data.routine.enabled, false);
  assert.equal((await f.post('routines', pause)).data.routine.version, routine.version + 1);
  assert.equal((await f.post('routines', { operation: 'resume', requestId: 'routine-stale-resume', id: routine.id, version: routine.version })).status, 409);
  assert.equal((await f.get('state')).data.journal.routines[0].enabled, false);
  assert.equal(f.app.hub.all('delivery').length, 0);
});

test('journal preference and item mutations retain routine, notice and suggestion metadata in their response', async t => {
  const f = await fixture(t), pairing = f.app.hub.pair({ label: 'Preference regression' });
  const created = await f.post('routines', { operation: 'create', requestId: 'preferences-routine', values: {
    title: '保留后台巡查', instruction: '只读公开项目', endpointId: pairing.endpointId,
    schedule: { time: '09:00', timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5, 6, 7] }, trigger: { condition: '新版本', mode: 'changed' },
  } });
  assert.equal(created.ok, true, JSON.stringify(created));
  const routine = created.data.routine;
  let journal = (await f.get('journal')).data;
  const retained = data => {
    assert.equal(data.routines?.length, 1, 'Mutation response must retain the routine without waiting for a later poll');
    assert.equal(data.routines[0].id, routine.id);
    assert.equal(data.routines[0].journalItemId, routine.journalItemId);
    assert.equal(data.routineNotices?.byRoutine?.[routine.id]?.state, 'journal');
    assert.deepEqual(data.followupSuggestions, []);
  };
  retained(journal);
  for (const values of [{ motion: 'reduced' }, { motion: 'off' }, { motion: 'system', autoLayout: false }]) {
    const saved = await f.post('journal', { operation: 'preferences', revision: journal.revision, values });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    for (const [key, value] of Object.entries(values)) assert.equal(saved.data.preferences[key], value);
    retained(saved.data); journal = saved.data;
  }
  const item = journal.items.find(item => item.id === routine.journalItemId);
  const edited = await f.post('journal', { operation: 'update', revision: journal.revision, itemId: item.id, itemVersion: item.version, values: { note: '只在有变化时查看' } });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(edited.data.items.find(row => row.id === item.id).note, '只在有变化时查看');
  retained(edited.data);
});

test('a non-owner journal scope never receives local owner routine metadata after a preference mutation', async t => {
  const rpc = async (_socket, input) => {
    assert.equal(input.operation, 'snapshot');
    return { kind: 'pa', data: { protocol: 1, account, users: [{ id: 'fixture-user', tasks: [] }], connected: true, journalAvailable: false } };
  };
  const f = await fixture(t, { rpc }), pairing = f.app.hub.pair({ label: 'Owner patrol' });
  const created = await f.post('routines', { operation: 'create', requestId: 'owner-private-routine', values: {
    title: 'PRIVATE_OWNER_PATROL', instruction: 'PRIVATE_OWNER_INSTRUCTION', endpointId: pairing.endpointId,
    schedule: { time: '09:00', timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5, 6, 7] }, trigger: { condition: '公开变化', mode: 'changed' },
  } });
  assert.equal(created.ok, true, JSON.stringify(created));
  const scope = { account, userId: 'fixture-user' };
  const before = await f.get(`journal?account=${account}&userId=fixture-user`);
  assert.equal(before.ok, true);
  const changed = await f.post('journal', { scope, operation: 'preferences', revision: before.data.revision, values: { motion: 'reduced' } });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.data.preferences.motion, 'reduced');
  assert.deepEqual(changed.data.routines, []);
  assert.deepEqual(changed.data.followupSuggestions, []);
  assert.equal(changed.data.routineNotices?.byRoutine?.[created.data.routine.id], undefined);
  assert.doesNotMatch(JSON.stringify(changed.data), /PRIVATE_OWNER/);
  assert.equal((await f.get('journal')).data.routines[0].id, created.data.routine.id, 'The owner routine remains intact');
});

test('routine agent bridge keeps published artifacts through quiet, failed and uncertain checks with progress reports', async t => {
  const f = await fixture(t), pairing = f.app.hub.pair({ label: 'Fixture patrol' });
  const created = await f.post('routines', { operation: 'create', requestId: 'routine-http-results', values: { title: '仓库巡查', instruction: '只读核对', schedule: { time: '09:00', timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5, 6, 7] }, trigger: { condition: '新版本', mode: 'changed' }, endpointId: pairing.endpointId } });
  const routine = created.data.routine;
  const bridge = async (operation, input) => {
    const response = await fetch(f.origin + '/api/agent-bridge/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA-Agent-Token': pairing.token }, body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  let publishedAnswerAt;
  for (const [index, matched] of [true, false].entries()) {
    const started = await f.post('routines', { operation: 'run_now', requestId: 'manual-check-' + index, id: routine.id, version: routine.version });
    assert.equal(started.ok, true, JSON.stringify(started));
    const claimed = await bridge('poll', { runnerId: 'fixture-patrol', routineGuardVersion: 1 }), job = claimed.data.job;
    assert.equal(job.routine.id, routine.id);
    const call = (name, args, callId) => bridge('tool', { runId: job.id, lease: job.lease, tool: name, arguments: args, callId });
    for (const [name, operation] of [['xiaoman_routines', 'pause'], ['xiaoman_journal', 'add'], ['xiaoman_reminders', 'add'], ['xiaoman_tasks', 'add'], ['xiaoman_memory', 'save']]) assert.equal((await call(name, { operation }, 'blocked-' + name)).status, 403);
    assert.equal((await call('xiaoman_routines', { operation: 'list' }, 'list')).data.currentRoutineId, routine.id);
    const summary = matched ? '仓库发布了可核对的新版本' : '本次没有新增版本';
    assert.equal((await call('xiaoman_routines', { operation: 'result', outcome: 'checked', matched, summary, checks: [{ source: 'https://github.com/example/project/releases', observedAt: Date.now() }], facts: matched ? [{ key: 'release:fixture:v1', summary, url: 'https://github.com/example/project/releases/tag/v1' }] : [] }, 'result')).ok, true);
    assert.equal((await call('xiaoman_report', { summary, outcome: 'completed', ...(matched && { artifacts: [{ label: '已核对的新版本', url: 'https://github.com/example/project/releases/tag/v1' }] }) }, 'report')).ok, true);
    // A fake adapter reports its actual fixture read through the same ordered
    // bridge event as DSH, after model tools and before execution completion.
    const observedAt = Date.now();
    assert.equal((await bridge('event', { runId: job.id, lease: job.lease, seq: 1, type: 'source_receipt', value: { tool: 'web_fetch', source: 'https://github.com/example/project/releases', status: 'completed', observedAt } })).ok, true);
    assert.equal((await bridge('event', { runId: job.id, lease: job.lease, seq: 2, type: 'completed', value: summary })).ok, true);
    assert.deepEqual(f.app.hub.get('routineRun', job.routine.occurrenceId).checks, [{ source: 'https://github.com/example/project/releases', observedAt }]);
    const retained = (await f.get('journal')).data.items.find(row => row.id === routine.journalItemId);
    const reportAt = f.app.hub.get('run', job.id).report.updatedAt;
    if (matched) {
      publishedAnswerAt = reportAt;
      assert.ok(Number.isFinite(publishedAnswerAt));
    } else {
      assert.ok(reportAt > publishedAnswerAt, 'The quiet check is newer than the published answer');
    }
    assert.equal(retained.followupReport.answerAt, publishedAnswerAt, 'A quiet check must not redate the retained answer');
  }
  const journal = (await f.get('journal')).data, item = journal.items.find(item => item.id === routine.journalItemId);
  assert.equal(item.followupReport.answer, '仓库发布了可核对的新版本');
  assert.equal(journal.routines[0].lastStatus, 'quiet');
  for (const status of ['failed', 'uncertain']) {
    assert.equal((await f.post('routines', { operation: 'run_now', requestId: 'interrupted-check-' + status, id: routine.id, version: routine.version })).ok, true);
    const { data: { job } } = await bridge('poll', { runnerId: 'fixture-patrol', routineGuardVersion: 1 });
    assert.equal((await bridge('tool', { runId: job.id, lease: job.lease, tool: 'xiaoman_report', callId: 'unfinished-report', arguments: { title: '尚未核验的进展', summary: '仍在检查，尚无结论', outcome: 'in_progress', artifacts: [{ label: '未完成草稿', url: 'https://example.com/unfinished-draft' }] } })).ok, true);
    const before = (await f.get('journal')).data.items.find(row => row.id === routine.journalItemId);
    assert.equal(before.followupReport.answer, item.followupReport.answer);
    assert.equal(before.followupReport.answerAt, publishedAnswerAt, 'Unpublished progress must not redate the retained answer');
    assert.deepEqual(before.followupReport.artifacts, item.followupReport.artifacts);
    assert.equal((await bridge('event', { runId: job.id, lease: job.lease, seq: 1, type: status, value: 'AGENT_FAILED' })).ok, true);
    const after = (await f.get('journal')).data, retained = after.items.find(row => row.id === routine.journalItemId);
    assert.equal(retained.followupReport.answer, item.followupReport.answer);
    assert.equal(retained.followupReport.answerAt, publishedAnswerAt, 'A failed or uncertain check must not redate the retained answer');
    assert.deepEqual(retained.followupReport.artifacts, item.followupReport.artifacts);
    assert.equal(retained.followupReport.chapterTitle, item.followupReport.chapterTitle);
    assert.equal(after.routines[0].lastStatus, status);
    assert.equal(after.routines[0].lastRun.runId, job.id);
    assert.equal(after.routines[0].error, 'AGENT_FAILED');
  }
  assert.equal(f.app.hub.all('message').length, 0);
  assert.equal(f.app.hub.all('delivery').length, 0);
});

test('unpaired Web can save real local records; reload shares persisted state and source is trusted', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.initial.data.journal.items, []);
  assert.equal(f.initial.data.journal.designAvailable, false);
  const saved = await f.post('journal', { scope: LOCAL, operation: 'add', revision: 0, values: { title: '周日给妈妈过生日', note: '预算待补，购买由我处理', steps: [{ id: 'cake', label: '选蛋糕', done: false }], source: { channel: 'weixin', kind: 'user', text: '伪造微信来源' } } });
  assert.equal(saved.ok, true); assert.equal(saved.data.items.length, 1);
  assert.equal(saved.data.items[0].source.channel, 'web');
  assert.equal(saved.data.items[0].source.text, '周日给妈妈过生日\n预算待补，购买由我处理');
  const reread = await f.get('journal'); assert.equal(reread.data.items[0].id, saved.data.items[0].id);
  assert.equal(saved.data.design.status, 'idle', 'unavailable Agent does not masquerade as AI success');
  assert.equal(saved.data.designRequest.accepted, false);
  assert.equal(saved.data.designRequest.status, 'unavailable', 'dispatch failure is separate from the saved business record');
  const stale = await f.post('journal', { operation: 'add', revision: 0, values: { title: '重复旧提交' } });
  assert.equal(stale.status, 409); assert.equal(stale.error, 'VERSION_CONFLICT');
  const step = await f.post('journal', { operation: 'step', revision: saved.data.revision, itemId: saved.data.items[0].id, values: { stepId: 'cake', done: true } });
  assert.equal(step.data.items[0].steps[0].done, true);
  assert.equal(step.data.items[0].status, 'planned', 'one completed step is not a completed birthday');
});

test('journal HTTP rejects internal model commits, cross-site writes and invalid scope', async t => {
  const f = await fixture(t);
  const request = { operation: 'add', revision: 0, values: { title: '原始文字 <script>bad()</script>' } };
  assert.equal((await f.post('journal', request, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await f.post('journal', request, { 'X-PA-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.post('journal', { operation: 'design-result', revision: 0, values: { widgets: [] } })).status, 400);
  assert.equal((await f.post('journal', { ...request, scope: { account: 'local', userId: 'someone-else' } })).status, 403);
  assert.equal((await f.post('journal', { ...request, scope: [] })).status, 400);
  assert.equal((await f.get('journal?account=..%2Fescape&userId=fixture-user')).ok, false);
  assert.equal(f.app.journal.store.snapshot().items.length, 0);
});

test('Web only accesses the configured WeChat account/user and never manufactures a chat context', async t => {
  let snapshotCalls = 0;
  const rpc = async (_socket, input) => {
    assert.equal(input.operation, 'snapshot'); snapshotCalls++;
    return { kind: 'pa', data: { protocol: 1, account, users: [{ id: 'fixture-user', tasks: [] }], connected: true, journalAvailable: false } };
  };
  const f = await fixture(t, { rpc });
  const scope = { account, userId: 'fixture-user' };
  const saved = await f.post('journal', { scope, operation: 'add', revision: 0, values: { title: '只属于这个微信用户的事项' } });
  assert.equal(saved.ok, true);
  const local = await f.get('journal'); assert.equal(local.data.items.length, 0);
  const bound = await f.get(`journal?account=${account}&userId=fixture-user`); assert.equal(bound.data.items.length, 1);
  const stranger = await f.get(`journal?account=${account}&userId=stranger`); assert.equal(stranger.error, 'FORBIDDEN');
  const wrong = await f.get(`journal?account=${'b'.repeat(64)}&userId=fixture-user`); assert.equal(wrong.error, 'ACCOUNT_CHANGED');
  f.settings.config.im.allow_from = [];
  assert.equal((await f.get(`journal?account=${account}&userId=fixture-user`)).error, 'FORBIDDEN');
  assert.ok(snapshotCalls > 0);
});

test('default design runs in background after structural writes; ordinary date updates stay local', async t => {
  const calls = []; let stopCount = 0;
  const factory = async ({ store }) => ({ ready: true, request: async (scope, { revision }) => {
    calls.push({ scope, revision });
    store.mutate(scope, { operation: 'design-start', revision, values: { status: 'queued' } });
    return { accepted: true, status: 'queued' };
  }, stop: async () => { stopCount++; } });
  const f = await fixture(t, { provider: 'codex', factory });
  const saved = await f.post('journal', { operation: 'add', revision: 0, values: { title: '生日准备' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.data.design.status, 'queued', 'write receipt follows queue acceptance, without waiting for a model result');
  assert.deepEqual(saved.data.designRequest, { accepted: true, status: 'queued', revision: saved.data.revision });
  for (let i = 0; calls.length === 0 && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const current = (await f.get('journal')).data;
  assert.equal(current.design.status, 'queued');
  const moved = await f.post('journal', { operation: 'update', revision: current.revision, itemId: current.items[0].id, values: { date: '2026-10-18T18:00:00+08:00' } });
  assert.equal(moved.ok, true); assert.equal(calls.length, 1);
  assert.equal(moved.data.designRequest, undefined, 'a nonstructural edit does not claim a new dispatch');
  const item = moved.data.items[0];
  const fullForm = await f.post('journal', { operation: 'update', revision: moved.data.revision, itemId: item.id, values: { title: item.title, kind: item.kind, steps: item.steps, candidates: item.candidates, date: item.date, note: '只补充备注' } });
  assert.equal(fullForm.ok, true); assert.equal(calls.length, 1, 'unchanged structural fields in a full editor submission do not invoke AI');
  const paused = await f.post('journal', { operation: 'preferences', revision: fullForm.data.revision, values: { autoLayout: false } });
  assert.equal(paused.ok, true);
  assert.equal((await f.post('journal/design', { revision: paused.data.revision })).error, 'AUTO_LAYOUT_PAUSED');
  assert.equal(stopCount, 0);
});

test('a concurrent edit during design dispatch cannot replace the saved write receipt', async t => {
  let edited;
  const factory = async ({ store }) => ({ ready: true, request: async (scope, { revision }) => {
    const saved = store.snapshot(scope);
    const item = saved.items[0];
    edited = store.mutate(scope, { operation: 'update', revision, itemId: item.id, itemVersion: item.version, values: { note: '用户在另一入口补充的备注' } });
    throw failure('VERSION_CONFLICT');
  }, stop: async () => {} });
  const f = await fixture(t, { provider: 'codex', factory });
  const saved = await f.post('journal', { operation: 'add', revision: 0, values: { title: '保存与设计并发' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.data.revision, 1);
  assert.equal(saved.data.items[0].version, 1);
  assert.equal(saved.data.designRequest.accepted, false);
  assert.equal(saved.data.designRequest.reason, 'VERSION_CONFLICT');
  const current = (await f.get('journal')).data;
  assert.equal(current.revision, edited.revision);
  assert.equal(current.items[0].id, saved.data.items[0].id);
  assert.equal(current.items[0].note, '用户在另一入口补充的备注');
});

test('designer uses consistent saved provider settings and rechecks revoked scope authorization', async t => {
  const constructed = [];
  const rpc = async () => ({ kind: 'pa', data: { protocol: 1, account, users: [{ id: 'fixture-user', tasks: [] }] } });
  const factory = async options => { constructed.push(options); return { ready: true, request: async () => ({ accepted: true }), stop: async () => {} }; };
  const f = await fixture(t, { provider: 'codex', factory, rpc });
  f.settings.agentCommand = 'fixture-codex';
  await f.post('journal', { operation: 'add', revision: 0, values: { title: '手账' } });
  for (let i = 0; !constructed.length && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  const first = constructed[0];
  assert.equal(first.agentConfig.provider, 'codex'); assert.equal(first.agentConfig.command, 'fixture-codex');
  assert.equal(await first.scopeAllowed({ account, userId: 'fixture-user' }), true);
  f.settings.config.im.allow_from = [];
  assert.equal(await first.scopeAllowed({ account, userId: 'fixture-user' }), false);
  f.settings.config.agent.provider = 'workbuddy'; f.settings.agentCommand = 'fixture-workbuddy';
  await f.post('journal/design', { revision: (await f.get('journal')).data.revision });
  assert.equal(constructed.length, 2);
  assert.equal(constructed[1].agentConfig.command, 'fixture-workbuddy');
  assert.equal(await first.scopeAllowed(LOCAL), false, 'old provider cannot publish after settings change');
});

test('native design is unavailable until the live PA reports the saved configuration revision', async t => {
  let loaded = 'old-config'; let designs = 0;
  const rpc = async (_socket, request) => {
    if (request.operation === 'snapshot') return { kind: 'pa', data: { protocol: 1, account, users: [], journalAvailable: true, configRevision: loaded } };
    assert.equal(request.operation, 'journal-design'); designs++;
    return { kind: 'pa', data: { journalDesign: { accepted: true, status: 'queued' } } };
  };
  const f = await fixture(t, { rpc });
  const saved = await f.post('journal', { operation: 'add', revision: 0, values: { title: '只用已加载的核心' } });
  assert.equal(saved.data.designAvailable, false);
  assert.equal((await f.post('journal/design', { revision: saved.data.revision })).error, 'DESIGN_UNAVAILABLE');
  assert.equal(designs, 0);
  loaded = f.settings.revision;
  assert.equal((await f.post('journal/design', { revision: saved.data.revision })).ok, true);
  assert.equal(designs, 1);
});


test('a new notebook message persists one linked matter, projects its report, and remains the same matter on continuation', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixture' });
  const originalAgent = f.app.hub.pair({ label: 'Original default' });
  const conversation = (await f.post('hub', { operation: 'new', endpointId: originalAgent.endpointId, title: '新的一页' })).data;
  assert.equal((await f.get('journal')).data.items.length, 0, 'Opening a blank page is still a draft');
  const request = { operation: 'send', conversationId: conversation.id, endpointId: paired.endpointId, content: '整理新项目的验收清单', requestId: 'notebook-first', journal: true };
  const first = await f.post('hub', request); assert.equal(first.ok, true);
  const itemId = first.data.journalItemId, state = (await f.get('journal')).data;
  assert.equal(state.items.length, 1); assert.equal(state.items[0].id, itemId);
  assert.equal(state.items[0].conversationId, conversation.id);
  assert.equal(state.items[0].title, request.content); assert.equal(state.items[0].note, request.content);
  assert.equal(f.app.hub.conversation(conversation.id).endpointId, paired.endpointId, 'The Agent chosen for the first message remains the new matter default');
  assert.equal(state.items[0].date, null); assert.equal(state.items[0].status, 'planned');
  assert.equal((await f.post('hub', request)).data.run.id, first.data.run.id);
  assert.equal((await f.get('journal')).data.items.length, 1);
  const job = f.app.hub.poll(paired.token, { runnerId: 'fixture' }).job;
  assert.equal(job.journalItemId, itemId); assert.equal(job.continuation.currentJournalItemId, itemId);
  const { journalTool } = await import('../plugins/agent-hub/journal.mjs');
  const tool = arguments_ => journalTool({ hub: f.app.hub, journal: f.app.journal, firstTasks: f.app.firstTasks, read: async () => f.settings, token: paired.token,
    input: { runId: job.id, lease: job.lease, callId: 'fixture', arguments: arguments_ } });
  assert.equal((await tool({ operation: 'list' })).currentItemId, itemId);
  const duplicate = await tool({ operation: 'add', revision: state.revision, values: { title: '不应重复创建' } });
  assert.equal(duplicate.saved, false); assert.equal(duplicate.itemId, itemId);
  const read = await tool({ operation: 'get', itemId });
  const updated = await tool({ ...read.writeTemplate, values: { title: '项目验收', taskType: 'prep', steps: [{ id: 'check', label: '核对功能流程', done: false }] } });
  assert.equal(updated.saved, true); assert.equal(updated.item.id, itemId);
  f.app.hub.tool(paired.token, { tool: 'xiaoman_report', runId: job.id, lease: job.lease, callId: 'report', arguments: { title: '验收清单', summary: '清单已记录，尚未执行验收。', outcome: 'completed' } });
  f.app.hub.event(paired.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '清单已记下。' });
  const reloaded = (await f.get('journal')).data.items[0];
  assert.equal(reloaded.followupReport.conversationId, conversation.id); assert.match(reloaded.followupReport.answer, /清单已记录/);
  const follow = await f.post('hub', { ...request, requestId: 'notebook-follow', content: '继续核对这份清单' });
  assert.equal(follow.data.journalItemId, itemId); assert.equal(follow.data.run.conversationId, conversation.id);
  assert.equal((await f.get('journal')).data.items.length, 1);
  assert.equal(f.app.hub.all('delivery').length, 0);
});

test('Agent-generated chapter titles survive refresh and follow-up while explicit names stay authoritative', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixture' });
  const conversation = (await f.post('hub', { operation: 'new', endpointId: paired.endpointId, title: '新的一页' })).data;
  const send = async (content, requestId) => f.post('hub', { operation: 'send', conversationId: conversation.id, endpointId: paired.endpointId, content, requestId, journal: true });
  const sent = await send('跨年想去首尔，请整理出发前需要确认的事情，预算和出发城市还没定。', 'title-first');
  const itemId = sent.data.journalItemId;
  const report = (job, title, callId) => f.app.hub.tool(paired.token, { tool: 'xiaoman_report', runId: job.id, lease: job.lease, callId, arguments: { title, summary: '正在核对出行条件。', outcome: 'in_progress' } });
  const first = f.app.hub.poll(paired.token, { runnerId: 'title-test' }).job;
  report(first, '首尔跨年准备', 'first-report');
  f.app.hub.tool(paired.token, { tool: 'xiaoman_report', runId: first.id, lease: first.lease, callId: 'artifact', arguments: { summary: '准备清单已整理。', outcome: 'completed', artifacts: [{ label: '清单', url: 'https://example.com/checklist' }] } });
  const firstView = (await f.get('journal')).data;
  assert.equal(firstView.items[0].displayTitle, '首尔跨年准备');
  assert.equal(f.app.hub.conversation(conversation.id).title, '首尔跨年准备');
  assert.match(firstView.items[0].source.text, /预算和出发城市还没定/);
  f.app.hub.event(paired.token, { runId: first.id, lease: first.lease, seq: 1, type: 'completed', value: '已记下待确认项。' });
  await send('先考虑从上海出发', 'title-follow');
  const follow = f.app.hub.poll(paired.token, { runnerId: 'title-test' }).job;
  const continuing = (await f.get('journal')).data.items[0].followupReport;
  assert.equal(continuing.isBusy, true); assert.equal(continuing.answer, '准备清单已整理。');
  assert.equal(continuing.artifacts[0].url, 'https://example.com/checklist');
  report(follow, '上海出发路线', 'follow-report');
  assert.equal((await f.get('journal')).data.items[0].displayTitle, '首尔跨年准备', 'Follow-up must not rename the chapter on every message');
  assert.equal(f.app.hub.conversation(conversation.id).title, '首尔跨年准备');
  const state = (await f.get('journal')).data;
  await f.post('journal', { operation: 'update', revision: state.revision, itemId, values: { title: '我的跨年旅行' } });
  report(follow, '另一份主题', 'later-report');
  assert.equal((await f.get('journal')).data.items[0].title, '我的跨年旅行');
  assert.equal((await f.get('journal')).data.items[0].displayTitle, undefined);
  assert.equal((await f.get('journal')).data.items.length, 1);
});

test('invalid or absent generated titles keep the original chapter and do not affect task reporting', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixture' });
  const conversation = f.app.hub.newConversation({ endpointId: paired.endpointId });
  await f.post('hub', { operation: 'send', conversationId: conversation.id, endpointId: paired.endpointId, content: '核对资料', requestId: 'title-invalid', journal: true });
  const job = f.app.hub.poll(paired.token, { runnerId: 'title-test' }).job;
  for (const [index, title] of [undefined, '主题\n另一行', '过长'.repeat(40)].entries()) {
    f.app.hub.tool(paired.token, { tool: 'xiaoman_report', runId: job.id, lease: job.lease, callId: 'report-' + index, arguments: { ...(title && { title }), summary: '资料还待核实。', outcome: 'partial' } });
    const item = (await f.get('journal')).data.items[0];
    assert.equal(item.title, '核对资料'); assert.equal(item.displayTitle, undefined); assert.equal(item.followupReport.answer, '资料还待核实。');
  }
});

test('a Hub failure after the notebook save recovers without duplicating the matter or dispatch', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixture' });
  const conversation = f.app.hub.newConversation({ endpointId: paired.endpointId });
  const request = { operation: 'send', conversationId: conversation.id, endpointId: paired.endpointId, content: '准备一份核对表', requestId: 'retry-notebook', journal: true };
  const submit = f.app.hub.submit.bind(f.app.hub); f.app.hub.submit = () => { throw failure('STORAGE_BUSY'); };
  assert.equal((await f.post('hub', request)).ok, false);
  const saved = (await f.get('journal')).data.items; assert.equal(saved.length, 1);
  assert.equal(f.app.hub.all('run').length, 0);
  f.app.hub.submit = submit;
  const retry = await f.post('hub', request); assert.equal(retry.ok, true); assert.equal(retry.data.journalItemId, saved[0].id);
  assert.equal((await f.get('journal')).data.items.length, 1); assert.equal(f.app.hub.all('run').length, 1);
});

test('invalid or unauthorized notebook sends cannot create matters; unmarked API conversations keep their contract', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixture' });
  const c = f.app.hub.newConversation({ endpointId: paired.endpointId });
  const request = { operation: 'send', conversationId: c.id, endpointId: paired.endpointId, requestId: 'validation', journal: true, content: '应该只在有效发送后保存' };
  assert.equal((await f.post('hub', { ...request, content: '' })).ok, false);
  assert.equal((await f.post('hub', request, { 'X-PA-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.post('hub', { ...request, endpointId: 'missing' })).ok, false);
  assert.equal((await f.get('journal')).data.items.length, 0);
  assert.equal((await f.post('hub', { ...request, journal: false })).ok, true);
  assert.equal((await f.get('journal')).data.items.length, 0);
});

test('an existing matter can open a conversation before any report and continue without another matter', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixture' });
  const saved = await f.post('journal', { operation: 'add', revision: 0, values: { title: '旅行准备', note: '出发城市未定', taskType: 'prep' } });
  const item = saved.data.items[0], request = { itemId: item.id, scope: LOCAL };
  assert.equal((await f.post('journal/conversation', request, { 'X-PA-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.post('journal/conversation', { ...request, scope: { account, userId: 'fixture-user' } })).status, 403);
  assert.equal((await f.post('journal/conversation', { itemId: 'missing' })).status, 404);
  assert.equal(f.app.hub.all('conversation').length, 0);
  const opened = await f.post('journal/conversation', request); assert.equal(opened.ok, true);
  assert.deepEqual((await f.post('journal/conversation', request)).data, opened.data);
  assert.equal(f.app.hub.all('conversation').length, 1); assert.equal(f.app.hub.all('run').length, 0);
  const linked = (await f.get('journal')).data.items[0];
  assert.equal(linked.conversationId, opened.data.conversationId); assert.equal(linked.note, item.note);
  assert.equal(linked.updatedAt, item.updatedAt); assert.equal(linked.status, item.status);
  const send = { operation: 'send', ...opened.data, journalItemId: item.id, journal: true, endpointId: paired.endpointId, content: '从北京出发', requestId: 'matter-followup' };
  assert.equal((await f.post('hub', { ...send, journalItemId: 'unrelated' })).status, 404);
  const accepted = await f.post('hub', send); assert.equal(accepted.ok, true);
  assert.equal((await f.post('hub', send)).data.run.id, accepted.data.run.id);
  const job = f.app.hub.poll(paired.token, { runnerId: 'fixture' }).job;
  assert.equal(job.continuation.currentJournalItemId, item.id);
  assert.equal((await f.get('journal')).data.items.length, 1);
  assert.equal(f.app.hub.all('delivery').length, 0);
});

test('legacy Agent-created matters recover their exact conversation and route reports to the selected matter', async t => {
  const f = await fixture(t), paired = f.app.hub.pair({ label: 'Fixture' });
  const conversation = f.app.hub.newConversation({ endpointId: paired.endpointId, title: '原旅行讨论' });
  f.app.hub.submit({ conversationId: conversation.id, content: '记录旅行和行李准备', requestId: 'legacy-start' });
  const job = f.app.hub.poll(paired.token, { runnerId: 'fixture' }).job;
  const { journalTool } = await import('../plugins/agent-hub/journal.mjs');
  const items = [];
  for (const title of ['旅行准备', '行李清单']) {
    const saved = await journalTool({ hub: f.app.hub, journal: f.app.journal, firstTasks: f.app.firstTasks, read: async () => f.settings, token: paired.token,
      input: { runId: job.id, lease: job.lease, callId: title, arguments: { operation: 'add', revision: (await f.get('journal')).data.revision, values: { title } } } });
    items.push(saved.item);
  }
  f.app.hub.event(paired.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '两件事已分别记下。' });
  for (const item of items) {
    const opened = await f.post('journal/conversation', { itemId: item.id });
    assert.equal(opened.data.conversationId, conversation.id);
  }
  assert.equal(f.app.hub.all('conversation').length, 1);
  const selected = items[1];
  const sent = await f.post('hub', { operation: 'send', conversationId: conversation.id, endpointId: paired.endpointId, journalItemId: selected.id,
    journal: true, content: '行李只带一个背包', requestId: 'selected-item' });
  assert.equal(sent.data.journalItemId, selected.id);
  const follow = f.app.hub.poll(paired.token, { runnerId: 'fixture' }).job;
  assert.equal(follow.continuation.currentJournalItemId, selected.id);
  assert.ok(follow.continuation.userMessages.some(message => message.text === '记录旅行和行李准备'));
  f.app.hub.reply(conversation.id, '我先看看。', { channel: 'web' }, follow.id);
  assert.equal((await f.get('journal')).data.items[1].followupReport.answer, null, 'Conversation text alone is not a produced result');
  f.app.hub.tool(paired.token, { tool: 'xiaoman_report', runId: follow.id, lease: follow.lease, callId: 'luggage-report', arguments: { summary: '按一个背包继续核对。', outcome: 'partial' } });
  f.app.hub.event(paired.token, { runId: follow.id, lease: follow.lease, seq: 1, type: 'completed', value: '按一个背包继续核对。' });
  const state = (await f.get('journal')).data;
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].followupReport, undefined);
  assert.equal(state.items[1].followupReport.answer, '按一个背包继续核对。');
  assert.deepEqual(state.items[0].sourceRef, { conversationId: conversation.id, messageId: job.messageId });
  assert.deepEqual(state.items[1].sourceRef, { conversationId: conversation.id, messageId: job.messageId });
  assert.equal(state.items[1].followupReport.sourceRef.messageId, f.app.hub.all('message').findLast(message => message.runId === follow.id).id);
  assert.equal(f.app.hub.all('delivery').length, 0);
});

test('conversation linking retries after a journal storage failure without opening another conversation', async t => {
  const f = await fixture(t); f.app.hub.pair({ label: 'Fixture' });
  const saved = await f.post('journal', { operation: 'add', revision: 0, values: { title: '手动记录' } });
  const request = { itemId: saved.data.items[0].id }, link = f.app.journal.store.linkConversation.bind(f.app.journal.store);
  f.app.journal.store.linkConversation = () => { throw failure('STORAGE_BUSY'); };
  assert.equal((await f.post('journal/conversation', request)).error, 'STORAGE_BUSY');
  assert.equal(f.app.hub.all('conversation').length, 1);
  f.app.journal.store.linkConversation = link;
  assert.equal((await f.post('journal/conversation', request)).ok, true);
  assert.equal(f.app.hub.all('conversation').length, 1); assert.equal(f.app.hub.all('run').length, 0);
  assert.equal((await f.get('journal')).data.items.length, 1);
});

test('automatic edition identity comes from stored source and day, without rewriting records or grouping by title', async t => {
  const f = await fixture(t), store = f.app.journal.store;
  for (const kind of ['automatic', 'user']) {
    const state = store.snapshot(LOCAL);
    const next = store.mutate(LOCAL, { operation: 'add', revision: state.revision, values: { title: '同样的整理标题', source: { kind, channel: kind === 'automatic' ? 'background' : 'web', text: '原始内容' } } });
    const item = next.items.find(item => !state.items.some(old => old.id === item.id));
    const row = { source: 'github', day: '2026-10-22', entryId: kind, hook: '摘要', summary: '详情' };
    store.db.prepare('INSERT INTO journal_content_entries(id,item_id,data) VALUES(?,?,?)').run(kind, item.id, JSON.stringify(row));
  }
  const before = store.snapshot(LOCAL), automatic = before.items.find(item => item.source.kind === 'automatic');
  let projected = (await f.get('journal')).data.items;
  assert.deepEqual(projected.find(item => item.id === automatic.id).contentSeries, { id: 'github', title: 'GitHub 整理', day: '2026-10-22' });
  assert.equal(projected.find(item => item.source.kind === 'user').contentSeries, undefined);
  assert.deepEqual(store.snapshot(LOCAL), before);
  store.db.prepare('INSERT INTO journal_content_entries(id,item_id,data) VALUES(?,?,?)').run('mixed', automatic.id, JSON.stringify({ source: 'google-mail', day: '2026-10-22' }));
  projected = (await f.get('journal')).data.items;
  assert.equal(projected.find(item => item.id === automatic.id).contentSeries, undefined, 'mixed content must not be mislabeled as a source series');
});
