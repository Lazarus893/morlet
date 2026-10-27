import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRemoteControl } from '../plugins/webui/remote-control.mjs';

const responseFixture = () => Object.assign(new EventEmitter(), { writableLength: 0, rows: [], writeHead(code) { this.statusCode = code; }, flushHeaders() {}, write(data) { this.rows.push(data); }, end() { this.ended = true; } });

test('owner controller exposes fixed operations and never retries an uncertain mutation', async () => {
  let calls = 0;
  const control = createRemoteControl({ client: { prompt: async () => { calls++; throw Object.assign(Error(), { code: 'DSH_REMOTE_OUTCOME_UNKNOWN' }); } } });
  for (const operation of ['constructor', 'close', 'stream', 'run', 'terminal']) await assert.rejects(control.mutate({ operation }), { code: 'INVALID_OPERATION' });
  await assert.rejects(control.mutate({ operation: 'prompt', request: { signal: {} } }), { code: 'INVALID_REQUEST' });
  await assert.rejects(control.mutate({ operation: 'prompt', request: { sessionId: 'session' } }), { code: 'DSH_REMOTE_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
});

test('native approval uses the saved handle and matching session, with one-shot decision vocabulary', async () => {
  let observed;
  const control = createRemoteControl({ client: { respondApproval: async (...args) => { observed = args; return { accepted: true }; } } });
  await control.mutate({ operation: 'approval', request: { handle: 'native-handle', decision: 'allowed-once', sessionId: 'session' } });
  assert.deepEqual(observed, ['native-handle', 'allowed-once', { sessionId: 'session' }]);
});

test('SSE uses native session address and stops both streams when browser disconnects', async () => {
  const calls = [], stopped = [], response = Object.assign(new EventEmitter(), { writableLength: 0, rows: [], writeHead(code) { this.statusCode = code; }, flushHeaders() {}, write(data) { this.rows.push(data); }, end() { this.ended = true; } });
  const client = { snapshot: async () => ({ connected: true }), async *stream(endpoint, args, { signal }) {
    calls.push({ endpoint, args });
    try {
      yield endpoint === '$events' ? { type: 'waterfall', event: 'approval/request', agentId: 'another-session' } : { type: 'snapshot', cursor: 7, records: [] };
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } finally { stopped.push(endpoint); }
  } };
  const control = createRemoteControl({ client });
  const task = control.events(response, 'session');
  while (calls.length < 2 || !response.rows.length) await new Promise(resolve => setImmediate(resolve));
  response.emit('close'); await task;
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.find(c => c.endpoint === 'session/follow').args, { request: { address: { kind: 'session', sessionId: 'session' }, maxMessages: 20 } });
  assert.doesNotMatch(response.rows.join(''), /another-session/);
  assert.deepEqual(stopped.sort(), ['$events', 'session/follow']); assert.equal(response.ended, true);
});

test('display snapshot has a short budget and caches failure without trusting it for mutations', async () => {
  let clock = 0, reads = 0, writes = 0, current = 'hang', released;
  const client = { snapshot: async () => { reads++; return current === 'hang' ? new Promise(resolve => { released = resolve; }) : { connected: true, configured: true, state: 'connected' }; }, prompt: async () => { writes++; throw Object.assign(Error(), { code: 'DSH_REMOTE_NOT_CONNECTED' }); }, close() {} };
  const control = createRemoteControl({ client, now: () => clock, snapshotTimeoutMs: 20, snapshotCacheMs: 100 });
  const start = performance.now(), value = await control.snapshot();
  assert.equal(value.state, 'unavailable'); assert.equal(value.configured, true); assert.ok(performance.now() - start < 300);
  assert.equal((await control.snapshot()).state, 'unavailable'); assert.equal(reads, 1);
  current = 'ready'; clock = 101; assert.equal((await control.snapshot()).connected, true);
  released({ connected: false, state: 'stale' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await control.snapshot()).state, 'connected');
  await assert.rejects(control.mutate({ operation: 'prompt', request: { sessionId: 's' } }), { code: 'DSH_REMOTE_NOT_CONNECTED' }); assert.equal(writes, 1);
  control.close();
});

test('SSE closed while its fresh snapshot is pending never opens either native stream', async () => {
  let calls = 0, snapshotSignal;
  const client = { snapshot: ({ signal }) => { snapshotSignal = signal; return new Promise(() => {}); }, async *stream() { calls++; }, close() {} };
  const control = createRemoteControl({ client }), response = responseFixture();
  const task = control.events(response, 's'); response.emit('close'); await task;
  assert.equal(calls, 0); assert.equal(snapshotSignal.aborted, true); assert.equal(response.listenerCount('close'), 0);
  control.close();
});

test('SSE reserves slots before awaiting snapshots and releases all reservations on close', async () => {
  const client = { snapshot: () => new Promise(() => {}), async *stream() { assert.fail('closed snapshots must not subscribe'); }, close() {} };
  const control = createRemoteControl({ client }), responses = Array.from({ length: 8 }, responseFixture);
  const tasks = responses.map(response => control.events(response, 's'));
  await assert.rejects(control.events(responseFixture(), 's'), { code: 'DSH_REMOTE_TOO_MANY_STREAMS' });
  for (const response of responses) response.emit('close'); await Promise.all(tasks);
  const retry = responseFixture(), next = control.events(retry, 's'); retry.emit('close'); await next;
  control.close();
});

test('SSE releases its slot when native snapshot or response startup fails', async () => {
  const client = { snapshot: async () => ({ connected: false }), close() {} }, control = createRemoteControl({ client });
  for (let index = 0; index < 10; index++) {
    const response = responseFixture();
    await assert.rejects(control.events(response, 's'), { code: 'DSH_REMOTE_NOT_CONNECTED' });
    assert.equal(response.listenerCount('close'), 0); assert.equal(response.ended, undefined);
  }
  client.snapshot = async () => ({ connected: true });
  for (let index = 0; index < 10; index++) {
    const response = responseFixture(); response.writeHead = () => { throw Error('fixture response closed'); };
    await assert.rejects(control.events(response, 's'), /fixture response closed/); assert.equal(response.listenerCount('close'), 0);
  }
  control.close();
});

test('disconnect aborts pending SSE snapshots and fences concurrent target changes', async () => {
  let release, streams = 0;
  const client = { snapshot: () => new Promise(() => {}), disconnect: () => new Promise(resolve => { release = resolve; }), async *stream() { streams++; }, close() {} };
  const control = createRemoteControl({ client }), response = responseFixture(), events = control.events(response, 's');
  const disconnect = control.mutate({ operation: 'disconnect' });
  await assert.rejects(control.mutate({ operation: 'connect', request: { targetDeviceId: 'another' } }), { code: 'DSH_REMOTE_BUSY' });
  assert.equal((await control.snapshot()).code, 'DSH_REMOTE_BUSY');
  await events; release({ configured: true, connected: false, state: 'disconnected' }); await disconnect;
  assert.equal((await control.snapshot()).state, 'disconnected'); assert.equal(streams, 0);
  control.close();
});

test('a running native RPC fences all target and workspace changes without closing existing streams', async () => {
  const released = Promise.withResolvers(), started = Promise.withResolvers();
  let switches = 0, streamCount = 0, stopped = 0;
  const client = { snapshot: async () => ({ connected: true }), createSession: () => { started.resolve(); return released.promise; },
    connect: async () => { switches++; return { connected: true }; }, disconnect: async () => { switches++; return { connected: false }; }, openWorkspace: async () => { switches++; }, close() {},
    async *stream(_endpoint, _args, { signal }) {
      streamCount++;
      try { yield { type: 'ready' }; if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
      finally { stopped++; }
    } };
  const control = createRemoteControl({ client }), response = responseFixture(), events = control.events(response, 's');
  while (streamCount < 2) await new Promise(resolve => setImmediate(resolve));
  const operation = control.mutate({ operation: 'createSession', request: { cwd: '/original' } }); await started.promise;
  for (const name of ['connect', 'disconnect', 'openWorkspace']) await assert.rejects(control.mutate({ operation: name }), { code: 'DSH_REMOTE_BUSY' });
  assert.equal(switches, 0); assert.equal(stopped, 0); assert.equal(response.ended, undefined);
  released.resolve({ sessionId: 'original-session' }); await operation;
  await control.mutate({ operation: 'disconnect' }); await events;
  assert.equal(switches, 1); assert.equal(stopped, 2);
  control.close();
});

test('operation accounting survives concurrent success and failure until every original request settles', async () => {
  const read = Promise.withResolvers(), write = Promise.withResolvers();
  let switches = 0;
  const control = createRemoteControl({ client: { sessions: () => read.promise, prompt: () => write.promise,
    connect: async () => { switches++; return { connected: true }; }, close() {} } });
  const first = control.mutate({ operation: 'sessions' }), second = control.mutate({ operation: 'prompt' });
  read.resolve({ items: [] }); await first;
  await assert.rejects(control.mutate({ operation: 'connect' }), { code: 'DSH_REMOTE_BUSY' });
  write.reject(Object.assign(new Error('lost receipt'), { code: 'DSH_REMOTE_OUTCOME_UNKNOWN' }));
  await assert.rejects(second, { code: 'DSH_REMOTE_OUTCOME_UNKNOWN' });
  await control.mutate({ operation: 'connect' }); assert.equal(switches, 1);
  control.close();
});

test('workspace switching aborts old SSE and excludes operations until failure settles, then allows recovery', async () => {
  const released = Promise.withResolvers(); let snapshots = 0, prompts = 0, streams = 0;
  const client = { snapshot: async () => { snapshots++; return { connected: true, state: 'connected' }; },
    openWorkspace: () => released.promise, prompt: async () => { prompts++; return { accepted: true }; }, close() {},
    async *stream(_endpoint, _args, { signal }) { streams++; yield { type: 'ready' }; if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } };
  const control = createRemoteControl({ client }), response = responseFixture(), events = control.events(response, 's');
  while (streams < 2) await new Promise(resolve => setImmediate(resolve));
  await control.snapshot();
  const change = control.mutate({ operation: 'openWorkspace', request: { path: '/next' } }); await events;
  assert.equal(response.ended, true);
  await assert.rejects(control.mutate({ operation: 'prompt' }), { code: 'DSH_REMOTE_BUSY' });
  await assert.rejects(control.events(responseFixture(), 's'), { code: 'DSH_REMOTE_BUSY' });
  assert.equal((await control.snapshot()).code, 'DSH_REMOTE_BUSY');
  released.reject(Object.assign(new Error('workspace rejected'), { code: 'DSH_REMOTE_REQUEST_FAILED' }));
  await assert.rejects(change, { code: 'DSH_REMOTE_REQUEST_FAILED' });
  const readsBefore = snapshots; assert.equal((await control.snapshot()).connected, true); assert.equal(snapshots, readsBefore + 1);
  await control.mutate({ operation: 'prompt' }); assert.equal(prompts, 1);
  control.close();
});
