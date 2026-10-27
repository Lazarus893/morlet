import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { projectWorkpages, workpageStage } from '../plugins/life-journal/workpages.mjs';
import { parseDesign } from '../plugins/life-journal/designer.mjs';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { createJournalControl } from '../plugins/webui/journal-control.mjs';
import { journalTool } from '../plugins/agent-hub/journal.mjs';
import { journalEvidence } from '../plugins/agent-hub/reports.mjs';

const scope = { account: 'local', userId: 'owner' };
const rejects = code => error => error.code === code;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'journal-plan-'));
  let store = new JournalStore(root);
  t.after(() => { store.close(); rmSync(root, { force: true, recursive: true }); });
  const saved = store.mutate(scope, { operation: 'add', revision: 0, values: {
    title: '两个人的番茄鸡蛋面', steps: [{ id: 'washed', label: '洗好番茄', done: true }],
    taskData: {
      meal: { baseServings: 2, servings: 2, ingredients: [{ id: 'noodle', name: '面条', quantity: 200, unit: 'g' }, { id: 'egg', name: '鸡蛋', quantity: 2, unit: '个' }, { id: 'tomato', name: '番茄', quantity: 2, unit: '个' }], instructions: [{ id: 'cook', label: '煮面', done: false }] },
      shopping: { entries: [{ id: 'buy-noodle', name: '面条', quantity: 200, unit: 'g' }, { id: 'buy-egg', name: '鸡蛋', quantity: 2, unit: '个', bought: true }, { id: 'buy-tomato', name: '番茄', quantity: 2, unit: '个', atHome: true }, { id: 'onion', name: '小葱', quantity: 1, unit: '把' }] },
      budget: { total: 100, lines: [{ id: 'food', label: '食材', amount: 40 }, { id: 'unknown', label: '另选小菜', amount: null }], reserve: 10 },
    },
  } });
  const input = parameters => ({ revision: store.snapshot(scope).revision, itemId: saved.items[0].id, itemVersion: store.snapshot(scope).items[0].version, parameters });
  const apply = request => store.applyPreview(scope, { ...request, previewHash: store.preview(scope, request).previewHash, requestId: 'test-request-001' });
  return { get store() { return store; }, input, apply, saved, restart() { store.close(); store = new JournalStore(root); } };
}

test('preview is read-only; adoption links unique recipe quantities and preserves facts in one revision', t => {
  const f = fixture(t), request = f.input({ servings: 4, budgetTotal: 120 });
  const before = f.store.snapshot(scope), preview = f.store.preview(scope, request);
  assert.deepEqual(f.store.snapshot(scope), before);
  assert.equal(preview.canApply, true);
  assert.ok(preview.warnings.some(warning => warning.code === 'SHOPPING_REVIEW'));
  assert.ok(preview.warnings.some(warning => warning.code === 'UNKNOWN_PRICE'));
  const saved = f.apply(request), item = saved.items[0];
  assert.equal(saved.revision, before.revision + 1);
  assert.equal(item.version, before.items[0].version + 1);
  assert.equal(item.taskData.meal.servings, 4);
  assert.deepEqual(item.taskData.shopping.entries.map(entry => entry.quantity), [400, 2, 2, 1]);
  assert.equal(item.steps[0].done, true);
  assert.deepEqual(item.taskData.budget.lines, before.items[0].taskData.budget.lines);
  assert.equal(item.taskData.budget.total, 120);
});

test('receipt survives restart; retry after lost response cannot apply twice or repurpose an idempotency key', t => {
  const f = fixture(t), request = f.input({ servings: 3 });
  const command = { ...request, previewHash: f.store.preview(scope, request).previewHash, requestId: 'persistent-request' };
  const saved = f.store.applyPreview(scope, command);
  f.restart();
  const replay = f.store.applyPreview(scope, command);
  assert.equal(replay.applyReceipt.replayed, true);
  assert.equal(replay.revision, saved.revision);
  assert.throws(() => f.store.applyPreview(scope, { ...command, parameters: { servings: 4 } }), rejects('IDEMPOTENCY_CONFLICT'));
});

