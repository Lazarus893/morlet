# 当前 Mac 的连接状态 Companion

云端小满的「连接」页管理 Google、本地文件、手机、GitHub 和 X。当前 Mac 上的 companion 通过 SSH 隧道领取用户在页面上的连接命令，只回传状态、账号名称、权限检查结果和短期 GitHub 授权码。Google、GitHub、X 的登录凭据始终留在 Mac 上；Google 与 X 的短期官方授权链接也同步到 Web，不含 token 或 secret。

## 启动与配置

本机需要 Node.js 22.19+、Python 3，以及对应服务已有的 `gog`、`gh`。文件选择助手通过本机 Swift 编译安装；X 使用官方 OAuth/API，不读取浏览器 Cookie。缺工具会显示「需要配置」，不会自动安装或替换登录凭据。手机使用项目 `.runtime/pa.json` 中的设备配置。

配对安装流程写入本机私有配置；`scripts/install-connection-companion.py` 读取这份配置并创建 LaunchAgent。SSH 隧道只绑定本机回环地址。配置保存在 `.runtime/connection-companion.json`，权限必须为 `0600`，不加入 Git：

```json
{
  "endpoint": "http://127.0.0.1:3093",
  "publicOrigin": "http://your-server.example:3083",
  "token": "云端配对产生的64位十六进制token",
  "intervalMs": 15000
}
```

手动启动：`node scripts/connection-companion.mjs`。可使用 `--config <私有配置路径>`；`--once` 只运行一轮，退出时会取消仍在进行的登录流程，不能代替长期进程。

## 各入口的真实含义

| 入口 | 本机动作 | 验证边界 |
| --- | --- | --- |
| Google | 明确授权时 `gog auth add <email> --readonly --drive-scope readonly --force-consent`，打开本机官方页面并提取经过严格校验的授权 URL | 用户完成后校验 refresh token 与 OAuth scopes；只读服务 API 的业务工具仍待接入 |
| 本地文件 | `Xiaoman File Access.app` 的 `authorize-defaults` 确认预设下载/用户目录/文档范围，`probe-defaults` 验证有效主目录授权；自定义 `authorize`/`probe` 保留 | 私有只读书签不上传；Node/Chief 不继承权限。`settings` 只打开完全磁盘设置，不授予或验证全盘权限 |
| 手机 | 明确 `connect-device` 识别唯一 Android 并保存私有配置；`device` 只读检查连接与权限；明确 `phone-settings` 打开已安装助手的设置页 | 配置优先原设备且忽略环境中的设备ID覆盖；系统 INJECT_EVENTS 授权和助手有效 MediaProjection 分开验证。录屏由用户在手机确认；不开始任务或录制，iPhone 只验证连接 |

手机授权页通过 `am start -W` 等待首屏并检查助手进程仍存活；系统收到启动请求本身不等于页面可用。诊断启动后退出时查看 Android crash buffer，不将启动回执当成录屏授权或运行成功。
| GitHub | 明确授权启动 `gh auth login --web`，随后 `gh api user` 与 `gh api user/repos?per_page=1 --jq length` | 只传账号和权限结果，不返回仓库名称。官方同意页的实际 scopes 可能包含 repo/read:org/gist |
| X | 官方 OAuth2 PKCE、Mac本机HTTP回调、token refresh、只读API | 身份和内容读取分别验证；不发帖或互动；X应用未配置明确返回 oauth_client_missing |

### X 应用配置（部署方一次性）

普通用户仅点击「授权 X」并在 X 官方页面同意，不填写 Client ID、Client Secret，也不需要拥有 Developer 应用。

部署方注册 X Native App（public client），将回调精确设为 `http://127.0.0.1:3094/oauth/x/callback`，在 Web 服务的私有环境中设置 `PA_X_CLIENT_ID` 后重启服务。已配对 Mac 自动获得 public client ID 与固定回调；桥接中没有 client secret。应用额度也由部署方维护，额度不足不能要求普通用户购买开发者额度。

独立本机部署也可由安装者在 `.runtime/connections/oauth-config.json`（600）预置：

```json
{"x":{"clientId":"<registered-client-id>","redirectUri":"http://127.0.0.1:3094/oauth/x/callback"}}
```

本机 public/native app 无需 secret；已有独立 confidential 部署仅在本机私有配置增加 `clientSecret`，不向用户表单或云端命令队列开放这个字段。令牌保存为本机私有 `.runtime/connections/x-oauth.json`，检查 uid、mode、符号链接及读取上限，不上传。refresh、重新授权写入、撤回共用既有 SQLite 排他锁，避免后台读取与状态探测竞争轮换令牌。缺部署配置不构造无效授权链接。身份与关注时间线读取分别校验；402/429 分别显示部署额度不足与限流，不冒充连接成功。官方协议说明：[Google 桌面 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[X OAuth2 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)、[X 关注时间线](https://docs.x.com/x-api/users/get-timeline)。

## 状态与退出

每两秒领取最新 enabled/generation，普通服务每15秒、X每60秒做实际探测；手动检查可立即触发一次。轮询不重叠；登录最长等待三分钟，其间仍继续领取云端撤回命令。撤回或切换账号会取消旧登录任务，旧 generation 的迟到结果不能覆盖新状态。命令 ID 去重记录仅保存在私有本机状态文件，不保存 credentials。

`SIGTERM`、`SIGINT` 会取消轮询、登录与子进程。云端按心跳和逐项检查时间将断连状态转为离线。日志只写静态状态码，不打印 CLI 原始 stdout/stderr、账号或凭据。

## 验收

`node --test tests/connection_probes.test.mjs` 覆盖静态安全错误、OAuth scope 判定、真实 manager 合约、私有配置、超时/输出上限、去重、撤回迟到隔离和 Python 手机配置映射；不发送消息或控制真实手机。

每次安装都需自行完成真实账号与系统授权验收。Google 检查通过实际执行 `auth list --check` 判定；授权状态通过不代表业务工具已接入。
