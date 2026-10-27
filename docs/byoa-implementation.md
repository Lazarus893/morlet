# 小满多入口与本地 Agent

> 小满负责上游入口与下游 Agent 之间的共同记录、路由、任务与交付。DSH 与 Codex 可同时连接；每条执行记录固定负责的 Agent，会话和任务不随入口切换而分裂。每个安装实例独立设置角色、运行端和权限；配置与分发规则见 [框架分发](distribution.md)。

## 三层实现

| 层 | 代码 | 职责 |
|---|---|---|
| 消息入口 | `plugins/agent-hub/channel.mjs`、微信 vendor 钩子、Web `chat.js`、`imessage.mjs` | 校验入口身份，保存来信，按来源单次回复；Web 展示完整记录 |
| 会话与任务中心 | `plugins/agent-hub/store.mjs`、`reports.mjs`、`reminders.mjs`、Web HTTP API | 单 owner 会话、消息、运行队列、审批、待办、任务摘要与产物；映射本地 session；接通原提醒台账 |
| 本地执行端 | `plugins/agent-hub/companion.mjs`、`plugins/agent-bridge/providers.mjs` | 读取本机配置，复用 DSH 原生 Agent API、Codex app-server 或 WorkBuddy stream-json；持久保存结果后回传 |

上游消息入口、会话任务中心与下游执行适配分别演进。

每个会话保存默认 Agent，发送时可以逐条覆盖；每个 `(conversationId, endpointId)` 独立保存 native session。来源是每条来信的属性。微信来信默认回微信，Web 来信只回 Web，绑定后的消息统一在 Web 查看。首次接管既有微信身份时延续已存在的 DSH session；旧原生日志不批量导入 Web，Web 记录从 Hub 接管时开始。切换入口不会换模型或新建原生会话，本地离线时排队，绝不静默切到云端模型。

首次使用的按钮路径、命令与云端/同机边界见 [新用户接入指南](getting-connected.md)。同机 Mac 可一键绑定；云端首次仍需本机安装连接助手。

## 接通 Codex、Web 和微信

前提：服务端与 Mac 都使用更新后的项目源码，Node >=22.19；Mac 已安装并登录 Codex CLI。云端微信仍由现有锁定版本 DSH 托管通道，本地连接助手不重复登录或轮询微信。

1. 先执行 `./scripts/pa.sh configure` 并启动 DSH 宿主。宿主读取本机角色配置并注册 DSH，Web 与微信无需等待 Codex 在线。Web 打开「设置 → 执行 Agent → 连接 Agent」；连接本机可选择 Codex 后点击「连接这台 Mac」，连接远端则展开「连接另一台 Mac」，填写 Mac 名称和本地工作目录。连接地址使用 HTTPS；当前内网 HTTP 部署可填已有 SSH 隧道的 loopback 地址。
2. 下载私密 `agent-companion.json`，在 Mac 的项目目录运行：

   ```sh
   python3 scripts/install-agent-companion.py --kind agent --config ~/Downloads/agent-companion.json
   ```

   安装器检测 CLI，保护配置为 0600，完整验证后建立当前用户的 LaunchAgent。每个 endpoint 独立配置、状态文件与服务名，已有连接不会被另一台 Agent 的配置替换。配置校验失败不会覆盖原配置。
3. Web 显示执行端在线后，新建对话或使用已有微信对话。在输入框的「本条交给」选择 DSH 或 Codex。可以先在 Web 发送一条文字，确认本地回复和执行状态。
4. 在同一对话的「从微信接着聊」选择自己的微信身份并绑定。必须已被微信白名单允许，且账号与当前运行实例一致；开启本机默认路由后，首次获准的微信来信自动创建该账号和发件人独立的会话；不会合并不同发件人。已存在的显式绑定优先。
5. 此后微信与 Web 进入同一会话。微信 `/use 会话ID` 可切换；`/new` 或 `/reset` 取消旧队列后创建新会话，旧记录保留；`/bot-cancel` 取消当前会话执行；`/tasks` 查看共同待办。命令有持久去重回执。`/agent` 列出可用 Agent；`/agent 名称` 更改该会话默认 Agent；`/agent 名称 消息` 仅分配本条。名称不唯一时使用列表中的 ID。

