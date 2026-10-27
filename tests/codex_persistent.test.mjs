import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { runCodex, closeCodexConnections } from '../plugins/agent-bridge/providers.mjs';
import { codexConnectionOptions } from '../plugins/agent-bridge/codex-app-server.mjs';
import { createHandler } from './fixtures/codex_app_server.mjs';
import { hubConfig } from '../plugins/agent-hub/config.mjs';
import { loadAgentConfig } from '../plugins/agent-hub/companion.mjs';

const fixture = fileURLToPath(new URL('./fixtures/codex_app_server.mjs', import.meta.url));
await chmod(fixture, 0o755);
const context = extra => ({ instructions: 'isolated test', signal: new AbortController().signal, onSession: async () => {}, approve: async () => false, ...extra });
async function setup(t) {
  const workspace = await mkdtemp('/tmp/pa-codex-');
  const config = { command: fixture, workspace, timeout_seconds: 5 };
  t.after(async () => { await closeCodexConnections(config); await rm(workspace, { recursive: true, force: true }); });
  return config;
}

test('stdio reuses one initialization/process, resumes identity and emits only owned progress', async t => {
  const config = await setup(t), events = [];
  const first = await runCodex(config, 'success', context({ onEvent: event => events.push(event) }));
  const second = await runCodex(config, 'success', context({ sessionId: first.sessionId }));
  const a = JSON.parse(first.text), b = JSON.parse(second.text);
  assert.equal(a.pid, b.pid); assert.equal(b.initialized, 1); assert.equal(b.turns, 2);
  assert.equal(first.sessionId, second.sessionId);
  assert.ok(events.some(event => event.method === 'item/agentMessage/delta'));
  assert.ok(events.every(event => event.params.threadId === first.sessionId));
});

test('concurrent turns keep approvals and results scoped to their native thread', async t => {
  const config = await setup(t), approvals = [];
  const [a, b] = await Promise.all([
    runCodex(config, 'approval-a', context({ approve: async value => { approvals.push(value); return true; } })),
    runCodex(config, 'approval-b', context({ approve: async value => { approvals.push(value); return false; } })),
  ]);
  assert.notEqual(a.sessionId, b.sessionId); assert.equal(a.text, 'approval-a:accept'); assert.equal(b.text, 'approval-b:decline');
  assert.equal(approvals.length, 2);
});

test('permission expansion remains fail-closed on a persistent transport', async t => {
  const config = await setup(t);
  const value = await runCodex(config, 'permissions', context({ approve: () => assert.fail('No broad permission UI') }));
  assert.equal(value.text, 'permissions:{"permissions":{},"scope":"turn"}');
});

test('old same-thread frames before turn/start acknowledgment cannot claim or finish the new turn', async t => {
  const config = await setup(t);
  const value = await runCodex(config, 'stale-before-ack', context({ approve: () => assert.fail('A previous turn cannot request permission') }));
  assert.equal(JSON.parse(value.text).turns, 1);
});

test('slow progress observers cannot reorder final item and turn completion', async t => {
  const config = await setup(t);
  const result = await runCodex(config, 'success', context({ onEvent: async event => {
    if (event.method === 'item/completed') await new Promise(resolve => setTimeout(resolve, 30));
  } }));
  assert.equal(JSON.parse(result.text).turns, 1);
});

test('native timeout expires a pending approval even when the caller has not aborted', async t => {
  const config = await setup(t); config.timeout_seconds = 0.15;
  let approvalSignal;
  await assert.rejects(runCodex(config, 'approval-timeout', context({ approve: request => {
    approvalSignal = request.signal;
    return new Promise(resolve => request.signal.addEventListener('abort', () => resolve(false), { once: true }));
  } })), { code: 'AGENT_TIMEOUT' });
  assert.equal(approvalSignal.aborted, true);
});

test('native timeout propagates to in-flight dynamic tool work', async t => {
  const config = await setup(t); config.timeout_seconds = 0.15;
  let toolSignal;
  await assert.rejects(runCodex(config, 'tool-waits', context({ callTool: (_name, _args, _id, options) => {
    toolSignal = options.signal;
    return new Promise(resolve => toolSignal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }));
  } })), { code: 'AGENT_TIMEOUT' });
  assert.equal(toolSignal.aborted, true);
});

