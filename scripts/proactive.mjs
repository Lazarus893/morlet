#!/usr/bin/env node
// Local inspection only. This command cannot send messages or invoke a model.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deliveryGate, eligibleTasks } from '../plugins/proactive/policy.mjs';
import { fallbackText, welcomeText } from '../plugins/proactive/sniper.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const action = process.argv[2] || 'status';
if (!['status', 'preview'].includes(action)) {
  console.error('Usage: ./scripts/pa.sh proactive status|preview'); process.exit(2);
}
try {
  let config;
  try { config = JSON.parse(await readFile(join(root, '.runtime/proactive.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('尚未生成主动跟进配置；先运行 init --proactive on 和 configure。'); process.exit(0);
  }
  if (config.timezone === 'local') config.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const results = [];
  for (const name of await readdir(config.state_dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const state = JSON.parse(await readFile(join(config.state_dir, name), 'utf8'));
    for (const [id, user] of Object.entries(state.users)) {
      const gate = deliveryGate(user, config, Date.now());
      const task = eligibleTasks(user, Date.now())[0];
      const report = { account: name.slice(0, 8), user: id, blocked_by: gate,
        preferences: { ...config, ...user.preferences }, tasks: user.tasks, events: user.events };
      delete report.preferences.agent_config; delete report.preferences.state_dir;
      if (action === 'preview') report.preview = task ? {
        task_id: task.id, eligible_by_local_policy: !gate,
        text: task.kind === 'welcome' ? welcomeText(user, report.preferences.max_chars) : fallbackText(task, config.timezone),
        note: '本地参考文案；实际发送前还需检查活跃会话和狙击者判断，本命令不发送。',
      } : null;
      results.push(report);
    }
  }
  console.log(JSON.stringify({ configured_enabled: config.enabled, timezone: config.timezone, accounts: results }, null, 2));
} catch {
  console.error('无法读取主动跟进配置/台账；请检查本机文件（未输出原始错误或凭据）。');
  process.exitCode = 2;
}
