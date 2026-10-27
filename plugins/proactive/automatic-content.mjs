import { createHash } from 'node:crypto';
import { localTime } from './policy.mjs';
import { failure } from '../agent-hub/store.mjs';
import { reachOutPolicy } from './reach-out.mjs';

const scope = ['local', 'owner'];
const sources = ['google-mail', 'github', 'x'];
const names = { 'google-mail': '邮件', github: 'GitHub', x: 'X' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const defaults = { id: 'owner', revision: 0, enabled: false, discovery: true, maxDaily: 18, topics: [], sources, readingGuidance: '' };
const reactions = new Set(['useful', 'less', 'not_interested', 'clear', 'opened']);
const contentNote = entry => `${entry.summary}\n\n与你的关系：${entry.relevance}\n可选下一步：${entry.suggestion}\n\n${entry.exploration ? '探索话题' : '话题'}：${entry.topic}\n读取时间：${new Date(entry.observedAt).toISOString()}\n覆盖：${entry.coverage}\n${entry.evidence.map(cite => `来源摘录：${cite.quote}${cite.url ? '\n' + cite.url : ''}`).join('\n')}${entry.correction ? `\n\n内容更正（${new Date(entry.correction.at).toISOString()}）：${entry.correction.reason}` : ''}`;

// Both the observer and the final write apply the same bounded selection. The
// model judges substance; explicit preferences and publication limits are ours.
export function selectAutomaticContent(entries, content, limit = 6) {
  const topics = new Map(content.topics.map(topic => [topic.name, topic]));
  const available = Math.max(0, content.maxDaily - content.today);
  let explorationLeft = content.discovery ? Math.max(0, Math.floor(content.maxDaily / 4) - (content.explorationToday || 0)) : 0;
  const counts = new Map(), selected = [], rejected = [];
  const ranked = entries.map((entry, index) => {
    const topic = topics.get(entry.topic), score = topic?.reduced ? Math.min(-2, topic.score) : topic?.score || 0;
    const exploration = topic?.origin !== 'seed' && !(score > 0 && topic?.explicitSignals > 0);
    return { entry: { ...entry, exploration }, topic, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  // When there is a useful adjacent discovery, reserve one place among a
  // normal-sized batch. Do not manufacture a topic merely to fill that place.
  const discovery = explorationLeft && Math.min(limit, available) >= 4 && ranked.find(row => row.entry.exploration && !row.topic?.muted && row.score >= 0);
  if (discovery && ranked.indexOf(discovery) > 2) ranked.splice(2, 0, ranked.splice(ranked.indexOf(discovery), 1)[0]);
  for (const { entry, topic, score } of ranked) {
    let reason;
    const count = counts.get(entry.topic) || 0;
    if (topic?.muted) reason = 'topic_preference';
    else if (score < 0 && (topic.today || 0) + count >= 1) reason = 'topic_reduced';
    else if (entry.exploration && !explorationLeft) reason = 'topic_preference';
    else if (selected.length >= Math.min(limit, available)) reason = 'content_budget';
    else if (count >= (score > 0 ? 3 : 2)) reason = 'topic_diversity';
    if (reason) { rejected.push({ key: entry.key, skipped: reason }); continue; }
    selected.push({ ...entry, learning: {
      version: content.learning?.version || null,
      reason: entry.exploration ? 'exploration' : score > 0 ? 'preferred' : score < 0 ? 'reduced' : 'relevant',
      score, signals: topic?.explicitSignals || 0,
      feedbackIds: topic?.feedbackIds || [],
      guidanceApplied: !!content.readingGuidance,
    } });
    counts.set(entry.topic, count + 1);
    if (entry.exploration) explorationLeft--;
  }
  return { selected, rejected };
}

// Content uses the existing journal transaction and collection contract. Receipts
// live in the same SQLite transaction as the visible entries, including on retry.
export function createAutomaticContent({ hub, journal }) {
  const store = journal.store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS journal_content_entries (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, data TEXT NOT NULL
  )`);
  const rows = () => store.db.prepare('SELECT data FROM journal_content_entries ORDER BY rowid DESC LIMIT 3000').all().map(row => JSON.parse(row.data));
  const policy = () => ({ ...defaults, ...hub.get('automaticContentPolicy', 'owner') });
  function topics(day = localTime(hub.now(), reachOutPolicy(hub).timezone).day) {
    const values = new Map(policy().topics.map(name => [name, { name, score: 0, origin: 'seed', signals: 0, explicitSignals: 0, today: 0, feedbackIds: [] }]));
    for (const row of rows()) {
      const topic = values.get(row.topic) || { name: row.topic, score: 0, origin: 'discovered', signals: 0, explicitSignals: 0, today: 0, feedbackIds: [] };
      const score = ({ useful: 3, less: -2, not_interested: -6 })[row.feedback] || 0;
      topic.score += score + (row.openedAt ? 0.25 : 0);
      if (row.feedback === 'not_interested') topic.muted = true;
      if (row.feedback === 'less') topic.reduced = true;
      if (row.feedback || row.openedAt) topic.signals++;
      if (row.feedback) { topic.explicitSignals++; if (topic.feedbackIds.length < 8) topic.feedbackIds.push(row.id); }
      if (row.day === day) topic.today++;
      values.set(row.topic, topic);
    }
    return [...values.values()].map(topic => ({ ...topic, score: topic.reduced ? Math.min(-2, topic.score) : topic.score, muted: topic.muted === true }))
      .sort((a, b) => b.score - a.score || b.signals - a.signals);
  }
  function snapshot({ bridge = false, internal = false, timezone = reachOutPolicy(hub).timezone } = {}) {
    const p = policy(), entries = rows(), day = localTime(hub.now(), timezone).day;
    const feedback = entries.filter(row => row.feedbackAt || row.feedback || row.openedAt).sort((a, b) => (b.feedbackAt || b.openedAt) - (a.feedbackAt || a.openedAt));
    const learning = { version: hash([p.topics, p.discovery, p.readingGuidance, feedback.map(row => [row.id, row.feedback || null, !!row.openedAt, row.feedbackRevision || 0]).sort((a, b) => a[0].localeCompare(b[0]))]),
      explicitSignals: feedback.filter(row => row.feedback).length, lastFeedbackAt: Math.max(0, ...feedback.map(row => row.feedbackAt || 0)) || null,
      ...(bridge && { readingGuidance: p.readingGuidance, examples: feedback.filter(row => row.feedback).slice(0, 20).map(({ id, title, topic, feedback }) => ({ id, title, topic, reaction: feedback })) }) };
    const publicEntries = entries.slice(0, 200).map(({ id, itemId, entryId, source, topic, exploration, feedback, openedAt, observedAt, savedAt, title, hook, learning }) =>
      ({ id, itemId, entryId, source, topic, exploration, feedback: feedback || null, openedAt: openedAt || null, observedAt, savedAt, title, hook, learning }));
    return { ...p, topics: internal ? topics(day) : topics(day).slice(0, 40), configuredTopics: p.topics, today: entries.filter(entry => entry.day === day).length,
      explorationToday: entries.filter(entry => entry.day === day && entry.exploration).length, learning,
      ...(bridge ? { published: entries.slice(0, 1000).map(({ key, source, accountHash, sourceGeneration, savedAt, topic }) => ({ key, source, accountHash, sourceGeneration, savedAt, topic })) } : { entries: publicEntries }) };
  }
  function configure(input) {
    if (!exact(input, ['operation', 'revision', 'enabled', 'discovery', 'topics', 'sources', 'maxDaily', 'readingGuidance']) ||
      typeof input.enabled !== 'boolean' || typeof input.discovery !== 'boolean' ||
      !Array.isArray(input.topics) || input.topics.length > 20 || input.topics.some(topic => !text(topic, 100)) ||
      new Set(input.topics).size !== input.topics.length || !Array.isArray(input.sources) || !input.sources.length ||
      input.sources.some(source => !sources.includes(source)) || new Set(input.sources).size !== input.sources.length ||
      !Number.isInteger(input.maxDaily) || input.maxDaily < 1 || input.maxDaily > 40 ||
      input.readingGuidance !== undefined && (typeof input.readingGuidance !== 'string' || input.readingGuidance.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.readingGuidance))) throw failure('INVALID_INPUT');
    hub.transaction(() => {
      if (input.revision !== policy().revision) throw failure('VERSION_CONFLICT');
      const { operation, ...value } = input;
      hub.put('automaticContentPolicy', { ...value, readingGuidance: input.readingGuidance ?? policy().readingGuidance, id: 'owner', revision: input.revision + 1 });
    });
    return snapshot();
  }
  function feedback(input) {
    if (!exact(input, ['operation', 'id', 'reaction']) || !/^[a-f0-9]{64}$/.test(input.id || '') || !reactions.has(input.reaction)) throw failure('INVALID_INPUT');
    store.transaction(() => {
      const stored = store.db.prepare('SELECT data FROM journal_content_entries WHERE id = ?').get(input.id);
      if (!stored) throw failure('ITEM_NOT_FOUND');
      const row = JSON.parse(stored.data);
      if (input.reaction === 'opened') row.openedAt ||= hub.now();
      else if (row.feedback !== (input.reaction === 'clear' ? null : input.reaction)) {
        row.feedback = input.reaction === 'clear' ? null : input.reaction; row.feedbackAt = hub.now(); row.feedbackRevision = (row.feedbackRevision || 0) + 1;
      }
      store.db.prepare('UPDATE journal_content_entries SET data = ? WHERE id = ?').run(JSON.stringify(row), input.id);
    });
    return snapshot();
  }
  // Owner-reviewed corrections update the existing journal material and teaser
  // together. They never create a publication, reset feedback or send a notice.
  function correct(input) {
    const fields = ['summary', 'hook', 'relevance', 'suggestion', 'coverage', 'evidence'];
    if (!exact(input, ['operation', 'id', 'revision', 'reason', ...fields]) || !/^[a-f0-9]{64}$/.test(input.id || '') ||
      !text(input.reason, 500) || !text(input.hook, 120) || !['summary', 'relevance', 'suggestion', 'coverage'].every(key => text(input[key], 1200)) ||
      !Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 4 ||
      input.evidence.some(cite => !exact(cite, ['quote', 'url', 'complete', 'type']) || !text(cite.quote, 160) || typeof cite.complete !== 'boolean' ||
        !['mail', 'primary', 'secondary'].includes(cite.type) || cite.url !== null && (typeof cite.url !== 'string' || !/^https:\/\//.test(cite.url)))) throw failure('INVALID_INPUT');
    store.transaction(() => {
      const state = store.read(scope);
      if (input.revision !== state.revision) throw failure('VERSION_CONFLICT');
      const stored = store.db.prepare('SELECT data FROM journal_content_entries WHERE id = ?').get(input.id);
      if (!stored) throw failure('ITEM_NOT_FOUND');
      const row = JSON.parse(stored.data), item = state.items.find(item => item.id === row.itemId);
      const entry = item?.taskData?.collection?.entries.find(entry => entry.id === row.entryId);
      if (!entry || ['done', 'cancelled'].includes(item.status)) throw failure('INVALID_STATE');
      const correction = { at: hub.now(), reason: input.reason, previous: Object.fromEntries(fields.map(key => [key, row[key]])) };
      Object.assign(row, Object.fromEntries(fields.map(key => [key, input[key]])), { correction });
      const taskData = structuredClone(item.taskData);
      taskData.collection.entries.find(entry => entry.id === row.entryId).note = contentNote(row);
      store.apply(state, { operation: 'update', revision: state.revision, itemId: item.id, itemVersion: item.version, values: { taskData } });
      store.db.prepare('UPDATE journal_content_entries SET data = ? WHERE id = ?').run(JSON.stringify(row), row.id);
      store.save(scope, state);
    });
    return snapshot();
  }
  function publish(input, authorizedSources, timezone) {
    const p = policy();
    if (!p.enabled) return { accepted: false, blocked: 'content_paused' };
    if (!exact(input, ['operation', 'entries']) || !Array.isArray(input.entries) || !input.entries.length || input.entries.length > 6 ||
      Buffer.byteLength(JSON.stringify(input)) > 60000) throw failure('INVALID_INPUT');
    const validated = input.entries.map(entry => {
      if (!exact(entry, ['key', 'source', 'sourceGeneration', 'title', 'summary', 'relevance', 'suggestion', 'topic', 'exploration', 'url', 'observedAt', 'expiresAt', 'evidence', 'coverage', 'preferenceVersion', 'hook']) ||
        !p.sources.includes(entry.source) || !text(entry.key, 256) || !text(entry.title, 250) ||
        !['summary', 'relevance', 'suggestion'].every(key => text(entry[key], 1200)) || !text(entry.topic, 100) ||
        typeof entry.exploration !== 'boolean' || !Number.isSafeInteger(entry.observedAt) || entry.observedAt > hub.now() + 60000 ||
        hub.now() - entry.observedAt > 86400000 || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= hub.now() ||
        !text(entry.coverage, 1000) || !Array.isArray(entry.evidence) || !entry.evidence.length || entry.evidence.length > 4 ||
        entry.preferenceVersion !== undefined && !/^[a-f0-9]{64}$/.test(entry.preferenceVersion) ||
        entry.hook !== undefined && !text(entry.hook, 120) ||
        entry.evidence.some(cite => !exact(cite, ['quote', 'url', 'complete', 'type']) || !text(cite.quote, 160) ||
          typeof cite.complete !== 'boolean' || !['mail', 'primary', 'secondary'].includes(cite.type))) throw failure('INVALID_INPUT');
      const grant = authorizedSources.find(source => source.id === entry.source);
      if (!grant || !Number.isSafeInteger(entry.sourceGeneration) || grant.generation !== entry.sourceGeneration) throw failure('SOURCE_AUTHORITY_CHANGED');
      const safeURL = value => {
        if (value === null) return null;
        let url; try { url = new URL(value); } catch { throw failure('INVALID_INPUT'); }
        if (url.protocol !== 'https:' || url.username || url.password || value.length > 2048) throw failure('INVALID_INPUT');
        return url.href;
      };
      safeURL(entry.url);
      for (const cite of entry.evidence) safeURL(cite.url);
      const accountHash = hash((grant.account || '').toLowerCase()), id = hash([entry.source, accountHash, entry.key]);
      return { ...entry, accountHash, id };
    });
    return store.transaction(() => {
      const state = store.read(scope), day = localTime(hub.now(), timezone).day;
      const priorRows = rows(), receipts = [];
      const current = snapshot({ timezone, internal: true });
      const freshEntries = validated.filter(entry => !priorRows.some(row => row.id === entry.id));
      const stale = freshEntries.filter(entry => entry.preferenceVersion && entry.preferenceVersion !== current.learning.version);
      receipts.push(...stale.map(entry => ({ key: entry.key, skipped: 'preferences_changed' })));
      const selection = selectAutomaticContent(freshEntries.filter(entry => !stale.includes(entry)), current);
      receipts.push(...selection.rejected);
      const selected = new Map(selection.selected.map(entry => [entry.id, entry]));
      for (const entry of validated) {
        const prior = store.db.prepare('SELECT data FROM journal_content_entries WHERE id = ?').get(entry.id);
        if (prior) { const row = JSON.parse(prior.data); receipts.push({ key: entry.key, id: row.id, itemId: row.itemId, replayed: true }); continue; }
        if (!selected.has(entry.id)) continue;
        Object.assign(entry, selected.get(entry.id));
        const group = `${day}:${entry.source}`;
        const previous = priorRows.find(row => row.group === group);
        let item = previous && state.items.find(item => item.id === previous.itemId);
        // A user's deletion/closure must not silently resurrect a digest.
        if (previous && (!item || ['done', 'cancelled'].includes(item.status))) { receipts.push({ key: entry.key, skipped: 'journal_closed' }); continue; }
        if (!item) {
          store.apply(state, { operation: 'add', revision: state.revision, values: {
            title: `${day} · ${names[entry.source]}整理`, kind: 'experience', taskType: 'collection',
            note: '小满自动整理的来源材料。观点与建议供参考，未核实之处会明确标注；不会自动变成你的待办。',
            taskData: { collection: { entries: [] } },
            source: { kind: 'automatic', channel: 'background', text: `已授权的${names[entry.source]}自动整理`, at: new Date(hub.now()).toISOString() },
          } }, { timeZone: timezone });
          item = state.items.at(-1);
        }
        const entryId = 'auto-' + entry.id.slice(0, 24);
        const note = contentNote(entry);
        store.apply(state, { operation: 'widget', revision: state.revision, itemId: item.id, itemVersion: item.version,
          values: { kind: 'collection', action: 'add-entry', entry: { id: entryId, title: entry.title, note, url: entry.url } } }, { timeZone: timezone });
        const row = { ...entry, itemId: item.id, entryId, group, day, savedAt: hub.now(), feedback: null };
        store.db.prepare('INSERT INTO journal_content_entries(id,item_id,data) VALUES(?,?,?)').run(row.id, row.itemId, JSON.stringify(row));
        priorRows.push(row);
        receipts.push({ key: entry.key, id: row.id, itemId: row.itemId, replayed: false });
      }
      store.save(scope, state);
      receipts.sort((a, b) => input.entries.findIndex(entry => entry.key === a.key) - input.entries.findIndex(entry => entry.key === b.key));
      return { accepted: true, receipts, revision: state.revision };
    });
  }
  return { snapshot, configure, feedback, correct, publish, policy };
}
