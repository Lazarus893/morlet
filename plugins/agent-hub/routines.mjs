import { resolveBot } from './bots.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { failure } from './store.mjs';
import { hubConfig } from './config.mjs';
import { normalizeRoutineNotification } from '../proactive/routine-notices.mjs';
import { ROUTINE_SCOPE_SCHEMA, normalizeRoutineScope, bindRoutineScope, assertRoutineScopeCurrent, routineScopeView, routineSourceOptions, routineScopeFingerprint } from './routine-scope.mjs';

const LOCAL = { account: 'local', userId: 'owner' };
const ACTIVE = new Set(['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling']);
const SUMMARY_LIMIT = 1200;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw failure('INVALID_INPUT');
  return value.trim();
}
function boundedSummary(value) {
  if (value.length <= SUMMARY_LIMIT) return value;
  const suffix = '\n…（部分内容已省略）';
  return value.slice(0, SUMMARY_LIMIT - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
}
const scheduleSchema = { type: 'object', additionalProperties: false, properties: { time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }, timezone: { type: 'string' }, days: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } } }, required: ['time', 'timezone', 'days'] };
const triggerSchema = { type: 'object', additionalProperties: false, properties: { condition: { type: 'string' }, mode: { type: 'string', enum: ['changed', 'always'] } }, required: ['condition', 'mode'] };
export const ROUTINE_TOOL = { type: 'function', name: 'xiaoman_routines', description: 'Create and manage durable daily or weekday patrols. List first for server time and versions. A routine saves a calendar Timer and a Trigger, checks through the selected Agent, and reports useful results in its journal. External notifications require a separately configured owner-approved channel; this tool cannot enable or change that channel. Scope binds only the listed source operations and exact filters; omitted scope allows public Web only. Ask before expanding private source access. End permanently stops a routine; resuming an ended routine is forbidden. Use stable facts identifying the actual source event or revision, not the check date. Background checks must submit result after successful reads; missing or failed reads are never evidence of no change. checks.source must match an actual current-run receipt: the requested page URL, search: followed by the exact query, or source-request: followed by xiaoman_sources execution.requestId. Inventory/list is not a data read. Only a current background run may submit result. Never claim a schedule was saved without its receipt.', inputSchema: {
  type: 'object', additionalProperties: false, properties: {
    operation: { type: 'string', enum: ['list', 'get', 'create', 'update', 'pause', 'resume', 'end', 'authorize_scope', 'run_now', 'verify', 'result'] },
    id: { type: 'string', description: 'Routine ID. Optional for result: the authenticated run already selects its routine; if supplied, this must match that current routine.' },
    version: { type: 'integer', description: 'Routine version. Optional for result: if supplied, it must match the current authenticated run. It cannot select another run or renew an old authorization.' },
    values: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, instruction: { type: 'string' }, schedule: scheduleSchema, trigger: triggerSchema, endpointId: { type: 'string' }, botId: { type: 'string' }, enabled: { type: 'boolean' }, notification: { type: 'object', additionalProperties: false, properties: { channelId: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['channelId'] }, scope: ROUTINE_SCOPE_SCHEMA, endsAt: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } } },
    matched: { type: 'boolean' }, summary: { type: 'string' }, facts: { type: 'array', maxItems: 60, items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, summary: { type: 'string' }, url: { type: 'string' } }, required: ['key', 'summary'] } },
    outcome: { type: 'string', enum: ['checked', 'blocked'] }, checks: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: { source: { type: 'string' }, observedAt: { type: 'integer' } }, required: ['source', 'observedAt'] } },
  }, required: ['operation'],
} };