也可不安装常驻服务，先把配置设为 0600 后前台运行：

```sh
node scripts/agent-companion.mjs .runtime/agent-companion.json
```

配置包含 `endpoint`、`publicOrigin`、`token`、`endpointId`、`provider`、`command`、`workspace`、`label`、`timeout_seconds`。`command` 与工作目录固定在 Mac 私密配置中，云端不能替换它们。本地 Agent 原有登录凭据不上传。工作目录沿用本机 AGENTS 指令；本地资料须由实际权限和工具边界控制，不把 workspace-write 误称为完整读取隔离。

### 云端通过 Mac 读取已连接的资料

云端 Agent 可继续负责对话，由 `xiaoman_sources` 自动派发只读请求到已配对 Mac。Mac 上现有 Agent 连接助手承担独立数据通道，不启动第二个模型，也不占用本地 LLM 执行队列。既有微信会话每轮注册当前工具；任务结果仍回复原始入口。

服务端与 Mac 都需升级。Mac 在自己的项目运行目录登记 `.runtime/local-sources.json`，仅包含用户明确复用的已有 `gh`／`gog` 命令、账号、服务和可读目录；令牌继续由原有 CLI 本地保管。服务端 `.runtime/agent-hub.json` 可显式增加：

```json
"sourceBridge": {
  "endpointId": "已配对的本地端点ID",
  "operations": [
    "github_repositories", "github_updates", "review_requests",
    "mail_search", "mail_read", "calendar_events",
    "drive_recent", "drive_search", "drive_metadata", "docs_read", "sheets_metadata", "sheets_read", "contacts_search",
    "recent_files", "file_search", "file_read"
  ]
}
```

此处为配置片段，合并到现有对象并保留 `agents` 和 `roles`。端点必须是仍有效的远程配对端；每个操作只检查所属服务的有效权限和账号：Google 分别检查 Gmail、Calendar、Drive、Contacts；Docs／Sheets 同时要求本机各自的 OAuth scope。GitHub 要求 repos，文件要求 readable 与显式目录。`list` 取服务端白名单、本机配置和有效授权的交集；撤回 Google 不会停掉 GitHub 或本地文件。未设置路由的独立安装继续直接读取自己明确登记的来源。

用户明确允许云端分析时，桥接按当前任务传回有界的邮件正文、文档内容或普通文本文件；账号凭据、绝对目录与书签仍留在 Mac。正文会进入该任务的模型上下文，不能把它描述为离线分析。此授权不改变主动关注扫描器的单独数据策略，不允许任意 URL、shell、外发、修改邮件／日历／文件或自动操作手机。

`github_repositories` 区分 Watch 通知订阅与 Star 收藏，分页返回公开仓库和每种列表的覆盖情况；私有仓库不传回。`github_updates` 验证仓库仍在当前账号的关注列表中，然后读取已发布 release 正文、近期默认分支 commit 说明与有界 patch。正文、描述及分页各有截断说明，不能把 `pushedAt` 或标题当作具体更新，也不能声称完整审阅全部代码。

每次用户要求复查，当前任务必须重新读取关注列表。任何声称“已读”“有更新”或“没有更新”的仓库都要有本轮成功读取；历史结果只用于对比，不能冒充当前检查。桥接回执附 `observedAt`，回复和任务汇报中的范围应与当前回执一致，未复查的仓库明确说明或不提及。

| 来源 | 操作与覆盖 | 不应声称 |
| --- | --- | --- |
| Gmail | mail_search 元数据；mail_read 解码正文，最多 20,000 字符 | 搜索标题等于读完邮件，或读过附件／外链 |
| Calendar | primary 日历的有界时间窗，最多 31 天 | 未覆盖其他日历却称全部日程 |
| Drive / Docs | 根目录近期文件、关键词搜索与元数据；docs_read 读取文档文字 | 文件名等于全文，或读过嵌入图片 |
| Sheets | metadata 找页签；read 指定有限 A1 区域 | 只读部分区域却分析整本表格 |
| Contacts | 按当前任务关键词搜索，有限结果 | 全量导出或向联系人发送消息 |
| 本地文件 | recent_files／file_search 找文本；file_read 有界 UTF-8 md/txt/csv/json | 继承原生助手书签权限或支持 PDF/Word/所有文件 |

