import { saveBot, botSessionKey } from '../plugins/agent-hub/bots.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { AgentCompanion } from '../plugins/agent-hub/companion.mjs';
import { REPORT_TOOL } from '../plugins/agent-hub/reports.mjs';
import { HubChannel } from '../plugins/agent-hub/channel.mjs';
import { acquireCompanionLock } from '../plugins/agent-hub/lock.mjs';
import { statusTool } from '../plugins/agent-hub/status.mjs';
const fixtureAgent = fileURLToPath(new URL('./fake_agent.mjs', import.meta.url));
await chmod(fixtureAgent, 0o755);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pa-hub-')); let now = Date.now();
  const hub = new AgentHub(root, { now: () => now });
  const pairing = hub.pair({ label: 'My local Codex' });
  // This fixture explicitly binds the manager to its fake Codex endpoint.
  saveBot(hub, { id: 'xiaoman', version: 1, values: { endpointId: pairing.endpointId } });
  const c = hub.newConversation({ endpointId: pairing.endpointId });
  t.after(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
  const submit = (content = 'hello', requestId = crypto.randomUUID(), source = { channel: 'web' }) => hub.submit({ conversationId: c.id, content, requestId, source });
  const poll = (more = {}) => hub.poll(pairing.token, { runnerId: 'test-runner', ...more });
  return { root, hub, c, pairing, submit, poll, advance: ms => { now += ms; } };
}

test('iMessage recovery is scoped to a fresh changed database and never makes the channel ready by itself', async t => {
  const f = await fixture(t);
  const channel = f.hub.pairChannel({ peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', conversationId: f.c.id, label: 'Recovery fixture' });
  const fingerprint = 'a'.repeat(64), input = { ready: false, error: 'IMESSAGE_DATABASE_CHANGED', botAddress: 'bot@example.invalid', peer: 'owner@example.invalid', lastInboundAt: 0, pendingInputs: 0, recoveryFingerprint: fingerprint };
  f.hub.channelStatus(channel.token, input);
  assert.throws(() => f.hub.recoverChannel({ channelId: channel.channelId, fingerprint: 'b'.repeat(64) }), { code: 'IMESSAGE_RECOVERY_STALE' });
  f.hub.recoverChannel({ channelId: channel.channelId, fingerprint });
  assert.equal(f.hub.snapshot().channels[0].ready, false);
  assert.equal(f.hub.channelStatus(channel.token, input).recovery.fingerprint, fingerprint);
  assert.equal(f.hub.channelStatus(channel.token, { ...input, recoveryFingerprint: 'b'.repeat(64) }).recovery, undefined);
  f.hub.channelStatus(channel.token, { ...input, pendingInputs: 1 });
  assert.throws(() => f.hub.recoverChannel({ channelId: channel.channelId, fingerprint }), { code: 'IMESSAGE_RECOVERY_PENDING_INPUTS' });
  f.hub.channelStatus(channel.token, input); f.advance(46000);
  assert.throws(() => f.hub.recoverChannel({ channelId: channel.channelId, fingerprint }), { code: 'IMESSAGE_RECOVERY_STALE' });
});

test('background messages without an endpoint do not stall queued user turns', async t => {
  const f = await fixture(t);
  f.hub.message(f.c.id, 'assistant', '替你留意到一条仓库更新。', { channel: 'imessage' });
  f.hub.message(f.c.id, 'user', '/help', { channel: 'weixin' });
  const old = f.hub.message(f.c.id, 'assistant', '旧执行端的回复', { channel: 'web' });
  f.hub.put('message', { ...old, endpointId: 'removed-endpoint' });
  const first = f.submit('活着吗').run, second = f.submit('看看我关注的仓库').run;
  const job = f.poll().job;
  assert.equal(job.id, first.id);
  assert.deepEqual(job.context, [
    { role: 'assistant', agent: 'Mori', text: '替你留意到一条仓库更新。' },
    { role: 'user', agent: 'Mori', text: '/help' },
    { role: 'assistant', agent: 'Mori', text: '旧执行端的回复' },
  ]);
  assert.equal(f.hub.get('endpoint', f.pairing.endpointId).lastSeen, f.hub.now());
  assert.equal(f.hub.get('run', first.id).status, 'running');
  f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '在的。' });
  assert.equal(f.poll().job.id, second.id);
  assert.equal(f.hub.all('run').length, 2);
});

test('native source events enforce the canonical URL bound without consuming a rejected sequence', async t => {
  const f = await fixture(t); f.submit('核对公开来源');
  const job = f.poll().job;
  const event = { runId: job.id, lease: job.lease, seq: 1, type: 'source_receipt', value: { tool: 'web_fetch', source: 'https://example.com/' + '中'.repeat(250), status: 'completed', observedAt: f.hub.now() } };
  assert.throws(() => f.hub.event(f.pairing.token, event), { code: 'INVALID_INPUT' });
  assert.equal(f.hub.get('run', job.id).seq, 0);
  event.value.source = 'https://example.com/资料';
  assert.equal(f.hub.event(f.pairing.token, event).accepted, true);
  assert.equal(f.hub.all('nativeSourceReceipt')[0].source, new URL(event.value.source).href);
});

