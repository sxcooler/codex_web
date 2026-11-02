# 会话终态与活动状态一致性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用户后续明确授权实施后，使用 superpowers:executing-plans 或 superpowers:subagent-driven-development。用户已明确授权实施；只修改状态处理代码，不修补用户历史。

**Goal:** 消除同一轮仍有运行证据却显示“本轮已中止”的矛盾，恢复后续消息同步，并保留真实历史终态与乱序保护。

**Architecture:** 在 Runtime 历史/live 合并与客户端增量同步边界识别冲突，以 epoch/thread/turn/revision/source 核对。复用现有只读 resync 通路和现有结果组件；不删除终态保护，不用隐藏横幅替代状态修复，不用 resume/abort/重启改变原生任务。

**Tech Stack:** TypeScript、现有 Runtime/SSE、React、Node tests、Playwright；不新增依赖。

**Spec:** `docs/design/2026-10-28-extensions-and-rich-content.arch.md` 第 13 节。

**Status:** 代码与隔离验收完成；实际运行服务验收待重启。实现基线 `6b05921`，两份计划同轮获授权，目录与终态来源仍分开记录。

## Global Constraints

- 本次只读证据说明原生当时持续工作；首次错误 interrupted 的来源仍未知，不可写成已定位唯一生产根因。
- 当前 active turn 与历史终态冲突必须核对；旧 terminal turn 不可被迟到旧事件复活；不同 turn 的历史结果保持可见。
- `applyChange` 不能在吞掉新活动的同时推进同步 cursor；冲突复用 null→完整 resync 通路。完整 snapshot 也须内部一致。
- 状态核对失败不得变成 IDLE 或允许重复发送；停止按钮的点击/受理、断线与 release 均不代表 native terminal。
- 只记录有界状态证据：epoch、匿名关联 ID、turn 状态、来源、revision/activity generation、核对结果；不记录正文/工具参数/完整 RPC payload。
- 不改用户 rollout/SQLite、不自动重发、abort、resume、抢占或重启；真实服务只读复核。按 AGENTS 使用中文提交并收口单个实现提交。

## Review Focus

1. 真 completed/interrupted/failed 后迟到 started/delta：不可复活，Task 1、2。
2. 同 turn 的更高 revision 活动与终态锁存冲突：必须 resync 且恢复后续输出，Task 1、3。
3. native 历史读与 live 活动并发：只读旧结果不能写入错误的 completedTurns，Task 2。
4. full snapshot 自相矛盾、重连/epoch 变化及反复冲突：不接受坏 baseline，也不产生无界 resync 风暴，Task 2、3。
5. 旧轮真实中止/新轮运行，以及用户停止失败/长任务/compaction：历史与当前状态按 ID 区分，Task 3、4。

## Task 1：隔离复现与状态证据

**Files:** 修改 `tests/session-sync.test.ts`、`tests/runtime-sync.test.ts`、`tests/runtime-history.test.ts`；必要的状态诊断只修改 `src/codex/runtime.ts`、`src/server/diagnostics.ts`，须先核实该文件现有诊断入口。

**Interfaces:** 复用 `applyChange(snapshot:Json,event:Json):Json|null`、`mergeSnapshot(previous:Json|null,next:Json):Json` 与 Runtime 现有 epoch/activityRevision/diagnostics；测试只使用匿名 fixture turn IDs。

- [x] 写最小前端红测：baseline T=interrupted，下一连续 revision 带 T=inProgress 和 RUNNING/activeTurnId=T；断言 `applyChange` 要求 resync，不能返回“全局运行、T仍中止且cursor已推进”的快照。
- [x] 保留/增强反例：真实 T 已完成且新事件只是迟到 started/item，不应恢复该 turn；旧 turn interrupted、新 turn inProgress 可以共存。
- [x] 写 Runtime 红测：历史读取开始后同 T 出现更高 activity generation；迟到历史页 terminal 不得静默覆盖 live、写错 completedTurns 或阻止真实新活动。将同一事件序列同时通过 Runtime 输出与客户端 reducer。
- [x] 运行 `node --test tests/session-sync.test.ts tests/runtime-sync.test.ts tests/runtime-history.test.ts`，记录实际失败点，区别已确认的 reducer 风险和本次生产首因。
- [x] 必要时增加脱敏的状态冲突记录，明确 source/generation；不临时记录所有 RPC 内容。若原生仍返回矛盾数据，保留该不确定性，不通过改历史“修复”。

