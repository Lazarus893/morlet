import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { saveBot, botSnapshot, botTool, botSessionKey, mentionedBots } from '../plugins/agent-hub/bots.mjs';
import { AgentCompanion } from '../plugins/agent-hub/companion.mjs';
import { history, continuation } from '../plugins/agent-hub/continuity.mjs';
import { hasTerminalIssue } from '../plugins/agent-hub/reports.mjs';
import { HubChannel } from '../plugins/agent-hub/channel.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoman-bots-')), hub = new AgentHub(root);
  const token = 'test-dsh-token-12345678901234567890';
  hub.registerHost({ id: 'dsh', label: 'DSH test', provider: 'dsh' }, token);
  const c = hub.newConversation({ botId: 'xiaoman' });
  const poll = () => hub.poll(token, { runnerId: 'fixture', routineGuardVersion: 1 }).job;
  const send = (content, extra = {}) => hub.submit({ conversationId: c.id, content, requestId: crypto.randomUUID(), ...extra });
  const event = (job, seq, type, value) => hub.event(token, { runId: job.id, lease: job.lease, seq, type, value });
  t.after(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, hub, token, c, poll, send, event };
}
test('Bot creation defaults to DSH, validates identity and uses optimistic versions', async t => {
  const f = await fixture(t), values = { name: '读书', handle: 'books', avatar: 'research', instructions: '整理用户提供的书摘' };
  const bot = saveBot(f.hub, { values });
  assert.equal(bot.endpointId, null);
  assert.equal(botSnapshot(f.hub).find(b => b.id === bot.id).provider, 'dsh');
  assert.throws(() => saveBot(f.hub, { values }), { code: 'BOT_NAME_TAKEN' });
  assert.throws(() => saveBot(f.hub, { id: bot.id, version: 0, values: { name: '阅读' } }), { code: 'VERSION_CONFLICT' });
  assert.throws(() => saveBot(f.hub, { id: 'xiaoman', version: 1, values: { active: false } }), { code: 'MANAGER_REQUIRED' });
});
test('initial manager honors the existing instance connection while new Bots still default to DSH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoman-bot-default-')), hub = new AgentHub(root);
  t.after(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
  hub.registerHost({ id: 'local-codex', label: 'Local Codex', provider: 'codex' }, 'codex-fixture-token-12345678901234567890');
  await writeFile(join(root, '.runtime/agent-hub.json'), JSON.stringify({ version: 1, agents: [], roles: { conversation: 'local-codex' } }), { mode: 0o600 });
  assert.equal(hub.newConversation({ botId: 'xiaoman' }).endpointId, 'local-codex');
  const bot = saveBot(hub, { values: { name: '阅读', handle: 'reader', avatar: 'research', instructions: '阅读提供的材料' } });
  assert.equal(bot.endpointId, null);
  assert.throws(() => hub.newConversation({ botId: bot.id }), { code: 'BOT_CONNECTION_REQUIRED' });
});
test('legacy endpoint selection gives migration guidance and never falsely changes the next public message', async t => {
  const f = await fixture(t);
  const channel = new HubChannel({ root: f.root, channel: 'imessage', account: 'im', allowed: () => true, autoFlush: false });
  t.after(() => channel.close()); f.hub.bind({ channel: 'imessage', account: 'im', peer: 'owner', conversationId: f.c.id });
  await channel.receive({ peer: 'owner', text: '/agent dsh', requestId: 'legacy-switch' });
  assert.match(f.hub.all('message').at(-1).text, /设置 → Bot/);
  assert.equal(f.hub.all('run').length, 0);
  await channel.receive({ peer: 'owner', text: '开始这件事', requestId: 'public-next' });
  assert.equal(f.poll().botId, 'xiaoman');
});
test('multiple mentions run in order with shared attributed context and separate native sessions', async t => {
  const f = await fixture(t);
  assert.deepEqual(mentionedBots(f.hub, 'user@example.com 和 https://example.com/@author'), []);
  f.send('请@阿探 找到依据，再让@maker 做成文档');
  const first = f.poll(); assert.equal(first.botId, 'research');
  f.event(first, 1, 'session', 'research-native'); f.event(first, 2, 'completed', '找到三条依据');
  const next = f.poll(); assert.equal(next.botId, 'maker'); assert.equal(next.sessionId, null);
  assert.equal(next.conversationId, first.conversationId);
  assert.ok(next.context.some(m => m.agent === '阿探' && m.text === '找到三条依据'));
  assert.equal(f.hub.all('message').filter(m => m.role === 'user').length, 1);
  f.event(next, 1, 'session', 'maker-native'); f.event(next, 2, 'completed', '文档完成');
  f.send('@research 继续核对'); assert.equal(f.poll().sessionId, 'research-native');
  assert.notEqual(botSessionKey(first), botSessionKey(next));
});
test('manager delegates once, shares original task and preserves IM return route without an ack', async t => {
  const f = await fixture(t), sent = [];
  const channel = new HubChannel({ root: f.root, channel: 'weixin', account: 'wx', allowed: p => p === 'owner', send: async (...args) => sent.push(args), autoFlush: false });
  t.after(() => channel.close()); f.hub.bind({ channel: 'weixin', account: 'wx', peer: 'owner', conversationId: f.c.id });
  const inbound = { peer: 'owner', text: '调研这份材料', requestId: 'inbound-one' };
  await channel.receive(inbound); await channel.receive(inbound);
  f.hub.expire(); assert.equal(f.hub.all('delivery').length, 0);
  const manager = f.poll(); assert.equal(manager.botId, 'xiaoman');
  const input = { runId: manager.id, lease: manager.lease, callId: 'delegate', arguments: { operation: 'delegate', botIds: ['research'], instruction: '核对三点事实' } };
  assert.equal(botTool({ hub: f.hub, token: f.token, input }).assigned, true);
  assert.equal(botTool({ hub: f.hub, token: f.token, input }).assigned, true);
  f.event(manager, 1, 'completed', '已分派');
  assert.equal(f.hub.all('delivery').length, 0);
  const worker = f.poll(); assert.equal(worker.botId, 'research'); assert.equal(worker.prompt, inbound.text);
  f.event(worker, 1, 'completed', '已核对来源'); await channel.flush();
  assert.equal(sent.length, 0);
  const summary = f.poll(); assert.equal(summary.botId, 'xiaoman'); assert.equal(summary.botPhase, 'summary');
  assert.ok(summary.botMessages.some(m => m.kind === 'result' && m.body === '已核对来源'));
  assert.throws(() => botTool({ hub: f.hub, token: f.token, input: { runId: summary.id, lease: summary.lease, callId: 'no-recursion', arguments: { operation: 'ask', botId: 'research', message: '再来一次' } } }), { code: 'FORBIDDEN' });
  f.event(summary, 1, 'completed', '核对结论：三点有依据。'); await channel.flush();
  assert.equal(sent.length, 1); assert.equal(sent[0][0], 'owner');
  assert.equal(f.hub.all('message').filter(m => m.role === 'user').length, 1);
});
test('different IM conversations never share context; disabled profiles fence queued and late work', async t => {
  const f = await fixture(t); f.send('@research 私人材料'); const first = f.poll();
  f.event(first, 1, 'completed', '私人摘要');
  const other = f.hub.newConversation({ botId: 'research' });
  f.hub.submit({ conversationId: other.id, content: '另一件事', requestId: 'other' });
  const job = f.poll(); assert.equal(job.context.length, 0); assert.equal(job.sessionId, null);
  saveBot(f.hub, { id: 'research', version: 1, values: { active: false } });
  f.event(job, 1, 'completed', '迟到的结果');
  assert.ok(!f.hub.all('message').some(m => m.text === '迟到的结果'));
  assert.throws(() => f.send('@research 再来'), { code: 'BOT_UNAVAILABLE' });
});
test('unknown mentions fail visibly; changed Bot is not silently retried as another runtime', async t => {
  const f = await fixture(t);
  assert.throws(() => f.send('@missing 工作'), { code: 'BOT_MENTION_UNKNOWN' });
  const request = { conversationId: f.c.id, content: '做一件事', botId: 'research', requestId: 'stable' };
  const first = f.hub.submit(request); assert.equal(f.hub.submit(request).run.id, first.run.id);
  assert.throws(() => f.hub.submit({ ...request, botId: 'maker' }), { code: 'CONFLICT' });
  saveBot(f.hub, { id: 'research', version: 1, values: { instructions: '先核对资料完整性' } });
  assert.equal(f.hub.get('run', first.run.id).status, 'cancelled');
  assert.equal(f.poll(), null);
});
test('a specialist and an explicitly mentioned manager cannot delegate recursively', async t => {
  const f = await fixture(t); f.send('@mori 请自己回答'); const job = f.poll();
  assert.throws(() => botTool({ hub: f.hub, token: f.token, input: { runId: job.id, lease: job.lease, callId: 'd', arguments: { operation: 'delegate', botIds: ['maker'], instruction: '做' } } }), { code: 'FORBIDDEN' });
});

