import { saveBot, botSnapshot } from '../plugins/agent-hub/bots.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { createRoutineController, routineTimes, routineTool } from '../plugins/agent-hub/routines.mjs';

const values = (more = {}) => ({ title: '项目巡查', instruction: '检查公开项目是否有值得整理的新进展。', schedule: { time: '09:00', timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5, 6, 7] }, trigger: { condition: '有新的公开进展', mode: 'changed' }, ...more });

test('preflight names the actual incomplete source, permits a verified reread, and does not commit a result', async t => {
  const f = await fixture(t), { routine } = await f.create();
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'preflight' });
  const job = f.poll(); f.read(job, { status: 'incomplete' });
  const args = { operation: 'verify', outcome: 'checked', matched: false, summary: 'No changes', facts: [], checks: [{ source: 'https://example.invalid/project', observedAt: f.hub.now() }] };
  const verify = () => f.routines.action(args, { run: job });
  const rejected = await verify();
  assert.equal(rejected.accepted, false); assert.deepEqual(rejected.gaps, [{ source: 'https://example.invalid/project', status: 'incomplete' }]);
  assert.equal(f.hub.get('run', job.id).routineResult, undefined);
  f.read(job); assert.equal((await verify()).accepted, true);
  await f.result(job, { ...args, operation: 'result' }, false); f.complete(job);
  assert.equal(f.hub.get('routineRun', job.routine.occurrenceId).status, 'quiet');
});
async function fixture(t, at = '2026-10-26T00:00:00Z') {
  const root = await mkdtemp(join(tmpdir(), 'pa-routine-')); let now = Date.parse(at);
  const hub = new AgentHub(root, { now: () => now }), store = new JournalStore(root, { now: () => now });
  const journal = { store }, pairing = hub.pair({ label: 'Routine fixture' });
  const routines = createRoutineController({ hub, journal, read: async () => ({ config: { proactive: { timezone: 'Asia/Shanghai' } } }) });
  t.after(async () => { hub.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const create = (input = values(), requestId = crypto.randomUUID()) => routines.action({ operation: 'create', requestId, values: input });
  const poll = () => hub.poll(pairing.token, { runnerId: 'fixture', routineGuardVersion: 1 }).job;
  const read = (job, more = {}) => hub.event(pairing.token, { runId: job.id, lease: job.lease, seq: hub.get('run', job.id).seq + 1, type: 'source_receipt', value: { tool: 'web_fetch', source: 'https://example.invalid/project', status: 'completed', observedAt: now, ...more } });
  const result = (job, more = {}, receipt = true) => {
    if (receipt && more.outcome !== 'blocked') read(job);
    return routineTool({ hub, routines, token: pairing.token, input: { runId: job.id, lease: job.lease, callId: 'result', arguments: { operation: 'result', outcome: 'checked', matched: true, summary: '发现一项新进展', checks: [{ source: 'https://example.invalid/project', observedAt: now }], facts: [{ key: 'https://example.invalid/project/release/1', summary: '发布了第一个版本', url: 'https://example.invalid/project/release/1' }], ...more } } });
  };
  const complete = (job, more = {}) => hub.event(pairing.token, { runId: job.id, lease: job.lease, seq: hub.get('run', job.id).seq + 1, type: 'completed', value: '巡查完成', ...more });
  return { root, hub, store, journal, routines, pairing, create, poll, read, result, complete, advance: ms => { now += ms; }, set: value => { now = Date.parse(value); } };
}

test('calendar times honor weekdays, DST gaps and repeated clock hours without 24-hour drift', () => {
  const schedule = { time: '09:00', timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6, 7] };
  assert.equal(new Date(routineTimes(schedule, Date.parse('2026-03-07T15:00:00Z')).next).toISOString(), '2026-03-08T13:00:00.000Z');
  assert.equal(new Date(routineTimes({ ...schedule, time: '02:30' }, Date.parse('2026-03-08T05:00:00Z')).next).toISOString(), '2026-03-09T06:30:00.000Z');
  const weeklyGap = routineTimes({ ...schedule, time: '02:30', days: [7] }, Date.parse('2026-03-06T12:00:00Z'));
  assert.equal(new Date(weeklyGap.next).toISOString(), '2026-03-15T06:30:00.000Z');
  assert.equal(new Date(weeklyGap.previous).toISOString(), '2026-03-01T07:30:00.000Z');
  const repeated = { ...schedule, time: '01:30' };
  assert.equal(new Date(routineTimes(repeated, Date.parse('2026-11-01T04:00:00Z')).next).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(new Date(routineTimes(repeated, Date.parse('2026-11-01T05:45:00Z')).next).toISOString(), '2026-11-02T06:30:00.000Z');
  const weekday = { ...schedule, timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5] };
  assert.equal(new Date(routineTimes(weekday, Date.parse('2026-10-30T02:00:00Z')).next).toISOString(), '2026-11-02T01:00:00.000Z');
});

test('creation is durable and idempotent, owns a real journal, and uses the instance timezone', async t => {
  const f = await fixture(t), input = values(); delete input.schedule.timezone;
  const first = await f.create(input, 'create-once'), second = await f.create(input, 'create-once');
  assert.deepEqual(second, first);
  assert.equal(first.routine.schedule.timezone, 'Asia/Shanghai');
  assert.equal((await f.routines.action({ operation: 'list' })).timezone, 'Asia/Shanghai');
  assert.equal(f.hub.all('routine').length, 1); assert.equal(f.hub.all('conversation').length, 1);
  const item = f.store.snapshot().items.find(item => item.id === first.routine.journalItemId);
  assert.equal(item.conversationId, first.routine.conversationId);
  assert.equal(f.hub.all('message').length, 0);
  await assert.rejects(f.create(values({ title: '其他巡查' }), 'create-once'), { code: 'CONFLICT' });
});

test('a crash between the Hub and journal link resumes the same conversation and item', async t => {
  const f = await fixture(t), original = f.store.ensureConversation.bind(f.store); let failOnce = true;
  f.store.ensureConversation = (...args) => { const item = original(...args); if (failOnce) { failOnce = false; throw new Error('lost journal response'); } return item; };
  await assert.rejects(f.create(values(), 'cross-db'), /lost journal response/);
  const recovered = await f.create(values(), 'cross-db');
  assert.equal(f.hub.all('routine').length, 1); assert.equal(f.hub.all('conversation').length, 1);
  assert.equal(f.store.snapshot().items.length, 1); assert.ok(recovered.routine.journalItemId);
});

test('Timer is persistent, concurrent ticks queue one background run, and no fake user input or delivery exists', async t => {
  const f = await fixture(t), { routine } = await f.create();
  f.set('2026-10-26T01:00:01Z');
  const other = new AgentHub(f.root, { now: f.hub.now }); t.after(() => other.close());
  const reopened = createRoutineController({ hub: other, journal: f.journal });
  await Promise.all([f.routines.tick(), f.routines.tick(), reopened.tick()]);
  assert.equal(f.hub.all('run').length, 1); assert.equal(f.hub.all('routineRun').length, 1);
  const job = f.poll(); assert.equal(job.journalItemId, routine.journalItemId); assert.ok(job.routine);
  assert.equal(job.messageId, null); assert.deepEqual(job.source, { channel: 'web' });
  await f.result(job); f.complete(job);
  assert.equal(f.hub.get('run', job.id).routinePublished, true);
  assert.deepEqual(f.hub.get('run', job.id).report.artifacts, [{ label: '发布了第一个版本', url: 'https://example.invalid/project/release/1' }]);
  assert.equal(f.routines.snapshot().routines[0].lastStatus, 'published');
  assert.equal(f.hub.all('message').length, 0); assert.equal(f.hub.all('delivery').length, 0);
  await reopened.tick(); assert.equal(f.hub.all('run').length, 1);
});

test('result accepts matching optional id/version without allowing another routine or version to receive it', async t => {
  const f = await fixture(t), { routine } = await f.create(), { routine: other } = await f.create(values({ title: '另一项巡查' }));
  await f.routines.action({ operation: 'run_now', id: routine.id, version: routine.version, requestId: 'current-result' });
  const job = f.poll();
  const queued = await f.routines.action({ operation: 'run_now', id: other.id, version: other.version, requestId: 'other-result' });
  await assert.rejects(f.result(job, { id: other.id, version: other.version }), { code: 'FORBIDDEN' });
  for (const version of [routine.version - 1, routine.version + 1, String(routine.version)]) {
    await assert.rejects(f.result(job, { id: routine.id, version }), { code: 'VERSION_CONFLICT' });
  }
  assert.equal(f.hub.get('run', job.id).routineResult, undefined);
  assert.equal(f.hub.get('run', queued.run.runId).routineResult, undefined);
  assert.equal(f.hub.all('routineFact').length, 0);
  await assert.rejects(f.result(job, { id: routine.id, version: routine.version, checks: [] }), { code: 'INVALID_INPUT' });
  const accepted = await f.result(job, { id: routine.id, version: routine.version });
  assert.equal(accepted.routineId, routine.id);
  assert.equal(accepted.occurrenceId, job.routine.occurrenceId);
  assert.deepEqual(await f.result(job, { id: routine.id }), accepted);
  assert.deepEqual(await f.result(job, { version: routine.version }), accepted);
  assert.deepEqual(await f.result(job), accepted, 'Optional identity fields do not change the idempotent result');
  f.complete(job);
  assert.equal(f.hub.get('run', job.id).routinePublished, true);
  assert.equal(f.hub.get('run', queued.run.runId).status, 'queued');
  assert.equal(f.hub.get('run', queued.run.runId).routineResult, undefined);
  assert.ok(f.hub.all('routineFact').every(fact => fact.routineId === routine.id));
});

test('missed days coalesce to the most recent occurrence and creation does not replay an earlier hour', async t => {
  const f = await fixture(t, '2026-10-26T02:00:00Z'); await f.create();
  await f.routines.tick(); assert.equal(f.hub.all('run').length, 0);
  f.set('2026-10-30T03:00:00Z'); await f.routines.tick();
  assert.equal(f.hub.all('run').length, 1);
  assert.equal(new Date(f.hub.all('routineRun')[0].scheduledAt).toISOString(), '2026-10-30T01:00:00.000Z');
});

test('changed Trigger deduplicates source facts across checks and quiet runs preserve the published report', async t => {
  const f = await fixture(t); await f.create(); f.set('2026-10-26T01:00:00Z'); await f.routines.tick();
  const first = f.poll(); await f.result(first); f.complete(first);
  const original = f.hub.get('run', first.id).report;
  f.set('2026-10-27T01:00:00Z'); await f.routines.tick(); const second = f.poll();
  assert.match(second.prompt, /https:\/\/example.invalid\/project\/release\/1/);
  await f.result(second); f.complete(second);
  assert.equal(f.hub.get('run', second.id).routinePublished, false);
  assert.equal(f.hub.get('routineRun', second.routine.occurrenceId).status, 'quiet');
  assert.deepEqual(f.hub.get('run', first.id).report, original);
  assert.equal(f.hub.all('routineFact').length, 1);
});

test('a mixed changed result publishes only new facts in its summary, links and notification occurrence', async t => {
  const f = await fixture(t), { routine } = await f.create();
  const old = { key: 'https://github.com/makecindy/cindy', summary: '此前已回报的项目', url: 'https://github.com/makecindy/cindy' };
  const fresh = { key: 'https://github.com/example/new-project', summary: '新项目提供了可核对的新能力', url: 'https://github.com/example/new-project' };
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'old-fact' });
  const first = f.poll(); await f.result(first, { facts: [old], summary: old.summary }); f.complete(first);
  const original = f.hub.get('run', first.id).report;
  const { scopeHash, ...legacy } = f.hub.all('routineFact')[0]; f.hub.put('routineFact', legacy);
  f.advance(1000);
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'mixed-facts' });
  const second = f.poll(), mixedSummary = '两个此前从未回报的项目：此前已回报的项目、新项目';
  await f.result(second, { facts: [old, fresh], summary: mixedSummary });
  f.hub.put('run', { ...f.hub.get('run', second.id), report: { outcome: 'completed', summary: mixedSummary, artifacts: [
    { label: old.summary, url: old.url }, { label: fresh.summary, url: fresh.url }, { label: '额外旧链接', url: 'https://example.invalid/untracked' },
  ] } });
  f.complete(second);
  const run = f.hub.get('run', second.id), occurrence = f.hub.get('routineRun', second.routine.occurrenceId);
  assert.equal(run.routinePublished, true);
  assert.deepEqual(run.routineResult.facts, [old, fresh], 'The original submission stays available as audit evidence');
  assert.equal(run.routineResult.summary, mixedSummary);
  assert.equal(run.report.summary, fresh.summary);
  assert.deepEqual(run.report.artifacts, [{ label: fresh.summary, url: fresh.url }]);
  assert.equal(occurrence.summary, fresh.summary);
  assert.deepEqual(occurrence.facts, [fresh], 'Notifications use the fresh projection rather than the raw batch');
  assert.deepEqual(f.hub.get('run', first.id).report, original);
  assert.equal(f.hub.all('routineFact').length, 2);
  f.advance(1000);
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'repeat-mixed-facts' });
  const third = f.poll(); await f.result(third, { facts: [old, fresh] }); f.complete(third);
  assert.equal(f.hub.get('run', third.id).routinePublished, false);
  assert.equal(f.hub.get('routineRun', third.routine.occurrenceId).status, 'quiet');
});

