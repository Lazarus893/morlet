import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inQuiet, localTime, MINUTE } from './policy.mjs';

export const MODES = ['Off', 'Digest', 'Gentle', 'Active'];
const live = new Set(['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling']);
const digestKinds = new Set(['reference', 'followup']);
const hash = v => createHash('sha256').update(v).digest('hex');
const error = code => Object.assign(new Error(code), { code });
const defaults = { mode: 'Digest', max_daily: 2, min_gap_minutes: 180, max_analyses_daily: 40, digest_minutes: 60, quiet_start: '22:00', quiet_end: '09:00', timezone: 'UTC', revision: 0 };

function basePolicy(hub) {
  let local = {};
  try { local = JSON.parse(readFileSync(join(hub.root, '.runtime/pa.json'), 'utf8')).proactive || {}; } catch { /* Blank install. */ }
  const legacy = hub.get('personalNoticePolicy', 'owner');
  const saved = hub.get('reachOutPolicy', 'owner');
  const p = { ...defaults, timezone: local.timezone === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : local.timezone || 'UTC',
    ...Object.fromEntries(['max_daily', 'min_gap_minutes', 'quiet_start', 'quiet_end'].filter(k => local[k] !== undefined).map(k => [k, local[k]])),
    ...Object.fromEntries(['timezone', 'max_daily', 'min_gap_minutes', 'quiet_start', 'quiet_end', 'trial'].filter(k => legacy?.[k] !== undefined).map(k => [k, legacy[k]])), ...saved };
  return p;
}

export function reachOutPolicy(hub) {
  const p = basePolicy(hub);
  const trial = p.trial?.endsAt > hub.now() ? p.trial : null;
  return { ...p, ...(trial ? { max_daily: trial.max_daily, min_gap_minutes: trial.min_gap_minutes } : {}), trial };
}

export function configureReachOut(hub, input) {
  const allowed = ['operation', 'revision', 'mode', 'max_daily', 'min_gap_minutes', 'max_analyses_daily', 'digest_minutes', 'quiet_start', 'quiet_end', 'timezone', 'trial'];
  if (!input || Object.keys(input).some(k => !allowed.includes(k))) throw error('INVALID_INPUT');
  return hub.transaction(() => {
    const current = reachOutPolicy(hub);
    if (input.revision !== current.revision) throw error('VERSION_CONFLICT');
    // Never copy a temporary trial's effective limits into the normal policy.
    const saved = basePolicy(hub);
    const p = { ...saved, ...input, id: 'owner', revision: current.revision + 1 }; delete p.operation;
    if (!MODES.includes(p.mode)) throw error('INVALID_INPUT');
    for (const [key, low, high] of [['max_daily', 1, 20], ['min_gap_minutes', 5, 1440], ['max_analyses_daily', 1, 200], ['digest_minutes', 5, 1440]]) if (!Number.isInteger(p[key]) || p[key] < low || p[key] > high) throw error('INVALID_INPUT');
    try { localTime(hub.now(), p.timezone); inQuiet(hub.now(), p); if (p.quiet_start === p.quiet_end) throw 0; } catch { throw error('INVALID_INPUT'); }
    if (p.trial && (!Number.isSafeInteger(p.trial.endsAt) || p.trial.endsAt <= hub.now() || p.trial.endsAt > hub.now() + 30 * 86400000 || !Number.isInteger(p.trial.max_daily) || p.trial.max_daily < 1 || p.trial.max_daily > 20 || !Number.isInteger(p.trial.min_gap_minutes) || p.trial.min_gap_minutes < 5 || p.trial.min_gap_minutes > 1440)) throw error('INVALID_INPUT');
    hub.put('reachOutPolicy', p);
    if (p.mode === 'Off') cancelPendingReachOut(hub);
    return reachOutSnapshot(hub);
  });
}

