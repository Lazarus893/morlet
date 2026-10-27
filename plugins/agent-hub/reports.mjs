import { createHash } from 'node:crypto';

/** A report describes the task outcome; the companion alone owns execution state. */
export const REPORT_TOOL = {
  type: 'function', name: 'xiaoman_report',
  description: 'Report progress and the outcome of the current Xiaoman task to the Hub. Use before your final reply for concrete work, and when blocked. Report only work actually done; completed means the user request is fully satisfied. This does not finish the execution or mark shared to-dos done. summary and outcome replace the previous report; omitted title/artifacts are preserved, artifacts: [] clears them. Artifact links must be HTTP(S); local paths remain on the executing computer and are not uploaded. When you have actually resolved a previously blocked run, include its exact ID in resolvesRunIds only after saving newer versions of every journal item linked to that run. Do not claim unrelated work resolves it. Never include credentials.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200, description: 'A concise subject for this task, normally 6–18 Chinese characters or a short noun phrase. Summarize the goal, not the full user sentence or completion status. Include on the first progress report; it also names an automatically titled notebook chapter.' },
      summary: { type: 'string', minLength: 1, maxLength: 1200 },
      outcome: { type: 'string', enum: ['in_progress', 'completed', 'partial', 'blocked'] },
      resolvesRunIds: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
      artifacts: { type: 'array', maxItems: 12, items: {
        type: 'object', additionalProperties: false,
        properties: { label: { type: 'string', minLength: 1, maxLength: 160 }, url: { type: 'string', maxLength: 2048 }, path: { type: 'string', maxLength: 1024 } },
        required: ['label'],
      } },
    }, required: ['summary', 'outcome'],
  },
};

const invalid = () => { throw Object.assign(new Error('INVALID_REPORT'), { code: 'INVALID_REPORT' }); };
const string = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value.trim() : invalid();
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
};

