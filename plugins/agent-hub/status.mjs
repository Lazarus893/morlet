import { assertRoutineSourceAccess, normalizeRoutineScope } from './routine-scope.mjs';
import { localServiceInventory } from './services.mjs';
import { getRuntime } from '../webui/control.mjs';
import { failure } from './store.mjs';
import { hubConfig } from './config.mjs';
import { personalNoticeSnapshot } from '../proactive/personal-notices.mjs';
import { reachOutSnapshot } from '../proactive/reach-out.mjs';
import { endpointReadiness } from './readiness.mjs';
import { connectedServiceStatus, sourceBridgeInventory } from './source-bridge.mjs';

export const STATUS_TOOL = { type: 'function', name: 'xiaoman_status', description: 'Read current connected-service, message-channel and Agent status from the Xiaoman host. Use this for questions about connected channels. Web, Weixin and iMessage are message channels; DSH/Codex are execution Agents. A local shell, port or missing socket cannot determine remote channel health. Enabled, online, bound to this conversation and actual message delivery are separate facts.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };

/** Host-side, read-only health projection; never exposes peer IDs or credentials. */
export async function statusTool({ hub, root, read, rpc, token, input }) {
  const authorize = () => {
    const endpoint = hub.authenticate(token), run = hub.get('run', input.runId);
    if (!run || run.endpointId !== endpoint.id || run.lease !== input.lease || !['running', 'waiting_approval', 'uncertain'].includes(run.status)) throw failure('FORBIDDEN');
    return run;
  };
  authorize();
  const args = input.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw failure('INVALID_INPUT');
  const run = authorize();
  if (run.routine) {
    assertRoutineSourceAccess(hub, run, { operation: 'list' });
    const endpoint = hub.get('endpoint', run.endpointId), scope = normalizeRoutineScope(hub.get('routine', run.routine.id).scope);
    return { checkedAt: hub.now(), currentRun: { id: run.id, status: run.status }, selectedEndpointId: run.endpointId,
      agents: [{ id: run.endpointId, provider: endpoint?.provider, online: !!endpoint?.active && hub.now() - endpoint.lastSeen < 45000 }],
      sources: { actions: ['list', ...new Set(scope.sources.map(source => source.operation))], scope },
      waiting: [], blockedTasks: [], resolvedTasks: [], scope: 'current_routine_only' };
  }
  const result = await statusSnapshot({ hub, root, read, rpc, conversationId: run.conversationId });
  authorize();
  return result;
}

export async function statusSnapshot({ hub, root, read, rpc, conversationId, settings, runtime }) {
  try {
    settings ||= await read();
    if (!runtime && settings.config.im.provider === 'weixin') runtime = await getRuntime(root, settings, rpc);
  } catch { /* Unknown evidence remains yellow. */ }
  const now = hub.now(), snapshot = hub.snapshot(), localServices = await localServiceInventory(root);
  const bindings = snapshot.bindings.filter(b => !conversationId || b.conversationId === conversationId);
  const weixinConfigured = settings ? settings.config.im.provider === 'weixin' : null;
  const fresh = runtime?.state === 'running' && runtime.configRevision === settings?.revision &&
    Number.isFinite(runtime.lastPollAt) && now - runtime.lastPollAt < 90000 && runtime.lastPollAt <= now + 60000;
  const weixinState = weixinConfigured === false ? 'disabled' : fresh
    ? runtime.connected && !runtime.connectionError ? 'online' : 'disconnected'
    : runtime?.state === 'offline' ? 'offline' : 'unknown';
  const messageBridges = snapshot.channels.filter(c => c.active && c.channel === 'imessage');
  const petBridges = snapshot.channels.filter(c => c.active && c.channel === 'desktop-pet');
  let sources;
  try { sources = sourceBridgeInventory(hub); } catch { sources = { error: 'SOURCE_AUTHORITY_UNAVAILABLE' }; }
  const notice = personalNoticeSnapshot(hub), worker = notice.worker;
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const code = value => typeof value === 'string' && /^[a-z_]{1,80}$/i.test(value) ? value : null;
  const personalNoticeWorker = worker ? { enabled: notice.enabled, online: worker.online, state: code(worker.state), reason: code(worker.reason),
    reading: worker.reading ? Object.fromEntries(['emailsRead', 'articlesRead', 'partial', 'failed', 'deferred'].map(key => [key, number(worker.reading[key]) || 0])) : null,
    lastSeenAt: number(worker.lastSeenAt), lastScanAt: number(worker.lastScanAt), nextScanAt: number(worker.nextScanAt),
    diagnostic: worker.diagnostic ? { stage: code(worker.diagnostic.stage), code: code(worker.diagnostic.code), attempt: number(worker.diagnostic.attempt),
      retryAt: number(worker.diagnostic.retryAt), retryable: worker.diagnostic.retryable === true, statusCode: number(worker.diagnostic.statusCode), elapsedMs: number(worker.diagnostic.elapsedMs), detail: code(worker.diagnostic.detail) } : null } : null;
  const agents = snapshot.endpoints.filter(e => e.active).map(e => endpointReadiness(hub, e, conversationId));
  const waiting = snapshot.approvals.filter(a => ['pending', 'deferred'].includes(a.state) && (!conversationId || a.conversationId === conversationId)).map(a => ({ id: a.id, runId: a.runId, title: a.action?.title || '一项操作等待确认', preview: a.action?.preview || '操作细节尚未整理，请先拒绝或到调试详情核对。', expiresAt: a.expiresAt, choices: a.action?.approvable ? ['approve', 'reject', 'defer'] : ['accept_limit', 'reject'], state: a.state }));
  const blockedTasks = snapshot.runs.filter(r => (!conversationId || r.conversationId === conversationId) && (['queued', 'uncertain', 'cancelling'].includes(r.status) || r.issue?.state === 'open')).map(r => ({ id: r.id, conversationId: r.conversationId, title: r.title, status: r.status, reason: r.error || r.report?.summary || '等待处理', issue: r.issue, progress: r.progress }));
  const contexts = bindings.filter(b => b.channel === 'weixin').map(b => hub.get('route', b.id)).filter(Boolean);
  const contextExpiresAt = contexts.length ? Math.min(...contexts.map(r => r.updatedAt + (settings?.config.proactive?.context_ttl_hours || 24) * 3600000)) : null;
  const contextState = contextExpiresAt === null ? 'unknown' : contextExpiresAt <= now ? 'expired' : contextExpiresAt - now < 2 * 3600000 ? 'expiring' : 'valid';
  const bound = bindings.some(b => b.channel === 'weixin' && b.account === runtime?.account && settings?.config.im.allow_from.includes(b.peer));
  const selectedId = conversationId ? hub.get('conversation', conversationId)?.endpointId : hubConfig(root).roles.conversation;
  const selected = agents.find(a => a.id === selectedId);
  const attention = [...(notice.enabled && worker && (!worker.online || worker.state === 'error' || worker.state === 'blocked' && (worker.diagnostic || ['source_unavailable', 'channel_offline'].includes(worker.reason))) ? [{ kind: 'background', reason: worker.online ? worker.reading?.failed && (worker.reading.emailsRead || worker.reading.articlesRead) ? '主动关注有部分资料未读到，完整读到的内容另行核对。' : '主动关注暂未完成，查看后台处理记录；正常交代仍可继续。' : '主动关注的本地助手暂未连接，等待恢复。' }] : []), ...localServices.items.filter(s => s.needsAttention).map(s => ({ kind: 'background', reason: s.suggestion })), ...(!selected ? [{ kind: 'execution', reason: '还没有就绪的默认执行助手' }] : []), ...(!bound && weixinConfigured ? [{ kind: 'channel', reason: '微信尚未绑定到这段对话' }] : []), ...(selected?.reasons || []).map(reason => ({ kind: 'execution', reason })), ...(weixinConfigured && weixinState !== 'online' ? [{ kind: 'channel', reason: '微信连接尚未确认，先检查连接状态' }] : []), ...(['expired', 'expiring'].includes(contextState) ? [{ kind: 'authorization', reason: contextState === 'expired' ? '微信主动联系窗口已过期，等你下一条微信后恢复' : '微信主动联系窗口将过期' }] : [])];
  return {
    checkedAt: now,
    light: attention.length || waiting.length || blockedTasks.length ? 'yellow' : 'green',
    summary: weixinState === 'online' && bound && selected?.canExecute ? '可以从微信交代事情；写动作仍需你批准。' : '暂不能确认微信任务可完整执行，交代与记录会保留。',
    attention, waiting, blockedTasks, resolvedTasks: snapshot.runs.filter(r => (!conversationId || r.conversationId === conversationId) && r.issue?.state === 'resolved').map(r => ({ id: r.id, conversationId: r.conversationId, title: r.title, status: r.status, resolution: r.issue.resolution })), localServices, reachOut: reachOutSnapshot(hub), selectedEndpointId: selectedId || null,
    personalNoticeWorker,
    services: connectedServiceStatus(root),
    sources,
    channels: [
      { id: 'web', configured: true, state: 'enabled', boundToConversation: true, evidence: 'shared_hub', detail: 'Web 共用此 Hub；这里不探测用户浏览器是否在线。' },
      { id: 'weixin', configured: weixinConfigured, state: weixinState,
        boundToConversation: bound,
        context: { state: contextState, expiresAt: contextExpiresAt, basis: '本地保守窗口，不代表平台保证' }, checkedAt: fresh ? runtime.lastPollAt : null, evidence: fresh ? 'channel_host' : 'unavailable' },
      { id: 'imessage', configured: messageBridges.length > 0,
        state: !messageBridges.length ? 'not_connected' : messageBridges.some(c => c.online) ? 'online' : messageBridges.some(c => c.connected && c.error) ? 'needs_attention' : 'offline',
        boundToConversation: bindings.some(b => b.channel === 'imessage' && messageBridges.some(c => c.id === b.account)),
        onlineBridges: messageBridges.filter(c => c.online).length, evidence: 'bridge_heartbeat' },
      ...(petBridges.length ? [{ id: 'desktop-pet', configured: true, state: petBridges.some(c => c.online) ? 'online' : 'offline',
        boundToConversation: bindings.some(b => b.channel === 'desktop-pet' && petBridges.some(c => c.id === b.account)),
        onlineBridges: petBridges.filter(c => c.online).length, evidence: 'bridge_heartbeat', detail: '桌宠接收主动通知；宿主接收回执不代表已读。' }] : []),
    ],
    agents,
    delivery: '通道在线不代表某条消息已经送达；实际发送、送达和已读以对应消息回执为准。',
  };
}
