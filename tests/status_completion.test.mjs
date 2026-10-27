import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { endpointReadiness, REQUIRED_TOOLS } from '../plugins/agent-hub/readiness.mjs';
import { statusSnapshot } from '../plugins/agent-hub/status.mjs';
import { normalizeReport } from '../plugins/agent-hub/reports.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pa-status-completion-')); let now = Date.now();
  const hub = new AgentHub(root, { now: () => now });
  const pairing = hub.pair({ label: 'Fixture' }), c = hub.newConversation({ endpointId: pairing.endpointId });
  t.after(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (id, overrides = {}) => hub.put('run', { id, conversationId: c.id, endpointId: pairing.endpointId, source: { channel: 'web' }, title: id, createdAt: now - 3000, finishedAt: now - 2000, status: 'completed', report: { outcome: 'blocked', summary: '等待生日安排确认', updatedAt: now - 2000 }, ...overrides });
  const save = (runId, itemId, version) => hub.put('effect', { id: `journal:${runId}:save-${itemId}-${version}`, state: 'done', result: { saved: true, item: { id: itemId, version } } });
  return { root, hub, pairing, c, run, save, now: () => now, advance: value => { now += value; } };
}
const get = (f, id) => f.hub.snapshot().runs.find(r => r.id === id);

test('later successful work and same-item saves do not silently close an unrelated blocked report', t => {
  const f = fixture(t); f.run('old'); f.save('old', 'birthday', 1);
  f.run('new', { createdAt: f.now() - 1000, finishedAt: f.now(), report: { outcome: 'completed', summary: '改预算完成' } }); f.save('new', 'birthday', 2);
  assert.equal(get(f, 'old').issue.state, 'open');
  assert.equal(f.hub.get('run', 'old').report.outcome, 'blocked');
});

test('explicit continuation requires every original item to have a newer host save receipt', t => {
  const f = fixture(t); f.run('old'); f.save('old', 'birthday', 2); f.save('old', 'budget', 1);
  f.run('new', { createdAt: f.now() - 1000, finishedAt: f.now(), report: { outcome: 'completed', summary: '计划已补齐', resolvesRunIds: ['old'] } });
  f.save('new', 'birthday', 2); f.save('new', 'budget', 2);
  assert.equal(get(f, 'old').issue.state, 'open');
  f.save('new', 'birthday', 3);
  const resolution = get(f, 'old').issue.resolution;
  assert.equal(resolution.kind, 'continued'); assert.equal(resolution.byRunId, 'new');
  assert.equal(resolution.items.length, 2); assert.ok(resolution.items.every(i => i.effectId.startsWith('journal:new:') && i.version > i.fromVersion));
  assert.equal(f.hub.get('run', 'old').report.outcome, 'blocked');
});

test('matching text, absent item identity, another conversation and incomplete runs cannot resolve history', t => {
  const f = fixture(t); f.run('old');
  f.run('new', { createdAt: f.now() - 1000, finishedAt: f.now(), report: { outcome: 'completed', summary: '生日好了', resolvesRunIds: ['old'] } }); f.save('new', 'birthday', 2);
  assert.equal(get(f, 'old').issue.state, 'open', 'no item id must require owner handling');
  f.save('old', 'birthday', 1);
  const next = f.hub.get('run', 'new'); f.hub.put('run', { ...next, conversationId: 'other' }); assert.equal(get(f, 'old').issue.state, 'open');
  f.hub.put('run', { ...next, status: 'running', heartbeat: f.now() }); assert.equal(get(f, 'old').issue.state, 'open');
  f.hub.put('run', { ...next, createdAt: f.now() - 4000 }); assert.equal(get(f, 'old').issue.state, 'open');
});