test('status reads channel-host evidence, separates agents and channels, and omits identities and credentials', async t => {
  const f = await fixture(t); f.submit(); const job = f.poll().job;
  const paired = f.hub.pairChannel({ label: 'Messages', peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', conversationId: f.c.id });
  f.hub.channelStatus(paired.token, { ready: true, peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', lastInboundAt: 0, pendingInputs: 0 });
  f.hub.bind({ channel: 'weixin', account: 'private-account', peer: 'private-peer', conversationId: f.c.id });
  const settings = { revision: 'r1', config: { im: { provider: 'weixin', allow_from: ['private-peer'] } }, socket: '/host-only/socket' };
  const input = { runId: job.id, lease: job.lease, arguments: {} };
  const host = { protocol: 1, configRevision: 'r1', connected: true, lastPollAt: f.hub.now(), account: 'private-account', users: [{ id: 'private-peer', contextToken: 'private-token' }] };
  const options = { hub: f.hub, root: f.root, token: f.pairing.token, input, read: async () => settings,
    rpc: async (path, request) => { assert.equal(path, settings.socket); assert.deepEqual(request, { command: 'pa', operation: 'snapshot' }); return { kind: 'pa', data: host }; } };
  const status = await statusTool(options);
  assert.deepEqual(status.channels.map(c => [c.id, c.state, c.boundToConversation]), [['web', 'enabled', true], ['weixin', 'online', false], ['imessage', 'online', true]]);
  assert.equal(status.agents[0].provider, 'codex');
  for (const secret of ['private-account', 'private-peer', 'private-token', paired.token, f.pairing.token, 'owner@example.invalid']) assert.equal(JSON.stringify(status).includes(secret), false);
  f.advance(100000);
  const stale = await statusTool(options);
  assert.equal(stale.channels[1].state, 'unknown'); assert.equal(stale.channels[2].state, 'offline');
  const unknown = await statusTool({ ...options, read: async () => { throw new Error('permission denied'); } });
  assert.equal(unknown.channels[1].state, 'unknown'); assert.equal(unknown.channels[1].configured, null);
});

test('status rejects wrong leases, unexpected arguments and cancellation while reading health', async t => {
  const f = await fixture(t); f.submit(); const job = f.poll().job;
  const options = { hub: f.hub, root: f.root, token: f.pairing.token, input: { runId: job.id, lease: job.lease, arguments: {} }, read: async () => ({ config: { im: { provider: 'disabled' } } }) };
  await assert.rejects(statusTool({ ...options, input: { ...options.input, lease: 'wrong' } }), { code: 'FORBIDDEN' });
  await assert.rejects(statusTool({ ...options, input: { ...options.input, arguments: { command: 'anything' } } }), { code: 'INVALID_INPUT' });
  assert.equal((await statusTool(options)).channels[1].state, 'disabled');
  await assert.rejects(statusTool({ ...options, read: async () => { f.hub.cancel(job.id); return { config: { im: { provider: 'disabled' } } }; } }), { code: 'FORBIDDEN' });
});

test('task reports persist across handles and completion; duplicate acknowledgements cannot overwrite newer progress', async t => {
  const f = await fixture(t); f.submit('准备结果'); const job = f.poll().job;
  const input = { tool: 'xiaoman_report', runId: job.id, lease: job.lease, callId: 'progress', arguments: { summary: '已整理材料，正在验证', outcome: 'in_progress', artifacts: [{ label: '草稿', path: '/tmp/fixture-result.md' }] } };
  const first = f.hub.tool(f.pairing.token, input);
  const second = { ...input, callId: 'final', arguments: { title: '整理材料', summary: '文档已完成；发布仍在等确认', outcome: 'partial', artifacts: [{ label: '文档', url: 'https://example.invalid/result' }, { label: '本地文件', path: '/tmp/fixture-result.md' }] } };
  f.advance(1000); f.hub.tool(f.pairing.token, second);
  assert.equal(f.hub.get('run', job.id).status, 'running', 'reporting success does not finish the execution');
  const reopened = new AgentHub(f.root); t.after(() => reopened.close());
  assert.deepEqual(reopened.tool(f.pairing.token, input), first);
  assert.equal(reopened.get('run', job.id).report.outcome, 'partial');
  f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '完整结果内容' });
  const run = reopened.snapshot().runs[0];
  assert.equal(run.status, 'completed'); assert.equal(run.report.outcome, 'partial');
  assert.equal(run.report.artifacts.length, 2); assert.equal(run.resultExcerpt, '完整结果内容');
  assert.equal(run.channel, 'web'); assert.equal(run.lease, undefined);
  assert.throws(() => reopened.tool(f.pairing.token, { ...second, callId: 'late' }), { code: 'FORBIDDEN' });
});

test('source coverage counts current-run receipts once and preserves partial, failed and calendar boundaries', async t => {
  const f = await fixture(t); f.submit('细读近两天邮件和接下来两天日程'); const job = f.poll().job;
  let order = 0;
  const receipt = (id, operation, args, result, extra = {}) => f.hub.put('sourceRequest', {
    id, runId: job.id, status: 'completed', createdAt: f.hub.now() + ++order,
    arguments: { operation, ...args }, result: { operation, ...result }, ...extra,
  });
  const messages = Array.from({ length: 20 }, (_, i) => ({ id: `mail-${i + 1}` }));
  receipt('directory', 'mail_search', { query: 'newer_than:2d' }, { messages, returnedCount: 20, coverage: 'metadata_only', truncated: true });
  for (const id of ['mail-1', 'mail-2', 'mail-3', 'mail-4']) receipt(`body-${id}`, 'mail_read', { messageId: id }, { messageId: id, coverage: 'message_body_only', text: '完整的验收正文。', complete: true, truncated: false });
  receipt('body-duplicate', 'mail_read', { messageId: 'mail-1' }, { messageId: 'mail-1', coverage: 'message_body_only', text: '完整的验收正文。', complete: true, truncated: false });
  receipt('body-old-full', 'mail_read', { messageId: 'mail-5' }, { messageId: 'mail-5', coverage: 'message_body_only', text: '先前完整读取的验收正文。', complete: true, truncated: false });
  receipt('body-latest-partial', 'mail_read', { messageId: 'mail-5' }, { messageId: 'mail-5', coverage: 'message_body_only', text: '这次只返回部分验收正文', complete: false, truncated: true });
  receipt('body-failed', 'mail_read', { messageId: 'mail-6' }, {}, { status: 'failed', errorCode: 'SOURCE_TIMEOUT' });
  receipt('body-pending', 'mail_read', { messageId: 'mail-7' }, {}, { status: 'running' });
  receipt('foreign-body', 'mail_read', { messageId: 'mail-8' }, { messageId: 'mail-8', coverage: 'message_body_only', text: '另一次任务的验收正文。', complete: true, truncated: false }, { runId: 'another-run' });
  const from = '2026-10-19T11:40:00+08:00', to = '2026-10-21T11:40:00+08:00';
  receipt('calendar', 'calendar_events', { from, to }, { calendarId: 'primary', window: { from, to }, events: [], truncated: true });
  f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '这几封正文没有明确指派给你的待办。' });
  const reply = f.hub.all('message').find(m => m.runId === job.id && m.role === 'assistant');
  assert.match(reply.text, /本轮读取范围：/);
  assert.match(reply.text, /邮件（newer_than:2d）：列出20封（目录未列全），完整正文4封、部分正文1封，16封尚未完整读取/);
  assert.match(reply.text, /上述统计不包含附件和正文链接/);
  assert.ok(reply.text.includes(`主日历（primary）：${from} 至 ${to}，返回0项（窗口结果未列全）`));
  assert.match(reply.text, /另有1次读取未成功、1次尚未完成，不能据此判断没有内容/);
  assert.equal(reply.text.includes('完整正文5封'), false, 'duplicate reads, an older complete body and another run cannot increase coverage');
});

test('source coverage keeps separate queries and uses the latest directory for each query without adding totals', async t => {
  const f = await fixture(t); f.submit('核对邮件读取范围'); const job = f.poll().job;
  const putSearch = (id, query, count, truncated, createdAt) => f.hub.put('sourceRequest', {
    id, runId: job.id, status: 'completed', createdAt, arguments: { operation: 'mail_search', query },
    result: { operation: 'mail_search', query, coverage: 'metadata_only', messages: Array.from({ length: count }, (_, i) => ({ id: `${query}-${i}` })), returnedCount: count, truncated },
  });
  putSearch('old-directory', 'newer_than:2d', 7, false, f.hub.now());
  putSearch('current-directory', 'newer_than:2d', 20, true, f.hub.now() + 1);
  putSearch('other-query', 'subject:meeting', 3, false, f.hub.now() + 2);
  f.hub.put('sourceRequest', { id: 'failed-search', runId: job.id, status: 'failed', createdAt: f.hub.now() + 3, arguments: { operation: 'mail_search', query: 'subject:invoice' }, errorCode: 'SOURCE_TIMEOUT' });
  f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '这些只是邮件目录，还没读正文。' });
  const reply = f.hub.all('message').find(m => m.runId === job.id && m.role === 'assistant');
  assert.match(reply.text, /邮件（newer_than:2d）：列出20封（目录未列全）/);
  assert.match(reply.text, /邮件（subject:meeting）：列出3封（目录已列全）/);
  assert.equal((reply.text.match(/邮件（newer_than:2d）/g) || []).length, 1);
  assert.doesNotMatch(reply.text, /列出(?:7|23|30)封/);
  assert.doesNotMatch(reply.text, /邮件（subject:invoice）：列出0封/);
  assert.match(reply.text, /1次读取未成功/);
});

