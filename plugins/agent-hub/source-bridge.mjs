import { readAttachment } from './attachments.mjs';
import { assertRoutineSourceAccess, routineSourceInventory } from './routine-scope.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hubConfig } from './config.mjs';
import { failure } from './store.mjs';
import { sourcesTool, validateSourceArguments } from './sources.mjs';
import { SOURCE_OPERATIONS } from './source-capabilities.mjs';
import { readConnectionAuthority as connectionAuthority, cloudSourceSelection, cloudSourceInventory, runCloudSource } from './cloud-source-routing.mjs';

const TTL = 120000, LEASE = 45000, RETENTION = 600000, MAX_BYTES = 512000;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const live = run => run && ['running', 'waiting_approval'].includes(run.status);

function operationAuthority(state, operation) {
  const capability = SOURCE_OPERATIONS[operation];
  if (!capability) throw failure('SOURCE_NOT_CONFIGURED');
  const matches = state.items.filter(item => item.id === capability.kind), item = matches[0];
  if (matches.length !== 1 || !item.enabled || ['revoked', 'unlinked'].includes(item.state)) throw failure('SOURCE_REVOKED');
  if (item.provider === 'nango' || capability.kind === 'x') throw failure('SOURCE_NOT_CONFIGURED');
  if (!Number.isSafeInteger(item.generation) || item.generation < 0 || !item.permissions?.some(p => p.id === capability.permission && p.granted === true && p.verified === true)) throw failure('SOURCE_NOT_CONFIGURED');
  const account = capability.kind === 'files' ? null : item.account?.toLowerCase();
  if (capability.kind === 'github' && !/^[a-z0-9][a-z0-9-]{0,38}$/.test(account || '') || capability.kind === 'google' && (typeof account !== 'string' || account.length > 254 || !/^[^\s@<>-][^\s@<>]*@[^\s@<>]+\.[^\s@<>]+$/.test(account))) throw failure('SOURCE_NOT_CONFIGURED');
  return { kind: capability.kind, permission: capability.permission, generation: item.generation, account };
}

function route(hub, args) {
  const value = hubConfig(hub.root).sourceBridge;
  if (!value) throw failure('SOURCE_BRIDGE_NOT_CONFIGURED');
  const endpoint = hub.get('endpoint', value.endpointId);
  if (!endpoint?.active || endpoint.hosted) throw failure('SOURCE_BRIDGE_REVOKED');
  if (!args) return value;
  const state = connectionAuthority(hub.root);
  if (args.operation === 'list') {
    const allowed = [];
    for (const operation of value.operations) {
      try { allowed.push({ operation, ...operationAuthority(state, operation) }); }
      catch (error) { if (!['SOURCE_REVOKED', 'SOURCE_NOT_CONFIGURED'].includes(error.code)) throw error; }
    }
    return { ...value, authority: { database: state.database, allowed } };
  }
  if (!value.operations.includes(args.operation)) throw failure('SOURCE_NOT_CONFIGURED');
  return { ...value, authority: { database: state.database, ...operationAuthority(state, args.operation) } };
}

/** Configuration/connection evidence only. Actual local reads still check Mac scopes. */
function pairedInventory(hub) {
  if (!hubConfig(hub.root).sourceBridge) return null;
  const current = route(hub, { operation: 'list' }), endpoint = hub.get('endpoint', current.endpointId);
  return { configured: true, location: 'paired_local_agent', online: Boolean(endpoint.sourceSeenAt && hub.now() - endpoint.sourceSeenAt <= LEASE),
    actions: ['list', ...current.authority.allowed.map(a => a.operation)], roots: [], verification: 'checked_on_use' };
}

export function sourceBridgeInventory(hub, { env = process.env } = {}) {
  const cloud = cloudSourceInventory(hub.root, { env });
  if (!cloud) return pairedInventory(hub);
  let local;
  try { local = pairedInventory(hub); }
  catch (error) { local = { configured: true, location: 'paired_local_agent', online: false, actions: [], roots: [], error: error.code }; }
  const availableLocal = local?.online ? local.actions : [];
  return { configured: cloud.configured || Boolean(local?.configured), location: local ? 'mixed' : 'nango',
    actions: [...new Set([...cloud.actions, ...availableLocal])], roots: [], verification: 'checked_on_use',
    locations: [cloud, ...(local ? [local] : [])] };
}

