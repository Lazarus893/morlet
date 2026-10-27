import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const TEXT_LIMIT = 60_000;
const PUBLIC_QUERY = new Set(['id', 'p', 'page', 'article', 'story', 'item', 'v', 'lang', 'language']);
const TRACKING_QUERY = /^(?:utm_.+|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi)$/i;
const PRIVATE_SEGMENT = /(?:^|[^a-z\d])(?:action|auth|oauth|login|logout|signin|signout|signup|register|unsubscribe|subscribe|manage|preferences|settings|account|verify|confirm|activate|reset|password|token|email|emails|callback|redirect|tracking|track|click|pixel|beacon)(?:$|[^a-z\d])/i;
const PAYWALL_TEXT = /subscribe to (?:continue|keep) reading|sign in to (?:continue|keep) reading|this (?:article|story) is (?:only )?for subscribers|unlock (?:the |this )?(?:full )?(?:article|story)|订阅后(?:继续|阅读)|订阅(?:即可|以)阅读|登录后(?:继续|阅读)|付费后(?:继续|阅读)/i;
const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'TR', 'UL']);

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function clean(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[ \t\r\f]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function publicUrl(input, allowedHosts) {
  if (typeof input !== 'string' || input.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(input)) throw fail('ARTICLE_URL_REJECTED', 'Invalid public article URL.');
  let url;
  try { url = new URL(input); } catch { throw fail('ARTICLE_URL_REJECTED', 'Invalid public article URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(url.hostname) || url.hostname.includes(':')) throw fail('ARTICLE_URL_REJECTED', 'Articles require a public HTTPS domain on port 443.');
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) || host.endsWith('.home.arpa')) throw fail('ARTICLE_URL_REJECTED', 'Local or special-use hosts are not public articles.');
  if (allowedHosts && !allowedHosts.some((entry) => entry.startsWith('*.') ? host.endsWith(`.${entry.slice(2)}`) && host !== entry.slice(2) : host === entry)) throw fail('ARTICLE_HOST_NOT_ALLOWED', 'Article publisher is not in the configured public host list.');
  let path = url.pathname;
  try { for (let i = 0; i < 3; i++) { const next = decodeURIComponent(path); if (next === path) break; path = next; } } catch { throw fail('ARTICLE_URL_REJECTED', 'Invalid article path encoding.'); }
  if (/[\u0000-\u0020\u007f\\@%]/.test(path) || PRIVATE_SEGMENT.test(path) || path.split('/').some((segment) => /^[a-z\d_-]{48,}$/i.test(segment) && !segment.includes('-'))) throw fail('ARTICLE_URL_REJECTED', 'Private, action, or tracking links are not article sources.');
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_QUERY.test(name)) { url.searchParams.delete(name); continue; }
    if (!PUBLIC_QUERY.has(name.toLowerCase())) throw fail('ARTICLE_URL_REJECTED', 'Private or unsupported article query parameters.');
    const values = url.searchParams.getAll(name);
    if (values.length > 1 || values.some((value) => value.length > 160 || /[@\s\\/:]/.test(value) || /^[a-z\d_-]{48,}$/i.test(value))) throw fail('ARTICLE_URL_REJECTED', 'Private or unsupported article query values.');
  }
  url.hash = '';
  return url;
}

function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

function textOf(node) {
  const parts = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current === '\n') { parts.push('\n'); continue; }
    if (current.nodeType === 3) { parts.push(current.textContent); continue; }
    if (current.nodeType !== 1) continue;
    const block = BLOCKS.has(current.tagName);
    if (block || current.tagName === 'BR') parts.push('\n');
    if (block) stack.push('\n');
    const children = current.childNodes;
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return clean(parts.join(''));
}