const legacyManagerInstructions = '你是总管小满。理解当前交代，查看 Bot 职责后把适合的工作交给相应 Bot；简单问题自己回答。不要为了分派而分派，不重复已交出的工作。';
const legacyManager = hub => {
  const row = { ...hub.get('bot', 'xiaoman'), name: '小满', handle: 'xiaoman', instructions: legacyManagerInstructions };
  delete row.defaultIdentityVersion; delete row.legacyHandle;
  return hub.put('bot', row);
};
test('new managers use Mori while the deployed identity and explicit mention dispatch stay stable', async t => {
  const f = await fixture(t), manager = botSnapshot(f.hub).find(bot => bot.id === 'xiaoman');
  assert.equal(manager.name, 'Mori'); assert.equal(manager.handle, 'mori'); assert.match(manager.instructions, /总管Mori/);
  assert.deepEqual(mentionedBots(f.hub, '@mori 请处理'), ['xiaoman']);
  assert.throws(() => mentionedBots(f.hub, '@xiaoman 新实例没有历史别名'), { code: 'BOT_MENTION_UNKNOWN' });
  const sent = f.send('@mori 请核对'); assert.equal(sent.run.botId, 'xiaoman');
});
test('old default branding migrates once without cancelling a live run, changing its version or losing native continuity', async t => {
  const f = await fixture(t), first = f.send('以前交给小满的事项').run, job = f.poll();
  f.event(job, 1, 'session', 'existing-manager-session');
  const old = legacyManager(f.hub), snapshot = f.hub.snapshot(), manager = snapshot.bots.find(bot => bot.id === 'xiaoman');
  assert.equal(manager.name, 'Mori'); assert.equal(manager.handle, 'mori'); assert.equal(manager.version, old.version);
  assert.equal(manager.endpointId, old.endpointId); assert.equal(f.hub.get('run', first.id).status, 'running');
  assert.equal(snapshot.messages.find(message => message.runId === first.id).text, '以前交给小满的事项');
  assert.deepEqual(mentionedBots(f.hub, '@xiaoman 旧入口'), ['xiaoman']);
  assert.deepEqual(mentionedBots(f.hub, '@mori 新入口'), ['xiaoman']);
  f.event(job, 2, 'completed', '原事项完成'); f.send('接着之前的事项');
  assert.equal(f.poll().sessionId, 'existing-manager-session');
  const updated = saveBot(f.hub, { id: manager.id, version: manager.version, values: { name: '小满', handle: 'my-mori', instructions: '用户明确保留的自定义职责' } });
  assert.equal(botSnapshot(f.hub).find(bot => bot.id === manager.id).name, '小满', 'a later explicit user edit is not automatically renamed again');
  assert.equal(f.hub.get('bot', manager.id).instructions, updated.instructions);
});
test('branding migration preserves custom identity and instructions and never steals another Bot handle', async t => {
  const f = await fixture(t); legacyManager(f.hub);
  f.hub.put('bot', { ...f.hub.get('bot', 'xiaoman'), name: '阿总', handle: 'my-manager', instructions: '只整理我的资料，不代办。' });
  let manager = botSnapshot(f.hub).find(bot => bot.id === 'xiaoman');
  assert.equal(manager.name, '阿总'); assert.equal(manager.handle, 'my-manager'); assert.equal(manager.instructions, '只整理我的资料，不代办。');
  legacyManager(f.hub);
  f.hub.put('bot', { ...f.hub.get('bot', 'xiaoman'), instructions: '你是小满，只照我自定义的研究流程工作。' });
  manager = botSnapshot(f.hub).find(bot => bot.id === 'xiaoman');
  assert.equal(manager.name, 'Mori'); assert.equal(manager.instructions, '你是小满，只照我自定义的研究流程工作。');
  const other = saveBot(f.hub, { values: { name: '旧入口', handle: 'xiaoman', avatar: 'research', instructions: '用户自建 Bot' } });
  assert.deepEqual(mentionedBots(f.hub, '@xiaoman 请处理'), [other.id], 'a real handle takes precedence over the migration alias');
  f.hub.put('bot', { ...other, name: 'Mori', handle: 'mori' }); legacyManager(f.hub);
  manager = botSnapshot(f.hub).find(bot => bot.id === 'xiaoman');
  assert.equal(manager.name, '小满'); assert.equal(manager.handle, 'xiaoman');
  assert.deepEqual(mentionedBots(f.hub, '@mori 请处理'), [other.id]);
});


