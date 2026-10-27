// Isolated HTTP/SQLite/browser acceptance; no account reads or messages.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWebUI } from '../plugins/webui/server.mjs';
import { createAutomaticContent } from '../plugins/proactive/automatic-content.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)), root = await mkdtemp(join(tmpdir(), 'auto-content-browser-'));
const artifacts = join(ROOT, '.runtime/verification/restraint-20261022/automatic');
const config = JSON.parse(await readFile(join(ROOT, 'config/pa.example.json'), 'utf8'));
config.proactive.enabled = false;
let app, browser;
try {
  await mkdir(artifacts, { recursive: true });
  app = createWebUI({ root,
    helper: async () => ({ config, revision: 'isolated', installed: true, runtimeInstalled: true, pending: [], socket: '/no-runtime' }),
    rpc: async () => ({ kind: 'pa', data: { protocol: 1, account: null, users: [], connected: false, configRevision: 'isolated' } }),
    journalRuntimeFactory: async () => ({ ready: false, request: async () => ({ accepted: false }), stop() {} }),
  });
  const scope = { account: 'local', userId: 'owner' }, store = app.journal.store, now = Date.now(), day = 86400000;
  let fixtureTime = now - 14 * day; store.now = () => fixtureTime;
  const add = values => store.mutate(scope, { operation: 'add', revision: store.snapshot(scope).revision, values }).items.at(-1);
  const old = add({ title: '隔离示例：上周的安排', date: new Date(now - 7 * day).toISOString() });
  const waiting = add({ title: '隔离示例：没有时间限制的准备' });
  const overdue = add({ title: '隔离示例：明确截止、完成待核对', taskType: 'deadline', taskData: { deadline: { dueAt: new Date(now - 2 * 3600000).toISOString() } } });
  const started = add({ title: '隔离示例：开始时间已到、进度未确认', date: new Date(now - 3600000).toISOString() });
  const reminder = add({ title: '隔离示例：只在提醒计划中记录的安排', taskType: 'reminder', taskData: { reminder: { at: new Date(now + 2 * 3600000).toISOString(), minutesBefore: 30 } } });
  fixtureTime = now;
  const soon = add({ title: '隔离示例：六小时后的安排', date: new Date(now + 6 * 3600000).toISOString() });
  const week = add({ title: '隔离示例：五天后的安排', date: new Date(now + 5 * day).toISOString() });
  const changed = add({ title: '隔离示例：刚补充的事项' });
  const content = createAutomaticContent({ hub: app.hub, journal: app.journal });
  content.configure({ operation: 'configure', revision: 0, enabled: true, discovery: true, maxDaily: 8, topics: ['组件设计'], sources: ['google-mail', 'github', 'x'] });
  content.publish({ operation: 'publish', entries: [{
    key: 'fixture', source: 'github', sourceGeneration: 2, title: '隔离验收示例：组件发布说明',
    hook: '这组测试组件可以重新组合，改页面时也许能少拆几面墙。',
    summary: '维护者介绍了新的组件组合方式。这是隔离验收用的材料，不代表真实仓库更新。',
    relevance: '与组件设计的关注点相关。', suggestion: '打开来源后再决定是否试用。',
    topic: '组件设计', exploration: false, url: 'https://example.com/release', observedAt: Date.now(), expiresAt: Date.now() + 86400000,
    coverage: '隔离测试来源；未运行产品。', evidence: [{ quote: 'Composable components in this fixture.', url: 'https://example.com/release', type: 'primary', complete: true }],
  }] }, [{ id: 'github', account: 'fixture', generation: 2 }], 'Asia/Shanghai');
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const require = createRequire(import.meta.url), { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.PA_BROWSER_CHANNEL ? { channel: process.env.PA_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + '/#journal');
  const automaticId = content.snapshot().entries[0].itemId;
  const order = () => page.locator('.journal-workpage').evaluateAll(nodes => nodes.map(node => node.dataset.item));
  await page.locator('.journal-workpage').first().waitFor();
  assert.deepEqual(await order(), [overdue.id, started.id, reminder.id, soon.id, automaticId, week.id, changed.id, waiting.id, old.id], 'Deadlines and nearby plans remain prominent; passing a start time does not imply completion');
  assert.equal(await page.locator('.journal-workpage:not([hidden])').count(), 1, 'The book opens one task at a time');
  const autoPage = page.locator(`.journal-workpage[data-item="${automaticId}"]`);
  await page.locator(`#journal-bookmarks [data-item="${automaticId}"]`).click();
  const beforeOrder = await order(), beforeUpdate = store.snapshot(scope), oldItem = beforeUpdate.items.find(item => item.id === old.id);
  store.mutate(scope, { operation: 'update', revision: beforeUpdate.revision, itemId: old.id, itemVersion: oldItem.version, values: { note: '隔离示例：另一个入口补充了这件事。' } });
  await page.waitForFunction(id => document.querySelector(`.journal-workpage[data-item="${id}"]`)?.dataset.priority === '3', old.id);
  assert.deepEqual(await order(), beforeOrder, 'Background changes do not move the page being read');
  await autoPage.locator('[data-j-action=work-toggle]').click();
  await page.waitForFunction(id => document.querySelector(`.journal-workpage[data-item="${id}"]`)?.dataset.expanded === 'false', automaticId);
  assert.equal((await order()).at(-1), waiting.id, 'Closing the reading view applies the new priority');
  assert.equal(await page.locator(`.journal-workpage[data-item="${old.id}"]`).isVisible(), false, 'A background update does not switch the reader to another record');
  assert.equal(store.snapshot(scope).items.find(item => item.id === old.id).status, oldItem.status);
  await page.reload(); await autoPage.waitFor();
  assert.equal(await autoPage.getAttribute('data-expanded'), 'false', 'Explicit collapsed state survives reload');
  await autoPage.locator('[data-j-action=work-toggle]').focus();
  await page.keyboard.press('Enter');
  const entry = page.locator('.jw-auto-entry');
  await entry.waitFor();
  assert.match(await entry.locator('h3').first().textContent(), /少拆几面墙/);
  assert.equal(await entry.locator('.jui-reading-summary').isVisible(), false, 'The hook does not force the full brief onto the reader');
  assert.ok(await entry.evaluate(node => node.classList.contains('openui-card')), 'Reading uses the official OpenUI Card');
  const details = entry.locator('.jui-reading-details');
  assert.equal(await details.locator('button[aria-expanded]').getAttribute('aria-expanded'), 'false');
  await details.locator('button[aria-expanded]').click();
  assert.ok(await entry.getByRole('button', { name: '有用', exact: true }).evaluate(node => node.classList.contains('openui-button-base')));
  await page.waitForTimeout(4300);
  assert.equal(await details.locator('button[aria-expanded]').getAttribute('aria-expanded'), 'true', 'Polling preserves the reader’s expanded evidence');
  await entry.getByRole('button', { name: '有用', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-j-action="content-feedback"][aria-pressed="true"]')?.textContent === '有用');
  assert.equal(content.snapshot().topics[0].score, 3);
  assert.equal(await details.locator('button[aria-expanded]').getAttribute('aria-expanded'), 'true', 'Feedback keeps the evidence disclosure in place');
  await page.reload();
  await page.locator('.jui-reading-details button[aria-expanded=false]').first().click();
  await page.locator('[data-j-action="content-feedback"][aria-pressed="true"]').waitFor({ state: 'attached' });
  const originalTitle = await page.locator('.jw-auto-entry h3').first().textContent();
  content.publish({ operation: 'publish', entries: [{
    key: 'later-fixture', source: 'github', sourceGeneration: 2, title: '隔离验收示例：阅读过程中新增的说明',
    summary: '这是在读者展开页面后到达的新材料，用来验证阅读位置保持。', relevance: '仍属于组件设计话题。',
    suggestion: '读完当前内容后再查看。', topic: '组件设计', exploration: false, url: 'https://example.com/later',
    observedAt: Date.now(), expiresAt: Date.now() + day, coverage: '隔离测试来源；未运行产品。',
    evidence: [{ quote: 'New information arrived while reading.', url: 'https://example.com/later', type: 'primary', complete: true }],
  }] }, [{ id: 'github', account: 'fixture', generation: 2 }], 'Asia/Shanghai');
  await page.waitForFunction(() => document.querySelectorAll('.jw-auto-entry').length === 2);
  assert.equal(await page.locator('.jw-auto-entry h3').first().textContent(), originalTitle, 'New material does not push down the current reading');
  await autoPage.locator('[data-j-action=work-toggle]').click();
  assert.match(await autoPage.locator('.journal-overview-titles li').first().textContent(), /阅读过程中新增/);
  await autoPage.locator('[data-j-action=work-toggle]').click();
  assert.match(await page.locator('.jw-auto-entry h3').first().textContent(), /阅读过程中新增/, 'Next opening starts with the newest material');
  await page.locator('#journal-preferences>summary').click();
  await page.locator('#journal-content-settings>summary').click();
  await page.locator('#journal-content-topics').fill('组件设计\n知识管理');
  await page.locator('#journal-content-guidance').fill('先分享一句轻松的小发现，完整材料展开再看。');
  await page.locator('[data-j-action=content-settings-save]').click();
  await page.waitForFunction(() => document.querySelector('#journal-status')?.textContent === '已保存');
  assert.deepEqual(content.policy().topics, ['组件设计', '知识管理']);
  assert.equal(content.policy().readingGuidance, '先分享一句轻松的小发现，完整材料展开再看。');
  await page.locator('#journal-content-settings>summary').click();
  await page.waitForFunction(() => !document.querySelector('#journal-content-settings').open);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, 'automatic-content-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, 'automatic-content-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const unauthorized = await fetch(url + '/api/automatic-content', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'feedback', id: content.snapshot().entries[0].id, reaction: 'less' }) });
  assert.equal(unauthorized.status, 403); assert.equal(content.snapshot().topics.find(t => t.name === '组件设计').score, 3);
  // The book must keep correction available even for automatically assembled pages.
  if (!await autoPage.locator('.journal-item-actions').getAttribute('open').then(value => value !== null)) await autoPage.locator('.journal-item-actions > summary').click();
  await autoPage.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('dialog .journal-editor-more > summary').click();
  assert.equal(await page.locator('dialog [data-j-action=delete]').isVisible(), true);
  await page.getByRole('button', { name: '关闭生活记录', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator('[data-j-tab=all]').click();
  await page.locator(`#journal-bookmarks [data-item="${automaticId}"]`).click();
  if (!await autoPage.locator('.journal-item-actions').getAttribute('open').then(value => value !== null)) await autoPage.locator('.journal-item-actions > summary').click();
  await autoPage.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '关闭生活记录', exact: true }).click();
  await autoPage.getByRole('button', { name: '归档', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#journal-status').textContent.includes('已确认结束'));
  await page.locator('[data-j-tab=kept]').click();
  if (!await autoPage.locator('.journal-item-actions').getAttribute('open').then(value => value !== null)) await autoPage.locator('.journal-item-actions > summary').click();
  await autoPage.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('dialog .journal-editor-more > summary').click();
  assert.equal(await page.locator('dialog [data-j-action=delete]').isVisible(), true);
  await page.getByRole('button', { name: '关闭生活记录', exact: true }).click();
  await page.locator('[data-j-tab=recent]').click();
  const lastBookmark = page.locator('#journal-bookmarks button').last();
  await lastBookmark.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#journal-index-toggle').click();
  const focusInDirectory = await page.locator('#journal-bookmarks').evaluate(nav => {
    const active = document.activeElement, outer = nav.getBoundingClientRect(), inner = active.getBoundingClientRect();
    return nav.contains(active) && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
  });
  assert.equal(focusInDirectory, true, 'Opening the mobile directory scrolls its selected bookmark into view');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, priorityOrder: true, stableWhileReading: true, keyboardDisclosure: true, feedbackPersisted: true, responsive: true, csrf: true, automaticEditAllViews: true, longDirectoryFocus: true, artifacts }));
} finally {
  await browser?.close(); app?.server.closeAllConnections(); await app?.shutdown(); await rm(root, { recursive: true, force: true });
}
