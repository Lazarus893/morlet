import { createHash } from 'node:crypto';
import { AgentHub } from './store.mjs';
import { hubConfig } from './config.mjs';
import { personalNoticeCommand, personalNoticeContext } from '../proactive/personal-notices.mjs';
import { runProgress } from './reports.mjs';
import { endpointReadiness } from './readiness.mjs';
import { configureReachOut, reachOutPolicy } from '../proactive/reach-out.mjs';

export class HubChannel {
  constructor({ root, channel, account, allowed, send, receiveLegacy, observe, nativeSession, autoFlush = true }) {
    this.hub = new AgentHub(root); this.channel = channel; this.account = account;
    this.allowed = allowed; this.send = send; this.receiveLegacy = receiveLegacy; this.observe = observe; this.nativeSession = nativeSession; this.sending = null;
    if (autoFlush) { this.timer = setInterval(() => { void this.flush().catch(() => {}); void this.observePending().catch(() => {}); }, 500); this.timer.unref(); }
  }
  async receive({ peer, text, requestId, contextToken, occurredAt, sourceMessageId, attachments = false, replyTo, entryId, reaction }) {
    if (!this.allowed(peer)) return false;
    const config = hubConfig(this.hub.root);
    const binding = this.hub.transaction(() => {
      const old = this.hub.binding(this.channel, this.account, peer);
      if (old) return this.hub.bind(old);
      if (!config.roles.conversation) return old;
      const conversation = this.hub.newConversation({ endpointId: config.roles.conversation });
      return this.hub.bind({ channel: this.channel, account: this.account, peer, conversationId: conversation.id });
    });
    if (!binding) return false;
    const source = { channel: this.channel, account: this.account, peer, ...(Number.isSafeInteger(occurredAt) && { occurredAt }), ...(sourceMessageId && { sourceMessageId }), ...(contextToken ? { contextToken } : {}), ...(this.channel === 'desktop-pet' && replyTo && { replyTo, ...(entryId && { entryId }) }) };
    // Route migration never moves old executions. Their approvals and controls
    // remain reachable by their original sender without reopening old context.
    const ownsRun = run => run && (!binding.ownerVerified && run.conversationId === binding.conversationId || run.source?.channel === this.channel && run.source.account === this.account && run.source.peer === peer);
    const pendingApprovals = () => this.hub.all('approval').filter(a => ['pending', 'deferred'].includes(a.state) && ownsRun(this.hub.get('run', a.runId)));
    // Refresh the return route without exposing the transport token to the agent.
    this.hub.put('route', { id: binding.id, source, updatedAt: this.hub.now() });
    const key = 'channel:' + createHash('sha256').update(JSON.stringify([this.channel, this.account, peer, requestId])).digest('hex');
    if (this.hub.receipt(key)) return true;
    const replyContext = this.channel === 'desktop-pet' && replyTo ? personalNoticeContext(this.hub, this.account, replyTo) : undefined;
    if (entryId && !replyContext?.entries.some(e => e.id === entryId)) throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
    if (replyContext && entryId) replyContext.entries = replyContext.entries.filter(e => e.id === entryId);
    const legacy = personalNoticeCommand(this.hub, this.channel, this.account, peer, text, { replyTo, entryId, reaction }) ?? await this.receiveLegacy?.({ peer, text, requestId, contextToken });
    this.hub.once(key, () => {
      let reply;
      try {
        const parts = text.trim().split(/\s+/);
        if (typeof legacy === 'string') reply = legacy;
        else if (attachments) reply = '这个本地 Agent 入口目前接收文字。请把需要处理的内容发成文字，附件尚未转交。';
        else if (['/approve', '/reject', '批准', '拒绝', '延后', '接受限制', '继续处理'].includes(parts[0])) {
          const pending = pendingApprovals();
          const approvalId = parts[1] || (pending.length === 1 ? pending[0].id : null);
          if (!approvalId) reply = pending.length ? '有几件事等你决定，请带上对应编号。' : '当前没有待批准的动作。';
          else {
            const decision = ({ '/approve': 'approve', '/reject': 'reject', '批准': 'approve', '拒绝': 'reject', '延后': 'defer', '接受限制': 'accept_limit', '继续处理': 'accept_limit' })[parts[0]];
            const approval = pending.find(a => a.id === approvalId);
            if (!approval) throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' });
            this.hub.decide({ approvalId, decision, conversationId: approval.conversationId });
            reply = decision === 'approve' ? '已批准这一次，Mori 接着处理。' : decision === 'defer' ? '先保留这个决定，暂不执行；过期后需重新确认。' : '这项动作不会执行，其余部分继续处理。';
          }
        } else if (parts[0] === '/bot-cancel') {
          for (const r of this.hub.all('run').filter(ownsRun)) this.hub.cancel(r.id);
          reply = '已取消当前会话的待执行任务，并通知本地 Agent 停止。';
        } else if (parts[0] === '/new' || parts[0] === '/reset') {
          this.hub.resetContext(binding.ownerVerified ? this.hub.openRoom({ kind: 'group' }).id : binding.conversationId);
          reply = '后续消息会使用新上下文，记录和正在处理的事项保留。';
        } else if (parts[0] === '/use') {
          if (this.hub.conversation(parts[1]).sourceScope !== binding.id) throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' });
          this.hub.bind({ ...binding, conversationId: parts[1] }); reply = '已切换会话，下一条消息会接着聊。';
        } else if (parts[0] === '/bot') {
          const bots = this.hub.snapshot().bots.filter(b => b.active);
          if (parts.length === 1) reply = bots.map(b => `${b.name} @${b.handle}`).join('\n');
          else {
            const bot = bots.find(b => b.id === parts[1] || b.handle === parts[1] || b.name === parts[1]);
            if (!bot) throw Object.assign(new Error('BOT_MENTION_UNKNOWN'), { code: 'BOT_MENTION_UNKNOWN' });
            if (parts.length === 2) reply = `用 @${bot.handle} 加上交代，就能请${bot.name}处理。`;
            else this.hub.submit({ conversationId: binding.conversationId, content: '@' + bot.handle + ' ' + parts.slice(2).join(' '), botId: bot.id, source, requestId, replyContext });
          }
        } else if (parts[0] === '/agent') {
          if (parts.length <= 2) reply = '现在按事务 Bot 分工。发送 /bot 查看，或用 @标识 加上交代；执行连接在「设置 → Bot」中修改。';
          // Preserve the deployed one-message API; it never changes the Bot's
          // default connection or the next public-inbox message's manager.
          else this.hub.submit({ conversationId: binding.conversationId, endpointId: parts[1], content: text.trim().split(/\s+/).slice(2).join(' '), source, requestId, replyContext });
        } else if (parts[0] === '/tasks') {
          reply = this.hub.all('task').filter(t => t.status === 'pending').map(t => `${t.title}\n${t.id}`).join('\n\n') || '目前没有未完成的待办。';
        } else if (parts[0] === '主动模式' && ['Off', 'Digest', 'Gentle', 'Active'].includes(parts[1])) {
          configureReachOut(this.hub, { revision: reachOutPolicy(this.hub).revision, mode: parts[1] }); reply = `已改为 ${parts[1]}。各来源原有的暂停和授权保持不变。`;
        } else if (['/bot-status', '/bot-ping', '进度', '查看进度', '现在到哪了'].includes(text.trim())) {
          const c = this.hub.conversation(binding.conversationId), e = this.hub.get('endpoint', c.endpointId);
          const ready = endpointReadiness(this.hub, e, c.id);
          const runs = this.hub.all('run').filter(ownsRun).slice(-3);
          const pending = pendingApprovals();
          reply = [ready.canExecute ? 'Mori 可以继续处理。' : ready.reasons.join('；'), ...runs.map(r => `${r.report?.title || r.title}：${({ queued: '排队等处理', running: '正在处理', waiting_approval: '等你决定', uncertain: '执行中断，结果待核对', failed: '未完成', completed: '已回复', cancelled: '已取消', cancelling: '等待停止' })[r.status]}${(() => { const progress = runProgress(r, this.hub.all('sourceRequest'), this.hub.now()); return progress ? '。' + progress.label + '（已用时 ' + progress.elapsedSeconds + ' 秒）' : r.report?.summary ? '。' + r.report.summary.slice(0, 180) : ''; })()}`), ...pending.map(a => `${a.action?.title || '待确认动作'} [${a.id}]：${a.action?.preview || '需要核对详情'}；${a.action?.approvable ? '回复批准、拒绝或延后。' : '回复接受限制，继续只读整理。'}`)].join('\n');
        } else if (text.startsWith('/')) reply = '可用命令：/reset、/bot、/tasks、/bot-cancel、/bot-status、/approve 审批ID、/reject 审批ID、/pa。';
        else {
          const current = this.hub.conversation(binding.conversationId);
          this.hub.put('conversation', { ...current, botId: 'xiaoman' });
          this.hub.submit({ conversationId: binding.conversationId, content: text, botId: 'xiaoman', source, requestId, replyContext });
        }
      } catch (error) {
        if (!['ITEM_NOT_FOUND', 'CONFLICT', 'INVALID_INPUT', 'FORBIDDEN', 'ENDPOINT_UNAVAILABLE', 'ACTION_UNSUPPORTED', 'APPROVAL_SCOPE_UNSUPPORTED', 'BOT_UNAVAILABLE', 'BOT_CONNECTION_REQUIRED', 'BOT_MENTION_UNKNOWN', 'BOT_LIMIT'].includes(error.code)) throw error;
        reply = ({ BOT_MENTION_UNKNOWN: '没有找到这个 @Bot，请在设置中核对名字。', BOT_CONNECTION_REQUIRED: '这个 Bot 还没有执行连接，请在设置的 Bot 页签连接。' })[error.code] || '操作未生效：会话、审批或连接状态已变化，请在 Web 核对。';
      }
      if (reply) { this.hub.message(binding.conversationId, 'user', text || '[附件]', source); this.hub.reply(binding.conversationId, reply, source); }
      return { accepted: true };
    });
    void this.observePending().catch(() => {});
    return true;
  }
  async observePending() {
    if (!this.observe || this.observing) return this.observing;
    this.observing = (async () => {
      const role = hubConfig(this.hub.root).roles.conversation;
      const bindings = this.hub.all('binding').filter(b => b.channel === this.channel && b.account === this.account && this.allowed(b.peer));
      for (const m of this.hub.all('message').filter(m => m.role === 'user' && m.runId && m.endpointId === role && !/提醒|别忘|记得/u.test(m.text))) {
        const peers = bindings.filter(b => b.conversationId === m.conversationId);
        const target = m.source.channel === this.channel ? peers.find(b => b.peer === m.source.peer) : m.source.channel === 'web' && peers.length === 1 ? peers[0] : null;
        if (!target) continue;
        const key = 'observation:' + m.id;
        const claim = this.hub.transaction(() => {
          if (this.hub.get('effect', key)) return false;
          this.hub.put('effect', { id: key, state: 'started' }); return true;
        });
        if (!claim) continue;
        // Background analysis is never blindly repeated after a crash. Explicit
        // reminders are written by the shared tool, with an authoritative receipt.
        try { await this.observe({ peer: target.peer, text: m.text }); this.hub.put('effect', { id: key, state: 'done' }); }
        catch { this.hub.put('effect', { id: key, state: 'uncertain' }); }
      }
    })();
    try { await this.observing; } finally { this.observing = null; }
  }
  async flush() {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      const delivery = this.hub.takeDelivery(this.channel, this.account, this.allowed);
      if (!delivery) return;
      const binding = this.hub.binding(this.channel, this.account, delivery.source.peer);
      const route = binding && this.hub.get('route', binding.id);
      let success = false;
      try { await this.send(delivery.source.peer, delivery.text, route?.source.contextToken || delivery.source.contextToken); success = true; } catch { /* An ambiguous send is never automatically retried. */ }
      this.hub.delivered(delivery.id, success);
    })();
    try { await this.sending; } finally { this.sending = null; }
  }
  async close() { clearInterval(this.timer); await this.sending; await this.observing; this.hub.close(); }
}

export function createWeixinHub({ root, accountId, allowed, send, receiveLegacy, observe, nativeSession }) {
  return new HubChannel({ root, channel: 'weixin', account: createHash('sha256').update(accountId).digest('hex'), allowed, send, receiveLegacy, observe, nativeSession });
}
