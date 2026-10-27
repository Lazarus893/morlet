import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const REQUIRED_TOOLS = ['xiaoman_tasks', 'xiaoman_report', 'xiaoman_status', 'xiaoman_journal', 'xiaoman_sources'];
const fresh = (at, now, age) => Number.isFinite(at) && at > 0 && at <= now + 60000 && now - at < age;

// Login checks do not start a model, copy credentials, or expose CLI output.
export async function probeLogin(config, now = Date.now(), run = exec) {
  if (config.provider !== 'codex') return { authentication: 'unknown', checkedAt: now };
  try {
    const result = await run(config.command, ['login', 'status'], { timeout: 5000, maxBuffer: 16384, cwd: config.workspace });
    return { authentication: /not logged in|unauthorized|authentication required/i.test(result.stdout + result.stderr) ? 'required' : /^logged in\b/im.test(result.stdout + result.stderr) ? 'verified' : 'unknown', checkedAt: now };
  } catch (e) {
    return { authentication: e.code === 'ENOENT' ? 'missing' : /not logged in|unauthorized|authentication|401/i.test(String(e.stdout || '') + String(e.stderr || '')) ? 'required' : 'unknown', checkedAt: now };
  }
}

export function validateHealth(value, now) {
  if (!value || !['verified', 'required', 'missing', 'unknown'].includes(value.authentication) ||
      !Number.isSafeInteger(value.checkedAt) || value.checkedAt <= 0 ||
      Object.keys(value).some(k => !['authentication', 'checkedAt', 'expiresAt'].includes(k)) ||
      value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0)) throw new Error('INVALID_HEALTH');
  return value;
}

export function endpointReadiness(hub, endpoint, conversationId) {
  const now = hub.now(), online = endpoint.active && fresh(endpoint.lastSeen, now, 45000);
  const runs = hub.all('run').filter(r => r.endpointId === endpoint.id).sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));
  const lastFailure = runs.find(r => ['failed', 'uncertain'].includes(r.status) && r.error === 'AGENT_AUTH_REQUIRED');
  const lastSuccess = runs.find(r => r.status === 'completed');
  const lastVerifiedAt = Math.max(endpoint.authenticationVerifiedAt || 0, endpoint.health?.authentication === 'verified' ? endpoint.health.checkedAt : 0, lastSuccess?.finishedAt || 0) || null;
  const healthAt = endpoint.health?.checkedAt || 0;
  let authentication = fresh(healthAt, now, 120000) ? endpoint.health.authentication : 'unknown';
  if (authentication === 'unknown' && lastSuccess && fresh(lastSuccess.finishedAt, now, 15 * 60000)) authentication = 'recently_verified';
  // A positive probe/run after an auth failure clears it. Mere time passing
  // and an unknown login probe cannot turn a known failure into success.
  const failureAt = Math.max(endpoint.authenticationFailureAt || 0, endpoint.health?.authentication === 'required' ? healthAt : 0, lastFailure?.error === 'AGENT_AUTH_REQUIRED' ? lastFailure.finishedAt || lastFailure.heartbeat || 0 : 0);
  if (failureAt && failureAt >= (lastVerifiedAt || 0)) authentication = 'required';
  const authenticationEvidence = { state: authentication === 'unknown' ? lastVerifiedAt ? 'stale' : 'never_verified' : authentication,
    checkedAt: healthAt || null, lastVerifiedAt,
    action: authentication === 'required' ? '在执行助手所在电脑重新登录，再回到连接页核对。' : authentication === 'missing' ? '在执行助手所在电脑安装 CLI，再重新连接。' : authentication === 'unknown' ? lastVerifiedAt ? '上次验证已超出时效；下一次真实交代会核验，不会为刷新状态额外调用模型。' : '先在连接页完成登录；第一次真实交代后核验执行能力。' : '可在连接页查看授权；每次真实执行仍会检查。' };
  const session = conversationId && hub.get('session', JSON.stringify([conversationId, endpoint.id]));
  const tools = session?.tools || (conversationId ? [] : endpoint.tools || []);
  const missingTools = REQUIRED_TOOLS.filter(t => !tools.includes(t));
  const expiresAt = endpoint.health?.expiresAt ?? null;
  const authorization = expiresAt === null ? 'expiry_unknown' : expiresAt <= now ? 'expired' : expiresAt - now < 24 * 3600000 ? 'expiring' : 'valid';
  const reasons = [];
  if (!online) reasons.push('执行助手离线，交代会排队保留');
  if (!['verified', 'recently_verified'].includes(authentication)) reasons.push(authentication === 'required' ? '登录已失效，需要在本机重新登录' : authentication === 'missing' ? '执行程序未安装' : lastVerifiedAt ? '上次执行验证已超出时效，当前登录状态待核对' : '尚无成功登录或执行的验证记录');
  if (missingTools.length) reasons.push(session ? '这段会话缺少或尚未验证所需工具' : '尚未验证任务工具，请先完成一次试用');
  if (authorization === 'expiry_unknown') reasons.push('授权有效期未提供，无法提前判断临期');
  if (['expired', 'expiring'].includes(authorization)) reasons.push(authorization === 'expired' ? '授权已过期' : '授权即将过期');
  return { id: endpoint.id, label: endpoint.label, provider: endpoint.provider, online, authentication, authenticationEvidence, authorization, expiresAt,
    tools, missingTools, canExecute: Boolean(online && ['verified', 'recently_verified'].includes(authentication) && !missingTools.length && authorization !== 'expired'),
    light: reasons.length ? 'yellow' : 'green', reasons };
}
