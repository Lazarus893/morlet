import { saveBot } from '../plugins/agent-hub/bots.mjs';
import { ownerSession } from './owner-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, chmod, lstat, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProactiveEngine } from '../plugins/proactive/engine.mjs';
import { accountKey, failure } from '../plugins/proactive/management.mjs';
import { control, getRuntime, manage, offlineAccounts } from '../plugins/webui/control.mjs';
import { createWebUI, python, qrImage } from '../plugins/webui/server.mjs';
import { WeixinHarnessBridge } from '../vendor/deepseek-harness-weixin/dist/index.js';
import { WeixinControlServer } from '../vendor/deepseek-harness-weixin/dist/chunk-KCZ7FGE3.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const base = JSON.parse(await readFile(join(ROOT, 'config/pa.example.json'), 'utf8'));
const NOW = Date.parse('2026-10-12T10:00:00+08:00');
const offline = async () => { throw failure('OFFLINE'); };
function rawHttp(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method || 'GET', headers: options.headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(options.body);
  });
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-web-'));
  const cfg = structuredClone(base); cfg.im.allow_from = ['fixture-user'];
  const engine = new ProactiveEngine({ config: { ...cfg.proactive, timezone: 'Asia/Shanghai', state_dir: join(root, '.runtime/proactive') }, accountId: 'fixture-account', allowed: id => id === 'fixture-user', now: () => NOW,
    send: async () => assert.fail('Tests must never send'), analyze: async () => '{"changes":[]}', ...overrides });
  await engine.initialize({ startTimer: false });
  await engine.receive({ from_user_id: 'fixture-user', context_token: 'PRIVATE_TEST_TOKEN' }, '/pa add 2026-10-12T11:00+08:00 取外套');
  const settings = { config: cfg, revision: 'config-1', socket: join(root, 'test.sock'), pending: [], capabilities: [], installed: true, runtimeInstalled: true };
  const bridge = Object.assign(Object.create(WeixinHarnessBridge.prototype), { proactive: engine, connected: true, config: { paConfigRevision: 'config-1', paProvider: 'dsh' } });
  const rpc = async (_socket, request) => ({ ok: true, kind: 'pa', data: await bridge.management(request) });
  const helper = async request => { if (request.action === 'read') return structuredClone(settings); throw failure('INVALID_INPUT'); };
  t.after(async () => { if (!engine.stopped) await engine.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, cfg, engine, settings, rpc, helper, bridge, user: () => engine.store.data.users['fixture-user'], task: () => engine.store.data.users['fixture-user'].tasks.find(t => t.kind === 'reminder'), request: extra => ({ account: accountKey('fixture-account'), userId: 'fixture-user', revision: engine.store.data.users['fixture-user'].revision, ...extra }) };
}
async function http(t, options) {
  const app = createWebUI(options); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.shutdown());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const transport = options.publicOrigin ? rawHttp : fetch;
  const hostHeaders = options.publicOrigin ? { Host: new URL(options.publicOrigin).host } : {};
  const home = await ownerSession(options.root, options.publicOrigin || origin); const cookie = home.headers.get('set-cookie').split(';')[0];
  const headers = { ...hostHeaders, Cookie: cookie };
  const snapshot = await transport(origin + '/api/state', { headers }).then(r => r.json());
  assert.equal(snapshot.ok, true);
  const post = async (route, body, replace = {}) => {
    const res = await transport(origin + '/api/' + route, { method: 'POST', headers: { ...headers, Origin: options.publicOrigin || origin, 'Content-Type': 'application/json', 'X-PA-CSRF': snapshot.data.csrf, ...replace }, body: JSON.stringify(body) });
    return { status: res.status, ...(await res.json()) };
  };
  return { app, origin, headers, home, snapshot: snapshot.data, post };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Fixture state did not converge');
}