每轮分析都必须实际读取正文，只使用成功回执；描述具体内容、与用户的关系和可选下一步。分页、截断、零结果、权限失败与 API 未启用分别解释。`list` 返回当前时间／时区；`observedAt` 为 ISO UTC，展示需转换并注明时区。`xiaoman_status` 同时返回连接状态和消息通道；手机、X 未验证时不会冒充可用来源，微信／iMessage 的正常回复继续复用原通道。

数据通道复用 Agent 配对凭据，接口为 `/api/agent-bridge/source-{poll,check,result}`。请求绑定原会话运行租约、配对端、连接代际、账号与当前路由；读取前后、缓存结果上报及恢复重试前复查授权。撤回连接、换账号、取消任务或撤销端点时拒绝迟到结果。缓存和结果在各自私有运行目录保存，短期服务端记录在截止后十分钟清理，不写入模型凭据或源码包。

每个只读请求最多等待两分钟；Mac 离线会明确返回 `SOURCE_BRIDGE_OFFLINE`。Mac 重启可以继续尚未过期的只读读取；已缓存结果复核后补传，丢失确认不会重复创建请求。普通 Agent 执行仍遵守下文“不自动重跑”的规则。源结果设有字节上限，永久协议错误会结束该读取而不会堵住后续任务。

## 本机角色配置

`configure` 首次按所选执行器初始化 `.runtime/agent-hub.json`，权限 0600；再次生成不覆盖用户配置。`agents` 描述当前宿主内的执行端：DSH 使用原生 preset、permission preset 和超时，可选 model/model_provider；本机 Codex/WorkBuddy 使用已有 CLI 的 command、实例 workspace 和超时。后两者复用用户已有登录，不复制凭据或要求额外模型 key。其他电脑上的 Codex/WorkBuddy 仍通过独立配对登记在私有 Hub 数据库。

`roles.conversation` 指定新会话默认 Agent；`observer`、`followup`、`journalDesigner` 绑定宿主内的执行端 ID。后台分析可用 DSH 或本机 Codex/WorkBuddy，无工具、无会话持久化；设计资料由宿主显式加载随包 skill。远程配对端的后台职责尚未实现，不会静默换模型。`conversation: null` 关闭首次来信自动路由，`journalDesigner: null` 保留基础排版。新实例选择本地 CLI 时，四个默认职责均绑定该 CLI；已有实例的角色配置保留。修改后运行 configure 并应用/重启宿主，队列中任务仍保留提交时的 Agent 归属。

只把通用模板放入源码包；实际角色分工、原生会话、endpoint token、账号与路径均留在安装实例。DSH 实际 persona 和指令从本机配置及 `.runtime/personalization` 加载。改变 Codex 连接不会重写这些职责。

## 任务互通

### 任务追踪

Web 手账按事项查看小满派发的任务；篇内「产物」呈现回报与文件，「对话」保留追聊与执行详情。每条执行记录保存负责的 Agent、来信入口、摘要、创建/开始/结束时间和产物，能定位到所属手账与对话。普通待办和定时提醒继续使用各自台账。

DSH、Codex 与 WorkBuddy 的执行适配器统一提供 `xiaoman_report`。具体工作开始后可报告进展，最终回复前报告任务摘要和真实完成情况。它只能更新当前租约所属的任务；重复调用 ID 返回已保存回执，不能覆盖后续报告。摘要和产物写入 Hub SQLite，刷新页面、切换入口或重启后保留。Agent 汇报不额外向微信发送消息，最终回复仍遵守来源路由。

