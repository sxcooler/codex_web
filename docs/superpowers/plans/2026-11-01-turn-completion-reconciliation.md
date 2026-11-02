# 已完成轮次误报中止实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:executing-plans，在当前会话逐项实施；最后进行一次独立代码审查。用户已明确授权修复并要求先落文档。

**Goal:** 原生轮次已完成时，页面不再锁存“本轮已中止”，同时保留真实终态及乱序保护。

**Architecture:** 先核对原生只读协议，再在 Runtime 与客户端既有同步边界补充终态纠正；复用现有 snapshot/SSE、revision/activityRevision 和真实 SessionView 验收，不另建历史数据库真相。

**Tech Stack:** TypeScript、Node test、React、现有 Playwright fixture；不新增依赖。

**Spec:** [修复设计](../../design/2026-11-01-turn-completion-reconciliation.md)。

## Global Constraints

- 不修改用户 rollout/SQLite，不自动重发、resume、abort、抢占 writer 或重启服务；不新增依赖。
- 真实 interrupted/failed 保留；旧事件不得复活终态，读竞争不得回滚更新活动。
- 仅修复轮次终态；压缩失败、提供商和泛化 UNKNOWN 提示不在范围内。
- 文档先于代码；临时回执放 `.local/`；最后一个中文提交，保留阶段提交原文。

## Review Focus

1. 同 ID 旧 interrupted、新鲜 completed：浏览器必须接受可信纠正。
2. 真实 interrupted/failed 与已存在的最终文字：不能推断成成功。
3. 读取期间收到新 started/completed/status：旧读取不得覆盖。
4. 新轮次运行时纠正旧轮次：不清空 activeTurnId，不解锁重复发送。
5. 重连、相同 revision 与核对失败：有界 resync，无自动写入和请求风暴。

## Task 1：核对实际边界并固定 RED

**Files:** `tests/runtime-sync.test.ts`、`tests/runtime-history.test.ts`、`tests/session-sync.test.ts`；只在必要时扩展 `tests/fixtures/runtime-server.mjs`。

**Interfaces:** 既有 `Runtime.snapshot/status/onNotification` 与 `applyChange(snapshot,event)`、`mergeSnapshot(previous,next)`。

- [x] 运行相关基线；只读核对生产案例对应的原生终态，区分持久化与协议读取；本机证据只存忽略目录。
- [x] 在发现的最小边界补 RED：完成通知被旧 interrupted 历史页覆盖，以及迟到终态通知覆盖已确认完成；断言最终回答保留、中止状态消失、无原生写入。
- [x] 补反例：真实 interrupted/failed 即使有文字仍保留；新轮次活动使旧核对失效；核对失败和重复旧读不丢证据、不反复请求。
- [x] 运行新增测试，保留预期失败输出；首批 5 项与审查补充 2 项均观察到对应 RED，修复后通过。

## Task 2：最小实现与状态回归

**Files:** 仅修改 RED 指向的 `src/codex/runtime.ts`、`src/web/sessionSync.ts`、`src/web/SessionView.tsx` 或 `src/web/turnFeedback.ts`；不要求全部修改。

**Interfaces:** 外部协议与现有组件签名优先保持；复用只读核对与错误保护。

- [x] 在实际根因位置实现最小修复，不移除 completedTurns 的乱序保护，不根据文字宣告成功。
- [x] 运行 `node --test --test-concurrency=4 tests/runtime-sync.test.ts tests/runtime-history.test.ts tests/runtime-open-recovery.test.ts tests/runtime-release-list-feedback.test.ts tests/session-sync.test.ts tests/turn-feedback.test.ts`，79/79 通过。
- [x] 审查修复后加入 `tests/runtime.test.ts` 一并验证，174/174 通过，含原有普通并发读取合同。
- [x] 复用原有有界诊断，未新增正文、RPC 或状态载荷记录。

## Task 3：浏览器验收与交付

**Files:** `tests/turn-feedback.spec.ts`，必要时扩展其既有 fixture；本设计、计划与 `docs/README.md`。

- [x] 用真实 SessionView/SSE fixture 重现中止→权威完成纠正，验证最终回答、顶部状态、横幅、发送/停止状态及草稿；保留真实中止反例。
- [x] 检查 1440/390、中英文、键盘焦点、相邻控件，保存并查看 8 张新截图；Browser 访问 host 不可用，使用项目现有独立 headless Edge。45/45 浏览器回归通过。
- [x] 最终完整 Node：1039 项，1034 通过、5 跳过、0 失败；隔离类型/构建与 diff 检查通过。首轮失败及暂停中断分别保留于验收报告。
- [x] 一次独立代码审查提出 2 项 Important，均 RED→GREEN 并通过完整回归；无 Critical/Minor，未重复独审。线上尚未部署或重启。
- [x] 将阶段提交合成一个中文提交，并在提交正文保留原提交说明；未推送或自动重启线上服务。

## 当前执行记录

- 2026-11-01：基线 `62e5c0f`；隔离 worktree `.worktrees/turn-completion-20261101`，分支 `fix/turn-completion-20261101`。文档先行提交 `e6d597e`，随后完成 Runtime 最小修复、7 项 Node 回归与 8 个浏览器组合。
- 用户要求暂停时，停止最终全量测试并保留全部改动；收到“继续”后补完最终全量、构建与 8 张截图检查，没有把中断运行计为通过。
- 完整裁定、命令和分母见[验收报告](../reports/2026-11-01-turn-completion-reconciliation.md)。已收口单个中文提交，当前待整合选择；未修改真实会话历史或运行服务。
