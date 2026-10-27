import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { bindRoutineScope } from '../plugins/agent-hub/routine-scope.mjs';
import { configureReachOut, reachOutPolicy } from '../plugins/proactive/reach-out.mjs';
import { managePersonalNotices, personalChannelPoll, personalNoticeCommand } from '../plugins/proactive/personal-notices.mjs';
import { normalizeRoutineNotification, syncRoutineNotices, routineNoticeSnapshot } from '../plugins/proactive/routine-notices.mjs';

const base = Date.parse('2026-10-27T10:00:00+08:00');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pa-routine-notices-')); let now = base;
  const hub = new AgentHub(root, { now: () => now });
  t.after(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
  const endpoint = hub.pair({ provider: 'codex', label: 'fixture' });
  const conversation = hub.newConversation({ endpointId: endpoint.endpointId });
  const pair = hub.pairChannel({ label: 'Test iMessage', peer: 'owner@example.test', botAddress: 'bot@example.test', conversationId: conversation.id });
  const ready = () => hub.channelStatus(pair.token, { ready: true, peer: 'owner@example.test', botAddress: 'bot@example.test', lastInboundAt: 0, pendingInputs: 0 });
  ready(); configureReachOut(hub, { revision: 0, mode: 'Active', timezone: 'Asia/Shanghai', min_gap_minutes: 5, max_daily: 20 });
  const create = (id = 'routine-1', notification = { channelId: null }) => hub.put('routine', { id, title: '项目巡查', version: 1, enabled: true, journalItemId: 'item-' + id, conversationId: conversation.id,
    notification: normalizeRoutineNotification(hub, notification), scope: { publicWeb: true, sources: [] }, createdAt: now });
  const run = (status, extra = {}, routineId = 'routine-1') => {
    now += 1000; ready();
    const routine = hub.get('routine', routineId);
    return hub.put('routineRun', { id: 'occurrence-' + now, routineId, version: routine.version, status, summary: '发现了一个新版本', facts: [{ key: 'release:1' }], createdAt: now - 500, finishedAt: now, reconciledAt: now, ...extra });
  };
  const sync = () => syncRoutineNotices(hub, { baseUrl: 'https://smallman.example.test/' });
  const poll = () => personalChannelPoll(hub, pair.token, { sourceAllowed: () => true }).delivery;
  return { hub, root, pair, conversation, ready, create, run, sync, poll, advance(ms) { now += ms; ready(); }, at(value) { now = Date.parse(value); ready(); } };
}

test('existing journal-only routines produce a durable node and no external candidate or send', t => {
  const f = fixture(t); const routine = f.create(); delete routine.notification; f.hub.put('routine', routine);
  f.run('published'); const snapshot = f.sync();
  assert.equal(snapshot.notices.length, 1); assert.equal(snapshot.notices[0].state, 'journal');
  assert.equal(snapshot.notices[0].href, '#journal/item-routine-1'); assert.equal(f.hub.all('delivery').length, 0);
  assert.equal(f.hub.all('reachOutCandidate').length, 0);
  f.sync(); assert.equal(f.hub.all('routineNotice').length, 1);
});

