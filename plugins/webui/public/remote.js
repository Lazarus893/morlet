(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const date = value => Number.isFinite(value) ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value) : '';
  const title = session => { const value = session?.projections?.values?.title; return typeof value === 'string' ? value : value?.title || '未命名会话'; };
  const failure = error => ({ DSH_REMOTE_NOT_CONNECTED: '远程电脑尚未连接。', DSH_REMOTE_STREAM_LOST: '连接中断，执行结果尚未确认。', DSH_REMOTE_APPROVAL_DETAILS_UNAVAILABLE: '操作详情未完整读取，请在原端确认。', DSH_REMOTE_UNREACHABLE: '远程连接暂不可用。', DSH_REMOTE_AUTH_REQUIRED: '远程连接需要重新授权。', DSH_REMOTE_SESSION_CONTROL_DISABLED: '当前连接仅允许查看会话。', DSH_REMOTE_APPROVAL_EXPIRED: '这次授权请求已失效，请读取最新状态。', DSH_REMOTE_OUTCOME_UNKNOWN: '操作结果尚未确认，请先核对最新记录。', DSH_REMOTE_TARGET_NOT_ALLOWED: '此设备未获授权。', DSH_REMOTE_BUSY: '远程电脑正在处理上一项操作。' })[error?.code] || '远程操作未完成，请重试。';
  const textBlocks = content => Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';

  function mount({ root, api, snapshot }) {
    let state = snapshot, dead = false, busy = false, loading = false, sessionId = '', sessions = [], devices = [], workspaces = [], generation = 0, listScroll = 0;
    let query = '', sessionLimit = 8;
    let stream, sessionReady = false, eventsReady = false, records = new Map(), cursor, liveCursor, hasMore = false, running = false, uncertain = false, pendingPrompt;
    const drafts = new Map(), submissions = new Map(), approvals = new Map();
    root.classList.add('remote-center');
    root.innerHTML = `<div class="r-heading"><h2>远程会话</h2><span class="c-state" id="r-state"></span><button type="button" class="text" data-r-action="refresh">刷新</button></div><div class="r-notice" role="status" aria-live="polite"><p id="r-status"></p><button type="button" class="text" data-r-action="recover" hidden>读取最新记录</button><button type="button" class="text" data-r-action="acknowledge" hidden>已核对记录</button></div><details class="r-device"><summary id="r-device-name">远程电脑</summary><div class="r-device-controls"><p id="r-device-status"></p><button type="button" class="outline" data-r-action="connect">连接</button><button type="button" class="text" data-r-action="disconnect">断开连接</button></div><form id="r-workspace-form" hidden><label for="r-workspace">工作区</label><div class="r-workspace-row"><select id="r-workspace" name="workspace"></select><button type="submit" class="outline" data-r-action="workspace">打开</button></div></form></details><div id="r-list-view"><div class="field r-search-field" hidden><label class="sr-only" for="r-search">查找远程会话</label><input id="r-search" type="search" placeholder="查找会话" autocomplete="off"></div><ul class="r-sessions" id="r-sessions" aria-label="远程会话"></ul><p class="r-empty" id="r-list-empty"></p><button type="button" class="text" data-r-action="more-sessions" hidden></button></div><section class="r-session" id="r-session" hidden aria-labelledby="r-session-title"><div class="r-session-heading"><button type="button" class="text" data-r-action="back">返回会话</button><h3 id="r-session-title" tabindex="-1"></h3></div><button type="button" class="text" data-r-action="history" hidden>更早记录</button><div class="r-history" id="r-history" tabindex="0" aria-label="会话记录"></div><div id="r-approvals"></div><form id="r-compose"><label for="r-input">继续对话</label><textarea id="r-input" name="prompt" rows="2" maxlength="16000"></textarea><div class="r-compose-actions"><span id="r-turn-state" role="status"></span><button type="button" class="text" data-r-action="cancel" hidden>停止本轮</button><button type="submit" class="primary" data-r-action="send">发送</button></div></form></section>`;
    const $ = selector => root.querySelector(selector), input = $('#r-input');
    $('.r-device-controls').insertAdjacentHTML('beforebegin', '<div class="r-device-picker" hidden><label for="r-device-select">连接到</label><select id="r-device-select"></select></div>');
    $('#r-workspace-form').classList.add('field'); $('.r-device-picker').classList.add('field'); $('#r-compose').classList.add('field');
    const call = (operation, request = {}) => api('remote-agent', { operation, request });
    const streamReady = () => sessionReady && (!state?.capabilities?.approval || eventsReady);
    function status(text = '', retry = false) { $('#r-status').textContent = text; $('[data-r-action="recover"]').hidden = !retry || !sessionId; }
    function saveDraft() { if (sessionId) { drafts.set(sessionId, input.value); submissions.set(sessionId, { uncertain, pendingPrompt }); } }
    function controls() {
      const connected = state?.connected === true, caps = state?.capabilities || {};
      for (const button of root.querySelectorAll('button')) button.disabled = busy;
      $('[data-r-action="connect"]').hidden = connected;
      $('[data-r-action="connect"]').disabled = busy || !devices.some(value => value.deviceId === ($('#r-device-select').value || state.targetDeviceId) && value.online);
      $('[data-r-action="disconnect"]').hidden = !connected;
      $('[data-r-action="send"]').disabled = busy || !connected || !streamReady() || !caps.prompt || uncertain || !input.value.trim();
      $('[data-r-action="cancel"]').hidden = !running || !caps.interrupt;
      $('[data-r-action="cancel"]').disabled = busy || !connected || !streamReady();
      $('[data-r-action="history"]').hidden = !hasMore;
      $('[data-r-action="history"]').disabled = busy || !connected || !sessionReady;
      $('[data-r-action="acknowledge"]').hidden = !uncertain || !sessionReady;
      input.disabled = !caps.prompt;
      $('#r-turn-state').textContent = !caps.prompt ? '仅查看会话' : uncertain ? '结果待核对' : !streamReady() ? '状态未同步' : approvals.size ? '等待确认' : running ? '正在执行' : pendingPrompt ? '已提交，等待执行' : '';
      for (const button of root.querySelectorAll('[data-r-approval]')) button.disabled = busy || !streamReady() || !caps.approval || button.dataset.rDecision === 'allowed-once' && !reviewedArguments(approvals.get(button.dataset.rApproval));
      root.setAttribute('aria-busy', String(busy || loading));
    }
    function renderState() {
      const connected = state?.connected === true, target = devices.find(value => value.deviceId === state?.targetDeviceId);
      const selected = $('#r-device-select').value || state.targetDeviceId;
      $('.r-device-picker').hidden = connected || !devices.length;
      $('#r-device-select').innerHTML = '<option value="">选择电脑</option>' + devices.map(value => `<option value="${esc(value.deviceId)}"${value.online ? '' : ' disabled'}>${esc(value.name)}${value.online ? '' : ' · 离线'}</option>`).join('');
      $('#r-device-select').value = selected || '';
      $('#r-state').textContent = connected ? '已连接' : state?.state === 'unavailable' ? '连接异常' : '未连接';
      $('#r-state').className = `c-state c-state-${connected ? 'connected' : 'offline'}`;
      $('#r-device-name').textContent = target?.name || '远程电脑';
      $('#r-device-status').textContent = connected ? `${state.backend === 'harness' ? 'DSH' : state.backend || '远程'} · ${state.transport === 'unknown' ? '已连接' : state.transport}` : target?.online === false ? '设备离线' : devices.length ? '尚未建立连接' : loading ? '正在查找设备…' : '暂无可连接的设备。';
      if (!connected) $('.r-device').open = true;
      controls();
    }
    function renderSessions() {
      const focused = document.activeElement?.dataset.rSession;
      const matching = sessions.filter(value => title(value).toLocaleLowerCase().includes(query));
      $('.r-search-field').hidden = !state.connected || sessions.length < 9 && !query;
      const more = $('[data-r-action="more-sessions"]');
      more.hidden = matching.length <= sessionLimit; more.textContent = `更多会话 · 还有 ${Math.max(0, matching.length - sessionLimit)} 条`;
      $('#r-sessions').innerHTML = matching.slice(0, sessionLimit).map(value => `<li><button type="button" class="r-session-link" data-r-session="${esc(value.sessionId)}"><span>${esc(title(value))}</span><small>${value.running ? '正在执行' : esc(date(value.updatedAt))}</small></button></li>`).join('');
      $('#r-list-empty').textContent = !state.connected ? '' : loading && !sessions.length ? '正在读取会话…' : !sessions.length ? '这个工作区还没有会话。' : !matching.length ? '没有找到匹配的会话。' : '';
      if (focused) [...root.querySelectorAll('[data-r-session]')].find(button => button.dataset.rSession === focused)?.focus({ preventScroll: true });
      controls();
    }
    function renderWorkspaces() {
      const selected = $('#r-workspace').value;
      $('#r-workspace-form').hidden = !state.connected || !workspaces.length;
      $('#r-workspace').innerHTML = workspaces.map((value, index) => `<option value="${index}">${esc(value.title || value.path)}</option>`).join('');
      if (selected && Number(selected) < workspaces.length) $('#r-workspace').value = selected;
    }
    function renderHistory() {
      const history = $('#r-history'), top = history.scrollTop, follow = history.scrollHeight - top - history.clientHeight < 64;
      const visible = [];
      for (const event of [...records.values()].sort((a, b) => a.seq - b.seq)) {
        if (!['user/message', 'assistant/message'].includes(event.type)) continue;
        const op = event.surfaceOp;
        if (op && typeof op === 'object' && op.op === 'replace') {
          for (let index = visible.length - 1; index >= 0; index--) if (visible[index].seq >= op.startSeq && visible[index].seq <= op.endSeq) visible.splice(index, 1);
        }
        const message = event.type === 'assistant/message' ? event.data?.message : event.data;
        // Harness also stores injected context as user-role messages. Only the
        // native user source represents what the person actually submitted.
        if (event.type === 'user/message' && message?.source?.kind !== 'user') continue;
        const text = textBlocks(message?.content);
        if (text) visible.push({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text, interrupted: event.data?.interrupted });
      }
      window.PAJournalSurfaces?.clearReports(history);
      history.innerHTML = visible.length ? visible.map(value => `<article class="r-message r-message-${value.role}"><span class="r-speaker">${value.role === 'user' ? '你' : 'DSH'}</span><div class="r-message-text pa-prose" data-r-message="${value.seq}">${esc(value.text)}</div>${value.interrupted ? '<small>回复已中断</small>' : ''}</article>`).join('') : '<p class="r-empty">尚无对话记录。</p>';
      for (const value of visible) if (value.role === 'assistant') {
        const body = history.querySelector(`[data-r-message="${value.seq}"]`);
        window.PAJournalSurfaces?.renderReport(body, value.text);
      }
      if (follow) history.scrollTop = history.scrollHeight; else history.scrollTop = top;
    }
    function addRecords(values) {
      if (!Array.isArray(values)) throw new Error('Invalid history');
      for (const value of values) {
        const event = value?.type === 'event' && value.event;
        if (!event || !Number.isSafeInteger(event.seq)) throw new Error('Invalid history event');
        records.set(event.seq, event);
        if (pendingPrompt && event.type === 'user/message' && event.data?.source?.kind === 'user' && event.data.source.rpcId === pendingPrompt.id) { pendingPrompt = undefined; uncertain = false; }
      }
      renderHistory();
      renderApprovals();
    }
    function reviewedArguments(value) {
      const request = value?.request;
      if (!request?.callId || typeof request.toolName !== 'string') return;
      const calls = [...records.values()].filter(event => event.type === 'tool/call' && event.data?.callId === request.callId);
      if (calls.length !== 1) return;
      const event = calls[0], data = event.data;
      if (data.name !== request.toolName || typeof data.arguments !== 'string' || data.arguments.length > 65536 || event.truncated || data.truncated || data.argumentsTruncated) return;
      try {
        const args = JSON.parse(data.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) return;
        return JSON.stringify(args, null, 2);
      } catch { return; }
    }
    function renderApprovals() {
      const list = $('#r-approvals'), focused = document.activeElement?.dataset;
      const markup = [...approvals.values()].map(value => {
        const args = reviewedArguments(value);
        return `<section class="r-approval" aria-label="操作授权"><h4>允许这次操作？</h4><p>${esc(value.request.toolName)}</p>${value.request.reason ? `<p>${esc(value.request.reason)}</p>` : ''}${args ? `<pre class="r-review-arguments" aria-label="完整工具参数" tabindex="0">${esc(args)}</pre>` : '<p class="r-approval-unavailable">尚无可核对的完整操作参数，请在原端处理。</p>'}<div class="r-approval-actions">${args ? `<button type="button" class="outline" data-r-approval="${esc(value.approvalHandle)}" data-r-decision="allowed-once">仅允许这次</button>` : ''}<button type="button" class="text" data-r-approval="${esc(value.approvalHandle)}" data-r-decision="rejected">拒绝</button></div></section>`;
      }).join('');
      if (list.dataset.markup !== markup) {
        list.innerHTML = markup; list.dataset.markup = markup;
        if (focused?.rApproval) [...list.querySelectorAll('[data-r-approval]')].find(button => button.dataset.rApproval === focused.rApproval && button.dataset.rDecision === focused.rDecision)?.focus({ preventScroll: true });
      }
      controls();
    }
    function stopStream() { stream?.close(); stream = undefined; sessionReady = false; eventsReady = false; approvals.clear(); renderApprovals(); }
    function lost(error) {
      stopStream();
      status(error?.code ? failure(error) : '连接中断，执行结果尚未确认。', true);
      controls();
    }
    function follow() {
      stopStream();
      const current = generation, selected = sessionId;
      stream = new EventSource(`/api/remote-agent/events?sessionId=${encodeURIComponent(selected)}`);
      stream.onmessage = event => {
        if (dead || current !== generation || selected !== sessionId) return;
        try {
          const frame = JSON.parse(event.data), value = frame.data;
          if (frame.source === 'session') {
            if (value?.type === 'snapshot') {
              if (value.header?.id !== selected || !Number.isSafeInteger(value.cursor)) throw new Error('Invalid snapshot');
              records = new Map(); cursor = value.cursor; liveCursor = value.cursor; hasMore = value.hasMore === true;
              addRecords(value.records); sessionReady = true;
              const sessionTitle = value.projections?.values?.title;
              if (typeof sessionTitle === 'string' && sessionTitle) $('#r-session-title').textContent = sessionTitle;
              if (!uncertain) status('');
            } else if (value?.type === 'event') {
              if (!sessionReady || value.event?.seq > liveCursor + 1) throw new Error('History gap');
              if (value.event?.seq <= liveCursor) return;
              liveCursor = value.event.seq;
              addRecords([value]);
              if (value.event.type === 'turn/start') { running = true; pendingPrompt = undefined; }
              if (value.event.type === 'turn/end') {
                running = false; approvals.clear(); renderApprovals();
                const reason = value.event.data?.reason?.kind;
                status(reason === 'completed' ? '' : reason === 'aborted' ? '本轮已停止。' : '本轮未完成，请核对已有记录。');
              }
            }
          } else if (frame.source === 'events') {
            if (value?.type === 'ready') eventsReady = true;
            if (value?.type === 'waterfall' && value.event === 'approval/request' && value.agentId === selected && value.approvalHandle) {
              approvals.set(value.approvalHandle, value); renderApprovals();
            }
            if (value?.type === 'cancel') { for (const [handle, request] of approvals) if (request.eventId === value.eventId) approvals.delete(handle); renderApprovals(); }
          } else if (frame.source === 'error') { lost(value); return; }
          controls();
        } catch { lost(); }
      };
      stream.onerror = event => {
        if (dead || current !== generation) return;
        let error; try { error = JSON.parse(event.data); } catch {}
        lost(error);
      };
      controls();
    }
    async function refresh({ reopen = false } = {}) {
      if (dead || busy || loading) return;
      loading = true; controls();
      try {
        const next = await api('remote-agent'); if (dead) return;
        state = next; renderState();
        if (next.capabilities?.devices) devices = await call('devices');
        if (dead) return;
        if (next.connected) {
          const results = await Promise.all([call('sessions'), call('workspaces', { backend: next.backend })]);
          if (dead) return;
          if (!Array.isArray(results[0]?.items) || !Array.isArray(results[1])) throw new Error('Invalid remote list');
          sessions = results[0].items; workspaces = results[1];
          renderSessions(); renderWorkspaces();
          if (sessionId) running = sessions.find(value => value.sessionId === sessionId)?.running === true;
          if (reopen && sessionId) follow();
        } else { stopStream(); sessions = []; renderSessions(); }
        renderState();
      } catch (error) { if (!dead) status(failure(error), Boolean(sessionId)); }
      finally { loading = false; if (!dead) { renderState(); renderSessions(); controls(); } }
    }
    async function mutate(operation, request, complete) {
      if (busy || dead) return;
      const current = generation;
      busy = true; controls(); status('');
      try { const value = await call(operation, request); if (!dead && current === generation) await complete?.(value); }
      catch (error) {
        if (!dead && current === generation) {
          if (['DSH_REMOTE_OUTCOME_UNKNOWN', 'NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT', 'UNAVAILABLE'].includes(error.code)) uncertain = operation === 'prompt';
          status(uncertain ? '发送结果尚未确认，请先核对最新记录。' : failure(error), Boolean(sessionId));
          if (operation === 'prompt' && !uncertain) pendingPrompt = undefined;
        }
      } finally { busy = false; if (!dead) controls(); }
    }
    function select(id) {
      if (busy || id === sessionId) return;
      const selected = sessions.find(value => value.sessionId === id); if (!selected) return;
      listScroll = window.scrollY;
      saveDraft(); generation++; stopStream(); sessionId = id; records = new Map(); cursor = undefined; hasMore = false;
      uncertain = submissions.get(id)?.uncertain === true; pendingPrompt = submissions.get(id)?.pendingPrompt;
      running = selected.running === true;
      $('#r-list-view').hidden = true; $('#r-session').hidden = false; $('#r-compose').before($('.r-notice')); $('#r-session-title').textContent = title(selected); input.value = drafts.get(id) || '';
      window.PAJournalSurfaces?.clearReports($('#r-history'));
      $('#r-history').innerHTML = '<p class="r-empty">正在读取记录…</p>'; status(''); follow();
      $('#r-session-title').focus({ preventScroll: true });
      $('#r-session').scrollIntoView({ block: 'start', behavior: 'auto' });
    }
    const click = event => {
      const selected = event.target.closest('[data-r-session]');
      if (selected) { event.stopPropagation(); select(selected.dataset.rSession); return; }
      const button = event.target.closest('[data-r-action],[data-r-approval]'); if (!button) return;
      event.stopPropagation(); if (busy) return;
      if (button.dataset.rApproval) {
        const handle = button.dataset.rApproval;
        if (!streamReady() || !approvals.has(handle) || !state.capabilities.approval) return;
        if (button.dataset.rDecision === 'allowed-once' && !reviewedArguments(approvals.get(handle))) return;
        void mutate('approval', { handle, sessionId, decision: button.dataset.rDecision }, () => { approvals.delete(handle); renderApprovals(); }); return;
      }
      const action = button.dataset.rAction;
      if (['refresh', 'recover'].includes(action)) void refresh({ reopen: Boolean(sessionId) });
      if (action === 'more-sessions') { sessionLimit += 20; renderSessions(); }
      if (action === 'connect') {
        const targetDeviceId = $('#r-device-select').value || state.targetDeviceId;
        if (devices.some(value => value.deviceId === targetDeviceId && value.online)) void mutate('connect', { targetDeviceId }, value => { state = value; renderState(); }).then(() => refresh());
      }
      if (action === 'disconnect') void mutate('disconnect', {}, value => { state = value; stopStream(); renderState(); });
      if (action === 'back') { const previous = sessionId; saveDraft(); generation++; stopStream(); sessionId = ''; $('#r-session').hidden = true; $('#r-list-view').hidden = false; $('.r-heading').after($('.r-notice')); status(''); [...root.querySelectorAll('[data-r-session]')].find(value => value.dataset.rSession === previous)?.focus({ preventScroll: true }); window.scrollTo({ top: listScroll, behavior: 'auto' }); }
      if (action === 'cancel' && streamReady() && state.capabilities.interrupt) void mutate('cancel', { sessionId }, () => status('已请求停止，等待远端确认。'));
      if (action === 'acknowledge') { uncertain = false; pendingPrompt = undefined; status(''); controls(); input.focus(); }
      if (action === 'history' && Number.isSafeInteger(cursor)) {
        const beforeSeq = Math.min(...records.keys());
        void mutate('history', { address: { kind: 'session', sessionId }, throughSeq: cursor, ...(Number.isFinite(beforeSeq) ? { beforeSeq } : {}), maxMessages: 20 }, value => {
          const history = $('#r-history'), height = history.scrollHeight, top = history.scrollTop;
          addRecords(value.records); hasMore = value.hasMore === true; history.scrollTop = top + history.scrollHeight - height;
        });
      }
    };
    const submit = event => {
      if (!event.target.matches('#r-compose,#r-workspace-form')) return;
      event.preventDefault(); event.stopPropagation(); if (busy) return;
      if (event.target.id === 'r-workspace-form') {
        const value = workspaces[Number($('#r-workspace').value)]; if (!value) return;
        saveDraft();
        void mutate('openWorkspace', { backend: state.backend, ...(state.backend === 'harness' ? { path: value.path } : { workspaceId: value.workspaceId }) }, () => {
          generation++; stopStream(); sessionId = ''; query = ''; sessionLimit = 8; $('#r-search').value = ''; $('#r-session').hidden = true; $('#r-list-view').hidden = false; $('.r-heading').after($('.r-notice'));
        }).then(() => refresh()); return;
      }
      if (!sessionId || !streamReady() || !state.capabilities.prompt || uncertain || !input.value.trim()) return;
      const text = input.value.trim(), selected = sessionId, requestId = window.PATransport.requestId();
      pendingPrompt = { id: requestId, text }; saveDraft();
      void mutate('prompt', { sessionId: selected, requestId, mode: 'queue', content: [{ type: 'text', text }] }, value => {
        if (value?.accepted !== true) { uncertain = true; status('发送结果尚未确认，请先核对最新记录。', true); return; }
        if (input.value.trim() === text) input.value = '';
        drafts.set(selected, input.value); controls();
      });
    };
    const changed = event => { if (event.target.id === 'r-search') { query = event.target.value.trim().toLocaleLowerCase(); sessionLimit = 8; renderSessions(); event.stopPropagation(); } if (event.target === input) { saveDraft(); controls(); event.stopPropagation(); } };
    const selectionChanged = event => { if (event.target.id === 'r-device-select') controls(); };
    root.addEventListener('click', click); root.addEventListener('submit', submit); root.addEventListener('input', changed); root.addEventListener('change', selectionChanged);
    renderState(); void refresh();
    return {
      update(next) { if (dead) return; const wasConnected = state?.connected; state = next; if (wasConnected && !state.connected) lost(); renderState(); },
      refresh, isEditing: () => Boolean(input.value.trim()), isBusy: () => busy,
      unmount() { window.PAJournalSurfaces?.clearReports($('#r-history')); dead = true; generation++; saveDraft(); stopStream(); root.removeEventListener('click', click); root.removeEventListener('submit', submit); root.removeEventListener('input', changed); root.removeEventListener('change', selectionChanged); },
    };
  }
  function mountStatus({ root, api, snapshot }) {
    let state = snapshot, devices = [], dead = false, busy = false;
    root.innerHTML = '<div class="r-heading"><h3>DSH Remote</h3><span class="c-state" id="r-state"></span><button class="text" data-remote-refresh>检查连接</button></div><p class="r-notice" role="status"></p><details class="r-device"><summary>管理</summary><p id="r-device-status"></p><label class="field">电脑<select id="r-device-select"></select></label><div class="actions"><button class="outline" data-remote-connect>连接</button><button class="text danger" data-remote-disconnect>断开</button></div></details>';
    const $ = selector => root.querySelector(selector);
    function render() {
      const connected = state?.connected === true;
      $('#r-state').textContent = connected ? '已连接' : state?.state === 'unavailable' ? '连接异常' : '未连接';
      $('#r-state').className = `c-state c-state-${connected ? 'connected' : 'offline'}`;
      $('.r-device > summary').textContent = connected ? '管理' : '连接电脑';
      const select = $('#r-device-select'), prior = select.value || state?.targetDeviceId;
      select.innerHTML = '<option value="">选择电脑</option>' + devices.map(d => `<option value="${esc(d.deviceId)}" ${d.online ? '' : 'disabled'}>${esc(d.name)}${d.online ? '' : ' · 离线'}</option>`).join('');
      select.value = prior || ''; select.closest('label').hidden = connected;
      $('#r-device-status').textContent = devices.find(d => d.deviceId === state?.targetDeviceId)?.name || (connected ? '私有远程连接' : devices.some(d => d.online) ? '选择一台已上线的电脑。' : '在执行电脑上启动 DSH Remote，连接已配置的私有服务，再检查连接。');
      $('[data-remote-connect]').hidden = connected; $('[data-remote-connect]').disabled = busy || !devices.some(d => d.deviceId === select.value && d.online);
      $('[data-remote-disconnect]').hidden = !connected; $('[data-remote-disconnect]').disabled = busy;
      $('[data-remote-refresh]').disabled = busy;
    }
    async function refresh() {
      try {
        const next = await api('remote-agent'); if (dead) return; state = next;
        if (next.capabilities?.devices) devices = await api('remote-agent', { operation: 'devices', request: {} });
        if (!dead) { $('.r-notice').textContent = ''; render(); }
      } catch (error) { if (!dead) $('.r-notice').textContent = failure(error); }
    }
    async function click(event) {
      const button = event.target.closest('button'); if (!button || busy) return;
      if (button.hasAttribute('data-remote-refresh')) { await refresh(); return; }
      const connect = button.hasAttribute('data-remote-connect');
      if (!connect && !button.hasAttribute('data-remote-disconnect')) return;
      if (!connect && !confirm('断开远程电脑？会话记录会保留。')) return;
      const targetDeviceId = $('#r-device-select').value;
      busy = true; render();
      try { state = await api('remote-agent', { operation: connect ? 'connect' : 'disconnect', request: connect ? { targetDeviceId } : {} }); if (!dead) await refresh(); }
      catch (error) { if (!dead) $('.r-notice').textContent = failure(error); }
      finally { busy = false; if (!dead) render(); }
    }
    root.addEventListener('click', click); root.addEventListener('change', render); render(); void refresh();
    return { update(next) { state = next; if (!dead) render(); }, isEditing: () => false, isBusy: () => busy, unmount() { dead = true; root.removeEventListener('click', click); root.removeEventListener('change', render); } };
  }
  window.PARemote = { mount, mountStatus };
})();
