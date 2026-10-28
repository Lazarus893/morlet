import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const fail = code => Object.assign(new Error(code), { code });
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
};
export const actionFingerprint = (tool, parameters) => createHash('sha256').update(canonical({ tool, parameters })).digest('hex');

export function actionPreview(tool, parameters, { title } = {}) {
  if (tool === 'xiaoman_reminders' && parameters.operation === 'cancel') return {
    kind: 'delete_reminder', title: '删这条提醒', preview: `取消「${title || parameters.taskId}」的后续提醒。保留历史记录，已发出的消息无法撤回。`, approvable: true };
  if (tool === 'xiaoman_tasks' && parameters.operation === 'cancel') return {
    kind: 'cancel_task', title: '取消这项待办', preview: `将「${title || parameters.taskId}」标记为取消，保留历史，可重新开启。`, approvable: true };
  if (tool === 'xiaoman_journal' && parameters.operation === 'cancel') return {
    kind: 'cancel_journal_item', title: '取消这件生活安排', preview: `将「${title || parameters.itemId}」标记为取消，保留历史与记录。不会撤销已经在外部完成的订单或预约。`, approvable: true };
  // Unclassified shell commands are NOT a substitute for typed life actions.
  // A model-written friendly title cannot authorize a different native command.
  // Native file-change callbacks do not provide a portable, complete diff.
  // Keep them closed until a typed editor can bind a reviewable diff to execution.
  return { kind: 'unsupported', title: '这项操作还不能直接办理', preview: '还没有可核对的生活动作预览。可以接受这个限制，继续只读整理或留下草稿。', approvable: false };
}

export function approvalText(a) {
  return `${a.action.title}\n${a.action.preview}\n${a.action.approvable ? `回复“批准 ${a.id}”或“拒绝 ${a.id}”；“延后 ${a.id}”保留此决定。` : `回复“接受限制 ${a.id}”，继续处理其余部分。`}\n本次参数已固定；修改后需重新确认。`;
}

export function requestAction(hub, { run, tool, parameters, callId, title, native = false }) {
  if (!run || !['running', 'waiting_approval'].includes(run.status)) throw fail('FORBIDDEN');
  const fingerprint = actionFingerprint(tool, parameters);
  const id = createHash('sha256').update(run.id + ':' + callId + ':' + fingerprint).digest('hex').slice(0, 12);
  return hub.transaction(() => {
    const old = hub.get('approval', id);
    if (old) return old;
    const action = { ...actionPreview(tool, parameters, { title }), fingerprint, parameters };
    const a = hub.put('approval', { id, runId: run.id, conversationId: run.conversationId, state: 'pending', expiresAt: hub.now() + 240000,
      toolName: tool, reason: canonical(parameters), action, callId, native, createdAt: hub.now() });
    hub.put('run', { ...hub.get('run', run.id), status: 'waiting_approval' });
    hub.reply(run.conversationId, approvalText(a), run.source, run.id);
    return a;
  });
}

export function requireAction(hub, { run, tool, parameters, callId, approvalId, title }) {
  const a = requestAction(hub, { run, tool, parameters, callId, title });
  if (!approvalId) return { approvalRequired: true, approvalId: a.id, action: { title: a.action.title, preview: a.action.preview }, state: a.state };
  if (a.id !== approvalId || a.action.fingerprint !== actionFingerprint(tool, parameters) || !a.action.approvable || a.state !== 'accepted' || a.expiresAt <= hub.now() || a.consumedAt) throw fail('APPROVAL_REQUIRED');
  hub.put('approval', { ...a, consumedAt: hub.now() });
  return null;
}

// DSH's native pipeline invokes this before dispatch, including resumed sessions.
// Only known read tools and the separately guarded Hub surface may pass freely.
export function nativeActionPolicy(name, args, routine) {
  if (routine && !name.startsWith('xiaoman_')) {
    if (!['web_search', 'web_fetch'].includes(name) || routine.scope?.publicWeb === false) return 'blocked';
  }
  if (['xiaoman_tasks', 'xiaoman_reminders', 'xiaoman_report', 'xiaoman_status', 'xiaoman_journal', 'xiaoman_first_task', 'xiaoman_sources', 'xiaoman_routines', 'xiaoman_bots'].includes(name)) return 'managed';
  if (name === 'web_search') return validPublicSearch(args) ? 'read' : 'blocked';
  if (name === 'web_fetch') return validPublicFetch(args) ? 'read' : 'blocked';
  if (['read_file', 'list_directory', 'search_files', 'grep', 'glob', 'read', 'Read', 'Glob', 'Grep'].includes(name)) return 'read';
  return 'blocked';
}

const exactArgument = (args, key) => args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 1 && Object.hasOwn(args, key);
function validPublicSearch(args) {
  return exactArgument(args, 'queries') && Array.isArray(args.queries) && args.queries.length > 0 && args.queries.length <= 8
    && args.queries.every(query => typeof query === 'string' && query.trim().length > 0 && query.length <= 500 && !/[\u0000-\u001f\u007f]/.test(query));
}
function validPublicFetch(args) {
  if (!exactArgument(args, 'url') || typeof args.url !== 'string' || args.url.length > 2048 || /[\s\\]/.test(args.url)) return false;
  try {
    const url = new URL(args.url), host = url.hostname;
    if (url.href.length > 2048) return false;
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || isIP(host.replace(/^\[|\]$/g, ''))) return false;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || /\.(?:localhost|local|internal|intranet|lan|home|test|invalid|example)$/.test(host)) return false;
    const path = decodeURIComponent(url.pathname);
    if (/(?:^|\/)(?:logout|signout|unsubscribe|delete|remove|cancel|approve|authorize|revoke|checkout|pay|send)(?:\/|\.|$)/i.test(path)) return false;
    for (const [key, value] of url.searchParams) {
      if (/(?:token|secret|password|credential|authorization|api[-_]?key)/i.test(key)) return false;
      if (/^(?:action|operation|cmd|command|method)$/i.test(key) && !/^(?:search|read|view|list|get)$/i.test(value)) return false;
    }
    // The configured dsh-web-fetch-http backend owns public DNS resolution,
    // address pinning, redirect validation, anonymous requests and size limits.
    return true;
  } catch { return false; }
}

// A scheduled inspection carries no fresh consent to mutate the owner's plans.
// Enforce this at both transport boundaries as well as in the companion relay.
export function assertRoutineToolAccess(run, name, args) {
  if (!run?.routine) return;
  const readOnly = ['xiaoman_sources', 'xiaoman_status', 'xiaoman_report'].includes(name)
    || name === 'xiaoman_journal' && (args?.operation === 'list' || args?.operation === 'get' && args.itemId === run.journalItemId)
    || name === 'xiaoman_routines' && (['list', 'verify', 'result'].includes(args?.operation) || args?.operation === 'get' && args.id === run.routine.id);
  if (!readOnly) throw fail('FORBIDDEN');
}
