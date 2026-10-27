import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAnalyzer } from '../plugins/proactive/index.mjs';
import { createJournalRuntime } from '../plugins/life-journal/chief.mjs';

const rolePath = new URL('../agents/life-journal-designer/AGENT.md', import.meta.url);
const LOCAL = { account: 'local', userId: 'owner' };
const signal = () => new AbortController().signal;

function context(produce) {
  const requests = [];
  return { requests,
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }) },
    llm: { async *stream(options) {
      requests.push(options);
      const chunks = typeof produce === 'function' ? produce(options) : produce;
      for (const chunk of chunks) yield chunk;
    } },
  };
}

function textChunks(text, finishKind = 'stop') {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(finishKind === null ? [] : [{ type: 'finish', reason: { kind: finishKind } }]),
  ];
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('isolated analysis did not settle');
}

test('the default observer analysis keeps its 1600-token budget, selected route and zero-tool boundary', async () => {
  const ctx = context(textChunks('{"changes":[]}'));
  const analyze = makeAnalyzer(ctx, { provider: 'dsh' }, 'unused-fixture-workspace');
  assert.equal(await analyze('observer', '{}', signal()), '{"changes":[]}');
  assert.equal(ctx.requests[0].maxTokens, 1600);
  assert.equal(ctx.requests[0].provider, 'fixture-provider');
  assert.equal(ctx.requests[0].model, 'fixture-model');
  assert.deepEqual(ctx.requests[0].tools, []);
  assert.equal(ctx.requests[0].sessionId, undefined);
  assert.equal(ctx.requests[0].signal.aborted, false);
});

test('an explicit analysis budget is forwarded without changing the configured role model', async () => {
  const ctx = context(textChunks('{"widgets":[],"reason":"fixture"}'));
  await makeAnalyzer(ctx, { provider: 'dsh', model_provider: 'role-provider', model: 'role-model' }, '', { maxTokens: 8192 })('designer', '{}', signal());
  assert.equal(ctx.requests[0].maxTokens, 8192);
  assert.equal(ctx.requests[0].provider, 'role-provider');
  assert.equal(ctx.requests[0].model, 'role-model');
  assert.deepEqual(ctx.requests[0].tools, []);
});

test('the real journal runtime requests 8192 tokens and publishes a bounded three-widget birthday proposal from an offline stream', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoman-analysis-budget-'));
  const ctx = context(options => {
    const input = JSON.parse(options.messages[0].content[0].text);
    const item = input.items[0];
    const text = JSON.stringify({ widgets: ['prep', 'decision', 'budget'].map((kind, index) => ({ id: `${item.id}:${kind}`, itemId: item.id, kind, emphasis: index === 0 ? 'primary' : 'normal' })), reason: '依据本人提供的生日材料整理' });
    return textChunks(text);
  });
  const runtime = await createJournalRuntime({ root, ctx, agentConfig: { provider: 'dsh' }, rolePath });
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  const saved = runtime.store.mutate(LOCAL, { operation: 'add', revision: 0, values: {
    title: '给妈妈准备生日', taskType: 'auto',
    steps: [{ id: 'cake', label: '核对蛋糕', done: false }, { id: 'candles', label: '准备蜡烛', done: false }],
    candidates: [{ id: 'one', name: '草莓蛋糕', selected: false }, { id: 'two', name: '巧克力蛋糕', selected: false }],
    taskData: { budget: { total: 400, lines: [{ id: 'cake-cost', label: '蛋糕报价待核对', amount: null }] } },
  } });
  assert.equal(runtime.ready, true);
  await runtime.request(LOCAL);
  await until(() => ['ready', 'failed'].includes(runtime.store.snapshot(LOCAL).design.status));
  const result = runtime.store.snapshot(LOCAL);
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0].maxTokens, 8192);
  assert.deepEqual(ctx.requests[0].tools, []);
  assert.equal(result.design.status, 'ready');
  assert.equal(result.layout.source, 'agent');
  assert.deepEqual(result.layout.widgets.map(widget => widget.kind), ['prep', 'decision', 'budget']);
  assert.deepEqual(result.items, saved.items, 'more output budget only changes presentation, not birthday facts');
});

test('a max-tokens terminal rejects even apparently complete JSON and exposes only safe finish metadata', async () => {
  const text = '{"widgets":[],"reason":"PRIVATE_FIXTURE_TEXT"}';
  const ctx = context(textChunks(text, 'max-tokens'));
  await assert.rejects(makeAnalyzer(ctx, { provider: 'dsh' }, '', { maxTokens: 8192 })('designer', '{}', signal()), error => {
    assert.equal(error.message, 'PROACTIVE_INCOMPLETE_RESULT');
    assert.equal(error.code, 'PROACTIVE_INCOMPLETE_RESULT');
    assert.equal(error.finishKind, 'max-tokens');
    assert.equal(error.textCharacters, text.length);
    assert.equal(JSON.stringify(error).includes('PRIVATE_FIXTURE_TEXT'), false);
    return true;
  });
});

