import test from 'node:test';
import assert from 'node:assert/strict';
import { journalReports } from '../plugins/webui/journal-reports.mjs';

test('patrol setup and failed checks cannot become results; each publication keeps its own dated sources', () => {
  const runs = [{ id: 'setup', journalItemId: 'page', report: { summary: '巡查已保存，明天开始' } }];
  const hub = { all: () => [{ journalItemId: 'page' }], snapshot: () => ({ runs }) };
  assert.equal(journalReports(hub).has('page'), false);
  const result = n => ({ id: 'run' + n, journalItemId: 'page', routine: { id: 'patrol' }, routinePublished: true, report: { summary: '发现' + n, updatedAt: n * 1000, artifacts: [{ label: '来源' + n, url: 'https://example.com/' + n }] } });
  runs.push(result(1));
  const first = journalReports(hub).get('page');
  runs.push({ id: 'failed', journalItemId: 'page', routine: { id: 'patrol' }, status: 'failed', report: { summary: '读取失败' } });
  assert.deepEqual(journalReports(hub).get('page'), first);
  runs.push(result(2));
  const latest = journalReports(hub).get('page');
  assert.equal(latest.answer, '发现2'); assert.equal(latest.answerAt, 2000);
  assert.deepEqual(latest.artifacts.map(a => a.url), ['https://example.com/2']);
  assert.equal(latest.history[0].answer, '发现1');
  assert.equal(latest.history[0].answerAt, 1000);
  assert.equal(latest.history[0].artifacts[0].url, 'https://example.com/1');
});

test('progress and blocked followups keep the previous useful result and its original date', () => {
  const runs = [{ id: 'first', journalItemId: 'page', status: 'completed', report: { summary: '三项准备清单', outcome: 'completed', updatedAt: 1000 } }];
  const hub = { all: () => [], snapshot: () => ({ runs }) };
  runs.push({ id: 'next', journalItemId: 'page', status: 'running', report: { summary: '正在继续', outcome: 'in_progress', updatedAt: 2000 } });
  let view = journalReports(hub).get('page');
  assert.equal(view.answer, '三项准备清单'); assert.equal(view.answerAt, 1000); assert.equal(view.isBusy, true);
  runs[1] = { ...runs[1], status: 'completed', report: { summary: '资料授权已过期', outcome: 'blocked', updatedAt: 3000 } };
  view = journalReports(hub).get('page');
  assert.equal(view.answer, '三项准备清单'); assert.equal(view.blocked, '资料授权已过期'); assert.equal(view.answerAt, 1000);
});

test('multi-page tool writes share exact input provenance without copying an unscoped report onto every page', () => {
  const runs = [{ id: 'create', conversationId: 'room', messageId: 'user-original', journalItemId: 'A', journalItemIds: ['A', 'B'], journalItemBound: false,
    status: 'completed', finishedAt: 100, report: { summary: '创建了两个独立页面', outcome: 'completed', updatedAt: 100 } }];
  const messages = [{ id: 'user-original', conversationId: 'room', role: 'user' }, { id: 'answer-create', conversationId: 'room', role: 'assistant', runId: 'create', createdAt: 100 }];
  const hub = { all: kind => kind === 'message' ? messages : [], snapshot: () => ({ runs }) };
  const initial = journalReports(hub);
  for (const item of ['A', 'B']) {
    assert.deepEqual(initial.get(item).originSourceRef, { conversationId: 'room', messageId: 'user-original' });
    assert.equal(initial.get(item).answer, undefined); assert.equal(initial.get(item).run, undefined);
  }
  runs.push({ id: 'follow-B', conversationId: 'room', messageId: 'user-next', journalItemId: 'B', journalItemIds: ['B'], journalItemBound: true,
    status: 'completed', finishedAt: 200, report: { summary: '只更新B的结果', outcome: 'completed', updatedAt: 200 } });
  messages.push({ id: 'user-next', conversationId: 'room', role: 'user' }, { id: 'answer-B', conversationId: 'room', role: 'assistant', runId: 'follow-B', createdAt: 200 });
  const updated = journalReports(hub);
  assert.equal(updated.get('A').answer, undefined); assert.equal(updated.get('B').answer, '只更新B的结果');
  assert.equal(updated.get('B').originSourceRef.messageId, 'user-original'); assert.equal(updated.get('B').sourceRef.messageId, 'answer-B');
});
