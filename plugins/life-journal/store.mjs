import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { guideSources, guideValues, guideFollowupValues } from './guide.mjs';
import { planAdjustment, planningRequest } from './planning.mjs';
import { validateSurfaces } from './surfaces.mjs';
import { WIDGET_KINDS, LEGACY_WIDGET_KINDS, canonicalWidgetKind, allowedWidget, materialWidgetKinds, validateTaskData, validateTaskType, validateTimestamp, validateItemTaskData, applyWidgetAction, invalidateConfirmation, invalidateIneligibleChoices, fitsCandidate } from './widgets.mjs';

const ITEM_KINDS = new Set(['arrangement', 'purchase', 'experience', 'wish']);
const STATUSES = new Set(['planned', 'active', 'done', 'cancelled']);
const STORED_WIDGET_KINDS = new Set([...WIDGET_KINDS, ...LEGACY_WIDGET_KINDS]);
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (code, message = code) => { const error = new Error(message); error.code = code; throw error; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const DESIGN_DIAGNOSTIC_STAGES = Object.freeze(['queue', 'recovery', 'role', 'input', 'analysis', 'validation', 'commit']);
export const DESIGN_DIAGNOSTIC_CODES = Object.freeze(['QUEUE_TIMEOUT', 'DESIGN_INTERRUPTED', 'DESIGN_TIMEOUT', 'INVALID_DESIGN_SKILL', 'INVALID_DESIGN_ROLE', 'DESIGN_INPUT_TOO_LARGE', 'INVALID_DESIGN', 'INVALID_LAYOUT', 'MODEL_REQUEST_FAILED', 'MODEL_AUTH_REQUIRED', 'MODEL_RATE_LIMITED', 'MODEL_HTTP_ERROR', 'MODEL_NETWORK_ERROR', 'PROACTIVE_INCOMPLETE_RESULT', 'PROACTIVE_OUTPUT_TOO_LARGE', 'PROACTIVE_TOOL_REJECTED', 'AGENT_TIMEOUT', 'AGENT_AUTH_REQUIRED', 'AGENT_FAILED', 'AGENT_EMPTY_REPLY', 'AGENT_TOOL_REJECTED', 'AGENT_CANCELLED', 'STORAGE_UNAVAILABLE', 'INVALID_REQUEST', 'UNEXPECTED_ERROR']);
function designDiagnostic(value) {
  if (!object(value) || Object.keys(value).some(key => !['stage', 'code', 'elapsedMs', 'statusCode', 'finishKind', 'textCharacters'].includes(key)) ||
      !DESIGN_DIAGNOSTIC_STAGES.includes(value.stage) || !DESIGN_DIAGNOSTIC_CODES.includes(value.code) ||
      !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 604800000 ||
      value.statusCode !== undefined && (!Number.isInteger(value.statusCode) || value.statusCode < 100 || value.statusCode > 599) ||
      value.finishKind !== undefined && !['stop', 'max-tokens', 'error', 'aborted', 'missing', 'unknown'].includes(value.finishKind) ||
      value.textCharacters !== undefined && (!Number.isSafeInteger(value.textCharacters) || value.textCharacters < 0 || value.textCharacters > 10000000)) fail('INVALID_REQUEST');
  return copy(value);
}
const str = (value, max = 200, empty = false) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail('INVALID_REQUEST');
  return value;
};
const identifier = value => { str(value, 128); if (!/^[a-zA-Z0-9:_-]+$/.test(value)) fail('INVALID_REQUEST'); return value; };
function scopeKey(scope = { account: 'local', userId: 'owner' }) {
  if (!object(scope) || !(scope.account === 'local' || /^[a-f0-9]{64}$/.test(scope.account))) fail('INVALID_SCOPE');
  if (typeof scope.userId !== 'string' || !scope.userId.trim() || scope.userId.length > 256 || /[\x00-\x1f]/.test(scope.userId)) fail('INVALID_SCOPE');
  return [scope.account, scope.userId];
}
function timestamp(value) {
  if (value === null) return null;
  try { return validateTimestamp(value); } catch { fail('INVALID_REQUEST'); }
}
function uniqueList(value, max = 100) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_REQUEST');
  const result = value.map(identifier);
  if (new Set(result).size !== result.length) fail('INVALID_REQUEST');
  return result;
}
function steps(value) {
  if (!Array.isArray(value) || value.length > 100) fail('INVALID_REQUEST');
  const result = value.map(step => {
    if (!object(step) || typeof step.done !== 'boolean') fail('INVALID_REQUEST');
    return { id: identifier(step.id ?? randomUUID()), label: str(step.label, 500), done: step.done };
  });
  if (new Set(result.map(step => step.id)).size !== result.length) fail('INVALID_REQUEST');
  return result;
}
function candidates(value) {
  if (!Array.isArray(value) || value.length > 30) fail('INVALID_REQUEST');
  const result = value.map(candidate => {
    if (!object(candidate) || typeof candidate.selected !== 'boolean') fail('INVALID_REQUEST');
    const result = { id: identifier(candidate.id ?? randomUUID()), name: str(candidate.name, 200), detail: str(candidate.detail ?? '', 2000, true), selected: candidate.selected };
    if (candidate.url !== undefined) {
      str(candidate.url, 2048); let url;
      try { url = new URL(candidate.url); } catch { fail('INVALID_REQUEST'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('INVALID_REQUEST');
      result.url = url.href;
    }
    return result;
  });
  if (new Set(result.map(candidate => candidate.id)).size !== result.length || result.filter(candidate => candidate.selected).length > 1) fail('INVALID_REQUEST');
  return result;
}
function fields(values, now, timeZone, existingTaskData) {
  if (!object(values)) fail('INVALID_REQUEST');
  const result = {};
  for (const key of Object.keys(values)) {
    if (key === 'title') result.title = str(values.title, 300);
    else if (key === 'kind') { if (!ITEM_KINDS.has(values.kind)) fail('INVALID_REQUEST'); result.kind = values.kind; }
    else if (key === 'date') result.date = timestamp(values.date);
    else if (key === 'note') result.note = str(values.note, 10000, true);
    else if (key === 'steps') result.steps = steps(values.steps);
    else if (key === 'candidates') result.candidates = candidates(values.candidates);
    else if (key === 'taskType') result.taskType = validateTaskType(values.taskType);
    else if (key === 'taskData') result.taskData = validateTaskData(values.taskData, { now, timeZone, existingTaskData });
    else fail('INVALID_REQUEST');
  }
  return result;
}
function initial() {
  return { revision: 0, items: [], layout: { version: 0, widgets: [], reason: '根据已确认的生活事项整理', source: 'basic' }, preferences: { autoLayout: true, motion: 'system', hidden: [], pinned: [], order: [] }, design: { status: 'idle', token: null, baseRevision: 0, layoutVersion: 0 }, events: [], _undo: {} };
}
const widgetKey = widget => `${widget.itemId}:${canonicalWidgetKind(widget.kind)}`;
function preferenceKey(widgetId) {
  const separator = widgetId.lastIndexOf(':'), kind = widgetId.slice(separator + 1);
  return separator > 0 && STORED_WIDGET_KINDS.has(kind) ? `${widgetId.slice(0, separator)}:${canonicalWidgetKind(kind)}` : null;
}
function hiddenWidget(state, widget) {
  const key = widgetKey(widget);
  return state.preferences.hidden.some(id => id === widget.id || preferenceKey(id) === key);
}
function basicWidgets(state) {
  const widgets = [];
  const category = item => ['done', 'cancelled'].includes(item.status) ? 2 : ['experience', 'wish'].includes(item.kind) ? 1 : 0;
  const items = [...state.items].sort((a, b) => category(a) - category(b) || (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.createdAt.localeCompare(b.createdAt));
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    // A deployed layout retains its old IDs (including hidden and pinned IDs)
    // until a new design replaces it. New items use only modern component kinds.
    const legacy = [...(state._hiddenWidgets ?? []), ...state.layout.widgets].filter(widget => widget.itemId === item.id && ['focus', 'checklist', 'comparison', 'timeline', 'wish'].includes(widget.kind) && allowedWidget(widget, item));
    const kinds = legacy.length ? [...new Set(legacy.map(widget => widget.kind))] : materialWidgetKinds(item);
    for (const kind of kinds) {
      const original = legacy.find(widget => widget.kind === kind);
      const widget = original ? copy(original) : { id: `${item.id}:${kind}`, kind, itemId: item.id, emphasis: widgets.length === 0 && item.status !== 'done' ? 'primary' : 'normal', reason: '展示用户已记录的生活事项' };
      if (widget.emphasis === 'primary' && widgets.some(widget => widget.emphasis === 'primary')) widget.emphasis = 'normal';
      widgets.push(widget);
    }
  }
  return widgets.slice(0, 100);
}
function arranged(state, widgets) {
  const { hidden, pinned, order } = state.preferences;
  const known = new Map([...(state._hiddenWidgets ?? []), ...state.layout.widgets].map(widget => [widget.id, widget]));
  const fixed = pinned.map(id => known.get(id)).filter(widget => widget && state.items.some(item => item.id === widget.itemId && allowedWidget(widget, item)));
  const fixedKeys = new Set(fixed.map(widgetKey));
  // A pinned pre-upgrade card remains the authoritative presentation. A modern
  // equivalent cannot duplicate or restyle it through a different identity.
  const proposal = [...widgets.filter(widget => !fixedKeys.has(widgetKey(widget))), ...fixed];
  const allowed = proposal.filter(widget => state.items.some(item => item.id === widget.itemId && allowedWidget(widget, item)));
  const hiddenKeys = new Set(hidden.map(preferenceKey).filter(Boolean));
  const isHidden = widget => hidden.includes(widget.id) || hiddenKeys.has(widgetKey(widget));
  state._hiddenWidgets = [...new Map([...(state._hiddenWidgets ?? []), ...allowed].filter(isHidden).map(widget => [widget.id, widget])).values()].slice(0, 100);
  const index = ids => {
    const keys = ids.map(preferenceKey);
    return widget => { const position = keys.indexOf(widgetKey(widget)); return position < 0 ? Number.MAX_SAFE_INTEGER : position; };
  };
  const pin = index(pinned), rank = index(order), seen = new Set();
  let primary = false;
  return allowed.filter(widget => !isHidden(widget)).map((widget, i) => ({ widget, i })).sort((a, b) => pin(a.widget) - pin(b.widget) || rank(a.widget) - rank(b.widget) || a.i - b.i).map(({ widget }) => widget).filter(widget => {
    const key = widgetKey(widget); if (seen.has(key)) return false; seen.add(key); return true;
  }).map(widget => {
    if (widget.emphasis !== 'primary') return widget;
    if (primary) return { ...widget, emphasis: 'normal' };
    primary = true; return widget;
  });
}
function refreshLayout(state, previous) {
  // Only structural changes require a new layout version. The UI binds fields
  // to current items, so date and note updates do not regenerate every card.
  const cached = [...(state._hiddenWidgets ?? []), ...(previous?.layout.widgets ?? [])]
    .filter(widget => state.items.some(item => item.id === widget.itemId && allowedWidget(widget, item)));
  const restored = cached.filter(widget => previous && hiddenWidget(previous, widget) && !hiddenWidget(state, widget));
  let proposal = [...state.layout.widgets];
  for (const widget of restored) if (!proposal.some(existing => existing.id === widget.id)) proposal.push(widget);
  state._hiddenWidgets = [...new Map(cached.filter(widget => hiddenWidget(state, widget)).map(widget => [widget.id, widget])).values()].slice(0, 100);
  if (state.preferences.autoLayout) {
    const basic = basicWidgets(state);
    if (state.layout.source === 'basic') proposal = basic;
    else {
      proposal = [...proposal];
      const oldBasic = previous ? basicWidgets(previous) : [];
      for (const widget of basic) if (!proposal.some(existing => existing.id === widget.id) &&
        (!oldBasic.some(old => old.id === widget.id) || previous && hiddenWidget(previous, widget) && !hiddenWidget(state, widget))) proposal.push(widget);
    }
  }
  const widgets = arranged(state, proposal);
  if (JSON.stringify(widgets) !== JSON.stringify(state.layout.widgets)) {
    state.layout = { ...state.layout, version: state.layout.version + 1, widgets, reason: '根据当前事项与展示偏好整理', source: state.layout.source };
  }
}
function publicState(state) { const { _undo, _hiddenWidgets, ...publicData } = state; return copy(publicData); }

// Shared business storage, independent from the proactive delivery ledger. Each
// transaction reads current state after obtaining SQLite's write lock, allowing
// the Web and WeChat processes to apply the same revision contract safely.
export class JournalStore {
  constructor(root, { now = () => Date.now() } = {}) {
    this.now = now;
    const directory = join(root, '.runtime');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'life-journal.sqlite');
    if (!existsSync(this.path)) { try { closeSync(openSync(this.path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS journal_scopes (account TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account,user_id)); CREATE TABLE IF NOT EXISTS journal_messages (account TEXT NOT NULL, user_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(account,user_id,message_id));');
    this.db.exec('CREATE TABLE IF NOT EXISTS journal_plan_receipts (account TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(account,user_id,request_id));');
    this.secureFiles();
  }
  secureFiles() { for (const suffix of ['', '-wal', '-shm']) if (existsSync(this.path + suffix)) chmodSync(this.path + suffix, 0o600); }
  read(key) {
    const row = this.db.prepare('SELECT data FROM journal_scopes WHERE account = ? AND user_id = ?').get(...key);
    return row ? JSON.parse(row.data) : initial();
  }
  save(key, state) {
    if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) fail('JOURNAL_CAPACITY_REACHED');
    this.db.prepare('INSERT INTO journal_scopes(account,user_id,data) VALUES(?,?,?) ON CONFLICT(account,user_id) DO UPDATE SET data = excluded.data').run(...key, JSON.stringify(state));
  }
  transaction(operation) {
    if (!this.db) {
      const error = new Error('STORAGE_UNAVAILABLE'); error.code = 'STORAGE_UNAVAILABLE'; error.journalCommitted = false; throw error;
    }
    let started = false, committed = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); started = true;
      const result = operation();
      this.db.exec('COMMIT'); committed = true;
      this.secureFiles(); return result;
    } catch (error) {
      let outcome = committed ? true : !started ? false : undefined;
      if (started && !committed) {
        try { this.db.exec('ROLLBACK'); outcome = false; }
        catch { /* Keep the original failure and an unknown write outcome. */ }
      }
      // File permission checks happen after COMMIT. Their failure must not be
      // mistaken for a rolled-back write or authorize another attempt.
      error.journalCommitted = outcome;
      if (error.errcode === 5 || error.errcode === 6) {
        const busy = new Error('STORAGE_BUSY', { cause: error }); busy.code = 'STORAGE_BUSY'; busy.journalCommitted = outcome; throw busy;
      }
      throw error;
    }
  }
  snapshot(scope = { account: 'local', userId: 'owner' }) {
    if (!this.db) fail('STORAGE_UNAVAILABLE');
    return publicState(this.read(scopeKey(scope)));
  }
  mutate(scope, request, context = {}) {
    const key = scopeKey(scope);
    return this.transaction(() => { const state = this.read(key); this.apply(state, request, context); this.save(key, state); return publicState(state); });
  }
  ensureConversation(scope, { conversationId, content }) {
    const key = scopeKey(scope); identifier(conversationId); str(content, 16000);
    return this.transaction(() => {
      const state = this.read(key), existing = state.items.find(item => item.conversationId === conversationId);
      if (existing) return copy(existing);
      const title = content.trim().split(/\n/)[0].replace(/\s+/g, ' ').slice(0, 80);
      this.apply(state, { operation: 'add', revision: state.revision, values: {
        title, note: content.trim().slice(0, 10000),
        source: { kind: 'user', channel: 'web', text: content.trim() },
      } });
      const item = state.items.at(-1); item.conversationId = conversationId; item.titleOrigin = 'message';
      this.save(key, state); return copy(item);
    });
  }
  linkConversation(scope, itemId, conversationId) {
    const key = scopeKey(scope); identifier(itemId); identifier(conversationId);
    return this.transaction(() => {
      const state = this.read(key), item = state.items.find(value => value.id === itemId);
      if (!item) fail('ITEM_NOT_FOUND');
      if (item.conversationId) {
        if (item.conversationId !== conversationId) fail('CONFLICT');
        return copy(item);
      }
      item.conversationId = conversationId; item.version++; state.revision++;
      this.save(key, state); return copy(item);
    });
  }
  ensureGuide(scope) {
    const key = scopeKey(scope);
    return this.transaction(() => {
      const state = this.read(key);
      let item = state.items.find(item => item.source?.kind === 'guide');
      // Existing in-progress real tasks keep their selected material and receipt.
      if (!state.guide || !item || !state.guide.resultItemId) {
        const sources = guideSources(this.db, state, scope, this.now());
        const selectedId = item?.candidates.find(candidate => candidate.selected)?.id;
        const selectedSource = selectedId && guideSources(this.db, state, scope, this.now(), Infinity).find(row => row.id === selectedId);
        if (selectedSource && !sources.some(row => row.id === selectedId)) sources.splice(2, 1, selectedSource);
        const values = guideValues(sources);
        for (const candidate of values.candidates) candidate.selected = candidate.id === selectedId;
        if (item && state.guide && isDeepStrictEqual(state.guide.sources, sources)) return publicState(state);
        if (!item) {
          this.apply(state, { operation: 'add', revision: state.revision, values: {
            ...values, source: { kind: 'guide', channel: 'web', text: '从已授权的近期材料开始一件真实跟进事项' },
          } });
          item = state.items.at(-1);
        } else {
          if (['done', 'cancelled'].includes(item.status)) this.apply(state, { operation: 'undo', revision: state.revision, itemId: item.id });
          this.apply(state, { operation: 'update', revision: state.revision, itemId: item.id, values });
        }
        state.guide = { itemId: item.id, sources, resultItemId: null, selectedId: null, createdAt: new Date(this.now()).toISOString() };
        this.save(key, state);
      }
      return publicState(state);
    });
  }
  followGuide(scope, input) {
    const key = scopeKey(scope);
    return this.transaction(() => {
      const state = this.read(key), guide = state.guide;
      if (!guide || input.itemId !== guide.itemId) fail('ITEM_NOT_FOUND');
      if (guide.resultItemId) {
        if (!state.items.some(item => item.id === guide.resultItemId)) fail('ITEM_NOT_FOUND');
        return publicState(state);
      }
      const item = state.items.find(item => item.id === guide.itemId);
      if (input.revision !== state.revision || input.itemVersion !== item.version) fail('VERSION_CONFLICT');
      if (['done', 'cancelled'].includes(item.status)) fail('INVALID_STATE');
      const source = guide.sources.find(row => row.id === item.candidates.find(candidate => candidate.selected)?.id);
      if (!source) fail('GUIDE_CHOICE_REQUIRED');
      // Re-read the current source so a correction/deletion cannot be silently ignored.
      const fresh = guideSources(this.db, state, scope, this.now(), Infinity).find(row => row.id === source.id);
      if (!fresh || !isDeepStrictEqual(fresh, source)) fail('GUIDE_SOURCE_CHANGED');
      this.apply(state, { operation: 'add', revision: state.revision, values: {
        ...guideFollowupValues(source), source: { kind: 'user', channel: 'web', text: `用户选择继续跟进：${source.title}` },
      } });
      state.items.at(-1).titleOrigin = 'message';
      state.guide = { ...guide, selectedId: source.id, resultItemId: state.items.at(-1).id, startedAt: new Date(this.now()).toISOString() };
      this.save(key, state);
      return publicState(state);
    });
  }
  preview(scope, input) {
    if (!this.db) fail('STORAGE_UNAVAILABLE');
    return planAdjustment(this.read(scopeKey(scope)), input).preview;
  }
  applyPreview(scope, input, context = {}) {
    const key = scopeKey(scope), request = planningRequest(input);
    return this.transaction(() => {
      const state = this.read(key);
      const prior = this.db.prepare('SELECT request_hash, receipt FROM journal_plan_receipts WHERE account = ? AND user_id = ? AND request_id = ?').get(...key, request.requestId);
      if (prior) {
        if (prior.request_hash !== request.requestHash) fail('IDEMPOTENCY_CONFLICT');
        return { ...publicState(state), applyReceipt: { ...JSON.parse(prior.receipt), replayed: true } };
      }
      const { preview, taskData } = planAdjustment(state, request);
      if (preview.previewHash !== request.previewHash) fail('STALE_PREVIEW');
      if (!preview.canApply) fail(preview.warnings.some(warning => warning.code === 'BUDGET_EXCEEDED') ? 'BUDGET_EXCEEDED' : 'PLAN_REVIEW_REQUIRED');
      this.apply(state, { operation: 'update', revision: request.revision, itemId: request.itemId, itemVersion: request.itemVersion, values: { taskData } }, context);
      this.save(key, state);
      const receipt = { requestId: request.requestId, itemId: request.itemId, revision: state.revision, itemVersion: state.items.find(item => item.id === request.itemId).version, previewHash: request.previewHash };
      this.db.prepare('INSERT INTO journal_plan_receipts(account,user_id,request_id,request_hash,receipt) VALUES(?,?,?,?,?)').run(...key, request.requestId, request.requestHash, JSON.stringify(receipt));
      return { ...publicState(state), applyReceipt: { ...receipt, replayed: false } };
    });
  }
  apply(state, request, { timeZone } = {}) {
    if (!object(request) || !Number.isSafeInteger(request.revision) || request.revision < 0) fail('INVALID_REQUEST');
    if (request.revision !== state.revision) fail('VERSION_CONFLICT');
    const { operation, values = {} } = request;
    if (!object(values)) fail('INVALID_REQUEST');
    const at = new Date(this.now()).toISOString();
    const previous = copy(state);
    if (operation === 'design-start') {
      if (!state.preferences.autoLayout) fail('AUTO_LAYOUT_PAUSED');
      if (!object(values) || (values.status !== undefined && !['queued', 'running'].includes(values.status))) fail('INVALID_REQUEST');
      const status = values.status ?? 'running';
      if (['queued', 'running'].includes(state.design.status)) {
        if (status === 'queued') return;
        if (state.design.status !== 'queued' || values.token !== state.design.token) fail('DESIGN_ALREADY_RUNNING');
        state.design.status = 'running';
        state.design.startedAt = at;
      } else {
        if (values.token !== undefined) fail('STALE_DESIGN');
        state.design = { status, token: randomUUID(), baseRevision: state.revision, layoutVersion: state.layout.version, startedAt: at };
      }
      if (values.owner !== undefined) {
        if (!Number.isSafeInteger(values.owner) || values.owner < 1) fail('INVALID_REQUEST');
        state.design.owner = values.owner;
      }
      return;
    }
    if (operation === 'design-result' || operation === 'design-failed') {
      if (!object(values) || !['running', 'queued'].includes(state.design.status) || values.token !== state.design.token || values.baseRevision !== state.revision || values.layoutVersion !== state.layout.version) fail('STALE_DESIGN');
      if (!state.preferences.autoLayout) fail('STALE_DESIGN');
      if (operation === 'design-failed') {
        const errors = { DESIGN_INTERRUPTED: '整理中断，现有事项仍可使用', MODEL_UNAVAILABLE: '暂时无法整理，现有事项仍可使用', INVALID_PROPOSAL: '展示方案未通过校验，保留原看板', DESIGN_FAILED: '整理未完成，现有事项仍可使用' };
        const errorCode = Object.hasOwn(errors, values.errorCode) ? values.errorCode : 'DESIGN_FAILED';
        const diagnostic = values.diagnostic === undefined ? undefined : designDiagnostic(values.diagnostic);
        state.design = { ...state.design, status: 'failed', errorCode, error: errors[errorCode], finishedAt: at, ...(diagnostic && { diagnostic }) };
        return;
      }
      if (!Array.isArray(values.widgets) || values.widgets.length > 100) fail('INVALID_LAYOUT');
      const widgets = values.widgets.map(widget => {
        if (!object(widget) || !STORED_WIDGET_KINDS.has(widget.kind)) fail('INVALID_LAYOUT');
        const item = state.items.find(item => item.id === widget.itemId);
        if (!item || !allowedWidget(widget, item)) fail('INVALID_LAYOUT');
        const id = identifier(widget.id);
        // Identity is tied to the item and kind; an agent cannot bypass hidden
        // preferences by assigning new arbitrary IDs to the same content.
        if (id !== `${item.id}:${widget.kind}`) fail('INVALID_LAYOUT');
        const result = { id, kind: widget.kind, itemId: item.id };
        if (widget.emphasis !== undefined) { if (!['primary', 'normal', 'quiet'].includes(widget.emphasis)) fail('INVALID_LAYOUT'); result.emphasis = widget.emphasis; }
        if (widget.reason !== undefined) result.reason = str(widget.reason, 500, true);
        if (widget.section !== undefined) { if (!['next', 'plan', 'reference'].includes(widget.section)) fail('INVALID_LAYOUT'); result.section = widget.section; }
        if (widget.presentation !== undefined) { if (!['expanded', 'compact'].includes(widget.presentation)) fail('INVALID_LAYOUT'); result.presentation = widget.presentation; }
        return result;
      });
      if (new Set(widgets.map(widget => widget.id)).size !== widgets.length || widgets.filter(widget => widget.emphasis === 'primary').length > 1) fail('INVALID_LAYOUT');
      // Preserve fixed cards even when the design proposal omits them.
      for (const widget of state.layout.widgets) if (state.preferences.pinned.includes(widget.id) && !widgets.some(candidate => candidate.id === widget.id)) widgets.push(widget);
      let surfaces;
      try { surfaces = validateSurfaces(values.surfaces, widgets); } catch { fail('INVALID_LAYOUT'); }
      state.layout = { version: state.layout.version + 1, widgets: arranged(state, widgets), reason: str(values.reason ?? '根据当前生活事项整理', 1000, true), source: 'agent', ...(surfaces.length && { surfaces }) };
      state.design = { ...state.design, status: 'ready', finishedAt: at };
      return;
    }
    if (operation === 'preferences') {
      if (!object(values)) fail('INVALID_REQUEST');
      for (const [key, value] of Object.entries(values)) {
        if (key === 'autoLayout') { if (typeof value !== 'boolean') fail('INVALID_REQUEST'); state.preferences[key] = value; }
        else if (key === 'motion') { if (!['system', 'reduced', 'off'].includes(value)) fail('INVALID_REQUEST'); state.preferences[key] = value; }
        else if (['hidden', 'pinned', 'order'].includes(key)) state.preferences[key] = uniqueList(value);
        else fail('INVALID_REQUEST');
      }
    } else if (operation === 'layout') {
      // Manual layout changes are user ordering preferences, never executable code.
      if (!object(values) || values.version !== state.layout.version) fail('VERSION_CONFLICT');
      state.preferences.order = uniqueList(values.order);
    } else if (operation === 'add') {
      if (!object(values)) fail('INVALID_REQUEST');
      if (state.items.length >= 1000) fail('JOURNAL_CAPACITY_REACHED');
      const { source, status, ...itemValues } = values;
      const data = fields(itemValues, this.now(), timeZone);
      if (!data.title) fail('INVALID_REQUEST');
      if (status !== undefined && !['planned', 'active'].includes(status)) fail('INVALID_REQUEST');
      let origin = { kind: 'user', text: data.title, at, channel: 'web' };
      if (source !== undefined) {
        if (!object(source) || !(source.kind === 'guide' && source.channel === 'web' || source.kind === 'user' && ['web', 'weixin', 'imessage'].includes(source.channel) ||
          source.kind === 'automatic' && source.channel === 'background')) fail('INVALID_REQUEST');
        origin = { kind: source.kind, text: str(source.text, 20000), at: timestamp(source.at ?? at), channel: source.channel };
      }
      const item = { id: randomUUID(), version: 1, title: data.title, kind: 'arrangement', status: status ?? 'planned', date: null, note: '', source: origin, steps: [], candidates: [], taskType: 'auto', taskData: {}, ...data, createdAt: at, updatedAt: at };
      validateItemTaskData(item);
      state.items.push(item);
    } else {
      if (!['update', 'done', 'cancel', 'undo', 'delete', 'step', 'choose', 'widget'].includes(operation)) fail('INVALID_OPERATION');
      const item = state.items.find(item => item.id === request.itemId);
      if (!item) fail('ITEM_NOT_FOUND');
      if (request.itemVersion !== undefined && request.itemVersion !== item.version) fail('VERSION_CONFLICT');
      if (item.source?.kind === 'guide' && state.guide?.resultItemId && ['update', 'choose', 'step', 'widget', 'delete'].includes(operation)) fail('GUIDE_ALREADY_STARTED');
      if (operation === 'widget' && (!Number.isSafeInteger(request.itemVersion) || request.itemVersion < 1)) fail('INVALID_REQUEST');
      if (operation === 'delete') { state.items = state.items.filter(candidate => candidate.id !== item.id); delete state._undo[item.id]; }
      else {
        const itemBefore = copy(item);
        if (operation === 'undo') {
          if (!['done', 'cancelled'].includes(item.status) || !state._undo[item.id]) fail('INVALID_STATE');
          item.status = state._undo[item.id]; delete state._undo[item.id];
        } else if (operation === 'done' || operation === 'cancel') {
          if (['done', 'cancelled'].includes(item.status)) fail('INVALID_STATE');
          state._undo[item.id] = item.status; item.status = operation === 'done' ? 'done' : 'cancelled';
        } else {
          const completedUpdate = item.status === 'done' && operation === 'update';
          const completedWidget = item.status === 'done' && operation === 'widget' && ['reflection', 'memory'].includes(values.kind);
          if (['done', 'cancelled'].includes(item.status) && !completedUpdate && !completedWidget) fail('INVALID_STATE');
          if (operation === 'update') {
            const data = fields(values, this.now(), item.taskData?.habit?.timeZone || timeZone, item.taskData);
            if (completedUpdate) for (const [key, value] of Object.entries(data)) {
              if (key === 'note') continue;
              if (key === 'taskType') {
                if (value !== (item.taskType || 'auto')) fail('INVALID_STATE');
                if (item.taskType === undefined) delete data.taskType;
              } else if (key === 'taskData') {
                const original = item.taskData || {};
                for (const kind of new Set([...Object.keys(original), ...Object.keys(value)])) if (!['reflection', 'memory'].includes(kind) && !isDeepStrictEqual(original[kind], value[kind])) fail('INVALID_STATE');
              } else if (!isDeepStrictEqual(item[key], value)) fail('INVALID_STATE');
            }
            if (data.title !== undefined && data.title !== item.title) item.titleOrigin = 'explicit';
            Object.assign(item, data); validateItemTaskData(item);
          }
          else if (operation === 'widget') applyWidgetAction(item, values, { now: this.now(), timeZone });
          else if (operation === 'step') {
            const step = item.steps.find(step => step.id === values.stepId);
            if (!step || typeof values.done !== 'boolean') fail('INVALID_REQUEST');
            step.done = values.done;
          } else {
            if (!item.candidates.some(candidate => candidate.id === values.candidateId)) fail('INVALID_REQUEST');
            if (!fitsCandidate(item, values.candidateId)) fail('CANDIDATE_CONSTRAINT');
            for (const candidate of item.candidates) candidate.selected = candidate.id === values.candidateId;
          }
        }
        if (!isDeepStrictEqual(item, itemBefore)) {
          // Changed constraints invalidate a choice. Merely passing its date
          // does not erase a historical user preference from a completed item.
          invalidateIneligibleChoices(item);
          if (!(operation === 'widget' && values.kind === 'approval' && values.action === 'confirm')) invalidateConfirmation(item);
          item.version += 1; item.updatedAt = at;
        }
      }
    }
    if (!isDeepStrictEqual(state, previous)) {
      state.revision += 1;
      state.design = { status: 'idle', token: null, baseRevision: state.revision, layoutVersion: state.layout.version };
      refreshLayout(state, previous);
      state.design.layoutVersion = state.layout.version;
      state.events.push({ id: randomUUID(), revision: state.revision, type: operation, itemId: request.itemId ?? (operation === 'add' ? state.items.at(-1).id : null), at });
      state.events = state.events.slice(-100);
    }
  }
  ingest(scope, { text, sourceText = text, messageId, channel = 'weixin', at } = {}) {
    const match = typeof text === 'string' && text.match(/^\/journal\s+(add|done|cancel|undo)\s+([\s\S]+)$/i);
    if (!match) return { accepted: false, duplicate: false, snapshot: this.snapshot(scope) };
    const key = scopeKey(scope); str(messageId, 256); if (channel !== 'weixin' && channel !== 'web') fail('INVALID_REQUEST');
    return this.transaction(() => {
      const state = this.read(key);
      if (this.db.prepare('SELECT 1 FROM journal_messages WHERE account = ? AND user_id = ? AND message_id = ?').get(...key, messageId)) return { accepted: true, duplicate: true, snapshot: publicState(state) };
      const operation = match[1].toLowerCase();
      const request = operation === 'add' ? { operation, revision: state.revision, values: { title: match[2].trim(), source: { kind: 'user', text: sourceText, channel, at: at ?? new Date(this.now()).toISOString() } } } : { operation, revision: state.revision, itemId: match[2].trim() };
      this.apply(state, request);
      this.save(key, state);
      this.db.prepare('INSERT INTO journal_messages(account,user_id,message_id) VALUES(?,?,?)').run(...key, messageId);
      return { accepted: true, duplicate: false, snapshot: publicState(state) };
    });
  }
  listScopes() {
    if (!this.db) fail('STORAGE_UNAVAILABLE');
    return this.db.prepare('SELECT account, user_id FROM journal_scopes').all().map(row => ({ account: row.account, userId: row.user_id }));
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
}
