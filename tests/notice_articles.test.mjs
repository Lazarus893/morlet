import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicArticleReader, extractReadableDocument } from '../plugins/proactive/notice-articles.mjs';

const ARTICLE = `<!doctype html><html><head><title>Keeping a household journal</title><base href="https://tracker.example/"><style>never read the stylesheet</style><script>globalThis.noticeArticleScriptExecuted = true;</script></head><body><nav>Navigation that is not the article</nav><main><article><h1>Keeping a household journal</h1><p>A useful household journal preserves the reasons behind an arrangement as well as the date. For a birthday dinner, the guest count, dietary preferences, and the most recent decision belong together so that a changed date does not lose the rest of the plan.</p><p>The assistant should distinguish a proposed booking from a confirmed reservation. If a restaurant has not acknowledged the request, the journal must show that the reservation is pending and retain enough evidence to continue later without making a duplicate request.</p><p>Good follow-up is selective. A reminder should explain the concrete situation and offer one next step, while routine checks remain in the background. A quiet evening is a normal outcome when nothing needs the person's attention.</p><p>The <a href="/research/journals?utm_source=newsletter#notes">research notes</a> describe these trade-offs. <a href="/unsubscribe?email=reader@example.org">Unsubscribe</a><a href="javascript:alert(1)">unsafe link</a><a href="https://other.example.org/article">Another public article</a></p><p hidden>hidden tracking text</p><form>Form secret input<button>Manage account</button></form><img src="https://tracker.example/pixel"><iframe src="https://tracker.example/frame"></iframe></article></main><footer>Copyright and footer that is not the article</footer></body></html>`;

function fixture(options = {}) {
  const calls = [];
  const reader = createPublicArticleReader({
    allowedHosts: ['news.example.org'],
    lookup: async () => [{ address: '93.184.215.14', family: 4 }],
    request: async (url, args) => { calls.push({ url: url.href, args }); return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: ARTICLE }; },
    now: () => 1234,
    ...options,
  });
  return { reader, calls };
}

test('readable extraction keeps substantial article text and safe links, not controls, scripts or tracking resources', () => {
  const result = extractReadableDocument(ARTICLE, 'https://news.example.org/notes');
  assert.equal(result.complete, true);
  assert.equal(result.title, 'Keeping a household journal');
  assert.match(result.text, /changed date does not lose/);
  assert.match(result.text, /pending and retain enough evidence/);
  assert.doesNotMatch(result.text, /Navigation|footer|stylesheet|ScriptExecuted|Form secret|hidden tracking/);
  assert.equal(globalThis.noticeArticleScriptExecuted, undefined);
  assert.deepEqual(result.links, [
    { url: 'https://news.example.org/research/journals', label: 'research notes' },
    { url: 'https://other.example.org/article', label: 'Another public article' },
  ]);
});

test('reader hashes stable article content without the volatile reading time, strips tracking params', async () => {
  let clock = 1;
  const { reader, calls } = fixture({ now: () => clock++ });
  const first = await reader('https://news.example.org/article?utm_source=email&id=42#details');
  const second = await reader('https://news.example.org/article?id=42&utm_medium=mail');
  assert.equal(first.url, 'https://news.example.org/article?id=42');
  assert.equal(first.complete, true);
  assert.equal(first.hash, second.hash);
  assert.equal(first.hash.length, 64);
  assert.notEqual(first.readAt, second.readAt);
  assert.equal(calls[0].args.address, '93.184.215.14');
  assert.equal(calls[0].args.servername, 'news.example.org');
  assert.equal(calls[0].args.headers['Accept-Encoding'], 'identity');
  assert.equal(calls[0].args.headers.Cookie, undefined);
  assert.equal(calls[0].args.headers.Authorization, undefined);
});

test('empty allowlist cannot fetch any domain', async () => {
  const { reader, calls } = fixture({ allowedHosts: [] });
  await assert.rejects(reader('https://news.example.org/article'), { code: 'ARTICLE_HOST_NOT_ALLOWED' });
  assert.equal(calls.length, 0);
});

test('allowlist is exact unless controlled subdomains are explicitly configured', async () => {
  const { reader } = fixture();
  for (const url of ['https://evilnews.example.org/article', 'https://news.example.org.evil.org/article', 'https://sub.news.example.org/article']) {
    await assert.rejects(reader(url), { code: 'ARTICLE_HOST_NOT_ALLOWED' });
  }
  const wildcard = fixture({ allowedHosts: ['*.example.org'] }).reader;
  assert.equal((await wildcard('https://news.example.org/article')).complete, true);
  await assert.rejects(wildcard('https://example.org/article'), { code: 'ARTICLE_HOST_NOT_ALLOWED' });
});

test('URL gate rejects non-HTTPS, credentials, ports, IP literals and special use hosts before DNS', async () => {
  let lookedUp = 0;
  const { reader } = fixture({ allowedHosts: ['news.example.org', 'localhost', 'printer.local', 'example.test'], lookup: async () => { lookedUp++; return []; } });
  for (const url of ['http://news.example.org/article', 'file:///etc/passwd', 'https://owner:secret@news.example.org/article', 'https://news.example.org:444/article', 'https://127.0.0.1/article', 'https://2130706433/article', 'https://0x7f000001/article', 'https://[::1]/article', 'https://localhost/article', 'https://printer.local/article', 'https://example.test/article', 'https://news.example.org./article']) {
    await assert.rejects(reader(url), { code: 'ARTICLE_URL_REJECTED' }, url);
  }
  assert.equal(lookedUp, 0);
});

