# 会话轮次结果与执行过程反馈实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 失败原因始终紧贴对应轮次，执行过程不重复显示整轮失败，压缩与原生重连有明确反馈。

**Architecture:** 使用现有快照与 SSE 字段，在前端分别计算轮次结果和过程局部状态。新增小型结果组件，保留原有折叠、缓存、阅读位置与权限保护。只展示原生正在重试的事实，不发起新执行。

**Tech Stack:** TypeScript、React 19、现有类型安全国际化、Node test、Playwright、Vite。无新增依赖。

**Spec:** [会话轮次结果与执行过程反馈](../specs/2026-10-20-turn-outcome-feedback.md)。

## 全局约束

- 用户已确认“落 plan，然后实施”，本计划保存后连续执行，不再增加计划审批。
- 复用干净的 `.worktrees/operation-feedback-20261015`，分支 `fix/turn-outcome-20261020`，基于 `9f38212`。不新增 worktree，不推送辅助分支。
- 保留“每个失败轮次末尾一次结果”，包括仅用户消息和空 items。正常成功不堆卡，中止保持中性。
- 根据官方 App 调研收敛：普通过程省略“已记录”；恢复建议只在最新失败展示；压缩超过 10 秒显示等待解释；原生重连与终止失败分开。
- 保留原始错误，不猜测网络或服务端根因，不把已经送达的消息改为发送失败，不把局部工具问题等同整轮失败。
- 不修改后端协议、writer、发送保护、审批、未知提交、自动接续和释放。真实故障会话不重发、不接续，后端不重启。
- 官方完整 UI 未实测。仅借鉴已核对的安装包逻辑，不复制原生包或加入开关框架。
- 当前代码图谱服务返回 Transport closed，按源码与测试定位。工作树已有依赖，不重新安装。
- 只验证当前产品支持的暗色主题；仓库没有浅色切换，本次不新增主题系统。
- 每项工作先看新增回归失败，再实施并验证。实现、计划和验证记录最终合并为一个中文提交，保留原提交信息。不推送。

## Review Focus

1. 空 items、只有用户消息及多个过程分组的失败，仍各有一份折叠外的结果。
2. 原生重连、压缩等待与已终止的失败不混淆，旧错误不得覆盖新活动轮次或未知提交。
3. 历史加载与语言切换不重复播报失败，不重置草稿、过程状态、阅读位置或发出会话写入。
4. 原始错误可能含 HTML、长行和路径，显示为文本，复制仅含错误及轮次元信息。
5. 命令退出码 1 的既有规则、真实工具异常、无可靠时间与不一致 error/status 均不被误判。

## Task 1：轮次与过程状态的共享判定

**Files:** 新增 `src/web/turnFeedback.ts`、`tests/turn-feedback.test.ts`；修改 `src/web/turnActivity.ts`、`src/web/i18n/catalogs/session.ts`，复用既有 `tests/turn-activity.test.ts` 回归。

**Interfaces:**
- `turnOutcome(turn, locale)`：返回结果种类、简短标题和详情说明，或 undefined。只有明确 failed 才显示确认失败。
- `turnErrorText(turn)`：仅输出错误及必要轮次时间，不拼入对话、路径或快照。
- `executionGroupIssue(items, locale)`：复用记录异常规则，返回异常／未结束摘要，正常返回空字符串。
- `nativeRetryText(retry, locale)`：依据已有原生重连消息展示保守摘要，不产生请求。

- [x] 新增单测：明确压缩 SSE 超时、普通断连不误归类、服务繁忙、无原因、中止、运行／完成附错误、退出码 1 与真实异常、上下文整理归组、错误复制范围。
- [x] 执行 `node --test tests/turn-feedback.test.ts tests/turn-activity.test.ts`，确认新增行为失败，原有用例通过。
- [x] 实施最小共享判定与中英文文案。压缩分类要求同时匹配 remote compact 和 SSE idle timeout，不根据文件大小或计时器判定失败。
- [x] 同命令及 `tests/i18n-session.test.ts` 通过，记录结果。

## Task 2：轮次末尾结果、过程摘要与压缩反馈

**Files:** 新增 `src/web/TurnOutcome.tsx`、`tests/turn-feedback.spec.ts`；修改 `src/web/Conversation.tsx`、`src/web/SessionView.tsx`、`src/web/style.css` 和必要的旧 fixture。

