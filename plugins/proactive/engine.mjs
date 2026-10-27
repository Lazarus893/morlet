import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentHub } from '../agent-hub/store.mjs';
import { reachOutPolicy, reachOutScope, importReachOutHistory, reachOutGate, reserveAnalysis, offerReachOut, reserveReachOut, finishReachOut, candidateReceipt, reachOutSnapshot, dispatchReachOut } from './reach-out.mjs';
import { snapshot, changeUser } from './management.mjs';
import { Ledger } from './store.mjs';
import { DAY, MINUTE, inQuiet, clock, count, displayTime, deliveryGate, eligibleTasks, localTime, parseInstant, validatePolicy } from './policy.mjs';
import { newId, observationInput, observerInstructions, parseObservation } from './observer.mjs';
import { compose, fallbackText, sniperInput, sniperInstructions, welcomeText } from './sniper.mjs';

const aliases = new Map([
  ['暂停提醒', '/pa off'], ['恢复提醒', '/pa on'], ['提醒设置', '/pa'], ['提醒列表', '/pa'],
  ['少提醒一点', '/pa less'], ['简短一点', '/pa brief'], ['办完了', '/pa done'],
  ['晚点提醒', '/pa later 60'], ['不用提醒了', '/pa drop'],
]);
const terminal = new Set(['done', 'cancelled', 'expired', 'skipped']);
const record = (user, now, code, taskId) => {
  user.events.push({ at: now, code, ...(taskId ? { taskId } : {}) });
  user.events = user.events.slice(-60);
};

