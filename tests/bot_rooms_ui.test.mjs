import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parseHTML } from 'linkedom';

const source = readFileSync(new URL('../plugins/webui/public/bots.js', import.meta.url), 'utf8');
const truth = readFileSync(new URL('../plugins/webui/public/truth.js', import.meta.url), 'utf8');
const routines = readFileSync(new URL('../plugins/webui/public/routines-ui.js', import.meta.url), 'utf8');
const bot = (id, name) => ({ id, name, handle: id, avatar: 'steward', active: true, connected: true, online: true });
const direct = id => ({ id: 'room-' + id, kind: 'direct', botId: id, title: id });
const group = { id: 'room-group', kind: 'group', memberBotIds: ['xiaoman', 'research'], title: '全员群' };
const initial = () => ({ bots: [bot('xiaoman', '小满'), bot('research', '阿探')], rooms: [group, direct('xiaoman'), direct('research')], conversations: [group, direct('xiaoman'), direct('research'), { id: 'legacy', title: '旧事项', botId: 'research' }], endpoints: [], runs: [], rootTasks: [] });
async function eventually(check) {
  for (let i = 0; i < 40; i++) { if (check()) return; await nextTurn(); }
  assert.fail('Production Bot UI did not reach expected state');
}
function harness(value = initial(), transport) {
  const { document, Event } = parseHTML('<html><body><main></main></body></html>');
  const root = document.querySelector('main'), intervals = new Map(), opened = [], calls = [], motion = [], navigations = [];
  Object.getPrototypeOf(document.createElement('dialog')).showModal = function() { this.open = true; };
  Object.getPrototypeOf(document.createElement('dialog')).close = function() { this.open = false; this.dispatchEvent(new Event('close')); };
  let n = 0, chatRoot, onConversation, model = value;
  const window = {
    PAChat: {
      isBusy: () => false,
      mount(options) { chatRoot = options.root; chatRoot.innerHTML = '<section class="chat-center"><textarea></textarea></section>'; onConversation = options.onConversation; },
      unmount() { chatRoot = undefined; },
      async open(options) { opened.push(options); onConversation?.(model.conversations.find(room => room.id === options.conversationId)); },
    },
    PAMotion: { play(element, kind) { motion.push({ element, kind }); }, toggle() {} },
  };
  runInNewContext(truth, { window });
  runInNewContext(routines, { window });
  runInNewContext(source, { window, document, Event, confirm: () => false, setInterval: fn => { intervals.set(++n, fn); return n; }, clearInterval: id => intervals.delete(id), setTimeout });
  const api = async (path, data) => { calls.push({ path, data }); return transport ? transport(path, data, model) : model; };
  const navigate = async options => { navigations.push(options); await window.PABots.mount({ root, api, mode: 'chat', navigate, ...options }); };
  return {
    root, document, opened, calls, motion, navigations, ui: window.PABots,
    mount: options => window.PABots.mount({ root, api, mode: 'chat', navigate, ...options }),
    tick: () => { for (const fn of intervals.values()) fn(); },
    setModel: next => { model = next; },
    click(selector) { root.querySelector(selector).dispatchEvent(new Event('click', { bubbles: true })); },
  };
}

test('chat directory contains one group and one fixed entry per active Bot, with no task/session directory', async () => {
  const h = harness();
  try {
    await h.mount();
    assert.deepEqual([...h.root.querySelectorAll('[data-bot]')].map(node => node.dataset.bot), ['group', 'xiaoman', 'research']);
    assert.equal(h.root.querySelector('#bot-chat-title').textContent, '全员群');
    assert.equal(h.opened[0].conversationId, 'room-group'); assert.equal(h.opened[0].roomKind, 'group');
    assert.doesNotMatch(h.root.textContent, /旧事项|新开一件事|新会话|共享上下文|@xiaoman/);
    h.click('[data-bot=research]'); await eventually(() => !h.ui.isBusy());
    await eventually(() => h.opened.at(-1).conversationId === 'room-research');
    assert.equal(h.opened.at(-1).conversationId, 'room-research'); assert.equal(h.root.querySelector('#bot-chat-title').textContent, '阿探');
    h.click('[data-bot=group]'); await eventually(() => h.opened.at(-1).conversationId === 'room-group' && !h.ui.isBusy());
    h.click('[data-bot=research]'); await eventually(() => h.opened.at(-1).conversationId === 'room-research' && !h.ui.isBusy());
    assert.equal(h.opened.at(-1).conversationId, 'room-research');
    assert.equal(h.calls.filter(call => call.data).length, 0, 'switching known rooms must not create more conversations');
    assert.deepEqual(h.navigations.map(route => route.botId), ['research', 'group', 'research'], 'directory selection updates the owning route rather than being overwritten by a stale route poll');
  } finally { h.ui.unmount(); }
});

