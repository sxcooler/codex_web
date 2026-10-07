# Final whole-branch merge review

- Reviewer: gpt-6.1-sol / high，独立最终审查。
- Range: `0960010a93a4df02d4c10768060a9de1bcbbf5ee..8b0497e595b988bd9d1c01f7cd152a6aee0a0d99`。
- Spec compliance: **PASS**。
- Quality / merge assessment: **APPROVE**。本分支没有剩余 Critical / Important，未发现新增 Minor。

## Findings

### Critical

无。

### Important

无。Task 1 继承速度校验、Task 2 cwd-only mock 身份、Task 3 密码错误就近提示与 CR-only 截断判断的修正均在最终范围内；不是仅根据各任务的通过结论作判断。

### Minor

无本分支新增 finding。`.local/settings-ux/final-build.log` 仍有既有 >500 kB chunk warning；没有证据表明本改动引入该问题，不要求本需求扩成打包优化。

## Cross-layer checks

- **模型与速度**：`src/codex/settings.ts:99-131` 将用户模型与有效模型分别校验；项目 standard 覆盖不能隐藏无法核实的用户继承速度，显式兼容速度提供恢复路径；模型切换保留 effort 兼容性和 managed serviceTier 限制。`src/web/ConfigSettings.tsx:34-40` 消费用户/有效模型的 tier 交集，标准映射 default，附加项来自 native catalog。未知目录保守拒绝。现有 `Runtime.saveModelDefaults` (`src/codex/runtime.ts:1025-1034`) 仍进入共同 writeSettings 校验路径，没有旧接口旁路。
- **原生记忆 / CAS**：`src/codex/settings.ts:19-25,65-78,139` 的 native 白名单、父键来源、独立 defaultValue 和 external-context 读写反转与 API schema/UI 一致。featureRequirements.memories 与受管来源限制仍在共享写入路径，基础层/profile/version/readback/unknown 保护保留。UI 的默认、未配置、未知和 readonly 反馈有独立表达；既有 agentmemory 未被冒充为 native memory。
- **余额与账号**：`src/server/account-usage.ts:14` 固定投影三个 credits 字段；`src/web/accountUsage.ts:14-23` 明确 codex 桶优先，null 不借用另一个桶，余额格式化保留十进制字符串精度，零/未知/无限分开，不求和或猜币种。核对现有 server read (`:35-59`) 的身份前后检查、cache identity/generation、ACCOUNT_CHANGED 传播，以及 Provider (`src/web/AccountUsage.tsx:26-49`) 的清旧账号/失联处理。新增余额沿同一账户数据流和共享 content 渲染，未绕过 reset 确认/幂等。
- **fork 登记与可信读取**：`src/server/api.ts:75,170` 正常快照读取和确认 fork 结果登记；`src/server/metadata.ts:19,25-31` 独立持久小表、不可变 seq、SQL keyset LIMIT 32。`src/codex/runtime.ts:237-263` 共享 header read 要求同 ID/ordinary source/明确 forkedFromId/空 preview；native codexHome 的 sessions 或 archived_sessions 必须通过 lexical containment、realpath containment 和文件存在性。header 去掉 turns，无 rollout/原生 DB 写入或虚假消息。清 Web 偏好保留 fork 事实；archive/unarchive/clear 失效 header，外部移动/删除使旧路径 fail closed。
- **分页、成本与排序**：`src/server/api.ts:134-164` cursor 绑定 sortKey/archived/includeHidden，native 与 fork 两路各自保留位置，耗尽 native 后仍能到达第 33 条以后的候选。最多 32 候选/并发 4/5 秒补充 RPC 与初始化预算，超时清 pending、禁止迟到补读和短预算 history 重试。native 重复游标拒绝；合并 ID 去重且采用 native 时间。`src/web/main.tsx:35-50,66,80` 排序变化清 cursor、取消旧请求、generation 拒绝迟到响应；收藏置顶、跨 tab 偏好和续页排序链路一致。
- **设置草稿与既有消息操作**：`src/web/Settings.tsx:17-35` 记忆/速度/配置/指令互斥挂载，单一 DraftActions，沿共同导航 guard，离开失败保留草稿。`src/web/navigation.ts:7-23` 的历史恢复/批准跳转接口与新 instructions 路由兼容。`src/web/MessageActions.tsx:33-51` 仍消费同形 threadId/status/warning API 响应，明确成功才导航，unknown 不自动再创建；Runtime 内部增加 header 没泄入公共 fork response。`.message-actions` / `.memory-citation-panel` CSS 原样保留，设置样式作用域没有覆盖消息操作。
- **布局 / 差异 / 维护**：设置 overflow 作用于含 settings 的 workspace；桌面分类与正文分别滚动，窄屏固定分类选择。`src/web/textDiff.ts:3-20` 使用同一 CRLF/CR/LF separator 计数和拆分，LCS/渲染有明确上界；`src/web/GitHistory.tsx:7` 原 renderer 的 kind/line-number/split 合同兼容，共用一个滚动容器。`src/web/WebSettings.tsx:18-41,52-58` 保留维护预检、unknown/pending 拒绝及 90 秒确认；password error 位于表单旁。插件只读状态、余额共享弹层和高级详情仍可用。