test('connection recovery stays available while both Nango and remote status hang', async t => {
  const f = await fixture(t), requests = [];
  const upstream = createHttpServer(req => { requests.push(req.url); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`, key = 'PA_TEST_CONNECTION_RECOVERY_KEY', before = process.env[key];
  process.env[key] = 'isolated-test-key';
  let web;
  try {
    await mkdir(join(f.root, '.runtime/connections'), { recursive: true });
    await writeFile(join(f.root, '.runtime/connections/nango.json'), JSON.stringify({ baseUrl, instanceId: 'test-recovery', secretKeyEnv: key, integrations: { github: { integrationId: 'github-read' } }, timeoutMs: 15000 }), { mode: 0o600 });
    await writeFile(join(f.root, '.runtime/remote-test-credentials.json'), JSON.stringify({ cookie: 'fixture=only' }), { mode: 0o600 });
    await writeFile(join(f.root, '.runtime/dsh-remote.json'), JSON.stringify({ version: 1, dedicatedClient: true, baseUrl, credentialFile: '.runtime/remote-test-credentials.json', targetDeviceId: 'fixture-device', timeoutMs: 15000 }), { mode: 0o600 });
    web = await http(t, f);
    web.app.connections.cloudBegin({ id: 'github', operation: 'connect', revision: web.app.connections.snapshot().revision });
    const started = performance.now();
    const result = await fetch(web.origin + '/api/connections', { headers: web.headers, signal: AbortSignal.timeout(4000) }).then(response => response.json());
    assert.ok(performance.now() - started < 3000);
    assert.equal(result.ok, true); assert.equal(result.data.items.length, 5);
    assert.equal(result.data.remote.state, 'unavailable'); assert.equal(result.data.remote.configured, true);
    assert.equal(result.data.items.find(item => item.id === 'github').state, 'checking');
    assert.ok(requests.some(path => path.startsWith('/connections?'))); assert.ok(requests.includes('/ds-harness-remote/status'));
    const again = performance.now();
    assert.equal((await fetch(web.origin + '/api/connections', { headers: web.headers }).then(response => response.json())).ok, true);
    assert.ok(performance.now() - again < 1000);
    assert.equal((await fetch(web.origin + '/api/remote-agent')).status, 403);
    assert.equal((await web.post('remote-agent', { operation: 'prompt' }, { 'X-PA-CSRF': 'wrong' })).status, 403);
  } finally {
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await web?.app.shutdown();
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
  }
});
async function managedFixture(t, overrides = {}) {
  const f = await fixture(t); await f.engine.stop();
  let child, clock = 1000, launches = 0; const children = [];
  const live = () => child?.pid && child.exitCode === null && child.signalCode === null;
  const rpc = async () => {
    if (!live()) throw failure('OFFLINE');
    return { ok: true, kind: 'pa', data: { protocol: 1, pid: child.pid, connected: false, provider: 'codex', users: [], account: null } };
  };
  const launch = async () => {
    launches++; child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); children.push(child); return child;
  };
  t.after(async () => { for (const process of children) if (process.exitCode === null && process.signalCode === null) { const exited = once(process, 'exit'); process.kill('SIGKILL'); await exited; } });
  return { ...f, managedRuntime: true, rpc, launch, runtimeSupervisor: { intervalMs: 60000, backoffMs: 100, maxBackoffMs: 800, now: () => clock, verifyHost: async (_root, _settings, runtime) => runtime.pid === child?.pid },
    launches: () => launches, child: () => child, advance: milliseconds => { clock += milliseconds; }, ...overrides };
}
async function inertHost(t, f, { delayed = false } = {}) {
  const root = await realpath(f.root), workspace = join(root, '.runtime/workspace'), directory = join(root, 'node_modules/@deepseek-ai/dsh/lib');
  await mkdir(directory, { recursive: true }); await mkdir(workspace, { recursive: true });
  const socket = `/tmp/xiaoman-${process.getuid()}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}.sock`, marker = join(root, 'fixture-host-ready');
  f.settings.socket = socket; const script = join(directory, 'bin.js');
  await writeFile(script, `const fs=require('node:fs'), net=require('node:net');
const server=net.createServer(client=>{let input='';client.on('data',part=>{input+=part;if(input.includes('\\n'))client.end(JSON.stringify({ok:true,kind:'pa',data:{protocol:1,pid:process.pid,connected:false,provider:'codex',users:[],account:null}})+'\\n');});});
function start(){if(process.env.FIXTURE_READY&&!fs.existsSync(process.env.FIXTURE_READY))return setTimeout(start,5);server.listen(process.env.FIXTURE_CONTROL,()=>fs.chmodSync(process.env.FIXTURE_CONTROL,0o600));}start();
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  let child, launches = 0;
  const launch = async () => {
    launches++; child = spawn(process.execPath, [script, '--profile', 'wx-life', '--no-open', '--port', process.env.XIAOMAN_PORT || '3082'], { cwd: workspace, detached: true, stdio: 'ignore', env: { ...process.env, FIXTURE_CONTROL: socket, FIXTURE_READY: delayed ? marker : '' } }); return child;
  };
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } await rm(socket, { force: true }); });
  return { root, socket, launch, child: () => child, launches: () => launches, ready: () => writeFile(marker, 'ready') };
}

test('two local instances retain independent sessions in a shared browser cookie jar', async t => {
  const first = await http(t, await fixture(t)), second = await http(t, await fixture(t));
  const jar = new Map();
  for (const instance of [first, second]) {
    const cookie = instance.home.headers.get('set-cookie').split(';')[0];
    const at = cookie.indexOf('='); jar.set(cookie.slice(0, at), cookie.slice(at + 1));
  }
  assert.equal(jar.size, 2);
  const cookie = [...jar].map(([name, value]) => name + '=' + value).join('; ');
  for (const instance of [first, second]) {
    assert.equal((await fetch(instance.origin + '/api/state', { headers: { Cookie: cookie } })).status, 200);
  }
  assert.equal((await fetch(first.origin + '/api/state', { headers: { Cookie: second.headers.Cookie } })).status, 403);
  assert.equal((await fetch(second.origin + '/api/state', { headers: { Cookie: first.headers.Cookie } })).status, 403);
});

test('management snapshot redacts tokens and does not alter inbound time, Day 1 or revision', async t => {
  const f = await fixture(t), before = JSON.stringify(f.user());
  const result = await f.bridge.management({ operation: 'snapshot' });
  assert.equal(JSON.stringify(f.user()), before);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TEST_TOKEN'));
  assert.ok(!JSON.stringify(result).includes('contextToken'));
  assert.equal(result.users[0].tasks.length, 1);
  assert.equal(result.account, accountKey('fixture-account'));
});

test('local agent installation requires page CSRF and refuses published servers and forwarded visitors', async t => {
  const f = await fixture(t); let calls = 0;
  const localAgentSetup = async () => { calls++; return { installed: true }; };
  const local = await http(t, { ...f, localAgentSetup });
  assert.equal((await local.post('local-agents', { provider: 'codex' }, { 'X-PA-CSRF': 'wrong' })).status, 403);
  assert.equal((await local.post('local-agents', { provider: 'codex' }, { 'X-Forwarded-For': '192.0.2.1' })).status, 403);
  const result = await local.post('local-agents', { provider: 'codex' });
  assert.equal(result.status, process.platform === 'darwin' ? 200 : 403);
  const before = calls;
  const published = await http(t, { ...f, publicOrigin: 'https://xiaoman.example.invalid', localAgentSetup });
  assert.equal(published.snapshot.localAgentAvailable, false);
  assert.equal((await published.post('local-agents', { provider: 'codex' })).status, 403);
  assert.equal(calls, before);
});

test('live UI mutations share the IM ledger, reject stale revisions and bind the account', async t => {
  const f = await fixture(t), lastInbound = f.user().lastInbound;
  const request = f.request({ operation: 'done', taskId: f.task().id });
  await assert.rejects(manage(f.root, f.settings, { ...request, account: 'f'.repeat(64) }, f.rpc), { code: 'ACCOUNT_CHANGED' });
  await manage(f.root, f.settings, request, f.rpc);
  assert.equal(f.task().status, 'done'); assert.equal(f.user().lastInbound, lastInbound);
  await assert.rejects(manage(f.root, f.settings, request, f.rpc), { code: 'CONFLICT' });
  assert.match(await f.engine.receive({ from_user_id: 'fixture-user', context_token: 'PRIVATE_TEST_TOKEN' }, '/pa'), /暂无|没有|取外套/);
  await manage(f.root, f.settings, f.request({ operation: 'undo', taskId: f.task().id }), f.rpc);
  assert.equal(f.task().status, 'pending');
});

