import { AgentHub } from '../plugins/agent-hub/store.mjs';
// Only loaded by the isolated native integration test. No model or network calls.
export const name = 'dsh-hub-fixture';
export const inject = ['llm', 'tools', 'approval', 'web'];
export function apply(ctx) {
  ctx.web.registerFetchProvider({ id: 'fixture-web', available: () => true, fetch: async ({ url }) => ({ url, statusCode: 200,
    body: { kind: 'html', content: '<!--' + 'x'.repeat(450000) + '--><main><h2>真实 preset 转码边界验收</h2><p>已读到导航之后的完整正文。</p></main>' },
    truncated: url.endsWith('/incomplete') }) });
  ctx.tools.register({ name: 'fixture_approval', description: 'Ask for a harmless fixture approval', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (_args, exec) => ({ outcome: await ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: 'fixture_approval', reason: '仅测试审批协议，不执行外部操作', signal: exec.signal }) }),
  });
  ctx.on('llm/stream', async function* (options) {
    const messages = options.messages;
    const userIndex = messages.findLastIndex(m => m.role === 'user' && m.source?.kind === 'user');
    const turn = messages[userIndex]?.content.filter(b => b.type === 'text').map(b => b.text).join('') || '';
    // This deterministic fixture dispatches on the current request only. The
    // preceding handoff can contain old approvals and must never replay them.
    const prompt = turn.split('\n\n本轮用户原话（以此为当前请求）：\n').at(-1);
    const results = messages.slice(userIndex + 1).flatMap(m => m.content).filter(b => b.type === 'tool-result');
    const toolName = prompt.includes('网页') ? 'web_fetch' : prompt.includes('审批') ? 'xiaoman_tasks' : prompt.includes('待办') ? 'xiaoman_tasks' : prompt.includes('汇报') ? 'xiaoman_report' : prompt.includes('通道状态') ? 'xiaoman_status' : null;
    if (prompt.includes('后台范围验收') && results.length === 1) {
      const denied = results[0].isError === true;
      yield { type: 'tool-call-delta', index: 0, id: 'fixture-result-' + crypto.randomUUID(), name: 'xiaoman_routines', argumentsDelta: JSON.stringify({
        operation: 'result', outcome: denied ? 'blocked' : 'checked', matched: !denied, summary: denied ? '网页不在本次资料范围' : '读取了约定网页',
        checks: denied ? [] : [{ source: 'https://example.com/complete', observedAt: Date.now() }],
        facts: denied ? [] : [{ key: 'fixture-scope-page', summary: '约定网页已核实', url: 'https://example.com/complete' }],
      }) };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else if (toolName && !results.length) {
      if (!options.tools?.some(t => t.name === toolName)) throw new Error('FIXTURE_TOOL_MISSING');
      const store = new AgentHub(process.env.XIAOMAN_PROJECT_ROOT);
      const task = store.all('task')[0]; store.close();
      const args = toolName === 'web_fetch' ? { url: 'https://example.com/' + (prompt.includes('截断') ? 'incomplete' : 'complete') } : prompt.includes('审批') ? { operation: 'cancel', taskId: task.id, version: task.version } : toolName === 'xiaoman_tasks' ? { operation: 'add', title: '原生 DSH 共享待办' } : toolName === 'xiaoman_report' ? { title: '原生 DSH 产物验收', summary: '完成测试文档', outcome: 'completed', artifacts: [{ label: '测试文档', path: process.env.XIAOMAN_PROJECT_ROOT + '/.runtime/workspace/native-result.md' }] } : {};
      yield { type: 'tool-call-delta', index: 0, id: 'fixture-' + crypto.randomUUID(), name: toolName, argumentsDelta: JSON.stringify(args) };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      const original = messages.filter(m => m.role === 'user' && m.source?.kind === 'user').length;
      const text = `DSH 原生完成：${prompt}；会话轮数 ${original}；${JSON.stringify(results)}`;
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }, { prepend: true });
}