function validateValues(input, previous, hub) {
  if (!exact(input, ['title', 'instruction', 'schedule', 'trigger', 'endpointId', 'botId', 'enabled', 'scope', 'endsAt', 'notification'])) throw failure('INVALID_INPUT');
  const values = { ...(previous || {}), ...input };
  values.title = text(values.title, 80); values.instruction = text(values.instruction, 8000);
  const s = values.schedule, t = values.trigger;
  if (!exact(s, ['time', 'timezone', 'days']) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '') || !Array.isArray(s.days) || !s.days.length || s.days.length > 7 || s.days.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(s.days).size !== s.days.length) throw failure('INVALID_INPUT');
  try { new Intl.DateTimeFormat('en', { timeZone: text(s.timezone, 100) }).format(0); } catch { throw failure('INVALID_INPUT'); }
  values.schedule = { time: s.time, timezone: s.timezone, days: [...s.days].sort((a, b) => a - b) };
  if (!exact(t, ['condition', 'mode']) || !['changed', 'always'].includes(t.mode)) throw failure('INVALID_INPUT');
  values.trigger = { condition: text(t.condition, 2000), mode: t.mode };
  if (values.endpointId !== undefined) values.endpointId = text(values.endpointId, 100);
  if (values.enabled !== undefined && typeof values.enabled !== 'boolean') throw failure('INVALID_INPUT');
  if (values.endsAt !== undefined && values.endsAt !== null && (!Number.isSafeInteger(values.endsAt) || values.endsAt <= hub.now())) throw failure('INVALID_INPUT');
  if (!previous) Object.assign(values, bindRoutineScope(hub, input.scope));
  else if (Object.hasOwn(input, 'scope')) {
    const scope = normalizeRoutineScope(input.scope);
    if (hash(scope) !== hash(normalizeRoutineScope(previous.scope))) Object.assign(values, bindRoutineScope(hub, scope));
    else values.scope = scope;
  }
  if (!previous || Object.hasOwn(input, 'notification')) values.notification = normalizeRoutineNotification(hub, input.notification);
  return values;
}

