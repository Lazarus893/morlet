# 连接与权限中心

小满的「连接」页面提供 Google 套件、本地文件、手机、GitHub、X 五个入口。云端保存小满的授权意图和状态；当前 Mac 的连接助手发起官方 OAuth 与系统文件授权，凭据留在本机；成功后才持续检查状态。这条连接助手链路负责授权与状态，不向远端 Chief 提供私人正文或文件。

独立本地 Agent 安装另有可选的 `xiaoman_sources` 业务读取工具：用户明确要求复用既有登录后，登记本机 Google 日历、邮件正文、本人 GitHub 待审请求和指定文本目录，Chief 才能实际读取。配置和凭据留在 Mac，详见 [安装技能包](skill-bundle.md) 与 setup skill 的 `references/existing-sources.md`。本实例 Web 撤回 Google、GitHub 或文件入口时，该类读取同样停止；普通“未连接”状态不会代替用户明确配置的本地来源授权。Mac 连接助手的配对与本地 Agent 的目录范围分别管理，不继承其他 App 的文件书签。Drive、X、浏览器和手机业务执行不在此只读工具内。

## 状态与权限

每项分别显示未连接、需要准备、等待授权、检查中、已连接、部分权限、授权过期、离线、异常或已撤回。状态检查由服务器和 Mac 助手持续运行，网页关闭不停止监控。Mac 每两秒领取授权命令；普通权限检查每15秒，X API每60秒，单项检查有超时；90 秒无新心跳或单项结果会清除「已验证」并标为离线。Mac 休眠会离线，醒来后重新检查。正常心跳不会改变表单版本；多窗口同时修改授权时拒绝旧版本并保留草稿。

「已允许」表示小满的使用授权，「已验证」表示近期实际检查确认的权限，两者不互相替代。撤回只停止小满使用这一入口，保留 Mac 上其他应用的 CLI 凭据。撤回、重新配对、服务重启都使旧任务的结果失效，避免迟到的 OAuth 结果恢复旧权限。

## 五个入口

| 入口 | 当前检查与授权方式 | 尚需使用者完成 |
| --- | --- | --- |
| Google | 点击授权后在 Mac 启动 Google 官方 OAuth，申请 Gmail、日历、Drive、联系人、Docs/Sheets 只读范围；官方链接同步到 Web | 填写账号，在 Google 官方页面选择并同意。当前 Mac 已有 gog OAuth client；其他安装由部署方一次性配置应用，不能把每个用户当开发者 |
| 本地文件 | 默认下载、用户目录、文档，只需在 Mac 原生弹窗确认；用户目录含下载和文档。系统预设主目录，保存只读 security-scoped bookmark | 无需逐个找目录。已有有效主目录授权时只显示确认框；没有时在系统预设主目录窗口确认。自定义选择收进“更改访问范围”；取消不授予新权限 |
| 手机 | 明确连接时识别唯一已授权 Android 并保存本机配置；后续只读检查配对、连接、系统输入权限及有效录屏授权 | 「管理手机权限」→「打开手机授权页」，在手机点击「授权录屏」并确认系统弹窗。检查不启动任务或录制；iPhone WDA 目前仅验证连接 |
| GitHub | 每次明确授权启动 `gh auth login --web` 官方设备授权，成功后验证账号和仓库列表 API | 在 GitHub 官方页面同意，Web 自动更新；设备码仍由官方流程提供。实际授权范围以 GitHub 同意页为准 |
| X | 官方 OAuth2 Authorization Code + S256 PKCE，Mac loopback 接收回调；验证身份和只读内容 API，支持 token 刷新 | 部署方先配置 X 开发者应用 client ID 及精确回调，然后使用者在 X 官方页面同意。不再借用浏览器 Cookie |

OAuth 链接仅允许各服务的官方域名与路径，device code 可选。授权完成、拒绝或超时会自动更新页面；检查是次要操作，不再要求使用者主动确认“我已授权”。拒绝不会被误报为一直等待。取消/撤回停止旧授权流程并拒绝迟到结果。

文件 App bundle 在 `.runtime/macos-file-access/`，书签在该 App 的 macOS 私有 container。常用范围与自定义范围分别验证；任意自定义目录不能当作主目录授权。授权属于文件 App，不能自动授予 Node、DSH 或云端读取能力；未来业务读取须通过同一 App 的受控接口。完全磁盘访问入口打开 macOS 系统设置，需要真人手动确认，且不会解除 App Sandbox 或扩大所选范围；不宣称全盘已获得权限。当前 Mac 使用本机 ad-hoc 签名，源码升级可能需要重新选择；正式分发需配置稳定签名身份。

原始 CLI 输出、令牌、文件路径不上传。服务器只保存配对令牌的 SHA-256；配对和授权操作仍要求同源页面会话与 CSRF。

## Mac 助手运行

私有 `.runtime/connection-companion.json`（600）保存 loopback tunnel endpoint、publicOrigin、配对 token 和轮询间隔。此文件与运行状态不进入源码包。服务器不能直接获得 Mac 的系统权限。

本机启动命令：

```bash
./scripts/pa.sh bridge
```

该命令需要已经配对并写好的私有配置；它不是扫码或配对向导。保持助手运行才能更新状态。

已配置的 Mac 可以安装用户 LaunchAgents，登录后自动运行：

```bash
python3 scripts/install-connection-companion.py \
  --ssh-host your-user@your-server.example --ssh-port 22 --remote-port 3083
```

安装器先构建并签名本机文件授权 App，再安装两项服务：`com.xiaoman.connection-tunnel` 和 `com.xiaoman.connection-companion`。SSH 加密隧道监听本机 `127.0.0.1:3093`，转发至服务器 loopback 网关；配对令牌不经内网明文传输。组件进程退出会由 launchd 重启，断网由 SSH 保活退出重连。日志只记录脱敏的固定状态码。

Mac 助手凭据只允许 `/api/connections/bridge` 与 `/api/connections/bridge/report`；不能调用配置、微信、手机执行或手账修改接口。内网入口不设小满账密登录，应用仍严格校验 Host、页面会话和 CSRF。没有扩大 DSH 沙箱或审批范围。

## 验收范围

### 私有 Nango 的浏览器地址

私有 `.runtime/connections/nango.json` 采用 `config/nango.example.json` 的配置。`baseUrl` 是小满服务器访问的 Nango API origin；`publicApiOrigin` 是使用者浏览器可访问的 API origin，默认与 `baseUrl` 相同；`connectOrigin` 是 Connect UI origin。浏览器通过 SSH loopback 转发访问时，两种 API origin 可以不同。配置只接受 HTTPS 或 HTTP loopback，不允许凭据、路径、查询参数或片段。

适配器在新连接与重连链接上设置 Nango Connect UI 官方支持的 `apiURL` 参数，并用受信的 `publicApiOrigin` 覆盖上游同名参数。Nango 0.71.13 的预构建 Connect UI 默认调用 `api.nango.dev`；只修改服务端地址不会改变此默认值，私有会话会被误报为过期。部署验收须确认 `/connect/session`、集成与 provider 查询以及 `/connect/telemetry` 都使用配置的私有 API，不修改官方静态包，不让私有会话令牌进入云端 API。服务端管理密钥仍仅从指定环境变量读取。

测试使用临时 SQLite、受控 CLI fixture 和隔离浏览器，不发送微信、不控制真实手机。涵盖状态超时、独立权限失效、重启、撤回迟到结果、换配对、CAS、凭据拒收、HTTP 授权边界及响应式/减少动画。真实账号授权必须由使用者在官方授权页完成，不能用模拟测试代替成功声明。
