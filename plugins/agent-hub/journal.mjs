import { assertRoutineToolAccess } from './actions.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requireAction } from './actions.mjs';
import { failure } from './store.mjs';
import { WIDGET_KINDS, availableWidgetKinds, widgetCapabilities } from '../life-journal/widgets.mjs';

const LOCAL = Object.freeze({ account: 'local', userId: 'owner' });
const workflowGuide = readFileSync(new URL('../../skills/xiaoman-setup/references/runtime-workflows.md', import.meta.url), 'utf8');
const operations = ['list', 'get', 'preview', 'apply-preview', 'add', 'update', 'widget', 'done', 'cancel', 'undo'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
// This is a read-time recommendation gate, not a mutation of the user's plan.
export function journalRecommendation(item, now) {
  let reason = 'upcoming';
  if (!['planned', 'active'].includes(item.status)) reason = 'closed';
  else if (!item.date || !Number.isFinite(Date.parse(item.date))) reason = 'date_unconfirmed';
  else if (Date.parse(item.date) <= now) reason = 'past_date';
  return { eligible: reason === 'upcoming', reason };
}
// Public Web addresses come from instance configuration, never CLI ports.
export function journalView(itemId, origin = process.env.PA_WEB_ORIGIN) {
  const path = '/#journal' + (itemId ? '/' + encodeURIComponent(itemId) : '');
  let url = null;
  try {
    const address = new URL(origin);
    if (['http:', 'https:'].includes(address.protocol) && !address.username && !address.password && address.pathname === '/' && !address.search && !address.hash) url = address.origin + path;
  } catch { /* Without a public URL, supply a label instead of inventing one. */ }
  return { label: '生活手账 → 我的手账', path, url };
}
const invalidEnvelope = () => ({ saved: false, error: {
  code: 'INVALID_INPUT',
  message: 'No journal record changed. Read get again and copy its writeTemplate. Every write requires revision; existing-item writes also require itemId and itemVersion. Put ALL changing fields (including widget kind, action and data) inside values, never at the top level.',
  envelope: { operation: 'update or widget', revision: 'number returned by get', itemId: 'exact ID returned by get', itemVersion: 'number returned by get.item.version', values: 'object containing all changing fields; widget uses {kind,action,...parameters}' },
} });

export const JOURNAL_TOOL = {
  type: 'function', name: 'xiaoman_journal',
  description: 'Save and update the owner’s real life journal, shared by Web and this paired conversation. Use for birthdays, meals, shopping, trips, routines, materials and other life arrangements. List first on EVERY turn for revision, time zone, current workflowGuide and the 20 taskData field/action contracts; apply the relevant workflowGuide section even when resuming an old session; get an item before updating it. recommendation.eligible is a current date/status filter for unsolicited suggestions: exclude past_date, closed and date_unconfirmed, and respect pauses in notes. Never revive historical tasks or roll dates forward automatically; explicit historical questions can still be answered without changing records. During the guided first task, list/get also return firstTask: this current authenticated receipt is the authority for phase, confirmedProposal and savedItemId; initial job context and previous turns are only snapshots. Copy get.writeTemplate: every write MUST include revision, and every existing-item write MUST include itemId and itemVersion. Put all changing fields inside values. For widget actions the envelope is {operation:widget,revision,itemId,itemVersion,values:{kind,action,...parameters}}; never flatten kind/action/data into the outer object. For changing known meal servings or total budget, use preview with values:{parameters:{servings?,budgetTotal?}}, then apply-preview with the same values.parameters plus previewHash returned by preview. This atomically links eligible shopping quantities while preserving bought/atHome facts and progress. Explain warnings; only apply a user-requested adjustment, never save exploratory what-if previews. Guided first-task writes still require its confirmed add/update proposal. Set taskType to the appropriate task intent when clear, or auto; the read-only design Agent chooses available Widgets automatically. Save only provided facts or clearly identified planned steps; unknown dates, amounts, availability and receipts remain null/unknown. Widget actions record local facts and decisions; they never book, pay, send a message or deliver a reminder. Actual timed delivery uses xiaoman_reminders. Never claim a save without a successful receipt. Existing widgets may be basic projections: only claim the design Agent finished when design.status is ready for the current revision; otherwise report its actual queued/running/failed status. For viewing links use only the host-returned view.url. If it is null, give view.label; never infer a localhost URL or management port. Do not supply scope or source.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operation: { type: 'string', enum: operations },
    revision: { type: 'integer', minimum: 0, description: 'REQUIRED for every add/update/widget/done/cancel/undo. Copy the revision returned by list or get. Never omit it.' },
    itemId: { type: 'string', maxLength: 128 },
    itemVersion: { type: 'integer', minimum: 1, description: 'REQUIRED for every existing-item write. Copy get.item.version or get.writeTemplate.itemVersion.' },
    values: { type: 'object', description: 'add/update: title, kind(arrangement|purchase|experience|wish), date(ISO with timezone or null), note, steps[{id,label,done}], candidates[{id,name,detail,selected,url?}], taskType(auto or a task kind), taskData{kind:fields}. widget: {kind,action,...parameters} from capabilities; set-data replaces one kind. Do not supply source, scope, HTML, CSS or code.', additionalProperties: false, properties: {
      title: { type: 'string', maxLength: 300 }, kind: { type: 'string', enum: ['arrangement', 'purchase', 'experience', 'wish', ...WIDGET_KINDS] },
      parameters: { type: 'object', additionalProperties: false, properties: { servings: { type: 'integer', minimum: 1, maximum: 100 }, budgetTotal: { type: 'number', minimum: 0, maximum: 1000000000 } } },
      previewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      date: { anyOf: [{ type: 'string' }, { type: 'null' }] }, note: { type: 'string', maxLength: 10000 },
      taskType: { type: 'string', enum: ['auto', ...WIDGET_KINDS] }, taskData: { type: 'object', additionalProperties: false, properties: Object.fromEntries(WIDGET_KINDS.map(kind => [kind, { type: 'object', additionalProperties: true }])) },
      steps: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, label: { type: 'string' }, done: { type: 'boolean' } }, required: ['label', 'done'] } },
      candidates: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, detail: { type: 'string' }, selected: { type: 'boolean' }, url: { type: 'string' } }, required: ['name', 'selected'] } },
      action: { type: 'string' }, data: { type: 'object', additionalProperties: true },
      stepId: { type: 'string' }, done: { type: 'boolean' }, candidateId: { type: 'string' }, slotId: { type: 'string' },
      amount: { type: 'number' }, entryId: { type: 'string' }, quantity: { type: 'number' }, omittedStopIds: { type: 'array', items: { type: 'string' } },
      requestId: { type: 'string' }, text: { type: 'string' }, stageId: { type: 'string' }, at: { type: 'string' }, detail: { type: 'string' }, evidence: { type: 'string' },
      label: { type: 'string' }, minutesBefore: { type: 'integer' }, servings: { type: 'integer' }, entry: { type: 'object', additionalProperties: true },
      state: { type: 'string', enum: ['missing', 'provided'] }, optionId: { type: 'string' }, rating: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      caption: { type: 'string' }, occurredAt: { anyOf: [{ type: 'string' }, { type: 'null' }] }, personId: { type: 'string' }, name: { type: 'string' },
    } },
  }, required: ['operation'] },
};

