# 文件全屏、官方项目融合与新任务恢复验收记录

日期：2026-10-11。三个设计已获用户明确授权，在隔离分支 feat/preview-project-recovery 实施。全部Task1..4及whole-branch/scoped review已CLEAN，所有原Important已处理，无新breakage/OutOfScope。最终冻结HEAD `91ebe81f88f7cb84043bdc59caa9d24a7ebe1d2f` / tree `dcdb411b3c119171f12cd3cb9ddec27eb8832179` 完整Node **714 total /709 pass /0 fail /0 cancelled /5 skipped，439191.3749ms，EXIT_CODE=0**。日志 `wholefix-node-final-frozen.log`，这是第三轮完整suite、此最终产品树首次完整复验；没有把先前full #2当成最终代码证据。产品未部署、重启或推送；feature本地squash已实际完成，保留12个原完整提交消息；main FF真实结果以后续主目录integration-result.json为准。

## 实施与验证

| 任务 | 实际结果与证据 |
| --- | --- |
| Task1 | 稳定原生 dialog 全屏外壳，文件、工作区与提交差异共用同一正文；桌面1280/手机模拟390浏览器通过，普通菜单/全屏/抽屉 Esc 层级经 RED/GREEN 修复后 clean。最终每尺寸40次预热切换 p95=33.7/33.5ms，节点/请求/Worker任务/图片请求/长任务增量0。完整原始报告见附录。 |
| Task2 | 原生 catalog/自动注册/幂等映射、创建 projectId、membership 与独立 cwd API。原 focused24/24、影响113/113、增量159/159是重叠集合，不累加。review 两轮修复：首轮41/41、open/send权限17/17、映射guard2/2；第二轮 cwd-resume17/17、影响14/14，fresh身份与home/epoch fence保留。临时原生 home 验证不发送模型 turn。 |
| Task3 | 官方项目/目录/列表视图、偏好迁移、选择器与会话菜单、独立 cwd UI。focused12/12、三个 browser suite exit0；非空草稿锁与两个30秒POST挂起 RED/GREEN 验证显式open+snapshot后恢复，zero messages/turn。Task3 scoped fix clean。 |
| Task4 | 创建响应复用 flattened initialSnapshot 与已确认 thread/turn/permissions/epoch/cursor；SSE早接入并与历史按已有ID/revision去重。只对新建同epoch精确未物化错误做 coalesced 只读恢复，15秒绝对截止传到每次 native timeoutMs；列表连续版本冲突返回 pending，保留同query内容/首屏占位，共享有界后续读取。名称通知/ack去重，诊断只保留 method/threadId/numeric code/class。 |

Task4 可信 RED：task4-history-red.log 4/4失败、task4-list-red.log 2/2失败、task4-browser-red-corrected.log 缺少即时accepted显示、task4-name-diagnostic-red.log 2/2失败。第一轮 focused 最终 task4-focused-final.log 76/76通过，含确认首轮 ACTIVE 后同epoch空history仍 RUNNING/first、无 expectedTurnId 直接 send 返回409且 starts仍1。

后续 named-risk 覆盖：task4-budget-resync-red.log 预算后resync产生第二次GET，GREEN task4-budget-resync-green.log exit0 验证自动停止、手动同步重新GET并清pending。空线程精确新错误分类兼容轻量status的 task4-empty-status-red/green.log 为0/1→1/1。最终 browser 包含5.2秒延迟、初始SSE实时项、历史/outgoing去重、one create/zero resend、unsupported/真实runtime错误/预算/epoch/nav/external/partial/unknown、same-query pending、新query占位隔离、hide排除与showHidden保留更新；1280/390无横溢出，截图已查看。

HTTP取消沿既有 reply.raw close 且 !writableEnded 转 AbortSignal，再传 snapshot/history/runtime waiter。既有API集成真实HTTP disconnect两路均执行，正常完成过滤保留。全部等待者离开或epoch取消忽略迟到历史；浏览器取消不能撤回已经发送的native只读RPC，其原request剩余寿命仍受15秒absolute deadline限制。contextUnknown只有authoritative open/resume完整cwd/project/权限核对解除，初始snapshot不解除该防护。

首次完整复验中两个产品回归修复后的当时冻结代码 build（含web/vite tsconfig TypeScript）exit0，task4-build-post-regression-final.log；2784 modules、927ms，既有 >500k chunk warning，没有为此新增依赖或改bundle。git diff --check exit0，task4-diff-post-regression-final.log，仅既有LF→CRLF提示。

## 最终全套与失败归因

首次产品冻结后运行 sandbox-external `node --test --test-concurrency=1 --test-timeout=240000 tests/*.test.ts`。原始完整日志 task4-node-final.log；真实结果为704 total /677 pass /22 fail /0 cancelled /5 skipped，327524.2738ms、exit1；不声称该次全绿。两个实际核心回归修复后，主会话明确裁定再次完整验证必要，规范化TEMP/TMP后修复前第二次全套 task4-node-final-corrected.log：**704 total /699 pass /0 fail /0 cancelled /5 skipped，325153.0394ms，EXIT_CODE=0**。tested tree 为 BASE23ec3c9858175f6d3c7c94406898b947fd1cbb2c 加当前Task4源/测试diff；该次结果对应Task4初次提交6c1a96d，当时冻结后仅更新文档与提交；其后独立review fix round1再修改产品代码，因此不能把699项通过写成当前修复树全套成功。5个原平台/协议skip保留，不新增skip。该阶段待最终冻结树全套；现已由下方 final frozen 验收完成。

