# 用现有本地 Agent 安装小满

分发物 `xiaoman-skills.zip` 包含两个可发现的 skill：

- `xiaoman-setup`：预检、安装、配置本机职责、启动、失败留证和继续安装，并提供生活与工作各两个入门场景。
- `xiaoman-journal-design`：任务理解、20 类组件契约、看板组合、状态与动效资源。

用户自己选择技能目录和独立安装目录。技能包不复制 Agent 登录凭据、不覆盖全局 `AGENTS.md`、模型或沙箱设置，不要求额外模型 key 或 iMessage 账户。当前适配范围为 macOS 的 Codex 和 WorkBuddy CLI；其他 Agent 与其他操作系统尚未验收。DSH 是包内锁定版本的微信通道宿主，日常模型请求交给用户既有 CLI。

## 四个入门场景

安装后的 Agent 按 [场景指南](../skills/xiaoman-setup/references/starter-scenarios.md) 引导一件真实任务；用户已有明确任务时直接推进。每个场景含可复制交代、最小输入、数据范围、阶段性组件组合、继续任务的说法和完成标准：

| 领域 | 场景 | 主要体验 |
| --- | --- | --- |
| 生活 | 生日筹备 | 准备清单、真实候选与预算，改期后接着做 |
| 生活 | 晚餐与采购 | 份量与食材缺口，采购状态和烹饪步骤 |
| 工作 | 邮件日程整理 | 读正文后判断本人待办，核对日程与截止 |
| 工作 | 项目会前准备 | 指定材料的进展、风险、待决问题与来源 |

两种生活场景可从聊天开始；工作场景按需复用已授权来源，也可先整理用户提供的材料。不会预填四件 mock 事项、连接所有服务或默认开启定时推送。管家负责业务材料与入账，设计职责的 [看板组合](../skills/xiaoman-journal-design/references/dashboard-patterns.md) 提供对应取舍，并由现有宿主显式装载。技能资源可用与四场景真实流程验收分别记录，不能混为一项完成结论。

执行 Agent 每轮通过 `xiaoman_journal list` 接收随包的 [办理与续做规则](../skills/xiaoman-setup/references/runtime-workflows.md)，旧会话恢复也读取当前规则。日期相关规划按已授权日历核对，预算等已知材料保存为结构化字段；保存回执区分业务保存、设计受理和模型完成，普通勾选则继续使用有效布局。

## 构建与载荷边界

```sh
python3 scripts/package_skills.py --output dist/xiaoman-skills.zip
```

构建先调用既有 `package.py`，严格使用 `config/distribution.json` 的逐文件白名单；生成的框架 ZIP 不登记为源码，再在打包阶段嵌入 `skills/xiaoman-setup/assets/framework.zip`。因此不会把载荷递归打进自身。两个生成文件逐一登记在 `skillGeneratedFiles` 中，与框架源码 `files` 分开；构建同时将安装器和载荷写回 `skills/xiaoman-setup/`，使该目录可直接安装。发布前必须重新构建，不能手改生成的副本。

安装脚本在包构建阶段从审核过的 `scripts/xiaoman_setup.py` 复制到 `skills/xiaoman-setup/scripts/`。`BUNDLE_MANIFEST.json` 记录所有技能资源和载荷的 SHA-256；载荷内 `SOURCE_MANIFEST.json` 与 `config/distribution.json` 的路径、大小和哈希必须完全相符。

运行数据、账号、token、微信凭据、私人记忆、日志、任务截图和录屏均不随技能包分发。产品介绍仅包含逐文件登记的演示素材。哈希可发现损坏和非预期文件，不代表发布者数字签名；只运行来自可信发布者的技能包。本版本不从任意 URL 下载并执行安装代码。

## 用户的第一次安装

将完整 `skills/xiaoman-setup/` 复制到用户选择的技能目录（包含 `scripts/`、`assets/` 和 `references/`）；只装 setup 即可，设计技能随框架安装。也可以从 ZIP 安装两个同级技能。让用户已有的 Agent 阅读 `xiaoman-setup/SKILL.md`，明确用户选择的安装位置，然后运行：

```sh
python3 /chosen/skills/xiaoman-setup/scripts/xiaoman_setup.py check --provider codex

python3 /chosen/skills/xiaoman-setup/scripts/xiaoman_setup.py install \
  --target /chosen/apps/xiaoman --provider codex --port 3383
```