```json
{
  "title": "准备发布说明",
  "summary": "说明文档已完成；发布仍需确认。",
  "outcome": "partial",
  "artifacts": [
    { "label": "预览", "url": "https://example.invalid/preview" },
    { "label": "本地文档", "path": "/workspace/release-notes.md" }
  ]
}
```

- `outcome` 支持 `in_progress / completed / partial / blocked`。执行是否结束由 companion 决定；Agent 汇报 completed 不会提前结束执行，也不会完成普通待办。运行失败、离线待确认或等待审批优先显示对应执行状态。
- 执行结束但汇报 partial / blocked 时显示「部分完成 / 任务受阻」。没有结构化汇报的旧任务显示「已回复 · 未汇报结果」；新回复另保存至多 240 字的摘录，不根据文本猜测任务成功。
- 摘要最多 1,200 字，产物最多 12 项。每个产物有名称和一个 HTTP(S) 链接或绝对文件路径；省略 artifacts 保留上一版，传空数组清除。只展示引用，不读取或上传本地文件、不请求外部 URL。带账号密码的 URL 和脚本、data、file 链接会被拒绝。
- 完成情况明确标记为 Agent 汇报，不代表用户验收。本地文件标注所属执行端及「未上传」，远程浏览器无法凭路径下载；需要跨设备查看时由 Agent 提供可访问的产物链接。
- 当前追踪范围是通过小满发起的任务；直接在独立 Codex/DSH 窗口发起的任务不会被自动扫描或导入。实例的私有摘要、产物路径和会话数据留在 `.runtime/hub/`，不进入源码包。

### 待办与提醒

- 普通待办通过 `xiaoman_tasks` 创建、完成、取消或恢复，微信、Web 和本地 Agent 使用同一 SQLite 台账。更新带版本检查，重试带请求 ID。
- 定时提醒通过 `xiaoman_reminders` 操作现有微信提醒台账，先 list 取得服务端时间、时区和 revision；Web「跟进事项」、微信 `/pa` 与 Agent 的修改互通。提醒继续遵守全局开关、静默、空闲、额度和微信上下文有效期。工具成功保存不等于已经发出。
- 定时提醒要求当前会话明确绑定微信身份。多个微信身份绑定到一个 Web 会话时不自动猜测收件人；需要消除歧义。每次回复的来源规则不改变明确安排的微信提醒。
- 观察、跟进、手账设计分别读取本机角色绑定。Codex 忙碌、离线或撤销不会关闭 DSH 角色。生活观察只消费默认对话 Agent 的文字消息，包括绑定同一微信身份的 Web 来信；明确提醒由共享工具处理，避免两个写入者重复登记。Codex 代码日志不会自动进入生活观察。原有主动开关与发送门控保留。

### 消息通道状态

`xiaoman_status` 是宿主执行的只读工具，提供消息入口与执行 Agent 的独立列表。微信使用宿主配置版本和新鲜轮询心跳，iMessage 使用桥接心跳；Web 标记已启用，不推断用户浏览器在线。当前会话是否绑定、通道在线和逐条消息送达是不同事实。未知或过期证据返回 unknown；执行沙箱内看不到 socket 不能认定微信离线。工具校验 endpoint 与当前任务租约，只返回必要状态，不暴露联系人、账号 ID 或凭据。

Codex 的动态工具在原生 `thread/start` 注册；当前本机协议的 `thread/resume` 没有追加动态工具的接口。因此升级前的 Codex 原生会话仍保留原工具集，新会话才有新增状态工具。旧会话的待办、任务汇报及续聊保持可用；不能仅重启连接助手就宣称旧会话工具已升级，也不能静默重建原生会话。DSH 每轮注册工具，不受此限制。

## 权限、重连和投递

页面管理沿用同源 session、Host/Origin 与 CSRF 校验；部署仍是可信单 owner 内网，没有增加多租户登录体系，不能原样用于公网多用户服务。

