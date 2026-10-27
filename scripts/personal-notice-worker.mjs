#!/usr/bin/env node
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { loadCompanionConfig } from './connection-companion.mjs';
import { loadAgentConfig } from '../plugins/agent-hub/companion.mjs';
import { roleAgent } from '../plugins/agent-hub/config.mjs';
import { acquireCompanionLock } from '../plugins/agent-hub/lock.mjs';
import { providers } from '../plugins/agent-bridge/providers.mjs';
import { PersonalNoticeWorker, noticeDiagnostic, NOTICE_ANALYSIS_REVISION } from '../plugins/proactive/notice-worker.mjs';
import { createNoticeSources } from '../plugins/proactive/notice-sources.mjs';
import { createMailReading } from '../plugins/proactive/notice-mail-reading.mjs';
import { createPublicArticleReader } from '../plugins/proactive/notice-articles.mjs';
import { createOAuthConnections } from '../plugins/connections/oauth.mjs';
import { PetDelivery, loadPetConfig } from '../plugins/proactive/pet-delivery.mjs';
import { loadPetChatConfig, startPetChatBridge } from '../plugins/proactive/pet-chat-bridge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const privateJSON = path => {
  const st = statSync(path);
  if (!st.isFile() || st.mode & 0o077 || st.size > 16384 || st.uid !== process.getuid()) throw new Error('PRIVATE_CONFIG_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8'));
};

const bridgeError = (code, statusCode) => Object.assign(new Error(code), { code, ...(statusCode && { statusCode }) });
export function noticeTransport(config) {
  return (input, signal) => new Promise((resolveRequest, reject) => {
    const payload = JSON.stringify(input);
    const req = request(new URL('/api/personal-notice-bridge', config.endpoint), { method: 'POST', signal,
      headers: { Host: new URL(config.publicOrigin).host, 'X-PA-Bridge-Token': config.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      let text = '', bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > (input.operation === 'cloud-mail' ? 2000000 : 512000)) req.destroy(new Error('RESPONSE_TOO_LARGE')); else text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(bridgeError([401, 403].includes(res.statusCode) ? 'BRIDGE_AUTH_REQUIRED' : 'BRIDGE_REJECTED', res.statusCode)); return; }
        try { const value = JSON.parse(text); if (value?.ok !== true || !value.data || typeof value.data !== 'object') throw bridgeError('BRIDGE_INVALID_RESPONSE'); resolveRequest(value.data); }
        catch { reject(bridgeError('BRIDGE_INVALID_RESPONSE', res.statusCode)); }
      });
    });
    req.setTimeout(['cloud-collect', 'cloud-mail'].includes(input.operation) ? 120000 : 15000, () => req.destroy(bridgeError('BRIDGE_TIMEOUT')));
    req.on('error', reject); req.end(payload);
  });
}