## Task 2：Runtime 历史/live 合并与只读核对

**Files:** 修改 `src/codex/runtime.ts`；对应测试为 `tests/runtime-sync.test.ts`、`tests/runtime-history.test.ts`、`tests/runtime-open-recovery.test.ts`、`tests/runtime-release-list-feedback.test.ts`。

**Interfaces:** 保留 `snapshot/loadThread/mergeThread/reconcile/onNotification` 外部合同；在原有读取上下文中携带发起时的 epoch/activity generation 与来源。冲突以现有同步/恢复状态传播，不新增可写“修复任务”接口。

- [x] 依 Task 1 的 failing sequence，在历史读取发起/完成处校验 generation，区分已确认原生终态与同 active turn 的矛盾历史页；只修改实际产生/扩大冲突的合并点。
- [x] 冲突时保留原始状态证据并执行 single-flight 的只读核对；本轮硬预算最多 10 秒，不无限递归读取。核对失败返回现有恢复/待核对状态，保留停止/连接信息，不伪报 IDLE。
- [x] 不让一个尚有冲突的终态进入 completedTurns 并永久拒绝后续新证据；也不放宽所有 completedTurns 守卫。来自当前 epoch 的真实终态仍保持不可被旧事件复活。
- [x] 对 self-conflicting full snapshot、重复冲突、进程更换、release/external writer 和 compaction 无 terminal 的情形补反例；写操作数量、stop/resume/restart 次数必须为零。
- [x] 运行 `node --test tests/runtime-sync.test.ts tests/runtime-history.test.ts tests/runtime-open-recovery.test.ts tests/runtime-release-list-feedback.test.ts`，确认 GREEN；首次引入 interrupted 若仍未被证实，验收记录继续标未知。

## Task 3：客户端冲突识别、重同步与一致展示

**Files:** 修改 `src/web/sessionSync.ts`、`src/web/SessionView.tsx`、`src/web/Conversation.tsx`、`src/web/turnFeedback.ts`、必要的 `src/web/TurnOutcome.tsx` 和 `src/web/i18n/catalogs/session.ts`；测试为 `tests/session-sync.test.ts`、`tests/turn-feedback.test.ts`。

**Interfaces:** `applyChange` 保留 null 代表需要完整 baseline；`sessionSync.ts` 新增 `hasActiveTurnConflict(snapshot:Json):boolean`，在 SessionView 接受 full snapshot 前验证，不能直接交给 mergeSnapshot 掩盖冲突。复用强制 refresh/resync，不能被“server revision相等”短路。为 timeline/headline 共用有效终态判断，扩展现有 helper 并传入必要的 active/context 信息，而不另建状态真相。

- [x] 在套用 patch.state/turn 之前检查同 ID active/terminal 矛盾；同类矛盾不接受为成功 baseline，未应用的事件不推进客户端 revision/cursor。
- [x] 核对中保留已有内容并显示同步提示；single-flight，每次冲突最多一次自动完整 resync。仍冲突或失败则显示待核对并提供手动重新同步，后续真实状态事件允许再次触发核对，避免每个 delta 无限请求。
- [x] 完整重同步成功后继续应用该 turn 的 item/delta，并保留已展开历史、附件与草稿。失败不能恢复发送按钮或自动重发。
- [x] 将完整读取和 `readChanges` 缓存回放作为同一次接受操作。回放中 applyChange 返回 null 时不得 `?? baseline` 回退并清除待核对状态，即使旧 baseline 本身内部一致也不能当成本次同步成功；受同一自动重试预算约束。
- [x] timeline 与头部共用已确认状态语义；当前冲突 turn 不宣告中止，历史真中止 turn 仍显示其结果和详情。先完成上游状态修复，再添加展示保护。
- [x] 运行 `node --test tests/session-sync.test.ts tests/turn-feedback.test.ts`，确认同 ID 恢复、乱序保护、full snapshot 一致性和旧轮/新轮并存均 GREEN。

## Task 4：真实页面入口验收与交付

**Files:** 修改 `tests/turn-feedback-fixture.tsx`、`tests/turn-feedback.spec.ts`，必要扩展 `tests/session-open-recovery.spec.ts`；更新本计划与 spec 第 13 节。