`/api/agent-bridge/{poll,event,tool}` 使用独立 Agent token，服务端只存摘要，权限限于所属 endpoint 的执行和共享任务工具。`/api/message-bridge/{poll,inbound,ack}` 使用另一种 channel token，仅能访问配对私聊。两类 token 都不能授权 Web 管理或现有连接中心。微信 context token 只保留在服务端，不进入前端、本地 job/spool 或 Agent prompt。

生活会话的 Codex 使用 app-server stdio 的 read-only/untrusted；第三方 MCP、apps/plugins 默认不启用。DSH 使用受控原生工具及单向收紧的执行闸，阻止 shell、run_code、手机等未经生活动作审核的写入路径。WorkBuddy 保留只读工具与受限任务 MCP，未进入关键验收链路。取消共同待办、提醒和手账安排须预览确切参数并批准一次；没有受控执行器的发信、下单、权限修改明确不可执行。详见 [审批边界](chief-sla.md)。

同一 endpoint 一次只运行一个任务；本地助手还持有 SQLite 操作系统锁，重复启动不会重复执行。任务 45 秒无心跳转为 uncertain，绝不重新分配；原租约可补传结果。结果与事件有序去重，本地先保存再传输。助手重启发现未确认执行，只报告 uncertain，不自动重跑。停机过程中晚到的领取结果不会启动新的本地执行，已领取但未启动的任务明确报告停止。过长的文字回复在入口截取并提示回本地查看全文，不阻塞后续事件。

取消先进入 cancelling，等待本地进程退出并确认停止，才能释放下一项工作。执行状态不明时 Web 要求使用者先在本地核实停止后再解除阻塞；离线取消不能撤销已经发生的本地副作用。撤销 endpoint 会停止领取并让正在执行的助手终止连接。

外部回复只有一次自动发送机会。超时、报错或宿主崩溃后送达状态为 unknown，不盲目重发；Web 仍保留全文。接口接受发送不等于对方已读。

## iMessage 与 WorkBuddy

**iMessage**：在收发 Mac 的「信息」中登录小满专用 Apple 账户。可创建独立的标准 macOS 用户隔离，也可由使用者明确选择在当前用户切换 Messages 账户。专用邮箱即可作为 iMessage 地址；用户自己的号码或邮箱是向小满发指令的发信身份。不得把个人用户当前登录的邮箱默认当作 bot 身份，亦不得迁入个人 Messages 数据库或 Apple 登录凭据。详细步骤见 [iMessage 接入](imessage-setup.md)。

在选定的 macOS 用户下安装 `imsg`，由使用者授予运行宿主完整磁盘访问和「信息」自动化权限。在已选会话里生成 iMessage 配置，指定允许的发信人 E.164 号码或邮箱、一个已有私聊的 chat ID，随后运行：

```sh
python3 scripts/install-agent-companion.py --kind imessage --config ~/Downloads/imessage-companion.json
```

安装器可使用 PATH 的 imsg 或项目 `.runtime/bin/imsg`；安装和每次后台启动前均只读核对指定 chat 的参与人、私聊类型与 iMessage 服务。读取失败或身份不匹配时不启动收发，安装失败不会替换既有连接。完整磁盘访问须在实际后台 Node 宿主下验证，不能只看设置开关。

首次监听从当前时刻开始，不扫描通讯录或历史。之后以已保存 row ID 补收，仅接收指定私聊、指定发件人，排除自己的消息、群聊和 reaction。GUID 去重、游标与本地入站队列一起保存；Messages 数据库更换时停止并提示核对。回复固定 `--to` 指定联系人、`--service imessage`，不会降级发送 SMS。第一版只支持文字；监听包含附件元数据，用于明确提示附件尚未转交。

