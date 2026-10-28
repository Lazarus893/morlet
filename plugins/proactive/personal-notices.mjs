import { createHash } from 'node:crypto';
import { connectedServiceStatus } from '../agent-hub/source-bridge.mjs';
import { failure } from '../agent-hub/store.mjs';
import { inQuiet, localTime, MINUTE } from './policy.mjs';
import { reachOutPolicy, configureReachOut, pauseReachOut, resumeReachOut, reachOutGate, offerReachOut, reserveReachOut, finishReachOut, candidateReceipt } from './reach-out.mjs';
import { JournalStore } from '../life-journal/store.mjs';
import { createAutomaticContent } from './automatic-content.mjs';
import { drainRoutineNotices, routineDeliveryEligible, routineNotificationChannelSelected } from './routine-notices.mjs';

const SOURCES = ['google-calendar', 'google-mail', 'github', 'x', 'local-files'];
const live = new Set(['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling']);
const defaults = { enabled: false, channelId: null, timezone: 'UTC', quiet_start: '22:00', quiet_end: '09:00', max_daily: 2, min_gap_minutes: 180, sources: SOURCES };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const text = (v, max) => { if (typeof v !== 'string' || !v.trim() || Array.from(v).length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)) throw failure('INVALID_INPUT'); return v.trim(); };
const savedPreferences = hub => ({ ...defaults, ...hub.get('personalNoticePolicy', 'owner') });
const preferences = hub => {
  const saved = savedPreferences(hub), shared = reachOutPolicy(hub);
  return { ...saved, ...Object.fromEntries(['mode', 'timezone', 'quiet_start', 'quiet_end', 'max_daily', 'min_gap_minutes', 'trial'].map(k => [k, shared[k]])), enabled: saved.enabled && shared.mode !== 'Off', profile: shared.trial ? 'evaluation' : 'normal' };
};

export function personalNoticeSnapshot(hub) {
  const p = preferences(hub), c = p.channelId && hub.get('channelEndpoint', p.channelId);
  const worker = hub.get('personalNoticeWorker', 'mac');
  return { ...p, channel: c?.channel || null, worker: worker ? { ...worker, online: hub.now() - worker.lastSeenAt < 150000 } : null, channelReady: Boolean(c?.active && c.ready && hub.now() - c.lastSeen < 45000), notices: hub.all('personalNotice').slice(-20).map(n => ({ key: n.key, source: n.source, at: n.at, channelId: (n.candidateId ? hub.get('reachOutCandidate', n.candidateId)?.route : hub.get('delivery', n.deliveryId)?.source)?.account || null, deliveryId: n.deliveryId, state: n.candidateId ? candidateReceipt(hub, n.candidateId)?.state || 'unknown' : hub.get('delivery', n.deliveryId)?.state || 'unknown' })) };
}

