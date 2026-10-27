import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectionManager } from '../plugins/connections/manager.mjs';
import { createCloudConnections } from '../plugins/connections/cloud.mjs';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pa-cloud-'));
  let clock = Date.now(), found = [], available = true;
  const manager = createConnectionManager({ root, cloudServices: ['github'], now: () => clock });
  const deleted = [];
  const client = { services: () => ['github'], beginConnect: async () => ({ connectUrl: 'http://127.0.0.1:3409/connect/session', expiresAt: new Date(clock + 600000).toISOString() }),
    reconnect: async () => ({ connectUrl: 'http://127.0.0.1:3409/connect/reconnect', expiresAt: new Date(clock + 600000).toISOString() }),
    findConnections: async ({ attemptId }) => found.filter(value => value.attemptId === attemptId),
    disconnect: async (binding, { authorize } = {}) => { if (authorize && !authorize()) throw Object.assign(Error('protected'), { code: 'NANGO_CONNECTION_PROTECTED' }); if (!available) throw Error('offline'); deleted.push(binding.connectionId); found = found.filter(value => value.connectionId !== binding.connectionId); } };
  const cloud = createCloudConnections({ manager, config: { connectOrigin: 'http://127.0.0.1:3409' }, client, now: () => clock,
    probe: async () => ({ account: 'fixture-owner', state: 'limited', permissions: [{ id: 'profile', granted: true, verified: true }, { id: 'repos', granted: true, verified: false, errorCode: 'NANGO_FORBIDDEN' }], services: [], scopes: [] }), ...options });
  t.after(async () => { await cloud.close(); manager.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, manager, cloud, client, deleted, advance: ms => clock += ms, found: value => { found = (Array.isArray(value) ? value : value ? [value] : []).map(item => ({ attemptId: manager.cloudState('github').attemptId || manager.cloudCleanupJobs().at(-1)?.attemptId, ...item })); }, available: value => available = value,
    mutate: operation => cloud.mutate({ id: 'github', operation, revision: manager.snapshot().revision }), item: () => manager.snapshot().items.find(i => i.id === 'github') };
}

test('Nango consent and partial permissions work without Mac; bindings stay server-side', async t => {
  const f = fixture(t);
  await f.mutate('connect'); assert.equal(f.item().state, 'awaiting_authorization');
  f.found({ service: 'github', connectionId: 'private-binding' });
  await f.cloud.refresh();
  assert.equal(f.item().state, 'limited'); assert.equal(f.item().connectionProvider, 'nango');
  assert.equal(f.item().permissions.find(p => p.id === 'repos').verified, false);
  assert.doesNotMatch(JSON.stringify(f.manager.snapshot()), /private-binding|attemptId|binding/);
  assert.equal(f.manager.snapshot().bridge.online, false);
});

test('late successful probe after revocation cannot restore account or permissions', async t => {
  let release;
  const f = fixture(t, { probe: () => new Promise(resolve => { release = resolve; }) });
  await f.mutate('connect'); f.found({ connectionId: 'revoked' });
  const refresh = f.cloud.refresh();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.mutate('disconnect');
  release({ account: 'fixture-owner', state: 'connected', permissions: [] }); await refresh;
  assert.equal(f.item().state, 'revoked'); assert.equal(f.item().account, null);
  assert.deepEqual(f.deleted, ['revoked']);
});

test('failed remote credential cleanup is persisted and visibly retried', async t => {
  const f = fixture(t); await f.mutate('connect'); f.found({ connectionId: 'cleanup' }); await f.cloud.refresh();
  f.available(false); await f.mutate('disconnect');
  assert.match(f.item().message, /清理.*重试/); assert.equal(f.manager.cloudCleanupJobs().length, 2);
  f.available(true); await f.cloud.refresh();
  assert.deepEqual(f.deleted, ['cleanup']); assert.equal(f.manager.cloudCleanupJobs().length, 1);
  f.advance(660001); await f.cloud.refresh(); assert.equal(f.manager.cloudCleanupJobs().length, 0);
});

test('cancelled consent cleans a subsequently created connection', async t => {
  const f = fixture(t); await f.mutate('connect'); await f.mutate('disconnect');
  assert.equal(f.manager.cloudCleanupJobs().filter(job => job.attemptId).length, 1);
  f.found({ connectionId: 'late-consent' }); await f.cloud.refresh();
  assert.deepEqual(f.deleted, ['late-consent']); assert.equal(f.item().state, 'revoked');
});

