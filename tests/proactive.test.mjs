import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProactiveEngine } from '../plugins/proactive/engine.mjs';
import { MINUTE, DAY, deliveryGate, inQuiet, localTime, parseInstant } from '../plugins/proactive/policy.mjs';
import { parseObservation } from '../plugins/proactive/observer.mjs';
import { compose } from '../plugins/proactive/sniper.mjs';
import { makeAnalyzer } from '../plugins/proactive/index.mjs';
import { WeixinHarnessBridge } from '../vendor/deepseek-harness-weixin/dist/index.js';

const base = JSON.parse(await readFile(new URL('../config/pa.example.json', import.meta.url))).proactive;
const initial = Date.parse('2026-10-10T10:00:00+08:00');
const message = (id = 'user-a', token = 'private-context') => ({ from_user_id: id, context_token: token });
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa proactive '));
  let now = initial;
  const sent = [];
  const config = { ...base, mode: 'Active', timezone: 'Asia/Shanghai', state_dir: directory, ...overrides.config };
  const options = { config, accountId: 'account-a', allowed: id => ['user-a', 'user-b'].includes(id), now: () => now,
    send: async (...args) => { sent.push(args); }, analyze: async () => '{"changes":[]}', ...overrides, config };
  const engine = new ProactiveEngine(options);
  await engine.initialize({ startTimer: false });
  t.after(async () => { if (!engine.stopped) await engine.stop(); await rm(directory, { recursive: true, force: true }); });
  return { engine, sent, config, options, directory, advance: ms => { now += ms; }, setNow: time => { now = Date.parse(time); },
    user: (id = 'user-a') => engine.store.data.users[id] };
}
async function addDue(f, title = '取快递', id = 'user-a') {
  await f.engine.receive(message(id), `/pa add 2026-10-10T10:06+08:00 ${title}`);
  return f.user(id).tasks.find(t => t.kind === 'reminder');
}

test('Day 1 stays silent even after idle delay and restart', async t => {
  const f = await fixture(t);
  await f.engine.receive(message(), '你好');
  await f.engine.tick(); assert.equal(f.sent.length, 0);
  f.advance(11 * MINUTE); await f.engine.tick();
  assert.equal(f.sent.length, 0);
  f.advance(4 * 60 * MINUTE); await f.engine.tick(); assert.equal(f.sent.length, 0);
  assert.equal((await stat(f.engine.store.path)).mode & 0o777, 0o600);
});

test('untrusted users are never persisted or notified', async t => {
  const f = await fixture(t);
  assert.equal(await f.engine.receive(message('stranger'), '你好'), null);
  assert.equal(Object.keys(f.engine.store.data.users).length, 0);
});

test('quiet windows support overnight and same-day ranges, IANA timezone and DST', () => {
  assert.equal(inQuiet(Date.parse('2026-10-10T23:00+08:00'), { ...base, timezone: 'Asia/Shanghai' }), true);
  assert.equal(inQuiet(Date.parse('2026-10-11T09:00+08:00'), { ...base, timezone: 'Asia/Shanghai' }), false);
  assert.equal(inQuiet(initial, { ...base, timezone: 'Asia/Shanghai', quiet_start: '09:00', quiet_end: '11:00' }), true);
  assert.equal(localTime(Date.parse('2026-11-01T06:30Z'), 'America/New_York').minutes, 90);
});

test('direct reminders use deterministic fallback if model fails; task touch replaces welcome', async t => {
  const f = await fixture(t, { analyze: async () => { throw new Error('offline'); } });
  const task = await addDue(f);
  f.advance(11 * MINUTE); await f.engine.tick();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0][1], /取快递/);
  assert.equal(task.status, 'submitted');
  assert.equal(f.user().tasks.find(t => t.kind === 'welcome').status, 'skipped');
});

test('pause/resume and completion feedback close the loop without calling Agent', async t => {
  const f = await fixture(t);
  const task = await addDue(f);
  await f.engine.receive(message(), '暂停提醒');
  f.advance(8 * MINUTE); await f.engine.tick(); assert.equal(f.sent.length, 0);
  await f.engine.receive(message(), '恢复提醒');
  f.advance(6 * MINUTE); await f.engine.tick(); assert.equal(f.sent.length, 1);
  assert.match(await f.engine.receive(message(), '办完了'), /已完成/);
  assert.equal(task.status, 'done');
  f.advance(4 * 60 * MINUTE); await f.engine.tick(); assert.equal(f.sent.length, 1);
});