test('opt-in uses the verified owner binding, includes reason and item link, and cannot replay after unknown', t => {
  const f = fixture(t); f.create('routine-1', { channelId: f.pair.channelId }); f.run('published');
  const first = f.sync().notices[0]; assert.equal(first.state, 'queued'); assert.equal(first.blocked, null); assert.equal(f.hub.all('delivery').length, 1);
  const delivery = f.poll(); assert.equal(delivery.peer, 'owner@example.test');
  assert.match(delivery.text, /符合回报条件/); assert.match(delivery.text, /https:\/\/smallman.example.test\/#journal\/item-routine-1/);
  f.hub.channelAck(f.pair.token, { deliveryId: delivery.id, state: 'unknown' });
  f.sync(); assert.equal(f.poll(), null); assert.equal(f.hub.all('delivery').length, 1);
  assert.equal(routineNoticeSnapshot(f.hub).notices[0].state, 'unknown');
  const other = new AgentHub(f.root, { now: () => base + 1000 });
  try { syncRoutineNotices(other); assert.equal(other.all('delivery').length, 1); } finally { other.close(); }
});

test('quiet checks and duplicate facts never create another change reminder', t => {
  const f = fixture(t); f.create('routine-1', { channelId: f.pair.channelId });
  f.run('quiet'); f.sync(); assert.equal(f.hub.all('routineNotice').length, 0);
  f.run('published'); f.sync(); f.advance(6 * 60000); f.run('published'); f.sync();
  assert.equal(f.hub.all('routineNotice').length, 1); assert.equal(f.hub.all('delivery').length, 1);
});

test('two failed checks create one failure episode; repeats do not alert, recovery remains visible', t => {
  const f = fixture(t); f.create('routine-1', { channelId: f.pair.channelId });
  f.run('failed', { summary: '来源离线', error: 'SOURCE_UNAVAILABLE', facts: [] }); f.sync(); assert.equal(f.hub.all('routineNotice').length, 0);
  f.run('failed', { summary: '来源离线', facts: [] }); f.sync(); assert.equal(f.hub.all('routineNotice').length, 1);
  const failure = f.poll(); f.hub.channelAck(f.pair.token, { deliveryId: failure.id, state: 'sent' });
  f.advance(6 * 60000); f.run('failed'); f.sync(); assert.equal(f.hub.all('routineNotice').length, 1);
  f.run('quiet', { facts: [] }); f.sync(); assert.deepEqual(f.hub.all('routineNotice').map(row => row.kind), ['failed', 'recovered']);
  assert.match(f.poll().text, /恢复/);
});

test('a recovered check cancels an unsent failure instead of delivering stale bad news', t => {
  const f = fixture(t); f.create('routine-1', { channelId: f.pair.channelId });
  f.run('failed'); f.run('failed'); f.sync(); const delivery = f.hub.all('delivery')[0];
  f.run('quiet', { facts: [] }); f.sync();
  assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled'); assert.equal(f.poll(), null);
  assert.equal(routineNoticeSnapshot(f.hub).notices.at(-1).state, 'journal');
});

test('quiet hours and offline channels retain pending nodes, then recover through the shared gate', t => {
  const f = fixture(t); f.at('2026-10-27T23:00:00+08:00'); f.create('routine-1', { channelId: f.pair.channelId }); f.run('published');
  let notice = f.sync().notices[0]; assert.equal(notice.blocked, 'quiet_hours'); assert.equal(f.hub.all('delivery').length, 0);
  f.at('2026-10-28T09:01:00+08:00'); const channel = f.hub.get('channelEndpoint', f.pair.channelId); f.hub.put('channelEndpoint', { ...channel, ready: false });
  notice = f.sync().notices[0]; assert.equal(notice.blocked, 'channel_offline'); assert.equal(f.hub.all('delivery').length, 0);
  f.ready(); f.sync(); assert.ok(f.poll());
});

test('pause, end, expiry, rule edit and channel rebind invalidate queued reminders at claim time', t => {
  for (const change of [r => ({ ...r, enabled: false }), r => ({ ...r, endedAt: base + 1 }), r => ({ ...r, endsAt: base + 1 }), r => ({ ...r, version: r.version + 1 })]) {
    const f = fixture(t); f.create('routine-1', { channelId: f.pair.channelId }); f.run('published'); f.sync();
    const delivery = f.hub.all('delivery')[0]; f.hub.put('routine', change(f.hub.get('routine', 'routine-1')));
    assert.equal(f.poll(), null); assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
  }
  const f = fixture(t); f.create('routine-1', { channelId: f.pair.channelId }); f.run('published'); f.sync();
  const delivery = f.hub.all('delivery')[0], next = f.hub.newConversation({ endpointId: f.conversation.endpointId });
  f.hub.bind({ channel: 'imessage', account: f.pair.channelId, peer: 'owner@example.test', conversationId: next.id });
  assert.equal(f.poll(), null); assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
});

test('source revocation and account generation changes cancel pending sends using current authority', t => {
  for (const mutation of [item => ({ ...item, enabled: false, state: 'revoked' }), item => ({ ...item, generation: item.generation + 1 }), item => ({ ...item, account: 'different@example.test' })]) {
    const f = fixture(t); const directory = join(f.root, '.runtime/connections'); mkdirSync(directory, { recursive: true });
    const path = join(directory, 'state.sqlite'), db = new DatabaseSync(path); chmodSync(path, 0o600);
    db.exec('CREATE TABLE connections (id INTEGER PRIMARY KEY, data TEXT)');
    const item = { id: 'google', account: 'owner@example.test', provider: 'local', generation: 1, state: 'connected', enabled: true, permissions: [{ id: 'calendar', granted: true, verified: true }] };
    db.prepare('INSERT INTO connections VALUES(1,?)').run(JSON.stringify({ items: [item] }));
    const routine = f.create('routine-1', { channelId: f.pair.channelId });
    f.hub.put('routine', { ...routine, ...bindRoutineScope(f.hub, { publicWeb: false, sources: [{ operation: 'calendar_events' }] }) });
    f.run('published'); f.sync(); const delivery = f.hub.all('delivery')[0]; assert.ok(delivery);
    db.prepare('UPDATE connections SET data=? WHERE id=1').run(JSON.stringify({ items: [mutation(item)] })); db.close();
    assert.equal(f.poll(), null); assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
  }
});

test('source personal notices and routine nodes share budgets without bypassing each other’s opt-in policy', t => {
  const f = fixture(t); managePersonalNotices(f.hub, { operation: 'configure', enabled: true, channelId: f.pair.channelId, timezone: 'Asia/Shanghai' });
  managePersonalNotices(f.hub, { operation: 'offer', key: 'calendar-first', source: 'google-calendar', text: '日历变化', observedAt: base, expiresAt: base + 86400000 });
  f.create('routine-1', { channelId: f.pair.channelId }); f.run('published');
  assert.equal(f.sync().notices[0].blocked, 'cooldown'); assert.equal(f.hub.all('delivery').length, 1);
  f.advance(6 * 60000); managePersonalNotices(f.hub, { operation: 'configure', enabled: false }); f.sync();
  assert.equal(f.hub.all('delivery').length, 2, 'a routine-specific opt-in does not enable source recommendations');
  const delivery = f.poll(); assert.match(delivery.text, /项目巡查/);
});

test('digest keeps valid changes in its original unsent delivery when one permission changes', t => {
  const f = fixture(t); configureReachOut(f.hub, { revision: 1, mode: 'Digest' });
  f.create('routine-1', { channelId: f.pair.channelId }); f.create('routine-2', { channelId: f.pair.channelId });
  f.run('published', { summary: '有效事项有新版本' }); f.run('published', { summary: '即将停止的事项' }, 'routine-2');
  assert.equal(f.sync().notices[0].blocked, 'digest_wait'); assert.equal(f.hub.all('delivery').length, 0);
  f.advance(61 * 60000); f.sync(); assert.equal(f.hub.all('delivery').length, 1);
  f.hub.put('routine', { ...f.hub.get('routine', 'routine-2'), enabled: false });
  const delivery = f.poll(); assert.match(delivery.text, /有效事项有新版本/); assert.doesNotMatch(delivery.text, /即将停止的事项/);
  assert.equal(f.hub.all('delivery').length, 1); assert.equal(f.hub.all('reachOutAttempt').length, 1);
});

test('an unsent digest drops a recovered failure without losing another routine’s valid change', t => {
  const f = fixture(t); configureReachOut(f.hub, { revision: 1, mode: 'Digest' });
  f.create('routine-1', { channelId: f.pair.channelId }); f.create('routine-2', { channelId: f.pair.channelId });
  f.run('failed', { summary: '读取中断' }); f.run('failed', { summary: '读取中断' });
  f.run('published', { summary: '另一个事项的重要变化' }, 'routine-2'); f.sync(); f.advance(61 * 60000); f.sync();
  const original = f.hub.all('delivery')[0]; assert.match(original.text, /读取中断/);
  f.run('quiet', { facts: [] }); f.sync();
  const delivery = f.poll(); assert.equal(delivery.id, original.id); assert.match(delivery.text, /另一个事项的重要变化/); assert.doesNotMatch(delivery.text, /读取中断/);
  assert.equal(f.hub.all('reachOutAttempt').length, 1);
});

test('generic pause covers routines and source notices immediately; resume restores the previous mode without replaying old nodes', t => {
  const f = fixture(t); managePersonalNotices(f.hub, { operation: 'configure', enabled: true, channelId: f.pair.channelId });
  f.create('routine-1', { channelId: f.pair.channelId }); f.run('published'); f.sync();
  assert.match(personalNoticeCommand(f.hub, 'imessage', f.pair.channelId, 'owner@example.test', '暂停提醒'), /主动提醒已暂停/);
  assert.equal(reachOutPolicy(f.hub).mode, 'Off'); assert.equal(f.hub.all('delivery')[0].state, 'cancelled');
  assert.match(personalNoticeCommand(f.hub, 'imessage', f.pair.channelId, 'owner@example.test', '恢复提醒'), /Active/);
  f.sync(); assert.equal(f.poll(), null, 'pause followed by immediate resume cannot revive the previously queued message');
  f.advance(6 * 60000); f.run('published', { facts: [{ key: 'release:2' }] }); f.sync(); assert.ok(f.poll());
});

test('routine-only channel handles pause/resume and preserves Digest instead of silently switching to Active', t => {
  const f = fixture(t); f.create('routine-1', { channelId: f.pair.channelId }); configureReachOut(f.hub, { revision: 1, mode: 'Digest' });
  assert.equal(f.hub.get('personalNoticePolicy', 'owner'), null);
  assert.match(personalNoticeCommand(f.hub, 'imessage', f.pair.channelId, 'owner@example.test', '/pa off'), /暂停/);
  f.run('published'); f.sync(); assert.equal(f.poll(), null);
  assert.match(personalNoticeCommand(f.hub, 'imessage', f.pair.channelId, 'owner@example.test', '/pa on'), /Digest/);
  assert.equal(reachOutPolicy(f.hub).mode, 'Digest'); assert.equal(f.hub.get('personalNoticePolicy', 'owner'), null);
  assert.equal(personalNoticeCommand(f.hub, 'imessage', f.pair.channelId, 'stranger@example.test', '/pa off'), null);
});

test('resume does not claim success when no saved mode exists or settings changed during the pause', t => {
  const f = fixture(t); f.create('routine-1', { channelId: f.pair.channelId });
  configureReachOut(f.hub, { revision: 1, mode: 'Off' });
  assert.match(personalNoticeCommand(f.hub, 'imessage', f.pair.channelId, 'owner@example.test', '恢复提醒'), /仍处于关闭/);
  configureReachOut(f.hub, { revision: 2, mode: 'Gentle' });
  personalNoticeCommand(f.hub, 'imessage', f.pair.channelId, 'owner@example.test', '暂停提醒');
  configureReachOut(f.hub, { revision: 4, max_daily: 3 });
  assert.match(personalNoticeCommand(f.hub, 'imessage', f.pair.channelId, 'owner@example.test', '恢复提醒'), /仍处于关闭/);
  assert.equal(reachOutPolicy(f.hub).mode, 'Off');
});

test('normal replies remain available when routine notifications are gated or cancelled', t => {
  const f = fixture(t); f.create('routine-1', { channelId: f.pair.channelId }); f.run('published'); f.sync(); f.at('2026-10-27T23:00:00+08:00');
  const ordinary = f.hub.reply(f.conversation.id, '普通回复', { channel: 'imessage', account: f.pair.channelId, peer: 'owner@example.test' });
  assert.equal(f.poll().id, ordinary.id);
});

test('notification choices do not accept recipients, unsupported channels, unbound or non-owner routes', t => {
  const f = fixture(t);
  assert.throws(() => normalizeRoutineNotification(f.hub, { channelId: f.pair.channelId, peer: 'other@example.test' }), error => error.code === 'INVALID_INPUT');
  assert.throws(() => normalizeRoutineNotification(f.hub, { channelId: 'not-paired' }), error => error.code === 'ROUTINE_NOTIFICATION_CHANNEL_REQUIRED');
  const binding = f.hub.binding('imessage', f.pair.channelId, 'owner@example.test'); f.hub.put('binding', { ...binding, ownerId: 'other' });
  assert.throws(() => normalizeRoutineNotification(f.hub, { channelId: f.pair.channelId }), error => error.code === 'ROUTINE_NOTIFICATION_CHANNEL_REQUIRED');
});
