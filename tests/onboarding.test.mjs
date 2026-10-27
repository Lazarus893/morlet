import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { AgentHub, failure } from '../plugins/agent-hub/store.mjs';
import { createWebUI } from '../plugins/webui/server.mjs';

const SCRIPT = new URL('../plugins/webui/public/onboarding.js', import.meta.url);
const context = vm.createContext({ window: {} });
vm.runInContext(await readFile(SCRIPT, 'utf8'), context, { filename: fileURLToPath(SCRIPT) });
const derive = context.window.PAOnboarding.derive;
const NOW = Date.parse('2026-10-14T10:30:00+08:00');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  return {
    state: {
      revision: 'settings-1', installed: false, runtimeInstalled: false, pending: [], capabilities: [],
      localAgentAvailable: false, agentRouting: { conversation: null, journalDesigner: null },
      config: { agent: { provider: 'codex' }, im: { provider: 'disabled', access_policy: 'allowlist', allow_from: [] }, proactive: { timezone: 'Asia/Shanghai' } },
      runtime: { state: 'offline', connected: false, accounts: [], configRevision: null, processState: 'stopped' },
      login: { state: 'idle' },
      journal: { revision: 0, items: [], layout: { source: 'basic', widgets: [] }, design: { status: 'idle', baseRevision: 0 }, designAvailable: false, designReason: '尚未绑定手账设计 Agent，当前使用基础排版。' },
    },
    hub: { roles: {}, endpoints: [], channels: [], conversations: [], bindings: [], messages: [], runs: [], tasks: [], approvals: [], deliveries: [] },
    connections: { revision: 0, stateVersion: 0, bridge: { paired: false, online: false, name: '', lastSeenAt: null }, items: [] },
    errors: {},
  };
}
function endpoint(f, more = {}) {
  const row = { id: 'codex-home', label: '家里的 Codex', provider: 'codex', active: true, online: true, lastSeen: NOW, ...more };
  f.hub.endpoints.push(row);
  f.hub.roles.conversation = row.id;
  f.state.agentRouting.conversation = row.id;
  return row;
}
function enableWeixin(f) {
  f.state.config.im.provider = 'weixin';
  f.state.runtime = { state: 'running', connected: true, account: 'wx-account-fixture', accounts: [{ account: 'wx-account-fixture', live: true, users: [] }], configRevision: f.state.revision, lastPollAt: NOW };
}
function recordedJournal(f, design = { status: 'idle', baseRevision: 1 }) {
  f.state.journal = { revision: 1, items: [{ id: 'birthday', title: '周六给妈妈过生日', status: 'active', version: 1, createdAt: '2026-10-14T10:00:00+08:00' }], layout: { source: 'basic', widgets: [{ id: 'birthday:agenda', kind: 'agenda', itemId: 'birthday' }] }, design, designAvailable: true };
}

test('an absent snapshot is unknown rather than a completed onboarding, while Web remains an independent entrance', () => {
  const result = derive({ state: null, hub: null, connections: null, errors: {} });
  assert.equal(result.agents.state, 'unknown');
  assert.equal(result.journal.state, 'unknown');
  assert.equal(result.channels.web.state, 'available');
  assert.notEqual(result.channels.weixin.state, 'received');
  assert.notEqual(result.channels.imessage.state, 'exchanged');
});

test('a known empty instance requires an Agent without requiring any IM or optional permission', () => {
  const result = derive(fixture());
  assert.equal(result.agents.state, 'missing');
  assert.equal(result.agents.endpoints.length, 0);
  assert.equal(result.channels.weixin.state, 'disabled');
  assert.equal(result.channels.imessage.state, 'unpaired');
  assert.equal(result.channels.web.state, 'available');
  assert.equal(result.journal.state, 'empty');
  assert.equal(result.optional.bridge.paired, false);
  assert.equal(result.nextStep, 1);
});