function cancelPendingReachOut(hub) {
  for (const candidate of hub.all('reachOutCandidate').filter(row => row.scope === 'owner' && ['pending', 'merged', 'reserved'].includes(row.state))) {
    const attempt = candidate.attemptId && hub.get('reachOutAttempt', candidate.attemptId);
    const delivery = attempt?.deliveryId && hub.get('delivery', attempt.deliveryId);
    if (delivery && !['pending', 'cancelled'].includes(delivery.state) || attempt?.state === 'dispatching') continue;
    if (delivery) hub.put('delivery', { ...delivery, state: 'cancelled', finishedAt: hub.now() });
    if (attempt) hub.put('reachOutAttempt', { ...attempt, state: 'cancelled', finishedAt: hub.now() });
    hub.put('reachOutCandidate', { ...candidate, state: 'cancelled' });
  }
}

// Conversational pause/resume controls the shared reminder gate, not just one
// producer. Existing per-source and per-routine opt-ins remain unchanged.
export function pauseReachOut(hub) {
  return hub.transaction(() => {
    const current = reachOutPolicy(hub);
    if (current.mode === 'Off') return { changed: false, mode: 'Off' };
    configureReachOut(hub, { revision: current.revision, mode: 'Off' });
    hub.put('reachOutPause', { id: 'owner', previousMode: current.mode, pausedRevision: current.revision + 1, createdAt: hub.now() });
    return { changed: true, mode: 'Off' };
  });
}

export function resumeReachOut(hub) {
  return hub.transaction(() => {
    const current = reachOutPolicy(hub);
    if (current.mode !== 'Off') return { changed: false, mode: current.mode };
    const pause = hub.get('reachOutPause', 'owner');
    if (!pause || pause.pausedRevision !== current.revision || !MODES.includes(pause.previousMode) || pause.previousMode === 'Off') return { changed: false, mode: 'Off' };
    configureReachOut(hub, { revision: current.revision, mode: pause.previousMode });
    hub.put('reachOutPause', { ...pause, resumedAt: hub.now() });
    return { changed: true, mode: pause.previousMode };
  });
}

export function reachOutScope(hub, channel, account, peer) {
  return hub.binding(channel, account, peer)?.ownerId || hash(JSON.stringify([channel, account, peer]));
}

// Import counters once, so upgrading or changing mode cannot reset a budget.
export function importReachOutHistory(hub, scope, namespace, days = {}, lastAttempt = 0) {
  hub.transaction(() => {
    const id = hash(JSON.stringify([scope, namespace]));
    if (!hub.get('reachOutHistory', id)) hub.put('reachOutHistory', { id, scope, days, lastAttempt });
  });
}

function usage(hub, scope, now, policy) {
  const day = localTime(now, policy.timezone).day;
  const attempts = hub.all('reachOutAttempt').filter(a => a.scope === scope);
  const old = hub.all('reachOutHistory').filter(a => a.scope === scope);
  // Old personal notices are still the durable migration evidence. New ones
  // carry a gate candidate ID and are counted only by the shared attempt.
  const legacy = scope === 'owner' ? hub.all('personalNotice').filter(n => !n.candidateId) : [];
  return { today: attempts.filter(a => localTime(a.at, policy.timezone).day === day).length + old.reduce((n, h) => n + (h.days[day] || 0), 0) + legacy.filter(n => localTime(n.at, policy.timezone).day === day).length,
    lastAttempt: Math.max(0, ...attempts.map(a => a.at), ...old.map(a => a.lastAttempt), ...legacy.map(a => a.at)),
    analyses: hub.all('reachOutAnalysis').filter(a => a.scope === scope && localTime(a.at, policy.timezone).day === day).length };
}

