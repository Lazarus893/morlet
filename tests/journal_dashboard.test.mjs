import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { projectWidget, validateTaskData } from '../plugins/life-journal/widgets.mjs';

const source = readFileSync(new URL('../plugins/webui/public/journal.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(readFileSync(new URL('../plugins/webui/public/journal-widgets.js', import.meta.url), 'utf8'), { window, URL, customElements: { get: () => undefined, whenDefined: () => Promise.resolve() } });
vm.runInNewContext(readFileSync(new URL('../plugins/webui/public/journal-index.js', import.meta.url), 'utf8'), { window });
const widgets = window.PAJournalWidgets, index = window.PAJournalIndex;
function render(kind, data = {}, extra = {}) {
  const item = { id: 'chapter', title: '已核对的真实任务', kind: 'arrangement', taskType: kind, status: 'active', version: 1, steps: [], candidates: [], note: '', taskData: validateTaskData({ [kind]: data }), ...extra };
  const projection = projectWidget(item, kind);
  const html = widgets.render({ id: `chapter:${kind}`, projection }, item, {}, { embedded: true, dashboard: true });
  return { html, document: parseHTML(`<html><body>${html}</body></html>`).document, item, projection };
}

test('dashboard displays saved collection and handoff facts without manual entry forms', () => {
  const collection = render('collection', { entries: [{ id: 'source', title: '来源文献', note: '已读摘录', url: 'https://example.invalid/source' }] });
  assert.ok(collection.html.includes('已读摘录'));
  assert.ok(collection.document.querySelector('a[href="https://example.invalid/source"]'));
  assert.equal(collection.document.querySelector('input,textarea,select,[data-w-action="add-entry"]'), null);
  assert.ok(!collection.html.includes('留下一条灵感'));
  const handoff = render('handoff', { people: [{ id: 'reviewer', name: '负责评审的人', role: '核对来源', tasks: ['检查引用'] }], condition: '来源可追溯' });
  assert.ok(handoff.html.includes('负责评审的人') && handoff.html.includes('检查引用'));
  assert.ok(handoff.html.includes('保存分工不等于对方已经接手'));
  assert.equal(handoff.document.querySelector('input,textarea,select,[data-w-action="set-owner"]'), null);
});

test('read dashboards remove general editors without dropping known values', () => {
  for (const [kind, data, expected] of [
    ['budget', { total: 800, reserve: 100, lines: [{ id: 'travel', label: '交通', amount: 200 }] }, '交通'],
    ['agenda', { place: '会议室' }, '会议室'],
    ['memory', { text: '这是一段已经保存的记录' }, '已经保存的记录'],
    ['reflection', { rating: 4, text: '这次有用' }, '这次有用'],
    ['waiting', { requests: [{ id: 'reply', person: '联系人', request: '核对资料', draft: '请核对这条资料' }] }, '请核对这条资料'],
  ]) {
    const result = render(kind, data);
    assert.ok(result.html.includes(expected), kind);
    assert.equal(result.document.querySelector('input,textarea,select'), null, kind);
  }
});

test('decision, approval, checklist and blocked recovery remain actionable and honest', () => {
  const approval = render('approval', { summary: '核对这次执行范围', amount: 20, conditions: ['仅本次'] });
  assert.ok(approval.document.querySelector('[data-w-action="confirm"]'));
  assert.ok(approval.html.includes('¥20') && approval.html.includes('仅记录确认，不执行'));
  const recovery = render('recovery', { blocker: '授权已撤回', known: ['上次结果仍在'], options: [{ id: 'reauthorize', label: '重新核对授权' }] });
  assert.ok(recovery.html.includes('授权已撤回'));
  assert.ok(recovery.document.querySelector('[data-w-action="ui-path"]'));
  const prep = render('prep', {}, { steps: [{ id: 'source', label: '核对来源', done: false }] });
  assert.ok(prep.document.querySelector('input[type="checkbox"]'));
  assert.equal(widgets.isEmptyReference(approval, approval.item), false);
});

test('empty optional panels are not mistaken for an unknown budget or required decision', () => {
  const collection = render('collection');
  assert.equal(widgets.isEmptyReference({ projection: collection.projection }, collection.item), true);
  const budget = render('budget');
  assert.equal(widgets.isEmptyReference({ projection: budget.projection }, budget.item), false);
  const approval = render('approval');
  assert.equal(widgets.isEmptyReference({ projection: approval.projection }, approval.item), false);
  assert.ok(approval.html.includes('金额待补'));
});

const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
test('onboarding reads real sources and opens an editable canonical-room draft without creating a guide', async () => {
  const routes = [], requests = [];
  const context = { root: {}, pending: false, alive: true, selectionToken: 4, snapshot: { scope: { account: 'local', userId: 'owner' } }, isEditing: () => false, setBusy() {}, patchChrome() {}, setStatus() {}, encodeURIComponent,
    request: async path => { requests.push(path); return { sources: [{ id: 'verified-source', title: '真实资料', summary: '已经核实的摘要', relevance: '当前评审相关' }] }; },
    navigate: async route => routes.push(route) };
  await vm.runInNewContext(extract('  async function openGuide()', '  function captureReadingPosition()') + '\nopenGuide()', context);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].startsWith('journal/guide-sources?'));
  assert.equal(routes[0].page, 'chat'); assert.equal(routes[0].botId, 'xiaoman');
  assert.equal(routes[0].guideSourceId, 'verified-source');
  assert.ok(routes[0].draft.includes('已经核实的摘要'));
  assert.equal(context.pending, false);
  context.request = async () => ({ sources: [] }); routes.length = 0;
  await vm.runInNewContext(extract('  async function openGuide()', '  function captureReadingPosition()') + '\nopenGuide()', context);
  assert.equal(routes[0].guideSourceId, undefined);
  assert.ok(!routes[0].draft.includes('会议'));
});

