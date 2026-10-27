import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createNangoClient, loadNangoConfig } from '../connections/nango.mjs';
import { readNangoMail, readNangoSource } from './nango-sources.mjs';
import { SOURCE_OPERATIONS } from './source-capabilities.mjs';
import { failure } from './store.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jobs = new Map();
const TTL = 120000, RETENTION = 600000;

/** Read only the existing private authority. No manager, migration or mutation. */
export function readConnectionAuthority(root, { optional = false } = {}) {
  const path = join(root, '.runtime/connections/state.sqlite'); let db;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.mode & 0o077 || process.getuid && before.uid !== process.getuid() || before.size > 16 * 1024 * 1024) throw failure('SOURCE_AUTHORITY_UNAVAILABLE');
    db = new DatabaseSync(path, { readOnly: true, enableExtensions: false });
    const raw = db.prepare('SELECT CASE WHEN length(CAST(data AS BLOB)) <= 1048576 THEN data END AS data FROM connections WHERE id=1').get()?.data;
    if (typeof raw !== 'string') throw failure('SOURCE_AUTHORITY_UNAVAILABLE');
    const state = JSON.parse(raw), after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || after.mode & 0o077 || process.getuid && after.uid !== process.getuid() || !Array.isArray(state.items) || state.items.length > 16) throw failure('SOURCE_AUTHORITY_UNAVAILABLE');
    return { database: [before.dev, before.ino], items: state.items };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw failure('SOURCE_AUTHORITY_UNAVAILABLE');
  } finally { db?.close(); }
}

export function cloudSourceSelection(root) {
  return (readConnectionAuthority(root, { optional: true })?.items || []).filter(item => item.provider === 'nango').map(item => item.id);
}

function plan(root, operation, env) {
  const capability = SOURCE_OPERATIONS[operation];
  if (!capability) throw failure('SOURCE_NOT_CONFIGURED');
  const state = readConnectionAuthority(root, { optional: true });
  const matches = state?.items.filter(item => item.id === capability.kind) || [], item = matches[0];
  if (item?.provider !== 'nango') return null;
  if (matches.length !== 1 || !item.enabled || ['revoked', 'unlinked'].includes(item.state)) throw failure('SOURCE_REVOKED');
  if (!Number.isSafeInteger(item.generation) || item.generation < 0 || !item.permissions?.some(p => p.id === capability.permission && p.granted === true && p.verified === true)) throw failure('SOURCE_NOT_CONFIGURED');
  const binding = item.binding;
  if (!binding || binding.service !== capability.kind || binding.ownerId !== 'owner' || typeof binding.connectionId !== 'string' || !binding.connectionId || typeof item.account !== 'string' || !item.account) throw failure('SOURCE_NOT_CONFIGURED');
  let config;
  try { config = loadNangoConfig(root, { env }); }
  catch { throw failure('SOURCE_CONFIG_UNAVAILABLE'); }
  if (!config || config.integrations[binding.service]?.integrationId !== binding.integrationId) throw failure('SOURCE_NOT_CONFIGURED');
  const safeBinding = { service: binding.service, ownerId: 'owner', connectionId: binding.connectionId, integrationId: binding.integrationId, account: item.account.toLowerCase(), generation: item.generation };
  // Configuration/credential replacement invalidates existing results, but only
  // a digest is persisted. Tokens, account and Nango IDs never enter receipts.
  const routeDigest = hash({ database: state.database, binding: safeBinding, permission: capability.permission, config, credential: hash(config.secretKey) });
  return { config, binding: safeBinding, routeDigest };
}

export function cloudSourceInventory(root, { env = process.env } = {}) {
  const selected = cloudSourceSelection(root);
  if (!selected.length) return null;
  const actions = ['list'], unavailable = [];
  for (const [operation, capability] of Object.entries(SOURCE_OPERATIONS)) {
    if (!selected.includes(capability.kind)) continue;
    try { if (plan(root, operation, env)) actions.push(operation); }
    catch (error) {
      if (!['SOURCE_REVOKED', 'SOURCE_NOT_CONFIGURED'].includes(error.code)) throw error;
      if (!unavailable.some(item => item.service === capability.kind)) unavailable.push({ service: capability.kind, error: error.code });
    }
  }
  return { configured: actions.length > 1, location: 'nango', actions, roots: [], verification: 'checked_on_use', ...(unavailable.length ? { unavailable } : {}) };
}

function context(root, operation, { generation, account, authorize, env = process.env, fetchImpl, now = Date.now, signal } = {}) {
  if (typeof authorize !== 'function') throw failure('FORBIDDEN');
  const initial = plan(root, operation, env);
  if (!initial) throw failure('SOURCE_NOT_CONFIGURED');
  if (generation !== undefined && generation !== initial.binding.generation || account !== undefined && account?.toLowerCase() !== initial.binding.account) throw failure('SOURCE_AUTHORITY_CHANGED');
  const check = async () => {
    signal?.throwIfAborted();
    if (await authorize() === false) throw failure('SOURCE_REVOKED');
    const current = plan(root, operation, env);
    if (!current || current.routeDigest !== initial.routeDigest) throw failure('SOURCE_AUTHORITY_CHANGED');
    return true;
  };
  const client = createNangoClient({ config: initial.config, fetchImpl, now, authorize: check });
  return { initial, check, client, binding: initial.binding, now, signal };
}

