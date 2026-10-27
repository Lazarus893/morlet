import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { failure } from '../agent-hub/store.mjs';
const exec = promisify(execFile);

/** Runs only on the Mac hosting this loopback Web UI, never on a remote visitor. */
export function createLocalAgentSetup({ root, hub, execute = exec }) {
  let busy = false;
  const run = (script, args) => execute(process.env.PA_PYTHON || 'python3', [join(root, 'scripts', script), ...args],
    { cwd: root, timeout: 110000, maxBuffer: 32768 });
  return async ({ provider, workspace }, origin) => {
    if (!['codex', 'workbuddy'].includes(provider) || workspace != null && typeof workspace !== 'string') throw failure('INVALID_INPUT');
    if (busy) throw failure('BUSY');
    busy = true;
    let pairing, fresh = false, source;
    try {
      const { stdout } = await run('connect.py', ['discover', '--json']);
      const discovery = JSON.parse(stdout), agent = discovery.agents.find(a => a.provider === provider);
      if (!agent?.installed || !discovery.node) throw failure('LOCAL_AGENT_NOT_INSTALLED');
      let directory;
      if (workspace?.trim()) {
        const requested = workspace.startsWith('~/') ? join(homedir(), workspace.slice(2)) : workspace;
        if (!isAbsolute(requested)) throw failure('LOCAL_WORKSPACE_REQUIRED');
        directory = resolve(requested);
        if (!(await stat(directory)).isDirectory()) throw failure('LOCAL_WORKSPACE_REQUIRED');
      } else {
        directory = join(root, '.runtime/agent-workspaces', provider);
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      const base = join(root, '.runtime/local-agent-setup');
      await mkdir(base, { recursive: true, mode: 0o700 });
      // One default connection per provider; additional workspaces use explicit pairing.
      source = join(base, provider + '.json');
      let prior;
      try {
        const info = await stat(source);
        if (info.mode & 0o077 || info.size > 16000 || process.getuid && info.uid !== process.getuid()) throw failure('PRIVATE_CONFIG_REQUIRED');
        prior = JSON.parse(await readFile(source, 'utf8'));
        const endpoint = hub.authenticate(prior.token);
        if (endpoint.provider !== provider || endpoint.id !== prior.endpointId) throw failure('PRIVATE_CONFIG_REQUIRED');
        if (prior.workspace !== directory || prior.endpoint !== origin) throw failure('LOCAL_AGENT_ALREADY_PAIRED');
        return { endpointId: endpoint.id, reused: true,
          note: '已存在此连接；以执行端的在线状态为准。离线时运行 connect agent --config 对应配置 重新安装。' };
      } catch (error) {
        if (!['ENOENT', 'BRIDGE_UNAUTHORIZED'].includes(error.code)) throw error;
      }
      pairing = hub.pair({ label: provider === 'codex' ? 'Codex' : 'WorkBuddy', provider }); fresh = true;
      const config = { ...pairing, provider, label: provider === 'codex' ? 'Codex' : 'WorkBuddy', command: agent.command,
        workspace: directory, endpoint: origin, publicOrigin: origin, timeout_seconds: 300 };
      const temporary = join(base, randomUUID() + '.json');
      try {
        await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
        await run('install-agent-companion.py', ['--kind', 'agent', '--config', temporary]);
        await rename(temporary, source);
      } finally { await rm(temporary, { force: true }); }
      return { endpointId: pairing.endpointId, installed: true, reused: false,
        note: '连接助手已安装，等待心跳上线。首次任务将验证 CLI 登录。' };
    } catch (error) {
      if (fresh) hub.revoke(pairing.endpointId);
      if (['INVALID_INPUT', 'LOCAL_AGENT_NOT_INSTALLED', 'LOCAL_WORKSPACE_REQUIRED', 'LOCAL_AGENT_ALREADY_PAIRED', 'PRIVATE_CONFIG_REQUIRED'].includes(error.code)) throw error;
      // Native diagnostics can contain credentials or account details.
      throw failure('LOCAL_AGENT_SETUP_FAILED');
    } finally { busy = false; }
  };
}
