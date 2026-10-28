# 新用户接入：微信、iMessage 与本地 Agent

部署完成后，在 Web「设置」连接执行 Agent，再到「聊天 → Mori」交代第一件事。Web 可以先开始，微信及其他授权按需要补齐，详见[首次使用](onboarding.md)。入口决定在哪里收发，Bot 决定由谁负责；连接 Codex 不会替换 DSH 或修改已有后台角色。本人验证后的微信、iMessage 与 Web 共享对应聊天，回复只回到来信入口。

## 微信：扫码 → 允许联系 → 第一条回复

| 步骤 | 用户做什么 | Morlet 负责什么 / 如何判断完成 |
|---|---|---|
| 准备 | 确认微信账号具备官方 ClawBot 插件入口；打开Morlet「设置 → 运行设置 → 微信」 | 插件使用 iLink 扫码；不需要用户填写 AppID、AppSecret |
| 启动 | 如果入口停用，点击启用微信；如果宿主未运行，点击启动服务 | 页面分别显示服务状态、微信登录状态 |
| 登录 | 点击「获取登录二维码」，用手机扫码并确认 | 等待本次扫码的成功回执；过期可以重新获取 |
| 允许联系 | 给机器人发一句话；返回页面，核对待确认用户的来信时间和 ID，点击「允许联系」 | 保存并应用白名单。未允许的来信不会执行，也不会回复；这一步不等于主人身份验证 |
| 验证 | 重新发送 `/bot-ping`，收到回复后再发送普通文字 | 前者验证通道，后者验证 Agent；第一条待配对消息不会自动当任务重放 |
| 接续 | 在「设置 → 微信消息归属」核对来信绑定，再单独点击「这是我本人」 | 验证后无 `@` 进入全员群，单 `@` 进入对应 Bot 私聊，多 `@` 在群内协作；与 Web 共用对应上下文 |

默认路由启用时，首次获准的微信来信也可自动建立独立会话。未验证账号和其他联系人不会自动并入主人的聊天；「取消本人绑定」后，未来来信恢复隔离。身份切换前会备份，存在活跃任务或混合联系人历史时拒绝合并。保存配置与服务实际加载是两件事：若页面提示未应用，应先应用或重启对应宿主。

打开现有 Web 的引导命令（不会自行登录或发送消息）：

```sh
./scripts/pa.sh connect weixin
# 服务器部署：填写自己已经部署好的地址
./scripts/pa.sh connect weixin --url https://morlet.example.com
# 只打印步骤，不打开浏览器
./scripts/pa.sh connect weixin --no-open
```

不使用 Web 时，原 CLI 仍可用：`pa.sh start` → 另一终端 `pa.sh login` → 用户扫码并发信 → `pa.sh pending-users` → 核对本人 ID 后 `pa.sh init --allow-from "实际 ID"` → 重启服务 → 用户重新发信。指定 `--allow-from` 会替换原列表，多位受信任使用者需分别重复该参数。

## iMessage：一次性的 Mac 准备是主要门槛

微信由服务端托管通道；iMessage 则需要一台持续可用的 Mac。Linux 云端本身不能登录「信息」代收发。

