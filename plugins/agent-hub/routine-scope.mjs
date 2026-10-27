import { createHash } from 'node:crypto';
import { SOURCE_OPERATIONS } from './source-capabilities.mjs';
import { readConnectionAuthority } from './cloud-source-routing.mjs';
import { failure } from './store.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const FILTERS = {
  calendar_events: ['from', 'to'], mail_search: ['query'], mail_read: ['messageId'], drive_recent: [], drive_search: ['query'],
  drive_metadata: ['fileId'], docs_read: ['documentId'], sheets_metadata: ['spreadsheetId'], sheets_read: ['spreadsheetId', 'range'], contacts_search: ['query'],
  review_requests: [], github_repositories: ['kind'], github_updates: ['repo'], github_notifications: ['since'], x_timeline: [],
  recent_files: ['rootId'], file_search: ['rootId', 'query'], file_read: ['rootId', 'relativePath'],
};
const names = { google: 'Google', github: 'GitHub', files: '本机文件', x: 'X' };
export const ROUTINE_SCOPE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  publicWeb: { type: 'boolean' }, sources: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: {
    operation: { type: 'string', enum: Object.keys(SOURCE_OPERATIONS) }, filter: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries([...new Set(Object.values(FILTERS).flat())].map(key => [key, { type: 'string', maxLength: 2048 }])) },
  }, required: ['operation'] } },
}, required: ['publicWeb', 'sources'] };

export function normalizeRoutineScope(value) {
  if (value === undefined) return { publicWeb: true, sources: [] };
  if (!exact(value, ['publicWeb', 'sources']) || typeof value.publicWeb !== 'boolean' || !Array.isArray(value.sources) || value.sources.length > 30) throw failure('INVALID_INPUT');
  const scope = { publicWeb: value.publicWeb, sources: value.sources.map(source => {
    if (!exact(source, ['operation', 'filter']) || !Object.hasOwn(SOURCE_OPERATIONS, source.operation) || source.filter !== undefined && !exact(source.filter, FILTERS[source.operation])) throw failure('INVALID_INPUT');
    const filter = Object.fromEntries(Object.entries(source.filter || {}).sort(([a], [b]) => a.localeCompare(b)));
    if (Object.values(filter).some(value => typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))) throw failure('INVALID_INPUT');
    if (['recent_files', 'file_search', 'file_read'].includes(source.operation) && !filter.rootId) throw failure('ROUTINE_SCOPE_REQUIRED');
    return { operation: source.operation, filter };
  }) };
  if (new Set(scope.sources.map(hash)).size !== scope.sources.length) throw failure('INVALID_INPUT');
  scope.sources.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return scope;
}
function authorizedItem(state, operation) {
  const capability = SOURCE_OPERATIONS[operation], items = state.items.filter(item => item.id === capability.kind), item = items[0];
  if (items.length !== 1 || !item.enabled || ['revoked', 'unlinked'].includes(item.state)) throw failure('SOURCE_REVOKED');
  if (!Number.isSafeInteger(item.generation) || item.generation < 0 || !item.permissions?.some(permission => permission.id === capability.permission && permission.granted === true && permission.verified === true)) throw failure('SOURCE_NOT_CONFIGURED');
  if (capability.kind !== 'files' && (typeof item.account !== 'string' || !item.account.trim())) throw failure('SOURCE_NOT_CONFIGURED');
  return item;
}
function binding(state, item) {
  return { service: item.id, generation: item.generation, account: item.account?.trim().toLowerCase() || null, provider: item.provider || 'local', database: state.database };
}
export function bindRoutineScope(hub, value) {
  const scope = normalizeRoutineScope(value), scopeBindings = [];
  if (scope.sources.length) {
    const state = readConnectionAuthority(hub.root);
    for (const source of scope.sources) {
      const item = authorizedItem(state, source.operation);
      if (!scopeBindings.some(row => row.service === item.id)) scopeBindings.push(binding(state, item));
    }
  }
  return { scope, scopeBindings };
}
export function routineScopeFingerprint(routine) { return hash([normalizeRoutineScope(routine.scope), routine.scopeBindings || []]); }
export function assertRoutineScopeCurrent(hub, routine) {
  const scope = normalizeRoutineScope(routine.scope);
  if (!scope.publicWeb && !scope.sources.length) throw failure('ROUTINE_SCOPE_EMPTY');
  if (!scope.sources.length) return scope;
  const state = readConnectionAuthority(hub.root);
  for (const source of scope.sources) {
    const item = authorizedItem(state, source.operation), saved = routine.scopeBindings?.find(row => row.service === item.id);
    if (!saved || hash(saved) !== hash(binding(state, item))) throw failure('SOURCE_AUTHORITY_CHANGED');
  }
  return scope;
}
export function assertRoutineSourceAccess(hub, run, args) {
  if (!run?.routine) return;
  const routine = hub.get('routine', run.routine.id);
  if (!routine || routine.version !== run.routine.version) throw failure('ROUTINE_SUPERSEDED');
  if (routine.endedAt || routine.endsAt && routine.endsAt <= hub.now()) throw failure('ROUTINE_ENDED');
  if (!routine.enabled) throw failure('ROUTINE_PAUSED');
  const scope = assertRoutineScopeCurrent(hub, routine);
  if (args.operation === 'list') return;
  if (!scope.sources.some(source => source.operation === args.operation && Object.entries(source.filter).every(([key, value]) => args[key] === value))) throw failure('SOURCE_SCOPE_DENIED');
}
export function routineSourceInventory(hub, run, inventory) {
  if (!run?.routine) return inventory;
  assertRoutineSourceAccess(hub, run, { operation: 'list' });
  const scope = normalizeRoutineScope(hub.get('routine', run.routine.id).scope);
  const allowed = new Set(scope.sources.map(source => source.operation));
  const roots = new Set(scope.sources.map(source => source.filter.rootId).filter(Boolean));
  const filter = item => ({ ...item, actions: (item.actions || []).filter(operation => operation === 'list' || allowed.has(operation)), roots: (item.roots || []).filter(root => roots.has(root.id)) });
  return { ...filter(inventory), ...(inventory.locations && { locations: inventory.locations.map(filter) }), routineScope: scope };
}
export function routineScopeView(hub, routine) {
  const scope = normalizeRoutineScope(routine.scope), connectionIds = [...new Set(scope.sources.map(source => SOURCE_OPERATIONS[source.operation].kind))];
  let error = null;
  try { assertRoutineScopeCurrent(hub, routine); } catch (cause) { error = cause.code || 'SOURCE_AUTHORITY_UNAVAILABLE'; }
  return { scope, scopeBindings: routine.scopeBindings || [], connectionIds, scopeStatus: { blocked: !!error, error },
    scopeSummary: [...(scope.publicWeb ? ['公开网络'] : []), ...connectionIds.map(id => names[id])].join('、') || '未选择来源' };
}
export function routineSourceOptions(hub) {
  try {
    const state = readConnectionAuthority(hub.root, { optional: true });
    return state ? Object.keys(SOURCE_OPERATIONS).flatMap(operation => {
      try { const item = authorizedItem(state, operation); return [{ operation, service: item.id, label: names[item.id], account: item.account || null, filterFields: FILTERS[operation] }]; }
      catch { return []; }
    }) : [];
  } catch { return []; }
}