test('CLI discovery and starting a host process do not create an online or execution-verified Agent', () => {
  const f = fixture();
  f.state.installed = true;
  f.state.runtimeInstalled = true;
  f.state.localAgentAvailable = true;
  f.state.runtime.processState = 'running';
  const result = derive(f);
  assert.equal(result.agents.cliInstalled, true);
  assert.equal(result.agents.state, 'missing');
  assert.equal(result.agents.endpoints.length, 0);
  assert.equal(result.nextStep, 1);
});

test('a paired offline endpoint and a later heartbeat have different states; heartbeat alone is unverified execution', () => {
  const f = fixture(), agent = endpoint(f, { online: false, lastSeen: 0 });
  assert.equal(derive(f).agents.state, 'offline');
  agent.online = true; agent.lastSeen = NOW;
  const result = derive(f);
  assert.equal(result.agents.state, 'online');
  assert.equal(result.agents.endpoints[0].execution, 'unverified');
  assert.equal(result.nextStep, 3);
  assert.equal(result.channels.weixin.state, 'disabled');
  assert.equal(result.channels.web.state, 'available');
});

test('an Agent final reply without a structured completed report does not certify a task outcome', () => {
  const f = fixture(), agent = endpoint(f);
  f.hub.runs.push({ id: 'dinner-run', endpointId: agent.id, conversationId: 'dinner', channel: 'web', status: 'completed', resultExcerpt: '我查到了两家店，尚未订座。', createdAt: NOW - 3000, finishedAt: NOW });
  let result = derive(f);
  assert.equal(result.agents.endpoints[0].execution, 'replied');
  assert.notEqual(result.agents.state, 'verified');
  f.hub.runs[0].report = { outcome: 'partial', summary: '候选已整理，订座尚未提交。', updatedAt: NOW };
  result = derive(f);
  assert.notEqual(result.agents.endpoints[0].execution, 'verified');
  assert.notEqual(result.agents.state, 'verified');
});

test('a completed report becomes an execution receipt only after the run ends and cannot fabricate a journal save', () => {
  const f = fixture(), agent = endpoint(f);
  f.hub.runs.push({ id: 'birthday-report', endpointId: agent.id, status: 'running', createdAt: NOW, report: { outcome: 'completed', summary: '已整理生日准备方案，未写入账本。', updatedAt: NOW } });
  let result = derive(f);
  assert.equal(result.agents.endpoints[0].execution, 'unverified');
  assert.equal(result.journal.state, 'empty');
  f.hub.runs[0].status = 'completed';
  f.hub.runs[0].finishedAt = NOW + 1;
  result = derive(f);
  assert.equal(result.agents.endpoints[0].execution, 'verified');
  assert.equal(result.agents.state, 'verified');
  assert.equal(result.journal.state, 'empty');
  assert.equal(result.journal.count, 0);
});

test('revoked endpoints are not offered as current Agent connections', () => {
  const f = fixture();
  endpoint(f, { active: false, online: false });
  const result = derive(f);
  assert.equal(result.agents.state, 'missing');
  assert.equal(result.agents.endpoints.length, 0);
});

test('disabling WeChat takes precedence over an old connected account and old inbound messages', () => {
  const f = fixture();
  f.state.runtime = { state: 'running', connected: true, account: 'wx-account-fixture', configRevision: f.state.revision, lastPollAt: NOW, accounts: [] };
  f.hub.messages.push({ id: 'wx-old', role: 'user', channel: 'weixin', text: '昨天请帮我记下生日', createdAt: NOW - 86400000 });
  assert.equal(derive(f).channels.weixin.state, 'disabled');
});

test('offline historical WeChat account data does not prove a current login', () => {
  const f = fixture(); f.state.config.im.provider = 'weixin';
  f.state.runtime.accounts = [{ account: 'wx-account-fixture', live: false, users: [{ id: 'owner-fixture', lastInboundAt: NOW - 86400000 }] }];
  const result = derive(f);
  assert.equal(result.channels.weixin.loggedIn, false);
  assert.equal(result.channels.weixin.state, 'not_logged_in');
});

