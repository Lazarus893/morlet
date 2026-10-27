import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { availableWidgetKinds, materialWidgetKinds, canonicalWidgetKind, projectWidget, validateTaskData, widgetCapabilities } from '../plugins/life-journal/widgets.mjs';
import { parseDesign } from '../plugins/life-journal/designer.mjs';

const scope = { account: 'local', userId: 'owner' };
const now = Date.parse('2026-10-22T09:00:00+08:00');
const code = expected => error => error.code === expected;
function fixture(t, time = now) {
  const root = mkdtempSync(join(tmpdir(), 'pa-widget-domain-'));
  const store = new JournalStore(root, { now: () => time });
  t.after(() => { store.close(); rmSync(root, { force: true, recursive: true }); });
  const mutate = (operation, values, extra = {}) => {
    const state = store.snapshot(scope), item = state.items[0];
    return store.mutate(scope, { operation, revision: state.revision, ...(item ? { itemId: item.id, itemVersion: item.version } : {}), values, ...extra });
  };
  const add = values => mutate('add', { title: '用户的一次生活交代', ...values }).items[0];
  const widget = (kind, action, values = {}) => mutate('widget', { kind, action, ...values }).items[0];
  return { root, store, mutate, add, widget };
}

test('empty task structures retain unknown values and capabilities contain all twenty real action contracts', () => {
  const data = validateTaskData({ budget: {}, meal: {}, habit: {}, approval: {}, delivery: {}, deadline: {} }, { now });
  assert.equal(data.budget.total, null);
  assert.equal(data.meal.baseServings, null);
  assert.equal(data.approval.amount, null);
  assert.equal(data.deadline.dueAt, null);
  assert.deepEqual(data.delivery.events, []);
  assert.equal(Object.keys(widgetCapabilities()).length, 20);
  assert.deepEqual(widgetCapabilities().waiting.actions['save-draft'], ['requestId', 'text']);
  const item = { id: 'empty', version: 1, title: '生日准备', status: 'planned', kind: 'arrangement', date: null, note: '', steps: [], candidates: [], taskType: 'budget', taskData: { budget: data.budget } };
  const projection = projectWidget(item, 'budget', { now });
  assert.equal(projection.data.remaining, null);
  assert.equal(projection.empty, true);
  assert.equal(projection.actions.find(action => action.action === 'reserve').enabled, false);
  assert.deepEqual(availableWidgetKinds(item), ['budget']);
});

test('strict task structures reject unknown keys, malformed days, fractional cents, duplicate rows and forged system confirmation', () => {
  assert.throws(() => validateTaskData({ script: {} }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ agenda: { html: '<script>' } }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ deadline: { dueAt: '2026-02-30T10:00:00+08:00' } }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ deadline: { dueAt: '2026-10-23T24:00:00+08:00' } }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ budget: { total: 12.001 } }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ collection: { entries: [{ id: 'same', title: '甲' }, { id: 'same', title: '乙' }] } }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ shopping: { entries: [{ id: 'missing-name' }] } }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ collection: { entries: [{ id: 'bad-link', title: '收藏', url: 'javascript:alert(1)' }] } }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ delivery: { stages: [{ id: 'out', label: '配送' }], events: [{ stageId: 'out', at: '2026-10-21T10:00:00+08:00', detail: '猜测已经配送' }] } }, { now }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ approval: { confirmation: { itemVersion: 1, at: '2026-10-22T01:00:00Z' } } }), code('INVALID_TASK_DATA'));
  assert.throws(() => validateTaskData({ reminder: { recordedAt: '2026-10-22T01:00:00Z' } }), code('INVALID_TASK_DATA'));
});

test('cross references and phased ownership are validated atomically against the shared steps and candidates', t => {
  const f = fixture(t);
  f.add({ steps: [{ id: 'cake', label: '核对蛋糕口味', done: false }], candidates: [{ id: 'a', name: '候选店', selected: false }] });
  const before = f.store.snapshot(scope);
  assert.throws(() => f.widget('prep', 'set-data', { data: { phases: [{ id: 'before', label: '之前', stepIds: ['missing'] }] } }), code('INVALID_TASK_DATA'));
  assert.throws(() => f.widget('prep', 'set-data', { data: { phases: [{ id: 'before', stepIds: ['cake'] }, { id: 'near', stepIds: ['cake'] }] } }), code('INVALID_TASK_DATA'));
  assert.throws(() => f.widget('decision', 'set-data', { data: { options: [{ candidateId: 'invented' }] } }), code('INVALID_TASK_DATA'));
  assert.deepEqual(f.store.snapshot(scope), before, 'invalid material leaves both revisions and facts unchanged');
  const item = f.widget('prep', 'set-data', { data: { phases: [{ id: 'before', label: '提前', stepIds: ['cake'] }] } });
  assert.deepEqual(projectWidget(item, 'prep', { now }).data.steps, item.steps);
});

