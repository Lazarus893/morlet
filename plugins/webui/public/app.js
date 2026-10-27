(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const main = $('#main');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cores = { dsh: 'DSH', codex: 'Codex CLI', workbuddy: 'WorkBuddy' };
  const errors = { FORBIDDEN: '页面会话已失效，请刷新后重试。', VERSION_CONFLICT: '生活记录已在别处更新，草稿已保留。', DESIGN_UNAVAILABLE: '设计服务尚未就绪，生活记录仍可查看与修改。', DESIGN_ALREADY_RUNNING: '正在整理看板，请稍候查看结果。', JOURNAL_CAPACITY_REACHED: '手账已达到容量限制，请先整理不再需要的记录。', INVALID_REQUEST: '请检查生活记录的内容与格式。', INVALID_SCOPE: '这份手账不可访问，请重新选择用户。', INVALID_LAYOUT: '展示方案未通过校验，保留现有排版。', ITEM_NOT_FOUND: '这条生活记录已不存在。', STALE_DESIGN: '记录已经更新，当前展示方案已过期。', STORAGE_BUSY: '生活账本正在保存其他修改，请稍候重试。', AUTO_LAYOUT_PAUSED: '自动布局已暂停，请先在看板偏好中恢复。', CONFLICT: '内容已在别处更新。你的输入还在，请重新载入后核对再保存。', ACCOUNT_CHANGED: '微信账号已变化，请刷新后重新选择用户。', INVALID_INPUT: '请检查填写的内容、时间及数值范围。', GLOBAL_DISABLED: '请先开启全局主动跟进，再恢复此用户的提醒。', CONTROL_TIMEOUT: '本地服务响应超时，结果可能已生效。请先刷新核对，不要重复提交。', OFFLINE: 'PA 尚未运行，请先启动本地服务。', CONTROL_FAILED: '运行中的服务无法提供管理接口，请更新并重启 PA。', UNAVAILABLE: '暂时无法完成，请检查本地服务后重试。', CONFIG_UNAVAILABLE: '无法读取或写入配置，请检查本机配置文件及权限。', CONFIG_TIMEOUT: '配置操作超时，请刷新核对是否已保存。', LEDGER_BUSY: '跟进台账正由另一个进程管理，请更新并重启该 PA 后再试。', INVALID_STATE: '这条事项的状态已变化，当前操作不再适用。', PAST_DEADLINE: '延后时间超过了事项截止时间，请选择更早的时间。', USER_NOT_FOUND: '这个用户尚未建立跟进记录，或已经取消配对。', TASK_NOT_FOUND: '事项已不存在，请刷新列表。', ALREADY_RUNNING: '服务已经运行，或控制接口暂时不可用。', NOT_OWNED: '这个服务由其他终端启动，请在原终端停止。', DEPENDENCIES_MISSING: '本机依赖不完整，请先运行 ./scripts/pa.sh setup，并安装选中的 CLI。', LOGIN_FAILED: '二维码获取失败，请检查服务及网络后重试。', BUSY: '上一项连接操作尚未完成，请稍候。', TASK_LIMIT: '待处理事项已达到 100 件，请先结束不再需要的跟进。', IM_DISABLED: '请先启用微信并应用配置。' };
  Object.assign(errors, {
    INVALID_TASK_DATA: '请校对这件事的材料与数值，草稿已保留。',
    INVALID_WIDGET: '这张组件的类型已变化，请刷新核对。',
    INVALID_WIDGET_ACTION: '当前组件无法执行这个动作，请核对最新记录。',
    BUDGET_EXCEEDED: '预留金额超过剩余预算，请减少金额或校对预算。',
    MISSING_BUDGET: '先补总预算，再记录预留金额。',
    CANDIDATE_CONSTRAINT: '这个候选尚未满足已记录的条件，请先核对。',
    SLOT_UNAVAILABLE: '这个时间与已有安排或缓冲冲突，请选其他时间。',
    DEADLINE_EXCEEDED: '安排时间超过截止时间，请选择更早的时间。',
    MISSING_DEADLINE: '先补截止时间，再保存提前安排。',
    PAST_SCHEDULE: '安排时间已经过去，请选择未来的时间。',
    FUTURE_CHECK_IN: '只能补记今天或过去的完成记录。',
    FUTURE_EVIDENCE: '回执时间不能晚于当前时间，请校对。',
    MISSING_BASE_SERVINGS: '先补食谱的基础人数，再换算份量。',
    MISSING_APPROVAL_FACTS: '日期、人数或对象仍待核对，请补齐后确认。',
  });
  const pages = new Set(['journal', 'settings']);
  // Published links migrate to the two current destinations; there are no legacy page renderers.
  const destination = name => ['settings', 'connections', 'prefs', 'tasks'].includes(name) ? 'settings' : 'journal';
  let journalMode = location.hash === '#journal/start' ? 'start' : 'book';
  const initialPage = location.hash.slice(1).split('/')[0];
  let initialJournalItem;
  try { if (initialPage === 'journal' && journalMode === 'book') initialJournalItem = decodeURIComponent(location.hash.slice(1).split('/')[1] || ''); } catch { /* Ignore malformed links. */ }
  if (initialJournalItem?.length > 128) initialJournalItem = null;
  let state, page = destination(initialPage), selected = '', dirty = false, busy = false, refreshing = false, toastTimer;
  let doctorResult, deviceResult;
  let sessionExpired = false;
  let navigationChoice;
  let lastEditingControl;
  let activeRoute = pages.has(initialPage) ? location.hash : '#' + page;
  history.replaceState(null, '', activeRoute);
  const dirtyForms = new Set();
  function clearDraft(id) { if (id) dirtyForms.delete(id); else dirtyForms.clear(); dirty = dirtyForms.size > 0; }
  function drafts(scope) { return [...scope.querySelectorAll('form')].filter(f => dirtyForms.has(f.id)).map(f => ({ id: f.id, data: { ...f.dataset }, values: [...f.querySelectorAll('input,select')].map(i => ({ id: i.id, value: i.value, checked: i.checked })) })); }
  function restoreDrafts(saved) { for (const f of saved) { const form = document.getElementById(f.id); if (!form) continue; Object.assign(form.dataset, f.data); for (const v of f.values) { const input = document.getElementById(v.id); if (input) { input.value = v.value; if (input.type === 'checkbox') input.checked = v.checked; } } } }
  const users = () => state.runtime.accounts.flatMap(a => a.users.map(user => ({ ...user, account: a.account, live: a.live })));
  const user = () => users().find(u => `${u.account}:${u.id}` === selected);
  function chooseUser() { if (dirty && selected) return; const list = users(); if (!list.some(u => `${u.account}:${u.id}` === selected)) selected = list[0] ? `${list[0].account}:${list[0].id}` : ''; }
  function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; toastTimer = setTimeout(() => { $('#toast').textContent = ''; }, 6500); }
  const client = window.PATransport.create({
    getCSRF: () => state?.csrf || '', errors,
    onSession: fresh => { state = fresh; sessionExpired = false; },
  });
  async function api(path, data) {
    try { const result = await client.api(path, data); if (path === 'state' && data === undefined) sessionExpired = false; return result; }
    catch (error) { if (error.code === 'FORBIDDEN') sessionExpired = true; throw error; }
  }

  async function refresh(renderPage = true) {
    if (refreshing) return;
    refreshing = true;
    try { state = await api('state'); chooseUser(); $('#header-status').hidden = true; if (renderPage && !(page === 'settings' && (window.PAConnections.isEditing() || window.PAConnections.isBusy() || window.PAChat.isEditing() || window.PAChat.isBusy()))) render(); return true; }
    catch (e) {
      $('#header-status').textContent = '连接中断'; $('#header-status').hidden = false;
      if (!state) main.innerHTML = `<section class="empty"><h1>连接中断</h1><p>${esc(e.message)}</p><div class="actions"><button class="primary" data-action="refresh">重新连接</button></div></section>`;
      else if (renderPage) toast(e.message);
      return false;
    } finally { refreshing = false; main.setAttribute('aria-busy', 'false'); }
  }
  function heading(title, description = '') { return `<div class="page-head"><h1 tabindex="-1">${title}</h1>${description ? `<p>${description}</p>` : ''}</div>`; }
  function picker() { const list = users(); return list.length > 1 ? `<div class="account-picker field"><label for="account">正在管理的微信用户</label><select id="account">${list.map(u => `<option value="${esc(u.account + ':' + u.id)}" ${selected === u.account + ':' + u.id ? 'selected' : ''}>${esc(u.id)} · 账号 ${u.account.slice(0, 8)}${u.live ? '' : ' · 离线'}</option>`).join('')}</select></div>` : ''; }
  function field(id, label, value, type = 'text', attrs = '') { return `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${attrs}></div>`; }
  function select(id, label, value, choices) { return `<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${id}">${choices.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>`; }
  function personalPrefs() {
    const p = state.personalNotices;
    if (!p?.channelId) return '';
    const w = p.worker, lastScan = w?.lastScanAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: p.timezone, hour: '2-digit', minute: '2-digit' }).format(w.lastScanAt) : null;
    const problem = w?.state === 'error' ? ({ AGENT_MODEL_UNAVAILABLE: '分析模型不可用，请检查 Agent 设置。', AGENT_AUTH_REQUIRED: '分析账号需要重新登录。', AGENT_RATE_LIMITED: '分析额度受限，恢复后重试。', AGENT_TIMEOUT: '分析超时，将按计划重试。', BRIDGE_NETWORK_UNAVAILABLE: 'Mac 连接中断，恢复后重试。' })[w.diagnostic?.code] || '整理未完成，将按计划重试。' : '';
    const recent = p.notices.findLast(n => n.channelId === p.channelId), delivery = { pending: '等待发送', sending: '发送中', submitted: '已提交', sent: '已发送', delivered: '已送达', read: '已读', unknown: '结果待核对', cancelled: '已取消', failed: '未发送成功' };
    return `<details class="panel" ${problem ? 'open' : ''}><summary>${p.channel === 'desktop-pet' ? '桌面小满' : 'iMessage'}通知 · ${p.enabled ? '已开启' : '已暂停'}</summary><div class="section-head"><p class="note">${p.channelReady ? '已连接' : '等待 Mac 上线'}</p><button class="outline" data-action="personal-toggle">${p.enabled ? '暂停推送' : '恢复推送'}</button></div>${p.trial ? `<p class="note">临时设置至 ${esc(new Intl.DateTimeFormat('zh-CN', { timeZone: p.timezone, month: 'numeric', day: 'numeric' }).format(p.trial.endsAt))}，之后恢复低频。</p>` : ''}${problem ? `<p class="error" role="status">${esc(problem)}</p>` : ''}${lastScan || recent ? `<p class="note">${lastScan ? `上次检查 ${esc(lastScan)}` : ''}${recent ? `${lastScan ? ' · ' : ''}最近通知${esc(delivery[recent.state] || '状态待核对')}` : ''}</p>` : ''}</details>`;
  }
  function preferences() {
    const u = user(), p = u?.preferences || state.config.proactive, shared = state.truth?.reachOut?.policy;
    const sharedForm = shared ? `<form class="panel" id="reach-out-form" data-revision="${shared.revision}">${select('reach-mode', '主动提醒', shared.mode, [['Off', '关闭'], ['Digest', '摘要'], ['Gentle', '仅重要事项'], ['Active', '积极跟进']])}<div class="two-fields">${field('reach-daily', '每天最多（条）', shared.max_daily, 'number', 'min="1" max="20" required')}${field('reach-gap', '至少间隔（分钟）', shared.min_gap_minutes, 'number', 'min="5" max="1440" required')}</div><div class="two-fields">${field('reach-start', '免打扰 · 从', shared.quiet_start, 'time', 'required')}${field('reach-end', '免打扰 · 到', shared.quiet_end, 'time', 'required')}</div><p class="note">${esc(shared.timezone)}${shared.trial ? ' · 保存后结束临时设置。' : ''}</p><div class="actions"><button class="primary" type="submit">保存</button></div></form>` : '';
    return sharedForm + personalPrefs() + '<details class="panel"><summary>微信提醒</summary>' + picker() + `<section class="preference-group"><div class="section-head"><h2>主动提醒</h2><button class="outline" data-action="global-toggle" id="global-toggle">${state.config.proactive.enabled ? '关闭主动跟进' : '开启主动跟进'}</button></div></section><form class="preference-group" id="prefs-form" data-account="${esc(u?.account || '')}" data-user="${esc(u?.id || '')}" data-revision="${u ? u.revision : state.revision}"><h2>${u ? '当前联系人' : '默认设置'}</h2>${u ? `<div class="field"><label class="checkbox-label" for="pref-enabled"><input id="pref-enabled" type="checkbox" ${p.enabled ? 'checked' : ''} ${!state.config.proactive.enabled ? 'disabled' : ''}>允许提醒这位联系人</label></div>` : ''}${select('max-daily', '每天最多', p.max_daily, Array.from({ length: 10 }, (_, i) => [i + 1, `${i + 1} 条`]))}<div class="two-fields">${field('quiet-start', '免打扰 · 从', p.quiet_start, 'time', 'required')}${field('quiet-end', '免打扰 · 到', p.quiet_end, 'time', 'required')}</div><p class="note">${esc(p.timezone === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : p.timezone)} · 定时提醒也受免打扰限制。</p><div class="two-fields">${field('min-gap', '至少间隔（分钟）', p.min_gap_minutes, 'number', 'min="5" max="1440" required')}${field('max-chars', '单条最长（字）', p.max_chars, 'number', 'min="100" max="500" required')}</div><p class="form-status" id="prefs-status" role="status"></p><div class="actions"><button class="primary" type="submit" id="save-prefs">保存</button><button type="button" class="text" data-action="reload-form">重新载入</button></div></form></details>`;
  }
  function configState() {
    const r = state.runtime;
    return `<div class="config-state"><p class="${r.configRevision === state.revision ? 'note' : 'saved-note'}">${r.state === 'running' && r.configRevision === state.revision ? '设置已生效。' : r.state === 'offline' ? '已保存，下次启动生效。' : '已保存，等待生效。'}</p>${r.state !== 'offline' && r.configRevision !== state.revision ? '<button class="text" data-action="apply">重新应用</button>' : ''}</div>`;
  }
  function connections() {
    const cfg = state.config, r = state.runtime;
    const hostOn = r.state === 'running' || (r.owned && ['running', 'starting'].includes(r.processState));
    return heading('设置') + '<div class="settings-columns"><section><h2>服务与设备</h2><div id="connections-root"></div></section><div id="hub-settings-root"></div></div><details class="panel" id="notification-settings"><summary>提醒偏好</summary>' + preferences() + '</details>' + '<details class="runtime-settings panel" id="runtime-settings"><summary>运行设置</summary>' + window.PATruth.details(state.truth) + `<section class="panel" id="service-setup"><div class="section-head"><h2>本地服务</h2><span class="tag ${hostOn ? '' : 'warn'}">${hostOn ? '正在运行' : r.state === 'unavailable' ? '管理接口不可用' : '未运行'}</span></div>${r.processState === 'failed' ? `<p class="error">启动失败（${esc(r.processExit ?? '未知')}）。请检查运行日志。</p>` : ''}<div class="actions">${!hostOn && r.state === 'offline' ? '<button class="primary" data-action="start" id="start-service">启动本地服务</button>' : ''}${r.owned || r.managed && state.service?.desired !== 'stopped' ? '<button class="outline" data-action="stop" id="stop-service">停止本地服务</button>' : ''}<button class="outline" data-action="refresh">刷新状态</button></div>${configState()}</section><form id="agent-form" class="panel" data-revision="${state.revision}"><div class="section-head"><h2>本地 Agent</h2><span class="tag ${state.installed ? '' : 'warn'}">${esc(cores[cfg.agent.provider])} · ${state.installed ? '已找到' : '未找到'}</span></div>${field('owner', '小满怎么称呼你', cfg.owner, 'text', 'required maxlength="80"')}${state.agentRouting?.conversation ? `<input id="agent-provider" type="hidden" value="${esc(cfg.agent.provider)}">` : select('agent-provider', '思考与处理', cfg.agent.provider, Object.entries(cores))}<details><summary>高级连接设置</summary>${field('agent-command', 'CLI 可执行文件路径（留空自动检测）', cfg.agent.command, 'text', 'maxlength="1024"')}${field('agent-model', '模型名称（留空使用 CLI 默认）', cfg.agent.model, 'text', 'maxlength="120"')}${field('agent-timeout', '单次处理超时（秒）', cfg.agent.timeout_seconds, 'number', 'min="10" max="1800" required')}<p class="note">CLI 登录在本机完成；DSH 路径留空。</p></details><p class="form-status" id="agent-status" role="status"></p><div class="actions"><button class="outline" type="submit" id="save-agent">保存并应用</button><button class="outline" type="button" data-action="doctor" id="doctor">检查连接</button><button class="text" type="button" data-action="reload-form">重新载入</button></div><div class="connection-result" id="doctor-result">${doctorResult ? renderDoctor() : ''}</div></form><section class="panel" id="weixin-setup"><div class="section-head"><h2>微信</h2><span class="tag ${r.connected && !r.connectionError ? '' : 'warn'}">${cfg.im.provider === 'disabled' ? '已停用' : r.connectionError ? '连接异常' : r.connected ? '已登录' : '未连接'}</span></div>${r.connectionError ? '<p class="error">微信连接异常，请检查网络或重新扫码。</p>' : ''}${!r.connected ? '<p class="connection-help">扫码后发一句话，再确认联系人。</p>' : ''}<div class="actions"><button class="${r.connected ? 'outline' : 'primary'}" data-action="login" id="login" ${!hostOn || cfg.im.provider === 'disabled' || state.login?.state === 'waiting' ? 'disabled' : ''}>${r.connected ? '重新扫码登录' : '获取登录二维码'}</button><button class="outline" data-action="im-toggle" id="im-toggle">${cfg.im.provider === 'disabled' ? '启用微信' : '停用微信'}</button></div>${state.login?.state === 'waiting' ? `<img class="qr" src="${esc(state.login.qr)}" alt="微信登录二维码"><p class="note">请扫码确认，二维码 5 分钟内有效。</p>` : state.login?.state === 'failed' ? '<p class="error">本次扫码未完成或已过期，请重新获取二维码。</p>' : state.login?.state === 'connected' ? '<p class="form-status">已登录，请确认联系人。</p>' : ''}<h3 class="detail-label">待确认的用户</h3>${state.pending.length ? `<ul class="plain-list">${state.pending.map((p, i) => `<li><div class="section-head"><div><strong>${esc(p.userId)}</strong><p class="note">来信时间 ${esc(p.receivedAt || '未知')}</p></div><button class="outline" data-action="approve" data-user="${esc(p.userId)}" data-config-revision="${state.revision}" id="approve-${i}">允许联系</button></div></li>`).join('')}</ul>` : '<p class="note">暂无申请。</p>'}<h3 class="detail-label">已允许联系</h3><ul class="plain-list">${(cfg.im.allow_from || []).map((id, i) => `<li><div class="section-head"><span>${esc(id)}</span><button class="text danger" data-action="revoke" data-user="${esc(id)}" data-config-revision="${state.revision}" id="revoke-${i}">取消配对</button></div></li>`).join('') || '<li class="note">尚未配对任何用户。</li>'}</ul>${(cfg.im.allow_from || []).length ? '<p class="note">取消配对将在重连后删除该联系人的提醒记录。</p>' : ''}</section><form id="device-form" class="panel" data-revision="${state.revision}"><h2>移动设备 <span class="subtext">· 可选</span></h2>${select('device-provider', '设备连接方式', cfg.device.provider, [['none', '暂不连接'], ['ios', 'iPhone · WebDriverAgent'], ['android', 'Android · ADB']])}${field('device-id', 'Android 设备 ID', cfg.device.id, 'text', 'maxlength="200"')}${field('wda-url', 'iPhone WDA 地址', cfg.device.wda_url, 'url', 'required')}<details><summary>需要准备什么</summary><p class="note">Android：ADB、USB 调试。iPhone：签名、开发者模式和 WDA。连接检查仅读取状态。</p></details><p class="form-status" id="device-status" role="status"></p><div class="actions"><button class="outline" type="submit" id="save-device">保存并应用</button><button class="outline" type="button" data-action="device" id="device-check">检查设备</button></div><div class="connection-result" id="device-result">${deviceResult ? esc(deviceResult.detail || deviceResult.state) : ''}</div></form><details class="panel"><summary>诊断</summary><ul class="plain-list">${(state.capabilities || []).map(c => `<li>${esc(c.id)} · ${c.available ? '可用' : esc(c.reasons.join('；'))}</li>`).join('')}</ul></details></details>`;
  }
  function updateDeviceFields() { const provider = $('#device-provider')?.value; if (!provider) return; for (const [id, relevant] of [['device-id', provider === 'android'], ['wda-url', provider === 'ios']]) { const input = document.getElementById(id); input.closest('.field').hidden = !relevant; input.required = relevant; } }
  function renderDoctor() { return doctorResult.checks.map(c => `<p class="report-check"><strong>${c.ok ? '通过' : '待处理'}</strong><span>${esc(c.detail)}</span></p>`).join('') + `<p class="note">${esc(doctorResult.note)}</p>`; }
  function render(moveFocus = false) {
    if (!state) return;
    document.body.dataset.page = page;
    for (const button of document.querySelectorAll('#product-nav [data-page]')) button.removeAttribute('aria-current');
    $(`#nav-${page}`)?.setAttribute('aria-current', 'page');
    if (page === 'journal') {
      window.PAConnections.unmount();
      if (journalMode === 'start') {
        if (!main.querySelector('.onboarding')) { window.PAJournal.unmount(); window.PAChat.unmount(); }
        window.PAOnboarding.mount({ root: main, api, state, navigate });
      } else {
        window.PAOnboarding.unmount();
        if (!main.querySelector('.journal')) window.PAChat.unmount();
        window.PAJournal.mount({ root: main, api, navigate, runtime: state.runtime, localAgentAvailable: state.localAgentAvailable, snapshot: state.journal, tasks: users().flatMap(u => u.tasks.map(task => ({ ...task, account: u.account, userId: u.id }))), scopes: users().map(u => ({ scope: { account: u.account, userId: u.id }, label: `微信用户 ${u.id}` })) });
        if (initialJournalItem) { const itemId = initialJournalItem; initialJournalItem = null; void window.PAJournal.openItem(itemId).catch(e => toast(e.message)); }
      }
      if (moveFocus) { main.querySelector('h1')?.focus(); window.scrollTo(0, 0); }
      return;
    }
    window.PAOnboarding.unmount(); window.PAJournal.unmount();
    const focus = document.activeElement?.id, start = document.activeElement?.selectionStart;
    const savedDrafts = drafts(main), details = new Map([...main.querySelectorAll('details[id]')].map(d => [d.id, d.open]));
    const connectionsRoot = $('#connections-root'), hubRoot = $('#hub-settings-root');
    connectionsRoot?.remove(); hubRoot?.remove();
    main.innerHTML = connections();
    if (connectionsRoot) $('#connections-root').replaceWith(connectionsRoot);
    else window.PAConnections.mount({ root: $('#connections-root'), api });
    if (hubRoot) $('#hub-settings-root').replaceWith(hubRoot);
    else window.PAChat.mount({ root: $('#hub-settings-root'), api, runtime: state.runtime, localAgentAvailable: state.localAgentAvailable, view: 'settings' });
    for (const [id, open] of details) { const node = document.getElementById(id); if (node) node.open = open; }
    restoreDrafts(savedDrafts); updateDeviceFields();
    if (moveFocus) { main.querySelector('h1')?.focus(); window.scrollTo(0, 0); }
    else if (focus) { const target = document.getElementById(focus); target?.focus({ preventScroll: true }); if (typeof start === 'number' && target?.type === 'text') target.setSelectionRange(start, start); }
  }
  async function navigate({ page: requestedPage, section, example, endpointId, conversationId, itemId, entryId, newConversation } = {}) {
    if (!requestedPage) return false;
    const nextPage = destination(requestedPage);
    if (busy || window.PAOnboarding.isBusy() || window.PAConnections.isBusy() || window.PAChat.isBusy() || window.PAJournal.isBusy()) { toast('正在处理当前操作，请稍候再切换。'); return false; }
    if (dirty || window.PAOnboarding.isEditing() || window.PAJournal.isEditing() || window.PAConnections.isEditing() || window.PAChat.isEditing()) {
      if (!await confirmNavigation()) return false;
      window.PAChat.discardCurrentDraft();
    }
    page = nextPage; journalMode = requestedPage === 'onboarding' ? 'start' : 'book'; initialJournalItem = null; clearDraft();
    activeRoute = '#' + page + (page === 'journal' ? journalMode === 'start' ? '/start' : itemId ? '/' + encodeURIComponent(itemId) : '' : '');
    history.replaceState(null, '', activeRoute); render(true);
    try {
      if (requestedPage === 'chat' && section) { await navigate({ page: 'settings', section }); return true; }
      if (page === 'journal' && (requestedPage === 'chat' || conversationId || newConversation)) await window.PAJournal.openConversation({ example, endpointId, conversationId, newConversation });
      if (page === 'settings') {
        if (requestedPage === 'prefs') section = 'notifications';
        if (requestedPage === 'tasks') section = 'notifications';
        if (['google', 'files', 'phone', 'github', 'x'].includes(section)) await window.PAConnections.focusCard(section);
        else if (section) {
          const target = $(({ weixin: '#weixin-setup', imessage: '#chat-imessage-setup', agent: '#chat-agent-setup', service: '#service-setup', notifications: '#notification-settings', reminders: '#reminder-records' })[section] || '#connections-root');
          for (let parent = target; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
          target?.scrollIntoView({ block: 'start' }); target?.querySelector('summary,h2')?.focus({ preventScroll: true });
        }
      }
      if (page === 'journal' && itemId) await window.PAJournal.openItem(itemId, entryId);
      if (page === 'journal' && section === 'report') {
        const report = main.querySelector('.journal-workpage:not([hidden]) .journal-followup-report, .journal-workpage:not([hidden]) .journal-guide-next');
        if (report) { if (report.tagName === 'DETAILS') report.open = true; report.scrollIntoView({ block: 'start' }); report.querySelector('summary,button')?.focus({ preventScroll: true }); }
      }
      if (page === 'journal' && section === 'guide') await window.PAJournal.openGuide();
      if (journalMode === 'start' && section === 'compose') await window.PAFirstTask.prefill(example || '');
      if (page === 'journal' && section === 'add') window.PAJournal.startDraft(example);
    } catch (e) { toast(e.message); }
    return true;
  }
  function confirmNavigation() {
    if (navigationChoice) return Promise.resolve(false);
    const prompt = $('#navigation-confirm'), previous = lastEditingControl?.isConnected ? lastEditingControl : document.activeElement;
    $('#navigation-copy').textContent = window.PAChat.hasPendingDownload() ? '连接配置尚未下载。可以先留在这里下载；离开后这个下载入口会关闭。' : '当前输入尚未保存。可以留在这里继续编辑，或放弃后离开。';
    return new Promise(resolve => {
      navigationChoice = value => { navigationChoice = null; prompt.close(); if (!value && previous?.isConnected) previous.focus({ preventScroll: true }); resolve(value); };
      prompt.showModal(); window.PAMotion?.play(prompt, 'enter'); $('#navigation-stay').focus();
    });
  }
  $('#navigation-confirm').addEventListener('cancel', event => { event.preventDefault(); navigationChoice?.(false); });
  window.addEventListener('hashchange', () => {
    const requested = location.hash, [route, encodedItem] = requested.slice(1).split('/');
    let itemId;
    try { if (route === 'journal' && encodedItem && encodedItem !== 'start') itemId = decodeURIComponent(encodedItem); } catch { history.replaceState(null, '', activeRoute); return; }
    if (itemId?.length > 128) { history.replaceState(null, '', activeRoute); return; }
    const nextPage = route === 'journal' && encodedItem === 'start' ? 'onboarding' : route || 'journal';
    if (!state) { page = destination(nextPage); journalMode = nextPage === 'onboarding' ? 'start' : 'book'; initialJournalItem = itemId; activeRoute = '#' + page + (itemId ? '/' + encodeURIComponent(itemId) : ''); history.replaceState(null, '', activeRoute); return; }
    void navigate({ page: nextPage, itemId }).then(moved => { if (!moved && location.hash === requested) history.replaceState(null, '', activeRoute); });
  });
  async function work(button, fn, target) {
    if (busy) return; busy = true;
    const disabled = [...document.querySelectorAll('input,select,button')].map(element => [element, element.disabled]);
    for (const [element] of disabled) element.disabled = true;
    const initial = button?.textContent; if (button) { button.disabled = true; button.textContent = '正在处理…'; }
    const status = target; if (status) { status.classList.remove('alert'); status.textContent = '正在保存，请稍候。'; }
    try { await fn(); }
    catch (e) { if (status?.isConnected) { status.classList.add('alert'); status.textContent = e.message; } else toast(e.message); }
    finally { busy = false; for (const [element, wasDisabled] of disabled) if (element.isConnected) element.disabled = wasDisabled; document.querySelector('[aria-invalid=true]')?.focus(); if (button?.isConnected) { button.disabled = false; button.textContent = initial; } }
  }
  async function saveConfig(patch, revision = state.revision, formId) {
    const saved = await api('config', { patch, revision });
    try { await api('apply', { revision: saved.revision }); }
    catch (e) { e.message = '配置已保存，但应用未确认。' + e.message; throw e; }
    if (formId) clearDraft(formId); await refresh(false); render(); toast('配置已保存。');
  }
  async function taskChange(operation, values, revision = user()?.revision, context, formId) {
    const identity = context || user();
    const u = identity && users().find(u => u.id === identity.id && u.account === identity.account);
    if (!u) throw new Error('原来选择的用户已变化，输入仍保留。请关闭后重新选择用户。');
    await api('tasks', { operation, account: u.account, userId: u.id, revision, ...values });
    if (formId) clearDraft(formId); await refresh(false); render();
    toast('配置已保存。');
  }
  document.addEventListener('input', e => { lastEditingControl = e.target; if (e.target.closest('.journal,.journal-editor,.connections-center,.chat-center,.first-task')) return; const form = e.target.closest('form'); if (form) { dirtyForms.add(form.id); dirty = true; if (e.target.id === 'quiet-start' || e.target.id === 'quiet-end') for (const id of ['quiet-start', 'quiet-end']) document.getElementById(id).removeAttribute('aria-invalid'); } });
  document.addEventListener('change', e => {
    if (e.target.closest('.journal,.journal-editor,.connections-center,.chat-center,.first-task')) return;
    if (e.target.id === 'account') { if (dirty && !confirm('有尚未保存的修改。切换用户并放弃这些修改？')) { e.target.value = selected; return; } selected = e.target.value; clearDraft(); render(); }
    else if (e.target.closest('form')) { dirtyForms.add(e.target.closest('form').id); dirty = true; }
    if (e.target.id === 'agent-provider') $('#agent-command').value = '';
    if (e.target.id === 'device-provider') updateDeviceFields();
  });
  document.addEventListener('click', e => {
    if (e.target.closest('.skip-link')) { e.preventDefault(); main.focus(); main.scrollIntoView({ block: 'start' }); return; }
    if (e.target.closest('[data-navigation-choice]')) { navigationChoice?.(e.target.closest('[data-navigation-choice]').dataset.navigationChoice === 'leave'); return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.openSetting) { void navigate({ page: 'settings', section: b.dataset.openSetting }); return; }
    if (b.dataset.page) {
      void navigate({ page: b.dataset.page, section: b.dataset.section, itemId: b.dataset.journalItem, entryId: b.dataset.journalEntry }); return;
    }
    const action = b.dataset.action; if (!action) return;
    if (action === 'revoke' && !confirm('取消配对后，这位用户将无法联系小满，重新连接后会删除其跟进记录。继续？')) return;
    if (action === 'stop' && !confirm('停止后将无法接收微信或主动提醒。现在停止本地 PA？')) return;
    if (action === 'reload-form' && dirty && !confirm('重新载入会放弃尚未保存的输入。继续？')) return;
    void work(b, async () => {
      if (action === 'refresh' || action === 'reload-form') { if (sessionExpired) { location.reload(); return; } if (action === 'reload-form') clearDraft(); await refresh(!dirty); return; }
      if (action === 'global-toggle') return saveConfig({ proactive: { enabled: !state.config.proactive.enabled } });
      if (action === 'personal-toggle') { await api('personal-notices', { operation: 'configure', enabled: !state.personalNotices.enabled }); await refresh(!dirty); toast('主动关注设置已保存。'); return; }
      if (action === 'im-toggle') return saveConfig({ im: { provider: state.config.im.provider === 'weixin' ? 'disabled' : 'weixin' } });
      if (action === 'approve' || action === 'revoke') {
        const id = b.dataset.user; let ids = [...state.config.im.allow_from];
        if (action === 'approve') { if (!state.pending.some(p => p.userId === id)) throw new Error('这位待确认用户的状态已变化，请刷新后核对。'); ids.push(id); }
        else { if (!ids.includes(id)) throw new Error('这位用户已经取消配对，请刷新后核对。'); ids = ids.filter(value => value !== id); }
        return saveConfig({ im: { allow_from: [...new Set(ids)], access_policy: 'allowlist' } }, b.dataset.configRevision);
      }
      if (action === 'doctor') { doctorResult = await api('doctor', {}); $('#doctor-result').innerHTML = renderDoctor(); toast('连接检查完成。'); return; }
      if (action === 'device') { deviceResult = await api('device', {}); $('#device-result').textContent = deviceResult.detail || deviceResult.state; toast('已读取设备连接状态。'); return; }
      if (action === 'apply') { await api('apply', { revision: state.revision }); await refresh(!dirty); toast('配置已生成，正在等待服务确认加载。'); return; }
      if (['start', 'stop', 'login'].includes(action)) { await api(action, {}); await refresh(!dirty); toast(action === 'start' ? '已请求启动，连接状态会自动更新。' : action === 'stop' ? '本地 PA 已停止。' : '请用微信扫码并确认。'); }
    });
  });
  document.addEventListener('submit', e => {
    if (e.target.closest('.journal-editor,.connections-center,.chat-center,.first-task')) return;
    e.preventDefault(); const form = e.target, button = e.submitter;
    const revision = form.dataset.revision;
    void work(button, async () => {
      if (form.id === 'agent-form') return saveConfig({ owner: $('#owner').value.trim(), agent: { provider: $('#agent-provider').value, command: $('#agent-command').value.trim(), model: $('#agent-model').value.trim(), timeout_seconds: Number($('#agent-timeout').value) } }, revision, form.id);
      if (form.id === 'device-form') return saveConfig({ device: { provider: $('#device-provider').value, id: $('#device-id').value.trim(), wda_url: $('#wda-url').value.trim() } }, revision, form.id);
      if (form.id === 'reach-out-form') {
        await api('reach-out', { revision: Number(revision), mode: $('#reach-mode').value, max_daily: Number($('#reach-daily').value), min_gap_minutes: Number($('#reach-gap').value), quiet_start: $('#reach-start').value, quiet_end: $('#reach-end').value, trial: null });
        clearDraft(form.id); await refresh(); toast('已保存。'); return;
      }
      if (form.id === 'prefs-form') {
        const values = { max_daily: Number($('#max-daily').value), quiet_start: $('#quiet-start').value, quiet_end: $('#quiet-end').value, min_gap_minutes: Number($('#min-gap').value), max_chars: Number($('#max-chars').value) };
        for (const id of ['quiet-start', 'quiet-end']) { document.getElementById(id).removeAttribute('aria-invalid'); document.getElementById(id).setAttribute('aria-describedby', 'prefs-status'); }
        if (values.quiet_start === values.quiet_end) { for (const id of ['quiet-start', 'quiet-end']) document.getElementById(id).setAttribute('aria-invalid', 'true'); throw new Error('静默开始与结束时间不能相同，请调整后保存。'); }
        if (form.dataset.account) { if (state.config.proactive.enabled) values.enabled = $('#pref-enabled').checked; return taskChange('preferences', { values }, Number(revision), { account: form.dataset.account, id: form.dataset.user }, form.id); }
        return saveConfig({ proactive: values }, revision, form.id);
      }
    }, form.querySelector('[role=status]'));
  });
  window.addEventListener('beforeunload', e => { if (dirty || window.PAOnboarding.isBusy() || window.PAOnboarding.isEditing() || window.PAJournal.isBusy() || window.PAChat.isBusy() || window.PAConnections.isBusy() || window.PAJournal.isEditing() || window.PAConnections.isEditing() || window.PAChat.isEditing()) { e.preventDefault(); e.returnValue = ''; } });
  void refresh();
  setInterval(() => { if (!busy && !document.hidden && !refreshing) void refresh(!dirty); }, 5000);
})();
