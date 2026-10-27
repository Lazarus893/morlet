import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../plugins/webui/public/first-task.js', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[value]);

// A small DOM for the actual production event handlers and keyed reconciliation.
// Layout, browser accessibility and rendering are verified separately in CUA.
class Node {
  constructor(tag = null, data = '') { this.nodeType = tag ? 1 : 3; this.tagName = tag?.toUpperCase(); this.data = data; this.childNodes = []; this.parentNode = null; this.attrs = new Map(); this.handlers = new Map(); this.root = false; this.open = false; this.disabled = false; this.selectionStart = 0; this.selectionEnd = 0; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get id() { return this.getAttribute('id') || ''; }
  get dataset() { return new Proxy({}, { get: (_, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())), set: (_, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase()), String(value)); return true; } }); }
  get isConnected() { return this.root || !!this.parentNode?.isConnected; }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); if (name === 'disabled') this.disabled = true; if (name === 'open') this.open = true; }
  removeAttribute(name) { this.attrs.delete(name); if (name === 'disabled') this.disabled = false; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(n => n.textContent).join(''); }
  get value() { return this._value ?? this.textContent; }
  set value(value) { this._value = String(value); }
  get innerHTML() { return this.childNodes.map(n => n.nodeType === 3 ? n.data : '<' + n.tagName + [...n.attrs].map(([k, v]) => ' ' + k + '="' + v + '"').join('') + '>' + n.innerHTML + '</' + n.tagName + '>').join(''); }
  set innerHTML(html) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = []; const stack = [this];
    for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = token.match(/^<(\w+)/)?.[1]; if (!tag) continue;
        const node = new Node(tag);
        for (const a of token.slice(tag.length + 1, -1).matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) node.setAttribute(a[1], decode(a[2] || ''));
        stack.at(-1).insertBefore(node, null);
        if (!['input', 'br', 'hr', 'img'].includes(tag)) stack.push(node);
      } else stack.at(-1).insertBefore(new Node(null, decode(token)), null);
    }
  }
  insertBefore(node, before) { node.remove(); const index = before ? this.childNodes.indexOf(before) : -1; node.parentNode = this; if (index < 0) this.childNodes.push(node); else this.childNodes.splice(index, 0, node); }
  remove() { if (this.parentNode) { const index = this.parentNode.childNodes.indexOf(this); if (index >= 0) this.parentNode.childNodes.splice(index, 1); this.parentNode = null; } }
  cloneNode(deep) { const node = new Node(this.tagName, this.data); for (const [name, value] of this.attrs) node.setAttribute(name, value); if (deep) for (const child of this.childNodes) node.insertBefore(child.cloneNode(true), null); return node; }
  matches(selector) { if (selector.startsWith('#')) return this.id === selector.slice(1); if (selector.startsWith('.')) return (this.getAttribute('class') || '').split(' ').includes(selector.slice(1)); if (selector === 'details[open]') return this.tagName === 'DETAILS' && this.open; const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/); if (attr) return attr[2] === undefined ? this.hasAttribute(attr[1]) : this.getAttribute(attr[1]) === attr[2]; return this.tagName === selector.toUpperCase(); }
  querySelectorAll(selector) { const out = []; const walk = parent => { for (const child of parent.childNodes) { if (child.nodeType !== 1) continue; if (child.matches(selector)) out.push(child); walk(child); } }; walk(this); return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  addEventListener(type, fn, options = {}) { const all = this.handlers.get(type) || new Set(); all.add(fn); this.handlers.set(type, all); options.signal?.addEventListener('abort', () => all.delete(fn)); }
  emit(type, target = this) { for (const fn of this.handlers.get(type) || []) fn({ target, preventDefault() {}, stopPropagation() {} }); }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  animate() {}
}

