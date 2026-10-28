import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parseHTML } from 'linkedom';

const scripts = ['truth', 'bots', 'app'].map(name => readFileSync(new URL(`../plugins/webui/public/${name}.js`, import.meta.url), 'utf8'));
async function eventually(check) {
  for (let i = 0; i < 60; i++) { if (check()) return; await nextTurn(); }
  assert.fail('The production app and Bot route did not settle');
}

test('a newly created Bot stays selected through production app and Bot polling after directory navigation', async () => {
  const reader = 'f1fc452b-1f0f-4ef3-8e91-ccd8dbdaca41';
  const room = id => ({ id: `room-${id}`, kind: 'direct', roomKind: 'direct', botId: id, title: id });
  const rooms = [room('xiaoman'), room(reader), { id: 'room-group', kind: 'group', roomKind: 'group', title: '全员群' }];
  const model = { bots: [{ id: 'xiaoman', name: 'Mori' }, { id: reader, name: '读书搭子' }].map(bot => ({ ...bot, active: true, connected: true, online: true })), rooms, conversations: rooms, endpoints: [], rootTasks: [], runs: [] };
  const { document, Event } = parseHTML('<html><body><nav id="product-nav"><button id="nav-journal" data-page="journal"></button><button id="nav-chat" data-page="chat"></button></nav><main id="main"></main><div id="header-status"></div><a id="owner-login-link"></a><div id="toast"></div><dialog id="navigation-confirm"><p id="navigation-copy"></p><button id="navigation-stay"></button></dialog></body></html>');
  Object.getPrototypeOf(document.createElement('dialog')).close = function() { this.open = false; this.dispatchEvent(new Event('close')); };
  const location = { hash: '#chat?bot=xiaoman' }, intervals = new Map(), opened = [], apiCalls = [], listeners = new Map();
  let timer = 0, historyState = null, chatHost, onConversation;
  const history = { get state() { return historyState; }, replaceState(value, _title, url) { historyState = value; location.hash = url; }, pushState(value, _title, url) { historyState = value; location.hash = url; } };
  const idle = () => ({ isBusy: () => false, isEditing: () => false, unmount() {}, mount() {} });
  const window = {
    addEventListener(type, fn) { listeners.set(type, fn); }, scrollTo() {},
    PATransport: { create: () => ({ api: async (path, data) => { apiCalls.push({ path, data }); return path === 'state' ? { runtime: { accounts: [] }, journal: { preferences: {} } } : model; } }) },
    PAOnboarding: idle(), PAConnections: idle(), PAJournal: { ...idle(), captureReadingPosition() {} },
    // Only the lower chat renderer is stubbed. Both actual navigation owners,
    // their async mounting and both independent polling loops run unchanged.
    PAChat: { ...idle(), hasPendingDownload: () => false, captureReadingPosition() {},
      mount(options) { chatHost = options.root; onConversation = options.onConversation; chatHost.innerHTML = '<section class="chat-center"><textarea></textarea></section>'; },
      async open(options) { opened.push(options); onConversation?.(rooms.find(item => item.id === options.conversationId)); },
    },
  };
  const context = createContext({ window, document, Event, location, history, URLSearchParams, confirm: () => false, setTimeout: () => 1, clearTimeout() {}, setInterval: fn => { intervals.set(++timer, fn); return timer; }, clearInterval: id => intervals.delete(id) });
  for (const source of scripts) runInContext(source, context);
  try {
    await eventually(() => opened.length === 1 && !window.PABots.isBusy());
    const list = document.querySelector('#bots-list'), header = document.querySelector('.bot-chat-head'), host = chatHost;
    document.querySelector(`[data-bot="${reader}"]`).dispatchEvent(new Event('click', { bubbles: true }));
    await eventually(() => opened.at(-1)?.conversationId === `room-${reader}` && !window.PABots.isBusy());
    assert.equal(location.hash, `#chat?bot=${reader}`);
    assert.equal(document.querySelector('#bots-list'), list); assert.equal(document.querySelector('.bot-chat-head'), header); assert.equal(chatHost, host);
    for (let i = 0; i < 3; i++) { for (const fn of [...intervals.values()]) fn(); await nextTurn(); await nextTurn(); }
    assert.equal(document.querySelector('#bot-chat-title').textContent, '读书搭子');
    assert.equal(document.querySelector('[data-bot][aria-current=true]').dataset.bot, reader);
    assert.equal(opened.length, 2, 'state polling must not reopen Mori or reset the newly selected Bot');
    assert.ok(apiCalls.filter(call => call.path === 'state').length >= 2);
    assert.ok(apiCalls.filter(call => call.path === 'hub').length >= 3);
  } finally { window.PABots.unmount(); }
});
