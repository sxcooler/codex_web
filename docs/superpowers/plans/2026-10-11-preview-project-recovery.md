# 文件全屏、官方项目融合与新任务恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** 文件预览快速全屏切换，两端共用官方项目身份，新任务创建成功后能够顺畅显示和恢复同步。

**Architecture:** 预览使用同一原生 dialog 和稳定内容子树。原生项目由后端共享目录与现有元数据中的幂等映射管理，文件访问仍由 Projects 校验。新任务复用已确认创建状态、SSE、消息去重和共享刷新。

**Tech Stack:** 当前 Node（本机验证版本 v26.11.1）、TypeScript、React 19、Fastify、SQLite、原生 dialog、既有 Node/Playwright 测试；不增加依赖。

**Spec:** `docs/design/2026-10-11-file-preview-fullscreen.md`、`docs/design/2026-10-11-native-project-integration.md`、`docs/design/2026-10-11-new-task-startup-recovery.md`。

## Global Constraints

- 用户已明确授权三个设计的实施；不重复请求设计或执行方式确认。
- 所有产品实施与修复由 `gpt-6.1-sol`、medium 子 agent 执行，不再派生子 agent。
- 工作目录固定为当前隔离工作树；不修改其它工作树、真实 Web 服务、官方数据库或私有状态，不发送真实模型任务，不部署/重启/推送。
- 使用已安装依赖；node_modules Junction 只读共享。所有诊断、临时 CODEX_HOME、构建与测试输出留在当前工作树。
- 历史归属已手动同步完成，不在实现、初始化或测试中再批量迁移会话；归属写入不改变 cwd。
- 保留无关文件和旧偏好；中文 commit message，最终将本需求 commit squash 为一个并在正文保留原消息。
- 不替换安全检查，不从浏览器接受任意绝对 cwd；原生项目、工作区身份分别处理。
- 基线测试失败须归因，不把环境/基线失败冒充本需求通过，也不通过跳过新增关键用例规避失败。

## Review Focus

- 全屏切换时长 Markdown 重排保持阅读锚点，popover/对话框/手机抽屉一次 Esc 只关闭一层。
- 原生项目读取不完整或跨客户端删除时，不创建重复项目，不立即加回手动删除项。
- 明确 null、字段缺失和未知项目 ID 分别处理；旧目录偏好迁移不能把历史目录身份当成官方项目身份。
- 创建已接受、历史未物化时不重复创建或发消息，不因空历史解除活动任务约束。
- 列表版本连续变化不发布过时结果、不污染失败缓存；归档/隐藏、搜索、分页仍正确。

---

### Task 1: 稳定的文件预览全屏外壳

**Files:**
- Create: `src/web/PreviewShell.tsx`。
- Modify: `src/web/GitPanel.tsx`、`src/web/GitHistory.tsx`、`src/web/PaneLayout.tsx`、`src/web/style.css`。
- Test: 新的 `tests/preview-fullscreen.browser.mjs`；复用 `tests/preview-performance.html` 与已有文件/面板浏览器 fixture；必要时增加浏览器 fixture，不复制生产渲染器。

**Interfaces:**
- Consumes: 当前预览 header、正文、导航和滚动持久化行为。
- Produces: `PreviewShell` 以稳定 children 包装 header/content，普通与全屏共用 DOM。局部 expanded 状态；支持父入口失效时关闭，不在业务状态中持久化 expanded。

- [x] Step 1: 先补可失败的浏览器用例：文件、工作区 diff、提交 diff 三处均有“全屏查看／收起”；验证桌面和 390px、内容节点身份、焦点恢复及 Esc 分层。
- [x] Step 2: 跑新用例证明 RED，记录命令和具体缺失行为。
- [x] Step 3: 同一个 dialog 普通状态参与布局，切换时先 close 再 showModal，处理内部 close 事件；对话框有名称、背景 inert，焦点恢复 preventScroll。PaneLayout 只让位于真正 :modal 对话框。
- [x] Step 4: 保留导航、模式、图片 URL、高亮任务、scroll 保存节流与 previewReady。Markdown 使用视口附近块锚点+偏移校正；忽略切换中间滚动。收起保持全屏里新的阅读位置。
- [x] Step 5: 20 次预热切换测节点身份和新增请求/高亮计数必须为 0，记录切换 p95 与长任务、文件规模/设备条件。覆盖失败/读取中、切文件/项目/标签/面板隐藏清理、小屏安全区。
- [x] Step 6: 跑相关浏览器回归与 `npm run build`，检查 diff，写报告并提交中文任务 commit。