`--agent-command` 可指定一个已有 CLI 的可执行文件路径，路径包含空格时需正常 shell 引号；不接受在该字段拼接命令参数。WorkBuddy 使用 `--provider workbuddy`，按 PATH 中的 `codebuddy`、`cbc` 或已适配的应用内 CLI 查找。

预检先校验 skill 自带的框架清单和文件哈希，并核对安装器副本；缺资源或混用了版本会明确报错，不访问作者仓库补文件。预检要求 Python 3.12+、Node.js 22.19+ 与 npm；只检查安装，不执行模型，更不把 `--version` 或可执行文件存在当成已登录。依赖按锁文件运行 `npm ci`，Python 依赖安装到实例自己的 `.venv`。依赖安装可能需要正常网络，载荷本身离线可用；`--no-start` 只准备依赖和配置，不启动服务、不进入扫码。

`--port` 指定 Web 端口，`--runtime-port` 可另行指定微信宿主端口；省略时使用 Web 端口加一。两端口必须不同且空闲；冲突时保留原服务并给出错误。

安装会：

1. 在全新目录解包并核对每个文件；已有实例不合并、不覆盖。
2. 保存私有、原子写入的 `.runtime/setup-state.json`，逐步记录依赖和配置完成情况。
3. 用 `configure-local-agent.py` 把管家、观察与手账设计职责绑定到所选本地 CLI，再生成此实例的微信宿主配置。
4. 注册并启动本实例的 macOS 用户 LaunchAgent，直接运行回环 Web 服务（默认 3383）；Web 监督微信宿主（默认下一端口 3384），确认宿主控制端真实可达。
5. 返回 Web 入口及剩余步骤：本人扫码、确认本人发信身份、执行一件真实生活任务。

常驻服务使用按实例绝对路径计算的独立 `com.xiaoman.web-<hash>` 标签，登录后启动、异常退出后恢复，15 秒限速避免崩溃忙循环；这是用户服务，Mac 关机或用户尚未登录时不运行。关闭终端或 Agent 窗口不会主动停止它。服务只带必要的路径与实例端口环境，不复制模型 key、令牌或全局设置；plist 和日志均为本人私有文件。

新 `install`、`continue` 默认安装该常驻服务；`--no-start` 不注册、不启动服务。已有旧式独立实例可以运行 `service-install` 升级，保留配置和账本。已有实例的 `start` 会按其模式继续：有 LaunchAgent 时恢复该精确用户服务，没有时保留原独立进程行为；推荐旧实例完成一次常驻升级。其他实例、现有小满生产服务及用户原 Agent 会话均不停止。

同一浏览器同时打开多个本地实例时，页面会话 Cookie 按服务端口区分，切换页面不会覆盖另一实例的会话；各自的页面会话和 CSRF 校验继续独立生效。

也可以用 `--source /chosen/clean-framework` 代替 `--archive`。该目录必须是含 `SOURCE_MANIFEST.json` 的纯净解压框架，不能是带 `.runtime`、`node_modules` 或其他额外文件的开发目录。

## 中断后继续

```sh
python3 /chosen/skills/xiaoman-setup/scripts/xiaoman_setup.py status --target /chosen/apps/xiaoman
python3 /chosen/skills/xiaoman-setup/scripts/xiaoman_setup.py continue --target /chosen/apps/xiaoman
python3 /chosen/skills/xiaoman-setup/scripts/xiaoman_setup.py stop --target /chosen/apps/xiaoman
python3 /chosen/skills/xiaoman-setup/scripts/xiaoman_setup.py start --target /chosen/apps/xiaoman
python3 /chosen/skills/xiaoman-setup/scripts/xiaoman_setup.py service-install --target /chosen/apps/xiaoman
```

安装进程锁防止同一实例并发继续；失败步骤下次重试，已完成步骤跳过。私有 `.runtime/logs/setup/` 留存命令输出；返回结构只给失败步骤和证据路径，不把凭据或全部日志贴到聊天里。状态是 `running` 的安装步骤也会在继续时重做，以适应中途被关闭的安装进程。

常驻模式下，`status` 从精确 LaunchAgent 读取当前 PID，并核对完整 Web 启动命令，不把旧 PID 或仅有 plist 当成已在线。显式 `stop` 先暂停宿主，再 `disable` 与 `bootout` 此实例服务；KeepAlive 和下次登录都不会推翻这次停止。显式 `start` 会重新 `enable`／加载，并清除宿主的人工暂停。Web 界面的宿主停止只暂停宿主，管理页面继续保留；异常退出与人工暂停分别处理。启动遇到监督器暂时占用操作锁时，有界等待并重新验证本实例身份。安装或启动失败会留下私有证据与下一步（`service-failure.json` 保留原始原因，继续安装不会覆盖它），不把扫码、模型登录或真实消息闭环算作已完成。