// Owner settings use the existing authenticated Web session. Offers never carry
// a recipient or return route: those come exclusively from the verified binding.
export function managePersonalNotices(hub, input) {
  if (!exact(input, ['operation', 'enabled', 'channelId', 'sources', 'timezone', 'trial', 'key', 'source', 'text', 'observedAt', 'expiresAt', 'topic', 'kind'])) throw failure('INVALID_INPUT');
  if (input.operation === 'configure') {
    if (typeof input.enabled !== 'boolean') throw failure('INVALID_INPUT');
    const p = savedPreferences(hub), channelId = input.channelId ?? p.channelId, c = hub.get('channelEndpoint', channelId);
    if (!c?.active || !['imessage', 'desktop-pet'].includes(c.channel) || !hub.binding(c.channel, c.id, c.peer)) throw failure('IMESSAGE_BINDING_REQUIRED');
    const sources = input.sources ?? p.sources;
    if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length || sources.some(s => !SOURCES.includes(s))) throw failure('INVALID_INPUT');
    const timezone = input.timezone ?? p.timezone;
    try { if (typeof timezone !== 'string' || timezone.length > 100) throw 0; localTime(hub.now(), timezone); } catch { throw failure('INVALID_INPUT'); }
    let trial = p.trial;
    if (Object.hasOwn(input, 'trial')) {
      trial = input.trial;
      if (trial !== null && (!exact(trial, ['max_daily', 'min_gap_minutes', 'endsAt']) || !Number.isInteger(trial.max_daily) || trial.max_daily < 1 || trial.max_daily > 20 || !Number.isInteger(trial.min_gap_minutes) || trial.min_gap_minutes < 5 || trial.min_gap_minutes > 1440 || !Number.isSafeInteger(trial.endsAt) || trial.endsAt <= hub.now() || trial.endsAt > hub.now() + 30 * 24 * 60 * MINUTE)) throw failure('INVALID_INPUT');
    }
    hub.put('personalNoticePolicy', { ...p, id: 'owner', channelId, enabled: input.enabled, sources, timezone, trial, updatedAt: hub.now() });
    if (Object.hasOwn(input, 'trial')) configureReachOut(hub, { revision: reachOutPolicy(hub).revision, trial });
    return personalNoticeSnapshot(hub);
  }
  if (input.operation !== 'offer') throw failure('INVALID_OPERATION');
  const key = text(input.key, 256), message = text(input.text, 500);
  if (!SOURCES.includes(input.source) || !Number.isSafeInteger(input.observedAt) || !Number.isSafeInteger(input.expiresAt)) throw failure('INVALID_INPUT');
  const fingerprint = createHash('sha256').update(JSON.stringify([input.source, message, input.expiresAt, input.topic || key, input.kind || 'reference'])).digest('hex');
  return hub.transaction(() => {
    const now = hub.now(), p = preferences(hub), id = createHash('sha256').update(key).digest('hex'), old = hub.get('personalNotice', id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw failure('CONFLICT');
      return { accepted: true, replay: true, ...(old.candidateId ? candidateReceipt(hub, old.candidateId) : { deliveryId: old.deliveryId, state: hub.get('delivery', old.deliveryId)?.state || 'unknown' }) };
    }
    const blocked = reason => ({ accepted: false, blocked: reason });
    if (!p.enabled) return blocked('paused');
    if (!p.sources.includes(input.source)) return blocked('source_disabled');
    if (input.observedAt > now + MINUTE || now - input.observedAt > 10 * MINUTE || input.expiresAt <= now || input.expiresAt > now + 7 * 24 * 60 * MINUTE) return blocked('stale_source');
    const c = hub.get('channelEndpoint', p.channelId), b = c && hub.binding(c.channel, c.id, c.peer);
    if (!c?.active || !c.ready || now - c.lastSeen >= 45000 || !b) return blocked('channel_offline');
    const gate = reachOutGate(hub, 'owner', { enabled: p.enabled, channelReady: true, conversationId: b.conversationId });
    if (gate) return blocked(gate);
    const candidate = offerReachOut(hub, { scope: 'owner', key, topic: input.topic || key, source: input.source, kind: input.kind || 'reference', text: message, expiresAt: input.expiresAt, route: { channel: c.channel, account: c.id, peer: c.peer } });
    hub.put('personalNotice', { id, key, fingerprint, source: input.source, at: now, observedAt: input.observedAt, expiresAt: input.expiresAt, candidateId: candidate.id, authorityStamp: noticeSourceStamp(hub.root, input.source), deliveryId: null });
    drainPersonalNotices(hub);
    return { accepted: true, replay: false, ...candidateReceipt(hub, candidate.id) };
  });
}

export function personalNoticeContext(hub, account, deliveryId) {
  const c = hub.get('channelEndpoint', account), b = c && hub.binding(c.channel, c.id, c.peer);
  if (!c?.active || c.channel !== 'desktop-pet' || !c.chatEnabled || !b) throw failure('FORBIDDEN');
  const eligible = d => d.source?.channel === c.channel && d.source.account === c.id && d.source.peer === c.peer && d.conversationId === b.conversationId && d.state === 'submitted' && hub.now() - d.createdAt < 86400000 && hub.all('personalNotice').some(n => n.deliveryId === d.id);
  const d = deliveryId ? hub.get('delivery', deliveryId) : hub.all('delivery').filter(eligible).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!d || !eligible(d)) { if (deliveryId) throw failure('REPLY_CONTEXT_EXPIRED'); return null; }
  const notices = hub.all('personalNotice').filter(n => n.deliveryId === d.id);
  const store = new JournalStore(hub.root, { now: hub.now });
  try {
    const hasEntries = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='journal_content_entries'").get();
    const entries = (hasEntries ? notices.flatMap(n => store.db.prepare("SELECT data FROM journal_content_entries WHERE json_extract(data,'$.key')=? AND json_extract(data,'$.source')=?").all(n.key, n.source).map(row => JSON.parse(row.data))) : [])
      .map(({ id, title, summary, hook, url, topic, feedback }) => ({ id, title, summary, hook, url, topic, feedback }));
    return { deliveryId: d.id, text: d.text, at: d.createdAt, entries };
  } finally { store.close(); }
}

