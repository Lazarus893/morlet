import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { statusSnapshot } from '../plugins/agent-hub/status.mjs';
import { python } from '../plugins/webui/server.mjs';

const root = resolve(process.env.XIAOMAN_PROJECT_ROOT || dirname(fileURLToPath(import.meta.url)) + '/..');
const hub = new AgentHub(root);
try {
  const state = await statusSnapshot({ root, hub, read: () => python(root, { action: 'read' }) });
  if (process.argv.includes('--json')) console.log(JSON.stringify(state));
  else {
    console.log(`${state.light === 'green' ? '可用' : '需要留意'}：${state.summary}`);
    for (const c of state.channels) console.log(`- ${({ web: '网页', weixin: '微信', imessage: 'iMessage' })[c.id]}：${c.state}`);
    for (const a of state.agents) console.log(`- ${a.id === state.selectedEndpointId ? '当前处理助手' : '其他处理助手'}：${a.canExecute ? '已验证可处理' : '尚不能确认可执行'}；${a.reasons.join('；') || '最近任务与工具验证通过'}${process.argv.includes('--verbose') ? ` [${a.label}]` : ''}`);
    for (const a of state.attention.filter(a => a.kind !== 'execution')) console.log(`- 留意：${a.reason}`);
    console.log(`- 等你决定：${state.waiting.length} 项；受阻或排队：${state.blockedTasks.length} 项`);
    for (const a of state.waiting) console.log(`  ${a.title}：${a.preview}\n  ${a.choices.includes('approve') ? '批准 / 拒绝 / 延后' : '接受限制 / 拒绝'}（${a.id}）`);
    console.log(`- 主动关注：${state.reachOut.policy.mode}；今天已占用 ${state.reachOut.used.today}/${state.reachOut.policy.max_daily} 次；摘要等待 ${state.reachOut.pending} 项`);
    if (process.argv.includes('--verbose')) for (const service of state.localServices.items) console.log(`- 后台服务：${service.label} · ${service.state} · PID ${service.pid || '—'}${service.cleanupProposal ? '\n  清理建议（需本人确认）：' + service.cleanupProposal.command : ''}`);
    console.log('- 授权期限未提供时标记未知，不推断为永久有效。');
  }
} finally { hub.close(); }
