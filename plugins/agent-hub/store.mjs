import { messageTimes, projectMessage, chronological, rootTasks, botExecution, routeId } from './projections.mjs';
import { botSnapshot, ensureBots, botEndpoint, resolveBot, mentionedBots, botSessionKey, continueBots, failIndependentParticipant, internalBotTurn, botMailbox, claimBotMessage, stopBotTask, botTaskRuns, BOT_PROTOCOL_VERSION } from './bots.mjs';
import { assertRoutineSourceAccess } from './routine-scope.mjs';
import { continuation, history, taskMessages, contextStatus, submissionContext, submissionSourceScope } from './continuity.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { hubConfig } from './config.mjs';
import { normalizeReport, excerpt, journalEvidence, runIssue, runIssueFingerprint, hasTerminalIssue, runProgress, sourceCoverage } from './reports.mjs';
import { validateHealth } from './readiness.mjs';
import { actionFingerprint, actionPreview, approvalText, requireAction } from './actions.mjs';

export const failure = code => Object.assign(new Error(code), { code });
const hash = text => createHash('sha256').update(text).digest('hex');
const json = value => JSON.stringify(value);
const parse = row => row ? JSON.parse(row.data) : null;
const id = () => randomUUID();
const live = new Set(['running', 'waiting_approval', 'uncertain', 'cancelling']);
const text = (value, max = 16000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw failure('INVALID_INPUT'); return value.trim(); };

