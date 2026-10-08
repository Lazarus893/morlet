# Agent Helper - Android Companion APK

Phone automation agent 的 Android 端辅助 APK，提供对话交互、屏幕遮罩和命令控制三大能力。

## 组件

| 组件 | 功能 |
|------|------|
| **DialogActivity** | ADB 启动的浮窗对话框，支持 Yes/No、文本输入、信息展示三种模式 |
| **OverlayService** | 全屏半透明遮罩，防止用户误触，需长按 3 秒解锁 |
| **CommandReceiver** | 广播命令接收器，支持 ping、清理响应文件、查询状态 |
| **SettingsActivity** | 桌面入口「小满手机助手」：自动化设置、「我来接管」按钮、当前任务状态 |
| **TaskStatusReceiver** | 接收 Mac 推送的任务状态，驱动状态文字、悬浮「接管」气泡和防误触遮罩 |
| **RecordService / RecordReceiver** | App 内录屏：持有 MediaProjection 授权，按 Mac 的 `RECORD` 广播分段录制任务视频 |

## 构建

### 前置条件
- JDK 8+ (推荐 JDK 17)
- Android SDK (compileSdk 34)
- 设置 `ANDROID_HOME` 环境变量

### 编译
```bash
# 首次构建会自动下载 Gradle
./gradlew assembleDebug

# APK 产出路径
# app/build/outputs/apk/debug/app-debug.apk
```

### 安装
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## ADB 权限设置

```bash
# 授予悬浮窗权限（必须）
adb shell appops set com.agent.helper SYSTEM_ALERT_WINDOW allow

# 授予存储权限（Android 9 及以下需要）
adb shell pm grant com.agent.helper android.permission.WRITE_EXTERNAL_STORAGE
```

## 使用方法

### DialogActivity - 对话交互

```bash
# Yes/No 对话框
adb shell am start -n com.agent.helper/.DialogActivity \
  --es title "确认操作" \
  --es message "是否继续执行？" \
  --es type "yesno"

# 文本输入对话框
adb shell am start -n com.agent.helper/.DialogActivity \
  --es title "请输入" \
  --es message "请输入验证码" \
  --es type "text_input"

# 信息提示（仅展示）
adb shell am start -n com.agent.helper/.DialogActivity \
  --es title "提示" \
  --es message "任务已完成" \
  --es type "info"

# 带超时的对话框（10秒后自动关闭）
adb shell am start -n com.agent.helper/.DialogActivity \
  --es title "确认" \
  --es message "是否继续？" \
  --es type "yesno" \
  --ei timeout 10
```

**响应文件路径**: `/sdcard/Android/data/com.agent.helper/files/response.json`

响应格式：
```json
{"type": "yesno", "result": "yes", "timestamp": 1234567890}
{"type": "text_input", "result": "用户输入的文本", "timestamp": 1234567890}
{"type": "info", "result": "ok", "timestamp": 1234567890}
```

### OverlayService - 屏幕遮罩

```bash
# 显示遮罩（阻止用户触摸）
adb shell am broadcast -a com.agent.helper.OVERLAY_ON

# 隐藏遮罩（用于截图等操作）
adb shell am broadcast -a com.agent.helper.OVERLAY_OFF

# 查询遮罩状态
adb shell am broadcast -a com.agent.helper.OVERLAY_STATUS
```

> **注意**: 遮罩不会阻止 `adb shell input tap` 等 ADB 注入操作，因为 ADB 输入绕过 WindowManager。

### CommandReceiver - 命令控制

```bash
# Ping 测试连通性
adb shell am broadcast -a com.agent.helper.COMMAND --es cmd "ping"

# 清理响应文件
adb shell am broadcast -a com.agent.helper.COMMAND --es cmd "clear_response"

# 查询当前状态
adb shell am broadcast -a com.agent.helper.COMMAND --es cmd "status"
```

## 读取响应

```bash
# 读取响应文件
adb shell cat /sdcard/Android/data/com.agent.helper/files/response.json

# 等待响应文件出现（轮询）
adb shell "while [ ! -f /sdcard/Android/data/com.agent.helper/files/response.json ]; do sleep 0.5; done; cat /sdcard/Android/data/com.agent.helper/files/response.json"
```

## 小满手机助手（设置 / 接管 / 状态广播）

App 名为「小满手机助手」，桌面图标可直接打开设置页；也可以用 ADB 打开：

```bash
adb shell am start -n com.agent.helper/.SettingsActivity
```

