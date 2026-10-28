import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { saveBot, botTool, botSessionKey } from '../plugins/agent-hub/bots.mjs';
import { CONTEXT_TTL_MS, history } from '../plugins/agent-hub/continuity.mjs';
import { HubChannel } from '../plugins/agent-hub/channel.mjs';
import { AgentCompanion } from '../plugins/agent-hub/companion.mjs';

async function fixture(t, { connected = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mori-rooms-'));
  let now = 1_000_000;
  const hub = new AgentHub(root, { now: () => now }), token = 'room-fixture-token-12345678901234567890';
  if (connected) hub.registerHost({ id: 'dsh', label: 'Fixture', provider: 'dsh' }, token);
  const poll = () => hub.poll(token, { runnerId: 'rooms', routineGuardVersion: 1 }).job;
  const send = (conversationId, content, extra = {}) => hub.submit({ conversationId, content, requestId: crypto.randomUUID(), ...extra });
  const event = (job, seq, type, value) => hub.event(token, { runId: job.id, lease: job.lease, seq, type, value });
  t.after(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, hub, token, poll, send, event, advance: amount => { now += amount; }, now: () => now };
}
const values = { name: '阅读', handle: 'reader', avatar: 'research', instructions: '阅读用户指定材料' };

test('rooms open once without an execution connection and new Bots join only the shared room membership', async t => {
  const f = await fixture(t, { connected: false });
  assert.deepEqual(f.hub.snapshot().rooms, []); assert.equal(f.hub.snapshot().defaultRoomId, null);
  const group = f.hub.openRoom({ kind: 'group' }), direct = f.hub.openRoom({ kind: 'direct', botId: 'research' });
  assert.notEqual(group.id, direct.id); assert.equal(direct.endpointId, null);
  const other = new AgentHub(f.root); t.after(() => other.close());
  assert.equal(other.openRoom({ kind: 'group' }).id, group.id);
  assert.equal(other.openRoom({ kind: 'direct', botId: 'research' }).id, direct.id);
  const bot = saveBot(f.hub, { values });
  assert.ok(f.hub.snapshot().rooms.find(r => r.id === group.id).memberBotIds.includes(bot.id));
  assert.equal(f.hub.snapshot().defaultRoomId, group.id);
  assert.equal(f.hub.all('conversation').length, 2, 'snapshot and Bot creation do not manufacture private rooms');
  assert.throws(() => f.send(direct.id, '开始'), { code: 'BOT_CONNECTION_REQUIRED' });
});

test('room migration claims only the latest same-Bot owner history and preserves old and special-purpose IDs', async t => {
  const f = await fixture(t), make = () => f.hub.newConversation({ botId: 'research' });
  const older = make(); f.advance(10); const latest = make(); f.advance(10);
  const firstTask = make(); f.hub.put('firstTask', { id: 'guide', conversationId: firstTask.id }); f.advance(10);
  const routine = make(); f.hub.put('routine', { id: 'routine', conversationId: routine.id, botId: 'research' }); f.advance(10);
  const inbox = make(); f.hub.bind({ channel: 'weixin', account: 'fixture', peer: 'person', conversationId: inbox.id });
  const room = f.hub.openRoom({ kind: 'direct', botId: 'research' });
  assert.equal(room.id, latest.id);
  for (const old of [older, firstTask, routine, inbox]) assert.equal(f.hub.conversation(old.id).roomKey, undefined);
  assert.notEqual(f.hub.openRoom({ kind: 'group' }).id, latest.id);
  assert.notEqual(f.hub.openRoom({ kind: 'direct', botId: 'maker' }).id, latest.id);
  assert.equal(f.hub.openRoom({ kind: 'direct', botId: 'research' }).id, latest.id);
});

test('a group task freezes eligible Bots before later Bot creation', async t => {
  const f = await fixture(t), group = f.hub.openRoom({ kind: 'group' });
  f.send(group.id, '请团队处理'); const job = f.poll(), bot = saveBot(f.hub, { values });
  const input = arguments_ => ({ hub: f.hub, token: f.token, input: { runId: job.id, lease: job.lease, callId: 'team', arguments: arguments_ } });
  assert.ok(f.hub.openRoom({ kind: 'group' }).memberBotIds.includes(bot.id));
  assert.equal(botTool(input({ operation: 'list' })).bots.some(b => b.id === bot.id), false);
  assert.throws(() => botTool(input({ operation: 'delegate', botIds: [bot.id], instruction: '新增的成员处理' })), { code: 'FORBIDDEN' });
  f.event(job, 1, 'completed', '当前范围已处理');
});

test('24h idle expiry fences prompt, history and native sessions without deleting messages or refreshing on reads and duplicates', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'direct', botId: 'research' });
  const first = f.send(room.id, '旧上下文的私人材料', { requestId: 'first' });
  const old = f.poll(); f.event(old, 1, 'session', 'old-native'); f.event(old, 2, 'completed', '已阅读');
  f.advance(CONTEXT_TTL_MS - 1);
  assert.equal(f.hub.snapshot().rooms[0].context.expired, false);
  f.advance(1);
  const before = f.hub.snapshot().rooms[0].context;
  assert.equal(before.expired, true);
  assert.equal(f.send(room.id, '旧上下文的私人材料', { requestId: 'first' }).run.id, first.run.id);
  assert.deepEqual(f.hub.snapshot().rooms[0].context, before);
  const fresh = f.send(room.id, '今天的新问题'), job = f.poll();
  assert.notEqual(fresh.run.contextEpoch, first.run.contextEpoch); assert.equal(job.sessionId, null);
  assert.equal(JSON.stringify({ context: job.context, continuation: job.continuation }).includes('旧上下文'), false);
  assert.equal(history(f.hub, job, { operation: 'search', query: '旧上下文' }).total, 0);
  assert.throws(() => history(f.hub, job, { operation: 'get', messageId: first.message.id }), { code: 'ITEM_NOT_FOUND' });
  assert.ok(f.hub.snapshot().messages.some(m => m.id === first.message.id));
  assert.equal(f.hub.get('session', botSessionKey(first.run)).nativeSessionId, 'old-native');
});

