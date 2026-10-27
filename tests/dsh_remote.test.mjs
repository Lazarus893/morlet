import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import { DshRemoteClient, loadDshRemoteConfig, saveDshRemoteTarget, validateDshRemoteConfig, unavailableDshRemoteStatus } from '../plugins/agent-hub/remote/index.mjs';

const target = 'host-test';
const state = () => ({ available: true, connected: true, mode: 'remote', backend: 'harness',
  connectedTargetDeviceId: target, transport: 'Relay', remoteFeatures: { remoteGateway: true, fileViewer: true, codex: true, pi: true } });

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xiaoman-remote-'));
  const credentialFile = join(dir, 'auth.json');
  await writeFile(credentialFile, JSON.stringify(options.credentials || { cookie: 'dsh_session=test-private' }), { mode: 0o600 });
  const calls = [], sockets = new Set();
  const remote = { status: state(), handlers: {}, frames: options.frames };
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      calls.push({ path: req.url, method: 'GET' });
      res.writeHead(302, { location: '/', 'set-cookie': 'dsh_session=test-private; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push({ path: req.url, body, cookie: req.headers.cookie, origin: req.headers.origin });
    if (req.headers.cookie !== 'dsh_session=test-private') { res.writeHead(401); res.end(); return; }
    const custom = remote.handlers[req.url];
    if (custom) { await custom(req, res, body); return; }
    const method = body.method;
    let value;
    if (method === 'status') value = remote.status;
    else if (method === 'devices') value = [{ deviceId: target, name: 'Test host', online: true, accessToken: 'never-expose', harnessVersion: '0.2.1-rc.1' }];
    else if (method === 'mode.set') { remote.status.mode = body.payload.mode; remote.status.connected = body.payload.mode === 'remote'; value = remote.status; }
    else if (method.endsWith('workspaces.list')) value = [{ workspaceId: 'workspace-a', path: '/workspace', title: 'Workspace' }];
    else if (method.endsWith('workspace.open')) value = { ...remote.status, workspace: { id: 'workspace-a' } };
    else if (method === 'session/list') value = { items: [] };
    else if (method === 'session/prompt') value = { accepted: true };
    else value = { accepted: true };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  const wss = new WebSocketServer({ server, path: '/api/remote.mux' });
  wss.on('connection', (socket, req) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    assert.equal(req.headers.cookie, 'dsh_session=test-private');
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      calls.push({ ws: message });
      if (message.type === 'open') {
        remote.lastSocket = socket; remote.lastStream = message.streamId;
        for (const value of (Array.isArray(remote.frames) ? remote.frames : remote.frames?.[message.endpoint]) || []) socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value }));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = { version: 1, baseUrl: `http://127.0.0.1:${server.address().port}`, credentialFile,
    targetDeviceId: target, dedicatedClient: true, allowSessionControl: true, timeoutMs: 500 };
  const client = new DshRemoteClient({ ...config, ...options.config });
  t.after(async () => { client.close(); for (const socket of sockets) socket.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { client, config, dir, calls, remote };
}

test('configuration is private, local/tunneled or HTTPS, explicit dedicated Client Host', async t => {
  const { config, dir } = await fixture(t);
  await mkdir(join(dir, '.runtime'));
  const path = join(dir, '.runtime/dsh-remote.json');
  assert.equal(loadDshRemoteConfig(dir), null);
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.equal(loadDshRemoteConfig(dir).targetDeviceId, target);
  await chmod(path, 0o644);
  assert.throws(() => loadDshRemoteConfig(dir), { code: 'DSH_REMOTE_PRIVATE_FILE_REQUIRED' });
  for (const patch of [{ baseUrl: 'http://example.com' }, { baseUrl: 'https://user:secret@example.com' }, { baseUrl: 'https://example.com/path' }, { dedicatedClient: false }, { arbitraryEndpoint: true }]) assert.throws(() => validateDshRemoteConfig({ ...config, ...patch }));
  assert.equal(unavailableDshRemoteStatus().capabilities.taskExecution, false);
});

test('symlink credential files are refused and credential values never appear in snapshot', async t => {
  const { config, dir } = await fixture(t);
  const link = join(dir, 'link.json'); await symlink(config.credentialFile, link);
  const client = new DshRemoteClient({ ...config, credentialFile: link }); t.after(() => client.close());
  const result = await client.snapshot();
  assert.equal(result.code, 'DSH_REMOTE_PRIVATE_FILE_REQUIRED');
  assert.ok(!JSON.stringify(result).includes('test-private'));
  assert.ok(!JSON.stringify(client).includes('test-private'));
});

test('unselected host permits inventory only and target persistence retains private configuration', async t => {
  const { client, config, dir, calls } = await fixture(t, { config: { targetDeviceId: undefined } });
  assert.equal((await client.snapshot()).code, 'DSH_REMOTE_HOST_NOT_SELECTED');
  assert.equal((await client.devices()).length, 1);
  await assert.rejects(client.connect({ targetDeviceId: target }), { code: 'DSH_REMOTE_HOST_NOT_SELECTED' });
  await assert.rejects(client.sessions(), { code: 'DSH_REMOTE_HOST_NOT_SELECTED' });
  await mkdir(join(dir, '.runtime'));
  await writeFile(join(dir, '.runtime/dsh-remote.json'), JSON.stringify({ ...config, targetDeviceId: undefined }), { mode: 0o600 });
  assert.deepEqual(saveDshRemoteTarget(dir, target), { targetDeviceId: target });
  assert.equal(loadDshRemoteConfig(dir).targetDeviceId, target);
  assert.equal(calls.filter(call => call.path?.startsWith('/api/')).length, 0);
});

test('launch token exchanges only at root without following redirects or exposing credentials', async t => {
  const { client, calls } = await fixture(t, { credentials: { launchToken: 'private-launch' } });
  const result = await client.snapshot();
  assert.equal(result.connected, true);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/?token=private-launch');
  assert.equal(calls[1].cookie, 'dsh_session=test-private');
  assert.ok(!JSON.stringify(result).includes('private-launch'));
});

test('device inventory and negotiated backend capabilities remain sanitized and truthful', async t => {
  const { client } = await fixture(t);
  assert.deepEqual(await client.devices(), [{ deviceId: target, name: 'Test host', online: true, harnessVersion: '0.2.1-rc.1' }]);
  const result = await client.snapshot();
  assert.deepEqual(result.capabilities.backends, ['harness', 'codex', 'pi']);
  assert.equal(result.capabilities.taskExecution, false);
  assert.equal(result.capabilities.businessTools, false);
  assert.equal(result.capabilities.prompt, true);
  assert.ok(!JSON.stringify(result).includes('credentialFile'));
});

test('connect pins configured target, backend browsing uses upstream control endpoints', async t => {
  const { client, calls } = await fixture(t);
  await assert.rejects(client.connect({ targetDeviceId: 'other-host' }), { code: 'DSH_REMOTE_TARGET_NOT_ALLOWED' });
  await client.connect();
  await client.workspaces({ backend: 'pi' });
  await client.openWorkspace({ backend: 'pi', workspaceId: 'pi-workspace' });
  await assert.rejects(client.workspaces({ backend: 'cursor' }), { code: 'DSH_REMOTE_BACKEND_UNSUPPORTED' });
  assert.ok(calls.some(call => call.path === '/ds-harness-remote/pi.workspaces.list'));
  assert.ok(calls.some(call => call.path === '/ds-harness-remote/pi.workspace.open' && call.body.payload.targetDeviceId === target));
});

test('native reads and session mutations use exact upstream Typert argument names', async t => {
  const { client, calls } = await fixture(t);
  await client.sessions({});
  await client.createSession({ cwd: '/workspace' });
  await client.prompt({ sessionId: 'session-a', requestId: 'request-a', mode: 'queue', content: [{ type: 'text', text: 'Read the file' }] });
  await client.cancel({ sessionId: 'session-a' });
  for (const call of calls.filter(call => call.path?.startsWith('/api/'))) {
    const descriptor = TYPERT_REMOTE.descriptors.find(d => `${d.namespace}/${d.method}` === call.body.method);
    assert.ok(descriptor, call.body.method);
    for (const param of descriptor.parameters) assert.equal(param.codec.schema.safeParse(call.body.payload.args[param.wire]).success, true, `${call.body.method}:${param.wire}`);
  }
  assert.deepEqual(calls.find(call => call.path === '/api/session/list').body.payload, { args: { _request: {} } });
});

test('missing controls and unsupported business-tool execution fail before prompt', async t => {
  const { client, calls } = await fixture(t, { config: { allowSessionControl: false } });
  await assert.rejects(client.cancel({ sessionId: 'session-a' }), { code: 'DSH_REMOTE_SESSION_CONTROL_DISABLED' });
  await assert.rejects(client.run({}, 'Do work', { tools: [{ name: 'xiaoman_report' }] }), { code: 'DSH_REMOTE_BUSINESS_TOOLS_UNAVAILABLE' });
  assert.equal(calls.filter(call => call.path?.startsWith('/api/')).length, 0);
});

test('another client changing target blocks subsequent reads and mutations', async t => {
  const { client, remote, calls } = await fixture(t);
  remote.status.connectedTargetDeviceId = 'different-host';
  await assert.rejects(client.sessions(), { code: 'DSH_REMOTE_NOT_CONNECTED' });
  await assert.rejects(client.cancel({ sessionId: 'session-a' }), { code: 'DSH_REMOTE_NOT_CONNECTED' });
  assert.equal(calls.filter(call => call.path?.startsWith('/api/')).length, 0);
});

test('lost mutation receipt is uncertain and never retried', async t => {
  const { client, remote, calls } = await fixture(t);
  remote.handlers['/api/session/prompt'] = (req) => req.socket.destroy();
  const request = { sessionId: 'session-a', requestId: 'request-a', mode: 'queue', content: [{ type: 'text', text: 'task' }] };
  await assert.rejects(client.prompt(request), error => error.code === 'DSH_REMOTE_OUTCOME_UNKNOWN' && error.uncertain);
  assert.equal(calls.filter(call => call.path === '/api/session/prompt').length, 1);
});

test('RPC correlation mismatch and redirects cannot become successful mutations', async t => {
  const { client, remote } = await fixture(t);
  remote.handlers['/api/session/cancel'] = (_req, res) => res.end(JSON.stringify({ type: 'server-response', rpcId: 'stale', result: { ok: true, value: {} } }));
  await assert.rejects(client.cancel({ sessionId: 'session-a' }), { code: 'DSH_REMOTE_OUTCOME_UNKNOWN' });
  remote.handlers['/api/session/cancel'] = (_req, res) => { res.writeHead(302, { location: 'https://example.com/steal' }); res.end(); };
  await assert.rejects(client.cancel({ sessionId: 'session-a' }), { code: 'DSH_REMOTE_OUTCOME_UNKNOWN' });
});

test('native stream delivers incremental frames and cancellation closes logical stream', async t => {
  const { client, calls } = await fixture(t, { frames: [{ type: 'baseline', value: { throughSeq: 4 } }, { type: 'entries', entries: [{ seq: 5 }] }] });
  const stream = client.stream('session/follow', { request: { address: { kind: 'session', sessionId: 'session-a' } } });
  assert.equal((await stream.next()).value.type, 'baseline');
  assert.equal((await stream.next()).value.type, 'entries');
  await stream.return();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(call => call.ws?.endpoint === 'session/follow'));
});

test('approvals are bound to observed generation and session, only allow once or reject', async t => {
  const { client, calls } = await fixture(t, { frames: { '$events': [
    { type: 'ready', clientId: 'client-generation-a', host: { home: '/host' } },
    { type: 'waterfall', event: 'approval/request', eventId: 'approval-a', agentId: 'session-a', request: { toolName: 'bash', callId: 'call-a', reason: 'Read file' } },
  ], 'session/follow': [{ type: 'snapshot', header: { id: 'session-a' }, cursor: 3, records: [
    { type: 'event', event: { type: 'tool/call', seq: 3, time: 1, data: { turn: 1, step: 1, callId: 'call-a', name: 'bash', arguments: '{"command":"cat file"}' } } },
  ] }] } });
  const stream = client.stream('$events');
  await stream.next(); const frame = (await stream.next()).value;
  await assert.rejects(client.respondApproval(frame.approvalHandle, 'always', { sessionId: 'session-a' }), { code: 'DSH_REMOTE_APPROVAL_NOT_ALLOWED' });
  await assert.rejects(client.respondApproval(frame.approvalHandle, 'allowed-once', { sessionId: 'other' }), { code: 'DSH_REMOTE_APPROVAL_EXPIRED' });
  await assert.rejects(client.respondApproval(frame.approvalHandle, 'allowed-once', { sessionId: 'session-a' }), { code: 'DSH_REMOTE_APPROVAL_DETAILS_UNAVAILABLE' });
  const follow = client.stream('session/follow', { request: { address: { kind: 'session', sessionId: 'session-a' } } });
  await follow.next();
  await client.respondApproval(frame.approvalHandle, 'allowed-once', { sessionId: 'session-a' });
  await assert.rejects(client.respondApproval(frame.approvalHandle, 'allowed-once', { sessionId: 'session-a' }), { code: 'DSH_REMOTE_APPROVAL_EXPIRED' });
  const answer = calls.find(call => call.path === '/api/$events/result');
  assert.deepEqual(answer.body.payload.args, { clientId: 'client-generation-a', eventId: 'approval-a', outcome: { kind: 'result', value: 'allowed-once' } });
  await stream.return(); await follow.return();
});

test('missing, mismatched or truncated durable tool details cannot authorize; rejection remains available', async t => {
  const { client, calls } = await fixture(t, { frames: { '$events': [
    { type: 'ready', clientId: 'generation' },
    { type: 'waterfall', event: 'approval/request', eventId: 'approval-a', agentId: 'session-a', request: { toolName: 'bash', callId: 'call-a' } },
  ], 'session/follow': [{ type: 'snapshot', header: { id: 'session-a' }, records: [
    { type: 'event', event: { type: 'tool/call', seq: 3, data: { callId: 'call-a', name: 'bash', arguments: '{"command":"partial"}', argumentsTruncated: true } } },
  ] }] } });
  const follow = client.stream('session/follow', { request: { address: { kind: 'session', sessionId: 'session-a' } } }); await follow.next();
  const stream = client.stream('$events'); await stream.next(); const frame = (await stream.next()).value;
  await assert.rejects(client.respondApproval(frame.approvalHandle, 'allowed-once', { sessionId: 'session-a' }), { code: 'DSH_REMOTE_APPROVAL_DETAILS_UNAVAILABLE' });
  await client.respondApproval(frame.approvalHandle, 'rejected', { sessionId: 'session-a' });
  assert.equal(calls.find(call => call.path === '/api/$events/result').body.payload.args.outcome.value, 'rejected');
  await follow.return(); await stream.return();
});

test('disconnect immediately expires approvals and cannot falsely finish stream', async t => {
  const { client, remote } = await fixture(t, { frames: [
    { type: 'ready', clientId: 'generation', host: { home: '/host' } },
    { type: 'waterfall', event: 'approval/request', eventId: 'approval-a', agentId: 'session-a', request: {} },
  ] });
  const stream = client.stream('$events'); await stream.next(); const frame = (await stream.next()).value;
  remote.lastSocket.terminate();
  await assert.rejects(stream.next(), { code: 'DSH_REMOTE_STREAM_LOST' });
  await assert.rejects(client.respondApproval(frame.approvalHandle, 'allowed-once', { sessionId: 'session-a' }), { code: 'DSH_REMOTE_APPROVAL_EXPIRED' });
});

test('stream methods and file operations are fixed allowlists', async t => {
  const { client } = await fixture(t);
  await assert.rejects(client.stream('terminal/attach').next(), { code: 'DSH_REMOTE_METHOD_NOT_ALLOWED' });
  await assert.rejects(client.files('write', { path: '/file' }), { code: 'DSH_REMOTE_METHOD_NOT_ALLOWED' });
  assert.deepEqual(await client.files('stat', { path: '/file' }), { accepted: true });
});
