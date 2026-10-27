# 实例部署模板

服务配置由用户本机参数生成，不在源码中填写个人主机、用户、安装目录或密钥。模板为 Linux systemd + 独立 Nginx 的受信任内网部署；当前应用没有多租户登录，不把此模板作为公网开放部署方案。

1. 将 `config/deployment.example.json` 复制到 `.runtime/deployment.json`，权限设为 0600。也可运行一次 `python3 scripts/render_deployment.py`，它会创建示例并停止。
2. 填入自己的部署目录、服务用户/组、Node/Nginx 路径、服务器域名和三个独立端口。模型和其他敏感环境值保存在目标实例的私有 `service.env`，不改源码模板。
3. 再次运行渲染器，检查 `.runtime/deployment/` 下生成的四个文件。渲染器不会连接服务器、安装服务、创建用户、接受许可或重启进程。

`install_dir` 指向目标机的实例根目录，模板使用其 `current/` 应用目录和 `service.env`。目标机依赖与微信 vendor 必须来自同一经过验证的 release；运行数据独立保留。`public_host/public_port` 与 Web 的 `PA_WEB_ORIGIN` 一致；DSH 和 Web 后端只绑定 loopback。反向代理配置、账户与系统权限由部署环境管理员确认。

Mac 连接助手的 SSH 用户/主机、SSH 端口和服务端端口通过安装器参数指定；本机监听端口读取私有 `connection-companion.json`，不根据某个开发者的端口猜测。

```sh
python3 scripts/install-connection-companion.py \
  --ssh-host your-user@your-server.example --ssh-port 22 --remote-port 3083
```

示例端口可更改，需与实际配置一致。Agent/iMessage 配对页面在 HTTPS 或本机访问时可使用当前地址；远程 HTTP 环境需填写自己已配置的 loopback 隧道地址，不会默认使用某个固定隧道端口。

## 公开网页读取

`config/profile.patch.json` 将官方 HTTP 提供方的 `maxBodyChars` 和宿主 Web 工具的 `fetchMaxOutputChars` 同时设为 1,000,000；`config/agent.preset.json` 中会话独立挂载的 `tool-web` 也必须显式使用同一上限。会话 preset 会覆盖宿主同名工具，只改 profile 不会改变 Agent 实际收到的内容。`fetchMaxOutputChars` 也限制 HTML 转码前的源字符数；只增加下载上限，工具仍会截掉正文。GitHub Trending 的榜单可出现在大量导航 HTML 之后，官方默认的 100,000 / 200,000 字符不足以读到榜单，500,000 也可能只包含前几项。

这两项仅调整有界文本容量：继续使用官方匿名 HTTP 提供方，保留默认 5 MB 响应字节上限、30 秒超时、5 次同源重定向，以及公开 DNS 校验与连接固定。未完成或仍被截断的读取必须报告实际覆盖，不能称为完整榜单或没有变化。运行 `scripts/configure.py` 在目标发布目录生成 profile 后，随正常发布重启宿主；不手工改运行中的实例配置。
