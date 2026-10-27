import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute } from 'node:path';
import WebSocket from 'ws';

const connections = new Map();
const MAX_FRAME = 32 * 1024 * 1024;
const failure = code => Object.assign(new Error(code), { code });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const clean = value => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value);

export function codexConnectionOptions(config) {
  const c = config.codex_connection === undefined ? { transport: 'stdio' } : config.codex_connection;
  if (!c || typeof c !== 'object' || Array.isArray(c) || !['stdio', 'unix', 'ssh'].includes(c.transport)) throw failure('AGENT_INVALID_CONNECTION');
  const keys = c.transport === 'stdio' ? ['transport'] : c.transport === 'unix' ? ['transport', 'socket_path'] : ['transport', 'socket_path', 'ssh_host', 'ssh_command', 'remote_command'];
  if (Object.keys(c).some(key => !keys.includes(key))) throw failure('AGENT_INVALID_CONNECTION');
  if (!clean(config.command) || !clean(config.workspace)) throw failure('AGENT_INVALID_CONNECTION');
  if (c.transport !== 'stdio' && (!clean(c.socket_path) || !isAbsolute(c.socket_path))) throw failure('AGENT_INVALID_CONNECTION');
  if (c.transport === 'ssh' && (!clean(c.ssh_host) || !/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(c.ssh_host) ||
      (c.ssh_command !== undefined && !clean(c.ssh_command)) || (c.remote_command !== undefined && (!clean(c.remote_command) || c.remote_command.startsWith('-'))))) throw failure('AGENT_INVALID_CONNECTION');
  return c.transport === 'stdio' ? { transport: 'stdio' } : c.transport === 'unix' ? { transport: 'unix', socket_path: c.socket_path } : {
    transport: 'ssh', socket_path: c.socket_path, ssh_host: c.ssh_host,
    ssh_command: c.ssh_command || 'ssh', remote_command: c.remote_command || 'codex',
  };
}

const keyFor = config => JSON.stringify([config.command, config.workspace, codexConnectionOptions(config)]);

/** One initialized native connection. No prompts, credentials or raw stderr are logged. */
export class CodexAppServer {
  constructor(config) {
    this.config = config;
    this.options = codexConnectionOptions(config);
    this.pending = new Map();
    this.runs = new Set();
    this.threads = new Map();
    this.nextId = 1;
    this.closed = false;
    this.exited = Promise.withResolvers();
    this.ready = this.open();
    this.ready.catch(() => {});
  }

