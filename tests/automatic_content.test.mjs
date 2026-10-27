import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { createAutomaticContent, selectAutomaticContent } from '../plugins/proactive/automatic-content.mjs';
import { PersonalNoticeWorker } from '../plugins/proactive/notice-worker.mjs';
import { noticeWorkerBridge } from '../plugins/proactive/notice-worker-bridge.mjs';
import { personalNoticeCommand } from '../plugins/proactive/personal-notices.mjs';
import { createNoticeSources } from '../plugins/proactive/notice-sources.mjs';

const base = Date.parse('2026-10-20T00:00:00+08:00');
const source = { id: 'github', account: 'fixture', generation: 2 };
const scope = { account: 'local', userId: 'owner' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'automatic-content-'));
  let now = base;
  const hub = new AgentHub(root, { now: () => now }), store = new JournalStore(root, { now: () => now });
  hub.put('reachOutPolicy', { id: 'owner', timezone: 'Asia/Shanghai' });
  const content = createAutomaticContent({ hub, journal: { store } });
  content.configure({ operation: 'configure', revision: 0, enabled: true, discovery: true, maxDaily: 8, topics: ['组件设计'], sources: ['google-mail', 'github', 'x'] });
  t.after(() => { store.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
  const entry = (key = 'github:one', extra = {}) => ({
    key, source: 'github', sourceGeneration: 2, title: '组件更新说明',
    summary: '发布说明介绍了可组合组件的处理方式；这些是维护者的说明，尚未独立测试。',
    relevance: '与你关注的组件设计有关。', suggestion: '可先阅读说明再决定是否试用。',
    topic: '组件设计', exploration: false, url: 'https://github.com/example/project/releases/tag/v1',
    observedAt: now, expiresAt: now + 86400000, coverage: '已读发布说明，未运行代码。',
    evidence: [{ quote: 'This release adds composable components.', url: 'https://github.com/example/project/releases/tag/v1', type: 'primary', complete: true }],
    ...extra,
  });
  const publish = (...entries) => content.publish({ operation: 'publish', entries }, [source], 'Asia/Shanghai');
  return { root, hub, store, content, entry, publish, advance(ms) { now += ms; }, now: () => now };
}

test('automatic collection and receipt commit together, survive reopen and do not overwrite manual records', t => {
  const f = fixture(t);
  const manual = f.store.mutate(scope, { operation: 'add', revision: 0, values: { title: '我的晚餐', note: '两个人' } }).items[0];
  const first = f.publish(f.entry()), second = f.publish(f.entry());
  assert.equal(first.receipts[0].replayed, false); assert.equal(second.receipts[0].replayed, true);
  const snapshot = f.store.snapshot(scope), item = snapshot.items.find(item => item.source.kind === 'automatic');
  assert.equal(snapshot.items.length, 2); assert.deepEqual(snapshot.items.find(item => item.id === manual.id), manual);
  assert.equal(item.taskData.collection.entries.length, 1); assert.match(item.taskData.collection.entries[0].note, /This release/);
  const reopened = new JournalStore(f.root, { now: f.now });
  try {
    const again = createAutomaticContent({ hub: f.hub, journal: { store: reopened } });
    assert.equal(again.publish({ operation: 'publish', entries: [f.entry()] }, [source], 'Asia/Shanghai').receipts[0].replayed, true);
    assert.equal(reopened.snapshot(scope).items.length, 2);
  } finally { reopened.close(); }
  const save = f.store.save;
  f.store.save = () => { throw new Error('simulated disk failure'); };
  assert.throws(() => f.publish(f.entry('github:two')), /simulated disk failure/);
  f.store.save = save;
  assert.equal(f.content.snapshot().entries.length, 1);
  assert.deepEqual(f.store.snapshot(scope), snapshot);
});

test('revocation and changed grant reject writes; deleting or closing a digest never resurrects it', t => {
  const f = fixture(t);
  assert.throws(() => f.content.publish({ operation: 'publish', entries: [f.entry()] }, [], 'Asia/Shanghai'), { code: 'SOURCE_AUTHORITY_CHANGED' });
  assert.throws(() => f.publish(f.entry('one', { sourceGeneration: 1 })), { code: 'SOURCE_AUTHORITY_CHANGED' });
  assert.equal(f.store.snapshot(scope).items.length, 0);
  const receipt = f.publish(f.entry()).receipts[0], snapshot = f.store.snapshot(scope);
  f.store.mutate(scope, { operation: 'delete', revision: snapshot.revision, itemId: receipt.itemId, itemVersion: snapshot.items[0].version });
  assert.equal(f.publish(f.entry('github:two')).receipts[0].skipped, 'journal_closed');
  assert.equal(f.store.snapshot(scope).items.length, 0);
});
test('reviewed corrections update the existing note and teaser atomically without changing feedback, quota or deliveries', t => {
  const f = fixture(t), original = f.entry('github:one', { hook: '原先的摘要。' });
  const receipt = f.publish(original).receipts[0];
  f.content.feedback({ operation: 'feedback', id: receipt.id, reaction: 'useful' });
  const before = f.content.snapshot(), state = f.store.snapshot(scope);
  const correction = { operation: 'correct', id: receipt.id, revision: state.revision, reason: '读完前后两份正文后更正遗漏。',
    summary: '新版明确增加可组合组件，原先遗漏了这一变化。', hook: '新版新增可组合组件，旧版接口仍然保留。',
    relevance: original.relevance, suggestion: original.suggestion, coverage: '已对照两份正文。', evidence: original.evidence };
  const after = f.content.correct(correction);
  assert.equal(after.today, before.today); assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].id, receipt.id); assert.equal(after.entries[0].savedAt, before.entries[0].savedAt);
  assert.equal(after.entries[0].feedback, 'useful'); assert.equal(after.entries[0].hook, correction.hook);
  assert.deepEqual(after.learning, before.learning); assert.equal(f.hub.all('delivery').length, 0);
  const corrected = f.store.snapshot(scope);
  assert.match(corrected.items[0].taskData.collection.entries[0].note, /新版明确增加可组合组件/);
  assert.match(corrected.items[0].taskData.collection.entries[0].note, /内容更正/);
  const stored = JSON.parse(f.store.db.prepare('SELECT data FROM journal_content_entries WHERE id=?').get(receipt.id).data);
  assert.equal(stored.correction.previous.hook, original.hook);
  assert.throws(() => f.content.correct(correction), { code: 'VERSION_CONFLICT' });
  assert.equal(f.publish(original).receipts[0].replayed, true);
  assert.equal(f.content.snapshot().entries[0].hook, correction.hook);
  const save = f.store.save; f.store.save = () => { throw new Error('disk failure'); };
  assert.throws(() => f.content.correct({ ...correction, revision: corrected.revision, hook: '未提交的修改。' }), /disk failure/);
  f.store.save = save;
  assert.equal(f.content.snapshot().entries[0].hook, correction.hook);
  assert.deepEqual(f.store.snapshot(scope), corrected);
});

