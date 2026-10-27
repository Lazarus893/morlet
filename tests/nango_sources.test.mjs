import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNangoClient } from '../plugins/connections/nango.mjs';
import { readNangoSource, readNangoMail, probeNangoConnection } from '../plugins/agent-hub/nango-sources.mjs';
import { GOOGLE_SCOPES } from '../plugins/agent-hub/google-sources.mjs';

const now = () => Date.parse('2026-10-23T00:00:00Z');
const json = (value, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const mime = (text, type = 'text/plain', extra = {}) => ({ mimeType: type, body: { data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text) }, ...extra });
const message = (id = 'abc', payload = mime('Read the complete mail.')) => ({ id, threadId: 'abc', internalDate: '1792627200000', payload: { ...payload, headers: [...(payload.headers || []), { name: 'Subject', value: 'Review update' }, { name: 'From', value: 'sender@example.com' }, { name: 'Date', value: 'Thu, 22 Oct 2026 08:00:00 +0800' }] } });
function fixture({ service = 'google', account = service === 'google' ? 'reader@example.com' : service === 'github' ? 'reader' : 'reader_x', scopes = service === 'google' ? Object.values(GOOGLE_SCOPES).map(values => values[0]) : service === 'x' ? ['users.read', 'tweet.read'] : ['repo'], handle, authorize = () => true } = {}) {
  const requests = [], ownerTag = createHash('sha256').update('fixture\0owner').digest('hex');
  const record = { connection_id: 'connection', provider_config_key: service, provider: service, tags: { end_user_id: ownerTag, xiaoman_instance: 'fixture' }, errors: [], credentials: { raw: { scope: scopes.join(' ') } } };
  const client = createNangoClient({ config: { instanceId: 'fixture', integrations: { [service]: { integrationId: service } } }, env: { NANGO_SECRET_KEY: 'fixture-private-key' }, fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/connections') return json({ connections: [record] });
    if (parsed.pathname === '/connections/connection') return json(record);
    const req = { path: parsed.pathname.replace(/^\/proxy/, ''), query: parsed.searchParams, headers: options.headers };
    requests.push(req);
    const custom = await handle?.(req, requests);
    if (custom !== undefined) return custom instanceof Response ? custom : json(custom);
    if (req.path === '/oauth2/v2/userinfo') return json({ email: account, verified_email: true });
    if (req.path === '/user') return json({ login: account });
    if (req.path === '/2/users/me') return json({ data: { id: '123', username: account } });
    throw new Error('Unexpected provider request ' + req.path);
  } });
  const binding = { service, ownerId: 'owner', connectionId: 'connection', account, generation: 1 };
  return { client, binding, requests, read: args => readNangoSource({ client, binding, args, authorize, now }), mail: args => readNangoMail({ client, binding, ...args, authorize }), probe: () => probeNangoConnection(client, binding, { authorize, now }) };
}

test('Calendar preserves primary window, all-day dates, source timezone, declined and pagination', async () => {
  const f = fixture({ handle: req => req.path.endsWith('/events') ? { timeZone: 'Asia/Shanghai', nextPageToken: 'more', items: [{ id: 'event', summary: 'Project review', start: { dateTime: '2026-10-23T09:00:00+08:00', timeZone: 'Asia/Shanghai' }, end: { dateTime: '2026-10-23T10:00:00+08:00' }, attendees: [{ self: true, responseStatus: 'declined' }] }, { id: 'all-day', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } }] } : undefined });
  const args = { operation: 'calendar_events', from: '2026-10-23T00:00:00+08:00', to: '2026-10-25T00:00:00+08:00' };
  const value = await f.read(args);
  assert.deepEqual(value.window, { from: args.from, to: args.to });
  assert.equal(value.events[0].startTimeZone, 'Asia/Shanghai');
  assert.equal(value.events[0].declined, true);
  assert.equal(value.events[1].allDay, true); assert.equal(value.events[1].start, '2026-10-24');
  assert.equal(value.truncated, true); assert.equal(value.untrusted, true); assert.equal(value.executionLocation, 'nango');
  const req = f.requests.find(r => r.path.endsWith('/events'));
  assert.equal(req.query.get('singleEvents'), 'true'); assert.equal(req.query.get('timeMin'), args.from);
});

