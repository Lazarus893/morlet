# 私有连接与远程会话

小满使用 Nango 管理第三方授权，用 DSH Remote 连接用户选择的原生 Agent 会话。它们分别部署；连接服务上线、账号授权、远程设备在线是三个独立状态。

## Nango

将 `config/nango.example.json` 复制到 `.runtime/connections/nango.json`，设为 0600 并由小满服务用户持有。删除尚未配置的 integration；`instanceId` 是稳定的实例隔离标识。`NANGO_SECRET_KEY` 仅通过服务环境注入，不能写进浏览器、Git、日志或源码包。

环境变量必须同时提供给 **Web 与实际执行 Hub 资料工具的进程**。内置 DSH Host 在 `xiaoman-dsh.service` 内直接调用 `xiaoman_sources`，不会借用 Web 进程的环境。默认两个 systemd 模板共用安装目录下的私有 `service.env`，可在该文件配置 `secretKeyEnv` 指定的密钥；若将 Nango 单独保存为 0600 环境文件，则须为 `xiaoman-web.service` 和 `xiaoman-dsh.service` 分别添加引用该文件的 `EnvironmentFile` drop-in，保留各自原有环境。其他部署方式也要检查真正执行云路由的宿主进程，不能把服务密钥传给浏览器或下游模型。

更新后先确认没有运行中任务，再重启受影响的宿主，检查实际 Node 进程是否具有所需变量；只记录存在性，不打印值。验收必须经正常 Agent 任务调用 `xiaoman_sources` 并检查 `sourceRequest` 回执中的 Nango 执行与真实正文覆盖。Web 显示“已连接”，或诊断脚本临时传入密钥后读取成功，都不能证明 Agent 业务链路可用。

私有 Nango 服务依赖独立的 Postgres 与 Redis。使用上游镜像的固定 digest，保留数据卷与 `NANGO_ENCRYPTION_KEY`，只在 loopback 暴露 API 与 Connect UI。远程浏览器可通过 SSH 转发访问；`NANGO_PUBLIC_SERVER_URL` 与 `NANGO_PUBLIC_CONNECT_URL` 必须是该浏览器能到达的地址，Google/X 的 OAuth 回调必须匹配。不要暴露数据库、Redis 或无访问控制的管理台。

`baseUrl` 是小满后端访问的 API 地址；`publicApiOrigin` 是浏览器访问同一私有 API 的地址，`connectOrigin` 是授权页面地址。Connect 链接通过官方 `apiURL` 参数指定 `publicApiOrigin`，避免私有授权会话误发到官方云端；SSH 转发场景下，这两个 API 地址通常不同。

部署验证版本为 Nango 0.71.13（`nangohq/nango-server:hosted` 对应 digest 见实例私有部署回执）。该版 API key 由环境创建并存储，**不能假设设置 `NANGO_SECRET_KEY_PROD` 就会配置它**。从自己的管理台获取环境密钥，写入私有服务环境。免费自托管适用本项目使用的 Auth / Proxy；未把商业版 Sync、托管 MCP、工作流当作已开通功能。

在 Nango 配置开发应用后，于小满「连接与权限」授权：

| 服务 | 已接入的读取能力 | 授权准备 |
| --- | --- | --- |
| Google | Gmail 搜索与完整正文/线程、Calendar、Drive、Docs、Sheets、Contacts | Google OAuth 应用；只读 scopes，文档实际访问读取时再次验证 |
| GitHub | 待审 PR、自己的/关注/收藏仓库、通知、发布说明、提交 | GitHub OAuth 或官方 `github-pat` integration；PAT 在 Nango 的授权页提交 |
| X | 当前账号与关注时间线 | X OAuth 开发应用及服务商可用的 API 额度 |

具体 scopes 与 API 路径在 `plugins/connections/nango-catalog.mjs`、`plugins/agent-hub/nango-sources.mjs`。新增服务可配置固定读路径、查询参数及 HTTPS 基址；该能力是后端接入点，不会自动生成任意第三方服务的业务工具。写入必须有明确的 `authorizeWrite` 回调；当前产品没有开放任意写入代理。

每次读取都校验账号归属、权限、连接代际与任务 lease。切换到 Nango 的源不会回退读取同名本地 CLI 账号。撤回授权立即停止小满访问，Nango 不可达时持久保存凭据清理工作并显示待清理状态。OAuth 凭据不会进入 Widget、模型上下文或前端。

自动阅读沿用同一套候选、正文解析、偏好、节流与结果回报机制。云端负责 Nango 读取，已配对的观察 Agent 仍负责分析；因此后台分析仍取决于该 Agent 在线。普通云数据查询不依赖 Mac 心跳。本地文件和手机继续使用各自的授权链路。

云邮件发现每次最多返回 20 封，并保留截断标记；这不代表扫描了完整收件箱。

## DSH Remote

安装与主 DSH 隔离的 Remote Client Host，配置见 [DSH Remote](dsh-remote.md)。示例复制到 `.runtime/dsh-remote.json`，权限 0600；凭据文件同样只允许本实例用户读取。首次可省略 `targetDeviceId`，页面只列真实授权设备。选择设备会保存目标，后续调用始终固定该设备。

已接设备、工作区、会话列表/创建/搜索/重命名/分叉、历史、模型与技能、队列、继续对话、停止、单次审批、实时事件和受限文件读取。连接页只展示常用动作，其余使用同一套 owner 验证后的固定 API 操作。终端、任意设置写入不在该接口中。原生会话控制需明确设置 `allowSessionControl: true`。

DSH Remote 目前不能注入小满每轮业务工具与 guard，因此不会冒充可执行 Widget 任务的 Hub endpoint。任务、跟进和结果回报仍走已有 Hub provider；这是上游接口边界，不能靠移除审批来绕过。中断连接后的写入结果显示待核对，不自动重发 prompt 或审批。

## Codex 常驻连接

已有 Codex provider 默认复用一个常驻 `codex app-server`（stdio），每轮保持独立 thread/turn 与审批归属。可在 Agent 实例配置中选择：

```json
{"codex_connection":{"transport":"unix","socket_path":"/absolute/private/codex.sock"}}
```

或使用已有 SSH 主机别名：

```json
{"codex_connection":{"transport":"ssh","ssh_host":"my-private-host","remote_command":"/absolute/path/to/codex"}}
```

socket、SSH 别名和账号均属于实例配置。真实转发的是原生协议，未引入 shell prompt 拼接；连接中断不重放已接受的任务。关闭 companion 会释放其连接，空闲连接按期限回收。

## 验收

运行 `./scripts/pa.sh check`、`python3 -m unittest discover -s tests -v` 及 Node 测试。重点包括 `nango*`、`cloud_*`、`dsh_remote`、`codex_persistent`、`webui`；浏览器流程在 `tests/remote_connections.browser.mjs` 与 `tests/connections.browser.mjs`。测试使用隔离账号/HTTP fixtures，不发送微信、不操作真实手机、不提交真实模型任务。私有服务另外执行健康、认证、授权会话创建和原生只读连接 smoke，记录“待账号授权/待设备注册”而不伪造连接成功。
