(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const kindNames = { arrangement: '安排', purchase: '购物', experience: '经历', wish: '愿望' };
  const widgetAPI = window.PAJournalWidgets;
  const indexAPI = window.PAJournalIndex;
  const routineUI = window.PARoutineUI;
  const widgetNames = { focus: '下一件事', checklist: '准备清单', comparison: '候选比较', timeline: '时间与材料', waiting: '等待与期限', memory: '留下来的', wish: '想做的事', ...(widgetAPI?.names || {}) };
  const statusNames = { planned: '已记下', active: '进行中', done: '已结束', cancelled: '已取消' };
  const motion = window.PAMotion;
  let listeners, root, request, navigate, snapshot, scopes = [], tasks = [], tab = 'recent', search = '', pending = false, editing = null, editor, lastOpener, refreshTimer, selectionToken = 0, alive = false, remindersInitialized = false;
  const cards = new Map();
  let automaticContent = null, automaticDirty = false;
  let creatingConversation = false;
  let guideOnly = false, hub, runtime, localAgentAvailable, readingConversation = '', readingItem = '', conversationRoot, remoteReader, remoteState;
  const conversationPages = new Map(), chapterViews = new Map();
  const routineFor = item => snapshot?.routines?.find(routine => routine.journalItemId === item?.id);
  const conversationIdFor = item => item?.conversationId || item?.followupReport?.conversationId || (item?.source?.kind === 'guide' ? snapshot?.guide?.report?.conversationId : null);
  const conversationItem = c => {
    const runs = hub?.runs?.filter(run => run.conversationId === c.id) || [], run = runs.at(-1);
    const artifacts = [...new Map(runs.flatMap(run => (run.report?.artifacts || []).map(a => [a.url || run.endpointId + ':' + a.path, a]))).values()];
    return { id: 'conversation-' + c.id, title: c.title || '未命名对话', status: 'active', source: { kind: 'conversation' }, conversationId: c.id, updatedAt: c.updatedAt || c.createdAt,
      ...(run && { followupReport: { run, artifacts, answer: runs.findLast(run => run.report?.summary)?.report.summary, reason: run.error, isBusy: ['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling'].includes(run.status) } }) };
  };
  function extraItems() {
    if (guideOnly || snapshot?.scope.account !== 'local' || snapshot?.scope.userId !== 'owner') return [];
    const linked = new Set((snapshot?.items || []).map(conversationIdFor).filter(Boolean));
    return [...(hub?.conversations || []).filter(c => !linked.has(c.id)).map(conversationItem), ...(remoteState?.configured ? [{ id: 'remote-conversations', title: '远程会话', status: 'active', source: { kind: 'remote' } }] : [])];
  }
  function closeConversation() {
    if (conversationRoot?.closest('.journal-workpage')) delete conversationRoot.closest('.journal-workpage').dataset.reading;
    window.PAChat.unmount(); remoteReader?.unmount(); remoteReader = null; conversationRoot?.remove(); conversationRoot = null; readingConversation = ''; readingItem = '';
  }
  async function revealSavedItem(itemId) {
    if (!alive) return;
    const token = selectionToken;
    tab = 'recent'; search = ''; root.querySelector('#journal-search').value = '';
    notebookSelection[tab] = itemId; chapterViews.set(itemId, 'conversation');
    try {
      await reload();
      if (!alive || token !== selectionToken) return;
      saveWorkState();
    } catch (error) { if (alive && token === selectionToken) setStatus('事项已保存，暂时读不到最新页面。请刷新重试。', true); }
  }
  async function loadConversations() {
    const token = selectionToken;
    try {
      const next = await request('hub');
      if (!alive || token !== selectionToken) return;
      hub = next; patchBoard();
      const error = root.querySelector('#journal-messages-error'); error.hidden = true;
    } catch (error) {
      if (!alive || token !== selectionToken) return;
      const node = root.querySelector('#journal-messages-error'); node.hidden = false; node.querySelector('span').textContent = '消息暂时读不到，已有手账仍可查看。';
    }
  }
  function mountConversation(item) {
    const id = item.conversationId || conversationIdFor(item);
    if (!id || !hub) return;
    if (readingConversation === id && readingItem === item.id && conversationRoot?.isConnected) return;
    closeConversation(); readingConversation = id; readingItem = item.id;
    const page = conversationPages.get(item.id) || [...workpages.values()].find(p => p.dataset.item === item.id);
    if (!page) return;
    conversationRoot = document.createElement('div'); conversationRoot.className = 'journal-conversation';
    page.dataset.reading = 'conversation';
    conversationRoot.id = `chapter-${item.id}-conversation`;
    conversationRoot.setAttribute('role', 'tabpanel');
    conversationRoot.setAttribute('aria-labelledby', `chapter-tab-${item.id}-conversation`);
    conversationRoot.innerHTML = '<div class="journal-chat-mount"></div>';
    (page.querySelector('.jui-workcard') || page).append(conversationRoot);
    window.PAChat.mount({ root: conversationRoot.querySelector('.journal-chat-mount'), api: request, runtime, localAgentAvailable, conversationId: id, ...(item.source?.kind !== 'conversation' && { journalItemId: item.id }), onItemSaved: revealSavedItem });
  }
  async function openConversation({ conversationId, itemId, ...options } = {}) {
    await loadConversations(); if (!alive || !hub) throw new Error('暂时读不到消息，请重试。');
    const linked = conversationId && (snapshot.items.find(item => item.id === itemId && conversationIdFor(item) === conversationId) || snapshot.items.find(item => item.source?.kind !== 'guide' && conversationIdFor(item) === conversationId) || snapshot.items.find(item => conversationIdFor(item) === conversationId));
    if (linked) { chapterViews.set(linked.id, 'conversation'); await openItem(linked.id); mountConversation(linked); }
    else if (conversationId) {
      const conversation = hub.conversations.find(c => c.id === conversationId);
      if (!conversation) throw new Error('原对话当前不可用，已有手账仍保留。');
      chapterViews.set('conversation-' + conversationId, 'conversation');
      tab = 'recent'; search = ''; root.querySelector('#journal-search').value = ''; notebookSelection[tab] = 'conversation-' + conversationId; patchChrome(); patchBoard();
      mountConversation(conversationItem(conversation));
    } else {
      const item = { id: 'conversation-new', title: '新的一页', status: 'active', source: { kind: 'conversation' } };
      closeConversation(); creatingConversation = true;
      const page = document.createElement('section'); page.className = 'journal-workpage journal-message-page'; page.dataset.item = item.id; page.innerHTML = '<h2 class="journal-chapter-title">新的一页</h2>';
      root.querySelector('#journal-board').append(page); conversationPages.set(item.id, page);
      for (const child of root.querySelector('#journal-board').children) child.hidden = child !== page;
      conversationRoot = document.createElement('div'); page.append(conversationRoot);
      window.PAChat.mount({ root: conversationRoot, api: request, runtime, localAgentAvailable, onItemSaved: revealSavedItem, onConversation: c => { creatingConversation = false; if (!hub.conversations.some(value => value.id === c.id)) hub.conversations.push(c); notebookSelection[tab] = 'conversation-' + c.id; readingConversation = c.id; readingItem = 'conversation-' + c.id; page.dataset.item = readingItem; conversationPages.delete(item.id); conversationPages.set(readingItem, page); patchBoard(); } });
      try { await window.PAChat.open({ ...options, newConversation: true }); } catch (error) { creatingConversation = false; closeConversation(); page.remove(); conversationPages.delete(item.id); patchBoard(); throw error; }
    }
    // A newly mounted composer stays disabled until its first refresh finishes.
    if (conversationId) { await window.PAChat.open(); if (readingConversation !== conversationId) return; }
    const input = conversationRoot?.querySelector('#chat-input'); input?.focus({ preventScroll: true });
  }
  async function followItem(itemId, button) {
    if (pending || window.PAChat.isBusy()) return;
    const token = selectionToken;
    pending = true; setBusy(true); button?.setAttribute('aria-busy', 'true');
    try {
      const saved = await request('journal/conversation', { itemId, scope: snapshot.scope });
      if (!alive || token !== selectionToken) return;
      pending = false; setBusy(false);
      await reload();
      if (!alive || token !== selectionToken) return;
      if (notebookItem !== itemId) return;
      await openConversation({ conversationId: saved.conversationId, itemId });
      setStatus('');
    } catch (error) { if (alive && token === selectionToken) setStatus(error.message, true); }
    finally { pending = false; if (alive) setBusy(false); button?.removeAttribute('aria-busy'); }
  }
  function chapterView(item) { return chapterViews.get(item.id) || (item.source?.kind === 'conversation' ? 'conversation' : 'output'); }
  async function switchChapter(item, view) {
    if (!alive || !['output', 'conversation'].includes(view) || chapterView(item) === view) return;
    if (view === 'conversation' && !conversationIdFor(item)) {
      await followItem(item.id);
      return;
    }
    chapterViews.set(item.id, view); saveWorkState(); patchBoard();
    const page = conversationPages.get(item.id) || [...workpages.values()].find(node => node.dataset.item === item.id);
    const panel = page?.querySelector(view === 'output' ? '.journal-output' : '.journal-conversation');
    if (panel) motion.play(panel, 'enter');
  }
  const automaticEntries = item => automaticContent?.entries?.filter(entry => entry.itemId === item.id) || [];
  function patchAutomatic() {
    const panel = root?.querySelector('#journal-content-settings');
    if (!panel || !automaticContent) return;
    const local = snapshot.scope.account === 'local' && snapshot.scope.userId === 'owner';
    panel.hidden = !local;
    panel.querySelector('summary').textContent = `资料与兴趣${automaticContent.enabled ? ` · 今日 ${automaticContent.today} 条` : ''}`;
    if (automaticDirty || panel.contains(document.activeElement)) return;
    const p = automaticContent;
    const learned = p.entries.filter(entry => entry.learning?.version === p.learning?.version && (entry.learning?.signals > 0 || entry.learning?.guidanceApplied)).length;
    const learningStatus = p.learning?.explicitSignals ? `${p.learning.explicitSignals} 条反馈${learned ? ` · ${learned} 条内容已应用偏好` : ''}` : '';
    const discovered = p.topics.filter(topic => topic.origin === 'discovered' && !topic.muted).map(topic => `${esc(topic.name)}（${topic.explicitSignals && topic.score > 0 ? '继续关注' : '少量探索'}）`).join('、');
    panel.querySelector('.journal-settings-body').innerHTML = `<label><input id="journal-content-enabled" type="checkbox" ${p.enabled ? 'checked' : ''}>自动收集资料</label><label><input id="journal-content-discovery" type="checkbox" ${p.discovery ? 'checked' : ''}>探索新话题</label><fieldset><legend>来源</legend>${[['google-mail', '邮件'], ['github', 'GitHub'], ['x', 'X']].map(([id, label]) => `<label><input type="checkbox" data-content-source="${id}" ${p.sources.includes(id) ? 'checked' : ''}>${label}</label>`).join('')}</fieldset><label for="journal-content-topics">关注话题（每行一个）<textarea id="journal-content-topics" rows="5" maxlength="2020">${esc(p.configuredTopics.join('\n'))}</textarea></label><label for="journal-content-guidance">希望小满怎么说<textarea id="journal-content-guidance" rows="3" maxlength="500" placeholder="例如：轻松一点，先给一句有意思的发现">${esc(p.readingGuidance || '')}</textarea></label><label for="journal-content-limit">每天最多留下<input id="journal-content-limit" type="number" min="1" max="40" value="${p.maxDaily}">条内容</label>${learningStatus ? `<p class="note" data-learning-status>${esc(learningStatus)}</p>` : ''}${p.topics.some(t => t.signals) ? `<p class="note">根据反馈调整：${p.topics.filter(t => t.signals).map(t => `${esc(t.name)}（${t.muted ? '已暂停' : t.score > 0 ? '更关注' : t.score < 0 ? '减少' : '保持'}）`).join('、')}</p>` : ''}${discovered ? `<p class="note">发现的新话题：${discovered}</p>` : ''}<button class="outline" data-j-action="content-settings-save">保存</button>`;
  }
  async function loadAutomatic() {
    const generation = selectionToken;
    const value = await request('automatic-content');
    if (alive && generation === selectionToken && Array.isArray(value?.configuredTopics) && Array.isArray(value?.entries)) { automaticContent = value; patchAutomatic(); patchBoard(); }
  }
  async function contentFeedback(id, reaction, target) {
    if (target) target.disabled = true;
    try {
      const value = await request('automatic-content', { operation: 'feedback', id, reaction });
      if (!alive) return;
      automaticContent = value; patchAutomatic(); patchBoard();
      if (reaction !== 'opened') setStatus('已反馈');
    } catch (error) { if (alive) setStatus(error.message, true); }
    finally { if (target?.isConnected) target.disabled = false; }
  }
  const workpages = new Map(), workDrafts = new Map();
  let notebookSelection = {}, notebookItems = [], notebookItem = null, indexToken = 0;
  const widgetViews = new Map(), widgetDrafts = new Map(), widgetFailures = new Map();
  const busyControls = new Map();
  const browsingControls = '[data-j-tab],[data-j-action="bookmark"],[data-j-action="bookmark-next"],[data-j-action="bookmark-previous"],[data-j-action="notebook-index"],[data-j-action="clear-search"],.jui-reading-details button[aria-expanded],#journal-search';
  let busyFocus, statusTimer, statusMessage = '';
  function focusControl(node) {
    if (!node?.isConnected || node.disabled) return;
    const generation = selectionToken, focused = document.activeElement;
    const restore = () => { if (alive && generation === selectionToken && node.isConnected && !node.disabled && (document.activeElement === focused || document.activeElement === document.body)) node.focus({ preventScroll: true }); };
    if (node.updateComplete) Promise.resolve(node.updateComplete).then(restore).catch(() => {}); else restore();
  }
  function setBusy(value) {
    root?.querySelector('.journal')?.setAttribute('aria-busy', String(value));
    if (value) {
      if (!busyControls.size) busyFocus = document.activeElement;
      for (const node of [...(root?.querySelectorAll('button,wa-button,input,select,textarea') || []), ...(editor?.querySelectorAll('button,wa-button,input,select,textarea') || [])]) {
        if (node.matches(browsingControls) || node.closest('.chat-center,.remote-center')) continue;
        if (!busyControls.has(node)) busyControls.set(node, { disabled: node.disabled, ariaDisabled: node.getAttribute('aria-disabled') });
        // Keep button labels, colors and focus stable while the mutation guard
        // prevents duplicate writes. Reading/navigation remains available.
        if (node.matches('button,wa-button')) node.setAttribute('aria-disabled', 'true');
        else node.disabled = true;
      }
    } else {
      for (const [node, previous] of busyControls) if (node.isConnected) {
        node.disabled = previous.disabled;
        if (previous.ariaDisabled === null) node.removeAttribute('aria-disabled'); else node.setAttribute('aria-disabled', previous.ariaDisabled);
      }
      busyControls.clear();
      if (busyFocus?.isConnected && !busyFocus.disabled && (!busyFocus.closest('dialog') || editor?.open) && document.activeElement === document.body) focusControl(busyFocus);
      busyFocus = null;
    }
  }
  const done = item => ['done', 'cancelled'].includes(item.status);
  const scopeKey = scope => JSON.stringify([scope?.account || 'local', scope?.userId || 'owner']);
  const isoInput = at => { if (!at) return ''; const date = new Date(at); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''; };
  const readableDate = at => { if (!at) return '日期待补'; const date = new Date(at); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) : '日期待校对'; };
  const safeUrl = url => { try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : ''; } catch { return ''; } };
  function setStatus(message, error = false) {
    const node = root?.querySelector('#journal-status'); if (!node || statusMessage === message && node.dataset.error === String(error)) return;
    clearTimeout(statusTimer);
    statusMessage = message; node.dataset.error = String(error);
    window.PAJournalSurfaces.renderStatus(node, message);
    if (error && message) { const rect = node.getBoundingClientRect(); if (rect.top < 0 || rect.bottom > innerHeight) node.scrollIntoView({ block: 'nearest', behavior: 'auto' }); }
    if (message && !error && !message.startsWith('正在')) statusTimer = setTimeout(() => { if (node.isConnected && statusMessage === message) setStatus(''); }, 4000);
  }
  function currentItem(id) { const item = snapshot?.items?.find(item => item.id === id) || extraItems().find(item => item.id === id); return item?.displayTitle ? { ...item, title: item.displayTitle } : item; }
  function preferences() { return { autoLayout: true, motion: 'system', hidden: [], pinned: [], order: [], ...(snapshot?.preferences || {}) }; }
  function hasWidgetDraft(draft) { return !!draft?.selectionDirty || !!draft?.failed || Object.values(draft?.fields || {}).some(fields => Object.keys(fields).length); }
  function isEditing() { return !!editing?.dirty || [...widgetDrafts.values()].some(hasWidgetDraft); }
  function ensureWidgetDraft(widget) {
    let draft = widgetDrafts.get(widget.id);
    if (!draft) {
      const position = [...(root?.querySelectorAll('#journal-board .journal-widget') || [])].findIndex(card => card.dataset.widget === widget.id);
      draft = { scope: { ...snapshot.scope }, revision: snapshot.revision, itemVersion: currentItem(widget.itemId)?.version, itemId: widget.itemId, widget: structuredClone(widget), position, fields: {}, selectionDirty: false };
      widgetDrafts.set(widget.id, draft);
    }
    return draft;
  }
  function rememberWidgetSelection(widget, view, action) {
    if (!['ui-slot', 'ui-route', 'ui-path'].includes(action)) return;
    const draft = ensureWidgetDraft(widget), data = widget.projection?.data || {};
    draft.selectionDirty = action === 'ui-slot' ? view.slotId !== (data.selectedSlotId || '') : action === 'ui-path' ? view.optionId !== (data.selectedOptionId || '') : JSON.stringify([...(view.omittedStopIds || [])].sort()) !== JSON.stringify([...(data.omittedStopIds || [])].sort());
    if (!hasWidgetDraft(draft)) widgetDrafts.delete(widget.id);
  }
  function inlineIdentity(widget) {
    const view = widgetViews.get(widget.id) || {}, data = widget.projection?.data || {};
    const kind = widget.projection?.kind || widget.kind;
    return kind === 'waiting' ? `request:${view.requestId || data.requests?.find(r => r.status === 'waiting')?.id || data.requests?.[0]?.id || ''}` : kind;
  }
  function rememberInline(target) {
    const card = target.closest('.journal-widget'), widget = card && visibleWidgets().find(w => w.id === card.dataset.widget);
    if (!widget || !target.dataset.wField) return;
    const draft = ensureWidgetDraft(widget);
    const key = inlineIdentity(widget);
    draft.fields[key] ||= {}; draft.fields[key][target.dataset.wField] = target.value;
  }
  function writtenFields(values) {
    const key = `${values.kind}:${values.action}`;
    return ({ 'agenda:schedule': ['date'], 'budget:reserve': ['amount'], 'waiting:save-draft': ['text'], 'delivery:record-event': ['stageId', 'at', 'detail', 'evidence'], 'deadline:schedule': ['at', 'label'], 'reminder:record-reminder': ['at', 'minutesBefore'], 'meal:set-servings': ['servings'], 'collection:add-entry': ['title', 'note', 'url'], 'reflection:save-reflection': ['rating', 'text'], 'memory:save-memory': ['text', 'caption', 'occurredAt'] })[key] || (key === 'shopping:quantity' ? [`qty-${values.entryId}`] : key === 'handoff:set-owner' ? [`owner-${values.personId}`] : []);
  }
  function reconcileWidgetDrafts() {
    for (const draft of widgetDrafts.values()) {
      if (!draft.failed && !draft.conflict && scopeKey(draft.scope) === scopeKey(snapshot.scope) && currentItem(draft.itemId)?.version === draft.itemVersion) draft.revision = snapshot.revision;
    }
  }
  async function writeWidget(widget, values, target, observed) {
    const ownedDraft = ensureWidgetDraft(widget), context = observed || ownedDraft;
    const generation = selectionToken, identity = scopeKey(context.scope);
    const saved = await mutate('widget', values, widget.itemId, target, context);
    if (!alive || generation !== selectionToken || scopeKey(snapshot.scope) !== identity) return saved;
    if (saved) {
      widgetFailures.delete(widget.id);
      const draft = widgetDrafts.get(widget.id), key = inlineIdentity(widget);
      for (const field of writtenFields(values)) if (draft?.fields?.[key]) delete draft.fields[key][field];
      if (draft && ['choose-slot', 'choose-path', 'set-route'].includes(values.action)) draft.selectionDirty = false;
      if (draft) { draft.revision = snapshot.revision; draft.itemVersion = currentItem(widget.itemId)?.version; draft.conflict = false; draft.failed = false; }
      if (draft && !hasWidgetDraft(draft)) widgetDrafts.delete(widget.id);
      patchBoard();
    } else if (alive && root) {
      const conflict = ['CONFLICT', 'VERSION_CONFLICT'].includes(lastMutationError?.code);
      widgetFailures.set(widget.id, { message: lastMutationError?.message || '保存未完成，输入仍保留。', conflict, values, observed: { ...context, scope: { ...context.scope } } });
      if (widgetDrafts.has(widget.id)) { widgetDrafts.get(widget.id).conflict = conflict; widgetDrafts.get(widget.id).failed = true; }
      patchBoard();
    }
    return saved;
  }
  let lastMutationError;
  function visibleWidgets() {
    if (guideOnly && !snapshot?.guide) return [];
    const items = snapshot?.items || [], p = preferences(), widgets = tab === 'recent' ? [...(snapshot?.layout?.widgets || [])] : items.flatMap(item => {
      if (item.source?.kind === 'guide' && item.guideProjections?.length) return item.guideProjections.map(projection => ({ id: `list-${item.id}-${projection.kind}`, itemId: item.id, kind: projection.kind, projection }));
      const current = (snapshot?.layout?.widgets || []).find(w => w.itemId === item.id && w.emphasis === 'primary') || (snapshot?.layout?.widgets || []).find(w => w.itemId === item.id);
      const projection = item.primaryProjection || current?.projection;
      return { id: `list-${item.id}`, itemId: item.id, kind: projection?.kind || (done(item) ? 'memory' : item.taskType !== 'auto' && item.taskType ? item.taskType : 'agenda'), ...(projection ? { projection } : {}) };
    });
    if (tab === 'recent') for (const routine of snapshot?.routines || []) {
      const item = items.find(value => value.id === routine.journalItemId), projection = item?.primaryProjection;
      if (projection && !widgets.some(widget => widget.itemId === item.id)) widgets.push({ id: `${item.id}:${projection.kind}`, itemId: item.id, kind: projection.kind, projection });
    }
    if (tab === 'recent') for (const [id, draft] of widgetDrafts) {
      if (!hasWidgetDraft(draft) || !draft.widget || scopeKey(draft.scope) !== scopeKey(snapshot.scope) || !currentItem(draft.itemId)) continue;
      const index = widgets.findIndex(widget => widget.id === id), current = widgets[index];
      if (!current) widgets.splice(draft.position < 0 ? widgets.length : Math.min(draft.position, widgets.length), 0, { ...draft.widget, uiRetained: true });
      else if (current.itemId !== draft.widget.itemId || (current.projection?.kind || current.kind) !== (draft.widget.projection?.kind || draft.widget.kind)) widgets[index] = { ...draft.widget, uiRetained: true };
    }
    // A dated edition remains reachable even after it leaves the generated layout.
    const requestedEdition = items.find(item => item.id === notebookSelection[tab] && indexAPI.seriesId(item));
    const latestEditions = new Set(indexAPI.directory(items.filter(item => indexAPI.seriesId(item) && !done(item)).map(item => ({ itemId: item.id })), items).map(group => group.itemId));
    if (tab === 'recent') for (const item of items.filter(item => indexAPI.seriesId(item) && (search || item === requestedEdition || latestEditions.has(item.id)))) {
      if (!widgets.some(widget => widget.itemId === item.id) && item.primaryProjection) widgets.push({ id: `edition-${item.id}`, itemId: item.id, kind: item.primaryProjection.kind, projection: item.primaryProjection });
    }
    const filtered = widgets.filter(widget => {
      const item = currentItem(widget.itemId); if (!item || p.hidden.includes(widget.id) || item.source?.kind === 'guide' && !snapshot.guide || guideOnly && item.source?.kind !== 'guide') return false;
      if (tab === 'recent' && done(item) && !widget.uiRetained && item.id !== requestedEdition?.id && !(search && indexAPI.seriesId(item))) return false;
      if (tab === 'kept' && !done(item) && !['experience', 'wish'].includes(item.kind)) return false;
      if (!search) return true;
      const text = [item.title, item.note, ...(item.steps || []).map(step => step.label)];
      if (indexAPI.seriesId(item)) text.push(item.contentSeries.title, item.contentSeries.day, ...(item.taskData?.collection?.entries || []).flatMap(entry => [entry.title, entry.note]), ...(item.contentPreviews || []).flatMap(entry => [entry.hook, entry.summary]));
      return text.filter(Boolean).join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase());
    });
    if (tab !== 'recent') return filtered.sort((a, b) => String(currentItem(b.itemId).updatedAt).localeCompare(String(currentItem(a.itemId).updatedAt)));
    return filtered.sort((a, b) => (p.pinned.includes(b.id) ? 1 : 0) - (p.pinned.includes(a.id) ? 1 : 0) || (p.order.indexOf(a.id) < 0 ? 10000 : p.order.indexOf(a.id)) - (p.order.indexOf(b.id) < 0 ? 10000 : p.order.indexOf(b.id)));
  }
  function basicContent(widget, item, embedded = false) {
    if (widgetAPI) {
      const kind = widget.projection?.kind || widget.kind, draft = widgetDrafts.get(widget.id), failure = widgetFailures.get(widget.id);
      const sourceNames = { weixin: '微信交代', imessage: 'iMessage 交代', web: '网页录入', webui: '网页录入', local: '手动录入', background: '小满自动整理' };
      const draftNotice = hasWidgetDraft(draft) ? `<div class="journal-widget-draft">${widget.uiRetained ? '<p>看板待更新：先保存或放弃这份输入，再呈现新的排版。</p>' : ''}<button class="text" data-j-action="widget-discard" data-widget="${esc(widget.id)}">放弃这份未保存的输入</button></div>` : '';
      const body = `${embedded ? '' : `<div class="journal-widget-top"><small>${esc(widgetNames[kind] || '生活事项')}</small><span class="tag">${esc(statusNames[item.status] || item.status)}</span></div>`}${widgetAPI.render(widget, item, { ...widgetViews.get(widget.id), automaticEntries: automaticEntries(item) }, { embedded })}${draftNotice}${failure ? `<div class="journal-widget-error" role="alert"><p>${esc(failure.message)}</p>${failure.conflict ? `<button class="outline" data-j-action="widget-review" data-widget="${esc(widget.id)}">核对最新记录，保留草稿</button>` : `<button class="outline" data-j-action="widget-retry" data-widget="${esc(widget.id)}">重试保存</button>`}</div>` : ''}${draft?.conflict && !failure ? '<p class="note">这份草稿基于旧版本，请先核对最新记录。</p>' : ''}`;
      if (embedded) return body;
      return `${body}<details class="journal-source"><summary>来源与记录</summary><p>${esc(sourceNames[item.source?.channel] || '生活记录')} · ${esc(readableDate(item.source?.at || item.createdAt))}</p><blockquote>${esc(item.source?.text || item.title)}</blockquote><p>更新于 ${esc(readableDate(item.updatedAt))}</p>${widget.reason ? `<p>整理依据：${esc(widget.reason)}</p>` : ''}</details><div class="actions"><button class="outline" data-j-action="edit" data-item="${esc(item.id)}">校对这件事</button>${!done(item) ? `<button class="text" data-j-action="done" data-item="${esc(item.id)}">确认结束</button>` : `<button class="text" data-j-action="undo" data-item="${esc(item.id)}">重新打开</button>`}</div>`;
    }
    const auxiliary = tab === 'recent' && ['checklist', 'comparison', 'timeline', 'waiting'].includes(widget.kind);
    let content = auxiliary ? `<h2>${esc(widgetNames[widget.kind])}</h2><p class="journal-related">${esc(item.title)}</p>` : `<div class="journal-widget-top"><small>${esc(widgetNames[widget.kind] || kindNames[item.kind])}</small><span class="tag">${esc(statusNames[item.status] || item.status)}</span></div><h2>${esc(item.title)}</h2><div class="journal-widget-meta"><span>${esc(kindNames[item.kind] || '生活事项')}</span><time>${esc(readableDate(item.date))}</time></div>`;
    if (item.note && ['focus', 'memory', 'wish', 'waiting'].includes(widget.kind)) content += `<p class="journal-widget-note">${esc(item.note)}</p>`;
    if (widget.kind === 'checklist' || tab !== 'recent' && (item.steps || []).length) {
      const steps = item.steps || [];
      if (tab !== 'recent') content += '<h3>准备步骤</h3>';
      content += steps.length ? `<ul class="journal-checklist">${steps.map(step => `<li data-j-row="${esc(step.id)}"><label><input type="checkbox" data-j-step="${esc(step.id)}" data-item="${esc(item.id)}" ${step.done ? 'checked' : ''} ${done(item) ? 'disabled' : ''}><span>${esc(step.label)}</span></label></li>`).join('')}</ul><p class="subtext">已确认 ${steps.filter(step => step.done).length} / ${steps.length} 个步骤 · 勾选不代表整件事结束</p>` : '<p class="note">还没有准备步骤，可在事项里补充。</p>';
    }
    if (widget.kind === 'focus' && (item.steps || []).length) {
      const steps = item.steps, next = steps.find(step => !step.done);
      content += `<p class="journal-next-step">${next ? `下一步 · ${esc(next.label)}` : '准备步骤已完成，整件事仍等待你确认结束。'}</p><p class="subtext">已确认 ${steps.filter(step => step.done).length} / ${steps.length} 个步骤</p>`;
    }
    if (widget.kind === 'timeline') content += `<ol class="journal-timeline"><li><time>${esc(readableDate(item.date))}</time>已记录的安排时间</li>${item.note ? `<li>${esc(item.note)}</li>` : ''}</ol>`;
    if (widget.kind === 'comparison' || tab !== 'recent' && (item.candidates || []).length) {
      const candidates = item.candidates || [];
      if (tab !== 'recent') content += '<h3>候选与选择</h3>';
      content += candidates.length ? candidates.map(candidate => `<section class="journal-candidate" data-j-candidate="${esc(candidate.id)}" data-selected="${!!candidate.selected}"><h3>${esc(candidate.name)}</h3>${candidate.detail ? `<p>${esc(candidate.detail)}</p>` : ''}${safeUrl(candidate.url) ? `<a href="${esc(safeUrl(candidate.url))}" target="_blank" rel="noopener noreferrer">查看材料来源 ↗</a>` : ''}<button class="outline" data-j-action="choose" data-item="${esc(item.id)}" data-candidate="${esc(candidate.id)}" ${done(item) ? 'disabled' : ''}>${candidate.selected ? '已选定此项' : '标记选择'}</button></section>`).join('') + '<p class="note">选择只记录你的决定，购买仍由你完成。</p>' : '<p class="note">候选待补充；这里没有进行实时商品查询。</p>';
    }
    if (widget.kind === 'waiting') content += `<p class="note">${(item.candidates || []).some(candidate => candidate.selected) ? `已选择：${esc(item.candidates.find(candidate => candidate.selected).name)}。订购或取货信息请继续补充。` : '按已记录的资料跟进。'} 不表示后台正在监控订单。</p>`;
    content += `<details class="journal-source"><summary>来源与记录时间</summary><p>${item.source?.channel === 'weixin' ? '微信交代' : '本机录入'} · ${esc(readableDate(item.source?.at || item.createdAt))}</p><blockquote>${esc(item.source?.text || item.title)}</blockquote><p>当前事项版本 ${esc(item.version)} · 更新于 ${esc(readableDate(item.updatedAt))}</p>${widget.reason ? `<p>展示原因：${esc(widget.reason)}</p>` : ''}</details><div class="actions"><button class="outline" data-j-action="edit" data-item="${esc(item.id)}">查看与校对</button>${auxiliary ? '' : !done(item) ? `<button class="text" data-j-action="done" data-item="${esc(item.id)}">确认结束</button>` : `<button class="text" data-j-action="undo" data-item="${esc(item.id)}">重新打开</button>`}</div>`;
    return content;
  }
  function controls(widget, index, count) {
    if (tab !== 'recent' || widget.uiRetained || currentItem(widget.itemId)?.source?.kind === 'guide') return '';
    const p = preferences(), visible = visibleWidgets().filter(w => !w.uiRetained), pinned = p.pinned.includes(widget.id), crosses = offset => visible[index + offset] && p.pinned.includes(visible[index + offset].id) !== pinned;
    index = visible.findIndex(w => w.id === widget.id); count = visible.length;
    return `<details class="journal-adjust" data-w-detail="layout-${esc(widget.id)}"><summary>${esc(widgetNames[widget.projection?.kind || widget.kind] || '组件')}版式${p.pinned.includes(widget.id) ? ' · 已固定' : ''}</summary><div class="journal-widget-controls"><button data-j-action="pin" data-widget="${esc(widget.id)}" aria-pressed="${p.pinned.includes(widget.id)}">${p.pinned.includes(widget.id) ? '已固定' : '固定'}</button><button data-j-action="up" data-widget="${esc(widget.id)}" ${index === 0 || crosses(-1) ? 'disabled' : ''}>上移</button><button data-j-action="down" data-widget="${esc(widget.id)}" ${index === count - 1 || crosses(1) ? 'disabled' : ''}>下移</button><button data-j-action="hide" data-widget="${esc(widget.id)}">隐藏</button></div></details>`;
  }
  function nodeKey(node) {
    if (node.nodeType !== 1) return null;
    const data = node.dataset;
    return node.id ? `id:${node.id}` : data.wDetail ? `detail:${data.wDetail}` : data.wCheckbox ? `checkbox:${data.wCheckbox}:${data.wPayload}` : data.wField ? `field:${data.wField}` : data.jStep ? `step:${data.jStep}` : data.jRow ? `row:${data.jRow}` : data.jCandidate ? `candidate:${data.jCandidate}` : data.wAction ? `widget-action:${data.wAction}:${data.wPayload}` : data.jAction ? `action:${data.jAction}:${data.item || ''}:${data.widget || ''}:${data.candidate || ''}` : null;
  }
  function syncNode(node, next) {
    if (node.nodeType === 3) { if (node.data !== next.data) node.data = next.data; return; }
    if (node.nodeType !== 1) return;
    const animatingDetail = node.tagName === 'DETAILS' && node.dataset.motionTarget;
    const ownedByMotion = name => animatingDetail && ['style', 'open', 'data-motion-target'].includes(name);
    for (const attribute of [...node.attributes]) if (!ownedByMotion(attribute.name) && !next.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
    for (const attribute of next.attributes) if (!ownedByMotion(attribute.name) && node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
    // The official OpenUI reading cards own this subtree, including disclosure
    // state and focused feedback buttons; polling only updates their props.
    if (node.hasAttribute('data-auto-reading') || node.hasAttribute('data-guide-report')) return;
    if (node.tagName === 'INPUT') { if (node.type === 'checkbox') node.checked = next.checked; else if (document.activeElement !== node) node.value = next.value; node.disabled = next.disabled; }
    if (node.tagName === 'SELECT' && document.activeElement !== node) node.value = next.value;
    if (node.tagName === 'TEXTAREA' && document.activeElement !== node) node.value = next.value;
    if (node.tagName === 'WA-BUTTON') node.disabled = next.hasAttribute('disabled');
    const existing = [...node.childNodes], used = new Set();
    for (const [index, child] of [...next.childNodes].entries()) {
      const key = nodeKey(child);
      let match = key ? existing.find(old => !used.has(old) && nodeKey(old) === key) : existing.find(old => !used.has(old) && !nodeKey(old) && old.nodeType === child.nodeType && (old.nodeType !== 1 || old.tagName === child.tagName));
      if (match) { used.add(match); syncNode(match, child); } else match = child.cloneNode(true);
      if (node.childNodes[index] !== match) {
        const focus = match.contains?.(document.activeElement) ? document.activeElement : null;
        node.insertBefore(match, node.childNodes[index] || null);
        focus?.focus({ preventScroll: true });
      }
    }
    for (const old of existing) if (!used.has(old)) old.remove();
  }
  function patchContent(card, html) {
    const next = document.createElement('article'); next.innerHTML = html;
    const open = new Set([...card.querySelectorAll('details[open]')].map(details => nodeKey(details) || details.className));
    syncNode(card, next);
    for (const details of card.querySelectorAll('details')) if (open.has(nodeKey(details) || details.className)) details.open = true;
  }
  const workStorageKey = () => `pa-journal-work-v1:${scopeKey(snapshot?.scope)}`;
  const notebookStorageKey = () => `pa-journal-bookmarks-v1:${scopeKey(snapshot?.scope)}`;
  function saveWorkState() {
    // Store local viewing choices and pending mutation identities, never source text.
    const values = {};
    for (const item of snapshot?.items || []) {
      const draft = workDrafts.get(item.id), views = {};
      for (const widget of snapshot.layout?.widgets || []) if (widget.itemId === item.id && widgetViews.has(widget.id)) views[widget.id] = widgetViews.get(widget.id);
      if (draft || Object.keys(views).length || chapterViews.has(item.id)) values[item.id] = { chapterView: chapterView(item), parameters: draft?.parameters || {}, open: !!draft?.open, ...(typeof draft?.expanded === 'boolean' ? { expanded: draft.expanded } : {}), sourceOpen: !!draft?.sourceOpen, ...(draft?.submission ? { submission: draft.submission } : {}), ...(draft?.routineSubmission ? { routineSubmission: draft.routineSubmission } : {}), ...(draft?.routineSettings ? { routineSettings: draft.routineSettings } : {}), ...(draft?.suggestionSubmission ? { suggestionSubmission: draft.suggestionSubmission } : {}), panels: draft?.panels || {}, views };
    }
    try {
      localStorage.setItem(workStorageKey(), JSON.stringify(values));
      localStorage.setItem(notebookStorageKey(), JSON.stringify(notebookSelection));
    } catch { /* Session remains usable if browser storage is unavailable. */ }
  }
  function restoreWorkState() {
    workDrafts.clear();
    chapterViews.clear();
    notebookSelection = {}; notebookItem = null;
    try {
      const saved = JSON.parse(localStorage.getItem(notebookStorageKey()) || '{}');
      for (const view of ['recent', 'all', 'kept']) if (typeof saved?.[view] === 'string' && saved[view].length <= 200) notebookSelection[view] = saved[view];
    } catch { /* Invalid reading position does not affect the ledger. */ }
    let values; try { values = JSON.parse(localStorage.getItem(workStorageKey()) || '{}'); } catch { return; }
    for (const item of snapshot?.items || []) {
      const value = values?.[item.id]; if (!value || typeof value !== 'object') continue;
      if (['output', 'conversation'].includes(value.chapterView)) chapterViews.set(item.id, value.chapterView);
      const parameters = {};
      for (const key of ['servings', 'budgetTotal']) if (typeof value.parameters?.[key] === 'string' && value.parameters[key].length <= 20) parameters[key] = value.parameters[key];
      workDrafts.set(item.id, { parameters, open: value.open === true, ...(typeof value.expanded === 'boolean' ? { expanded: value.expanded } : {}), sourceOpen: value.sourceOpen === true, panels: Object.fromEntries(Object.entries(value.panels || {}).filter(([key, value]) => key.length <= 200 && typeof value === 'boolean')), restored: Object.keys(parameters).length > 0 });
      const routineRequest = value.routineSubmission, routine = routineFor(item);
      if (routine && routineRequest?.id === routine.id && ['pause', 'resume', 'run_now', 'end', 'update', 'authorize_scope'].includes(routineRequest.operation) && Number.isSafeInteger(routineRequest.version) && routineRequest.version > 0 && /^[a-zA-Z0-9:_-]{8,128}$/.test(routineRequest.requestId || '') && JSON.stringify(routineRequest).length < 16000) {
        workDrafts.get(item.id).routineSubmission = { id: routine.id, version: routineRequest.version, operation: routineRequest.operation, requestId: routineRequest.requestId, ...(routineRequest.operation === 'update' && { values: routineRequest.values }) };
      }
      if (value.routineSettings && typeof value.routineSettings === 'object') workDrafts.get(item.id).routineSettings = value.routineSettings;
      const suggestion = value.suggestionSubmission;
      if (suggestion && ['accept', 'dismiss'].includes(suggestion.operation) && typeof suggestion.id === 'string' && suggestion.id.length <= 128 && /^[a-zA-Z0-9:_-]{8,128}$/.test(suggestion.requestId || '') && JSON.stringify(suggestion).length < 1000) workDrafts.get(item.id).suggestionSubmission = suggestion;
      const saved = value.submission, context = saved?.context;
      if (context && scopeKey(context.scope) === scopeKey(snapshot.scope) && context.itemId === item.id && Number.isSafeInteger(context.revision) && Number.isSafeInteger(context.itemVersion) && context.itemVersion >= 1 && /^[a-f0-9]{64}$/.test(saved.previewHash || '') && /^[a-zA-Z0-9:_-]{8,128}$/.test(saved.requestId || '') && context.parameters && Object.entries(context.parameters).every(([key, value]) => ['servings', 'budgetTotal'].includes(key) && Number.isFinite(value))) {
        const draft = workDrafts.get(item.id);
        draft.submission = { context: { scope: { ...snapshot.scope }, revision: context.revision, itemVersion: context.itemVersion, itemId: item.id, parameters: { ...context.parameters } }, previewHash: saved.previewHash, requestId: saved.requestId };
        draft.open = true; draft.restored = false;
      }
      for (const widget of snapshot.layout?.widgets || []) {
        const view = value.views?.[widget.id];
        if (widget.itemId === item.id && view && typeof view === 'object') {
          const safe = {};
          for (const key of ['stepId', 'phaseId', 'entryId', 'requestId']) if (typeof view[key] === 'string' && view[key].length <= 128) safe[key] = view[key];
          widgetViews.set(widget.id, safe);
        }
      }
    }
  }
  function workDraft(item) {
    if (!workDrafts.has(item.id)) workDrafts.set(item.id, { parameters: {}, open: false });
    return workDrafts.get(item.id);
  }
  function workParameters(item) {
    const data = item.taskData || {};
    return { servings: Number.isFinite(data.meal?.baseServings) && data.meal.baseServings > 0 && Number.isFinite(data.meal?.servings), budgetTotal: !!data.budget };
  }
  function workExpanded(item) {
    if (routineFor(item)) return true;
    const draft = workDraft(item);
    // Unresolved saves remain visible, including drafts restored from before
    // the overview was introduced. Explicit viewing choices are browser-local.
    return !!draft.submission || !!draft.busy || (draft.expanded ?? true);
  }
  function workPriority(item, now = Date.now()) {
    const deadline = item.taskData?.deadline, due = Date.parse(deadline?.dueAt), next = Date.parse(deadline?.nextAt);
    const times = [Date.parse(item.date), due, next, Date.parse(item.taskData?.reminder?.at)].filter(Number.isFinite);
    const upcoming = times.filter(at => at >= now);
    const at = upcoming.length ? Math.min(...upcoming) : times.length ? Math.max(...times) : NaN;
    const updated = Date.parse(item.updatedAt), hours = 3600000;
    const recent = Number.isFinite(updated) && updated <= now + 60000 && updated >= now - 48 * hours;
    const automatic = item.source?.kind === 'automatic', past = Number.isFinite(at) && at < now;
    const timing = { past, at, timeLabel: at === due ? '截止 ' : at === next ? '下一步 ' : '' };
    // A recorded deadline is different from an old appointment. Never bury an
    // unresolved deadline merely because nobody has edited the record recently.
    if (!automatic && !done(item) && due < now) return { rank: 0, label: '已过截止 · 待核对', sort: due, at: due, timeLabel: '截止 ', past: true, expiredDeadline: true };
    if (!automatic && at < now && at >= now - 24 * hours) return { ...timing, rank: 0, label: '最近一天的安排', sort: at };
    if (!automatic && at >= now && at <= now + 24 * hours) return { ...timing, rank: 0, label: at === due ? '一天内截止' : '一天内的安排', sort: at };
    if (automatic && recent) return { ...timing, rank: 1, label: '新整理', sort: -updated };
    if (!automatic && at >= now && at <= now + 7 * 24 * hours) return { ...timing, rank: 2, label: at === due ? '一周内截止' : '一周内的安排', sort: at };
    if (recent) return { ...timing, rank: 3, label: past ? '时间已过 · 最近更新' : '最近更新', sort: -updated };
    if (past) return { ...timing, rank: 6, label: '较早安排 · 时间已过', sort: -at };
    return { ...timing, rank: automatic ? 5 : 4, label: automatic ? '此前整理' : '继续处理', sort: Number.isFinite(at) ? at : 0 };
  }
  function workPlan(item, widgets) {
    const plans = (snapshot.layout?.workpages || []).filter(value => value.itemId === item.id);
    if (plans.length) return { ...plans[0], sections: plans.flatMap(plan => plan.sections || []) };
    const data = item.taskData || {}, missingShopping = data.shopping?.entries?.find(entry => !entry.bought && !entry.atHome), nextCooking = data.meal?.instructions?.find(step => !step.done), nextPrep = item.steps?.find(step => !step.done);
    const nextStep = done(item) ? '留下一点感受，下次准备时可以再翻看。' : nextPrep?.label || (missingShopping ? `核对还缺的 ${missingShopping.name}` : nextCooking?.label) || (item.candidates?.length && !item.candidates.some(candidate => candidate.selected) ? '对照已知材料，选一个合适的候选。' : '核对已知材料，补上仍未确认的条件。');
    const primaryKind = nextPrep ? 'prep' : missingShopping ? 'shopping' : nextCooking ? 'meal' : widgets[0]?.projection?.kind;
    return { itemId: item.id, stage: done(item) ? 'reflection' : missingShopping ? 'shopping' : nextCooking ? 'cooking' : 'preparing', nextStep, sections: widgets.map(widget => ({ id: widget.id, widgetIds: [widget.id], role: (widget.projection?.kind || widget.kind) === primaryKind ? 'primary' : 'support', density: ['budget', 'waiting'].includes(widget.projection?.kind || widget.kind) ? 'compact' : 'comfortable' })) };
  }
  function workGroups(widgets) {
    if (!widgetAPI) return widgets.map(widget => ({ id: widget.id, itemId: widget.itemId, widgets: [widget], embedded: false }));
    const customOrder = tab !== 'recent' || preferences().pinned.length || preferences().order.length, groups = [], byItem = new Map();
    for (const widget of widgets) {
      // Explicit user ordering takes precedence over grouping. Never move a pinned card.
      let group = customOrder ? groups.at(-1) : byItem.get(widget.itemId);
      if (!group || group.itemId !== widget.itemId) {
        group = { id: customOrder ? `${widget.itemId}:${widget.id}` : widget.itemId, itemId: widget.itemId, widgets: [], embedded: true };
        groups.push(group); byItem.set(widget.itemId, group);
      }
      group.widgets.push(widget);
    }
    if (!customOrder) for (const group of groups) {
      if (currentItem(group.itemId)?.source?.kind === 'guide') { group.widgets.sort((a, b) => ['prep', 'decision'].indexOf(a.kind) - ['prep', 'decision'].indexOf(b.kind)); continue; }
      const plan = workPlan(currentItem(group.itemId), group.widgets);
      const role = widget => plan.sections?.find(section => section.widgetIds?.includes(widget.id))?.role === 'primary' ? 0 : 1;
      const page = workpages.get(group.id), active = page?.contains(document.activeElement) || page?.contains(busyFocus);
      if (active) {
        const previous = [...page.querySelectorAll('.journal-widget')].map(card => card.dataset.widget);
        group.widgets.sort((a, b) => (previous.includes(a.id) ? previous.indexOf(a.id) : 10000) - (previous.includes(b.id) ? previous.indexOf(b.id) : 10000));
      } else group.widgets.sort((a, b) => role(a) - role(b));
    }
    if (!customOrder) {
      const previous = [...(root?.querySelectorAll('#journal-board > .journal-workpage') || [])].map(page => page.dataset.group);
      const reading = root.querySelector('#journal-board').dataset.view === tab && groups.some(group => group.itemId === notebookItem && workExpanded(currentItem(group.itemId)));
      // Keep the reading position stable while a work page is open. New groups
      // join at the end until the reader closes the pages or reloads the view.
      if (reading && previous.length) groups.sort((a, b) => (previous.includes(a.id) ? previous.indexOf(a.id) : 10000) - (previous.includes(b.id) ? previous.indexOf(b.id) : 10000));
      else {
        const now = Date.now();
        groups.sort((a, b) => { const left = workPriority(currentItem(a.itemId), now), right = workPriority(currentItem(b.itemId), now); return left.rank - right.rank || left.sort - right.sort; });
      }
    }
    if (!preferences().pinned.length && !preferences().order.length) groups.sort((a, b) => Number(currentItem(b.itemId)?.source?.kind === 'guide' && !done(currentItem(b.itemId))) - Number(currentItem(a.itemId)?.source?.kind === 'guide' && !done(currentItem(a.itemId))));
    return groups;
  }
  function compactSummary(widget, item) {
    const data = widget.projection?.data || {}, kind = widget.projection?.kind || widget.kind;
    if (kind === 'prep') { const steps = data.steps || item.steps || []; return `${steps.filter(step => step.done).length} / ${steps.length} 项已准备`; }
    if (kind === 'budget') return Number.isFinite(data.total) ? `预算 ¥${data.total.toLocaleString('zh-CN')}` : '预算待补';
    if (kind === 'shopping') return `${(data.entries || []).filter(entry => !entry.bought && !entry.atHome).length} 种待买`;
    if (kind === 'meal') return Number.isFinite(data.servings) ? `${data.servings} 人份 · ${(data.instructions || []).length} 步` : '份量待补';
    if (kind === 'decision') return `${(data.candidates || item.candidates || []).length} 个候选`;
    if (kind === 'agenda') return item.date ? readableDate(item.date) : '时间待补';
    return (widget.projection?.missing || []).length ? '仍有材料待补' : '查看已记录的材料';
  }
  function trialResult(item, draft) {
    if (draft.submission) {
      const parameters = draft.submission.context.parameters;
      return `<div class="journal-trial-result journal-trial-uncertain"><h3 tabindex="-1">这次保存的结果还待确认</h3><p>${Object.entries(parameters).map(([key, value]) => `${key === 'servings' ? '人数' : '总预算'}：${esc(value)}${key === 'servings' ? ' 人' : ' 元'}`).join(' · ')}</p><p class="journal-trial-note">${draft.busy ? '正在核对这次保存。' : '已保留原来的保存请求。核对结果后，再调整其他条件。'}</p><button class="outline" data-j-action="work-reconcile" data-item="${esc(item.id)}" ${draft.busy ? 'disabled' : ''}>${draft.busy ? '正在核对…' : '核对保存结果'}</button></div>`;
    }
    const preview = draft.preview;
    if (!preview) return draft.restored ? '<p class="journal-trial-note">上次的试算条件已恢复。查看影响后，再决定是否采用。</p>' : '';
    const stale = preview.baseVersion !== item.version;
    const labels = { changed: '将更新', preserved: '保留', needs_review: '待核实' };
    const value = (number, unit) => number === null || number === undefined ? '未知' : unit === 'CNY' ? `¥${esc(Number(number).toLocaleString('zh-CN', { maximumFractionDigits: 2 }))}` : `${esc(number)}${unit ? ` ${esc(unit)}` : ''}`;
    return `<div class="journal-trial-result" id="journal-trial-result-${esc(item.id)}"><div class="journal-trial-result-title"><h3 tabindex="-1">这次调整会影响什么</h3><span>试算 · 未采用</span></div><ul class="journal-trial-changes">${(preview.changes || []).map(change => `<li data-change="${esc(change.status)}"><div><strong>${esc(change.label)}${['ingredient', 'shopping'].includes(change.kind) ? `<small>${change.kind === 'ingredient' ? '食谱所需' : '采购记录'}</small>` : ''}</strong><span>${esc(labels[change.status] || '待核实')}</span></div><p>${value(change.before, change.unit)} <span aria-label="改为">→</span> ${value(change.after, change.unit)}</p></li>`).join('')}</ul>${preview.warnings?.length ? `<ul class="journal-trial-warnings">${preview.warnings.map(warning => `<li>${esc(warning.message || warning)}</li>`).join('')}</ul>` : ''}${stale ? '<p class="journal-trial-error" role="status">记录已在别处更新。条件仍保留，请重新查看影响后再采用。</p>' : ''}<div class="actions"><button class="primary" data-j-action="work-apply" data-item="${esc(item.id)}" ${stale || !preview.canApply || draft.busy ? 'disabled' : ''}>采用这次调整</button><button class="text" data-j-action="work-reset" data-item="${esc(item.id)}" ${draft.busy ? 'disabled' : ''}>放弃试算</button></div></div>`;
  }
  function workHeader(item, widgets, plan, groupId, continuation = false, chapter = 1) {
    const expanded = workExpanded(item), priority = workPriority(item), automatic = item.source?.kind === 'automatic';
    const entries = item.taskData?.collection?.entries || [];
    const draft = workDraft(item);
    const toggle = `<button class="text journal-work-toggle" data-j-action="work-toggle" data-item="${esc(item.id)}" aria-expanded="${expanded}" aria-controls="work-body-${esc(groupId)}" ${draft.busy || draft.submission ? 'disabled' : ''}>${expanded ? '收起' : automatic ? `阅读 ${entries.length} 条` : '展开'}</button>`;
    const title = item.contentSeries?.title || item.title;
    const editions = indexAPI.editions(snapshot.items, item);
    const editionPicker = !editions.length ? '' : editions.length === 1 ? `<time class="journal-edition-date">${esc(item.contentSeries.day)}</time>` : `<label class="journal-edition-picker"><span class="sr-only">${esc(title)}日期</span><select data-j-edition="${esc(item.id)}" aria-label="${esc(title)}日期">${editions.map((edition, i) => `<option value="${esc(edition.id)}" ${edition.id === item.id ? 'selected' : ''}>${esc(edition.contentSeries.day)}${i === 0 ? ' · 最新' : ''}</option>`).join('')}</select></label>`;
    const heading = `<div class="journal-chapter-title"${title.length > 60 ? ' data-long-title="true"' : ''}>${continuation ? '' : `<span class="journal-chapter-number" aria-hidden="true">${String(chapter).padStart(2, '0')}</span>`}<h2 id="work-title-${esc(groupId)}" tabindex="-1">${esc(title)}${continuation ? ' · 继续' : ''}</h2></div>`;
    const routine = routineFor(item);
    if (routine) return `<div class="journal-work-heading"><div>${heading}</div></div>${routineUI.render(routine, item.id, draft, undefined, snapshot.routinesError, snapshot.routineNotices || {})}`;
    if (!expanded) {
      const custom = preferences().pinned.length || preferences().order.length;
      const reason = custom ? widgets.some(widget => preferences().pinned.includes(widget.id)) ? '已固定' : '按你的顺序' : priority.label;
      const next = priority.expiredDeadline ? '已记录的截止时间已过，完成情况仍需核对。' : priority.past ? '原定时间已过，可展开核对安排与已记录的进度。' : typeof plan.nextStep === 'string' ? plan.nextStep : plan.nextStep?.label || '展开查看已记录的材料。';
      const summary = automatic ? `<ul class="journal-overview-titles">${[...entries].reverse().slice(0, 2).map(entry => `<li>${esc(automaticEntries(item).find(value => value.entryId === entry.id)?.hook || entry.title)}</li>`).join('')}</ul>` : `<p class="journal-overview-next">${esc(next)}</p>`;
      const facts = [Number.isFinite(priority.at) && `${priority.timeLabel}${readableDate(priority.at)}`, !automatic && item.steps?.length && `${item.steps.filter(step => step.done).length}/${item.steps.length} 项已准备`, automatic && `更新于 ${readableDate(item.updatedAt)}`].filter(Boolean);
      return `<div class="journal-work-heading journal-overview-heading"><div>${heading}${editionPicker}<p class="journal-work-stage">${esc(reason)}</p></div><div class="journal-work-heading-actions">${toggle}</div></div>${summary}${facts.length ? `<p class="journal-work-facts">${facts.map(fact => `<span>${esc(fact)}</span>`).join('')}</p>` : ''}`;
    }
    if (item.source?.kind === 'guide') return `<div class="journal-work-heading"><div>${heading}</div></div>`;
    if (automatic) return `<div class="journal-work-heading"><div>${heading}${editionPicker}</div><div class="journal-work-heading-actions"><span class="journal-reading-count">${entries.length} 条</span>${toggle}</div></div>${followupSuggestion(item)}`;
    const data = item.taskData || {}, stage = ({ past_date: '日期已过', preparing: '准备中', prepare: '准备中', planning: '先做计划', shopping: '采购准备', cooking: '做饭中', deciding: '等待选择', decision: '等待选择', reflection: '收尾回看', complete: '收尾回看', done: '收尾回看', waiting: '等待回音', cancelled: '已取消', planned: '已记下' })[plan.stage] || statusNames[item.status] || '已记下';
    const facts = [item.date && readableDate(item.date), Number.isFinite(data.meal?.servings) && `${data.meal.servings} 人份`, Number.isFinite(data.budget?.total) && `总预算 ¥${data.budget.total.toLocaleString('zh-CN')}`].filter(Boolean);
    const needsScheduleReview = plan.stage === 'past_date';
    const next = typeof plan.nextStep === 'string' ? plan.nextStep : plan.nextStep?.label || '核对已记录的材料。';
    return `<div class="journal-work-heading"><div>${heading}<p class="journal-work-facts"><span class="journal-work-stage">${esc(stage)}</span>${facts.map(fact => `<span>${esc(fact)}</span>`).join('')}</p></div><div class="journal-work-heading-actions">${toggle}</div></div>${needsScheduleReview ? `<div class="journal-work-next"><p>${esc(next)}</p><button class="text" data-j-action="edit" data-edit-field="date" data-item="${esc(item.id)}">核对安排</button></div>` : ''}`;
  }
  function workReport(item) {
    const report = item.followupReport, artifacts = report?.artifacts || report?.run?.report?.artifacts || [];
    if (!report) return '';
    const routineStatus = !!routineFor(item) && !!report.run?.routine;
    const answerAt = report.answerAt || report.run?.report?.updatedAt;
    const reportTime = answerAt && Number.isFinite(answerAt) ? `<time datetime="${esc(new Date(answerAt).toISOString())}">${esc(routineUI.atLabel(answerAt, routineFor(item)?.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone))}</time>` : '';
    const labels = { AGENT_TIMEOUT: '处理超时', ENDPOINT_OFFLINE: '处理助手离线', AGENT_FAILED: '处理未完成' };
    return `${!routineStatus && report.reason ? `<p class="journal-trial-error" role="status">${esc(labels[report.reason] || report.reason)}<button class="text" data-j-action="item-conversation" data-item="${esc(item.id)}">回到对话</button></p>` : !routineStatus && report.isBusy ? '<p class="note" role="status">正在处理…</p>' : ''}${report.answer ? `<section class="journal-result"><h3>回报${reportTime}</h3><div class="journal-guide-answer" data-guide-report="${esc(item.id)}"></div></section>` : ''}${artifacts.length ? `<ul class="journal-artifacts" aria-label="产物文件">${artifacts.map(a => a.url && safeUrl(a.url) ? `<li><a href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">${esc(a.label)}</a></li>` : a.path ? `<li><strong>${esc(a.label)}</strong><code>${esc(a.path)}</code><small>保存在执行电脑</small></li>` : '').join('')}</ul>` : ''}`;
  }
  const awaitingMaterial = item => item.conversationId && (routineFor(item) || !item.taskType || item.taskType === 'auto') && !item.date && !item.steps?.length && !item.candidates?.length && !Object.keys(item.taskData || {}).length;
  function workAdjustments(item, covered = []) {
    const data = item.taskData || {}, draft = workDraft(item), options = workParameters(item);
    const missingBase = !!data.meal && !(Number.isFinite(data.meal.baseServings) && data.meal.baseServings > 0);
    const fields = Object.entries(options).filter(([key, enabled]) => enabled && !covered.includes(key)).map(([key]) => {
      const value = draft.parameters[key] ?? (key === 'servings' ? data.meal.servings : data.budget.total) ?? '';
      return `<label for="work-${esc(item.id)}-${key}"><span>${key === 'servings' ? '人数' : '总预算（元）'}</span><input id="work-${esc(item.id)}-${key}" data-work-field="${key}" data-item="${esc(item.id)}" type="number" value="${esc(value)}" ${key === 'servings' ? 'min="1" max="100" step="1"' : 'min="0" step="0.01"'} ${draft.busy || draft.submission ? 'disabled' : ''}></label>`;
    }).join('');
    const feedback = `${draft.error ? `<p class="journal-trial-error" role="alert">${esc(draft.error)}</p>` : ''}${draft.notice ? `<p class="journal-trial-note" role="status">${esc(draft.notice)}</p>` : ''}${trialResult(item, draft)}`;
    return `${(fields || missingBase || (!covered.length && draft.submission)) && !done(item) ? `<details class="journal-work-trial" data-work-detail="trial" data-item="${esc(item.id)}" ${draft.open ? 'open' : ''}><summary>${missingBase && !fields ? '人数试算' : covered.length ? '其他调整条件' : '调整条件，先看看影响'}${missingBase ? '<span>基础份量人数待补</span>' : Object.keys(draft.parameters).length ? '<span>有试算草稿</span>' : ''}</summary>${missingBase ? `<p class="journal-trial-note">先核对已记录材料原本是几人份，再试算新的用量。现有数量与准备进度会保留。</p><button class="outline" data-j-action="edit" data-edit-field="baseServings" data-item="${esc(item.id)}" ${draft.busy || draft.submission ? 'disabled' : ''}>补充基础份量</button>` : ''}${fields ? `<div class="journal-trial-fields">${fields}<button class="outline" data-j-action="work-preview" data-item="${esc(item.id)}" ${draft.busy || draft.submission ? 'disabled' : ''}>${draft.busy === 'preview' ? '正在计算…' : '查看影响'}</button></div>` : ''}${covered.length ? '' : feedback}</details>` : ''}${covered.length && !done(item) ? feedback : ''}`;
  }
  function workFooter(item, widgets) {
    if (item.source?.kind === 'guide') return '';
    const automatic = item.source?.kind === 'automatic', draft = workDraft(item);
    const sources = { weixin: '微信', imessage: 'iMessage', web: '手动记录', webui: '手动记录', local: '手动记录' };
    const routine = routineFor(item);
    if (routine) {
      const ruleTexts = [routine.instruction, `${routine.title}\n${routine.instruction}`].map(value => value.trim());
      const original = item.source?.text?.trim(), note = item.note?.trim();
      const source = original && !ruleTexts.includes(original) ? original : '';
      const materialNote = note && note !== source && !ruleTexts.includes(note) ? note : '';
      const material = source || materialNote ? `<details class="journal-work-source journal-source" data-work-detail="source" data-item="${esc(item.id)}" ${draft.sourceOpen ? 'open' : ''}><summary>材料</summary>${source ? `<blockquote>${esc(source)}</blockquote>` : ''}${materialNote ? `<p class="journal-work-note">${esc(materialNote)}</p>` : ''}</details>` : '';
      return material + (done(item) ? `<button type="button" class="text" data-j-action="undo" data-item="${esc(item.id)}">重新打开手账</button>` : '');
    }
    const missing = [...new Set(widgets.flatMap(widget => widget.projection?.missing || []))];
    const material = automatic ? '' : `<details class="journal-work-source journal-source" data-work-detail="source" data-item="${esc(item.id)}" ${draft.sourceOpen ? 'open' : ''}><summary>材料${missing.length ? `<span>${missing.length} 项待补</span>` : ''}</summary><p>${esc(sources[item.source?.channel] || '生活记录')} · ${esc(readableDate(item.source?.at || item.createdAt))}</p><blockquote>${esc(item.source?.text || '未记录原始交代。')}</blockquote>${item.note ? `<p class="journal-work-note">${esc(item.note)}</p>` : ''}${missing.length ? `<ul>${missing.map(value => `<li>${esc(value)}</li>`).join('')}</ul>` : ''}</details>`;
    const layout = widgets.map(widget => controls(widget)).join('');
    return `${material}<details class="journal-item-actions"><summary>更多</summary><div class="actions"><button class="text" data-j-action="edit" data-item="${esc(item.id)}">编辑</button><button class="text" data-j-action="${done(item) ? 'undo' : 'done'}" data-item="${esc(item.id)}">${done(item) ? '重新打开' : automatic ? '归档' : '完成'}</button></div>${automatic && !done(item) ? '<p class="note">归档后不再追加内容，已有材料保留。</p>' : ''}${layout ? `<div class="journal-layout-tools">${layout}</div>` : ''}</details>`;
  }
  function readTrial(itemId) {
    const item = currentItem(itemId), draft = workDraft(item), parameters = {}, supported = workParameters(item);
    for (const input of root.querySelectorAll(`[data-work-field][data-item="${CSS.escape(itemId)}"]`)) {
      if (!supported[input.dataset.workField]) continue;
      if (!input.value.trim() || !input.checkValidity()) throw new Error('请填写有效的人数或总预算。试算条件仍保留。');
      parameters[input.dataset.workField] = Number(input.value);
      draft.parameters[input.dataset.workField] = input.value;
    }
    return parameters;
  }
  async function previewWork(itemId, supplied) {
    const item = currentItem(itemId); if (!item || done(item)) return;
    const draft = workDraft(item); if (draft.busy || draft.submission) return;
    let parameters; try {
      if (supplied) {
        const supported = workParameters(item);
        if (Object.entries(supplied).some(([key, value]) => !supported[key] || !Number.isFinite(value) || (key === 'servings' ? !Number.isInteger(value) || value < 1 || value > 100 : value < 0 || value > 100000000))) throw new Error('请填写有效的人数或总预算。');
        parameters = supplied;
        for (const [key, value] of Object.entries(supplied)) draft.parameters[key] = String(value);
      } else parameters = readTrial(itemId);
    } catch (error) { draft.error = error.message; patchBoard(); return; }
    const initiatingControl = document.activeElement;
    const generation = selectionToken, identity = scopeKey(snapshot.scope), context = { scope: { ...snapshot.scope }, revision: snapshot.revision, itemId, itemVersion: item.version, parameters };
    draft.busy = 'preview'; draft.error = ''; draft.notice = ''; draft.open = true; draft.restored = false; saveWorkState(); patchBoard();
    try {
      const preview = await request('journal/preview', context);
      if (!alive || generation !== selectionToken || scopeKey(snapshot.scope) !== identity) return;
      draft.preview = preview; draft.context = context; draft.requestId = window.PATransport.requestId();
    } catch (error) { if (alive && generation === selectionToken) draft.error = `${error.message} 条件仍保留，正式计划没有改变。`; }
    finally { if (alive && generation === selectionToken) { draft.busy = false; patchBoard(); const result = root.querySelector(`#journal-trial-result-${CSS.escape(itemId)}`); if (result) { motion.play(result, 'enter'); setStatus('试算已完成，正式计划尚未改变。'); if (document.activeElement === document.body || document.activeElement === initiatingControl || !document.activeElement?.isConnected) result.querySelector('h3')?.focus({ preventScroll: true }); } else if (draft.error && document.activeElement === document.body) root.querySelector(`[data-j-action=work-preview][data-item="${CSS.escape(itemId)}"]`)?.focus({ preventScroll: true }); } }
  }
  async function applyWork(itemId, reconcile = false) {
    const item = currentItem(itemId), draft = item && workDraft(item);
    if (!draft || pending || draft.busy) return;
    if (!reconcile && (!draft.preview?.canApply || !draft.context || draft.submission)) return;
    if (reconcile && !draft.submission) return;
    if (!reconcile && item.version !== draft.preview.baseVersion) { draft.error = '记录已更新，请保留条件重新查看影响。'; patchBoard(); return; }
    const generation = selectionToken, initiatingControl = document.activeElement;
    if (!reconcile) draft.submission = { context: { ...draft.context, parameters: { ...draft.context.parameters } }, previewHash: draft.preview.previewHash, requestId: draft.requestId };
    const submission = draft.submission;
    // Persist before sending: refresh or a lost response must retain the exact request identity.
    saveWorkState(); pending = true; draft.busy = 'apply'; draft.error = ''; setBusy(true);
    try {
      const next = await request('journal/apply-preview', { ...submission.context, previewHash: submission.previewHash, requestId: submission.requestId });
      if (!alive || generation !== selectionToken) return;
      snapshot = next; draft.parameters = {}; draft.preview = null; draft.context = null; draft.submission = null; draft.notice = next.applyReceipt?.replayed ? '已核对：这次调整已保存，没有重复修改。' : '已采用，准备进度与已买记录保留。'; draft.restored = false;
      saveWorkState(); setStatus(next.applyReceipt?.replayed ? '已核对保存结果，没有重复修改。' : '已采用这次调整。'); reconcileWidgetDrafts();
    } catch (error) {
      if (!alive || generation !== selectionToken) return;
      const definite = ['CONFLICT', 'VERSION_CONFLICT', 'PREVIEW_STALE', 'PREVIEW_MISMATCH', 'STALE_PREVIEW', 'INVALID_REQUEST', 'INVALID_PARAMETERS', 'FORBIDDEN', 'ITEM_NOT_FOUND', 'ITEM_CLOSED', 'IDEMPOTENCY_CONFLICT', 'BUDGET_EXCEEDED', 'PLAN_REVIEW_REQUIRED', 'INVALID_TASK_DATA'].includes(error.code);
      draft.error = definite ? `${error.message} 试算条件仍保留，请重新查看影响。` : `${error.message} 请核对这次保存的结果。`;
      if (definite) { draft.submission = null; draft.preview = null; draft.context = null; }
      saveWorkState(); pending = false; await reload().catch(() => {});
    } finally { if (alive && generation === selectionToken) { pending = false; draft.busy = false; setBusy(false); patchChrome(); patchBoard();
      if (document.activeElement === document.body || document.activeElement === initiatingControl || !document.activeElement?.isConnected) {
        const page = root.querySelector(`.journal-workpage[data-item="${CSS.escape(itemId)}"]`);
        const target = draft.submission ? page?.querySelector('[data-j-action=work-reconcile]') : draft.error ? page?.querySelector('[data-j-action=work-preview]') : page?.querySelector('.journal-work-heading h2');
        target?.focus({ preventScroll: true });
      }
    } }
  }
  function patchBookPart(node, html) {
    const next = node.cloneNode(false); next.innerHTML = html;
    syncNode(node, next);
  }
  function notebookMeta(item) {
    const routine = routineFor(item);
    if (routine) return routineUI.directoryLabel(routine);
    if (['conversation', 'remote'].includes(item.source?.kind)) return ''; 
    if (item.source?.kind === 'automatic') return `${item.contentSeries?.day ? item.contentSeries.day.slice(5).replace('-', '/') + ' · ' : ''}${item.taskData?.collection?.entries?.length || 0} 条`;
    if (done(item)) return statusNames[item.status] || '已收好';
    if (item.date) return readableDate(item.date);
    if (item.steps?.length) return `${item.steps.filter(step => step.done).length} / ${item.steps.length} 项已准备`;
    return item.status === 'planned' ? '' : statusNames[item.status] || '';
  }
  function patchNotebook(groups) {
    const previousItem = notebookItem;
    const firstByItem = new Map();
    for (const group of groups) if (!firstByItem.has(group.itemId)) firstByItem.set(group.itemId, group);
    for (const item of extraItems()) if (tab !== 'kept' && (!search || item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))) firstByItem.set(item.id, { id: item.id, itemId: item.id, embedded: true, conversation: true });
    const compact = !search;
    const firstGroups = indexAPI.directory([...firstByItem.values()], snapshot.items, compact);
    for (const group of firstGroups.filter(g => g.conversation)) {
      const item = currentItem(group.itemId); let page = conversationPages.get(item.id);
      if (!page) { page = document.createElement('section'); page.className = 'journal-workpage journal-message-page'; page.dataset.item = item.id; page.id = 'journal-work-' + item.id; window.PAJournalSurfaces.frame(page); conversationPages.set(item.id, page); root.querySelector('#journal-board').append(page); }
      // The first blank page already owns a live composer; keep it until the
      // first send creates its durable journal item.
      const header = page.querySelector('.journal-work-header');
      if (!header) { page.querySelector('h2').textContent = item.title; continue; }
      patchContent(header, `<div class="journal-work-heading"><h2 class="journal-chapter-title" tabindex="-1">${esc(item.title)}</h2></div>`); header.className = 'journal-work-header';
      const tabs = page.querySelector('.journal-page-tabs'), output = page.querySelector('.journal-output');
      tabs.hidden = item.source?.kind === 'remote'; output.hidden = item.source?.kind === 'remote' || chapterView(item) === 'conversation';
      if (item.source?.kind === 'conversation') {
        window.PAJournalSurfaces.renderChapterTabs(tabs, { value: chapterView(item), itemId: item.id, onChange: view => switchChapter(item, view) });
        output.id = `chapter-${item.id}-output`; output.setAttribute('aria-labelledby', `chapter-tab-${item.id}-output`);
        const report = page.querySelector('.journal-work-report');
        patchContent(report, workReport(item) || '<p class="note">还没有产物</p>'); report.className = 'journal-work-report';
        const answer = report.querySelector('[data-guide-report]'); if (answer) window.PAJournalSurfaces.renderReport(answer, item.followupReport.answer);
      }
    }
    const wanted = new Set(firstGroups.map(g => g.itemId));
    for (const [id, page] of conversationPages) if (!wanted.has(id)) { if (id === readingItem) closeConversation(); window.PAJournalSurfaces.clear(page); window.PAJournalSurfaces.unframe(page); page.remove(); conversationPages.delete(id); }
    notebookItems = firstGroups.map(group => group.itemId);
    const requested = notebookSelection[tab];
    const latest = tab === 'recent' ? firstGroups.filter(g => currentItem(g.itemId)?.source?.kind !== 'guide').sort((a, b) => {
      const at = group => { const item = currentItem(group.itemId), value = item?.updatedAt || item?.createdAt; return typeof value === 'number' ? value : Date.parse(value || '') || 0; };
      return at(b) - at(a);
    })[0]?.itemId : null;
    const representative = compact ? indexAPI.representative(notebookItems, snapshot.items, requested) : notebookItems.includes(requested) && requested;
    notebookItem = representative ? requested : latest || notebookItems[0] || null;
    if (!requested && notebookItem) { notebookSelection[tab] = notebookItem; saveWorkState(); }
    if (readingItem && readingItem !== notebookItem) closeConversation();
    const selectedItem = currentItem(notebookItem);
    if (conversationIdFor(selectedItem) && chapterView(selectedItem) === 'conversation') mountConversation(selectedItem);
    if (selectedItem && selectedItem.source?.kind !== 'remote') {
      for (const page of [...workpages.values(), ...conversationPages.values()]) if (page.dataset.item === selectedItem.id) {
        const chatting = chapterView(selectedItem) === 'conversation';
        page.dataset.reading = chatting ? 'conversation' : 'output';
        const output = page.querySelector('.journal-output'); if (output) output.hidden = chatting;
        if (conversationRoot?.closest('.journal-workpage') === page) conversationRoot.hidden = !chatting;
      }
    }
    if (selectedItem?.source?.kind === 'remote' && !remoteReader) {
      closeConversation(); readingItem = selectedItem.id; conversationRoot = document.createElement('div'); conversationPages.get(selectedItem.id).append(conversationRoot);
      remoteReader = window.PARemote.mount({ root: conversationRoot, api: request, snapshot: remoteState });
    }
    const activeIndex = notebookItems.indexOf(representative || notebookItem), number = index => String(index + 1).padStart(2, '0');
    const book = root.querySelector('.journal-book');
    book.dataset.empty = String(!notebookItem);
    for (const child of root.querySelector('#journal-board').children) {
      if (child.classList.contains('journal-empty')) { child.hidden = !!notebookItem; continue; }
      const itemId = child.dataset.item || visibleWidgets().find(widget => widget.id === child.dataset.widget)?.itemId;
      child.hidden = itemId !== notebookItem;
      if (!child.hidden) { const chapter = child.querySelector('.journal-chapter-number'); if (chapter) chapter.textContent = number(activeIndex); }
      if (!child.hidden && previousItem && previousItem !== notebookItem) motion.play(child, 'page');
    }
    const bookmark = (group, index, edge = false) => {
      const item = currentItem(group.itemId), selected = index === activeIndex, title = compact && item.contentSeries ? item.contentSeries.title : item.title;
      return `<button type="button" id="${edge ? 'edge' : 'bookmark'}-${esc(tab)}-${esc(item.id)}" class="${edge ? 'journal-edge-bookmark' : 'journal-bookmark'}" data-j-action="bookmark" data-item="${esc(item.id)}" data-tone="${index % 4}" ${selected ? 'aria-current="page"' : ''} aria-controls="${group.embedded ? 'journal-work-' : 'journal-widget-'}${esc(group.id)}" aria-label="翻到：${esc(title)}"><span class="journal-bookmark-number" aria-hidden="true">${number(index)}</span><span class="journal-bookmark-copy"><strong>${esc(title)}</strong>${!edge && notebookMeta(item) ? `<small>${esc(notebookMeta(item))}</small>` : ''}</span>${edge ? '' : '<span class="journal-bookmark-arrow" aria-hidden="true">↗</span>'}</button>`;
    };
    patchBookPart(root.querySelector('#journal-bookmarks'), firstGroups.map((group, index) => bookmark(group, index)).join('') || '<p class="journal-index-empty">这一册还没有内容。</p>');
    // A short set of physical tabs complements the complete, scrollable index.
    const start = Math.max(0, Math.min(activeIndex - 1, firstGroups.length - 4));
    patchBookPart(root.querySelector('#journal-edge-tabs'), firstGroups.slice(start, start + 4).map((group, index) => bookmark(group, start + index, true)).join(''));
    root.querySelector('.journal-guide-entry').hidden = notebookItems.some(id => currentItem(id)?.source?.kind === 'guide' && !done(currentItem(id)));
    root.querySelector('.journal-book').dataset.guide = String(currentItem(notebookItem)?.source?.kind === 'guide');
    root.querySelector('#journal-current-chapter').textContent = notebookItem ? `${number(activeIndex)} / ${number(firstGroups.length - 1)}` : '';
    const clearSearch = root.querySelector('#journal-clear-search');
    clearSearch.hidden = !search; clearSearch.textContent = search ? `清除筛选“${search}”` : '';
    const pagination = root.querySelector('#journal-pagination');
    patchBookPart(pagination, `<button type="button" data-j-action="bookmark-previous" ${activeIndex <= 0 ? 'disabled' : ''}><span aria-hidden="true">←</span> 上一篇</button><span aria-live="polite">${notebookItem ? `${number(activeIndex)} / ${number(firstGroups.length - 1)}` : '还没有记录'}</span><button type="button" data-j-action="bookmark-next" ${activeIndex < 0 || activeIndex >= firstGroups.length - 1 ? 'disabled' : ''}>下一篇 <span aria-hidden="true">→</span></button>`);
  }
  function selectNotebookItem(itemId) {
    if (window.PAChat.isBusy() || remoteReader?.isBusy()) { setStatus('正在提交，请稍候再翻页。'); return; }
    if (!indexAPI.representative(notebookItems, snapshot.items, itemId)) return;
    if (itemId === notebookItem && root.querySelector('.journal-book').dataset.indexOpen !== 'true') return;
    notebookSelection[tab] = itemId;
    workDraft(currentItem(itemId)).expanded = true;
    saveWorkState(); patchBoard();
    root.querySelector('.journal-book').dataset.indexOpen = 'false';
    root.querySelector('#journal-index-toggle').setAttribute('aria-expanded', 'false');
    const page = [...root.querySelector('#journal-board').children].find(node => !node.hidden && node.dataset.item === itemId);
    const heading = page?.querySelector('h2,h3');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    const bounds = heading?.getBoundingClientRect();
    if (bounds && (bounds.top < 0 || bounds.bottom > innerHeight)) heading.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function patchBoard() {
    if (!root || creatingConversation) return;
    const focused = document.activeElement, focusedWidget = focused.closest?.('.journal-widget')?.dataset.widget;
    const board = root.querySelector('#journal-board'), widgets = visibleWidgets();
    const keys = new Set(widgets.map(widget => widget.id)), groups = workGroups(widgets), groupKeys = new Set(groups.filter(group => group.embedded).map(group => group.id));
    board.dataset.view = tab;
    for (const [id, card] of cards) if (!keys.has(id)) { if (card.contains(document.activeElement)) root.querySelector('#journal-add').focus({ preventScroll: true }); window.PAJournalSurfaces?.clearReadings(card); card.remove(); cards.delete(id); }
    for (const [id, page] of workpages) if (!groupKeys.has(id)) { for (const card of page.querySelectorAll('.journal-widget')) board.append(card); window.PAJournalSurfaces?.clear(page); page.remove(); workpages.delete(id); }
    board.querySelector('.journal-empty')?.remove();
    if (!widgets.length && !guideOnly) {
      const empty = document.createElement('section'); empty.className = 'journal-empty';
      empty.innerHTML = `<h2>${search ? '还没有找到这件事' : tab === 'kept' ? '把值得留下的日子放在这里' : tab === 'all' ? '从一件小事开始' : '眼下，给生活留一点空白'}</h2><p>${search ? '试试其他关键词，或切换到“全部”查找。' : '记下一件挂心的事、一条想继续读的信息。小满会根据真实记录整理手账；本机录入无需先连接微信。'}</p>`;
      board.append(empty);
    }
    const seenItems = new Set();
    groups.forEach((group, groupIndex) => {
      const item = currentItem(group.widgets[0].itemId), plan = workPlan(item, group.widgets), continuation = seenItems.has(item.id);
      seenItems.add(item.id);
      let page, parent = board;
      if (group.embedded) {
        page = workpages.get(group.id);
        if (!page) { page = document.createElement('section'); window.PAJournalSurfaces.frame(page); workpages.set(group.id, page); }
        const header = page.querySelector('.journal-work-header'), footer = page.querySelector('.journal-work-footer');
        const chapter = [...seenItems].indexOf(item.id) + 1;
        patchContent(header, workHeader(item, group.widgets, plan, group.id, continuation, chapter)); header.className = 'journal-work-header';
        patchContent(footer, continuation || item.source?.kind === 'guide' && !done(item) ? '' : workFooter(item, widgets.filter(widget => widget.itemId === item.id))); footer.className = 'journal-work-footer';
        page.className = 'journal-workpage'; page.dataset.item = item.id; page.dataset.stage = plan.stage || 'preparing'; page.id = `journal-work-${group.id}`;
        page.dataset.automatic = String(item.source?.kind === 'automatic');
        page.dataset.group = group.id; page.dataset.expanded = String(workExpanded(item)); page.dataset.priority = String(workPriority(item).rank);
        const tabs = page.querySelector('.journal-page-tabs'), output = page.querySelector('.journal-output');
        const canChat = item.source?.kind !== 'guide' && snapshot.scope.account === 'local' && snapshot.scope.userId === 'owner';
        tabs.hidden = !canChat;
        if (canChat) window.PAJournalSurfaces.renderChapterTabs(tabs, { value: chapterView(item), itemId: item.id, onChange: view => switchChapter(item, view) });
        output.id = `chapter-${item.id}-output`; output.setAttribute('aria-labelledby', `work-title-${group.id}`);
        for (const slot of output.children) slot.hidden = !workExpanded(item);
        const reportSlot = page.querySelector('.journal-work-report');
        patchContent(reportSlot, workReport(item) || (awaitingMaterial(item) ? `<p class="note">${routineFor(item) && !routineFor(item).lastRun ? '等待首次检查' : '还没有产物'}</p>` : '')); reportSlot.className = 'journal-work-report';
        page.setAttribute('aria-label', item.title);
        const options = workParameters(item); page.dataset.linkedServings = String(options.servings && !done(item));
        const surface = !continuation && snapshot.layout?.surfaces?.find(value => value.itemId === item.id), surfaceNode = page.querySelector('.journal-surface');
        if (surface && window.PAJournalSurfaces) {
          if (page.surfaceProgram !== surface.program) { page.surfaceProgram = surface.program; page.surfaceFields = []; }
          window.PAJournalSurfaces.render(surfaceNode, { program: surface.program, item, scope: scopeKey(snapshot.scope), disabled: pending || done(item) || !!workDraft(item).busy || !!workDraft(item).submission, onPreview: parameters => previewWork(item.id, parameters), onControlsChange: fields => {
            if (JSON.stringify(page.surfaceFields) === JSON.stringify(fields)) return;
            page.surfaceFields = fields;
            queueMicrotask(() => { if (alive && workpages.get(group.id) === page) patchBoard(); });
          } });
        } else { window.PAJournalSurfaces?.unmount(surfaceNode); page.surfaceFields = []; page.surfaceProgram = null; }
        const adjustments = page.querySelector('.journal-work-adjustments');
        patchContent(adjustments, continuation ? '' : workAdjustments(item, page.surfaceFields || [])); adjustments.className = 'journal-work-adjustments';
        parent = page.querySelector('.journal-work-body');
        parent.id = `work-body-${group.id}`;
        const kinds = group.widgets.map(widget => widget.projection?.kind || widget.kind);
        parent.dataset.layout = !preferences().pinned.length && !preferences().order.length && kinds.includes('prep') && kinds.includes('budget') && !kinds.includes('meal') ? 'preparation' : 'flow';
      }
      group.widgets.forEach((widget, localIndex) => {
        const index = widgets.findIndex(value => value.id === widget.id); let card = cards.get(widget.id);
        if (!card) { card = document.createElement('article'); cards.set(widget.id, card); }
        const section = plan.sections?.find(value => value.widgetIds?.includes(widget.id));
        const presentation = item.source?.kind === 'guide' || item.source?.kind === 'automatic' && (widget.projection?.kind || widget.kind) === 'collection' ? 'expanded' : card.dataset.presentation === 'expanded' && (card.contains(document.activeElement) || card.contains(busyFocus)) ? 'expanded' : widget.presentation || (section?.role === 'primary' || preferences().pinned.includes(widget.id) ? 'expanded' : 'compact');
        const signature = JSON.stringify([widget, item, preferences().pinned, index, widgets.length, tab, widgetViews.get(widget.id), widgetFailures.get(widget.id), hasWidgetDraft(widgetDrafts.get(widget.id)), group.embedded, presentation, workDraft(item).panels?.[widget.id], automaticEntries(item)]);
        if (card.dataset.signature !== signature) {
          if (item.source?.kind !== 'automatic' || (widget.projection?.kind || widget.kind) !== 'collection') window.PAJournalSurfaces?.clearReadings(card);
          const content = basicContent(widget, item, group.embedded) + (group.embedded ? '' : controls(widget, index, widgets.length));
          patchContent(card, group.embedded && presentation === 'compact' ? `<details class="journal-work-panel" data-work-panel="${esc(widget.id)}" data-item="${esc(item.id)}" ${workDraft(item).panels?.[widget.id] ? 'open' : ''}><summary><span>${esc(widgetNames[widget.projection?.kind || widget.kind] || '已知材料')}</span><small>${esc(compactSummary(widget, item))}</small><span aria-hidden="true" class="journal-work-expand">＋</span></summary><div class="journal-work-panel-body">${content}</div></details>` : content);
          card.dataset.signature = signature;
          const draft = widgetDrafts.get(widget.id), identity = inlineIdentity(widget);
          for (const field of card.querySelectorAll('[data-w-field]')) if (Object.hasOwn(draft?.fields?.[identity] || {}, field.dataset.wField)) field.value = draft.fields[identity][field.dataset.wField];
        }
        card.className = 'journal-widget'; card.id = `journal-widget-${widget.id}`; card.dataset.widget = widget.id;
        card.dataset.item = item.id; card.dataset.kind = widget.projection?.kind || widget.kind; card.dataset.emphasis = section?.role === 'primary' || !group.embedded && widget.emphasis === 'primary' ? 'primary' : 'secondary';
        card.dataset.presentation = presentation;
        card.hidden = !!awaitingMaterial(item);
        const reading = card.querySelector('[data-auto-reading]');
        if (reading) window.PAJournalSurfaces.renderReading(reading, widget.projection?.data?.entries || item.taskData?.collection?.entries || [], automaticEntries(item));
        const at = parent.children[group.embedded ? localIndex : groupIndex];
        if (at !== card) { const focus = card.contains(document.activeElement) ? document.activeElement : null; parent.insertBefore(card, at || null); if (focus) focusControl(focus); }
      });
      if (page) {
        let guide = page.querySelector('.journal-guide-next');
        if (item.source?.kind === 'guide' && !continuation) {
          if (!guide) { guide = document.createElement('div'); guide.className = 'journal-guide-next'; page.querySelector('.journal-output').append(guide); }
          const previousStage = guide.dataset.stage;
          patchContent(guide, guideFooter(item));
          const nextStage = snapshot.guide?.report?.answer ? 'result' : snapshot.guide?.report?.stage || 'choice';
          if (previousStage && previousStage !== nextStage && notebookItem === item.id) motion.play(guide, 'enter');
          guide.dataset.stage = nextStage;
          guide.className = 'journal-guide-next'; guide.hidden = !workExpanded(item);
        } else guide?.remove();
        for (const reportNode of page.querySelectorAll('[data-guide-report]')) {
          const report = item.source?.kind === 'guide' ? snapshot.guide?.report : item.followupReport;
          if (report?.answer) window.PAJournalSurfaces.renderReport(reportNode, report.answer);
        }
      }
      if (page && board.children[groupIndex] !== page) { const focus = page.contains(document.activeElement) ? document.activeElement : null; board.insertBefore(page, board.children[groupIndex] || null); if (focus) focusControl(focus); }
    });
    patchNotebook(groups);
    const focusedCard = focusedWidget && cards.get(focusedWidget);
    if (focusedCard && (focused.disabled || document.activeElement === document.body)) focusControl(focused.isConnected && !focused.disabled ? focused : focusedCard.querySelector('button:not(:disabled),wa-button:not([disabled]),summary'));
    for (const card of cards.values()) {
      const table = card.querySelector('.jw-comparison-scroll'), hint = card.querySelector('.jw-scroll-hint');
      if (table && hint) hint.hidden = table.scrollWidth <= table.clientWidth + 1;
    }
    if (pending) setBusy(true);
  }
  function patchChrome() {
    if (!root) return;
    const retry = root.querySelector('#journal-guide-retry'); if (retry) retry.hidden = !guideOnly || !!snapshot.guide || pending;
    const p = preferences(), design = snapshot.design || {}, busyDesign = ['queued', 'running'].includes(design.status), node = root.querySelector('#journal-design');
    motion.set(p.motion);
    node.dataset.pending = String(busyDesign);
    node.querySelector('strong').textContent = busyDesign ? '排版中…' : design.status === 'failed' ? '排版失败' : snapshot.layout?.source === 'agent' ? '已排版' : '默认排版';
    node.querySelector('p').textContent = design.status === 'failed' ? (design.message || '当前手账与记录仍可使用。') : !snapshot.designAvailable ? snapshot.designReason || '设计服务暂不可用，按现有记录呈现。' : p.autoLayout ? '按事项阶段自动整理；你可以校对材料。' : '自动整理已暂停，记录仍会同步。';
    const button = root.querySelector('#journal-redesign'); button.disabled = pending || busyDesign || snapshot.designAvailable === false || !p.autoLayout || !(snapshot.items || []).length; button.textContent = busyDesign ? '排版中…' : '重新排版';
    root.querySelector('#journal-auto').checked = p.autoLayout; root.querySelector('#journal-motion').value = p.motion;
    const hidden = root.querySelector('#journal-hidden');
    const html = p.hidden.map(id => { const [itemId, kind] = id.split(':'); return `<button class="outline" data-j-action="restore" data-widget="${esc(id)}">恢复 ${esc(currentItem(itemId)?.title || '已移除事项')} · ${esc(widgetNames[kind] || '组件')}</button>`; }).join('');
    if (hidden.innerHTML !== html && !hidden.contains(document.activeElement)) hidden.innerHTML = html;
    const settings = root.querySelector('#journal-preferences');
    if (design.status === 'failed' && settings.dataset.designStatus !== 'failed') settings.open = true;
    settings.dataset.designStatus = design.status;
    window.PAJournalSurfaces.renderTabs(root.querySelector('.journal-tabs'), { value: tab, onChange: value => {
      if (tab === value) return;
      const previousItem = notebookItem;
      tab = value; patchChrome(); patchBoard();
      if (previousItem === notebookItem) motion.play(root.querySelector('.journal-workpage:not([hidden])'), 'page');
    } });
    root.querySelector('#journal-board').setAttribute('role', 'tabpanel');
    root.querySelector('#journal-board').setAttribute('aria-labelledby', `journal-tab-${tab}`);
    const select = root.querySelector('#journal-scope');
    if (!select.contains(document.activeElement)) {
      const options = [...new Map([{ scope: { account: 'local', userId: 'owner' }, label: '我的手账' }, ...scopes].map(option => [scopeKey(option.scope), option])).values()];
      root.querySelector('.journal-scope-row').hidden = options.length <= 1;
      const value = scopeKey(snapshot.scope), content = options.map(option => `<option value="${esc(scopeKey(option.scope))}" ${scopeKey(option.scope) === value ? 'selected' : ''}>${esc(option.label)}</option>`).join('');
      if (select.innerHTML !== content) select.innerHTML = content;
    }
  }
  function patchReminders() {
    const notice = root.querySelector('#journal-notice');
    // Task versions provide event identity. Existing reminders remain readable; only unseen transitions animate.
    const relevant = tasks.filter(task => (snapshot.scope.account === 'local' || task.account === snapshot.scope.account && task.userId === snapshot.scope.userId) && (['sending', 'submitted', 'delivery_unknown'].includes(task.status) || task.status === 'pending' && task.notifyAt <= Date.now()));
    const key = 'pa-journal-notices-v1', stored = (() => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } })(), seen = new Set(stored);
    let novel = false;
    for (const task of relevant) { const id = JSON.stringify([task.account, task.userId, task.id, task.version || '', task.status, task.notifyAt]); if (!seen.has(id)) { novel = true; seen.add(id); } }
    try { localStorage.setItem(key, JSON.stringify([...seen].slice(-300))); } catch { /* Rendering works without browser storage. */ }
    notice.hidden = !relevant.length;
    const copy = relevant.slice(0, 4).map(task => `<li>${esc(task.title)} · ${task.status === 'submitted' ? '已提交微信，等待你的反馈' : task.status === 'delivery_unknown' ? '送达未知，未自动重发' : task.status === 'sending' ? '正在提交微信' : '到达候选提醒时间，仍受提醒规则约束'}</li>`).join('');
    const list = notice.querySelector('ul'); if (list.innerHTML !== copy) list.innerHTML = copy;
    if (novel && remindersInitialized && !document.hidden) {
      motion.play(notice, 'notice');
      const announcement = root.querySelector('#journal-reminder-announcement');
      if (announcement) announcement.textContent = relevant.slice(0, 4).map(task => `${task.title}，提醒状态有更新。`).join(' ');
    }
    remindersInitialized = true;
  }
  function update(next, nextTasks = tasks, nextScopes = scopes) {
    if (!root || !next || pending || window.PAChat.isBusy()) return;
    if (snapshot && (scopeKey(next.scope) !== scopeKey(snapshot.scope) || next.revision < snapshot.revision)) return;
    snapshot = next; tasks = nextTasks; scopes = nextScopes; reconcileWidgetDrafts();
    patchChrome(); patchBoard(); patchReminders();
    if (editing && !currentItem(editing.itemId) && editing.itemId) { editing.removed = true; editor.querySelector('#journal-editor-status').textContent = '这条记录已在别处删除。草稿仍在，但不能再覆盖原记录。'; }
  }
  async function reload() {
    const identity = snapshot.scope, token = selectionToken;
    const [next] = await Promise.all([request(`journal?account=${encodeURIComponent(identity.account)}&userId=${encodeURIComponent(identity.userId)}`), loadAutomatic().catch(() => {}), loadConversations()]);
    if (alive && token === selectionToken) update(next);
  }
  async function mutate(operation, values = {}, itemId, target, observed) {
    if (pending) return;
    pending = true;
    lastMutationError = null;
    const identity = editing?.scope || observed?.scope || snapshot.scope, revision = editing?.revision ?? observed?.revision ?? snapshot.revision, itemVersion = editing?.itemVersion ?? observed?.itemVersion ?? currentItem(itemId)?.version, token = selectionToken;
    const archivedGuide = operation === 'done' && currentItem(itemId)?.source?.kind === 'guide';
    if (target) target.setAttribute('aria-busy', 'true');
    setBusy(true);
    clearTimeout(statusTimer);
    const status = editing ? editor.querySelector('#journal-editor-status') : root.querySelector('#journal-status');
    if (editing) { status.dataset.error = 'false'; status.textContent = '正在保存，请稍候。'; } else setStatus('正在保存，请稍候。');
    try {
      const next = await request('journal', { scope: identity, operation, revision, ...(itemId ? { itemId, itemVersion } : {}), values });
      if (!alive || token !== selectionToken) return true;
      pending = false; setBusy(false);
      const added = operation === 'add' ? next.items.find(item => !snapshot.items.some(previous => previous.id === item.id)) : null;
      snapshot = next;
      if (added) {
        tab = 'recent'; search = ''; root.querySelector('#journal-search').value = '';
        // A paused or full layout can omit a new item; All always exposes its record.
        if (!visibleWidgets().some(widget => widget.itemId === added.id)) tab = 'all';
        notebookSelection[tab] = added.id; workDraft(added).expanded = true; saveWorkState();
      }
      reconcileWidgetDrafts(); patchChrome(); patchBoard(); patchReminders();
      if (added) lastOpener = root.querySelector(`.journal-workpage[data-item="${CSS.escape(added.id)}"] h2`);
      if (editing) { status.textContent = '已保存。'; editing.dirty = false; editor.close(); }
      else setStatus(operation === 'done' ? '已确认结束，可在“留下来的”回看。' : operation === 'delete' ? '记录已删除。' : currentItem(itemId)?.source?.kind === 'guide' ? '' : '已保存。');
      if (archivedGuide) (root.querySelector('.journal-workpage:not([hidden]) h2') || root.querySelector('h1'))?.focus();
      return true;
    } catch (error) {
      lastMutationError = error;
      if (!alive || token !== selectionToken) return false;
      const message = error.message + (['CONFLICT', 'VERSION_CONFLICT'].includes(error.code) ? ' 请核对最新记录后重新打开；这份草稿仍保留。' : '');
      if (editing) { status.dataset.error = 'true'; status.textContent = message; } else setStatus(message, true);
      if (['CONFLICT', 'VERSION_CONFLICT'].includes(error.code)) { pending = false; await reload().catch(() => {}); }
      return false;
    } finally { if (alive && token === selectionToken) { pending = false; setBusy(false); if (target?.isConnected) target.removeAttribute('aria-busy'); if (root) patchChrome(); } }
  }
  function detectedType(item) {
    const type = item?.primaryProjection?.kind || (snapshot?.layout?.widgets || []).find(w => w.itemId === item?.id && w.emphasis === 'primary')?.projection?.kind || Object.keys(item?.taskData || {})[0];
    return widgetAPI?.kinds.includes(type) ? type : item?.status === 'done' ? 'memory' : item ? 'agenda' : '';
  }
  function taskContext() { return widgetAPI.readBaseEditor(editor, { draft: true }); }
  function rememberTaskEditor() {
    const node = editor.querySelector('#journal-task-fields'), kind = node?.dataset.kind;
    if (!kind || !widgetAPI?.kinds.includes(kind)) return;
    editing.taskDrafts[kind] = widgetAPI.readTaskEditor(node, kind, editing.taskDrafts[kind] || editing.original?.taskData?.[kind] || {}, taskContext(), { draft: true });
  }
  function refreshTaskEditor() {
    const mode = editor.querySelector('#journal-task-type')?.value || 'auto';
    const kind = mode === 'auto' ? detectedType(editing.original) : mode;
    const node = editor.querySelector('#journal-task-fields');
    node.dataset.kind = kind; node.innerHTML = kind ? `<h3>${esc(widgetNames[kind])}</h3>${widgetAPI.taskEditor(kind, editing.taskDrafts[kind] || editing.original?.taskData?.[kind] || {}, taskContext())}` : '';

  }
  function editorMarkup(item) {
    const categoryChoices = Object.entries(kindNames).map(([value, label]) => `<option value="${value}" ${item?.kind === value ? 'selected' : ''}>${label}</option>`).join('');
    const taskType = item?.status === 'done' ? 'auto' : item?.taskType || 'auto', effective = taskType === 'auto' ? detectedType(item) : taskType;
    const types = item?.status === 'done' ? ['reflection', 'memory'] : widgetAPI?.kinds || [];
    return `<div class="dialog-top"><span>${item ? '编辑记录' : '新记录'}</span><button class="close journal-editor-close" data-j-action="close-editor" aria-label="关闭生活记录">×</button></div><form id="journal-item-form"><h2 id="journal-editor-title">${item ? '编辑' : '记一件事'}</h2><div class="field"><label for="journal-title">标题</label><input id="journal-title" maxlength="200" required value="${esc(item?.title)}"></div><div class="field"><label for="journal-note">内容</label><textarea id="journal-note" maxlength="10000" rows="4">${esc(item?.note)}</textarea></div><details class="journal-editor-fields"><summary>更多字段</summary><div class="two-fields"><div class="field"><label for="journal-kind">分类</label><select id="journal-kind">${categoryChoices}</select></div><div class="field"><label for="journal-date">时间</label><input id="journal-date" type="datetime-local" value="${esc(isoInput(item?.date))}"></div></div><div class="field"><label for="journal-task-type">结构</label><select id="journal-task-type"><option value="auto" ${taskType === 'auto' ? 'selected' : ''}>自动</option>${types.map(type => `<option value="${type}" ${taskType === type ? 'selected' : ''}>${esc(widgetNames[type])}</option>`).join('')}</select></div>${widgetAPI ? widgetAPI.baseEditor(item || {}) : ''}<section class="journal-task-fields" id="journal-task-fields" data-kind="${esc(effective)}" tabindex="-1">${effective && widgetAPI ? `<h3>${esc(widgetNames[effective])}</h3>${widgetAPI.taskEditor(effective, item?.taskData?.[effective] || {}, { steps: item?.steps || [], candidates: item?.candidates || [] })}` : ''}</section></details><p id="journal-editor-status" class="form-status" role="status"></p><div class="actions"><button class="primary" type="submit" id="journal-save">保存</button><button class="text" type="button" data-j-action="close-editor">取消</button>${item ? `<details class="journal-editor-more"><summary>更多</summary><div class="actions"><button class="text" type="button" data-j-action="refresh-editor">重新载入</button>${!done(item) ? `<button class="text danger" type="button" data-j-action="cancel" data-item="${esc(item.id)}">取消事项</button>` : ''}<button class="text danger" type="button" data-j-action="delete" data-item="${esc(item.id)}">删除记录</button></div></details>` : ''}</div></form>`;

  }
  function showEditor(itemId, opener) {
    const item = itemId ? currentItem(itemId) : null;
    if (itemId && !item) return;
    editing = { itemId, scope: { ...snapshot.scope }, revision: snapshot.revision, itemVersion: item?.version, dirty: false, original: item, taskDrafts: structuredClone(item?.taskData || {}) };
    lastOpener = opener; editor.innerHTML = editorMarkup(item);
    if (item?.status === 'done' || item?.status === 'cancelled') {
      for (const field of editor.querySelectorAll('input,select,textarea')) if (item.status === 'cancelled' || !['journal-note', 'journal-task-type'].includes(field.id) && !field.closest('#journal-task-fields')) field.disabled = true;
      for (const button of editor.querySelectorAll('[data-j-action=task-row-add],[data-j-action=task-row-remove]')) button.disabled = true;
      editor.querySelector('#journal-editor-title').textContent = item.status === 'done' ? '留下这件事的评价' : '回看已取消的记录';
      editor.querySelector('#journal-editor-status').textContent = item.status === 'done' ? '事项已结束，可补记感受与回忆。' : '已取消的记录保持只读，重新打开后可以继续安排。';
      if (item.status === 'cancelled') { const save = editor.querySelector('#journal-save'); save.type = 'button'; save.dataset.jAction = 'undo'; save.dataset.item = item.id; save.textContent = '重新打开这件事'; }
    }
    const target = opener?.dataset.editField;
    const targetField = target === 'date' ? editor.querySelector('#journal-date') : target === 'candidates' ? editor.querySelector('[data-t-list="candidates"] input,[data-t-list="candidates"] textarea') || editor.querySelector('[data-t-list="candidates"] [data-j-action="task-row-add"]') : target ? editor.querySelector(`[data-t-key="${CSS.escape(target)}"]`) : null;
    if (target) editor.querySelector('.journal-editor-fields').open = true;
    if (targetField) for (let parent = targetField.parentElement; parent && parent !== editor; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    editor.showModal(); motion.play(editor, 'enter'); (item?.status === 'done' ? editor.querySelector('#journal-note') : item?.status === 'cancelled' ? editor.querySelector('#journal-save') : targetField || editor.querySelector('#journal-title')).focus();
  }
  function formValues() {
    const item = editing.original, field = id => editor.querySelector(`#journal-${id}`).value;
    const invalid = (field, message) => { throw Object.assign(new Error(message), { field }); };
    if (!field('title').trim()) invalid('title', '请填写这件事的名称。');
    let base;
    try { base = widgetAPI.readBaseEditor(editor); } catch (error) { invalid('task-fields', error.message); }
    if (base.steps.length > 100 || base.steps.some(step => step.label.length > 500)) invalid('task-fields', '准备步骤最多 100 项，每项不超过 500 字。');
    if (base.candidates.length > 30) invalid('task-fields', '候选最多 30 项。');
    const type = field('task-type') || 'auto', kind = editor.querySelector('#journal-task-fields').dataset.kind;
    const taskData = { ...(item?.taskData || {}) };
    if (kind && widgetAPI.kinds.includes(kind)) {
      try { taskData[kind] = widgetAPI.readTaskEditor(editor.querySelector('#journal-task-fields'), kind, editing.taskDrafts[kind] || item?.taskData?.[kind] || {}, base); }
      catch (error) { invalid('task-fields', error.message); }
    }
    if (item?.status === 'done') {
      const allowed = Object.fromEntries(['reflection', 'memory'].filter(key => taskData[key]).map(key => [key, taskData[key]]));
      return { note: field('note'), taskData: { ...(item.taskData || {}), ...allowed } };
    }
    const at = field('date') ? new Date(field('date')) : null;
    if (at && !Number.isFinite(at.getTime())) invalid('date', '请填写有效日期，或留空。');
    return { title: field('title').trim(), kind: field('kind'), taskType: type, taskData, date: at?.toISOString() || null, note: field('note'), steps: base.steps, candidates: base.candidates };
  }
  function moveWidget(id, offset) {
    const ids = visibleWidgets().filter(widget => !widget.uiRetained).map(widget => widget.id), index = ids.indexOf(id), to = index + offset;
    if (index < 0 || to < 0 || to >= ids.length) return;
    const p = preferences(); if (p.pinned.includes(id) !== p.pinned.includes(ids[to])) return setStatus('固定组件优先显示，跨组移动请先取消固定。');
    ids.splice(index, 1); ids.splice(to, 0, id);
    void mutate('preferences', { order: ids });
  }
  function followupSuggestion(item) {
    const draft = workDraft(item), saved = draft.suggestionSubmission;
    const suggestion = snapshot.followupSuggestions?.find(value => value.sourceItemId === item.id);
    if (!suggestion && !saved) return '';
    const button = (action, text) => `<button type="button" class="${action === 'accept' ? 'outline' : 'text'}" data-j-action="suggestion-${action}" data-item="${esc(item.id)}">${text}</button>`;
    return `<aside class="journal-followup-suggestion" aria-label="持续跟进建议">${suggestion ? `<p>${esc(suggestion.reason)}</p><details><summary>${esc(routineUI.scheduleLabel(suggestion.values.schedule))}（${esc(suggestion.values.schedule.timezone)}）· 仅手账</summary><p>${esc(suggestion.values.schedule.timezone)}，${esc(suggestion.values.trigger.condition)}；结果保存在手账。</p><p>${esc((suggestion.values.scope?.sources || []).map(routineUI.sourceLabel).join('；'))}</p></details>` : '<p>正在核对上次操作。</p>'}<div class="journal-suggestion-actions">${saved ? button('reconcile', '核对操作') : button('accept', '持续跟进') + button('dismiss', '忽略')}</div>${draft.suggestionError ? `<p role="alert">${esc(draft.suggestionError)}</p>` : ''}</aside>`;
  }
  async function changeSuggestion(itemId, operation, button) {
    const item = currentItem(itemId); if (!item || pending || window.PAChat.isBusy()) return;
    const draft = workDraft(item), suggestion = snapshot.followupSuggestions?.find(value => value.sourceItemId === itemId), generation = selectionToken;
    const submission = draft.suggestionSubmission || (suggestion && { operation, id: suggestion.id, version: suggestion.version, requestId: routineUI.requestId() });
    if (!submission || !['accept', 'dismiss'].includes(submission.operation)) return;
    draft.suggestionSubmission = submission; draft.suggestionError = ''; saveWorkState(); pending = true; setBusy(true);
    try {
      const result = await request('followup-suggestions', submission);
      draft.suggestionSubmission = null; saveWorkState();
      if (!alive || generation !== selectionToken) return;
      await reload();
      pending = false; setBusy(false);
      if (result.routine?.journalItemId) await openItem(result.routine.journalItemId);
    } catch (error) {
      if (!alive || generation !== selectionToken) return;
      if (['INVALID_INPUT', 'INVALID_OPERATION', 'FORBIDDEN', 'VERSION_CONFLICT', 'CONFLICT', 'SUGGESTION_EXPIRED', 'FOLLOWUP_UNAVAILABLE', 'SOURCE_REVOKED', 'SOURCE_AUTHORITY_CHANGED', 'ITEM_NOT_FOUND'].includes(error.code)) draft.suggestionSubmission = null;
      draft.suggestionError = error.code === 'FOLLOWUP_UNAVAILABLE' ? '这条建议的来源已变化，请查看最新材料。' : routineUI.errorLabel(error.code) || error.message || '暂时无法保存，请核对操作。'; saveWorkState();
      await reload().catch(() => {});
    } finally { if (alive && generation === selectionToken) { pending = false; setBusy(false); patchBoard(); } }
  }
  async function changeRoutine(itemId, operation, button, values) {
    const item = currentItem(itemId), routine = routineFor(item);
    if (!routine || pending || window.PAChat.isBusy()) return;
    const draft = workDraft(item), generation = selectionToken;
    if (operation === 'authorize_scope' && draft.routineSettings?.baseVersion !== undefined && draft.routineSettings.baseVersion !== routine.version) { draft.routineError = '规则已变化，请重新载入后核对资料范围。'; patchBoard(); return; }
    if (operation === 'authorize_scope' && (draft.routineSettings?.sources !== undefined || draft.routineSettings?.publicWeb !== undefined)) {
      const currentScope = routine.scope || { publicWeb: true, sources: [] }, saved = draft.routineSettings;
      const selected = { publicWeb: saved.publicWeb ?? currentScope.publicWeb, sources: currentScope.sources.filter(source => !saved.sources || saved.sources.includes(routineUI.sourceKey(source))) };
      if (saved.baseVersion !== routine.version || JSON.stringify(selected) !== JSON.stringify(currentScope)) { draft.routineError = '请先核对并保存资料范围。'; patchBoard(); return; }
    }
    if (draft.routineBusy) return;
    if (draft.routineSubmission && operation !== 'reconcile') return;
    const submission = draft.routineSubmission || { operation, id: routine.id, version: routine.version, requestId: routineUI.requestId(), ...(values && { values }) };
    if (!['pause', 'resume', 'run_now', 'end', 'update', 'authorize_scope'].includes(submission.operation)) return;
    const identity = { ...snapshot.scope };
    const refresh = async () => {
      const next = await request(`journal?account=${encodeURIComponent(identity.account)}&userId=${encodeURIComponent(identity.userId)}`);
      if (alive && generation === selectionToken && scopeKey(identity) === scopeKey(snapshot.scope) && next.revision >= snapshot.revision) { snapshot = next; reconcileWidgetDrafts(); }
    };
    draft.routineSubmission = submission; draft.routineBusy = true; draft.routineError = ''; draft.routineNotice = '';
    saveWorkState(); pending = true; setBusy(true); button?.setAttribute('aria-busy', 'true');
    try {
      const receipt = await request('routines', submission);
      if (!alive || generation !== selectionToken) return;
      draft.routineSubmission = null;
      if (['update', 'end'].includes(submission.operation)) draft.routineSettings = null;
      else if (draft.routineSettings?.baseVersion === submission.version) draft.routineSettings.baseVersion = receipt.routine.version;
      draft.routineNotice = submission.operation === 'update' ? '设置已保存' : submission.operation === 'authorize_scope' ? '资料范围已确认' : ''; saveWorkState();
      await refresh().catch(() => setStatus('操作已保存，最新状态暂时读不到。请刷新页面核对。', true));
    } catch (error) {
      if (!alive || generation !== selectionToken) return;
      const definite = ['INVALID_INPUT', 'INVALID_REQUEST', 'VERSION_CONFLICT', 'CONFLICT', 'FORBIDDEN', 'ITEM_NOT_FOUND', 'ITEM_CLOSED', 'JOURNAL_CLOSED', 'ROUTINE_PAUSED', 'ROUTINE_BUSY', 'ROUTINE_RUN_ACTIVE', 'ROUTINE_ACTIVE', 'ENDPOINT_UNAVAILABLE', 'IDEMPOTENCY_CONFLICT', 'ROUTINE_ENDED', 'SOURCE_AUTHORITY_CHANGED', 'SOURCE_REVOKED', 'SOURCE_NOT_CONFIGURED', 'ROUTINE_NOTIFICATION_CHANNEL_REQUIRED', 'ROUTINE_SCOPE_REQUIRED', 'ROUTINE_SCOPE_EMPTY', 'ROUTINE_SCOPE_DENIED', 'ROUTINE_SCOPE_UNSUPPORTED', 'ROUTINE_PUBLIC_WEB_UNSUPPORTED', 'ROUTINE_EXPIRED'].includes(error.code);
      if (definite) draft.routineSubmission = null;
      draft.routineError = ['VERSION_CONFLICT', 'CONFLICT'].includes(error.code) ? '巡查规则已更新，请核对后再操作。' : routineUI.errorLabel(error.code) || error.message || '这次操作未完成。';
      saveWorkState();
      await refresh().catch(() => {});
    } finally {
      draft.routineBusy = false;
      if (alive && generation === selectionToken) {
        pending = false; setBusy(false); patchChrome(); patchBoard(); button?.removeAttribute('aria-busy');
        if (document.activeElement === document.body || document.activeElement === button || !document.activeElement?.isConnected) {
          const nextAction = draft.routineSubmission ? 'reconcile' : ({ pause: 'resume', resume: 'pause', update: 'save', authorize_scope: 'authorize_scope' })[submission.operation] || submission.operation;
          const page = root.querySelector(`.journal-workpage[data-item="${CSS.escape(itemId)}"]`);
          const control = page?.querySelector(`[data-j-action="routine-${nextAction}"]:not(:disabled)`) || page?.querySelector('.journal-routine-rules > summary') || page?.querySelector('h2');
          control?.focus({ preventScroll: true });
        }
      }
    }
  }
  async function click(event) {
    const sourceLink = event.target.closest('[data-content-open]');
    if (sourceLink) void contentFeedback(sourceLink.dataset.contentOpen, 'opened');
    const summary = event.target.closest('summary');
    if (summary && summary.closest('.journal')) {
      event.preventDefault(); motion.toggle(summary.parentElement);
      const details = summary.parentElement;
      if (details.dataset.workPanel) { const item = currentItem(details.dataset.item); if (item) { const draft = workDraft(item); draft.panels ||= {}; draft.panels[details.dataset.workPanel] = details.dataset.motionTarget ? details.dataset.motionTarget === 'open' : details.open; saveWorkState(); } }
      if (details.dataset.workDetail) { const item = currentItem(details.dataset.item); if (item) { const draft = workDraft(item); draft[details.dataset.workDetail === 'trial' ? 'open' : 'sourceOpen'] = details.dataset.motionTarget ? details.dataset.motionTarget === 'open' : details.open; saveWorkState(); } }
      return;
    }
    const button = event.target.closest('button,wa-button'); if (!button || button.disabled || !root?.contains(button) && !editor?.contains(button)) return;
    if (pending && !button.matches(browsingControls)) { event.preventDefault(); return; }
    const action = button.dataset.jAction, itemId = button.dataset.item, widgetId = button.dataset.widget, p = preferences();
    if (action === 'routine-connect') return void navigate?.({ page: 'connections' });
    if (action === 'routine-edit') return void openConversation({ conversationId: routineFor(currentItem(itemId))?.conversationId, itemId }).catch(error => setStatus(error.message, true));
    if (['routine-pause', 'routine-resume', 'routine-run_now', 'routine-reconcile', 'routine-end', 'routine-authorize_scope'].includes(action)) return void changeRoutine(itemId, action.slice('routine-'.length), button);
    if (action === 'routine-save') {
      const item = currentItem(itemId), draft = workDraft(item);
      try { return void changeRoutine(itemId, 'update', button, routineUI.settingsValues(routineFor(item), draft)); }
      catch (error) { draft.routineError = error.message; patchBoard(); return; }
    }
    if (action === 'routine-reset') { const draft = workDraft(currentItem(itemId)); draft.routineSettings = null; draft.routineError = ''; saveWorkState(); patchBoard(); return; }
    if (action?.startsWith('suggestion-')) return void changeSuggestion(itemId, action.slice('suggestion-'.length), button);
    if (action === 'clear-search') { search = ''; root.querySelector('#journal-search').value = ''; patchBoard(); root.querySelector('#journal-index-toggle').focus(); return; }
    if (action === 'guide') return void openGuide();
    if (action === 'guide-follow') return void followGuide(itemId, button);
    if (action === 'item-conversation') return void (currentItem(itemId)?.source?.kind === 'conversation' ? switchChapter(currentItem(itemId), 'conversation') : followItem(itemId, button));
    if (action === 'guide-continue') { const item = currentItem(button.closest('[data-item]')?.dataset.item); void openConversation({ conversationId: conversationIdFor(item) || snapshot.guide?.report?.conversationId }).catch(error => setStatus(error.message, true)); return; }
    if (action === 'messages-retry') { void loadConversations(); return; }
    if (action === 'message-new') { void openConversation({ newConversation: true }).catch(error => setStatus(error.message, true)); return; }
    if (action === 'guide-result') return void (guideOnly ? navigate?.({ page: 'journal', itemId: snapshot.guide?.resultItemId }) : openItem(snapshot.guide?.resultItemId));
    if (action === 'guide-connect') return void navigate?.({ page: 'connections' });
    if (action === 'guide-compose') return void navigate?.({ page: 'onboarding', section: 'compose' });
    if (action === 'bookmark') return selectNotebookItem(itemId);
    if (action === 'bookmark-next' || action === 'bookmark-previous') return selectNotebookItem(notebookItems[notebookItems.indexOf(indexAPI.representative(notebookItems, snapshot.items, notebookItem)) + (action === 'bookmark-next' ? 1 : -1)]);
    if (action === 'notebook-index') {
      const book = root.querySelector('.journal-book'), open = book.dataset.indexClosing === 'true' || book.dataset.indexOpen !== 'true', token = ++indexToken;
      const parts = [...root.querySelectorAll('.journal-index')];
      for (const part of parts) motion.cancel(part);
      delete book.dataset.indexClosing; button.setAttribute('aria-expanded', String(open));
      if (open) {
        book.dataset.indexOpen = 'true'; parts.forEach(part => motion.play(part, 'enter'));
        const bookmark = root.querySelector('#journal-bookmarks [aria-current]'); bookmark?.focus({ preventScroll: true }); bookmark?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      } else {
        book.dataset.indexClosing = 'true';
        void Promise.all(parts.map(part => motion.exit(part, () => {}))).then(() => { if (!alive || token !== indexToken || !book.isConnected) return; book.dataset.indexOpen = 'false'; delete book.dataset.indexClosing; });
      }
      return;
    }
    if (action === 'content-feedback') return contentFeedback(button.dataset.contentId, button.dataset.reaction, button);
    if (action === 'content-settings-save') {
      const panel = root.querySelector('#journal-content-settings');
      button.disabled = true;
      try {
        const value = await request('automatic-content', {
          operation: 'configure', revision: automaticContent.revision,
          enabled: panel.querySelector('#journal-content-enabled').checked,
          discovery: panel.querySelector('#journal-content-discovery').checked,
          topics: [...new Set(panel.querySelector('#journal-content-topics').value.split('\n').map(t => t.trim()).filter(Boolean))],
          sources: [...panel.querySelectorAll('[data-content-source]:checked')].map(input => input.dataset.contentSource),
          maxDaily: Number(panel.querySelector('#journal-content-limit').value),
          readingGuidance: panel.querySelector('#journal-content-guidance').value.trim(),
        });
        if (alive) { automaticContent = value; automaticDirty = false; button.blur(); patchAutomatic(); setStatus('已保存'); }
      } catch (error) { if (alive) setStatus(error.message, true); }
      finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    if (button.dataset.jTab) return; // OpenUI Tabs owns selection and keyboard navigation.
    if (!action) return;
    if (action === 'work-toggle') {
      const item = currentItem(itemId); if (!item) return;
      const draft = workDraft(item); if (draft.busy || draft.submission) return;
      const groupId = button.closest('.journal-workpage').dataset.group;
      const page = button.closest('.journal-workpage'), body = page.querySelector('.journal-work-body');
      const opening = page.dataset.closing === 'true' || !workExpanded(item);
      motion.cancel(body); delete page.dataset.closing;
      if (!opening) {
        page.dataset.closing = 'true'; button.setAttribute('aria-expanded', 'false');
        void motion.exit(body, () => { if (!alive || !page.isConnected) return; delete page.dataset.closing; draft.expanded = false; saveWorkState(); patchBoard(); });
        return;
      }
      draft.expanded = true; saveWorkState(); patchBoard(); motion.play(body, 'enter');
      const control = root.querySelector(`#${CSS.escape(`journal-work-${groupId}`)} [data-j-action=work-toggle]`);
      if (control) { control.focus({ preventScroll: true }); if (!draft.expanded) control.closest('.journal-workpage').scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (action === 'work-preview') return previewWork(itemId);
    if (action === 'work-apply') return applyWork(itemId);
    if (action === 'work-reconcile') return applyWork(itemId, true);
    if (action === 'work-reset') { const draft = workDraft(currentItem(itemId)); if (draft.busy || draft.submission) return; draft.parameters = {}; draft.preview = null; draft.context = null; draft.error = ''; draft.notice = '已放弃试算，正式计划保持原样。'; draft.restored = false; saveWorkState(); patchBoard(); return; }
    if (action === 'widget') {
      const card = button.closest('.journal-widget'), widget = card && visibleWidgets().find(w => w.id === card.dataset.widget);
      if (!widget) return;
      try {
        const result = widgetAPI.action(widget, button, card, widgetViews.get(widget.id) || {});
        if (result.local) {
          rememberWidgetSelection(widget, result.ui, button.dataset.wAction); widgetViews.set(widget.id, result.ui); saveWorkState(); patchBoard();
          // Local navigation changes the working material, not the saved record.
          const region = card.querySelector('.jw-prep-list,.jw-route-stops,.jw-pinboard');
          if (region) motion.play(region, 'success');
          return;
        }
        return writeWidget(widget, result.values, button);
      } catch (error) { setStatus(error.message, true); return; }
    }
    if (action === 'widget-discard') {
      widgetDrafts.delete(widgetId); widgetViews.delete(widgetId); widgetFailures.delete(widgetId);
      const card = cards.get(widgetId); if (card) delete card.dataset.signature;
      patchBoard(); setStatus('已放弃这份未保存的输入，看板按最新记录呈现。'); return;
    }
    if (action === 'widget-review' || action === 'widget-retry') {
      const widget = visibleWidgets().find(w => w.id === widgetId), failure = widgetFailures.get(widgetId);
      if (!widget || !failure) return;
      if (action === 'widget-review') {
        const draft = widgetDrafts.get(widgetId);
        if (draft) { draft.revision = snapshot.revision; draft.itemVersion = currentItem(widget.itemId)?.version; draft.conflict = false; }
        widgetFailures.delete(widgetId); patchBoard(); setStatus('已读取最新记录，草稿仍保留；请核对后再保存。'); return;
      }
      const card = cards.get(widgetId), entityKeys = ['entryId', 'stepId', 'requestId', 'personId', 'slotId', 'candidateId', 'optionId'];
      const matches = node => { const payload = JSON.parse(node.dataset.wPayload || '{}'); return entityKeys.every(key => failure.values?.[key] === undefined || payload[key] === failure.values[key]); };
      const control = [...card.querySelectorAll('[data-w-action]')].find(n => n.dataset.wAction === failure.values?.action && matches(n));
      const checkbox = [...card.querySelectorAll('[data-w-checkbox]')].find(n => n.dataset.wCheckbox === failure.values?.action && matches(n));
      if (!control && !checkbox && entityKeys.some(key => failure.values?.[key] !== undefined)) { setStatus('原来的材料当前未显示，请切回对应材料再重试。', true); return; }
      try { const values = control ? widgetAPI.action(widget, control, card, widgetViews.get(widgetId) || {}).values : failure.values; if (values) return writeWidget(widget, values, button, failure.observed); }
      catch (error) { setStatus(error.message, true); }
      return;
    }
    if (action === 'task-row-add') {
      const kind = button.dataset.tKind, key = button.dataset.tListKey, list = button.closest('[data-t-list]');
      const data = kind === 'base' ? {} : editing.taskDrafts[kind] || editing.original?.taskData?.[kind] || {};
      list.querySelector('.jt-repeat-rows').insertAdjacentHTML('beforeend', widgetAPI.rowMarkup(kind, key, {}, taskContext(), data));
      editing.dirty = true;
      const row = list.querySelector('.jt-row:last-child'); if (event.detail !== 0) motion.play(row, 'enter'); row.querySelector('input,textarea,select')?.focus(); return;
    }
    if (action === 'task-row-remove') { button.closest('.jt-row').remove(); editing.dirty = true; return; }
    if (action === 'task-refresh') { rememberTaskEditor(); refreshTaskEditor(); editing.dirty = true; return; }
    if (action === 'add' || action === 'edit') return showEditor(itemId, button);
    if (action === 'close-editor') { if (!editing?.dirty || confirm('放弃尚未保存的生活记录并返回？')) void motion.exit(editor, () => editor?.open && editor.close()); return; }
    if (action === 'refresh-editor') {
      await reload().catch(error => { editor.querySelector('#journal-editor-status').textContent = error.message; });
      if (editing && currentItem(editing.itemId)) { editing.revision = snapshot.revision; editing.itemVersion = currentItem(editing.itemId).version; editing.original = currentItem(editing.itemId); editor.querySelector('#journal-editor-status').textContent = `已读取最新版本 ${editing.itemVersion}。你的草稿还在，保存会用草稿替换已知字段，请核对后再保存。`; }
      return;
    }
    if (action === 'delete' && !confirm(`删除“${currentItem(itemId)?.title}”及其关联展示？来源记录也会移除，此操作无法在看板撤销。`)) return;
    if (action === 'cancel' && !confirm(`取消“${currentItem(itemId)?.title}”？已保存的来源会保留。`)) return;
    if (['done', 'cancel', 'undo', 'delete'].includes(action)) return mutate(action, {}, itemId, button);
    if (action === 'choose') return mutate('choose', { candidateId: button.dataset.candidate }, itemId, button);
    if (action === 'pin') return mutate('preferences', { pinned: p.pinned.includes(widgetId) ? p.pinned.filter(id => id !== widgetId) : [...p.pinned, widgetId] }, null, button);
    if (action === 'hide') return mutate('preferences', { hidden: [...new Set([...p.hidden, widgetId])] }, null, button);
    if (action === 'restore') return mutate('preferences', { hidden: p.hidden.filter(id => id !== widgetId) }, null, button);
    if (action === 'up' || action === 'down') return moveWidget(widgetId, action === 'up' ? -1 : 1);
    if (action === 'design') {
      const token = selectionToken, identity = scopeKey(snapshot.scope);
      button.disabled = true; setStatus('排版中…');
      try { const next = await request('journal/design', { scope: snapshot.scope, revision: snapshot.revision }); if (!alive || token !== selectionToken || scopeKey(snapshot.scope) !== identity) return; if (next.snapshot) update(next.snapshot); else if (next.items) update(next); else await reload(); if (alive && token === selectionToken) setStatus(next.accepted === false ? '未开始排版' : '已请求排版'); }
      catch (error) { if (alive && token === selectionToken) setStatus(error.message, true); }
      finally { if (alive && token === selectionToken) patchChrome(); }
    }
  }
  async function change(event) {
    if (pending) return;
    const target = event.target;
    if (target.matches('[data-j-edition]')) {
      search = ''; root.querySelector('#journal-search').value = '';
      patchChrome(); return selectNotebookItem(target.value);
    }
    if (target.id === 'journal-task-type') { rememberTaskEditor(); refreshTaskEditor(); editing.dirty = true; return; }
    if (target.matches('[data-w-field]')) { rememberInline(target); return; }
    if (target.matches('[data-w-checkbox]')) {
      const card = target.closest('.journal-widget'), widget = card && visibleWidgets().find(w => w.id === card.dataset.widget), previous = !target.checked;
      if (!widget) return;
      try { const values = { kind: target.dataset.wKind, action: target.dataset.wCheckbox, ...JSON.parse(target.dataset.wPayload || '{}'), done: target.checked }; const saved = await writeWidget(widget, values, target); if (!saved && target.isConnected) target.checked = previous; }
      catch (error) { if (target.isConnected) target.checked = previous; setStatus(error.message, true); }
      return;
    }
    if (target.matches('[data-j-step]')) { const saved = await mutate('step', { stepId: target.dataset.jStep, done: target.checked }, target.dataset.item, target); if (!saved) target.checked = !target.checked; return; }
    if (target.id === 'journal-auto') return mutate('preferences', { autoLayout: target.checked }, null, target);
    if (target.id === 'journal-motion') return mutate('preferences', { motion: target.value }, null, target);
    if (target.id === 'journal-scope') {
      const old = snapshot.scope, identity = JSON.parse(target.value);
      if (isEditing() && !confirm('切换手账会放弃尚未保存的草稿。继续？')) { target.value = scopeKey(old); return; }
      const token = ++selectionToken;
      if (editor.open) editor.close();
      target.value = scopeKey(old); pending = true; setBusy(true); setStatus('正在读取另一份手账，请稍候。');
      try { const next = await request(`journal?account=${encodeURIComponent(identity[0])}&userId=${encodeURIComponent(identity[1])}`); if (alive && token === selectionToken) { pending = false; setBusy(false); snapshot = next; window.PAJournalSurfaces?.clear(); cards.clear(); widgetViews.clear(); widgetDrafts.clear(); widgetFailures.clear(); root.querySelector('#journal-board').replaceChildren(); workpages.clear(); restoreWorkState(); patchChrome(); patchBoard(); patchReminders(); setStatus('已切换手账。'); } }
      catch (error) { if (alive && token === selectionToken) { target.value = scopeKey(old); setStatus(error.message, true); } }
      finally { if (alive && token === selectionToken) { pending = false; setBusy(false); patchChrome(); } }
    }
  }
  function mount(options) {
    if (root === options.root && root.querySelector('.journal')) return update(options.snapshot, options.tasks, options.scopes);
    unmount(); runtime = options.runtime; localAgentAvailable = options.localAgentAvailable; root = options.root; request = options.api; navigate = options.navigate; snapshot = options.snapshot; tasks = options.tasks || []; scopes = options.scopes || []; tab = 'recent'; search = ''; alive = true; selectionToken++; remindersInitialized = false; listeners = new AbortController();
    guideOnly = options.guideOnly === true;
    if (guideOnly) tab = 'all';
    const listen = (target, event, callback) => target.addEventListener(event, callback, { signal: listeners.signal });
    root.innerHTML = `<section class="journal journal-notebook${guideOnly ? ' journal-onboarding' : ''}" aria-label="${guideOnly ? '从真实材料开始' : '生活手账'}">
      <div class="journal-book" data-index-open="false">
          <div class="journal-mobile-reader"><h1 class="sr-only" tabindex="-1">手账</h1><button type="button" id="journal-index-toggle" data-j-action="notebook-index" aria-expanded="false" aria-controls="journal-index">书签目录</button><span id="journal-current-chapter"></span><button type="button" id="journal-clear-search" data-j-action="clear-search" hidden></button><button type="button" class="text journal-mobile-add" data-j-action="message-new">＋ 写一页</button></div>
        <aside class="journal-index" id="journal-index" aria-label="手账目录">
          <div class="journal-index-sticky">
            <header class="journal-header"><div><h1 tabindex="-1">我的手账</h1><p class="journal-edition">${esc(new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(new Date()))}</p></div><button class="primary" id="journal-add" data-j-action="message-new"><span aria-hidden="true">＋</span> 写一页</button></header>
            <div class="journal-settings-body journal-scope-row"><label for="journal-scope">正在查看 <select id="journal-scope" aria-label="正在查看的手账"></select></label></div>
            <div class="journal-toolbar"><nav class="journal-tabs" aria-label="手账视图"></nav><label class="journal-search" for="journal-search"><span class="sr-only">查找手账</span><input id="journal-search" type="search" placeholder="搜索" autocomplete="off"></label></div>
            <nav class="journal-bookmarks" id="journal-bookmarks" aria-label="按书签查找任务"></nav>
            <button type="button" class="journal-guide-entry" data-j-action="guide">认识小满</button>
          </div>
        </aside>
        <div class="journal-leaves"><span class="journal-spine-ribbon" aria-hidden="true"></span>
          <aside class="journal-notice" id="journal-notice" aria-label="当前提醒" hidden><h2>待处理</h2><ul></ul></aside>
          <div id="journal-messages-error" class="pause-note" role="status" hidden><span></span><button class="text" data-j-action="messages-retry">重试</button></div><p class="journal-status" id="journal-status" role="status" aria-live="polite"></p><span class="sr-only" id="journal-reminder-announcement" role="status" aria-live="polite"></span>
          <button class="outline" id="journal-guide-retry" data-j-action="guide" hidden>重试</button><div class="journal-board" id="journal-board"></div>
          <nav class="journal-pagination" id="journal-pagination" aria-label="翻阅手账"></nav>
        </div>
        <nav class="journal-edge-tabs" id="journal-edge-tabs" aria-label="页边书签"></nav>
      </div>
      <details class="journal-settings" id="journal-preferences"><summary>手账设置</summary>
        <div class="journal-design" id="journal-design"><div class="journal-design-copy"><strong></strong><details class="journal-design-detail"><summary>详情</summary><p></p></details></div><button class="outline" id="journal-redesign" data-j-action="design">重新排版</button></div>
        <div class="journal-settings-body"><button type="button" class="text" data-j-action="add">手动记事</button><label><input id="journal-auto" type="checkbox">自动排版</label><label for="journal-motion">动效<select id="journal-motion"><option value="system">跟随系统</option><option value="reduced">减少</option><option value="off">关闭</option></select></label></div><div class="journal-hidden-list" id="journal-hidden"></div>
      </details>
    </section>`;
    editor = document.createElement('dialog'); editor.className = 'journal-editor'; editor.setAttribute('aria-labelledby', 'journal-editor-title'); document.body.append(editor);
    editor.addEventListener('invalid', event => { for (let parent = event.target.parentElement; parent && parent !== editor; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; }, { capture: true, signal: listeners.signal });
    for (const container of [root, editor]) container.addEventListener('click', event => {
      const button = event.target.closest('button,wa-button');
      // Capture before OpenUI/React action handlers as well as our delegated ones.
      if (pending && button && !button.matches(browsingControls)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { capture: true, signal: listeners.signal });
    listen(root, 'click', click); listen(root, 'change', change);
    listen(root, 'keydown', event => {
      const nav = event.target.closest('#journal-bookmarks,#journal-edge-tabs');
      if (!nav || !event.target.matches('button') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...nav.querySelectorAll('button')], index = buttons.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next]?.focus();
    });
    listen(root, 'input', event => {
      if (event.target.matches('[data-routine-field],[data-routine-source]')) {
        const item = currentItem(event.target.dataset.item); if (!item) return;
        const draft = workDraft(item); draft.routineSettings ||= { baseVersion: routineFor(item).version }; draft.routineError = '';
        if (event.target.dataset.routineSource !== undefined) draft.routineSettings.sources = [...event.target.closest('.journal-routine-sources').querySelectorAll('[data-routine-source]:checked')].map(input => input.dataset.routineSource);
        else draft.routineSettings[event.target.dataset.routineField] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        saveWorkState();
        if (event.target.dataset.routineSource !== undefined || event.target.dataset.routineField === 'publicWeb') patchBoard();
      }
      if (event.target.matches('[data-w-field]')) rememberInline(event.target);
      if (event.target.matches('[data-work-field]')) {
        const item = currentItem(event.target.dataset.item); if (!item) return;
        const draft = workDraft(item); draft.parameters[event.target.dataset.workField] = event.target.value; draft.preview = null; draft.context = null; draft.error = ''; draft.notice = ''; draft.restored = false; saveWorkState();
        // Remove a stale adoption action immediately, without replacing the focused input.
        event.target.closest('.journal-workpage')?.querySelector('.journal-trial-result')?.remove();
      }
    });
    listen(root.querySelector('#journal-search'), 'input', event => { search = event.target.value; patchBoard(); });
    listen(root, 'focusout', deferredPatch);
    listen(window, 'resize', deferredPatch);
    listen(editor, 'click', click); listen(editor, 'change', change); listen(editor, 'input', () => { if (editing) editing.dirty = true; }); listen(editor, 'change', () => { if (editing) editing.dirty = true; });
    listen(editor, 'submit', event => { event.preventDefault(); event.stopPropagation(); if (pending || editing?.removed) return; for (const field of editor.querySelectorAll('[aria-invalid]')) { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); } try { const values = formValues(); void mutate(editing.itemId ? 'update' : 'add', values, editing.itemId, event.submitter); } catch (error) { const status = editor.querySelector('#journal-editor-status'); status.dataset.error = 'true'; status.textContent = (error.field ? error.message : '请检查生活记录的内容与格式。') + ' 草稿仍然保留。'; const field = error.field && editor.querySelector(`#journal-${error.field}`); if (field) { for (let parent = field.parentElement; parent && parent !== editor; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', status.id); field.focus(); } motion.play(status, 'enter'); } });
    listen(editor, 'cancel', event => { if (pending || editing?.dirty && !confirm('放弃尚未保存的生活记录并返回？')) event.preventDefault(); });
    listen(editor, 'close', () => { editing = null; (lastOpener?.isConnected ? lastOpener : root?.querySelector('#journal-add'))?.focus({ preventScroll: true }); patchBoard(); });
    const header = root.querySelector('.journal-header');
    header.insertBefore(root.querySelector('.journal-scope-row'), root.querySelector('#journal-add'));
    restoreWorkState(); patchChrome(); patchBoard(); patchReminders();
    if (guideOnly) {
      const guide = snapshot.items.find(item => item.source?.kind === 'guide');
      if (guide && snapshot.guide) { tab = 'all'; search = ''; notebookSelection[tab] = guide.id; workDraft(guide).expanded = true; patchChrome(); patchBoard(); }
      else void openGuide();
    }
    const panel = document.createElement('details');
    panel.id = 'journal-content-settings'; panel.className = 'journal-settings'; panel.hidden = true;
    panel.innerHTML = '<summary>资料与兴趣</summary><div class="journal-settings-body"></div>';
    const tools = document.createElement('div'); tools.className = 'journal-tools';
    const design = root.querySelector('#journal-design');
    design.before(tools); tools.append(panel, design);
    listen(panel, 'input', () => { automaticDirty = true; });
    const mountedGeneration = selectionToken;
    if (!guideOnly) { void loadConversations(); void request('remote-agent').then(value => { if (alive && mountedGeneration === selectionToken) { remoteState = value; patchBoard(); } }).catch(() => {}); }
    void loadAutomatic().catch(error => { if (alive && mountedGeneration === selectionToken) setStatus('自动整理偏好暂时不可用：' + error.message, true); });
    widgetAPI?.ready.then(() => { if (alive && mountedGeneration === selectionToken && root) { for (const card of cards.values()) delete card.dataset.signature; patchBoard(); } });
    refreshTimer = setInterval(() => { if (alive && !pending && !document.hidden) void reload().catch(error => setStatus(error.message, true)); }, 4000);
  }
  function deferredPatch() { setTimeout(() => { if (root && !pending) patchBoard(); }, 0); }
  function unmount() { creatingConversation = false; if (root) closeConversation(); hub = null; remoteState = null; conversationPages.clear(); chapterViews.clear(); statusMessage = ''; automaticContent = null; automaticDirty = false; if (root) window.PAJournalSurfaces?.clear(root); listeners?.abort(); alive = false; selectionToken++; pending = false; setBusy(false); clearInterval(refreshTimer); clearTimeout(statusTimer); if (root) { root.removeEventListener('click', click); root.removeEventListener('change', change); root.removeEventListener('focusout', deferredPatch); } editor?.remove(); editor = null; editing = null; root = null; cards.clear(); workpages.clear(); workDrafts.clear(); widgetViews.clear(); widgetDrafts.clear(); widgetFailures.clear(); notebookSelection = {}; notebookItems = []; notebookItem = null; motion.stop(); }
  async function openItem(itemId, entryId) {
    if (!root || pending || isEditing()) return;
    if (itemId.startsWith('conversation-')) return openConversation({ conversationId: itemId.slice(13) });
    const targetRoot = root, token = selectionToken;
    if (!currentItem(itemId)) await reload();
    if (!alive || root !== targetRoot || token !== selectionToken || pending || isEditing()) return;
    const item = currentItem(itemId);
    if (!item) throw new Error('这件事当前不可查看，请在手账中核对最新记录。');
    workDraft(item).expanded = true;
    // A direct link selects a bookmark; it is not a search for that title.
    tab = done(item) ? 'kept' : 'recent'; search = '';
    if (!visibleWidgets().some(widget => widget.itemId === itemId)) tab = 'all';
    notebookSelection[tab] = itemId; saveWorkState();
    root.querySelector('#journal-search').value = search; patchChrome(); patchBoard();
    const itemCards = visibleWidgets().filter(value => value.itemId === itemId).map(widget => cards.get(widget.id)).filter(Boolean), card = itemCards[0];
    if (entryId) {
      const entry = itemCards.map(node => node.querySelector(`[data-reading-entry="${CSS.escape(entryId)}"]`)).find(Boolean), trigger = entry?.querySelector('button[aria-expanded]');
      // An explicit reading link must reveal its compact reference panels too.
      // Remember only these ancestors; unrelated disclosure choices stay intact.
      for (let parent = entry?.parentElement; parent && parent !== root; parent = parent.parentElement) if (parent.tagName === 'DETAILS') {
        motion.cancel(parent, true); parent.open = true;
        if (parent.dataset.workPanel) { const draft = workDraft(item); draft.panels ||= {}; draft.panels[parent.dataset.workPanel] = true; }
      }
      if (entry) saveWorkState();
      if (trigger) { if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click(); trigger.focus({ preventScroll: true }); entry.scrollIntoView({ block: 'start' }); return; }
    }
    const target = card || root.querySelector(`.journal-workpage[data-item="${CSS.escape(itemId)}"]`);
    if (target) { target.scrollIntoView({ block: 'start' }); const heading = target.querySelector('h2,h3'); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } if (card) motion.play(card, 'notice'); }
  }
  function guideFooter(item) {
    const guide = snapshot.guide, source = guide?.sources?.find(row => row.id === item.candidates?.find(candidate => candidate.selected)?.id), report = guide?.report;
    const selected = source ? `<details class="journal-guide-context journal-source"><summary>材料与来源</summary><p>${esc(source.relevance)}</p><p>${esc(source.summary)}</p><p>${esc(source.coverage)} · ${esc(readableDate(source.observedAt))}</p>${source.evidence.map(cite => `<blockquote>${esc(cite.quote)}</blockquote>${safeUrl(cite.url) ? `<a href="${esc(safeUrl(cite.url))}" target="_blank" rel="noopener noreferrer">原文 ↗</a>` : ''}`).join('')}</details>` : '';
    if (report?.answer) return `<section class="journal-guide-result" role="region" aria-label="小满的跟进回报"><h3>${report.run?.report?.outcome === 'partial' ? '部分结果' : '回报'}</h3><div class="journal-guide-answer" data-guide-report="${esc(item.id)}"></div><div class="actions"><button class="primary" data-j-action="guide-continue">继续跟进</button>${!done(item) ? `<button class="text" data-j-action="done" data-item="${esc(item.id)}">归档引导</button>` : ''}</div></section>${selected}`;
    if (report?.isBusy) return `<div class="journal-guide-working" role="status"><span class="journal-working-dot" aria-hidden="true"></span><p>${report.stage === 'uncertain' || report.stage === 'cancelling' ? '执行状态待核对，暂不重复提交。' : report.stage === 'queued' ? '等待接手…' : '分析中…'}</p></div><button class="text" data-j-action="guide-result">查看事项</button>${selected}`;
    if (!guide?.sources?.length) return `<div class="actions"><button class="primary" data-j-action="guide-connect">连接资料</button><button class="text" data-j-action="guide-compose">记一件事</button></div>`;
    const waiting = !!guide.resultItemId;
    return `${waiting ? `<p class="journal-guide-save" role="status">${report?.reason || (report?.stage === 'incomplete' ? '未取得回报，可以重试。' : '事项已保存，等待 Agent 连接。')}</p>` : ''}<div class="actions"><button class="primary" data-j-action="guide-follow" data-item="${esc(item.id)}" ${!source || done(item) ? 'disabled' : ''}>${waiting ? '重试' : '让小满跟进'}</button></div>${selected}`;
  }
  async function followGuide(itemId, target) {
    if (pending) return;
    const item = currentItem(itemId), token = selectionToken;
    pending = true; setBusy(true); target?.setAttribute('aria-busy', 'true'); setStatus('正在交给小满…');
    try {
      const next = await request('journal/guide/follow', { scope: snapshot.scope, itemId, itemVersion: item.version, revision: snapshot.revision, requestId: window.PATransport.requestId() });
      if (!alive || token !== selectionToken) return;
      snapshot = next; pending = false; setBusy(false); patchChrome(); patchBoard();
      setStatus(next.guideError ? '跟进事项已保存，Agent 暂时无法接手。连接恢复后可重试。' : '已开始跟进，可以稍后回来查看。', !!next.guideError);
    } catch (error) {
      if (!alive || token !== selectionToken) return;
      pending = false; await reload().catch(() => {});
      setStatus(error.code === 'GUIDE_SOURCE_CHANGED' ? '来源已更新或不再可用，请重新打开引导，核对材料后再继续。' : '这次提交未能确认，请核对当前进度后重试。已有选择和事项会保留。', true);
    } finally { if (alive && token === selectionToken) { pending = false; setBusy(false); target?.removeAttribute('aria-busy'); } }
  }
  async function openGuide() {
    if (!root || pending || isEditing()) return;
    const token = selectionToken;
    pending = true; setBusy(true); setStatus('正在打开认识小满…');
    try {
      const next = await request('journal/guide', { scope: snapshot.scope });
      if (!alive || token !== selectionToken) return;
      pending = false; snapshot = next;
      const item = next.items.find(value => value.source?.kind === 'guide');
      tab = done(item) ? 'kept' : 'all'; search = ''; root.querySelector('#journal-search').value = '';
      notebookSelection[tab] = item.id; workDraft(item).expanded = true; saveWorkState();
      patchChrome(); patchBoard(); setStatus('');
      if (!guideOnly) selectNotebookItem(item.id);
    } catch (error) { if (alive && token === selectionToken) setStatus('暂时没能打开引导，请重试。已有记录不会改变。', true); }
    finally { if (alive && token === selectionToken) { pending = false; setBusy(false); patchChrome(); } }
  }
  function startDraft(text = '') {
    if (!root || pending || isEditing()) return;
    showEditor(undefined, root.querySelector('#journal-add'));
    if (typeof text === 'string' && text.trim()) {
      editor.querySelector('#journal-title').value = '我的第一件生活事';
      editor.querySelector('#journal-note').value = text.trim().slice(0, 4000);
      editing.dirty = true;
    }
    editor.querySelector('#journal-title').focus();
  }
  window.addEventListener('xiaoman-surfaces-ready', () => { if (alive) patchBoard(); });
  window.PAJournal = { mount, update, unmount, openConversation, openItem, openGuide, startDraft, isEditing, isBusy: () => pending || remoteReader?.isBusy() };
})();
