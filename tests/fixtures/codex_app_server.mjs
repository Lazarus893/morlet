#!/usr/bin/env node
// Native-protocol fixture: no model, tools, credentials or user sessions.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export function createHandler(send, disconnect) {
  let initialized = 0, nextThread = 0, nextTurn = 0;
  const approvals = new Map(), turns = new Map();
  const finish = (threadId, turnId, text, status = 'completed') => {
    if (text) send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'message-' + turnId, type: 'agentMessage', phase: 'final_answer', text } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
    turns.delete(threadId);
  };
  return message => {
    const { id, method, params: p = {} } = message;
    if (!method && approvals.has(id)) {
      const { threadId, turnId, mode } = approvals.get(id); approvals.delete(id);
      finish(threadId, turnId, mode + ':' + (message.result?.decision || JSON.stringify(message.result || message.error)));
      return;
    }
    if (id === undefined) return;
    if (method === 'initialize') { initialized++; send({ id, result: { userAgent: 'offline-native-fixture' } }); return; }
    if (method === 'config/read') { send({ id, result: { config: { mcp_servers: { inherited: {} } } } }); return; }
    if (method === 'thread/start' || method === 'thread/resume') {
      if (p.approvalPolicy !== (p.ephemeral ? 'never' : 'untrusted') || p.sandbox !== 'read-only' || p.config.mcp_servers.inherited.enabled !== false) throw new Error('Unsafe thread boundary');
      const threadId = p.threadId || 'thread-' + ++nextThread;
      send({ id, result: { thread: { id: threadId, status: { type: threadId === 'busy' ? 'active' : 'idle' } } } }); return;
    }
    if (method === 'turn/interrupt') {
      send({ id, result: {} });
      if (turns.get(p.threadId)?.mode !== 'ignore-interrupt') finish(p.threadId, p.turnId, '', 'interrupted');
      return;
    }
    if (method !== 'turn/start') { send({ id, result: {} }); return; }
    if (p.sandboxPolicy.type !== 'readOnly' || p.sandboxPolicy.networkAccess !== false || p.approvalsReviewer !== 'user') throw new Error('Unsafe turn boundary');
    const threadId = p.threadId, turnId = 'turn-' + ++nextTurn, mode = p.input[0].text;
    if (mode === 'rejected') { send({ id, error: { code: -32602, message: 'fixture rejection' } }); return; }
    turns.set(threadId, { turnId, mode });
    if (mode === 'start-lost') { disconnect(); return; }
    if (mode === 'stale-before-ack') {
      send({ id: 'stale-approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'previous-turn', itemId: 'old-command', command: 'stale request' } });
      finish(threadId, 'previous-turn', 'WRONG PREVIOUS TURN');
    }
    const start = () => {
      send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      if (mode === 'lost') { disconnect(); return; }
      if (['hang', 'slow-start', 'ignore-interrupt'].includes(mode)) return;
      if (mode.startsWith('approval')) {
        const approvalId = 'approval-' + turnId;
        approvals.set(approvalId, { threadId, turnId, mode });
        send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command', command: mode === 'approval-missing-detail' ? undefined : 'read fixture', cwd: '/fixture' } }); return;
      }
      if (mode === 'tool-waits') {
        send({ id: 'tool-' + turnId, method: 'item/tool/call', params: { threadId, turnId, tool: 'xiaoman_status', callId: 'fixture-call', arguments: {} } }); return;
      }
      if (mode === 'permissions') {
        const approvalId = 'approval-' + turnId;
        approvals.set(approvalId, { threadId, turnId, mode });
        send({ id: approvalId, method: 'item/permissions/requestApproval', params: { threadId, turnId, permissions: { network: { enabled: true } } } }); return;
      }
      // Another owner's final notification must never finish this run.
      finish('foreign-thread', 'foreign-turn', 'WRONG OWNER');
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message', delta: 'fixture progress' } });
      finish(threadId, turnId, JSON.stringify({ pid: process.pid, initialized, turns: nextTurn, threadId }));
    };
    if (mode === 'slow-start') setTimeout(start, 100); else start();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handler = createHandler(value => process.stdout.write(JSON.stringify(value) + '\n'), () => process.exit(0));
  createInterface({ input: process.stdin }).on('line', line => handler(JSON.parse(line)));
}