test('owner accepts a terminal limitation once without changing its report; stale and cross-conversation decisions fail', t => {
  const f = fixture(t); f.run('old'); const original = f.hub.get('run', 'old');
  const args = { runId: 'old', conversationId: f.c.id, fingerprint: get(f, 'old').issue.fingerprint, decision: 'accept_limit' };
  assert.throws(() => f.hub.resolveRunIssue({ ...args, conversationId: 'other' }), { code: 'ITEM_NOT_FOUND' });
  assert.throws(() => f.hub.resolveRunIssue({ ...args, fingerprint: 'stale' }), { code: 'CONFLICT' });
  const accepted = f.hub.resolveRunIssue(args); assert.deepEqual(f.hub.resolveRunIssue(args), accepted);
  assert.equal(get(f, 'old').issue.state, 'resolved'); assert.equal(f.hub.all('runResolution').length, 1);
  assert.deepEqual(f.hub.get('run', 'old'), original);
  f.hub.put('run', { ...original, report: { ...original.report, summary: '新的限制' } });
  assert.equal(get(f, 'old').issue.state, 'open', 'a different issue must not reuse old acceptance');
});

test('unknown and running executions cannot be hidden by accepting a limitation', t => {
  const f = fixture(t);
  for (const status of ['running', 'uncertain', 'cancelling', 'queued']) {
    f.run(status, { status, heartbeat: f.now() });
    assert.equal(get(f, status).issue, null);
    assert.throws(() => f.hub.resolveRunIssue({ runId: status, conversationId: f.c.id, fingerprint: 'anything', decision: 'accept_limit' }), { code: 'CONFLICT' });
  }
});

test('authentication distinguishes never verified, aged evidence, and known failure without a model probe', t => {
  const f = fixture(t); let e = f.hub.get('endpoint', f.pairing.endpointId);
  assert.equal(endpointReadiness(f.hub, e).authenticationEvidence.state, 'never_verified');
  f.run('ok', { finishedAt: f.now() - 16 * 60000, report: { outcome: 'completed', summary: '好' } });
  let state = endpointReadiness(f.hub, e);
  assert.equal(state.authentication, 'unknown'); assert.equal(state.authenticationEvidence.state, 'stale'); assert.equal(state.canExecute, false);
  assert.ok(state.reasons.some(r => /超出时效/.test(r))); assert.ok(state.authenticationEvidence.lastVerifiedAt > 0);
  f.run('auth-fail', { status: 'failed', finishedAt: f.now() - 1000, error: 'AGENT_AUTH_REQUIRED' });
  assert.equal(endpointReadiness(f.hub, e).authentication, 'required');
  f.hub.poll(f.pairing.token, { runnerId: 'fixture', claim: false, health: { authentication: 'verified', checkedAt: f.now() } });
  e = f.hub.get('endpoint', f.pairing.endpointId);
  assert.equal(endpointReadiness(f.hub, e).authentication, 'verified');
  f.advance(3 * 60000);
  f.hub.poll(f.pairing.token, { runnerId: 'fixture', claim: false, health: { authentication: 'unknown', checkedAt: f.now() } });
  state = endpointReadiness(f.hub, f.hub.get('endpoint', e.id));
  assert.equal(state.authenticationEvidence.state, 'stale', 'unknown probe preserves the last positive evidence');
});

test('an unverified secondary assistant does not turn a usable selected assistant yellow', async t => {
  const f = fixture(t); f.hub.pair({ label: 'Unverified secondary' });
  f.hub.put('endpoint', { ...f.hub.get('endpoint', f.pairing.endpointId), lastSeen: f.now(), health: { authentication: 'verified', checkedAt: f.now(), expiresAt: f.now() + 48 * 3600000 } });
  f.hub.put('session', { id: JSON.stringify([f.c.id, f.pairing.endpointId]), tools: REQUIRED_TOOLS });
  f.hub.bind({ channel: 'weixin', account: 'account', peer: 'owner', conversationId: f.c.id });
  const options = { hub: f.hub, root: f.root, conversationId: f.c.id, settings: { revision: 1, config: { im: { provider: 'weixin', allow_from: ['owner'] } } }, runtime: { state: 'running', configRevision: 1, lastPollAt: f.now(), connected: true, account: 'account' } };
  let state = await statusSnapshot(options); assert.equal(state.light, 'green'); assert.equal(state.agents[1].light, 'yellow');
  f.run('old'); const issue = get(f, 'old').issue;
  state = await statusSnapshot(options); assert.equal(state.blockedTasks.length, 1);
  f.hub.resolveRunIssue({ runId: 'old', conversationId: f.c.id, fingerprint: issue.fingerprint, decision: 'accept_limit' });
  state = await statusSnapshot(options); assert.equal(state.blockedTasks.length, 0); assert.equal(state.resolvedTasks.length, 1); assert.equal(state.light, 'green');
});