function calendarParts(at, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(part => [part.type, part.value]));
}
function localInstant(day, time, timezone) {
  const wall = Date.parse(`${day}T${time}:00Z`), offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const at = wall + hours * 3600000, p = calendarParts(at, timezone);
    offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - at);
  }
  // A repeated DST clock hour runs once, at its first occurrence. A nonexistent
  // local time is skipped that day, rather than drifting every subsequent day.
  return [...offsets].map(offset => wall - offset).filter(at => {
    const p = calendarParts(at, timezone);
    return `${p.year}-${p.month}-${p.day}` === day && `${p.hour}:${p.minute}` === time;
  }).sort((a, b) => a - b)[0] ?? null;
}
export function routineTimes(schedule, now) {
  const p = calendarParts(now, schedule.timezone), date = Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`), times = [];
  // Include a second weekly occurrence: a DST gap may remove the only chosen
  // weekday in the nearest week (for example Sunday 02:30 in New York).
  for (let offset = -15; offset <= 15; offset++) {
    const day = new Date(date + offset * 86400000);
    if (!schedule.days.includes(day.getUTCDay() || 7)) continue;
    const at = localInstant(day.toISOString().slice(0, 10), schedule.time, schedule.timezone);
    if (at !== null) times.push(at);
  }
  return { previous: times.filter(at => at <= now).at(-1) ?? null, next: times.find(at => at > now) ?? null };
}

function validateResult(input, run, now) {
  if (!exact(input, ['operation', 'id', 'version', 'outcome', 'matched', 'summary', 'facts', 'checks']) || !['checked', 'blocked'].includes(input.outcome) || typeof input.matched !== 'boolean' || !Array.isArray(input.facts) || input.facts.length > 60 || !Array.isArray(input.checks) || input.checks.length > 30 || input.outcome === 'checked' && !input.checks.length || input.outcome === 'blocked' && input.matched) throw failure('INVALID_INPUT');
  if (Object.hasOwn(input, 'id') && input.id !== run.routine.id) throw failure('FORBIDDEN');
  if (Object.hasOwn(input, 'version') && input.version !== run.routine.version) throw failure('VERSION_CONFLICT');
  const result = { outcome: input.outcome, matched: input.matched, summary: text(input.summary, SUMMARY_LIMIT), checks: input.checks.map(check => {
    if (!exact(check, ['source', 'observedAt']) || !Number.isSafeInteger(check.observedAt) || check.observedAt < run.createdAt - 60000 || check.observedAt > now + 60000) throw failure('INVALID_INPUT');
    return { source: text(check.source, 2048), observedAt: check.observedAt };
  }), facts: input.facts.map(fact => {
    if (!exact(fact, ['key', 'summary', 'url'])) throw failure('INVALID_INPUT');
    const value = { key: text(fact.key, 256), summary: text(fact.summary, 1000) };
    if (fact.url !== undefined) {
      let url; try { url = new URL(fact.url); } catch { throw failure('INVALID_INPUT'); }
      if (!/^https?:\/\//i.test(fact.url) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\s\\]/.test(fact.url) || fact.url.length > 2048) throw failure('INVALID_INPUT');
      value.url = url.href;
    }
    return value;
  }) };
  if (new Set(result.facts.map(fact => fact.key)).size !== result.facts.length) throw failure('INVALID_INPUT');
  return result;
}

function sourceIdentity(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('search:')) return 'search:' + value.slice(7).trim();
  if (value.startsWith('source-request:')) return value;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = ''; return url.href;
  } catch { return null; }
}
function incompleteSource(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return false;
  if (value.truncated === true || value.complete === false) return true;
  return Object.values(value).some(child => incompleteSource(child, depth + 1));
}
function verifiedSources(hub, runId, claims) {
  const native = hub.all('nativeSourceReceipt').filter(row => row.runId === runId);
  const requested = new Set(claims.map(check => sourceIdentity(check.source)));
  const fullPage = native.some(row => row.tool === 'web_fetch' && row.status === 'completed');
  // Search is a bounded discovery directory. An undeclared partial directory
  // may lead to a complete page read; an actual failed page cannot be hidden by
  // omitting it from the model's checks.
  const gaps = native.filter(row => row.status !== 'completed' && (row.tool === 'web_fetch' || requested.has(row.source) || !fullPage)).map(row => ({ source: row.source, status: row.status }));
  const evidence = new Map(native.map(row => [row.source, { source: row.source, observedAt: row.observedAt }]));
  const resources = new Map();
  for (const row of hub.all('sourceRequest').filter(row => row.runId === runId).sort((a, b) => (a.finishedAt || a.createdAt || 0) - (b.finishedAt || b.createdAt || 0))) {
    const args = row.arguments || {};
    // Inventory describes permissions, not data actually read.
    if (args.operation === 'list') continue;
    const identity = Object.fromEntries(Object.entries(args).filter(([key]) => !['max', 'limit', 'perPage', 'pages', 'maxReleases', 'maxCommits', 'includePatches'].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
    const key = hash(identity), old = resources.get(key);
    resources.set(key, { row, aliases: [...(old?.aliases || []), 'source-request:' + row.id] });
  }
  for (const { row, aliases } of resources.values()) {
    if (row.status !== 'completed' || !row.result || incompleteSource(row.result)) { gaps.push({ source: 'source-request:' + row.id, operation: row.arguments?.operation || '', status: row.status === 'completed' ? 'incomplete' : 'failed' }); continue; }
    const args = row.arguments || {}, result = row.result;
    if (!args.operation) continue;
    if (typeof result.url === 'string') aliases.push(sourceIdentity(result.url));
    if (args.operation === 'github_updates' && args.repo) aliases.push(sourceIdentity('https://github.com/' + args.repo));
    if (args.operation === 'docs_read' && args.documentId) aliases.push(sourceIdentity('https://docs.google.com/document/d/' + args.documentId + '/edit'));
    if (args.operation === 'sheets_read' && args.spreadsheetId) aliases.push(sourceIdentity('https://docs.google.com/spreadsheets/d/' + args.spreadsheetId + '/edit'));
    const verified = { source: 'source-request:' + row.id, observedAt: row.finishedAt || row.createdAt, operation: args.operation };
    for (const alias of aliases.filter(Boolean)) evidence.set(alias, verified);
  }
  if (gaps.length) return { error: 'ROUTINE_SOURCE_INCOMPLETE', checks: [], gaps };
  const checks = [];
  for (const claim of claims) {
    const verified = evidence.get(sourceIdentity(claim.source));
    if (!verified) return { error: 'ROUTINE_SOURCE_UNVERIFIED', checks: [], gaps: [{ source: claim.source, status: 'unverified' }] };
    if (!checks.some(check => check.source === verified.source)) checks.push(verified);
  }
  return checks.length ? { error: null, checks, gaps: [] } : { error: 'ROUTINE_SOURCE_UNVERIFIED', checks: [], gaps: [] };
}

export function createRoutineController({ hub, journal, read }) {
  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let timezone = read ? null : hostTimezone, ticking;
  async function refreshSettings() {
    if (!read) return;
    const settings = await read(), configured = settings.config?.proactive?.timezone;
    const next = configured && configured !== 'local' ? configured : hostTimezone;
    try { new Intl.DateTimeFormat('en', { timeZone: next }).format(0); } catch { throw failure('INVALID_INPUT'); }
    timezone = next;
  }
  const journalItem = routine => journal.store.snapshot(LOCAL).items.find(item => item.id === routine.journalItemId);
  function link(routine) {
    if (routine.journalItemId) return routine;
    const item = journal.store.ensureConversation(LOCAL, { conversationId: routine.conversationId, content: routine.title + '\n' + routine.instruction });
    return hub.transaction(() => {
      const current = hub.get('routine', routine.id);
      return hub.put('routine', { ...current, journalItemId: item.id, error: null });
    });
  }
  function reconcile(runId) {
    return hub.transaction(() => {
      let run = hub.get('run', runId);
      if (!run?.routine) return;
      const routine = hub.get('routine', run.routine.id), occurrence = hub.get('routineRun', run.routine.occurrenceId);
      if (!occurrence || occurrence.reconciledAt) return occurrence;
      const item = routine?.journalItemId && journalItem(routine);
      let status = run.status, error = null, published = false, checkedSources = [], publicationFacts = [], gaps = [];
      let scopeError = null;
      if (routine) { try { assertRoutineScopeCurrent(hub, routine); } catch (cause) { scopeError = cause.code; } }
      const obsolete = !routine || !routine.enabled || routine.endedAt || routine.endsAt && routine.endsAt <= hub.now() || routine.version !== run.routine.version || !item || ['done', 'cancelled'].includes(item.status);
      if (scopeError && ACTIVE.has(status) && status !== 'cancelling') { hub.cancelRun(run); run = hub.get('run', runId); status = run.status; }
      if (ACTIVE.has(status)) {
        if (obsolete && status !== 'cancelling') { hub.cancelRun(run); run = hub.get('run', runId); status = run.status; }
        if (ACTIVE.has(status)) return hub.put('routineRun', { ...occurrence, status, ...(status === 'uncertain' && { error: run.error || 'EXECUTION_UNCERTAIN' }) });
      }
      const result = run.routineResult;
      if (obsolete) status = 'superseded';
      else if (scopeError) { status = 'failed'; error = scopeError; }
      else if (status === 'completed') {
        const verification = result ? verifiedSources(hub, runId, result.checks) : null;
        gaps = verification?.gaps || [];
        checkedSources = verification?.checks || [];
        if (!result) { status = 'failed'; error = 'ROUTINE_RESULT_MISSING'; }
        else if (result.outcome === 'blocked') { status = 'failed'; error = 'ROUTINE_CHECK_BLOCKED'; }
        else if (verification?.error) { status = 'failed'; error = verification.error; }
        else if (run.report && run.report.outcome !== 'completed') { status = 'failed'; error = 'ROUTINE_INCOMPLETE'; }
        else {
          const scopeHash = routineScopeFingerprint(routine);
          const fresh = result.facts.filter(fact => {
            const previous = hub.get('routineFact', hash([routine.id, fact.key]));
            // Existing unscoped receipts still suppress duplicate notifications,
            // but their keys are never injected into the new model context.
            return !previous || previous.scopeHash && previous.scopeHash !== scopeHash;
          });
          published = result.matched && (routine.trigger.mode === 'always' || fresh.length > 0);
          publicationFacts = routine.trigger.mode === 'changed' ? fresh : result.facts;
          status = published ? 'published' : 'quiet';
          if (published) for (const fact of fresh) hub.put('routineFact', { id: hash([routine.id, fact.key]), routineId: routine.id, key: fact.key, scopeHash, firstRunId: runId, seenAt: hub.now() });
        }
      } else if (status === 'failed') error = run.error || 'AGENT_FAILED';
      // Keep the original model submission in run.routineResult for audit. A
      // mixed old/new batch must not reintroduce old facts through its prose,
      // artifacts, or the occurrence later used by notification delivery.
      const mixed = published && publicationFacts.length < result.facts.length;
      const summary = mixed ? boundedSummary(publicationFacts.map(fact => fact.summary).join('\n')) : error ? (result?.summary || run.report?.summary || null) : result?.summary || null;
      const finished = hub.put('routineRun', { ...occurrence, status, error, summary, gaps, checks: checkedSources, facts: published ? publicationFacts : result?.facts || [], finishedAt: run.finishedAt || hub.now(), reconciledAt: hub.now() });
      const artifacts = published ? [...new Map([...publicationFacts.filter(fact => fact.url).map(fact => ({ label: fact.summary.slice(0, 160), url: fact.url })), ...(routine.trigger.mode === 'always' ? run.report?.artifacts || [] : [])].map(artifact => [artifact.url || artifact.path, artifact])).values()].slice(0, 12) : [];
      hub.put('run', { ...run, routinePublished: published, routineOutcome: status, ...(published ? { report: { ...run.report, title: routine.title, summary, outcome: 'completed', updatedAt: hub.now(), artifacts } } : {}) });
      if (routine && routine.version === run.routine.version) hub.put('routine', { ...routine, lastRunId: occurrence.id, error });
      return finished;
    });
  }
  // Event delivery can originate from another Hub handle; tick also reconciles
  // all unfinished occurrences, so the hook is an optimization, not authority.
  hub.reconcileRoutineRun = reconcile;
  function view(routine) {
    let lastRun = hub.all('routineRun').filter(row => row.routineId === routine.id).sort((a, b) => b.createdAt - a.createdAt || b.scheduledAt - a.scheduledAt)[0] || null;
    if (lastRun?.status === 'failed' && !lastRun.gaps) {
      const run = hub.get('run', lastRun.runId);
      lastRun = { ...lastRun, gaps: verifiedSources(hub, lastRun.runId, run?.routineResult?.checks || []).gaps || [] };
    }
    const scope = routineScopeView(hub, routine), next = routineTimes(routine.schedule, hub.now()).next;
    const ended = !!routine.endedAt || !!routine.endsAt && routine.endsAt <= hub.now();
    return { ...routine, ...scope, ended, revision: routine.version, nextRunAt: routine.enabled && !ended && !scope.scopeStatus.blocked && (!routine.endsAt || next <= routine.endsAt) ? next : null,
      lastRun, lastRunAt: lastRun?.finishedAt || lastRun?.createdAt || null, lastStatus: lastRun?.status || null, lastSummary: lastRun?.summary || null, error: scope.scopeStatus.error || routine.error || lastRun?.error || null };
  }
  function backgroundView(routine) {
    const { lastRun, lastSummary, lastRunId, lastRunAt, lastStatus, scopeBindings, ...visible } = routine;
    return visible;
  }
  function snapshot() {
    return { now: hub.now(), timezone, hostTimezone, sourcesAvailable: routineSourceOptions(hub), routines: hub.all('routine').map(view), runs: hub.all('routineRun').slice(-100).reverse() };
  }
  function enqueue(routine, scheduledAt, occurrenceId, manual = false) {
    return hub.transaction(() => {
      const current = hub.get('routine', routine.id);
      if (current?.endedAt || current?.endsAt && current.endsAt <= hub.now()) throw failure('ROUTINE_ENDED');
      if (!current?.enabled || current.version !== routine.version) throw failure('ROUTINE_PAUSED');
      assertRoutineScopeCurrent(hub, current);
      const existing = hub.get('routineRun', occurrenceId);
      if (existing) return existing;
      const item = journalItem(current);
      if (!item || ['done', 'cancelled'].includes(item.status)) throw failure('JOURNAL_CLOSED');
      if (hub.all('run').some(run => run.routine?.id === current.id && ACTIVE.has(run.status))) throw failure('ROUTINE_BUSY');
      const knownKeys = []; let knownLength = 0;
      for (const fact of hub.all('routineFact').filter(fact => fact.routineId === current.id && fact.scopeHash === routineScopeFingerprint(current)).slice(-60).reverse()) {
        if (knownLength + fact.key.length > 3500) break;
        knownKeys.push(fact.key); knownLength += fact.key.length;
      }
      const prompt = `这是已获用户授权的后台巡查，不是新的用户消息。\n事项：${current.title}\n用户指令：${current.instruction}\n资料范围：${JSON.stringify(routineScopeView(hub, current).scope)}\n本期计划时间：${new Date(scheduledAt).toISOString()}（${current.schedule.timezone}）\n实际检查时间：${new Date(hub.now()).toISOString()}\nTrigger：${current.trigger.condition}\n回报方式：${current.trigger.mode === 'changed' ? '仅条件成立且有尚未回报的新事实时保存结果' : '条件成立时保存本期结果'}。\n最近已回报事实key：${JSON.stringify(knownKeys)}\n先读取已授权来源，完成后必须使用 xiaoman_routines result 提交 outcome、matched、summary、facts、checks。检查成功用outcome:checked；checks列出本轮实际读取的来源URL或明确来源名及observedAt毫秒时间，未读不能编造。facts.key 使用来源事项或版本的稳定标识，不得附加本次时间来绕过去重。来源失败或未读完时用outcome:blocked、matched:false，并通过 xiaoman_report 报告 blocked/partial，不得声称没有变化。后台只读，不修改手账规则或业务数据、不外发；由宿主保存结果。`;
      const submitted = hub.submitRoutine({ routine: current, occurrenceId, scheduledAt, prompt });
      const row = hub.put('routineRun', { id: occurrenceId, routineId: current.id, version: current.version, runId: submitted.run.id, scheduledAt, manual, status: 'queued', createdAt: hub.now() });
      hub.put('routine', { ...current, lastRunId: row.id, error: null, ...(!manual && { lastScheduledAt: scheduledAt }) });
      return row;
    });
  }
  function tickSync() {
    hub.transaction(() => hub.expire());
    for (const occurrence of hub.all('routineRun').filter(row => !row.reconciledAt)) reconcile(occurrence.runId);
    for (let routine of hub.all('routine')) {
      if (!routine.enabled || routine.endedAt) continue;
      if (routine.endsAt && routine.endsAt <= hub.now()) {
        hub.transaction(() => {
          const current = hub.get('routine', routine.id);
          if (!current?.endedAt && current?.enabled && current.endsAt && current.endsAt <= hub.now()) {
            hub.put('routine', { ...current, enabled: false, endedAt: current.endsAt, endReason: 'expired', version: current.version + 1, updatedAt: hub.now() });
            for (const job of hub.all('run').filter(job => job.routine?.id === current.id && ACTIVE.has(job.status))) { hub.cancelRun(job); reconcile(job.id); }
          }
        });
        continue;
      }
      try {
        assertRoutineScopeCurrent(hub, routine);
        routine = link(routine);
        const item = journalItem(routine);
        if (!item || ['done', 'cancelled'].includes(item.status)) throw failure('JOURNAL_CLOSED');
        const scheduledAt = routineTimes(routine.schedule, hub.now()).previous;
        if (scheduledAt === null || scheduledAt < routine.activatedAt || scheduledAt <= (routine.lastScheduledAt || 0)) continue;
        enqueue(routine, scheduledAt, hash([routine.id, routine.version, scheduledAt]));
      } catch (error) {
        if (error.code === 'ROUTINE_BUSY') continue;
        for (const job of hub.all('run').filter(job => job.routine?.id === routine.id && ACTIVE.has(job.status))) { hub.cancelRun(job); reconcile(job.id); }
        hub.transaction(() => { const current = hub.get('routine', routine.id); if (current?.version === routine.version) hub.put('routine', { ...current, error: error.code || 'ROUTINE_UNAVAILABLE' }); });
      }
    }
    return snapshot();
  }
  function performAction(input, { run, requestId } = {}) {
    if (!input || typeof input !== 'object') throw failure('INVALID_INPUT');
    if (run) {
      const current = hub.get('run', run.id);
      if (!current || current.lease !== run.lease || current.endpointId !== run.endpointId || !['running', 'waiting_approval'].includes(current.status)) throw failure('FORBIDDEN');
      if (run.routine) {
        const assigned = hub.get('routine', run.routine.id);
        if (!assigned?.enabled || assigned.endedAt || assigned.endsAt && assigned.endsAt <= hub.now() || assigned.version !== run.routine.version) throw failure('ROUTINE_SUPERSEDED');
        assertRoutineScopeCurrent(hub, assigned);
      }
    }
    if (['verify', 'result'].includes(input.operation)) {
      if (!run?.routine || !['running', 'waiting_approval'].includes(hub.get('run', run.id)?.status)) throw failure('FORBIDDEN');
      const current = hub.get('routine', run.routine.id);
      if (!current?.enabled || current.endedAt || current.endsAt && current.endsAt <= hub.now() || current.version !== run.routine.version) throw failure('ROUTINE_SUPERSEDED');
      assertRoutineScopeCurrent(hub, current);
      const result = validateResult(input, run, hub.now());
      if (result.matched && current.trigger.mode === 'changed' && !result.facts.length) throw failure('INVALID_ROUTINE_RESULT');
      if (input.operation === 'verify') {
        const verification = verifiedSources(hub, run.id, result.checks);
        return { accepted: result.outcome === 'blocked' || !verification.error, error: verification.error, gaps: verification.gaps || [], checks: verification.checks,
          next: verification.error ? '补读列出的来源后重新提交；仍无法完整读取则提交 outcome:blocked、matched:false，明确缺口。不要把部分读取说成无变化或已完整核实。' : '读取回执已核实；最终发布仍会再次核对授权与结果。' };
      }
      const latest = hub.get('run', run.id);
      if (latest.routineResult && hash(latest.routineResult) !== hash(result)) throw failure('CONFLICT');
      hub.put('run', { ...latest, routineResult: result });
      return { accepted: true, routineId: current.id, occurrenceId: run.routine.occurrenceId, published: false };
    }
    if (!exact(input, ['operation', 'requestId', 'id', 'version', 'values'])) throw failure('INVALID_INPUT');
    if (input.operation === 'list') {
      const data = snapshot();
      if (run?.routine) { data.routines = data.routines.filter(row => row.id === run.routine.id).map(backgroundView); data.runs = []; data.sourcesAvailable = []; }
      return { ...data, ...(run && { currentJournalItemId: run.journalItemId || null, currentRoutineId: run.routine?.id || hub.all('routine').find(row => row.journalItemId === run.journalItemId)?.id || null }) };
    }
    if (input.operation === 'get') {
      if (run?.routine && input.id !== run.routine.id) throw failure('FORBIDDEN');
      const routine = hub.get('routine', text(input.id, 128)); if (!routine) throw failure('ITEM_NOT_FOUND');
      return { now: hub.now(), routine: run?.routine ? backgroundView(view(routine)) : view(routine), runs: run?.routine ? [] : hub.all('routineRun').filter(row => row.routineId === routine.id).slice(-30).reverse() };
    }
    if (run?.routine) throw failure('FORBIDDEN');
    if (!['create', 'update', 'pause', 'resume', 'end', 'authorize_scope', 'run_now'].includes(input.operation)) throw failure('INVALID_OPERATION');
    // A new journal-only routine may spell out the same least-privilege default.
    // Agents still cannot select an external channel or alter an existing one.
    const quietCreation = input.operation === 'create' && exact(input.values?.notification, ['channelId']) && input.values.notification.channelId === null;
    if (run && (input.operation === 'authorize_scope' || Object.hasOwn(input.values || {}, 'notification') && !quietCreation)) throw failure('FORBIDDEN');
    const key = 'routine-mutation:' + text(requestId || input.requestId, 256), fingerprint = hash({ ...input, requestId: undefined });
    const previous = hub.get('routineMutation', key);
    if (previous && previous.fingerprint !== fingerprint) throw failure('CONFLICT');
    if (previous?.result) return previous.result;
    if (input.operation === 'create') {
      const values = validateValues(input.values, undefined, hub);
      let routine = hub.transaction(() => {
        const old = hub.get('routineMutation', key);
        if (old) { if (old.fingerprint !== fingerprint) throw failure('CONFLICT'); return hub.get('routine', old.routineId); }
        const selectedBotId = values.botId || run?.botId;
        if (selectedBotId) { values.botId = selectedBotId; values.endpointId = resolveBot(hub, selectedBotId).endpoint.id; }
        const endpoint = hub.resolveEndpoint(values.endpointId || run?.endpointId || hubConfig(hub.root).roles.conversation || hub.all('endpoint').find(row => row.active)?.id);
        if (run?.journalItemId && hub.all('routine').some(row => row.journalItemId === run.journalItemId)) throw failure('ROUTINE_ALREADY_EXISTS');
        const item = run?.journalItemId && journal.store.snapshot(LOCAL).items.find(row => row.id === run.journalItemId && row.conversationId === run.conversationId);
        if (run?.journalItemId && (!item || ['done', 'cancelled'].includes(item.status))) throw failure('JOURNAL_CLOSED');
        const conversation = item ? hub.conversation(run.conversationId) : hub.newConversation({ title: values.title, endpointId: endpoint.id });
        if (conversation.ownerId !== 'owner') throw failure('FORBIDDEN');
        const created = hub.put('routine', { id: randomUUID(), ...values, endpointId: endpoint.id, enabled: values.enabled !== false, version: 1, conversationId: conversation.id, journalItemId: item?.id || null, createdAt: hub.now(), updatedAt: hub.now(), activatedAt: hub.now(), error: null });
        hub.put('routineMutation', { id: key, fingerprint, routineId: created.id });
        return created;
      });
      // The durable conversation precedes the other database's idempotent link.
      // A crash between these writes resumes the same item, never creates two.
      routine = link(routine);
      return hub.transaction(() => {
        const result = { saved: true, routine: view(hub.get('routine', routine.id)) };
        hub.put('routineMutation', { id: key, fingerprint, routineId: routine.id, result }); return result;
      });
    }
    return hub.transaction(() => {
      const old = hub.get('routineMutation', key); if (old && old.fingerprint !== fingerprint) throw failure('CONFLICT'); if (old?.result) return old.result;
      let routine = hub.get('routine', text(input.id, 128)); if (!routine) throw failure('ITEM_NOT_FOUND');
      if (input.version !== routine.version) throw failure('VERSION_CONFLICT');
      if (routine.endedAt || routine.endsAt && routine.endsAt <= hub.now()) throw failure('ROUTINE_ENDED');
      let occurrence;
      if (input.operation === 'run_now') occurrence = enqueue(routine, hub.now(), hash([routine.id, routine.version, key]), true);
      else {
        const values = input.operation === 'update' ? validateValues(input.values, routine, hub) : input.operation === 'authorize_scope' ? bindRoutineScope(hub, routine.scope) : { enabled: input.operation === 'resume', ...(input.operation === 'end' && { endedAt: hub.now(), endReason: 'user' }) };
        if (input.operation === 'resume') assertRoutineScopeCurrent(hub, routine);
        if (values.botId && (input.operation === 'update' || input.operation === 'resume')) values.endpointId = resolveBot(hub, values.botId).endpoint.id;
        if (values.endpointId) hub.resolveEndpoint(values.endpointId);
        routine = hub.put('routine', { ...routine, ...values, version: routine.version + 1, updatedAt: hub.now(), activatedAt: hub.now(), error: null });
        for (const job of hub.all('run').filter(job => job.routine?.id === routine.id && ACTIVE.has(job.status))) { hub.cancelRun(job); reconcile(job.id); }
      }
      const result = { saved: true, routine: view(hub.get('routine', routine.id)), ...(occurrence && { run: occurrence }) };
      hub.put('routineMutation', { id: key, fingerprint, routineId: routine.id, result }); return result;
    });
  }
  async function action(input, context) {
    await refreshSettings();
    // An omitted zone means the owner's configured zone, never the cloud host.
    if (input?.operation === 'create' && input.values?.schedule && input.values.schedule.timezone === undefined) input = { ...input, values: { ...input.values, schedule: { ...input.values.schedule, timezone } } };
    context?.beforeMutation?.();
    return performAction(input, context);
  }
  function tick() {
    if (!ticking) ticking = (async () => { await refreshSettings(); return tickSync(); })().finally(() => { ticking = null; });
    return ticking;
  }
  hub.routineSnapshot = snapshot;
  return { action, tick, snapshot, reconcile };
}

export async function routineTool({ hub, routines, token, input }) {
  const endpoint = hub.authenticate(token), run = hub.get('run', input.runId);
  if (!run || run.endpointId !== endpoint.id || run.lease !== input.lease || !['running', 'waiting_approval'].includes(run.status) || run.firstTaskId) throw failure('FORBIDDEN');
  return routines.action(input.arguments, { run, requestId: 'agent:' + run.id + ':' + text(input.callId, 200) });
}