function extractDocument(html, url) {
  const { document } = parseHTML(String(html));
  Object.defineProperty(document, 'documentURI', { value: url, configurable: true });
  Object.defineProperty(document, 'baseURI', { value: url, configurable: true });
  // Metadata can disclose an inaccessible article. It is parsed as data only.
  const paywall = Boolean(document.querySelector('[data-paywall], [class*="paywall" i], [id*="paywall" i], meta[property="article:content_tier"][content="locked"]'))
    || [...document.querySelectorAll('script[type="application/ld+json"]')].some((node) => /"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(node.textContent));
  for (const node of document.querySelectorAll('script, style, nav, footer, form, input, button, select, textarea, iframe, object, embed, img, video, audio, source, picture, link, base, noscript, template, svg, canvas, dialog, [hidden], [aria-hidden="true"]')) node.remove();
  const pageTitle = clean(document.querySelector('title')?.textContent);
  const article = new Readability(document, { charThreshold: 200, maxElemsToParse: 30_000, keepClasses: false }).parse();
  if (!article?.content) return { title: pageTitle, text: '', links: [], complete: false, reason: 'ARTICLE_NO_CONTENT' };
  const extracted = parseHTML(`<html><body>${article.content}</body></html>`).document;
  const text = textOf(extracted.body);
  const links = [];
  const seen = new Set();
  for (const link of extracted.querySelectorAll('a[href]')) {
    if (links.length >= 50) break;
    try {
      const href = publicUrl(new URL(link.getAttribute('href'), url).href).href;
      if (!seen.has(href)) { links.push({ url: href, label: clean(link.textContent).slice(0, 300) }); seen.add(href); }
    } catch { /* Do not propagate private or action URLs to the next reading step. */ }
  }
  const blocked = paywall || PAYWALL_TEXT.test(text);
  const complete = !blocked && text.length >= 200 && text.length <= TEXT_LIMIT;
  return {
    title: clean(article.title || pageTitle).slice(0, 1000), text: text.slice(0, TEXT_LIMIT), links, complete,
    reason: blocked ? 'ARTICLE_PAYWALL' : text.length < 200 ? 'ARTICLE_NO_CONTENT' : null,
  };
}

/** Extract readable static HTML only. No script or external resource is loaded. */
export function extractReadableDocument(html, url) {
  const { title, text, links, complete } = extractDocument(html, url);
  return { title, text, links, complete };
}

function secureRequest(url, { address, signal, headers }) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: 'GET', agent: false, rejectUnauthorized: true,
      servername: url.hostname, family: 4, signal, headers,
      // Pin this connection to the complete DNS answer that was checked above.
      lookup: (_host, options, callback) => options?.all
        ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
    }, (response) => resolve({ statusCode: response.statusCode, headers: response.headers, body: response }));
    req.on('error', reject);
    req.end();
  });
}

function closeBody(body) {
  if (typeof body?.destroy === 'function') body.destroy();
}

function checkAbort(signal) {
  if (signal.aborted) throw signal.reason || fail('ARTICLE_ABORTED', 'Article reading was cancelled.');
}

function abortable(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || fail('ARTICLE_ABORTED', 'Article reading was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function consumeBody(body, maxBytes, signal) {
  const chunks = [];
  let size = 0;
  try {
    const iterable = typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array ? [body] : body;
    if (!iterable?.[Symbol.asyncIterator] && !iterable?.[Symbol.iterator]) throw fail('ARTICLE_RESPONSE_INVALID', 'Article response has no readable body.');
    const iterator = iterable[Symbol.asyncIterator]?.() || iterable[Symbol.iterator]();
    try {
      for (;;) {
        const { done, value } = await abortable(iterator.next(), signal);
        if (done) break;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > maxBytes) throw fail('ARTICLE_TOO_LARGE', 'Article response exceeds the configured byte limit.');
        chunks.push(chunk);
      }
    } finally {
      if (signal.aborted || size > maxBytes) { closeBody(body); Promise.resolve(iterator.return?.()).catch(() => {}); }
    }
  } catch (error) { closeBody(body); throw error; }
  return Buffer.concat(chunks);
}

