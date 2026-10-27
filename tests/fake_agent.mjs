#!/usr/bin/env node
// Offline protocol fixture. This executable never contacts a model or device.
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in (offline fixture)'); process.exit(0); }
const workbuddy = args.includes('-p');
const mode = process.env.PA_TEST_SCENARIO || 'success';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let session = 'thread-fixture';
const finish = () => {
  if (mode === 'exit') return process.exit(0);
  if (mode === 'invalid') return process.stdout.write('not-json\n');
  if (mode === 'hang') return;
  if (mode === 'auth' && workbuddy) return emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['401 Authentication required. Please sign in.'] });
  if (workbuddy) emit({ type: 'result', subtype: mode === 'failure' ? 'error_during_execution' : 'success',
    is_error: mode === 'failure', result: process.env.PA_TEST_REPLY || 'fixture reply', session_id: session });
  else {
    emit({ method: 'item/completed', params: { threadId: session, turnId: 'turn-fixture', item: { id: 'message', type: 'agentMessage', text: process.env.PA_TEST_REPLY || 'fixture reply', phase: 'final_answer' } } });
    emit({ method: 'turn/completed', params: { threadId: session, turn: { id: 'turn-fixture', status: mode === 'failure' ? 'failed' : 'completed', ...(process.env.PA_TEST_TURN_ERROR && { error: JSON.parse(process.env.PA_TEST_TURN_ERROR) }) } } });
  }
};
const approval = () => {
  if (workbuddy) emit({ type: 'control_request', request_id: 'permission-fixture', request: {
    subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'read local fixture' } } });
  else emit({ id: 'approval-fixture', method: 'item/commandExecution/requestApproval', params: {
    threadId: session, turnId: 'turn-fixture', itemId: 'command-fixture', command: 'read local fixture', cwd: process.cwd() } });
};
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const msg = JSON.parse(line);
  if (workbuddy) {
    if (msg.type === 'user') {
      if (mode === 'passive' && (args[args.indexOf('--tools') + 1] !== '' || !args.includes('--no-session-persistence'))) process.exit(5);
      const index = args.indexOf('--resume') >= 0 ? args.indexOf('--resume') : args.indexOf('--session-id');
      session = args[index + 1];
      emit({ type: 'system', subtype: 'init', session_id: session });
      if (mode === 'approval') approval(); else finish();
    }
    if (msg.type === 'control_response') {
      if (msg.response.request_id !== 'permission-fixture') process.exit(2);
      emit({ type: 'result', subtype: 'success', is_error: false,
        result: msg.response.response.allowed ? 'approved' : 'denied', session_id: session });
    }
    return;
  }
  if (msg.id === 'approval-fixture') {
    emit({ method: 'item/completed', params: { threadId: session, turnId: 'turn-fixture', item: { id: 'approval-result', type: 'agentMessage', text: msg.result.decision === 'accept' ? 'approved' : 'denied' } } });
    emit({ method: 'turn/completed', params: { threadId: session, turn: { id: 'turn-fixture', status: 'completed' } } });
    return;
  }
  if (msg.id === undefined) return;
  if (msg.id === 'source-fixture') {
    const result = JSON.parse(msg.result.contentItems[0].text);
    if (!msg.result.success || JSON.stringify(result.actions) !== '["list"]' || result.roots.length !== 0) return process.exit(9);
    finish();
    return;
  }
  let result = {};
  if (msg.method === 'config/read') result = { config: { mcp_servers: { inherited: { command: 'private-unexecuted' } } } };
  if (msg.method === 'account/read') result = { requiresOpenaiAuth: true, account: mode === 'auth' ? null : { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'fixture' } };
  if (msg.method === 'model/list') result = { data: [{ model: 'fixture-model', isDefault: true, hidden: false }], nextCursor: null };
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    if (msg.params.sandbox !== 'read-only' || msg.params.approvalPolicy !== (mode === 'passive' ? 'never' : 'untrusted') ||
        msg.params.config.mcp_servers.inherited.enabled !== false) process.exit(3);
    if (mode === 'passive' && (!msg.params.ephemeral || msg.params.config['features.shell_tool'] !== false || msg.params.config.web_search !== 'disabled')) process.exit(6);
    if (mode === 'routine' && (!msg.params.ephemeral || msg.params.config['features.shell_tool'] !== false || msg.params.config.web_search !== 'disabled' || msg.params.config.project_doc_max_bytes !== 0 || msg.params.config['features.multi_agent'] !== false || msg.params.config['features.apply_patch_freeform'] !== false)) process.exit(10);
    if (process.env.PA_TEST_REASONING_EFFORT && msg.params.config.model_reasoning_effort !== process.env.PA_TEST_REASONING_EFFORT) process.exit(7);
    if (!process.env.PA_TEST_REASONING_EFFORT && 'model_reasoning_effort' in msg.params.config) process.exit(8);
    session = msg.params.threadId || session;
    result = { thread: { id: session } };
  }
  if (msg.method === 'turn/start') {
    if (msg.params.sandboxPolicy.networkAccess !== false) process.exit(4);
    result = { turn: { id: 'turn-fixture' } };
  }
  emit({ id: msg.id, result });
  if (msg.method === 'turn/start') {
    if (mode === 'approval') approval();
    else if (mode === 'source-list') emit({ id: 'source-fixture', method: 'item/tool/call', params: { threadId: session, turnId: 'turn-fixture', callId: 'sources-fixture', tool: 'xiaoman_sources', arguments: { operation: 'list' } } });
    else finish();
  }
});
