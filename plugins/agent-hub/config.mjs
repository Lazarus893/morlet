import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { failure } from './store.mjs';
import { SOURCE_OPERATIONS } from './source-capabilities.mjs';
import { codexConnectionOptions } from '../agent-bridge/codex-app-server.mjs';

// This is instance configuration, never part of a release. Missing configuration
// means no automatic routing; an invalid file must not select a different agent.
export function hubConfig(root) {
  const path = join(root, '.runtime/agent-hub.json');
  let value;
  try {
    const st = statSync(path);
    if (st.mode & 0o077 || st.size > 65536) throw failure('PRIVATE_CONFIG_REQUIRED');
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return { version: 1, agents: [], roles: {} }; throw e; }
  if (value.version !== 1 || !Array.isArray(value.agents) || !value.roles || typeof value.roles !== 'object') throw failure('INVALID_HUB_CONFIG');
  const ids = new Set();
  for (const a of value.agents) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(a.id) || ids.has(a.id) || !['dsh', 'codex', 'workbuddy'].includes(a.provider) || typeof a.label !== 'string' || !a.label.trim() || a.label.length > 80 || typeof a.workspace !== 'string' || !a.workspace || /[\r\n\0]/.test(a.workspace) || !Number.isInteger(a.timeout_seconds) || a.timeout_seconds < 10 || a.timeout_seconds > 1800) throw failure('INVALID_HUB_CONFIG');
    if (a.provider === 'dsh' ? typeof a.agentPreset !== 'string' || !a.agentPreset || typeof a.permissionPreset !== 'string' || !a.permissionPreset : typeof a.command !== 'string' || !a.command || a.command.length > 4096 || /[\r\n\0]/.test(a.command)) throw failure('INVALID_HUB_CONFIG');
    for (const key of ['model', 'model_provider']) if (a[key] !== undefined && (typeof a[key] !== 'string' || a[key].length > 200 || /[\r\n\0]/.test(a[key]))) throw failure('INVALID_HUB_CONFIG');
    if (a.codex_connection !== undefined) {
      if (a.provider !== 'codex') throw failure('INVALID_HUB_CONFIG');
      try { a.codex_connection = codexConnectionOptions(a); } catch { throw failure('INVALID_HUB_CONFIG'); }
      if (a.codex_connection.transport !== 'stdio' && !isAbsolute(a.workspace)) throw failure('INVALID_HUB_CONFIG');
    }
    ids.add(a.id); a.workspace = resolve(root, a.workspace);
  }
  for (const [role, target] of Object.entries(value.roles)) if (!['conversation', 'observer', 'followup', 'journalDesigner'].includes(role) || target !== null && (typeof target !== 'string' || !target || target.length > 100)) throw failure('INVALID_HUB_CONFIG');
  if (value.sourceBridge !== undefined) {
    const bridge = value.sourceBridge;
    if (!bridge || Object.keys(bridge).some(key => !['endpointId', 'operations'].includes(key)) ||
        typeof bridge.endpointId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(bridge.endpointId) ||
        !Array.isArray(bridge.operations) || !bridge.operations.length ||
        bridge.operations.some(op => !Object.hasOwn(SOURCE_OPERATIONS, op)) ||
        new Set(bridge.operations).size !== bridge.operations.length) throw failure('INVALID_HUB_CONFIG');
  }
  return value;
}

export function roleAgent(root, role) {
  const config = hubConfig(root), id = config.roles[role];
  if (!id) throw failure('ROLE_UNCONFIGURED');
  const agent = config.agents.find(a => a.id === id);
  if (!agent) throw failure('ROLE_RUNTIME_UNAVAILABLE');
  return agent;
}