test('Mac pairing preserves cloud grants and never exports cloud account to CLI collector', async t => {
  const f = fixture(t); await f.mutate('connect'); f.found({ connectionId: 'bound' }); await f.cloud.refresh();
  const paired = await f.cloud.mutate({ operation: 'pair', revision: f.manager.snapshot().revision, values: { name: 'fixture' } });
  assert.ok(paired.token);
  const desired = f.manager.bridgeSnapshot(paired.token).desired.find(row => row.id === 'github');
  assert.equal(desired.enabled, false); assert.equal(desired.account, null); assert.equal(f.item().state, 'limited');
});

test('cancelled reconnect deletes the original binding and cleans any later OAuth completion', async t => {
  const f = fixture(t); await f.mutate('connect'); f.found({ connectionId: 'original-binding' }); await f.cloud.refresh();
  f.found(null); await f.mutate('connect');
  const pending = f.manager.cloudState('github');
  assert.equal(pending.binding, undefined); assert.deepEqual(pending.pendingReconnect, { connectionId: 'original-binding' });
  assert.doesNotMatch(JSON.stringify(f.item()), /pendingReconnect|original-binding/);
  await f.cloud.refresh(); assert.equal(f.item().state, 'awaiting_authorization');
  await f.mutate('disconnect'); assert.deepEqual(f.deleted, ['original-binding']);
  assert.equal(f.manager.cloudCleanupJobs().filter(job => job.attemptId).length, 2);
  f.found({ connectionId: 'late-reconnect' }); await f.cloud.refresh();
  assert.deepEqual(f.deleted, ['original-binding', 'late-reconnect']); assert.equal(f.item().state, 'revoked');
});

test('reconnect reference survives restart without becoming an active cloud grant', async t => {
  const f = fixture(t); await f.mutate('connect'); f.found({ connectionId: 'restart-binding' }); await f.cloud.refresh();
  f.found(null); await f.mutate('connect'); await f.cloud.close(); f.manager.close();
  const manager = createConnectionManager({ root: f.root, cloudServices: ['github'] });
  try {
    const item = manager.cloudState('github'); assert.equal(item.binding, undefined); assert.equal(item.pendingReconnect.connectionId, 'restart-binding');
    manager.cloudBegin({ id: 'github', operation: 'disconnect', revision: manager.snapshot().revision });
    assert.ok(manager.cloudCleanupJobs().some(job => job.connectionId === 'restart-binding'));
    assert.equal(manager.cloudState('github').pendingReconnect, undefined);
  } finally { manager.close(); }
});

test('completed reconnect consumes cleanup-only reference and never deletes the renewed active binding', async t => {
  const f = fixture(t); await f.mutate('connect'); f.found({ connectionId: 'renewed' }); await f.cloud.refresh();
  f.found(null); await f.mutate('connect');
  f.found({ connectionId: 'renewed' }); await f.cloud.refresh();
  assert.equal(f.manager.cloudState('github').pendingReconnect, undefined);
  assert.equal(f.manager.cloudState('github').binding.connectionId, 'renewed');
  await f.cloud.refresh(); assert.deepEqual(f.deleted, []);
});

const completeProbe = (extra = {}) => ({ account: 'fixture-owner', userId: '123', state: 'connected', scopes: ['read:user', 'repo'], services: ['profile', 'repos'], permissions: [{ id: 'profile', granted: true, verified: true }, { id: 'repos', granted: true, verified: true }], ...extra });
const duplicates = () => [{ connectionId: 'older', createdAt: '2026-10-23T00:00:00Z' }, { connectionId: 'newer', createdAt: '2026-10-23T00:01:00Z' }];

