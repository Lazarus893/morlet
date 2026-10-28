import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parseHTML } from 'linkedom';

const source = readFileSync(new URL('../plugins/webui/public/app.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
async function eventually(check) {
  for (let i = 0; i < 50; i++) { if (check()) return; await nextTurn(); }
  assert.fail('Navigation did not settle');
}
function harness(hash = '#journal') {
  const { document, Event } = parseHTML('<html><body><nav id="product-nav"><button id="nav-journal" data-page="journal"></button><button id="nav-chat" data-page="chat"></button></nav><main id="main"></main><div id="header-status"></div><a id="owner-login-link"></a><div id="toast"></div><dialog id="navigation-confirm"><p id="navigation-copy"></p><button id="navigation-stay"></button></dialog></body></html>');
  const listeners = new Map(), polls = [], mounts = [], restores = [], opened = [];
  const location = { hash }, stack = [{ url: hash, state: null }]; let cursor = 0, options, discarded = 0, mountWait;
  let position = { itemId: 'matter-2', tab: 'recent', scrollY: 480 }, chatDraft = '这段草稿不能丢';
  const history = {
    get state() { return stack[cursor].state; },
    replaceState(state, _title, url) { stack[cursor] = { state, url }; location.hash = url; },
    pushState(state, _title, url) { stack.splice(++cursor); stack[cursor] = { state, url }; location.hash = url; },
    back() { if (cursor) { cursor--; location.hash = stack[cursor].url; listeners.get('hashchange')(); } },
  };
  const idle = () => ({ isBusy: () => false, isEditing: () => false, unmount() {}, mount() {} });
  const window = {
    addEventListener(type, fn) { listeners.set(type, fn); }, scrollTo() {},
    PATransport: { create: () => ({ api: async () => ({ runtime: { accounts: [] }, journal: { preferences: {} } }) }) },
    PAOnboarding: idle(), PAConnections: idle(),
    PAChat: { ...idle(), captureReadingPosition() {}, hasPendingDownload: () => false, discardCurrentDraft() { discarded++; chatDraft = ''; } },
    PABots: { ...idle(), async mount(value) { options = value; mounts.push(value); value.root.innerHTML = '<section class="bots-workspace"></section>'; if (mountWait) { const wait = mountWait; mountWait = null; await wait; } } },
    PAJournal: {
      ...idle(), mount(value) { options = value; value.root.innerHTML = '<section class="journal"><h1>手账</h1></section>'; },
      captureReadingPosition: () => position,
      async restoreReadingPosition(value) { if (value) restores.push(value); },
      async openItem(id, entryId) { opened.push({ id, entryId }); },
      async openConversation(value) { opened.push({ conversationId: value.conversationId }); },
      async openGuide() { await options.navigate({ page: 'chat', botId: 'xiaoman', draft: '跟进已授权资料', guideSourceId: 'source-1' }); },
    },
  };
  runInNewContext(source, { window, document, location, history, URLSearchParams, setInterval: fn => { polls.push(fn); }, clearTimeout() {}, setTimeout: () => 1 });
  return {
    document, location, history, mounts, restores, opened, stack,
    ready: () => eventually(() => options),
    navigate: value => options.navigate(value),
    poll: async () => { polls.forEach(fn => fn()); await nextTurn(); },
    setPosition(value) { position = value; },
    deferNextMount() { let resolve; mountWait = new Promise(done => { resolve = done; }); return resolve; },
    get discarded() { return discarded; }, get draft() { return chatDraft; },
    hash(value) { location.hash = value; listeners.get('hashchange')(); },
    click(selector) { document.querySelector(selector).dispatchEvent(new Event('click', { bubbles: true })); },
  };
}

test('a journal reference retains exact message identity and browser Back restores its reading position', async () => {
  const h = harness('#journal/matter-2'); await h.ready();
  assert.equal(await h.navigate({ page: 'chat', conversationId: 'room-2', messageId: 'message-2' }), true);
  assert.equal(h.location.hash, '#chat/room-2/message-2');
  assert.equal(h.mounts.at(-1).conversationId, 'room-2');
  assert.equal(h.mounts.at(-1).messageId, 'message-2');
  assert.equal(h.discarded, 0); assert.equal(h.draft, '这段草稿不能丢');
  h.history.back(); await eventually(() => h.restores.length);
  assert.deepEqual(plain(h.restores.at(-1)), { itemId: 'matter-2', tab: 'recent', scrollY: 480 });
  assert.equal(h.location.hash, '#journal/matter-2');
});

test('initial direct message links work and polling does not replay highlighting or draft injection', async () => {
  const h = harness('#chat/room-2/message-2'); await h.ready(); await nextTurn();
  assert.equal(h.mounts[0].messageId, 'message-2');
  await h.poll();
  assert.equal(h.mounts.at(-1).messageId, undefined);
  assert.equal(await h.navigate({ page: 'chat', botId: 'mori', draft: '私有候选', sourceRefs: [{ conversationId: 'private-room', messageId: 'private-source' }] }), true);
  assert.equal(h.mounts.at(-1).draft, '私有候选');
  assert.equal(h.location.hash, '#chat?bot=mori');
  assert.doesNotMatch(h.location.hash, /私有|private-source/);
  await h.poll(); assert.equal(h.mounts.at(-1).draft, undefined);
});

test('malformed deep links do not break the page or interpret a message as a different room', async () => {
  const h = harness('#chat/%E0%A4/message'); await h.ready();
  assert.equal(h.location.hash, '#journal');
  await h.navigate({ page: 'chat', conversationId: 'valid', messageId: 'exact' });
  h.hash('#chat/valid/%2Fother'); await nextTurn();
  assert.equal(h.location.hash, '#chat/valid/exact');
  assert.equal(h.mounts.at(-1).messageId, 'exact');
});

test('journal entry links preserve the exact entry through reload', async () => {
  const h = harness('#journal/matter-2?entry=entry-7'); await h.ready(); await nextTurn();
  assert.deepEqual(plain(h.opened[0]), { id: 'matter-2', entryId: 'entry-7' });
});

test('the guide can redirect through the journal controller into Mori without sending or losing its source', async () => {
  const h = harness(); await h.ready();
  assert.equal(await h.navigate({ page: 'journal', section: 'guide' }), true);
  assert.equal(h.location.hash, '#chat?bot=xiaoman');
  assert.equal(h.mounts.at(-1).guideSourceId, 'source-1');
  assert.equal(h.mounts.at(-1).draft, '跟进已授权资料');
  assert.equal(h.discarded, 0);
});

test('a slower previous chat navigation cannot reopen its conversation in the newer journal destination', async () => {
  const h = harness(); await h.ready();
  const finishMount = h.deferNextMount();
  const first = h.navigate({ page: 'chat', conversationId: 'older-room', messageId: 'older-message' });
  await eventually(() => h.mounts.length);
  await h.navigate({ page: 'journal', itemId: 'newer-matter' });
  finishMount(); await first;
  assert.equal(h.location.hash, '#journal/newer-matter');
  assert.deepEqual(plain(h.opened), [{ id: 'newer-matter' }]);
  assert.equal(h.document.body.dataset.page, 'journal');
});
