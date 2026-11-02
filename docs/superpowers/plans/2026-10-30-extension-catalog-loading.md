# 插件目录按需加载与失败隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 在用户后续明确授权实施后，使用 superpowers:executing-plans 或 superpowers:subagent-driven-development 逐项执行。用户已明确授权实施；实际未验收范围保留未完成。

**Goal:** 已安装列表独立呈现，Apps 使用运行时库存，远端插件采用关键词分页；缓存和错误按来源隔离，保留原有管理安全检查。

**Architecture:** 复用 Runtime、Fastify 和现有插件页。拆出纯读取适配与 Runtime 内存缓存，保持现有配置/CLI 写操作；前端按 section 合并数据，不依赖远端完整目录完成首次呈现。Cloudflare 仅分类、脱敏、提示和重试，不嵌入挑战页或承诺验证恢复。

**Tech Stack:** TypeScript、Node、Fastify、React、现有 Node tests 与 Playwright；不新增依赖。

**Spec:** `docs/design/2026-10-28-extensions-and-rich-content.arch.md` 第 12 节；既有受管/CAS/未知写/技能与富内容边界仍适用。

**Status:** 代码与隔离验收完成；实际运行服务验收待重启。实现基线 `6b05921`（代码前态 `becb6ef`），用户同轮授权两份计划，在隔离 worktree 按模块实施；终态来源和验收仍分开记录。

## Global Constraints

- section 为 `installed|apps|mcp|marketplaces`；默认 installed。搜索为独立 `/api/codex/extensions/search`，只支持非空关键词和 global scope。
- Apps 优先 `app/installed` + `app/read`，ID 每批最多 100、最多并发两批；仅方法不支持回退 `app/list`，403 不回退。
- 搜索 trim 后 1—200 UTF-16 单位、200ms 防抖、原生 limit 50、每页最多 1,000 条、cursor 不透明且检测循环。
- 不新增默认全量 discovery CLI，不增大旧 CLI 2 MiB 上限，不调用私有 `/ps/*` HTTP，不默认调用开发中的 plugin/read/list/install/uninstall RPC。
- 内存 TTL：installed 30 秒、Apps 5 分钟、MCP 15 秒、marketplaces 30 秒、search 60 秒；失败退避 5 秒；32 个上下文、64 个搜索页、服务器旧成功数据最长保留 15 分钟。
- 缓存绑定 epoch/home/cwd/auth revision/config generation；MCP key 再区分基本状态与各目标详情。显式刷新绕 TTL/失败退避，写前检查不使用缓存充当权限证据。`usage-invalidated` 保守清理前端缓存，普通 usage 更新不清理。
- 不自动重登、修改代理、升级 CLI、重启/中止活动服务、调用业务工具或发送模型请求。危险 HTML、Cookie、token、完整异常和凭据不进入 UI/普通诊断。
- 读取反馈与 mutation busy 分离；保留安装身份、owner、策略、expectedVersion、impactVersion、未知写锁定及有限技能文件操作。
- 按 AGENTS 使用中文提交；需求完成收为一个提交，若存在中间提交则 squash 并保留其原始 message。不要重写本轮文档提交或无关历史。

## Review Focus

1. 同账号换 home/cwd、不同账号同 cwd、epoch 更换与迟到响应：旧结果不得回填，见 Task 2。
2. Apps 库存成功但部分元数据失败/missing：保留库存且不伪报已连接，见 Task 1。
3. 原生第一页附加本地条目、同名不同来源、cursor 失效/循环/后页失败：不误判结束或安装身份，见 Task 3。
4. 旧成功数据能展示但不能授权写入或解除未知写锁定，见 Task 2、3。
5. 挑战 HTML 含脚本、动态 URL 和秘密；正常 403 与挑战不同；页面慢读不能锁住导航，见 Task 1、4。

## Task 1：分组读取、Apps 适配与安全错误

**Files:** 修改 `src/codex/extensions.ts`；创建 `src/codex/extension-catalog.ts`；修改 `tests/extensions.test.ts`、`tests/extensions-fixture.ts`；创建 `tests/extension-catalog.test.ts`。

