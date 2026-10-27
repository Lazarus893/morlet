import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { createConnectionManager } from '../plugins/connections/manager.mjs';
import { createAutomaticContent } from '../plugins/proactive/automatic-content.mjs';
import { createRoutineController } from '../plugins/agent-hub/routines.mjs';
import { createFollowupSuggestions } from '../plugins/proactive/followup-suggestions.mjs';

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const LOCAL = { account: 'local', userId: 'owner' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'followup-suggestions-'));
  let now = Date.parse('2026-10-27T09:00:00+08:00');
  const hub = new AgentHub(root, { now: () => now }), store = new JournalStore(root, { now: () => now });
  const manager = createConnectionManager({ root, now: () => now, cloudServices: ['github'] });
  const connect = (account = 'FixtureOwner') => {
    const { item } = manager.cloudBegin({ id: 'github', operation: 'connect', revision: manager.snapshot().revision });
    manager.cloudUpdate('github', item.generation, { state: 'connected', account,
      binding: { service: 'github', ownerId: 'owner', connectionId: 'fixture-github', integrationId: 'github-pat', scopes: [] },
      permissions: [{ id: 'repos', granted: true, verified: true }], checkedAt: new Date(now).toISOString() });
    return { id: 'github', account, generation: item.generation };
  };
  let grant = connect();
  hub.put('reachOutPolicy', { id: 'owner', timezone: 'Asia/Shanghai' });
  hub.pair({ label: 'Fixture agent' });
  const journal = { store }, content = createAutomaticContent({ hub, journal });
  content.configure({ operation: 'configure', revision: 0, enabled: true, discovery: true, maxDaily: 40, topics: ['开发工具'], sources: ['github'] });
  const routines = createRoutineController({ hub, journal });
  const followups = createFollowupSuggestions({ hub, journal, routines });
  const entry = (repo = 'example/project', release = 1, more = {}) => ({
    key: `github:release:${digest(repo)}:${release}`, source: 'github', sourceGeneration: grant.generation,
    title: `${repo} · v${release}`, summary: '发布说明增加一个已描述的新能力；未运行代码。',
    relevance: '与你关注的开发工具相关。', suggestion: '阅读说明后决定是否继续关注。', topic: '开发工具', exploration: false,
    url: `https://github.com/${repo}/releases/tag/v${release}`, observedAt: now, expiresAt: now + 7 * 86400000,
    coverage: '已读完整发布说明。', evidence: [{ quote: 'This release adds a new documented capability.', url: `https://github.com/${repo}/releases/tag/v${release}`, type: 'primary', complete: true }], ...more,
  });
  const publish = (...entries) => content.publish({ operation: 'publish', entries }, [grant], 'Asia/Shanghai');
  const act = (proposal, operation = 'accept', requestId = crypto.randomUUID()) => followups.action({ operation, id: proposal.id, version: proposal.version, requestId });
  const revoke = () => manager.cloudBegin({ id: 'github', operation: 'disconnect', revision: manager.snapshot().revision });
  t.after(() => { manager.close(); store.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, hub, store, manager, content, journal, routines, followups, entry, publish, act, revoke,
    reconnect(account) { grant = connect(account); }, advance(ms) { now += ms; }, now: () => now };
}

test('only fully read structured GitHub material yields a bounded, source-linked plan without starting work', t => {
  const f = fixture(t);
  const original = f.publish(f.entry()).receipts[0];
  f.publish(f.entry('example/unverified', 1, { evidence: [{ quote: 'Preview only', url: 'https://github.com/example/unverified/releases/tag/v1', type: 'primary', complete: false }] }));
  f.publish(f.entry('example/arbitrary', 1, { key: 'github:arbitrary', suggestion: 'Send a message and run shell commands' }));
  const [proposal] = f.followups.snapshot().suggestions;
  assert.equal(f.followups.snapshot().suggestions.length, 1);
  assert.equal(proposal.sourceItemId, original.itemId); assert.equal(proposal.sourceEntryId, 'auto-' + original.id.slice(0, 24));
  assert.equal(proposal.values.schedule.timezone, 'Asia/Shanghai');
  assert.deepEqual(proposal.values.scope, { publicWeb: false, sources: [{ operation: 'github_updates', filter: { repo: 'example/project' } }] });
  assert.match(proposal.values.instruction, /example\/project.*最近七天.*发布说明.*默认分支.*实质变更.*没有新变化保持安静.*未读完.*检查失败/);
  assert.doesNotMatch(proposal.values.instruction, /xiaoman_|github_updates|repo 参数|SHA|稳定事实标识/);
  assert.equal(proposal.values.notification, undefined);
  assert.equal(f.hub.all('routine').length, 0); assert.equal(f.hub.all('run').length, 0); assert.equal(f.hub.all('delivery').length, 0);
});