test('URL gate blocks account actions, tracking and private query links including encoded paths', async () => {
  const { reader, calls } = fixture();
  for (const path of ['/unsubscribe', '/unsubscribe;reader', '/account/manage', '/oauth/callback', '/click/link', '/news/%75nsubscribe', '/news/%2565mail', '/news/%25252575nsubscribe', '/story?token=private', '/story?email=owner%40example.org', '/story?redirect=https%3A%2F%2Fexample.org', '/story?unknown=private', '/story?id=a%40example.org', '/story?id=one&id=two', '/story?key=secret']) {
    await assert.rejects(reader(`https://news.example.org${path}`), { code: 'ARTICLE_URL_REJECTED' }, path);
  }
  assert.equal(calls.length, 0);
});

test('DNS gate rejects all private, reserved, multicast, IPv6 and mixed answers', async () => {
  const rejected = ['0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.2', '169.254.169.254', '172.16.0.1', '172.31.255.254', '192.0.0.9', '192.0.2.10', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.254', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255'];
  for (const address of rejected) {
    const { reader, calls } = fixture({ lookup: async () => [{ address, family: 4 }] });
    await assert.rejects(reader('https://news.example.org/article'), { code: 'ARTICLE_DNS_REJECTED' }, address);
    assert.equal(calls.length, 0);
  }
  for (const records of [[], [{ address: '2606:4700:4700::1111', family: 6 }], [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    await assert.rejects(fixture({ lookup: async () => records }).reader('https://news.example.org/article'), { code: 'ARTICLE_DNS_REJECTED' });
  }
});

test('each redirect is allowlisted and resolves and pins its own validated IP', async () => {
  const lookups = [];
  const requests = [];
  const { reader } = fixture({
    allowedHosts: ['news.example.org', 'articles.example.org'],
    lookup: async (host) => { lookups.push(host); return [{ address: host.startsWith('news.') ? '93.184.215.14' : '8.8.8.8', family: 4 }]; },
    request: async (url, args) => {
      requests.push([url.href, args.address]);
      return requests.length === 1 ? { statusCode: 302, headers: { Location: 'https://articles.example.org/story?utm_source=redirect' }, body: '' } : { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: ARTICLE };
    },
  });
  const article = await reader('https://news.example.org/story');
  assert.equal(article.url, 'https://articles.example.org/story');
  assert.deepEqual(lookups, ['news.example.org', 'articles.example.org']);
  assert.deepEqual(requests, [['https://news.example.org/story', '93.184.215.14'], ['https://articles.example.org/story', '8.8.8.8']]);
});

test('redirect cannot cross into an unlisted domain, localhost, HTTP or DNS rebinding to private addresses', async () => {
  for (const location of ['https://evil.example.org/story', 'https://127.0.0.1/story', 'http://news.example.org/story', '/unsubscribe']) {
    let requests = 0;
    const { reader } = fixture({ request: async () => { requests++; return { statusCode: 302, headers: { location }, body: '' }; } });
    await assert.rejects(reader('https://news.example.org/story'));
    assert.equal(requests, 1);
  }
  let dns = 0;
  let requests = 0;
  const { reader } = fixture({ lookup: async () => [{ address: ++dns === 1 ? '93.184.215.14' : '192.168.0.1', family: 4 }], request: async () => { requests++; return { statusCode: 302, headers: { location: '/another' }, body: '' }; } });
  await assert.rejects(reader('https://news.example.org/story'), { code: 'ARTICLE_DNS_REJECTED' });
  assert.equal(requests, 1);
});

test('redirect loop stops after at most three redirects and closes response bodies', async () => {
  let requests = 0;
  let closed = 0;
  const { reader } = fixture({ request: async () => { requests++; return { statusCode: 302, headers: { location: '/loop' }, body: { destroy() { closed++; } } }; } });
  await assert.rejects(reader('https://news.example.org/story'), { code: 'ARTICLE_REDIRECT_REJECTED' });
  assert.equal(requests, 4);
  assert.equal(closed, 4);
});

test('compressed bodies, PDF, missing types, and non-success HTTP are explicit failures', async () => {
  for (const [response, code] of [
    [{ statusCode: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: 'compressed' }, 'ARTICLE_ENCODING_REJECTED'],
    [{ statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF' }, 'ARTICLE_TYPE_REJECTED'],
    [{ statusCode: 200, headers: {}, body: ARTICLE }, 'ARTICLE_TYPE_REJECTED'],
    [{ statusCode: 403, headers: { 'content-type': 'text/html' }, body: ARTICLE }, 'ARTICLE_HTTP_ERROR'],
  ]) {
    await assert.rejects(fixture({ request: async () => response }).reader('https://news.example.org/article'), { code, ...(code === 'ARTICLE_HTTP_ERROR' && { statusCode: 403 }) });
  }
});

test('declared and streaming response sizes are bounded before parsing', async () => {
  let read = false;
  const declared = fixture({ maxBytes: 500, request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html', 'content-length': '501' }, body: { async *[Symbol.asyncIterator]() { read = true; yield 'a'; } } }) }).reader;
  await assert.rejects(declared('https://news.example.org/article'), { code: 'ARTICLE_TOO_LARGE' });
  assert.equal(read, false);
  let chunks = 0;
  const streamed = fixture({ maxBytes: 500, request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: { async *[Symbol.asyncIterator]() { for (let i = 0; i < 20; i++) { chunks++; yield Buffer.alloc(100); } } } }) }).reader;
  await assert.rejects(streamed('https://news.example.org/article'), { code: 'ARTICLE_TOO_LARGE' });
  assert.equal(chunks, 6);
});

test('abort cancels before DNS, while resolving, and while reading body', async () => {
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('owner cancelled'), { code: 'OWNER_CANCELLED' }));
  await assert.rejects(fixture().reader('https://news.example.org/article', { signal: controller.signal }), { code: 'OWNER_CANCELLED' });
  const duringDns = new AbortController();
  const dns = fixture({ lookup: () => new Promise(() => {}) }).reader('https://news.example.org/article', { signal: duringDns.signal });
  duringDns.abort(Object.assign(new Error('owner cancelled'), { code: 'OWNER_CANCELLED' }));
  await assert.rejects(dns, { code: 'OWNER_CANCELLED' });
  const duringBody = new AbortController();
  let closed = false;
  let bodyStarted;
  const start = new Promise((resolve) => { bodyStarted = resolve; });
  const pending = fixture({ request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: { destroy() { closed = true; }, [Symbol.asyncIterator]() { return { next() { bodyStarted(); return new Promise(() => {}); } }; } } }) }).reader('https://news.example.org/article', { signal: duringBody.signal });
  await start;
  duringBody.abort(Object.assign(new Error('owner cancelled'), { code: 'OWNER_CANCELLED' }));
  await assert.rejects(pending, { code: 'OWNER_CANCELLED' });
  assert.equal(closed, true);
});