**Interfaces:**

- 在 extensions.ts 导出 `ExtensionSection`、`ExtensionSectionSnapshot`、`ExtensionSearchPage`，字段严格依 spec 12.2/12.4；既有 ExtensionItem 不改作第二套状态模型。
- catalog 导出 `readExtensionSection(peer:ExtensionPeer,cwd:string,section:ExtensionSection,options?:{refresh?:boolean;key?:string}):Promise<ExtensionsSnapshot>`；由 Runtime 后续注入 section/contextKey/cache 时间形成 SectionSnapshot。MCP key 只能解析服务端已核实对象。
- 导出 `classifyExtensionReadError(error:unknown):ExtensionReadError`；`ExtensionReadError={code:ExtensionReadErrorCode;rpcCode?:number;httpStatus?:number}`，code 枚举取 spec 12.6。只返回 allowlist 类别/代码；保留原异常在本次调用内，不透传。

- [x] 写 reader 红测：installed 成功不调用 app/list、MCP 工具、discovery 或市场 CLI；把 Apps 和 MCP promise 挂起也不阻塞 installed。
- [x] 写 Apps 红测：空库存不调 app/read；101 IDs 分批且并发有界；metadata 某批失败和 missingAppIds 均保留 runtimeName/enabled/callable；authorization/connected 不从 callable 推断。
- [x] 写兼容/错误红测：仅 -32601 或核实 method-not-found 回退；旧 app/list 消费 cursor/过滤可访问对象且 installed 未知；普通 403、401、超时、损坏 JSON、真正挑战分开分类。挑战检测在前 16 KiB 内，返回值不含 HTML、URL 查询或 token。
- [x] 运行 `node --test tests/extension-catalog.test.ts`，确认因当前全量编排/新接口缺失而 RED，不把环境权限失败当功能红测。
- [x] 实现 section adapters；并发独立本地读取；普通 skills 不 forceReload，显式刷新才强制。MCP 基本状态与工具/资源/模板详情读取分离。保留每源 notLoaded/unknown/partial 及已有字段脱敏。
- [x] 更新旧 extensions fixture 的已安装读取期望，不删除 CAS/策略/技能等有意义的原断言。运行 `node --test tests/extension-catalog.test.ts tests/extensions.test.ts`，确认 GREEN。

## Task 2：Runtime 缓存与读取 API

**Files:** 创建 `src/codex/extension-cache.ts`、`tests/extension-cache.test.ts`；修改 `src/codex/runtime.ts`、`src/server/codex-settings.ts`、`tests/extensions-api-errors.test.ts`；必要的 API 集成用例放 `tests/extensions.test.ts`。

**Interfaces:**

- `ExtensionCatalogCache.read<T>(context:ExtensionReadContext,key:string,policy:ExtensionCachePolicy,load:()=>Promise<T>,refresh?:boolean):Promise<ExtensionCached<T>>`；`invalidate(context?:ExtensionReadContext,namespaces?:Array<ExtensionSection|'search'>):void`。key 区分 namespace/query/cursor，MCP 另区分 `mode=status|detail` 与已验证 target key；policy 固定来自 spec，测试用可控时钟。
- 导出 `ExtensionReadContext={epoch:string;home:string;cwd:string;authRevision:number;configGeneration:number}`、`ExtensionCachePolicy={ttlMs:number;maxAgeMs:number}`、`ExtensionCached<T>={data:T;fetchedAt:number;lastSuccessAt:number;stale:boolean;error?:ExtensionReadError}`。maxAgeMs 从最近可用读取起计，不在 TTL 之后再加 15 分钟。可用 partial section 进入缓存，来源各自的错误/成功时间保留；只有该 section 的库存/定义完全不可用才由 load 抛分类失败并回退旧 section。无旧数据时不创造 T 的假空值。
- Runtime `extensions(cwd:string,options?:{section?:ExtensionSection;refresh?:boolean;key?:string})` 调 Task 1 reader；`GET /api/codex/extensions` 验证 projectId/section/refresh/key 后转发。旧 `/api/codex/plugins` 保持。
- 返回 contextKey/cache 及来源状态，失败有旧数据返回 stale，不改 lastSuccessAt；无旧数据返回该来源错误而非成功空数组。