test('snooze only matches owning user and cannot pass a known deadline', async t => {
  const f = await fixture(t);
  const task = await addDue(f);
  await f.engine.receive(message('user-b'), '你好');
  assert.match(await f.engine.receive(message('user-b'), `/pa done ${task.id}`), /没找到/);
  task.dueAt = initial + 30 * MINUTE;
  assert.match(await f.engine.receive(message(), `/pa later 60 ${task.id}`), /超过/);
  assert.match(await f.engine.receive(message(), `/pa later 10 ${task.id}`), /已延后/);
});

test('recent activity, busy conversation and stale context all defer delivery', async t => {
  let busy = true;
  const f = await fixture(t, { busy: () => busy });
  await addDue(f);
  f.advance(11 * MINUTE); await f.engine.tick(); assert.equal(f.sent.length, 0);
  busy = false;
  await f.engine.receive(message(), '还在聊呢');
  await f.engine.tick(); assert.equal(f.sent.length, 0);
  f.advance(6 * MINUTE);
  f.user().contextAt = initial - DAY;
  await f.engine.tick(); assert.equal(f.sent.length, 0);
  assert.equal(f.user().blockedBy, 'context_expired');
});

test('daily budget and cooldown count attempts, and calendar day uses selected timezone', async t => {
  const f = await fixture(t);
  await addDue(f);
  f.advance(6 * MINUTE); await f.engine.tick();
  assert.equal(deliveryGate(f.user(), f.config, initial + 7 * MINUTE), 'cooldown');
  f.user().lastAttempt = initial - DAY;
  f.user().deliveryDays['2026-10-10'] = 2;
  assert.equal(deliveryGate(f.user(), f.config, initial + 7 * MINUTE), 'daily_budget');
});

test('an expired task is retained as expired and never produces a catch-up burst', async t => {
  const f = await fixture(t);
  const task = await addDue(f);
  f.advance(5 * 60 * MINUTE);
  // The late first-day opener must also expire, to isolate the overdue-task behavior.
  f.user().tasks.find(t => t.kind === 'welcome').expiresAt = initial;
  await f.engine.tick();
  assert.equal(task.status, 'expired'); assert.equal(f.sent.length, 0);
});

test('transport ambiguity is recorded once, including across restart', async t => {
  let attempts = 0;
  const f = await fixture(t, { send: async () => { attempts++; throw new Error('timeout'); } });
  const task = await addDue(f);
  f.advance(6 * MINUTE); await f.engine.tick();
  assert.equal(task.status, 'delivery_unknown'); assert.equal(attempts, 1);
  await f.engine.stop();
  const restarted = new ProactiveEngine(f.options);
  await restarted.initialize({ startTimer: false });
  f.advance(3 * 60 * MINUTE); await restarted.tick();
  assert.equal(attempts, 1);
  assert.equal(restarted.store.data.users['user-a'].tasks.find(t => t.id === task.id).status, 'delivery_unknown');
  await restarted.stop();
});

test('feedback during an uncertain send closes the current reminder instead of the previous one', async t => {
  let f;
  f = await fixture(t, { send: async () => {
    assert.match(await f.engine.receive(message(), '办完了'), /已完成/);
    throw new Error('response lost after delivery');
  } });
  const task = await addDue(f);
  f.user().lastTaskId = 'older-unrelated-task';
  f.advance(6 * MINUTE); await f.engine.tick();
  assert.equal(task.status, 'done'); assert.equal(f.user().lastTaskId, task.id);
});

test('crash in sending recovers as unknown and removed recipients are pruned', async t => {
  const f = await fixture(t);
  const task = await addDue(f);
  task.status = 'sending'; await f.engine.store.save(); await f.engine.stop();
  const restarted = new ProactiveEngine(f.options);
  await restarted.initialize({ startTimer: false });
  assert.equal(restarted.store.data.users['user-a'].tasks.find(t => t.id === task.id).status, 'delivery_unknown');
  await restarted.stop();
  const pruned = new ProactiveEngine({ ...f.options, allowed: () => false });
  await pruned.initialize({ startTimer: false });
  assert.deepEqual(Object.keys(pruned.store.data.users), []);
  await pruned.stop();
});

test('second channel process cannot own the same ledger', async t => {
  const f = await fixture(t);
  const duplicate = new ProactiveEngine(f.options);
  await assert.rejects(duplicate.initialize({ startTimer: false }), /ALREADY_RUNNING/);
});