test('feedback persists, silence has no penalty, opened is weak and idempotent, exploration is bounded', t => {
  const f = fixture(t), id = f.publish(f.entry()).receipts[0].id;
  assert.equal(f.content.snapshot().topics[0].score, 0);
  f.content.feedback({ operation: 'feedback', id, reaction: 'opened' });
  f.content.feedback({ operation: 'feedback', id, reaction: 'opened' });
  assert.equal(f.content.snapshot().topics[0].score, 0.25);
  f.content.feedback({ operation: 'feedback', id, reaction: 'not_interested' });
  assert.equal(f.content.snapshot().topics[0].muted, true);
  assert.equal(f.publish(f.entry('muted')).receipts[0].skipped, 'topic_preference');
  f.content.feedback({ operation: 'feedback', id, reaction: 'useful' });
  assert.equal(f.content.snapshot().topics[0].score, 3.25);
  f.content.feedback({ operation: 'feedback', id, reaction: 'clear' });
  assert.equal(f.content.snapshot().topics[0].score, 0.25);
  const exploration = f.publish(...[1, 2, 3].map(i => f.entry('explore-' + i, { topic: '新话题', exploration: true })));
  assert.equal(exploration.receipts.filter(row => row.id).length, 2);
  assert.equal(exploration.receipts[2].skipped, 'topic_preference');
  assert.throws(() => f.content.configure({ ...f.content.policy(), operation: 'configure' }), { code: 'INVALID_INPUT' });
});

