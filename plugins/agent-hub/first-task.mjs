import { resolveBot, mentionedBots } from './bots.mjs';
import { attachmentForSend, attachmentPrompt } from './attachments.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { failure } from './store.mjs';
import { hubConfig } from './config.mjs';
import { JOURNAL_TOOL } from './journal.mjs';
import { validateTaskData, validateTaskType, validateTimestamp } from '../life-journal/widgets.mjs';

const KIND = 'firstTask';
const OWNER = 'owner';
const POINTER = 'owner';
const BUSY = new Set(['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling']);
const WRITE_FIELDS = ['title', 'kind', 'date', 'note', 'steps', 'candidates', 'taskType', 'taskData'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const copy = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const journalDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const str = (value, max = 16000, empty = false) => {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /[\x00]/.test(value)) throw failure('INVALID_INPUT');
  return value.trim();
};
const identifier = value => { const result = str(value, 128); if (!/^[a-zA-Z0-9:_-]+$/.test(result)) throw failure('INVALID_INPUT'); return result; };
const bump = (hub, flow, fields) => hub.put(KIND, { ...flow, ...fields, version: flow.version + 1, updatedAt: hub.now() });

function flowForId(hub, flowId) {
  const flow = hub.get(KIND, flowId);
  if (!flow || flow.ownerId !== OWNER) throw failure('ITEM_NOT_FOUND');
  if (flow.conversationId) {
    const conversation = hub.get('conversation', flow.conversationId);
    if (!conversation || conversation.ownerId !== OWNER || hub.all('binding').some(binding => binding.conversationId === conversation.id)) throw failure('FORBIDDEN');
  }
  return flow;
}

export function firstTaskForRun(hub, candidate) {
  if (!candidate?.firstTaskId) return null;
  const run = hub.get('run', candidate.id), flow = flowForId(hub, candidate.firstTaskId);
  if (!run || run.firstTaskId !== flow.id || run.conversationId !== flow.conversationId || run.source?.channel !== 'web' || !flow.runIds.includes(run.id)) throw failure('FORBIDDEN');
  return flow;
}

function currentRunFlow(hub, candidate) {
  const flow = firstTaskForRun(hub, candidate), run = candidate && hub.get('run', candidate.id);
  if (!flow || flow.currentRunId !== run.id || candidate.lease !== run.lease || !['running', 'waiting_approval'].includes(run.status)) throw failure('FORBIDDEN');
  return { flow, run };
}

