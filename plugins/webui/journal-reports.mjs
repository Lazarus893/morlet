// Reports are a read projection; setup receipts and older source bundles remain
// in the conversation ledger but never masquerade as a patrol's latest result.
export function journalReports(hub) {
  const reports = new Map();
  const patrolItems = new Set(hub.all('routine').map(row => row.journalItemId));
  const runs = hub.snapshot().runs, byId = new Map(runs.map(run => [run.id, run])), messages = hub.all('message');
  for (const original of runs) {
    const itemIds = [...new Set([...(original.journalItemId ? [original.journalItemId] : []), ...(original.journalItemIds || [])])];
    // Tool effects prove provenance for every saved page, but a task-level
    // summary cannot be assigned to every page in a multi-page write.
    const reportItemId = original.journalItemBound === false && itemIds.length > 1 ? null : original.journalItemId || (itemIds.length === 1 ? itemIds[0] : null);
    for (const itemId of itemIds) {
      const run = { ...original, journalItemId: itemId };
      const root = byId.get(run.rootRunId || run.id), source = root && messages.find(message => message.id === root.messageId);
      const originSourceRef = source && { conversationId: source.conversationId, messageId: source.id };
      if (itemId !== reportItemId) {
        if (originSourceRef) reports.set(itemId, { ...reports.get(itemId), originSourceRef: reports.get(itemId)?.originSourceRef || originSourceRef });
        continue;
      }
      const reply = messages.findLast(message => message.runId === run.id && message.role === 'assistant' && message.createdAt >= (run.finishedAt || Infinity));
      const replySourceRef = reply && { conversationId: reply.conversationId, messageId: reply.id };
      const patrol = patrolItems.has(run.journalItemId);
      if ((patrol || run.routine) && !run.routinePublished) continue;
      const previous = reports.get(run.journalItemId), title = run.report?.title;
      const chapterTitle = previous?.chapterTitle || (title && Array.from(title).length <= 60 && !/[\r\n]/.test(title) ? title : null);
      const hasResult = !!run.report?.summary && (run.routinePublished || ['completed', 'partial'].includes(run.report.outcome));
      const current = (hasResult ? run.report.artifacts || [] : []).map(a => ({ ...a, endpointId: run.endpointId }));
      const artifacts = [...new Map([...(patrol ? [] : previous?.artifacts || []), ...current].map(a => [a.url || a.endpointId + ':' + a.path, a])).values()];
      const history = patrol && previous?.answer ? [...(previous.history || []), { runId: previous.run.id, answer: previous.answer, answerAt: previous.answerAt, artifacts: previous.artifacts }] : previous?.history || [];
      reports.set(run.journalItemId, { originSourceRef: previous?.originSourceRef || originSourceRef, sourceRef: hasResult ? replySourceRef : previous?.sourceRef, chapterTitle, artifacts, history, conversationId: run.conversationId, stage: run.status,
        isBusy: ['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling'].includes(run.status),
        answer: hasResult ? run.report.summary : previous?.answer || null,
        answerAt: hasResult ? run.report.updatedAt || run.finishedAt || null : previous?.answerAt || null,
        answerOutcome: hasResult ? run.report.outcome : previous?.answerOutcome || null,
        blocked: run.report?.outcome === 'blocked' ? run.report.summary : null,
        run, reason: run.error || null });
    }
  }
  return reports;
}
