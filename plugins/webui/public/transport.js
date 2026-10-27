(() => {
  'use strict';
  // Intranet HTTP is supported; randomUUID is restricted to secure contexts.
  function requestId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Reconnect reads after a local service restart. Writes always need their
  // original user action and idempotency key; a lost response is never replayed.
  function create({ fetch: request = globalThis.fetch, getCSRF = () => '', onSession = () => {}, errors = {} } = {}) {
    let recovery;
    const failure = (code, fallback) => Object.assign(new Error(errors[code] || fallback), { code });
    const read = async (path, signal) => {
      const response = await request('/api/' + path, { credentials: 'same-origin', cache: 'no-store', signal });
      return response.json();
    };
    async function recover() {
      if (recovery) return recovery;
      recovery = (async () => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
        try {
          const home = await request('/', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
          if (!home.ok) throw failure('FORBIDDEN', '页面会话暂时无法恢复，输入仍保留。');
          const fresh = await read('state', controller.signal);
          if (!fresh.ok || typeof fresh.data?.csrf !== 'string' || !fresh.data.csrf || fresh.data.csrf.length > 256) throw failure('FORBIDDEN', '页面会话暂时无法恢复，输入仍保留。');
          onSession(fresh.data);
          return fresh.data;
        } finally { clearTimeout(timer); }
      })();
      try { return await recovery; } finally { recovery = undefined; }
    }
    async function api(path, data) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), data === undefined ? 8000 : path === 'local-agents' ? 120000 : 55000);
      try {
        const response = await request('/api/' + path, { credentials: 'same-origin', signal: controller.signal, ...(data === undefined
          ? { cache: 'no-store' }
          : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA-CSRF': getCSRF() }, body: JSON.stringify(data) }) });
        let result = await response.json();
        if (!result.ok && result.error === 'FORBIDDEN' && data === undefined) {
          const fresh = await recover();
          if (path === 'state') return fresh;
          result = await read(path, controller.signal);
        }
        if (!result.ok) throw failure(result.error || 'UNAVAILABLE', '暂时无法完成，输入仍保留。');
        return result.data;
      } catch (error) {
        if (typeof error.code === 'string') throw error;
        throw failure(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_UNAVAILABLE',
          data === undefined ? '暂时连不上小满，正在重新连接。' : '尚未确认服务是否收到了这条消息，输入已保留。恢复后重试会沿用同一请求。');
      } finally { clearTimeout(timer); }
    }
    return { api };
  }
  window.PATransport = { create, requestId };
})();
