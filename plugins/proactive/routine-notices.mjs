import { createHash } from 'node:crypto';
import { failure } from '../agent-hub/store.mjs';
import { assertRoutineScopeCurrent } from '../agent-hub/routine-scope.mjs';
import { reachOutPolicy, reachOutGate, offerReachOut, reserveReachOut, finishReachOut, candidateReceipt } from './reach-out.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const channels = new Set(['imessage', 'desktop-pet']);
const checked = new Set(['published', 'quiet']);
const submitted = new Set(['sending', 'submitted', 'sent', 'delivered', 'read', 'unknown']);
const cut = (value, length) => Array.from(String(value || '').replace(/[\x00-\x1f]/g, ' ').trim()).slice(0, length).join('');
const stamp = (channel, binding) => hash([channel.id, channel.channel, channel.peer, channel.tokenHash, binding.conversationId, binding.ownerId]);

function channelBinding(hub, id) {
  const channel = hub.get('channelEndpoint', id), binding = channel && hub.binding(channel.channel, channel.id, channel.peer);
  return channel?.active && channels.has(channel.channel) && binding?.ownerId === 'owner' && hub.get('conversation', binding.conversationId)?.ownerId === 'owner' ? { channel, binding } : null;
}

// The owner picks an existing channel, never an address supplied by the model.
// The stamp pins the actual paired identity and conversation across re-pairing.
export function normalizeRoutineNotification(hub, value = { channelId: null }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['channelId', 'bindingStamp'].includes(key)) || value.channelId !== null && (typeof value.channelId !== 'string' || value.channelId.length > 128)) throw failure('INVALID_INPUT');
  if (value.channelId === null) return { channelId: null };
  const route = channelBinding(hub, value.channelId);
  if (!route) throw failure('ROUTINE_NOTIFICATION_CHANNEL_REQUIRED');
  return { channelId: value.channelId, bindingStamp: stamp(route.channel, route.binding) };
}

function routeFor(hub, routine) {
  const route = routine?.notification?.channelId && channelBinding(hub, routine.notification.channelId);
  return route && routine.notification.bindingStamp === stamp(route.channel, route.binding) ? route : null;
}

export function routineNoticeCurrent(hub, notice) {
  const routine = hub.get('routine', notice.routineId);
  if (!routine?.enabled || routine.endedAt || routine.endsAt && routine.endsAt <= hub.now() || routine.version !== notice.version || notice.expiresAt <= hub.now()) return false;
  try { assertRoutineScopeCurrent(hub, routine); } catch { return false; }
  const route = routeFor(hub, routine);
  return Boolean(route && notice.channelId === route.channel.id && notice.bindingStamp === stamp(route.channel, route.binding));
}

function stateFor(hub, notice) {
  if (['cancelled', 'expired'].includes(notice.state)) return notice.state;
  if (notice.candidateId) {
    const receipt = candidateReceipt(hub, notice.candidateId);
    return receipt?.state === 'pending' && receipt.deliveryId ? 'queued' : receipt?.state || 'unknown';
  }
  return notice.state;
}

function revisePendingDigest(hub, deliveryId) {
  const delivery = hub.get('delivery', deliveryId);
  if (delivery?.state !== 'pending') return;
  const attempt = hub.all('reachOutAttempt').find(row => row.deliveryId === deliveryId);
  if (!attempt) return;
  const candidates = attempt.candidates.map(id => hub.get('reachOutCandidate', id)).filter(candidate => candidate && !['cancelled', 'expired'].includes(candidate.state));
  if (!candidates.length) {
    hub.put('delivery', { ...delivery, state: 'cancelled', finishedAt: hub.now() });
    hub.put('reachOutAttempt', { ...attempt, state: 'cancelled', finishedAt: hub.now() });
    return;
  }
  // No claim has occurred: trim the queued digest in place, preserving its
  // exact-once delivery id and already reserved shared budget slot.
  const text = candidates.length === 1 ? candidates[0].text : `这次有 ${candidates.length} 条新发现：\n\n` + candidates.map(candidate => candidate.text).join('\n\n');
  hub.put('reachOutAttempt', { ...attempt, candidates: candidates.map(candidate => candidate.id) });
  hub.put('delivery', { ...delivery, text });
  const message = hub.get('message', delivery.messageId);
  if (message) hub.put('message', { ...message, text });
}

function cancelNotice(hub, notice, state, blocked) {
  const candidate = notice.candidateId && hub.get('reachOutCandidate', notice.candidateId);
  const delivery = notice.deliveryId && hub.get('delivery', notice.deliveryId);
  // A submitted/unknown send cannot be recalled, and must never be replayed.
  if (delivery && submitted.has(delivery.state)) return;
  if (candidate && ['pending', 'merged', 'reserved'].includes(candidate.state)) hub.put('reachOutCandidate', { ...candidate, state: 'cancelled', cancelledAttemptId: candidate.attemptId || null, attemptId: null });
  hub.put('routineNotice', { ...notice, state, blocked, cancelledDeliveryId: notice.deliveryId || notice.cancelledDeliveryId || null, deliveryId: null });
  if (delivery?.state === 'pending') revisePendingDigest(hub, delivery.id);
}

