import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { memoryTool, memoryRequest } from '../plugins/agent-hub/memory.mjs';
import { validateSurface, validateSurfaces } from '../plugins/life-journal/surfaces.mjs';
import { JournalStore } from '../plugins/life-journal/store.mjs';
import { parseDesign } from '../plugins/life-journal/designer.mjs';
import { AgentCompanion } from '../plugins/agent-hub/companion.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoman-reuse-')), hub = new AgentHub(root), pairing = hub.pair({ label: 'fixture' });
  const conversation = hub.newConversation({ endpointId: pairing.endpointId });
  t.after(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
  const start = text => { hub.submit({ conversationId: conversation.id, content: text, requestId: crypto.randomUUID() }); return hub.poll(pairing.token, { runnerId: 'fixture' }).job; };
  const finish = job => hub.event(pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: '本轮已结束。' });
  const tool = (job, args, callId = crypto.randomUUID()) => memoryTool({ root, hub, token: pairing.token, input: { runId: job.id, lease: job.lease, callId, arguments: args } });
  return { root, hub, pairing, conversation, start, finish, tool };
}

test('Octop stores exact preferences, reopens with Chinese search, replaces with CAS, and deactivates recall', async t => {
  const f = await fixture(t), first = f.start('请记住：晚餐偏好清淡，不喜欢过甜。');
  const saved = await f.tool(first, { operation: 'save', content: '晚餐偏好清淡' }, 'remember-one');
  assert.equal(saved.memory.content, '晚餐偏好清淡');
  assert.equal(saved.memory.source.messageId, first.messageId);
  assert.deepEqual(await f.tool(first, { operation: 'save', content: '晚餐偏好清淡' }, 'remember-one'), saved);
  assert.deepEqual(await Promise.all([1, 2].map(() => f.tool(first, { operation: 'save', content: '晚餐偏好清淡' }, 'remember-one'))), [saved, saved]);
  await assert.rejects(f.tool(first, { operation: 'save', content: '不喜欢过甜' }, 'remember-one'), { code: 'CONFLICT' });
  await assert.rejects(f.tool(first, { operation: 'save', content: '喜欢辣椒' }), { code: 'SOURCE_REQUIRED' });
  assert.equal((await memoryRequest(f.root, { operation: 'search', query: '清淡' })).memories[0].id, saved.memory.id);
  assert.equal((await stat(join(f.root, '.runtime/memory/memory.sqlite'))).mode & 0o777, 0o600);
  f.finish(first);
  const second = f.start('更正刚才的偏好：晚餐喜欢微辣。');
  const change = { operation: 'correct', memoryId: saved.memory.id, version: saved.memory.version, content: '晚餐喜欢微辣' };
  await assert.rejects(f.tool(second, { ...change, version: 'old' }), { code: 'VERSION_CONFLICT' });
  const corrected = await f.tool(second, change, 'correct-one');
  assert.notEqual(corrected.memory.id, saved.memory.id);
  assert.equal(corrected.memory.source.messageId, second.messageId);
  const recalled = (await f.tool(second, { operation: 'search', query: '清淡' })).memories;
  assert.ok(recalled.every(memory => memory.id === corrected.memory.id && memory.content === '晚餐喜欢微辣'), 'Historical source terms may match, but recall must return only the corrected live preference');
  const previous = (await f.tool(second, { operation: 'get', memoryId: saved.memory.id })).memory;
  assert.equal(previous.replacedBy, corrected.memory.id);
  assert.equal(previous.source.messageId, first.messageId, 'Superseding a preference must retain its original evidence');
  await assert.rejects(f.tool(second, change), { code: 'VERSION_CONFLICT' });
  f.finish(second);
  const third = f.start('忘记我的晚餐口味偏好。');
  const forgotten = await f.tool(third, { operation: 'forget', memoryId: corrected.memory.id, version: corrected.memory.version });
  assert.equal(forgotten.memory.active, false);
  assert.equal((await f.tool(third, { operation: 'list' })).memories.length, 0);
});

test('memory rejects foreign endpoint, cancelled lease and invented sources before touching storage', async t => {
  const f = await fixture(t), job = f.start('请记住：周末喜欢散步。');
  const other = f.hub.pair({ label: 'other' });
  let calls = 0;
  const options = { root: f.root, hub: f.hub, token: other.token, request: async () => { calls++; }, input: { runId: job.id, lease: job.lease, callId: 'one', arguments: { operation: 'list' } } };
  await assert.rejects(memoryTool(options), { code: 'FORBIDDEN' });
  await assert.rejects(memoryTool({ ...options, token: f.pairing.token, input: { ...options.input, arguments: { operation: 'save', content: '别人说的话' } } }), { code: 'SOURCE_REQUIRED' });
  f.finish(job);
  await assert.rejects(memoryTool({ ...options, token: f.pairing.token }), { code: 'FORBIDDEN' });
  assert.equal(calls, 0);
});

