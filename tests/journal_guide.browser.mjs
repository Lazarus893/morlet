// Full UI journey in an isolated database. PA_GUIDE_REAL_AGENT=1 uses the installed
// read-only Codex adapter; otherwise a controlled endpoint exercises recovery.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { once } from 'node:events'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWebUI } from '../plugins/webui/server.mjs';
import { journalTool } from '../plugins/agent-hub/journal.mjs';
import { AgentCompanion } from '../plugins/agent-hub/companion.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url)), root = await mkdtemp(join(tmpdir(), 'xiaoman-real-guide-'));
const real = process.env.PA_GUIDE_REAL_AGENT === '1', artifacts = process.env.PA_GUIDE_ARTIFACTS || join(ROOT, '.runtime/verification/real-guide-20261022/browser');
const scope = { account: 'local', userId: 'owner' }, errors = [], writes = [], followResponses = [];
const publicOrigin = real ? undefined : 'http://xiaoman.test';
const config = JSON.parse(await readFile(join(ROOT, 'config/pa.example.json'), 'utf8')); config.proactive.enabled = false;
const settings = { config, revision: 'guide-test', installed: true, runtimeInstalled: true, pending: [], socket: '/no-real-runtime' };
let app, browser, companion, timer, inTick = false, ticks = [], responseFailed = false;
try {
 await mkdir(artifacts, { recursive: true, mode: 0o700 }); await mkdir(join(root, '.runtime'), { recursive: true });
 if (process.env.PA_GUIDE_SOURCE_DB) await copyFile(process.env.PA_GUIDE_SOURCE_DB, join(root, '.runtime/life-journal.sqlite'));
 app = createWebUI({ root, publicOrigin, helper: async req => { assert.equal(req.action, 'read'); return settings; }, rpc: async (_socket, req) => { assert.equal(req.operation, 'snapshot'); return { kind: 'pa', data: { protocol: 1, account: null, users: [], connected: false, configRevision: settings.revision } }; }, journalRuntimeFactory: async () => { throw new Error('No design model is needed for this flow'); } });
 const store = app.journal.store, snapshot = () => store.snapshot(scope), guide = () => snapshot().items.find(i => i.source.kind === 'guide');
 if (!process.env.PA_GUIDE_SOURCE_DB) {
  const material = store.mutate(scope, { operation: 'add', revision: snapshot().revision, values: { title: '测试材料', source: { kind: 'automatic', channel: 'background', text: '隔离验收材料' }, taskType: 'collection', taskData: { collection: { entries: [{ id: 'one', title: '键盘修复', note: '修复禁用按钮的键盘响应' }, { id: 'two', title: '组件更新', note: '过渡可以中断' }] } } } }).items.at(-1);
  for (const [n, title] of ['键盘修复', '组件更新'].entries()) {
   const row = { id: String(n + 1).repeat(64), itemId: material.id, entryId: ['one', 'two'][n], source: 'github', title, hook: title + '的具体行为发生变化', summary: title + '改善连续操作体验。', relevance: '可核对当前交互。', suggestion: '对照更新说明体验一次完整操作。', coverage: '已读发布说明，未核对代码。', evidence: [{ quote: title, url: 'https://example.com/release' }], topic: title, url: 'https://example.com/release', observedAt: Date.now(), savedAt: Date.now(), day: '2026-10-22', exploration: false };
   store.db.prepare('INSERT INTO journal_content_entries VALUES(?,?,?)').run(row.id, row.itemId, JSON.stringify(row));
  }
 }
 const originals = snapshot().items.filter(i => i.source.kind !== 'guide');
 const pairing = app.hub.pair({ label: real ? 'Read-only acceptance' : 'Controlled acceptance' });
 await writeFile(join(root, '.runtime/agent-hub.json'), JSON.stringify({ version: 1, agents: [], roles: { conversation: pairing.endpointId, journalDesigner: null } }), { mode: 0o600 });
 const draft = app.firstTasks.action({ operation: 'draft', text: '不要覆盖已有草稿', requestId: 'existing-draft' });
 app.hub.poll(pairing.token, { runnerId: 'guide-browser', claim: false });
 app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
 const url = publicOrigin || `http://127.0.0.1:${app.server.address().port}`;
 let instanceAgent = {};
 if (real && process.env.PA_GUIDE_AGENT_CONFIG) { const cfg = JSON.parse(await readFile(process.env.PA_GUIDE_AGENT_CONFIG, 'utf8')); instanceAgent = cfg.agents.find(a => a.id === cfg.roles.conversation); assert.ok(instanceAgent); assert.equal(instanceAgent.provider, 'codex'); }
 if (real) companion = new AgentCompanion({ config: { ...instanceAgent, endpoint: url, token: pairing.token, provider: 'codex', command: instanceAgent.command || process.env.PA_GUIDE_CODEX_COMMAND || 'codex', workspace: root, timeout_seconds: 240 }, statePath: join(root, '.runtime/companion-state.json') });
 async function tick() {
  if (inTick) return; inTick = true;
  try {
   if (companion) await companion.tick();
   else {
    const job = app.hub.poll(pairing.token, { runnerId: 'guide-browser' }).job;
    if (job) {
     if (!responseFailed) { responseFailed = true; app.hub.event(pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'failed', value: 'AGENT_TIMEOUT' }); }
     else {
      await journalTool({ hub: app.hub, journal: app.journal, firstTasks: app.firstTasks, token: pairing.token, read: async () => settings, input: { runId: job.id, lease: job.lease, callId: 'read', arguments: { operation: 'get', itemId: snapshot().guide.resultItemId } } });
      const result = snapshot().items.find(i => i.id === snapshot().guide.resultItemId);
      app.hub.tool(pairing.token, { tool: 'xiaoman_report', runId: job.id, lease: job.lease, callId: 'report', arguments: { summary: '已依据保存材料整理核对要点，原始来源未在本轮复查。', outcome: 'partial' } });
      app.hub.event(pairing.token, { runId: job.id, lease: job.lease, seq: 1, type: 'completed', value: job.prompt === '请继续核对这件事，不修改记录。' ? '已按补充继续核对，新的结果仍属于原事项。' : `已读这件事的当前材料。\n下一步：${result.steps[1].label}\n本轮只核对已保存材料，未重新访问原始来源。` });
     }
    }
   }
  } catch (e) { ticks.push(e.code || e.message); } finally { inTick = false; }
 }
 browser = await chromium.launch({ headless: true, channel: process.env.PA_BROWSER_CHANNEL || 'chrome', ...(publicOrigin ? { args: [`--host-resolver-rules=MAP xiaoman.test 127.0.0.1:${app.server.address().port}`, '--no-proxy-server'] } : {}) });
 const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Shanghai', reducedMotion: 'no-preference', recordVideo: { dir: artifacts, size: { width: 1440, height: 1100 } } });
 const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() === 'POST') writes.push({ url: new URL(r.url()).pathname, operation: r.postDataJSON()?.operation }); });
 page.on('response', response => { if (new URL(response.url()).pathname === '/api/journal/guide/follow') followResponses.push({ status: response.status(), requestId: response.request().postDataJSON()?.requestId }); });
 const post = (path, data, csrf) => page.evaluate(async ({ path, data, csrf }) => {
  const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-PA-CSRF': csrf } : {}) }, body: JSON.stringify(data) });
  return { status: response.status, wire: await response.json() };
 }, { path, data, csrf });
 async function enterGuide() {
  if (await page.locator('.journal-onboarding').count()) { await page.locator('.journal-guide-choices').waitFor(); return; }
  await page.locator('.journal-bookmark').first().waitFor();
  const index = page.locator('#journal-index-toggle');
  if (await index.isVisible() && await index.getAttribute('aria-expanded') !== 'true') await index.click();
  const bookmark = guide() && page.locator(`#journal-bookmarks [data-item="${guide().id}"]`);
  if (bookmark && await bookmark.count()) await bookmark.click();
  else await page.locator('.journal-guide-entry').click();
  await page.locator('.journal-workpage:not([hidden]) .journal-guide-choices').waitFor();
 }
 await page.goto(url + '/#onboarding');
 const browserContext = await page.evaluate(() => ({ isSecureContext, randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues }));
 if (!real) assert.deepEqual(browserContext, { isSecureContext: false, randomUUID: 'undefined', getRandomValues: 'function' }, 'exercise the supported intranet HTTP environment, not localhost secure-context privileges');
 await page.locator('.journal-onboarding .journal-guide-choices').waitFor();
 await page.waitForFunction(() => !window.PAJournal.isBusy());
 assert.equal(await page.locator('#on-compose').evaluate(el => el.open), false, 'recent materials lead while free-form composing is secondary');
 assert.equal(await page.locator('#ft-draft').isVisible(), false);
 await page.evaluate(() => window.PAFirstTask.prefill(''));
 assert.equal(await page.locator('#on-compose').evaluate(el => el.open), true, 'a compose handoff expands the secondary path');
 assert.equal(await page.locator('#ft-draft').inputValue(), '不要覆盖已有草稿');
 assert.equal(writes.filter(write => write.url !== '/api/journal/guide').length, 0, 'opening the guide may save its local page but never chooses or starts a task');
 await page.locator('#on-compose>summary').click();
 await page.screenshot({ path: join(artifacts, '00-real-material-start.png') });

 await page.locator('.journal-workpage:not([hidden]) .journal-guide-choices').waitFor();
 const ownerState = await page.evaluate(() => fetch('/api/state').then(response => response.json()));
 const invalidCsrf = await post('journal/guide/follow', { scope, requestId: 'invalid' });
 assert.equal(invalidCsrf.status, 403);
 const foreign = await post('journal/guide/follow', { scope: { account: 'a'.repeat(64), userId: 'other' }, requestId: 'foreign' }, ownerState.data.csrf);
 assert.equal(foreign.status, 403);
 const guidePage = () => page.locator(`.journal-workpage[data-item="${guide().id}"]`);
 assert.ok(snapshot().guide.sources.length > 0);
 const firstChoice = guidePage().locator('.journal-guide-choices').getByRole('button').first();
 await firstChoice.focus(); await page.keyboard.press('Space');
 await page.waitForFunction(() => document.querySelector('.journal-guide-choices [data-selected=true]'));
 const selectedControl = guidePage().locator('.journal-guide-choices').getByRole('button', { pressed: true });
 assert.equal(await selectedControl.count(), 1, 'the pressed state is exposed by the actual button role');
 assert.equal(await selectedControl.isDisabled(), true, 'the selected choice remains visibly selected and cannot be resubmitted');
 const selected = guide().candidates.find(c => c.selected).id;
 // Read failures belong above the current work, not inside connection settings.
 await page.setViewportSize({ width: 390, height: 844 });
 await page.route('**/api/hub', route => route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试：消息读取失败' }) }) : route.continue());
 await page.reload(); await page.locator('#on-read-errors:not([hidden])').waitFor();
 assert.equal(await page.locator('#on-connection-settings').evaluate(el => el.open), false);
 assert.equal(await page.locator('#on-read-errors').isVisible(), true);
 await page.setViewportSize({ width: 390, height: 844 });
 assert.ok((await page.locator('#on-read-errors').boundingBox()).y < 250);
 await page.waitForTimeout(350);
 await page.screenshot({ path: join(artifacts, 'error-visible-mobile.png') });
 await page.unroute('**/api/hub'); await page.locator('#on-retry').click();
 await page.locator('#on-read-errors').waitFor({ state: 'hidden' });
 assert.equal(guide().candidates.find(c => c.selected).id, selected);
 await page.locator('.journal-guide-choices [data-selected=true]').waitFor();
 await page.evaluate(() => scrollTo(0, 0));
 const firstBox = await page.locator('.journal-guide-choices button').first().boundingBox();
 const followBox = await page.locator('[data-j-action=guide-follow]').boundingBox();
 assert.ok(firstBox.y < 300, 'a real choice is in the first screen');
 assert.ok(followBox.y + followBox.height <= 844, 'follow-up action fits the mobile screen');
 await page.screenshot({ path: join(artifacts, 'mobile-first-screen.png') });
 await page.setViewportSize({ width: 1440, height: 1100 });

 await page.screenshot({ path: join(artifacts, '01-choice.png') });
 await page.reload(); await enterGuide();
 assert.equal(guide().candidates.find(c => c.selected).id, selected);
 for (const width of [820, 390, 320]) { await page.setViewportSize({ width, height: 1100 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
 await page.setViewportSize({ width: 1440, height: 1100 });
 // A failed HTTP submission leaves the source choice intact and can be retried.
 await page.route('**/api/journal/guide/follow', route => route.abort('failed'));
 await guidePage().locator('[data-j-action=guide-follow]').click(); await page.waitForFunction(() => document.querySelector('#journal-status')?.textContent.includes('提交未能确认'));
 assert.equal(snapshot().guide.resultItemId, null); await page.unroute('**/api/journal/guide/follow');
 await guidePage().locator('[data-j-action=guide-follow]').dblclick();
 await page.waitForFunction(() => document.querySelector('.journal-guide-working'));
 assert.equal(followResponses.filter(response => response.status === 200).length, 1, 'the browser submits one accepted HTTP request on an insecure origin');
 assert.match(followResponses.find(response => response.status === 200).requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 const resultId = snapshot().guide.resultItemId; assert.ok(resultId); assert.equal(app.hub.all('run').length, 1);
 await page.screenshot({ path: join(artifacts, '02-working.png') });
 // Leave the page while work runs, then return to the same bookmark.
 await guidePage().locator('[data-j-action=guide-result]').click();
 assert.equal(await page.locator('.journal-workpage:not([hidden])').getAttribute('data-item'), resultId);
 timer = setInterval(() => { void tick(); }, 500); await tick();
 await page.reload(); await enterGuide();
 if (!real) { await page.waitForFunction(() => document.querySelector('.journal-guide-next [data-j-action=guide-follow]')?.textContent.includes('重试')); assert.ok((await page.locator('.journal-guide-next').innerText()).includes('等待超时')); await page.locator('.journal-guide-next [data-j-action=guide-follow]').click(); }
 if (real) {
  await page.waitForFunction(() => document.querySelector('.journal-guide-result .journal-guide-answer') || document.querySelector('.journal-guide-next [data-j-action=guide-follow]'), null, { timeout: 300000 });
  const report = app.firstTasks.guideSnapshot(snapshot());
  await writeFile(join(artifacts, 'agent-run.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  assert.ok(report?.answer, `Real agent did not complete: ${JSON.stringify(report)}`);
 }
 await page.locator('.journal-guide-result .journal-guide-answer').waitFor({ timeout: 15000 });
 assert.equal(snapshot().guide.resultItemId, resultId);
 await page.waitForTimeout(350); await page.screenshot({ path: join(artifacts, '03-result.png') });
 const answer = await page.locator('.journal-guide-result .journal-guide-answer').innerText(); assert.ok(answer.trim().length > 10);
 await page.reload(); await enterGuide(); await page.locator('.journal-guide-result .journal-guide-answer').waitFor(); assert.equal(await page.locator('.journal-guide-result .journal-guide-answer').innerText(), answer);
 await page.setViewportSize({ width: 390, height: 1000 }); await page.locator('.journal-guide-result .journal-guide-answer').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(artifacts, '04-mobile-result.png') });
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
 const previousGuideReport = app.firstTasks.guideSnapshot(snapshot());
 await page.locator('.journal-guide-result [data-j-action=guide-continue]').click();
 await page.locator('#chat-input').waitFor();
 await page.waitForFunction(id => document.querySelector(`[data-conversation="${id}"]`)?.getAttribute('aria-current') === 'true', previousGuideReport.conversationId);
 await page.getByText(answer, { exact: true }).waitFor();
 if (!real) {
  await page.locator('#chat-input').fill('请继续核对这件事，不修改记录。');
  await page.locator('#chat-send').click();
  await page.getByText('已按补充继续核对，新的结果仍属于原事项。', { exact: true }).waitFor();
  const continued = app.firstTasks.guideSnapshot(snapshot());
  assert.notEqual(continued.run.id, previousGuideReport.run.id);
  assert.equal(continued.conversationId, previousGuideReport.conversationId);
  assert.equal(continued.answer, '已按补充继续核对，新的结果仍属于原事项。');
  assert.equal(snapshot().guide.resultItemId, resultId);
  assert.ok(app.hub.get('run', previousGuideReport.run.id).report, 'the earlier report remains in its original run');
  await page.goto(url + '/#onboarding'); await page.reload();
  await page.locator('.journal-guide-result .journal-guide-answer').waitFor();
  assert.equal(await page.locator('.journal-guide-result .journal-guide-answer').innerText(), continued.answer);
 }
 await page.goto(url + '/#journal/' + resultId); await page.reload();
 const resultPage = page.locator(`.journal-workpage[data-item="${resultId}"]`), checkbox = resultPage.locator('[data-w-checkbox=step]').first();
 await checkbox.focus(); await page.keyboard.press('Space'); await page.waitForFunction(id => document.querySelector(`.journal-workpage[data-item="${id}"] [data-w-checkbox=step]`)?.checked, resultId);
 await page.reload(); assert.equal(snapshot().items.find(i => i.id === resultId).steps[0].done, true);
 await page.setViewportSize({ width: 1440, height: 1100 });
 await enterGuide();
 await guidePage().locator('.journal-guide-result [data-j-action=done]').click();
 await guidePage().locator('.journal-guide-result [data-j-action=done]').waitFor({ state: 'detached' });
 assert.equal(guide().status, 'done');
 await enterGuide();
 await guidePage().locator('.journal-guide-result .journal-guide-answer').waitFor();
 assert.equal(await guidePage().locator('.journal-guide-result .journal-guide-answer').innerText(), answer);
 const archivedChoices = guidePage().locator('.journal-guide-choices [data-w-action=choose]');
 assert.ok(await archivedChoices.count() > 0);
 assert.ok(await archivedChoices.evaluateAll(elements => elements.every(el => el.hasAttribute('disabled'))));
 assert.equal(await guidePage().locator('[data-widget=reflection],[data-widget=memory]').count(), 0);
 assert.equal(guide().status, 'done');
 await page.goto(url + '/#home');
 await page.locator('.home-focus button').waitFor();
 await page.locator('.home-focus button').click();
 await page.locator('.journal-followup-report[open]').waitFor();
 assert.ok((await page.locator('.journal-followup-report').innerText()).includes(answer.split('\n')[0]));
 await page.goto(url + '/#home');
 await page.locator('.home-journal-entry[data-journal-entry]').first().waitFor();
 const readingLink = page.locator('.home-journal-entry[data-journal-entry]').first();
 assert.ok((await readingLink.locator('strong').innerText()).length > 0);
 const entryId = await readingLink.getAttribute('data-journal-entry');
 const readingItemId = await readingLink.getAttribute('data-journal-item');
 // A real design may put the collection inside a compact reference panel.
 // Expanding the inner Accordion alone must not leave its ancestors collapsed.
 await page.route(/\/api\/(?:state|journal)(?:\?|$)/, async route => {
  const response = await route.fetch(), wire = await response.json();
  const journal = new URL(route.request().url()).pathname === '/api/state' ? wire.data?.journal : wire.data;
  for (const widget of journal?.layout?.widgets || []) if (widget.itemId === readingItemId && widget.kind === 'collection') widget.presentation = 'compact';
  await route.fulfill({ response, json: wire });
 });
 await page.goto(url + '/#journal/' + readingItemId);
 await page.reload();
 const readingPanel = page.locator(`.journal-workpage[data-item="${readingItemId}"] details[data-work-panel]`).filter({ has: page.locator(`[data-reading-entry="${entryId}"]`) });
 await readingPanel.waitFor();
 assert.equal(await readingPanel.evaluate(node => node.open), false, 'Ordinary item navigation keeps the compact reading panel collapsed');
 const readingWrites = writes.length;
 for (const width of [1440, 768, 390]) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url + '/#home');
  await page.reload();
  await page.locator(`.home-journal-entry[data-journal-entry="${entryId}"]`).click();
  const reading = page.locator(`[data-reading-entry="${entryId}"]`);
  await reading.locator('button[aria-expanded=true]').waitFor();
  assert.equal(await reading.locator('.jui-reading-summary').isVisible(), true, `${width}px: direct reading reveals the actual content, not only an expanded hidden trigger`);
  assert.equal(await reading.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) return false; return true; }), true);
  assert.equal(await reading.locator('button[aria-expanded]').evaluate(node => node === document.activeElement), true);
  await page.screenshot({ path: join(artifacts, `home-direct-reading-${width}.png`) });
  await readingPanel.locator(':scope > summary').click();
  await page.waitForFunction(id => !document.querySelector(`details[data-work-panel="${id}:collection"]`)?.open, readingItemId);
 }
 assert.equal(writes.length, readingWrites, 'Reading navigation and disclosure do not write the journal');
 await page.goto(url + '/#home');
 await page.reload();
 await page.locator(`.home-journal-entry[data-journal-entry="${entryId}"]`).click();
 await page.waitForTimeout(4300);
 assert.equal(await page.locator(`[data-reading-entry="${entryId}"] .jui-reading-summary`).isVisible(), true, 'Polling preserves the explicitly opened reading panel');
 await page.setViewportSize({ width: 390, height: 844 });
 assert.equal(await page.locator('#journal-index').isVisible(), false);
 await page.locator('#journal-index-toggle').click();
 await page.locator('#journal-index').waitFor({ state: 'visible' });
 await page.locator('#journal-index-toggle').click();
 await page.locator('#journal-index').waitFor({ state: 'hidden' });
 await page.goto(url + '/#chat'); await page.locator('#chat-input').waitFor();
 const inputBox = await page.locator('#chat-input').boundingBox();
 await page.screenshot({ path: join(artifacts, 'chat-mobile.png') });
 assert.ok(inputBox.y + inputBox.height <= 844, 'chat composer fits the mobile screen: ' + JSON.stringify(inputBox));
 await page.screenshot({ path: join(artifacts, 'chat-mobile.png') });
 await page.locator('.chat-list-toggle').click();
 assert.equal(await page.locator('#chat-sidebar').isVisible(), true);
 await page.locator('.chat-list-toggle').click();
 assert.equal(await page.locator('#chat-sidebar').isVisible(), false);
 assert.equal(app.firstTasks.snapshot().flow.id, draft.flowId); assert.equal(app.firstTasks.snapshot().flow.draft, '不要覆盖已有草稿');
 for (const item of originals) assert.deepEqual(snapshot().items.find(i => i.id === item.id), item);
 assert.equal(app.hub.all('delivery').length, 0); assert.deepEqual(errors, []); assert.deepEqual(ticks, []);
 const runs = app.hub.all('run').map(({ id, status, report }) => ({ id, status, report }));
 await writeFile(join(artifacts, 'receipt.json'), JSON.stringify({ realAgent: real, browserContext, followResponses, resultId, answer, runs, errors, writes, originalsUnchanged: true, deliveries: 0 }, null, 2), { mode: 0o600 });
 console.log('PASS: real sources → choice → follow-up → leave/resume → verified report → durable checklist; failed-submit/retry, draft preservation, desktop/mobile/keyboard, no external delivery.');
 await context.close();
} finally { clearInterval(timer); await companion?.stop(); await browser?.close(); await app?.shutdown(); await rm(root, { recursive: true, force: true }); }
