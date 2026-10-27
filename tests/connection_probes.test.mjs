import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalProbes, parseGoogleAccounts, runCLI } from '../plugins/connections/local-probes.mjs';
import { ConnectionCompanion, loadCompanionConfig, createBridgeTransport } from '../scripts/connection-companion.mjs';
import { createConnectionManager } from '../plugins/connections/manager.mjs';

const ACCOUNT = 'test@example.com';
const desired = (id, extra = {}) => ({ id, enabled: true, generation: 1, ...extra });
const ok = stdout => ({ exitCode: 0, stdout, stderr: '' });
const googleJSON = row => JSON.stringify({ accounts: [{ email: ACCOUNT, services: ['gmail', 'calendar', 'drive', 'contacts', 'docs', 'sheets'], scopes: ['gmail', 'calendar', 'drive', 'contacts'].map(id => 'https://www.googleapis.com/auth/' + id + '.readonly'), client: 'default', created_at: '2026-10-13T00:00:00Z', auth: 'oauth', valid: true, ...row }] });
const turn = () => new Promise(resolve => setImmediate(resolve));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const phoneEvidence = (automation = false, recording = false) => [{ id: 'automation', granted: automation, verified: automation, reason: automation ? 'authorized' : 'unverified' }, { id: 'recording', granted: recording, verified: recording, reason: recording ? 'authorized' : 'needs_authorization' }];

test('native file authorization opens the picker only on explicit grant and sends no bookmarks or paths', async () => {
  const calls = [];
  const payload = { version: 1, state: 'connected', code: 'ok', selectedCount: 1, accessibleCount: 1, secretPath: '/PRIVATE', bookmark: 'SECRET', permissions: [{ id: 'readable', granted: true, verified: true }, { id: 'full_disk', granted: false, verified: false }] };
  const probes = createLocalProbes({ root: '/test-root', runner: async (tool, args, options) => { calls.push({ tool, args, timeout: options.timeoutMs }); return ok(JSON.stringify(payload)); } });
  const selected = desired('files', { scope: 'selected-files' });
  const value = await probes.connect(selected);
  assert.equal(value.state, 'connected');
  assert.ok(!JSON.stringify(value).includes('PRIVATE')); assert.ok(!JSON.stringify(value).includes('SECRET'));
  assert.deepEqual(calls[0].args, ['authorize']); assert.equal(calls[0].timeout, 180000);
  await probes.probe(selected); assert.deepEqual(calls[1].args, ['probe']);
  await probes.connect(selected, { kind: 'settings' }); assert.deepEqual(calls[2].args, ['settings']);
  payload.permissions[1].granted = true;
  assert.equal((await probes.probe(selected)).code, 'probe_failed');
});

test('common folders use native default confirmation and scope-specific proof', async () => {
  const actions = [], progress = [];
  const probes = createLocalProbes({ runner: async (_tool, args, options) => {
    actions.push({ action: args[0], timeout: options.timeoutMs });
    return ok(JSON.stringify({ version: 1, state: 'connected', code: 'ok', selectedCount: 3, accessibleCount: 3, permissions: [{ id: 'readable', granted: true, verified: true }, { id: 'full_disk', granted: false, verified: false }] }));
  } });
  const common = desired('files', { scope: 'common-folders' });
  assert.equal((await probes.connect(common, { onProgress: row => progress.push(row) })).state, 'connected');
  assert.deepEqual(actions[0], { action: 'authorize-defaults', timeout: 180000 });
  assert.equal(progress[0].state, 'awaiting_authorization');
  assert.ok(!progress[0].permissions?.some(row => row.verified));
  await probes.probe(common); assert.deepEqual(actions[1], { action: 'probe-defaults', timeout: 12000 });
});

test('native picker cancellation, absence, and malformed outputs never count as authorization', async () => {
  for (const [response, state, code] of [
    [{ errorCode: 'MISSING_TOOL' }, 'setup_required', 'native_helper_missing'],
    [ok('not-json'), 'error', 'probe_failed'],
    [ok(JSON.stringify({ version: 1, state: 'awaiting_authorization', code: 'auth_denied', selectedCount: 0, accessibleCount: 0, permissions: [{ id: 'readable', granted: false, verified: false }, { id: 'full_disk', granted: false, verified: false }] })), 'error', 'auth_denied'],
  ]) {
    const value = await createLocalProbes({ runner: async () => response }).connect(desired('files', { scope: 'selected-files' }));
    assert.equal(value.state, state); assert.equal(value.code, code);
    assert.ok(!value.permissions?.some(row => row.verified));
  }
});