// Authentication and source construction belong to the host. No model-selected
// owner, channel identity, internal design commit or remote side effect is exposed.
export async function journalTool({ hub, journal, firstTasks, read, token, input }) {
  const authorize = () => {
    const endpoint = hub.authenticate(token), run = hub.get('run', input.runId);
    const conversation = run && hub.get('conversation', run.conversationId);
    if (!run || run.endpointId !== endpoint.id || run.lease !== input.lease || !['running', 'waiting_approval', 'uncertain'].includes(run.status) || conversation?.ownerId !== 'owner') throw failure('FORBIDDEN');
    return run;
  };
  const run = authorize(), args = input.arguments;
  assertRoutineToolAccess(run, 'xiaoman_journal', args);
  if (object(args) && (Object.hasOwn(args, 'scope') || Object.hasOwn(args, 'source') || object(args.values) && (Object.hasOwn(args.values, 'source') || Object.hasOwn(args.values, 'scope')))) throw failure('INVALID_INPUT');
  if (!exact(args, ['operation', 'revision', 'itemId', 'itemVersion', 'values']) || !operations.includes(args.operation) || args.values !== undefined && !object(args.values)) return invalidEnvelope();
  const settings = await read(); authorize();
  const snapshot = await journal.snapshot(LOCAL, settings);
  if (run.routine) {
    // Historical bodies may belong to a prior authorization scope. Background
    // jobs receive only their own heading; the host supplies scoped fact keys.
    snapshot.items = snapshot.items.filter(item => item.id === run.journalItemId).map(item => ({ id: item.id, version: item.version, title: item.title, status: item.status, kind: item.kind, taskType: item.taskType, date: null, note: '', taskData: {}, steps: [], candidates: [] }));
    snapshot.layout = { ...snapshot.layout, widgets: [] };
  }
  authorize();
  const zone = settings.config.proactive?.timezone;
  const timezone = zone && zone !== 'local' ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const now = hub.now();
  const firstTaskContext = () => {
    const current = authorize();
    if (!current.firstTaskId) return {};
    // A native CLI thread may retain its original instructions on resume. Read
    // workflow consent from the current authenticated run, never that snapshot.
    const firstTask = firstTasks?.context(current);
    if (!firstTask) throw failure('FORBIDDEN');
    return { firstTask: { ...firstTask, timezone } };
  };
  if (args.operation === 'list') return {
    revision: snapshot.revision, now, timezone, design: snapshot.design, view: journalView(),
    workflowGuide, ...(run.journalItemId && { currentItemId: run.journalItemId, currentItemInstruction: '当前追聊关联此事项；先get读取最新内容，按本轮要求更新，不重复新增。' }),
    recommendationPolicy: 'Only current upcoming items may be considered for unsolicited suggestions. Exclude past_date, closed and date_unconfirmed; history is not a current task. Also respect user pauses and relevance. Do not silently reschedule, repeat next week, reopen or delete an item. Explicit questions about past items can be answered as history.',
    ...firstTaskContext(),
    capabilities: { kinds: WIDGET_KINDS, types: widgetCapabilities() },
    items: snapshot.items.slice(-100).map(item => ({ id: item.id, version: item.version, title: item.title, status: item.status, kind: item.kind, taskType: item.taskType || 'auto', date: item.date, note: item.note.slice(0, 1200), recommendation: journalRecommendation(item, now), availableKinds: availableWidgetKinds(item) })),
    totalItems: snapshot.items.length,
  };
  if (args.operation === 'get') {
    const item = snapshot.items.find(item => item.id === args.itemId);
    if (!item) throw failure('ITEM_NOT_FOUND');
    firstTasks?.recordRead?.(authorize(), item);
    return { revision: snapshot.revision, item, recommendation: journalRecommendation(item, now), view: journalView(item.id), writeTemplate: { operation: 'update', revision: snapshot.revision, itemId: item.id, itemVersion: item.version, values: {} }, widgets: snapshot.layout.widgets.filter(widget => widget.itemId === item.id), design: snapshot.design, layoutSource: snapshot.layout.source, now, timezone, ...firstTaskContext() };
  }
  if (args.operation === 'add' && run.journalItemId && hub.all('run').find(r => r.conversationId === run.conversationId)?.id === run.id) {
    const item = snapshot.items.find(item => item.id === run.journalItemId);
    if (!item) throw failure('ITEM_NOT_FOUND');
    return { saved: false, error: 'ITEM_ALREADY_EXISTS', message: '本轮交代已建立事项。请先 get 读取该事项，再用 update 补充，不重复新增。',
      itemId: item.id, writeTemplate: { operation: 'update', revision: snapshot.revision, itemId: item.id, itemVersion: item.version, values: {} } };
  }
  if (args.operation === 'preview') {
    if (!exact(args.values, ['parameters'])) return invalidEnvelope();
    const result = await journal.preview({ revision: args.revision, itemId: args.itemId, itemVersion: args.itemVersion, parameters: args.values.parameters, scope: LOCAL }, settings);
    authorize();
    return { saved: false, preview: result, view: journalView(args.itemId) };
  }
  if (typeof input.callId !== 'string' || !input.callId.trim() || input.callId.length > 200) throw failure('INVALID_INPUT');
  if (!Number.isSafeInteger(args.revision) || args.revision < 0 || args.operation !== 'add' && (!Number.isSafeInteger(args.itemVersion) || args.itemVersion < 1 || typeof args.itemId !== 'string') || ['add', 'update', 'widget'].includes(args.operation) && !object(args.values)) return invalidEnvelope();
  if (args.operation === 'apply-preview' && !exact(args.values, ['parameters', 'previewHash'])) return invalidEnvelope();
  firstTasks?.guardWrite(authorize(), args, input);
  const key = 'journal:' + run.id + ':' + input.callId;
  const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex');
  if (args.operation === 'cancel' && !hub.get('effect', key)) {
    const gate = requireAction(hub, { run: authorize(), tool: 'xiaoman_journal', parameters: args, callId: input.callId, approvalId: input.approvalId, title: snapshot.items.find(item => item.id === args.itemId)?.title });
    if (gate) return gate;
  }
  const previous = hub.transaction(() => {
    const old = hub.get('effect', key);
    if (old) return old;
    hub.put('effect', { id: key, digest, state: 'pending' }); return null;
  });
  if (previous) {
    if (previous.digest !== digest) throw failure('CONFLICT');
    if (previous.state === 'done') return { ...previous.result, view: journalView(previous.result.item?.id) };
    // Planning writes have an atomic receipt in the journal database. A crash
    // between that commit and this Hub effect must reconcile the same request.
    // Other writes have no such receipt and must remain uncertain.
    if (args.operation !== 'apply-preview' || !['pending', 'uncertain'].includes(previous.state)) throw failure(previous.error || 'EXECUTION_UNCERTAIN');
  }
  try {
    authorize();
    let committedRun;
    const sourceText = run.firstTaskId ? hub.all('message').filter(message => message.conversationId === run.conversationId && message.role === 'user' && message.createdAt <= run.createdAt).map(message => message.text).join('\n').slice(0, 10000) : run.prompt;
    const beforeCommit = () => { const current = authorize(); firstTasks?.guardWrite(current, args, input); committedRun = current; };
    const result = args.operation === 'apply-preview'
      ? await journal.applyPreview({ revision: args.revision, itemId: args.itemId, itemVersion: args.itemVersion, ...args.values, requestId: createHash('sha256').update(key).digest('hex'), scope: LOCAL }, settings, { beforeCommit })
      : await journal.mutate({ ...args, scope: LOCAL }, settings, { trustedSource: { kind: 'user', channel: run.source.channel, text: sourceText, at: new Date(run.createdAt).toISOString() }, beforeCommit });
    const item = args.operation === 'add' ? result.items.find(item => !snapshot.items.some(old => old.id === item.id)) : result.items.find(item => item.id === args.itemId);
    // item/revision are the current snapshot; applyReceipt identifies the
    // original commit even when another edit happened before reconciliation.
    const receipt = { saved: true, revision: result.revision, item, ...(result.applyReceipt ? { applyReceipt: result.applyReceipt } : {}), view: journalView(item?.id), design: result.design, ...(result.designRequest ? { designRequest: result.designRequest } : {}), designAvailable: result.designAvailable, scopeLabel: '我的手账' };
    hub.transaction(() => { hub.put('effect', { id: key, digest, state: 'done', result: receipt }); firstTasks?.recordReceipt(committedRun || run, receipt, input); }); return receipt;
  } catch (cause) {
    // Only apply-preview can reconcile against a durable journal receipt.
    // Other interrupted writes still require a read before any new action.
    hub.put('effect', { id: key, digest, state: cause.journalCommitted === false ? 'failed' : 'uncertain', error: cause.code || 'EXECUTION_UNCERTAIN' }); throw cause;
  }
}