test('onboarding handoffs keep the original consent gate and current flow identity', async t => {
  const f = await fixture(t);
  const { run } = f.send('@research 提炼内容 @maker 整理方案');
  f.hub.put('run', { ...run, firstTaskId: 'flow', firstTaskMode: 'clarify' });
  f.hub.put('firstTask', { id: 'flow', currentRunId: run.id, conversationId: run.conversationId, runIds: [run.id], version: 1, stage: 'queued' });
  const first = f.poll(); f.event(first, 1, 'completed', '分析结果');
  const next = f.poll(); assert.equal(next.firstTaskId, 'flow'); assert.equal(next.firstTaskMode, 'clarify');
  assert.equal(f.hub.get('firstTask', 'flow').currentRunId, next.id);
  assert.deepEqual(f.hub.get('firstTask', 'flow').runIds, [first.id, next.id]);
});


test('an already queued follow-up waits for the current Bot handoff', async t => {
  const f = await fixture(t);
  f.send('@research 查资料 @maker 写说明'); const first = f.poll();
  f.send('继续压缩上一轮结果');
  f.event(first, 1, 'completed', '依据已找到');
  const next = f.poll(); assert.equal(next.botId, 'maker'); assert.equal(next.parentRunId, first.id);
  f.event(next, 1, 'completed', '说明已完成');
  assert.equal(f.poll().prompt, '继续压缩上一轮结果');
});