test('all new widget writes require item CAS and survive a second SQLite instance without overwriting another namespace', t => {
  const f = fixture(t);
  f.add({ taskData: { budget: { total: 100 }, waiting: { requests: [{ id: 'friend', person: '朋友', request: '是否带伞' }] } } });
  const stale = f.store.snapshot(scope), item = stale.items[0];
  assert.throws(() => f.store.mutate(scope, { operation: 'widget', revision: stale.revision, itemId: item.id, values: { kind: 'budget', action: 'reserve', amount: 10 } }), code('INVALID_REQUEST'));
  f.widget('waiting', 'save-draft', { requestId: 'friend', text: '明天记得看一下是否方便带伞。' });
  const second = new JournalStore(f.root, { now: () => now });
  t.after(() => second.close());
  assert.throws(() => second.mutate(scope, { operation: 'widget', revision: stale.revision, itemId: item.id, itemVersion: item.version, values: { kind: 'budget', action: 'reserve', amount: 10 } }), code('VERSION_CONFLICT'));
  const state = f.store.snapshot(scope);
  assert.throws(() => second.mutate(scope, { operation: 'widget', revision: state.revision, itemId: item.id, itemVersion: item.version, values: { kind: 'budget', action: 'reserve', amount: 10 } }), code('VERSION_CONFLICT'));
  f.widget('budget', 'set-data', { data: { total: 120, reserve: 20 } });
  const saved = second.snapshot(scope).items[0];
  assert.equal(saved.taskData.budget.reserve, 20);
  assert.equal(saved.taskData.waiting.requests[0].draft, '明天记得看一下是否方便带伞。');
  assert.equal(saved.taskData.waiting.requests[0].status, 'unknown', 'saving text is not a sent message or reply');
});

test('legacy and new candidate actions enforce the same known constraints and changed facts invalidate prior choices', t => {
  const f = fixture(t);
  f.add({ candidates: [{ id: 'a', name: '窄饮水机', selected: false }, { id: 'b', name: '宽饮水机', selected: false }], taskData: { decision: { budget: 1500, widthLimitCm: 30, options: [{ candidateId: 'a', amount: 1200, widthCm: 27 }, { candidateId: 'b', amount: 1000, widthCm: 34 }] } } });
  assert.throws(() => f.mutate('choose', { candidateId: 'b' }), code('CANDIDATE_CONSTRAINT'));
  assert.throws(() => f.widget('decision', 'choose', { candidateId: 'b' }), code('CANDIDATE_CONSTRAINT'));
  let item = f.widget('decision', 'choose', { candidateId: 'a' });
  assert.equal(item.candidates[0].selected, true);
  item = f.widget('decision', 'set-data', { data: { budget: 1000, options: [{ candidateId: 'a', amount: null }, { candidateId: 'b', amount: 1000 }] } });
  assert.equal(item.candidates[0].selected, false);
  assert.equal(projectWidget(item, 'decision', { now }).data.candidates[0].selectable, false, 'unknown price cannot pass a known hard budget');
});

test('slot buffers, elapsed slots and changed availability cannot leave a valid-looking recorded preference', t => {
  const f = fixture(t);
  f.add({ taskType: 'time-grid', taskData: { 'time-grid': { durationMinutes: 60, bufferMinutes: 30, slots: [{ id: 'fit', start: '2026-10-23T15:30:00+08:00', status: 'available' }, { id: 'conflict', start: '2026-10-23T17:00:00+08:00', status: 'available' }, { id: 'past', start: '2026-10-21T10:00:00+08:00', status: 'available' }], constraints: [{ start: '2026-10-23T18:00:00+08:00', end: '2026-10-23T19:00:00+08:00', label: '晚饭准备' }] } } });
  assert.throws(() => f.widget('time-grid', 'choose-slot', { slotId: 'conflict' }), code('SLOT_UNAVAILABLE'));
  assert.throws(() => f.widget('time-grid', 'choose-slot', { slotId: 'past' }), code('SLOT_UNAVAILABLE'));
  let item = f.widget('time-grid', 'choose-slot', { slotId: 'fit' });
  assert.equal(item.taskData['time-grid'].selectedSlotId, 'fit');
  item = f.widget('time-grid', 'set-data', { data: { durationMinutes: 60, slots: [{ id: 'fit', start: '2026-10-23T15:30:00+08:00', status: 'unknown' }], selectedSlotId: 'fit' } });
  assert.equal(item.taskData['time-grid'].selectedSlotId, null);
});