test('a large mixed batch bounds its published summary while retaining every original fact', async t => {
  const f = await fixture(t), { routine } = await f.create();
  const old = { key: 'already-published', summary: '旧事实不能重新进入回报' };
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'large-batch-old' });
  const first = f.poll(); await f.result(first, { facts: [old] }); f.complete(first);
  f.advance(1000);
  const fresh = Array.from({ length: 59 }, (_, index) => ({ key: `new-event-${index}`, summary: `新事实${index}：` + '内容'.repeat(495) }));
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'large-batch-new' });
  const second = f.poll(); await f.result(second, { facts: [old, ...fresh], summary: '一旧加五十九新' }); f.complete(second);
  const run = f.hub.get('run', second.id), occurrence = f.hub.get('routineRun', second.routine.occurrenceId);
  assert.equal(run.routinePublished, true);
  assert.ok(run.report.summary.length <= 1200);
  assert.match(run.report.summary, /^新事实0：/);
  assert.match(run.report.summary, /…（部分内容已省略）$/);
  assert.doesNotMatch(run.report.summary, /旧事实不能重新进入回报/);
  assert.equal(occurrence.summary, run.report.summary);
  assert.deepEqual(occurrence.facts, fresh);
  assert.deepEqual(run.routineResult.facts, [old, ...fresh]);
  assert.equal(run.routineResult.summary, '一旧加五十九新');
});