test('passive turns never delegate a native approval to the interactive owner', async t => {
  const config = await setup(t);
  await assert.rejects(runCodex(config, 'approval-passive', context({ passive: true, approve: () => assert.fail('Passive approval escaped') })), /AGENT_PASSIVE_TOOL_REJECTED/);
});

test('native approvals without the exact command are declined before asking the owner', async t => {
  const config = await setup(t);
  const result = await runCodex(config, 'approval-missing-detail', context({ approve: () => assert.fail('No generic tool approval') }));
  assert.equal(result.text, 'approval-missing-detail:decline');
});

for (const mode of ['hang', 'slow-start']) test(`cancellation interrupts native turn (${mode}) and keeps healthy connection reusable`, async t => {
  const config = await setup(t), controller = new AbortController();
  let sessionId;
  const pending = runCodex(config, mode, context({ signal: controller.signal, onSession: id => {
    sessionId = id; setTimeout(() => controller.abort(), mode === 'hang' ? 150 : 50);
  } }));
  await assert.rejects(pending, { code: 'AGENT_CANCELLED' });
  const result = await runCodex(config, 'success', context({ sessionId }));
  assert.equal(JSON.parse(result.text).turns, 2);
});

for (const mode of ['lost', 'start-lost']) test(`${mode} is uncertain and never replays the submitted prompt`, async t => {
  const config = await setup(t);
  await assert.rejects(runCodex(config, mode, context()), error => error.code === 'AGENT_CONNECTION_UNCERTAIN' && error.sessionId === 'thread-1');
  const next = await runCodex(config, 'success', context());
  assert.equal(JSON.parse(next.text).turns, 1);
});

test('interrupt acknowledgment without terminal notification is uncertain', async t => {
  const config = await setup(t); config.timeout_seconds = 0.1;
  await assert.rejects(runCodex(config, 'ignore-interrupt', context()), error => error.code === 'AGENT_CONNECTION_UNCERTAIN' && /TIMEOUT/.test(error.message));
});

test('busy resumed native sessions are not sent another prompt', async t => {
  const config = await setup(t);
  await assert.rejects(runCodex(config, 'success', context({ sessionId: 'busy' })), { code: 'AGENT_THREAD_BUSY' });
  const next = await runCodex(config, 'success', context());
  assert.equal(JSON.parse(next.text).turns, 1);
});

test('two callers cannot own the same resumed native thread', async t => {
  const config = await setup(t), controller = new AbortController(), started = Promise.withResolvers();
  const running = runCodex(config, 'hang', context({ sessionId: 'shared-thread', signal: controller.signal,
    onEvent: event => { if (event.method === 'turn/started') started.resolve(); } }));
  await started.promise;
  await assert.rejects(runCodex(config, 'success', context({ sessionId: 'shared-thread' })), { code: 'AGENT_THREAD_BUSY' });
  controller.abort(); await assert.rejects(running, { code: 'AGENT_CANCELLED' });
});

test('an explicit turn rejection is a failure rather than an uncertain execution', async t => {
  const config = await setup(t);
  await assert.rejects(runCodex(config, 'rejected', context()), { code: 'AGENT_RPC_REJECTED' });
});

async function socketServer(t, config, onMessage = () => {}) {
  const path = join(config.workspace, 'control.sock'), http = createServer(), wss = new WebSocketServer({ server: http });
  wss.on('connection', socket => {
    const handler = createHandler(value => socket.send(JSON.stringify(value)), () => socket.terminate());
    socket.on('message', value => { const message = JSON.parse(value.toString()); onMessage(message); handler(message); });
  });
  http.listen(path); await once(http, 'listening');
  t.after(async () => { await closeCodexConnections(config); for (const client of wss.clients) client.terminate(); wss.close(); await new Promise(resolve => http.close(resolve)); });
  return path;
}