test('source and report actions resolve different exact messages and never fall back to text', () => {
  const routes = [], item = { id: 'chapter', sourceRef: { conversationId: 'room', messageId: 'user-message' }, followupReport: { sourceRef: { conversationId: 'room', messageId: 'bot-message' } } };
  const block = extract("    if (action === 'source-message' || action === 'report-message')", "    if (action === 'routine-connect')");
  const context = { action: 'source-message', itemId: item.id, currentItem: () => item, navigate: route => routes.push(route), setStatus() {} };
  vm.runInNewContext(`(function(){${block}})()`, context);
  context.action = 'report-message'; vm.runInNewContext(`(function(){${block}})()`, context);
  assert.deepEqual(routes.map(route => route.messageId), ['user-message', 'bot-message']);
  delete item.followupReport.sourceRef;
  vm.runInNewContext(`(function(){${block}})()`, context);
  assert.equal(routes.length, 2);
});

test('sorting snapshots both versions and retains other chapter slots through save or failure', async () => {
  const writes = [], notices = [], updates = [];
  const snapshot = { revision: 7, scope: { account: 'local', userId: 'owner' }, layout: { version: 3, widgets: [{ id: 'a:prep', itemId: 'a' }, { id: 'b:prep', itemId: 'b' }, { id: 'a:budget', itemId: 'a' }] } };
  const context = { snapshot, pending: false, sorting: null, deferredUpdate: null, lastMutationError: { message: '记录版本已变化。' }, selectionToken: 5, notebookItem: 'a', alive: true,
    indexAPI: index, window: { PAChat: { isBusy: () => false } }, isEditing: () => false, preferences: () => ({ order: [], pinned: [] }), setStatus: text => notices.push(text), patchBoard() {}, queueMicrotask,
    update: value => updates.push(value), mutate: async (...args) => { writes.push(args); return true; } };
  vm.runInNewContext(extract('  function beginWidgetOrder(', '  function moveWidget('), context);
  assert.equal(context.beginWidgetOrder('b', ['a:prep', 'a:budget'], 'a:prep'), false);
  assert.equal(context.beginWidgetOrder('a', ['a:prep', 'a:budget'], 'a:prep'), true);
  assert.equal(await context.saveWidgetOrder(['a:budget', 'a:prep']), true);
  assert.equal(writes[0][0], 'layout');
  assert.equal(writes[0][1].version, 3); assert.equal(writes[0][4].revision, 7);
  assert.deepEqual(Array.from(writes[0][1].order), ['a:budget', 'b:prep', 'a:prep']);
  assert.deepEqual(snapshot.layout.widgets.map(widget => widget.id), ['a:prep', 'b:prep', 'a:budget']);
  context.mutate = async () => false;
  context.beginWidgetOrder('a', ['a:prep', 'a:budget'], 'a:prep');
  context.deferredUpdate = { next: { revision: 8 }, tasks: [], scopes: [] };
  assert.equal(await context.saveWidgetOrder(['a:budget', 'a:prep']), false);
  assert.equal(updates[0].revision, 8); assert.ok(notices.at(-1).includes('已恢复')); assert.ok(notices.at(-1).includes('记录版本已变化'));
});

test('polling queues structural changes while a user is dragging instead of replacing the active order', () => {
  const current = { revision: 7, scope: { account: 'local', userId: 'owner' } }, changed = { ...current, revision: 8 };
  const context = { root: {}, snapshot: current, sorting: { itemId: 'a' }, pending: false, deferredUpdate: null, tasks: [], scopes: [], window: { PAChat: { isBusy: () => false } }, patchBoard: () => assert.fail('active drag must not be patched'), patchChrome: () => assert.fail('active drag must not be replaced') };
  vm.runInNewContext(extract('  function update(', '  async function reload()'), context);
  context.update(changed, ['new-task'], []);
  assert.equal(context.snapshot, current);
  assert.equal(context.deferredUpdate.next, changed);
  assert.deepEqual(context.deferredUpdate.tasks, ['new-task']);
});

