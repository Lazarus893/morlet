# 小满：复用成熟能力的增量优化

2026-10-19。把三个项目中与小满职责相合的能力接进现有产品。主 DSH runtime、微信插件、已有业务账本与审批路径继续使用锁定版本；原部署与真实账号未参与本轮测试。

## 实际采用

| 来源 | 接入内容 | 小满中的作用 |
|---|---|---|
| [OpenUI](https://github.com/thesysdev/openui) | `@openuidev/lang-core` / `react-lang` 1.0.1、`react-ui` 0.18.1；直接复用 schema、prompt、parser、响应式状态、renderer 和官方 UI 组件 | 现有 20 种领域卡片上方可生成事项专属的组合视图。文字、指标、表格、输入、按钮、分组由同一组件 schema 定义；人数/预算调整回到原有预览与采纳流程。 |
| [Octop](https://github.com/TencentCloud/Octop) | 独立 `octop-memory==1.0.2`；公共 Memory API、SQLite、中文检索、替换链与 RawEvent 审计 | `xiaoman_memory` 查询、保存、更正和停用有来源的长期偏好，无模型抽取或网络依赖。 |
| [DeepSeek-Bot](https://github.com/FeiZhuLulu/DeepSeek-Bot) | 借鉴原话随交接保留、历史可检索的机制，适配到已有 Hub | 每轮附近期用户原话、历史任务状态和宿主保存回执；`xiaoman_history` 按 ID 回查原文，支持同会话搜索。未复制其源文件。 |

参考源码的固定提交与产品核实见 `docs/research/` 的三份调研。依赖版本与完整性保存在锁文件；前端依赖的完整许可随构建资源保留，来源登记在 `THIRD_PARTY_NOTICES.md`。

## 行为变化

**界面随数据更新。** Designer 的 JSON 增加可选 `surfaces: [{itemId, program}]`。程序由 OpenUI 真正解析和渲染，`Query("current_item", {}, {})` 只能读取所属事项。普通字段更新沿用已保存程序，不重新要求模型生成页面。没有额外视图的既有事项继续使用原来的业务卡片。

视图可使用本地 `$state` 做试算；草稿按 scope、事项及程序身份隔离，刷新可恢复，轮询保留输入焦点。正式采纳继续校验账本版本、预览散列和幂等请求 ID；原有数量编辑、已买记录、固定隐藏排序及结果未知时的核对流程保留。未开放任意 HTML、JavaScript、URL、Mutation 或外部写工具。

**偏好可追溯、更正。** 例如用户明确说“请记住：晚餐偏好清淡”，Agent 可保存该句原话；临时的“今晚四人份”仍属于生活账本。每条记忆带消息来源、版本和时间。更正创建后继记忆，历史来源仍可查；停用后不再参与召回，但保留审计，并非永久擦除。并发重试按同一请求回执去重，更正和停用必须带读取到的版本。记忆保存在实例 `.runtime/memory/`，不进入源码包。

**续接带着原始交代。** 交接包优先保留近期更正和未完工作，截断的原话带消息 ID，可继续回查。它作为每轮输入的数据传给 Agent，稳定权限规则保留在系统指令中，兼容原生会话保留首次指令的行为。后续排队消息不会混进当前轮历史；读取历史仅限已认证的当前会话。历史报告与批准不构成当前事实或新操作授权。

## 启用和维护

新安装要求 Node.js 22.19+、Python 3.12+。安装器和 `pa.sh setup` 按锁文件安装依赖，并关闭 OpenUI 安装遥测。浏览器资源本地提供；本轮网络记录没有 CDN、遥测或模型请求。

已有独立实例更新框架时，同步更新 Node 与 Python 依赖后重启对应服务/连接助手。只更新网页资源不会升级仍在运行的后端。已有 Codex 原生会话保留创建时的工具清单；要使用新增的 history/memory 工具，需新建小满会话，旧会话及账本不会被重置。已有会话仍可收到每轮交接包。

修改自定义视图组件后运行 `npm run build:surfaces`；生成的 JS、CSS 与许可文件均在分发白名单中。官方 React UI 按组件及样式入口引入；无需搬入 OpenUI 的聊天壳或托管 Gateway，也无需运行 Octop/DeepSeek-Bot 的第二套会话、派工和账号系统。那些未接入实例授权的连接器未被标为可用能力。

## 官方组件纠正

初版只接入 OpenUI 引擎，自行实现了外观，未达到复用成熟组件的要求。现已改用 `@openuidev/react-ui@0.18.1` 的 Card、CardHeader、TextContent、MetricIndicator、Input、FormControl、Label、Button、Table 及官方 CSS；本地 CSS 仅负责组合布局、触摸/键盘访问与宿主边界。遵循 [官方组件导入与样式文档](https://github.com/thesysdev/openui/tree/9823ec05d4b29bc78d101676dc16b44fe17f1830/packages/react-ui)。

使用官方静态 `defaults.css` 提供主题：ThemeProvider 默认注入的内联 style 被宿主 CSP 阻止，静态文件从本地同源加载。react-lang 1.0.1 还会无条件注入一条固定的 openui-spin 动画样式，因此 CSP 只增加该文本的 SHA-256 精确许可，继续禁止其他内联样式和脚本；没有启用 unsafe-inline。当前 JS 约 202 KB gzip，CSS 约 4.5 KB gzip。

实际渲染了对应输入和 PreviewPlan 参数的视图会替代重复的原生试算控件；预览、错误、采纳及核对结果显示在视图之后。未覆盖的字段继续使用宿主入口；仅本地 Set/Reset 的视图不会隐藏原入口。改变的是展示层，组件 schema 与已保存程序保持一致。

浏览器验收除了交互，还检查官方样式计算结果及控制台错误，覆盖主题加载与 CSP 错误、重复输入、没有预览动作和预览参数不对应的情形。截图 `openui-official-desktop.png` 与 `openui-mobile.png` 为修正后的真实页面。

## 验证

- 实施前基线：641 项 Node 测试通过；改动前文件副本保存在本实例工作目录。
- 全量 Node：647 项通过。覆盖原生 DSH 会话、Codex 共存、审批/取消、首用流程与本轮新增能力。
- Python：131 项，成功；1 项 Android/JDK 条件跳过。安装器变更后另复验 42 项，通过。
- 新增 6 项集成测试使用真实 Octop 包和 SQLite，覆盖中文检索、原话约束、跨会话隔离、并发重试、更正版本和旧来源保留；OpenUI 校验覆盖非法工具、动作、代码、截断输入与陈旧设计结果。
- 实际浏览器：6→4 人试算，意面 600→400 克、菠菜 300→200 克；试算不写账本，用户采纳后原事项更新，程序保持不变。刷新恢复、轮询焦点、390px 布局、卡片/页尾不重叠与无外部请求通过。
- 原有手账浏览器回归通过，包括跨入口版本冲突、失回执后核对、不重复写入，以及已有采购记录保留。
- 来源检查、分发白名单、可搬迁框架/技能包验收通过；`pip check` 无损坏依赖。

开发验收输出位于 `.runtime/reuse-upgrade-20261019/`，截图及浏览器结果位于 `.runtime/verification/reuse-upgrade-20261019/`，均不分发。复验入口：

```sh
./scripts/pa.sh check
python3 -m unittest discover -s tests -v
node --test tests/*.test.mjs
# 指向已安装的 Playwright 后执行真实浏览器测试
PA_PLAYWRIGHT_MODULE=/path/to/playwright node tests/reuse_upgrade.browser.mjs
```

本轮完成源码与隔离验收；没有重启生产服务，没有读取真实邮箱、发送微信消息或控制手机。自定义页面生成质量仍需在具体实例的真实模型上验收，不能把固定测试提案的通过称作线上模型成功率。
