# 安装与中断恢复

## 交付内容与支持范围

可直接安装仓库中完整的 `skills/xiaoman-setup/` 目录，也可解压发布 ZIP 后安装其中的技能。不要只复制 `SKILL.md`：`scripts/xiaoman_setup.py` 与 `assets/framework.zip` 必须一并保留。发布 ZIP 包含两个同级技能目录：`xiaoman-setup` 和 `xiaoman-journal-design`。安装技能携带安装脚本与白名单框架包 `assets/framework.zip`；设计技能携带通用选型规则、20 种组件说明和离线看板参考。框架包没有作者的 `.runtime`、账号、人设、账本、模型 key 或部署地址。

当前安装目标为 **macOS 本机**。预检要求 Python 3.12+、Node.js 22.19+、npm，以及已安装的 Codex 或 WorkBuddy CLI。用户继续使用自己现有的 CLI 登录身份与模型；脚本不要求 iMessage 账户，不更改其全局配置。没有 CLI 或未登录时，说明检测事实，使用该 CLI 正常安装／登录流程后继续，不能伪造在线状态。

## 命令

下例中的 `<skill>` 是此技能真实目录，`<target>` 是本次独立安装目录。命令中每个路径须按当前 shell 正确引用；不要原样执行尖括号占位符。

```sh
python3 "<skill>/scripts/xiaoman_setup.py" check --provider codex
python3 "<skill>/scripts/xiaoman_setup.py" install --target "<target>" --provider codex
python3 "<skill>/scripts/xiaoman_setup.py" status --target "<target>"
python3 "<skill>/scripts/xiaoman_setup.py" continue --target "<target>"
```

使用 WorkBuddy 时把 `--provider codex` 换成 `--provider workbuddy`。必要时可传 `--agent-command` 指定单个 CLI 可执行文件，不能传含 shell 片段的命令。`--port 3383` 可指定本机 Web 端口，`--runtime-port` 可另指定微信宿主端口（默认 Web 端口 + 1）；端口冲突时选择空闲端口，不杀占用端口的未知进程。`--no-start` 只安装配置，不把它报告为服务可用。

已有可验证的框架解压目录时，可用 `--source <目录>` 代替 `--archive`；源目录必须带 `SOURCE_MANIFEST.json`。不要把正在运行的私人实例当作可分发框架。

```sh
python3 "<skill>/scripts/xiaoman_setup.py" start --target "<target>"
python3 "<skill>/scripts/xiaoman_setup.py" stop --target "<target>"
python3 "<skill>/scripts/xiaoman_setup.py" service-install --target "<target>"
```

## Agent 应完成什么

1. **预检。** `check` 会校验自带框架的完整白名单、文件哈希及安装器版本，再检查本机工具；缺少资源时应取得完整发布目录。读脚本回执，区分工具缺失、CLI 未登录、端口冲突和真正可执行。必要时解释用户需要完成的登录，不索取密码或新模型 key。
2. **安装。** Codex 安装时通过官方 `model/list` 选择当前可用模型，再执行一次不调用工具的真实请求；只有返回验证文本才登记登录与模型通过，不改全局模型。框架白名单和依赖由脚本校验；安装进度落入本实例运行目录。将已有 Agent 与默认管家、观察、手账设计职责配对，设计任务显式载入同包资源。
3. **常驻并打开本机 Web。** 默认安装此独立实例的用户 LaunchAgent，直接运行 Web，再由 Web 监督宿主；核对脚本返回的实际常驻状态、地址及实例身份，不能引用作者演示站点。仅复制 plist、Web 可达或旧 PID 存在都不能证明完整常驻成功。检查页面与宿主控制端可达，再让用户在微信入口扫码。后台设计职责由宿主显式载入设计 skill 的公共规则；本地 CLI 的正常对话里主动调用 skill 则使用已配对、受租约约束的账本工具，不直接写布局文件。
4. **连接微信。** 用户完成扫码，核对实际连接状态和本人归属。未扫码可以继续使用 Web；安装无需等待可选的 Google、手机、文件或 iMessage。
5. **走真实任务。** 用户已有任务就直接推进；想了解能做什么时，按 [四个入门场景](starter-scenarios.md) 选一件生活或工作中的真事。用户在微信交代后，记录收到、回复、账本、设计布局及继续任务的真实结果。按 [验收清单](acceptance.md) 区分通过与待完成，不自动创建四件样例。

## 恢复