export function reachOutGate(hub, scope, { enabled = true, channelReady = true, contextValid = true, conversationId, busy = false, lastInbound = 0, quiet = false, limits = {}, phase = 'delivery' } = {}) {
  const p = reachOutPolicy(hub), now = hub.now();
  // An explicitly enabled journal collection is independent of notifications.
  // Retain the shared analysis budget, including while notifications are quiet.
  if (phase === 'content') return !enabled ? 'content_paused' : usage(hub, scope, now, p).analyses >= p.max_analyses_daily ? 'analysis_budget' : null;
  if (!enabled || p.mode === 'Off') return 'paused';
  if (quiet || inQuiet(now, p)) return 'quiet_hours';
  if (!channelReady) return 'channel_offline';
  if (!contextValid) return 'context_expired';
  if (busy || conversationId && hub.all('run').some(r => r.conversationId === conversationId && live.has(r.status))) return 'conversation_active';
  const conversations = new Set(hub.all('binding').filter(b => b.ownerId === scope).map(b => b.conversationId));
  const inbound = Math.max(lastInbound, ...hub.all('message').filter(m => m.role === 'user' && (conversationId ? m.conversationId === conversationId : conversations.has(m.conversationId))).map(m => m.createdAt), 0);
  if (phase !== 'observation' && now - inbound < 5 * MINUTE) return 'recent_conversation';
  if (phase === 'dispatch') return null; // This attempt already owns its quota slot.
  const used = usage(hub, scope, now, p);
  if (phase === 'analysis' || phase === 'observation') return used.analyses >= p.max_analyses_daily ? 'analysis_budget' : null;
  if (used.today >= Math.min(p.max_daily, limits.max_daily || p.max_daily)) return 'daily_budget';
  if (used.lastAttempt && now - used.lastAttempt < Math.max(p.min_gap_minutes, limits.min_gap_minutes || 0) * MINUTE) return 'cooldown';
  return null;
}

export function reserveAnalysis(hub, scope, { key, count, ...context }) {
  return hub.transaction(() => {
    if (!Number.isInteger(count) || count <= 0) return { allowed: false, blocked: 'empty_checklist' };
    const blocked = reachOutGate(hub, scope, { ...context, phase: context.phase || 'analysis' });
    if (blocked) return { allowed: false, blocked };
    const id = hash(JSON.stringify([scope, key]));
    if (hub.get('reachOutAnalysis', id)) return { allowed: false, blocked: 'already_analyzed' };
    hub.put('reachOutAnalysis', { id, scope, at: hub.now() });
    return { allowed: true };
  });
}

export function offerReachOut(hub, { scope, key, topic, source, kind = 'reference', text, expiresAt, route }) {
  if (![scope, key, topic, source, text].every(v => typeof v === 'string' && v.trim()) || !['reference', 'followup', 'deadline', 'watch_hit', 'approval'].includes(kind) || !Number.isSafeInteger(expiresAt) || !route || !['weixin', 'imessage', 'desktop-pet'].includes(route.channel)) throw error('INVALID_INPUT');
  if (key.length > 256 || topic.length > 512 || Array.from(text).length > 500 || expiresAt <= hub.now()) throw error('INVALID_INPUT');
  return hub.transaction(() => {
    const id = hash(JSON.stringify([scope, source, key])), fingerprint = hash(JSON.stringify([text, expiresAt, route, topic, kind]));
    const prior = hub.get('reachOutCandidate', id);
    if (prior) { if (prior.fingerprint !== fingerprint) throw error('CONFLICT'); return prior; }
    const normalizedTopic = hash(topic.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' '));
    const same = hub.all('reachOutCandidate').find(c => c.scope === scope && c.topic === normalizedTopic && c.expiresAt > hub.now() && !['cancelled', 'expired', 'merged'].includes(c.state));
    const candidate = { id, scope, key, topic: normalizedTopic, source, kind, text, expiresAt, route, fingerprint, createdAt: hub.now(), state: same ? 'merged' : 'pending', mergedInto: same?.id || null };
    return hub.put('reachOutCandidate', candidate);
  });
}

export function candidateReceipt(hub, id) {
  let c = hub.get('reachOutCandidate', id);
  if (c?.mergedInto) c = hub.get('reachOutCandidate', c.mergedInto);
  const attempt = c?.attemptId && hub.get('reachOutAttempt', c.attemptId);
  return c ? { candidateId: id, deliveryId: attempt?.deliveryId || null, state: attempt?.deliveryId ? hub.get('delivery', attempt.deliveryId)?.state || 'unknown' : attempt?.state || c.state } : null;
}

