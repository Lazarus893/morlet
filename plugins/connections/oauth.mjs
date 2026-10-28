import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, open, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireCompanionLock } from '../agent-hub/lock.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const X_CALLBACK = 'http://127.0.0.1:3094/oauth/x/callback';
const X_SCOPES = ['tweet.read', 'users.read', 'offline.access'];
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const EMAIL = /^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/;
const result = (state, code, extra = {}) => ({ state, code, ...extra });
const failure = code => Object.assign(new Error(code), { code });
const assertActive = signal => { if (signal?.aborted) throw failure('aborted'); };

/** Only a native Google consent URL may leave the local CLI process. */
export function googleAuthorizationURL(output) {
  for (const match of String(output).matchAll(/https:\/\/accounts\.google\.com\/[^\s<>"']+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.href.length > 4096) continue;
      const allowed = new Set(['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'access_type', 'prompt', 'include_granted_scopes', 'login_hint', 'code_challenge', 'code_challenge_method']);
      if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) continue;
      if (url.origin !== 'https://accounts.google.com' || !['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname) || url.username || url.password || url.hash) continue;
      if (url.searchParams.get('response_type') !== 'code' || !url.searchParams.get('client_id') || !url.searchParams.get('state')) continue;
      const callback = new URL(url.searchParams.get('redirect_uri'));
      if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) || callback.username || callback.password) continue;
      return url.href;
    } catch { /* Ignore untrusted output. */ }
  }
  return null;
}

function parseCallbackURI(value) {
  const url = new URL(value);
  // This service runs on the user's Mac; never receive credentials through a cloud callback.
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !url.port || Number(url.port) < 1024 || url.pathname !== '/oauth/x/callback') throw failure('setup_required');
  return url;
}

async function readPrivateJSON(path) {
  // Check the same no-follow file descriptor that supplies the credential bytes.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536 || (info.mode & 0o177) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw failure('probe_failed');
    const content = await handle.readFile('utf8');
    if (content.length > 65536) throw failure('probe_failed');
    return JSON.parse(content);
  } finally { await handle.close(); }
}

async function writePrivateJSON(path, value, signal) {
  assertActive(signal);
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    assertActive(signal);
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally { await rm(temp, { force: true }); }
}

async function readResponse(response) {
  // Never forward provider errors, token responses, or user content to the server/logs.
  if (!response.ok) {
    const code = response.status === 401 ? 'credential_expired' : response.status === 402 ? 'credits_required' : response.status === 403 ? 'permission_required' : response.status === 429 ? 'rate_limited' : 'probe_failed';
    await response.body?.cancel().catch(() => {});
    throw failure(code);
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure('probe_failed');
  let bytes = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 65536) throw failure('probe_failed');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw failure('probe_failed'); }
  } finally { await reader.cancel().catch(() => {}); }
}

async function listenForCode(callback, state, { signal, timeoutMs }) {
  assertActive(signal);
  let settled = false, timer, abort;
  let complete;
  const code = new Promise(resolve => { complete = resolve; });
  const finish = outcome => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    server.close();
    complete(outcome);
  };
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let url;
    try { url = new URL(request.url, callback.origin); } catch { response.writeHead(400).end('无效请求'); return; }
    if (settled || request.method !== 'GET' || request.headers.host !== callback.host || url.pathname !== callback.pathname || (request.url?.length || 0) > 8192) { response.writeHead(404).end('无效请求'); return; }
    const incoming = url.searchParams.getAll('state');
    const expected = Buffer.from(state);
    const provided = Buffer.from(incoming[0] || '');
    if (incoming.length !== 1 || expected.length !== provided.length || !timingSafeEqual(expected, provided)) { response.writeHead(400).end('授权状态不匹配，请回到Morlet重试。'); return; }
    if (url.searchParams.has('error')) {
      response.writeHead(200).end('已取消授权，可以回到Morlet。');
      finish({ error: 'auth_denied' }); return;
    }
    const codes = url.searchParams.getAll('code');
    if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) { response.writeHead(400).end('缺少授权结果'); return; }
    response.writeHead(200).end('授权已返回。Morlet正在完成连接，请回到手账查看结果。');
    finish({ code: codes[0] });
  });
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(failure('setup_required')));
    server.listen(Number(callback.port), '127.0.0.1', resolve);
  });
  abort = () => finish({ error: 'aborted' });
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => finish({ error: 'auth_expired' }), timeoutMs);
  if (signal?.aborted) abort();
  return { code, close: () => finish({ error: 'aborted' }) };
}