test('always Trigger may publish the same facts once per period while unmatched checks stay quiet', async t => {
  const f = await fixture(t); await f.create(values({ trigger: { condition: '当天已核查', mode: 'always' } }));
  for (const day of [26, 27]) {
    f.set(`2026-10-${day}T01:00:00Z`); await f.routines.tick(); const job = f.poll(); await f.result(job); f.complete(job);
    assert.equal(f.hub.get('run', job.id).routinePublished, true);
  }
  f.set('2026-10-28T01:00:00Z'); await f.routines.tick(); const job = f.poll();
  await f.result(job, { matched: false, facts: [], summary: '检查完成，条件未满足' }); f.complete(job);
  assert.equal(f.hub.get('routineRun', job.routine.occurrenceId).status, 'quiet');
});

test('missing evidence, blocked reads, partial reports and failed source receipts never become quiet success', async t => {
  const f = await fixture(t); const { routine } = await f.create();
  for (const kind of ['missing', 'blocked', 'partial', 'source']) {
    await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: kind }); const job = f.poll();
    await assert.rejects(f.result(job, { checks: [] }), { code: 'INVALID_INPUT' });
    if (kind !== 'missing') await f.result(job, kind === 'blocked' ? { outcome: 'blocked', matched: false, facts: [], checks: [], summary: '来源暂不可读' } : { matched: false, facts: [], summary: '本轮检查未发现更新' });
    if (kind === 'partial') f.hub.put('run', { ...f.hub.get('run', job.id), report: { outcome: 'partial', summary: '只读了一部分' } });
    if (kind === 'source') f.hub.put('sourceRequest', { id: 'failed-read', runId: job.id, status: 'failed' });
    f.complete(job);
    const record = f.hub.get('routineRun', job.routine.occurrenceId);
    assert.equal(record.status, 'failed'); assert.equal(f.hub.get('run', job.id).routinePublished, false); assert.ok(record.error);
    f.advance(1000);
  }
  assert.equal(f.hub.all('delivery').length, 0); assert.equal(f.hub.all('message').length, 0);
});

