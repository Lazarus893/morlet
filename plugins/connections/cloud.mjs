import { createNangoClient } from './nango.mjs';
import { probeNangoConnection } from '../agent-hub/nango-sources.mjs';

const messages = {
  NANGO_AUTH_REQUIRED: '授权已过期，请重新连接', NANGO_OWNER_MISMATCH: '账号归属校验未通过，请重新连接',
  NANGO_RATE_LIMITED: '服务暂时限流，稍后重试', NANGO_NOT_FOUND: '尚未完成授权，或授权已被撤回',
  NANGO_FORBIDDEN: '服务权限不足，请检查授权范围', NANGO_UNAUTHORIZED: '连接服务配置失效，请联系部署方',
  NANGO_TIMEOUT: '连接检查超时，请重试', SOURCE_ACCOUNT_CHANGED: '连接的账号发生变化，请重新授权',
  NANGO_AMBIGUOUS_CONNECTION: '这次授权包含无法确认一致的账号或权限，请撤回后重新授权',
};
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** The connection manager owns grants. Nango owns OAuth credentials. */
export function createCloudConnections({ config, manager, client = config && createNangoClient({ config }), probe = probeNangoConnection, now = Date.now }) {
  const services = client ? client.services().filter(id => ['google', 'github', 'x'].includes(id)) : [];
  const pending = new Map(); let closed = false;
  let cleanupTask;
  const cleanup = () => cleanupTask ||= (async () => {
    for (const job of manager.cloudCleanupJobs()) {
      if (!services.includes(job.service) || closed) continue;
      try {
        const bindings = job.connectionId ? [job] : await client.findConnections({ service: job.service, ownerId: 'owner', attemptId: job.attemptId });
        for (const binding of bindings) {
          const canDelete = () => {
            const active = manager.cloudState(job.service);
            return !active?.enabled || ![active.binding?.connectionId, active.pendingReconnect?.connectionId].includes(binding.connectionId);
          };
          if (!canDelete()) continue;
          try { await client.disconnect({ service: job.service, ownerId: 'owner', connectionId: binding.connectionId, ...(job.attemptId ? { attemptId: job.attemptId } : {}) }, { authorize: canDelete }); }
          catch (error) { if (error.code !== 'NANGO_CONNECTION_PROTECTED') throw error; }
        }
        // A valid Connect session can still create another connection after
        // this sweep. Keep its cleanup job until expiry plus a final grace sweep.
        if (job.connectionId || job.expiresAt && now() > Date.parse(job.expiresAt) + 60_000) manager.cloudCleanupDone(job.key);
      } catch { manager.cloudCleanupFailed(job.service); }
    }
  })().finally(() => { cleanupTask = undefined; });
  const current = (id, generation) => {
    const item = manager.cloudState(id);
    if (!item?.enabled || item.provider !== 'nango' || item.generation !== generation) fail('SOURCE_AUTHORITY_CHANGED');
    return item;
  };
  async function check(id, force = false) {
    if (closed || !services.includes(id)) return;
    if (pending.has(id)) return pending.get(id);
    const item = manager.cloudState(id);
    if (!item?.enabled || item.provider !== 'nango' || !force && !item.auth && now() - Date.parse(item.checkedAt || 0) < 60_000) return;
    const task = (async () => {
      const scope = { service: id, ownerId: 'owner' };
      try {
        const bindings = item.binding ? [item.binding] : item.attemptId ? await client.findConnections({ ...scope, attemptId: item.attemptId }) : [];
        current(id, item.generation);
        if (!bindings.length) return;
        if (bindings.length > 10) fail('NANGO_AMBIGUOUS_CONNECTION');
        const verified = [];
        for (const binding of bindings) {
          const result = await probe(client, { ...binding, ...scope }, { authorize: () => current(id, item.generation) });
          current(id, item.generation);
          verified.push({ binding, result });
        }
        if (verified.length > 1) {
          const fingerprint = result => JSON.stringify([result.userId, result.account?.toLowerCase(), [...new Set(result.scopes || [])].sort()]);
          const first = verified[0].result;
          if (!first.userId || !first.account || verified.some(({ binding, result }) =>
            !Number.isFinite(Date.parse(binding.createdAt)) || !result.userId || fingerprint(result) !== fingerprint(first) ||
            !['connected', 'limited'].includes(result.state) || result.permissions.some(permission => permission.granted && !permission.verified))) fail('NANGO_AMBIGUOUS_CONNECTION');
          verified.sort((a, b) => Date.parse(b.binding.createdAt) - Date.parse(a.binding.createdAt) || a.binding.connectionId.localeCompare(b.binding.connectionId));
        }
        const { binding, result } = verified[0];
        current(id, item.generation);
        if (item.account && result.account?.toLowerCase() !== item.account.toLowerCase()) fail('SOURCE_ACCOUNT_CHANGED');
        manager.cloudUpdate(id, item.generation, { binding: { ...binding, ...scope, services: result.services || [], scopes: result.scopes || [] },
          account: result.account, permissions: result.permissions.map(({ id, label, granted, verified }) => ({ id, ...(label && { label }), granted, verified })), state: result.state,
          message: result.state === 'connected' ? '已连接' : '部分读取权限可用' });
      } catch (error) {
        if (error.code === 'SOURCE_AUTHORITY_CHANGED' || closed) return;
        manager.cloudUpdate(id, item.generation, { state: ['NANGO_AUTH_REQUIRED', 'NANGO_NOT_FOUND'].includes(error.code) ? 'expired' : 'error', message: messages[error.code] || '连接检查未成功，请重试' });
      }
    })().finally(() => pending.delete(id));
    pending.set(id, task); return task;
  }
  return {
    services,
    async refresh() { await Promise.all([cleanup(), ...services.map(id => check(id))]); return manager.snapshot(); },
    async mutate(input) {
      if (!input || Object.keys(input).some(k => !['operation', 'id', 'revision', 'values'].includes(k))) fail('INVALID_REQUEST');
      const active = manager.cloudState(input.id);
      if ((!services.includes(input.id) && !(active?.provider === 'nango' && input.operation === 'disconnect')) || active?.provider !== 'nango' && active?.enabled && input.operation !== 'connect') return manager.mutate(input);
      if (input.values && (typeof input.values !== 'object' || Array.isArray(input.values) || Object.keys(input.values).some(k => k !== 'account'))) fail('INVALID_REQUEST');
      // Do not start a reconnect while an earlier cleanup DELETE is in flight.
      if (input.operation === 'connect' && cleanupTask) await cleanupTask;
      const { item, previous } = manager.cloudBegin(input);
      if (input.operation === 'check') { await check(item.id, true); return manager.snapshot(); }
      if (input.operation === 'disconnect') {
        await cleanup();
        if (!services.includes(input.id)) manager.cloudCleanupFailed(input.id);
        return manager.snapshot();
      }
      try {
        const reconnect = previous.provider === 'nango' && (previous.binding || previous.pendingReconnect);
        const auth = reconnect
          ? await client.reconnect({ service: item.id, ownerId: 'owner', connectionId: reconnect.connectionId, attemptId: item.attemptId })
          : await client.beginConnect({ service: item.id, ownerId: 'owner', attemptId: item.attemptId });
        manager.cloudUpdate(item.id, item.generation, { state: 'awaiting_authorization', message: '请在授权页面确认账号与权限',
          auth: { verificationUrl: auth.connectUrl, origin: config.connectOrigin, expiresAt: auth.expiresAt } });
      } catch (error) {
        manager.cloudUpdate(item.id, item.generation, { state: 'error', message: messages[error.code] || '授权页面暂时无法打开，请重试' });
      }
      return manager.snapshot();
    },
    async close() { closed = true; await Promise.allSettled([...pending.values(), cleanupTask]); },
  };
}