test('source coverage without a search persists once across duplicate completion and a reopened hub', async t => {
  const f = await fixture(t); f.submit('继续读这封邮件'); const job = f.poll().job;
  f.hub.put('sourceRequest', { id: 'direct-body', runId: job.id, status: 'completed', createdAt: f.hub.now(), arguments: { operation: 'mail_read', messageId: 'direct-mail' }, result: { operation: 'mail_read', messageId: 'direct-mail', coverage: 'message_body_only', text: '直接读取的验收正文。', complete: true, truncated: false } });
  const completion = { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '已读这封正文，链接没有打开。' };
  f.hub.event(f.pairing.token, completion);
  f.hub.event(f.pairing.token, completion);
  const before = f.hub.all('message').filter(m => m.runId === job.id && m.role === 'assistant');
  assert.equal(before.length, 1);
  assert.match(before[0].text, /完整正文1封/);
  assert.equal((before[0].text.match(/本轮读取范围：/g) || []).length, 1);
  const reopened = new AgentHub(f.root); t.after(() => reopened.close());
  reopened.event(f.pairing.token, completion);
  const after = reopened.all('message').filter(m => m.runId === job.id && m.role === 'assistant');
  assert.deepEqual(after, before, 'completion replay must retain the original receipt-backed reply without creating a duplicate');
});

test('source coverage includes directly read bodies outside every current-run search list once', async t => {
  const f = await fixture(t); f.submit('读搜索结果，也读我指定的邮件'); const job = f.poll().job;
  const receipt = (id, operation, args, result, order) => f.hub.put('sourceRequest', {
    id, runId: job.id, status: 'completed', createdAt: f.hub.now() + order,
    arguments: { operation, ...args }, result: { operation, ...result },
  });
  receipt('directory', 'mail_search', { query: 'newer_than:2d' }, { messages: [{ id: 'aa' }], returnedCount: 1, truncated: false }, 1);
  receipt('direct-first', 'mail_read', { messageId: 'bb' }, { messageId: 'bb', coverage: 'message_body_only', text: '指定邮件的完整正文。', complete: true, truncated: false }, 2);
  receipt('direct-repeat', 'mail_read', { messageId: 'bb' }, { messageId: 'bb', coverage: 'message_body_only', text: '指定邮件的完整正文。', complete: true, truncated: false }, 3);
  f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '已读你指定的邮件，目录那封尚未打开。' });
  const reply = f.hub.all('message').find(m => m.runId === job.id && m.role === 'assistant');
  assert.match(reply.text, /邮件（newer_than:2d）：列出1封（目录已列全），完整正文0封、部分正文0封，1封尚未完整读取/);
  assert.match(reply.text, /另读取未包含在上述列表的正文：完整1封、部分0封/);
  assert.equal((reply.text.match(/另读取未包含在上述列表的正文/g) || []).length, 1);
});

test('reports are lease-scoped, bounded, and reject unsafe artifacts atomically', async t => {
  const f = await fixture(t); f.submit(); const job = f.poll().job;
  const base = { tool: 'xiaoman_report', runId: job.id, lease: job.lease, callId: 'report', arguments: { summary: '有效摘要', outcome: 'in_progress' } };
  const other = f.hub.pair({ label: 'Other' });
  assert.throws(() => f.hub.tool(other.token, base), { code: 'FORBIDDEN' });
  assert.throws(() => f.hub.tool(f.pairing.token, { ...base, lease: 'stale' }), { code: 'FORBIDDEN' });
  const bad = [
    { summary: 'x'.repeat(1201) }, { outcome: 'success' }, { status: 'completed' },
    ...['javascript:alert(1)', 'file:///tmp/result', 'data:text/html,bad', '//example.invalid/file', 'https://secret:password@example.invalid/file'].map(url => ({ artifacts: [{ label: '产物', url }] })),
    { artifacts: [{ label: '相对路径', path: '../secret' }] },
    { artifacts: [{ label: '两种地址', path: '/tmp/file', url: 'https://example.invalid/file' }] },
    { artifacts: Array.from({ length: 13 }, (_, i) => ({ label: 'file', path: '/tmp/' + i })) },
  ];
  for (const args of bad) assert.throws(() => f.hub.tool(f.pairing.token, { ...base, arguments: { ...base.arguments, ...args } }), { code: 'INVALID_REPORT' });
  assert.equal(f.hub.get('run', job.id).report, undefined);
  f.hub.tool(f.pairing.token, { ...base, arguments: { ...base.arguments, artifacts: [{ label: '合法文件', path: '/tmp/report.md' }] } });
  f.hub.tool(f.pairing.token, { ...base, callId: 'preserve', arguments: { summary: '只更新摘要', outcome: 'blocked' } });
  assert.equal(f.hub.get('run', job.id).report.artifacts.length, 1);
  f.hub.tool(f.pairing.token, { ...base, callId: 'clear', arguments: { ...base.arguments, artifacts: [] } });
  assert.deepEqual(f.hub.get('run', job.id).report.artifacts, []);
  f.hub.cancel(job.id);
  assert.throws(() => f.hub.tool(f.pairing.token, { ...base, callId: 'cancelled' }), { code: 'FORBIDDEN' });
});

