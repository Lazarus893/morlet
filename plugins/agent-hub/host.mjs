import { memoryTool } from './memory.mjs';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AgentHub, failure } from './store.mjs';
import { AgentCompanion } from './companion.mjs';
import { acquireCompanionLock } from './lock.mjs';
import { hubConfig } from './config.mjs';
import { dshProvider } from './dsh.mjs';
import { providers } from '../agent-bridge/providers.mjs';
import { reminderTool } from './reminders.mjs';
import { statusTool } from './status.mjs';
import { journalTool } from './journal.mjs';
import { routedSourcesTool as sourcesTool } from './source-bridge.mjs';
import { createFirstTaskFlow, firstTaskTool } from './first-task.mjs';
import { createJournalControl } from '../webui/journal-control.mjs';
import { createRoutineController, routineTool } from './routines.mjs';
import { assertRoutineToolAccess } from './actions.mjs';
import { python } from '../webui/server.mjs';

export const name = 'xiaoman-agent-hub';
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'sessionPersistence', 'tools'];

export async function startHost(ctx, root) {
  const config = hubConfig(root), hub = new AgentHub(root), runners = [];
  const firstTasks = createFirstTaskFlow({ hub });
  const read = () => python(root, { action: 'read' });
  const journal = createJournalControl({ root, readSettings: read });
  const routines = createRoutineController({ hub, journal, read });
  try {
    for (const agent of config.agents) {
      const directory = join(root, '.runtime/hub', agent.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'credential.json');
      try { writeFileSync(path, JSON.stringify({ token: randomBytes(32).toString('base64url') }), { mode: 0o600, flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (statSync(path).mode & 0o077) throw failure('PRIVATE_CONFIG_REQUIRED');
      const release = acquireCompanionLock(path);
      try {
        const { token } = JSON.parse(readFileSync(path, 'utf8'));
        hub.registerHost(agent, token);
        const companion = new AgentCompanion({ config: { ...agent, token }, statePath: join(directory, 'state.json'), provider: agent.provider === 'dsh' ? dshProvider(ctx) : providers[agent.provider],
          transport: async (operation, input) => {
            if (operation === 'tool') {
              const run = hub.get('run', input.runId);
              if (run?.firstTaskId && ['xiaoman_tasks', 'xiaoman_reminders', 'xiaoman_routines'].includes(input.tool)) throw failure('FORBIDDEN');
              assertRoutineToolAccess(run, input.tool, input.arguments);
            }
            const handler = operation === 'tool' && (input.tool === 'xiaoman_memory' ? memoryTool : input.tool === 'xiaoman_status' ? statusTool : input.tool === 'xiaoman_reminders' ? reminderTool : input.tool === 'xiaoman_journal' ? journalTool : input.tool === 'xiaoman_first_task' ? firstTaskTool : input.tool === 'xiaoman_sources' ? sourcesTool : input.tool === 'xiaoman_routines' ? routineTool : null);
            const result = handler ? await handler({ root, hub, journal, firstTasks, routines, token, input, read }) : hub[operation](token, input);
            if (operation === 'poll' && result.job?.firstTaskId) {
          const settings = await read();
          result.job.firstTask = { ...firstTasks.context(result.job), timezone: settings.config.proactive?.timezone && settings.config.proactive.timezone !== 'local' ? settings.config.proactive.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone };
        }
            return result;
          },
        });
        const tick = () => companion.tick().catch(e => ctx.logger(name).warn('Agent %s: %s', agent.id, e.code || 'HOST_UNAVAILABLE'));
        await tick();
        const timer = setInterval(tick, 500); timer.unref();
        runners.push({ companion, release, timer });
      } catch (e) { release(); throw e; }
    }
  } catch (e) {
    for (const r of runners) { clearInterval(r.timer); await r.companion.stop(); r.release(); }
    await journal.close(); hub.close(); throw e;
  }
  return { hub, async stop() {
    for (const r of runners) clearInterval(r.timer);
    await Promise.all(runners.map(async r => { try { await r.companion.stop(); } finally { r.release(); } }));
    await journal.close(); hub.close();
  } };
}

export function apply(ctx, config) {
  ctx.effect(async () => {
    const host = await startHost(ctx, config.root);
    return () => host.stop();
  }, 'xiaoman-agent-hub.lifecycle');
}
