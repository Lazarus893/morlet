import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { webcrypto } from 'node:crypto';

const window = {};
const httpCrypto = { getRandomValues: values => webcrypto.getRandomValues(values) };
runInNewContext(readFileSync(new URL('../plugins/webui/public/routines-ui.js', import.meta.url), 'utf8'), { window, Intl, crypto: httpCrypto });
const ui = window.PARoutineUI;
const routine = {
  id: 'routine-fixture', version: 1, enabled: true, title: '每日资料巡查',
  instruction: '检查已授权资料，保留来源。',
  schedule: { time: '09:26', timezone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5, 6, 7] },
  trigger: { condition: '出现与当前项目相关的新材料', mode: 'changed' },
  nextRunAt: Date.parse('2026-10-28T01:26:00Z'),
  lastRunAt: Date.parse('2026-10-27T01:26:00Z'),
};
const render = (values = {}, draft = {}, zone = 'Asia/Shanghai', schedulerError) => parseHTML(`<html><body>${ui.render({ ...routine, ...values }, 'item-fixture', draft, zone, schedulerError)}</body></html>`).document;

test('failed verification never presents the model success claim as a result', () => {
  const doc = render({ lastStatus: 'failed', error: 'ROUTINE_SOURCE_INCOMPLETE', lastSummary: '所有网页完整读取，已核实。', lastRun: { gaps: [{ source: 'https://example.org/partial', status: 'incomplete' }] } });
  assert.doesNotMatch(doc.body.textContent, /所有网页完整读取/);
  assert.match(doc.body.textContent, /未通过读取核验/); assert.match(doc.body.textContent, /example.org\/partial/);
  assert.ok(doc.querySelector('[data-j-action="routine-run_now"]'));
});

test('changing the deadline does not silently reauthorise the channel or source binding', () => {
  const current = { ...routine, notification: { channelId: 'channel-1' }, scope: { publicWeb: false, sources: [{ operation: 'github_updates', filter: { repo: 'example/project' } }] } };
  const update = ui.settingsValues(current, { routineSettings: { endsAt: '' } });
  assert.deepEqual(JSON.parse(JSON.stringify(update)), { endsAt: null });
  const removal = ui.settingsValues(current, { routineSettings: { sources: [] } });
  assert.deepEqual(JSON.parse(JSON.stringify(removal)), { scope: { publicWeb: false, sources: [] } });
  assert.throws(() => ui.settingsValues(current, { routineSettings: { endsAt: 'invalid' } }), /结束时间/);
});

test('ended and revoked routines never imply another check and preserve an explicit recovery path', () => {
  const ended = { ...routine, endedAt: routine.lastRunAt, enabled: false, lastStatus: 'failed' };
  const doc = render(ended);
  assert.equal(ui.directoryLabel(ended), '已结束跟进');
  assert.equal(doc.querySelector('[data-j-action="routine-resume"]'), null);
  assert.equal(doc.querySelector('[data-j-action="routine-run_now"]'), null);
  const revoked = render({ scopeStatus: { blocked: true, error: 'SOURCE_AUTHORITY_CHANGED' }, scopeSummary: 'GitHub：example/project' });
  assert.equal(revoked.querySelector('[data-j-action="routine-run_now"]').disabled, true);
  assert.ok(revoked.querySelector('[data-j-action="routine-authorize_scope"]'));
  assert.ok([...revoked.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('来源授权已变化') && !node.closest('details')));
  const empty = render({ scope: { publicWeb: false, sources: [] }, scopeStatus: { blocked: true, error: 'ROUTINE_SCOPE_EMPTY' }, error: 'ROUTINE_SCOPE_EMPTY' });
  assert.match(empty.querySelector('summary').textContent, /等待选择来源/);
  assert.equal(empty.querySelector('[data-j-action="routine-run_now"]').disabled, true);
  assert.equal(empty.querySelector('[data-j-action="routine-authorize_scope"]'), null);
  assert.equal(empty.querySelector('[data-j-action="routine-connect"]'), null);
  assert.match(empty.querySelector('[role="status"]').textContent, /未选择资料来源/);
});

test('notification uncertainty is distinct from delivery and private scope text remains inert', () => {
  assert.equal(ui.noticeLabel({ state: 'unknown' }), '投递结果待核对');
  assert.equal(ui.noticeLabel({ state: 'pending', blocked: 'channel_offline' }), '提醒渠道离线');
  const doc = render({ scope: { publicWeb: false, sources: [{ operation: 'github_updates', filter: { repo: '<img src=x onerror=alert(1)>' } }] } });
  assert.equal(doc.querySelector('img'), null);
  assert.ok(doc.body.textContent.includes('<img'));
});

