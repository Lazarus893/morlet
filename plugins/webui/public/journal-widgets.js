(() => {
  'use strict';
  const names = { agenda: '今日议程', 'time-grid': '可选时间', prep: '分段准备', decision: '条件比较', budget: '预算拆分', shopping: '分组采购', itinerary: '路线站点', waiting: '等待回音', delivery: '履约进度', deadline: '期限与下一步', reminder: '事件提醒', habit: '习惯周历', meal: '做饭步骤', collection: '灵感收藏', documents: '材料夹', approval: '行动确认', recovery: '受阻补救', reflection: '收尾感受', memory: '生活回忆', handoff: '协作交接' };
  const kinds = Object.keys(names);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const arr = value => Array.isArray(value) ? value : [];
  const number = value => value === '' || value === null || value === undefined ? null : Number(value);
  const money = value => Number.isFinite(value) ? `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : '金额待补';
  const link = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  const asInput = value => { const d = new Date(value); return value && Number.isFinite(d.getTime()) ? new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''; };
  const date = (value, opts = {}) => { const d = new Date(value); return value && Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...opts }).format(d) : '时间待补'; };
  const time = value => date(value, { month: undefined, day: undefined, weekday: undefined });
  const iso = value => { if (!value) return null; const d = new Date(value); if (!Number.isFinite(d.getTime())) throw new Error('请填写完整有效的日期和时间。'); return d.toISOString(); };
  const id = () => `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  function allowed(projection, action) {
    return arr(projection.actions).some(a => typeof a === 'string' ? a === action : a.action === action && a.enabled !== false);
  }
  function button(p, action, label, payload = {}, options = {}) {
    if (p.dashboard && ['schedule', 'reserve', 'quantity', 'save-draft', 'record-event', 'record-reminder', 'set-servings', 'add-entry', 'save-reflection', 'save-memory', 'set-owner'].includes(action)) return '';
    const suffix = payload.entryId || payload.stepId || payload.slotId || payload.candidateId || payload.personId || payload.optionId || payload.requestId || payload.date || options.key || '';
    const local = action.startsWith('ui-');
    const disabled = options.disabled || !local && !allowed(p, action);
    const tag = !options.choice && customElements.get('wa-button') ? 'wa-button' : 'button';
    const content = options.lines ? `<span class="jw-button-date">${esc(options.lines[0])}</span><span class="jw-button-state">${esc(options.lines[1])}</span>` : options.choice ? `<span class="journal-choice-content"><span class="journal-choice-indicator" aria-hidden="true"></span><span class="journal-choice-copy"><span>${esc(label)}</span>${options.choiceMeta ? `<span class="journal-choice-meta">${esc(options.choiceMeta)}</span>` : ''}</span></span>` : esc(label);
    return `<${tag} type="button" id="jw-${esc(p.instanceId || p.itemId)}-${esc(p.kind)}-${esc(action)}-${esc(suffix)}" data-j-action="widget" data-w-action="${esc(action)}" data-w-kind="${esc(p.kind)}" data-item="${esc(p.itemId)}" data-w-payload="${esc(JSON.stringify(payload))}" ${options.primary ? (tag === 'wa-button' ? 'variant="brand" appearance="accent"' : 'class="primary"') : (tag === 'wa-button' ? 'appearance="outlined"' : 'class="outline"')} ${disabled ? 'disabled' : ''} ${options.pressed !== undefined ? `aria-pressed="${options.pressed}"` : ''}>${content}</${tag}>`;
  }
  const input = (p, key, label, value, type = 'text', extra = '') => p.dashboard ? '' : `<label class="jw-input" for="jw-${esc(p.instanceId || p.itemId)}-${esc(p.kind)}-${esc(key)}"><span>${esc(label)}</span><input id="jw-${esc(p.instanceId || p.itemId)}-${esc(p.kind)}-${esc(key)}" data-w-field="${esc(key)}" type="${type}" value="${esc(value ?? '')}" ${extra}></label>`;
  const textarea = (p, key, label, value, limit = 2000) => p.dashboard ? value ? `<p class="jw-saved-text">${esc(value)}</p>` : '' : `<label class="jw-input" for="jw-${esc(p.instanceId || p.itemId)}-${esc(p.kind)}-${esc(key)}"><span>${esc(label)}</span><textarea id="jw-${esc(p.instanceId || p.itemId)}-${esc(p.kind)}-${esc(key)}" data-w-field="${esc(key)}" maxlength="${limit}" rows="3">${esc(value)}</textarea></label>`;
  const title = (text, meta = '') => `${meta ? `<p class="jw-label">${esc(meta)}</p>` : ''}<h2>${esc(text)}</h2>`;
  const empty = (p, text) => `<div class="jw-empty"><p>${esc(text)}</p>${arr(p.missing).length ? `<p class="jw-muted">${arr(p.missing).map(esc).join(' · ')}</p>` : ''}</div>`;
  const sourceLink = (url, text = '查看材料来源 ↗') => link(url) ? `<a class="jw-source-link" href="${esc(link(url))}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : '';
  const list = (values, cls = '') => `<ul class="${cls}">${arr(values).map(v => `<li>${esc(v)}</li>`).join('')}</ul>`;
  function stepContent(label) {
    if (label.length <= 140) return { title: label, detail: '' };
    const sentence = label.match(/^.{1,120}?[。？！?]/u)?.[0];
    const title = sentence || Array.from(label).slice(0, 100).join('') + '…';
    return { title, detail: `<details class="jw-step-detail"><summary>展开全文</summary><p>${esc(label)}</p></details>` };
  }
  const renderers = {
    agenda(p, item) {
      const d = p.data, at = d.date || item.date, scheduled = !!asInput(at);
      const detail = [Number.isFinite(d.durationMinutes) ? `${d.durationMinutes} 分钟` : '时长待补', d.flexible ? '时间可调整' : scheduled ? '按已记录时间' : ''].filter(Boolean).join(' · ');
      return `${title(item.title, scheduled ? date(at) : '')}<div class="jw-agenda-track"><div class="jw-agenda-time" data-pending="${!scheduled}">${scheduled ? esc(time(at)) : '时间未定'}</div><div><strong>${esc(d.place || '地点待补')}</strong><p>${esc(detail)}</p></div></div><div class="jw-action-form">${input(p, 'date', '安排时间', asInput(at), 'datetime-local')}${button(p, 'schedule', '保存时间', {}, { primary: true })}</div>`;
    },
    'time-grid'(p, item, ui) {
      const d = p.data, slots = arr(d.slots), selected = ui.slotId || d.selectedSlotId;
      return `${title(item.title, Number.isFinite(d.durationMinutes) ? `${d.durationMinutes} 分钟${Number.isFinite(d.bufferMinutes) ? ` · 另留 ${d.bufferMinutes} 分钟` : ''}` : '服务时长待补')}${slots.length ? `<div class="jw-time-grid" role="group" aria-label="已选的时间">${slots.map(s => `<div class="jw-time-cell" data-selected="${s.id === selected}">${button(p, 'ui-slot', date(s.start), { slotId: s.id }, { pressed: s.id === selected, disabled: s.selectable === false || s.status !== 'available' })}<span>${s.selectable ? '记录中可选' : s.status === 'busy' ? '有冲突' : '仍需核对'}</span><p class="jw-muted">${esc(s.blockedReason || s.reason)}</p></div>`).join('')}</div><div class="jw-actions">${button(p, 'choose-slot', '保存时间偏好', { slotId: selected }, { primary: true, disabled: !selected || slots.find(s => s.id === selected)?.selectable === false || slots.find(s => s.id === selected)?.status !== 'available' })}</div><p class="jw-muted">尚未预约。</p>` : empty(p, '还没有取得可比较的时段。')}`;
    },
    prep(p, item, ui) {
      const d = p.data, steps = arr(d.steps || item.steps), phases = arr(d.phases), phase = phases.find(v => v.id === (ui.phaseId || d.activePhaseId)) || phases[0];
      const shown = phase ? steps.filter(s => arr(phase.stepIds).includes(s.id)) : steps, next = shown.find(s => !s.done);
      return `${title(item.title, `${steps.filter(s => s.done).length} / ${steps.length} 项已准备`)}${phases.length > 1 && item.source?.kind !== 'guide' ? `<nav class="jw-phase-nav" aria-label="准备阶段">${phases.map((v, n) => button(p, 'ui-phase', `${n + 1} · ${v.label}`, { phaseId: v.id }, { pressed: v.id === phase?.id })).join('')}</nav>` : ''}${shown.length ? `<ul class="jw-prep-list">${shown.map(s => { const text = stepContent(s.label); return `<li data-j-row="${esc(s.id)}"><label><input type="checkbox" data-w-checkbox="step" data-w-kind="prep" data-item="${esc(item.id)}" data-w-payload="${esc(JSON.stringify({ stepId: s.id }))}" ${s.done ? 'checked' : ''} ${!allowed(p, 'step') ? 'disabled' : ''}><span>${esc(text.title)}</span></label>${text.detail}</li>`; }).join('')}</ul>` : empty(p, '准备材料还没有分段。')}`;
    },
    decision(p, item) {
      const d = p.data, candidates = arr(d.candidates || item.candidates), criteria = arr(d.criteria), options = arr(d.options);
      if (item.source?.kind === 'guide') return `<div class="journal-guide-choices" role="group" aria-label="选择要跟进的材料">${candidates.filter(c => !item.guide?.resultItemId || c.selected).map(c => { const source = item.guide?.sources?.find(row => row.id === c.id); return `<div data-selected="${!!c.selected}">${button(p, 'choose', c.name, { candidateId: c.id }, { choice: true, choiceMeta: `${source?.source === 'github' ? 'GitHub' : '邮件'}${source ? ` · ${date(source.observedAt, { weekday: undefined, hour: undefined, minute: undefined })}` : ''}`, pressed: !!c.selected, disabled: !!item.guide?.resultItemId || c.selected || c.selectable === false })}</div>`; }).join('')}</div>${candidates.length ? '' : '<p class="journal-guide-empty">暂无近期材料。</p>'}`;
      const fields = criteria.length ? criteria : [{ id: 'detail', label: '已知材料' }];
      return `${title(item.title, [Number.isFinite(d.budget) ? `候选预算上限 ${money(d.budget)}` : '预算待补', Number.isFinite(d.widthLimitCm) ? `尺寸 ≤ ${d.widthLimitCm} cm` : ''].filter(Boolean).join(' · '))}${candidates.length ? `${candidates.every(c => c.selectable === false) ? `<div class="jw-missing-next"><span>候选条件还不够，先补上已核实的材料。</span><button class="outline" data-j-action="edit" data-edit-field="candidates" data-item="${esc(item.id)}">补充候选信息</button></div>` : ''}<p class="jw-scroll-hint">左右滑动，对照 ${candidates.length} 个候选</p><div class="jw-comparison-scroll" tabindex="0" role="region" aria-label="候选同字段比较，可横向滚动"><table class="jw-comparison"><thead><tr><th scope="col">共同条件</th>${candidates.map(c => `<th scope="col" data-selected="${!!c.selected}">${esc(c.name)}${c.selected ? '<small>已选</small>' : ''}</th>`).join('')}</tr></thead><tbody><tr><th scope="row">金额</th>${candidates.map(c => `<td>${money(c.amount ?? options.find(o => o.candidateId === c.id)?.amount ?? null)}</td>`).join('')}</tr>${Number.isFinite(d.widthLimitCm) || options.some(o => Number.isFinite(o.widthCm)) ? `<tr><th scope="row">占用宽度</th>${candidates.map(c => `<td>${Number.isFinite(c.widthCm) ? `${c.widthCm} cm` : '待核实'}</td>`).join('')}</tr>` : ''}${fields.map(f => `<tr><th scope="row">${esc(f.label)}</th>${candidates.map(c => `<td>${esc(f.id === 'detail' ? c.detail || '材料待补' : c.fields?.[f.id] ?? options.find(o => o.candidateId === c.id)?.fields?.[f.id] ?? '待核实')}</td>`).join('')}</tr>`).join('')}<tr><th scope="row">记录决定</th>${candidates.map(c => `<td>${sourceLink(c.url)}${button(p, 'choose', c.selected ? '已选' : c.selectable === false ? '待核对' : `选择：${c.name}`, { candidateId: c.id }, { disabled: c.selected || c.selectable === false })}</td>`).join('')}</tr></tbody></table></div><p class="jw-muted">尚未预订或购买。</p>` : `${empty(p, '还没有取得候选，先保留需求。')}<button class="outline" data-j-action="edit" data-edit-field="candidates" data-item="${esc(item.id)}">补充候选信息</button>`}`;
    },
    budget(p, item) {
      const d = p.data, lines = arr(d.lines), known = lines.filter(l => Number.isFinite(l.amount)), allocated = known.reduce((sum, l) => sum + l.amount, 0) + (Number.isFinite(d.reserve) ? d.reserve : 0), remainder = Number.isFinite(d.total) ? d.total - allocated : null;
      return `${title(item.title)}<div class="jw-budget-summary"><div><span>总预算</span><strong>${money(d.total)}</strong></div><div><span>${remainder !== null && remainder < 0 ? '按已知费用超出' : lines.some(l => !Number.isFinite(l.amount)) ? '按已知费用计算剩余' : '尚未分配'}</span><strong>${money(remainder === null ? null : Math.abs(remainder))}</strong></div></div>${Number.isFinite(d.total) && d.total > 0 ? `<wa-progress-bar value="${Math.min(100, allocated / d.total * 100)}" label="已分配 ${money(allocated)}，总预算 ${money(d.total)}"></wa-progress-bar>` : ''}<dl class="jw-budget-lines">${lines.map(l => `<div><dt>${esc(l.label)}</dt><dd>${money(l.amount)}</dd></div>`).join('')}<div><dt>额外预留</dt><dd>${money(d.reserve)}</dd></div></dl><div class="jw-action-form">${input(p, 'amount', '预留金额（元）', d.reserve, 'number', 'min="0" step="0.01"')}${button(p, 'reserve', '保存预留', {}, { primary: true })}</div>`;
    },
    shopping(p, item) {
      const entries = arr(p.data.entries), categories = [...new Set(entries.map(e => e.category || '待采购'))];
      return `${title(item.title, `${entries.filter(e => !e.bought && !e.atHome).length} 种待买`)}${entries.length ? categories.map(c => `<section class="jw-shopping-group"><h3>${esc(c)}</h3><ul>${entries.filter(e => (e.category || '待采购') === c).map(e => `<li><div><label><input type="checkbox" data-w-checkbox="mark-bought" data-w-kind="shopping" data-item="${esc(item.id)}" data-w-payload="${esc(JSON.stringify({ entryId: e.id }))}" ${e.bought || e.atHome ? 'checked' : ''} ${e.atHome || !allowed(p, 'mark-bought') ? 'disabled' : ''}>${esc(e.name)}</label><small>${e.atHome ? '家里已有' : e.bought ? '用户记下已买' : '待买'}</small></div><div class="jw-quantity">${e.atHome || p.dashboard ? `<span class="jw-quantity-value">${Number.isFinite(e.quantity) ? esc(e.quantity) : '数量待补'} ${esc(e.unit)}</span>` : `<details class="jw-quantity-editor" data-w-detail="quantity-${esc(e.id)}"><summary><span>${Number.isFinite(e.quantity) ? esc(e.quantity) : '数量待补'} ${esc(e.unit)}</span><small>调整</small></summary><div>${input(p, `qty-${e.id}`, `数量（${e.unit || '单位待补'}）`, e.quantity, 'number', 'min="0" step="any"')}${button(p, 'quantity', '保存数量', { entryId: e.id })}</div></details>`}</div></li>`).join('')}</ul></section>`).join('') : empty(p, '采购材料还没补齐。')}`;
    },
    itinerary(p, item, ui) {
      const d = p.data, omitted = ui.omittedStopIds || arr(d.omittedStopIds), stops = arr(d.stops).filter(s => !omitted.includes(s.id));
      return `${title(item.title)}${stops.length ? `<ol class="jw-route">${stops.map((s, n) => { const prev = stops[n - 1], leg = prev && arr(d.legs).find(l => l.from === prev.id && l.to === s.id); return `<li><span class="jw-route-number">${n + 1}</span><div>${prev ? `<p class="jw-route-leg">${leg ? `${esc(leg.mode || '方式待补')} · ${Number.isFinite(leg.minutes) ? `${leg.minutes} 分钟（记录值）` : '时长待核实'}` : '直达路线与时长待核实'}</p>` : ''}<h3>${esc(s.name)}</h3><p>${esc(date(s.start))}${s.end ? ` — ${esc(time(s.end))}` : ''}</p></div></li>`; }).join('')}</ol>${arr(d.stops).filter(s => s.optional).map(s => button(p, 'ui-route', omitted.includes(s.id) ? `恢复 ${s.name}` : `略过 ${s.name}`, { stopId: s.id })).join('')}<div class="jw-actions">${button(p, 'set-route', '保存这条路线', { omittedStopIds: omitted }, { primary: true })}</div>` : empty(p, '路线站点还没有记录。')}`;
    },
    waiting(p, item, ui) {
      const requests = arr(p.data.requests), selected = requests.find(r => r.id === ui.requestId) || requests.find(r => r.status === 'waiting') || requests[0];
      return `${title(item.title)}${requests.length ? `<ul class="jw-waiting-people">${requests.map(r => `<li><span class="jw-initial" aria-hidden="true">${esc(r.person?.slice(0, 1) || '?')}</span><div><strong>${esc(r.person || '联系人待补')}</strong><p>${esc(r.request)}</p><small>${r.due ? `希望 ${esc(date(r.due))} 前回复` : '回复期限待补'}</small></div><span>${({ agreed: '已同意', declined: '无法配合', waiting: '未回复', unknown: '状态未知' })[r.status] || '状态未知'}</span>${!p.dashboard || r.draft ? button(p, 'ui-request', '草稿', { requestId: r.id }, { pressed: selected?.id === r.id }) : ''}</li>`).join('')}</ul>${selected && (!p.dashboard || selected.draft) ? `<div class="jw-draft"><p class="jw-label">给 ${esc(selected.person || '这位联系人')} 的草稿 · 未发送</p>${textarea(p, 'text', '核对或修改措辞', selected.draft || '')}${button(p, 'save-draft', '保存草稿', { requestId: selected.id }, { primary: true })}</div>` : ''}` : empty(p, '还没有记录等待谁的回音。')}`;
    },
    delivery(p, item) {
      const d = p.data, events = arr(d.events), latest = events.at(-1), stages = arr(d.stages), index = latest ? stages.findIndex(s => s.id === latest.stageId) : -1;
      return `${title(item.title, d.reference ? `记录编号：${d.reference}` : '编号待补')}<ol class="jw-delivery-stages">${stages.map((s, n) => `<li data-state="${n < index ? 'past' : n === index ? 'current' : 'unknown'}"><span>${n + 1}</span><strong>${esc(s.label)}</strong><small>${n <= index ? '有记录' : '未取得回执'}</small></li>`).join('')}</ol>${latest ? `<div class="jw-delivery-latest"><p class="jw-label">最近取得的材料</p><strong>${esc(latest.detail)}</strong><p>${esc(date(latest.at))}</p><p>${esc(latest.evidence || '证据来源待补')}</p></div>` : empty(p, '还没有取得履约回执。')}${p.dashboard ? '' : `<details class="jw-detail"><summary>补记取得的回执</summary><div class="jw-action-form"><label class="jw-input">阶段<select data-w-field="stageId"><option value="">选择实际阶段</option>${stages.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')}</select></label>${input(p, 'at', '回执时间', '', 'datetime-local')}${textarea(p, 'detail', '回执内容', '')}${input(p, 'evidence', '证据来源', '')}${button(p, 'record-event', '保存回执', {}, { primary: true })}</div></details>`}`;
    },
    deadline(p, item) {
      const d = p.data, due = d.dueAt || item.date;
      return `<div class="jw-deadline-heading"><div class="jw-date-stamp">${esc(date(due, { hour: undefined, minute: undefined, weekday: undefined }))}</div><div>${title(item.title, `截止 ${date(due)}`)}<p>${esc(d.nextLabel || '下一步待补')}</p></div></div><div class="jw-action-form">${input(p, 'at', '计划提前完成的时间', asInput(d.nextAt), 'datetime-local')}${input(p, 'label', '提前做的一步', d.nextLabel || '')}${button(p, 'schedule', '保存安排', {}, { primary: true })}</div>`;
    },
    reminder(p, item) {
      const d = p.data, at = d.at || item.date;
      return `<div class="jw-reminder-strip"><div class="jw-clock"><strong>${esc(time(at))}</strong><span>${esc(date(at, { hour: undefined, minute: undefined }))}</span></div><div>${title(item.title)}<p>${d.recordedAt ? '提醒计划已保存' : '提醒计划尚未保存'}</p></div></div><div class="jw-action-form">${input(p, 'at', '提醒时刻', asInput(at), 'datetime-local')}${input(p, 'minutesBefore', '提前多少分钟', d.minutesBefore, 'number', 'min="0" step="1"')}${button(p, 'record-reminder', '保存提醒计划', {}, { primary: true })}</div><p class="jw-muted">通知状态见跟进记录。</p>`;
    },
    habit(p, item) {
      const d = p.data, start = d.weekStart, dates = arr(d.dates), today = d.today;
      const days = start ? Array.from({ length: 7 }, (_, n) => { const day = new Date(`${start}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + n); return day.toISOString().slice(0, 10); }) : [];
      return `${title(item.title, Number.isFinite(d.targetPerWeek) ? `一周 ${d.targetPerWeek} 天 · ${d.weekCount ?? 0} 天已记下` : '每周目标待补')}${days.length ? `<div class="jw-week" role="group" aria-label="本周习惯记录">${days.map(day => `<div data-today="${day === today}" data-done="${dates.includes(day)}">${button(p, 'check-in', `${day.slice(5).replace('-', '/')} ${dates.includes(day) ? '已记' : day === today ? '今天' : day > today ? '待到来' : '未记'}`, { date: day, done: !dates.includes(day) }, { disabled: !today || day > today, pressed: dates.includes(day), lines: [day.slice(5).replace('-', '/'), dates.includes(day) ? '已记' : day === today ? '今天' : day > today ? '待到来' : '未记'] })}</div>`).join('')}</div>` : empty(p, '周历时间还没有取得。')}`;
    },
    meal(p, item, ui) {
      const d = p.data, instructions = arr(d.instructions), step = instructions.find(s => s.id === ui.stepId) || instructions.find(s => !s.done) || instructions[0];
      const hasBase = Number.isFinite(d.baseServings) && d.baseServings > 0, canScale = hasBase && Number.isFinite(d.servings) && d.servings > 0;
      return `${title(item.title)}<div class="jw-action-form jw-servings">${hasBase ? `${input(p, 'servings', '几人份', d.servings, 'number', 'min="1" max="100" step="1"')}${button(p, 'set-servings', '调整份量')}` : `<p class="jw-muted">基础份量人数待补。</p><button class="text" data-j-action="edit" data-edit-field="baseServings" data-item="${esc(item.id)}">核对原份量</button>`}</div><div class="jw-cookbook"><section><h3>材料份量</h3>${!canScale && arr(d.ingredients).some(i => Number.isFinite(i.quantity)) ? '<p class="jw-muted">已记录基础用量，未换算</p>' : ''}${arr(d.ingredients).length ? `<dl class="jw-ingredients">${d.ingredients.map(i => `<div><dt>${esc(i.name)}</dt><dd>${Number.isFinite(i.quantity) ? (canScale ? Math.round(i.quantity * d.servings / d.baseServings * 100) / 100 : i.quantity) : '数量待补'} ${esc(i.unit)}</dd></div>`).join('')}</dl>` : empty(p, '材料还没有补充。')}</section><section class="jw-cooking-page">${step ? `<p class="jw-label">第 ${instructions.indexOf(step) + 1} / ${instructions.length} 步${Number.isFinite(step.durationMinutes) ? ` · 约 ${step.durationMinutes} 分钟` : ''}</p><h3>${esc(step.label)}</h3><div class="jw-actions">${button(p, 'meal-step', step.done ? '撤回完成' : '完成这步', { stepId: step.id, done: !step.done }, { primary: !step.done })}</div><nav class="jw-step-nav" aria-label="回看做饭步骤">${instructions.map((s, n) => button(p, 'ui-meal', `${n + 1}${s.done ? ' · 已记' : ''}`, { stepId: s.id }, { pressed: s.id === step.id })).join('')}</nav>` : empty(p, '做法步骤还没有记录。')}</section></div>`;
    },
    collection(p, item, ui) {
      const entries = arr(p.data.entries);
      if (item.source?.kind === 'automatic') {
        return `${title(item.title, `${entries.length} 条来源材料`)}<div class="jw-auto-reading" data-auto-reading></div>`;
      }
      return `${title(item.title, `${entries.length} 条保留的灵感`)}${entries.length ? `<div class="jw-pinboard">${entries.map((e, n) => `<article class="jw-clip jw-clip-${n % 3}"><h3>${esc(e.title)}</h3><p>${esc(e.note || '还没有补注。')}</p>${sourceLink(e.url)}</article>`).join('')}</div>` : empty(p, '还没有留下灵感材料。')}${p.dashboard ? '' : `<details class="jw-detail"><summary>留下一条灵感</summary><div class="jw-action-form">${input(p, 'title', '灵感标题', '')}${textarea(p, 'note', '这条想法', '')}${input(p, 'url', '已有材料链接（可留空）', '', 'url')}${button(p, 'add-entry', '保存这条灵感', {}, { primary: true })}</div></details>`}`;
    },
    documents(p, item, ui) {
      const entries = arr(p.data.entries), current = entries.find(e => e.id === ui.entryId) || entries[0];
      return `${title(item.title)}${entries.length ? `<div class="jw-folder"><nav aria-label="材料目录">${entries.map(e => button(p, 'ui-document', `${e.name} · ${e.state === 'provided' ? '用户记下已提供' : '尚缺'}`, { entryId: e.id }, { pressed: current?.id === e.id })).join('')}</nav><section class="jw-document-detail">${current ? `<p class="jw-label">${esc(current.type || '类型待补')}</p><h3>${esc(current.name)}</h3><p>${esc(current.note || '材料说明待补。')}</p>${sourceLink(current.url)}<div class="jw-actions">${button(p, 'mark-document', current.state === 'provided' ? '撤回' : '标记已提供', { entryId: current.id, state: current.state === 'provided' ? 'missing' : 'provided' }, { primary: current.state !== 'provided' })}</div>` : ''}</section></div>` : empty(p, '先记下这件事需要的材料。')}`;
    },
    approval(p, item) {
      const d = p.data;
      return `<div class="jw-approval-sheet">${title(item.title, d.confirmed ? '本次确认已记录' : '这一次行动，先核对内容')}<p class="jw-approval-summary">${esc(d.summary || '具体行动内容待补')}</p><dl class="jw-approval-facts"><div><dt>涉及金额</dt><dd>${money(d.amount)}</dd></div><div><dt>安排时间</dt><dd>${esc(date(d.scheduledAt))}</dd></div></dl>${list(d.conditions, 'jw-approval-conditions')}<p class="jw-muted">仅记录确认，不执行。</p><div class="jw-actions">${d.confirmed ? button(p, 'revoke', '撤回确认') : button(p, 'confirm', '确认内容', {}, { primary: true, disabled: !d.summary })}</div></div>`;
    },
    recovery(p, item, ui) {
      const d = p.data, selected = ui.optionId || d.selectedOptionId, options = arr(d.options);
      return `${title(item.title)}<div class="jw-blocker"><h3>${esc(d.blocker || '受阻原因待补')}</h3><p>先保留材料，后续执行仍需核对。</p></div><div class="jw-recovery-evidence"><section><h3>已经知道</h3>${list(d.known)}</section><section><h3>仍然缺少</h3>${list(d.missing)}</section></div>${options.length ? `<div class="jw-recovery-branches">${options.map(o => button(p, 'ui-path', o.label, { optionId: o.id }, { pressed: o.id === selected })).join('')}</div><div class="jw-actions">${button(p, 'choose-path', '记下这个补救方向', { optionId: selected }, { primary: true, disabled: !selected })}</div>` : empty(p, '补救方向还没明确，可先校对缺口。')}`;
    },
    reflection(p, item) {
      const d = p.data;
      if (p.dashboard) return `${title(item.title)}${d.rating !== null && d.rating !== undefined ? `<p class="jw-saved-rating">${esc(d.rating)} / 5</p>` : ''}<p class="jw-saved-text">${esc(d.text || item.note || '尚无回顾')}</p>`;
      return `${title(item.title, '感受')}<div class="jw-rating"><label>这次感受（可不评分）<select data-w-field="rating"><option value="">不评分</option>${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${d.rating === n ? 'selected' : ''}>${n} / 5</option>`).join('')}</select></label></div>${textarea(p, 'text', '想留的话', d.text || item.note || '', 10000)}<div class="jw-actions">${button(p, 'save-reflection', '保存', {}, { primary: true })}</div>`;
    },
    memory(p, item) {
      const d = p.data, at = d.occurredAt || item.date;
      return `<div class="jw-memory-page"><aside class="jw-memory-date">${esc(date(at, { hour: undefined, minute: undefined }))}</aside><article>${title(item.title)}${d.caption ? `<blockquote>${esc(d.caption)}</blockquote>` : ''}<div class="jw-memory-story">${esc(d.text || item.note || '这页还没有留下故事。')}</div>${p.dashboard ? '' : `<details class="jw-detail"><summary>补一句记忆</summary>${textarea(p, 'text', '这段故事', d.text || item.note || '', 10000)}${input(p, 'caption', '留一句原话（可留空）', d.caption || '')}${input(p, 'occurredAt', '实际发生的时间（可留空）', asInput(at), 'datetime-local')}<div class="jw-actions">${button(p, 'save-memory', '保存补记', {}, { primary: true })}</div></details>`}</article></div>`;
    },
    handoff(p, item) {
      const d = p.data, people = arr(d.people);
      return `${title(item.title, '分工')}<div class="jw-responsibilities">${people.map(person => `<section><span class="jw-initial" aria-hidden="true">${esc(person.name?.slice(0, 1) || '?')}</span><h3>${esc(person.name || '负责人待补')}</h3><p class="jw-label">${esc(person.role || '职责待补')}</p>${list(person.tasks)}${input(p, `owner-${person.id}`, '负责人名称', person.name || '')}${button(p, 'set-owner', '保存负责人', { personId: person.id })}</section>`).join('')}</div>${people.length ? `<div class="jw-handoff-condition"><span class="jw-label">交付条件</span><p>${esc(d.condition || '交付条件待补')}</p></div>` : empty(p, '这件事的负责人还没有明确。')}<p class="jw-muted">${esc(d.note || '保存分工不等于对方已经接手。')}</p>`;
    },
  };
  function isEmptyReference(widget, item) {
    const p = widget.projection, kind = p?.kind || widget.kind, data = p?.data || item.taskData?.[kind] || {};
    return kind === 'collection' && !data.entries?.length || kind === 'handoff' && !data.people?.length && !data.condition && !data.note || kind === 'memory' && !data.text && !data.caption && !item.note || kind === 'reflection' && !data.text && data.rating == null;
  }
  function render(widget, item, ui = {}, options = {}) {
    const p = widget.projection;
    if (!p || !renderers[p.kind]) return `<div class="jw-summary">${title(item.title, date(item.date))}<p>${esc(item.note || '已记下，等待按材料整理。')}</p></div>`;
    let content = renderers[p.kind]({ ...p, instanceId: widget.id, data: p.data || {}, dashboard: options.dashboard === true }, item, ui);
    if (options.embedded) content = content.replace(`<h2>${esc(item.title)}</h2>`, `<h3 class="jw-section-title">${esc(item.source?.kind === 'automatic' ? '来源精选' : names[p.kind])}</h3>`);
    return `<div class="journal-task-widget jw-${esc(p.kind)}" data-task-kind="${esc(p.kind)}">${content}</div>`;
  }
  function action(widget, element, card, ui = {}) {
    const kind = element.dataset.wKind, name = element.dataset.wAction;
    const raw = element.dataset.wPayload ? JSON.parse(element.dataset.wPayload) : {};
    if (name.startsWith('ui-')) {
      const next = { ...ui };
      if (name === 'ui-slot') next.slotId = raw.slotId;
      if (name === 'ui-phase') next.phaseId = raw.phaseId;
      if (name === 'ui-meal') next.stepId = raw.stepId;
      if (name === 'ui-document') next.entryId = raw.entryId;
      if (name === 'ui-request') next.requestId = raw.requestId;
      if (name === 'ui-path') next.optionId = raw.optionId;
      if (name === 'ui-route') {
        const omitted = arr(ui.omittedStopIds || widget.projection?.data?.omittedStopIds);
        next.omittedStopIds = omitted.includes(raw.stopId) ? omitted.filter(v => v !== raw.stopId) : [...omitted, raw.stopId];
      }
      return { local: true, ui: next };
    }
    if (!allowed(widget.projection || {}, name)) throw new Error('当前阶段暂不支持这个动作，请先校对记录。');
    const fields = Object.fromEntries([...card.querySelectorAll('[data-w-field]')].map(n => [n.dataset.wField, n.type === 'checkbox' ? n.checked : n.value]));
    const values = { kind, action: name, ...raw };
    if (kind === 'agenda') values.date = iso(fields.date);
    if (kind === 'budget') values.amount = number(fields.amount);
    if (kind === 'shopping' && name === 'quantity') values.quantity = number(fields[`qty-${raw.entryId}`]);
    if (kind === 'waiting') values.text = fields.text || '';
    if (kind === 'delivery') Object.assign(values, { stageId: fields.stageId, at: iso(fields.at), detail: fields.detail || '', evidence: fields.evidence || '' });
    if (kind === 'deadline') Object.assign(values, { at: iso(fields.at), label: fields.label || '' });
    if (kind === 'reminder') Object.assign(values, { at: iso(fields.at), minutesBefore: number(fields.minutesBefore) });
    if (kind === 'meal' && name === 'set-servings') values.servings = number(fields.servings);
    if (kind === 'collection') values.entry = { id: id(), title: fields.title || '', note: fields.note || '', url: fields.url || null };
    if (kind === 'reflection') Object.assign(values, { rating: number(fields.rating), text: fields.text || '' });
    if (kind === 'memory') Object.assign(values, { text: fields.text || '', caption: fields.caption || '', occurredAt: iso(fields.occurredAt) });
    if (kind === 'handoff') values.name = fields[`owner-${raw.personId}`] || '';
    return { values };
  }
  const f = (key, label, type = 'text', options = {}) => ({ key, label, type, ...options });
  const r = (key, label, fields, options = {}) => ({ key, label, fields, ...options });
  const choices = (values, key = 'id', label = 'label') => arr(values).map(v => [v[key], v[label] || v.name || v.title || '尚未命名的材料']);
  const specs = {
    agenda: { fields: [f('durationMinutes', '预计时长（分钟）', 'number', { min: 1, max: 1440 }), f('place', '地点'), f('flexible', '时间可以调整', 'boolean')] },
    'time-grid': { fields: [f('durationMinutes', '所需时长（分钟）', 'number', { min: 1, max: 1440 }), f('bufferMinutes', '收尾 / 返程预留（分钟）', 'number', { min: 0, max: 1440, default: 0 })], rows: [r('slots', '候选时段', [f('start', '开始时间', 'datetime', { required: true }), f('status', '材料中的状态', 'select', { options: [['unknown', '待核实'], ['available', '材料明确可选'], ['busy', '有冲突']], default: 'unknown' }), f('reason', '依据或限制', 'textarea')]), r('constraints', '已有安排与不可用时间', [f('start', '开始', 'datetime', { required: true }), f('end', '结束', 'datetime', { required: true }), f('label', '是什么安排', 'text', { required: true })], { noId: true })] },
    prep: { fields: [], rows: [r('phases', '准备阶段', [f('label', '阶段名称', 'text', { required: true }), f('stepIds', '属于这一阶段的步骤', 'checklist', { options: ctx => choices(ctx.steps, 'id', 'label') })])], references: true },
    decision: { fields: [f('budget', '预算上限（元）', 'money'), f('widthLimitCm', '可用宽度（cm）', 'number', { min: 0.000001 })], rows: [r('criteria', '共同的比较维度', [f('label', '维度名称', 'text', { required: true })]), r('options', '每个候选的已知条件', (ctx, data) => [f('candidateId', '对应候选', 'select', { options: choices(ctx.candidates, 'id', 'name'), required: true }), f('amount', '已知金额（元）', 'money'), f('widthCm', '占用宽度（cm）', 'number', { min: 0.000001 }), ...arr(data.criteria).map(c => f(`fields:${c.id}`, c.label, 'nullable-text'))], { noId: true })], references: true },
    budget: { fields: [f('total', '总预算（元）', 'money'), f('reserve', '额外预留（元）', 'money', { default: 0 })], rows: [r('lines', '费用项目', [f('label', '费用是什么', 'text', { required: true }), f('amount', '金额（元，未知留空）', 'money')])] },
    shopping: { fields: [], rows: [r('entries', '采购物品', [f('name', '物品名称', 'text', { required: true }), f('category', '分组'), f('quantity', '数量（未知留空）', 'number', { min: 0.000001 }), f('unit', '单位'), f('atHome', '家里已经有', 'boolean'), f('bought', '我已记下买好', 'boolean')])] },
    itinerary: { fields: [], rows: [r('stops', '路线站点', [f('name', '地点名称', 'text', { required: true }), f('start', '计划到达时间', 'datetime'), f('end', '计划离开时间', 'datetime'), f('optional', '可以略过这一站', 'boolean')]), r('legs', '实际记录的路段', (ctx, data) => [f('from', '从哪站出发', 'select', { options: choices(data.stops), required: true }), f('to', '到哪站', 'select', { options: choices(data.stops), required: true }), f('mode', '出行方式'), f('minutes', '用时（分钟，未知留空）', 'number', { min: 0, max: 10080 })], { noId: true })], references: true },
    waiting: { fields: [], rows: [r('requests', '等待哪些回音', [f('person', '联系人', 'text', { required: true }), f('request', '等对方确认什么', 'textarea', { required: true }), f('status', '已取得的回应', 'select', { options: [['unknown', '状态未知'], ['waiting', '尚未回复'], ['agreed', '已有同意材料'], ['declined', '已明确无法配合']], default: 'unknown' }), f('due', '希望何时回复', 'datetime'), f('draft', '未发送的草稿', 'textarea')])] },
    delivery: { fields: [f('reference', '已有订单 / 物流标识')], rows: [r('stages', '履约阶段', [f('label', '阶段名称', 'text', { required: true })]), r('events', '已取得的回执', (ctx, data) => [f('stageId', '对应阶段', 'select', { options: choices(data.stages), required: true }), f('at', '回执时间', 'datetime', { required: true }), f('detail', '回执内容', 'textarea', { required: true }), f('evidence', '证据原文或来源', 'textarea', { required: true })], { noId: true })], references: true },
    deadline: { fields: [f('dueAt', '明确的截止时间', 'datetime'), f('nextAt', '提前做下一步的时间', 'datetime'), f('nextLabel', '提前做什么')] },
    reminder: { fields: [f('at', '事项时间', 'datetime'), f('minutesBefore', '提前多少分钟提醒', 'number', { min: 0, max: 10080 })] },
    habit: { fields: [f('targetPerWeek', '每周目标（天）', 'number', { min: 1, max: 7 }), f('timeZone', '打卡时区', 'text', { default: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }), f('dates', '已经打卡的日期 · 每行一个 YYYY-MM-DD', 'date-lines')] },
    meal: { fields: [f('baseServings', '材料原本是几人份', 'number', { min: 1, max: 100 }), f('servings', '这次准备几人份', 'number', { min: 1, max: 100 })], rows: [r('ingredients', '食材与基础份量', [f('name', '食材', 'text', { required: true }), f('quantity', '基础数量（未知留空）', 'number', { min: 0.000001 }), f('unit', '单位')]), r('instructions', '烹饪步骤', [f('label', '这一段怎么做', 'textarea', { required: true }), f('durationMinutes', '预计分钟（未知留空）', 'number', { min: 0, max: 1440 }), f('done', '我已记下这步完成', 'boolean')])] },
    collection: { fields: [], rows: [r('entries', '保留的灵感材料', [f('title', '标题', 'text', { required: true }), f('note', '我的想法', 'textarea'), f('url', '已有材料链接（可留空）', 'url')])] },
    documents: { fields: [], rows: [r('entries', '需要的材料', [f('name', '材料名称', 'text', { required: true }), f('type', '材料类型'), f('state', '提供情况', 'select', { options: [['missing', '还缺这份'], ['provided', '我记下已提供']], default: 'missing' }), f('note', '用途与版本说明', 'textarea'), f('url', '已有材料链接（可留空）', 'url')])] },
    approval: { fields: [f('summary', '这次具体要确认的内容', 'textarea'), f('amount', '明确金额（元，无费用填 0）', 'money'), f('scheduledAt', '计划执行时间', 'datetime'), f('conditions', '本次确认的范围与条件 · 每行一项', 'lines')] },
    recovery: { fields: [f('blocker', '现在卡在哪里', 'textarea'), f('known', '已知材料 · 每行一项', 'lines'), f('missing', '还缺的事实 · 每行一项', 'lines')], rows: [r('options', '可以走的补救方向', [f('label', '补救方式', 'text', { required: true })])] },
    reflection: { fields: [f('rating', '体验评分（可留空）', 'number', { min: 1, max: 5 }), f('text', '想留下的感受', 'textarea', { max: 10000 })] },
    memory: { fields: [f('text', '想留下的故事与原话', 'textarea', { max: 10000 }), f('occurredAt', '实际发生的时间（可留空）', 'datetime'), f('caption', '留一句题注', 'textarea')] },
    handoff: { fields: [f('condition', '共同交付条件', 'textarea'), f('note', '分工备注', 'textarea')], rows: [r('people', '参与者与分工', [f('name', '负责人', 'text', { required: true }), f('role', '负责哪一部分'), f('tasks', '要交付什么 · 每行一项', 'lines')])] },
  };
  const baseSpecs = {
    steps: r('steps', '准备步骤', [f('label', '这一步做什么', 'text', { required: true, max: 500 }), f('done', '我已记下完成', 'boolean')]),
    candidates: r('candidates', '候选材料', [f('name', '候选名称', 'text', { required: true, max: 200 }), f('detail', '已知条件', 'textarea'), f('url', '已有材料链接（可留空）', 'url')]),
  };
  function fieldMarkup(def, data, context, prefix) {
    const value = def.key.startsWith('fields:') ? data.fields?.[def.key.slice(7)] : data[def.key];
    const effective = value ?? def.default ?? (def.type === 'boolean' ? false : '');
    const attrs = `data-t-key="${esc(def.key)}" id="${esc(prefix)}-${esc(def.key)}" ${def.required ? 'required' : ''}`;
    if (def.type === 'boolean') return `<label class="jt-checkbox"><input ${attrs} type="checkbox" ${effective ? 'checked' : ''}>${esc(def.label)}</label>`;
    if (def.type === 'checklist') {
      const options = typeof def.options === 'function' ? def.options(context) : def.options;
      return `<fieldset class="jt-field jt-field-wide"><legend>${esc(def.label)}</legend><div class="jt-choice-list">${arr(options).map(([key, text]) => `<label class="jt-checkbox"><input type="checkbox" data-t-key="${esc(def.key)}" data-t-choice="true" value="${esc(key)}" ${arr(value).includes(key) ? 'checked' : ''}>${esc(text)}</label>`).join('') || '<p class="jw-muted">先补充准备步骤，再更新引用材料。</p>'}</div></fieldset>`;
    }
    const start = `<label class="jt-field ${['textarea', 'lines', 'date-lines'].includes(def.type) ? 'jt-field-wide' : ''}" for="${esc(prefix)}-${esc(def.key)}"><span>${esc(def.label)}</span>`;
    if (def.type === 'select') return `${start}<select ${attrs}><option value="">选择实际记录</option>${arr(def.options).map(([key, text]) => `<option value="${esc(key)}" ${String(key) === String(effective) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
    if (['textarea', 'lines', 'date-lines'].includes(def.type)) return `${start}<textarea ${attrs} rows="3" maxlength="${def.max || 10000}">${esc(['lines', 'date-lines'].includes(def.type) ? arr(value).join('\n') : effective)}</textarea></label>`;
    const type = def.type === 'datetime' ? 'datetime-local' : ['number', 'money'].includes(def.type) ? 'number' : def.type === 'url' ? 'url' : 'text';
    return `${start}<input ${attrs} type="${type}" value="${esc(def.type === 'datetime' ? asInput(value) : effective)}" ${type === 'number' ? `step="${def.type === 'money' ? '0.01' : def.min === 0.000001 ? 'any' : '1'}" min="${def.min ?? 0}" ${def.max !== undefined ? `max="${def.max}"` : ''}` : `maxlength="${def.max || 2000}"`}></label>`;
  }
  function fieldsFor(rowSpec, context, data) { return typeof rowSpec.fields === 'function' ? rowSpec.fields(context, data) : rowSpec.fields; }
  function rowMarkup(kind, key, value = {}, context = {}, namespace = {}) {
    const spec = kind === 'base' ? baseSpecs[key] : specs[kind]?.rows?.find(v => v.key === key);
    if (!spec) return '';
    const rowId = value.id || id(), rowContext = { ...context, rowId };
    return `<div class="jt-row" data-t-row="${esc(key)}" data-t-row-id="${esc(rowId)}" ${value.selected ? 'data-t-selected="true"' : ''}><div class="jt-row-grid">${fieldsFor(spec, context, namespace).map(def => fieldMarkup(def, value, rowContext, `jt-${kind}-${rowId}`)).join('')}</div><button type="button" class="text jt-row-remove" data-j-action="task-row-remove">移除这条材料</button></div>`;
  }
  function repeatMarkup(kind, spec, values, context, namespace) {
    return `<section class="jt-repeat" data-t-list="${esc(spec.key)}" data-t-kind="${esc(kind)}"><h4>${esc(spec.label)}</h4><div class="jt-repeat-rows">${arr(values).map(value => rowMarkup(kind, spec.key, value, context, namespace)).join('')}</div><button type="button" class="outline" data-j-action="task-row-add" data-t-kind="${esc(kind)}" data-t-list-key="${esc(spec.key)}">添加${esc(spec.label)}</button></section>`;
  }
  function taskEditor(kind, data = {}, context = {}) {
    const spec = specs[kind];
    if (!spec) return '<p class="jw-muted">先交代这件事，自动识别后再补充具体材料。</p>';
    return `<div class="jt-fields">${spec.fields.map(def => fieldMarkup(def, data, context, `jt-${kind}`)).join('')}</div>${arr(spec.rows).map(row => repeatMarkup(kind, row, data[row.key], context, data)).join('')}${spec.references ? '<button type="button" class="outline" data-j-action="task-refresh">更新可引用的材料</button><p class="jw-muted">增加步骤、候选、站点或阶段后，更新这里的选择项。</p>' : ''}`;
  }
  function baseEditor(item = {}) {
    return `<details class="jt-base-materials"><summary>准备步骤与候选材料</summary>${repeatMarkup('base', baseSpecs.steps, item.steps || [], {}, {})}${repeatMarkup('base', baseSpecs.candidates, item.candidates || [], {}, {})}</details>`;
  }
  function readField(container, def, options = {}) {
    const controls = [...container.querySelectorAll('[data-t-key]')].filter(n => n.dataset.tKey === def.key && !n.closest('.jt-row')?.parentElement?.closest('.jt-row'));
    const control = controls[0];
    if (def.type === 'checklist') return controls.filter(n => n.checked).map(n => n.value);
    if (!control) return def.default ?? (def.type === 'boolean' ? false : ['lines', 'date-lines'].includes(def.type) ? [] : null);
    if (def.type === 'boolean') return control.checked;
    const value = control.value;
    if (!options.draft && def.required && !value.trim()) throw new Error(`请补充「${def.label}」。`);
    if (def.type === 'datetime') { try { return iso(value); } catch (error) { if (!options.draft) throw error; return null; } }
    if (def.type === 'url') { if (!value.trim()) return null; if (options.draft) return value.trim(); if (!link(value.trim())) throw new Error(`「${def.label}」需要完整的 http 或 https 链接。`); return link(value.trim()); }
    if (['number', 'money'].includes(def.type)) {
      const n = value.trim() ? number(value) : def.default ?? null;
      if (!options.draft && n !== null && (!Number.isFinite(n) || n < (def.min ?? 0) || def.max !== undefined && n > def.max || def.type === 'money' && Math.abs(n * 100 - Math.round(n * 100)) > .00001)) throw new Error(`请校对「${def.label}」的数值，未知时留空。`);
      return n;
    }
    if (['lines', 'date-lines'].includes(def.type)) {
      const values = value.split('\n').map(v => v.trim()).filter(Boolean);
      if (!options.draft && def.type === 'date-lines' && values.some(v => !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) !== v)) throw new Error('打卡日期请每行填写一个有效的 YYYY-MM-DD。');
      return values;
    }
    if (def.type === 'nullable-text') return value.trim() ? value : null;
    return value;
  }
  function readRows(container, spec, context, namespace, options = {}) {
    const rows = [...container.querySelectorAll('.jt-row')].filter(n => n.dataset.tRow === spec.key);
    return rows.map(row => {
      const data = spec.noId ? {} : { id: row.dataset.tRowId };
      for (const def of fieldsFor(spec, context, namespace)) {
        const value = readField(row, def, options);
        if (def.key.startsWith('fields:')) { data.fields ||= {}; data.fields[def.key.slice(7)] = value; } else data[def.key] = value;
      }
      if (spec.key === 'options') data.fields ||= {};
      return data;
    });
  }
  function readTaskEditor(container, kind, original = {}, context = {}, options = {}) {
    const spec = specs[kind];
    if (!spec) return null;
    const data = structuredClone(original);
    delete data.confirmation; delete data.recordedAt;
    for (const def of spec.fields) data[def.key] = readField(container, def, options);
    for (const row of arr(spec.rows)) data[row.key] = readRows(container, row, context, data, options);
    if (kind === 'time-grid' && data.selectedSlotId && !arr(data.slots).some(s => s.id === data.selectedSlotId)) data.selectedSlotId = null;
    if (kind === 'prep' && data.activePhaseId && !arr(data.phases).some(s => s.id === data.activePhaseId)) data.activePhaseId = null;
    if (kind === 'itinerary') data.omittedStopIds = arr(data.omittedStopIds).filter(v => arr(data.stops).some(s => s.id === v && s.optional));
    if (kind === 'recovery' && data.selectedOptionId && !arr(data.options).some(o => o.id === data.selectedOptionId)) data.selectedOptionId = null;
    return data;
  }
  function readBaseEditor(container, options = {}) {
    const steps = readRows(container, baseSpecs.steps, {}, {}, options);
    const candidates = readRows(container, baseSpecs.candidates, {}, {}, options).map(row => {
      const element = [...container.querySelectorAll('[data-t-row=candidates]')].find(n => n.dataset.tRowId === row.id);
      return { id: row.id, name: row.name, detail: row.detail || '', ...(row.url ? { url: row.url } : {}), selected: element?.dataset.tSelected === 'true' };
    });
    return { steps, candidates };
  }
  window.PAJournalWidgets = { isEmptyReference, names, kinds, render, action, allowed, esc, asInput, taskEditor, readTaskEditor, baseEditor, readBaseEditor, rowMarkup, ready: customElements.whenDefined('wa-button') };
})();
