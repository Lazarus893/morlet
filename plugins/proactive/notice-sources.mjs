import { readdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCLI } from '../connections/local-probes.mjs';
import { githubSource } from '../agent-hub/github-sources.mjs';

const DAY = 86400000;
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const sensitive = /password|verification|one.time|验证码|密码|账单|银行|支付|钱包|病历|医疗|体检|诊断|身份证|护照|secret|credential|invoice|statement|medical|health|wallet|bank|cancer|cancers|癌|肺病|finance|financial|portfolio|inflation|stock|crypto|commodity|commodities|stablecoin|bitcoin|ethereum|mortgage|payroll|seekingalpha|bloomberg|coingecko|milkroad|market|投资|证券|借贷|征信|工资|税单/i;
const clean = (value, max = 240) => typeof value === 'string' ? Array.from(value.replace(/[\x00-\x1f]/g, ' ')).slice(0, max).join('') : '';

// gog emits date strings in the CLI's timezone. The worker sets TZ explicitly;
// interpret those strings without relying on the server or host default zone.
export function mailInstant(value, timezone) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(value)) return NaN;
  const target = Date.parse(value.replace(' ', 'T') + ':00Z');
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant).map(p => [p.type, p.value]));
    const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
    instant += target - local;
  }
  return instant;
}