协议依据：[imsg watch](https://github.com/openclaw/imsg/blob/main/docs/watch.md)、[JSON 字段](https://github.com/openclaw/imsg/blob/main/docs/json.md)、[发送参数](https://github.com/openclaw/imsg/blob/main/docs/send.md)。原生收发和 Hub 任务互通需分别验收；首次实例已完成，新增部署仍须按其实际账号验证。

**WorkBuddy**：在同一安装流程选择 WorkBuddy，安装器检测 PATH 的 `codebuddy` 或标准 WorkBuddy.app 内置 CLI。每轮接入受限任务 MCP，保持原生 session。协议、审批、任务 MCP 已离线验证；若实际 CLI 返回 401，使用者需在 CLI 重新登录后运行真实验收；桌面登录状态不能代替 CLI 登录状态。Web 会提示 `AGENT_AUTH_REQUIRED`，不向云端透出账号错误原文。

## 验收与发布边界

本轮验证包含：

- 源码检查、Python 回归、Hub/原生 DSH/主动服务/Web 协议回归，以及安装器与 HTTP 权限测试。覆盖重复来信与结果、跨入口 session、来源回复、审批归属、撤销、取消屏障、崩溃不重跑、任务版本、发送结果不明、WorkBuddy MCP、iMessage 过滤与 token 隔离。
- 真实 Codex CLI 在临时工作目录中，通过原生动态工具创建待办，Web 完成待办后，第二轮恢复同一 native session 并读到完成状态；没有真实微信或 iMessage 发送。
- Playwright 使用真实 Web HTTP 服务与离线执行端，验证任务摘要、完成情况、产物、历史记录、跨会话筛选与跳转，以及 Web 发信、微信续聊、待办同步、仅回来源、审批、草稿保留、任务保存丢响应后重试去重、Codex 等待审批时 DSH 并行执行、逐条 Agent 选择、桌面及 390px 移动页面。
- 使用安装的真实 DSH runtime 和隔离模型输出，验证原生会话恢复、共享待办与汇报工具、原生审批拒绝、来源回复及双执行队列。测试不发送真实微信。
- 2026-10-13 发布实例实机闭环：真实 Web 页面由 DSH 建立唯一待办，个人微信读取 pending/v1，个人 iMessage 完成同一任务至 done/v2，Codex 经 Web 实际读取最终状态并生成文档产物。五个阶段的摘要、完成情况、入口来源、产物路径、记录跳转和刷新后保留均经真实桌面/390px 浏览器核对。用户确认两端回复；微信仅记录 sent，iMessage 为 read，Web 不广播。实例身份、任务 ID、产物及完整证据留在私有运行目录。
- 浏览器回归覆盖内网 HTTP 缺少 `crypto.randomUUID` 的环境（幂等键使用 `getRandomValues`）、首屏响应延迟、同一请求重试去重。依据 [getRandomValues](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues) 的非安全上下文可用性，实际 HTTP 域名另做发送验收。

可重复执行：

```sh
./scripts/pa.sh check
python3 -m unittest discover -s tests -v
node --test --test-concurrency=1 tests/*.test.mjs
node tests/agent_hub.browser.mjs
# 显式启用真实本机模型；使用临时目录，不发送真实消息
PA_RUN_LIVE_AGENT=1 node tests/agent_hub.live.mjs
```

浏览器脚本需要 Playwright，可用 `PA_PLAYWRIGHT_MODULE` 指向已有安装。Python 套件已经调用部分 Node 套件，避免与全量 Node 重复并行运行。真实模型验收只在显式 opt-in 后调用本机 CLI。

每个安装实例上线前都需完成服务端版本核对、Agent 配对及真实入口验收。独立 iMessage 用户的登录、FDA/自动化与收发必须单独验证；安装工具、个人用户的读取测试或 CLI 接受发送，均不能替代 bot 的双向收发与 Hub 验收。

### 回答范围与旧任务推荐

邮件读取回执由当前 Agent 执行汇总为 `mailReview`：保留每个真实查询、目录覆盖、完整正文／部分正文／尚未读正文的数量，不缓存另一份正文，也不跨轮累计。用户没有要求未读时不默认加未读过滤；未读全只能给已读文本的结论，不能排除其余邮件需要回应的可能。

手账工具按本轮宿主时间为事项派生 `recommendation`，过去的日期、已结束事项、日期未确认的事项不能作为主动推荐；这不会自动改写或清理账本。即使日期有效，也需尊重用户暂停决定和当前需求。显式查询历史事项仍可回答，改期和重新开启需要用户交代。
