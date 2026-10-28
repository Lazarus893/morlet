import { createHash } from 'node:crypto';
import { endpointReadiness } from './readiness.mjs';

export const routeId = source => source?.channel && source.channel !== 'web' ? createHash('sha256').update(JSON.stringify([source.channel, source.account || '', source.peer || ''])).digest('hex') : null;
export function messageTimes(source, receivedAt) {
  const occurredAt = Number.isSafeInteger(source?.occurredAt) && source.occurredAt > 0 && source.occurredAt <= receivedAt + 60000 ? source.occurredAt : null;
  return { receivedAt, occurredAt, effectiveAt: occurredAt ?? receivedAt };
}
export function projectMessage(hub, row, items = []) {
  const { source = { channel: 'web' }, ...message } = row;
  const run = row.runId && hub.get('run', row.runId), rootRunId = run && (run.rootRunId || run.id);
  const receivedAt = row.receivedAt ?? row.createdAt, occurredAt = row.occurredAt ?? null;
  const appendSeq = row.appendSeq ?? Number(hub.db.prepare("SELECT rowid FROM records WHERE kind='message' AND id=?").get(row.id)?.rowid || 0);
  const delivery = hub.get('delivery', row.id);
  return { ...message, resolvedConversationId: hub.resolveConversationId(row.conversationId), appendSeq, receivedAt, occurredAt, effectiveAt: row.effectiveAt ?? occurredAt ?? receivedAt,
    channel: source.channel, sourceRef: { conversationId: row.conversationId, messageId: row.id },
    origin: { channel: source.channel, routeId: routeId(source), receivedAt, occurredAt, ...(source.sourceMessageId && { sourceMessageId: source.sourceMessageId }) },
    ...(delivery && { delivery: { state: delivery.state, channel: delivery.source.channel } }),
    ...(rootRunId && { rootRunId, journalItemIds: items }) };
}
export const chronological = (a, b) => a.effectiveAt - b.effectiveAt || a.appendSeq - b.appendSeq;
export function rootTasks(runs) {
  return runs.filter(run => !run.rootRunId && !run.routine).map(root => {
    const chain = runs.filter(run => (run.rootRunId || run.id) === root.id), active = chain.find(run => ['uncertain', 'waiting_approval', 'cancelling'].includes(run.status)) || chain.find(run => run.status === 'running') || chain.find(run => run.status === 'queued');
    const problem = chain.findLast(run => run.issue && run.issue.state !== 'resolved');
    const incomplete = chain.findLast(run => run.issue?.state !== 'resolved' && ['partial', 'blocked'].includes(run.report?.outcome));
    const state = active?.status || (problem || incomplete ? incomplete?.report.outcome || (root.groupPlanState === 'partial' ? 'partial' : 'failed') : chain.some(run => run.status === 'failed' && run.issue?.state !== 'resolved') ? 'failed' : chain.some(run => run.issue?.state === 'resolved') ? 'resolved' : chain.some(run => run.status === 'cancelled') ? 'cancelled' : 'completed');
    const ids = root.groupPlan?.participantBotIds || [...new Set(chain.map(run => run.botId).filter(Boolean))];
    return { id: root.id, rootRunId: root.id, messageId: root.messageId, conversationId: root.conversationId, resolvedConversationId: root.resolvedConversationId || root.conversationId, botId: root.botId, state,
      runIds: chain.map(run => run.id), participantSlots: ids.map(botId => { const run = chain.findLast(run => run.botId === botId && (!root.groupPlan || run.botPhase === 'participant')); return { botId, runId: run?.id || null, state: run?.status || 'queued', outcome: run?.report?.outcome || null }; }),
      issue: problem?.issue || (incomplete ? { state: 'open', reason: incomplete.report.summary, outcome: incomplete.report.outcome, runId: incomplete.id } : null),
      createdAt: root.createdAt, startedAt: root.startedAt || null, finishedAt: active ? null : Math.max(...chain.map(run => run.finishedAt || 0)) || null,
      journalItemIds: [...new Set(chain.flatMap(run => run.journalItemIds || []))] };
  });
}
export function botExecution(hub, bot) {
  const endpoint = bot.resolvedEndpointId && hub.get('endpoint', bot.resolvedEndpointId);
  const readiness = endpoint ? endpointReadiness(hub, endpoint) : null;
  const runs = hub.all('run').filter(run => run.botId === bot.id);
  return { endpointId: endpoint?.id || null, label: endpoint?.label || null, provider: endpoint?.provider || null,
    connected: Boolean(endpoint?.active), online: readiness?.online || false, canExecute: readiness?.canExecute || false,
    authentication: readiness?.authentication || 'unknown', reasons: readiness?.reasons || ['尚未绑定执行助手'],
    busy: runs.filter(run => ['running', 'waiting_approval', 'uncertain', 'cancelling'].includes(run.status)).length,
    queued: runs.filter(run => run.status === 'queued').length };
}
