# auto-phone 适配补丁

2026-10-10。保留上游 Apache 2.0 LICENSE，未修改项目外原 auto-phone 部署。

- ADB 命令在 adb 模块与 companion 中统一读取 `ADB` 环境变量，允许非 PATH 的自定义安装位置。
- iOS 点击/滑动坐标比例从 WDA `/wda/screen` 读取并校验，覆盖 2x/3x 屏幕，不再固定 3。
- iOS 截图失败直接抛错，不返回合成黑图，也不切到未明确绑定的其他设备截图。
- iOS 网络调用统一走 xctest/http.py：不继承代理、保留 TLS 验证、校验 HTTP 与 WDA JSON 错误；动作失败抛给执行器，不再打印后假定成功。
- PA 层验证 WDA 创建了有效 session 才执行动作。Android 助手功能不会在 iOS 路径被调用。
- phone_task 以具体设备配置绑定任务，拒绝跨设备续跑；使用本地进程锁避免同时操作。
- 手机确认由原来的“批准任意下一次敏感请求”收紧为匹配待确认说明、一次消费。仍依赖模型标记，不等价于对具体截图/坐标/金额签名授权。

离线测试在 tests/phone_runtime_cases.py 与 tests/test_adapters.py；真实 WDA/设备尚未验收。