test('real overspending stays visible while extra budget reservation is blocked and unknown quotes remain null', t => {
  const f = fixture(t);
  f.add({ taskType: 'budget', taskData: { budget: { total: 100, lines: [{ id: 'spent', label: '用户实际交通费', amount: 120 }, { id: 'ticket', label: '门票未报价', amount: null }] } } });
  const projection = projectWidget(f.store.snapshot(scope).items[0], 'budget', { now });
  assert.equal(projection.data.remaining, -20);
  assert.equal(projection.data.knownAmount, 120);
  assert.deepEqual(projection.data.unknownLineIds, ['ticket']);
  assert.throws(() => f.widget('budget', 'reserve', { amount: 1 }), code('BUDGET_EXCEEDED'));
  assert.equal(f.widget('budget', 'reserve', { amount: 0 }).taskData.budget.reserve, 0);
});

test('approval is bound to item version, repeated confirmation is idempotent and changed schedule invalidates it', t => {
  const f = fixture(t);
  f.add({ taskData: { approval: { summary: '周五在家做两人晚饭', amount: 0, conditions: ['20:00开始'] }, handoff: { people: [{ id: 'me', name: '我', role: '主菜' }] } } });
  let item = f.widget('approval', 'confirm');
  assert.equal(item.taskData.approval.confirmation.itemVersion, item.version);
  assert.equal(projectWidget(item, 'approval', { now }).data.confirmed, true);
  const revision = f.store.snapshot(scope).revision;
  assert.equal(f.widget('approval', 'confirm').version, item.version);
  assert.equal(f.store.snapshot(scope).revision, revision);
  item = f.widget('handoff', 'set-owner', { personId: 'me', name: '我负责准备' });
  assert.equal(item.taskData.approval.confirmation, null);
  f.widget('approval', 'confirm');
  item = f.mutate('update', { date: '2026-10-24T20:00:00+08:00' }).items[0];
  assert.equal(item.taskData.approval.confirmation, null);
  assert.equal(item.status, 'planned', 'confirming does not execute or finish the plan');
});

test('delivery rejects future or backward evidence, including material editing that bypasses a primary button', t => {
  const f = fixture(t);
  f.add({ taskData: { delivery: { stages: [{ id: 'packed', label: '打包' }, { id: 'out', label: '配送' }], events: [{ stageId: 'packed', at: '2026-10-21T12:00:00+08:00', detail: '用户收到打包短信', evidence: '短信原文' }] } } });
  const before = f.store.snapshot(scope);
  assert.throws(() => f.widget('delivery', 'record-event', { stageId: 'out', at: '2026-10-23T12:00:00+08:00', detail: '配送', evidence: '未来回执' }), code('FUTURE_EVIDENCE'));
  assert.throws(() => f.widget('delivery', 'record-event', { stageId: 'out', at: '2026-10-20T12:00:00+08:00', detail: '配送', evidence: '旧日期回执' }), code('INVALID_TASK_DATA'));
  assert.throws(() => f.widget('delivery', 'record-event', { stageId: 'out', at: '2026-10-22T08:00:00+08:00', detail: '配送', evidence: '' }), code('INVALID_TASK_DATA'));
  assert.throws(() => f.widget('delivery', 'set-data', { data: { stages: [{ id: 'out', label: '配送' }], events: [{ stageId: 'out', at: '2026-10-23T12:00:00+08:00', detail: '配送', evidence: '未来' }] } }), code('FUTURE_EVIDENCE'));
  assert.deepEqual(f.store.snapshot(scope), before);
});

test('habit calendar uses the recorded IANA zone at midnight and rejects future check-ins through both actions and editing', t => {
  const f = fixture(t, Date.parse('2026-10-21T16:30:00Z'));
  let item = f.add({ taskData: { habit: { timeZone: 'Asia/Shanghai', targetPerWeek: 3, dates: ['2026-10-20'] } } });
  const projection = projectWidget(item, 'habit', { now: f.store.now() });
  assert.equal(projection.data.today, '2026-10-22');
  assert.equal(projection.data.weekStart, '2026-10-19');
  item = f.widget('habit', 'check-in', { date: '2026-10-22', done: true });
  assert.equal(projectWidget(item, 'habit', { now: f.store.now() }).data.weekCount, 2);
  assert.throws(() => f.widget('habit', 'check-in', { date: '2026-10-23', done: true }), code('FUTURE_CHECK_IN'));
  assert.throws(() => f.widget('habit', 'set-data', { data: { timeZone: 'Asia/Shanghai', dates: ['2026-10-23'] } }), code('FUTURE_CHECK_IN'));
});

