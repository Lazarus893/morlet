import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NANGO_APIS, nangoPathMatches, nangoServiceApis } from './nango-catalog.mjs';

// REST contract verified against Nango's HTTP API on 2026-10-23:
// /docs/reference/backend/http-api/{connect/sessions/create,connections/list,
// connections/get,connections/delete,proxy/get}. Only server code may use this
// client. The caller owns durable bindings, generation checks and run approvals.
const MAX_CONFIG_BYTES = 128 * 1024, MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const normalizedConfigs = new WeakSet();
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, ...details }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const ownKeys = (value, allowed, code = 'NANGO_INVALID_CONFIGURATION') => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(code);
};
function origin(value, { loopback = false } = {}) {
  let url;
  try { url = new URL(value); } catch { fail('NANGO_INVALID_CONFIGURATION'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    url.protocol !== 'https:' && !(loopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('NANGO_INVALID_CONFIGURATION');
  return url.origin;
}
function path(value, code = 'NANGO_OPERATION_FORBIDDEN') {
  if (typeof value !== 'string' || value.length > 4000 || !value.startsWith('/') || value.startsWith('//') || /[?#\\\x00-\x20\x7f]/.test(value)) fail(code);
  for (const segment of value.split('/').slice(1)) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { fail(code); }
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/\x00-\x1f\x7f]|%[0-9a-f]{2}/i.test(decoded)) fail(code);
  }
  return value;
}
function rule(value, access) {
  ownKeys(value, ['path', 'query', 'baseUrl', 'method', 'headers']);
  path(value.path, 'NANGO_INVALID_CONFIGURATION');
  const method = value.method || 'GET';
  if (access === 'read' ? method !== 'GET' : !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) fail('NANGO_INVALID_CONFIGURATION');
  if (!Array.isArray(value.query || []) || (value.query || []).length > 40 || (value.query || []).some(k => typeof k !== 'string' || !/^[A-Za-z][A-Za-z0-9_.\[\]-]{0,79}$/.test(k))) fail('NANGO_INVALID_CONFIGURATION');
  const headers = {};
  if (value.headers !== undefined) {
    if (!object(value.headers) || Object.keys(value.headers).length > 8) fail('NANGO_INVALID_CONFIGURATION');
    for (const [key, val] of Object.entries(value.headers)) {
      // Configuration may specify API versions, but never credential or routing overrides.
      if (!/^(accept|[a-z0-9-]+-version)$/i.test(key) || typeof val !== 'string' || val.length > 200 || /[\r\n]/.test(val)) fail('NANGO_INVALID_CONFIGURATION');
      headers[key] = val;
    }
  }
  return { path: value.path, method, query: [...new Set(value.query || [])], baseUrl: origin(value.baseUrl), headers, access };
}
function normalizeConfig(input, env) {
  ownKeys(input, ['baseUrl', 'publicApiOrigin', 'connectOrigin', 'secretKeyEnv', 'instanceId', 'integrations', 'timeoutMs', 'maxResponseBytes']);
  if (!identifier(input.instanceId) || !object(input.integrations) || !Object.keys(input.integrations).length || Object.keys(input.integrations).length > 40) fail('NANGO_INVALID_CONFIGURATION');
  const baseUrl = origin(input.baseUrl || 'https://api.nango.dev', { loopback: true });
  const secretKeyEnv = input.secretKeyEnv || 'NANGO_SECRET_KEY';
  if (!/^[A-Z][A-Z0-9_]{1,100}$/.test(secretKeyEnv)) fail('NANGO_INVALID_CONFIGURATION');
  const secretKey = env?.[secretKeyEnv];
  if (typeof secretKey !== 'string' || secretKey.length < 8 || secretKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(secretKey)) fail('NANGO_SECRET_MISSING');
  const timeoutMs = input.timeoutMs ?? 20_000, maxResponseBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) fail('NANGO_INVALID_CONFIGURATION');
  const integrations = Object.create(null);
  for (const [service, value] of Object.entries(input.integrations)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(service)) fail('NANGO_INVALID_CONFIGURATION');
    ownKeys(value, ['integrationId', 'readRules', 'writeRules']);
    if (!identifier(value.integrationId)) fail('NANGO_INVALID_CONFIGURATION');
    for (const key of ['readRules', 'writeRules']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 100)) fail('NANGO_INVALID_CONFIGURATION');
    const readRules = (value.readRules || []).map(r => rule(r, 'read')), writeRules = (value.writeRules || []).map(r => rule(r, 'write'));
    integrations[service] = { integrationId: value.integrationId, readRules, writeRules };
  }
  const config = { baseUrl, publicApiOrigin: origin(input.publicApiOrigin || baseUrl, { loopback: true }), connectOrigin: origin(input.connectOrigin || (baseUrl === 'https://api.nango.dev' ? 'https://connect.nango.dev' : baseUrl), { loopback: true }), secretKeyEnv, instanceId: input.instanceId, integrations, timeoutMs, maxResponseBytes };
  // Neither JSON snapshots nor accidental object logging may reveal the key.
  Object.defineProperty(config, 'secretKey', { value: secretKey, enumerable: false });
  const freeze = value => { if (object(value) || Array.isArray(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
  freeze(config);
  normalizedConfigs.add(config);
  return config;
}

/** Missing file means disabled; malformed/insecure configuration fails closed. */
export function loadNangoConfig(root, { env = process.env } = {}) {
  if (typeof root !== 'string' || !root) fail('NANGO_INVALID_CONFIGURATION');
  const file = join(root, '.runtime', 'connections', 'nango.json');
  let fd;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid() || stat.size > MAX_CONFIG_BYTES) fail('NANGO_PRIVATE_CONFIG_REQUIRED');
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) fail('NANGO_PRIVATE_CONFIG_REQUIRED');
    let parsed;
    try { parsed = JSON.parse(readFileSync(fd, 'utf8')); } catch { fail('NANGO_INVALID_CONFIGURATION'); }
    return normalizeConfig(parsed, env);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code?.startsWith('NANGO_')) throw error;
    fail('NANGO_CONFIG_UNAVAILABLE');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Config is server-authored. Browser input must never be used as configuration. */
