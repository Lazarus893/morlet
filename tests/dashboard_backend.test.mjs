import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { HubChannel } from '../plugins/agent-hub/channel.mjs';
import { WeixinHarnessBridge } from '../vendor/deepseek-harness-weixin/dist/index.js';
import { botTool, botSessionKey, saveBot } from '../plugins/agent-hub/bots.mjs';
import { createAgentCompanion } from '../plugins/agent-hub/companion.mjs';
import { CONTEXT_TTL_MS, history } from '../plugins/agent-hub/continuity.mjs';
import { journalReports } from '../plugins/webui/journal-reports.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'morlet-dashboard-'));
  let now = 2_000_000;
  const hub = new AgentHub(root, { now: () => now }), token = 'fixture-dashboard-token-123456789012345';
  hub.registerHost({ id: 'dsh', label: 'Fixture DSH', provider: 'dsh' }, token);
  const poll = (runnerId = 'one', capacity = 1) => hub.poll(token, { runnerId, capacity, routineGuardVersion: 1 }).job;
  const send = (conversationId, content, extra = {}) => hub.submit({ conversationId, content, requestId: crypto.randomUUID(), ...extra });
  const event = (job, type, value) => hub.event(token, { runId: job.id, lease: job.lease, seq: hub.get('run', job.id).seq + 1, type, value });
  const tool = (job, args, callId = 'plan') => botTool({ hub, token, input: { runId: job.id, lease: job.lease, callId, arguments: args } });
  t.after(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, hub, token, poll, send, event, tool, advance: value => { now += value; }, now: () => now };
}

test('six independent group contributions cover the frozen roster, start in two slots, and finish without an extra summary', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'group' });
  for (const [name, handle] of [['读书', 'reader'], ['校对', 'proofreader']]) saveBot(f.hub, { values: { name, handle, avatar: 'research', instructions: '完成自己的工作' } });
  const root = f.send(room.id, '每人独立介绍自己').run, initial = f.poll();
  const ids = f.hub.get('run', root.id).availableBotIds;
  assert.equal(ids.length, 6);
  assert.throws(() => f.tool(initial, { operation: 'delegate', botIds: ids.slice(0, 3), instruction: '独立介绍', mode: 'parallel', participantScope: 'all', participationOnly: true, requireSummary: false }), { code: 'BOT_ROSTER_INCOMPLETE' });
  const args = { operation: 'delegate', botIds: ids, instruction: '只介绍你自己', mode: 'parallel', participantScope: 'all', participationOnly: true, requireSummary: false };
  f.tool(initial, args); f.tool(initial, args);
  f.event(initial, 'yielded', { operation: 'delegate' });
  assert.equal(f.hub.all('run').length, 7);
  const first = f.poll('a', 2), second = f.poll('b', 2);
  assert.ok(first && second); assert.notEqual(first.botId, second.botId); assert.equal(f.poll('c', 2), null);
  assert.equal(first.groupParticipationOnly, true);
  f.event(second, 'completed', '第二位的个人发言');
  const third = f.poll('b', 2); assert.ok(third);
  f.event(first, 'completed', '第一位的个人发言'); f.event(third, 'completed', '第三位的个人发言');
  for (let job; (job = f.poll('a', 2));) f.event(job, 'completed', '其余成员的个人发言');
  const snapshot = f.hub.snapshot(room.id);
  assert.equal(snapshot.messages.filter(m => m.role === 'assistant').length, 6);
  assert.equal(snapshot.runs.some(run => run.botPhase === 'summary'), false);
  assert.equal(snapshot.rootTasks.length, 1); assert.equal(snapshot.rootTasks[0].state, 'completed');
  assert.equal(snapshot.rootTasks[0].participantSlots.length, 6);
  assert.ok(snapshot.rootTasks[0].participantSlots.every(slot => slot.state === 'completed'));
});

test('parallel capacity does not let later private work or a same-native turn overtake an unfinished task', async t => {
  const f = await fixture(t), a = f.hub.openRoom({ botId: 'research' }), b = f.hub.openRoom({ botId: 'maker' });
  const first = f.send(a.id, '第一件事'), later = f.send(a.id, '同一Bot后来的事'), independent = f.send(b.id, '另一Bot独立工作');
  const one = f.poll('one', 2), two = f.poll('two', 2);
  assert.equal(one.id, first.run.id); assert.equal(two.id, independent.run.id);
  f.event(two, 'completed', '独立工作完成'); assert.equal(f.poll('two', 2), null);
  f.event(one, 'completed', '第一件事完成'); assert.equal(f.poll('one', 2).id, later.run.id);
});