test('fast command polling preserves check cadence and manual refresh can force a new probe', async () => {
  let at = 0, commands = [], calls = [];
  const companion = new ConnectionCompanion({ now: () => at, transport: async (_path, body) => body ? {} : ({ desired: [desired('github'), desired('x')], commands }), probes: { probe: async row => { calls.push(row.id); return { state: 'connected', code: 'ok' }; } } });
  await companion.tick(); assert.deepEqual(calls, ['github', 'x']);
  at = 2000; await companion.tick(); assert.equal(calls.length, 2);
  at = 15000; await companion.tick(); assert.deepEqual(calls, ['github', 'x', 'github']);
  commands = [{ commandId: 'force-refresh', id: 'x', kind: 'check', generation: 1 }];
  await companion.tick(); assert.equal(calls.at(-1), 'x'); assert.equal(calls.length, 4);
  commands = []; at = 75000; await companion.tick(); assert.equal(calls.filter(id => id === 'x').length, 3);
  await companion.stop();
});

test('Google uses actual gog 0.9 checked-command context and reports requested services', () => {
  const parseChecked = (output, account = ACCOUNT) => parseGoogleAccounts(output, account, { liveCheck: true });
  const value = parseChecked(googleJSON());
  assert.equal(value.state, 'connected'); assert.equal(value.account, ACCOUNT);
  assert.equal('checked' in JSON.parse(googleJSON()).accounts[0], false);
  assert.deepEqual(value.permissions.map(row => row.id), ['gmail', 'calendar', 'drive', 'contacts']);
  assert.ok(value.permissions.every(row => row.verified && row.granted));
  const partial = parseChecked(googleJSON({ services: ['gmail', 'drive'] }));
  assert.equal(partial.state, 'limited'); assert.equal(partial.code, 'partial');
  assert.equal(partial.permissions.find(row => row.id === 'calendar').granted, false);
  // A stored valid/checked claim is insufficient without a real --check execution.
  assert.equal(parseGoogleAccounts(googleJSON(), ACCOUNT).code, 'not_authenticated');
  assert.equal(parseGoogleAccounts(googleJSON({ checked: true }), ACCOUNT).code, 'not_authenticated');
  assert.equal(parseGoogleAccounts(googleJSON(), ACCOUNT, { liveCheck: 'true' }).code, 'probe_failed');
  for (const row of [{ valid: 'true' }, { valid: undefined }, { error: 123 }, { services: [123] }, { scopes: 'gmail' }, { scopes: [123] }]) assert.equal(parseChecked(googleJSON(row)).code, 'probe_failed');
  for (const [error, expected] of [['invalid_grant SECRET_TOKEN', 'credential_expired'], ['credentials.json missing SECRET_TOKEN', 'setup_required'], ['keychain interaction is not allowed SECRET_TOKEN', 'permission_required'], ['dial tcp: network unreachable SECRET_TOKEN', 'network_error']]) {
    const failure = parseChecked(googleJSON({ valid: false, error }));
    assert.equal(failure.code, expected);
    assert.ok(!JSON.stringify(failure).includes('SECRET_TOKEN'));
    assert.ok(!failure.permissions?.some(row => row.verified));
  }
  assert.equal(parseChecked(googleJSON({ scopes: undefined })).state, 'limited');
  assert.ok(parseChecked(googleJSON({ scopes: undefined })).permissions.every(row => !row.verified));
  assert.equal(parseChecked('{"accounts":[{"email":3}]}').code, 'not_authenticated');
  assert.equal(parseChecked(googleJSON(), '-flag@example.com').code, 'permission_required');
  assert.equal(parseChecked(googleJSON(), 'other@example.com').code, 'not_authenticated');
  assert.equal(parseChecked('{"accounts":[]}', '').code, 'permission_required');
  for (const text of ['null', '[]', '{}', 'not json']) assert.equal(parseChecked(text).code, 'probe_failed');
});

