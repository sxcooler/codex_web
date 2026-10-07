# 设置体验与会话列表修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 主会话完成设计与计划，实施和 review 使用 gpt-6.1-sol / high。

**Goal:** 实现截图指导的设置布局、原生速度/记忆/余额，补齐 fork 列表与会话排序。
**Architecture:** 扩展既有 native CAS 设置投影和 AccountUsage 数据；在既有元数据层记录 Web fork，读取原生 header 补充列表；UI 复用现有保存保护、DiffView 和 CSS，不引入组件库。
**Tech Stack:** TypeScript、React、CSS、Node SQLite、Codex app-server、node:test、Playwright Chrome。
**Spec:** `docs/superpowers/specs/2026-10-07-settings-ux.md`

## Global Constraints

- 主会话负责设计与计划；实施及 review 全部由 gpt-6.1-sol / high 子 agent 完成。
- 不增加 UI 依赖；保留 native CAS、未知结果不自动重试、原生权限约束、草稿保护和 fork 幂等。
- 不改真实 Codex 配置/记忆作为验证，不创建真实测试聊天，不消费额度、不充值、不重启服务。
- 默认按更新时间；收藏置顶；原生列表分页也必须使用相同 sortKey。
- 所有正式功能必须接真实接口，未知不能伪装为关闭或零，余额不得推导币种。
- 中文提交，最终本需求压成一个提交并保留原提交说明；在现有隔离分支 codex/settings-ux 实施。

## Review Focus

1. 用户模型与项目有效模型不同，速度目录和受管 serviceTier 不允许非法写入。
2. 未配置 memories 子项、托管 featureRequirements、开关反向语义；指令草稿导航不能被记忆表单覆盖。
3. credits 单/多桶冲突、未知/零/超大余额、账号变更；不能破坏重置操作幂等。
4. fork 在原生列表缺席，外部归档/删除、隐藏与分页去重；补充读取失败不能制造幽灵会话或全表 RPC 风暴。
5. 长路径、大指令文本、390px 窄屏、滚动到底、快速排序切换后的旧响应；不可仅靠快照宣称交互正常。

## Task 1：原生设置能力与余额投影

**Files:** `src/codex/settings.ts`, `src/codex/runtime.ts` 的 models/settings 部分，`src/server/codex-settings.ts` 严格请求 schema，`src/server/account-usage.ts`, `src/web/accountUsage.ts` 类型，`tests/codex-settings.test.ts`, `tests/account-usage.test.ts` 及现有 API 用例。
**Interfaces:** SettingsValues 扩展 `service_tier:string`, `memoriesEnabled:boolean`, `generateMemories:boolean`, `useMemories:boolean`, `allowExternalMemory:boolean`；分别映射 service_tier、features.memories、memories.generate_memories、memories.use_memories、反向 memories.disable_on_external_context。SettingsField 增加可选 `defaultValue`（官方默认，必须保持 userValue=null 的事实）。native model 投影保留验证后的 serviceTiers/defaultServiceTier。UsageGroup 增加 credits={hasCredits:boolean|null,unlimited:boolean|null,balance:string|null}|null。读取保持白名单。

- [x] 在现有测试添加速度合法目录/受管限制、记忆布尔反转/来源与默认/受管 feature 限制、额度投影边界的失败用例。
- [x] 扩展既有 settings nativeKey/value 与白名单，不绕过版本比较、写回验证；附加速度按模型目录校验，default 永远代表标准，不硬编码 fast。
- [x] 补齐 models 与 credits 投影，避免泄露其他配置/账户信息。
- [x] 跑聚焦 Node 测试及 tsc，记录命令输出并提交；由独立 reviewer 看任务 diff。

## Task 2：fork 可见性和排序链路

**Files:** `src/server/metadata.ts`, `src/server/api.ts`, `src/codex/runtime.ts` 的 fork/list/header 部分，`src/codex/app-server.ts` 可选单次请求超时，`src/web/main.tsx`, `src/web/preferences.ts`；`tests/fork.test.ts`, `tests/app-server.test.ts`, 现有 API/runtime 列表 tests 与 `tests/recent-sessions-recovery.spec.ts`。
**Interfaces:** 浏览器 `SessionSort='updated_at'|'created_at'`，`readSessionSort()`/`writeSessionSort()`，成功写后 window 派发 `session-sort-changed`；默认 updated_at。GET /api/sessions 新 sortKey 白名单；Runtime.list 传原生 sortKey、desc。设置控件由 Task 3 消费偏好方法。

