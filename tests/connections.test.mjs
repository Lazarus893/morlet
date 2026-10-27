import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectionManager } from '../plugins/connections/manager.mjs';

test('deployment provisions only public X client metadata; ordinary account settings cannot accept application keys', t => {
  const root = mkdtempSync(join(tmpdir(), 'connection-public-app-'));
  const manager = createConnectionManager({ root, env: { PA_X_CLIENT_ID: 'deployment_public_client', PA_X_CLIENT_SECRET: 'NEVER_FORWARD' } });
  t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
  const { token } = manager.mutate({ operation: 'pair', revision: 0, values: { name: 'fixture' } });
  const bridge = manager.bridgeSnapshot(token);
  assert.deepEqual(bridge.desired.find(row => row.id === 'x').oauthApp, { clientId: 'deployment_public_client', redirectUri: 'http://127.0.0.1:3094/oauth/x/callback' });
  assert.doesNotMatch(JSON.stringify(bridge), /NEVER_FORWARD|clientSecret/);
  assert.throws(() => manager.mutate({ operation: 'settings', id: 'x', revision: 1, values: {} }), { code: 'INVALID_REQUEST' });
  assert.throws(() => manager.mutate({ operation: 'connect', id: 'x', revision: 1, values: { clientId: 'user_input' } }), { code: 'INVALID_REQUEST' });
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pa-connections-'));
  let timestamp = Date.parse('2026-10-12T10:00:00Z');
  let manager = createConnectionManager({ root, now: () => timestamp });
  t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, get manager() { return manager; }, advance: value => { timestamp += value; },
    mutate: (operation, id, values = {}) => manager.mutate({ operation, id, values, revision: manager.snapshot().revision }),
    restart: () => { manager.close(); manager = createConnectionManager({ root, now: () => timestamp }); } };
}
const item = (manager, id) => manager.snapshot().items.find(item => item.id === id);
test('OAuth URLs support Google and X without device codes and reject nonofficial or credential URLs', t => {
  const f = fixture(t), { token } = f.mutate('pair', null, { name: 'Mac' });
  for (const id of ['google', 'x']) {
    f.mutate('connect', id, id === 'google' ? { account: 'test@example.com' } : {});
    const verificationUrl = id === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&response_type=code&state=fixture' : 'https://x.com/i/oauth2/authorize?response_type=code&client_id=fixture&state=fixture&code_challenge=fixture&code_challenge_method=S256';
    const auth = { verificationUrl, expiresAt: '2026-10-12T10:03:00.000Z' };
    report(f.manager, token, id, { state: 'awaiting_authorization', code: 'auth_pending', auth });
    assert.equal(item(f.manager, id).auth.verificationUrl, verificationUrl);
    assert.equal(item(f.manager, id).auth.code, undefined);
    for (const url of ['https://evil.invalid/', verificationUrl + '&client_secret=PRIVATE']) assert.throws(() => report(f.manager, token, id, { state: 'awaiting_authorization', code: 'auth_pending', auth: { ...auth, verificationUrl: url } }), { code: 'INVALID_REQUEST' });
  }
});

test('selected file grant is distinct from opening full disk settings and preserves a queued request', t => {
  const f = fixture(t), { token } = f.mutate('pair', null, { name: 'Mac' });
  f.mutate('grant', 'files', { scope: 'selected-files' });
  assert.equal(f.manager.bridgeSnapshot(token).desired.find(row => row.id === 'files').scope, 'selected-files');
  assert.match(item(f.manager, 'files').scopeDescription, /选择的文件/);
  f.mutate('settings', 'files');
  assert.equal(f.manager.bridgeSnapshot(token).commands[0].kind, 'settings');
  f.mutate('check', 'files'); assert.equal(f.manager.bridgeSnapshot(token).commands[0].kind, 'settings');
  assert.throws(() => f.mutate('settings', 'github'), { code: 'INVALID_REQUEST' });
  assert.ok(!item(f.manager, 'files').permissions.some(row => row.verified));
});

test('phone settings is an explicit empty request and checks cannot cancel native authorization', t => {
  const f = fixture(t), { token } = f.mutate('pair', null, { name: 'Mac' });
  f.manager.reportBridge(token, { reports: [] });
  f.mutate('settings', 'phone');
  const before = f.manager.bridgeSnapshot(token);
  assert.equal(before.commands[0].kind, 'settings'); assert.deepEqual(before.commands[0].values, {});
  f.mutate('check', 'phone');
  assert.deepEqual(f.manager.bridgeSnapshot(token).commands, before.commands);
  assert.throws(() => f.mutate('settings', 'phone', { recording: true }), { code: 'INVALID_REQUEST' });
  report(f.manager, token, 'phone', { state: 'limited', code: 'phone_recording_required', permissions: [{ id: 'paired', granted: true, verified: true }, { id: 'device', granted: true, verified: true }, { id: 'automation', granted: true, verified: true }, { id: 'recording', granted: false, verified: false }] });
  const phone = item(f.manager, 'phone');
  assert.match(phone.message, /在手机确认录屏授权/);
  assert.equal(phone.permissions.find(row => row.id === 'automation').verified, true);
  assert.equal(phone.permissions.find(row => row.id === 'recording').verified, false);
});