test('mail search reads explicit metadata only, keeps caller query and signals an omitted page', async () => {
  const f = fixture({ handle: req => req.path.endsWith('/messages') ? { messages: [{ id: 'abc' }], nextPageToken: 'more' } : req.path.endsWith('/messages/abc') ? message() : undefined });
  const value = await f.read({ operation: 'mail_search', query: 'in:inbox newer_than:7d', max: 10 });
  assert.equal(value.messages[0].subject, 'Review update'); assert.equal(value.coverage, 'metadata_only'); assert.equal(value.truncated, true);
  assert.equal(value.messages[0].receivedAt, new Date(1792627200000).toISOString());
  assert.equal(f.requests.find(r => r.path.endsWith('/messages')).query.get('q'), 'in:inbox newer_than:7d');
  assert.equal(f.requests.find(r => r.path.endsWith('/messages/abc')).query.get('format'), 'metadata');
  assert.deepEqual(f.requests.find(r => r.path.endsWith('/messages/abc')).query.getAll('metadataHeaders'), ['Subject', 'From', 'Date']);
  assert.equal(Object.hasOwn(value.messages[0], 'text'), false);
});

test('empty Gmail listing is complete only without a next page; never substitute snippets', async () => {
  const f = fixture({ handle: req => req.path.endsWith('/messages') ? { resultSizeEstimate: 0 } : req.path.endsWith('/messages/abc') ? { ...message(), payload: {}, snippet: 'Not a full body' } : undefined });
  const value = await f.read({ operation: 'mail_search', query: 'in:inbox' });
  assert.deepEqual(value.messages, []); assert.equal(value.complete, true);
  await assert.rejects(f.read({ operation: 'mail_read', messageId: 'abc' }), { code: 'SOURCE_BODY_UNAVAILABLE' });
});

test('MIME selects one alternative, joins mixed text, omits attachments and preserves body completeness', async () => {
  const payload = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [mime('<p>duplicate html</p>', 'text/html'), mime('Primary plain text')] },
    mime('Second inline section'), mime('never read this attachment', 'text/plain', { filename: 'secret.txt' }),
  ] };
  const f = fixture({ handle: req => req.path.endsWith('/messages/abc') ? message('abc', payload) : undefined });
  const value = await f.read({ operation: 'mail_read', messageId: 'abc' });
  assert.equal(value.text, 'Primary plain text\nSecond inline section');
  assert.equal(value.complete, true); assert.equal(value.attachmentsRead, false); assert.equal(value.attachmentsOmitted, 1);
  assert.equal(value.sentAt, '2026-10-22T00:00:00.000Z'); assert.equal(value.threadId, 'abc');
});

test('HTML mail is parsed without executing or fetching resources; Unicode truncation is honest', async () => {
  const f = fixture({ handle: req => req.path.endsWith('/messages/abc') ? message('abc', mime('<p>Hello &amp; goodbye</p><script>private script</script><img src="https://evil.invalid/resource"><p>' + '小'.repeat(21000) + '</p>', 'text/html')) : undefined });
  const value = await f.read({ operation: 'mail_read', messageId: 'abc' });
  assert.ok(value.text.startsWith('Hello & goodbye'));
  assert.equal(value.text.includes('private script'), false); assert.equal(value.textCharacters, 20000);
  assert.equal(value.complete, false); assert.equal(value.externalLinksRead, false);
  assert.ok(f.requests.every(r => !r.path.includes('resource')));
});

