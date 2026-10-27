import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest, createServer } from 'node:http';
import { noticeTransport } from '../scripts/personal-notice-worker.mjs';
import { PersonalNoticeWorker, formatNotice } from '../plugins/proactive/notice-worker.mjs';
import { createNoticeSources, mailInstant } from '../plugins/proactive/notice-sources.mjs';
import { noticeWorkerBridge, noticeWorkerSources } from '../plugins/proactive/notice-worker-bridge.mjs';
import { createWebUI } from '../plugins/webui/server.mjs';

const base = Date.parse('2026-10-15T10:00:00+08:00');
const candidate = { key: 'google-calendar:abc123', source: 'google-calendar', kind: 'event', title: 'Dinner', expiresAt: base + 86400000 };
test('a standalone notification retains its subject and verified original; private and uncited links stay out', () => {
  const update = { source: 'github', repo: 'example/assistant', title: 'fix copied link', url: 'https://github.com/example/assistant/commit/abc' };
  const message = formatNotice(update, '切换项目后，复制提示也跟着新链接走了。');
  assert.match(message, /^example\/assistant · GitHub 更新\n/);
  assert.ok(message.endsWith(update.url));
  const mail = { source: 'google-mail', title: 'Research newsletter', url: 'https://mail.google.com/private', reading: { sources: [
    { id: 'read', type: 'primary', complete: true, url: 'https://example.com/research' },
    { id: 'uncited', type: 'primary', complete: true, url: 'https://example.com/other' },
  ] } };
  const review = { evidence: [{ sourceId: 'read' }] };
  assert.ok(formatNotice(mail, '研究有了新发现。', review).endsWith('https://example.com/research'));
  assert.ok(!formatNotice(mail, '研究有了新发现。').includes('https:'));
  for (const url of ['https://example.com/page?token=private', 'https://secret@example.com/page', 'file:///private/source']) {
    assert.ok(!formatNotice({ ...update, url }, '新消息。').includes(url));
  }
});
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'notice-worker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = base, collected = 0, analyzed = 0;
  const calls = [], snapshot = { policy: { enabled: true, timezone: 'Asia/Shanghai', quiet_start: '22:00', quiet_end: '09:00' }, sources: [{ id: 'google-mail', account: 'owner@example.test' }, { id: 'google-calendar', account: 'owner@example.test' }], notices: [], blocked: null };
  const options = { directory, now: () => now,
    transport: async input => { calls.push(input); if (input.operation === 'snapshot') return structuredClone(snapshot); if (input.operation === 'analysis') return { allowed: true }; if (input.operation === 'offer') return { accepted: true, state: 'pending', deliveryId: 'd1' }; if (input.operation === 'receipt') return { receipt: { state: 'read', deliveryId: 'd1' } }; return { accepted: true }; },
    collect: async () => { collected++; return { candidates: [candidate], counts: { 'google-mail': 1 }, errors: [] }; },
    analyze: async () => { analyzed++; return JSON.stringify({ key: candidate.key, text: '邮件里有一份指南，有空可以读读，看是否对你有帮助。' }); }, ...overrides };
  const worker = new PersonalNoticeWorker(options);
  return { worker, options, directory, calls, snapshot, get collected() { return collected; }, get analyzed() { return analyzed; }, advance(ms) { now += ms; } };
}