## Verification evidence

- 完整 supplied `final-review.diff`（commits/stat 与全部文件 hunks）分块阅读；截断输出的遗漏部分从包内恢复。阅读 spec、plan、progress Ruling、task reports/reviews 及 `design-qa.md`。未重新生成全分支 diff，未重复跑全套。
- 图谱优先使用 list_projects/search_graph/trace_path/check_index_coverage；项目 metadata_changed、两个新 UI 文件 not_tracked、CSS partial，所以当前 diff 和被点名的外部调用点源码是最终依据，不根据图缺失声称代码不存在。
- 独立读保存的 `full-node-frozen.log`：**389 总 / 384 pass / 0 fail / 5 skip / 0 cancelled**，约 174 秒。5 skip 为 Linux 服务三项、Linux 文件名一项、未提供 extracted portable release fixture 一项。主会话报告退出 0。
- 完整 Chrome **102/102** 为主会话已提供结果，发生在最后四文件修补前；本审查独立读修补后 `review-settings-green.log` **7/7** 和 `review-textdiff-green.log` **1/1**，不把相关复跑称为完整 Chrome 重新执行。
- 独立读 `final-build.log`，tsc + vite build 成功，无编译错误；退出 0 为主会话提供证据。现有 chunk warning 保留。
- 早先两轮 full Node 的 **389 总 / 383 pass / 1 fail / 5 skip** 保留在 progress 与实施记录；最终冻结树结果没有抹掉失败分母。
- 设计 QA 为主会话实际打开官方/实现图片并三轮修正后的 passed；本 reviewer 没有重复截图或宣称自己完成视觉对照。本轮没有新的具体疑点需要额外定点测试，未运行测试或服务动作。

## Accepted limits / release boundary

- 遵循明确 Ruling：后来加载的补充 fork 可插入已加载时间顺序，首屏不保证尚未读取候选的全局顺序；UI 已显示补充 pending。读取失败不会制造 header，用户须刷新重试。32 是每请求候选预算，不是永久总上限。
- header 最多 30 秒缓存、每次仍验证文件路径；同路径 preview/header 变化可在 TTL 内滞后。外部归档/删除旧路径消失时立即 fail closed；未猜测未知原生目录布局。
- native 隐藏较多时最多五个普通分页 RPC 的既有行为没有改变；新 5 秒预算只约束 fork 补充，不能把它宣称成整个 /api/sessions 的总 SLA。
- 未连接真实目标会话 `00000000-0000-4000-8000-000000000105` 作部署后恢复验收，未更改真实配置/记忆/额度或服务。测试证明修复链路与边界，不等于真实部署目标已经恢复可见。
- 本报告批准上述冻结行为范围合并；最终 squash/真实部署/重连后目标验收由主会话按已授权流程完成。本 reviewer 唯一写入为本文件，没有改实现、index、HEAD 或运行状态。