function proposalValues(value, now, timeZone) {
  if (!exact(value, WRITE_FIELDS) || typeof value.title !== 'string') throw failure('INVALID_INPUT');
  const values = copy(value);
  values.title = str(values.title, 300);
  if (values.kind !== undefined && !['arrangement', 'purchase', 'experience', 'wish'].includes(values.kind)) throw failure('INVALID_INPUT');
  if (values.date !== undefined && values.date !== null) { try { validateTimestamp(values.date); } catch { throw failure('INVALID_INPUT'); } }
  if (values.note !== undefined) values.note = str(values.note, 10000, true);
  if (values.steps !== undefined) {
    if (!Array.isArray(values.steps) || values.steps.length > 100) throw failure('INVALID_INPUT');
    values.steps = values.steps.map(step => {
      if (!exact(step, ['id', 'label', 'done']) || step.done !== false) throw failure('INVALID_INPUT');
      return { ...(step.id !== undefined ? { id: identifier(step.id) } : {}), label: str(step.label, 500), done: false };
    });
    const ids = values.steps.filter(step => step.id).map(step => step.id);
    if (new Set(ids).size !== ids.length) throw failure('INVALID_INPUT');
  }
  if (values.candidates !== undefined) {
    if (!Array.isArray(values.candidates) || values.candidates.length > 30) throw failure('INVALID_INPUT');
    values.candidates = values.candidates.map(candidate => {
      if (!exact(candidate, ['id', 'name', 'detail', 'selected', 'url']) || typeof candidate.selected !== 'boolean') throw failure('INVALID_INPUT');
      const result = { ...(candidate.id !== undefined ? { id: identifier(candidate.id) } : {}), name: str(candidate.name, 200), selected: candidate.selected };
      if (candidate.detail !== undefined) result.detail = str(candidate.detail, 2000, true);
      if (candidate.url !== undefined) {
        let url; try { url = new URL(str(candidate.url, 2048)); } catch { throw failure('INVALID_INPUT'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('INVALID_INPUT');
        result.url = url.href;
      }
      return result;
    });
    if (values.candidates.filter(candidate => candidate.selected).length > 1) throw failure('INVALID_INPUT');
  }
  try {
    if (values.taskType !== undefined) validateTaskType(values.taskType);
    if (values.taskData !== undefined) values.taskData = validateTaskData(values.taskData, { now, timeZone });
  } catch { throw failure('INVALID_INPUT'); }
  if (!values.note && !values.steps?.length) throw failure('FIRST_TASK_PLAN_REQUIRED');
  return values;
}

export const FIRST_TASK_TOOL = {
  type: 'function', name: 'xiaoman_first_task',
  description: 'Guide the owner’s first life arrangement. Only use for a job with trusted firstTask context. Ask 1–3 necessary questions at a time in ask; allow a natural sentence answering them. Do not invent the birthday person, time, party size, budget, availability, or completed steps. Read xiaoman_journal list for the real date/timezone when resolving Sunday. Propose a clear planned arrangement in proposal using the xiaoman_journal values contract; title and a plan (note or planned steps done:false) are required. Propose does NOT save anything. Only the owner clicking the Web confirmation authorizes saving. The model cannot confirm. In the saving phase copy trusted confirmedProposal.values exactly and use xiaoman_journal: add only if savedItemId is null, otherwise get and update that exact savedItemId. Do not book, buy, send messages, control phones, or invoke unrelated tools in this guided flow. Use blocked with an honest reason and the next user action when unable to proceed. An execution ending is not evidence of journal save or business completion.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operation: { type: 'string', enum: ['ask', 'propose', 'blocked'] },
    questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', maxLength: 128 }, label: { type: 'string', maxLength: 300 }, hint: { type: 'string', maxLength: 500 } }, required: ['id', 'label'] } },
    message: { type: 'string', maxLength: 1200 }, proposal: { type: 'object', additionalProperties: false, properties: { ...Object.fromEntries(WRITE_FIELDS.map(field => [field, JOURNAL_TOOL.inputSchema.properties.values.properties[field]])), kind: { type: 'string', enum: ['arrangement', 'purchase', 'experience', 'wish'] } }, required: ['title'] },
    summary: { type: 'string', maxLength: 1200 }, reason: { type: 'string', maxLength: 1200 }, nextAction: { type: 'string', maxLength: 500 },
  }, required: ['operation'] },
};