for (const channel of ['web', 'imessage']) test(`one independent ${channel} group participant can fail without cancelling peers or concealing its missing contribution`, async t => {
  const f = await fixture(t), room = channel === 'web' ? f.hub.openRoom({ kind: 'group' }) : f.hub.newConversation({ botId: 'xiaoman' });
  const source = channel === 'web' ? { channel } : { channel, account: 'fixture', peer: 'owner' };
  const submitted = f.send(room.id, '请每位各自介绍', { source }), initial = f.poll();
  const ids = f.hub.get('run', submitted.run.id).availableBotIds;
  f.tool(initial, { operation: 'delegate', botIds: ids, instruction: '只介绍自己', mode: 'parallel', participantScope: 'all', participationOnly: true, requireSummary: false });
  f.event(initial, 'yielded', { operation: 'delegate' });
  const failing = f.poll('one', 2), surviving = f.poll('two', 2);
  f.event(failing, 'failed', 'AGENT_RATE_LIMITED');
  assert.equal(f.hub.get('run', surviving.id).status, 'running'); assert.equal(f.hub.get('run', submitted.run.id).botTaskStopped, undefined);
  assert.equal(f.hub.get('botMessage', failing.botMessageId).state, 'failed');
  const duplicate = f.hub.event(f.token, { runId: failing.id, lease: failing.lease, seq: 1, type: 'failed', value: 'AGENT_RATE_LIMITED' }); assert.equal(duplicate.duplicate, true);
  f.event(surviving, 'completed', '独立成员已介绍');
  for (let job; (job = f.poll('one', 2));) f.event(job, 'completed', '其他成员已介绍');
  const snapshot = f.hub.snapshot(room.id), task = snapshot.rootTasks[0];
  assert.equal(task.state, 'partial'); assert.equal(task.participantSlots.filter(slot => slot.state === 'completed').length, ids.length - 1);
  assert.equal(task.participantSlots.filter(slot => slot.state === 'failed').length, 1); assert.ok(task.issue);
  assert.equal(snapshot.runs.some(run => run.status === 'cancelled' || run.botPhase === 'summary'), false);
  assert.equal(f.hub.get('run', submitted.run.id).groupPlanState, 'partial');
  assert.equal(f.hub.all('run').length, ids.length + 1, 'failure is never silently retried');
  const deliveries = f.hub.all('delivery'); assert.equal(deliveries.length, channel === 'web' ? 0 : 2, 'only immediate failure and one final group result may leave IM');
  if (channel !== 'web') { assert.ok(deliveries.every(row => row.source.peer === 'owner')); assert.match(deliveries.at(-1).text, /限流/); }
});

test('a failed dependency still cancels the unfinished collaborative chain', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'group' }); f.send(room.id, '先研究再制作');
  const initial = f.poll(); f.tool(initial, { operation: 'delegate', botIds: ['research', 'maker'], instruction: '前后依赖', mode: 'sequential', participantScope: 'selected', participationOnly: false, requireSummary: true });
  f.event(initial, 'yielded', { operation: 'delegate' }); const research = f.poll(); f.event(research, 'failed', 'AGENT_RATE_LIMITED');
  assert.equal(f.hub.get('run', initial.id).botTaskStopped, 'AGENT_RATE_LIMITED'); assert.equal(f.poll(), null);
  assert.equal(f.hub.snapshot(room.id).rootTasks[0].state, 'failed');
});

