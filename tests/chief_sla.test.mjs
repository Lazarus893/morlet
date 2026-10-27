import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { isJsonValue } from '@deepseek-ai/dsh-util-values';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { actionFingerprint, actionPreview, nativeActionPolicy, assertRoutineToolAccess, requestAction, requireAction } from '../plugins/agent-hub/actions.mjs';
import { endpointReadiness, probeLogin, REQUIRED_TOOLS } from '../plugins/agent-hub/readiness.mjs';
import { statusSnapshot, statusTool } from '../plugins/agent-hub/status.mjs';
import { configureReachOut, reachOutPolicy, reachOutGate, reserveAnalysis, offerReachOut, reserveReachOut, finishReachOut, candidateReceipt, reachOutSnapshot, reachOutScope, dispatchReachOut } from '../plugins/proactive/reach-out.mjs';
import { managePersonalNotices, drainPersonalNotices, personalChannelPoll, noticeSourceAllowed, noticeSourceStamp } from '../plugins/proactive/personal-notices.mjs';
import { PersonalNoticeWorker } from '../plugins/proactive/notice-worker.mjs';
import { createNoticeSources } from '../plugins/proactive/notice-sources.mjs';
import { ProactiveEngine } from '../plugins/proactive/engine.mjs';
import { HubChannel } from '../plugins/agent-hub/channel.mjs';
import { journalTool } from '../plugins/agent-hub/journal.mjs';
import { createJournalControl } from '../plugins/webui/journal-control.mjs';
import { reminderTool } from '../plugins/agent-hub/reminders.mjs';
import { createConnectionManager } from '../plugins/connections/manager.mjs';

// All identities, clocks, transport/model calls and data below are isolated
// fixtures. These tests never contact a service, launch a model or send a message.
const MINUTE = 60_000;
const START = Date.parse('2026-10-17T10:01:00Z');
const route = { channel: 'imessage', account: 'fixture-channel', peer: 'owner@example.invalid' };
const otherRoute = { channel: 'weixin', account: 'fixture-account', peer: 'fixture-owner' };

