import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { WIDGET_KINDS, projectWidget } from '../plugins/life-journal/widgets.mjs';
import { JournalDesigner, parseDesign } from '../plugins/life-journal/designer.mjs';
import { journalView, journalRecommendation } from '../plugins/agent-hub/journal.mjs';
import { isJsonValue } from '@deepseek-ai/dsh-util-values';

const LOCAL = { account: 'local', userId: 'owner' };
const at = '2026-10-14T02:00:00.000Z';
const hasCode = expected => error => error.code === expected;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoman-widget-integration-'));
  const stores = [];
  const open = () => {
    const store = new JournalStore(root, { now: () => Date.parse(at) });
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, open, store: open() };
}

function legacyState() {
  const item = (id, title, extra = {}) => ({
    id, version: 3, title, kind: 'arrangement', status: 'planned',
    date: '2026-10-18T12:00:00.000Z', note: '原有材料',
    source: { kind: 'user', text: title, channel: 'weixin', at },
    steps: [], candidates: [], createdAt: at, updatedAt: at, ...extra,
  });
  const widgets = ['checklist', 'timeline', 'comparison', 'waiting'].map(kind => ({
    id: `birthday:${kind}`, itemId: 'birthday', kind, emphasis: 'normal', reason: '用户原有布局',
  }));
  widgets.push({ id: 'travel:memory', itemId: 'travel', kind: 'memory', emphasis: 'quiet' });
  widgets.push({ id: 'wish:wish', itemId: 'wish', kind: 'wish', emphasis: 'normal' });
  return {
    revision: 12,
    items: [
      item('birthday', '生日准备', {
        steps: [{ id: 'cake', label: '取蛋糕', done: false }],
        candidates: [{ id: 'one', name: '草莓蛋糕', detail: '待本人核对', selected: false }],
      }),
      item('travel', '已结束的旅行', { kind: 'experience', status: 'done' }),
      item('wish', '想去的书店', { kind: 'wish', date: null }),
    ],
    layout: { version: 8, widgets, source: 'agent', reason: '保留用户确认的版式' },
    preferences: { autoLayout: false, motion: 'off', hidden: ['birthday:focus'], pinned: ['birthday:checklist'], order: ['birthday:timeline', 'birthday:checklist'] },
    design: { status: 'idle', token: null, baseRevision: 12, layoutVersion: 8 },
    events: [], _undo: {},
    _hiddenWidgets: [{ id: 'birthday:focus', itemId: 'birthday', kind: 'focus', emphasis: 'quiet', reason: '本人隐藏的原组件' }],
  };
}

test('a pre-upgrade paused ledger keeps all seven legacy widget identities and preferences after reopening and editing', async t => {
  const f = await fixture(t);
  const legacy = legacyState();
  f.store.db.prepare('INSERT INTO journal_scopes(account,user_id,data) VALUES(?,?,?)').run(LOCAL.account, LOCAL.userId, JSON.stringify(legacy));
  const reopened = f.open();
  const initial = reopened.snapshot(LOCAL);
  assert.equal(initial.preferences.autoLayout, false);
  assert.deepEqual(initial.preferences, legacy.preferences);
  assert.deepEqual(initial.layout.widgets.map(widget => widget.id), legacy.layout.widgets.map(widget => widget.id));
  assert.equal(initial.items[0].source.text, '生日准备');
  assert.equal(initial.items[1].status, 'done');

  const edited = reopened.mutate(LOCAL, { operation: 'update', revision: initial.revision, itemId: 'birthday', itemVersion: 3, values: { note: '本人补充：先核对取货时间' } });
  assert.deepEqual(edited.preferences, legacy.preferences);
  assert.equal(edited.items[0].source.text, initial.items[0].source.text);
  assert.equal(edited.items[0].note, '本人补充：先核对取货时间');
  assert.ok(edited.layout.widgets.some(widget => widget.id === 'birthday:checklist'));
  assert.ok(edited.layout.widgets.some(widget => widget.id === 'wish:wish'));

  const restored = f.store.mutate(LOCAL, { operation: 'preferences', revision: edited.revision, values: { hidden: [] } });
  assert.deepEqual(restored.layout.widgets.find(widget => widget.id === 'birthday:focus'), legacy._hiddenWidgets[0]);
  const again = f.open().snapshot(LOCAL);
  assert.deepEqual(again.layout.widgets, restored.layout.widgets);
  assert.deepEqual(again.preferences.pinned, ['birthday:checklist']);
  assert.deepEqual(again.preferences.order, ['birthday:timeline', 'birthday:checklist']);
});

test('legacy ledger preferences and writes stay isolated between local and authorized user scopes', async t => {
  const f = await fixture(t);
  const remote = { account: 'a'.repeat(64), userId: 'fixture-owner' };
  const legacy = legacyState();
  f.store.db.prepare('INSERT INTO journal_scopes(account,user_id,data) VALUES(?,?,?)').run(remote.account, remote.userId, JSON.stringify(legacy));
  assert.equal(f.store.snapshot(LOCAL).items.length, 0);
  const stale = f.store.snapshot(remote);
  const saved = f.open().mutate(remote, { operation: 'update', revision: stale.revision, itemId: 'birthday', itemVersion: 3, values: { note: '另一入口已校对' } });
  assert.throws(() => f.store.mutate(remote, { operation: 'update', revision: stale.revision, itemId: 'birthday', itemVersion: 3, values: { note: '过期材料' } }), hasCode('VERSION_CONFLICT'));
  assert.equal(f.store.snapshot(remote).items[0].note, saved.items[0].note);
  assert.throws(() => f.store.mutate(LOCAL, { operation: 'delete', revision: 0, itemId: 'birthday' }), hasCode('ITEM_NOT_FOUND'));
  assert.deepEqual(f.store.snapshot(remote).preferences, legacy.preferences);
});

