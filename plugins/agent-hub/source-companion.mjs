import { readFileSync, writeFileSync, renameSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bridgeTransport } from './companion.mjs';
import { readLocalSource, sourceAuthorizationSnapshot } from './sources.mjs';
import { failure } from './store.mjs';
import { SOURCE_OPERATIONS } from './source-capabilities.mjs';

export const sourceTransport = config => bridgeTransport(config, {
  operations: ['source-poll', 'source-check', 'source-result'], prefix: '/api/agent-bridge/', header: 'X-PA-Agent-Token',
});
const MAX_RESULT_BYTES = 512000;
const terminal = new Set(['FORBIDDEN', 'SOURCE_AUTHORITY_CHANGED', 'SOURCE_REVOKED', 'SOURCE_BRIDGE_REVOKED', 'SOURCE_BRIDGE_TIMEOUT', 'SOURCE_NOT_CONFIGURED', 'CONFLICT']);
const permanentResponse = new Set(['BODY_TOO_LARGE', 'INVALID_SOURCE_RESPONSE', 'INVALID_INPUT']);

/** A separate read-only lane: cloud tools never compete for the local LLM job. */
export class SourceCompanion {
  constructor({ root, statePath, transport, readSource = readLocalSource, authorizationSnapshot = sourceAuthorizationSnapshot, now = Date.now }) {
    this.root = root; this.statePath = statePath; this.transport = transport; this.readSource = readSource; this.authorizationSnapshot = authorizationSnapshot; this.now = now;
    this.state = { runnerId: randomUUID(), active: null };
    try {
      const st = lstatSync(statePath);
      if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077 || process.getuid && st.uid !== process.getuid() || st.size > 768000) throw failure('PRIVATE_SOURCE_STATE_REQUIRED');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(state.runnerId)) throw failure('INVALID_SOURCE_STATE');
      this.state = state;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.save();
  }
  save() {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const data = JSON.stringify(this.state);
    if (Buffer.byteLength(data) > 640000) throw failure('INVALID_SOURCE_STATE');
    const temporary = this.statePath + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.statePath);
  }
  async authorize(job) {
    if (this.closed || this.now() >= job.deadlineAt) throw failure('SOURCE_BRIDGE_TIMEOUT');
    const result = await this.transport('source-check', { runnerId: this.state.runnerId, requestId: job.id, lease: job.lease });
    if (this.closed || result.allowed !== true || result.account !== job.account || JSON.stringify(result.accounts) !== JSON.stringify(job.accounts) || JSON.stringify(result.operations) !== JSON.stringify(job.operations)) throw failure('SOURCE_AUTHORITY_CHANGED');
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const saved = this.state.active;
      if (saved?.outcome) {
        try {
          await this.authorize(saved.job);
          if (saved.outcome.result) {
            try {
              const current = await this.authorizationSnapshot(this.root, saved.job.account, saved.job.arguments);
              if (JSON.stringify(current) !== JSON.stringify(saved.authorization)) throw failure('SOURCE_AUTHORITY_CHANGED');
            } catch {
              saved.outcome = { error: 'SOURCE_AUTHORITY_CHANGED' }; delete saved.authorization; this.save();
            }
          }
          await this.transport('source-result', { runnerId: this.state.runnerId, requestId: saved.job.id, lease: saved.job.lease, ...saved.outcome });
        }
        catch (e) {
          if (permanentResponse.has(e.code) && saved.outcome.result) {
            saved.outcome = { error: 'SOURCE_RESPONSE_REJECTED' }; delete saved.authorization; this.save(); return;
          }
          if (!terminal.has(e.code) && !permanentResponse.has(e.code)) throw e;
        }
        this.state.active = null; this.save();
      }
      const { enabled, job } = await this.transport('source-poll', { runnerId: this.state.runnerId });
      if (this.closed) return;
      if (!enabled || !job) {
        if (!this.execution && this.state.active) { this.state.active = null; this.save(); }
        return;
      }
      if (this.execution) return;
      if (!job.id || !job.lease || !Number.isSafeInteger(job.deadlineAt) || job.account !== null && typeof job.account !== 'string' || !Array.isArray(job.operations)) throw failure('INVALID_SOURCE_RESPONSE');
      this.state.active = { job }; this.save();
      this.execution = this.execute(job).finally(() => { this.execution = null; });
    } finally { this.ticking = false; }
  }
  async execute(job) {
    const authorize = () => this.authorize(job);
    try {
      await authorize();
      if (job.arguments?.operation !== 'list' && (!Object.hasOwn(SOURCE_OPERATIONS, job.arguments?.operation) || !job.operations.includes(job.arguments.operation))) throw failure('FORBIDDEN');
      const authorization = await this.authorizationSnapshot(this.root, job.account, job.arguments);
      let result = await this.readSource({ root: this.root, args: job.arguments, expectedAccount: job.account, ...(job.accounts ? { expectedAccounts: job.accounts } : {}), authorize });
      await authorize();
      if (JSON.stringify(await this.authorizationSnapshot(this.root, job.account, job.arguments)) !== JSON.stringify(authorization)) throw failure('SOURCE_AUTHORITY_CHANGED');
      if (job.arguments.operation === 'list') result = { operation: 'list', untrusted: true, configured: result.configured,
        actions: result.actions.filter(op => op === 'list' || job.operations.includes(op)),
        roots: job.operations.some(op => SOURCE_OPERATIONS[op]?.kind === 'files') ? result.roots : [] };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw failure('SOURCE_RESPONSE_TOO_LARGE');
      this.state.active.authorization = authorization;
      this.state.active.outcome = { result };
    } catch (e) {
      // Reads can restart safely. Keep the durable request on a deliberate stop.
      if (this.closed) return;
      this.state.active.outcome = { error: /^(?:SOURCE_[A-Z_]+|INVALID_(?:INPUT|SOURCE_RESPONSE)|FORBIDDEN)$/.test(e.code || '') ? e.code : 'SOURCE_UNAVAILABLE' };
    }
    this.save();
  }
  async stop() { this.closed = true; await this.execution; }
}
