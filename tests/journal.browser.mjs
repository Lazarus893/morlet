// Optional browser acceptance: real HTTP + SQLite + designer, isolated model/channel substitutes.
// PA_PLAYWRIGHT_MODULE=/path/to/playwright node tests/journal.browser.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createWebUI } from '../plugins/webui/server.mjs';
import { JournalDesigner } from '../plugins/life-journal/designer.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pa-journal-browser-'));
const artifacts = join(ROOT, '_temp/journal-acceptance');
const local = { account: 'local', userId: 'owner' }, account = 'a'.repeat(64);
let browser, app, context, delay = 1700, invalidDesign = false, users = [];
const config = JSON.parse(await readFile(join(ROOT, 'config/pa.example.json'), 'utf8'));
config.owner = '验收用户'; config.agent.provider = 'codex'; config.proactive.enabled = false;
const settings = { config, revision: 'fixture-config', installed: true, runtimeInstalled: true, pending: [], socket: '/never-connect-to-real-socket' };
let analyzes = 0;
try {
  await mkdir(artifacts, { recursive: true });
  app = createWebUI({ root, helper: async () => settings, rpc: async (_socket, request) => {
    assert.equal(request.operation, 'snapshot', 'No message, phone or account mutation is allowed');
    return { kind: 'pa', data: { protocol: 1, account: users.length ? account : null, users, connected: false, configRevision: 'fixture-config' } };
  }, journalRuntimeFactory: async ({ store }) => {
    const designer = new JournalDesigner({ root, store, analyze: async (_role, text, signal) => {
      analyzes++;
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, delay); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
      if (invalidDesign) return '{"widgets":[{"kind":"script","code":"alert(1)"}],"reason":"unsafe"}';
      const input = JSON.parse(text), widgets = [];
      for (const item of input.items) {
        if (item.status === 'cancelled') continue;
        const kinds = item.status === 'done' ? ['memory'] : item.kind === 'wish' ? ['wish'] : ['focus', ...(item.steps.length ? ['checklist'] : []), ...(item.candidates.length && !item.candidates.some(c => c.selected) ? ['comparison'] : []), ...(item.date ? ['timeline'] : [])];
        for (const kind of kinds) widgets.push({ id: `${item.id}:${kind}`, itemId: item.id, kind, emphasis: widgets.length === 0 ? 'primary' : 'normal', reason: '测试模型基于真实记录的提案' });
      }
      return JSON.stringify({ widgets: widgets.slice(0, 12), reason: '按生日准备阶段分层整理' });
    } });
    await designer.initialize();
    return { ready: true, request: (...args) => designer.request(...args), stop: () => designer.stop() };
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/`;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai', recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  const state = () => app.journal.store.snapshot(local);
  const saved = async () => { await page.locator('.journal-editor').waitFor({ state: 'hidden' }); };
  const settle = async () => { await page.waitForFunction(() => document.querySelector('#journal-design strong')?.textContent.includes('AI 已整理')); };
  const first = () => page.locator('.journal-widget').first();
  const adjust = async card => { if (!(await card.locator('.journal-adjust').evaluate(node => node.open))) { await card.locator('.journal-adjust>summary').click(); await page.waitForTimeout(300); } };
  await page.goto(url); await page.locator('#nav-journal').click();
  await page.getByRole('heading', { name: '你的生活手账' }).waitFor();
  assert.equal(await page.locator('.journal-widget').count(), 0, 'No invented records before first input');
  await page.screenshot({ path: join(artifacts, 'journal-empty-desktop.png'), fullPage: true });
  await page.locator('#journal-add').click();
  await page.locator('#journal-title').fill('给妈妈准备生日');
  await page.locator('#journal-date').fill('2026-10-17T16:00');
  await page.locator('#journal-note').fill('已确认 6 人，预算 300 元，评价暂未填写。');
  await page.locator('#journal-steps').fill('确认人数\n准备贺卡\n取蛋糕');
  await page.locator('#journal-candidates').fill('芋泥蛋糕 | 门店提供的材料，300 元 | https://example.invalid/cake\n水果蛋糕 | 家人提供的候选，280 元');
  await page.locator('#journal-save').click(); await saved();
  assert.equal(state().items[0].date, '2026-10-17T08:00:00.000Z', 'User local date is stored as UTC');
  assert.equal(state().items[0].source.channel, 'web');
  await page.locator('.journal-widget').first().waitFor();
  await page.waitForTimeout(2200); // Observe generation while actual model substitute finishes.
  await settle(); await page.waitForTimeout(350);
  assert.ok(analyzes > 0, 'Default designer dispatched without explicit design request');
  await page.screenshot({ path: join(artifacts, 'birthday-desktop.png'), fullPage: true });
  await page.screenshot({ path: join(artifacts, 'birthday-overview.png') });
  await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(250);
  assert.ok((await first().boundingBox()).y < 720, 'The real birthday reaches the mobile first screen');
  await page.screenshot({ path: join(artifacts, 'birthday-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const widgetId = await first().getAttribute('data-widget');
  await page.evaluate(() => { window.__stableCard = document.querySelector('.journal-widget'); });
  await page.waitForTimeout(5300);
  assert.equal(await page.evaluate(() => window.__stableCard === document.querySelector('.journal-widget')), true, 'Polling keeps component identity');
  // Confirmed checkbox action does not end the parent event.
  await page.locator('.journal-widget[data-kind=checklist] [data-j-step]').first().check();
  await page.waitForFunction(() => document.querySelector('#journal-status').textContent === '已保存。');
  assert.equal(state().items[0].steps[0].done, true); assert.equal(state().items[0].status, 'planned');
  // Editing keeps input and focus through incoming snapshots.
  await first().getByRole('button', { name: '查看与校对' }).click();
  assert.equal(await page.locator('#journal-date').inputValue(), '2026-10-17T16:00');
  await page.locator('#journal-date').fill('2026-10-18T16:00'); await page.locator('#journal-note').fill('改周日，已经联系家人。');
  await page.waitForTimeout(5100); assert.equal(await page.locator('#journal-note').inputValue(), '改周日，已经联系家人。');
  await page.locator('#journal-save').click(); await saved();
  assert.equal(state().items[0].date, '2026-10-18T08:00:00.000Z');
  await settle();
  await page.locator('.journal-widget[data-kind=comparison]').getByRole('button', { name: '标记选择' }).first().click();
  await page.waitForFunction(() => !document.querySelector('.journal-widget[data-kind=comparison]'));
  assert.equal(state().items[0].candidates[0].selected, true);
  await settle();
  // Persist controls and restore hidden widget even when it is removed from the returned layout.
  await adjust(first());
  await first().getByRole('button', { name: '固定', exact: true }).click(); await page.waitForTimeout(250);
  assert.ok(state().preferences.pinned.includes(widgetId));
  await first().getByRole('button', { name: '已固定', exact: true }).click(); await page.waitForTimeout(250);
  await first().getByRole('button', { name: '下移', exact: true }).click(); await page.waitForTimeout(250);
  assert.ok(state().preferences.order.length > 1);
  await adjust(first());
  await first().getByRole('button', { name: '隐藏', exact: true }).click(); await page.waitForTimeout(250);
  assert.equal(state().preferences.hidden.length, 1);
  await page.locator('.journal-settings>summary').click();
  await page.locator('#journal-hidden button').first().click(); await page.waitForTimeout(250);
  assert.equal(state().preferences.hidden.length, 0);
  await page.locator('#journal-motion').selectOption('reduced'); await page.waitForTimeout(250);
  assert.equal(state().preferences.motion, 'reduced'); assert.equal(await page.evaluate(() => window.PAMotion.reduced()), true);
  await page.locator('#journal-motion').selectOption('off'); await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'off');
  await page.locator('#journal-auto').uncheck(); await page.waitForTimeout(250);
  assert.equal(state().preferences.autoLayout, false);
  assert.equal(await page.locator('#journal-redesign').isDisabled(), true);
  // Conflict cannot silently replace external changes or erase the user's draft.
  await first().getByRole('button', { name: '查看与校对' }).click();
  await page.locator('#journal-title').fill('我的修改草稿');
  const original = state();
  app.journal.store.mutate(local, { operation: 'update', revision: original.revision, itemId: original.items[0].id, itemVersion: original.items[0].version, values: { note: '另一个入口已更新' } });
  await page.locator('#journal-save').click();
  await page.waitForFunction(() => document.querySelector('#journal-editor-status').dataset.error === 'true');
  assert.equal(await page.locator('#journal-title').inputValue(), '我的修改草稿');
  assert.equal(state().items[0].note, '另一个入口已更新');
  await page.getByRole('button', { name: '核对最新版本' }).click();
  assert.equal(await page.locator('#journal-title').inputValue(), '我的修改草稿');
  await page.locator('#journal-save').click(); await saved();
  assert.equal(state().items[0].title, '我的修改草稿');
  // XSS-looking source is rendered as text and all external URLs use the safe renderer.
  await page.locator('#journal-add').click(); await page.locator('#journal-title').fill('<img src=x onerror="window.__unsafe=1">');
  await page.locator('#journal-kind').selectOption('wish'); await page.locator('#journal-save').click(); await saved();
  await page.locator('[data-j-tab=all]').click();
  assert.equal(await page.evaluate(() => window.__unsafe), undefined); assert.equal(await page.locator('.journal img').count(), 0);
  // A real existing delivery event is emphasized once, and remains readable after reload.
  config.im.allow_from = ['fixture-user'];
  users = [{ id: 'fixture-user', revision: 1, tasks: [{ id: 'fixture-reminder', title: '取蛋糕', status: 'submitted', version: 1, notifyAt: Date.now() - 1000 }], preferences: config.proactive }];
  await page.waitForTimeout(5400);
  await page.locator('#journal-notice').waitFor({ state: 'visible' });
  const noticeKey = await page.evaluate(() => localStorage.getItem('pa-journal-notices-v1'));
  await page.reload(); await page.locator('#nav-journal').click();
  await page.locator('#journal-notice').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => localStorage.getItem('pa-journal-notices-v1')), noticeKey, 'Reload preserves event identity');
  // Scope selection is explicit and never moves local records into a WeChat user's ledger.
  await page.locator('#journal-scope').selectOption(JSON.stringify([account, 'fixture-user']));
  await page.waitForFunction(() => document.querySelector('#journal-status').textContent === '已切换手账。');
  assert.equal(await page.locator('.journal-widget').count(), 0);
  await page.locator('#journal-add').click(); await page.locator('#journal-title').fill('微信用户自己的安排'); await page.locator('#journal-save').click(); await saved();
  assert.equal(app.journal.store.snapshot({ account, userId: 'fixture-user' }).items.length, 1);
  assert.equal(state().items.length, 2);
  await page.locator('#journal-scope').selectOption(JSON.stringify(['local', 'owner'])); await page.waitForFunction(() => document.querySelector('#journal-scope').value.includes('local'));
  await page.locator('[data-j-tab=all]').click();
  await page.locator('.journal-widget').filter({ hasText: '我的修改草稿' }).getByRole('button', { name: '确认结束' }).click();
  await page.waitForTimeout(300); assert.equal(state().items[0].status, 'done');
  await page.locator('[data-j-tab=kept]').click();
  await page.locator('.journal-widget').filter({ hasText: '我的修改草稿' }).getByRole('button', { name: '查看与校对' }).click();
  assert.equal(await page.locator('#journal-date').isDisabled(), true);
  await page.locator('#journal-note').fill('生日很开心，下次还选这家蛋糕。');
  await page.locator('#journal-save').click(); await saved();
  assert.equal(state().items[0].status, 'done'); assert.equal(state().items[0].note, '生日很开心，下次还选这家蛋糕。');
  await page.locator('.journal-widget').filter({ hasText: '我的修改草稿' }).getByRole('button', { name: '重新打开' }).click();
  await page.waitForTimeout(300); assert.equal(state().items[0].status, 'planned');
  await page.locator('[data-j-tab=all]').click();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No page overflow at ${width}`);
    await page.screenshot({ path: join(artifacts, `journal-${width}.png`), fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.journal-settings>summary').click();
  await page.locator('#journal-motion').selectOption('system'); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.PAMotion.reduced()), true);
  // Invalid late proposals preserve records and basic list operations.
  invalidDesign = true; delay = 200;
  await page.locator('#journal-auto').check();
  await page.waitForTimeout(4500);
  assert.equal(state().design.status, 'failed');
  assert.equal(state().items.length, 2);
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(join(artifacts, 'verification.json'), JSON.stringify({ passed: true, model: 'isolated delayed JSON substitute', realLayers: ['HTTP', 'SQLite', 'JournalDesigner', 'DOM', 'WAAPI'], analyzes, widths: [1280, 390, 320], noPageErrors: true, video: 'recorded by Playwright, no real personal data' }, null, 2));
  console.log(`Journal browser acceptance passed; artifacts: ${artifacts}`);
} finally {
  await context?.close(); await browser?.close(); await app?.shutdown(); await rm(root, { recursive: true, force: true });
}