test('default folder request declares readonly common scope without fabricating system consent', t => {
  const f = fixture(t), { token } = f.mutate('pair', null, { name: 'Mac' });
  f.manager.reportBridge(token, { reports: [] });
  f.mutate('grant', 'files', { scope: 'common-folders' });
  const command = f.manager.bridgeSnapshot(token).commands[0];
  assert.deepEqual(command.values, { scope: 'common-folders', readOnly: true });
  assert.equal(item(f.manager, 'files').state, 'checking');
  assert.match(item(f.manager, 'files').scopeDescription, /下载、用户目录、文档/);
  assert.ok(!item(f.manager, 'files').permissions.some(row => row.granted || row.verified));
});
test('refresh preserves queued authorization and its generation until the Mac receives it', t => {
  const f = fixture(t), { token } = f.mutate('pair', null, { name: 'Mac' });
  f.manager.reportBridge(token, { reports: [] });
  f.mutate('connect', 'github');
  const before = f.manager.bridgeSnapshot(token);
  f.mutate('check', 'github');
  const after = f.manager.bridgeSnapshot(token);
  assert.deepEqual(after.commands, before.commands);
  assert.deepEqual(after.desired, before.desired);
});

test('refresh retains an active OAuth code and accepts the original authorization result', t => {
  const f = fixture(t), { token } = f.mutate('pair', null, { name: 'Mac' });
  f.mutate('connect', 'github');
  const before = f.manager.bridgeSnapshot(token), generation = before.desired.find(row => row.id === 'github').generation;
  const auth = { verificationUrl: 'https://github.com/login/device', code: 'ABCD-1234', expiresAt: '2026-10-12T10:03:00.000Z' };
  f.manager.reportBridge(token, { ack: before.commands.map(row => row.commandId), reports: [{ id: 'github', generation, state: 'awaiting_authorization', code: 'auth_pending', auth }] });
  f.mutate('check', 'github');
  assert.equal(item(f.manager, 'github').state, 'awaiting_authorization');
  assert.deepEqual(item(f.manager, 'github').auth, auth);
  assert.equal(f.manager.bridgeSnapshot(token).desired.find(row => row.id === 'github').generation, generation);
  f.manager.reportBridge(token, { reports: [{ id: 'github', generation, state: 'limited', code: 'partial', permissions: [{ id: 'profile', granted: true, verified: true }] }] });
  assert.equal(item(f.manager, 'github').state, 'limited');
  assert.equal(item(f.manager, 'github').auth, undefined);
});
function report(manager, token, id, options = {}) {
  const desired = manager.bridgeSnapshot(token).desired.find(item => item.id === id);
  return manager.reportBridge(token, { reports: [{ id, generation: desired.generation, state: 'connected', code: 'ok', permissions: [{ id: id === 'google' ? 'gmail' : id === 'github' ? 'profile' : id === 'x' ? 'read' : id === 'files' ? 'readable' : 'device', granted: true, verified: true }], ...options }] });
}

test('five entries begin unlinked, CAS rejects stale writes, files grant is explicitly readonly', t => {
  const f = fixture(t);
  assert.deepEqual(f.manager.snapshot().items.map(item => item.id), ['google', 'files', 'phone', 'github', 'x']);
  assert.ok(f.manager.snapshot().items.every(item => item.state === 'unlinked'));
  const { token, snapshot } = f.mutate('pair', null, { name: '当前 Mac' });
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.bridge.paired, true);
  assert.throws(() => f.manager.mutate({ operation: 'connect', id: 'github', revision: 0 }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => f.mutate('connect', 'files'), { code: 'INVALID_REQUEST' });
  assert.throws(() => f.mutate('grant', 'files', { scope: '/' }), { code: 'INVALID_REQUEST' });
  f.mutate('grant', 'files', { scope: 'all-readable-files' });
  assert.deepEqual(f.manager.bridgeSnapshot(token).commands[0].values, { scope: 'all-readable-files', readOnly: true });
  assert.equal(item(f.manager, 'files').state, 'offline');
  report(f.manager, token, 'files');
  assert.equal(item(f.manager, 'files').state, 'connected');
  assert.equal(f.manager.snapshot().revision, 2);
});