test('a new QR attempt and saved but unapplied allowlist cannot borrow success from an older account', () => {
  const f = fixture(); enableWeixin(f);
  f.state.config.im.allow_from = ['owner-fixture'];
  f.state.login.state = 'waiting';
  let result = derive(f);
  assert.equal(result.channels.weixin.loggedIn, false);
  assert.notEqual(result.channels.weixin.state, 'received');
  f.state.login.state = 'failed';
  assert.equal(derive(f).channels.weixin.loggedIn, false);
  f.state.login.state = 'connected';
  f.state.runtime.configRevision = 'settings-before-allowlist';
  result = derive(f);
  assert.equal(result.channels.weixin.state, 'configuration_pending');
  assert.notEqual(result.channels.weixin.state, 'received');
});

test('a failed runtime status is unknown even if its payload retains the previous connected flag', () => {
  const f = fixture(); enableWeixin(f); f.state.config.im.allow_from = ['owner-fixture'];
  f.state.runtime.state = 'unavailable';
  const result = derive(f);
  assert.equal(result.channels.weixin.state, 'unknown');
  assert.equal(result.channels.weixin.loggedIn, false);
});

test('WeChat login, allowing a sender and receiving a new message advance three separate facts', () => {
  const f = fixture(); enableWeixin(f);
  assert.equal(derive(f).channels.weixin.state, 'awaiting_identity');
  f.state.config.im.allow_from = ['owner-fixture'];
  assert.equal(derive(f).channels.weixin.state, 'awaiting_inbound');
  f.hub.messages.push({ id: 'assistant-only', conversationId: 'wx-chat', role: 'assistant', channel: 'weixin', text: '你好', createdAt: NOW });
  assert.equal(derive(f).channels.weixin.hasInbound, false);
  f.hub.messages.push({ id: 'wx-user', conversationId: 'wx-chat', role: 'user', channel: 'weixin', text: '周六生日帮我准备一下', createdAt: NOW + 1 });
  f.state.runtime.accounts[0].users.push({ id: 'owner-fixture', lastInbound: NOW + 1 });
  const result = derive(f);
  assert.equal(result.channels.weixin.state, 'received');
  assert.equal(result.channels.weixin.hasInbound, true);
  assert.equal(result.channels.weixin.allowedCount, 1);
  assert.equal(result.channels.weixin.deliveredCount, 0);
});

test('a Mac iMessage heartbeat with a permission error is connected but is not ready to receive', () => {
  const f = fixture();
  f.hub.channels.push({ id: 'imac', channel: 'imessage', label: '专用 Mac', active: true, ready: false, connected: true, online: false, error: 'IMESSAGE_CHAT_ACCESS_REQUIRED', lastSeen: NOW });
  const result = derive(f).channels.imessage;
  assert.equal(result.paired, true);
  assert.equal(result.online, false);
  assert.equal(result.hasInbound, false);
  assert.equal(result.state, 'needs_attention');
});

test('delivery receipts are attributed by the assistant message channel, and submission is not delivery', () => {
  const f = fixture(); enableWeixin(f); f.state.config.im.allow_from = ['owner-fixture'];
  f.state.runtime.accounts[0].users.push({ id: 'owner-fixture', lastInbound: NOW });
  f.hub.channels.push({ id: 'imac', channel: 'imessage', active: true, ready: true, online: true, connected: true });
  f.hub.bindings.push(
    { id: 'wx-bind', channel: 'weixin', account: 'wx-account-fixture', peer: 'owner-fixture', conversationId: 'shared' },
    { id: 'im-bind', channel: 'imessage', account: 'imac', peer: 'owner@example.invalid', conversationId: 'shared' },
  );
  f.hub.messages.push(
    { id: 'wx-in', conversationId: 'shared', role: 'user', channel: 'weixin', text: '交代生日准备', createdAt: NOW },
    { id: 'im-in', conversationId: 'shared', role: 'user', channel: 'imessage', text: '继续看候选', createdAt: NOW + 1 },
    { id: 'wx-reply', conversationId: 'shared', role: 'assistant', channel: 'weixin', text: '已经记下', createdAt: NOW + 2 },
    { id: 'im-reply', conversationId: 'shared', role: 'assistant', channel: 'imessage', text: '候选已整理', createdAt: NOW + 3 },
  );
  f.hub.deliveries.push(
    { id: 'wx-reply', conversationId: 'shared', state: 'submitted' },
    { id: 'im-reply', conversationId: 'shared', state: 'read' },
    { id: 'missing-message', conversationId: 'shared', state: 'delivered' },
  );
  let result = derive(f);
  assert.equal(result.channels.weixin.submittedCount, 1);
  assert.equal(result.channels.weixin.deliveredCount, 0);
  assert.equal(result.channels.imessage.deliveredCount, 1);
  assert.equal(result.channels.imessage.state, 'exchanged');
  f.hub.deliveries[0].state = 'sent';
  result = derive(f);
  assert.equal(result.channels.weixin.sentCount, 1);
  assert.equal(result.channels.weixin.deliveredCount, 0);
});

