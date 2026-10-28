#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentCompanion, loadAgentConfig } from '../plugins/agent-hub/companion.mjs';
import { acquireCompanionLock } from '../plugins/agent-hub/lock.mjs';
import { SourceCompanion, sourceTransport } from '../plugins/agent-hub/source-companion.mjs';

export async function runCompanion(configPath) {
  const config = loadAgentConfig(configPath), release = acquireCompanionLock(configPath);
  let companion, sources;
  try {
    companion = createAgentCompanion({ config, statePath: configPath + '.state' });
    sources = new SourceCompanion({ root: fileURLToPath(new URL('..', import.meta.url)), statePath: configPath + '.sources-state', transport: sourceTransport(config) });
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    let previous;
    while (!stopping) {
      try { await companion.tick(); await sources.tick(); if (previous !== 'connected') console.log('Local agent companion connected.'); previous = 'connected'; }
      catch (error) { if (error.code === 'BRIDGE_UNAUTHORIZED') { companion.controller?.abort(); throw error; } if (previous !== 'offline') console.error('Agent hub unavailable; local results remain queued.'); previous = 'offline'; }
      await delay(1000);
    }
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  } finally {
    try { await sources?.stop(); await companion?.stop(); } finally { release(); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = resolve(process.argv[2] || '.runtime/agent-companion.json');
  runCompanion(configPath).catch(error => { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'AGENT_COMPANION_FAILED'); process.exitCode = 1; });
}
