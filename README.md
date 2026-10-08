# 小满 · Personal Agent

通过微信使用的本地生活助理：dsh 负责对话和工具调用，独立意图模型选择 PC、安卓手机或混合执行，手机执行器负责在 App 中查询并回传截图。

这是原有 `wx-life` 的独立源码副本。配置、执行器、安卓 App、技能和插件修改都在当前项目内；运行数据单独存放在 `.runtime/`。

## 项目内容

| 目录 | 内容 |
|---|---|
| `config/` | dsh profile / preset 的路径模板、手机配置示例 |
| `home/AGENTS.md` | 小满的人设和行为规则 |
| `bin/` | 意图分流、手机任务、复盘、状态报告、云同步 |
| `plugins/` | 手机运行状态上下文、日志落盘 |
| `skills/` | phone、天气、提醒事项、备忘录、摘要、地点查询，共 6 个技能 |
| `phone-refs/experiences/` | 手机执行器的初始 App 操作经验 |
| `android/` | 「小满手机助手」完整 Android 工程和 Gradle wrapper |
| `vendor/auto-phone/` | 手机执行器源码及原始 Apache 2.0 LICENSE |
| `vendor/deepseek-harness-weixin/` | 已修复的微信插件副本及原始 MIT LICENSE |
| `scripts/` | 配置生成、统一命令入口、检查、按需导入技能、打包 |

## 安装与运行

主环境为 macOS + USB 连接的安卓手机。需要 Node.js 22.19+、npm、Python 3.10+、adb；视频复盘需要 ffmpeg。安卓构建需要 JDK 17 和 Android SDK。

```bash
cp .env.example .env
# 在 .env 中填写 DeepSeek key，以及手机执行模型的地址、key、device ID。
./scripts/pa.sh setup
./scripts/pa.sh start
```

`PHONE_AGENT_BASE_URL` 是手机视觉执行模型的 OpenAI-compatible 服务地址，`PHONE_AGENT_MODEL` 默认 `autoglm-phone`。对话和意图分流默认使用 `deepseek-flash`，它们与手机执行模型是两套配置。设备 ID 可通过 `adb devices` 查看。

默认使用端口 **3082** 和项目自己的 `DSH_HOME=.runtime/dsh`，避免和已有 3081 实例混用。启动命令在当前终端前台运行，退出用 Ctrl-C。源码移动后再次运行 `configure` 或 `start`，会重新生成绝对路径；已有记忆、任务和学习记录会保留。

保持服务运行，在另一个终端生成扫码入口：

```bash
./scripts/pa.sh login
```

首次绑定需要扫码。源码包不包含旧微信登录凭据；在切换使用前自行决定何时停止旧实例，不要让两个实例同时消费同一个账号的消息。

## 常用命令

```bash
./scripts/pa.sh status --fast
./scripts/pa.sh phone check
./scripts/pa.sh phone run "打开淘宝，查询最近一单的物流，只查不下单" --checkpoint-every 0
./scripts/pa.sh phone resume last
./scripts/pa.sh review last
./scripts/pa.sh dump-config
```

手机需要 USB 调试已授权、屏幕解锁；文本输入依赖手机上已安装并启用的 ADB Keyboard。手机视觉模型服务需另行提供。录屏需要在「小满手机助手」中单独授权，与手机投屏互斥；不录屏仍可以通过截图查询和复盘。详情见 [安卓 App 文档](android/README.md)。

构建安卓 App（先配置 `ANDROID_HOME`，或本机未提交的 `android/local.properties`）：

```bash
cd android
./gradlew assembleDebug
```

APK 在 `android/app/build/outputs/apk/debug/app-debug.apk`。安装到手机使用 `adb install -r`，悬浮窗和录屏权限由手机用户授权。

## 数据和权限

- `.env`：本机 API key、模型服务和设备配置。
- `.runtime/dsh/`：微信登录凭据、session、profile 状态和可重新生成的配置。
- `.runtime/workspace/`：私人记忆、任务日志/截图/录像、双端共享文件、可写的 App 经验。
- `memory/`：开发会话记录；不进入源码包。

沙箱仍为 `workspace-write`，只写自己的 runtime 工作区。微信工具审批用 `/approve`、`/reject`；手机敏感操作会暂停等待确认。现有手机敏感识别依赖模型标记，批准尚未与具体动作严格绑定，这项改进留在待办中。此次迁移没有放宽权限。

云同步脚本保留，通过 rclone 远端 `xiaoman-cloud` 使用。远端仍需自行配置，目前尚未接入任务收尾。

## 技能

已收录生活助理需要的 6 个技能。提醒事项依赖 `remindctl`，备忘录依赖 `memo`，摘要依赖 `summarize`，地点查询依赖 `goplaces` 和对应 API key；具体安装与授权见各技能的 `SKILL.md`。内置 web 工具和手机查询仍可直接使用。

按需导入本地技能：

```bash
./scripts/pa.sh import-skills <技能目录名>
./scripts/pa.sh import-skills --source /path/to/local/skills <技能目录名>
./scripts/pa.sh check
```

默认只扫描项目内的 `skills/`，不再依赖机器上的 Claude/Codex 技能目录。保留的 `dsh-hooks-claude-code` 是 dsh 的 hook 格式适配器，不调用 Claude Code CLI 或 Claude 模型。

## 检查、打包和提交

```bash
./scripts/pa.sh check
python3 -m unittest discover -s tests -v
./scripts/pa.sh pack
git status --short
```

打包输出为 `dist/personal-agent-source.zip`，内含文件清单、大小与 SHA-256。打包按源码目录白名单选取，排除密钥、登录态、私人记忆、任务产物、依赖安装目录和构建缓存。依赖由 `package-lock.json` 与 `requirements.txt` 安装。

该目录使用独立 Git 仓库，可以自行提交和配置远端。迁移不包含向远端推送。

尚待完成的内容、迁移范围和验证记录见 [项目状态](docs/status.md)，微信插件修改见 [修改记录](docs/weixin-patches.md)。