test('a bare habit uses trusted instance time zone for projection and first action, preserving an explicit recorded zone thereafter', t => {
  const clock = Date.parse('2026-10-21T16:30:00Z'), f = fixture(t, clock);
  let item = f.add({ taskType: 'habit' });
  assert.equal(projectWidget(item, 'habit', { now: clock, timeZone: 'Asia/Shanghai' }).data.today, '2026-10-22');
  let state = f.store.snapshot(scope);
  state = f.store.mutate(scope, { operation: 'widget', revision: state.revision, itemId: item.id, itemVersion: item.version, values: { kind: 'habit', action: 'check-in', date: '2026-10-22', done: true } }, { timeZone: 'Asia/Shanghai' });
  item = state.items[0];
  assert.equal(item.taskData.habit.timeZone, 'Asia/Shanghai');
  assert.deepEqual(item.taskData.habit.dates, ['2026-10-22']);
  assert.equal(projectWidget(item, 'habit', { now: clock, timeZone: 'UTC' }).data.today, '2026-10-22');
  state = f.store.mutate(scope, { operation: 'widget', revision: state.revision, itemId: item.id, itemVersion: item.version, values: { kind: 'habit', action: 'check-in', date: '2026-10-22', done: false } }, { timeZone: 'UTC' });
  assert.equal(state.items[0].taskData.habit.timeZone, 'Asia/Shanghai', 'host defaults cannot change the user recorded calendar');
  item = state.items[0];
  state = f.store.mutate(scope, { operation: 'widget', revision: state.revision, itemId: item.id, itemVersion: item.version, values: { kind: 'habit', action: 'set-data', data: { targetPerWeek: 3 } } }, { timeZone: 'UTC' });
  assert.equal(state.items[0].taskData.habit.timeZone, 'Asia/Shanghai', 'material editing that omits timeZone preserves the recorded calendar');
  item = state.items[0];
  state = f.store.mutate(scope, { operation: 'update', revision: state.revision, itemId: item.id, itemVersion: item.version, values: { taskData: { habit: { targetPerWeek: 4 } } } }, { timeZone: 'UTC' });
  assert.equal(state.items[0].taskData.habit.timeZone, 'Asia/Shanghai', 'ordinary updates obey the same recorded calendar');
  item = state.items[0];
  state = f.store.mutate(scope, { operation: 'widget', revision: state.revision, itemId: item.id, itemVersion: item.version, values: { kind: 'habit', action: 'set-data', data: { timeZone: 'America/Los_Angeles' } } }, { timeZone: 'UTC' });
  assert.equal(state.items[0].taskData.habit.timeZone, 'America/Los_Angeles', 'an explicit user correction still applies');
});

test('completed items accept only reflection and memory widget facts and never invent a photograph', t => {
  const f = fixture(t);
  f.add({ note: '我想留下这次散步的原话' });
  f.mutate('done', {});
  let item = f.widget('reflection', 'save-reflection', { rating: null, text: '下次提前带水。' });
  assert.equal(item.status, 'done');
  item = f.widget('memory', 'save-memory', { text: '沿河走了一小段', caption: '', occurredAt: null });
  assert.deepEqual(availableWidgetKinds(item), ['reflection', 'memory']);
  assert.equal(projectWidget(item, 'memory', { now }).data.occurredAt, null);
  assert.equal(Object.hasOwn(projectWidget(item, 'memory', { now }).data, 'photo'), false);
  assert.throws(() => f.widget('shopping', 'set-data', { data: {} }), code('INVALID_STATE'));
  f.mutate('undo', {});
  f.mutate('cancel', {});
  assert.throws(() => f.widget('memory', 'save-memory', { text: '改写取消事项', caption: '', occurredAt: null }), code('INVALID_STATE'));
});

test('trusted iMessage source is retained and unsafe inherited action names fail with a domain error', t => {
  const f = fixture(t);
  const item = f.add({ source: { kind: 'user', channel: 'imessage', text: '周五给生日准备一个采购清单', at: '2026-10-22T08:59:00+08:00' } });
  assert.equal(item.source.channel, 'imessage');
  assert.equal(item.source.text, '周五给生日准备一个采购清单');
  assert.throws(() => f.widget('agenda', 'constructor'), code('INVALID_WIDGET_ACTION'));
  assert.throws(() => f.widget('agenda', 'schedule', { date: '2026-10-23T20:00:00+08:00', sent: true }), code('INVALID_TASK_DATA'));
  assert.throws(() => f.mutate('update', { date: '2026-10-23T24:00:00+08:00' }), code('INVALID_REQUEST'));
});