export class ProactiveEngine {
  constructor({ config, accountId, allowed, send, analyze, resetContext = false, busy = () => false, followupAnalyze = analyze, now = Date.now }) {
    this.config = { ...config, timezone: config.timezone === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : config.timezone };
    validatePolicy(this.config);
    Object.assign(this, { allowed, send, analyze, busy, followupAnalyze, now, resetContext });
    this.store = new Ledger(config.state_dir, accountId);
    this.account = createHash('sha256').update(accountId).digest('hex');
    this.controller = new AbortController();
    this.observations = new Map();
    this.observerControllers = new Map();
    this.stopped = false;
  }
  async initialize({ startTimer = true } = {}) {
    // Validate runtime policy as well as the Python installation configuration.
    await this.store.initialize(this.allowed);
    this.hub = new AgentHub(this.config.hub_root || join(this.config.state_dir, 'reach-out'), { now: this.now });
    if (!this.config.hub_root && !this.hub.get('reachOutPolicy', 'owner')) this.hub.put('reachOutPolicy', { id: 'owner', revision: 0, timezone: this.config.timezone, max_daily: this.config.max_daily, min_gap_minutes: this.config.min_gap_minutes, max_analyses_daily: this.config.max_observations_daily, mode: this.config.mode || 'Digest' });
    for (const [id, user] of Object.entries(this.store.data.users)) importReachOutHistory(this.hub, this.scope(id), this.account + ':' + id, user.deliveryDays, user.lastAttempt);
    try {
      for (const user of Object.values(this.store.data.users)) validatePolicy(this.preferences(user));
      if (this.resetContext) await this.store.update(data => {
        for (const user of Object.values(data.users)) { user.contextToken = ''; user.contextAt = 0; }
      });
    } catch (error) { await this.store.close(); throw error; }
    if (startTimer) {
      this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 15_000);
      this.timer.unref();
    }
  }
  createUser(now) {
    return { preferences: {}, tasks: [], events: [], deliveryDays: {}, observationDays: {},
      firstSeen: now, lastInbound: now, contextAt: 0, contextToken: '', revision: 0, controlRevision: 0,
      lastAttempt: 0, lastTaskId: null, day1Created: false };
  }
  scope(id) { return reachOutScope(this.hub, 'weixin', this.account, id); }
  welcome(user, now) { if (!user.day1Created) user.tasks.push({ id: newId(), kind: 'welcome', title: '首次开场（不主动发送）', evidence: '', status: 'skipped', notifyAt: now, expiresAt: now + DAY, createdAt: now }); user.day1Created = true; } // No value-free onboarding push.
  gateContext(id, user) {
    const p = this.preferences(user), binding = this.hub.binding('weixin', this.account, id);
    return { enabled: this.config.enabled && p.enabled, quiet: inQuiet(this.now(), p), limits: user.preferences, contextValid: Boolean(user.contextToken && this.now() - user.contextAt < this.config.context_ttl_hours * 60 * MINUTE),
      conversationId: binding?.conversationId, busy: this.busy(id) || this.observations.has(id), lastInbound: user.lastInbound };
  }
  preferences(user) { return { ...this.config, ...user.preferences }; }
  summary(user) {
    const p = this.preferences(user), shared = reachOutPolicy(this.hub);
    const active = user.tasks.filter(t => t.kind !== 'welcome' && !terminal.has(t.status)).slice(-8);
    const missed = user.tasks.filter(t => t.kind !== 'welcome' && t.status === 'expired').slice(-3);
    const labels = { pending: '待提醒', sending: '正在提交', submitted: '已提交微信', delivery_unknown: '送达未知，未重发' };
    return [
      `主动关注 ${shared.mode}；微信跟进${this.config.enabled && p.enabled && shared.mode !== 'Off' ? '开启' : '暂停'}。共享额度每天最多 ${shared.max_daily} 条、间隔至少 ${shared.min_gap_minutes} 分钟，静默 ${shared.quiet_start}–${shared.quiet_end}（${shared.timezone}）。`,
      `微信另遵守每天最多 ${p.max_daily} 条、间隔至少 ${p.min_gap_minutes} 分钟，静默 ${p.quiet_start}–${p.quiet_end}（${p.timezone}）；两者取更严格限制。`,
      ...active.map(t => `[${t.id}] ${t.title}｜${labels[t.status] || t.status}｜${displayTime(t.notifyAt, p.timezone)}`),
      ...missed.map(t => `[${t.id}] ${t.title}｜已过期，未发送`),
      ...(active.length ? [] : ['目前没有需要跟进的事。']),
      '回复“暂停提醒”“少提醒一点”“简短一点”；/pa done 编号 完成；/pa later 60 编号 延后；/pa quiet 22:00 09:00 设置静默。',
      '需要电脑保持运行、微信上下文有效；提交微信不代表已读。',
    ].join('\n');
  }
  async management(request = {}) {
    if (this.stopped) throw new Error('PROACTIVE_STOPPED');
    return this.store.update(data => {
      if (request.operation && request.operation !== 'snapshot') {
        changeUser(data, this.config, request, { allowed: this.allowed, now: this.now() });
        this.observerControllers.get(request.userId)?.abort();
      }
      return snapshot(data, this.config, { allowed: this.allowed,
        busy: id => this.busy(id) || this.observations.has(id), now: this.now() }).map(row => ({ ...row, shared: reachOutSnapshot(this.hub, this.scope(row.id)), blockedBy: reachOutGate(this.hub, this.scope(row.id), this.gateContext(row.id, data.users[row.id])) }));
    });
  }
  async receive(message, text) {
    const id = message.from_user_id?.trim();
    if (this.stopped || !id || !this.allowed(id)) return null;
    return this.store.update(data => {
      const now = this.now();
      const user = data.users[id] ||= this.createUser(now);
      user.lastInbound = now; user.revision++;
      if (typeof message.context_token === 'string' && message.context_token && message.context_token.length <= 16_384) {
        user.contextToken = message.context_token; user.contextAt = now;
      }
      this.welcome(user, now);
      const line = aliases.get(text.trim()) || text.trim();
      if (['/bot-cancel', '/new', '/reset'].includes(line)) {
        user.controlRevision++;
        this.observerControllers.get(id)?.abort();
        return null;
      }
      if (!/^\/pa(?:\s|$)/.test(line)) return null;
      user.controlRevision++;
      this.observerControllers.get(id)?.abort();
      const [, command, ...args] = line.split(/\s+/);
      if (!command || command === 'status') return this.summary(user);
      if (command === 'off') {
        user.preferences.enabled = false;
        record(user, now, 'paused');
        return '主动提醒已暂停。已有待办会保留，回复“恢复提醒”后继续。';
      }
      if (command === 'on') {
        if (!this.config.enabled) return '本机尚未启用主动功能，请在电脑运行 init --proactive on 后重启 PA。';
        user.preferences.enabled = true;
        record(user, now, 'resumed');
        return '主动跟进已恢复。过时的事项不会集中补发。';
      }
      if (command === 'less' || command === 'brief') {
        if (command === 'less') Object.assign(user.preferences, { max_daily: 1, min_gap_minutes: Math.max(360, this.preferences(user).min_gap_minutes) });
        else user.preferences.max_chars = Math.min(120, this.preferences(user).max_chars);
        return command === 'less' ? '已调整为每天最多主动提醒一次。' : '以后主动提醒会控制在 120 字以内。';
      }
      if (command === 'quiet') {
        try {
          clock(args[0]); clock(args[1]);
          if (args.length !== 2 || args[0] === args[1]) throw new Error();
          Object.assign(user.preferences, { quiet_start: args[0], quiet_end: args[1] });
          return `静默时段已改为 ${args[0]}–${args[1]}。期间到期的提醒可能延后或过期。`;
        } catch { return '用法：/pa quiet 22:00 09:00（按配置时区）'; }
      }
      if (['done', 'drop', 'later'].includes(command)) {
        const taskId = (command === 'later' ? args[1] : args[0]) || user.lastTaskId;
        const task = user.tasks.find(t => t.id === taskId && t.kind !== 'welcome' && !terminal.has(t.status));
        if (!task) return '没找到对应待办。发“提醒列表”查看，再带上编号。';
        if (command === 'later') {
          const minutes = Number(args[0]);
          if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 10080) return '延后时间为 5–10080 分钟，例如 /pa later 60 编号。';
          const next = now + minutes * MINUTE;
          if (task.dueAt && next >= task.dueAt) return '延后会超过已记录的截止时间。请明确新的安排，或取消这条提醒。';
          task.notifyAt = next; task.expiresAt = task.dueAt || next + 4 * 60 * MINUTE; task.status = 'pending';
          record(user, now, 'snoozed', task.id);
          return `已延后到 ${displayTime(next, this.preferences(user).timezone)}；仍遵守静默和每日额度。`;
        }
        task.status = command === 'done' ? 'done' : 'cancelled';
        record(user, now, task.status, task.id);
        return command === 'done' ? '记下了，这件事已完成，不再提醒。' : '这件事不再提醒。';
      }
      if (command === 'add') {
        if (!this.config.enabled || !this.preferences(user).enabled) return '主动提醒尚未开启，先回复“恢复提醒”。';
        const when = parseInstant(args[0]);
        const title = args.slice(1).join(' ');
        if (!Number.isFinite(when) || when < now || when > now + 366 * DAY || !title || count(title) > 50)
          return '用法：/pa add 2026-10-11T10:00+08:00 取快递（时间需含时区，事项不超过 50 字）。';
        if (user.tasks.filter(t => !terminal.has(t.status)).length >= 100) return '待办已达 100 项，请先完成或取消旧事项。';
        const duplicate = user.tasks.find(t => t.title === title && t.notifyAt === when && !terminal.has(t.status));
        if (duplicate) return `已记录过：[${duplicate.id}] ${title}。`;
        const task = { id: newId(), kind: 'reminder', title, evidence: title, status: 'pending',
          notifyAt: when, dueAt: null, expiresAt: when + 4 * 60 * MINUTE, createdAt: now };
        user.tasks.push(task); record(user, now, 'registered', task.id);
        return `已记录 [${task.id}] ${title}，计划 ${displayTime(when, this.preferences(user).timezone)} 提醒。静默、电脑离线或微信上下文失效可能影响送达。`;
      }
      return '用法：/pa 查看；/pa on|off；/pa quiet 开始 结束；/pa done|drop 编号；/pa later 分钟 编号；/pa add ISO时间 事项。';
    });
  }
  observe(id, text) {
    const controlRevision = this.store.data.users[id]?.controlRevision;
    const previous = this.observations.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.observeNow(id, text, controlRevision));
    const tracked = task.catch(() => {}).finally(() => { if (this.observations.get(id) === tracked) this.observations.delete(id); });
    this.observations.set(id, tracked);
    return task;
  }
  async observeNow(id, text, controlRevision) {
    if (this.stopped || !this.allowed(id) || text.length < 4 || text.length > 4000 || text.startsWith('/')) return '';
    const snapshot = await this.store.update(data => {
      const user = data.users[id], now = this.now();
      if (!user || user.controlRevision !== controlRevision || !this.config.enabled || !this.preferences(user).enabled) return null;
      const actionable = user.tasks.some(t => !terminal.has(t.status) && t.kind !== 'welcome') || /提醒|准备|待办|截止|别忘|记得|需要|还没|计划|要去|明天|下周|\b(remind|deadline|prepare|todo|tomorrow|next week)\b/iu.test(text);
      const permit = reserveAnalysis(this.hub, this.scope(id), { key: 'observe:' + this.account + ':' + id + ':' + user.revision + ':' + createHash('sha256').update(text).digest('hex'), count: actionable ? 1 : 0, enabled: this.config.enabled && this.preferences(user).enabled, phase: 'observation' });
      if (!permit.allowed) return null;
      const day = localTime(now, this.config.timezone).day;
      user.observationDays[day] = (user.observationDays[day] || 0) + 1;
      return structuredClone(user);
    });
    if (!snapshot) return '';
    const controller = new AbortController();
    this.observerControllers.set(id, controller);
    try {
      const now = this.now();
      const raw = await this.analyze(observerInstructions, observationInput(text, snapshot, now, this.config.timezone),
        AbortSignal.any([this.controller.signal, controller.signal]));
      const changes = parseObservation(raw, text, snapshot, now);
      return await this.store.update(data => {
        const user = data.users[id];
        if (this.stopped || !user || user.controlRevision !== snapshot.controlRevision || !this.preferences(user).enabled || reachOutPolicy(this.hub).mode === 'Off') return '';
        const notes = [];
        for (const change of changes) {
          if (change.action === 'upsert') {
            if (user.tasks.filter(t => !terminal.has(t.status)).length >= 100) continue;
            user.tasks = user.tasks.filter(t => t.id !== change.task.id);
            user.tasks.push(change.task);
            notes.push(`已登记 [${change.task.id}] ${change.task.title}，候选提醒时间 ${displayTime(change.task.notifyAt, this.config.timezone)}`);
            record(user, this.now(), 'observed', change.task.id);
          } else {
            const task = user.tasks.find(t => t.id === change.id);
            if (task) { task.status = change.action === 'done' ? 'done' : 'cancelled'; notes.push(`${task.title} 已${task.status === 'done' ? '完成' : '取消'}，不再提醒`); }
          }
        }
        if (changes.length) user.revision++;
        return notes.join('；') || '本轮没有新增或修改提醒记录；不要声称已经设好新的提醒。';
      });
    } catch {
      if (controller.signal.aborted || this.stopped) return '';
      if (!this.stopped) await this.store.update(data => record(data.users[id], this.now(), 'observer_unavailable'));
      return '本轮后台未能确认提醒记录，不要声称已经设定；需要精确登记可用 /pa add。';
    } finally { this.observerControllers.delete(id); }
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.tickNow().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  async tickNow() {
    for (const id of Object.keys(this.store.data.users)) {
      if (this.stopped) return;
      await this.store.update(data => {
        const user = data.users[id];
        for (const task of user.tasks) {
          if (task.kind === 'welcome' && task.status === 'pending') task.status = 'skipped';
          if (task.status === 'pending' && task.expiresAt <= this.now()) { task.status = 'expired'; record(user, this.now(), 'expired', task.id); }
        }
      });
      const user = structuredClone(this.store.data.users[id]), scope = this.scope(id);
      const route = { channel: 'weixin', account: this.account, peer: id };
      const context = this.gateContext(id, user);
      const blocked = reachOutGate(this.hub, scope, context);
      await this.store.update(data => { data.users[id].blockedBy = blocked; });
      // Withdraw stale candidates before dispatch; completing a task on another
      // surface must win even if a digest was already waiting.
      for (const c of this.hub.all('reachOutCandidate').filter(c => c.scope === scope && c.source === 'weixin-followup' && c.state === 'pending' && JSON.stringify(c.route) === JSON.stringify(route))) {
        const task = user.tasks.find(t => c.key === t.id + ':' + t.notifyAt);
        if (!task || task.status !== 'pending') this.hub.put('reachOutCandidate', { ...c, state: 'cancelled' });
      }
      if (blocked) continue;
      for (const task of eligibleTasks(user, this.now()).filter(t => t.kind !== 'welcome')) {
        const key = task.id + ':' + task.notifyAt;
        if (this.hub.all('reachOutCandidate').some(c => c.scope === scope && c.source === 'weixin-followup' && c.key === key)) continue;
        let text = fallbackText(task, this.config.timezone) + `\n[${task.id}] 回复“办完了”或“晚点提醒”。`;
        if (reachOutPolicy(this.hub).mode !== 'Digest') {
          const permit = reserveAnalysis(this.hub, scope, { key: 'followup:' + key, count: 1, ...context });
          if (!permit.allowed) continue;
          try { text = compose(await this.followupAnalyze(sniperInstructions, sniperInput(task, user, this.now(), this.config), this.controller.signal), task, user, this.config); }
          catch { if (task.kind !== 'reminder') text = null; }
        }
        if (this.stopped) return;
        const latest = this.store.data.users[id], currentTask = latest.tasks.find(t => t.id === task.id);
        if (!currentTask || currentTask.status !== 'pending' || currentTask.notifyAt !== task.notifyAt || currentTask.expiresAt <= this.now() || latest.revision !== user.revision || reachOutGate(this.hub, scope, this.gateContext(id, latest))) continue;
        if (text === null) { await this.store.update(data => { const current = data.users[id].tasks.find(t => t.id === task.id); if (current?.status === 'pending') current.status = 'skipped'; }); continue; }
        if (count(text) > this.preferences(user).max_chars) continue;
        offerReachOut(this.hub, { scope, route, key, topic: task.title + ':' + task.notifyAt, source: 'weixin-followup', kind: task.kind === 'reminder' ? 'deadline' : 'followup', text, expiresAt: task.expiresAt });
      }
      const current = this.store.data.users[id];
      const attempt = reserveReachOut(this.hub, scope, route, this.gateContext(id, current));
      if (!attempt.id) continue;
      const candidates = attempt.candidates.map(cid => this.hub.get('reachOutCandidate', cid));
      let claimed = false;
      await this.store.update(data => {
        const current = data.users[id];
        if (current.revision !== user.revision || candidates.some(c => !current.tasks.some(t => c.key === t.id + ':' + t.notifyAt && t.status === 'pending' && t.expiresAt > this.now()))) return;
        claimed = true;
        for (const c of candidates) { const task = current.tasks.find(t => c.key === t.id + ':' + t.notifyAt); if (task?.status === 'pending') { task.status = 'sending'; current.lastTaskId = task.id; } }
        current.lastAttempt = this.now();
        const day = localTime(this.now(), this.config.timezone).day;
        current.deliveryDays[day] = (current.deliveryDays[day] || 0) + 1;
      });
      const dispatched = await dispatchReachOut(this.hub, attempt.id, {
        context: () => this.gateContext(id, this.store.data.users[id]),
        preflight: () => claimed && !this.stopped && this.allowed(id) && this.store.data.users[id].revision === user.revision && candidates.every(c => this.store.data.users[id].tasks.some(t => c.key === t.id + ':' + t.notifyAt && t.status === 'sending' && t.expiresAt > this.now())),
        send: () => this.send(id, attempt.text, this.store.data.users[id].contextToken),
      });
      const result = dispatched.state;
      await this.store.update(data => {
        for (const c of candidates) { const task = data.users[id].tasks.find(t => c.key === t.id + ':' + t.notifyAt); if (task?.status === 'sending') task.status = result === 'cancelled' ? 'skipped' : result; }
        record(data.users[id], this.now(), result);
      });
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller.abort();
    await Promise.allSettled([...this.observations.values(), this.ticking].filter(Boolean));
    await this.store.close();
    this.hub?.close();
  }
}