// These are concrete, authored domain examples. The common runner checks the
// same persistence/CAS contract; each assertion checks a different business fact.
const examples = [
  {
    kind: 'agenda', title: '把包裹放进一个已核对的空档',
    data: { durationMinutes: 45, place: '家里' },
    action: { action: 'schedule', date: '2026-10-18T15:30:00+08:00' },
    verify(item, view) { assert.equal(item.date, '2026-10-18T07:30:00.000Z'); assert.equal(view.data.durationMinutes, 45); assert.equal(view.data.place, '家里'); },
  },
  {
    kind: 'time-grid', title: '剪发时段连同收尾缓冲避开已有安排',
    data: { durationMinutes: 60, bufferMinutes: 15, slots: [{ id: 'early', start: '2026-10-18T10:00:00+08:00', status: 'available' }, { id: 'overlap', start: '2026-10-18T11:00:00+08:00', status: 'available' }], constraints: [{ start: '2026-10-18T11:30:00+08:00', end: '2026-10-18T12:30:00+08:00', label: '已有安排' }] },
    action: { action: 'choose-slot', slotId: 'early' },
    verify(item, view) { assert.equal(item.taskData['time-grid'].selectedSlotId, 'early'); assert.equal(view.data.slots.find(slot => slot.id === 'overlap').selectable, false); assert.equal(item.date, null, 'a preference is not a confirmed appointment'); },
  },
  {
    kind: 'prep', title: '生日准备只完成一个步骤',
    fields: { steps: [{ id: 'cake', label: '取蛋糕', done: false }, { id: 'candles', label: '准备蜡烛', done: false }] },
    data: { phases: [{ id: 'before', label: '出门前', stepIds: ['cake', 'candles'] }], activePhaseId: 'before' },
    action: { action: 'step', stepId: 'cake', done: true },
    verify(item, view) { assert.equal(item.steps[0].done, true); assert.equal(item.steps[1].done, false); assert.equal(item.status, 'planned'); assert.equal(view.data.phases[0].stepIds.length, 2); },
  },
  {
    kind: 'decision', title: '按预算和宽度记下家具候选',
    fields: { candidates: [{ id: 'narrow', name: '窄柜', selected: false }, { id: 'wide', name: '宽柜', selected: false }] },
    data: { budget: 1800, widthLimitCm: 30, criteria: [{ id: 'material', label: '材料' }], options: [{ candidateId: 'narrow', amount: 1580, widthCm: 27, fields: { material: '实木' } }, { candidateId: 'wide', amount: 1280, widthCm: 34, fields: { material: '板材' } }] },
    action: { action: 'choose', candidateId: 'narrow' },
    verify(item, view) { assert.equal(item.candidates[0].selected, true); assert.equal(item.candidates[1].selected, false); assert.equal(view.data.candidates[1].selectable, false); assert.equal(item.status, 'planned'); },
  },
  {
    kind: 'budget', title: '预算预留保留未知门票报价',
    data: { total: 1500, lines: [{ id: 'transport', label: '交通', amount: 240 }, { id: 'meals', label: '餐饮', amount: 420 }, { id: 'stay', label: '住宿', amount: 680 }, { id: 'tickets', label: '门票待报价', amount: null }] },
    action: { action: 'reserve', amount: 120 },
    verify(item, view) { assert.equal(item.taskData.budget.reserve, 120); assert.equal(view.data.remaining, 40); assert.deepEqual(view.data.unknownLineIds, ['tickets']); assert.equal(item.taskData.budget.lines[3].amount, null); },
  },
  {
    kind: 'shopping', title: '买到青菜仍保留家里已有的米',
    data: { entries: [{ id: 'vegetables', name: '青菜', quantity: 300, unit: '克', category: '蔬菜' }, { id: 'rice', name: '米', quantity: 2, unit: '杯', atHome: true }] },
    action: { action: 'mark-bought', entryId: 'vegetables', done: true },
    verify(item) { assert.equal(item.taskData.shopping.entries[0].bought, true); assert.equal(item.taskData.shopping.entries[1].atHome, true); assert.equal(item.taskData.shopping.entries[1].bought, false); },
  },
  {
    kind: 'itinerary', title: '省略公园时不发明新的路段用时',
    data: { stops: [{ id: 'museum', name: '博物馆' }, { id: 'park', name: '公园', optional: true }, { id: 'cafe', name: '咖啡馆' }], legs: [{ from: 'museum', to: 'park', minutes: 20, mode: '步行' }, { from: 'park', to: 'cafe', minutes: 15, mode: '步行' }] },
    action: { action: 'set-route', omittedStopIds: ['park'] },
    verify(item, view) { assert.deepEqual(view.data.visibleStops.map(stop => stop.id), ['museum', 'cafe']); assert.equal(view.data.segments[0].minutes, null); assert.ok(view.missing.includes('路段用时待核实')); },
  },
  {
    kind: 'waiting', title: '编辑给朋友的催询草稿仍未发信',
    data: { requests: [{ id: 'friend', person: '朋友', request: '确认到店时间', status: 'waiting' }] },
    action: { action: 'save-draft', requestId: 'friend', text: '方便确认一下八点到店吗？' },
    verify(item) { assert.equal(item.taskData.waiting.requests[0].draft, '方便确认一下八点到店吗？'); assert.equal(item.taskData.waiting.requests[0].status, 'waiting'); },
  },
  {
    kind: 'delivery', title: '依据已有短信记一条履约回执',
    data: { reference: '本人核对的蛋糕订单', stages: [{ id: 'accepted', label: '店家已接单' }, { id: 'ready', label: '可以取货' }] },
    action: { action: 'record-event', stageId: 'accepted', at: '2026-10-14T01:00:00Z', detail: '本人看到了接单短信', evidence: '短信内容由本人录入' },
    verify(item, view) { assert.equal(view.data.currentStageId, 'accepted'); assert.equal(item.taskData.delivery.events[0].evidence, '短信内容由本人录入'); assert.equal(item.taskData.delivery.events.length, 1); },
  },
  {
    kind: 'deadline', title: '截止前安排核对材料的下一步',
    data: { dueAt: '2026-10-20T09:00:00Z' },
    action: { action: 'schedule', at: '2026-10-19T08:00:00Z', label: '核对材料清单' },
    verify(item) { assert.equal(item.taskData.deadline.nextAt, '2026-10-19T08:00:00.000Z'); assert.equal(item.taskData.deadline.dueAt, '2026-10-20T09:00:00.000Z'); assert.equal(item.taskData.deadline.nextLabel, '核对材料清单'); },
  },
  {
    kind: 'reminder', title: '保存取货前半小时的提醒计划',
    data: {}, action: { action: 'record-reminder', at: '2026-10-18T12:00:00Z', minutesBefore: 30 },
    verify(item, view) { assert.equal(view.data.notifyAt, '2026-10-18T11:30:00.000Z'); assert.equal(view.data.deliveryStatus, 'plan-only'); assert.equal(item.taskData.reminder.recordedAt, at); },
  },
  {
    kind: 'habit', title: '上海时区的今日打卡保存为日历日期',
    data: { targetPerWeek: 3, timeZone: 'Asia/Shanghai', dates: ['2026-10-12'] },
    action: { action: 'check-in', date: '2026-10-14', done: true },
    verify(item, view) { assert.deepEqual(item.taskData.habit.dates, ['2026-10-12', '2026-10-14']); assert.equal(view.data.today, '2026-10-14'); assert.equal(view.data.weekCount, 2); },
  },
  {
    kind: 'meal', title: '两人食谱改三人后仅缩放已知用量',
    data: { baseServings: 2, servings: 2, ingredients: [{ id: 'vegetables', name: '青菜', quantity: 200, unit: '克' }, { id: 'salt', name: '盐', quantity: null, unit: '少许' }], instructions: [{ id: 'wash', label: '洗菜', done: false }] },
    action: { action: 'set-servings', servings: 3 },
    verify(item, view) { assert.equal(item.taskData.meal.servings, 3); assert.equal(view.data.scaledIngredients[0].scaledQuantity, 300); assert.equal(view.data.scaledIngredients[1].scaledQuantity, null); },
  },
  {
    kind: 'collection', title: '收藏一条具体书店线索',
    data: { entries: [{ id: 'old', title: '旧的笔记', note: '先保留' }] },
    action: { action: 'add-entry', entry: { id: 'bookshop', title: '想去的书店', note: '等路过附近再去', url: 'https://example.invalid/bookshop' } },
    verify(item) { assert.equal(item.taskData.collection.entries.length, 2); assert.equal(item.taskData.collection.entries[1].note, '等路过附近再去'); assert.equal(item.taskData.collection.entries[0].note, '先保留'); },
  },
  {
    kind: 'documents', title: '租房材料状态只是本人记录',
    data: { entries: [{ id: 'contract', name: '租约摘要', type: '本人材料', state: 'missing', note: '无附件读取权限' }, { id: 'identity', name: '身份材料', state: 'missing' }] },
    action: { action: 'mark-document', entryId: 'contract', state: 'provided' },
    verify(item) { assert.equal(item.taskData.documents.entries[0].state, 'provided'); assert.equal(item.taskData.documents.entries[0].url, null); assert.equal(item.taskData.documents.entries[1].state, 'missing'); },
  },
  {
    kind: 'approval', title: '确认一份零费用计划而不执行外部动作',
    data: { summary: '按本人记录的时间出门', amount: 0, scheduledAt: '2026-10-18T12:00:00Z', conditions: ['店家是否营业仍待核对'] },
    action: { action: 'confirm' },
    verify(item, view) { assert.equal(view.data.confirmed, true); assert.equal(item.taskData.approval.confirmation.itemVersion, item.version); assert.equal(item.status, 'planned'); },
  },
  {
    kind: 'recovery', title: '阻塞后选择先补资料的方向',
    data: { blocker: '尚无商家可订证据', known: ['两位，周三20:00'], missing: ['营业与订位情况'], options: [{ id: 'check', label: '本人先核对商家' }, { id: 'change', label: '考虑其他店' }] },
    action: { action: 'choose-path', optionId: 'check' },
    verify(item) { assert.equal(item.taskData.recovery.selectedOptionId, 'check'); assert.deepEqual(item.taskData.recovery.missing, ['营业与订位情况']); },
  },
  {
    kind: 'reflection', title: '结束后记录评分与下次准备建议',
    finishFirst: true, data: {}, action: { action: 'save-reflection', rating: 4, text: '蛋糕很好，下次提前两天取号。' },
    verify(item) { assert.equal(item.status, 'done'); assert.equal(item.taskData.reflection.rating, 4); assert.equal(item.taskData.reflection.text, '蛋糕很好，下次提前两天取号。'); },
  },
  {
    kind: 'memory', title: '已结束的经历留下原话而保留日期',
    finishFirst: true, data: {}, action: { action: 'save-memory', text: '今天一起吹了蜡烛。', caption: '生日那天', occurredAt: '2026-10-13T12:00:00Z' },
    verify(item) { assert.equal(item.status, 'done'); assert.equal(item.taskData.memory.text, '今天一起吹了蜡烛。'); assert.equal(item.taskData.memory.occurredAt, '2026-10-13T12:00:00.000Z'); },
  },
  {
    kind: 'handoff', title: '只调整一位负责人的姓名',
    data: { people: [{ id: 'cake', name: '我', role: '准备', tasks: ['取蛋糕'] }, { id: 'room', name: '朋友', role: '布置', tasks: ['准备桌面'] }], condition: '先核对取货安排' },
    action: { action: 'set-owner', personId: 'cake', name: '家人' },
    verify(item) { assert.equal(item.taskData.handoff.people[0].name, '家人'); assert.deepEqual(item.taskData.handoff.people[0].tasks, ['取蛋糕']); assert.equal(item.taskData.handoff.people[1].name, '朋友'); },
  },
];

