// Business contracts for the journal. These are user records, never demo data or
// promises that an external booking, message, payment or reminder was executed.
export const WIDGET_KINDS = Object.freeze(['agenda', 'time-grid', 'prep', 'decision', 'budget', 'shopping', 'itinerary', 'waiting', 'delivery', 'deadline', 'reminder', 'habit', 'meal', 'collection', 'documents', 'approval', 'recovery', 'reflection', 'memory', 'handoff']);
export const LEGACY_WIDGET_KINDS = Object.freeze(['focus', 'checklist', 'comparison', 'timeline', 'waiting', 'memory', 'wish']);
const aliases = { focus: 'agenda', checklist: 'prep', comparison: 'decision', timeline: 'agenda', wish: 'collection' };
export const canonicalWidgetKind = kind => aliases[kind] || kind;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code = 'INVALID_TASK_DATA', message = code) => { throw Object.assign(new Error(message), { code }); };
const exact = (value, keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail(); };
const text = (value, max = 2000) => { if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(); return value; };
const nonempty = value => { text(value, 500); if (!value.trim()) fail(); return value; };
const id = value => { text(value, 128); if (!/^[a-zA-Z0-9:_-]+$/.test(value)) fail(); return value; };
const number = (value, min = 0, max = 1_000_000_000) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(); return value; };
const integer = (value, min = 0, max = 100_000) => { number(value, min, max); if (!Number.isSafeInteger(value)) fail(); return value; };
const money = value => { number(value); if (Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) fail(); return value; };
const bool = value => { if (typeof value !== 'boolean') fail(); return value; };
const enumeration = values => value => { if (!values.includes(value)) fail(); return value; };
const nullable = validate => value => value === null ? null : validate(value);
export function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) fail();
  const [year, month, day] = value.split('-').map(Number);
  const probe = new Date(`${value}T00:00:00Z`);
  if (year < 1 || month < 1 || month > 12 || day < 1 || !Number.isFinite(probe.getTime()) || probe.toISOString().slice(0, 10) !== value) fail();
  return value;
}
export function validateTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail();
  validateDate(value.slice(0, 10));
  const hour = Number(value.slice(11, 13)), minute = Number(value.slice(14, 16));
  const seconds = value.slice(16, 19).startsWith(':') ? Number(value.slice(17, 19)) : 0;
  const offset = value.match(/[+-](\d\d):(\d\d)$/);
  if (hour > 23 || minute > 59 || seconds > 59 || offset && (Number(offset[1]) > 14 || Number(offset[2]) > 59 || Number(offset[1]) === 14 && Number(offset[2]) !== 0) || !Number.isFinite(Date.parse(value))) fail();
  return new Date(value).toISOString();
}
const url = value => { text(value, 2048); let parsed; try { parsed = new URL(value); } catch { fail(); } if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(); return parsed.href; };
const array = (validate, max = 100) => value => { if (!Array.isArray(value) || value.length > max) fail(); return value.map(validate); };
const unique = (values, get = value => value) => { if (new Set(values.map(get)).size !== values.length) fail(); return values; };
const rows = validate => value => unique(array(validate)(value), row => row.id);
const texts = array(value => text(value, 1000));
const ids = value => unique(array(id)(value));
const field = (validate, fallback) => ({ validate, fallback });
const record = spec => value => {
  exact(value, Object.keys(spec));
  return Object.fromEntries(Object.entries(spec).map(([key, definition]) => [key, definition.validate(value[key] === undefined ? clone(definition.fallback) : value[key])]));
};
const row = spec => value => { const result = record(spec)(value); id(result.id); return result; };
const fText = (max = 2000) => field(value => text(value, max), '');
const fRequiredText = (max = 2000) => field(value => { text(value, max); if (!value.trim()) fail(); return value; }, '');
const fDate = () => field(nullable(validateTimestamp), null);
const fMoney = () => field(nullable(money), null);
const fNumber = () => field(nullable(value => number(value, 0.000001)), null);
const fArray = validator => field(validator, []);
const fId = () => field(nullable(id), null);
const period = record({ start: field(validateTimestamp, null), end: field(validateTimestamp, null), label: fText(500) });
const criteriaRow = row({ id: field(id, null), label: fRequiredText(100) });
const decisionOption = value => {
  exact(value, ['candidateId', 'amount', 'widthCm', 'fields']);
  const result = record({ candidateId: field(id, null), amount: fMoney(), widthCm: fNumber(), fields: field(value => { if (!object(value) || Object.keys(value).length > 30) fail(); return Object.fromEntries(Object.entries(value).map(([key, val]) => [id(key), nullable(value => text(value, 1000))(val)])); }, {}) })(value);
  id(result.candidateId); return result;
};
const timezone = value => { text(value, 100); try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { fail(); } return value; };
const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// Each type has its own explicit fields. Missing measurements are null; no
// numeric zero, invented date, inventory, quote or external receipt is supplied.
const schemas = {
  agenda: record({ durationMinutes: field(nullable(value => integer(value, 1, 1440)), null), place: fText(500), flexible: field(bool, false) }),
  'time-grid': record({ durationMinutes: field(nullable(value => integer(value, 1, 1440)), null), bufferMinutes: field(value => integer(value, 0, 1440), 0), slots: fArray(rows(row({ id: field(id, null), start: field(validateTimestamp, null), status: field(enumeration(['available', 'busy', 'unknown']), 'unknown'), reason: fText(500) }))), constraints: fArray(array(period)), selectedSlotId: fId() }),
  prep: record({ phases: fArray(rows(row({ id: field(id, null), label: fRequiredText(200), stepIds: field(ids, []) }))), activePhaseId: fId() }),
  decision: record({ criteria: fArray(rows(criteriaRow)), options: fArray(value => unique(array(decisionOption, 30)(value), option => option.candidateId)), budget: fMoney(), widthLimitCm: fNumber() }),
  budget: record({ currency: field(enumeration(['CNY']), 'CNY'), total: fMoney(), lines: fArray(rows(row({ id: field(id, null), label: fRequiredText(500), amount: fMoney() }))), reserve: field(money, 0) }),
  shopping: record({ entries: fArray(rows(row({ id: field(id, null), name: field(nonempty, ''), category: fText(200), quantity: fNumber(), unit: fText(50), atHome: field(bool, false), bought: field(bool, false) }))) }),
  itinerary: record({ stops: fArray(rows(row({ id: field(id, null), name: field(nonempty, ''), start: fDate(), end: fDate(), optional: field(bool, false) }))), legs: fArray(array(record({ from: field(id, null), to: field(id, null), mode: fText(200), minutes: field(nullable(value => integer(value, 0, 10080)), null) }))), omittedStopIds: field(ids, []) }),
  waiting: record({ requests: fArray(rows(row({ id: field(id, null), person: field(nonempty, ''), request: field(nonempty, ''), status: field(enumeration(['unknown', 'waiting', 'agreed', 'declined']), 'unknown'), due: fDate(), draft: fText(2000) }))) }),
  delivery: record({ reference: fText(500), stages: fArray(rows(criteriaRow)), events: fArray(array(record({ stageId: field(id, null), at: field(validateTimestamp, null), detail: fRequiredText(2000), evidence: fRequiredText(2000) }))) }),
  deadline: record({ dueAt: fDate(), nextAt: fDate(), nextLabel: fText(500) }),
  reminder: record({ at: fDate(), minutesBefore: field(nullable(value => integer(value, 0, 10080)), null), recordedAt: fDate() }),
  habit: record({ targetPerWeek: field(nullable(value => integer(value, 1, 7)), null), dates: field(value => unique(array(validateDate, 3660)(value)), []), timeZone: field(timezone, defaultTimeZone) }),
  meal: record({ baseServings: field(nullable(value => integer(value, 1, 100)), null), servings: field(nullable(value => integer(value, 1, 100)), null), ingredients: fArray(rows(row({ id: field(id, null), name: field(nonempty, ''), quantity: fNumber(), unit: fText(50) }))), instructions: fArray(rows(row({ id: field(id, null), label: field(nonempty, ''), done: field(bool, false), durationMinutes: field(nullable(value => integer(value, 0, 1440)), null) }))) }),
  collection: record({ entries: fArray(rows(row({ id: field(id, null), title: field(nonempty, ''), note: fText(5000), url: field(nullable(url), null) }))) }),
  documents: record({ entries: fArray(rows(row({ id: field(id, null), name: field(nonempty, ''), type: fText(100), state: field(enumeration(['missing', 'provided']), 'missing'), note: fText(5000), url: field(nullable(url), null) }))) }),
  approval: record({ summary: fText(2000), amount: fMoney(), currency: field(enumeration(['CNY']), 'CNY'), scheduledAt: fDate(), conditions: field(texts, []), confirmation: field(nullable(record({ itemVersion: field(value => integer(value, 1, Number.MAX_SAFE_INTEGER), null), at: field(validateTimestamp, null) })), null) }),
  recovery: record({ blocker: fText(2000), known: field(texts, []), missing: field(texts, []), options: fArray(rows(criteriaRow)), selectedOptionId: fId() }),
  reflection: record({ rating: field(nullable(value => integer(value, 1, 5)), null), text: fText(10000) }),
  memory: record({ text: fText(10000), occurredAt: fDate(), caption: fText(2000) }),
  handoff: record({ people: fArray(rows(row({ id: field(id, null), name: field(nonempty, ''), role: fText(500), tasks: field(texts, []) }))), condition: fText(2000), note: fText(5000) }),
};