export function createNangoClient({ config: input, env = process.env, fetchImpl = globalThis.fetch, now = Date.now, authorizeWrite, authorize } = {}) {
  if (!input) fail('NANGO_NOT_CONFIGURED');
  // Accept loadNangoConfig's non-enumerable secret without returning it anywhere.
  const config = normalizedConfigs.has(input) ? input : normalizeConfig(input, env);
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || authorizeWrite !== undefined && typeof authorizeWrite !== 'function' || authorize !== undefined && typeof authorize !== 'function') fail('NANGO_INVALID_CONFIGURATION');
  const revoked = new Set(), inFlight = new Map();
  const serviceConfig = service => {
    if (typeof service !== 'string' || !Object.hasOwn(config.integrations, service)) fail('NANGO_SERVICE_NOT_CONFIGURED');
    return config.integrations[service];
  };
  const ownerTag = ownerId => {
    if (!identifier(ownerId)) fail('NANGO_INVALID_REQUEST');
    return hash(config.instanceId + '\0' + ownerId);
  };
  const binding = ({ service, ownerId, connectionId }) => {
    const integration = serviceConfig(service), owner = ownerTag(ownerId);
    if (!identifier(connectionId)) fail('NANGO_INVALID_REQUEST');
    return { service, ownerId, owner, connectionId, integrationId: integration.integrationId, key: JSON.stringify([owner, integration.integrationId, connectionId]) };
  };
  const alive = scoped => { if (revoked.has(scoped.key)) fail('NANGO_CONNECTION_REVOKED'); };
  async function request(endpoint, { method = 'GET', body, headers = {}, signal, scoped, guard, maxBytes = config.maxResponseBytes, kind = 'management' } = {}) {
    if (authorize && await authorize() === false) fail('NANGO_CONNECTION_REVOKED');
    if (guard && await guard() === false) fail('NANGO_CONNECTION_PROTECTED');
    if (scoped) alive(scoped);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort('timeout'), config.timeoutMs);
    const joined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    if (scoped) { if (!inFlight.has(scoped.key)) inFlight.set(scoped.key, new Set()); inFlight.get(scoped.key).add(controller); }
    try {
      const response = await fetchImpl(config.baseUrl + endpoint, { method, headers: { Authorization: 'Bearer ' + config.secretKey, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: joined, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail('NANGO_REDIRECT_REJECTED'); }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); fail('NANGO_RESPONSE_TOO_LARGE'); }
      const chunks = []; let bytes = 0;
      if (response.body) for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > maxBytes) fail('NANGO_RESPONSE_TOO_LARGE'); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      let value;
      try { value = raw ? JSON.parse(raw) : null; } catch { if (response.ok) fail('NANGO_INVALID_RESPONSE'); }
      if (!response.ok) {
        const authError = ['invalid_credentials', 'connection_missing_credentials', 'invalid_token'].includes(value?.error?.code);
        const disabled = kind === 'proxy' && (value?.error?.errors?.some?.(e => e?.reason === 'accessNotConfigured') || value?.error?.details?.some?.(e => e?.reason === 'SERVICE_DISABLED'));
        const code = disabled ? 'NANGO_API_DISABLED' : authError || response.status === 424 || kind === 'proxy' && response.status === 401 ? 'NANGO_AUTH_REQUIRED' : response.status === 401 ? 'NANGO_UNAUTHORIZED' : kind === 'proxy' && response.status === 402 ? 'NANGO_CREDITS_REQUIRED' : response.status === 403 ? 'NANGO_FORBIDDEN' : response.status === 404 ? 'NANGO_NOT_FOUND' : response.status === 429 ? 'NANGO_RATE_LIMITED' : response.status >= 500 ? 'NANGO_UNAVAILABLE' : 'NANGO_REQUEST_FAILED';
        const retry = Number(response.headers.get('retry-after'));
        fail(code, { status: response.status, ...(response.status === 429 && Number.isFinite(retry) && retry >= 0 ? { retryAfterSeconds: Math.min(retry, 3600) } : {}) });
      }
      if (joined.aborted) fail('NANGO_CANCELLED');
      if (scoped) alive(scoped);
      if (authorize && await authorize() === false) fail('NANGO_CONNECTION_REVOKED');
      return value;
    } catch (error) {
      // Durable authorization errors belong to the caller, not the upstream.
      // Recheck after every failed I/O too so a retry cannot cross revocation.
      if (authorize && await authorize() === false) fail('NANGO_CONNECTION_REVOKED');
      if (scoped && revoked.has(scoped.key)) fail('NANGO_CONNECTION_REVOKED');
      if (joined.aborted) fail(controller.signal.reason === 'timeout' ? 'NANGO_TIMEOUT' : 'NANGO_CANCELLED');
      if (error.code?.startsWith('NANGO_') || error.code?.startsWith('SOURCE_') || error.code === 'FORBIDDEN') throw error;
      fail('NANGO_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      if (scoped) { const running = inFlight.get(scoped.key); running?.delete(controller); if (!running?.size) inFlight.delete(scoped.key); }
    }
  }
  function describe(value, service, owner, connectionId, attemptId) {
    if (!object(value) || value.provider_config_key !== serviceConfig(service).integrationId || !identifier(value.connection_id) ||
      connectionId && value.connection_id !== connectionId || value.tags?.end_user_id !== owner || value.tags?.xiaoman_instance !== config.instanceId ||
      attemptId && value.tags?.xiaoman_attempt !== attemptId) fail('NANGO_OWNER_MISMATCH');
    if (!Array.isArray(value.errors)) fail('NANGO_INVALID_RESPONSE');
    const rawScope = value.credentials?.scope ?? value.credentials?.raw?.scope;
    const scopes = typeof rawScope === 'string' ? rawScope.split(/[ ,]+/) : Array.isArray(rawScope) ? rawScope : [];
    return { service, connectionId: value.connection_id, integrationId: value.provider_config_key,
      provider: typeof value.provider === 'string' && /^[a-z0-9_-]{1,100}$/i.test(value.provider) ? value.provider : null,
      account: null, scopes: [...new Set(scopes.filter(v => typeof v === 'string' && v.length <= 300 && !/[\s\x00-\x1f]/.test(v)))].slice(0, 100),
      state: value.errors.some(e => e?.type === 'auth') ? 'expired' : 'connected', checkedAt: new Date(now()).toISOString() };
  }
  async function candidates({ service, ownerId, connectionId, attemptId, signal }) {
    const integration = serviceConfig(service), owner = ownerTag(ownerId);
    if (connectionId !== undefined && !identifier(connectionId) || attemptId !== undefined && !identifier(attemptId)) fail('NANGO_INVALID_REQUEST');
    const query = new URLSearchParams({ 'tags[end_user_id]': owner, 'tags[xiaoman_instance]': config.instanceId, limit: '100', page: '0', ...(connectionId ? { connectionId } : {}), ...(attemptId ? { 'tags[xiaoman_attempt]': attemptId } : {}) });
    const value = await request('/connections?' + query, { signal, maxBytes: 512 * 1024 });
    if (!Array.isArray(value?.connections) || value.connections.length >= 100) fail('NANGO_INVALID_RESPONSE');
    const matches = value.connections.filter(v => v?.provider_config_key === integration.integrationId && (!connectionId || v.connection_id === connectionId));
    return matches.map(value => ({ ...describe(value, service, owner, connectionId, attemptId), ...(attemptId ? { attemptId } : {}), createdAt: Number.isFinite(Date.parse(value.created)) ? new Date(value.created).toISOString() : null }));
  }
  async function lookup(args) {
    const matches = await candidates(args);
    if (matches.length > 1) fail('NANGO_AMBIGUOUS_CONNECTION');
    return matches[0] || null;
  }
  async function verifyConnection(args) {
    const scoped = binding(args); alive(scoped);
    // Verify ownership without requesting credentials first. The following get
    // refreshes expired access tokens; its credentials never leave this closure.
    const owned = await lookup(args);
    if (!owned) fail('NANGO_NOT_FOUND');
    const query = new URLSearchParams({ provider_config_key: scoped.integrationId });
    const value = await request('/connections/' + encodeURIComponent(scoped.connectionId) + '?' + query, { signal: args.signal, scoped, maxBytes: 512 * 1024 });
    const result = describe(value, args.service, scoped.owner, scoped.connectionId, args.attemptId);
    if (result.state === 'expired') fail('NANGO_AUTH_REQUIRED');
    return result;
  }
  function sessionResult(value) {
    const data = value?.data;
    const expires = Date.parse(data?.expires_at);
    let url;
    try { url = new URL(data?.connect_link); } catch { fail('NANGO_CONNECT_LINK_UNAVAILABLE'); }
    if (url.origin !== config.connectOrigin || url.username || url.password || url.hash || !Number.isFinite(expires) || expires <= now() || expires > now() + 31 * 60_000) fail('NANGO_INVALID_RESPONSE');
    // Official Connect UI option. The prebuilt SPA otherwise defaults to
    // api.nango.dev, even for links minted by a self-hosted Nango server.
    // Always replace an upstream query override with trusted deployment config.
    url.searchParams.set('apiURL', config.publicApiOrigin);
    return { connectUrl: url.href, expiresAt: new Date(expires).toISOString() };
  }
  async function beginConnect({ service, ownerId, attemptId, signal }) {
    const integration = serviceConfig(service), owner = ownerTag(ownerId);
    if (!identifier(attemptId)) fail('NANGO_INVALID_REQUEST');
    return sessionResult(await request('/connect/sessions', { method: 'POST', signal, body: { allowed_integrations: [integration.integrationId], tags: { end_user_id: owner, xiaoman_instance: config.instanceId, xiaoman_attempt: attemptId } }, maxBytes: 64 * 1024 }));
  }
  async function findConnection(args) {
    if (!identifier(args.attemptId)) fail('NANGO_INVALID_REQUEST');
    const value = await lookup(args);
    return value ? verifyConnection({ ...args, connectionId: value.connectionId }) : null;
  }
  async function findConnections(args) {
    if (!identifier(args.attemptId)) fail('NANGO_INVALID_REQUEST');
    // Metadata only: revocation must work even when provider credentials expire.
    return candidates(args);
  }
  async function reconnect(args) {
    const scoped = binding(args); alive(scoped);
    if (!identifier(args.attemptId)) fail('NANGO_INVALID_REQUEST');
    // Do not require valid credentials to reconnect an expired connection.
    if (!await lookup({ ...args, attemptId: undefined })) fail('NANGO_NOT_FOUND');
    return sessionResult(await request('/connect/sessions/reconnect', { method: 'POST', signal: args.signal, scoped, body: { connection_id: scoped.connectionId, integration_id: scoped.integrationId, tags: { end_user_id: scoped.owner, xiaoman_instance: config.instanceId, xiaoman_attempt: args.attemptId } }, maxBytes: 64 * 1024 }));
  }
  async function disconnect(args, { authorize: canDelete } = {}) {
    if (canDelete !== undefined && typeof canDelete !== 'function') fail('NANGO_INVALID_REQUEST');
    const scoped = binding(args);
    if (canDelete && await canDelete() === false) fail('NANGO_CONNECTION_PROTECTED');
    const owned = await lookup(args);
    if (!owned) return { disconnected: true };
    if (canDelete && await canDelete() === false) fail('NANGO_CONNECTION_PROTECTED');
    // Check attempt ownership before fencing: an old cleanup job must never
    // revoke a connection ID that has since completed a different reconnect.
    const alreadyRevoked = revoked.has(scoped.key);
    revoked.add(scoped.key);
    for (const controller of inFlight.get(scoped.key) || []) controller.abort('revoked');
    const query = new URLSearchParams({ provider_config_key: scoped.integrationId });
    try { await request('/connections/' + encodeURIComponent(scoped.connectionId) + '?' + query, { method: 'DELETE', signal: args.signal, guard: canDelete, maxBytes: 64 * 1024 }); }
    catch (error) {
      if (error.code === 'NANGO_CONNECTION_PROTECTED' && !alreadyRevoked) revoked.delete(scoped.key);
      if (error.code !== 'NANGO_NOT_FOUND') throw error;
    }
    return { disconnected: true };
  }
  async function proxy(args) {
    ownKeys(args, ['service', 'ownerId', 'connectionId', 'attemptId', 'method', 'endpoint', 'query', 'api', 'signal', 'body', 'approval'], 'NANGO_INVALID_REQUEST');
    const scoped = binding(args), integration = serviceConfig(args.service), endpoint = path(args.endpoint), method = args.method || 'GET';
    const apis = nangoServiceApis(args.service), api = args.api || (apis.length === 1 ? apis[0] : null);
    const builtIn = apis.includes(api) ? NANGO_APIS[api] : null;
    const selected = method === 'GET' && builtIn?.routes.find(r => nangoPathMatches(r.path, endpoint));
    const configured = [...integration.readRules, ...integration.writeRules].find(r => r.method === method && nangoPathMatches(r.path, endpoint));
    const allowed = selected ? { ...selected, baseUrl: builtIn.baseUrl, headers: builtIn.headers || {}, access: 'read' } : configured;
    if (!allowed || args.api && !builtIn && !configured || method === 'GET' && args.body !== undefined) fail('NANGO_OPERATION_FORBIDDEN');
    if (!object(args.query || {})) fail('NANGO_INVALID_REQUEST');
    const query = new URLSearchParams();
    for (const [key, supplied] of Object.entries(args.query || {})) {
      if (!allowed.query.includes(key)) fail('NANGO_OPERATION_FORBIDDEN');
      const values = Array.isArray(supplied) ? supplied : [supplied];
      if (values.length > 100) fail('NANGO_INVALID_REQUEST');
      for (const value of values) {
        if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value) || String(value).length > 5000 || /[\x00-\x1f\x7f]/.test(String(value))) fail('NANGO_INVALID_REQUEST');
        query.append(key, String(value));
      }
    }
    let body;
    if (args.body !== undefined) {
      try { const serialized = JSON.stringify(args.body); if (serialized === undefined || Buffer.byteLength(serialized) > 128 * 1024) fail('NANGO_INVALID_REQUEST'); body = JSON.parse(serialized); }
      catch { fail('NANGO_INVALID_REQUEST'); }
    }
    if (query.toString().length > 16000) fail('NANGO_INVALID_REQUEST');
    await verifyConnection(args);
    const approvalQuery = Object.fromEntries([...new Set(query.keys())].map(key => { const values = query.getAll(key); return [key, values.length === 1 ? values[0] : values]; }));
    if (allowed.access === 'write' && (!authorizeWrite || await authorizeWrite({ service: scoped.service, ownerId: scoped.ownerId, connectionId: scoped.connectionId, method, endpoint, query: approvalQuery, body: body === undefined ? undefined : structuredClone(body), approval: args.approval }) !== true)) fail('NANGO_APPROVAL_REQUIRED');
    alive(scoped);
    return request('/proxy' + endpoint + (query.size ? '?' + query : ''), { method, body, signal: args.signal, scoped, kind: 'proxy', headers: { ...allowed.headers, 'Provider-Config-Key': scoped.integrationId, 'Connection-Id': scoped.connectionId, 'Base-Url-Override': allowed.baseUrl, Retries: '0' } });
  }
  return Object.freeze({ beginConnect, findConnection, findConnections, verifyConnection, reconnect, disconnect, proxy,
    services: () => Object.keys(config.integrations),
  });
}