const initialFlow = overrides => ({ id: 'flow-one', version: 1, stage: 'draft', draft: '', runIds: [], questions: [], proposal: null, itemRecords: [], approvals: [], design: { state: 'not_requested' }, ...overrides });
function harness({ flow = initialFlow(), cache = null, transport, agents = { preferredEndpointId: 'chief', endpoints: [{ id: 'chief', label: '测试管家', online: true }] } } = {}) {
  const root = new Node('div'); root.root = true;
  const document = { body: new Node('body'), documentElement: new Node('html'), hidden: false, createElement: tag => { const node = new Node(tag); node.document = document; return node; } }; document.activeElement = document.body;
  const inheritedDocument = Object.getOwnPropertyDescriptor(Node.prototype, 'document');
  if (!inheritedDocument) Object.defineProperty(Node.prototype, 'document', { get() { return this._document || this.parentNode?.document; }, set(value) { this._document = value; }, configurable: true });
  root.document = document;
  const storage = new Map(cache ? [['pa:first-task:pending-v1', JSON.stringify(cache)]] : []), timeouts = new Map(), intervals = new Map(), calls = [], navigations = [];
  let timerId = 0, serverFlow = copy(flow), requestCount = 0;
  const snapshot = () => ({ flow: copy(serverFlow), currentFlowId: serverFlow?.id || null, agents: copy(agents), history: [] });
  const mutate = input => {
    if (!serverFlow) serverFlow = initialFlow();
    if (input.operation === 'draft') serverFlow = { ...serverFlow, version: serverFlow.version + 1, draft: input.text, lastDraftRequest: { requestId: input.requestId } };
    else if (input.operation === 'start' || input.operation === 'send') serverFlow = { ...serverFlow, version: serverFlow.version + 1, draft: '', currentRunId: 'run-' + ++requestCount, runIds: [...serverFlow.runIds, 'run-' + requestCount], stage: 'queued', runSummary: { status: 'queued' }, lastRequest: { requestId: input.requestId, operation: input.operation } };
    else if (input.operation === 'confirm') serverFlow = { ...serverFlow, version: serverFlow.version + 1, stage: 'saving', runSummary: { status: 'running' }, lastRequest: { requestId: input.requestId, operation: input.operation } };
    return snapshot();
  };
  const context = vm.createContext({ window: {}, document, crypto: webcrypto, AbortController, matchMedia: () => ({ matches: false }), localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, location: { reload() {} }, setTimeout: fn => { timeouts.set(++timerId, fn); return timerId; }, clearTimeout: id => timeouts.delete(id), setInterval: fn => { intervals.set(++timerId, fn); return timerId; }, clearInterval: id => intervals.delete(id) });
  vm.runInContext(source, context, { filename: 'production-first-task.js' });
  const ui = context.window.PAFirstTask;
  const api = async (path, input) => { calls.push({ path, input: input && copy(input) }); return transport ? transport(path, input, { snapshot, mutate }) : input ? mutate(input) : snapshot(); };
  const mount = () => ui.mount({ root, api, navigate(route) { navigations.push(copy(route)); } }); mount();
  return { ui, root, calls, storage, navigations, mount, snapshot, mutate, setFlow: value => { serverFlow = copy(value); }, getFlow: () => copy(serverFlow), input: value => { const node = root.querySelector('#ft-draft'); assert.ok(node, 'expected composer'); node.value = value; node.selectionStart = node.selectionEnd = value.length; node.focus(); root.emit('input', node); }, click: id => { const node = root.querySelector('#' + id); assert.ok(node, id + ' exists'); assert.equal(node.disabled, false, id + ' is enabled'); root.emit('click', node); }, tick: () => { for (const fn of intervals.values()) fn(); } };
}
async function eventually(check) { for (let i = 0; i < 60; i++) { if (check()) return; await nextTurn(); } assert.fail('Expected production handler state was not reached'); }

test('natural example fills and saves only draft; start requires explicit click', async () => {
  const h = harness(); await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…');
  h.click('ft-example-plan'); assert.equal(h.root.querySelector('#ft-draft').value, '我有一件一直挂心、还没开始的事，帮我找到今天能做的第一步');
  assert.equal(h.calls.filter(c => c.input?.operation === 'start').length, 0);
  await h.ui.flushDraft(); assert.equal(h.ui.isEditing(), false);
  h.click('ft-submit'); await eventually(() => h.getFlow().stage === 'queued');
  assert.equal(h.calls.filter(c => c.input?.operation === 'start').length, 1);
  assert.equal(h.getFlow().runIds.length, 1);
});

test('draft text with trailing whitespace is preserved and flush completes', async () => {
  const h = harness(); await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…');
  h.input('生日准备  \n'); assert.equal(await h.ui.flushDraft(), true);
  assert.equal(h.getFlow().draft, '生日准备  \n'); assert.equal(h.ui.isEditing(), false);
});

test('typing during slow autosave keeps new text and serially saves it', async () => {
  const slow = deferred(); let drafts = 0;
  const h = harness({ transport: (path, input, server) => input?.operation === 'draft' && ++drafts === 1 ? slow.promise.then(() => server.mutate(input)) : input ? server.mutate(input) : server.snapshot() });
  await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…'); h.input('周日生日'); const saving = h.ui.flushDraft();
  await eventually(() => h.ui.isBusy()); h.input('周日生日，6个人'); slow.resolve();
  assert.equal(await saving, true); assert.equal(h.getFlow().draft, '周日生日，6个人');
  assert.equal(h.root.querySelector('#ft-draft').value, '周日生日，6个人'); assert.equal(h.calls.filter(c => c.input?.operation === 'draft').length, 2);
});

