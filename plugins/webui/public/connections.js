(() => {
  'use strict';
  const labels = { unlinked: '未连接', setup_required: '暂不可用', awaiting_authorization: '等待你授权', checking: '正在检查', connected: '已连接', limited: '权限不完整', expired: '授权已过期', offline: '设备离线', error: '连接异常', revoked: '已撤回' };
  const names = { google: 'Google 套件', files: '本地文件', phone: '我的手机', github: 'GitHub', x: 'X' };
  const icons = { google: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="15" y="4" width="7" height="7" rx="1"/><rect x="4" y="15" width="7" height="7" rx="1"/><rect x="15" y="15" width="7" height="7" rx="1"/>', files: '<path d="M3 7h8l2 3h10v12H3z"/><path d="M3 7V4h8l2 3h7v3"/>', phone: '<rect x="7" y="2" width="12" height="23" rx="3"/><path d="M11 5h4M12 22h2"/>', github: '<path d="M7 4v10a5 5 0 0 0 5 5h7M19 4v10"/><circle cx="7" cy="4" r="2"/><circle cx="19" cy="4" r="2"/><circle cx="19" cy="19" r="2"/>', x: '<path d="M5 4l17 19M21 4L5 23"/>' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const time = value => { const at = new Date(value); return value && Number.isFinite(+at) ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at) : '尚未检查'; };
  const failure = error => ({ REVISION_CONFLICT: '连接设置已在别处更新。输入已保留，请先载入最新设置。', CONFLICT: '连接设置已在别处更新。输入已保留，请先载入最新设置。', VERSION_CONFLICT: '连接设置已在别处更新。输入已保留，请先载入最新设置。', BRIDGE_OFFLINE: '资料来源 Mac 连接助手离线，请恢复连接后再试。', BRIDGE_REQUIRED: '请先将资料来源 Mac 的连接助手配对。', INVALID_INPUT: '请检查填写的账号与授权范围。', INVALID_REQUEST: '请检查填写的账号与授权范围。', BUSY: '上一项操作尚未完成，请稍候。' })[error.code] || error.message || '暂时无法读取连接状态，请重新检查。';
  let instance;
  function mount({ root, api }) {
    if (instance?.root === root) return instance;
    instance?.unmount();
    let snapshot, busy = false, refreshing = false, dead = false, editorId = '', editorRevision, dirty = false, conflicting = false, remote;
    let timer, pollMs = 15000, openedBy, errorText = '', disconnected = false, editorWaiting = false, editorState = '', editorFileScope = '', editorPhonePermissions = false;
    root.classList.add('connections-center');
    root.innerHTML = `<section class="c-overview" aria-label="资料来源 Mac 连接状态"><span class="c-state" id="c-bridge-state">正在读取</span></section><div class="c-monitor" id="c-monitor"><p id="c-monitor-copy" role="status"></p><button type="button" class="text" data-c-action="bridge" id="c-bridge-recover" hidden>连接 Mac</button></div><p class="c-status" id="c-status" role="status" aria-live="polite"></p><div class="c-grid" id="c-grid" aria-label="服务与设备连接"></div><details class="c-help" id="c-bridge-help"><summary>资料来源 Mac</summary><div class="c-bridge"><strong id="c-bridge-name">资料来源 Mac</strong><small id="c-bridge-seen">尚未收到状态</small><button type="button" class="outline" data-c-action="refresh" id="c-refresh">刷新状态</button></div><p id="c-bridge-instructions"></p><details class="c-events"><summary>近期记录</summary><ol id="c-events-list"><li>暂无记录</li></ol></details></details><dialog class="c-dialog" id="c-dialog" aria-labelledby="c-dialog-title"><div class="c-dialog-head"><h2 id="c-dialog-title"></h2><button type="button" class="close" data-c-action="close" aria-label="关闭连接设置">×</button></div><div id="c-dialog-body"></div><p class="c-status" id="c-dialog-status" role="status" aria-live="polite"></p></dialog>`;
    const $ = selector => root.querySelector(selector), modal = $('#c-dialog');
    $('#c-bridge-help > summary').insertAdjacentHTML('afterend', '<div id="c-local-services" hidden></div>');
    $('#c-status').insertAdjacentHTML('afterend', '<p class="c-integration-error" id="c-integration-error" role="alert" hidden></p>');
    const item = id => snapshot?.items?.find(value => value.id === id);
    const online = () => snapshot?.bridge?.paired && snapshot?.bridge?.online;
    const available = (value, operation = 'connect') => operation === 'connect' && value?.cloudAvailable === true || (value?.connectionProvider === 'nango' ? value.cloudAvailable === true : online());
    function status(text, inDialog = false) { (inDialog ? $('#c-dialog-status') : $('#c-status')).textContent = text; }
    function controls() { for (const button of root.querySelectorAll('button[data-c-action]')) button.disabled = busy || (conflicting && button.dataset.cAction === 'submit'); root.setAttribute('aria-busy', String(busy)); }
    function auth(value) {
      if (!value?.auth) return '';
      let link = '';
      try {
        const url = new URL(value.auth.verificationUrl);
        const official = { google: ['accounts.google.com'], github: ['github.com'], x: ['x.com', 'twitter.com'] };
        const pathAllowed = value.id !== 'x' || url.pathname === '/i/oauth2/authorize';
        const origin = value.connectionProvider === 'nango' && value.auth.origin ? new URL(value.auth.origin) : null;
        const cloud = origin && !origin.username && !origin.password && (origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) && url.origin === origin.origin;
        const local = !origin && value.connectionProvider !== 'nango' && url.protocol === 'https:' && !url.port && official[value.id]?.includes(url.hostname) && pathAllowed;
        if (!url.username && !url.password && (cloud || local)) link = `<a class="c-auth-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">继续 ${esc(names[value.id] || value.title)} 授权 ↗</a>`;
      } catch {}
      return `<div class="c-auth">${link || (value.auth.verificationUrl ? '<p class="c-auth-error">授权地址不可用，请重新授权。</p>' : '')}${value.auth.code ? `<p>授权码 <strong class="c-code">${esc(value.auth.code)}</strong></p>` : ''}${value.auth.expiresAt ? `<small>有效期至 ${time(value.auth.expiresAt)}</small>` : ''}</div>`;
    }
    function waitingView(value) {
      if (value.id === 'phone' && ['connected', 'limited'].includes(value.state) && value.permissions?.some(row => row.id === 'paired' && row.verified)) { editorPhonePermissions = true; phoneView(value); return; }
      const pending = ['awaiting_authorization', 'checking'].includes(value?.state);
      const body = $('#c-dialog-body'), focusAction = document.activeElement?.dataset.cAction;
      const retry = ['error', 'expired', 'setup_required'].includes(value.state) || value.id === 'phone' && ['offline', 'limited'].includes(value.state);
      const actions = pending ? `<button type="button" class="outline" data-c-action="cancel-wait" data-c-id="${esc(value.id)}">${value.id === 'phone' ? '取消连接' : '取消授权'}</button>` : retry ? `<button type="button" class="primary" data-c-action="open" data-c-id="${esc(value.id)}">${value.id === 'phone' ? '重新连接' : '重新授权'}</button>` : '<button type="button" class="primary" data-c-action="close">完成</button>';
      const commonFiles = editorFileScope ? editorFileScope === 'common-folders' : value.scopeDescription?.includes('常用目录');
      const pendingMessage = value.id === 'files' ? commonFiles ? '请在资料来源 Mac 的系统弹窗确认常用目录访问。' : '请在资料来源 Mac 的文件选择弹窗中确认访问范围。' : value.id === 'phone' && value.state === 'checking' ? '正在连接资料来源 Mac 上的手机…' : value.message || '正在打开官方授权页面…';
      const markup = `<p class="c-flow-state" role="status">${esc(pending ? pendingMessage : value.state === 'connected' ? `${names[value.id]}已连接。` : value.message || labels[value.state])}</p><div id="c-editor-auth">${pending ? auth(value) : ''}</div><div class="c-dialog-actions">${actions}</div>`;
      if (body.dataset.markup !== markup) {
        body.innerHTML = markup; body.dataset.markup = markup;
        if (editorState && editorState !== value.state) motion(body, 'change');
        if (focusAction) (body.querySelector(`[data-c-action="${focusAction}"]`) || body.querySelector('button'))?.focus({ preventScroll: true });
      }
      editorState = value.state;
      status('', true);
    }
    function phoneView(value) {
      const pending = ['awaiting_authorization', 'checking'].includes(value.state), ready = value.state === 'connected' && value.permissions?.every(row => row.verified);
      const body = $('#c-dialog-body'), focusAction = document.activeElement?.dataset.cAction;
      const message = pending ? '正在同步手机权限…' : ready ? '手机已连接。' : value.message || labels[value.state];
      const unavailable = /这类设备|尚未安装/.test(value.message || ''), needsConsent = !ready && !unavailable && /录屏授权|授权页/.test(value.message || '');
      const markup = `<p class="c-flow-state" role="status">${esc(message)}</p><ul class="c-scope-list">${(value.permissions || []).map(row => `<li>${esc(row.label)}：${row.verified ? '已验证' : row.id === 'recording' && needsConsent ? '待授权' : '尚未验证'}</li>`).join('')}</ul>${needsConsent ? '<p>在手机点击「授权录屏」→「开始」。请先关闭手机投屏。</p>' : ''}<div class="c-dialog-actions">${!pending && !ready && !unavailable ? '<button type="button" class="primary" data-c-action="phone-settings">打开手机授权页</button>' : ''}${!pending && !ready ? '<button type="button" class="outline" data-c-action="phone-check">检查权限</button>' : ''}${ready ? '<button type="button" class="primary" data-c-action="close">完成</button>' : ''}</div>`;
      if (body.dataset.markup !== markup) {
        body.innerHTML = markup; body.dataset.markup = markup;
        if (editorState && editorState !== value.state) motion(body, 'change');
        if (focusAction) (body.querySelector(`[data-c-action="${focusAction}"]`) || body.querySelector('button'))?.focus({ preventScroll: true });
      }
      editorState = value.state;
      status('', true);
    }
    function card(value) {
      const id = value.id, waiting = ['awaiting_authorization', 'checking'].includes(value.state), authorised = ['connected', 'limited', 'expired', 'offline', 'error'].includes(value.state);
      const basic = value.state === 'limited' && value.permissions?.some(permission => permission.granted && permission.verified);
      const label = basic ? id === 'files' ? '基础读取可用' : id === 'phone' ? value.permissions.some(row => row.id === 'device' && row.verified) ? '手机已连接' : '请解锁手机' : ['github', 'x'].includes(id) ? '账号已验证' : '部分权限可用' : labels[value.state];
      const message = ['unlinked', 'connected', 'revoked', 'awaiting_authorization', 'checking'].includes(value.state) ? '' : value.message;
      const needsBridge = !available(value, waiting ? 'progress' : 'connect'), canCheck = available(value, 'check');
      const primaryAction = waiting ? 'progress' : 'open';
      const primaryLabel = waiting ? value.state === 'checking' ? '查看进度' : '继续授权' : '连接';
      const primary = !needsBridge && !authorised && value.state !== 'setup_required' ? `<button type="button" class="outline" data-c-action="${primaryAction}" data-c-id="${esc(id)}" id="c-connect-${esc(id)}" aria-label="${primaryLabel} ${esc(names[id])}">${primaryLabel}</button>` : '';
      const dependents = (snapshot.routines || []).filter(r => r.connectionIds?.includes(id) && !r.endedAt);
      const usage = dependents.length ? `<div class="c-routine-usage"><p>使用这项授权的跟进</p><ul>${dependents.map(r => `<li><a href="#journal/${encodeURIComponent(r.journalItemId)}">${esc(r.title)}</a><span>${r.scopeStatus?.blocked ? '来源需要处理' : r.enabled ? '跟进中' : '已暂停'}</span></li>`).join('')}</ul><p>撤回后，这些事项将停止读取该来源。</p></div>` : '';
      const manage = authorised ? `<details class="c-permissions"><summary id="c-manage-${esc(id)}" aria-label="管理 ${esc(names[id])}">管理</summary><div class="c-management"><p>${value.connectionProvider === 'nango' ? '通过私有云端连接。' : '通过资料来源 Mac 连接。'}</p><p>${esc(value.scopeDescription || '尚未授权')}</p><ul>${(value.permissions || []).map(permission => `<li><span>${esc(permission.label)}</span><span>${permission.granted ? permission.verified ? '已验证' : '已允许 · 待验证' : basic && !permission.verified && id !== 'google' ? '尚未验证' : '未允许'}</span></li>`).join('')}</ul>${value.checkedAt ? `<p class="c-last">最近检查 ${time(value.checkedAt)}</p>` : ''}${usage}<div class="c-card-actions">${!needsBridge && !waiting ? `<button type="button" class="outline" data-c-action="open" data-c-id="${esc(id)}" id="c-connect-${esc(id)}">${id === 'files' ? '调整访问范围' : id === 'phone' ? '手机权限' : '重新授权'}</button>` : ''}${canCheck && authorised && !waiting ? `<button type="button" class="text" data-c-action="check" data-c-id="${esc(id)}" id="c-check-${esc(id)}">检查连接</button>` : ''}<button type="button" class="text danger" data-c-action="withdraw" data-c-id="${esc(id)}" id="c-withdraw-${esc(id)}">撤回授权</button></div></div></details>` : '';
      return `<article class="c-card" id="c-card-${esc(id)}" data-c-id="${esc(id)}" data-c-state="${esc(value.state)}"><div class="c-card-summary"><svg viewBox="0 0 28 28" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[id] || icons.files}</svg><div class="c-card-identity"><h3>${esc(names[id] || value.title)}</h3>${value.account ? `<p class="c-account">${esc(value.account)}</p>` : ''}</div><span class="c-state c-state-${esc(value.state)}">${esc(label || '状态待确认')}</span>${primary}</div>${message ? `<p class="c-message">${esc(message)}</p>` : ''}${manage}${!authorised ? usage : ''}</article>`;
    }
    function render(next) {
      const previous = snapshot; snapshot = next; errorText = ''; disconnected = false;
      const bridge = snapshot.bridge || {}, monitor = snapshot.monitor || {};
      $('#c-bridge-state').textContent = !bridge.paired ? 'Mac 尚未配对' : bridge.online ? 'Mac 在线' : 'Mac 离线';
      $('#c-bridge-state').className = `c-state c-state-${bridge.paired && bridge.online ? 'connected' : 'offline'}`;
      $('#c-bridge-name').textContent = bridge.name || '资料来源 Mac'; $('#c-bridge-seen').textContent = `最近在线 ${time(bridge.lastSeenAt)}`;
      const hasCloud = snapshot.items?.some(value => value.cloudAvailable === true);
      const integrationError = snapshot.integrationError;
      $('#c-integration-error').hidden = !integrationError;
      $('#c-integration-error').textContent = integrationError ? `云端连接配置异常，请修复 ${integrationError.service === 'nango' ? 'Nango' : '服务'} 配置后重启服务。${/^[A-Z_]+$/.test(integrationError.code) ? `（${integrationError.code}）` : ''}` : '';
      $('#c-monitor-copy').textContent = !bridge.paired ? hasCloud ? '本地文件和手机需连接 Mac。' : '先连接资料来源 Mac。' : !bridge.online ? hasCloud ? 'Mac 离线，本地文件和手机暂不可用。' : '恢复 Mac 连接后可继续授权。' : monitor.running ? '' : '状态同步已暂停';
      $('#c-monitor').hidden = !!bridge.paired && !!bridge.online && !!monitor.running;
      $('#c-bridge-recover').hidden = !!bridge.paired && !!bridge.online;
      const grid = $('#c-grid'), localGrid = $('#c-local-services'), focus = document.activeElement?.id;
      $('#c-bridge-help > summary').textContent = '资料来源 Mac';
      $('#c-bridge-instructions').innerHTML = bridge.paired ? '在这台 Mac 的 Morlet 项目目录运行 <code>./scripts/pa.sh bridge</code>，保持电脑联网、连接助手运行，再刷新状态。' : '请先由部署者为提供资料的 Mac 配置连接助手；配对后，本地文件和设备才可在这里授权。';
      for (const value of snapshot.items || []) {
        if (!Object.hasOwn(names, value.id)) continue;
        const target = hasCloud && !online() && !value.cloudAvailable && value.connectionProvider !== 'nango' && ['unlinked', 'revoked'].includes(value.state) ? localGrid : grid;
        const existing = $(`#c-card-${value.id}`), markup = card(value), opened = existing?.querySelector('.c-permissions')?.open;
        if (!existing || existing.dataset.markup !== markup) {
          const holder = document.createElement('div'); holder.innerHTML = markup; const replacement = holder.firstElementChild; replacement.dataset.markup = markup;
          if (opened && replacement.querySelector('.c-permissions')) replacement.querySelector('.c-permissions').open = true;
          if (existing) existing.replaceWith(replacement); else target.append(replacement);
          if (replacement.parentElement !== target) target.append(replacement);
          if (previous && previous.items?.find(old => old.id === value.id)?.state !== value.state) motion(replacement, 'change');
        } else if (existing.parentElement !== target) target.append(existing);
      }
      localGrid.hidden = !localGrid.children.length;
      if (focus && !modal.open) document.getElementById(focus)?.focus({ preventScroll: true });
      $('#c-events-list').innerHTML = (snapshot.events || []).slice(0, 8).map(event => `<li><span>${esc(names[event.connectionId] || (event.connectionId === 'bridge' ? '资料来源 Mac' : '连接'))} · ${esc(labels[event.kind] || ({ pair: '已配对', unpair: '已解除配对', connect: '开始连接', check: '发起检查', grant: '允许授权', disconnect: '撤回授权', online: '已上线' })[event.kind] || '状态更新')}</span><time>${time(event.at || event.createdAt)}</time></li>`).join('') || '<li>暂时没有状态变化。</li>';
      if (snapshot.remote?.configured && window.PARemote) {
        let holder = $('#c-remote');
        if (!holder) { holder = document.createElement('section'); holder.id = 'c-remote'; grid.after(holder); }
        if (!remote) remote = window.PARemote.mountStatus({ root: holder, api, snapshot: snapshot.remote });
        else remote.update(snapshot.remote);
      } else if (remote) { remote.unmount(); remote = undefined; $('#c-remote')?.remove(); }
      if (modal.open && editorId && item(editorId)) { if (editorPhonePermissions) phoneView(item(editorId)); else if (editorWaiting) waitingView(item(editorId)); else { const holder = $('#c-editor-auth'); if (holder) holder.innerHTML = auth(item(editorId)); } }
      controls();
      const awaiting = snapshot.items?.some(value => ['awaiting_authorization', 'checking'].includes(value.state));
      const nextPoll = awaiting || modal.open && editorPhonePermissions && item('phone')?.state !== 'connected' ? 2000 : Math.max(1000, Number(monitor.intervalMs) || 15000);
      if (nextPoll !== pollMs) { pollMs = nextPoll; clearInterval(timer); timer = setInterval(() => { if (!document.hidden) void refresh(); }, pollMs); }
    }
    function motion(element, kind) {
      if (document.documentElement.dataset.motion === 'off' || document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (window.PAMotion?.play) window.PAMotion.play(element, kind);
      else element.animate?.([{ opacity: .6, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200, easing: 'ease-out' });
    }
    let refreshPromise;
    async function refresh() {
      if (dead || busy) return;
      if (refreshing) return refreshPromise;
      refreshing = true;
      refreshPromise = (async () => {
        try { const next = await api('connections'); if (!dead) render(next); }
        catch (error) { if (!dead) { errorText = failure(error); status(errorText); disconnected = true; $('#c-monitor').hidden = false; $('#c-monitor-copy').textContent = '连接中断，请刷新状态。'; $('#c-bridge-recover').hidden = false; $('#c-bridge-state').textContent = '状态待确认'; } }
        finally { refreshing = false; }
      })();
      return refreshPromise;
    }
    function restoreFocus(id) {
      const target = document.getElementById(openedBy?.id) || $(`#c-connect-${id}`);
      target?.focus({ preventScroll: true });
      if (document.activeElement !== target) $(`#c-manage-${id}`)?.focus({ preventScroll: true });
    }
    function close() {
      if (busy || dirty && !confirm('放弃尚未提交的连接设置？')) return;
      const id = editorId; modal.close(); dirty = false; editorId = ''; conflicting = false; editorWaiting = false; editorState = ''; editorFileScope = ''; editorPhonePermissions = false; restoreFocus(id);
    }
    function open(id, withdraw = false) {
      const value = item(id); if (!value || busy) return;
      $('#c-reload-version')?.remove();
      editorId = id; editorRevision = snapshot.revision; dirty = false; conflicting = false; editorWaiting = false; editorState = ''; editorFileScope = ''; editorPhonePermissions = false; openedBy = document.activeElement; delete $('#c-dialog-body').dataset.markup;
      $('#c-dialog-title').textContent = `${withdraw ? '撤回授权 · ' : '连接'}${names[id]}`;
      let body;
      if (withdraw) body = `<p>${value.connectionProvider === 'nango' ? '停止 Morlet 访问此云端账号。' : '停止 Morlet 访问，保留本机登录。'}</p><form data-c-form="${id}" data-c-operation="disconnect"><div class="c-dialog-actions"><button type="submit" class="outline danger" data-c-action="submit">撤回授权</button><button type="button" class="outline" data-c-action="close">保留授权</button></div></form>`;
      else if (id === 'google') body = `<p>${value.cloudAvailable ? '在接下来的 Google 页面确认账号与权限。' : '授权页面将在资料来源 Mac 上打开，请到那台电脑确认。'}只读访问邮件、日历、云端文件和联系人。</p><form data-c-form="google" data-c-operation="connect">${value.cloudAvailable ? '' : `<div class="field"><label for="c-google-email">Google 账号邮箱</label><input id="c-google-email" name="email" type="email" autocomplete="email" maxlength="254" value="${esc(value.account || '')}" required></div>`}<div class="c-dialog-actions"><button type="submit" class="primary" data-c-action="submit">开始 Google 授权</button><button type="button" class="outline" data-c-action="close">取消</button></div></form>`;
      else if (id === 'files') body = `${['connected', 'limited'].includes(value.state) ? '<p>新授权将替换当前范围。</p>' : ''}<div class="c-scope-callout"><strong>只读访问</strong><ul class="c-scope-list c-directory-list"><li><span>下载目录</span><code>~/Downloads</code></li><li><span>用户目录</span><code>~</code></li><li><span>文档目录</span><code>~/Documents</code></li></ul></div><div class="c-dialog-actions c-file-actions"><form data-c-form="files" data-c-operation="grant" data-c-scope="common-folders"><button type="submit" class="primary" data-c-action="submit">授权这些目录</button></form><form data-c-form="files" data-c-operation="grant" data-c-scope="selected-files"><button type="submit" class="outline" data-c-action="submit">选择其他目录</button></form><button type="button" class="text" data-c-action="close">取消</button></div><details class="c-help" id="c-file-system-help"><summary>系统权限</summary><p>在系统设置中允许文件授权助手（Xiaoman File Access.app）。只访问已确认的范围。</p><button type="button" class="outline" data-c-action="file-settings" data-c-id="files">打开系统设置</button></details>`;
      else if (id === 'phone') body = `<p>先将手机接到资料来源 Mac。Android 需开启 USB 调试并允许这台电脑；iPhone 需启动已配置的 WebDriverAgent。检查只验证连接。</p><form data-c-form="phone" data-c-operation="connect"><div class="c-dialog-actions"><button type="submit" class="primary" data-c-action="submit">连接当前手机</button><button type="button" class="outline" data-c-action="close">取消</button></div></form>`;
      else if (id === 'github') body = `<p>${value.cloudAvailable ? '在授权页面连接 GitHub 账号，Morlet 只读取已授权内容。' : '到资料来源 Mac，在 GitHub 官方页面确认账号与权限。'}</p><form data-c-form="github" data-c-operation="connect"><div class="c-dialog-actions"><button type="submit" class="primary" data-c-action="submit">开始 GitHub 授权</button><button type="button" class="outline" data-c-action="close">取消</button></div></form>`;
      else body = `<p>${value.cloudAvailable ? '在接下来的' : '到资料来源 Mac，在'} X 官方页面确认只读访问。</p><form data-c-form="x" data-c-operation="connect"><div class="c-dialog-actions"><button type="submit" class="primary" data-c-action="submit">开始 X 授权</button><button type="button" class="outline" data-c-action="close">取消</button></div></form>`;
      $('#c-dialog-body').innerHTML = body + '<div id="c-editor-auth"></div>'; status('', true); modal.showModal(); motion(modal, 'enter'); controls();
      if (id === 'phone' && !withdraw && ['connected', 'limited'].includes(value.state)) { editorPhonePermissions = true; phoneView(value); $('#c-dialog-title').textContent = '手机权限'; }
    }
    async function mutate(operation, id, values = {}, revision = snapshot?.revision) {
      if (busy || dead || !item(id)) return;
      busy = true; controls(); status(operation === 'check' ? '正在检查连接…' : operation === 'disconnect' ? '正在撤回授权…' : operation === 'settings' ? id === 'phone' ? '正在手机打开授权页…' : '正在资料来源 Mac 打开系统设置…' : item(id)?.cloudAvailable ? '正在准备授权…' : '正在资料来源 Mac 启动授权…', modal.open);
      try {
        const next = await api('connections', { operation, id, revision, values });
        if (dead) return;
        render(next); editorRevision = next.revision; dirty = false; conflicting = false;
        const value = item(id);
        if (modal.open && id === 'phone' && editorPhonePermissions) { phoneView(value); }
        else if (modal.open && (['connect', 'grant'].includes(operation) || editorWaiting && operation !== 'settings')) {
          editorWaiting = true; waitingView(value);
        } else if (operation === 'settings' && modal.open) { status('已请求打开系统设置，请在 Mac 确认。', true); }
        else { modal.close(); editorId = ''; editorWaiting = false; status(operation === 'disconnect' || value?.state === 'connected' ? '' : value?.message || '已提交。'); restoreFocus(id); }
      } catch (error) {
        if (!dead) {
          conflicting = ['REVISION_CONFLICT', 'CONFLICT', 'VERSION_CONFLICT'].includes(error.code); status(failure(error), modal.open);
          if (conflicting && modal.open && !$('#c-reload-version')) $('#c-dialog-status').insertAdjacentHTML('afterend', '<button type="button" class="outline" data-c-action="reload-version" id="c-reload-version">载入最新设置</button>');
        }
      } finally { busy = false; if (!dead) controls(); }
    }
    const click = event => {
      const button = event.target.closest('[data-c-action]'); if (!button) return; event.stopPropagation();
      const action = button.dataset.cAction, id = button.dataset.cId;
      if (action === 'submit' || busy) return;
      if (action === 'refresh') void refresh();
      if (action === 'bridge') { $('#c-bridge-help').open = true; $('#c-bridge-help').scrollIntoView({ block: 'center', behavior: 'auto' }); $('#c-bridge-help > summary').focus(); }
      if (action === 'open') open(id);
      if (action === 'progress') { open(id); editorWaiting = true; waitingView(item(id)); }
      if (action === 'file-settings') void mutate('settings', 'files', {}, editorRevision);
      if (['phone-settings', 'phone-check'].includes(action) && editorId === 'phone') { if (!online()) status('资料来源 Mac 离线，请恢复连接。', true); else void mutate(action === 'phone-settings' ? 'settings' : 'check', 'phone', {}, editorRevision); }
      if (action === 'withdraw') open(id, true);
      if (action === 'check') void mutate('check', id);
      if (action === 'cancel-wait') void mutate('disconnect', id);
      if (action === 'close') close();
      if (action === 'reload-version') void (async () => { await refresh(); if (disconnected) return; editorRevision = snapshot.revision; conflicting = false; $('#c-reload-version')?.remove(); controls(); status('已载入最新设置，输入已保留。', true); })();
    };
    const submit = event => {
      const form = event.target.closest('[data-c-form]'); if (!form) return; event.preventDefault(); event.stopPropagation();
      if (busy || conflicting || form.dataset.cForm !== editorId || !available(item(editorId), form.dataset.cOperation) && form.dataset.cOperation !== 'disconnect') { if (!available(item(editorId), form.dataset.cOperation)) status(item(editorId)?.connectionProvider === 'nango' ? '云端连接暂不可用，请刷新后再试。' : '资料来源 Mac 连接助手离线，请恢复连接后再提交。', true); return; }
      const id = form.dataset.cForm, values = id === 'google' && form.dataset.cOperation === 'connect' && form.elements.email ? { account: form.elements.email.value.trim() } : id === 'files' && form.dataset.cOperation === 'grant' ? { scope: form.dataset.cScope } : {};
      if (id === 'files' && form.dataset.cOperation === 'grant') editorFileScope = form.dataset.cScope;
      void mutate(form.dataset.cOperation, id, values, editorRevision);
    };
    const input = event => { if (event.target.closest('[data-c-form]')) { dirty = true; event.stopPropagation(); } };
    const cancel = event => { event.preventDefault(); close(); };
    root.addEventListener('click', click); root.addEventListener('submit', submit); root.addEventListener('input', input); root.addEventListener('change', input); modal.addEventListener('cancel', cancel);
    timer = setInterval(() => { if (!document.hidden) void refresh(); }, pollMs); void refresh();
    const focusCard = async id => {
      if (!Object.hasOwn(names, id)) return;
      await refresh();
      if (dead || busy || dirty || modal.open) return;
      const card = root.querySelector('#c-card-' + id), heading = card?.querySelector('h3');
      if (card) { card.scrollIntoView({ block: 'start' }); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } }
    };
    instance = { root, refresh, focusCard, isEditing: () => dirty || modal.open || remote?.isEditing(), isBusy: () => busy || remote?.isBusy(), unmount: () => { dead = true; clearInterval(timer); remote?.unmount(); root.removeEventListener('click', click); root.removeEventListener('submit', submit); root.removeEventListener('input', input); root.removeEventListener('change', input); modal.removeEventListener('cancel', cancel); modal.close(); if (instance?.root === root) instance = undefined; } };
    return instance;
  }
  window.PAConnections = { mount, refresh: () => instance?.refresh(), focusCard: id => instance?.focusCard(id), unmount: () => instance?.unmount(), isEditing: () => instance?.isEditing() || false, isBusy: () => instance?.isBusy() || false };
})();