const ask = (f, job, message = '请核对这个事实', extra = {}) => botTool({ hub: f.hub, token: f.token, input: { runId: job.id, lease: job.lease, callId: 'ask-one', arguments: { operation: 'ask', botId: 'maker', message }, ...extra } });

test('durable questions wake one recipient, correlate replies and resume across ledger reopen before a later user task', async t => {
  const f = await fixture(t);
  const { run: root } = f.send('@research 核实材料，再由 @maker 整理', { source: { channel: 'imessage', account: 'fixture', peer: 'owner' }, journalItemId: 'original-page', attachmentId: 'original-attachment' });
  const first = f.poll(); f.event(first, 1, 'session', 'research-session');
  const receipt = ask(f, first), again = ask(f, first);
  assert.equal(again.messageId, receipt.messageId);
  assert.equal(f.hub.all('run').length, 2, 'request and recipient queue are committed together');
  assert.equal(f.poll(), null, 'recipient cannot run while requester is still running');
  assert.throws(() => ask(f, first, '改写请求'), { code: 'CONFLICT' });
  const later = f.send('下一件事：只属于后续任务的新资料范围');
  f.event(first, 2, 'completed', '等同事补充后继续');
  let reopened = new AgentHub(f.root);
  const reply = reopened.poll(f.token, { runnerId: 'fixture', routineGuardVersion: 1 }).job;
  assert.equal(reply.botPhase, 'reply'); assert.equal(reply.botId, 'maker');
  assert.equal(reply.botMessageId, receipt.messageId); assert.equal(reply.journalItemId, 'original-page');
  assert.deepEqual(reply.attachmentIds, ['original-attachment']);
  assert.equal(JSON.stringify({ context: reply.context, continuation: reply.continuation, mailbox: reply.botMessages }).includes('后续任务的新资料范围'), false);
  assert.throws(() => history(reopened, reply, { operation: 'get', messageId: later.message.id }), { code: 'ITEM_NOT_FOUND' });
  assert.equal(history(reopened, reply, { operation: 'recent' }).messages.some(m => m.id === later.message.id), false);
  const answerEvent = { runId: reply.id, lease: reply.lease, seq: 1, type: 'completed', value: '核对后的补充依据' };
  reopened.event(f.token, answerEvent); reopened.close();
  reopened = new AgentHub(f.root);
  assert.equal(reopened.event(f.token, answerEvent).duplicate, true);
  const resumed = reopened.poll(f.token, { runnerId: 'fixture', routineGuardVersion: 1 }).job;
  assert.equal(resumed.botId, 'research'); assert.equal(resumed.botPhase, 'continuation');
  assert.equal(resumed.sessionId, 'research-session'); assert.equal(resumed.rootRunId, root.id);
  assert.ok(resumed.botMessages.some(m => m.replyTo === receipt.messageId && m.kind === 'result' && m.body === '核对后的补充依据'));
  assert.equal(f.hub.all('delivery').length, 0);
  reopened.event(f.token, { runId: resumed.id, lease: resumed.lease, seq: 1, type: 'completed', value: '结合补充完成核实' });
  const final = reopened.poll(f.token, { runnerId: 'fixture', routineGuardVersion: 1 }).job;
  assert.equal(final.botId, 'maker'); assert.equal(final.botPhase, undefined);
  assert.equal(final.prompt, root.prompt);
  reopened.event(f.token, { runId: final.id, lease: final.lease, seq: 1, type: 'completed', value: '最终整理结果' });
  assert.equal(f.hub.all('delivery').length, 1); assert.match(f.hub.all('delivery')[0].text, /最终整理结果/);
  assert.equal(reopened.poll(f.token, { runnerId: 'fixture', routineGuardVersion: 1 }).job.id, later.run.id);
  reopened.close();
});

test('question budget, participant scope, reply phase and authority boundaries prevent unbounded or cross-task messaging', async t => {
  const f = await fixture(t); f.send('@research 核对 @maker 制作'); let requester = f.poll();
  const unauthorized = args => botTool({ hub: f.hub, token: f.token, input: { runId: requester.id, lease: requester.lease, callId: 'bad', arguments: args } });
  assert.throws(() => unauthorized({ operation: 'ask', botId: 'planner', message: '越过成员范围' }), { code: 'FORBIDDEN' });
  assert.throws(() => unauthorized({ operation: 'ask', botId: 'maker', message: '伪造关联', replyTo: 'another-task' }), { code: 'INVALID_INPUT' });
  for (let i = 0; i < 3; i++) {
    ask(f, requester, '补充问题 ' + i); f.event(requester, 1, 'completed', '等待同事');
    const reply = f.poll();
    assert.throws(() => ask(f, reply, '循环询问', { arguments: { operation: 'ask', botId: 'research', message: '回问' } }), { code: 'FORBIDDEN' });
    f.event(reply, 1, 'completed', '答复 ' + i); requester = f.poll();
  }
  assert.throws(() => ask(f, requester, '第四次'), { code: 'BOT_MESSAGE_LIMIT' });
  assert.equal(f.hub.all('botMessage').filter(m => m.kind === 'request' && m.purpose === 'question').length, 3);
  const other = f.hub.newConversation({ botId: 'planner' });
  const foreign = f.hub.submit({ conversationId: other.id, content: '另一事项', requestId: 'foreign' }).run;
  assert.throws(() => ask(f, requester, '伪造运行身份', { runId: foreign.id }), { code: 'FORBIDDEN' });
  const inbox = botTool({ hub: f.hub, token: f.token, input: { runId: requester.id, lease: requester.lease, arguments: { operation: 'inbox' } } });
  assert.ok(inbox.messages.every(m => m.conversationId === f.c.id && m.rootRunId === requester.rootRunId));
});