test('source drafts remain bound to permissions and cannot authorise a stale or changed scope', () => {
  const first = { operation: 'github_updates', filter: { repo: 'example/first' } };
  const second = { operation: 'github_updates', filter: { repo: 'example/second' } };
  const current = { ...routine, scope: { publicWeb: false, sources: [second, first] }, scopeStatus: { blocked: true } };
  const draft = { routineSettings: { baseVersion: 1, sources: [ui.sourceKey(first)] } };
  const selected = ui.settingsValues(current, draft);
  assert.deepEqual(JSON.parse(JSON.stringify(selected.scope.sources)), [first]);
  const changed = render(current, draft);
  assert.equal(changed.querySelector('[data-j-action="routine-authorize_scope"]').disabled, true);
  assert.equal(changed.querySelector('[data-routine-source]:checked').getAttribute('data-routine-source'), ui.sourceKey(first));
  const newer = { ...current, version: 2 };
  assert.throws(() => ui.settingsValues(newer, draft), /规则已变化/);
  const stale = render(newer, draft);
  assert.equal(stale.querySelector('[data-j-action="routine-save"]').disabled, true);
  assert.equal(stale.querySelector('[data-j-action="routine-authorize_scope"]').disabled, true);
  assert.ok(stale.querySelector('[data-j-action="routine-reset"]'));
  assert.equal(ui.sourceKey({ operation: 'file_read', filter: { rootId: 'a', path: 'b' } }), ui.sourceKey({ operation: 'file_read', filter: { path: 'b', rootId: 'a' } }));
});

test('mutation identities work on intranet HTTP without crypto.randomUUID', () => {
  assert.equal(httpCrypto.randomUUID, undefined);
  const first = ui.requestId(), second = ui.requestId();
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.match(second, /^[a-f0-9]{32}$/);
  assert.notEqual(first, second);
});

test('routine calendar labels preserve weekday selection and the schedule timezone', () => {
  assert.equal(ui.scheduleLabel(routine.schedule), '每天 09:26');
  assert.equal(ui.scheduleLabel({ time: '10:30', days: [5, 1, 2, 3, 4] }), '工作日 10:30');
  assert.equal(ui.scheduleLabel({ time: '08:00', days: [6, 7] }), '周末 08:00');
  assert.equal(ui.scheduleLabel({ time: '08:00', days: [1, 3, 5] }), '周一、周三、周五 08:00');
  assert.match(render().querySelector('summary').textContent, /下次 10\/28 09:26/);
  assert.equal(render().querySelector('.journal-routine-zone'), null, 'the local timezone is available inside rules without repeating it in the row');
  assert.match(render({}, {}, 'America/New_York').querySelector('summary').textContent, /Asia\/Shanghai/);
});

test('quiet checks retain a visible receipt without a success banner or result claim', () => {
  const doc = render({ lastStatus: 'quiet', lastSummary: '没有新材料' });
  assert.equal(doc.querySelector('details').hasAttribute('open'), false);
  const state = doc.querySelector('.journal-routine-status');
  assert.equal(state.closest('details'), null, 'the last check must remain visible when rules are collapsed');
  assert.match(state.textContent, /10\/27 09:26.*已检查，无新发现/);
  assert.doesNotMatch(state.textContent, /更新产物/);
  assert.equal(doc.querySelector('[data-j-action="routine-run_now"]').disabled, false);
});

test('failed, uncertain and approval states are visible with recovery, and uncertain runs cannot be repeated', () => {
  for (const status of ['failed', 'uncertain', 'waiting_approval']) {
    const doc = render({ lastStatus: status, error: 'AGENT_TIMEOUT' });
    const state = doc.querySelector('.journal-routine-problem');
    assert.equal(state.closest('details'), null);
    assert.ok(state.querySelector(`[data-j-action="routine-${status === 'failed' ? 'recover' : 'edit'}"]`));
    assert.doesNotMatch(state.textContent, /无新发现/);
    assert.equal(doc.querySelector('[data-j-action="routine-run_now"]').disabled, status !== 'failed');
    assert.ok(ui.directoryLabel({ ...routine, lastStatus: status }));
  }
});

test('paused routines expose recovery and do not promise another scheduled check', () => {
  const doc = render({ enabled: false, lastStatus: 'quiet' });
  assert.match(doc.querySelector('summary').textContent, /已暂停/);
  assert.doesNotMatch(doc.querySelector('summary').textContent, /下次/);
  assert.ok(doc.querySelector('[data-j-action="routine-resume"]'));
  assert.equal(doc.querySelector('[data-j-action="routine-run_now"]').disabled, true);
  assert.equal(ui.directoryLabel({ ...routine, enabled: false }), '已暂停');
});