test('time limit covers unresponsive DNS, request and streaming body hooks', async () => {
  for (const options of [
    { lookup: () => new Promise(() => {}) },
    { request: () => new Promise(() => {}) },
    { request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } } }) },
  ]) {
    await assert.rejects(fixture({ timeoutMs: 15, ...options }).reader('https://news.example.org/article'), { code: 'ARTICLE_TIMEOUT' });
  }
});

test('paywalls and JavaScript shells cannot be reported as a complete read', async () => {
  const paywall = ARTICLE.replace('<article>', '<article><div data-paywall>Subscribe to continue reading</div>');
  const structuredPaywall = ARTICLE.replace('<head>', '<head><script type="application/ld+json">{"isAccessibleForFree":false}</script>');
  for (const html of [paywall, structuredPaywall]) {
    assert.equal(extractReadableDocument(html, 'https://news.example.org/story').complete, false);
    await assert.rejects(fixture({ request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: html }) }).reader('https://news.example.org/story'), { code: 'ARTICLE_PAYWALL' });
  }
  const shell = '<html><head><title>News</title></head><body><div id="root"></div><script>loadNews()</script><noscript>Please enable JavaScript</noscript></body></html>';
  assert.equal(extractReadableDocument(shell, 'https://news.example.org/story').complete, false);
  await assert.rejects(fixture({ request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: shell }) }).reader('https://news.example.org/story'), { code: 'ARTICLE_NO_CONTENT' });
});

test('long documents are explicitly incomplete at the text limit; plain text preserves the full readable body', async () => {
  const long = `<html><body><article><h1>A long household diary</h1><p>${'A concrete diary observation about the dinner and its next step. '.repeat(1200)}</p></article></body></html>`;
  const extraction = extractReadableDocument(long, 'https://news.example.org/story');
  assert.equal(extraction.text.length, 60_000);
  assert.equal(extraction.complete, false);
  const plain = 'The full plain-text article describes how the assistant keeps a journal, checks facts, and makes a selective recommendation. '.repeat(4);
  const result = await fixture({ request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: plain }) }).reader('https://news.example.org/story');
  assert.equal(result.complete, true);
  assert.equal(result.text, plain.trim());
});

test('invalid reader configuration and invalid text encodings fail explicitly', async () => {
  assert.throws(() => createPublicArticleReader({ allowedHosts: ['https://example.org'] }), { code: 'ARTICLE_CONFIG_INVALID' });
  assert.throws(() => createPublicArticleReader({ allowedHosts: ['*.com'] }), { code: 'ARTICLE_CONFIG_INVALID' });
  assert.throws(() => createPublicArticleReader({ maxBytes: 0 }), { code: 'ARTICLE_CONFIG_INVALID' });
  await assert.rejects(fixture({ request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from([0xff, 0xfe, 0xff]) }) }).reader('https://news.example.org/story'), { code: 'ARTICLE_ENCODING_REJECTED' });
});