test('cancelling a completed requester fences the still-answering child and prevents resumption or late external delivery', async t => {
  const f = await fixture(t); const root = f.send('@research 核对 @maker 制作', { source: { channel: 'weixin', account: 'fixture', peer: 'owner' } }).run;
  const requester = f.poll(); ask(f, requester); f.event(requester, 1, 'completed', '等答复');
  const reply = f.poll(); f.hub.cancel(root.id);
  assert.equal(f.hub.get('run', reply.id).status, 'cancelling');
  assert.equal(f.hub.get('run', root.id).botTaskStopped, 'CANCELLED');
  assert.equal(f.event(reply, 1, 'completed', '迟到答复').ignored, true);
  assert.equal(f.hub.all('run').length, 2); assert.equal(f.hub.all('delivery').length, 0);
  assert.throws(() => botTool({ hub: f.hub, token: f.token, input: { runId: reply.id, lease: reply.lease, arguments: { operation: 'inbox' } } }), { code: 'FORBIDDEN' });
  f.event(reply, 2, 'stopped', ''); assert.equal(f.poll(), null);
  assert.equal(f.hub.all('botMessage')[0].state, 'cancelled');
});

test('changing a requester profile while its teammate answers cancels the whole task without reviving the old persona', async t => {
  const f = await fixture(t); f.send('@research 核对 @maker 制作');
  const requester = f.poll(); ask(f, requester); f.event(requester, 1, 'completed', '等答复');
  const reply = f.poll(); saveBot(f.hub, { id: 'research', version: 1, values: { instructions: '新的职责' } });
  assert.equal(f.hub.get('run', reply.id).status, 'cancelling');
  f.event(reply, 1, 'completed', '迟到结果');
  assert.ok(!f.hub.all('message').some(m => m.text === '迟到结果'));
  assert.equal(f.hub.all('run').length, 2);
});

test('a requester failure cancels its queued recipient and emits one necessary error, not a successful summary', async t => {
  const f = await fixture(t); f.send('@research 核对 @maker 制作', { source: { channel: 'imessage', account: 'fixture', peer: 'owner' } });
  const requester = f.poll(); ask(f, requester); f.event(requester, 1, 'failed', 'AGENT_TIMEOUT');
  assert.equal(f.hub.all('run')[1].status, 'cancelled'); assert.equal(f.poll(), null);
  assert.equal(f.hub.all('delivery').length, 1); assert.match(f.hub.all('delivery')[0].text, /超时/);
  assert.equal(f.hub.all('botMessage')[0].state, 'failed');
});

test('partial member work remains visible and never becomes an automatic successful manager summary', async t => {
  const f = await fixture(t); f.send('请团队核对', { source: { channel: 'weixin', account: 'fixture', peer: 'owner' } });
  const manager = f.poll(); botTool({ hub: f.hub, token: f.token, input: { runId: manager.id, lease: manager.lease, callId: 'handoff', arguments: { operation: 'delegate', botIds: ['research', 'maker'], instruction: '先核对再制作' } } });
  f.event(manager, 1, 'completed', '已交出'); const member = f.poll();
  f.hub.put('run', { ...f.hub.get('run', member.id), report: { outcome: 'partial', summary: '第二份来源尚不可读' } });
  f.event(member, 1, 'completed', '暂时只有第一份来源');
  assert.equal(f.poll(), null); assert.equal(f.hub.all('delivery').length, 1);
  assert.match(f.hub.all('delivery')[0].text, /尚未完成.*第二份来源/s);
  assert.equal(f.hub.get('run', manager.id).botTaskStopped, 'BOT_MEMBER_PARTIAL');
  assert.equal(f.hub.all('botMessage').every(m => m.state === 'failed'), true);
});

test('onboarding and background routine executions cannot open a new Bot communication path', async t => {
  for (const extra of [{ firstTaskId: 'flow' }, { routine: { id: 'patrol' } }]) {
    const f = await fixture(t); f.send('@research 核对 @maker 制作'); const job = f.poll();
    f.hub.put('run', { ...f.hub.get('run', job.id), ...extra });
    assert.throws(() => ask(f, job), { code: 'FORBIDDEN' });
    assert.equal(f.hub.all('botMessage').length, 0); assert.equal(f.hub.all('run').length, 1);
  }
});