function validateKindData(kind, value, { recorded = false, now = Date.now(), timeZone } = {}) {
  if (!WIDGET_KINDS.includes(kind)) fail();
  if (kind === 'habit' && timeZone && object(value) && !Object.hasOwn(value, 'timeZone')) value = { ...value, timeZone };
  const data = schemas[kind](value);
  if (!recorded && kind === 'approval' && data.confirmation !== null || !recorded && kind === 'reminder' && data.recordedAt !== null) fail();
  if (kind === 'time-grid') {
    for (const slot of data.slots) { id(slot.id); validateTimestamp(slot.start); }
    for (const constraint of data.constraints) if (!constraint.start || !constraint.end || Date.parse(constraint.end) <= Date.parse(constraint.start)) fail();
    if (data.selectedSlotId && !data.slots.some(slot => slot.id === data.selectedSlotId)) fail();
  }
  if (kind === 'prep' && data.activePhaseId && !data.phases.some(phase => phase.id === data.activePhaseId)) fail();
  if (kind === 'decision') for (const option of data.options) if (Object.keys(option.fields).some(key => !data.criteria.some(criterion => criterion.id === key))) fail();
  if (kind === 'budget' && data.total !== null && data.reserve > 0 && sumCents(data.lines) + cents(data.reserve) > cents(data.total)) fail('BUDGET_EXCEEDED');
  if (kind === 'itinerary') {
    for (const stop of data.stops) if (stop.start && stop.end && Date.parse(stop.end) < Date.parse(stop.start)) fail();
    if (data.omittedStopIds.some(stopId => !data.stops.some(stop => stop.id === stopId && stop.optional))) fail();
    for (const leg of data.legs) if (!leg.from || !leg.to || leg.from === leg.to || !data.stops.some(stop => stop.id === leg.from) || !data.stops.some(stop => stop.id === leg.to)) fail();
    unique(data.legs, leg => `${leg.from}:${leg.to}`);
  }
  if (kind === 'delivery') {
    let previousAt = -Infinity, previousStage = -1;
    for (const event of data.events) {
      const stage = data.stages.findIndex(candidate => candidate.id === event.stageId), at = Date.parse(event.at);
      if (stage < 0 || !event.at || at < previousAt || stage < previousStage) fail();
      if (at > now) fail('FUTURE_EVIDENCE');
      previousAt = at; previousStage = stage;
    }
  }
  if (kind === 'habit' && data.dates.some(date => date > dateInZone(now, data.timeZone))) fail('FUTURE_CHECK_IN');
  if (kind === 'deadline' && data.dueAt && data.nextAt && Date.parse(data.nextAt) > Date.parse(data.dueAt)) fail('DEADLINE_EXCEEDED');
  if (kind === 'recovery' && data.selectedOptionId && !data.options.some(option => option.id === data.selectedOptionId)) fail();
  return data;
}
export function validateTaskData(value, { existingTaskData, ...options } = {}) {
  exact(value, WIDGET_KINDS);
  return Object.fromEntries(Object.entries(value).map(([kind, data]) => {
    const systemField = kind === 'approval' ? 'confirmation' : kind === 'reminder' ? 'recordedAt' : null;
    const existing = existingTaskData?.[kind];
    if (!systemField || !existing) return [kind, validateKindData(kind, data, options)];
    // Whole-item editing may replay the original receipt, never forge or alter
    // it. Omitting this read-only field preserves its prior value. The store
    // separately invalidates a plan confirmation after actual fact changes.
    const prior = existing[systemField] ?? null;
    const input = object(data) && !Object.hasOwn(data, systemField) ? { ...data, [systemField]: clone(prior) } : data;
    const normalized = validateKindData(kind, input, { ...options, recorded: true });
    if (JSON.stringify(normalized[systemField]) !== JSON.stringify(prior)) fail();
    return [kind, normalized];
  }));
}
export function validateTaskType(value) { if (value !== 'auto' && !WIDGET_KINDS.includes(value)) fail(); return value; }
const cents = value => Math.round(value * 100);
const sumCents = lines => lines.reduce((sum, line) => sum + (line.amount === null ? 0 : cents(line.amount)), 0);
const active = item => !['done', 'cancelled'].includes(item.status);
// Basic rendering follows known material and an explicit user intent, so an
// unclassified note never creates eighteen empty cards before AI selection.
export function materialWidgetKinds(item) {
  if (!item || item.status === 'cancelled') return [];
  if (item.source?.kind === 'automatic') return ['collection'];
  if (item.source?.kind === 'guide') return ['decision'];
  if (item.status === 'done') return ['reflection', 'memory'];
  const kinds = new Set(Object.keys(item.taskData || {}).filter(kind => WIDGET_KINDS.includes(kind)));
  if (item.taskType && item.taskType !== 'auto' && WIDGET_KINDS.includes(item.taskType)) kinds.add(item.taskType);
  if (item.steps?.length) kinds.add('prep');
  if (item.candidates?.length) kinds.add(item.candidates.some(candidate => candidate.selected) ? 'waiting' : 'decision');
  if (item.date) kinds.add('agenda');
  if (item.kind === 'experience') kinds.add('memory');
  if (item.kind === 'wish') kinds.add('collection');
  if (!kinds.size) kinds.add('agenda');
  return [...kinds];
}
// Choosing a structure is not asserting its missing facts. An automatic item
// can use an empty budget, file folder or habit grid and ask for its material.
// A retrospective structure needs an experience, provided material, or an
// explicit user intent; merely scheduling something is not a lived memory.
export function availableWidgetKinds(item) {
  if (!item || item.status === 'cancelled') return [];
  if (item.source?.kind === 'automatic') return ['collection'];
  if (item.source?.kind === 'guide') return ['decision'];
  if (item.status === 'done') return ['reflection', 'memory'];
  if (item.taskType && item.taskType !== 'auto') return materialWidgetKinds(item);
  return WIDGET_KINDS.filter(kind => !['reflection', 'memory'].includes(kind) || item.kind === 'experience' || Object.hasOwn(item.taskData || {}, kind));
}
export function allowedWidget(widget, item) {
  if (!widget || !item || item.status === 'cancelled') return false;
  if (item.source?.kind === 'automatic') return canonicalWidgetKind(widget.kind) === 'collection';
  if (widget.kind === 'focus') return active(item);
  if (widget.kind === 'checklist') return active(item) && Boolean(item.steps?.length);
  if (widget.kind === 'comparison') return active(item) && Boolean(item.candidates?.length) && !item.candidates.some(candidate => candidate.selected);
  if (widget.kind === 'timeline') return active(item) && Boolean(item.date);
  if (widget.kind === 'wish') return active(item) && item.kind === 'wish';
  // Existing waiting/memory cards share modern names and remain readable.
  if (widget.kind === 'waiting' && active(item)) return true;
  if (widget.kind === 'memory' && (item.status === 'done' || item.kind === 'experience')) return true;
  return availableWidgetKinds(item).includes(widget.kind);
}
export function validateItemTaskData(item) {
  const data = item.taskData || {};
  if (data.prep) {
    const assigned = data.prep.phases.flatMap(phase => phase.stepIds);
    unique(assigned);
    if (assigned.some(stepId => !item.steps.some(step => step.id === stepId))) fail();
  }
  if (data.decision?.options.some(option => !item.candidates.some(candidate => candidate.id === option.candidateId))) fail();
}

