(() => {
  'use strict';
  const array = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const providers = { dsh: 'DSH', codex: 'Codex', workbuddy: 'WorkBuddy' };
  const serviceNames = { google: 'Google 套件', files: '本地文件', phone: '手机', github: 'GitHub', x: 'X' };
  const connectionStates = { unlinked: '未连接', setup_required: '需要准备', awaiting_authorization: '待你授权', checking: '正在核对', connected: '已连接', limited: '部分权限可用', expired: '授权已过期', offline: '设备离线', error: '需要检查', revoked: '已撤回', unknown: '状态待更新' };
  const stepNames = ['确认一个 Agent', '选择消息入口', '交代第一件事'];
  const stepLabels = ['确认 Agent', '消息入口', '第一件事'];
  const examples = [
    { id: 'plan', title: '推进一件事', text: '帮我把一件挂心的事拆成今天能开始的第一步，先和我确认目标和限制。' },
    { id: 'outing', title: '出门清单', text: '帮我整理明天出门的清单，先问我目的地、出发时间和需要带的东西。' },
    { id: 'reading', title: '阅读习惯', text: '我想养成阅读习惯，先和我确认每周目标，再做一个简单的打卡手账。' },
  ];
  const errorCode = error => typeof error?.code === 'string' && /^[A-Z_]{3,60}$/.test(error.code) ? error.code : '';
  const errorText = error => errorCode(error) === 'FORBIDDEN' ? '页面会话已失效。刷新页面后继续，草稿不会自动发送。' : error ? text(error.message) || text(error.code) || (typeof error === 'string' ? error : '暂时无法读取，请重试。') : '';
  const timestamp = value => typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(value) || 0;
  const latest = values => [...values].sort((a, b) => timestamp(b.updatedAt || b.finishedAt || b.createdAt) - timestamp(a.updatedAt || a.finishedAt || a.createdAt))[0] || null;
  const evidence = run => run.status === 'completed' && run.report?.outcome === 'completed' ? 'verified' : run.status === 'completed' ? 'replied' : 'unverified';
  function deliveryCounts(hub, channel, conversationIds) {
    const replies = array(hub?.messages).filter(m => m.channel === channel && m.role === 'assistant' && (!conversationIds || conversationIds.has(m.conversationId)));
    const ids = new Set(replies.map(m => m.id)), records = array(hub?.deliveries).filter(d => ids.has(d.id));
    return {
      submittedCount: records.filter(d => d.state === 'submitted').length,
      sentCount: records.filter(d => ['sent', 'delivered', 'read'].includes(d.state)).length,
      deliveredCount: records.filter(d => ['delivered', 'read'].includes(d.state)).length,
    };
  }
  // Pure evidence projection. Heartbeats, permissions and message receipts remain separate.
  function derive({ state = {}, hub = null, connections = null, errors = {} } = {}) {
    state ||= {}; errors ||= {};
    const failures = { hub: errorText(errors.hub), connections: errorText(errors.connections) };
    const errorCodes = { hub: errorCode(errors.hub), connections: errorCode(errors.connections) };
    const hubKnown = !!hub && !failures.hub, connectionsKnown = !!connections && !failures.connections;
    const runs = array(hub?.runs), endpoints = array(hub?.endpoints).filter(e => e.active === true).map(e => {
      const own = runs.filter(r => r.endpointId === e.id), completed = own.filter(r => evidence(r) === 'verified'), replied = own.filter(r => r.status === 'completed');
      return { id: text(e.id), label: text(e.label) || '尚未命名的 Agent', provider: text(e.provider), online: hubKnown && e.online === true, execution: !hubKnown ? 'unverified' : completed.length ? 'verified' : replied.length ? 'replied' : 'unverified', latestRun: latest(completed.length ? completed : replied), unavailable: !hubKnown };
    });
    const roles = hubKnown ? hub.roles || state.agentRouting || {} : state.agentRouting || {};
    const preferred = endpoints.find(e => e.id === roles.conversation) || endpoints.find(e => e.online) || endpoints[0] || null;
    const agents = {
      state: !hubKnown ? 'unknown' : !endpoints.length ? 'missing' : !endpoints.some(e => e.online) ? 'offline' : endpoints.some(e => e.online && e.execution === 'verified') ? 'verified' : 'online',
      endpoints, preferredEndpointId: preferred?.id || '', cliInstalled: state.installed === true,
      cliProvider: text(state.config?.agent?.provider), localSetupAvailable: state.localAgentAvailable === true,
    };
    const im = state.config?.im, runtime = state.runtime;
    const wxConfigured = im?.provider === 'weixin' && im.enabled !== false, wxKnown = !!im && !!runtime;
    const currentLoginPending = ['waiting', 'failed'].includes(state.login?.state);
    const configApplied = state.revision !== undefined && runtime?.configRevision === state.revision;
    const loggedIn = wxKnown && wxConfigured && !currentLoginPending && runtime.state === 'running' && runtime.connected === true && !runtime.connectionError;
    const allowFrom = im?.access_policy === 'allowlist' ? array(im.allow_from) : [];
    const accounts = array(runtime?.accounts).filter(a => !runtime?.account || a.account === runtime.account);
    const peers = accounts.flatMap(a => array(a.users)).filter(u => allowFrom.includes(u.id));
    const lastInboundAt = peers.reduce((at, u) => Math.max(at, Number.isFinite(u.lastInbound) ? u.lastInbound : 0), 0) || null;
    const hasWxInbound = lastInboundAt !== null;
    const wxConversations = new Set(array(hub?.bindings).filter(b => b.channel === 'weixin' && allowFrom.includes(b.peer) && (!runtime?.account || b.account === runtime.account)).map(b => b.conversationId));
    const wxDelivery = hubKnown ? deliveryCounts(hub, 'weixin', wxConversations) : { submittedCount: 0, sentCount: 0, deliveredCount: 0 };
    const weixin = {
      state: im && !wxConfigured ? 'disabled' : !wxKnown || runtime.state === 'unavailable' ? 'unknown' : !loggedIn ? 'not_logged_in' : !configApplied ? 'configuration_pending' : !allowFrom.length ? 'awaiting_identity' : !hasWxInbound ? 'awaiting_inbound' : 'received',
      loggedIn, allowedCount: allowFrom.length, configApplied, loginState: text(state.login?.state), hasInbound: hasWxInbound, lastInboundAt, ...wxDelivery,
      connectionError: text(runtime?.connectionError),
    };
    const messageBridges = array(hub?.channels).filter(c => c.active === true && c.channel === 'imessage');
    const imIds = new Set(messageBridges.map(c => c.id));
    const imConversations = new Set(array(hub?.bindings).filter(b => b.channel === 'imessage' && imIds.has(b.account)).map(b => b.conversationId));
    const imInputs = array(hub?.messages).filter(m => m.channel === 'imessage' && m.role === 'user' && imConversations.has(m.conversationId));
    const hasImInbound = hubKnown && (imInputs.length > 0 || messageBridges.some(c => Number.isFinite(c.lastInboundAt) && c.lastInboundAt > 0));
    const imDelivery = hubKnown ? deliveryCounts(hub, 'imessage', imConversations) : { submittedCount: 0, sentCount: 0, deliveredCount: 0 };
    const imOnline = hubKnown && messageBridges.some(c => c.online === true);
    const imState = !hubKnown ? 'unknown' : !messageBridges.length ? 'unpaired' : imOnline ? hasImInbound && imDelivery.sentCount > 0 ? 'exchanged' : hasImInbound ? 'received' : 'online' : messageBridges.some(c => c.connected && c.error) ? 'needs_attention' : messageBridges.some(c => Number(c.lastSeen) > 0) ? 'offline' : 'paired';
    const imessage = { state: imState, paired: hubKnown && messageBridges.length > 0, online: imOnline, hasInbound: hasImInbound, inboundCount: hubKnown ? imInputs.length : 0, bridgeCount: messageBridges.length, ...imDelivery };
    const j = state.journal, ownerJournal = !!j && (!j.scope || j.scope.account === 'local' && j.scope.userId === 'owner');
    const items = ownerJournal ? array(j.items) : [], designStatus = text(j?.design?.status);
    const roleConfigured = typeof roles.journalDesigner === 'string' && !!roles.journalDesigner;
    const designCurrent = ownerJournal && j.design?.baseRevision === j.revision;
    const designState = !ownerJournal ? 'unavailable' : ['queued', 'running'].includes(designStatus) && designCurrent ? 'running' : designStatus === 'failed' ? 'failed' : j.designAvailable === false || !roleConfigured ? 'unavailable' : designStatus === 'ready' && designCurrent && j.layout?.source === 'agent' ? 'ready' : 'basic';
    const designMessages = {
      running: 'AI 正在整理；已保存的记录可以先用。',
      failed: '自动整理未完成，记录仍在。',
      ready: 'AI 已整理看板，执行结果仍以任务记录为准。',
      basic: '已用基础排版呈现，可继续补充材料。',
      unavailable: roleConfigured ? '设计服务暂不可用，仍可手动记事。' : '尚未绑定专用设计 Agent，仍可手动记事。',
    };
    const hasMaterials = ownerJournal && (array(j.guide?.sources).length > 0 || items.some(item => item.source?.kind === 'automatic' && array(item.taskData?.collection?.entries).length > 0));
    const journal = { hasMaterials, state: !ownerJournal ? 'unknown' : items.length ? 'recorded' : 'empty', count: items.length, latest: latest(items), design: { state: designState, message: designState === 'basic' && j.layout?.source === 'agent' ? '保留已有排版，等待按当前材料整理。' : designMessages[designState], detail: text(j?.design?.error || j?.design?.message || j?.designReason), roleConfigured, current: !!designCurrent, endpointId: text(roles.journalDesigner) } };
    const optional = {
      bridge: { paired: connectionsKnown && connections.bridge?.paired === true, online: connectionsKnown && connections.bridge?.online === true, state: !connectionsKnown ? 'unknown' : connections.bridge?.online && connections.bridge?.paired ? 'online' : connections.bridge?.paired ? 'offline' : 'unpaired', name: text(connections?.bridge?.name) },
      services: Object.entries(serviceNames).map(([id, title]) => {
        const item = array(connections?.items).find(value => value.id === id);
        const permissions = array(item?.permissions).map(p => ({ id: text(p.id), label: text(p.label), granted: p.granted === true, verified: connectionsKnown && ['connected', 'limited'].includes(item?.state) && p.granted === true && p.verified === true }));
        const grantedCount = permissions.filter(p => p.granted).length, verifiedCount = permissions.filter(p => p.verified).length;
        return { id, title, state: connectionsKnown && item ? text(item.state) || 'unknown' : 'unknown', grantedCount, verifiedCount, allVerified: connectionsKnown && ['connected', 'limited'].includes(item?.state) && permissions.length > 0 && permissions.every(p => p.verified), permissions, scopeDescription: text(item?.scopeDescription), message: text(item?.message), stale: !connectionsKnown };
      }),
    };
    return { agents, channels: { web: { state: 'available' }, weixin, imessage }, journal, optional, nextStep: agents.endpoints.some(e => e.online) ? 3 : 1, errors: failures, errorCodes, sessionExpired: Object.values(errorCodes).includes('FORBIDDEN') };
  }
  let root, api, hostState, navigate, hub, connections, failures, model, timer, listeners, generation = 0, refreshing = false, navigating = false, step = 1, selectedAgent = '', selectedChannel = 'web', agentChosen = false, stepChosen = false, initialized = false, signature = '', copyValue = '', copyMessage = '';
  const $ = selector => root?.querySelector(selector);
  const selectedEndpoint = () => model?.agents.endpoints.find(e => e.id === selectedAgent);
  function button(id, label, action, value = '', primary = false, extra = '') {
    return '<button type="button" id="' + esc(id) + '" class="' + (primary ? 'primary' : 'outline') + '" data-on-action="' + esc(action) + '" data-on-value="' + esc(value) + '" ' + (action === 'reload' ? 'data-action="reload" ' : '') + extra + '>' + esc(label) + '</button>';
  }
  const summary = label => '<summary><span>' + esc(label) + '</span><span class="on-expand" aria-hidden="true"></span></summary>';
  function statusLabel(endpoint) {
    if (endpoint.unavailable) return '状态待更新';
    if (!endpoint.online) return '离线';
    return endpoint.execution === 'verified' ? '在线 · 已验证' : '在线 · 待验证';
  }
  const channelLabels = { web: 'Web', weixin: '微信', imessage: 'iMessage' };
  function channelCopy(channel) {
    const c = model.channels[channel];
    if (channel === 'web') return { label: '可用', detail: '在网页编辑草稿，确认后发送。' };
    if (channel === 'weixin') return {
      label: { unknown: '状态待更新', disabled: '尚未启用', not_logged_in: c.loginState === 'waiting' ? '等待这次扫码确认' : c.loginState === 'failed' ? '这次登录未成功' : '等待登录', configuration_pending: '配置已保存 · 等待加载', awaiting_identity: '已登录 · 待确认本人', awaiting_inbound: '已允许 · 等待真实来信', received: '已有真实来信' }[c.state] || '状态待更新',
      detail: c.state === 'received' ? '已收到允许用户的来信；回复发送与送达另看回执。' : c.state === 'configuration_pending' ? '先应用已保存的配置，再核对当前微信身份。' : c.state === 'awaiting_identity' ? '先在连接页核对并允许你的微信身份。' : c.state === 'awaiting_inbound' ? '用已允许的身份发一句话，再核对是否收到。' : '登录与本人确认在连接页完成。',
    };
    return {
      label: { unknown: '状态待更新', unpaired: '尚未配对', paired: '已配对 · 等待 Mac 接入', offline: '已配对 · 收发 Mac 离线', needs_attention: '已连接 · 系统权限待检查', online: '收发桥在线 · 等待来信', received: '已有来信 · 回复待核对', exchanged: '有收信与发送记录' }[c.state] || '状态待更新',
      detail: c.deliveredCount ? c.deliveredCount + ' 条回复有送达或已读回执。' : c.sentCount ? '已有发送记录，暂未取得送达回执。' : '配对、桥在线、实际收信和发送分别核对。',
    };
  }
  function markup() {
    const errors = Object.entries(model.errors).filter(([, value]) => value);
    const agents = model.agents.endpoints, hasMaterials = model.journal.hasMaterials;
    const agentRows = agents.length ? '<ul class="on-connected-agents">' + agents.map(endpoint => '<li><strong>' + esc(endpoint.label) + '</strong><span class="on-state">' + esc(statusLabel(endpoint)) + '</span></li>').join('') + '</ul>' : '<p class="on-note">' + (model.agents.state === 'unknown' ? '处理助手状态待更新' : '处理助手尚未连接') + '</p>';
    const channels = ['weixin', 'imessage'].map(channel => { const info = channelCopy(channel); return '<div class="on-connected-channel"><h3>' + channelLabels[channel] + '</h3><span class="on-state">' + esc(info.label) + '</span>' + button('on-connect-' + channel, channel === 'weixin' ? '连接微信' : '连接 iMessage', channel) + '</div>'; }).join('');
    const error = '<div id="on-read-errors" class="on-read-errors" role="alert" ' + (errors.length ? '' : 'hidden') + '>' + (errors.length ? '<p>' + errors.map(([key, value]) => esc((key === 'hub' ? '消息状态暂不可用' : '连接状态暂不可用') + '：' + value)).join('<br>') + '</p>' + button('on-retry', model.sessionExpired ? '刷新页面继续' : '重试', model.sessionExpired ? 'reload' : 'refresh', '', false, refreshing ? 'disabled' : '') : '') + '</div>';
    return '<section class="onboarding" aria-labelledby="on-title"><h1 id="on-title" class="' + (hasMaterials ? 'on-start-title' : 'on-sr') + '" tabindex="-1">' + (hasMaterials ? '跟进一件事' : '交代一件事') + '</h1>' + error + (hasMaterials ? '<div id="on-journal"></div>' : '') + '<details class="on-compose" id="on-compose" data-secondary="' + hasMaterials + '" ' + (hasMaterials ? '' : 'open') + '>' + summary('自己交代一件事') + '<div id="on-first-task"></div></details><details class="on-connection-settings" id="on-connection-settings">' + summary('连接设置') + '<div class="on-panel" id="on-panel"><div class="on-agent-settings">' + agentRows + button('on-manage-agents', '管理连接', 'agents') + '</div><div class="on-channel-settings">' + channels + '</div></div><button class="text" data-page="connections">账号与设备</button></details></section>';
  }
  function key(node) {
    if (node.nodeType !== 1) return null;
    return node.id || (node.tagName === 'LABEL' && node.querySelector('input[name]') ? 'choice:' + node.querySelector('input').name + ':' + node.querySelector('input').value : null);
  }
  function sync(node, next, preserveAttributes = false) {
    if (node.nodeType === 3) { if (node.data !== next.data) node.data = next.data; return; }
    if (node.nodeType !== 1) return;
    if (node.id === 'on-first-task' || node.id === 'on-journal') return;
    if (!preserveAttributes) {
      for (const a of [...node.attributes]) if (!next.hasAttribute(a.name)) node.removeAttribute(a.name);
      for (const a of next.attributes) if (node.getAttribute(a.name) !== a.value) node.setAttribute(a.name, a.value);
    }
    if (node.tagName === 'INPUT') { node.checked = next.checked; node.disabled = next.disabled; }
    if (node.tagName === 'BUTTON') node.disabled = next.disabled;
    const existing = [...node.childNodes], used = new Set();
    for (const [index, child] of [...next.childNodes].entries()) {
      const identity = key(child);
      const match = identity ? existing.find(n => !used.has(n) && key(n) === identity && n.nodeType === child.nodeType && n.tagName === child.tagName) : existing.find(n => !used.has(n) && !key(n) && n.nodeType === child.nodeType && (n.nodeType !== 1 || n.tagName === child.tagName));
      const result = match || child.cloneNode(true);
      if (match) { used.add(match); sync(match, child); }
      if (node.childNodes[index] !== result) node.insertBefore(result, node.childNodes[index] || null);
    }
    for (const child of existing) if (!used.has(child)) child.remove();
  }
  function paint({ transition = false, focus = false } = {}) {
    if (!root) return;
    const html = markup(); if (html === signature && !focus) return;
    const focused = document.activeElement, focusId = focused?.id, focusedChoice = focused?.name && focused?.value;
    const opened = new Set([...root.querySelectorAll('details[open]')].map(n => n.id));
    const next = document.createElement('div'); next.innerHTML = html;
    if ($('#on-journal') && !next.querySelector('#on-journal')) window.PAJournal.unmount();
    sync(root, next, true);
    for (const id of opened) { const node = [...root.querySelectorAll('details')].find(d => d.id === id); if (node) node.open = true; }
    signature = html;
    const journal = $('#on-journal');
    if (journal && !journal.querySelector('.journal')) window.PAJournal.mount({ root: journal, api, navigate, snapshot: hostState.journal, guideOnly: true });
    if (window.PAFirstTask) window.PAFirstTask.mount({ root: $('#on-first-task'), api, navigate });
    if (focus) $('#on-title')?.focus({ preventScroll: true });
    else if (root.contains(focused) || focused?.isConnected === false) {
      const candidate = focusId ? [...root.querySelectorAll('[id]')].find(n => n.id === focusId) : focusedChoice ? [...root.querySelectorAll('input[name]')].find(n => n.name === focused.name && n.value === focused.value) : null;
      if (candidate && !candidate.disabled && (document.activeElement === document.body || document.activeElement === focused)) candidate.focus({ preventScroll: true });
      else if (document.activeElement === document.body) ($('#on-title') || $('#ft-title'))?.focus({ preventScroll: true });
    }
    const reduced = ['off', 'reduced'].includes(document.documentElement.dataset.motion) || matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (transition && !reduced) $('#on-panel')?.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.75,.25,1)' });
    for (const b of root.querySelectorAll('[data-on-action=refresh]')) b.disabled = refreshing;
  }
  function rebuild() {
    model = derive({ state: hostState, hub, connections, errors: failures });
    if (model.sessionExpired) clearInterval(timer);
    if (!agentChosen) selectedAgent = model.agents.preferredEndpointId;
  }
  async function refresh() {
    if (!root || refreshing || model?.sessionExpired) return;
    const token = generation;
    refreshing = true; paint();
    const read = async name => {
      try {
        const value = await api(name);
        if (!root || token !== generation) return;
        if (name === 'hub') hub = value; else connections = value;
        failures[name] = '';
      } catch (error) { if (!root || token !== generation) return; failures[name] = { code: errorCode(error), message: errorText(error) }; }
      rebuild();
      if (name === 'hub' && !initialized) { initialized = true; if (!stepChosen) step = model.nextStep; }
      paint();
    };
    await Promise.allSettled([read('hub'), read('connections')]);
    if (root && token === generation) { refreshing = false; paint(); }
  }
  async function go(route) {
    if (!root || navigating) return;
    const token = generation; navigating = true;
    try { await navigate(route); }
    catch (error) { if (root && token === generation) { const node = document.createElement('p'); node.className = 'on-navigation-error'; node.setAttribute('role', 'alert'); node.textContent = errorText(error); $('#on-title')?.after(node); } }
    finally { if (token === generation) navigating = false; }
  }
  function click(event) {
    const b = event.target.closest('[data-on-action]'); if (!b || b.disabled || navigating) return;
    event.stopPropagation();
    const action = b.dataset.onAction, value = b.dataset.onValue;
    if (action === 'refresh') return void refresh();
    if (action === 'reload') return location.reload();
    if (action === 'agents') return void go({ page: 'chat', section: 'agents', endpointId: selectedAgent });
    if (action === 'weixin') return void go({ page: 'connections', section: 'weixin' });
    if (action === 'imessage') return void go({ page: 'chat', section: 'imessage' });
    if (action === 'journal' || action === 'journal-new') return void go({ page: 'journal', ...(action === 'journal-new' ? { section: 'add' } : model.journal.latest?.id ? { itemId: model.journal.latest.id } : {}) });
    if (action === 'service') return void go({ page: 'connections', section: value });
  }
  function change(event) {
    const input = event.target;
    if (input.name === 'on-agent') { selectedAgent = input.value; agentChosen = true; paint(); }
    if (input.name === 'on-channel') { selectedChannel = input.value; copyValue = ''; copyMessage = ''; paint(); }
  }
  function mount(options) {
    if (root === options.root && root.querySelector('.onboarding')) return update(options.state);
    unmount(); root = options.root; api = options.api; hostState = options.state || {}; navigate = options.navigate;
    hub = null; connections = null; failures = {}; step = 1; selectedAgent = ''; selectedChannel = 'web'; agentChosen = false; stepChosen = false; initialized = false; signature = ''; copyValue = ''; copyMessage = ''; listeners = new AbortController(); generation++;
    rebuild(); paint();
    root.addEventListener('click', click, { signal: listeners.signal }); root.addEventListener('change', change, { signal: listeners.signal });
    timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    void refresh();
  }
  function update(state) { if (!root) return; hostState = state || {}; rebuild(); paint(); }
  function unmount() { if (root?.querySelector('#on-journal')) window.PAJournal?.unmount(); window.PAFirstTask?.unmount(); generation++; clearInterval(timer); listeners?.abort(); root = null; hub = null; connections = null; failures = {}; model = null; refreshing = false; navigating = false; signature = ''; }
  window.PAOnboarding = { mount, update, unmount, isBusy: () => window.PAFirstTask?.isBusy() === true || !!root?.querySelector('#on-journal') && window.PAJournal?.isBusy(), isEditing: () => window.PAFirstTask?.isEditing() === true || !!root?.querySelector('#on-journal') && window.PAJournal?.isEditing(), flushDraft: () => window.PAFirstTask?.flushDraft(), derive };
})();

