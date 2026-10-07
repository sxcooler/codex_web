# 回答底部操作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付按轮次 fork 与回答自带记忆引用面板。

**Architecture:** Runtime 复用幂等 mutation 和历史头读取，API 复用会话鉴权及元数据。前端在现有 Markdown 复制区旁组合操作组件，引用直接消费原生 item 数据，无插件扫描。

**Tech Stack:** TypeScript、React、Fastify、Node test、Playwright；无新增依赖。

**Spec:** [回答底部操作规格](../specs/2026-10-07-message-actions.md)。用户明确要求设计后用子 agent 实施，执行方法已确定，不重复请求同一授权。

## Global Constraints

- 无新增生产依赖，不新增通用插件系统，不修改真实配置／记忆，不调用插件安装、授权或工具执行。
- 所有实施与 review 子 agent 使用 `gpt-6.1-sol`、`high`；不再派生子 agent。
- 复用已有 Runtime、认证、元数据、导航与复制逻辑；不改发送语义、历史加载、设置页功能。
- 仅操作隔离工作树；不推送、不合并主分支、不重启在线服务。只对测试临时数据实施写入。
- 中文提交，本需求全部临时提交最终 squash 为一个，保留原提交信息；不 squash 之前的设置页提交。
- 保留失败和跳过分母；fixture、协议生成、真实只读和真实 fork 的验证结果分别记录。

## Review Focus

- 旧原生端忽略 lastTurnId 导致复制未来轮次 → Task 1 验证新历史边界。
- fork 已成功但元数据或前端列表刷新失败 → 两任务均保留新 ID，不再创建。
- 用户导航离开期间 fork 成功 → Task 2 不劫持当前页面，保留可恢复结果。
- 畸形引用和来源路径 → Task 2 文本展示、校验并跳过，不提供文件读取。
- Markdown 共享于文件预览和流式回答 → Task 2 可选 footer 接口保持默认复制和流式行为。

## Task 1：原生 Fork 服务与会话 API

**Files:** 修改 `src/codex/runtime.ts`、`src/server/api.ts`、`tests/fixtures/runtime-server.mjs`、`tests/runtime.test.ts`、`tests/api.test.ts`；必要时新建独立 `tests/fork.test.ts` 以保持测试清晰，不增加生产服务层。

**Interfaces:** 新增 `Runtime.fork(threadId:string,input:{lastTurnId:string;clientRequestId:string}):Promise<{threadId:string;status:'idle';cwd:string}>`；POST `/api/sessions/:threadId/fork` 返回 `{threadId,status,warning?}`，cwd 仅用于服务器关联项目。错误沿用现有 `{error,code,partial?}`，已知新 ID 的部分成功通过 `partial.threadId` 保留。原生不支持使用 `RUNTIME_FORK_UNSUPPORTED`，未知使用现有 `RUNTIME_RESULT_UNKNOWN`。将确切错误/status 映射记录报告供 Task 2 使用。

- [x] 写失败用例：两个已完成轮次按第一轮 fork，只收到第一轮，源历史不变；精确参数无配置覆盖；只读预检不 resume，不 start turn；普通 fork 可 list。
- [x] 写失败用例：未找到／未完成目标拒绝且无 fork；并发相同 ID 只一次 mutation；相同 ID 不同轮 409；原生未知方法、超时／断连、返回源 ID、缺失返回字段、回读包含未来轮次均不误报成功；部分成功保留新 ID。
- [x] API 断言无认证／CSRF 与额外 cwd／config 字段不触发 fork，项目路径取原生结果，元数据警告不重发。运行相关测试确认 RED。
- [x] 复用 readThread(headersOnly)、idempotent、mutation、verifyPermissions 和原生状态登记，实现固定签名与安全错误边界；精确调用当前 CLI 已生成协议。
- [x] 运行 `node --test --test-concurrency=1 tests/runtime.test.ts tests/api.test.ts`（以及新增 fork.test.ts），`git diff --check`。报告 RED/GREEN、验证边界；提交「增加按轮次创建原生会话分支」。

## Task 2：回答操作区、引用面板与集成验收

**Files:** 新增 `src/web/MessageActions.tsx`、`tests/message-actions.spec.ts`；修改 `src/web/Conversation.tsx`、`src/web/Markdown.tsx`、`src/web/MarkdownView.tsx`、必要的 `src/web/SessionView.tsx`、`src/web/style.css`；更新 `docs/guides/sessions.md` 与本 spec/plan 验收状态。不重写复制组件或导航。

**Interfaces:** 消费 Task 1 POST，复用 `api()`、`navigate()`、Session `onChanged` 和草稿保存；`MarkdownView`/`Markdown` 增加可选 `actions?:ReactNode`，在已有 Copy 旁渲染。`MessageActions` 接收当前 threadId/turnId、是否可 fork、原生 memoryCitation 和列表刷新回调；props 精确命名由本任务统一定义并记录。引用不依赖插件安装列表。

- [x] 编写浏览器失败用例：只有 completed 轮次最后普通 assistant 有 fork；正确 lastTurnId/clientRequestId；成功刷新与导航；重复点击一次 POST；列表刷新失败仍可进入新 ID；确定失败留页，未知结果无重发／明确核对提示；离开页面后的响应不劫持新页面，已知 partial 可打开。
- [x] 引用用例覆盖多条、空、畸形、特殊字符、历史刷新、流式隐藏、Enter 打开／Escape 关闭焦点返回、外部点击关闭；无任意文件或插件扫描请求。
- [x] 运行定向浏览器套件确认 RED，补最小组件与布局，保留源草稿、复制、时间和 Markdown 默认行为。在 390px 与 1440px 核验。
- [x] 运行 `tests/message-actions.spec.ts`、`tests/message-times.spec.ts`、相关 Markdown 套件及 `tests/codex-settings.spec.ts`、`tests/questions.spec.ts`、`tests/settings-restart.spec.ts`；无疑虑不反复跑。使用忽略配置 `.local/playwright-settings-chrome.config.ts`、4189、workers1；清除 NO_COLOR，临时目录使用工作树 `.local/tmp`。
- [x] 完整 `node --test --test-concurrency=1 tests/*.test.ts`，`npm run build -- --outDir .local/message-actions-build`，`git diff --check`。默认并发已知有旧 timing/runner/cleanup问题；不修改旧测试或排除任何用例。
- [x] 更新指南和验收记录（可放 spec 末尾），区分生成协议、fixture 与真实操作证据；不 fork 用户现有会话作为测试。提交「增加回答分支入口与记忆引用面板」。

## 控制器收尾

- [x] 两任务独立 review 通过后，整分支 review；处理实质发现。
- [x] 合并本需求临时提交并保留原消息，基准 b4efd5a 不改；保留隔离分支，说明未部署与未实测真实 fork。

## 自审

A1/A2/A3 → Task 1；A4/A5/A6 → Task 2。接口与 Review Focus 已分配；当前协议已由 0.159.2 生成确认。仅保留两个可独立验收任务，无插件发现、市场、任意路径、真实记忆读取或新通用框架。
