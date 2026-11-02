# 活动检查与单弹窗重启实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击入口自动列出活动会话，同一弹窗直接提供绿色“重启”或警告色“强制重启”，并修复终态错误判定与错误原因丢失。

**Architecture:** 在 Runtime 内共享结构化检查结果，既有空闲断言消费同一判定。复用 API、dialog、受管进程控制和 Windows 90 秒调度，显式传递强制模式及已确认影响范围。

**Tech Stack:** 现有 TypeScript／React／Fastify、Node test、Playwright 和 PowerShell，不增加依赖。

**Spec:** [已确认 spec](../../design/2026-10-22-restart-activity-and-force.arch.md)。

## 全局约束

- 用户已明确要求“落 plan 然后实施”，保存后连续执行，不增加计划审批或风险勾选。
- 单一弹窗、唯一执行按钮：无活动绿色“重启”，有活动警告色“强制重启”；检查不完整禁用执行并说明具体原因。
- 复用 `.worktrees/operation-feedback-20261015`，分支 `fix/restart-activity-20261022`，基于 `56e10a7`。不新增 worktree、不推送辅助分支。
- 保留所有已确认活动、子 Agent 和临时任务；只读列表／历史／模型请求不阻塞重启。不能借由卸载、接续或发送来检查。
- 原生状态、查询错误与历史错误保留；不得从 systemError 一律推断空闲。外部 writer、未确认历史和写入冲突继续保护。
- 强制只影响本服务持有的 Codex 子进程和已验证的受管 Web 服务，不按名称杀进程，不接管独立 App／CLI。
- Windows 保留桌面预检、90 秒延迟、PID／实例校验和结果文件；强制必须贯穿 worker，不能只省略 RequireIdle。
- 真实运行服务、真实任务不用于重启／强制验收。不在旧后端上单独交付新前端协议；最终说明代码完成与后端生效边界。
- 新行为先 RED 再 GREEN；使用隔离 fixture。任务提交最终 squash 为一个中文提交，提交正文保留原任务提交信息；本地集成，不推送。
- 执行记录保存在本 worktree 的忽略目录 `.local/restart-activity/progress.md`，保留失败／跳过分母；一次最终独立审查，按项目要求使用 gpt-6.1-sol。

## Review Focus

1. 有原生活动但 Web 没有对应 state、隐藏子 Agent、临时命名线程及无名称线程，不能遗漏或错误开放普通重启。
2. 检查到确认／延迟执行之间增加轮次、实例替换或外部占用，不能扩大已确认强制范围；正常进度不造成无休止过期。
3. 强制期间原生中止不响应、stdin 关闭超时、后台查询还在等待或客户端断连，仍须有界结束受管子进程且不重复调度。
4. systemError 仅在可靠的终态与归属证据下放行；未知／空历史／缺页／坏游标不得被当成空闲。
5. 两种入口、中英文、长清单和窄屏均使用同一直接确认流程，检查／确认失效不增加第二弹窗或偷偷改成强制执行。

## Task 1：结构化活动检查与终态判定

**Files:** `src/codex/runtime.ts`；新增 `tests/restart-activity.test.ts`，必要时扩展 `tests/fixtures/runtime-server.mjs`；复用 `tests/runtime-restart.test.ts`／`tests/runtime.test.ts`。

**Interfaces:**
- 导出 `RestartInspection`：`checkedAt`、`complete`、`sessions`、`blockers`、`issues`、`canRestart`、`canForce`、`version`。会话包含 threadId、可用名称／项目名、类别、状态和当前轮次；异常包含阶段、相关会话、原始原因与错误码。
- `Runtime.inspectRestart(): Promise<RestartInspection>`：不启动新实例，20 秒总预算，收集本地活动与全部原生 loaded 分页；元信息缺失仅回退名称。
- `assertNativeIdle(): Promise<void>`：复用报告，活动返回既有 busy，未确认返回 unavailable，并保留诊断原因；不修改更新器严格只读保护。

- [x] 新增断言：多个本地与原生活动均列出、审批／输入、隐藏任务与名称兜底；旧实现因缺少报告而失败。
- [x] 新增断言：终态 systemError 放行，空历史／不一致／外部占用不放行；单条读取失败继续其他条目，诊断保留阶段和会话。
- [x] 实现共享扫描和确定性活动版本，版本不含普通输出、标题或时间。
- [x] 运行 `node --test --test-concurrency=1 tests/restart-activity.test.ts tests/runtime-restart.test.ts`，再运行 `tests/runtime.test.ts`，结果通过后提交。

## Task 2：普通／强制执行与受管 Web 链路

**Files:** `src/codex/runtime.ts`、`src/codex/app-server.ts`（仅必要时）、`src/server/api.ts`、`src/server/app.ts`、`src/server/main.ts`、`src/server/restart.ts`、`scripts/server-control.ts`、`scripts/windows/restart-server.ps1`；相关 `tests/settings-restart.test.ts`、`tests/service-exit.test.ts`、`tests/windows-*.test.ts` 及 Task 1 测试。