已定位：API综合例的 finally `dirname(dir)===tmpdir()` 因TEMP含斜杠文本不同而失败，产品+HTTP取消断言已执行；保持产品/测试不变，Resolve-Path规范TEMP后该例1/1通过（task4-api-failure-attribution.log / task4-api-normalized-temp-green.log）。四个fork partial旧assert只期望{phase:IDLE}，新增open epoch后精确比较失败；更新为同时检查真实runtime epoch，四例权限恢复/send完整4/4通过（task4-fork-attribution.log / task4-fork-epoch-contract-green.log）。其余失败逐项处理如下；不按路径泛归因。

| 原失败归因 | 修正与实际定向结果 |
| --- | --- |
| 另外6项finally路径比较（filepreview3/projects2/setup1） | 产品与断言不变，规范TEMP后6/6通过，task4-path-failures-green.log。 |
| 两项Task2 create返回cwd缺失/偏离请求的旧fixture | 原测试期望创建成功与新首轮前验证冲突；改为精确错误+partialID、native file binding保持、zero turn，两项通过。 |
| 两项unmaterialized-current原fixture使用未验证-32000且首轮后仍抛错误 | 改准确-32600并仅无firstturn时未物化；empty fallback与首次send后status分别通过。 |
| 一项metadata-delayed读取 | 新deadline传timeoutMs使旧call精确empty-rollout50/100/200/400ms重试被门控跳过，实际产品回归；恢复既有精确只读重试，delay/RPC均核remaining absolute deadline，不泛-32603；原accepted first/start=1例通过。 |
| 三项name/thread/resync hard后真实failure返回旧data | 实际产品回归；恢复hard清server cache，客户端pending独立保留samequery pages。原三个安全assert不改，全部通过。 |
| 一项连续version-conflict旧503/negativecache预期 | 按新pending合同验证不发布obsolete/不进入negativecache，原metadata/archive真实failure防护继续通过。 |
| diagnostics与plugin auth全局native idle旧预期 | 已授权服务初始化自动扫描/注册允许独立bootstrap initialize/project/list，绝无thread/start或turn/start。主会话裁定保留onReady。diagnostics等settled sample后验证请求不加启动/RPC/模型turn；plugin等bootstrap具体method后，未授权及invalid请求必须与基准精确相同、authorized仅加plugin/installed并保持project scope/secret过滤。全部通过。 |

新合同小集 task4-full-failures-contract-green.log 初次13项11pass2fail（pluginfixture错误等待401无Host、emptyfixture首轮后仍报未物化），保留原输出；修正fixture后task4-bootstrap-empty-fixture-green.log 2/2通过。diagnostics1/1、cwd2/2、metadata1/1、hard/pending安全7/7已通过。两处核心修复后的完整受影响 runtime/shared 集57/57通过（task4-runtime-shared-regression-final.log），fake API browser最终exit0（task4-browser-post-regression-final.log）。不把这些重叠小集累加成新full-suite分母。

原始受限基线为632 total /624 pass /2 fail /1 cancelled /5 skipped（并发与90秒预算），不是全绿；Git process count 与 Windows hidden-host 两例单独2/2通过，heavyhistory1/1通过110936ms。最终顺序结果与这三项定向证据分别报告。4个baseline helper PID仍在（31388/23316、10692/12740），Windows拒绝精确停止；未扩大终止或触碰服务。

## 原生证据与发布边界

独立空CODEX_HOME / CLI0.160.1：new-task-empty-read-1791699064132/result.json，header read成功，turns/list -32600准确threadId/message未物化，full read -32601准确unsupported，close无warning/exit0。仅空thread/start，无首轮模型turn；不证明事故未记录message/data的-32603内部原因。事故原现场证据缺口保留，不泛重试-32603、退出或所有-32601。

Task2 native-project-smoke-1791696400538/result.json 验证catalog/create/幂等/start/settings；空线程metadata no rollout found，首次settings物化projectId=null的限制保留，产品fresh identity防护不删。早期独立probe shutdown超过5000ms、owned-child关闭warning和exit1，finally先close导致结果未保留；随后先保存结果再捕获warning，最新probe exit0无warning。没有批量杀进程。真实持久membership/cwd切换和官方App实时UI仍未验收。

历史46/46真实持久会话归属已由主会话此前独立验证，主目录 .local/project-history-sync-20261011/independent-verification.json；本次实现没有再迁移，不计入fakebrowser/native空probe成功分母。

主服务只读前检 PID31544 为node非watch；主dist/index.html SHA256为1825ca3c05c28c2c21aabb3a06a89e890317e4cbc8ece07e09f7492482310c1f。未登录主页HTTP403，不等于served-byte/authenticated UI通过。未改部署资产。未验收真实手机、Safari/Firefox、真实模型首轮、官方App与Web整体双端UI。

## Ledger rulings与证据归档

