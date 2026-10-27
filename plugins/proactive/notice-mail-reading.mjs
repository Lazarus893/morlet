import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCLI } from '../connections/local-probes.mjs';
import { parseHTML } from 'linkedom';

export const READING_CODES = new Set(['MAIL_UNAVAILABLE', 'INVALID_MAIL', 'SENSITIVE_MAIL', 'PRIVATE_CACHE_REQUIRED',
  'ARTICLE_URL_REJECTED', 'ARTICLE_HOST_NOT_ALLOWED', 'ARTICLE_DNS_REJECTED', 'ARTICLE_REDIRECT_REJECTED', 'ARTICLE_HTTP_ERROR', 'ARTICLE_TIMEOUT',
  'ARTICLE_NO_CONTENT', 'ARTICLE_PAYWALL', 'ARTICLE_RESPONSE_INVALID', 'ARTICLE_TYPE_REJECTED', 'ARTICLE_ENCODING_REJECTED', 'ARTICLE_TOO_LARGE',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH']);
const hash = text => createHash('sha256').update(text).digest('hex');
const redact = text => text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]').replace(/\b(?:\+?86[ -]?)?1[3-9]\d{9}\b/g, '[电话号码]');
const normalize = text => redact(text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\u200b-\u200f\ufeff]/g, '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{4,}/g, '\n\n').trim());
const hostAllowed = (host, hosts) => hosts.some(rule => rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule);
const FOOTER = /^(?:manage your subscriptions|manage your preferences|unsubscribe|stop receiving emails|share turing post|love tldr\?|you currently have .*referrals|if you have any comments or feedback)/im;
const PAYWALL = /upgrade to read the full|subscribe to (?:continue|read)|premium subscribers only|this is a preview/i;
const SENSITIVE_BODY = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:one.time|verification|security|验证码|动态密码)[ -]?(?:password|code|码)?\s*[:：]\s*[A-Z0-9]{4,10}\b|(?:social security|passport number|身份证号|银行卡号|诊断结果|病历号)\s*[:：]/i;
const MAIL_CACHE_REVISION = 2;

