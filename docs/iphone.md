# iPhone 接入

PA 通过 WebDriverAgent（WDA）与 XCTest 操作 iPhone。它不是 iPhone 镜像窗口的鼠标脚本，也不能替使用者绕过开发者模式、签名、信任或锁屏。

## 使用者准备

1. 在 Mac 安装与设备系统兼容的 Xcode；用 USB 连接 iPhone，完成“信任此电脑”，开启开发者模式并解锁。
2. 按 Appium 官方指南安装/获取 WebDriverAgent，在 Xcode 的 WebDriverAgentRunner target 设置自己的 Team 与签名、唯一 Bundle ID，选择真实设备并运行测试，直到 WDA 启动。
3. 将 WDA 暴露为电脑可访问的地址。可以使用设备局域网地址，或由本机 USB 端口转发提供 `http://127.0.0.1:8100`。转发进程与 WDA 需要保持运行。
4. 配置自己的手机视觉模型，在 `.env` 设置 PHONE_AGENT_BASE_URL / MODEL / API_KEY；这个模型应能识别截图并返回 auto-phone 支持的动作格式。

参考：[Appium 真机配置](https://appium.github.io/appium-xcuitest-driver/8.4/preparation/real-device-config/)、[官方手动签名说明](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/getting-started/provisioning-profile/full-manual-config.md)。安装和签名操作由设备所有者完成，本项目不保存证书或 Apple 账号。

## 配置与检查

```bash
./scripts/pa.sh init --device ios --wda-url "http://127.0.0.1:8100"
./scripts/pa.sh configure
./scripts/pa.sh doctor
./scripts/pa.sh device-status
./scripts/pa.sh phone check
```

`device-status` / `phone check` 只读取 `/status` 与 `/wda/locked`，不会创建 WDA session、点屏幕或唤醒设备。只有 state=connected 时才开始任务。若无法确认锁屏状态，按不可用处理。

先用单一、只读的小任务验收：

```bash
./scripts/pa.sh phone run "打开 Safari，查看当前网页标题，用 finish 汇报，不登录、不提交表单" --max-steps 8 --checkpoint-every 3 --no-record
./scripts/pa.sh phone status last
./scripts/pa.sh phone resume last --no-record
```

执行后检查真实手机画面、任务截图和结果是否一致，再从微信发同类任务。WDA URL 是设备身份的一部分；改 URL 后不能直接续跑旧任务，避免误操作另一部手机。

## 能力差异

| 能力 | iPhone |
|---|---|
| 打开已映射 App、点按、滑动、输入 | WDA/XCTest |
| 截图、分步日志、暂停续跑 | 支持 |
| 锁屏、登录、验证码、支付 | 交给用户 |
| Android 助手的悬浮窗、录屏、接管按钮 | 不支持；用微信取消或本地 Ctrl-C 停止 |
| phone push/pull 共享目录 | 不支持 |
| 任意 App 的私有文件、后台权限或全部 iOS 系统界面 | 不承诺；由 iOS/XCTest 能力决定 |

不同 iPhone 的坐标比例取自 `/wda/screen` 的 scale，不再固定假设为 3；截图失败会停止，不用黑图冒充屏幕。HTTP/WDA 动作错误会上抛。屏幕尺寸、横竖屏、具体 App 与输入法仍需真机验收。

WDA 通常没有面向公网的认证保护，请仅在使用者自己的本机或可信网络访问。无需把 WDA 暴露到互联网。
