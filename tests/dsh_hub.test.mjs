import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { HubChannel } from '../plugins/agent-hub/channel.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { createRoutineController } from '../plugins/agent-hub/routines.mjs';
import { createConnectionManager } from '../plugins/connections/manager.mjs';
import { nativeSourceReceipts } from '../plugins/agent-hub/dsh.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));

test('native source receipts use effective metadata and current-turn call identity instead of model text', () => {
  const call = (id, url) => ({ type: 'tool/call', data: { callId: id, name: 'web_fetch', arguments: JSON.stringify({ url }) } });
  const result = (id, meta, extra = {}) => ({ type: 'tool/result', time: 100 + Number(id.replace(/\D/g, '') || 0), data: { meta, message: { content: [{ type: 'tool-result', toolCallId: id, isError: false, content: [{ type: 'text', text: '模型声称已完整读取' }], ...extra }] } } });
  const receipts = nativeSourceReceipts([
    result('historical', { statusCode: 200, truncated: false }),
    call('1', 'https://github.com/trending?since=daily#section'), result('1', { statusCode: 200, truncated: true }),
    call('2', 'https://github.com/trending?since=daily'), result('2', { statusCode: 200, truncated: false }),
    call('3', 'https://example.com/missing'), result('3', { statusCode: 404, truncated: false }),
    call('4', 'https://example.com/no-metadata'), result('4', undefined),
    call('5', 'https://example.com/failed'), result('5', { statusCode: 200, truncated: false }, { isError: true }),
    { type: 'tool/call', data: { callId: '6', name: 'web_search', arguments: JSON.stringify({ queries: [' one ', 'two'] }) } },
    result('6', { sources: [{ url: 'https://example.com' }], truncated: true }),
  ]);
  assert.deepEqual(receipts.map(row => [row.source, row.status, row.observedAt]), [
    ['https://github.com/trending?since=daily', 'incomplete', 101],
    ['https://github.com/trending?since=daily', 'completed', 102],
    ['https://example.com/missing', 'failed', 103],
    ['https://example.com/no-metadata', 'incomplete', 104],
    ['https://example.com/failed', 'failed', 105],
    ['search:one', 'incomplete', 106], ['search:two', 'incomplete', 106],
  ]);
  assert.equal(JSON.stringify(receipts).includes('模型声称'), false);
  const validUnicode = 'https://example.com/资料';
  assert.equal(nativeSourceReceipts([call('7', validUnicode), result('7', { statusCode: 200, truncated: false })])[0].source, new URL(validUnicode).href);
  const oversizedUnicode = 'https://example.com/' + '中'.repeat(250);
  assert.ok(oversizedUnicode.length < 2048); assert.ok(new URL(oversizedUnicode).href.length > 2048);
  assert.deepEqual(nativeSourceReceipts([call('8', oversizedUnicode), result('8', undefined, { isError: true })]), [], 'a rejected unrepresentable URL cannot poison the durable event queue');
});

