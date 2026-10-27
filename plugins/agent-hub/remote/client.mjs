import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DshRemoteError, DSH_REMOTE_UPSTREAM, privateJson, validateDshRemoteConfig } from './config.mjs';

// The installed upstream Client Host owns identity, Noise, transport and reconnect.
// This is its documented loopback client, not another remote execution protocol.
const BACKENDS = new Set(['harness', 'codex', 'cursor', 'antigravity', 'pi', 'opencode', 'claude']);
const STREAMS = new Set(['$events', 'session/follow', 'session/control', 'workspace/follow']);
const READS = new Set(['session/list', 'session/page', 'session/search', 'session/modelCatalog', 'session/projections', 'skills/list']);
const WRITES = new Set(['session/create', 'session/prompt', 'session/cancel', 'session/rename', 'session/fork', 'session/selectModel', 'session/updateQueue']);
const MAX_BYTES = 8 * 1024 * 1024;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\r\n\0]/.test(value);
const failure = (code, uncertain = false) => new DshRemoteError(code, { uncertain });

function safeCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_./-]{1,100}$/.test(value) ? value : 'DSH_REMOTE_REQUEST_FAILED';
}

function validPayload(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw failure('DSH_REMOTE_INVALID_REQUEST'); }
  if (!record(value) || !encoded || Buffer.byteLength(encoded) > 256 * 1024) throw failure('DSH_REMOTE_INVALID_REQUEST');
  return value;
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw failure('DSH_REMOTE_INVALID_RESPONSE');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) throw failure('DSH_REMOTE_RESPONSE_TOO_LARGE');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof DshRemoteError) throw error;
    throw failure('DSH_REMOTE_INVALID_RESPONSE');
  } finally { reader.releaseLock(); }
}

function capabilities(status, config) {
  const connected = Boolean(config.targetDeviceId) && status?.connected === true && status?.mode === 'remote' &&
    (status.connectedTargetDeviceId ?? status.target?.deviceId) === config.targetDeviceId;
  const features = record(status?.remoteFeatures) ? status.remoteFeatures : {};
  const control = connected && config.allowSessionControl;
  return {
    devices: status?.available === true, workspaces: connected, sessions: connected, history: connected, stream: connected,
    prompt: control, interrupt: control, approval: control,
    files: connected && features.fileViewer === true,
    backends: ['harness', ...[...BACKENDS].filter(name => name !== 'harness' && features[name] === true)],
    businessTools: false, taskExecution: false,
    unavailable: [
      ...(!config.allowSessionControl ? [{ capability: 'sessionControl', code: 'DSH_REMOTE_SESSION_CONTROL_DISABLED' }] : []),
      { capability: 'taskExecution', code: 'DSH_REMOTE_BUSINESS_TOOLS_UNAVAILABLE' },
      { capability: 'terminal', code: 'DSH_REMOTE_TERMINAL_NOT_EXPOSED' },
      { capability: 'settings', code: 'DSH_REMOTE_SETTINGS_NOT_EXPOSED' },
    ],
  };
}

export class DshRemoteClient {
  #config; #fetch; #WebSocket; #cookie; #closed = false; #streams = new Set(); #approvals = new Map(); #followEvidence = new Map(); #status;
  constructor(config, { fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket } = {}) {
    this.#config = validateDshRemoteConfig(config);
    this.#fetch = fetchImpl;
    this.#WebSocket = WebSocketImpl;
  }