test('Web, Weixin and iMessage keep owner task receipts while isolating route histories and native sessions without broadcasting', async t => {
  const f = await fixture(t), sent = [], dshToken = 'three-channel-dsh-fixture-token';
  f.hub.registerHost({ id: 'dsh', label: 'DSH', provider: 'dsh' }, dshToken);
  saveBot(f.hub, { id: 'xiaoman', version: f.hub.get('bot', 'xiaoman').version, values: { endpointId: 'dsh' } });
  f.hub.selectEndpoint({ conversationId: f.c.id, endpointId: 'dsh' });
  f.hub.bind({ channel: 'weixin', account: 'wx-fixture', peer: 'owner', conversationId: f.c.id });
  const wx = new HubChannel({ root: f.root, channel: 'weixin', account: 'wx-fixture', allowed: p => p === 'owner', autoFlush: false, send: async (...args) => sent.push(args) });
  const paired = f.hub.pairChannel({ label: 'Fixture Messages', peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', conversationId: f.c.id });
  f.hub.channelStatus(paired.token, { ready: true, peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', lastInboundAt: 0, pendingInputs: 0 });
  const im = new HubChannel({ root: f.root, channel: 'imessage', account: paired.channelId, allowed: p => p === 'owner@example.invalid', autoFlush: false });
  t.after(async () => { await wx.close(); await im.close(); });
  const tools = (token, job) => (name, args, callId) => f.hub.tool(token, { runId: job.id, lease: job.lease, tool: name, arguments: args, callId });
  const finish = (token, job, session, text) => {
    f.hub.event(token, { runId: job.id, lease: job.lease, seq: 1, type: 'session', value: session });
    f.hub.event(token, { runId: job.id, lease: job.lease, seq: 2, type: 'completed', value: text });
  };
  f.submit('Web 建单', 'three-web-create');
  const first = f.hub.poll(dshToken, { runnerId: 'dsh-fixture' }).job, firstTool = tools(dshToken, first);
  const { task } = firstTool('xiaoman_tasks', { operation: 'add', title: '三端互通待办' }, 'add');
  firstTool('xiaoman_report', { summary: `已建立 ${task.id}，待办中`, outcome: 'completed' }, 'report');
  finish(dshToken, first, 'native-dsh-three', 'Web 建单成功');

  f.hub.submit({ conversationId: f.c.id, endpointId: f.pairing.endpointId, content: '准备产物', requestId: 'three-web-artifact' });
  const preparation = f.poll().job, prepareTool = tools(f.pairing.token, preparation);
  assert.equal(prepareTool('xiaoman_tasks', { operation: 'list' }, 'list').tasks[0].id, task.id);
  const artifact = join(f.root, 'acceptance.md'); await writeFile(artifact, `# 验收\n任务 ${task.id}\n手机步骤待验收\n`);
  prepareTool('xiaoman_report', { summary: '文档已生成，手机步骤待验收', outcome: 'partial', artifacts: [{ label: '验收文档', path: artifact }] }, 'report');
  finish(f.pairing.token, preparation, 'native-codex-three', '准备阶段结束');
  assert.equal(f.hub.all('delivery').length, 0);

  const wxInput = { peer: 'owner', text: '微信读取', requestId: 'three-wx-read' };
  await wx.receive(wxInput); await wx.receive(wxInput);
  const wxJob = f.hub.poll(dshToken, { runnerId: 'dsh-fixture' }).job, wxTool = tools(dshToken, wxJob);
  assert.equal(wxJob.sessionId, null, 'Bot identity starts a distinct native session');
  assert.deepEqual(wxTool('xiaoman_tasks', { operation: 'list' }, 'list').tasks[0], task);
  wxTool('xiaoman_report', { summary: `微信读到 ${task.id} pending v1`, outcome: 'completed' }, 'report');
  finish(dshToken, wxJob, 'native-dsh-three', '微信读到同一待办'); await wx.flush(); await wx.flush();
  assert.equal(sent.length, 1); assert.equal(f.hub.channelPoll(paired.token).delivery, null);

  const imInput = { peer: 'owner@example.invalid', text: 'iMessage 完成', requestId: 'three-im-done' };
  await im.receive(imInput); await im.receive(imInput);
  const imJob = f.hub.poll(dshToken, { runnerId: 'dsh-fixture' }).job, imTool = tools(dshToken, imJob);
  assert.equal(imJob.sessionId, null, 'a separate IM route does not inherit another route native context');
  assert.notEqual(imJob.conversationId, wxJob.conversationId);
  assert.equal(JSON.stringify(imJob.continuation).includes('微信读取'), false);
  const doneArgs = { operation: 'done', taskId: task.id, version: task.version };
  const done = imTool('xiaoman_tasks', doneArgs, 'done').task;
  assert.deepEqual(imTool('xiaoman_tasks', doneArgs, 'done').task, done);
  assert.equal(done.status, 'done'); assert.equal(done.version, 2);
  imTool('xiaoman_report', { summary: `iMessage 完成 ${task.id} done v2`, outcome: 'completed' }, 'report');
  finish(dshToken, imJob, 'native-dsh-three', 'iMessage 完成同一待办');
  const delivery = f.hub.channelPoll(paired.token).delivery;
  assert.equal(delivery.text, 'iMessage 完成同一待办');
  f.hub.channelAck(paired.token, { deliveryId: delivery.id, state: 'read' });
  await wx.flush(); assert.equal(sent.length, 1);

  f.hub.submit({ conversationId: f.c.id, endpointId: f.pairing.endpointId, content: 'Web 收尾', requestId: 'three-web-final' });
  const final = f.poll().job, finalTool = tools(f.pairing.token, final);
  assert.equal(final.sessionId, 'native-codex-three');
  assert.deepEqual(finalTool('xiaoman_tasks', { operation: 'list' }, 'list').tasks[0], done);
  await writeFile(artifact, `# 验收\n任务 ${done.id}\n微信读取、iMessage完成、Web核对：done v2\n`);
  finalTool('xiaoman_report', { title: '三端互通验收', summary: `同一任务 ${done.id} 已完成`, outcome: 'completed', artifacts: [{ label: '验收文档', path: artifact }] }, 'report');
  finish(f.pairing.token, final, 'native-codex-three', 'Web 核对成功');
  const reopened = new AgentHub(f.root); t.after(() => reopened.close());
  const snapshot = reopened.snapshot();
  assert.equal(snapshot.conversations.length, 2); assert.equal(snapshot.tasks.length, 1);
  assert.deepEqual(snapshot.runs.map(r => r.channel), ['web', 'web', 'weixin', 'imessage', 'web']);
  assert.ok(snapshot.runs.every(r => r.status === 'completed' && r.report?.summary));
  assert.equal(snapshot.runs[1].report.outcome, 'partial');
  assert.equal(snapshot.runs.at(-1).report.outcome, 'completed');
  assert.equal(snapshot.runs.at(-1).report.artifacts[0].path, artifact);
  assert.match(await readFile(artifact, 'utf8'), /done v2/);
  assert.deepEqual(snapshot.deliveries.map(d => d.state), ['sent', 'read']);
  assert.equal(reopened.all('session').length, 4, 'each route manager, legacy DSH and Codex keep distinct native sessions');
});

test('companion exposes reporting to native agents; a later failure retains the report without marking success', async t => {
  const f = await fixture(t); f.submit();
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'report-spool'), transport: async (op, input) => f.hub[op](f.pairing.token, input), provider: async (_cfg, _prompt, ctx) => {
    assert.deepEqual(ctx.tools.find(t => t.name === 'xiaoman_report'), REPORT_TOOL);
    await ctx.callTool('xiaoman_report', { title: '本地任务', summary: '文件已写入，校验中断', outcome: 'partial' }, 'fixture-report');
    throw Object.assign(new Error('AGENT_TIMEOUT'), { code: 'AGENT_TIMEOUT' });
  } });
  t.after(() => companion.stop());
  await companion.tick(); await companion.execution; await companion.tick();
  const run = f.hub.snapshot().runs[0];
  assert.equal(run.status, 'failed'); assert.equal(run.report.summary, '文件已写入，校验中断');
  assert.equal(run.report.outcome, 'partial'); assert.equal(run.error, 'AGENT_TIMEOUT');
});

test('companion exposes routine contract and fences background mutations before transport', async t => {
  const f = await fixture(t), submitted = f.submit('每天只读核对仓库');
  f.hub.put('routine', { id: 'routine-fixture', version: 1, enabled: true, scope: { publicWeb: true, sources: [] } });
  f.hub.put('run', { ...submitted.run, journalItemId: 'fixture-item', routine: { id: 'routine-fixture', version: 1, occurrenceId: 'today' } });
  const calls = [];
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'routine-spool'),
    transport: async (operation, input) => {
      if (operation === 'tool') { calls.push(input.tool + ':' + input.arguments.operation); return { accepted: true }; }
      return f.hub[operation](f.pairing.token, input);
    }, provider: async (_config, prompt, context) => {
      const schema = context.tools.find(tool => tool.name === 'xiaoman_routines');
      assert.ok(schema.inputSchema.properties.operation.enum.includes('result'));
      assert.match(context.instructions, /outcome=checked/);
      assert.match(context.instructions, /不能把失败写成没有变化/);
      assert.match(context.instructions, /当前轮先 create，收到保存回执后用其 id\/version 调用 run_now/);
      assert.match(context.instructions, /由这次后台巡查作为唯一检查执行/);
      assert.match(context.instructions, /历史消息与旧工具回执不构成本轮立即检查的授权/);
      assert.match(context.instructions, /用户明确要求的一次性研究仍按本轮要求正常执行/);
      assert.match(prompt, /不是新的用户授权/);
      assert.match(prompt, /本次巡查要求/);
      await context.callTool('xiaoman_routines', { operation: 'list' }, 'read-routine');
      await context.callTool('xiaoman_journal', { operation: 'get', itemId: 'fixture-item' }, 'read-journal');
      for (const [name, operation] of [['xiaoman_routines', 'create'], ['xiaoman_routines', 'update'], ['xiaoman_journal', 'add'], ['xiaoman_tasks', 'cancel'], ['xiaoman_memory', 'save']]) await assert.rejects(context.callTool(name, { operation }, name), { code: 'FORBIDDEN' });
      return '只读检查结束';
    } });
  t.after(() => companion.stop());
  await companion.tick(); await companion.execution; await companion.tick();
  assert.deepEqual(calls, ['xiaoman_routines:list', 'xiaoman_journal:get']);
  assert.equal(f.hub.all('delivery').length, 0);
});