test('owner verification shares real private context across transports and journals while returning only through the original route', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ botId: 'xiaoman' });
  const a = f.hub.bind({ channel: 'imessage', account: 'fixture', peer: 'owner-a', conversationId: room.id });
  const b = f.hub.bind({ channel: 'weixin', account: 'fixture', peer: 'owner-b', conversationId: room.id });
  const stranger = f.hub.bind({ channel: 'imessage', account: 'fixture', peer: 'other-person', conversationId: room.id });
  f.hub.verifyOwnerRoute(a.id); f.hub.verifyOwnerRoute(b.id);
  assert.equal(f.hub.binding('imessage', 'fixture', 'owner-a').conversationId, room.id);
  assert.ok((await readdir(join(f.root, '.runtime/hub/identity-backups'))).length === 2);
  const first = f.send(room.id, 'Web给出的准确材料', { journalItemId: 'A' }), one = f.poll();
  f.event(one, 'session', 'shared-owner-native'); f.event(one, 'completed', 'Web结果');
  const second = f.send(a.conversationId, '@mori 换端继续同一事项', { journalItemId: 'B', source: { channel: 'imessage', account: 'fixture', peer: 'owner-a' } }), two = f.poll();
  assert.equal(second.run.conversationId, room.id); assert.equal(two.sessionId, 'shared-owner-native');
  assert.equal(botSessionKey(first.run), botSessionKey(second.run));
  assert.equal(history(f.hub, two, { operation: 'get', messageId: first.message.id }).message.text, 'Web给出的准确材料');
  f.event(two, 'completed', '只回原来的iMessage');
  const deliveries = f.hub.all('delivery'); assert.equal(deliveries.length, 1); assert.equal(deliveries[0].source.peer, 'owner-a');
  f.send(b.conversationId, '@mori 微信继续', { source: { channel: 'weixin', account: 'fixture', peer: 'owner-b' } }); const three = f.poll(); assert.equal(three.sessionId, 'shared-owner-native'); f.event(three, 'completed', '微信回报');
  f.send(stranger.conversationId, '另一个联系人的消息', { source: { channel: 'imessage', account: 'fixture', peer: 'other-person' } }); const separate = f.poll();
  assert.equal(separate.sessionId, null); assert.equal(JSON.stringify(separate.continuation).includes('Web给出的准确材料'), false); f.event(separate, 'completed', '独立结果');
  assert.equal(f.hub.messageById(second.message.id).resolvedConversationId, room.id);
  f.hub.verifyOwnerRoute(a.id, false);
  const revoked = f.hub.binding('imessage', 'fixture', 'owner-a'); assert.notEqual(revoked.conversationId, room.id);
  f.send(revoked.conversationId, '撤销后', { source: { channel: 'imessage', account: 'fixture', peer: 'owner-a' } }); const isolated = f.poll();
  assert.equal(isolated.sessionId, null); assert.equal(JSON.stringify(isolated.continuation).includes('Web给出的准确材料'), false);
});

test('owner migration refuses in-flight work and ambiguous peers; old exact message links remain resolvable', async t => {
  const f = await fixture(t), room = f.hub.openRoom({}), binding = f.hub.bind({ channel: 'imessage', account: 'fixture', peer: 'A', conversationId: room.id });
  const old = f.send(binding.conversationId, '旧来信', { source: { channel: 'imessage', account: 'fixture', peer: 'A' } });
  assert.throws(() => f.hub.verifyOwnerRoute(binding.id), { code: 'OWNER_ROUTE_BUSY' });
  f.event(f.poll(), 'completed', '旧回报'); f.hub.verifyOwnerRoute(binding.id);
  const linked = f.hub.messageById(old.message.id); assert.equal(linked.message.sourceRef.messageId, old.message.id); assert.equal(linked.resolvedConversationId, room.id);
  assert.ok(f.hub.snapshot(room.id).messages.some(message => message.id === old.message.id));
  const another = f.hub.newConversation({ botId: 'xiaoman' });
  const mixed = f.hub.bind({ channel: 'weixin', account: 'fixture', peer: 'A', conversationId: another.id });
  f.hub.message(another.id, 'user', '另一人旧来信', { channel: 'weixin', account: 'fixture', peer: 'B' });
  assert.throws(() => f.hub.verifyOwnerRoute(mixed.id), { code: 'OWNER_ROUTE_MIXED' });
});

