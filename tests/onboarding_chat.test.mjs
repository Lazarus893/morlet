import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { messageTimes, projectMessage } from '../plugins/agent-hub/projections.mjs';

const truthSource = await readFile(new URL('../plugins/webui/public/truth.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../plugins/webui/public/chat.js', import.meta.url), 'utf8');
const example = '帮我准备生日聚会，先确认日期、人数和预算。';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const snapshot = (conversations = [{ id: 'old-im', title: '原来的手机对话', endpointId: 'agent-a' }]) => ({
  bots: [{ id: 'xiaoman', name: '小满', handle: 'xiaoman', avatar: 'steward', active: true, connected: true, online: true, resolvedEndpointId: 'agent-a' }, { id: 'agent-b', name: '阿探', handle: 'research', avatar: 'research', active: true, connected: true, online: true, resolvedEndpointId: 'agent-b' }],
  endpoints: [{ id: 'agent-a', label: '测试执行端', provider: 'codex', active: true, online: true }],
  conversations, messages: [], runs: [], tasks: [], approvals: [], deliveries: [], channels: [], bindings: [],
});

// This deliberately small DOM implements only the browser APIs exercised here.
// The production script is evaluated unchanged, including renderData, event
// handlers, transport calls and finally blocks. It does not validate CSS/layout.
class Element {
  constructor(tagName = 'div', id = '') {
    Object.assign(this, { tagName: tagName.toUpperCase(), id, value: '', disabled: false,
      hidden: false, textContent: '', dataset: {}, children: [], listeners: new Map(),
      isConnected: true, scrollHeight: 0, scrollTop: 0, clientHeight: 0, options: [] });
    this._html = '';
  }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this._html = value;
    if (this.id === 'chat-messages') {
      this.children = [...value.matchAll(/<article\b[^>]*id="([^"]+)"[^>]*data-message-id="([^"]+)"/g)].map((match, index) => {
        const node = new Element('article', match[1]); node.dataset.messageId = match[2];
        node.getBoundingClientRect = () => ({ top: index * 100 - this.scrollTop, bottom: (index + 1) * 100 - this.scrollTop });
        node.scrollIntoView = () => { this.scrollTop = index * 100; }; return node;
      });
      this.scrollHeight = this.children.length * 100;
    }
    if (this.tagName === 'SELECT') {
      this.options = [...value.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>/g)].map(match => ({ value: match[1] }));
      this.value = this.options[0]?.value || '';
    }
  }
  addEventListener(type, fn) { const callbacks = this.listeners.get(type) || []; callbacks.push(fn); this.listeners.set(type, callbacks); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(callback => callback !== fn)); }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn({ target: this, preventDefault() {}, ...event }); }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  append(node) { this.children.push(node); }
  prepend(node) { this.options.unshift(node); }
  replaceChildren() { this.children = []; }
  querySelectorAll(selector) { return this.children.filter(node => node.tagName.toLowerCase() === selector || selector === '[data-message-id]' && node.dataset.messageId || selector === '#' + node.id); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return selector === 'form' ? this.form : selector === '.chat-center' ? this.section : null; }
  focus() { this.focusCount = (this.focusCount || 0) + 1; }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, bottom: this.clientHeight }; }
  setAttribute(name, value) { this[name] = String(value); }
  getAttribute(name) { return this[name] ?? null; }
}

class Root extends Element {
  set innerHTML(value) {
    this._html = value; this.nodes = new Map();
    for (const match of value.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)) this.nodes.set(match[2], new Element(match[1], match[2]));
    this.heading = new Element('h1'); this.section = new Element('section');
    const compose = this.nodes.get('chat-compose'), input = this.nodes.get('chat-input');
    if (compose) { compose.section = this.section; compose.fields = { content: input }; input.form = compose; }
    for (const id of ['chat-pair', 'chat-channel-pair', 'chat-local-pair']) {
      const form = this.nodes.get(id); if (form) { form.section = this.section; form.fields = {}; }
    }
    const channel = this.nodes.get('chat-channel-pair');
    if (channel) {
      const conversation = this.nodes.get('chat-channel-conversation'); conversation.form = channel; channel.fields.conversationId = conversation;
      for (const [name, value] of Object.entries({ peer: 'sender@example.invalid', botAddress: 'bot@example.invalid', endpoint: 'https://fixture.invalid' })) {
        const field = new Element('input'); Object.assign(field, { name, value, form: channel }); channel.fields[name] = field;
      }
    }
    const pair = this.nodes.get('chat-pair');
    for (const [name, initial] of Object.entries(pair ? { label: '测试电脑', provider: 'codex', workspace: '/fixture/v1', command: 'codex', endpoint: 'https://fixture.invalid' } : {})) {
      const field = new Element('input'); Object.assign(field, { name, value: initial, form: pair }); pair.fields[name] = field;
    }
  }
  contains(node) { return node === this || [...this.nodes.values()].includes(node) || Boolean(node?.dataset?.chatAction); }
  get innerHTML() { return this._html; }
  querySelector(selector) {
    if (selector === '.chat-center') return this._html ? this.section : null;
    if (selector === 'h1') return this.heading;
    if (selector === '#chat-compose textarea') return this.nodes.get('chat-input');
    return selector.startsWith('#') ? this.nodes.get(selector.slice(1)) || this.nodes.get('chat-messages')?.querySelector(selector) || undefined : null;
  }
  querySelectorAll(selector) { return selector.split(',').map(part => this.querySelector(part.trim())).filter(Boolean); }
}

class FormDataFixture {
  constructor(form) { this.form = form; }
  *entries() { for (const [key, field] of Object.entries(this.form.fields || {})) yield [key, field.value]; }
  [Symbol.iterator]() { return this.entries(); }
}