  async #credentials(signal) {
    if (this.#cookie) return this.#cookie;
    let credentials;
    try { credentials = privateJson(this.#config.credentialFile, 32768); }
    catch (error) { if (error.code === 'ENOENT') throw failure('DSH_REMOTE_AUTH_REQUIRED'); throw error; }
    if (typeof credentials.cookie === 'string' && credentials.cookie.length && credentials.cookie.length < 16384 && !/[\r\n\0]/.test(credentials.cookie)) {
      this.#cookie = credentials.cookie;
      return this.#cookie;
    }
    if (typeof credentials.launchToken !== 'string' || !credentials.launchToken || credentials.launchToken.length > 4096 || /[\r\n\0]/.test(credentials.launchToken)) throw failure('DSH_REMOTE_AUTH_REQUIRED');
    let response;
    try {
      const url = new URL('/', this.#config.baseUrl);
      url.searchParams.set('token', credentials.launchToken);
      response = await this.#fetch(url, { redirect: 'manual', signal });
    } catch { throw failure('DSH_REMOTE_UNREACHABLE'); }
    if (![302, 303].includes(response.status)) { await response.body?.cancel(); throw failure('DSH_REMOTE_AUTH_REQUIRED'); }
    const location = response.headers.get('location');
    if (location && new URL(location, this.#config.baseUrl).origin !== this.#config.baseUrl) { await response.body?.cancel(); throw failure('DSH_REMOTE_AUTH_REDIRECT_REJECTED'); }
    const cookies = response.headers.getSetCookie?.() ?? [];
    this.#cookie = cookies.map(cookie => cookie.split(';', 1)[0]).filter(cookie => /^[-A-Za-z0-9_]+=.+$/.test(cookie)).join('; ');
    await response.body?.cancel();
    if (!this.#cookie) throw failure('DSH_REMOTE_AUTH_REQUIRED');
    return this.#cookie;
  }

  async #rpc(channel, method, payload, { signal, mutation = false } = {}) {
    if (this.#closed) throw failure('DSH_REMOTE_CLOSED');
    validPayload(payload);
    const abort = AbortSignal.any([AbortSignal.timeout(this.#config.timeoutMs), ...(signal ? [signal] : [])]);
    abort.throwIfAborted();
    const cookie = await this.#credentials(abort);
    const rpcId = randomUUID();
    let response;
    try {
      response = await this.#fetch(`${this.#config.baseUrl}${channel}/${method}`, {
        method: 'POST', redirect: 'manual', signal: abort,
        headers: { 'content-type': 'application/json', cookie, origin: this.#config.baseUrl },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      });
    } catch { throw failure(mutation ? 'DSH_REMOTE_OUTCOME_UNKNOWN' : 'DSH_REMOTE_UNREACHABLE', mutation); }
    if (response.status === 401 || response.status === 403) {
      this.#cookie = undefined;
      await response.body?.cancel();
      throw failure(response.status === 401 ? 'DSH_REMOTE_AUTH_REQUIRED' : 'DSH_REMOTE_FORBIDDEN');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw failure(response.status === 404 ? 'DSH_REMOTE_PLUGIN_UNAVAILABLE' : mutation ? 'DSH_REMOTE_OUTCOME_UNKNOWN' : 'DSH_REMOTE_REQUEST_FAILED', mutation && response.status !== 404);
    }
    let wire;
    try { wire = await boundedJson(response); }
    catch { throw failure(mutation ? 'DSH_REMOTE_OUTCOME_UNKNOWN' : 'DSH_REMOTE_INVALID_RESPONSE', mutation); }
    if (!record(wire) || wire.type !== 'server-response' || wire.rpcId !== rpcId || typeof wire.result?.ok !== 'boolean') throw failure(mutation ? 'DSH_REMOTE_OUTCOME_UNKNOWN' : 'DSH_REMOTE_INVALID_RESPONSE', mutation);
    if (!wire.result.ok) throw failure(safeCode(wire.result.error?.code));
    return wire.result.value;
  }

  #control(method, payload = {}, options) { return this.#rpc('/ds-harness-remote', method, payload, options); }

  async snapshot({ signal } = {}) {
    try {
      const status = await this.#control('status', {}, { signal });
      if (!record(status)) throw failure('DSH_REMOTE_INVALID_RESPONSE');
      this.#status = status;
      const caps = capabilities(status, this.#config);
      return { configured: true, connected: caps.sessions, state: caps.sessions ? 'connected' : 'disconnected',
        ...(!this.#config.targetDeviceId ? { code: 'DSH_REMOTE_HOST_NOT_SELECTED' } : {}),
        targetDeviceId: this.#config.targetDeviceId, backend: BACKENDS.has(status.backend) ? status.backend : 'harness',
        transport: ['LAN', 'P2P', 'TURN', 'Relay', 'Disconnected', 'relay', 'webrtc'].includes(status.transport) ? status.transport : 'unknown',
        upstream: DSH_REMOTE_UPSTREAM, capabilities: caps };
    } catch (error) {
      this.#status = undefined;
      return { configured: true, connected: false, state: 'unavailable', code: safeCode(error.code),
        targetDeviceId: this.#config.targetDeviceId, upstream: DSH_REMOTE_UPSTREAM, capabilities: capabilities(null, this.#config) };
    }
  }

  async #requireConnected({ signal, mutation = false } = {}) {
    const state = await this.snapshot({ signal });
    if (!state.connected) throw failure(state.code || 'DSH_REMOTE_NOT_CONNECTED');
    if (mutation && !this.#config.allowSessionControl) throw failure('DSH_REMOTE_SESSION_CONTROL_DISABLED');
    return state;
  }

  async devices({ signal } = {}) {
    const devices = await this.#control('devices', {}, { signal });
    if (!Array.isArray(devices) || devices.some(item => !record(item) || !id(item.deviceId) || typeof item.name !== 'string')) throw failure('DSH_REMOTE_INVALID_RESPONSE');
    return devices.map(item => ({ deviceId: item.deviceId, name: item.name, online: item.online === true,
      ...(typeof item.clientVersion === 'string' ? { clientVersion: item.clientVersion } : {}),
      ...(typeof item.harnessVersion === 'string' ? { harnessVersion: item.harnessVersion } : {}) }));
  }

  async connect({ targetDeviceId = this.#config.targetDeviceId, signal } = {}) {
    if (!this.#config.targetDeviceId) throw failure('DSH_REMOTE_HOST_NOT_SELECTED');
    if (targetDeviceId !== this.#config.targetDeviceId) throw failure('DSH_REMOTE_TARGET_NOT_ALLOWED');
    await this.#control('mode.set', { mode: 'remote', targetDeviceId }, { signal, mutation: true });
    const state = await this.snapshot({ signal });
    if (!state.connected) throw failure(state.code || 'DSH_REMOTE_NOT_CONNECTED');
    return state;
  }

  async disconnect({ signal } = {}) {
    for (const stream of this.#streams) stream.close();
    this.#approvals.clear();
    await this.#requireConnected({ signal });
    await this.#control('mode.set', { mode: 'local' }, { signal, mutation: true });
    return this.snapshot({ signal });
  }

  async #backend(backend, signal) {
    if (!BACKENDS.has(backend)) throw failure('DSH_REMOTE_BACKEND_UNSUPPORTED');
    const state = await this.#requireConnected({ signal });
    if (!state.capabilities.backends.includes(backend)) throw failure('DSH_REMOTE_BACKEND_UNSUPPORTED');
    return backend === 'harness' ? '' : `${backend}.`;
  }

  async workspaces({ backend = 'harness', signal } = {}) {
    const prefix = await this.#backend(backend, signal);
    return this.#control(`${prefix}workspaces.list`, { targetDeviceId: this.#config.targetDeviceId }, { signal });
  }

  async openWorkspace({ backend = 'harness', path, workspaceId, signal } = {}) {
    const prefix = await this.#backend(backend, signal);
    if (backend === 'harness' ? !id(path) : !id(workspaceId)) throw failure('DSH_REMOTE_INVALID_REQUEST');
    for (const stream of this.#streams) stream.close();
    this.#approvals.clear();
    return this.#control(`${prefix}workspace.open`, { targetDeviceId: this.#config.targetDeviceId,
      ...(backend === 'harness' ? { path } : { workspaceId }) }, { signal, mutation: true });
  }

  async #native(endpoint, args, { signal } = {}) {
    const mutation = WRITES.has(endpoint);
    if (!READS.has(endpoint) && !mutation) throw failure('DSH_REMOTE_METHOD_NOT_ALLOWED');
    await this.#requireConnected({ signal, mutation });
    return this.#rpc('/api', endpoint, { args }, { signal, mutation });
  }

  sessions(request = {}, options) { return this.#native('session/list', { _request: validPayload(request) }, options); }
  history(request, options) { return this.#native('session/page', { request: validPayload(request) }, options); }
  search(request, options) { return this.#native('session/search', { request: validPayload(request) }, options); }
  models(options) { return this.#native('session/modelCatalog', {}, options); }
  projections(request, options) { return this.#native('session/projections', { request: validPayload(request) }, options); }
  skills(request = {}, options) { return this.#native('skills/list', { request: validPayload(request) }, options); }
  createSession(request, options) { return this.#native('session/create', { request: validPayload(request) }, options); }
  rename(request, options) { return this.#native('session/rename', { request: validPayload(request) }, options); }
  fork(request, options) { return this.#native('session/fork', { request: validPayload(request) }, options); }
  selectModel(request, options) { return this.#native('session/selectModel', { request: validPayload(request) }, options); }
  updateQueue(request, options) { return this.#native('session/updateQueue', { request: validPayload(request) }, options); }

  prompt(request, options) {
    if (!id(request?.sessionId) || !id(request.requestId) || !['queue', 'steer'].includes(request.mode) || !Array.isArray(request.content) || !request.content.length) throw failure('DSH_REMOTE_INVALID_REQUEST');
    return this.#native('session/prompt', { request: validPayload(request) }, options);
  }

  cancel(request, options) {
    if (!id(request?.sessionId)) throw failure('DSH_REMOTE_INVALID_REQUEST');
    return this.#native('session/cancel', { request: { sessionId: request.sessionId } }, options);
  }

  async files(operation, payload, { signal } = {}) {
    if (!['stat', 'readRange', 'list'].includes(operation)) throw failure('DSH_REMOTE_METHOD_NOT_ALLOWED');
    const state = await this.#requireConnected({ signal });
    if (!state.capabilities.files) throw failure('DSH_REMOTE_FEATURE_UNAVAILABLE');
    return this.#control(`fileviewer.${operation}`, validPayload(payload), { signal });
  }

  async *stream(endpoint, args = {}, { signal } = {}) {
    if (!STREAMS.has(endpoint)) throw failure('DSH_REMOTE_METHOD_NOT_ALLOWED');
    validPayload(args);
    await this.#requireConnected({ signal });
    const cookie = await this.#credentials(signal);
    const streamId = randomUUID();
    const followedSession = endpoint === 'session/follow' && args.request?.address?.kind === 'session' && id(args.request.address.sessionId) ? args.request.address.sessionId : undefined;
    const url = new URL('/api/remote.mux', this.#config.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new this.#WebSocket(url, { headers: { cookie, origin: this.#config.baseUrl },
      maxPayload: MAX_BYTES, handshakeTimeout: this.#config.timeoutMs, followRedirects: false });
    const queue = [];
    let bytes = 0, ended = false, error, wake, eventClientId;
    const handles = new Set();
    const notify = () => { wake?.(); wake = undefined; };
    const stop = (reason) => { if (ended) return; ended = true; error = reason; for (const key of handles) this.#approvals.delete(key); this.#followEvidence.delete(streamId); notify(); if (socket.readyState < 2) socket.close(); };
    const handle = { close: () => stop(failure('DSH_REMOTE_STREAM_CLOSED')) };
    this.#streams.add(handle);
    const abort = () => stop(failure('DSH_REMOTE_CANCELLED'));
    const timeout = setTimeout(() => stop(failure('DSH_REMOTE_STREAM_TIMEOUT')), this.#config.timeoutMs);
    timeout.unref?.();
    socket.on('open', () => {
      if (ended) { socket.close(); return; }
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    });
    socket.on('message', data => {
      if (ended) return;
      let frame;
      try { frame = JSON.parse(data.toString()); }
      catch { stop(failure('DSH_REMOTE_INVALID_FRAME')); return; }
      if (!record(frame) || frame.streamId !== streamId || !['item', 'end', 'error'].includes(frame.type)) { stop(failure('DSH_REMOTE_INVALID_FRAME')); return; }
      clearTimeout(timeout);
      if (frame.type === 'error') { stop(failure(safeCode(frame.error?.code))); return; }
      if (frame.type === 'end') { stop(); return; }
      const size = Buffer.byteLength(data);
      bytes += size;
      if (queue.length >= 128 || bytes > MAX_BYTES) { stop(failure('DSH_REMOTE_STREAM_OVERFLOW')); return; }
      let value = frame.value;
      if (followedSession) this.#observeCalls(streamId, followedSession, value);
      if (endpoint === '$events') {
        if (!eventClientId) {
          if (value?.type !== 'ready' || !id(value.clientId)) { stop(failure('DSH_REMOTE_INVALID_FRAME')); return; }
          eventClientId = value.clientId;
        } else if (value?.type === 'waterfall' && value.event === 'approval/request') {
          if (!id(value.eventId) || !id(value.agentId) || !record(value.request)) { stop(failure('DSH_REMOTE_INVALID_FRAME')); return; }
          const duplicate = [...handles].find(key => this.#approvals.get(key)?.eventId === value.eventId);
          if (duplicate) return;
          const approvalHandle = randomUUID();
          this.#approvals.set(approvalHandle, { clientId: eventClientId, eventId: value.eventId, sessionId: value.agentId, streamId,
            callId: value.request.callId, toolName: value.request.toolName });
          handles.add(approvalHandle);
          value = { ...value, approvalHandle };
        } else if (value?.type === 'cancel') {
          for (const key of handles) if (this.#approvals.get(key)?.eventId === value.eventId) { this.#approvals.delete(key); handles.delete(key); }
        }
      }
      queue.push({ value, size }); notify();
    });
    socket.on('error', () => stop(failure('DSH_REMOTE_STREAM_LOST')));
    socket.on('close', () => stop(failure('DSH_REMOTE_STREAM_LOST')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      while (!ended || queue.length) {
        if (!queue.length) { await new Promise(resolve => { wake = resolve; }); continue; }
        const next = queue.shift(); bytes -= next.size; yield next.value;
      }
      if (error) throw error;
    } finally {
      clearTimeout(timeout);
      for (const key of handles) this.#approvals.delete(key);
      this.#followEvidence.delete(streamId);
      signal?.removeEventListener('abort', abort);
      this.#streams.delete(handle);
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', streamId }));
      if (socket.readyState < 2) socket.close();
    }
  }

  #observeCalls(streamId, sessionId, frame) {
    if (frame?.type === 'snapshot') {
      if (frame.header?.id !== sessionId || !Array.isArray(frame.records)) { this.#followEvidence.delete(streamId); return; }
      this.#followEvidence.set(streamId, { sessionId, calls: new Map() });
    }
    const evidence = this.#followEvidence.get(streamId);
    if (!evidence) return;
    for (const entry of frame?.type === 'snapshot' ? frame.records : [frame]) {
      const event = entry?.type === 'event' ? entry.event : null;
      if (event?.type !== 'tool/call' || !record(event.data) || !id(event.data.callId)) continue;
      const data = event.data;
      let complete = Number.isSafeInteger(event.seq) && id(data.name) && typeof data.arguments === 'string' && data.arguments.length <= 65536 &&
        !event.truncated && !data.truncated && !data.argumentsTruncated;
      if (complete) { try { complete = record(JSON.parse(data.arguments)); } catch { complete = false; } }
      const previous = evidence.calls.get(data.callId);
      if (previous && (previous.name !== data.name || previous.arguments !== data.arguments)) complete = false;
      evidence.calls.set(data.callId, { name: data.name, arguments: complete ? data.arguments : undefined, complete });
      // Evidence outside this bounded current window must be recovered through a
      // new native snapshot, never inferred from a title or streamed text prefix.
      if (evidence.calls.size > 128) evidence.calls.delete(evidence.calls.keys().next().value);
    }
  }

  #approvalHasDetails(pending) {
    if (!id(pending.callId) || !id(pending.toolName)) return false;
    const matches = [...this.#followEvidence.values()].filter(value => value.sessionId === pending.sessionId)
      .map(value => value.calls.get(pending.callId)).filter(Boolean);
    return matches.length > 0 && matches.every(value => value.complete && value.name === pending.toolName && value.arguments === matches[0].arguments);
  }

  async respondApproval(approvalHandle, decision, { sessionId, signal } = {}) {
    if (!['allowed-once', 'rejected'].includes(decision)) throw failure('DSH_REMOTE_APPROVAL_NOT_ALLOWED');
    const pending = this.#approvals.get(approvalHandle);
    if (!pending || pending.sessionId !== sessionId) throw failure('DSH_REMOTE_APPROVAL_EXPIRED');
    await this.#requireConnected({ signal, mutation: true });
    if (this.#approvals.get(approvalHandle) !== pending) throw failure('DSH_REMOTE_APPROVAL_EXPIRED');
    if (decision === 'allowed-once' && !this.#approvalHasDetails(pending)) throw failure('DSH_REMOTE_APPROVAL_DETAILS_UNAVAILABLE');
    this.#approvals.delete(approvalHandle);
    return this.#rpc('/api', '$events/result', { args: { clientId: pending.clientId, eventId: pending.eventId,
      outcome: { kind: 'result', value: decision } } }, { signal, mutation: true });
  }

  async run(_config, _prompt, _options = {}) {
    // A native prompt channel does not supply the existing per-run tools/guards.
    // Keep Hub execution closed until a target-host extension supplies that contract.
    throw failure('DSH_REMOTE_BUSINESS_TOOLS_UNAVAILABLE');
  }

  close() {
    this.#closed = true;
    for (const stream of this.#streams) stream.close();
    this.#approvals.clear(); this.#cookie = undefined;
  }
}

export function unavailableDshRemoteStatus(code = 'DSH_REMOTE_NOT_CONFIGURED') {
  return { configured: false, connected: false, state: 'unavailable', code, upstream: DSH_REMOTE_UPSTREAM,
    capabilities: { devices: false, workspaces: false, sessions: false, history: false, stream: false,
      prompt: false, interrupt: false, approval: false, files: false, backends: [], businessTools: false, taskExecution: false,
      unavailable: [{ capability: 'connection', code }] } };
}
