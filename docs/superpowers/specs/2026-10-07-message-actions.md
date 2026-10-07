# 回答底部操作：Fork 与引用的记忆

日期：2026-10-07。状态：已按用户确认方案实施，两任务独立审查及整分支审查通过，本需求合并为一个中文提交并保留原提交信息。基于设置页提交 `b4efd5a` 的独立分支 `codex/message-actions`；未合并主分支、未部署。

## 目标与范围

在现有回答复制操作旁增加「分支到新聊天」和「引用的记忆」。通过 Codex 接口处理 fork 和回答自带的引用数据；不枚举插件、不按插件名称适配、不建立插件注册框架。本轮已知内容类型只有 `memoryCitation`，后续真实出现其他类型时再增加展示。

当前主机 `codex-cli 0.159.2` 的新生成协议确认 `thread/fork` 接收 `threadId`、`lastTurnId` 和 `excludeTurns`，返回新 thread 与有效配置。`agentMessage.memoryCitation` 为 `{entries:[{path,lineStart,lineEnd,note}],threadIds:string[]}`。生成文件位于忽略目录 `.local/message-actions-protocol`；协议证据不等同于真实会话写入验收，也不能单凭字段判断引用是哪个插件生成的。

## 交互

- 保留现有复制 Markdown、代码复制、消息时间、图片和链接行为。回答操作区使用已有样式和可访问按钮，390px 无横向溢出。
- 在 `status === completed` 轮次的最后一条普通 assistant 回答下提供 fork；不在执行步骤、中途说明、异步问题或仍在生成的轮次提供 fork。历史轮次同样可用。
- 点击 fork 只创建新聊天，不发送提示、不重新执行任务、不回滚文件。继承至所选轮次（含该轮）的原生聊天上下文，后续轮次不进入新聊天；新聊天使用原项目目录。普通 fork 保持在会话列表中，不按子 agent 过滤。
- 请求期间防止重复点击。成功后刷新会话列表并进入新会话；源页面输入草稿按已有机制保留。列表刷新失败不得让已经创建的会话丢失，仍能打开返回的新 ID。
- 明确失败保留源页面并可显式重试；超时、断连、响应异常等结果未知不自动重试，说明先核对会话列表。已知部分成功的新 ID 提供明确打开入口，不再创建一次。组件卸载后的成功响应不能把用户从另一个页面强行跳走。
- 有有效 `memoryCitation.entries` 时显示「引用的记忆」按钮，点击打开只读小面板，摘要为主，路径／行号作为来源。键盘可打开、Escape 关闭并还原焦点；鼠标点外部关闭。无引用不显示空按钮，畸形记录跳过，全部无效则隐藏。生成中不展示未完成引用。
- 引用正文使用 React 文本渲染，不执行 HTML；来源路径只显示文本，不据此读取任意文件或生成远程资源链接。不调用 Agent Memory API、不扫描记忆文件、不写记忆。

## 后端边界

新增 `POST /api/sessions/:threadId/fork`，唯一 body 为 `{lastTurnId:string,clientRequestId:string}`。复用认证、Origin、CSRF、ID 格式与严格字段校验，不接受 cwd、任意配置或 RPC 名称。

`Runtime.fork(threadId,{lastTurnId,clientRequestId})` 复用现有幂等表和 mutation 错误处理：同请求 ID 同参数共用结果，参数不一致 409；保证仅限当前 Runtime 生命周期，不承诺跨服务重启的 exactly-once。

操作前以原生历史头信息验证用户会话和目标轮次已完成，不通过 open/resume 接管或修改原会话。使用 `thread/fork({threadId,lastTurnId,excludeTurns:true})`，不覆盖模型、权限、cwd 或指令。验证返回的新 ID 不等于源 ID；按现有模式维护新会话状态和有效权限，不从源会话的 UI 值猜测配置。

回读新会话的轮次头信息验证截断边界，避免不支持参数的原生端静默复制后续历史。验证失败不宣称成功、不自动删除新会话；保留已知新 ID 和结果未知提示。API 复用原生 cwd 与现有 projectForCwd/saveMeta 关联项目，元数据保存失败只作警告，不创建第二次。

不支持原生方法、目标不存在／未完成、权限状态不可表达、传输结果未知需可区分；未知错误不得作为“安全重试”的证据。缺字段和 malformed 响应按不确定结果处理。

## 全局约束