test('read-only CLI probes keep secrets and device ids local; X uses official OAuth', async () => {
  const calls = [];
  const probes = createLocalProbes({ runner: async (tool, args, options) => {
    calls.push({ tool, args, options });
    if (tool === 'gog') return ok(googleJSON());
    if (tool === 'gh') return ok(args[1].startsWith('user/repos') ? '1' : 'test-account\n');
    
    return ok(JSON.stringify({ ok: true, data: { state: 'locked', provider: 'ios', permissions: phoneEvidence().map(row => ({ ...row, reason: 'unsupported' })), detail: 'PRIVATE_DEVICE_ADDRESS', id: 'PRIVATE_DEVICE_ID' } }));
  }, oauth: { xProbe: async () => ({ state: 'connected', code: 'ok', account: 'tester', permissions: [{ id: 'profile', granted: true, verified: true }] }) } });
  const values = await Promise.all(['google', 'github', 'x', 'phone'].map(id => probes.probe(desired(id, { account: ACCOUNT }))));
  assert.equal(values[0].state, 'connected'); assert.equal(values[1].code, 'ok');
  assert.equal(values[2].account, 'tester'); assert.equal(values[3].code, 'phone_locked');
  assert.ok(!JSON.stringify(values).includes('SECRET')); assert.ok(!JSON.stringify(values).includes('PRIVATE'));
  assert.deepEqual(calls[0].args, ['auth', 'list', '--check', '--json', '--no-input', '--timeout=8s']);
  assert.deepEqual(calls[1].args, ['api', 'user', '--hostname', 'github.com', '--jq', '.login']);
  assert.equal(calls[2].options.input, '{"action":"device"}');
  assert.ok(calls.every(call => !/tweet|screenshot|logout|remove|token|session|exec/.test(call.args.join(' '))));
});

test('disabled services never inspect credentials, files or phones', async () => {
  let calls = 0;
  const probes = createLocalProbes({ runner: async () => { calls++; }, fs: { access: async () => { calls++; } } });
  for (const id of ['google', 'github', 'x', 'phone', 'files']) {
    await probes.probe(desired(id, { enabled: false })); await probes.connect(desired(id, { enabled: false }));
  }
  assert.equal(calls, 0);
});

test('files only open bounded directories; denied TCC and full-disk uncertainty remain visible', async () => {
  const paths = [];
  const fs = { access: async path => { paths.push(path); if (path.endsWith('/Mail')) throw Object.assign(new Error('private'), { code: 'EPERM' }); }, opendir: async () => ({ close: async () => {} }) };
  const probes = createLocalProbes({ fs, home: '/Users/tester' });
  assert.equal((await probes.probe(desired('files'))).code, 'permission_required');
  const value = await probes.probe(desired('files', { scope: 'all-readable-files' }));
  assert.equal(paths.length, 8); assert.equal(value.state, 'limited'); assert.equal(value.code, 'permission_required');
  assert.deepEqual(value.permissions.map(row => row.id), ['readable', 'full_disk']);
  assert.equal(value.permissions[0].granted, true); assert.equal(value.permissions[1].verified, false);
  assert.ok(!JSON.stringify(value).includes('/Users/'));
  const allReadable = await createLocalProbes({ fs: { access: async () => {}, opendir: async () => ({ close: async () => {} }) }, home: '/Users/tester' }).probe(desired('files', { scope: 'all-readable-files' }));
  assert.equal(allReadable.state, 'limited'); assert.equal(allReadable.permissions[1].granted, false);
});

test('TCC directory timeout returns a permission result and closes late handles without stacking OS calls', async () => {
  let opened = 0, closed = 0, finish;
  const fs = {
    access: async () => {},
    opendir: async path => {
      if (path === '/') { opened++; return await new Promise(resolve => { finish = resolve; }); }
      return { close: async () => {} };
    },
  };
  const probes = createLocalProbes({ fs, home: '/test-home', fileCheckTimeoutMs: 10, fileProbeTimeoutMs: 100 });
  const row = await probes.probe(desired('files', { scope: 'all-readable-files' }));
  assert.equal(row.state, 'limited'); assert.equal(row.code, 'permission_required');
  assert.equal(row.permissions[0].granted, false);
  await probes.probe(desired('files', { scope: 'all-readable-files' }));
  assert.equal(opened, 1);
  finish({ close: async () => { closed++; } }); await turn();
  assert.equal(closed, 1);
});

test('overall file deadline and withdrawal abort a hung FS call without a verified readable claim', async () => {
  let accesses = 0;
  const fs = { access: async () => { accesses++; return await new Promise(() => {}); }, opendir: async () => { throw new Error('must not open'); } };
  const probes = createLocalProbes({ fs, fileCheckTimeoutMs: 2000, fileProbeTimeoutMs: 15 });
  const row = await probes.probe(desired('files', { scope: 'all-readable-files' }));
  assert.equal(row.code, 'permission_required'); assert.equal(row.permissions[0].granted, false);
  const controller = new AbortController();
  const pending = probes.probe(desired('files', { scope: 'all-readable-files' }), controller.signal);
  await turn(); controller.abort();
  const aborted = await pending;
  assert.equal(aborted.state, 'offline'); assert.equal(aborted.code, 'probe_failed');
  assert.equal(accesses, 2);
});

