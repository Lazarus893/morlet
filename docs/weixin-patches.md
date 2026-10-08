# 本地改动记录

## deepseek-harness-weixin 0.2.5 → dsh 0.1.5-rc.1 兼容
- 文件：vendor/deepseek-harness-weixin/dist/index.js（保留当前已工作的修改）
- 原因：dsh 0.1.5 里 `agents.create({ setup })` 的回调签名变成 `(agentCtx, agent)`，Agent 由第二个参数传入；
  插件仍按 rc.7 的写法在 setup 里读 `agentCtx.agent`，在 0.1.5 会报
  `cannot get property "agent" without inject`，改成 `agentCtx.get("agent")` 则拿到 undefined。
- 改动（三处）：
  1. `setup: (agentCtx) => this.setupAgent(agentCtx, agentPreset, this.config.permissionPreset)`
     → `setup: (agentCtx, agentArg) => this.setupAgent(..., agentArg)`
  2. `async setupAgent(agentCtx, agentPreset, permissionPreset)` → 末尾加 `agentArg` 参数
  3. `const agent = agentCtx.agent;` → `const agent = agentArg ?? agentCtx.get("agent");`
- 本项目保留已修改的插件副本，依赖以 file:vendor/deepseek-harness-weixin 安装。升级时审查这些差异。
  4. `agent.session.events` → `agent.session.log`（5 处）：0.1.5 的 Session 把事件数组改名为 `log`，事件类型名未变。
  5. `initialize()`：`sessionPersistence.list()` 在 0.1.5 返回 `{header, revision, sizeBytes}`，id 改从 `header.header.id` 取。
  6. `createOrResume()` 恢复分支：0.1.5 没有 `sessionPersistence.inspect`，去掉 inspect，恢复时直接用配置/默认 agent 预设（standard）。

## 7. 回复里链接到的工作区图片按「图片」发送（2026-10-08）
`sendReply()` 里遍历 `reply.files` 时，文件名以 png/jpg/jpeg/gif/webp 结尾的改走 `api.sendImage(to, data, context_token)`，其余仍走 `api.sendFile`。
目的：小满在回复里写 `[截图](phone-logs/.../013_final.png)` 时，微信里直接显示手机截图而不是一个文件卡片。

## 8. 出错回复改成「各设备在线状态」（2026-10-08）
`collectReply()` / `collectLatestReply()` 里的 `处理失败（CODE），请稍后重试。` 和消息处理异常的 `处理消息时发生错误，请稍后重试。` 三处，改为调用
`bin/status_report.py --error <code> --fast`（顶部新增 `import { execFile as __wxExecFile } from "node:child_process"` 和 `__wxStatusReportText()`），
回复变成「这轮没处理成功：CODE / 定位提示 / 设备状态：小满、模型 API、手机、手机助手、微信通道、分流器各自 online/offline」。脚本失败时退回一句带错误码的话。

## 独立项目副本（2026-10-08）
- 插件副本作为本地 npm 依赖随项目提交，保留上游 MIT LICENSE。
- 状态脚本路径改读 XIAOMAN_STATUS_SCRIPT，由 scripts/pa.sh 注入。
- 移除过期 source map 和旧部署备份，避免调试时误指向修改前源码。
- 主 runtime 固定为 dsh 0.1.5-rc.1，详细版本见 package-lock.json。
- 清理已经没有调用处的 `resolveSessionPreset` import；新版本 dsh 不再导出它，独立安装到同一套 runtime 时会因此加载失败。旧部署恰好从另一套旧 peer 包解析了该 import。