/** One durable owner ledger, opened by both the Web host and channel processes. */
export class AgentHub {
  constructor(root, { now = Date.now } = {}) {
    const directory = join(root, '.runtime', 'hub');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.now = now; this.root = root;
    this.db = new DatabaseSync(join(directory, 'hub.sqlite'));
    chmodSync(join(directory, 'hub.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (job TEXT, seq INTEGER, digest TEXT NOT NULL, PRIMARY KEY(job,seq));`);
  }
  close() { this.db.close(); }
  get(kind, key) { return parse(this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, key)); }
  all(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(parse); }
  put(kind, row) { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, row.id, json(row)); return row; }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  receipt(key) { return parse(this.db.prepare('SELECT data FROM receipts WHERE id=?').get(key)); }
  once(key, fn) {
    return this.transaction(() => {
      const old = this.receipt(key);
      if (old) return old;
      const result = fn(); this.db.prepare('INSERT INTO receipts VALUES(?,?)').run(key, json(result)); return result;
    });
  }
  pair({ label, provider = 'codex' }) {
    if (!['codex', 'workbuddy'].includes(provider)) throw failure('INVALID_INPUT');
    const token = randomBytes(32).toString('base64url');
    const endpoint = this.put('endpoint', { id: id(), label: text(label, 80), provider, tokenHash: hash(token), createdAt: this.now(), lastSeen: 0, active: true });
    return { endpointId: endpoint.id, token };
  }
  registerHost(agent, token) {
    return this.transaction(() => {
      const old = this.get('endpoint', agent.id);
      if (old && (!old.hosted || old.tokenHash !== hash(token))) throw failure('ENDPOINT_CONFLICT');
      return this.put('endpoint', { ...old, id: agent.id, label: text(agent.label, 80), provider: agent.provider, hosted: true, tokenHash: hash(token), createdAt: old?.createdAt || this.now(), lastSeen: old?.lastSeen || 0, active: old?.active ?? true });
    });
  }
  resolveEndpoint(key) {
    const endpoints = this.all('endpoint').filter(e => e.active);
    const direct = endpoints.find(e => e.id === key);
    if (direct) return direct;
    const matches = endpoints.filter(e => e.label.toLowerCase() === String(key).toLowerCase());
    if (matches.length !== 1) throw failure('ENDPOINT_UNAVAILABLE');
    return matches[0];
  }
  selectEndpoint({ conversationId, endpointId }) {
    const endpoint = this.resolveEndpoint(endpointId);
    return this.put('conversation', { ...this.conversation(conversationId), endpointId: endpoint.id });
  }
  authenticate(token) {
    if (typeof token !== 'string' || token.length > 256) throw failure('BRIDGE_UNAUTHORIZED');
    const endpoint = this.all('endpoint').find(e => e.active && e.tokenHash === hash(token));
    if (!endpoint) throw failure('BRIDGE_UNAUTHORIZED'); return endpoint;
  }
  pairChannel({ label, peer, botAddress, conversationId }) {
    text(peer, 256); this.conversation(conversationId);
    const valid = value => typeof value === 'string' && value.length <= 256 && /^(?:\+[1-9]\d{6,14}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(value);
    if (!valid(peer) || !valid(botAddress) || peer.toLowerCase() === botAddress.toLowerCase()) throw failure('IMESSAGE_IDENTITIES_REQUIRED');
    peer = peer.toLowerCase(); botAddress = botAddress.toLowerCase();
    return this.transaction(() => {
      const previous = this.all('channelEndpoint').find(c => c.channel === 'imessage' && c.peer === peer && c.botAddress === botAddress);
      if (previous?.active) throw failure('IMESSAGE_ALREADY_BOUND');
      const token = randomBytes(32).toString('base64url');
      const c = this.put('channelEndpoint', { id: previous?.id || id(), label: text(label, 80), channel: 'imessage', peer, botAddress, tokenHash: hash(token), active: true, ready: false, lastSeen: 0 });
      const binding = this.bind({ channel: 'imessage', account: c.id, peer, conversationId });
      return { channelId: c.id, token, conversationId: binding.conversationId };
    });
  }
  pairDesktopPet({ label, petId, conversationId }) {
    if (typeof petId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(petId)) throw failure('INVALID_INPUT');
    this.conversation(conversationId);
    return this.transaction(() => {
      if (this.all('channelEndpoint').some(c => c.channel === 'desktop-pet' && c.peer === petId && c.active)) throw failure('PET_ALREADY_BOUND');
      const token = randomBytes(32).toString('base64url');
      const c = this.put('channelEndpoint', { id: id(), label: text(label, 80), channel: 'desktop-pet', peer: petId, tokenHash: hash(token), active: true, ready: false, lastSeen: 0 });
      const binding = this.bind({ channel: c.channel, account: c.id, peer: c.peer, conversationId });
      return { channelId: c.id, token, conversationId: binding.conversationId };
    });
  }
  authenticateChannel(token) {
    if (typeof token !== 'string' || token.length > 256) throw failure('BRIDGE_UNAUTHORIZED');
    const c = this.all('channelEndpoint').find(c => c.active && c.tokenHash === hash(token));
    if (!c) throw failure('BRIDGE_UNAUTHORIZED'); return c;
  }
  enablePetChat({ channelId, enabled }) {
    const c = this.get('channelEndpoint', channelId);
    if (!c?.active || c.channel !== 'desktop-pet' || typeof enabled !== 'boolean') throw failure('INVALID_INPUT');
    this.put('channelEndpoint', { ...c, chatEnabled: enabled });
    return { channelId: c.id, chatEnabled: enabled };
  }
  channelPoll(token) {
    const c = this.authenticateChannel(token);
    if (!c.ready || this.now() - c.lastSeen > 45000) return { delivery: null };
    const d = this.takeDelivery(c.channel, c.id, p => p === c.peer);
    return { delivery: d && { id: d.id, text: d.text, peer: c.peer } };
  }
  channelAck(token, { deliveryId, state, error }) {
    const c = this.authenticateChannel(token), d = this.get('delivery', deliveryId);
    const rank = { unknown: 0, submitted: 1, sent: 2, failed: 3, delivered: 4, read: 5 };
    if (!d || d.source.channel !== c.channel || d.source.account !== c.id || d.source.peer !== c.peer || !Object.hasOwn(rank, state) || d.state === 'pending') throw failure('FORBIDDEN');
    // A broadcast receipt proves submission to the pet host, not human reading.
    if (c.channel === 'desktop-pet' && !['unknown', 'submitted', 'failed'].includes(state)) throw failure('INVALID_INPUT');
    const databaseChanged = c.channel === 'imessage' && state === 'unknown' && error === 'IMESSAGE_DATABASE_CHANGED' && ['submitted', 'sent'].includes(d.state);
    if (databaseChanged || d.state === 'sending' || rank[state] > (rank[d.state] ?? -1)) this.put('delivery', { ...d, state, ...(databaseChanged && { error }), finishedAt: this.now() });
    return { accepted: true };
  }
  channelStatus(token, input) {
    const c = this.authenticateChannel(token);
    if (c.channel === 'desktop-pet') {
      if (Object.keys(input).some(k => !['ready', 'peer', 'error'].includes(k)) || typeof input.ready !== 'boolean' || input.peer !== c.peer || input.error && !['PET_OFFLINE', 'PET_UNAVAILABLE', 'PET_BRIDGE_STOPPED'].includes(input.error)) throw failure('INVALID_INPUT');
      this.put('channelEndpoint', { ...c, ready: input.ready, error: input.ready ? null : input.error || 'PET_OFFLINE', lastSeen: this.now() });
      return { accepted: true };
    }
    const errors = new Set(['IMESSAGE_CHAT_ACCESS_REQUIRED', 'IMESSAGE_ACCOUNT_MISMATCH', 'IMESSAGE_DATABASE_CHANGED', 'IMESSAGE_BINDING_CHANGED', 'IMESSAGE_STATE_INVALID', 'IMESSAGE_BACKPRESSURE', 'IMESSAGE_CHAT_NOT_FOUND', 'IMESSAGE_PEER_MISMATCH', 'IMESSAGE_DIRECT_CHAT_REQUIRED', 'IMESSAGE_SERVICE_REQUIRED', 'IMESSAGE_RECORD_UNAVAILABLE', 'IMESSAGE_TOO_LARGE', 'IMESSAGE_WATCH_STOPPED', 'IMESSAGE_NOT_INSTALLED', 'IMESSAGE_SETUP_REQUIRED', 'IMESSAGE_BRIDGE_STOPPED']);
    if (typeof input.ready !== 'boolean' || input.botAddress !== c.botAddress || input.peer !== c.peer || input.error && !errors.has(input.error) || !Number.isSafeInteger(input.lastInboundAt) || input.lastInboundAt < 0 || input.lastInboundAt > this.now() + 60000 || !Number.isSafeInteger(input.pendingInputs) || input.pendingInputs < 0 || input.pendingInputs > 256) throw failure('INVALID_INPUT');
    if (input.recoveryFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(input.recoveryFingerprint)) throw failure('INVALID_INPUT');
    const recoveryFingerprint = !input.ready && input.error === 'IMESSAGE_DATABASE_CHANGED' ? input.recoveryFingerprint || null : null;
    const recovery = c.recovery && c.recovery.expiresAt > this.now() && c.recovery.fingerprint === recoveryFingerprint ? c.recovery : null;
    this.put('channelEndpoint', { ...c, ready: input.ready, error: input.ready ? null : input.error || 'IMESSAGE_SETUP_REQUIRED', lastSeen: this.now(), lastInboundAt: input.lastInboundAt, pendingInputs: input.pendingInputs, recoveryFingerprint, recovery });
    return { accepted: true, ...(recovery && { recovery }) };
  }
  recoverChannel({ channelId, fingerprint }) {
    return this.transaction(() => {
      const c = this.get('channelEndpoint', channelId);
      if (!c?.active || c.channel !== 'imessage' || c.ready || c.error !== 'IMESSAGE_DATABASE_CHANGED' || this.now() - c.lastSeen > 45000 || !fingerprint || fingerprint !== c.recoveryFingerprint) throw failure('IMESSAGE_RECOVERY_STALE');
      if (c.pendingInputs) throw failure('IMESSAGE_RECOVERY_PENDING_INPUTS');
      const recovery = c.recovery?.expiresAt > this.now() ? c.recovery : { id: id(), fingerprint, expiresAt: this.now() + 5 * 60000 };
      this.put('channelEndpoint', { ...c, recovery });
      return { requested: true, channelId, expiresAt: recovery.expiresAt };
    });
  }
  revoke(endpointId) {
    return this.transaction(() => {
      const endpoint = this.get('endpoint', endpointId); if (!endpoint) throw failure('ITEM_NOT_FOUND');
      this.put('endpoint', { ...endpoint, active: false });
      for (const run of this.all('run').filter(r => r.endpointId === endpointId && (live.has(r.status) || r.status === 'queued'))) this.cancelRun(run);
      return { revoked: true };
    });
  }
  newConversation({ endpointId = hubConfig(this.root).roles.conversation, botId, title = '新的对话' } = {}) {
    if (botId) endpointId = resolveBot(this, botId).endpoint.id;
    const endpoint = this.get('endpoint', endpointId); if (!endpoint?.active) throw failure('ENDPOINT_UNAVAILABLE');
    return this.put('conversation', { id: id(), ownerId: 'owner', endpointId, ...(botId && { botId }), title: text(title, 80), titleOrigin: ['新的对话', '新的一页'].includes(title) ? 'message' : 'explicit', createdAt: this.now() });
  }
  openRoom({ kind = 'direct', botId = 'xiaoman' } = {}) {
    if (!['direct', 'group'].includes(kind) || kind === 'group' && botId !== 'xiaoman') throw failure('INVALID_INPUT');
    return this.transaction(() => {
      const bots = ensureBots(this), bot = bots.find(bot => bot.id === botId && bot.active);
      if (!bot) throw failure('BOT_UNAVAILABLE');
      const roomKey = kind === 'group' ? 'owner:group:all' : 'owner:direct:' + bot.id;
      const existing = this.all('conversation').find(c => c.roomKey === roomKey);
      if (existing) return this.roomView(existing);
      const excluded = new Set([
        ...this.all('binding').map(row => row.conversationId), ...this.all('firstTask').map(row => row.conversationId),
        ...this.all('routine').map(row => row.conversationId),
        ...this.all('run').filter(run => run.firstTaskId || run.routine || run.source?.channel !== 'web').map(run => run.conversationId),
        ...this.all('message').filter(message => message.source?.channel !== 'web').map(message => message.conversationId),
      ]);
      const messages = this.all('message');
      const recent = c => messages.findLast(m => m.conversationId === c.id && m.role === 'user')?.createdAt ?? c.createdAt;
      // Old IDs remain intact. Only one eligible owner conversation is claimed;
      // other histories are not merged into the Bot's model context.
      const candidate = kind === 'direct' && this.all('conversation').filter(c => c.ownerId === 'owner' && !c.roomKey && !c.sourceScope && !excluded.has(c.id) && c.botId === bot.id).sort((a, b) => recent(b) - recent(a))[0];
      const conversation = this.put('conversation', { ...(candidate || { id: id(), ownerId: 'owner', createdAt: this.now() }),
        roomKey, roomKind: kind, botId: bot.id, endpointId: botEndpoint(this, bot)?.id || null,
        title: kind === 'group' ? '全员群' : bot.name, titleOrigin: 'room' });
      return this.roomView(conversation);
    });
  }
  roomView(conversation) {
    return { ...conversation, kind: conversation.roomKind,
      title: conversation.roomKind === 'group' ? '全员群' : this.get('bot', conversation.botId)?.name || conversation.title,
      memberBotIds: conversation.roomKind === 'group' ? this.all('bot').filter(bot => bot.active).map(bot => bot.id) : [conversation.botId],
      context: contextStatus(this, conversation) };
  }
  resetContext(conversationId) {
    return this.transaction(() => {
      const conversation = this.conversation(conversationId);
      this.put('conversation', { ...conversation, contextEpoch: id(), contextStartMessageId: null, contextReset: true, lastUserAt: null });
      return { conversationId, reset: true };
    });
  }
  bind({ channel, account, peer, conversationId }) {
    if (!['weixin', 'imessage', 'desktop-pet'].includes(channel)) throw failure('INVALID_INPUT');
    text(account, 256); text(peer, 256);
    const key = hash(json([channel, account, peer]));
    return this.transaction(() => {
      const previous = this.get('binding', key);
      if (previous?.ownerVerified) return previous;
      let conversation = this.conversation(conversationId);
      const conflicts = conversation => conversation.sourceScope && conversation.sourceScope !== key ||
        this.all('binding').some(binding => binding.conversationId === conversation.id && binding.id !== key) ||
        this.all('message').some(message => message.conversationId === conversation.id && message.source?.channel !== 'web' && hash(json([message.source.channel, message.source.account, message.source.peer])) !== key);
      if (conversation.roomKey || conflicts(conversation)) {
        conversation = this.all('conversation').find(c => c.sourceScope === key && !conflicts(c)) || this.put('conversation', {
          id: id(), ownerId: 'owner', endpointId: conversation.endpointId, botId: 'xiaoman',
          title: { weixin: '微信', imessage: 'iMessage', 'desktop-pet': '桌宠' }[channel], titleOrigin: 'channel', createdAt: this.now(), sourceScope: key,
        });
      }
      this.put('conversation', { ...conversation, sourceScope: key });
      return this.put('binding', { id: key, channel, account, peer, conversationId: conversation.id, ownerId: 'owner' });
    });
  }
  binding(channel, account, peer) { return this.get('binding', hash(json([channel, account, peer]))); }
  conversation(key) { const c = this.get('conversation', key); if (!c) throw failure('ITEM_NOT_FOUND'); return c; }
  message(conversationId, role, content, source, runId) {
    const receivedAt = this.now(), row = this.put('message', { id: id(), conversationId, role, text: content, source, runId,
      endpointId: runId ? this.get('run', runId)?.endpointId : undefined, botId: runId ? this.get('run', runId)?.botId : undefined,
      createdAt: receivedAt, ...messageTimes(role === 'user' ? source : null, receivedAt) });
    return this.put('message', { ...row, appendSeq: Number(this.db.prepare("SELECT rowid FROM records WHERE kind='message' AND id=?").get(row.id).rowid) });
  }
  resolveConversationId(conversationId) {
    if (typeof conversationId !== 'string') return conversationId;
    return this.get('conversationAlias', conversationId)?.canonicalConversationId || conversationId;
  }
  conversationIds(conversationId) {
    const canonical = this.resolveConversationId(conversationId);
    return [canonical, ...this.all('conversationAlias').filter(alias => alias.canonicalConversationId === canonical).map(alias => alias.id)];
  }
  verifyOwnerRoute(bindingId, verified = true) {
    const binding = this.get('binding', bindingId);
    if (!binding) throw failure('ITEM_NOT_FOUND');
    if (verified && binding.ownerVerified) return binding;
    if (!verified && !binding.ownerVerified) return binding;
    const original = this.conversation(binding.conversationId), rooms = this.all('conversation').filter(c => ['direct', 'group'].includes(c.roomKind));
    const affected = new Set([original.id, ...rooms.map(c => c.id)]);
    if (this.all('run').some(run => affected.has(run.conversationId) && (live.has(run.status) || run.status === 'queued'))) throw failure('OWNER_ROUTE_BUSY');
    // The owner action identifies a route, never guesses an identity from names.
    // Refuse ambiguous legacy inboxes instead of importing another person's text.
    if (verified && this.all('message').some(m => m.conversationId === original.id && m.source?.channel !== 'web' && routeId(m.source) !== binding.id)) throw failure('OWNER_ROUTE_MIXED');
    const directory = join(this.root, '.runtime/hub/identity-backups'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const backupPath = join(directory, id() + '.sqlite');
    this.db.exec("VACUUM INTO '" + backupPath.replaceAll("'", "''") + "'"); chmodSync(backupPath, 0o600);
    return this.transaction(() => {
      if (this.all('run').some(run => affected.has(run.conversationId) && (live.has(run.status) || run.status === 'queued'))) throw failure('OWNER_ROUTE_BUSY');
      const canonical = verified ? this.openRoom({ botId: 'xiaoman' }) : this.put('conversation', { id: id(), ownerId: 'owner', botId: 'xiaoman', endpointId: original.endpointId,
        title: binding.channel, titleOrigin: 'channel', sourceScope: binding.id, createdAt: this.now() });
      if (verified && original.id !== canonical.id && !original.roomKey) this.put('conversationAlias', { id: original.id, canonicalConversationId: canonical.id, ownerIdentityId: 'owner', routeId: binding.id, createdAt: this.now() });
      // Start one shared future epoch; never resume an opaque old route session.
      const history = this.all('message').filter(m => this.conversationIds(canonical.id).includes(m.conversationId) && m.role === 'user');
      this.put('conversation', { ...this.conversation(canonical.id), contextEpoch: id(), contextStartMessageId: null, contextReset: false, lastUserAt: history.at(-1)?.createdAt || null });
      const next = this.put('binding', { ...binding, conversationId: canonical.id, ownerVerified: verified, ownerIdentityId: verified ? 'owner' : null, verifiedAt: verified ? this.now() : null });
      this.put('identityMigration', { id: id(), bindingId, verified, backupPath, messageCount: this.all('message').length, runCount: this.all('run').length, createdAt: this.now() });
      return next;
    });
  }
  messageById(messageId) {
    const message = this.get('message', messageId);
    if (!message || this.get('conversation', message.conversationId)?.ownerId !== 'owner') throw failure('ITEM_NOT_FOUND');
    return { conversation: this.roomView(this.conversation(this.resolveConversationId(message.conversationId))), message: projectMessage(this, message), conversationId: message.conversationId, resolvedConversationId: this.resolveConversationId(message.conversationId) };
  }
  reply(conversationId, content, source, runId) {
    const m = this.message(conversationId, 'assistant', content, source, runId);
    if (source.channel !== 'web') this.put('delivery', { id: m.id, messageId: m.id, conversationId, source, text: m.botId && m.botId !== 'xiaoman' ? `${this.get('bot', m.botId)?.name || 'Bot'}：\n${content}` : content, state: 'pending', createdAt: this.now() });
    return m;
  }
  submit({ conversationId, content, endpointId, botId, source = { channel: 'web' }, requestId, replyContext, journalItemId, attachmentId, referenceKey }) {
    text(requestId, 256); text(content);
    if (!['web', 'weixin', 'imessage', 'desktop-pet'].includes(source.channel)) throw failure('INVALID_INPUT');
    const key = hash(json([source.channel, source.account || '', source.peer || '', requestId]));
    const ownerBinding = source.channel !== 'web' && this.binding(source.channel, source.account, source.peer);
    const mentions = mentionedBots(this, content);
    return this.transaction(() => {
      const old = this.receipt('message:' + key);
      if (ownerBinding?.ownerVerified) {
        // Dedupe an accepted event before applying today's routing policy. Its
        // original room and return route are immutable even after an upgrade.
        conversationId = old ? this.resolveConversationId(old.message.conversationId) : mentions.length === 1
          ? this.openRoom({ kind: 'direct', botId: mentions[0] }).id : this.openRoom({ kind: 'group' }).id;
      } else if (source.channel === 'web') conversationId = this.resolveConversationId(conversationId);
      if (old && ((old.requestedBotId || undefined) !== botId || this.resolveConversationId(old.message.conversationId) !== conversationId || old.message.text !== content || endpointId && old.run.endpointId !== endpointId || (old.run.attachmentIds?.[0] || null) !== (attachmentId || null) || (old.run.journalItemId || null) !== (journalItemId || null) || (old.run.referenceKey || null) !== (referenceKey || null))) throw failure('CONFLICT');
      return this.once('message:' + key, () => {
        const c = this.conversation(conversationId);
        if (source.channel !== 'web' && !ownerBinding?.ownerVerified && (c.roomKey || c.sourceScope && c.sourceScope !== hash(json([source.channel, source.account, source.peer])))) throw failure('FORBIDDEN');
        const selectedBotId = mentions[0] || botId || (endpointId ? null : c.botId);
        const selectedBot = selectedBotId ? resolveBot(this, selectedBotId) : null;
        const endpoint = selectedBot?.endpoint || this.resolveEndpoint(endpointId || c.endpointId);
        const runId = id();
        const message = this.message(c.id, 'user', content, { ...source, ...(source.channel !== 'web' && { sourceMessageId: source.sourceMessageId || requestId }) }, runId);
        message.endpointId = endpoint.id; message.botId = selectedBot?.bot.id; this.put('message', message);
        const context = submissionContext(this, c, message);
        const ownerRoom = ['direct', 'group'].includes(c.roomKind) && (source.channel === 'web' || ownerBinding?.ownerVerified);
        const sourceScope = ownerRoom ? null : submissionSourceScope(this, c, source, journalItemId);
        const run = this.put('run', { id: runId, ...(referenceKey && { referenceKey }), ...(ownerRoom && { ownerIdentityId: 'owner', roomKind: c.roomKind }), journalItemBound: Boolean(journalItemId), contextEpoch: context.contextEpoch, contextStartMessageId: context.contextStartMessageId,
          ...(sourceScope && { sourceScope }),
          ...(selectedBot && { botId: selectedBot.bot.id, botVersion: selectedBot.bot.version, availableBotIds: this.all('bot').filter(bot => bot.active).map(bot => bot.id), botVersions: Object.fromEntries([...new Set([selectedBot.bot.id, ...mentions])].map(id => [id, this.get('bot', id).version])), pendingBotIds: mentions.slice(1), explicitMentions: mentions.length > 0 }), ...(attachmentId && { attachmentIds: [attachmentId] }), ...(journalItemId && { journalItemId }), conversationId: c.id, endpointId: endpoint.id, messageId: message.id, title: excerpt(content, 100), prompt: content, source, ...(replyContext && { replyContext }), status: 'queued', seq: 0, createdAt: this.now() });
        this.put('conversation', { ...c, ...context, ...(c.title === '新的对话' && { title: content.slice(0, 36) }) });
        return { message, run, ...(botId && { requestedBotId: botId }) };
      });
    });
  }
  // Internal scheduler entry: background work is not a user message and never
  // inherits an external return route. The Routine ledger owns each occurrence.
  submitRoutine({ routine, occurrenceId, scheduledAt, prompt }) {
    return this.once('routine-job:' + text(occurrenceId, 128), () => {
      const current = this.get('routine', routine.id), conversation = this.conversation(routine.conversationId);
      if (!current?.enabled || current.version !== routine.version || conversation.ownerId !== 'owner' || !routine.journalItemId) throw failure('FORBIDDEN');
      const selectedBot = routine.botId ? resolveBot(this, routine.botId) : null;
      const endpoint = selectedBot?.endpoint || this.resolveEndpoint(routine.endpointId);
      const run = this.put('run', { id: id(), ...(selectedBot && { botId: selectedBot.bot.id, botVersion: selectedBot.bot.version }), conversationId: conversation.id, journalItemId: routine.journalItemId, endpointId: endpoint.id,
        messageId: null, title: routine.title, prompt: text(prompt), source: { channel: 'web', origin: 'routine' },
        routine: { id: routine.id, version: routine.version, occurrenceId, scheduledAt, trigger: routine.trigger, scope: routine.scope || { publicWeb: true, sources: [] } },
        routinePublished: false, status: 'queued', seq: 0, createdAt: this.now() });
      return { run };
    });
  }
  cancelRun(run, confirmStopped = false) {
    if (!run) return;
    const active = botTaskRuns(this, run).filter(r => live.has(r.status) || r.status === 'queued');
    if (!active.length) return;
    stopBotTask(this, run, 'CANCELLED');
    for (const member of active) {
      this.put('run', { ...this.get('run', member.id), status: member.status === 'queued' || confirmStopped && member.id === run.id ? 'cancelled' : 'cancelling', ...(member.status === 'queued' || confirmStopped && member.id === run.id ? { finishedAt: this.now() } : {}) });
      for (const a of this.all('approval').filter(a => a.runId === member.id && ['pending', 'deferred'].includes(a.state))) this.put('approval', { ...a, state: 'rejected' });
    }
  }
  cancel(runId, confirmStopped = false) { return this.transaction(() => { const run = this.get('run', runId); if (!run) throw failure('ITEM_NOT_FOUND'); this.cancelRun(run, confirmStopped && ['uncertain', 'cancelling'].includes(run.status)); return this.get('run', runId); }); }
  decide({ approvalId, allow, decision, fingerprint, conversationId, scope = 'once', minutes }) {
    decision ||= typeof allow === 'boolean' ? allow ? 'approve' : 'reject' : null;
    if (!['approve', 'reject', 'defer', 'accept_limit'].includes(decision) || !['once', 'minutes', 'session'].includes(scope)) throw failure('INVALID_INPUT');
    return this.transaction(() => {
      const a = this.get('approval', approvalId), run = a && this.get('run', a.runId);
      if (!a || conversationId && a.conversationId !== conversationId) throw failure('ITEM_NOT_FOUND');
      if (!['pending', 'deferred'].includes(a.state) || !live.has(run?.status) || run.status === 'cancelling' || a.expiresAt <= this.now() || fingerprint && fingerprint !== a.action?.fingerprint) throw failure('CONFLICT');
      if (decision === 'defer') {
        this.put('approval', { ...a, state: 'deferred', expiresAt: Math.min(a.createdAt + 15 * 60000, this.now() + 4 * 60000) });
        return { decided: true, state: 'deferred' };
      }
      if (decision === 'approve' && !a.action?.approvable) throw failure('ACTION_UNSUPPORTED');
      // Native one-shot callbacks cannot honor durable grants. Do not pretend a
      // provider's tool-wide permission is an exact-parameter life-action grant.
      if (scope !== 'once') throw failure('APPROVAL_SCOPE_UNSUPPORTED');
      const state = decision === 'approve' ? 'accepted' : decision === 'accept_limit' ? 'limited' : 'rejected';
      this.put('approval', { ...a, state, decisionAt: this.now(), scope });
      const other = this.all('approval').some(x => x.runId === run.id && x.id !== a.id && ['pending', 'deferred'].includes(x.state));
      this.put('run', { ...run, status: other ? 'waiting_approval' : 'running' }); return { decided: true, state };
    });
  }
  expire() {
    for (const run of this.all('run')) if (['running', 'waiting_approval'].includes(run.status) && this.now() - run.heartbeat > 45000) this.put('run', { ...run, status: 'uncertain' });
    for (const a of this.all('approval')) if (['pending', 'deferred'].includes(a.state) && a.expiresAt <= this.now()) {
      this.put('approval', { ...a, state: 'expired' });
      const run = this.get('run', a.runId);
      if (run?.status === 'waiting_approval' && !this.all('approval').some(x => x.runId === run.id && ['pending', 'deferred'].includes(x.state))) this.put('run', { ...run, status: 'running' });
    }
    for (const d of this.all('delivery')) if (d.state === 'sending' && this.now() - d.startedAt > 60000) this.put('delivery', { ...d, state: 'unknown' });
  }
  poll(token, { runnerId, active = null, claim = true, provider, label, health, routineGuardVersion, capacity = 1 } = {}) {
    text(runnerId, 100);
    return this.transaction(() => {
      const endpoint = this.authenticate(token);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4) throw failure('INVALID_INPUT');
      if (provider && provider !== endpoint.provider) throw failure('INVALID_INPUT');
      this.put('endpoint', { ...endpoint, lastSeen: this.now(), maxParallelRuns: capacity, routineGuardVersion: routineGuardVersion === 1 ? 1 : 0, ...(label ? { localLabel: text(label, 80) } : {}), ...(health ? { health: validateHealth(health, this.now()), ...(health.authentication === 'verified' ? { authenticationVerifiedAt: health.checkedAt, authenticationFailureAt: null } : health.authentication === 'required' ? { authenticationFailureAt: health.checkedAt } : {}) } : {}) });
      this.expire();
      let current = active && this.get('run', active.id);
      const matches = current && current.endpointId === endpoint.id && current.lease === active.lease && current.runnerId === runnerId;
      if (matches && current.routine && live.has(current.status)) {
        try {
          if (routineGuardVersion !== 1) throw failure('ROUTINE_SCOPE_UNSUPPORTED');
          assertRoutineSourceAccess(this, current, { operation: 'list' });
        } catch (cause) {
          current = this.put('run', { ...current, error: cause.code || 'ROUTINE_UNAVAILABLE' });
          this.cancelRun(current);
        }
      }
      if (matches && live.has(current.status)) {
        current = this.get('run', current.id);
        current = this.put('run', { ...current, heartbeat: this.now(), status: current.status === 'uncertain' ? 'running' : current.status });
      }
      if (active) return { active: matches ? { id: current.id, status: current.status, seq: current.seq } : { id: active.id, status: 'cancelled' }, approvals: matches ? this.all('approval').filter(a => a.runId === current.id) : [] };
      if (!claim) return { job: null };
      const runs = this.all('run');
      // Never reassign an execution whose outcome is unknown. A later explicit
      // cancellation fences its lease, including late results and approvals.
      if (runs.filter(r => r.endpointId === endpoint.id && live.has(r.status)).length >= capacity) return { job: null };
      const order = new Map(runs.map((r, i) => [r.id, i]));
      const taskTime = r => order.get(r.rootRunId || r.id) ?? order.get(r.id);
      const candidate = runs.filter(r => r.endpointId === endpoint.id && r.status === 'queued' && !runs.some(other => {
        if (live.has(other.status) && botSessionKey(other) === botSessionKey(r)) return true;
        if (other.conversationId !== r.conversationId) return false;
        const sameRoot = (other.rootRunId || other.id) === (r.rootRunId || r.id);
        const independent = sameRoot && this.get('run', r.rootRunId || r.id)?.groupPlan?.mode === 'parallel' && r.botPhase === 'participant' && other.botPhase === 'participant';
        return live.has(other.status) && !independent || other.status === 'queued' && taskTime(other) < taskTime(r);
      })).sort((a, b) => taskTime(a) - taskTime(b) || a.createdAt - b.createdAt)[0];
      if (!candidate) return { job: null };
      if (candidate.botId) {
        const bot = this.get('bot', candidate.botId);
        if (!bot?.active || bot.version !== candidate.botVersion || this.get('run', candidate.rootRunId || candidate.id)?.botTaskStopped) {
          stopBotTask(this, candidate, 'BOT_CHANGED');
          this.put('run', { ...candidate, status: 'failed', error: 'BOT_CHANGED', finishedAt: this.now() });
          if (candidate.routine) this.reconcileRoutineRun?.(candidate.id);
          else this.reply(candidate.conversationId, 'Bot 的设置已变化，请核对后重新交代。', candidate.source, candidate.id);
          return { job: null };
        }
      }
      if (candidate.routine) {
        try {
          if (routineGuardVersion !== 1) throw failure('ROUTINE_SCOPE_UNSUPPORTED');
          assertRoutineSourceAccess(this, candidate, { operation: 'list' });
        } catch (cause) {
          this.put('run', { ...candidate, status: 'failed', error: cause.code || 'ROUTINE_UNAVAILABLE', finishedAt: this.now() });
          this.reconcileRoutineRun?.(candidate.id);
          return { job: null };
        }
      }
      claimBotMessage(this, candidate);
      const sourceScope = candidate.sourceScope || submissionSourceScope(this, this.conversation(candidate.conversationId), candidate.source, candidate.journalItemId);
      const job = this.put('run', { ...candidate, ...(sourceScope && { sourceScope }), status: 'running', runnerId, lease: id(), heartbeat: this.now(), startedAt: this.now() });
      const savedSession = this.get('session', botSessionKey(job));
      const lastSessionRun = savedSession?.lastRunId && this.get('run', savedSession.lastRunId);
      const session = lastSessionRun && taskTime(lastSessionRun) > taskTime(job) ? null : savedSession;
      // Shared context is bounded and attributed; native sessions remain independent.
      let remaining = 16000;
      const context = taskMessages(this, job).filter(m => m.id !== job.messageId && (job.botId ? m.botId !== job.botId : m.endpointId !== endpoint.id)).slice(-24).reverse().map(m => {
        const content = m.text.slice(0, Math.min(4000, remaining)); remaining -= content.length;
        // Background notices belong to the conversation without an Agent endpoint.
        const endpoint = m.endpointId ? this.get('endpoint', m.endpointId) : null;
        return { role: m.role, agent: (m.botId && this.get('bot', m.botId)?.name) || endpoint?.label || this.get('bot', 'xiaoman')?.name || 'Mori', text: content };
      }).filter(m => m.text).reverse();
      // Return routing credentials belong only to the channel process.
      return { job: { ...job, ...(job.botId && { bot: this.get('bot', job.botId), botMessages: botMailbox(this, job), botFinalReporter: !internalBotTurn(this, job), groupParticipationOnly: Boolean(this.get('run', job.rootRunId || job.id)?.groupPlan?.participationOnly), sessionBotProtocolVersion: session?.botProtocolVersion || 0 }), source: { channel: job.source.channel }, sessionId: job.routine ? null : session?.nativeSessionId || null, sessionTools: job.routine ? [] : session?.tools || [], context: job.routine ? [] : context, continuation: job.routine ? null : continuation(this, job), provider: endpoint.provider } };
    });
  }
  event(token, { runId, lease, seq, type, value }) {
    return this.transaction(() => {
      const endpoint = this.authenticate(token), run = this.get('run', runId);
      if (!run || run.endpointId !== endpoint.id || run.lease !== lease) throw failure('FORBIDDEN');
      const digest = hash(json([type, value]));
      const old = this.db.prepare('SELECT digest FROM events WHERE job=? AND seq=?').get(runId, seq);
      if (old) { if (old.digest !== digest) throw failure('CONFLICT'); return { accepted: true, duplicate: true }; }
      if (!live.has(run.status)) return { accepted: false, status: run.status };
      if (!Number.isSafeInteger(seq) || seq !== run.seq + 1) throw failure('EVENT_ORDER');
      if (run.status === 'cancelling' && !['stopped', 'uncertain'].includes(type)) {
        this.put('run', { ...run, seq });
        this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(runId, seq, digest);
        return { accepted: true, ignored: true, status: 'cancelling' };
      }
      if (type === 'stopped') { run.status = 'cancelled'; run.finishedAt = this.now(); }
      else if (type === 'session') {
        if (run.routine) run.nativeSessionId = text(value, 200);
        else this.put('session', { id: botSessionKey(run), conversationId: run.conversationId, endpointId: endpoint.id, lastRunId: run.id, nativeSessionId: text(value, 200) });
      }
      else if (type === 'activity') {
        if (!value || Object.keys(value).some(k => !['kind', 'phase'].includes(k)) || !['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'agentMessage'].includes(value.kind) || !['started', 'completed'].includes(value.phase)) throw failure('INVALID_INPUT');
        run.nativeActivity = { ...value, observedAt: this.now() };
      }
      else if (type === 'source_receipt') {
        if (!value || Object.keys(value).some(key => !['tool', 'source', 'status', 'observedAt'].includes(key)) ||
            !['web_fetch', 'web_search'].includes(value.tool) || !['completed', 'incomplete', 'failed'].includes(value.status) ||
            !Number.isSafeInteger(value.observedAt) || value.observedAt < run.createdAt - 300000 || value.observedAt > this.now() + 300000) throw failure('INVALID_INPUT');
        let source = text(value.source, 2048);
        if (value.tool === 'web_fetch') {
          let url; try { url = new URL(source); } catch { throw failure('INVALID_INPUT'); }
          if (!/^https?:\/\//i.test(source) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\s\\]/.test(source)) throw failure('INVALID_INPUT');
          url.hash = ''; source = url.href;
          if (source.length > 2048) throw failure('INVALID_INPUT');
        } else {
          if (!source.startsWith('search:') || !source.slice(7).trim() || source.length > 1007 || /[\x00-\x1f]/.test(source)) throw failure('INVALID_INPUT');
          source = 'search:' + source.slice(7).trim();
        }
        // A real adapter receipt, bound to this lease and ordered event stream.
        // A successful re-read replaces a failed/partial read of the same source;
        // model tool arguments never write this record kind.
        this.put('nativeSourceReceipt', { id: hash(json([runId, source])), runId, tool: value.tool, source,
          status: value.status, observedAt: value.observedAt, receivedAt: this.now(), seq });
      }
      else if (type === 'capabilities') {
        if (value.botProtocolVersion !== undefined && value.botProtocolVersion !== BOT_PROTOCOL_VERSION) throw failure('INVALID_INPUT');
        if (!Array.isArray(value.tools) || value.tools.length > 40 || value.tools.some(t => typeof t !== 'string' || !/^xiaoman_[a-z_]+$/.test(t))) throw failure('INVALID_INPUT');
        const key = botSessionKey(run), session = this.get('session', key);
        if (run.routine) {
          if (run.nativeSessionId !== value.sessionId) throw failure('FORBIDDEN');
          run.nativeTools = [...new Set(value.tools)];
        } else {
          if (!session || session.nativeSessionId !== value.sessionId) throw failure('FORBIDDEN');
          this.put('session', { ...session, tools: [...new Set(value.tools)], ...(value.botProtocolVersion && { botProtocolVersion: value.botProtocolVersion }), toolsCheckedAt: this.now() });
        }
        this.put('endpoint', { ...endpoint, tools: [...new Set(value.tools)] });
      }
      else if (type === 'approval') {
        text(value.id, 100); text(value.toolName, 100); text(value.reason, 8000);
        if (this.get('approval', value.id)) throw failure('CONFLICT');
        let parameters;
        try { parameters = JSON.parse(value.reason); } catch { parameters = { detail: value.reason }; }
        const action = { ...actionPreview(value.toolName, parameters), fingerprint: actionFingerprint(value.toolName, parameters), parameters };
        const approval = this.put('approval', { id: value.id, toolName: value.toolName, reason: value.reason, action, native: true, runId, conversationId: run.conversationId, state: 'pending', createdAt: this.now(), expiresAt: this.now() + 240000 });
        run.status = 'waiting_approval';
        this.reply(run.conversationId, approvalText(approval), run.source, runId);
      } else if (type === 'completed' || type === 'yielded') {
        if (type === 'yielded') {
          const request = run.botRequest && this.get('botMessage', run.botRequest);
          const validAsk = value?.operation === 'ask' && request && value.messageId === request.id && request.runId === run.id && request.state === 'queued' && this.get('run', request.recipientRunId)?.status === 'queued';
          const validDelegate = value?.operation === 'delegate' && run.handoff && !run.botTaskStopped;
          if (run.routine || run.firstTaskId || this.get('run', run.rootRunId || run.id)?.botTaskStopped || !validAsk && !validDelegate) throw failure('FORBIDDEN');
          value = ''; run.botYielded = true;
        } else text(value, 16000);
        run.status = 'completed'; run.finishedAt = this.now();
        const coverage = sourceCoverage(runId, this.all('sourceRequest'));
        const finalValue = run.botId && !internalBotTurn(this, run) && ['blocked', 'partial'].includes(run.report?.outcome) ? `Bot 协作尚未完成：${run.report.summary || '仍有未完成部分。'}\n已保留现有结果，请核对后再继续。` : value;
        const reply = coverage ? `${finalValue}\n\n${coverage}` : finalValue;
        run.resultExcerpt = excerpt(reply);
        if (!run.routine) {
          if (!run.handoff && type !== 'yielded') {
            if (internalBotTurn(this, run)) this.message(run.conversationId, 'assistant', reply, run.source, runId);
            else this.reply(run.conversationId, reply, run.source, runId);
          }
          if ((run.pendingBotIds?.length || run.handoff?.botIds?.length || run.botRequest || run.botPhase) && !run.journalItemId) run.journalItemId = [...(journalEvidence(this.all('effect')).get(run.id)?.keys() || [])][0];
          continueBots(this, run, reply);
        }
      } else if (type === 'failed' || type === 'uncertain') {
        run.status = type; run.error = /^[A-Z_]{3,80}$/.test(value) ? value : 'AGENT_FAILED';
        if (type === 'failed') run.finishedAt = this.now();
        if (!run.routine) {
          const where = run.source.channel === 'web' ? '展开执行详情' : '在 Web 打开执行详情';
          const reason = ({ AGENT_TIMEOUT: '本次处理超时。', AGENT_RATE_LIMITED: '模型服务暂时限流，本轮未完成，也没有自动重试。', AGENT_MODEL_UNAVAILABLE: '所选模型不可用，请在执行电脑检查模型设置或切换 Agent。' })[run.error] || '本次执行未完成。';
          this.reply(run.conversationId, type === 'uncertain' ? `本地执行已中断，结果尚未确认。任务不会自动重跑，请${where}核对后再决定下一步。` : `${reason}请${where}核对已完成部分后再继续。`, run.source, runId);
        }
        if (type === 'failed' && !failIndependentParticipant(this, run)) stopBotTask(this, run, run.error);
      } else throw failure('INVALID_INPUT');
      this.put('run', { ...run, seq, heartbeat: this.now() });
      this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(runId, seq, digest);
      if (run.routine) this.reconcileRoutineRun?.(runId);
      return { accepted: true };
    });
  }
  taskAction(input) {
    if (input.operation === 'list') return { tasks: this.all('task') };
    const requestId = text(input.requestId, 256);
    return this.once('task:' + requestId, () => {
      if (input.operation === 'add') return { task: this.put('task', { id: id(), title: text(input.title, 200), note: typeof input.note === 'string' ? input.note.slice(0, 4000) : '', status: 'pending', version: 1, createdAt: this.now() }) };
      const task = this.get('task', input.taskId);
      if (!task) throw failure('ITEM_NOT_FOUND');
      if (input.version !== task.version) throw failure('VERSION_CONFLICT');
      if (!['done', 'cancel', 'reopen'].includes(input.operation)) throw failure('INVALID_INPUT');
      return { task: this.put('task', { ...task, status: { done: 'done', cancel: 'cancelled', reopen: 'pending' }[input.operation], version: task.version + 1, updatedAt: this.now() }) };
    });
  }
  tool(token, input) {
    return this.transaction(() => {
      const endpoint = this.authenticate(token), run = this.get('run', input.runId);
      if (!run || run.endpointId !== endpoint.id || run.lease !== input.lease || !live.has(run.status) || run.status === 'cancelling') throw failure('FORBIDDEN');
      const requestId = 'agent:' + run.id + ':' + text(input.callId, 200);
      if (input.tool === 'xiaoman_history') return history(this, run, input.arguments);
      if (input.tool === 'xiaoman_report') return this.once('report:' + requestId, () => {
        const report = normalizeReport(input.arguments, run.report, this.now());
        this.put('run', { ...run, report });
        const conversation = this.conversation(run.conversationId);
        const first = this.all('message').find(m => m.conversationId === conversation.id && m.role === 'user');
        const automatic = conversation.titleOrigin === 'message' || !conversation.titleOrigin && ['新的对话', '新的一页', first?.text.slice(0, 36), first?.text.trim().split(/\n/)[0].replace(/\s+/g, ' ').slice(0, 80)].includes(conversation.title);
        if (automatic && report.title && Array.from(report.title).length <= 60 && !/[\r\n]/.test(report.title)) {
          this.put('conversation', { ...conversation, title: report.title, titleOrigin: 'generated' });
        }
        return { runId: run.id, report };
      });
      if (input.tool && input.tool !== 'xiaoman_tasks') throw failure('FORBIDDEN');
      if (input.arguments?.operation === 'cancel') {
        const prior = this.receipt('task:' + requestId);
        if (prior) {
          const approved = this.all('approval').find(a => a.runId === run.id && a.callId === input.callId && a.consumedAt);
          if (!approved || approved.action.fingerprint !== actionFingerprint(input.tool, input.arguments)) throw failure('CONFLICT');
          return prior;
        }
        const gate = requireAction(this, { run, tool: 'xiaoman_tasks', parameters: input.arguments, callId: input.callId, approvalId: input.approvalId, title: this.get('task', input.arguments.taskId)?.title });
        if (gate) return gate;
      }
      return this.taskAction({ ...input.arguments, requestId });
    });
  }
  takeDelivery(channel, account, allowed, eligible = () => true) {
    return this.transaction(() => {
      this.expire();
      const d = this.all('delivery').find(d => d.source.channel === channel && d.source.account === account && d.state === 'pending' && allowed(d.source.peer) && eligible(d));
      return d ? this.put('delivery', { ...d, state: 'sending', startedAt: this.now() }) : null;
    });
  }
  delivered(deliveryId, success) { return this.transaction(() => { const d = this.get('delivery', deliveryId); if (d?.state === 'sending' || d?.state === 'unknown' && success) this.put('delivery', { ...d, state: success ? 'sent' : 'unknown', finishedAt: this.now() }); }); }
  resolveRunIssue({ runId, conversationId, fingerprint, decision }) {
    if (decision !== 'accept_limit') throw failure('INVALID_INPUT');
    return this.transaction(() => {
      const run = this.get('run', runId);
      if (!run || run.conversationId !== conversationId || this.conversation(conversationId).ownerId !== 'owner') throw failure('ITEM_NOT_FOUND');
      if (!hasTerminalIssue(run) || fingerprint !== runIssueFingerprint(run)) throw failure('CONFLICT');
      const key = run.id + ':' + fingerprint, previous = this.get('runResolution', key);
      if (previous) return previous;
      return this.put('runResolution', { id: key, kind: 'accepted_limit', runId, conversationId, fingerprint, actor: 'owner', at: this.now() });
    });
  }
  snapshot(conversationId) {
    this.transaction(() => this.expire());
    const rooms = this.all('conversation').filter(c => c.roomKey && (c.roomKind === 'group' || this.get('bot', c.botId)?.active)).map(c => this.roomView(c));
    const runs = this.all('run'), evidence = journalEvidence(this.all('effect')), resolutions = this.all('runResolution'), sources = this.all('sourceRequest');
    const byId = new Map(runs.map(run => [run.id, run])), itemsByRoot = new Map();
    for (const run of runs) {
      const rootId = run.rootRunId || run.id, items = itemsByRoot.get(rootId) || new Set();
      for (const item of [...(run.journalItemId ? [run.journalItemId] : []), ...(evidence.get(run.id)?.keys() || [])]) items.add(item);
      itemsByRoot.set(rootId, items);
    }
    const cleanRun = ({ prompt, lease, runnerId, source, ...r }) => ({ ...r, resolvedConversationId: this.resolveConversationId(r.conversationId), title: r.title || excerpt(prompt || '对话任务', 100), channel: source.channel,
      journalItemIds: [...new Set([...(r.journalItemId ? [r.journalItemId] : []), ...(evidence.get(r.id)?.keys() || [])])], issue: runIssue(r, runs, evidence, resolutions), progress: runProgress(r, sources, this.now()) });
    return { rooms, defaultRoomId: rooms.find(room => room.kind === 'group')?.id || null, botMessages: this.all('botMessage').filter(m => !conversationId || m.conversationId === conversationId), bots: botSnapshot(this).map(bot => ({ ...bot, execution: botExecution(this, bot) })), roles: hubConfig(this.root).roles, endpoints: this.all('endpoint').map(({ tokenHash, ...e }) => ({ ...e, online: e.active && this.now() - e.lastSeen < 45000 })), channels: this.all('channelEndpoint').map(({ tokenHash, ...c }) => ({ ...c, online: c.active && c.ready === true && this.now() - c.lastSeen < 45000, connected: c.active && c.lastSeen > 0 && this.now() - c.lastSeen < 45000 })), conversations: this.all('conversation').map(c => ({ ...c, resolvedConversationId: this.resolveConversationId(c.id) })), bindings: this.all('binding').map(({ id, channel, account, peer, conversationId, ownerVerified = false, ownerIdentityId }) => ({ id, channel, account, peer, conversationId, ownerVerified, ownerIdentityId })), messages: this.all('message').filter(m => !conversationId || this.conversationIds(conversationId).includes(m.conversationId)).map(m => {
      const run = m.runId && byId.get(m.runId), rootId = run && (run.rootRunId || run.id);
      return projectMessage(this, m, [...(itemsByRoot.get(rootId) || [])]);
    }).sort(chronological), rootTasks: rootTasks(runs.map(cleanRun)), runs: runs.map(cleanRun), tasks: this.all('task'), approvals: this.all('approval'), deliveries: this.all('delivery').map(({ id, conversationId, state }) => ({ id, conversationId, state })) };
  }
}