- [x] 添加 empty-preview fork 缺失回归、元数据持久化、归档/隐藏/子 agent、排序与分页/过期响应回归。
- [x] 在 MetadataStore 用独立小表记录已确认 fork 的 header/来源（不要迁移整个 session_meta 结构）；成功 fork 和明确 forkedFromId 的正常会话读取登记，支持现有目标已打开后恢复。
- [x] 补充登记的 fork：只读 thread/read includeTurns:false，校验 ordinary fork，原生 path 必须严格位于 initialize codexHome/sessions 或 archived_sessions 下，用实际存在性及规范路径判定归档；未知路径/null 不能当 recent。只补 preview 为空的 fork，非空预览交回原生分页。禁止写原生DB/rollout、补发消息、scan-and-repair。SQL按不可变登记序号keyset分页，每次候选最多32条，并发最多4；补充总短预算（目标5秒），超时不能拖垮正常列表或无限遗留RPC。缓存30秒且每次使用核对原生文件存在/分类，Web归档/恢复/清理使其失效。对于首次升级已有记录，只在实际正常会话读取确认fork时补登记，不做无界启动扫描。
- [x] 使用最小带版本复合游标，绑定sortKey/archived并保留native cursor与fork keyset位置。32不是候选总上限，两路均耗尽才结束；按ID去重，main对已载入条目按原生时间重排；fork仍有未读候选时返回并显示相应状态。大量空fork的后续批次可能插入现有排序位置，这是已知边界，不建立全历史快照或无限已发ID游标。对本次既有案例可通过正常打开确认fork登记，或部署时受控一次性补登记，测试不得改真实DB。
- [x] main 使用偏好请求、按选择对已载入列表排序（收藏优先），事件/跨tab storage刷新；清旧cursor/取消旧响应；不因为 metadata.updated_at 或打开页面提升 native 更新时间。
- [x] 跑聚焦测试，记录输出并提交，独立 review。

## Task 3：设置界面与差异预览

**Files:** `src/web/Settings.tsx`, `ConfigSettings.tsx`, `InstructionsSettings.tsx`, `InstalledPlugins.tsx`, `AccountUsage.tsx`, `style.css`；必要时独立 `WebSettings.tsx` 拆出现有维护页，纯文本差异 helper；现有 settings/usage/browser tests。
**Interfaces:** 消费 Task1 fields/credits/model tiers 和 Task2 sort偏好；已有 DraftProps 不破坏。ConfigSettings 支持配置/速度/记忆字段组（可 mode prop），共享已有 CAS 逻辑。personalization 路由 `view=instructions` 单独进入指令编辑，避免多份 draft owner。

- [x] 按 spec 实现独立导航/内容滚动、紧凑分组行、中性设置配色；Codex Web独立分类与维护状态卡片。优先修根层 overflow，不只给 nav sticky。
- [x] 常规速度 + 即时保存发送快捷键，个性化原生记忆 + 指令入口，配置详情渐进展示；清晰 readonly/overridden/dirty/error状态。
- [x] 指令修改转为既有 DiffView 内容结构，红绿变化/行号；桌面 split 共用容器联动，窄屏 unified。限制算法资源，尽可能复用已有构建器；没有时只新增必要纯函数。
- [x] 余额卡片紧跟周期用量，reset credits 独立；已安装插件紧凑列表并折叠详情。
- [x] 以现有测试 fixture 增补真实行为检查：滚动时 nav top不变、mobile不溢出、记忆/速度保存、dirty离开、红绿diff/共享滚动、排序即时生效与持久化。测试不触发真实服务维护。
- [x] Chrome真实渲染截图：1440x900、390x844；保存每页和滚动后证据到 `.local/settings-ux/`，主会话按官方参考做设计QA，修可见P0/P1/P2。
- [x] 聚焦测试 + tsc + build，提交；独立任务 review，主会话全量测试一次及最终全分支 review。

## 收尾

- [x] 主会话记录浏览器桥只读归因，区分已证实与推断。
- [x] 主会话完成 `design-qa.md`，记录对照范围与限制、截图证据。
- [x] 全部通过后按本需求 squash，保留每次原始提交说明；不擅自重启。若用户授权部署，使用既有脚本 -RequireIdle -Diagnostics 并遵守立即结束规则。

## 执行与验证（2026-10-07）

- Task 1、2、3 已实施并通过独立任务审阅；原生速度继承校验、旧 header fixture、密码就近错误、CR-only 截断均已修正并复审。
- 主会话在 Chrome 实际截图对照官方参考，桌面1440、平板768、手机390，最终 `design-qa.md` 为 passed；没有把模拟 API 写入当成真实账号修改。
- 冻结版本全量 Node：389 项，384 通过、0 失败、5 跳过（Linux服务3、Linux大小写1、未提供portable包1）。完整浏览器102/102；最终密码/CR修补后相关浏览器7/7、helper1/1。最终 TypeScript 与生产构建通过；保留已有大 chunk 提示。
- 保留失败分母：第一次全量 Node 为383/389通过、1失败、5跳过，原因是旧fixture缺协议必需ID；第二轮同分母，遇到并行加入的CR红灯用例。冻结后第三轮才是上述绿色结果。Chrome聚焦曾50/51，修复插件fixture就绪等待后51/51。
- 最终整合审阅 PASS / APPROVE，0 Critical / Important，见 reviews/2026-10-07-settings-ux.md。本地部署仍须按安全重启脚本执行并在重连后核对 success；没有在验证过程中重启服务或修改真实配置/记忆/额度。