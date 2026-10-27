import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quantity = value => Math.round(value * 1000) / 1000;
const nameKey = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase();

export function planningInput(input) {
  if (!object(input) || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.itemId !== 'string' || !input.itemId || !Number.isSafeInteger(input.itemVersion) || input.itemVersion < 1 || !object(input.parameters)) fail('INVALID_REQUEST');
  const keys = Object.keys(input.parameters);
  if (!keys.length || keys.some(key => !['servings', 'budgetTotal'].includes(key))) fail('INVALID_REQUEST');
  const parameters = {};
  if (Object.hasOwn(input.parameters, 'servings')) {
    const value = input.parameters.servings;
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail('INVALID_REQUEST');
    parameters.servings = value;
  }
  if (Object.hasOwn(input.parameters, 'budgetTotal')) {
    const value = input.parameters.budgetTotal;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-5) fail('INVALID_REQUEST');
    parameters.budgetTotal = value;
  }
  return { revision: input.revision, itemId: input.itemId, itemVersion: input.itemVersion, parameters };
}

export function planningRequest(input) {
  const request = planningInput(input);
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{8,128}$/.test(input.requestId) || typeof input.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewHash)) fail('INVALID_REQUEST');
  return { ...request, requestId: input.requestId, previewHash: input.previewHash, requestHash: hash({ ...request, previewHash: input.previewHash }) };
}

// Preview and adoption share the same deterministic calculation. No provider,
// catalogue price, or external action is involved in changing a local plan.
export function planAdjustment(state, input) {
  const request = planningInput(input), { itemId, parameters } = request;
  if (state.revision !== request.revision) fail('VERSION_CONFLICT');
  const item = state.items.find(value => value.id === itemId);
  if (!item) fail('ITEM_NOT_FOUND');
  if (item.version !== request.itemVersion) fail('VERSION_CONFLICT');
  if (!['planned', 'active'].includes(item.status)) fail('INVALID_STATE');
  const taskData = structuredClone(item.taskData || {}), changes = [], warnings = [];
  let canApply = true;
  const warn = (code, message) => warnings.push({ code, message });
  const change = (kind, label, before, after, unit = '', status = before === after ? 'preserved' : 'changed', entryId) => changes.push({ kind, label, before, after, unit, status, ...(entryId ? { entryId } : {}) });
  if (parameters.servings !== undefined) {
    const meal = taskData.meal;
    if (!meal?.baseServings || !meal?.servings) fail('MISSING_BASE_SERVINGS');
    change('meal', '用餐人数', meal.servings, parameters.servings, '人');
    const originalServings = meal.servings;
    for (const ingredient of meal.ingredients) {
      if (ingredient.quantity === null) {
        change('ingredient', ingredient.name, null, null, ingredient.unit, 'needs_review', ingredient.id);
        warn('UNKNOWN_QUANTITY', `${ingredient.name}的用量未记录，请自行确认。`);
        continue;
      }
      const before = quantity(ingredient.quantity * originalServings / meal.baseServings);
      const after = quantity(ingredient.quantity * parameters.servings / meal.baseServings);
      if (after <= 0 || after > 1e9) {
        canApply = false;
        change('ingredient', ingredient.name, before, null, ingredient.unit, 'needs_review', ingredient.id);
        warn('QUANTITY_PRECISION', `${ingredient.name}调整后的数量超出当前单位可安全记录的范围，请先校对单位和基础用量。`);
        continue;
      }
      change('ingredient', ingredient.name, before, after, ingredient.unit, undefined, ingredient.id);
    }
    for (const entry of taskData.shopping?.entries || []) {
      const matches = meal.ingredients.filter(value => nameKey(value.name) === nameKey(entry.name) && value.unit === entry.unit);
      const sameEntries = taskData.shopping.entries.filter(value => nameKey(value.name) === nameKey(entry.name) && value.unit === entry.unit);
      if (entry.bought || entry.atHome) {
        change('shopping', entry.name, entry.quantity, entry.quantity, entry.unit, 'preserved', entry.id);
        continue;
      }
      const ingredient = matches[0];
      const before = ingredient?.quantity == null ? null : quantity(ingredient.quantity * originalServings / meal.baseServings);
      if (matches.length !== 1 || sameEntries.length !== 1 || before === null || entry.quantity !== before) {
        change('shopping', entry.name, entry.quantity, entry.quantity, entry.unit, 'needs_review', entry.id);
        warn('SHOPPING_REVIEW', `${entry.name}的采购量无法与食谱唯一对应，保留原值。`);
        continue;
      }
      const after = quantity(ingredient.quantity * parameters.servings / meal.baseServings);
      if (after <= 0 || after > 1e9) {
        change('shopping', entry.name, entry.quantity, entry.quantity, entry.unit, 'needs_review', entry.id);
        continue;
      }
      change('shopping', entry.name, entry.quantity, after, entry.unit, undefined, entry.id);
      entry.quantity = after;
    }
    meal.servings = parameters.servings;
    if (originalServings !== parameters.servings) warn('STOCK_AND_PRICE_UNCHANGED', '试算基于已保存的食谱和采购记录，不会重新核实当前库存或烹饪耗时。已买和已有的数量、完成进度及预算明细均保留；库存缺口只能按原记录说明，价格不按人数推算。');
  }
  if (parameters.budgetTotal !== undefined) {
    const budget = taskData.budget;
    if (!budget) fail('MISSING_BUDGET');
    change('budget', '总预算', budget.total, parameters.budgetTotal, budget.currency);
    const known = budget.lines.reduce((sum, line) => sum + (line.amount ?? 0), 0) + budget.reserve;
    if (Math.round(known * 100) > Math.round(parameters.budgetTotal * 100)) {
      canApply = false;
      warn('BUDGET_EXCEEDED', '新预算低于已记录的明细与预留金额，请先调整明细。');
    }
    if (budget.lines.some(line => line.amount === null)) warn('UNKNOWN_PRICE', '仍有未记录的金额，不能据此确认最终开销。');
    budget.total = parameters.budgetTotal;
  }
  const preview = { itemId, baseRevision: state.revision, baseVersion: item.version, parameters, canApply, changes, warnings };
  return { preview: { ...preview, previewHash: hash(preview) }, taskData };
}