test('CAS conflict preserves input and requires explicit save after reading latest', async () => {
  let conflict = true;
  const h = harness({ transport: (path, input, server) => { if (input?.operation === 'draft' && conflict) { conflict = false; throw Object.assign(new Error('changed'), { code: 'VERSION_CONFLICT' }); } return input ? server.mutate(input) : server.snapshot(); } });
  await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…'); h.input('我的补充'); assert.equal(await h.ui.flushDraft(), false);
  assert.equal(h.root.querySelector('#ft-draft').value, '我的补充'); h.tick(); await nextTurn();
  assert.equal(h.calls.filter(c => c.input?.operation === 'draft').length, 1);
  h.click('ft-draft-retry'); await eventually(() => h.getFlow().draft === '我的补充' && !h.ui.isEditing());
});

test('cached draft restores only its exact flow and is not lost on mount/unmount', async () => {
  const h = harness({ cache: { flowId: 'flow-one', draft: '中断前的交代', dirty: true } });
  await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…'); assert.equal(h.root.querySelector('#ft-draft').value, '中断前的交代');
  await h.ui.flushDraft(); h.ui.unmount(); h.mount(); await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…');
  assert.equal(h.root.querySelector('#ft-draft').value, '中断前的交代');
});

test('different-flow browser draft never automatically overwrites current flow', async () => {
  const h = harness({ cache: { flowId: 'old-flow', draft: '原生日交代', dirty: true }, flow: initialFlow({ id: 'new-flow', draft: '另一端的新安排' }) });
  await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…'); h.tick(); await nextTurn();
  assert.equal(h.getFlow().draft, '另一端的新安排'); assert.equal(h.calls.filter(c => c.input).length, 0);
  assert.ok(h.root.querySelector('#ft-draft-retry')); assert.ok(h.root.querySelector('#ft-draft-discard'));
  h.click('ft-draft-discard'); assert.equal(h.root.querySelector('#ft-draft').value, '另一端的新安排'); assert.equal(h.ui.isEditing(), false);
});

test('lost start receipt is read back without automatically sending again', async () => {
  const h = harness({ transport: (path, input, server) => { if (input?.operation === 'start') { server.mutate(input); throw Object.assign(new Error('lost response'), { code: 'UNAVAILABLE' }); } return input ? server.mutate(input) : server.snapshot(); } });
  await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…'); h.input('帮我准备周日的生日'); await h.ui.flushDraft(); h.click('ft-submit');
  await eventually(() => !h.ui.isBusy()); h.tick(); await nextTurn();
  assert.equal(h.calls.filter(c => c.input?.operation === 'start').length, 1); assert.equal(h.getFlow().runIds.length, 1);
  assert.equal(h.root.querySelector('#ft-request-retry'), null);
});

test('unreceived request needs explicit retry using the exact same payload and nonce', async () => {
  let rejected = false;
  const h = harness({ transport: (path, input, server) => { if (input?.operation === 'start' && !rejected) { rejected = true; throw Object.assign(new Error('never reached server'), { code: 'UNAVAILABLE' }); } return input ? server.mutate(input) : server.snapshot(); } });
  await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…'); h.input('帮我准备周日的生日'); await h.ui.flushDraft(); h.click('ft-submit');
  await eventually(() => !h.ui.isBusy() && h.root.querySelector('#ft-request-retry'));
  const original = h.calls.find(c => c.input?.operation === 'start').input; h.tick(); await nextTurn();
  assert.equal(h.calls.filter(c => c.input?.operation === 'start').length, 1);
  h.click('ft-request-retry'); await eventually(() => h.getFlow().stage === 'queued');
  assert.deepEqual(h.calls.filter(c => c.input?.operation === 'start')[1].input, original); assert.equal(h.getFlow().runIds.length, 1);
});

