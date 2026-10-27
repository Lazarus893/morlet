// Explicit opt-in smoke against the user's locally authenticated Codex CLI.
// It uses a disposable workspace and ledger, with no real messaging transport.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentHub } from '../plugins/agent-hub/store.mjs';
import { AgentCompanion } from '../plugins/agent-hub/companion.mjs';
if (process.env.PA_RUN_LIVE_AGENT !== '1') throw new Error('Set PA_RUN_LIVE_AGENT=1 to explicitly enable local Codex inference.');
const root = await mkdtemp(join(tmpdir(), 'xiaoman-live-')), hub = new AgentHub(root);
const provider = process.env.PA_LIVE_PROVIDER || 'codex';
const paired = hub.pair({ label: 'Temporary live acceptance', provider }), conversation = hub.newConversation({ endpointId: paired.endpointId });
const companion = new AgentCompanion({ config: { provider, command: process.env.PA_CODEX_COMMAND || 'codex', workspace: root, timeout_seconds: 90 }, statePath: join(root, 'spool'), transport: async (op, input) => hub[op](paired.token, input) });
let interval;
try {
  interval = setInterval(() => {
    for (const a of hub.all('approval')) {
      if (a.state === 'pending' && /^mcp__xiaoman__xiaoman_tasks$/.test(a.toolName)) {
        const args = JSON.parse(a.reason);
        if (['list', 'add', 'done'].includes(args.operation)) hub.decide({ approvalId: a.id, allow: true });
      }
    }
    void companion.tick().catch(() => {});
  }, 200);
  hub.submit({ conversationId: conversation.id, content: '这是一个临时本地接入测试。请只调用 xiaoman_tasks 工具，添加一个标题为“本地接入验收”的普通待办，然后回答“已记录测试待办”。不要运行 shell、读写文件或调用任何其他工具。', requestId: 'live-1' });
  const deadline = Date.now() + 110000;
  while (Date.now() < deadline && hub.all('run')[0].status !== 'completed' && hub.all('run')[0].status !== 'failed') await delay(200);
  assert.equal(hub.all('run')[0].status, 'completed', hub.all('run')[0].error);
  assert.equal(hub.all('task')[0]?.title, '本地接入验收');
  const nativeId = hub.get('session', JSON.stringify([conversation.id, paired.endpointId])).nativeSessionId; assert.ok(nativeId);
  hub.submit({ conversationId: conversation.id, content: '继续刚才的接入测试。请仅通过 xiaoman_tasks 读取待办并将“本地接入验收”标记为完成。不要调用其他工具。完成后简短确认。', requestId: 'live-2' });
  const secondDeadline = Date.now() + 110000;
  while (Date.now() < secondDeadline && !['completed', 'failed'].includes(hub.all('run')[1].status)) await delay(200);
  assert.equal(hub.all('run')[1].status, 'completed', hub.all('run')[1].error);
  assert.equal(hub.all('task')[0]?.status, 'done');
  assert.equal(hub.get('session', JSON.stringify([conversation.id, paired.endpointId])).nativeSessionId, nativeId);
  console.log('Live ' + provider + ' acceptance passed: native dynamic tools, shared task create/complete, same native session resumed. No real messages sent.');
} finally { clearInterval(interval); await companion.stop(); hub.close(); await rm(root, { recursive: true, force: true }); }
