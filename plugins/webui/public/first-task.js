(() => {
  'use strict';
  const arr = value => Array.isArray(value) ? value : [];
  const str = value => typeof value === 'string' ? value : '';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const STORAGE = 'pa:first-task:pending-v1';
  const examples = [ ['plan', '推进一件挂心的事', '我有一件一直挂心、还没开始的事，帮我找到今天能做的第一步'], ['outing', '周末出门', '周末想出去走走，帮我安排一下'], ['reading', '阅读习惯', '我想每天读一会儿书，帮我坚持下来'] ];
  const stages = {
    draft: ['交代一件事', ''],
    queued: ['等待接手', ''],
    working: ['正在整理', ''],
    awaiting_answer: ['补充信息', ''],
    awaiting_confirmation: ['确认计划', ''],
    saving: ['正在保存', ''],
    recorded: ['已记入手账', ''],
    blocked: ['需要处理', ''],
    failed: ['未能完成', ''],
    cancelled: ['已停止', ''],
    uncertain: ['结果待核对', '确认原任务已停止后，才能继续。'],
    cancelling: ['等待停止确认', '确认原任务已停止后，才能继续。'],
    incomplete: ['尚未完成', ''],
  };
  const activeStatuses = new Set(['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling']);
  const uncertainStages = new Set(['uncertain', 'cancelling']);
  const safeCode = error => str(error?.code) || 'UNAVAILABLE';
  const errors = {
    FORBIDDEN: '页面会话已失效。刷新页面后接着做，草稿不会自动发送。',
    CONFLICT: '这件事已在别处更新。你的输入还在，请核对最新进展后再保存。',
    VERSION_CONFLICT: '这件事已在别处更新。你的输入还在，请核对最新进展后再保存。',
    AGENT_AUTH_REQUIRED: '需要在运行这位管家的电脑上重新登录。登录完成后，回来继续这件事。',
    ENDPOINT_OFFLINE: '管家暂时离线。草稿保留着，连接恢复后再开始。',
    OFFLINE: '管家暂时离线。草稿保留着，连接恢复后再开始。',
    INVALID_STATE: '处理进展已变化。先核对最新状态，再继续。',
    INVALID_INPUT: '请检查交代的内容，输入还在。',
    ROLE_UNCONFIGURED: '先连接一位管家。草稿已保留，连接后接着开始。',
    FIRST_TASK_BUSY: '管家还在处理上一轮，结束后再发送补充。',
    FIRST_TASK_RECOVERY_REQUIRED: '原任务的结果仍不确定，请先核对是否停止。',
    FIRST_TASK_FLOW_REQUIRED: '另一端已开始别的事情。当前输入保留着，请先核对最新交代。',
  };
  const errorMessage = error => errors[safeCode(error)] || '连接暂时中断。先核对这件事的进展，避免重复提交。';
  function requestId() {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  const dateLabel = value => {
    const date = new Date(value); if (!value || !Number.isFinite(date.getTime())) return '时间待定';
    return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  };
  function derive(snapshot = {}) {
    const flow = snapshot?.flow || null, stage = stages[flow?.stage] ? flow.stage : 'draft';
    const endpoints = arr(snapshot?.agents?.endpoints), agent = endpoints.find(e => e.id === (flow?.endpointId || snapshot?.agents?.preferredEndpointId)) || null;
    const run = flow?.runSummary || null, running = activeStatuses.has(run?.status) || ['queued', 'working', 'saving', 'uncertain', 'cancelling'].includes(stage);
    const items = arr(flow?.itemRecords), design = flow?.design || {};
    return { flow, stage, agent, run, running, uncertain: uncertainStages.has(stage) || ['uncertain', 'cancelling'].includes(run?.status), items, design, next: flow?.nextAction || { kind: 'start', label: '交给小满' } };
  }
  let root, api, navigate, snapshot, model, listeners, pollTimer, draftTimer, generation = 0, initialized = false, refreshing = false;
  let draft = '', dirty = false, saving = false, acting = false, pausedDraft = false, readError = null, writeError = null, pendingAction = null, pendingChecked = false, cachedPending = null, editPlan = false, loginAcknowledged = false, note = '', signature = '', draftPromise;
  const $ = selector => root?.querySelector(selector);
  function readCache() { try { return JSON.parse(localStorage.getItem(STORAGE) || 'null'); } catch { return null; } }
  function persist() {
    try {
      if (!dirty && !pendingAction) localStorage.removeItem(STORAGE);
      else localStorage.setItem(STORAGE, JSON.stringify({ flowId: model?.flow?.id || null, draft, dirty, pendingAction, updatedAt: Date.now() }));
    } catch { /* Server persistence still works when browser storage is unavailable. */ }
  }
  function accept(value, { mutation = false, capturedDraft } = {}) {
    if (!value || typeof value !== 'object') return;
    const nextFlow = value.flow || null, oldFlow = model?.flow;
    if (oldFlow && nextFlow?.id === oldFlow.id && nextFlow.version < oldFlow.version) return;
    if (oldFlow && nextFlow && nextFlow.id !== oldFlow.id && !mutation && (dirty || pendingAction)) {
      note = '另一端正在查看别的事情。先保存或核对当前交代，再切换。'; return;
    }
    snapshot = value; model = derive(snapshot);
    if (oldFlow?.currentRunId !== nextFlow?.currentRunId) loginAcknowledged = false;
    if (!initialized) {
      initialized = true;
      if (cachedPending && (cachedPending.flowId === nextFlow?.id || !cachedPending.flowId && !nextFlow)) {
        if (cachedPending.dirty === true && !dirty) { draft = str(cachedPending.draft); dirty = draft !== str(nextFlow?.draft); }
        pendingAction = cachedPending.pendingAction || null;
      } else if (dirty && nextFlow) { pausedDraft = true; note = '输入先保留着。请核对正在处理的这件事后，再决定是否保存这份草稿。'; }
      cachedPending = null;
    }
    const serverDraft = str(nextFlow?.draft);
    if (capturedDraft !== undefined && draft === capturedDraft && serverDraft === capturedDraft) { dirty = false; pausedDraft = false; }
    else if (!dirty) draft = serverDraft;
    if (['awaiting_confirmation', 'recorded'].includes(model.stage) && draft.trim()) editPlan = true;
    if (pendingAction && nextFlow?.lastRequest?.requestId === pendingAction.requestId) { pendingAction = null; pendingChecked = false; writeError = null; pausedDraft = false; note = '已核对，刚才的提交已收到。'; }
    persist();
  }
  function btn(id, label, action, { primary = false, disabled = false, value = '' } = {}) {
    return '<button type="button" id="' + id + '" class="' + (primary ? 'primary' : 'outline') + '" data-ft-action="' + action + '" data-ft-value="' + esc(value) + '" ' + (disabled ? 'disabled' : '') + '>' + esc(label) + '</button>';
  }
  const summary = label => '<summary><span>' + esc(label) + '</span><span aria-hidden="true" class="ft-expand"></span></summary>';
  function proposalMarkup() {
    const proposal = model.flow?.proposal, values = proposal?.values;
    if (!proposal || !values) return '';
    const rows = [ ['时间', dateLabel(values.date)] ];
    if (values.taskData?.agenda && Object.hasOwn(values.taskData.agenda, 'place')) rows.push(['地点', str(values.taskData.agenda.place) || '待定']);
    if (values.taskData?.budget?.total != null) rows.push(['预算', '¥ ' + Number(values.taskData.budget.total).toLocaleString('zh-CN')]);
    return '<section class="ft-proposal" aria-labelledby="ft-plan-title"><h3 id="ft-plan-title">' + esc(values.title || '这一件生活事') + '</h3>' + (proposal.summary ? '<p class="ft-plan-summary">' + esc(proposal.summary) + '</p>' : '') + '<dl class="ft-facts">' + rows.map(([label, value]) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>').join('') + '</dl>' + (values.note ? '<p class="ft-plan-note">' + esc(values.note) + '</p>' : '') + (arr(values.steps).length ? '<div class="ft-plan-steps"><ol aria-label="准备清单">' + values.steps.map(step => '<li><span aria-hidden="true" class="ft-step-mark">' + (step.done === true ? '✓' : '·') + '</span>' + esc(step.label) + '<span class="ft-step-status">' + (step.done === true ? '已记录完成' : '') + '</span></li>').join('') + '</ol></div>' : '') + '<p class="ft-note">仅保存计划，不会预约、购买或发送。</p></section>';
  }
  function questionsMarkup() {
    const questions = arr(model.flow?.questions).slice(0, 3);
    return '<section class="ft-questions" aria-labelledby="ft-question-title"><h3 id="ft-question-title">' + esc(model.flow?.questionMessage || '请补充') + '</h3>' + (questions.length ? '<ol>' + questions.map(q => '<li><strong>' + esc(q.label) + '</strong>' + (q.hint ? '<span>' + esc(q.hint) + '</span>' : '') + '</li>').join('') + '</ol>' : '<p>请补充具体要求。</p>') + '</section>';
  }
  function recordMarkup() {
    if (!model.items.length) return '<div class="ft-recovery"><strong>这次保存过的记录目前未找到</strong><p>可能已在别处删除。先核对手账，已有交代和确认历史仍保留。</p>' + btn('ft-record-check', '重新核对手账记录', 'check', { disabled: refreshing || acting }) + '</div>';
    const design = model.design, designText = ['queued', 'running'].includes(design.state) ? '正在整理看板' : design.state === 'failed' ? '看板整理未完成，记录已保存。' : '';
    return (model.flow?.followupAnswer ? '<section class="ft-followup" aria-label="小满的回复"><p class="ft-plan-note">' + esc(model.flow.followupAnswer) + '</p></section>' : '') + '<section class="ft-record" aria-labelledby="ft-record-title">' + model.items.map((item, index) => '<article><h3 id="' + (index ? 'ft-record-title-' + index : 'ft-record-title') + '">' + esc(item.title || '这一件生活事') + '</h3><p>' + esc(dateLabel(item.date)) + ' · ' + esc(item.status === 'done' ? '已记下结束' : item.status === 'cancelled' ? '已放下' : '准备中') + '</p>' + (index ? btn('ft-view-' + index, '查看这件事', 'view', { value: item.id }) : '') + '</article>').join('') + (designText ? '<p class="ft-design-state" role="status">' + esc(designText) + '</p>' : '') + '</section>';
  }
  function approvalsMarkup() {
    return arr(model.flow?.approvals).filter(a => !a.status || ['pending', 'requested'].includes(a.status)).map((approval, index) => '<section class="ft-approval" aria-labelledby="ft-approval-' + index + '"><h3 id="ft-approval-' + index + '">' + esc(approval.title || approval.description || '管家请求一次操作授权') + '</h3><p>' + esc(approval.reason || approval.detail || '') + '</p>' + (approval.command ? '<pre>' + esc(typeof approval.command === 'string' ? approval.command : JSON.stringify(approval.command, null, 2)) + '</pre>' : '') + '<div class="ft-actions">' + btn('ft-allow-' + index, '允许这次操作', 'allow', { disabled: blocked(), value: approval.id }) + btn('ft-decline-' + index, '拒绝这次操作', 'decline', { disabled: blocked(), value: approval.id }) + '</div></section>').join('');
  }
  function transcript() {
    const messages = arr(model.flow?.messages);
    if (!messages.length) return '';
    return '<details class="ft-history" id="ft-history">' + summary('交代与回复 · ' + messages.length + ' 条') + '<ol>' + messages.map(m => '<li data-role="' + (m.role === 'user' ? 'user' : 'assistant') + '"><span class="ft-sr">' + (m.role === 'user' ? '你的交代' : '小满') + '</span><p>' + esc(m.text) + '</p></li>').join('') + '</ol></details>';
  }
  function blocked() { return acting || saving || !initialized || !!readError || !!pendingAction; }
  function connectionIssue() {
    const error = model.run?.error;
    const code = str(error?.code) || str(error);
    if (['AGENT_AUTH_REQUIRED', 'LOGIN_REQUIRED', 'AUTH_REQUIRED'].includes(code)) return 'login';
    if (['ENDPOINT_OFFLINE', 'ENDPOINT_UNAVAILABLE', 'OFFLINE', 'UNAVAILABLE'].includes(code)) return 'offline';
    if (code === 'ROLE_UNCONFIGURED' || !model.agent) return 'missing';
    if (model.next.kind === 'connect' || model.agent.online !== true) return 'offline';
    return '';
  }
  const needsConnection = () => !!connectionIssue();
  function composer({ first = false, label = '补充这件事', submit = '继续整理', operation = 'send' } = {}) {
    const needsSetup = first && initialized && (!model.agent || model.agent.online !== true);
    return '<form id="ft-compose" data-operation="' + operation + '"><label for="ft-draft"' + (first ? ' class="ft-sr"' : '') + '>' + esc(first ? '想做什么' : label) + '</label><textarea id="ft-draft" name="life-request" rows="' + (first ? '3' : '2') + '" maxlength="12000" placeholder="' + (first ? '比如：整理最近值得读的信息' : '补充具体要求') + '" ' + (acting ? 'disabled' : '') + '>' + esc(draft) + '</textarea><div class="ft-compose-bottom"><p id="ft-draft-status" class="ft-draft-status" role="status">' + esc(saving ? '正在保存草稿…' : dirty ? pausedDraft ? '草稿仍保留，尚未同步' : '草稿待同步' : initialized ? draft ? '草稿已保存' : '' : '正在读取…') + '</p>' + btn('ft-submit', needsSetup ? model.agent ? '重连管家后开始' : '先连接一位管家' : acting ? '正在提交…' : submit, needsSetup ? 'connect' : operation, { primary: true, disabled: blocked() || !needsSetup && (!draft.trim() || model.running || model.uncertain) }) + '</div></form>';
  }
  function primaryAction() {
    const next = model.next, disabled = blocked() || model.running;
    const editButton = btn('ft-edit-plan', editPlan ? draft.trim() ? '放弃修改' : '返回计划' : '修改', editPlan && draft.trim() ? 'discard-edit' : 'edit', { disabled });
    if (model.stage === 'awaiting_confirmation') return '<div class="ft-actions">' + (!editPlan ? btn('ft-confirm', acting ? '正在确认…' : '记入手账', 'confirm', { primary: true, disabled: disabled || !model.flow?.proposal || !!draft.trim() }) : '') + editButton + '</div>';
    if (model.stage === 'recorded') return '<div class="ft-actions">' + btn('ft-view', '打开手账', 'view', { primary: !editPlan, disabled: !model.items.length, value: model.items[0]?.id }) + (!model.uncertain ? editButton : '') + '</div>' + (model.uncertain ? uncertainActions(false) : '');
    if (model.uncertain) return uncertainActions(true);
    if (needsConnection()) {
      const login = connectionIssue() === 'login';
      return '<div class="ft-actions">' + btn('ft-connect', login ? '重新登录' : '连接管家', 'connect', { primary: true }) + btn('ft-check', login ? '核对状态' : '核对状态', 'check', { disabled: refreshing || acting }) + '</div>' + (login ? '<details class="ft-stop-confirm" id="ft-login-resume">' + summary('已经在执行端重新登录') + '<label for="ft-login-confirm" class="checkbox-label check"><input id="ft-login-confirm" type="checkbox" ' + (loginAcknowledged ? 'checked' : '') + '> 我已在运行这位管家的电脑上完成重新登录</label><p>页面在线状态不能证明登录恢复。确认后才会重新办理原来的事。</p>' + btn('ft-login-retry', '登录完成，继续原来的事', 'login-resume', { disabled: blocked() || !loginAcknowledged || model.agent?.online !== true }) + '</details>' : model.agent?.online === true && !model.running ? '<details class="ft-stop-confirm" id="ft-reconnect-resume">' + summary('已经恢复连接') + '<p>如果已在执行端恢复连接，可以明确继续原来的事。</p>' + btn('ft-reconnect-retry', '连接恢复，继续原来的事', 'resume', { disabled: blocked() }) + '</details>' : '');
    }
    if (['failed', 'cancelled', 'incomplete', 'blocked'].includes(model.stage) && !model.running) return '<div class="ft-actions">' + btn('ft-resume', '继续原来的事', 'resume', { primary: true, disabled }) + '</div>';
    return '';
  }
  function uncertainActions(primary) {
    return '<div class="ft-actions">' + btn('ft-check', refreshing ? '正在核对…' : '核对原任务状态', 'check', { primary, disabled: refreshing || acting }) + '</div><details class="ft-stop-confirm" id="ft-stop-confirm">' + summary('我已确认原任务停止') + '<p>仅在确认原任务没有继续执行后使用。已有记录仍会保留。</p>' + btn('ft-confirm-stopped', '确认已停止，结束这次处理', 'confirm-stopped', { disabled: acting || saving }) + '</details>';
  }
  function markup() {
    const confirmedSave = model.flow?.confirmedProposal?.runId === model.flow?.currentRunId && model.flow?.currentRunId;
    const state = model.stage === 'recorded' && !model.items.length ? ['记录待核对', ''] : model.stage === 'recorded' && model.uncertain ? ['计划已保存，处理状态还待核对', '最后一轮尚未确认停止。'] : model.stage === 'queued' && confirmedSave ? ['等待保存', ''] : model.stage === 'recorded' && model.flow?.followupAnswer ? ['已有回复', ''] : stages[model.stage], noFlow = !model.flow || model.stage === 'draft', uncertainAction = !!pendingAction;
    let body = '';
    if (noFlow) body = composer({ first: true, operation: 'start', submit: '交给小满' }) + '<details class="ft-history" id="ft-examples-wrap">' + summary('例句') + '<div class="ft-examples" aria-label="生活交代示例">' + examples.map(([id, label, value]) => btn('ft-example-' + id, label, 'example', { disabled: acting, value })).join('') + '</div></details>';
    else {
      if (model.stage === 'awaiting_answer') body += questionsMarkup();
      if (model.stage === 'awaiting_confirmation') body += proposalMarkup();
      if (model.stage === 'recorded') body += recordMarkup();

      if (['blocked', 'failed', 'cancelled', 'incomplete', 'uncertain', 'cancelling'].includes(model.stage)) body += '<div class="ft-recovery"><strong>' + esc(connectionIssue() === 'login' ? '需要在执行端重新登录' : needsConnection() ? model.agent ? '管家暂时离线，需要恢复连接' : '先连接一位管家' : model.next.label || state[0]) + '</strong><p>' + esc(connectionIssue() === 'login' ? '请在运行' + (model.agent?.label || '这位管家') + '的电脑上重新登录，然后继续。' : needsConnection() ? '连接恢复后再继续。' : model.flow?.blocked?.reason || model.next.detail || state[1]) + '</p></div>';
      body += approvalsMarkup() + primaryAction();
      if (model.stage === 'awaiting_answer') body += composer({ submit: '继续整理' });
      if (['awaiting_confirmation', 'recorded'].includes(model.stage) && editPlan) body += composer({ label: '想调整什么', submit: '按补充重新整理' });
      if (['failed', 'cancelled', 'incomplete', 'blocked'].includes(model.stage) && !model.running && !needsConnection()) body += '<details class="ft-history" id="ft-resume-edit">' + summary('补充情况') + composer({ label: '接着处理这件事', submit: '按补充继续' }) + '</details>';
      if (['queued', 'working', 'saving'].includes(model.stage) && !arr(model.flow?.approvals).length) body += '<div class="ft-secondary-actions">' + btn('ft-cancel-run', '停止', 'cancel-run', { disabled: acting || saving }) + '</div>';
      body += transcript();
      if (model.stage === 'recorded') body += '<div class="ft-secondary-actions">' + btn('ft-new', '新任务', 'new', { disabled: blocked() || model.running }) + '</div>';
    }
    const error = writeError || readError;
    return '<section class="first-task" aria-labelledby="ft-title">' + (needsConnection() && model.agent ? '<p class="ft-chief">' + esc(model.agent.label + (connectionIssue() === 'login' ? ' · 需要登录' : ' · 离线')) + '</p>' : '') + '<h2 id="ft-title" tabindex="-1">' + (['queued', 'working', 'saving'].includes(model.stage) ? '<span class="ft-working-dot" aria-hidden="true"></span>' : '') + esc(state[0]) + '</h2>' + (state[1] ? '<p class="ft-lead">' + esc(state[1]) + '</p>' : '') + (uncertainAction ? '<div class="ft-request-pending" role="status"><strong>提交结果待核对</strong><p>未自动重试。请先核对。</p>' + btn('ft-request-check', refreshing ? '正在核对…' : '核对提交结果', 'check', { primary: true, disabled: refreshing || acting }) + (pendingChecked && pendingAction.payload ? btn('ft-request-retry', pendingAction.operation === 'confirm' ? '继续提交这次确认' : '重试刚才这次提交', 'retry-request', { disabled: acting || saving || !!readError }) : '') + '</div>' : '') + body + (error || pausedDraft ? '<div class="ft-error" role="alert"><p>' + esc(error ? errorMessage(error) : '这份草稿尚未用于当前事。核对后，可以明确采用或放下。') + '</p>' + (safeCode(error) === 'FORBIDDEN' ? btn('ft-reload', '刷新页面继续', 'reload') : error ? btn('ft-read-retry', '核对最新进展', 'check', { disabled: refreshing || acting }) : '') + (pausedDraft && !pendingAction ? '<p class="ft-preserved-draft">' + esc(draft) + '</p>' + btn('ft-draft-retry', error ? '保存这份草稿' : '把这份输入用于当前事', 'save-draft', { disabled: saving || acting || !initialized || !!readError }) + btn('ft-draft-discard', '放下这份浏览器草稿', 'discard-draft', { disabled: saving || acting }) : '') + '</div>' : '') + (note ? '<p class="ft-feedback" role="status">' + esc(note) + '</p>' : '') + '</section>';
  }
  function key(node) { return node.nodeType === 1 ? node.id || node.getAttribute('data-key') : null; }
  function sync(node, next, preserve = false) {
    if (node.nodeType === 3) { if (node.data !== next.data) node.data = next.data; return; }
    if (node.nodeType !== 1) return;
    if (!preserve) {
      for (const a of [...node.attributes]) if (!next.hasAttribute(a.name)) node.removeAttribute(a.name);
      for (const a of next.attributes) if (node.getAttribute(a.name) !== a.value) node.setAttribute(a.name, a.value);
    }
    if (node.tagName === 'TEXTAREA') { if (node.value !== draft) node.value = draft; node.disabled = next.disabled; return; }
    if (node.tagName === 'BUTTON') node.disabled = next.disabled;
    const existing = [...node.childNodes], used = new Set();
    [...next.childNodes].forEach((child, index) => {
      const identity = key(child), match = existing.find(n => !used.has(n) && n.nodeType === child.nodeType && (n.nodeType !== 1 || n.tagName === child.tagName) && (identity ? key(n) === identity : !key(n)));
      const result = match || child.cloneNode(true);
      if (match) { used.add(match); sync(match, child); }
      if (node.childNodes[index] !== result) node.insertBefore(result, node.childNodes[index] || null);
    });
    for (const child of existing) if (!used.has(child)) child.remove();
  }
  function paint({ focus = false } = {}) {
    if (!root) return;
    const html = markup(); if (html === signature && !focus) return;
    const active = document.activeElement, id = active?.id, selection = active?.id === 'ft-draft' ? [active.selectionStart, active.selectionEnd] : null;
    const opened = new Set([...root.querySelectorAll('details[open]')].map(n => n.id));
    const before = root.dataset.stage, next = document.createElement('div'); next.innerHTML = html;
    sync(root, next, true); root.dataset.stage = model.stage; signature = html;
    for (const detail of root.querySelectorAll('details')) if (opened.has(detail.id)) detail.open = true;
    if (focus) $('#ft-title')?.focus({ preventScroll: true });
    else if (id && active?.isConnected === false) $(`[id="${id}"]`)?.focus({ preventScroll: true });
    if (selection && $('#ft-draft') === document.activeElement) $('#ft-draft').setSelectionRange?.(...selection);
    const reduced = ['off', 'reduced'].includes(document.documentElement.dataset.motion) || matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (before && before !== model.stage && !reduced) $('.first-task')?.animate?.([{ opacity: .65, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.75,.25,1)' });
  }
  async function refresh() {
    if (!root || refreshing || safeCode(readError) === 'FORBIDDEN') return false;
    const token = generation; refreshing = true; paint();
    try {
      const flowId = model?.flow?.id || cachedPending?.flowId;
      const value = await api('first-task' + (flowId ? '?flowId=' + encodeURIComponent(flowId) : ''));
      if (!root || token !== generation) return false;
      readError = null; accept(value); pendingChecked = !!pendingAction; paint();
      if (dirty && !pausedDraft && !pendingAction) scheduleDraft();
      return true;
    } catch (error) { if (root && token === generation) { readError = error; if (safeCode(error) === 'FORBIDDEN') clearInterval(pollTimer); paint(); } return false; }
    finally { if (root && token === generation) { refreshing = false; paint(); } }
  }
  function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(() => void flushDraft(), 650); }
  async function flushDraft({ retry = false } = {}) {
    clearTimeout(draftTimer);
    if (draftPromise) { await draftPromise; if (dirty && !pausedDraft) return flushDraft(); return !dirty; }
    if (!dirty) return true;
    if (!root || !initialized || acting || pendingAction || readError || pausedDraft && !retry) return false;
    const token = generation, value = draft, flow = model.flow;
    saving = true; paint();
    draftPromise = (async () => {
      try {
        const result = await api('first-task', { operation: 'draft', text: value, ...(flow ? { flowId: flow.id, version: flow.version } : {}), requestId: requestId() });
        if (!root || token !== generation) return false;
        writeError = null; pausedDraft = false; accept(result, { mutation: true, capturedDraft: value }); return true;
      } catch (error) {
        if (root && token === generation) { writeError = error; pausedDraft = true; persist(); }
        return false;
      } finally { if (root && token === generation) { saving = false; draftPromise = null; paint(); } }
    })();
    const success = await draftPromise;
    if (success && dirty && !pausedDraft && root && token === generation) return flushDraft();
    return success && !dirty;
  }
  async function act(operation, extra = {}) {
    if (blocked() || model.uncertain && !['cancel-run'].includes(operation)) return;
    if (['start', 'send', 'confirm', 'new'].includes(operation) && model.running) return;
    if (['start', 'send'].includes(operation) && !draft.trim()) return;
    if (['start', 'send', 'confirm'].includes(operation) && (!model.agent || model.agent.online !== true)) { note = '草稿已保留。先连接管家，再开始处理。'; paint(); return; }
    if (dirty && !await flushDraft()) return;
    if (!root || pendingAction) return;
    const token = generation, flow = model.flow, payload = { operation, ...(flow ? { flowId: flow.id, version: flow.version } : {}), ...extra, requestId: requestId() };
    if (operation === 'confirm') payload.proposalVersion = flow?.proposal?.version;
    acting = true; writeError = null; note = ''; pendingChecked = false; pendingAction = { requestId: payload.requestId, operation, flowId: flow?.id || null, payload, submittedDraft: draft }; persist(); paint();
    try {
      const result = await api('first-task', payload);
      if (!root || token !== generation) return;
      pendingAction = null; dirty = false; editPlan = false; accept(result, { mutation: true }); paint({ focus: true });
    } catch (error) {
      if (!root || token !== generation) return;
      writeError = error;
      if (error.code && !['CONTROL_TIMEOUT', 'EXECUTION_UNCERTAIN', 'UNAVAILABLE'].includes(error.code)) pendingAction = null;
      pausedDraft = true; persist();
      await refresh();
    } finally { if (root && token === generation) { acting = false; persist(); paint(); } }
  }
  async function retryPending() {
    if (!root || !pendingAction?.payload || !pendingChecked || acting || saving || readError) return;
    const token = generation, request = pendingAction;
    acting = true; writeError = null; paint();
    try {
      const result = await api('first-task', request.payload);
      if (!root || token !== generation) return;
      const hasNewInput = dirty && draft !== request.submittedDraft;
      pendingAction = null; pendingChecked = false; dirty = hasNewInput; pausedDraft = false; editPlan = false; accept(result, { mutation: true }); note = hasNewInput ? '已收到刚才的提交，新补充保留为草稿。' : '已收到这次提交，接着显示原来的进展。'; paint({ focus: true });
    } catch (error) {
      if (!root || token !== generation) return;
      writeError = error;
      if (error.code && !['CONTROL_TIMEOUT', 'EXECUTION_UNCERTAIN', 'UNAVAILABLE'].includes(error.code)) pendingAction = null;
      await refresh();
    } finally { if (root && token === generation) { acting = false; persist(); paint(); } }
  }
  function input(event) {
    if (event.target.id !== 'ft-draft' || acting) return;
    draft = event.target.value; dirty = draft !== str(model.flow?.draft); note = ''; persist(); scheduleDraft(); paint();
  }
  function change(event) { if (event.target.id === 'ft-login-confirm') { loginAcknowledged = event.target.checked === true; paint(); } }
  function click(event) {
    const button = event.target.closest('[data-ft-action]'); if (!button || button.disabled) return;
    event.stopPropagation();
    const action = button.dataset.ftAction, value = button.dataset.ftValue;
    if (action === 'reload') return location.reload();
    if (action === 'check') return void refresh().then(() => { if (root && connectionIssue() === 'login') { note = '已读取最新状态；在线心跳不能确认登录已恢复。请先在执行端完成登录，再明确继续原来的事。'; paint(); } });
    if (action === 'retry-request') return void retryPending();
    if (action === 'save-draft') return void flushDraft({ retry: true });
    if (action === 'discard-draft') { draft = str(model.flow?.draft); dirty = false; pausedDraft = false; writeError = null; note = '已放下这份浏览器草稿，原来的办理进展保留。'; persist(); return paint(); }
    if (action === 'example') { draft = value; dirty = draft !== str(model.flow?.draft); pausedDraft = false; persist(); scheduleDraft(); paint(); return $('#ft-draft')?.focus({ preventScroll: true }); }
    if (action === 'edit') { editPlan = !editPlan; paint(); return editPlan ? $('#ft-draft')?.focus({ preventScroll: true }) : undefined; }
    if (action === 'discard-edit') { draft = ''; dirty = str(model.flow?.draft) !== ''; pausedDraft = false; editPlan = false; note = '已放弃修改，原计划保留。'; persist(); scheduleDraft(); return paint(); }
    if (action === 'resume') { if (!draft.trim()) { draft = '继续处理刚才交代的这件事。'; dirty = true; persist(); } return void act('send'); }
    if (action === 'login-resume') { if (!loginAcknowledged) return; if (!draft.trim()) { draft = '我已在执行端重新登录，请继续处理刚才交代的这件事。'; dirty = true; persist(); } return void act('send'); }
    if (action === 'view') return void navigate({ page: 'journal', itemId: value || model.items[0]?.id });
    if (action === 'connect') return void (async () => { if (dirty && !await flushDraft()) return; if (root) await navigate({ page: 'chat', section: 'agents', endpointId: model.flow?.endpointId || model.agent?.id }); })();
    if (action === 'allow' || action === 'decline') return void act('decide', { approvalId: value, allow: action === 'allow' });
    if (action === 'confirm-stopped') return void act('cancel-run', { confirmStopped: true });
    if (['start', 'send', 'confirm', 'new', 'cancel-run'].includes(action)) return void act(action);
  }
  function submit(event) { if (event.target.id !== 'ft-compose') return; event.preventDefault(); event.stopPropagation(); void act(event.target.dataset.operation || 'send'); }
  function mount(options) {
    if (root === options.root && root.querySelector('.first-task')) return update(options.state);
    unmount(); root = options.root; api = options.api; navigate = options.navigate; generation++;
    snapshot = {}; model = derive(snapshot); initialized = false; draft = ''; dirty = false; saving = false; acting = false; pausedDraft = false; readError = null; writeError = null; pendingAction = null; pendingChecked = false; cachedPending = readCache(); editPlan = false; loginAcknowledged = false; note = ''; signature = '';
    if (cachedPending?.dirty === true) { draft = str(cachedPending.draft); dirty = true; }
    listeners = new AbortController(); root.addEventListener('click', click, { signal: listeners.signal }); root.addEventListener('input', input, { signal: listeners.signal }); root.addEventListener('change', change, { signal: listeners.signal }); root.addEventListener('submit', submit, { signal: listeners.signal });
    paint(); pollTimer = setInterval(() => { if (!document.hidden && !saving && !acting) void refresh(); }, 2500); void refresh();
  }
  async function prefill(value = '') {
    const compose = root?.closest('#on-compose'); if (compose) compose.open = true;
    const token = generation;
    // Read before filling: never replace a saved draft or an ongoing task.
    try { const current = await api('first-task'); if (!root || token !== generation) return; accept(current); }
    catch { if (root && token === generation) { note = '先恢复已有交代，再写下一件事。'; paint(); } return; }
    if (!root || token !== generation) return;
    if (draft.trim() || dirty || pendingAction || model.stage !== 'draft') {
      note = '你之前的交代还在。先接着这件事，新的方向不会覆盖它。'; paint();
    } else if (value.trim()) {
      draft = value.trim().slice(0, 12000); dirty = true; persist(); scheduleDraft();
      note = '方向已带过来。改成自己的话，再交给小满。'; paint();
    }
    const target = $('#ft-draft') || $('#ft-title'); target?.focus(); target?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  }
  function update() { if (root) paint(); }
  function unmount() { if (root) persist(); generation++; listeners?.abort(); clearInterval(pollTimer); clearTimeout(draftTimer); root = null; saving = false; acting = false; refreshing = false; draftPromise = null; signature = ''; }
  window.PAFirstTask = { mount, update, unmount, prefill, isBusy: () => saving || acting, isEditing: () => dirty, flushDraft, derive };
})();
