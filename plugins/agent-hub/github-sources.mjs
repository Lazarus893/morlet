import { failure } from './store.mjs';

// REST contracts: docs.github.com/en/rest/activity/{watching,starring},
// /releases/releases and /commits/commits. This module only builds fixed GETs.
export const validRepository = value => typeof value === 'string' && value.length <= 140 && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) && !['.', '..'].includes(value.split('/')[1]);
const publicRepository = repo => repo?.private === false && (repo.visibility === undefined || repo.visibility === 'public') && validRepository(repo.full_name);
const semantics = { watching: 'Repository notification subscriptions; distinct from stars.', starred: 'Bookmarked repositories; stars do not subscribe to notifications.' };
const repositoryFields = 'map({full_name,private,visibility,description,pushed_at,updated_at,archived})';

export async function githubSource({ args, json, starred, clean, secretContent }) {
  const text = (value, max = 500) => {
    if (typeof value === 'string' && secretContent(value)) throw failure('SOURCE_SENSITIVE_CONTENT');
    return clean(value, max);
  };
  const date = value => { const supplied = text(value, 100), parsed = Date.parse(supplied); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''; };
  const description = value => {
    const original = text(value, Number.MAX_SAFE_INTEGER), chars = Array.from(original); let result = '';
    for (const char of chars.slice(0, 120)) { const next = result + char; if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 256) break; result = next; }
    return { description: result, descriptionTruncated: result !== original };
  };
  if (args.operation === 'github_notifications') {
    const since = new Date(args.since).toISOString(), perPage = 50;
    const batch = await json(`notifications?all=true&since=${encodeURIComponent(since)}&per_page=${perPage}&page=1`);
    if (!Array.isArray(batch) || batch.length > perPage) throw failure('INVALID_SOURCE_RESPONSE');
    const publicRows = batch.filter(row => publicRepository(row.repository));
    const offset = publicRows.length ? (args.offset || 0) % publicRows.length : 0;
    const selected = args.ids ? publicRows.filter(row => args.ids.includes(String(row.id))) :
      [...publicRows.slice(offset), ...publicRows.slice(0, offset)].slice(0, args.max ?? 4), notifications = [];
    for (const row of selected) {
      const repo = row.repository.full_name;
      const match = /^https:\/\/api\.github\.com\/repos\/([^/?#]+\/[^/?#]+)\/(pulls|issues|releases)\/(\d+)$/.exec(row.subject?.url || '');
      if (!match || match[1].toLowerCase() !== repo.toLowerCase() || !/^\d{1,30}$/.test(String(row.id))) continue;
      const detail = await json(`repos/${repo}/${match[2]}/${match[3]}`, '{title,name,body:(.body // \"\")[:6001],html_url,updated_at,state}');
      if (!/^https:\/\/github\.com\//.test(detail.html_url || '') || typeof detail.body !== 'string') throw failure('INVALID_SOURCE_RESPONSE');
      notifications.push({ id: String(row.id), repo, reason: text(row.reason, 60), unread: row.unread === true,
        title: text(detail.title || detail.name || row.subject.title, 240), url: detail.html_url,
        updatedAt: date(row.updated_at), body: { text: text(detail.body, 6000), complete: detail.body.length <= 6000 },
        coverage: '公开通知对应条目的正文；评论、完整改动与外部链接未读取。通知不代表用户承诺的待办。' });
    }
    return { notifications, returnedCount: batch.length, excludedPrivate: batch.length - publicRows.length,
      truncated: batch.length === perPage || publicRows.length > selected.length, onlyPublic: true };
  }
  if (args.operation === 'github_repositories') {
    const kinds = args.kind && args.kind !== 'all' ? [args.kind] : ['watching', 'starred'];
    const first = args.page ?? 1, pages = args.pages ?? 1, perPage = args.perPage ?? 20, repositories = new Map(), coverage = {};
    for (const kind of kinds) {
      let exhausted = false, error, fetchedPages = 0, scanned = 0, excludedPrivate = 0;
      for (let page = first; page < first + pages; page++) {
        let batch;
        try { batch = await json(`user/${kind === 'watching' ? 'subscriptions' : 'starred'}?per_page=${perPage}&page=${page}`, repositoryFields); }
        catch (failure) { if (failure.code !== 'SOURCE_UNAVAILABLE') throw failure; error = 'SOURCE_UNAVAILABLE'; break; }
        if (!Array.isArray(batch) || batch.length > perPage) throw failure('INVALID_SOURCE_RESPONSE');
        fetchedPages++; scanned += batch.length;
        for (const repo of batch) {
          if (!publicRepository(repo)) { excludedPrivate++; continue; }
          const key = repo.full_name.toLowerCase(), prior = repositories.get(key);
          if (prior) { if (!prior.followedVia.includes(kind)) prior.followedVia.push(kind); continue; }
          repositories.set(key, { repo: repo.full_name, url: `https://github.com/${repo.full_name}`, ...description(repo.description), pushedAt: date(repo.pushed_at), updatedAt: date(repo.updated_at), archived: repo.archived === true, followedVia: [kind] });
        }
        if (batch.length < perPage) { exhausted = true; break; }
      }
      const complete = first === 1 && exhausted && !error;
      coverage[kind] = { semantics: semantics[kind], fromPage: first, pagesRead: fetchedPages, perPage, scanned, excludedPrivate, complete, truncated: !complete, nextPage: exhausted || first + fetchedPages > 100 ? null : first + fetchedPages, limitReached: !exhausted && first + fetchedPages > 100,
        ...(error ? { error, note: 'GitHub did not provide this list. This is not evidence that the user follows no repositories.' } : {}) };
    }
    const result = { repositories: [...repositories.values()], onlyPublic: true, kinds, coverage, metadataTruncated: [...repositories.values()].some(repo => repo.descriptionTruncated) };
    result.complete = Object.values(coverage).every(value => value.complete) && !result.metadataTruncated;
    result.truncated = Object.values(coverage).some(value => value.truncated) || result.metadataTruncated;
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') >= 480 * 1024) throw failure('SOURCE_RESULT_TOO_LARGE');
    return result;
  }

  const repo = args.repo, prefix = 'repos/' + repo;
  let watching = false;
  try {
    const subscription = await json(prefix + '/subscription', '{subscribed,ignored}');
    if (typeof subscription.subscribed !== 'boolean' || typeof subscription.ignored !== 'boolean') throw failure('INVALID_SOURCE_RESPONSE');
    watching = subscription.subscribed && !subscription.ignored;
  } catch (error) { if (error.code !== 'SOURCE_UNAVAILABLE') throw error; }
  const saved = watching ? false : await starred(repo);
  if (!watching && !saved) throw failure('SOURCE_REPOSITORY_NOT_VERIFIED');
  const metadata = async () => {
    const value = await json(prefix, '{full_name,private,visibility,description,default_branch}');
    if (!publicRepository(value)) throw failure('SOURCE_PUBLIC_REPOSITORY_REQUIRED');
    if (value.full_name.toLowerCase() !== repo.toLowerCase()) throw failure('SOURCE_REPOSITORY_CHANGED');
    return value;
  };
  const info = await metadata(), maxReleases = args.maxReleases ?? 2, maxCommits = args.maxCommits ?? 2;
  const since = args.since ? new Date(args.since).toISOString() : null;
  const rawReleases = await json(`${prefix}/releases?per_page=${maxReleases + 1}&page=1`, 'map({id,name,tag_name,body:(if .body == null then null else .body[:10001] end),draft,prerelease,published_at})');
  const rawCommits = await json(`${prefix}/commits?per_page=${maxCommits + 1}&page=1${since ? '&since=' + encodeURIComponent(since) : ''}`, 'map({sha,commit:{message:.commit.message[:4001],committer:{date:.commit.committer.date}}})');
  if (!Array.isArray(rawReleases) || rawReleases.length > maxReleases + 1 || !Array.isArray(rawCommits) || rawCommits.length > maxCommits + 1) throw failure('INVALID_SOURCE_RESPONSE');
  let remaining = 20000, clipped = false;
  const body = (value, limit) => {
    const original = typeof value === 'string' ? value : '', chars = Array.from(text(original, Number.MAX_SAFE_INTEGER));
    const kept = chars.slice(0, Math.min(limit, remaining)); remaining -= kept.length;
    const truncated = chars.length > kept.length; clipped ||= truncated;
    return { text: kept.join(''), complete: !truncated, truncated };
  };
  const published = rawReleases.filter(value => value.draft === false && typeof value.published_at === 'string' && Number.isFinite(Date.parse(value.published_at)) && (!since || Date.parse(value.published_at) >= Date.parse(since)));
  const releases = published.slice(0, maxReleases).map(value => {
    if (!Number.isSafeInteger(value.id) || value.id < 1 || (value.body !== null && typeof value.body !== 'string') || typeof value.tag_name !== 'string' || !value.tag_name || value.tag_name.length > 1024 || /[\x00-\x1f\x7f]/.test(value.tag_name)) throw failure('INVALID_SOURCE_RESPONSE');
    const tag = text(value.tag_name, 200);
    return { id: value.id, name: text(value.name), tag, url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(value.tag_name)}`, publishedAt: value.published_at, prerelease: value.prerelease === true, bodyAvailable: typeof value.body === 'string' && Boolean(value.body.trim()), body: body(value.body, 10000) };
  });
  const commits = [];
  for (const summary of rawCommits.slice(0, maxCommits)) {
    if (typeof summary.sha !== 'string' || !/^[a-fA-F0-9]{40,64}$/.test(summary.sha) || typeof summary.commit?.message !== 'string') throw failure('INVALID_SOURCE_RESPONSE');
    const entry = { sha: summary.sha, url: `https://github.com/${repo}/commit/${summary.sha}`, committedAt: text(summary.commit.committer?.date, 50), message: body(summary.commit.message, 4000), patchesRead: args.includePatches !== false };
    if (entry.patchesRead) {
      const detail = await json(`${prefix}/commits/${summary.sha}?per_page=3&page=1`, '{sha,files:[.files[]|{filename,status,patch:(if .patch == null then null else .patch[:2001] end)}],stats:{additions:.stats.additions,deletions:.stats.deletions}}');
      if (detail.sha !== summary.sha || !Array.isArray(detail.files) || detail.files.length > 3) throw failure('INVALID_SOURCE_RESPONSE');
      entry.stats = { additions: Number.isSafeInteger(detail.stats?.additions) ? detail.stats.additions : null, deletions: Number.isSafeInteger(detail.stats?.deletions) ? detail.stats.deletions : null };
      entry.files = detail.files.map(file => ({ filename: text(file.filename, 500), status: text(file.status, 30), patchAvailable: typeof file.patch === 'string', patch: body(file.patch, 2000) }));
      entry.filesComplete = detail.files.length < 3;
      entry.fullDiffRead = false;
      entry.patchCoverage = 'GitHub JSON patch excerpts only; binary or large patches may be omitted. This is not a full commit diff.';
    }
    commits.push(entry);
  }
  await metadata();
  const releaseComplete = rawReleases.length < maxReleases + 1 && published.length <= maxReleases;
  const commitComplete = rawCommits.length <= maxCommits;
  return { repo: info.full_name, url: `https://github.com/${info.full_name}`, description: text(info.description, 400), followedVia: watching ? ['watching'] : ['starred'], onlyPublic: true, since, releases, commits,
    coverage: { releaseScope: 'First release API page filtered to published releases and the requested publishedAt lower bound; draft releases and unassociated tags are excluded.', releasesComplete: releaseComplete, releasesTruncated: !releaseComplete,
      commitScope: `Default branch (${text(info.default_branch, 100) || 'unknown'}), first API page${since ? ' since the requested timestamp' : ' only'}.`, commitsComplete: commitComplete, commitsTruncated: !commitComplete, textTruncated: clipped, noExternalLinksRead: true },
    complete: releaseComplete && commitComplete && !clipped && commits.every(commit => !commit.patchesRead || commit.filesComplete && commit.files.every(file => file.patchAvailable && file.patch.complete)),
    truncated: !releaseComplete || !commitComplete || clipped || commits.some(commit => commit.patchesRead && (!commit.filesComplete || commit.files.some(file => !file.patchAvailable || file.patch.truncated))) };
}