export function personalNoticeCommand(hub, channel, account, peer, input, context = {}) {
  if (!['imessage', 'desktop-pet'].includes(channel)) return null;
  if (channel === 'desktop-pet') {
    const c = hub.get('channelEndpoint', account);
    if (!c?.active || !c.chatEnabled || c.channel !== channel || c.peer !== peer) return null;
  }
  const reactions = { '有用': 'useful', '这条有用': 'useful', '少推': 'less', '少推这类': 'less', '不感兴趣': 'not_interested', '这类不感兴趣': 'not_interested', '撤回反馈': 'clear' };
  if (channel === 'desktop-pet' && (context.reaction || reactions[input.trim()])) {
    const reaction = context.reaction || reactions[input.trim()];
    if (!['useful', 'less', 'not_interested', 'clear'].includes(reaction)) throw failure('INVALID_INPUT');
    if (!context.replyTo) return '请先选择要反馈的推送；我不会猜是哪一条。';
    const target = personalNoticeContext(hub, account, context.replyTo);
    const entry = context.entryId ? target.entries.find(e => e.id === context.entryId) : target.entries.length === 1 ? target.entries[0] : null;
    if (!entry) return '这条推送含多个话题或没有对应材料，请在输入框中选择具体内容，或到手账里反馈。';
    const store = new JournalStore(hub.root, { now: hub.now });
    try { createAutomaticContent({ hub, journal: { store } }).feedback({ operation: 'feedback', id: entry.id, reaction }); }
    finally { store.close(); }
    return `关于「${entry.title.slice(0, 65)}」：${({ useful: '记下了，之后会更留意这个话题。', less: '记下了，这类内容会少一些。', not_interested: '记下了，先暂停这个话题。', clear: '已撤回这条反馈。' })[reaction]}`;
  }
  const p = preferences(hub), c = hub.get('channelEndpoint', p.channelId);
  const command = input.trim(), incoming = hub.get('channelEndpoint', account), binding = incoming && hub.binding(channel, account, peer);
  const controlsNotifications = incoming?.active && incoming.channel === channel && incoming.peer === peer && binding?.ownerId === 'owner' &&
    (c?.id === account || routineNotificationChannelSelected(hub, account));
  if (controlsNotifications && ['暂停提醒', '暂停主动推送', '/pa off'].includes(command)) {
    pauseReachOut(hub);
    return '好，我先安静一阵。主动提醒已暂停，巡查继续记录在手账；有事照常发消息就好。';
  }
  if (controlsNotifications && ['恢复提醒', '恢复主动推送', '/pa on'].includes(command)) {
    const restored = resumeReachOut(hub), policy = reachOutPolicy(hub);
    if (restored.mode === 'Off') return '提醒仍处于关闭状态。暂停后设置已变化，请在设置中选择提醒模式。';
    return `已恢复 ${restored.mode} 模式，原有授权和各项提醒开关保持不变。每天最多${policy.max_daily}条，${policy.quiet_start}–${policy.quiet_end}保持安静。`;
  }
  if (controlsNotifications && ['提醒设置', '提醒列表', '/pa'].includes(command)) {
    const policy = reachOutPolicy(hub);
    const routineEnabled = hub.all('routine').some(routine => routine.enabled && !routine.endedAt && routine.notification?.channelId === account && (!routine.endsAt || routine.endsAt > hub.now()));
    const enabled = policy.mode !== 'Off' && (c?.id === account && p.enabled || routineEnabled);
    return `主动提醒 ${policy.mode}；${channel === 'desktop-pet' ? '桌面Morlet' : 'iMessage'}${enabled ? '开启' : '暂停'}。共享额度每天最多${policy.max_daily}条，间隔至少${policy.min_gap_minutes}分钟，静默${policy.quiet_start}–${policy.quiet_end}（${policy.timezone}）。`;
  }
  if (!c?.active || c.id !== account || c.peer !== peer) return null;
  const reaction = channel === 'imessage' && reactions[input.trim()];
  if (reaction) {
    // Resolve only an unambiguous, actually delivered recommendation. A digest
    // with several topics or an intervening reply needs a per-entry selection.
    const last = hub.all('delivery').filter(d => d.source?.channel === channel && d.source.account === account && d.source.peer === peer && ['sent', 'delivered', 'read'].includes(d.state))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const notices = last && hub.now() - last.createdAt < 86400000 ? hub.all('personalNotice').filter(n => n.deliveryId === last.id) : [];
    if (notices.length !== 1) return '请在手账里点这条内容下的反馈，避免把偏好记到别的话题上。';
    const store = new JournalStore(hub.root, { now: hub.now });
    try {
      const content = createAutomaticContent({ hub, journal: { store } });
      const records = store.db.prepare('SELECT data FROM journal_content_entries').all().map(row => JSON.parse(row.data))
        .filter(row => row.key === notices[0].key && row.source === notices[0].source);
      if (records.length !== 1) return '这条提醒还没有对应的手账材料，请在手账里选择具体内容反馈。';
      content.feedback({ operation: 'feedback', id: records[0].id, reaction });
      return ({ useful: '记下了，之后会更留意这个话题。', less: '记下了，这类内容会少一些。', not_interested: '记下了，先暂停这个话题。', clear: '已撤回这条反馈。' })[reaction];
    } finally { store.close(); }
  }
  return null;
}