export function normalizeReport(input, previous, now) {
  object(input, ['title', 'summary', 'outcome', 'artifacts', 'resolvesRunIds']);
  const report = { ...previous, summary: string(input.summary, 1200), outcome: input.outcome, updatedAt: now };
  if (!REPORT_TOOL.inputSchema.properties.outcome.enum.includes(input.outcome)) invalid();
  delete report.resolvesRunIds;
  if (input.resolvesRunIds !== undefined) {
    if (!Array.isArray(input.resolvesRunIds) || input.resolvesRunIds.length > 8 || new Set(input.resolvesRunIds).size !== input.resolvesRunIds.length) invalid();
    report.resolvesRunIds = input.resolvesRunIds.map(value => string(value, 128));
  }
  if (input.title !== undefined) report.title = string(input.title, 200);
  if (input.artifacts !== undefined) {
    if (!Array.isArray(input.artifacts) || input.artifacts.length > 12) invalid();
    const seen = new Set();
    report.artifacts = input.artifacts.map(item => {
      object(item, ['label', 'url', 'path']);
      if ((item.url !== undefined) === (item.path !== undefined)) invalid();
      const artifact = { label: string(item.label, 160) };
      if (item.url !== undefined) {
        const raw = string(item.url, 2048);
        let url; try { url = new URL(raw); } catch { invalid(); }
        if (!/^https?:\/\//i.test(raw) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\s\\]/.test(raw)) invalid();
        artifact.url = url.href;
      } else {
        artifact.path = string(item.path, 1024);
        if (!/^(?:\/|[a-zA-Z]:[\\/])/.test(artifact.path) || /[\r\n\t]/.test(artifact.path)) invalid();
      }
      const key = artifact.url || artifact.path;
      if (seen.has(key)) invalid(); seen.add(key);
      return artifact;
    });
  }
  report.artifacts ||= [];
  return report;
}

// This is an explicitly labelled excerpt, never an inferred success claim.
export const excerpt = (value, max = 240) => {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? compact.slice(0, max - 1) + '…' : compact;
};

// Coverage is an observation of this execution's source receipts, not a model
// assessment of relevance. Persist it with the reply so retry/restart cannot
// silently replace an incomplete read with an unqualified answer.
export function sourceCoverage(runId, requests) {
  const searches = new Map(), bodies = new Map(), calendars = new Map();
  let failed = 0, pending = 0;
  for (const row of requests.filter(row => row.runId === runId).sort((a, b) => (a.finishedAt || a.createdAt) - (b.finishedAt || b.createdAt))) {
    const args = row.arguments || {}, result = row.result;
    if (!['mail_search', 'mail_read', 'calendar_events'].includes(args.operation)) continue;
    if (row.status === 'failed') { failed++; continue; }
    if (row.status !== 'completed') { pending++; continue; }
    if (args.operation === 'mail_search' && Array.isArray(result?.messages)) searches.set(args.query, result);
    if (args.operation === 'mail_read' && result?.messageId === args.messageId && typeof result.text === 'string') bodies.set(args.messageId, result.complete === true && result.truncated === false ? 'complete' : 'partial');
    if (args.operation === 'calendar_events' && result?.calendarId === 'primary' && result.window && Array.isArray(result.events)) calendars.set(JSON.stringify(result.window), result);
  }
  const lines = [];
  for (const [query, result] of searches) {
    const ids = [...new Set(result.messages.map(message => message.id))];
    const complete = ids.filter(id => bodies.get(id) === 'complete').length, partial = ids.filter(id => bodies.get(id) === 'partial').length;
    lines.push(`邮件（${query}）：列出${ids.length}封（目录${result.truncated === false ? '已列全' : '未列全'}），完整正文${complete}封、部分正文${partial}封，${ids.length - complete}封尚未完整读取。`);
  }
  if (searches.size) {
    const listed = new Set([...searches.values()].flatMap(result => result.messages.map(message => message.id)));
    const outside = [...bodies].filter(([id]) => !listed.has(id)).map(([, state]) => state);
    if (outside.length) lines.push(`另读取未包含在上述列表的正文：完整${outside.filter(state => state === 'complete').length}封、部分${outside.filter(state => state === 'partial').length}封。`);
  }
  if (!searches.size && bodies.size) lines.push(`邮件：完整正文${[...bodies.values()].filter(value => value === 'complete').length}封、部分正文${[...bodies.values()].filter(value => value === 'partial').length}封；本轮未重新查询目录。`);
  if (searches.size || bodies.size) lines.push('上述统计不包含附件和正文链接。');
  for (const result of calendars.values()) lines.push(`主日历（primary）：${result.window.from} 至 ${result.window.to}，返回${result.events.length}项（窗口结果${result.truncated === false ? '已列全' : '未列全'}）。`);
  if (failed || pending) lines.push(`另有${failed}次读取未成功、${pending}次尚未完成，不能据此判断没有内容。`);
  return lines.length ? `本轮读取范围：\n${lines.join('\n')}` : '';
}

// A closed issue is separate from an execution's immutable historical outcome.
export const runIssueFingerprint = run => createHash('sha256').update(JSON.stringify([run.id, run.status, run.finishedAt ?? null, run.error ?? null, run.report ?? null])).digest('hex');
export const hasTerminalIssue = run => run.status === 'failed' || run.status === 'completed' && ['blocked', 'partial', 'in_progress'].includes(run.report?.outcome);

export function journalEvidence(effects) {
  const result = new Map();
  for (const effect of effects) {
    const item = effect.result?.item;
    if (effect.state !== 'done' || effect.result?.saved !== true || typeof item?.id !== 'string' || !effect.id.startsWith('journal:')) continue;
    const runId = effect.id.slice(8).split(':')[0];
    if (!result.has(runId)) result.set(runId, new Map());
    const items = result.get(runId), old = items.get(item.id);
    const committed = effect.result.applyReceipt;
    const candidateVersion = committed ? committed.itemId === item.id ? committed.itemVersion : null : item.version;
    const version = Number.isSafeInteger(candidateVersion) && candidateVersion > 0 ? candidateVersion : null;
    if (!old || version !== null && (old.version === null || old.version < version)) items.set(item.id, { id: item.id, version, effectId: effect.id });
  }
  return result;
}

export function runIssue(run, runs, evidence, resolutions) {
  if (!hasTerminalIssue(run)) return null;
  const fingerprint = runIssueFingerprint(run);
  const accepted = resolutions.find(r => r.runId === run.id && r.fingerprint === fingerprint);
  if (accepted) return { state: 'resolved', fingerprint, resolution: accepted };
  const original = [...(evidence.get(run.id)?.values() || [])];
  // Only a successful, explicitly linked continuation with host-owned write
  // receipts can close an earlier block. Similar text and shared conversations
  // are deliberately insufficient, as is a later edit to the same item alone.
  if (run.status === 'completed' && run.report?.outcome === 'blocked' && original.length && original.every(item => Number.isSafeInteger(item.version) && item.version > 0)) {
    const next = runs.filter(r => r.id !== run.id && r.conversationId === run.conversationId && r.createdAt >= run.finishedAt && r.status === 'completed' && r.report?.outcome === 'completed' && r.report.resolvesRunIds?.includes(run.id)).sort((a, b) => a.finishedAt - b.finishedAt).find(r => original.every(item => (evidence.get(r.id)?.get(item.id)?.version || 0) > item.version));
    if (next) return { state: 'resolved', fingerprint, resolution: { kind: 'continued', runId: run.id, byRunId: next.id, at: next.finishedAt, items: original.map(item => ({ itemId: item.id, fromVersion: item.version, ...evidence.get(next.id).get(item.id) })) } };
  }
  return { state: 'open', fingerprint, resolution: null };
}

export function runProgress(run, sourceRequests, now) {
  if (!['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling'].includes(run.status)) return null;
  const startedAt = run.startedAt || run.createdAt;
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  let label = { queued: '交代已保存，等待处理助手', running: '处理助手正在执行', waiting_approval: '等待你决定，批准后才继续该动作', uncertain: '执行心跳中断，结果待核对', cancelling: '已请求停止，等待执行端确认' }[run.status];
  let stage = run.status, observedAt = run.startedAt || run.createdAt;
  if (run.status === 'running') {
    const sources = sourceRequests.filter(r => r.runId === run.id).sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));
    const active = sources.find(r => ['queued', 'running'].includes(r.status));
    if (active) { stage = 'reading_sources'; label = active.status === 'queued' ? '读取请求已交给本地助手，等待取回资料' : '本地助手正在读取已授权资料'; observedAt = active.heartbeat || active.createdAt; }
    else if (run.report?.outcome === 'in_progress') { stage = 'reported'; label = run.report.summary; observedAt = run.report.updatedAt; }
    else if (sources[0]?.status === 'completed') { stage = 'sources_returned'; label = '资料已返回，处理助手继续整理'; observedAt = sources[0].finishedAt || sources[0].createdAt; }
    else if (sources[0]?.status === 'failed') { stage = 'source_failed'; label = '一次资料读取未成功，等待处理助手说明'; observedAt = sources[0].finishedAt || sources[0].createdAt; }
    else if (run.nativeActivity) {
      stage = 'native_activity'; observedAt = run.nativeActivity.observedAt;
      label = run.nativeActivity.phase === 'completed' ? '执行步骤已返回，继续整理结果' : ({ commandExecution: '正在执行命令', fileChange: '正在处理文件', mcpToolCall: '正在调用已连接工具', dynamicToolCall: '正在处理小满任务', webSearch: '正在检索资料', agentMessage: '正在整理回复' })[run.nativeActivity.kind] || label;
    }
  }
  return { stage, label, elapsedSeconds, observedAt, path: '消息与任务 → 任务追踪；微信可发“进度”' };
}
