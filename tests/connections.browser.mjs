// Isolated HTTP/browser acceptance: fixture accounts only; no cloud login, files or phone access.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PA_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = process.env.PA_CONNECTION_ARTIFACTS || join(root, '_temp/connections-acceptance'); await mkdir(artifacts, { recursive: true });
const cfg = JSON.parse(await readFile(join(root, 'config/pa.example.json')));
const ids = ['google', 'files', 'phone', 'github', 'x'];
const initial = () => ({ revision: 1, stateVersion: 1, checkedAt: Date.now(), monitor: { running: true, intervalMs: 15000, staleAfterMs: 90000 }, bridge: { paired: true, online: true, name: '验收 Mac', lastSeenAt: Date.now() }, items: ids.map(id => ({ id, title: id, state: 'unlinked', message: '等待你允许连接。', checkedAt: Date.now(), scopeDescription: '验收范围', permissions: [{ id: 'read', label: '读取与检查', granted: false, verified: false }] })), events: [] });
let snapshot = initial(), conflict = false, hold, calls = [], errors = [], failures = [], results = [];
const state = { csrf: 'fixture-only', config: cfg, revision: 'fixture', installed: true, pending: [], capabilities: [], runtime: { state: 'running', connected: true, owned: false, accounts: [], configurationMatched: true, provider: cfg.agent.provider, configRevision: 'fixture' } };
const allowed = new Set(['index.html', 'style.css', 'journal.css', 'journal.js', 'journal-webawesome.css', 'journal-webawesome.js', 'journal-widgets.css', 'journal-widgets.js', 'journal-surfaces.css', 'journal-surfaces.js', 'journal-notebook.css', 'connections.css', 'connections.js', 'remote.css', 'remote.js', 'motion.js', 'chat.css', 'truth.js', 'chat.js', 'onboarding.css', 'onboarding.js', 'first-task.css', 'first-task.js', 'transport.js', 'app.js']);
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://fixture.local').pathname;
  try {
    if (path === '/api/state') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, data: state })); }
    if (path === '/api/connections') {
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk; const command = JSON.parse(raw); calls.push(command);
        if (hold) await hold;
        if (conflict) { conflict = false; snapshot.revision++; return res.end(JSON.stringify({ ok: false, error: 'REVISION_CONFLICT' })); }
        assert.equal(command.revision, snapshot.revision); const item = snapshot.items.find(item => item.id === command.id); assert.ok(item);
        if (command.operation === 'connect' && ['google', 'github', 'x'].includes(command.id)) { item.state = 'awaiting_authorization'; item.auth = { verificationUrl: command.id === 'google' ? 'https://accounts.google.com/' : command.id === 'github' ? 'https://github.com/login/device' : 'https://x.com/i/oauth2/authorize?client_id=fixture', ...(command.id === 'x' ? {} : { code: 'FIXTURE-ONLY' }), expiresAt: Date.now() + 100000 }; }
        else if (command.operation === 'grant' && command.id === 'files') { item.state = 'awaiting_authorization'; delete item.auth; }
        else if (command.operation !== 'settings') { item.state = command.operation === 'disconnect' ? 'revoked' : 'connected'; delete item.auth; }
        item.message = item.state === 'connected' ? '连接检查已通过。' : item.state === 'revoked' ? '已撤回小满授权。' : '等待你完成官方授权。';
        item.permissions[0].granted = item.state !== 'revoked'; item.permissions[0].verified = item.state === 'connected'; item.checkedAt = Date.now(); snapshot.revision++; snapshot.stateVersion++;
        snapshot.events.unshift({ id: 'fixture-event', connectionId: item.id, kind: item.state, at: Date.now() });
      }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, data: snapshot }));
    }
    const asset = path === '/' ? 'index.html' : path.slice(1); if (!allowed.has(asset)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(await readFile(join(root, 'plugins/webui/public', asset)));
  } catch (error) { errors.push(error.message); res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'UNAVAILABLE' })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true, ...(process.env.PA_BROWSER_CHANNEL ? { channel: process.env.PA_BROWSER_CHANNEL } : {}) });
