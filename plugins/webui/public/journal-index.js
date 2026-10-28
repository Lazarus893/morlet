(() => {
  'use strict';
  const seriesId = item => item?.source?.kind === 'automatic' ? item.contentSeries?.id : null;
  const newestFirst = (a, b) => String(b.contentSeries?.day || '').localeCompare(String(a.contentSeries?.day || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.id.localeCompare(b.id);
  const isGuide = (item, guide) => item?.source?.kind === 'guide' || !!guide?.itemId && item?.id === guide.itemId;
  const referenceKinds = new Set(['collection', 'documents', 'memory', 'reflection']);
  function category(item, routines = []) {
    if (routines.some(routine => routine.journalItemId === item?.id)) return 'routines';
    if (item?.source?.kind === 'automatic' || referenceKinds.has(item?.taskType) || item?.kind === 'experience') return 'reference';
    const kinds = Object.keys(item?.taskData || {});
    if (item?.taskType === 'auto' && kinds.length && kinds.every(kind => referenceKinds.has(kind)) && !item.date && !item.steps?.length && !item.candidates?.length) return 'reference';
    return 'tasks';
  }
  function hasResult(item) {
    return !!(item?.followupReport?.answer || item?.followupReport?.artifacts?.length || item?.steps?.length || item?.candidates?.length || Object.values(item?.taskData || {}).some(data => Object.values(data || {}).some(value => Array.isArray(value) ? value.length : typeof value === 'string' ? value.trim() : typeof value === 'number')));
  }
  // Reorder only the supplied slots. Hidden cards and other chapters retain
  // their relative positions and their explicit saved preferences.
  function mergeOrder(current, before, after) {
    if (before.length !== after.length || new Set(after).size !== after.length || after.some(id => !before.includes(id))) throw new Error('INVALID_ORDER');
    const order = [...new Set([...current, ...before])], allowed = new Set(before);
    let index = 0;
    return order.map(id => allowed.has(id) ? after[index++] : id);
  }
  function editions(items, item) {
    const id = seriesId(item);
    return id ? items.filter(value => seriesId(value) === id).sort(newestFirst) : [];
  }
  function directory(groups, items, compact = true) {
    const byId = new Map(items.map(item => [item.id, item])), result = [], series = new Map();
    for (const group of groups) {
      const item = byId.get(group.itemId), id = compact && seriesId(item);
      if (!id) { result.push(group); continue; }
      const prior = series.get(id);
      if (!prior) { series.set(id, { index: result.length, item }); result.push(group); }
      else if (newestFirst(item, prior.item) < 0) { result[prior.index] = group; prior.item = item; }
    }
    return result;
  }
  function representative(ids, items, selectedId) {
    if (ids.includes(selectedId)) return selectedId;
    const selected = items.find(item => item.id === selectedId), id = seriesId(selected);
    return id ? ids.find(itemId => seriesId(items.find(item => item.id === itemId)) === id) : undefined;
  }
  window.PAJournalIndex = { seriesId, editions, directory, representative, isGuide, category, hasResult, mergeOrder };
})();