主会话设计计划先完成，实施使用gpt-6.1-sol medium顺序子agent，无新增实施授权询问。仓库内ignored worktree隔离保留原工作树；Git Bash脚本缺basename/Windows绝对路径mkdir循环停止后，使用本机Python仅生成等价brief/review artifacts。Task3无现有session settings API，经graph核对后在Task2增加最小server-owned cwd API；只能选择已授权原生项目root，保留activity/ownership/identity保护。Task4复用现有读取job与native timeoutMs传播remaining15秒，不新建队列或改变旧线程预算。错误裁定的代价都是reviewable实现/fixture重工，无额外模型写操作。最终suite出现真实runtime/shared回归后，主会话裁定原“一次全套”原则只适用于无新产品问题，修复核心回归必须再次完整验证；不以环境归因替代真实full GREEN。

原始证据来自 C:/Users/Developer/work/codex_web/.worktrees/preview-project-recovery/.local/qa-temp 及 .superpowers/sdd/2026-10-11-preview-project-recovery。主会话归档到主目录 .local/preview-project-recovery-20261011/worktree-evidence/，其下保留原.local/qa-temp和.superpowers/sdd相对结构；83项Task1/2/3是历史interim批次，不能视为最终总数。最终归档事实以主目录 `.local/preview-project-recovery-20261011/evidence-manifest-final.json` 为准，由root最后生成和核验（本docs提交时尚未生成）；现有interim/reviewed-tasks/task4 manifests保留历史。只选日志/JSON/截图，不复制临时CODEX_HOME/凭证/node_modules。工作树原始路径不冒充主目录已归档文件。

## 附录：Task1完整报告（移自临时tracked SDD）

# Task 1 实施报告：稳定文件预览全屏外壳

状态：DONE。未部署、重启、推送或访问真实官方数据。

## 实施范围与自审

- 新增 `src/web/PreviewShell.tsx`，同一个原生 dialog 普通状态使用 show()，展开时 close() 后 showModal()；React children、内容 DOM、图片 URL 和业务请求依赖保持原位。expanded 仅为外壳本地状态。
- 文件、工作区 diff、提交 diff 接入同一外壳。工作区并排/统一按钮移入预览标题栏，使全屏内可用；既有手机隐藏并排切换行为保留。
- 弹窗命名、全屏/收起 aria-label 和 aria-expanded、44px 按钮、preventScroll 焦点恢复、Tab 首尾限制、popover/Esc/手机抽屉分层落实。PaneLayout 只对 dialog:modal 让位。
- Markdown 只在视口前 128px 内最多 6 个点查找现有块；记录块相对视口偏移，在布局完成后校正。居中正文从正文左缘采样；不扫描全篇或在滚动时增加 React 状态。源码/diff 保留双轴滚动。中间滚动在 capture 阶段阻断，校正完成发出正常 scroll，让现有 previewReady 与节流保存最终位置。
- 会话/项目/标签变化、visible=false、预览退出和卸载清理 modal。文件导航及模式切换保持 modal。普通 dialog 显式 height:100%，避免原生 fit-content 撑破现有 grid；手机 popover 固定左右边距避免新标题布局将最近文件菜单挤出视口。
- 未添加依赖，未修改内容渲染器、缓存结构、服务端 API、存储 schema 或设计文档草案状态。

## RED / GREEN

新增 `tests/preview-fullscreen.browser.mjs` 与仅调用生产 GitPanel/PaneLayout 的 `tests/preview-fullscreen.html`。

受影响基线（实施接入前）：`node tests/preview-fullscreen.browser.mjs --baseline` 在 1280/390 下运行 file-browser、workspace-panels、panel-collapse、preview-performance，全部 PASS。

RED：`node tests/preview-fullscreen.browser.mjs`，两尺寸均因 `全屏查看` 按钮等待 3000ms 超时退出 1，证实现有入口缺失。报告保留具体失败，而非把空 fixture 当通过。

GREEN 最终：同一命令退出 0，两尺寸覆盖三个入口、同一内容节点、Markdown 锚点展开与全屏新阅读位置收起、localStorage 最终位置、原生 modal/focus、Tab、最近文件 Esc 层级、手机抽屉 Esc 层级、文件链接/后退/阅读模式保持全屏、源码双轴位置及 Worker 任务不增加、图片节点/请求、读取中与 404、会话/项目更换、隐藏清理与手机横屏工具栏。

强化用例曾暴露并修正普通 dialog 高度与 Markdown 左侧空白采样问题。Tab 边界也验证并显式循环，防止浏览器焦点进入浏览器工具栏后 activeElement 回到 body。

最终受影响既有基线：`node tests/preview-fullscreen.browser.mjs --baseline` 两尺寸四 fixture 全 PASS；`.local/qa-temp/fullscreen-baseline.json`。复测期间有一次 desktop file-browser 的原有 3s “Markdown 链接未加载”超时，也有 mobile 最近菜单溢出断言失败（后者修复后通过）；未修改原测试等待时限，最终顺序复测通过。

## 性能实测

最终 `.local/qa-temp/fullscreen-results.json`：Windows 本机、Intel64 Family 6 Model 151 Stepping 2 / 20 逻辑处理器（环境变量证据，CIM CPU 型号读取拒绝访问），Node v26.11.1，HeadlessChrome 155.0.0.0，Vite 开发构建，无 CPU 节流。120 节长 Markdown（120 标题/段落/相对链接）；另测 400 行宽源码和 600 行 diff。先等内容加载、完成一次展开/收起，首次读取不计入切换。每尺寸采样 40 次操作（20 次展开/收起往返），每次计时含两次 requestAnimationFrame，按 ceil(40*0.95) 排序项计算 p95。