export async function firstTaskTool({ hub, read, token, input }) {
  const endpoint = hub.authenticate(token);
  const authorize = () => {
    const run = hub.get('run', input.runId);
    if (!run || run.endpointId !== endpoint.id || run.lease !== input.lease) throw failure('FORBIDDEN');
    return currentRunFlow(hub, run);
  };
  authorize();
  const args = input.arguments, callId = str(input.callId, 200);
  if (!exact(args, ['operation', 'questions', 'message', 'proposal', 'summary', 'reason', 'nextAction']) || !['ask', 'propose', 'blocked'].includes(args.operation)) throw failure('INVALID_INPUT');
  const settings = read ? await read() : null;
  return hub.transaction(() => {
    const { flow, run } = authorize();
    if (flow.guideItemId && args.operation !== 'blocked') throw failure('FORBIDDEN');
    const key = 'first-task-tool:' + run.id + ':' + callId, fingerprint = digest(args), old = hub.get('firstTaskToolReceipt', key);
    if (old) { if (old.digest !== fingerprint) throw failure('CONFLICT'); return copy(old.result); }
    if (flow.stage === 'recorded' || flow.confirmedProposal?.runId === run.id && args.operation !== 'blocked') throw failure('FIRST_TASK_CONFIRM_REQUIRED');
    let fields;
    if (args.operation === 'ask') {
      if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3 || args.proposal !== undefined || args.reason !== undefined || args.nextAction !== undefined || args.summary !== undefined) throw failure('INVALID_INPUT');
      const questions = args.questions.map(question => {
        if (!exact(question, ['id', 'label', 'hint'])) throw failure('INVALID_INPUT');
        return { id: identifier(question.id), label: str(question.label, 300), ...(question.hint !== undefined ? { hint: str(question.hint, 500, true) } : {}) };
      });
      if (new Set(questions.map(question => question.id)).size !== questions.length) throw failure('INVALID_INPUT');
      fields = { stage: 'awaiting_answer', questions, questionMessage: args.message === undefined ? '' : str(args.message, 1200, true), proposal: null, blocked: null };
    } else if (args.operation === 'propose') {
      if (args.questions !== undefined || args.message !== undefined || args.reason !== undefined || args.nextAction !== undefined) throw failure('INVALID_INPUT');
      const timezone = settings?.config?.proactive?.timezone;
      const values = proposalValues(args.proposal, hub.now(), timezone && timezone !== 'local' ? timezone : Intl.DateTimeFormat().resolvedOptions().timeZone);
      const proposal = { version: (flow.proposalSequence || 0) + 1, values, summary: args.summary === undefined ? '' : str(args.summary, 1200, true), createdAt: hub.now(), runId: run.id };
      fields = { stage: 'awaiting_confirmation', proposal, proposalSequence: proposal.version, questions: [], questionMessage: '', blocked: null };
    } else {
      if (args.questions !== undefined || args.message !== undefined || args.proposal !== undefined || args.summary !== undefined) throw failure('INVALID_INPUT');
      fields = { stage: 'blocked', blocked: { reason: str(args.reason, 1200), nextAction: str(args.nextAction, 500) }, questions: [], proposal: null };
    }
    const updated = bump(hub, flow, fields), result = { accepted: true, flowId: flow.id, version: updated.version, stage: updated.stage, saved: false };
    hub.put('firstTaskToolReceipt', { id: key, digest: fingerprint, result });
    return result;
  });
}

export function assertFirstTaskJournalWrite(hub, candidate, args, input) {
  if (!candidate?.firstTaskId || ['list', 'get'].includes(args?.operation)) return null;
  const { flow, run } = currentRunFlow(hub, candidate), confirmed = flow.confirmedProposal;
  if (!confirmed || confirmed.runId !== run.id || !['add', 'update'].includes(args.operation) || digest(args.values) !== digest(confirmed.values)) throw failure('FIRST_TASK_CONFIRM_REQUIRED');
  if (flow.savedProposalVersion === confirmed.version) {
    const old = input?.callId && hub.get('effect', 'journal:' + run.id + ':' + input.callId);
    if (old?.state === 'done' && old.result?.saved === true && flow.itemIds.includes(old.result.item?.id) && old.digest === journalDigest(args)) return flow;
    throw failure('FIRST_TASK_ALREADY_SAVED');
  }
  const currentCall = input?.callId ? 'journal:' + run.id + ':' + input.callId : null;
  // The journal host creates this call's pending effect before its final commit
  // fence. A replay of that same pending call is rejected by journalTool itself.
  if (hub.all('effect').some(effect => flow.runIds.some(id => effect.id.startsWith('journal:' + id + ':')) && (effect.state === 'uncertain' || effect.state === 'pending' && (effect.id !== currentCall || effect.digest !== journalDigest(args))))) throw failure('FIRST_TASK_WRITE_UNCERTAIN');
  if (flow.itemIds.length ? args.operation !== 'update' || args.itemId !== flow.itemIds[0] : args.operation !== 'add') throw failure('FIRST_TASK_ITEM_MISMATCH');
  return flow;
}

