import { ownerSession } from './owner-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { managePersonalNotices, personalChannelPoll, personalNoticeSnapshot } from '../plugins/proactive/personal-notices.mjs';
import { configureReachOut } from '../plugins/proactive/reach-out.mjs';
import { PetDelivery, createPetClient, discoverPetOrigin, petRequest } from '../plugins/proactive/pet-delivery.mjs';
import { createWebUI } from '../plugins/webui/server.mjs';

const base = Date.parse('2026-10-21T10:00:00+08:00');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pet-delivery-')); let now = base;
  const hub = new AgentHub(root, { now: () => now });
  t.after(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
  const endpoint = hub.pair({ provider: 'codex', label: 'isolated' });
  const conversation = hub.newConversation({ endpointId: endpoint.endpointId });
  const pair = hub.pairDesktopPet({ label: '桌面小满', petId: 'main', conversationId: conversation.id });
  const ready = () => hub.channelStatus(pair.token, { ready: true, peer: 'main' }); ready();
  managePersonalNotices(hub, { operation: 'configure', enabled: true, channelId: pair.channelId, timezone: 'Asia/Shanghai' });
  configureReachOut(hub, { revision: 0, mode: 'Active' });
  const offer = (key = 'one') => ({ operation: 'offer', key, source: 'github', topic: key, text: '项目升级后，代码生成规则也值得一起检查。来源：GitHub。', observedAt: now, expiresAt: now + 3600000 });
  return { root, hub, pair, conversation, ready, offer, advance(ms) { now += ms; ready(); } };
}
test('pet channel uses the existing policy and owner binding; cannot acknowledge another endpoint or claim reading', t => {
  const f = fixture(t);
  assert.equal(personalNoticeSnapshot(f.hub).channel, 'desktop-pet');
  assert.throws(() => f.hub.pairDesktopPet({ label: 'duplicate', petId: 'main', conversationId: f.conversation.id }), /PET_ALREADY_BOUND/);
  assert.throws(() => f.hub.channelStatus(f.pair.token, { ready: true, peer: 'other' }), /INVALID_INPUT/);
  const receipt = managePersonalNotices(f.hub, f.offer());
  assert.equal(receipt.accepted, true);
  const delivery = personalChannelPoll(f.hub, f.pair.token, { sourceAllowed: () => true }).delivery;
  assert.equal(delivery.peer, 'main');
  assert.equal(personalChannelPoll(f.hub, f.pair.token, { sourceAllowed: () => true }).delivery, null);
  const other = f.hub.pairDesktopPet({ label: 'other', petId: 'other', conversationId: f.conversation.id });
  assert.throws(() => f.hub.channelAck(other.token, { deliveryId: delivery.id, state: 'submitted' }), /FORBIDDEN/);
  assert.throws(() => f.hub.channelAck(f.pair.token, { deliveryId: delivery.id, state: 'read' }), /INVALID_INPUT/);
  f.hub.channelAck(f.pair.token, { deliveryId: delivery.id, state: 'submitted' });
  assert.equal(managePersonalNotices(f.hub, f.offer()).state, 'submitted');
  assert.equal(personalNoticeSnapshot(f.hub).notices.at(-1).channelId, f.pair.channelId);
  managePersonalNotices(f.hub, { operation: 'configure', enabled: true, channelId: other.channelId });
  assert.equal(personalNoticeSnapshot(f.hub).notices.filter(n => n.channelId === other.channelId).length, 0, 'A new channel must not inherit old delivery receipts');
  managePersonalNotices(f.hub, { operation: 'configure', enabled: true, channelId: f.pair.channelId });
  assert.equal(managePersonalNotices(f.hub, f.offer('two')).blocked, 'cooldown');
});
test('pet pause, source revocation, quiet hours and channel switching are checked at delivery time', t => {
  const f = fixture(t); managePersonalNotices(f.hub, f.offer());
  managePersonalNotices(f.hub, { operation: 'configure', enabled: false });
  assert.equal(personalChannelPoll(f.hub, f.pair.token, { sourceAllowed: () => true }).delivery, null);
  assert.equal(f.hub.all('delivery')[0].state, 'cancelled');
  const g = fixture(t); managePersonalNotices(g.hub, g.offer());
  assert.equal(personalChannelPoll(g.hub, g.pair.token, { sourceAllowed: () => false }).delivery, null);
  const h = fixture(t); h.advance(12 * 3600000);
  assert.equal(managePersonalNotices(h.hub, h.offer()).blocked, 'quiet_hours');
  const j = fixture(t); managePersonalNotices(j.hub, j.offer());
  const im = j.hub.pairChannel({ label: 'other channel', peer: 'owner@example.test', botAddress: 'bot@example.test', conversationId: j.conversation.id });
  managePersonalNotices(j.hub, { operation: 'configure', enabled: true, channelId: im.channelId });
  assert.equal(personalChannelPoll(j.hub, j.pair.token, { sourceAllowed: () => true }).delivery, null);
  assert.equal(j.hub.all('delivery')[0].state, 'cancelled');
});
test('desktop pet token is outbound only and owner pairing cannot be called with a channel token', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pet-http-'));
  const app = createWebUI({ root, helper: async () => ({ revision: 'fixture', installed: false, config: { agent: { provider: 'dsh' }, im: { provider: 'disabled', allow_from: [] }, proactive: { timezone: 'Asia/Shanghai' } } }), rpc: async () => { throw new Error('offline'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await app.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const endpoint = app.hub.pair({ provider: 'codex', label: 'test' }), conversation = app.hub.newConversation({ endpointId: endpoint.endpointId });
  const home = await ownerSession(root, origin), cookie = home.headers.get('set-cookie').split(';')[0];
  const state = await fetch(origin + '/api/state', { headers: { Cookie: cookie } }).then(r => r.json());
  const ownerHeaders = { Cookie: cookie, Origin: origin, 'X-PA-CSRF': state.data.csrf, 'Content-Type': 'application/json' };
  const input = { operation: 'pair-desktop-pet', label: '桌面小满', petId: 'main', conversationId: conversation.id };
  const response = await fetch(origin + '/api/hub', { method: 'POST', headers: ownerHeaders, body: JSON.stringify(input) });
  const paired = await response.json(); assert.equal(paired.ok, true);
  const headers = { 'X-PA-Channel-Token': paired.data.token, 'Content-Type': 'application/json' };
  const inbound = await fetch(origin + '/api/message-bridge/inbound', { method: 'POST', headers, body: JSON.stringify({ peer: 'main', requestId: 'forbidden', text: 'start a task' }) });
  assert.equal(inbound.status, 403); assert.equal(app.hub.all('run').length, 0);
  assert.equal((await fetch(origin + '/api/hub', { method: 'POST', headers, body: JSON.stringify(input) })).status, 403);
});
test('pet delivery persists before broadcast, retries only acknowledgement and never resends after crash', async t => {
  const f = fixture(t), statePath = join(f.root, 'pet-state.json'); let sent = 0, polled = 0, ackFails = true;
  const transport = async (op, data) => {
    if (op === 'poll') return { delivery: ++polled === 1 ? { id: 'delivery-one', peer: 'main', text: 'a real source hook' } : null };
    if (op === 'ack' && ackFails) throw new Error('network down');
    return { accepted: true };
  };
  const client = { probe: async () => 'http://127.0.0.1:1234', broadcast: async () => {
    sent++; assert.equal(JSON.parse(readFileSync(statePath)).pending.state, 'unknown');
    return { state: 'submitted', counter: 42 };
  } };
  const options = { config: { petId: 'main' }, statePath, transport, client };
  await assert.rejects(new PetDelivery(options).tick(), /network down/); assert.equal(sent, 1);
  ackFails = false; await new PetDelivery(options).tick(); assert.equal(sent, 1);
  assert.equal(JSON.parse(readFileSync(statePath)).pending, null); assert.equal(statSync(statePath).mode & 0o777, 0o600);
});
test('timeout remains unknown, offline pet does not claim a delivery, and busy ticks do not overlap', async t => {
  const f = fixture(t); let polls = 0, sends = 0; const acks = [];
  const transport = async (op, data) => {
    if (op === 'ack') acks.push(data.state);
    if (op === 'poll') { polls++; return { delivery: polls === 1 ? { id: 'one', peer: 'main', text: 'hello' } : null }; }
    return {};
  };
  const client = { probe: async () => { throw new Error('offline'); }, broadcast: async () => { sends++; throw new Error('response lost'); } };
  const p = new PetDelivery({ config: { petId: 'main' }, statePath: join(f.root, 'pet.json'), transport, client });
  await p.tick(); assert.equal(polls, 0);
  client.probe = async () => 'http://127.0.0.1:1234';
  await Promise.all([p.tick(), p.tick()]); assert.equal(polls, 1); assert.equal(sends, 1); assert.deepEqual(acks, ['unknown']);
  await p.tick(); assert.equal(sends, 1);
});
test('official pet API checks inner ok and state counter; no redirect or arbitrary remote endpoint', async () => {
  let counter = 5, text = '', accept = false;
  const request = async (origin, route, options = {}) => {
    if (route === '/config') return { main: { pets: [{ id: 'main', display: 'desktop' }] } };
    if (route === '/state') return { pets: { main: { say: { counter, data: { text } } } } };
    if (accept) { counter++; text = options.body.text; }
    return { ok: accept };
  };
  const c = createPetClient({ petId: 'main' }, { discover: async () => 'http://127.0.0.1:1234', request });
  const origin = await c.probe(); assert.deepEqual(await c.broadcast(origin, 'hello'), { state: 'failed' });
  accept = true; const result = await c.broadcast(origin, 'hello'); assert.equal(result.state, 'submitted'); assert.equal(text, 'Morlet · hello');
  await assert.rejects(petRequest('https://example.test', '/state'), /INVALID_CONFIG/);
  await assert.rejects(petRequest(origin, '/chat'), /INVALID_ROUTE/);
  let redirect;
  await petRequest(origin, '/state', { fetcher: async (url, options) => { redirect = options.redirect; return new Response('{}'); } });
  assert.equal(redirect, 'error');
});
test('discovery uses exact executable identity, same user and loopback, and refuses ambiguity', async () => {
  const config = { hostExecutable: '/Applications/Test.app/Test', helperExecutable: '/runtime/Electron' };
  const execute = async (command, args) => ({ stdout: command === '/bin/ps' ? '501 10 /Applications/Test.app/Test\n501 11 /runtime/Electron\n502 12 /Applications/Test.app/Test\n' : 'p10\nn127.0.0.1:53523\nn*:9999\n' });
  assert.equal(await discoverPetOrigin(config, { execute, uid: 501 }), 'http://127.0.0.1:53523');
  await assert.rejects(discoverPetOrigin(config, { execute, uid: 502 }), /PET_OFFLINE/);
  await assert.rejects(discoverPetOrigin(config, { uid: 501, execute: async (c, a) => c === '/bin/ps' ? execute(c, a) : { stdout: 'n127.0.0.1:1234\nn127.0.0.1:1235\n' } }), /PET_OFFLINE/);
});
test('a freshly restarted pet accepts its first broadcast before a say counter exists', async () => {
  let sent = 0, state = { pets: {} };
  const c = createPetClient({ petId: 'main' }, { request: async (origin, route, options) => {
    if (route === '/state') return state;
    sent++;
    state = { pets: { main: { say: { counter: 1, data: { text: options.body.text } } } } };
    return { ok: true };
  } });
  assert.equal((await c.broadcast('http://127.0.0.1:1234', 'hello')).state, 'submitted');
  assert.equal(sent, 1);
  state = { pets: { main: { say: { counter: 'invalid' } } } };
  await assert.rejects(c.broadcast('http://127.0.0.1:1234', 'again'), /PET_UNAVAILABLE/);
  assert.equal(sent, 1);
});
test('standalone discovery distinguishes this instance from other Node hosts and requires its own helper', async () => {
  const config = { hostExecutable: '/node', hostArguments: ['/instance/pet-host.mjs', '--config', '/instance/pet.json'], helperExecutable: '/Electron' };
  let parent = '11', queried = [];
  const execute = async (command, args) => {
    if (command === '/usr/sbin/lsof') { queried.push(args[2]); return { stdout: 'n127.0.0.1:3080\n' }; }
    if (args[0] === '-axo') return { stdout: '501 10 /node\n501 11 /node\n501 12 /Electron\n' };
    if (args[3] === 'ppid=') return { stdout: parent };
    return { stdout: args[1] === '11' ? '/node /instance/pet-host.mjs --config /instance/pet.json' : '/node unrelated.mjs' };
  };
  assert.equal(await discoverPetOrigin(config, { execute, uid: 501 }), 'http://127.0.0.1:3080');
  assert.deepEqual(queried, ['11']);
  parent = '10'; queried = [];
  await assert.rejects(discoverPetOrigin(config, { execute, uid: 501 }), /PET_OFFLINE/);
  assert.deepEqual(queried, []);
});