function fixture(t, now = START) {
  const root = mkdtempSync(join(tmpdir(), 'xiaoman-chief-sla-'));
  const hub = new AgentHub(root, { now: () => now });
  const pairing = hub.pair({ label: 'Acceptance fixture', provider: 'codex' });
  const conversation = hub.newConversation({ endpointId: pairing.endpointId });
  t.after(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
  const configure = changes => configureReachOut(hub, { revision: reachOutPolicy(hub).revision, ...changes });
  const submit = (content = '隔离验收任务', extra = {}) => hub.submit({ conversationId: conversation.id, content, requestId: randomUUID(), ...extra }).run;
  const poll = extra => hub.poll(pairing.token, { runnerId: 'fixture-runner', ...extra });
  return { root, hub, pairing, conversation, configure, submit, poll, advance: ms => { now += ms; }, now: () => now };
}

function offer(f, changes = {}) {
  return offerReachOut(f.hub, { scope: 'owner', key: 'fixture-reference', topic: '项目文档更新', source: 'github', kind: 'reference', text: '项目的操作说明有一处更新，方便时可以看一下。', expiresAt: f.now() + 4 * 60 * MINUTE, route, ...changes });
}

function noticeFixture(t) {
  const f = fixture(t);
  const channel = f.hub.pairChannel({ label: 'Fixture iMessage', peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', conversationId: f.conversation.id });
  const alive = () => f.hub.channelStatus(channel.token, { ready: true, peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', lastInboundAt: 0, pendingInputs: 0 });
  alive();
  f.configure({ mode: 'Digest', digest_minutes: 5, timezone: 'UTC' });
  const configureNotices = changes => managePersonalNotices(f.hub, { operation: 'configure', enabled: true, channelId: channel.channelId, sources: ['google-calendar', 'github'], timezone: 'UTC', ...changes });
  configureNotices({});
  const add = (key, source, expiresAt = f.now() + 60 * MINUTE) => managePersonalNotices(f.hub, { operation: 'offer', key, topic: key, source, text: key === 'calendar-fixture' ? '有一项已确认的日程。' : '仓库发布了有参考价值的更新。', observedAt: f.now(), expiresAt });
  const queueDigest = () => {
    f.advance(5 * MINUTE); alive(); drainPersonalNotices(f.hub);
    const deliveries = f.hub.all('delivery');
    assert.equal(deliveries.length, 1);
    assert.equal(f.hub.all('personalNotice').filter(n => n.deliveryId === deliveries[0].id).length, 2);
    return deliveries[0];
  };
  return { ...f, channel, alive, configureNotices, add, queueDigest };
}

function authorityFixture(f) {
  const manager = createConnectionManager({ root: f.root, now: f.now });
  const mutate = values => manager.mutate({ revision: manager.snapshot().revision, ...values });
  const { token } = mutate({ operation: 'pair', values: { name: 'Isolated fixture Mac' } });
  mutate({ operation: 'connect', id: 'google', values: { account: 'account-a@example.invalid' } });
  mutate({ operation: 'connect', id: 'github', values: { account: 'github-fixture-a' } });
  const report = (changes = {}) => {
    const desired = manager.bridgeSnapshot(token).desired;
    manager.reportBridge(token, { reports: ['google', 'github'].map(id => ({ id, generation: desired.find(i => i.id === id).generation, state: 'connected', code: 'ok', account: changes[id] || desired.find(i => i.id === id).account,
      permissions: [{ id: id === 'google' ? 'calendar' : 'repos', granted: true, verified: true }] })) });
  };
  report();
  return { manager, mutate, report };
}

test('empty and interest-only worker scans make zero model and analysis-reservation calls', async t => {
  for (const candidates of [[], [{ key: 'file-name-context', source: 'local-files', kind: 'interest_context', title: '仅用于兴趣背景的文件名', expiresAt: START + 60 * MINUTE }]]) {
    const directory = mkdtempSync(join(tmpdir(), 'xiaoman-chief-worker-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let models = 0, analyses = 0, offers = 0;
    const worker = new PersonalNoticeWorker({ directory, now: () => START,
      transport: async input => {
        if (input.operation === 'analysis') { analyses++; return { allowed: true }; }
        if (input.operation === 'offer') offers++;
        return input.operation === 'snapshot' ? { policy: { enabled: true, timezone: 'UTC', quiet_start: '22:00', quiet_end: '09:00' }, sources: [{ id: 'local-files', account: 'fixture' }], notices: [] } : {};
      },
      collect: async () => ({ candidates, counts: { 'local-files': candidates.length } }),
      analyze: async () => { models++; return '{"key":null}'; },
    });
    await worker.tick(new AbortController().signal);
    assert.equal(worker.state.lastResult.state, 'idle');
    assert.deepEqual({ models, analyses, offers }, { models: 0, analyses: 0, offers: 0 });
  }
});

test('empty checklists consume no analysis or delivery budget', t => {
  const f = fixture(t);
  assert.deepEqual(reserveAnalysis(f.hub, 'owner', { key: 'empty', count: 0 }), { allowed: false, blocked: 'empty_checklist' });
  assert.deepEqual(reserveReachOut(f.hub, 'owner', route), { blocked: 'empty_checklist' });
  assert.equal(f.hub.all('reachOutAnalysis').length, 0);
  assert.equal(f.hub.all('reachOutAttempt').length, 0);
});

test('a real calendar-source event becomes a deadline offer and bypasses Gentle digest waiting', async t => {
  const f = fixture(t); f.configure({ mode: 'Gentle' });
  const sources = [{ id: 'google-calendar', account: 'fixture-calendar@example.invalid' }];
  let reads = 0, models = 0; const offers = [], attempts = [];
  const collect = createNoticeSources({ gog: 'fixture-gog', runner: async (command, args) => {
    assert.equal(command, 'fixture-gog'); assert.deepEqual(args.slice(0, 3), ['calendar', 'events', 'primary']);
    assert.equal(args.at(-1), sources[0].account); reads++;
    return { exitCode: 0, stdout: JSON.stringify({ events: [{ id: 'calendar-fixture-meeting', summary: '项目方案讨论', start: { dateTime: new Date(f.now() + 60 * MINUTE).toISOString() }, status: 'confirmed' }] }) };
  } });
  const worker = new PersonalNoticeWorker({ directory: join(f.root, 'notice-worker'), now: f.now, collect,
    transport: async input => {
      if (input.operation === 'snapshot') return { policy: { ...reachOutPolicy(f.hub), enabled: true }, sources, notices: [] };
      if (input.operation === 'analysis') return { allowed: true };
      if (input.operation === 'offer') {
        offers.push(input);
        const { operation, observedAt, ...candidate } = input;
        offerReachOut(f.hub, { ...candidate, scope: 'owner', route });
        const attempt = reserveReachOut(f.hub, 'owner', route); attempts.push(attempt);
        return { accepted: true, state: attempt.id ? 'reserved' : 'pending', deliveryId: null };
      }
      return {};
    },
    analyze: async (_instructions, input) => {
      models++; const candidate = JSON.parse(input).candidates[0];
      assert.equal(candidate.kind, 'event'); assert.equal(candidate.evidence, 'calendar_event');
      return JSON.stringify({ key: candidate.key, text: '留意到一小时后有项目方案讨论，方便时可以先把待确认的两三点记下来。' });
    },
  });
  await worker.tick(new AbortController().signal);
  assert.equal(worker.state.lastResult.state, 'idle'); assert.equal(reads, 2); assert.equal(models, 1);
  assert.equal(offers.length, 1); assert.equal(offers[0].source, 'google-calendar'); assert.equal(offers[0].kind, 'deadline');
  assert.equal(offers[0].expiresAt, f.now() + 60 * MINUTE);
  assert.ok(attempts[0].id, 'a verified future calendar event must not be demoted to a reference waiting for a digest');
  assert.equal(attempts[0].mode, 'Gentle');
});

test('a real GitHub-source review_requested candidate becomes watch_hit in Gentle mode', async t => {
  const f = fixture(t); f.configure({ mode: 'Gentle' });
  const sources = [{ id: 'github', account: 'fixture-reviewer' }];
  let identityReads = 0, reviewReads = 0, models = 0; const offers = [], attempts = [];
  const collect = createNoticeSources({ gh: 'fixture-gh', runner: async (command, args) => {
    assert.equal(command, 'fixture-gh');
    if (args[0] === 'api') {
      assert.equal(args[1], 'user'); identityReads++;
      return { exitCode: 0, stdout: JSON.stringify({ login: sources[0].account }) };
    }
    assert.deepEqual(args.slice(0, 6), ['search', 'prs', '--review-requested', '@me', '--state', 'open']); reviewReads++;
    return { exitCode: 0, stdout: JSON.stringify([{ id: 'PR_fixture_review', title: '修复会话中断后的继续处理', url: 'https://github.com/fixture-org/fixture-journal/pull/42', updatedAt: new Date(f.now() - 30 * MINUTE).toISOString(), repository: { nameWithOwner: 'fixture-org/fixture-journal' } }]) };
  } });
  const worker = new PersonalNoticeWorker({ directory: join(f.root, 'notice-worker'), now: f.now, collect,
    transport: async input => {
      if (input.operation === 'snapshot') return { policy: { ...reachOutPolicy(f.hub), enabled: true }, sources, notices: [] };
      if (input.operation === 'analysis') return { allowed: true };
      if (input.operation === 'offer') {
        offers.push(input);
        const { operation, observedAt, ...candidate } = input;
        offerReachOut(f.hub, { ...candidate, scope: 'owner', route });
        const attempt = reserveReachOut(f.hub, 'owner', route); attempts.push(attempt);
        return { accepted: true, state: attempt.id ? 'reserved' : 'pending', deliveryId: null };
      }
      return {};
    },
    analyze: async (_instructions, input) => {
      models++; const candidate = JSON.parse(input).candidates[0];
      assert.equal(candidate.kind, 'review_requested'); assert.equal(candidate.evidence, 'own_open_review_request');
      return JSON.stringify({ key: candidate.key, text: '留意到会话恢复这项改动正在等你评审，方便时可以先核对中断后续做的处理。' });
    },
  });
  await worker.tick(new AbortController().signal);
  assert.equal(worker.state.lastResult.state, 'idle'); assert.equal(identityReads, 2); assert.equal(reviewReads, 2); assert.equal(models, 1);
  assert.equal(offers.length, 1); assert.equal(offers[0].source, 'github'); assert.equal(offers[0].kind, 'watch_hit');
  assert.equal(offers[0].topic, 'https://github.com/fixture-org/fixture-journal/pull/42');
  assert.ok(attempts[0].id, 'an actual open review request must not become a generic digest reference');
  assert.equal(attempts[0].mode, 'Gentle');
});

test('a worker with an unknown offer outcome only requests its receipt after restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'xiaoman-chief-worker-unknown-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = START, offers = 0, models = 0, receipts = 0;
  const candidate = { key: 'calendar-event-fixture', source: 'google-calendar', kind: 'event', evidence: 'calendar_event', title: '隔离会议', at: START, startsAt: START + 60 * MINUTE, expiresAt: START + 2 * 60 * MINUTE };
  const options = { directory, now: () => now,
    transport: async input => {
      if (input.operation === 'snapshot') return { policy: { enabled: true, timezone: 'UTC', quiet_start: '22:00', quiet_end: '09:00' }, sources: [{ id: 'google-calendar', account: 'fixture' }], notices: [] };
      if (input.operation === 'analysis') return { allowed: true };
      if (input.operation === 'receipt') { receipts++; return { receipt: null }; }
      if (input.operation === 'offer') { offers++; throw new Error('fixture response lost after possible commit'); }
      return {};
    },
    collect: async () => ({ candidates: [candidate], counts: { 'google-calendar': 1 } }),
    analyze: async () => { models++; return JSON.stringify({ key: candidate.key, text: '留意到稍后有一项会议，方便时可以先看看材料。' }); },
  };
  const first = new PersonalNoticeWorker(options); await first.tick(new AbortController().signal);
  assert.equal(first.state.offers[candidate.key].state, 'unknown'); assert.equal(offers, 1);
  now += 31 * MINUTE;
  const reopened = new PersonalNoticeWorker(options); await reopened.tick(new AbortController().signal);
  assert.equal(receipts, 1); assert.equal(offers, 1); assert.equal(models, 1);
  assert.equal(reopened.state.offers[candidate.key].state, 'unknown');
});

test('Off blocks analysis and proactive candidates while ordinary user replies remain deliverable', t => {
  const f = fixture(t); f.configure({ mode: 'Off' }); offer(f);
  assert.equal(reserveAnalysis(f.hub, 'owner', { key: 'available', count: 1 }).blocked, 'paused');
  assert.equal(reserveReachOut(f.hub, 'owner', route).blocked, 'paused');
  f.hub.reply(f.conversation.id, '你刚才交代的事我已记下。', route);
  assert.equal(f.hub.takeDelivery(route.channel, route.account, () => true).text, '你刚才交代的事我已记下。');
  assert.equal(f.hub.all('reachOutAttempt').length, 0);
});

test('Digest waits for its boundary, combines eligible facts, and spends one attempt', t => {
  const f = fixture(t); f.configure({ mode: 'Digest', digest_minutes: 5 });
  offer(f); offer(f, { key: 'calendar', topic: '晚间日程', source: 'google-calendar', kind: 'deadline', text: '晚间有一项已确认的安排。' });
  assert.equal(reserveReachOut(f.hub, 'owner', route).blocked, 'digest_wait');
  f.advance(4 * MINUTE);
  const attempt = reserveReachOut(f.hub, 'owner', route);
  assert.equal(attempt.mode, 'Digest'); assert.equal(attempt.candidates.length, 2);
  assert.match(attempt.text, /项目的操作说明/); assert.match(attempt.text, /晚间有一项/);
  assert.equal(reachOutSnapshot(f.hub).used.today, 1);
});

test('Gentle holds references but permits a verified deadline immediately', t => {
  const f = fixture(t); f.configure({ mode: 'Gentle' }); const reading = offer(f);
  assert.equal(reserveReachOut(f.hub, 'owner', route).blocked, 'digest_wait');
  const deadline = offer(f, { key: 'deadline', topic: '会议即将开始', source: 'google-calendar', kind: 'deadline', text: '已确认的会议将开始。' });
  const attempt = reserveReachOut(f.hub, 'owner', route);
  assert.deepEqual(attempt.candidates, [deadline.id]);
  assert.equal(f.hub.get('reachOutCandidate', reading.id).state, 'pending');
});

test('Digest preserves the original link at the end of a longer notification', t => {
  const f = fixture(t); f.configure({ mode: 'Digest', digest_minutes: 5 });
  const first = 'example/assistant · GitHub 更新\n' + '一条完整的发现。'.repeat(20) + '\n原文：https://github.com/example/assistant/commit/abc';
  offer(f, { text: first });
  offer(f, { key: 'second', topic: 'second', text: '另一个项目有了新变化。' });
  f.advance(4 * MINUTE);
  const attempt = reserveReachOut(f.hub, 'owner', route);
  assert.equal(attempt.candidates.length, 2);
  assert.ok(attempt.text.includes(first));
  assert.ok(attempt.text.includes('另一个项目有了新变化。'));
});

test('Active permits a reference immediately but retains cooldown and quota', t => {
  const f = fixture(t); f.configure({ mode: 'Active', max_daily: 2, min_gap_minutes: 5 });
  const reading = offer(f); const first = reserveReachOut(f.hub, 'owner', route);
  assert.deepEqual(first.candidates, [reading.id]); finishReachOut(f.hub, first.id, 'submitted');
  offer(f, { key: 'second', topic: '不同事实' });
  assert.equal(reserveReachOut(f.hub, 'owner', route).blocked, 'cooldown');
  f.advance(5 * MINUTE);
  const second = reserveReachOut(f.hub, 'owner', route); assert.ok(second.id);
  offer(f, { key: 'third', topic: '第三个不同事实' }); f.advance(5 * MINUTE);
  assert.equal(reserveReachOut(f.hub, 'owner', route).blocked, 'daily_budget');
});

test('bound WeChat and iMessage routes share owner delivery and analysis limits', t => {
  const f = fixture(t); f.configure({ mode: 'Active', max_daily: 1, max_analyses_daily: 1, min_gap_minutes: 5 });
  f.hub.bind({ ...route, conversationId: f.conversation.id });
  f.hub.bind({ ...otherRoute, conversationId: f.conversation.id });
  assert.equal(reachOutScope(f.hub, ...[route.channel, route.account, route.peer]), 'owner');
  assert.equal(reachOutScope(f.hub, ...[otherRoute.channel, otherRoute.account, otherRoute.peer]), 'owner');
  assert.equal(reserveAnalysis(f.hub, 'owner', { key: 'mail-reading', count: 1 }).allowed, true);
  assert.equal(reserveAnalysis(f.hub, 'owner', { key: 'wechat-followup', count: 1 }).blocked, 'analysis_budget');
  offer(f); offer(f, { key: 'second-route', topic: '另一事项', source: 'weixin-followup', route: otherRoute });
  const first = reserveReachOut(f.hub, 'owner', route); finishReachOut(f.hub, first.id, 'unknown'); f.advance(10 * MINUTE);
  assert.equal(reserveReachOut(f.hub, 'owner', otherRoute).blocked, 'daily_budget');
});

test('same topic from calendar and mail merges and shares the durable receipt', t => {
  const f = fixture(t); f.configure({ mode: 'Active' });
  const first = offer(f, { key: 'calendar:event-1', topic: '  Review   Meeting  ', source: 'google-calendar' });
  const second = offer(f, { key: 'mail:event-1', topic: 'review meeting', source: 'google-mail', text: '同一会议也出现在邮件中。' });
  assert.equal(second.state, 'merged'); assert.equal(second.mergedInto, first.id);
  const attempt = reserveReachOut(f.hub, 'owner', route); assert.deepEqual(attempt.candidates, [first.id]);
  finishReachOut(f.hub, attempt.id, 'unknown');
  assert.equal(candidateReceipt(f.hub, first.id).state, 'unknown');
  assert.equal(candidateReceipt(f.hub, second.id).state, 'unknown');
  assert.equal(f.hub.all('reachOutAttempt').length, 1);
});

test('unknown delivery remains reserved across database reopen and is never automatically replayed', t => {
  const f = fixture(t); f.configure({ mode: 'Active', min_gap_minutes: 5 });
  const candidate = offer(f); const attempt = reserveReachOut(f.hub, 'owner', route);
  finishReachOut(f.hub, attempt.id, 'unknown'); f.advance(10 * MINUTE);
  const reopened = new AgentHub(f.root, { now: f.now });
  try {
    assert.equal(reachOutSnapshot(reopened).unknown, 1);
    assert.equal(candidateReceipt(reopened, candidate.id).state, 'unknown');
    assert.equal(reserveReachOut(reopened, 'owner', route).blocked, 'empty_checklist');
    assert.equal(reopened.all('reachOutAttempt').length, 1);
  } finally { reopened.close(); }
});

test('dispatch rechecks current busy/context and mode without charging its reserved slot twice', async t => {
  const f = fixture(t); f.configure({ mode: 'Active', max_daily: 1 }); offer(f);
  const attempt = reserveReachOut(f.hub, 'owner', route); let sent = 0;
  assert.equal(reachOutGate(f.hub, 'owner'), 'daily_budget');
  const result = await dispatchReachOut(f.hub, attempt.id, { context: () => ({}), send: async () => { sent++; } });
  assert.equal(result.state, 'submitted'); assert.equal(sent, 1);
  assert.equal((await dispatchReachOut(f.hub, attempt.id, { context: () => ({}), send: async () => { sent++; } })).blocked, 'already_claimed');
  assert.equal(sent, 1);
  for (const [label, context, changeMode] of [
    ['busy', { busy: true }, false], ['context', { contextValid: false }, false], ['mode', {}, true],
  ]) {
    const scope = 'fixture-' + label; offer(f, { scope, key: label, topic: label });
    const pending = reserveReachOut(f.hub, scope, route);
    assert.ok(pending.id);
    if (changeMode) f.configure({ mode: 'Gentle' });
    const denied = await dispatchReachOut(f.hub, pending.id, { context: () => context, send: async () => { assert.fail('changed final conditions must prevent transport'); } });
    assert.equal(denied.state, 'cancelled');
    assert.equal(denied.blocked, { busy: 'conversation_active', context: 'context_expired', mode: 'mode_changed' }[label]);
  }
});

test('two independent SQLite workers can dispatch a persisted attempt only once', { timeout: 10_000 }, async t => {
  const f = fixture(t); f.configure({ mode: 'Active' }); offer(f);
  const attempt = reserveReachOut(f.hub, 'owner', route);
  const shared = new SharedArrayBuffer(8), counters = new Int32Array(shared);
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { AgentHub } = await import(workerData.storeUrl);
      const { dispatchReachOut } = await import(workerData.gateUrl);
      const hub = new AgentHub(workerData.root, { now: () => workerData.now });
      const counters = new Int32Array(workerData.shared);
      parentPort.postMessage({ ready: true });
      Atomics.wait(counters, 0, 0, 5000);
      try {
        const result = await dispatchReachOut(hub, workerData.id, {
          context: () => ({}),
          send: async () => { Atomics.add(counters, 1, 1); await new Promise(resolve => setTimeout(resolve, 20)); }
        });
        parentPort.postMessage({ result });
      } finally { hub.close(); }
    })().catch(error => { parentPort.postMessage({ error: error.stack }); });
  `;
  const workers = [0, 1].map(() => {
    const worker = new Worker(source, { eval: true, workerData: { root: f.root, now: f.now(), shared, id: attempt.id,
      storeUrl: new URL('../plugins/agent-hub/store.mjs', import.meta.url).href,
      gateUrl: new URL('../plugins/proactive/reach-out.mjs', import.meta.url).href } });
    let readyResolve, readyReject, resultResolve, resultReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    worker.on('message', message => {
      if (message.ready) readyResolve();
      if (message.result) resultResolve(message.result);
      if (message.error) { readyReject(new Error(message.error)); resultReject(new Error(message.error)); }
    });
    worker.on('error', error => { readyReject(error); resultReject(error); });
    return { worker, ready, result };
  });
  try {
    await Promise.all(workers.map(w => w.ready)); Atomics.store(counters, 0, 1); Atomics.notify(counters, 0, 2);
    const results = await Promise.all(workers.map(w => w.result));
    assert.equal(Atomics.load(counters, 1), 1);
    assert.deepEqual(results.map(r => r.state).sort(), ['cancelled', 'submitted']);
    assert.equal(results.find(r => r.state === 'cancelled').blocked, 'already_claimed');
    assert.equal(f.hub.get('reachOutAttempt', attempt.id).state, 'submitted');
  } finally { await Promise.all(workers.map(w => w.worker.terminate())); }
});

test('trial expiry and mode changes preserve normal limits and existing counters', t => {
  const f = fixture(t); f.configure({ mode: 'Active', max_daily: 2, min_gap_minutes: 180, trial: { endsAt: START + 10 * MINUTE, max_daily: 8, min_gap_minutes: 5 } });
  offer(f); const first = reserveReachOut(f.hub, 'owner', route); finishReachOut(f.hub, first.id, 'unknown');
  f.configure({ mode: 'Gentle' }); assert.equal(reachOutPolicy(f.hub).max_daily, 8);
  f.advance(11 * MINUTE);
  assert.equal(reachOutPolicy(f.hub).max_daily, 2); assert.equal(reachOutPolicy(f.hub).min_gap_minutes, 180);
  assert.equal(reachOutSnapshot(f.hub).used.today, 1);
  assert.equal(reachOutGate(f.hub, 'owner'), 'cooldown');
});

test('a queued digest checks every member when the second source is disabled', t => {
  const f = noticeFixture(t); f.add('calendar-fixture', 'google-calendar'); f.add('github-fixture', 'github'); const delivery = f.queueDigest();
  f.configureNotices({ sources: ['google-calendar'] });
  assert.equal(personalChannelPoll(f.hub, f.channel.token, { sourceAllowed: () => true }).delivery, null);
  assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
});

test('a queued digest checks expiry of its second member immediately before claiming', t => {
  const f = noticeFixture(t); f.add('calendar-fixture', 'google-calendar'); f.add('github-fixture', 'github', f.now() + 6 * MINUTE); const delivery = f.queueDigest();
  f.advance(2 * MINUTE); f.alive();
  assert.equal(personalChannelPoll(f.hub, f.channel.token, { sourceAllowed: () => true }).delivery, null);
  assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
});

test('a queued digest rechecks actual authority of every member, not just source preferences', t => {
  const f = noticeFixture(t); f.add('calendar-fixture', 'google-calendar'); f.add('github-fixture', 'github'); const delivery = f.queueDigest();
  const checked = [];
  assert.equal(personalChannelPoll(f.hub, f.channel.token, { sourceAllowed: source => { checked.push(source); return source !== 'github'; } }).delivery, null);
  assert.deepEqual(checked, ['google-calendar', 'github']); assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
});

test('the default claim authority fails closed in a fresh instance with no Connections grant', t => {
  const f = noticeFixture(t); f.add('calendar-fixture', 'google-calendar'); f.add('github-fixture', 'github'); const delivery = f.queueDigest();
  assert.equal(noticeSourceAllowed(f.root, 'google-calendar'), false);
  assert.equal(noticeSourceAllowed(f.root, 'github'), false);
  assert.equal(personalChannelPoll(f.hub, f.channel.token).delivery, null);
  assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
});

test('default claim allows a digest only while its actual Connections authority stamps remain valid', t => {
  const f = noticeFixture(t), authority = authorityFixture(f);
  try {
    f.add('calendar-fixture', 'google-calendar'); f.add('github-fixture', 'github'); const delivery = f.queueDigest(); authority.report();
    for (const n of f.hub.all('personalNotice')) {
      assert.ok(n.authorityStamp); assert.equal(noticeSourceAllowed(f.root, n.source, n), true);
    }
    assert.equal(personalChannelPoll(f.hub, f.channel.token).delivery.id, delivery.id);
  } finally { authority.manager.close(); }
});

test('an Active notice already queued is cancelled if the owner switches to Digest before claim', t => {
  const f = noticeFixture(t), authority = authorityFixture(f);
  try {
    f.configure({ mode: 'Active' });
    const offered = f.add('calendar-fixture', 'google-calendar');
    const delivery = f.hub.get('delivery', offered.deliveryId);
    assert.equal(delivery.state, 'pending');
    const attempts = f.hub.all('reachOutAttempt');
    assert.equal(attempts.length, 1); assert.equal(attempts[0].mode, 'Active'); assert.equal(attempts[0].state, 'queued');
    const notice = f.hub.all('personalNotice')[0];
    assert.equal(noticeSourceAllowed(f.root, notice.source, notice), true);
    f.configure({ mode: 'Digest' });
    assert.equal(personalChannelPoll(f.hub, f.channel.token).delivery, null, 'old Active urgency cannot carry through a new Digest preference');
    assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
    assert.equal(candidateReceipt(f.hub, notice.candidateId).state, 'cancelled');
    assert.equal(personalChannelPoll(f.hub, f.channel.token).delivery, null);
    assert.equal(f.hub.all('reachOutAttempt').length, 1); assert.equal(reachOutSnapshot(f.hub).used.today, 1);
  } finally { authority.manager.close(); }
});

test('Google A revoked and reconnected as B cannot authorize an old queued A digest', t => {
  const f = noticeFixture(t), authority = authorityFixture(f);
  try {
    const stampA = noticeSourceStamp(f.root, 'google-calendar');
    f.add('calendar-fixture', 'google-calendar'); f.add('github-fixture', 'github'); const delivery = f.queueDigest();
    authority.mutate({ operation: 'disconnect', id: 'google' });
    authority.mutate({ operation: 'connect', id: 'google', values: { account: 'account-b@example.invalid' } }); authority.report();
    const stampB = noticeSourceStamp(f.root, 'google-calendar');
    assert.ok(stampA); assert.ok(stampB); assert.notEqual(stampA, stampB);
    assert.equal(authority.manager.snapshot().items.find(i => i.id === 'google').state, 'connected');
    assert.equal(personalChannelPoll(f.hub, f.channel.token).delivery, null);
    assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
  } finally { authority.manager.close(); }
});

test('an old notice lacking an authority stamp remains blocked after services reconnect', t => {
  const f = noticeFixture(t);
  f.add('calendar-fixture', 'google-calendar'); f.add('github-fixture', 'github'); const delivery = f.queueDigest();
  const authority = authorityFixture(f);
  try {
    assert.ok(noticeSourceStamp(f.root, 'google-calendar'));
    assert.ok(f.hub.all('personalNotice').every(n => !n.authorityStamp));
    assert.equal(personalChannelPoll(f.hub, f.channel.token).delivery, null);
    assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
  } finally { authority.manager.close(); }
});

test('a changed GitHub account reported under the same grant cannot authorize the previous account digest', t => {
  const f = noticeFixture(t), authority = authorityFixture(f);
  try {
    f.add('calendar-fixture', 'google-calendar'); f.add('github-fixture', 'github'); const delivery = f.queueDigest();
    authority.report({ github: 'github-fixture-b' });
    assert.equal(authority.manager.snapshot().items.find(i => i.id === 'github').account, 'github-fixture-b');
    assert.equal(personalChannelPoll(f.hub, f.channel.token).delivery, null, 'a current connected service with a different account is not the source authority that produced this candidate');
    assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
  } finally { authority.manager.close(); }
});

test('pausing after a digest is queued cancels that digest without blocking an ordinary reply', t => {
  const f = noticeFixture(t); f.add('calendar-fixture', 'google-calendar'); f.add('github-fixture', 'github'); const delivery = f.queueDigest();
  f.configureNotices({ enabled: false });
  const ordinary = f.hub.reply(f.conversation.id, '这是你刚才问题的答复。', { channel: 'imessage', account: f.channel.channelId, peer: 'owner@example.invalid' });
  const claimed = personalChannelPoll(f.hub, f.channel.token, { sourceAllowed: () => true }).delivery;
  assert.equal(claimed.id, ordinary.id); assert.equal(f.hub.get('delivery', delivery.id).state, 'cancelled');
});

async function engineFixture(t, duringAnalysis = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'xiaoman-chief-engine-'));
  let now = Date.parse('2026-10-17T10:00:00+08:00'); const sent = []; let analyses = 0;
  const base = JSON.parse(readFileSync(new URL('../config/pa.example.json', import.meta.url), 'utf8')).proactive;
  const engine = new ProactiveEngine({ config: { ...base, state_dir: root, timezone: 'Asia/Shanghai' }, accountId: 'fixture', allowed: id => id === 'fixture', now: () => now,
    send: async (...args) => { sent.push(args); }, analyze: async () => '{"changes":[]}',
    followupAnalyze: async (_instructions, input) => { analyses++; const title = JSON.parse(input).candidate.title; await duringAnalysis(engine); return JSON.stringify({ decision: 'send', text: `你之前交代的「${title}」到提醒时间了。` }); },
  });
  await engine.initialize({ startTimer: false });
  t.after(async () => { await engine.stop(); rmSync(root, { recursive: true, force: true }); });
  // Switching only mode must work with initialize's partial policy record.
  configureReachOut(engine.hub, { revision: 0, mode: 'Active' });
  await engine.receive({ from_user_id: 'fixture', context_token: 'fixture-context' }, '/pa add 2026-10-17T10:06+08:00 取验收包裹');
  const task = () => engine.store.data.users.fixture.tasks.find(t => t.kind === 'reminder');
  now += 11 * MINUTE;
  return { engine, sent, task, analyses: () => analyses, advance: ms => { now += ms; } };
}

test('cancelling while the follow-up model runs prevents delivery', async t => {
  const f = await engineFixture(t, async engine => {
    const user = engine.store.data.users.fixture;
    await engine.management({ operation: 'cancel', userId: 'fixture', revision: user.revision, taskId: user.tasks.find(t => t.kind === 'reminder').id });
  });
  await f.engine.tick();
  assert.equal(f.analyses(), 1); assert.equal(f.task().status, 'cancelled'); assert.equal(f.sent.length, 0);
  assert.equal(f.engine.hub.all('reachOutAttempt').length, 0);
});

test('editing the task title while the model runs invalidates its old proposed text', async t => {
  const f = await engineFixture(t, async engine => {
    const user = engine.store.data.users.fixture;
    await engine.management({ operation: 'update', userId: 'fixture', revision: user.revision, taskId: user.tasks.find(t => t.kind === 'reminder').id, title: '改为取另一份验收材料' });
  });
  await f.engine.tick();
  assert.equal(f.analyses(), 1); assert.equal(f.task().title, '改为取另一份验收材料');
  assert.equal(f.sent.length, 0, 'a changed task revision must invalidate text generated from the previous title');
  assert.equal(f.engine.hub.all('reachOutAttempt').length, 0);
});

test('snoozing during model analysis neither sends nor reserves the obsolete due-time candidate', async t => {
  const f = await engineFixture(t, async engine => {
    const user = engine.store.data.users.fixture;
    await engine.management({ operation: 'snooze', userId: 'fixture', revision: user.revision, taskId: user.tasks.find(t => t.kind === 'reminder').id, minutes: 60 });
  });
  await f.engine.tick();
  assert.equal(f.task().status, 'pending'); assert.equal(f.sent.length, 0);
  assert.equal(f.engine.hub.all('reachOutAttempt').length, 0, 'obsolete candidates must not consume a new delivery attempt');
});

test('a failed transport is marked unknown and is not sent on subsequent engine ticks', async t => {
  const f = await engineFixture(t); let attempts = 0;
  f.engine.send = async () => { attempts++; throw new Error('fixture transport outcome unknown'); };
  await f.engine.tick(); f.advance(4 * 60 * MINUTE); await f.engine.tick();
  assert.equal(attempts, 1); assert.equal(f.task().status, 'delivery_unknown');
  assert.equal(f.engine.hub.all('reachOutAttempt')[0].state, 'unknown');
});

test('crossing into quiet hours while persisting a claimed reminder prevents the final send', async t => {
  const f = await engineFixture(t);
  f.advance(Date.parse('2026-10-17T21:54:00+08:00') - f.engine.now());
  await f.engine.management({ operation: 'add', userId: 'fixture', revision: f.engine.store.data.users.fixture.revision, title: '晚间验收提醒', notifyAt: Date.parse('2026-10-17T21:55:00+08:00') });
  f.advance(5 * MINUTE + 59_000);
  const save = f.engine.store.save.bind(f.engine.store);
  f.engine.store.save = async serialized => {
    await save(serialized);
    if (f.engine.store.data.users.fixture.tasks.some(t => t.status === 'sending')) f.advance(2_000);
  };
  await f.engine.tick();
  assert.equal(f.analyses(), 1);
  assert.ok(f.engine.now() >= Date.parse('2026-10-17T22:00:00+08:00'));
  assert.equal(f.sent.length, 0, 'quiet hours must be rechecked after awaited claim persistence and before transport');
});

function healthy(f, endpointId, conversationId = f.conversation.id) {
  f.hub.put('endpoint', { ...f.hub.get('endpoint', endpointId), lastSeen: f.now(), health: { authentication: 'verified', checkedAt: f.now(), expiresAt: f.now() + 48 * 60 * MINUTE } });
  f.hub.put('session', { id: JSON.stringify([conversationId, endpointId]), tools: REQUIRED_TOOLS, nativeSessionId: 'fixture-session' });
}

function statusOptions(f) {
  return { hub: f.hub, root: f.root, conversationId: f.conversation.id,
    settings: { revision: 1, config: { im: { provider: 'weixin', allow_from: ['fixture-owner'] }, proactive: { timezone: 'UTC' } } },
    runtime: { state: 'running', configRevision: 1, lastPollAt: f.now(), connected: true, account: 'fixture-account' } };
}

test('a missing host Intl timezone falls back to UTC and the raw status tool passes DSH lossless JSON validation', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.runtime', 'pa.json'), JSON.stringify({ proactive: { timezone: 'local' } }), { mode: 0o600 });
  const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  t.mock.method(Intl.DateTimeFormat.prototype, 'resolvedOptions', function () {
    return { ...originalResolvedOptions.call(this), timeZone: undefined };
  });
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, undefined);
  assert.equal(isJsonValue({ timezone: undefined }), false, 'the real DSH validator must detect undefined before serialization could silently drop it');
  assert.equal(reachOutPolicy(f.hub).timezone, 'UTC');
  f.submit('隔离状态回执验收'); const job = f.poll().job;
  const settings = statusOptions(f).settings; settings.config.proactive.timezone = 'local';
  const result = await statusTool({ hub: f.hub, root: f.root, token: f.pairing.token,
    input: { runId: job.id, lease: job.lease, arguments: {} }, read: async () => settings,
    rpc: async () => ({ kind: 'pa', data: { protocol: 1, configRevision: settings.revision, connected: true, lastPollAt: f.now(), account: 'fixture-account', users: [] } }),
  });
  assert.equal(result.reachOut.policy.timezone, 'UTC');
  assert.equal(isJsonValue(result), true, 'validate the untouched native tool return value, not a JSON.stringify round trip');
});

test('an online healthy alternate Agent cannot make an offline selected Agent appear executable', async t => {
  const f = fixture(t); const other = f.hub.pair({ label: 'Healthy alternate' }); healthy(f, other.endpointId);
  f.hub.bind({ ...otherRoute, conversationId: f.conversation.id });
  const status = await statusSnapshot(statusOptions(f));
  assert.equal(status.selectedEndpointId, f.pairing.endpointId);
  assert.equal(status.agents.find(a => a.id === other.endpointId).canExecute, true);
  assert.equal(status.agents.find(a => a.id === f.pairing.endpointId).canExecute, false);
  assert.match(status.summary, /暂不能确认/);
});

test('a fresh online WeChat channel requires the actual current-conversation binding', async t => {
  const f = fixture(t); healthy(f, f.pairing.endpointId);
  const before = await statusSnapshot(statusOptions(f));
  assert.equal(before.channels.find(c => c.id === 'weixin').state, 'online');
  assert.equal(before.channels.find(c => c.id === 'weixin').boundToConversation, false); assert.match(before.summary, /暂不能确认/);
  f.hub.bind({ ...otherRoute, conversationId: f.conversation.id });
  const after = await statusSnapshot(statusOptions(f)); assert.match(after.summary, /^可以从微信交代事情/);
});

test('heartbeat online does not imply authentication, required tools, or unexpired authorization', t => {
  const f = fixture(t); healthy(f, f.pairing.endpointId); const endpoint = f.hub.get('endpoint', f.pairing.endpointId);
  assert.equal(endpointReadiness(f.hub, endpoint, f.conversation.id).canExecute, true);
  const unverified = { ...endpoint, health: { ...endpoint.health, authentication: 'unknown' } };
  assert.equal(endpointReadiness(f.hub, unverified, f.conversation.id).canExecute, false);
  const expired = { ...endpoint, health: { ...endpoint.health, expiresAt: f.now() } };
  assert.equal(endpointReadiness(f.hub, expired, f.conversation.id).canExecute, false);
  f.hub.put('session', { id: JSON.stringify([f.conversation.id, endpoint.id]), tools: REQUIRED_TOOLS.filter(n => n !== 'xiaoman_sources') });
  const missing = endpointReadiness(f.hub, endpoint, f.conversation.id);
  assert.equal(missing.canExecute, false); assert.deepEqual(missing.missingTools, ['xiaoman_sources']);
});

test('login evidence explicitly rejects a successful process reporting Not logged in', async () => {
  const config = { provider: 'codex', command: 'unused-fixture-command', workspace: '/unused' };
  assert.equal((await probeLogin(config, START, async () => ({ stdout: 'Not logged in\n', stderr: '' }))).authentication, 'required');
  assert.equal((await probeLogin(config, START, async () => ({ stdout: 'Logged in using ChatGPT\n', stderr: '' }))).authentication, 'verified');
  assert.equal((await probeLogin(config, START, async () => ({ stdout: 'Checking credentials...\n', stderr: '' }))).authentication, 'unknown');
});

function actionFixture(t) {
  const f = fixture(t); f.submit(); const job = f.poll().job;
  const taskA = f.hub.taskAction({ operation: 'add', title: '取消用的验收待办 A', requestId: 'add-A' }).task;
  const taskB = f.hub.taskAction({ operation: 'add', title: '不得误取消的验收待办 B', requestId: 'add-B' }).task;
  const input = { tool: 'xiaoman_tasks', runId: job.id, lease: job.lease, callId: 'cancel-A', arguments: { operation: 'cancel', taskId: taskA.id, version: taskA.version } };
  return { ...f, job, taskA, taskB, input, call: more => f.hub.tool(f.pairing.token, { ...input, ...more }) };
}

test('typed task cancellation is previewed before mutation and executes exactly once after approval', t => {
  const f = actionFixture(t); const pending = f.call();
  assert.equal(pending.approvalRequired, true); assert.match(pending.action.preview, /验收待办 A/);
  assert.equal(f.hub.get('task', f.taskA.id).status, 'pending');
  f.hub.decide({ approvalId: pending.approvalId, decision: 'approve', conversationId: f.conversation.id });
  const result = f.call({ approvalId: pending.approvalId });
  assert.equal(result.task.status, 'cancelled'); assert.equal(result.task.version, 2);
  assert.deepEqual(f.call({ approvalId: pending.approvalId }), result);
  assert.equal(f.hub.get('task', f.taskA.id).version, 2);
});

test('changing parameters cannot reuse an approval before or after original execution', t => {
  const f = actionFixture(t); const pending = f.call();
  f.hub.decide({ approvalId: pending.approvalId, decision: 'approve' });
  const changed = { arguments: { operation: 'cancel', taskId: f.taskB.id, version: f.taskB.version }, approvalId: pending.approvalId };
  assert.throws(() => f.call(changed), { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.hub.get('task', f.taskB.id).status, 'pending');
  f.call({ approvalId: pending.approvalId });
  assert.throws(() => f.call(changed), { code: 'CONFLICT' });
  assert.equal(f.hub.get('task', f.taskB.id).status, 'pending');
});

test('same approved parameters under a new tool call require a new approval', t => {
  const f = actionFixture(t); const pending = f.call(); f.hub.decide({ approvalId: pending.approvalId, decision: 'approve' });
  assert.throws(() => f.call({ callId: 'another-call', approvalId: pending.approvalId }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.hub.get('task', f.taskA.id).status, 'pending');
});

test('approval is conversation-scoped, once-only, and cannot grant a session-wide capability', t => {
  const f = actionFixture(t); const pending = f.call(); const other = f.hub.newConversation({ endpointId: f.pairing.endpointId });
  assert.throws(() => f.hub.decide({ approvalId: pending.approvalId, decision: 'approve', conversationId: other.id }), { code: 'ITEM_NOT_FOUND' });
  assert.throws(() => f.hub.decide({ approvalId: pending.approvalId, decision: 'approve', fingerprint: 'different-parameters' }), { code: 'CONFLICT' });
  assert.throws(() => f.hub.decide({ approvalId: pending.approvalId, decision: 'approve', scope: 'session' }), { code: 'APPROVAL_SCOPE_UNSUPPORTED' });
  assert.equal(f.hub.get('task', f.taskA.id).status, 'pending');
});

test('cancelled execution fences an already accepted approval', t => {
  const f = actionFixture(t); const pending = f.call(); f.hub.decide({ approvalId: pending.approvalId, decision: 'approve' });
  f.hub.cancel(f.job.id);
  assert.throws(() => f.call({ approvalId: pending.approvalId }), { code: 'FORBIDDEN' });
  assert.equal(f.hub.get('task', f.taskA.id).status, 'pending');
});

test('endpoint revocation fences pending approvals and future mutations', t => {
  const f = actionFixture(t); const pending = f.call(); f.hub.revoke(f.pairing.endpointId);
  assert.throws(() => f.hub.decide({ approvalId: pending.approvalId, decision: 'approve' }), { code: 'CONFLICT' });
  assert.throws(() => f.call({ approvalId: pending.approvalId }));
  assert.equal(f.hub.get('task', f.taskA.id).status, 'pending');
});

test('deferred approvals remain visible and expired decisions cannot execute', async t => {
  const f = actionFixture(t); const pending = f.call(); f.hub.decide({ approvalId: pending.approvalId, decision: 'defer' });
  const status = await statusSnapshot(statusOptions(f));
  const waiting = status.waiting.find(a => a.id === pending.approvalId);
  assert.equal(waiting.state, 'deferred'); assert.deepEqual(waiting.choices, ['approve', 'reject', 'defer']);
  f.advance(4 * MINUTE);
  assert.throws(() => f.hub.decide({ approvalId: pending.approvalId, decision: 'approve' }), { code: 'CONFLICT' });
  assert.throws(() => f.call({ approvalId: pending.approvalId }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.hub.get('task', f.taskA.id).status, 'pending');
});

test('native public web tools accept only bounded read arguments and reject private or action targets', () => {
  assert.equal(nativeActionPolicy('web_search', { queries: ['Typeless pricing release notes'] }), 'read');
  for (const args of [{}, { queries: [] }, { queries: [''] }, { queries: ['x'.repeat(501)] }, { queries: ['safe'], command: 'send' }, { queries: Array(9).fill('query') }]) assert.equal(nativeActionPolicy('web_search', args), 'blocked');
  for (const url of ['https://github.com/trending', 'https://example.com/docs?q=routine']) assert.equal(nativeActionPolicy('web_fetch', { url }), 'read');
  assert.equal(nativeActionPolicy('web_fetch', { url: 'https://example.com/资料' }), 'read');
  assert.equal(nativeActionPolicy('web_fetch', { url: 'https://example.com/' + '中'.repeat(250) }), 'blocked');
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://[::1]/', 'https://localhost', 'https://service.internal', 'https://a.local', 'https://user:pass@example.com', 'https://example.com:8443', 'https://example.com/logout', 'https://example.com/unsubscribe?id=12', 'https://example.com/%64elete/user', 'https://example.com/?action=send', 'https://example.com/?access_token=secret']) assert.equal(nativeActionPolicy('web_fetch', { url }), 'blocked', url);
  assert.equal(nativeActionPolicy('web_fetch', { url: 'https://example.com', headers: { Authorization: 'secret' } }), 'blocked');
  assert.equal(nativeActionPolicy('Bash', { command: 'curl https://example.com' }), 'blocked');
});

test('scheduled inspection cannot mutate rules, plans, memory or reminders through managed tools', () => {
  const run = { routine: { id: 'daily', version: 1 }, journalItemId: 'own-item' };
  for (const [name, operation] of [['xiaoman_routines', 'result'], ['xiaoman_routines', 'get'], ['xiaoman_journal', 'list'], ['xiaoman_journal', 'get'], ['xiaoman_sources', 'mail_read'], ['xiaoman_report', undefined]]) assert.doesNotThrow(() => assertRoutineToolAccess(run, name, { operation, id: 'daily', itemId: 'own-item' }));
  for (const [name, operation] of [['xiaoman_routines', 'create'], ['xiaoman_routines', 'update'], ['xiaoman_routines', 'pause'], ['xiaoman_journal', 'widget'], ['xiaoman_tasks', 'add'], ['xiaoman_reminders', 'add'], ['xiaoman_memory', 'save'], ['xiaoman_memory', 'search'], ['xiaoman_history', 'list'], ['xiaoman_tasks', 'list'], ['xiaoman_first_task', 'propose'], ['unknown_tool', 'read']]) assert.throws(() => assertRoutineToolAccess(run, name, { operation }), { code: 'FORBIDDEN' });
  assert.doesNotThrow(() => assertRoutineToolAccess({}, 'xiaoman_routines', { operation: 'create' }));
});

test('FileChange and unknown native writes cannot become actionable by supplying a friendly title', async t => {
  const f = actionFixture(t);
  for (const name of ['FileChange', 'Bash', 'browser.click', 'gmail.send', 'run_code', 'unknown_mutation']) {
    assert.equal(actionPreview(name, { title: '温和的生活动作' }).approvable, false);
    assert.equal(nativeActionPolicy(name, {}), 'blocked');
  }
  assert.equal(nativeActionPolicy('read_file', {}), 'read'); assert.equal(nativeActionPolicy('xiaoman_tasks', {}), 'managed');
  const a = requestAction(f.hub, { run: f.hub.get('run', f.job.id), tool: 'FileChange', parameters: {}, callId: 'native-file', title: '请直接批准', native: true });
  assert.throws(() => f.hub.decide({ approvalId: a.id, decision: 'approve' }), { code: 'ACTION_UNSUPPORTED' });
  const status = await statusSnapshot(statusOptions(f));
  assert.deepEqual(status.waiting.find(x => x.id === a.id).choices, ['accept_limit', 'reject']);
  assert.equal(f.hub.decide({ approvalId: a.id, decision: 'accept_limit' }).state, 'limited');
});

test('the channel progress reply offers accept-limit rather than approve for an unsupported native action', async t => {
  const f = actionFixture(t);
  f.hub.bind({ ...otherRoute, conversationId: f.conversation.id });
  const a = requestAction(f.hub, { run: f.hub.get('run', f.job.id), tool: 'FileChange', parameters: {}, callId: 'unsupported-progress', native: true });
  const channel = new HubChannel({ root: f.root, channel: otherRoute.channel, account: otherRoute.account, allowed: peer => peer === otherRoute.peer, send: async () => { assert.fail('this test must not flush a real or fixture message'); }, autoFlush: false });
  channel.hub.now = f.now;
  try {
    await channel.receive({ peer: otherRoute.peer, text: '进度', requestId: 'progress-fixture' });
    const response = channel.hub.all('message').findLast(m => m.role === 'assistant');
    const approvalLine = response.text.split('\n').find(line => line.includes(a.id));
    assert.ok(approvalLine);
    assert.match(approvalLine, /接受限制/);
    assert.doesNotMatch(approvalLine, /回复批准/);
  } finally { await channel.close(); }
});

test('journal cancellation uses a typed preview, exact approval and persistent idempotent receipt', async t => {
  const f = actionFixture(t);
  const settings = { installed: false, config: { agent: { provider: 'disabled' }, im: { provider: 'disabled' }, proactive: { timezone: 'UTC' } } };
  const journal = createJournalControl({ root: f.root, readSettings: async () => settings, rpc: async () => { assert.fail('isolated disabled journal must not request a real runtime'); } });
  const call = (args, callId, approvalId) => journalTool({ hub: f.hub, journal, read: async () => settings, token: f.pairing.token, input: { runId: f.job.id, lease: f.job.lease, arguments: args, callId, approvalId } });
  try {
    const listed = await call({ operation: 'list' });
    const added = await call({ operation: 'add', revision: listed.revision, values: { kind: 'arrangement', title: '只存在临时账本的生日验收安排', date: null, note: '验收条件，不是真实生日' } }, 'journal-add');
    const args = { operation: 'cancel', revision: added.revision, itemId: added.item.id, itemVersion: added.item.version };
    const pending = await call(args, 'journal-cancel');
    assert.equal(pending.approvalRequired, true); assert.match(pending.action.preview, /生日验收安排/);
    assert.equal(journal.store.snapshot({ account: 'local', userId: 'owner' }).items[0].status, 'planned');
    f.hub.decide({ approvalId: pending.approvalId, decision: 'approve' });
    await assert.rejects(call({ ...args, itemVersion: args.itemVersion + 1 }, 'journal-cancel', pending.approvalId), { code: 'APPROVAL_REQUIRED' });
    const result = await call(args, 'journal-cancel', pending.approvalId);
    assert.equal(result.saved, true); assert.equal(result.item.status, 'cancelled');
    const replay = await call(args, 'journal-cancel', pending.approvalId);
    assert.equal(replay.item.version, result.item.version);
    assert.equal(journal.store.snapshot({ account: 'local', userId: 'owner' }).items.length, 1);
    await assert.rejects(call({ ...args, itemVersion: args.itemVersion + 1 }, 'journal-cancel', pending.approvalId), { code: 'CONFLICT' });
  } finally { await journal.close(); }
});

async function reminderFixture(t) {
  const f = actionFixture(t), reminder = await engineFixture(t);
  f.hub.bind({ channel: 'weixin', account: reminder.engine.account, peer: 'fixture', conversationId: f.conversation.id });
  const settings = { socket: 'unused-fixture-socket', config: { im: { provider: 'weixin', access_policy: 'allowlist', allow_from: ['fixture'] }, proactive: reminder.engine.config } };
  let mutations = 0, loseResponse = false;
  const rpc = async (_socket, request) => {
    if (request.operation === 'snapshot') return { kind: 'pa', data: { protocol: 1, account: reminder.engine.account, users: await reminder.engine.management({ operation: 'snapshot' }) } };
    mutations++;
    const users = await reminder.engine.management(request);
    if (loseResponse) throw Object.assign(new Error('CONTROL_TIMEOUT'), { code: 'CONTROL_TIMEOUT' });
    return { kind: 'pa', data: { users } };
  };
  const args = { operation: 'cancel', revision: reminder.engine.store.data.users.fixture.revision, taskId: reminder.task().id };
  const call = (approvalId, changed = args) => reminderTool({ hub: f.hub, root: f.root, read: async () => settings, rpc, token: f.pairing.token, input: { runId: f.job.id, lease: f.job.lease, callId: 'reminder-cancel', arguments: changed, approvalId } });
  return { ...f, reminder, args, call, mutations: () => mutations, loseResponse: () => { loseResponse = true; } };
}

test('cancelling a reminder requires its exact previewed arguments and cannot replay a changed version', async t => {
  const f = await reminderFixture(t);
  const pending = await f.call(); assert.equal(pending.approvalRequired, true); assert.match(pending.action.preview, /取验收包裹/);
  assert.equal(f.mutations(), 0); assert.equal(f.reminder.task().status, 'pending');
  f.hub.decide({ approvalId: pending.approvalId, decision: 'approve' });
  await assert.rejects(f.call(pending.approvalId, { ...f.args, revision: f.args.revision + 1 }), { code: 'APPROVAL_REQUIRED' });
  const result = await f.call(pending.approvalId); assert.equal(result.saved, true); assert.equal(f.reminder.task().status, 'cancelled');
  assert.deepEqual(await f.call(pending.approvalId), result); assert.equal(f.mutations(), 1);
  await assert.rejects(f.call(pending.approvalId, { ...f.args, revision: f.args.revision + 1 }), { code: 'CONFLICT' });
  assert.equal(f.mutations(), 1);
});

test('an approved reminder cancellation with a lost response is not automatically retried', async t => {
  const f = await reminderFixture(t); const pending = await f.call();
  f.hub.decide({ approvalId: pending.approvalId, decision: 'approve' }); f.loseResponse();
  await assert.rejects(f.call(pending.approvalId), { code: 'CONTROL_TIMEOUT' });
  assert.equal(f.reminder.task().status, 'cancelled');
  await assert.rejects(f.call(pending.approvalId), { code: 'CONTROL_TIMEOUT' });
  assert.equal(f.mutations(), 1); assert.equal(f.hub.get('effect', f.job.id + ':reminder-cancel').state, 'uncertain');
});

test('canonical parameter fingerprints are stable but do not hide a changed task version', () => {
  const a = { operation: 'cancel', taskId: 'fixture', version: 1 };
  const reordered = { version: 1, taskId: 'fixture', operation: 'cancel' };
  assert.equal(actionFingerprint('xiaoman_tasks', a), actionFingerprint('xiaoman_tasks', reordered));
  assert.notEqual(actionFingerprint('xiaoman_tasks', a), actionFingerprint('xiaoman_tasks', { ...a, version: 2 }));
});

test('consuming an accepted approval directly is also one-shot', t => {
  const f = actionFixture(t); const options = { run: f.hub.get('run', f.job.id), tool: 'xiaoman_tasks', parameters: f.input.arguments, callId: 'one-shot' };
  const a = requestAction(f.hub, options); f.hub.decide({ approvalId: a.id, decision: 'approve' });
  assert.equal(requireAction(f.hub, { ...options, approvalId: a.id }), null);
  assert.throws(() => requireAction(f.hub, { ...options, approvalId: a.id }), { code: 'APPROVAL_REQUIRED' });
});

for (const state of ['running', 'waiting_approval', 'uncertain', 'cancelling']) {
  test(`a ${state} run blocks another endpoint from claiming the same conversation`, t => {
    const f = fixture(t); const second = f.hub.pair({ label: 'Second endpoint' });
    const first = f.submit(); const job = f.poll().job;
    assert.equal(job.id, first.id);
    if (state === 'waiting_approval') requestAction(f.hub, { run: f.hub.get('run', first.id), tool: 'xiaoman_tasks', parameters: { operation: 'cancel', taskId: 'fixture', version: 1 }, callId: 'hold' });
    if (state === 'uncertain') { f.advance(46_000); f.hub.expire(); }
    if (state === 'cancelling') f.hub.cancel(first.id);
    assert.equal(f.hub.get('run', first.id).status, state);
    const waiting = f.submit('交给另一个执行端', { endpointId: second.endpointId });
    const reopened = new AgentHub(f.root, { now: f.now });
    try {
      assert.equal(reopened.poll(second.token, { runnerId: 'second-runner' }).job, null);
      assert.equal(reopened.get('run', waiting.id).status, 'queued');
      // Mutual exclusion is scoped to a conversation, not a global stop.
      const unrelated = reopened.newConversation({ endpointId: second.endpointId });
      const independent = reopened.submit({ conversationId: unrelated.id, content: '独立会话', requestId: randomUUID() }).run;
      assert.equal(reopened.poll(second.token, { runnerId: 'second-runner' }).job.id, independent.id);
    } finally { reopened.close(); }
  });
}

test('confirmed stop releases a conversation for another endpoint and fences old results', t => {
  const f = fixture(t); const second = f.hub.pair({ label: 'Second endpoint' }); f.submit(); const first = f.poll().job;
  const queued = f.submit('下一项任务', { endpointId: second.endpointId });
  f.hub.cancel(first.id); assert.equal(f.hub.poll(second.token, { runnerId: 'second-runner' }).job, null);
  f.hub.cancel(first.id, true);
  assert.equal(f.hub.poll(second.token, { runnerId: 'second-runner' }).job.id, queued.id);
  const beforeMessages = f.hub.all('message').length;
  assert.deepEqual(f.hub.event(f.pairing.token, { runId: first.id, lease: first.lease, seq: 1, type: 'completed', value: '旧执行结果不得覆盖新任务' }), { accepted: false, status: 'cancelled' });
  assert.equal(f.hub.all('message').length, beforeMessages);
  assert.equal(f.hub.get('run', queued.id).status, 'running');
});