test('pause and rule revision fence queued and in-flight outcomes; resume cannot replay a missed period', async t => {
  const f = await fixture(t), { routine } = await f.create(); f.set('2026-10-26T01:00:00Z'); await f.routines.tick();
  const job = f.poll(); await f.result(job);
  const paused = await f.routines.action({ operation: 'pause', id: routine.id, version: 1, requestId: 'pause' });
  assert.equal(f.hub.get('run', job.id).status, 'cancelling');
  f.complete(job); assert.equal(f.hub.get('run', job.id).routinePublished, false);
  f.hub.event(f.pairing.token, { runId: job.id, lease: job.lease, seq: f.hub.get('run', job.id).seq + 1, type: 'stopped', value: null });
  assert.equal(f.hub.get('routineRun', job.routine.occurrenceId).status, 'superseded');
  f.set('2026-10-28T02:00:00Z'); await f.routines.tick(); assert.equal(f.hub.all('run').length, 1);
  await f.routines.action({ operation: 'resume', id: routine.id, version: paused.routine.version, requestId: 'resume' });
  await f.routines.tick(); assert.equal(f.hub.all('run').length, 1);
  await assert.rejects(f.routines.action({ operation: 'pause', id: routine.id, version: 1, requestId: 'stale' }), { code: 'VERSION_CONFLICT' });
});

