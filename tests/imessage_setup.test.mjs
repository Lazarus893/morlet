import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMessageChat, resolveMessageChat } from '../plugins/agent-hub/imessage.mjs';

const config = { command: '/fixture/imsg', chatId: 42, peer: 'owner@example.invalid', botAddress: 'bot@example.invalid' };
const directChat = { id: 42, service: 'iMessage', is_group: false, participants: [config.peer], last_addressed_handle: config.botAddress };

test('setup resolves one exact peer from bounded metadata and never reads message history', async () => {
  const input = { command: 'imsg', peer: config.peer };
  const execute = async (_command, args) => {
    assert.deepEqual(args, ['chats', '--limit', '100', '--json']);
    return { stdout: [directChat, { ...directChat, id: 43, participants: ['unrelated@example.invalid'] }].map(JSON.stringify).join('\n') };
  };
  assert.equal(await resolveMessageChat(input, { execute }), 42);
  assert.equal(await resolveMessageChat({ ...input, chatId: 99 }, { execute: () => assert.fail('explicit ID must skip discovery') }), 99);
  for (const [chats, code] of [
    [[], 'IMESSAGE_CHAT_NOT_FOUND'],
    [[{ ...directChat, service: 'SMS' }], 'IMESSAGE_CHAT_NOT_FOUND'],
    [[{ ...directChat, is_group: true }], 'IMESSAGE_CHAT_NOT_FOUND'],
    [[directChat, { ...directChat, id: 43 }], 'IMESSAGE_CHAT_AMBIGUOUS'],
  ]) await assert.rejects(resolveMessageChat(input, { execute: async () => ({ stdout: JSON.stringify(chats) }) }), { code });
  await assert.rejects(resolveMessageChat({ ...input, peer: 'invalid' }, { execute: () => assert.fail('invalid peer must not run') }), { code: 'INVALID_CONFIG' });
});

test('iMessage startup inspects only the selected chat identity without sending or reading history', async () => {
  const calls = [];
  await checkMessageChat(config, { execute: async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify(directChat) + '\n' };
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], config.command);
  assert.deepEqual(calls[0][1], ['group', '--chat-id', '42', '--json']);
  assert.ok(calls[0][2].timeout > 0);
});

test('iMessage startup rejects groups, SMS, and a different sender before enabling a connection', async () => {
  for (const [chat, code] of [
    [{ ...directChat, is_group: true }, 'IMESSAGE_DIRECT_CHAT_REQUIRED'],
    [{ ...directChat, participants: [config.peer, 'another@example.invalid'] }, 'IMESSAGE_DIRECT_CHAT_REQUIRED'],
    [{ ...directChat, service: 'SMS' }, 'IMESSAGE_SERVICE_REQUIRED'],
    [{ ...directChat, participants: ['another@example.invalid'] }, 'IMESSAGE_PEER_MISMATCH'],
    [{ ...directChat, last_addressed_handle: 'other@example.invalid' }, 'IMESSAGE_ACCOUNT_MISMATCH'],
    [null, 'IMESSAGE_DIRECT_CHAT_REQUIRED'],
  ]) {
    await assert.rejects(checkMessageChat(config, { execute: async () => ({ stdout: JSON.stringify(chat) }) }), { code });
  }
});

test('iMessage startup reports actionable permission or install errors without exposing native diagnostics', async () => {
  for (const [nativeCode, expected] of [['ENOENT', 'IMESSAGE_NOT_INSTALLED'], [1, 'IMESSAGE_CHAT_ACCESS_REQUIRED']]) {
    const execute = async () => { throw Object.assign(new Error('Private native diagnostic'), { code: nativeCode }); };
    await assert.rejects(checkMessageChat(config, { execute }), error => error.code === expected && !error.message.includes('Private'));
  }
  await assert.rejects(checkMessageChat(config, { execute: async () => ({ stdout: 'invalid JSON' }) }), { code: 'IMESSAGE_CHAT_ACCESS_REQUIRED' });
});

