import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailReading, validateMailReviews } from '../plugins/proactive/notice-mail-reading.mjs';
import { PersonalNoticeWorker } from '../plugins/proactive/notice-worker.mjs';

const now = Date.parse('2026-10-15T12:00:00+08:00');
const header = { key: 'google-mail:abc1', source: 'google-mail', kind: 'mail', mailId: 'abc1', title: 'Two APIs', at: now - 3600000, expiresAt: now + 86400000, evidence: 'unread_mail_header' };
const body = 'The Pi API in this issue trains robot policies. It is not the coding-agent library. The useful item for a household assistant is explicit background session ownership.\nRead https://docs.example.org/background?utm_source=mail .\nContact private-person@example.test.\nManage your subscriptions\nhttps://docs.example.org/unsubscribe?email=private-person@example.test';
const pageText = 'The server owns sessions and permissions. Clients connect to one shared background process. This is a concrete separation between the user interface and the executor, and does not require every client to start its own service.';
function fixture(t, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'notice-mail-reading-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [], articles = [];
  const reader = createMailReading({ directory, publisherHosts: ['docs.example.org'], primaryHosts: ['docs.example.org'], topics: ['background'], now: () => now,
    runner: async (command, args, options) => { calls.push({ command, args, options }); return { exitCode: 0, stdout: JSON.stringify({ body, unsubscribe: 'private unsubscribe URL', message: { id: args[2] } }) }; },
    articleReader: async url => { articles.push(url); return { url: 'https://docs.example.org/background', title: 'Background ownership', text: pageText, complete: true, hash: 'stable-page-hash', readAt: Date.now() }; }, ...extra });
  return { directory, reader, calls, articles, context: { sources: [{ id: 'google-mail', account: 'owner@example.test' }] } };
}
const review = { key: header.key, summary: '正文中 Pi API 是机器人训练接口，与 coding Agent 的库同名；真正相关的机制是服务端管理会话和权限。', relevance: '小满已有多个入口与执行器，可以借鉴统一后台所有权。', suggestion: '保留现有执行器，先检查会话与权限是否由同一后台管理。', decision: 'recommend', evidence: [{ sourceId: 'article-1', quote: 'The server owns sessions and permissions.' }] };