**Interfaces:**
- `RestartSelection={mode?:'normal'|'force';version?:string}`：旧调用默认 normal；强制必须携带已检查版本。
- `Runtime.authorizeRestart(selection): Promise<RestartScope|undefined>`：重查并核对受影响集合；不符返回 `RUNTIME_RESTART_CHANGED` 及最新报告，未产生写入。
- `RestartScope` 由服务端产生：原生实例 epoch 与批准的 threadId／turnId 集合，跨 Windows 调度保存；worker 接受减少的活动，不接受新增轮次或实例变化。
- `reloadModels(selection?)` 复用既有返回结构；强制先关 admission，再向受管实例发送 turn/interrupt 并有界关闭 owned child，重启后不自动重发。
- `prepareRestart(scope?)` 默认保持空闲模式；显式 scope 的强制调用经私有受管控制接口核对后停止 owned child，并保留 admission 关闭直至 Web 退出。
- `webRestart.schedule(scope?)` 经 `ForceScopeFile`／私有控制载荷传递 scope；旧调度仍 RequireIdle。不能对旧服务回退为无条件强制停止。

- [x] 写先失败的测试：无 version 不能强制、确认后新增活动返回新报告、输出进度不影响版本；正常模式不升级成强制。
- [x] 写先失败的 fixture 测试：真实子进程中断／关闭／重建、未响应中止的有界关闭、外部进程不受影响、写入时拒绝、重复请求去重。
- [x] 实现带验证的普通／强制入口；复用现有认证／Origin／CSRF，更新结构化 GET 报告与参数 schema。
- [x] 写并通过 Windows fixture：强制 scope 实际到达 worker 和私有控制端；新任务／旧实例取消；普通旧调用、桌面校验及结果文件不退化。
- [x] 运行针对性 runtime、settings、service-exit、Windows 重启测试，读取结果后提交。

## Task 3：单弹窗与中英文浏览器验收

**Files:** `src/web/WebSettings.tsx`、`src/web/i18n/catalogs/settings.ts`、`src/web/style.css`；`tests/settings-restart.spec.ts`、受影响 i18n／设置 fixture。

**Interfaces:**
- 入口打开即 GET 报告；目标标题不变。按报告显示活动清单、具体异常和唯一执行按钮；重查不重复写入。
- 执行携带 mode／version；`RUNTIME_RESTART_CHANGED` 更新当前弹窗报告，用户对新清单再次点击；网络结果未知不自动重复提交。
- 所有文案使用现有类型安全国际化。取消、Esc、焦点返回、用户主动会话链接沿用既有行为。

- [x] 旧实现上确认新增浏览器断言失败：完整清单、绿色普通与警告色强制、没有第二步／勾选、未知状态禁用。
- [x] 实现单弹窗，桌面约 640px；窄屏左右 12px，正文单一滚动，执行按钮独占一行。首焦点取消，保留真实 dialog 和相邻控件布局。
- [x] 覆盖两个入口、1280／1440px 与 360／390px、中英文、长名称／错误／清单、Tab／Enter／Space／Esc、重查／范围变化／复制无关写入。
- [x] 通过真实浏览器查看受影响入口、交互及截图，全部使用演示 API／隔离服务，禁止命中真实重启 POST；记录 pageerror 与测试边界。
- [x] 跑相关设置与国际化浏览器、类型检查及独立输出生产构建，读取结果后提交。

## Task 4：最终审查、全量回归与本地集成

**Files:** 更新 spec 状态、plan、`docs/README.md` 及重启设计说明；新增 `docs/verification/2026-10-22-restart-activity-and-force.md`。

- [x] 一次最终独立审查覆盖 Review Focus、全部调用方和强制生命周期；重要发现一轮 RED→GREEN 修正，次要发现及判断写入记录。
- [x] `node --test --test-concurrency=1 --test-timeout=90000 tests/*.test.ts`、相关 Playwright、`npx tsc --noEmit`、独立 Vite 构建及 `git diff --check`。日志落忽略目录，保留首轮失败与未验证范围。
- [x] 记录普通／强制受管 fixture、浏览器截图及真实服务未重启边界；不把模拟通过写成现场问题已恢复。
- [x] 将本次实现提交 squash 为一个中文提交，正文保存原提交信息；核对主分支无变更后本地快进集成，不推送。新接口需要后端重启生效，本次不自动重启真实服务。

## 进度

计划先于产品实现保存。现有隔离 worktree 已准备，基线 `runtime-restart`＋`settings-restart` 13/13 通过。用户已批准按 spec 连续实施。

实施与最终一轮审查修正已完成：全量 Node 832 项中 827 通过、5 跳过、0 失败，相关浏览器 44/44，类型及独立构建通过。详见[验收记录](../../verification/2026-10-22-restart-activity-and-force.md)；真实后端与前端静态资源未更新。