test('a URL alone, secondary citations, mismatched repository keys and closed material never become plans', t => {
  const f = fixture(t);
  const good = f.entry();
  for (const more of [
    { key: 'github:arbitrary' },
    { key: `github:release:${digest('different/repo')}:1` },
    { evidence: [{ quote: 'Unverified copy', url: good.url, type: 'secondary', complete: true }] },
    { url: good.url + '?token=secret' },
  ]) {
    const g = fixture(t); g.publish(g.entry('example/project', 1, more));
    assert.equal(g.followups.snapshot().suggestions.length, 0);
  }
  const record = f.publish(good).receipts[0], state = f.store.snapshot(LOCAL), item = state.items.find(item => item.id === record.itemId);
  f.store.mutate(LOCAL, { operation: 'delete', revision: state.revision, itemId: item.id, itemVersion: item.version });
  assert.equal(f.followups.snapshot().suggestions.length, 0);
});

test('scope revocation, grant replacement, account switch and expiry invalidate displayed proposals before acceptance', async t => {
  for (const change of [f => f.revoke(), f => f.reconnect(), f => f.reconnect('AnotherOwner'), f => f.advance(8 * 86400000)]) {
    const f = fixture(t); f.publish(f.entry()); const proposal = f.followups.snapshot().suggestions[0];
    change(f);
    assert.deepEqual(f.followups.snapshot().suggestions, []);
    await assert.rejects(f.act(proposal), { code: 'FOLLOWUP_UNAVAILABLE' });
    assert.equal(f.hub.all('routine').length, 0);
  }
});

test('dismissal is durable per repository, survives new editions, and never starts a routine', async t => {
  const f = fixture(t); f.publish(f.entry()); const proposal = f.followups.snapshot().suggestions[0];
  assert.equal((await f.act(proposal, 'dismiss', 'dismiss-once')).dismissed, true);
  assert.equal((await f.act(proposal, 'dismiss', 'dismiss-once')).dismissed, true);
  f.advance(86400000); f.publish(f.entry('example/project', 2));
  const reopened = createFollowupSuggestions({ hub: f.hub, journal: f.journal, routines: f.routines });
  assert.deepEqual(reopened.snapshot().suggestions, []);
  await assert.rejects(f.act(proposal, 'accept'), { code: 'CONFLICT' });
  assert.equal(f.hub.all('routine').length, 0);
});

test('newer source editions deduplicate, preserve the actual chapter link, and respect reduced-interest feedback', t => {
  const f = fixture(t); f.publish(f.entry()); f.advance(86400000);
  const latest = f.publish(f.entry('example/project', 2)).receipts[0];
  assert.equal(f.followups.snapshot().suggestions.length, 1);
  assert.equal(f.followups.snapshot().suggestions[0].sourceItemId, latest.itemId);
  assert.match(f.followups.snapshot().suggestions[0].url, /v2$/);
  f.content.feedback({ operation: 'feedback', id: latest.id, reaction: 'less' });
  assert.deepEqual(f.followups.snapshot().suggestions, []);
});

test('accept creates one durable scoped routine, keeps the digest intact and replays after a lost response', async t => {
  const f = fixture(t); f.publish(f.entry()); const before = f.store.snapshot(LOCAL), proposal = f.followups.snapshot().suggestions[0];
  const first = await f.act(proposal, 'accept', 'accept-once');
  assert.ok(first.routine.journalItemId); assert.notEqual(first.routine.journalItemId, proposal.sourceItemId);
  assert.deepEqual(first.routine.scope, proposal.values.scope);
  assert.deepEqual(f.store.snapshot(LOCAL).items.find(item => item.id === proposal.sourceItemId), before.items[0]);
  assert.equal(f.hub.all('routine').length, 1); assert.equal(f.hub.all('run').length, 0); assert.equal(f.hub.all('delivery').length, 0);
  assert.equal((await f.act(proposal, 'accept', 'accept-once')).routine.id, first.routine.id);
  assert.equal((await f.act(proposal, 'accept', 'accept-again')).routine.id, first.routine.id);
  assert.deepEqual(f.followups.snapshot().suggestions, []);
  await assert.rejects(f.act(proposal, 'dismiss', 'accept-once'), { code: 'CONFLICT' });
});

