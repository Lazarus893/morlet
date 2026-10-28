import { ownerSession } from './owner-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createWebUI } from '../plugins/webui/server.mjs';
import { failure } from '../plugins/agent-hub/store.mjs';

const LOCAL = { account: 'local', userId: 'owner' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'first-task-http-'));
  const settings = {
    revision: 'first-task-http-fixture', installed: false, runtimeInstalled: false,
    socket: join(root, 'offline.sock'), pending: [], capabilities: [],
    config: {
      owner: '隔离首用测试', agent: { provider: 'dsh' },
      im: { provider: 'disabled', access_policy: 'allowlist', allow_from: [] },
      proactive: { enabled: false, timezone: 'Asia/Shanghai' },
    },
  };
  const makeApp = () => createWebUI({ root, helper: async input => {
    assert.equal(input.action, 'read');
    return settings;
  }, rpc: async () => { throw failure('OFFLINE'); } });
  let app = makeApp();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    app.server.closeAllConnections();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  let origin = `http://127.0.0.1:${app.server.address().port}`;
  const boundedFetch = (path, options = {}) => fetch(origin + path, {
    ...options, signal: AbortSignal.timeout(5000),
  });
  const home = await ownerSession(root, origin);
  let cookie = home.headers.get('set-cookie').split(';')[0];
  const state = await boundedFetch('/api/state', { headers: { Cookie: cookie } }).then(r => r.json());
  assert.equal(state.ok, true);
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-PA-CSRF': state.data.csrf };
  const get = async () => {
    const response = await boundedFetch('/api/first-task', { headers: { Cookie: cookie } });
    return { status: response.status, ...await response.json() };
  };
  const post = async (input, overrides = {}) => {
    const response = await boundedFetch('/api/first-task', {
      method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(input),
    });
    return { status: response.status, ...await response.json() };
  };
  const bridge = async (operation, token, input) => {
    const response = await boundedFetch('/api/agent-bridge/' + operation, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA-Agent-Token': token }, body: JSON.stringify(input),
    });
    return { status: response.status, ...await response.json() };
  };
  const endpoint = app.hub.pair({ provider: 'codex', label: '隔离执行端' });
  app.hub.poll(endpoint.token, { runnerId: 'first-http-runner', claim: false });
  const durableState = () => JSON.stringify(app.hub.db.prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all());
  const reopen = async () => {
    app.server.closeAllConnections();
    await app.shutdown();
    app = makeApp();
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    origin = `http://127.0.0.1:${app.server.address().port}`;
    const page = await ownerSession(root, origin);
    cookie = page.headers.get('set-cookie').split(';')[0];
    const fresh = await boundedFetch('/api/state', { headers: { Cookie: cookie } }).then(r => r.json());
    assert.equal(fresh.ok, true);
    Object.assign(headers, { Cookie: cookie, Origin: origin, 'X-PA-CSRF': fresh.data.csrf });
    return get();
  };
  return { get app() { return app; }, root, get origin() { return origin; }, get cookie() { return cookie; }, headers, settings, endpoint, boundedFetch, get, post, bridge, durableState, reopen };
}