  spawn(command, args, cwd) {
    this.child = spawn(command, args, { cwd, env: process.env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.close(failure('AGENT_START_FAILED')));
    this.child.stdin.on('error', () => this.close(failure('AGENT_CONNECTION_LOST')));
    this.child.on('close', () => { this.exited.resolve(); this.close(failure('AGENT_CONNECTION_LOST')); });
    return this.child;
  }

  async open() {
    try {
      if (this.options.transport === 'stdio') {
        const child = this.spawn(this.config.command, ['app-server', '--listen', 'stdio://', '--disable', 'plugins', '--disable', 'apps'], this.config.workspace);
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        child.stdout.on('data', chunk => {
          buffer += decoder.write(chunk);
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (Buffer.byteLength(line) > MAX_FRAME) return this.close(failure('AGENT_OUTPUT_LIMIT'));
            if (line.trim()) this.receive(line);
          }
          if (Buffer.byteLength(buffer) > MAX_FRAME) this.close(failure('AGENT_OUTPUT_LIMIT'));
        });
      } else {
        let createConnection;
        if (this.options.transport === 'unix') createConnection = () => connect(this.options.socket_path);
        else {
          // SSH executes a remote shell command: quote every fixed/config argument, never task input.
          const remote = ['exec', quote(this.options.remote_command), 'app-server', 'proxy', '--sock', quote(this.options.socket_path)].join(' ');
          const child = this.spawn(this.options.ssh_command, ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--', this.options.ssh_host, remote]);
          createConnection = () => Duplex.from({ readable: child.stdout, writable: child.stdin });
        }
        this.ws = new WebSocket('ws://localhost/', { createConnection, maxPayload: MAX_FRAME, handshakeTimeout: 10000 });
        this.ws.on('message', (data, binary) => binary ? this.close(failure('AGENT_INVALID_JSON')) : this.receive(data.toString()));
        this.ws.on('error', () => this.close(failure('AGENT_CONNECTION_LOST')));
        this.ws.on('close', () => this.close(failure('AGENT_CONNECTION_LOST')));
        await new Promise((resolve, reject) => {
          this.ws.once('open', resolve);
          this.ws.once('error', () => reject(failure('AGENT_CONNECTION_LOST')));
          this.ws.once('close', () => reject(failure('AGENT_CONNECTION_LOST')));
        });
      }
      const info = await this.request('initialize', { clientInfo: { name: 'personal_agent', title: 'Personal Agent', version: '0.3.0' }, capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized', params: {} });
      this.reference(this.runs.size > 0);
      return info;
    } catch (error) { this.close(error); throw error; }
  }

  reference(active) {
    clearTimeout(this.idleTimer);
    if (!active && !this.closed) {
      this.idleTimer = setTimeout(() => this.close(failure('AGENT_CONNECTION_IDLE')), 5 * 60 * 1000);
      this.idleTimer.unref();
    }
    for (const pending of this.pending.values()) { if (active) pending.timer.ref(); else pending.timer.unref(); }
    for (const handle of [this.child, this.child?.stdin, this.child?.stdout, this.child?.stderr, this.ws?._socket]) {
      if (active) handle?.ref?.(); else handle?.unref?.();
    }
  }

  receive(line) {
    if (this.closed) return;
    let message;
    try { message = JSON.parse(line); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(); }
    catch { this.close(failure('AGENT_INVALID_JSON')); return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(failure('AGENT_RPC_REJECTED')); else pending.resolve(message.result);
      return;
    }
    const run = this.threads.get(message.params?.threadId);
    if (run) run.receive(message);
    else if (message.id !== undefined && message.method) this.send({ id: message.id, error: { code: -32601, message: 'No active owner; no permission granted' } });
  }

  send(message) {
    if (this.closed) throw failure('AGENT_CONNECTION_LOST');
    const encoded = JSON.stringify(message);
    if (this.ws) this.ws.send(encoded); else this.child.stdin.write(encoded + '\n');
  }

  request(method, params, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(failure('AGENT_CONNECTION_LOST'));
    const id = this.nextId++, pending = Promise.withResolvers();
    pending.timer = setTimeout(() => {
      this.pending.delete(id); pending.reject(failure('AGENT_RPC_TIMEOUT'));
    }, timeoutMs);
    this.pending.set(id, pending);
    try { this.send({ id, method, params }); }
    catch (error) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error); }
    return pending.promise;
  }

  close(error = failure('AGENT_CONNECTION_CLOSED')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const run of [...this.runs]) run.disconnected(error);
    if (this.ws) this.ws.terminate();
    if (!this.child) { this.exited.resolve(); return; }
    this.child.stdin.end();
    const kill = signal => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      try { if (process.platform === 'win32') this.child.kill(signal); else process.kill(-this.child.pid, signal); } catch { /* already gone */ }
    };
    const grace = setTimeout(() => kill('SIGTERM'), 500); grace.unref();
    const deadline = setTimeout(() => kill('SIGKILL'), 1500); deadline.unref();
    this.exited.promise.then(() => { clearTimeout(grace); clearTimeout(deadline); });
  }
}

export function getCodexConnection(config) {
  const key = keyFor(config);
  let connection = connections.get(key);
  if (!connection || connection.closed) { connection = new CodexAppServer(config); connections.set(key, connection); }
  return connection;
}

export async function closeCodexConnections(config) {
  let entries = [...connections];
  if (config) {
    let key;
    try { key = keyFor(config); } catch { return; } // No connection could have been opened for this configuration.
    entries = [[key, connections.get(key)]];
  }
  await Promise.all(entries.map(async ([key, connection]) => {
    connections.delete(key);
    if (connection) { connection.reference(true); connection.close(); await connection.exited.promise; }
  }));
}

/** Turn-scoped ownership, deadline and cancellation over a reusable connection. */
export class CodexRun {
  constructor(connection, context, timeoutMs) {
    this.connection = connection; this.context = context;
    this.effects = new AbortController(); this.signal = this.effects.signal;
    this.opening = []; this.openingBytes = 0; this.requests = new Set();
    this.done = Promise.withResolvers(); this.done.promise.catch(() => {});
    this.connection.runs.add(this); this.connection.reference(true);
    this.abort = () => this.stop(failure('AGENT_CANCELLED'));
    context.signal?.addEventListener('abort', this.abort, { once: true });
    this.timer = setTimeout(() => this.stop(failure('AGENT_TIMEOUT')), timeoutMs);
    if (context.signal?.aborted) this.abort();
  }