test('reads real-shaped Gmail full body and the linked primary page; excludes addresses and unsubscribe links', async t => {
  const f = fixture(t), result = await f.reader([header], f.context), read = result.candidates[0];
  assert.equal(f.calls[0].args.slice(0, 4).join(' '), 'gmail get abc1 --format'); assert.equal(f.calls[0].options.maxBytes, 1500000);
  assert.equal(read.evidence, 'mail_content_read'); assert.equal(read.reading.newsletter, true); assert.equal(read.reading.sources[0].complete, true);
  assert.match(read.reading.sources[0].text, /trains robot policies/); assert.doesNotMatch(JSON.stringify(read), /private-person|unsubscribe\?email/);
  assert.equal(result.stats.emailsRead, 1); assert.equal(result.stats.articlesRead, 1);
  assert.equal(validateMailReviews(result.candidates, [review]).get(header.key).decision, 'recommend');
});
test('unchanged immutable message bodies and fresh public pages cache locally; before-send recheck gets the body again', async t => {
  const f = fixture(t); const first = await f.reader([header], f.context); const second = await f.reader([header], f.context);
  assert.equal(f.calls.length, 1); assert.equal(f.articles.length, 1); assert.deepEqual(first.candidates, second.candidates);
  await f.reader([header], { ...f.context, recheck: true }); assert.equal(f.calls.length, 2); assert.equal(f.articles.length, 2);
});
test('a thread reply includes earlier inline bodies as separately citable evidence and rechecks them before sending', async t => {
  const message = (id, at, text, mimeType = 'text/plain') => ({ id, threadId: 'abc1', internalDate: String(at), payload: { mimeType, body: { data: Buffer.from(text).toString('base64url') } } });
  const previous = message('abc1', now - 7200000, '<p>Seats: 12</p><p>Grace period: 3 days</p><script>do not execute</script>', 'text/html');
  const current = message('abc2', now - 3600000, 'Seats: 24\nGrace period: 3 days');
  const calls = [], f = fixture(t, { runner: async (_command, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: JSON.stringify(args[1] === 'thread' ? { thread: { id: 'abc1', messages: [current, previous] } } : { message: { id: 'abc2' }, body: 'Seats: 24\nGrace period: 3 days' }) };
  } });
  const selected = { ...header, mailId: 'abc2' };
  const first = await f.reader([selected], f.context), evidence = first.candidates[0].reading.sources;
  assert.match(evidence[0].text, /Seats: 24/);
  assert.equal(evidence[1].id, 'mail-history-abc1'); assert.equal(evidence[1].context, 'earlier-in-thread');
  assert.match(evidence[1].text, /Seats: 12/); assert.match(evidence[1].text, /Grace period: 3 days/);
  assert.doesNotMatch(evidence[1].text, /do not execute/); assert.equal(evidence[1].complete, true);
  assert.deepEqual(calls[1].slice(0, 5), ['gmail', 'thread', 'get', 'abc1', '--full']);
  previous.payload.body.data = Buffer.from('<p>Seats: 10</p>').toString('base64url');
  const again = await f.reader([selected], { ...f.context, recheck: true });
  assert.notEqual(again.candidates[0].reading.sources[1].hash, evidence[1].hash);
});
test('thread history failures, superseding replies and sensitive earlier mail cannot become a current-message-only recommendation', async t => {
  for (const scenario of ['unavailable', 'newer', 'sensitive']) {
    const entry = (id, at, text) => ({ id, threadId: 'abc1', internalDate: String(at), payload: { mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } } });
    const messages = [entry('abc1', now - 7200000, scenario === 'sensitive' ? 'verification code: 123456' : 'Seats: 12'), entry('abc2', now - 3600000, 'Seats: 24')];
    if (scenario === 'newer') messages.push(entry('abc3', now, 'This change was cancelled.'));
    const f = fixture(t, { runner: async (_command, args) => args[1] === 'thread'
      ? scenario === 'unavailable' ? { exitCode: 1 } : { exitCode: 0, stdout: JSON.stringify({ thread: { id: 'abc1', messages } }) }
      : { exitCode: 0, stdout: JSON.stringify({ message: { id: 'abc2' }, body: 'Seats: 24' }) } });
    const result = await f.reader([{ ...header, mailId: 'abc2' }], f.context);
    assert.equal(result.candidates.length, 0, scenario);
    if (scenario === 'sensitive') assert.deepEqual(result.ignored, [header.key]);
    else assert.equal(result.stats.failed, 1);
  }
});
test('reading budget defers remaining messages without claiming they were read', async t => {
  const f = fixture(t, { maxEmails: 1 }); const r = await f.reader([header, { ...header, key: 'google-mail:abc2', mailId: 'abc2' }], f.context);
  assert.equal(r.candidates.length, 1); assert.equal(r.stats.emailsRead, 1); assert.equal(r.stats.deferred, 1); assert.equal(f.calls.length, 1);
});
test('preview, oversized body, unavailable content and missing one-time secrets cannot masquerade as full reading', async t => {
  for (const text of ['This is a preview. Upgrade to read the full guide.', 'a'.repeat(40001)]) {
    const f = fixture(t, { runner: async () => ({ exitCode: 0, stdout: JSON.stringify({ body: text, message: { id: 'abc1' } }) }) });
    const r = await f.reader([header], f.context); assert.equal(r.stats.emailsRead, 0); assert.equal(r.stats.partial, 1); assert.equal(r.candidates[0].reading.sources[0].complete, false);
  }
  const f = fixture(t, { runner: async () => ({ exitCode: 0, stdout: JSON.stringify({ body: 'verification code: 123456', message: { id: 'abc1' } }) }) });
  const r = await f.reader([header], f.context); assert.equal(r.candidates.length, 0); assert.equal(r.stats.failed, 0); assert.deepEqual(r.ignored, [header.key]);
});
test('a reading pause propagates immediately instead of continuing later link or email reads', async t => {
  const f = fixture(t); let progressed = 0;
  await assert.rejects(f.reader([header], { ...f.context, onProgress: async () => { if (++progressed === 2) throw new Error('READING_PAUSED'); } }), /READING_PAUSED/);
  assert.equal(f.calls.length, 1); assert.equal(f.articles.length, 0);
});
test('a secondary article moves its primary reference ahead of other secondary links even when already queued', async t => {
  const read = [], f = fixture(t, { publisherHosts: ['secondary.example.org', 'docs.example.org'],
    runner: async () => ({ exitCode: 0, stdout: JSON.stringify({ body: 'A report with references. https://secondary.example.org/a https://secondary.example.org/b https://docs.example.org/primary', message: { id: 'abc1' } }) }),
    articleReader: async url => { read.push(url); return { url, title: 'Source', text: pageText, complete: true, hash: url, links: url.includes('/a') ? [{ url: 'https://docs.example.org/primary', label: 'Original' }] : [] }; } });
  const r = await f.reader([header], f.context);
  assert.deepEqual(read, ['https://secondary.example.org/a', 'https://docs.example.org/primary']);
  assert.equal(r.candidates[0].reading.sources[2].type, 'primary');
});
test('short acknowledgements and empty footers cannot poison a normal reading batch', async t => {
  const f = fixture(t, { runner: async (_cmd, args) => ({ exitCode: 0, stdout: JSON.stringify({ body: args[2] === 'abc1' ? '谢谢' : body, message: { id: args[2] } }) }) });
  const second = { ...header, key: 'google-mail:abc2', mailId: 'abc2' }, r = await f.reader([header, second], f.context);
  const shortReview = { ...review, decision: 'skip', evidence: [{ sourceId: 'mail', quote: '谢谢' }] };
  assert.equal(validateMailReviews(r.candidates, [shortReview, { ...review, key: second.key }]).size, 2);
  const g = fixture(t, { runner: async (_cmd, args) => ({ exitCode: 0, stdout: JSON.stringify({ body: args[2] === 'abc1' ? 'Unsubscribe\nThanks for subscribing.' : body, message: { id: args[2] } }) }) });
  const normal = await g.reader([header, second], g.context);
  assert.equal(normal.candidates.length, 1); assert.equal(normal.stats.emailsRead, 1); assert.equal(validateMailReviews(normal.candidates, [{ ...review, key: second.key }]).size, 1);
  assert.deepEqual(normal.ignored, [header.key]);
});
test('a newsletter recommendation needs a quote actually present in a complete primary document', async t => {
  const f = fixture(t), r = await f.reader([header], f.context);
  assert.throws(() => validateMailReviews(r.candidates, [{ ...review, evidence: [{ sourceId: 'article-1', quote: 'This invented quote is not in the article.' }] }]));
  assert.throws(() => validateMailReviews(r.candidates, [{ ...review, evidence: [{ sourceId: 'mail', quote: 'The Pi API in this issue trains robot policies.' }] }]), /PRIMARY_READING_REQUIRED/);
  r.candidates[0].reading.sources[1].complete = false; assert.throws(() => validateMailReviews(r.candidates, [review]), /PRIMARY_READING_REQUIRED/);
  assert.throws(() => validateMailReviews(r.candidates, []));
});
test('worker saves substantive reading notes, skips unchanged rejected content, and never offers headers alone', async t => {
  const f = fixture(t); const inputs = []; let clock = now, analyses = 0;
  const snapshot = { policy: { enabled: true, timezone: 'Asia/Shanghai', quiet_start: '22:00', quiet_end: '09:00' }, blocked: null, sources: f.context.sources, notices: [] };
  const common = { directory: f.directory, now: () => clock, collect: async () => ({ candidates: [header], counts: { 'google-mail': 1 }, errors: [] }),
    transport: async input => { inputs.push(input); if (input.operation === 'analysis') return { allowed: true }; return input.operation === 'snapshot' ? structuredClone(snapshot) : { accepted: true, state: 'pending', deliveryId: 'isolated' }; },
    analyze: async () => { analyses++; return JSON.stringify({ key: null, reviews: [{ ...review, decision: 'skip' }] }); } };
  const noReader = new PersonalNoticeWorker(common); await noReader.tick(); assert.equal(analyses, 0);
  const worker = new PersonalNoticeWorker({ ...common, prepareReading: f.reader }); clock += 31 * 60000;
  await worker.tick(); assert.equal(analyses, 1);
  const notes = readdirSync(join(f.directory, 'reading-notes')); assert.equal(notes.length, 1);
  const note = JSON.parse(readFileSync(join(f.directory, 'reading-notes', notes[0]))); assert.equal(note.summary, review.summary); assert.ok(note.sources.every(s => !Object.hasOwn(s, 'text')));
  clock += 31 * 60000; await new PersonalNoticeWorker({ ...common, prepareReading: f.reader }).tick(); assert.equal(analyses, 1);
  assert.equal(inputs.filter(i => i.operation === 'offer').length, 0);
});
test('changed mail content during the before-send full-body read blocks stale recommendation text', async t => {
  const f = fixture(t), inputs = []; let passes = 0;
  const worker = new PersonalNoticeWorker({ directory: f.directory, now: () => now,
    transport: async input => { inputs.push(input); if (input.operation === 'analysis') return { allowed: true }; return input.operation === 'snapshot' ? { policy: { enabled: true, timezone: 'Asia/Shanghai', quiet_start: '22:00', quiet_end: '09:00' }, blocked: null, sources: f.context.sources, notices: [] } : { accepted: true }; },
    collect: async () => ({ candidates: [header], counts: { 'google-mail': 1 }, errors: [] }),
    prepareReading: async (candidates, context) => { const r = await f.reader(candidates, context); if (++passes === 2) r.candidates[0].reading.sources[0].text += ' Changed.'; return r; },
    analyze: async () => JSON.stringify({ key: header.key, text: '我读到一种更贴近小满的做法：后台统一管理会话与权限，前台只负责交互。我们可以先据此检查现有分工。', reviews: [review] }),
  });
  await worker.tick(); assert.equal(inputs.filter(i => i.operation === 'offer').length, 0);
  assert.match(readFileSync(join(f.directory, 'scan-log.jsonl'), 'utf8'), /source_changed/);
});
test('primary correction or withdrawal during actual recheck cannot reuse the old cached evidence', async t => {
  for (const changed of ['corrected', 'withdrawn']) {
    let reads = 0; const inputs = [], f = fixture(t, { articleReader: async url => {
      if (++reads > 1 && changed === 'withdrawn') throw new Error('ARTICLE_HTTP_ERROR');
      return { url, title: 'Original', text: reads === 1 ? pageText : pageText + ' Correction.', complete: true, hash: 'version-' + reads };
    } });
    const worker = new PersonalNoticeWorker({ directory: f.directory, now: () => now,
      transport: async input => { inputs.push(input); if (input.operation === 'analysis') return { allowed: true }; return input.operation === 'snapshot' ? { policy: { enabled: true, timezone: 'Asia/Shanghai', quiet_start: '22:00', quiet_end: '09:00' }, blocked: null, sources: f.context.sources, notices: [] } : { accepted: true }; },
      collect: async () => ({ candidates: [header], counts: { 'google-mail': 1 }, errors: [] }), prepareReading: f.reader,
      analyze: async () => JSON.stringify({ key: header.key, text: '后台统一管理会话与权限，入口负责交互。这能帮助小满减少状态分散；可以先检查现有分工。', reviews: [review] }),
    });
    await worker.tick(); assert.equal(reads, 2); assert.equal(inputs.filter(i => i.operation === 'offer').length, 0);
  }
});