**Interfaces:**
- `TurnOutcome({turn, latest, duration})`：独立于执行折叠的紧凑结果，提供本地展开详情和复制反馈。最新失败才给恢复建议。
- `TurnMessages` 复用 Task 1 共享判定，增加 latest 标记；终态本轮时间仅显示一次，运行时间在当前活动分组。
- `Session` 保持既有状态判定，移除顶部聚集的轮次错误，空消息但有失败轮次也渲染。

- [x] 浏览器回归使用新增的 `tests/turn-feedback.html`／`turn-feedback-fixture.tsx`，以真实 Session／PaneLayout 和受限视口模拟 API／SSE。现有 i18n fixture 未限制页面高度，因此不用于本次布局验收。覆盖多过程失败、仅用户消息、空 items、未完成工具、详情和复制。旧实现上确认结果卡位置断言失败。
- [x] 实施结果组件。错误和中途说明都保留；默认标题和原因简洁，长错误放详情，复制成功／失败如实反馈。
- [x] 过程卡只显示自身异常或未结束摘要，正常省略标签。只有当前活动分组展示运行／等待状态。
- [x] 上下文整理进入共享步骤映射。仅当前有明确 inProgress 的压缩记录显示运行提示，10 秒后增加“可能需要几分钟”；缺少开始时间或状态不猜测、历史成功记录不回染。
- [x] 保留惰性挂载、原始数据、输出缓存和展开状态。中英文切换、历史刷新、终态 SSE 后不重置。
- [x] 新失败只经一个 live region 播报，历史初载／翻页／语言切换不重新宣告。
- [x] Task 2 浏览器回归通过，不出现意外写入和额外历史请求。

## Task 3：顶栏定位、原生重连及全链路验收

**Files:** 修改 `src/web/SessionView.tsx`、`src/web/turnFeedback.ts`（若需共享判定）、`tests/turn-feedback.spec.ts`；新增 `docs/verification/2026-10-20-turn-outcome-feedback.md`；更新设计与索引。

**Interfaces:**
- 顶栏仅在已同步、确认空闲、最新轮次失败或中止时提供结果定位。使用稳定的轮次结果 id，点击只滚动并聚焦。
- `snapshot.retry` 必须匹配当前活动轮次、且当前仍在执行，才展示原生重连。优先于普通执行摘要，不能在结束后继续显示“重连中”。

- [x] 新增浏览器状态变更回归，确认旧失败摘要不会覆盖新执行、待输入／审批、断线或未知提交。点击定位不提交、不接续。
- [x] 实施紧凑顶栏，桌面表达“空闲＋上轮未完成”，窄屏缩短可见文本但保留完整可访问名称。
- [x] 将匹配的原生 retry 显示在活动轮次附近，保留原文详情；不新增客户端重试、自动重发或额外轮询。
- [x] 实测 1280／1440px、360／390px，中英文，Tab／Enter／Space、详情展开、复制成功与失败、历史滚动、语言切换及相邻控件布局，查看截图与控制台。
- [x] 执行 `node --test tests/turn-feedback.test.ts tests/turn-activity.test.ts tests/i18n-session.test.ts tests/session-sync.test.ts`、相关 Playwright 用例、`npm test`、`npx tsc --noEmit`、独立输出 Vite 构建和 `git diff --check`。大日志写入忽略目录，保留失败／跳过分母。
- [x] 用可用的 Playwright Chrome MCP 走测试入口并查看截图；Browser skill 未提供，因此使用既有 Playwright，不新增插件。不得以 fixture 结果替代原生压缩恢复或手机实机验收。
- [x] 完成一次独立审查，修复重要发现并补回归。执行 skill 要求一次最终 reviewer，按项目规则使用 gpt-6.1-sol。
- [x] 更新验证记录、设计与 plan 进度，形成一个中文实现提交。本地集成不推送，任何静态部署或重启结论与代码验收分开记录。

## 当前进度

Task 1、2、3 已完成。最终相关浏览器 30/30 通过；全量 Node 808 项中 803 通过、5 跳过、0 失败；类型及独立生产构建通过。本地静态资源已交付，后端未重启。实现形成一个中文提交并本地快进集成，不推送。失败记录、独立审查修正及未验证范围详见验收记录，不将提示修复推断为原生故障恢复。
