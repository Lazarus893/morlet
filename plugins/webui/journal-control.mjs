import { guideSources } from '../life-journal/guide.mjs';
import { hubConfig, roleAgent } from '../agent-hub/config.mjs';
import { JournalStore } from '../life-journal/store.mjs';
import { projectWorkpages } from '../life-journal/workpages.mjs';
import { createJournalRuntime } from '../life-journal/chief.mjs';
import { availableWidgetKinds, materialWidgetKinds, projectWidget } from '../life-journal/widgets.mjs';
import { getRuntime, control } from './control.mjs';
import { failure } from '../proactive/management.mjs';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const LOCAL = Object.freeze({ account: 'local', userId: 'owner' });
const operations = new Set(['add', 'update', 'done', 'cancel', 'undo', 'delete', 'step', 'choose', 'preferences', 'layout', 'widget']);
const sameScope = (a, b) => a.account === b.account && a.userId === b.userId;
async function executableAvailable(command) {
  const paths = command.includes('/') ? [command] : (process.env.PATH || '').split(delimiter).map(dir => join(dir, command));
  for (const path of paths) {
    try { if ((await stat(path)).isFile()) { await access(path, constants.X_OK); return true; } } catch { /* Not installed here. */ }
  }
  return false;
}

// The HTTP layer owns permission checks. Internal design commits are deliberately
// absent from the public operation list, even though the store supports them.
export function createJournalControl({ root, rpc = control, runtimeFactory = createJournalRuntime, readSettings, guideReport, conversationReports }) {
  const store = new JournalStore(root);
  let runtime, runtimeKey, loading, closing = false;
  const pending = new Set();
  const designConfig = settings => { const roles = hubConfig(root).roles; return Object.hasOwn(roles, 'journalDesigner') ? roles.journalDesigner ? roleAgent(root, 'journalDesigner') : { provider: 'disabled' } : settings.config.agent; };
  const settingsKey = settings => JSON.stringify([designConfig(settings), settings.agentCommand, settings.config.im]);
  const defaultZone = settings => settings.config.proactive?.timezone && settings.config.proactive.timezone !== 'local' ? settings.config.proactive.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  function project(snapshot, settings) {
    const items = new Map(snapshot.items.map(item => [item.id, item]));
    const timeZone = defaultZone(settings), projection = (item, kind) => projectWidget(item, kind, { now: store.now(), timeZone });
    const report = guideReport?.(snapshot) || null;
    const linkedReports = conversationReports?.() || new Map();
    const projectedItems = snapshot.items.map(item => {
      const contentEntries = item.source?.kind === 'automatic' ? store.db.prepare('SELECT data FROM journal_content_entries WHERE item_id = ?').all(item.id).map(({ data }) => JSON.parse(data)) : undefined;
      const contentPreviews = contentEntries?.map(entry => ({ entryId: entry.entryId, hook: entry.hook, summary: entry.summary }));
      const seriesNames = { 'google-mail': '邮件整理', github: 'GitHub 整理', x: 'X 整理' };
      const firstEntry = contentEntries?.[0];
      const contentSeries = firstEntry && seriesNames[firstEntry.source] && /^\d{4}-\d{2}-\d{2}$/.test(firstEntry.day) && contentEntries.every(entry => entry.source === firstEntry.source && entry.day === firstEntry.day)
        ? { id: firstEntry.source, title: seriesNames[firstEntry.source], day: firstEntry.day } : null;
      const current = snapshot.layout.widgets.find(widget => widget.itemId === item.id);
      const kinds = availableWidgetKinds(item);
      const kind = kinds.includes(item.taskType) ? item.taskType : current?.kind || kinds[0];
      const linkedReport = linkedReports.get(item.id);
      const followupReport = item.id === snapshot.guide?.resultItemId && report ? report : item.conversationId && linkedReport?.run ? linkedReport : null;
      const initialTitle = item.source?.text?.trim().split(/\n/)[0].replace(/\s+/g, ' ').slice(0, 80);
      const automaticTitle = item.titleOrigin === 'message' || !item.titleOrigin && (item.conversationId && item.title === initialTitle || item.id === snapshot.guide?.resultItemId && item.title.startsWith('跟进：'));
      const generatedTitle = followupReport?.chapterTitle || followupReport?.run?.report?.title;
      const displayTitle = automaticTitle && typeof generatedTitle === 'string' && Array.from(generatedTitle).length <= 60 && !/[\r\n]/.test(generatedTitle) ? generatedTitle : automaticTitle ? Array.from(item.title.split(/[\n。！？；;，,]/)[0]).slice(0, 24).join('') : item.title;
      return { ...item, ...(displayTitle !== item.title && { displayTitle }), ...(contentPreviews && { contentPreviews }), ...(contentSeries && { contentSeries }), ...(followupReport ? { followupReport } : {}), ...(linkedReports.get(item.id)?.originSourceRef && { sourceRef: linkedReports.get(item.id).originSourceRef }), primaryProjection: kind ? projection(item, kind) : null,
        ...(item.source?.kind === 'guide' && { ...(snapshot.guide ? { guide: snapshot.guide } : {}), guideProjections: kinds.map(kind => projection(item, kind)) }) };
    });
    return { ...snapshot, ...(snapshot.guide && { guide: { ...snapshot.guide, report } }), items: projectedItems, layout: { ...snapshot.layout, workpages: projectWorkpages(snapshot, { now: store.now() }), widgets: snapshot.layout.widgets.map(widget => ({ ...widget, projection: items.has(widget.itemId) ? projection(items.get(widget.itemId), widget.kind) : null })) } };
  }
  async function authorize(value, settings, live) {
    const scope = value ?? LOCAL;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
        typeof scope.account !== 'string' || typeof scope.userId !== 'string') throw failure('INVALID_SCOPE');
    if (sameScope(scope, LOCAL)) return { ...LOCAL };
    if (!/^[a-f0-9]{64}$/.test(scope.account) || settings.config.im.provider !== 'weixin' ||
        settings.config.im.access_policy !== 'allowlist' || !settings.config.im.allow_from.includes(scope.userId)) throw failure('FORBIDDEN');
    const host = live ?? await getRuntime(root, settings, rpc);
    if (!host.accounts.some(account => account.account === scope.account && account.users.some(user => user.id === scope.userId))) throw failure('ACCOUNT_CHANGED');
    return { account: scope.account, userId: scope.userId };
  }
  async function availability(settings, host) {
    try {
      const selected = designConfig(settings);
      if (selected.provider === 'disabled') return { designAvailable: false, designReason: '尚未绑定手账设计 Agent，当前使用基础排版。' };
      if (selected.provider === 'dsh') {
        const live = host ?? await getRuntime(root, settings, rpc);
        const matched = live.configRevision === settings.revision;
        return { designAvailable: Boolean(live.journalAvailable && matched), designReason: live.journalAvailable ? matched ? '' : '已保存设置尚未由Morlet加载，当前保留原排版。' : '尚未提供手账设计服务，当前使用基础排版。' };
      }
      const installed = selected.command ? await executableAvailable(selected.command) : Boolean(settings.installed);
      return { designAvailable: installed, designReason: installed ? '' : '尚未找到所选 Agent，当前使用基础排版。' };
    } catch {
      // Model routing is independent of a confirmed ledger write. Never report
      // a saved business fact as failed or silently switch to another Agent.
      return { designAvailable: false, designReason: '设计 Agent 暂不可用，已有手账仍可使用。' };
    }
  }
  async function snapshot(value, settings, host) {
    const scope = await authorize(value, settings, host);
    const persisted = store.snapshot(scope);
    let provider;
    try { provider = designConfig(settings).provider; } catch { /* An unavailable role must not hide saved facts. */ }
    if (['queued', 'running'].includes(persisted.design.status) && ['codex', 'workbuddy'].includes(provider)) {
      // Reopening Web must recover an existing design even before WeChat login.
      // Initialize resumes queued work; an orphaned running job is marked interrupted.
      await externalRuntime(settings);
    }
    return { ...project(store.snapshot(scope), settings), scope, ...await availability(settings, host) };
  }
  async function externalRuntime(settings) {
    const key = settingsKey(settings);
    if (runtime && runtimeKey === key) return runtime;
    if (loading) await loading;
    if (runtime && runtimeKey === key) return runtime;
    loading = (async () => {
      await runtime?.stop();
      const scopeAllowed = async scope => {
        if (closing) return false;
        const current = readSettings ? await readSettings() : settings;
        if (settingsKey(current) !== key) return false;
        if (sameScope(scope, LOCAL)) return true;
        const live = await getRuntime(root, current, rpc);
        if (live.state !== 'running' || live.account !== scope.account) return false;
        try { await authorize(scope, current, live); return true; } catch { return false; }
      };
      const selected = designConfig(settings);
      // A distinct design role keeps its own executable and model. Never switch
      // to the conversation provider just because it is currently available.
      const agentConfig = { ...selected, command: selected.command || (selected.provider === settings.config.agent.provider ? settings.agentCommand : null) || (selected.provider === 'codex' ? 'codex' : 'codebuddy') };
      runtime = await runtimeFactory({ root, store, agentConfig, scopeAllowed });
      runtimeKey = key;
      return runtime;
    })();
    try { return await loading; } finally { loading = null; }
  }
  async function performDesign(value, revision, settings) {
    const scope = await authorize(value, settings);
    if (designConfig(settings).provider === 'disabled') throw failure('DESIGN_UNAVAILABLE');
    if (!Number.isSafeInteger(revision) || revision !== store.snapshot(scope).revision) throw failure('VERSION_CONFLICT');
    if (!store.snapshot(scope).preferences.autoLayout) throw failure('AUTO_LAYOUT_PAUSED');
    if (designConfig(settings).provider === 'dsh') {
      const live = await getRuntime(root, settings, rpc);
      if (!live.journalAvailable || !live.account || live.configRevision !== settings.revision) throw failure('DESIGN_UNAVAILABLE');
      const result = await rpc(settings.socket, { command: 'pa', operation: 'journal-design', account: live.account, scope, revision });
      if (result.kind !== 'pa' || !result.data?.journalDesign) throw failure('CONTROL_FAILED');
      return { ...result.data.journalDesign, snapshot: await snapshot(scope, settings) };
    }
    const agent = await externalRuntime(settings);
    if (!agent.ready) throw failure('DESIGN_UNAVAILABLE');
    const result = await agent.request(scope, { revision });
    return { ...result, snapshot: await snapshot(scope, settings) };
  }
  function requestDesign(value, revision, settings) {
    if (closing) return Promise.reject(failure('STORAGE_UNAVAILABLE'));
    const job = performDesign(value, revision, settings);
    pending.add(job);
    job.then(() => pending.delete(job), () => pending.delete(job));
    return job;
  }
  async function mutate(input, settings, { trustedSource, beforeCommit } = {}) {
    if (closing) throw failure('STORAGE_UNAVAILABLE');
    const scope = await authorize(input.scope, settings);
    if (!operations.has(input.operation)) throw failure('INVALID_OPERATION');
    const before = store.snapshot(scope);
    const previousItem = before.items.find(item => item.id === input.itemId);
    let values = input.values;
    if (input.operation === 'add' && values && typeof values === 'object' && !Array.isArray(values)) {
      const { source: _untrusted, ...fields } = values;
      values = { ...fields, source: trustedSource || { kind: 'user', channel: 'web', text: [fields.title, fields.note].filter(Boolean).join('\n'), at: new Date().toISOString() } };
    }
    const timeZone = defaultZone(settings);
    const habitZone = previousItem?.taskData?.habit?.timeZone || timeZone;
    if (values?.taskData?.habit && typeof values.taskData.habit === 'object' && !Array.isArray(values.taskData.habit) && !Object.hasOwn(values.taskData.habit, 'timeZone')) values = { ...values, taskData: { ...values.taskData, habit: { ...values.taskData.habit, timeZone: habitZone } } };
    if (input.operation === 'widget' && values?.kind === 'habit' && values.action === 'set-data' && values.data && typeof values.data === 'object' && !Array.isArray(values.data) && !Object.hasOwn(values.data, 'timeZone')) values = { ...values, data: { ...values.data, timeZone: habitZone } };
    try { beforeCommit?.(); }
    catch (error) { error.journalCommitted = false; throw error; }
    // Only the store knows whether its transaction rolled back or committed.
    // Do not overwrite that evidence for errors after a durable commit.
    const result = store.mutate(scope, { operation: input.operation, revision: input.revision, itemId: input.itemId, itemVersion: input.itemVersion, values }, { timeZone });
    const updatedItem = result.items.find(item => item.id === input.itemId);
    const structural = ['add', 'done', 'cancel', 'undo', 'delete', 'choose'].includes(input.operation) ||
      input.operation === 'update' && ['title', 'kind', 'steps', 'candidates', 'taskType'].some(key => JSON.stringify(previousItem?.[key]) !== JSON.stringify(updatedItem?.[key])) ||
      previousItem && updatedItem && JSON.stringify(availableWidgetKinds(previousItem)) !== JSON.stringify(availableWidgetKinds(updatedItem)) ||
      previousItem && updatedItem && JSON.stringify(materialWidgetKinds(previousItem)) !== JSON.stringify(materialWidgetKinds(updatedItem)) ||
      input.operation === 'preferences' && !before.preferences.autoLayout && result.preferences.autoLayout;
    // Wait only for queue acceptance, never model completion. Returning the
    // pre-enqueue idle snapshot made successful background designs look broken.
    // Business facts are already durable; dispatch failure cannot undo the save.
    let designRequest;
    const interruptedGuideDesign = previousItem?.source?.kind === 'guide' && ['queued', 'running'].includes(before.design.status);
    if (result.preferences.autoLayout && (structural && previousItem?.source?.kind !== 'guide' || interruptedGuideDesign)) {
      try {
        const accepted = await requestDesign(scope, result.revision, settings);
        designRequest = { accepted: accepted.accepted === true, status: accepted.status || 'unavailable', ...(accepted.reason ? { reason: accepted.reason } : {}), revision: result.revision };
      } catch (cause) {
        designRequest = { accepted: false, status: 'unavailable', reason: cause.code || 'DESIGN_UNAVAILABLE', revision: result.revision };
      }
    }
    const current = store.snapshot(scope);
    // A concurrent business edit must not change the identity/version in this
    // write's receipt; only take the refreshed design at the saved revision.
    return { ...project(current.revision === result.revision ? current : result, settings), scope, ...(designRequest ? { designRequest } : {}), ...await availability(settings) };
  }
  async function preview(input, settings) {
    const scope = await authorize(input?.scope, settings);
    return store.preview(scope, input);
  }
  async function applyPreview(input, settings, { beforeCommit } = {}) {
    const scope = await authorize(input?.scope, settings);
    try { beforeCommit?.(); } catch (error) { error.journalCommitted = false; throw error; }
    const result = store.applyPreview(scope, input, { timeZone: defaultZone(settings) });
    return { ...project(result, settings), scope, ...await availability(settings) };
  }
  async function guideSourcesSnapshot(value, settings) {
    const scope = await authorize(value, settings);
    const sources = guideSources(store.db, store.snapshot(scope), scope, store.now());
    return { sources, available: sources.length > 0 };
  }
  async function startGuide(input, settings) {
    if (closing) throw failure('STORAGE_UNAVAILABLE');
    const scope = await authorize(input?.scope, settings);
    const before = store.snapshot(scope), result = store.ensureGuide(scope);
    // Creating a local guide must not silently discard an existing design job.
    if (result.revision !== before.revision && before.preferences.autoLayout && ['queued', 'running'].includes(before.design.status)) {
      try { await requestDesign(scope, result.revision, settings); } catch { /* Snapshot still exposes design availability. */ }
    }
    return snapshot(scope, settings);
  }
  async function followGuide(input, settings) {
    const scope = await authorize(input?.scope, settings);
    if (!sameScope(scope, LOCAL)) throw failure('FORBIDDEN');
    return store.followGuide(scope, input);
  }
  return { store, snapshot, guideSourcesSnapshot, mutate, preview, applyPreview, startGuide, followGuide, requestDesign, close: async () => {
    closing = true;
    await Promise.allSettled([...pending]);
    await loading?.catch(() => {});
    await runtime?.stop();
    store.close();
  } };
}
