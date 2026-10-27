# Third-party components

- `ws` 8.22.0：MIT，来源 https://github.com/websockets/ws ，作为直接依赖用于 Codex 原生常驻连接与 DSH Remote 原生事件流；版本和完整性由 `package-lock.json` 固定。
- `ds-harness-remote` 0.5.18：MIT，来源 https://github.com/liguobao/ds-harness-remote 。独立部署上游 Relay 与 DSH 0.2.1-rc.1 Client Host，框架只包含适配器及有说明的启动助手，不复制或重写 Noise 协议。现有主 DSH 0.1.5-rc.1 不变。
- Nango：来源 https://github.com/NangoHQ/nango ，Elastic License 2.0；独立运行 Auth/Proxy 服务，不随框架源码包重新分发。镜像 digest、数据库和密钥只登记于实例配置。不同功能的自托管许可范围按上游文档核实，未将商业功能作为免费功能分发。

- `vendor/auto-phone/`：从本机现有 Open-AutoGLM / auto-phone 项目复制的手机执行器，保留 `LICENSE`（Apache License 2.0）和原始源码。`android/` 来自同一项目的 companion-app，包含此前为小满编写的设置、接管和录屏扩展。
- `vendor/deepseek-harness-weixin/`：`deepseek-harness-weixin` 0.2.5，来源 https://github.com/sliverp/DeepSeek-harness-weixin ，保留原始 MIT LICENSE。该副本含当前部署中已有的 dsh API 适配、截图发送和错误诊断修改；独立迁移时另将诊断脚本路径改为环境变量，并固定依赖版本。具体见 `docs/weixin-patches.md`。
- `@deepseek-ai/dsh` 及配套包：通过 npm 安装，入口版本 0.1.5-rc.1；实际依赖版本、来源和完整性记录在 `package-lock.json`，各包许可随 npm 包保留。
- `vendor/dsh-pet/`：针对 `dsh-pet` 0.3.7 的聊天接入补丁，来源 https://github.com/PC2005-cloud/dsh-pet ，保留上游 MIT LICENSE。复用其原生对话框、桌面 helper 与广播接口；补丁、上游源码散列和扩展模块随源码分发，不分发宠物素材或独立模型服务。安装包通过 pnpm patch 管理，详见 `docs/pet-chat.md`。
- `plugins/webui/public/journal-webawesome.js`、`journal-webawesome.css`：从 `@awesome.me/webawesome` 3.14.0 的 Core 控件及默认主题构建的本地静态资源，项目来源 https://github.com/shoelace-style/webawesome ，Core 为 MIT。构建保留依赖法律注释；内嵌 Font Awesome SVG 的图标许可为 CC BY 4.0，相关注释与署名随产物保留。禁用默认外部图标库解析，系统图标使用内嵌资源；未使用 Pro、CDN 或 `wa-animation`。
- `skills/{weather,apple-reminders,apple-notes,summarize,goplaces}/`：从现有本地技能包复制，保留原始 `SKILL.md` 的 metadata 和工具安装声明。它们依赖的 CLI 不随源码包提供。

- `@mozilla/readability` 0.6.0：Mozilla 官方正文提取器，Apache-2.0，来源 https://github.com/mozilla/readability 。仅用于后台静态文章解析，不执行网页脚本。
- `linkedom` 0.18.13：静态 DOM 解析器，ISC，来源 https://github.com/WebReflection/linkedom 。各包许可随 npm 包保留，版本与完整性登记在 package-lock.json。

本文件记录来源和修改，没有重新指定第三方组件的许可。

- `@openuidev/lang-core` / `@openuidev/react-lang` 1.0.1、`@openuidev/react-ui` 0.18.1：来自 https://github.com/thesysdev/openui ，MIT。用于自定义事项视图的 schema、提示词生成、解析、响应式状态和 React 渲染；官方 React UI 提供卡片、表单、指标、按钮和表格及样式；小满保留领域 schema、数据绑定与预览动作。React 19.3.1、React DOM 19.3.1、Zod 4.6.7 及间接依赖随锁文件固定。`scripts/build_surfaces.mjs` 使用 esbuild 0.28.2 构建本地资源；完整许可及版权声明（包括 Radix/clsx 的 MIT、Lucide 的 ISC/Feather MIT）保存在 `plugins/webui/public/journal-surfaces.js.LEGAL.txt`。不使用托管 Gateway、外部 CDN、任意 HTML 组件或可写 toolProvider。
- `octop-memory` 1.0.2：来自 https://github.com/TencentCloud/Octop ，MIT，通过 PyPI 安装，许可随 Python 包保留。直接使用公共 Memory API、SQLite、中文检索、记忆替换和审计；不启用模型抽取、向量模型或网络连接器。
- https://github.com/FeiZhuLulu/DeepSeek-Bot （现为 Fei2411/DeepSeek-Bot，Apache-2.0）：借鉴其原话交接与可回查历史机制，适配到小满已有 Hub；本轮未复制其源文件，未引入第二套运行时。

- `motion` / `framer-motion` / `motion-dom` / `motion-utils` 14.6.0：MIT，来源 https://github.com/motiondivision/motion 。`motion/react` 的 AnimatePresence、MotionConfig 与 motion.create 用于 OpenUI/Radix Accordion 和状态提示；`motion/mini` 用于非 React 的页面、原生 details、目录和弹窗。版本/完整性由 package-lock.json 固定；完整许可与 tslib 许可分别随 journal-surfaces.js.LEGAL.txt、motion.js.LEGAL.txt 分发。没有加入第二套 UI 主题或 CDN。OpenUI 0.18.1 的 Accordion/Tabs 直接复用，其 Radix 传递依赖（含 Accordion1.3.1、Tabs1.2.1、Collapsible1.2.1）由锁文件固定，完整 MIT 许可已纳入构建产物。

- 手账跟进回报复用 OpenUI 0.18.1 的 MarkDownRenderer（已有 react-markdown 及其传递依赖），禁用原始 HTML 与远程图片，只允许 http/https 链接。构建脚本按实际打包模块自动收集依赖许可到 journal-surfaces.js.LEGAL.txt；没有新增 npm 依赖。

- 产品介绍 `docs/product/index.html` 内嵌 Anime.js 4.5.0（MIT），来源 https://animejs.com/ ，完整MIT许可随HTML保留。该库仅用于介绍页，不是产品运行依赖。介绍页中的Messages图标来自Apple官方指南 https://support.apple.com/en-ca/guide/iphone/iph82fb73ba3/ios ，微信图标来自 https://www.wechat.com/en/ ，仅标识对应接入渠道，商标权属于各自权利人。截图使用隔离演示数据；消息派发场景明确标为模拟。