test('normal heartbeats do not change user CAS revision, stale Mac becomes offline', t => {
  const f = fixture(t);
  const { token } = f.mutate('pair', null, { name: '当前 Mac' });
  f.mutate('connect', 'github');
  const revision = f.manager.snapshot().revision;
  report(f.manager, token, 'github', { account: 'tony' });
  assert.equal(item(f.manager, 'github').state, 'connected');
  assert.equal(item(f.manager, 'github').account, 'tony');
  assert.equal(f.manager.snapshot().revision, revision);
  const lastSuccess = item(f.manager, 'github').lastSuccessAt;
  f.advance(90_001);
  assert.equal(f.manager.snapshot().bridge.online, false);
  assert.equal(item(f.manager, 'github').state, 'offline');
  assert.ok(item(f.manager, 'github').permissions.every(permission => !permission.verified));
  assert.equal(item(f.manager, 'github').lastSuccessAt, lastSuccess);
  assert.equal(f.manager.snapshot().revision, revision);
  report(f.manager, token, 'github');
  assert.equal(item(f.manager, 'github').state, 'connected');
});

test('background timer monitors even when no snapshot is being read', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pa-connections-timer-'));
  let timestamp = Date.now();
  const manager = createConnectionManager({ root, now: () => timestamp, intervalMs: 10 });
  t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
  const { token } = manager.mutate({ operation: 'pair', revision: 0, values: { name: 'Mac' } });
  manager.mutate({ operation: 'connect', id: 'github', revision: 1 });
  report(manager, token, 'github');
  timestamp += 90_001;
  await new Promise(resolve => setTimeout(resolve, 30));
  // Read SQLite without calling a manager snapshot, so the timer itself is exercised.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(root, '.runtime/connections/state.sqlite'));
  const persisted = JSON.parse(db.prepare('SELECT data FROM connections WHERE id=1').get().data);
  db.close();
  assert.equal(persisted.items.find(item => item.id === 'github').state, 'offline');
});

test('an online Mac heartbeat cannot keep stale individual permissions marked verified', t => {
  const f = fixture(t);
  const { token } = f.mutate('pair', null, { name: 'Mac' });
  f.mutate('connect', 'github');
  report(f.manager, token, 'github');
  f.advance(90_001);
  f.manager.reportBridge(token, { reports: [] });
  assert.equal(f.manager.snapshot().bridge.online, true);
  assert.equal(item(f.manager, 'github').state, 'offline');
  assert.ok(item(f.manager, 'github').permissions.every(permission => !permission.verified));
});

test('withdrawn permission and prior generation cannot be revived by delayed reports', t => {
  const f = fixture(t);
  const { token } = f.mutate('pair', null, { name: 'Mac' });
  f.mutate('connect', 'github');
  const generation = f.manager.bridgeSnapshot(token).desired.find(item => item.id === 'github').generation;
  report(f.manager, token, 'github');
  f.mutate('disconnect', 'github');
  f.manager.reportBridge(token, { reports: [{ id: 'github', generation, state: 'connected', code: 'ok', permissions: [{ id: 'repos', granted: true, verified: true }] }] });
  assert.equal(item(f.manager, 'github').state, 'revoked');
  assert.ok(item(f.manager, 'github').permissions.every(permission => !permission.granted));
  f.mutate('connect', 'github');
  f.manager.reportBridge(token, { reports: [{ id: 'github', generation, state: 'connected', code: 'ok' }] });
  assert.notEqual(item(f.manager, 'github').state, 'connected');
});

test('new pairing invalidates old token, reports, and commands; unpair also invalidates token', t => {
  const f = fixture(t);
  const first = f.mutate('pair', null, { name: 'Mac one' });
  f.mutate('connect', 'x');
  report(f.manager, first.token, 'x');
  const oldCommand = f.manager.bridgeSnapshot(first.token).commands[0];
  const second = f.mutate('pair', null, { name: 'Mac two' });
  assert.throws(() => f.manager.bridgeSnapshot(first.token), { code: 'BRIDGE_UNAUTHORIZED' });
  assert.throws(() => report(f.manager, first.token, 'x'), { code: 'BRIDGE_UNAUTHORIZED' });
  assert.equal(item(f.manager, 'x').state, 'offline');
  assert.ok(item(f.manager, 'x').permissions.every(permission => !permission.verified));
  assert.ok(f.manager.bridgeSnapshot(second.token).commands.every(command => command.commandId !== oldCommand.commandId));
  f.mutate('unpair');
  assert.throws(() => f.manager.reportBridge(second.token, { reports: [] }), { code: 'BRIDGE_UNAUTHORIZED' });
});