| 视口 | p95 | 采样区间长任务 | 正文 added/removed 节点 | 新 fetch | 新 Worker | 新 Worker postMessage 任务 | 图片切换请求 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280×900 | 33.6ms | 0 | 0 | 0 | 0 | 0 | 0 |
| 390×900 | 33.6ms | 0 | 0 | 0 | 0 | 0 | 0 |

DOM 身份保持 true。源码测量先确认真实 Worker 创建及 postMessage 任务均 >0，再检查展开/收起差值为 0；源码 scrollTop/scrollLeft 精确恢复。Markdown 无独立解析任务计数接口，正文节点零变化与同一 children 身份是间接证据，未声称使用解析器内部计数器。

中间一轮并行运行曾记录 desktop p95 33.7ms / longTasks=1，mobile 33.5ms / longTasks=0；未证明该长任务来源，不能将这轮描述为零长任务。最终完整顺序采样为上表值，其他本机测试负载仍可能影响测量；结果属于本机桌面浏览器模拟，不能外推真实低端手机性能。

实际全屏截图已生成并查看：`.local/qa-temp/fullscreen-1280.png`、`.local/qa-temp/fullscreen-390.png`。手机标题/导航/模式与44px收起按钮可见；桌面正文960px居中。截图也已交主会话查看。

## 验证命令和结果

各命令均在本工作树设置 TEMP/TMP=`.local/qa-temp`。缓存、构建、截图、日志未离开工作树；node_modules Junction 只读使用。

- `node tests/preview-fullscreen.browser.mjs`：最终退出 0，两尺寸全 PASS。
- `node tests/preview-fullscreen.browser.mjs --baseline`：最终退出 0，两尺寸四 fixture PASS。
- `node tests/source-preview.browser.mjs`：退出 0，两尺寸原始字节/语言/边界/锚点/缓存/迟到回调/Markdown 全 PASS；`.local/qa-temp/fullscreen-source-regression.log`。
- `node tests/image-view.browser.mjs`：退出 0，两尺寸 PASS（collapsed loading、preview、paths、boundaries、missing file、reopen）。
- `node tests/git-history.browser.mjs`：退出 0，两尺寸 Git repositories、repository reload、git-history、workspace-panels/fetch/images PASS；`.local/qa-temp/fullscreen-history-regression.log`。
- `npm run build`：最终退出 0，TypeScript 与 Vite 构建通过；`.local/qa-temp/fullscreen-build.log`。只有既有大于500kB chunk 提示，未新增警告类别。
- `git diff --check`：通过。Node 全套由控制器负责，本 agent 未重复执行。

## 文件清单

`src/web/PreviewShell.tsx`、`src/web/GitPanel.tsx`、`src/web/GitHistory.tsx`、`src/web/PaneLayout.tsx`、`src/web/style.css`、`tests/preview-fullscreen.html`、`tests/preview-fullscreen.browser.mjs`、本报告。

未检查真实手机硬件、Safari/Firefox 或真实服务；原生 dialog/popover 与 CSS anchor 的跨浏览器表现仍需发布前对应设备验收。未增加动画、快捷键、设置或新窗口。

## Fix round 1：普通抽屉最近文件菜单的 Esc 层级

审查基线 Head：`5bd3295e537ada420ce0f7f7986b725e79bea2fc`。两条 Important 指向同一个行为与缺测：普通非模态 PreviewShell 在处理菜单前提前返回，PaneLayout 的 window keydown 会关闭抽屉，第一次 Esc 同时清掉菜单和抽屉。

先增加真实生产 PaneLayout/GitPanel 的390px浏览器回归，未改旧 fixture 或等待时限：普通预览打开最近文件菜单后，第一下关闭菜单且保留抽屉，第二下关闭抽屉；另保留并强化全屏菜单/全屏/抽屉三次 Esc 各关闭一层。

- RED：设置 TEMP/TMP=`.local/qa-temp` 后运行 `node tests/preview-fullscreen.browser.mjs *> .local/qa-temp/fullscreen-fix1-red.log`，退出1。桌面原回归通过；手机具体输出 `ordinary preview: first Esc closes only recent menu / 0 !== 1`，抽屉实际已关闭。
- 根因修复：仅在共享 `PreviewShell.tsx` 把菜单 Escape preventDefault/stopPropagation/hidePopover 放在 modal 判断之前；Tab 限制仍仅用于 modal，未扩大 PaneLayout 的键盘 guard，未改变全屏关闭或业务状态。
- GREEN：同命令写入 `.local/qa-temp/fullscreen-fix1-green.log`，退出0。1280/390完整回归及新增普通两层、modal三层均通过；p95分别33.7/33.5ms，新增正文节点、请求、Worker、postMessage任务、图片请求及长任务均0，身份保持true。
- `node node_modules/typescript/bin/tsc --noEmit` 与 `git diff --check`：退出0。Git仅提示既有LF将转CRLF，无空白错误。本轮未重复Node全套、构建或全部图片/Git专项回归。

