// The first task uses already authorized, evidenced journal material.
// Personal content stays in the instance database, never in this template.
export const GUIDE_ITEM = {
  title: '和小满，跟进一件真实的事', kind: 'arrangement', taskType: 'decision',
  note: '从近期已经读过的材料里选一条，小满会整理与你的关系、待核对的问题和可做的下一步。',
  steps: [], candidates: [], taskData: {},
};

export function guideSources(db, state, scope, now, limit = 3) {
  if (scope.account !== 'local' || scope.userId !== 'owner' || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_content_entries'").get()) return [];
  const rows = db.prepare('SELECT data FROM journal_content_entries ORDER BY rowid DESC LIMIT 3000').all().map(row => JSON.parse(row.data));
  const usable = rows.filter(row => ['google-mail', 'github'].includes(row.source) && row.feedback !== 'not_interested' &&
    Number.isFinite(row.observedAt) && row.observedAt <= now && now - row.observedAt <= 14 * 86400000 &&
    row.summary?.trim() && row.relevance?.trim() && row.suggestion?.trim() && row.coverage?.trim() && row.evidence?.some(cite => cite.quote?.trim()) &&
    state.items.some(item => item.id === row.itemId && item.source.kind === 'automatic' && !['done', 'cancelled'].includes(item.status) && item.taskData?.collection?.entries.some(entry => entry.id === row.entryId))
  ).sort((a, b) => Number(a.exploration) - Number(b.exploration) || b.observedAt - a.observedAt);
  const picked = [], topics = new Set();
  for (const row of usable) {
    if (limit !== Infinity && topics.has(row.topic)) continue;
    picked.push(row); topics.add(row.topic); if (picked.length === limit) break;
  }
  return picked.map(({ id, itemId, entryId, source, title, hook, summary, relevance, suggestion, coverage, evidence, url, observedAt, correction }) =>
    ({ id, itemId, entryId, source, title, hook, summary, relevance, suggestion, coverage, evidence, url, observedAt, ...(correction ? { correction } : {}) }));
}

export function guideValues(sources) {
  return { ...GUIDE_ITEM, candidates: sources.map(row => ({ id: row.id, name: (row.hook || row.title).slice(0, 200),
    detail: row.relevance.slice(0, 2000), selected: false })) };
}

export function guideFollowupValues(source) {
  const evidence = source.evidence.map(cite => `来源摘录：${cite.quote}${cite.url ? '\n' + cite.url : ''}`).join('\n\n');
  return { title: `跟进：${source.hook || source.title}`.slice(0, 300), kind: 'arrangement', taskType: 'prep',
    note: `已读材料\n${source.summary}\n\n与你的关系\n${source.relevance}\n\n建议的下一步\n${source.suggestion}\n\n材料范围\n${source.coverage}\n读取于 ${new Date(source.observedAt).toISOString()}\n\n${evidence}`.slice(0, 10000),
    steps: [{ id: 'review', label: '查看小满的核对结果，确定这件事是否值得继续', done: false },
      { id: 'next', label: source.suggestion.slice(0, 500), done: false }],
    taskData: { prep: { phases: [{ id: 'follow', label: '把这件事往前推进', stepIds: ['review', 'next'] }] },
      collection: { entries: [{ id: source.id, title: source.title, note: source.coverage, ...(source.url ? { url: source.url } : {}) }] } },
  };
}
