import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { providers } from './providers.mjs';

// Channel-neutral request execution. IM-specific serialization stays in the channel.
export class AgentConversations {
  constructor({ config, accountId, inbound, outbound, approvalRegistry, sessionKey, agentConfig }) {
    Object.assign(this, { config, accountId, inbound, outbound, approvalRegistry, sessionKey, agentConfig });
    this.queues = new Map();
    this.active = new Map();
    this.generations = new Map();
    this.disposed = false;
  }

  async initialize() {
    if (!providers[this.agentConfig.provider]) throw new Error('Unsupported agent provider');
    await mkdir(this.agentConfig.state_dir, { recursive: true, mode: 0o700 });
  }

  key(message) { return this.sessionKey(this.accountId, message); }
  path(id) {
    return join(this.agentConfig.state_dir, createHash('sha256')
      .update(this.agentConfig.provider + '\0' + id).digest('hex') + '.json');
  }
  async load(id) {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async save(id, sessionId) {
    const path = this.path(id);
    const temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify({ sessionId }), { mode: 0o600 });
    await rename(temporary, path);
  }
  enqueue(id, operation) {
    const next = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    const tracked = next.catch(() => {}).finally(() => {
      if (this.queues.get(id) === tracked) this.queues.delete(id);
    });
    this.queues.set(id, tracked);
    return next;
  }

  process(message, api, sendPrompt) {
    const id = this.key(message);
    const generation = this.generations.get(id) || 0;
    return this.enqueue(id, async () => {
      if (this.disposed || generation !== (this.generations.get(id) || 0)) throw new Error('AGENT_CANCELLED');
      const controller = new AbortController();
      this.active.set(id, controller);
      try {
        const state = await this.load(id);
        const content = await this.inbound(message, api);
        const prompt = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const instructions = await readFile(this.agentConfig.instructions, 'utf8');
        if (controller.signal.aborted) throw new Error('AGENT_CANCELLED');
        const result = await providers[this.agentConfig.provider](this.agentConfig, prompt, {
          sessionId: state.sessionId, instructions, signal: controller.signal,
          onSession: session => this.save(id, session),
          approve: async request => {
            // Do not approve a truncated operation: the user must see the whole request.
            if (Buffer.byteLength(request.reason || '') > 1800) return false;
            return await this.approvalRegistry.request(id, request, sendPrompt) === 'allowed-once';
          },
        });
        if (controller.signal.aborted) throw new Error('AGENT_CANCELLED');
        await this.save(id, result.sessionId);
        const attachments = await this.outbound(result.text);
        if (controller.signal.aborted) throw new Error('AGENT_CANCELLED');
        return { text: [result.text, ...attachments.warnings].join('\n'), images: [], files: attachments.files };
      } finally {
        controller.abort();
        this.approvalRegistry.cancelConversation(id);
        this.active.delete(id);
      }
    });
  }

  executeCommand() { return Promise.resolve({ kind: 'unknown', available: ['/bot-cancel', '/bot-status'] }); }
  decideApproval(message, command) { return this.approvalRegistry.decide(this.key(message), command); }
  cancel(message) {
    const id = this.key(message);
    this.generations.set(id, (this.generations.get(id) || 0) + 1);
    const controller = this.active.get(id);
    controller?.abort();
    return this.approvalRegistry.cancelConversation(id) || Boolean(controller || this.queues.get(id));
  }
  startNewConversation(message) {
    this.cancel(message);
    const id = this.key(message);
    return this.enqueue(id, () => this.save(id, null));
  }
  cancelPendingApprovals() {
    this.disposed = true;
    for (const controller of this.active.values()) controller.abort();
    this.approvalRegistry.cancelAll();
  }
  async dispose() {
    this.cancelPendingApprovals();
    await Promise.allSettled(this.queues.values());
  }
}

export async function createConversations(options) {
  const path = new URL('../../.runtime/agent.json', import.meta.url);
  const agentConfig = JSON.parse(await readFile(path, 'utf8'));
  return new AgentConversations({ ...options, agentConfig });
}
