import { DshRemoteClient, loadDshRemoteConfig, saveDshRemoteTarget, unavailableDshRemoteStatus } from '../agent-hub/remote/index.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const operations = new Set(['devices', 'connect', 'disconnect', 'workspaces', 'openWorkspace', 'sessions', 'history', 'search', 'models', 'projections', 'skills', 'createSession', 'rename', 'fork', 'selectModel', 'updateQueue', 'prompt', 'cancel']);
const code = error => /^DSH_REMOTE_[A-Z_]{1,60}$/.test(error?.code) ? error.code : 'DSH_REMOTE_UNAVAILABLE';

/** Owner-authenticated routes only. Credentials and arbitrary endpoint paths never cross this boundary. */
export function createRemoteControl({ root, client: supplied, now = Date.now, snapshotTimeoutMs = 1500, snapshotCacheMs = 5000 }) {
  let client = supplied, configError;
  if (!client) {
    try { const config = loadDshRemoteConfig(root); if (config) client = new DshRemoteClient(config); }
    catch (error) { configError = code(error); }
  }
  const streams = new Set();
  let closed = false, switching = false, activeOperations = 0, cached, cachedAt = -Infinity, snapshotTask, snapshotController;
  const unavailable = error => ({ ...unavailableDshRemoteStatus(error), configured: Boolean(client || configError) });
  const invalidate = () => { cached = undefined; cachedAt = -Infinity; snapshotController?.abort(); snapshotController = undefined; snapshotTask = undefined; };
  async function snapshot() {
    if (!client || closed) return unavailable(configError || 'DSH_REMOTE_NOT_CONFIGURED');
    if (switching) return unavailable('DSH_REMOTE_BUSY');
    if (cached && now() - cachedAt < snapshotCacheMs) return cached;
    if (snapshotTask) return snapshotTask;
    const observed = client, controller = new AbortController(); snapshotController = controller;
    const timeout = setTimeout(() => controller.abort(), snapshotTimeoutMs);
    let onAbort;
    const task = (async () => {
      try {
        // Display reads have a short independent budget. Mutations and streams
        // still perform fresh native authorization/connection checks below.
        const value = await Promise.race([
          observed.snapshot({ signal: controller.signal }),
          new Promise(resolve => { onAbort = () => resolve(unavailable('DSH_REMOTE_UNREACHABLE')); controller.signal.addEventListener('abort', onAbort, { once: true }); }),
        ]);
        const result = object(value) ? value : unavailable('DSH_REMOTE_INVALID_RESPONSE');
        if (!closed && client === observed && snapshotController === controller) { cached = result; cachedAt = now(); }
        return result;
      } catch (error) {
        const result = unavailable(code(error));
        if (!closed && client === observed && snapshotController === controller) { cached = result; cachedAt = now(); }
        return result;
      } finally {
        clearTimeout(timeout); controller.signal.removeEventListener('abort', onAbort);
        if (snapshotController === controller) { snapshotTask = undefined; snapshotController = undefined; }
      }
    })();
    snapshotTask = task; return task;
  }
  return {
    snapshot,
    async mutate(input) {
      if (!object(input) || Object.keys(input).some(key => !['operation', 'request'].includes(key)) || input.request !== undefined && !object(input.request)) fail('INVALID_REQUEST');
      if (!client || closed) fail(configError || 'DSH_REMOTE_NOT_CONFIGURED');
      if (switching) fail('DSH_REMOTE_BUSY');
      const request = input.request || {};
      // Signals are controlled by the server, never JSON supplied by the browser.
      if (Object.hasOwn(request, 'signal')) fail('INVALID_REQUEST');
      if (!operations.has(input.operation) && !['files', 'approval'].includes(input.operation)) fail('INVALID_OPERATION');
      const connectionChange = ['connect', 'disconnect'].includes(input.operation);
      const targetChange = connectionChange || input.operation === 'openWorkspace';
      // Upstream mode and workspace selection affect the entire dedicated Client
      // Host. Do not switch it while a previously admitted native RPC still runs.
      // Closing an HTTP client would not prove that RPC had stopped remotely.
      if (targetChange && activeOperations > 0) fail('DSH_REMOTE_BUSY');
      if (targetChange) switching = true;
      activeOperations++;
      try {
        if (input.operation === 'connect' && request.targetDeviceId && !supplied) {
          if (Object.keys(request).some(key => key !== 'targetDeviceId')) fail('INVALID_REQUEST');
          const observed = client, devices = await observed.devices();
          if (closed || observed !== client) fail('DSH_REMOTE_NOT_CONNECTED');
          if (!devices.some(device => device.deviceId === request.targetDeviceId && device.online)) fail('DSH_REMOTE_TARGET_NOT_ALLOWED');
          saveDshRemoteTarget(root, request.targetDeviceId);
          for (const controller of streams) controller.abort();
          invalidate(); observed.close(); client = new DshRemoteClient(loadDshRemoteConfig(root));
        }
        if (targetChange) { for (const controller of streams) controller.abort(); invalidate(); }
        if (input.operation === 'files') return await client.files(request.operation, request.payload);
        if (input.operation === 'approval') return await client.respondApproval(request.handle, request.decision, { sessionId: request.sessionId });
        const value = await client[input.operation](request);
        if (connectionChange && !closed && object(value)) { cached = value; cachedAt = now(); }
        return value;
      } finally { activeOperations--; if (targetChange) switching = false; }
    },
    async events(res, sessionId) {
      if (!client || closed) fail(configError || 'DSH_REMOTE_NOT_CONFIGURED');
      if (switching) fail('DSH_REMOTE_BUSY');
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sessionId)) fail('INVALID_REQUEST');
      if (streams.size >= 8) fail('DSH_REMOTE_TOO_MANY_STREAMS');
      const observed = client, controller = new AbortController(); streams.add(controller);
      const close = () => controller.abort(); res.once('close', close);
      let heartbeat, abortSnapshot, started = false;
      try {
        if (res.destroyed || res.writableEnded) { controller.abort(); return; }
        const state = await Promise.race([
          observed.snapshot({ signal: controller.signal }),
          new Promise(resolve => { abortSnapshot = () => resolve(null); controller.signal.addEventListener('abort', abortSnapshot, { once: true }); }),
        ]);
        controller.signal.removeEventListener('abort', abortSnapshot);
        if (controller.signal.aborted || closed || observed !== client) return;
        if (!state.connected) fail(state.code || 'DSH_REMOTE_NOT_CONNECTED');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.flushHeaders(); started = true;
        const write = data => {
          if (controller.signal.aborted) return;
          if (res.writableLength > 1024 * 1024) { controller.abort(); return; }
          res.write(data);
        };
        const emit = value => write(`data: ${JSON.stringify(value)}\n\n`);
        heartbeat = setInterval(() => write(': heartbeat\n\n'), 15000); heartbeat.unref();
        const follow = async (source, endpoint, args) => {
          try {
            for await (const frame of observed.stream(endpoint, args, { signal: controller.signal })) {
              if (source === 'events' && frame.agentId && frame.agentId !== sessionId) continue;
              emit({ source, data: frame });
            }
          } catch (error) { if (!controller.signal.aborted) emit({ source: 'error', data: { code: code(error) } }); }
          finally { controller.abort(); }
        };
        await Promise.allSettled([follow('session', 'session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages: 20 } }), follow('events', '$events', {})]);
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { controller.abort(); controller.signal.removeEventListener('abort', abortSnapshot); clearInterval(heartbeat); res.off('close', close); streams.delete(controller); if (started && !res.destroyed && !res.writableEnded) res.end(); }
    },
    close() { closed = true; invalidate(); for (const controller of streams) controller.abort(); client?.close(); },
  };
}