自审：菜单处理从更具体的子树出发，React键盘事件在window抽屉监听前阻断；没有菜单时普通dialog继续让PaneLayout处理第二次Esc，全屏仍由原生cancel处理。只改 `PreviewShell.tsx`、`preview-fullscreen.browser.mjs` 与本报告。跨浏览器/真实手机硬件的原验收边界保持不变。

## Task4独立审查修复 round1

FIX_BASE：6c1a96d9d12562858d73fb871afd381b185877c2。Important3项均由真实状态迁移RED复现，task4-fix1-red.log：3 total /0 pass /3 fail /exit1。pending→forced followup真实failure后普通GET仍pending；30秒followup耗尽后manual继承1ms旧deadline；首读14900ms精确未物化进入200ms退避，15秒中止返回ABORT_ERR而非正确public code。

最小修复：shared job terminal catch清pending/followupDeadline/dirty，真实failure继续既有error/stale负缓存，不自动重新开启已耗尽周期；新显式恢复得到新的有界读取。活动周期的普通pending读与仍pending的forced followup保持同一deadline，不通过重复请求延长30秒。runtime只在wait取消时抛controller.signal.reason，精确恢复错误与epoch/普通取消原因保持，不重发任何写操作或泛化数字错误。

定向3/3 GREEN（task4-fix1-green.log）；增强周期deadline断言后受影响runtime/shared/cancel全集60/60、10568.4175ms、exit0（task4-fix1-affected-green.log）。既有fake API浏览器预算停止/resync不自动重读/手动ready恢复及query/hide组合exit0（task4-fix1-browser-green.log）。当前fix代码build含web/vite tsconfig TypeScript exit0、2784modules、874ms，既有>500k warning（task4-fix1-build.log）；diff检查另存task4-fix1-diff.log。

本轮未重跑完整suite。上述full #2 704/699/0fail/5skip只证明修复前当时的6c1a96d代码；当前fix tree最终全套与独立re-review由主会话负责。无真实home/DB/模型turn、部署、重启、push；Task2身份、权限、activity及hard真实failure安全断言全部保留。

## Whole-branch final fix wave（FIX_BASE bffc893）

三条 Important 一起修复，尚待唯一 scoped re-review 与主会话最终冻结树完整 suite。本波没有完整 suite；此前 full #2 的704 total /699 pass /0 fail /5 skip只属于6c1a96d当时代码，不代表本波最终代码。

1. 官方 `thread/settings/updated` 的有效 canonical cwd 变化撤销 loaded/permissions 并保持 contextUnknown；普通 snapshot/status/SSE 不能重新授权，只允许既有 authoritative open/resume 验证当前 cwd/project/新权限。Windows extended-prefix/case alias 不误失效，在途 Web pendingCwdIdentity 保留。UI cwd 真变化关闭旧预览、清除旧 workspace 上下文，再由既有 GET/projectForCwd 解析安全 workspace；外部共享范围之外明确没有文件/Git面板，membership-only 同 cwd 保持全屏与 DOM。
2. Shared pending 发布、job finally、新读取都核对 absolute deadline；边界 version conflict 仍返回 pending、终止旧 followupDeadline/dirty，不生成60秒negative failure cache。显式 manual 若旧句柄已过期则先终止旧job再新30秒预算，未到期活动周期仍合并，不续时。真实 failure/hard invalidation 原安全合同保留。
3. 新创建当前epoch的 initialHistory 保留15秒 absolute deadline，all-waiters-gone仍取消读取，但自动再读只使用剩余预算；manual 在活动周期内合并，到期（含 timer 未运行）才可新有界周期。新增只读 `snapshot(...,{restartHistory:true})` / `GET /api/sessions/:threadId?restartHistory=true` 桥；缺省false，schema只接受字符串true，false/1返回400；unknown字段由既有Fastify removeAdditional过滤。只有用户刷新/重新同步/重试按钮传true，SSE/status/reconnect/普通自动load与发送后回调均不传。未改变身份权限与任何turn写操作。

证据全部在工作树 `.local/qa-temp/`：
- `wholefix-red-verified.log`：可信Node 3 total /0 pass /3 fail（427.9484ms），三处分别证明cwd旧grant、all-reader取消后预算延长、exact deadline pending污染。早期 `wholefix-red.log` 不完整、自有挂起session已停止，不计通过。
- `wholefix-green-three.log`：3/3 GREEN。cwd恢复发送第一轮fixture错误要求新已核实权限也必须undefined，修正为只允许新readOnly grant；没有放宽旧dangerFullAccess撤销断言。
- `wholefix-browser-budget-red.log`：10s/12s resync使原实现未在原15秒窗口出现恢复按钮；`wholefix-browser-cwd-red-verified.log`：真实cwd不能关闭旧fullscreen。首轮cwd browser只因首屏fixture等待不充分失败，保留 `wholefix-browser-cwd-red.log`，不算根因RED。
- `wholefix-browser-{cwd,budget}-green.log`：各exit0。membership-only同cwd保留preview DOM/fullscreen；真实outside cwd清旧文件/Git上下文并保持发送锁/zero turn；首轮5.2s、SSE/消息去重/unknown/external/导航/epoch/unsupported/failure/query/hide原组合保持；新增耗尽前10s/12s resync保留单HTTP、总15秒截止、自动无restart参数、manual true后ready。仅1280/390 Chrome fixture，不是真App/手机/model验收。
- `wholefix-affected-green.log` 首轮166 /165 pass /1 fail /15069.2757ms；唯一新增shared fixture误用soft事件不推进version，改为实际hard name invalidation后 `wholefix-shared-extra-green.log` 1/1。最终 `wholefix-affected-final.log`：166 total /166 pass /0 fail /0 cancelled /0 skip /14400.4849ms、exit0，覆盖native project safety/API/catalog/cwd open/send permissions、runtime history/open/sync/budget/cancel、shared真实failure。新增 expired-active 句柄在timer未回调时manual恢复、before-deadline manual不延长、alias/在途身份、APItrue-only均通过。
- `wholefix-tsc.log` TypeScript exit0；相同最终产品代码 `wholefix-build.log` Vite exit0、982ms，既有>500k chunk warning保留。没有泛称测试环境日志无warning。

