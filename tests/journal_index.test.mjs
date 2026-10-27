import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const window = {};
runInNewContext(readFileSync(new URL('../plugins/webui/public/journal-index.js', import.meta.url), 'utf8'), { window });
const index = window.PAJournalIndex;
const edition = (id, source, day, extra = {}) => ({ id, source: { kind: 'automatic' }, contentSeries: { id: source, day }, ...extra });
const ids = groups => Array.from(groups, group => group.itemId);

test('directory retains one latest edition per source, irrespective of history edits, and leaves ordinary tasks alone', () => {
  const items = [edition('old', 'github', '2026-10-20', { updatedAt: '2026-10-28' }), { id: 'task', title: 'GitHub 整理', source: { kind: 'user' } }, edition('mail', 'google-mail', '2026-10-21'), edition('new', 'github', '2026-10-22'), { id: 'unknown', source: { kind: 'automatic' } }];
  const groups = items.map(item => ({ itemId: item.id, widgets: [item.id] }));
  const before = JSON.stringify({ items, groups });
  assert.deepEqual(ids(index.directory(groups, items)), ['new', 'task', 'mail', 'unknown']);
  assert.equal(JSON.stringify({ items, groups }), before, 'grouping must not mutate persisted data or layout');
  assert.deepEqual(ids(index.directory(groups, items, false)), ids(groups), 'search can show individual editions');
});
test('history selection maps to the latest bookmark while ordered editions and unrelated selection remain correct', () => {
  const items = [edition('older', 'github', '2026-10-19'), edition('latest', 'github', '2026-10-22'), edition('mail', 'google-mail', '2026-10-22')];
  assert.deepEqual(Array.from(index.editions(items, items[0]), item => item.id), ['latest', 'older']);
  assert.equal(index.representative(['latest', 'mail'], items, 'older'), 'latest');
  assert.equal(index.representative(['older', 'latest', 'mail'], items, 'older'), 'older');
  assert.equal(index.representative(['mail'], items, 'older'), undefined);
  assert.equal(index.representative(['virtual'], items, 'virtual'), 'virtual');
  const next = edition('incoming', 'github', '2026-10-23');
  assert.deepEqual(ids(index.directory([...items, next].map(item => ({ itemId: item.id })), [...items, next])), ['incoming', 'mail']);
});

test('recent keeps independent routine pages omitted by design layout while preserving explicit filters', () => {
  const source = readFileSync(new URL('../plugins/webui/public/journal.js', import.meta.url), 'utf8');
  const visibleWidgets = source.slice(source.indexOf('  function visibleWidgets() {'), source.indexOf('  function basicContent('));
  const item = (id, extra = {}) => ({ id, title: id, status: 'planned', taskType: 'collection', taskData: {}, primaryProjection: { kind: 'collection' }, ...extra });
  const items = [item('github'), item('typeless'), item('paused'), item('hidden'), item('closed', { status: 'done' }), item('ordinary')];
  const snapshot = { items, scope: {}, layout: { widgets: [{ id: 'github:collection', itemId: 'github', kind: 'collection' }] }, routines: ['github', 'typeless', 'paused', 'hidden', 'closed', 'another-scope'].map(id => ({ journalItemId: id, enabled: id !== 'paused' })) };
  const context = { snapshot, tab: 'recent', guideOnly: false, search: '', notebookSelection: {}, indexAPI: index, widgetDrafts: new Map(), preferences: () => ({ hidden: ['hidden:collection'], pinned: [], order: [] }), currentItem: id => items.find(item => item.id === id), done: item => item.status === 'done' };
  const visible = () => runInNewContext(visibleWidgets + '\nvisibleWidgets()', context);
  assert.deepEqual(ids(visible()), ['github', 'typeless', 'paused']);
  assert.deepEqual(Array.from(visible(), widget => widget.id), ['github:collection', 'typeless:collection', 'paused:collection']);
  assert.equal(snapshot.layout.widgets.length, 1, 'the generated layout is not mutated');
  context.search = 'Typeless';
  assert.deepEqual(ids(visible()), ['typeless']);
});