test('missing inline MIME body makes mail partial and blocks automatic full-body reader', async () => {
  const f = fixture({ handle: req => req.path.endsWith('/messages/abc') ? message('abc', { mimeType: 'multipart/mixed', parts: [mime('Available section'), { mimeType: 'text/plain', body: { attachmentId: 'not-fetched', size: 100 } }] }) : undefined });
  const value = await f.read({ operation: 'mail_read', messageId: 'abc' });
  assert.equal(value.complete, false); assert.equal(value.truncated, true);
  await assert.rejects(f.mail({ messageId: 'abc' }), { code: 'SOURCE_BODY_UNAVAILABLE' });
});

test('automatic reader obtains full shape and bounded verified thread; IDs cannot be swapped', async () => {
  const f = fixture({ handle: req => req.path.endsWith('/messages/abc') ? message() : req.path.endsWith('/threads/abc') ? { id: 'abc', messages: [message(), message('abd')] } : undefined });
  const full = await f.mail({ messageId: 'abc' });
  assert.equal(full.message.id, 'abc'); assert.equal(full.body, 'Read the complete mail.'); assert.equal(full.bodyComplete, true);
  const thread = await f.mail({ threadId: 'abc' }); assert.equal(thread.thread.messages.length, 2);
  const swapped = fixture({ handle: req => req.path.endsWith('/messages/abc') ? message('def') : undefined });
  await assert.rejects(swapped.read({ operation: 'mail_read', messageId: 'abc' }), { code: 'INVALID_SOURCE_RESPONSE' });
});

test('Drive recent preserves root-only semantics; search safely quotes literal text and filters sensitive names', async () => {
  const f = fixture({ handle: req => req.path === '/drive/v3/files' ? { files: [{ id: 'file1', name: 'Public notes', mimeType: 'text/plain' }, { id: 'file2', name: 'passwords.txt', mimeType: 'text/plain' }], nextPageToken: 'more' } : undefined });
  const recent = await f.read({ operation: 'drive_recent' });
  assert.equal(recent.coverage, 'drive_root_folder_recent_metadata_only'); assert.equal(recent.excludedSensitive, 1); assert.equal(recent.complete, false);
  assert.equal(f.requests.find(r => r.path === '/drive/v3/files').query.get('q'), "'root' in parents and trashed = false");
  await f.read({ operation: 'drive_search', query: "Bob's \\ notes" });
  assert.equal(f.requests.filter(r => r.path === '/drive/v3/files').at(-1).query.get('q'), "fullText contains 'Bob\\'s \\\\ notes' and trashed = false");
});

test('Drive metadata retains bytes and description without downloading file content', async () => {
  const f = fixture({ handle: req => req.path === '/drive/v3/files/file1' ? { id: 'file1', name: 'Notes', mimeType: 'text/plain', size: '400', description: 'Metadata only' } : undefined });
  const value = await f.read({ operation: 'drive_metadata', fileId: 'file1' });
  assert.equal(value.file.size, '400'); assert.equal(value.file.description, 'Metadata only'); assert.equal(value.coverage, 'file_metadata_only');
  assert.equal(f.requests.some(r => r.query.get('alt') === 'media'), false);
});

test('Docs extracts paragraphs, table cells and nested tabs with explicit excluded-content coverage', async () => {
  const paragraph = text => ({ paragraph: { elements: [{ textRun: { content: text } }] } });
  const doc = { documentId: 'doc1', tabs: [{ tabProperties: { tabId: 'one', title: 'First' }, documentTab: { body: { content: [paragraph('First\n'), { table: { tableRows: [{ tableCells: [{ content: [paragraph('Cell A')] }, { content: [paragraph('Cell B')] }] }] } }] } }, childTabs: [{ tabProperties: { tabId: 'two', title: 'Child' }, documentTab: { body: { content: [paragraph('Child\n')] } } }] }] };
  const f = fixture({ handle: req => req.path === '/v1/documents/doc1' ? doc : undefined });
  const value = await f.read({ operation: 'docs_read', documentId: 'doc1' });
  assert.equal(value.text, 'First\nCell A\tCell B\nChild\n'); assert.equal(value.tabsRead.length, 2);
  assert.equal(value.complete, true); assert.match(value.note, /Comments, images, headers, footnotes/);
  assert.equal(f.requests.find(r => r.path === '/v1/documents/doc1').query.get('includeTabsContent'), 'true');
});