/** Cloud failures stay visible without rerouting them to an old local login. */
export function createRoutedNoticeSources({ collect, transport }) {
  return async (sources, context) => {
    if (new Set(sources.map(source => source.id)).size !== sources.length) throw bridgeError('INVALID_SNAPSHOT');
    const cloud = sources.filter(source => source.connectionProvider === 'nango'), local = sources.filter(source => source.connectionProvider !== 'nango');
    const cloudRead = async () => {
      try {
        const result = await transport({ operation: 'cloud-collect', sources: cloud.map(({ id, generation }) => ({ id, generation })), content: context.content === true,
          ...(context.recheckCandidates && { recheckCandidates: context.recheckCandidates.filter(c => c.source === 'github').slice(0, 20).map(({ source, repo, notificationId }) => ({ source, ...(repo && { repo }), ...(notificationId && { notificationId }) })) }) }, context.signal);
        if (!Array.isArray(result?.candidates) || !Array.isArray(result.errors) || !result.counts || typeof result.counts !== 'object') throw bridgeError('BRIDGE_INVALID_RESPONSE');
        return result;
      } catch (error) {
        if (context.signal?.aborted || error.code === 'BRIDGE_AUTH_REQUIRED') throw error;
        return { candidates: [], counts: Object.fromEntries(cloud.map(source => [source.id, 0])), errors: cloud.map(source => source.id) };
      }
    };
    const results = await Promise.all([collect(local, context), ...(cloud.length ? [cloudRead()] : [])]);
    return { candidates: results.flatMap(result => result.candidates), counts: Object.assign({}, ...results.map(result => result.counts)), errors: [...new Set(results.flatMap(result => result.errors))] };
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((a, i) => a !== '--once' && a !== '--config' && args[i - 1] !== '--config') || args.includes('--config') && !args[args.indexOf('--config') + 1]) throw new Error('INVALID_ARGUMENTS');
  const configPath = args.includes('--config') ? resolve(args[args.indexOf('--config') + 1]) : join(ROOT, '.runtime/personal-notices/worker.json');
  const config = privateJSON(configPath);
  if (Object.keys(config).some(k => !['connectionConfig', 'agentConfig', 'voicePath', 'interests', 'timezone', 'gog', 'gh', 'reading', 'petConfig'].includes(k)) || !config.connectionConfig || config.agentConfig !== undefined && (typeof config.agentConfig !== 'string' || !config.agentConfig) || !config.timezone || !Array.isArray(config.interests) || config.interests.length > 12 || config.interests.some(v => typeof v !== 'string' || v.length > 160) || config.petConfig !== undefined && (typeof config.petConfig !== 'string' || !config.petConfig)) throw new Error('INVALID_CONFIG');
  const reading = config.reading;
  if (reading && (Object.keys(reading).some(k => !['publisherHosts', 'primaryHosts', 'topics', 'maxEmails', 'maxArticles', 'reasoningEffort'].includes(k)) || !Array.isArray(reading.publisherHosts) || !Array.isArray(reading.primaryHosts) || !Array.isArray(reading.topics) || reading.topics.length > 30 || reading.topics.some(t => typeof t !== 'string' || !t || t.length > 100) || reading.primaryHosts.some(h => !reading.publisherHosts.includes(h)) || reading.reasoningEffort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(reading.reasoningEffort))) throw new Error('INVALID_CONFIG');
  new Intl.DateTimeFormat('en', { timeZone: config.timezone }).format();
  process.env.TZ = config.timezone;
  const bridge = await loadCompanionConfig(resolve(config.connectionConfig));
  const agent = config.agentConfig ? loadAgentConfig(resolve(config.agentConfig)) : roleAgent(ROOT, 'observer'), workspace = join(dirname(configPath), 'analysis');
  if (!['codex', 'workbuddy'].includes(agent.provider)) throw new Error('LOCAL_AGENT_REQUIRED');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const voice = config.voicePath ? readFileSync(resolve(config.voicePath), 'utf8') : '';
  if (Buffer.byteLength(voice) > 8000) throw new Error('INVALID_VOICE');
  const release = acquireCompanionLock(configPath), controller = new AbortController();
  let timer, petTimer, stopped = false;
  const petConfig = config.petConfig ? loadPetConfig(resolve(config.petConfig)) : null;
  const pet = petConfig ? new PetDelivery({ config: petConfig, statePath: join(dirname(configPath), 'pet-delivery-state.json') }) : null;
  const petChat = petConfig?.chatConfig ? await startPetChatBridge(loadPetChatConfig(petConfig.chatConfig), petConfig) : null;
  const collect = createNoticeSources({ gog: config.gog || 'gog', gh: config.gh || 'gh', xTimeline: createOAuthConnections({ root: ROOT }).xTimeline });
  const transport = noticeTransport(bridge);
  const collectSources = createRoutedNoticeSources({ collect, transport });
  const worker = new PersonalNoticeWorker({ directory: dirname(configPath), transport, voice, interests: config.interests,
    analysisRevision: createHash('sha256').update(JSON.stringify([NOTICE_ANALYSIS_REVISION, agent.provider, agent.command, agent.model || '', reading?.reasoningEffort || ''])).digest('hex'),
    collect: async (sources, context) => {
      process.env.TZ = context.timezone;
      return collectSources(sources, context);
    },
    prepareReading: reading ? createMailReading({ directory: join(dirname(configPath), 'reading-cache'), ...reading, gog: config.gog || 'gog',
      readMail: (source, { messageId, threadId, signal }) => transport({ operation: 'cloud-mail', generation: source.generation, ...(messageId && { messageId }), ...(threadId && { threadId }) }, signal),
      articleReader: createPublicArticleReader({ allowedHosts: reading.publisherHosts }) }) : undefined,
    analyze: async (instructions, prompt, signal) => {
      const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]);
      try {
        const result = await providers[agent.provider]({ ...agent, workspace, timeout_seconds: 120 }, prompt, { instructions, signal: deadline, passive: true, ...(agent.provider === 'codex' && reading?.reasoningEffort && { reasoningEffort: reading.reasoningEffort }), onSession: async () => {}, approve: async () => false });
        return result.text;
      } catch (error) {
        if (deadline.aborted && !signal?.aborted) throw Object.assign(new Error('AGENT_TIMEOUT'), { code: 'AGENT_TIMEOUT' });
        throw error;
      }
    } });
  const stop = () => { stopped = true; clearTimeout(timer); clearTimeout(petTimer); controller.abort(); void pet?.stop().catch(() => {}); void petChat?.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const loop = async () => { await worker.tick(controller.signal); if (!stopped && !args.includes('--once')) timer = setTimeout(loop, 60000); else release(); };
  const petLoop = async () => {
    try { await pet.tick(controller.signal); }
    catch { if (!stopped) process.stderr.write('{"event":"pet_delivery_unavailable"}\n'); }
    if (!stopped && !args.includes('--once')) petTimer = setTimeout(petLoop, 10000);
  };
  if (pet) await petLoop();
  await loop();
  if (args.includes('--once')) { await petChat?.close(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  else process.once('beforeExit', release);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(JSON.stringify({ event: 'personal_notice_worker_start_failed', ...noticeDiagnostic(error) }) + '\n'); process.exitCode = 1; });