test('Codex refreshes the same-named Bot tool schema once without losing the conversation or notebook', async t => {
  const f = await fixture(t), calls = [];
  f.hub.put('endpoint', { ...f.hub.get('endpoint', 'dsh'), provider: 'codex' });
  saveBot(f.hub, { id: 'xiaoman', version: 1, values: { endpointId: 'dsh' } });
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'bot-schema-spool'), transport: async (op, input) => f.hub[op](f.token, input), provider: async (_config, prompt, context) => {
    calls.push(context.sessionId);
    if (calls.length === 2) { assert.equal(context.sessionId, null); assert.match(prompt, /原任务范围不变/); assert.match(prompt, /stable-page/); }
    if (calls.length === 3) assert.equal(context.sessionId, 'bot-new-schema');
    const id = calls.length === 1 ? 'bot-old-schema' : 'bot-new-schema';
    await context.onSession(id); await context.onCapabilities(id, context.tools.map(tool => tool.name));
    return { text: '仍在原事项中继续' };
  } });
  t.after(() => companion.stop());
  let original;
  for (let i = 0; i < 3; i++) {
    if (i === 1) {
      const session = f.hub.get('session', botSessionKey(original));
      f.hub.put('session', { ...session, botProtocolVersion: 0 });
    }
    const { run } = f.send(i ? '继续办理' : '原任务范围不变', { journalItemId: 'stable-page' }); original ||= run;
    await companion.tick(); await companion.execution; await companion.tick();
  }
  assert.deepEqual(calls, [null, null, 'bot-new-schema']);
  assert.equal(f.hub.all('conversation').length, 1);
  assert.ok(f.hub.all('run').every(run => run.status === 'completed' && run.journalItemId === 'stable-page'));
});


test('a partial or blocked final manager report produces exactly one honest IM result', async t => {
  for (const outcome of ['partial', 'blocked']) {
    const f = await fixture(t); f.send('由团队核对', { source: { channel: 'imessage', account: 'fixture', peer: 'owner' } });
    const manager = f.poll(); botTool({ hub: f.hub, token: f.token, input: { runId: manager.id, lease: manager.lease, callId: 'handoff', arguments: { operation: 'delegate', botIds: ['research'], instruction: '核对材料' } } });
    f.event(manager, 1, 'completed', '分派完成'); const member = f.poll(); f.event(member, 1, 'completed', '已找到初步依据');
    const summary = f.poll(); f.hub.put('run', { ...f.hub.get('run', summary.id), report: { outcome, summary: '还有结论需要本人确认' } });
    f.event(summary, 1, 'completed', '所有任务已经完成');
    const deliveries = f.hub.all('delivery'); assert.equal(deliveries.length, 1);
    assert.match(deliveries[0].text, /尚未完成.*需要本人确认/s); assert.doesNotMatch(deliveries[0].text, /所有任务已经完成/);
    assert.equal(f.poll(), null); assert.equal(f.hub.get('run', manager.id).botTaskStopped, outcome === 'partial' ? 'BOT_MEMBER_PARTIAL' : 'BOT_MEMBER_BLOCKED');
  }
});


test('successful ask and delegate may yield with no final text while ordinary, rejected and forged empty replies still fail', async t => {
  for (const mode of ['ask', 'delegate', 'plain', 'rejected', 'inbox']) {
    const f = await fixture(t); const root = f.send(mode === 'delegate' || mode === 'plain' ? '处理这项事务' : '@research 核对 @maker 制作').run;
    const companion = new AgentCompanion({ config: { provider: 'dsh' }, statePath: join(f.root, 'yield-spool'), transport: async (op, input) => op === 'tool' && input.tool === 'xiaoman_bots' ? botTool({ hub: f.hub, token: f.token, input }) : f.hub[op](f.token, input), provider: async (_config, _prompt, context) => {
      f.hub.put('run', { ...f.hub.get('run', root.id), report: { outcome: 'in_progress', summary: '已开始当前分工' } });
      if (mode === 'ask') await context.callTool('xiaoman_bots', { operation: 'ask', botId: 'maker', message: '确认格式' }, 'q');
      if (mode === 'delegate') { await context.callTool('xiaoman_bots', { operation: 'delegate', botIds: ['research'], instruction: '核对文本' }, 'd'); throw new Error('AGENT_EMPTY_REPLY'); }
      if (mode === 'rejected') await assert.rejects(context.callTool('xiaoman_bots', { operation: 'ask', botId: 'planner', message: '未分配成员' }, 'bad'), { code: 'FORBIDDEN' });
      if (mode === 'inbox') await context.callTool('xiaoman_bots', { operation: 'inbox' }, 'read');
      return { text: '' };
    } });
    await companion.tick(); await companion.execution; await companion.flush();
    const stored = f.hub.get('run', root.id);
    if (['ask', 'delegate'].includes(mode)) {
      assert.equal(stored.status, 'completed'); assert.equal(stored.botYielded, true);
      assert.equal(f.hub.snapshot().runs.find(r => r.id === root.id).issue, null);
      const handedOff = continuation(f.hub, f.hub.all('run')[1]).recentWork.find(r => r.id === root.id);
      assert.equal(handedOff.nextRunId, stored.nextRunId); assert.equal(handedOff.report.outcome, 'in_progress');
      assert.equal(f.hub.all('run').length, 2); assert.equal(f.hub.all('run')[1].status, 'queued');
      assert.equal(f.hub.all('message').filter(m => m.role === 'assistant').length, 0);
    } else { assert.equal(stored.status, 'failed'); assert.equal(stored.error, 'AGENT_EMPTY_REPLY'); }
    await companion.stop();
  }
  const f = await fixture(t); f.send('普通任务'); const job = f.poll();
  assert.throws(() => f.event(job, 1, 'yielded', { operation: 'delegate' }), { code: 'FORBIDDEN' });
  assert.throws(() => f.event(job, 1, 'yielded', { operation: 'ask' }), { code: 'FORBIDDEN' });
});