本波无真实home/privateDB/模型turn/部署/重启/push/历史再迁移；46条真实history membership是独立既有证据，不能与fake双端/fixture混算。真实App/Web双端UI、真model首轮、phone/Safari/Firefox与运行切换仍未检查。helper目录保留。原始日志最终主目录归档由root完成。

## Whole scoped 残余顺序修复（FIX_BASE ff55240）

唯一whole scoped review确认finding1/3 ADDRESSED，但finding2仍有 expired-active→passive→manual 顺序遗漏：passive提前清followupDeadline却保留job，manual无法识别过期并加入旧job。仅针对这一原finding修复，不展开新范围。

Root ruling：更高完成要求override一次wave cap，仅这一未解决原finding；终止旧job前不能丢失expired身份，passive不制造新预算，manual可新周期，未到期active仍join；truefailure/no-obsolete/hard合同保持。代价：共享恢复局部重验，最终integration继续阻塞直到此ordering scoped clean与最终frozen full，无远端/服务/私有状态效果。

增强既有真实行为测试：前两次hard name version conflict返回pending、第三次hang；只推进Date30秒而timer未运行，先passive（calls仍3），随后manual必须发第四次freshread且10ms ready；旧job迟到结果不能覆盖ready。`wholefix-ordering-red.log`：1 total/0 pass/1 fail/108.4145ms，实际calls3!==4。产品只改shared read入口一行：存在active job时不提前清expired deadline；manual中止旧job，既有catch/finally terminal清理后新有界读取，普通passive保持合并与无新增预算。

`wholefix-ordering-green.log`：1/1、123.9676ms、exit0。`wholefix-ordering-shared-final.log`：50 total/50 pass/0 fail/0 cancelled/0 skipped/1443.1395ms、exit0，包含shared真实失败/hard stale安全、版本冲突pending、截止边界与transport。`wholefix-ordering-tsc.log` TypeScript exit0，`wholefix-ordering-diff.log` diff exit0。日志前缀均工作树 `.local/qa-temp/`，保留测试环境原输出，不泛称无warning。

本轮只改server/测试/报告与plan，无frontend新改动，因此按裁定没有重复browser/build/full；上一166/166、browser/build属于ff55240当时树，旧full #2属于6c1a96d。当前树仍待原reviewer仅验证本ordering与tinyfix，随后主会话一次最终frozen full；没有squash/merge/push/nativehome/model/deploy/restart。

## 最终冻结验收与docs-only尾部

全部Task1..4及whole-branch/scoped review已CLEAN，所有原Important已处理，无新breakage/OutOfScope。最终冻结HEAD `91ebe81f88f7cb84043bdc59caa9d24a7ebe1d2f` / tree `dcdb411b3c119171f12cd3cb9ddec27eb8832179` 完整Node **714 total /709 pass /0 fail /0 cancelled /5 skipped，439191.3749ms，EXIT_CODE=0**。日志 `wholefix-node-final-frozen.log`，这是第三轮完整suite、此最终产品树首次完整复验；没有把先前full #2当成最终代码证据。产品未部署、重启或推送；feature本地squash已实际完成，保留12个原完整提交消息；main FF真实结果以后续主目录integration-result.json为准。

冻结源树完整标识：

- src：`768d7e1f5e86647a1462ebb01c718d3d23d1ef8e`
- tests：`dcbf6ba085d950700b8e87d703c063baaeae0cc1`
- scripts：`193811dc9da94032384b18d89de1bc7470bc491a`
- package.json：`af19b4a170d0722745b2d54c027d3cc3ea0e9680`

启动前tracked status为空，TEMP/TMP均canonical Resolve-Path到feature `.local/qa-temp`，suite独占顺序执行；冻结身份原日志 `wholefix-frozen-identity.log`。末尾Windows launcher/stop/read-only helper检查通过，没有执行生产服务脚本。5个skip保持既有平台/协议边界，没有新增skip来制造成功。此前ff55240的web源/browser/build与此最终web源完全相同，残余server一行修复经tsc/shared/scoped及此完整suite覆盖，无理由重复browser/build。Vite既有chunk warning与测试环境原日志保留。