async function refresh(page) {
  const help = page.locator('#c-bridge-help');
  const opened = await help.evaluate(node => node.open);
  if (!opened) await help.locator(':scope > summary').click();
  await page.locator('#c-refresh').click();
  if (!opened) await help.locator(':scope > summary').click();
}
async function run(name, action, options = {}) {
  snapshot = initial(); calls = []; hold = undefined; conflict = false;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  context.setDefaultTimeout(10000);
  const page = await context.newPage(), pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { window.__animations = []; const animate = Element.prototype.animate; Element.prototype.animate = function(...args) { window.__animations.push({ id: this.id, frames: args[0] }); return animate.apply(this, args); }; });
  try {
    await page.goto(url + '/#connections'); await page.locator('#c-card-x').waitFor();
    await action(page); assert.deepEqual(pageErrors, []); results.push({ name, passed: true }); console.log('PASS', name);
  } catch (error) { failures.push(name); results.push({ name, passed: false, error: error.message }); console.error('FAIL', name, error.message); await page.screenshot({ path: join(artifacts, name + '.png'), fullPage: true }); }
  finally { hold = undefined; await context.close(); }
}
try {
  await run('five-entries-and-existing-settings', async page => {
    assert.equal(await page.locator('.c-card').count(), 5);
    assert.equal(await page.locator('#agent-form').count(), 1); assert.equal(await page.locator('#device-form').count(), 1); assert.equal(await page.getByRole('heading', { name: '微信', exact: true, includeHidden: true }).count(), 1);
    assert.equal(await page.locator('#c-monitor').isVisible(), false);
    assert.equal(await page.locator('#c-bridge-state').textContent(), 'Mac 在线');
    assert.match(await page.locator('#c-bridge-help').textContent(), /15.*90/);
    await page.screenshot({ path: join(artifacts, 'connections-desktop.png'), fullPage: true });
  });
  await run('missing-mac-never-fakes-connection', async page => {
    snapshot.bridge = { paired: false, online: false }; await refresh(page); await page.waitForFunction(() => document.querySelector('#c-bridge-state').textContent === 'Mac 尚未配对');
    assert.equal(await page.locator('[id^="c-connect-"]').count(), 0);
    await page.locator('#c-bridge-recover').click(); assert.equal(await page.locator('#c-bridge-help').getAttribute('open'), ''); assert.equal(calls.length, 0);
    snapshot.bridge = { paired: true, online: true, name: '验收 Mac', lastSeenAt: Date.now() }; await refresh(page); await page.waitForFunction(() => document.querySelector('#c-bridge-state').textContent === 'Mac 在线');
    assert.equal(await page.locator('#c-connect-phone').getAttribute('data-c-action'), 'open');
  });
  await run('partial-access-distinguishes-success-from-unverified-capabilities', async page => {
    for (const id of ['files', 'github', 'x']) {
      const row = snapshot.items.find(row => row.id === id);
      row.state = 'limited'; row.message = '部分权限可用，请完成剩余授权';
      row.permissions = [{ id: id === 'files' ? 'readable' : 'profile', label: '基础能力', granted: true, verified: true }, { id: 'remaining', label: '其他能力', granted: false, verified: false }];
    }
    await refresh(page);
    await page.waitForFunction(() => document.querySelector('#c-card-files .c-state').textContent === '基础读取可用');
    assert.equal(await page.locator('#c-card-github .c-state').textContent(), '账号已验证');
    assert.equal(await page.locator('#c-card-x .c-state').textContent(), '账号已验证');
    assert.match(await page.locator('#c-card-github .c-message').textContent(), /部分权限可用/);
    assert.equal(await page.locator('#c-connect-files').isVisible(), false);
    await page.locator('#c-manage-files').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#c-connect-files').textContent(), '调整访问范围');
    assert.match(await page.locator('#c-card-files .c-permissions').textContent(), /尚未验证/);
    snapshot.items.find(row => row.id === 'files').checkedAt++;
    await page.evaluate(() => window.PAConnections.refresh());
    assert.equal(await page.locator('#c-card-files .c-permissions').evaluate(node => node.open), true);
    assert.equal(calls.length, 0);
    await page.screenshot({ path: join(artifacts, 'connections-partial-access.png'), fullPage: true });
  });
  await run('google-oauth-auto-completion-and-disconnect', async page => {
    await page.locator('#c-connect-google').click(); await page.locator('#c-google-email').fill('fixture@example.invalid'); await page.getByRole('button', { name: '开始 Google 授权', exact: true }).click();
    await page.locator('#c-dialog .c-code').waitFor(); assert.equal(calls[0].values.account, 'fixture@example.invalid'); assert.equal(snapshot.items[0].state, 'awaiting_authorization');
    assert.equal(await page.locator('#c-dialog .c-auth-link').getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.getByRole('button', { name: '我已授权，重新检查' }).count(), 0);
    snapshot.items[0].state = 'connected'; delete snapshot.items[0].auth; snapshot.items[0].permissions[0].verified = true;
    await page.waitForFunction(() => document.querySelector('#c-dialog .c-flow-state').textContent === 'Google 套件已连接。', null, { timeout: 5000 });
    assert.equal(calls.length, 1); await page.locator('#c-dialog').getByRole('button', { name: '完成', exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'c-manage-google');
    await page.locator('#c-manage-google').click(); await page.locator('#c-withdraw-google').click();
    assert.match(await page.locator('#c-dialog').textContent(), /停止小满访问，保留本机登录/);
    await page.locator('#c-dialog').getByRole('button', { name: '撤回授权', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#c-card-google').dataset.cState === 'revoked'); assert.equal(snapshot.items[0].state, 'revoked');
  });
  await run('native-common-folders-and-custom-scope-binding', async page => {
    assert.equal(await page.locator('#c-connect-files').textContent(), '连接');
    await page.locator('#c-connect-files').click(); assert.equal(await page.locator('#c-files-consent').count(), 0);
    assert.match(await page.locator('#c-dialog-body').textContent(), /下载目录.*用户目录.*文档目录/s);
    assert.match(await page.locator('#c-dialog-body').textContent(), /只读访问/);
    const commonForm = page.locator('[data-c-form="files"][data-c-scope="common-folders"]');
    await commonForm.evaluate(form => { form.dataset.cForm = 'phone'; form.requestSubmit(); }); assert.equal(calls.length, 0);
    await page.locator('[data-c-form="phone"]').evaluate(form => { form.dataset.cForm = 'files'; }); await page.getByRole('button', { name: '授权这些目录' }).click();
    await page.waitForFunction(() => document.querySelector('#c-dialog .c-flow-state')?.textContent.includes('系统弹窗确认常用目录'));
    assert.deepEqual(calls[0].values, { scope: 'common-folders' }); assert.equal(calls[0].id, 'files');
    assert.equal(snapshot.items[1].permissions[0].verified, false);
    snapshot.items[1].state = 'connected'; snapshot.items[1].permissions[0].verified = true;
    await page.evaluate(() => window.PAConnections.refresh()); await page.waitForFunction(() => document.querySelector('#c-dialog .c-flow-state').textContent === '本地文件已连接。');
    assert.equal(calls.length, 1); await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.locator('#c-manage-files').click();
    assert.equal(await page.locator('#c-connect-files').textContent(), '调整访问范围');
    await page.locator('#c-connect-files').click();
    assert.match(await page.locator('#c-dialog-body').textContent(), /新授权将替换当前范围/);
    await page.getByRole('button', { name: '选择其他目录' }).click();
    await page.waitForFunction(() => document.querySelector('#c-dialog .c-flow-state')?.textContent.includes('文件选择弹窗'));
    assert.deepEqual(calls[1].values, { scope: 'selected-files' });
    assert.equal(snapshot.items[1].permissions[0].verified, false);
  });
  await run('native-file-settings-do-not-pretend-permission-granted', async page => {
    await page.locator('#c-connect-files').click(); await page.locator('#c-file-system-help summary').click();
    assert.match(await page.locator('#c-file-system-help').textContent(), /小满文件授权.*Xiaoman File Access.app/);
    assert.match(await page.locator('#c-file-system-help').textContent(), /只访问已确认的范围/);
    await page.getByRole('button', { name: '打开系统设置' }).click();
    await page.waitForFunction(() => document.querySelector('#c-dialog-status').textContent.includes('已请求'));
    assert.equal(calls[0].operation, 'settings'); assert.equal(calls[0].id, 'files'); assert.equal(snapshot.items[1].state, 'unlinked');
    await page.getByRole('button', { name: '授权这些目录' }).click();
    await page.waitForFunction(() => document.querySelector('#c-dialog .c-flow-state')?.textContent.includes('系统弹窗确认常用目录'));
    assert.equal(calls[1].revision, 2);
  });
  await run('phone-and-x-official-oauth', async page => {
    await page.locator('#c-connect-phone').click(); assert.match(await page.locator('#c-dialog-body').textContent(), /此处只验证连接/); await page.getByRole('button', { name: '连接当前手机' }).click();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    assert.equal(calls[0].id, 'phone'); await page.locator('#c-connect-x').click(); assert.equal(await page.locator('#c-dialog a[href="https://x.com/login"]').count(), 0);
    await page.getByRole('button', { name: '开始 X 授权' }).click(); await page.locator('#c-dialog .c-auth-link').waitFor();
    assert.match(await page.locator('#c-dialog .c-auth-link').getAttribute('href'), /^https:\/\/x.com\/i\/oauth2\/authorize/); assert.equal(calls[1].id, 'x');
    assert.equal(await page.locator('#c-dialog .c-code').count(), 0);
    await page.locator('#c-dialog').getByRole('button', { name: '取消授权', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#c-card-x').dataset.cState === 'revoked');
  });
  await run('official-auth-links-are-provider-specific', async page => {
    const row = snapshot.items.find(row => row.id === 'x'); row.state = 'awaiting_authorization';
    await page.evaluate(() => window.PAConnections.refresh()); await page.locator('#c-connect-x').click();
    for (const verificationUrl of ['https://accounts.google.com/', 'https://x.com/login', 'https://x.com.evil.invalid/i/oauth2/authorize', 'https://evil@x.com/i/oauth2/authorize', 'javascript:alert(1)']) {
      row.auth = { verificationUrl }; await page.evaluate(() => window.PAConnections.refresh());
      assert.equal(await page.locator('#c-dialog .c-auth-link').count(), 0);
    }
    row.auth = { verificationUrl: 'https://x.com/i/oauth2/authorize?client_id=fixture' }; await page.evaluate(() => window.PAConnections.refresh());
    assert.equal(await page.locator('#c-dialog .c-auth-link').count(), 1);
    assert.equal(await page.locator('#c-card-x .c-auth-link').count(), 0);
  });
  await run('unavailable-service-keeps-status-without-failed-action', async page => {
    const row = snapshot.items.find(row => row.id === 'x'); row.state = 'setup_required'; row.message = '服务方尚未配置连接。';
    await refresh(page); await page.waitForFunction(() => document.querySelector('#c-card-x .c-state').textContent === '暂不可用');
    assert.equal(await page.locator('#c-card-x .c-message').isVisible(), true);
    assert.equal(await page.locator('#c-connect-x').count(), 0); assert.equal(calls.length, 0);
  });
  await run('conflict-keeps-google-draft', async page => {
    await page.locator('#c-connect-google').click(); await page.locator('#c-google-email').fill('draft@example.invalid'); conflict = true;
    await page.getByRole('button', { name: '开始 Google 授权' }).click(); await page.locator('#c-reload-version').waitFor(); assert.equal(await page.locator('#c-google-email').inputValue(), 'draft@example.invalid'); assert.equal(await page.getByRole('button', { name: '开始 Google 授权' }).isDisabled(), true);
    await page.locator('#c-reload-version').click(); await page.waitForFunction(() => !document.querySelector('[data-c-action="submit"]').disabled);
    await page.getByRole('button', { name: '开始 Google 授权' }).click(); await page.locator('#c-dialog .c-code').waitFor(); assert.equal(calls[1].revision, 2); assert.equal(calls[1].values.account, 'draft@example.invalid');
  });
  await run('busy-disables-writes-and-poll-does-not-replay', async page => {
    await page.locator('#c-connect-phone').click(); let release; hold = new Promise(resolve => { release = resolve; });
    await page.getByRole('button', { name: '连接当前手机' }).click(); await page.waitForFunction(() => document.querySelector('#connections-root').getAttribute('aria-busy') === 'true');
    assert.equal(await page.locator('#c-refresh').isDisabled(), true); assert.equal(await page.locator('#nav-home').isDisabled(), false); await page.keyboard.press('Escape'); assert.equal(await page.locator('#c-dialog').evaluate(node => node.open), true); await page.waitForTimeout(5200); assert.equal(await page.locator('#c-dialog').evaluate(node => node.open && node.matches(':modal')), true);
    release(); await page.getByRole('button', { name: '完成', exact: true }).click(); hold = undefined;
    const count = await page.evaluate(() => window.__animations.length); await refresh(page); await page.waitForTimeout(150); assert.equal(await page.evaluate(() => window.__animations.length), count);
  });
  await run('reduced-motion-and-mobile-no-overflow', async page => {
    await page.locator('#c-connect-files').click(); await page.getByRole('button', { name: '授权这些目录' }).click();
    await page.waitForFunction(() => document.querySelector('#c-dialog .c-flow-state')?.textContent.includes('系统弹窗确认常用目录'));
    await page.getByRole('button', { name: '关闭连接设置' }).click();
    assert.equal(await page.evaluate(() => window.__animations.length), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, 'connections-mobile.png'), fullPage: true });
  }, { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  assert.deepEqual(errors, []); await writeFile(join(artifacts, 'results.json'), JSON.stringify({ results, externalActions: 0 }, null, 2));
  if (failures.length) throw new Error(`${failures.length} browser checks failed`);
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
