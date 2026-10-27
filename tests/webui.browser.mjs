// Optional browser acceptance suite. Uses isolated files, a fake Agent/channel and real HTTP APIs.
// npm install --no-save playwright; node tests/webui.browser.mjs
// Or set PA_PLAYWRIGHT_MODULE to an existing Playwright package directory.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createWebUI, python } from '../plugins/webui/server.mjs';
import { ProactiveEngine } from '../plugins/proactive/engine.mjs';
import { WeixinHarnessBridge } from '../vendor/deepseek-harness-weixin/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pa-browser-'));
const screenshotDir = join(ROOT, '.runtime/verification/restraint-20261022/shell');
let browser, app, engine;
try {
  for (const dir of ['bin', 'scripts', 'config', 'home', 'phone-refs', 'agents']) await cp(join(ROOT, dir), join(root, dir), { recursive: true });
  await mkdir(join(root, 'skills/phone/references/apps'), { recursive: true });
  await mkdir(join(root, '.runtime/pairing'), { recursive: true });
  const cfg = JSON.parse(await readFile(join(ROOT, 'config/pa.example.json'), 'utf8'));
  cfg.owner = '林同学'; cfg.im.allow_from = ['fixture-user-a'];
  await writeFile(join(root, '.runtime/pa.json'), JSON.stringify(cfg));
  await writeFile(join(root, '.runtime/pairing/request.json'), JSON.stringify({ userId: 'fixture-user-b', receivedAt: new Date().toISOString() }));
  let now = Date.now();
  engine = new ProactiveEngine({ config: { ...cfg.proactive, timezone: 'Asia/Shanghai', state_dir: join(root, '.runtime/proactive') }, accountId: 'fixture-account', allowed: id => cfg.im.allow_from.includes(id), now: () => now,
    send: async () => assert.fail('Browser tests must never send'), analyze: async () => '{"changes":[]}' });
  await engine.initialize({ startTimer: false });
  const addUser = id => {
    const u = engine.createUser(now - 10 * 60000); Object.assign(u, { contextToken: 'FIXTURE_PRIVATE_TOKEN', contextAt: now, day1Created: true });
    u.tasks.push({ id: '12345678', kind: 'reminder', title: '出门前，确认西装已经熨好', evidence: '明天晚宴前，提前一小时提醒我准备西装。', status: 'pending', notifyAt: now + 3600000, expiresAt: now + 18000000, createdAt: now });
    engine.store.data.users[id] = u;
  };
  addUser('fixture-user-a'); await engine.store.save();
  const bridge = Object.assign(Object.create(WeixinHarnessBridge.prototype), { proactive: engine, connected: true, config: { paConfigRevision: '', paProvider: 'dsh' } });
  let completeLogin;
  const rpc = async (_socket, request) => {
    if (request.command === 'login') return { ok: true, kind: 'qr', url: 'https://example.invalid/test-only', loginId: 'fixture-login' };
    if (request.command === 'wait-login') return new Promise(resolve => { completeLogin = resolve; });
    return { ok: true, kind: 'pa', data: await bridge.management(request) };
  };
  const helper = async request => {
    const result = await python(root, request);
    if (request.action === 'apply') { Object.assign(cfg, result.config); bridge.config.paConfigRevision = result.revision; bridge.config.paProvider = cfg.agent.provider; Object.assign(engine.config, cfg.proactive, { timezone: 'Asia/Shanghai' }); }
    return result;
  };
  app = createWebUI({ root, helper, rpc });
  const journalScope = { account: 'local', userId: 'owner' }, journalStore = app.journal.store;
  let journalClock = now - 86400000;
  journalStore.now = () => journalClock;
  const journalItems = [];
  for (const title of ['昨天的邮件', '昨天的 GitHub', '今天的邮件', '今天的 GitHub']) {
    journalClock += 3600000;
    const snapshot = journalStore.snapshot(journalScope);
    journalItems.push(journalStore.mutate(journalScope, { operation: 'add', revision: snapshot.revision, values: { title } }).items.at(-1));
  }
  journalClock = now;
  const beforeUpdate = journalStore.snapshot(journalScope);
  journalStore.mutate(journalScope, { operation: 'update', revision: beforeUpdate.revision, itemId: journalItems[0].id, itemVersion: journalItems[0].version, values: { note: '今天补充了核对结果。' } });
  journalStore.now = () => Date.now();
  const journalRevision = journalStore.snapshot(journalScope).revision;
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/`;
  browser = await chromium.launch({ headless: true, ...(process.env.PA_BROWSER_CHANNEL ? { channel: process.env.PA_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const navigate = async target => { const button = page.locator('#nav-' + target); if (!await button.isVisible()) await page.locator('#nav-more > summary').click(); await button.click(); };
  const clickAndSettle = async selector => { await page.locator(selector).click(); await page.waitForFunction(s => { const button = document.querySelector(s); return button && !button.disabled && !button.textContent.includes('正在处理'); }, selector); };
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(url); await page.locator('#home-done').waitFor();
  assert.deepEqual(await page.locator('.home-journal-entry strong').allTextContents(), ['昨天的邮件', '今天的 GitHub', '今天的邮件'], 'Recent updates take precedence over creation order and fill the first three slots');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.skip-link').evaluate(node => node === document.activeElement && node.getBoundingClientRect().top >= 0), true, 'Keyboard skip link remains visibly focused');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#main').evaluate(node => node === document.activeElement), true);
  await page.locator('#nav-home').click();
  assert.equal(await page.locator('#main h1').evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'none'), true, 'Pointer navigation announces the heading without a default outline');
  await page.locator('#nav-home').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#main h1').evaluate(node => node === document.activeElement && node.matches(':focus-visible') && getComputedStyle(node).outlineStyle === 'solid'), true, 'Keyboard navigation retains a visible heading focus');
  assert.equal(journalStore.snapshot(journalScope).revision, journalRevision, 'Ordering and navigation do not mutate journal data');
  assert.equal(await page.locator('.top .nav > button').count(), 3);
  await page.locator('#nav-more > summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#nav-prefs').isVisible(), true);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#nav-prefs').isVisible(), false);
  assert.equal(await page.locator('#nav-more > summary').evaluate(el => el === document.activeElement), true);
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, 'today-desktop.png'), fullPage: true });
  await page.locator('#home-detail').click();
  assert.equal(await page.locator('#task-title').isVisible(), false);
  await page.locator('.task-adjust > summary').click();
  await page.locator('#task-title').fill('西装已备好，出门前再检查');
  await clickAndSettle('#save-title'); await page.waitForFunction(() => document.querySelector('#dialog-status')?.textContent.includes('已保存'));
  assert.equal(engine.store.data.users['fixture-user-a'].tasks[0].title, '西装已备好，出门前再检查');
  await page.locator('#snooze-minutes').selectOption('15'); await clickAndSettle('#save-snooze');
  await page.waitForFunction(() => document.querySelector('#dialog-status')?.textContent.includes('已保存'));
  assert.equal(engine.store.data.users['fixture-user-a'].tasks[0].notifyAt, now + 15 * 60000);
  await page.locator('#detail-done').click(); await page.locator('#detail-undo').waitFor();
  assert.equal(engine.store.data.users['fixture-user-a'].tasks[0].status, 'done');
  await page.locator('#detail-undo').click(); await page.locator('#detail-done').waitFor();
  assert.equal(engine.store.data.users['fixture-user-a'].tasks[0].status, 'pending');
  await page.getByRole('button', { name: '关闭详情' }).click();
  await navigate('prefs');
  await page.getByText('微信提醒', { exact: true }).click();
  await page.locator('#quiet-start').fill('21:00'); await page.locator('#quiet-end').fill('21:00');
  await clickAndSettle('#save-prefs');
  assert.equal(await page.locator('#quiet-end').getAttribute('aria-invalid'), 'true');
  await page.locator('#quiet-end').fill('08:00'); await page.locator('#max-daily').selectOption('1');
  await clickAndSettle('#save-prefs'); await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('已保存'));
  assert.equal(engine.store.data.users['fixture-user-a'].preferences.max_daily, 1);
  await page.locator('#quiet-start').fill('20:30');
  await clickAndSettle('#global-toggle'); await page.waitForFunction(() => document.querySelector('#global-toggle')?.textContent.includes('开启'));
  assert.equal(await page.locator('#quiet-start').inputValue(), '20:30', 'saving global switch must retain user preference draft');
  await page.getByRole('button', { name: '重新载入', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#quiet-start')?.value === '21:00');
  await clickAndSettle('#global-toggle'); await page.waitForFunction(() => document.querySelector('#global-toggle')?.textContent.includes('关闭'));
  await navigate('connections');
  assert.equal(await page.locator('#owner').isVisible(), false);
  await page.locator('#runtime-settings > summary').click();
  const diagnostics = page.locator('#runtime-settings > .truth-details');
  assert.equal(await diagnostics.evaluate(node => node.open), false, 'Connection evidence remains collapsed inside runtime settings');
  await diagnostics.locator(':scope > summary').click();
  assert.equal(await diagnostics.locator('pre').isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Expanded diagnostics wrap within the page');
  await diagnostics.locator(':scope > summary').click();
  const advanced = page.locator('#agent-form summary'); await advanced.click(); await page.waitForTimeout(5600);
  assert.equal(await advanced.evaluate(el => el.parentElement.open), true, 'polling preserves expanded settings');
  assert.equal(await page.locator('#wda-url').isVisible(), false);
  await page.locator('#owner').fill('张同学'); await clickAndSettle('#save-agent');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('配置已保存'));
  assert.equal(JSON.parse(await readFile(join(root, '.runtime/pa.json'), 'utf8')).owner, '张同学');
  await page.locator('#owner').fill('配对期间的配置草稿');
  await writeFile(join(root, '.runtime/pairing/request.json'), JSON.stringify({ userId: 'fixture-user-c', receivedAt: new Date().toISOString() }));
  await page.waitForTimeout(5600);
  await page.locator('#approve-0').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('待确认用户的状态已变化'));
  assert.ok(!cfg.im.allow_from.includes('fixture-user-c'), 'old pairing row must not approve a different user');
  await writeFile(join(root, '.runtime/pairing/request.json'), JSON.stringify({ userId: 'fixture-user-b', receivedAt: new Date().toISOString() }));
  await page.locator('#agent-form').getByRole('button', { name: '重新载入' }).click();
  await page.locator('[data-action=approve][data-user=fixture-user-b]').waitFor();
  await page.locator('#approve-0').click(); await page.locator('#revoke-1').waitFor();
  assert.ok(cfg.im.allow_from.includes('fixture-user-b'));
  await page.locator('#login').click(); await page.locator('.qr').waitFor();
  assert.match(await page.locator('.qr').getAttribute('src'), /^data:image\/svg\+xml;base64,/);
  completeLogin({ ok: true, kind: 'connected' });
  await page.getByText('已登录，请确认联系人。').waitFor({ timeout: 10000 });
  await clickAndSettle('#device-check'); await page.getByText('未启用移动设备', { exact: true }).waitFor();
  // A second browser changes config: the first keeps its draft and receives a conflict.
  await page.locator('#owner').fill('未提交的草稿');
  const external = await python(root, { action: 'read' });
  await python(root, { action: 'save', revision: external.revision, patch: { owner: '另一个窗口' } });
  await clickAndSettle('#save-agent');
  await page.waitForFunction(() => document.querySelector('#agent-status')?.textContent.includes('别处更新'));
  assert.equal(await page.locator('#owner').inputValue(), '未提交的草稿');
  await page.locator('#agent-form').getByRole('button', { name: '重新载入' }).click();
  await page.waitForFunction(() => document.querySelector('#owner')?.value === '另一个窗口');
  await navigate('tasks'); await page.getByRole('button', { name: '添加提醒', exact: true }).click();
  await page.locator('#new-title').fill('<img src=x onerror=alert(1)>'); await page.locator('#save-new').click(); await page.locator('#detail').waitFor({ state: 'hidden' });
  assert.equal(engine.store.data.users['fixture-user-a'].tasks.length, 2);
  assert.equal(await page.locator('.task-list img').count(), 0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const tab of ['home', 'tasks', 'prefs', 'connections']) {
      await navigate(tab);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tab} overflows ${width}`);
      await page.screenshot({ path: join(screenshotDir, `${tab}-${width}.png`), fullPage: true });
    }
  }
  // Identity drift: a removed user must never transfer an open draft to the next user.
  await navigate('tasks'); await page.getByRole('button', { name: '添加提醒', exact: true }).click();
  await page.locator('#new-title').fill('只属于 A 的草稿');
  addUser('fixture-user-b'); delete engine.store.data.users['fixture-user-a']; await engine.store.save();
  await page.waitForTimeout(5600);
  await page.locator('#save-new').click();
  await page.waitForFunction(() => document.querySelector('#dialog-status')?.textContent.includes('原来选择的用户已变化'));
  assert.equal(engine.store.data.users['fixture-user-b'].tasks.length, 1);
  assert.equal(await page.locator('#new-title').inputValue(), '只属于 A 的草稿');
  await page.getByRole('button', { name: '关闭详情' }).click();
  assert.deepEqual(errors, []);
  console.log('Browser acceptance passed: real API config/save/conflict/apply/pairing/QR/preferences/tasks, identity binding, XSS and 1280/390/320 layouts. No external messages or devices used.');
} finally {
  await browser?.close(); await app?.shutdown(); await engine?.stop(); await rm(root, { recursive: true, force: true });
}