/** Shared by scheduled reads: caller supplies its own durable execution fence. */
export async function readCloudSource(root, args, options) {
  const ctx = context(root, args.operation, options);
  await ctx.check();
  return readNangoSource({ client: ctx.client, binding: ctx.binding, args, authorize: ctx.check, now: ctx.now, signal: ctx.signal });
}

/** Raw MIME shape required by the existing mail pipeline; no snippet fallback. */
export async function readCloudMail(root, { messageId, threadId }, options) {
  const ctx = context(root, 'mail_read', options);
  await ctx.check();
  return readNangoMail({ client: ctx.client, binding: ctx.binding, messageId, threadId, authorize: ctx.check, signal: ctx.signal });
}

/** Existing sourceRequest evidence contract, with direct server-side execution. */
export async function runCloudSource({ root, hub, input, authorize, env = process.env, fetchImpl }, args) {
  const run = authorize(), initial = plan(root, args.operation, env);
  if (!initial) throw failure('SOURCE_NOT_CONFIGURED');
  if (typeof input.callId !== 'string' || !input.callId || input.callId.length > 256) throw failure('INVALID_INPUT');
  const id = hash([run.id, run.lease, input.callId]), argsDigest = hash(args), jobKey = root + ':' + id;
  const check = () => {
    authorize();
    const current = plan(root, args.operation, env), row = hub.get('sourceRequest', id);
    if (!current || current.routeDigest !== initial.routeDigest || row?.routeDigest !== initial.routeDigest) throw failure('SOURCE_AUTHORITY_CHANGED');
    if (!row || row.deadlineAt <= hub.now()) throw failure('SOURCE_TIMEOUT');
    return row;
  };
  hub.transaction(() => {
    for (const row of hub.all('sourceRequest')) {
      const unfinished = ['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling'].includes(hub.get('run', row.runId)?.status);
      if (!unfinished && row.deadlineAt + RETENTION < hub.now()) hub.db.prepare("DELETE FROM records WHERE kind='sourceRequest' AND id=?").run(row.id);
    }
    const old = hub.get('sourceRequest', id);
    if (old) { if (old.argsDigest !== argsDigest) throw failure('CONFLICT'); return; }
    if (hub.all('sourceRequest').filter(r => ['queued', 'running'].includes(r.status) && r.deadlineAt > hub.now()).length >= 16) throw failure('SOURCE_BRIDGE_BUSY');
    hub.put('sourceRequest', { id, runId: run.id, runLease: run.lease, requesterId: run.endpointId, endpointId: null,
      executionLocation: 'nango', routeDigest: initial.routeDigest, argsDigest, arguments: args,
      status: 'queued', createdAt: hub.now(), deadlineAt: hub.now() + TTL });
  });
  const old = check();
  if (!jobs.has(jobKey) && old.status === 'queued') {
    const execute = async () => {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), TTL); timeout.unref?.();
      try {
        const row = check(); hub.put('sourceRequest', { ...row, status: 'running' });
        const result = await readCloudSource(root, args, { generation: initial.binding.generation, account: initial.binding.account, authorize: check, env, fetchImpl, now: () => hub.now(), signal: controller.signal });
        const current = check();
        hub.put('sourceRequest', { ...current, status: 'completed', result, resultDigest: hash(result), finishedAt: hub.now() });
      } catch (error) {
        const current = hub.get('sourceRequest', id);
        const code = controller.signal.aborted ? 'SOURCE_TIMEOUT' : /^(?:SOURCE_[A-Z_]+|INVALID_(?:INPUT|SOURCE_RESPONSE)|FORBIDDEN)$/.test(error.code || '') ? error.code : 'SOURCE_UNAVAILABLE';
        if (current) hub.put('sourceRequest', { ...current, status: 'failed', error: code, finishedAt: hub.now() });
      } finally { clearTimeout(timeout); }
    };
    // Reserve before executing the first await; duplicate calls share work.
    const pending = Promise.resolve().then(execute).finally(() => jobs.delete(jobKey)); jobs.set(jobKey, pending);
  }
  if (jobs.has(jobKey)) await jobs.get(jobKey);
  let row = check();
  if (row.status === 'running') {
    // A process restart cannot assert whether its old I/O completed. A fresh
    // callId may retry this read; never silently reuse an unfinished receipt.
    row = { ...row, status: 'failed', error: 'SOURCE_EXECUTION_INTERRUPTED', finishedAt: hub.now() }; hub.put('sourceRequest', row);
  }
  if (row.status === 'failed') throw failure(row.error);
  if (row.status !== 'completed') throw failure('SOURCE_UNAVAILABLE');
  return { ...row.result, untrusted: true, observedAt: new Date(row.finishedAt).toISOString(), execution: { location: 'nango', requestId: row.id } };
}