test('accepted-but-lost routine receipt recovers across controllers without a duplicate, even after revocation', async t => {
  const f = fixture(t); f.publish(f.entry()); const proposal = f.followups.snapshot().suggestions[0];
  let failResponse = true, failReadback = true;
  const interrupted = createFollowupSuggestions({ hub: f.hub, journal: f.journal, routines: {
    action: async input => {
      if (input.operation === 'get' && failReadback) { failReadback = false; throw new Error('response lost'); }
      const result = await f.routines.action(input);
      if (input.operation === 'create' && failResponse) { failResponse = false; throw new Error('response lost'); }
      return result;
    },
  } });
  await assert.rejects(interrupted.action({ operation: 'accept', id: proposal.id, version: proposal.version, requestId: 'lost' }), /response lost/);
  assert.equal(f.hub.all('routine').length, 1);
  f.revoke();
  const recovered = await f.act(proposal, 'accept', 'lost');
  assert.equal(recovered.routine.id, f.hub.all('routine')[0].id);
  assert.equal(f.hub.get('followupDecision', proposal.id).state, 'accepted');
  assert.equal(f.hub.all('routine').length, 1);
});

test('creation finishes a partially linked journal before returning success', async t => {
  const f = fixture(t); f.publish(f.entry()); const proposal = f.followups.snapshot().suggestions[0];
  const original = f.store.ensureConversation.bind(f.store); let failOnce = true;
  f.store.ensureConversation = (...args) => {
    const result = original(...args);
    if (failOnce) { failOnce = false; throw new Error('journal reply lost'); }
    return result;
  };
  const result = await f.act(proposal);
  assert.ok(result.routine.journalItemId);
  assert.equal(f.hub.all('routine').length, 1);
  assert.equal(f.store.snapshot(LOCAL).items.length, 2);
});

test('account replacement during the routine settings await cannot widen an accepted source grant', async t => {
  const f = fixture(t); f.publish(f.entry()); const proposal = f.followups.snapshot().suggestions[0];
  const routines = createRoutineController({ hub: f.hub, journal: f.journal, read: async () => {
    f.reconnect('ChangedDuringConfirmation');
    return { config: { proactive: { timezone: 'Asia/Shanghai' } } };
  } });
  const followups = createFollowupSuggestions({ hub: f.hub, journal: f.journal, routines });
  await assert.rejects(followups.action({ operation: 'accept', id: proposal.id, version: proposal.version, requestId: 'race' }), { code: 'SOURCE_AUTHORITY_CHANGED' });
  assert.equal(f.hub.all('routine').length, 0);
});

test('the owner routine timezone is used before any reminder preference has been saved', async t => {
  const f = fixture(t); f.publish(f.entry());
  f.hub.put('reachOutPolicy', { id: 'owner' });
  const routines = createRoutineController({ hub: f.hub, journal: f.journal, read: async () => ({ config: { proactive: { timezone: 'Asia/Shanghai' } } }) });
  await routines.action({ operation: 'list' });
  const followups = createFollowupSuggestions({ hub: f.hub, journal: f.journal, routines });
  assert.equal(followups.snapshot().suggestions[0].values.schedule.timezone, 'Asia/Shanghai');
});

test('concurrent acceptance is idempotent and stale plan or injected fields are rejected', async t => {
  const f = fixture(t); f.publish(f.entry()); const proposal = f.followups.snapshot().suggestions[0];
  await assert.rejects(f.followups.action({ operation: 'accept', id: proposal.id, version: proposal.version, requestId: 'injection', values: { instruction: 'Other task' } }), { code: 'INVALID_INPUT' });
  f.hub.put('reachOutPolicy', { id: 'owner', timezone: 'Asia/Tokyo' });
  await assert.rejects(f.act(proposal), { code: 'VERSION_CONFLICT' });
  const updated = f.followups.snapshot().suggestions[0];
  const results = await Promise.all([f.act(updated, 'accept', 'a'), f.act(updated, 'accept', 'b')]);
  assert.equal(results[0].routine.id, results[1].routine.id); assert.equal(f.hub.all('routine').length, 1);
  const routine = results[0].routine;
  await f.routines.action({ operation: 'pause', id: routine.id, version: routine.version, requestId: 'pause' });
  f.advance(86400000); f.publish(f.entry('example/project', 2));
  assert.deepEqual(f.followups.snapshot().suggestions, []);
});