1. **准备独立身份。** 为Morlet准备专用 Apple 账户，在选定 macOS 用户中登录「信息」，选好Morlet的收发邮箱。可以选择现有用户，也可另建标准用户隔离；选择现有用户会替换该用户的「信息」登录。桥接程序与「信息」在同一用户下运行，Agent 可留在其他用户中，通过 Hub 接任务。
2. **准备本机运行环境。** 在消息用户内解压Morlet源码包，准备 Node.js 22.19+、Python 3.12+ 和 imsg。imsg 官方安装命令为 `brew install steipete/tap/imsg`。当前适配使用 `chats/group/watch/send`，不需要高级 IMCore bridge。
3. **完成系统授权。** 在系统设置的隐私与安全性中，给实际运行 imsg 的宿主完整磁盘访问权限；首次发送时确认允许控制「信息」。授权终端后要重启终端。终端预检通过不等于 LaunchAgent 后台进程已获授权，后台上线需单独核对。
4. **建立一条私聊。** 从自己的手机向Morlet的邮箱发一句话。不要让Morlet账户给自己发消息；自发消息会被忽略。
5. **绑定会话。** 在 Web「设置 → 连接 iMessage」选择新来信接到的手账对话，分别填写Morlet的收信地址、自己的实际发信号码或邮箱，以及 Mac 可访问的连接地址，下载配置。两方身份必须不同；双重认证手机号不等于实际 iMessage 发信地址。私聊编号可以留空，安装器会在最近 100 条会话元数据中查找指定联系人；只在唯一匹配且参与人、服务和Morlet收信地址复核通过时绑定。不读取历史正文，不上传其他联系人的元数据。未找到时先发一条新消息；多个匹配时在高级字段指定编号。
6. **安装并验收。** 在消息用户内双击 `scripts/connect.command`，选择下载的 JSON；或运行下面的命令。看到通道在线后，自己发一条新消息，确认收到回复、Web 出现对应记录。核对路线并点击「这是我本人」后，再验证无 `@` 的全员群续聊、单 `@` 的对应 Bot 私聊。安装成功、在线、实际送达分别确认。

```sh
./scripts/pa.sh connect imessage --check
./scripts/pa.sh connect imessage --config ~/Downloads/imessage-companion.json --check
./scripts/pa.sh connect imessage --config ~/Downloads/imessage-companion.json
```

第一个命令仅检查工具并打印下一步；带配置的 `--check` 还核对私聊身份。两者都不发送消息、不安装服务。没有测试发送命令，避免把安装检查变成自动外发。

消息用户的 GUI 登录会话要保持存在，可快速切回个人用户，但退出消息用户、Mac 休眠、网络断开都可能中断服务。重启 Mac 后需重新登录并核对状态。基础版只接指定私聊的文字，不接群聊或 SMS。详细身份与验收规则见 [iMessage 接入](imessage-setup.md)。

Web 按用户视角显示左右方向，回复旁区分提交、发送、送达和已读。原生「信息」跟随登录身份：个人手机上你在右、Morlet在左；桥接 Mac 登录Morlet，方向相反。首次连接以前的历史不会自动执行，重启后的未上传输入按原游标恢复；未知发送结果不会自动重发。