和 Mac 端交换的文件都在 `/sdcard/Android/data/com.agent.helper/files/`。App 写入时先写 `.tmp` 再 rename，Mac 端 `adb shell cat` 不会读到写了一半的内容。

| 文件 | 写入方 | 读取方 | 说明 |
|------|--------|--------|------|
| `settings.json` | App（设置页每次改动立即写；首次启动写默认值） | Mac | 自动化设置。Mac 也可以 `adb push` 覆盖它，App 以文件为准 |
| `control.json` | App（「我来接管」按钮 / 悬浮气泡） | Mac | 接管请求。Mac 处理完删掉文件，或写成 `{"takeover":false}` |
| `response.json` | App | Mac | DialogActivity / CommandReceiver 的响应（见上文） |

### settings.json

```json
{"record":true,"checkpointEvery":8,"screenshotEvery":3,"maxSteps":30,"bubble":true,"overlay":false,"updatedAt":1760000000000}
```

| 字段 | 类型 | 默认 | 范围 | 含义 |
|------|------|------|------|------|
| `record` | bool | `true` | | 录制任务视频 |
| `checkpointEvery` | int | `8` | 0–50 | 每 N 步向微信发一次进度截图，0 表示不发 |
| `screenshotEvery` | int | `3` | 1–20 | 每 N 步存一张截图到日志 |
| `maxSteps` | int | `30` | 5–80 | 单次任务最多步数 |
| `bubble` | bool | `true` | | 任务进行中显示悬浮「接管」气泡 |
| `overlay` | bool | `false` | | 任务进行中显示防误触遮罩 |
| `updatedAt` | long | | | 最后修改时间（毫秒） |

```bash
adb shell cat /sdcard/Android/data/com.agent.helper/files/settings.json
```

### control.json（接管）

用户点设置页的「我来接管」或悬浮气泡后，App 写：

```json
{"takeover":true,"requestedAt":1760000000000}
```

Mac 端轮询这个文件，看到 `takeover:true` 后暂停任务，处理完回执：

```bash
adb shell rm /sdcard/Android/data/com.agent.helper/files/control.json
# 或
adb shell "echo '{\"takeover\":false}' > /sdcard/Android/data/com.agent.helper/files/control.json"
```

请求还没被回执时，气泡保持灰色「已请求接管」；回执后下一条 `running` 状态会让气泡恢复成可点击。点气泡接管时，如果防误触遮罩正在显示，会同时撤掉遮罩，让用户能直接操作。

### 任务状态广播（Mac → 手机）

```bash
adb shell am broadcast -a com.agent.helper.TASK_STATUS -p com.agent.helper \
  --es state running --ei step 3 --es text "正在美团搜索"
```

| extra | 类型 | 说明 |
|-------|------|------|
| `state` | string | `running` / `paused` / `finished` / `error`（必填） |
| `step` | int | 当前步数；`finished` 时显示为「共 N 步」，0 或缺省时不显示 |
| `text` | string | 一句话进度，显示在设置页「当前状态」 |

| state | 手机上的反应 |
|-------|-------------|
| `running` | 更新状态文字；`bubble=true` 时显示/刷新悬浮气泡；`overlay=true` 时显示防误触遮罩 |
| `paused` | 更新状态文字；撤掉防误触遮罩（暂停意味着把手机交还给用户），气泡保留 |
| `finished` / `error` | 更新状态文字；收起气泡和遮罩，停止前台服务 |

### ColorOS 冻结后台应用：每条广播后都要唤醒一次

ColorOS（OnePlus PJZ110 / Android 16 实测）会在 App 退到后台几秒后冻结它的进程，之后发给它的**所有**广播都会被扣住，`TASK_STATUS`、`COMMAND`、`OVERLAY_*` 都一样。用 `adb shell dumpsys activity broadcasts` 能看到 `not runnable because DEFER_BY_OPLUS SUB_REASON: FROZEN`。加 `--receiver-foreground` 没用，常驻前台服务也挡不住冻结。

不动屏幕的解冻方法：发完广播紧接着跑一次 `dumpsys meminfo`。它会调用进 App 进程，ColorOS 随即解冻，被扣住的广播约 0.2 秒内全部送达。

```bash
adb shell "am broadcast -a com.agent.helper.TASK_STATUS -p com.agent.helper --es state running --ei step 3 --es text 正在美团搜索; dumpsys meminfo com.agent.helper > /dev/null"
```