test('companion attaches real per-run mail coverage to resumed native tool replies, without carrying prior reads', async t => {
  const f = await fixture(t); let turns = 0;
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'mail-review-spool'),
    transport: async (op, input) => {
      if (op === 'tool' && input.tool === 'xiaoman_sources') return input.arguments.operation === 'mail_search'
        ? { messages: [{ id: 'a' }, { id: 'b' }], truncated: true }
        : { messageId: 'a', text: 'Bounded mail body', complete: true, truncated: false };
      return f.hub[op](f.pairing.token, input);
    }, provider: async (_cfg, _prompt, ctx) => {
      turns++; await ctx.onSession('same-mail-session');
      const listed = await ctx.callTool('xiaoman_sources', { operation: 'mail_search', query: 'newer_than:2d' }, 'search');
      assert.equal(listed.mailReview.searches[0].completeBodies, 0);
      const read = await ctx.callTool('xiaoman_sources', { operation: 'mail_read', messageId: 'a' }, 'body');
      assert.equal(read.mailReview.searches[0].bodiesNotRead, 1);
      assert.equal(read.mailReview.searches[0].conclusionScope, 'read_text_only');
      return { text: 'Read one body; others not assessed.' };
    } });
  t.after(() => companion.stop());
  for (let turn = 0; turn < 2; turn++) { f.submit('看看近两天邮件'); await companion.tick(); await companion.execution; await companion.tick(); }
  assert.equal(turns, 2); assert.equal(f.hub.all('session').length, 1);
});

test('companion lock excludes concurrent starters and is released by process death', async t => {
  const f = await fixture(t), config = join(f.root, 'config.json');
  await writeFile(config, '{}', { mode: 0o600 });
  const module = new URL('../plugins/agent-hub/lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireCompanionLock } from ${JSON.stringify(module)}; acquireCompanionLock(process.argv[1]); process.stdout.write('locked'); setInterval(() => {}, 1000);`, config], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => assert.fail('Lock holder exited before acquiring lock'))]);
  assert.throws(() => acquireCompanionLock(config), { code: 'COMPANION_ALREADY_RUNNING' });
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  const release = acquireCompanionLock(config);
  assert.throws(() => acquireCompanionLock(config), { code: 'COMPANION_ALREADY_RUNNING' });
  release(); release(); acquireCompanionLock(config)();
});

test('Web and Weixin share one native session; inbound and results are idempotent, replies stay at source', async t => {
  const f = await fixture(t), sent = [];
  const channel = new HubChannel({ root: f.root, channel: 'weixin', account: 'acct', allowed: p => p === 'owner', send: async (...args) => sent.push(args) });
  t.after(() => channel.close());
  f.hub.bind({ channel: 'weixin', account: 'acct', peer: 'owner', conversationId: f.c.id });
  assert.equal(await channel.receive({ peer: 'stranger', text: 'hi', requestId: 'bad' }), false);
  await channel.receive({ peer: 'owner', text: 'first', requestId: 'one', contextToken: 'PRIVATE_CONTEXT' });
  await channel.receive({ peer: 'owner', text: 'first', requestId: 'one', contextToken: 'PRIVATE_CONTEXT' });
  const { job } = f.poll(); assert.equal(f.hub.all('run').length, 1);
  assert.deepEqual(job.source, { channel: 'weixin' });
  assert.equal(JSON.stringify(job).includes('PRIVATE_CONTEXT'), false);
  const event = (seq, type, value) => f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq, type, value });
  event(1, 'session', 'native-123'); event(2, 'completed', 'first answer'); event(2, 'completed', 'first answer');
  await channel.flush(); assert.equal(sent.length, 1); assert.equal(sent[0][0], 'owner');
  f.hub.submit({ conversationId: f.c.id, botId: 'xiaoman', content: 'continue', requestId: 'continue' }); const next = f.poll().job; assert.equal(next.sessionId, 'native-123');
  f.hub.event(f.pairing.token, { runId: next.id, lease: next.lease, seq: 1, type: 'completed', value: 'Web answer' });
  await channel.flush(); assert.equal(sent.length, 1);
  const snapshot = f.hub.snapshot(); assert.equal(snapshot.messages.length, 4);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_CONTEXT'), false);
  assert.equal(JSON.stringify(snapshot).includes(f.pairing.token), false);
});

test('lease expiry never reruns work; cancel fences late results and frees queued work', async t => {
  const f = await fixture(t); const first = f.submit(); f.submit('next'); const job = f.poll().job;
  f.advance(46000); assert.equal(f.poll().job, null); assert.equal(f.hub.get('run', job.id).status, 'uncertain');
  f.hub.cancel(first.run.id, true);
  assert.equal(f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: 'late' }).accepted, false);
  assert.ok(f.poll().job); assert.equal(f.hub.all('message').some(m => m.text === 'late'), false);
});

