# PA 适配架构

2026-10-10。本次把运行配置与执行接口分开，保留原有锁定 DSH 宿主，避免重写已工作的微信协议、登录和附件链路。

## 执行路径

微信 iLink → 通道的认证、去重、配对和附件边界 → Conversation 接口 → DSH 原生会话或外部 Agent provider → 工作区 skills / 手机任务 → Android ADB 或 iPhone WDA。

这是有意保留的部署依赖：选择 Codex/WorkBuddy 后仍安装 DSH 作为微信宿主，但普通微信对话不经过 DSH 模型。DSH Web 页仍是 DSH 管理界面，不是外部核心的统一聊天 UI。

## Agent 接口

`plugins/agent-bridge/providers.mjs` 的 provider 接收配置、prompt 和 context，返回 `{text, sessionId}`。context 提供：

- `instructions`：生成的 PA 人设、能力列表和统一工具入口。
- `sessionId` / `onSession`：恢复和记录原生核心会话。
- `approve({toolName, reason, signal})`：等待该微信用户的本次决定。
- `signal`：取消；适配器关闭整个子进程组及其工具进程。

Codex 使用 `app-server --listen stdio://`，显式指定 workspace-write、on-request、user reviewer 和工作区。禁止默认网络与附加写目录；特权请求经微信由用户决定。WorkBuddy 使用内置 CodeBuddy CLI 双向 stream-json 与 `permission-mode default`，保持 stdin 打开接收工具审批。没有传入 bypassPermissions 或跳过沙箱的选项。WorkBuddy 的工具权限机制不等价于 Codex 的 OS 沙箱，未承诺两者拥有相同隔离能力。

provider 必须看到协议最终成功事件才返回；退出码 0、进度文本、空输出均不能当作成功。原始 stderr、账号初始化响应和整个 config/read 结果不会记录或回传。未知交互请求明确失败，权限扩展请求默认拒绝。超过微信可完整展示长度的审批请求拒绝，不让用户批准截断内容。

`AgentConversations` 按账号、用户串行排队，跨用户分开 session；取消会作废旧队列，新会话重置 ID。切换 provider 不复用另一核心的 session。附件继续经过微信插件已有的工作区、符号链接和大小检查。

## IM 接口

微信插件通过 `agentAdapterModule` 加载实现，传入已解码的入站内容、出站附件收集器、审批注册表和会话标识函数。它要求实现 `initialize/process/executeCommand/startNewConversation/cancel/decideApproval/cancelPendingApprovals/dispose`。

新增 IM 应只负责自己的登录、入站转换、消息送达和身份绑定，再复用 provider。不要把另一渠道的 ID 直接混入微信 session namespace，也不要跳过出站文件检查。当前发行版只提供微信；`im.provider=disabled` 可停用通道。

## 主动跟进接口

与 IM 解耦的 Observer/Sniper 服务：通道提供 `receive/observe` 输入、`busy` 和一次 `send` 回调；分析器复用所选核心。预算、时区、Day 1 和反馈状态机不写进 Agent provider。详见 [主动跟进](proactive.md)。

## 设备接口

`bin/devices.py` 的设备对象提供 `probe/screenshot/create_agent` 和 `companion` 能力声明；工厂拒绝未知 provider，不默默落回 ADB。`phone_task.py` 管理检查点、状态和续跑，只有 Android 执行助手广播、录屏或共享文件推拉。

配置与任务状态记录 device_type/device_id/wda_url；改了设备必须恢复原配置才能续跑。WDA 探测只 GET status/locked，不创建 session，不解锁。只有显式 run/resume 才创建执行 session。

手机敏感批准只匹配上一轮记录的说明且只消费一次；它仍不是动作坐标、截图和交易金额的完整授权绑定。若需要交易级自动操作，需另行实现严格动作授权；本项目人设维持只查、不支付、不登录。

## 能力与分发

`pa_config.py` 校验 provider、字段、URL 和技能名。`config/capabilities.json` 是依赖声明；自定义技能和所需资源必须放在项目内。生成的工作区技能目录是受管理副本，运行经验写到 phone-refs，不改技能副本作为长期来源。

Core 与设备连接各自拥有诊断。`doctor` 不检查账号、不探测手机；`device-status` 才会对选定设备做只读探测。`status --fast` 的 socket/监听结果不能作为微信实际送达的证据。

## 已核实的接口版本

- Codex CLI 0.156.1，本机生成的 app-server JSON schema；[官方协议](https://developers.openai.com/codex/app-server/)。
- WorkBuddy 5.5.6 内置 CodeBuddy CLI 2.137.1，help 与本机协议实现；[Headless](https://www.codebuddy.ai/docs/cli/headless)、[审批 SDK](https://www.codebuddy.ai/docs/cli/sdk-permissions)。普通 `-p` 非流输入会直接拒绝需要确认的工具，不能冒充交互审批。
- DSH 0.1.5-rc.1，使用项目 lockfile 中固定依赖。

不同 CLI 版本可能变更协议。升级后先跑 doctor 与离线契约测试，再做经用户授权的真实账号验收。