  bind(threadId) {
    const owner = this.connection.threads.get(threadId);
    if (owner && owner !== this) throw failure('AGENT_THREAD_BUSY');
    this.threadId = threadId; this.connection.threads.set(threadId, this);
  }

  async request(method, params) {
    if (this.settled || this.stopping) throw this.stopping || failure('AGENT_CLOSED');
    if (method === 'turn/start') this.submitted = true;
    let result;
    try { result = await Promise.race([this.connection.request(method, params), this.done.promise.then(() => { throw failure('AGENT_CLOSED'); })]); }
    catch (error) {
      // An explicit rejection is evidence that the server did not accept a new turn.
      if (method === 'turn/start' && error.code === 'AGENT_RPC_REJECTED' && !this.turnId) this.submitted = false;
      throw error;
    }
    if (method === 'turn/start') {
      if (!clean(result?.turn?.id)) throw failure('AGENT_INVALID_RESPONSE');
      this.turnId = result.turn.id;
      this.interrupt();
      const opening = this.opening; this.opening = []; this.openingBytes = 0;
      for (const message of opening) this.receive(message);
    }
    return result;
  }

  receive(message) {
    if (this.settled || !this.submitted) return;
    const p = message.params || {}, turnId = p.turnId || p.turn?.id;
    // Notifications can precede the turn/start response. Only that correlated
    // response establishes ownership; a late previous turn must not claim it.
    if (!this.turnId) {
      this.openingBytes += Buffer.byteLength(JSON.stringify(message));
      if (this.opening.length >= 1024 || this.openingBytes > MAX_FRAME) {
        this.connection.close(failure('AGENT_OUTPUT_LIMIT')); return;
      }
      this.opening.push(message); return;
    }
    if (turnId !== this.turnId) {
      if (message.id !== undefined) this.connection.send({ id: message.id, error: { code: -32601, message: 'No matching active turn; no permission granted' } });
      return;
    }
    if (message.id !== undefined) {
      if (this.requests.has(message.id)) return;
      this.requests.add(message.id);
    }
    if (message.method === 'turn/completed') {
      this.terminal = true;
      this.effects.abort();
      if (this.stopping) { this.reject(this.stopping); return; }
    }
    if (this.stopping) {
      if (message.id !== undefined) this.connection.send({ id: message.id, error: { code: -32601, message: 'Turn cancelled; no permission granted' } });
      return;
    }
    Promise.resolve(this.onMessage?.(message)).catch(error => this.fail(error));
  }

  send(message) { if (!this.settled && !this.stopping && !this.terminal) this.connection.send(message); }
  finish(value) { if (!this.settled) { this.settled = true; this.cleanup(); this.done.resolve(value); } }
  reject(error) { if (!this.settled) { this.settled = true; this.cleanup(); this.done.reject(error); } }
  fail(error) { if (this.terminal || !this.submitted) this.reject(error); else this.stop(error); }

  uncertain(reason) {
    return Object.assign(new Error('AGENT_CONNECTION_UNCERTAIN' + (reason?.code ? ': ' + reason.code : '')), {
      code: 'AGENT_CONNECTION_UNCERTAIN', sessionId: this.threadId, turnId: this.turnId,
    });
  }

  disconnected(error) { this.reject(this.submitted && !this.terminal ? this.uncertain(error) : error); }

  stop(error) {
    if (this.settled || this.stopping) return;
    if (!this.submitted) { this.reject(error); return; }
    this.stopping = error;
    this.effects.abort();
    this.cancelTimer = setTimeout(() => {
      this.reject(this.uncertain(error));
      // This connection can no longer prove turn ownership or completion.
      this.connection.close(failure('AGENT_CONNECTION_UNCERTAIN'));
    }, 2000);
    this.interrupt();
  }

  interrupt() {
    if (!this.stopping || !this.turnId || this.interruptSent || this.settled) return;
    this.interruptSent = true;
    this.connection.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 2000).catch(() => {});
  }

  cleanup() {
    clearTimeout(this.timer); clearTimeout(this.cancelTimer);
    this.effects.abort(); this.opening = []; this.openingBytes = 0; this.requests.clear();
    this.context.signal?.removeEventListener('abort', this.abort);
    this.connection.runs.delete(this);
    if (this.connection.threads.get(this.threadId) === this) this.connection.threads.delete(this.threadId);
    if (!this.connection.runs.size) this.connection.reference(false);
  }
}