test('handoff keeps verbatim corrections and host receipts, excludes later queued turns and foreign conversations', async t => {
  const f = await fixture(t), first = f.start('晚餐是四个人，预算 300 元；不要订餐。');
  f.hub.put('effect', { id: `journal:${first.id}:save`, state: 'done', result: { saved: true, item: { id: 'meal-original', version: 2 } } });
  f.finish(first);
  const foreign = f.hub.newConversation({ endpointId: f.pairing.endpointId });
  const secret = f.hub.message(foreign.id, 'user', '另一对话的私密材料', { channel: 'web' });
  const second = f.hub.submit({ conversationId: f.conversation.id, content: '改成六个人。', requestId: crypto.randomUUID() }).run;
  f.hub.submit({ conversationId: f.conversation.id, content: '后续独立排队的要求', requestId: crypto.randomUUID() });
  const job = f.hub.poll(f.pairing.token, { runnerId: 'fixture' }).job;
  assert.equal(job.id, second.id);
  assert.deepEqual(job.continuation.userMessages.map(m => m.text), ['晚餐是四个人，预算 300 元；不要订餐。']);
  assert.equal(job.continuation.recentWork[0].savedItems[0].id, 'meal-original');
  const history = args => f.hub.tool(f.pairing.token, { tool: 'xiaoman_history', runId: job.id, lease: job.lease, callId: 'history', arguments: args });
  assert.equal(history({ operation: 'search', query: '不要订餐' }).messages[0].id, first.messageId);
  assert.throws(() => history({ operation: 'get', messageId: secret.id }), { code: 'ITEM_NOT_FOUND' });
  assert.equal(history({ operation: 'get', messageId: first.messageId }).message.text, '晚餐是四个人，预算 300 元；不要订餐。');
});

const program = 'item = Query("current_item", {}, {})\n$servings = 4\nroot = Panel("人数试算", [Row([Metric("正式计划", item.taskData.meal.servings, "人"), NumberInput("servings", "拟调整人数", $servings)]), Button("查看调整影响", @PreviewPlan($servings))])';

test('native companion exposes and dispatches the actual history and memory tools', async t => {
  const f = await fixture(t);
  f.hub.submit({ conversationId: f.conversation.id, content: '请记住：周末喜欢散步。', requestId: crypto.randomUUID() });
  let verified = false;
  const companion = new AgentCompanion({ config: { provider: 'codex' }, statePath: join(f.root, 'spool'),
    transport: async (operation, input) => operation === 'tool' && input.tool === 'xiaoman_memory' ? memoryTool({ root: f.root, hub: f.hub, token: f.pairing.token, input }) : f.hub[operation](f.pairing.token, input),
    provider: async (_config, _prompt, context) => {
      assert.ok(context.tools.some(tool => tool.name === 'xiaoman_memory'));
      assert.ok(context.tools.some(tool => tool.name === 'xiaoman_history'));
      const recent = await context.callTool('xiaoman_history', { operation: 'recent' }, 'read-one');
      assert.equal(recent.messages.at(-1).text, '请记住：周末喜欢散步。');
      const saved = await context.callTool('xiaoman_memory', { operation: 'save', content: '周末喜欢散步' }, 'save-one');
      assert.equal(saved.saved, true); verified = true;
      return { text: '已保存有来源的偏好。' };
    } });
  t.after(() => companion.stop());
  await companion.tick(); await companion.execution; await companion.tick();
  assert.equal(verified, true);
});

test('OpenUI accepts native bindings and rejects code, cross-task tools, dynamic actions and incomplete programs', () => {
  assert.equal(validateSurface(program), program);
  for (const unsafe of [program.replace('current_item', 'send_email'), program.replace('Query(', 'Mutation('), program.replace('@PreviewPlan($servings)', '@OpenUrl("https://example.com")'), program.replace('@PreviewPlan($servings)', 'item.action'), program.replace('@PreviewPlan($servings)', '{type: "open_url", url: "https://example.com"}'), 'root = HtmlView("<script>alert(1)</script>")', 'root = Panel("incomplete", [', program + '\nevil = @Run(item)', program.replace('{}, {}', '{itemId: "other"}, {}')]) assert.throws(() => validateSurface(unsafe), { code: 'INVALID_SURFACE' });
  assert.throws(() => validateSurfaces([{ itemId: 'other', program }], [{ itemId: 'one' }]), { code: 'INVALID_SURFACE' });
});

test('design commits an item-bound program, preserves it on field edits, and rejects stale or invalid replacement atomically', async t => {
  const f = await fixture(t), store = new JournalStore(f.root), scope = { account: 'local', userId: 'owner' };
  t.after(() => store.close());
  let state = store.mutate(scope, { operation: 'add', revision: 0, values: { title: '隔离验证晚餐', taskType: 'meal', taskData: { meal: { servings: 4, baseServings: 4, ingredients: [{ id: 'rice', name: '米饭', quantity: 400, unit: '克' }] } } } });
  const item = state.items[0];
  state = store.mutate(scope, { operation: 'design-start', revision: state.revision, values: {} });
  const proposal = parseDesign(JSON.stringify({ widgets: [{ id: `${item.id}:meal`, itemId: item.id, kind: 'meal' }], reason: '人数试算', surfaces: [{ itemId: item.id, program }] }), state);
  const commit = { ...proposal, token: state.design.token, baseRevision: state.design.baseRevision, layoutVersion: state.design.layoutVersion };
  state = store.mutate(scope, { operation: 'design-result', revision: state.revision, values: commit });
  assert.equal(state.layout.surfaces[0].program, program);
  assert.throws(() => store.mutate(scope, { operation: 'design-result', revision: state.revision, values: commit }), { code: 'STALE_DESIGN' });
  state = store.mutate(scope, { operation: 'update', revision: state.revision, itemId: item.id, version: item.version, values: { note: '只更新材料，不重建界面。' } });
  assert.equal(state.layout.surfaces[0].program, program);
  state = store.mutate(scope, { operation: 'design-start', revision: state.revision, values: {} });
  assert.throws(() => store.mutate(scope, { operation: 'design-result', revision: state.revision, values: { ...proposal, token: state.design.token, baseRevision: state.design.baseRevision, layoutVersion: state.design.layoutVersion, surfaces: [{ itemId: item.id, program: 'root = HtmlView("hi")' }] } }), { code: 'INVALID_LAYOUT' });
  assert.equal(store.snapshot(scope).layout.surfaces[0].program, program);
});