test('completed Bot handoffs stop occupying unfinished history while genuine incomplete work stays visible', async t => {
  const f = await fixture(t), root = f.send('@research 核对 @maker 制作').run;
  const requester = f.poll(); ask(f, requester);
  f.hub.put('run', { ...f.hub.get('run', requester.id), report: { outcome: 'in_progress', summary: '已发问，等待同事回复' } });
  f.event(requester, 1, 'completed', '交接给同事');
  const handoff = f.hub.get('run', root.id);
  assert.equal(hasTerminalIssue(handoff), false, 'a hosted ask also supports a nonempty final handoff');
  for (const change of [
    { nextRunId: undefined }, { botId: undefined }, { botRequest: undefined },
    { botTaskStopped: 'CANCELLED' }, { handoffError: 'BOT_UNAVAILABLE' }, { error: 'AGENT_FAILED' },
    { report: { outcome: 'partial' } }, { report: { outcome: 'blocked' } }, { status: 'failed' },
  ]) assert.equal(hasTerminalIssue({ ...handoff, ...change }), true, JSON.stringify(change));
  const reply = f.poll(); f.event(reply, 1, 'completed', '问题答完');
  const resumed = f.poll(); f.event(resumed, 1, 'completed', '核对完成');
  const final = f.poll(); f.event(final, 1, 'completed', '制作完成');
  const incomplete = f.send('普通任务尚未完成').run, incompleteJob = f.poll();
  f.hub.put('run', { ...f.hub.get('run', incomplete.id), report: { outcome: 'in_progress', summary: '尚有内容未处理' } });
  f.event(incompleteJob, 1, 'completed', '本轮暂时结束');
  for (let i = 0; i < 7; i++) { f.send('后续独立任务 ' + i); f.event(f.poll(), 1, 'completed', '已完成'); }
  const latest = f.send('查看之前的工作').run, work = continuation(f.hub, latest).recentWork;
  assert.equal(work.some(r => r.id === root.id), false, 'a finished handoff is not pinned as an old unfinished task');
  assert.ok(work.some(r => r.id === incomplete.id && r.report.outcome === 'in_progress'), 'ordinary incomplete work remains recoverable after newer tasks');
  const snapshot = f.hub.snapshot();
  assert.equal(snapshot.runs.find(r => r.id === root.id).issue, null);
  assert.equal(snapshot.runs.find(r => r.id === incomplete.id).issue.state, 'open');
});

test('an earlier queued root blocks later work on another endpoint before any native session can contain future authorization', async t => {
  const f = await fixture(t), codex = f.hub.pair({ label: 'Second execution connection' });
  saveBot(f.hub, { id: 'maker', version: 1, values: { endpointId: codex.endpointId } });
  const occupied = f.hub.newConversation({ botId: 'planner' });
  f.hub.submit({ conversationId: occupied.id, content: '先处理另一段对话', requestId: 'occupied' });
  const busy = f.poll();
  const earlier = f.send('@research 旧任务核对 @maker 制作').run;
  const later = f.send('@maker 后续任务的新授权').run;
  const pollCodex = () => f.hub.poll(codex.token, { runnerId: 'codex-fixture', routineGuardVersion: 1 }).job;
  assert.equal(pollCodex(), null, 'a newer root cannot bypass an older queued root on another endpoint');
  f.event(busy, 1, 'completed', '已完成其他事项');
  const requester = f.poll(); assert.equal(requester.id, earlier.id); ask(f, requester); f.event(requester, 1, 'completed', '等答复');
  const reply = pollCodex(); assert.equal(reply.botPhase, 'reply'); assert.equal(reply.sessionId, null);
  assert.equal(JSON.stringify(reply).includes('后续任务的新授权'), false);
  f.hub.event(codex.token, { runId: reply.id, lease: reply.lease, seq: 1, type: 'completed', value: '补充信息' });
  const resumed = f.poll(); f.event(resumed, 1, 'completed', '原任务核对完成');
  const final = pollCodex(); assert.equal(final.rootRunId, earlier.id);
  f.hub.event(codex.token, { runId: final.id, lease: final.lease, seq: 1, type: 'completed', value: '原任务制作完成' });
  assert.equal(pollCodex().id, later.id);
});