// Real SQLite, synthetic Messages metadata: no system database, UI, or sends.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMessageCompanion, loadMessageConfig } from '../plugins/agent-hub/imessage.mjs';
import { acquireMessageCompanionLock } from '../plugins/agent-hub/lock.mjs';

async function spoolFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pa-message-spool-'));
  const cfg = { ...config, database: join(root, 'messages.sqlite'), channelId: 'fixture-channel' };
  const db = new DatabaseSync(cfg.database);
  db.exec(`CREATE TABLE message (guid TEXT, service TEXT, is_from_me INTEGER, destination_caller_id TEXT,
    is_sent INTEGER DEFAULT 0,is_delivered INTEGER DEFAULT 0,is_read INTEGER DEFAULT 0,error INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER,message_id INTEGER);`);
  let now = Date.now(), nextId = 0, delivery = null, sends = 0, failInbound = false;
  const inbound = new Map(), acks = [], companions = new Set();
  const row = (overrides = {}, metadata = {}) => {
    const event = { id: ++nextId, guid: `message-${nextId}`, chat_id: cfg.chatId, sender: cfg.peer, is_from_me: false, is_group: false, text: 'same words', created_at: new Date(now).toISOString(), attachments: [], ...overrides };
    const record = { service: 'iMessage', is_from_me: Number(event.is_from_me), destination_caller_id: cfg.botAddress, ...metadata };
    db.prepare('INSERT INTO message(ROWID,guid,service,is_from_me,destination_caller_id) VALUES(?,?,?,?,?)').run(event.id, event.guid, record.service, record.is_from_me, record.destination_caller_id);
    db.prepare('INSERT INTO chat_message_join VALUES(?,?)').run(event.chat_id, event.id);
    return event;
  };
  row({ created_at: new Date(now - 1000).toISOString(), text: 'old history' });
  const options = { config: cfg, statePath: join(root, 'spool.sqlite'), now: () => now, check: async () => {},
    transport: async (operation, value) => {
      if (operation === 'inbound') {
        inbound.set(value.requestId, value);
        if (failInbound) throw new Error('response lost after Hub commit');
        return { accepted: true };
      }
      if (operation === 'ack') acks.push(value);
      if (operation === 'poll') { const result = { delivery }; delivery = null; return result; }
      return { accepted: true };
    },
    send: async () => { sends++; return row({ is_from_me: true }); },
  };
  function open(more = {}) { const c = new IMessageCompanion({ ...options, ...more }); companions.add(c); return c; }
  function close(c) { c.close(); companions.delete(c); }
  t.after(() => { for (const c of companions) c.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const c = open(); await c.prepare();
  return { root, cfg, db, c, row, open, close, inbound, acks, advance: ms => { now += ms; },
    deliver: (id = 'delivery-1') => { delivery = { id, text: 'reply', peer: cfg.peer }; },
    failInbound: value => { failInbound = value; }, sends: () => sends };
}

test('database recovery requires an exact owner request, rechecks identity, skips old inputs and never repeats a send', async t => {
  const f = await spoolFixture(t), oldGeneration = f.c.state.generation;
  f.deliver(); await f.c.tick(); assert.equal(f.sends(), 1);
  const baseline = f.c.database.baseline.bind(f.c.database);
  let generation = 'changed', authorized = false, checks = 0;
  f.c.database.baseline = () => ({ ...baseline(), generation });
  f.c.check = async () => { checks++; };
  const transport = f.c.transport;
  f.c.transport = async (op, input) => op === 'status' && input.error === 'IMESSAGE_DATABASE_CHANGED'
    ? { accepted: true, ...(authorized && { recovery: { id: 'confirmed', fingerprint: input.recoveryFingerprint } }) }
    : transport(op, input);
  await assert.rejects(f.c.prepare(), { code: 'IMESSAGE_DATABASE_CHANGED' });
  assert.equal(f.c.state.generation, oldGeneration);
  const history = f.row({ text: 'Before recovery' }); authorized = true;
  await f.c.prepare(); assert.equal(f.c.state.generation, generation); assert.ok(checks >= 3);
  f.c.accept(history); assert.equal(f.c.state.incoming.length, 0);
  f.deliver(); await f.c.tick(); assert.equal(f.sends(), 1);
  assert.equal(f.c.db.prepare('SELECT state FROM outbox').get().state, 'unknown');
  generation = 'changed-again'; f.c.check = async () => { throw Object.assign(new Error(), { code: 'IMESSAGE_ACCOUNT_MISMATCH' }); };
  await assert.rejects(f.c.prepare(), { code: 'IMESSAGE_ACCOUNT_MISMATCH' });
  assert.equal(f.c.state.generation, 'changed');
});

test('running bridge retains the recovery fingerprint across tick error reporting', async t => {
  const f = await spoolFixture(t), baseline = f.c.database.baseline.bind(f.c.database);
  f.c.database.baseline = () => ({ ...baseline(), generation: 'changed-while-running' });
  const statuses = [], transport = f.c.transport;
  let recovery;
  f.c.transport = async (op, input) => {
    if (op !== 'status') return transport(op, input);
    statuses.push(input);
    if (recovery && recovery.fingerprint !== input.recoveryFingerprint) recovery = undefined;
    return { accepted: true, ...(recovery && { recovery }) };
  };
  f.advance(16000);
  await assert.rejects(f.c.tick(), { code: 'IMESSAGE_DATABASE_CHANGED' });
  assert.ok(statuses.length >= 2, 'prepare and tick both report the blocked state');
  const fingerprint = statuses[0].recoveryFingerprint;
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(statuses.every(s => !s.ready && s.recoveryFingerprint === fingerprint));
  recovery = { id: 'owner-request', fingerprint };
  await f.c.tick();
  assert.equal(f.c.state.generation, 'changed-while-running');
  assert.equal(statuses.at(-1).ready, true);
  assert.equal(f.sends(), 0);
});

test('binding rejects self chat and missing bot identity before starting a bridge', t => {
  const root = mkdtempSync(join(tmpdir(), 'pa-message-config-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  for (const botAddress of [undefined, config.peer.toUpperCase()]) {
    writeFileSync(path, JSON.stringify({ ...config, botAddress }), { mode: 0o600 });
    assert.throws(() => loadMessageConfig(path), { code: 'IMESSAGE_IDENTITIES_REQUIRED' });
  }
});

test('durable input filters old history, outgoing, SMS, other chats, reactions and previews; GUID dedup preserves repeated text', async t => {
  const f = await spoolFixture(t); f.advance(10);
  const ignored = [
    f.row({ created_at: new Date(0).toISOString() }), f.row({ is_from_me: true }),
    f.row({}, { service: 'SMS' }), f.row({ sender: 'stranger@example.invalid' }),
    f.row({ is_reaction: true }), f.row({ poll: { kind: 'vote' } }),
    f.row({ balloon_bundle_id: 'com.apple.messages.URLBalloonProvider' }), f.row({ chat_id: 99 }),
  ];
  ignored.forEach(r => f.c.accept(r)); assert.equal(f.c.state.incoming.length, 0);
  const first = f.row(), second = f.row(); f.c.accept(first); f.c.accept(second);
  await f.c.tick(); assert.equal(f.inbound.size, 2); assert.equal(f.c.state.incoming.length, 0);
  f.c.accept(f.row({ guid: first.guid })); await f.c.tick(); assert.equal(f.inbound.size, 2);
  const mismatch = f.row({}, { destination_caller_id: 'other-bot@example.invalid' });
  const cursor = f.c.state.cursor;
  assert.throws(() => f.c.accept(mismatch), { code: 'IMESSAGE_ACCOUNT_MISMATCH' });
  assert.equal(f.c.state.cursor, cursor);
});

test('quiet restart retains the first cursor; response loss retries the durable input with the same GUID', async t => {
  const f = await spoolFixture(t); f.advance(100);
  const message = f.row(); f.close(f.c);
  const restarted = f.open(); await restarted.prepare();
  assert.equal(restarted.state.cursor, 1, 'restart must not reset to newest and lose offline input');
  restarted.accept(message); f.failInbound(true);
  await assert.rejects(restarted.tick(), /response lost/); f.close(restarted);
  const retry = f.open(); f.failInbound(false); await retry.tick();
  assert.equal(f.inbound.size, 1); assert.equal(retry.state.incoming.length, 0);
  assert.equal(retry.db.prepare('SELECT body FROM inbox WHERE guid=?').get(message.guid).body, null, 'acknowledged body is cleared while GUID evidence remains');
});

test('delivery state follows exact message metadata; CLI submission alone never means delivered', async t => {
  const f = await spoolFixture(t); f.deliver(); await f.c.tick();
  const receipt = f.c.db.prepare('SELECT * FROM outbox').get(); assert.equal(receipt.state, 'submitted');
  await f.c.tick(); assert.equal(f.acks.at(-1).state, 'submitted');
  for (const [column, expected] of [['is_sent', 'sent'], ['is_delivered', 'delivered'], ['is_read', 'read']]) {
    f.db.prepare(`UPDATE message SET ${column}=1 WHERE ROWID=?`).run(receipt.message_id);
    f.advance(4000); await f.c.tick(); assert.equal(f.acks.at(-1).state, expected);
  }
  assert.equal(f.sends(), 1);
  f.deliver('delivery-2'); await f.c.tick();
  const failed = f.c.db.prepare("SELECT * FROM outbox WHERE id='delivery-2'").get();
  f.db.prepare('UPDATE message SET error=22 WHERE ROWID=?').run(failed.message_id);
  await f.c.tick(); assert.equal(f.acks.at(-1).state, 'failed');
});

test('crash at sending and missing receipts become unknown and never resend', async t => {
  const f = await spoolFixture(t);
  f.c.db.prepare("INSERT INTO outbox(id,state,at) VALUES('crashed','sending',1)").run(); f.close(f.c);
  const restart = f.open({ send: async () => ({ status: 'sent' }) });
  f.deliver('crashed'); await restart.tick();
  assert.equal(restart.db.prepare("SELECT state FROM outbox WHERE id='crashed'").get().state, 'unknown');
  assert.equal(f.sends(), 0);
  f.deliver('missing-guid'); await restart.tick();
  assert.equal(restart.db.prepare("SELECT state FROM outbox WHERE id='missing-guid'").get().state, 'unknown');
});

test('inbox capacity rolls back cursor; database replacement and changed identity fail closed', async t => {
  const f = await spoolFixture(t);
  for (let i = 0; i < 256; i++) f.c.accept(f.row());
  const cursor = f.c.state.cursor;
  assert.throws(() => f.c.accept(f.row()), { code: 'IMESSAGE_BACKPRESSURE' }); assert.equal(f.c.state.cursor, cursor);
  f.c.database.baseline = () => ({ generation: 'replacement', cursor: 500 });
  await assert.rejects(f.c.prepare(), { code: 'IMESSAGE_DATABASE_CHANGED' });
  f.close(f.c);
  assert.throws(() => f.open({ config: { ...f.cfg, peer: 'different@example.invalid' } }), { code: 'IMESSAGE_BINDING_CHANGED' });
});

test('two copied configurations for the same Messages chat cannot acquire separate locks', async t => {
  const f = await spoolFixture(t), directory = join(f.root, 'locks');
  const release = acquireMessageCompanionLock(f.cfg, directory);
  try { assert.throws(() => acquireMessageCompanionLock({ ...f.cfg, channelId: 'copied-config' }, directory), { code: 'COMPANION_ALREADY_RUNNING' }); }
  finally { release(); }
  acquireMessageCompanionLock(f.cfg, directory)();
});