test('uncertain delivery cannot be accidentally replayed by undo; snooze requires explicit new schedule', async t => {
  const f = await fixture(t); f.task().status = 'sending';
  await manage(f.root, f.settings, f.request({ operation: 'done', taskId: f.task().id }), f.rpc);
  await manage(f.root, f.settings, f.request({ operation: 'undo', taskId: f.task().id }), f.rpc);
  assert.equal(f.task().status, 'delivery_unknown');
  f.task().dueAt = NOW + 30 * 60000;
  await assert.rejects(manage(f.root, f.settings, f.request({ operation: 'snooze', taskId: f.task().id, minutes: 60 }), f.rpc), { code: 'PAST_DEADLINE' });
  await manage(f.root, f.settings, f.request({ operation: 'snooze', taskId: f.task().id, minutes: 15 }), f.rpc);
  assert.equal(f.task().status, 'pending'); assert.equal(f.task().notifyAt, NOW + 15 * 60000);
});

test('paused global policy still allows editing preferences but cannot be bypassed', async t => {
  const f = await fixture(t); f.engine.config.enabled = false;
  await manage(f.root, f.settings, f.request({ operation: 'preferences', values: { max_daily: 1 } }), f.rpc);
  assert.equal(f.user().preferences.max_daily, 1);
  await assert.rejects(manage(f.root, f.settings, f.request({ operation: 'preferences', values: { enabled: true } }), f.rpc), { code: 'GLOBAL_DISABLED' });
  const before = JSON.stringify(f.user());
  for (const values of [{ max_daily: 99 }, { quiet_start: '09:00', quiet_end: '09:00' }, { contextToken: 'evil' }, []]) {
    await assert.rejects(manage(f.root, f.settings, f.request({ operation: 'preferences', values }), f.rpc), { code: 'INVALID_INPUT' });
    assert.equal(JSON.stringify(f.user()), before);
  }
});

test('offline editing takes the account lease; IPC timeout never replays a write', async t => {
  const f = await fixture(t), request = f.request({ operation: 'done', taskId: f.task().id });
  await assert.rejects(manage(f.root, f.settings, request, offline), { code: 'LEDGER_BUSY' });
  await assert.rejects(manage(f.root, f.settings, request, async () => { throw failure('CONTROL_TIMEOUT'); }), { code: 'CONTROL_TIMEOUT' });
  assert.equal(f.task().status, 'pending');
  await f.engine.stop();
  await manage(f.root, f.settings, request, offline);
  const accounts = await offlineAccounts(f.root, f.cfg);
  assert.equal(accounts[0].users[0].tasks[0].status, 'done');
  assert.ok(!JSON.stringify(accounts).includes('PRIVATE_TEST_TOKEN'));
  await assert.rejects(manage(f.root, f.settings, { ...request, account: '../escape' }, offline), { code: 'INVALID_INPUT' });
  await assert.rejects(manage(f.root, f.settings, { ...request, userId: 'stranger' }, offline), { code: 'USER_NOT_FOUND' });
});

test('management invalidates an in-flight observer without sending or synthesizing an inbound message', async t => {
  let finish;
  const f = await fixture(t, { analyze: async (_instruction, _prompt, signal) => await new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve('{"changes":[]}'), { once: true }); }) });
  const pending = f.engine.observe('fixture-user', '稍后再想一想');
  for (let i = 0; i < 50 && !finish; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(finish);
  const before = f.user().lastInbound;
  await manage(f.root, f.settings, f.request({ operation: 'preferences', values: { enabled: false } }), f.rpc);
  await pending;
  assert.equal(f.user().preferences.enabled, false); assert.equal(f.user().lastInbound, before);
});

test('real control socket supports management and login completion with private permissions', async t => {
  const f = await fixture(t); let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const server = new WeixinControlServer(f.settings.socket, async () => ({ url: 'https://example.invalid/qr-fixture', reused: false, completion }), { info() {}, warn() {} }, request => f.bridge.management(request));
  await server.start(); t.after(() => server.stop());
  const result = await getRuntime(f.root, f.settings);
  assert.equal(result.state, 'running'); assert.equal(result.users.length, 1);
  const login = await control(f.settings.socket, { command: 'login' });
  const wait = control(f.settings.socket, { command: 'wait-login', loginId: login.loginId });
  complete({ accountId: 'fixture-account', baseUrl: 'https://example.invalid', userId: 'fixture-user' });
  assert.equal((await wait).kind, 'connected');
});

test('control client write failure closes that client and keeps management available', async t => {
  const f = await fixture(t);
  const server = new WeixinControlServer(f.settings.socket, () => assert.fail('No login'), { info() {}, warn() {} }, request => f.bridge.management(request));
  await server.start(); t.after(() => server.stop());
  // Model a peer disconnecting after respond's destroyed check but before write.
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(Object.assign(new Error('peer closed'), { code: 'EPIPE' })); } });
  server.accept(socket);
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.emit('data', JSON.stringify({ command: 'pa', operation: 'snapshot' }) + '\n');
  await closed;
  assert.equal(server.clients.size, 0);
  const result = await getRuntime(f.root, f.settings);
  assert.equal(result.state, 'running');
});

