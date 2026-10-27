import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { createLocalAgentSetup } from '../plugins/webui/local-agent-setup.mjs';

async function fixture(t, install = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-local-setup-'));
  const hub = new AgentHub(root), calls = [];
  const setup = createLocalAgentSetup({ root, hub, execute: async (_command, args) => {
    calls.push(args);
    if (args[0].endsWith('connect.py')) return { stdout: JSON.stringify({ node: '/fixture/node', agents: [{ provider: 'codex', installed: true, command: '/fixture/codex' }] }) };
    const file = args.at(-1);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await install(JSON.parse(await readFile(file, 'utf8')));
    return { stdout: 'installed' };
  } });
  t.after(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, hub, calls, setup };
}

test('one click privately pairs a local agent without changing DSH or duplicating on retry', async t => {
  const f = await fixture(t);
  f.hub.registerHost({ id: 'dsh', provider: 'dsh', label: 'DSH' }, 'dsh-fixture-token');
  const existing = f.hub.get('endpoint', 'dsh');
  const result = await f.setup({ provider: 'codex' }, 'http://127.0.0.1:3083');
  assert.equal(result.installed, true);
  assert.equal(JSON.stringify(result).includes('token'), false);
  const config = JSON.parse(await readFile(join(f.root, '.runtime/local-agent-setup/codex.json')));
  assert.equal(config.workspace, join(f.root, '.runtime/agent-workspaces/codex'));
  assert.equal(f.hub.authenticate(config.token).id, result.endpointId);
  assert.equal(f.hub.get('endpoint', result.endpointId).lastSeen, 0, 'install is not online evidence');
  const retry = await f.setup({ provider: 'codex' }, 'http://127.0.0.1:3083');
  assert.equal(retry.endpointId, result.endpointId);
  assert.equal(retry.reused, true);
  assert.equal(f.calls.filter(c => c[0].endsWith('install-agent-companion.py')).length, 1);
  assert.deepEqual(f.hub.get('endpoint', 'dsh'), existing);
  await assert.rejects(f.setup({ provider: 'codex', workspace: '/does-not-exist' }, 'http://127.0.0.1:3083'));
  await assert.rejects(f.setup({ provider: 'codex', workspace: f.root }, 'http://127.0.0.1:3083'), { code: 'LOCAL_AGENT_ALREADY_PAIRED' });
});

test('installer failure revokes the new credential and never exposes native diagnostics', async t => {
  const f = await fixture(t, async () => { throw new Error('PRIVATE_TOKEN_NATIVE_OUTPUT'); });
  await assert.rejects(f.setup({ provider: 'codex' }, 'http://127.0.0.1:3083'), { code: 'LOCAL_AGENT_SETUP_FAILED' });
  assert.equal(f.hub.all('endpoint').filter(e => e.active).length, 0);
  await assert.rejects(readFile(join(f.root, '.runtime/local-agent-setup/codex.json')), { code: 'ENOENT' });
});

test('concurrent clicks cannot create a second endpoint; arbitrary providers cannot execute', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, () => waiting);
  const first = f.setup({ provider: 'codex' }, 'http://127.0.0.1:3083');
  await assert.rejects(f.setup({ provider: 'codex' }, 'http://127.0.0.1:3083'), { code: 'BUSY' });
  release(); await first;
  await assert.rejects(f.setup({ provider: 'shell' }, 'http://127.0.0.1:3083'), { code: 'INVALID_INPUT' });
  assert.equal(f.hub.all('endpoint').length, 1);
});