test('observer grounds candidates in exact user evidence, merges updates and closes done items', async t => {
  let response;
  const inputs = [];
  const f = await fixture(t, { analyze: async (_, input) => { inputs.push(input); return JSON.stringify(response); } });
  const text = '明天上午十点提醒我拿快递';
  await f.engine.receive(message(), text);
  response = { changes: [{ action: 'upsert', id: null, kind: 'reminder', title: '拿快递', evidence: text, confidence: .96,
    notify_at: '2026-10-11T10:00+08:00', due_at: null }] };
  assert.match(await f.engine.observe('user-a', text), /已登记/);
  assert.ok(inputs.every(input => !input.includes('private-context')));
  await f.engine.observe('user-a', text);
  assert.equal(f.user().tasks.filter(t => t.kind === 'reminder').length, 1);
  const task = f.user().tasks.find(t => t.kind === 'reminder');
  response = { changes: [{ action: 'done', id: task.id, evidence: '快递已经拿回来了', confidence: .95 }] };
  assert.match(await f.engine.observe('user-a', '快递已经拿回来了'), /已完成/);
  assert.equal(task.status, 'done');
});

test('observer rejects unsupported facts, past dates, low confidence and foreign task ids', () => {
  const c = { action: 'upsert', kind: 'reminder', title: '拿快递', evidence: '明天提醒拿快递', confidence: .95,
    id: null, notify_at: '2026-10-11T10:00+08:00', due_at: null };
  for (const override of [{ evidence: '编造用户的话' }, { confidence: .5 }, { id: 'foreign' },
    { notify_at: 'yesterday' }, { notify_at: '2020-01-01T00:00Z' }, { notify_at: null }]) {
    assert.deepEqual(parseObservation(JSON.stringify({ changes: [{ ...c, ...override }] }), c.evidence, { tasks: [] }, initial), []);
  }
  assert.equal(parseObservation(JSON.stringify({ changes: [c, c] }), c.evidence, { tasks: [] }, initial).length, 1);
});

test('sniper can suppress weak followups and enforces information budget', () => {
  const task = { id: '12345678', kind: 'followup' }, user = { preferences: {} };
  assert.equal(compose('{"decision":"skip","text":""}', task, user, base), null);
  assert.throws(() => compose(JSON.stringify({ decision: 'send', text: '长'.repeat(500) }), task, user, base));
  assert.ok(compose('{"decision":"send","text":"你提过要寄包裹，今天方便整理一下吗？"}', task, user, base).length <= base.max_chars);
});

test('an inbound pause while sniper is drafting prevents submission', async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { analyze: async () => { started(); return await new Promise(resolve => { release = resolve; }); } });
  await addDue(f); f.advance(6 * MINUTE);
  const tick = f.engine.tick(); await waiting;
  await f.engine.receive(message(), '暂停提醒');
  release('{"decision":"send","text":"提醒你拿快递。"}');
  await tick; assert.equal(f.sent.length, 0);
});

test('pauses during observer analysis discard its late result', async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { analyze: async () => { started(); return await new Promise(resolve => { release = resolve; }); } });
  await f.engine.receive(message(), '稍后准备寄快递');
  const observe = f.engine.observe('user-a', '稍后准备寄快递'); await waiting;
  await f.engine.receive(message(), '暂停提醒');
  release(JSON.stringify({ changes: [{ action: 'upsert', kind: 'followup', id: null, title: '寄快递',
    evidence: '稍后准备寄快递', confidence: .96, notify_at: null, due_at: null }] }));
  await observe; assert.equal(f.user().tasks.filter(t => t.kind !== 'welcome').length, 0);
});

test('WeChat observes ordinary input; commands do not invoke core', async t => {
  const f = await fixture(t, { analyze: async () => '{"changes":[]}' });
  const replies = [], prompts = [];
  const bridge = new WeixinHarnessBridge({ logger: () => ({ warn() {}, error() {} }) }, {
    cwd: f.directory, approvalTimeoutMs: 100, responseTimeoutMs: 1000, maxSeenMessageIds: 100,
    accessPolicy: 'allowlist', allowFrom: ['user-a'], maxInFlightMessages: 4, maxReplyBytes: 4000, maxReplyImages: 0, maxReplyFiles: 0, sendRetries: 0,
  });
  bridge.proactive = f.engine;
  bridge.conversations = { process: async msg => { prompts.push(msg); return { text: '正常回复', images: [], files: [] }; } };
  const api = { sendText: async (_id, text) => { replies.push(text); } };
  await bridge.dispatch({ ...message(), item_list: [{ type: 1, text_item: { text: '今天先把待办整理好' } }] }, api);
  await Promise.all([...bridge.inFlight]);
  assert.equal(prompts.length, 1); assert.equal(bridge.activeUsers.size, 0);
  await bridge.dispatch({ ...message(), message_id: 'pause', item_list: [{ type: 1, text_item: { text: '暂停提醒' } }] }, api);
  await Promise.all([...bridge.inFlight]);
  assert.equal(prompts.length, 1); assert.match(replies.at(-1), /已暂停/);
});