test('whole-item editing accepts matching system receipts and omissions, but real rescheduling invalidates only the plan confirmation', t => {
  const f = fixture(t);
  f.add({ taskData: { approval: { summary: '周五准备晚饭', amount: 0 }, reminder: { at: '2026-10-23T20:00:00+08:00', minutesBefore: 30 } } });
  f.widget('reminder', 'record-reminder', { at: '2026-10-23T20:00:00+08:00', minutesBefore: 30 });
  const item = f.widget('approval', 'confirm'), before = f.store.snapshot(scope);
  const originalReceipt = item.taskData.reminder.recordedAt;
  const reordered = { reminder: structuredClone(item.taskData.reminder), approval: structuredClone(item.taskData.approval) };
  let state = f.mutate('update', { taskData: reordered });
  assert.equal(state.revision, before.revision, 'object key order alone is not a fact change');
  assert.deepEqual(state.items[0].taskData.approval.confirmation, item.taskData.approval.confirmation);
  const omitted = structuredClone(item.taskData);
  delete omitted.approval.confirmation; delete omitted.reminder.recordedAt;
  state = f.mutate('update', { taskData: omitted });
  assert.equal(state.revision, before.revision, 'editing fields that omit read-only metadata preserves matching receipts');
  state = f.mutate('update', { date: '2026-10-24T20:00:00+08:00', taskData: structuredClone(item.taskData) });
  assert.equal(state.items[0].date, '2026-10-24T12:00:00.000Z');
  assert.equal(state.items[0].taskData.approval.confirmation, null);
  assert.equal(state.items[0].taskData.reminder.recordedAt, originalReceipt);
  assert.throws(() => f.mutate('update', { taskData: structuredClone(item.taskData) }), code('INVALID_TASK_DATA'), 'an old approval nonce cannot be restored after changing facts');
});

test('normal item editing cannot add or alter system metadata, and widget material editing cannot bypass that policy', t => {
  const f = fixture(t);
  f.add({ taskData: { approval: { summary: '仍待确认的晚饭计划', amount: 0 }, reminder: { at: '2026-10-23T20:00:00+08:00', minutesBefore: 30 } } });
  let item = f.store.snapshot(scope).items[0];
  const fake = structuredClone(item.taskData); fake.approval.confirmation = { itemVersion: item.version + 1, at: new Date(now).toISOString() };
  assert.throws(() => f.mutate('update', { taskData: fake }), code('INVALID_TASK_DATA'));
  item = f.widget('reminder', 'record-reminder', { at: '2026-10-23T20:00:00+08:00', minutesBefore: 30 });
  item = f.widget('approval', 'confirm');
  const before = f.store.snapshot(scope), changedNonce = structuredClone(item.taskData);
  changedNonce.approval.confirmation.itemVersion += 1;
  assert.throws(() => f.mutate('update', { taskData: changedNonce }), code('INVALID_TASK_DATA'));
  const changedTimestamp = structuredClone(item.taskData); changedTimestamp.reminder.recordedAt = '2026-10-22T00:00:00Z';
  assert.throws(() => f.mutate('update', { taskData: changedTimestamp }), code('INVALID_TASK_DATA'));
  assert.throws(() => f.widget('approval', 'set-data', { data: item.taskData.approval }), code('INVALID_TASK_DATA'));
  assert.throws(() => f.widget('reminder', 'set-data', { data: item.taskData.reminder }), code('INVALID_TASK_DATA'));
  assert.deepEqual(f.store.snapshot(scope), before);
});

test('completed whole-item forms can change notes and retrospective namespaces while all business fields remain locked', t => {
  const f = fixture(t);
  f.add({ date: '2026-10-21T20:00:00+08:00', steps: [{ id: 'cake', label: '取蛋糕', done: true }], taskData: { budget: { total: 100, lines: [{ id: 'food', label: '餐费', amount: 80 }] } } });
  let item = f.mutate('done', {}).items[0];
  const originalSource = structuredClone(item.source), originalBudget = structuredClone(item.taskData.budget);
  const form = { title: item.title, kind: item.kind, date: item.date, steps: item.steps, candidates: item.candidates, taskType: item.taskType, note: '这次准备时间刚好。', taskData: { ...item.taskData, reflection: { rating: 4, text: '下次早十分钟取蛋糕。' }, memory: { text: '晚饭后一起吹了蜡烛。' } } };
  item = f.mutate('update', form).items[0];
  assert.equal(item.status, 'done');
  assert.equal(item.taskData.reflection.rating, 4);
  assert.equal(item.taskData.memory.text, '晚饭后一起吹了蜡烛。');
  assert.deepEqual(item.taskData.budget, originalBudget);
  assert.deepEqual(item.source, originalSource);
  const before = f.store.snapshot(scope);
  for (const values of [{ title: '改写已结束标题' }, { kind: 'wish' }, { date: '2026-10-24T20:00:00+08:00' }, { taskType: 'shopping' }, { steps: [{ ...item.steps[0], done: false }] }, { taskData: { ...item.taskData, budget: { total: 200 } } }, { taskData: { reflection: { rating: 5 } } }]) assert.throws(() => f.mutate('update', values), code('INVALID_STATE'));
  assert.deepEqual(f.store.snapshot(scope), before);
});

