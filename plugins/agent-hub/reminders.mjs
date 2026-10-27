import { getRuntime, manage } from '../webui/control.mjs';
import { failure } from './store.mjs';
import { requireAction, actionFingerprint } from './actions.mjs';

export const REMINDER_TOOL = { type: 'function', name: 'xiaoman_reminders', description: 'Manage the existing shared Weixin/Web reminder ledger. List first to obtain revision and task IDs. notifyAt is a future Unix millisecond timestamp; check now/timezone from list. Delivery obeys enabled, quiet hours, idle time and quotas; do not promise delivery when blocked. No binding means ask the user to bind Weixin in Web. Never claim success without a successful receipt.', inputSchema: {
  type: 'object', additionalProperties: false, properties: { operation: { type: 'string', enum: ['list', 'add', 'done', 'cancel', 'snooze', 'update'] }, revision: { type: 'integer' }, title: { type: 'string' }, notifyAt: { type: 'number' }, taskId: { type: 'string' }, minutes: { type: 'integer' } }, required: ['operation'],
} };

// Management of the existing ledger stays in its owning process. An uncertain
// transport outcome is never automatically replayed, including after a restart.
export async function reminderTool({ hub, root, read, rpc, token, input }) {
  const endpoint = hub.authenticate(token), run = hub.get('run', input.runId);
  if (!run || run.endpointId !== endpoint.id || run.lease !== input.lease || !['running', 'waiting_approval', 'uncertain'].includes(run.status)) throw failure('FORBIDDEN');
  const bindings = hub.all('binding').filter(b => b.channel === 'weixin' && b.conversationId === run.conversationId);
  const binding = bindings.find(b => b.peer === run.source.peer) || (bindings.length === 1 ? bindings[0] : null);
  if (!binding) throw failure('WEIXIN_BINDING_REQUIRED');
  const settings = await read();
  const snapshot = async () => {
    const runtime = await getRuntime(root, settings, rpc);
    const user = runtime.accounts.find(a => a.account === binding.account)?.users.find(u => u.id === binding.peer);
    if (!user) throw failure('USER_NOT_FOUND');
    return { ...user, now: Date.now(), timezone: user.preferences.timezone };
  };
  const args = input.arguments;
  if (args?.operation === 'list') return snapshot();
  if (!args || !['add', 'done', 'cancel', 'snooze', 'update'].includes(args.operation) || typeof input.callId !== 'string' || input.callId.length > 200) throw failure('INVALID_INPUT');
  const key = run.id + ':' + input.callId;
  const fingerprint = actionFingerprint('xiaoman_reminders', args);
  const old = hub.get('effect', key);
  if (old) { if (old.fingerprint !== fingerprint) throw failure('CONFLICT'); if (old.state === 'done') return old.result; throw failure(old.error || 'EXECUTION_UNCERTAIN'); }
  if (args.operation === 'cancel') {
    const current = await snapshot();
    const gate = requireAction(hub, { run: hub.get('run', run.id), tool: 'xiaoman_reminders', parameters: args, callId: input.callId, approvalId: input.approvalId, title: current.tasks?.find(t => t.id === args.taskId)?.title });
    if (gate) return gate;
  }
  hub.transaction(() => { if (hub.get('effect', key)) throw failure('EXECUTION_UNCERTAIN'); hub.put('effect', { id: key, fingerprint, state: 'pending' }); });
  try {
    if (!['running', 'waiting_approval', 'uncertain'].includes(hub.get('run', run.id)?.status)) throw failure('FORBIDDEN');
    await manage(root, settings, { operation: args.operation, revision: args.revision, title: args.title, notifyAt: args.notifyAt, taskId: args.taskId, minutes: args.minutes, account: binding.account, userId: binding.peer }, rpc);
    const result = { saved: true, snapshot: await snapshot() };
    hub.put('effect', { id: key, fingerprint, state: 'done', result }); return result;
  } catch (e) { hub.put('effect', { id: key, fingerprint, state: 'uncertain', error: e.code || 'EXECUTION_UNCERTAIN' }); throw e; }
}
