import { readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
let cached;

// Read only; never unload a daemon or print ProgramArguments/environment secrets.
export async function localServiceInventory(root) {
  if (process.platform !== 'darwin') return { supported: false, reason: '此宿主不使用 macOS 后台服务', items: [] };
  if (cached?.root === root && Date.now() - cached.at < 60000) return cached.value;
  const folder = join(homedir(), 'Library/LaunchAgents'), items = [];
  try {
    const files = (await readdir(folder)).filter(n => /^com\.xiaoman\.[a-zA-Z0-9_.-]+\.plist$/.test(n));
    const listing = await exec('/bin/launchctl', ['list'], { timeout: 3000, maxBuffer: 262144 });
    const loaded = new Map(listing.stdout.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 3).map(([pid, exit, label]) => [label, { pid: /^\d+$/.test(pid) ? Number(pid) : null, exit: /^-?\d+$/.test(exit) ? Number(exit) : null }]));
    for (const file of files) {
      try {
        const parsed = JSON.parse((await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(folder, file)], { timeout: 2000, maxBuffer: 65536 })).stdout);
        const label = file.slice(0, -6); if (parsed.Label !== label) continue;
        const state = loaded.get(label), belongsToInstance = typeof parsed.WorkingDirectory === 'string' && resolve(parsed.WorkingDirectory) === resolve(root);
        let missing = false;
        for (const path of [parsed.WorkingDirectory, parsed.ProgramArguments?.[0]].filter(p => typeof p === 'string' && p.startsWith('/'))) try { await access(path); } catch { missing = true; }
        const needsAttention = belongsToInstance && (missing || parsed.KeepAlive === true && !state?.pid);
        items.push({ label, belongsToInstance, state: missing ? 'missing_path' : state?.pid ? 'running' : state ? 'idle_or_exited' : 'not_loaded', pid: state?.pid || null, lastExit: state?.exit ?? null, needsAttention,
          suggestion: missing ? '路径已经失效，可核对后停用这项旧后台服务。' : needsAttention ? '常驻服务尚未运行，请先核对退出原因。' : null,
          ...(missing && belongsToInstance ? { cleanupProposal: { title: '停用这项旧后台服务', consequence: '会停止该服务；保留配置文件。需要本人明确确认后执行。', command: `launchctl bootout gui/${process.getuid()}/${label}` } } : {}) });
      } catch { items.push({ label: file.slice(0, -6), state: 'unknown', needsAttention: true, suggestion: '服务配置尚未能读取，需人工核对。' }); }
    }
    const value = { supported: true, items }; cached = { root, at: Date.now(), value }; return value;
  } catch { return { supported: true, error: 'SERVICE_INVENTORY_UNAVAILABLE', items }; }
}
