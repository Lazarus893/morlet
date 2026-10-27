import { createHash } from 'node:crypto';
import { failure } from '../agent-hub/store.mjs';
import { readConnectionAuthority } from '../agent-hub/cloud-source-routing.mjs';
import { reachOutPolicy } from './reach-out.mjs';

const LOCAL = { account: 'local', userId: 'owner' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// An ordinary link or a model-written suggestion is not an executable plan.
// Only the structured GitHub release/commit records produced by the existing
// authorised reading pipeline qualify; all future instructions are host-written.
function repositoryEvidence(entry) {
  if (entry.source !== 'github' || typeof entry.url !== 'string') return null;
  let url;
  try { url = new URL(entry.url); } catch { return null; }
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) return null;
  const match = url.pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/(releases\/tag\/.+|commit\/([a-f0-9]{40}))$/);
  if (!match || ['.', '..'].includes(match[2]) || /[\s\\\x00-\x1f]/.test(entry.url)) return null;
  const repo = match[1] + '/' + match[2], prefix = 'github:' + (match[4] ? 'commit:' : 'release:') + digest(repo) + ':';
  if (typeof entry.key !== 'string' || !entry.key.startsWith(prefix) ||
      (match[4] ? entry.key !== prefix + match[4] : !/^\d+$/.test(entry.key.slice(prefix.length)))) return null;
  if (!entry.evidence?.some(cite => cite.type === 'primary' && cite.complete === true && cite.url === entry.url && typeof cite.quote === 'string' && cite.quote.trim())) return null;
  return { repo, url: url.href };
}

/** Read-only discovery from saved, currently authorised material. No model call,
 * extra source read, routine creation or notification occurs in snapshot(). */