test('provider prompts put the internal question or member assignment last and reserve whole-task acceptance for the final owner', async t => {
  const f = await fixture(t), phases = [];
  f.send('@research 先问 @maker 文案的长度，再提炼验收点，最后由阿造写最终文案');
  const companion = new AgentCompanion({ config: { provider: 'dsh' }, statePath: join(f.root, 'turn-contract-spool'), transport: async (op, input) => op === 'tool' && input.tool === 'xiaoman_bots' ? botTool({ hub: f.hub, token: f.token, input }) : f.hub[op](f.token, input), provider: async (_config, prompt, context) => {
    const turn = prompt.slice(prompt.lastIndexOf('当前执行轮的目标与验收'));
    const index = phases.length; phases.push(turn);
    if (index === 0) {
      assert.match(turn, /完成当前 Bot 的职责分工/);
      await context.callTool('xiaoman_bots', { operation: 'ask', botId: 'maker', message: '请给出文案长度建议' }, 'format');
      return { text: '' };
    }
    if (index === 1) {
      assert.match(turn, /只回答.*提出的问题/s); assert.match(turn, /请给出文案长度建议/);
      assert.match(turn, /无需完成原始整件事/); assert.match(turn, /问题本身未答完整.*partial\/blocked/s);
      assert.ok(prompt.indexOf('原始用户交代（授权范围上限') < prompt.lastIndexOf('当前执行轮的目标与验收'));
    } else if (index === 2) {
      assert.match(turn, /完成当前 Bot 的职责分工/); assert.match(turn, /后续成员尚未执行的工作不构成你的 partial/);
      assert.doesNotMatch(turn, /你是本次最终回报负责人/);
    } else assert.match(turn, /你是本次最终回报负责人/);
    return { text: ['发问', '建议六十字', '已提炼验收点', '最终文案'][index] };
  } });
  t.after(() => companion.stop());
  for (let i = 0; i < 4; i++) { await companion.tick(); await companion.execution; await companion.flush(); }
  assert.equal(phases.length, 4);
  assert.ok(f.hub.all('run').every(run => run.status === 'completed'));
});

test('real partial work in an explicitly mentioned chain cannot be overwritten by a later member or a false final claim', async t => {
  for (const partialAt of ['first', 'final']) {
    const f = await fixture(t); const root = f.send('@research 核对来源 @maker 整理结果', { source: { channel: 'imessage', account: 'fixture', peer: 'owner' } }).run;
    let member = f.poll();
    if (partialAt === 'final') { f.event(member, 1, 'completed', '已完成来源核对'); member = f.poll(); }
    f.hub.put('run', { ...f.hub.get('run', member.id), report: { outcome: 'partial', summary: '本轮所需第二份来源未读完整' } });
    f.event(member, 1, 'completed', '全部目标都完成了');
    assert.equal(f.poll(), null); assert.equal(f.hub.get('run', root.id).botTaskStopped, 'BOT_MEMBER_PARTIAL');
    const deliveries = f.hub.all('delivery'); assert.equal(deliveries.length, 1);
    assert.match(deliveries[0].text, /第二份来源未读完整/); assert.doesNotMatch(deliveries[0].text, /全部目标都完成了/);
  }
});


test('a true partial or blocked requester after ask cancels the already queued reply even when its final event is yielded', async t => {
  for (const outcome of ['partial', 'blocked']) for (const eventType of ['completed', 'yielded']) {
    const f = await fixture(t); const root = f.send('@research 核对来源 @maker 制作', { source: { channel: 'weixin', account: 'fixture', peer: 'owner' } }).run;
    const requester = f.poll(), receipt = ask(f, requester);
    f.hub.put('run', { ...f.hub.get('run', requester.id), report: { outcome, summary: '本轮必需的原始资料无法完整读取' } });
    f.event(requester, 1, eventType, eventType === 'yielded' ? { operation: 'ask', messageId: receipt.messageId } : '等待同事回复');
    assert.equal(f.hub.get('run', root.id).botTaskStopped, outcome === 'partial' ? 'BOT_MEMBER_PARTIAL' : 'BOT_MEMBER_BLOCKED');
    assert.equal(f.hub.get('run', receipt.recipientRunId).status, 'cancelled');
    assert.equal(f.hub.get('botMessage', receipt.messageId).state, 'failed');
    assert.equal(f.poll(), null);
    assert.equal(f.hub.all('delivery').length, 1); assert.match(f.hub.all('delivery')[0].text, /资料无法完整读取/);
  }
});