- **每条广播之后都要执行一次**，不只是任务开始时。解冻几秒后 App 又会被冻上，任务中途的 `paused` / `finished`、上文的 `OVERLAY_*`、`COMMAND` 广播也需要。命令只读，耗时约 0.2 秒，不会切换前台应用，也不会影响屏幕。
- 进程不在时它什么也不做；这种情况下广播会冷启动 App，本来就不会被冻结。所以可以无条件执行。
- 写 `control.json` 是用户点按触发的，此时 App 在前台，不受冻结影响。

注意：
- `text` 里有空格时需要两层引号：`--es text "'打开 美团'"`。
- 安装或更新后先打开一次 App。Android 不会把广播发给「已停止」状态的应用；也可以在命令里加 `--include-stopped-packages`。
- 悬浮气泡默认在屏幕右侧中部，可以拖动，松手后吸附到最近的左右边缘。它是普通悬浮窗，`screencap` 截图里能看到它。
- 气泡和遮罩需要悬浮窗权限。部分 ColorOS / OxygenOS 机型上 `appops set` 会报 `MANAGE_APP_OPS_MODES` 权限错误，这时打开 App，按顶部「悬浮窗权限未开启」卡片里的「去开启」手动授权。

## 录屏（MediaProjection）

这台 ColorOS 16 拦掉了 adb 的 `screenrecord`，所以任务视频改由 App 自己用 MediaProjection 录，Mac 端只发开始/停止指令，再把文件拉走。设置页「录制任务视频」开关不变，Mac 端用它决定要不要发 start。

### 和手机投屏二选一

录屏和投屏共用一个系统通道，同一时间只能有一个生效：

- `adb shell dumpsys media_projection` 里只有一个槽位（投屏时显示 `(com.oplus.cast, uid=…): TYPE_SCREEN_CAPTURE`）。
- AOSP 的 `MediaProjectionManagerService` 只保留一个活动的 projection，新的一开始就会 stop 掉旧的。

所以授权录屏会中断正在进行的投屏；反过来开了投屏，小满的录屏授权会被系统收回：`record-status.json` 变成 `authorized:false`，`error` 为 `projection stopped by system (可能是投屏抢占)`，设置页显示「授权被系统收回」，需要重新授权。

### 授权（每次开机后做一次）

1. 打开「小满手机助手」，点「录屏授权」卡片上的「授权录屏」。
2. 第一次会先问通知权限，允许后通知栏才会常驻「录屏已就绪」；拒绝也能录。
3. 系统弹窗「开始录制或投屏」：Android 14+ 上 App 已限定只能录整个屏幕，点「开始 / 允许」。
4. 卡片显示「已授权，小满可随时录制」，`record-status.json` 变成 `authorized:true`。

授权由常驻前台服务 `RecordService` 一直持有（Android 14+ 一次授权只能用一次）。再点「重新授权」会换一个新授权；正在录的一段先收尾。

### 录制控制（Mac → 手机）

```bash
# 开始：同一个 task_id 已在录时忽略；另一个 task_id 会先收尾当前任务
adb shell "am broadcast -a com.agent.helper.RECORD -p com.agent.helper --es action start --es task_id 20261008-1; dumpsys meminfo com.agent.helper > /dev/null"
# 停止：收尾当前段
adb shell "am broadcast -a com.agent.helper.RECORD -p com.agent.helper --es action stop; dumpsys meminfo com.agent.helper > /dev/null"
```

- 和 `TASK_STATUS` 一样，每条广播后要跟一次 `dumpsys meminfo` 唤醒（见上文 ColorOS 冻结一节）。
- `task_id` 里除 `A-Z a-z 0-9 . _ -` 以外的字符会被替换成 `_`。
- 视频参数：H.264 MP4，无音频，3 Mbps，30fps。尺寸取屏幕的 2/3（本机 720x1584）；编码器不支持时依次退到 1/2、整屏。

### 文件位置与分段

`/sdcard/Android/data/com.agent.helper/files/rec/<task_id>/seg_00.mp4、seg_01.mp4…`

- 每 180 秒自动切一段，段与段之间可能有零点几秒的缝。App 进程被杀时只丢正在写的那一段；下次启动会删掉这段不完整的文件。
- 同一个 task_id 先 stop 再 start，会接着往后编号，不会覆盖已有的段。
- 画面完全不动时系统不产生新帧。一段里只有静止画面时 `stop` 会失败，这段会被删掉、不进 `segments`。视频时长按最后一帧算，可能比实际录制时间短。