/** Service status is distinct from executable data-source and messaging capabilities. */
export function connectedServiceStatus(root) {
  try {
    return connectionAuthority(root).items.filter(i => ['google', 'github', 'files', 'phone', 'x'].includes(i.id)).map(i => ({
      id: i.id, state: i.state, enabled: i.enabled === true, generation: i.generation, accountFingerprint: typeof i.account === 'string' && i.account.trim() ? createHash('sha256').update(i.account.trim().toLowerCase()).digest('hex') : null, scope: i.scope, permissions: (i.permissions || []).map(p => ({ id: p.id, granted: p.granted === true, verified: p.verified === true })),
      evidence: 'connection_monitor',
    }));
  } catch { return []; }
}

function jobScope(current, args) {
  if (args.operation !== 'list') return { account: current.authority.account, accounts: null, operations: [args.operation] };
  return { account: null, accounts: Object.fromEntries(current.authority.allowed.filter(a => a.account).map(a => [a.kind, a.account])),
    operations: current.authority.allowed.map(a => a.operation) };
}

function checkRequest(hub, row) {
  const current = route(hub, row.arguments), run = hub.get('run', row.runId);
  assertRoutineSourceAccess(hub, run, row.arguments);
  if (!live(run) || run.lease !== row.runLease || run.endpointId !== row.requesterId || hub.get('conversation', run.conversationId)?.ownerId !== 'owner') throw failure('FORBIDDEN');
  if (!hub.get('endpoint', row.requesterId)?.active) throw failure('FORBIDDEN');
  if (digest(current) !== row.routeDigest) throw failure('SOURCE_AUTHORITY_CHANGED');
  if (row.deadlineAt <= hub.now()) throw failure('SOURCE_BRIDGE_TIMEOUT');
  return current;
}

function prune(hub) {
  for (const row of hub.all('sourceRequest')) {
    // An unfinished execution still needs these receipts for its final coverage
    // and recovery. This does not extend the request's authorization/deadline.
    const unfinished = ['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling'].includes(hub.get('run', row.runId)?.status);
    if (!unfinished && row.deadlineAt + RETENTION < hub.now()) hub.db.prepare("DELETE FROM records WHERE kind='sourceRequest' AND id=?").run(row.id);
  }
}