1. 无新增生产依赖，不新增通用插件系统，不修改真实配置／记忆，不调用插件安装、授权或工具执行。
2. 所有实施与 review 子 agent 使用 `gpt-6.1-sol`、`high`；不再派生子 agent。
3. 复用已有 Runtime、认证、元数据、导航与复制逻辑；不改发送语义、历史加载、设置页功能。
4. 仅操作隔离工作树；不推送、不合并主分支、不重启在线服务。只对测试临时数据实施写入。
5. 中文提交，本需求全部临时提交最终 squash 为一个，保留原提交信息；不 squash 之前的设置页提交。
6. 保留失败和跳过分母；fixture、协议生成、真实只读和真实 fork 的验证结果分别记录。

## 验收

- A1：真实 Runtime + fake peer 证明 fork 参数固定、目标验证、截断回读、原会话未 resume／修改，无 turn/start。
- A2：同请求重复合并，参数冲突、未知结果、部分成功、原生不支持及异常响应有断言；失败不盲目再发 mutation。
- A3：API 认证／CSRF／严格字段与服务器所属项目关联验证，普通 fork 正常显示。
- A4：浏览器操作只出现在正确轮次；成功导航、刷新失败、重复点击、确定失败与结果未知、卸载竞态均验证。
- A5：引用面板覆盖有／无／畸形／多条／特殊字符引用、键盘与外部关闭、历史刷新；不读记忆文件，原文不会成为 HTML。
- A6：复制及消息时间／Markdown 回归通过，390px 与桌面布局可用；Node 完整单并发、浏览器相关套件、TypeScript、隔离输出构建、diff 检查通过。

## 非目标

插件管理与通用 MCP UI 宿主、记忆编辑／删除、点赞反馈、分享链接、导出、fork 工作目录副本和文件回滚均不在本轮范围。回答引用的来源归属按接口证据展示，不伪造 Agent Memory 标签。

## 工作树实施验收记录（2026-10-07）

Task 1 与 Task 2 已完成并通过任务 review；整分支 review 通过，无未解决 Critical／Important／Minor。交付提交保留本需求全部原临时提交信息。未部署、未推送或合并主分支，未对真实用户会话执行 fork。

- A1–A3：真实 Runtime + fake native peer、真实 API/auth/projects/metadata fixture 验证，包含截断回读与已知 partial 打开后权限恢复；不把 fake peer 视为真实原生 fork 成功。
- A4–A5：新回答操作浏览器套件 15/15；相关浏览器整套 68/68，Chrome、workers 1、4189。本轮 fixture 验证只创建模拟新 ID，无真实 fork、记忆扫描或插件扫描。390px 与 1440px 引用截图已检查。
- A6：消息时间、问题/文件预览 Markdown、设置/重启 fixture 回归通过；原 Markdown 自检两宽度 PASS，图片浏览器套件两宽度 PASS。TypeScript 和隔离 `.local/message-actions-build` 构建通过（保留既有 Vite 大 chunk 警告），`git diff --check` 通过。
- 完整 Node 单并发首轮 372：363 通过、4 失败、5 平台跳过。四个失败均为测试 TEMP/TMP 混合路径分隔符与 realpath 严格比较不一致；规范化工作树临时路径后定向 4/4 通过，最终完整单并发 372：367 通过、0 失败、5 平台跳过、0 取消。不改旧断言、不排除用例，保留两轮分母。

完整 RED/GREEN、停止轮、环境归因和日志/截图路径见工作树 `.superpowers/sdd/2026-10-07-message-actions/task-2-report.md`；此目录为本地忽略的协作证据。分支结果复用浏览器生命周期内的草稿 Map，不承诺完整刷新、关闭或退出登录后恢复；未知结果需先核对会话列表，已知新 ID 可显式打开。

### Task 2 review 修复 I1

有效且不同于源的新 `threadId` 配合缺失／异常 `status`，仍按结果未知处理，但保留已知 ID 并提供原有“打开已创建的会话”入口；不自动导航或再次创建。无效 ID 和源 ID 不进入恢复入口。定向浏览器 RED 4：2 失败（缺失／异常 status 丢入口）、2 通过（无效／源 ID）；修复后聚焦 GREEN 11/11，涵盖四个新边界和七个原错误恢复用例。当前源码的 TypeScript／隔离构建通过，保留既有大 chunk 警告；本轮未重复 68-browser／完整 Node，不把先前完整结果当作本轮重新执行。
