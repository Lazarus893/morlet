#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hubConfig } from '../plugins/agent-hub/config.mjs';
import { verifySetupAgent } from '../plugins/agent-bridge/setup-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
try {
  const path = join(root, '.runtime/agent-hub.json'), original = await readFile(path, 'utf8');
  const config = hubConfig(root), agent = config.agents.find(a => a.id === config.roles.conversation);
  if (!agent || !['codex', 'workbuddy'].includes(agent.provider)) throw new Error('LOCAL_AGENT_REQUIRED');
  const check = await verifySetupAgent(agent);
  if (await readFile(path, 'utf8') !== original) throw new Error('CONFIGURATION_CHANGED');
  if (check.model) {
    const raw = JSON.parse(original), selected = raw.agents.find(a => a.id === agent.id);
    selected.model = check.model;
    const temporary = path + '.setup-' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  const evidence = join(root, '.runtime/setup-agent-check.json');
  await writeFile(evidence + '.tmp', JSON.stringify({ ...check, endpointId: agent.id }, null, 2) + '\n', { mode: 0o600 });
  await rename(evidence + '.tmp', evidence);
  process.stdout.write(JSON.stringify(check) + '\n');
} catch (error) {
  const code = /^[A-Z_]{3,80}$/.test(error.message || '') ? error.message : 'AGENT_SETUP_FAILED';
  process.stderr.write(JSON.stringify({ ok: false, code }) + '\n'); process.exitCode = 1;
}