test('implicit observation does not delay chat; cancellation stops explicit observation before core', async t => {
  let waiting, release;
  let started = new Promise(resolve => { waiting = resolve; });
  const f = await fixture(t, { analyze: async (_instructions, _input, signal) => {
    waiting();
    return new Promise((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } });
  let chats = 0;
  const replies = [];
  const bridge = new WeixinHarnessBridge({ logger: () => ({ warn() {}, error() {} }) }, {
    cwd: f.directory, approvalTimeoutMs: 100, responseTimeoutMs: 1000, maxSeenMessageIds: 100,
    accessPolicy: 'allowlist', allowFrom: ['user-a'], maxInFlightMessages: 4, maxReplyBytes: 4000,
    maxReplyImages: 0, maxReplyFiles: 0, sendRetries: 0,
  });
  bridge.proactive = f.engine;
  bridge.conversations = { process: async () => { chats++; return { text: '正常回复', images: [], files: [] }; }, cancel: () => false };
  const api = { sendText: async (_id, text) => { replies.push(text); } };
  const msg = text => ({ ...message(), item_list: [{ type: 1, text_item: { text } }] });
  const chat = bridge.handleMessage(msg('明天需要整理报销'), api);
  await started;
  while (!replies.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(chats, 1); // Observer is still unresolved, but chat is already delivered.
  release('{"changes":[]}'); await chat;
  started = new Promise(resolve => { waiting = resolve; });
  const explicit = bridge.handleMessage(msg('明天提醒我整理报销'), api);
  await started;
  await bridge.handleMessage(msg('/bot-cancel'), api);
  await explicit;
  assert.equal(chats, 1);
});

test('parallel scheduler ticks submit one message', async t => {
  const f = await fixture(t);
  await addDue(f); f.advance(6 * MINUTE);
  await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()]);
  assert.equal(f.sent.length, 1);
});

test('per-user observation budget limits model cost without blocking explicit local add', async t => {
  let calls = 0;
  const f = await fixture(t, { config: { max_observations_daily: 1 }, analyze: async () => { calls++; return '{"changes":[]}'; } });
  await f.engine.receive(message(), '明天还有点事情');
  await f.engine.observe('user-a', '明天还有点事情');
  await f.engine.observe('user-a', '后天也有点事情');
  assert.equal(calls, 1);
  assert.match(await f.engine.receive(message(), '/pa add 2026-10-10T12:00+08:00 取快递'), /已记录/);
});

test('invalid calendar dates and unsafe runtime policy fail closed', async t => {
  assert.ok(Number.isNaN(parseInstant('2026-02-30T10:00+08:00')));
  assert.ok(Number.isNaN(parseInstant('2026-10-10T24:00+08:00')));
  const f = await fixture(t);
  assert.throws(() => new ProactiveEngine({ ...f.options, config: { ...f.config, max_daily: -1 } }), /CONFIG_INVALID/);
});

test('local preview excludes context tokens and cannot send', async t => {
  const f = await fixture(t);
  await addDue(f);
  const root = join(f.directory, 'relocated');
  for (const dir of ['scripts', 'plugins/proactive', '.runtime']) await mkdir(join(root, dir), { recursive: true });
  for (const path of ['scripts/proactive.mjs', 'plugins/proactive/policy.mjs', 'plugins/proactive/sniper.mjs']) {
    await copyFile(fileURLToPath(new URL('../' + path, import.meta.url)), join(root, path));
  }
  await writeFile(join(root, '.runtime/proactive.json'), JSON.stringify(f.config));
  const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'scripts/proactive.mjs'), 'preview']);
  assert.ok(!stdout.includes('private-context')); assert.ok(!stdout.includes('contextToken'));
  assert.equal(JSON.parse(stdout).accounts.length, 1); assert.equal(f.sent.length, 0);
});