- [x] 写缓存红测：相同 key 并发只读一次；TTL/显式刷新绕失败退避；整来源失败保留成功内容；15 分钟与 LRU 边界；单调用方取消不污染共享任务。基本 MCP 状态→A 详情→B 详情互不命中。旧 Apps=A，本次库存=A+B 且 metadata 403 时仍返回 B，失败 metadata 不伪报本次成功。
- [x] 写隔离红测：账号/home/cwd/epoch 不同均不命中；invalidate 后旧 promise 不能写回；account/updated 与退出清理，rateLimits 更新不变身份代。MCP 写后 config V2 与 Apps 旧 V1 不会循环冲突；外部配置更新推进 configGeneration，迟到 V1 不回滚它。Apps 更新通知只失效 Apps，普通读取不清除未知写锁。
- [x] 运行 `node --test tests/extension-cache.test.ts` 确认 RED。
- [x] 在 Runtime 生命周期拥有缓存，复用 directoryKey 路径规范和 accountChanged 通知。新鲜配置读/写后核对发现 userVersion 变化，推进 configGeneration 并清除全上下文缓存；校验读取发起 generation/序号，避免迟到版本回滚，不引入磁盘存储或后台常驻轮询。接收 app/list/updated 只失效，不覆盖安装库存。
- [x] 扩展 Fastify query schema，拒绝未知 section、任意 cwd、非法布尔值及非授权 target；Runtime 维持 reads/idle 调度与关闭语义。补 API 的 section/query 校验和身份变化隔离测试。
- [x] 运行 `node --test tests/extension-cache.test.ts tests/extension-catalog.test.ts tests/extensions-api-errors.test.ts`，确认 GREEN。

## Task 3：关键词分页与管理操作的相关来源核对

**Files:** 修改 `src/codex/extension-catalog.ts`、`src/codex/extensions.ts`、`src/codex/runtime.ts`、`src/server/codex-settings.ts`；创建 `tests/extension-search.test.ts`；修改 `tests/extensions.test.ts`、`tests/extensions-skill-actions.test.ts`、`tests/extensions-api-errors.test.ts`。

**Interfaces:**

- catalog `searchExtensions(peer:ExtensionPeer,cwd:string,input:{query:string;cursor?:string;refresh?:boolean}):Promise<Omit<ExtensionSearchPage,'contextKey'|'cache'>>`；Runtime 同名入口负责 Task 2 cache/context 并返回完整 ExtensionSearchPage；HTTP q 映射 query。
- 搜索目标登记绑定 context/query/page/key；管理前重新执行该页读取并核对身份。既有 `ExtensionMutation` 请求身份与 action 不放宽，返回结果增加 `contextKey:string`、`invalidatedSections:ExtensionSection[]`；snapshot 仅含相关来源已核对结果，未知来源仍标 notLoaded。
- configGeneration 不变时 invalidation 最小映射：skill→installed；MCP→installed/mcp；app enabled→installed/apps；plugin→installed/apps/mcp 并清搜索；marketplace→全部 section 并清搜索。新鲜 userVersion 改变则全上下文失效优先。写后仅核对本动作成功所需来源，其余来源在 UI 后台按需刷新；动作回复的新 contextKey 先驱逐旧 envelope，再重读，不能直接覆盖新代页面。
- `changeExtension` 使用相关来源的 fresh target context，代替写前/写后 `load()` 全量调用；`skill.read` 只核对配置、目标技能与受限文档。

