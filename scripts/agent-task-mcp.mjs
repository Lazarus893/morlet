#!/usr/bin/env node
// Private MCP stdio adapter. Stdout is protocol-only; no account token is present.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const callPrefix = randomUUID();
const url = new URL(process.env.PA_TOOL_URL);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/tool') throw new Error('INVALID_RELAY');
async function relay(input) {
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', 'X-PA-Tool-Token': process.env.PA_TOOL_TOKEN }, body: JSON.stringify(input) });
  const value = await response.json(); if (!response.ok || value.error) throw new Error(value.error || 'TOOL_FAILED'); return value;
}
const emit = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.length > 65536) break;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  if (msg.id === undefined) continue;
  try {
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'xiaoman-tasks', version: '1.0.0' } };
    else if (msg.method === 'ping') result = {};
    else if (msg.method === 'tools/list') result = await relay({ operation: 'list' });
    else if (msg.method === 'tools/call') {
      try { const value = await relay({ name: msg.params.name, arguments: msg.params.arguments, callId: callPrefix + ':' + String(msg.id) }); result = { content: [{ type: 'text', text: JSON.stringify(value.result) }] }; }
      catch (e) { result = { content: [{ type: 'text', text: /^[A-Z_]+$/.test(e.message) ? e.message : 'TOOL_FAILED' }], isError: true }; }
    } else { emit({ id: msg.id, error: { code: -32601, message: 'Method not supported' } }); continue; }
    emit({ id: msg.id, result });
  } catch { emit({ id: msg.id, error: { code: -32603, message: 'Tool relay unavailable' } }); }
}