test('cancelling an in-flight opendir closes its eventual handle and stops further directory checks', async () => {
  let finish, calls = 0, closed = 0;
  const probes = createLocalProbes({ fs: { access: async () => {}, opendir: async () => { calls++; return await new Promise(resolve => { finish = resolve; }); } } });
  const controller = new AbortController();
  const pending = probes.connect(desired('files', { scope: 'all-readable-files' }), { signal: controller.signal });
  await turn(); controller.abort(); assert.equal((await pending).code, 'probe_failed');
  assert.equal(calls, 1);
  finish({ close: async () => { closed++; } }); await turn(); assert.equal(closed, 1);
});

test('phone state mapping and malformed helper responses cannot fake connection', async () => {
  for (const [state, expected] of [['connected', 'limited'], ['locked', 'limited'], ['absent', 'offline'], ['unauthorized', 'awaiting_authorization'], ['multiple', 'setup_required'], ['unconfigured', 'setup_required'], ['disabled', 'setup_required'], ['invented', 'error']]) {
    const value = await createLocalProbes({ runner: async () => ok(JSON.stringify({ ok: true, data: { state, provider: 'adb', permissions: phoneEvidence() } })) }).probe(desired('phone'));
    assert.equal(value.state, expected);
    if (value.permissions) assert.equal(value.permissions.find(row => row.id === 'automation').verified, false);
  }
  for (const text of ['not json', '{"ok":false}', '{"ok":true,"data":{"state":"connected","provider":"fake"}}']) assert.equal((await createLocalProbes({ runner: async () => ok(text) }).probe(desired('phone'))).code, 'probe_failed');
});

test('phone binds only on explicit connection; background probes never configure devices', async () => {
  const calls = [];
  const probes = createLocalProbes({ runner: async (_tool, _args, options) => {
    calls.push(JSON.parse(options.input).action);
    return ok(JSON.stringify({ ok: true, data: { provider: 'adb', state: 'connected', permissions: phoneEvidence() } }));
  } });
  await probes.probe(desired('phone'));
  assert.deepEqual(calls, ['device']);
  const value = await probes.connect(desired('phone'));
  assert.deepEqual(calls, ['device', 'connect-device']);
  assert.equal(value.state, 'limited');
  assert.equal(value.permissions.find(row => row.id === 'automation').granted, false);
  assert.equal(value.permissions.find(row => row.id === 'recording').granted, false);
});

test('phone permissions require independent evidence, and native settings only open explicitly', async () => {
  const actions = [];
  let recording = false;
  const probes = createLocalProbes({ runner: async (_tool, _args, options) => {
    const action = JSON.parse(options.input).action; actions.push(action);
    return ok(JSON.stringify({ ok: true, data: { state: 'connected', provider: 'adb', permissions: phoneEvidence(true, recording), ...(action === 'phone-settings' ? { settingsOpened: true } : {}), deviceId: 'PRIVATE_DEVICE', rawError: 'PRIVATE_ERROR' } }));
  } });
  const partial = await probes.probe(desired('phone'));
  assert.equal(partial.state, 'limited'); assert.equal(partial.code, 'phone_recording_required');
  assert.equal(partial.permissions.find(row => row.id === 'automation').verified, true);
  assert.equal(partial.permissions.find(row => row.id === 'recording').verified, false);
  const opened = await probes.connect(desired('phone'), { kind: 'settings' });
  assert.equal(opened.code, 'phone_settings_opened'); assert.equal(opened.state, 'limited');
  assert.deepEqual(actions, ['device', 'phone-settings']);
  assert.ok(!JSON.stringify(opened).includes('PRIVATE'));
  recording = true;
  const ready = await probes.probe(desired('phone'));
  assert.equal(ready.state, 'connected'); assert.ok(ready.permissions.every(row => row.verified));
});