- [x] 从当前 CLI/schema 核实搜索 fixture，记录版本；不要用 `.local/protocol` 的旧 0.156.1 目录冒充当前合同，不录入账号/凭据。先写空词/超长词拒绝、scope 固定、cursor 传递的红测。
- [x] 写分页红测：limit=50 但首屏 52 条且有 cursor 仍可继续；同名跨 marketplace 不去重；同 identity 跨页不重复；后页失败保留前页；循环游标显式错误；方法/实验能力不支持时没有全量 CLI/private HTTP 回退。
- [x] 写动作红测：过期或跨 context 搜索 key、对象消失、安装策略变化、CLI identity 不明确均拒绝；有效对象继续走 plugin add 及原回执校验。配置版本冲突、marketplace 移除影响不完整、未知写依然阻止重放。
- [x] 加“无关来源挂起”用例：skill.read/save 与 mcp.save 无须等待 discovery/Apps；写后只读相关来源。运行 `node --test tests/extension-search.test.ts tests/extensions.test.ts tests/extensions-skill-actions.test.ts` 观察 RED。
- [x] 实现分页面适配、身份去重、短期目标登记及相关来源 fresh 核对；不默认加入 plugin/read。明确 metadata-only/不可安装对象，既有受管限制不可因列表更快而弱化。
- [x] 运行上述测试及 `tests/extensions-api-errors.test.ts`，确认 GREEN；CLI stdout 上限与危险 stderr 处理不在本任务中放宽。

## Task 4：页面读取状态、发现分页与局部样式

**Files:** 创建 `src/web/extensionsState.ts`、`tests/extensions-state.test.ts`；修改 `src/web/InstalledPlugins.tsx`、`src/web/extensions.css`、`src/web/i18n/catalogs/extensions.ts`、`tests/extensions.spec.ts`、`tests/extensions-fixture.ts`。

**Interfaces:**

- `mergeExtensionSection(current:ExtensionsSnapshot|null,incoming:ExtensionSectionSnapshot):ExtensionsSnapshot` 按拥有的 section/identity 合并；context 或配置版本冲突要求重读，不合并旧数据。
- InstalledPlugins 保留当前路由与 installed/discover/sources 入口；状态分成 per-section read、mutation、skill document read；搜索结果独立于 installed snapshot。
- 监听已有 shared-state usage-invalidated 与 auth-lost，清理旧上下文；组件失效/换词后的旧响应不得影响新页面。

- [x] 写 merge 红测：Apps/MCP 响应不抹插件/技能，来源失败不改为零项，缺元数据不删除库存，过期上下文/配置版本响应不合并。
- [x] 写浏览器红测：deferred Apps/MCP 时可读已安装/切页签；返回页面复用缓存；每个来源错误可单独重试；后台读取不显示“操作中”或锁全页。
- [x] 写发现页红测：空词引导、200ms 防抖、加载更多、后页重试、换词迟到响应、选中项返回保留搜索；安装只使用服务端 key，未知写后缓存刷新不能直接解锁。
- [x] 写挑战红测：仅显示本地化类别与安全诊断；raw HTML/动态 URL/秘密不出现在 DOM；辅助链接固定为官方站点且声明不代表验证完成；按钮不触发登录、代理或服务变更。
- [x] 运行 `node --test tests/extensions-state.test.ts` 与 `npx playwright test tests/extensions.spec.ts`，观察缺失行为的 RED。
- [x] 实现 section 合并/并发请求/保留旧内容、搜索分页与双语状态；按 kind 显示适用字段、能力分组，局部修正 facts/label/input 的 CSS 优先级与间距，不全局重写设置样式。
- [x] 同命令确认 GREEN。实际走 installed → 筛选 → 详情 → 返回、discover → 搜索 → 更多/失败重试、sources/MCP/技能弹窗；查看 1440/390、中英文、200% zoom 与键盘截图，记录既有全局顶栏缺陷，不能只测溢出。

## Task 5：验证、性能与交付