test('normal Web send continues only the matching guide and returns its new report to the same journal item', async t => {
  const f = await fixture(t), store = f.app.journal.store;
  await writeFile(join(f.root, '.runtime/agent-hub.json'), JSON.stringify({ version: 1, agents: [], roles: { conversation: f.endpoint.endpointId } }), { mode: 0o600 });
  const draft = await f.post({ operation: 'draft', text: '另一个尚未发送的草稿', requestId: 'separate-draft' });
  const material = store.mutate(LOCAL, { operation: 'add', revision: 0, values: { title: '近期材料', source: { kind: 'automatic', channel: 'background', text: '隔离资料' }, taskType: 'collection', taskData: { collection: { entries: [{ id: 'release', title: '键盘修复', note: '禁用按钮不再接受键盘触发' }] } } } }).items[0];
  const source = { id: 'a'.repeat(64), itemId: material.id, entryId: 'release', source: 'github', title: '键盘修复', hook: '新版本修复禁用按钮的键盘行为。', summary: '发布说明称禁用按钮不再接受键盘触发。', relevance: '可核对界面行为。', suggestion: '测试禁用按钮。', topic: '界面交互', coverage: '已读发布说明，未运行核验。', evidence: [{ quote: 'Disabled controls ignore keyboard activation.', url: 'https://example.com/release' }], url: 'https://example.com/release', observedAt: Date.now() };
  store.db.prepare('INSERT INTO journal_content_entries VALUES(?,?,?)').run(source.id, material.id, JSON.stringify(source));
  const guide = store.ensureGuide(LOCAL), guideItem = guide.items.find(item => item.id === guide.guide.itemId);
  const selected = store.mutate(LOCAL, { operation: 'widget', revision: guide.revision, itemId: guideItem.id, itemVersion: guideItem.version, values: { kind: 'decision', action: 'choose', candidateId: source.id } });
  const ownerPost = async (path, input, overrides = {}) => {
    const response = await f.boundedFetch('/api/' + path, { method: 'POST', headers: { ...f.headers, ...overrides }, body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  };
  const started = await ownerPost('journal/guide/follow', { scope: LOCAL, itemId: guideItem.id, itemVersion: selected.items.find(item => item.id === guideItem.id).version, revision: selected.revision, requestId: 'initial-follow' });
  assert.equal(started.status, 200);
  const resultItemId = started.data.guide.resultItemId, oldRunId = started.data.guide.report.run.id;
  const finish = async text => {
    const { job } = f.app.hub.poll(f.endpoint.token, { runnerId: 'first-http-runner' });
    const read = await f.bridge('tool', f.endpoint.token, { runId: job.id, lease: job.lease, callId: 'read', tool: 'xiaoman_journal', arguments: { operation: 'get', itemId: resultItemId } });
    assert.equal(read.status, 200);
    f.app.hub.tool(f.endpoint.token, { tool: 'xiaoman_report', runId: job.id, lease: job.lease, callId: 'report', arguments: { summary: text, outcome: 'completed' } });
    f.app.hub.event(f.endpoint.token, { runId: job.id, lease: job.lease, seq: f.app.hub.get('run', job.id).seq + 1, type: 'completed', value: text });
  };
  await finish('这是已有材料的整理。');
  const before = store.snapshot(LOCAL), oldRun = structuredClone(f.app.hub.get('run', oldRunId));
  const input = { operation: 'send', conversationId: oldRun.conversationId, endpointId: f.endpoint.endpointId, content: '重新核对原始资料，不修改记录。', requestId: 'real-web-continuation' };
  for (const overrides of [{ Cookie: '' }, { Origin: 'https://other.invalid' }, { 'X-PA-CSRF': 'wrong' }]) assert.equal((await ownerPost('hub', input, overrides)).status, 403);
  assert.equal(f.app.hub.all('run').length, 1);
  const uploaded = await ownerPost('attachments', { conversationId: oldRun.conversationId, name: '补充材料.txt', base64: Buffer.from('追加的原文依据').toString('base64'), requestId: 'guide-file-12345' });
  assert.equal(uploaded.status, 200);
  input.attachmentId = uploaded.data.id;
  const resumed = await ownerPost('hub', input);
  assert.deepEqual(resumed.data.run.attachmentIds, [input.attachmentId]);
  assert.match(resumed.data.run.prompt, /attachment_read/);
  assert.equal((await ownerPost('hub', { ...input, attachmentId: 'changed' })).status, 409);
  assert.equal(resumed.status, 200); assert.notEqual(resumed.data.run.id, oldRunId);
  assert.equal(resumed.data.run.firstTaskId, oldRun.firstTaskId);
  assert.equal(resumed.data.run.firstTaskMode, 'followup');
  assert.equal((await ownerPost('hub', input)).data.run.id, resumed.data.run.id);
  assert.equal((await ownerPost('hub', { ...input, content: 'different' })).status, 409);
  assert.equal((await ownerPost('hub', { ...input, requestId: 'concurrent' })).error, 'FIRST_TASK_BUSY');
  assert.equal(f.app.hub.all('run').length, 2);
  await finish('已重新核对，下一步测试禁用按钮的实际响应。');
  const current = await f.app.journal.snapshot(LOCAL, f.settings);
  assert.equal(current.guide.resultItemId, resultItemId);
  assert.equal(current.guide.report.run.id, resumed.data.run.id);
  assert.equal(current.guide.report.conversationId, oldRun.conversationId);
  assert.equal(current.guide.report.answer, '已重新核对，下一步测试禁用按钮的实际响应。');
  assert.deepEqual(current.items.find(item => item.id === resultItemId).followupReport, current.guide.report);
  assert.deepEqual(store.snapshot(LOCAL), before);
  assert.deepEqual(f.app.hub.get('run', oldRunId), oldRun);
  assert.equal(f.app.hub.all('message').filter(message => message.conversationId === oldRun.conversationId).length, 4);
  assert.equal((await f.get()).data.flow.id, draft.data.flowId);
  assert.equal((await f.get()).data.flow.draft, '另一个尚未发送的草稿');
  const ordinary = f.app.hub.newConversation({ endpointId: f.endpoint.endpointId });
  const unrelated = await ownerPost('hub', { ...input, attachmentId: undefined, conversationId: ordinary.id, requestId: 'ordinary-send' });
  assert.equal(unrelated.status, 200); assert.equal(unrelated.data.run.firstTaskId, undefined);
  assert.equal(f.app.firstTasks.guideSnapshot(store.snapshot(LOCAL)).run.id, resumed.data.run.id);
  assert.equal(f.app.hub.all('delivery').length, 0);
});

test('source inventory routes through the authenticated agent bridge without exposing a default account', async t => {
  const f = await fixture(t);
  const conversation = f.app.hub.newConversation({ endpointId: f.endpoint.endpointId });
  f.app.hub.submit({ conversationId: conversation.id, content: 'Read the available local sources', source: { channel: 'web' }, requestId: 'source-inventory' });
  const { job } = f.app.hub.poll(f.endpoint.token, { runnerId: 'first-http-runner' });
  const input = { runId: job.id, lease: job.lease, callId: 'inventory', tool: 'xiaoman_sources', arguments: { operation: 'list' } };
  const result = await f.bridge('tool', f.endpoint.token, input);
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.actions, ['list']);
  assert.deepEqual(result.data.roots, []);
  assert.equal((await f.bridge('tool', f.endpoint.token, { ...input, lease: 'stale' })).status, 403);
  assert.equal((await f.bridge('tool', 'unpaired-token', input)).status, 403);
});

test('first-task owner APIs retain page-session, same-origin and CSRF boundaries with zero writes on rejection', async t => {
  const f = await fixture(t);
  const initial = await f.get();
  assert.equal(initial.status, 200);
  assert.equal(initial.ok, true);
  const before = f.durableState();
  const input = { operation: 'draft', requestId: 'first-http-rejected', text: '帮我准备周日的生日' };
  assert.equal((await f.boundedFetch('/api/first-task')).status, 403);
  assert.equal((await f.boundedFetch('/api/first-task', { headers: { 'X-PA-Agent-Token': f.endpoint.token } })).status, 403);
  assert.equal((await f.post(input, { Cookie: '' })).status, 403);
  assert.equal((await f.post(input, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.post(input, { 'X-PA-CSRF': 'not-the-page-csrf' })).status, 403);
  assert.equal((await f.post(input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(f.durableState(), before);
  assert.equal((await f.app.journal.snapshot(LOCAL, f.settings)).items.length, 0);
});

test('public first-task resources expose presentation only and enforce host and CSP', async t => {
  const f = await fixture(t);
  for (const path of ['/first-task.js', '/first-task.css']) {
    const response = await f.boundedFetch(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(response.headers.get('content-type'), path.endsWith('.js') ? /text\/javascript/ : /text\/css/);
    assert.ok((await response.text()).length > 100);
  }
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(f.origin + '/first-task.js', { headers: { Host: 'untrusted.invalid' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.boundedFetch('/api/first-task', { headers: { Cookie: f.cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('a natural birthday follows the dedicated Web flow through questions and explicit confirmation before one trusted journal save', async t => {
  const f = await fixture(t);
  const draftInput = { operation: 'draft', requestId: 'birthday-draft', text: '帮我准备周日的生日', endpointId: f.endpoint.endpointId };
  const drafted = await f.post(draftInput);
  assert.equal(drafted.ok, true, drafted.error);
  const flowId = drafted.data.flow.id;
  assert.equal(drafted.data.flow.draft, '帮我准备周日的生日');
  assert.equal(f.app.hub.all('run').length, 0);
  const repeatDraft = await f.post(draftInput);
  assert.equal(repeatDraft.data.flow.id, flowId);
  assert.equal((await f.post({ ...draftInput, text: '修改相同请求编号的正文' })).error, 'CONFLICT');

  const started = await f.post({ operation: 'start', requestId: 'birthday-start', flowId, version: drafted.data.flow.version });
  assert.equal(started.ok, true);
  const conversationId = started.data.flow.conversationId;
  assert.equal(f.app.hub.all('binding').length, 0);
  assert.equal(f.app.hub.all('delivery').length, 0);
  const firstPoll = await f.bridge('poll', f.endpoint.token, { runnerId: 'first-http-runner' });
  assert.equal(firstPoll.ok, true);
  const firstJob = firstPoll.data.job;
  assert.equal(firstJob.firstTaskId, flowId);
  assert.equal(firstJob.firstTask.flowId, flowId);
  assert.equal(firstJob.firstTask.phase, 'clarify');
  assert.equal(firstJob.prompt, '帮我准备周日的生日');
  assert.equal(firstJob.source.channel, 'web');
  const tool = (job, name, callId, args) => f.bridge('tool', f.endpoint.token, { runId: job.id, lease: job.lease, callId, tool: name, arguments: args });
  const completed = (job, text) => f.bridge('event', f.endpoint.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: text });
  const initialJournal = await tool(firstJob, 'xiaoman_journal', 'read-initial-flow', { operation: 'list' });
  assert.equal(initialJournal.ok, true); assert.equal(initialJournal.data.firstTask.phase, 'clarify');
  assert.equal(initialJournal.data.firstTask.confirmedProposal, null);

  const premature = await tool(firstJob, 'xiaoman_journal', 'save-too-soon', { operation: 'add', revision: 0, values: { title: '未经确认的生日', note: '不能保存' } });
  assert.equal(premature.ok, false);
  assert.equal(premature.error, 'FIRST_TASK_CONFIRM_REQUIRED');
  assert.equal((await f.app.journal.snapshot(LOCAL, f.settings)).items.length, 0);
  const unrelated = await tool(firstJob, 'xiaoman_tasks', 'unrelated-todo', { operation: 'add', title: '误存为共同待办' });
  assert.equal(unrelated.ok, false);
  assert.equal(f.app.hub.all('task').length, 0);
  const asked = await tool(firstJob, 'xiaoman_first_task', 'ask-birthday', {
    operation: 'ask', questions: [
      { id: 'person', label: '给谁过生日？' },
      { id: 'arrangement', label: '几位参加，几点开始，预算多少？', hint: '用一句话说就好。' },
    ], message: '先确认两个关键点，再给你准备计划。',
  });
  assert.equal(asked.ok, true);
  assert.equal(asked.data.saved, false);
  assert.equal((await completed(firstJob, '给谁过生日？几位参加，几点开始，预算多少？')).ok, true);
  const awaiting = (await f.get()).data.flow;
  assert.equal(awaiting.id, flowId);
  assert.equal(awaiting.stage, 'awaiting_answer');
  assert.equal(awaiting.nextAction.kind, 'answer');
  assert.equal(awaiting.questions.length, 2);
  const beforeRead = f.durableState();
  for (let i = 0; i < 3; i++) assert.equal((await f.get()).data.flow.id, flowId);
  assert.equal(f.durableState(), beforeRead, 'returning to the flow only reads; it must not restart the model');

  const answered = await f.post({ operation: 'send', requestId: 'birthday-answer', flowId, version: awaiting.version, text: '给妈妈，周日18点，4个人，预算800元，在家里吃饭。' });
  assert.equal(answered.ok, true);
  assert.equal(answered.data.flow.conversationId, conversationId);
  const secondJob = (await f.bridge('poll', f.endpoint.token, { runnerId: 'first-http-runner' })).data.job;
  const proposal = {
    title: '给妈妈准备周日生日', kind: 'arrangement', date: '2026-10-18T18:00:00+08:00',
    note: '4人，家里吃饭，计划预算800元。建议准备蛋糕并核对菜单；尚未购买、邀请或安排通知。',
    steps: [{ id: 'cake', label: '选一款适合妈妈的蛋糕', done: false }, { id: 'menu', label: '确认四人的菜单与食材', done: false }],
    taskType: 'prep', taskData: { budget: { total: 800, lines: [] }, agenda: { place: '家里' } },
  };
  const proposed = await tool(secondJob, 'xiaoman_first_task', 'propose-birthday', { operation: 'propose', proposal, summary: '周日18点在家给妈妈过生日，4人，预算800元。' });
  assert.equal(proposed.ok, true);
  assert.equal((await completed(secondJob, '准备计划已整理，请在页面确认后再记入手账。')).ok, true);
  const pending = (await f.get()).data.flow;
  assert.equal(pending.stage, 'awaiting_confirmation');
  assert.equal(pending.nextAction.kind, 'confirm');
  assert.equal(pending.itemIds.length, 0);
  assert.equal((await f.app.journal.snapshot(LOCAL, f.settings)).items.length, 0);
  const stale = await f.post({ operation: 'confirm', requestId: 'birthday-old-proposal', flowId, version: pending.version, proposalVersion: pending.proposal.version + 1 });
  assert.equal(stale.ok, false);
  assert.equal(f.app.hub.all('run').length, 2);

  const confirmInput = { operation: 'confirm', requestId: 'birthday-confirm', flowId, version: pending.version, proposalVersion: pending.proposal.version };
  const confirmed = await f.post(confirmInput);
  assert.equal(confirmed.ok, true);
  const saveJob = (await f.bridge('poll', f.endpoint.token, { runnerId: 'first-http-runner' })).data.job;
  assert.equal(saveJob.firstTask.phase, 'saving');
  assert.equal(saveJob.firstTask.savedItemId, null);
  const currentJournal = await tool(saveJob, 'xiaoman_journal', 'read-current-confirmation', { operation: 'list' });
  assert.equal(currentJournal.ok, true); assert.equal(currentJournal.data.firstTask.phase, 'saving');
  assert.equal(currentJournal.data.firstTask.confirmed, true); assert.equal(currentJournal.data.firstTask.timezone, 'Asia/Shanghai');
  const confirmedValues = currentJournal.data.firstTask.confirmedProposal.values;
  assert.deepEqual(confirmedValues, pending.proposal.values);
  const mismatched = await tool(saveJob, 'xiaoman_journal', 'mismatch-birthday', { operation: 'add', revision: 0, values: { ...confirmedValues, title: '擅自更改的计划' } });
  assert.equal(mismatched.ok, false);
  assert.equal((await f.app.journal.snapshot(LOCAL, f.settings)).items.length, 0);
  const saveArgs = { operation: 'add', revision: 0, values: confirmedValues };
  const saved = await tool(saveJob, 'xiaoman_journal', 'save-birthday', saveArgs);
  assert.equal(saved.ok, true);
  assert.equal(saved.data.saved, true);
  const itemId = saved.data.item.id;
  const readSaved = await tool(saveJob, 'xiaoman_journal', 'read-saved-confirmation', { operation: 'get', itemId });
  assert.equal(readSaved.ok, true); assert.equal(readSaved.data.firstTask.stage, 'recorded');
  assert.equal(readSaved.data.firstTask.savedItemId, itemId);
  assert.equal(saved.data.item.source.channel, 'web');
  assert.equal(saved.data.item.status, 'planned');
  assert.ok(saved.data.item.source.text.includes('帮我准备周日的生日'));
  assert.ok(saved.data.item.source.text.includes('给妈妈'));
  assert.ok(saved.data.item.steps.every(step => step.done === false));
  const repeated = await tool(saveJob, 'xiaoman_journal', 'save-birthday', saveArgs);
  assert.equal(repeated.ok, true, 'the same saved tool receipt must be replayable after a response loss');
  assert.equal(repeated.data.item.id, itemId);
  const duplicate = await tool(saveJob, 'xiaoman_journal', 'second-save-birthday', saveArgs);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'FIRST_TASK_ALREADY_SAVED');
  assert.equal((await completed(saveJob, '已记录计划，可以查看这件事；生日尚未实际举办。')).ok, true);
  const final = (await f.get()).data.flow;
  assert.equal(final.stage, 'recorded');
  assert.deepEqual(final.itemIds, [itemId]);
  assert.equal(final.itemRecords[0].id, itemId);
  assert.equal(final.currentRunId, saveJob.id);
  assert.equal(final.runIds.length, 3);
  assert.equal(final.design.state, 'idle', 'basic projection cannot pretend to be design Agent success');
  assert.equal((await f.app.journal.snapshot(LOCAL, f.settings)).items.length, 1);
  assert.equal(f.app.hub.all('delivery').length, 0);
  assert.equal((await f.post(confirmInput)).data.flow.id, flowId);
  assert.equal(f.app.hub.all('run').length, 3, 'replaying a lost confirmation response does not create another run');
  const serialized = JSON.stringify(final);
  assert.equal(serialized.includes(saveJob.lease), false);
  assert.equal(serialized.includes(f.endpoint.token), false);
});

test('server restart resumes the persisted unsent birthday draft and the same queued run without implicit execution', async t => {
  const f = await fixture(t);
  const draftText = '帮我准备周日的生日  \n';
  const drafted = await f.post({ operation: 'draft', requestId: 'restart-draft', text: draftText, endpointId: f.endpoint.endpointId });
  assert.equal(drafted.ok, true, drafted.error);
  const flowId = drafted.data.flow.id;
  const resumed = await f.reopen();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.flow.id, flowId);
  assert.equal(resumed.data.flow.draft, draftText, 'draft whitespace remains exact so autosave can acknowledge the same input');
  assert.equal(resumed.data.flow.stage, 'draft');
  assert.equal(f.app.hub.all('run').length, 0);
  const started = await f.post({ operation: 'start', requestId: 'restart-start', flowId, version: resumed.data.flow.version });
  assert.equal(started.ok, true);
  const runId = started.data.flow.currentRunId;
  const queued = await f.reopen();
  assert.equal(queued.data.flow.id, flowId);
  assert.equal(queued.data.flow.currentRunId, runId);
  assert.equal(queued.data.flow.stage, 'queued');
  assert.equal(queued.data.flow.runIds.length, 1);
  assert.equal(f.app.hub.get('run', runId).status, 'queued');
  assert.equal(f.app.hub.all('run').length, 1);
  assert.equal(f.app.hub.all('delivery').length, 0);
});

test('uncertain execution requires explicit recovery, keeps supplements and rejects late tool writes after cancellation', async t => {
  const f = await fixture(t);
  const started = await f.post({ operation: 'start', requestId: 'uncertain-start', text: '帮我准备周日的生日', endpointId: f.endpoint.endpointId });
  assert.equal(started.ok, true, started.error);
  const flowId = started.data.flow.id;
  const job = (await f.bridge('poll', f.endpoint.token, { runnerId: 'first-http-runner' })).data.job;
  const event = await f.bridge('event', f.endpoint.token, { runId: job.id, lease: job.lease, seq: 1, type: 'uncertain', value: 'COMPANION_STOPPED' });
  assert.equal(event.ok, true);
  const uncertain = (await f.get()).data.flow;
  assert.equal(uncertain.stage, 'uncertain');
  assert.equal(uncertain.nextAction.kind, 'check');
  const supplemented = await f.post({ operation: 'draft', requestId: 'uncertain-supplement', flowId, version: uncertain.version, text: '给妈妈，周日18点在家里' });
  assert.equal(supplemented.ok, true);
  const attempt = await f.post({ operation: 'send', requestId: 'uncertain-restart', flowId, version: supplemented.data.flow.version });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error, 'FIRST_TASK_RECOVERY_REQUIRED');
  const bypass = await f.post({ operation: 'new', requestId: 'uncertain-new-without-id' });
  assert.equal(bypass.ok, false);
  assert.equal(f.app.hub.all('run').length, 1);
  assert.equal((await f.get()).data.flow.id, flowId);
  const recovered = await f.reopen();
  assert.equal(recovered.data.flow.draft, '给妈妈，周日18点在家里');
  assert.equal(recovered.data.flow.currentRunId, job.id);
  assert.equal(recovered.data.flow.nextAction.kind, 'check');
  const stopped = await f.post({ operation: 'cancel-run', requestId: 'uncertain-stop-confirmed', flowId, version: recovered.data.flow.version, confirmStopped: true });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.data.flow.stage, 'cancelled');
  const late = await f.bridge('tool', f.endpoint.token, { runId: job.id, lease: job.lease, callId: 'late-ask', tool: 'xiaoman_first_task', arguments: { operation: 'ask', questions: [{ id: 'late', label: '迟到的问题' }] } });
  assert.equal(late.status, 403);
  assert.equal(f.app.hub.all('run').length, 1);
  assert.equal((await f.app.journal.snapshot(LOCAL, f.settings)).items.length, 0);
});

test('a confirmed plan can recover from a proven zero-write journal version conflict without duplicating or changing another item', async t => {
  const f = await fixture(t);
  const started = await f.post({ operation: 'start', requestId: 'version-race-start', text: '周日18点在家给妈妈过生日，4人，预算800元。', endpointId: f.endpoint.endpointId });
  assert.equal(started.ok, true, started.error);
  const flowId = started.data.flow.id;
  const firstJob = (await f.bridge('poll', f.endpoint.token, { runnerId: 'first-http-runner' })).data.job;
  const proposal = { title: '妈妈的生日准备', note: '周日18点在家，4人，预算800元，尚未实际举办。', steps: [{ id: 'cake', label: '准备蛋糕', done: false }] };
  const proposed = await f.bridge('tool', f.endpoint.token, { runId: firstJob.id, lease: firstJob.lease, callId: 'version-race-plan', tool: 'xiaoman_first_task', arguments: { operation: 'propose', proposal } });
  assert.equal(proposed.ok, true);
  assert.equal((await f.bridge('event', f.endpoint.token, { runId: firstJob.id, lease: firstJob.lease, seq: 1, type: 'completed', value: '请确认这份计划。' })).ok, true);
  const pending = (await f.get()).data.flow;
  assert.equal((await f.post({ operation: 'confirm', requestId: 'version-race-confirm', flowId, version: pending.version, proposalVersion: pending.proposal.version })).ok, true);
  const saveJob = (await f.bridge('poll', f.endpoint.token, { runnerId: 'first-http-runner' })).data.job;
  const otherResponse = await f.boundedFetch('/api/journal', { method: 'POST', headers: f.headers, body: JSON.stringify({ operation: 'add', revision: 0, values: { title: '另一页刚保存的阅读计划', note: '不得被生日恢复覆盖。' } }) });
  const otherSaved = await otherResponse.json();
  assert.equal(otherSaved.ok, true);
  const otherItem = structuredClone(otherSaved.data.items[0]);
  const write = (revision, callId) => f.bridge('tool', f.endpoint.token, { runId: saveJob.id, lease: saveJob.lease, callId, tool: 'xiaoman_journal', arguments: { operation: 'add', revision, values: saveJob.firstTask.confirmedProposal.values } });
  const stale = await write(0, 'version-race-stale');
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'VERSION_CONFLICT');
  assert.equal((await f.app.journal.snapshot(LOCAL, f.settings)).items.length, 1, 'a version conflict did not save the first-task plan');
  const saved = await write(otherSaved.data.revision, 'version-race-fresh');
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.data.saved, true);
  const final = await f.app.journal.snapshot(LOCAL, f.settings);
  assert.equal(final.items.length, 2);
  assert.deepEqual(final.items.find(item => item.id === otherItem.id), otherItem);
  assert.deepEqual((await f.get()).data.flow.itemIds, [saved.data.item.id]);
});

test('replaying an old flow request returns that exact flow even when another tab made a different flow current', async t => {
  const f = await fixture(t);
  const input = { operation: 'draft', requestId: 'parallel-birthday-draft', text: '帮我准备周日的生日', endpointId: f.endpoint.endpointId };
  const first = await f.post(input);
  assert.equal(first.ok, true, first.error);
  const firstId = first.data.flow.id;
  const second = await f.post({ operation: 'new', flowId: firstId, version: first.data.flow.version, requestId: 'parallel-reading-new' });
  assert.equal(second.ok, true);
  const secondId = second.data.flow.id;
  assert.notEqual(secondId, firstId);
  const selected = await f.boundedFetch('/api/first-task?flowId=' + encodeURIComponent(firstId), { headers: { Cookie: f.cookie } }).then(r => r.json());
  assert.equal(selected.ok, true);
  assert.equal(selected.data.flow.id, firstId);
  assert.equal(selected.data.currentFlowId, secondId);
  const replayed = await f.post(input);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.data.flow.id, firstId, 'a receipt replay must not display another flow as this request result');
  assert.equal(replayed.data.flow.draft, '帮我准备周日的生日');
  assert.equal((await f.get()).data.flow.id, secondId, 'read-only receipt replay does not silently change the other tab’s pointer');
  assert.equal(f.app.hub.all('run').length, 0);
});