test('same-attempt connections bind newest only after all immutable identities and scopes match', async t => {
  const checked = []; let f;
  f = fixture(t, { probe: async (_client, binding, { authorize }) => {
    authorize(); assert.equal(f.manager.cloudState('github').binding, undefined);
    checked.push(binding.connectionId); return completeProbe({ scopes: binding.connectionId === 'newer' ? ['repo', 'read:user'] : ['read:user', 'repo'] });
  } });
  await f.mutate('connect'); f.found(duplicates()); await f.cloud.refresh();
  assert.deepEqual(checked, ['older', 'newer']); assert.equal(f.item().state, 'connected');
  assert.equal(f.manager.cloudState('github').binding.connectionId, 'newer');
  assert.equal(f.manager.cloudCleanupJobs().length, 0); assert.deepEqual(f.deleted, []);
  assert.doesNotMatch(JSON.stringify(f.item()), /attemptExpiresAt|createdAt|newer|userId/);
  await f.mutate('disconnect'); assert.deepEqual(new Set(f.deleted), new Set(['older', 'newer']));
  assert.equal(f.manager.cloudCleanupJobs().filter(job => job.attemptId).length, 1);
});

test('duplicate ambiguity, failed capability checks and missing immutable identity never commit any binding', async t => {
  for (const change of [{ userId: '456' }, { account: 'other-account' }, { scopes: ['read:user'] }, { userId: undefined }, { permissions: [{ id: 'repos', granted: true, verified: false }] }, { createdAt: null }, { throw: true }]) {
    await t.test(JSON.stringify(change), async t => {
      const f = fixture(t, { probe: async (_client, binding) => {
        if (binding.connectionId === 'newer' && change.throw) throw Object.assign(Error('unavailable'), { code: 'SOURCE_UNAVAILABLE' });
        return completeProbe(binding.connectionId === 'newer' ? change : {});
      } });
      await f.mutate('connect'); const values = duplicates(); if ('createdAt' in change) values[1].createdAt = change.createdAt; f.found(values);
      await f.cloud.refresh(); assert.equal(f.item().state, 'error'); assert.equal(f.item().account, null);
      assert.equal(f.manager.cloudState('github').binding, undefined); assert.deepEqual(f.deleted, []);
    });
  }
});

test('cancel during final duplicate probe discards results and cleans every same-attempt connection', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { probe: async (_client, binding) => {
    if (binding.connectionId === 'newer') { started(); await new Promise(resolve => { release = resolve; }); }
    return completeProbe();
  } });
  await f.mutate('connect'); f.found(duplicates()); const checking = f.cloud.refresh(); await ready;
  await f.mutate('disconnect'); release(); await checking;
  assert.equal(f.item().state, 'revoked'); assert.equal(f.manager.cloudState('github').binding, undefined);
  assert.deepEqual(new Set(f.deleted), new Set(['older', 'newer']));
});

test('cancelled attempt sweeps expired and late duplicate credentials until session expiry', async t => {
  const f = fixture(t); await f.mutate('connect'); const attemptId = f.manager.cloudState('github').attemptId;
  await f.mutate('disconnect');
  f.found([{ connectionId: 'expired', state: 'expired', attemptId }, { connectionId: 'first', attemptId }]); await f.cloud.refresh();
  assert.deepEqual(f.deleted, ['expired', 'first']); assert.equal(f.manager.cloudCleanupJobs().length, 1);
  f.found({ connectionId: 'second-late', attemptId }); await f.cloud.refresh(); assert.ok(f.deleted.includes('second-late'));
  assert.equal(f.manager.cloudCleanupJobs().length, 1);
  f.advance(660001); f.found({ connectionId: 'last-before-final-sweep', attemptId }); await f.cloud.refresh();
  assert.ok(f.deleted.includes('last-before-final-sweep')); assert.equal(f.manager.cloudCleanupJobs().length, 0);
});

test('old-attempt cleanup protects the pending and renewed active binding while removing siblings', async t => {
  const f = fixture(t, { probe: async () => completeProbe() }); await f.mutate('connect');
  const oldAttempt = f.manager.cloudState('github').attemptId;
  f.found([{ connectionId: 'same-id', createdAt: '2026-10-23T00:01:00Z' }, { connectionId: 'sibling', createdAt: '2026-10-23T00:00:00Z' }]); await f.cloud.refresh();
  await f.mutate('connect'); await f.cloud.refresh(); assert.deepEqual(f.deleted, ['sibling']);
  f.found({ connectionId: 'same-id' }); await f.cloud.refresh(); assert.equal(f.manager.cloudState('github').binding.connectionId, 'same-id');
  // A stale inventory can still contain the same ID from the old attempt.
  f.found({ connectionId: 'same-id', attemptId: oldAttempt }); await f.cloud.refresh();
  assert.deepEqual(f.deleted, ['sibling']); assert.equal(f.item().state, 'connected');
});
