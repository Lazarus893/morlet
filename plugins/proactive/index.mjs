import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { providers } from '../agent-bridge/providers.mjs';
import { roleAgent, hubConfig } from '../agent-hub/config.mjs';
import { ProactiveEngine } from './engine.mjs';

export function makeAnalyzer(ctx, agentConfig, workspace, { maxTokens = 1600 } = {}) {
  return async (instructions, prompt, signal) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    deadline.throwIfAborted();
    if (agentConfig.provider !== 'dsh') {
      const result = await providers[agentConfig.provider]({ ...agentConfig, workspace, timeout_seconds: 60 }, prompt, {
        instructions: instructions + '\n这是后台分析：不使用任何工具，不读取文件，不联网，不执行动作。只返回 JSON。',
        signal: deadline, passive: true, ...(agentConfig.provider === 'codex' && { reasoningEffort: 'medium' }), onSession: async () => {}, approve: async () => false,
      });
      if (Buffer.byteLength(result.text) > 16_384) throw new Error('PROACTIVE_OUTPUT_TOO_LARGE');
      return result.text;
    }
    // Call the existing DSH model directly, with no Agent, tools, hooks or session.
    const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm');
    const selected = ctx.agentDefaultModel.currentSelection();
    const route = { provider: agentConfig.model_provider || selected.provider, model: agentConfig.model || selected.model };
    const assembler = new BlockAssembler();
    let finished = false, size = 0;
    for await (const chunk of ctx.llm.stream({ ...route, system: instructions,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'pa-proactive' } })],
      tools: [], maxTokens, signal: deadline })) {
      deadline.throwIfAborted();
      if (chunk.type === 'tool-call-delta') throw new Error('PROACTIVE_TOOL_REJECTED');
      if (chunk.type === 'text-delta') size += chunk.text.length;
      if (size > 16_384) throw new Error('PROACTIVE_OUTPUT_TOO_LARGE');
      if (chunk.type === 'finish') finished = true;
      assembler.push(chunk);
    }
    deadline.throwIfAborted();
    if (!finished || assembler.finish.kind !== 'stop') throw Object.assign(new Error('PROACTIVE_INCOMPLETE_RESULT'), {
      code: 'PROACTIVE_INCOMPLETE_RESULT', finishKind: finished ? assembler.finish.kind : 'missing', textCharacters: size,
    });
    const output = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
    if (Buffer.byteLength(output) > 16_384) throw new Error('PROACTIVE_OUTPUT_TOO_LARGE');
    return output;
  };
}

export async function createProactive({ ctx, configPath, ...options }) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const agentConfig = JSON.parse(await readFile(config.agent_config, 'utf8'));
  const analysisWorkspace = join(config.state_dir, 'analysis');
  await mkdir(analysisWorkspace, { recursive: true, mode: 0o700 });
  const engine = new ProactiveEngine({ ...options, config, analyze: config.hub_root ? (...args) => makeAnalyzer(ctx, roleAgent(config.hub_root, 'observer'), analysisWorkspace)(...args) : makeAnalyzer(ctx, agentConfig, analysisWorkspace),
    followupAnalyze: config.hub_root ? (...args) => makeAnalyzer(ctx, roleAgent(config.hub_root, 'followup'), analysisWorkspace)(...args) : undefined });
  await engine.initialize();
  if (config.journal_root) {
    try {
      const { createJournalRuntime, attachJournalChief } = await import('../life-journal/chief.mjs');
      const account = createHash('sha256').update(options.accountId).digest('hex');
      const runtime = await createJournalRuntime({ root: config.journal_root, ctx, agentConfig: config.hub_root ? hubConfig(config.hub_root).roles.journalDesigner ? roleAgent(config.hub_root, 'journalDesigner') : {} : agentConfig, rolePath: config.journal_role,
        scopeAllowed: scope => (scope.account === 'local' && scope.userId === 'owner') || (scope.account === account && engine.allowed(scope.userId)) });
      attachJournalChief(engine, runtime, options.accountId);
    } catch (error) { await engine.stop(); throw error; }
  }
  return engine;
}