/** Public, allowlisted static article reader. request/lookup hooks exist for isolated tests. */
export function createPublicArticleReader({ allowedHosts = [], lookup = dnsLookup, request = secureRequest, now = Date.now, maxBytes = 1_500_000, timeoutMs = 15_000 } = {}) {
  if (!Array.isArray(allowedHosts) || allowedHosts.some((host) => typeof host !== 'string' || !/^(?:\*\.)?[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host) || (host.startsWith('*.') && !host.slice(2).includes('.')))) throw fail('ARTICLE_CONFIG_INVALID', 'Invalid configured public article hosts.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw fail('ARTICLE_CONFIG_INVALID', 'Invalid article reader byte or time limit.');
  const hosts = allowedHosts.map((host) => host.toLowerCase());
  return async (input, { signal: upstreamSignal } = {}) => {
    const controller = new AbortController();
    const signal = controller.signal;
    const abort = () => controller.abort(upstreamSignal.reason || fail('ARTICLE_ABORTED', 'Article reading was cancelled.'));
    if (upstreamSignal?.aborted) abort();
    else upstreamSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(fail('ARTICLE_TIMEOUT', 'Article reading exceeded the time limit.')), timeoutMs);
    let activeBody;
    try {
      let url = publicUrl(input, hosts);
      for (let redirects = 0; ; redirects++) {
        checkAbort(signal);
        const records = await abortable(lookup(url.hostname, { all: true, verbatim: true, family: 4 }), signal);
        if (!Array.isArray(records) || records.length === 0 || records.some((record) => record.family !== 4 || !isPublicIPv4(record.address))) throw fail('ARTICLE_DNS_REJECTED', 'All article DNS addresses must be public IPv4 addresses.');
        const response = await abortable(request(url, {
          address: records[0].address, family: 4, servername: url.hostname,
          signal, maxBytes, timeoutMs,
          headers: { Accept: 'text/html, application/xhtml+xml, text/plain;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'Xiaoman-PublicArticleReader/1.0' },
        }), signal);
        activeBody = response.body;
        const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          closeBody(activeBody); activeBody = null;
          if (redirects >= 3 || typeof headers.location !== 'string') throw fail('ARTICLE_REDIRECT_REJECTED', 'Article redirect limit reached or target missing.');
          url = publicUrl(new URL(headers.location, url).href, hosts);
          continue;
        }
        if (response.statusCode !== 200) throw Object.assign(fail('ARTICLE_HTTP_ERROR', 'Public article request was not successful.'), { statusCode: Number(response.statusCode) || 0 });
        const encoding = String(headers['content-encoding'] || 'identity').toLowerCase().trim();
        if (encoding !== 'identity') throw fail('ARTICLE_ENCODING_REJECTED', 'Compressed article bodies are not accepted.');
        const contentType = String(headers['content-type'] || '');
        const mime = contentType.split(';')[0].trim().toLowerCase();
        if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(mime)) throw fail('ARTICLE_TYPE_REJECTED', 'Article response must be HTML or plain text.');
        const length = headers['content-length'];
        if (length != null && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) throw fail('ARTICLE_TOO_LARGE', 'Article response exceeds the configured byte limit.');
        const bytes = await consumeBody(activeBody, maxBytes, signal);
        activeBody = null;
        const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] || 'utf-8';
        let body;
        try { body = new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { throw fail('ARTICLE_ENCODING_REJECTED', 'Article text encoding is unsupported or invalid.'); }
        let article;
        if (mime === 'text/plain') {
          const text = clean(body);
          if (text.length < 200 || PAYWALL_TEXT.test(text)) throw fail('ARTICLE_NO_CONTENT', 'No complete public article text was available.');
          article = { title: '', text: text.slice(0, TEXT_LIMIT), links: [], complete: text.length <= TEXT_LIMIT };
        } else {
          article = extractDocument(body, url.href);
          if (article.reason) throw fail(article.reason, 'No complete public article text was available.');
        }
        checkAbort(signal);
        const { title, text, links, complete } = article;
        const hash = createHash('sha256').update(JSON.stringify([url.href, title, text, complete])).digest('hex');
        return { url: url.href, title, text, links, complete, hash, readAt: now() };
      }
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener('abort', abort);
      closeBody(activeBody);
    }
  };
}
