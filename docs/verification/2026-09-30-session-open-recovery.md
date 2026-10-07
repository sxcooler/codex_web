# 发送后刷新：会话打开失败的恢复

> **现场验收未通过（用户后续反馈）**：前端恢复用例通过不代表实际会话已修好。用户刷新后仍收到 `Native thread activity could not be reconciled`，任务本身仍在 Codex Web 执行。后续证据见文末；不能把本记录的静态部署核验视为端到端修复验收。

## 现场与证据边界

用户在发送消息后等待同步，因等待较久刷新浏览器；随后历史可见，但输入区显示“会话占用状态未确认”，发送不可用。

首次 `/open` 请求的 HTTP 响应与耗时未留存，现场 Web 服务未开启诊断日志。因此不能认定首次失败一定是超时、其他客户端占用或浏览器刷新取消了后端任务。原生记录显示该会话之后仍有执行活动，但不能代替当次 HTTP 证据。

## 已确认的代码链路

1. `SessionView.tsx` 发送 `/messages`，再以历史里的 `userMessage.clientId` 核对消息；浏览器刷新会重建组件。
2. 进入会话先调用 `/cancel-release`，再调用 `/open`（30 秒超时），随后读快照并连接 SSE。
3. `/open` 的非子 Agent 错误被统一替换为占用未确认文案，原错误信息丢失。
4. `openError` 阻止发送；SSE、定时 `/status` 和普通 `load()` 都不会重新调用 `/open`。连接和历史恢复不等于打开成功，故不能简单在收到 SSE 时清空错误。
5. `Runtime.open()` 对 `reserved`、`activeTurnId` 和待处理请求直接返回状态，并复用正在执行的 `openPromise`；刷新不会再次启动一轮任务。真实外部占用返回 `EXTERNAL`，必须继续阻止发送。

补充边界：`drafts` 是内存 Map，硬刷新不保留未确认发送的本地气泡。恢复依赖服务端历史，不以同文内容猜测接收结果，也不自动重发。草稿持久化不纳入本次修复。

## 实施计划

按 writing-plans 与测试先行流程在当前工作区实施；用户已授权文档和修复，无需再次确认。保留已有 `tests/questions.spec.ts` 修改。

- [x] 新增浏览器回归：提交响应未返回时刷新、打开失败后恢复、原消息只提交一次；1440px 和 390px 均验证。
- [x] 在 `SessionView.tsx` 的现有加载流程中增加有限重试：瞬时网络/超时/5xx/忙碌错误最多自动重试两次，在本次快照读取结束后间隔 3 秒；手动重试重置额度。
- [x] 打开成功才清除错误；正常历史/SSE 不解锁；认证、权限和子 Agent 拒绝不自动重试；离开会话/释放时取消重试。
- [x] 保留错误详情，失败时底部明确显示待重试；历史读取未完成时也显示错误详情。
- [x] 验证持续失败的上限、手动恢复、外部占用、离开取消、打开超时；运行构建、Node 测试及相关浏览器回归。

第一批生产变更仅修改前端会话恢复。后续取得真实错误和状态后，补充后端恢复修复，见下文；没有新增依赖，也未重启正在执行任务的服务。

## 验证结果

新增 `tests/session-open-recovery.spec.ts` 和 `tests/runtime-open-recovery.test.ts`；无依赖变更。

标准浏览器复验入口为 `npx playwright test tests/session-open-recovery.spec.ts --reporter=line`。本机 Browser 连接不可用，使用项目已有 Playwright 测试；临时配置仅复用本轮启动的 4178 测试服务，TEMP/TMP 指向 `.local/tmp` 以避免系统临时缓存目录的写入限制。

先运行失败用例，确认桌面/手机在服务恢复后仍无法插话，以及错误详情丢失。复核再发现旧 RUNNING 快照的竞态：`/open` 返回 EXTERNAL 后，读取新快照前若结束 `opening`，旧快照可能短暂解锁插话。新增延迟快照用例确认旧行为失败，再将禁用状态保持到整个加载完成；后端占用防护保持原样。