test('phone helper rejects fabricated, malformed and contradictory permission reports', async () => {
  for (const data of [
    { state: 'connected', provider: 'adb' },
    { state: 'connected', provider: 'adb', permissions: [phoneEvidence()[0], phoneEvidence()[0]] },
    { state: 'connected', provider: 'adb', permissions: [{ ...phoneEvidence()[0], granted: true }, phoneEvidence()[1]] },
    { state: 'connected', provider: 'adb', permissions: [{ ...phoneEvidence()[0], reason: 'PRIVATE_ERROR' }, phoneEvidence()[1]] },
    { state: 'absent', provider: 'adb', permissions: phoneEvidence(true, true) },
    { state: 'connected', provider: 'none', permissions: phoneEvidence(true, true) },
    { state: 'connected', provider: 'ios', permissions: phoneEvidence(true, true) },
  ]) {
    const result = await createLocalProbes({ runner: async () => ok(JSON.stringify({ ok: true, data })) }).probe(desired('phone'));
    assert.equal(result.code, 'probe_failed'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('phone settings failure and unavailable capability keep an actionable limited state', async () => {
  const responses = [
    [{ state: 'connected', provider: 'adb', permissions: phoneEvidence(true, false), settingsOpened: false }, 'phone_settings_failed'],
    [{ state: 'connected', provider: 'adb', permissions: [phoneEvidence(true)[0], { ...phoneEvidence()[1], reason: 'helper_missing' }], settingsOpened: false }, 'phone_helper_missing'],
    [{ state: 'connected', provider: 'ios', permissions: phoneEvidence().map(row => ({ ...row, reason: 'unsupported' })), settingsOpened: false }, 'phone_permissions_unsupported'],
  ];
  for (const [data, code] of responses) {
    const row = await createLocalProbes({ runner: async () => ok(JSON.stringify({ ok: true, data })) }).connect(desired('phone'), { kind: 'settings' });
    assert.equal(row.state, 'limited'); assert.equal(row.code, code);
    assert.equal(row.permissions.find(row => row.id === 'recording').verified, false);
  }
});

test('companion dispatches a phone settings command once without launching on a heartbeat', async () => {
  const kinds = [], reports = [];
  const companion = new ConnectionCompanion({ transport: async (_path, body) => {
    if (body) { reports.push(...body.reports); return {}; }
    return { desired: [desired('phone')], commands: [{ id: 'phone', kind: 'settings', commandId: 'phone-settings-fixture', generation: 1 }] };
  }, probes: { connect: async (_desired, { kind }) => { kinds.push(kind); return { state: 'limited', code: 'phone_settings_opened' }; }, probe: async () => ({ state: 'limited', code: 'phone_recording_required' }) } });
  await companion.tick(); await turn(); await companion.tick();
  assert.deepEqual(kinds, ['settings']);
  assert.ok(reports.some(row => row.code === 'phone_settings_opened'));
  await companion.stop();
});

test('OAuth starts only on explicit connect, requests consent again, and sanitizes GitHub device code', async () => {
  const calls = [], progress = [];
  let authenticated = false;
  const probes = createLocalProbes({ runner: async (tool, args, options) => {
    calls.push({ tool, args });
    if (args[0] === 'list' || args[1] === 'list') return ok(authenticated ? googleJSON() : '{"accounts":[]}');
    if (args[1] === 'add') { authenticated = true; return ok('SECRET_TOKEN'); }
    if (args[0] === 'api') return { exitCode: 1, stderr: 'not logged in SECRET_TOKEN' };
    options.onOutput('First copy your one-time code: ABCD-1234\nOTHER SECRET_TOKEN');
    return { exitCode: 1, stderr: 'not logged in SECRET_TOKEN' };
  } });
  assert.equal((await probes.probe(desired('google', { account: ACCOUNT }))).code, 'not_authenticated');
  assert.ok(!calls.some(call => call.args.includes('add')));
  assert.equal((await probes.connect(desired('google', { account: ACCOUNT }))).state, 'connected');
  const googleAdd = calls.find(call => call.args.includes('add'));
  assert.ok(googleAdd.args.includes('--readonly')); assert.equal(googleAdd.args[googleAdd.args.indexOf('--drive-scope') + 1], 'readonly'); assert.ok(googleAdd.args.includes('--force-consent'));
  const count = calls.length;
  await probes.connect(desired('google', { account: ACCOUNT }));
  assert.equal(calls.length, count + 2);
  await probes.connect(desired('github'), { onProgress: row => progress.push(row) });
  assert.equal(progress.at(-1).auth.verificationUrl, 'https://github.com/login/device');
  assert.equal(progress.at(-1).auth.code, 'ABCD-1234');
  assert.ok(!JSON.stringify(progress).includes('SECRET_TOKEN'));
});

test('missing tools, keychain denial and malformed identity have static safe errors', async () => {
  for (const [result, code] of [[{ errorCode: 'MISSING_TOOL' }, 'tool_missing'], [{ stderr: 'keychain SECRET' }, 'permission_required'], [{ stderr: 'invalid_grant SECRET' }, 'credential_expired'], [{ errorCode: 'TIMEOUT' }, 'network_error']]) {
    const row = await createLocalProbes({ runner: async () => ({ exitCode: 1, ...result }) }).probe(desired('google', { account: ACCOUNT }));
    assert.equal(row.code, code); assert.ok(!JSON.stringify(row).includes('SECRET'));
  }
  assert.equal((await createLocalProbes({ runner: async () => ok('SECRET_TOKEN\nhello') }).probe(desired('github'))).code, 'probe_failed');
});

test('explicit Google supplemental authorization requests missing readonly scopes with consent', async () => {
  const calls = []; let full = false;
  const probes = createLocalProbes({ runner: async (tool, args) => {
    calls.push(args);
    if (args[1] === 'add') { full = true; return ok(''); }
    return ok(googleJSON(full ? {} : { services: ['gmail'] }));
  } });
  assert.equal((await probes.probe(desired('google', { account: ACCOUNT }))).state, 'limited');
  assert.equal(calls.length, 1);
  assert.equal((await probes.connect(desired('google', { account: ACCOUNT }))).state, 'connected');
  const args = calls.find(args => args[1] === 'add');
  assert.ok(args.includes('--force-consent')); assert.ok(args.includes('--readonly'));
  assert.equal(args[args.indexOf('--drive-scope') + 1], 'readonly');
});

test('readonly checks never initiate login; explicit GitHub connect opens authorization', async () => {
  const calls = [];
  const probes = createLocalProbes({ runner: async (tool, args) => {
    calls.push({ tool, args });
    return tool === 'gog' ? { exitCode: 1, stderr: 'keychain interaction is not allowed' } : ok(args[1].startsWith('user/repos') ? '0' : 'tester\n');
  } });
  assert.equal((await probes.probe(desired('google', { account: ACCOUNT }))).code, 'permission_required');
  assert.equal((await probes.probe(desired('github'))).state, 'connected');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !call.args.includes('add') && !call.args.includes('login')));
  await probes.connect(desired('github'));
  assert.ok(calls.some(call => call.args.includes('login')));
});

test('companion deduplicates commands, never overlaps polling, and aborts stale OAuth generations', async () => {
  const posts = [], jobs = [], connected = [];
  let snapshot = { desired: [desired('github')], commands: [{ commandId: 'command-1', id: 'github', generation: 1, kind: 'connect' }] };
  const companion = new ConnectionCompanion({ transport: async (path, body) => { if (body) { posts.push(body); return {}; } return snapshot; }, probes: {
    probe: async row => { connected.push(row.id); return { state: 'connected', code: 'ok' }; },
    connect: (row, { signal, onProgress }) => new Promise(resolve => { jobs.push({ row, signal, resolve, onProgress }); }),
  } });
  await companion.tick(); await turn();
  assert.equal(jobs.length, 1); assert.deepEqual(posts[0].ack, ['command-1']); assert.deepEqual(connected, []);
  await companion.tick(); assert.equal(jobs.length, 1);
  snapshot = { desired: [desired('github', { enabled: false, generation: 2 })], commands: [{ commandId: 'command-2', id: 'github', generation: 2, kind: 'disconnect' }] };
  await companion.tick(); assert.equal(jobs[0].signal.aborted, true);
  jobs[0].onProgress({ state: 'connected', code: 'ok' }); jobs[0].resolve({ state: 'connected', code: 'ok' }); await turn();
  await companion.tick(); assert.deepEqual(posts.at(-1).reports, []);
  let finish;
  companion.transport = () => new Promise(resolve => { finish = resolve; });
  const first = companion.tick(); assert.equal(await companion.tick(), false);
  finish({ desired: [], commands: [] }); await turn();
  // The transport post is independently pending; shutdown must remain safe.
  finish({}); await first; await companion.stop();
});

test('companion rejects malformed snapshots and retains reports across temporary transport failure', async () => {
  let tries = 0;
  const posts = [], statuses = [];
  const companion = new ConnectionCompanion({ probes: { probe: async () => ({ state: 'connected', code: 'ok' }) }, transport: async (path, body) => {
    if (!body) return { desired: [desired('github')], commands: [] };
    posts.push(body); if (++tries === 1) throw new Error('SECRET'); return {};
  }, onStatus: value => statuses.push(value) });
  assert.equal(await companion.tick(), false); assert.equal(await companion.tick(), true);
  assert.equal(posts[1].reports[0].state, 'connected'); assert.deepEqual(statuses, ['BRIDGE_UNAVAILABLE', 'CONNECTED']);
  companion.transport = async () => ({ desired: [desired('bad-id')], commands: [] });
  assert.equal(await companion.tick(), false); assert.equal(statuses.at(-1), 'INVALID_RESPONSE');
  await companion.stop();
});

test('private config and persisted deduplication survive a restart without retaining credentials in state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pa-companion-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'companion.json'), statePath = join(dir, 'state.json');
  const config = { endpoint: 'http://127.0.0.1:3093', publicOrigin: 'http://example.internal:3083', token: 'a'.repeat(64), intervalMs: 15000 };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); assert.equal((await loadCompanionConfig(configPath)).publicOrigin, config.publicOrigin);
  await writeFile(configPath, JSON.stringify({ ...config, password: 'OBSOLETE_PASSWORD' })); await assert.rejects(loadCompanionConfig(configPath), { code: 'INVALID_CONFIG' });
  await writeFile(configPath, JSON.stringify(config));
  await chmod(configPath, 0o644); await assert.rejects(loadCompanionConfig(configPath), { code: 'PRIVATE_CONFIG_REQUIRED' });
  await chmod(configPath, 0o600); await writeFile(configPath, JSON.stringify({ ...config, endpoint: 'http://outside.example' })); await assert.rejects(loadCompanionConfig(configPath), { code: 'INVALID_CONFIG' });
  const first = new ConnectionCompanion({ transport: async () => {}, statePath }); await first.remember('only-command');
  const second = new ConnectionCompanion({ transport: async () => {}, statePath }); await second.initialize(); assert.ok(second.seen.has('only-command'));
  assert.ok(!(await readFile(statePath, 'utf8')).includes('SECRET'));
  await first.stop(); await second.stop();
});

