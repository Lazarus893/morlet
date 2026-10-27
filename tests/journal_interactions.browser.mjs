// Independent interaction regression. Temporary HTTP + real SQLite; no real
// model, WeChat transport, account mutation, external navigation or phone.
// PA_PLAYWRIGHT_MODULE=/path/to/playwright node tests/journal_interactions.browser.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWebUI } from '../plugins/webui/server.mjs';
import { JournalDesigner } from '../plugins/life-journal/designer.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pa-journal-interactions-'));
const artifacts = join(ROOT, '_temp/journal-interactions');
const local = { account: 'local', userId: 'owner' }, account = 'b'.repeat(64), foreign = { account, userId: 'fixture-user' };
const config = JSON.parse(await readFile(join(ROOT, 'config/pa.example.json'), 'utf8'));
config.owner = '交互验收用户'; config.agent.provider = 'codex'; config.proactive.enabled = false; config.im.allow_from = [foreign.userId];
const settings = { config, revision: 'interaction-fixture', installed: true, runtimeInstalled: true, pending: [], socket: '/never-use-real-runtime' };
let users = [{ id: foreign.userId, revision: 1, tasks: [{ id: 'historical-reminder', title: '历史生日提醒', status: 'submitted', version: 1, notifyAt: Date.now() - 1000 }], preferences: config.proactive }];
let app, browser, modelCalls = 0, focusOnly = false;
const results = [];
try {
  await mkdir(artifacts, { recursive: true });
  app = createWebUI({ root, helper: async request => { assert.equal(request.action, 'read'); return settings; }, rpc: async (_socket, request) => {
    assert.equal(request.command, 'pa'); assert.equal(request.operation, 'snapshot', 'fixture rejects all transport mutations');
    return { kind: 'pa', data: { protocol: 1, account, users, connected: true, configRevision: settings.revision } };
  }, journalRuntimeFactory: async ({ store, scopeAllowed }) => {
    const designer = new JournalDesigner({ root, store, scopeAllowed, analyze: async (_role, prompt, signal) => {
      modelCalls++; signal.throwIfAborted(); const data = JSON.parse(prompt), widgets = [];
      for (const item of data.items) {
        const kinds = item.status === 'done' ? ['memory'] : focusOnly ? ['focus'] : ['focus', ...(item.steps.length ? ['checklist'] : []), ...(item.date ? ['timeline'] : [])];
        for (const kind of kinds) widgets.push({ id: `${item.id}:${kind}`, itemId: item.id, kind, emphasis: widgets.length ? 'normal' : 'primary' });
      }
      return JSON.stringify({ widgets: widgets.slice(0, 12), reason: '隔离测试模型按已保存事项整理' });
    } });
    await designer.initialize();
    return { ready: true, request: (...args) => designer.request(...args), stop: () => designer.stop() };
  } });
  const store = app.journal.store;
  const add = (scope, title) => store.mutate(scope, { operation: 'add', revision: store.snapshot(scope).revision, values: { title, date: '2026-10-18T08:00:00Z', steps: [{ label: '准备贺卡', done: false }, { label: '取蛋糕', done: false }] } }).items.at(-1);
  const birthday = add(local, '妈妈生日准备'), trip = add(local, '周末出行'), remote = add(foreign, '微信用户自己的生日');
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/`;
  browser = await chromium.launch({ headless: true });
  const mutate = values => { const state = store.snapshot(local); return store.mutate(local, { operation: 'preferences', revision: state.revision, values }); };

  async function run(name, action) {
    mutate({ autoLayout: true, motion: 'system', hidden: [], pinned: [], order: [] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai', recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } } });
    await context.addInitScript(() => {
      window.__motionLog = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) { window.__motionLog.push({ id: this.id, frames, options }); return animate.call(this, frames, options); };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    let failure;
    try {
      await page.goto(url); await page.waitForLoadState('networkidle'); await page.locator('#nav-journal').click();
      await page.getByRole('heading', { name: '你的生活手账' }).waitFor(); await page.locator('.journal-widget').first().waitFor();
      await action(page); await page.waitForTimeout(80);
      assert.deepEqual(errors, [], 'No uncaught browser errors');
      results.push({ name, passed: true }); console.log(`PASS ${name}`);
    } catch (error) {
      failure = error.message; results.push({ name, passed: false, error: failure, pageErrors: errors }); console.error(`FAIL ${name}: ${failure}`);
      await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true }).catch(() => {});
    } finally { await context.close(); }
  }

  const card = (page, item, kind = 'focus') => page.locator(`.journal-widget[data-widget="${item.id}:${kind}"]`);
  const closeEditor = page => page.getByRole('button', { name: '关闭生活记录' }).click();
  const saved = page => page.waitForFunction(() => !document.querySelector('.journal-editor')?.open && !document.querySelector('#journal-status')?.textContent.includes('正在'));
  const openSettings = async page => { const summary = page.locator('.journal-settings > summary'); await summary.click(); await page.waitForFunction(() => document.querySelector('.journal-settings')?.open); };
  async function hold(page, pattern, condition = () => true) {
    const arrived = Promise.withResolvers(), release = Promise.withResolvers();
    await page.route(pattern, async route => {
      if (!condition(route.request())) return route.continue();
      arrived.resolve(); await release.promise; await route.continue().catch(() => {});
    });
    return { arrived: arrived.promise, release: () => release.resolve(), remove: () => page.unroute(pattern) };
  }

  await run('slow-save-disables-other-writes', async page => {
    await card(page, birthday).getByRole('button', { name: '查看与校对' }).click();
    await page.locator('#journal-note').fill('这份草稿等待真实保存确认');
    const gate = await hold(page, '**/api/journal', request => request.method() === 'POST');
    try {
      await page.locator('#journal-save').click(); await gate.arrived;
      assert.equal(await page.locator('#journal-save').isDisabled(), true);
      assert.equal(await page.locator('#journal-auto').isDisabled(), true);
      assert.equal(await page.locator('#journal-motion').isDisabled(), true);
      assert.equal(await page.locator('#journal-scope').isDisabled(), true);
      assert.equal(await page.locator('#journal-add').isDisabled(), true);
      assert.equal(await card(page, birthday).getByRole('button', { name: '确认结束' }).isDisabled(), true);
      assert.equal(store.snapshot(local).items.find(item => item.id === birthday.id).status, 'planned');
      assert.equal(await page.locator('#journal-editor-status').textContent(), '正在保存，请稍候。');
    } finally { gate.release(); }
    await saved(page); await gate.remove();
    assert.equal(await page.locator('#journal-add').isDisabled(), false);
  });

  await run('slow-scope-keeps-current-selection', async page => {
    const gate = await hold(page, '**/api/journal?*', request => new URL(request.url()).searchParams.get('account') === account);
    try {
      await page.locator('#journal-scope').selectOption(JSON.stringify([account, foreign.userId])); await gate.arrived;
      assert.equal(await page.locator('#journal-scope').inputValue(), JSON.stringify(['local', 'owner']));
      assert.equal(await page.locator('#journal-add').isDisabled(), true);
      assert.equal(await card(page, birthday).isVisible(), true);
      assert.equal(await card(page, remote).count(), 0);
      assert.equal(await page.locator('#journal-status').textContent(), '正在读取另一份手账，请稍候。');
    } finally { gate.release(); }
    await page.waitForFunction(() => document.querySelector('#journal-status')?.textContent === '已切换手账。'); await gate.remove();
    assert.equal(await page.locator('#journal-scope').inputValue(), JSON.stringify([account, foreign.userId]));
    assert.equal(await card(page, remote).isVisible(), true); assert.equal(await page.locator('#journal-add').isDisabled(), false);
  });

  await run('late-manual-design-after-navigation', async page => {
    const gate = await hold(page, '**/api/journal/design', request => request.method() === 'POST');
    try {
      assert.equal(await page.locator('#journal-redesign').isDisabled(), false);
      await page.locator('#journal-redesign').click(); await gate.arrived;
      await page.locator('[data-page="home"]').first().click();
      assert.equal(await page.locator('.journal').count(), 0);
    } finally { gate.release(); }
    await page.waitForTimeout(250); await gate.remove();
    assert.equal(await page.locator('.journal').count(), 0);
    await page.locator('#nav-journal').click(); await page.getByRole('heading', { name: '你的生活手账' }).waitFor();
  });

  await run('keyboard-reorder-retains-card-focus', async page => {
    const order = await page.locator('#journal-board .journal-widget').evaluateAll(nodes => nodes.map(node => node.dataset.widget));
    const widgetId = order[1], target = page.locator(`.journal-widget[data-widget="${widgetId}"]`);
    assert.ok(widgetId); order.splice(1, 1); order.unshift(widgetId);
    await target.locator('.journal-adjust > summary').click(); await page.waitForTimeout(300);
    const up = target.getByRole('button', { name: '上移', exact: true });
    await up.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#journal-status')?.textContent === '已保存。');
    assert.deepEqual(store.snapshot(local).preferences.order, order, 'Enter applies one upward move');
    const focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, card: document.activeElement.closest('.journal-widget')?.dataset.widget, disabled: !!document.activeElement.disabled, text: document.activeElement.textContent }));
    assert.equal(focus.card, widgetId, 'focus stays in the reordered card after Up becomes disabled');
    assert.equal(focus.disabled, false, 'focus is on an operable card control'); assert.ok(['BUTTON', 'SUMMARY', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(focus.tag), 'focus target is a keyboard control');
  });

  for (const preference of ['off', 'reduced']) await run(`dialog-active-${preference}-has-no-scale`, async page => {
    await openSettings(page); await page.locator('#journal-motion').selectOption(preference);
    await page.waitForFunction(value => document.documentElement.dataset.motion === value, preference);
    await page.locator('#journal-add').click(); await page.locator('#journal-title').fill('动画偏好验收');
    const button = page.locator('.journal-editor-close'); await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    try {
      const transform = await button.evaluate(node => getComputedStyle(node).transform);
      assert.ok(transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)', `dialog button must not scale in ${preference}: ${transform}`);
    } finally { await page.mouse.up(); }
  });

  await run('invalid-candidate-focus-and-aria', async page => {
    const revision = store.snapshot(local).revision;
    await page.locator('#journal-add').click(); await page.locator('#journal-title').fill('不安全候选的格式验收');
    await page.locator('#journal-candidates').fill('候选蛋糕 | 用户提供材料 | javascript:alert(1)'); await page.locator('#journal-save').click();
    assert.equal(await page.locator('#journal-candidates').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#journal-candidates').getAttribute('aria-describedby'), 'journal-editor-status');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'journal-candidates');
    assert.match(await page.locator('#journal-editor-status').textContent(), /http 或 https/); assert.equal(store.snapshot(local).revision, revision);
    await closeEditor(page);
  });

  await run('restore-buttons-identify-item-and-widget', async page => {
    const hide = async (item, kind) => { const target = card(page, item, kind); await target.locator('.journal-adjust > summary').click(); await page.waitForTimeout(300); await target.getByRole('button', { name: '隐藏', exact: true }).click(); await page.waitForFunction(id => !document.querySelector(`.journal-widget[data-widget="${id}"]`), `${item.id}:${kind}`); };
    await hide(birthday, 'checklist'); await hide(trip, 'focus'); await openSettings(page);
    const labels = await page.locator('#journal-hidden button').allTextContents();
    assert.ok(labels.some(label => label.includes('妈妈生日准备') && label.includes('准备清单')), labels.join(' | '));
    assert.ok(labels.some(label => label.includes('周末出行') && label.includes('下一件事')), labels.join(' | '));
    assert.equal(new Set(labels).size, labels.length);
    await page.getByRole('button', { name: '恢复 妈妈生日准备 · 准备清单', exact: true }).click();
    await card(page, birthday, 'checklist').waitFor(); assert.equal(store.snapshot(local).preferences.hidden.includes(`${trip.id}:focus`), true);
  });

  await run('new-reminder-announces-once-history-is-quiet', async page => {
    assert.equal(await page.locator('#journal-reminder-announcement').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('#journal-reminder-announcement').textContent(), '');
    assert.equal(await page.evaluate(() => window.__motionLog.filter(event => event.id === 'journal-notice').length), 0, 'first display of historical reminders is not replayed');
    await page.evaluate(() => {
      window.__announcementChanges = 0;
      new MutationObserver(records => { window.__announcementChanges += records.length; }).observe(document.querySelector('#journal-reminder-announcement'), { childList: true, subtree: true, characterData: true });
    });
    users = [{ ...users[0], revision: users[0].revision + 1, tasks: [...users[0].tasks, { id: 'new-reminder', title: '新的取蛋糕提醒', status: 'submitted', version: 1, notifyAt: Date.now() - 1000 }] }];
    await page.waitForFunction(() => document.querySelector('#journal-reminder-announcement')?.textContent.includes('新的取蛋糕提醒'), { timeout: 7000 });
    const changes = await page.evaluate(() => window.__announcementChanges);
    assert.ok(changes > 0); assert.equal(await page.evaluate(() => window.__motionLog.filter(event => event.id === 'journal-notice').length), 1);
    await page.waitForTimeout(5500); assert.equal(await page.evaluate(() => window.__announcementChanges), changes, 'normal polling does not announce the same event again');
    await page.reload(); await page.locator('#nav-journal').click(); await page.getByRole('heading', { name: '你的生活手账' }).waitFor();
    assert.equal(await page.locator('#journal-reminder-announcement').textContent(), '');
    assert.equal(await page.evaluate(() => window.__motionLog.filter(event => event.id === 'journal-notice').length), 0, 'reload does not animate previous reminders');
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(artifacts, 'reminder-polite.png'), fullPage: true });
  });

  await run('focus-only-design-keeps-all-item-actions-and-readonly-history', async page => {
    focusOnly = true;
    try {
      await page.locator('#journal-add').click();
      await page.locator('#journal-title').fill('只生成焦点组件的生日');
      await page.locator('#journal-steps').fill('确认生日人数\n准备生日贺卡');
      await page.locator('#journal-candidates').fill('生日候选 A | 家人提供的材料 A\n生日候选 B | 家人提供的材料 B');
      await page.locator('#journal-save').click(); await saved(page);
      const item = store.snapshot(local).items.find(item => item.title === '只生成焦点组件的生日');
      assert.ok(item);
      await page.waitForFunction(id => {
        const cards = [...document.querySelectorAll('#journal-board .journal-widget')].filter(node => node.dataset.widget.startsWith(`${id}:`));
        return document.querySelector('#journal-design strong')?.textContent === 'AI 已整理看板' && cards.length === 1 && cards[0].dataset.kind === 'focus';
      }, item.id);
      assert.deepEqual(store.snapshot(local).layout.widgets.filter(widget => widget.itemId === item.id).map(widget => widget.kind), ['focus']);
      const focus = card(page, item);
      assert.equal(await focus.locator('[data-j-step]').count(), 0, 'Recent board follows the model focus-only proposal');
      assert.equal(await focus.locator('[data-j-action=choose]').count(), 0);
      await page.locator('[data-j-tab=all]').click();
      const record = page.locator(`.journal-widget[data-widget="list-${item.id}"]`);
      assert.equal(await record.locator('[data-j-step]').count(), 2, 'Steps appear once on the full record');
      assert.equal(await record.locator('[data-j-candidate]').count(), 2, 'Candidates appear once on the full record');
      await record.locator('[data-j-step]').first().check();
      await page.waitForFunction(() => document.querySelector('#journal-status')?.textContent === '已保存。');
      assert.equal(store.snapshot(local).items.find(saved => saved.id === item.id).steps[0].done, true);
      await record.getByRole('button', { name: '标记选择', exact: true }).nth(1).click();
      await record.getByRole('button', { name: '已选定此项', exact: true }).waitFor();
      assert.equal(store.snapshot(local).items.find(saved => saved.id === item.id).candidates[1].selected, true);
      await record.getByRole('button', { name: '确认结束', exact: true }).click();
      await record.getByRole('button', { name: '重新打开', exact: true }).waitFor();
      assert.equal(store.snapshot(local).items.find(saved => saved.id === item.id).status, 'done');
      for (const tab of ['all', 'kept']) {
        await page.locator(`[data-j-tab=${tab}]`).click();
        assert.equal(await record.locator('[data-j-step]').count(), 2);
        assert.equal(await record.locator('[data-j-step]').first().isChecked(), true);
        assert.equal(await record.locator('[data-j-step]').first().isDisabled(), true);
        assert.equal(await record.getByText('家人提供的材料 B', { exact: true }).isVisible(), true);
        assert.equal(await record.getByRole('button', { name: '已选定此项', exact: true }).isDisabled(), true);
        assert.equal(await record.getByRole('button', { name: '标记选择', exact: true }).isDisabled(), true);
      }
      const revision = store.snapshot(local).revision;
      await record.locator('[data-j-action=choose]').first().evaluate(button => button.click());
      await page.waitForTimeout(100);
      assert.equal(store.snapshot(local).revision, revision, 'Disabled history actions cannot mutate the ledger');
      await page.screenshot({ path: join(artifacts, 'focus-only-birthday-readonly.png'), fullPage: true });
    } finally { focusOnly = false; }
  });

  await writeFile(join(artifacts, 'verification.json'), JSON.stringify({ passed: results.every(result => result.passed), cases: results, modelCalls, fixture: 'temporary root; real HTTP and SQLite; substituted JSON model and read-only channel; no real external actions' }, null, 2));
  assert.ok(results.every(result => result.passed), `${results.filter(result => !result.passed).length} interaction cases failed; see ${artifacts}`);
  console.log(`Journal interaction regression passed (${results.length} cases); ${artifacts}`);
} finally { await browser?.close(); await app?.shutdown(); await rm(root, { recursive: true, force: true }); }
