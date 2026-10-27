# DSH Remote 接入

小满通过 `ds-harness-remote@0.5.18` 已认证的 Client Host 接口操作远端原生会话。Remote 插件负责设备认证、身份固定、Noise 加密和网络传输；小满不重新实现这些协议。

## 部署边界

使用专用 DSH Client Host，不能把用户正在操作的桌面实例当作共享的模式切换器。上游 `mode.set` 会改变整个 Client Host 的目标，因此专用实例是必要隔离边界。该实例可在本机运行，或通过已认证的 SSH 隧道访问其 loopback 端口。

Client Host 使用与插件兼容的 DSH 版本（本轮核对 0.2.1-rc.1）；小满线上仍可保持自身锁定版本。主项目不安装第二套 DSH，也不把上游浏览器 IIFE `ds-harness-remote/client` 误当成 Node SDK。

Remote Host/Client 必须在上游完成账号及设备授权。优先使用自有服务；小满不自动把账号或令牌提交给作者托管服务。Client 实例禁用不需要的 terminal、Host 控制与本地 Codex 域，避免额外暴露本机执行能力。目标 Host 保持自己的 sandbox 与审批策略。

## 实例配置

保存为 `.runtime/dsh-remote.json`，文件权限 `0600`：

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:3484",
  "credentialFile": ".runtime/dsh-remote-auth.json",
  "targetDeviceId": "replace-with-authorized-host-id",
  "dedicatedClient": true,
  "allowSessionControl": true,
  "timeoutMs": 15000
}
```

`baseUrl` 只接受 loopback HTTP 或 HTTPS 根地址，不接受 URL 内凭据、路径、query 或 fragment。`credentialFile` 必须是普通私密文件，拒绝 symlink。凭据格式为 `{ "cookie": "<Client Host browser cookie>" }` 或 `{ "launchToken": "<Client Host launch token>" }`；launch token 只在该 Host 根路径交换 cookie，禁止跨域跳转，cookie 仅保存在适配器内存。不将这些文件放入发布包或 Git。

`allowSessionControl` 缺省为 false；true 只开放原生会话创建、继续、停止和一次性审批，不取消远端原生权限约束。服务连接、原生会话控制与小满任务执行是三个独立状态。

尚未选择真实 Host 时省略 `targetDeviceId`。此时可读取已授权设备，状态返回 `DSH_REMOTE_HOST_NOT_SELECTED`，不开放工作区或会话。认证后的控制器先用 `devices()` 校验目标属于真实授权列表，再调用 `saveDshRemoteTarget(root, deviceId)` 原子保存、重建 client、调用 `connect()`。保存函数校验现有文件归属、私密权限及非 symlink；它本身不授予设备权限。

## 调用

```js
import { loadDshRemoteConfig, DshRemoteClient } from './plugins/agent-hub/remote/index.mjs';

