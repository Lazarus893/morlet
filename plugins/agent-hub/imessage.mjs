import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, statSync, closeSync, openSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { bridgeTransport, validateBridgeConfig } from './companion.mjs';
import { failure } from './store.mjs';
const exec = promisify(execFile);
export const normalizeMessageAddress = value => typeof value === 'string' ? value.replace(/^(?:mailto:|tel:|E:)/i, '').trim().toLowerCase() : '';
export const validMessageAddress = value => typeof value === 'string' && value.length <= 256 && /^(?:\+[1-9]\d{6,14}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(value);

export function loadMessageConfig(path) {
  const st = statSync(path);
  if (st.mode & 0o077 || !st.isFile() || st.size > 16000 || process.getuid && st.uid !== process.getuid()) throw failure('PRIVATE_CONFIG_REQUIRED');
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isSafeInteger(c.chatId) || c.chatId < 1 || typeof c.peer !== 'string' || !/^(?:\+[1-9]\d{6,14}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(c.peer) || c.peer.length > 256 || typeof c.command !== 'string' || !c.command || c.database) throw failure('INVALID_CONFIG');
  if (!validMessageAddress(c.botAddress) || normalizeMessageAddress(c.botAddress) === normalizeMessageAddress(c.peer)) throw failure('IMESSAGE_IDENTITIES_REQUIRED');
  return { ...c, peer: normalizeMessageAddress(c.peer), botAddress: normalizeMessageAddress(c.botAddress), ...validateBridgeConfig(c), database: join(homedir(), 'Library/Messages/chat.db') };
}
export const messageTransport = config => bridgeTransport(config, { operations: ['poll', 'inbound', 'ack', 'status'], prefix: '/api/message-bridge/', header: 'X-PA-Channel-Token' });

/** Find only the explicitly requested peer; never return unrelated chat metadata. */
export async function resolveMessageChat(config, { execute = exec } = {}) {
  if (typeof config.peer !== 'string' || config.peer.length > 256 || !/^(?:\+[1-9]\d{6,14}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(config.peer)) throw failure('INVALID_CONFIG');
  if (config.chatId !== undefined && config.chatId !== null) {
    if (!Number.isSafeInteger(config.chatId) || config.chatId < 1) throw failure('INVALID_CONFIG');
    return config.chatId;
  }
  let chats;
  try {
    const { stdout } = await execute(config.command, ['chats', '--limit', '100', '--json'], { timeout: 15000, maxBuffer: 262144 });
    const raw = stdout.trim();
    chats = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!Array.isArray(chats)) throw 0;
  } catch (error) { throw failure(error?.code === 'ENOENT' ? 'IMESSAGE_NOT_INSTALLED' : 'IMESSAGE_CHAT_ACCESS_REQUIRED'); }
  const matches = chats.filter(c => c && c.service === 'iMessage' && c.is_group === false &&
    (normalizeMessageAddress(c.identifier) === normalizeMessageAddress(config.peer) || c.participants?.length === 1 && normalizeMessageAddress(c.participants[0]) === normalizeMessageAddress(config.peer)));
  const ids = [...new Set(matches.map(c => c.id).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) throw failure('IMESSAGE_CHAT_NOT_FOUND');
  if (ids.length !== 1) throw failure('IMESSAGE_CHAT_AMBIGUOUS');
  return ids[0];
}

/** Read only the configured chat's identity; never scan history or send a probe. */
export async function checkMessageChat(config, { execute = exec } = {}) {
  let chat;
  try {
    const { stdout } = await execute(config.command, ['group', '--chat-id', String(config.chatId), '--json'], { timeout: 15000, maxBuffer: 65536 });
    chat = JSON.parse(stdout);
  } catch (error) { throw failure(error.code === 'ENOENT' ? 'IMESSAGE_NOT_INSTALLED' : 'IMESSAGE_CHAT_ACCESS_REQUIRED'); }
  if (!chat || chat.is_group !== false || !Array.isArray(chat.participants) || chat.participants.length !== 1) throw failure('IMESSAGE_DIRECT_CHAT_REQUIRED');
  if (chat.service !== 'iMessage') throw failure('IMESSAGE_SERVICE_REQUIRED');
  if (normalizeMessageAddress(chat.participants[0]) !== normalizeMessageAddress(config.peer)) throw failure('IMESSAGE_PEER_MISMATCH');
  if (!validMessageAddress(config.botAddress) || normalizeMessageAddress(config.peer) === normalizeMessageAddress(config.botAddress)) throw failure('IMESSAGE_IDENTITIES_REQUIRED');
  if (normalizeMessageAddress(chat.last_addressed_handle) !== normalizeMessageAddress(config.botAddress)) throw failure('IMESSAGE_ACCOUNT_MISMATCH');
  return chat;
}

/** Only metadata from this chat is read; Messages is never opened for writing. */
export function messageDatabase(config) {
  function read(fn) {
    let db;
    try { db = new DatabaseSync(config.database, { readOnly: true }); return fn(db); }
    catch { throw failure('IMESSAGE_CHAT_ACCESS_REQUIRED'); }
    finally { db?.close(); }
  }
  return {
    baseline() {
      return read(db => {
        const st = statSync(config.database);
        return { generation: `${st.dev}:${st.ino}:${st.birthtimeMs}`, cursor: Number(db.prepare('SELECT COALESCE(MAX(message_id),0) AS cursor FROM chat_message_join WHERE chat_id=?').get(config.chatId).cursor) };
      });
    },
    inspect({ id, guid }) {
      return read(db => db.prepare(`SELECT m.ROWID AS id, m.guid, m.service, m.is_from_me, m.destination_caller_id,
        m.is_sent, m.is_delivered, m.is_read, m.error FROM message m
        JOIN chat_message_join j ON j.message_id=m.ROWID
        WHERE j.chat_id=? AND m.ROWID=? AND m.guid=?`).get(config.chatId, id, guid));
    },
  };
}

/** Durable inbox/outbox; only one verified external peer can become a task. */
export class IMessageCompanion {
  constructor({ config, statePath, transport = messageTransport(config), now = Date.now,
    database = messageDatabase(config), check = () => checkMessageChat(config),
    // Handle targets use the active iMessage service, not an old any-chat route.
    send = async text => {
      const { stdout } = await exec(config.command, ['send', '--chat-identifier', config.peer, '--text', text, '--service', 'imessage', '--json'], { timeout: 30000, maxBuffer: 65536 });
      return JSON.parse(stdout);
    } }) {
    Object.assign(this, { config, statePath, transport, now, database, check, send });
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(statePath, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const st = statSync(statePath);
    if (!st.isFile() || st.mode & 0o077 || process.getuid && st.uid !== process.getuid()) throw failure('PRIVATE_STATE_REQUIRED');
    this.db = new DatabaseSync(statePath); chmodSync(statePath, 0o600);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox (guid TEXT PRIMARY KEY, row_id INTEGER, body TEXT, received_at INTEGER);
        CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, state TEXT NOT NULL, guid TEXT, message_id INTEGER,
          at INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0, acked_state TEXT, error TEXT);`);
      const identity = JSON.stringify([config.channelId, config.chatId, config.botAddress, config.peer]);
      if (this.get('identity') && this.get('identity') !== identity) throw failure('IMESSAGE_BINDING_CHANGED');
      this.transaction(() => {
        this.set('identity', identity);
        if (!this.get('activatedAt')) this.set('activatedAt', this.now());
        this.db.exec("UPDATE outbox SET state='unknown' WHERE state='sending'");
      });
    } catch (error) { this.db.close(); throw error.code ? error : failure('IMESSAGE_STATE_INVALID'); }
    this.nextCheck = 0; this.ticking = false;
  }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get state() {
    return { cursor: Number(this.get('cursor') || 0), generation: this.get('generation'),
      incoming: this.db.prepare('SELECT body FROM inbox WHERE body IS NOT NULL ORDER BY row_id').all().map(r => JSON.parse(r.body)) };
  }
  close() { this.db.close(); }
  generationFingerprint(generation) {
    return createHash('sha256').update(JSON.stringify([this.get('identity'), this.get('generation'), generation])).digest('hex');
  }
  async prepare() {
    await this.check();
    const current = this.database.baseline();
    if (this.get('generation') && this.get('generation') !== current.generation) {
      const fingerprint = this.generationFingerprint(current.generation);
      const response = await this.status(false, 'IMESSAGE_DATABASE_CHANGED', fingerprint);
      if (response?.recovery?.fingerprint !== fingerprint || this.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE body IS NOT NULL').get().n) throw failure('IMESSAGE_DATABASE_CHANGED');
      await this.check();
      const verified = this.database.baseline();
      if (!verified.cursor || verified.generation !== current.generation) throw failure('IMESSAGE_DATABASE_CHANGED');
      this.transaction(() => {
        // Keep delivery IDs permanently: uncertain sends must never be replayed.
        this.db.exec("UPDATE outbox SET state='unknown',guid=NULL,message_id=NULL,acked_state=NULL,error='IMESSAGE_DATABASE_CHANGED' WHERE state IN ('sending','submitted','sent','unknown')");
        this.set('generation', verified.generation); this.set('cursor', verified.cursor);
        this.set('activatedAt', this.now()); this.set('recoveryId', response.recovery.id);
      });
    }
    if (!current.cursor) throw failure('IMESSAGE_CHAT_NOT_FOUND');
    this.transaction(() => {
      this.set('generation', current.generation);
      if (this.get('cursor') === undefined) this.set('cursor', current.cursor);
    });
    this.nextCheck = this.now() + 15000;
  }
  status(ready = true, error, recoveryFingerprint) {
    if (!ready && error === 'IMESSAGE_DATABASE_CHANGED' && !recoveryFingerprint) {
      const current = this.database.baseline();
      if (this.get('generation') !== current.generation) recoveryFingerprint = this.generationFingerprint(current.generation);
    }
    return this.transport('status', { ready, error, botAddress: this.config.botAddress, peer: this.config.peer,
      ...(recoveryFingerprint && { recoveryFingerprint }),
      lastInboundAt: Number(this.get('lastInboundAt') || 0), pendingInputs: this.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE body IS NOT NULL').get().n });
  }
  accept(row) {
    if (!Number.isSafeInteger(row.id) || row.id < 1) throw failure('INVALID_IMESSAGE_EVENT');
    if (row.id <= Number(this.get('cursor') || 0)) return;
    const candidate = row.chat_id === this.config.chatId && row.is_from_me === false && row.is_group === false &&
      normalizeMessageAddress(row.sender) === this.config.peer && !row.is_reaction && !row.poll && !row.balloon_bundle_id;
    let input;
    if (candidate) {
      if (typeof row.guid !== 'string' || !row.guid || row.guid.length > 256) throw failure('INVALID_IMESSAGE_EVENT');
      const created = Date.parse(row.created_at);
      if (!Number.isFinite(created)) throw failure('INVALID_IMESSAGE_EVENT');
      if (created >= Number(this.get('activatedAt'))) {
        if (this.get('generation') && this.database.baseline().generation !== this.get('generation')) throw failure('IMESSAGE_DATABASE_CHANGED');
        const record = this.database.inspect(row);
        if (!record) throw failure('IMESSAGE_RECORD_UNAVAILABLE');
        if (record.service === 'iMessage' && record.is_from_me === 0) {
          if (normalizeMessageAddress(record.destination_caller_id) !== this.config.botAddress) throw failure('IMESSAGE_ACCOUNT_MISMATCH');
          const text = row.text ?? '';
          if (typeof text !== 'string' || text.length > 16000) throw failure('IMESSAGE_TOO_LARGE');
          if (text.trim() || row.attachments?.length) input = { peer: this.config.peer, text, requestId: row.guid, sourceMessageId: row.guid, occurredAt: created, attachments: Boolean(row.attachments?.length) };
        }
      }
    }
    this.transaction(() => {
      if (input && !this.db.prepare('SELECT 1 FROM inbox WHERE guid=?').get(row.guid)) {
        if (this.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE body IS NOT NULL').get().n >= 256) throw failure('IMESSAGE_BACKPRESSURE');
        this.db.prepare('INSERT INTO inbox VALUES(?,?,?,?)').run(row.guid, row.id, JSON.stringify(input), this.now());
        this.set('lastInboundAt', this.now());
      }
      this.set('cursor', row.id);
    });
  }
  async updateReceipts() {
    const receipts = this.db.prepare("SELECT * FROM outbox WHERE guid IS NOT NULL AND state IN ('submitted','sent','delivered','unknown') AND checked_at<=? ORDER BY checked_at LIMIT 16").all(this.now() - 3000);
    if (receipts.length && this.get('generation') && this.database.baseline().generation !== this.get('generation')) throw failure('IMESSAGE_DATABASE_CHANGED');
    for (const r of receipts) {
      const record = this.database.inspect({ id: r.message_id, guid: r.guid });
      let state = r.state, error = null;
      if (record) {
        if (record.service !== 'iMessage' || normalizeMessageAddress(record.destination_caller_id) !== this.config.botAddress || record.is_from_me !== 1) { state = 'failed'; error = 'IMESSAGE_ACCOUNT_MISMATCH'; }
        else if (record.error) { state = 'failed'; error = 'IMESSAGE_SEND_FAILED'; }
        else if (record.is_read) state = 'read';
        else if (record.is_delivered) state = 'delivered';
        else if (record.is_sent) state = 'sent';
      }
      this.db.prepare('UPDATE outbox SET state=?, checked_at=?, error=? WHERE id=?').run(state, this.now(), error, r.id);
    }
    for (const r of this.db.prepare('SELECT * FROM outbox WHERE state<>\'sending\' AND (acked_state IS NULL OR acked_state<>state)').all()) {
      await this.transport('ack', { deliveryId: r.id, state: r.state, error: r.error });
      this.db.prepare('UPDATE outbox SET acked_state=? WHERE id=?').run(r.state, r.id);
    }
  }
  async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      if (this.now() >= this.nextCheck) { await this.prepare(); }
      await this.status();
      for (const r of this.db.prepare('SELECT guid,body FROM inbox WHERE body IS NOT NULL ORDER BY row_id').all()) {
        const result = await this.transport('inbound', JSON.parse(r.body));
        if (!result.accepted) throw failure('MESSAGE_NOT_BOUND');
        this.db.prepare('UPDATE inbox SET body=NULL WHERE guid=?').run(r.guid);
      }
      await this.updateReceipts();
      const { delivery } = await this.transport('poll', {});
      if (!delivery) return;
      if (delivery.peer !== this.config.peer || typeof delivery.id !== 'string' || delivery.id.length > 256 || typeof delivery.text !== 'string' || delivery.text.length > 20000) throw failure('INVALID_DELIVERY');
      if (this.db.prepare('SELECT 1 FROM outbox WHERE id=?').get(delivery.id)) return;
      await this.check();
      this.db.prepare("INSERT INTO outbox(id,state,at) VALUES(?,'sending',?)").run(delivery.id, this.now());
      let receipt;
      try { receipt = await this.send(delivery.text); } catch { /* Unknown sends are never repeated. */ }
      const known = typeof receipt?.guid === 'string' && receipt.guid.length > 0 && receipt.guid.length <= 256 && Number.isSafeInteger(receipt.id) && receipt.id > 0;
      this.db.prepare('UPDATE outbox SET state=?,guid=?,message_id=? WHERE id=?').run(known ? 'submitted' : 'unknown', known ? receipt.guid : null, known ? receipt.id : null, delivery.id);
    } catch (error) {
      if (String(error.code || '').startsWith('IMESSAGE_')) await this.status(false, error.code).catch(() => {});
      throw error;
    } finally { this.ticking = false; }
  }
  async watch(signal) {
    const args = ['watch', '--chat-id', String(this.config.chatId), '--json', '--attachments', '--debounce', '500ms',
      '--since-rowid', String(this.state.cursor), '--start', new Date(Number(this.get('activatedAt'))).toISOString()];
    const child = spawn(this.config.command, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], signal });
    let spawnError; child.on('error', () => { spawnError = true; });
    const lines = createInterface({ input: child.stdout });
    let lineBytes = 0;
    child.stdout.on('data', b => { lineBytes += b.length; if (lineBytes > 1024 * 1024) child.kill('SIGTERM'); if (b.includes(10)) lineBytes = b.length - b.lastIndexOf(10) - 1; });
    try {
      for await (const line of lines) {
        if (line.length > 65536) throw failure('IMESSAGE_TOO_LARGE');
        let row; try { row = JSON.parse(line); } catch { throw failure('INVALID_IMESSAGE_EVENT'); }
        this.accept(row);
      }
      if (!signal.aborted) throw failure(spawnError ? 'IMESSAGE_NOT_INSTALLED' : 'IMESSAGE_WATCH_STOPPED');
    } finally { lines.close(); child.kill('SIGTERM'); }
  }
}
