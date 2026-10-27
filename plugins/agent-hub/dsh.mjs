import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { failure } from './store.mjs';
import { nativeActionPolicy } from './actions.mjs';

// Read only this turn's official durable tool receipts. Rendered text and model
// claims cannot replace the tool's effective truncation/error metadata.
export function nativeSourceReceipts(events) {
  const calls = new Map(), receipts = [];
  for (const event of events) {
    const data = event.data || {};
    if (event.type === 'tool/call' && ['web_fetch', 'web_search'].includes(data.name)) {
      let args;
      try { args = JSON.parse(data.arguments); } catch { continue; }
      calls.set(data.callId, { tool: data.name, args });
    }
    if (event.type !== 'tool/result') continue;
    for (const block of data.message?.content || []) {
      const call = block.type === 'tool-result' && calls.get(block.toolCallId);
      if (!call) continue;
      if (!Number.isSafeInteger(event.time) || event.time < 0) throw failure('INVALID_NATIVE_SOURCE_RECEIPT');
      const meta = data.meta;
      let sources = [], status = block.isError || data.error ? 'failed' : 'incomplete';
      if (call.tool === 'web_fetch') {
        try {
          const url = new URL(call.args.url);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
          url.hash = '';
          if (url.href.length > 2048) continue;
          sources = [url.href];
        } catch { continue; }
        if (status !== 'failed' && Number.isInteger(meta?.statusCode)) {
          status = meta.statusCode < 200 || meta.statusCode >= 300 ? 'failed' : meta.truncated === false ? 'completed' : 'incomplete';
        }
      } else {
        sources = Array.isArray(call.args.queries) ? call.args.queries.filter(query => typeof query === 'string' && query.trim() && query.length <= 500).map(query => 'search:' + query.trim()) : [];
        if (status !== 'failed' && Array.isArray(meta?.sources) && meta.truncated === false) status = 'completed';
      }
      for (const source of sources) receipts.push({ tool: call.tool, source, status, observedAt: event.time });
    }
  }
  return receipts;
}

/** Native DSH adapter. Presets, permissions, tools and persistence stay in DSH. */
export function dshProvider(ctx) {
  return async (config, prompt, options) => {
    const sessionId = SessionId(options.sessionId || 'xiaoman-' + randomUUID());
    if (ctx.agents.get(sessionId)) throw failure('AGENT_SESSION_BUSY');
    const route = ctx.agentDefaultModel.currentSelection();
    const agentOptions = { provider: config.model_provider || route.provider, model: config.model || route.model };
    ctx.permissionPresets.resolve(config.permissionPreset);
    const setup = async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, config.agentPreset);
      // Resume preserves the persisted permission preset. New sessions receive
      // the instance's configured preset, with the host's sandbox still applied.
      if (!options.sessionId) ctx.permissionPresets.set((agent || agentCtx.get('agent')).session, config.permissionPreset);
      // PTC's worker-thread runtime is bash-equivalent, not a sandbox. Native
      // presentation keeps every capability behind the host's typed boundary.
      agentCtx.tools.presentAs('native');
      agentCtx.tools.guard(exec => nativeActionPolicy(exec.name, exec.arguments, options.routine) === 'blocked'
        ? '此操作没有受控的生活动作预览，不能执行。请使用小满的只读资料/手账工具，或保留草稿并说明限制。' : undefined);
      if (options.routine) agentCtx.on('tools/execute', async (exec, next) => {
        if (!['web_search', 'web_fetch'].includes(exec.name)) return next();
        // A public read also checks the current server lease/scope immediately
        // before dispatch and before releasing bytes; a revoked old snapshot
        // cannot continue through the native provider between polling ticks.
        const check = async () => {
          exec.signal.throwIfAborted();
          await options.callTool('xiaoman_routines', { operation: 'get', id: options.routine.id }, 'native-scope:' + String(exec.callId));
          exec.signal.throwIfAborted();
        };
        await check(); const result = await next(); await check(); return result;
      }, { prepend: true });
      for (const tool of options.tools || []) agentCtx.tools.register({
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: (args, exec) => {
          if (exec.signal.aborted || String(exec.agent?.session.id) !== String(sessionId)) throw failure('FORBIDDEN');
          return options.callTool(tool.name, args, String(exec.callId));
        },
      });
    };
    const handle = options.sessionId
      ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      : await ctx.agents.create({ sessionId, meta: { cwd: config.workspace, agentPreset: config.agentPreset }, agentOptions, setup });
    const agent = handle.agent;
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(config.timeout_seconds * 1000)]);
    const cancel = () => agent.cancel({ kind: 'user' });
    signal.addEventListener('abort', cancel, { once: true });
    const off = agent.ctx.on('approval/request', async request => {
      if (signal.aborted || request.signal?.aborted) return 'cancelled';
      const call = [...agent.session.log].reverse().find(e => e.type === 'tool/call' && e.data.callId === request.callId);
      const reason = [request.reason, call?.data.arguments].filter(Boolean).join('\n');
      // Oversized requests are refused by the companion, never invisibly trimmed.
      const allowed = await options.approve({ toolName: request.toolName, reason: reason || '操作需要批准', signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal });
      return signal.aborted || request.signal?.aborted ? 'cancelled' : allowed ? 'allowed-once' : 'rejected';
    }, { prepend: true });
    try {
      signal.throwIfAborted();
      await options.onSession(String(sessionId));
      await options.onCapabilities?.(String(sessionId), (options.tools || []).map(t => t.name));
      agent.inject(createUserMessage({ content: [{ type: 'text', text: options.instructions }], source: { kind: 'plugin', plugin: 'xiaoman-hub', form: 'instructions' } }));
      const start = agent.session.log.length;
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
      await agent.whenIdle();
      if (signal.aborted) throw failure('AGENT_TIMEOUT');
      const events = agent.session.log.slice(start);
      for (const receipt of nativeSourceReceipts(events)) await options.onSourceRead?.(receipt);
      const end = events.findLast(e => e.type === 'turn/end');
      if (end?.data.reason.kind === 'error') throw failure('DSH_TURN_FAILED');
      const final = events.findLast(e => e.type === 'assistant/message' && !e.data.message.content.some(b => b.type === 'tool-call'));
      const text = final?.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!text) throw failure('AGENT_EMPTY_REPLY');
      return { text };
    } finally {
      off(); signal.removeEventListener('abort', cancel);
      if (agent.status !== 'idle') { cancel(); await agent.whenIdle(); }
      await handle.dispose();
    }
  };
}
