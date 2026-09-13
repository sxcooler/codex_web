# 会话增量同步实施计划

> For agentic workers: Use superpowers:subagent-driven-development. 按任务实施与独立复核；不再询问已授权的实施许可。

**Goal:** 消除实时更新反复重传完整会话的问题。
**Architecture:** Runtime 产生可回放增量；快照携带一致水位；浏览器按会话 revision 和消息 id 合并；异常恢复权威基线。
**Tech Stack:** TypeScript、React、现有 Fastify SSE 与 Node test/Playwright。
**Spec:** docs/superpowers/specs/2026-09-11-session-sync-design.md

## 全局约束

不新增依赖，不中断当前服务，不触碰用户凭据；本次代码生成一个中文提交并保留旧提交。打包输出写 releases，测试使用独立解压目录。初始工作区干净，在现有用户工作区实施。

## 任务 1：后端增量与基线

Files: src/codex/runtime.ts, src/server/api.ts, tests/runtime.test.ts, tests/api.test.ts, tests/fixtures/runtime-server.mjs，必要时新增 tests/runtime-sync.test.ts。

- [x] 先用真实 Runtime + 模拟原生事件断言：delta payload 不含历史、item/turn 终态可覆盖、快照水位可回放；未实现时失败。
- [x] 实现规格中的 change.patch 与 syncCursor，保留旧 change envelope；SSE 接受 cursor 且优先 Last-Event-ID，缺口 resync。
- [x] 已完成正文在前端复用，服务端使用有界头/轮次签名基线，并提供轻量状态校验；测试原生历史请求数、换代和外部变化。
- [x] 定向测试与独立复核通过。

## 任务 2：前端合并与连接生命周期

Files: 新增 src/web/sessionSync.ts、tests/session-sync.test.ts；修改 src/web/SessionView.tsx；新增 tests/session-sync.html。

- [x] reducer 测试先覆盖重复 revision、偏移重叠、消息替换、旧终态后迟到增量、错误缺口；例如 applyChange(snapshot,event) 返回 null 表示必须重新同步。
- [x] 实现 applyChange(snapshot,event)，只复制被修改的轮次和消息，保留未变化历史对象。
- [x] 首次快照后带 cursor 建连；change 合并到当前快照，ready/ping 仅更新连接状态，resync 才刷新基线；普通受理响应保留连接；手动刷新、重连与外部状态校验遵守后端契约。
- [x] 浏览器模拟长对话与连续增量，断言只有首次一次全量 GET，断线与重同步不丢字；原发送和面板回归通过。

## 任务 3：交付与重新打包

- [x] 全量 npm test、npm run build；独立代码复核并修复确定问题。
- [x] 更新文档实际契约和验收结果，git diff --check，一个中文提交。
发布步骤（代码提交后执行）：`npm run package:portable`；校验两个归档及 SHA256SUMS，解压后用 PORTABLE_TEST_DIR 运行 tests/portable-package.test.ts；产物和校验报告写入 releases。

## 执行记录

文档在本次代码修改前写入。后端与前端按以上 patch 契约独立实施；如果为一致性调整契约，同步文档和双方实现。

实现无新依赖。用户补充的会话菜单外部点击关闭已同步完成并加入发送页回归。后端与前端独立实现后完成只读复审，3 项具体问题均已有失败复现和修复回归。构建与生产资源浏览器检查通过，详见设计文档验收记录。