const client = new DshRemoteClient(loadDshRemoteConfig(root));
const status = await client.snapshot();
const devices = await client.devices();
await client.connect(); // 只允许实例配置中固定的 targetDeviceId
const workspaces = await client.workspaces({ backend: 'harness' });
const sessions = await client.sessions();
```

支持的入口：

| 能力 | 方法 |
| --- | --- |
| 状态、设备、连接 | `snapshot`、`devices`、`connect`、`disconnect` |
| 工作区 | `workspaces`、`openWorkspace`；按 Host 能力支持 harness / codex / cursor / antigravity / pi / opencode / claude |
| 会话与历史 | `sessions`、`history`、`search`、`projections`、`models`、`skills` |
| 原生控制 | `createSession`、`prompt`、`cancel`、`rename`、`fork`、`selectModel`、`updateQueue` |
| 实时事件 | `stream('session/follow', { request })`、`session/control`、`workspace/follow`、`$events` |
| 单次审批 | 从 `$events` 收到 `approvalHandle` 后，`respondApproval(handle, 'allowed-once' / 'rejected', { sessionId })` |
| 文件只读 | `files('stat' / 'readRange' / 'list', payload)`；由上游 Host 校验路径权限 |

请求参数遵循 DSH 原生类型，保持 requestId、sessionId 与日志 cursor；`session/page` 的 throughSeq 必须来自相应 follow opening frame。小满不把 prompt 的 accepted 入队回执当作任务完成。

所有调用禁用 HTTP 自动重定向，校验 rpcId。变更请求丢回执返回 `DSH_REMOTE_OUTCOME_UNKNOWN` / `uncertain:true`，不自动重试。原生流断线抛错，撤销该代审批；恢复需重新读取原生基线，不重发 prompt。审批只能回答当前连接实际收到的请求，不能跨 session、重复批准或批准整段会话。

允许审批还必须从同会话的活跃 `session/follow` 读取 durable `tool/call`，以 `callId` 和 `name` 对应请求，完整展示其中的 `arguments`。只凭工具名或理由不能允许。后端同样要求完整、有效的 JSON 对象，长度不超过 65536 字符且没有截断标记；缺证据返回 `DSH_REMOTE_APPROVAL_DETAILS_UNAVAILABLE`。拒绝始终可用，follow 断开立即撤销其证明；瞬时 assistant-stream 文本不作为授权依据。

## 用户 Host 最少接入步骤

1. 在用户自己选择的兼容 DSH 实例中，用官方插件管理安装 `ds-harness-remote@0.5.18` 并重启。当前维护基线为 DSH `0.2.1-rc.1`；历史兼容声明不等于旧版已通过本次验收。不要自动修改主项目或微信 profile。
2. 在 Remote 设置中填入自建服务地址（本机 SSH 转发时填该 loopback 地址），使用私密部署文件中的自建账号登录，明确开启该设备的远程控制。终端是独立能力，按需关闭。
3. 在小满连接页刷新并选择真实设备、工作区，再打开原生会话。设备没有出现时先检查授权与在线状态，不把服务登录成功视为 Host 已配对。

上述账号只用于自建 Relay，不是模型账号。最小服务没有作者托管服务的第三方 QR 登录；不要引导用户到作者服务完成本实例配对。

## 明确未开放

- `businessTools:false`、`taskExecution:false`：现成 Remote 不提供小满同宿主 `setup` 注入的业务工具和副作用 guard。`run()` 在发送 prompt 前返回 `DSH_REMOTE_BUSINESS_TOOLS_UNAVAILABLE`；Hub 不得把该端点列为可执行小满任务，直至目标 Host 的工具注册与会话隔离协议完成真实验收。
- 任意终端、配置修改、任意原生 RPC、任意 URL 代理不经此适配器开放。
- 新版 DSH 定时问题与迟到答复的完整交互还需要独立实现，不能用审批响应冒充问题回答。
- 本轮 HTTP/WS 契约测试不等于用户账号已授权或跨机网络稳定性通过；状态必须展示真实配置、连接和能力缺口。

## 验证

`node --test tests/dsh_remote.test.mjs` 覆盖真实 loopback HTTP/WebSocket 载体、原生参数 schema、授权交换、目标固定、响应关联、无盲目重试、审批归属/撤销、失联和固定接口范围。用户目标 Host 的账号授权、版本匹配、跨机收发和工具闭环仍须使用真实部署验证。

独立 Client Host 安装时必须显式补齐上游 peer dependencies，避免 `--legacy-peer-deps` 的结果从主项目的旧 DSH 意外解析依赖。本轮已在没有主项目祖先依赖的 Linux 服务上验证 DSH 0.2.1-rc.1 + Remote 0.5.18 的 cookie 交换、服务账号登录和真实空设备列表；自建 Relay 的官方 Docker 镜像通过 `/healthz`。这不等于用户 Host 已配对。

上游 0.5.18 即使 `role:client` 且 `hostControl.enabled:false`，仍会启动未授权本地 Host，使设备列表被本地 Host 的授权错误阻止。部署使用 [`client-host-ready.py`](../plugins/agent-hub/remote/client-host-ready.py) 作为专用服务的 `ExecStartPost`：等插件就绪后，通过官方 `host.authorization.set(false)` 停止本地 Host，再原子刷新私密 cookie。它不注册 Host、不选择目标、不发送模型任务。服务以独立用户和隔离的 DSH_HOME 运行；该助手的写入目录须受 systemd 白名单限制。已验证服务重启后仍可读设备，且本地 Host 未授权、离线、无错误。私密部署回执在 `.runtime/integrations/dsh-remote-deployment.json`，不进入发布包。

上游依据：[控制接口](https://github.com/liguobao/ds-harness-remote/blob/main/packages/plugin/src/control-route.ts)、[控制方法](https://github.com/liguobao/ds-harness-remote/blob/main/packages/plugin/src/client-control.ts)、[兼容范围](https://github.com/liguobao/ds-harness-remote/blob/main/docs/compatibility.md)、[恢复协议](https://github.com/liguobao/ds-harness-remote/blob/main/docs/network.md)。
