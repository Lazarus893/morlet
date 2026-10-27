export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const count = text => Array.from(text).length;
export const bounded = (text, size) => count(text) <= size ? text : Array.from(text).slice(0, size - 1).join('') + '…';
export const clock = text => {
  if (typeof text !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error('时间格式应为 HH:MM');
  const [hours, minutes] = text.split(':').map(Number);
  return hours * 60 + minutes;
};
export function validatePolicy(config) {
  if (typeof config.enabled !== 'boolean' || typeof config.timezone !== 'string') throw new Error('PROACTIVE_CONFIG_INVALID');
  clock(config.quiet_start); clock(config.quiet_end);
  if (config.quiet_start === config.quiet_end) throw new Error('PROACTIVE_CONFIG_INVALID');
  const limits = { max_daily: [1, 10], min_gap_minutes: [5, 1440], idle_minutes: [1, 60],
    day1_delay_minutes: [1, 1440], max_chars: [100, 500], max_observations_daily: [1, 200], context_ttl_hours: [1, 24] };
  for (const [name, [low, high]] of Object.entries(limits)) {
    if (!Number.isInteger(config[name]) || config[name] < low || config[name] > high) throw new Error('PROACTIVE_CONFIG_INVALID');
  }
  localTime(Date.now(), config.timezone);
}
export function localTime(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
export function inQuiet(now, preferences) {
  const minutes = localTime(now, preferences.timezone).minutes;
  const start = clock(preferences.quiet_start), end = clock(preferences.quiet_end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
export function deliveryGate(user, config, now, busy = false) {
  const p = { ...config, ...user.preferences };
  if (!config.enabled || !p.enabled) return 'paused';
  if (busy) return 'conversation_active';
  if (!user.contextToken || now - user.contextAt >= config.context_ttl_hours * 60 * MINUTE) return 'context_expired';
  if (inQuiet(now, p)) return 'quiet_hours';
  if (now - user.lastInbound < config.idle_minutes * MINUTE) return 'recent_conversation';
  if (user.lastAttempt && now - user.lastAttempt < p.min_gap_minutes * MINUTE) return 'cooldown';
  const day = localTime(now, p.timezone).day;
  if (user.deliveryDays[day] >= p.max_daily) return 'daily_budget';
  return null;
}
export function eligibleTasks(user, now) {
  return user.tasks.filter(t => t.status === 'pending' && t.notifyAt <= now && t.expiresAt > now)
    .sort((a, b) => (a.kind === 'welcome') - (b.kind === 'welcome') ||
      (a.kind !== 'reminder') - (b.kind !== 'reminder') || a.expiresAt - b.expiresAt);
}
export function parseInstant(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return NaN;
  const [date, time] = text.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || !/^(?:[01]\d|2[0-3]):[0-5]\d/.test(time)) return NaN;
  return Date.parse(text);
}
export function displayTime(now, timezone) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}
