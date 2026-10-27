# DSH pet 与小满聊天

复用 dsh-pet 0.3.7 的右键「对话」、原输入框和气泡。上游只有独立模型聊天，没有转发回调，因此补丁仅替换已明确连接的小满宠物的聊天路径；其他宠物继续走原行为。上游源码散列、补丁、桥接扩展与 MIT 许可在 `vendor/dsh-pet/`，不直接编辑安装目录。

## 安装与升级

先确认实际安装版本为 0.3.7，备份 DSH profile 的 package.json、lockfile、patch 配置和 pet 用户配置。在 profile 工作目录用包管理器的 `pnpm patch dsh-pet@0.3.7 --edit-dir <隔离目录>` 创建副本，再运行本项目的 `node scripts/build-pet-chat.mjs <隔离目录>`。脚本核对上游源码散列、应用源码补丁，使用已有 esbuild 构建 host、web client 与桌面共享组件；不会复制新素材或升级 DSH。最后在原 profile 执行 `pnpm patch-commit <隔离目录> --patches-dir patches`。补丁登记到 package manager，升级时须重新审查；不能无条件应用到新版本。

主人认证的 Hub `enable-pet-chat` 操作接受已绑定 `channelId` 与 `enabled`。新配对默认只允许投递，只有主人明确开启后该通道才能接收入站；token 不能自行启用聊天或修改绑定。现有 conversation/Agent/工具审批均继续使用。

在 `$DSH_HOME/dsh-pet/xiaoman-chat.json` 配置 `petId`、绝对 `socketPath` 和随机 `token`，权限 0600，由本人持有。Mac worker 的 pet.json 用 `chatConfig` 指向这份私有文件。socket 路径 UTF-8 长度不得超过 100 字节。worker 在原排他锁下创建 0600 Unix socket，检查 token、来源、大小和有限操作。凭据仅在宿主与本机 worker 之间，不发到 renderer；另一个远端通道 token 仍保存在原 pet 配置中。

重载原 notice worker 和 DSH pet 插件后验证。普通用户不填写上游模型密钥；已连接的小满聊天失败时显式报错，禁止回退到 pet 模型伪装小满。

已连接小满的 pet 禁止经 HTTP `/chat` 入站（403），桌面对话使用上游现成的 Electron helper 管道；已授权的 DSH 原生命令也走宿主路径。这样不会因插件前缀路由缺少主 API 的浏览器校验而把 Agent 暴露给其他网页。浏览器 pet 不作为本桌面通道的第二入口。发布须在重载后确认 HTTP 被拒绝、原生管道可用，再开启 Hub 入站。

## 回复与反馈

右键菜单的操作项支持键盘焦点与 Enter/空格触发。输入框打开时读取当前通道最近 24 小时内已提交的真实推送，固定其 deliveryId。小满对话面板使用系统字体：正文与输入框14px、常规字重、1.6倍行高，按钮13px、提示12px，不继承桌宠装饰字体。通知全文在独立滚动区域显示并可选中复制，来源不截断；反馈按钮与输入框始终可见。晚到的新推送不会替换输入中的目标。普通文字携带来源摘要进入原 Hub 会话和 Agent，本轮来源材料明确标为只读数据，不是新指令或批准。主动推送暂停不阻止用户主动发起的聊天回复。

「有用／少推／不感兴趣／撤回反馈」直接调用已有手账 feedback 存储，不调用模型；也支持对应明确文字。多条摘要须先选择具体材料。服务端核对通道、会话、投递状态、有效期与条目归属，拒绝跨对象反馈。未能确定目标时不猜测。

输入请求编号在发送前写入 sessionStorage；同一未确认请求的重试沿用编号，宿主核对正文及目标散列。请求丢失或重试不能多建任务、重复修改反馈。已接受后清理草稿身份。回复仍由原投递队列发送，气泡长文节选，完整回复在「消息与任务」；API 成功仅记 submitted，不冒充用户已读。

## 自动推送验收

使用原定扫描、真实来源、既有政策和额度，不插入验收通知。内容在冷却期/夜间保存后，之后的正常扫描可从当前来源中匹配已保存但尚未推送的内容。仅复用完整来源散列一致、模型已评为 recommend、表达偏好未改变的原 hook；再次核对授权代际、正文、期限和当前兴趣后才提出通知。最多检查三条候选、每轮最多提出一条延后推荐，不额外调用模型，不增加手账整理上限。发送结果未知只核对原回执，不能换 key 重发。

功能测试使用隔离 Hub/HTTP/Unix socket；正式验收另记实际扫描时间、source key 散列、Hub deliveryId、pet counter、原生截图、真实回复及反馈记录。测试反馈不能当作用户真实兴趣信号。


## 独立 skill 安装

`xiaoman_setup.py connect --desktop-pet` 复用 dsh-pet 官方 standalone 模式，固定 0.3.7，通过 `config/pet-host/pnpm-lock.yaml` 与 pnpm 补丁安装。补丁构建仍用 `scripts/build-pet-chat.mjs`，新增官方 standalone 入口构建；上游文件哈希登记在 `vendor/dsh-pet/upstream.json`，没有原地修改 node_modules。

新增 standalone 控制面限制：HTTP 要求准确的 loopback Host，拒绝 Origin 和跨站 Fetch Metadata；原生 helper 继续用管道调用聊天，网页不能借本地端口发话。每实例 DSH_HOME、Chromium userData、Unix socket、配对令牌均独立，原有 DSH 配置与聊天绑定保留。已有 Electron 可复用；没有时走上游下载。停止安装实例时先停止 worker 再停止官方宿主，宿主负责回收 helper。