test('reset and its receipt commit together without cancelling work or manufacturing conversations', async t => {
  const f = await fixture(t);
  const channel = new HubChannel({ root: f.root, channel: 'weixin', account: 'acct', allowed: () => true, autoFlush: false });
  t.after(() => channel.close());
  f.hub.bind({ channel: 'weixin', account: 'acct', peer: 'owner', conversationId: f.c.id });
  f.submit(); f.submit('queued'); f.poll();
  const reset = { peer: 'owner', text: '/reset', requestId: 'reset-once' };
  await Promise.all([channel.receive(reset), channel.receive(reset)]);
  assert.equal(f.hub.all('conversation').length, 1);
  assert.deepEqual(f.hub.all('run').map(r => r.status), ['running', 'queued']);
  const next = f.hub.binding('weixin', 'acct', 'owner').conversationId;
  assert.equal(next, f.c.id);
  const epoch = f.hub.conversation(next).contextEpoch;
  await channel.receive(reset); assert.equal(f.hub.all('conversation').length, 1); assert.equal(f.hub.conversation(next).contextEpoch, epoch);
  await channel.receive({ peer: 'owner', text: 'start again', requestId: 'after-reset' });
  assert.equal(f.hub.all('run').at(-1).conversationId, next);
  assert.equal(f.poll().job, null, 'the new context waits until in-flight work finishes');
});

test('approvals bind to one conversation and endpoint; denial, expiry and duplicate decisions fail closed', async t => {
  const f = await fixture(t); f.submit(); const job = f.poll().job;
  const other = f.hub.pair({ label: 'Other' });
  const event = { runId: job.id, lease: job.lease, seq: 1, type: 'approval', value: { id: 'approve-me', toolName: 'Shell', reason: 'read fixture' } };
  assert.throws(() => f.hub.event(other.token, event), { code: 'FORBIDDEN' });
  f.hub.event(f.pairing.token, event);
  assert.throws(() => f.hub.decide({ approvalId: 'approve-me', allow: true, conversationId: 'other' }), { code: 'ITEM_NOT_FOUND' });
  f.hub.decide({ approvalId: 'approve-me', allow: false, conversationId: f.c.id });
  assert.throws(() => f.hub.decide({ approvalId: 'approve-me', allow: true }), { code: 'CONFLICT' });
  assert.equal(f.poll({ active: { id: job.id, lease: job.lease } }).approvals[0].state, 'rejected');
  f.hub.revoke(f.pairing.endpointId); assert.throws(() => f.poll(), { code: 'BRIDGE_UNAUTHORIZED' });
  assert.throws(() => f.submit('after revocation'), { code: 'ENDPOINT_UNAVAILABLE' });
});

test('ordered events, optimistic task versions and tool idempotency survive separate database handles', async t => {
  const f = await fixture(t); f.submit(); const job = f.poll().job;
  const other = new AgentHub(f.root); t.after(() => other.close());
  assert.throws(() => f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: 2, type: 'completed', value: 'out of order' }), { code: 'EVENT_ORDER' });
  const input = { runId: job.id, lease: job.lease, callId: 'call-1', arguments: { operation: 'add', title: 'Shared task' } };
  const result = f.hub.tool(f.pairing.token, input); assert.deepEqual(other.tool(f.pairing.token, input), result);
  const task = result.task;
  other.taskAction({ operation: 'done', taskId: task.id, version: 1, requestId: 'web-1' });
  assert.equal(f.hub.all('task')[0].status, 'done');
  assert.throws(() => f.hub.taskAction({ operation: 'cancel', taskId: task.id, version: 1, requestId: 'stale' }), { code: 'VERSION_CONFLICT' });
});

test('ambiguous channel delivery is not retried, including after restart', async t => {
  const f = await fixture(t); let attempts = 0;
  const source = { channel: 'weixin', account: 'a', peer: 'p' };
  f.hub.reply(f.c.id, 'once', source);
  const channel = new HubChannel({ root: f.root, channel: 'weixin', account: 'a', allowed: () => true, send: async () => { attempts++; throw new Error('lost acknowledgement'); } });
  await channel.flush(); await channel.flush(); await channel.close();
  assert.equal(attempts, 1); assert.equal(f.hub.all('delivery')[0].state, 'unknown');
});

test('Codex refreshes obsolete native tools while retaining the Hub conversation, notebook and handoff', async t => {
  const f = await fixture(t), journalItemId = 'stable-notebook-item';
  const seen = [], nativeIds = ['initial-native', 'initial-native', 'refreshed-native', 'refreshed-native'];
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'tool-upgrade-spool'), transport: async (operation, input) => f.hub[operation](f.pairing.token, input),
    provider: async (_config, prompt, context) => {
      const index = seen.length;
      seen.push({ sessionId: context.sessionId, knownTools: context.knownTools });
      assert.equal(context.sessionId || null, [null, 'initial-native', null, 'refreshed-native'][index]);
      assert.match(prompt, /本轮情况说明写给人读/); // Also reaches native resumes that retain earlier system instructions.
      if (index === 2) {
        assert.deepEqual(context.knownTools, []);
        assert.match(prompt, /只检查关注仓库，不检查全网热门/);
        assert.match(prompt, /第一次已核对的真实摘要/);
        assert.ok(prompt.includes(f.c.id));
        assert.ok(prompt.includes(journalItemId));
      }
      await context.onSession(nativeIds[index]);
      await context.onCapabilities(nativeIds[index], context.tools.map(tool => tool.name));
      await context.callTool('xiaoman_report', { summary: index === 0 ? '第一次已核对的真实摘要' : '本轮保留原事项', outcome: 'completed' }, 'report-' + index);
      return { text: '本轮完成' };
    } });
  t.after(() => companion.stop());
  for (let index = 0; index < 4; index++) {
    if (index === 2) {
      const session = f.hub.get('session', botSessionKey(f.hub.all('run').at(-1)));
      f.hub.put('session', { ...session, tools: session.tools.filter(tool => tool !== 'xiaoman_routines') });
    }
    f.hub.submit({ conversationId: f.c.id, journalItemId, content: index === 0 ? '只检查关注仓库，不检查全网热门' : '继续同一事项 ' + index, requestId: 'refresh-' + index });
    await companion.tick(); await companion.execution; await companion.tick();
  }
  assert.equal(f.hub.all('conversation').length, 1);
  assert.deepEqual(f.hub.all('run').map(run => run.journalItemId), Array(4).fill(journalItemId));
  assert.equal(f.hub.all('run').every(run => run.status === 'completed'), true);
  assert.equal(f.hub.get('session', botSessionKey(f.hub.all('run').at(-1))).nativeSessionId, 'refreshed-native');
});

test('companion resumes same session and durably replays results after a lost response without rerunning', async t => {
  const f = await fixture(t); let calls = 0, drop = true;
  f.submit('first');
  const transport = async (op, args) => { const r = f.hub[op](f.pairing.token, args); if (op === 'event' && args.type === 'completed' && drop) { drop = false; throw new Error('offline'); } return r; };
  const config = { provider: 'codex', workspace: f.root, command: fixtureAgent, timeout_seconds: 10 };
  const provider = async (_config, _prompt, context) => { calls++; const sessionId = context.sessionId || 'local-session'; await context.onSession(sessionId); await context.onCapabilities(sessionId, context.tools.map(tool => tool.name)); return { text: 'result' }; };
  const companion = new AgentCompanion({ config, statePath: join(f.root, 'local-state'), transport, provider });
  t.after(() => companion.stop());
  await companion.tick(); await companion.execution;
  await assert.rejects(companion.tick());
  await companion.tick(); assert.equal(calls, 1); assert.equal(f.hub.all('message').filter(m => m.role === 'assistant').length, 1);
  f.submit('second'); await companion.tick(); await companion.execution; await companion.tick();
  assert.equal(calls, 2); assert.equal(f.hub.get('session', JSON.stringify([f.c.id, f.pairing.endpointId])).nativeSessionId, 'local-session');
});