- [x] 运行相关 Node 回归：`node --test tests/extension-catalog.test.ts tests/extension-cache.test.ts tests/extension-search.test.ts tests/extensions-state.test.ts tests/extensions.test.ts tests/extensions-api-errors.test.ts tests/extensions-skill-files.test.ts tests/extensions-skill-actions.test.ts tests/codex-settings.test.ts tests/i18n.test.ts`。如果 Windows sandbox 临时 rename/fixture 权限失败，保留首次分母，再合规重跑隔离 fixture，不放松断言。
- [x] 运行 `npx playwright test tests/extensions.spec.ts tests/codex-settings.spec.ts`；Browser plugin 不可用时使用项目独立 headless Playwright，不切换用户前台、不读取/改写系统剪贴板。
- [ ] 在用户实际服务上仅做已认证的只读性能核验，记录至少 2 冷/5 热、每个 section 耗时、cache hit/miss；比较 installed 热读 p95≤200ms、呈现≤500ms 的目标。真实失败、冷启动、缺失和未测项分别记载；不能用 mock 响应冒充上游恢复。
- [x] 独立审查 API/缓存/写安全/UI；完成 `npm run build`、`git diff --check`，更新主目录 dist 并核对入口。若未获实现授权，此步骤不得提前执行。
- [x] 更新 spec 第 12 节验收状态、计划结果与所有未通过边界；收口单个中文实现提交。服务重启必须按 AGENTS 的独立授权/受管脚本流程，不在构建后自动安排。

## 本轮文档检查

- 读取路径和写路径已分开，所有来源刷新/缓存/未知写锁都有对应任务与测试。
- search 不默认取全目录、不依赖私有 HTTP；用户人工验证只作为辅助提示，不冒充可闭环的 Cloudflare 验证。
- 用户授权后已实现适配、缓存、API、搜索与写前身份核对。最终验证、构建和 dist 见下文；用户 Web 服务未重启，实际入口性能保留待验收。

## 实施裁定与证据（2026-10-30）

- 新增 ExtensionService 管理身份、缓存与目标登记，Runtime 保有生命周期，无磁盘目录快照。首次版本确认也建立 generation 围栏，仅将本次刚核实的成功结果迁入新代；旧读和写后迟到快照不能回滚新版本。写已发生而配置代已变时保留未知结果锁，不自动重试。
- 0.164.0 原生 MCP schema 只有 toolsAndAuthOnly/full，没有保证不发现工具的纯状态 RPC。后台基本读取可能初始化连接和返回工具；基本适配不向页面输出完整工具目录，详情使用已验证目标 key。独立加载不代表免除原生发现成本。
- Apps 方法能力分别缓存，app/read 不支持不再连带禁用 app/installed。库存保留，metadata 显示 partial；仅库存方法不支持才回退旧目录，403 不回退。
- 搜索与已安装统一使用市场名称/路径/插件 ID 组成的 opaque key。写前须完整 fresh plugin/installed 证明 CLI 市场名称唯一且路径匹配，缺失/重复/不完整均写前拒绝；写后按完整 key 核对。跨已见页同 CLI ID 的不同身份也拒绝。
- 64 页缓存外，跨页证据限 64 个查询、全局 64,000 identity 与 4,096 cursor 记录，15 分钟无成功读取过期。超限明确 CATALOG_LIMIT/要求缩小关键词，不悄悄丢链继续；196 页 × 50 条已验证可继续。
- 服务端按 epoch/home/cwd/auth 保存未知写 required/remaining 集合，独立于缓存 LRU。SectionSnapshot 可选 writePendingSections 使页面重挂载仍禁写；相关 section 必须在同配置代显式新鲜对账，普通缓存/partial 不解锁。锁是 Runtime 内存状态，不声称跨进程事务日志。
- 后页 HTTP 错误与 200+结构化来源错误都保留前页及失败 cursor；未知写后只读缓存不恢复写权限。challenge 按真正 status 403 Forbidden/特征及 UTF-8 前 16 KiB 分类，HTML/秘密不进入页面。

### 真实原生读取，非当前 Web 服务入口

两组独立 Runtime/native app-server，仅目录读取，无模型、业务工具、配置写；自身进程均关闭。冷读指新 Runtime 的 section 缓存为空，不清上游或 OS 缓存。首次沙箱启动失败另存：RUNTIME_UNAVAILABLE、目录 RPC=0、18 槽未开始；一次明确提权复核后 18/18 完成。

