// Small extension of the upstream pet input; no second chat application.
export function attachXiaomanChat({ root, input, err, url, send, clamp, x, y }: any) {
  let context: any = null, selected = '', active = false;
  const fit = () => {
    if (!root.isConnected) return;
    const rect = root.getBoundingClientRect();
    root.style.left = Math.max(clamp.x + 4, Math.min(x, clamp.x + clamp.w - rect.width - 4)) + 'px';
    root.style.top = Math.max(clamp.y + 4, Math.min(y, clamp.y + clamp.h - rect.height - 4)) + 'px';
  };
  const observer = new ResizeObserver(fit);
  observer.observe(root);
  const key = 'xiaoman-pet-draft:' + url;
  const panel = document.createElement('div');
  panel.style.cssText = 'font:inherit;padding:8px 11px;border-bottom:1px solid #e5e5e5';
  panel.textContent = '正在连接…'; root.prepend(panel); input.disabled = true;
  const payload = (text: string, extra: any = {}) => {
    if (!active) return extra;
    const fields = { text, ...(context && { replyTo: context.deliveryId }), ...(selected && { entryId: selected }), ...extra };
    const fingerprint = JSON.stringify(fields);
    let old: any;
    try { old = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { /* unavailable storage is explicit below */ }
    const requestId = old?.fingerprint === fingerprint ? old.requestId : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem(key, JSON.stringify({ fingerprint, requestId }));
    const { text: ignored, ...metadata } = fields;
    return { ...metadata, requestId };
  };
  fetch(url, { signal: AbortSignal.timeout(12000) }).then(r => r.json()).then(data => {
    if (data.ok !== true) throw new Error(data.message || '小满连接未就绪');
    if (!root.isConnected) return;
    if (!data.xiaoman) { panel.remove(); input.disabled = false; input.focus(); return; }
    active = true; context = data.context;
    root.style.font = '400 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
    root.style.letterSpacing = 'normal';
    root.style.webkitFontSmoothing = 'antialiased';
    root.lang = 'zh-CN';
    input.style.font = 'inherit';
    root.style.minWidth = Math.min(280, Math.max(1, clamp.w - 8)) + 'px';
    root.style.maxWidth = Math.max(1, clamp.w - 8) + 'px';
    root.style.maxHeight = Math.max(1, clamp.h - 8) + 'px';
    root.style.overflow = 'auto'; input.setAttribute('aria-label', '回复小满');
    panel.replaceChildren();
    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:12px;font-weight:500;line-height:1.5;margin-bottom:6px';
    heading.textContent = context ? '回复这条推送' : '和小满聊聊';
    panel.append(heading);
    const label = document.createElement('div');
    label.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:110px;overflow:auto;user-select:text';
    label.textContent = context?.text || '';
    if (context) panel.append(label);
    if (context?.entries?.length) {
      if (context.entries.length === 1) selected = context.entries[0].id;
      else {
        const select = document.createElement('select'); select.setAttribute('aria-label', '选择反馈内容');
        select.style.cssText = 'width:100%;margin-top:6px;font:inherit';
        const empty = document.createElement('option'); empty.value = ''; empty.textContent = '先选一条内容'; select.append(empty);
        for (const entry of context.entries) { const o = document.createElement('option'); o.value = entry.id; o.textContent = entry.title; select.append(o); }
        select.onchange = () => { selected = select.value; buttons.forEach(b => b.disabled = !selected); };
        panel.append(select);
      }
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:7px';
      const buttons: HTMLButtonElement[] = [];
      for (const [reaction, label] of [['useful','有用'],['less','少推'],['not_interested','不感兴趣'],['clear','撤回反馈']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.style.cssText = 'font:inherit;font-size:13px;line-height:1.5;white-space:nowrap;color:inherit;background:#f5f5f3;border:1px solid #ddd;border-radius:5px;padding:3px 7px;cursor:pointer';
        button.disabled = !selected;
        button.onclick = () => { if (!input.disabled && selected) send(label, { reaction }); };
        buttons.push(button); actions.append(button);
      }
      panel.append(actions);
    }
    input.placeholder = '回复小满…'; input.disabled = false; input.focus();
  }).catch(error => {
    if (!root.isConnected) return;
    panel.textContent = '暂时连不上小满'; err.textContent = error.message; err.style.display = 'block'; input.disabled = true;
  });
  return { payload, accepted: () => { if (active) sessionStorage.removeItem(key); }, close: () => observer.disconnect() };
}