test('real DSH sessions, shared tools, permissions and Codex coexist without a live model or Weixin send', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-native-hub-'));
  let child, hub, channel, log = '';
  t.after(async () => {
    if (child && child.exitCode === null) { process.kill(-child.pid, 'SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]); if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL'); }
    await channel?.close(); hub?.close(); await rm(root, { recursive: true, force: true });
  });
  for (const name of JSON.parse(await readFile(join(source, 'config/distribution.json'), 'utf8')).files) {
    await mkdir(join(root, name, '..'), { recursive: true }); await cp(join(source, name), join(root, name));
  }
  await symlink(join(source, 'node_modules'), join(root, 'node_modules'));
  execFileSync('python3', [join(root, 'scripts/configure.py')]);
  const patchPath = join(root, '.runtime/dsh/profiles/wx-life/cordis.patch.yml');
  const patch = JSON.parse(await readFile(patchPath, 'utf8'));
  patch.find(r => r.id === 'weixin-channel').disabled = true;
  patch.push({ id: 'tools', config: { mode: 'native' } }, { id: 'web', config: { fetchProvider: 'fixture-web' } }, { insert: [{ id: 'hub-fixture', name: join(root, 'tests/dsh_hub_fixture.mjs') }] });
  await writeFile(patchPath, JSON.stringify(patch));
  const env = { ...process.env, DSH_HOME: join(root, '.runtime/dsh'), XIAOMAN_PROJECT_ROOT: root, INTENT_ENABLED: '0' };
  for (const key of ['DEEPSEEK_API_KEY', 'WEIXIN_ILINK_CREDENTIAL', 'PHONE_AGENT_API_KEY', 'PHONE_AGENT_DEVICE_ID']) delete env[key];
  child = spawn(join(root, 'node_modules/.bin/dsh'), ['--profile', 'wx-life', '--no-open', '--port', '0'], { cwd: join(root, '.runtime/workspace'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  hub = new AgentHub(root);
  const until = async predicate => { for (let n = 0; n < 200; n++) { if (predicate()) return; if (child.exitCode !== null) break; await delay(100); } assert.fail(log.slice(-14000)); };
  await until(() => hub.snapshot().endpoints.some(e => e.id === 'dsh' && e.online));
  const sent = [];
  channel = new HubChannel({ root, channel: 'weixin', account: 'fixture', allowed: p => p === 'owner', send: async (_peer, text) => sent.push(text), autoFlush: false });
  await channel.receive({ peer: 'owner', text: '创建待办', requestId: 'wx-one' });
  const c = hub.all('conversation')[0];
  await until(() => hub.all('run')[0]?.status === 'completed' || hub.all('run')[0]?.status === 'failed');
  assert.equal(hub.all('run')[0].status, 'completed', log.slice(-14000));
  assert.equal(hub.all('task')[0]?.title, '原生 DSH 共享待办', log.slice(-10000));
  const session = hub.all('session')[0].nativeSessionId;
  // IM reception is quiet; only the actual result is delivered.
  const inboundRun = hub.all('run')[0];
  const initialDeliveries = hub.all('delivery');
  assert.equal(initialDeliveries.length, 1);
  assert.ok(initialDeliveries.every(d => hub.get('message', d.messageId)?.runId === inboundRun.id));
  for (const delivery of initialDeliveries) { await channel.flush(); assert.equal(hub.get('delivery', delivery.id).state, 'sent'); }
  assert.equal(sent.length, initialDeliveries.length);
  const codex = hub.pair({ label: 'Codex' });
  const codeConversation = hub.newConversation({ endpointId: codex.endpointId });
  const codeRun = hub.submit({ conversationId: codeConversation.id, endpointId: codex.endpointId, content: '独立工作', requestId: 'codex-one' }).run;
  const job = hub.poll(codex.token, { runnerId: 'codex-fixture' }).job;
  hub.event(codex.token, { runId: codeRun.id, lease: job.lease, seq: 1, type: 'approval', value: { id: 'codex-approval', toolName: 'test', reason: 'Hold the Codex lane' } });
  const webRun = hub.submit({ conversationId: c.id, botId: 'xiaoman', content: '继续聊天', requestId: 'web-two' }).run;
  await until(() => hub.all('run').at(-1)?.status === 'completed');
  assert.equal(hub.get('run', codeRun.id).status, 'waiting_approval');
  assert.equal(hub.all('session').find(s => s.endpointId === 'dsh').nativeSessionId, session);
  assert.match(hub.all('message').at(-1).text, /会话轮数 2/);
  assert.equal(hub.all('delivery').some(d => hub.get('message', d.messageId)?.runId === webRun.id), false, 'Web creates no channel delivery');
  await channel.flush(); assert.equal(sent.length, initialDeliveries.length, 'Web does not broadcast to Weixin');
  hub.submit({ conversationId: c.id, botId: 'xiaoman', content: '请求审批', requestId: 'dsh-approval' });
  await until(() => hub.all('approval').some(a => a.id !== 'codex-approval' && a.state === 'pending'));
  const approval = hub.all('approval').find(a => a.id !== 'codex-approval');
  hub.decide({ approvalId: approval.id, allow: false, conversationId: c.id });
  await until(() => hub.all('run').at(-1).status === 'completed');
  assert.match(hub.all('message').at(-1).text, /ACTION_NOT_APPROVED|APPROVAL_REJECTED|APPROVAL_REQUIRED|rejected/i);
  assert.equal(hub.get('approval', 'codex-approval').state, 'pending');
  const allowedRun = hub.submit({ conversationId: c.id, botId: 'xiaoman', content: '允许本次审批', requestId: 'dsh-allow' }).run;
  await until(() => hub.all('approval').some(a => a.runId === allowedRun.id && a.state === 'pending'));
  const allowedApproval = hub.all('approval').find(a => a.runId === allowedRun.id);
  hub.decide({ approvalId: allowedApproval.id, allow: true, conversationId: c.id });
  await until(() => hub.get('run', allowedRun.id).status === 'completed');
  assert.equal(hub.all('task')[0].status, 'cancelled');
  hub.taskAction({ operation: 'reopen', taskId: hub.all('task')[0].id, version: hub.all('task')[0].version, requestId: 'reopen-fixture' });

  const cancelledRun = hub.submit({ conversationId: c.id, botId: 'xiaoman', content: '等待审批时取消', requestId: 'dsh-cancel-approval' }).run;
  await until(() => hub.all('approval').some(a => a.runId === cancelledRun.id && a.state === 'pending'));
  const following = hub.submit({ conversationId: c.id, botId: 'xiaoman', content: '取消后继续聊天', requestId: 'dsh-after-cancel' }).run;
  hub.cancel(cancelledRun.id);
  assert.equal(hub.get('run', cancelledRun.id).status, 'cancelling');
  assert.equal(hub.get('run', following.id).status, 'queued');
  await until(() => hub.get('run', following.id).status === 'completed');
  assert.equal(hub.get('run', cancelledRun.id).status, 'cancelled');
  assert.equal(hub.all('approval').find(a => a.runId === cancelledRun.id).state, 'rejected');
  assert.equal(hub.all('session').find(s => s.endpointId === 'dsh').nativeSessionId, session);
  assert.equal(hub.get('run', codeRun.id).status, 'waiting_approval', 'DSH cancellation cannot affect Codex');
  const artifactPath = join(root, '.runtime/workspace/native-result.md');
  await writeFile(artifactPath, '# Native DSH fixture\n');
  const reported = hub.submit({ conversationId: c.id, botId: 'xiaoman', content: '汇报测试产物', requestId: 'native-report' }).run;
  await until(() => hub.get('run', reported.id).status === 'completed');
  const report = hub.snapshot().runs.find(r => r.id === reported.id).report;
  assert.equal(report?.outcome, 'completed', log.slice(-12000));
  assert.equal(report.artifacts[0].path, artifactPath);
  const health = hub.submit({ conversationId: c.id, botId: 'xiaoman', content: '查询通道状态', requestId: 'native-status' }).run;
  await until(() => ['completed', 'failed'].includes(hub.get('run', health.id).status));
  assert.equal(hub.get('run', health.id).status, 'completed');
  assert.match(hub.all('message').at(-1).text, /imessage/);
  assert.match(hub.all('message').at(-1).text, /bridge_heartbeat/);
  for (const [content, suffix, status] of [['读取完整网页', 'complete', 'completed'], ['读取截断网页', 'incomplete', 'incomplete']]) {
    const run = hub.submit({ conversationId: c.id, botId: 'xiaoman', content, requestId: 'native-web-' + suffix }).run;
    await until(() => ['completed', 'failed'].includes(hub.get('run', run.id).status));
    assert.equal(hub.get('run', run.id).status, 'completed', log.slice(-12000));
    const receipt = hub.all('nativeSourceReceipt').find(row => row.runId === run.id);
    assert.equal(receipt?.source, 'https://example.com/' + suffix);
    assert.equal(receipt?.status, status);
    assert.ok(receipt.observedAt >= run.createdAt);
  }
  const journalStore = new JournalStore(root); t.after(() => journalStore.close());
  const routineController = createRoutineController({ hub, journal: { store: journalStore } });
  const connections = createConnectionManager({ root });
  const sourceBridge = connections.mutate({ operation: 'pair', revision: connections.snapshot().revision, values: { name: 'Native scope fixture' } });
  connections.mutate({ operation: 'grant', id: 'files', revision: connections.snapshot().revision, values: { scope: 'common-folders' } });
  const files = connections.bridgeSnapshot(sourceBridge.token).desired.find(row => row.id === 'files');
  connections.reportBridge(sourceBridge.token, { reports: [{ id: 'files', generation: files.generation, state: 'connected', code: 'ok', permissions: [{ id: 'readable', granted: true, verified: true }] }] });
  connections.close();
  for (const publicWeb of [true, false]) {
    const { routine } = await routineController.action({ operation: 'create', requestId: 'native-scope-' + publicWeb, values: {
      title: '后台范围验收', instruction: '后台范围验收：读取完整网页', endpointId: 'dsh',
      schedule: { time: '09:00', timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5, 6, 7] }, trigger: { mode: 'changed', condition: '完整读取约定网页' },
      scope: { publicWeb, sources: publicWeb ? [] : [{ operation: 'file_read', filter: { rootId: 'fixture' } }] },
    } });
    const queued = await routineController.action({ operation: 'run_now', id: routine.id, version: routine.version, requestId: 'native-scope-run-' + publicWeb });
    await until(() => ['completed', 'failed'].includes(hub.get('run', queued.run.runId).status));
    const executed = hub.get('run', queued.run.runId), receipt = hub.all('nativeSourceReceipt').find(row => row.runId === executed.id);
    assert.equal(executed.status, 'completed', log.slice(-12000));
    assert.equal(receipt?.status, publicWeb ? 'completed' : 'failed');
    assert.equal(executed.routinePublished, publicWeb);
    assert.ok(executed.nativeSessionId);
    assert.equal(hub.all('session').some(row => row.conversationId === routine.conversationId), false, 'Background sessions do not become human chat sessions');
    assert.equal(hub.get('routineRun', queued.run.id).status, publicWeb ? 'published' : 'failed');
  }
});
