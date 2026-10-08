# auto-phone

AI 驱动的手机自动化 Skill —— 让 Claude Code 直接操控你的手机完成日常任务。

---

## 目录

- [工作原理](#工作原理)
- [快速开始](#快速开始)
- [Skill 命令](#skill-命令)
- [Profile 配置](#profile-配置)
- [环境变量](#环境变量)
- [支持的平台](#支持的平台)
- [常见问题](#常见问题)
- [致谢](#致谢)

---

## 工作原理

auto-phone 基于「视觉-推理-执行」循环实现手机自动化：

1. **截屏感知** — 通过 ADB/HDC/XCTest 获取设备当前屏幕截图
2. **视觉理解** — 将截图发送给多模态大模型，识别界面元素与当前状态
3. **动作推理** — 模型根据用户任务目标，决定下一步操作（点击、滑动、输入等）
4. **指令执行** — 将操作指令发送到设备并执行
5. **循环迭代** — 重复上述步骤，直到任务完成或达到最大步数

整个过程无需预先录制脚本，也不依赖固定的 UI 坐标。模型通过实时观察屏幕自主决策，
能够适应不同的 App 版本和界面变化。你只需用自然语言描述任务，auto-phone 负责完成
剩余的所有工作。

---

## 快速开始

### 前置条件

| 依赖项 | 最低版本 | 说明 |
|--------|---------|------|
| Python | 3.10+ | 推荐 3.11 或 3.12 |
| ADB | 最新版 | Android 设备必需；`brew install android-platform-tools` |
| HDC | 最新版 | HarmonyOS 设备必需；随 DevEco Studio 安装 |
| Claude Code | 最新版 | 作为 Skill 宿主运行 |

### 安装

```bash
cd ~/Projects/auto-phone
pip install -e .
```

安装完成后，auto-phone 会自动注册为 Claude Code Skill，无需额外配置。

可通过以下命令确认安装成功：

```bash
phone-agent --version
```

### 连接设备

**USB 连接（推荐）**

1. 在手机上开启「开发者选项」→「USB 调试」
2. 用数据线连接电脑
3. 在手机弹窗中授权调试
4. 验证连接：

```bash
# Android
adb devices

# HarmonyOS
hdc list targets
```

**WiFi 连接**

适合不方便使用数据线的场景：

```bash
# 先通过 USB 连接，然后切换到 WiFi
adb tcpip 5555
adb connect <手机IP>:5555

# 验证
adb devices
```

> 提示：WiFi 模式下手机和电脑需在同一局域网内，延迟可能略高于 USB 连接。
> 建议在稳定性要求高的任务中优先使用 USB。

### 配置模型 API

auto-phone 需要一个支持视觉理解的多模态大模型 API。通过环境变量配置：

```bash
export PHONE_AGENT_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
export PHONE_AGENT_MODEL="autoglm-phone"
export PHONE_AGENT_API_KEY="your-api-key-here"
```

建议将以上配置写入 `~/.zshrc` 或 `~/.bashrc` 中以便持久化。

#### 云端选项

**智谱开放平台（推荐）**

- 地址：`https://open.bigmodel.cn/api/paas/v4`
- 模型名：`autoglm-phone`（手机操控专用视觉模型）
- 注册后获取 API Key，有免费额度可供测试

**ModelScope**

- 地址：`https://api-inference.modelscope.cn/v1`
- 模型名：`ZhipuAI/AutoGLM-Phone-9B`

配置示例（ModelScope）：

```bash
export PHONE_AGENT_BASE_URL="https://api-inference.modelscope.cn/v1"
export PHONE_AGENT_MODEL="ZhipuAI/AutoGLM-Phone-9B"
export PHONE_AGENT_API_KEY="your-modelscope-key"
```

---

## Skill 命令

auto-phone 作为 Claude Code Skill 提供以下命令，可在 Claude Code 中直接调用：

### /d-profile — 管理用户档案

管理你的个人信息档案，让 Agent 了解你的偏好和常用信息，从而更智能地执行任务。

```
/d-profile              # 查看当前档案
/d-profile edit         # 交互式编辑档案
/d-profile set name 张三  # 设置单个字段
/d-profile reset        # 重置档案为默认值
```

档案包含姓名、常用地址、App 别名映射、个人偏好等信息。
例如，当你说「帮我叫个车到公司」，Agent 会自动读取档案中的公司地址。

详见下方 [Profile 配置](#profile-配置)。

### /d-execute — 直接执行任务

适用于简单、明确的单步或少步任务。Agent 会直接开始操作手机，无需事先确认。

```
/d-execute 打开微信发送"我到了"给妈妈
/d-execute 设置明天早上8点的闹钟
/d-execute 打开支付宝查看余额
/d-execute 截图当前屏幕
```

执行过程中会实时显示每一步的操作和截图，方便你跟踪进度。

### /d-plan — 规划并执行复杂任务

适用于需要多个步骤、可能涉及多个 App 的复杂任务。Agent 会先制定执行计划，
确认后再逐步执行，最后生成执行报告。

```
/d-plan 帮我在美团上点一份附近评分最高的咖啡外卖送到公司
/d-plan 查看最近三天的快递物流信息并汇总
/d-plan 在小红书搜索北京周末好去处，收藏前三个帖子
```

执行流程：

1. **分析** — Agent 将任务拆解为可执行的步骤
2. **确认** — 生成执行计划并展示给用户确认或调整
3. **执行** — 逐步执行计划，每步截图验证结果
4. **报告** — 汇总执行结果，输出任务报告（包含关键截图和结果摘要）

### /d-log — 查看任务日志

查看历史任务的执行记录，便于回溯和排查问题。

```
/d-log              # 列出最近的任务日志
/d-log <task-id>    # 查看指定任务的详细日志
/d-log --last       # 查看最近一次任务的日志
```

日志包含每个步骤的截图、操作详情和执行结果。

---

## Profile 配置

Profile 文件存储在项目的 `data/profile.json`，用于向 Agent 提供个人化上下文。
也可通过 `/d-profile` 命令交互式管理。

```json
{
  "name": "张三",
  "phone": "138xxxx1234",

  "app_map": {
    "打车": "滴滴出行",
    "外卖": "美团",
    "咖啡": "瑞幸咖啡",
    "导航": "高德地图",
    "支付": "支付宝",
    "聊天": "微信"
  },

  "addresses": {
    "家": "杭州市西湖区xxx路xxx号xxx小区",
    "公司": "杭州市余杭区xxx科技园B栋12楼"
  },

  "preferences": {
    "coffee_default": "生椰拿铁，少冰",
    "ride_type": "快车",
    "payment": "支付宝",
    "language": "zh-CN"
  },

  "contacts": {
    "妈妈": "微信备注名",
    "李四": "同事"
  }
}
```

**字段说明**

| 字段 | 说明 |
|------|------|
| `name` | 用户姓名，用于需要填写姓名的场景 |
| `phone` | 手机号，用于需要填写手机号的场景 |
| `app_map` | 任务关键词到 App 名称的映射，让 Agent 能准确选择对应 App |
| `addresses` | 常用地址别名，在外卖、导航、打车等场景中自动填入 |
| `preferences` | 个人偏好设置，影响 Agent 的默认选择（如默认支付方式） |
| `contacts` | 联系人备注信息，帮助 Agent 在通讯录中定位正确的人 |

> 提示：Profile 信息仅存储在本地，不会上传到任何服务器。

---

## 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `PHONE_AGENT_BASE_URL` | 是 | — | 模型 API 的 Base URL |
| `PHONE_AGENT_MODEL` | 否 | `autoglm-phone` | 模型名称（智谱用 `autoglm-phone`，ModelScope 用 `ZhipuAI/AutoGLM-Phone-9B`） |
| `PHONE_AGENT_API_KEY` | 是 | — | 模型 API 密钥 |
| `PHONE_AGENT_DEVICE_TYPE` | 否 | `android` | 设备类型：`android` / `harmony` / `ios` |
| `PHONE_AGENT_DEVICE_ID` | 否 | 自动检测 | 指定设备 ID（多设备时使用） |
| `PHONE_AGENT_LANG` | 否 | `zh` | Agent 交互语言：`zh` / `en` |

多设备场景下，使用 `PHONE_AGENT_DEVICE_ID` 指定目标设备：

```bash
# 查看已连接设备
adb devices

# 指定设备
export PHONE_AGENT_DEVICE_ID="XXXXXXXX"
```

---

## 支持的平台

### Android (ADB)

- 通过 Android Debug Bridge (ADB) 进行设备控制
- 支持 Android 8.0 及以上版本
- 连接方式：USB / WiFi
- 需开启 USB 调试

### HarmonyOS (HDC)

- 通过 HarmonyOS Device Connector (HDC) 进行设备控制
- 支持 HarmonyOS 3.0 及以上版本
- 需安装 DevEco Studio 或单独安装 HDC 工具
- 需开启开发者模式

### iOS (XCTest)

- 通过 XCTest 框架进行自动化控制
- 支持 iOS 16.0 及以上版本
- 需在 Mac 上运行，且安装 Xcode
- 设备需开启「开发者模式」并信任电脑

> 注意：iOS 支持目前为实验性功能，部分操作的稳定性可能不及 Android。

各平台能力对比：

| 能力 | Android | HarmonyOS | iOS |
|------|---------|-----------|-----|
| 点击 | 支持 | 支持 | 支持 |
| 滑动 | 支持 | 支持 | 支持 |
| 输入文字 | 支持 | 支持 | 支持 |
| 截屏 | 支持 | 支持 | 支持 |
| 返回 | 支持 | 支持 | 有限支持 |
| 安装 App | 支持 | 支持 | 不支持 |

---

## 常见问题

**Q: 设备连接后 `adb devices` 显示 unauthorized 怎么办？**

请检查手机上是否弹出了 USB 调试授权弹窗，点击「允许」即可。如果没有弹窗，
尝试重新插拔数据线或重启 ADB 服务：

```bash
adb kill-server
adb start-server
```

**Q: 执行任务时模型响应很慢怎么办？**

视觉模型处理截图需要一定时间，通常每步 2-5 秒属于正常范围。如果持续超时，
请检查网络连接和 API 服务状态。

**Q: 任务执行到一半失败了怎么办？**

使用 `/d-log --last` 查看最近一次任务的日志，定位失败步骤。
可以用 `/d-execute` 从失败的地方手动继续，或重新用 `/d-plan` 执行完整任务。
常见原因包括：App 弹出了意外弹窗、网络加载超时、界面布局与模型预期不符等。

**Q: 可以同时控制多台设备吗？**

当前版本一次只能操控一台设备。如需切换设备，请修改 `PHONE_AGENT_DEVICE_ID`
环境变量。

**Q: 支持哪些类型的操作？**

支持点击、长按、滑动、文字输入、返回、回到桌面等基础操作。
对于需要复杂手势（如双指缩放）的场景，目前暂不支持。

---

## 致谢

auto-phone 基于 [Open-AutoGLM](https://github.com/THUDM/OpenAutoGLM)（智谱 AI / Zhipu AI）
构建，在其手机自动化代理框架之上封装为 Claude Code Skill，提供更便捷的自然语言交互体验。

感谢智谱 AI 团队在多模态 Agent 和自动化领域的开源贡献。

---

## 许可证

请参阅 [LICENSE](./LICENSE) 文件。
