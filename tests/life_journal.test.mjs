import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { JournalStore } from '../plugins/life-journal/store.mjs';

const scope = { account: 'local', userId: 'owner' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pa-journal-test-'));
  const stores = [];
  const create = () => { const store = new JournalStore(root, { now: () => Date.parse('2026-10-12T10:00:00Z') }); stores.push(store); return store; };
  t.after(() => { stores.forEach(store => store.close()); rmSync(root, { recursive: true, force: true }); });
  return { root, create, store: create() };
}
const code = expected => error => error.code === expected;
function add(store, values = {}, target = scope) { return store.mutate(target, { operation: 'add', revision: store.snapshot(target).revision, values: { title: '妈妈生日', ...values } }); }
function change(store, operation, values = {}, extra = {}, target = scope) {
  const state = store.snapshot(target);
  return store.mutate(target, { operation, revision: state.revision, itemId: state.items[0]?.id, itemVersion: state.items[0]?.version, values, ...extra });
}
function result(store, widgets, extra = {}) {
  const state = store.snapshot(scope);
  return store.mutate(scope, { operation: 'design-result', revision: state.revision, values: { token: state.design.token, baseRevision: state.design.baseRevision, layoutVersion: state.design.layoutVersion, widgets, reason: '生日准备优先', ...extra } });
}