### Task 2: 原生项目目录、自动注册及创建身份

**Files:**
- Create: `src/server/project-catalog.ts`（只承担原生目录缓存、映射和注册队列）。
- Modify: `src/codex/runtime.ts`、`src/codex/app-server.ts`、`src/server/metadata.ts`、`src/server/api.ts`；需要时调整 `src/server/app.ts` 的生命周期和 `src/projects.ts` 的扫描完成通知。
- Test: `tests/native-project-catalog.test.ts`、`tests/native-project-api.test.ts`；更新既有假 Codex fixture 和相关创建/API 测试。

**Interfaces:**
- Runtime 提供原生 project list/create 与 thread metadata project 更新，启用当前本机所需实验能力协商，保留其它错误和通知行为。原生读取包含所有页且有时间/页数边界、重复 cursor 校验。
- `GET /api/project-catalog` 响应：`{state:'ready'|'loading'|'unavailable',updatedAt:number|null,projects:CatalogProject[],workspaces:CatalogWorkspace[],error?:string}`。
- `CatalogProject={id:string,name:string,roots:Array<{path:string,workspaceId:string|null,available:boolean}>}`，roots 保持原生顺序。
- `CatalogWorkspace={workspaceId:string,nativeProjectId:string|null,status:'syncing'|'synced'|'failed'|'removed'|'ambiguous',error?:string,matches?:string[]}`。
- `POST /api/project-catalog/:workspaceId/retry` 显式重试/重新添加；客户端只传安全工作区 ID。
- 新建请求保持现有 `projectId` 作为工作区 ID，新增可选 `nativeProjectId`。旧调用方只传工作区时自动解析原生映射；多匹配返回明确冲突，注册失败必须在模型任务之前返回错误。
- `POST /api/sessions/:threadId/project` body `{nativeProjectId:string|null}`，null 翻译为原生空字符串移出，现有项目 ID 移入；成功返回核对后的归属，不改 cwd。验证线程可操作范围和项目存在，不绕过占用检查。
- 原生项目变化通过既有 SSE/共享状态发布目录失效；会话原生 projectId 贯穿 header/list/snapshot/fork 及通知。
- `POST /api/sessions/:threadId/cwd` body `{workspaceId:string}`，只允许当前原生项目最新 roots 中的安全工作区；复用活动/占用/权限检查并串行变更，调用原生 thread/settings/update 只改 cwd 后核对 cwd 与原生 projectId 不变。返回 `{cwd,workspaceId,nativeProjectId}`，失效目录相关元数据/列表，供客户端重读上下文。当前并无会话 cwd API，这一后端支持归 Task 2，Task 3 只接界面。

- [x] Step 1: 添加 RED：同根不同名复用；同名不同根不合并；Windows 扩展/UNC/大小写规范化；多根顺序；重复扫描/响应丢失用同幂等键；不完整 list 零创建；官方删除停止自动重建；两个同根项目歧义；外部 root 不可用于 Web cwd。
- [x] Step 2: 实现现有 metadata DB 中按原生数据目录+工作区隔离的映射、创建幂等键与 suppression，不另存 names/roots 的权威注册表，不覆盖历史 session_meta。
- [x] Step 3: 初始化、显式刷新、创建/clone 后触发扫描同步，最多 2 项原生注册并发，合并在途；GET 仅读快照。完整目录失败保留标记为旧的快照，不猜“缺失”创建项目。
- [x] Step 4: 接入上述契约、创建时传原生 projectId、设置/元数据通知。已被手动删除的官方项目不自动重建，retry 才恢复；目录消失或改名不删除原生对象。
- [x] Step 5: 加 API 用例：新会话项目与 cwd 同时正确；无项目创建；旧客户端；项目操作不改 cwd；root 越界/项目不存在/另一客户端冲突失败；创建部分失败保留文件、原生项目和幂等信息。
- [x] Step 6: 跑 focused Node 测试、类型/构建及 diff 检查，报告实际接口/限制并提交中文任务 commit。不得对真实官方数据运行自动注册验收。