test('a newly created Bot appears on polling without rebuilding the active conversation or adding another group', async () => {
  const h = harness();
  try {
    await h.mount(); const input = h.root.querySelector('textarea'); input.value = '仍在输入';
    const next = initial(); next.bots.push(bot('maker', '阿造')); next.rooms.push(direct('maker')); next.conversations.push(direct('maker')); h.setModel(next); h.tick();
    await eventually(() => h.root.querySelector('[data-bot=maker]'));
    assert.equal(h.root.querySelectorAll('[data-bot=group]').length, 1);
    assert.equal(h.root.querySelector('textarea'), input); assert.equal(input.value, '仍在输入');
    assert.equal(h.opened.length, 1); assert.equal(h.motion.length, 1, 'polling cannot replay room transitions');
    assert.equal(h.root.querySelector('#bot-chat-identity .bot-members').children.length, 3);
  } finally { h.ui.unmount(); }
});

test('opening a missing canonical room locks the old composer and preserves it after failure', async () => {
  const model = initial(); model.rooms = [group];
  let reject, fail = true;
  const h = harness(model, async (_path, data, current) => {
    if (!data) return current;
    assert.deepEqual(JSON.parse(JSON.stringify(data)), { operation: 'open-room', kind: 'direct', botId: 'research' });
    if (fail) return new Promise((_resolve, no) => { reject = no; });
    return direct('research');
  });
  try {
    await h.mount(); h.click('[data-bot=research]'); await eventually(() => reject);
    assert.equal(h.root.querySelector('#bot-chat-root').inert, true);
    assert.equal(h.root.querySelector('#bot-chat-title').textContent, '全员群');
    reject(new Error('服务暂不可用')); await eventually(() => !h.ui.isBusy());
    assert.equal(h.root.querySelector('#bot-chat-root').inert, false);
    assert.equal(h.root.querySelector('[aria-current=true]').dataset.bot, 'group');
    assert.equal(h.root.querySelector('.bots-status').hidden, false); assert.match(h.root.querySelector('#bots-status').textContent, /服务暂不可用/);
    h.tick(); await nextTurn(); assert.equal(h.root.querySelector('.bots-status').hidden, false, 'a successful poll cannot erase an open-room failure');
    const writes = h.calls.filter(call => call.data).length;
    await h.mount({ botId: 'research' }); assert.equal(h.calls.filter(call => call.data).length, writes, 'route polling does not automatically replay a failed room open');
    fail = false; h.click('#bots-retry'); await eventually(() => h.opened.at(-1).conversationId === 'room-research' && !h.ui.isBusy());
    assert.equal(h.opened.at(-1).conversationId, 'room-research');
    assert.equal(h.root.querySelector('#bot-chat-title').textContent, '阿探');
  } finally { h.ui.unmount(); }
});