export function recordFirstTaskReceipt(hub, candidate, receipt, input) {
  if (!candidate?.firstTaskId || receipt?.saved !== true) return null;
  return hub.transaction(() => {
    const flow = firstTaskForRun(hub, candidate), run = hub.get('run', candidate.id);
    const confirmed = flow?.confirmations?.find(proposal => proposal.runId === run.id) || (flow?.confirmedProposal?.runId === run.id ? flow.confirmedProposal : null);
    if (!flow || candidate.lease !== run.lease || input?.runId !== run.id || input.lease !== run.lease || !confirmed || digest(input.arguments?.values) !== digest(confirmed.values) || !receipt.item?.id || !Number.isSafeInteger(receipt.item.version) || flow.itemIds.length && !flow.itemIds.includes(receipt.item.id)) throw failure('FIRST_TASK_ITEM_MISMATCH');
    const effect = input?.callId && hub.get('effect', 'journal:' + run.id + ':' + input.callId);
    if (!effect || effect.digest !== journalDigest(input.arguments) || effect.state !== 'done' || effect.result?.saved !== true || effect.result.item?.id !== receipt.item.id || effect.result.item.version !== receipt.item.version) throw failure('FORBIDDEN');
    if (flow.receipts?.some(entry => entry.runId === run.id && entry.callId === input.callId)) return flow;
    const saved = { runId: run.id, callId: input.callId, proposalVersion: confirmed.version, itemId: receipt.item.id, itemVersion: receipt.item.version, revision: receipt.revision, savedAt: hub.now() };
    return bump(hub, flow, { ...(flow.currentRunId === run.id ? { stage: 'recorded', blocked: null } : {}), itemIds: [receipt.item.id], savedProposalVersion: confirmed.version, receipt: saved, receipts: [...(flow.receipts || []), saved] });
  });
}

function userRun(hub, flow, content, endpointId, requestId, mode, botId) {
  const mentions = mentionedBots(hub, content);
  botId = mentions[0] || botId || flow.botId;
  if (botId) endpointId = resolveBot(hub, botId).endpoint.id;
  const conversation = flow.conversationId ? hub.conversation(flow.conversationId) : hub.newConversation({ endpointId, title: '第一件生活事' });
  if (conversation.ownerId !== OWNER || hub.all('binding').some(binding => binding.conversationId === conversation.id)) throw failure('FORBIDDEN');
  const submitted = hub.submit({ conversationId: conversation.id, endpointId, ...(botId && { botId }), content, requestId: 'first-task:' + flow.id + ':' + requestId, source: { channel: 'web' } });
  hub.put('run', { ...submitted.run, firstTaskId: flow.id, firstTaskMode: mode });
  return { conversationId: conversation.id, currentRunId: submitted.run.id, endpointId: submitted.run.endpointId, ...(botId && { botId }), runIds: [...flow.runIds, submitted.run.id], draft: '' };
}

function availableEndpoint(hub, preferred) {
  const key = preferred || hubConfig(hub.root).roles.conversation;
  if (!key) throw failure('ROLE_UNCONFIGURED');
  const endpoint = hub.resolveEndpoint(key);
  if (!endpoint.lastSeen || hub.now() - endpoint.lastSeen >= 45000) throw failure('ENDPOINT_OFFLINE');
  return endpoint.id;
}

function idle(hub, flow) {
  const run = flow.currentRunId && hub.get('run', flow.currentRunId);
  if (['uncertain', 'cancelling'].includes(run?.status)) throw failure('FIRST_TASK_RECOVERY_REQUIRED');
  if (BUSY.has(run?.status)) throw failure('FIRST_TASK_BUSY');
}

function newFlow(hub, endpointId) {
  const flow = hub.put(KIND, { id: randomUUID(), ownerId: OWNER, version: 1, stage: 'draft', draft: '', endpointId: endpointId || null, conversationId: null, currentRunId: null, runIds: [], questions: [], questionMessage: '', proposal: null, proposalSequence: 0, confirmedProposal: null, confirmations: [], savedProposalVersion: null, itemIds: [], receipt: null, receipts: [], blocked: null, createdAt: hub.now(), updatedAt: hub.now() });
  hub.put('firstTaskState', { id: POINTER, currentFlowId: flow.id }); return flow;
}

function cleanRun(run) {
  if (!run) return null;
  return { id: run.id, status: run.status, error: run.error || null, createdAt: run.createdAt, startedAt: run.startedAt || null, finishedAt: run.finishedAt || null, report: run.report ? Object.fromEntries(['title', 'summary', 'outcome'].filter(key => run.report[key] !== undefined).map(key => [key, run.report[key]])) : null };
}

