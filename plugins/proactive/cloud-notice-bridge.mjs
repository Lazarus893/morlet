import { readCloudSource, readCloudMail } from '../agent-hub/cloud-source-routing.mjs';
import { createNoticeSources } from './notice-sources.mjs';
import { noticeWorkerSources } from './notice-worker-bridge.mjs';
import { personalNoticeSnapshot } from './personal-notices.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const service = id => id.startsWith('google-') ? 'google' : id;
const permission = id => ({ 'google-calendar': 'calendar', 'google-mail': 'gmail', github: 'repos', x: 'read' })[id];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const mailId = value => typeof value === 'string' && /^[a-fA-F0-9]{1,64}$/.test(value);

/** Reuse the paired observer's existing analysis, budgets and publication path. */
export function createCloudNoticeBridge({ config, manager, hub, automaticContent, env = process.env, fetchImpl, readSource = readCloudSource, readMail = readCloudMail }) {
  const contentPolicy = () => automaticContent?.policy() || { enabled: false, sources: [] };
  const grant = (id, content) => {
    const notice = personalNoticeSnapshot(hub), automatic = contentPolicy();
    // Content mode does not expand a source enabled only for personal notices.
    const fullContent = content && automatic.enabled && automatic.sources.includes(id);
    if (fullContent || !content && automatic.enabled && automatic.sources.includes(id)) return { kind: 'content', revision: automatic.revision, content: Boolean(fullContent) };
    if (notice.enabled && notice.sources.includes(id)) return { kind: 'notice', updatedAt: notice.updatedAt ?? null, mode: notice.mode, content: false };
    fail('SOURCE_AUTHORITY_CHANGED');
  };
  return async (input, connections, { authorize: authorizeRequest = () => true, signal: requestSignal } = {}) => {
    if (!config) fail('SOURCE_NOT_CONFIGURED');
    const signal = AbortSignal.any([AbortSignal.timeout(120000), ...(requestSignal ? [requestSignal] : [])]);
    const notice = personalNoticeSnapshot(hub), automatic = contentPolicy();
    const active = noticeWorkerSources(connections, { sources: [...new Set([...(notice.enabled ? notice.sources : []), ...(automatic.enabled ? automatic.sources : [])])] }).filter(source => source.connectionProvider === 'nango');
    const content = input?.operation === 'cloud-collect' && input.content === true;
    if (content && !automatic.enabled) fail('SOURCE_AUTHORITY_CHANGED');
    const scope = source => {
      const id = service(source.id), initialGrant = grant(source.id, content);
      const authorize = async () => {
        signal.throwIfAborted();
        if (await authorizeRequest() === false) fail('FORBIDDEN');
        const current = manager.cloudState(id);
        if (!current?.enabled || current.provider !== 'nango' || !current.binding || current.generation !== source.generation || current.account?.toLowerCase() !== source.account?.toLowerCase() ||
          !['connected', 'limited'].includes(current.state) || !current.permissions.some(p => p.id === permission(source.id) && p.granted && p.verified) ||
          JSON.stringify(grant(source.id, content)) !== JSON.stringify(initialGrant) || content && (!contentPolicy().enabled || contentPolicy().revision !== automatic.revision)) fail('SOURCE_AUTHORITY_CHANGED');
        return true;
      };
      return { content: initialGrant.content, options: { generation: source.generation, account: source.account, authorize, env, fetchImpl, signal, now: () => hub.now() } };
    };
    if (input?.operation === 'cloud-mail') {
      if (!exact(input, ['operation', 'generation', 'messageId', 'threadId']) || !Number.isSafeInteger(input.generation) || input.generation < 0 || Boolean(input.messageId) === Boolean(input.threadId) ||
        input.messageId !== undefined && !mailId(input.messageId) || input.threadId !== undefined && !mailId(input.threadId)) fail('INVALID_REQUEST');
      const source = active.find(s => s.id === 'google-mail' && s.generation === input.generation);
      if (!source) fail('SOURCE_AUTHORITY_CHANGED');
      const { options } = scope(source); await options.authorize();
      const result = await readMail(hub.root, { messageId: input.messageId, threadId: input.threadId }, options);
      await options.authorize();
      if (Buffer.byteLength(JSON.stringify(result)) > 1900000) fail('SOURCE_RESULT_TOO_LARGE');
      return result;
    }
    if (input?.operation !== 'cloud-collect' || !exact(input, ['operation', 'sources', 'content', 'recheckCandidates']) || typeof input.content !== 'boolean' || !Array.isArray(input.sources) || input.sources.length > 4 ||
      input.sources.some(s => !exact(s, ['id', 'generation']) || !['google-calendar', 'google-mail', 'github', 'x'].includes(s.id) || !Number.isSafeInteger(s.generation) || s.generation < 0) || new Set(input.sources.map(s => s.id)).size !== input.sources.length) fail('INVALID_REQUEST');
    const selected = input.sources.map(request => active.find(s => s.id === request.id && s.generation === request.generation));
    if (selected.some(s => !s)) fail('SOURCE_AUTHORITY_CHANGED');
    if (input.recheckCandidates !== undefined && (!Array.isArray(input.recheckCandidates) || input.recheckCandidates.length > 20 || input.recheckCandidates.some(c => !exact(c, ['source', 'repo', 'notificationId']) || c.source !== 'github' || c.repo !== undefined && (typeof c.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.repo)) || c.notificationId !== undefined && !/^\d{1,30}$/.test(c.notificationId)))) fail('INVALID_REQUEST');
    const scopes = new Map(selected.map(source => [source.id, scope(source)]));
    for (const { options } of scopes.values()) await options.authorize();
    const collect = createNoticeSources({ readSource: (source, args) => readSource(hub.root, args, scopes.get(source.id).options), runner: async () => fail('CLOUD_SOURCE_REQUIRED') });
    const results = await Promise.all(selected.map(source => collect([source], { now: hub.now(), timezone: notice.timezone, signal, content: scopes.get(source.id).content, recheckCandidates: input.recheckCandidates })));
    for (const { options } of scopes.values()) await options.authorize();
    const result = { candidates: results.flatMap(r => r.candidates), counts: Object.assign({}, ...results.map(r => r.counts)), errors: [...new Set(results.flatMap(r => r.errors))] };
    if (Buffer.byteLength(JSON.stringify(result)) > 480000) fail('SOURCE_RESULT_TOO_LARGE');
    return result;
  };
}
