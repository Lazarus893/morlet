#!/usr/bin/env node
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { IMessageCompanion, loadMessageConfig } from '../plugins/agent-hub/imessage.mjs';
import { acquireMessageCompanionLock } from '../plugins/agent-hub/lock.mjs';
const configPath = resolve(process.argv[2] || '.runtime/imessage-companion.json');
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
let release, companion, stoppedBy = 'IMESSAGE_BRIDGE_STOPPED';
try {
  const config = loadMessageConfig(configPath);
  if (process.platform !== 'darwin') throw new Error('MACOS_REQUIRED');
  release = acquireMessageCompanionLock(config);
  companion = new IMessageCompanion({ config, statePath: configPath + '.state.sqlite' });
  await companion.prepare();
  const watch = companion.watch(controller.signal).catch(error => { stoppedBy = error.code || 'IMESSAGE_WATCH_STOPPED'; console.error(stoppedBy); controller.abort(); });
  let offline = false;
  while (!controller.signal.aborted) {
    try { await companion.tick(); offline = false; }
    catch (error) { if (!offline) console.error(error.code || 'MESSAGE_BRIDGE_UNAVAILABLE'); offline = true; if (error.code === 'BRIDGE_UNAUTHORIZED') controller.abort(); }
    await delay(1000);
  }
  await watch;
} catch (error) { stoppedBy = error.code || 'IMESSAGE_SETUP_REQUIRED'; console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'IMESSAGE_SETUP_REQUIRED'); process.exitCode = 1; }
finally { controller.abort(); await companion?.status(false, stoppedBy).catch(() => {}); companion?.close(); release?.(); }