test('uncertain execution blocks overlap and never automatically repeats after restart', async t => {
  const f = await fixture(t), { routine } = await f.create(); f.set('2026-10-26T01:00:00Z'); await f.routines.tick(); const job = f.poll();
  f.complete(job, { type: 'uncertain', value: 'TRANSPORT_LOST' });
  f.set('2026-10-28T02:00:00Z'); await f.routines.tick(); assert.equal(f.hub.all('run').length, 1);
  await assert.rejects(f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'retry' }), { code: 'ROUTINE_BUSY' });
  assert.equal(f.routines.snapshot().routines[0].lastStatus, 'uncertain');
  f.hub.cancel(job.id, true); await f.routines.tick(); assert.equal(f.hub.all('run').length, 2);
});

test('closing the journal blocks future scans and rejects in-flight publication', async t => {
  const f = await fixture(t), { routine } = await f.create(); f.set('2026-10-26T01:00:00Z'); await f.routines.tick(); const job = f.poll(); await f.result(job);
  const state = f.store.snapshot(), item = state.items.find(item => item.id === routine.journalItemId);
  f.store.mutate({ account: 'local', userId: 'owner' }, { operation: 'done', revision: state.revision, itemId: item.id, itemVersion: item.version });
  f.complete(job); assert.equal(f.hub.get('run', job.id).routinePublished, false);
  f.set('2026-10-27T02:00:00Z'); await f.routines.tick(); assert.equal(f.hub.all('run').length, 1);
  assert.equal(f.routines.snapshot().routines[0].error, 'JOURNAL_CLOSED');
});

test('only the authenticated current background lease may submit results or change its outcome', async t => {
  const f = await fixture(t), { routine } = await f.create();
  await assert.rejects(f.routines.action({ operation: 'result', outcome: 'blocked', matched: false, summary: '伪造', facts: [], checks: [] }), { code: 'FORBIDDEN' });
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'manual' }); const job = f.poll();
  await assert.rejects(routineTool({ hub: f.hub, routines: f.routines, token: f.pairing.token, input: { runId: job.id, lease: 'wrong', callId: 'bad', arguments: { operation: 'list' } } }), { code: 'FORBIDDEN' });
  await assert.rejects(routineTool({ hub: f.hub, routines: f.routines, token: f.pairing.token, input: { runId: job.id, lease: job.lease, callId: 'bad', arguments: { operation: 'pause', id: routine.id, version: 1 } } }), { code: 'FORBIDDEN' });
  await f.result(job); await f.result(job);
  await assert.rejects(f.result(job, { summary: '不同的结果' }), { code: 'CONFLICT' });
});

