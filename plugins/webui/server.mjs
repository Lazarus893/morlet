import { memoryTool } from '../agent-hub/memory.mjs';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir, open, lstat, rename, unlink, realpath } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { control, getRuntime, manage } from './control.mjs';
import { failure } from '../proactive/management.mjs';
import { createJournalControl } from './journal-control.mjs';
import { createConnectionManager } from '../connections/manager.mjs';
import { loadNangoConfig } from '../connections/nango.mjs';
import { createCloudConnections } from '../connections/cloud.mjs';
import { createRemoteControl } from './remote-control.mjs';
import { hubConfig } from '../agent-hub/config.mjs';
import { AgentHub } from '../agent-hub/store.mjs';
import { reminderTool } from '../agent-hub/reminders.mjs';
import { statusTool, statusSnapshot } from '../agent-hub/status.mjs';
import { journalTool } from '../agent-hub/journal.mjs';
import { sourceInventory } from '../agent-hub/sources.mjs';
import { sourceBridgeInventory } from '../agent-hub/source-bridge.mjs';
import { routedSourcesTool as sourcesTool, sourceBridgeRPC } from '../agent-hub/source-bridge.mjs';
import { createFirstTaskFlow, firstTaskTool } from '../agent-hub/first-task.mjs';
import { createRoutineController, routineTool } from '../agent-hub/routines.mjs';
import { syncRoutineNotices, routineNoticeSnapshot } from '../proactive/routine-notices.mjs';
import { createFollowupSuggestions } from '../proactive/followup-suggestions.mjs';
import { assertRoutineToolAccess } from '../agent-hub/actions.mjs';
import { HubChannel } from '../agent-hub/channel.mjs';
import { reachOutSnapshot, configureReachOut } from '../proactive/reach-out.mjs';
import { personalNoticeSnapshot, managePersonalNotices, personalChannelPoll, personalNoticeContext } from '../proactive/personal-notices.mjs';
import { createAutomaticContent } from '../proactive/automatic-content.mjs';
import { noticeWorkerBridge } from '../proactive/notice-worker-bridge.mjs';
import { createCloudNoticeBridge } from '../proactive/cloud-notice-bridge.mjs';
import { createLocalAgentSetup } from './local-agent-setup.mjs';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const execute = promisify(execFile);
const privateFile = info => info.isFile() && (info.mode & 0o777) === 0o600 && (!process.getuid || info.uid === process.getuid());

async function runtimeProcessOwned(root, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    const base = await realpath(root);
    const port = Number(process.env.XIAOMAN_PORT || 3082);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
    const { stdout } = await execute('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'command='], { timeout: 5000, maxBuffer: 16384 });
    const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) !== process.getuid()) return false;
    const executables = new Set(['node', process.execPath, await realpath(process.execPath)]);
    const scripts = [join(base, 'node_modules/.bin/dsh'), join(base, 'node_modules/@deepseek-ai/dsh/lib/bin.js')];
    const dsh = [...executables].some(node => scripts.some(script => match[2] === `${node} ${script} --profile wx-life --no-open --port ${port}`));
    const launcher = ['bash', '/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash'].some(shell => match[2] === `${shell} ${join(base, 'scripts/pa.sh')} start`);
    if (!dsh && !launcher) return false;
    const expected = [join(base, '.runtime/workspace'), ...(launcher ? [base] : [])];
    if (process.platform === 'linux') return expected.includes(await realpath(`/proc/${pid}/cwd`));
    if (process.platform !== 'darwin') return false;
    const cwd = await execute('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000, maxBuffer: 16384 });
    const directories = cwd.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    return directories.length === 1 && expected.includes(directories[0]);
  } catch { return false; }
}
async function runtimeHostOwned(root, settings, runtime) {
  if (runtime.protocol !== 1 || runtime.state !== 'running' || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 1) return false;
  try {
    const base = await realpath(root), identity = createHash('sha256').update(base).digest('hex').slice(0, 12);
    if (settings.socket !== `/tmp/xiaoman-${process.getuid()}-${identity}.sock`) return false;
    const socket = await lstat(settings.socket);
    return socket.isSocket() && socket.uid === process.getuid() && !(socket.mode & 0o077) && await runtimeProcessOwned(root, runtime.pid);
  } catch { return false; }
}

function validatePublicOrigin(value) {
  if (value === undefined) return undefined;
  const invalid = () => { throw new Error('Public origin must be a canonical HTTP(S) origin with a valid host and no path, credentials, query or fragment.'); };
  if (typeof value !== 'string' || !value) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid();
  const hostname = url.hostname;
  const ip = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const domain = hostname.length <= 253 && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (!isIP(ip) && !domain) invalid();
  return { origin: url.origin, host: url.host, secure: url.protocol === 'https:' };
}

