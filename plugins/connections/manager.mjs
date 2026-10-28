import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STALE_MS = 90_000;
const REPORT_STATES = new Set(['setup_required', 'awaiting_authorization', 'checking', 'connected', 'limited', 'expired', 'offline', 'error']);
const MESSAGES = {
  ok: '已连接，最近检查正常', partial: '部分权限可用，请完成剩余授权',
  not_authenticated: '尚未登录，请在当前 Mac 完成授权', permission_required: '需要在当前 Mac 补充权限',
  credential_expired: '授权已过期，请重新登录', device_missing: '当前 Mac 未检测到已连接的手机',
  device_unauthorized: '请在手机上确认信任或调试授权', tool_missing: '当前 Mac 尚未安装所需连接工具',
  device_multiple: '检测到多台手机，请只连接要使用的手机后重试',
  phone_recording_required: '手机已连接，请在手机确认录屏授权',
  phone_locked: '请先解锁手机，再确认录屏授权',
  phone_helper_missing: '手机尚未安装小满手机助手',
  phone_permissions_unsupported: '手机已连接，这类设备的自动化与录屏权限尚未接入验证',
  phone_automation_required: '请在手机允许调试控制权限',
  phone_permission_unverified: '手机已连接，部分权限暂时无法验证',
  phone_settings_opened: '已打开手机授权页，请点击「授权录屏」并确认系统弹窗',
  phone_settings_failed: '未能打开手机授权页，请在手机打开小满手机助手',
  setup_required: '请在当前 Mac 完成连接配置', network_error: '暂时无法访问服务，稍后会再次检查',
  probe_failed: '检查未成功，请在当前 Mac 查看连接配置', auth_pending: '请完成授权页面中的确认',
  auth_expired: '本次授权已过期，请重新开始', auth_denied: '本次授权未获允许',
  oauth_client_missing: 'Morlet尚未配置这个服务的 OAuth 应用，请由部署方完成配置后再授权',
  credits_required: 'X 内容服务额度不可用，请联系Morlet部署方',
  rate_limited: '服务暂时限流，稍后会再次检查',
  account_changed: '当前登录账号与已授权账号不同，请重新确认授权',
  native_helper_missing: '当前 Mac 尚未安装文件授权助手，请先完成本机安装',
  full_disk_manual: '已在当前 Mac 打开完全磁盘访问设置，请在系统设置中完成确认；此操作不代表已获得全盘权限',
};
const DEFINITIONS = {
  google: { title: 'Google 套件', scopeDescription: 'Gmail、日历、云端硬盘与联系人；当前 Mac 保存凭据', permissions: { gmail: 'Gmail', calendar: '日历', drive: '云端硬盘', contacts: '联系人' } },
  files: { title: '本地文件', scopeDescription: '当前 Mac 上操作系统允许读取的文件；只读，不自动上传文件内容', permissions: { readable: '文件读取', full_disk: '完全磁盘访问' } },
  phone: { title: '手机', scopeDescription: '当前 Mac 的手机；自动化检查系统输入权限，录屏检查有效授权；不启动任务或录制', permissions: { paired: '手机配对', device: '设备连接', automation: '手机自动化', recording: '录屏权限' } },
  github: { title: 'GitHub', scopeDescription: '账号及已授权的仓库访问；不自动发布或修改仓库', permissions: { profile: '账号身份', repos: '仓库列表读取' } },
  x: { title: 'X', scopeDescription: '账号及内容读取；不自动发送或发布', permissions: { profile: '账号身份', read: '内容读取' } },
};
const IDS = Object.keys(DEFINITIONS);
const FILE_SCOPES = {
  'all-readable-files': DEFINITIONS.files.scopeDescription,
  'selected-files': '在当前 Mac 的系统窗口中选择的文件与文件夹；只读，授权保留在本机',
  'common-folders': '默认常用目录：下载、用户目录、文档（只读）；用户目录包含下载和文档，最终授权由 Mac 系统窗口确认',
};
const clone = value => JSON.parse(JSON.stringify(value));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const iso = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(value).digest();
function keys(value, allowed) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_REQUEST');
}
function account(id, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 254) fail('INVALID_REQUEST');
  if (id === 'google' && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)) fail('INVALID_REQUEST');
  if (['github', 'x'].includes(id) && !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) fail('INVALID_REQUEST');
  if (['files', 'phone'].includes(id) && !/^[a-zA-Z0-9 ._-]{1,80}$/.test(value)) fail('INVALID_REQUEST');
  return value;
}
function permissions(id, value) {
  if (!Array.isArray(value) || value.length > 8) fail('INVALID_REQUEST');
  const seen = new Set();
  return value.map(permission => {
    keys(permission, ['id', 'label', 'granted', 'verified']);
    if (!Object.hasOwn(DEFINITIONS[id].permissions, permission.id) || seen.has(permission.id) || typeof permission.granted !== 'boolean' || typeof permission.verified !== 'boolean') fail('INVALID_REQUEST');
    seen.add(permission.id);
    return { id: permission.id, label: DEFINITIONS[id].permissions[permission.id], granted: permission.granted, verified: permission.verified && permission.granted };
  });
}
function authorization(id, value, timestamp) {
  keys(value, ['verificationUrl', 'code', 'expiresAt']);
  if (!['google', 'github', 'x'].includes(id) || typeof value.verificationUrl !== 'string' || value.verificationUrl.length > 4096 || value.code !== undefined && (typeof value.code !== 'string' || !/^[A-Z0-9 -]{4,32}$/.test(value.code))) fail('INVALID_REQUEST');
  let url;
  try { url = new URL(value.verificationUrl); } catch { fail('INVALID_REQUEST'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('INVALID_REQUEST');
  if (id === 'github' && (url.hostname !== 'github.com' || url.pathname !== '/login/device' || url.search)) fail('INVALID_REQUEST');
  if (id === 'x') {
    if (url.hostname !== 'x.com' || url.pathname !== '/i/oauth2/authorize') fail('INVALID_REQUEST');
    const allowed = new Set(['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method']);
    for (const key of url.searchParams.keys()) if (!allowed.has(key)) fail('INVALID_REQUEST');
    if (url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256') fail('INVALID_REQUEST');
  }
  if (id === 'google') {
    if (url.hostname !== 'accounts.google.com' || !['/o/oauth2/auth', '/o/oauth2/v2/auth', '/o/oauth2/device/usercode'].includes(url.pathname)) fail('INVALID_REQUEST');
    const allowed = new Set(['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'access_type', 'prompt', 'include_granted_scopes', 'login_hint', 'code_challenge', 'code_challenge_method', 'user_code']);
    for (const key of url.searchParams.keys()) if (!allowed.has(key)) fail('INVALID_REQUEST');
  }
  const expiry = typeof value.expiresAt === 'number' ? value.expiresAt : Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= timestamp || expiry > timestamp + 30 * 60_000) fail('INVALID_REQUEST');
  return { verificationUrl: url.href, ...(value.code === undefined ? {} : { code: value.code }), expiresAt: iso(expiry) };
}
function emptyItem(id) {
  return { id, ...DEFINITIONS[id], enabled: false, generation: 0, state: 'unlinked', message: '尚未连接', checkedAt: null, lastSuccessAt: null, account: null, scope: null,
    permissions: Object.entries(DEFINITIONS[id].permissions).map(([id, label]) => ({ id, label, granted: false, verified: false })) };
}
function initial() {
  return { revision: 0, stateVersion: 0, checkedAt: null, bridge: { paired: false, online: false, name: null, lastSeenAt: null, hash: null }, items: IDS.map(emptyItem), commands: [], events: [] };
}

/** Durable authority/status only. Credentials and file contents stay on the Mac. */
export function createConnectionManager({ root, now = Date.now, intervalMs = 15_000, env = process.env, cloudServices = [] } = {}) {
  const cloud = new Set(cloudServices);
  if ([...cloud].some(id => !['google', 'github', 'x'].includes(id))) fail('INVALID_CONFIGURATION');
  if (typeof root !== 'string' || typeof now !== 'function' || !Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) fail('INVALID_CONFIGURATION');
  const directory = join(root, '.runtime', 'connections');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, 'state.sqlite');
  if (!existsSync(path)) { try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  chmodSync(path, 0o600);
  let db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)');
  const secure = () => { for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600); };
  const read = () => { const row = db.prepare('SELECT data FROM connections WHERE id=1').get(); return row ? JSON.parse(row.data) : initial(); };
  const save = state => { db.prepare('INSERT INTO connections(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(state)); };
  function transaction(operation) {
    if (!db) fail('STORAGE_UNAVAILABLE');
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(read()); db.exec('COMMIT'); secure(); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function event(state, id, kind) {
    state.stateVersion += 1;
    state.events.unshift({ id: randomUUID(), connectionId: id, kind, at: iso(now()), version: state.stateVersion });
    state.events = state.events.slice(0, 30);
  }
  function setState(state, item, status, message) {
    if (!['connected', 'limited'].includes(status)) item.permissions = item.permissions.map(permission => ({ ...permission, verified: false }));
    if (item.state !== status || item.message !== message) { item.state = status; item.message = message; event(state, item.id, status); }
  }
  function tick(state) {
    const timestamp = now();
    state.checkedAt = iso(timestamp);
    const online = state.bridge.paired && state.bridge.lastSeenAt !== null && timestamp - Date.parse(state.bridge.lastSeenAt) <= STALE_MS;
    if (online !== state.bridge.online) { state.bridge.online = online; event(state, 'bridge', online ? 'online' : 'offline'); }
    for (const item of state.items) {
      if (!item.enabled) continue;
      if (item.auth && Date.parse(item.auth.expiresAt) <= timestamp) { delete item.auth; setState(state, item, 'expired', MESSAGES.auth_expired); }
      else if (item.provider === 'nango') {
        if (['connected', 'limited'].includes(item.state) && (!item.checkedAt || timestamp - Date.parse(item.checkedAt) > 5 * 60_000)) setState(state, item, 'offline', '云端连接检查已超时，请重试');
      }
      else if (!online) setState(state, item, 'offline', state.bridge.paired ? '当前 Mac 已离线，等待重新连接' : '请先配对当前 Mac');
      else if (['connected', 'limited'].includes(item.state) && (!item.checkedAt || timestamp - Date.parse(item.checkedAt) > STALE_MS)) setState(state, item, 'offline', '这项连接的检查已超时，等待当前 Mac 重新检查');
    }
    state.commands = state.commands.filter(command => timestamp - Date.parse(command.createdAt) <= 10 * 60_000);
  }
  function publicState(state) {
    return clone({ revision: state.revision, stateVersion: state.stateVersion, checkedAt: state.checkedAt, nextCheckAt: iso(now() + intervalMs),
      monitor: { running: Boolean(db), intervalMs, staleAfterMs: STALE_MS },
      bridge: { paired: state.bridge.paired, online: state.bridge.online, name: state.bridge.name, lastSeenAt: state.bridge.lastSeenAt },
      items: state.items.map(({ enabled, generation, scope, binding, pendingReconnect, attemptId, attemptExpiresAt, ...item }) => ({ ...item, connectionProvider: item.provider === 'nango' || !enabled && cloud.has(item.id) ? 'nango' : 'local', cloudAvailable: cloud.has(item.id), ...(item.id === 'files' ? { scopeDescription: FILE_SCOPES[scope] || item.scopeDescription } : item.provider === 'nango' || !enabled && cloud.has(item.id) ? { scopeDescription: '由私有连接服务保存授权；只读访问，不自动发布或修改内容' } : {}), actionLabel: item.state === 'connected' ? '管理授权' : item.state === 'revoked' || item.state === 'unlinked' ? '开始授权' : '继续授权' })), events: state.events });
  }
  function authorized(state, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !state.bridge.paired || !state.bridge.hash) fail('BRIDGE_UNAUTHORIZED');
    if (!timingSafeEqual(hash(token), Buffer.from(state.bridge.hash, 'hex'))) fail('BRIDGE_UNAUTHORIZED');
  }
  function enqueue(state, item, kind, values = {}) {
    // A refresh must not replace an authorization command the Mac has not received.
    if (kind === 'check' && state.commands.some(command => command.id === item.id && command.generation === item.generation && ['connect', 'grant', 'settings'].includes(command.kind))) return;
    state.commands = state.commands.filter(command => command.id !== item.id);
    state.commands.push({ commandId: randomUUID(), id: item.id, kind, values, createdAt: iso(now()), generation: item.generation });
    state.commands = state.commands.slice(-20);
  }
  // A process restart never treats a persisted heartbeat as a fresh observation.
  transaction(state => {
    state.bridge.lastSeenAt = null; state.bridge.online = false;
    for (const item of state.items) if (item.enabled) {
      item.generation += 1; delete item.auth;
      item.permissions = item.permissions.map(permission => ({ ...permission, verified: false }));
      setState(state, item, item.provider === 'nango' ? 'checking' : 'offline', item.provider === 'nango' ? '正在检查云端授权' : '服务已重启，等待当前 Mac 重新检查');
      if (item.provider !== 'nango') enqueue(state, item, 'check');
    }
    save(state);
  });
  const timer = setInterval(() => { try { transaction(state => { tick(state); save(state); }); } catch { /* No credentials or raw failures are logged. The next read surfaces storage errors. */ } }, intervalMs);
  timer.unref();
  return {
    snapshot() { return transaction(state => { tick(state); save(state); return publicState(state); }); },
    cloudState(id) { return transaction(state => clone(state.items.find(item => item.id === id) || null)); },
    cloudCleanupJobs() { return transaction(state => clone(state.nangoCleanup || [])); },
    cloudCleanupDone(key) { return transaction(state => { state.nangoCleanup = (state.nangoCleanup || []).filter(job => job.key !== key); save(state); }); },
    cloudCleanupFailed(id) { return transaction(state => { const item = state.items.find(item => item.id === id); if (item?.provider === 'nango' && !item.enabled) { setState(state, item, 'revoked', 'Morlet访问已撤回；云端凭据清理将在服务恢复后重试'); save(state); } }); },
    cloudBegin({ id, revision, operation }) {
      if (!['google', 'github', 'x'].includes(id) || !['connect', 'check', 'disconnect'].includes(operation)) fail('INVALID_REQUEST');
      return transaction(state => {
        if (revision !== state.revision) fail('REVISION_CONFLICT');
        const item = state.items.find(item => item.id === id), previous = clone(item);
        if (!cloud.has(id) && !(operation === 'disconnect' && item.provider === 'nango')) fail('INVALID_REQUEST');
        if (operation === 'check' && (!item.enabled || item.provider !== 'nango')) fail('CONNECTION_NOT_ENABLED');
        if (operation !== 'check') { item.generation += 1; delete item.auth; }
        if (previous.provider === 'nango' && operation !== 'check') {
          state.nangoCleanup ||= [];
          if (operation === 'disconnect') {
            for (const connectionId of new Set([previous.binding?.connectionId, previous.pendingReconnect?.connectionId].filter(Boolean))) {
              state.nangoCleanup.push({ key: randomUUID(), service: id, connectionId });
            }
          }
          if (previous.attemptId) state.nangoCleanup.push({ key: randomUUID(), service: id, attemptId: previous.attemptId, expiresAt: previous.attemptExpiresAt || previous.auth?.expiresAt || iso(now() + 30 * 60_000) });
        }
        item.provider = 'nango';
        state.commands = state.commands.filter(command => command.id !== id);
        if (operation === 'disconnect') {
          item.enabled = false; item.account = null; delete item.binding; delete item.pendingReconnect; delete item.attemptId; delete item.attemptExpiresAt;
          item.permissions = item.permissions.map(p => ({ ...p, granted: false, verified: false }));
          setState(state, item, 'revoked', '已撤回Morlet访问授权');
        } else {
          item.enabled = true;
          if (operation === 'connect') {
            // This reference is only for reconnect/cleanup. It is never an active grant.
            if (previous.provider === 'nango' && previous.binding) item.pendingReconnect = { connectionId: previous.binding.connectionId };
            delete item.binding; item.attemptId = randomUUID(); delete item.attemptExpiresAt; item.account = null;
          }
          if (!item.auth || operation === 'connect') setState(state, item, 'checking', '正在检查云端授权');
        }
        state.revision += 1; event(state, id, operation); save(state);
        return { item: clone(item), previous };
      });
    },
    cloudUpdate(id, generation, update) {
      if (!cloud.has(id)) fail('INVALID_REQUEST');
      return transaction(state => {
        const item = state.items.find(item => item.id === id);
        if (!item.enabled || item.provider !== 'nango' || item.generation !== generation) return false;
        if (update.binding) {
          if (item.pendingReconnect?.connectionId && item.pendingReconnect.connectionId !== update.binding.connectionId) {
            state.nangoCleanup ||= [];
            state.nangoCleanup.push({ key: randomUUID(), service: id, connectionId: item.pendingReconnect.connectionId });
          }
          item.binding = clone(update.binding); delete item.pendingReconnect;
        }
        if (update.account !== undefined) item.account = account(id, update.account);
        if (update.permissions) item.permissions = permissions(id, update.permissions);
        if (update.auth) { item.auth = clone(update.auth); item.attemptExpiresAt = update.auth.expiresAt; } else if (update.state !== 'awaiting_authorization') delete item.auth;
        if (!REPORT_STATES.has(update.state)) fail('INVALID_REQUEST');
        item.checkedAt = iso(now());
        setState(state, item, update.state, update.message);
        if (['connected', 'limited'].includes(item.state)) item.lastSuccessAt = item.checkedAt;
        save(state); return true;
      });
    },
    mutate(input) {
      keys(input, ['operation', 'id', 'revision', 'values']);
      const { operation, id, revision, values = {} } = input;
      if (!Number.isInteger(revision) || revision < 0 || !['connect', 'grant', 'settings', 'check', 'disconnect', 'pair', 'unpair'].includes(operation)) fail('INVALID_REQUEST');
      keys(values, ['name', 'account', 'scope']);
      if (!['pair', 'unpair'].includes(operation) && !IDS.includes(id)) fail('INVALID_REQUEST');
      return transaction(state => {
        if (revision !== state.revision) fail('REVISION_CONFLICT');
        let token;
        if (operation === 'pair' || operation === 'unpair') {
          if (operation === 'pair') {
            if (typeof values.name !== 'string' || !values.name.trim() || values.name.length > 80 || /[\x00-\x1f]/.test(values.name)) fail('INVALID_REQUEST');
            token = randomBytes(32).toString('hex');
          }
          state.bridge = { paired: operation === 'pair', online: false, name: operation === 'pair' ? values.name : null, lastSeenAt: null, hash: token ? hash(token).toString('hex') : null };
          state.commands = [];
          for (const item of state.items) {
            if (item.provider === 'nango') continue;
            item.generation += 1; delete item.auth;
            item.permissions = item.permissions.map(permission => ({ ...permission, verified: false }));
            if (item.enabled) { setState(state, item, 'offline', operation === 'pair' ? '等待当前 Mac 连接并检查' : '当前 Mac 已解除配对'); if (token) enqueue(state, item, 'check'); }
          }
          event(state, 'bridge', operation);
        } else {
          const item = state.items.find(item => item.id === id);
          if (item.provider === 'nango') fail('CLOUD_CONNECTION_REQUIRED');
          if (operation === 'check' && !item.enabled) fail('CONNECTION_NOT_ENABLED');
          if (operation === 'settings' && (!['files', 'phone'].includes(id) || Object.keys(values).length)) fail('INVALID_REQUEST');
          if (['connect', 'grant', 'settings'].includes(operation)) {
            if (id === 'files' && operation !== 'settings' && (operation !== 'grant' || typeof values.scope !== 'string' || !Object.hasOwn(FILE_SCOPES, values.scope))) fail('INVALID_REQUEST');
            if (id === 'google' && !account(id, values.account)) fail('INVALID_REQUEST');
            item.account = account(id, values.account) ?? item.account;
            item.scope = id === 'files' ? operation === 'settings' ? item.scope || 'all-readable-files' : values.scope : null;
            item.enabled = true;
          }
          if (operation !== 'check') { item.generation += 1; delete item.auth; }
          if (operation === 'disconnect') {
            item.enabled = false; item.scope = null; item.account = null;
            item.permissions = item.permissions.map(permission => ({ ...permission, granted: false, verified: false }));
            state.commands = state.commands.filter(command => command.id !== id);
            setState(state, item, 'revoked', '已撤回Morlet访问授权；其他工具的登录凭据保留');
          } else {
            if (!(operation === 'check' && item.state === 'awaiting_authorization')) setState(state, item, state.bridge.online ? 'checking' : 'offline', state.bridge.online ? '正在检查当前 Mac 的连接与权限' : '等待当前 Mac 连接并检查');
            enqueue(state, item, operation, id === 'google' ? { account: item.account } : id === 'files' ? { scope: item.scope, readOnly: true } : {});
          }
          event(state, id, operation);
        }
        state.revision += 1; tick(state); save(state);
        const snapshot = publicState(state);
        return token ? { snapshot, token } : snapshot;
      });
    },
    bridgeSnapshot(token) {
      return transaction(state => {
        authorized(state, token); tick(state); save(state);
        return clone({ revision: state.revision, intervalMs, commands: state.commands,
          desired: state.items.map(item => ({ id: item.id, enabled: item.enabled && item.provider !== 'nango', account: item.provider === 'nango' ? null : item.account, scope: item.scope, generation: item.generation,
            ...(item.id === 'x' && /^[A-Za-z0-9_:.+=\/-]{8,256}$/.test(env.PA_X_CLIENT_ID || '') && { oauthApp: { clientId: env.PA_X_CLIENT_ID, redirectUri: 'http://127.0.0.1:3094/oauth/x/callback' } }) })) });
      });
    },
    reportBridge(token, input) {
      keys(input, ['reports', 'ack']);
      const { reports = [], ack = [] } = input;
      if (!Array.isArray(reports) || reports.length > 5 || !Array.isArray(ack) || ack.length > 20 || ack.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) || new Set(ack).size !== ack.length) fail('INVALID_REQUEST');
      const seen = new Set();
      const normalized = reports.map(report => {
        keys(report, ['id', 'generation', 'state', 'code', 'account', 'permissions', 'auth']);
        if (!IDS.includes(report.id) || seen.has(report.id) || !Number.isInteger(report.generation) || report.generation < 0 || !REPORT_STATES.has(report.state) || !Object.hasOwn(MESSAGES, report.code)) fail('INVALID_REQUEST');
        seen.add(report.id);
        return { ...report, account: account(report.id, report.account),
          permissions: report.permissions === undefined ? undefined : permissions(report.id, report.permissions),
          auth: report.auth === undefined ? undefined : authorization(report.id, report.auth, now()) };
      });
      return transaction(state => {
        authorized(state, token);
        state.bridge.lastSeenAt = iso(now());
        for (const report of normalized) {
          const item = state.items.find(item => item.id === report.id);
          if (!item.enabled || item.provider === 'nango' || item.generation !== report.generation) continue;
          // An already granted, different Google account must not satisfy the requested identity.
          const mismatch = item.id === 'google' && item.account && report.account && item.account.toLowerCase() !== report.account.toLowerCase();
          if (report.account && !mismatch) item.account = report.account;
          if (report.permissions) item.permissions = Object.entries(DEFINITIONS[item.id].permissions).map(([id, label]) => report.permissions.find(permission => permission.id === id) ?? { id, label, granted: false, verified: false });
          if (mismatch) item.permissions = item.permissions.map(permission => ({ ...permission, verified: false }));
          let status = mismatch ? 'limited' : report.state;
          if (status === 'awaiting_authorization' && report.code === 'not_authenticated' && !report.auth) status = 'setup_required';
          if (status === 'awaiting_authorization' && report.code === 'auth_denied') status = 'error';
          if (status === 'awaiting_authorization' && report.code === 'auth_expired') status = 'expired';
          if (status === 'connected' && !item.permissions.some(permission => permission.granted && permission.verified)) status = 'limited';
          if (report.auth && status === 'awaiting_authorization') item.auth = report.auth;
          else delete item.auth;
          item.checkedAt = iso(now());
          if (status === 'connected') item.lastSuccessAt = item.checkedAt;
          setState(state, item, status, mismatch ? '当前 Mac 登录的 Google 账号与指定账号不一致' : status === 'limited' && report.code === 'ok' ? MESSAGES.partial : MESSAGES[report.code]);
        }
        state.commands = state.commands.filter(command => !ack.includes(command.commandId));
        tick(state); save(state);
        return { ok: true, revision: state.revision, stateVersion: state.stateVersion };
      });
    },
    close() { if (db) { clearInterval(timer); db.close(); db = null; } },
  };
}