test('Sheets metadata flattens REST properties; values preserve range bounds and clipping', async () => {
  const f = fixture({ handle: req => req.path === '/v4/spreadsheets/sheet1' ? { spreadsheetId: 'sheet1', properties: { title: 'Plan', locale: 'zh_CN', timeZone: 'Asia/Shanghai' }, sheets: [{ properties: { sheetId: 0, title: 'Sheet1', gridProperties: { rowCount: 100, columnCount: 20 } } }] } : req.path.startsWith('/v4/spreadsheets/sheet1/values/') ? { range: 'Sheet1!A1:B2', values: [['Long ' + 'x'.repeat(2500), 3], [true]] } : undefined });
  const meta = await f.read({ operation: 'sheets_metadata', spreadsheetId: 'sheet1' });
  assert.equal(meta.title, 'Plan'); assert.equal(meta.sheets[0].id, 0);
  const value = await f.read({ operation: 'sheets_read', spreadsheetId: 'sheet1', range: 'Sheet1!A1:B2' });
  assert.equal(value.truncated, true); assert.equal(value.values[0][0].length, 2000); assert.equal(value.fullSpreadsheetRead, false);
  await assert.rejects(f.read({ operation: 'sheets_read', spreadsheetId: 'sheet1', range: 'A1:Z1000' }), { code: 'INVALID_INPUT' });
});

test('Contacts warms search cache then returns primary fields without exporting full address book', async () => {
  const f = fixture({ handle: req => req.path === '/v1/people:searchContacts' ? { results: req.query.get('query') ? [{ person: { resourceName: 'people/c1', names: [{ displayName: 'Alt' }, { displayName: 'Tony', metadata: { primary: true } }], emailAddresses: [{ value: 'tony@example.com' }] } }] : [] } : undefined });
  const value = await f.read({ operation: 'contacts_search', query: 'Tony' });
  assert.equal(value.contacts[0].name, 'Tony'); assert.equal(value.contacts[0].email, 'tony@example.com'); assert.equal(value.fullAddressBookRead, false);
  assert.deepEqual(f.requests.filter(r => r.path === '/v1/people:searchContacts').map(r => r.query.get('query')), ['', 'Tony']);
});

test('GitHub review search binds the verified account and excludes malformed URLs', async () => {
  const f = fixture({ service: 'github', handle: req => req.path === '/search/issues' ? { items: [{ id: 1, title: 'Review', html_url: 'https://github.com/org/repo/pull/1', updated_at: '2026-10-22T00:00:00Z' }, { id: 2, html_url: 'https://evil.invalid' }], total_count: 2 } : undefined });
  const value = await f.read({ operation: 'review_requests' });
  assert.equal(value.requests.length, 1); assert.equal(value.truncated, true);
  assert.equal(f.requests.find(r => r.path === '/search/issues').query.get('q'), 'is:pr is:open review-requested:reader');
});

const repo = { full_name: 'org/repo', private: false, visibility: 'public', description: 'Project', default_branch: 'main', pushed_at: '2026-10-22T00:00:00Z' };
test('GitHub followed repositories reuse public-only parsing and watching/starred distinction', async () => {
  const f = fixture({ service: 'github', handle: req => req.path === '/user/subscriptions' ? [repo, { ...repo, full_name: 'org/private', private: true }] : req.path === '/user/starred' ? [repo] : undefined });
  const value = await f.read({ operation: 'github_repositories' });
  assert.equal(value.repositories.length, 1); assert.deepEqual(value.repositories[0].followedVia, ['watching', 'starred']);
  assert.equal(value.coverage.watching.excludedPrivate, 1); assert.equal(value.complete, true);
});

