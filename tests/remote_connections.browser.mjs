// Isolated browser acceptance. No OAuth, SSH, real agent, external message or model execution.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = process.env.PA_REMOTE_ARTIFACTS || join(root, '.runtime/verification/native-remote-20261023'); await mkdir(artifacts, { recursive: true });
const cfg = JSON.parse(await readFile(join(root, 'config/pa.example.json')));
const state = { csrf: 'isolated-fixture', config: cfg, revision: 'fixture', installed: true, pending: [], capabilities: [], runtime: { state: 'running', connected: true, owned: false, accounts: [], configurationMatched: true, provider: cfg.agent.provider, configRevision: 'fixture' } };
const baseRemote = () => ({ configured: true, connected: true, state: 'connected', targetDeviceId: 'writing-mac', backend: 'harness', transport: 'LAN', capabilities: { devices: true, sessions: true, workspaces: true, history: true, stream: true, prompt: true, interrupt: true, approval: true, businessTools: false, taskExecution: false } });
const base = () => ({ revision: 1, stateVersion: 1, bridge: { paired: false, online: false }, monitor: { running: true, intervalMs: 15000 }, events: [], remote: baseRemote(), items: ['google', 'files', 'phone', 'github', 'x'].map(id => ({ id, title: id, state: 'unlinked', connectionProvider: ['google', 'github'].includes(id) ? 'nango' : 'local', cloudAvailable: ['google', 'github'].includes(id), permissions: [], scopeDescription: '只读访问' })) });
let snapshot = base(), calls = [], unknownPrompt = false, emptyDevices = false, records, seq, hasMore;
const streams = new Map();
const record = (number, type, data) => ({ type: 'event', event: { seq: number, type, time: 1792742400000 + number * 1000, data, surfaceOp: 'append' } });
const initialRecords = () => [record(11, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把最近的产品反馈归成三个优先事项。' }] }), record(12, 'assistant/message', { message: { content: [{ type: 'text', text: '先解决手机首屏、明确展示失败，再让引导完成一件有用的事。\n下一步可以逐项核对对应页面。' }] } }), record(13, 'turn/end', { reason: { kind: 'completed' } })];
const sessions = () => ({ items: [{ sessionId: 'journal-review', updatedAt: 1792742400000, running: false, cwd: '/work/journal', projections: { values: { title: '手账界面的反馈整理' } } }, { sessionId: 'remote-evaluation', updatedAt: 1792738800000, running: false, cwd: '/work/journal', projections: { values: { title: 'DSH 远程连接方案' } } }] });
const emit = (source, data, sessionId = 'journal-review') => { for (const [response, selected] of streams) if (selected === sessionId) response.write('data: ' + JSON.stringify({ source, data }) + '\n\n'); };
const append = (type, data) => { const value = record(++seq, type, data); records.push(value); emit('session', value); };
function reset() { for (const response of streams.keys()) response.end(); streams.clear(); snapshot = base(); calls = []; unknownPrompt = false; emptyDevices = false; records = initialRecords(); seq = 13; hasMore = true; }
reset();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.local'), path = url.pathname;
  const reply = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
  try {
    if (path === '/api/state') return reply(state);
    if (path === '/api/connections') {
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk; const input = JSON.parse(raw); calls.push({ source: 'connections', ...input });
        assert.equal(req.headers['x-pa-csrf'], state.csrf);
        const value = snapshot.items.find(item => item.id === input.id);
        value.state = 'awaiting_authorization'; value.connectionProvider = 'nango'; value.auth = { verificationUrl: 'https://connect.example.invalid/oauth/fixture', origin: 'https://connect.example.invalid' }; snapshot.revision++;
      }
      return reply(snapshot);
    }
    if (path === '/api/remote-agent/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const selected = url.searchParams.get('sessionId'); streams.set(res, selected); req.on('close', () => streams.delete(res));
      res.write('data: ' + JSON.stringify({ source: 'events', data: { type: 'ready', clientId: 'browser-generation' } }) + '\n\n');
      res.write('data: ' + JSON.stringify({ source: 'session', data: { type: 'snapshot', header: { id: selected }, cursor: seq, records, hasMore, projections: { values: { title: sessions().items.find(item => item.sessionId === selected)?.projections.values.title } } } }) + '\n\n'); return;
    }
    if (path === '/api/remote-agent') {
      if (req.method !== 'POST') return reply(snapshot.remote);
      let raw = ''; for await (const chunk of req) raw += chunk; const input = JSON.parse(raw); calls.push({ source: 'remote', ...input });
      assert.equal(req.headers['x-pa-csrf'], state.csrf);
      if (input.operation === 'devices') return reply(emptyDevices ? [] : [{ deviceId: 'writing-mac', name: '写作 Mac', online: true }, { deviceId: 'offline-mac', name: '离线电脑', online: false }]);
      if (input.operation === 'connect') { assert.equal(input.request.targetDeviceId, 'writing-mac'); snapshot.remote = baseRemote(); return reply(snapshot.remote); }
      if (input.operation === 'disconnect') { snapshot.remote.connected = false; snapshot.remote.state = 'disconnected'; return reply(snapshot.remote); }
      if (input.operation === 'workspaces') return reply([{ workspaceId: 'journal', path: '/work/journal', title: '手账项目' }]);
      if (input.operation === 'openWorkspace') { assert.equal(input.request.path, '/work/journal'); return reply({ accepted: true }); }
      if (input.operation === 'sessions') return reply(sessions());
      if (input.operation === 'history') { assert.deepEqual(input.request.address, { kind: 'session', sessionId: 'journal-review' }); assert.equal(input.request.throughSeq, 13); return reply({ records: [record(9, 'user/message', { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '内部历史注入，不是用户输入。' }] }), record(10, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '保留手账意象，文字要克制。' }] })], hasMore: false }); }
      if (input.operation === 'prompt') {
        assert.equal(input.request.mode, 'queue'); assert.ok(input.request.requestId);
        if (unknownPrompt) return res.end(JSON.stringify({ ok: false, error: 'DSH_REMOTE_OUTCOME_UNKNOWN' }));
        return reply({ accepted: true });
      }
      if (['cancel', 'approval'].includes(input.operation)) return reply({ accepted: true });
      throw new Error('Unexpected operation ' + input.operation);
    }
    const asset = path === '/' ? 'index.html' : path.slice(1);
    if (asset.includes('/') || asset.includes('..') || !/\.(html|js|css)$/.test(asset)) { res.writeHead(404); return res.end(); }
    const body = await readFile(join(root, 'plugins/webui/public', asset));
    res.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(body);
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
if (process.env.PA_REMOTE_SERVE === '1') { console.log(`http://127.0.0.1:${server.address().port}/#connections`); await new Promise(() => {}); }
const url = 'http://xiaoman.test';
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP xiaoman.test 127.0.0.1:${server.address().port}`, '--no-proxy-server'], ...(process.env.PA_BROWSER_CHANNEL ? { channel: process.env.PA_BROWSER_CHANNEL } : {}) });
const results = [];
async function check(name, work, options = {}) {
  reset();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options }), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
  try { await page.goto(url + '/#connections'); await page.locator('[data-r-session="journal-review"]').waitFor(); await work(page); assert.deepEqual(errors, []); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) { await page.screenshot({ path: join(artifacts, name + '-failure.png'), fullPage: true }); throw error; }
  finally { await context.close(); }
}
const select = async page => { await page.locator('[data-r-session="journal-review"]').click(); await page.locator('#r-history .r-message-assistant').first().waitFor(); };
try {
  await check('nango-without-mac-and-origin-bound-authorization', async page => {
    await page.locator('#c-connect-google').click(); assert.equal(await page.locator('#c-google-email').count(), 0);
    await page.getByRole('button', { name: '开始 Google 授权', exact: true }).click(); await page.locator('.c-auth-link').waitFor();
    assert.equal(calls.find(value => value.operation === 'connect' && value.source === 'connections').values.account, undefined);
    assert.equal(await page.locator('.c-auth-link').getAttribute('href'), 'https://connect.example.invalid/oauth/fixture');
    snapshot.items[0].auth.verificationUrl = 'https://evil.invalid/oauth'; await page.evaluate(() => window.PAConnections.refresh());
    assert.equal(await page.locator('.c-auth-link').count(), 0); assert.match(await page.locator('.c-auth-error').textContent(), /不可用/);
    for (const origin of ['http://connect.example.invalid', 'https://user:secret@connect.example.invalid']) {
      snapshot.items[0].auth = { verificationUrl: origin + '/oauth', origin }; await page.evaluate(() => window.PAConnections.refresh());
      assert.equal(await page.locator('.c-auth-link').count(), 0);
    }
  });
  await check('unconfigured-and-empty-devices-never-offer-fake-actions', async page => {
    snapshot.remote.configured = false; await page.evaluate(() => window.PAConnections.refresh());
    assert.equal(await page.locator('#c-remote').count(), 0);
    snapshot.remote.configured = true; snapshot.remote.connected = false; delete snapshot.remote.targetDeviceId; emptyDevices = true;
    await page.evaluate(() => window.PAConnections.refresh());
    await page.getByText('暂无可连接的设备。', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-r-action="connect"]').isDisabled(), true);
    assert.equal(calls.filter(value => value.source === 'remote' && value.operation === 'connect').length, 0);
  });
  await check('existing-local-account-can-authorize-cloud-without-mac', async page => {
    for (const id of ['google', 'github']) {
      const value = snapshot.items.find(item => item.id === id); value.connectionProvider = 'local'; value.state = 'connected'; value.account = 'fixture account';
    }
    await page.evaluate(() => window.PAConnections.refresh());
    for (const id of ['google', 'github']) {
      await page.locator('#c-manage-' + id).click();
      assert.equal(await page.locator('#c-check-' + id).count(), 0);
      await page.locator('#c-connect-' + id).click();
      if (id === 'google') await page.getByText(/通过私有 Nango 授权/).waitFor();
      else {
        await page.getByText('在授权页面连接 GitHub 账号，小满只读取已授权内容。', { exact: true }).waitFor();
        assert.doesNotMatch(await page.locator('#c-dialog-body').textContent(), /GitHub 官方页面/);
      }
      assert.equal(await page.locator('#c-google-email').count(), 0);
      await page.getByRole('button', { name: id === 'google' ? '开始 Google 授权' : '开始 GitHub 授权', exact: true }).click();
      await page.locator('.c-auth-link').waitFor();
      assert.equal(calls.filter(value => value.source === 'connections' && value.id === id && value.operation === 'connect').length, 1);
      await page.getByRole('button', { name: '关闭连接设置', exact: true }).click();
    }
    assert.equal(calls.some(value => value.source === 'connections' && value.operation === 'check'), false);
  });
  await check('cloud-configuration-error-is-visible-and-recovers', async page => {
    snapshot.integrationError = { service: 'nango', code: 'NANGO_CONFIG_UNAVAILABLE' };
    await page.evaluate(() => window.PAConnections.refresh());
    assert.equal(await page.locator('#c-integration-error').isVisible(), true);
    assert.match(await page.locator('#c-integration-error').textContent(), /NANGO_CONFIG_UNAVAILABLE/);
    await page.screenshot({ path: join(artifacts, 'connections-configuration-error.png'), fullPage: true });
    delete snapshot.integrationError; await page.evaluate(() => window.PAConnections.refresh());
    assert.equal(await page.locator('#c-integration-error').isVisible(), false);
  });
  await check('device-choice-workspace-and-keyboard-history', async page => {
    snapshot.remote.connected = false; delete snapshot.remote.targetDeviceId;
    await page.locator('[data-r-action="refresh"]').click(); await page.locator('#r-device-select').selectOption('writing-mac'); await page.locator('[data-r-action="connect"]').click();
    await page.waitForFunction(() => document.querySelector('#r-state').textContent === '已连接');
    assert.equal(calls.find(value => value.source === 'remote' && value.operation === 'connect').request.targetDeviceId, 'writing-mac');
    await page.locator('#r-workspace-form button').click(); await page.waitForFunction(() => !document.querySelector('[data-r-session="journal-review"]').disabled);
    await page.locator('[data-r-session="journal-review"]').focus(); await page.keyboard.press('Enter');
    await page.locator('#r-history .r-message-assistant').waitFor(); await page.locator('[data-r-action="history"]').click();
    await page.getByText('保留手账意象，文字要克制。', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('#r-history').textContent(), /内部历史注入/);
    await page.locator('#r-input').fill('保留的会话草稿'); await page.locator('[data-r-action="back"]').click();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.rSession), 'journal-review');
    await select(page); assert.equal(await page.locator('#r-input').inputValue(), '保留的会话草稿');
  });
  await check('native-source-metadata-keeps-user-text-and-hides-injected-context', async page => {
    const internalKinds = ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context', 'future-producer'];
    for (const kind of internalKinds) records.push(record(++seq, 'user/message', { role: 'user', source: { kind }, content: [{ type: 'text', text: `内部快照：${kind}` }] }));
    records.push(record(++seq, 'user/message', { role: 'user', content: [{ type: 'text', text: '缺失来源的消息不能冒充用户。' }] }));
    const literal = '<system-reminder>这是用户写下的原文。</system-reminder>\nTime sampled 和 available_skills 也必须保留。';
    records.push(record(++seq, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: literal }] }));
    await select(page);
    assert.deepEqual(await page.locator('#r-history .r-message-user p').allTextContents(), ['把最近的产品反馈归成三个优先事项。', literal]);
    assert.equal(await page.locator('#r-history .r-message-assistant').count(), 1);
    assert.equal(await page.locator('#r-history system-reminder').count(), 0);
    assert.doesNotMatch(await page.locator('#r-history').textContent(), /内部快照|缺失来源/);
    for (const kind of internalKinds) append('user/message', { role: 'user', source: { kind }, content: [{ type: 'text', text: `内部实时：${kind}` }] });
    append('assistant/message', { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '真实助手结果仍然保留。' }] } });
    await page.getByText('真实助手结果仍然保留。', { exact: true }).waitFor();
    assert.equal(await page.locator('#r-history .r-message').count(), 4);
    assert.doesNotMatch(await page.locator('#r-history').textContent(), /内部实时/);
    emit('error', { code: 'DSH_REMOTE_STREAM_LOST' });
    await page.locator('[data-r-action="recover"]').waitFor(); await page.locator('[data-r-action="recover"]').click();
    await page.waitForFunction(() => document.querySelector('#r-turn-state').textContent === '' && !document.querySelector('#r-input').disabled);
    assert.deepEqual(await page.locator('#r-history .r-message-user p').allTextContents(), ['把最近的产品反馈归成三个优先事项。', literal]);
    assert.equal(await page.locator('#r-history .r-message-assistant').count(), 2);
    assert.doesNotMatch(await page.locator('#r-history').textContent(), /内部快照|内部实时|缺失来源/);
    assert.equal(calls.filter(value => value.operation === 'prompt').length, 0);
  });
  await check('prompt-receipt-progress-approval-and-result', async page => {
    assert.deepEqual(await page.evaluate(() => ({ isSecureContext, randomUUID: typeof crypto.randomUUID })), { isSecureContext: false, randomUUID: 'undefined' });
    await select(page); await page.locator('#r-input').fill('核对这三个问题，并给出下一步。'); await page.locator('[data-r-action="send"]').click();
    await page.waitForFunction(() => document.querySelector('#r-turn-state').textContent === '已提交，等待执行');
    const prompt = calls.find(value => value.operation === 'prompt'); append('turn/start', { turn: 2 });
    assert.match(prompt.request.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    append('user/message', { source: { kind: 'user', rpcId: prompt.request.requestId }, content: prompt.request.content });
    append('tool/call', { turn: 2, step: 1, callId: 'review-file', name: 'Bash', arguments: JSON.stringify({ command: 'cat review-checklist.md', cwd: '/work/journal' }) });
    emit('events', { type: 'waterfall', event: 'approval/request', eventId: 'approval-a', agentId: 'different-session', approvalHandle: 'foreign', request: { toolName: 'Bash', reason: 'wrong owner' } });
    emit('events', { type: 'waterfall', event: 'approval/request', eventId: 'approval-b', agentId: 'journal-review', approvalHandle: 'owned', request: { callId: 'review-file', toolName: 'Bash', reason: '读取工作区中的核对清单。' } });
    await page.getByLabel('完整工具参数').waitFor(); assert.match(await page.getByLabel('完整工具参数').textContent(), /cat review-checklist\.md/);
    await page.getByRole('button', { name: '仅允许这次' }).click();
    assert.equal(calls.filter(value => value.operation === 'approval').length, 1); assert.equal(calls.find(value => value.operation === 'approval').request.handle, 'owned');
    append('assistant/message', { message: { content: [{ type: 'text', text: '三个问题已记录：手机首屏、错误恢复、引导价值。下一步先逐个检查手机页面。' }] } }); append('turn/end', { reason: { kind: 'completed' } });
    await page.getByText('三个问题已记录：手机首屏、错误恢复、引导价值。下一步先逐个检查手机页面。', { exact: true }).waitFor();
    assert.equal(calls.filter(value => value.operation === 'prompt').length, 1); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: join(artifacts, 'remote-result-1440.png'), fullPage: true });
  });
  await check('cancel-waits-for-terminal-and-lost-stream-keeps-draft', async page => {
    await select(page); append('turn/start', { turn: 2 }); await page.locator('[data-r-action="cancel"]').click();
    await page.waitForFunction(() => document.querySelector('#r-status').textContent.includes('等待远端确认'));
    assert.equal(await page.locator('[data-r-action="cancel"]').isVisible(), true);
    append('turn/end', { reason: { kind: 'aborted' } }); await page.waitForFunction(() => document.querySelector('#r-status').textContent === '本轮已停止。');
    await page.locator('#r-input').fill('断线前尚未提交的草稿'); emit('error', { code: 'DSH_REMOTE_STREAM_LOST' });
    await page.waitForFunction(() => document.querySelector('[data-r-action="send"]').disabled);
    assert.equal(await page.locator('#r-input').inputValue(), '断线前尚未提交的草稿'); assert.equal(calls.filter(value => value.operation === 'prompt').length, 0);
    await page.locator('[data-r-action="recover"]').click(); await page.waitForFunction(() => !document.querySelector('[data-r-action="send"]').disabled);
    assert.equal(calls.filter(value => value.operation === 'prompt').length, 0);
  });
  await check('uncertain-submit-never-replays-or-discards-draft', async page => {
    await select(page); unknownPrompt = true; await page.locator('#r-input').fill('这条消息的回执将丢失'); await page.locator('[data-r-action="send"]').click();
    await page.waitForFunction(() => document.querySelector('#r-turn-state').textContent === '结果待核对');
    const pending = calls.find(value => value.operation === 'prompt');
    append('user/message', { role: 'user', source: { kind: 'time-context', rpcId: pending.request.requestId }, content: [{ type: 'text', text: '内部注入不能确认用户提交。' }] });
    append('assistant/message', { message: { content: [{ type: 'text', text: '用于确认实时事件已处理的助手记录。' }] } });
    await page.getByText('用于确认实时事件已处理的助手记录。', { exact: true }).waitFor();
    assert.equal(await page.locator('#r-turn-state').textContent(), '结果待核对');
    assert.doesNotMatch(await page.locator('#r-history').textContent(), /内部注入不能确认/);
    await page.locator('[data-r-action="recover"]').click(); await page.locator('[data-r-action="acknowledge"]').waitFor();
    assert.equal(await page.locator('[data-r-action="send"]').isDisabled(), true); assert.equal(await page.locator('#r-input').inputValue(), '这条消息的回执将丢失');
    assert.equal(calls.filter(value => value.operation === 'prompt').length, 1);
    await page.locator('[data-r-action="back"]').click(); await select(page);
    assert.equal(await page.locator('[data-r-action="send"]').isDisabled(), true);
    await page.locator('[data-r-action="acknowledge"]').waitFor();
    await page.locator('[data-r-action="acknowledge"]').click(); assert.equal(await page.locator('[data-r-action="send"]').isEnabled(), true);
  });
  await check('read-only-remote-never-enables-prompt-or-approval', async page => {
    snapshot.remote.capabilities.prompt = false; snapshot.remote.capabilities.approval = false;
    await page.locator('[data-r-action="refresh"]').click(); await select(page);
    assert.equal(await page.locator('#r-input').isDisabled(), true); assert.equal(await page.locator('[data-r-action="send"]').isDisabled(), true);
    assert.equal(await page.locator('#r-turn-state').textContent(), '仅查看会话');
    emit('events', { type: 'waterfall', event: 'approval/request', eventId: 'read-only-event', agentId: 'journal-review', approvalHandle: 'read-only', request: { toolName: 'Bash', reason: '当前连接不能审批。' } });
    await page.getByRole('button', { name: '拒绝', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '仅允许这次' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '拒绝', exact: true }).isDisabled(), true);
  });
  await check('approval-needs-matching-complete-durable-arguments', async page => {
    await select(page);
    const approval = (handle, request) => emit('events', { type: 'waterfall', event: 'approval/request', eventId: handle, agentId: 'journal-review', approvalHandle: handle, request: { toolName: 'Bash', reason: '请求执行', ...request } });
    for (const [handle, request, tool] of [
      ['missing-id', {}, undefined],
      ['wrong-tool', { callId: 'wrong' }, { callId: 'wrong', name: 'Write', arguments: '{"path":"note.md"}' }],
      ['bad-json', { callId: 'bad' }, { callId: 'bad', name: 'Bash', arguments: '{"command":' }],
      ['truncated', { callId: 'short' }, { callId: 'short', name: 'Bash', arguments: '{"command":"cat a"}', truncated: true }],
      ['too-long', { callId: 'long' }, { callId: 'long', name: 'Bash', arguments: JSON.stringify({ command: 'a'.repeat(66000) }) }],
    ]) {
      if (tool) append('tool/call', { turn: 2, step: 1, ...tool });
      approval(handle, request); await page.locator(`[data-r-approval="${handle}"]`).waitFor();
      assert.equal(await page.getByRole('button', { name: '仅允许这次' }).count(), 0);
      await page.locator(`[data-r-approval="${handle}"]`).click();
      await page.locator(`[data-r-approval="${handle}"]`).waitFor({ state: 'detached' });
      assert.equal(calls.filter(value => value.operation === 'approval').at(-1).request.decision, 'rejected');
    }
    approval('late-proof', { callId: 'late' }); await page.getByText('尚无可核对的完整操作参数，请在原端处理。').waitFor();
    assert.equal(await page.getByRole('button', { name: '仅允许这次' }).count(), 0);
    append('tool/call', { turn: 2, step: 1, callId: 'late', name: 'Bash', arguments: JSON.stringify({ command: 'printf "<literal>"', cwd: '/work/journal' }) });
    await page.getByRole('button', { name: '仅允许这次' }).waitFor();
    assert.match(await page.getByLabel('完整工具参数').textContent(), /<literal>/);
    assert.equal(await page.locator('#r-turn-state').textContent(), '等待确认');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(artifacts, 'remote-approval.png'), fullPage: true });
    emit('error', { code: 'DSH_REMOTE_STREAM_LOST' });
    await page.getByRole('button', { name: '仅允许这次' }).waitFor({ state: 'detached' });
    assert.equal(calls.filter(value => value.operation === 'approval' && value.request.decision === 'allowed-once').length, 0);
  });
  for (const width of [1440, 768, 390]) await check('responsive-' + width, async page => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('[data-r-session="journal-review"]').evaluate(element => element.getBoundingClientRect().bottom < innerHeight), true);
    await page.screenshot({ path: join(artifacts, `connections-${width}.png`), fullPage: true });
    await select(page); await page.locator('#r-input').fill('从这里继续');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, `remote-session-viewport-${width}.png`) });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(artifacts, `remote-session-${width}.png`), fullPage: true });
    await page.locator('#r-input').focus(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.dataset.rAction), 'send');
  }, { viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
  await writeFile(join(artifacts, 'browser-results.json'), JSON.stringify({ results, externalActions: 0, modelTurns: 0 }, null, 2));
} finally { for (const response of streams.keys()) response.end(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
