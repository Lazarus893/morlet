// Normal-motion recording against an isolated HTTP/SQLite instance. Never writes to the live app.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWebUI } from '../plugins/webui/server.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const artifacts = resolve(process.env.PA_MOTION_ARTIFACTS || join(ROOT, '.runtime/verification/journal-motion'));
const root = await mkdtemp(join(tmpdir(), 'xiaoman-motion-'));
const scope = { account: 'local', userId: 'owner' };
const config = JSON.parse(await readFile(join(ROOT, 'config/pa.example.json'), 'utf8')); config.proactive.enabled = false;
const settings = { config, revision: 'motion-test', installed: true, runtimeInstalled: true, pending: [], socket: '/no-real-runtime' };
let app, browser;
const errors = [], traces = [], writes = [];
try {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  if (process.env.PA_MOTION_SOURCE_DB) {
    await mkdir(join(root, '.runtime'), { recursive: true });
    await copyFile(process.env.PA_MOTION_SOURCE_DB, join(root, '.runtime/life-journal.sqlite'));
  }
  app = createWebUI({ root, helper: async req => { assert.equal(req.action, 'read'); return settings; }, rpc: async (_socket, req) => { assert.equal(req.operation, 'snapshot'); return { kind: 'pa', data: { protocol: 1, account: null, users: [], connected: false, configRevision: settings.revision } }; }, journalRuntimeFactory: async () => { throw new Error('Motion test must not dispatch a model'); } });
  const store = app.journal.store;
  if (!store.snapshot(scope).items.length) store.mutate(scope, { operation: 'add', revision: 0, values: { title: '下一篇笔记', note: '隔离浏览器测试' } });
  const guide = store.mutate(scope, { operation: 'add', revision: store.snapshot(scope).revision, values: {
    title: '交互稳定性验收', taskType: 'prep', steps: [{ id: 'first-touch', label: '核对一项准备', done: false }, { id: 'second-step', label: '核对另一项准备', done: false }],
    candidates: [{ id: 'reading', name: '整理值得读的信息', detail: '整理来源', selected: false }, { id: 'plan', name: '推进一件挂心的事', detail: '确定下一步', selected: false }],
    taskData: { prep: { phases: [{ id: 'prepare', label: '准备', stepIds: ['first-touch'] }] }, decision: {} },
  } }).items.at(-1);
  store.mutate(scope, { operation: 'preferences', revision: store.snapshot(scope).revision, values: { pinned: [`${guide.id}:prep`, `${guide.id}:decision`] } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  browser = await chromium.launch({ headless: true, channel: process.env.PA_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Shanghai', reducedMotion: 'no-preference', recordVideo: { dir: artifacts, size: { width: 1440, height: 1100 } } });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|flushSync|React error/i.test(message.text())) errors.push(message.text()); });
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/journal') writes.push(req.postDataJSON()); });
  await page.addInitScript(() => {
    window.motionAnimations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      window.motionAnimations.push({ time: performance.now(), target: this.id || this.className, connected: this.isConnected, frames, options });
      return animate.call(this, frames, options);
    };
    window.startMotionTrace = name => {
      const trace = { name, started: performance.now(), frames: [] }; window.motionTrace = trace;
      const sample = () => {
        if (window.motionTrace !== trace) return;
        const rect = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const reading = document.querySelector('.journal-workpage:not([hidden]) .jui-reading-content');
        trace.frames.push({ t: performance.now() - trace.started, scroll: scrollY, checkbox: rect('.journal-workpage:not([hidden]) [data-w-checkbox=step]'), choices: rect('.journal-workpage:not([hidden]) .jw-comparison'), reading: rect('.journal-workpage:not([hidden]) .jui-reading-content'), readingOpacity: reading ? Number(getComputedStyle(reading).opacity) : null, status: rect('#journal-status'), disabledBookmarks: document.querySelectorAll('.journal-bookmark:disabled,.journal-edge-bookmark:disabled').length, animations: document.getAnimations().filter(a => a.playState === 'running').map(a => a.effect?.target?.className) });
        requestAnimationFrame(sample);
      }; sample();
    };
  });
  // Make the saving state observable on fast machines without changing production code.
  await page.route('**/api/journal', async route => { if (route.request().method() === 'POST') await new Promise(resolve => setTimeout(resolve, 450)); await route.continue(); });
  await page.goto(`http://127.0.0.1:${app.server.address().port}/#journal`);
  await page.locator('#journal-bookmarks button[data-item="' + guide.id + '"]').click();
  const initialPage = page.locator('.journal-workpage[data-item="' + guide.id + '"]');
  if (await initialPage.getAttribute('data-expanded') !== 'true') await initialPage.locator('[data-j-action=work-toggle]').click();
  for (const panel of await initialPage.locator('.journal-work-panel').all()) if (!await panel.evaluate(el => el.open)) await panel.locator(':scope > summary').click();
  await page.waitForFunction(() => document.querySelector('.journal')?.getAttribute('aria-busy') !== 'true');
  const guidePage = page.locator(`.journal-workpage[data-item="${guide.id}"]`);
  async function record(name, locator, action = () => locator.click(), duration = 1300) {
    if (locator) await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.evaluate(name => window.startMotionTrace(name), name);
    await action(); await page.waitForTimeout(duration);
    traces.push(await page.evaluate(() => { const result = window.motionTrace; window.motionTrace = null; result.animations = window.motionAnimations.filter(a => a.time >= result.started); return result; }));
    await page.screenshot({ path: join(artifacts, `${name}.png`) });
  }
  await record('01-checklist', guidePage.locator('[data-w-checkbox=step]').first());
  await record('02-choice', guidePage.getByRole('button', { name: '选择：推进一件挂心的事', exact: true }));
  await record('03-change-choice', guidePage.getByRole('button', { name: '选择：整理值得读的信息', exact: true }));
  await record('04-poll', null, async () => {}, 4600);
  await record('05-current-bookmark', page.locator('#journal-bookmarks [aria-current]'));
  const automatic = store.snapshot(scope).items.find(item => item.source.kind === 'automatic');
  const other = automatic ? page.locator(`#journal-bookmarks [data-item="${automatic.id}"]`) : page.locator('#journal-bookmarks button:not([aria-current])').first();
  await record('06-other-bookmark', other);
  const disclosure = page.locator('.journal-workpage:not([hidden]) summary').first();
  if (await disclosure.count()) {
    await record('07-expand', disclosure);
    const readingTrigger = page.locator('.journal-workpage:not([hidden]) .jui-reading-details button[aria-expanded]').first();
    if (await readingTrigger.count()) {
      await record('07a-reading-open', readingTrigger);
      await record('07b-reading-close', readingTrigger);
      await record('07c-interrupt-reading', readingTrigger, async () => { await readingTrigger.click(); await page.waitForTimeout(55); await readingTrigger.click(); await page.waitForTimeout(55); await readingTrigger.click(); });
      assert.equal(await readingTrigger.getAttribute('aria-expanded'), 'true');
      await record('07d-reading-poll', null, async () => {}, 4300);
      assert.equal(await readingTrigger.getAttribute('aria-expanded'), 'true', 'polling keeps the library disclosure open');
    }
    await record('08-collapse', disclosure);
  }
  await page.locator(`#journal-bookmarks button[data-item="${guide.id}"]`).click();
  const choice = guidePage.getByRole('button', { name: '选择：推进一件挂心的事', exact: true });
  await choice.scrollIntoViewIfNeeded();
  await choice.focus();
  const count = writes.length;
  const bounds = await choice.boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.waitForFunction(() => document.querySelector('.journal[aria-busy=true]'));
  const focus = await choice.evaluate(el => ({ retained: el === document.activeElement || el.getRootNode().activeElement === el, activeTag: document.activeElement?.tagName, activeAction: document.activeElement?.dataset.jAction, buttonTag: el.tagName }));
  assert.equal(focus.retained, true, `save keeps button focus: ${JSON.stringify(focus)}`);
  // Real rapid clicks bypass Playwright's aria-disabled actionability wait.
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.keyboard.press('Enter');
  await other.click();
  assert.equal(await page.locator('#journal-bookmarks [aria-current]').getAttribute('data-item') === guide.id, false, 'reading navigation works during a write');
  await page.waitForFunction(() => document.querySelector('.journal[aria-busy=false]'));
  assert.equal(writes.length - count, 1, 'rapid mouse and keyboard activation sends one mutation');
  assert.equal(store.snapshot(scope).items.find(i => i.id === guide.id).candidates.find(c => c.id === 'plan').selected, true);
  assert.equal(await page.locator('#journal-bookmarks [aria-current]').getAttribute('data-item') === guide.id, false, 'save response does not steal the selected chapter');
  await page.locator(`#journal-bookmarks button[data-item="${guide.id}"]`).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await record('09-mobile-checklist', guidePage.locator('[data-w-checkbox=step]').first());
  await record('10-mobile-choice', guidePage.getByRole('button', { name: '选择：整理值得读的信息', exact: true }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const beforeFailure = store.snapshot(scope).items.find(i => i.id === guide.id).steps[0].done;
  await page.route('**/api/journal', async route => { if (route.request().method() === 'POST') await route.abort('failed'); else await route.continue(); });
  await guidePage.locator('[data-w-checkbox=step]').first().click();
  await page.waitForFunction(() => document.querySelector('#journal-status')?.dataset.error === 'true');
  await page.waitForFunction(() => document.querySelector('.journal[aria-busy=false]'));
  assert.equal(await guidePage.locator('[data-w-checkbox=step]').first().isChecked(), beforeFailure, 'failed save restores the previous checkbox');
  assert.equal(store.snapshot(scope).items.find(i => i.id === guide.id).steps[0].done, beforeFailure);
  await page.unroute('**/api/journal');
  await guidePage.locator('[data-w-checkbox=step]').first().focus(); await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('.journal[aria-busy=false]'));
  assert.equal(store.snapshot(scope).items.find(i => i.id === guide.id).steps[0].done, !beforeFailure, 'keyboard retry persists');
  const indexToggle = page.locator('#journal-index-toggle');
  await record('13-mobile-directory-open', indexToggle);
  assert.equal(await indexToggle.getAttribute('aria-expanded'), 'true');
  await record('14-mobile-directory-close', indexToggle);
  assert.equal(await page.locator('.journal-book').getAttribute('data-index-open'), 'false');
  if (automatic) {
    await indexToggle.click();
    await page.locator(`#journal-bookmarks [data-item="${automatic.id}"]`).click();
    const outer = page.locator('.journal-workpage:not([hidden]) .journal-work-panel');
    if (await outer.count() && !await outer.evaluate(el => el.open)) await outer.locator('summary').click();
    const trigger = page.locator('.journal-workpage:not([hidden]) .jui-reading-details button[aria-expanded]').first();
    if (await trigger.getAttribute('aria-expanded') === 'true') { await trigger.click(); await page.waitForTimeout(300); }
    await record('15-mobile-long-reading', trigger);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  }
  await record('16-editor-open', page.locator('.journal-mobile-add'));
  await record('17-editor-close', page.getByRole('button', { name: '关闭生活记录', exact: true }));
  assert.equal(await page.locator('.journal-editor').evaluate(el => el.open), false);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await record('18-tabs', page.locator('[data-j-tab="recent"]'));
  assert.equal(await page.locator('[data-j-tab="recent"]').getAttribute('aria-selected'), 'true');
  await page.locator('[data-j-tab="recent"]').focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.dataset.jTab === 'all');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-j-tab="all"]').getAttribute('aria-selected'), 'true');
  if (automatic) await page.locator(`#journal-bookmarks [data-item="${automatic.id}"]`).click(); else await other.click();
  for (const panel of await page.locator('.journal-workpage:not([hidden]) .journal-work-panel').all()) if (!await panel.evaluate(el => el.open)) await panel.locator(':scope > summary').click();
  const readingToggle = page.locator('.journal-workpage:not([hidden]) .jui-reading-details button[aria-expanded]').first();
  if (automatic && await readingToggle.count()) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (await readingToggle.getAttribute('aria-expanded') === 'true') { await readingToggle.click(); await page.waitForTimeout(150); }
    await record('11-reduced-disclosure', readingToggle);
    await page.locator('.journal-settings>summary').filter({ hasText: '手账设置' }).click();
    await page.locator('#journal-motion').selectOption('off');
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'off');
    await record('12-off-disclosure', readingToggle, async () => { await readingToggle.click(); await readingToggle.click(); });
  }
  await writeFile(join(artifacts, 'trace.json'), JSON.stringify({ errors, traces }, null, 2), { mode: 0o600 });
  const metrics = traces.map(trace => {
    const positions = trace.frames.map(f => f.checkbox?.y).filter(v => v != null);
    return { action: trace.name, checkboxTravel: positions.length ? Math.max(...positions) - Math.min(...positions) : null, maxDisabledBookmarks: Math.max(...trace.frames.map(f => f.disabledBookmarks)), animationCalls: trace.animations.length, animatedTargets: [...new Set(trace.animations.map(a => a.target))] };
  });
  console.log(JSON.stringify(metrics, null, 2));
  await writeFile(join(artifacts, 'metrics.json'), JSON.stringify(metrics, null, 2));
  await context.close();
  await (await page.video()).saveAs(join(artifacts, 'interaction.webm'));
  assert.deepEqual(errors, []);
  for (const metric of metrics.filter(m => /checklist|choice|poll/.test(m.action))) {
    assert.ok(metric.checkboxTravel <= 1, `${metric.action}: no content jump (${metric.checkboxTravel}px)`);
    assert.equal(metric.maxDisabledBookmarks, 0, `${metric.action}: bookmarks do not flash disabled`);
    assert.equal(traces.find(t => t.name === metric.action).animations.filter(a => a.connected && !String(a.target).includes('jui-journal-status')).length, 0, `${metric.action}: saving/polling does not replay widget animation`);
  }
  for (const name of ['07a-reading-open', '07b-reading-close']) {
    const trace = traces.find(t => t.name === name); if (!trace) continue;
    const heights = trace.frames.map(f => f.reading?.height || 0), max = Math.max(...heights);
    assert.ok(heights.some(height => height > 1 && height < max - 1), `${name}: library renders intermediate frames in both directions`);
  }
  const longReading = traces.find(t => t.name === '15-mobile-long-reading');
  if (longReading) {
    assert.ok(longReading.frames.some(f => f.readingOpacity > 0 && f.readingOpacity < 1), 'long mobile content retains a visible fade');
    assert.ok(new Set(longReading.frames.filter(f => f.reading?.height > 1).map(f => Math.round(f.reading.height))).size <= 2, 'long mobile content does not stretch thousands of pixels');
  }
  assert.ok(traces.find(t => t.name === '11-reduced-disclosure')?.animations.every(a => a.options.duration <= 100) ?? true);
  assert.equal(traces.find(t => t.name === '12-off-disclosure')?.animations.filter(a => a.options.duration > 0).length || 0, 0);
  console.log('PASS: stable normal-motion desktop/mobile clicks, quiet polling, duplicate-write guard, keyboard retry, navigation during save, failed-save rollback, reduced/off motion.');
} finally { await browser?.close(); await app?.shutdown(); await rm(root, { recursive: true, force: true }); }
