(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const active = new Set(['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling']);
  const problems = new Set(['failed', 'uncertain', 'waiting_approval']);
  const labels = { queued: '等待检查', running: '正在检查', waiting_approval: '等待你确认', uncertain: '执行中断，结果待核对', cancelling: '正在停止', published: '已更新产物', quiet: '已检查，无新发现', failed: '这次巡查未完成', cancelled: '本次已停止', superseded: '规则已更新，旧检查结果未采用' };
  const errors = { ENDPOINT_UNAVAILABLE: '执行 Agent 不可用', ENDPOINT_OFFLINE: '执行 Agent 离线', AGENT_TIMEOUT: '执行超时', SOURCE_UNAVAILABLE: '资料来源暂不可用', SOURCE_BRIDGE_OFFLINE: '资料来源 Mac 离线', SOURCE_REVOKED: '资料授权已撤回', SOURCE_NOT_CONFIGURED: '资料来源尚未连接', SOURCE_PERMISSION_REQUIRED: '资料来源需要授权', ROUTINE_RESULT_REQUIRED: '没有收到完整检查结果', ROUTINE_RESULT_MISSING: '没有收到完整检查结果', ROUTINE_SOURCE_INCOMPLETE: '资料读取未完成', ROUTINE_SOURCE_UNVERIFIED: '尚未核实本次读取', ROUTINE_INCOMPLETE: '检查尚未完成', ROUTINE_CHECK_BLOCKED: '检查遇到阻碍', JOURNAL_CLOSED: '关联手账已归档或不可用', ITEM_CLOSED: '这篇手账已归档', ITEM_NOT_FOUND: '关联手账不可用' };
  const connectionErrors = new Set(['ENDPOINT_UNAVAILABLE', 'ENDPOINT_OFFLINE', 'SOURCE_BRIDGE_OFFLINE', 'SOURCE_REVOKED', 'SOURCE_NOT_CONFIGURED', 'SOURCE_PERMISSION_REQUIRED']);
  Object.assign(errors, { ROUTINE_SCOPE_EMPTY: '未选择资料来源，后续检查已停止', SOURCE_AUTHORITY_CHANGED: '资料授权已变化，请重新确认范围', ROUTINE_ENDED: '这项跟进已结束', ROUTINE_NOTIFICATION_CHANNEL_REQUIRED: '提醒渠道不可用，请重新选择', ROUTINE_SCOPE_REQUIRED: '请明确文件访问目录', ROUTINE_SCOPE_DENIED: '这次读取超出跟进范围', ROUTINE_SCOPE_UNSUPPORTED: '执行端需更新后才能安全跟进', ROUTINE_PUBLIC_WEB_UNSUPPORTED: '这个执行端尚不支持可核验的网页巡查', ROUTINE_EXPIRED: '已到结束时间' });
  // Intranet HTTP supports getRandomValues, but not secure-context randomUUID.
  const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  function scheduleLabel(schedule = {}) {
    const days = [...new Set(schedule.days || [])].sort((a, b) => a - b);
    const key = days.join(','), names = ['一', '二', '三', '四', '五', '六', '日'];
    const period = key === '1,2,3,4,5,6,7' ? '每天' : key === '1,2,3,4,5' ? '工作日' : key === '6,7' ? '周末' : days.map(day => `周${names[day - 1] || '?'}`).join('、');
    return `${period || '时间待确认'}${schedule.time ? ` ${schedule.time}` : ''}`;
  }
  function atLabel(at, timezone) {
    if (!at) return '';
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) return '';
    try { return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date); }
    catch { return ''; }
  }
  function directoryLabel(routine) {
    if (routine.endedAt) return '已结束跟进';
    if (routine.scopeStatus?.error === 'ROUTINE_SCOPE_EMPTY') return '未选择来源';
    if (routine.scopeStatus?.allowed === false || routine.scopeStatus?.blocked) return '来源需要处理';
    if (routine.error && !problems.has(routine.lastStatus)) return '巡查暂未运行';
    if (problems.has(routine.lastStatus)) return labels[routine.lastStatus];
    if (!routine.enabled) return '已暂停';
    if (active.has(routine.lastStatus)) return labels[routine.lastStatus];
    return scheduleLabel(routine.schedule);
  }
  const sourceNames = { calendar_events: '日历', mail_search: '邮件搜索', mail_read: '邮件阅读', drive_recent: '最近云端文件', drive_search: '云端文件', drive_metadata: '文件信息', docs_read: '文档', sheets_metadata: '表格信息', sheets_read: '表格', contacts_search: '联系人', review_requests: '待评审事项', github_repositories: 'GitHub 仓库', github_updates: 'GitHub 仓库更新', github_notifications: 'GitHub 通知', recent_files: '最近文件', file_search: '文件搜索', file_read: '文件阅读', x_timeline: 'X 时间线' };
  function sourceLabel(source) {
    const values = Object.values(source.filter || {});
    return `${sourceNames[source.operation] || source.operation}${values.length ? `：${values.join('、')}` : '（已授权范围）'}`;
  }
  const sourceKey = source => JSON.stringify([source.operation, Object.entries(source.filter || {}).sort(([a], [b]) => a.localeCompare(b))]);
  function localInput(at) {
    if (!at) return '';
    const date = new Date(at);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function noticeLabel(notice) {
    if (!notice || notice.state === 'journal') return '仅保存在手账';
    const blocked = { quiet_hours: '静默时段，稍后提醒', channel_offline: '提醒渠道离线', cooldown: '稍后合并提醒', daily_budget: '今日提醒额度已用完', paused: '提醒已暂停', digest_wait: '等待合并提醒', recent_conversation: '对话结束后提醒', conversation_active: '对话结束后提醒' };
    return blocked[notice.blocked] || ({ pending: '等待提醒', queued: '等待投递', sending: '正在投递', submitted: '已提交提醒', sent: '已发送提醒', delivered: '提醒已送达', read: '提醒已读', unknown: '投递结果待核对', cancelled: '提醒已撤回', expired: '提醒已过期' })[notice.state] || '提醒状态待核对';
  }
  function settings(routine, itemId, draft, notifications, localTimezone) {
    if (routine.endedAt) return '';
    const saved = draft.routineSettings || {}, channelId = saved.channelId ?? routine.notification?.channelId ?? '';
    const scope = routine.scope || { publicWeb: true, sources: [] };
    const scopeChanged = JSON.stringify({ publicWeb: saved.publicWeb ?? scope.publicWeb, sources: (scope.sources || []).filter(source => !saved.sources || saved.sources.includes(sourceKey(source))) }) !== JSON.stringify(scope);
    const stale = saved.baseVersion !== undefined && saved.baseVersion !== routine.version;
    const channels = notifications.channels || [];
    const input = (name, label, content) => `<label class="journal-routine-field" for="routine-${name}-${esc(itemId)}"><span>${label}</span>${content}</label>`;
    const sourceChecks = (scope.sources || []).map(source => `<label class="journal-routine-source"><input type="checkbox" data-routine-source="${esc(sourceKey(source))}" data-item="${esc(itemId)}"${(!saved.sources || saved.sources.includes(sourceKey(source))) ? ' checked' : ''}><span>${esc(sourceLabel(source))}</span></label>`).join('');
    return `<div class="journal-routine-settings" data-item="${esc(itemId)}">
      ${stale ? `<p class="journal-routine-problem journal-routine-reauthorize" role="alert">规则已变化，请重新核对后填写。<button type="button" class="text" data-j-action="routine-reset" data-item="${esc(itemId)}">重新载入</button></p>` : ''}
      <fieldset class="journal-routine-sources"><legend>可读取</legend><label class="journal-routine-source"><input type="checkbox" data-routine-field="publicWeb" data-item="${esc(itemId)}"${(saved.publicWeb ?? scope.publicWeb) ? ' checked' : ''}><span>公开网页</span></label>${sourceChecks}</fieldset>
      ${routine.scopeStatus?.blocked && routine.scopeStatus.error !== 'ROUTINE_SCOPE_EMPTY' ? `<div class="journal-routine-reauthorize"><p>${scopeChanged ? '先保存已修改的资料范围。' : esc(routine.scopeSummary || '请核对以上资料范围。')}</p><button type="button" class="outline" data-j-action="routine-authorize_scope" data-item="${esc(itemId)}"${scopeChanged || stale ? ' disabled' : ''}>重新确认资料范围</button></div>` : ''}
      ${input('channel', '提醒到', `<select id="routine-channel-${esc(itemId)}" data-routine-field="channelId" data-item="${esc(itemId)}"><option value="">仅手账</option>${channelId && !channels.some(c => c.id === channelId) ? `<option value="${esc(channelId)}" selected>原渠道已不可用</option>` : ''}${channels.map(c => `<option value="${esc(c.id)}"${c.id === channelId ? ' selected' : ''}>${esc(c.label)}${c.online ? '' : '（离线）'}</option>`).join('')}</select>`)}
      ${input('ends', `结束时间（${esc(localTimezone)}）`, `<input type="datetime-local" id="routine-ends-${esc(itemId)}" data-routine-field="endsAt" data-item="${esc(itemId)}" value="${esc(saved.endsAt ?? localInput(routine.endsAt))}">`)}
      <div class="journal-routine-settings-actions"><button type="button" class="outline" data-j-action="routine-save" data-item="${esc(itemId)}"${draft.routineSubmission || stale ? ' disabled' : ''}>保存</button><button type="button" class="text" data-j-action="routine-edit" data-item="${esc(itemId)}">调整来源与规则</button><details class="journal-routine-end"><summary>结束跟进</summary><p>停止后续检查，保留已有产物。结束后需重新创建。</p><button type="button" class="text danger" data-j-action="routine-end" data-item="${esc(itemId)}">确认结束</button></details></div>
    </div>`;
  }
  function render(routine, itemId, draft = {}, localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone, schedulerError = null, notifications = {}) {
    if (!routine) return '';
    const zone = routine.schedule?.timezone, last = routine.lastStatus, busy = active.has(last), problem = problems.has(last) || !!routine.error;
    const schedule = scheduleLabel(routine.schedule), next = routine.enabled && atLabel(routine.nextRunAt, zone);
    const checkBlocked = !!routine.error && !problems.has(last);
    const checked = checkBlocked ? '' : atLabel(routine.lastRun?.finishedAt || routine.lastRunAt, zone);
    const button = (operation, label, disabled = false, className = 'text') => `<button type="button" class="${className}" data-j-action="routine-${operation}" data-item="${esc(itemId)}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
    const status = checkBlocked ? '巡查暂未运行' : labels[last] || '';
    const reason = errors[routine.error];
    const detail = reason ? `：${reason}` : '';
    const headline = last === 'failed' && reason ? reason : status + detail;
    const summary = problems.has(last) && typeof routine.lastSummary === 'string' && routine.lastSummary.trim() ? routine.lastSummary : '';
    const time = checked ? `<time>${esc(checked)}</time>` : '';
    const statusContent = summary ? `<details class="journal-routine-result-details" id="routine-result-${esc(routine.id)}"><summary>${time}<span>${esc(headline)}</span></summary><div class="journal-routine-rule-body"><p>${esc(summary)}</p></div></details>` : `${time}<span>${esc(headline)}</span>`;
    const unresolved = !!draft.routineSubmission;
    const retry = unresolved && !draft.routineBusy;
    const scopeError = routine.scopeStatus?.error || routine.scopeStatus?.blocked;
    const nextLabel = routine.endedAt ? '已结束跟进' : !routine.enabled ? '已暂停' : scopeError === 'ROUTINE_SCOPE_EMPTY' ? '等待选择来源' : scopeError ? '等待授权恢复' : next ? `下次 ${next}` : '下次检查待确认';
    const notice = notifications.byRoutine?.[routine.id];
    const scopeMessage = scopeError === 'ROUTINE_SCOPE_EMPTY' ? '未选择资料来源，后续检查已停止。' : scopeError ? '来源授权已变化，后续检查已停止。' : '';
    return `<section class="journal-routine" aria-label="日常巡查" data-state="${esc(last || 'scheduled')}">
      <div class="journal-routine-row">
        <details class="journal-routine-rules" id="routine-rules-${esc(routine.id)}">
          <summary aria-label="巡查规则：${esc(schedule)}"><strong>${esc(schedule)}${zone && zone !== localTimezone ? `<span class="journal-routine-zone"> · ${esc(zone)}</span>` : ''}</strong><span>${esc(nextLabel)}</span></summary>
          <div class="journal-routine-rule-body"><p>${esc(routine.instruction)}</p><dl><div><dt>回报条件</dt><dd>${esc(routine.trigger?.condition || '按已保存规则检查')}</dd></div><div><dt>时区</dt><dd>${esc(zone || '待确认')}</dd></div><div><dt>最近提醒</dt><dd>${esc(noticeLabel(notice))}</dd></div></dl>${settings(routine, itemId, draft, notifications, localTimezone)}</div>
        </details>
        ${routine.endedAt ? '' : `<div class="journal-routine-actions">${button(routine.enabled ? 'pause' : 'resume', routine.enabled ? '暂停' : '恢复', unresolved)}${button('run_now', busy ? labels[last] : '立即检查', busy || unresolved || !routine.enabled || !!scopeError, 'outline')}</div>`}
      </div>
      ${status && !scopeError ? `<div class="journal-routine-status${problem ? ' journal-routine-problem' : ''}" role="status">${statusContent}${problem ? connectionErrors.has(routine.error) ? button('connect', '检查连接') : button('edit', last === 'waiting_approval' ? '查看请求' : '查看执行') : ''}</div>` : ''}
      ${scopeMessage ? `<p class="journal-routine-problem" role="status">${scopeMessage}${scopeError === 'ROUTINE_SCOPE_EMPTY' ? button('edit', '调整来源与规则') : button('connect', '检查连接')}</p>` : ''}
      ${notice && notice.state !== 'journal' && !['cancelled', 'expired'].includes(notice.state) ? `<p class="journal-routine-notice" role="status">${esc(noticeLabel(notice))}${notice.blocked === 'channel_offline' ? button('connect', '检查连接') : ''}</p>` : ''}
      ${schedulerError ? '<p class="journal-routine-problem" role="alert">巡查调度暂不可用，请稍后重试检查。</p>' : ''}
      ${retry ? `<p class="journal-routine-problem" role="status"><span>操作结果待确认</span>${button('reconcile', '核对操作')}</p>` : ''}
      ${draft.routineError && !retry ? `<p class="journal-routine-problem" role="alert">${esc(draft.routineError)}</p>` : ''}
      ${draft.routineNotice ? `<p class="journal-routine-notice" role="status">${esc(draft.routineNotice)}</p>` : ''}
    </section>`;
  }
  function settingsValues(routine, draft = {}) {
    const saved = draft.routineSettings || {}, scope = routine.scope || { publicWeb: true, sources: [] };
    if (saved.baseVersion !== undefined && saved.baseVersion !== routine.version) throw new Error('规则已变化，请重新载入后核对资料范围。');
    const ends = saved.endsAt === undefined ? routine.endsAt || null : saved.endsAt ? new Date(saved.endsAt).getTime() : null;
    if (ends !== null && (!Number.isSafeInteger(ends) || ends <= Date.now())) throw new Error('结束时间需要晚于现在，或清空后持续跟进。');
    const nextScope = { publicWeb: saved.publicWeb ?? scope.publicWeb, sources: (scope.sources || []).filter(source => !saved.sources || saved.sources.includes(sourceKey(source))) };
    return { ...(saved.channelId !== undefined ? { notification: { channelId: saved.channelId || null } } : {}), ...(saved.endsAt !== undefined ? { endsAt: ends } : {}),
      ...(JSON.stringify(nextScope) !== JSON.stringify(scope) ? { scope: nextScope } : {}) };
  }
  window.PARoutineUI = { requestId, scheduleLabel, atLabel, directoryLabel, sourceKey, sourceLabel, noticeLabel, settingsValues, errorLabel: code => errors[code], render };
})();