| 检查 | 结果 |
| --- | --- |
| `npx playwright test --config .local/session-open.config.ts tests/session-open-recovery.spec.ts --reporter=line` | 7 通过，含实际 30 秒打开超时、持续失败最多 3 次、权限拒绝、离开取消、旧快照竞态与慢历史错误提示 |
| 相关 Runtime / 同步 / 历史 / submission / handoff Node 测试 | 119 通过 |
| `npm test -- --test-timeout=90000` | 272 通过、5 按条件跳过、0 失败；4 个 Linux 专用用例及 1 个便携产物用例跳过 |
| `npm run build -- --outDir .local/session-open-dist` | 类型检查和构建通过；已有大包体积警告 |
| 独立代码复核 | 发现的旧快照竞态已用失败→通过回归闭合 |

完整测试最初在沙箱内卡住于 Git 超时清理用例；该用例单跑仍超时，沙箱外完整测试通过。只清理了本轮测试目录对应、命令行核实后的辅助进程。

旧 `tests/session-toolbar.browser.mjs` 首次首屏超时，重跑在第 58 行读取已消失的 `.composer-compact.textContent` 失败。通过 Vite 加载未修改的 HEAD 版 `SessionView.tsx` 后复现相同失败，未把这个旧脚本报告为通过，也未扩大修复范围。

本机证据（`.local` 不随 Git 提交）：[浏览器结果](../../.local/session-open-browser-final.log)、[完整 Node 结果](../../.local/session-open-node-final.log)、[相关 Node 结果](../../.local/session-open-related.log)、[构建结果](../../.local/session-open-build.log)、[旧脚本基线失败](../../.local/session-open-toolbar-baseline.log)。

[桌面恢复后](../../.local/session-open-1440-recovered.png) · [窄屏恢复后](../../.local/session-open-390-recovered.png)。截图显示原消息仍在历史中，插话恢复可用；浏览器断言确认只提交过一次原消息。

## 运行页面更新与验收边界

将验证构建的新 assets 复制到 `dist/assets`，保留旧 assets 供已打开页面按需加载；最后替换入口 HTML。经配置的 HTTPS 入口读取，HTML 与脚本均为 200 且内容与构建文件一致，[静态部署核验](../../.local/session-open-deployment.json)记录脚本校验值。管理记录中的后端 PID 前后均为 30892，未执行后端重启；浏览器刷新后加载新前端。

首次用 localhost 核验得到 Host 防护的 403，部署脚本已自动恢复旧入口，随后改用配置的 HTTPS 地址重新核验成功。未修改地址白名单或降低访问限制。

浏览器回归使用真实 React 页面与受控 HTTP/SSE 边界，不代表已重现现场首次失败；现场当次请求的具体原因仍未证实。未向真实会话发送测试消息。原有 `tests/questions.spec.ts` 改动保留，不纳入本次提交。

## 后续现场排查：后端版本与真实活动