test('before-send recheck preserves the actual evidence set after a shared article budget is exhausted', async t => {
  const f = fixture(t, { maxArticles: 1 });
  const second = { ...header, key: 'google-mail:abc2', mailId: 'abc2' };
  const initial = await f.reader([header, second], f.context);
  assert.equal(initial.candidates[0].reading.sources.length, 2);
  assert.equal(initial.candidates[1].reading.sources.length, 1);
  const repeated = await f.reader([second], { ...f.context, recheck: true, evidenceByKey: new Map([[second.key, initial.candidates[1].reading.sources]]) });
  assert.deepEqual(repeated.candidates[0], initial.candidates[1]);
  assert.equal(f.articles.length, 1, 'rechecking the selected mail must not add articles it could not use in its original batch');
});

test('reading and validation failures include bounded diagnostics without source content', async t => {
  const f = fixture(t, { articleReader: async () => { throw Object.assign(new Error('https://private.test SECRET'), { code: 'ARTICLE_TIMEOUT' }); } });
  const result = await f.reader([header], f.context);
  assert.equal(result.stats.failed, 1);
  assert.equal(result.diagnostics[0].stage, 'article'); assert.equal(result.diagnostics[0].code, 'ARTICLE_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /private\.test|SECRET|google-mail:abc/);
  assert.throws(() => validateMailReviews(result.candidates, []), error => error.code === 'INVALID_READING_REVIEW' && error.detail === 'count_mismatch');
  assert.throws(() => validateMailReviews(result.candidates, [{ ...review, decision: 'skip', evidence: [{ sourceId: 'mail', quote: 'This is an invented private quote.' }] }]), error => error.detail === 'quote_not_found' && !error.message.includes('private quote'));
});