export async function routedSourcesTool(options) {
  if (options.input?.arguments?.operation === 'attachment_read') return readAttachment(options);
  const { hub, token, input } = options;
  const authorize = () => {
    const endpoint = hub.authenticate(token), run = hub.get('run', input?.runId);
    if (!live(run) || run.endpointId !== endpoint.id || run.lease !== input.lease || hub.get('conversation', run.conversationId)?.ownerId !== 'owner') throw failure('FORBIDDEN');
    assertRoutineSourceAccess(hub, run, validateSourceArguments(input?.arguments));
    return run;
  };
  const run = authorize();
  const args = validateSourceArguments(input?.arguments);
  if (args.operation !== 'list') {
    if (typeof input.callId !== 'string' || !input.callId || input.callId.length > 256) throw failure('INVALID_INPUT');
    try {
      const selected = cloudSourceSelection(hub.root);
      if (selected.includes(SOURCE_OPERATIONS[args.operation]?.kind)) return await runCloudSource({ ...options, authorize }, args);
      return await pairedSourcesTool(options);
    } catch (error) {
      // A valid, authenticated read may fail before the bridge allocates its
      // request (offline/revoked route). Keep that failure as current-run
      // evidence so a later unrelated success cannot disguise missing coverage.
      if (/^(?:SOURCE_[A-Z_]+|INVALID_SOURCE_CONFIG|PRIVATE_SOURCE_CONFIG_REQUIRED)$/.test(error?.code || '')) {
        authorize();
        const id = digest([run.id, run.lease, input.callId]);
        hub.transaction(() => {
          const old = hub.get('sourceRequest', id);
          const canonical = value => digest(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
          if (old && canonical(old.arguments) !== canonical(args)) throw failure('CONFLICT');
          const { result, resultDigest, ...previous } = old || {};
          hub.put('sourceRequest', { ...previous, id, runId: run.id, runLease: run.lease, requesterId: run.endpointId,
            endpointId: old?.endpointId || null, executionLocation: old?.executionLocation || 'source_routing', argsDigest: old?.argsDigest || digest(args), arguments: args,
            status: 'failed', error: error.code, createdAt: old?.createdAt || hub.now(), deadlineAt: old?.deadlineAt || hub.now() + TTL, finishedAt: hub.now() });
        });
      }
      throw error;
    }
  }
  const selected = cloudSourceSelection(hub.root);
  if (!selected.length) return routineSourceInventory(hub, run, await pairedSourcesTool(options));
  const env = options.env || process.env;
  let local, localError;
  try {
    if (hubConfig(hub.root).sourceBridge) {
      if (pairedInventory(hub)?.online) local = await pairedSourcesTool(options);
      else localError = 'SOURCE_BRIDGE_OFFLINE';
    } else local = await sourcesTool(options);
  } catch (error) {
    if (!error.code?.startsWith('SOURCE_') && !['INVALID_SOURCE_CONFIG', 'PRIVATE_SOURCE_CONFIG_REQUIRED'].includes(error.code)) throw error;
    localError = error.code;
  }
  let timezone = 'UTC';
  if (options.read) { const settings = await options.read(), zone = settings?.config?.proactive?.timezone; if (zone && zone !== 'local') timezone = zone; }
  authorize();
  const cloud = cloudSourceInventory(hub.root, { env }), currentSelected = cloudSourceSelection(hub.root);
  // A provider switch during the local inventory cannot reintroduce its old
  // Mac capabilities. Inventory contains metadata only, never cloud bindings.
  const localActions = (local?.actions || []).filter(op => !currentSelected.includes(SOURCE_OPERATIONS[op]?.kind));
  return routineSourceInventory(hub, run, { untrusted: true, operation: 'list', configured: Boolean(cloud?.configured || local?.configured),
    actions: [...new Set(['list', ...(cloud?.actions || []), ...localActions])], roots: local?.roots || [],
    now: new Date(hub.now()).toISOString(), timezone, verification: 'checked_on_use',
    locations: [...(cloud ? [cloud] : []), ...(local ? [{ location: hubConfig(hub.root).sourceBridge ? 'paired_local_agent' : 'local', actions: localActions, roots: local.roots || [] }] : []), ...(localError ? [{ location: hubConfig(hub.root).sourceBridge ? 'paired_local_agent' : 'local', online: false, error: localError }] : [])] });
}

async function pairedSourcesTool(options) {
  const { hub, token, input } = options;
  if (!hubConfig(hub.root).sourceBridge) return sourcesTool(options);
  const authorize = () => {
    const endpoint = hub.authenticate(token), run = hub.get('run', input?.runId);
    if (!live(run) || run.endpointId !== endpoint.id || run.lease !== input.lease || hub.get('conversation', run.conversationId)?.ownerId !== 'owner') throw failure('FORBIDDEN');
    assertRoutineSourceAccess(hub, run, validateSourceArguments(input?.arguments));
    return run;
  };
  const run = authorize(), args = validateSourceArguments(input.arguments), current = route(hub, args);
  if (args.operation !== 'list' && !current.operations.includes(args.operation)) throw failure('SOURCE_NOT_CONFIGURED');
  if (typeof input.callId !== 'string' || !input.callId || input.callId.length > 256) throw failure('INVALID_INPUT');
  const id = digest([run.id, run.lease, input.callId]), argsDigest = digest(args);
  hub.transaction(() => {
    prune(hub);
    const old = hub.get('sourceRequest', id);
    if (old) { if (old.argsDigest !== argsDigest) throw failure('CONFLICT'); return; }
    const endpoint = hub.get('endpoint', current.endpointId);
    if (!endpoint.sourceSeenAt || hub.now() - endpoint.sourceSeenAt > LEASE) throw failure('SOURCE_BRIDGE_OFFLINE');
    if (hub.all('sourceRequest').filter(r => ['queued', 'running'].includes(r.status) && r.deadlineAt > hub.now()).length >= 16) throw failure('SOURCE_BRIDGE_BUSY');
    hub.put('sourceRequest', { id, runId: run.id, runLease: run.lease, requesterId: run.endpointId,
      endpointId: current.endpointId, routeDigest: digest(current), argsDigest, arguments: args,
      status: 'queued', createdAt: hub.now(), deadlineAt: hub.now() + TTL });
  });
  while (true) {
    authorize();
    const row = hub.get('sourceRequest', id); checkRequest(hub, row);
    if (row.status === 'failed') throw failure(row.error);
    if (row.status === 'completed') {
      const result = { ...row.result, untrusted: true, observedAt: new Date(row.finishedAt).toISOString(), execution: { location: 'paired_local_agent', requestId: row.id } };
      if (args.operation === 'list') {
        const allowed = current.authority.allowed.map(a => a.operation);
        result.actions = result.actions.filter(op => op === 'list' || allowed.includes(op));
        if (!result.actions.some(op => SOURCE_OPERATIONS[op]?.kind === 'files')) result.roots = [];
        let timezone = 'UTC';
        if (options.read) { const settings = await options.read(); const zone = settings?.config?.proactive?.timezone; if (zone && zone !== 'local') timezone = zone; }
        result.now = new Date(hub.now()).toISOString(); result.timezone = timezone;
        authorize(); checkRequest(hub, row);
      }
      return args.operation === 'list' ? routineSourceInventory(hub, run, result) : result;
    }
    await delay(200);
  }
}

/** All RPC operations authenticate the existing paired local Agent credential. */
export function sourceBridgeRPC(hub, token, operation, input) {
  const endpoint = hub.authenticate(token);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !validId(input.runnerId)) throw failure('INVALID_INPUT');
  return hub.transaction(() => {
    const current = hubConfig(hub.root).sourceBridge;
    // An ordinary local installation has no remote source route. It stays inert.
    if (operation === 'source-poll' && (!current || current.endpointId !== endpoint.id)) return { enabled: false, job: null };
    const routing = route(hub);
    if (routing.endpointId !== endpoint.id) throw failure('FORBIDDEN');
    if (operation === 'source-poll') {
      if (Object.keys(input).some(k => !['runnerId'].includes(k))) throw failure('INVALID_INPUT');
      hub.put('endpoint', { ...endpoint, sourceSeenAt: hub.now(), sourceProtocol: 1 }); prune(hub);
      for (const row of hub.all('sourceRequest').filter(r => r.endpointId === endpoint.id && ['queued', 'running'].includes(r.status))) {
        try { checkRequest(hub, row); }
        catch (e) { hub.put('sourceRequest', { ...row, status: 'failed', error: e.code, finishedAt: hub.now() }); continue; }
        if (row.status === 'running' && row.runnerId !== input.runnerId && row.heartbeat + LEASE > hub.now()) continue;
        const claimed = { ...row, status: 'running', runnerId: input.runnerId, heartbeat: hub.now(),
          sourceLease: row.status === 'running' && row.runnerId === input.runnerId ? row.sourceLease : randomUUID() };
        hub.put('sourceRequest', claimed);
        return { enabled: true, job: { id: row.id, lease: claimed.sourceLease, arguments: row.arguments,
          ...jobScope(checkRequest(hub, claimed), row.arguments), deadlineAt: row.deadlineAt } };
      }
      return { enabled: true, job: null };
    }
    if (!['source-check', 'source-result'].includes(operation) || Object.keys(input).some(k => !['runnerId', 'requestId', 'lease', ...(operation === 'source-result' ? ['result', 'error'] : [])].includes(k))) throw failure('INVALID_INPUT');
    if (typeof input.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(input.requestId) || !validId(input.lease)) throw failure('INVALID_INPUT');
    const row = hub.get('sourceRequest', input.requestId);
    if (!row || row.endpointId !== endpoint.id || row.runnerId !== input.runnerId || row.sourceLease !== input.lease) throw failure('FORBIDDEN');
    const checked = checkRequest(hub, row);
    if (operation === 'source-check') {
      if (row.status !== 'running') throw failure('FORBIDDEN');
      hub.put('sourceRequest', { ...row, heartbeat: hub.now() });
      return { allowed: true, ...jobScope(checked, row.arguments) };
    }
    const error = input.error;
    if (error !== undefined && (!/^(?:SOURCE_[A-Z_]+|INVALID_(?:INPUT|SOURCE_RESPONSE)|FORBIDDEN)$/.test(error) || input.result !== undefined)) throw failure('INVALID_INPUT');
    if (!error && (!input.result || typeof input.result !== 'object' || input.result.operation !== row.arguments.operation || input.result.untrusted !== true || Buffer.byteLength(JSON.stringify(input.result)) > MAX_BYTES || row.arguments.operation === 'list' && !Array.isArray(input.result.actions))) throw failure('INVALID_SOURCE_RESPONSE');
    const resultDigest = digest(error ? { error } : input.result);
    if (['completed', 'failed'].includes(row.status)) {
      if (row.resultDigest !== resultDigest) throw failure('CONFLICT');
      return { accepted: true };
    }
    if (row.status !== 'running') throw failure('FORBIDDEN');
    hub.put('sourceRequest', { ...row, status: error ? 'failed' : 'completed', resultDigest,
      ...(error ? { error } : { result: input.result }), finishedAt: hub.now() });
    return { accepted: true };
  });
}