test('Bot replies keep the root epoch across an idle boundary while later user work waits in its new epoch', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'group' });
  const first = f.send(room.id, '@research 旧任务核对后请 @maker 制作'), requester = f.poll();
  f.event(requester, 1, 'session', 'research-old-task');
  botTool({ hub: f.hub, token: f.token, input: { runId: requester.id, lease: requester.lease, callId: 'question', arguments: { operation: 'ask', botId: 'maker', message: '旧任务需要什么格式' } } });
  f.event(requester, 2, 'completed', '等待同事');
  f.advance(CONTEXT_TTL_MS + 1);
  const later = f.send(room.id, '后来的新授权资料');
  const reply = f.poll(); assert.equal(reply.botPhase, 'reply'); assert.equal(reply.contextEpoch, first.run.contextEpoch);
  assert.equal(JSON.stringify(reply).includes('后来的新授权资料'), false);
  assert.ok(reply.botMessages.some(message => message.body.includes('旧任务')));
  f.event(reply, 1, 'completed', '给出旧任务格式');
  const resumed = f.poll(); assert.equal(resumed.sessionId, 'research-old-task');
  assert.equal(resumed.contextEpoch, first.run.contextEpoch); f.event(resumed, 1, 'completed', '核对完成');
  f.event(f.poll(), 1, 'completed', '最终制作');
  const next = f.poll(); assert.equal(next.id, later.run.id); assert.equal(next.sessionId, null);
  assert.equal(JSON.stringify({ context: next.context, continuation: next.continuation, mailbox: next.botMessages }).includes('旧任务'), false);
});