test('actual manager and companion agree on null defaults, accounts, scopes, permissions and OAuth', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-companion-manager-')); t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createConnectionManager({ root }); t.after(() => manager.close());
  const { token } = manager.mutate({ operation: 'pair', revision: 0, values: { name: 'Test Mac' } });
  const calls = [];
  const probes = createLocalProbes({ home: '/test-home', fs: { access: async () => {}, opendir: async () => ({ close: async () => {} }) }, runner: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'gog') return ok(googleJSON());
    if (tool === 'gh') return ok(args[1].startsWith('user/repos') ? '1' : 'test-account');
    
    return ok(JSON.stringify({ ok: true, data: { state: 'connected', provider: 'adb', detail: 'SECRET_DEVICE', permissions: phoneEvidence(true, true) } }));
  }, oauth: { xConnect: async () => ({ state: 'limited', code: 'partial', account: 'tester', permissions: [{ id: 'profile', granted: true, verified: true }] }), xProbe: async () => ({ state: 'limited', code: 'partial', account: 'tester', permissions: [{ id: 'profile', granted: true, verified: true }] }) } });
  const companion = new ConnectionCompanion({ probes, transport: async (_path, body) => body ? manager.reportBridge(token, body) : manager.bridgeSnapshot(token) });
  t.after(() => companion.stop());
  assert.equal(await companion.tick(), true);
  assert.equal(manager.snapshot().bridge.online, true); assert.equal(calls.length, 0);
  for (const id of ['google', 'files', 'phone', 'github', 'x']) manager.mutate({ operation: id === 'files' ? 'grant' : 'connect', id, revision: manager.snapshot().revision, values: id === 'google' ? { account: ACCOUNT } : id === 'files' ? { scope: 'all-readable-files' } : {} });
  assert.equal(await companion.tick(), true); await turn(); assert.equal(await companion.tick(), true);
  const items = manager.snapshot().items;
  assert.equal(items.find(row => row.id === 'google').state, 'connected');
  assert.equal(items.find(row => row.id === 'files').state, 'limited');
  assert.equal(items.find(row => row.id === 'phone').state, 'connected');
  assert.equal(items.find(row => row.id === 'github').state, 'connected');
  assert.equal(items.find(row => row.id === 'x').state, 'limited');
  assert.equal(items.find(row => row.id === 'x').account, 'tester');
  assert.ok(!JSON.stringify(items).includes('SECRET'));
  assert.ok(calls.some(row => row.args.includes('login'))); assert.ok(calls.some(row => row.args.includes('add'))); assert.ok(!calls.some(row => row.tool === 'bird'));
  assert.deepEqual(manager.bridgeSnapshot(token).commands, []);
});