| 冷 section | 第 1 组 | 第 2 组 |
| --- | ---: | ---: |
| installed | 6314 ms / 124 项 | 724 ms / 51 项 |
| Apps | 864 ms | 869 ms |
| MCP | 4429 ms | 1734 ms |
| marketplaces | 491 ms | 343 ms |

初始化 676/373 ms。10 个预期热读中 9 次保留 fetchedAt，耗时 0.24—11.04 ms；另一次重取 514.82 ms，库存从 51 变 124 项。内容不同，不能计算等价加速比；不把 Service/RPC 结果冒充 Web HTTP p95 或页面 ≤500 ms 验收。当前旧 Web 未重启，实际入口性能待用户重启后复核。

### 界面范围

已用独立 headless Edge 操作列表/筛选/详情/返回、发现搜索/更多/失败重试、来源/MCP/技能弹窗，并查看 1440/390、中英文、200% zoom、键盘与截图。局部 facts/label/input/相邻按钮间距已修正；390px/200% 既有全局品牌与用量徽章挤压仍在，单列为未修范围。未操作用户前台或系统剪贴板。

统一回归与构建回执如下；实际运行服务的未验收项继续保留。

### 统一回归回执

- 首轮默认并发全量 Node：985 项，978 通过、2 失败、5 跳过。Git fetch 辅助进程未及时启动（pids.json ENOENT）单独重跑通过；release 终态读期间缓冲消息竞争已补确定性 RED→GREEN 回归并修复，不放松原断言。
- 最终 `node --test --test-concurrency=4 tests/*.test.ts`：987 项，982 通过、0 失败、5 跳过（4 项 Linux 平台门控，其中 systemd 另需显式开关；1 项发布包用例缺少 PORTABLE_TEST_DIR）。无取消或 todo。
- `npm run build`（含 TypeScript）与 `git diff --check` 通过。生成入口为 `/assets/index-De5qGabl.js`，CSS 为 `/assets/index-DEQdZXs8.css`；保留既有大 chunk 提示，不新增依赖。
- 独立审查补回归：库存/metadata 方法能力隔离、首次版本确认旧读围栏、写后迟到版本不回滚、跨市场 CLI 身份与回执、未知写跨重挂载及同版本新鲜对账、分页循环/证据预算/过期。
- 界面阶段的首次 symlink EPERM、错误 locale fixture 失败及一次桌面 30 秒超时保留；未以环境错误充当功能 RED，后续按原断言通过。

主目录 dist 在合入时按同一源码重建并核对以上入口；服务重启、真实 Web HTTP/呈现指标和真实账号写操作均不在已通过范围。

### 暂停恢复后的最终浏览器核验

统一 4 文件共 104 例运行，102 通过、2 失败。失败两例是已有指令编辑页的真实竞态：初读取消后切至未选项目的 project 范围，空目标直接返回未清 busy，导致两个选择器永久禁用。复用原 read 的空目标分支加一行 setBusy(false)，保留旧请求 abort 结果守卫，不改写入协议或延长测试超时。

修复后原失败两例各重复三轮 6/6 通过，完整 settings 52/52 通过；再补选择器启用断言与 390/1440 空目标截图，两例 2/2 通过并实际查看。目录 15 例、会话 37 例在联合运行中均通过，按文件最终覆盖 104 个不同用例；保留 102/104 的首次分母，不声称单次联合全绿。原始联合日志为 .local/implementation-20261030/browser-final.log，后续为 settings-after-instructions-fix.log 和 instructions-empty-project.log。

最终工作树构建再次通过，入口 index-De5qGabl.js（CSS index-DEQdZXs8.css）。Node 全量之后仅新增这行前端 busy 修复及对应断言/截图，随后相关浏览器、TypeScript 和构建均通过。验收截图/日志保留在隔离 worktree 的 .local，未纳入发布包或读取用户前台。