此后仅允许3design/plan/durable验收文字与数字收尾，src/tests/scripts/package/config不变；docs-only git name list记录于 `wholefix-final-docs-range.log`。squash与main exact FF仍待实际完成，未提前勾选。integration-brief已读：仅reviewable相同整树本地squash（保留原messages）、main ff-only、备份同hash原design，不resetmain；不push/restart/deploy，不动部署资产与其它工作树改动。四个baseline helper及其fixture/worktree按root裁定保留，最终归档由root完成。

## 附录：progress全部Ruling原文与代价

以下逐条保存progress中所有包含Ruling的完整段落（包括句内Ruling和后续Cost原句），作为历史决策记录；早期pending/失败归因对应当时阶段，当前验收事实以上方最终冻结结果为准。

1. Ruling: User has approved the three designs and explicitly requested implementation; the plan only decomposes that scope, so no new design confirmation is required — cost if wrong: reviewable implementation rework.
Ruling: Create an isolated project-local worktree under the already ignored .worktrees directory as reversible setup within implementation authorization — cost if wrong: remove only this unused feature workspace, preserving main checkout.
Ruling: Git Bash lacks basename, so native Python creates the same plan-scoped workspace/brief artifacts after the prescribed script fails — cost if wrong: artifact layout mismatch, with no effect on product behavior.

2. Ruling: The prescribed Bash helpers also mis-handle Windows git absolute paths and enter a failed mkdir loop; their owned command was stopped. Use the already-created native Python artifacts for all briefs/review packages — cost if wrong: artifact naming only, no product data changes.
Baseline: original npm test stopped after no progress; rerunning with concurrency=4 and 90s test timeout, log .local/baseline-bounded.log.

3. Ruling: Task3 approved cwd-switch UI cannot reuse a nonexistent per-session settings API (graph verified registerCodexSettingsRoutes and native settings literal absence); add the minimal safe POST /api/sessions/:threadId/cwd backend in Task2, retain existing ownership/activity mechanisms, authoritative project roots, no arbitrary browser cwd or membership/model/permission change — cost if wrong: endpoint/fixture rework before deployment. Contracts and Task2/3 briefs updated; native method schema only so runtime verification still required.

4. Task4 dispatched new_task_recovery gpt6.1sol medium, BASE23ec3c985. Implementer identified strictnotmaterialized misclassified HISTORY_UNSUPPORTED andsecondsharedversionconflict cachedfailure60s. Ruling: newcreatedsameepoch readonlyrecovery uses onecoalescedjob and15sabsolute deadline propagated along existing loadThread/readTurnBodies/readItems native timeoutMs remaining; independentwaiterabort/allgone/epoch cancel withlatedataignored, nooldthreadbudgetchange/noqueue — costifwrong: newthreadhistoryreconciliation tests/rework, noadditionalmodelwrite.

5. Task4 finalwholeNode running14456/log task4-node-final.log. One api.test comprehensive test fails in finally387 dirname(dir) backslashes vs TEMP containing forwardslash. Allproductassertions including HTTPabort353-364 executedbeforefailure; attributionlog task4-api-failure-attribution.log. Ruling: canonical Resolve-Path TEMP/TMP targetedwholecase rerun afterfull completes, noproductvalidationchange/no skip/no repeatedfull absentnewconcerns. Report originalfullcounts andtargetedresult separately, neverclaim singlefullsuitegreen — costifwrong: namedcase failedcleanup andlocaltestfixture retention, independentlyverified API checks.

6. Task4 fullrun followup: canonicalTEMP api case1/1 PASS; fourfork open strictdeepEqual failsolelynew epoch field, assertions strengthenedphase+runtimeepoch, 4/4PASS; these small targetedcommandsran whilefull stillrunning, controller thenrequiredsequentialreruns to avoidbaselineGit/hostload noise. diagnostics realentry native_start1vs0 dueTask2 catalog.onReady bootstrap. Ruling: authorizedautomaticprojectregistration requires independentserviceboot Nativeinitialization/projectRPC, neverthread/turn/model; retainproductonReady andupdateoldtests tosettledbootstrap baseline + diagnosticsrequest noadditionalNative/userbusinessRPC/turn, authunauthorized noinstalledPluginsRPC. Do notdeleteauth/noTurn assertions orgeneralizeunknownfailures; installedpluginsfailure preciseattributionpending. Costifwrong: startup-boundary tests mustbe corrected beforeintegration, no addeduserturn.

7. Task4 fullrun completed704total677pass22fail0cancel5skip327524ms. Detailedgroupattribution required. Two genuineproductregressions: explicitstartup timeout disabledexisting Runtime.call exactthread/read rollout-race boundedreadretry; hardinvalidation serverdata retention violatedtruefailure stale/errorcontract in3existing name/thread/resync tests. Ruling: restorepreciseexistingreadonlyretry withinabsolute remainingdeadline (no generic-32603/no modelwrite retry), restorehardclearsserverdata (clientpending keepssamequeryoldpages), keeporiginal3securityassertions. Otherfixture/contract/environmentfailures verifiedonebyone. Sincecoreruntime/shared productfixes are newconcerns, requiredsecondfullsuite on finalfrozen code withcanonicalTEMP afterall22targetedGREEN; earlierno-repeat guidance didnotcovernew productregressions. Nevermerge withunresolvedtests/claim firstfullgreen. Costifwrong: retry/data safety regression, blockedintegration untilverified.