test('a fresh Mac bridge and one verified phone permission do not imply that phone recording is authorized', () => {
  const f = fixture(); endpoint(f);
  f.connections.bridge = { paired: true, online: true, name: '我的 Mac', lastSeenAt: NOW };
  f.connections.items.push({ id: 'phone', title: '手机', state: 'connected', permissions: [
    { id: 'paired', label: '设备配对', granted: true, verified: true },
    { id: 'device', label: '设备可达', granted: true, verified: true },
    { id: 'automation', label: '手机自动化', granted: true, verified: true },
    { id: 'recording', label: '手机录屏', granted: false, verified: false },
  ] });
  const result = derive(f), phone = result.optional.services.find(row => row.id === 'phone');
  assert.equal(result.optional.bridge.online, true);
  assert.equal(phone.verifiedCount, 3);
  assert.equal(phone.allVerified, false);
  assert.equal(phone.permissions.find(row => row.id === 'recording').verified, false);
  assert.equal(result.nextStep, 3, 'optional phone recording must not block the Web conversation');
});

test('a granted but unverified permission and an empty permission list never count as all verified', () => {
  const f = fixture();
  f.connections.items.push(
    { id: 'google', title: 'Google', state: 'checking', permissions: [{ id: 'gmail', label: '邮件', granted: true, verified: false }] },
    { id: 'github', title: 'GitHub', state: 'connected', permissions: [] },
    { id: 'files', title: '本地文件', state: 'limited', scopeDescription: '用户目录、下载、文档（只读）', permissions: [{ id: 'readable', granted: true, verified: true }, { id: 'full_disk', granted: false, verified: false }] },
  );
  const result = derive(f);
  for (const service of result.optional.services) assert.equal(service.allVerified, false, service.id);
  assert.equal(result.optional.services.find(row => row.id === 'google').verifiedCount, 0);
  assert.equal(result.optional.services.find(row => row.id === 'files').verifiedCount, 1);
});

test('connection API failure does not invalidate a known online Agent or a recorded journal, and Hub failure cannot reuse its green cached state', () => {
  const f = fixture(); endpoint(f); recordedJournal(f);
  f.errors.connections = 'CONTROL_TIMEOUT';
  let result = derive(f);
  assert.equal(result.agents.state, 'online');
  assert.equal(result.journal.state, 'recorded');
  assert.equal(result.optional.bridge.state, 'unknown');
  f.errors = { hub: 'CONTROL_TIMEOUT' };
  result = derive(f);
  assert.equal(result.agents.state, 'unknown');
  assert.ok(result.agents.endpoints.every(row => row.online === false && row.execution === 'unverified'));
  assert.equal(result.journal.state, 'recorded');
});

