import { DatabaseSync } from 'node:sqlite';
import { chmodSync, realpathSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { failure } from './store.mjs';

// Keep the file in place: unlinking a stale PID file lets concurrent starters
// acquire different inodes. SQLite's OS lock is released even after SIGKILL.
export function acquireCompanionLock(configPath) {
  return acquireLock(realpathSync(configPath) + '.lock.sqlite');
}

export function acquireMessageCompanionLock(config, directory = join(homedir(), 'Library/Application Support/Xiaoman/message-locks')) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(JSON.stringify([realpathSync(config.database), config.chatId])).digest('hex');
  return acquireLock(join(directory, key + '.sqlite'));
}

function acquireLock(path) {
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if (error.errcode === 5 || error.errcode === 6) throw failure('COMPANION_ALREADY_RUNNING');
    throw error;
  }
  let released = false;
  return () => { if (!released) { released = true; db.close(); } };
}