function cancelObsolete(hub) {
  for (const notice of hub.all('routineNotice')) {
    if (['journal', 'cancelled', 'expired'].includes(notice.state) || routineNoticeCurrent(hub, notice)) continue;
    cancelNotice(hub, notice, notice.expiresAt <= hub.now() ? 'expired' : 'cancelled', 'routine_changed');
  }
}

function cancelResolvedFailures(hub) {
  for (const notice of hub.all('routineNotice').filter(row => row.kind === 'failed' && row.candidateId)) {
    const resolved = hub.all('routineRun').some(row => row.routineId === notice.routineId && row.version === notice.version && row.reconciledAt && checked.has(row.status) && (row.finishedAt || row.createdAt) > notice.createdAt);
    if (!resolved) continue;
    if (['cancelled', 'expired'].includes(notice.state)) continue;
    cancelNotice(hub, notice, 'cancelled', 'recovered');
  }
}

function eventFor(hub, routine, occurrence, runs) {
  const previous = runs.filter(row => row.version === occurrence.version && (row.finishedAt || row.createdAt) < (occurrence.finishedAt || occurrence.createdAt));
  if (occurrence.status === 'published') {
    const facts = [...new Set((occurrence.facts || []).map(fact => fact.key))].sort();
    return { kind: 'changed', key: hash(facts.length ? facts : cut(occurrence.summary, 1200)), summary: cut(occurrence.summary, 260), reason: '发现符合回报条件的新变化', actionLabel: '查看变化与来源' };
  }
  if (occurrence.status === 'failed') {
    const latestChecked = previous.filter(row => checked.has(row.status)).at(-1);
    const failures = [...previous.filter(row => row.status === 'failed' && (!latestChecked || (row.finishedAt || row.createdAt) > (latestChecked.finishedAt || latestChecked.createdAt))), occurrence];
    if (failures.length < 2) return null;
    return { kind: 'failed', key: failures[0].id, summary: cut(occurrence.summary || occurrence.error || '暂时无法完成检查', 260), reason: '连续两次未能完成检查', actionLabel: '查看阻碍并处理' };
  }
  if (checked.has(occurrence.status)) {
    const prior = previous.at(-1);
    if (prior?.status !== 'failed') return null;
    const failure = hub.all('routineNotice').filter(row => row.routineId === routine.id && row.version === routine.version && row.kind === 'failed' && row.createdAt <= (occurrence.finishedAt || occurrence.createdAt)).at(-1);
    if (!failure) return null;
    return { kind: 'recovered', key: failure.id, summary: '已恢复读取并完成检查，后续按原计划继续。', reason: '之前受阻的巡查已经恢复', actionLabel: '回看检查结果', journalOnly: !submitted.has(stateFor(hub, failure)) };
  }
  return null;
}