关闭终端、安装器退出或网络失败后，先用 `status` 查看已完成步骤与下一步，再执行 `continue`。不要删除状态文件后重装，也不要把登录成功当作尚未完成的安装步骤已经成功。新安装默认使用按实例路径区分的 macOS 用户 LaunchAgent：用户登录后启动，Web 异常退出后恢复，并由 Web 监督微信宿主；关闭终端或 Agent 窗口不停止服务。Mac 关机或用户未登录时无法继续运行。`--no-start` 不注册服务；旧独立进程实例可用 `service-install` 升级，保留原数据。

`stop` 明确暂停宿主，并停用、卸载此实例的用户服务；KeepAlive 与下次登录都不能把它悄悄拉起。只有用户明确 `start` 或 `continue` 才恢复服务及宿主。不要把“检查状态”解释为恢复用户主动停止的实例。Web 内的停止宿主按钮保持管理页面在线，但暂停意图跨 Web 重启保留。服务标签、启动参数、当前 PID、私有日志和状态必须属于本实例，不按端口终止未知进程，也不修改其他用户服务。

运行中的生活任务与安装检查点分开。重启小满后，先读取原事项及未完成任务的身份、版本与最后已确认步骤，再继续。对微信发送、预约或其他外部动作，结果未知时先查现有回执，不能盲目重放。设计结果过期则读取新版本重新选型，不能覆盖用户刚改好的事实或布局。

## 停止条件与诊断

包清单不符、目标目录归属不明、检测到不受支持的系统，或 CLI 的真实身份未确认时，保留安装状态并说明具体缺口。常规缺依赖可按平台正常流程补齐；若需要管理员权限、系统授权或本人扫码，应先完成能独立做的部分，把唯一剩余动作说清楚。

日志只保存本实例的简短错误和阶段，不把微信凭据、模型登录令牌或私人材料复制到公开问题、源码包或技能资源。

## 账号授权、自动整理与桌宠

用户要求这条链路时，核心安装完成后执行：

```sh
python3 "<skill>/scripts/xiaoman_setup.py" connect --target "<target>" \
  --sources google,github,x --google-account "<用户选定的邮箱>" \
  --desktop-pet --topic "<用户选定的话题>"
python3 "<skill>/scripts/xiaoman_setup.py" automation-status --target "<target>"
```

只列用户要求的来源；不需要全部连接才能使用。Google 使用官方 `gog`，GitHub 使用官方 `gh`，预检缺哪个就按该工具官方安装流程补齐。多个邮箱时问清账号；不索取密码。连接器返回官方授权 URL 或 GitHub device code，在官方页面由用户确认。授权窗口过期后再次 `connect`，有效账号不重复授权。授权成功后再执行同一 `connect` 命令，登记可用只读来源；已有不同来源配置会保留并报告冲突。

X 使用 OAuth 2.0 PKCE。发布方必须预先提供已注册的公开 Client ID 和回调地址；公开客户端不需要 Secret。配置位于本实例 `.runtime/connections/oauth-config.json` 或发布服务的公开应用元数据；具体格式见框架 `docs/connection-companion.md`。Google 的 OAuth 应用也需要发布方通过 gog 配好。没有应用配置时属于产品发布前提缺失，不是普通用户未填完授权表；不能把旧浏览器 cookie 当作替代授权。

`--desktop-pet` 从锁文件安装官方 dsh-pet 0.3.7 的 standalone 模式和已登记的补丁。复用其动画、窗口、菜单与宿主；小满只配对消息、聊天及反馈。不要求安装或启动 DSH 桌面应用，不改已有 DSH 桌宠。Electron 已安装时复用官方运行时，否则由官方包下载；每个实例独立配置、缓存与通道。

`connect` 会注册本实例的连接桥、桌宠和整理 worker 常驻服务。`stop` 按 worker → 桌宠 → 连接桥 → 核心服务顺序关闭；`start` 恢复自己的服务。重复执行保留账号、账本和偏好，失败时从已有检查点续装。默认保留每日 18 条整理上限与现有免打扰策略，不因验收擅自扩大额度或在夜间推送。

`installationReady` 只说明服务及真实模型检查通过；`automation.ready` 需要授权成功、真实自动入账、当前通知通道接收回执和 worker 在线。宿主接收回执不能证明桌面已显示或用户已读，最后仍需观察真实桌宠消息，并验证用户回复。微信是可选入口，有需要时独立扫码验收。
