import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providers, closeCodexConnections } from '../plugins/agent-bridge/providers.mjs';
import { AgentConversations } from '../plugins/agent-bridge/index.mjs';
import { WeixinApprovalRegistry, collectOutboundFiles, WeixinHarnessBridge } from '../vendor/deepseek-harness-weixin/dist/index.js';

const fixture = fileURLToPath(new URL('./fake_agent.mjs', import.meta.url));
await chmod(fixture, 0o755);
const workspace = await mkdtemp(join(tmpdir(), 'pa agent tests '));
const base = { command: fixture, workspace, timeout_seconds: 3, model: '' };
const context = extra => ({ instructions: 'PA test instructions', onSession: async () => {},
  approve: async () => false, signal: new AbortController().signal, ...extra });
test.after(async () => { delete process.env.PA_TEST_SCENARIO; await rm(workspace, { recursive: true, force: true }); });
test.afterEach(() => closeCodexConnections());

for (const provider of ['codex', 'workbuddy']) {
  test(`${provider}: final text, explicit resume and persisted identity`, async () => {
    process.env.PA_TEST_SCENARIO = 'success';
    let saved;
    const result = await providers[provider](base, 'test', context({ sessionId: 'resume-fixture', onSession: async id => { saved = id; } }));
    assert.equal(result.text, 'fixture reply');
    assert.equal(result.sessionId, 'resume-fixture');
    assert.equal(saved, 'resume-fixture');
  });
  for (const allowed of [true, false]) test(`${provider}: native approval ${allowed}`, async () => {
    process.env.PA_TEST_SCENARIO = 'approval';
    const requests = [];
    const result = await providers[provider](base, 'test', context({ approve: async request => {
      requests.push(request); return allowed;
    } }));
    assert.equal(result.text, allowed ? 'approved' : 'denied');
    assert.equal(requests.length, 1);
    assert.match(requests[0].reason, /read local fixture/);
  });
  for (const mode of ['failure', 'exit', 'invalid']) test(`${provider}: rejects ${mode} even with exit zero`, async () => {
    process.env.PA_TEST_SCENARIO = mode;
    await assert.rejects(providers[provider](base, 'test', context()), /AGENT_/);
  });
  test(`${provider}: cancellation closes child process`, async () => {
    process.env.PA_TEST_SCENARIO = 'hang';
    const controller = new AbortController();
    const result = providers[provider](base, 'test', context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(result, /CANCELLED/);
  });
  test(`${provider}: timeout closes child process`, async () => {
    process.env.PA_TEST_SCENARIO = 'hang';
    await assert.rejects(providers[provider]({ ...base, timeout_seconds: 0.1 }, 'test', context()), /TIMEOUT/);
  });
}

test('WorkBuddy classifies expired local login without exposing account error details', async () => {
  process.env.PA_TEST_SCENARIO = 'auth';
  await assert.rejects(providers.workbuddy(base, 'test', context()), { message: 'AGENT_AUTH_REQUIRED' });
});

test('Codex reports model entitlement, authentication and rate limits without exposing provider text', async () => {
  process.env.PA_TEST_SCENARIO = 'failure';
  try {
    for (const [codexErrorInfo, message, code] of [
      ['other', 'PRIVATE: the selected model is not supported when using a ChatGPT account', 'AGENT_MODEL_UNAVAILABLE'],
      ['unauthorized', 'PRIVATE credential details', 'AGENT_AUTH_REQUIRED'],
      ['usageLimitExceeded', 'PRIVATE billing details', 'AGENT_RATE_LIMITED'],
      [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, 'PRIVATE retry details', 'AGENT_RATE_LIMITED'],
      [{ response_too_many_failed_attempts: { http_status_code: 429 } }, 'PRIVATE retry details', 'AGENT_RATE_LIMITED'],
      ['other', 'exceeded retry limit, last status: 429 Too Many Requests', 'AGENT_RATE_LIMITED'],
      [{ responseTooManyFailedAttempts: { httpStatusCode: 503 } }, 'PRIVATE unavailable details', 'AGENT_TURN_FAILED'],
    ]) {
      process.env.PA_TEST_TURN_ERROR = JSON.stringify({ codexErrorInfo, message });
      await assert.rejects(providers.codex(base, 'test', context()), { message: code });
      await closeCodexConnections(base);
    }
  } finally { delete process.env.PA_TEST_TURN_ERROR; }
});

test('Codex passive analysis sets its own reasoning budget without overriding ordinary sessions', async () => {
  process.env.PA_TEST_SCENARIO = 'passive';
  process.env.PA_TEST_REASONING_EFFORT = 'medium';
  try {
    assert.equal((await providers.codex(base, 'test', context({ passive: true, reasoningEffort: 'medium' }))).text, 'fixture reply');
  } finally { delete process.env.PA_TEST_REASONING_EFFORT; await closeCodexConnections(base); }
  assert.equal((await providers.codex(base, 'test', context({ passive: true }))).text, 'fixture reply');
  const absentCommand = { ...base, command: '/fixture/never-spawn' };
  await assert.rejects(providers.codex(absentCommand, 'test', context({ passive: true, reasoningEffort: 'invalid' })), { message: 'AGENT_INVALID_REASONING_EFFORT' });
  await assert.rejects(providers.codex(absentCommand, 'test', context({ reasoningEffort: 'medium' })), { message: 'AGENT_INVALID_REASONING_EFFORT' });
  process.env.PA_TEST_SCENARIO = 'success';
  await closeCodexConnections(base);
  assert.equal((await providers.codex(base, 'test', context())).text, 'fixture reply');
});

test('IM -> CLI -> scoped approval -> final reply, restart and reset', async () => {
  process.env.PA_TEST_SCENARIO = 'approval';
  const instructions = join(workspace, 'AGENTS.md');
  await writeFile(instructions, 'test persona');
  const registry = new WeixinApprovalRegistry(1000);
  const options = { config: {}, accountId: 'account',
    sessionKey: (account, message) => `${account}:${message.from_user_id}`,
    approvalRegistry: registry, inbound: async message => [{ type: 'text', text: message.text }],
    outbound: text => collectOutboundFiles(text, workspace, 5, 100000),
    agentConfig: { ...base, provider: 'codex', state_dir: join(workspace, 'sessions'), instructions } };
  const manager = new AgentConversations(options);
  await manager.initialize();
  const message = { from_user_id: 'user-a', text: 'read fixture' };
  const reply = await manager.process(message, {}, async text => {
    const code = text.match(/\/approve (\d{6})/)[1];
    assert.equal(manager.decideApproval({ from_user_id: 'user-b' }, { code, outcome: 'allowed-once' }), undefined);
    assert.equal(manager.decideApproval(message, { code, outcome: 'allowed-once' }).outcome, 'allowed-once');
    assert.equal(manager.decideApproval(message, { code, outcome: 'allowed-once' }), undefined);
  });
  assert.equal(reply.text, 'approved');
  const restarted = new AgentConversations(options);
  await restarted.initialize();
  assert.equal((await restarted.load(restarted.key(message))).sessionId, 'thread-fixture');
  await restarted.startNewConversation(message);
  assert.equal((await restarted.load(restarted.key(message))).sessionId, null);
  await manager.dispose(); await restarted.dispose();
});

test('approval timeout and sender allowlist fail closed', async () => {
  const registry = new WeixinApprovalRegistry(20);
  assert.equal(await registry.request('user', { toolName: 'Bash', reason: 'fixture' }, async () => {}), 'unavailable');
  const bridge = new WeixinHarnessBridge({ logger: () => ({}) }, {
    cwd: workspace, approvalTimeoutMs: 100, responseTimeoutMs: 1000, maxSeenMessageIds: 100,
    accessPolicy: 'allowlist', allowFrom: ['trusted'],
  });
  assert.equal(bridge.allowed('trusted'), true);
  assert.equal(bridge.allowed('stranger'), false);
});

test('untrusted pairing stores only sender ID locally and sends nothing', async () => {
  const bridge = new WeixinHarnessBridge({ logger: () => ({}) }, {
    cwd: workspace, approvalTimeoutMs: 100, responseTimeoutMs: 1000, maxSeenMessageIds: 100,
    accessPolicy: 'allowlist', allowFrom: [], pairingRequestPath: join(workspace, 'pairing'),
  });
  let sent = false;
  await bridge.dispatch({ from_user_id: 'untrusted', item_list: [{ type: 1, text_item: { text: 'private message body' } }] },
    { sendText: () => { sent = true; } });
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(join(workspace, 'pairing'));
  const saved = JSON.parse(await readFile(join(workspace, 'pairing', files[0]), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['receivedAt', 'userId']);
  assert.equal(sent, false);
});

test('attachment boundary rejects paths outside workspace', async () => {
  const file = join(workspace, 'result.txt');
  await writeFile(file, 'result');
  const allowed = await collectOutboundFiles(`[result](<${file}>)`, workspace, 5, 10000);
  assert.equal(allowed.files.length, 1);
  const rejected = await collectOutboundFiles(`[outside](<${fixture}>)`, workspace, 5, 10000);
  assert.equal(rejected.files.length, 0);
  assert.equal(rejected.warnings.length, 1);
});

test('same-user queue resumes serially; reset cancels active and stale queued requests', async () => {
  const original = providers.codex;
  const instructions = join(workspace, 'queue-AGENTS.md');
  await writeFile(instructions, 'fixture');
  const manager = new AgentConversations({ config: {}, accountId: 'account',
    sessionKey: (account, message) => `${account}:${message.from_user_id}`,
    approvalRegistry: new WeixinApprovalRegistry(1000),
    inbound: async message => [{ type: 'text', text: message.text }],
    outbound: async () => ({ files: [], warnings: [] }),
    agentConfig: { ...base, provider: 'codex', state_dir: join(workspace, 'queue-sessions'), instructions },
  });
  await manager.initialize();
  const seen = [];
  providers.codex = async (config, prompt, context) => {
    seen.push(context.sessionId || null);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 30);
      context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('AGENT_CANCELLED')); }, { once: true });
    });
    return { text: 'queued reply', sessionId: context.sessionId || 'queue-session' };
  };
  const message = { from_user_id: 'queue-user', text: 'fixture' };
  try {
    await Promise.all([manager.process(message), manager.process(message)]);
    assert.deepEqual(seen, [null, 'queue-session']);
    const running = manager.process(message).catch(error => error.message);
    const stale = manager.process(message).catch(error => error.message);
    while (!manager.active.has(manager.key(message))) await new Promise(resolve => setTimeout(resolve, 1));
    await manager.startNewConversation(message);
    assert.equal(await running, 'AGENT_CANCELLED');
    assert.equal(await stale, 'AGENT_CANCELLED');
    assert.equal((await manager.load(manager.key(message))).sessionId, null);
  } finally { providers.codex = original; await manager.dispose(); }
});

test('Codex routine disables unscoped native access and fails closed for unavailable public Web evidence', async () => {
  const absentCommand = { ...base, command: '/fixture/never-spawn' };
  await assert.rejects(providers.codex(absentCommand, 'inspect', context({ routine: { scope: { publicWeb: true } } })), { message: 'ROUTINE_PUBLIC_WEB_UNSUPPORTED' });
  await assert.rejects(providers.workbuddy(absentCommand, 'inspect', context({ routine: { scope: { publicWeb: false } } })), { message: 'ROUTINE_SCOPE_UNSUPPORTED' });
  process.env.PA_TEST_SCENARIO = 'routine';
  assert.equal((await providers.codex(base, 'inspect', context({ routine: { scope: { publicWeb: false } }, tools: [] }))).text, 'fixture reply');
  await closeCodexConnections(base);
  process.env.PA_TEST_SCENARIO = 'approval'; let approvals = 0;
  await assert.rejects(providers.codex(base, 'inspect', context({ routine: { scope: { publicWeb: false } }, approve: async () => { approvals++; return true; } })), /REJECTED/);
  assert.equal(approvals, 0, 'a scheduled read cannot request a fresh unrestricted native grant');
});
