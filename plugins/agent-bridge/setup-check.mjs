import { JsonProcess } from './process.mjs';
import { providers } from './providers.mjs';

/** Discover through the user's CLI; never read/copy its token or change global config. */
export async function inspectCodex(config) {
  const proc = new JsonProcess(config.command, ['app-server', '--listen', 'stdio://', '--disable', 'plugins', '--disable', 'apps'],
    { cwd: config.workspace, timeoutMs: 30000 });
  proc.onMessage = message => {
    if (message.id !== undefined && message.method) proc.send({ id: message.id, error: { code: -32601, message: 'Setup does not grant permissions' } });
  };
  try {
    await proc.request('initialize', { clientInfo: { name: 'xiaoman_setup', version: '0.1.0' } });
    proc.send({ method: 'initialized', params: {} });
    const account = await proc.request('account/read', { refreshToken: false });
    if (account.requiresOpenaiAuth && !account.account) throw new Error('AGENT_AUTH_REQUIRED');
    const effective = await proc.request('config/read', { cwd: config.workspace, includeLayers: false });
    const models = [], cursors = new Set();
    let cursor;
    do {
      const page = await proc.request('model/list', { limit: 100, ...(cursor && { cursor }) });
      if (!Array.isArray(page.data) || models.length + page.data.length > 500) throw new Error('AGENT_MODEL_CATALOG_INVALID');
      models.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('AGENT_MODEL_CATALOG_INVALID');
      cursors.add(cursor);
    } while (cursor);
    return { configuredModel: effective.config?.model || '', models };
  } finally { proc.close(); await proc.exited.promise; }
}

export function selectSetupModel(config, catalog) {
  const models = catalog.models.filter(m => typeof m.model === 'string' && m.model.length <= 200 && !/[\x00-\x20]/.test(m.model) && m.hidden !== true);
  // An explicitly chosen instance model is authoritative; never silently substitute it.
  if (config.model) {
    if (!models.some(m => m.model === config.model)) throw new Error('AGENT_MODEL_UNAVAILABLE');
    return { model: config.model, selection: 'instance' };
  }
  const configured = models.find(m => m.model === catalog.configuredModel);
  const selected = configured || models.find(m => m.isDefault === true);
  if (!selected) throw new Error('AGENT_MODEL_SELECTION_REQUIRED');
  return { model: selected.model, selection: configured ? 'cli-configured' : 'catalog-default' };
}

export async function verifySetupAgent(config, { inspect = inspectCodex, run = providers[config.provider] } = {}) {
  const selected = config.provider === 'codex' ? selectSetupModel(config, await inspect(config)) : { ...(config.model && { model: config.model }), selection: 'cli-configured' };
  if (typeof run !== 'function') throw new Error('AGENT_PROVIDER_UNSUPPORTED');
  // A catalog is not proof of availability. Exercise the actual passive adapter once.
  const result = await run({ ...config, ...selected, timeout_seconds: 90 }, 'Reply exactly XIAOMAN_READY.', {
    passive: true, instructions: 'This is an installation connectivity check. Reply with the requested text only. Do not use tools or inspect files.',
    signal: AbortSignal.timeout(95000), onSession: async () => {}, approve: async () => false,
  });
  if (result.text?.trim() !== 'XIAOMAN_READY') throw new Error('AGENT_SETUP_RESPONSE_INVALID');
  return { verified: true, provider: config.provider, ...selected, checkedAt: Date.now() };
}
