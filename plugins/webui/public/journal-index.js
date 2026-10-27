(() => {
  'use strict';
  const seriesId = item => item?.source?.kind === 'automatic' ? item.contentSeries?.id : null;
  const newestFirst = (a, b) => String(b.contentSeries?.day || '').localeCompare(String(a.contentSeries?.day || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.id.localeCompare(b.id);
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
  window.PAJournalIndex = { seriesId, editions, directory, representative };
})();
