import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

/** A per-turn capability: MCP children never receive the endpoint's pairing token. */
export async function createToolRelay(callTool, tools) {
  const secret = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    const reply = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const token = req.headers['x-pa-tool-token'];
    if (req.method !== 'POST' || req.url !== '/tool' || req.headers.host !== `127.0.0.1:${server.address()?.port}` || req.headers.origin || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(secret))) return reply(403, { error: 'FORBIDDEN' });
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) return reply(413, { error: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks));
      if (input.operation === 'list') return reply(200, { tools: tools.map(({ type, ...tool }) => tool) });
      if (!tools.some(t => t.name === input.name) || typeof input.callId !== 'string') return reply(400, { error: 'INVALID_INPUT' });
      reply(200, { result: await callTool(input.name, input.arguments, input.callId) });
    } catch (error) { reply(400, { error: /^[A-Z_]+$/.test(error.code) ? error.code : 'TOOL_FAILED' }); }
  });
  server.requestTimeout = 20000; server.headersTimeout = 5000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    mcpServers: { xiaoman: { command: process.execPath, args: [fileURLToPath(new URL('../../scripts/agent-task-mcp.mjs', import.meta.url))], env: { PA_TOOL_URL: `http://127.0.0.1:${server.address().port}/tool`, PA_TOOL_TOKEN: secret } } },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