test('same-root Bot navigation reuses the directory, header and chat shell instead of flashing a loading page', async () => {
  const h = harness();
  try {
    await h.mount({ botId: 'xiaoman' });
    const directory = h.root.querySelector('#bots-list'), header = h.root.querySelector('.bot-chat-head'), host = h.root.querySelector('#bot-chat-root'), input = h.root.querySelector('textarea');
    input.value = '未发送的原草稿';
    h.click('.bot-identity-button'); assert.equal(h.root.querySelector('#bot-detail').open, true);
    await h.mount({ botId: 'research' });
    assert.equal(h.root.querySelector('#bots-list'), directory); assert.equal(h.root.querySelector('.bot-chat-head'), header);
    assert.equal(h.root.querySelector('#bot-chat-root'), host); assert.equal(h.root.querySelector('textarea'), input);
    assert.equal(h.root.querySelector('#bot-detail').open, false); assert.equal(h.opened.at(-1).conversationId, 'room-research');
    assert.doesNotMatch(h.root.textContent, /读取中/);
    assert.equal(h.root.querySelector('#bot-chat-title').textContent, '阿探');
    await h.mount({ botId: 'research' }); assert.equal(h.opened.length, 2, 'polling does not reopen the selected room');
  } finally { h.ui.unmount(); }
});

test('explicit old links retain their history while the directory stays Bot based', async () => {
  const h = harness();
  try {
    await h.mount({ conversationId: 'legacy', botId: 'research' });
    assert.equal(h.opened[0].conversationId, 'legacy');
    assert.equal(h.root.querySelectorAll('[data-bot]').length, 3);
    assert.doesNotMatch(h.root.querySelector('#bots-list').textContent, /旧事项/);
  } finally { h.ui.unmount(); }
});

test('live avatars follow execution presence while historical author avatars remain unchanged', async () => {
  const model = initial(); model.bots[1].execution = { connected: true, online: false, canExecute: false };
  const h = harness(model);
  try {
    await h.mount({ botId: 'research' });
    assert.ok(h.root.querySelector('[data-bot=research] .bot-avatar').classList.contains('is-offline'));
    assert.equal(h.root.querySelector('.bot-identity-button .bot-avatar').getAttribute('title'), '离线');
    assert.doesNotMatch(h.ui.avatar(model.bots[1]), /is-offline|data-presence/);
    assert.match(h.ui.avatar({ active: true }, { presence: true }), /状态待确认/);
    model.bots[1].execution = { connected: true, online: true, canExecute: true }; h.tick();
    await eventually(() => !h.root.querySelector('[data-bot=research] .bot-avatar').classList.contains('is-offline'));
    assert.equal(h.opened.length, 1, 'presence polling does not reopen the room');
  } finally { h.ui.unmount(); }
});

test('Bot details show actual execution and schedules without touching the active draft or Bot', async () => {
  const model = initial(); model.bots[1].execution = { endpointId: 'research-executor', label: '实际执行端', provider: 'codex', connected: true, online: true, canExecute: true };
  model.bots[1].routines = [{ id: 'routine-1', title: '每日资料检查', journalItemId: 'item-1', enabled: true, nextRunAt: Date.parse('2026-10-29T02:00:00Z') }];
  model.rootTasks = [{ id: 'root-1', rootRunId: 'root-1', botId: 'xiaoman', state: 'running', participantSlots: [{ botId: 'research' }], messageId: 'message-1', conversationId: 'room-group' }];
  model.runs = [{ id: 'root-1', title: '核实一份材料' }];
  const h = harness(model);
  try {
    await h.mount({ botId: 'research' }); const input = h.root.querySelector('textarea'); input.value = '未发送';
    h.click('.bot-identity-button'); assert.equal(h.root.querySelector('#bot-detail').open, true);
    const detail = h.root.querySelector('#bot-detail-body');
    assert.match(detail.textContent, /实际执行端.*codex/s); assert.match(detail.textContent, /每日资料检查.*下次/s); assert.match(detail.textContent, /核实一份材料/);
    assert.doesNotMatch(detail.textContent, /其他 Bot 的安排|全部安排/);
    assert.equal(h.root.querySelector('#bot-routines'), null, 'No permanent schedule strip above the chat');
    h.tick(); await nextTurn(); assert.equal(input.value, '未发送'); assert.equal(h.opened.length, 1);
    h.click('#bot-detail-close'); assert.equal(h.root.querySelector('#bot-detail').open, false); assert.equal(h.root.querySelector('[aria-current=true]').dataset.bot, 'research');
  } finally { h.ui.unmount(); }
});