Apple 的登录及收发地址规则见 [Messages 官方指南](https://support.apple.com/guide/messages/set-up-messages-ichte16154fb/mac)。imsg 的安装、完整磁盘访问和 Automation 要求见 [项目官方说明](https://github.com/openclaw/imsg#permissions)，会话元数据格式见 [官方 JSON 文档](https://github.com/openclaw/imsg/blob/main/docs/json.md)。

## 本地 Agent：同机一个按钮，远程首次安装助手

首次在本机完整安装时，可以让已有 Agent 使用 [Morlet 技能包](skill-bundle.md)：安装器会将管家与后台设计一同绑定到本机 CLI。安装包功能以对应 Release 为准。下面的一键连接入口适用于已有实例增加执行端，保留原有角色，不自动重绑职责。

### Morlet Web 与 Agent 都在同一台 Mac

前提是已安装所选 CLI 并完成其登录。打开未设置 `PA_WEB_ORIGIN` 的本机 Web 页面，在「设置 → 执行 Agent → 连接 Agent」选择 Codex 或 WorkBuddy，点击「连接这台 Mac」。工作目录留空时创建 `.runtime/agent-workspaces/<provider>`；也可以填写一个已有目录。

按钮负责发现 CLI、生成独立配对、以 0600 保存配置、安装当前用户 LaunchAgent。重复点击同一默认连接不创建第二个 Agent；已绑定其他工作目录时引导使用手动连接，不覆盖旧设置。安装后等待执行端在线，在「聊天 → Mori」发送第一条任务确认 CLI 登录和执行。WorkBuddy 桌面登录不保证其 CLI 已登录。

对应命令（Web 必须先运行，端口要与当前服务一致）：

```sh
./scripts/pa.sh connect discover --json
./scripts/pa.sh web
# 保持 Web 运行，另开终端：
./scripts/pa.sh connect agent --provider codex
./scripts/pa.sh connect agent --provider workbuddy
# 可选工作目录和 Web 端口
./scripts/pa.sh connect agent --provider codex --workspace /path/to/project --url http://127.0.0.1:3083
```

该入口只安装 CLI 连接，不自动安装 Codex/WorkBuddy、不代为登录、不复制凭据，不改变 `.runtime/agent-hub.json` 的默认路由和角色绑定。同一 provider 的第二个工作目录使用手动配对；每个 endpoint 的常驻服务互相独立。

### Morlet部署在服务器，Agent 在用户 Mac

浏览器不能直接运行另一台电脑上的程序。当前源码提供的最短路径：

1. 在 Mac 准备同版源码、Node/Python 和已登录的 Agent CLI。
2. 在服务器 Web「手动连接 / 连接另一台电脑」生成私密配置。填写 **Mac 上** 的已有工作目录；连接地址使用 HTTPS。只有内网 HTTP 时，需要使用者已建立的本地 SSH 隧道，不能把远程明文 HTTP 当成安全配对地址。
3. 下载到 Mac 后，双击项目里的 `scripts/connect.command`，在原生文件选择器选择配置；也可执行下面的一条命令。
4. 返回 Web 等待该执行端在线，在设置中为 Bot 选择该执行端，再到对应 Bot 私聊验证。无需每次开网页或重启 Mac 后重新下载配置；LaunchAgent 会在该用户登录时启动。

```sh
./scripts/pa.sh connect agent --config ~/Downloads/agent-companion.json --check
./scripts/pa.sh connect agent --config ~/Downloads/agent-companion.json
```

macOS 如要求确认脚本打开，由用户完成系统确认；安装器不会绕过系统限制。配置只在对应 Mac 用户的私有 runtime 保存，页面和命令输出不展示 token。已有默认本机连接离线时，可用 `.runtime/local-agent-setup/codex.json`（或 `workbuddy.json`）作为 `--config` 重新安装；重装会重启对应连接，先确认没有正在执行的任务。

**仍未达到的目标：云端 Web 点一下，就自动唤起未安装助手的 Mac 并完成绑定。** 目前没有签名/公证的一体化安装包，也没有注册 URL scheme 的设备配对交接。即使已有服务连接用的 Mac 助手，它也尚不接收 Agent 安装命令。下一阶段应在统一 Mac 助手里完成设备发现、用户选择工作目录、短期一次性配对、登录引导和后台上线验证；不能把下载配置称为已绑定。

## 当前源码的状态与剩余体验缺口

| 项目 | 已具备 | 尚需完成 |
|---|---|---|
| 微信 | 扫码、允许联系、状态反馈、CLI 与 Web；Hub 微信/Web 统一路由代码 | 分步引导已集中；每个部署仍需本人验证真实首次收发 |
| iMessage | 两方身份校验、私聊自动定位、持久收发凭据、来源回信、桥接及送达状态、统一会话协议 | 专用账户和系统授权需真人操作；每个实例仍需真实任务闭环验收，专用身份与系统权限仍需真人准备 |
| 同机 Codex/WorkBuddy | 一个按钮或命令配对、默认工作目录、常驻安装、失败回滚 | 登录状态目前不在预检中验证，第一条任务仍是实际登录/执行验收 |
| 云端接本地 Agent | Web 发配对配置、Mac 双击或一条命令安装 | 初次源码/依赖安装、HTTPS/隧道设置，以及云端一键交接尚未产品化 |

产品引导应始终把「已安装 → 待登录/授权 → 待配对 → 等待在线 → 可执行/可收发」分开。当前分步向导已集中已有步骤；统一 Mac 安装包和云端唤起仍需后续交付。不要把 CLI 存在、服务创建成功或心跳在线直接显示成账号和业务已经验证。