test('legacy auto intent and historical time preferences survive retrospective editing', t => {
  const f = fixture(t);
  let item = f.add({ taskType: 'time-grid', taskData: { 'time-grid': { durationMinutes: 30, slots: [{ id: 'morning', start: '2026-10-23T10:00:00+08:00', status: 'available' }] } } });
  item = f.widget('time-grid', 'choose-slot', { slotId: 'morning' });
  f.store.now = () => Date.parse('2026-10-24T09:00:00+08:00');
  item = f.mutate('done', {}).items[0];
  assert.equal(item.taskData['time-grid'].selectedSlotId, 'morning', 'an elapsed preference remains a historical user record');
  const raw = f.store.read(['local', 'owner']); delete raw.items[0].taskType;
  f.store.db.prepare('UPDATE journal_scopes SET data=? WHERE account=? AND user_id=?').run(JSON.stringify(raw), 'local', 'owner');
  const revision = raw.revision;
  let state = f.mutate('update', { taskType: 'auto' });
  assert.equal(state.revision, revision, 'missing legacy taskType is semantically auto');
  state = f.mutate('update', { note: '已经结束，留下原安排。', taskType: 'auto', taskData: { ...state.items[0].taskData, memory: { text: '这次选择的是上午时段。' } } });
  assert.equal(state.items[0].taskData['time-grid'].selectedSlotId, 'morning');
});

test('an automatic birthday note can select an empty preparation structure without inventing a date or completing a step', t => {
  const f = fixture(t);
  const item = f.add({ title: '帮我准备妈妈的生日', note: '家里一起吃饭，日期和准备事项还没有确定。' });
  const state = f.store.snapshot(scope), facts = structuredClone(state.items);
  assert.deepEqual(materialWidgetKinds(item), ['agenda']);
  assert.deepEqual(state.layout.widgets.map(widget => widget.kind), ['agenda'], 'basic rendering does not produce eighteen empty cards');
  assert.equal(availableWidgetKinds(item).includes('prep'), true);
  const proposal = { widgets: [{ id: `${item.id}:prep`, itemId: item.id, kind: 'prep' }], reason: '生日准备先用阶段结构等待补材料' };
  assert.deepEqual(parseDesign(JSON.stringify(proposal), state), proposal);
  const view = projectWidget(item, 'prep', { now });
  assert.equal(view.empty, true);
  assert.deepEqual(view.data.phases, []);
  assert.deepEqual(view.data.steps, []);
  assert.equal(view.actions.find(action => action.action === 'step').enabled, false);
  assert.equal(view.actions.find(action => action.action === 'set-data').enabled, true);
  assert.equal(item.date, null);
  assert.deepEqual(f.store.snapshot(scope).items, facts);
});

test('an automatic habit note can select a real-calendar empty grid without fabricating targets or completed dates', t => {
  const f = fixture(t);
  const item = f.add({ title: '想养成饭后散步的习惯', note: '每周目标还没有定，先留个位置。' });
  const state = f.store.snapshot(scope);
  assert.equal(availableWidgetKinds(item).includes('habit'), true);
  assert.deepEqual(parseDesign(JSON.stringify({ widgets: [{ id: `${item.id}:habit`, itemId: item.id, kind: 'habit' }], reason: '选择习惯结构，等待用户补目标' }), state).widgets[0].kind, 'habit');
  const view = projectWidget(item, 'habit', { now, timeZone: 'Asia/Shanghai' });
  assert.equal(view.empty, true);
  assert.equal(view.data.targetPerWeek, null);
  assert.deepEqual(view.data.dates, []);
  assert.equal(view.data.weekCount, 0, 'a count of no user records is not a fabricated habit target');
  assert.equal(view.data.today, '2026-10-22', 'the calendar uses actual trusted time');
  assert.equal(view.data.timeZone, 'Asia/Shanghai');
  assert.deepEqual(item.taskData, {});
  assert.deepEqual(materialWidgetKinds(item), ['agenda']);
});

test('an automatic materials note can select an empty file folder or budget without claiming file access, prices or payment', t => {
  const f = fixture(t);
  const item = f.add({ title: '整理租房要交的材料', note: '具体文件和费用还没有发给你。' });
  const state = f.store.snapshot(scope);
  const proposals = { widgets: [{ id: `${item.id}:documents`, itemId: item.id, kind: 'documents' }, { id: `${item.id}:budget`, itemId: item.id, kind: 'budget' }], reason: '先留下材料清单和待补预算结构' };
  assert.deepEqual(parseDesign(JSON.stringify(proposals), state), proposals);
  const files = projectWidget(item, 'documents', { now });
  assert.equal(files.empty, true);
  assert.deepEqual(files.data.entries, []);
  assert.equal(files.actions.find(action => action.action === 'mark-document').enabled, false);
  const budget = projectWidget(item, 'budget', { now });
  assert.equal(budget.data.total, null);
  assert.equal(budget.data.remaining, null);
  assert.deepEqual(budget.data.lines, []);
  assert.equal(budget.actions.find(action => action.action === 'reserve').enabled, false);
  assert.equal(item.date, null);
  assert.deepEqual(item.taskData, {});
});