test('owner journal items share one private native context and expired continuation restores only the selected item', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'direct', botId: 'research' });
  const a = f.send(room.id, 'A事项的原始材料', { journalItemId: 'A' }), jobA = f.poll();
  f.event(jobA, 1, 'session', 'native-A'); f.event(jobA, 2, 'completed', 'A事项已处理');
  const b = f.send(room.id, 'B事项的私有内容', { journalItemId: 'B' }), jobB = f.poll();
  assert.equal(jobB.sessionId, 'native-A'); f.event(jobB, 1, 'session', 'native-B'); f.event(jobB, 2, 'completed', 'B事项已处理');
  f.advance(CONTEXT_TTL_MS + 1);
  f.send(room.id, '继续A事项', { journalItemId: 'A' }); const next = f.poll();
  assert.equal(next.sessionId, null);
  assert.equal(history(f.hub, next, { operation: 'get', messageId: a.message.id }).message.text, 'A事项的原始材料');
  assert.throws(() => history(f.hub, next, { operation: 'get', messageId: b.message.id }), { code: 'ITEM_NOT_FOUND' });
  assert.equal(JSON.stringify({ context: next.context, continuation: next.continuation }).includes('B事项'), false);
  const snapshot = f.hub.snapshot();
  assert.deepEqual(snapshot.messages.find(m => m.id === a.message.id).journalItemIds, ['A']);
  assert.deepEqual(snapshot.messages.find(m => m.id === b.message.id).journalItemIds, ['B']);
});

test('channel bindings isolate peers from owner rooms and reject cross-peer history and commands', async t => {
  const f = await fixture(t), group = f.hub.openRoom({ kind: 'group' });
  const a = f.hub.bind({ channel: 'imessage', account: 'fixture', peer: 'A', conversationId: group.id });
  const b = f.hub.bind({ channel: 'imessage', account: 'fixture', peer: 'B', conversationId: group.id });
  assert.notEqual(a.conversationId, group.id); assert.notEqual(a.conversationId, b.conversationId);
  assert.equal(f.hub.bind({ channel: 'imessage', account: 'fixture', peer: 'A', conversationId: group.id }).conversationId, a.conversationId);
  assert.equal(f.hub.bind({ channel: 'imessage', account: 'fixture', peer: 'B', conversationId: a.conversationId }).conversationId, b.conversationId);
  assert.throws(() => f.send(a.conversationId, '冒用A范围', { source: { channel: 'imessage', account: 'fixture', peer: 'B' } }), { code: 'FORBIDDEN' });
  const channel = new HubChannel({ root: f.root, channel: 'imessage', account: 'fixture', allowed: () => true, autoFlush: false });
  t.after(() => channel.close()); channel.hub.now = f.now;
  await channel.receive({ peer: 'A', text: '/use ' + b.conversationId, requestId: 'forged-use' });
  assert.equal(f.hub.binding('imessage', 'fixture', 'A').conversationId, a.conversationId);
  assert.equal(f.hub.all('message').some(m => m.conversationId === b.conversationId), false);
});

test('IM reset keeps its room, history and in-flight work while clearing only subsequent model context', async t => {
  const f = await fixture(t), conversation = f.hub.newConversation({ botId: 'xiaoman' });
  f.hub.bind({ channel: 'weixin', account: 'fixture', peer: 'owner', conversationId: conversation.id });
  const channel = new HubChannel({ root: f.root, channel: 'weixin', account: 'fixture', allowed: () => true, autoFlush: false });
  t.after(() => channel.close()); channel.hub.now = f.now;
  await channel.receive({ peer: 'owner', text: '先前交代', requestId: 'before' }); const old = f.poll();
  f.event(old, 1, 'session', 'before-reset');
  await channel.receive({ peer: 'owner', text: '/reset', requestId: 'reset' });
  assert.equal(f.hub.binding('weixin', 'fixture', 'owner').conversationId, conversation.id);
  assert.equal(f.hub.get('run', old.id).status, 'running');
  await channel.receive({ peer: 'owner', text: '重置后的新交代', requestId: 'after' });
  f.event(old, 2, 'completed', '先前交代完成'); const next = f.poll();
  assert.equal(next.sessionId, null); assert.equal(JSON.stringify(next.continuation).includes('先前交代'), false);
  assert.ok(f.hub.all('message').some(m => m.text === '先前交代'));
  assert.equal(f.hub.all('conversation').length, 1);
});

