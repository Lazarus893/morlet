import { randomUUID } from 'node:crypto';
import { JsonProcess } from './process.mjs';
import { CodexRun, getCodexConnection } from './codex-app-server.mjs';
export { closeCodexConnections } from './codex-app-server.mjs';

export async function runCodex(config, prompt, context) {
  const passive = context.passive === true;
  const routine = !!context.routine;
  if (routine && context.routine.scope?.publicWeb !== false) throw Object.assign(new Error('ROUTINE_PUBLIC_WEB_UNSUPPORTED'), { code: 'ROUTINE_PUBLIC_WEB_UNSUPPORTED' });
  if (context.reasoningEffort !== undefined && (!passive || !['low', 'medium', 'high', 'xhigh'].includes(context.reasoningEffort))) throw new Error('AGENT_INVALID_REASONING_EFFORT');
  if (context.signal?.aborted) throw new Error('AGENT_CANCELLED');
  const connection = getCodexConnection(config);
  const proc = new CodexRun(connection, context, config.timeout_seconds * 1000);
  let threadId;
  let finalText = '';
  let lastText = '';
  const items = new Map();
  proc.onMessage = async message => {
    const { method, params: p = {}, id } = message;
    if (p.threadId && threadId && p.threadId !== threadId) return;
    // Observers must not reorder native item/terminal state by awaiting I/O.
    if (id === undefined && /^(?:item\/|turn\/)/.test(method || '')) {
      Promise.resolve(context.onEvent?.({ method, params: p })).catch(error => proc.fail(error));
    }
    if (id !== undefined && method) {
      if (method === 'item/tool/call' && context.callTool && !passive) {
        try {
          const result = await context.callTool(p.tool, p.arguments, p.callId, { signal: proc.signal });
          proc.send({ id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } });
        } catch (error) {
          proc.send({ id, result: { success: false, contentItems: [{ type: 'inputText', text: error.code || 'TOOL_FAILED' }] } });
        }
      } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        if (passive || routine) {
          proc.send({ id, result: { decision: 'decline' } });
          proc.fail(new Error('AGENT_PASSIVE_TOOL_REJECTED')); return;
        }
        const detail = method.includes('commandExecution')
          ? { command: p.command, cwd: p.cwd, reason: p.reason }
          : { reason: p.reason, grantRoot: p.grantRoot, changes: items.get(p.itemId)?.changes };
        const reviewable = method.includes('commandExecution')
          ? typeof detail.command === 'string' && detail.command.trim() && typeof detail.cwd === 'string' && detail.cwd
          : Array.isArray(detail.changes) && detail.changes.length > 0 && detail.changes.every(change =>
            typeof change?.path === 'string' && change.path && typeof change.diff === 'string');
        if (!reviewable) { proc.send({ id, result: { decision: 'decline' } }); return; }
        const allow = await context.approve({ toolName: method.includes('commandExecution') ? 'Bash' : 'FileChange',
          reason: JSON.stringify(detail), signal: proc.signal });
        proc.send({ id, result: { decision: allow ? 'accept' : 'decline' } });
      } else if (method === 'item/permissions/requestApproval') {
        // Broader permission grants need a distinct UI; fail closed.
        proc.send({ id, result: { permissions: {}, scope: 'turn' } });
      } else {
        proc.send({ id, error: { code: -32601, message: 'Unsupported PA interaction; no permission granted' } });
        proc.fail(new Error('AGENT_UNSUPPORTED_INTERACTION'));
      }
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (passive && p.item && !['agentMessage', 'reasoning', 'userMessage', 'plan'].includes(p.item.type)) {
        proc.fail(new Error('AGENT_PASSIVE_TOOL_REJECTED'));
        return;
      }
      if (p.item) items.set(p.item.id, p.item);
      if (method === 'item/completed' && p.item?.type === 'agentMessage') {
        if (p.item.phase === 'final_answer') finalText = p.item.text;
        if (!p.item.phase || p.item.phase === 'final_answer') lastText = p.item.text;
      }
    }
    if (method === 'turn/completed') {
      if (p.turn?.status !== 'completed') {
        const detail = p.turn?.error, info = detail?.codexErrorInfo;
        const exhausted = info?.responseTooManyFailedAttempts || info?.response_too_many_failed_attempts;
        const rateLimited = ['usageLimitExceeded', 'rateLimitExceeded'].includes(info) ||
          (exhausted?.httpStatusCode ?? exhausted?.http_status_code) === 429 || /\b429\b.*Too Many Requests/i.test(String(detail?.message || ''));
        const code = info === 'unauthorized' ? 'AGENT_AUTH_REQUIRED' :
          rateLimited ? 'AGENT_RATE_LIMITED' :
          /model.{0,160}(?:not supported|not available|not found)|unsupported model/i.test(String(detail?.message || '')) ? 'AGENT_MODEL_UNAVAILABLE' :
          'AGENT_TURN_' + String(p.turn?.status || 'FAILED').toUpperCase();
        proc.fail(new Error(code));
      }
      else if (!(finalText || lastText).trim()) proc.fail(new Error('AGENT_EMPTY_REPLY'));
      else proc.finish({ text: finalText || lastText, sessionId: threadId });
    }
  };
  try {
    await Promise.race([connection.ready, proc.done.promise]);
    if (context.sessionId) proc.bind(context.sessionId);
    const effective = await proc.request('config/read', { cwd: config.workspace, includeLayers: false });
    const servers = Object.keys(effective?.config?.mcp_servers || {});
    const params = {
      cwd: config.workspace, approvalPolicy: passive ? 'never' : 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only',
      developerInstructions: context.instructions,
      config: {
        mcp_servers: Object.fromEntries(servers.map(name => [name, { enabled: false }])),
        'features.plugins': false,
        'features.apps': false,
        'sandbox_workspace_write.network_access': false,
        'sandbox_workspace_write.writable_roots': [],
        'sandbox_workspace_write.exclude_slash_tmp': true,
        'sandbox_workspace_write.exclude_tmpdir_env_var': true,
      },
    };
    if (passive || routine) {
      params.ephemeral = true;
      if (context.reasoningEffort !== undefined) params.config.model_reasoning_effort = context.reasoningEffort;
      Object.assign(params.config, { 'features.shell_tool': false, 'features.multi_agent': false,
        'agents.enabled': false, 'features.multi_agent_v2': false, 'features.apply_patch_freeform': false,
        'web_search': 'disabled', 'project_doc_max_bytes': 0 });
    }
    if (config.model) params.model = config.model;
    if (context.tools && !passive && !context.sessionId) params.dynamicTools = context.tools;
    if (context.sessionId) params.threadId = context.sessionId;
    const started = await proc.request(context.sessionId ? 'thread/resume' : 'thread/start', params);
    threadId = started.thread.id;
    if (started.thread.status?.type === 'active' || started.thread.turns?.some(turn => turn.status === 'inProgress')) throw Object.assign(new Error('AGENT_THREAD_BUSY'), { code: 'AGENT_THREAD_BUSY' });
    proc.bind(threadId);
    await context.onSession(threadId);
    await context.onCapabilities?.(threadId, context.sessionId ? context.knownTools || [] : (context.tools || []).map(t => t.name));
    await proc.request('turn/start', {
      threadId, cwd: config.workspace, approvalPolicy: passive ? 'never' : 'untrusted', approvalsReviewer: 'user',
      input: [{ type: 'text', text: prompt }],
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    return await proc.done.promise;
  } catch (error) {
    proc.fail(error);
    return await proc.done.promise;
  }
}

export async function runWorkbuddy(config, prompt, context) {
  const sessionId = context.sessionId || randomUUID();
  let sessionSave = Promise.resolve();
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: context.passive ? {} : context.mcpServers || {} }),
    '--append-system-prompt', context.instructions,
    context.sessionId ? '--resume' : '--session-id', sessionId];
  if (context.routine) throw Object.assign(new Error('ROUTINE_SCOPE_UNSUPPORTED'), { code: 'ROUTINE_SCOPE_UNSUPPORTED' });
  if (!context.passive) args.push('--tools', 'Read,Glob,Grep');
  if (context.passive) args.push('--tools', '', '--no-session-persistence', '--max-turns', '1',
    '--settings', '{"disableAllHooks":true}');
  if (config.model) args.push('--model', config.model);
  const proc = new JsonProcess(config.command, args, {
    cwd: config.workspace, signal: context.signal, timeoutMs: config.timeout_seconds * 1000,
  });
  proc.onMessage = async message => {
    if (message.type === 'control_request') {
      if (message.request?.subtype !== 'can_use_tool') {
        proc.fail(new Error('AGENT_UNSUPPORTED_INTERACTION'));
        return;
      }
      const allow = await context.approve({ toolName: message.request.tool_name || 'Tool',
        reason: JSON.stringify(message.request.input || {}), signal: context.signal });
      proc.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
        response: { allowed: allow, reason: allow ? '用户批准本次操作' : '用户拒绝或审批未完成', interrupt: !allow } } });
    } else if (message.type === 'system' && message.subtype === 'init') {
      sessionSave = sessionSave.then(() => context.onSession(message.session_id || sessionId));
      await sessionSave;
    } else if (message.type === 'error') {
      proc.fail(new Error('AGENT_PROTOCOL_ERROR'));
    } else if (message.type === 'result') {
      if (message.is_error || message.subtype !== 'success') {
        context.onDiagnostic?.({ subtype: message.subtype, errors: message.errors, result: message.result });
        const authenticationRequired = (Array.isArray(message.errors) ? message.errors : []).some(error => typeof error === 'string' && /\b401\b|Authentication required/i.test(error));
        proc.fail(new Error(authenticationRequired ? 'AGENT_AUTH_REQUIRED' : 'AGENT_TURN_FAILED'));
      }
      else if (typeof message.result !== 'string' || !message.result.trim()) proc.fail(new Error('AGENT_EMPTY_REPLY'));
      else {
        await sessionSave;
        proc.finish({ text: message.result, sessionId: message.session_id || sessionId });
      }
    }
  };
  try {
    proc.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    return await proc.done.promise;
  } finally { proc.close(); await proc.exited.promise; await sessionSave.catch(() => {}); }
}

export const providers = { codex: runCodex, workbuddy: runWorkbuddy };