test('Agent-created routines reuse the current real journal and reject a second rule in that chapter', async t => {
  const f = await fixture(t), conversation = f.hub.newConversation({ endpointId: f.pairing.endpointId });
  const item = f.store.ensureConversation({ account: 'local', userId: 'owner' }, { conversationId: conversation.id, content: '项目跟踪' });
  f.hub.submit({ conversationId: conversation.id, journalItemId: item.id, content: '每天看看进展', requestId: 'user' }); const job = f.poll();
  const input = { runId: job.id, lease: job.lease, callId: 'create', arguments: { operation: 'create', values: values() } };
  const result = await routineTool({ hub: f.hub, routines: f.routines, token: f.pairing.token, input });
  assert.equal(result.routine.journalItemId, item.id); assert.equal(result.routine.conversationId, conversation.id);
  assert.equal(f.store.snapshot().items.length, 1);
  await assert.rejects(routineTool({ hub: f.hub, routines: f.routines, token: f.pairing.token, input: { ...input, callId: 'again' } }), { code: 'ROUTINE_ALREADY_EXISTS' });
});

test('cancellation during asynchronous settings reads fences a late tool mutation', async t => {
  const f = await fixture(t), conversation = f.hub.newConversation({ endpointId: f.pairing.endpointId });
  f.hub.submit({ conversationId: conversation.id, content: '创建巡查', requestId: 'user' }); const job = f.poll();
  const routines = createRoutineController({ hub: f.hub, journal: f.journal, read: async () => { f.hub.cancel(job.id); return { config: { proactive: { timezone: 'Asia/Shanghai' } } }; } });
  await assert.rejects(routineTool({ hub: f.hub, routines, token: f.pairing.token, input: { runId: job.id, lease: job.lease, callId: 'late', arguments: { operation: 'create', values: values() } } }), { code: 'FORBIDDEN' });
  assert.equal(f.hub.all('routine').length, 0);
});

test('manual runs have durable request receipts and rule updates use the new schedule and endpoint', async t => {
  const f = await fixture(t), { routine } = await f.create();
  const request = { operation: 'run_now', id: routine.id, version: 1, requestId: 'manual-once' };
  const first = await f.routines.action(request), again = await f.routines.action(request); assert.deepEqual(again, first);
  assert.equal(f.hub.all('run').length, 1);
  const changed = await f.routines.action({ operation: 'update', id: routine.id, version: 1, requestId: 'new-clock', values: { schedule: { time: '11:00', timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5] }, trigger: { condition: '有正式发布', mode: 'changed' } } });
  assert.equal(changed.routine.version, 2); assert.equal(f.hub.get('run', first.run.runId).status, 'cancelled');
  f.set('2026-10-26T03:00:00Z'); await f.routines.tick(); const job = f.poll();
  assert.equal(job.routine.version, 2); assert.match(job.prompt, /有正式发布/);
  await assert.rejects(f.routines.action({ ...request, id: 'different' }), { code: 'CONFLICT' });
});

test('model checks cannot substitute for a current actual read receipt or cite a different URL', async t => {
  const f = await fixture(t), { routine } = await f.create();
  for (const scenario of ['none', 'foreign', 'wrong-url']) {
    await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: scenario }); const job = f.poll();
    if (scenario === 'foreign') f.hub.put('nativeSourceReceipt', { id: 'old', runId: 'previous-run', tool: 'web_fetch', source: 'https://example.invalid/project', status: 'completed', observedAt: f.hub.now() });
    if (scenario === 'wrong-url') f.read(job, { source: 'https://example.invalid/unrelated' });
    await f.result(job, { matched: false, facts: [] }, false); f.complete(job);
    const record = f.hub.get('routineRun', job.routine.occurrenceId);
    assert.equal(record.error, 'ROUTINE_SOURCE_UNVERIFIED'); assert.equal(record.status, 'failed'); assert.deepEqual(record.checks, []);
    assert.equal(f.hub.get('run', job.id).routinePublished, false); f.advance(1000);
  }
});