test('GitHub updates retain real release bodies, bounded patch excerpts and partial-diff coverage', async () => {
  const sha = 'a'.repeat(40);
  const f = fixture({ service: 'github', handle: req => {
    if (req.path.endsWith('/subscription')) return { subscribed: true, ignored: false };
    if (req.path === '/repos/org/repo') return repo;
    if (req.path.endsWith('/releases')) return [{ id: 10, name: 'v1', tag_name: 'v1', body: 'Release body', draft: false, prerelease: false, published_at: '2026-10-22T00:00:00Z' }];
    if (req.path.endsWith('/commits')) return [{ sha, commit: { message: 'Fixed issue', committer: { date: '2026-10-22T00:00:00Z' } } }];
    if (req.path.endsWith('/commits/' + sha)) return { sha, files: Array.from({ length: 10 }, (_, i) => ({ filename: 'file' + i, status: 'modified', patch: '+change' })), stats: { additions: 10, deletions: 0 } };
  } });
  const value = await f.read({ operation: 'github_updates', repo: 'org/repo' });
  assert.equal(value.releases[0].body.text, 'Release body'); assert.equal(value.commits[0].files.length, 3);
  assert.equal(value.commits[0].fullDiffRead, false); assert.equal(value.commits[0].filesComplete, false); assert.equal(value.truncated, true);
});

test('GitHub notification collector reuses selected notification IDs and fetches corresponding body', async () => {
  const f = fixture({ service: 'github', handle: req => req.path === '/notifications' ? [{ id: '12', repository: repo, subject: { title: 'Issue', url: 'https://api.github.com/repos/org/repo/issues/5' }, updated_at: '2026-10-22T00:00:00Z', unread: true }] : req.path === '/repos/org/repo/issues/5' ? { title: 'Issue', body: 'Issue body', html_url: 'https://github.com/org/repo/issues/5' } : undefined });
  const value = await f.read({ operation: 'github_notifications', since: '2026-10-21T00:00:00Z', ids: ['12'], max: 4 });
  assert.equal(value.notifications[0].body.text, 'Issue body'); assert.equal(value.notifications[0].id, '12');
});

test('X timeline uses current REST post fields and retains long-post and pagination coverage', async () => {
  const f = fixture({ service: 'x', handle: req => req.path.includes('/timelines/') ? { data: [{ id: '456', text: 'short', note_post: { text: 'Full long post' }, author_id: '22', created_at: '2026-10-22T00:00:00Z' }], includes: { users: [{ id: '22', username: 'author' }] }, meta: { next_token: 'more', result_count: 1 } } : undefined });
  const value = await f.read({ operation: 'x_timeline' });
  assert.equal(value.posts[0].text, 'Full long post'); assert.equal(value.posts[0].url, 'https://x.com/author/status/456'); assert.equal(value.truncated, true);
  assert.equal(f.requests.find(r => r.path.includes('/timelines/')).query.get('post.fields'), 'created_at,text,note_post');
});

test('Google probes distinguish granted scopes from actual API availability', async () => {
  const f = fixture({ handle: req => {
    if (req.path.endsWith('/messages')) return { messages: [] };
    if (req.path.endsWith('/events')) return json({ error: { message: 'API disabled' } }, 403);
    if (req.path === '/drive/v3/files') return { files: [] };
    if (req.path === '/v1/people/me/connections') return { connections: [] };
  } });
  const value = await f.probe();
  assert.equal(value.account, 'reader@example.com'); assert.equal(value.state, 'limited');
  assert.deepEqual(value.permissions.find(p => p.id === 'calendar'), { id: 'calendar', granted: true, verified: false, errorCode: 'SOURCE_SCOPE_MISSING' });
  assert.ok(value.permissions.filter(p => p.id !== 'calendar').every(p => p.verified));
  assert.equal(value.capabilityVerification.docs, 'checked_on_use');
});

