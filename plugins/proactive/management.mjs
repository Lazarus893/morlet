// Shared management commands: UI/CLI use the same owner and persisted ledger as IM.
import { createHash } from 'node:crypto';
import { DAY, MINUTE, count, deliveryGate, localTime, validatePolicy } from './policy.mjs';
import { newId } from './observer.mjs';
const terminal = new Set(['done', 'cancelled', 'expired', 'skipped']);
export const accountKey = id => createHash('sha256').update(id).digest('hex');
export function failure(code) { const e = new Error(code); e.code = code; return e; }
export function snapshot(data, config, { allowed = () => true, busy = () => false, now = Date.now() } = {}) {
  const keys = ['enabled', 'timezone', 'quiet_start', 'quiet_end', 'max_daily', 'min_gap_minutes', 'max_chars'];
  return Object.entries(data.users).filter(([id]) => allowed(id)).map(([id, user]) => {
    const prefs = { ...config, ...user.preferences };
    return { id, revision: user.revision, preferences: Object.fromEntries(keys.map(k => [k, prefs[k]])),
      globalEnabled: config.enabled, blockedBy: deliveryGate(user, config, now, busy(id)),
      todayCount: user.deliveryDays[localTime(now, prefs.timezone).day] || 0,
      tasks: user.tasks.filter(t => t.kind !== 'welcome').map(t => Object.fromEntries(
        ['id', 'kind', 'title', 'evidence', 'status', 'notifyAt', 'dueAt', 'expiresAt', 'createdAt', 'updatedAt', 'lastAttempt', 'previousStatus'].filter(k => k in t).map(k => [k, t[k]]))),
      events: user.events.slice(-30).map(e => ({ at: e.at, code: e.code, ...(e.taskId ? { taskId: e.taskId } : {}) })), lastInbound: user.lastInbound };
  });
}
export function changeUser(data, config, request, { allowed = () => true, now = Date.now() } = {}) {
  const { userId, revision, operation } = request;
  if (typeof userId !== 'string') throw failure('INVALID_INPUT');
  const user = Object.hasOwn(data.users, userId) && data.users[userId];
  if (!user || !allowed(userId)) throw failure('USER_NOT_FOUND');
  if (!Number.isInteger(revision) || revision !== user.revision) throw failure('CONFLICT');
  if (operation === 'preferences') {
    const fields = new Set(['enabled', 'quiet_start', 'quiet_end', 'max_daily', 'max_chars', 'min_gap_minutes']);
    if (!request.values || typeof request.values !== 'object' || Array.isArray(request.values) || Object.keys(request.values).some(k => !fields.has(k))) throw failure('INVALID_INPUT');
    const prefs = { ...user.preferences, ...request.values };
    try { validatePolicy({ ...config, ...prefs }); } catch { throw failure('INVALID_INPUT'); }
    if (request.values.enabled === true && !config.enabled) throw failure('GLOBAL_DISABLED');
    user.preferences = prefs;
  } else if (operation === 'add') {
    const { title, notifyAt } = request;
    if (typeof title !== 'string' || !title.trim() || count(title) > 50 || !Number.isFinite(notifyAt) || notifyAt <= now || notifyAt > now + 366 * DAY) throw failure('INVALID_INPUT');
    if (user.tasks.filter(t => !terminal.has(t.status)).length >= 100) throw failure('TASK_LIMIT');
    user.tasks.push({ id: newId(), kind: 'reminder', title: title.trim(), evidence: title.trim(), status: 'pending', notifyAt, dueAt: null, expiresAt: notifyAt + 4 * 60 * MINUTE, createdAt: now });
  } else {
    const task = user.tasks.find(t => t.id === request.taskId && t.kind !== 'welcome');
    if (!task) throw failure('TASK_NOT_FOUND');
    if (operation === 'done' || operation === 'cancel') {
      if (terminal.has(task.status)) throw failure('INVALID_STATE');
      task.previousStatus = task.status === 'sending' ? 'delivery_unknown' : task.status;
      task.status = operation === 'done' ? 'done' : 'cancelled';
    } else if (operation === 'undo') {
      if (!['done', 'cancelled'].includes(task.status) || !task.previousStatus || task.expiresAt <= now) throw failure('INVALID_STATE');
      task.status = task.previousStatus; delete task.previousStatus;
    } else if (operation === 'snooze' || operation === 'update') {
      if (task.status === 'sending' || terminal.has(task.status)) throw failure('INVALID_STATE');
      if (operation === 'snooze') {
        if (!Number.isInteger(request.minutes) || request.minutes < 5 || request.minutes > 10080) throw failure('INVALID_INPUT');
        const next = now + request.minutes * MINUTE;
        if (task.dueAt && next >= task.dueAt) throw failure('PAST_DEADLINE');
        task.notifyAt = next; task.expiresAt = task.dueAt || next + 4 * 60 * MINUTE;
        task.status = 'pending';
      } else {
        if (typeof request.title !== 'string' || !request.title.trim() || count(request.title) > 50) throw failure('INVALID_INPUT');
        task.title = request.title.trim(); // Preserve the original evidence when correcting an interpretation.
      }
    } else throw failure('INVALID_INPUT');
    task.updatedAt = now;
  }
  user.revision++; user.controlRevision++;
  user.events.push({ at: now, code: 'managed_' + operation, ...(request.taskId ? { taskId: request.taskId } : {}) });
  user.events = user.events.slice(-60);
  return { revision: user.revision };
}