test('an expired page session requests page recovery rather than reusing an online endpoint or suggesting that the saved journal was lost', () => {
  const f = fixture(); endpoint(f); recordedJournal(f);
  f.errors.hub = { code: 'FORBIDDEN', message: 'PREVIOUS_SESSION_ERROR_TEXT' };
  let result = derive(f);
  assert.equal(result.sessionExpired, true);
  assert.equal(result.errorCodes.hub, 'FORBIDDEN');
  assert.equal(result.agents.state, 'unknown');
  assert.ok(result.agents.endpoints.every(row => row.online === false));
  assert.equal(result.journal.state, 'recorded');
  assert.equal(result.journal.count, 1);
  assert.match(result.errors.hub, /刷新页面/);
  assert.doesNotMatch(result.errors.hub, /PREVIOUS_SESSION_ERROR_TEXT/);
  f.errors = { connections: { code: 'CONTROL_TIMEOUT', message: '设备状态读取超时' } };
  result = derive(f);
  assert.equal(result.sessionExpired, false);
  assert.equal(result.agents.state, 'online');
  assert.equal(result.optional.bridge.state, 'unknown');
  assert.equal(result.journal.state, 'recorded');
});

test('design failure and a missing designer role preserve the saved birthday rather than requiring the user to submit it again', () => {
  const f = fixture(); recordedJournal(f, { status: 'failed', baseRevision: 1, errorCode: 'DESIGN_FAILED', error: '整理未完成，现有事项仍可使用' });
  let result = derive(f);
  assert.equal(result.journal.state, 'recorded');
  assert.equal(result.journal.count, 1);
  assert.equal(result.journal.design.state, 'failed');
  f.state.journal.design = { status: 'idle', baseRevision: 1 };
  f.state.journal.designAvailable = false;
  f.state.agentRouting.journalDesigner = null;
  result = derive(f);
  assert.equal(result.journal.state, 'recorded');
  assert.equal(result.journal.design.state, 'unavailable');
});

test('a stale ready design cannot certify a newer journal revision as model-designed', () => {
  const f = fixture(); recordedJournal(f, { status: 'ready', baseRevision: 0 });
  f.hub.roles.journalDesigner = 'design-agent';
  f.state.journal.layout.source = 'agent';
  assert.notEqual(derive(f).journal.design.state, 'ready');
  f.state.journal.design.baseRevision = 1;
  assert.equal(derive(f).journal.design.state, 'ready');
});

test('derivation is side-effect free and resumes an existing instance without changing pairing, preferences or saved records', () => {
  const f = fixture(); endpoint(f); recordedJournal(f);
  f.connections.bridge = { paired: true, online: false, name: '已配对 Mac', lastSeenAt: NOW - 100000 };
  f.state.journal.preferences = { autoLayout: false, pinned: ['birthday:agenda'], hidden: [], motion: 'off' };
  const before = structuredClone(f);
  const first = plain(derive(f)), second = plain(derive(f));
  assert.deepEqual(f, before);
  assert.deepEqual(first, second);
  assert.equal(first.journal.state, 'recorded');
  assert.equal(first.optional.bridge.paired, true);
  assert.equal(first.optional.bridge.online, false);
  assert.equal(first.nextStep, 3);
});

test('actual Hub pairing and heartbeat expiry cannot be mistaken for permanent execution readiness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'onboarding-hub-')); let now = NOW;
  const hub = new AgentHub(root, { now: () => now });
  t.after(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
  const pair = hub.pair({ label: '本机测试 Codex' });
  const f = fixture(); f.hub = hub.snapshot();
  assert.equal(derive(f).agents.state, 'offline');
  hub.poll(pair.token, { runnerId: 'onboarding-test', claim: false });
  f.hub = hub.snapshot();
  assert.equal(derive(f).agents.state, 'online');
  assert.equal(derive(f).agents.endpoints[0].execution, 'unverified');
  now += 46000; f.hub = hub.snapshot();
  assert.equal(derive(f).agents.state, 'offline');
});

