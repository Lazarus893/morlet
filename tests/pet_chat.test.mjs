import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { HubChannel } from '../plugins/agent-hub/channel.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { createAutomaticContent } from '../plugins/proactive/automatic-content.mjs';
import { personalNoticeContext, personalNoticeCommand, personalChannelPoll } from '../plugins/proactive/personal-notices.mjs';
import { startPetChatBridge, loadPetChatConfig } from '../plugins/proactive/pet-chat-bridge.mjs';
import { xiaomanChat, readXiaomanChat, blocksXiaomanHttpChat } from '../vendor/dsh-pet/xiaoman-chat.mjs';
import { createWebUI } from '../plugins/webui/server.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pet-chat-')), hub = new AgentHub(root), store = new JournalStore(root);
  const content = createAutomaticContent({ hub, journal: { store } });
  const endpoint = hub.pair({ provider: 'codex', label: 'existing agent' }), conversation = hub.newConversation({ endpointId: endpoint.endpointId });
  const pair = hub.pairDesktopPet({ label: 'pet', petId: 'main', conversationId: conversation.id });
  hub.enablePetChat({ channelId: pair.channelId, enabled: true });
  hub.channelStatus(pair.token, { peer: 'main', ready: true });
  const source = { channel: 'desktop-pet', account: pair.channelId, peer: 'main' };
  const notice = (id, keys) => {
    hub.put('delivery', { id, conversationId: conversation.id, source, text: 'A real queue notification', state: 'submitted', createdAt: Date.now() });
    for (const key of keys) {
      hub.put('personalNotice', { id: 'notice-' + key, key, source: 'github', deliveryId: id });
      const entryId = key.padEnd(64, '0');
      store.db.prepare('INSERT INTO journal_content_entries VALUES(?,?,?)').run(entryId, 'item', JSON.stringify({ id: entryId, key, source: 'github', title: key, topic: key, summary: 'Existing source summary', feedback: null }));
    }
  };
  t.after(() => { store.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, hub, store, content, endpoint, conversation, pair, source, notice };
}

test('pet reply stays pinned to the opened notification; explicit feedback is scoped, idempotent and reversible', async t => {
  const f = fixture(t); f.notice('older', ['a']);
  const captured = personalNoticeContext(f.hub, f.pair.channelId);
  f.notice('newer', ['b']);
  const router = new HubChannel({ root: f.root, channel: 'desktop-pet', account: f.pair.channelId, allowed: p => p === 'main', autoFlush: false });
  t.after(() => router.close());
  await router.receive({ peer: 'main', text: '这有什么意思？', requestId: 'conversation-test', replyTo: captured.deliveryId });
  const run = f.hub.all('run')[0];
  assert.equal(run.replyContext.deliveryId, 'older'); assert.equal(run.replyContext.entries[0].title, 'a');
  const feedback = { peer: 'main', text: '少推', requestId: 'feedback-test', replyTo: 'older', entryId: 'a'.padEnd(64, '0'), reaction: 'less' };
  await router.receive(feedback); await router.receive(feedback);
  let row = JSON.parse(f.store.db.prepare('SELECT data FROM journal_content_entries WHERE id=?').get(feedback.entryId).data);
  assert.equal(row.feedback, 'less'); assert.equal(row.feedbackRevision, 1);
  assert.equal(f.content.snapshot().entries.find(e => e.title === 'b').feedback, null);
  assert.equal(f.hub.all('run').length, 1, 'Feedback does not invoke a model');
  await router.receive({ ...feedback, requestId: 'feedback-clear', reaction: 'clear', text: '撤回反馈' });
  assert.equal(f.content.snapshot().entries.find(e => e.title === 'a').feedback, null);
  assert.equal(personalNoticeCommand(f.hub, 'desktop-pet', f.pair.channelId, 'stranger', '有用', { replyTo: 'older' }), null);
});

test('ambiguous digests require an entry; wrong channel, expired context and fabricated entry are rejected', async t => {
  const f = fixture(t); f.notice('digest', ['a', 'b']);
  assert.match(personalNoticeCommand(f.hub, 'desktop-pet', f.pair.channelId, 'main', '少推', { replyTo: 'digest' }), /选择具体/);
  assert.equal(f.content.snapshot().learning.explicitSignals, 0);
  const other = f.hub.pairDesktopPet({ label: 'other', petId: 'other', conversationId: f.conversation.id });
  f.hub.enablePetChat({ channelId: other.channelId, enabled: true });
  assert.throws(() => personalNoticeContext(f.hub, other.channelId, 'digest'), /REPLY_CONTEXT_EXPIRED/);
  const router = new HubChannel({ root: f.root, channel: 'desktop-pet', account: f.pair.channelId, allowed: p => p === 'main', autoFlush: false });
  t.after(() => router.close());
  await assert.rejects(router.receive({ peer: 'main', text: '有用', requestId: 'bad-entry', replyTo: 'digest', entryId: 'c'.repeat(64) }), /INVALID_INPUT/);
  f.hub.put('delivery', { ...f.hub.get('delivery', 'digest'), createdAt: Date.now() - 86400001 });
  assert.throws(() => personalNoticeContext(f.hub, f.pair.channelId, 'digest'), /REPLY_CONTEXT_EXPIRED/);
});