const action = (action, label, enabled, required = []) => ({ action, label, enabled, required });
export function fitsCandidate(item, candidateId) {
  const data = item.taskData?.decision;
  if (!data) return true; // Legacy candidates have no recorded hard constraints.
  const option = data.options.find(option => option.candidateId === candidateId);
  if (data.budget !== null && (!option || option.amount === null || option.amount > data.budget)) return false;
  if (data.widthLimitCm !== null && (!option || option.widthCm === null || option.widthCm > data.widthLimitCm)) return false;
  return true;
}
function slotProblem(data, slot, now) {
  if (!slot || slot.status !== 'available') return '尚无可用时段的材料';
  if (now !== undefined && Date.parse(slot.start) < now) return '该时段已经过去';
  if (data.durationMinutes === null) return '请补充所需时长';
  const start = Date.parse(slot.start), end = start + (data.durationMinutes + data.bufferMinutes) * 60_000;
  if (data.constraints.some(block => start < Date.parse(block.end) && end > Date.parse(block.start))) return '该时段连同收尾缓冲与已有安排冲突';
  return null;
}
const dateInZone = (now, timeZone) => {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const value = name => parts.find(part => part.type === name).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
};
export function projectWidget(item, requestedKind, { now = Date.now(), timeZone } = {}) {
  const kind = canonicalWidgetKind(requestedKind);
  if (!WIDGET_KINDS.includes(kind)) fail('INVALID_WIDGET');
  const data = clone(item.taskData?.[kind] || schemas[kind](kind === 'habit' && timeZone ? { timeZone } : {}));
  const missing = [], actions = [], editable = active(item) || ['reflection', 'memory'].includes(kind) && item.status === 'done';
  switch (kind) {
    case 'agenda': data.date = item.date; if (!data.date) missing.push('日期与时间'); actions.push(action('schedule', '记下安排时间', editable, ['date'])); break;
    case 'time-grid': data.slots = data.slots.map(slot => ({ ...slot, selectable: !slotProblem(data, slot, now), blockedReason: slotProblem(data, slot, now) })); if (!data.slots.length) missing.push('候选时段'); if (data.durationMinutes === null) missing.push('所需时长'); actions.push(action('choose-slot', '记下时间偏好', editable && data.slots.some(slot => slot.selectable), ['slotId'])); break;
    case 'prep': data.steps = clone(item.steps); if (!data.steps.length) missing.push('准备步骤'); actions.push(action('step', '记下步骤完成情况', editable && data.steps.length > 0, ['stepId', 'done'])); break;
    case 'decision': data.candidates = item.candidates.map(candidate => ({ ...clone(candidate), ...clone(data.options.find(option => option.candidateId === candidate.id) || {}), selectable: fitsCandidate(item, candidate.id) })); if (!data.candidates.length) missing.push('候选资料'); actions.push(action('choose', '记下候选选择', editable && data.candidates.some(candidate => candidate.selectable), ['candidateId'])); break;
    case 'budget': data.knownAmount = sumCents(data.lines) / 100; data.unknownLineIds = data.lines.filter(line => line.amount === null).map(line => line.id); data.remaining = data.total === null ? null : (cents(data.total) - sumCents(data.lines) - cents(data.reserve)) / 100; if (data.total === null) missing.push('预算上限'); if (!data.lines.length) missing.push('费用项目'); actions.push(action('reserve', '记下预算预留', editable && data.total !== null, ['amount'])); break;
    case 'shopping': if (!data.entries.length) missing.push('采购物品与数量'); actions.push(action('mark-bought', '记下物品已买', editable && data.entries.some(entry => !entry.atHome), ['entryId', 'done']), action('quantity', '修改采购数量', editable && data.entries.length > 0, ['entryId', 'quantity'])); break;
    case 'itinerary': {
      data.visibleStops = data.stops.filter(stop => !data.omittedStopIds.includes(stop.id));
      data.segments = data.visibleStops.slice(1).map((stop, index) => { const from = data.visibleStops[index].id; return clone(data.legs.find(leg => leg.from === from && leg.to === stop.id) || { from, to: stop.id, mode: '', minutes: null }); });
      if (!data.stops.length) missing.push('路线地点'); if (data.segments.some(leg => leg.minutes === null)) missing.push('路段用时待核实'); actions.push(action('set-route', '记下路线取舍', editable && data.stops.some(stop => stop.optional), ['omittedStopIds'])); break;
    }
    case 'waiting': data.selectedCandidates = clone(item.candidates.filter(candidate => candidate.selected)); if (!data.requests.length) missing.push('联系对象、要等的回音'); actions.push(action('save-draft', '保存催询草稿', editable && data.requests.length > 0, ['requestId', 'text'])); break;
    case 'delivery': data.currentStageId = data.events.at(-1)?.stageId || null; if (!data.events.length) missing.push('已知履约回执'); if (!data.stages.length) missing.push('履约阶段'); actions.push(action('record-event', '记下收到的回执', editable && data.stages.length > 0, ['stageId', 'at', 'detail', 'evidence'])); break;
    case 'deadline': data.remainingMinutes = data.dueAt ? Math.floor((Date.parse(data.dueAt) - now) / 60_000) : null; if (!data.dueAt) missing.push('明确截止时间'); actions.push(action('schedule', '记下下一步时间', editable && Boolean(data.dueAt), ['at', 'label'])); break;
    case 'reminder': data.notifyAt = data.at && data.minutesBefore !== null ? new Date(Date.parse(data.at) - data.minutesBefore * 60_000).toISOString() : null; data.deliveryStatus = 'plan-only'; if (!data.at) missing.push('事项时间'); if (data.minutesBefore === null) missing.push('提前多久'); actions.push(action('record-reminder', '保存提醒计划', editable, ['at', 'minutesBefore'])); break;
    case 'habit': { data.today = dateInZone(now, data.timeZone); const day = new Date(`${data.today}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7); data.weekStart = day.toISOString().slice(0, 10); data.weekCount = data.dates.filter(date => date >= data.weekStart && date <= data.today).length; if (data.targetPerWeek === null) missing.push('每周目标'); actions.push(action('check-in', '记下今天的打卡', editable, ['date', 'done'])); break; }
    case 'meal': data.scaledIngredients = data.ingredients.map(ingredient => ({ ...ingredient, scaledQuantity: ingredient.quantity !== null && data.baseServings !== null && data.servings !== null ? Math.round(ingredient.quantity * data.servings / data.baseServings * 1000) / 1000 : null })); if (!data.ingredients.length) missing.push('食材及基础份量'); if (!data.instructions.length) missing.push('烹饪步骤'); actions.push(action('set-servings', '调整用餐人数', editable && data.baseServings !== null, ['servings']), action('meal-step', '记下这一步已完成', editable && data.instructions.length > 0, ['stepId', 'done'])); break;
    case 'collection': if (!data.entries.length) missing.push('用户提供的收藏材料'); actions.push(action('add-entry', '留下一个收藏', editable, ['entry'])); break;
    case 'documents': if (!data.entries.length) missing.push('材料清单'); actions.push(action('mark-document', '记下材料已提供', editable && data.entries.length > 0, ['entryId', 'state'])); break;
    case 'approval': data.confirmed = Boolean(data.confirmation && data.confirmation.itemVersion === item.version); if (!data.summary.trim()) missing.push('待确认内容'); if (data.amount === null) missing.push('明确金额（无费用填 0）'); actions.push(action('confirm', '确认这份计划', editable && !missing.length && !data.confirmed), action('revoke', '撤回计划确认', editable && data.confirmed)); break;
    case 'recovery': if (!data.blocker.trim()) missing.push('当前阻塞与材料'); if (!data.options.length) missing.push('下一步候选方向'); actions.push(action('choose-path', '记下下一步方向', editable && data.options.length > 0, ['optionId'])); break;
    case 'reflection': if (!data.text && data.rating === null) missing.push('体验评价'); actions.push(action('save-reflection', '留下这次评价', editable, ['rating', 'text'])); break;
    case 'memory': data.text ||= item.note || ''; data.occurredAt ||= item.date || null; if (!data.text) missing.push('想留下的原话'); actions.push(action('save-memory', '留下这段记忆', editable, ['text', 'caption', 'occurredAt'])); break;
    case 'handoff': if (!data.people.length) missing.push('参与者与分工'); actions.push(action('set-owner', '记下负责人', editable && data.people.length > 0, ['personId', 'name'])); break;
  }
  actions.push(action('set-data', '补充或校对材料', editable, ['data']));
  return { kind, requestedKind, itemId: item.id, itemVersion: item.version, title: item.title, status: item.status, data, empty: missing.length > 0, missing, actions };
}

const actionKeys = {
  agenda: { schedule: ['date'] }, 'time-grid': { 'choose-slot': ['slotId'] }, prep: { step: ['stepId', 'done'] }, decision: { choose: ['candidateId'] }, budget: { reserve: ['amount'] }, shopping: { 'mark-bought': ['entryId', 'done'], quantity: ['entryId', 'quantity'] }, itinerary: { 'set-route': ['omittedStopIds'] }, waiting: { 'save-draft': ['requestId', 'text'] }, delivery: { 'record-event': ['stageId', 'at', 'detail', 'evidence'] }, deadline: { schedule: ['at', 'label'] }, reminder: { 'record-reminder': ['at', 'minutesBefore'] }, habit: { 'check-in': ['date', 'done'] }, meal: { 'set-servings': ['servings'], 'meal-step': ['stepId', 'done'] }, collection: { 'add-entry': ['entry'] }, documents: { 'mark-document': ['entryId', 'state'] }, approval: { confirm: [], revoke: [] }, recovery: { 'choose-path': ['optionId'] }, reflection: { 'save-reflection': ['rating', 'text'] }, memory: { 'save-memory': ['text', 'caption', 'occurredAt'] }, handoff: { 'set-owner': ['personId', 'name'] },
};
export function applyWidgetAction(item, values, { now = Date.now(), timeZone } = {}) {
  if (!object(values) || !WIDGET_KINDS.includes(values.kind)) fail('INVALID_WIDGET');
  const { kind, action: name } = values;
  if (item.status === 'cancelled' || item.status === 'done' && !['reflection', 'memory'].includes(kind)) fail('INVALID_STATE');
  const keys = name === 'set-data' ? ['data'] : Object.hasOwn(actionKeys[kind], name) ? actionKeys[kind][name] : null;
  if (!keys) fail('INVALID_WIDGET_ACTION');
  exact(values, ['kind', 'action', ...keys]);
  for (const key of keys) if (!Object.hasOwn(values, key)) fail();
  item.taskData ||= {};
  const data = clone(item.taskData[kind] || schemas[kind](kind === 'habit' && timeZone ? { timeZone } : {}));
  if (name === 'set-data') {
    const next = validateKindData(kind, values.data, { now, timeZone: kind === 'habit' ? data.timeZone : timeZone });
    item.taskData[kind] = next;
    validateItemTaskData(item);
    return;
  }
  switch (kind) {
    case 'agenda': item.date = validateTimestamp(values.date); break;
    case 'time-grid': { const slot = data.slots.find(slot => slot.id === values.slotId); const problem = slotProblem(data, slot, now); if (problem) fail('SLOT_UNAVAILABLE', problem); data.selectedSlotId = slot.id; break; }
    case 'prep': { const step = item.steps.find(step => step.id === values.stepId); if (!step) fail(); step.done = bool(values.done); break; }
    case 'decision': if (!item.candidates.some(candidate => candidate.id === values.candidateId)) fail(); if (!fitsCandidate(item, values.candidateId)) fail('CANDIDATE_CONSTRAINT'); for (const candidate of item.candidates) candidate.selected = candidate.id === values.candidateId; break;
    case 'budget': data.reserve = money(values.amount); if (data.total === null) fail('MISSING_BUDGET'); if (data.reserve > 0 && sumCents(data.lines) + cents(data.reserve) > cents(data.total)) fail('BUDGET_EXCEEDED'); break;
    case 'shopping': { const entry = data.entries.find(entry => entry.id === values.entryId); if (!entry) fail(); if (name === 'mark-bought') { if (entry.atHome) fail('INVALID_STATE'); entry.bought = bool(values.done); } else entry.quantity = number(values.quantity, 0.000001); break; }
    case 'itinerary': data.omittedStopIds = ids(values.omittedStopIds); break;
    case 'waiting': { const request = data.requests.find(request => request.id === values.requestId); if (!request) fail(); request.draft = text(values.text, 2000); break; }
    case 'delivery': { const at = validateTimestamp(values.at); if (Date.parse(at) > now) fail('FUTURE_EVIDENCE'); const detail = text(values.detail, 2000), evidence = text(values.evidence, 2000); if (!detail.trim() || !evidence.trim()) fail(); data.events.push({ stageId: id(values.stageId), at, detail, evidence }); break; }
    case 'deadline': if (!data.dueAt) fail('MISSING_DEADLINE'); data.nextAt = validateTimestamp(values.at); data.nextLabel = nonempty(values.label); if (Date.parse(data.nextAt) < now) fail('PAST_SCHEDULE'); break;
    case 'reminder': data.at = validateTimestamp(values.at); data.minutesBefore = integer(values.minutesBefore, 0, 10080); if (Date.parse(data.at) - data.minutesBefore * 60_000 < now) fail('PAST_SCHEDULE'); data.recordedAt = new Date(now).toISOString(); break;
    case 'habit': { const date = validateDate(values.date), today = dateInZone(now, data.timeZone); if (date > today) fail('FUTURE_CHECK_IN'); if (bool(values.done)) data.dates = [...new Set([...data.dates, date])].sort(); else data.dates = data.dates.filter(recorded => recorded !== date); break; }
    case 'meal': if (name === 'set-servings') { if (data.baseServings === null) fail('MISSING_BASE_SERVINGS'); data.servings = integer(values.servings, 1, 100); } else { const step = data.instructions.find(step => step.id === values.stepId); if (!step) fail(); step.done = bool(values.done); } break;
    case 'collection': data.entries.push(schemas.collection({ entries: [values.entry] }).entries[0]); break;
    case 'documents': { const entry = data.entries.find(entry => entry.id === values.entryId); if (!entry) fail(); entry.state = enumeration(['missing', 'provided'])(values.state); break; }
    case 'approval': if (name === 'revoke') data.confirmation = null; else { if (!data.summary.trim() || data.amount === null) fail('MISSING_APPROVAL_FACTS'); if (data.confirmation?.itemVersion === item.version) return; data.confirmation = { itemVersion: item.version + 1, at: new Date(now).toISOString() }; } break;
    case 'recovery': if (!data.options.some(option => option.id === values.optionId)) fail(); data.selectedOptionId = values.optionId; break;
    case 'reflection': data.rating = nullable(value => integer(value, 1, 5))(values.rating); data.text = text(values.text, 10000); if (!data.text.trim() && data.rating === null) fail(); break;
    case 'memory': data.text = text(values.text, 10000); if (!data.text.trim()) fail(); data.caption = text(values.caption, 2000); data.occurredAt = nullable(validateTimestamp)(values.occurredAt); break;
    case 'handoff': { const person = data.people.find(person => person.id === values.personId); if (!person) fail(); person.name = nonempty(values.name); break; }
  }
  item.taskData[kind] = validateKindData(kind, data, { recorded: true, now });
  validateItemTaskData(item);
}
export function invalidateConfirmation(item) {
  if (item.taskData?.approval?.confirmation) item.taskData.approval.confirmation = null;
}
export function invalidateIneligibleChoices(item, { now } = {}) {
  const grid = item.taskData?.['time-grid'];
  if (grid?.selectedSlotId && slotProblem(grid, grid.slots.find(slot => slot.id === grid.selectedSlotId), now)) grid.selectedSlotId = null;
  for (const candidate of item.candidates || []) if (candidate.selected && !fitsCandidate(item, candidate.id)) candidate.selected = false;
}

// Plain, bounded descriptions are included in the trusted tool and design
// prompt. They describe the same fields validated above, not sample content.
const capabilities = {
  agenda: { label: '今日议程', fields: { durationMinutes: '整数 1–1440 或 null；尚不知道时长保留 null', place: '用户给出的地点文本，<=500字', flexible: 'boolean；是否可移动。实际时间复用 item.date' } },
  'time-grid': { label: '可选时间', fields: { durationMinutes: '整数 1–1440 或 null', bufferMinutes: '整数 0–1440，用户确认的收尾/返程缓冲', slots: '[{id,start:含时区的ISO日期时间,status:available|busy|unknown,reason:文本}]；available仅表示用户提供材料，不等于实单', constraints: '[{start,end:含时区的ISO日期时间,label:文本}]；end必须晚于start', selectedSlotId: '候选slot id或null，记录偏好不预订' } },
  prep: { label: '分阶段准备', fields: { phases: '[{id,label,stepIds:[item.steps中存在的id]}]；每个step只能属于一个阶段', activePhaseId: '阶段id或null。具体步骤复用 item.steps [{id,label,done}]' } },
  decision: { label: '候选比较', fields: { criteria: '[{id,label}]；同字段比较', options: '[{candidateId:已存在的item.candidates id,amount:金额|null,widthCm:正数|null,fields:{criterionId:文本|null}}]', budget: 'CNY非负金额，最多2位小数或null', widthLimitCm: '正数或null。候选名称/详情/选择复用item.candidates' } },
  budget: { label: '预算拆分', fields: { currency: '只支持 CNY', total: '非负金额，最多2位小数或null；未知不填0', lines: '[{id,label,amount:金额|null}]；null表示待报价，不计入已知合计', reserve: '非负金额；新增预留不得超过已知余额。可记录真实费用超预算' } },
  shopping: { label: '分组采购', fields: { entries: '[{id,name,category,quantity:正数|null,unit,atHome:boolean,bought:boolean}]；未知数量保留null，物品在家不能宣称新买' } },
  itinerary: { label: '路线站点', fields: { stops: '[{id,name,start,end:含时区ISO|null,optional:boolean}]；这是用户安排的时间', legs: '[{from:站点id,to:站点id,mode,minutes:整数0–10080|null}]；缺少直连段时投影用null，禁止将旧路线片段相加', omittedStopIds: '[可选站点id]；固定站点不能略过' } },
  waiting: { label: '等待回音', fields: { requests: '[{id,person,request,status:unknown|waiting|agreed|declined,due:含时区ISO|null,draft:文本<=2000字}]；仅记用户提供的回应，保存草稿不发送' } },
  delivery: { label: '履约进度', fields: { reference: '用户提供的订单/物流标识，不虚构', stages: '[{id,label}]；按顺序定义阶段', events: '[{stageId,at:含时区ISO,detail,evidence:用户提供的回执原文}]；时间和阶段不得倒退，录入不代表平台查询成功' } },
  deadline: { label: '期限与下一步', fields: { dueAt: '明确的截止时间；含时区ISO或null；生日日期不自动当截止', nextAt: '计划下一步；含时区ISO或null，不得晚于dueAt', nextLabel: '下一步任务文本<=500字' } },
  reminder: { label: '提醒计划', fields: { at: '事项时间；含时区ISO或null', minutesBefore: '整数0–10080或null', recordedAt: '系统维护，set-data不得传非null。仅保存计划，不代表提醒已投递' } },
  habit: { label: '每周习惯', fields: { targetPerWeek: '整数1–7或null', dates: '[YYYY-MM-DD]；唯一的已打卡日期，无假日期', timeZone: 'IANA时区；未提供保留已存时区，新记录使用可信实例默认，无实例上下文才使用服务器时区。today/weekStart/weekCount由真实now投影，不写入taskData' } },
  meal: { label: '一餐准备', fields: { baseServings: '基础食谱人数；整数1–100或null', servings: '计划人数；整数1–100或null', ingredients: '[{id,name,quantity:正数|null,unit}]；未知数量不会按0缩放', instructions: '[{id,label,done:boolean,durationMinutes:整数0–1440|null}]' } },
  collection: { label: '生活收藏', fields: { entries: '[{id,title,note,url:http(s)URL|null}]；只保留用户材料，不加入实验室照片' } },
  documents: { label: '材料文件夹', fields: { entries: '[{id,name,type,state:missing|provided,note,url:http(s)URL|null}]；provided只代表用户标记提供，不宣称读取/核验文件权限' } },
  approval: { label: '待确认计划', fields: { summary: '用户要确认的具体内容<=2000字', amount: '明确的非负CNY金额或null；无费用须明确0', currency: '只支持CNY', scheduledAt: '计划执行时间；含时区ISO或null', conditions: '[条件文本]；<=100条', confirmation: '系统维护的{itemVersion,at}或null；set-data不得伪造确认，任何其他事实变更使确认失效。确认只记计划，不执行实单' } },
  recovery: { label: '受阻后的下一步', fields: { blocker: '明确的阻塞文本', known: '[已知材料原话]', missing: '[待补事实]', options: '[{id,label}]；下一步可选方向', selectedOptionId: '方向id或null；仅记录选择' } },
  reflection: { label: '结束后评价', fields: { rating: '整数1–5或null', text: '用户评价<=10000字；已结束事项允许补记' } },
  memory: { label: '生活记忆', fields: { text: '想留下的原话<=10000字；无则投影使用item.note', occurredAt: '含时区ISO或null；无则投影使用item.date', caption: '用户题注<=2000字。没有照片不加入外部素材；已结束事项允许补记' } },
  handoff: { label: '分工交接', fields: { people: '[{id,name,role,tasks:[任务文本]}]；记录分工不发消息', condition: '共同交付条件', note: '用户备注' } },
};
export function widgetCapabilities() {
  return Object.fromEntries(WIDGET_KINDS.map(kind => [kind, { label: capabilities[kind].label, fields: clone(capabilities[kind].fields), actions: { 'set-data': ['data（本kind完整字段对象，保留其它namespace）'], ...clone(actionKeys[kind]) } }]));
}
