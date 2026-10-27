import { NOTICE_STAGES, REVIEW_DETAILS, noticeDiagnostic } from './notice-worker.mjs';
import { failure } from '../agent-hub/store.mjs';
import { personalNoticeSnapshot, managePersonalNotices } from './personal-notices.mjs';
import { inQuiet, localTime, MINUTE } from './policy.mjs';
import { reachOutGate, reserveAnalysis, candidateReceipt } from './reach-out.mjs';

const live = new Set(['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling']);
const states = new Set(['idle', 'scanning', 'paused', 'quiet_hours', 'blocked', 'error']);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));

// The paired Mac gets no owner settings, conversation contents, destinations,
// or permission to start an Agent run. Its source permissions remain revocable.
export function noticeWorkerSources(connections, policy) {
  const verified = (item, permission) => (item?.connectionProvider === 'nango' || connections.bridge?.online) && ['connected', 'limited'].includes(item?.state) && item.permissions.some(p => p.id === permission && p.granted && p.verified);
  const google = connections.items.find(i => i.id === 'google'), github = connections.items.find(i => i.id === 'github'), files = connections.items.find(i => i.id === 'files'), x = connections.items.find(i => i.id === 'x');
  return [
    verified(google, 'calendar') && { id: 'google-calendar', account: google.account },
    verified(google, 'gmail') && { id: 'google-mail', account: google.account },
    verified(github, 'repos') && { id: 'github', account: github.account },
    verified(x, 'read') && { id: 'x', account: x.account },
    verified(files, 'readable') && connections.desired?.some(i => i.id === 'files' && i.enabled && ['common-folders', 'all-readable-files'].includes(i.scope)) && { id: 'local-files' },
  ].filter(s => s && policy.sources.includes(s.id)).map(source => {
    const connectionId = source.id.startsWith('google-') ? 'google' : source.id === 'local-files' ? 'files' : source.id;
    const desired = connections.desired?.find(item => item.id === connectionId), generation = desired?.generation;
    const connectionProvider = connections.items.find(item => item.id === connectionId)?.connectionProvider;
    return { ...source, ...(connectionProvider === 'nango' && { connectionProvider }), ...(Number.isSafeInteger(generation) && generation >= 0 && { generation }), ...(source.id === 'x' && connectionProvider !== 'nango' && desired?.oauthApp && { oauthApp: desired.oauthApp }) };
  });
}

export function noticeWorkerGate(hub) {
  const p = personalNoticeSnapshot(hub), now = hub.now();
  if (!p.enabled) return 'paused';
  if (inQuiet(now, p)) return 'quiet_hours';
  if (!p.channelReady) return 'channel_offline';
  const c = hub.get('channelEndpoint', p.channelId), b = c && hub.binding(c.channel, c.id, c.peer);
  if (!b) return 'channel_offline';
  return reachOutGate(hub, 'owner', { enabled: p.enabled, channelReady: p.channelReady, conversationId: b.conversationId });
}