export function createNoticeSources({ runner = runCLI, home = homedir(), gog = 'gog', gh = 'gh', xTimeline, readSource, fs = { readdir, lstat } } = {}) {
  return async (sources, { now, timezone, signal, content = false, recheckCandidates }) => {
    const candidates = [], counts = {}, errors = [];
    const json = async (command, args, maxBytes = 65536) => {
      const r = await runner(command, args, { signal, timeoutMs: 30000, maxBytes });
      if (r.errorCode || r.exitCode !== 0) throw Object.assign(new Error('SOURCE_UNAVAILABLE'), { code: 'SOURCE_UNAVAILABLE' });
      return JSON.parse(r.stdout);
    };
    await Promise.all(sources.map(async source => {
      counts[source.id] = 0;
      try {
        const cloud = source.connectionProvider === 'nango';
        if (cloud && typeof readSource !== 'function') throw new Error('CLOUD_SOURCE_REQUIRED');
        const read = args => readSource(source, args, { signal });
        if (source.id === 'google-calendar') {
          if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(source.account || '') || source.account.startsWith('-')) throw 0;
          const result = cloud ? await read({ operation: 'calendar_events', from: new Date(now).toISOString(), to: new Date(now + DAY).toISOString(), max: 20 }) : await json(gog, ['calendar', 'events', 'primary', '--from', new Date(now).toISOString(), '--to', new Date(now + DAY).toISOString(), '--max', '20', '--json', '--no-input', '--account', source.account]);
          if (!Array.isArray(result.events)) throw 0;
          for (const event of result.events.slice(0, 20)) {
            counts[source.id]++;
            const startsAt = Date.parse(cloud ? event.allDay ? '' : event.start : event.start?.dateTime || ''), title = clean(event.summary);
            if (!event.id || event.status === 'cancelled' || sensitive.test(title) || !title || !Number.isFinite(startsAt) || startsAt <= now || startsAt > now + DAY || event.declined || event.attendees?.some(a => a.self && a.responseStatus === 'declined')) continue;
            candidates.push({ key: `google-calendar:${digest(source.account)}:${digest(event.id + ':' + startsAt)}`, source: source.id, kind: 'event', title, startsAt, expiresAt: startsAt, evidence: 'calendar_event' });
          }
        } else if (source.id === 'google-mail') {
          if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(source.account || '') || source.account.startsWith('-')) throw 0;
          const query = content ? 'in:inbox newer_than:7d -category:promotions' : 'is:unread in:inbox newer_than:2d -category:promotions -category:social';
          const result = cloud ? await read({ operation: 'mail_search', query, max: 20 }) : await json(gog, ['gmail', 'messages', 'search', query, '--max', '100', '--json', '--no-input', '--account', source.account], 512000);
          if (result?.messages === null && !result.error) result.messages = [];
          if (!Array.isArray(result.messages)) throw 0;
          for (const message of result.messages.slice(0, 100)) {
            counts[source.id]++;
            const title = clean(message.subject), at = cloud ? Date.parse(message.date) : mailInstant(message.date, timezone);
            const lifetime = (content ? 7 : 2) * DAY;
            if (!/^[a-f0-9]{1,64}$/.test(message.id || '') || !title || sensitive.test(title + ' ' + clean(message.from)) || !Number.isFinite(at) || at > now + 60000 || at + lifetime <= now) continue;
            // Sender display names and links are not proof of identity or of a
            // pending task. Supply only the header fact, never body or addresses.
            const thread = /^[a-f0-9]{1,64}$/.test(message.threadId || '') ? message.threadId : message.id;
            if (!candidates.some(c => c.key === `google-mail:${thread}`)) candidates.push({ key: `google-mail:${thread}`, source: source.id, kind: 'mail', mailId: message.id, title, at, expiresAt: at + lifetime, evidence: content ? 'mail_header' : 'unread_mail_header' });
          }
        } else if (source.id === 'github') {
          const user = cloud ? { login: source.account } : await json(gh, ['api', 'user', '--jq', '{login:.login}']);
          if (user.login !== source.account) throw 0;
          if (content) {
            const api = args => cloud ? read(args) : githubSource({ args, clean, secretContent: value => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value),
              json: (path, jq) => json(gh, ['api', path, '--hostname', 'github.com', '--method', 'GET', ...(jq ? ['--jq', jq] : [])], 1500000),
              starred: async repo => { const response = await runner(gh, ['api', 'user/starred/' + repo, '--hostname', 'github.com', '--method', 'GET', '--silent'], { signal, timeoutMs: 15000, maxBytes: 4096 }); return !response.errorCode && response.exitCode === 0; } });
            const since = new Date(now - 7 * DAY).toISOString();
            const push = ({ key, title, url, at, body, repo, coverage, notificationId }) => {
              if (!body?.text?.trim() || !Number.isFinite(at) || at > now + 60000 || at + 7 * DAY <= now) return;
              candidates.push({ key, source: 'github', kind: 'repository_update', title: clean(title), url, repo, at, expiresAt: at + 7 * DAY, ...(notificationId && { notificationId }),
                evidence: 'public_github_content', coverage, reading: { newsletter: false, sources: [{ id: 'github', type: 'primary', url, title: clean(title), text: body.text, complete: body.complete, hash: digest(body.text) }] } });
            };
            try {
              const notices = await api({ operation: 'github_notifications', since, max: 4, offset: Math.floor(now / (30 * 60000)),
                ...(recheckCandidates && { ids: recheckCandidates.filter(row => row.source === 'github' && row.notificationId).map(row => row.notificationId) }) });
              counts.github += notices.returnedCount;
              for (const note of notices.notifications) push({ key: `github:notification:${digest(source.account)}:${note.id}:${digest(note.updatedAt)}`, notificationId: note.id, title: note.title, url: note.url, repo: note.repo, at: Date.parse(note.updatedAt), body: note.body, coverage: note.coverage });
            } catch { errors.push('github'); }
            const repos = await api({ operation: 'github_repositories', kind: 'all', page: 1, pages: 1, perPage: 50 });
            const recent = repos.repositories.filter(repo => !repo.archived && Date.parse(repo.pushedAt) >= now - 7 * DAY).sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
            const offset = recent.length ? Math.floor(now / (30 * 60000)) % recent.length : 0;
            const selected = recheckCandidates ? [...new Set(recheckCandidates.filter(row => row.source === 'github' && row.repo && !row.notificationId).map(row => row.repo))] : [...recent.slice(offset), ...recent.slice(0, offset)].slice(0, 2).map(repo => repo.repo);
            for (const repo of selected) {
              try {
                const updates = await api({ operation: 'github_updates', repo, since, maxReleases: 2, maxCommits: 1, includePatches: false });
                counts.github += updates.releases.length + updates.commits.length;
                for (const release of updates.releases) push({ key: `github:release:${digest(repo)}:${release.id}`, title: `${repo} · ${release.name || release.tag}`, repo, url: release.url, at: Date.parse(release.publishedAt), body: release.body, coverage: '已读取发布说明；未运行软件或验证发布方的效果主张。' });
                for (const commit of updates.commits) push({ key: `github:commit:${digest(repo)}:${commit.sha}`, title: `${repo} · ${commit.message.text.split('\n')[0]}`, repo, url: commit.url, at: Date.parse(commit.committedAt), body: commit.message, coverage: '已读取默认分支提交说明；未读取完整 diff 或执行测试。' });
              } catch { errors.push('github'); }
            }
            const after = cloud ? { login: source.account } : await json(gh, ['api', 'user', '--jq', '{login:.login}']);
            if (after.login !== source.account) { for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].source === 'github') candidates.splice(i, 1); throw 0; }
            return;
          }
          const result = cloud ? (await read({ operation: 'review_requests', max: 10 })).requests : await json(gh, ['search', 'prs', '--review-requested', '@me', '--state', 'open', '--limit', '10', '--json', 'id,title,url,updatedAt,repository']);
          if (!Array.isArray(result)) throw 0;
          for (const pr of result.slice(0, 10)) {
            counts[source.id]++;
            const at = Date.parse(pr.updatedAt), title = clean(pr.title);
            if (!pr.id || !title || sensitive.test(title) || !Number.isFinite(at) || at + 7 * DAY <= now || !/^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/pull\/\d+$/.test(pr.url || '')) continue;
            candidates.push({ key: `github:review:${digest(source.account + ':' + String(pr.id))}`, source: source.id, kind: 'review_requested', title, url: pr.url, at, expiresAt: at + 7 * DAY, evidence: 'own_open_review_request' });
          }
        } else if (source.id === 'x') {
          if (!cloud && typeof xTimeline !== 'function') throw 0;
          const timeline = cloud ? await read({ operation: 'x_timeline', max: 20 }) : await xTimeline({ ...source, enabled: true }, { signal });
          counts.x = timeline.posts.length;
          for (const post of timeline.posts) {
            const at = Date.parse(post.createdAt);
            if (!post.text?.trim() || !Number.isFinite(at) || at > now + 60000 || at + 7 * DAY <= now) continue;
            candidates.push({ key: 'x:post:' + post.id, source: 'x', kind: 'social_post', title: clean(post.title || post.text, 120), url: post.url, at, expiresAt: at + 7 * DAY,
              evidence: 'x_timeline_post', coverage: '已读取关注时间线中的这条内容；作者观点未独立验证，外链和完整讨论未读取。',
              reading: { newsletter: false, sources: [{ id: 'x', type: 'primary', url: post.url, title: clean(post.title || post.text, 120), text: post.text, complete: post.complete, hash: digest(post.text) }] } });
          }
        } else if (source.id === 'local-files') {
          // No recursion, symlinks, bodies, paths, hidden files or application
          // stores. A filename is interest context, never evidence of a to-do.
          for (const folder of ['Downloads', 'Documents', 'Desktop']) {
            const dir = join(home, folder);
            let names;
            try { names = await fs.readdir(dir); } catch { errors.push('local-files'); continue; }
            for (const name of names.slice(0, 2000)) {
              if (name.startsWith('.') || sensitive.test(name) || /mock|验收|screenshot|录屏|截屏|截图/i.test(name) || !/\.(md|txt|pdf|docx|pptx)$/i.test(name)) continue;
              const st = await fs.lstat(join(dir, name));
              if (!st.isFile() || st.isSymbolicLink() || st.mtimeMs <= now - DAY || st.mtimeMs > now + 60000) continue;
              counts[source.id]++;
              candidates.push({ key: `local-files:${digest(folder + '/' + name + ':' + st.mtimeMs)}`, source: source.id, kind: 'interest_context', title: clean(name, 120), at: Math.floor(st.mtimeMs), expiresAt: Math.floor(st.mtimeMs) + DAY, evidence: 'filename_only' });
            }
          }
        }
      } catch { errors.push(source.id); }
    }));
    const localContext = candidates.filter(c => c.kind === 'interest_context').sort((a, b) => b.at - a.at).slice(0, 12);
    return { candidates: [...candidates.filter(c => c.kind !== 'interest_context'), ...localContext].sort((a, b) => (b.at || now) - (a.at || now)), counts, errors: [...new Set(errors)] };
  };
}