// All producers submit candidates. Only this transaction reserves a delivery
// and its shared budget. A reserved/unknown attempt is never auto-replayed.
export function reserveReachOut(hub, scope, route, context = {}) {
  return hub.transaction(() => {
    const blocked = reachOutGate(hub, scope, context);
    if (blocked) return { blocked };
    const now = hub.now(), p = reachOutPolicy(hub);
    for (const c of hub.all('reachOutCandidate').filter(c => c.state === 'pending' && c.expiresAt <= now)) hub.put('reachOutCandidate', { ...c, state: 'expired' });
    let candidates = hub.all('reachOutCandidate').filter(c => c.scope === scope && c.state === 'pending' && c.expiresAt > now && JSON.stringify(c.route) === JSON.stringify(route) && (!context.candidateFilter || context.candidateFilter(c)));
    if (!candidates.length) return { blocked: 'empty_checklist' };
    const digest = p.mode === 'Digest' || p.mode === 'Gentle' && candidates.every(c => digestKinds.has(c.kind));
    if (digest && now < Math.floor(candidates[0].createdAt / (p.digest_minutes * MINUTE) + 1) * p.digest_minutes * MINUTE) return { blocked: 'digest_wait' };
    if (p.mode === 'Gentle' && !digest) candidates = candidates.filter(c => !digestKinds.has(c.kind));
    const chosen = []; let length = 0;
    for (const c of candidates) {
      if (chosen.length && length + c.text.length > 400) break;
      chosen.push(c); length += c.text.length;
      if (!digest || chosen.length >= 5) break;
    }
    const at = now, id = randomUUID();
    const text = chosen.length === 1 ? chosen[0].text : `这次有 ${chosen.length} 条新发现：\n\n` + chosen.map(c => c.text).join('\n\n');
    hub.put('reachOutAttempt', { id, scope, at, state: 'reserved', candidates: chosen.map(c => c.id), mode: p.mode });
    for (const c of chosen) hub.put('reachOutCandidate', { ...c, state: 'reserved', attemptId: id });
    return { id, text, candidates: chosen.map(c => c.id), mode: p.mode };
  });
}

export function finishReachOut(hub, id, state, deliveryId = null) {
  const attempt = hub.get('reachOutAttempt', id);
  if (!attempt || !['reserved', 'dispatching'].includes(attempt.state)) return;
  hub.put('reachOutAttempt', { ...attempt, state, deliveryId, finishedAt: hub.now() });
}

// The producer supplies candidate text and a transport. This is the only
// proactive Weixin send boundary; a persisted attempt is claimed exactly once.
export async function dispatchReachOut(hub, id, { context, preflight = () => true, send }) {
  const blocked = hub.transaction(() => {
    const attempt = hub.get('reachOutAttempt', id);
    if (!attempt || attempt.state !== 'reserved') return 'already_claimed';
    const reason = reachOutGate(hub, attempt.scope, { ...context(), phase: 'dispatch' }) ||
      (reachOutPolicy(hub).mode !== attempt.mode ? 'mode_changed' : null) || (!preflight() ? 'candidate_changed' : null);
    if (reason) { finishReachOut(hub, id, 'cancelled'); return reason; }
    hub.put('reachOutAttempt', { ...attempt, state: 'dispatching' });
    return null;
  });
  if (blocked) return { state: 'cancelled', blocked };
  try { await send(); finishReachOut(hub, id, 'submitted'); return { state: 'submitted' }; }
  catch { finishReachOut(hub, id, 'unknown'); return { state: 'delivery_unknown' }; }
}

export function reachOutSnapshot(hub, scope = 'owner') {
  const policy = reachOutPolicy(hub), now = hub.now(), used = usage(hub, scope, now, policy);
  return { policy, used, pending: hub.all('reachOutCandidate').filter(c => c.scope === scope && c.state === 'pending' && c.expiresAt > now).length,
    merged: hub.all('reachOutCandidate').filter(c => c.scope === scope && c.state === 'merged').length,
    unknown: hub.all('reachOutAttempt').filter(a => a.scope === scope && (['unknown', 'reserved', 'dispatching'].includes(a.state) || a.deliveryId && hub.get('delivery', a.deliveryId)?.state === 'unknown')).length };
}