test('Unix socket uses real WebSocket framing and reuses the daemon connection', async t => {
  const config = await setup(t), socket_path = await socketServer(t, config);
  config.codex_connection = { transport: 'unix', socket_path };
  const a = await runCodex(config, 'success', context());
  const b = await runCodex(config, 'success', context({ sessionId: a.sessionId }));
  assert.equal(JSON.parse(b.text).initialized, 1); assert.equal(JSON.parse(b.text).turns, 2);
});

test('a delayed approval answer cannot grant permission after cancellation', async t => {
  const config = await setup(t), received = [], socket_path = await socketServer(t, config, message => received.push(message));
  config.codex_connection = { transport: 'unix', socket_path };
  const controller = new AbortController(), asked = Promise.withResolvers(), answer = Promise.withResolvers();
  const running = runCodex(config, 'approval-late', context({ signal: controller.signal, approve: () => { asked.resolve(); return answer.promise; } }));
  await asked.promise; controller.abort(); await assert.rejects(running, { code: 'AGENT_CANCELLED' });
  answer.resolve(true);
  await runCodex(config, 'success', context());
  assert.ok(!received.some(message => String(message.id).startsWith('approval-') && message.result?.decision === 'accept'));
});

test('SSH proxy carries WebSocket framing without task input in SSH arguments', async t => {
  const config = await setup(t), socket_path = await socketServer(t, config), ssh = join(config.workspace, 'ssh-fixture.mjs');
  await writeFile(ssh, `#!/usr/bin/env node\nimport {connect} from 'node:net';\nconst args=process.argv.slice(2);\nif(!args.includes('BatchMode=yes')||!args.includes('StrictHostKeyChecking=yes')||args.at(-2)!=='fixture-host')process.exit(2);\nconst socket=connect(${JSON.stringify(socket_path)});process.stdin.pipe(socket).pipe(process.stdout);\n`);
  await chmod(ssh, 0o755);
  config.codex_connection = { transport: 'ssh', socket_path, ssh_host: 'fixture-host', ssh_command: ssh, remote_command: "/fixture/codex with ' quote" };
  const result = await runCodex(config, 'task input never becomes a shell command', context());
  assert.equal(JSON.parse(result.text).turns, 1);
});

test('connection configuration rejects implicit ports, flags and malformed paths', () => {
  const base = { command: 'codex', workspace: '/fixture' };
  for (const connection of [{ transport: 'ws' }, { transport: 'unix', socket_path: 'relative' }, { transport: 'ssh', socket_path: '/a', ssh_host: '-oProxyCommand=evil' }, { transport: 'ssh', socket_path: '/a', ssh_host: 'host\nother' }]) {
    assert.throws(() => codexConnectionOptions({ ...base, codex_connection: connection }), { code: 'AGENT_INVALID_CONNECTION' });
  }
});

test('instance parsers preserve remote workspace paths and reject invalid connection providers', async t => {
  const config = await setup(t), root = config.workspace;
  const agent = { id: 'remote', label: 'Remote Codex', provider: 'codex', command: 'codex', workspace: '/remote/workspace-not-on-this-machine', timeout_seconds: 60,
    codex_connection: { transport: 'ssh', ssh_host: 'configured-host', socket_path: '/remote/control.sock' } };
  await mkdir(join(root, '.runtime'));
  const hubPath = join(root, '.runtime/agent-hub.json');
  await writeFile(hubPath, JSON.stringify({ version: 1, agents: [agent], roles: { conversation: agent.id } }), { mode: 0o600 });
  assert.equal(hubConfig(root).agents[0].workspace, agent.workspace);
  const companionPath = join(root, 'companion.json');
  await writeFile(companionPath, JSON.stringify({ ...agent, endpoint: 'http://127.0.0.1:3083', token: 'x'.repeat(48) }), { mode: 0o600 });
  assert.equal(loadAgentConfig(companionPath).codex_connection.transport, 'ssh');
  await writeFile(hubPath, JSON.stringify({ version: 1, agents: [{ ...agent, provider: 'workbuddy' }], roles: {} }));
  assert.throws(() => hubConfig(root), { code: 'INVALID_HUB_CONFIG' });
  await closeCodexConnections({ provider: 'codex' }); // shutdown of an injected provider is harmless
});