test('real Codex protocol fixture executes through companion and hub without contacting a model', async t => {
  const f = await fixture(t); f.submit();
  const config = { provider: 'codex', command: fixtureAgent, workspace: f.root, timeout_seconds: 10 };
  const companion = new AgentCompanion({ config, statePath: join(f.root, 'local'), transport: async (op, args) => f.hub[op](f.pairing.token, args) });
  t.after(() => companion.stop());
  await companion.tick(); await companion.execution; await companion.tick();
  assert.equal(f.hub.all('run')[0].status, 'completed');
  assert.equal(f.hub.all('message').at(-1).text, 'fixture reply');
});

test('cancellation waits for local acknowledgement before another run can use its native session', async t => {
  const f = await fixture(t); f.submit(); f.submit('next');
  let entered;
  const start = new Promise(resolve => { entered = resolve; });
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'cancel-spool'), transport: async (op, input) => f.hub[op](f.pairing.token, input), provider: async (_c, _p, ctx) => {
    entered(); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true })); throw new Error('AGENT_CANCELLED');
  } });
  t.after(() => companion.stop());
  await companion.tick(); await start;
  const first = f.hub.all('run')[0]; f.hub.cancel(first.id);
  assert.equal(f.poll().job, null);
  await companion.tick();
  assert.equal(f.hub.get('run', first.id).status, 'cancelling');
  await companion.flush();
  assert.equal(f.hub.get('run', first.id).status, 'cancelled');
  assert.ok(f.poll().job);
});

test('companion crash reports uncertainty and does not restart a claimed native turn', async t => {
  const f = await fixture(t); f.submit(); const job = f.poll().job;
  const { writeFile } = await import('node:fs/promises');
  const statePath = join(f.root, 'crash-spool');
  await writeFile(statePath, JSON.stringify({ runnerId: 'test-runner', active: { ...job, seq: 0 }, events: [] }), { mode: 0o600 });
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath, transport: async (op, input) => f.hub[op](f.pairing.token, input), provider: async () => assert.fail('Must not rerun a crashed task') });
  await companion.tick(); assert.equal(f.hub.get('run', job.id).status, 'uncertain'); assert.equal(f.poll().job, null); await companion.stop();
});

test('unconfirmed native cancellation stays uncertain and cannot release the next companion job', async t => {
  const f = await fixture(t); f.submit(); f.submit('next');
  const entered = Promise.withResolvers();
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'uncertain-cancel-spool'),
    transport: async (op, input) => f.hub[op](f.pairing.token, input), provider: async (_config, _prompt, ctx) => {
      entered.resolve();
      await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('AGENT_CONNECTION_UNCERTAIN'), { code: 'AGENT_CONNECTION_UNCERTAIN' });
    } });
  t.after(() => companion.stop());
  await companion.tick(); await entered.promise;
  const run = f.hub.all('run')[0]; f.hub.cancel(run.id);
  await companion.tick(); await companion.flush();
  assert.equal(f.hub.get('run', run.id).status, 'uncertain');
  assert.equal(f.poll().job, null);
});

test('long native responses finish the run without wedging its durable event queue', async t => {
  const f = await fixture(t); f.submit();
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'long-output'), transport: async (op, input) => f.hub[op](f.pairing.token, input), provider: async () => ({ text: '长回复'.repeat(6000) }) });
  t.after(() => companion.stop());
  await companion.tick(); await companion.execution; await companion.tick();
  assert.equal(f.hub.all('run')[0].status, 'completed');
  assert.equal(companion.state.events.length, 0);
  const text = f.hub.all('message').at(-1).text;
  assert.ok(text.length <= 16000); assert.match(text, /完整内容请在本地 Agent/);
});

test('shutdown waits for an in-flight claim and never launches its late-arriving job', async t => {
  const f = await fixture(t); f.submit();
  const claimed = Promise.withResolvers(), release = Promise.withResolvers();
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'shutdown-race'), provider: async () => assert.fail('No model may start after shutdown'), transport: async (op, input) => {
    const result = f.hub[op](f.pairing.token, input);
    if (op === 'poll') { claimed.resolve(); await release.promise; }
    return result;
  } });
  const tick = companion.tick(); await claimed.promise;
  const stopped = companion.stop(); release.resolve(); await Promise.all([tick, stopped]);
  assert.equal(f.hub.all('run')[0].status, 'failed');
  assert.equal(f.hub.all('run')[0].error, 'AGENT_COMPANION_STOPPED');
});