test('explicit retry response preserves a new unsent supplement', async () => {
  let failed = false; const retry = deferred();
  const h = harness({ transport: (path, input, server) => { if (input?.operation === 'start') { if (!failed) { failed = true; throw Object.assign(new Error('network'), { code: 'UNAVAILABLE' }); } return retry.promise.then(() => server.mutate(input)); } return input ? server.mutate(input) : server.snapshot(); } });
  await eventually(() => h.root.querySelector('#ft-draft-status')?.textContent !== '正在读取…'); h.input('帮我准备周日的生日'); await h.ui.flushDraft(); h.click('ft-submit');
  await eventually(() => !h.ui.isBusy() && h.root.querySelector('#ft-request-retry')); h.input('补充：预算600元'); h.click('ft-request-retry'); retry.resolve();
  await eventually(() => !h.ui.isBusy()); assert.equal(h.ui.isEditing(), true);
  const cache = JSON.parse(h.storage.get('pa:first-task:pending-v1')); assert.equal(cache.draft, '补充：预算600元'); assert.equal(cache.dirty, true);
});

test('proposal awaits explicit owner confirmation, and running proposal stays disabled', async () => {
  const proposal = { version: 1, values: { title: '周日生日', date: '2026-10-18T18:00:00+08:00', note: '在家', steps: [{ label: '准备蛋糕', done: false }] } };
  const h = harness({ flow: initialFlow({ stage: 'awaiting_confirmation', runIds: ['one'], runSummary: { status: 'running' }, proposal }) });
  await eventually(() => h.root.querySelector('#ft-confirm')); assert.equal(h.root.querySelector('#ft-confirm').disabled, true); assert.equal(h.calls.filter(c => c.input).length, 0);
  assert.equal(h.root.querySelector('.ft-facts').textContent.includes('地点待定'), false);
  h.setFlow({ ...h.getFlow(), runSummary: { status: 'completed' } }); h.tick(); await eventually(() => !h.root.querySelector('#ft-confirm').disabled);
  h.click('ft-confirm'); await eventually(() => h.getFlow().stage === 'saving'); assert.equal(h.calls.filter(c => c.input?.operation === 'confirm').length, 1);
});

test('uncertain run offers only check or explicit confirmed stop, never send', async () => {
  const h = harness({ flow: initialFlow({ stage: 'uncertain', runIds: ['one'], currentRunId: 'one', runSummary: { status: 'uncertain' }, nextAction: { kind: 'check', label: '核对办理状态' } }) });
  await eventually(() => h.root.querySelector('#ft-check')); assert.equal(h.root.querySelector('#ft-submit'), null);
  assert.ok(h.root.querySelector('#ft-confirm-stopped')); h.click('ft-check'); await nextTurn(); assert.equal(h.calls.filter(c => c.input).length, 0);
});

test('recorded view uses exact bound item and reports designer failure honestly', async () => {
  const h = harness({ flow: initialFlow({ stage: 'recorded', runIds: ['one'], itemRecords: [{ id: 'exact-item', title: '当前生日', date: null, status: 'preparing' }], design: { state: 'failed', current: false } }) });
  await eventually(() => h.root.querySelector('#ft-view')); assert.equal(h.root.querySelector('#ft-view').dataset.ftValue, 'exact-item');
  assert.ok(h.root.textContent.includes('看板整理未完成，记录已保存')); assert.equal(h.root.textContent.includes('看板已整理好'), false);
});

test('an unsent correction cannot confirm the older proposal and restores after remount', async () => {
  const proposal = { version: 2, values: { title: '周日生日', note: '晚上在家准备', steps: [{ label: '准备蛋糕', done: false }] } };
  const h = harness({ flow: initialFlow({ stage: 'awaiting_confirmation', runIds: ['one'], runSummary: { status: 'completed' }, proposal }) });
  await eventually(() => h.root.querySelector('#ft-confirm')); h.click('ft-edit-plan'); h.input('改成周日下午，预算600元'); await h.ui.flushDraft();
  assert.equal(h.root.querySelector('#ft-confirm'), null); assert.equal(h.calls.filter(c => c.input?.operation === 'confirm').length, 0);
  h.ui.unmount(); h.mount(); await eventually(() => h.root.querySelector('#ft-draft')?.value === '改成周日下午，预算600元');
  assert.equal(h.root.querySelector('#ft-draft').value, '改成周日下午，预算600元'); assert.equal(h.root.querySelector('#ft-confirm'), null);
  h.click('ft-edit-plan'); await h.ui.flushDraft(); await eventually(() => h.root.querySelector('#ft-confirm'));
  assert.equal(h.getFlow().draft, ''); assert.equal(h.getFlow().proposal.version, 2);
});