### 状态文件 `record-status.json`

每次状态变化立即写：

```json
{"authorized":true,"recording":true,"taskId":"20261008-1","segments":["rec/20261008-1/seg_00.mp4"],"currentSegment":"rec/20261008-1/seg_01.mp4","error":"","updatedAt":1760000000000}
```

| 字段 | 含义 |
|------|------|
| `authorized` | 当前能不能录 |
| `recording` | 是否正在录 |
| `taskId` | 当前或最近一次录制的任务 |
| `segments` | 已收尾、可以拉走的段（相对 files 目录的路径） |
| `currentSegment` | 正在写的段，没在录时为空 |
| `error` | 最近一次问题，例如 `not authorized`、`projection stopped by system (可能是投屏抢占)`、`recorder failed: …`、`app process restarted, authorize again` |

stop 之后 `recording:false` 且 `segments` 列全，就可以 `adb pull` 了。

### 已知限制

- 重启手机、强行停止 App、App 进程被杀之后，授权都会失效，要在手机上重新点一次「授权录屏」。
- 授权弹窗出现时，如果 Mac 端正好在跑任务，那一步截图会看到这个弹窗。所以授权要在没有任务时做。
- 持有授权期间，状态栏会一直显示系统的录屏/投屏指示。
- 还没在授权状态下实机验证的：App 被 ColorOS 冻结时 180 秒分段会不会推迟（编码在系统媒体进程里，不受影响；但切段的计时器在 App 进程里）。

### 验收步骤（Tony 自己做；需要先停掉投屏）

以下命令在 Mac 终端执行，先设好路径变量：

```bash
F=/sdcard/Android/data/com.agent.helper/files
```

**b. 授权**：`adb -s "$PHONE_AGENT_DEVICE_ID" shell am start -n com.agent.helper/.SettingsActivity`，在手机上点「授权录屏」并允许。
- 期望：`adb -s "$PHONE_AGENT_DEVICE_ID" shell cat $F/record-status.json` 显示 `"authorized":true`。
- 期望：`adb -s "$PHONE_AGENT_DEVICE_ID" shell dumpsys media_projection` 显示 `com.agent.helper`。

**c. 短录制**：

```bash
adb -s "$PHONE_AGENT_DEVICE_ID" shell "am broadcast -a com.agent.helper.RECORD -p com.agent.helper --es action start --es task_id t1; dumpsys meminfo com.agent.helper >/dev/null"
sleep 8; adb -s "$PHONE_AGENT_DEVICE_ID" shell input swipe 540 1600 540 800 300; adb -s "$PHONE_AGENT_DEVICE_ID" shell input swipe 540 800 540 1600 300
adb -s "$PHONE_AGENT_DEVICE_ID" shell "am broadcast -a com.agent.helper.RECORD -p com.agent.helper --es action stop; dumpsys meminfo com.agent.helper >/dev/null"
sleep 3; adb -s "$PHONE_AGENT_DEVICE_ID" shell cat $F/record-status.json
adb -s "$PHONE_AGENT_DEVICE_ID" pull $F/rec/t1 ./recording-test/
ffprobe -v error -show_entries format=duration:stream=width,height -of default=nw=1 ./recording-test/t1/seg_00.mp4
```

期望：`"recording":false,"segments":["rec/t1/seg_00.mp4"]`；ffprobe 输出 `width=720`、`height=1584`、`duration` ≥ 8。

**d. 自动分段**：用 `task_id t2` 发 start，录 200 秒，期间每 30 秒 `input swipe` 一次，然后发 stop。
- 期望：`segments` 为 `rec/t2/seg_00.mp4`、`rec/t2/seg_01.mp4` 两段。
- 期望：pull 下来后 seg_00 约 180 秒、seg_01 约 20 秒，两段都能用 ffprobe 读出时长并正常播放。

**e. 清理**：`adb -s "$PHONE_AGENT_DEVICE_ID" shell rm -r $F/rec/t1 $F/rec/t2`。
- 期望：`record-status.json` 仍是 `"recording":false`。

## 技术细节

- **App 名称**: 小满手机助手
- **包名**: `com.agent.helper`
- **最低 SDK**: 26 (Android 8.0)
- **目标 SDK**: 34 (Android 14)
- **无网络权限**: 所有通信通过 ADB intent + 文件系统
- **无第三方依赖**: 纯 Android SDK
- **遮罩透明度**: ~85% (`#D9000000`)