test('shared instances and a new process observe saved facts; revision CAS rejects lost updates', t => {
  const { store, create, root } = fixture(t);
  const second = create();
  const first = add(store, { date: '2026-10-18T12:00:00+08:00', note: '六个人' });
  assert.deepEqual(second.snapshot(scope), first);
  assert.throws(() => second.mutate(scope, { operation: 'update', revision: 0, itemId: first.items[0].id, values: { title: '过期修改' } }), code('VERSION_CONFLICT'));
  assert.throws(() => second.mutate(scope, { operation: 'update', revision: first.revision, itemId: first.items[0].id, itemVersion: 0, values: { title: '过期事项' } }), code('VERSION_CONFLICT'));
  const script = `import { JournalStore } from ${JSON.stringify(new URL('../plugins/life-journal/store.mjs', import.meta.url).href)}; const s = new JournalStore(${JSON.stringify(root)}); console.log(JSON.stringify(s.snapshot())); s.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), first);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.equal(first.items[0].date, '2026-10-18T04:00:00.000Z');
});

test('scope isolation applies to reads, writes, message dedup, and design binding', t => {
  const { store } = fixture(t);
  const a = { account: 'a'.repeat(64), userId: '妈妈' };
  const b = { account: 'b'.repeat(64), userId: '妈妈' };
  const state = add(store, {}, a);
  assert.equal(store.snapshot(b).items.length, 0);
  assert.throws(() => store.mutate(b, { operation: 'delete', revision: 0, itemId: state.items[0].id }), code('ITEM_NOT_FOUND'));
  assert.throws(() => store.snapshot({ account: 'a'.repeat(16), userId: 'owner' }), code('INVALID_SCOPE'));
  assert.throws(() => store.snapshot({ account: 'local', userId: '' }), code('INVALID_SCOPE'));
  store.ingest(a, { text: '/journal add 喝茶', messageId: 'm1' });
  store.ingest(b, { text: '/journal add 散步', messageId: 'm1' });
  assert.equal(store.snapshot(b).items.length, 1);
  assert.equal(store.listScopes().length, 2);
});

test('step and candidate selection affect actual objects; source remains unchanged; undo restores status', t => {
  const { store } = fixture(t);
  const initial = add(store, { status: 'active', steps: [{ id: 'cake', label: '取蛋糕', done: false }], candidates: [{ id: 'one', name: '草莓', selected: false }, { id: 'two', name: '巧克力', selected: false }] });
  change(store, 'step', { stepId: 'cake', done: true });
  let state = change(store, 'choose', { candidateId: 'two' });
  assert.equal(state.items[0].status, 'active');
  assert.equal(state.items[0].steps[0].done, true);
  assert.equal(state.items[0].candidates[1].selected, true);
  const revision = state.revision;
  state = change(store, 'step', { stepId: 'cake', done: true });
  assert.equal(state.revision, revision, 'no-op does not invalidate design or revision');
  assert.throws(() => change(store, 'update', { source: { text: '改原文' } }), code('INVALID_REQUEST'));
  assert.deepEqual(state.items[0].source, initial.items[0].source);
  change(store, 'done');
  assert.throws(() => change(store, 'update', { title: '改写已结束内容' }), code('INVALID_STATE'));
  state = change(store, 'undo');
  assert.equal(state.items[0].status, 'active');
  change(store, 'cancel');
  assert.equal(store.snapshot(scope).layout.widgets.length, 0);
  assert.equal(change(store, 'undo').items[0].status, 'active');
});

test('late design after business update, preferences, or deletion is rejected and cannot revive data', t => {
  const { store } = fixture(t);
  let state = add(store);
  const widget = { id: `${state.items[0].id}:focus`, kind: 'focus', itemId: state.items[0].id, emphasis: 'primary' };
  for (const operation of ['update', 'preferences', 'delete']) {
    if (!store.snapshot(scope).items.length) state = add(store);
    const queued = change(store, 'design-start', { status: 'queued' });
    const currentItem = store.snapshot(scope).items[0];
    change(store, operation, operation === 'update' ? { note: '改期后信息' } : operation === 'preferences' ? { hidden: [widget.id] } : {});
    const current = store.snapshot(scope);
    assert.throws(() => store.mutate(scope, { operation: 'design-result', revision: current.revision, values: { token: queued.design.token, baseRevision: queued.design.baseRevision, layoutVersion: queued.design.layoutVersion, widgets: [{ ...widget, id: `${currentItem.id}:focus`, itemId: currentItem.id }] } }), code('STALE_DESIGN'));
  }
  assert.equal(store.snapshot(scope).items.length, 0);
  assert.equal(store.snapshot(scope).layout.widgets.length, 0);
});

test('hidden wins over pinning, fixed cards survive design, ordering is retained, unsafe proposals fail atomically', t => {
  const { store } = fixture(t);
  let state = add(store, { steps: [{ id: 'cake', label: '取蛋糕', done: false }], date: '2026-10-18T10:00:00Z', candidates: [{ id: 'one', name: '草莓', selected: false }] });
  const id = state.items[0].id;
  const focus = `${id}:agenda`, checklist = `${id}:prep`, timeline = `${id}:decision`;
  state = change(store, 'preferences', { hidden: [focus], pinned: [checklist], order: [timeline, checklist] });
  assert.equal(state.layout.widgets[0].id, checklist);
  change(store, 'design-start');
  state = result(store, [{ id: timeline, kind: 'decision', itemId: id }, { id: focus, kind: 'agenda', itemId: id }]);
  assert.deepEqual(state.layout.widgets.map(widget => widget.id), [checklist, timeline]);
  assert.equal(state.layout.source, 'agent');
  state = change(store, 'update', { note: '普通更新' });
  assert.equal(state.layout.source, 'agent', 'normal refresh retains chosen layout');
  assert.deepEqual(state.layout.widgets.map(widget => widget.id), [checklist, timeline]);
  change(store, 'design-start');
  assert.throws(() => result(store, [{ id: 'new-id', kind: 'focus', itemId: id }]), code('INVALID_LAYOUT'));
  assert.throws(() => result(store, [{ id: 'else:focus', kind: 'focus', itemId: 'else' }]), code('INVALID_LAYOUT'));
  assert.throws(() => result(store, [{ id: `${id}:script`, kind: 'script', itemId: id }]), code('INVALID_LAYOUT'));
  assert.equal(store.snapshot(scope).design.status, 'running');
  assert.deepEqual(store.snapshot(scope).layout.widgets.map(widget => widget.id), [checklist, timeline]);
});

test('paused auto layout keeps facts editable and resumes with real basic widgets', t => {
  const { store } = fixture(t);
  change(store, 'preferences', { autoLayout: false, motion: 'reduced' });
  assert.throws(() => change(store, 'design-start'), code('AUTO_LAYOUT_PAUSED'));
  let state = add(store);
  assert.equal(state.items.length, 1);
  assert.equal(state.layout.widgets.length, 0);
  state = change(store, 'preferences', { autoLayout: true });
  assert.equal(state.layout.widgets.length, 1);
  assert.equal(state.layout.source, 'basic');
  assert.equal(state.preferences.motion, 'reduced');
});

test('durable queue token and atomic claim prevent two processes from owning same design', t => {
  const { store, create } = fixture(t);
  add(store);
  const queued = change(store, 'design-start', { status: 'queued' });
  const second = create();
  const repeated = change(second, 'design-start', { status: 'queued' });
  assert.equal(repeated.design.token, queued.design.token);
  const claimed = change(store, 'design-start', { status: 'running', token: queued.design.token, owner: process.pid });
  assert.equal(claimed.design.owner, process.pid);
  assert.throws(() => change(second, 'design-start', { status: 'running', token: queued.design.token }), code('DESIGN_ALREADY_RUNNING'));
  assert.equal(second.snapshot(scope).design.status, 'running');
  const failed = change(store, 'design-failed', { token: claimed.design.token, baseRevision: claimed.design.baseRevision, layoutVersion: claimed.design.layoutVersion, error: '模型暂不可用' });
  assert.equal(failed.design.status, 'failed');
  assert.equal(failed.items.length, 1);
  assert.equal(failed.layout.source, 'basic');
});

test('only explicit commands are retained; repeated messages and restart do not recreate deleted facts', t => {
  const { store, create } = fixture(t);
  const ignored = store.ingest(scope, { text: '周末去哪里玩？', messageId: 'chat' });
  assert.equal(ignored.accepted, false);
  assert.equal(store.snapshot(scope).revision, 0);
  let result = store.ingest(scope, { text: '/journal add 周末散步', messageId: 'm1' });
  assert.equal(result.snapshot.items[0].source.text, '/journal add 周末散步');
  assert.equal(result.snapshot.items[0].source.channel, 'weixin');
  change(store, 'delete');
  const restarted = create();
  result = restarted.ingest(scope, { text: '/journal add 周末散步', messageId: 'm1' });
  assert.equal(result.duplicate, true);
  assert.equal(result.snapshot.items.length, 0);
  assert.equal(result.snapshot.layout.widgets.length, 0);
  assert.throws(() => restarted.ingest(scope, { text: '/journal done not-found', messageId: 'bad' }), code('ITEM_NOT_FOUND'));
  result = restarted.ingest(scope, { text: '/journal add 修正后事项', messageId: 'bad' });
  assert.equal(result.accepted, true, 'failed command does not poison dedup');
});


test('parallel process writes serialize and reject the stale revision', async t => {
  const { store, root } = fixture(t);
  const state = add(store);
  const run = title => new Promise((resolve, reject) => {
    const script = `import { JournalStore } from ${JSON.stringify(new URL('../plugins/life-journal/store.mjs', import.meta.url).href)}; const s = new JournalStore(${JSON.stringify(root)}); try { s.mutate(undefined,{ operation:'add', revision:${state.revision},values:{title:${JSON.stringify(title)}}}); console.log('saved'); } catch(e){console.log(e.code);} s.close();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
    let output = ''; child.stdout.on('data', value => output += value);
    child.on('error', reject); child.on('close', status => status === 0 ? resolve(output.trim()) : reject(new Error('child failed')));
  });
  const results = await Promise.all([run('甲'), run('乙')]);
  assert.deepEqual(results.sort(), ['VERSION_CONFLICT', 'saved']);
  assert.equal(store.snapshot().items.length, 2);
});

