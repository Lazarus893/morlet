import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createOAuthConnections, googleAuthorizationURL } from '../plugins/connections/oauth.mjs';

const googleURL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=client.apps.googleusercontent.com&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A4000%2Fcallback&state=random&scope=email';
const desired = { id: 'x', enabled: true };
const response = body => new Response(JSON.stringify(body), { status: 200 });

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pa-oauth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const redirectUri = 'http://127.0.0.1:' + port + '/oauth/x/callback';
  const directory = join(root, '.runtime/connections');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'oauth-config.json'), JSON.stringify({ x: { clientId: 'fixture_client_id', redirectUri } }), { mode: 0o600 });
  return { root, redirectUri, tokenPath: join(directory, 'x-oauth.json'), oauth: createOAuthConnections({ root, env: {}, callbackTimeoutMs: 3000, ...options }) };
}

function sendCallback(url, fields = {}) {
  const consent = new URL(url);
  const callback = new URL(consent.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: consent.searchParams.get('state'), code: 'fixture_code', ...fields }).toString();
  return fetch(callback);
}

function provider() {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/oauth2/token')) return response({ token_type: 'bearer', access_token: 'fixture_access', refresh_token: 'fixture_refresh', scope: 'users.read tweet.read offline.access', expires_in: 7200 });
    if (url.endsWith('/users/me')) return response({ data: { id: '123', username: 'fixture_user' } });
    if (url.includes('/timelines/reverse_chronological?')) return response({ meta: { result_count: 0 } });
    throw new Error('Unexpected API URL');
  };
  return { fetchImpl, requests };
}

test('Google exposes only native official consent URLs from CLI output', () => {
  assert.equal(googleAuthorizationURL('noise\n' + googleURL), googleURL);
  for (const bad of [googleURL.replace('accounts.google.com', 'accounts.google.com.evil.test'), googleURL.replace('127.0.0.1', 'evil.test'), googleURL.replace('state=random', 'state='), googleURL.replace('/o/oauth2/v2/auth', '/login'), googleURL + '#token', googleURL + '&secret=private', googleURL + '&client_id=duplicate']) assert.equal(googleAuthorizationURL(bad), null);
});

test('Google connect launches native OAuth and sends only safe progress', async () => {
  const progress = [], calls = [];
  const oauth = createOAuthConnections({ runner: async (...args) => {
    calls.push(args);
    args[2].onOutput('browser\n' + googleURL + '\nprivate token must stay local');
    return { exitCode: 0 };
  } });
  const completed = await oauth.googleConnect({ enabled: true, account: 'fixture@example.com' }, { onProgress: value => progress.push(value), probe: async () => ({ state: 'connected', code: 'ok' }) });
  assert.equal(completed.state, 'connected');
  assert.equal(calls[0][0], 'gog');
  assert.ok(calls[0][1].includes('--readonly'));
  assert.ok(calls[0][1].includes('--force-consent'));
  assert.equal(progress.at(-1).auth.verificationUrl, googleURL);
  assert.equal(progress.at(-1).auth.code, undefined);
  assert.equal(JSON.stringify(progress).includes('private token'), false);
});

test('Google rejects missing account and reports missing app configuration without raw error', async () => {
  let called = false;
  const oauth = createOAuthConnections({ runner: async () => { called = true; return { exitCode: 1, stderr: 'no OAuth client_secret PRIVATE_SECRET' }; } });
  assert.equal((await oauth.googleConnect({ enabled: true })).code, 'permission_required');
  assert.equal(called, false);
  const result = await oauth.googleConnect({ enabled: true, account: 'fixture@example.com' });
  assert.equal(result.state, 'setup_required');
  assert.equal(JSON.stringify(result).includes('PRIVATE_SECRET'), false);
  for (const [stderr, expected] of [['access_denied', { state: 'error', code: 'auth_denied' }], ['keychain permission denied', { state: 'limited', code: 'permission_required' }], ['permission_denied', { state: 'limited', code: 'permission_required' }], ['invalid_grant', { state: 'expired', code: 'credential_expired' }]]) {
    const auth = createOAuthConnections({ runner: async () => ({ exitCode: 1, stderr }) });
    assert.deepEqual(await auth.googleConnect({ enabled: true, account: 'fixture@example.com' }), expected);
  }
});

test('X missing OAuth client does not open browser or look for browser cookies', async t => {
  const f = await fixture(t);
  await rm(join(f.root, '.runtime/connections/oauth-config.json'));
  assert.equal((await f.oauth.xConnect(desired)).code, 'oauth_client_missing');
  assert.equal((await f.oauth.xProbe(desired)).code, 'oauth_client_missing');
});