test('exact message and unsent guide draft are forwarded once and missing conversation never opens a fallback', async () => {
  const h = harness();
  try {
    await h.mount({ conversationId: 'room-research', messageId: 'reply-exact', draft: '实际资料', guideSourceId: 'guide-1' });
    assert.equal(h.opened[0].messageId, 'reply-exact'); assert.equal(h.opened[0].draft, '实际资料'); assert.equal(h.opened[0].guideSourceId, 'guide-1');
    await h.mount({ conversationId: 'room-research' }); assert.equal(h.opened.length, 1);
    await h.mount({ conversationId: 'gone', messageId: 'gone-message' });
    assert.equal(h.opened.length, 1); assert.match(h.root.querySelector('#bots-status').textContent, /未跳到其他聊天/);
  } finally { h.ui.unmount(); }
});

test('Bot detail reuses readable routine errors and preserves the full current-task title behind a two-line preview', async () => {
  const model = initial(), title = '请将最近读到的每一篇文章逐项整理成一份结构清晰的长资料清单，并保留各个任务的原文引用。';
  model.bots[1].routines = [{ id: 'routine-1', title: '网页巡查', enabled: true, error: 'ROUTINE_PUBLIC_WEB_UNSUPPORTED', scopeStatus: { blocked: true } }];
  model.rootTasks = [{ id: 'run-1', rootRunId: 'run-1', botId: 'research', state: 'running', messageId: 'message-1', conversationId: 'room-research' }];
  model.runs = [{ id: 'run-1', title }];
  const h = harness(model);
  try {
    await h.mount({ botId: 'research' }); h.click('.bot-identity-button');
    assert.equal(h.root.querySelector('.bot-detail-error').textContent, '这个执行端尚不支持可核验的网页巡查');
    assert.equal(h.root.querySelector('[data-routine-error] code').textContent, 'ROUTINE_PUBLIC_WEB_UNSUPPORTED');
    assert.notEqual(h.root.querySelector('[data-routine-error]').open, true);
    const preview = h.root.querySelector('.bot-detail-task-title'); assert.equal(preview.textContent, title); assert.equal(preview.getAttribute('title'), title);
    assert.equal(h.root.querySelector('[data-bot-task]').dataset.botTask, 'run-1');
  } finally { h.ui.unmount(); }
});

test('new identity commits with its conversation before a slow directory metadata refresh', async () => {
  let slow = false, finish;
  const model = initial(), h = harness(model, async (_path, _request, current) => slow ? new Promise(resolve => { finish = () => resolve(current); }) : current);
  try {
    await h.mount({ botId: 'xiaoman' }); slow = true;
    const switching = h.mount({ botId: 'research' });
    await eventually(() => finish); await switching;
    assert.equal(h.opened.at(-1).conversationId, 'room-research');
    assert.equal(h.root.querySelector('#bot-chat-title').textContent, '阿探', 'New messages cannot stay under the previous Bot identity while metadata is delayed');
    assert.equal(h.root.querySelector('#bot-chat-root').inert, false);
    slow = false; finish(); await nextTurn();
  } finally { h.ui.unmount(); }
});

test('a new mount shows a neutral loading title and ignores a late retired mount snapshot', async () => {
  let release; const first = new Promise(resolve => { release = resolve; }); let reads = 0;
  const model = initial(), h = harness(model, async () => ++reads === 1 ? first : model);
  const old = h.mount({ botId: 'research' });
  assert.equal(h.root.querySelector('#bot-chat-title').textContent, '聊天');
  h.ui.unmount(); await h.mount({ botId: 'xiaoman' }); release(model); await old; await nextTurn();
  try {
    assert.equal(h.root.querySelector('#bot-chat-title').textContent, '小满');
    assert.equal(h.opened.at(-1).conversationId, 'room-xiaoman');
  } finally { h.ui.unmount(); }
});