test('real manager accepts sanitized GitHub device flow and rejects no late completion after withdrawal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-companion-oauth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createConnectionManager({ root }); t.after(() => manager.close());
  const { token } = manager.mutate({ operation: 'pair', revision: 0, values: { name: 'Test Mac' } });
  let finish, signal;
  const probes = createLocalProbes({ runner: async (_tool, args, options) => {
    if (args[0] === 'api') return { exitCode: 1, stderr: 'not logged in' };
    options.onOutput('First copy your one-time code: ABCD-1234\nSECRET');
    signal = options.signal;
    return await new Promise(resolve => { finish = resolve; });
  } });
  const companion = new ConnectionCompanion({ probes, transport: async (_path, body) => body ? manager.reportBridge(token, body) : manager.bridgeSnapshot(token) });
  await companion.tick();
  manager.mutate({ operation: 'connect', id: 'github', revision: manager.snapshot().revision });
  await companion.tick(); await turn(); await companion.tick();
  const item = manager.snapshot().items.find(row => row.id === 'github');
  assert.equal(item.state, 'awaiting_authorization'); assert.equal(item.auth.code, 'ABCD-1234');
  manager.mutate({ operation: 'disconnect', id: 'github', revision: manager.snapshot().revision });
  await companion.tick(); assert.equal(signal.aborted, true);
  finish(ok('SECRET')); await turn(); await companion.tick();
  assert.equal(manager.snapshot().items.find(row => row.id === 'github').state, 'revoked');
  await companion.stop();
});