test('a partial or failed actual fetch cannot be hidden by omitting it from checks; full reread recovers', async t => {
  const f = await fixture(t), { routine } = await f.create();
  for (const recover of [false, true]) {
    await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: String(recover) }); const job = f.poll();
    f.read(job, { source: 'https://example.invalid/other', status: 'incomplete' });
    await f.result(job, { matched: false, facts: [] });
    if (recover) { f.advance(1000); f.read(job, { source: 'https://example.invalid/other', status: 'completed' }); }
    f.complete(job);
    const record = f.hub.get('routineRun', job.routine.occurrenceId);
    assert.equal(record.status, recover ? 'quiet' : 'failed');
    assert.equal(record.error, recover ? null : 'ROUTINE_SOURCE_INCOMPLETE');
    f.advance(1000);
  }
});

test('DSH receipts arriving after result but before completion provide authoritative source times', async t => {
  const f = await fixture(t), { routine } = await f.create();
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'source-order' }); const job = f.poll();
  await f.result(job, { checks: [{ source: 'https://EXAMPLE.invalid:443/project#summary', observedAt: f.hub.now() - 1000 }] }, false);
  f.advance(2000); f.read(job); f.complete(job);
  const record = f.hub.get('routineRun', job.routine.occurrenceId);
  assert.equal(record.status, 'published');
  assert.deepEqual(record.checks, [{ source: 'https://example.invalid/project', observedAt: f.hub.now() }]);
});

test('bounded search discovery permits full page checks but cannot claim a truncated search was complete', async t => {
  const f = await fixture(t), { routine } = await f.create();
  for (const declared of [false, true]) {
    await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: String(declared) }); const job = f.poll();
    f.read(job, { tool: 'web_search', source: 'search:public updates', status: 'incomplete' });
    await f.result(job, { matched: false, facts: [], ...(declared && { checks: [{ source: 'search:public updates', observedAt: f.hub.now() }] }) });
    f.complete(job);
    assert.equal(f.hub.get('routineRun', job.routine.occurrenceId).status, declared ? 'failed' : 'quiet');
    f.advance(1000);
  }
});

test('controlled bridge reads retain real receipt support; inventory cannot stand in for a data read', async t => {
  const f = await fixture(t), { routine } = await f.create();
  for (const operation of ['list', 'github_updates']) {
    await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: operation }); const job = f.poll();
    const sourceId = 'fixture-' + operation;
    f.hub.put('sourceRequest', { id: sourceId, runId: job.id, arguments: { operation, ...(operation === 'github_updates' && { repo: 'example/project' }) }, status: 'completed', result: { operation, complete: true }, createdAt: f.hub.now(), finishedAt: f.hub.now() });
    await f.result(job, { matched: false, facts: [], checks: [{ source: 'source-request:' + sourceId, observedAt: f.hub.now() }] }, false); f.complete(job);
    const record = f.hub.get('routineRun', job.routine.occurrenceId);
    assert.equal(record.status, operation === 'list' ? 'failed' : 'quiet');
    if (operation === 'list') assert.equal(record.error, 'ROUTINE_SOURCE_UNVERIFIED');
    f.advance(1000);
  }
});

test('a larger complete bridge reread supersedes incomplete coverage of the same resource', async t => {
  const f = await fixture(t), { routine } = await f.create();
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'bridge-retry' }); const job = f.poll();
  const row = { runId: job.id, status: 'completed', arguments: { operation: 'github_updates', repo: 'example/project', maxReleases: 1 }, result: { operation: 'github_updates', complete: false }, createdAt: f.hub.now(), finishedAt: f.hub.now() };
  f.hub.put('sourceRequest', { ...row, id: 'small' }); f.advance(1000);
  f.hub.put('sourceRequest', { ...row, id: 'full', arguments: { ...row.arguments, maxReleases: 3 }, result: { operation: 'github_updates', complete: true }, createdAt: f.hub.now(), finishedAt: f.hub.now() });
  await f.result(job, { checks: [{ source: 'https://github.com/example/project', observedAt: f.hub.now() }] }, false); f.complete(job);
  assert.equal(f.hub.get('routineRun', job.routine.occurrenceId).status, 'published');
  assert.equal(f.hub.get('routineRun', job.routine.occurrenceId).checks[0].source, 'source-request:full');
});

