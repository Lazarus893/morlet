# 框架分发与实例配置

小满是消息入口与下游 Agent 之间的中间层。发布物包含应用框架、适配器、通用默认值、模板和使用文档。用户选择哪个 Agent、怎么分工、使用哪些账号/设备/地址，以及个性化提示和技能，都属于安装实例的数据。

## 配置放在哪里

| 配置 | 本机位置 | 使用方式 |
| --- | --- | --- |
| 使用者、Agent/模型、白名单、设备、能力、提醒偏好 | `.runtime/pa.json` | Web 配置或 `pa.sh init`；`configure` 生成运行配置 |
| DSH 模型提供方、模型名称 | `agent.model_provider`、`agent.model` | 提供方必须已在 DSH 注册；模型名不会修改外部 CLI 登录 |
| 人设前后缀 | `persona.prefix`、`persona.suffix` | DSH system prompt；不改变沙箱和审批机制 |
| 主角色与设计角色提示 | `.runtime/personalization/AGENTS.md`、`life-journal-designer.md` | 首次从通用模板初始化；再次 configure 保留修改 |
| 个人技能 | `.runtime/local-skills/<名称>/` | `pa.sh import-skills --source <目录> <名称>` 私有导入并登记 |
| Agent / iMessage 连接参数 | `.runtime/agent-companion*.json`、`imessage-companion*.json` | 每个运行端和通道独立配对、撤销；不随包提供 |
| OAuth、连接助手、账号状态 | `.runtime/connections/`、`.runtime/connection-companion.json` | 各安装实例完成登录；文件书签仍在 macOS 沙箱 App 私有容器 |
| 服务地址、端口、工具路径、密钥 | `.env` 或安装服务的私有环境配置 | 通用变量见 `.env.example`；真实值不填写到模板 |
| 部署用户、目录、地址、端口 | `.runtime/deployment.json` | `python3 scripts/render_deployment.py` 只生成本机文件 |

`agent.model` 为空时使用适配器的通用默认值。可运行 `pa.sh init --model <名称> --model-provider <DSH提供方>`。角色提示中的通用业务行为可修改；权限与审批仍由执行适配器、操作系统和通道策略执行，不能靠改提示词绕过。

从较早安装升级时，现有生成的人设前后缀与工作区人设会先保留为私有配置，不因通用模板变化丢失。之后在人设私有源文件修改，再运行 configure；工作区的“本机配置”段由程序维护。迁移项目目录后重新 configure 生成路径，复制产品更新时保留原 `.runtime`。

个人导入技能不写入源码 `skills/`。新增产品内置技能需单独审阅，再明确加入发布清单；禁止把用户自己导入的技能直接作为产品资源提交。

## 发布清单

`config/distribution.json` 是逐文件清单，没有目录通配符。`pa.sh pack` 仅归档清单里的文件，并写入内容 SHA-256 的 `SOURCE_MANIFEST.json`。新增源码文件需要明确加入清单。

运行目录、环境文件、私人记忆、会话/任务、密钥、个人技能、账号授权、部署与验收记录、设计探索稿均不进入包。文件即使误放在 `config/`、`docs/`、`skills/` 或 `scripts/`，未列入清单也不自动分发。清单不能列入已知私有目录、数据库或密钥文件；符号链接和越界路径被拒绝。

框架常量保留在代码中，例如身份核验、来源回复、任务去重、审批归属和取消确认；不为“可配置”提供绕过这些机制的开关。Agent 的业务职责存为实例绑定，共同会话、任务和来源路由由 Hub 管理；宿主内可使用 DSH 或用户已有的本地 CLI，远程后台职责仍有单独边界。

## 发布前验证

```sh
./scripts/pa.sh check
python3 -m unittest discover -s tests -v
./scripts/pa.sh pack
```

分发 `dist/personal-agent-source.zip`，不直接压缩工作目录。分发测试覆盖未列入的配置/个人技能排除、路径和符号链接拒绝、ZIP 内容校验、解压后的全新实例以及本机配置保留。所有这些测试都不使用真实账号或发送消息。

这是框架源码包；签名安装包、自动更新与多租户公开服务需要各自的发布与验证流程。

面向用户已有 Agent 的交付可执行 `python3 scripts/package_skills.py` 生成 `dist/xiaoman-skills.zip`。包内包含安装配置和手账设计两个 skill、通用设计与离线看板资源，以及同一白名单构建的框架载荷。载荷只在打包时生成，不回填到源码清单形成递归包。使用与验收见[技能包](skill-bundle.md)。