test('selected candidate changes capability, invalid timestamps/URLs are rejected and public errors stay safe', t => {
  const { store } = fixture(t);
  assert.throws(() => add(store, { date: '2026-02-30T12:00:00Z' }), code('INVALID_REQUEST'));
  assert.throws(() => add(store, { candidates: [{ id: 'x', name: 'x', selected: false, url: 'javascript:alert(1)' }] }), code('INVALID_REQUEST'));
  const state = add(store, { candidates: [{ id: 'x', name: '草莓', selected: false }] });
  const selected = change(store, 'choose', { candidateId: 'x' });
  assert.ok(selected.layout.widgets.some(widget => widget.kind === 'waiting'));
  assert.ok(!selected.layout.widgets.some(widget => widget.kind === 'comparison'));
  const started = change(store, 'design-start');
  const failed = change(store, 'design-failed', { token: started.design.token, baseRevision: started.design.baseRevision, layoutVersion: started.design.layoutVersion, error: 'API_KEY=secret-cli-stderr', errorCode: 'MODEL_UNAVAILABLE' });
  assert.equal(failed.design.errorCode, 'MODEL_UNAVAILABLE');
  assert.ok(!JSON.stringify(failed).includes('secret-cli'));
  assert.equal(state.items.length, failed.items.length);
});

test('paused layout restores hidden AI widgets with their original presentation', t => {
  const { store, create } = fixture(t);
  const saved = add(store);
  change(store, 'design-start');
  const waiting = { id: `${saved.items[0].id}:waiting`, itemId: saved.items[0].id, kind: 'waiting', emphasis: 'quiet', reason: '等待用户确认' };
  result(store, [waiting]);
  change(store, 'preferences', { autoLayout: false });
  change(store, 'preferences', { hidden: [waiting.id] });
  assert.equal(store.snapshot().layout.widgets.length, 0);
  const restarted = create();
  const restored = change(restarted, 'preferences', { hidden: [] });
  assert.deepEqual(restored.layout.widgets, [waiting]);
  assert.ok(!Object.hasOwn(restored, '_hiddenWidgets'));
});

test('completed records allow evaluation notes while dates and cancelled records stay protected', t => {
  const { store } = fixture(t);
  add(store, { note: '准备材料' });
  const finished = change(store, 'done');
  const reviewed = change(store, 'update', { note: '蛋糕很好吃，下次提前两天预订' });
  assert.equal(reviewed.items[0].status, 'done');
  assert.equal(reviewed.items[0].version, finished.items[0].version + 1);
  assert.equal(reviewed.items[0].source.text, finished.items[0].source.text);
  assert.throws(() => change(store, 'update', { date: '2026-10-20T12:00:00Z' }), code('INVALID_STATE'));
  change(store, 'undo'); change(store, 'cancel');
  assert.throws(() => change(store, 'update', { note: '取消后改写' }), code('INVALID_STATE'));
});