test('verified owner IM routes no mention to the shared group, one mention to private, and several mentions to named group work', async t => {
  const f = await fixture(t), manager = f.hub.openRoom({ botId: 'xiaoman' });
  for (const [channel, peer] of [['imessage', 'phone-owner'], ['weixin', 'wechat-owner']]) {
    const binding = f.hub.bind({ channel, account: 'fixture', peer, conversationId: manager.id }); f.hub.verifyOwnerRoute(binding.id);
  }
  const makeChannel = (channel, peer) => {
    const ingress = new HubChannel({ root: f.root, channel, account: 'fixture', allowed: value => value === peer, send: async () => assert.fail('must not send'), autoFlush: false });
    ingress.hub.now = f.now; t.after(() => ingress.close()); return ingress;
  };
  const imessage = makeChannel('imessage', 'phone-owner'), weixin = makeChannel('weixin', 'wechat-owner');
  await imessage.receive({ peer: 'phone-owner', text: '请总管安排这件事', requestId: 'im-group' });
  const first = f.poll(), group = f.hub.openRoom({ kind: 'group' });
  assert.equal(first.conversationId, group.id); assert.equal(first.botId, 'xiaoman'); assert.equal(first.ownerIdentityId, 'owner');
  f.event(first, 'session', 'one-shared-group-session'); f.event(first, 'completed', '第一件事的回报');
  await weixin.receive({ peer: 'wechat-owner', text: '从微信接着说刚才那件事', requestId: 'wx-group' });
  const second = f.poll(); assert.equal(second.conversationId, group.id); assert.equal(second.sessionId, 'one-shared-group-session');
  assert.equal(history(f.hub, second, { operation: 'get', messageId: first.messageId }).message.text, '请总管安排这件事'); f.event(second, 'completed', '第二件事的回报');
  const researchRoom = f.hub.openRoom({ botId: 'research' }); f.send(researchRoom.id, '私聊里已有的材料'); const privateWeb = f.poll();
  f.event(privateWeb, 'session', 'one-shared-research-private'); f.event(privateWeb, 'completed', '私聊已收到');
  await imessage.receive({ peer: 'phone-owner', text: '@research 请核对私聊材料', requestId: 'im-private' });
  const direct = f.poll(); assert.equal(direct.conversationId, researchRoom.id); assert.equal(direct.sessionId, 'one-shared-research-private');
  assert.throws(() => history(f.hub, direct, { operation: 'get', messageId: first.messageId }), { code: 'ITEM_NOT_FOUND' }); f.event(direct, 'completed', '阿探私聊回报');
  await weixin.receive({ peer: 'wechat-owner', text: '@research @maker 请依次核对并整理', requestId: 'wx-multi' });
  const named = f.poll(); assert.equal(named.conversationId, group.id); assert.equal(named.botId, 'research'); assert.deepEqual(named.pendingBotIds, ['maker']);
  assert.equal(named.sessionId, null, 'group and private native sessions stay separate');
  const before = f.hub.all('delivery').length; f.event(named, 'completed', '阿探分工完成'); assert.equal(f.hub.all('delivery').length, before);
  const maker = f.poll(); assert.equal(maker.botId, 'maker'); assert.equal(maker.conversationId, group.id); f.event(maker, 'completed', '阿造最终回报');
  const deliveries = f.hub.all('delivery');
  assert.deepEqual(deliveries.map(row => [row.source.channel, row.source.peer]), [['imessage', 'phone-owner'], ['weixin', 'wechat-owner'], ['imessage', 'phone-owner'], ['weixin', 'wechat-owner']]);
  assert.equal(f.hub.snapshot().rooms.filter(room => room.kind === 'group').length, 1);
  const outsider = f.hub.bind({ channel: 'imessage', account: 'fixture', peer: 'outsider', conversationId: manager.id });
  f.send(outsider.conversationId, '另一个联系人的话', { source: { channel: 'imessage', account: 'fixture', peer: 'outsider' } }); const isolated = f.poll();
  assert.notEqual(isolated.conversationId, group.id); assert.notEqual(isolated.conversationId, manager.id); assert.equal(isolated.ownerIdentityId, undefined);
  assert.throws(() => history(f.hub, isolated, { operation: 'get', messageId: first.messageId }), { code: 'ITEM_NOT_FOUND' });
});

test('an accepted IM event keeps its receipt and original route after verification changes future no-mention routing', async t => {
  const f = await fixture(t), manager = f.hub.openRoom({}), binding = f.hub.bind({ channel: 'weixin', account: 'fixture', peer: 'owner', conversationId: manager.id });
  const input = { source: { channel: 'weixin', account: 'fixture', peer: 'owner' }, requestId: 'old-routing' };
  const old = f.send(binding.conversationId, '已接受的旧事件', input); f.event(f.poll(), 'completed', '旧回报'); f.hub.verifyOwnerRoute(binding.id);
  const before = f.hub.all('run').length, replay = f.send(binding.conversationId, '已接受的旧事件', input);
  assert.equal(replay.run.id, old.run.id); assert.equal(replay.run.conversationId, binding.conversationId); assert.equal(f.hub.all('run').length, before);
  assert.throws(() => f.send(binding.conversationId, '不同原话不能复用回执', input), { code: 'CONFLICT' });
});

