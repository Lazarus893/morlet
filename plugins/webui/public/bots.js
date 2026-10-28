(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const faces = ['steward', 'research', 'planner', 'maker'];
  const presence = bot => window.PATruth.botPresence(bot);
  const avatar = (bot, options = {}) => {
    const state = options.presence ? presence(bot) : null;
    return `<img class="bot-avatar${state?.muted ? ' is-offline' : ''}" src="/bot-avatars/${faces.includes(bot?.avatar) ? bot.avatar : 'steward'}.png" alt="" ${state ? `title="${esc(state.label)}" data-presence="${state.state}"` : ''} width="40" height="40">`;
  };
  const errors = { BOT_NAME_TAKEN: '名字或 @标识已被使用。', BOT_CONNECTION_REQUIRED: '请在设置中连接这个 Bot。', VERSION_CONFLICT: '设置已更新，请重新打开后核对。', MANAGER_REQUIRED: '总管需要保持启用。', ENDPOINT_UNAVAILABLE: '原连接已停用，请选择可用连接。', INVALID_INPUT: '请核对名字、@标识和职责。' };
  let root, api, navigate, mode, model, timer, selected = 'group', activeConversation = '', busy = false, editing = false, generation = 0, activeSelection = 'group', failedSelection = '';
  let mentionsModel = [], mentionsUpdatedAt = 0;
  const mentionMenus = new WeakMap();
  let detailBotId = null, detailOpener = null, routeVersion = 0;
  function notice(text, failed = false, source = '') {
    const box = root?.querySelector('.bots-status'); if (!box) return;
    box.hidden = !text; box.dataset.error = String(failed); box.dataset.source = source;
    box.querySelector('#bots-status').textContent = text;
    box.querySelector('#bots-retry').hidden = !failed;
  }
  const showError = (error, source = 'action') => notice(errors[error.code] || error.message || '暂时无法读取，请重试。', true, source);
  const activeBots = () => (model?.bots || []).filter(bot => bot.active);
  const members = () => `<span class="bot-members" aria-hidden="true">${activeBots().slice(0, 4).map(bot => avatar(bot, { presence: true })).join('')}</span>`;
  function replace(element, markup) {
    if (!element || element.dataset.markup === markup) return;
    const focus = element.contains(document.activeElement) ? JSON.stringify(document.activeElement?.dataset || {}) : null;
    const roleOpen = element.querySelector('.bot-detail-role')?.open;
    const diagnostics = new Set([...element.querySelectorAll('details[data-routine-error][open]')].map(node => node.dataset.routineError));
    const diagnosticFocus = element.contains(document.activeElement) ? document.activeElement?.closest('[data-routine-error]')?.dataset.routineError : null;
    element.innerHTML = markup; element.dataset.markup = markup;
    if (roleOpen && element.querySelector('.bot-detail-role')) element.querySelector('.bot-detail-role').open = true;
    for (const node of element.querySelectorAll('[data-routine-error]')) { if (diagnostics.has(node.dataset.routineError)) node.open = true; if (diagnosticFocus === node.dataset.routineError) node.querySelector('summary')?.focus({ preventScroll: true }); }
    if (focus && !diagnosticFocus) [...element.querySelectorAll('button')].find(button => JSON.stringify(button.dataset) === focus)?.focus({ preventScroll: true });
  }
  async function refresh() {
    const ticket = generation;
    try {
      const next = await api('hub');
      if (!root || ticket !== generation) return false;
      model = next; mentionsModel = next.bots || []; mentionsUpdatedAt = Date.now();
      renderList();
      if (root.querySelector('.bots-status')?.dataset.source === 'read') notice('');
      return true;
    } catch (error) { if (ticket === generation) showError(error, 'read'); return false; }
  }
  function renderList() {
    if (!root || !model) return;
    const list = root.querySelector('#bots-list');
    const bots = (model.bots || []).filter(bot => mode === 'settings' || bot.active);
    const buttons = bots.map(bot => {
      const truth = presence(bot), state = truth.state === 'online' ? '' : truth.label;
      return `<button type="button" class="bot-row" data-bot="${esc(bot.id)}" ${selected === bot.id ? 'aria-current="true"' : ''} ${busy ? 'disabled' : ''}>${avatar(bot, { presence: true })}<span class="bot-row-label"><strong>${esc(bot.name)}</strong>${state ? `<small>${esc(state)}</small>` : ''}</span></button>`;
    }).join('');
    replace(list, (mode === 'chat' ? `<button type="button" class="bot-row bot-group" data-bot="group" ${selected === 'group' ? 'aria-current="true"' : ''} ${busy ? 'disabled' : ''}>${members()}<span class="bot-row-label"><strong>全员群</strong></span></button>` : '') + buttons);
    if (mode !== 'chat') return;
    const bot = model.bots.find(value => value.id === selected), group = selected === 'group';
    if (!busy || !activeConversation) replace(root.querySelector('#bot-chat-identity'), `<h1 id="bot-chat-title" tabindex="-1"><button type="button" class="bot-identity-button" data-bot-detail="${group ? 'group' : esc(bot?.id || selected)}" aria-haspopup="dialog" aria-label="${group ? '查看群成员' : `查看${esc(bot?.name || 'Bot')}的详情`}">${group ? members() : avatar(bot, { presence: true })}<span>${group ? '全员群' : esc(bot?.name || 'Bot')}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></h1>`);
    const ready = (bot || model.bots.find(value => value.id === 'xiaoman'))?.connected;
    const connection = root.querySelector('#bot-connect');
    connection.hidden = !!ready; connection.disabled = busy;
    root.querySelector('#bot-chat-root').setAttribute('aria-busy', String(busy));
    root.querySelector('#bot-chat-root').inert = busy;
    renderDetail();
  }
  function scheduledTime(value) {
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }
  function renderDetail() {
    if (!detailBotId || !root) return;
    const host = root.querySelector('#bot-detail-body'), group = detailBotId === 'group';
    if (group) { replace(host, `<h2 id="bot-detail-title">群成员</h2><div class="bot-detail-members">${activeBots().map(bot => `<button type="button" data-bot-detail="${esc(bot.id)}">${avatar(bot, { presence: true })}<span>${esc(bot.name)}<small>${esc(presence(bot).label)}</small></span></button>`).join('')}</div>`); return; }
    const bot = model.bots.find(value => value.id === detailBotId);
    if (!bot) { replace(host, '<h2 id="bot-detail-title">Bot 已不可用</h2>'); return; }
    const execution = bot.execution || {}, state = presence(bot);
    const endpoint = model.endpoints.find(value => value.id === (execution.endpointId || bot.resolvedEndpointId));
    const routines = bot.routines || [];
    const tasks = (model.rootTasks || []).filter(task => ['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling'].includes(task.state) && (task.botId === bot.id || task.participantSlots?.some(slot => slot.botId === bot.id)));
    const routineRows = routines.map(item => {
      const next = scheduledTime(item.nextRunAt), schedule = typeof item.schedule === 'string' ? item.schedule : item.schedule?.label || item.schedule?.summary, trigger = typeof item.trigger === 'string' ? item.trigger : item.trigger?.label || item.trigger?.summary;
      const context = item.ended || item.endedAt ? '已结束' : item.scopeStatus?.blocked ? '暂未运行' : !item.enabled ? '已暂停' : next ? `下次 ${next}` : schedule || trigger || '等待触发';
      const error = item.error && (window.PARoutineUI?.errorLabel(item.error) || '这次巡查未完成，请打开原手账核对后恢复。');
      return `<li>${item.journalItemId ? `<button type="button" class="text" data-bot-item="${esc(item.journalItemId)}">${esc(item.title)}</button>` : `<strong>${esc(item.title)}</strong>`}<p class="note">${esc(context)}</p>${error ? `<p class="bot-detail-error">${esc(error)}</p><details class="bot-detail-diagnostic" data-routine-error="${esc(item.id)}"><summary>错误详情</summary><code>${esc(item.error)}</code></details>` : ''}</li>`;
    }).join('');
    const taskRows = tasks.map(task => { const run = model.runs.find(value => value.id === task.rootRunId || value.id === task.id), title = run?.title || run?.report?.title || '正在处理的交代'; return `<li><strong class="bot-detail-task-title" title="${esc(title)}">${esc(title)}</strong><p class="note">${esc(({ queued: '排队中', running: '正在处理', waiting_approval: '等待批准', uncertain: '执行结果待核对', cancelling: '等待停止' })[task.state])}</p>${task.messageId ? `<button class="text" type="button" data-bot-task="${esc(task.id)}">查看对话</button>` : ''}</li>`; }).join('');
    replace(host, `<div class="bot-detail-heading">${avatar(bot, { presence: true })}<div><h2 id="bot-detail-title">${esc(bot.name)}</h2><p>${esc(state.label)}</p></div></div>${bot.instructions ? `<details class="bot-detail-role"><summary>职责</summary><p>${esc(bot.instructions)}</p></details>` : ''}<section class="bot-detail-section"><h3>执行 Agent</h3><p>${esc(execution.label || endpoint?.label || '尚未连接')}<span class="note">${execution.provider || endpoint?.provider ? ' · ' + esc(execution.provider || endpoint.provider) : ''}</span></p>${state.state === 'attention' ? `<p class="bot-detail-error">${esc(state.label)}</p>` : ''}<button type="button" class="text" data-bot-settings="${esc(bot.id)}">管理连接</button></section><section class="bot-detail-section"><h3>巡查</h3>${routineRows ? `<ul class="bot-detail-tasks">${routineRows}</ul>` : '<p class="note">还没有安排。</p>'}</section>${taskRows ? `<section class="bot-detail-section"><h3>当前执行</h3><ul class="bot-detail-tasks">${taskRows}</ul></section>` : ''}`);
  }
  function openDetail(id, opener) {
    const dialog = root?.querySelector('#bot-detail'); if (!dialog) return;
    detailBotId = id; renderDetail();
    if (!dialog.open) { detailOpener = opener; dialog.showModal(); window.PAMotion?.play(dialog, 'enter'); }
    dialog.querySelector('#bot-detail-title')?.setAttribute('tabindex', '-1');
    dialog.querySelector('#bot-detail-title')?.focus({ preventScroll: true });
  }
  function closeDetail() { root?.querySelector('#bot-detail')?.close(); }
  async function openConversation(id, options = {}) {
    if (busy || window.PAChat.isBusy()) return;
    const ticket = generation, selection = selected, previousConversation = activeConversation;
    let resolvedRoom = false;
    busy = true; failedSelection = ''; renderList(); notice('');
    try {
      let conversation = id && model.conversations.find(value => value.id === id);
      if (conversation?.resolvedConversationId) conversation = model.rooms?.find(value => value.id === conversation.resolvedConversationId) || model.conversations.find(value => value.id === conversation.resolvedConversationId) || conversation;
      if (!conversation) {
        conversation = (model.rooms || []).find(room => selection === 'group' ? room.kind === 'group' : room.kind === 'direct' && room.botId === selection);
        conversation ||= await api('hub', { operation: 'open-room', kind: selection === 'group' ? 'group' : 'direct', ...(selection !== 'group' && { botId: selection }) });
      }
      if (!root || ticket !== generation) return;
      resolvedRoom = true;
      const roomKind = conversation.kind || conversation.roomKind;
      const host = root.querySelector('#bot-chat-root');
      const newMount = !host.querySelector('.chat-center');
      if (newMount) window.PAChat.mount({ root: host, api, view: 'conversation', conversationId: conversation.id, roomKind, onConversation: value => { if (value && ticket === generation && root?.querySelector('#bot-chat-root') === host) activeConversation = value.id; }, onItemSaved: () => {} });
      await window.PAChat.open({ conversationId: conversation.id, botId: selection === 'group' ? 'xiaoman' : selection, roomKind, example: options.example, draft: options.draft, sourceRefs: options.sourceRefs, guideSourceId: options.guideSourceId, messageId: options.messageId });
      if (!root || ticket !== generation) return;
      const changed = previousConversation !== conversation.id;
      activeConversation = conversation.id; activeSelection = selection;
      // Commit the identity together with the newly loaded conversation. The
      // directory's metadata refresh must not leave the previous Bot above it.
      busy = false; renderList(); void refresh();
      if (changed || newMount) window.PAMotion?.play(host, 'page');
    } catch (error) { if (ticket === generation) { failedSelection = selection; if (!resolvedRoom && activeConversation) selected = activeSelection; showError(error); } }
    finally { if (ticket === generation && root) { busy = false; renderList(); } }
  }
  function editBot(id) {
    notice('');
    const bot = model.bots.find(value => value.id === id) || { name: '', handle: '', instructions: '', avatar: 'steward', active: true, endpointId: null };
    editing = false;
    const host = root.querySelector('#bot-editor');
    host.innerHTML = `<form id="bot-form" data-id="${esc(bot.id || '')}" data-version="${bot.version || 0}"><div class="section-head"><h2>${bot.id ? esc(bot.name) : '新建 Bot'}</h2>${avatar(bot)}</div><div class="bot-form-pair"><label>名字<input name="name" required maxlength="24" value="${esc(bot.name)}" autocomplete="off"></label><label>@标识<input name="handle" required pattern="[a-z][a-z0-9_-]{1,31}" maxlength="32" value="${esc(bot.handle)}" autocomplete="off"></label></div><fieldset class="bot-faces"><legend>头像</legend>${faces.map(face => `<label><input type="radio" name="avatar" value="${face}" ${bot.avatar === face ? 'checked' : ''}>${avatar({ avatar: face })}<span class="sr-only">${({ steward: '书签', research: '放大镜', planner: '日历', maker: '积木' })[face]}</span></label>`).join('')}</fieldset><label>职责<textarea name="instructions" rows="5" required maxlength="4000">${esc(bot.instructions)}</textarea></label><details class="bot-execution"><summary><svg class="bot-disclosure" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>执行方式<span>${esc(bot.provider === 'dsh' || !bot.provider ? 'DSH' : bot.provider)}</span></summary><label>连接<select name="endpointId"><option value="">DSH（默认）</option>${model.endpoints.filter(endpoint => endpoint.active || endpoint.id === bot.endpointId).map(endpoint => `<option value="${esc(endpoint.id)}" ${bot.endpointId === endpoint.id ? 'selected' : ''}>${esc(endpoint.label)} · ${esc(endpoint.provider)}${endpoint.active ? '' : ' · 已停用'}</option>`).join('')}</select></label></details>${bot.id ? `<div class="bot-enabled-row"><label class="bot-enabled"><input type="checkbox" name="active" ${bot.active ? 'checked' : ''} ${bot.id === 'xiaoman' ? 'disabled' : ''}>启用${bot.id === 'xiaoman' ? '（总管）' : ''}</label><p class="note">修改会停止在途任务；停用还会暂停巡查。</p></div>` : ''}<div class="actions"><button class="primary" type="submit">${bot.id ? '保存' : '创建'}</button>${bot.id && bot.active ? bot.connected ? '<button type="button" class="outline" data-bot-talk>聊天</button>' : '<button type="button" class="outline" data-bot-connect>连接执行端</button>' : ''}</div></form>`;
    window.PAMotion?.play(host, 'page');
    if (!bot.id) host.querySelector('[name=name]').focus();
  }
  async function click(event) {
    const summary = event.target.closest('summary');
    if (summary && root?.contains(summary) && window.PAMotion) { event.preventDefault(); event.stopPropagation(); window.PAMotion.toggle(summary.parentElement); return; }
    const button = event.target.closest('button'); if (!button) return;
    if (button.id === 'bot-detail-close') { closeDetail(); return; }
    if (button.dataset.botDetail) { openDetail(button.dataset.botDetail, button); return; }
    if (busy) return;
    if (button.dataset.botSettings) { closeDetail(); await navigate({ page: 'settings', section: 'bots', botId: button.dataset.botSettings }); return; }
    if (button.dataset.botTask) { const task = model.rootTasks?.find(value => value.id === button.dataset.botTask); if (task) { closeDetail(); await navigate({ page: 'chat', conversationId: task.conversationId, messageId: task.messageId }); } return; }
    if (button.dataset.bot) {
      if (editing && !confirm('放弃未保存的修改？')) return;
      if (window.PAChat.isBusy()) return;
      const nextBot = button.dataset.bot;
      if (mode === 'settings') { selected = nextBot; editBot(selected); }
      else if (selected !== nextBot || !activeConversation) { failedSelection = ''; await navigate({ page: 'chat', botId: nextBot }); }
      renderList();
    } else if (button.id === 'bot-create') { if (!editing || confirm('放弃未保存的修改？')) { selected = ''; editBot(); renderList(); } }
    else if (button.id === 'bot-connect') await navigate({ page: 'settings', section: 'bots', botId: selected === 'group' ? 'xiaoman' : selected });
    else if (button.hasAttribute('data-bot-connect')) await navigate({ page: 'settings', section: 'agent' });
    else if (button.hasAttribute('data-bot-talk')) await navigate({ page: 'chat', botId: selected });
    else if (button.dataset.botItem) { closeDetail(); await navigate({ page: 'journal', itemId: button.dataset.botItem }); }
    else if (button.id === 'bots-retry') { if (await refresh() && mode === 'chat') { if (failedSelection) selected = failedSelection; await openConversation(); } }
  }
  async function submit(event) {
    if (event.target.id !== 'bot-form') return;
    event.preventDefault(); if (busy) return;
    const form = event.target, values = Object.fromEntries(new FormData(form));
    values.active = form.dataset.id === 'xiaoman' || !form.dataset.id || form.elements.active.checked;
    values.endpointId ||= null;
    busy = true; form.querySelector('button[type=submit]').disabled = true;
    try {
      const bot = await api('hub', { operation: 'save-bot', ...(form.dataset.id && { id: form.dataset.id, version: Number(form.dataset.version) }), values });
      if (!root || !form.isConnected) return;
      editing = false; selected = bot.id; await refresh(); editBot(bot.id); notice('已保存');
    } catch (error) { showError(error); } finally { busy = false; if (form.isConnected) form.querySelector('button[type=submit]').disabled = false; }
  }
  function input(event) { if (event.target.closest('#bot-form')) editing = true; }
  async function selectRoute(options, version) {
    const ticket = generation;
    let explicit = options.conversationId && model.conversations.find(value => value.id === options.conversationId);
    if (!explicit && options.conversationId && options.messageId) {
      try {
        const result = await api('hub/message?messageId=' + encodeURIComponent(options.messageId));
        if (!root || ticket !== generation || version !== routeVersion) return;
        if (result.conversation && (result.conversationId === options.conversationId || result.message?.sourceRef?.conversationId === options.conversationId || result.resolvedConversationId === options.conversationId)) { explicit = result.conversation; model.conversations.push(explicit); }
      } catch { /* Keep an unavailable exact target; never open a fallback room. */ }
    }
    if (!root || ticket !== generation || version !== routeVersion) return;
    if (options.conversationId && !explicit) { notice('这段原对话已不可用，未跳到其他聊天。', true); return; }
    const next = explicit ? (explicit.kind || explicit.roomKind) === 'group' ? 'group' : options.botId || explicit.botId || 'xiaoman' : options.botId || selected;
    if (failedSelection === next && !options.messageId && !options.draft && !options.example) return;
    if (next !== selected || explicit && explicit.id !== activeConversation) closeDetail();
    selected = next;
    await openConversation(explicit?.id, options);
  }
  async function mount(options) {
    if (root === options.root && mode === options.mode) {
      api = options.api; navigate = options.navigate;
      if (busy || window.PAChat.isBusy()) return;
      const unchanged = (!options.botId || options.botId === selected) && (!options.conversationId || options.conversationId === activeConversation);
      if (unchanged && !options.messageId && !options.example && !options.draft) return;
      const version = ++routeVersion, ticket = generation;
      if (!model) await refresh();
      if (!root || ticket !== generation || version !== routeVersion || !model) return;
      if (mode === 'settings') { selected = options.botId || selected; editBot(selected); renderList(); }
      else await selectRoute(options, version);
      if (root && ticket === generation && version === routeVersion && !timer) timer = setInterval(() => { if (!busy) void refresh(); }, 4000);
      return;
    }
    unmount(); root = options.root; api = options.api; navigate = options.navigate; mode = options.mode; const ticket = generation, version = ++routeVersion;
    selected = options.botId || (mode === 'settings' ? 'xiaoman' : 'group'); activeConversation = '';
    root.innerHTML = `<section class="bots-workspace ${mode === 'settings' ? 'bots-settings' : 'bots-chat'}"><aside class="bots-sidebar"><div class="section-head">${mode === 'settings' ? '' : '<h2>聊天</h2>'}${mode === 'settings' ? '<button class="text" id="bot-create" type="button">新建</button>' : ''}</div><div id="bots-list"><p class="note">读取中…</p></div></aside><div class="bots-content">${mode === 'settings' ? '<div id="bot-editor"></div>' : '<header class="bot-chat-head"><div id="bot-chat-identity"><h1 id="bot-chat-title" tabindex="-1">聊天</h1></div><button class="outline" type="button" id="bot-connect" hidden>连接</button></header><div id="bot-chat-root"><div class="bot-empty">读取中…</div></div><dialog id="bot-detail" class="bot-detail" aria-labelledby="bot-detail-title"><button type="button" class="bot-detail-close" id="bot-detail-close" aria-label="关闭详情"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button><div id="bot-detail-body"></div></dialog>'}<div class="bots-status" hidden><p id="bots-status" role="status" aria-live="polite"></p><button class="text" id="bots-retry" type="button" hidden>重试</button></div></div></section>`;
    root.querySelector('#bot-detail')?.addEventListener('close', () => { detailBotId = null; const target = detailOpener?.isConnected ? detailOpener : root?.querySelector('.bot-identity-button'); target?.focus({ preventScroll: true }); detailOpener = null; });
    root.addEventListener('click', click); root.addEventListener('submit', submit); root.addEventListener('input', input);
    await refresh(); if (!root || ticket !== generation || version !== routeVersion || !model) return;
    if (mode === 'settings') editBot(selected);
    else await selectRoute(options, version);
    if (!root || ticket !== generation || version !== routeVersion) return;
    timer = setInterval(() => { if (!busy) void refresh(); }, 4000);
  }
  function unmount() {
    clearInterval(timer); timer = null; generation++; routeVersion++;
    if (mode === 'chat' && root) window.PAChat.unmount();
    root?.removeEventListener('click', click); root?.removeEventListener('submit', submit); root?.removeEventListener('input', input);
    detailBotId = null; detailOpener = null; failedSelection = ''; root = null; model = null; busy = false; editing = false;
  }
  // Shared composer enhancement. It never changes selection or sends; insertion
  // triggers the composer's own draft persistence and keyboard behavior.
  function mentions(input) {
    if (!input) return;
    input.setAttribute('aria-controls', input.id + '-mentions'); input.setAttribute('aria-autocomplete', 'list');
    const existing = mentionMenus.get(input);
    // The first-task composer reconciles its DOM while saving drafts. Reuse the
    // same menu and listeners if that reconciliation detached the enhancement.
    if (existing) {
      if (!existing.isConnected) input.after(existing);
      input.setAttribute('aria-expanded', String(!existing.hidden));
      const active = existing.querySelector('[aria-selected=true]');
      if (!existing.hidden && active) input.setAttribute('aria-activedescendant', active.id);
      return;
    }
    const list = document.createElement('div'); list.className = 'bot-mentions'; list.hidden = true; list.setAttribute('role', 'listbox'); list.id = input.id + '-mentions';
    mentionMenus.set(input, list);
    input.after(list);
    let candidates = [], at = 0, match, start, revision = 0;
    const close = () => {
      const ticket = ++revision;
      input.removeAttribute('aria-activedescendant'); input.setAttribute('aria-expanded', 'false');
      list.inert = true; list.setAttribute('aria-hidden', 'true');
      if (!list.hidden && window.PAMotion) window.PAMotion.exit(list, () => { if (ticket === revision) list.hidden = true; });
      else list.hidden = true;
    };
    const paint = () => { list.innerHTML = candidates.map((b, i) => `<button id="${list.id}-${i}" type="button" role="option" aria-selected="${i === at}" data-mention="${i}">${avatar(b, { presence: true })}<span>${esc(b.name)}<small>@${esc(b.handle)}${presence(b).state !== 'online' ? ' · ' + esc(presence(b).label) : ''}</small></span></button>`).join(''); input.setAttribute('aria-activedescendant', list.id + '-' + at); };
    const update = async () => {
      const ticket = ++revision;
      const prefix = input.value.slice(0, input.selectionStart); match = prefix.match(/(?:^|[^a-zA-Z0-9._%+@/-])@([\p{L}\p{N}_-]*)$/u);
      if (!match) return close();
      if (!mentionsModel.length || Date.now() - mentionsUpdatedAt > 5000) { try { const r = await window.PATransport.create().api('hub'); mentionsModel = r.bots || []; mentionsUpdatedAt = Date.now(); } catch { return close(); } }
      if (ticket !== revision || !input.isConnected || prefix !== input.value.slice(0, input.selectionStart)) return;
      start = prefix.length - match[1].length - 1;
      candidates = mentionsModel.filter(b => b.active && (b.handle.toLowerCase().includes(match[1].toLowerCase()) || b.name.includes(match[1]))).slice(0, 8);
      if (!candidates.length) return close();
      const opening = list.hidden || list.inert;
      window.PAMotion?.cancel(list);
      at = 0; list.hidden = false; list.inert = false; list.setAttribute('aria-hidden', 'false'); input.setAttribute('aria-expanded', 'true'); paint();
      list.dataset.side = input.form.getBoundingClientRect().top < list.getBoundingClientRect().height + 12 ? 'below' : 'above';
      if (opening) window.PAMotion?.play(list, 'enter');
    };
    const choose = index => { const bot = candidates[index]; if (!bot) return; input.setRangeText('@' + bot.handle + ' ', start, input.selectionStart, 'end'); close(); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); };
    input.addEventListener('input', update);
    input.addEventListener('keydown', e => { if (list.hidden || list.inert) return; if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); if (e.key === 'Escape') close(); else if (e.key === 'Enter') choose(at); else { at = (at + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length; paint(); } } });
    list.addEventListener('mousedown', e => e.preventDefault());
    list.addEventListener('click', e => { const b = e.target.closest('[data-mention]'); if (b) choose(Number(b.dataset.mention)); });
    input.addEventListener('blur', () => setTimeout(close, 100));
  }
  window.PABots = { mount, unmount, mentions, avatar, isBusy: () => busy, isEditing: () => editing };
})();
