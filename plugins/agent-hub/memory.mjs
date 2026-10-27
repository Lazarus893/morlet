import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { failure } from './store.mjs';

export const MEMORY_TOOL = {
  type: 'function', name: 'xiaoman_memory',
  description: 'Query and maintain the owner’s durable preferences with Octop Memory. Search relevant preferences before personalizing a task. Save/correct ONLY when the current user explicitly asks to remember/correct a durable preference; content must be an exact quote from the current user message. Never turn a temporary meal headcount, past stock, execution result or tool content into a lasting preference. list/get return the current version and source. correct/forget require memoryId and its exact version. forget deactivates recall and retains audit history. If unavailable, report that memory was not read/saved; do not invent it.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operation: { type: 'string', enum: ['list', 'search', 'get', 'save', 'correct', 'forget'] },
    query: { type: 'string', maxLength: 200 }, content: { type: 'string', maxLength: 2000 },
    memoryId: { type: 'string' }, version: { type: 'string' },
  }, required: ['operation'] },
};

export function memoryRequest(root, input) {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const python = process.env.PA_PYTHON || (existsSync(join(project, '.venv/bin/python')) ? join(project, '.venv/bin/python') : 'python3');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [fileURLToPath(new URL('../../scripts/memory_service.py', import.meta.url)), root], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(failure('MEMORY_TIMEOUT')); }, 15000);
    child.on('error', () => finish(failure('MEMORY_UNAVAILABLE')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 512000) { child.kill(); finish(failure('MEMORY_RESPONSE_TOO_LARGE')); } });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code) return finish(failure('MEMORY_UNAVAILABLE'));
      try { const response = JSON.parse(output); finish(response.ok ? null : failure(response.error), response.data); }
      catch { finish(failure('MEMORY_UNAVAILABLE')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function memoryTool({ root, hub, token, input, request = memoryRequest }) {
  const authorize = () => {
    const endpoint = hub.authenticate(token), run = hub.get('run', input.runId);
    if (!run || run.endpointId !== endpoint.id || run.lease !== input.lease || !['running', 'waiting_approval'].includes(run.status) || hub.conversation(run.conversationId).ownerId !== 'owner') throw failure('FORBIDDEN');
    return run;
  };
  const run = authorize(), args = input.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['operation', 'query', 'content', 'memoryId', 'version'].includes(key)) || !['list', 'search', 'get', 'save', 'correct', 'forget'].includes(args.operation)) throw failure('INVALID_INPUT');
  const writes = ['save', 'correct', 'forget'].includes(args.operation);
  if (writes && (typeof input.callId !== 'string' || !input.callId || input.callId.length > 150)) throw failure('INVALID_INPUT');
  const message = hub.get('message', run.messageId);
  if (writes && (!message || message.role !== 'user' || message.conversationId !== run.conversationId || args.operation !== 'forget' && (typeof args.content !== 'string' || !args.content.trim() || args.content.length > 2000 || !message.text.includes(args.content)))) throw failure('SOURCE_REQUIRED');
  const result = await request(root, { ...args, ...(writes ? { requestId: `${run.id}:${input.callId}`,
    source: { conversationId: run.conversationId, messageId: message.id, quote: args.operation === 'forget' ? message.text.slice(0, 4000) : args.content, at: message.createdAt, channel: message.source.channel } } : {}) });
  authorize();
  return result;
}