export function python(root, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PA_PYTHON || 'python3', [join(root, 'scripts/web_config.py')], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(failure('CONFIG_TIMEOUT')); }, 45000);
    child.on('error', () => finish(failure('CONFIG_UNAVAILABLE')));
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) { child.kill(); finish(failure('RESPONSE_TOO_LARGE')); } });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code) return finish(failure('CONFIG_UNAVAILABLE'));
      try { const result = JSON.parse(output); if (!result.ok) return finish(failure(result.error)); finish(null, result.data); }
      catch { finish(failure('CONFIG_UNAVAILABLE')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
export function qrImage(url) {
  if (typeof url !== 'string' || url.length > 4096 || !/^https?:\/\//.test(url)) throw failure('LOGIN_FAILED');
  const code = new QRCode(-1, level.L); code.addData(url); code.make();
  const size = code.getModuleCount(); const dots = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (code.isDark(y, x)) dots.push(`M${x + 4},${y + 4}h1v1h-1z`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 8} ${size + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${dots.join('')}" fill="black"/></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
async function body(req, maxBytes = 65536) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure('INVALID_INPUT');
  const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw failure('BODY_TOO_LARGE'); chunks.push(chunk); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw 0; return data; }
  catch { throw failure('INVALID_INPUT'); }
}
export function createWebUI({ root, helper = request => python(root, request), rpc = control, launch, journalRuntimeFactory, publicOrigin, localAgentSetup, managedRuntime = false, controlOnly = false, runtimeSupervisor = {} } = {}) {
  const published = validatePublicOrigin(publicOrigin);
  const session = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  let owned, adoptedPid, adoptedVerified = false, intentionalExit, processState = 'stopped', processExit = null, operationBusy = false, operationTask, closing = false, monitorTimer, monitorTask, launchedAt = 0, healthySince = null;
  const { now = Date.now, intervalMs = 2000, backoffMs = 1000, maxBackoffMs = 60000, startupTimeoutMs = 30000, verifyHost = runtimeHostOwned, verifyProcess = runtimeProcessOwned } = runtimeSupervisor;
  if ((controlOnly && !managedRuntime) || ![intervalMs, backoffMs, maxBackoffMs, startupTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0) || typeof now !== 'function' || typeof verifyHost !== 'function' || typeof verifyProcess !== 'function') throw failure('INVALID_CONFIGURATION');
  const service = { managed: Boolean(managedRuntime), controlOnly: Boolean(controlOnly), desired: managedRuntime ? 'running' : 'unknown', health: controlOnly ? 'paused' : managedRuntime ? 'starting' : 'unmanaged', error: null, retryAt: null, failures: 0 };
  const intentPath = join(root, '.runtime/web-service.json'); let intentGeneration = 0;
  const intent = async () => {
    let handle; const generation = intentGeneration;
    try {
      handle = await open(intentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!privateFile(info) || info.size > 4096) throw failure('RUNTIME_INTENT_INVALID');
      const bytes = await handle.readFile();
      if (bytes.length > 4096) throw failure('RUNTIME_INTENT_INVALID');
      const value = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || value.version !== 1 || !['running', 'stopped'].includes(value.desired)) throw failure('RUNTIME_INTENT_INVALID');
      if (generation === intentGeneration) service.desired = value.desired; return true;
    } catch (error) {
      if (generation !== intentGeneration) return false;
      if (error.code === 'ENOENT') { service.desired = managedRuntime ? 'running' : 'unknown'; return true; }
      service.desired = 'unknown'; service.health = 'blocked'; service.error = 'RUNTIME_INTENT_INVALID'; service.retryAt = null; return false;
    } finally { await handle?.close(); }
  };
  const recordIntent = async desired => {
    intentGeneration++;
    let handle; const temporary = `${intentPath}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      try { if (!privateFile(await lstat(intentPath))) throw failure('RUNTIME_INTENT_INVALID'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(join(root, '.runtime'), { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ version: 1, desired }) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, intentPath);
      intentGeneration++;
      service.desired = desired; service.error = null; service.retryAt = null; service.failures = 0; healthySince = null;
    } catch { intentGeneration++; service.desired = 'unknown'; service.health = 'blocked'; service.error = 'RUNTIME_INTENT_INVALID'; throw failure('RUNTIME_INTENT_INVALID'); }
    finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
  };
  const failed = error => {
    if (closing || service.desired !== 'running') return;
    service.failures++; service.health = 'backoff'; service.error = /^[A-Z_]{3,60}$/.test(error) ? error : 'RUNTIME_UNAVAILABLE';
    service.retryAt = now() + Math.min(maxBackoffMs, backoffMs * 2 ** Math.min(20, service.failures - 1)); healthySince = null;
  };
  const hostPath = join(root, '.runtime/web-host.json');
  async function hostRecord(pid) {
    let handle, temporary;
    try {
      if (pid === undefined) {
        try { handle = await open(hostPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        const info = await handle.stat(); if (!privateFile(info) || info.size > 4096) throw failure('HOST_RECORD_INVALID');
        const bytes = await handle.readFile(); if (bytes.length > 4096) throw failure('HOST_RECORD_INVALID');
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 1) throw failure('HOST_RECORD_INVALID');
        return value.pid;
      }
      try { if (!privateFile(await lstat(hostPath))) throw failure('HOST_RECORD_INVALID'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      temporary = `${hostPath}.${randomBytes(12).toString('hex')}.tmp`;
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ version: 1, pid }) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, hostPath);
    } catch { throw failure('HOST_RECORD_INVALID'); }
    finally { await handle?.close(); if (temporary) await unlink(temporary).catch(() => {}); }
  }
  async function recordedHostPending() {
    if (!managedRuntime) return false;
    const pid = await hostRecord(); if (pid === null) return false;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw failure('HOST_NOT_VERIFIED'); }
    if (!await verifyProcess(root, pid)) throw failure('HOST_NOT_VERIFIED');
    adoptedPid = pid; adoptedVerified = false;
    return true;
  }
  async function stopRecordedHost() {
    const pid = await hostRecord(); if (pid === null) return { accepted: true };
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return { accepted: true }; throw failure('HOST_NOT_VERIFIED'); }
    if (!await verifyProcess(root, pid) || await hostRecord() !== pid || !await verifyProcess(root, pid)) throw failure('HOST_NOT_VERIFIED');
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw failure('RUNTIME_STOP_FAILED'); }
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { adoptedPid = undefined; adoptedVerified = false; processState = 'stopped'; return { accepted: true }; } throw failure('RUNTIME_STOP_FAILED'); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw failure('RUNTIME_STOP_TIMEOUT');
  }
  let login = null, loginGeneration = 0; const loginAbort = new AbortController();
  const read = () => helper({ action: 'read' });
  let firstTasks;
  const journal = createJournalControl({ root, rpc, readSettings: read, guideReport: snapshot => firstTasks?.guideSnapshot(snapshot), conversationReports: () => {
    const reports = new Map();
    for (const run of hub.snapshot().runs) {
      if (!run.journalItemId) continue;
      // Background progress and failures belong to the patrol status. Only a
      // published result may change the notebook's retained answer or files.
      if (run.routine && !run.routinePublished) continue;
      const previous = reports.get(run.journalItemId);
      const title = run.report?.title;
      const chapterTitle = previous?.chapterTitle || (title && Array.from(title).length <= 60 && !/[\r\n]/.test(title) ? title : null);
      const artifacts = [...new Map([...(previous?.artifacts || []), ...(run.report?.artifacts || []).map(a => ({ ...a, endpointId: run.endpointId }))].map(a => [a.url || a.endpointId + ':' + a.path, a])).values()];
      reports.set(run.journalItemId, { chapterTitle, artifacts, conversationId: run.conversationId, stage: run.status,
        isBusy: ['queued', 'running', 'waiting_approval', 'uncertain', 'cancelling'].includes(run.status),
        answer: run.report?.summary || previous?.answer || null,
        answerAt: run.report?.summary ? run.report.updatedAt || run.finishedAt || null : previous?.answerAt || null,
        run, reason: run.error || null });
    }
    return reports;
  }, ...(journalRuntimeFactory ? { runtimeFactory: journalRuntimeFactory } : {}) });
  let nangoConfig, nangoError;
  try { nangoConfig = loadNangoConfig(root); }
  catch (error) { nangoError = /^NANGO_[A-Z_]+$/.test(error.code) ? error.code : 'NANGO_CONFIG_UNAVAILABLE'; }
  const connections = createConnectionManager({ root, cloudServices: Object.keys(nangoConfig?.integrations || {}).filter(id => ['google', 'github', 'x'].includes(id)) });
  const cloud = createCloudConnections({ config: nangoConfig, manager: connections });
  const remote = createRemoteControl({ root });
  const connectionSnapshot = async (refresh = true) => {
    // A slow provider must not hide other connections or their recovery actions.
    if (refresh) void cloud.refresh().catch(() => {});
    return { ...connections.snapshot(), remote: await remote.snapshot(), routines: routines.snapshot().routines.map(({ id, title, journalItemId, connectionIds, scopeSummary, scopeStatus, enabled, endedAt }) => ({ id, title, journalItemId, connectionIds, scopeSummary, scopeStatus, enabled, endedAt })),
      ...(nangoError && { integrationError: { service: 'nango', code: nangoError } }) };
  };
  const cloudTimer = setInterval(() => { void cloud.refresh().catch(() => {}); }, 60000); cloudTimer.unref();
  service.instanceId = createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 20);
  const hub = new AgentHub(root);
  const routines = createRoutineController({ hub, journal, read });
  const followupSuggestions = createFollowupSuggestions({ hub, journal, routines });
  const syncNotices = () => syncRoutineNotices(hub, { baseUrl: published?.origin });
  let routineTimer, routineTick, routineError = null;
  const routineSnapshot = async () => ({ ...await routines.action({ operation: 'list' }), notifications: routineNoticeSnapshot(hub), ...(routineError && { error: routineError }) });
  const enrichJournalSnapshot = async data => {
    if (data.scope?.account !== 'local' || data.scope?.userId !== 'owner') return { ...data, routines: [], followupSuggestions: [] };
    return { ...data, routines: (await routineSnapshot()).routines, routineNotices: routineNoticeSnapshot(hub), followupSuggestions: followupSuggestions.snapshot().suggestions, ...(routineError && { routinesError: routineError }) };
  };
  const journalSnapshot = async (...args) => enrichJournalSnapshot(await journal.snapshot(...args));
  const checkRoutines = () => {
    if (closing || routineTick) return;
    routineTick = Promise.resolve().then(() => routines.tick()).then(() => { syncNotices(); routineError = null; }, error => {
      routineError = /^[A-Z_]{3,80}$/.test(error?.code) ? error.code : 'ROUTINE_SCHEDULER_UNAVAILABLE';
    }).finally(() => { routineTick = null; });
  };
  const automaticContent = createAutomaticContent({ hub, journal });
  const cloudNotice = createCloudNoticeBridge({ config: nangoConfig, manager: connections, hub, automaticContent });
  firstTasks = createFirstTaskFlow({ hub });
  const firstTaskSnapshot = async flowId => firstTasks.snapshot({ ...(flowId ? { flowId } : {}), journal: await journal.snapshot({ account: 'local', userId: 'owner' }, await read()) });
  const setupLocalAgent = localAgentSetup || createLocalAgentSetup({ root, hub });
  const localAgentAvailable = !published && process.platform === 'darwin';
  const state = async () => {
    await intent();
    const settings = await read();
    const runtime = await getRuntime(root, settings, rpc);
    const { socket, ...safe } = settings;
    return { ...safe, localAgentAvailable, agentRouting: hubConfig(root).roles, personalNotices: personalNoticeSnapshot(hub), truth: await statusSnapshot({ hub, root, settings, runtime }), service: { ...service }, runtime: { ...runtime, managed: Boolean(managedRuntime), owned: !!owned, adopted: adoptedPid === runtime.pid && !!adoptedPid, processState, processExit }, journal: await journalSnapshot(undefined, settings, runtime), login, csrf };
  };
  const exclusive = async fn => {
    if (operationBusy) throw failure('BUSY'); operationBusy = true;
    const task = operationTask = Promise.resolve().then(fn);
    try { return await task; } finally { operationBusy = false; if (operationTask === task) operationTask = undefined; }
  };
  async function startRuntime() {
    const settings = await read();
    const runtime = await getRuntime(root, settings, rpc);
    if (runtime.state === 'running' && managedRuntime) {
      if (owned && runtime.pid !== owned.pid) throw failure('HOST_NOT_VERIFIED');
      if (!owned && !await verifyHost(root, settings, runtime)) throw failure('HOST_NOT_VERIFIED');
      if (!owned) { await hostRecord(runtime.pid); adoptedPid = runtime.pid; adoptedVerified = true; }
      service.health = 'running'; service.error = null; service.retryAt = null;
      return { accepted: true, adopted: !owned };
    }
    if (owned && managedRuntime && runtime.state === 'offline') { service.health = 'starting'; return { accepted: true, starting: true }; }
    if (owned || runtime.state !== 'offline') throw failure(runtime.state === 'unavailable' ? 'RUNTIME_UNAVAILABLE' : 'ALREADY_RUNNING');
    if (await recordedHostPending()) throw failure('RUNTIME_CONTROL_UNAVAILABLE');
    if (!settings.runtimeInstalled || !settings.installed) throw failure('DEPENDENCIES_MISSING');
    processState = 'starting'; processExit = null; adoptedPid = undefined; adoptedVerified = false; intentionalExit = undefined; launchedAt = now(); service.health = managedRuntime ? 'starting' : 'unmanaged';
    if (launch) owned = await launch();
    else {
      await mkdir(join(root, '.runtime/logs'), { recursive: true, mode: 0o700 });
      const log = await open(join(root, '.runtime/logs/web-launch.log'), 'a', 0o600);
      try { owned = spawn(join(root, 'scripts/pa.sh'), ['start'], { cwd: root, stdio: ['ignore', log.fd, log.fd], detached: true }); }
      finally { void log.close(); }
    }
    const child = owned;
    if (child.pid) processState = 'running';
    child.once('spawn', () => { if (owned === child) processState = 'running'; });
    child.once('error', () => { if (owned === child) { owned = undefined; processState = 'failed'; if (managedRuntime) failed('RUNTIME_START_FAILED'); } });
    child.once('exit', (code, signal) => { if (owned === child) { owned = undefined; processState = signal === 'SIGTERM' || code === 0 ? 'stopped' : 'failed'; processExit = code; if (managedRuntime && intentionalExit !== child) failed('RUNTIME_EXITED'); } });
    if (managedRuntime && child.pid) {
      try { await hostRecord(child.pid); }
      catch (error) { if (owned === child) await stopRuntime(); throw error; }
    }
    return { accepted: true };
  }
  async function stopRuntime() {
    if (!owned) {
      if (!managedRuntime) throw failure('NOT_OWNED');
      const settings = await read(), runtime = await getRuntime(root, settings, rpc);
      if (runtime.state === 'offline') return stopRecordedHost();
      if (!await verifyHost(root, settings, runtime)) throw failure('HOST_NOT_VERIFIED');
      const current = await getRuntime(root, settings, rpc);
      if (current.state === 'offline') return { accepted: true };
      if (current.pid !== runtime.pid || !await verifyHost(root, settings, current)) throw failure('HOST_NOT_VERIFIED');
      try { process.kill(current.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw failure('RUNTIME_STOP_FAILED'); }
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await getRuntime(root, settings, rpc)).state === 'offline') { adoptedPid = undefined; processState = 'stopped'; return { accepted: true }; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw failure('RUNTIME_STOP_TIMEOUT');
    }
    const child = owned; intentionalExit = child; processState = 'stopping';
    const signal = name => { if (owned === child && child.pid) { try { process.kill(-child.pid, name); } catch { child.kill(name); } } };
    await new Promise(resolve => { const timer = setTimeout(() => { signal('SIGKILL'); resolve(); }, 10000); child.once('exit', () => { clearTimeout(timer); resolve(); }); signal('SIGTERM'); });
    return { accepted: true };
  }
  async function start() { if (controlOnly) throw failure('RUNTIME_CONTROL_ONLY'); await recordIntent('running'); try { return await startRuntime(); } catch (error) { if (managedRuntime) failed(error.code); throw error; } }
  async function stop() {
    await recordIntent('stopped');
    try { const result = await stopRuntime(); service.health = managedRuntime ? 'paused' : 'unmanaged'; return result; }
    catch (error) { service.health = 'blocked'; service.error = error.code || 'RUNTIME_STOP_FAILED'; throw error; }
  }
  function monitor() {
    if (!managedRuntime || controlOnly || closing) return;
    if (monitorTask) return monitorTask;
    if (operationBusy) return;
    return monitorTask = (async () => { try {
      await exclusive(async () => {
        if (closing || !await intent()) return;
        if (service.desired !== 'running') { if (!service.error) service.health = 'paused'; return; }
        if (service.retryAt !== null && now() < service.retryAt) return;
        const settings = await read(), runtime = await getRuntime(root, settings, rpc);
        if (runtime.state === 'running') {
          if (owned && runtime.pid !== owned.pid) throw failure('HOST_NOT_VERIFIED');
          if (!owned && (!adoptedVerified || adoptedPid !== runtime.pid) && !await verifyHost(root, settings, runtime)) throw failure('HOST_NOT_VERIFIED');
          if (!owned && (!adoptedVerified || adoptedPid !== runtime.pid)) { await hostRecord(runtime.pid); adoptedPid = runtime.pid; adoptedVerified = true; }
          service.health = 'running'; service.error = null; service.retryAt = null;
          if (healthySince === null) healthySince = now();
          if (now() - healthySince >= 30000) service.failures = 0;
        } else if (runtime.state === 'unavailable') throw failure('RUNTIME_UNAVAILABLE');
        else if (adoptedPid) {
          try { process.kill(adoptedPid, 0); throw failure('RUNTIME_CONTROL_UNAVAILABLE'); }
          catch (error) { if (error.code !== 'ESRCH') throw failure('RUNTIME_CONTROL_UNAVAILABLE'); }
          adoptedPid = undefined; processState = 'failed'; throw failure('RUNTIME_EXITED');
        }
        else if (owned) {
          if (now() - launchedAt >= startupTimeoutMs) throw failure('RUNTIME_START_TIMEOUT');
          service.health = 'starting';
        } else await startRuntime();
      });
    } catch (error) { if (error.code !== 'BUSY') failed(error.code); }
    finally { monitorTask = undefined; } })();
  }
  async function loginStart() {
    const settings = await read();
    if (settings.config.im.provider !== 'weixin') throw failure('IM_DISABLED');
    if (login?.state === 'waiting') return { accepted: true };
    const result = await rpc(settings.socket, { command: 'login' }, 20000);
    if (result.kind !== 'qr' || !result.loginId) throw failure('LOGIN_FAILED');
    const generation = ++loginGeneration;
    login = { state: 'waiting', qr: qrImage(result.url), createdAt: Date.now() };
    // The result of this exact login is authoritative; an older connected account is not.
    void rpc(settings.socket, { command: 'wait-login', loginId: result.loginId }, 300000, loginAbort.signal).then(result => {
      if (generation === loginGeneration) login = { state: result.kind === 'connected' ? 'connected' : 'failed' };
    }, () => { if (generation === loginGeneration) login = { state: 'failed' }; });
    return { accepted: true };
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // react-lang 1.0.1 always injects this fixed openui-spin keyframe rule,
    // including with a custom queryLoader. Allow only that exact CSS, not
    // arbitrary inline styles; the UI theme remains an external local file.
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'sha256-vai9tBS1dbqDlLt2vYYQwJl16j1hMfOCO5KhCK8LRBg='; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = server.address()?.port, origin = published?.origin || `http://127.0.0.1:${port}`;
    const host = published?.host || `127.0.0.1:${port}`;
    // Cookies share a host across ports. Keep independent local instances from
    // replacing each other's page session when both are open in one browser.
    const sessionName = `pa_session_${port}`;
    const respond = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== host || req.headers['sec-fetch-site'] === 'cross-site') throw failure('FORBIDDEN');
      const path = req.url?.split('?')[0];
      if (req.method === 'GET' && ['/', '/app.js', '/transport.js', '/style.css', '/onboarding.js', '/onboarding.css', '/first-task.js', '/first-task.css', '/journal.js', '/journal-index.js', '/routines-ui.js', '/journal.css', '/journal-notebook.css', '/journal-widgets.js', '/journal-widgets.css', '/journal-surfaces.js', '/journal-surfaces.css', '/journal-webawesome.js', '/journal-webawesome.css', '/motion.js', '/connections.js', '/connections.css', '/remote.js', '/remote.css', '/chat.js', '/chat.css', '/truth.js'].includes(path)) {
        if (path === '/') res.setHeader('Set-Cookie', `${sessionName}=${session}; HttpOnly; SameSite=Strict; Path=/${published?.secure ? '; Secure' : ''}`);
        const name = path === '/' ? 'index.html' : path.slice(1);
        const asset = await readFile(join(publicDir, name));
        res.writeHead(200, { 'Content-Type': (name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html') + '; charset=utf-8' });
        res.end(asset); return;
      }
      // The Mac companion has its own narrow credential; it cannot authorize other APIs.
      if (path === '/api/personal-notice-bridge' && req.method === 'POST') {
        const input = await body(req);
        const paired = connections.bridgeSnapshot(req.headers['x-pa-bridge-token']);
        if (['cloud-collect', 'cloud-mail'].includes(input.operation)) return respond(200, { ok: true, data: await cloudNotice(input, { ...connections.snapshot(), desired: paired.desired }, { authorize: () => connections.bridgeSnapshot(req.headers['x-pa-bridge-token']) }) });
        return respond(200, { ok: true, data: noticeWorkerBridge(hub, { ...connections.snapshot(), desired: paired.desired }, input, automaticContent) });
      }
      if (path === '/api/connections/bridge' && req.method === 'GET') {
        return respond(200, { ok: true, data: connections.bridgeSnapshot(req.headers['x-pa-bridge-token']) });
      }
      if (path === '/api/connections/bridge/report' && req.method === 'POST') {
        return respond(200, { ok: true, data: connections.reportBridge(req.headers['x-pa-bridge-token'], await body(req)) });
      }
      if (req.method === 'POST' && ['/api/agent-bridge/source-poll', '/api/agent-bridge/source-check', '/api/agent-bridge/source-result'].includes(path)) {
        const result = sourceBridgeRPC(hub, req.headers['x-pa-agent-token'], path.split('/').at(-1), await body(req, path.endsWith('/source-result') ? 520000 : 65536));
        return respond(200, { ok: true, data: result });
      }
      if (req.method === 'POST' && ['/api/agent-bridge/poll', '/api/agent-bridge/event', '/api/agent-bridge/tool'].includes(path)) {
        const input = await body(req), token = req.headers['x-pa-agent-token'];
        const operation = path.split('/').at(-1);
        if (operation === 'tool') {
          const run = hub.get('run', input.runId);
          if (run?.firstTaskId && ['xiaoman_tasks', 'xiaoman_reminders', 'xiaoman_routines'].includes(input.tool)) throw failure('FORBIDDEN');
          assertRoutineToolAccess(run, input.tool, input.arguments);
        }
        const handler = operation === 'tool' && (input.tool === 'xiaoman_memory' ? memoryTool : input.tool === 'xiaoman_status' ? statusTool : input.tool === 'xiaoman_reminders' ? reminderTool : input.tool === 'xiaoman_journal' ? journalTool : input.tool === 'xiaoman_first_task' ? firstTaskTool : input.tool === 'xiaoman_sources' ? sourcesTool : input.tool === 'xiaoman_routines' ? routineTool : null);
        const result = handler ? await handler({ hub, journal, firstTasks, routines, root, read, rpc, token, input }) : hub[operation](token, input);
        if (operation === 'poll' && result.job?.firstTaskId) {
          const settings = await read();
          result.job.firstTask = { ...firstTasks.context(result.job), timezone: settings.config.proactive?.timezone && settings.config.proactive.timezone !== 'local' ? settings.config.proactive.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone };
        }
        return respond(200, { ok: true, data: result });
      }
      if (req.method === 'POST' && ['/api/message-bridge/poll', '/api/message-bridge/inbound', '/api/message-bridge/ack', '/api/message-bridge/status', '/api/message-bridge/context'].includes(path)) {
        const input = await body(req), token = req.headers['x-pa-channel-token'];
        const channel = hub.authenticateChannel(token);
        let result;
        if (path.endsWith('/poll')) result = personalChannelPoll(hub, token);
        else if (path.endsWith('/ack')) result = hub.channelAck(token, input);
        else if (path.endsWith('/status')) result = hub.channelStatus(token, input);
        else if (path.endsWith('/context')) {
          if (channel.channel !== 'desktop-pet' || !channel.chatEnabled || input.peer !== channel.peer || Object.keys(input).some(k => k !== 'peer')) throw failure('FORBIDDEN');
          result = { context: personalNoticeContext(hub, channel.id) };
        }
        else {
          if (channel.channel !== 'imessage' && !(channel.channel === 'desktop-pet' && channel.chatEnabled)) throw failure('FORBIDDEN');
          if (input.peer !== channel.peer || typeof input.requestId !== 'string' || input.requestId.length > 256 || typeof input.text !== 'string' || input.text.length > 16000) throw failure('INVALID_INPUT');
          if (channel.channel === 'desktop-pet') {
            if (Object.keys(input).some(k => !['peer', 'requestId', 'text', 'replyTo', 'entryId', 'reaction'].includes(k)) || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId) || !input.text.trim() || input.text.length > 2000 || input.replyTo !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(input.replyTo) || input.entryId !== undefined && !/^[a-f0-9]{64}$/.test(input.entryId) || input.reaction !== undefined && !['useful', 'less', 'not_interested', 'clear'].includes(input.reaction)) throw failure('INVALID_INPUT');
            const id = createHash('sha256').update(JSON.stringify([channel.id, input.requestId])).digest('hex');
            const fingerprint = createHash('sha256').update(JSON.stringify([input.text, input.replyTo, input.entryId, input.reaction])).digest('hex');
            const previous = hub.get('petInput', id);
            if (previous && previous.fingerprint !== fingerprint) throw failure('CONFLICT');
            if (!previous) hub.put('petInput', { id, fingerprint, at: hub.now() });
          }
          const router = new HubChannel({ root, channel: channel.channel, account: channel.id, allowed: p => p === channel.peer, autoFlush: false });
          try { result = { accepted: await router.receive(input) }; } finally { await router.close(); }
        }
        return respond(200, { ok: true, data: result });
      }
      const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(sessionName + '='))?.slice(sessionName.length + 1);
      if (!equal(cookie, session)) throw failure('FORBIDDEN');
      if (req.method === 'GET' && path === '/api/state') return respond(200, { ok: true, data: await state() });
      if (req.method === 'GET' && path === '/api/status') return respond(200, { ok: true, data: await statusSnapshot({ hub, root, read, rpc, conversationId: new URL(req.url, origin).searchParams.get('conversation') || undefined }) });
      if (req.method === 'GET' && path === '/api/connections') return respond(200, { ok: true, data: await connectionSnapshot() });
      if (req.method === 'GET' && path === '/api/remote-agent') return respond(200, { ok: true, data: await remote.snapshot() });
      if (req.method === 'GET' && path === '/api/remote-agent/events') return await remote.events(res, new URL(req.url, origin).searchParams.get('sessionId'));
      if (req.method === 'GET' && path === '/api/hub') {
        let localSources;
        try { localSources = sourceBridgeInventory(hub) || await sourceInventory(root); }
        catch { localSources = { actions: [], roots: [], error: 'SOURCE_CONFIG_UNAVAILABLE' }; }
        return respond(200, { ok: true, data: { ...hub.snapshot(new URL(req.url, origin).searchParams.get('conversation') || undefined), truth: await statusSnapshot({ hub, root, read, rpc, conversationId: new URL(req.url, origin).searchParams.get('conversation') || undefined }), localSources } });
      }
      if (req.method === 'GET' && path === '/api/first-task') return respond(200, { ok: true, data: await firstTaskSnapshot(new URL(req.url, origin).searchParams.get('flowId')) });
      if (req.method === 'GET' && path === '/api/reach-out') return respond(200, { ok: true, data: reachOutSnapshot(hub) });
      if (req.method === 'GET' && path === '/api/personal-notices') return respond(200, { ok: true, data: personalNoticeSnapshot(hub) });
      if (req.method === 'GET' && path === '/api/automatic-content') return respond(200, { ok: true, data: automaticContent.snapshot() });
      if (req.method === 'GET' && path === '/api/routines') return respond(200, { ok: true, data: await routineSnapshot() });
      if (req.method === 'GET' && path === '/api/followup-suggestions') { await routines.action({ operation: 'list' }); return respond(200, { ok: true, data: followupSuggestions.snapshot() }); }
      if (req.method === 'GET' && path === '/api/journal') {
        const query = new URL(req.url, origin).searchParams;
        const scope = query.has('account') || query.has('userId') ? { account: query.get('account'), userId: query.get('userId') } : undefined;
        return respond(200, { ok: true, data: await journalSnapshot(scope, await read()) });
      }
      if (req.method !== 'POST') return respond(404, { ok: false, error: 'NOT_FOUND' });
      if (req.headers.origin !== origin || !equal(req.headers['x-pa-csrf'], csrf)) throw failure('FORBIDDEN');
      const input = await body(req);
      let result;
      if (path === '/api/config') result = await exclusive(() => helper({ action: 'save', patch: input.patch, revision: input.revision }));
      else if (path === '/api/apply') result = await exclusive(() => helper({ action: 'apply', revision: input.revision }));
      else if (path === '/api/doctor') result = await helper({ action: 'doctor' });
      else if (path === '/api/device') result = await helper({ action: 'device' });
      else if (path === '/api/tasks') result = await manage(root, await read(), input, rpc);
      else if (path === '/api/journal') result = await enrichJournalSnapshot(await journal.mutate(input, await read()));
      else if (path === '/api/journal/conversation') {
        const local = { account: 'local', userId: 'owner' };
        if (input.scope && (input.scope.account !== local.account || input.scope.userId !== local.userId)) throw failure('FORBIDDEN');
        const item = journal.store.snapshot(local).items.find(item => item.id === input.itemId);
        if (!item || item.source?.kind === 'guide') throw failure('ITEM_NOT_FOUND');
        let conversation;
        if (item.conversationId) conversation = hub.conversation(item.conversationId);
        else {
          // A persisted tool receipt proves which conversation already worked on this item.
          const prior = hub.snapshot().runs.findLast(run => run.journalItemIds?.includes(item.id));
          conversation = prior ? hub.conversation(prior.conversationId) : hub.once('journal-conversation:' + item.id, () => hub.newConversation({
            title: item.title.slice(0, 80), endpointId: hubConfig(root).roles.conversation || hub.all('endpoint').find(endpoint => endpoint.active)?.id,
          }));
        }
        if (conversation.ownerId !== 'owner') throw failure('FORBIDDEN');
        journal.store.linkConversation(local, item.id, conversation.id);
        result = { itemId: item.id, conversationId: conversation.id };
      }
      else if (path === '/api/journal/guide') result = await enrichJournalSnapshot(await journal.startGuide(input, await read()));
      else if (path === '/api/journal/guide/follow') {
        if (!input || typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 200) throw failure('INVALID_INPUT');
        const settings = await read(), saved = await journal.followGuide(input, settings);
        let guideError;
        try { firstTasks.startGuide({ journal: saved, requestId: input.requestId }); }
        catch (error) {
          if (!['ROLE_UNCONFIGURED', 'ENDPOINT_OFFLINE', 'FIRST_TASK_RECOVERY_REQUIRED', 'FIRST_TASK_BUSY'].includes(error.code)) throw error;
          guideError = error.code;
        }
        result = { ...await journalSnapshot(input.scope, settings), ...(guideError ? { guideError } : {}) };
      }
      else if (path === '/api/journal/preview') result = await journal.preview(input, await read());
      else if (path === '/api/journal/apply-preview') result = await enrichJournalSnapshot(await journal.applyPreview(input, await read()));
      else if (path === '/api/first-task') { const action = firstTasks.action(input); result = { ...action, ...await firstTaskSnapshot(action.flowId) }; }
      else if (path === '/api/reach-out') result = configureReachOut(hub, input);
      else if (path === '/api/personal-notices') result = managePersonalNotices(hub, input);
      else if (path === '/api/routines') { result = await routines.action(input); syncNotices(); }
      else if (path === '/api/followup-suggestions') result = await followupSuggestions.action(input);
      else if (path === '/api/automatic-content') result = input.operation === 'configure' ? automaticContent.configure(input) : input.operation === 'feedback' ? automaticContent.feedback(input) : input.operation === 'correct' ? automaticContent.correct(input) : (() => { throw failure('INVALID_OPERATION'); })();
      else if (path === '/api/journal/design') { const changed = await journal.requestDesign(input.scope, input.revision, await read()); result = { ...changed, snapshot: await enrichJournalSnapshot(changed.snapshot) }; }
      else if (path === '/api/connections') { const changed = await cloud.mutate(input); result = changed?.snapshot ? { ...changed, snapshot: await connectionSnapshot(false) } : await connectionSnapshot(false); }
      else if (path === '/api/remote-agent') result = await remote.mutate(input);
      else if (path === '/api/local-agents') {
        if (!localAgentAvailable || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers['x-forwarded-for'] || req.headers.forwarded) throw failure('FORBIDDEN');
        result = await setupLocalAgent(input, origin);
      }
      else if (path === '/api/hub') {
        if (input.operation === 'pair') result = hub.pair(input);
        else if (input.operation === 'pair-channel') result = hub.pairChannel(input);
        else if (input.operation === 'pair-desktop-pet') result = hub.pairDesktopPet(input);
        else if (input.operation === 'enable-pet-chat') result = hub.enablePetChat(input);
        else if (input.operation === 'revoke-channel') {
          const channel = hub.get('channelEndpoint', input.channelId); if (!channel) throw failure('ITEM_NOT_FOUND');
          hub.put('channelEndpoint', { ...channel, active: false }); result = { revoked: true };
        }
        else if (input.operation === 'revoke') result = hub.revoke(input.endpointId);
        else if (input.operation === 'new') result = hub.newConversation(input);
        else if (input.operation === 'select') result = hub.selectEndpoint(input);
        else if (input.operation === 'send') {
          const message = { conversationId: input.conversationId, endpointId: input.endpointId, content: input.content, requestId: input.requestId };
          result = firstTasks.continueGuide(message);
          if (!result) result = hub.transaction(() => {
            const conversation = hub.conversation(message.conversationId);
            if (conversation.ownerId !== 'owner') throw failure('FORBIDDEN');
            // Validate before saving. Creating the item must never imply that an unavailable run was dispatched.
            if (typeof message.content !== 'string' || !message.content.trim() || message.content.length > 16000 ||
                typeof message.requestId !== 'string' || !message.requestId.trim() || message.requestId.length > 256) throw failure('INVALID_INPUT');
            hub.resolveEndpoint(message.endpointId || conversation.endpointId);
            const local = { account: 'local', userId: 'owner' }, saved = journal.store.snapshot(local);
            const linked = saved.items.filter(item => item.conversationId === conversation.id);
            let item = input.journalItemId ? linked.find(item => item.id === input.journalItemId) : linked.length === 1 ? linked[0] : undefined;
            if (input.journalItemId !== undefined && !item) throw failure('ITEM_NOT_FOUND');
            const firstMessage = !hub.all('message').some(m => m.conversationId === conversation.id);
            if (!item && input.journal === true && firstMessage) item = journal.store.ensureConversation(local, { conversationId: conversation.id, content: message.content });
            if (item && firstMessage) hub.put('conversation', { ...conversation, title: item.title.slice(0, 80), endpointId: message.endpointId || conversation.endpointId });
            const submitted = hub.submit({ ...message, ...(item && { journalItemId: item.id }) });
            return { ...submitted, ...(item && { journalItemId: item.id }) };
          });
        }
        else if (input.operation === 'cancel') result = hub.cancel(input.runId, input.confirmStopped === true);
        else if (input.operation === 'decide') result = hub.decide(input);
        else if (input.operation === 'resolve-run') result = hub.resolveRunIssue(input);
        else if (input.operation === 'task') result = hub.taskAction(input.task);
        else if (input.operation === 'bind') {
          const settings = await read(), runtime = await getRuntime(root, settings, rpc);
          if (input.channel !== 'weixin' || settings.config.im.access_policy !== 'allowlist' || !settings.config.im.allow_from.includes(input.peer) || runtime.account !== input.account) throw failure('FORBIDDEN');
          result = hub.bind(input);
        } else throw failure('INVALID_OPERATION');
      }
      else if (path === '/api/start') result = await exclusive(start);
      else if (path === '/api/stop') result = await exclusive(stop);
      else if (path === '/api/login') result = await exclusive(loginStart);
      else return respond(404, { ok: false, error: 'NOT_FOUND' });
      // The read/save helper's socket path is an internal implementation detail.
      if (result && typeof result === 'object') delete result.socket;
      respond(200, { ok: true, data: result });
    } catch (error) {
      const code = error.code && /^[A-Z_]{3,60}$/.test(error.code) ? error.code : 'UNAVAILABLE';
      respond(['FORBIDDEN', 'BRIDGE_UNAUTHORIZED'].includes(code) ? 403 : ['ROUTINE_ALREADY_EXISTS', 'ROUTINE_BUSY', 'ROUTINE_SUPERSEDED', 'JOURNAL_CLOSED', 'GUIDE_SOURCE_CHANGED', 'GUIDE_ALREADY_STARTED', 'IDEMPOTENCY_CONFLICT', 'STALE_PREVIEW', 'CONFLICT', 'VERSION_CONFLICT', 'REVISION_CONFLICT', 'CONNECTION_NOT_ENABLED', 'STALE_DESIGN', 'BUSY', 'LEDGER_BUSY', 'STORAGE_BUSY', 'ACCOUNT_CHANGED', 'ALREADY_RUNNING', 'AUTO_LAYOUT_PAUSED', 'INVALID_STATE', 'FIRST_TASK_FLOW_REQUIRED', 'FIRST_TASK_BUSY', 'FIRST_TASK_RECOVERY_REQUIRED', 'FIRST_TASK_CONFIRM_REQUIRED', 'FIRST_TASK_ALREADY_SAVED', 'FIRST_TASK_ITEM_MISMATCH', 'FIRST_TASK_WRITE_UNCERTAIN'].includes(code) ? 409 : code === 'BODY_TOO_LARGE' ? 413 : ['INVALID_ROUTINE_RESULT', 'GUIDE_CHOICE_REQUIRED', 'PLAN_REVIEW_REQUIRED', 'FIRST_TASK_PLAN_REQUIRED', 'INVALID_INPUT', 'INVALID_REPORT', 'INVALID_REQUEST', 'INVALID_SCOPE', 'INVALID_OPERATION', 'INVALID_LAYOUT', 'INVALID_TASK_DATA', 'INVALID_WIDGET', 'INVALID_WIDGET_ACTION', 'BUDGET_EXCEEDED', 'MISSING_BUDGET', 'CANDIDATE_CONSTRAINT', 'SLOT_UNAVAILABLE', 'DEADLINE_EXCEEDED', 'MISSING_DEADLINE', 'PAST_SCHEDULE', 'FUTURE_CHECK_IN', 'FUTURE_EVIDENCE', 'MISSING_BASE_SERVINGS', 'MISSING_APPROVAL_FACTS'].includes(code) ? 400 : code === 'ITEM_NOT_FOUND' ? 404 : 503, { ok: false, error: code });
    }
  });
  server.requestTimeout = 50000; server.headersTimeout = 10000;
  server.once('listening', () => {
    if (!controlOnly && !closing) { checkRoutines(); routineTimer = setInterval(checkRoutines, 25000); routineTimer.unref(); }
    if (!managedRuntime || controlOnly || closing) return;
    void monitor(); monitorTimer = setInterval(() => { void monitor(); }, intervalMs); monitorTimer.unref();
  });
  let shutdownTask;
  return { server, state, journal, connections, hub, firstTasks, routines, monitor, shutdown: () => shutdownTask ||= (async () => {
    closing = true; clearInterval(monitorTimer); clearInterval(cloudTimer); clearInterval(routineTimer); loginGeneration++; loginAbort.abort();
    await routineTick;
    remote.close(); await cloud.close();
    await operationTask?.catch(() => {});
    // launchd restarts the Web supervisor; its already-running detached host can
    // be verified and adopted without interrupting a user's current task.
    if (owned) { if (managedRuntime) owned.unref(); else await stopRuntime(); }
    await new Promise(resolve => server.close(resolve)); connections.close(); hub.close(); await journal.close();
  })() };
}