test('an explicitly resumed group matter excludes other matters from both Hub history and its native session', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'group' });
  const a = f.send(room.id, 'A事项专属资料', { botId: 'maker', journalItemId: 'A' }); const first = f.poll();
  f.event(first, 'session', 'group-native-A'); f.event(first, 'completed', 'A处理完成');
  const b = f.send(room.id, 'B事项专属资料', { botId: 'maker', journalItemId: 'B' }); const second = f.poll();
  assert.equal(second.sessionId, null); f.event(second, 'session', 'group-native-B'); f.event(second, 'completed', 'B处理完成');
  f.send(room.id, '只继续A', { botId: 'maker', journalItemId: 'A' }); const resumed = f.poll();
  assert.equal(resumed.sessionId, 'group-native-A');
  assert.equal(history(f.hub, resumed, { operation: 'get', messageId: a.message.id }).message.text, 'A事项专属资料');
  assert.throws(() => history(f.hub, resumed, { operation: 'get', messageId: b.message.id }), { code: 'ITEM_NOT_FOUND' });
  assert.equal(JSON.stringify(resumed.continuation).includes('B事项专属资料'), false);
});

test('display uses trusted occurrence time with append ties while dedupe preserves receipt order and context epoch', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'group' }), binding = f.hub.bind({ channel: 'imessage', account: 'fixture', peer: 'A', conversationId: room.id }); f.hub.verifyOwnerRoute(binding.id);
  const source = { channel: 'imessage', account: 'fixture', peer: 'A' };
  const recent = f.send(room.id, '较晚发送先收到', { source: { ...source, occurredAt: f.now() - 100 }, requestId: 'one' }); f.event(f.poll(), 'completed', '回报'); f.advance(20);
  const delayed = f.send(room.id, '较早发送晚收到', { source: { ...source, occurredAt: f.now() - 1000 }, requestId: 'two' }); f.event(f.poll(), 'completed', '回报');
  const snapshot = f.hub.snapshot(room.id), user = snapshot.messages.filter(m => m.role === 'user');
  assert.deepEqual(user.map(m => m.id), [delayed.message.id, recent.message.id]); assert.ok(user[0].appendSeq > user[1].appendSeq);
  const context = f.hub.conversation(room.id).contextEpoch; f.advance(CONTEXT_TTL_MS + 1);
  const duplicate = f.send(room.id, '较早发送晚收到', { source: { ...source, occurredAt: 1 }, requestId: 'two' });
  assert.equal(duplicate.run.id, delayed.run.id); assert.equal(f.hub.conversation(room.id).contextEpoch, context);
  const future = f.send(room.id, '无效未来时间', { source: { ...source, occurredAt: f.now() + 3600000 } });
  const message = f.hub.messageById(future.message.id).message; assert.equal(message.occurredAt, null); assert.equal(message.effectiveAt, message.receivedAt);
});

test('the actual Weixin adapter preserves sent time, rejects strangers, and deduplicates late events before dispatch', async t => {
  const f = await fixture(t), room = f.hub.openRoom({ kind: 'group' });
  const binding = f.hub.bind({ channel: 'weixin', account: 'fixture', peer: 'owner', conversationId: room.id }); f.hub.verifyOwnerRoute(binding.id);
  const channel = new HubChannel({ root: f.root, channel: 'weixin', account: 'fixture', allowed: peer => peer === 'owner', send: async () => assert.fail('must not send'), autoFlush: false });
  channel.hub.now = f.now; t.after(() => channel.close());
  const bridge = new WeixinHarnessBridge({ logger: () => ({}) }, { cwd: f.root, approvalTimeoutMs: 100, responseTimeoutMs: 1000, maxSeenMessageIds: 100, accessPolicy: 'allowlist', allowFrom: ['owner'] });
  bridge.hub = channel;
  const message = (id, time, peer = 'owner') => ({ message_id: id, create_time_ms: time, from_user_id: peer, item_list: [{ type: 1, text_item: { text: '消息-' + id } }] });
  await bridge.dispatch(message(1, f.now() - 100), {}); f.advance(10);
  await bridge.dispatch(message(2, f.now() - 1000), {});
  await bridge.dispatch(message(2, 1), {});
  await bridge.dispatch(message(3, f.now() + 3600000), {});
  await bridge.dispatch(message(4, f.now(), 'stranger'), {});
  const messages = f.hub.snapshot(room.id).messages;
  assert.deepEqual(messages.map(row => row.text), ['消息-2', '消息-1', '消息-3']);
  assert.ok(messages[0].appendSeq > messages[1].appendSeq); assert.equal(messages[2].occurredAt, null);
  assert.equal(messages[0].origin.sourceMessageId, '2');
  assert.equal(f.hub.all('run').length, 3); assert.equal(f.hub.all('delivery').length, 0);
});