### Task 3: 两端项目选择与会话分组

**Files:**
- Modify: `src/web/main.tsx`、`src/web/sessionGroups.ts`、`src/web/preferences.ts`、`src/web/SessionView.tsx`；相应 `src/web/style.css` 与必要的项目选择/会话菜单小组件。
- Test: `tests/session-project-groups.test.ts`、`tests/preferences.test.ts`、现有项目分组浏览器用例和 fixture；增加原生目录/移入交互场景。

**Interfaces:**
- Consumes Task 2 的目录契约、workspaceId/nativeProjectId 分离、SSE 目录失效及会话 projectId。
- Grouping 使用 `'project'|'directory'|'flat'`。旧保存 project 实为目录分组，版本化迁移为 directory；全新默认 project。折叠 key 按视图与原生 ID 隔离。
- 原生项目按 ID+name 分组；明确 projectId null 为无项目；缺字段、未知 ID 或目录读取失败独立待确认，不冒充无项目或回退 cwd。目录视图沿用旧行为。

- [x] Step 1: RED：同名官方项目不同 ID 不串组；“502”cwd 但 native projectId=codex_web 时项目视图归 codex_web、目录视图仍 502；null 与缺失字段不同；旧分组/折叠偏好迁移；搜索与更多不额外扫描全历史。
- [x] Step 2: 用 Map 一次匹配目录和已加载会话；保留当前组内三条、搜索、排序、收藏、隐藏、归档、更多和折叠行为。
- [x] Step 3: 合并项目选择器，展示同步中/失败/已移除与重试，多匹配要求选择。原生项目的主 root 默认选择，额外 root 可选；未开放 root 可展示而不可执行。
- [x] Step 4: 会话菜单接入移入/移出，成功以后按原生结果重读归属；展示“项目／当前工作目录”的差异。独立切换 cwd 复用现有设置/活动检查，只允许项目内安全根目录，活动或占用时不修改。
- [x] Step 5: 浏览器桌面/390px 验证选择、移入、目录差异、三种视图及旧偏好；API 失败不乐观确认；不新建测试模型任务。
- [x] Step 6: focused 单测/浏览器回归、build/diff，更新报告并提交中文任务 commit。

### Task 4: 新任务交接、首轮历史恢复与列表变更收敛

**Files:**
- Modify: `src/codex/runtime.ts`、`src/codex/app-server.ts`、`src/server/api.ts`、`src/server/shared-client-state.ts`、`src/web/main.tsx`、`src/web/SessionView.tsx`、`src/web/drafts.ts`；需要时调整既有 `src/web/sessionSync.ts`。
- Test: 既有 runtime/共享状态/提交幂等用例，新增 `tests/new-task-history.test.ts`、`tests/new-task-startup.browser.mjs` 及 fixture。

**Interfaces:**
- 创建响应新增 `initialSnapshot`，复用当前 snapshot 的 browser 形状，包含服务端确认的 thread/turn 状态、权限、epoch/revision/syncCursor；新增 `historyPending:boolean` 明确未完成持久历史核对。
- 初始显示仅用于相同 thread/epoch；前端沿用既有占用检查和消息去重，再连接既有 SSE，后台读取历史。显示“任务已启动 · 同步中”及“已发送，正在同步”。
- 列表响应对版本持续变化使用 `{pending:true}`（不是成功空 data）。客户端保留原列表，初次无数据则占位；安排共享后续刷新。已有真实读取失败的 stale/error 契约保持。