test('source receipt events are bounded, lease-scoped, ordered and replay idempotent', async t => {
  const f = await fixture(t), { routine } = await f.create();
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'receipt-validation' }); const job = f.poll();
  const event = { runId: job.id, lease: job.lease, seq: 1, type: 'source_receipt', value: { tool: 'web_fetch', source: 'https://example.invalid/project', status: 'failed', observedAt: f.hub.now() } };
  assert.throws(() => f.hub.event(f.pairing.token, { ...event, lease: 'foreign' }), { code: 'FORBIDDEN' });
  assert.throws(() => f.hub.event(f.pairing.token, { ...event, value: { ...event.value, body: 'never store body' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.hub.event(f.pairing.token, { ...event, value: { ...event.value, source: 'file:///etc/passwd' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.hub.event(f.pairing.token, { ...event, value: { ...event.value, observedAt: f.hub.now() + 3600000 } }), { code: 'INVALID_INPUT' });
  f.hub.event(f.pairing.token, event); assert.equal(f.hub.event(f.pairing.token, event).duplicate, true);
  f.read(job); assert.equal(f.hub.all('nativeSourceReceipt').length, 1); assert.equal(f.hub.all('nativeSourceReceipt')[0].status, 'completed');
  f.hub.event(f.pairing.token, event); assert.equal(f.hub.all('nativeSourceReceipt')[0].status, 'completed');
});

test('older fact receipts retain deduplication without leaking unstamped keys into a fresh scope', async t => {
  const f = await fixture(t); await f.create(); f.set('2026-10-26T01:00:00Z'); await f.routines.tick();
  const first = f.poll(); await f.result(first); f.complete(first);
  const { scopeHash, ...legacy } = f.hub.all('routineFact')[0]; f.hub.put('routineFact', legacy);
  f.set('2026-10-27T01:00:00Z'); await f.routines.tick(); const second = f.poll();
  assert.doesNotMatch(second.prompt, /https:\/\/example.invalid\/project\/release\/1/);
  await f.result(second); f.complete(second);
  assert.equal(f.hub.get('routineRun', second.routine.occurrenceId).status, 'quiet');
});


test('a Bot owns its routine and disabling it pauses the schedule and fences old work', async t => {
  const f = await fixture(t);
  const bot = saveBot(f.hub, { values: { name: '巡查员', handle: 'patrol', instructions: '检查用户指定的公开页面', avatar: 'research', endpointId: f.pairing.endpointId } });
  const { routine } = await f.create(values({ botId: bot.id }));
  assert.equal(routine.botId, bot.id);
  assert.equal(botSnapshot(f.hub).find(b => b.id === bot.id).routines[0].id, routine.id);
  await f.routines.action({ operation: 'run_now', id: routine.id, version: 1, requestId: 'bot-run' });
  const job = f.poll(); assert.equal(job.botId, bot.id); assert.equal(job.sessionId, null); assert.deepEqual(job.context, []);
  saveBot(f.hub, { id: bot.id, version: 1, values: { active: false } });
  assert.equal(f.hub.get('routine', routine.id).enabled, false);
  assert.equal(f.hub.get('run', job.id).status, 'cancelling');
  await assert.rejects(f.result(job, { outcome: 'blocked' }, false), { code: 'FORBIDDEN' });
});


test('an Agent can explicitly create a journal-only Bot routine but cannot set an external channel', async t => {
  const f = await fixture(t);
  const bot = saveBot(f.hub, { values: { name: '安排', handle: 'arrange', instructions: '按用户交代安排巡查', avatar: 'planner', endpointId: f.pairing.endpointId } });
  const conversation = f.hub.newConversation({ botId: bot.id });
  f.hub.submit({ conversationId: conversation.id, botId: bot.id, content: '每天检查公开页面，只保存手账', requestId: 'daily-request' });
  const run = f.poll();
  const invoke = (notification, callId) => routineTool({ hub: f.hub, routines: f.routines, token: f.pairing.token, input: { runId: run.id, lease: run.lease, callId, arguments: { operation: 'create', values: values({ notification }) } } });
  const result = await invoke({ channelId: null }, 'quiet'); assert.equal(result.routine.botId, bot.id);
  await assert.rejects(invoke({ channelId: 'external' }, 'external'), { code: 'FORBIDDEN' });
});
