# 本地改动记录

## 2026-10-28 保留微信原始发送时间

- `dist/index.js` 将 iLink 消息 `create_time_ms` 和稳定消息 ID 一并交给 Hub；只在原有白名单检查后接收。
- Hub 单独保存发送时间与接收时间。可信发送时间用于跨端聊天排序，异常未来时间回退为接收时间；接收序号仍用于去重与任务执行顺序。
- 离线回归覆盖乱序到达、重复事件及异常时间，不发送真实微信，不修改插件锁定版本。

## 2026-10-28 控制连接断开不再退出宿主

- `dist/chunk-KCZ7FGE3.js` 为每个控制 socket 处理连接错误，清理客户端并中止其等待；已关闭写端不再响应。
- 原因：Web 状态请求超时后，异步管理响应可能遭遇 `EPIPE`。未处理的 socket `error` 会退出整个 DSH 进程，使无关后台巡查变为执行不确定。
- 不改变账号、权限、任务状态或重试策略；只关闭失败客户端。`tests/webui.test.mjs` 复现检查后写入时的断开，验证宿主继续响应下一次管理请求；测试不发送微信消息。

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

## 9. 可插拔 Agent 核心与本机配对（2026-10-10）

- 新增 `agentAdapterModule` 配置：外部核心加载项目内 Conversation 实现；空值继续使用 DSH 原生 manager。微信登录、去重、文件下载/发送和范围校验继续由原插件负责。
- Codex/WorkBuddy 图片入站保存为工作区私有文件，把路径交给原生图片/文件工具。出站仍经过 collectOutboundFiles，不允许跨工作区发送。
- 外部核心工具审批复用 WeixinApprovalRegistry，按原会话一次性短码决定；取消、关闭、超时仍拒绝。没有添加自动批准路径。
- 发行配置默认 accessPolicy=allowlist、空白名单。未授权来信仅在 pairingRequestPath 记录 userId/首次时间，用本机 pending-users 核对；不保存正文、不回复陌生人。
- 会话和状态文案改为 Agent/PA，不再把 Codex/WorkBuddy 会话误称为 DSH Web 会话。
- 配置模板由 scripts/configure.py 生成模块绝对路径；不用任何开发者私有路径。
- 主 runtime 与 npm 锁定版本不变；离线 provider/审批/白名单/附件测试见 tests/agent_bridge.test.mjs，宿主启动见 scripts/smoke.py。

## 10. 观察者、狙击者与主动跟进（2026-10-10）

- `proactiveModule` / `proactiveConfigPath` 加载项目内服务，跟随微信连接启动/停止；初始化异常不影响普通聊天。显式扫码清除旧发送上下文。
- 白名单和入站去重之后才更新主动台账；模型不接触 context token。Day 1 开场、时间门控、台账和限频在独立模块中。
- `/pa` 与自然语言控制词直接处理，不交模型；暂停、完成、取消可绕过普通消息容量限制。普通聊天和观察并行，明确提醒先取得持久化回执。
- 用户活跃计数阻止插话；取消/新会话在异步 I/O 前作废旧请求，防止迟到的观察结果启动新一轮回复。
- 主动文本只调用一次 sendText，不经过普通回复的自动重试；超时不推定失败或盲目重发，接口成功也不称为已读。
- 离线覆盖见 tests/proactive.test.mjs；产品规则和限制见 docs/proactive.md。原宿主版本与运行实例未修改。

## Web 管理接口（方案 B）

- `dist/chunk-KCZ7FGE3.js` 的本机控制 socket 增加可选管理回调和 `pa` 命令；原有 login/wait-login 协议保持不变。访问仍受 Unix socket 0600 权限保护。
- `dist/index.js` 的 bridge 返回协议版本、配置版本、当前账号散列及脱敏用户快照。修改请求必须匹配当前账号，由主动引擎串行提交，并沿用发信人白名单与台账租约。
- 新配置 `paConfigRevision` / `paProvider` 由 configure 生成。相关声明同步到 `dist/index.d.ts`。
- 暴露最近收取消息的时间与分类连接错误（网络、平台、凭据），不向 Web 返回原始异常或令牌。
- Web 配置文件全部写好后，最后原子发布 profile patch 触发 live reload。隔离 smoke 验证实际 DSH 接受新版本，不需要真实微信凭据。

## 生活手账设计服务（2026-10-12）

- `dist/index.js` 管理快照增加 `journalAvailable`，如实报告运行中的手账设计服务。
- `journal-design` 管理请求必须匹配当前账号，scope 仅允许本机 owner 或该账号的已授权用户；派发给 Chief 持有的 journal runtime。
- 微信入站的手账确定性命令由项目内 `plugins/life-journal/chief.mjs` 处理，保留原有上下文刷新、私聊和白名单检查。账本持久化成功不因设计失败改成保存失败。
- 新增服务不主动发送消息或建立提醒，宿主和微信插件锁定版本不变。测试使用离线协议替身，没有真实微信收发验收。

## 2026-10-13 多入口会话与本地 Agent Hub

- `hubModule` / `hubRoot` 由 configure 生成并同步类型声明。通道连接加载项目内 Hub，关闭时等候入站/发送完成后关闭数据库。
- 已授权来信优先写入 Hub。已有显式绑定优先；本机配置默认路由后，首次来信创建该账号/发件人的独立会话，不合并不同身份。既有 DSH 原生 session 可续接；Web 从接管时记新消息。
- 持久接受来信后才推进微信收取游标；Hub 按账号、发件人、消息 ID 去重。原主动台账继续刷新发送上下文，确定性 `/pa` 与手账命令仍有效。
- 原生 session、审批、取消和 `/new` / `/reset` 由 Hub 管理，与 Web 共用。重置命令和新会话映射、旧任务取消、命令回执原子保存，重复推送不多建会话。
- 生活 Agent 的执行繁忙状态覆盖 Web 来信，避免微信后台提醒插话；其他 Agent 的长任务不占用该队列。明确提醒仍走原限频/静默/上下文规则；发送前将通知记入 Hub 消息与 sending 投递记录，实际发送只有一次。
- 取消 BYOA 绑定与 DSH 后台能力的互斥。后台角色读取私有配置；生活观察消费同一会话的微信/Web 消息，明确提醒只由共享工具写入。观察领取持久去重，中断不盲目重跑；保持原有主动功能开关。
- 微信 context token 只在服务端保存，不传给本地执行端。测试不访问真实微信；实现、安装及待验收项见 [BYOA 说明](byoa-implementation.md)。

- DSH Hub 宿主插件独立于微信连接启动，Web 不依赖微信登录。`/agent` 支持选择默认 Agent 或仅指定当前一条；来源投递、审批、取消仍走同一 Hub。
