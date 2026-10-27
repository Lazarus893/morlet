import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// One channel process owns an account ledger. Models never receive its path or tokens.
export class Ledger {
  constructor(directory, accountId, { hashed = false } = {}) {
    if (hashed && !/^[a-f0-9]{64}$/.test(accountId)) throw new Error("INVALID_ACCOUNT");
    this.directory = directory;
    this.path = join(directory, (hashed ? accountId : createHash('sha256').update(accountId).digest('hex')) + '.json');
    this.lockPath = this.path + '.lease.sqlite';
    this.tail = Promise.resolve();
  }
  async initialize(allowed, { managementOnly = false } = {}) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      // A kernel-backed SQLite transaction releases automatically on a crash.
      // Avoid stale-PID lock deletion races and PID reuse. No application data
      // lives in this lease DB; JSON snapshots stay independently readable.
      this.lock = new DatabaseSync(this.lockPath, { timeout: 0 });
      this.lock.exec('BEGIN EXCLUSIVE');
      await chmod(this.lockPath, 0o600);
    } catch (error) {
      this.lock?.close(); this.lock = undefined;
      if (error.errcode === 5 || error.errcode === 6) throw new Error('PROACTIVE_ALREADY_RUNNING');
      throw error;
    }
    try {
      try {
        const raw = await readFile(this.path, 'utf8');
        if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('PROACTIVE_STATE_TOO_LARGE');
        this.data = JSON.parse(raw);
        if (this.data.version !== 1 || !this.data.users || typeof this.data.users !== 'object' || Array.isArray(this.data.users)) throw new Error('PROACTIVE_STATE_INVALID');
        Object.setPrototypeOf(this.data.users, null);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.data = { version: 1, users: Object.create(null) };
      }
      for (const [id, user] of Object.entries(this.data.users)) {
        if (!allowed(id)) { delete this.data.users[id]; continue; }
        if (!user || !Array.isArray(user.tasks) || !Array.isArray(user.events) || !user.preferences ||
            !user.deliveryDays || !user.observationDays || typeof user.contextToken !== 'string' ||
            !Number.isFinite(user.contextAt) || !Number.isFinite(user.lastInbound) || !Number.isFinite(user.lastAttempt)) {
          throw new Error('PROACTIVE_STATE_INVALID');
        }
        for (const task of user.tasks) {
          if (!task || !/^[a-f0-9]{8}$/.test(task.id) || typeof task.title !== 'string' ||
              !['welcome', 'reminder', 'followup'].includes(task.kind) ||
              !['pending', 'sending', 'submitted', 'delivery_unknown', 'done', 'cancelled', 'expired', 'skipped'].includes(task.status) ||
              !Number.isFinite(task.notifyAt) || !Number.isFinite(task.expiresAt) || !Number.isFinite(task.createdAt)) {
            throw new Error('PROACTIVE_STATE_INVALID');
          }
        }
        // A crash after submission has an unknown outcome. Never resend automatically.
        for (const task of user.tasks) if (task.status === 'sending') task.status = 'delivery_unknown';
        if (!managementOnly) user.revision = (user.revision || 0) + 1;
      }
      await this.save();
    } catch (error) { await this.close(); throw error; }
  }
  async save(serialized = JSON.stringify(this.data)) {
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, this.path);
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  update(operation) {
    const current = this.tail.then(async () => {
      if (this.failed) throw new Error('PROACTIVE_STORAGE_UNAVAILABLE');
      const before = JSON.stringify(this.data);
      const result = operation(this.data);
      const after = JSON.stringify(this.data);
      if (before !== after) {
        try { await this.save(after); }
        catch (error) { this.failed = true; throw error; }
      }
      return result;
    });
    this.tail = current.catch(() => {});
    return current;
  }
  async close() {
    await this.tail;
    if (this.lock) {
      this.lock.close(); this.lock = undefined;
    }
  }
}