常驻升级失败时会恢复原服务定义及升级前实际运行／暂停意图，失败证据仍保留；原本暂停的宿主不会在回滚时启动。Web 不可达时，停止流程只临时启动禁止自动执行的控制页面，交由 Node 以本实例私有宿主记录完成核验和停止；控制 socket 尚未出现不能被当成宿主已退出。

运行期的微信会话、首件事草稿、已确认手账与设计状态由小满的正式持久层恢复，安装器不复制或重新发送这些请求。启动失败不重新初始化用户数据。

Web 意外退出时，微信宿主可能仍在运行。`start` 会先恢复管理 Web，再通过此实例私有控制 socket 识别既有宿主；不会把它占用的宿主端口误当成其他服务而卡住恢复。只有本实例宿主明确离线、需要新启动时才要求宿主端口空闲。

`stop` 先核对 Web PID 的完整命令和实例路径，正常停止其拥有的宿主，再结束 Web。对于 Web 退出后留下的宿主，只恢复管理 Web、不启动新业务；仅在私有 socket 的权限与所有者、实际控制回执 PID、同用户、完整 DSH 启动参数和本实例工作目录均吻合后，才向该单个宿主 PID 发送正常停止信号，并确认控制 socket 已离线。不能证明归属时保留进程及管理页面并报告原因，不按端口、模糊名称或未知进程组终止服务。PID 已被别的进程复用时不发终止信号。

## 验收与诚实状态

安装脚本不会代替本人扫码、登录、验证码或授权。`ready: false` 与 `agentLogin: not_verified` 表示安装结果尚不能证明真实端到端通过；它们不会因进程启动或 CLI 帮助输出变成成功。

用户明确要求复用本机已有数据时，按 setup skill 的 `references/existing-sources.md` 使用 `configure-existing-sources.py` 登记已有 Google、GitHub 和指定资料目录。凭据继续留在各自 CLI／系统钥匙串；只把命令、已选账号和允许的根目录保存到本实例私有 `.runtime/local-sources.json`。核心安装不强制连接这些可选来源。

Chief 的 `xiaoman_sources` 提供受当前任务租约约束的只读日历、邮件检索与正文、Drive 检索与元数据、Docs 正文、Sheets 有界范围、Contacts 关键词查询、本人待审 PR、公开关注仓库更新、近期文件与文本读取。不会调用通用 shell、发邮件、创建日程、修改仓库或操作手机；来源正文不作为指令。OS 不允许读取的目录直接返回权限问题，不继承文件 App 的安全书签。当前整套本地安装可直接复用本机 CLI；云端经 Mac 读取需显式配对与操作白名单，配置见技能中的 [已有来源](../skills/xiaoman-setup/references/existing-sources.md)。X、浏览器与手机仍须各自业务适配及具体任务的授权，不能仅凭工具安装／连接状态声称已经执行。

新线程从首次调用注册稳定完整工具集。已有原生 Codex 线程不能通过恢复追加新工具；升级后对需要新来源的任务应明确新建对话，原会话与账本保留。

最低真实验收应逐项记录证据：

- 全新目录不含原用户数据、额外 key 或 iMessage 配置；四个默认职责均由所选本地 CLI 承担。
- 微信扫码后确认本人身份；从该微信交代一件生活事，记录可信入站与实际 Agent 执行回执。
- 用户确认后入账；设计 Agent 使用随包设计资源提交有效布局，Web 显示对应真实组件；不能以基础投影代替设计成功。
- 关闭页面或重启此实例后，回到同一件事和原生会话继续，既有草稿与已确认记录保留，没有自动重复提交。
- 缺失 CLI 登录、任务失败、微信待扫码、设计失败和端口冲突能保留内容并说明下一步。

隔离测试替换依赖安装与服务调用，覆盖载荷校验、目录安全、中断继续和 PID 归属，不发送真实微信、不控制真实手机、不注册真实 LaunchAgent。真实新账号扫码与真实消息收发需要本人完成相应步骤，再保存独立证据；不能用上述测试冒称已经通过。