test('iMessage binding rejects self and duplicate pairs; re-pairing preserves inbound deduplication and rotates credentials', async t => {
  const f = await fixture(t);
  const options = { label: 'Messages', peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', conversationId: f.c.id };
  assert.throws(() => f.hub.pairChannel({ ...options, botAddress: options.peer.toUpperCase() }), { code: 'IMESSAGE_IDENTITIES_REQUIRED' });
  const first = f.hub.pairChannel(options);
  assert.throws(() => f.hub.pairChannel({ ...options, peer: options.peer.toUpperCase() }), { code: 'IMESSAGE_ALREADY_BOUND' });
  const source = { channel: 'imessage', account: first.channelId, peer: options.peer };
  const submitted = f.submit('one input', 'native-guid', source);
  const channel = f.hub.get('channelEndpoint', first.channelId);
  f.hub.put('channelEndpoint', { ...channel, active: false });
  const next = f.hub.pairChannel(options);
  assert.equal(next.channelId, first.channelId); assert.notEqual(next.token, first.token);
  assert.throws(() => f.hub.authenticateChannel(first.token), { code: 'BRIDGE_UNAUTHORIZED' });
  assert.equal(f.hub.authenticateChannel(next.token).id, first.channelId);
  assert.equal(f.submit('one input', 'native-guid', source).run.id, submitted.run.id);
  assert.equal(f.hub.all('run').length, 1); assert.equal(f.hub.all('message').length, 1);
});

test('iMessage accepts only configured direct incoming messages, persists cursor, and never replays ambiguous sends', async t => {
  const { IMessageCompanion } = await import('../plugins/agent-hub/imessage.mjs');
  const f = await fixture(t), paired = f.hub.pairChannel({ label: 'Messages on Mac', peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', conversationId: f.c.id });
  let sends = 0;
  const router = new HubChannel({ root: f.root, channel: 'imessage', account: paired.channelId, allowed: p => p === 'owner@example.invalid', autoFlush: false }); t.after(() => router.close());
  const transport = async (op, value) => op === 'inbound' ? { accepted: await router.receive(value) } : op === 'poll' ? f.hub.channelPoll(paired.token) : op === 'status' ? f.hub.channelStatus(paired.token, value) : f.hub.channelAck(paired.token, value);
  const options = { config: { chatId: 42, peer: 'owner@example.invalid', botAddress: 'bot@example.invalid' }, statePath: join(f.root, 'messages-spool'), check: async () => {}, database: { baseline: () => ({ generation: 'fixture', cursor: 1 }), inspect: () => ({ service: 'iMessage', is_from_me: 0, destination_caller_id: 'bot@example.invalid' }) }, transport, send: async () => { sends++; throw new Error('send timed out after possible submission'); } };
  const messages = new IMessageCompanion(options); t.after(() => messages.close());
  const row = { created_at: new Date().toISOString(), id: 1, chat_id: 42, is_from_me: false, is_group: false, sender: 'owner@example.invalid', guid: 'guid-one', text: 'hello', attachments: [] };
  messages.accept({ ...row, is_from_me: true }); messages.accept({ ...row, id: 2, is_group: true }); messages.accept({ ...row, id: 3, sender: 'stranger@example.invalid' });
  messages.accept({ ...row, id: 4 }); await messages.tick(); assert.equal(f.hub.all('run').length, 1);
  const job = f.poll().job; f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: 'answer' });
  await messages.tick(); assert.equal(sends, 1);
  const restart = new IMessageCompanion(options); t.after(() => restart.close()); assert.equal(restart.state.cursor, 4); restart.accept({ ...row, id: 4 }); await restart.tick();
  assert.equal(sends, 1); assert.equal(f.hub.all('delivery')[0].state, 'unknown');
  assert.throws(() => f.hub.authenticate(paired.token), { code: 'BRIDGE_UNAUTHORIZED' });
  assert.throws(() => f.hub.authenticateChannel(f.pairing.token), { code: 'BRIDGE_UNAUTHORIZED' });
  restart.accept({ ...row, id: 5, guid: 'attachment-only', text: null, attachments: [{ filename: 'photo.jpg' }] });
  assert.equal(restart.state.incoming[0].text, '');
  assert.equal(restart.state.incoming[0].attachments, true);
});

test('WorkBuddy uses only the per-turn MCP relay and can mutate the same shared task store', async t => {
  const { createToolRelay } = await import('../plugins/agent-hub/tool-relay.mjs');
  const { TASK_TOOL } = await import('../plugins/agent-hub/companion.mjs');
  const { JsonProcess } = await import('../plugins/agent-bridge/process.mjs');
  const f = await fixture(t); f.submit(); const job = f.poll().job;
  const relay = await createToolRelay((name, args, callId) => f.hub.tool(f.pairing.token, { runId: job.id, lease: job.lease, arguments: args, callId }), [TASK_TOOL]);
  const spec = relay.mcpServers.xiaoman;
  const rejected = await fetch(spec.env.PA_TOOL_URL, { method: 'POST', headers: { 'X-PA-Tool-Token': 'ü'.repeat(64) }, body: '{}' });
  assert.equal(rejected.status, 403, 'non-ASCII token must not crash the local relay');
  const saved = { url: process.env.PA_TOOL_URL, token: process.env.PA_TOOL_TOKEN }; Object.assign(process.env, spec.env);
  const proc = new JsonProcess(spec.command, spec.args, { cwd: f.root, timeoutMs: 5000 });
  try {
    assert.equal((await proc.request('initialize', { protocolVersion: '2024-11-05' })).serverInfo.name, 'xiaoman-tasks');
    assert.equal((await proc.request('tools/list', {})).tools[0].name, 'xiaoman_tasks');
    const result = await proc.request('tools/call', { name: 'xiaoman_tasks', arguments: { operation: 'add', title: 'WorkBuddy shared task' } });
    assert.equal(result.isError, undefined); assert.equal(f.hub.all('task')[0].title, 'WorkBuddy shared task');
    assert.equal(JSON.stringify(spec).includes(f.pairing.token), false);
  } finally {
    proc.close(); await proc.exited.promise; await relay.close();
    if (saved.url === undefined) delete process.env.PA_TOOL_URL; else process.env.PA_TOOL_URL = saved.url;
    if (saved.token === undefined) delete process.env.PA_TOOL_TOKEN; else process.env.PA_TOOL_TOKEN = saved.token;
  }
});

test('configured default creates separate authorized Weixin conversations; observations include Web and exclude another agent', async t => {
  const f = await fixture(t), observed = [];
  await writeFile(join(f.root, '.runtime/agent-hub.json'), JSON.stringify({ version: 1, agents: [], roles: { conversation: f.pairing.endpointId } }), { mode: 0o600 });
  const channel = new HubChannel({ root: f.root, channel: 'weixin', account: 'acct', allowed: p => ['one', 'two'].includes(p), autoFlush: false, observe: async m => observed.push(m) });
  t.after(() => channel.close());
  assert.equal(await channel.receive({ peer: 'stranger', text: 'private', requestId: 'bad' }), false);
  assert.equal(f.hub.all('binding').length, 0);
  await channel.receive({ peer: 'one', text: '今天散步', requestId: 'one' }); await channel.observePending();
  const c = f.hub.binding('weixin', 'acct', 'one').conversationId;
  await channel.receive({ peer: 'two', text: '另一身份', requestId: 'two' }); await channel.observePending();
  assert.notEqual(f.hub.binding('weixin', 'acct', 'two').conversationId, c);
  f.hub.submit({ conversationId: c, content: 'Web 继续生活事项', requestId: 'web' });
  const other = f.hub.pair({ label: 'Other Codex' });
  f.hub.submit({ conversationId: c, endpointId: other.endpointId, content: '编程任务不要交给生活观察', requestId: 'other' });
  await channel.observePending(); await channel.observePending();
  assert.deepEqual(observed.map(m => m.text), ['今天散步', '另一身份', 'Web 继续生活事项']);
  assert.equal(observed.at(-1).peer, 'one');
});

test('DSH and Codex retain separate sessions but an uncertain task fences the same conversation', async t => {
  const f = await fixture(t), token = 'host-token-fixture-0000000000000000';
  f.hub.registerHost({ id: 'dsh', label: 'DSH', provider: 'dsh' }, token);
  const a = f.submit('Codex 工作').run, codex = f.poll().job;
  f.hub.event(f.pairing.token, { runId: a.id, lease: codex.lease, seq: 1, type: 'session', value: 'codex-native' });
  f.advance(46000); f.hub.snapshot();
  f.hub.submit({ conversationId: f.c.id, endpointId: 'dsh', content: 'DSH 工作', requestId: 'dsh' });
  assert.equal(f.hub.poll(token, { runnerId: 'dsh-fixture' }).job, null);
  f.hub.cancel(a.id, true);
  const dsh = f.hub.poll(token, { runnerId: 'dsh-fixture' }).job;
  assert.equal(dsh.sessionId, null);
  assert.match(JSON.stringify(dsh.context), /Codex 工作/);
  f.hub.event(token, { runId: dsh.id, lease: dsh.lease, seq: 1, type: 'session', value: 'dsh-native' });
  f.hub.event(token, { runId: dsh.id, lease: dsh.lease, seq: 2, type: 'completed', value: '完成' });
  f.hub.revoke(f.pairing.endpointId);
  f.hub.selectEndpoint({ conversationId: f.c.id, endpointId: 'DSH' });
  f.submit('DSH 继续');
  assert.equal(f.hub.poll(token, { runnerId: 'dsh-fixture' }).job.sessionId, 'dsh-native');
  assert.equal(f.hub.all('session').find(s => s.endpointId === f.pairing.endpointId).nativeSessionId, 'codex-native');
});
