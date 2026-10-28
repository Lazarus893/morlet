(() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const channelNames = { weixin: '微信', imessage: 'iMessage', 'desktop-pet': '桌面 Mori' };
  function connectionIssues(truth) {
    const selected = (truth.agents || []).find(a => a.id === truth.selectedEndpointId), reasons = [];
    if (!selected) reasons.push('尚未连接处理助手');
    else {
      if (selected.online === false) reasons.push('处理助手离线，交代会排队保留。');
      if (selected.authentication === 'required') reasons.push('登录已失效，请在本机重新登录。');
      if (selected.authentication === 'missing') reasons.push('执行程序未安装。');
      if (selected.authorization === 'expired') reasons.push('执行授权已过期。');
      if (selected.missingTools?.length) reasons.push('处理助手缺少所需工具。');
    }
    for (const channel of truth.channels || []) {
      if (channel.configured && ['disconnected', 'offline', 'needs_attention'].includes(channel.state)) reasons.push(`${channelNames[channel.id] || channel.id}${channel.state === 'needs_attention' ? '连接需要处理。' : '连接已断开。'}`);
    }
    for (const service of truth.localServices?.items || []) {
      if (service.belongsToInstance && service.needsAttention && ['missing_path', 'not_loaded', 'idle_or_exited'].includes(service.state)) reasons.push(service.suggestion || '本地服务未运行。');
    }
    const worker = truth.personalNoticeWorker;
    if (worker?.enabled && (worker.online === false || worker.state === 'error')) reasons.push(worker.online === false ? '主动关注的本地助手已离线。' : '主动关注处理失败。');
    return [...new Set(reasons)];
  }
  function details(truth) {
    if (!truth) return '';
    const evidence = [...new Set([...(truth.agents || []).flatMap(agent => agent.reasons || []), ...(truth.attention || []).map(item => item.reason)])].filter(Boolean);
    return `<details class="truth-details" data-truth-section="debug"><summary>连接诊断</summary>${evidence.length ? `<ul>${evidence.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}<pre>${esc(JSON.stringify(truth, null, 2))}</pre></details>`;
  }
  function render(truth) {
    if (!truth) return '';
    // Readiness contains evidence gaps as well as faults. Only concrete failures
    // interrupt the current task; the complete snapshot stays in connection details.
    const reasons = connectionIssues(truth);
    if (!reasons.length) return '';
    return `<section class="panel truth-panel" aria-label="连接需要处理"><p><span>${esc(reasons[0])}</span><a href="#settings">核对连接</a></p>${reasons.length > 1 ? `<details data-truth-section="evidence"><summary>其他连接问题</summary><ul>${reasons.slice(1).map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></details>` : ''}</section>`;
  }
  function botPresence(bot) {
    const execution = bot?.execution || bot || {};
    if (bot?.active === false) return { label: '已停用', muted: true, state: 'disabled' };
    if (execution.connected === false) return { label: '待连接', muted: true, state: 'disconnected' };
    if (execution.online === false) return { label: '离线', muted: true, state: 'offline' };
    if (execution.authentication === 'required') return { label: '需重新登录', muted: false, state: 'attention' };
    if (execution.authentication === 'missing') return { label: '程序未安装', muted: false, state: 'attention' };
    if (execution.canExecute === false && execution.online === true) return { label: '连接需检查', muted: false, state: 'attention' };
    if (execution.online === true && execution.connected === true) return { label: '在线', muted: false, state: 'online' };
    return { label: '状态待确认', muted: false, state: 'unknown' };
  }
  window.PATruth = { render, details, botPresence };
})();