test('ordinary pet replies remain available when proactive messages are paused', t => {
  const f = fixture(t);
  f.hub.put('personalNoticePolicy', { id: 'owner', enabled: false, channelId: f.pair.channelId });
  assert.match(personalNoticeCommand(f.hub, 'desktop-pet', f.pair.channelId, 'main', '提醒设置'), /桌面小满暂停/);
  const m = f.hub.reply(f.conversation.id, 'ordinary answer', f.source);
  assert.equal(personalChannelPoll(f.hub, f.pair.token).delivery.id, m.id);
  f.hub.channelAck(f.pair.token, { deliveryId: m.id, state: 'submitted' });
  assert.equal(personalNoticeContext(f.hub, f.pair.channelId), null, 'A chat answer is not a recommendation target');
});

test('Unix bridge requires a private credential, bounds operations, and does not fall back to pet LLM when offline', async t => {
  const root = mkdtempSync('/tmp/pet-socket-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { petId: 'main', token: 't'.repeat(40), socketPath: join(root, 'chat.sock') }, path = join(root, 'xiaoman-chat.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(loadPetChatConfig(path), config); assert.equal(readXiaomanChat(root, 'other'), null);
  assert.equal(blocksXiaomanHttpChat(root, '/dsh-pet-7340/chat?pet=main'), true);
  assert.equal(blocksXiaomanHttpChat(root, '/dsh-pet-7340/%63hat?pet=main'), true);
  assert.equal(blocksXiaomanHttpChat(root, '/dsh-pet-7340/chat?pet=other'), false);
  assert.equal(blocksXiaomanHttpChat(root, '/dsh-pet-7340/state'), false);
  const calls = [], server = await startPetChatBridge(config, { petId: 'main' }, { transport: async (op, input) => { calls.push({ op, input }); return op === 'context' ? { context: { deliveryId: 'exact' } } : { accepted: true }; } });
  assert.equal(statSync(config.socketPath).mode & 0o777, 0o600);
  assert.equal((await xiaomanChat(root, 'main', 'context')).context.deliveryId, 'exact');
  assert.equal((await xiaomanChat(root, 'main', 'inbound', { text: 'hi', requestId: 'stable-request-01' })).ok, true);
  assert.equal(calls[1].input.requestId, 'stable-request-01');
  const status = await new Promise(resolve => { const r = request({ socketPath: config.socketPath, path: '/inbound', method: 'POST' }, res => { res.resume(); resolve(res.statusCode); }); r.end('{}'); });
  assert.equal(status, 403);
  await server.close(); await assert.rejects(xiaomanChat(root, 'main', 'inbound', { text: 'no fallback' }), /连接中断/);
  chmodSync(path, 0o644); assert.throws(() => readXiaomanChat(root, 'main'), /0600/);
});

test('owner must enable pet chat; channel HTTP requests preserve identity, reject changed replays and cannot enable themselves', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-http-chat-'));
  const app = createWebUI({ root, helper: async () => ({ revision: 'fixture', installed: false, config: { agent: { provider: 'dsh' }, im: { provider: 'disabled', allow_from: [] }, proactive: { timezone: 'Asia/Shanghai' } } }), rpc: async () => { throw new Error('offline'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await app.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const endpoint = app.hub.pair({ provider: 'codex', label: 'existing' }), c = app.hub.newConversation({ endpointId: endpoint.endpointId });
  const pair = app.hub.pairDesktopPet({ label: 'pet', petId: 'main', conversationId: c.id });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const call = (path, input) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA-Channel-Token': pair.token }, body: JSON.stringify(input) });
  const input = { peer: 'main', requestId: 'stable-pet-request-01', text: 'hello' };
  assert.equal((await call('/api/message-bridge/inbound', input)).status, 403);
  assert.equal((await call('/api/hub', { operation: 'enable-pet-chat', channelId: pair.channelId, enabled: true })).status, 403);
  app.hub.enablePetChat({ channelId: pair.channelId, enabled: true });
  assert.equal((await call('/api/message-bridge/inbound', input)).status, 200);
  assert.equal((await call('/api/message-bridge/inbound', input)).status, 200);
  assert.equal(app.hub.all('run').length, 1);
  assert.notEqual((await call('/api/message-bridge/inbound', { ...input, text: 'changed' })).status, 200);
  assert.notEqual((await call('/api/message-bridge/inbound', { ...input, peer: 'other' })).status, 200);
  assert.equal((await call('/api/message-bridge/context', { peer: 'main' })).status, 200);
});
test('login startup recreates a cleared private socket directory without the installer', async t => {
  const root = mkdtempSync('/tmp/pet-reboot-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, 'cleared'), config = { petId: 'main', token: 'r'.repeat(40), socketPath: join(parent, 'chat.sock') };
  const bridge = await startPetChatBridge(config, { petId: 'main' }, { transport: async () => ({}) });
  assert.equal(statSync(parent).mode & 0o777, 0o700);
  assert.equal(statSync(config.socketPath).mode & 0o777, 0o600);
  await bridge.close();
  chmodSync(parent, 0o777);
  await assert.rejects(startPetChatBridge(config, { petId: 'main' }), /PRIVATE_SOCKET_REQUIRED/);
});