const criticalSettings = { revision: 'journal-critical-test', installed: false, socket: '/no-real-runtime', config: { agent: { provider: 'codex' }, im: { provider: 'disabled', allow_from: [] }, proactive: { enabled: false, timezone: 'Asia/Shanghai' } } };
function criticalFixture(t, { mode, operation = 'apply-preview' }) {
  const root = mkdtempSync(join(tmpdir(), 'journal-dual-db-'));
  let hub, journal;
  t.after(async () => { await journal?.close(); hub?.close(); rmSync(root, { recursive: true, force: true }); });
  const child = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { AgentHub } from ${JSON.stringify(new URL('../plugins/agent-hub/store.mjs', import.meta.url).href)};
    import { createJournalControl } from ${JSON.stringify(new URL('../plugins/webui/journal-control.mjs', import.meta.url).href)};
    import { journalTool } from ${JSON.stringify(new URL('../plugins/agent-hub/journal.mjs', import.meta.url).href)};
    const root = process.argv[1], mode = process.argv[2], operation = process.argv[3];
    const scope = { account: 'local', userId: 'owner' }, settings = ${JSON.stringify(criticalSettings)};
    const hub = new AgentHub(root), journal = createJournalControl({ root });
    journal.store.mutate(scope, { operation: 'add', revision: 0, values: { title: '隔离晚餐', steps: [{ id: 'washed', label: '洗菜', done: true }], taskData: { meal: { baseServings: 2, servings: 2, ingredients: [{ id: 'noodle', name: '面条', quantity: 200, unit: '克' }], instructions: [] }, shopping: { entries: [{ id: 'buy-noodle', name: '面条', quantity: 200, unit: '克' }] } } } });
    journal.store.mutate(scope, { operation: 'preferences', revision: 1, values: { autoLayout: false } });
    const state = journal.store.snapshot(scope), item = state.items[0];
    const pairing = hub.pair({ label: 'Isolated reviewer' }), conversation = hub.newConversation({ endpointId: pairing.endpointId });
    hub.submit({ conversationId: conversation.id, content: '调整同一份晚餐为4人', requestId: 'critical-dinner', source: { channel: 'web' } });
    const job = hub.poll(pairing.token, { runnerId: 'critical-review' }).job;
    const request = { revision: state.revision, itemId: item.id, itemVersion: item.version, parameters: { servings: 4 } };
    const preview = await journal.preview(request, settings);
    const input = { runId: job.id, lease: job.lease, callId: 'critical-adjustment', arguments: { operation, revision: state.revision, itemId: item.id, itemVersion: item.version, values: operation === 'apply-preview' ? { parameters: request.parameters, previewHash: preview.previewHash } : { note: '只更新一次的记录' } } };
    writeFileSync(join(root, 'resume.json'), JSON.stringify({ token: pairing.token, input }), { mode: 0o600 });
    const method = operation === 'apply-preview' ? 'applyPreview' : 'mutate', actual = journal[method];
    journal[method] = async (...args) => { await actual(...args); if (mode === 'pending') process.exit(86); throw Object.assign(new Error('POST_COMMIT_INTERRUPTION'), { code: 'POST_COMMIT_INTERRUPTION' }); };
    try { await journalTool({ hub, journal, read: async () => settings, token: pairing.token, input }); }
    catch (error) { if (error.code === 'POST_COMMIT_INTERRUPTION') process.exit(86); throw error; }
    process.exit(87);
  `;
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', child, root, mode, operation], { encoding: 'utf8' });
  assert.equal(interrupted.status, 86, interrupted.stderr);
  hub = new AgentHub(root); journal = createJournalControl({ root });
  const resume = JSON.parse(readFileSync(join(root, 'resume.json'), 'utf8'));
  const key = `journal:${resume.input.runId}:${resume.input.callId}`;
  assert.equal(hub.get('effect', key).state, mode);
  return { hub, journal, key, resume, call: input => journalTool({ hub, journal, read: async () => criticalSettings, token: resume.token, input: input || resume.input }) };
}

for (const mode of ['pending', 'uncertain']) test(`Agent apply-preview reconciles ${mode} Hub effect after a real process interruption, preserving the original receipt despite later edits`, async t => {
  const f = criticalFixture(t, { mode });
  const committed = f.journal.store.snapshot(scope), item = committed.items[0];
  assert.equal(committed.items.length, 1);
  assert.equal(item.taskData.meal.servings, 4);
  assert.equal(item.taskData.shopping.entries[0].quantity, 400);
  assert.equal(item.steps[0].done, true);
  const changedInput = structuredClone(f.resume.input);
  changedInput.arguments.values.parameters.servings = 5;
  await assert.rejects(f.call(changedInput), rejects('CONFLICT'));
  assert.deepEqual(f.journal.store.snapshot(scope), committed);
  f.journal.store.mutate(scope, { operation: 'update', revision: committed.revision, itemId: item.id, itemVersion: item.version, values: { note: '另一个入口的后续记录' } });
  const concurrent = f.journal.store.snapshot(scope);
  const resumed = await f.call();
  assert.equal(resumed.saved, true);
  assert.equal(resumed.applyReceipt.itemId, item.id);
  assert.equal(resumed.applyReceipt.itemVersion, item.version, 'Receipt identifies the original commit, not a later edit');
  assert.equal(resumed.applyReceipt.revision, committed.revision);
  assert.equal(resumed.applyReceipt.replayed, true);
  assert.equal(resumed.item.version, concurrent.items[0].version, 'Current item snapshot may have a later version');
  assert.equal(resumed.item.note, '另一个入口的后续记录');
  assert.equal(f.hub.get('effect', f.key).state, 'done');
  assert.equal(journalEvidence(f.hub.all('effect')).get(f.resume.input.runId).get(item.id).version, item.version, 'Recovery evidence must not claim a later concurrent edit');
  assert.deepEqual(f.journal.store.snapshot(scope), concurrent, 'Reconciliation does not create another revision or item');
  assert.deepEqual(await f.call(), resumed);
});

for (const mode of ['pending', 'uncertain']) test(`ordinary update with ${mode} Hub effect is not automatically replayed`, async t => {
  const f = criticalFixture(t, { mode, operation: 'update' });
  const before = f.journal.store.snapshot(scope);
  assert.equal(before.items[0].note, '只更新一次的记录');
  await assert.rejects(f.call(), rejects(mode === 'pending' ? 'EXECUTION_UNCERTAIN' : 'POST_COMMIT_INTERRUPTION'));
  assert.deepEqual(f.journal.store.snapshot(scope), before);
  assert.equal(f.hub.get('effect', f.key).state, mode);
});

test('stale revision, changed item version and forged preview hash cannot commit', t => {
  const f = fixture(t), request = f.input({ servings: 4 });
  assert.throws(() => f.store.preview(scope, { ...request, itemVersion: 900 }), rejects('VERSION_CONFLICT'));
  assert.throws(() => f.store.applyPreview(scope, { ...request, previewHash: '0'.repeat(64), requestId: 'forged-request' }), rejects('STALE_PREVIEW'));
  f.store.mutate(scope, { operation: 'step', ...request, values: { stepId: 'washed', done: false } });
  assert.throws(() => f.store.preview(scope, request), rejects('VERSION_CONFLICT'));
  assert.equal(f.store.snapshot(scope).items[0].taskData.meal.servings, 2);
});

test('budget lower than known expenses and reserve remains preview-only', t => {
  const f = fixture(t), request = f.input({ budgetTotal: 49 });
  assert.equal(f.store.preview(scope, request).canApply, false);
  assert.throws(() => f.apply(request), rejects('BUDGET_EXCEEDED'));
  assert.equal(f.store.snapshot(scope).items[0].taskData.budget.total, 100);
});

test('unknown, mismatched units, partial inventory and ambiguous names never silently scale shopping', t => {
  const f = fixture(t), state = f.store.snapshot(scope), item = state.items[0];
  item.taskData.meal.ingredients.push({ id: 'extra-noodle', name: '面条', quantity: 100, unit: 'g' });
  item.taskData.shopping.entries[1].bought = false;
  item.taskData.shopping.entries[1].quantity = 1;
  item.taskData.shopping.entries[2].atHome = false;
  item.taskData.shopping.entries[2].unit = '袋';
  f.store.mutate(scope, { operation: 'update', ...f.input({ servings: 4 }), values: { taskData: item.taskData } });
  const result = f.apply(f.input({ servings: 4 }));
  assert.deepEqual(result.items[0].taskData.shopping.entries.map(entry => entry.quantity), [200, 1, 2, 1]);
});

test('invalid parameters and closed items cannot be adjusted', t => {
  const f = fixture(t);
  for (const parameters of [{}, { servings: 0 }, { servings: 2.5 }, { budgetTotal: 12.345 }, { code: 'alert(1)' }]) assert.throws(() => f.store.preview(scope, f.input(parameters)), rejects('INVALID_REQUEST'));
  f.store.mutate(scope, { operation: 'done', ...f.input({ servings: 3 }), values: {} });
  assert.throws(() => f.store.preview(scope, f.input({ servings: 3 })), rejects('INVALID_STATE'));
});

test('rounding to zero or overflowing a quantity is a blocked preview, never a false adoption affordance', t => {
  const f = fixture(t);
  for (const [amount, base, next] of [[0.001, 3, 1], [1e9, 1, 100]]) {
    const item = f.store.snapshot(scope).items[0];
    item.taskData.meal = { baseServings: base, servings: base, ingredients: [{ id: 'salt', name: '盐', quantity: amount, unit: 'kg' }], instructions: [] };
    item.taskData.shopping.entries = [{ id: 'salt-buy', name: '盐', quantity: amount, unit: 'kg', bought: false, atHome: false, category: '' }];
    f.store.mutate(scope, { operation: 'update', ...f.input({ servings: next }), values: { taskData: item.taskData } });
    const request = f.input({ servings: next });
    assert.equal(f.store.preview(scope, request).canApply, false);
    assert.throws(() => f.apply(request), rejects('PLAN_REVIEW_REQUIRED'));
    assert.equal(f.store.snapshot(scope).items[0].taskData.shopping.entries[0].quantity, amount);
  }
});

test('workpages preserve global order and keep past-dated history without recommending or completing it', t => {
  const f = fixture(t), state = f.store.snapshot(scope), item = state.items[0];
  const other = { ...item, id: 'other', steps: [], taskData: {}, date: '2000-01-01T00:00:00Z' };
  state.items.push(other);
  state.layout.widgets = [{ id: 'one', itemId: item.id, kind: 'meal', section: 'next' }, { id: 'two', itemId: other.id, kind: 'documents', presentation: 'compact' }, { id: 'three', itemId: item.id, kind: 'budget' }];
  const pages = projectWorkpages(state);
  assert.deepEqual(pages.map(page => page.itemId), [item.id, 'other', item.id]);
  assert.equal(pages[2].sections[0].density, 'compact');
  assert.equal(pages.filter(page => page.itemId === item.id).flatMap(page => page.sections).filter(section => section.role === 'primary').length, 1);
  assert.equal(workpageStage(other).stage, 'past_date');
  assert.match(workpageStage(other).nextStep, /原定日期已过/);
  assert.equal(other.status, 'planned');
  assert.equal(workpageStage({ ...other, date: null }).stage, 'planned');
  assert.equal(workpageStage({ ...other, date: '2030-01-01T00:00:00Z' }, { now: Date.parse('2026-10-18T00:00:00Z') }).stage, 'planned');
  assert.equal(workpageStage({ ...other, status: 'done' }).stage, 'done');
});

test('design permits bounded composition fields and rejects executable or unsupported layout values', t => {
  const f = fixture(t), state = f.store.snapshot(scope), itemId = state.items[0].id;
  const value = { widgets: [{ id: `${itemId}:meal`, itemId, kind: 'meal', section: 'next', presentation: 'compact' }], reason: '先备食材，再照着做' };
  assert.deepEqual(parseDesign(JSON.stringify(value), state), value);
  for (const change of [{ section: 'custom' }, { presentation: 'html' }, { style: 'position:fixed' }]) assert.throws(() => parseDesign(JSON.stringify({ ...value, widgets: [{ ...value.widgets[0], ...change }] }), state), rejects('INVALID_DESIGN'));
});