assert.equal(new Set(examples.map(example => example.kind)).size, 20);
assert.deepEqual(new Set(examples.map(example => example.kind)), new Set(WIDGET_KINDS));

for (const example of examples) {
  test(`real ledger ${example.kind}: ${example.title}`, async t => {
    const f = await fixture(t);
    let state = f.store.mutate(LOCAL, { operation: 'add', revision: 0, values: { title: example.title, taskType: example.kind, taskData: { [example.kind]: example.data }, ...example.fields } });
    const itemId = state.items[0].id;
    const originalSource = state.items[0].source;
    if (example.finishFirst) state = f.store.mutate(LOCAL, { operation: 'done', revision: state.revision, itemId, itemVersion: state.items[0].version, values: {} });
    const before = structuredClone(state);
    const values = { kind: example.kind, ...example.action };
    assert.throws(() => f.store.mutate(LOCAL, { operation: 'widget', revision: state.revision, itemId, values }), hasCode('INVALID_REQUEST'), 'domain write requires the item version');
    const saved = f.store.mutate(LOCAL, { operation: 'widget', revision: state.revision, itemId, itemVersion: state.items[0].version, values });
    assert.equal(saved.revision, before.revision + 1);
    assert.equal(saved.items[0].version, before.items[0].version + 1);
    assert.deepEqual(saved.items[0].source, originalSource);
    assert.throws(() => f.open().mutate(LOCAL, { operation: 'widget', revision: before.revision, itemId, itemVersion: before.items[0].version, values }), hasCode('VERSION_CONFLICT'));
    const reread = f.open().snapshot(LOCAL);
    assert.deepEqual(reread.items, saved.items);
    const item = reread.items.find(item => item.id === itemId);
    example.verify(item, projectWidget(item, example.kind, { now: Date.parse(at) }));
    assert.equal(f.store.snapshot({ account: 'b'.repeat(64), userId: 'another-user' }).items.length, 0);
  });
}