export function noticeWorkerBridge(hub, connections, input, automaticContent) {
  if (!exact(input, ['operation', 'state', 'reason', 'counts', 'reading', 'diagnostic', 'scanAt', 'nextScanAt', 'key', 'source', 'sourceGeneration', 'text', 'observedAt', 'expiresAt', 'topic', 'kind', 'count', 'entries', 'content'])) throw failure('INVALID_INPUT');
  const contentPolicy = automaticContent?.policy();
  const activeSources = () => { const notice = personalNoticeSnapshot(hub); return noticeWorkerSources(connections, { sources: [...new Set([...(notice.enabled ? notice.sources : []), ...(contentPolicy?.enabled ? contentPolicy.sources : [])])] }); };
  if (input.operation === 'publish' && automaticContent) return automaticContent.publish(input, activeSources(), personalNoticeSnapshot(hub).timezone);
  if (input.operation === 'snapshot') {
    const p = personalNoticeSnapshot(hub);
    return { policy: { mode: p.mode, enabled: p.enabled, timezone: p.timezone, quiet_start: p.quiet_start, quiet_end: p.quiet_end, max_daily: p.max_daily, min_gap_minutes: p.min_gap_minutes },
      blocked: noticeWorkerGate(hub), sources: activeSources(),
      ...(automaticContent && { content: automaticContent.snapshot({ bridge: true }) }),
      notices: hub.all('personalNotice').slice(-1000).map(n => ({ key: n.key, state: n.candidateId ? candidateReceipt(hub, n.candidateId)?.state || 'unknown' : hub.get('delivery', n.deliveryId)?.state || 'unknown' })) };
  }
  if (input.operation === 'receipt') {
    if (typeof input.key !== 'string' || input.key.length > 256) throw failure('INVALID_INPUT');
    const n = hub.all('personalNotice').find(n => n.key === input.key);
    return { receipt: n ? n.candidateId ? candidateReceipt(hub, n.candidateId) : { deliveryId: n.deliveryId, state: hub.get('delivery', n.deliveryId)?.state || 'unknown' } : null };
  }
  if (input.operation === 'analysis') {
    if (typeof input.key !== 'string' || input.key.length > 256) throw failure('INVALID_INPUT');
    if (input.content !== undefined && typeof input.content !== 'boolean') throw failure('INVALID_INPUT');
    if (input.content) return reserveAnalysis(hub, 'owner', { key: input.key, count: input.count, enabled: contentPolicy?.enabled === true, phase: 'content' });
    const blocked = noticeWorkerGate(hub);
    return blocked ? { allowed: false, blocked } : reserveAnalysis(hub, 'owner', { key: input.key, count: input.count });
  }
  if (input.operation === 'offer') {
    const source = noticeWorkerSources(connections, personalNoticeSnapshot(hub)).find(s => s.id === input.source);
    if (!source) return { accepted: false, blocked: 'source_unavailable' };
    if (input.sourceGeneration !== undefined && (!Number.isSafeInteger(input.sourceGeneration) || input.sourceGeneration < 0)) throw failure('INVALID_INPUT');
    if (input.sourceGeneration !== undefined && input.sourceGeneration !== source.generation) return { accepted: false, blocked: 'source_changed' };
    // This optional field allows the previous deployed Mac worker to upgrade
    // after the server. New workers always bind a proposal to its grant version.
    const { sourceGeneration, ...offer } = input;
    return managePersonalNotices(hub, offer);
  }
  if (input.operation !== 'status' || !states.has(input.state) || input.reason !== undefined && (typeof input.reason !== 'string' || !/^[a-z_]{1,60}$/.test(input.reason))) throw failure('INVALID_INPUT');
  if (input.counts !== undefined && (!exact(input.counts, ['google-calendar', 'google-mail', 'github', 'x', 'local-files']) || Object.values(input.counts).some(n => !Number.isInteger(n) || n < 0 || n > 10000))) throw failure('INVALID_INPUT');
  if (input.reading !== undefined && (!exact(input.reading, ['emailsRead', 'articlesRead', 'partial', 'failed', 'deferred']) || Object.values(input.reading).some(n => !Number.isInteger(n) || n < 0 || n > 10000))) throw failure('INVALID_INPUT');
  for (const field of ['scanAt', 'nextScanAt']) if (input[field] !== undefined && (!Number.isSafeInteger(input[field]) || Math.abs(input[field] - hub.now()) > 86400000)) throw failure('INVALID_INPUT');
  if (input.diagnostic !== undefined) {
    const d = input.diagnostic;
    if (!exact(d, ['stage', 'code', 'retryable', 'attempt', 'retryAt', 'elapsedMs', 'statusCode', 'detail']) || !NOTICE_STAGES.has(d.stage)
      || typeof d.code !== 'string' || noticeDiagnostic({ code: d.code }).code !== d.code || typeof d.retryable !== 'boolean'
      || !Number.isSafeInteger(d.attempt) || d.attempt < 0 || d.attempt > 30 || !Number.isSafeInteger(d.retryAt) || Math.abs(d.retryAt - hub.now()) > 86400000
      || d.elapsedMs !== undefined && (!Number.isSafeInteger(d.elapsedMs) || d.elapsedMs < 0 || d.elapsedMs > 86400000)
      || d.statusCode !== undefined && (!Number.isInteger(d.statusCode) || d.statusCode < 100 || d.statusCode > 599)
      || d.detail !== undefined && !REVIEW_DETAILS.has(d.detail)) throw failure('INVALID_INPUT');
  }
  const old = hub.get('personalNoticeWorker', 'mac') || {};
  hub.put('personalNoticeWorker', { ...old, id: 'mac', lastSeenAt: hub.now(), state: input.state, reason: input.reason || null, diagnostic: input.diagnostic || null,
    ...(input.counts && { counts: input.counts }), ...(input.reading && { reading: input.reading }), ...(input.scanAt !== undefined && { lastScanAt: input.scanAt }), ...(input.nextScanAt !== undefined && { nextScanAt: input.nextScanAt }) });
  return { accepted: true };
}