test('a stream without a terminal finish cannot inherit BlockAssembler default stop', async () => {
  const text = '{"changes":[]}';
  const ctx = context(textChunks(text, null));
  await assert.rejects(makeAnalyzer(ctx, { provider: 'dsh' }, '')('observer', '{}', signal()), error => {
    assert.equal(error.code, 'PROACTIVE_INCOMPLETE_RESULT');
    assert.equal(error.finishKind, 'missing');
    assert.equal(error.textCharacters, text.length);
    return true;
  });
  const empty = context([]);
  await assert.rejects(makeAnalyzer(empty, { provider: 'dsh' }, '')('observer', '{}', signal()), error => error.finishKind === 'missing' && error.textCharacters === 0);
});

test('raising the token budget preserves the exact ASCII text limit and rejects overflow across chunks', async () => {
  const text = 'x'.repeat(16_384);
  const allowed = context(textChunks(text));
  assert.equal((await makeAnalyzer(allowed, { provider: 'dsh' }, '', { maxTokens: 8192 })('designer', '{}', signal())).length, 16_384);
  const oversized = context([
    { type: 'text-delta', index: 0, text: text.slice(0, 8192) },
    { type: 'text-delta', index: 0, text: text.slice(8192) + 'x' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  await assert.rejects(makeAnalyzer(oversized, { provider: 'dsh' }, '', { maxTokens: 8192 })('designer', '{}', signal()), /PROACTIVE_OUTPUT_TOO_LARGE/);
});

test('a completed text block without deltas cannot bypass the same output text limit', async () => {
  const ctx = context([
    { type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(16_385) } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  await assert.rejects(makeAnalyzer(ctx, { provider: 'dsh' }, '', { maxTokens: 8192 })('designer', '{}', signal()), /PROACTIVE_OUTPUT_TOO_LARGE/);
});

test('the assembled UTF-8 bound rejects Chinese text over 16KiB even when its character count is smaller', async () => {
  const text = '中'.repeat(5461);
  assert.equal(Buffer.byteLength(text), 16_383);
  const allowed = context(textChunks(text));
  assert.equal(await makeAnalyzer(allowed, { provider: 'dsh' }, '', { maxTokens: 8192 })('designer', '{}', signal()), text);
  const oversized = context(textChunks(text + '中'));
  assert.ok((text + '中').length < 16_384);
  await assert.rejects(makeAnalyzer(oversized, { provider: 'dsh' }, '', { maxTokens: 8192 })('designer', '{}', signal()), /PROACTIVE_OUTPUT_TOO_LARGE/);
});

test('an offline native CLI result obeys the same final UTF-8 text bound', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoman-cli-text-bound-'));
  const previousScenario = process.env.PA_TEST_SCENARIO;
  const previousReply = process.env.PA_TEST_REPLY;
  const previousEffort = process.env.PA_TEST_REASONING_EFFORT;
  t.after(async () => {
    if (previousScenario === undefined) delete process.env.PA_TEST_SCENARIO;
    else process.env.PA_TEST_SCENARIO = previousScenario;
    if (previousReply === undefined) delete process.env.PA_TEST_REPLY;
    else process.env.PA_TEST_REPLY = previousReply;
    if (previousEffort === undefined) delete process.env.PA_TEST_REASONING_EFFORT;
    else process.env.PA_TEST_REASONING_EFFORT = previousEffort;
    await rm(root, { recursive: true, force: true });
  });
  process.env.PA_TEST_SCENARIO = 'passive';
  process.env.PA_TEST_REASONING_EFFORT = 'medium';
  process.env.PA_TEST_REPLY = '中'.repeat(5462);
  const command = fileURLToPath(new URL('./fake_agent.mjs', import.meta.url));
  await assert.rejects(makeAnalyzer({}, { provider: 'codex', command, timeout_seconds: 3 }, root)('designer', '{}', signal()), /PROACTIVE_OUTPUT_TOO_LARGE/);
});

test('an incomplete journal stream preserves the saved birthday and does not publish a partial layout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoman-incomplete-analysis-'));
  const ctx = context(textChunks('{"widgets":[],"reason":"not finished"}', 'max-tokens'));
  const runtime = await createJournalRuntime({ root, ctx, agentConfig: { provider: 'dsh' }, rolePath });
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  const saved = runtime.store.mutate(LOCAL, { operation: 'add', revision: 0, values: { title: '已经保存的生日交代' } });
  await runtime.request(LOCAL);
  await until(() => runtime.store.snapshot(LOCAL).design.status === 'failed');
  const result = runtime.store.snapshot(LOCAL);
  assert.equal(result.design.errorCode, 'DESIGN_FAILED');
  assert.equal(result.layout.source, 'basic');
  assert.deepEqual(result.items, saved.items);
});