test('progress uses observed local read state and elapsed time while keeping source content private', t => {
  const f = fixture(t); f.run('read', { status: 'running', startedAt: f.now() - 180000, heartbeat: f.now() });
  f.hub.put('sourceRequest', { id: 'source', runId: 'read', status: 'running', createdAt: f.now() - 30000, arguments: { path: '/private/person/secret', query: 'secret query' }, result: { body: 'private mail' } });
  let progress = get(f, 'read').progress;
  assert.equal(progress.stage, 'reading_sources'); assert.equal(progress.elapsedSeconds, 180);
  assert.equal(JSON.stringify(progress).includes('private'), false); assert.equal(JSON.stringify(progress).includes('secret'), false);
  assert.equal(progress.percent, undefined);
  f.hub.put('sourceRequest', { ...f.hub.get('sourceRequest', 'source'), status: 'completed', finishedAt: f.now() });
  progress = get(f, 'read').progress; assert.equal(progress.stage, 'sources_returned');
});

test('report continuation IDs are bounded and validated', () => {
  const base = { summary: '已核对', outcome: 'completed' };
  assert.deepEqual(normalizeReport({ ...base, resolvesRunIds: ['run-a'] }, null, 1).resolvesRunIds, ['run-a']);
  for (const ids of [['same', 'same'], [''], [42], Array.from({ length: 9 }, (_, i) => String(i))]) assert.throws(() => normalizeReport({ ...base, resolvesRunIds: ids }, null, 1), { code: 'INVALID_REPORT' });
});


test('ordinary replies without a work report are not invented blocked tasks', t => {
  const f = fixture(t); f.run('greeting', { report: undefined }); assert.equal(get(f, 'greeting').issue, null);
});

test('a failed login probe remains required after an unknown probe and clears only on later positive evidence', t => {
  const f = fixture(t);
  f.hub.poll(f.pairing.token, { runnerId: 'fixture', claim: false, health: { authentication: 'required', checkedAt: f.now() } });
  f.advance(3 * 60000);
  f.hub.poll(f.pairing.token, { runnerId: 'fixture', claim: false, health: { authentication: 'unknown', checkedAt: f.now() } });
  assert.equal(endpointReadiness(f.hub, f.hub.get('endpoint', f.pairing.endpointId)).authentication, 'required');
  f.advance(1);
  f.hub.poll(f.pairing.token, { runnerId: 'fixture', claim: false, health: { authentication: 'verified', checkedAt: f.now() } });
  assert.equal(endpointReadiness(f.hub, f.hub.get('endpoint', f.pairing.endpointId)).authentication, 'verified');
});

test('new progress reports do not implicitly repeat an earlier resolution declaration', () => {
  const first = normalizeReport({ summary: '已核对', outcome: 'completed', resolvesRunIds: ['old'] }, null, 1);
  const later = normalizeReport({ summary: '另一步尚待确认', outcome: 'completed' }, first, 2);
  assert.equal(later.resolvesRunIds, undefined);
});


test('legacy saved receipts retain journal links, but missing versions cannot close a historical issue', t => {
  const f = fixture(t); f.run('old');
  f.hub.put('effect', { id: 'journal:old:legacy', state: 'done', result: { saved: true, item: { id: 'birthday' } } });
  f.run('new', { createdAt: f.now() - 1000, finishedAt: f.now(), report: { outcome: 'completed', summary: '新安排已存', resolvesRunIds: ['old'] } }); f.save('new', 'birthday', 2);
  assert.deepEqual(get(f, 'old').journalItemIds, ['birthday']); assert.equal(get(f, 'old').issue.state, 'open');
});
