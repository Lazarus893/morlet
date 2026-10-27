import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { createConnectionManager } from '../plugins/connections/manager.mjs';
import { createCloudNoticeBridge } from '../plugins/proactive/cloud-notice-bridge.mjs';
import { noticeWorkerSources, noticeWorkerBridge } from '../plugins/proactive/notice-worker-bridge.mjs';
import { createNoticeSources } from '../plugins/proactive/notice-sources.mjs';
import { createMailReading } from '../plugins/proactive/notice-mail-reading.mjs';
import { createRoutedNoticeSources } from '../scripts/personal-notice-worker.mjs';
import { PersonalNoticeWorker } from '../plugins/proactive/notice-worker.mjs';
import { createAutomaticContent } from '../plugins/proactive/automatic-content.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';

const env = { NANGO_SECRET_KEY: 'private-fixture-key-not-for-output' };
const now = Date.parse('2026-10-23T04:00:00Z');
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const ago = new Date(now - 3600000).toISOString();
const message = (id, time, text) => ({ id, threadId: 'abc', internalDate: String(time), payload: { mimeType: 'text/plain', headers: [
  { name: 'Date', value: new Date(time).toUTCString() }, { name: 'Subject', value: 'Agent interface review' }, { name: 'From', value: 'author@example.test' },
], body: { data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text) } } });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-notice-')), hub = new AgentHub(root, { now: () => now });
  const manager = createConnectionManager({ root, now: () => now, cloudServices: ['google', 'github'] });
  const paired = manager.mutate({ operation: 'pair', revision: manager.snapshot().revision, values: { name: 'Fixture Mac' } });
  const config = { instanceId: 'notice-test', integrations: { google: { integrationId: 'google-suite' }, github: { integrationId: 'github-pat' } } };
  writeFileSync(join(root, '.runtime/connections/nango.json'), JSON.stringify(config), { mode: 0o600 });
  for (const [id, account, permissions] of [['google', 'reader@example.test', ['gmail', 'calendar']], ['github', 'FixtureOwner', ['repos']]]) {
    const { item } = manager.cloudBegin({ id, operation: 'connect', revision: manager.snapshot().revision });
    manager.cloudUpdate(id, item.generation, { state: 'connected', account, binding: { service: id, connectionId: id + '-connection', integrationId: config.integrations[id].integrationId, ownerId: 'owner' },
      permissions: permissions.map(id => ({ id, granted: true, verified: true })) });
  }
  hub.put('automaticContentPolicy', { id: 'owner', enabled: true, revision: 1, sources: ['google-mail', 'google-calendar', 'github'] });
  const automaticContent = { policy: () => hub.get('automaticContentPolicy', 'owner'), snapshot: () => ({ ...hub.get('automaticContentPolicy', 'owner'), learning: { version: 'test' } }) };
  const calls = []; let intercept;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), path = parsed.pathname; calls.push(path);
    if (intercept) { const value = await intercept(path); if (value) return value; }
    const google = options.headers['Provider-Config-Key'] === 'google-suite' || parsed.searchParams.get('connectionId') === 'google-connection' || path.includes('google-connection'), id = google ? 'google' : 'github';
    const record = { connection_id: id + '-connection', provider_config_key: config.integrations[id].integrationId, provider: id,
      tags: { end_user_id: createHash('sha256').update('notice-test\0owner').digest('hex'), xiaoman_instance: 'notice-test' }, errors: [],
      credentials: { api_key: 'PRIVATE_UPSTREAM_VALUE', scope: google ? 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly' : '' } };
    if (path === '/connections') return response({ connections: [record] });
    if (path.startsWith('/connections/')) return response(record);
    if (path === '/proxy/oauth2/v2/userinfo') return response({ email: 'reader@example.test', verified_email: true });
    if (path === '/proxy/user') return response({ login: 'FixtureOwner' });
    if (path === '/proxy/gmail/v1/users/me/messages') return response({ messages: [{ id: 'bbb', threadId: 'abc' }] });
    if (path === '/proxy/gmail/v1/users/me/messages/bbb') return response(message('bbb', now - 3600000, 'The current revision keeps the task bookmark visible.'));
    if (path === '/proxy/gmail/v1/users/me/threads/abc') return response({ id: 'abc', messages: [message('abc', now - 7200000, 'Earlier revision had a hidden task bookmark.'), message('bbb', now - 3600000, 'The current revision keeps the task bookmark visible.')] });
    if (path === '/proxy/calendar/v3/calendars/primary/events') return response({ timeZone: 'Asia/Shanghai', items: [
      { id: 'event', summary: 'Design review', start: { dateTime: new Date(now + 3600000).toISOString() }, end: { dateTime: new Date(now + 7200000).toISOString() } },
      { id: 'declined', summary: 'Declined event', start: { dateTime: new Date(now + 3600000).toISOString() }, attendees: [{ self: true, responseStatus: 'declined' }] },
      { id: 'all-day', summary: 'All day', start: { date: '2026-10-23' } },
    ] });
    if (path === '/proxy/notifications') return response([{ id: '12', repository: { full_name: 'example/agent', private: false }, reason: 'subscribed', updated_at: ago,
      subject: { title: 'Task navigation', url: 'https://api.github.com/repos/example/agent/issues/1' } }]);
    if (path === '/proxy/repos/example/agent/issues/1') return response({ title: 'Task navigation', body: 'The implementation adds a bookmark to the first task page.', html_url: 'https://github.com/example/agent/issues/1', updated_at: ago });
    if (path === '/proxy/user/subscriptions' || path === '/proxy/user/starred') return response([]);
    if (path === '/proxy/search/issues') return response({ items: [] });
    throw new Error('Unexpected REST endpoint');
  };
  const bridge = createCloudNoticeBridge({ config, manager, hub, automaticContent, env, fetchImpl });
  const connections = () => ({ ...manager.snapshot(), desired: manager.bridgeSnapshot(paired.token).desired });
  const sources = () => noticeWorkerSources(connections(), automaticContent.policy());
  const call = input => bridge(input, connections(), { authorize: () => manager.bridgeSnapshot(paired.token) });
  const collect = (content = true, ids = ['google-mail', 'google-calendar', 'github']) => call({ operation: 'cloud-collect', content, sources: sources().filter(s => ids.includes(s.id)).map(({ id, generation }) => ({ id, generation })) });
  const pause = () => hub.put('automaticContentPolicy', { ...automaticContent.policy(), enabled: false, revision: automaticContent.policy().revision + 1 });
  t.after(() => { manager.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, hub, manager, sources, calls, call, collect, connections, automaticContent, pause, intercept: fn => { intercept = fn; } };
}

test('automatic mail/calendar/notification collection uses Nango REST while Mac heartbeat is offline', async t => {
  const f = fixture(t); assert.equal(f.manager.snapshot().bridge.online, false);
  assert.deepEqual(f.sources().map(s => s.id), ['google-calendar', 'google-mail', 'github']);
  const result = await f.collect();
  assert.deepEqual(result.errors, []);
  assert.equal(result.candidates.filter(c => c.source === 'google-calendar').length, 1);
  assert.equal(result.candidates.find(c => c.source === 'google-mail').mailId, 'bbb');
  assert.match(result.candidates.find(c => c.source === 'github').reading.sources[0].text, /bookmark/);
  const json = JSON.stringify(result); assert.ok(!json.includes('PRIVATE_UPSTREAM_VALUE')); assert.ok(!json.includes(env.NANGO_SECRET_KEY));
});

test('cloud MIME and thread bodies feed the existing mail reader with complete provenance and no CLI', async t => {
  const f = fixture(t), collected = await f.collect(true, ['google-mail']); let localCalls = 0;
  const read = createMailReading({ directory: join(f.root, 'reading'), now: () => now, maxArticles: 1, articleReader: async () => { throw new Error('No article expected'); },
    runner: async () => { localCalls++; throw new Error('Local CLI forbidden'); },
    readMail: (source, { messageId, threadId }) => f.call({ operation: 'cloud-mail', generation: source.generation, ...(messageId && { messageId }), ...(threadId && { threadId }) }) });
  const result = await read(collected.candidates, { sources: f.sources() });
  assert.equal(result.stats.emailsRead, 1); assert.equal(result.stats.failed, 0); assert.equal(localCalls, 0);
  const evidence = result.candidates[0].reading.sources;
  assert.equal(evidence.length, 2); assert.match(evidence[0].text, /current revision/); assert.match(evidence[1].text, /Earlier revision/);
  assert.ok(evidence.every(s => s.complete));
  assert.ok(f.calls.includes('/proxy/gmail/v1/users/me/threads/abc'));
});

test('policy withdrawal during ownership lookup prevents credentials/body from being fetched', async t => {
  const f = fixture(t), source = f.sources().find(s => s.id === 'google-mail');
  f.intercept(async path => { if (path === '/connections') f.pause(); });
  await assert.rejects(f.call({ operation: 'cloud-mail', generation: source.generation, messageId: 'bbb' }), { code: 'SOURCE_AUTHORITY_CHANGED' });
  assert.deepEqual(f.calls, ['/connections']);
});

test('connection withdrawal or paired-credential revocation during MIME fetch discards its response', async t => {
  for (const revokePair of [false, true]) {
    const f = fixture(t), source = f.sources().find(s => s.id === 'google-mail');
    f.intercept(async path => {
      if (path !== '/proxy/gmail/v1/users/me/messages/bbb') return;
      if (revokePair) f.manager.mutate({ operation: 'unpair', revision: f.manager.snapshot().revision });
      else f.manager.cloudBegin({ id: 'google', operation: 'disconnect', revision: f.manager.snapshot().revision });
    });
    await assert.rejects(f.call({ operation: 'cloud-mail', generation: source.generation, messageId: 'bbb' }), { code: revokePair ? 'BRIDGE_UNAUTHORIZED' : 'SOURCE_AUTHORITY_CHANGED' });
  }
});

test('paused personal notices do not expand enabled automatic reading to other sources', async t => {
  const f = fixture(t);
  f.hub.put('personalNoticePolicy', { id: 'owner', enabled: false, sources: ['github'] });
  f.hub.put('automaticContentPolicy', { ...f.automaticContent.policy(), sources: ['google-mail'], revision: 2 });
  const connections = { ...f.manager.snapshot(), desired: ['google', 'github'].map(id => ({ id, generation: f.manager.cloudState(id).generation })) };
  const snapshot = noticeWorkerBridge(f.hub, connections, { operation: 'snapshot' }, f.automaticContent);
  assert.deepEqual(snapshot.sources.map(s => s.id), ['google-mail']);
  await assert.rejects(f.call({ operation: 'cloud-collect', content: true, sources: [{ id: 'github', generation: f.manager.cloudState('github').generation }] }), { code: 'SOURCE_AUTHORITY_CHANGED' });
  assert.equal(f.calls.length, 0);
});

test('failed cloud collection remains an explicit source failure and never uses the matching local CLI', async () => {
  const localInputs = [], collector = createRoutedNoticeSources({
    collect: async sources => { localInputs.push(...sources.map(s => s.id)); return { candidates: [{ key: 'local', source: 'local-files' }], counts: { 'local-files': 1 }, errors: [] }; },
    transport: async () => { throw new Error('private upstream failure'); },
  });
  const result = await collector([{ id: 'github', connectionProvider: 'nango', generation: 2 }, { id: 'local-files' }], { now, timezone: 'UTC' });
  assert.deepEqual(localInputs, ['local-files']); assert.deepEqual(result.errors, ['github']); assert.equal(result.candidates[0].source, 'local-files');
  await assert.rejects(collector([{ id: 'github', connectionProvider: 'nango' }, { id: 'github' }], {}), { code: 'INVALID_SNAPSHOT' });
  let commands = 0;
  const direct = createNoticeSources({ runner: async () => { commands++; } });
  assert.deepEqual((await direct([{ id: 'github', account: 'FixtureOwner', connectionProvider: 'nango' }], { now, timezone: 'UTC' })).errors, ['github']);
  assert.equal(commands, 0);
});

test('incomplete cloud mail cannot be cached or classified as a complete body by the old reader', async t => {
  const f = fixture(t), source = f.sources().find(s => s.id === 'google-mail'); let local = 0;
  const reader = createMailReading({ directory: join(f.root, 'incomplete'), runner: async () => { local++; },
    readMail: async () => ({ message: { id: 'bbb' }, body: 'Partial text', bodyComplete: false }), maxArticles: 1 });
  const result = await reader([{ key: 'google-mail:bbb', kind: 'mail', mailId: 'bbb', source: 'google-mail' }], { sources: [source] });
  assert.equal(result.stats.failed, 1); assert.equal(result.stats.emailsRead, 0); assert.deepEqual(result.candidates, []); assert.equal(local, 0);
});

test('existing observer completes cloud collect, full reading, reread and durable journal publication without sending notices', async t => {
  const f = fixture(t), store = new JournalStore(f.root, { now: () => now });
  try {
    f.hub.put('automaticContentPolicy', { ...f.automaticContent.policy(), sources: ['google-mail', 'github'], topics: ['界面设计'], maxDaily: 10, discovery: false });
    const content = createAutomaticContent({ hub: f.hub, journal: { store } }), operations = [];
    const transport = async input => {
      operations.push(input.operation);
      return input.operation.startsWith('cloud-') ? f.call(input) : noticeWorkerBridge(f.hub, f.connections(), input, content);
    };
    const read = createMailReading({ directory: join(f.root, 'pipeline-reading'), now: () => now, maxArticles: 1,
      readMail: (source, { messageId, threadId }) => transport({ operation: 'cloud-mail', generation: source.generation, ...(messageId && { messageId }), ...(threadId && { threadId }) }),
      runner: async () => { throw new Error('Unexpected CLI'); } });
    const worker = new PersonalNoticeWorker({ directory: join(f.root, 'worker'), now: () => now, transport,
      collect: createRoutedNoticeSources({ collect: createNoticeSources({ runner: async () => { throw new Error('Unexpected CLI'); } }), transport }), prepareReading: read,
      analyze: async (_rules, prompt) => {
        const input = JSON.parse(prompt);
        assert.ok(input.candidates.every(candidate => candidate.reading?.sources[0]?.complete));
        return JSON.stringify({ key: null, reviews: input.candidates.map(candidate => ({ key: candidate.key, summary: '来源说明任务书签改为持续显示，未独立验证实现效果。', relevance: '与界面设计有关。', suggestion: '可结合任务导航检查。', decision: 'skip', save: true, topic: '界面设计', exploration: false,
          evidence: [{ sourceId: candidate.reading.sources[0].id, quote: candidate.reading.sources[0].text }] })) });
      } });
    await worker.tick();
    assert.equal(content.snapshot().entries.length, 2, JSON.stringify(worker.state.lastResult));
    assert.ok(operations.includes('publish')); assert.ok(operations.filter(operation => operation === 'cloud-collect').length >= 2);
    assert.equal(operations.includes('offer'), false); assert.equal(f.hub.all('run').length, 0);
    await worker.tick(); assert.equal(content.snapshot().entries.length, 2);
  } finally { store.close(); }
});
