import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const truthSource = await readFile(new URL('../plugins/webui/public/truth.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../plugins/webui/public/chat.js', import.meta.url), 'utf8');
const example = '帮我准备生日聚会，先确认日期、人数和预算。';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const snapshot = (conversations = [{ id: 'old-im', title: '原来的手机对话', endpointId: 'agent-a' }]) => ({
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
  querySelectorAll(selector) { return this.children.filter(node => node.tagName.toLowerCase() === selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return selector === 'form' ? this.form : selector === '.chat-center' ? this.section : null; }
  focus() { this.focusCount = (this.focusCount || 0) + 1; }
  scrollIntoView() {}
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
    return selector.startsWith('#') ? this.nodes.get(selector.slice(1)) : null;
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
  let nextInterval = 0, nextBlob = 0;
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
    setInterval: fn => { intervals.set(++nextInterval, fn); return nextInterval; }, clearInterval: id => intervals.delete(id),
    confirm: () => false, CSS: { escape: value => value },
  });
  vm.runInContext(truthSource, context);
  vm.runInContext(source, context, { filename: 'production-chat.js' });
  const chat = context.window.PAChat;
  const api = async (path, data) => { calls.push(data?.operation || 'GET'); return transport(path, data); };
  const mount = (options = initialOptions) => chat.mount({ root, api, runtime: { accounts: [] }, localAgentAvailable: false, ...options });
  mount();
  return { chat, root, calls, storage, revoked, mount,
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
  assert.equal(h.calls.includes('send'), false); assert.equal(h.calls.includes('new'), false);
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

test('a delayed new-conversation POST keeps sending disabled and restores editing only after the new draft exists', async () => {
  const created = deferred();
  const h = harness(async (_path, data) => data?.operation === 'new' ? created.promise : snapshot());
  await ready(h);
  const opening = h.chat.open({ example, endpointId: 'agent-a' });
  await eventually(() => h.calls.includes('new'));
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
    assert.equal(data.endpointId, 'agent-b', 'manual retry must retain the explicitly selected Agent');
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

test('a failed new-conversation POST releases the lock and leaves the original IM draft unsent', async () => {
  const h = harness(async (_path, data) => {
    if (data?.operation === 'new') throw new Error('新对话创建尚未成功');
    return snapshot();
  });
  await ready(h); h.control('chat-input').value = '旧对话里需要保留的交代';
  await assert.rejects(h.chat.open({ example, endpointId: 'agent-a' }), /创建尚未成功/);
  assert.deepEqual(selectedIds(h), ['old-im']); assert.equal(h.control('chat-input').value, '旧对话里需要保留的交代');
  assert.equal(h.chat.isBusy(), false); assert.equal(h.control('chat-input').disabled, false);
  assert.equal(h.control('chat-send').disabled, false); assert.equal(h.control('chat-agent-select').disabled, false);
  assert.equal(h.calls.filter(call => call === 'new').length, 1); assert.equal(h.calls.includes('send'), false);
  h.chat.unmount();
});

test('a polling GET that sees the created conversation before its POST response cannot duplicate the conversation', async () => {
  const response = deferred(); let created = false;
  const newConversation = { id: 'one-web', title: '第一件生活事', endpointId: 'agent-a' };
  const h = harness(async (_path, data) => {
    if (data?.operation === 'new') { created = true; return response.promise; }
    const result = snapshot(); if (created) result.conversations.push(structuredClone(newConversation)); return result;
  });
  await ready(h);
  const opening = h.chat.open({ example, endpointId: 'agent-a' });
  await eventually(() => created); h.tick();
  await nextTurn();
  response.resolve(newConversation); await opening;
  assert.equal(h.calls.filter(call => call === 'new').length, 1);
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
  await eventually(() => h.control('chat-status').textContent.includes('上次对话'));
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
  assert.equal(h.calls.includes('new'), false); assert.equal(h.calls.includes('send'), false);
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