export function drainPersonalNotices(hub) {
  return hub.transaction(() => {
    const p = preferences(hub), c = hub.get('channelEndpoint', p.channelId), b = c && hub.binding(c.channel, c.id, c.peer);
    if (!c || !b) return;
    for (const n of hub.all('personalNotice').filter(n => n.candidateId)) {
      const candidate = hub.get('reachOutCandidate', n.candidateId);
      if (candidate?.state === 'pending' && (!p.enabled || !p.sources.includes(n.source) || candidate.route.channel !== c.channel || candidate.route.account !== c.id)) hub.put('reachOutCandidate', { ...candidate, state: 'cancelled' });
    }
    const attempt = reserveReachOut(hub, 'owner', { channel: c.channel, account: c.id, peer: c.peer }, { enabled: p.enabled, channelReady: c.active && c.ready && hub.now() - c.lastSeen < 45000, conversationId: b.conversationId,
      candidateFilter: candidate => hub.all('personalNotice').some(notice => notice.candidateId === candidate.id) });
    if (!attempt.id) return;
    const queued = hub.reply(b.conversationId, attempt.text, { channel: c.channel, account: c.id, peer: c.peer });
    finishReachOut(hub, attempt.id, 'queued', queued.id);
    for (const n of hub.all('personalNotice').filter(n => attempt.candidates.includes(n.candidateId))) hub.put('personalNotice', { ...n, deliveryId: queued.id });
  });
}

// The bridge rechecks policy immediately before claiming a proactive delivery.
// Ordinary replies remain available during quiet hours or a proactive pause.
export function noticeSourceStamp(root, source) {
  const capability = { 'google-calendar': ['google', 'calendar'], 'google-mail': ['google', 'gmail'], github: ['github', 'repos'], x: ['x', 'read'], 'local-files': ['files', 'readable'] }[source];
  const service = capability && connectedServiceStatus(root).find(s => s.id === capability[0]);
  const allowed = service?.enabled && ['connected', 'limited'].includes(service.state) && Number.isSafeInteger(service.generation) && service.permissions.some(p => p.id === capability[1] && p.granted && p.verified) && (source !== 'local-files' || ['common-folders', 'all-readable-files'].includes(service.scope));
  return allowed ? createHash('sha256').update(JSON.stringify([service.id, service.generation, service.accountFingerprint, service.scope || null])).digest('hex') : null;
}
export const noticeSourceAllowed = (root, source, notice) => {
  const stamp = noticeSourceStamp(root, source);
  return Boolean(stamp && stamp === notice?.authorityStamp);
};

export function personalChannelPoll(hub, token, { sourceAllowed = (source, notice) => noticeSourceAllowed(hub.root, source, notice) } = {}) {
  const c = hub.authenticateChannel(token);
  drainPersonalNotices(hub);
  drainRoutineNotices(hub);
  if (!c.ready || hub.now() - c.lastSeen >= 45000) return { delivery: null };
  const d = hub.takeDelivery(c.channel, c.id, peer => peer === c.peer, delivery => {
    const routineEligible = routineDeliveryEligible(hub, delivery);
    if (routineEligible !== null) return routineEligible;
    const notices = hub.all('personalNotice').filter(n => n.deliveryId === delivery.id);
    if (!notices.length) return c.channel !== 'desktop-pet' || c.chatEnabled === true && delivery.conversationId === hub.binding(c.channel, c.id, c.peer)?.conversationId;
    const p = preferences(hub), now = hub.now(), b = hub.binding(c.channel, c.id, c.peer);
    const attempt = hub.all('reachOutAttempt').find(a => a.deliveryId === delivery.id);
    if (!p.enabled || attempt && attempt.mode !== p.mode || p.channelId !== c.id || notices.some(n => !p.sources.includes(n.source) || n.expiresAt <= now || !sourceAllowed(n.source, n)) || !b || b.conversationId !== delivery.conversationId) {
      hub.put('delivery', { ...delivery, state: 'cancelled', finishedAt: now }); return false;
    }
    return !inQuiet(now, p) && !hub.all('run').some(r => r.conversationId === b.conversationId && live.has(r.status)) &&
      !hub.all('message').some(m => m.conversationId === b.conversationId && m.role === 'user' && now - m.createdAt < 5 * MINUTE);
  });
  return { delivery: d && { id: d.id, text: d.text, peer: c.peer } };
}
