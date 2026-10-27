const referenceKinds = new Set(['documents', 'memory', 'reflection', 'delivery']);

export function workpageStage(item, { now = Date.now() } = {}) {
  const data = item.taskData || {};
  if (item.status === 'cancelled') return { stage: 'cancelled', nextStep: '这件事已取消，原记录保留。', primaryKind: 'memory' };
  if (item.status === 'done') return { stage: 'done', nextStep: data.reflection?.rating ? '评价已记下，随时回来回顾。' : '事情已完成，可以留下一点感受。', primaryKind: 'reflection' };
  if (item.date && Date.parse(item.date) <= now) return { stage: 'past_date', nextStep: '原定日期已过，记录保留；如需继续，请先核对新的安排。', primaryKind: null };
  const question = data.waiting?.requests?.find(request => ['unknown', 'waiting'].includes(request.status));
  if (question) return { stage: 'waiting', nextStep: `等待${question.person || '对方'}的回音：${question.request}`, primaryKind: 'waiting' };
  if (item.candidates?.length && !item.candidates.some(candidate => candidate.selected)) return { stage: 'deciding', nextStep: item.candidates.some(candidate => fitsCandidate(item, candidate.id)) ? '比较候选，选一个合适的方案。' : '先补充候选信息，核对已记录的条件后再选择。', primaryKind: 'decision' };
  const shopping = data.shopping?.entries?.find(entry => !entry.atHome && !entry.bought);
  if (shopping) return { stage: 'shopping', nextStep: `先备齐${shopping.name}，已买的可以勾上。`, primaryKind: 'shopping' };
  const step = item.steps?.find(step => !step.done);
  if (step) return { stage: 'preparing', nextStep: step.label, primaryKind: 'prep' };
  const cooking = data.meal?.instructions?.find(step => !step.done);
  if (cooking) return { stage: 'cooking', nextStep: cooking.label, primaryKind: 'meal' };
  return { stage: 'planned', nextStep: '按计划继续，进展会保存在这件事里。', primaryKind: null };
}

// Group only adjacent cards: global pinned/order preferences remain authoritative.
// Design chooses bounded roles; business phase is always derived from saved facts.
export function projectWorkpages(snapshot, context) {
  const items = new Map(snapshot.items.map(item => [item.id, item]));
  const pages = [];
  const primaryIds = new Map(snapshot.items.map(item => {
    const widgets = snapshot.layout.widgets.filter(widget => widget.itemId === item.id);
    // An explicit structure chooses the lead widget, without changing the
    // business stage or removing the other saved materials.
    const preferred = !['done', 'cancelled'].includes(item.status) && item.taskType && item.taskType !== 'auto'
      ? item.taskType : workpageStage(item, context).primaryKind;
    const match = widgets.find(widget => widget.kind === preferred || preferred === 'prep' && widget.kind === 'checklist' || preferred === 'decision' && widget.kind === 'comparison');
    return [item.id, (match || widgets.find(widget => widget.emphasis === 'primary') || widgets[0])?.id];
  }));
  for (const widget of snapshot.layout.widgets) {
    const item = items.get(widget.itemId);
    if (!item) continue;
    let page = pages.at(-1);
    if (!page || page.itemId !== item.id) {
      page = { itemId: item.id, ...workpageStage(item, context), sections: [] };
      pages.push(page);
    }
    const primary = primaryIds.get(item.id) === widget.id;
    const section = primary ? 'next' : widget.section === 'reference' || referenceKinds.has(widget.kind) ? 'reference' : 'plan';
    const density = primary || widget.presentation === 'expanded' ? 'comfortable' : 'compact';
    const last = page.sections.at(-1);
    if (last?.id === section && last.density === density) last.widgetIds.push(widget.id);
    else page.sections.push({ id: section, widgetIds: [widget.id], role: primary ? 'primary' : 'support', density });
  }
  return pages;
}
import { fitsCandidate } from './widgets.mjs';