test('a scheduler rejection is visible even before a run exists or after an older successful check', () => {
  for (const lastStatus of [null, 'quiet', 'published']) {
    const doc = render({ lastStatus, error: 'ENDPOINT_UNAVAILABLE', lastSummary: '旧检查的摘要，不是本次拒绝的原因' });
    const state = doc.querySelector('.journal-routine-problem');
    assert.match(state.textContent, /巡查暂未运行：执行 Agent 不可用/);
    assert.equal(state.closest('details'), null);
    assert.equal(state.querySelector('time'), null, 'an older check time must not date a new scheduler rejection');
    assert.equal(state.querySelector('.journal-routine-result-details'), null, 'an older successful report must not be presented as the new failure reason');
    assert.equal(ui.directoryLabel({ ...routine, lastStatus, error: 'ENDPOINT_UNAVAILABLE' }), '巡查暂未运行');
  }
});

test('source connection failures name the cause and point to connection recovery', () => {
  const cases = { SOURCE_BRIDGE_OFFLINE: '资料来源 Mac 离线', SOURCE_REVOKED: '资料授权已撤回', SOURCE_NOT_CONFIGURED: '资料来源尚未连接' };
  for (const [error, reason] of Object.entries(cases)) {
    const doc = render({ lastStatus: 'failed', error });
    assert.ok(doc.querySelector('.journal-routine-problem').textContent.includes(reason));
    assert.equal(doc.querySelector('[data-j-action="routine-connect"]').textContent, '检查连接');
  }
  assert.match(render({ error: 'JOURNAL_CLOSED' }).body.textContent, /手账已归档或不可用/);
});

test('long failure reports leave a short visible error and retain their complete text in a disclosure', () => {
  const summary = '已读取 https://example.org/releases，但历史窗口的来源读取失败。\n' + '详情与来源证据。'.repeat(140) + '\n最后一条待核对信息完整保留。';
  const doc = render({ lastStatus: 'failed', error: 'ROUTINE_INCOMPLETE', lastSummary: summary });
  const details = doc.querySelector('.journal-routine-result-details');
  assert.ok(details);
  assert.equal(details.hasAttribute('open'), false);
  assert.match(details.querySelector('summary').textContent, /检查尚未完成/);
  assert.ok(details.querySelector('summary').textContent.length < 40);
  assert.doesNotMatch(details.querySelector('summary').textContent, /https|example|详情与/);
  assert.equal(details.querySelector('p').textContent, '执行端说明：' + summary, 'the detailed report must not be truncated');
  assert.ok(doc.querySelector('.journal-routine-status > [data-j-action="routine-recover"]'), 'execution recovery remains outside the collapsed report');
  const unknown = render({ lastStatus: 'failed', error: 'UNMAPPED_FAILURE', lastSummary: '<img src=x onerror="bad()">\n' + summary });
  assert.match(unknown.querySelector('.journal-routine-result-details > summary').textContent, /这次巡查未完成/);
  assert.equal(unknown.querySelector('img'), null);
});

test('an uncertain submission offers reconciliation and blocks fresh mutations', () => {
  const doc = render({}, { routineSubmission: { id: routine.id, operation: 'run_now', requestId: 'known-request' } });
  assert.match(doc.body.textContent, /操作结果待确认/);
  assert.ok(doc.querySelector('[data-j-action="routine-reconcile"]'));
  assert.equal(doc.querySelector('[data-j-action="routine-pause"]').disabled, true);
  assert.equal(doc.querySelector('[data-j-action="routine-run_now"]').disabled, true);
  const busy = render({}, { routineSubmission: {}, routineBusy: true });
  assert.equal(busy.querySelector('[data-j-action="routine-reconcile"]'), null);
});

test('instructions and failures are inert text, while scheduler failures cannot disappear inside rules', () => {
  const doc = render({ instruction: '<img src=x onerror="alert(1)">', trigger: { condition: '<script>bad()</script>', mode: 'changed' } }, { routineError: '<b>bad</b>' }, 'Asia/Shanghai', 'SCHEDULER_FAILED');
  assert.equal(doc.querySelector('script,img,b'), null);
  assert.match(doc.querySelector('.journal-routine-rule-body').textContent, /<img/);
  const warning = [...doc.querySelectorAll('[role="alert"]')].find(node => /调度暂不可用/.test(node.textContent));
  assert.ok(warning);
  assert.equal(warning.closest('details'), null);
});