test('actual Python helper maps Android config to adb without contacting a physical device', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-companion-device-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(join(ROOT, 'config/pa.example.json'), 'utf8'));
  config.device.provider = 'android';
  await mkdir(join(root, '.runtime')); await writeFile(join(root, '.runtime/pa.json'), JSON.stringify(config));
  const script = 'import importlib.util,json,sys\nfrom pathlib import Path\nroot=Path(sys.argv[1]); project=Path(sys.argv[2])\nsys.path.insert(0,str(project/"bin"));sys.path.insert(0,str(project/"scripts"))\nspec=importlib.util.spec_from_file_location("web_config_fixture",project/"scripts/web_config.py");module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nimport devices\ndevices.probe_device=lambda cfg, **kw:{"state":"connected","provider":cfg["device_type"],"id":"PRIVATE_DEVICE"}\nmodule.phone_permissions=lambda *args:[{"id":name,"granted":False,"verified":False,"reason":"unverified"} for name in ("automation","recording")]\nprint(json.dumps({"ok":True,"data":module.execute({"action":"device"},root)}))';
  const helper = await runCLI('python3', ['-c', script, root, ROOT]);
  assert.equal(helper.exitCode, 0); assert.equal(JSON.parse(helper.stdout).data.provider, 'adb');
  const row = await createLocalProbes({ runner: async () => helper }).probe(desired('phone'));
  assert.equal(row.state, 'limited'); assert.ok(!JSON.stringify(row).includes('PRIVATE_DEVICE'));
});

test('bridge transport uses expected Host and auth headers without session or redirect requirements', async t => {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ headers: req.headers, method: req.method, path: req.url });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data: { desired: [], commands: [] } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const transport = createBridgeTransport({ endpoint: `http://127.0.0.1:${server.address().port}`, publicOrigin: 'http://example.internal:3083', token: 'test-token' });
  await transport('/api/connections/bridge'); await transport('/api/connections/bridge/report', { reports: [], ack: [] });
  assert.equal(calls[0].headers.host, 'example.internal:3083'); assert.equal(calls[0].headers['x-pa-bridge-token'], 'test-token');
  assert.equal(calls[0].headers.authorization, undefined); assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].method, 'POST'); await assert.rejects(transport('/outside'), { code: 'INVALID_ROUTE' });
});

test('CLI runner bounds output, handles missing programs, and aborts without exposing stderr', async () => {
  assert.equal((await runCLI('/nonexistent-pa-test', [])).errorCode, 'MISSING_TOOL');
  const controller = new AbortController();
  const job = runCLI(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: controller.signal }); controller.abort();
  assert.equal((await job).errorCode, 'ABORTED');
  assert.equal((await runCLI(process.execPath, ['-e', 'process.stdout.write("x".repeat(70000))'])).errorCode, 'INVALID_RESPONSE');
});

test('CLI runner preserves split UTF-8 on both streams and counts original output bytes', async () => {
  const program = `
    (async () => {
      for (const byte of Buffer.from('{"text":"你🪴好"}')) {
        process.stdout.write(Buffer.from([byte]));
        await new Promise(resolve => setTimeout(resolve, 3));
      }
      for (const byte of Buffer.from('连接正常')) {
        process.stderr.write(Buffer.from([byte]));
        await new Promise(resolve => setTimeout(resolve, 3));
      }
    })();
  `;
  const result = await runCLI(process.execPath, ['-e', program]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.errorCode, undefined);
  assert.deepEqual(JSON.parse(result.stdout), { text: '你🪴好' });
  assert.equal(result.stderr, '连接正常');
  const exact = await runCLI(process.execPath, ['-e', 'process.stdout.write("🪴".repeat(256))'], { maxBytes: 1024 });
  assert.equal(exact.errorCode, undefined);
  assert.equal(exact.stdout, '🪴'.repeat(256));
  const overflow = await runCLI(process.execPath, ['-e', 'process.stdout.write("🪴".repeat(256));process.stderr.write("x")'], { maxBytes: 1024 });
  assert.equal(overflow.errorCode, 'INVALID_RESPONSE');
});
