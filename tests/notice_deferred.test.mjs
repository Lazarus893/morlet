import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PersonalNoticeWorker } from '../plugins/proactive/notice-worker.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
async function fixture(t, { notify = false, explore = false, missingPublication = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'deferred-notice-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-21T10:00:00+08:00'), analyses = 0, saved = 0;
  const calls = [], grant = { id: 'github', account: 'owner', generation: 2 };
  const quote = 'This change introduces scoped rules and explicit priorities.';
  const candidate = { key: 'github:one', source: 'github', kind: 'repository_update', title: 'Scoped rules', at: now, expiresAt: now + 86400000, url: 'https://github.com/example/rules', reading: { newsletter: false, sources: [{ id: 'github', type: 'primary', url: 'https://github.com/example/rules', text: quote, hash: hash(quote), complete: true }] } };
  const snapshot = { policy: { enabled: true, timezone: 'Asia/Shanghai', quiet_start: '22:00', quiet_end: '09:00' }, blocked: notify ? null : 'cooldown', sources: [grant], notices: [], content: { enabled: true, sources: ['github'], today: 0, maxDaily: 1, explorationToday: 0, discovery: false, revision: 0, learning: { version: 'initial' }, topics: [{ name: '工程规则', origin: 'seed', score: 0 }], published: [] } };
  const options = { directory, now: () => now,
    collect: async () => ({ candidates: [structuredClone(candidate)], counts: { github: 1 }, errors: [] }),
    prepareReading: async candidates => ({ candidates }),
    analyze: async () => { analyses++; return JSON.stringify({ key: notify ? candidate.key : null, ...(notify && { text: '规则库新增了明确的作用域和优先级。' }), reviews: [{ key: candidate.key, save: true, exploration: explore, topic: explore ? '新的探索方向' : '工程规则', decision: 'recommend', hook: '规则撞车时，先看看各自的作用域和优先级。', summary: '发布说明介绍了规则的作用域与优先级配置，让不同来源的规则可以明确各自的生效边界；这是维护者的说明，尚未实际运行验证。', relevance: '和用户一直关注的工程规则组织方式有关。', suggestion: '可以先看看它对优先级冲突的具体处理说明。', evidence: [{ sourceId: 'github', quote }] }] }); },
    transport: async input => {
      calls.push(input);
      if (input.operation === 'snapshot') return structuredClone(snapshot);
      if (input.operation === 'analysis') return { allowed: true };
      if (input.operation === 'publish') { saved++; snapshot.content.today = 1; if (!missingPublication) snapshot.content.published = [{ key: candidate.key, source: 'github', accountHash: hash(JSON.stringify(grant.account)), sourceGeneration: grant.generation, savedAt: now, topic: '工程规则' }]; return { accepted: true, receipts: [{ key: candidate.key, id: 'e'.repeat(64), replayed: false }] }; }
      if (input.operation === 'offer') return { accepted: true, state: 'pending', deliveryId: 'digest' };
      if (input.operation === 'receipt') return { receipt: { state: 'pending', deliveryId: 'digest' } };
      return { accepted: true };
    } };
  const worker = new PersonalNoticeWorker(options); await worker.tick();
  assert.equal(saved, explore ? 0 : 1, JSON.stringify(worker.state.lastResult));
  if (!notify) assert.equal(calls.some(c => c.operation === 'offer'), false);
  return { worker, options, calls, snapshot, candidate, get analyses() { return analyses; }, get saved() { return saved; }, advance() { now += 31 * 60000; snapshot.blocked = null; } };
}
test('direct notifications require an accepted journal target and cannot bypass exploration limits', async t => {
  for (const options of [{}, { explore: true }, { missingPublication: true }]) {
    const f = await fixture(t, { notify: true, ...options });
    assert.equal(f.calls.some(c => c.operation === 'offer'), !options.explore && !options.missingPublication);
  }
});
test('a reading saved during cooldown can be automatically proposed later without increasing the content budget or rerunning its model', async t => {
  const f = await fixture(t); f.advance(); await f.worker.tick();
  const offers = f.calls.filter(c => c.operation === 'offer');
  assert.equal(offers.length, 1); assert.match(offers[0].text, /规则撞车/); assert.equal(offers[0].key, 'github:one');
  assert.match(offers[0].text, /^Scoped rules · GitHub 更新\n/);
  assert.ok(offers[0].text.endsWith(f.candidate.url));
  assert.equal(f.analyses, 1); assert.equal(f.saved, 1); assert.equal(f.snapshot.content.maxDaily, 1);
  f.advance(); await new PersonalNoticeWorker(f.options).tick(); assert.equal(f.calls.filter(c => c.operation === 'offer').length, 1);
});
test('saved entries marked skip cannot starve a later recommended entry when the content budget is full', async t => {
  const f = await fixture(t);
  const original = JSON.parse(readFileSync(join(f.options.directory, 'reading-notes', hash(f.candidate.key) + '.json'), 'utf8'));
  const skipped = Array.from({ length: 4 }, (_, i) => ({ ...f.candidate, key: `github:skip-${i}` }));
  for (const candidate of skipped) {
    f.snapshot.content.published.unshift({ ...f.snapshot.content.published[0], key: candidate.key });
    f.worker.state.reviews[candidate.key] = { ...f.worker.state.reviews[f.candidate.key], headerHash: hash(JSON.stringify([candidate.key, candidate.source, candidate.kind, candidate.mailId, candidate.title, candidate.at, candidate.startsAt, candidate.url, candidate.expiresAt])) };
    writeFileSync(join(f.options.directory, 'reading-notes', hash(candidate.key) + '.json'), JSON.stringify({ ...original, key: candidate.key, decision: 'skip' }), { mode: 0o600 });
  }
  f.worker.collect = async () => ({ candidates: [...skipped, f.candidate], counts: { github: 5 }, errors: [] });
  let rereads = 0;
  f.worker.prepareReading = async candidates => { rereads++; return { candidates }; };
  f.advance(); await f.worker.tick();
  assert.deepEqual(f.calls.filter(c => c.operation === 'offer').map(c => c.key), [f.candidate.key]);
  assert.equal(rereads, 1); assert.equal(f.analyses, 1); assert.equal(f.saved, 1);
  assert.equal(f.snapshot.content.maxDaily, 1);
});
test('changed source, revoked grant, changed preference and muted topics prevent deferred recommendations', async t => {
  for (const change of ['source', 'grant', 'preference', 'muted']) {
    const f = await fixture(t); f.advance();
    if (change === 'source') f.candidate.reading.sources[0].hash = hash('new version');
    if (change === 'grant') f.snapshot.sources[0].generation++;
    if (change === 'preference') f.snapshot.content.learning.version = 'changed';
    if (change === 'muted') f.snapshot.content.topics[0].muted = true;
    await f.worker.tick(); assert.equal(f.calls.some(c => c.operation === 'offer'), false, change);
  }
});
test('feedback changed during the final read is checked again before the offer', async t => {
  const f = await fixture(t); f.advance();
  f.worker.prepareReading = async candidates => { f.snapshot.content.learning.version = 'changed-during-read'; return { candidates }; };
  await f.worker.tick(); assert.equal(f.calls.some(c => c.operation === 'offer'), false);
});
