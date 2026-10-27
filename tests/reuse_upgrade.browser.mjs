// Isolated HTTP + SQLite + actual upstream OpenUI renderer. No model or account.
// PA_PLAYWRIGHT_MODULE=/path/to/playwright node tests/reuse_upgrade.browser.mjs
// PA_REUSE_PREVIEW_PORT=3089 starts the same fixture for visual inspection.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWebUI } from '../plugins/webui/server.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url)), root = await mkdtemp(join(tmpdir(), 'xiaoman-openui-'));
const artifacts = join(ROOT, '.runtime/verification/notebook-20261022/openui');
const config = JSON.parse(await readFile(join(ROOT, 'config/pa.example.json'), 'utf8'));
config.proactive.enabled = false;
const settings = { config, revision: 'reuse-fixture', installed: true, runtimeInstalled: true, pending: [], socket: '/no-real-runtime' };
const scope = { account: 'local', userId: 'owner' };
let app, browser;
try {
  await mkdir(artifacts, { recursive: true });
  app = createWebUI({ root, helper: async request => { assert.equal(request.action, 'read'); return settings; }, rpc: async (_socket, request) => { assert.equal(request.operation, 'snapshot'); return { kind: 'pa', data: { protocol: 1, account: null, users: [], connected: false, configRevision: settings.revision } }; }, journalRuntimeFactory: async () => ({ ready: false, request: async () => ({ accepted: false }), stop() {} }) });
  const store = app.journal.store, state = () => store.snapshot(scope);
  const item = store.mutate(scope, { operation: 'add', revision: 0, values: { title: '周末一起做番茄意面', taskType: 'meal', note: '隔离验收示例：试算人数后再采纳，不代表真实备餐或库存。', steps: [{ id: 'wash', label: '洗好番茄和菠菜', done: false }], taskData: { meal: { baseServings: 6, servings: 6, ingredients: [{ id: 'pasta', name: '意面', quantity: 600, unit: '克' }, { id: 'spinach', name: '菠菜', quantity: 300, unit: '克' }], instructions: [{ id: 'boil', label: '煮面并准备配菜', durationMinutes: 15 }] }, shopping: { entries: [{ id: 'pasta', name: '意面', quantity: 600, unit: '克' }, { id: 'spinach', name: '菠菜', quantity: 300, unit: '克' }] } } } }).items[0];
  const program = 'item = Query("current_item", {}, {})\n$servings = 6\nroot = Panel("这一餐，按人数来准备", [Text("先调整人数，看看食材如何变化。确认影响后再更新正式计划。"), Row([Metric("正式计划", item.taskData.meal.servings, "人"), NumberInput("servings", "拟调整人数", $servings), Metric("每人意面", item.taskData.meal.ingredients[0].quantity / item.taskData.meal.baseServings, "克")]), Button("查看人数调整影响", @PreviewPlan($servings))])';
  const design = store.mutate(scope, { operation: 'design-start', revision: state().revision, values: {} }).design;
  store.mutate(scope, { operation: 'design-result', revision: state().revision, values: { token: design.token, baseRevision: design.baseRevision, layoutVersion: design.layoutVersion, reason: '先算人数，再沿用食谱和采购记录。', widgets: ['meal', 'shopping'].map((kind, index) => ({ id: `${item.id}:${kind}`, itemId: item.id, kind, emphasis: index ? 'normal' : 'primary' })), surfaces: [{ itemId: item.id, program }] } });
  store.mutate(scope, { operation: 'preferences', revision: state().revision, values: { autoLayout: false } });
  app.server.listen(Number(process.env.PA_REUSE_PREVIEW_PORT) || 0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/#journal`;
  if (process.env.PA_REUSE_PREVIEW_PORT) {
    console.log(JSON.stringify({ url, fixture: true }));
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  } else {
    const require = createRequire(import.meta.url), { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, ...(process.env.PA_BROWSER_CHANNEL ? { channel: process.env.PA_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url);
    await page.locator('.journal-workpage:not([hidden])').waitFor();
    const field = () => page.getByRole('spinbutton', { name: '拟调整人数', exact: true });
    await field().waitFor();
    await page.waitForFunction(() => document.querySelector('.jui-metric .openui-metric-indicator__main-value')?.textContent === '6 人');
    await page.waitForFunction(() => !document.querySelector('[data-work-field=servings]'));
    assert.equal(await page.locator('.journal-surface .openui-card .openui-input').count(), 1, 'Official components provide the only servings control');
    assert.equal(await page.locator('.journal-surface .openui-button-base-primary').count(), 1);
    assert.deepEqual(await page.locator('.jui-panel').evaluate(node => { const style = getComputedStyle(node); return [style.display, style.gap, style.borderRadius]; }), ['flex', '24px', '16px'], 'Official CSS and static theme tokens load under the existing CSP');
    await page.locator('.brand').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, 'openui-official-desktop.png'), fullPage: true, animations: 'disabled' });
    const before = state();
    await field().fill('4');
    await page.waitForTimeout(4300);
    assert.equal(await field().inputValue(), '4');
    assert.equal(await field().evaluate(node => node === document.activeElement), true, 'Polling preserves input focus');
    assert.equal(state().revision, before.revision, 'OpenUI local state is not a ledger write');
    await page.reload(); await field().waitFor();
    assert.equal(await field().inputValue(), '4', 'Reactive state survives reload');
    await page.getByRole('button', { name: '查看人数调整影响', exact: true }).click();
    await page.locator('.journal-trial-result').waitFor();
    assert.equal(state().revision, before.revision, 'Preview remains read-only');
    assert.match(await page.locator('.journal-trial-result').innerText(), /400/);
    const surfaceBox = await page.locator('.journal-surface').boundingBox(), previewBox = await page.locator('.journal-trial-result').boundingBox();
    assert.ok(previewBox.y >= surfaceBox.y + surfaceBox.height, 'Preview follows the initiating surface');
    await page.locator('.brand').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, 'openui-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '采用这次调整', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#journal-status')?.textContent === '已采用这次调整。');
    assert.equal(state().items[0].taskData.meal.servings, 4);
    assert.equal(state().layout.surfaces[0].program, program, 'Adoption changes data, not the saved program');
    await page.waitForFunction(() => document.querySelector('.jui-metric .openui-metric-indicator__main-value')?.textContent === '4 人');
    assert.equal(await field().inputValue(), '4');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No mobile page overflow');
    const body = await page.locator('.journal-work-body').boundingBox(), footer = await page.locator('.journal-work-footer').boundingBox();
    assert.ok(body.y + body.height <= footer.y + 1, 'Ledger cards cannot overlap the work-page footer');
    await page.locator('.brand').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, 'openui-mobile.png'), fullPage: true, animations: 'disabled' });
    // A view without a preview action must leave the host controls available.
    const replaceSurface = nextProgram => {
      store.mutate(scope, { operation: 'preferences', revision: state().revision, values: { autoLayout: true } });
      const nextDesign = store.mutate(scope, { operation: 'design-start', revision: state().revision, values: {} }).design;
      store.mutate(scope, { operation: 'design-result', revision: state().revision, values: { token: nextDesign.token, baseRevision: nextDesign.baseRevision, layoutVersion: nextDesign.layoutVersion, widgets: state().layout.widgets, surfaces: [{ itemId: item.id, program: nextProgram }] } });
      store.mutate(scope, { operation: 'preferences', revision: state().revision, values: { autoLayout: false } });
    };
    replaceSurface('$servings = 4\nroot = Panel("本地试算", [NumberInput("servings", "试算人数", $servings), Button("恢复试算", @Reset($servings))])');
    await page.reload(); await page.locator('.jui-panel').waitFor();
    await page.locator('.journal-work-trial > summary').click();
    assert.equal(await page.locator('[data-work-field=servings]').isVisible(), true, 'Local-only actions cannot remove host preview controls');
    // The same rule holds for an input whose value is not sent by PreviewPlan.
    replaceSurface('$budget = 100\nroot = Panel("只查看", [NumberInput("budgetTotal", "试算预算", $budget), Button("固定四人试算", @PreviewPlan(4))])');
    await page.reload(); await page.locator('.jui-panel').waitFor();
    assert.equal(await page.locator('[data-work-field=servings]').count(), 1, 'Only fields covered by the rendered preview action are replaced');
    assert.deepEqual(errors, []);
    assert.ok(requests.every(request => request.startsWith(new URL(url).origin)), 'No CDN, telemetry or external model request');
    const report = { checks: ['official React UI components and CSS', 'single servings control', 'preview follows controls', 'local-only action keeps host preview', 'uncovered fields remain available', 'no CSP or console errors', 'actual OpenUI reactive rendering', 'polling focus', 'reload persistence', 'read-only preview', '400g scaling', 'existing confirmed adoption', 'same program after data update', '390px responsive', 'no external requests'], errors };
    await writeFile(join(artifacts, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
} finally { await browser?.close(); await app?.shutdown(); await rm(root, { recursive: true, force: true }); }