function viewFlow(hub, flow, journal) {
  const run = flow.currentRunId && hub.get('run', flow.currentRunId);
  const readItem = flow.followupRead && flow.followupRead.runId === run?.id && journal?.items?.find(item => item.id === flow.followupRead.itemId);
  const followupAnswer = run?.firstTaskMode === 'followup' && run.status === 'completed' && (run.report?.outcome === 'completed' || flow.guideItemId && run.report?.outcome === 'partial') && readItem && flow.itemIds.includes(readItem.id) && flow.stage === 'queued'
    ? hub.all('message').filter(message => message.runId === run.id && message.role === 'assistant').at(-1)?.text || run.report.summary || null : null;
  let stage = flow.stage;
  if (run?.status === 'queued') stage = 'queued';
  else if (['running', 'waiting_approval'].includes(run?.status) && !['awaiting_answer', 'awaiting_confirmation', 'recorded', 'blocked', 'saving'].includes(stage)) stage = 'working';
  else if (['failed', 'cancelled', 'uncertain', 'cancelling'].includes(run?.status) && stage !== 'recorded') stage = run.status;
  else if (run?.status === 'completed' && !['awaiting_answer', 'awaiting_confirmation', 'recorded', 'blocked'].includes(stage)) stage = 'incomplete';
  if (followupAnswer) stage = 'recorded';
  const isBusy = BUSY.has(run?.status), itemRecords = flow.itemIds.map(id => journal?.items?.find(item => item.id === id)).filter(Boolean).map(item => ({ id: item.id, title: item.title, date: item.date, status: item.status, version: item.version, taskType: item.taskType || 'auto' }));
  const ready = journal?.design?.status === 'ready' && journal.design.baseRevision === journal.revision && journal.layout?.source === 'agent';
  const design = { state: !flow.itemIds.length ? 'not_requested' : !journal ? 'unknown' : itemRecords.length !== flow.itemIds.length ? 'record_missing' : ready ? 'ready' : journal.design?.status || 'unknown', current: ready === true, revision: journal?.revision ?? null, message: !flow.itemIds.length ? '确认计划后再生成组件' : ready ? '手账组件已按当前记录生成' : '计划记录与组件生成分别跟进' };
  const approvals = hub.all('approval').filter(approval => approval.runId === run?.id && approval.state === 'pending').map(({ id, toolName, reason, expiresAt, state }) => ({ id, toolName, reason, expiresAt, state }));
  let nextAction;
  if (run?.status === 'uncertain') nextAction = { kind: 'check', label: '核对办理状态', detail: '执行结果尚未确认；不会自动重新提交。先核对状态，再确认停止或等待恢复。' };
  else if (run?.status === 'cancelling') nextAction = { kind: 'wait', label: '正在等待停止', detail: '原执行尚未确认停止，暂不开始下一轮。' };
  else if (isBusy) nextAction = { kind: 'wait', label: approvals.length ? '需要你的批准' : stage === 'saving' ? '正在保存已确认的计划' : 'Mori 正在整理', detail: '可以先写补充，当前办理结束后再发送。' };
  else if (stage === 'awaiting_answer') nextAction = { kind: 'answer', label: '告诉 Mori', detail: '可以用一句话回答，不必逐个填写。' };
  else if (stage === 'awaiting_confirmation') nextAction = { kind: 'confirm', label: flow.itemIds.length ? '确认更新这份计划' : '确认并记入手账' };
  else if (stage === 'recorded') nextAction = { kind: 'view', label: itemRecords.length ? '查看这件事' : '核对手账记录', detail: '已记录计划；实际生日准备尚未因此完成。' };
  else if (stage === 'blocked') nextAction = { kind: 'answer', label: '补充后继续', detail: flow.blocked?.nextAction || '' };
  else if (['failed', 'cancelled', 'incomplete'].includes(stage)) nextAction = { kind: 'retry', label: '接着处理这件事', detail: stage === 'incomplete' ? '这轮已结束，但没有留下问题、可确认计划或保存回执，需要继续核对。' : '保留交代和已有记录，由你决定是否继续。' };
  else nextAction = { kind: 'start', label: '交给 Mori' };
  return { ...Object.fromEntries(['id', 'version', 'draft', 'endpointId', 'conversationId', 'currentRunId', 'runIds', 'questions', 'questionMessage', 'proposal', 'confirmedProposal', 'itemIds', 'blocked', 'lastRequest', 'lastDraftRequest', 'createdAt', 'updatedAt'].map(key => [key, copy(flow[key] ?? null)])), stage, followupAnswer, isBusy, itemRecords, runSummary: cleanRun(run), relatedRuns: flow.runIds.map(id => cleanRun(hub.get('run', id))).filter(Boolean), messages: hub.all('message').filter(message => message.conversationId === flow.conversationId).map(({ id, role, text, runId, createdAt }) => ({ id, role, text, runId, createdAt })), approvals, design, nextAction };
}

