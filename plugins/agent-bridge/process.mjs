import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// A private JSONL transport: never log raw protocol, stderr, tokens or prompts.
export class JsonProcess {
  constructor(command, args, { cwd, signal, timeoutMs }) {
    if (signal?.aborted) throw new Error('AGENT_CANCELLED');
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.done = Promise.withResolvers();
    this.exited = Promise.withResolvers();
    // Suppress unhandled rejection while the caller is still initializing RPCs.
    this.done.promise.catch(() => {});
    this.child = spawn(command, args, {
      cwd, env: process.env, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(new Error('AGENT_STDIN_CLOSED')));
    this.child.on('error', () => this.fail(new Error('AGENT_START_FAILED')));
    this.child.on('close', () => {
      if (!this.closed) this.fail(new Error('AGENT_EXITED_WITHOUT_RESULT'));
      this.exited.resolve();
    });
    let bytes = 0;
    this.child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) this.fail(new Error('AGENT_OUTPUT_LIMIT'));
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      if (!line.trim() || this.closed) return;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error('AGENT_RPC_REJECTED'));
          else pending.resolve(message.result);
        } else {
          Promise.resolve(this.onMessage?.(message)).catch(error => this.fail(error));
        }
      } catch { this.fail(new Error('AGENT_INVALID_JSON')); }
    });
    this.timer = setTimeout(() => this.fail(new Error('AGENT_TIMEOUT')), timeoutMs);
    this.abort = () => this.fail(new Error('AGENT_CANCELLED'));
    this.signal = signal;
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  send(message) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('AGENT_CLOSED'));
    const id = this.nextId++;
    const pending = Promise.withResolvers();
    this.pending.set(id, pending);
    this.send({ id, method, params });
    return pending.promise;
  }

  finish(result) {
    if (this.closed) return;
    this.done.resolve(result);
    this.close();
  }

  fail(error) {
    if (this.closed) return;
    this.done.reject(error);
    this.close(error);
  }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.abort);
    for (const pending of this.pending.values()) pending.reject(error || new Error('AGENT_CLOSED'));
    this.pending.clear();
    this.lines.close();
    const kill = signal => {
      try {
        if (process.platform === 'win32') this.child.kill(signal);
        else process.kill(-this.child.pid, signal);
      } catch { /* process already exited */ }
    };
    if (error) kill('SIGTERM');
    else {
      this.child.stdin.end();
      const grace = setTimeout(() => kill('SIGTERM'), 500);
      grace.unref();
    }
    // Kill the process group, including a tool still holding stdio open.
    const timer = setTimeout(() => kill('SIGKILL'), 1500);
    timer.unref();
  }
}
