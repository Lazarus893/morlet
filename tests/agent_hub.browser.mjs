// Isolated browser acceptance: no real model, Weixin transport, or device.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createWebUI } from '../plugins/webui/server.mjs';
import { AgentCompanion, agentTransport } from '../plugins/agent-hub/companion.mjs';
import { HubChannel } from '../plugins/agent-hub/channel.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
const root = await mkdtemp(join(tmpdir(), 'pa-hub-browser-'));
const config = JSON.parse(await readFile(new URL('../config/pa.example.json', import.meta.url), 'utf8'));
const helper = async () => ({ config, revision: 'fixture', socket: join(root, 'none'), installed: true, runtimeInstalled: true, pending: [] });
const app = createWebUI({ root, helper, rpc: async () => { throw Object.assign(new Error('OFFLINE'), { code: 'OFFLINE' }); } });
let browser, companion, dshCompanion, interval, dshInterval, channel;
try {
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const paired = app.hub.pair({ label: '我的电脑 · Codex' }), conv = app.hub.newConversation({ endpointId: paired.endpointId });
  const sent = []; let sessions = [], approvalSequence = 0;
  channel = new HubChannel({ root, channel: 'weixin', account: 'fixture', allowed: p => p === 'owner', send: async (...args) => sent.push(args) });
  app.hub.bind({ channel: 'weixin', account: 'fixture', peer: 'owner', conversationId: conv.id });
  const localConfig = { endpoint: origin, publicOrigin: origin, token: paired.token, provider: 'codex', workspace: root };
  companion = new AgentCompanion({ config: localConfig, statePath: join(root, 'spool'), transport: agentTransport(localConfig), provider: async (_c, prompt, ctx) => {
    sessions.push(ctx.sessionId); await ctx.onSession('native-browser');
    if (prompt === '新增一个审批验收待办，然后取消它') {
      const sequence = ++approvalSequence;
      const { task } = await ctx.callTool('xiaoman_tasks', { operation: 'add', title: '审批验收待办 ' + sequence }, 'approval-add-' + sequence);
      try {
        const cancelled = await ctx.callTool('xiaoman_tasks', { operation: 'cancel', taskId: task.id, version: task.version }, 'approval-cancel-' + sequence);
        assert.equal(cancelled.task.id, task.id); assert.equal(cancelled.task.status, 'cancelled');
        return { text: '已批准这一次' };
      } catch (error) {
        if (error.code !== 'ACTION_NOT_APPROVED') throw error;
        assert.equal(app.hub.get('task', task.id).status, 'pending');
        return { text: '已拒绝' };
      }
    }
    if (prompt === '失败草稿验收') throw Object.assign(new Error('AGENT_TIMEOUT'), { code: 'AGENT_TIMEOUT' });
    if (prompt === '生成产物') {
      await ctx.callTool('xiaoman_report', { title: '配置说明文档', summary: '文档已整理，等待发布确认。', outcome: 'partial', artifacts: [{ label: '在线预览', url: 'https://example.invalid/preview?fixture=1' }, { label: '本地说明', path: '/tmp/fixture-result.md' }] }, 'browser-report');
      return { text: '完整结果只在对话显示：说明文档、检查细节和执行记录。' };
    }
    if (prompt === '完成验收') {
      await ctx.callTool('xiaoman_report', { title: '配置验收', summary: '验收通过。', outcome: 'completed', artifacts: [] }, 'browser-complete');
      return { text: '本次验收已经完成。' };
    }
    if (prompt === '新增待办') await ctx.callTool('xiaoman_tasks', { operation: 'add', title: '整理书桌' }, 'task-fixture');
    return { text: `本地回复：${prompt}` };
  } });
  interval = setInterval(() => void companion.tick().catch(() => {}), 50);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  const selectAgent = async endpointId => {
    const settings = page.locator('#chat-compose details');
    if (await settings.getAttribute('open') === null) await settings.locator('summary').click();
    await page.locator('#chat-agent-select').selectOption(endpointId);
  };
  // Intranet HTTP has getRandomValues but no randomUUID. Exercise real UI
  // message sends, task mutations and deduplicated retries with that API surface.
  await page.addInitScript(() => Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }));
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  let releaseSnapshot;
  const firstSnapshot = new Promise(resolve => { releaseSnapshot = resolve; });
  const holdInitialSnapshot = async route => { if (route.request().method() === 'GET') await firstSnapshot; await route.continue(); };
  await page.route('**/api/hub', holdInitialSnapshot);
  await page.goto(origin); await page.locator('#nav-chat').click();
  await page.locator('#chat-run-filter').waitFor();
  for (const selector of ['#chat-run-scope', '#chat-run-filter', '#chat-input', '#chat-send', '#chat-new', '#chat-bind']) assert.equal(await page.locator(selector).isDisabled(), true, selector + ' waits for the first snapshot');
  releaseSnapshot();
  await page.locator('#chat-input:not([disabled])').waitFor();
  await page.unroute('**/api/hub', holdInitialSnapshot);
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
  await page.locator('#chat-input').fill('新增待办'); await page.locator('#chat-send').click();
  await page.locator('#chat-messages').getByText('本地回复：新增待办', { exact: true }).waitFor(); await page.locator('#chat-tasks').getByText('整理书桌').waitFor();
  assert.equal(sent.length, 0, 'Web replies must not broadcast to Weixin');
  await page.locator('#chat-tasks').getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('#chat-tasks').getByRole('button', { name: '恢复', exact: true }).waitFor();
  await channel.receive({ peer: 'owner', text: '微信接着聊', requestId: 'wechat-1' });
  await page.locator('#chat-messages').getByText('本地回复：微信接着聊', { exact: true }).waitFor(); await channel.flush();
  assert.equal(sent.length, 1); assert.equal(sessions[1], 'native-browser');
  await page.locator('#chat-input').fill('草稿不应丢失'); await page.waitForTimeout(5500);
  assert.equal(await page.locator('#chat-input').inputValue(), '草稿不应丢失');
  await page.locator('#chat-input').fill('新增一个审批验收待办，然后取消它'); await page.locator('#chat-send').click();
  await page.getByRole('button', { name: '批准这一次', exact: true }).waitFor();
  const approvalTask = app.hub.all('task').find(t => t.title === '审批验收待办 1');
  assert.equal(approvalTask.status, 'pending', 'a typed cancellation must wait for this exact approval');
  await page.getByRole('button', { name: '批准这一次', exact: true }).click();
  await page.locator('#chat-messages').getByText('已批准这一次', { exact: true }).waitFor();
  assert.equal(app.hub.get('task', approvalTask.id).status, 'cancelled');
  assert.equal(app.hub.all('approval').filter(a => a.consumedAt && a.action.parameters.taskId === approvalTask.id).length, 1);
  // Simulate a lost response after the task was durably saved; retry must dedup.
  let dropTaskResponse = true;
  await page.route('**/api/hub', async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON()?.task?.title === '重试只保存一次' && dropTaskResponse) {
      dropTaskResponse = false; await route.fetch(); await route.abort(); return;
    }
    await route.continue();
  });
  await page.locator('#chat-task-title').fill('重试只保存一次');
  await page.locator('#chat-task-add').getByRole('button', { name: '记下' }).click();
  await page.locator('#chat-status').filter({ hasText: '尚未确认服务是否收到了这条消息，输入已保留' }).waitFor();
  await page.waitForTimeout(1700);
  assert.match(await page.locator('#chat-status').textContent(), /尚未确认.*输入已保留/, 'a successful poll must not clear the uncertain write receipt');
  assert.equal(await page.locator('#chat-task-title').inputValue(), '重试只保存一次');
  await page.locator('#chat-task-add').getByRole('button', { name: '记下' }).click();
  await page.waitForFunction(() => document.querySelector('#chat-task-title').value === '');
  assert.equal(app.hub.all('task').filter(t => t.title === '重试只保存一次').length, 1);
  // Both agents remain visible; another conversation can use DSH while Codex waits. The same conversation retains one execution owner.
  const dshToken = 'dsh-browser-fixture-token-0000000000';
  app.hub.registerHost({ id: 'dsh', provider: 'dsh', label: 'DSH' }, dshToken);
  const dshConfig = { provider: 'dsh', label: 'DSH', token: dshToken, workspace: root };
  dshCompanion = new AgentCompanion({ config: dshConfig, statePath: join(root, 'dsh-spool'), transport: async (op, input) => app.hub[op](dshToken, input), provider: async (_cfg, prompt, context) => {
    const list = await context.callTool('xiaoman_tasks', { operation: 'list' }, 'dsh-list');
    assert.equal(list.tasks.find(t => t.title === '整理书桌').status, 'done');
    await context.onSession('dsh-browser-native');
    if (prompt === '从微信继续') await context.callTool('xiaoman_report', { title: '微信入口任务', summary: '需要确认下游配置。', outcome: 'blocked' }, 'dsh-report');
    return { text: 'DSH 已读到 Web 完成的待办：' + prompt };
  } });
  dshInterval = setInterval(() => void dshCompanion.tick().catch(() => {}), 50);
  await page.locator('#chat-input').fill('新增一个审批验收待办，然后取消它'); await page.locator('#chat-send').click();
  await page.getByRole('button', { name: '批准这一次', exact: true }).waitFor();
  const pendingCancellation = app.hub.all('approval').find(a => a.state === 'pending');
  await page.locator('#chat-new').click();
  await page.waitForFunction(() => document.querySelectorAll('.conversation-link').length === 2);
  await page.locator('#chat-agent-select option[value="dsh"]').waitFor({ state: 'attached' });
  await selectAgent('dsh');
  await page.locator('#chat-input').fill('同时继续'); await page.locator('#chat-send').click();
  await page.locator('#chat-messages').getByText('DSH 已读到 Web 完成的待办：同时继续', { exact: true }).waitFor();
  assert.equal(app.hub.get('approval', pendingCancellation.id).state, 'pending', 'another conversation/agent can complete while this approval waits');
  await page.locator(`.conversation-link[data-conversation="${conv.id}"]`).click();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await page.locator('#chat-messages').getByText('已拒绝', { exact: true }).waitFor();
  assert.equal(app.hub.get('approval', pendingCancellation.id).state, 'rejected');
  assert.equal(app.hub.get('task', pendingCancellation.action.parameters.taskId).status, 'pending');
  assert.equal(app.hub.all('conversation').length, 2);
  await channel.receive({ peer: 'owner', text: '/agent dsh 从微信继续', requestId: 'dsh-wx-oneoff' });
  await page.locator('#chat-messages').getByText('DSH 已读到 Web 完成的待办：从微信继续', { exact: true }).waitFor();
  assert.equal(app.hub.conversation(conv.id).endpointId, paired.endpointId, 'one-off routing does not replace default');
  // Task summaries and outputs are shared across conversation and channel boundaries.
  await selectAgent(paired.endpointId);
  await page.locator('#chat-input').fill('生成产物'); await page.locator('#chat-send').click();
  const tracked = page.locator('.chat-tracked-run').filter({ hasText: '配置说明文档' });
  await tracked.getByText('部分完成', { exact: true }).waitFor();
  assert.equal(await tracked.getByRole('link', { name: '在线预览' }).getAttribute('href'), 'https://example.invalid/preview?fixture=1');
  assert.equal(await tracked.getByRole('link', { name: '在线预览' }).getAttribute('rel'), 'noopener noreferrer');
  assert.match(await tracked.textContent(), /本地文件.*未上传/);
  assert.equal(await tracked.locator('a[href^="file:"]').count(), 0);
  assert.equal(await tracked.getByText('完整结果只在对话显示', { exact: false }).count(), 0);
  await tracked.getByRole('button', { name: '执行记录' }).click();
  await page.waitForTimeout(1700);
  assert.equal(await tracked.getByRole('button', { name: '收起记录' }).getAttribute('aria-expanded'), 'true');
  await page.locator('#chat-input').fill('完成验收'); await page.locator('#chat-send').click();
  await page.locator('.chat-tracked-run').filter({ hasText: '配置验收' }).getByText('已完成', { exact: true }).waitFor();
  await page.locator('#chat-run-filter').selectOption('done');
  assert.equal(await page.locator('.chat-tracked-run').count(), 1, 'partial and unreported turns are not completed tasks');
  await page.locator('#chat-run-filter').selectOption('artifacts');
  assert.equal(await page.locator('.chat-tracked-run').count(), 1);
  await page.locator('#chat-new').click();
  await page.waitForFunction(() => document.querySelectorAll('.conversation-link').length === 3);
  const draftConversationId = await page.locator('.conversation-link[aria-current="true"]').getAttribute('data-conversation');
  await page.locator('#chat-input').fill('新对话未发送草稿');
  await page.locator('#chat-run-scope').selectOption('current');
  assert.equal(await page.locator('.chat-tracked-run').count(), 0);
  await page.locator('#chat-run-scope').selectOption('all');
  await tracked.getByRole('button', { name: '打开对话' }).click();
  assert.equal(await page.locator('.conversation-link[aria-current="true"]').getAttribute('data-conversation'), conv.id);
  await page.waitForFunction(() => document.activeElement.matches('.chat-message') && document.activeElement.textContent.includes('生成产物'));
  await page.locator(`.conversation-link[data-conversation="${draftConversationId}"]`).click();
  assert.equal(await page.locator('#chat-input').inputValue(), '新对话未发送草稿', 'opening a tracked run preserves the previous conversation draft');
  await tracked.getByRole('button', { name: '打开对话' }).click();
  await page.waitForFunction(() => document.activeElement.matches('.chat-message') && document.activeElement.textContent.includes('生成产物'));
  // Recovering a failed run from another conversation fetches its actual input without rerunning it.
  await page.locator('#chat-run-filter').selectOption('all');
  await page.locator('#chat-input').fill('失败草稿验收'); await page.locator('#chat-send').click();
  const failedTracked = page.locator('.chat-tracked-run').filter({ has: page.getByRole('heading', { name: '失败草稿验收', exact: true }) });
  await failedTracked.getByText('执行失败', { exact: true }).waitFor();
  await page.locator(`.conversation-link[data-conversation="${draftConversationId}"]`).click();
  assert.equal(await page.locator('#chat-input').inputValue(), '新对话未发送草稿');
  const runsBeforeDraftRecovery = app.hub.all('run').length;
  await failedTracked.getByRole('button', { name: '把交代带回草稿', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#chat-input').value === '失败草稿验收');
  assert.equal(await page.locator('.conversation-link[aria-current="true"]').getAttribute('data-conversation'), conv.id);
  assert.equal(await page.locator('#chat-agent-select').inputValue(), paired.endpointId, 'failed run recovery preserves its original agent');
  assert.equal(app.hub.all('run').length, runsBeforeDraftRecovery, 'bringing back a draft must never execute the failed request');
  await page.locator(`.conversation-link[data-conversation="${draftConversationId}"]`).click();
  assert.equal(await page.locator('#chat-input').inputValue(), '新对话未发送草稿', 'failure recovery must not consume the other conversation draft');
  await page.locator(`.conversation-link[data-conversation="${conv.id}"]`).click();
  assert.equal(await page.locator('#chat-input').inputValue(), '失败草稿验收');
  await page.locator('#chat-input').fill('');
  // Older records remain reachable instead of being discarded after ten turns.
  for (let i = 0; i < 5; i++) {
    const { run } = app.hub.submit({ conversationId: conv.id, content: '历史排队任务 ' + i, requestId: 'history-' + i });
    app.hub.cancel(run.id);
  }
  await page.locator('#chat-run-filter').selectOption('all');
  await page.locator('#chat-runs-more').waitFor({ state: 'visible' });
  await page.locator('#chat-runs-more').click();
  await page.locator('.chat-tracked-run').filter({ has: page.getByRole('heading', { name: '新增待办', exact: true }) }).waitFor();
  await page.locator('#chat-run-filter').selectOption('attention');
  await page.locator('.chat-tracked-run').filter({ hasText: '微信入口任务' }).getByText('任务受阻', { exact: true }).waitFor();
  // Losing a send receipt must not duplicate execution after visiting another conversation.
  await page.locator('#chat-run-filter').selectOption('all');
  await page.locator(`.conversation-link[data-conversation="${conv.id}"]`).click();
  await selectAgent(paired.endpointId);
  await page.locator('#chat-input').fill('新增一个审批验收待办，然后取消它'); await page.locator('#chat-send').click();
  await page.getByRole('button', { name: '批准这一次', exact: true }).waitFor();
  const cancelling = app.hub.all('run').findLast(r => r.status === 'waiting_approval' && r.endpointId === paired.endpointId);
  await page.locator(`[data-run="${cancelling.id}"]`).getByRole('button', { name: '取消执行', exact: true }).click();
  await page.locator(`[data-run="${cancelling.id}"]`).getByText('已取消', { exact: true }).waitFor();
  assert.equal(app.hub.all('approval').find(a => a.runId === cancelling.id).state, 'rejected');
  await page.locator('#chat-input').fill('取消后继续执行'); await page.locator('#chat-send').click();
  await page.locator('#chat-messages').getByText('本地回复：取消后继续执行', { exact: true }).waitFor();
  await selectAgent('dsh');
  let dropSendResponse = true;
  const dropSend = async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON()?.content === '切换对话后重试' && dropSendResponse) {
      dropSendResponse = false; await route.fetch(); await route.abort(); return;
    }
    await route.continue();
  };
  await page.route('**/api/hub', dropSend);
  await page.locator('#chat-input').fill('切换对话后重试'); await page.locator('#chat-send').click();
  await page.locator('#chat-status').filter({ hasText: '尚未确认服务是否收到了这条消息，输入已保留' }).waitFor();
  const otherConversation = app.hub.all('conversation').find(c => c.id !== conv.id);
  await page.locator(`.conversation-link[data-conversation="${otherConversation.id}"]`).click();
  await page.locator('#chat-input').fill('另一个对话正常发送'); await page.locator('#chat-send').click();
  await page.waitForFunction(() => document.querySelector('#chat-input').value === '');
  await page.locator(`.conversation-link[data-conversation="${conv.id}"]`).click();
  assert.equal(await page.locator('#chat-input').inputValue(), '切换对话后重试');
  assert.equal(await page.locator('#chat-agent-select').inputValue(), 'dsh', 'retry preserves the chosen agent');
  await page.locator('#chat-send').click();
  await page.waitForFunction(() => document.querySelector('#chat-input').value === '');
  assert.equal(app.hub.all('run').filter(r => r.prompt === '切换对话后重试').length, 1, 'one execution after lost receipt and conversation switch');
  await page.unroute('**/api/hub', dropSend);

  // A slow receipt preserves newer input and blocks conversation switching until save confirmation.
  let releaseReceipt, markAccepted;
  const receipt = new Promise(resolve => { releaseReceipt = resolve; });
  const accepted = new Promise(resolve => { markAccepted = resolve; });
  const slowSend = async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON()?.content === '慢回执测试') {
      const response = await route.fetch(); markAccepted(); await receipt;
      await route.fulfill({ response }); return;
    }
    await route.continue();
  };
  await page.route('**/api/hub', slowSend);
  await page.locator('#chat-input').fill('慢回执测试'); await page.locator('#chat-send').click();
  await accepted;
  await page.locator('#chat-input').fill('这是下一条草稿');
  await page.locator(`.conversation-link[data-conversation="${otherConversation.id}"]`).click();
  assert.equal(await page.locator('.conversation-link[aria-current="true"]').getAttribute('data-conversation'), conv.id, 'an in-flight save must keep its conversation selected');
  assert.match(await page.locator('#chat-status').textContent(), /正在保存当前操作/);
  releaseReceipt();
  await page.locator('#chat-send:not([disabled])').waitFor();
  await page.locator(`.conversation-link[data-conversation="${otherConversation.id}"]`).click();
  await page.locator(`.conversation-link[data-conversation="${conv.id}"]`).click();
  assert.equal(await page.locator('#chat-input').inputValue(), '这是下一条草稿', 'new draft survives the earlier send receipt');
  await page.unroute('**/api/hub', slowSend);
  await page.locator('#chat-input').fill('');
  await page.locator('#chat-run-filter').selectOption('artifacts');
  await page.evaluate(() => window.scrollTo(0, 0));
  const out = new URL('../_temp/byoa-acceptance/', import.meta.url); await mkdir(out, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('desktop.png', out)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { window.scrollTo(0, 0); const log = document.querySelector('#chat-messages'); log.scrollTop = log.scrollHeight; });
  await page.screenshot({ path: fileURLToPath(new URL('mobile.png', out)), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile must not overflow');
  // Revoking the selected endpoint on another device must not silently route to DSH.
  await selectAgent(paired.endpointId);
  await page.locator('#chat-input').fill('断开授权后保留草稿');
  app.hub.revoke(paired.endpointId);
  await page.waitForFunction(() => document.querySelector('#chat-agent-select').value === '');
  assert.equal(await page.locator('#chat-send').isDisabled(), true);
  assert.equal(await page.locator('#chat-input').inputValue(), '断开授权后保留草稿');
  await selectAgent('dsh');
  assert.equal(await page.locator('#chat-send').isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('Browser acceptance passed: Web send, local result, shared task completion, Weixin continuation, source reply, approval/cancel/next execution, independent-conversation DSH/Codex parallel execution, reports/artifacts and cross-conversation draft recovery, lost-receipt retry across conversations, pending-send switch guard and draft preservation, revoked-agent no reroute, desktop/mobile.');
} finally {
  clearInterval(interval); clearInterval(dshInterval); await dshCompanion?.stop(); await companion?.stop(); await browser?.close(); await channel?.close(); await app.shutdown(); await rm(root, { recursive: true, force: true });
}
