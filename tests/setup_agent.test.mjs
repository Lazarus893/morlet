import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inspectCodex, selectSetupModel, verifySetupAgent } from '../plugins/agent-bridge/setup-check.mjs';

const catalog = { configuredModel: 'unavailable', models: [{ model: 'available', isDefault: true }] };
test('fresh install chooses the catalog default instead of an unavailable global model', () => {
  assert.deepEqual(selectSetupModel({}, catalog), { model: 'available', selection: 'catalog-default' });
  assert.equal(catalog.configuredModel, 'unavailable');
});
test('an explicitly selected instance model is never silently replaced', () => {
  assert.throws(() => selectSetupModel({ model: 'unavailable' }, catalog), /MODEL_UNAVAILABLE/);
});
test('a missing usable default leaves a selection requirement', () => {
  assert.throws(() => selectSetupModel({}, { models: [{ model: 'hidden', isDefault: true, hidden: true }] }), /SELECTION_REQUIRED/);
});
test('catalog presence does not count as a successful model call', async () => {
  await assert.rejects(verifySetupAgent({ provider: 'codex' }, { inspect: async () => catalog, run: async () => { throw new Error('AGENT_AUTH_REQUIRED'); } }), /AUTH_REQUIRED/);
});
test('the actual protocol adapter verifies without tools, copied credentials or a persistent thread', async t => {
  const prior = { ...process.env };
  process.env.PA_TEST_SCENARIO = 'passive'; process.env.PA_TEST_REPLY = 'XIAOMAN_READY';
  t.after(() => { for (const k of ['PA_TEST_SCENARIO', 'PA_TEST_REPLY']) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; } });
  const config = { provider: 'codex', command: fileURLToPath(new URL('./fake_agent.mjs', import.meta.url)), workspace: process.cwd(), timeout_seconds: 10 };
  const checked = await verifySetupAgent(config);
  assert.equal(checked.verified, true); assert.equal(checked.model, 'fixture-model');
  process.env.PA_TEST_SCENARIO = 'auth';
  await assert.rejects(inspectCodex(config), /AUTH_REQUIRED/);
});