test('OS lease is released after an owned process crashes', async t => {
  const f = await fixture(t);
  await f.engine.stop();
  const source = `import {Ledger} from ${JSON.stringify(new URL('../plugins/proactive/store.mjs', import.meta.url).href)};
    const store=new Ledger(${JSON.stringify(f.directory)},'account-a');
    await store.initialize(()=>true); process.stdout.write('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  const restarted = new ProactiveEngine(f.options);
  await restarted.initialize({ startTimer: false });
  await restarted.stop();
});

for (const provider of ['codex', 'workbuddy']) test(`${provider} background analysis uses isolated nonpersistent restricted mode`, async t => {
  const f = await fixture(t);
  process.env.PA_TEST_SCENARIO = 'passive'; process.env.PA_TEST_REPLY = '{"changes":[]}';
  process.env.PA_TEST_REASONING_EFFORT = 'medium';
  try {
    const analyze = makeAnalyzer({}, { provider, command: fileURLToPath(new URL('./fake_agent.mjs', import.meta.url)), timeout_seconds: 3 }, f.directory);
    assert.equal(await analyze('观察者', '{}', new AbortController().signal), '{"changes":[]}');
  } finally { delete process.env.PA_TEST_SCENARIO; delete process.env.PA_TEST_REPLY; delete process.env.PA_TEST_REASONING_EFFORT; }
});

test('DSH analysis calls the existing model without an Agent or any tools', async () => {
  let options;
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) }, llm: {
    async *stream(value) { options = value; yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '{"changes":[]}' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"changes":[]}' } };
      yield { type: 'finish', reason: { kind: 'stop' } }; },
  } };
  assert.equal(await makeAnalyzer(ctx, { provider: 'dsh' }, '')('observer', '{}', new AbortController().signal), '{"changes":[]}');
  assert.deepEqual(options.tools, []); assert.equal(options.sessionId, undefined);
});

test('channel lifecycle replies to ping but never submits first-day heartbeat text', async t => {
  const f = await fixture(t);
  const agentConfig = join(f.directory, 'agent.json'), configPath = join(f.directory, 'proactive.json');
  await writeFile(agentConfig, JSON.stringify({ provider: 'dsh' }));
  await writeFile(configPath, JSON.stringify({ ...f.config, agent_config: agentConfig }));
  const sent = [], warnings = [];
  const api = { notifyStart: async () => {}, notifyStop: async () => {},
    getUpdates: (_cursor, _timeout, signal) => new Promise(resolve => {
      if (signal.aborted) resolve({ msgs: [] });
      else signal.addEventListener('abort', () => resolve({ msgs: [] }), { once: true });
    }), sendText: async (...args) => { sent.push(args); } };
  const ctx = { logger: () => ({ info() {}, error() {}, warn: (...args) => warnings.push(args) }),
    credentials: { resolve: async () => ({ value: JSON.stringify({ token: 'fixture-token', accountId: 'lifecycle-account', baseUrl: 'https://example.invalid' }) }) },
    sessionPersistence: { list: async () => [] } };
  const bridge = new WeixinHarnessBridge(ctx, { cwd: f.directory, approvalTimeoutMs: 100, responseTimeoutMs: 1000,
    maxSeenMessageIds: 100, accessPolicy: 'allowlist', allowFrom: ['user-a'], maxInFlightMessages: 4,
    maxReplyBytes: 4000, maxReplyImages: 0, maxReplyFiles: 0, sendRetries: 0, statePath: join(f.directory, 'cursor.json'),
    credentialRef: 'FIXTURE', proactiveModule: fileURLToPath(new URL('../plugins/proactive/index.mjs', import.meta.url)),
    proactiveConfigPath: configPath }, () => api);
  t.after(() => bridge.stop());
  await bridge.start();
  assert.ok(bridge.proactive); assert.deepEqual(warnings, []);
  clearInterval(bridge.proactive.timer);
  bridge.proactive.now = () => initial;
  await bridge.handleMessage({ ...message(), item_list: [{ type: 1, text_item: { text: '/bot-ping' } }] }, api);
  bridge.proactive.now = () => initial + 11 * MINUTE;
  await bridge.proactive.tick();
  assert.equal(sent.length, 1);
  const engine = bridge.proactive;
  await bridge.stop(); assert.equal(engine.stopped, true);
});
