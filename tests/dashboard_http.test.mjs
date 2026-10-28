import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ownerSession } from './owner-fixture.mjs';
import { createWebUI } from '../plugins/webui/server.mjs';
import { failure } from '../plugins/agent-hub/store.mjs';
import { uploadAttachment, readAttachment, attachmentForSend } from '../plugins/agent-hub/attachments.mjs';

const LOCAL = { account: 'local', userId: 'owner' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-http-'));
  const settings = { revision: 'test', installed: true, runtimeInstalled: true, socket: join(root, 'not-a-real-socket'), pending: [], capabilities: [],
    config: { owner: '测试用户', agent: { provider: 'dsh' }, im: { provider: 'weixin', access_policy: 'allowlist', allow_from: ['fixture-user'] }, proactive: { enabled: false, timezone: 'Asia/Shanghai' } } };
  const app = createWebUI({ root, helper: async request => { assert.equal(request.action, 'read'); return settings; }, rpc: async () => { throw failure('OFFLINE'); } });
  const token = 'dashboard-http-fixture-token-123456789';
  app.hub.registerHost({ id: 'dsh', label: 'Fixture DSH', provider: 'dsh' }, token);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const home = await ownerSession(root, origin), headers = { Cookie: home.headers.get('set-cookie').split(';')[0] };
  const get = async path => fetch(origin + '/api/' + path, { headers }).then(response => response.json());
  const initial = await get('state'); assert.equal(initial.ok, true);
  const post = async (path, body) => {
    const response = await fetch(origin + '/api/' + path, { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json', 'X-PA-CSRF': initial.data.csrf }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const poll = () => app.hub.poll(token, { runnerId: 'http-fixture', routineGuardVersion: 1 }).job;
  const finish = job => app.hub.event(token, { runId: job.id, lease: job.lease, seq: app.hub.get('run', job.id).seq + 1, type: 'completed', value: '已核对本轮材料。' });
  t.after(async () => { await app.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { app, root, token, origin, get, post, poll, finish };
}

test('guide source reads are owner scoped and never create an empty chapter or change its revision', async t => {
  const f = await fixture(t), before = f.app.journal.store.snapshot(LOCAL);
  const first = await f.get('journal/guide-sources'), again = await f.get('journal/guide-sources');
  assert.deepEqual(first, { ok: true, data: { sources: [], available: false } }); assert.deepEqual(again, first);
  const after = f.app.journal.store.snapshot(LOCAL);
  assert.equal(after.revision, before.revision); assert.deepEqual(after.items, before.items);
  const anonymous = await fetch(f.origin + '/api/journal/guide-sources'); assert.equal(anonymous.status, 403);
  assert.equal((await f.get('journal/guide-sources?account=local&userId=stranger')).error, 'FORBIDDEN');
});

test('exact source references survive retries without growing the prompt or accepting a forged location', async t => {
  const f = await fixture(t), room = f.app.hub.openRoom({ botId: 'xiaoman' });
  const source = f.app.hub.submit({ conversationId: room.id, content: '确切的原始材料', requestId: 'reference-source' }); f.finish(f.poll());
  const other = f.app.hub.submit({ conversationId: room.id, content: '确切的原始材料', requestId: 'reference-other' }); f.finish(f.poll());
  const sourceRef = { conversationId: room.id, messageId: source.message.id };
  const request = { operation: 'send', conversationId: room.id, content: '根据指定原文核对', requestId: 'referenced-send', sourceRefs: [sourceRef], journal: false };
  const first = await f.post('hub', request); assert.equal(first.ok, true, JSON.stringify(first));
  const prompt = f.app.hub.get('run', first.data.run.id).prompt;
  assert.ok(prompt.includes(source.message.id)); assert.ok(!prompt.includes(other.message.id));
  const repeat = await f.post('hub', request); assert.equal(repeat.data.run.id, first.data.run.id);
  assert.equal(f.app.hub.get('run', first.data.run.id).prompt, prompt);
  assert.equal((await f.post('hub', { ...request, sourceRefs: [{ conversationId: room.id, messageId: other.message.id }] })).error, 'CONFLICT');
  assert.equal((await f.post('hub', { ...request, requestId: 'forged-reference', sourceRefs: [{ conversationId: 'wrong-room', messageId: source.message.id }] })).error, 'FORBIDDEN');
  const original = await f.get('hub/message?messageId=' + source.message.id); assert.equal(original.ok, true);
  assert.deepEqual(original.data.message.sourceRef, sourceRef);
  assert.equal((await fetch(f.origin + '/api/hub/message?messageId=' + source.message.id)).status, 403);
  assert.equal(f.app.hub.all('run').length, 3); assert.equal(f.app.hub.all('delivery').length, 0);
});

test('verified legacy room links continue the exact chapter and attachment in the canonical private session', async t => {
  const f = await fixture(t), hub = f.app.hub, room = hub.openRoom({ botId: 'xiaoman' });
  const binding = hub.bind({ channel: 'imessage', account: 'fixture', peer: 'owner', conversationId: room.id });
  assert.notEqual(binding.conversationId, room.id);
  const item = f.app.journal.store.ensureConversation(LOCAL, { conversationId: binding.conversationId, content: '旧渠道事项' });
  const attachment = await uploadAttachment(hub, { conversationId: binding.conversationId, name: '材料.txt', base64: Buffer.from('仅供这一件事使用的资料').toString('base64'), requestId: 'legacy-attachment' });
  const original = hub.submit({ conversationId: binding.conversationId, content: '按资料核对', requestId: 'legacy-input', journalItemId: item.id, attachmentId: attachment.id, source: { channel: 'imessage', account: 'fixture', peer: 'owner' } }); f.finish(f.poll());
  const oldRequest = { operation: 'send', conversationId: binding.conversationId, journalItemId: item.id, content: '来自旧页面的补充', requestId: 'pre-migration-web', journal: false };
  const oldWeb = await f.post('hub', oldRequest); assert.equal(oldWeb.ok, true, JSON.stringify(oldWeb)); f.finish(f.poll());
  assert.equal((await f.post('hub', { operation: 'verify-owner-route', bindingId: binding.id })).ok, true);
  const countBeforeRetry = hub.all('run').length;
  const replay = await f.post('hub', oldRequest); assert.equal(replay.ok, true, JSON.stringify(replay)); assert.equal(replay.data.run.id, oldWeb.data.run.id);
  assert.equal(hub.all('run').length, countBeforeRetry);
  assert.equal((await f.post('hub', { ...oldRequest, content: '改变原话不算重试' })).error, 'CONFLICT');
  const originalRef = await f.get('hub/message?messageId=' + original.message.id);
  assert.equal(originalRef.data.message.conversationId, binding.conversationId); assert.equal(originalRef.data.message.resolvedConversationId, room.id);
  const opened = await f.post('journal/conversation', { itemId: item.id }); assert.equal(opened.data.conversationId, room.id);
  const sent = await f.post('hub', { operation: 'send', conversationId: binding.conversationId, journalItemId: item.id, content: '明确继续这件事', requestId: 'alias-follow', journal: false });
  assert.equal(sent.ok, true, JSON.stringify(sent)); assert.equal(sent.data.run.conversationId, room.id); assert.equal(sent.data.run.journalItemId, item.id); f.finish(f.poll());
  const current = f.app.journal.store.snapshot(LOCAL).items.find(row => row.id === item.id);
  const continued = await f.post('journal/continue', { itemId: item.id, itemVersion: current.version, requestId: 'alias-continue' });
  assert.equal(continued.ok, true, JSON.stringify(continued)); assert.equal(continued.data.conversationId, room.id);
  const job = f.poll(); assert.equal(job.journalItemId, item.id); assert.deepEqual(job.attachmentIds, [attachment.id]);
  const read = readAttachment({ hub, token: f.token, input: { runId: job.id, lease: job.lease, callId: 'read-legacy', arguments: { operation: 'attachment_read', attachmentId: attachment.id } } });
  assert.equal(read.text, '仅供这一件事使用的资料');
  const unrelated = hub.openRoom({ botId: 'maker' }); assert.throws(() => attachmentForSend(hub, unrelated.id, attachment.id), { code: 'ATTACHMENT_EXPIRED' });
  const snapshot = hub.snapshot(room.id); assert.ok(snapshot.messages.filter(row => row.id === original.message.id).every(row => row.resolvedConversationId === room.id));
  assert.ok(snapshot.runs.filter(row => row.id === original.run.id).every(row => row.resolvedConversationId === room.id));
  assert.equal(snapshot.rootTasks.find(row => row.id === original.run.id).resolvedConversationId, room.id);
  assert.equal(f.app.journal.store.snapshot(LOCAL).items.length, 1);
});