test('legacy mixed-route migration retains old runs and routes their approvals and final result only to the original sender', async t => {
  const f = await fixture(t), old = f.hub.newConversation({ botId: 'xiaoman' });
  const source = peer => ({ channel: 'imessage', account: 'fixture', peer });
  const a = f.send(old.id, 'A的在途事项', { source: source('A') }), job = f.poll();
  f.send(old.id, 'B的旧事项', { source: source('B') });
  for (const peer of ['A', 'B']) f.hub.put('binding', { id: createHash('sha256').update(JSON.stringify(['imessage', 'fixture', peer])).digest('hex'), ...source(peer), conversationId: old.id, ownerId: 'owner' });
  f.event(job, 1, 'session', 'A-old-native');
  f.event(job, 2, 'approval', { id: 'old-A-approval', toolName: 'Shell', reason: '需要决定旧事项' });
  const channel = new HubChannel({ root: f.root, channel: 'imessage', account: 'fixture', allowed: () => true, autoFlush: false });
  t.after(() => channel.close()); channel.hub.now = f.now;
  await channel.receive({ peer: 'B', text: '/reject old-A-approval', requestId: 'foreign-approval' });
  assert.equal(f.hub.get('approval', 'old-A-approval').state, 'pending');
  await channel.receive({ peer: 'A', text: '/reject old-A-approval', requestId: 'own-approval' });
  const inboxA = f.hub.binding('imessage', 'fixture', 'A').conversationId, inboxB = f.hub.binding('imessage', 'fixture', 'B').conversationId;
  assert.notEqual(inboxA, old.id); assert.notEqual(inboxB, old.id); assert.notEqual(inboxA, inboxB);
  assert.equal(f.hub.get('approval', 'old-A-approval').state, 'rejected');
  assert.equal(f.hub.get('run', a.run.id).conversationId, old.id);
  f.event(job, 3, 'completed', '旧事项只回给A');
  const result = f.hub.all('delivery').filter(delivery => delivery.text === '旧事项只回给A');
  assert.equal(result.length, 1); assert.equal(result[0].source.peer, 'A');
  assert.ok(f.hub.all('message').some(message => message.conversationId === old.id && message.text === 'B的旧事项'));
  const oldB = f.poll(); assert.equal(oldB.sessionId, null);
  assert.equal(JSON.stringify({ context: oldB.context, continuation: oldB.continuation }).includes('A的在途事项'), false);
});

test('journal save receipts attribute an entire Bot task without attaching unrelated room messages', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'group' });
  const first = f.send(room.id, '@research 核实 @maker 制作'); f.event(f.poll(), 1, 'completed', '核实结果');
  const maker = f.poll();
  f.hub.put('effect', { id: 'journal:' + maker.id + ':save', state: 'done', result: { saved: true, item: { id: 'made-item', version: 1 } } });
  f.event(maker, 1, 'completed', '已保存');
  const unrelated = f.send(room.id, '无关的新交代'); f.event(f.poll(), 1, 'completed', '新交代完成');
  const snapshot = f.hub.snapshot();
  assert.deepEqual(snapshot.messages.find(m => m.id === first.message.id).journalItemIds, ['made-item']);
  assert.deepEqual(snapshot.messages.find(m => m.id === unrelated.message.id).journalItemIds, []);
  f.advance(CONTEXT_TTL_MS + 1);
  f.send(room.id, '继续已保存的事项', { journalItemId: 'made-item', requestId: 'continue-item' });
  assert.throws(() => f.send(room.id, '继续已保存的事项', { journalItemId: 'other-item', requestId: 'continue-item' }), { code: 'CONFLICT' });
  const continued = f.poll();
  assert.equal(history(f.hub, continued, { operation: 'get', messageId: first.message.id }).message.id, first.message.id);
  assert.throws(() => history(f.hub, continued, { operation: 'get', messageId: unrelated.message.id }), { code: 'ITEM_NOT_FOUND' });
});