test('saved record with an uncertain final run retains view and explicit recovery', async () => {
  const h = harness({ flow: initialFlow({ stage: 'recorded', runIds: ['one'], currentRunId: 'one', runSummary: { status: 'uncertain' }, itemRecords: [{ id: 'exact-item', title: '当前生日', status: 'preparing' }], design: { state: 'running', current: false } }) });
  await eventually(() => h.root.querySelector('#ft-view')); assert.equal(h.root.querySelector('#ft-view').disabled, false);
  assert.ok(h.root.querySelector('#ft-check')); assert.ok(h.root.querySelector('#ft-confirm-stopped')); assert.equal(h.root.querySelector('#ft-edit-plan'), null);
  assert.ok(h.root.textContent.includes('计划已保存，处理状态还待核对')); assert.equal(h.calls.filter(c => c.input).length, 0);
});

test('a completed read-only followup shows the answer and opens the existing item without a retry warning', async () => {
  const h = harness({ flow: initialFlow({ stage: 'recorded', followupAnswer: '还剩确定地点 <script>unsafe</script>', runIds: ['one', 'two'], currentRunId: 'two', runSummary: { status: 'completed' }, itemRecords: [{ id: 'exact-item', title: '当前生日', status: 'preparing' }], design: { state: 'ready', current: true } }) });
  await eventually(() => h.root.querySelector('#ft-view'));
  assert.ok(h.root.textContent.includes('已有回复'));
  assert.equal(h.root.querySelector('#ft-view').getAttribute('data-ft-value'), 'exact-item');
  assert.ok(h.root.textContent.includes('还剩确定地点 <script>unsafe</script>'));
  assert.equal(h.root.querySelector('script'), null);
  assert.equal(h.root.textContent.includes('还没有拿到完整结果'), false);
  assert.equal(h.calls.filter(c => c.input).length, 0);
});

test('a new flow without a Chief preserves draft and connects without submitting a model run', async () => {
  const h = harness({ flow: null, agents: { preferredEndpointId: null, endpoints: [] } });
  await eventually(() => h.root.querySelector('#ft-submit')?.dataset.ftAction === 'connect');
  h.input('帮我准备周日的生日'); await h.ui.flushDraft(); h.click('ft-submit');
  await eventually(() => h.navigations.length === 1);
  assert.equal(h.getFlow().draft, '帮我准备周日的生日'); assert.equal(h.getFlow().runIds.length, 0);
  assert.equal(h.calls.filter(c => c.input?.operation === 'start').length, 0);
  assert.equal(h.navigations[0].section, 'agents');
});

test('offline Chief cannot start even via form submit and keeps the original draft', async () => {
  const h = harness({ agents: { preferredEndpointId: 'chief', endpoints: [{ id: 'chief', label: '测试管家', online: false }] } });
  await eventually(() => h.root.querySelector('#ft-submit')?.dataset.ftAction === 'connect');
  h.input('帮我准备周日的生日'); await h.ui.flushDraft(); h.root.emit('submit', h.root.querySelector('#ft-compose'));
  await nextTurn(); assert.equal(h.calls.filter(c => c.input?.operation === 'start').length, 0);
  assert.equal(h.getFlow().draft, '帮我准备周日的生日'); assert.ok(h.root.textContent.includes('重连管家后开始'));
});

test('login failure remains explicit despite heartbeat and retries only after owner acknowledgement', async () => {
  const h = harness({ flow: initialFlow({ stage: 'failed', runIds: ['original-run'], currentRunId: 'original-run', endpointId: 'chief', runSummary: { status: 'failed', error: 'AGENT_AUTH_REQUIRED' } }) });
  await eventually(() => h.root.querySelector('#ft-login-retry'));
  assert.ok(h.root.textContent.includes('需要在执行端重新登录')); assert.ok(h.root.textContent.includes('测试管家 · 需要登录'));
  assert.equal(h.root.querySelector('#ft-connect').textContent, '重新登录'); assert.equal(h.root.querySelector('#ft-login-retry').disabled, true);
  h.click('ft-check'); h.tick(); await nextTurn(); assert.equal(h.calls.filter(c => c.input).length, 0);
  assert.equal(h.root.querySelector('#ft-login-retry').disabled, true);
  const checkbox = h.root.querySelector('#ft-login-confirm'); checkbox.checked = true; h.root.emit('change', checkbox);
  h.click('ft-login-retry'); await eventually(() => h.calls.some(c => c.input?.operation === 'send') && !h.ui.isBusy());
  assert.equal(h.calls.find(c => c.input?.operation === 'send').input.flowId, 'flow-one');
  assert.equal(h.calls.filter(c => c.input?.operation === 'send').length, 1);
});