test('connection probes expose verified immutable Google/GitHub identity for duplicate resolution', async () => {
  for (const service of ['google', 'github']) {
    const f = fixture({ service, scopes: [], handle: req => {
      if (req.path === '/oauth2/v2/userinfo') return { id: '10001', email: 'reader@example.com', verified_email: true };
      if (req.path === '/user') return { id: 10001, login: 'reader' };
      if (req.path === '/user/repos') return [];
    } });
    assert.equal((await f.probe()).userId, '10001');
  }
  let reads = 0;
  const changed = fixture({ scopes: [], handle: req => req.path === '/oauth2/v2/userinfo' ? { id: ++reads === 1 ? '10001' : '20002', email: 'reader@example.com', verified_email: true } : undefined });
  await assert.rejects(changed.probe(), { code: 'SOURCE_ACCOUNT_CHANGED' });
});

test('GitHub and X probes require actual repo/timeline responses, not auth metadata', async () => {
  const github = fixture({ service: 'github', handle: req => req.path === '/user/repos' ? [] : undefined });
  assert.equal((await github.probe()).permissions.find(p => p.id === 'repos').verified, true);
  const x = fixture({ service: 'x', handle: req => req.path.includes('/timelines/') ? json({ error: { message: 'quota unavailable' } }, 403) : undefined });
  const result = await x.probe(); assert.equal(result.state, 'limited'); assert.equal(result.permissions.find(p => p.id === 'read').verified, false);
});

test('missing scopes block content requests; account changes invalidate otherwise successful results', async () => {
  const missing = fixture({ scopes: [GOOGLE_SCOPES.drive[0]] });
  await assert.rejects(missing.read({ operation: 'mail_read', messageId: 'abc' }), { code: 'SOURCE_SCOPE_MISSING' });
  assert.equal(missing.requests.some(r => r.path.includes('/messages/')), false);
  let identityChecks = 0;
  const changed = fixture({ handle: req => req.path === '/oauth2/v2/userinfo' ? { email: ++identityChecks === 1 ? 'reader@example.com' : 'other@example.com', verified_email: true } : req.path.endsWith('/messages/abc') ? message() : undefined });
  await assert.rejects(changed.read({ operation: 'mail_read', messageId: 'abc' }), { code: 'SOURCE_ACCOUNT_CHANGED' });
});

test('revocation or generation change during REST I/O discards late contents', async () => {
  let active = true;
  const f = fixture({ authorize: () => active, handle: req => { if (req.path.endsWith('/messages/abc')) { active = false; return message(); } } });
  await assert.rejects(f.read({ operation: 'mail_read', messageId: 'abc' }), { code: 'SOURCE_REVOKED' });
  let g;
  g = fixture({ handle: req => { if (req.path.endsWith('/messages/abc')) { g.binding.generation++; return message(); } } });
  await assert.rejects(g.read({ operation: 'mail_read', messageId: 'abc' }), { code: 'SOURCE_AUTHORITY_CHANGED' });
});

test('sensitive bodies and unbounded or mismatched source operations never become usable results', async () => {
  const f = fixture({ handle: req => req.path.endsWith('/messages/abc') ? message('abc', mime('password: veryprivatevalue')) : undefined });
  await assert.rejects(f.read({ operation: 'mail_read', messageId: 'abc' }), { code: 'SOURCE_SENSITIVE_CONTENT' });
  await assert.rejects(f.read({ operation: 'calendar_events', from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.read({ operation: 'github_repositories' }), { code: 'SOURCE_NOT_CONFIGURED' });
  await assert.rejects(f.read({ operation: 'mail_read', messageId: '../bad' }), { code: 'INVALID_INPUT' });
});