test('failed onboarding source read remains visible and does not create a fake task', async () => {
  const statuses = [];
  const context = { root: {}, pending: false, alive: true, selectionToken: 4, snapshot: { scope: { account: 'local', userId: 'owner' } }, isEditing: () => false, setBusy() {}, patchChrome() {}, setStatus: (...args) => statuses.push(args), encodeURIComponent,
    request: async () => { throw new Error('offline'); }, navigate: () => assert.fail('failed source read must not silently navigate') };
  await vm.runInNewContext(extract('  async function openGuide()', '  function captureReadingPosition()') + '\nopenGuide()', context);
  assert.equal(context.pending, false);
  assert.equal(statuses[0][1], true);
});

test('late reading-position restoration yields to the chapter the user just chose', async () => {
  let finishOpen;
  const searchNode = { value: '' }, leaves = { scrollTop: 0 }, bookmarks = { scrollTop: 0 };
  const context = { readingIntent: 0, selectionToken: 1, alive: true, snapshot: { scope: 'owner' }, scopeKey: value => value,
    currentItem: id => ({ id }), openItem: () => new Promise(resolve => { finishOpen = resolve; }),
    tab: 'recent', category: 'all', search: '', chapterViews: new Map(), notebookSelection: { recent: 'new-choice' },
    root: { querySelector: selector => selector === '#journal-search' ? searchNode : selector === '.journal-leaves' ? leaves : bookmarks },
    patchChrome() {}, patchBoard() {}, requestAnimationFrame: callback => callback(), window: { scrollTo: () => assert.fail('late restore must not scroll away') } };
  vm.runInNewContext(extract('  async function restoreReadingPosition(', '  function startDraft('), context);
  const restore = context.restoreReadingPosition({ scope: 'owner', itemId: 'previous-chapter', tab: 'all', search: 'old search', chapterView: 'conversation' });
  context.readingIntent++; // A bookmark click while the earlier open is pending.
  finishOpen(); await restore;
  assert.equal(context.notebookSelection.recent, 'new-choice');
  assert.equal(context.tab, 'recent'); assert.equal(context.search, '');
  assert.equal(context.chapterViews.size, 0);
  context.openItem = () => assert.fail('a restore invoked after a user choice must also yield');
  await context.restoreReadingPosition({ scope: 'owner', itemId: 'previous-chapter' });
});

test('reading-position restoration waits for virtual conversations and still restores untouched history', async () => {
  const position = { scope: 'owner', itemId: 'conversation-legacy', tab: 'recent', category: 'tasks', search: '', chapterView: 'output', scrollY: 120, leavesTop: 30, indexTop: 20 };
  let loaded = false, opened, scroll;
  const searchNode = { value: '' }, leaves = { scrollTop: 0 }, bookmarks = { scrollTop: 0 };
  const context = { readingIntent: 0, selectionToken: 1, alive: true, snapshot: { scope: 'owner' }, scopeKey: value => value,
    currentItem: id => loaded ? { id } : null, loadConversations: async () => { loaded = true; }, openItem: async id => { opened = id; },
    tab: 'recent', category: 'all', search: '', chapterViews: new Map(), notebookSelection: {},
    root: { querySelector: selector => selector === '#journal-search' ? searchNode : selector === '.journal-leaves' ? leaves : bookmarks },
    patchChrome() {}, patchBoard() {}, requestAnimationFrame: callback => callback(), window: { scrollTo: value => { scroll = value.top; } } };
  vm.runInNewContext(extract('  async function restoreReadingPosition(', '  function startDraft('), context);
  await context.restoreReadingPosition(position);
  assert.equal(opened, position.itemId); assert.equal(context.notebookSelection.recent, position.itemId);
  assert.equal(context.chapterViews.get(position.itemId), 'output'); assert.equal(context.category, 'tasks');
  assert.equal(scroll, 120); assert.equal(leaves.scrollTop, 30); assert.equal(bookmarks.scrollTop, 20);
});

test('current result stays readable without a character-count gate while history and sources remain secondary', () => {
  const context = { routineFor: () => null, Intl, esc: value => String(value ?? ''), routineUI: { atLabel: () => '今天' }, workDraft: () => ({ panels: {} }), artifactLinks: () => '<a>依据文件</a>' };
  vm.runInNewContext(extract('  function workReport(', '  const awaitingMaterial'), context);
  const html = context.workReport({ id: 'chapter', followupReport: { answer: '当前情况说明。'.repeat(100), answerOutcome: 'partial', sourceRef: { conversationId: 'room', messageId: 'answer' }, reason: '未完成核对', artifacts: [{ path: '/evidence.md' }], history: [{ runId: 'old', answerAt: 1 }] } });
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const current = document.querySelector('.journal-result [data-guide-report]');
  assert.ok(current); assert.equal(current.closest('details'), null);
  assert.equal(document.querySelector('.journal-report-preview'), null);
  assert.ok(document.querySelector('[data-work-detail="history"]'));
  assert.ok(document.querySelector('[data-work-detail="artifacts"]'));
  assert.ok(document.querySelector('[data-j-action="report-message"]'));
  assert.ok(html.includes('部分结果') && html.includes('未完成核对'));
});