test('automatic structure selection respects life stage and manual intent while materials stay separate from possibilities', t => {
  const f = fixture(t);
  let item = f.add({ title: '尚未发生的一件事' });
  assert.equal(availableWidgetKinds(item).length, 18);
  assert.equal(availableWidgetKinds(item).includes('reflection'), false);
  assert.equal(availableWidgetKinds(item).includes('memory'), false);
  item = f.mutate('update', { taskType: 'budget' }).items[0];
  assert.deepEqual(availableWidgetKinds(item), ['budget']);
  assert.throws(() => parseDesign(JSON.stringify({ widgets: [{ id: `${item.id}:documents`, itemId: item.id, kind: 'documents' }], reason: '不兼容明确预算意图' }), f.store.snapshot(scope)), code('INVALID_DESIGN'));
  item = f.mutate('update', { taskType: 'auto', kind: 'experience' }).items[0];
  assert.equal(availableWidgetKinds(item).includes('memory'), true);
  assert.equal(availableWidgetKinds(item).includes('reflection'), true);
  item = f.mutate('update', { kind: 'arrangement', taskData: { reflection: { text: '本人提供的感受' } } }).items[0];
  assert.equal(availableWidgetKinds(item).includes('reflection'), true);
  assert.equal(availableWidgetKinds(item).includes('memory'), false);
  item = f.mutate('done', {}).items[0];
  assert.deepEqual(availableWidgetKinds(item), ['reflection', 'memory']);
  f.mutate('undo', {});
  item = f.mutate('cancel', {}).items[0];
  assert.deepEqual(availableWidgetKinds(item), []);
  assert.deepEqual(materialWidgetKinds(item), []);
});

function saveLegacyLayout(f, widgets) {
  const state = f.store.read(['local', 'owner']);
  state.layout = { ...state.layout, widgets: structuredClone(widgets), source: 'agent', reason: '升级前已保存的展示' };
  f.store.db.prepare('UPDATE journal_scopes SET data=? WHERE account=? AND user_id=?').run(JSON.stringify(state), 'local', 'owner');
}
function modernDesign(f, widgets) {
  const before = f.store.snapshot(scope), proposal = { widgets, reason: '设计 Agent 按现有事实选择现代结构' };
  parseDesign(JSON.stringify(proposal), before);
  const queued = f.mutate('design-start', {});
  return f.mutate('design-result', { ...proposal, token: queued.design.token, baseRevision: queued.design.baseRevision, layoutVersion: queued.design.layoutVersion });
}

test('a hidden legacy birthday focus blocks its modern agenda alias and restores the original presentation without duplicate cards', t => {
  const f = fixture(t);
  const item = f.add({ title: '家里的生日晚饭', date: '2026-10-25T20:00:00+08:00', steps: [{ id: 'cake', label: '核对蛋糕口味', done: false }], taskData: { budget: { total: 300 } } });
  const focus = { id: `${item.id}:focus`, itemId: item.id, kind: 'focus', emphasis: 'quiet', reason: '升级前的安静焦点呈现' };
  const checklist = { id: `${item.id}:checklist`, itemId: item.id, kind: 'checklist', emphasis: 'normal', reason: '升级前准备步骤' };
  saveLegacyLayout(f, [focus, checklist]);
  const order = [focus.id, checklist.id, `${item.id}:budget`];
  f.mutate('preferences', { hidden: [focus.id], order });
  const facts = structuredClone(f.store.snapshot(scope).items);
  let state = modernDesign(f, [
    { id: `${item.id}:agenda`, itemId: item.id, kind: 'agenda', emphasis: 'primary' },
    { id: `${item.id}:prep`, itemId: item.id, kind: 'prep' },
    { id: `${item.id}:budget`, itemId: item.id, kind: 'budget' },
  ]);
  assert.equal(state.layout.widgets.some(widget => canonicalWidgetKind(widget.kind) === 'agenda'), false);
  assert.deepEqual(state.layout.widgets.map(widget => widget.kind), ['prep', 'budget'], 'a different preparation or budget structure is not hidden');
  assert.deepEqual(state.preferences.hidden, [focus.id]);
  assert.deepEqual(state.preferences.order, order);
  state = f.mutate('preferences', { hidden: [] });
  assert.deepEqual(state.layout.widgets[0], focus);
  assert.equal(state.layout.widgets.filter(widget => canonicalWidgetKind(widget.kind) === 'agenda').length, 1);
  assert.deepEqual(state.preferences.order, order, 'restoration does not rewrite history to modern IDs');
  assert.deepEqual(state.items, facts, 'preferences and design commits never migrate life facts');
  state = f.mutate('preferences', { hidden: [focus.id] });
  assert.equal(state.layout.widgets.some(widget => canonicalWidgetKind(widget.kind) === 'agenda'), false);
});