function externalLink(href, baseUrl) {
  if (!baseUrl) return null;
  try { const url = new URL(baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null; url.hash = href.slice(1); return url.href.length <= 260 ? url.href : null; } catch { return null; }
}

function addNode(hub, routine, occurrence, event, baseUrl) {
  const id = hash([routine.id, event.kind, event.key]);
  if (hub.get('routineNotice', id)) return;
  const createdAt = occurrence.finishedAt || occurrence.createdAt, expiresAt = createdAt + 3 * 86400000;
  const href = '#journal/' + encodeURIComponent(routine.journalItemId), route = routeFor(hub, routine);
  const channelId = !event.journalOnly && route ? route.channel.id : null;
  const notice = { id, routineId: routine.id, journalItemId: routine.journalItemId, version: routine.version, occurrenceId: occurrence.id, kind: event.kind, summary: event.summary,
    reason: event.reason, actionLabel: event.actionLabel, href, createdAt, expiresAt, channelId, bindingStamp: channelId ? stamp(route.channel, route.binding) : null, state: channelId ? 'pending' : 'journal', candidateId: null, deliveryId: null };
  if (channelId && expiresAt > hub.now()) {
    const link = externalLink(href, baseUrl);
    const heading = `${cut(routine.title, 80)}：${event.reason}。`, action = event.actionLabel + (link ? '：' + link : '：打开Morlet手账中的同名事项');
    const message = `${heading}\n${cut(event.summary, Math.max(0, 498 - Array.from(heading + action).length))}\n${action}`;
    const candidate = offerReachOut(hub, { scope: 'owner', source: 'routine', key: id, topic: 'routine:' + id, kind: event.kind === 'failed' ? 'approval' : 'watch_hit', text: message, expiresAt, route: { channel: route.channel.channel, account: route.channel.id, peer: route.channel.peer } });
    notice.candidateId = candidate.id;
  } else if (channelId) notice.state = 'expired';
  hub.put('routineNotice', notice);
}

export function routineNotificationChannels(hub) {
  return hub.all('channelEndpoint').filter(channel => channelBinding(hub, channel.id)).map(channel => ({ id: channel.id, label: channel.label || (channel.channel === 'imessage' ? 'iMessage' : '桌面Morlet'), channel: channel.channel, online: Boolean(channel.ready && hub.now() - channel.lastSeen < 45000) }));
}

export function routineNotificationChannelSelected(hub, channelId) {
  return hub.all('routine').some(routine => !routine.endedAt && routeFor(hub, routine)?.channel.id === channelId);
}

export function routineNoticeSnapshot(hub) {
  const notices = hub.all('routineNotice').sort((a, b) => a.createdAt - b.createdAt).map(({ bindingStamp, ...notice }) => {
    const routine = hub.get('routine', notice.routineId), route = routeFor(hub, routine), state = stateFor(hub, notice);
    const policy = reachOutPolicy(hub);
    const blocked = ['pending', 'queued'].includes(state) && route ? reachOutGate(hub, 'owner', { ...(state === 'queued' && { phase: 'dispatch' }), channelReady: route.channel.ready && hub.now() - route.channel.lastSeen < 45000, conversationId: route.binding.conversationId }) ||
      (state === 'pending' && policy.mode === 'Digest' && hub.now() < Math.floor(notice.createdAt / (policy.digest_minutes * 60000) + 1) * policy.digest_minutes * 60000 ? 'digest_wait' : null) : notice.blocked || null;
    return { ...notice, state, blocked };
  });
  return { channels: routineNotificationChannels(hub), notices: notices.slice(-100), byRoutine: Object.fromEntries(hub.all('routine').map(routine => {
    const lastNotice = notices.filter(notice => notice.routineId === routine.id).at(-1) || null;
    return [routine.id, { channelId: routine.notification?.channelId || null, state: lastNotice?.state || 'journal', blocked: lastNotice?.blocked || null, lastNotice }];
  })) };
}

// Called after reconciliation, independent of browser/chat lifetime. The same
// durable occurrence and fact keys make retries/restarts safe.
export function syncRoutineNotices(hub, { baseUrl } = {}) {
  return hub.transaction(() => {
    cancelObsolete(hub);
    for (const routine of hub.all('routine')) {
      const runs = hub.all('routineRun').filter(row => row.routineId === routine.id && row.reconciledAt).sort((a, b) => (a.finishedAt || a.createdAt) - (b.finishedAt || b.createdAt));
      for (const occurrence of runs.filter(row => row.version === routine.version)) {
        const event = eventFor(hub, routine, occurrence, runs);
        if (event) addNode(hub, routine, occurrence, event, baseUrl);
      }
    }
    cancelObsolete(hub);
    cancelResolvedFailures(hub);
    drainRoutineNotices(hub);
    return routineNoticeSnapshot(hub);
  });
}

export function drainRoutineNotices(hub) {
  return hub.transaction(() => {
    cancelObsolete(hub);
    cancelResolvedFailures(hub);
    const routes = new Map();
    for (const notice of hub.all('routineNotice').filter(row => row.candidateId && routineNoticeCurrent(hub, row))) {
      const routine = hub.get('routine', notice.routineId), route = routeFor(hub, routine);
      routes.set(route.channel.id, route);
    }
    for (const { channel, binding } of routes.values()) {
      const attempt = reserveReachOut(hub, 'owner', { channel: channel.channel, account: channel.id, peer: channel.peer }, { channelReady: channel.ready && hub.now() - channel.lastSeen < 45000, conversationId: binding.conversationId,
        candidateFilter: candidate => candidate.source === 'routine' && hub.all('routineNotice').some(notice => notice.candidateId === candidate.id && routineNoticeCurrent(hub, notice)) });
      if (!attempt.id) continue;
      const delivery = hub.reply(binding.conversationId, attempt.text, { channel: channel.channel, account: channel.id, peer: channel.peer });
      finishReachOut(hub, attempt.id, 'queued', delivery.id);
      for (const notice of hub.all('routineNotice').filter(row => attempt.candidates.includes(row.candidateId))) hub.put('routineNotice', { ...notice, state: 'queued', blocked: null, deliveryId: delivery.id });
    }
  });
}

// Invoked by the existing channel claim boundary, before a message can leave.
// null means this delivery belongs to another producer.
export function routineDeliveryEligible(hub, delivery) {
  const notices = hub.all('routineNotice').filter(notice => notice.deliveryId === delivery.id);
  if (!notices.length) return null;
  const attempt = hub.all('reachOutAttempt').find(row => row.deliveryId === delivery.id), policy = reachOutPolicy(hub);
  const routine = hub.get('routine', notices[0].routineId), route = routeFor(hub, routine);
  if (!attempt || attempt.mode !== policy.mode || policy.mode === 'Off' || !route || route.binding.conversationId !== delivery.conversationId || notices.some(notice => !routineNoticeCurrent(hub, notice))) {
    hub.put('delivery', { ...delivery, state: 'cancelled', finishedAt: hub.now() }); return false;
  }
  return !reachOutGate(hub, 'owner', { phase: 'dispatch', channelReady: route.channel.ready && hub.now() - route.channel.lastSeen < 45000, conversationId: route.binding.conversationId });
}