async function httpFixture(t) {
  const { createWebUI } = await import('../plugins/webui/server.mjs');
  const root = await mkdtemp(join(tmpdir(), 'xiaoman-widget-http-'));
  const settings = {
    revision: 'widget-fixture', installed: true, runtimeInstalled: true,
    socket: join(root, 'no-real-agent.sock'), pending: [], capabilities: [],
    config: { owner: '本地测试', agent: { provider: 'dsh' }, im: { provider: 'weixin', access_policy: 'allowlist', allow_from: ['fixture-owner'] }, proactive: { enabled: false, timezone: 'Asia/Shanghai' } },
  };
  const app = createWebUI({ root, helper: async () => settings,
    rpc: async () => ({ kind: 'pa', data: { protocol: 1, account: 'a'.repeat(64), users: [{ id: 'fixture-owner', tasks: [] }], journalAvailable: false, configRevision: settings.revision } }) });
  app.journal.store.now = () => Date.parse(at);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const home = await fetch(origin);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const get = async path => fetch(`${origin}/api/${path}`, { headers: { Cookie: cookie } }).then(response => response.json());
  const state = await get('state');
  assert.equal(state.ok, true);
  const post = async (body, extraHeaders = {}) => {
    const response = await fetch(`${origin}/api/journal`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-PA-CSRF': state.data.csrf, ...extraHeaders }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  t.after(async () => { await app.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, app, settings, get, post };
}

test('the protected real HTTP endpoint persists all twenty authored domain actions and rejects stale or forged writes', async t => {
  const f = await httpFixture(t);
  for (const example of examples) {
    const prior = await f.get('journal');
    let saved = await f.post({ operation: 'add', revision: prior.data.revision, values: { title: example.title, taskType: example.kind, taskData: { [example.kind]: example.data }, ...example.fields, source: { kind: 'user', channel: 'weixin', text: '伪造来源' } } });
    assert.equal(saved.ok, true, `${example.kind} add: ${saved.error}`);
    const itemId = saved.data.items.at(-1).id;
    if (example.finishFirst) saved = await f.post({ operation: 'done', revision: saved.data.revision, itemId, itemVersion: saved.data.items.at(-1).version, values: {} });
    const before = saved.data;
    const item = before.items.find(item => item.id === itemId);
    const request = { operation: 'widget', revision: before.revision, itemId, itemVersion: item.version, values: { kind: example.kind, ...example.action } };
    const changed = await f.post(request);
    assert.equal(changed.ok, true, `${example.kind} action: ${changed.error}`);
    const reread = await f.get('journal');
    const persisted = reread.data.items.find(item => item.id === itemId);
    assert.deepEqual(persisted, changed.data.items.find(item => item.id === itemId));
    assert.equal(persisted.source.channel, 'web');
    assert.equal(persisted.source.text.includes('伪造来源'), false);
    example.verify(persisted, projectWidget(persisted, example.kind, { now: Date.parse(at) }));
    const stale = await f.post(request);
    assert.equal(stale.status, 409);
    assert.equal(stale.error, 'VERSION_CONFLICT');
  }
  const current = await f.get('journal');
  assert.equal(current.data.items.length, 20);
  const forbidden = await f.post({ operation: 'widget', revision: current.data.revision, scope: { account: 'local', userId: 'somebody-else' }, itemId: current.data.items[0].id, itemVersion: current.data.items[0].version, values: { kind: 'agenda', action: 'schedule', date: '2026-10-19T10:00:00Z' } });
  assert.equal(forbidden.status, 403);
  assert.equal((await f.post({ operation: 'design-result', revision: current.data.revision, values: { widgets: [] } })).status, 400);
  assert.equal((await f.post({ operation: 'add', revision: current.data.revision, values: { title: '跨站写入' } }, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await f.get('journal')).data.revision, current.data.revision);
  assert.equal(f.app.journal.store.snapshot({ account: 'a'.repeat(64), userId: 'fixture-owner' }).items.length, 0);
});

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('isolated designer did not reach the expected state');
}

test('the actual designer receives twenty capabilities and bounded materials, while hidden and pinned identities win over its proposal', async t => {
  const f = await fixture(t);
  const collection = Array.from({ length: 10 }, (_, index) => ({ id: `note-${index}`, title: `笔记 ${index}`, note: index === 0 ? '原文'.repeat(300) : '本人提供的材料' }));
  let state = f.store.mutate(LOCAL, { operation: 'add', revision: 0, values: { title: '周末预算与采购', taskType: 'budget', taskData: { budget: { total: 500, lines: [{ id: 'food', label: '食材', amount: 200 }] }, shopping: { entries: [{ id: 'vegetables', name: '青菜', quantity: 300, unit: '克' }] }, collection: { entries: collection } } } });
  const id = state.items[0].id;
  state = f.store.mutate(LOCAL, { operation: 'preferences', revision: state.revision, values: { hidden: [`${id}:budget`], pinned: [`${id}:shopping`], order: [`${id}:shopping`, `${id}:collection`] } });
  const before = structuredClone(state.items);
  let offered;
  const designer = new JournalDesigner({ root: f.root, store: f.store, now: () => Date.parse(at), analyze: async (_role, text) => {
    offered = JSON.parse(text);
    return JSON.stringify({ widgets: [{ id: `${id}:budget`, itemId: id, kind: 'budget', emphasis: 'primary' }], reason: '优先展示本人记录的预算' });
  } });
  t.after(() => designer.stop());
  await designer.request(LOCAL);
  await until(() => f.store.snapshot(LOCAL).design.status === 'ready');
  assert.deepEqual(new Set(offered.capabilities.kinds), new Set(WIDGET_KINDS));
  assert.deepEqual(new Set(Object.keys(offered.capabilities.types)), new Set(WIDGET_KINDS));
  assert.deepEqual(new Set(offered.items[0].availableKinds), new Set(['budget', 'shopping', 'collection']));
  assert.equal(offered.items[0].taskDataPreview.collection.entries.length, 8);
  assert.equal(offered.items[0].taskDataPreview.collection.entries[0].note.length, 400);
  assert.equal(offered.items[0].source, undefined);
  assert.equal(offered.account, undefined);
  assert.equal(offered.userId, undefined);
  const result = f.open().snapshot(LOCAL);
  assert.deepEqual(result.items, before, 'selecting presentation cannot edit the full ledger materials');
  assert.equal(result.items[0].taskData.collection.entries.length, 10);
  assert.equal(result.items[0].taskData.collection.entries[0].note.length, 600);
  assert.equal(result.layout.source, 'agent');
  assert.equal(result.layout.widgets.some(widget => widget.id === `${id}:budget`), false);
  assert.equal(result.layout.widgets[0].id, `${id}:shopping`);
  assert.deepEqual(result.preferences, state.preferences);
});

test('new proposals accept each available modern structure and reject fabricated capabilities, identity changes or fact payloads', async t => {
  const f = await fixture(t);
  let state = f.store.snapshot(LOCAL);
  for (const example of examples) {
    state = f.store.mutate(LOCAL, { operation: 'add', revision: state.revision, values: { title: example.title, taskType: example.kind, taskData: { [example.kind]: example.data }, ...example.fields } });
    const item = state.items.at(-1);
    const widget = { id: `${item.id}:${example.kind}`, itemId: item.id, kind: example.kind };
    const proposal = { widgets: [widget], reason: '只选本人已有材料支持的结构' };
    assert.deepEqual(parseDesign(JSON.stringify(proposal), state), proposal);
    assert.throws(() => parseDesign(JSON.stringify({ ...proposal, widgets: [{ ...widget, data: { total: 999 } }] }), state), hasCode('INVALID_DESIGN'));
    assert.throws(() => parseDesign(JSON.stringify({ ...proposal, widgets: [{ ...widget, itemId: 'another-item', id: `another-item:${example.kind}` }] }), state), hasCode('INVALID_DESIGN'));
  }
  const simple = f.store.mutate(LOCAL, { operation: 'add', revision: state.revision, values: { title: '本人明确只要议程', taskType: 'agenda' } });
  const item = simple.items.at(-1);
  for (const kind of ['budget', 'delivery', 'documents', 'approval', 'focus', 'script']) {
    assert.throws(() => parseDesign(JSON.stringify({ widgets: [{ id: `${item.id}:${kind}`, itemId: item.id, kind }], reason: '与本人明确议程类型不兼容' }), simple), hasCode('INVALID_DESIGN'));
  }
  assert.throws(() => parseDesign(JSON.stringify({ widgets: [], reason: '清空看板', html: '<script>bad()</script>' }), simple), hasCode('INVALID_DESIGN'));
  assert.deepEqual(f.store.snapshot(LOCAL).items, simple.items);
});

test('a late layout response cannot undo a domain budget write or publish its old version after reopening', async t => {
  const f = await fixture(t);
  const state = f.store.mutate(LOCAL, { operation: 'add', revision: 0, values: { title: '改动中的预算', taskType: 'budget', taskData: { budget: { total: 500, lines: [{ id: 'food', label: '餐饮', amount: 200 }] } } } });
  const id = state.items[0].id;
  let release;
  const designer = new JournalDesigner({ root: f.root, store: f.store, now: () => Date.parse(at), analyze: async () => new Promise(resolve => { release = () => resolve(JSON.stringify({ widgets: [{ id: `${id}:budget`, itemId: id, kind: 'budget' }], reason: '旧版本预算布局' })); }) });
  t.after(() => designer.stop());
  await designer.request(LOCAL);
  await until(() => release);
  const saved = f.open().mutate(LOCAL, { operation: 'widget', revision: state.revision, itemId: id, itemVersion: state.items[0].version, values: { kind: 'budget', action: 'reserve', amount: 140 } });
  release();
  await until(() => designer.running.size === 0);
  const reread = f.open().snapshot(LOCAL);
  assert.deepEqual(reread.items, saved.items);
  assert.equal(reread.items[0].taskData.budget.reserve, 140);
  assert.equal(reread.layout.source, 'basic');
  assert.equal(reread.design.status, 'idle');
});

async function hubFixture(t, { queuedDesign = false } = {}) {
  const { AgentHub } = await import('../plugins/agent-hub/store.mjs');
  const { journalTool } = await import('../plugins/agent-hub/journal.mjs');
  const { createJournalControl } = await import('../plugins/webui/journal-control.mjs');
  const f = await fixture(t);
  const hub = new AgentHub(f.root, { now: () => Date.parse(at) });
  const pairing = hub.pair({ label: 'Isolated journal agent' });
  const conversation = hub.newConversation({ endpointId: pairing.endpointId });
  const prompt = '请记下周三晚上两位的生日准备，费用还没核对。';
  hub.submit({ conversationId: conversation.id, content: prompt, requestId: 'journal-fixture-input', source: { channel: 'weixin', account: 'a'.repeat(64), peer: 'fixture-owner' } });
  const job = hub.poll(pairing.token, { runnerId: 'journal-fixture-runner' }).job;
  assert.ok(job);
  const settings = { revision: 'journal-fixture', installed: true, agentCommand: 'unused-fixture-command', socket: join(f.root, 'no-real-agent.sock'), config: { agent: { provider: 'dsh' }, im: { provider: 'weixin', access_policy: 'allowlist', allow_from: ['fixture-owner'] }, proactive: { enabled: false, timezone: 'Asia/Shanghai' } } };
  if (queuedDesign) settings.config.agent.provider = 'codex';
  const journal = createJournalControl({ root: f.root, readSettings: async () => settings,
    ...(queuedDesign ? { runtimeFactory: async ({ store }) => ({ ready: true, request: async (scope, { revision }) => {
      store.mutate(scope, { operation: 'design-start', revision, values: { status: 'queued' } });
      return { accepted: true, status: 'queued' };
    }, stop: async () => {} }) } : {}),
    rpc: async () => ({ kind: 'pa', data: { protocol: 1, account: 'a'.repeat(64), users: [{ id: 'fixture-owner', tasks: [] }], journalAvailable: false, configRevision: settings.revision } }) });
  journal.store.now = () => Date.parse(at);
  t.after(async () => { await journal.close(); hub.close(); });
  const options = { hub, journal, read: async () => settings, token: pairing.token };
  const call = (args, callId = 'journal-fixture-call', overrides = {}) => journalTool({ ...options, input: { runId: job.id, lease: job.lease, callId, arguments: args, ...overrides } });
  return { ...f, hub, journal, journalTool, pairing, conversation, job, settings, prompt, options, call };
}

test('paired agent previews and adopts the same atomic parameter contract without manual ledger changes', async t => {
  const f = await hubFixture(t);
  const saved = await f.call({ operation: 'add', revision: 0, values: { title: '预算安排', taskData: { budget: { total: 600, lines: [{ id: 'cake', label: '蛋糕建议', amount: 120 }] } } } }, 'plan-add');
  const args = { revision: saved.revision, itemId: saved.item.id, itemVersion: saved.item.version, values: { parameters: { budgetTotal: 800 } } };
  const preview = await f.call({ operation: 'preview', ...args }, 'plan-preview');
  assert.equal(preview.saved, false);
  assert.equal(f.journal.store.snapshot(LOCAL).revision, saved.revision);
  const command = { ...args, operation: 'apply-preview', values: { ...args.values, previewHash: preview.preview.previewHash } };
  const result = await f.call(command, 'plan-adopt');
  assert.equal(result.saved, true);
  assert.equal(result.item.taskData.budget.total, 800);
  assert.equal(result.item.taskData.budget.lines[0].amount, 120);
  assert.deepEqual(await f.call(command, 'plan-adopt'), result);
  f.hub.put('run', { ...f.hub.get('run', f.job.id), lease: 'replaced' });
  await assert.rejects(f.call({ ...args, operation: 'preview' }, 'late-preview'), hasCode('FORBIDDEN'));
});

test('recommendation date checks respect absolute time, closed state and unknown dates', () => {
  const now = Date.parse('2026-10-16T10:00:00Z');
  assert.deepEqual(journalRecommendation({ status: 'planned', date: '2026-10-16T18:00:00+08:00' }, now), { eligible: false, reason: 'past_date' });
  assert.deepEqual(journalRecommendation({ status: 'active', date: '2026-10-16T18:00:01+08:00' }, now), { eligible: true, reason: 'upcoming' });
  for (const status of ['done', 'cancelled']) assert.deepEqual(journalRecommendation({ status, date: '2026-10-18T12:00:00Z' }, now), { eligible: false, reason: 'closed' });
  for (const date of [null, 'invalid']) assert.deepEqual(journalRecommendation({ status: 'planned', date }, now), { eligible: false, reason: 'date_unconfirmed' });
});

test('raw journal save receipts cross the native DSH lossless-JSON boundary with and without a design dispatch', async t => {
  for (const queuedDesign of [false, true]) {
    const f = await hubFixture(t, { queuedDesign });
    const saved = await f.call({ operation: 'add', revision: 0, values: { title: '原生回执校验', date: '2026-10-18T18:00:00+08:00', steps: [{ id: 'first', label: '核对材料', done: false }] } }, 'json-save');
    assert.equal(isJsonValue(saved), true, 'use DSH’s actual validator before JSON.stringify can silently erase undefined fields');
    assert.equal(saved.designRequest.accepted, queuedDesign);
    const current = await f.call({ operation: 'get', itemId: saved.item.id });
    const edited = await f.call({ ...current.writeTemplate, values: { date: '2026-10-25T18:00:00+08:00' } }, 'json-date-edit');
    assert.equal(isJsonValue(edited), true, 'a date-only edit has no design dispatch, but must remain valid native output');
    assert.equal(Object.hasOwn(edited, 'designRequest'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(edited)), edited);
    assert.equal(f.store.snapshot(LOCAL).items.length, 1);
  }
});

test('real journal reads exclude an elapsed plan without changing it, and explicit rescheduling restores eligibility', async t => {
  const f = await hubFixture(t);
  const saved = await f.call({ operation: 'add', revision: 0, values: { title: '旧聚餐', date: '2026-10-13T20:00:00+08:00', note: '只保留结果，不继续' } }, 'past-plan');
  const before = f.journal.store.snapshot(LOCAL);
  const listing = await f.call({ operation: 'list' });
  assert.deepEqual(listing.items[0].recommendation, { eligible: false, reason: 'past_date' });
  assert.equal(listing.now, Date.parse(at));
  const detail = await f.call({ operation: 'get', itemId: saved.item.id });
  assert.equal(detail.item.status, 'planned'); assert.equal(detail.recommendation.eligible, false);
  assert.deepEqual(f.journal.store.snapshot(LOCAL), before, 'read-time checks must not rewrite a past task');
  await f.call({ ...detail.writeTemplate, values: { date: '2026-10-18T20:00:00+08:00', note: '用户明确改期' } }, 'explicit-reschedule');
  const moved = await f.call({ operation: 'get', itemId: saved.item.id });
  assert.equal(moved.recommendation.eligible, true);
  assert.equal((await f.call({ operation: 'list' })).items.length, 1);
});

function configuredOrigin(t, value) {
  const original = process.env.PA_WEB_ORIGIN;
  t.after(() => { if (original === undefined) delete process.env.PA_WEB_ORIGIN; else process.env.PA_WEB_ORIGIN = original; });
  if (value === undefined) delete process.env.PA_WEB_ORIGIN; else process.env.PA_WEB_ORIGIN = value;
}

test('journal views use only a configured HTTP origin and encode reserved characters in an item deep link', () => {
  assert.deepEqual(journalView(undefined, 'https://journal.example.invalid:8443'), {
    label: '生活手账 → 我的手账', path: '/#journal', url: 'https://journal.example.invalid:8443/#journal',
  });
  const view = journalView('生日 / a?b#c%', 'http://journal.example.invalid:3883/');
  assert.deepEqual(view, {
    label: '生活手账 → 我的手账',
    path: '/#journal/%E7%94%9F%E6%97%A5%20%2F%20a%3Fb%23c%25',
    url: 'http://journal.example.invalid:3883/#journal/%E7%94%9F%E6%97%A5%20%2F%20a%3Fb%23c%25',
  });
  assert.equal(new URL(view.url).pathname, '/');
});

test('missing or unsafe public origins return a viewing label without guessing a localhost port or exposing origin credentials', t => {
  configuredOrigin(t, undefined);
  const fallback = { label: '生活手账 → 我的手账', path: '/#journal/item-a', url: null };
  assert.deepEqual(journalView('item-a'), fallback);
  for (const origin of [
    '', 'not-an-origin', 'file:///tmp/journal', 'javascript:alert(1)',
    'https://fixture-user:fixture-password@journal.example.invalid',
    'https://journal.example.invalid/private/',
    'https://journal.example.invalid/?token=fixture-token',
    'https://journal.example.invalid/#already-open',
  ]) assert.deepEqual(journalView('item-a', origin), fallback, origin);
  assert.equal(JSON.stringify(fallback).includes('127.0.0.1'), false);
});

test('a leased tool returns configured list/get/save viewing links outside the persistent birthday facts', async t => {
  configuredOrigin(t, 'https://journal.example.invalid:8443');
  const f = await hubFixture(t);
  const listed = await f.call({ operation: 'list' });
  assert.equal(listed.view.url, 'https://journal.example.invalid:8443/#journal');
  const saved = await f.call({ operation: 'add', revision: listed.revision, values: {
    title: '需要核对日期的生日准备', taskType: 'budget',
    taskData: { budget: { total: 500, lines: [{ id: 'food', label: '准备餐食', amount: 200 }] } },
  } }, 'configured-view-add');
  assert.equal(saved.saved, true);
  assert.equal(saved.view.url, `https://journal.example.invalid:8443/#journal/${saved.item.id}`);
  const beforeGet = f.open().snapshot(LOCAL);
  const got = await f.call({ operation: 'get', itemId: saved.item.id });
  assert.deepEqual(got.view, saved.view);
  assert.deepEqual(f.open().snapshot(LOCAL), beforeGet, 'reading a view must not update the ledger');
  const updated = await f.call({ ...got.writeTemplate, values: { note: '本人补充：先核对时间，尚未下单。' } }, 'configured-view-update');
  assert.equal(updated.saved, true); assert.deepEqual(updated.view, saved.view);
  const ledger = f.open().snapshot(LOCAL), item = ledger.items[0];
  assert.equal(Object.hasOwn(item, 'view'), false);
  assert.equal(Object.hasOwn(item.taskData, 'view'), false);
  assert.equal(item.note, '本人补充：先核对时间，尚未下单。');
  assert.equal(JSON.stringify(ledger).includes('journal.example.invalid'), false);
  assert.equal(JSON.stringify(ledger).includes('#journal'), false);
});

test('a successful leased receipt replay follows the current configured origin without another save or rewriting the old effect', async t => {
  configuredOrigin(t, 'https://first-journal.example.invalid');
  const f = await hubFixture(t);
  const args = { operation: 'add', revision: 0, values: { title: '幂等保存的生日准备' } };
  const saved = await f.call(args, 'view-replay');
  assert.equal(saved.view.url, `https://first-journal.example.invalid/#journal/${saved.item.id}`);
  const effectId = `journal:${f.job.id}:view-replay`, oldEffect = structuredClone(f.hub.get('effect', effectId));
  const oldLedger = f.open().snapshot(LOCAL);
  process.env.PA_WEB_ORIGIN = 'http://second-journal.example.invalid:3883';
  const replay = await f.call(args, 'view-replay');
  assert.equal(replay.saved, true);
  assert.equal(replay.view.url, `http://second-journal.example.invalid:3883/#journal/${saved.item.id}`);
  assert.deepEqual(replay.item, saved.item); assert.equal(replay.revision, saved.revision);
  assert.deepEqual(f.hub.get('effect', effectId), oldEffect, 'old receipts stay durable; only the returned viewing helper changes');
  assert.deepEqual(f.open().snapshot(LOCAL), oldLedger);
  assert.equal(f.store.snapshot(LOCAL).items.length, 1);
});

test('a leased get/save still succeeds with missing or invalid origins and supplies a label without persisting the viewing helper', async t => {
  configuredOrigin(t, undefined);
  const f = await hubFixture(t);
  const saved = await f.call({ operation: 'add', revision: 0, values: { title: '无公开地址时仍能保存的清单', steps: [{ id: 'keys', label: '带钥匙', done: false }] } }, 'no-origin-add');
  assert.equal(saved.saved, true); assert.equal(saved.view.url, null);
  assert.equal(saved.view.label, '生活手账 → 我的手账');
  assert.equal(saved.view.path, '/#journal/' + saved.item.id);
  process.env.PA_WEB_ORIGIN = 'https://fixture-user:fixture-password@journal.example.invalid/private/?token=fixture-token';
  const got = await f.call({ operation: 'get', itemId: saved.item.id });
  assert.equal(got.view.url, null); assert.equal(got.view.label, saved.view.label);
  const updated = await f.call({ ...got.writeTemplate, values: { note: '本人核对清单，未执行外部任务。' } }, 'unsafe-origin-update');
  assert.equal(updated.saved, true); assert.equal(updated.view.url, null);
  assert.deepEqual(updated.view, got.view);
  const text = JSON.stringify(f.open().snapshot(LOCAL));
  for (const forbidden of ['fixture-password', 'fixture-token', '#journal', '"view"']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('a leased Hub task saves the shared owner ledger with the real inbound source and an idempotent domain receipt', async t => {
  const f = await hubFixture(t);
  const listed = await f.call({ operation: 'list' });
  assert.deepEqual(new Set(listed.capabilities.kinds), new Set(WIDGET_KINDS));
  assert.deepEqual(new Set(Object.keys(listed.capabilities.types)), new Set(WIDGET_KINDS));
  assert.equal(listed.timezone, 'Asia/Shanghai');
  assert.equal(listed.workflowGuide, await readFile(new URL('../skills/xiaoman-setup/references/runtime-workflows.md', import.meta.url), 'utf8'), 'resumed tasks receive the shipped workflow resource through the authenticated list receipt');
  const args = { operation: 'add', revision: 0, values: { title: '从真实交代保存的生日预算', taskType: 'budget', taskData: { budget: { total: 500, lines: [{ id: 'food', label: '餐饮', amount: 200 }] } } } };
  const saved = await f.call(args, 'add-budget');
  assert.equal(saved.saved, true);
  assert.equal(saved.item.source.channel, 'weixin');
  assert.equal(saved.item.source.text, f.prompt);
  assert.equal(saved.item.source.at, at);
  assert.equal(f.store.snapshot(LOCAL).items[0].id, saved.item.id);
  assert.equal(f.store.snapshot({ account: 'a'.repeat(64), userId: 'fixture-owner' }).items.length, 0, 'new Hub records do not silently merge old per-user ledgers');
  const replayed = await f.call(args, 'add-budget');
  assert.deepEqual(replayed, saved);
  assert.equal(f.store.snapshot(LOCAL).items.length, 1);
  await assert.rejects(f.call({ ...args, values: { ...args.values, title: '同编号不同载荷' } }, 'add-budget'), hasCode('CONFLICT'));
  const got = await f.call({ operation: 'get', itemId: saved.item.id });
  assert.equal(got.item.taskData.budget.total, 500);
  assert.equal(got.design.status, 'idle');
  assert.equal(got.layoutSource, 'basic', 'an available basic projection is not a successful model design');
  const changed = await f.call({ operation: 'widget', revision: got.revision, itemId: got.item.id, itemVersion: got.item.version, values: { kind: 'budget', action: 'reserve', amount: 140 } }, 'reserve-budget');
  assert.equal(changed.saved, true);
  assert.equal(changed.item.taskData.budget.reserve, 140);
  assert.equal(projectWidget(f.open().snapshot(LOCAL).items[0], 'budget').data.remaining, 160);
  assert.deepEqual(await f.call({ operation: 'get', itemId: got.item.id }).then(result => result.item), changed.item);
});

test('Hub get reports a failed design and its basic layout without converting a saved item into model success', async t => {
  const f = await hubFixture(t);
  const saved = f.store.mutate(LOCAL, { operation: 'add', revision: 0, values: { title: '设计失败后仍已保存的生日' } });
  const started = f.store.mutate(LOCAL, { operation: 'design-start', revision: saved.revision, values: { status: 'running' } });
  f.store.mutate(LOCAL, { operation: 'design-failed', revision: started.revision, values: { token: started.design.token, baseRevision: started.design.baseRevision, layoutVersion: started.design.layoutVersion, errorCode: 'DESIGN_FAILED' } });
  const got = await f.call({ operation: 'get', itemId: saved.items[0].id });
  assert.equal(got.revision, saved.revision);
  assert.equal(got.design.status, 'failed');
  assert.equal(got.design.errorCode, 'DESIGN_FAILED');
  assert.equal(got.layoutSource, 'basic');
  const { primaryProjection, ...facts } = got.item;
  assert.deepEqual(facts, saved.items[0]);
  assert.equal(primaryProjection.empty, true);
  assert.ok(got.widgets.length > 0, 'fallback widgets remain usable without claiming ready');
  assert.equal((await f.call({ operation: 'list' })).design.status, 'failed');
  assert.equal(f.open().snapshot(LOCAL).design.status, 'failed');
});

test('Hub journal refuses model-selected scope/source, internal operations, missing versions and another endpoint or lease', async t => {
  const f = await hubFixture(t);
  const request = { operation: 'add', revision: 0, values: { title: '不可伪造来源' } };
  for (const args of [
    { ...request, scope: { account: 'local', userId: 'other' } },
    { ...request, values: { ...request.values, source: { channel: 'web', text: '伪造' } } },
    { ...request, values: { ...request.values, scope: LOCAL } },
  ]) await assert.rejects(f.call(args), hasCode('INVALID_INPUT'));
  const internalOperation = await f.call({ ...request, operation: 'design-result' }, 'internal-operation');
  assert.equal(internalOperation.saved, false);
  assert.equal(internalOperation.error.code, 'INVALID_INPUT');
  const missingVersion = await f.call({ operation: 'widget', revision: 0, itemId: 'unknown', values: { kind: 'budget', action: 'reserve', amount: 1 } }, 'missing-version');
  assert.equal(missingVersion.saved, false);
  assert.equal(missingVersion.error.code, 'INVALID_INPUT');
  await assert.rejects(f.call(request, ''), hasCode('INVALID_INPUT'));
  await assert.rejects(f.call(request, 'wrong-lease', { lease: 'not-the-granted-lease' }), hasCode('FORBIDDEN'));
  const other = f.hub.pair({ label: 'Other isolated endpoint' });
  await assert.rejects(f.journalTool({ ...f.options, token: other.token, input: { runId: f.job.id, lease: f.job.lease, callId: 'other-endpoint', arguments: request } }), hasCode('FORBIDDEN'));
  assert.equal(f.store.snapshot(LOCAL).items.length, 0);
  f.hub.cancel(f.job.id);
  await assert.rejects(f.call({ operation: 'list' }), hasCode('FORBIDDEN'));
  await assert.rejects(f.call(request), hasCode('FORBIDDEN'));
});

test('malformed real-world journal write shapes save nothing; get supplies a versioned values template and stale corrected writes still fail', async t => {
  const f = await hubFixture(t);
  const initial = f.store.mutate(LOCAL, { operation: 'add', revision: 0, values: { title: '生日预算等待本人校对', taskType: 'budget', taskData: { budget: { total: 400, lines: [{ id: 'known', label: '已知准备费用', amount: 50 }] } } } });
  const itemId = initial.items[0].id;
  const got = await f.call({ operation: 'get', itemId });
  assert.deepEqual(got.writeTemplate, { operation: 'update', revision: initial.revision, itemId, itemVersion: initial.items[0].version, values: {} });
  const malformed = [
    { operation: 'update', itemId, itemVersion: got.item.version, values: { note: '漏带revision的改期交代' } },
    { operation: 'widget', itemId, kind: 'budget', action: 'reserve', data: { amount: 140 } },
    { operation: 'widget', revision: got.revision, itemId, itemVersion: got.item.version, kind: 'budget', action: 'reserve', amount: 140 },
    { operation: 'widget', revision: got.revision, itemId, values: { kind: 'budget', action: 'reserve', amount: 140 } },
    { operation: 'add', values: { title: '缺版本不能新增的事项' } },
  ];
  for (const [index, args] of malformed.entries()) {
    const response = await f.call(args, `bad-shape-${index}`);
    assert.equal(response.saved, false);
    assert.equal(response.error.code, 'INVALID_INPUT');
    const correction = JSON.stringify(response);
    assert.match(correction, /revision/);
    assert.match(correction, /values/);
    const unchanged = f.open().snapshot(LOCAL);
    assert.equal(unchanged.revision, initial.revision);
    assert.deepEqual(unchanged.items, initial.items);
  }
  await assert.rejects(f.call(malformed[0], 'wrong-lease-bad-shape', { lease: 'not-the-granted-lease' }), hasCode('FORBIDDEN'));
  await assert.rejects(f.call({ ...malformed[0], scope: { account: 'local', userId: 'other' } }, 'forged-scope'), hasCode('INVALID_INPUT'));
  await assert.rejects(f.call({ ...malformed[0], values: { source: { kind: 'user', channel: 'web', text: '不可伪造' } } }, 'forged-source'), hasCode('INVALID_INPUT'));

  const correct = { ...structuredClone(got.writeTemplate), values: { note: '本人已核对取蛋糕时间，仍未下单。' } };
  const saved = await f.call(correct, 'correct-shape');
  assert.equal(saved.saved, true);
  assert.equal(saved.item.note, correct.values.note);
  assert.equal(saved.revision, initial.revision + 1);
  const fresh = await f.call({ operation: 'get', itemId });
  const widget = { ...structuredClone(fresh.writeTemplate), operation: 'widget', values: { kind: 'budget', action: 'reserve', amount: 140 } };
  const selected = await f.call(widget, 'correct-widget-shape');
  assert.equal(selected.saved, true);
  assert.equal(selected.item.taskData.budget.reserve, 140);
  assert.equal(projectWidget(f.open().snapshot(LOCAL).items[0], 'budget').data.remaining, 210);
  const beforeStale = f.store.snapshot(LOCAL);
  await assert.rejects(f.call(correct, 'stale-corrected-shape'), hasCode('VERSION_CONFLICT'));
  assert.equal(f.store.snapshot(LOCAL).revision, beforeStale.revision);
  assert.deepEqual(f.open().snapshot(LOCAL).items, beforeStale.items);
});

test('an interrupted cross-database write cannot be replayed even when the first business save is already durable', async t => {
  const f = await hubFixture(t);
  const realMutate = f.journal.mutate;
  let writes = 0;
  f.journal.mutate = async (...args) => {
    writes++;
    await realMutate(...args);
    throw Object.assign(new Error('Receipt interrupted after the SQLite commit'), { code: 'EXECUTION_UNCERTAIN' });
  };
  const args = { operation: 'add', revision: 0, values: { title: '已保存但回执中断的事项' } };
  await assert.rejects(f.call(args, 'interrupted'), hasCode('EXECUTION_UNCERTAIN'));
  assert.equal(f.open().snapshot(LOCAL).items.length, 1);
  f.journal.mutate = realMutate;
  await assert.rejects(f.call(args, 'interrupted'), hasCode('EXECUTION_UNCERTAIN'));
  assert.equal(writes, 1);
  assert.equal(f.store.snapshot(LOCAL).revision, 1);
  assert.equal(f.store.snapshot(LOCAL).items.length, 1);
  const listed = await f.call({ operation: 'list' });
  assert.equal(listed.totalItems, 1, 'the recovery path is a fresh read, not another write');
});

test('a pending Hub effect blocks a concurrent duplicate while the first domain save is unresolved', async t => {
  const f = await hubFixture(t);
  const realMutate = f.journal.mutate;
  let release;
  f.journal.mutate = async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return realMutate(...args);
  };
  const args = { operation: 'add', revision: 0, values: { title: '慢保存的唯一事项' } };
  const first = f.call(args, 'concurrent');
  await until(() => release);
  await assert.rejects(f.call(args, 'concurrent'), hasCode('EXECUTION_UNCERTAIN'));
  release();
  const result = await first;
  assert.equal(result.saved, true);
  assert.deepEqual(await f.call(args, 'concurrent'), result);
  assert.equal(f.open().snapshot(LOCAL).items.length, 1);
});

test('Hub list/get recheck the task lease after an asynchronous journal snapshot', async t => {
  for (const operation of ['list', 'get']) {
    const f = await hubFixture(t);
    const saved = f.store.mutate(LOCAL, { operation: 'add', revision: 0, values: { title: '授权撤回后不可再返回的材料' } });
    const realSnapshot = f.journal.snapshot;
    f.journal.snapshot = async (...args) => {
      const result = await realSnapshot(...args);
      f.hub.cancel(f.job.id);
      return result;
    };
    await assert.rejects(f.call({ operation, ...(operation === 'get' ? { itemId: saved.items[0].id } : {}) }), hasCode('FORBIDDEN'));
  }
});

test('a UTC server uses the configured Shanghai day for a bare habit through real HTTP, without overriding a recorded user timezone', async t => {
  const f = await fixture(t);
  const module = new URL('../plugins/webui/server.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { join } from 'node:path';
    import { createWebUI } from ${JSON.stringify(module)};
    const root = ${JSON.stringify(f.root)};
    const settings = { revision:'habit-midnight-fixture',installed:true,runtimeInstalled:true,socket:join(root,'unused.sock'),pending:[],capabilities:[],config:{owner:'测试',agent:{provider:'dsh'},im:{provider:'disabled',access_policy:'allowlist',allow_from:[]},proactive:{enabled:false,timezone:'Asia/Shanghai'}} };
    const app = createWebUI({root,helper:async()=>settings,rpc:async()=>({kind:'pa',data:{protocol:1,users:[],journalAvailable:false,configRevision:settings.revision}})});
    app.journal.store.now = () => Date.parse('2026-10-13T17:00:00Z');
    app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
    try {
      const origin='http://127.0.0.1:'+app.server.address().port;
      const home=await fetch(origin),cookie=home.headers.get('set-cookie').split(';')[0];
      const read=async()=>fetch(origin+'/api/state',{headers:{Cookie:cookie}}).then(r=>r.json());
      const csrf=(await read()).data.csrf;
      const post=async body=>fetch(origin+'/api/journal',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-PA-CSRF':csrf},body:JSON.stringify(body)}).then(r=>r.json());
      let saved=await post({operation:'add',revision:0,values:{title:'上海午夜的裸习惯',taskType:'habit'}}); assert.equal(saved.ok,true);
      const id=saved.data.items[0].id;
      const initial=saved.data.layout.widgets.find(w=>w.kind==='habit').projection;
      assert.equal(initial.data.today,'2026-10-14'); assert.equal(initial.data.timeZone,'Asia/Shanghai');
      saved=await post({operation:'widget',revision:saved.data.revision,itemId:id,itemVersion:saved.data.items[0].version,values:{kind:'habit',action:'check-in',date:'2026-10-14',done:true}}); assert.equal(saved.ok,true,saved.error);
      assert.deepEqual(saved.data.items[0].taskData.habit.dates,['2026-10-14']); assert.equal(saved.data.items[0].taskData.habit.timeZone,'Asia/Shanghai');
      const explicit=await post({operation:'add',revision:saved.data.revision,values:{title:'本人保存的洛杉矶习惯',taskType:'habit',taskData:{habit:{timeZone:'America/Los_Angeles'}}}}); assert.equal(explicit.ok,true);
      const explicitId=explicit.data.items.at(-1).id;
      assert.equal(explicit.data.layout.widgets.find(w=>w.itemId===explicitId&&w.kind==='habit').projection.data.today,'2026-10-13');
      console.log(JSON.stringify({serverZone:Intl.DateTimeFormat().resolvedOptions().timeZone,today:initial.data.today,storedZone:saved.data.items[0].taskData.habit.timeZone,explicitZone:explicit.data.items.at(-1).taskData.habit.timeZone}));
    } finally { await app.shutdown(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' }, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { serverZone: 'UTC', today: '2026-10-14', storedZone: 'Asia/Shanghai', explicitZone: 'America/Los_Angeles' });
});

test('thirty valid large items keep their identities and capabilities inside the total designer prompt budget, without truncating the ledger', async t => {
  const f = await fixture(t);
  const note = '本人提供的完整材料'.repeat(44);
  // Repeated primitive rows exercise size limits; they do not generate cases or
  // conclusions. The one authored scenario is the 30-item prompt boundary.
  const entries = Array.from({ length: 24 }, (_, index) => ({ id: `material-${index}`, title: '完整材料', note }));
  const documents = entries.map(({ id, note }) => ({ id, name: '本人整理的材料', state: 'provided', note }));
  let state = f.store.snapshot(LOCAL);
  for (let index = 0; index < 30; index++) {
    const request = { operation: 'add', revision: state.revision, values: { title: '材料很多的生活事项', taskType: 'collection', taskData: { collection: { entries }, documents: { entries: documents } } } };
    assert.ok(Buffer.byteLength(JSON.stringify(request)) < 65536, 'each valid record fits the existing HTTP payload limit');
    state = f.store.mutate(LOCAL, request);
  }
  const before = structuredClone(state.items);
  let offered, promptBytes;
  const designer = new JournalDesigner({ root: f.root, store: f.store, now: () => Date.parse(at), analyze: async (_role, text) => {
    promptBytes = Buffer.byteLength(text);
    offered = JSON.parse(text);
    const item = offered.items[0];
    return JSON.stringify({ widgets: [{ id: `${item.id}:collection`, itemId: item.id, kind: 'collection' }], reason: '只选择完整账本已有的收藏结构' });
  } });
  t.after(() => designer.stop());
  await designer.request(LOCAL);
  await until(() => f.store.snapshot(LOCAL).design.status === 'ready');
  assert.ok(promptBytes <= 128 * 1024, `actual serialized prompt was ${promptBytes} bytes`);
  assert.equal(offered.items.length, 30);
  assert.deepEqual(new Set(offered.items.map(item => item.id)), new Set(before.map(item => item.id)));
  for (const item of offered.items) {
    assert.equal(item.taskType, 'collection');
    assert.deepEqual(new Set(item.availableKinds), new Set(['collection', 'documents']));
  }
  const after = f.open().snapshot(LOCAL);
  assert.deepEqual(after.items, before);
  assert.equal(after.items[29].taskData.documents.entries.length, 24);
  assert.equal(after.items[29].taskData.collection.entries[23].note, note);
});

test('an automatic title-only item starts with one basic card and the actual model may select a lawful empty structure without inventing facts', async t => {
  const cases = [
    { title: '帮我准备妈妈的生日', kind: 'prep', verify(view) { assert.deepEqual(view.data.steps, []); assert.equal(view.actions.find(action => action.action === 'step').enabled, false); } },
    { title: '想开始每周散步', kind: 'habit', verify(view) { assert.equal(view.data.targetPerWeek, null); assert.deepEqual(view.data.dates, []); assert.deepEqual(view.actions.find(action => action.action === 'check-in').required, ['date', 'done']); } },
    { title: '帮我整理这次租房材料', kind: 'documents', verify(view) { assert.deepEqual(view.data.entries, []); assert.equal(view.actions.find(action => action.action === 'mark-document').enabled, false); } },
    { title: '周末预算怎么安排', kind: 'budget', verify(view) { assert.equal(view.data.total, null); assert.equal(view.data.remaining, null); assert.deepEqual(view.data.lines, []); assert.equal(view.actions.find(action => action.action === 'reserve').enabled, false); } },
  ];
  for (const example of cases) {
    const f = await fixture(t);
    const initial = f.store.mutate(LOCAL, { operation: 'add', revision: 0, values: { title: example.title } });
    const id = initial.items[0].id;
    assert.equal(initial.items[0].taskType, 'auto');
    assert.equal(initial.layout.widgets.length, 1, 'basic layout must not create eighteen empty cards');
    assert.equal(initial.layout.widgets[0].kind, 'agenda');
    let offered;
    const designer = new JournalDesigner({ root: f.root, store: f.store, now: () => Date.parse(at), analyze: async (_role, text) => {
      offered = JSON.parse(text);
      return JSON.stringify({ widgets: [{ id: `${id}:${example.kind}`, itemId: id, kind: example.kind, emphasis: 'primary' }], reason: '依据本人交代选结构，缺资料留待补充' });
    } });
    t.after(() => designer.stop());
    await designer.request(LOCAL);
    await until(() => f.store.snapshot(LOCAL).design.status === 'ready');
    const after = f.open().snapshot(LOCAL);
    assert.deepEqual(after.items, initial.items, 'selecting an empty structure is not a fact write');
    assert.equal(after.layout.widgets.length, 1);
    assert.equal(after.layout.widgets[0].kind, example.kind);
    assert.deepEqual(new Set(offered.items[0].availableKinds), new Set(WIDGET_KINDS.filter(kind => !['reflection', 'memory'].includes(kind))));
    const view = projectWidget(after.items[0], example.kind, { now: Date.parse(at), timeZone: 'Asia/Shanghai' });
    assert.equal(view.empty, true);
    assert.ok(view.missing.length > 0);
    example.verify(view);
    assert.equal(Object.hasOwn(after.items[0].taskData, example.kind), false);
    for (const kind of ['memory', 'reflection', 'script']) assert.throws(() => parseDesign(JSON.stringify({ widgets: [{ id: `${id}:${kind}`, itemId: id, kind }], reason: '未发生事项不能变成回忆' }), after), hasCode('INVALID_DESIGN'));
  }
});

const formValues = (item, changes = {}) => ({ title: item.title, kind: item.kind, taskType: item.taskType || 'auto', date: item.date, note: item.note, steps: structuredClone(item.steps), candidates: structuredClone(item.candidates), taskData: structuredClone(item.taskData || {}), ...changes });

test('a full HTTP editor preserves unchanged system fields, invalidates confirmation on a real reschedule and refuses their forgery', async t => {
  const f = await httpFixture(t);
  let response = await f.post({ operation: 'add', revision: 0, values: { title: '有确认和提醒计划的生日', taskType: 'approval', date: '2026-10-18T12:00:00Z', taskData: { approval: { summary: '本人核对的出门计划', amount: 0, scheduledAt: '2026-10-18T12:00:00Z' }, reminder: { at: '2026-10-18T12:00:00Z', minutesBefore: 30 } } } });
  assert.equal(response.ok, true);
  const itemId = response.data.items[0].id;
  const write = async (operation, values) => f.post({ operation, revision: response.data.revision, itemId, itemVersion: response.data.items[0].version, values });
  response = await write('widget', { kind: 'reminder', action: 'record-reminder', at: '2026-10-18T12:00:00Z', minutesBefore: 30 });
  assert.equal(response.ok, true);
  response = await write('widget', { kind: 'approval', action: 'confirm' });
  assert.equal(response.ok, true);
  const recorded = structuredClone(response.data.items[0]);
  const beforeRevision = response.data.revision;
  response = await write('update', formValues(recorded));
  assert.equal(response.ok, true);
  assert.equal(response.data.revision, beforeRevision);
  assert.equal(response.data.items[0].version, recorded.version);
  const omitted = formValues(response.data.items[0]);
  delete omitted.taskData.approval.confirmation;
  delete omitted.taskData.reminder.recordedAt;
  response = await write('update', omitted);
  assert.equal(response.ok, true);
  assert.equal(response.data.revision, beforeRevision);
  assert.deepEqual(response.data.items[0].taskData.approval.confirmation, recorded.taskData.approval.confirmation);
  assert.equal(response.data.items[0].taskData.reminder.recordedAt, recorded.taskData.reminder.recordedAt);
  const reordered = formValues(response.data.items[0]);
  reordered.taskData = Object.fromEntries(Object.entries(reordered.taskData).reverse().map(([kind, data]) => [kind, Object.fromEntries(Object.entries(data).reverse())]));
  response = await write('update', reordered);
  assert.equal(response.ok, true);
  assert.equal(response.data.revision, beforeRevision, 'object key order is not a business edit');
  response = await write('update', formValues(response.data.items[0], { date: '2026-10-19T12:00:00Z' }));
  assert.equal(response.ok, true);
  assert.equal(response.data.items[0].taskData.approval.confirmation, null);
  assert.equal(response.data.items[0].taskData.reminder.recordedAt, recorded.taskData.reminder.recordedAt);
  const rescheduled = structuredClone(response.data);
  const restored = formValues(rescheduled.items[0]);
  restored.taskData.approval.confirmation = recorded.taskData.approval.confirmation;
  const invalidConfirmation = await write('update', restored);
  assert.equal(invalidConfirmation.ok, false);
  assert.equal(invalidConfirmation.error, 'INVALID_TASK_DATA');
  const forged = formValues(rescheduled.items[0]);
  forged.taskData.reminder.recordedAt = '2026-10-13T01:00:00Z';
  const invalidRecordedAt = await write('update', forged);
  assert.equal(invalidRecordedAt.ok, false);
  assert.equal(invalidRecordedAt.error, 'INVALID_TASK_DATA');
  assert.deepEqual((await f.get('journal')).data.items, rescheduled.items);
  response = await write('done', {});
  assert.equal(response.ok, true);
  const doneForm = formValues(response.data.items[0], { note: '结束后补充体验' });
  doneForm.taskData.reflection = { rating: 4, text: '下次提前一点出门。' };
  response = await write('update', doneForm);
  assert.equal(response.ok, true);
  assert.equal(response.data.items[0].status, 'done');
  assert.equal(response.data.items[0].taskData.reflection.rating, 4);
  const completed = structuredClone(response.data);
  const forbiddenDate = await write('update', formValues(completed.items[0], { date: '2026-10-20T12:00:00Z' }));
  assert.equal(forbiddenDate.ok, false);
  assert.equal(forbiddenDate.error, 'INVALID_STATE');
  assert.deepEqual((await f.get('journal')).data.items, completed.items);
});

test('a full HTTP editor may add a note to a completed legacy item without rewriting its absent taskType, and cancelled records remain closed', async t => {
  const f = await httpFixture(t);
  const legacy = legacyState();
  f.app.journal.store.db.prepare('INSERT INTO journal_scopes(account,user_id,data) VALUES(?,?,?)').run(LOCAL.account, LOCAL.userId, JSON.stringify(legacy));
  let response = await f.get('journal');
  const travel = response.data.items.find(item => item.id === 'travel');
  assert.equal(Object.hasOwn(travel, 'taskType'), false);
  const saved = await f.post({ operation: 'update', revision: response.data.revision, itemId: travel.id, itemVersion: travel.version, values: formValues(travel, { note: '补记：回来后想起一起吃的那顿饭。' }) });
  assert.equal(saved.ok, true);
  const persisted = saved.data.items.find(item => item.id === travel.id);
  assert.equal(persisted.status, 'done');
  assert.equal(Object.hasOwn(persisted, 'taskType'), false);
  assert.equal(persisted.date, travel.date);
  assert.deepEqual(persisted.source, travel.source);
  const birthday = saved.data.items.find(item => item.id === 'birthday');
  const cancelled = await f.post({ operation: 'cancel', revision: saved.data.revision, itemId: birthday.id, itemVersion: birthday.version, values: {} });
  assert.equal(cancelled.ok, true);
  const item = cancelled.data.items.find(item => item.id === birthday.id);
  const rejected = await f.post({ operation: 'update', revision: cancelled.data.revision, itemId: item.id, itemVersion: item.version, values: formValues(item, { note: '取消后不能改材料' }) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'INVALID_STATE');
  assert.deepEqual((await f.get('journal')).data.items, cancelled.data.items);
});