test('the initial group manager dispatches work before the separate final summary contract applies', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'group' }), turns = [];
  f.send(room.id, '请让阿探核对给定材料，再由总管汇总', { botId: 'xiaoman' });
  const companion = new AgentCompanion({ config: { provider: 'dsh' }, statePath: join(f.root, 'manager-spool'),
    transport: async (operation, input) => operation === 'tool' && input.tool === 'xiaoman_bots' ? botTool({ hub: f.hub, token: f.token, input }) : f.hub[operation](f.token, input),
    provider: async (_config, prompt, context) => {
      const contract = prompt.slice(prompt.lastIndexOf('当前执行轮的目标与验收')), index = turns.length; turns.push(contract);
      if (index === 0) {
        assert.match(contract, /初始总管轮.*实际调用 delegate/s); assert.doesNotMatch(contract, /你是本次最终回报负责人/);
        const list = await context.callTool('xiaoman_bots', { operation: 'list' }, 'members');
        assert.ok(list.bots.some(bot => bot.id === 'research'));
        await context.callTool('xiaoman_report', { title: '材料核对', outcome: 'in_progress', summary: '交由阿探核对' }, 'progress');
        await context.callTool('xiaoman_bots', { operation: 'delegate', botIds: ['research'], instruction: '只核对给定材料' }, 'dispatch');
        return { text: '' };
      }
      if (index === 1) assert.match(contract, /完成当前 Bot 的职责分工/);
      else { assert.match(contract, /最终回报负责人/); assert.match(contract, /本轮仅汇总核对/); assert.doesNotMatch(contract, /初始总管轮/); }
      await context.callTool('xiaoman_report', { title: '材料核对', outcome: 'completed', summary: index === 1 ? '材料已核对' : '核对后的汇总' }, 'done');
      return { text: index === 1 ? '核对依据' : '最终汇总' };
    } });
  t.after(() => companion.stop());
  for (let index = 0; index < 3; index++) { await companion.tick(); await companion.execution; await companion.flush(); }
  assert.equal(turns.length, 3); assert.ok(f.hub.all('run').every(run => run.status === 'completed'));
  assert.equal(f.hub.all('run')[0].botYielded, true); assert.equal(f.hub.all('run')[2].botPhase, 'summary');
  assert.equal(f.hub.snapshot().runs[0].issue, null);
});

test('new Web execution through a legacy mixed room never imports both peers or an unscoped old Web summary', async t => {
  const f = await fixture(t), room = f.hub.newConversation({ botId: 'xiaoman' });
  const a = f.send(room.id, 'A PRIVATE_SCOPE', { source: { channel: 'imessage', account: 'fixture', peer: 'A' }, journalItemId: 'A' });
  f.event(f.poll(), 1, 'completed', 'A私有回报');
  const b = f.send(room.id, 'B PRIVATE_SCOPE', { source: { channel: 'imessage', account: 'fixture', peer: 'B' }, journalItemId: 'B' });
  f.event(f.poll(), 1, 'completed', 'B私有回报');
  const legacy = f.send(room.id, '旧Web历史').run, oldWeb = f.poll();
  f.event(oldWeb, 1, 'completed', 'LEGACY_WEB_MIXED_SUMMARY');
  const stored = f.hub.get('run', legacy.id); delete stored.sourceScope; f.hub.put('run', stored);
  f.hub.put('session', { id: botSessionKey(stored), nativeSessionId: 'old-mixed-web-session', lastRunId: stored.id });
  f.send(room.id, '新的普通Web消息'); const web = f.poll();
  assert.equal(web.sessionId, null);
  assert.equal(JSON.stringify({ context: web.context, continuation: web.continuation }).includes('PRIVATE_SCOPE'), false);
  assert.equal(JSON.stringify(web.continuation).includes('LEGACY_WEB_MIXED_SUMMARY'), false);
  assert.throws(() => history(f.hub, web, { operation: 'get', messageId: a.message.id }), { code: 'ITEM_NOT_FOUND' });
  f.event(web, 1, 'completed', '新Web自己的回报');
  f.send(room.id, '明确继续A事项', { journalItemId: 'A' }); const item = f.poll();
  assert.equal(history(f.hub, item, { operation: 'get', messageId: a.message.id }).message.id, a.message.id);
  assert.throws(() => history(f.hub, item, { operation: 'get', messageId: b.message.id }), { code: 'ITEM_NOT_FOUND' });
  f.event(item, 1, 'completed', 'A续办完成');
  f.send(room.id, 'A的新来信', { source: { channel: 'imessage', account: 'fixture', peer: 'A' } }); const inbound = f.poll();
  assert.equal(JSON.stringify(inbound.continuation).includes('LEGACY_WEB_MIXED_SUMMARY'), false);
  assert.equal(JSON.stringify(inbound.continuation).includes('B PRIVATE_SCOPE'), false);
});