test('quiet notification policy still produces visible content; lost publish response replays once after restart', async t => {
  const f = fixture(t), directory = join(f.root, 'worker'), calls = [];
  let failResponse = true;
  const candidate = { key: 'github:one', source: 'github', kind: 'repository_update', title: '组件更新说明', url: 'https://github.com/example/project/releases/tag/v1', expiresAt: base + 86400000,
    reading: { newsletter: false, sources: [{ id: 'github', type: 'primary', url: 'https://github.com/example/project/releases/tag/v1', text: 'This release adds composable components.', complete: true }] } };
  const connections = { bridge: { online: true }, desired: [{ ...source, enabled: true }], items: [{ id: 'github', account: 'fixture', state: 'connected', permissions: [{ id: 'repos', granted: true, verified: true }] }] };
  const options = {
    directory, now: f.now,
    transport: async input => {
      calls.push(input);
      const result = noticeWorkerBridge(f.hub, connections, input, f.content);
      if (input.operation === 'publish' && failResponse) { failResponse = false; throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' }); }
      return result;
    },
    collect: async () => ({ candidates: [candidate], counts: { github: 1 }, errors: [] }),
    prepareReading: async candidates => ({ candidates }),
    analyze: async () => JSON.stringify({ key: null, reviews: [{ key: candidate.key, summary: '发布说明介绍可组合组件。未执行测试。', relevance: '与组件设计有关。', suggestion: '可先阅读发布说明。', decision: 'skip', save: true, topic: '组件设计', exploration: false, evidence: [{ sourceId: 'github', quote: candidate.reading.sources[0].text }] }] }),
  };
  const worker = new PersonalNoticeWorker(options);
  await worker.tick();
  assert.equal(f.content.snapshot().entries.length, 1, JSON.stringify(worker.state.lastResult));
  assert.equal(worker.state.contentOutbox.length, 1);
  assert.equal(calls.some(call => call.operation === 'offer'), false);
  f.advance(31 * 60000);
  const restarted = new PersonalNoticeWorker(options);
  await restarted.tick();
  assert.equal(restarted.state.contentOutbox.length, 0);
  assert.equal(f.content.snapshot().entries.length, 1);
  assert.equal(f.store.snapshot(scope).items[0].taskData.collection.entries.length, 1);
  assert.equal(f.hub.all('delivery').length, 0);
  assert.doesNotMatch(readFileSync(join(directory, 'scan-log.jsonl'), 'utf8'), /This release|组件更新说明/);
});

test('explicit reply learns only from one delivered notice in the bound conversation', t => {
  const f = fixture(t), entry = f.publish(f.entry()).receipts[0];
  f.hub.put('channelEndpoint', { id: 'channel', active: true, peer: 'owner' });
  f.hub.put('personalNoticePolicy', { id: 'owner', channelId: 'channel' });
  f.hub.put('personalNotice', { id: 'notice', key: 'github:one', source: 'github', deliveryId: 'delivery' });
  f.hub.put('delivery', { id: 'delivery', source: { channel: 'imessage', account: 'channel', peer: 'owner' }, state: 'read', createdAt: base });
  assert.equal(personalNoticeCommand(f.hub, 'imessage', 'channel', 'stranger', '这条有用'), null);
  assert.match(personalNoticeCommand(f.hub, 'imessage', 'channel', 'owner', '这条有用'), /更留意/);
  assert.equal(f.content.snapshot().entries.find(row => row.id === entry.id).feedback, 'useful');
  f.hub.put('personalNotice', { id: 'another', key: 'other', source: 'github', deliveryId: 'delivery' });
  assert.match(personalNoticeCommand(f.hub, 'imessage', 'channel', 'owner', '这类不感兴趣'), /避免/);
  assert.equal(f.content.snapshot().topics[0].score, 3);
});

test('real feedback changes later selection; a new topic needs explicit positive feedback to graduate', t => {
  const f = fixture(t);
  f.content.configure({ operation: 'configure', revision: 1, enabled: true, discovery: true, maxDaily: 16, topics: ['组件设计', '工程规则'], sources: ['github'] });
  const receipts = f.publish(f.entry('liked'), f.entry('reduced', { topic: '工程规则' }), f.entry('new', { topic: '可访问性测试', exploration: false })).receipts;
  const before = f.content.snapshot();
  const discovery = before.entries.find(row => row.id === receipts[2].id);
  assert.equal(discovery.exploration, true, 'Unknown labels cannot evade the exploration budget');
  f.content.feedback({ operation: 'feedback', id: receipts[0].id, reaction: 'useful' });
  f.content.feedback({ operation: 'feedback', id: receipts[1].id, reaction: 'less' });
  const after = f.content.snapshot({ bridge: true });
  assert.notEqual(after.learning.version, before.learning.version);
  assert.equal(after.learning.explicitSignals, 2);
  assert.equal(after.learning.examples[0].reaction, 'less');
  const candidates = [
    f.entry('rule-next', { topic: '工程规则' }), f.entry('component-next'),
    f.entry('discovery-next', { topic: '可访问性测试' }),
  ];
  const chosen = selectAutomaticContent(candidates, after);
  assert.deepEqual(chosen.selected.map(row => row.key), ['component-next', 'discovery-next']);
  assert.equal(chosen.rejected.find(row => row.key === 'rule-next').skipped, 'topic_reduced');
  const result = f.publish(...candidates);
  assert.equal(result.receipts.find(row => row.key === 'rule-next').skipped, 'topic_reduced');
  const learned = f.content.snapshot().entries.find(row => row.id === result.receipts.find(row => row.key === 'component-next').id);
  assert.equal(learned.learning.reason, 'preferred');
  assert.deepEqual(learned.learning.feedbackIds, [receipts[0].id]);
  assert.equal(learned.learning.version, after.learning.version);
  f.content.feedback({ operation: 'feedback', id: discovery.id, reaction: 'opened' });
  assert.equal(selectAutomaticContent([f.entry('just-opened', { topic: '可访问性测试' })], f.content.snapshot()).selected[0].exploration, true);
  f.content.feedback({ operation: 'feedback', id: discovery.id, reaction: 'useful' });
  assert.equal(selectAutomaticContent([f.entry('learned-topic', { topic: '可访问性测试' })], f.content.snapshot()).selected[0].exploration, false);
});

test('changed preference invalidates analyzed outbox; replay preserves original receipt and provenance', t => {
  const f = fixture(t), first = f.publish(f.entry()).receipts[0];
  const version = f.content.snapshot().learning.version;
  f.content.feedback({ operation: 'feedback', id: first.id, reaction: 'not_interested' });
  const updated = f.content.snapshot().learning.version;
  f.content.feedback({ operation: 'feedback', id: first.id, reaction: 'not_interested' });
  assert.equal(f.content.snapshot().learning.version, updated, 'Repeated clicks are idempotent');
  const stale = f.publish(f.entry('stale', { preferenceVersion: version }));
  assert.equal(stale.receipts[0].skipped, 'preferences_changed');
  assert.equal(f.content.snapshot().entries.length, 1);
  assert.equal(f.publish(f.entry('github:one', { preferenceVersion: version })).receipts[0].replayed, true);
  f.content.feedback({ operation: 'feedback', id: first.id, reaction: 'clear' });
  assert.notEqual(f.content.snapshot().learning.version, updated);
  assert.ok(f.publish(f.entry('fresh', { preferenceVersion: f.content.snapshot().learning.version })).receipts[0].id);
  f.content.feedback({ operation: 'feedback', id: first.id, reaction: 'not_interested' });
  for (let day = 0; day < 21; day++) {
    f.advance(86400000);
    f.publish(...[0, 1].map(index => f.entry(`discover-${day}-${index}`, { topic: `新方向 ${day}-${index}` })));
  }
  assert.equal(f.content.snapshot().topics.some(topic => topic.name === '组件设计'), false, 'The bridge prompt bounds its topic list');
  assert.equal(f.publish(f.entry('muted-after-many-discoveries')).receipts[0].skipped, 'topic_preference', 'Prompt truncation cannot unmute a topic');
});

test('reading guidance changes future writing without inventing topic likes', t => {
  const f = fixture(t), before = f.content.snapshot();
  f.content.configure({ operation: 'configure', revision: 1, enabled: true, discovery: true, maxDaily: 8,
    topics: ['组件设计'], sources: ['github'], readingGuidance: '先分享一个轻松的小发现，细节展开再读。' });
  const changed = f.content.snapshot({ bridge: true });
  assert.notEqual(changed.learning.version, before.learning.version);
  assert.equal(changed.learning.explicitSignals, 0);
  assert.deepEqual(changed.learning.examples, []);
  assert.equal(changed.topics[0].score, 0);
  assert.equal(changed.learning.readingGuidance, f.content.policy().readingGuidance);
  const hook = '这组组件能重新组合，改页面时也许能少拆几面墙。';
  f.publish(f.entry('guided', { hook, preferenceVersion: changed.learning.version }));
  assert.equal(f.content.snapshot().entries[0].hook, hook);
  assert.equal(f.content.snapshot().entries[0].learning.guidanceApplied, true);
  assert.equal(f.content.snapshot().entries[0].learning.reason, 'relevant');
});

test('a full daily budget stops source and model work, then resumes after the local day changes', async t => {
  const f = fixture(t);
  f.content.configure({ operation: 'configure', revision: 1, enabled: true, discovery: true, maxDaily: 2, topics: ['组件设计'], sources: ['github'] });
  f.publish(f.entry('one'), f.entry('two'));
  assert.equal(f.publish(f.entry('three')).receipts[0].skipped, 'content_budget');
  let reads = 0;
  const worker = new PersonalNoticeWorker({ directory: join(f.root, 'worker'), now: f.now,
    transport: async input => input.operation === 'snapshot' ? { policy: { enabled: false, timezone: 'Asia/Shanghai' }, sources: [source], notices: [], content: f.content.snapshot({ bridge: true }) } : { accepted: true },
    collect: async () => { reads++; return { candidates: [], counts: {}, errors: [] }; },
    analyze: async () => { throw new Error('No analysis is permitted without a candidate'); },
  });
  await worker.tick();
  assert.equal(reads, 0);
  assert.equal(worker.state.lastResult.reason, 'content_budget');
  f.advance(86400000); await worker.tick();
  assert.equal(reads, 1);
  assert.equal(f.content.snapshot().today, 0);
});

test('worker consumes feedback before the scheduled scan, retains evidence and publishes only current preferences', async t => {
  const f = fixture(t), original = f.publish(f.entry('original')).receipts[0];
  const candidate = { key: 'new-candidate', source: 'github', kind: 'repository_update', title: '新的组件实证',
    url: 'https://github.com/example/project/releases/tag/v2', expiresAt: base + 86400000,
    reading: { newsletter: false, sources: [{ id: 'github', type: 'primary', url: 'https://github.com/example/project/releases/tag/v2', text: 'This release tests composable components.', complete: true }] } };
  const connections = { bridge: { online: true }, desired: [{ ...source, enabled: true }], items: [{ id: 'github', account: 'fixture', state: 'connected', permissions: [{ id: 'repos', granted: true, verified: true }] }] };
  let changeDuringAnalysis = false, analyses = 0;
  const worker = new PersonalNoticeWorker({ directory: join(f.root, 'worker'), now: f.now,
    transport: async input => noticeWorkerBridge(f.hub, connections, input, f.content),
    collect: async () => ({ candidates: [candidate], counts: { github: 1 }, errors: [] }),
    prepareReading: async candidates => ({ candidates }),
    analyze: async (_instructions, prompt) => {
      analyses++;
      const input = JSON.parse(prompt);
      assert.equal(input.learning.examples[0].id, original.id);
      if (changeDuringAnalysis) f.content.feedback({ operation: 'feedback', id: original.id, reaction: 'not_interested' });
      return JSON.stringify({ key: null, reviews: [{ key: candidate.key, summary: '维护者记录了组件组合测试，未独立执行。', relevance: '呼应对组件设计的明确反馈。', suggestion: '可以核对具体测试条件。',
        decision: 'skip', save: true, topic: '组件设计', exploration: false, evidence: [{ sourceId: 'github', quote: candidate.reading.sources[0].text }] }] });
    } });
  worker.state.preferenceVersion = f.content.snapshot().learning.version;
  worker.state.contentPolicyRevision = 1; worker.state.nextScanAt = f.now() + 1800000;
  f.content.feedback({ operation: 'feedback', id: original.id, reaction: 'useful' });
  changeDuringAnalysis = true; await worker.tick();
  assert.equal(analyses, 1, 'A feedback change wakes selection without clearing scheduler files');
  assert.equal(f.content.snapshot().entries.length, 1, 'A stale analysis cannot publish after feedback changed');
  changeDuringAnalysis = false;
  f.content.feedback({ operation: 'feedback', id: original.id, reaction: 'useful' });
  await worker.tick();
  assert.equal(analyses, 2);
  assert.equal(f.content.snapshot().entries.length, 2);
  assert.equal(f.content.snapshot().entries[0].learning.reason, 'preferred');
  assert.equal(worker.state.contentSelection.preferenceVersion, f.content.snapshot().learning.version);
  assert.equal(f.hub.all('delivery').length, 0);
});

test('background GitHub reuses public source reader, including stars without watching; recheck repeats exact notification', async () => {
  const calls = [], repo = { full_name: 'example/project', private: false, visibility: 'public', default_branch: 'main', pushed_at: new Date(base).toISOString() };
  const runner = async (_command, args) => {
    calls.push(args);
    const path = args[1];
    let value;
    if (path === 'user') value = { login: 'fixture' };
    else if (path.startsWith('notifications?')) value = [{ id: '12', repository: repo, subject: { url: 'https://api.github.com/repos/example/project/issues/7' }, updated_at: new Date(base).toISOString(), unread: true }];
    else if (path === 'repos/example/project/issues/7') value = { title: 'Design discussion', body: 'A concrete proposal for composable components.', html_url: 'https://github.com/example/project/issues/7' };
    else if (path.startsWith('user/subscriptions?')) value = [];
    else if (path.startsWith('user/starred?')) value = [repo];
    else if (path.endsWith('/subscription')) return { exitCode: 1, stdout: '' };
    else if (path === 'user/starred/example/project') return { exitCode: 0, stdout: '' };
    else if (path === 'repos/example/project') value = repo;
    else if (path.startsWith('repos/example/project/releases?')) value = [{ id: 42, name: 'Version one', tag_name: 'v1', body: 'New components with composition support.', published_at: new Date(base).toISOString(), draft: false, prerelease: false }];
    else if (path.startsWith('repos/example/project/commits?')) value = [];
    else throw new Error('Unexpected request ' + path);
    return { exitCode: 0, stdout: JSON.stringify(value) };
  };
  const collect = createNoticeSources({ runner });
  const context = { now: base + 1000, timezone: 'Asia/Shanghai', content: true };
  const result = await collect([source], context);
  assert.deepEqual(result.errors, []);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every(row => row.reading.sources[0].complete));
  const notification = result.candidates.find(row => row.notificationId);
  const recheck = await collect([source], { ...context, now: base + 1801000, recheckCandidates: [notification] });
  assert.deepEqual(recheck.candidates, [notification]);
  for (const args of calls.filter(args => args[1] !== 'user')) {
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    assert.ok(!args.includes('-f'));
  }
});