test('X ordinary user receives the deployment public client and consents without entering application credentials', async t => {
  const p = provider();
  const f = await fixture(t, { fetchImpl: p.fetchImpl, openURL: url => sendCallback(url) });
  await rm(join(f.root, '.runtime/connections/oauth-config.json'));
  const configured = { ...desired, oauthApp: { clientId: 'deployment_public_client', redirectUri: f.redirectUri } };
  assert.equal((await f.oauth.xConnect(configured)).state, 'connected');
  assert.equal(p.requests[0].init.body.get('client_id'), 'deployment_public_client');
  assert.equal(p.requests[0].init.headers.Authorization, undefined);
  assert.equal((await f.oauth.xConnect({ ...configured, oauthApp: { ...configured.oauthApp, clientSecret: 'never-bridge-this' } })).code, 'oauth_client_missing');
});

test('X timeline reads following posts with source dates and explicit partial coverage', async t => {
  const p = provider(), at = '2026-10-20T01:00:00Z';
  const f = await fixture(t, { fetchImpl: async (url, init) => url.includes('post.fields=') ? response({
    data: [{ id: '789', text: 'A short source post.', created_at: at, author_id: '456', note_post: { text: 'The complete source post with details.' } }],
    includes: { users: [{ id: '456', username: 'author' }] }, meta: { next_token: 'next' },
  }) : p.fetchImpl(url, init), openURL: url => sendCallback(url) });
  await f.oauth.xConnect(desired);
  const timeline = await f.oauth.xTimeline({ ...desired, account: 'fixture_user' });
  assert.equal(timeline.posts[0].text, 'The complete source post with details.');
  assert.equal(timeline.posts[0].url, 'https://x.com/author/status/789');
  assert.equal(timeline.posts[0].createdAt, at); assert.equal(timeline.truncated, true);
  await assert.rejects(f.oauth.xTimeline({ ...desired, account: 'other_user' }), { code: 'account_changed' });
});

test('X concurrent worker and connection checks serialize rotating refresh tokens and report provider limits', async t => {
  const p = provider();
  const f = await fixture(t, { fetchImpl: p.fetchImpl, now: () => 100000 });
  await writeFile(f.tokenPath, JSON.stringify({ accessToken: 'old', refreshToken: 'rotating', scopes: ['users.read', 'tweet.read', 'offline.access'], expiresAt: 0, clientId: 'fixture_client_id' }), { mode: 0o600 });
  const other = createOAuthConnections({ root: f.root, env: {}, fetchImpl: p.fetchImpl, now: () => 100000 });
  const statuses = await Promise.all([f.oauth.xProbe(desired), other.xProbe(desired)]);
  assert.ok(statuses.every(value => value.state === 'connected'));
  assert.equal(p.requests.filter(request => request.url.endsWith('/oauth2/token')).length, 1);
  for (const [status, code] of [[402, 'credits_required'], [429, 'rate_limited']]) {
    const limited = createOAuthConnections({ root: f.root, env: {}, fetchImpl: async () => new Response('PRIVATE', { status }), now: () => 100000 });
    assert.equal((await limited.xProbe(desired)).code, code);
  }
});

test('X Connect completes S256 PKCE via local callback, stores private tokens and reads APIs', async t => {
  const p = provider();
  let consent;
  const f = await fixture(t, { fetchImpl: p.fetchImpl, openURL: async url => { consent = new URL(url); await sendCallback(url); } });
  const progress = [];
  const result = await f.oauth.xConnect(desired, { onProgress: value => progress.push(value) });
  assert.equal(result.state, 'connected');
  assert.equal(consent.origin, 'https://x.com');
  assert.equal(consent.searchParams.get('scope'), 'tweet.read users.read offline.access');
  assert.equal(consent.searchParams.get('code_challenge_method'), 'S256');
  const exchange = p.requests[0].init.body;
  assert.equal(consent.searchParams.get('code_challenge'), createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'));
  assert.equal(exchange.get('redirect_uri'), f.redirectUri);
  assert.equal(exchange.get('client_id'), 'fixture_client_id');
  assert.equal(exchange.get('code'), 'fixture_code');
  assert.equal((await stat(f.tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, '.runtime/connections'))).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(result).includes('fixture_access'), false);
  assert.equal(JSON.stringify(progress).includes('fixture_refresh'), false);
  assert.equal(result.permissions.find(p => p.id === 'read').verified, true);
  await f.oauth.xDisconnect();
  await assert.rejects(readFile(f.tokenPath), { code: 'ENOENT' });
});

test('X rejects forged state, accepts valid callback afterward, and never exchanges forged code', async t => {
  const p = provider();
  const f = await fixture(t, { fetchImpl: p.fetchImpl, openURL: async url => {
    assert.equal((await sendCallback(url, { state: 'forged_state', code: 'evil_code' })).status, 400);
    assert.equal(p.requests.length, 0);
    await sendCallback(url);
  } });
  assert.equal((await f.oauth.xConnect(desired)).state, 'connected');
  assert.equal(p.requests[0].init.body.get('code'), 'fixture_code');
});