// Gmail already supplies a parsed MIME tree. Read only inline text parts;
// attachments and remote HTML resources are never fetched.
function inlineMessageText(message) {
  const pending = [message.payload], plain = [], html = [];
  for (let i = 0; i < pending.length && i < 100; i++) {
    const part = pending[i];
    if (!part || part.filename) continue;
    pending.push(...(part.parts || []).slice(0, 100));
    if (!['text/plain', 'text/html'].includes(part.mimeType) || typeof part.body?.data !== 'string') continue;
    const contentType = part.headers?.find(h => h.name?.toLowerCase() === 'content-type')?.value || '';
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
    const value = new TextDecoder(charset, { fatal: true }).decode(Buffer.from(part.body.data, 'base64url'));
    if (part.mimeType === 'text/plain') plain.push(value);
    else {
      const { document } = parseHTML(/<html[\s>]/i.test(value) ? value : '<html><body>' + value + '</body></html>');
      for (const node of document.querySelectorAll('script,style,iframe,object,embed,form,[hidden],[aria-hidden="true"]')) node.remove();
      for (const node of document.querySelectorAll('br,p,div,li,tr,td,h1,h2,h3')) node.appendChild(document.createTextNode('\n'));
      html.push(document.body?.textContent || document.documentElement?.textContent || document.textContent || '');
    }
  }
  const text = (plain.length ? plain : html).join('\n');
  if (!text.trim()) throw new Error('INVALID_MAIL');
  if (SENSITIVE_BODY.test(text)) throw new Error('SENSITIVE_MAIL');
  return normalize(text.replace(/https?:\/\/[^\s<>"'\[\]()]+/g, '[链接]'));
}

function readCache(path) {
  try { const st = statSync(path); if (st.mode & 0o077 || st.size > 2 * 1024 * 1024) throw new Error('PRIVATE_CACHE_REQUIRED'); return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function saveCache(path, value) {
  writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(path + '.tmp', path);
}

export function createMailReading({ directory, articleReader, publisherHosts = [], primaryHosts = [], topics = [], runner = runCLI, gog = 'gog', readMail, maxEmails = 8, maxArticles = 6, now = Date.now }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!Number.isInteger(maxEmails) || maxEmails < 1 || maxEmails > 20 || !Number.isInteger(maxArticles) || maxArticles < 0 || maxArticles > 12) throw new Error('INVALID_READING_LIMIT');
  return async (candidates, { sources, signal, recheck = false, evidenceByKey, onProgress = async () => {} }) => {
    const source = sources.find(s => s.id === 'google-mail'), account = source?.account;
    const cloud = source?.connectionProvider === 'nango';
    const loadMail = async args => {
      if (cloud) {
        if (typeof readMail !== 'function') throw new Error('MAIL_UNAVAILABLE');
        return readMail(source, { ...args, signal });
      }
      const command = args.threadId ? ['gmail', 'thread', 'get', args.threadId, '--full'] : ['gmail', 'get', args.messageId, '--format', 'full'];
      const response = await runner(gog, [...command, '--json', '--no-input', '--account', account], { signal, timeoutMs: 30000, maxBytes: 1500000 });
      if (response.errorCode || response.exitCode !== 0) throw new Error('MAIL_UNAVAILABLE');
      return JSON.parse(response.stdout);
    };
    const result = [], ignored = [], diagnostics = [], stats = { emailsRead: 0, articlesRead: 0, partial: 0, failed: 0, deferred: 0 };
    const recordFailure = (stage, error, key) => {
      const code = READING_CODES.has(error?.code || error?.message) ? error.code || error.message : error instanceof SyntaxError ? 'INVALID_SOURCE_JSON' : 'READING_FAILED';
      diagnostics.push({ stage, code, keyHash: hash(key), ...(Number.isInteger(error?.statusCode) && error.statusCode >= 100 && error.statusCode <= 599 && { statusCode: error.statusCode }) });
    };
    let usedEmails = 0, usedArticles = 0, usedChars = 0;
    const articlesSeen = new Set();
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      if (candidate.kind !== 'mail') { result.push(candidate); continue; }
      if (usedEmails >= maxEmails || usedChars > 140000) { stats.deferred++; continue; }
      if (!account || !/^[a-f0-9]{1,64}$/.test(candidate.mailId || '')) { stats.failed++; continue; }
      usedEmails++;
      await onProgress();
      try {
        const cachePath = join(directory, hash(account + ':' + candidate.mailId + (cloud ? ':nango:' + source.generation : '')) + '.json');
        let mail = !recheck && readCache(cachePath);
        if (!mail || mail.revision !== MAIL_CACHE_REVISION || mail.cachedAt < now() - 86400000) {
          const full = await loadMail({ messageId: candidate.mailId });
          if (full.message?.id !== candidate.mailId || typeof full.body !== 'string' || !full.body.trim() || cloud && full.bodyComplete !== true) throw new Error('INVALID_MAIL');
          const body = full.body;
          if (SENSITIVE_BODY.test(body)) throw new Error('SENSITIVE_MAIL');
          const rawLinks = [...body.matchAll(/https:\/\/[^\s<>"'\[\]()]+/g)].map(m => m[0].replace(/[.,;:!?]+$/, ''));
          const parts = [full.message.payload];
          for (let i = 0; i < parts.length && i < 100; i++) {
            const part = parts[i]; if (!part) continue;
            if (Array.isArray(part.parts)) parts.push(...part.parts.slice(0, 100));
            if (part.mimeType === 'text/html' && typeof part.body?.data === 'string' && part.body.data.length < 1500000) {
              const { document } = parseHTML(Buffer.from(part.body.data, 'base64url').toString('utf8'));
              for (const link of document.querySelectorAll('a[href]')) rawLinks.push(link.getAttribute('href'));
            }
          }
          const links = [...new Set(rawLinks)].filter(raw => {
            try { const url = new URL(raw); return hostAllowed(url.hostname, publisherHosts) && !/unsubscribe|subscribe|preferences|manage|\/mk\/|tracking|referral|\/(?:download|pricing|jobs|about|upgrade|advertise)(?:\/|$)/i.test(url.pathname + url.search); } catch { return false; }
          });
          const bodyWithoutLinks = body.replace(/https?:\/\/[^\s<>"'\[\]()]+/g, '[链接]');
          const footer = bodyWithoutLinks.search(FOOTER), main = normalize(footer >= 0 ? bodyWithoutLinks.slice(0, footer) : bodyWithoutLinks);
          const text = Array.from(main).slice(0, 40000).join('');
          const complete = Array.from(main).length <= 40000 && !PAYWALL.test(main);
          const history = [];
          let earlierOmitted = 0;
          const threadId = /^google-mail:([a-f0-9]{1,64})$/.exec(candidate.key)?.[1];
          // A reply's thread ID identifies its first message, not the selected
          // message. Earlier bodies are needed to explain changes accurately.
          if (threadId && threadId !== candidate.mailId) {
            await onProgress();
            const thread = (await loadMail({ threadId })).thread;
            if (thread?.id !== threadId || !Array.isArray(thread.messages) || thread.messages.some(m => m.threadId !== threadId || !/^[a-f0-9]{1,64}$/.test(m.id || '') || !/^\d+$/.test(String(m.internalDate)))) throw new Error('INVALID_MAIL');
            const ordered = [...thread.messages].sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
            const current = ordered.findIndex(m => m.id === candidate.mailId);
            // Do not summarize an inbox message after newer replies supersede it.
            if (current < 0 || current !== ordered.length - 1) throw new Error('INVALID_MAIL');
            const earlier = ordered.slice(0, current);
            earlierOmitted = Math.max(0, earlier.length - 4);
            for (const message of earlier.slice(-4)) {
              const fullText = inlineMessageText(message), text = Array.from(fullText).slice(0, 10000).join('');
              history.push({ id: 'mail-history-' + message.id, type: 'mail', context: 'earlier-in-thread', at: Number(message.internalDate), text,
                complete: text === fullText && !PAYWALL.test(fullText), hash: hash(text) });
            }
          }
          mail = { revision: MAIL_CACHE_REVISION, cachedAt: now(), newsletter: Boolean(full.unsubscribe), text, complete, hash: hash(text), links, history, earlierOmitted };
          saveCache(cachePath, mail);
        }
        if (!mail.text.trim()) { stats.partial++; ignored.push(candidate.key); continue; }
        usedChars += mail.text.length + mail.history.reduce((sum, source) => sum + source.text.length, 0);
        const evidence = [{ id: 'mail', type: 'mail', title: candidate.title, text: mail.text, complete: mail.complete, hash: mail.hash }, ...mail.history];
        if (mail.complete) stats.emailsRead++; else stats.partial++;
        const rank = links => links.map((url, index) => ({ url, score: topics.filter(topic => url.toLowerCase().includes(topic.toLowerCase())).length * 10 - index / 100 })).sort((a, b) => b.score - a.score);
        // Revalidate exactly the evidence used for this selection. A selected mail
        // previously sharing the batch article budget must not acquire extra
        // articles merely because it is now re-read alone.
        const expected = recheck ? evidenceByKey?.get(candidate.key) : undefined;
        const ranked = expected ? expected.filter(source => source.url).map(source => ({ url: source.url })) : rank(mail.links);
        for (let linkIndex = 0; linkIndex < ranked.length; linkIndex++) {
          const { url } = ranked[linkIndex];
          if (usedArticles >= maxArticles || usedChars > 180000) break;
          const pagePath = join(directory, 'article-' + hash(url) + '.json');
          let page = readCache(pagePath);
          try {
            signal?.throwIfAborted();
            if (recheck || !page || page.cachedAt < now() - 10 * 60000) {
              if (!articlesSeen.has(url)) usedArticles++;
              await onProgress();
              const read = await articleReader(url, { signal });
              page = { cachedAt: now(), url: read.url, title: normalize(read.title || ''), text: normalize(read.text), complete: read.complete === true, hash: read.hash, links: read.links || [] };
              saveCache(pagePath, page);
            } else if (!articlesSeen.has(url)) usedArticles++;
            usedChars += page.text.length;
            evidence.push({ id: expected?.find(source => source.url === url)?.id || 'article-' + evidence.length, type: hostAllowed(new URL(page.url).hostname, primaryHosts) ? 'primary' : 'secondary', url: page.url, title: page.title, text: page.text, complete: page.complete, hash: page.hash });
            if (!articlesSeen.has(page.url)) { if (page.complete) stats.articlesRead++; else stats.partial++; }
            articlesSeen.add(page.url); articlesSeen.add(url);
            if (!expected && !hostAllowed(new URL(page.url).hostname, primaryHosts)) {
              const originals = rank(page.links.map(l => l.url).filter(href => { try { return !evidence.some(s => s.url === href) && hostAllowed(new URL(href).hostname, primaryHosts); } catch { return false; } })).slice(0, 3);
              for (const item of originals) { const position = ranked.findIndex((value, index) => index > linkIndex && value.url === item.url); if (position >= 0) ranked.splice(position, 1); }
              ranked.splice(linkIndex + 1, 0, ...originals);
            }
            if (evidence.filter(source => source.url).length >= 2) break;
          } catch (error) { if (signal?.aborted || error.message === 'READING_PAUSED') throw error; stats.failed++; recordFailure('article', error, candidate.key); }
        }
        result.push({ ...candidate, evidence: 'mail_content_read', reading: { newsletter: mail.newsletter, earlierOmitted: mail.earlierOmitted, sources: evidence } });
      } catch (error) {
        if (signal?.aborted || error.message === 'READING_PAUSED') throw error;
        // Intentional privacy exclusions are completed skips, not broken sources.
        if (error.message === 'SENSITIVE_MAIL') { ignored.push(candidate.key); continue; }
        stats.failed++; recordFailure('mail', error, candidate.key);
      }
    }
    return { candidates: result, stats, ignored, diagnostics };
  };
}

const invalidReview = (detail, code = 'INVALID_READING_REVIEW') => Object.assign(new Error(code), { code, detail });
export function validateMailReviews(candidates, reviews, { content = false } = {}) {
  const mails = candidates.filter(c => content ? c.reading?.sources?.length : c.kind === 'mail');
  if (!Array.isArray(reviews) || reviews.length !== mails.length) throw invalidReview('count_mismatch');
  const byKey = new Map();
  for (const review of reviews) {
    const candidate = mails.find(c => c.key === review?.key);
    if (!candidate || byKey.has(review.key) || Object.keys(review).some(k => !['key', 'summary', 'relevance', 'suggestion', 'decision', 'evidence', ...(content ? ['save', 'topic', 'exploration', 'hook'] : [])].includes(k)) || !['skip', 'recommend'].includes(review.decision)) throw invalidReview('invalid_entry');
    if (content && (typeof review.save !== 'boolean' || typeof review.exploration !== 'boolean' || typeof review.topic !== 'string' || !review.topic.trim() || review.topic.length > 100)) throw invalidReview('invalid_entry');
    if (review.hook !== undefined && (typeof review.hook !== 'string' || !review.hook.trim() || review.hook.length > 120 || /[\x00-\x1f]/.test(review.hook))) throw invalidReview('invalid_text');
    for (const field of ['summary', 'relevance', 'suggestion']) if (typeof review[field] !== 'string' || !review[field].trim() || Array.from(review[field]).length > 600) throw invalidReview('invalid_text');
    if (review.decision === 'recommend' && (Array.from(review.summary.trim()).length < 40 || Array.from(review.relevance.trim()).length < 12 || Array.from(review.suggestion.trim()).length < 12)) throw invalidReview('insufficient_summary');
    if (!Array.isArray(review.evidence) || !review.evidence.length || review.evidence.length > 4) throw invalidReview('invalid_evidence');
    for (const cite of review.evidence) {
      const source = candidate.reading?.sources.find(s => s.id === cite?.sourceId);
      const shortSkip = source && review.decision === 'skip' && typeof cite.quote === 'string' && source.text.trim().length > 0 && source.text.trim().length < 10 && cite.quote === source.text.trim();
      if (!source) throw invalidReview('source_missing');
      if (Object.keys(cite).some(k => !['sourceId', 'quote'].includes(k)) || typeof cite.quote !== 'string' || !shortSkip && cite.quote.trim().length < 10 || cite.quote.length > 160 || cite.quote.trim().split(/\s+/).length > 25) throw invalidReview('quote_invalid');
      if (!source.text.includes(cite.quote)) throw invalidReview('quote_not_found');
    }
    if (review.decision === 'recommend' && candidate.reading.newsletter && !review.evidence.some(cite => candidate.reading.sources.some(s => s.id === cite.sourceId && s.type === 'primary' && s.complete))) throw invalidReview('primary_missing', 'PRIMARY_READING_REQUIRED');
    byKey.set(review.key, review);
  }
  return byKey;
}