test('a pinned legacy checklist retains its exact ID, appearance and order while modern preparation proposals cannot duplicate it', t => {
  const f = fixture(t);
  const item = f.add({ title: '出门前的准备', date: '2026-10-24T09:00:00+08:00', steps: [{ id: 'keys', label: '带上钥匙', done: false }], taskData: { budget: { total: 200 } } });
  const checklist = { id: `${item.id}:checklist`, itemId: item.id, kind: 'checklist', emphasis: 'primary', reason: '用户固定的原准备清单' };
  const focus = { id: `${item.id}:focus`, itemId: item.id, kind: 'focus', emphasis: 'normal', reason: '原日期焦点' };
  saveLegacyLayout(f, [focus, checklist]);
  const pinned = [checklist.id], order = [checklist.id, focus.id, `${item.id}:budget`];
  f.mutate('preferences', { pinned, order });
  const facts = structuredClone(f.store.snapshot(scope).items);
  let state = modernDesign(f, [
    { id: `${item.id}:budget`, itemId: item.id, kind: 'budget' },
    { id: `${item.id}:agenda`, itemId: item.id, kind: 'agenda', emphasis: 'primary' },
    { id: `${item.id}:prep`, itemId: item.id, kind: 'prep', reason: '模型提出的同类型新卡' },
  ]);
  assert.deepEqual(state.layout.widgets[0], checklist);
  assert.equal(state.layout.widgets.some(widget => widget.id === `${item.id}:prep`), false);
  assert.deepEqual(state.layout.widgets.map(widget => canonicalWidgetKind(widget.kind)), ['prep', 'agenda', 'budget']);
  assert.equal(state.layout.widgets.filter(widget => widget.emphasis === 'primary').length, 1, 'preserving an old primary cannot create a second primary');
  assert.deepEqual(state.preferences.pinned, pinned);
  assert.deepEqual(state.preferences.order, order);
  state = modernDesign(f, [{ id: `${item.id}:budget`, itemId: item.id, kind: 'budget' }]);
  assert.deepEqual(state.layout.widgets[0], checklist, 'omitting the fixed card cannot remove it');
  assert.deepEqual(state.items, facts);
  f.mutate('preferences', { pinned: [] });
  state = modernDesign(f, [{ id: `${item.id}:prep`, itemId: item.id, kind: 'prep' }, { id: `${item.id}:budget`, itemId: item.id, kind: 'budget' }]);
  assert.equal(state.layout.widgets[0].id, `${item.id}:prep`, 'an explicit unpin allows a later modern proposal');
  assert.deepEqual(state.preferences.order, order);
});

test('legacy timeline hiding is confined to the same item and canonical structure, and hiding still wins over pinning', t => {
  const f = fixture(t);
  const first = f.add({ title: '明天取包裹', date: '2026-10-23T18:00:00+08:00', taskData: { budget: { total: 20 } } });
  const second = f.mutate('add', { title: '周末散步', date: '2026-10-24T09:00:00+08:00' }).items[1];
  const timeline = { id: `${first.id}:timeline`, itemId: first.id, kind: 'timeline', emphasis: 'quiet', reason: '原取货时间卡' };
  const otherAgenda = { id: `${second.id}:agenda`, itemId: second.id, kind: 'agenda' };
  saveLegacyLayout(f, [timeline, otherAgenda]);
  f.mutate('preferences', { hidden: [timeline.id], pinned: [timeline.id] });
  let state = modernDesign(f, [
    { id: `${first.id}:agenda`, itemId: first.id, kind: 'agenda' },
    { id: `${first.id}:budget`, itemId: first.id, kind: 'budget' },
    otherAgenda,
  ]);
  assert.equal(state.layout.widgets.some(widget => widget.itemId === first.id && canonicalWidgetKind(widget.kind) === 'agenda'), false);
  assert.equal(state.layout.widgets.some(widget => widget.id === otherAgenda.id), true);
  assert.equal(state.layout.widgets.some(widget => widget.id === `${first.id}:budget`), true);
  state = f.mutate('preferences', { hidden: [] });
  assert.deepEqual(state.layout.widgets[0], timeline);
  assert.equal(state.layout.widgets.filter(widget => widget.itemId === first.id && canonicalWidgetKind(widget.kind) === 'agenda').length, 1);
  assert.deepEqual(state.preferences.pinned, [timeline.id]);
});