8. Task4 implementation DONE6c1a96d9d12562858d73fb871afd381b185877c2, tree d06953b806ee1acc0d5d96b77657cf8387506cb4. Full#2 704/699/0fail/0cancel/5skip325153ms and same-code build/tsc/browser PASS. Fresh new_task_review Needsfixes:0Critical3Important(pending hides terminal error, expired followup deadline contaminates manual recovery, startup backoff abort loses budget error code), three readonly focused reproductions; no broad rerun. Fixround1/5 originalimplementer BASE6c1a96d. No parkedfinding.
Ruling: final-full#2 predates these newly confirmed terminal/deadline product gaps; after scoped fix and wholebranch review, run one final whole Node suite on the final frozen product tree, not during each review turn. Targeted covering sets first; don't claim old full#2 as final-code verification. Costifwrong: untested cancellation/error recovery interaction, so integration remains gated on fixes and final checks.

9. Wholebranch review over2a94fe1..bffc893 Needsfixes:0Critical3Important(externalcwd stalegrant permits send; exactdeadline versionconflict pending; pre-exhaustion sameepoch SSE resync resets15s). Fullreadonlypackage+3focused in-memory probes, no realNative/turn/suite repeat. No parkedissues. Onefixwave originalnew_task_recovery getscomplete3list; finalfull helduntil scopedgate.
Ruling: persistent startup-cycle absolute deadline survives all-waiter cancellation; explicitmanual read reset may start a new15s cycle only after the active job ends, never auto/SSE. Add only a small existing snapshot read option/query bridge if needed, preserving identity/activity, and coalesce sameepoch pending resync. Costifwrong: API/read-cycle rework beforeintegration, no modelwrite orprivate-state migration.

10. Whole fix wave DONE ff55240f10728d560fd953b8211b174b7145de66 / tree4f029ef0aa70f0457fbd50e884b690212f0d5a2e. Root read credible3RED, affected166/166, cwd/budgetbrowserexit0, sameproducttsc/Vite982ms. Unique scoped whole reviewer dispatched overbffc893..ff55240, finalfull remains gated.
Ruling: Finishing skill menu and fresh merged-suite replay are overridden by developer instruction to complete already-authorized reversible local integration without repeat approval/checks; user explicitly requires Chinese squash with original messages. Integrate only exact tested product tree with documented docs-only tail, squash tree equivalence and main ff-only; no remote pull/push or service cutover. Cost if wrong: reversible local branch integration rework; unrelated changes and production assets preserved.
Ruling: Keep owned feature worktree and helper fixtures because four verified baseline helper processes cannot be stopped with exact PID due Windows permissions. Archive selected evidence, do not force-delete active resources or broaden process termination. Cost if wrong: extra ignored disk space/process retention, disclosed final limitation, no product or production data loss.

11. Whole scoped review ff55240: findings1/3 ADDRESSED, finding2 remainingImportant expired-active passive->manual clearsmarker thenjoinsoldjob. In-memory credibleprobe native0. No other scoped/OutOfScope issues; finalfull remains gated.
Ruling: SDD one whole-fix-wave cap cannot justify merging a confirmed unresolved original Important; higher-priority developer requires the intended goal fully handled. Authorize one minimal residual correction of finding2, its specific RED/GREEN and shared affected checks only, then targeted verification of this exact ordering (no renewed wholebranch review/suite repetition). Final frozen full remains one run after clean. Cost if wrong: shared recovery code rework, preserved true-failure/active-cycle contracts; no remote/service/private-state effects.

12. Final residual scoped review CLEAN91ebe81f88f7cb84043bdc59caa9d24a7ebe1d2f: finding2 ordering ADDRESSED,0new/OutOfScope; originalfindings1/3 stilladdressed. All tasks/whole gate clean. Finalfrozenfull authorized next; build/browser remain verified prior identicalwebsources, finalserver source getsfullsuite.
Ruling: Committed Finish squash status must follow actual feature squash, not pretend a future action happened. After initial feature squash and exact tree equality, permit only docs Finish stamps and same-commit amend preserving all original messages; recheck docs-only amendment/source equivalence, then main ff-only. Final ff SHA/tree facts stay external integration-result.json to avoid a circular commit hash. Cost if wrong: doc/commit-metadata correction only; no main reset or untested product code.

## Actual feature squash与本地集成记录边界

feature实际squash完成后才补Finish stamp；12个原完整%B按实施顺序保留，未重写/丢弃原message正文。pre-squash7395537与first squash fd7675610d9451f124ebb251709bee3aa521d5fc整树均833feff7604f2e390030f9d70bde9e2db2ddc889，base上恰1commit；证据主目录integration-squash-verified.json/original-commit-messages.json/squash-commit-message.txt。

本段stamp及三设计/plan仅docs amend，产品源树仍同final QA freeze。此刻尚未执行main FF，不能在提交正文提前声称合入成功；实际FF后的最终SHA/tree/状态、未部署资产/Oct9哈希、服务PID/StartTime检查由主目录 `.local/preview-project-recovery-20261011/integration-result.json` 持久记录，避免提交自哈希循环。不resetmain/不pull/push/部署/重启；原feature worktree及四个权限拒绝停止的baseline helper fixtures保留。