export function createFollowupSuggestions({ hub, journal, routines }) {
  const store = journal.store;
  function rows() {
    const table = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_content_entries'").get();
    return table ? store.db.prepare('SELECT data FROM journal_content_entries ORDER BY rowid DESC LIMIT 3000').all().map(row => JSON.parse(row.data)) : [];
  }
  function currentGrant() {
    try {
      const matches = readConnectionAuthority(hub.root, { optional: true })?.items.filter(item => item.id === 'github') || [];
      const grant = matches[0];
      if (matches.length !== 1 || !grant.enabled || !['connected', 'limited'].includes(grant.state) ||
          !Number.isSafeInteger(grant.generation) || grant.generation < 0 ||
          typeof grant.account !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(grant.account) ||
          !grant.permissions?.some(p => p.id === 'repos' && p.granted === true && p.verified === true)) return null;
      return { generation: grant.generation, accountHash: hash(grant.account.toLowerCase()) };
    } catch { return null; }
  }
  function candidates() {
    const policy = hub.get('automaticContentPolicy', 'owner');
    if (!policy?.enabled || !policy.sources?.includes('github')) return [];
    const grant = currentGrant();
    if (!grant) return [];
    const material = rows(), items = new Map(store.snapshot(LOCAL).items.map(item => [item.id, item]));
    const mutedTopics = new Set(material.filter(row => ['less', 'not_interested'].includes(row.feedback)).map(row => row.topic));
    const scheduledRepos = new Set(hub.all('routine').flatMap(row => (row.scope?.sources || []).filter(source => source.operation === 'github_updates' && source.filter?.repo).map(source => source.filter.repo.toLowerCase())));
    const timezone = hub.get('reachOutPolicy', 'owner')?.timezone || routines.snapshot?.().timezone || reachOutPolicy(hub).timezone;
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(hub.now()); } catch { return []; }
    const proposals = new Map();
    for (const entry of material) {
      if (!validId(entry.id) || entry.accountHash !== grant.accountHash || entry.sourceGeneration !== grant.generation ||
          !Number.isSafeInteger(entry.observedAt) || entry.observedAt > hub.now() + 60000 ||
          !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= hub.now() || mutedTopics.has(entry.topic)) continue;
      const evidence = repositoryEvidence(entry), item = items.get(entry.itemId);
      if (!evidence || !item || ['done', 'cancelled'].includes(item.status) ||
          !item.taskData?.collection?.entries?.some(row => row.id === entry.entryId) || scheduledRepos.has(evidence.repo.toLowerCase())) continue;
      const id = hash(['github-repository', grant.accountHash, evidence.repo.toLowerCase()]);
      const values = {
        title: (evidence.repo + ' · 更新跟进').slice(0, 80),
        instruction: `跟进 ${evidence.repo} 最近七天的发布说明和默认分支提交，只报告值得关注的新版本或实质变更。没有新变化保持安静；资料未读完或来源失效时明确说明检查失败。`,
        schedule: { time: '09:00', timezone, days: [1, 2, 3, 4, 5, 6, 7] },
        trigger: { condition: '出现尚未回报的新版本或值得关注的默认分支变更；无变化不回报。', mode: 'changed' },
        scope: { publicWeb: false, sources: [{ operation: 'github_updates', filter: { repo: evidence.repo } }] },
      };
      const proposal = { id, version: hash([id, grant.generation, values]), title: values.title,
        reason: `已读过 ${evidence.repo} 的更新说明，可以继续跟进后续变更。`,
        sourceItemId: entry.itemId, sourceEntryId: entry.entryId, sourceTitle: entry.title,
        url: evidence.url, observedAt: entry.observedAt, expiresAt: entry.expiresAt, values };
      if (!proposals.has(id) || proposals.get(id).observedAt < entry.observedAt) proposals.set(id, proposal);
    }
    return [...proposals.values()].sort((a, b) => b.observedAt - a.observedAt || a.id.localeCompare(b.id));
  }
  function snapshot() {
    return { now: hub.now(), suggestions: candidates().filter(row => {
      const decision = hub.get('followupDecision', row.id);
      return !decision || decision.state === 'accepting';
    }).slice(0, 3) };
  }
  function beforeCreate(decision) {
    // Controller invokes this synchronously after refreshing settings and just
    // before binding its source grants. Recheck the displayed proposal across
    // that await, so an account switch cannot silently change the approved plan.
    if (!candidates().some(row => row.id === decision.id && row.version === decision.version)) throw failure('SOURCE_AUTHORITY_CHANGED');
  }
  async function receipt(decision) {
    // Routine creation owns its durable idempotency record, including the
    // cross-database journal link. Recover a lost response without creating a
    // second routine or treating a revoked source as a fresh authorisation.
    const mutation = hub.get('routineMutation', 'routine-mutation:' + decision.createRequestId);
    const id = decision.routineId || mutation?.routineId;
    if (!id || !hub.get('routine', id)) return null;
    let result = await routines.action({ operation: 'get', id });
    if (!result.routine.journalItemId) {
      // A crash after routine persistence but before its journal link must be
      // finished through the controller's idempotent creation path.
      result = await routines.action({ operation: 'create', requestId: decision.createRequestId, values: decision.values });
      if (!result.routine.journalItemId) throw failure('FOLLOWUP_UNAVAILABLE');
    }
    hub.transaction(() => {
      const current = hub.get('followupDecision', decision.id);
      if (current?.state === 'accepting') hub.put('followupDecision', { ...current, state: 'accepted', routineId: id, decidedAt: hub.now() });
    });
    return { saved: true, routine: result.routine, sourceItemId: decision.sourceItemId };
  }
  async function action(input) {
    if (!exact(input, ['operation', 'id', 'version', 'requestId']) || !['accept', 'dismiss'].includes(input.operation) ||
        !validId(input.id) || !validId(input.version) || typeof input.requestId !== 'string' ||
        !input.requestId.trim() || input.requestId.length > 256 || /[\x00-\x1f]/.test(input.requestId)) throw failure('INVALID_INPUT');
    const mutationId = 'followup:' + input.requestId, fingerprint = hash(input);
    let decision = hub.get('followupDecision', input.id);
    hub.transaction(() => {
      const previous = hub.get('followupMutation', mutationId);
      if (previous && previous.fingerprint !== fingerprint) throw failure('CONFLICT');
      if (!previous) hub.put('followupMutation', { id: mutationId, fingerprint });
    });
    if (decision) {
      if (decision.version !== input.version || (decision.state === 'dismissed') !== (input.operation === 'dismiss')) throw failure('CONFLICT');
      if (decision.state === 'dismissed') return { saved: true, dismissed: true, id: input.id };
      const recovered = await receipt(decision);
      if (recovered) return recovered;
    }
    const proposal = candidates().find(row => row.id === input.id);
    if (!proposal) {
      const pending = hub.get('followupDecision', input.id);
      if (input.operation === 'accept' && pending?.version === input.version && ['accepting', 'accepted'].includes(pending.state)) {
        const recovered = await receipt(pending);
        if (recovered) return recovered;
      }
      throw failure('FOLLOWUP_UNAVAILABLE');
    }
    if (proposal.version !== input.version) throw failure('VERSION_CONFLICT');
    decision = hub.transaction(() => {
      const existing = hub.get('followupDecision', input.id);
      if (existing) {
        if (existing.version !== input.version || (existing.state === 'dismissed') !== (input.operation === 'dismiss')) throw failure('CONFLICT');
        return existing;
      }
      return hub.put('followupDecision', { id: input.id, state: input.operation === 'dismiss' ? 'dismissed' : 'accepting', version: input.version,
        sourceItemId: proposal.sourceItemId, sourceEntryId: proposal.sourceEntryId, createdAt: hub.now(),
        createRequestId: 'followup:' + input.id, values: proposal.values });
    });
    if (decision.state === 'dismissed') return { saved: true, dismissed: true, id: input.id };
    try {
      // Re-evaluate authority immediately before routine creation. Its own
      // source binding then checks the same authority on every execution.
      if (!candidates().some(row => row.id === input.id && row.version === decision.version)) throw failure('FOLLOWUP_UNAVAILABLE');
      const result = await routines.action({ operation: 'create', requestId: decision.createRequestId, values: decision.values }, { beforeMutation: () => beforeCreate(decision) });
      hub.transaction(() => hub.put('followupDecision', { ...decision, state: 'accepted', routineId: result.routine.id, decidedAt: hub.now() }));
      return { saved: true, routine: result.routine, sourceItemId: decision.sourceItemId };
    } catch (error) {
      const recovered = await receipt(decision);
      if (recovered) return recovered;
      // Keep the durable intent for a retry; the UI can retry the same action.
      // Snapshot exposes it again only while no routine was actually created.
      throw error;
    }
  }
  return { snapshot, action };
}