test('actual Hub journal links contain only deduplicated done saved receipts belonging to the corresponding run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'onboarding-receipts-'));
  const hub = new AgentHub(root, { now: () => NOW });
  t.after(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
  const pairing = hub.pair({ label: '离线回执测试端' });
  const conversation = hub.newConversation({ endpointId: pairing.endpointId });
  const { run } = hub.submit({ conversationId: conversation.id, requestId: 'birthday-case', content: '请记下生日准备' });
  const { run: otherRun } = hub.submit({ conversationId: conversation.id, requestId: 'reading-case', content: '记录阅读计划' });
  const effect = (key, state, saved, itemId, prefix = 'journal', target = run.id) => hub.put('effect', {
    id: `${prefix}:${target}:${key}`, state, digest: 'PRIVATE_PAYLOAD_DIGEST',
    result: { saved, item: { id: itemId, title: 'PRIVATE_ITEM_TEXT' }, privateToken: 'PRIVATE_EFFECT_TOKEN' },
  });
  effect('saved-a', 'done', true, 'birthday');
  effect('saved-again', 'done', true, 'birthday');
  effect('saved-b', 'done', true, 'birthday-shopping');
  effect('pending', 'pending', true, 'not-confirmed');
  effect('uncertain', 'uncertain', true, 'uncertain-save');
  effect('rejected', 'done', false, 'unsaved');
  effect('foreign-kind', 'done', true, 'foreign-kind-item', 'other');
  effect('other-run', 'done', true, 'reading', 'journal', otherRun.id);
  const snapshot = hub.snapshot();
  assert.deepEqual(snapshot.runs.find(row => row.id === run.id).journalItemIds, ['birthday', 'birthday-shopping']);
  assert.deepEqual(snapshot.runs.find(row => row.id === otherRun.id).journalItemIds, ['reading']);
  for (const secret of ['PRIVATE_PAYLOAD_DIGEST', 'PRIVATE_ITEM_TEXT', 'PRIVATE_EFFECT_TOKEN', pairing.token]) assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test('real HTTP serves only the public onboarding resources; public JavaScript does not authorize the onboarding state APIs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'onboarding-http-'));
  const f = fixture();
  const helper = async request => {
    assert.equal(request.action, 'read');
    return { ...structuredClone(f.state), socket: join(root, 'offline.sock') };
  };
  const app = createWebUI({ root, helper, rpc: async () => { throw failure('OFFLINE'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await app.shutdown(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const boundedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const home = await boundedFetch(origin), cookie = home.headers.get('set-cookie').split(';')[0];
  const html = await home.text();
  assert.match(html, /onboarding\.js/);
  assert.match(html, /onboarding\.css/);
  for (const path of ['/onboarding.js', '/onboarding.css']) {
    const response = await boundedFetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(response.headers.get('content-type'), path.endsWith('.js') ? /text\/javascript/ : /text\/css/);
    assert.ok((await response.text()).length > 100);
  }
  for (const route of ['/api/state', '/api/hub', '/api/connections']) {
    assert.equal((await boundedFetch(origin + route)).status, 403, route);
    assert.equal((await boundedFetch(origin + route, { headers: { Cookie: cookie } })).status, 200, route);
  }
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(origin + '/onboarding.js', { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await boundedFetch(origin + '/onboarding/../../.runtime/agent-hub.json', { headers: { Cookie: cookie } })).status, 404);
});


test('recent source material is offered only from the owner journal, independently of task history', () => {
  const f = fixture(); recordedJournal(f);
  assert.equal(derive(f).journal.hasMaterials, false, 'an ordinary saved task is not recent source material');
  f.state.journal.items.push({ id: 'reading', source: { kind: 'automatic' }, taskData: { collection: { entries: [{ title: 'Current source' }] } } });
  assert.equal(derive(f).journal.hasMaterials, true);
  f.state.journal.scope = { account: 'other', userId: 'other' };
  assert.equal(derive(f).journal.hasMaterials, false, 'another person’s material is not an owner onboarding prompt');
  f.state.journal = { scope: { account: 'local', userId: 'owner' }, items: [], guide: { sources: [{ id: 'source' }] } };
  assert.equal(derive(f).journal.hasMaterials, true);
});
