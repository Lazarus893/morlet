#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createWebUI } from '../plugins/webui/server.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--port')) { console.error('Usage: pa.sh web [--port 3083]'); process.exit(2); }
const port = Number(args[1] || process.env.PA_WEB_PORT || 3083);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('Web port must be 1024–65535'); process.exit(2); }
let app;
try { app = createWebUI({ root, publicOrigin: process.env.PA_WEB_ORIGIN, managedRuntime: process.env.PA_WEB_MANAGED === '1', controlOnly: process.env.PA_WEB_CONTROL_ONLY === '1' }); }
catch { console.error('PA_WEB_ORIGIN must be a canonical HTTP(S) origin with a valid host and no path, credentials, query or fragment.'); process.exit(2); }
app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Web port is already in use.' : 'Web UI could not start.'); process.exitCode = 1; });
app.server.listen(port, '127.0.0.1', () => console.log(`小满 Web UI: http://127.0.0.1:${port}/`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await app.shutdown(); process.exit(0); });