test('X denied consent and cancellation close callback without saving credentials', async t => {
  const p = provider();
  const denied = await fixture(t, { fetchImpl: p.fetchImpl, openURL: url => sendCallback(url, { error: 'access_denied' }) });
  assert.deepEqual(await denied.oauth.xConnect(desired), { state: 'error', code: 'auth_denied' });
  assert.equal(p.requests.length, 0);
  await assert.rejects(readFile(denied.tokenPath), { code: 'ENOENT' });
  const controller = new AbortController();
  const cancelled = await fixture(t, { fetchImpl: p.fetchImpl, openURL: async () => controller.abort() });
  assert.equal((await cancelled.oauth.xConnect(desired, { signal: controller.signal })).code, 'probe_failed');
  assert.equal(p.requests.length, 0);
  await assert.rejects(readFile(cancelled.tokenPath), { code: 'ENOENT' });
});

test('X rotates expired refresh token without another popup', async t => {
  const p = provider();
  const f = await fixture(t, { fetchImpl: p.fetchImpl, now: () => 100000 });
  await writeFile(f.tokenPath, JSON.stringify({ clientId: 'fixture_client_id', accessToken: 'old_access', refreshToken: 'old_refresh', scopes: ['users.read', 'tweet.read'], expiresAt: 1 }), { mode: 0o600 });
  assert.equal((await f.oauth.xProbe(desired)).state, 'connected');
  assert.equal(p.requests[0].init.body.get('grant_type'), 'refresh_token');
  assert.equal(p.requests[0].init.body.get('refresh_token'), 'old_refresh');
  assert.equal(JSON.parse(await readFile(f.tokenPath)).refreshToken, 'fixture_refresh');
});

test('X identity success with content API denied stays limited and does not claim verified read', async t => {
  const p = provider();
  const f = await fixture(t, { fetchImpl: async (url, init) => url.includes('/timelines/reverse_chronological?') ? new Response('PRIVATE_ERROR', { status: 403 }) : p.fetchImpl(url, init), openURL: url => sendCallback(url) });
  const result = await f.oauth.xConnect(desired);
  assert.equal(result.state, 'limited');
  assert.deepEqual(result.permissions.map(p => [p.id, p.granted, p.verified]), [['profile', true, true], ['read', true, false]]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR'), false);
});

test('X refuses cloud callback configurations', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.runtime/connections/oauth-config.json'), JSON.stringify({ x: { clientId: 'fixture_client_id', redirectUri: 'https://cloud.example/oauth/x/callback' } }));
  assert.equal((await f.oauth.xConnect(desired)).code, 'setup_required');
});


test('X refuses credentials with shared access or symlink indirection', async t => {
  const f = await fixture(t);
  const path = join(f.root, '.runtime/connections/oauth-config.json');
  await chmod(path, 0o644);
  assert.equal((await f.oauth.xConnect(desired)).code, 'oauth_client_missing');
  await chmod(path, 0o600);
  await writeFile(f.tokenPath, JSON.stringify({ clientId: 'fixture_client_id', accessToken: 'private', scopes: [] }), { mode: 0o600 });
  await chmod(f.tokenPath, 0o644);
  assert.equal((await f.oauth.xProbe(desired)).code, 'probe_failed');
  await rm(path);
  await symlink(f.tokenPath, path);
  assert.equal((await f.oauth.xConnect(desired)).code, 'oauth_client_missing');
});


test('X expires abandoned authorization and closes its localhost listener', async t => {
  let callback;
  const f = await fixture(t, { callbackTimeoutMs: 30, openURL: async url => { callback = new URL(url).searchParams.get('redirect_uri'); } });
  assert.equal((await f.oauth.xConnect(desired)).code, 'auth_expired');
  await assert.rejects(fetch(callback));
  await assert.rejects(readFile(f.tokenPath), { code: 'ENOENT' });
});

test('X confidential clients authenticate token exchange without sending secret to UI', async t => {
  const p = provider();
  const f = await fixture(t, { fetchImpl: p.fetchImpl, openURL: url => sendCallback(url) });
  await writeFile(join(f.root, '.runtime/connections/oauth-config.json'), JSON.stringify({ x: { clientId: 'fixture_client_id', clientSecret: 'private_fixture_secret', redirectUri: f.redirectUri } }), { mode: 0o600 });
  const progress = [];
  const result = await f.oauth.xConnect(desired, { onProgress: value => progress.push(value) });
  assert.equal(result.state, 'connected');
  assert.equal(p.requests[0].init.headers.Authorization, 'Basic ' + Buffer.from('fixture_client_id:private_fixture_secret').toString('base64'));
  assert.equal(p.requests[0].init.body.has('client_id'), false);
  assert.equal(JSON.stringify(progress).includes('private_fixture_secret'), false);
  assert.equal((await readFile(f.tokenPath, 'utf8')).includes('private_fixture_secret'), false);
});
