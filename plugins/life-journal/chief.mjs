import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JournalStore } from './store.mjs';
import { JournalDesigner } from './designer.mjs';
import { makeAnalyzer } from '../proactive/index.mjs';

export function scopeForMessage(accountId, message) {
  if (typeof accountId !== 'string' || !accountId || typeof message?.from_user_id !== 'string' || !message.from_user_id.trim()) throw new Error('INVALID_SCOPE');
  return { account: createHash('sha256').update(accountId).digest('hex'), userId: message.from_user_id.trim() };
}

export async function createJournalRuntime({ root, ctx, store, agentConfig, analyze, rolePath, scopeAllowed }) {
  const ownsStore = !store;
  store ||= new JournalStore(root);
  try {
    if (!agentConfig) {
      try { agentConfig = JSON.parse(await readFile(join(root, '.runtime/agent.json'), 'utf8')); }
      catch { agentConfig = {}; }
    }
    const provider = agentConfig.provider || null;
    if (!analyze && (['codex', 'workbuddy'].includes(provider) || (provider === 'dsh' && ctx?.llm?.stream && ctx?.agentDefaultModel?.currentSelection))) {
      const workspace = join(root, '.runtime/journal-analysis');
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      // Twelve layout entries can exceed the short follow-up analysis budget.
      const analyzer = makeAnalyzer(ctx, agentConfig, workspace, { maxTokens: 8192 });
      analyze = async (...args) => {
        try { return await analyzer(...args); }
        catch (cause) {
          const known = ['PROACTIVE_INCOMPLETE_RESULT', 'PROACTIVE_OUTPUT_TOO_LARGE', 'PROACTIVE_TOOL_REJECTED'];
          const code = known.includes(cause?.message) ? cause.message : 'MODEL_REQUEST_FAILED';
          const finish = ['max-tokens', 'error', 'aborted', 'missing'].includes(cause?.finishKind) ? cause.finishKind : 'unknown';
          const size = Number.isSafeInteger(cause?.textCharacters) ? cause.textCharacters : 0;
          try { ctx?.logger?.('xiaoman-journal')?.warn('Design model failed: %s; finish=%s; textCharacters=%d', code, finish, size); }
          catch { /* The designer persists safe diagnostics; optional logging must not replace the original error. */ }
          throw cause;
        }
      };
    }
    const designer = new JournalDesigner({ root, store, analyze, scopeAllowed, rolePath: rolePath || join(root, 'agents/life-journal-designer/AGENT.md') });
    await designer.initialize();
    return { store, designer, ready: Boolean(analyze), provider,
      request: (scope, options) => designer.request(scope, options),
      async stop() { try { await designer.stop(); } finally { if (ownsStore) store.close(); } },
    };
  } catch (cause) { if (ownsStore) store.close(); throw cause; }
}

function command(text) {
  if (typeof text !== 'string') return null;
  const line = text.trim();
  if (/^\/journal(?:\s|$)/i.test(line)) return line;
  const match = line.match(/^手[账帳帐]\s+(新增|添加|完成|取消|撤销)\s+([\s\S]+)$/);
  if (!match) return /^手[账帳帐](?:\s|$)/.test(line) ? '/journal' : null;
  return `/journal ${{ 新增: 'add', 添加: 'add', 完成: 'done', 取消: 'cancel', 撤销: 'undo' }[match[1]]} ${match[2]}`;
}

export function attachJournalChief(engine, runtime, accountId) {
  engine.journalRuntime = runtime;
  const receive = engine.receive.bind(engine), management = engine.management.bind(engine), stop = engine.stop.bind(engine);
  engine.receive = async (message, text) => {
    const line = command(text);
    if (!line) return receive(message, text);
    if (engine.stopped || !message.from_user_id?.trim() || message.group_id || !engine.allowed(message.from_user_id.trim())) return null;
    // Preserve the channel's existing context freshness and delivery policy.
    await receive(message, text);
    const scope = scopeForMessage(accountId, message);
    if (line === '/journal' || line === '/journal list') {
      const items = runtime.store.snapshot(scope).items.filter(item => item.status !== 'cancelled').slice(-8);
      return items.length ? items.map(item => `${item.title}｜${item.status === 'done' ? '已完成' : '待处理'}\n${item.id}`).join('\n') : '手账目前没有事项。用 /journal add 标题，或“手账 新增 标题”记录。';
    }
    const messageId = message.message_id ?? message.client_id ?? message.seq;
    if ((typeof messageId !== 'string' && !Number.isSafeInteger(messageId)) || !String(messageId)) return '这条消息缺少稳定编号，尚未写入手账，请重新发送。';
    try {
      const result = runtime.store.ingest(scope, { text: line, sourceText: text, messageId: String(messageId), channel: 'weixin', ...(Number.isFinite(message.create_time_ms) ? { at: new Date(message.create_time_ms).toISOString() } : {}) });
      if (!result.accepted) return '手账用法：/journal add 标题；/journal done、cancel、undo 后加事项编号。';
      // A display failure never reverses a confirmed business write.
      let design;
      if (!result.duplicate) {
        try { design = await runtime.request(scope, { revision: result.snapshot.revision }); }
        catch { design = { accepted: false, status: 'unavailable' }; }
      }
      return result.duplicate ? '这条交代已经保存，没有重复写入。' : design?.accepted ? '已保存到生活手账。看板正在整理；这不创建额外微信提醒。' : '已保存到生活手账。当前使用基础排版；这不创建额外微信提醒。';
    } catch (cause) {
      return cause.code === 'ITEM_NOT_FOUND' ? '没找到这个手账事项。发 /journal 查看编号。' : '手账操作尚未完成，请查看当前事项后重试。';
    }
  };
  engine.management = async request => {
    if (request?.operation !== 'journal-design') return management(request);
    if (engine.stopped) throw new Error('PROACTIVE_STOPPED');
    const scope = request.scope || scopeForMessage(accountId, { from_user_id: request.userId });
    const ownAccount = createHash('sha256').update(accountId).digest('hex');
    if (!(scope.account === 'local' && scope.userId === 'owner') && (scope.account !== ownAccount || !engine.allowed(scope.userId))) throw new Error('INVALID_SCOPE');
    return { protocol: 1, journalDesign: await runtime.request(scope, { revision: request.revision }) };
  };
  engine.stop = async () => { try { await runtime.stop(); } finally { await stop(); } };
  return engine;
}