function harness(transport, initialStorage = {}, initialOptions = {}) {
  const root = new Root(), intervals = new Map(), storage = new Map(Object.entries(initialStorage)), calls = [], revoked = [];
  let nextInterval = 0, nextBlob = 0, confirmed = false;
  const confirmations = [];
  class URLFixture extends URL {
    static createObjectURL() { return `blob:fixture-${++nextBlob}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const document = { body: new Element('body'), activeElement: null, createElement: tag => new Element(tag) };
  document.activeElement = document.body;
  const context = vm.createContext({
    window: {}, document, FormData: FormDataFixture, Blob, URL: URLFixture, crypto: webcrypto,
    location: { protocol: 'https:', hostname: 'fixture.invalid', origin: 'https://fixture.invalid' },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setInterval: fn => { intervals.set(++nextInterval, fn); return nextInterval; }, clearInterval: id => intervals.delete(id), setTimeout: () => 1, clearTimeout() {},
    confirm: text => { confirmations.push(text); return confirmed; }, CSS: { escape: value => value },
  });
  vm.runInContext(truthSource, context);
  vm.runInContext(source, context, { filename: 'production-chat.js' });
  const chat = context.window.PAChat;
  const api = async (path, data) => { calls.push(data?.operation || 'GET'); return transport(path, data); };
  const mount = (options = initialOptions) => chat.mount({ root, api, runtime: { accounts: [] }, localAgentAvailable: false, ...options });
  mount();
  return { chat, root, calls, storage, revoked, mount, confirmations, allowConfirm: () => { confirmed = true; },
    control: id => root.querySelector('#' + id),
    tick: () => { for (const fn of intervals.values()) fn(); },
    submit: id => root.emit('submit', { target: root.querySelector('#' + id) }),
  };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 40; attempt++) { if (check()) return; await nextTurn(); }
  assert.fail('The production handler did not reach the expected state.');
}
async function ready(h) { await eventually(() => !h.control('chat-input').disabled); }
function locked(h) {
  for (const id of ['chat-input', 'chat-send', 'chat-agent-select']) assert.equal(h.control(id).disabled, true, id);
  assert.equal(h.chat.isBusy(), true);
}
function selectedIds(h) {
  const id = h.storage.get('xiaoman-current-conversation'); return id ? [id] : [];
}

test('canonical direct and group sends stay in chat until a journal item is explicitly supplied', async () => {
  for (const roomKind of ['direct', 'group']) {
    const sent = [], room = { id: 'room-a', title: '固定聊天', botId: roomKind === 'direct' ? 'agent-b' : 'xiaoman' };
    const h = harness(async (_path, data) => { if (data) { sent.push(data); return {}; } return snapshot([room]); }, {}, { conversationId: room.id, roomKind, botId: room.botId });
    try {
      await ready(h);
      assert.equal(h.control('chat-agent-select').value, room.botId);
      assert.equal(h.control('chat-compose').dataset.direct, String(roomKind === 'direct'));
      if (roomKind === 'group') assert.match(h.control('chat-agent-select').innerHTML, /自动分派/);
      h.control('chat-input').value = '只聊一条消息'; h.submit('chat-compose');
      await eventually(() => sent.length === 1 && !h.chat.isBusy());
      assert.equal(sent[0].journal, false); assert.equal(sent[0].journalItemId, undefined);
      assert.equal(sent[0].botId, room.botId); assert.equal(h.control('chat-input').value, '');
      assert.equal(h.control('chat-status').textContent, '');
      h.chat.unmount(); h.mount({ conversationId: room.id, roomKind, botId: room.botId, journalItemId: 'item-a' });
      await ready(h); h.control('chat-input').value = '跟进这一篇'; h.submit('chat-compose');
      await eventually(() => sent.length === 2 && !h.chat.isBusy());
      assert.equal(sent[1].journal, true); assert.equal(sent[1].journalItemId, 'item-a');
    } finally { h.chat.unmount(); }
  }
});

test('journal conversations filter messages, task errors and approvals by root task within one shared room', async () => {
  const model = snapshot([{ id: 'room-a', title: '共享聊天', botId: 'xiaoman' }]);
  model.runs = [
    { id: 'run-a', rootRunId: 'run-a', journalItemIds: ['item-a'], conversationId: 'room-a', status: 'completed', createdAt: 1 },
    { id: 'run-b', rootRunId: 'run-b', journalItemIds: ['item-b'], conversationId: 'room-a', status: 'failed', error: '另一篇错误', createdAt: 2 },
  ];
  model.messages = [
    { id: 'message-a', conversationId: 'room-a', journalItemIds: ['item-a'], role: 'user', text: '甲篇消息', createdAt: 1 },
    { id: 'message-child', conversationId: 'room-a', rootRunId: 'run-a', role: 'assistant', text: '甲篇协作回报', createdAt: 1 },
    { id: 'message-b', conversationId: 'room-a', runId: 'run-b', role: 'user', text: '乙篇消息', createdAt: 2 },
  ];
  model.approvals = [{ id: 'approval-b', runId: 'run-b', conversationId: 'room-a', state: 'pending', action: { title: '另一篇审批' } }];
  model.deliveries = [{ id: 'message-b', conversationId: 'room-a', state: 'unknown' }];
  const h = harness(async () => model, {}, { conversationId: 'room-a', journalItemId: 'item-a' });
  try {
    await ready(h);
    assert.match(h.control('chat-messages').innerHTML, /甲篇消息/); assert.match(h.control('chat-messages').innerHTML, /甲篇协作回报/);
    assert.doesNotMatch(h.control('chat-messages').innerHTML, /乙篇消息/);
    assert.equal(h.control('chat-run-notice').innerHTML, ''); assert.equal(h.control('chat-approvals').innerHTML, '');
    assert.equal(h.control('chat-delivery-note').textContent, '');
    h.mount({ conversationId: 'room-a', journalItemId: 'item-b' }); await ready(h);
    assert.match(h.control('chat-messages').innerHTML, /乙篇消息/); assert.doesNotMatch(h.control('chat-messages').innerHTML, /甲篇消息/);
    assert.match(h.control('chat-messages').innerHTML, /另一篇错误/);
    assert.equal(h.control('chat-run-notice').innerHTML, '', 'Recovery is attached to the exact task message'); assert.match(h.control('chat-approvals').innerHTML, /另一篇审批/);
    assert.match(h.control('chat-messages').innerHTML, /发送结果未知/);
    h.mount({ conversationId: 'room-a', roomKind: 'group' }); await ready(h);
    assert.match(h.control('chat-messages').innerHTML, /甲篇消息/); assert.match(h.control('chat-messages').innerHTML, /乙篇消息/);
  } finally { h.chat.unmount(); }
});

test('two journal items in one room retain independent drafts and retry identities across remount and reload', async () => {
  const requests = [], room = { id: 'room-a', title: '共享聊天', botId: 'xiaoman' };
  const transport = async (_path, data) => {
    if (!data) return snapshot([room]);
    requests.push(data); throw Object.assign(new Error('响应丢失'), { code: 'NETWORK_UNAVAILABLE' });
  };
  const h = harness(transport, {}, { conversationId: room.id, journalItemId: 'item-a' });
  await ready(h); h.control('chat-input').value = '甲篇草稿'; h.submit('chat-compose');
  await eventually(() => requests.length === 1 && !h.chat.isBusy());
  h.mount({ conversationId: room.id, journalItemId: 'item-b' }); await ready(h);
  assert.equal(h.control('chat-input').value, '');
  h.control('chat-input').value = '乙篇草稿'; h.submit('chat-compose');
  await eventually(() => requests.length === 2 && !h.chat.isBusy());
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  h.mount({ conversationId: room.id, journalItemId: 'item-a' }); await ready(h);
  assert.equal(h.control('chat-input').value, '甲篇草稿'); h.chat.unmount();
  const reload = harness(transport, Object.fromEntries(h.storage), { conversationId: room.id, journalItemId: 'item-b' });
  try {
    await ready(reload); assert.equal(reload.control('chat-input').value, '乙篇草稿');
    assert.equal(requests.length, 2); reload.submit('chat-compose');
    await eventually(() => requests.length === 3 && !reload.chat.isBusy());
    assert.equal(requests[2].requestId, requests[1].requestId); assert.equal(requests[2].journalItemId, 'item-b');
  } finally { reload.chat.unmount(); }
});

test('a new journal page keeps a separate draft and retry identity from its Bot private room', async () => {
  const room = { id: 'room-a', title: '小满', botId: 'xiaoman', roomKind: 'direct' }, requests = [];
  const model = snapshot([room]);
  model.messages = [{ id: 'old-message', conversationId: room.id, role: 'user', text: '私聊旧消息', createdAt: 1 }];
  const transport = async (_path, data) => {
    if (!data) return model;
    if (data.operation === 'open-room') return room;
    requests.push(data); throw new Error('响应丢失');
  };
  const h = harness(transport, {}, { conversationId: room.id, roomKind: 'direct', botId: 'xiaoman' });
  try {
    await ready(h); h.control('chat-input').value = '私聊草稿'; h.submit('chat-compose');
    await eventually(() => requests.length === 1 && !h.chat.isBusy());
    h.mount({ journalDraft: true }); await ready(h); await h.chat.open({ newConversation: true });
    assert.equal(h.control('chat-input').value, '');
    assert.doesNotMatch(h.control('chat-messages').innerHTML, /私聊旧消息/);
    h.control('chat-input').value = '新事项草稿'; h.submit('chat-compose');
    await eventually(() => requests.length === 2 && !h.chat.isBusy());
    assert.notEqual(requests[0].requestId, requests[1].requestId); assert.equal(requests[1].journal, true);
    h.mount({ conversationId: room.id, roomKind: 'direct', botId: 'xiaoman' }); await ready(h);
    assert.equal(h.control('chat-input').value, '私聊草稿');
    h.submit('chat-compose'); await eventually(() => requests.length === 3 && !h.chat.isBusy());
    assert.equal(requests[2].requestId, requests[0].requestId); h.chat.unmount();
    const reload = harness(transport, Object.fromEntries(h.storage), { journalDraft: true });
    try {
      await ready(reload); await reload.chat.open({ newConversation: true });
      assert.equal(reload.control('chat-input').value, '新事项草稿');
      reload.submit('chat-compose'); await eventually(() => requests.length === 4 && !reload.chat.isBusy());
      assert.equal(requests[3].requestId, requests[1].requestId);
    } finally { reload.chat.unmount(); }
  } finally { h.chat.unmount(); }
});

test('a conversation switch fetches its own messages while an older poll is still pending and preserves both drafts', async () => {
  const conversations = [{ id: 'old-im', title: '原来的手机对话', endpointId: 'agent-a' }, { id: 'new-web', title: '网页对话', endpointId: 'agent-a' }];
  const old = { ...snapshot(conversations), messages: [{ id: 'old-message', conversationId: 'old-im', role: 'user', channel: 'web', text: '原对话消息', createdAt: 1 }] };
  const fresh = { ...snapshot(conversations), messages: [{ id: 'new-message', conversationId: 'new-web', role: 'user', channel: 'web', text: '新对话消息', createdAt: 2 }] };
  const delayed = deferred(); let delayOld = false; const paths = [];
  const h = harness(async path => { paths.push(path); if (path.includes('new-web')) return fresh; return delayOld ? delayed.promise : old; });
  try {
    await ready(h);
    h.control('chat-input').value = '原对话未发送草稿';
    delayOld = true; h.tick();
    await eventually(() => paths.includes('hub?conversation=old-im'));
    h.chat.unmount(); h.mount({ conversationId: 'new-web' });
    await eventually(() => h.control('chat-messages').innerHTML.includes('新对话消息'));
    assert.ok(paths.includes('hub?conversation=new-web'), 'The new conversation cannot reuse the old pending GET');
    h.control('chat-input').value = '新对话未发送草稿';
    delayed.resolve(old); await nextTurn(); await nextTurn();
    assert.match(h.control('chat-messages').innerHTML, /新对话消息/);
    assert.doesNotMatch(h.control('chat-messages').innerHTML, /原对话消息/);
    h.chat.unmount(); h.mount({ conversationId: 'old-im' });
    await eventually(() => h.control('chat-messages').innerHTML.includes('原对话消息'));
    assert.equal(h.control('chat-input').value, '原对话未发送草稿');
    h.chat.unmount(); h.mount({ conversationId: 'new-web' });
    await eventually(() => h.control('chat-messages').innerHTML.includes('新对话消息'));
    assert.equal(h.control('chat-input').value, '新对话未发送草稿');
  } finally { h.chat.unmount(); }
});

test('a slow fresh GET locks the old IM input before preparing an unsent Web draft', async () => {
  const fresh = deferred(); let gets = 0;
  const h = harness(async (_path, data) => !data ? ++gets === 1 ? snapshot() : fresh.promise : { id: 'new-web', title: '第一件生活事', endpointId: 'agent-a' });
  await ready(h);
  h.control('chat-input').value = '原手机对话里尚未发送的内容';
  const opening = h.chat.open({ example, endpointId: 'agent-a' });
  locked(h); h.submit('chat-compose'); await nextTurn();
  assert.equal(h.calls.includes('send'), false); assert.equal(h.calls.includes('open-room'), false);
  fresh.resolve(snapshot()); await opening;
  assert.deepEqual(selectedIds(h), ['new-web']);
  assert.equal(h.control('chat-input').value, example);
  assert.equal(h.control('chat-input').disabled, false); assert.equal(h.chat.isBusy(), false);
  assert.equal(h.calls.includes('send'), false);
  h.chat.unmount();
});

test('a first mount waiting for its first snapshot cannot expose an editable old conversation during the handoff', async () => {
  const firstRead = deferred();
  const h = harness(async (_path, data) => !data ? firstRead.promise : { id: 'first-web', title: '第一件生活事', endpointId: 'agent-a' });
  const opening = h.chat.open({ example, endpointId: 'agent-a' });
  for (const id of ['chat-input', 'chat-send']) assert.equal(h.control(id).disabled, true, id);
  h.submit('chat-compose'); await nextTurn();
  assert.deepEqual(h.calls, ['GET']);
  firstRead.resolve(snapshot()); await opening;
  assert.deepEqual(selectedIds(h), ['first-web']); assert.equal(h.control('chat-input').value, example);
  assert.equal(h.calls.includes('send'), false); assert.equal(h.chat.isBusy(), false);
  h.chat.unmount();
});

test('a delayed canonical-room POST keeps sending disabled and restores editing only after the new draft exists', async () => {
  const created = deferred();
  const h = harness(async (_path, data) => data?.operation === 'open-room' ? created.promise : snapshot());
  await ready(h);
  const opening = h.chat.open({ example, endpointId: 'agent-a' });
  await eventually(() => h.calls.includes('open-room'));
  locked(h); h.submit('chat-compose'); await nextTurn();
  assert.deepEqual(selectedIds(h), ['old-im']); assert.equal(h.calls.includes('send'), false);
  created.resolve({ id: 'birthday-web', title: '第一件生活事', endpointId: 'agent-a' }); await opening;
  assert.deepEqual(selectedIds(h), ['birthday-web']);
  assert.equal(h.control('chat-input').value, example); assert.equal(h.control('chat-input').disabled, false);
  assert.equal(h.control('chat-send').disabled, false); assert.equal(h.calls.includes('send'), false);
  assert.equal(h.control('chat-input').focusCount, 1);
  h.chat.unmount();
});

test('a failed fresh GET preserves the previous draft, makes no new/send call and releases the preparation lock', async () => {
  let gets = 0;
  const h = harness(async () => { if (++gets === 1) return snapshot(); throw new Error('快照暂时不可读取'); });
  await ready(h); h.control('chat-input').value = '想继续校对的旧草稿';
  await assert.rejects(h.chat.open({ example, endpointId: 'agent-a' }), /最新状态/);
  assert.deepEqual(h.calls, ['GET', 'GET']);
  assert.equal(h.control('chat-input').value, '想继续校对的旧草稿');
  assert.deepEqual(selectedIds(h), ['old-im']);
  assert.equal(h.chat.isBusy(), false); assert.equal(h.control('chat-input').disabled, false);
  assert.equal(h.control('chat-send').disabled, true, 'offline state must not offer a write'); assert.equal(h.control('chat-agent-select').disabled, false);
  h.chat.unmount();
});

test('a disconnected poll retains editable input, blocks writes and reconnects without sending the draft', async () => {
  let connected = true;
  const h = harness(async (_path, data) => {
    assert.equal(data, undefined, 'reconnection cannot submit a draft');
    if (!connected) throw Object.assign(new Error('offline'), { code: 'NETWORK_UNAVAILABLE' });
    return snapshot();
  });
  await ready(h);
  const input = h.control('chat-input'); input.value = '等恢复后再交代的一件事'; h.root.emit('input', { target: input });
  connected = false; h.tick();
  await eventually(() => h.control('chat-send').disabled);
  assert.equal(input.value, '等恢复后再交代的一件事'); assert.equal(input.disabled, false);
  assert.equal(h.control('chat-connectivity').hidden, false);
  h.submit('chat-compose'); await nextTurn();
  assert.equal(h.calls.includes('send'), false);
  connected = true; h.tick();
  await eventually(() => !h.control('chat-send').disabled);
  assert.equal(h.control('chat-connectivity').hidden, true);
  assert.equal(input.value, '等恢复后再交代的一件事'); assert.equal(h.calls.includes('send'), false);
  h.chat.unmount();
});

test('an acknowledged-but-lost send retains its idempotency key across reload and never auto-replays', async () => {
  const requests = [], accepted = new Set(); let loseResponse = true;
  const transport = async (_path, data) => {
    if (!data) { const value = snapshot(); value.endpoints.push({ id: 'agent-b', label: '另一个执行端', provider: 'codex', active: true, online: true }); return value; }
    assert.equal(data.operation, 'send'); requests.push(data.requestId); accepted.add(data.requestId);
    assert.equal(data.botId, 'agent-b', 'manual retry must retain the explicitly selected Bot');
    if (loseResponse) throw Object.assign(new Error('Response lost'), { code: 'NETWORK_UNAVAILABLE' });
    return {};
  };
  const first = harness(transport); await ready(first);
  first.control('chat-agent-select').value = 'agent-b'; first.root.emit('change', { target: first.control('chat-agent-select') });
  first.control('chat-input').value = '只核对服务回复，不新增生活事项';
  first.root.emit('input', { target: first.control('chat-input') }); first.submit('chat-compose');
  await eventually(() => requests.length === 1 && !first.chat.isBusy());
  assert.equal(first.control('chat-input').value, '只核对服务回复，不新增生活事项');
  first.chat.unmount();
  const reloaded = harness(transport, Object.fromEntries(first.storage)); await ready(reloaded);
  assert.equal(reloaded.control('chat-input').value, '只核对服务回复，不新增生活事项');
  assert.equal(requests.length, 1, 'mount must never replay pending input');
  loseResponse = false; reloaded.submit('chat-compose');
  await eventually(() => requests.length === 2 && !reloaded.chat.isBusy());
  assert.equal(requests[1], requests[0]); assert.equal(accepted.size, 1);
  assert.equal(reloaded.control('chat-input').value, '');
  reloaded.chat.unmount();
  const final = harness(transport, Object.fromEntries(reloaded.storage)); await ready(final);
  assert.equal(final.control('chat-input').value, ''); assert.equal(requests.length, 2);
  final.chat.unmount();
});

test('a failed canonical-room POST releases the lock and leaves the original IM draft unsent', async () => {
  const h = harness(async (_path, data) => {
    if (data?.operation === 'open-room') throw new Error('新对话创建尚未成功');
    return snapshot();
  });
  await ready(h); h.control('chat-input').value = '旧对话里需要保留的交代';
  await assert.rejects(h.chat.open({ example, endpointId: 'agent-a' }), /创建尚未成功/);
  assert.deepEqual(selectedIds(h), ['old-im']); assert.equal(h.control('chat-input').value, '旧对话里需要保留的交代');
  assert.equal(h.chat.isBusy(), false); assert.equal(h.control('chat-input').disabled, false);
  assert.equal(h.control('chat-send').disabled, false); assert.equal(h.control('chat-agent-select').disabled, false);
  assert.equal(h.calls.filter(call => call === 'open-room').length, 1); assert.equal(h.calls.includes('send'), false);
  h.chat.unmount();
});

test('a polling GET that sees the created conversation before its POST response cannot duplicate the conversation', async () => {
  const response = deferred(); let created = false;
  const newConversation = { id: 'one-web', title: '第一件生活事', endpointId: 'agent-a' };
  const h = harness(async (_path, data) => {
    if (data?.operation === 'open-room') { created = true; return response.promise; }
    const result = snapshot(); if (created) result.conversations.push(structuredClone(newConversation)); return result;
  });
  await ready(h);
  const opening = h.chat.open({ example, endpointId: 'agent-a' });
  await eventually(() => created); h.tick();
  await nextTurn();
  response.resolve(newConversation); await opening;
  assert.equal(h.calls.filter(call => call === 'open-room').length, 1);
  assert.deepEqual(selectedIds(h), ['one-web']); assert.equal(h.calls.includes('send'), false);
  h.chat.unmount();
});

test('downloading an earlier pairing configuration does not clear a subsequently edited workspace', async () => {
  const h = harness(async (_path, data) => data?.operation === 'pair' ? { token: 'FIXTURE_ONLY', endpointId: 'paired-fixture' } : snapshot(), {}, { view: 'settings' });
  await eventually(() => h.control('chat-endpoints').innerHTML.includes('测试执行端'));
  const form = h.control('chat-pair'), field = form.fields.workspace;
  h.root.emit('input', { target: field }); h.submit('chat-pair');
  await eventually(() => !h.chat.isBusy() && h.control('chat-pair-result').children.length > 0);
  assert.equal(h.chat.hasPendingDownload(), true);
  field.value = '/fixture/v2'; h.root.emit('input', { target: field });
  h.control('chat-pair-result').children[0].emit('click');
  assert.equal(h.chat.hasPendingDownload(), false);
  assert.equal(h.chat.isEditing(), true); assert.equal(field.value, '/fixture/v2');
  h.chat.unmount(); assert.equal(h.revoked.length, 1);
});

test('an invalid restored conversation ID keeps requiring a deliberate selection across polls and reloads', async () => {
  const h = harness(async () => snapshot(), { 'xiaoman-current-conversation': 'removed-conversation' });
  await eventually(() => h.control('chat-status').textContent.includes('这段聊天暂不可用'));
  assert.deepEqual(selectedIds(h), []); assert.equal(h.control('chat-input').disabled, true);
  assert.equal(h.control('chat-send').disabled, true); assert.equal(h.storage.get('xiaoman-needs-conversation-choice'), 'true');
  h.tick(); await nextTurn(); assert.deepEqual(selectedIds(h), []);
  const recovered = harness(async () => snapshot(), Object.fromEntries(h.storage));
  await nextTurn(); await nextTurn();
  assert.deepEqual(selectedIds(recovered), []); assert.equal(recovered.control('chat-input').disabled, true);
  assert.equal(recovered.calls.includes('send'), false);
  h.chat.unmount(); recovered.chat.unmount();
});

test('unmounting during preparation cannot leave a later mount permanently locked by the old finally', async () => {
  const oldRead = deferred(); let gets = 0;
  const h = harness(async (_path, data) => data ? { id: 'unexpected-new' } : ++gets === 2 ? oldRead.promise : snapshot());
  await ready(h);
  const opening = h.chat.open({ example, endpointId: 'agent-a' }); locked(h);
  h.chat.unmount(); h.mount(); await ready(h);
  oldRead.resolve(snapshot()); await opening;
  assert.equal(h.chat.isBusy(), false); assert.equal(h.control('chat-input').disabled, false);
  assert.equal(h.calls.includes('open-room'), false); assert.equal(h.calls.includes('send'), false);
  h.chat.unmount();
});

test('connection evidence gaps stay in management details without interrupting a usable chat', () => {
  const context = vm.createContext({ window: {} }); vm.runInContext(truthSource, context);
  const truth = { light: 'yellow', selectedEndpointId: 'agent', agents: [{ id: 'agent', online: true, authentication: 'verified', authorization: 'expiry_unknown', missingTools: [], canExecute: true, reasons: ['授权有效期未提供，无法提前判断临期'] }], attention: [{ kind: 'channel', reason: '微信尚未绑定到这段对话' }], channels: [{ id: 'weixin', configured: true, state: 'unknown' }] };
  const before = structuredClone(truth);
  assert.equal(context.window.PATruth.render(truth), '');
  const detail = context.window.PATruth.details(truth);
  assert.match(detail, /授权有效期未提供/); assert.match(detail, /expiry_unknown/);
  assert.match(detail, /^<details[^>]*><summary>连接诊断/);
  assert.deepEqual(truth, before, 'presentation must preserve the full evidence snapshot');
  truth.agents[0].authentication = 'unknown'; truth.agents[0].canExecute = false;
  assert.equal(context.window.PATruth.render(truth), '', 'aged login evidence is not itself a confirmed failure');
});

test('concrete execution, channel and local service failures retain a visible recovery action', () => {
  const context = vm.createContext({ window: {} }); vm.runInContext(truthSource, context);
  const base = { selectedEndpointId: 'agent', agents: [{ id: 'agent', online: true, authentication: 'verified', authorization: 'expiry_unknown', missingTools: [], canExecute: true }], channels: [] };
  for (const [change, message] of [
    [{ online: false }, /助手离线/], [{ authentication: 'required' }, /登录已失效/],
    [{ authentication: 'missing' }, /程序未安装/], [{ authorization: 'expired' }, /授权已过期/],
    [{ missingTools: ['xiaoman_tasks'] }, /缺少所需工具/],
  ]) {
    const output = context.window.PATruth.render({ ...base, agents: [{ ...base.agents[0], ...change }] });
    assert.match(output, message); assert.match(output, /href="#settings"/);
    assert.doesNotMatch(output, /授权有效期未提供/);
  }
  assert.match(context.window.PATruth.render({ ...base, channels: [{ id: 'weixin', configured: true, state: 'disconnected' }] }), /微信连接已断开/);
  assert.match(context.window.PATruth.render({ ...base, localServices: { items: [{ belongsToInstance: true, needsAttention: true, state: 'not_loaded', suggestion: '常驻服务尚未运行' }] } }), /常驻服务尚未运行/);
  assert.equal(context.window.PATruth.render({ ...base, localServices: { items: [{ belongsToInstance: false, needsAttention: true, state: 'not_loaded' }] } }), '');
});

test('settings renders channel failures and agent authentication without a message log or composer', async () => {
  const data = snapshot();
  data.truth = { channels: [{ id: 'imessage', configured: true, state: 'needs_attention' }], agents: [{ id: 'agent-a', authentication: 'required' }] };
  const h = harness(async () => data, {}, { view: 'settings' });
  await eventually(() => h.control('chat-channel-status').innerHTML.includes('需要处理'));
  assert.match(h.control('chat-endpoints').innerHTML, /需重新登录/);
  assert.equal(h.control('chat-messages'), undefined);
  assert.equal(h.control('chat-compose'), undefined);
  assert.equal(h.control('chat-runs'), undefined);
  h.chat.unmount();
});

test('settings polls device readiness independently of the previously selected conversation', async () => {
  const paths = [], data = snapshot();
  data.truth = { agents: [{ id: 'agent-a', online: true, authentication: 'verified', missingTools: [] }] };
  const h = harness(async path => { paths.push(path); return data; }, { 'xiaoman-current-conversation': 'old-im' }, { view: 'settings' });
  try {
    await eventually(() => h.control('chat-endpoints').innerHTML.includes('在线'));
    h.tick(); await nextTurn(); h.tick(); await nextTurn();
    assert.ok(paths.length >= 3);
    assert.ok(paths.every(path => path === 'hub'), JSON.stringify(paths));
    assert.doesNotMatch(h.control('chat-endpoints').innerHTML, /工具待验证/);
  } finally { h.chat.unmount(); }
});

test('a notebook conversation has no second directory or connection forms, and an execution error stays outside details', async () => {
  const data = snapshot(); data.runs = [{ id: 'failed', conversationId: 'old-im', status: 'failed', error: 'AGENT_TIMEOUT', createdAt: 1 }];
  const h = harness(async () => data);
  await ready(h);
  assert.equal(h.control('chat-conversations'), undefined);
  assert.equal(h.control('chat-pair'), undefined);
  assert.match(h.control('chat-run-notice').innerHTML, /执行超时/);
  assert.match(h.control('chat-run-notice').innerHTML, /data-retry-run="failed"/);
  assert.doesNotMatch(h.control('chat-run-notice').innerHTML, /<details/);
  h.chat.unmount();
});

test('a cancelled Bot child cannot hide the original task failure or its recovery action', async () => {
  const data = snapshot();
  data.runs = [
    { id: 'ask-root', conversationId: 'old-im', botId: 'research', status: 'failed', error: 'AGENT_EMPTY_REPLY', botTaskStopped: 'AGENT_EMPTY_REPLY', nextRunId: 'answer-child', createdAt: 1 },
    { id: 'answer-child', rootRunId: 'ask-root', conversationId: 'old-im', botId: 'maker', status: 'cancelled', createdAt: 2 },
  ];
  const h = harness(async () => data);
  try {
    await ready(h);
    assert.equal(h.control('chat-endpoint').innerHTML, '', 'No generic interruption banner');
    assert.match(h.control('chat-run-notice').innerHTML, /没有返回结果/);
    assert.match(h.control('chat-run-notice').innerHTML, /data-retry-run="ask-root"/);
    assert.equal(h.control('chat-run-counts').innerHTML, '', 'Internal steps are not pending task counts');
    assert.equal((h.control('chat-runs').innerHTML.match(/class="chat-tracked-run/g) || []).length, 1);
  } finally { h.chat.unmount(); }
});

test('a partially completed Bot chain can recover the original draft without sending automatically', async () => {
  const data = snapshot();
  data.messages = [{ id: 'original', conversationId: 'old-im', role: 'user', text: '@research @maker 整理这份材料', createdAt: 1 }];
  data.runs = [{ id: 'partial-root', conversationId: 'old-im', messageId: 'original', botId: 'research', status: 'completed', botTaskStopped: 'BOT_MEMBER_PARTIAL', createdAt: 1 }];
  const h = harness(async () => data);
  try {
    await ready(h);
    const button = new Element('button', 'test-retry');
    button.dataset.retryRun = 'partial-root'; button.closest = () => button;
    h.root.nodes.set(button.id, button);
    h.root.emit('click', { target: button });
    await eventually(() => h.control('chat-input').value === data.messages[0].text);
    assert.equal(h.calls.includes('send'), false);
    assert.match(h.control('chat-messages').innerHTML, /未完成部分/);
    assert.equal(h.control('chat-run-notice').innerHTML, '');
  } finally { h.chat.unmount(); }
});

test('a queued internal reply cannot hide an uncertain sender that needs user attention', async () => {
  const data = snapshot();
  data.runs = [
    { id: 'uncertain-root', conversationId: 'old-im', status: 'uncertain', nextRunId: 'waiting-answer', createdAt: 1 },
    { id: 'waiting-answer', rootRunId: 'uncertain-root', conversationId: 'old-im', status: 'queued', createdAt: 2 },
  ];
  const h = harness(async () => data);
  try {
    await ready(h);
    assert.equal(h.control('chat-endpoint').innerHTML, '');
    assert.match(h.control('chat-run-notice').innerHTML, /data-id="uncertain-root"/);
    assert.match(h.control('chat-run-notice').innerHTML, /未自动重发/);
  } finally { h.chat.unmount(); }
});


test('iMessage pairing requires its own deliberate conversation choice and preserves it across polls', async () => {
  const data = snapshot([{ id: 'old-im', title: '微信对话', endpointId: 'agent-a' }, { id: 'chosen-im', title: 'iMessage 对话', endpointId: 'agent-a' }]);
  let paired;
  const h = harness(async (_path, request) => {
    if (request?.operation === 'pair-channel') { paired = request; return { token: 'FIXTURE_ONLY', channelId: 'fixture-channel' }; }
    return data;
  }, {}, { view: 'settings' });
  await eventually(() => h.control('chat-endpoints').innerHTML.includes('测试执行端'));
  assert.equal(h.control('chat-channel-conversation').value, '');
  h.submit('chat-channel-pair');
  await eventually(() => !h.chat.isBusy());
  assert.equal(paired, undefined, 'An existing WeChat selection cannot silently bind iMessage');
  assert.match(h.control('chat-status').textContent, /请选择要接收 iMessage/);
  h.control('chat-channel-conversation').value = 'chosen-im';
  h.root.emit('change', { target: h.control('chat-channel-conversation') });
  h.tick(); await nextTurn();
  assert.equal(h.control('chat-channel-conversation').value, 'chosen-im');
  h.submit('chat-channel-pair');
  await eventually(() => paired && !h.chat.isBusy());
  assert.equal(paired.conversationId, 'chosen-im');
  assert.equal(h.chat.hasPendingDownload(), true);
  h.chat.unmount();
});

test('message ordering uses trusted effective time and sequence, while assistant attribution is not delivery', async () => {
  const data = snapshot(), at = Date.parse('2026-10-28T02:00:00Z');
  data.messages = [
    { id: 'later', conversationId: 'old-im', role: 'user', text: '相同正文', effectiveAt: at + 2000, appendSeq: 1, origin: { channel: 'weixin' } },
    { id: 'tie-b', conversationId: 'old-im', role: 'user', text: '第二条', effectiveAt: at, appendSeq: 3, origin: { channel: 'imessage' } },
    { id: 'tie-a', conversationId: 'old-im', role: 'user', text: '第一条', effectiveAt: at, appendSeq: 2, origin: { channel: 'web' } },
    { id: 'internal', conversationId: 'old-im', role: 'assistant', text: '内部回复', effectiveAt: at + 3000, appendSeq: 4, channel: 'weixin', botId: 'agent-b' },
    { id: 'outbox', conversationId: 'old-im', role: 'assistant', text: '外部结果', effectiveAt: at + 4000, appendSeq: 5, botId: 'xiaoman', delivery: { channel: 'imessage', state: 'unknown' } },
  ];
  const h = harness(async () => data);
  try {
    await ready(h);
    assert.equal(h.control('chat-messages').dataset.messageIds, 'tie-a tie-b later internal outbox');
    const html = h.control('chat-messages').innerHTML;
    assert.match(html, /<time datetime="2026-10-28T/);
    const internal = html.split('id="chat-message-internal"')[1].split('</article>')[0];
    assert.match(internal, /微信交代/); assert.doesNotMatch(internal, /回微信|送达|已发送/);
    assert.match(html.split('id="chat-message-outbox"')[1], /回iMessage[\s\S]*发送结果未知/);
  } finally { h.chat.unmount(); }
});

test('a late message preserves the visible reading anchor, and exact reveal distinguishes equal text', async () => {
  const data = snapshot(), at = Date.parse('2026-10-28T02:00:00Z');
  data.messages = Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, conversationId: 'old-im', role: i === 3 ? 'assistant' : 'user', text: '完全相同', effectiveAt: at + i * 1000, appendSeq: i + 1 }));
  const h = harness(async () => data);
  try {
    await ready(h); const list = h.control('chat-messages'); list.clientHeight = 100; list.scrollTop = 200; list.emit('scroll');
    const reading = h.chat.captureReadingPosition(); assert.equal(reading.messageId, 'm2');
    data.messages.push({ id: 'late', conversationId: 'old-im', role: 'user', text: '迟到的消息', effectiveAt: at - 1000, appendSeq: 7 });
    h.tick(); await eventually(() => list.dataset.messageIds.startsWith('late'));
    assert.equal(list.scrollTop, 300); assert.equal(h.chat.captureReadingPosition().messageId, 'm2');
    assert.equal(await h.chat.revealMessage({ conversationId: 'old-im', messageId: 'm3' }), true);
    assert.equal(h.control('chat-message-m3').focusCount, 1); assert.equal(list.scrollTop, 400);
    assert.equal(h.control('chat-message-m0').focusCount, undefined);
    h.tick(); await nextTurn(); assert.equal(list.scrollTop, 400, 'poll must not return to the newest message');
  } finally { h.chat.unmount(); }
});

test('old original lookup requires the exact ID and room, never a similar or latest message', async () => {
  const data = snapshot(), at = Date.now(), requests = [];
  data.messages = [{ id: 'latest', conversationId: 'old-im', role: 'user', text: '一样', createdAt: at }];
  const h = harness(async path => {
    requests.push(path);
    if (path.startsWith('hub/message?')) return { conversationId: 'old-im', resolvedConversationId: 'old-im', message: { id: 'archived', conversationId: 'old-im', role: 'assistant', text: '一样', createdAt: at - 5000 } };
    return data;
  });
  try {
    await ready(h); h.control('chat-input').value = '未发草稿';
    assert.equal(await h.chat.revealMessage({ messageId: 'archived' }), true);
    assert.equal(h.control('chat-message-archived').focusCount, 1); assert.equal(h.control('chat-input').value, '未发草稿');
    const scroll = h.control('chat-messages').scrollTop;
    assert.equal(await h.chat.revealMessage({ messageId: 'missing' }), false);
    assert.equal(h.control('chat-messages').scrollTop, scroll); assert.match(h.control('chat-status').textContent, /未跳到其他消息/);
    assert.ok(requests.includes('hub/message?messageId=archived'));
  } finally { h.chat.unmount(); }
});

test('suggested guide drafts wait for explicit append and keep verified references across reload', async () => {
  const data = snapshot(); let sent;
  const transport = async (_path, request) => { if (request?.operation === 'send') { sent = request; return {}; } return data; };
  const h = harness(transport);
  await ready(h); h.control('chat-input').value = '原来的草稿'; h.root.emit('input', { target: h.control('chat-input') });
  await h.chat.open({ conversationId: 'old-im', draft: '整理这份已授权资料', guideSourceId: 'guide-1' });
  assert.equal(h.control('chat-input').value, '原来的草稿'); assert.equal(h.control('chat-draft-suggestion').hidden, false); assert.equal(sent, undefined);
  const button = new Element('button'); button.dataset.chatAction = 'append-draft'; button.closest = () => button;
  h.root.emit('click', { target: button }); assert.equal(h.control('chat-input').value, '原来的草稿\n\n整理这份已授权资料');
  const saved = Object.fromEntries(h.storage); h.chat.unmount();
  const reloaded = harness(transport, saved);
  try {
    await ready(reloaded); assert.equal(sent, undefined); reloaded.submit('chat-compose');
    await eventually(() => sent && !reloaded.chat.isBusy());
    assert.equal(sent.guideSourceId, 'guide-1'); assert.equal(sent.content, '原来的草稿\n\n整理这份已授权资料');
  } finally { reloaded.chat.unmount(); }
});

test('owner channel unification is an explicit confirmed action, not a side effect of displaying a binding', async () => {
  const data = snapshot(); data.bindings = [{ id: 'binding-1', channel: 'weixin', account: 'account-1', peer: 'fixture-peer', conversationId: 'old-im', ownerVerified: false }];
  const posted = []; const h = harness(async (_path, request) => { if (request) posted.push(request); return data; }, {}, { view: 'settings' });
  try {
    await eventually(() => h.control('chat-weixin-bindings').innerHTML.includes('这是我本人'));
    assert.equal(posted.length, 0); const button = new Element('button'); button.dataset = { chatAction: 'verify-owner-route', id: 'binding-1' }; button.closest = () => button;
    h.root.emit('click', { target: button }); await eventually(() => !h.chat.isBusy()); assert.equal(posted.length, 0);
    assert.match(h.confirmations[0], /共享 Mori 私聊和上下文/); h.allowConfirm();
    h.root.emit('click', { target: button }); await eventually(() => posted.length === 1);
    assert.equal(posted[0].operation, 'verify-owner-route'); assert.equal(posted[0].bindingId, 'binding-1');
  } finally { h.chat.unmount(); }
});

test('a recovery keeps its actions without repeating the exact summary already in its message', async () => {
  const data = snapshot(), summary = '已收到阿探的检查结果。校对员还没有完成核对，因此这件事尚未完成。';
  data.runs = [{ id: 'partial-root', conversationId: 'old-im', messageId: 'input', status: 'completed', createdAt: 1, report: { outcome: 'partial', summary } }];
  data.messages = [{ id: 'reply', conversationId: 'old-im', runId: 'partial-root', role: 'assistant', text: summary, createdAt: 2 }];
  const h = harness(async () => data);
  try {
    await ready(h); const html = h.control('chat-messages').innerHTML;
    assert.equal(html.split(summary).length - 1, 1, 'The historical body remains the single complete explanation');
    assert.match(html, /data-retry-run="partial-root"/);
    assert.match(html, /class="chat-message-recovery" role="status"><button/);
    assert.equal(h.control('chat-run-notice').innerHTML, '');
  } finally { h.chat.unmount(); }
});

test('recovery retains a different gap and does not deduplicate against another message', async () => {
  for (const text of ['已收到阿探的检查结果。', '检查结果已保存。']) {
    const data = snapshot(), gap = '还缺发票附件，不能完成核对。';
    data.runs = [{ id: 'partial-root', conversationId: 'old-im', messageId: 'input', status: 'completed', createdAt: 1, report: { outcome: 'partial', summary: gap } }];
    data.messages = [
      { id: 'unrelated', conversationId: 'old-im', role: 'assistant', text: gap, createdAt: 1 },
      { id: 'reply', conversationId: 'old-im', runId: 'partial-root', role: 'assistant', text, createdAt: 2 },
    ];
    const h = harness(async () => data);
    try {
      await ready(h); const reply = h.control('chat-messages').innerHTML.split('id="chat-message-reply"')[1];
      assert.match(reply, /<p>还缺发票附件，不能完成核对。<\/p>/);
      assert.match(reply, /data-retry-run="partial-root"/);
    } finally { h.chat.unmount(); }
  }
});

test('the running header shows a concise host stage while keeping full reported progress in task details', async () => {
  const data = snapshot(), summary = '已核对当前六位成员，并正在逐个整理他们的职责、近期进度和可继续推进的事情。';
  data.runs = [{ id: 'working', conversationId: 'old-im', status: 'running', createdAt: 1, progress: { stage: 'reported', label: summary, elapsedSeconds: 20 }, report: { outcome: 'in_progress', summary } }];
  const h = harness(async () => data);
  try {
    await ready(h); assert.match(h.control('chat-endpoint').innerHTML, />正在处理</);
    assert.doesNotMatch(h.control('chat-endpoint').innerHTML, /六位成员/); assert.match(h.control('chat-runs').innerHTML, /当前六位成员/);
    data.runs[0].progress = { stage: 'reading_sources', label: '很长的资料说明不应成为顶部横幅', elapsedSeconds: 21 };
    h.tick(); await eventually(() => h.control('chat-endpoint').innerHTML.includes('正在读取资料'));
    assert.equal(h.control('chat-run-notice').innerHTML, '');
  } finally { h.chat.unmount(); }
});

test('host failure codes have readable recovery reasons while unknown codes stay in execution details', async () => {
  for (const [code, readable] of [['AGENT_TURN_FAILED', /未能完成这一轮/], ['AGENT_RATE_LIMITED', /额度或频率限制/], ['AGENT_NEW_FAILURE', /这次处理未完成/]]) {
    const data = snapshot();
    data.runs = [{ id: 'failed-run', conversationId: 'old-im', status: 'failed', error: code, createdAt: 1 }];
    const original = `历史原文保留：${code}`;
    data.messages = [{ id: 'failed-reply', conversationId: 'old-im', role: 'assistant', runId: 'failed-run', text: original, createdAt: 2 }];
    const h = harness(async () => data);
    try {
      await ready(h); const messages = h.control('chat-messages').innerHTML;
      assert.ok(messages.includes(original), 'Historical assistant text must not be rewritten');
      const recovery = messages.split('class="chat-message-recovery"')[1];
      assert.match(recovery, readable); assert.ok(!recovery.includes(code)); assert.match(recovery, /data-retry-run="failed-run"/);
      const records = h.control('chat-runs').innerHTML, [normal, detail] = records.split('id="run-detail-failed-run"');
      assert.ok(!normal.includes(code)); assert.ok(detail.includes(`<code>${code}</code>`)); assert.match(detail, /hidden/);
    } finally { h.chat.unmount(); }
  }
});

test('actual host origin projections render group IM and addressed private replies without inventing delivery for internal steps', async () => {
  const rooms = [{ id: 'group', title: '全员群', botId: 'xiaoman', roomKind: 'group' }, { id: 'direct', title: '阿探', botId: 'agent-b', roomKind: 'direct' }];
  const data = snapshot(rooms), at = Date.parse('2026-10-28T13:41:00Z');
  const wx = { channel: 'weixin', account: 'fixture-account', peer: 'fixture-owner', sourceMessageId: 'wx-fixture', occurredAt: at };
  const im = { channel: 'imessage', account: 'fixture-channel', peer: 'fixture-owner', sourceMessageId: 'im-fixture', occurredAt: at + 1000 };
  const deliveries = new Map([
    ['group-answer', { state: 'sent', source: wx }],
    ['direct-answer', { state: 'unknown', source: im }],
  ]);
  const projectedHost = { get: (kind, id) => kind === 'delivery' ? deliveries.get(id) : undefined, resolveConversationId: id => id === 'old-group' ? 'group' : id };
  // Fixture records pass through the production host projection. This is not
  // evidence of a live IM receipt and never contacts either messaging service.
  const rows = [
    { id: 'group-input', conversationId: 'old-group', role: 'user', text: '帮我安排今天的事项', source: wx },
    { id: 'group-answer', conversationId: 'group', role: 'assistant', botId: 'xiaoman', text: '群聊的总管回报', source: wx },
    { id: 'group-internal', conversationId: 'group', role: 'assistant', botId: 'agent-b', text: '成员内部进展', source: wx },
    { id: 'direct-input', conversationId: 'direct', role: 'user', text: '@research 核实这份资料', source: im },
    { id: 'direct-answer', conversationId: 'direct', role: 'assistant', botId: 'agent-b', text: '定向私聊结果', source: im },
  ];
  data.messages = rows.map((row, index) => projectMessage(projectedHost, { ...row, ...messageTimes(row.source, at + 5000 + index), createdAt: at + 5000 + index, appendSeq: index + 1 }));
  const h = harness(async () => data, {}, { conversationId: 'group', roomKind: 'group' });
  try {
    await ready(h); const group = h.control('chat-messages').innerHTML;
    assert.match(group.split('id="chat-message-group-input"')[1].split('</article>')[0], /微信/);
    assert.match(group.split('id="chat-message-group-answer"')[1].split('</article>')[0], /回微信[\s\S]*已发送/);
    assert.match(group.split('id="chat-message-group-internal"')[1].split('</article>')[0], /微信交代/);
    assert.doesNotMatch(group.split('id="chat-message-group-internal"')[1].split('</article>')[0], /回微信|已发送|送达/);
    assert.doesNotMatch(group, /定向私聊结果/);
    h.mount({ conversationId: 'direct', roomKind: 'direct', botId: 'agent-b' }); await ready(h);
    const direct = h.control('chat-messages').innerHTML;
    assert.match(direct, /@research 核实这份资料/); assert.match(direct, /回iMessage[\s\S]*发送结果未知/);
    assert.doesNotMatch(direct, /群聊的总管回报|微信/);
  } finally { h.chat.unmount(); }
});

test('IM bubbles expose text and generic channel marks, with actual delivery errors and unknown times retained', async () => {
  const data = snapshot(), at = Date.parse('2026-10-28T13:41:00Z');
  data.messages = [
    { id: 'wx', conversationId: 'old-im', role: 'user', text: '微信交代', origin: { channel: 'weixin' }, effectiveAt: at, appendSeq: 1 },
    { id: 'im', conversationId: 'old-im', role: 'user', text: '信息交代', origin: { channel: 'imessage' }, effectiveAt: at + 1, appendSeq: 2 },
    { id: 'reply', conversationId: 'old-im', role: 'assistant', botId: 'xiaoman', text: '真实失败回报', origin: { channel: 'weixin' }, effectiveAt: at + 2, appendSeq: 3, delivery: { channel: 'weixin', state: 'failed' } },
    { id: 'unknown-time', conversationId: 'old-im', role: 'assistant', botId: 'xiaoman', text: '原渠道的历史结果', origin: { channel: 'imessage' }, effectiveAt: null, appendSeq: 4 },
  ];
  const h = harness(async () => data);
  try {
    await ready(h); const html = h.control('chat-messages').innerHTML;
    const bubble = id => html.split(`id="chat-message-${id}"`)[1].split('</article>')[0];
    assert.match(bubble('wx'), /data-channel="weixin"[\s\S]*chat-channel-icon[\s\S]*<span>微信<\/span>/);
    assert.match(bubble('im'), /data-channel="imessage"[\s\S]*chat-channel-icon[\s\S]*<span>iMessage<\/span>/);
    assert.match(bubble('wx'), /aria-hidden="true" focusable="false"/);
    assert.match(bubble('reply'), /回微信[\s\S]*needs-attention[\s\S]*发送失败，请检查连接/);
    assert.match(bubble('unknown-time'), /iMessage交代[\s\S]*时间未知/);
    assert.doesNotMatch(bubble('unknown-time'), /回iMessage|已发送|1970/);
    assert.doesNotMatch(html, /logo|微信官方|apple\.com|weixin\.qq/);
  } finally { h.chat.unmount(); }
});