- 用户提供的实际错误是 `Native thread activity could not be reconciled`，由 `Runtime.open()` 的 owned 分支在 reconcile 后仍不能确认活动状态时抛出。有限重试不足以修复持续的后端状态不一致。
- 当前受管后端为 PID 30892，实际进程启动时间为 2026-09-29 15:51:20。它早于 `1e54df2`（18:03）的子 Agent 过滤修复，也早于 `24855d6`（17:51）的重启前原生活动检查修复。后者不是这段会话恢复逻辑的修复，两者不可混同。
- 上次安排的重启结果为 `failed: Legacy idle check refused shutdown; no process was stopped.`，不能把“安排重启”当作已生效。
- 新通知指向 `00000000-0000-4000-8000-000000000106`，原生状态库确认其 `thread_source=subagent`、`agent_path=/root/review_recovery`，即本次修复审查的子 Agent。当前运行后端未加载过滤代码，是通知回归的已确认原因。
- 问题主会话最新轮次 `00000000-0000-4000-8000-000000000107` 在历史库为 `inProgress`；rollout 只有本轮开始，没有本轮完成；03:19:51 日志仍在输出推理事件。执行进程 PID 31628 的父 PID 正是 30892，与用户“在 Web 执行”说明一致，不是桌面端占用，也不是仅凭旧数据库推断的残留任务。
- 未停止、重启或接管该原生进程。独立只读诊断进程的 `thread/read` 返回 `thread not loaded`，不能用它代替现有后端的状态。
- 用户从已登录页面读取的快照确认：`phase=UNKNOWN`、`activeTurnId=null`、`error=Native thread activity could not be reconciled`、`thread.status.type=active`；最近三轮是 completed / completed / inProgress，最后一轮 ID 与正在执行的原生轮次一致。这证明运行状态与 Web 认领状态不一致，但快照经过 live 合并且只含最近三轮，尚不能据此判定 completedTurns 污染或旧轮次的 inProgress 冲突。继续读取较早历史的轮次状态以区分这两个分支。

## 后端补充修复：终态缓存阻断活动恢复

用户随后完整读取旧历史：共 28 轮，27 completed、1 interrupted，`nextCursor=null`，没有第二个 inProgress。结合当前 owned 分支错误、active 线程和唯一执行中轮次，证据指向本地 `completedTurns` 缓存阻断认领。现有日志没有记录最初哪次读取或通知写入了错误终态，不能宣称已复原该现场事件。

代码层面已复现持续失败机制：一次终态读取留下 `completedTurns` 后，新原生历史即使确认 `active + inProgress`，旧 `reconcile()` 仍排除该轮次。此缓存没有重新验证机制；打开错误也会残留并继续阻止插话。新增测试通过受控读取/通知建立这两种缓存来源，旧代码在 open、snapshot、release 三条恢复路径失败。

修复共用 `Runtime.reconcile()`：

- 仅对当前后端持有、未释放且非外部占用的线程，在新原生历史恰有一个 inProgress 时纠正终态缓存并恢复原轮次 ID；不 resume、重复 start、interrupt 或 unsubscribe。
- 读取前记录活动通知版本；读取期间若收到轮次开始、完成或线程状态通知，不用该次较旧读取重新认领轮次。普通文本增量不会妨碍打开恢复。
- 清除这条特定的“活动状态无法核对”错误，并修正旧终态 live 缓存造成的快照显示；其他错误不会被顺带清除。
- 多个 inProgress、外部占用、已释放以及执行中的释放请求仍保持保护。原来的子 Agent 过滤修复不重复实现。

后端定向用例 9 个通过（含原发送刷新用例）：两种终态缓存来源 × 三个恢复入口、读取期间完成通知、所有权/歧义/其他错误边界。恢复后实际调用 fixture 的 `turn/steer`，断言原生 turnStarts=1、resumes=0、interrupts=0、unsubscribes=0。相关 Runtime/历史/同步用例在补充边界测试前共 123 个通过；`npx tsc --noEmit` 通过。

完整 `npm test -- --test-timeout=90000`：280 通过、5 按条件跳过、0 失败。另补断言确认恢复后继续接收该轮次的文本增量，9 个定向用例复验通过。[完整后端回归](../../.local/session-open-backend-node.log) · [后端定向回归](../../.local/session-open-backend-focused.log)。

**部署状态：未激活后端补丁，现场验收仍未完成。** 原生状态库复核最新轮次仍为 inProgress，故未执行重启；此前只发布了静态前端，不代表 Node 后端模块更新。待所有活动任务结束后，按仓库要求使用 `scripts/windows/restart-server.ps1 -RequireIdle` 安排安全重启；必须读取结果文件确认 success，再验收会话恢复和子 Agent 通知过滤。
