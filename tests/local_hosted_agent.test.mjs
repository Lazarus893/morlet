import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../plugins/agent-hub/host.mjs';
import { hubConfig } from '../plugins/agent-hub/config.mjs';
import { createJournalControl } from '../plugins/webui/journal-control.mjs';
import { designSkillInstructions } from '../plugins/life-journal/design-skill.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { createJournalRuntime } from '../plugins/life-journal/chief.mjs';

const fixture = fileURLToPath(new URL('./fake_agent.mjs', import.meta.url));
const roles = id => Object.fromEntries(['conversation', 'observer', 'followup', 'journalDesigner'].map(role => [role, id]));
async function setup(t, provider = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'xiaoman-local-host-'));
  await mkdir(join(root, '.runtime'), { mode: 0o700 });
  const agent = { id: 'local-' + provider, label: 'Existing CLI', provider, command: fixture, workspace: root, timeout_seconds: 30 };
  const config = { version: 1, agents: [agent], roles: roles(agent.id) };
  await writeFile(join(root, '.runtime/agent-hub.json'), JSON.stringify(config), { mode: 0o600 });
  const cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); await rm(root, { recursive: true, force: true }); });
  return { root, agent, config, cleanup };
}

for (const provider of ['codex', 'workbuddy']) test(`hosted ${provider} serves its own role without a DSH model key`, async t => {
  const f = await setup(t, provider); await chmod(fixture, 0o755);
  const host = await startHost({ logger: () => ({ warn() {} }) }, f.root);
  f.cleanup.push(() => host.stop());
  const conversation = host.hub.newConversation({ endpointId: f.agent.id });
  const { run } = host.hub.submit({ conversationId: conversation.id, content: 'Use the existing local CLI', source: { channel: 'web' }, requestId: 'hosted-cli' });
  for (let i = 0; i < 100 && host.hub.get('run', run.id).status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(host.hub.get('run', run.id).status, 'completed');
  assert.equal(host.hub.snapshot().messages.at(-1).text, 'fixture reply');
  assert.equal(host.hub.snapshot().endpoints[0].provider, provider);
  assert.equal(host.hub.snapshot().channels.length, 0);
  assert.equal(host.hub.snapshot().runs.length, 1);
});

test('hosted role validation rejects unsupported executors and executable control characters', async t => {
  const f = await setup(t);
  assert.equal(hubConfig(f.root).agents[0].provider, 'codex');
  for (const change of [{ provider: 'arbitrary' }, { command: 'codex\nother' }, { command: '' }]) {
    await writeFile(join(f.root, '.runtime/agent-hub.json'), JSON.stringify({ ...f.config, agents: [{ ...f.agent, ...change }] }), { mode: 0o600 });
    assert.throws(() => hubConfig(f.root), { code: 'INVALID_HUB_CONFIG' });
  }
});

test('hosted Codex can read source inventory through its new native tool without network or model credentials', async t => {
  const f = await setup(t); await chmod(fixture, 0o755);
  const previous = process.env.PA_TEST_SCENARIO;
  process.env.PA_TEST_SCENARIO = 'source-list';
  t.after(() => { if (previous === undefined) delete process.env.PA_TEST_SCENARIO; else process.env.PA_TEST_SCENARIO = previous; });
  const host = await startHost({ logger: () => ({ warn() {} }) }, f.root);
  f.cleanup.push(() => host.stop());
  const conversation = host.hub.newConversation({ endpointId: f.agent.id });
  const { run } = host.hub.submit({ conversationId: conversation.id, content: 'Read my configured sources', source: { channel: 'web' }, requestId: 'hosted-sources' });
  for (let i = 0; i < 100 && host.hub.get('run', run.id).status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(host.hub.get('run', run.id).status, 'completed');
  assert.equal(host.hub.snapshot().messages.at(-1).text, 'fixture reply');
});

test('design availability and execution follow the selected role rather than the conversation CLI', async t => {
  const f = await setup(t, 'workbuddy');
  f.agent.command = process.execPath; f.agent.model = 'role-specific-model';
  await writeFile(join(f.root, '.runtime/agent-hub.json'), JSON.stringify({ ...f.config, agents: [f.agent] }), { mode: 0o600 });
  const calls = [], settings = { revision: 'one', installed: false, agentCommand: '/missing/conversation-cli',
    config: { agent: { provider: 'codex', command: '/missing/conversation-cli' }, im: { provider: 'disabled', allow_from: [] }, proactive: { timezone: 'Asia/Shanghai' } } };
  const journal = createJournalControl({ root: f.root, readSettings: async () => settings, runtimeFactory: async options => {
    calls.push(options.agentConfig); return { ready: true, request: async () => ({ accepted: true }), stop: async () => {} };
  } });
  f.cleanup.push(() => journal.close());
  const result = await journal.snapshot({ account: 'local', userId: 'owner' }, settings);
  assert.equal(result.designAvailable, true);
  await journal.requestDesign({ account: 'local', userId: 'owner' }, 0, settings);
  assert.equal(calls[0].provider, 'workbuddy'); assert.equal(calls[0].command, process.execPath); assert.equal(calls[0].model, 'role-specific-model');
});

test('passive design receives the packaged skill and protocol explicitly', async () => {
  const instructions = await designSkillInstructions();
  assert.match(instructions, /references\/runtime-design.md/);
  assert.match(instructions, /references\/selection-protocol.md/);
  assert.match(instructions, /references\/dashboard-patterns.md/);
  assert.match(instructions, /availableKinds/);
  assert.match(instructions, /16,384/);
});

for (const status of ['queued', 'running']) test(`Web-only restart recovers persisted ${status} design without WeChat or iMessage`, async t => {
  const f = await setup(t), scope = { account: 'local', userId: 'owner' };
  const old = new JournalStore(f.root);
  const saved = old.mutate(scope, { operation: 'add', revision: 0, values: { title: 'Birthday preparation', steps: [{ id: 'cake', label: 'Choose a cake', done: false }] } });
  const queued = old.mutate(scope, { operation: 'design-start', revision: saved.revision, values: { status: 'queued' } });
  if (status === 'running') old.mutate(scope, { operation: 'design-start', revision: queued.revision, values: { status: 'running', token: queued.design.token } });
  old.close();
  const settings = { revision: 'one', installed: true, config: { agent: { provider: 'codex' }, im: { provider: 'disabled', allow_from: [] }, proactive: { timezone: 'Asia/Shanghai' } } };
  let analyses = 0;
  const journal = createJournalControl({ root: f.root, readSettings: async () => settings,
    runtimeFactory: options => createJournalRuntime({ ...options, rolePath: new URL('../agents/life-journal-designer/AGENT.md', import.meta.url), analyze: async (_instructions, prompt) => {
      analyses++;
      const item = JSON.parse(prompt).items[0];
      return JSON.stringify({ widgets: [{ id: item.id + ':prep', itemId: item.id, kind: 'prep', emphasis: 'primary' }], reason: 'Resume the confirmed preparation.' });
    } }) });
  f.cleanup.push(() => journal.close());
  let current = await journal.snapshot(scope, settings);
  for (let i = 0; i < 100 && !['ready', 'failed'].includes(current.design.status); i++) {
    await new Promise(resolve => setTimeout(resolve, 10)); current = await journal.snapshot(scope, settings);
  }
  assert.deepEqual(journal.store.snapshot(scope).items, saved.items);
  if (status === 'queued') { assert.equal(current.design.status, 'ready'); assert.equal(current.layout.source, 'agent'); assert.equal(analyses, 1); }
  else { assert.equal(current.design.status, 'failed'); assert.equal(current.design.errorCode, 'DESIGN_INTERRUPTED'); assert.equal(analyses, 0); }
});

test('a queued design with an unavailable role still exposes the saved journal', async t => {
  const f = await setup(t), scope = { account: 'local', userId: 'owner' };
  f.config.roles.journalDesigner = 'remote-endpoint-not-hosted-here';
  await writeFile(join(f.root, '.runtime/agent-hub.json'), JSON.stringify(f.config), { mode: 0o600 });
  const journal = createJournalControl({ root: f.root, runtimeFactory: async () => { assert.fail('An unavailable role must not execute'); } });
  f.cleanup.push(() => journal.close());
  const saved = journal.store.mutate(scope, { operation: 'add', revision: 0, values: { title: 'Saved preparation' } });
  journal.store.mutate(scope, { operation: 'design-start', revision: saved.revision, values: { status: 'queued' } });
  const current = await journal.snapshot(scope, { config: { agent: { provider: 'codex' }, im: { provider: 'disabled' }, proactive: {} } });
  assert.equal(current.items[0].title, 'Saved preparation');
  assert.equal(current.designAvailable, false); assert.equal(current.design.status, 'queued');
});