test('unique journal source and answer links refer to exact user and Bot messages, never matching repeated text', async t => {
  const f = await fixture(t), room = f.hub.openRoom({});
  const first = f.send(room.id, '同样的交代', { journalItemId: 'A' }), one = f.poll();
  f.hub.tool(f.token, { runId: one.id, lease: one.lease, callId: 'report-a', tool: 'xiaoman_report', arguments: { summary: 'A成果', outcome: 'completed' } }); f.event(one, 'completed', 'A成果');
  const second = f.send(room.id, '同样的交代', { journalItemId: 'B' }), two = f.poll();
  f.hub.tool(f.token, { runId: two.id, lease: two.lease, callId: 'report-b', tool: 'xiaoman_report', arguments: { summary: 'B成果', outcome: 'completed' } }); f.event(two, 'completed', 'B成果');
  const reports = journalReports(f.hub), answer = f.hub.all('message').findLast(m => m.runId === two.id);
  assert.equal(reports.get('A').originSourceRef.messageId, first.message.id); assert.equal(reports.get('B').originSourceRef.messageId, second.message.id);
  assert.equal(reports.get('B').sourceRef.messageId, answer.id); assert.notEqual(answer.id, second.message.id);
  assert.throws(() => f.hub.messageById('nonexistent'), { code: 'ITEM_NOT_FOUND' });
});

test('resolved historical failures are not reopened by task aggregation', async t => {
  const f = await fixture(t), room = f.hub.openRoom({});
  const failed = f.send(room.id, '先核对这件事'); f.event(f.poll(), 'failed', 'AGENT_UNAVAILABLE');
  const initial = f.hub.snapshot(room.id), issue = initial.runs.find(run => run.id === failed.run.id).issue;
  assert.equal(initial.rootTasks[0].state, 'failed'); assert.equal(issue.state, 'open');
  f.hub.resolveRunIssue({ runId: failed.run.id, conversationId: room.id, fingerprint: issue.fingerprint, decision: 'accept_limit' });
  f.send(room.id, '接受已知限制，完成能核对的部分'); f.event(f.poll(), 'completed', '当前范围已完成');
  const tasks = f.hub.snapshot(room.id).rootTasks;
  assert.equal(tasks[0].state, 'resolved'); assert.equal(tasks[0].issue, null); assert.equal(tasks[1].state, 'completed');
});

test('companion pool keeps two leases, tool calls, cancellation and event spools independent', async t => {
  const f = await fixture(t), a = f.hub.openRoom({ botId: 'research' }), b = f.hub.openRoom({ botId: 'maker' });
  const first = f.send(a.id, '取消这一件'), second = f.send(b.id, '完成另一件');
  let started = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const pool = createAgentCompanion({ config: { provider: 'dsh', max_parallel_runs: 2 }, statePath: join(f.root, 'pool'), transport: async (op, input) => f.hub[op](f.token, input),
    provider: async (_config, _prompt, ctx) => { started++; await gate; if (ctx.signal.aborted) throw Object.assign(new Error('stopped'), { code: 'AGENT_CANCELLED' }); await ctx.callTool('xiaoman_report', { summary: '另一件独立完成', outcome: 'completed' }, 'same-tool-id'); return { text: '另一件独立完成' }; } });
  t.after(() => pool.stop()); await pool.tick();
  for (let i = 0; i < 20 && started < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started, 2); assert.notEqual(pool.slots[0].state.active.id, pool.slots[1].state.active.id);
  f.hub.cancel(first.run.id); const cancelled = pool.slots.find(slot => slot.state.active.id === first.run.id); cancelled.controller.abort(); release();
  await pool.execution; await pool.flush(); await pool.tick(); await pool.flush();
  assert.equal(f.hub.get('run', second.run.id).status, 'completed'); assert.notEqual(f.hub.get('run', first.run.id).status, 'completed');
  assert.equal(f.hub.all('message').filter(m => m.role === 'assistant' && m.runId === second.run.id).length, 1);
});