test('night and pause stop before any source or model read; scheduler does not override Shanghai quiet hours', async t => {
  const f = fixture(t); f.advance(12 * 3600000);
  await f.worker.tick(); assert.equal(f.collected, 0); assert.equal(f.analyzed, 0);
  assert.equal(f.calls.at(-1).state, 'quiet_hours');
  f.snapshot.policy.enabled = false; await f.worker.tick(); assert.equal(f.calls.at(-1).state, 'paused'); assert.equal(f.collected, 0);
});
test('failed model analysis can retry next interval; a corrected analysis configuration recovers without clearing receipts', async t => {
  const f = fixture(t), transport = f.options.transport, permits = new Set();
  f.worker.transport = async input => {
    if (input.operation === 'analysis') {
      if (permits.has(input.key)) return { allowed: false, blocked: 'already_analyzed' };
      permits.add(input.key);
    }
    return transport(input);
  };
  f.worker.analyze = async () => { throw new Error('AGENT_MODEL_UNAVAILABLE'); };
  await f.worker.tick();
  assert.equal(f.worker.state.lastResult.diagnostic.code, 'AGENT_MODEL_UNAVAILABLE');
  f.advance(31 * 60000);
  f.worker.analyze = async () => '{"key":null}';
  await f.worker.tick();
  assert.equal(f.worker.state.lastResult.state, 'idle'); assert.equal(permits.size, 2);
  const nextScan = f.worker.state.nextScanAt;
  const corrected = new PersonalNoticeWorker({ ...f.options, analysisRevision: 'configured-supported-model' });
  assert.equal(corrected.state.nextScanAt, 0);
  corrected.state.nextScanAt = nextScan; corrected.save();
  assert.equal(new PersonalNoticeWorker({ ...f.options, analysisRevision: 'configured-supported-model' }).state.nextScanAt, nextScan);
});
test('worker revalidates a source, persists the exact offer before transport, and restart cannot duplicate it', async t => {
  const f = fixture(t), transport = f.options.transport;
  f.worker.transport = async input => {
    if (input.operation === 'offer') {
      const state = JSON.parse(readFileSync(join(f.directory, 'worker-state.json')));
      assert.deepEqual(state.offers[candidate.key].offer, input); assert.equal(state.offers[candidate.key].state, 'unknown');
    }
    return transport(input);
  };
  await f.worker.tick(); assert.equal(f.collected, 2); assert.equal(f.calls.filter(c => c.operation === 'offer').length, 1);
  f.advance(31 * 60000); const next = new PersonalNoticeWorker(f.options); await next.tick();
  assert.equal(f.calls.filter(c => c.operation === 'offer').length, 1); assert.equal(next.state.offers[candidate.key].state, 'read');
  assert.equal(statSync(join(f.directory, 'worker-state.json')).mode & 0o777, 0o600);
  const log = readFileSync(join(f.directory, 'scan-log.jsonl'), 'utf8'); assert.ok(!log.includes(candidate.title)); assert.ok(!log.includes(candidate.key));
});
test('ambiguous offer response is receipt-only after restart, even when receipt is absent', async t => {
  const f = fixture(t), transport = f.options.transport;
  f.options.transport = async input => {
    if (input.operation === 'offer') { f.calls.push(input); throw new Error('offline after accept'); }
    if (input.operation === 'receipt') { f.calls.push(input); return { receipt: null }; }
    return transport(input);
  };
  f.worker.transport = f.options.transport; await f.worker.tick();
  assert.equal(f.worker.state.offers[candidate.key].state, 'unknown');
  f.advance(31 * 60000); await new PersonalNoticeWorker(f.options).tick();
  assert.equal(f.calls.filter(c => c.operation === 'offer').length, 1); assert.equal(f.calls.filter(c => c.operation === 'receipt').length, 1);
});
test('changed source or revoked permission between analysis and send cannot create an offer', async t => {
  const f = fixture(t); let reads = 0;
  f.worker.collect = async () => ({ candidates: ++reads === 1 ? [candidate] : [], counts: { 'google-mail': 0 }, errors: [] });
  await f.worker.tick(); assert.equal(f.calls.filter(c => c.operation === 'offer').length, 0);
  assert.match(readFileSync(join(f.directory, 'scan-log.jsonl'), 'utf8'), /source_changed/);
  const g = fixture(t); g.worker.analyze = async () => { g.snapshot.policy.enabled = false; g.snapshot.blocked = 'paused'; return JSON.stringify({ key: candidate.key, text: 'hello' }); };
  await g.worker.tick(); assert.equal(g.calls.filter(c => c.operation === 'offer').length, 0);
  const h = fixture(t); let checks = 0;
  h.worker.collect = async () => ({ candidates: [{ ...candidate, title: ++checks === 1 ? '晚餐' : '面试' }], counts: { 'google-calendar': 1 }, errors: [] });
  await h.worker.tick(); assert.equal(h.calls.filter(c => c.operation === 'offer').length, 0, 'same fact key and expiry cannot justify stale wording after title changes');
});
test('model cannot invent source keys, recipients, or a push justified only by filename', async t => {
  for (const selected of [{ key: 'invented', text: 'hello' }, { key: candidate.key, text: 'hello', recipient: 'stranger' }, { key: candidate.key, text: 'file:///private/document' }]) {
    const f = fixture(t, { analyze: async () => JSON.stringify(selected) }); await f.worker.tick();
    assert.equal(f.calls.filter(c => c.operation === 'offer').length, 0);
  }
  const f = fixture(t, { collect: async () => ({ candidates: [{ ...candidate, kind: 'interest_context' }], counts: { 'local-files': 1 } }) });
  await f.worker.tick(); assert.equal(f.analyzed, 0);
});
test('an empty decision is private evidence, no offer or conversation run; next minute does not scan again', async t => {
  const f = fixture(t, { analyze: async () => '{"key":null}' });
  await f.worker.tick(); f.advance(60000); await f.worker.tick();
  assert.equal(f.collected, 1); assert.equal(f.calls.filter(c => c.operation === 'offer').length, 0);
  assert.ok(f.calls.every(c => ['snapshot', 'status', 'receipt', 'analysis'].includes(c.operation)));
});
test('a failed scan stays visible across heartbeat and restart until a real successful scan', async t => {
  const f = fixture(t, { collect: async () => ({ candidates: [], counts: { github: 0 }, errors: ['github'] }) });
  await f.worker.tick(); assert.equal(f.calls.at(-1).state, 'error');
  f.advance(60000); await new PersonalNoticeWorker(f.options).tick(); assert.equal(f.calls.at(-1).state, 'error');
  assert.equal(f.calls.at(-1).reason, 'source_unavailable');
  f.advance(30 * 60000); f.worker.collect = async () => ({ candidates: [], counts: {}, errors: [] });
  await f.worker.tick(); assert.equal(f.calls.at(-1).state, 'idle');
});
test('PR comments and event descriptions do not re-notify, but an actual event reschedule has a new fact key', async () => {
  let revision = 0, startsAt = base + 3600000;
  const runner = async (command, args) => ({ exitCode: 0, stdout: JSON.stringify(command === 'gh' ? args[0] === 'api' ? { login: 'owner' } : [{ id: 'pr1', title: 'Review', updatedAt: new Date(base + revision * 60000).toISOString(), url: 'https://github.com/example/repo/pull/1' }] : { events: [{ id: 'event', summary: 'Dinner', updated: String(revision), start: { dateTime: new Date(startsAt).toISOString() } }] }) });
  const collect = createNoticeSources({ runner }), sources = [{ id: 'github', account: 'owner' }, { id: 'google-calendar', account: 'owner@example.test' }], context = { now: base, timezone: 'Asia/Shanghai' };
  const first = await collect(sources, context); revision++;
  const second = await collect(sources, context);
  assert.deepEqual(first.candidates.map(c => c.key).sort(), second.candidates.map(c => c.key).sort());
  startsAt += 3600000;
  const changed = await collect(sources, context);
  assert.notEqual(first.candidates.find(c => c.source === 'google-calendar').key, changed.candidates.find(c => c.source === 'google-calendar').key);
});
test('source collectors omit private bodies/addresses and verify the GitHub account; mailbox threads deduplicate', async () => {
  const runner = async (command, args) => ({ exitCode: 0, stdout: JSON.stringify(command === 'gh' ? { login: 'different-owner' } : args[0] === 'calendar' ? { events: [
    { id: 'event', summary: 'Dinner', start: { dateTime: new Date(base + 3600000).toISOString() } },
    { id: 'declined', summary: 'Declined', start: { dateTime: new Date(base + 3600000).toISOString() }, attendees: [{ self: true, responseStatus: 'declined' }] },
  ] } : { messages: [
    { id: 'abc', threadId: 'abc', subject: 'A guide', date: '2026-10-15 08:00', from: 'private@example.test', body: 'PRIVATE BODY' },
    { id: 'bcd', threadId: 'abc', subject: 'Reply', date: '2026-10-15 08:01' },
    { id: 'def', subject: 'Your verification password', date: '2026-10-15 08:00' },
  ] }) });
  const collect = createNoticeSources({ runner });
  const r = await collect([{ id: 'google-mail', account: 'owner@example.test' }, { id: 'google-calendar', account: 'owner@example.test' }, { id: 'github', account: 'expected-owner' }], { now: base, timezone: 'Asia/Shanghai' });
  assert.equal(r.candidates.length, 2); assert.deepEqual(r.errors, ['github']);
  const encoded = JSON.stringify(r); assert.ok(!encoded.includes('private@example')); assert.ok(!encoded.includes('PRIVATE BODY')); assert.ok(!encoded.includes('Declined')); assert.ok(!encoded.includes('password'));
  assert.equal(mailInstant('2026-10-15 08:00', 'Asia/Shanghai'), Date.parse('2026-10-15T00:00:00Z'));
});
test('all 100 recent mail headers reach the reading queue even with many newer local files', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: (i + 1).toString(16), threadId: (i + 1).toString(16), subject: 'A concrete guide ' + i, date: '2026-10-15 08:00' }));
  const collect = createNoticeSources({ runner: async () => ({ exitCode: 0, stdout: JSON.stringify({ messages: rows }) }),
    fs: { readdir: async () => Array.from({ length: 30 }, (_, i) => 'guide-' + i + '.md'), lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mtimeMs: base - 60000 }) } });
  const result = await collect([{ id: 'google-mail', account: 'owner@example.test' }, { id: 'local-files' }], { now: base, timezone: 'Asia/Shanghai' });
  assert.equal(result.candidates.filter(c => c.kind === 'mail').length, 100); assert.ok(result.candidates.some(c => c.mailId === '64')); assert.equal(result.candidates.filter(c => c.kind === 'interest_context').length, 12);
});
test('selected-files grant cannot imply whole common-folder access, and offline/revoked sources vanish', () => {
  const connections = { bridge: { online: true }, items: [{ id: 'files', state: 'connected', permissions: [{ id: 'readable', granted: true, verified: true }] }], desired: [{ id: 'files', enabled: true, scope: 'selected-files' }] };
  assert.deepEqual(noticeWorkerSources(connections, { sources: ['local-files'] }), []);
  connections.desired[0].scope = 'common-folders'; assert.equal(noticeWorkerSources(connections, { sources: ['local-files'] }).length, 1);
  connections.bridge.online = false; assert.deepEqual(noticeWorkerSources(connections, { sources: ['local-files'] }), []);
});
test('limited overall connection still exposes its individually verified calendar and file permissions', () => {
  const connections = { bridge: { online: true }, items: [
    { id: 'google', state: 'limited', account: 'owner@example.test', permissions: [{ id: 'calendar', granted: true, verified: true }, { id: 'gmail', granted: false, verified: false }] },
    { id: 'files', state: 'limited', permissions: [{ id: 'readable', granted: true, verified: true }] },
  ], desired: [{ id: 'files', enabled: true, scope: 'all-readable-files' }] };
  assert.deepEqual(noticeWorkerSources(connections, { sources: ['google-calendar', 'google-mail', 'local-files'] }).map(s => s.id), ['google-calendar', 'local-files']);
});
test('paired Mac has only observer operations; no owner settings, recipient selection, or history writes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notice-worker-http-'));
  const app = createWebUI({ root, helper: async () => ({ revision: 'fixture', installed: false, config: { agent: { provider: 'dsh' }, im: { provider: 'disabled', allow_from: [] }, proactive: { timezone: 'Asia/Shanghai' } } }), rpc: async () => { throw new Error('offline'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await app.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const pair = app.connections.mutate({ operation: 'pair', revision: 0, values: { name: 'isolated Mac' } });
  const post = (route, body, token = pair.token) => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA-Bridge-Token': token }, body: JSON.stringify(body) });
  assert.equal((await post('/api/personal-notice-bridge', { operation: 'snapshot' }, 'wrong')).status, 403);
  assert.equal((await post('/api/personal-notices', { operation: 'configure', enabled: true })).status, 403);
  assert.equal((await post('/api/personal-notice-bridge', { operation: 'configure', enabled: true })).status, 400);
  const snapshot = await post('/api/personal-notice-bridge', { operation: 'snapshot' }).then(r => r.json());
  assert.equal(snapshot.data.blocked, 'paused'); assert.ok(!JSON.stringify(snapshot).includes('conversationId'));
  assert.equal((await post('/api/personal-notice-bridge', { operation: 'status', state: 'idle', counts: { 'google-mail': 2 }, scanAt: Date.now() })).status, 200);
  const diagnostic = { stage: 'snapshot', code: 'BRIDGE_NETWORK_UNAVAILABLE', retryable: true, attempt: 2, retryAt: Date.now() + 120000, elapsedMs: 15000 };
  assert.equal((await post('/api/personal-notice-bridge', { operation: 'status', state: 'error', reason: 'bridge_network_unavailable', diagnostic })).status, 200);
  assert.deepEqual(app.hub.get('personalNoticeWorker', 'mac').diagnostic, diagnostic);
  assert.equal((await post('/api/personal-notice-bridge', { operation: 'status', state: 'error', diagnostic: { ...diagnostic, message: 'PRIVATE' } })).status, 400);
  assert.equal((await post('/api/personal-notice-bridge', { operation: 'status', state: 'idle' })).status, 200);
  assert.equal(app.hub.get('personalNoticeWorker', 'mac').diagnostic, null);
  const changedGrant = { bridge: { online: true }, items: [{ id: 'google', state: 'connected', account: 'owner@example.test', permissions: [{ id: 'gmail', granted: true, verified: true }] }], desired: [{ id: 'google', generation: 3, enabled: true }] };
  assert.equal(noticeWorkerSources(changedGrant, { sources: ['google-mail'] })[0].generation, 3);
  assert.deepEqual(noticeWorkerBridge(app.hub, changedGrant, { operation: 'offer', source: 'google-mail', sourceGeneration: 2 }), { accepted: false, blocked: 'source_changed' });
  assert.equal(app.hub.all('message').length, 0); assert.equal(app.hub.all('run').length, 0);
  assert.throws(() => noticeWorkerBridge(app.hub, app.connections.snapshot(), { operation: 'status', state: 'idle', counts: { 'private-text': 1 } }));
  const before = app.hub.get('personalNoticeWorker', 'mac');
  const received = once(app.server, 'request');
  const payload = JSON.stringify({ operation: 'status', state: 'scanning' });
  let finishBody;
  const slow = new Promise((resolve, reject) => {
    const req = httpRequest(origin + '/api/personal-notice-bridge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-PA-Bridge-Token': pair.token } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); finishBody = () => req.end(payload); req.flushHeaders();
  });
  await received;
  app.connections.mutate({ operation: 'unpair', revision: 1 });
  finishBody(); assert.equal(await slow, 403);
  assert.deepEqual(app.hub.get('personalNoticeWorker', 'mac'), before);
  assert.equal((await post('/api/personal-notice-bridge', { operation: 'snapshot' })).status, 403);
});

test('bridge failures record a safe stage and persistent exponential backoff without exposing transport text', async t => {
  const f = fixture(t); let snapshots = 0;
  f.options.transport = async input => {
    if (input.operation === 'snapshot') { snapshots++; throw Object.assign(new Error('connect 10.0.0.1 owner@private.test token=SECRET'), { code: 'ECONNREFUSED' }); }
    return { accepted: true };
  };
  f.worker.transport = f.options.transport;
  await f.worker.tick();
  assert.equal(f.worker.state.lastResult.diagnostic.stage, 'snapshot');
  assert.equal(f.worker.state.lastResult.diagnostic.code, 'BRIDGE_NETWORK_UNAVAILABLE');
  assert.equal(f.worker.state.retryAt, base + 60000);
  await f.worker.tick(); assert.equal(snapshots, 1);
  f.advance(60000); await f.worker.tick(); assert.equal(snapshots, 2);
  assert.equal(f.worker.state.retryAt, base + 180000);
  f.advance(60000); await new PersonalNoticeWorker(f.options).tick(); assert.equal(snapshots, 2);
  const log = readFileSync(join(f.directory, 'scan-log.jsonl'), 'utf8');
  assert.doesNotMatch(log, /10\.0\.0\.1|private\.test|SECRET/);
  f.advance(60000); await new PersonalNoticeWorker(f.options).tick(); assert.equal(snapshots, 3);
});

test('a pause detected after backoff stops before source reads and successful scans clear failure state', async t => {
  const f = fixture(t), collect = f.worker.collect;
  f.worker.collect = async () => { throw new Error('AGENT_TIMEOUT'); };
  await f.worker.tick(); assert.equal(f.worker.state.lastResult.diagnostic.stage, 'collect');
  f.advance(60000); f.snapshot.policy.enabled = false;
  await f.worker.tick(); assert.equal(f.calls.at(-1).state, 'paused'); assert.equal(f.collected, 0);
  f.snapshot.policy.enabled = true; f.worker.collect = collect;
  await f.worker.tick(); assert.equal(f.worker.state.failures, 0); assert.equal(f.worker.state.retryAt, 0);
});

test('same-account revoke and regrant during analysis invalidate the original observation generation', async t => {
  const f = fixture(t);
  f.snapshot.sources.forEach(s => { s.generation = 3; });
  f.worker.analyze = async () => { f.snapshot.sources.find(s => s.id === candidate.source).generation = 5; return JSON.stringify({ key: candidate.key, text: '具体安排可以确认一下。' }); };
  await f.worker.tick();
  assert.equal(f.calls.filter(c => c.operation === 'offer').length, 0);
  assert.match(readFileSync(join(f.directory, 'scan-log.jsonl'), 'utf8'), /source_changed/);
});

test('invalid model JSON records selection failure rather than an untraceable scan_failed', async t => {
  const f = fixture(t, { analyze: async () => 'PRIVATE_MAIL is not JSON' });
  await f.worker.tick();
  assert.equal(f.worker.state.lastResult.diagnostic.stage, 'selection');
  assert.equal(f.worker.state.lastResult.diagnostic.code, 'INVALID_SELECTION_JSON');
  assert.doesNotMatch(readFileSync(join(f.directory, 'scan-log.jsonl'), 'utf8'), /PRIVATE_MAIL/);
});

test('HTTP bridge distinguishes pairing, server rejection and malformed JSON without retaining the response', async t => {
  let status = 403, body = 'PRIVATE_RESPONSE';
  const server = createServer((req, res) => { req.resume(); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const transport = noticeTransport({ endpoint, publicOrigin: endpoint, token: 'fixture' });
  await assert.rejects(transport({ operation: 'snapshot' }), error => error.code === 'BRIDGE_AUTH_REQUIRED' && error.statusCode === 403 && !error.message.includes('PRIVATE'));
  status = 400; await assert.rejects(transport({ operation: 'snapshot' }), error => error.code === 'BRIDGE_REJECTED' && error.statusCode === 400);
  status = 200; await assert.rejects(transport({ operation: 'snapshot' }), error => error.code === 'BRIDGE_INVALID_RESPONSE');
  body = '{"ok":true,"data":{"blocked":"paused"}}'; assert.deepEqual(await transport({ operation: 'snapshot' }), { blocked: 'paused' });
});

test('analysis backoff keeps a healthy bridge heartbeat and observes Off without repeating the model', async t => {
  let analyses = 0;
  const f = fixture(t, { analyze: async () => { analyses++; throw new Error('AGENT_TIMEOUT'); } });
  await f.worker.tick(); assert.equal(analyses, 1);
  f.advance(60000); await f.worker.tick();
  assert.equal(analyses, 1); assert.equal(f.calls.at(-1).state, 'error'); assert.equal(f.calls.at(-1).diagnostic.stage, 'analysis');
  f.snapshot.policy.enabled = false; f.advance(60000); await f.worker.tick();
  assert.equal(f.calls.at(-1).state, 'paused'); assert.equal(analyses, 1); assert.equal(f.collected, 1);
});

test('a mismatched quote gets one budgeted repair using the same evidence; invalid repairs never publish', async t => {
  for (const mode of ['correct', 'still-invalid', 'budget', 'revoked']) {
    let analyses = 0;
    const mail = { ...candidate, key: 'google-mail:review', source: 'google-mail', kind: 'mail', reading: { newsletter: false, sources: [{ id: 'mail', text: 'The release introduces scoped component rules.', complete: true }] } };
    const f = fixture(t, { collect: async () => ({ candidates: [mail], counts: { 'google-mail': 1 }, errors: [] }), prepareReading: async candidates => ({ candidates }) });
    const transport = f.worker.transport;
    f.worker.transport = async input => {
      if (mode === 'budget' && input.operation === 'analysis' && input.key.startsWith('repair:')) { f.calls.push(input); return { allowed: false, blocked: 'analysis_budget' }; }
      return transport(input);
    };
    f.worker.analyze = async (rules, prompt) => {
      analyses++;
      if (analyses === 2) {
        const input = JSON.parse(prompt);
        assert.equal(input.validationError, 'quote_not_found');
        assert.equal(input.candidates[0].reading.sources[0].text, mail.reading.sources[0].text);
      }
      if (mode === 'revoked') f.snapshot.sources = [];
      return JSON.stringify({ key: null, reviews: [{ key: mail.key, summary: '发布说明谈到了规则。', relevance: '暂时保留。', suggestion: '可跳过。', decision: 'skip', evidence: [{ sourceId: 'mail', quote: analyses === 2 && mode === 'correct' ? mail.reading.sources[0].text : 'A fabricated quotation that is absent.' }] }] });
    };
    await f.worker.tick();
    assert.equal(analyses, ['budget', 'revoked'].includes(mode) ? 1 : 2);
    assert.equal(f.calls.filter(c => c.operation === 'offer' || c.operation === 'publish').length, 0);
    if (mode === 'correct') assert.equal(f.worker.state.lastResult.state, 'idle');
    if (mode === 'still-invalid') assert.equal(f.worker.state.lastResult.diagnostic.detail, 'quote_not_found');
    if (mode === 'budget') assert.equal(f.worker.state.lastResult.reason, 'analysis_budget');
    if (mode !== 'budget') assert.doesNotMatch(readFileSync(join(f.directory, 'scan-log.jsonl'), 'utf8'), /fabricated quotation/);
  }
});
