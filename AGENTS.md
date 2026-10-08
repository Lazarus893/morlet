# Personal Agent 开发约定

- 这是独立的小满项目，运行目录在 `.runtime/`。不要修改原部署或原 auto-phone 目录。
- 优先使用 `scripts/pa.sh`；配置模板在 `config/`，运行前由 `scripts/configure.py` 生成本机路径。
- 不将 API key、微信凭据、私人记忆、任务截图或录屏加入 Git。源码包用 `scripts/package.py` 的白名单构建。
- 人设在 `home/AGENTS.md`；新增技能直接放入 `skills/`，不要依赖项目外的机器路径。
- 主 runtime 和微信插件版本已锁定。微信插件的修改保存在 `vendor/deepseek-harness-weixin/`，同步更新 `docs/weixin-patches.md`。
- 检查用 `./scripts/pa.sh check` 和 `python3 -m unittest discover -s tests -v`。测试不得发送微信消息或控制真实手机。
- 不因迁移放宽沙箱和审批；录屏授权和扫码绑定由用户完成。
