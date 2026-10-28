(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const errors = { IMESSAGE_IDENTITIES_REQUIRED: '请分别填写不同的 Mori 收信地址和个人发信地址。', IMESSAGE_ALREADY_BOUND: '这段私聊已经绑定。请使用已有连接；更换配置前先断开原授权。', LOCAL_AGENT_NOT_INSTALLED: '请先在这台 Mac 安装所选 Agent 的 CLI 和 Node.js，再重试。', LOCAL_WORKSPACE_REQUIRED: '请选择已存在的本地工作目录。', LOCAL_AGENT_ALREADY_PAIRED: '这个 Agent 已绑定其他工作目录；请展开「连接另一台 Mac」，下载配置后在执行电脑上安装。', LOCAL_AGENT_SETUP_FAILED: '连接助手未安装成功。请运行 pa.sh connect discover 检查工具，再用下载配置的方式重试。', AGENT_AUTH_REQUIRED: '本地 Agent 的登录已失效，请在电脑上重新登录后再试。', AGENT_TIMEOUT: '本地 Agent 执行超时，请在电脑上核对状态。', ENDPOINT_UNAVAILABLE: '执行端已断开，请重新连接。', WEIXIN_BINDING_REQUIRED: '请先把自己的微信接到这段对话，再设置微信提醒。', VERSION_CONFLICT: '待办已在其他入口更新，请查看最新状态后重试。', CONFLICT: '这项操作的状态已变化，请查看最新状态。', BRIDGE_UNAUTHORIZED: '连接授权已失效，请重新生成连接配置。' };
  Object.assign(errors, { IMESSAGE_RECOVERY_STALE: '绑定状态已变化，请刷新后重新核对。', IMESSAGE_RECOVERY_PENDING_INPUTS: '还有未提交来信，请先在收发 Mac 核对。', SOURCE_DOCUMENT_OCR_REQUIRED: '这份 PDF 没有可提取文字，需要先做 OCR。', SOURCE_DOCUMENT_TOO_LARGE: '文档超过 10 MiB，请先缩小文件。', SOURCE_DOCUMENT_PASSWORD_REQUIRED: 'PDF 需要密码，请提供已解锁的副本。', SOURCE_DOCUMENT_TIMEOUT: '文档解析超时，请缩小文件后重试。', SOURCE_DOCUMENT_INVALID: '暂时无法解析这份文档，请检查文件格式。' });
  const status = { queued: '等待处理助手', running: '正在处理', waiting_approval: '等待你批准', uncertain: '执行结果待确认', completed: '已完成', failed: '执行失败', cancelled: '已取消', cancelling: '正在等待本地停止', pending: '待办', done: '已完成' };
  Object.assign(errors, { BOT_CONNECTION_REQUIRED: '这个 Bot 还没有执行连接，请到设置的 Bot 页签配置。', BOT_UNAVAILABLE: '这个 Bot 已停用，请换一位。', BOT_MENTION_UNKNOWN: '没有找到这个 @Bot，请核对名字。', BOT_CHANGED: 'Bot 设置已变化，请核对后重新发送。', FIRST_TASK_BUSY: 'Mori 还在跟进这件事，等当前结果返回后再发送。', FIRST_TASK_RECOVERY_REQUIRED: '上一轮执行状态仍待核对，当前输入已保留，请先核对执行记录。' });
  Object.assign(errors, {
    AGENT_EMPTY_REPLY: '这次执行没有返回结果，已有材料仍保留，请核对后继续。',
    AGENT_TURN_FAILED: '执行端未能完成这一轮，已有结果仍保留。请检查连接后重试。',
    AGENT_FAILED: '执行端未能完成这次处理，已有结果仍保留。请检查连接后重试。',
    AGENT_RATE_LIMITED: '执行端暂时受到额度或频率限制，请稍后重试，或在设置中更换执行端。',
    AGENT_COMPANION_STOPPED: '执行助手已停止，请在执行电脑上重新启动连接。',
    AGENT_CONNECTION_UNCERTAIN: '执行端连接中断，结果尚未确认。请先核对执行状态。',
    AGENT_SESSION_BUSY: '这段聊天还有任务在执行，请等待当前任务结束。',
    ENDPOINT_OFFLINE: '执行电脑离线，请恢复连接后再继续。',
    BRIDGE_UNAVAILABLE: '连接助手暂不可用，请在执行电脑上检查连接。',
    BOT_MEMBER_BLOCKED: '协作成员遇到阻碍，已有结果仍保留。',
    BOT_MEMBER_PARTIAL: '协作仍有未完成部分，请核对已有结果后继续。',
    BOT_TASK_STOPPED: '这次协作已停止，已有结果仍保留。',
    BOT_MESSAGE_LIMIT: '本次协作已达到询问上限，请核对已有结果后继续。',
    BOT_LIMIT: '点名的 Bot 超过了本次协作上限。',
    SOURCE_BRIDGE_OFFLINE: '资料来源 Mac 离线，请在设置中检查连接。',
    SOURCE_REVOKED: '资料授权已撤回，请在设置中重新连接所需来源。',
    SOURCE_NOT_CONFIGURED: '资料来源尚未连接，请先到设置中连接。',
    SOURCE_PERMISSION_REQUIRED: '资料来源需要授权，请在设置中核对。',
    SOURCE_UNAVAILABLE: '资料来源暂不可用，请检查连接后重试。',
    ROUTINE_RESULT_MISSING: '没有收到完整检查结果，请查看本次执行后重新检查。',
    ROUTINE_SOURCE_INCOMPLETE: '资料读取未完成，不能据此判断没有新发现。',
    ROUTINE_SOURCE_UNVERIFIED: '尚未核实本次读取，请查看执行详情。',
    ROUTINE_INCOMPLETE: '这次巡查尚未完成，请查看执行详情。',
    ROUTINE_CHECK_BLOCKED: '这次巡查遇到阻碍，请查看具体原因后重试。',
    ROUTINE_PAUSED: '巡查已暂停，恢复后才能检查。',
    ROUTINE_BUSY: '已有检查尚未结束，请先核对当前执行。',
    ROUTINE_SUPERSEDED: '巡查规则已更新，这次旧规则的结果未采用。',
    JOURNAL_CLOSED: '关联手账已归档或不可用，请重新打开后再检查。',
  });
  const deliveryLabels = { pending: '等待发送', sending: '正在发送', submitted: '已提交，等待回执', sent: '已发送', delivered: '已送达', read: '对方已读', failed: '发送失败，请检查连接', unknown: '发送结果未知，未自动重发', cancelled: '已取消发送' };
  const channelErrors = { IMESSAGE_ACCOUNT_MISMATCH: 'Mori 收信账号不匹配，请核对信息设置', IMESSAGE_CHAT_ACCESS_REQUIRED: '需要检查消息读取权限', IMESSAGE_DATABASE_CHANGED: '消息数据库已变化，请重新核对绑定', IMESSAGE_BACKPRESSURE: '待上传消息已满，请检查 Hub 连接' };
  const source = { weixin: '微信', web: '网页', imessage: 'iMessage', 'desktop-pet': '桌面 Mori' };
  const imChannel = channel => ['weixin', 'imessage'].includes(channel);
  function sourceMarker(channel, role, delivery) {
    const outgoing = role === 'assistant' && imChannel(delivery?.channel);
    const shown = outgoing ? delivery.channel : channel;
    const label = source[shown] || (shown ? '来源未知' : '');
    if (!label || role === 'assistant' && !imChannel(shown)) return '';
    const text = role === 'assistant' ? outgoing ? `回${label}` : `${label}交代` : label;
    // Generic channel symbols follow our Lucide stroke style; these are not
    // platform logos. Text carries the source even without color or icons.
    const path = shown === 'weixin' ? '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>' : '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>';
    const icon = imChannel(shown) ? `<svg class="chat-channel-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>` : '';
    return `<span class="chat-source" data-source-channel="${esc(shown || '')}">${icon}<span>${esc(text)}</span></span>`;
  }
  errors.OWNER_ROUTE_BUSY = '这段聊天还有任务在处理，完成或取消后再修改本人绑定。';
  // Idempotency keys must also work on supported intranet HTTP origins.
  Object.assign(errors, { AGENT_MODEL_UNAVAILABLE: '所选模型不可用，请在执行电脑检查模型设置或切换 Agent。', ATTACHMENT_FORMAT_UNSUPPORTED: '请选择 PDF、DOCX 或文字文件。', BODY_TOO_LARGE: '资料不能超过 10 MiB。', ATTACHMENT_EXPIRED: '这份临时资料已过期，请重新选择。', ATTACHMENT_LIMIT: '临时资料较多，请稍后再试。', SOURCE_DOCUMENT_OCR_REQUIRED: '这份 PDF 没有可提取的文字，请提供文字版。', SOURCE_DOCUMENT_PASSWORD_REQUIRED: '请先解除文件密码后再选择。', SOURCE_DOCUMENT_INVALID: '无法读取这份资料，请检查文件格式。', SOURCE_DOCUMENT_TEXT_UNAVAILABLE: '没有读取到文字，请换一份资料。' });
  const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  let uploading = false;
  let view = 'conversation', onConversation, onItemSaved, journalItemId, journalDraft = false, roomKind, roomBotId, messageObserver, followMessages = true;
  function scrollMessages() { const list = root?.querySelector('#chat-messages'); if (list) { followMessages = list.scrollHeight - list.scrollTop - list.clientHeight < 90; captureReadingPosition(); } }
  let root, api, timer, model, selected = '', pending = false, runtime, taskDraft, generation = 0;
  const drafts = new Map(), attachments = new Map();
  const agentSelections = new Map(), sendRequests = new Map();
  const readingPositions = new Map(), locatedMessages = new Map(), draftReferences = new Map(), draftSuggestions = new Map();
  let revealedMessageId = '', revealTimer;
  const openRuns = new Set();
  const draftKey = (conversationId = selected, itemId = journalItemId, isNew = journalDraft) => itemId ? conversationId + ':' + itemId : isNew ? conversationId + ':new' : conversationId;
  const inConversation = value => (value.resolvedConversationId || value.conversationId) === selected;
  function chapterTaskIds() {
    if (journalDraft) return new Set();
    if (!journalItemId) return null;
    return new Set(model.runs.filter(run => run.journalItemId === journalItemId || run.journalItemIds?.includes(journalItemId)).map(run => run.rootRunId || run.id));
  }
  function visibleRuns() {
    const tasks = chapterTaskIds();
    return model.runs.filter(run => (!tasks || tasks.has(run.rootRunId || run.id)) && (runScope !== 'current' || inConversation(run)));
  }
  function visibleMessages() {
    if (journalDraft) return [];
    const tasks = chapterTaskIds();
    const runs = new Map(model.runs.map(run => [run.id, run]));
    const messages = new Map(model.messages.map(message => [message.id, message]));
    for (const message of locatedMessages.values()) if (!messages.has(message.id)) messages.set(message.id, message);
    return [...messages.values()].filter(message => inConversation(message) && (!tasks || message.journalItemId === journalItemId || message.journalItemIds?.includes(journalItemId) || tasks.has(message.rootRunId || runs.get(message.runId)?.rootRunId || message.runId))).sort((a, b) => effectiveTime(a) - effectiveTime(b) || (a.appendSeq || 0) - (b.appendSeq || 0));
  }
  function effectiveTime(message) {
    const value = message.effectiveAt ?? message.origin?.receivedAt ?? message.createdAt;
    const time = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(time) ? time : 0;
  }
  function captureReadingPosition() {
    const list = root?.querySelector('#chat-messages'); if (!list) return null;
    if (list.dataset.conversation !== selected) return readingPositions.get(draftKey()) || null;
    const top = list.getBoundingClientRect?.().top || 0;
    const anchor = [...list.querySelectorAll('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > top);
    const position = { key: draftKey(), conversationId: selected, messageId: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, scrollTop: list.scrollTop, bottom: followMessages };
    readingPositions.set(position.key, position); return position;
  }
  function restoreReadingPosition(position = readingPositions.get(draftKey())) {
    const list = root?.querySelector('#chat-messages'); if (!list || !position || position.key !== draftKey()) return false;
    followMessages = position.bottom;
    const anchor = position.messageId && list.querySelector(`#chat-message-${CSS.escape(position.messageId)}`);
    if (position.bottom) list.scrollTop = list.scrollHeight;
    else if (anchor?.getBoundingClientRect) list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - position.offset;
    else list.scrollTop = position.scrollTop;
    return true;
  }
  function taskRows() {
    const runs = visibleRuns(), roots = new Map();
    for (const run of runs) {
      const id = run.rootRunId || run.id;
      if (!roots.has(id)) roots.set(id, model.runs.find(value => value.id === id) || run);
    }
    return [...roots].map(([id, rootRun]) => {
      const task = model.rootTasks?.find(value => value.rootRunId === id || value.id === id);
      const children = runs.filter(value => (value.rootRunId || value.id) === id);
      const fault = children.find(value => value.issue?.state !== 'resolved' && (['uncertain', 'cancelling', 'failed'].includes(value.status) || ['partial', 'blocked'].includes(value.report?.outcome)));
      const current = children.find(value => ['running', 'waiting_approval', 'queued'].includes(value.status));
      const representative = fault || current || children.at(-1) || rootRun;
      return { ...rootRun, ...(task && { status: task.state, issue: task.issue || rootRun.issue }), task, members: children, activeRun: representative, recoveryRun: fault || rootRun };
    });
  }
  function taskProblem(run) {
    if (!run || run.issue?.state === 'resolved' || run.botTaskStopped === 'CANCELLED') return '';
    if (['uncertain', 'cancelling'].includes(run.status)) return '执行结果待核对，未自动重发。';
    const fault = run.recoveryRun || run;
    if (['uncertain', 'cancelling'].includes(fault.status)) return '执行结果待核对，未自动重发。';
    if (run.botTaskStopped || run.handoffError || ['failed', 'partial', 'blocked'].includes(run.status) || ['failed', 'partial', 'blocked'].includes(fault.status) || ['partial', 'blocked'].includes(fault.report?.outcome)) return errors[fault.error] || errors[run.error] || readableReason(fault.report?.summary) || readableReason(run.issue?.reason) || errors[run.botTaskStopped] || readableReason(fault.error) || readableReason(run.error) || '这次处理未完成，已有结果仍保留。请查看执行记录后重试。';
    return '';
  }
  function readableReason(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    const text = value.trim();
    return errors[text] || (/^[A-Z][A-Z0-9_]+(?:$|:)/.test(text) ? '' : text);
  }
  function recoveryMarkup(run, existingText = '') {
    const text = taskProblem(run); if (!text) return '';
    const recovery = run.recoveryRun || run;
    const uncertain = ['uncertain', 'cancelling'].includes(run.status) || ['uncertain', 'cancelling'].includes(recovery.status);
    // The host already attached this issue to its exact task message. Suppress
    // only an exact fact already present there, never another message's text.
    const alreadyExplained = typeof existingText === 'string' && existingText.includes(text.trim());
    return `<div class="chat-message-recovery" role="status">${alreadyExplained ? '' : `<p>${esc(text)}</p>`}${uncertain ? `<button class="text" data-chat-action="cancel" data-id="${esc(recovery.id)}">核对执行状态</button>` : `<button class="text" ${pending ? 'disabled' : ''} data-retry-run="${esc(recovery.id)}">带回草稿</button>`}${run.issue?.state === 'open' ? `<button class="text" data-chat-action="resolve-run" data-id="${esc(run.id)}">接受当前结果</button>` : ''}</div>`;
  }
  let runScope = 'all', runFilter = 'all', runLimit = 8;
  let preferredNewEndpoint = '', preparingDraft = false;
  let refreshTicket, transportHealthy = false;
  const setupDirtyForms = new Set();
  const pendingDownloads = new Set();
  const downloadURLs = new Map();
  const formFingerprint = form => JSON.stringify([...new FormData(form).entries()]);
  let mustChooseConversation = false;
  try { selected = sessionStorage.getItem('xiaoman-current-conversation') || ''; mustChooseConversation = sessionStorage.getItem('xiaoman-needs-conversation-choice') === 'true'; } catch {}
  try {
    const saved = JSON.parse(sessionStorage.getItem('xiaoman-chat-drafts-v2') || sessionStorage.getItem('xiaoman-chat-drafts-v1') || '[]');
    if (Array.isArray(saved) && saved.length <= 20) for (const entry of saved) {
      if (!entry || typeof entry.conversationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.conversationId) || typeof entry.content !== 'string' || entry.content.length > 16000) continue;
      if (entry.journalItemId && (typeof entry.journalItemId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.journalItemId))) continue;
      const key = draftKey(entry.conversationId, entry.journalItemId || null, entry.journalDraft === true);
      drafts.set(key, entry.content);
      if (entry.references) draftReferences.set(key, entry.references);
      if (entry.attachment && typeof entry.attachment.id === 'string' && typeof entry.attachment.name === 'string') attachments.set(key, entry.attachment);
      const r = entry.request;
      if (r && r.conversationId === entry.conversationId && (r.journalItemId || null) === (entry.journalItemId || null) && r.content === entry.content.trim() && typeof (r.botId || r.endpointId) === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(r.botId || r.endpointId) && /^[a-f0-9]{32}$/.test(r.requestId || '')) { sendRequests.set(key, r); agentSelections.set(key, r.botId || 'xiaoman'); }
    }
  } catch {}
  function persistDrafts() {
    try {
      const entries = [...new Set([...drafts.keys(), ...sendRequests.keys(), ...attachments.keys()])].filter(key => key && (drafts.get(key)?.trim() || sendRequests.has(key) || attachments.has(key))).slice(-20).map(key => {
        const [conversationId, itemId] = key.split(':');
        return { conversationId, ...(itemId === 'new' ? { journalDraft: true } : itemId && { journalItemId: itemId }), content: drafts.get(key) ?? sendRequests.get(key)?.content ?? '', request: sendRequests.get(key), attachment: attachments.get(key), references: draftReferences.get(key) };
      });
      sessionStorage.setItem('xiaoman-chat-drafts-v2', JSON.stringify(entries));
      sessionStorage.removeItem('xiaoman-chat-drafts-v1');
    } catch {}
  }
  function rememberConversation() { try { if (selected) { sessionStorage.setItem('xiaoman-current-conversation', selected); sessionStorage.removeItem('xiaoman-needs-conversation-choice'); } else { sessionStorage.removeItem('xiaoman-current-conversation'); if (mustChooseConversation) sessionStorage.setItem('xiaoman-needs-conversation-choice', 'true'); } } catch {} }
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const canRetryRun = run => run && run.issue?.state !== 'resolved' && (run.status === 'failed' || ['partial', 'blocked'].includes(run.report?.outcome) || run.botTaskStopped && run.botTaskStopped !== 'CANCELLED');
  function runState(run) {
    if (run.issue?.state === 'resolved') return { label: run.issue.resolution.kind === 'continued' ? '原问题已接着处理' : '已接受当前结果', tone: 'done' };
    if (run.botTaskStopped) return { label: run.botTaskStopped === 'CANCELLED' ? '已取消' : '未完成', tone: run.botTaskStopped === 'CANCELLED' ? 'active' : 'attention' };
    if (['partial', 'blocked'].includes(run.status)) return { label: run.status === 'partial' ? '部分完成' : '任务受阻', tone: 'attention' };
    if (run.handoffError) return { label: '协作未接上', tone: 'attention' };
    if (run.status === 'completed' && run.nextRunId) return { label: '已交接', tone: 'done' };
    if (run.status !== 'completed') return { label: status[run.status] || run.status, tone: ['failed', 'uncertain', 'waiting_approval'].includes(run.status) ? 'attention' : 'active' };
    return { label: { completed: '已完成', partial: '部分完成', blocked: '任务受阻', in_progress: '尚未完成' }[run.report?.outcome] || '已回复 · 未汇报结果', tone: run.report?.outcome === 'completed' ? 'done' : 'attention' };
  }
  function artifactMarkup(artifact, endpoint) {
    if (artifact.url) {
      // Validate at the rendering boundary as well, including restored local data.
      let url; try { url = new URL(artifact.url); } catch { return ''; }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      return `<li><a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer" class="chat-artifact-link">${esc(artifact.label)} ↗</a><small>${esc(url.host)}</small></li>`;
    }
    return `<li><strong>${esc(artifact.label)}</strong><small>本地文件 · ${esc(endpoint)} · 未上传</small><code>${esc(artifact.path)}</code></li>`;
  }
  function renderRuns() {
    if (!model || !root?.querySelector('#chat-runs')) return;
    root.querySelector('#chat-run-scope').disabled = false;
    root.querySelector('#chat-run-filter').disabled = false;
    const scoped = taskRows();
    const active = r => ['queued', 'running', 'waiting_approval', 'cancelling'].includes(r.status);
    const done = r => r.status === 'completed' && !r.handoffError && !r.botTaskStopped && (r.report?.outcome === 'completed' || r.nextRunId);
    const attention = r => Boolean(taskProblem(r)) || r.status === 'waiting_approval';
    const runs = scoped.filter(r => runFilter === 'all' || ({ active, attention, done, artifacts: r => r.report?.artifacts?.length > 0 }[runFilter])(r)).sort((a, b) => b.createdAt - a.createdAt);
    root.querySelector('#chat-tracker').hidden = scoped.length === 0;
    update('#chat-run-counts', '');
    update('#chat-runs', runs.slice(0, runLimit).map(r => {
      const state = runState(r), agent = model.bots?.find(b => b.id === r.botId)?.name || model.endpoints.find(e => e.id === r.endpointId)?.label || model.bots?.find(b => b.id === 'xiaoman')?.name || 'Mori';
      const conversation = model.conversations.find(c => c.id === r.conversationId)?.title || '对话';
      const artifacts = r.report?.artifacts || [], summary = readableReason(r.report?.summary || r.resultExcerpt);
      return `<article class="chat-tracked-run ${openRuns.has(r.id) ? 'expanded' : ''}" data-run="${esc(r.id)}" tabindex="-1"><div class="chat-run-heading"><h3>${esc(r.report?.title || r.title || '对话任务')}</h3><span class="chat-run-badge ${state.tone}">${esc(state.label)}</span></div><p class="chat-run-meta">${esc(agent)}${r.botPhase ? ' · ' + esc(({ reply: '回复同事', continuation: '接着处理', summary: '汇总' })[r.botPhase] || '') : ''} · ${esc(source[r.channel] || 'Web')} · ${esc(date(r.createdAt))}</p>${summary ? `<p class="chat-run-summary">${esc(summary)}</p>` : ''}${r.report && r.status !== 'completed' ? `<p class="chat-run-attribution">${esc({ completed: '已汇报完成', in_progress: '进行中', partial: '部分完成', blocked: '受阻' }[r.report.outcome])}</p>` : ''}${r.progress ? `<p class="chat-run-progress" role="status">${esc(r.progress.label)} · ${r.status === 'queued' ? '已等待' : '已用时'} ${r.progress.elapsedSeconds < 60 ? r.progress.elapsedSeconds + ' 秒' : Math.floor(r.progress.elapsedSeconds / 60) + ' 分 ' + r.progress.elapsedSeconds % 60 + ' 秒'}</p>` : ''}${r.issue?.state === 'resolved' ? `<p class="note">${r.issue.resolution.byRunId ? `<button class="text" data-open-run="${esc(r.issue.resolution.byRunId)}">查看续办记录</button>` : ''}</p>` : ''}${r.error ? `<p class="chat-run-error">${esc(readableReason(r.error) || '执行未完成，请展开执行记录核对。')}</p>` : ''}${view !== 'conversation' && artifacts.length ? `<ul class="chat-artifacts" aria-label="任务产物">${artifacts.map(a => artifactMarkup(a, agent)).join('')}</ul>` : ''}<div class="chat-run-actions">${r.issue?.state === 'open' ? `<button class="text" data-chat-action="resolve-run" data-id="${esc(r.id)}">接受当前结果</button>` : ''}${canRetryRun(r) ? `<button class="text" ${pending ? 'disabled' : ''} data-retry-run="${esc(r.id)}">带回草稿</button>` : ''}${(r.journalItemIds || []).map((itemId, index) => `<button class="text" data-page="journal" data-journal-item="${esc(itemId)}">打开手账${r.journalItemIds.length > 1 ? ' ' + (index + 1) : ''} ↗</button>`).join('')}<button class="text" data-open-run="${esc(r.id)}">打开对话</button>${['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling'].includes(r.status) ? `<button class="text" data-chat-action="cancel" data-id="${esc(r.activeRun?.id || r.id)}">${['uncertain', 'cancelling'].includes(r.status) ? '核对执行状态' : '取消执行'}</button>` : ''}<button class="text" data-run-details="${esc(r.id)}" aria-expanded="${openRuns.has(r.id)}" aria-controls="run-detail-${esc(r.id)}">${openRuns.has(r.id) ? '收起记录' : '执行记录'}</button></div><div id="run-detail-${esc(r.id)}" class="chat-run-detail" ${openRuns.has(r.id) ? '' : 'hidden'}><p>执行助手：${esc(agent)} · 所属对话：${esc(conversation)}</p><p>创建 ${esc(date(r.createdAt))} · 开始 ${esc(date(r.startedAt))} · 结束 ${esc(date(r.finishedAt))}</p>${r.report ? `<p>最近汇报：${esc(date(r.report.updatedAt))}。完成情况由 Agent 汇报。</p>` : ''}<p>任务编号：<code>${esc(r.id)}</code></p>${r.error || r.recoveryRun?.error ? `<p>错误代码：<code>${esc(r.recoveryRun?.error || r.error)}</code></p>` : ''}</div></article>`;
    }).join('') || '<p class="note">暂无任务</p>');
    const more = root.querySelector('#chat-runs-more'); more.hidden = runs.length <= runLimit;
    more.textContent = `再显示 8 项（还有 ${Math.max(0, runs.length - runLimit)} 项）`;
  }
  function message(text) { if (root) root.querySelector('#chat-status').textContent = text; }
  function renderConnection() {
    const line = root?.querySelector('#chat-connectivity');
    if (!line) return;
    line.hidden = transportHealthy;
    line.innerHTML = transportHealthy ? '' : '<p>连接中断，正在重连。未确认的输入已保留。</p><button class="outline" data-chat-action="reconnect">重新连接</button>';
  }
  const update = (selector, html) => {
    const el = root?.querySelector(selector); if (!el || el.innerHTML === html) return;
    const details = ['#chat-truth', '#chat-endpoints', '#chat-channels'].includes(selector) ? new Map([...el.querySelectorAll('details')].map(d => [d.dataset.truthSection, d.open])) : new Map();
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    const truthFocus = focused?.closest('details')?.dataset.truthSection;
    const runFocus = focused?.closest('[data-run]')?.dataset.run;
    const dataset = focused ? JSON.stringify(focused.dataset) : null;
    el.innerHTML = html;
    if (['#chat-truth', '#chat-endpoints', '#chat-channels'].includes(selector)) {
      for (const d of el.querySelectorAll('details')) { d.open = Boolean(details.get(d.dataset.truthSection)); if (truthFocus && d.dataset.truthSection === truthFocus) d.querySelector('summary')?.focus({ preventScroll: true }); }
    } else if (runFocus) {
      const run = [...el.querySelectorAll('[data-run]')].find(r => r.dataset.run === runFocus);
      const target = run && [...run.querySelectorAll('button')].find(b => JSON.stringify(b.dataset) === dataset);
      (target || run)?.focus({ preventScroll: true });
    }

  };
  async function refresh() {
    if (!root) return;
    const current = generation, conversationId = selected;
    if (refreshTicket?.generation === current && refreshTicket.conversationId === conversationId) return refreshTicket.promise;
    const ticket = { generation: current, conversationId };
    refreshTicket = ticket;
    ticket.promise = (async () => {
      try {
        // Settings describes the device, not the tools in the last opened chat.
        const queryConversation = view === 'settings' ? '' : conversationId;
        const result = await api('hub' + (queryConversation ? '?conversation=' + encodeURIComponent(queryConversation) : '')); if (current !== generation || selected !== conversationId || !root) return false; model = result; transportHealthy = true;
        renderConnection();
        if (selected && !model.conversations.some(c => c.id === selected)) { selected = ''; mustChooseConversation = true; message('这段聊天暂不可用，请重新选择 Bot。'); }
        else if (!selected && !mustChooseConversation) selected = model.conversations[0]?.id || '';
        renderData(); return true;
      }
      catch (e) { if (current === generation && selected === conversationId && root) { transportHealthy = false; renderConnection(); if (model) renderData(); } return false; }
      finally { if (refreshTicket === ticket) refreshTicket = undefined; }
    })();
    return ticket.promise;
  }
  async function openRun(run) {
    const current = generation;
    drafts.set(draftKey(), root.querySelector('#chat-input').value); selected = run.conversationId;
    root.querySelector('#chat-input').value = drafts.get(draftKey()) || ''; persistDrafts(); renderData();
    // Run lists span conversations, but messages are fetched for only one.
    // Wait for that conversation's snapshot before locating its original input.
    const fresh = await refresh();
    if (current !== generation || !root || selected !== run.conversationId) return;
    if (!fresh) { message('暂时读不到这段对话，草稿已保留。连接恢复后再打开记录。'); return; }
    const target = root.querySelector(`#chat-message-${CSS.escape(run.messageId)}`);
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'center' }); }
    else message('这项任务的原始消息当前不可用，执行记录仍保留。');
  }
  async function retryRun(run) {
    const current = generation;
    drafts.set(draftKey(), root.querySelector('#chat-input').value); selected = run.conversationId;
    root.querySelector('#chat-input').value = drafts.get(draftKey()) || ''; persistDrafts(); renderData();
    const fresh = await refresh();
    if (current !== generation || !root || selected !== run.conversationId) return;
    if (!fresh) { message('暂时读不到原交代，已有草稿保留。连接恢复后再试。'); return; }
    if (pending) { message('正在保存当前操作，已有草稿保留。稍后再带回原交代。'); return; }
    const original = model.runs.some(value => value.id === run.id && canRetryRun(value)) && model.messages.find(value => value.id === run.messageId && value.role === 'user' && value.conversationId === run.conversationId);
    if (!original) { message('这项失败任务的原始交代当前不可用，已有草稿保留。'); return; }
    const input = root.querySelector('#chat-input');
    if (input.value.trim() && !confirm('这段对话有未发送的草稿。替换为这次失败任务的交代？')) return;
    agentSelections.set(draftKey(), run.botId || 'xiaoman'); drafts.set(draftKey(), original.text);
    if (original.attachments?.[0]) attachments.set(draftKey(), original.attachments[0]);
    input.value = original.text; persistDrafts(); renderData();
    message('已带回草稿，修改后发送。'); input.focus();
  }
  function renderAttachment() {
    const node = root?.querySelector('#chat-attachment'), value = attachments.get(draftKey());
    if (node) node.innerHTML = value ? `<span>${esc(value.name)}${value.complete === false ? ' · 部分文字' : ''}</span><button type="button" class="text" data-chat-action="remove-attachment" aria-label="移除所选资料">移除</button>` : '';
  }
  function renderSuggestion() {
    const node = root?.querySelector('#chat-draft-suggestion'); if (!node) return;
    node.hidden = !draftSuggestions.has(draftKey());
  }
  function offerDraft(content, references = {}) {
    if (typeof content !== 'string' || !content.trim()) return;
    const input = root?.querySelector('#chat-input'); if (!input) return;
    const addition = content.trim().slice(0, 16000);
    if (input.value.trim()) {
      draftSuggestions.set(draftKey(), { content: addition, references }); renderSuggestion(); return;
    }
    input.value = addition; drafts.set(draftKey(), addition); draftReferences.set(draftKey(), references); persistDrafts(); if (!preparingDraft) input.focus();
  }
  async function revealMessage({ conversationId = selected, messageId } = {}) {
    if (!messageId || !root) return false;
    const current = generation;
    if (conversationId !== selected) await open({ conversationId });
    if (!root || current !== generation || selected !== conversationId) return false;
    let target = visibleMessages().find(value => value.id === messageId);
    if (!target) {
      try {
        const result = await api('hub/message?messageId=' + encodeURIComponent(messageId));
        if (!root || current !== generation || selected !== conversationId) return false;
        const resolved = result.resolvedConversationId || result.conversationId;
        if (result.message?.id !== messageId || (result.message.conversationId !== conversationId && resolved !== conversationId)) throw new Error('原文不属于这段聊天。');
        target = { ...result.message, conversationId };
        locatedMessages.set(messageId, target);
      } catch { message('这条原文已不可用，未跳到其他消息。'); return false; }
    }
    revealedMessageId = messageId; followMessages = false; renderData();
    const node = root.querySelector(`#chat-message-${CSS.escape(messageId)}`);
    if (!node) { message('这条原文当前不可用，未跳到其他消息。'); return false; }
    node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'center', behavior: 'instant' });
    clearTimeout(revealTimer); revealTimer = setTimeout(() => { if (revealedMessageId === messageId) { revealedMessageId = ''; node.classList?.remove('is-located'); } }, 1800);
    followMessages = false; captureReadingPosition(); message(''); return true;
  }
  function renderData() {
    renderAttachment();
    const attach = root.querySelector('#chat-attach'); if (attach) attach.disabled = pending || !selected || !transportHealthy;
    if (view === 'settings') { renderSettings(); return; }
    if (selected && model.conversations.some(c => c.id === selected)) mustChooseConversation = false;
    rememberConversation();
    update('#chat-truth', window.PATruth.render(model.truth));
    const conversation = model.conversations.find(c => c.id === selected), endpoint = model.endpoints.find(e => e.id === conversation?.endpointId);
    const hasAgent = model.endpoints.some(e => e.active);
    const tasks = taskRows().filter(inConversation).sort((a, b) => b.createdAt - a.createdAt);
    const activeTask = tasks.find(run => ['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling'].includes(run.status));
    const stage = activeTask?.activeRun?.progress?.stage;
    const phase = { reading_sources: '正在读取资料', sources_returned: '正在整理资料', source_failed: '资料读取需检查' }[stage] || (activeTask?.status === 'queued' ? '等待处理' : '正在处理');
    update('#chat-endpoint', activeTask && ['queued', 'running'].includes(activeTask.status) ? `<span class="chat-running" role="status">${phase}</span>` : '');
    const messages = visibleMessages(), recoveryByMessage = new Map(), unattachedProblems = [];
    for (const task of tasks) {
      if (!taskProblem(task)) continue;
      const runIds = new Set(task.members.map(run => run.id));
      const target = [...messages].reverse().find(message => message.rootRunId === task.id || runIds.has(message.runId) || message.id === task.messageId);
      if (target) recoveryByMessage.set(target.id, task); else unattachedProblems.push(task);
    }
    update('#chat-run-notice', unattachedProblems.map(recoveryMarkup).join(''));
    const select = root.querySelector('#chat-endpoint-select'), prior = preferredNewEndpoint || select?.value;
    update('#chat-endpoint-select', model.endpoints.filter(e => e.active).map(e => `<option value="${esc(e.id)}">${esc(e.label)} · ${esc(e.provider)}</option>`).join(''));
    if (select && [...select.options].some(o => o.value === prior)) { select.value = prior; preferredNewEndpoint = ''; }
    const agentSelect = root.querySelector('#chat-agent-select');
    const directRoom = roomKind === 'direct' && !journalItemId;
    const selectedAgent = directRoom ? roomBotId || conversation?.botId || 'xiaoman' : conversation ? agentSelections.get(draftKey()) || conversation.botId || 'xiaoman' : 'xiaoman';
    update('#chat-agent-select', (model.bots || []).filter(b => b.active).map(b => `<option value="${esc(b.id)}">${roomKind === 'group' && b.id === 'xiaoman' ? '自动分派' : esc(b.name)}${!b.connected ? ' · 待连接' : !b.online ? ' · 离线' : ''}</option>`).join(''));
    if (![...agentSelect.options].some(o => o.value === selectedAgent)) {
      const unavailable = document.createElement('option'); unavailable.value = ''; unavailable.disabled = true;
      unavailable.textContent = '原 Bot 已停用，请重新选择'; agentSelect.prepend(unavailable); agentSelect.value = '';
    } else agentSelect.value = selectedAgent;
    const choice = root.querySelector('.chat-agent-choice');
    if (choice) choice.hidden = directRoom;
    const composer = root.querySelector('#chat-compose');
    composer.dataset.direct = String(directRoom);
    const botName = model.bots?.find(bot => bot.id === selectedAgent)?.name || 'Bot';
    const input = root.querySelector('#chat-input');
    input.placeholder = directRoom ? `发给${botName}…` : roomKind === 'group' ? '发给全员群，@ 点名' : '继续聊…';
    input.setAttribute('aria-label', directRoom ? `发给${botName}的消息` : roomKind === 'group' ? '发给全员群的消息' : '继续对话');
    const list = root.querySelector('#chat-messages'), atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    const reading = captureReadingPosition();
    let previousDay = '';
    const messageMarkup = messages.map(m => {
      const timestamp = effectiveTime(m), validTime = timestamp > 0, time = validTime ? new Date(timestamp) : null;
      const day = time ? time.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '时间未知';
      const separator = day !== previousDay ? `<div class="chat-date-separator">${esc(day)}</div>` : ''; previousDay = day;
      const channel = m.origin?.channel || m.channel;
      const delivery = m.delivery || model.deliveries.find(d => d.id === m.id);
      const deliveryText = delivery ? deliveryLabels[delivery.state] || '送达状态待确认' : '';
      const shownChannel = m.role === 'assistant' && imChannel(delivery?.channel) ? delivery.channel : channel;
      const channelAttribute = imChannel(shownChannel) ? ` data-channel="${shownChannel}"` : '';
      const origin = sourceMarker(channel, m.role, delivery);
      const stamp = time ? `<time datetime="${time.toISOString()}" title="${esc(time.toLocaleString('zh-CN'))}">${esc(time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}</time>` : '<span>时间未知</span>';
      return `${separator}<article id="chat-message-${esc(m.id)}" data-message-id="${esc(m.id)}"${channelAttribute} tabindex="-1" class="chat-message ${m.role === 'user' ? 'from-user' : ''}${revealedMessageId === m.id ? ' is-located' : ''}"><div class="chat-message-meta">${m.role === 'assistant' ? window.PABots?.avatar(model.bots?.find(b => b.id === m.botId)) || '' : ''}<span>${m.role === 'user' ? '你' : esc(model.bots?.find(b => b.id === m.botId)?.name || model.bots?.find(b => b.id === 'xiaoman')?.name || 'Mori')}</span>${origin}${stamp}</div><div class="chat-message-text pa-prose" data-message-body="${esc(m.id)}">${esc(m.text)}</div>${m.attachments?.length ? `<p class="chat-attachment">${m.attachments.map(a => esc(a.name)).join('、')}</p>` : ''}${deliveryText ? `<small class="chat-delivery ${['unknown', 'failed'].includes(delivery.state) ? 'needs-attention' : ''}">${delivery.channel && !imChannel(delivery.channel) ? esc(source[delivery.channel] || delivery.channel) + ' ' : ''}${esc(deliveryText)}</small>` : ''}${recoveryByMessage.has(m.id) ? recoveryMarkup(recoveryByMessage.get(m.id), m.text) : ''}</article>`;
    }).join('') || '<div class="chat-empty"><p>暂无消息</p></div>';
    if (list.dataset.messageMarkup !== messageMarkup) {
      const previousIds = new Set((list.dataset.messageIds || '').split(' ').filter(Boolean));
      const sameConversation = list.dataset.conversation === selected;
      const focusedId = list.contains(document.activeElement) ? document.activeElement?.closest('[data-message-id]')?.dataset.messageId : null;
      window.PAJournalSurfaces?.clearReports(list);
      list.innerHTML = `<div class="chat-message-content">${messageMarkup}</div>`; list.dataset.messageMarkup = messageMarkup;
      list.dataset.messageIds = messages.map(message => message.id).join(' '); list.dataset.conversation = selected;
      followMessages = sameConversation ? atBottom : readingPositions.get(draftKey())?.bottom ?? true; messageObserver?.disconnect();
      if (typeof ResizeObserver !== 'undefined' && list.firstElementChild) {
        messageObserver = new ResizeObserver(() => { if (!list.isConnected) return; if (followMessages) list.scrollTop = list.scrollHeight; else restoreReadingPosition(); });
        messageObserver.observe(list.firstElementChild);
      }
      for (const message of messages) {
        if (message.role === 'assistant') window.PAJournalSurfaces?.renderReport(list.querySelector(`[data-message-body="${CSS.escape(message.id)}"]`), message.text);
        if (sameConversation && !previousIds.has(message.id)) window.PAMotion?.play(list.querySelector(`#chat-message-${CSS.escape(message.id)}`), 'enter');
      }
      if (followMessages) list.scrollTop = list.scrollHeight;
      else restoreReadingPosition(sameConversation ? reading : undefined);
      if (focusedId) list.querySelector(`#chat-message-${CSS.escape(focusedId)}`)?.focus({ preventScroll: true });
    }
    update('#chat-approvals', model.approvals.filter(a => inConversation(a) && (!journalItemId || visibleRuns().some(run => run.id === a.runId)) && ['pending', 'deferred'].includes(a.state)).map(a => `<section class="chat-approval"><h3>${esc(a.action?.title || '这项操作需要先核对')}</h3><p>${esc(a.action?.preview || '缺少完整动作预览，请拒绝后重新交代。')}</p><p class="note">${a.state === 'deferred' ? '已延后决定' : '等你决定'} · ${esc(date(a.expiresAt))} 前有效 · 参数改变需重新确认</p><div class="actions">${a.action?.approvable ? `<button class="primary" data-chat-action="approve" data-id="${esc(a.id)}">批准这一次</button>` : `<button class="outline" data-chat-action="accept_limit" data-id="${esc(a.id)}">接受限制，继续整理</button>`}<button class="outline" data-chat-action="reject" data-id="${esc(a.id)}">拒绝</button><button class="text" data-chat-action="defer" data-id="${esc(a.id)}">延后</button></div><details><summary>调试详情</summary><pre>${esc(JSON.stringify({ tool: a.toolName, parameters: a.action?.parameters, fingerprint: a.action?.fingerprint }, null, 2))}</pre></details></section>`).join(''));
    renderRuns();
    root.querySelector('#chat-compose textarea').disabled = !conversation || preparingDraft;
    root.querySelector('#chat-send').disabled = !conversation || !agentSelect.value || pending || !transportHealthy || Boolean(roomKind && !model.bots?.find(bot => bot.id === selectedAgent)?.connected);
    root.querySelector('#chat-send').textContent = pending ? uploading ? '读取中…' : '发送中…' : '发送';
    agentSelect.disabled = preparingDraft;
    if (!directRoom) window.PAJournalSurfaces?.enhanceBotSelect(agentSelect, { bots: model.bots || [], label: '发送给' });
    else window.PAJournalSurfaces?.clearBotSelect(agentSelect);
    const uncertain = model.deliveries.some(d => inConversation(d) && ['unknown', 'failed'].includes(d.state) && !messages.some(message => message.id === d.id) && !journalItemId);
    root.querySelector('#chat-delivery-note').textContent = uncertain ? '有外部消息未确认送达，未自动重发。' : '';
    renderSuggestion();
  }
  function agentStatus(endpoint) {
    const truth = model.truth?.agents?.find(agent => agent.id === endpoint.id);
    if (truth?.authentication === 'required') return '需重新登录';
    if (truth?.authentication === 'missing') return '程序未安装';
    if (truth?.authorization === 'expired') return '授权已过期';
    if (!endpoint.online) return '离线';
    if (truth?.missingTools?.length) return '工具待验证';
    return endpoint.online ? '在线' : '离线';
  }
  function agentHelp(endpoint) {
    const truth = model.truth?.agents?.find(agent => agent.id === endpoint.id);
    if (truth?.authentication === 'required') return '在运行 Agent 的电脑上重新登录 CLI，再回这里核对状态。';
    if (truth?.authentication === 'missing') return '在运行 Agent 的电脑上安装 CLI，再启动连接助手。';
    if (truth?.authorization === 'expired') return '执行端授权已过期，请在该电脑上恢复授权。';
    if (!endpoint.online) return '让执行电脑保持联网，并启动 Morlet 连接助手；已有交代会保留。';
    if (truth?.missingTools?.length) return '尚未验证任务工具。回手账完成一次交代后，会更新验证结果。';
    return '';
  }
  function settingsMarkup(options) {
    const endpoint = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? location.origin : '';
    const address = (prefix, computer = '执行电脑') => `<label for="${prefix}-endpoint">Morlet 服务地址<input id="${prefix}-endpoint" name="endpoint" type="url" required value="${esc(endpoint)}" aria-describedby="${prefix}-address-help" placeholder="HTTPS 地址或本地 SSH 隧道地址"></label><p class="note" id="${prefix}-address-help">${endpoint ? `${computer}须能访问此地址。` : '此页面使用内网 HTTP。请使用部署方提供的 HTTPS 地址，或执行电脑上已建立的 SSH 隧道地址。'}</p>`;
    const manualAgent = `<ol class="chat-connection-steps"><li>在执行任务的 Mac 安装并登录 Codex 或 WorkBuddy。</li><li>填写这台 Mac 的信息，生成连接配置。</li><li>下载配置，在该 Mac 的 Morlet 项目中双击 <code>scripts/connect.command</code>，选择文件；回这里确认在线。</li></ol><form id="chat-pair"><div class="chat-setup-grid"><label>电脑名称<input name="label" required maxlength="80" placeholder="我的 Mac"></label><label>Agent<select name="provider"><option value="codex">Codex</option><option value="workbuddy">WorkBuddy</option></select></label><label class="chat-field-wide">Mac 上的工作目录<input name="workspace" required placeholder="已有目录的绝对路径" autocomplete="off"></label></div>${address('chat-agent')}<details class="chat-advanced"><summary>自定义 CLI 命令</summary><label>CLI 命令<input name="command" value="codex" required></label></details><p class="note">凭据留在执行电脑。需要审批的操作仍由你确认。</p><button class="outline" type="submit">生成连接配置</button></form><div id="chat-pair-result"></div>`;
    return `<section class="chat-settings" id="chat-settings">
      <h2>消息渠道</h2><div id="chat-channel-status"></div>
      <details class="chat-setup" id="chat-weixin-setup"><summary>微信消息归属</summary><div id="chat-weixin-bindings"></div><form id="chat-bind-form"><label>新来信接到<select id="chat-bind-conversation"></select></label><label>已配对的微信用户<select id="chat-weixin-peer"></select></label><button class="outline" id="chat-bind">绑定对话</button></form><p class="note">先绑定来信，再单独确认本人身份；回复原路返回。</p></details>
      <h2 class="settings-agents-title">执行 Agent</h2><div id="chat-endpoints"></div>
      <details class="chat-setup" id="chat-agent-setup"><summary>连接 Agent</summary>${options.localAgentAvailable ? `<form id="chat-local-pair"><p class="note">先在这台 Mac 登录所选 CLI，再连接。</p><div class="chat-setup-grid"><label>Agent<select name="localProvider"><option value="codex">Codex</option><option value="workbuddy">WorkBuddy</option></select></label><label>工作目录（选填）<input name="localWorkspace" placeholder="留空使用 Morlet 专用目录" autocomplete="off"></label></div><button class="primary" type="submit">连接这台 Mac</button></form><p id="chat-local-result" class="note" role="status" aria-live="polite"></p><details class="chat-advanced"><summary>连接另一台 Mac</summary>${manualAgent}</details>` : manualAgent}</details>
      <details class="chat-setup" id="chat-imessage-setup"><summary>连接 iMessage</summary><div id="chat-channels"></div>
      <details class="chat-advanced" id="chat-imessage-new"><summary>连接其他私聊</summary><ol class="chat-connection-steps"><li>在收发消息的 Mac，用 Mori 专用 Apple 账户登录「信息」，从你的手机发一条消息给它。</li><li>在这台 Mac 安装 <code>imsg</code>，允许后台助手读取消息并控制「信息」。</li><li>填好下面的信息并下载配置，在该 Mac 的 Morlet 项目中双击 <code>scripts/connect.command</code>，选择文件；回这里确认收发桥在线。</li></ol>
      <form id="chat-channel-pair"><label>新来信接到<select id="chat-channel-conversation" name="conversationId" required></select></label><div class="chat-setup-grid"><label>Mori 的收信地址<input name="botAddress" required placeholder="专用账户的 iMessage 号码或邮箱" autocomplete="off"></label><label>你的发信地址<input name="peer" required placeholder="你实际发信的号码或邮箱" autocomplete="off"></label></div>${address('chat-message', '收发消息的 Mac')}<details class="chat-advanced"><summary>指定私聊</summary><label>私聊编号（选填）<input name="chatId" type="number" min="1" placeholder="留空按发信人查找"></label></details><p class="note">双方地址须不同。只处理绑定后发来的文字，回复原路返回；历史消息不导入。</p><button class="outline" type="submit">生成 iMessage 配置</button></form><div id="chat-channel-result"></div></details></details>
      <p id="chat-sources" class="note" hidden></p></section>`;
  }
  function renderSettings() {
    const newChannel = root.querySelector('#chat-imessage-new');
    if (newChannel && !(model.channels || []).some(c => c.active && c.channel === 'imessage')) newChannel.open = true;
    const picker = root.querySelector('#chat-bind-conversation');
    const prior = picker.value || selected;
    update('#chat-bind-conversation', '<option value="">选择手账中的对话</option>' + model.conversations.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join(''));
    picker.value = model.conversations.some(c => c.id === prior) ? prior : '';
    selected = picker.value;
    const channelPicker = root.querySelector('#chat-channel-conversation');
    const channelPrior = channelPicker.value;
    update('#chat-channel-conversation', `<option value="">${model.conversations.length ? '选择手账中的对话' : '先在手账开始一件事'}</option>` + model.conversations.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join(''));
    channelPicker.value = model.conversations.some(c => c.id === channelPrior) ? channelPrior : '';
    const peers = runtime?.accounts?.flatMap(a => a.users.map(u => ({ account: a.account, id: u.id }))) || [];
    update('#chat-weixin-peer', peers.map(p => `<option value="${esc(p.account + ':' + p.id)}">${esc(p.id)}</option>`).join(''));
    update('#chat-weixin-bindings', (model.bindings || []).filter(binding => binding.channel === 'weixin').map(binding => `<div class="chat-owner-binding"><span>${esc(binding.peer)}</span>${ownerBindingMarkup(binding)}</div>`).join(''));
    root.querySelector('#chat-bind').disabled = !selected || !peers.length || pending;
    const labels = { connected: '已连接', online: '在线', available: '可用', enabled: '可用', offline: '离线', disconnected: '未连接', needs_attention: '需要处理', disabled: '已停用', unconfigured: '未配置', unpaired: '未连接', unknown: '状态待确认' };
    const channels = model.truth?.channels || [];
    update('#chat-channel-status', channels.map(c => `<div class="settings-status-row"><strong>${esc(source[c.id] || c.id)}</strong><span class="c-state c-state-${c.state === 'connected' || c.state === 'online' || c.state === 'available' || c.state === 'enabled' ? 'connected' : 'offline'}">${esc(labels[c.state] || (c.configured ? '状态待确认' : '未配置'))}${c.context?.state === 'expired' ? ' · 会话已过期' : ''}</span>${['weixin', 'imessage'].includes(c.id) ? `<button class="text" data-settings-channel="${esc(c.id)}">管理</button>` : ''}</div>`).join(''));
    update('#chat-channels', (model.channels || []).filter(c => c.active && c.channel === 'imessage').map(c => {
      const binding = model.bindings.find(b => b.channel === 'imessage' && b.account === c.id && b.peer === c.peer);
      const conversation = model.conversations.find(item => item.id === binding?.conversationId);
      return `<div class="chat-run"><span>你：${esc(c.peer)}<small>Mori：${esc(c.botAddress || '')}</small><small>会话：${esc(conversation?.title || '尚未绑定')}</small><small>${c.online ? '收发桥在线' : c.error && c.connected ? esc(channelErrors[c.error] || '收发桥需要检查，请查看本机状态') : c.lastSeen ? '收发桥离线，等待恢复' : '等待连接收发 Mac'}${c.lastInboundAt ? ' · 最近收信 ' + new Date(c.lastInboundAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}</small></span>${c.error === 'IMESSAGE_DATABASE_CHANGED' ? `<details class="chat-advanced" data-truth-section="recover-${esc(c.id)}"><summary>恢复收发</summary><p>核对原来的双方地址与私聊后，从恢复时的新消息继续。旧消息不导入，送达不明的回复不重发。</p>${c.pendingInputs ? '<p role="status">还有未提交来信，请先在收发 Mac 核对。</p>' : c.recovery?.expiresAt > Date.now() ? '<p role="status">等待 Mac 核对绑定…</p>' : c.recoveryFingerprint && c.connected ? `<button class="outline" data-chat-action="recover-channel" data-id="${esc(c.id)}">核对并恢复</button>` : '<p>请在收发 Mac 更新并启动 Morlet 连接助手。</p>'}</details>` : ''}${ownerBindingMarkup(binding)}<button class="text danger" data-chat-action="revoke-channel" data-id="${esc(c.id)}">断开授权</button></div>`;
    }).join(''));
    update('#chat-endpoints', model.endpoints.filter(e => e.active).map(e => {
      const label = agentStatus(e), help = agentHelp(e);
      return `<div class="settings-agent-row"><div class="settings-status-row"><strong>${esc(e.label)}</strong><span class="c-state c-state-${label === '在线' ? 'connected' : 'offline'}">${esc(label)}</span><details data-truth-section="${esc(e.id)}"><summary>管理</summary><button class="text danger" data-chat-action="revoke" data-id="${esc(e.id)}">断开授权</button></details></div>${help ? `<p class="settings-connection-help">${esc(help)}</p>` : ''}</div>`;
    }).join('') || '<p class="note">尚未连接执行 Agent。</p>');
    const sourceLine = root.querySelector('#chat-sources');
    if (sourceLine) {
      const actions = model.localSources?.actions || [];
      const names = [['mail_read', '邮件'], ['calendar_events', '日历'], ['drive_search', '云端文档'], ['contacts_search', '联系人'], ['github_repositories', 'GitHub'], ['file_read', '本地文件']].filter(([action]) => actions.includes(action)).map(([, label]) => label);
      sourceLine.textContent = names.length ? (model.localSources?.location === 'paired_local_agent' ? model.localSources.online ? '通过 Mac 读取：' : '等待 Mac 上线：' : '已启用读取：') + names.join(' · ') : '';
      sourceLine.hidden = true;
    }
  }
  function ownerBindingMarkup(binding) {
    if (!binding?.id) return '';
    return `<div class="chat-owner-control"><small>${binding.ownerVerified ? '本人 · 与网页共享聊天' : '独立聊天 · 尚未确认本人'}</small><button type="button" class="text" ${pending ? 'disabled' : ''} data-chat-action="${binding.ownerVerified ? 'revoke-owner-route' : 'verify-owner-route'}" data-id="${esc(binding.id)}">${binding.ownerVerified ? '取消本人绑定' : '这是我本人'}</button></div>`;
  }
  function mount(options) {
    api = options.api; runtime = options.runtime;
    if (root === options.root && root.querySelector('.chat-center') && journalItemId === options.journalItemId && journalDraft === Boolean(options.journalDraft) && roomKind === options.roomKind && (!options.conversationId || selected === options.conversationId)) { if (model) renderData(); return; }
    unmount(); root = options.root; generation++; view = options.view || 'conversation'; onConversation = options.onConversation; onItemSaved = options.onItemSaved; journalItemId = options.journalItemId; journalDraft = Boolean(options.journalDraft); roomKind = options.roomKind; roomBotId = options.botId;
    if (options.conversationId) selected = options.conversationId;
    if (view === 'conversation') runScope = 'current';
    const connection = '<div id="chat-connectivity" class="pause-note" role="status" aria-live="polite" hidden></div>';
    const content = view === 'settings' ? settingsMarkup(options) : `<div id="chat-approvals"></div><div class="chat-main"><div id="chat-endpoint" class="chat-endpoint"></div><div id="chat-run-notice" role="status"></div><div id="chat-messages" class="chat-messages" role="log" aria-label="对话记录" aria-live="polite"></div><p id="chat-delivery-note" class="note"></p><form id="chat-compose"><label class="sr-only" for="chat-input">消息</label><textarea id="chat-input" rows="3" maxlength="16000" placeholder="继续聊…" required></textarea><div id="chat-attachment" class="chat-attachment" role="status"></div><div id="chat-draft-suggestion" class="chat-draft-suggestion" hidden><span>已保留原草稿</span><button type="button" class="text" data-chat-action="append-draft">追加交代</button><button type="button" class="text" data-chat-action="dismiss-draft">忽略</button></div><div class="chat-compose-footer"><input id="chat-file" type="file" accept=".pdf,.docx,.txt,.md,.csv,.json" hidden><button type="button" class="text" id="chat-attach" data-chat-action="attach" aria-label="选择本次任务的资料" title="选择资料（PDF、DOCX 或文字文件，10 MiB 内）">附件</button><label class="chat-agent-choice"><span class="sr-only">发送给</span><select id="chat-agent-select" aria-label="发送给"></select></label><button class="primary" type="submit" id="chat-send">发送</button></div></form></div><details class="chat-tracker" id="chat-tracker"><summary><span id="chat-tracker-title">任务</span><span id="chat-run-counts" class="note" role="status"></span></summary><div class="chat-tracker-head"><div class="chat-run-filters"><label hidden>范围<select id="chat-run-scope"><option value="all">所有对话</option><option value="current">当前对话</option></select></label><label>状态<select id="chat-run-filter"><option value="all">全部任务</option><option value="active">进行中</option><option value="attention">待关注</option><option value="done">已完成</option><option value="artifacts">有产物</option></select></label></div></div><div id="chat-runs" class="chat-run-list"></div><button class="outline" id="chat-runs-more" data-chat-action="more-runs" hidden>显示更多</button></details>`;
    root.innerHTML = `<section class="chat-center ${view === 'settings' ? 'chat-settings-view' : 'chat-conversation'}">${connection}${content}<p id="chat-status" class="note" role="status" aria-live="polite"></p></section>`;
    root.addEventListener('click', click); root.addEventListener('submit', submit); root.addEventListener('input', input); root.addEventListener('change', change);
    root.querySelectorAll('#chat-run-scope, #chat-run-filter, #chat-input, #chat-send, #chat-new, #chat-bind').forEach(el => { el.disabled = true; });
    followMessages = true; root.querySelector('#chat-messages')?.addEventListener('scroll', scrollMessages, { passive: true });
    const composeInput = root.querySelector('#chat-input'); if (composeInput) composeInput.value = drafts.get(draftKey()) || '';
    const scope = root.querySelector('#chat-run-scope'); if (scope) { scope.value = runScope; root.querySelector('#chat-run-filter').value = runFilter; }
    window.PABots?.mentions(root.querySelector('#chat-input'));
    timer = setInterval(refresh, 1500); void refresh();
  }
  function unmount() {
    captureReadingPosition();
    clearTimeout(revealTimer); revealedMessageId = '';
    messageObserver?.disconnect(); messageObserver = null; root?.querySelector('#chat-messages')?.removeEventListener('scroll', scrollMessages);
    generation++; clearInterval(timer); pending = false; preparingDraft = false;
    if (root?.querySelector('#chat-input')) drafts.set(draftKey(), root.querySelector('#chat-input').value);
    if (root?.querySelector('#chat-messages')) window.PAJournalSurfaces?.clearReports(root.querySelector('#chat-messages'));
    window.PAJournalSurfaces?.clearBotSelect(root?.querySelector('#chat-agent-select'));
    persistDrafts(); transportHealthy = false;
    root?.removeEventListener('click', click); root?.removeEventListener('submit', submit); root?.removeEventListener('input', input); root?.removeEventListener('change', change); root = null; setupDirtyForms.clear(); pendingDownloads.clear();
    for (const url of downloadURLs.values()) URL.revokeObjectURL(url); downloadURLs.clear();
  }
  function input(e) { if (e.target.id === 'chat-input') { drafts.set(draftKey(), e.target.value); persistDrafts(); } else if (['chat-pair', 'chat-channel-pair', 'chat-local-pair'].includes(e.target.closest('form')?.id)) setupDirtyForms.add(e.target.closest('form').id); }
  function change(e) {
    input(e);
    if (e.target.id === 'chat-file') {
      const file = e.target.files?.[0], target = selected, key = draftKey(), current = generation;
      if (!file) return;
      uploading = true;
      void work(async () => {
        if (file.size > 10 * 1024 * 1024) throw new Error('资料不能超过 10 MiB。');
        message('正在读取资料…');
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const saved = await api('attachments', { conversationId: target, name: file.name, base64: btoa(binary), requestId: requestId() });
        attachments.set(key, saved); persistDrafts();
        if (current === generation) renderAttachment();
        return saved.complete === false ? '仅提取到部分文字。' : '';
      }).finally(() => { uploading = false; });
      e.target.value = '';
    }
    if (e.target.id === 'chat-bind-conversation') { selected = e.target.value; renderData(); }
    if (e.target.id === 'chat-agent-select') { agentSelections.set(draftKey(), e.target.value); renderData(); }
    if (e.target.name === 'provider') root.querySelector('[name=command]').value = e.target.value === 'codex' ? 'codex' : 'codebuddy';
    if (e.target.id === 'chat-run-scope') { runScope = e.target.value; runLimit = 8; renderRuns(); }
    if (e.target.id === 'chat-run-filter') { runFilter = e.target.value; runLimit = 8; renderRuns(); }
  }
  async function work(fn) {
    if (pending) return; pending = true;
    const focus = document.activeElement, current = generation;
    let notice;
    if (model && root) renderData();
    try { notice = await fn(); message(typeof notice === 'string' ? notice : ''); await refresh(); }
    catch (e) { message(errors[e.code] || e.message); }
    finally {
      pending = false; if (model && root) renderData();
      if (notice?.journalItemId && current === generation && root) void onItemSaved?.(notice.journalItemId);
      if (current === generation && root && focus && !focus.isConnected && document.activeElement === document.body) {
        const input = root.querySelector('#chat-input'), fallback = input && !input.disabled ? input : root.querySelector('h1');
        if (fallback) { if (fallback.tagName !== 'TEXTAREA') fallback.tabIndex = -1; fallback.focus({ preventScroll: true }); }
      }
    }
  }
  function click(e) {
    const summary = e.target.closest('summary');
    if (summary && root?.contains(summary) && window.PAMotion) { e.preventDefault(); e.stopPropagation(); window.PAMotion.toggle(summary.parentElement); return; }
    const b = e.target.closest('button'); if (!b || !root?.contains(b)) return;
    if (b.dataset.settingsChannel) {
      const id = b.dataset.settingsChannel;
      if (id === 'weixin') { const binding = root.querySelector('#chat-weixin-setup'); if (binding) binding.open = true; const target = document.querySelector('#weixin-setup'); if (target) { for (let p = target.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true; target.scrollIntoView({ block: 'start' }); } return; }
      const target = root.querySelector(id === 'imessage' ? '#chat-imessage-setup' : '#chat-agent-setup');
      if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); target.querySelector('summary')?.focus(); }
      return;
    }
    if (b.dataset.chatAction === 'reconnect') { void refresh(); return; }
    if (pending && (b.dataset.conversation || b.dataset.openRun || b.dataset.chatAction === 'new')) { message('正在保存当前操作，请稍候再切换对话。'); return; }
    if (b.dataset.retryRun) {
      if (pending) return;
      const run = model.runs.find(value => value.id === b.dataset.retryRun);
      if (canRetryRun(run)) void retryRun(run); return;
    }
    if (b.dataset.runDetails) {
      const id = b.dataset.runDetails;
      if (openRuns.has(id)) openRuns.delete(id); else openRuns.add(id);
      renderRuns(); root.querySelector(`[data-run-details="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); return;
    }
    if (b.dataset.openRun) {
      const run = model.runs.find(r => r.id === b.dataset.openRun); if (!run) return;
      void openRun(run); return;
    }
    if (b.dataset.chatAction === 'more-runs') { runLimit += 8; renderRuns(); return; }
    const action = b.dataset.chatAction;
    if (action === 'dismiss-draft') { draftSuggestions.delete(draftKey()); renderSuggestion(); return; }
    if (action === 'append-draft') {
      if (pending) return;
      const suggestion = draftSuggestions.get(draftKey()); if (!suggestion) return;
      const input = root.querySelector('#chat-input'), combined = [input.value.trim(), suggestion.content].filter(Boolean).join('\n\n');
      if (combined.length > 16000) { message('合并后超过 16000 字，请先精简草稿。'); return; }
      const existing = draftReferences.get(draftKey()) || {};
      if (existing.guideSourceId && suggestion.references.guideSourceId && existing.guideSourceId !== suggestion.references.guideSourceId) { message('原草稿已引用另一份资料，请先完成或清空它。'); return; }
      input.value = combined; drafts.set(draftKey(), combined);
      draftReferences.set(draftKey(), { ...existing, ...suggestion.references, sourceRefs: [...new Map([...(existing.sourceRefs || []), ...(suggestion.references.sourceRefs || [])].map(ref => [ref.messageId, ref])).values()].slice(0, 8) });
      draftSuggestions.delete(draftKey()); persistDrafts(); renderSuggestion(); input.focus(); return;
    }
    if (action === 'attach') { if (!pending) root.querySelector('#chat-file').click(); return; }
    if (action === 'remove-attachment') { if (!pending) { attachments.delete(draftKey()); persistDrafts(); renderAttachment(); } return; } if (!action) return;
    void work(async () => {
      if (action === 'resolve-run') { const r = model.runs.find(r => r.id === b.dataset.id); if (!r?.issue || !confirm('接受这次结果并从待处理列表收起？原始失败或受阻记录会保留，尚未完成的工作不会自动继续。')) return; await api('hub', { operation: 'resolve-run', runId: r.id, conversationId: r.conversationId, fingerprint: r.issue.fingerprint, decision: 'accept_limit' }); }
      if (action === 'cancel') { const r = model.runs.find(r => r.id === b.dataset.id); const uncertain = ['uncertain', 'cancelling'].includes(r.status); if (uncertain && !confirm('请先在本地确认任务和子进程已经停止。只有确认停止后才能解除阻塞；未停止时请取消此操作。确认已停止？')) return; await api('hub', { operation: 'cancel', runId: b.dataset.id, confirmStopped: uncertain }); }
      if (['approve', 'reject', 'defer', 'accept_limit'].includes(action)) await api('hub', { operation: 'decide', approvalId: b.dataset.id, decision: action, fingerprint: model.approvals.find(a => a.id === b.dataset.id)?.action?.fingerprint, scope: 'once', conversationId: selected });
      if (action === 'revoke') { if (!confirm('断开后，这台电脑将不能再领取任务，正在执行的任务会收到取消请求。继续？')) return; await api('hub', { operation: 'revoke', endpointId: b.dataset.id }); }
      if (['verify-owner-route', 'revoke-owner-route'].includes(action)) {
        const verify = action === 'verify-owner-route';
        if (!confirm(verify ? '确认这是你本人的账号？此后的来信会与网页共享 Mori 私聊和上下文。允许联系不代表本人，请勿确认其他人的账号。' : '取消本人绑定？此后的来信将恢复独立上下文；既有聊天记录保留。')) return;
        await api('hub', { operation: action, bindingId: b.dataset.id });
      }
      if (action === 'revoke-channel') await api('hub', { operation: 'revoke-channel', channelId: b.dataset.id });
      if (action === 'recover-channel') { const channel = model.channels.find(c => c.id === b.dataset.id); if (channel) await api('hub', { operation: 'recover-channel', channelId: channel.id, fingerprint: channel.recoveryFingerprint }); }
      if (action === 'task') await api('hub', { operation: 'task', task: { operation: b.dataset.operation, taskId: b.dataset.id, version: Number(b.dataset.version), requestId: requestId() } });
    });
  }
  function submit(e) {
    if (!e.target.closest('.chat-center')) return; e.preventDefault();
    const form = e.target, submittedForm = formFingerprint(form);
    void work(async () => {
      if (form.id === 'chat-local-pair') {
        const button = form.querySelector('button'), result = root.querySelector('#chat-local-result');
        button.disabled = true; result.textContent = '正在检测 CLI 并安装连接助手…';
        try {
          const installed = await api('local-agents', { provider: form.elements.localProvider.value, workspace: form.elements.localWorkspace.value || null });
          preferredNewEndpoint = installed.endpointId;
          result.textContent = installed.note; if (formFingerprint(form) === submittedForm) setupDirtyForms.delete(form.id);
        } catch (error) { result.textContent = errors[error.code] || '安装尚未完成，请检查执行端状态后重试。'; throw error; }
        finally { button.disabled = false; }
      } else if (form.id === 'chat-compose') {
        const input = root.querySelector('#chat-input'), content = input.value.trim(), target = selected, key = draftKey();
        if (!content) return;
        if (!transportHealthy) throw new Error('连接尚未恢复，输入已保留。');
        const botId = root.querySelector('#chat-agent-select').value;
        if (!model.bots.some(b => b.id === botId && b.active)) throw Object.assign(new Error('执行端已断开，请重新选择。'), { code: 'ENDPOINT_UNAVAILABLE' });
        let request = sendRequests.get(key);
        if (!request || request.content !== content || request.botId !== botId || request.journalItemId !== journalItemId || request.attachmentId !== attachments.get(key)?.id) {
          request = { conversationId: target, botId, content, requestId: requestId(), ...draftReferences.get(key), ...(journalItemId && { journalItemId }), ...(attachments.get(key) && { attachmentId: attachments.get(key).id }) }; sendRequests.set(key, request);
        }
        drafts.set(key, input.value); persistDrafts();
        const saved = await api('hub', { operation: 'send', ...request, journal: Boolean(journalItemId || !roomKind) });
        if (input.value.trim() === content && selected === target) input.value = '';
        if (drafts.get(key)?.trim() === content) drafts.delete(key);
        if (sendRequests.get(key) === request) sendRequests.delete(key);
        attachments.delete(key); draftReferences.delete(key); renderAttachment(); persistDrafts();
        return saved?.journalItemId ? { journalItemId: saved.journalItemId } : '';
      } else if (form.id === 'chat-bind-form') {
        const value = root.querySelector('#chat-weixin-peer').value, split = value.indexOf(':');
        await api('hub', { operation: 'bind', channel: 'weixin', account: value.slice(0, split), peer: value.slice(split + 1), conversationId: selected });
      } else if (form.id === 'chat-task-add') {
        const title = form.elements.title.value.trim();
        if (!taskDraft || taskDraft.title !== title) taskDraft = { operation: 'add', title, requestId: requestId() };
        await api('hub', { operation: 'task', task: taskDraft });
        if (form.elements.title.value.trim() === title) form.reset(); taskDraft = null;
      } else if (form.id === 'chat-channel-pair') {
        const v = Object.fromEntries(new FormData(form));
        if (!v.conversationId || !model.conversations.some(c => c.id === v.conversationId)) throw new Error('请选择要接收 iMessage 的手账对话。');
        const paired = await api('hub', { operation: 'pair-channel', label: 'iMessage', peer: v.peer.trim(), botAddress: v.botAddress.trim(), conversationId: v.conversationId });
        downloadConfig('#chat-channel-result', { endpoint: v.endpoint, publicOrigin: location.origin, token: paired.token, channelId: paired.channelId, chatId: v.chatId ? Number(v.chatId) : undefined, botAddress: v.botAddress.trim().toLowerCase(), peer: v.peer.trim().toLowerCase(), command: 'imsg' }, 'imessage', submittedForm);
      } else if (form.id === 'chat-pair') {
        const v = Object.fromEntries(new FormData(form));
        const paired = await api('hub', { operation: 'pair', label: v.label, provider: v.provider });
        const config = { endpoint: v.endpoint, publicOrigin: location.origin, token: paired.token, endpointId: paired.endpointId, provider: v.provider, command: v.command, workspace: v.workspace, label: v.label, timeout_seconds: 300 };
        downloadConfig('#chat-pair-result', config, 'agent', submittedForm);
      }
    });
  }
  function downloadConfig(selector, config, kind, submittedForm) {
    pendingDownloads.add(selector);
    if (downloadURLs.has(selector)) URL.revokeObjectURL(downloadURLs.get(selector));
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2) + '\n'], { type: 'application/json' }));
    downloadURLs.set(selector, url);
    const result = root.querySelector(selector); result.replaceChildren();
    const link = document.createElement('a'); link.href = url; link.download = kind + '-companion.json'; link.textContent = '下载连接配置'; result.append(link);
    const instructions = document.createElement('p'); instructions.className = 'note'; instructions.textContent = '下载后，在收取配置的 Mac 双击 Morlet 项目内的 scripts/connect.command，选择此文件；回这里确认在线。配置含私密凭据，请勿分享。'; result.append(instructions);
    const code = document.createElement('pre'); code.className = 'chat-install'; code.textContent = './scripts/pa.sh connect ' + kind + ' --config ~/Downloads/' + kind + '-companion.json'; const manual = document.createElement('details'); manual.className = 'chat-advanced'; const summary = document.createElement('summary'); summary.textContent = '在终端安装'; manual.append(summary, code); result.append(manual);
    link.addEventListener('click', () => { pendingDownloads.delete(selector); const id = kind === 'imessage' ? 'chat-channel-pair' : 'chat-pair', form = root?.querySelector('#' + id); if (form && formFingerprint(form) === submittedForm) setupDirtyForms.delete(id); }, { once: true });
  }
  async function open({ section, example, draft, sourceRefs, guideSourceId, messageId, endpointId, botId, conversationId, roomKind: nextRoomKind, newConversation = false } = {}) {
    if (!root || pending) return;
    const current = generation, createDraft = !conversationId && (newConversation || typeof example === 'string' && !!example.trim());
    const changingRoom = Boolean(conversationId && conversationId !== selected), preparing = createDraft || changingRoom;
    if (nextRoomKind) { roomKind = nextRoomKind; roomBotId = botId; }
    if (preparing) { pending = true; preparingDraft = true; if (model) renderData(); message(''); }
    let prepared = false;
    try {
      const fresh = await refresh();
      if (current !== generation || !root) return;
      if (!model) throw new Error('暂时读不到执行端，输入尚未提交。请刷新状态后再试。');
      if (createDraft && !fresh) throw new Error('暂时无法核对 Agent 的最新状态，交代尚未发送。请恢复连接后重试。');
      if (section) {
        root.querySelector('#chat-settings').open = true;
        const details = root.querySelector(section === 'imessage' ? '#chat-imessage-setup' : '#chat-agent-setup');
        if (details) { details.open = true; details.scrollIntoView({ block: 'start' }); details.querySelector('summary')?.focus({ preventScroll: true }); }
      }
      if (conversationId) {
        if (!model.conversations.some(c => c.id === conversationId)) throw new Error('原对话已不可用，请重新选择。');
        if (selected !== conversationId) captureReadingPosition();
        drafts.set(draftKey(), root.querySelector('#chat-input')?.value || ''); selected = conversationId;
        if (botId && !agentSelections.has(draftKey())) agentSelections.set(draftKey(), botId);
        root.querySelector('#chat-input').value = drafts.get(draftKey()) || ''; persistDrafts();
        const loaded = await refresh();
        if (current !== generation || !root || selected !== conversationId) return;
        if (!loaded) throw new Error('暂时读不到这段对话，输入已保留，请稍后重试。');
      }
      if (!createDraft) {
        offerDraft(draft || example, { ...(sourceRefs && { sourceRefs }), ...(guideSourceId && { guideSourceId }) });
        if (messageId) await revealMessage({ conversationId: selected, messageId });
        if (current !== generation || !root) return;
        onConversation?.(model.conversations.find(value => value.id === selected));
        return;
      }
      // Preparing a new Web draft never submits a run into an existing IM chat.
      const bot = model.bots?.find(b => b.id === (botId || 'xiaoman') && b.active);
      if (!bot?.connected) throw new Error('这个 Bot 还没有执行连接，请在设置的 Bot 页签连接。');
      const conversation = await api('hub', { operation: 'open-room', kind: 'direct', botId: bot.id });
      if (current !== generation || !root) return;
      captureReadingPosition(); drafts.set(draftKey(), root.querySelector('#chat-input').value); selected = conversation.id;
      if (!model.conversations.some(value => value.id === conversation.id)) model.conversations.push(conversation);
      agentSelections.set(draftKey(), bot.id);
      const existing = drafts.get(draftKey()) || '';
      const addition = typeof example === 'string' ? example.trim().slice(0, 4000) : '';
      root.querySelector('#chat-input').value = existing; offerDraft(draft || addition, { ...(sourceRefs && { sourceRefs }), ...(guideSourceId && { guideSourceId }) });
      persistDrafts(); renderData(); prepared = true; onConversation?.(conversation);
      message('');
    } finally {
      if (current === generation && root && preparing) { pending = false; preparingDraft = false; if (model) renderData(); if (prepared) root.querySelector('#chat-input').focus(); }
    }
  }
  function discardCurrentDraft() { if (!root || pending) return; drafts.delete(draftKey()); draftReferences.delete(draftKey()); draftSuggestions.delete(draftKey()); sendRequests.delete(draftKey()); persistDrafts(); const input = root.querySelector('#chat-input'); if (input) input.value = ''; }
  function addDraft(content) {
    const input = root?.querySelector('#chat-input');
    if (!input || pending || !selected) throw new Error('请等待对话加载完成。');
    input.value = [input.value.trim(), content].filter(Boolean).join('\n\n');
    drafts.set(draftKey(), input.value); persistDrafts(); input.focus();
  }
  window.PAChat = { addDraft, mount, unmount, open, revealMessage, captureReadingPosition, restoreReadingPosition, discardCurrentDraft, hasPendingDownload: () => pendingDownloads.size > 0, isBusy: () => pending, isEditing: () => setupDirtyForms.size > 0 || pendingDownloads.size > 0 };
})();