- [x] Playwright 通过真实 SessionView/SSE fixture 输入同 ID 冲突、强制 resync 成功/失败和后续 delta，验证横幅、顶部状态、停止/发送按钮、阅读位置、已有草稿均收敛；不能只给 TurnOutcome 塞静态 props。
- [x] 增加读取竞争用例：historyPending 期间先收到同 ID 新活动，完整读取随后仍返回旧终态；缓存事件回放冲突不得清除待核对、放行发送或循环请求。随后权威一致快照到达才恢复。
- [x] 覆盖真正失败/中止/完成、不同 ID 旧中止与新运行、停止请求被拒、断线/release、compaction 长任务无终态。统计 resync/发送/abort 调用，证明没有重复请求或状态修复副作用。
- [x] 运行 `npx playwright test tests/turn-feedback.spec.ts tests/session-open-recovery.spec.ts`，用独立 headless 浏览器检查 1440/390、中英文、结果定位键盘/Esc/焦点与截图，不操作用户前台。
- [ ] 对实际目标线程仅做已认证只读状态核对；复现不到时如实说明，不停止真实任务来制造中止，不宣称已证明当初首因。保存的诊断只保留允许字段。
- [x] 独立审查乱序/终态证据与 UI 一致性；运行上述相关 Node 回归、`npm run build`、`git diff --check`，核对主目录 dist，再记录实际通过/失败/未测项并收口一个中文实现提交。未经实现授权不执行本步。

## 当前证据与未完成项

已只读确认：截图对应原生轮次仍有活动，Web diagnostics 同期 RUNNING；时间线只看 turn.status；reducer 的 terminal 锁存可吞同 ID 新活动；Runtime 可能扩大历史/live 冲突。

未确认：首次引入这次 interrupted 的具体 RPC/缓存事件。已修改 Runtime/UI，未回写用户数据或重启服务；原目标线程的新实现验收需重启后进行。

## 实施裁定与证据（2026-10-30）

- syncConflict 为只读状态，核对绑定 epoch/activity generation，single-flight 最多 10 秒。失败不写 completedTurns、不放行发送/插话/release；不自动停止、resume、重启或重发。
- 完整读自身一致 idle+terminal，且无读取期间更新活动，仍是原生终态证据；同 ID 的更新活动/active 历史冲突才核对。真实 completed/interrupted/failed 及旧轮结果保留。
- full baseline 与读取期间缓存事件原子接受；相同 revision 也可 force resync。自动核对预算只由同 epoch 严格新 revision 的状态证据更新，不因每条 delta 附 state 或 A/B 旧 journal 重放而产生风暴。
- 独立审查补齐 RED→GREEN：A/B journal 回放风暴、成功核对 promise 第二次复用卡住 pending、release 读期间收到缓冲 delta。release 复用同一只读核对，真实活动/失败仍不卸载。
- 前端 Node 18/18；SessionView/SSE 浏览器完整 36/36，补验 5/5（4 项重跑，共 37 个不同用例）。已查看 1440/390、中英文核对中/恢复截图；当前轮不误报中止、旧中止保留、后续 delta、Abort/Steer/Esc 焦点；历史展开、scrollTop=100、附件 preserved.txt 与草稿跨 resync 保留。
- 首次 interrupted 的生产来源仍未知，未停止真实任务制造中止，fixture 不代表旧服务已应用新修复。

统一回归与构建回执如下；原生线程实际入口验收待用户重启后进行。

### 统一回归回执

最终全量 Node 987 项：982 通过、5 项平台/发布包检查跳过、0 失败；构建与 diff 检查通过。首轮 985 项的 2 项失败及其处理保留在目录加载计划的统一回归回执。Runtime 完整/增量/历史/release 的 fixture 均已覆盖，但代码验收不代表用户当前原生轮次的在线验收。主目录 dist 按本次源码重建后，后端仍须单独重启才能应用新状态处理。


暂停恢复后的统一 104 例浏览器核验中，会话 37 例均通过；另两例指令页 busy 竞态与该状态修复无关，已最小修复并完成 settings 52/52 及精确 6/6、2/2 复测。保留联合首轮 102/104 分母，详见目录加载计划。