test('HTTP requires same-origin session + CSRF, enforces Host, serves only allowlisted assets', async t => {
  const f = await fixture(t), web = await http(t, { root: f.root, helper: f.helper, rpc: f.rpc });
  const request = f.request({ operation: 'done', taskId: f.task().id });
  assert.equal((await web.post('tasks', request, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await web.post('tasks', request, { 'X-PA-CSRF': 'wrong' })).status, 403);
  assert.equal(await new Promise(resolve => { const req = httpRequest(web.origin + '/api/state', { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); }), 403);
  assert.equal((await web.post('tasks', request, { Cookie: '' })).status, 403);
  assert.equal((await fetch(web.origin + '/api/state')).status, 403);
  assert.equal((await rawHttp(web.origin, { headers: { Host: '10.0.0.8:3083', 'X-Forwarded-Host': new URL(web.origin).host, 'X-Forwarded-Proto': 'http' } })).status, 403);
  assert.equal((await fetch(web.origin + '/.runtime/pa.json', { headers: web.headers })).status, 404);
  assert.equal((await fetch(web.origin + '/%2e%2e/.env', { headers: web.headers })).status, 404);
  const res = await fetch(web.origin + '/'); assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const done = await web.post('tasks', request); assert.equal(done.status, 200); assert.equal(f.task().status, 'done');
  assert.ok(!JSON.stringify(web.snapshot).includes('PRIVATE_TEST_TOKEN'));
  assert.equal(web.snapshot.socket, undefined);
});

test('explicit private origin supports proxy GET/POST and rejects Host, Origin and forwarded-header spoofing', async t => {
  const f = await fixture(t), publicOrigin = 'http://10.0.0.8:3083';
  const web = await http(t, { root: f.root, helper: f.helper, rpc: f.rpc, publicOrigin });
  assert.equal(web.home.status, 200);
  assert.doesNotMatch(web.home.headers.get('set-cookie'), /; Secure/);
  const request = f.request({ operation: 'done', taskId: f.task().id });
  assert.equal((await rawHttp(web.origin, { headers: { Host: 'evil.invalid', 'X-Forwarded-Host': '10.0.0.8:3083', 'X-Forwarded-Proto': 'http' } })).status, 403);
  assert.equal((await rawHttp(web.origin, { headers: { 'X-Forwarded-Host': '10.0.0.8:3083' } })).status, 403);
  assert.equal((await web.post('tasks', request, { Origin: 'https://evil.invalid', 'X-Forwarded-Origin': publicOrigin })).status, 403);
  assert.equal((await web.post('tasks', request, { Origin: web.origin, 'X-Forwarded-Host': '10.0.0.8:3083' })).status, 403);
  assert.equal((await web.post('tasks', request, { Origin: '' })).status, 403);
  assert.equal((await web.post('tasks', request, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await web.post('tasks', request, { 'X-PA-CSRF': 'wrong' })).status, 403);
  assert.equal((await web.post('tasks', request)).status, 200);
  assert.equal(f.task().status, 'done');
});

test('HTTPS published origin sets Secure cookie while preserving loopback-only listener', async t => {
  const f = await fixture(t), publicOrigin = 'https://journal.internal.example';
  const web = await http(t, { root: f.root, helper: f.helper, rpc: f.rpc, publicOrigin });
  assert.match(web.home.headers.get('set-cookie'), /; Secure/);
  assert.equal(web.app.server.address().address, '127.0.0.1');
  assert.equal((await web.post('tasks', f.request({ operation: 'done', taskId: f.task().id }))).status, 200);
});

test('invalid public origins fail before the server or journal is created; invalid environment fails startup', async () => {
  for (const publicOrigin of ['', null, 12, 'ftp://10.0.0.8', 'http://user:password@10.0.0.8', 'http://10.0.0.8/path', 'http://10.0.0.8/', 'http://10.0.0.8?x=1', 'http://10.0.0.8#x', 'http://bad_host:3083', 'http://-bad.example', 'http://10.0.0.8:99999', 'http://10.0.0.8:3083\n']) {
    assert.throws(() => createWebUI({ root: '/unused', publicOrigin }), /Public origin/);
  }
  const child = spawn(process.execPath, [join(ROOT, 'scripts/webui.mjs')], { env: { ...process.env, PA_WEB_ORIGIN: 'http://bad_host:3083' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 2); assert.match(output, /PA_WEB_ORIGIN/);
});

test('QR is locally generated; exact login result controls success, not the previous connected account', async t => {
  const f = await fixture(t); let complete;
  const rpc = async (socket, request) => {
    if (request.command === 'login') return { ok: true, kind: 'qr', url: 'https://example.invalid/fixture-only', loginId: 'id' };
    if (request.command === 'wait-login') return new Promise(resolve => { complete = resolve; });
    return f.rpc(socket, request);
  };
  const web = await http(t, { root: f.root, helper: f.helper, rpc });
  assert.equal((await web.post('login', {})).ok, true);
  assert.equal((await web.app.state()).login.state, 'waiting');
  assert.match((await web.app.state()).login.qr, /^data:image\/svg\+xml;base64,/);
  complete({ ok: true, kind: 'connected' }); await new Promise(r => setImmediate(r));
  assert.deepEqual((await web.app.state()).login, { state: 'connected' });
  assert.throws(() => qrImage('javascript:alert(1)'));
});

test('supervisor only stops its own child and reports startup failures', async t => {
  const f = await fixture(t); await f.engine.stop();
  const web = await http(t, { root: f.root, helper: f.helper, rpc: offline,
    launch: async () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }) });
  assert.equal((await web.post('stop', {})).error, 'NOT_OWNED');
  assert.equal((await web.post('start', {})).ok, true);
  assert.equal((await web.post('start', {})).error, 'ALREADY_RUNNING');
  assert.equal((await web.app.state()).runtime.owned, true);
  assert.equal((await web.post('stop', {})).ok, true);
  assert.equal((await web.app.state()).runtime.owned, false);
});

test('managed Web starts its own host after listening and restores crashes with exponential backoff', async t => {
  const f = await managedFixture(t), web = await http(t, f);
  await until(() => f.launches() === 1); await web.app.monitor(); await web.app.monitor();
  let state = await web.app.state();
  assert.equal(state.service.managed, true); assert.equal(state.runtime.managed, true);
  assert.equal(state.service.instanceId, createHash('sha256').update(await realpath(f.root)).digest('hex').slice(0, 20));
  assert.equal(state.service.desired, 'running'); assert.equal(state.service.health, 'running');
  assert.equal(state.runtime.connected, false, 'host availability is not WeChat or model availability');
  let exited = once(f.child(), 'exit'); f.child().kill('SIGKILL'); await exited;
  state = await web.app.state(); assert.equal(state.service.health, 'backoff'); assert.equal(state.service.error, 'RUNTIME_EXITED'); assert.equal(state.service.retryAt, 1100);
  await web.app.monitor(); assert.equal(f.launches(), 1);
  f.advance(100); await web.app.monitor(); assert.equal(f.launches(), 2); await web.app.monitor();
  exited = once(f.child(), 'exit'); f.child().kill('SIGKILL'); await exited;
  state = await web.app.state(); assert.equal(state.service.failures, 2); assert.equal(state.service.retryAt, 1300);
  f.advance(199); await web.app.monitor(); assert.equal(f.launches(), 2);
  f.advance(1); await web.app.monitor(); assert.equal(f.launches(), 3);
  assert.equal((await web.post('stop', {})).ok, true);
  const path = join(f.root, '.runtime/web-service.json');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, desired: 'stopped' }); assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test('starting hosts accept explicit intent without duplication and expose an unready control timeout', async t => {
  const f = await managedFixture(t); f.rpc = offline; f.runtimeSupervisor.startupTimeoutMs = 50;
  const web = await http(t, f); await until(() => f.launches() === 1); await web.app.monitor();
  const started = await web.post('start', {}); assert.equal(started.ok, true); assert.equal(started.data.starting, true); assert.equal(f.launches(), 1);
  f.advance(49); await web.app.monitor(); assert.equal((await web.app.state()).service.health, 'starting');
  f.advance(1); await web.app.monitor();
  const state = await web.app.state(); assert.equal(state.service.health, 'backoff'); assert.equal(state.service.error, 'RUNTIME_START_TIMEOUT'); assert.equal(state.runtime.state, 'offline');
  f.advance(100); await web.app.monitor(); assert.equal(f.launches(), 1, 'a live but unready child must not be duplicated');
  assert.equal((await web.post('stop', {})).ok, true);
});

test('missing runtime dependencies and launch failures remain visible and rate limited', async t => {
  const missing = await managedFixture(t); missing.settings.runtimeInstalled = false;
  const first = await http(t, missing); await first.app.monitor(); assert.equal(missing.launches(), 0); assert.equal((await first.app.state()).service.error, 'DEPENDENCIES_MISSING');
  let attempts = 0; const failed = await managedFixture(t);
  const second = await http(t, { ...failed, launch: async () => { attempts++; throw failure('RUNTIME_START_FAILED'); } });
  await until(() => attempts === 1); await second.app.monitor(); assert.equal(attempts, 1); assert.equal((await second.app.state()).service.error, 'RUNTIME_START_FAILED');
  failed.advance(100); await second.app.monitor(); assert.equal(attempts, 2);
  assert.equal((await second.post('stop', {})).ok, true);
});

test('manual pause survives Web restart and explicit start restores the intent without duplicate hosts', async t => {
  const f = await managedFixture(t), first = await http(t, f); await until(() => f.launches() === 1); await first.app.monitor();
  assert.equal((await first.post('stop', {})).ok, true); await first.app.shutdown();
  const second = await http(t, f); await second.app.monitor();
  assert.equal(f.launches(), 1); assert.equal((await second.app.state()).service.health, 'paused');
  assert.equal((await second.post('start', {})).ok, true); assert.equal(f.launches(), 2);
  assert.equal((await second.post('start', {})).ok, true); assert.equal(f.launches(), 2);
  assert.equal(JSON.parse(await readFile(join(f.root, '.runtime/web-service.json'), 'utf8')).desired, 'running');
  assert.equal((await second.post('stop', {})).ok, true);
});

test('managed Web restart adopts a verified live host rather than launching another', async t => {
  const f = await managedFixture(t), first = await http(t, f); await until(() => f.launches() === 1);
  const pid = f.child().pid; await first.app.shutdown();
  const second = await http(t, f); await second.app.monitor();
  const state = await second.app.state(); assert.equal(f.launches(), 1); assert.equal(state.runtime.pid, pid); assert.equal(state.runtime.adopted, true); assert.equal(state.service.health, 'running');
  assert.equal((await second.post('stop', {})).ok, true); await until(() => f.child().signalCode !== null);
});

test('an adopted host crash also waits for backoff before replacement', async t => {
  const f = await managedFixture(t), first = await http(t, f); await until(() => f.launches() === 1); await first.app.shutdown();
  const second = await http(t, f); await second.app.monitor();
  const exited = once(f.child(), 'exit'); f.child().kill('SIGKILL'); await exited;
  await second.app.monitor(); assert.equal(f.launches(), 1); assert.equal((await second.app.state()).service.error, 'RUNTIME_EXITED');
  f.advance(99); await second.app.monitor(); assert.equal(f.launches(), 1);
  f.advance(1); await second.app.monitor(); assert.equal(f.launches(), 2);
  assert.equal((await second.post('stop', {})).ok, true);
});

test('an adopted but still-living host with an unavailable socket is not duplicated', async t => {
  const f = await managedFixture(t); let reachable = true; const rpc = async (...args) => { if (!reachable) throw failure('OFFLINE'); return f.rpc(...args); };
  const first = await http(t, { ...f, rpc }); await until(() => f.launches() === 1); await first.app.shutdown();
  const second = await http(t, { ...f, rpc }); await second.app.monitor();
  assert.equal((await second.app.state()).runtime.adopted, true);
  reachable = false; await second.app.monitor();
  assert.equal((await second.app.state()).service.error, 'RUNTIME_CONTROL_UNAVAILABLE');
  f.advance(1000); await second.app.monitor(); assert.equal(f.launches(), 1); assert.equal(f.child().exitCode, null);
});

test('default adoption proves an inert fixture host by private socket, exact argv, uid and workspace', async t => {
  const f = await fixture(t); await f.engine.stop();
  const host = await inertHost(t, f), child = await host.launch();
  await until(async () => { try { return (await control(host.socket, { command: 'pa', operation: 'snapshot' })).data.pid === child.pid; } catch { return false; } });
  const web = await http(t, { ...f, rpc: control, managedRuntime: true, launch: async () => assert.fail('Verified existing host must be adopted'), runtimeSupervisor: { intervalMs: 60000 } });
  await web.app.monitor(); await until(async () => (await web.app.state()).service.health === 'running');
  assert.equal((await web.app.state()).runtime.adopted, true);
  assert.equal((await web.post('stop', {})).ok, true); await until(() => child.exitCode === 0);
  assert.equal((await web.app.state()).runtime.state, 'offline');
});

test('Web restart during actual host startup recovers its private PID without duplicating the host', async t => {
  const f = await fixture(t); await f.engine.stop(); const host = await inertHost(t, f, { delayed: true });
  const options = { ...f, rpc: control, managedRuntime: true, launch: host.launch, runtimeSupervisor: { intervalMs: 60000, backoffMs: 1 } };
  const first = await http(t, options); await until(() => host.launches() === 1); await first.app.shutdown();
  const path = join(f.root, '.runtime/web-host.json'), record = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(record, { version: 1, pid: host.child().pid }); assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const second = await http(t, options); await until(async () => (await second.app.state()).service.error === 'RUNTIME_CONTROL_UNAVAILABLE');
  assert.equal(host.launches(), 1); assert.equal(host.child().exitCode, null);
  await host.ready(); await until(async () => { try { return (await control(host.socket, { command: 'pa', operation: 'snapshot' })).data.pid === record.pid; } catch { return false; } });
  await second.app.monitor(); assert.equal(host.launches(), 1); assert.equal((await second.app.state()).runtime.adopted, true);
  assert.equal((await second.post('stop', {})).ok, true);
});

test('a recorded starting host can be stopped before its control socket exists', async t => {
  const f = await fixture(t); await f.engine.stop(); const host = await inertHost(t, f, { delayed: true });
  const options = { ...f, rpc: control, managedRuntime: true, launch: host.launch, runtimeSupervisor: { intervalMs: 60000 } };
  const first = await http(t, options); await until(() => host.launches() === 1); await first.app.shutdown();
  const second = await http(t, { ...options, controlOnly: true });
  await second.app.monitor(); const state = await second.app.state();
  assert.equal(state.service.controlOnly, true); assert.equal(state.service.managed, true); assert.equal(state.runtime.managed, true);
  assert.equal(host.launches(), 1); assert.equal(host.child().exitCode, null);
  assert.equal((await second.post('start', {})).error, 'RUNTIME_CONTROL_ONLY');
  await assert.rejects(readFile(join(f.root, '.runtime/web-service.json')), error => error.code === 'ENOENT');
  assert.equal((await second.post('stop', {})).ok, true); await until(() => host.child().exitCode === 0);
  assert.equal(host.launches(), 1); assert.equal(JSON.parse(await readFile(join(f.root, '.runtime/web-service.json'), 'utf8')).desired, 'stopped');
});

test('a control-only manager never starts a fresh business host', async t => {
  const f = await managedFixture(t), web = await http(t, { ...f, controlOnly: true });
  await web.app.monitor(); assert.equal(f.launches(), 0); assert.equal((await web.app.state()).service.controlOnly, true);
  assert.equal((await web.post('start', {})).error, 'RUNTIME_CONTROL_ONLY'); assert.equal(f.launches(), 0);
  assert.equal((await web.post('stop', {})).ok, true); assert.equal(f.launches(), 0);
});

test('an unsafe host record fails closed and cannot authorize signalling an unrelated process', async t => {
  const f = await managedFixture(t), path = join(f.root, '.runtime/web-host.json');
  await writeFile(path, JSON.stringify({ version: 1, pid: process.pid }), { mode: 0o600 });
  const web = await http(t, f); await until(async () => (await web.app.state()).service.error === 'HOST_NOT_VERIFIED');
  assert.equal(f.launches(), 0); assert.equal((await web.post('stop', {})).error, 'HOST_NOT_VERIFIED');
  await writeFile(path, '{invalid'); assert.equal((await web.post('start', {})).error, 'HOST_RECORD_INVALID'); assert.equal(f.launches(), 0);
  await writeFile(path, JSON.stringify({ version: 1, pid: process.pid })); await chmod(path, 0o644);
  assert.equal((await web.post('start', {})).error, 'HOST_RECORD_INVALID'); assert.equal(f.launches(), 0);
});

test('monitor and explicit lifecycle actions share one exclusive operation', async t => {
  let release, entered; const waiting = new Promise(resolve => { entered = resolve; });
  const f = await managedFixture(t), original = f.launch;
  f.launch = async () => { entered(); await new Promise(resolve => { release = resolve; }); return original(); };
  const web = await http(t, f); await waiting;
  assert.equal((await web.post('start', {})).error, 'BUSY'); assert.equal((await web.post('stop', {})).error, 'BUSY');
  const pending = web.app.monitor(); assert.equal(f.launches(), 0);
  release(); await pending; await until(() => f.launches() === 1); await web.app.monitor();
  assert.equal(f.launches(), 1); assert.equal((await web.post('stop', {})).ok, true);
});

test('invalid runtime intent fails closed, is visible and can be explicitly repaired without launching automatically', async t => {
  const f = await managedFixture(t), path = join(f.root, '.runtime/web-service.json');
  await writeFile(path, '{invalid', { mode: 0o600 });
  const web = await http(t, f); await web.app.monitor();
  let state = await web.app.state(); assert.equal(state.service.desired, 'unknown'); assert.equal(state.service.health, 'blocked'); assert.equal(state.service.error, 'RUNTIME_INTENT_INVALID'); assert.equal(f.launches(), 0);
  assert.equal((await web.post('start', {})).ok, true); assert.equal(f.launches(), 1); assert.equal((await web.post('stop', {})).ok, true);
  await chmod(path, 0o644); await web.app.monitor(); assert.equal((await web.app.state()).service.error, 'RUNTIME_INTENT_INVALID');
  assert.equal((await web.post('start', {})).error, 'RUNTIME_INTENT_INVALID'); assert.equal(f.launches(), 1);
  await chmod(path, 0o600); await rm(path); const elsewhere = join(f.root, 'external-intent'); await writeFile(elsewhere, '{"version":1,"desired":"running"}', { mode: 0o600 }); await symlink(elsewhere, path);
  await web.app.monitor(); assert.equal((await web.post('start', {})).error, 'RUNTIME_INTENT_INVALID'); assert.equal(f.launches(), 1);
  assert.equal(await readFile(elsewhere, 'utf8'), '{"version":1,"desired":"running"}');
});

test('unknown or unverified runtime is never duplicated or signalled and manual stop is persisted first', async t => {
  const f = await managedFixture(t), unverified = async () => ({ ok: true, kind: 'pa', data: { protocol: 1, pid: process.pid, connected: false, users: [] } });
  const { verifyHost, ...policy } = f.runtimeSupervisor;
  const web = await http(t, { ...f, rpc: unverified, runtimeSupervisor: policy });
  await web.app.monitor(); assert.equal(f.launches(), 0);
  assert.equal((await web.post('stop', {})).error, 'HOST_NOT_VERIFIED');
  assert.equal(JSON.parse(await readFile(join(f.root, '.runtime/web-service.json'), 'utf8')).desired, 'stopped');
  f.advance(10000); await web.app.monitor(); assert.equal(f.launches(), 0);
  const unknown = await http(t, { ...await managedFixture(t), rpc: async () => { throw failure('CONTROL_TIMEOUT'); } });
  await unknown.app.monitor(); assert.equal((await unknown.app.state()).service.error, 'RUNTIME_UNAVAILABLE'); assert.equal((await unknown.app.state()).runtime.state, 'unavailable');
});

test('real Python helper persists config optimistically and applies a matching runtime revision', async t => {
  const f = await fixture(t); await f.engine.stop();
  for (const directory of ['bin', 'scripts', 'config', 'home', 'phone-refs', 'agents']) await cp(join(ROOT, directory), join(f.root, directory), { recursive: true });
  await mkdir(join(f.root, 'skills/phone/references/apps'), { recursive: true });
  await writeFile(join(f.root, '.runtime/pa.json'), JSON.stringify(f.cfg));
  const web = await http(t, { root: f.root, rpc: offline });
  const result = await web.post('config', { revision: web.snapshot.revision, patch: { owner: '测试用户', agent: { provider: 'codex' }, persona: { prefix: '实例自己的角色' }, proactive: { max_daily: 1 } } });
  assert.equal(result.ok, true); assert.equal(result.data.config.owner, '测试用户');
  assert.equal((await web.post('config', { revision: web.snapshot.revision, patch: { owner: '丢失更新' } })).error, 'CONFLICT');
  assert.equal((await web.post('config', { revision: result.data.revision, patch: { credentials: 'never' } })).error, 'INVALID_INPUT');
  const applied = await web.post('apply', { revision: result.data.revision }); assert.equal(applied.ok, true);
  const patch = JSON.parse(await readFile(join(f.root, '.runtime/dsh/profiles/wx-life/cordis.patch.yml'), 'utf8'));
  assert.equal(patch.find(p => p.id === 'weixin-channel').config.paConfigRevision, result.data.revision);
  assert.equal(patch.find(p => p.id === 'system-prompt').config.personaPrefix, '实例自己的角色');
  assert.equal((await python(f.root, { action: 'device' })).state, 'disabled');
});

test('Agent bridge HTTP authentication stays separate, and local reminder tools share the existing Web/Weixin ledger', async t => {
  const { agentTransport } = await import('../plugins/agent-hub/companion.mjs');
  const f = await fixture(t), web = await http(t, f);
  const paired = await web.post('hub', { operation: 'pair', label: 'Test local Codex', provider: 'codex' }); assert.equal(paired.ok, true);
  const conversation = (await web.post('hub', { operation: 'new', endpointId: paired.data.endpointId })).data;
  assert.equal((await web.post('hub', { operation: 'bind', channel: 'weixin', account: accountKey('other'), peer: 'fixture-user', conversationId: conversation.id })).status, 403);
  assert.equal((await web.post('hub', { operation: 'bind', channel: 'weixin', account: accountKey('fixture-account'), peer: 'fixture-user', conversationId: conversation.id })).ok, true);
  await web.post('hub', { operation: 'send', conversationId: conversation.id, content: 'Manage my reminders', requestId: 'http-test' });
  const bridge = agentTransport({ endpoint: web.origin, publicOrigin: web.origin, token: paired.data.token });
  const { job } = await bridge('poll', { runnerId: 'http-runner' });
  const healthInput = { runId: job.id, lease: job.lease, tool: 'xiaoman_status', callId: 'health', arguments: {} };
  const health = await bridge('tool', healthInput);
  assert.deepEqual(health.channels.map(c => c.id), ['web', 'weixin', 'imessage']);
  assert.equal(JSON.stringify(health).includes('PRIVATE_TEST_TOKEN'), false);
  await assert.rejects(bridge('tool', { ...healthInput, lease: 'wrong' }), { code: 'FORBIDDEN' });
  await assert.rejects(bridge('tool', { ...healthInput, tool: 'constructor' }));
  const tool = args => bridge('tool', { runId: job.id, lease: job.lease, tool: 'xiaoman_reminders', callId: args.operation + (args.taskId || ''), arguments: args });
  const before = await tool({ operation: 'list' }); assert.equal(before.tasks[0].id, f.task().id);
  const saved = await tool({ operation: 'done', revision: before.revision, taskId: f.task().id }); assert.equal(saved.saved, true);
  assert.equal(f.task().status, 'done');
  const again = await tool({ operation: 'done', revision: before.revision, taskId: f.task().id }); assert.deepEqual(again, saved, 'retry returns receipt without mutating twice');
  const snapshot = await tool({ operation: 'list' }); assert.equal(snapshot.tasks[0].status, 'done');
  const unauthorized = await fetch(web.origin + '/api/hub', { headers: { 'X-PA-Agent-Token': paired.data.token } }); assert.equal(unauthorized.status, 403);
  const wrong = agentTransport({ endpoint: web.origin, publicOrigin: web.origin, token: 'wrong-token' }); await assert.rejects(wrong('poll', { runnerId: 'bad' }), { code: 'BRIDGE_UNAUTHORIZED' });
  const state = await fetch(web.origin + '/api/hub', { headers: web.headers }).then(r => r.json());
  assert.equal(JSON.stringify(state).includes(paired.data.token), false); assert.equal(JSON.stringify(state).includes('PRIVATE_TEST_TOKEN'), false);
});

test('bound Weixin dispatch persists to the Hub instead of executing the cloud/native conversation manager', async t => {
  const { createWeixinHub } = await import('../plugins/agent-hub/channel.mjs');
  const f = await fixture(t), web = await http(t, f);
  const paired = web.app.hub.pair({ label: 'Local' }), c = web.app.hub.newConversation({ endpointId: paired.endpointId });
  saveBot(web.app.hub, { id: 'xiaoman', version: 1, values: { endpointId: paired.endpointId } });
  web.app.hub.bind({ channel: 'weixin', account: accountKey('fixture-account'), peer: 'fixture-user', conversationId: c.id });
  const adapter = createWeixinHub({ root: f.root, accountId: 'fixture-account', allowed: id => id === 'fixture-user', send: async () => assert.fail('No external send in tests'), receiveLegacy: input => f.engine.receive({ from_user_id: input.peer, context_token: 'fixture' }, input.text) });
  t.after(() => adapter.close());
  const bridge = Object.assign(Object.create(WeixinHarnessBridge.prototype), { hub: adapter, config: { accessPolicy: 'allowlist', allowFrom: ['fixture-user'] }, requireConversations: () => assert.fail('Cloud/native agent must not execute') });
  const message = { from_user_id: 'fixture-user', message_id: 'hub-message', item_list: [{ type: 1, text_item: { text: 'Continue from Weixin' } }] };
  await bridge.dispatch(message, {}); await bridge.dispatch(message, {});
  assert.equal(web.app.hub.all('run').length, 1); assert.equal(web.app.hub.all('message')[0].text, 'Continue from Weixin');
  assert.equal(f.user().contextToken, 'fixture');
});

test('iMessage HTTP ingress is scoped to its configured peer and isolated from Agent and Web credentials', async t => {
  const { messageTransport } = await import('../plugins/agent-hub/imessage.mjs');
  const { agentTransport } = await import('../plugins/agent-hub/companion.mjs');
  const f = await fixture(t), web = await http(t, f), hub = web.app.hub;
  const paired = hub.pair({ label: 'Local' }), c = hub.newConversation({ endpointId: paired.endpointId });
  saveBot(hub, { id: 'xiaoman', version: 1, values: { endpointId: paired.endpointId } });
  const channel = await web.post('hub', { operation: 'pair-channel', label: 'Messages', peer: 'owner@example.invalid', botAddress: 'bot@example.invalid', conversationId: c.id });
  assert.equal(channel.ok, true);
  const transport = messageTransport({ endpoint: web.origin, token: channel.data.token });
  const health = { ready: true, botAddress: 'bot@example.invalid', peer: 'owner@example.invalid', lastInboundAt: 0, pendingInputs: 0 };
  assert.equal((await transport('poll', {})).delivery, null);
  await transport('status', health);
  await assert.rejects(transport('status', { ...health, botAddress: 'wrong@example.invalid' }), { code: 'INVALID_INPUT' });
  const inbound = { peer: 'owner@example.invalid', requestId: 'native-guid', text: 'Continue from Messages' };
  assert.equal((await transport('inbound', inbound)).accepted, true);
  assert.equal((await transport('inbound', inbound)).accepted, true);
  await assert.rejects(transport('inbound', { ...inbound, peer: 'stranger@example.invalid' }), { code: 'INVALID_INPUT' });
  const run = hub.poll(paired.token, { runnerId: 'local' }).job;
  assert.equal(hub.all('run').length, 1);
  hub.event(paired.token, { runId: run.id, lease: run.lease, seq: 1, type: 'completed', value: 'A private reply' });
  const { delivery } = await transport('poll', {});
  assert.equal(delivery.peer, inbound.peer);
  assert.equal(delivery.text, 'A private reply');
  assert.equal((await transport('poll', {})).delivery, null);
  await transport('ack', { deliveryId: delivery.id, state: 'submitted' });
  assert.equal(hub.snapshot().deliveries[0].state, 'submitted');
  await transport('ack', { deliveryId: delivery.id, state: 'read' });
  await transport('ack', { deliveryId: delivery.id, state: 'unknown' });
  assert.equal(hub.snapshot().deliveries[0].state, 'read', 'late acknowledgements cannot downgrade proof');
  await transport('status', { ...health, ready: false, error: 'IMESSAGE_CHAT_ACCESS_REQUIRED' });
  assert.equal(hub.snapshot().channels[0].online, false);
  assert.equal(hub.snapshot().channels[0].connected, true);
  const wrongAgent = agentTransport({ endpoint: web.origin, token: channel.data.token });
  await assert.rejects(wrongAgent('poll', { runnerId: 'wrong' }), { code: 'BRIDGE_UNAUTHORIZED' });
  const wrongChannel = messageTransport({ endpoint: web.origin, token: paired.token });
  await assert.rejects(wrongChannel('poll', {}), { code: 'BRIDGE_UNAUTHORIZED' });
  assert.equal((await fetch(web.origin + '/api/hub', { headers: { 'X-PA-Channel-Token': channel.data.token } })).status, 403);
  await web.post('hub', { operation: 'revoke-channel', channelId: channel.data.channelId });
  await assert.rejects(transport('poll', {}), { code: 'BRIDGE_UNAUTHORIZED' });
  assert.equal(hub.snapshot().messages[0].channel, 'imessage');
});
