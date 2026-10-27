// Xiaoman extension for dsh-pet 0.3.7 (MIT). Bundled into the host only.
import { lstatSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

export function readXiaomanChat(userRoot, petId) {
  let st;
  const path = join(userRoot, 'xiaoman-chat.json');
  try { st = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.size > 4096) throw new Error('小满连接配置需由本人持有且权限为 0600');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!isAbsolute(config.socketPath || '') || Buffer.byteLength(config.socketPath) > 100 || !/^[A-Za-z0-9_-]{32,256}$/.test(config.token || '') || !/^[A-Za-z0-9_-]{1,80}$/.test(config.petId || '')) throw new Error('小满连接配置无效');
  return config.petId === petId ? config : null;
}

// Desktop renders over the existing helper pipe. Do not expose an additional
// unauthenticated HTTP path into the owner's agent, even on loopback.
export function blocksXiaomanHttpChat(userRoot, rawUrl) {
  const url = new URL(rawUrl, 'http://127.0.0.1');
  return decodeURIComponent(url.pathname) === '/dsh-pet-7340/chat' && !!readXiaomanChat(userRoot, url.searchParams.get('pet') || '');
}

export async function xiaomanChat(userRoot, petId, operation, input = {}) {
  const config = readXiaomanChat(userRoot, petId);
  if (!config) return null;
  if (!['context', 'inbound'].includes(operation)) throw new Error('小满连接操作无效');
  const payload = JSON.stringify({ petId, ...input, ...(operation === 'inbound' && { requestId: input.requestId || randomUUID() }) });
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: config.socketPath, path: '/' + operation, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-PA-Pet-Token': config.token } }, res => {
      let bytes = 0, chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 128000) return req.destroy(new Error('RESPONSE_TOO_LARGE')); chunks.push(chunk); });
      res.on('error', () => reject(new Error('小满连接中断；重试会沿用本次编号')));
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (value.ok !== true) throw new Error(value.error === 'REPLY_CONTEXT_EXPIRED' ? '这条推送的回复窗口已过期，请重新打开对话' : value.error === 'CONFLICT' ? '这次发送的内容已改变，请重新打开对话' : '小满暂未接通，请稍后重试');
          resolve(operation === 'context' ? { ok: true, xiaoman: true, context: value.data.context } : { ok: value.data.accepted === true });
        } catch (error) { reject(error instanceof SyntaxError ? new Error('小满响应无效') : error); }
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error('TIMEOUT')));
    req.on('error', () => reject(new Error('小满连接中断；重试会沿用本次编号'))); req.end(payload);
  });
}