test('restart preserves desired grants but never assumes an old verified connection', t => {
  const f = fixture(t);
  const { token } = f.mutate('pair', null, { name: 'Mac' });
  f.mutate('connect', 'github');
  report(f.manager, token, 'github');
  const generation = f.manager.bridgeSnapshot(token).desired.find(item => item.id === 'github').generation;
  f.restart();
  assert.equal(f.manager.snapshot().bridge.online, false);
  assert.equal(item(f.manager, 'github').state, 'offline');
  const pending = f.manager.bridgeSnapshot(token);
  assert.equal(pending.desired.find(item => item.id === 'github').enabled, true);
  assert.ok(pending.desired.find(item => item.id === 'github').generation > generation);
  assert.equal(pending.commands[0].kind, 'check');
});

test('authorization links have strict provider origins, expires and removes device codes', t => {
  const f = fixture(t);
  const { token } = f.mutate('pair', null, { name: 'Mac' });
  f.mutate('connect', 'github');
  const auth = { verificationUrl: 'https://github.com/login/device', code: 'ABCD-1234', expiresAt: '2026-10-12T10:05:00Z' };
  report(f.manager, token, 'github', { state: 'awaiting_authorization', code: 'auth_pending', auth });
  assert.deepEqual(item(f.manager, 'github').auth, { ...auth, expiresAt: '2026-10-12T10:05:00.000Z' });
  for (const verificationUrl of ['https://evil.test/login/device', 'http://github.com/login/device', 'https://github.com/login/device?access_token=secret', 'https://github.com@evil.test/login/device']) {
    assert.throws(() => report(f.manager, token, 'github', { state: 'awaiting_authorization', code: 'auth_pending', auth: { ...auth, verificationUrl } }), { code: 'INVALID_REQUEST' });
  }
  f.advance(300_001);
  assert.equal(item(f.manager, 'github').state, 'expired');
  assert.ok(item(f.manager, 'github').permissions.every(permission => !permission.verified));
  assert.equal(item(f.manager, 'github').auth, undefined);
});

test('Google account identity mismatch cannot satisfy requested authorization', t => {
  const f = fixture(t);
  const { token } = f.mutate('pair', null, { name: 'Mac' });
  assert.throws(() => f.mutate('connect', 'google'), { code: 'INVALID_REQUEST' });
  f.mutate('connect', 'google', { account: 'owner@example.com' });
  report(f.manager, token, 'google', { account: 'other@example.com' });
  assert.equal(item(f.manager, 'google').state, 'limited');
  assert.equal(item(f.manager, 'google').account, 'owner@example.com');
});

test('unknown raw errors and token-bearing payloads are rejected without advancing heartbeat', t => {
  const f = fixture(t);
  const { token } = f.mutate('pair', null, { name: 'Mac' });
  f.mutate('connect', 'github');
  const desired = f.manager.bridgeSnapshot(token).desired.find(item => item.id === 'github');
  const reportBase = { id: 'github', generation: desired.generation, state: 'error', code: 'probe_failed' };
  for (const reportValue of [{ ...reportBase, message: 'SECRET_CLI_ERROR' }, { ...reportBase, code: 'SECRET_CLI_ERROR' }, { ...reportBase, token: 'SECRET' }, { ...reportBase, permissions: [{ id: 'token', label: 'SECRET', granted: true, verified: true }] }]) {
    assert.throws(() => f.manager.reportBridge(token, { reports: [reportValue] }), { code: 'INVALID_REQUEST' });
  }
  assert.equal(f.manager.snapshot().bridge.lastSeenAt, null);
  assert.throws(() => f.manager.reportBridge('0'.repeat(64), { reports: [reportBase] }), { code: 'BRIDGE_UNAUTHORIZED' });
  assert.equal(f.manager.snapshot().bridge.lastSeenAt, null);
  report(f.manager, token, 'github', { state: 'error', code: 'probe_failed', permissions: [{ id: 'profile', label: 'SECRET_LABEL', granted: false, verified: false }] });
  assert.ok(!JSON.stringify(f.manager.snapshot()).includes('SECRET'));
});

test('SQLite stores only hashed pairing secret, permission labels are canonical and files private', t => {
  const f = fixture(t);
  const { token } = f.mutate('pair', null, { name: 'Mac' });
  f.mutate('connect', 'github');
  report(f.manager, token, 'github', { permissions: [{ id: 'profile', label: 'unsafe CLI output', granted: true, verified: true }] });
  assert.equal(item(f.manager, 'github').permissions[0].label, '账号身份');
  assert.ok(!JSON.stringify(f.manager.snapshot()).includes(token));
  f.manager.close();
  const dbPath = join(f.root, '.runtime/connections/state.sqlite');
  assert.ok(!readFileSync(dbPath).includes(Buffer.from(token)));
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.root, '.runtime/connections')).mode & 0o777, 0o700);
});