export function createFirstTaskFlow({ hub }) {
  const snapshot = ({ journal, flowId } = {}) => {
    hub.transaction(() => hub.expire());
    const currentFlowId = hub.get('firstTaskState', POINTER)?.currentFlowId || null;
    const flow = flowId ? flowForId(hub, flowId) : currentFlowId ? flowForId(hub, currentFlowId) : null;
    return { currentFlowId, flow: flow ? viewFlow(hub, flow, journal) : null, history: hub.all(KIND).filter(row => row.ownerId === OWNER && !row.guideItemId).map(row => ({ id: row.id, version: row.version, title: row.proposal?.values?.title || (row.runIds[0] ? hub.get('run', row.runIds[0])?.title : null) || '尚未交代的生活事', stage: viewFlow(hub, row, journal).stage, itemIds: row.itemIds, updatedAt: row.updatedAt })), agents: { preferredEndpointId: hubConfig(hub.root).roles.conversation || null, endpoints: hub.all('endpoint').filter(endpoint => endpoint.active).map(endpoint => ({ id: endpoint.id, label: endpoint.label, online: !!endpoint.lastSeen && hub.now() - endpoint.lastSeen < 45000 })) } };
  };
  const action = input => hub.transaction(() => {
    if (!exact(input, ['operation', 'flowId', 'version', 'requestId', 'text', 'endpointId', 'proposalVersion', 'approvalId', 'allow', 'confirmStopped']) || !['draft', 'start', 'send', 'confirm', 'cancel-run', 'decide', 'new'].includes(input.operation)) throw failure('INVALID_INPUT');
    const requestId = str(input.requestId, 200), key = 'first-task-request:' + digest(requestId), fingerprint = digest(input), previous = hub.get('firstTaskRequest', key);
    if (previous) { if (previous.digest !== fingerprint) throw failure('CONFLICT'); return copy(previous.result); }
    let flow = input.flowId ? flowForId(hub, identifier(input.flowId)) : null;
    const currentFlowId = hub.get('firstTaskState', POINTER)?.currentFlowId;
    if (flow && currentFlowId && flow.id !== currentFlowId) throw failure('FIRST_TASK_FLOW_REQUIRED');
    if (flow && input.version !== flow.version) throw failure('VERSION_CONFLICT');
    if (!flow && (input.version !== undefined || !['draft', 'start', 'new'].includes(input.operation))) throw failure('INVALID_INPUT');
    if (!flow && hub.get('firstTaskState', POINTER)?.currentFlowId) throw failure('FIRST_TASK_FLOW_REQUIRED');
    if (input.operation === 'new') {
      if (flow) idle(hub, flow);
      flow = newFlow(hub, input.endpointId);
    } else {
      if (!flow) flow = newFlow(hub, input.endpointId);
      let fields;
      if (input.operation === 'draft') { str(input.text, 16000, true); fields = { draft: input.text, ...(input.endpointId !== undefined ? { endpointId: identifier(input.endpointId) } : {}) }; }
      else if (['start', 'send'].includes(input.operation)) {
        idle(hub, flow);
        if (input.operation === 'start' && flow.runIds.length) throw failure('CONFLICT');
        if (input.operation === 'send' && !flow.runIds.length) throw failure('INVALID_INPUT');
        const endpointId = availableEndpoint(hub, input.endpointId || flow.endpointId), content = str(input.text === undefined ? flow.draft : input.text);
        fields = { ...userRun(hub, flow, content, endpointId, requestId, flow.itemIds.length ? 'followup' : 'clarify'), stage: 'queued', questions: [], questionMessage: '', proposal: null, confirmedProposal: null, blocked: null, followupRead: null };
      } else if (input.operation === 'confirm') {
        idle(hub, flow);
        if (flow.stage !== 'awaiting_confirmation' || !flow.proposal || input.proposalVersion !== flow.proposal.version) throw failure('VERSION_CONFLICT');
        const endpointId = availableEndpoint(hub, flow.endpointId), confirmed = { ...copy(flow.proposal), confirmedAt: hub.now() };
        fields = userRun(hub, flow, '我确认这份计划，请按刚才确认的内容记入生活手账。', endpointId, requestId, 'save');
        confirmed.runId = fields.currentRunId;
        fields = { ...fields, stage: 'saving', confirmedProposal: confirmed, confirmations: [...flow.confirmations, confirmed], questions: [], blocked: null };
      } else if (input.operation === 'cancel-run') {
        const run = flow.currentRunId && hub.get('run', flow.currentRunId);
        if (!run || !BUSY.has(run.status) || input.confirmStopped !== undefined && typeof input.confirmStopped !== 'boolean') throw failure('CONFLICT');
        hub.cancel(run.id, input.confirmStopped === true); fields = {};
      } else if (input.operation === 'decide') {
        const approval = hub.get('approval', input.approvalId);
        if (!approval || approval.runId !== flow.currentRunId || approval.conversationId !== flow.conversationId) throw failure('FORBIDDEN');
        hub.decide({ approvalId: input.approvalId, allow: input.allow, conversationId: flow.conversationId }); fields = {};
      }
      flow = bump(hub, flow, fields);
    }
    flow = hub.put(KIND, { ...flow, [input.operation === 'draft' ? 'lastDraftRequest' : 'lastRequest']: { requestId, operation: input.operation, version: flow.version } });
    hub.put('firstTaskState', { id: POINTER, currentFlowId: flow.id });
    const result = { flowId: flow.id, version: flow.version, runId: flow.currentRunId, flow: viewFlow(hub, flow) };
    hub.put('firstTaskRequest', { id: key, digest: fingerprint, result }); return result;
  });
  const guideSnapshot = journal => {
    if (journal.guide?.resultItemId) hub.transaction(() => hub.expire());
    const itemId = journal.guide?.resultItemId;
    if (!itemId) return null;
    const flow = hub.get(KIND, 'guide:' + itemId);
    if (!flow) return { stage: 'not_started', isBusy: false, answer: null };
    const view = viewFlow(hub, flow, journal);
    const failedReason = view.stage === 'failed' ? view.runSummary?.error === 'AGENT_TIMEOUT'
      ? '这次分析等待超时。材料和跟进事项已保留，可以重试同一件事。'
      : '这次分析没有完成。材料和跟进事项已保留，可以重试同一件事。' : null;
    return { conversationId: flow.conversationId, stage: view.stage, isBusy: view.isBusy, answer: view.followupAnswer, run: view.runSummary,
      reason: view.blocked?.reason || failedReason, nextAction: view.blocked?.nextAction || null };
  };
  const startGuide = ({ journal, requestId }) => hub.transaction(() => {
    str(requestId, 200);
    const item = journal.items.find(item => item.id === journal.guide?.resultItemId);
    if (!item || !journal.guide?.selectedId) throw failure('ITEM_NOT_FOUND');
    const id = 'guide:' + item.id;
    let flow = hub.get(KIND, id);
    if (flow) {
      const view = viewFlow(hub, flow, journal);
      if (view.isBusy || view.followupAnswer || flow.lastGuideRequest === requestId) return { flowId: id, runId: flow.currentRunId };
      idle(hub, flow);
    }
    const endpointId = availableEndpoint(hub, flow?.endpointId);
    if (!flow) flow = hub.put(KIND, { id, ownerId: OWNER, guideItemId: journal.guide.itemId, version: 1,
      stage: 'draft', draft: '', endpointId, conversationId: null, currentRunId: null, runIds: [],
      questions: [], questionMessage: '', proposal: null, proposalSequence: 0, confirmedProposal: null,
      confirmations: [], savedProposalVersion: null, itemIds: [item.id], receipt: null, receipts: [],
      blocked: null, createdAt: hub.now(), updatedAt: hub.now() });
    const content = `我在认识 Mori 的引导里选中了这件真实事项，请继续帮我分析。先读取手账事项 ${item.id} 的当前内容。只处理这一件事，依据已保存的正文、来源摘录和覆盖范围，给出：1. 具体变化；2. 为什么值得我关注；3. 一个现在可做的下一步，以及仍需核实的事实。把已有材料的整理与本轮新核实分清。如果已连接的只读资料工具能够定位原始邮件或仓库，可以有界核对；不能访问则基于现有材料明确说明。无需追问，不生成待确认提案，不修改记录，不外发、不安排定时监控。最后直接向我汇报分析结果并提交完成报告；资料不足时给出部分结果和原因。`;
    flow = bump(hub, flow, { ...userRun(hub, flow, content, endpointId, requestId, 'followup'),
      stage: 'queued', blocked: null, followupRead: null, lastGuideRequest: requestId });
    return { flowId: id, runId: flow.currentRunId };
  });
  const continueGuide = ({ conversationId, content, endpointId, botId, requestId, attachmentId }) => hub.transaction(() => {
    const found = hub.all(KIND).find(flow => flow.guideItemId && flow.conversationId === conversationId);
    if (!found) return null;
    const flow = flowForId(hub, found.id);
    const input = { conversationId, ...(botId && { botId: identifier(botId) }), content: str(content), endpointId: endpointId === undefined ? null : identifier(endpointId), requestId: str(requestId, 200), ...(attachmentId && { attachmentId }) };
    const key = 'guide-send:' + flow.id + ':' + digest(input.requestId), fingerprint = digest(input), previous = hub.get('firstTaskRequest', key);
    if (previous) { if (previous.digest !== fingerprint) throw failure('CONFLICT'); return copy(previous.result); }
    const attachment = attachmentId ? attachmentForSend(hub, conversationId, attachmentId) : null;
    idle(hub, flow);
    // This is a new explicit Web message in the same guarded, read-only flow.
    // Keep the independent first-task draft and every earlier run/report intact.
    const endpoint = availableEndpoint(hub, input.endpointId || flow.endpointId);
    const fields = userRun(hub, flow, input.content, endpoint, 'continue-' + digest(input.requestId), 'followup', input.botId);
    bump(hub, flow, { ...fields, stage: 'queued', blocked: null, followupRead: null });
    let run = hub.get('run', fields.currentRunId), message = hub.get('message', run.messageId);
    if (attachment) {
      run = hub.put('run', { ...run, attachmentIds: [attachment.id], prompt: run.prompt + attachmentPrompt(attachment) });
      message = hub.put('message', { ...message, attachments: [{ id: attachment.id, name: attachment.name }] });
    }
    const result = { message, run };
    hub.put('firstTaskRequest', { id: key, digest: fingerprint, result }); return copy(result);
  });
  const context = candidate => {
    const flow = firstTaskForRun(hub, candidate);
    if (!flow || flow.currentRunId !== candidate.id) return null;
    const confirmed = flow.confirmedProposal?.runId === candidate.id;
    return { flowId: flow.id, phase: confirmed ? 'saving' : candidate.firstTaskMode === 'followup' ? 'followup' : 'clarify', stage: flow.stage, confirmed, now: hub.now(), questions: copy(flow.questions), proposal: copy(flow.proposal), confirmedProposal: copy(flow.confirmedProposal), itemIds: [...flow.itemIds], savedItemId: flow.itemIds[0] || null, rules: 'Read xiaoman_journal list for the configured timezone and current date; do not infer them from the host OS. In followup, get savedItemId for current details. A read-only answer may finish with a completed report without ask/propose/save. Changes still require propose and explicit Web confirmation; never save before it. In saving, copy confirmedProposal.values exactly. Only record this plan; no booking, purchase, external messaging or device actions.' };
  };
  const recordRead = (run, item) => hub.transaction(() => {
    const flow = firstTaskForRun(hub, run);
    if (flow?.currentRunId === run.id && run.firstTaskMode === 'followup' && flow.itemIds.includes(item.id))
      hub.put(KIND, { ...flow, followupRead: { runId: run.id, itemId: item.id, itemVersion: item.version } });
  });
  return { action, snapshot, startGuide, continueGuide, guideSnapshot, context, recordRead, guardWrite: (run, args, input) => assertFirstTaskJournalWrite(hub, run, args, input), recordReceipt: (run, receipt, input) => recordFirstTaskReceipt(hub, run, receipt, input) };
}