/** Official consent and PKCE, with private tokens confined to the current Mac. */
export function createOAuthConnections({ runner, root = ROOT, fetchImpl = fetch, openURL = async () => {}, now = Date.now, callbackTimeoutMs = 180000, configPath = join(root, '.runtime/connections/oauth-config.json'), env = process.env } = {}) {
  const tokenPath = join(root, '.runtime/connections/x-oauth.json');
  let activeX = false;
  const config = async desired => {
    // The deployment provisions its native/public application. Ordinary users
    // only give consent; an application secret never travels over the bridge.
    let value = desired?.oauthApp;
    if (value && (Object.keys(value).some(key => !['clientId', 'redirectUri'].includes(key)) || typeof value.redirectUri !== 'string')) throw failure('oauth_client_missing');
    if (!value) {
      try { value = (await readPrivateJSON(configPath)).x; } catch (error) { if (error.code !== 'ENOENT') throw failure('oauth_client_missing'); }
    }
    value = value || { clientId: env.PA_X_CLIENT_ID, clientSecret: env.PA_X_CLIENT_SECRET, redirectUri: env.PA_X_REDIRECT_URI };
    if (!value || typeof value.clientId !== 'string' || !/^[A-Za-z0-9_:.+=\/-]{8,256}$/.test(value.clientId) || value.clientSecret !== undefined && (typeof value.clientSecret !== 'string' || !value.clientSecret || value.clientSecret.length > 1024 || /[\x00-\x20]/.test(value.clientSecret))) throw failure('oauth_client_missing');
    return { ...value, callback: parseCallbackURI(value.redirectUri || X_CALLBACK) };
  };
  const request = async (url, init = {}, signal) => readResponse(await fetchImpl(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) }));
  const exchange = async (settings, fields, signal) => {
    const body = new URLSearchParams(fields);
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (settings.clientSecret) headers.Authorization = 'Basic ' + Buffer.from(settings.clientId + ':' + settings.clientSecret).toString('base64');
    else body.set('client_id', settings.clientId);
    const data = await request(TOKEN_URL, { method: 'POST', headers, body }, signal);
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8192 || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' || typeof data.scope !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || data.refresh_token.length > 8192)) throw failure('probe_failed');
    return { accessToken: data.access_token, refreshToken: data.refresh_token, scopes: data.scope.split(' '), expiresAt: now() + data.expires_in * 1000, clientId: settings.clientId };
  };
  const status = error => result(['setup_required', 'oauth_client_missing'].includes(error.code) ? 'setup_required' : error.code === 'auth_denied' ? 'error' : error.code === 'credential_expired' || error.code === 'auth_expired' ? 'expired' : ['permission_required', 'credits_required'].includes(error.code) ? 'limited' : 'offline', error.code === 'aborted' ? 'probe_failed' : ['setup_required', 'oauth_client_missing', 'auth_denied', 'auth_expired', 'credential_expired', 'permission_required', 'probe_failed', 'credits_required', 'rate_limited', 'account_changed'].includes(error.code) ? error.code : 'network_error');
  async function tokenLock(signal, operation) {
    await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
    let release;
    for (let attempt = 0; !release; attempt++) {
      assertActive(signal);
      try { release = acquireCompanionLock(dirname(tokenPath)); }
      catch (error) {
        if (error.code !== 'COMPANION_ALREADY_RUNNING' || attempt >= 60) throw error;
        await delay(250, undefined, { signal });
      }
    }
    try { return await operation(); } finally { release(); }
  }
  async function identity(desired, signal) {
    const settings = await config(desired);
    let token;
    try {
      token = await tokenLock(signal, async () => {
        let value = await readPrivateJSON(tokenPath);
        if (value.clientId !== settings.clientId || !value.accessToken || !Array.isArray(value.scopes)) throw failure('credential_expired');
        if (value.expiresAt <= now() + 30000) {
          if (!value.refreshToken) throw failure('credential_expired');
          const renewed = await exchange(settings, { grant_type: 'refresh_token', refresh_token: value.refreshToken }, signal);
          value = { ...renewed, refreshToken: renewed.refreshToken || value.refreshToken };
          await writePrivateJSON(tokenPath, value, signal);
        }
        return value;
      });
    } catch (error) { if (error.code === 'ENOENT') throw failure('not_authenticated'); throw error; }
    const headers = { Authorization: 'Bearer ' + token.accessToken };
    const profile = await request('https://api.x.com/2/users/me', { headers }, signal);
    if (!/^\d{1,32}$/.test(profile.data?.id || '') || !/^[A-Za-z0-9_]{1,15}$/.test(profile.data?.username || '')) throw failure('probe_failed');
    if (desired.account && desired.account.toLowerCase() !== profile.data.username.toLowerCase()) throw failure('account_changed');
    return { token, headers, profile: profile.data };
  }

  const api = {
    async googleConnect(desired, { signal, onProgress = () => {}, probe } = {}) {
      if (!desired?.enabled) return result('offline', 'not_authenticated');
      if (!EMAIL.test(desired.account || '') || desired.account.startsWith('-') || desired.account.length > 254) return result('awaiting_authorization', 'permission_required');
      if (typeof runner !== 'function') return result('setup_required', 'tool_missing');
      onProgress(result('awaiting_authorization', 'auth_pending'));
      let emitted;
      const args = ['auth', 'add', desired.account, '--services', 'gmail,calendar,drive,contacts,docs,sheets', '--readonly', '--drive-scope', 'readonly', '--force-consent'];
      const response = await runner('gog', args, {
        signal, timeoutMs: callbackTimeoutMs,
        onOutput(output) {
          const verificationUrl = googleAuthorizationURL(output);
          if (verificationUrl && verificationUrl !== emitted) {
            emitted = verificationUrl;
            onProgress(result('awaiting_authorization', 'auth_pending', { auth: { verificationUrl, expiresAt: now() + callbackTimeoutMs } }));
          }
        },
      });
      if (signal?.aborted) return result('offline', 'probe_failed');
      if (response.errorCode === 'TIMEOUT') return result('expired', 'auth_expired');
      if (response.errorCode === 'MISSING_TOOL') return result('setup_required', 'tool_missing');
      if (response.exitCode !== 0 || response.errorCode) {
        if (/credentials\.json|client.?secret|no.?client|oauth.?client/i.test(response.stderr || '')) return result('setup_required', 'oauth_client_missing');
        const error = response.stderr || '';
        if (/invalid_grant|invalid.?token|token.?expired|credential.?expired/i.test(error)) return result('expired', 'credential_expired');
        if (/keychain|permission[_ ]denied|operation not permitted/i.test(error)) return result('limited', 'permission_required');
        if (/access_denied|denied|cancel/i.test(error)) return result('error', 'auth_denied');
        return result('offline', 'network_error');
      }
      return typeof probe === 'function' ? probe(desired, signal) : result('checking', 'auth_pending');
    },
    async xProbe(desired, { signal } = {}) {
      if (!desired?.enabled) return result('offline', 'not_authenticated');
      try {
        const { token, headers, profile } = await identity(desired, signal);
        const permissions = [{ id: 'profile', label: '读取 X 账号身份', granted: token.scopes.includes('users.read'), verified: token.scopes.includes('users.read') }, { id: 'read', label: '读取 X 内容', granted: token.scopes.includes('tweet.read'), verified: false }];
        if (permissions[1].granted) {
          try {
            await request('https://api.x.com/2/users/' + profile.id + '/timelines/reverse_chronological?max_results=5', { headers }, signal);
            permissions[1].verified = true;
          } catch (error) {
            assertActive(signal);
            if (['credential_expired', 'credits_required', 'rate_limited'].includes(error.code)) throw error;
          }
        }
        const complete = permissions.every(permission => permission.verified);
        return result(complete ? 'connected' : 'limited', complete ? 'ok' : 'partial', { account: profile.username, permissions });
      } catch (error) { return error.code === 'not_authenticated' ? result('awaiting_authorization', 'not_authenticated') : status(error); }
    },
    async xTimeline(desired, { signal } = {}) {
      if (!desired?.enabled) throw failure('not_authenticated');
      const { token, headers, profile } = await identity(desired, signal);
      if (!token.scopes.includes('tweet.read')) throw failure('permission_required');
      const query = new URLSearchParams({ max_results: '20', 'post.fields': 'created_at,author_id,note_post', expansions: 'author_id', 'user.fields': 'username' });
      const page = await request(`https://api.x.com/2/users/${profile.id}/timelines/reverse_chronological?${query}`, { headers }, signal);
      if (page.data !== undefined && !Array.isArray(page.data) || page.errors?.length && !page.data) throw failure('probe_failed');
      const authors = new Map((page.includes?.users || []).map(user => [user.id, user.username]));
      const posts = (page.data || []).slice(0, 20).map(post => {
        if (!/^\d{1,32}$/.test(post.id || '') || typeof post.text !== 'string' || !Number.isFinite(Date.parse(post.created_at))) throw failure('probe_failed');
        const full = post.note_post?.text || post.text, username = authors.get(post.author_id);
        return { id: post.id, text: Array.from(full).slice(0, 6000).join(''), complete: Array.from(full).length <= 6000,
          createdAt: post.created_at, url: `https://x.com/${/^[A-Za-z0-9_]{1,15}$/.test(username || '') ? username : 'i/web'}/status/${post.id}` };
      });
      return { posts, truncated: Boolean(page.meta?.next_token), coverage: 'Following timeline, first 20 posts only; no external links or full threads read.' };
    },
    async xConnect(desired, { signal, onProgress = () => {} } = {}) {
      if (!desired?.enabled) return result('offline', 'not_authenticated');
      if (activeX) return result('awaiting_authorization', 'auth_pending');
      activeX = true;
      let listener;
      try {
        const settings = await config(desired);
        assertActive(signal);
        const state = randomBytes(32).toString('base64url');
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        listener = await listenForCode(settings.callback, state, { signal, timeoutMs: callbackTimeoutMs });
        const url = new URL('https://x.com/i/oauth2/authorize');
        url.search = new URLSearchParams({ response_type: 'code', client_id: settings.clientId, redirect_uri: settings.callback.href, scope: X_SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
        onProgress(result('awaiting_authorization', 'auth_pending', { auth: { verificationUrl: url.href, expiresAt: now() + callbackTimeoutMs } }));
        // Native browser open is best-effort; cloud UI still receives the official consent link.
        await openURL(url.href, signal).catch(() => {});
        const callback = await listener.code;
        if (callback.error) throw failure(callback.error);
        assertActive(signal);
        const token = await exchange(settings, { grant_type: 'authorization_code', code: callback.code, redirect_uri: settings.callback.href, code_verifier: verifier }, signal);
        await tokenLock(signal, () => writePrivateJSON(tokenPath, token, signal));
        return await api.xProbe(desired, { signal });
      } catch (error) { return status(error); }
      finally { listener?.close(); activeX = false; }
    },
    async xDisconnect() { await tokenLock(undefined, () => rm(tokenPath, { force: true })); },
  };
  return api;
}
