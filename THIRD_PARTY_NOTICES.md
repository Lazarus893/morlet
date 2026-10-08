# Third-party components

- `vendor/auto-phone/`：从本机现有 Open-AutoGLM / auto-phone 项目复制的手机执行器，保留 `LICENSE`（Apache License 2.0）和原始源码。`android/` 来自同一项目的 companion-app，包含此前为小满编写的设置、接管和录屏扩展。
- `vendor/deepseek-harness-weixin/`：`deepseek-harness-weixin` 0.2.5，来源 https://github.com/sliverp/DeepSeek-harness-weixin ，保留原始 MIT LICENSE。该副本含当前部署中已有的 dsh API 适配、截图发送和错误诊断修改；独立迁移时另将诊断脚本路径改为环境变量，并固定依赖版本。具体见 `docs/weixin-patches.md`。
- `@deepseek-ai/dsh` 及配套包：通过 npm 安装，入口版本 0.1.5-rc.1；实际依赖版本、来源和完整性记录在 `package-lock.json`，各包许可随 npm 包保留。
- `skills/{weather,apple-reminders,apple-notes,summarize,goplaces}/`：从现有本地技能包复制，保留原始 `SKILL.md` 的 metadata 和工具安装声明。它们依赖的 CLI 不随源码包提供。

本文件记录来源和修改，没有重新指定第三方组件的许可。