- [x] Step 1: 先调查/验证当前原生具体未物化错误。可以在当前工作树独立临时 CODEX_HOME 创建空测试线程并读取（不 turn/start、不复制真实凭证），或用已有明确错误契约；禁止只按 -32601/-32603 泛化为可重试。记录无法证明的原始错误，不伪造现场消息。
- [x] Step 2: RED：线程和首轮接受后 5—10 秒历史未就绪；连续线程→metadata→两次 name 失效；真实 native 退出/不支持、部分创建成功、结果未知；切会话与 epoch 变化取消。首条仅发送一次，不解除活动约束。
- [x] Step 3: 构造无额外完整历史 RPC 的 initialSnapshot；交接 draft/outgoing 和 cursor，不让首次历史读取失败阻止实时消息。已确认活动轮次不能被空历史覆盖；保留当前 revision/activityRevision 和消息 ID 去重。
- [x] Step 4: 对新建、同 epoch 且已核实的历史未就绪进行只读恢复，间隔 200ms/500ms/1s/2s/4s，总预算最多 15 秒，共用一个读取。就绪/失效/卸载取消，预算耗尽保留显示+重新同步；不重发模型任务。
- [x] Step 5: 共享列表保持 30 秒有界读取和版本校验，版本冲突返回 pending 而非 503/60 秒错误缓存，合并安排后续读取。去重本地命名与同一原生 name 通知；真实失败仍报错，隐藏/归档/搜索/排序/分页不使用别的查询缓存。
- [x] Step 6: 脱敏诊断记录原生错误类别、method/threadId、原始码，不能输出用户内容/凭证；UI 区分就绪、能力、占用、结果未知和真实运行时故障。
- [x] Step 7: focused Node 与浏览器测试、全 Node suite、build/diff；更新三份设计的实施/验收事实，提交中文任务 commit。

## Finish

- [x] 主会话独立检查关键行为与测试证据；每任务鲜上下文审查，发现交由原实施 agent 修复。
- [x] 全分支独立审查，集成回归覆盖全屏性能、项目身份、首轮与列表收敛。
- [x] 将本需求提交 squash 为一个中文 commit，正文保留原 commit messages；保留无关文档和原分支工作树。
- [x] 提供可审查最终结果，明确尚未部署/重启的边界。服务运行验收与实际官方 App UI 不能用 fixture 成功替代。

## Whole-branch fix wave 验证状态

- [x] 三项Important可信RED后最小修复：externalcwd撤销旧身份/权限与UI上下文、shared exact-deadline清周期、startup absolute deadline保留与显式manual桥。
- [x] focused166/166、cwd和预算browser组合、同最终产品代码TypeScript/build通过；失败原日志和fixture归因保留于持久报告。
- [x] 唯一whole scoped re-review与主会话最终冻结树全Node suite；此前full #2不作为本波代码全套结果。Finish门槛仍由主会话完成，未部署。

### Whole scoped残余ordering

- [x] finding2 expired-active→passive→manual保留截止身份，可信RED1/1失败→GREEN1/1与shared50/50、tsc/diff通过。
- [x] 原reviewer仅核本ordering/tinyfixCLEAN；最终frozen full已通过，integration仍待root安排。上一166/166与旧full #2不是此最终树全套结果。

### 最终冻结全套

全部Task1..4及whole-branch/scoped review已CLEAN，所有原Important已处理，无新breakage/OutOfScope。最终冻结HEAD `91ebe81f88f7cb84043bdc59caa9d24a7ebe1d2f` / tree `dcdb411b3c119171f12cd3cb9ddec27eb8832179` 完整Node **714 total /709 pass /0 fail /0 cancelled /5 skipped，439191.3749ms，EXIT_CODE=0**。日志 `wholefix-node-final-frozen.log`，这是第三轮完整suite、此最终产品树首次完整复验；没有把先前full #2当成最终代码证据。产品未部署、重启或推送；feature本地squash已实际完成，保留12个原完整提交消息；main FF真实结果以后续主目录integration-result.json为准。

仅docs-only验收收尾；Finish squash/可审查结果项在实际feature squash及整树等价验证完成后勾选；main FF结果不提前声明，见主目录integration-result.json。

### Actual feature squash Finish stamp

实际feature squash已完成：12个原完整%B按顺序保留，base上恰1个中文commit；stamp之前pre/post整树均833feff7604f2e390030f9d70bde9e2db2ddc889。随后仅docs Finish/报告事实amend该singlecommit，产品/tests/scripts/package均同最终QA冻结。此刻尚未执行main FF；真实执行后的HEAD/tree/status/部署hash在主目录integration-result.json记录，未部署/重启/push。
