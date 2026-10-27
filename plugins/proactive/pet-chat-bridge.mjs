import { createServer } from 'node:http';
import { chmodSync, lstatSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { bridgeTransport } from '../agent-hub/companion.mjs';

export function loadPetChatConfig(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.size > 4096) throw new Error('PRIVATE_CONFIG_REQUIRED');
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (Object.keys(c).some(k => !['socketPath', 'token', 'petId'].includes(k)) || !isAbsolute(c.socketPath || '') || Buffer.byteLength(c.socketPath) > 100 || !/^[A-Za-z0-9_-]{32,256}$/.test(c.token || '') || !/^[A-Za-z0-9_-]{1,80}$/.test(c.petId || '')) throw new Error('INVALID_CONFIG');
  return c;
}

// A same-user Unix socket keeps credentials and the inbound bridge out of the
// pet renderer and web pages. The remote channel is separately owner-enabled.
export async function startPetChatBridge(config, channelConfig, { transport = bridgeTransport(channelConfig, { operations: ['context', 'inbound'], prefix: '/api/message-bridge/', header: 'X-PA-Channel-Token' }) } = {}) {
  if (config.petId !== channelConfig.petId) throw new Error('INVALID_CONFIG');
  // macOS clears /tmp across reboots; LaunchAgent startup must work without
  // rerunning the installer. Keep existing owner-only-writable directories.
  const parentPath = dirname(config.socketPath);
  mkdirSync(parentPath, { recursive: true, mode: 0o700 });
  const parent = lstatSync(parentPath);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o022) throw new Error('PRIVATE_SOCKET_REQUIRED');
  try {
    const old = lstatSync(config.socketPath);
    if (!old.isSocket() || old.uid !== process.getuid()) throw new Error('PRIVATE_SOCKET_REQUIRED');
    unlinkSync(config.socketPath); // caller already holds the worker's exclusive lock
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let active = 0;
  const server = createServer(async (req, res) => {
    const answer = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const token = req.headers['x-pa-pet-token'];
    if (req.method !== 'POST' || req.headers.origin || typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(config.token) || !timingSafeEqual(Buffer.from(token), Buffer.from(config.token))) return answer(403, { ok: false, error: 'FORBIDDEN' });
    if (!['/context', '/inbound'].includes(req.url)) return answer(404, { ok: false, error: 'INVALID_ROUTE' });
    if (active >= 4) return answer(429, { ok: false, error: 'BUSY' });
    active++;
    try {
      let bytes = 0, chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('INVALID_INPUT'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || input.petId !== config.petId || Object.keys(input).some(k => !['petId', 'requestId', 'text', 'replyTo', 'entryId', 'reaction'].includes(k))) throw new Error('INVALID_INPUT');
      const { petId, ...payload } = input;
      const data = await transport(req.url.slice(1), { ...payload, peer: petId });
      answer(200, { ok: true, data });
    } catch (error) {
      const code = ['FORBIDDEN', 'CONFLICT', 'INVALID_INPUT', 'REPLY_CONTEXT_EXPIRED'].includes(error.code || error.message) ? error.code || error.message : 'PET_CHAT_UNAVAILABLE';
      answer(400, { ok: false, error: code });
    } finally { active--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socketPath, () => { chmodSync(config.socketPath, 0o600); resolve(); }); });
  return { close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
