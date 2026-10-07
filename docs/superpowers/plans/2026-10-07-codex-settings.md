# Codex 设置页 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task; only use superpowers:subagent-driven-development if the user selects delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付配置、用量、常规、指令与已安装插件五类可用设置，保留既有功能与生效范围。

**Architecture:** 保留 Runtime 对原生进程的所有权，通过固定配置白名单和只读插件投影接入原生 RPC；指令服务只处理两个固定文件目标。页面按分类懒加载，复用现有模型、权限、用量 provider、通知、重启与差异显示。

**Tech Stack:** TypeScript、React 19、Fastify 5、Node 24、现有 Node test runner 与 Playwright；无新增生产依赖。

**Spec:** [Codex 设置页设计规格](../specs/2026-10-07-codex-settings.md)。P0 已实现，Task 1—8 验收与整分支审查通过；交付合并为一个中文提交，保留全部原临时提交信息。尚未部署，真实写入未验收；测试证据与限制见 [设置能力记录](../../verification/codex-settings-capabilities.md)。

## Global Constraints

- 不新增生产依赖；复用 React、Fastify、Node 标准库和现有测试工具。
- 首期只写用户级 Codex 配置；项目配置只显示来源和覆盖效果，不提供任意 TOML 编辑器。
- 设置页写操作显式保存；显示原值／新值及范围。保留首页创建成功后保存模型默认值的既有行为，并补齐版本保护。GET 不修改配置、不恢复会话、不安装插件、不重启进程。
- 配置写入必须有版本检查和回读；禁止为“生效”自动重启或重发任务。
- 管理路由复用登录、Origin、CSRF 校验；禁止接收任意文件路径、任意配置键或任意 RPC 方法。
- 远程页面操作的是服务器主机；“此浏览器”设置只影响当前浏览器。缺失、受管、未知、失败不显示为关闭、零或未安装。
- 界面验证 390px 和 1440px；中文提交；完成独立需求后合并临时提交并保留原提交信息。
- 插件已安装列表属于 P0；启停、授权、安装卸载与市场不属于 P0。
- P0 不热加载原生配置，不写项目 config.toml，不修改真实个人指令／配置作为自动测试。
- 用户后续已明确授权 P0 实施和子 agent 协作，覆盖初版计划的待授权状态；仍不授权真实配置／指令写入、插件管理、电脑操作或部署。最终整分支审查与提交合并由控制器完成。

## Review Focus

1. 桌面端同时改配置：409 保留草稿，不能由旧默认值入口绕开版本检查（Task 2）。
2. 受管或新版权限不能表示：该组只读，但不牵连模型和搜索字段（Task 2、6）。
3. 主机路径被链接替换或外部编辑：固定目标校验、409／写入失败保留原文（Task 3）。
4. 插件接口不支持、部分市场失败和真正空列表：三种状态不能合并（Task 4、6）。
5. 手机、IME、未保存内容和账户变化：不误发、不丢草稿、不消耗旧账户额度（Task 5—7）。

## 文件边界与执行顺序

以下是计划新增或修改的文件，不是本轮已经实现的文件。

| 文件 | 责任 |
| --- | --- |
| `src/web/Settings.tsx`（新） | 从 main 提取设置、五分类导航、常规、未保存离开保护 |
| `src/web/ConfigSettings.tsx`（新） | 配置表单、来源、差异、冲突和回读结果 |
| `src/web/InstructionsSettings.tsx`（新） | 个人／项目指令编辑及差异预览 |
| `src/web/InstalledPlugins.tsx`（新） | 插件只读列表、筛选及能力／错误状态 |
| `src/web/preferences.ts`（新） | 仅发送快捷键本地读写及键盘判定 |
| `src/web/AccountUsage.tsx`（改） | 从现有 provider 提供可复用的内联面板，保持唯一请求状态 |
| `src/codex/settings.ts`（新） | 配置字段类型、投影、受管校验、原生 edits 构造 |
| `src/codex/installed-plugins.ts`（新） | 插件结果的安全投影及稳定标识 |
| `src/server/codex-settings.ts`（新） | 六条固定设置路由及 Schema；不含任意 RPC |
| `src/server/instructions.ts`（新） | 固定 AGENTS.md 目标、版本、大小／编码与原子保存 |
| `src/codex/runtime.ts`（改） | 配置读写、插件读取的薄入口，复用 call／mutation 错误处理 |
| `src/server/app.ts`、`api.ts`、`diagnostics.ts`（改） | 注册路由、接入默认值兼容入口、暴露诊断摘要 |
| `src/web/main.tsx`、`SessionView.tsx`、`style.css`（改） | 页面接线、快捷键复用、响应布局 |

Task 1 → 2／3／4；Task 5 → 6；Task 6 消费 2／3／4；Task 7 完成通用偏好；Task 8 验收。这里的依赖允许逐项交付，不表示授权并行 agent。

## Task 1：核对原生能力并记录边界

**Files:** 查看 `.local/protocol/v2/{ConfigReadResponse,ConfigBatchWriteParams,ConfigWriteResponse,PluginInstalledParams,PluginInstalledResponse,PluginSummary}.ts`、`src/codex/app-server.ts`、`runtime.ts`；新增 `docs/verification/codex-settings-capabilities.md`。

**Interfaces:** 消费 `AppServer.initialize/request/close`；产生配置基础层版本来源、写入接口语义和 `plugin/installed` 的支持结论，不新增产品接口。

- [x] 对当前安装 CLI 开独立只读探测，调用 initialize、config/read(includeLayers:true)、configRequirements/read、plugin/installed。不调用写入、resume、reload、install 或 OAuth；输出仅字段存在性、版本、计数和脱敏错误码，不输出完整配置。
- [x] 记录本机 CLI 版本与日期，确认用户基础配置层可确定；缺少版本或 profile 无法区分时标记不可写。插件未知方法标记 unsupported，不回退 plugin/list。
- [x] 记录 config/batchWrite 的 expectedVersion、回读和错误语义依据；本步骤不能向真实用户配置写“测试值”。后续写入契约由隔离测试验证，实机写入另行授权。
- [x] 执行文档检查并提交：`git diff --check`；中文信息“核对设置页原生能力边界”。失败能力进入页面状态设计，不伪造接口成功。

## Task 2：配置读写服务与统一默认值入口

**Files:** 新增 `src/codex/settings.ts`、`src/server/codex-settings.ts`、`tests/codex-settings.test.ts`；修改 `runtime.ts`、`server/api.ts`、`server/app.ts` 及现有 `/model-defaults` 前端调用。

**Interfaces:**
- `SettingsValues` 仅有 spec §4.1 的七个字段；网络值在 Web DTO 使用 `workspaceNetworkAccess`，服务端固定映射原生键。
- `Runtime.readSettings(cwd: string): Promise<SettingsSnapshot>`：`{fields, userVersion: string|null, userFile: string|null, writable: boolean}`；fields 为固定字段记录，每项 `{userValue, effectiveValue, origin, writable, reason}`，未知值使用 null。
- `Runtime.writeSettings(cwd: string, input: {expectedVersion: string; values: Partial<SettingsValues>}): Promise<{status:'written'; snapshot:SettingsSnapshot; effect:'future-sessions'}>`。
- `registerCodexSettingsRoutes(app, {runtime, projects, instructions})` 注册 spec §5 固定路由；projectId 只能由 Projects 解析，HTTP 不传 cwd/filePath。

- [x] 在 `codex-settings.test.ts` 用 fake 原生 peer 编写失败用例：白名单外 `model_provider`／任意 filePath 返回 400；模型与强度不兼容拒绝；受管或新版权限组不可写；模型与搜索仍可保存；项目覆盖返回不同 effectiveValue。
- [x] 加入精确断言：
  ```ts
  assert.equal(conflict.statusCode, 409);
  assert.equal(writesAfterConflict.length, 0);
  assert.equal(sent.expectedVersion, 'user-v1');
  assert.notEqual(sent.reloadUserConfig, true);
  assert.deepEqual(Object.keys(publicFields).sort(), allowedPublicFields.sort());
  ```
  另测批量写超时返回 SETTINGS_WRITE_UNKNOWN、回读失败不宣称“已生效”、缺版本旧入口返回 409，以及整个响应无伪造 secret 字符串。
- [x] 运行 `node --test tests/codex-settings.test.ts`，确认失败来自新契约缺失。
- [x] 实现白名单投影与原生 batchWrite；复用 permissionChoices、模型目录与原生约束。writeSettings 先校验、携带原用户层版本、原子提交后回读；只选择基础用户层，profile 不明确则只读。
- [x] 让 saveModelDefaults 和 `/api/model-defaults` 走相同的写入方法；首页初始读取配置时保留 expectedVersion，任务创建成功后携带原版本保存，保留成功响应的旧 model/effort/effective 字段。没有版本或出现冲突时仅提示默认值未保存，不影响已创建任务、不重发消息、不临时获取新版本覆盖并发修改。增加相应用例。接口错误加入现有 Fastify 可识别分支，避免被吞成 Internal server error。
- [x] 加入路由鉴权／CSRF、projectId 路径边界用例并运行 `node --test tests/codex-settings.test.ts tests/runtime.test.ts tests/api.test.ts tests/auth.test.ts tests/turn-settings.test.ts`。
- [x] 提交“增加受控 Codex 配置读写并统一默认值保存”。验收 A2、A3、A4、A9。

## Task 3：个人与项目指令的固定目标服务

**Files:** 新增 `src/server/instructions.ts`、`tests/instructions.test.ts`；修改 `codex-settings.ts` 注册对应路由；Runtime 增加 `configurationHome(): Promise<string|null>`，仅从当前已初始化原生进程取得可信 codexHome。

**Interfaces:** `InstructionTarget = {scope:'user'|'project'; projectId?:string}`；`InstructionDocument = {path:string; content:string; version:string; exists:boolean; writable:boolean; reason?:string; overriddenBy:string|null}`。`Instructions.read(target): Promise<InstructionDocument>`、`write(target, {expectedVersion:string, content:string}): Promise<InstructionDocument>`；构造参数为 `{codexHome:()=>Promise<string|null>, projects:Projects}`，不接收客户端路径；home 不可用时返回明确的能力错误。

- [x] 在工作区临时目录编写失败用例：不存在文件 GET 后仍不存在；正常保存；两编辑者旧版本 409；UTF-8 超过 262144 字节拒绝；非法 UTF-8 只读；BOM／CRLF 保留；AGENTS.override.md 提示；项目目标逃逸、文件链接和替换成目录拒绝；rename 失败原文件字节不变。
- [x] 运行 `node --test tests/instructions.test.ts` 确认预期失败。
- [x] 实现固定路径解析、字节散列版本（不存在使用专用版本标记）、同目标写入串行、保存前真实路径和版本复查、同目录临时文件替换。临时文件只清理本次创建且身份确定的目标，绝不先 unlink 原文件。
- [x] 在服务说明中保留“跨外部进程不是事务锁”的限制；不引入文件监听、记忆数据库或通用编辑 API。
- [x] 运行 `node --test tests/instructions.test.ts tests/codex-settings.test.ts`；提交“增加个人与项目指令受控编辑”。验收 A7、A9。

## Task 4：P0 已安装插件只读接口

**Files:** 新增 `src/codex/installed-plugins.ts`、`tests/installed-plugins.test.ts`；修改 Runtime 和 `server/codex-settings.ts`。

**Interfaces:** `Runtime.installedPlugins(cwd?: string): Promise<InstalledPluginsSnapshot>`；返回 `{supported:boolean, items:InstalledPlugin[], partial:boolean, errorCount:number, updatedAt:number|null}`。条目仅含 `{key,id,name,description,marketplace,localVersion,enabled,availability,reason}`，未知可选字段为 null；key 由市场标识及 id 构成。

- [x] 用 fake peer 写失败用例：同名不同市场不合并；installed=false 不进入 items；缺 localVersion 不借用 version；未知方法 supported=false；成功空数组 supported=true；部分市场错误 partial=true 且保留已读项目；全失败不得表示暂无插件；任意源凭据不外泄。
- [x] 运行 `node --test tests/installed-plugins.test.ts` 确认预期失败。
- [x] 实现一次 plugin/installed 调用及纯投影，不请求安装建议、不发 plugin/list／plugin/read／OAuth／reload；无自动轮询和额外后台索引。
- [x] 断言 fake peer 的 method 列表仅含 initialize 和 plugin/installed；GET API 认证失败不触发原生调用。
- [x] 运行 `node --test tests/installed-plugins.test.ts tests/codex-settings.test.ts`；提交“提供已安装插件只读列表”。验收 A8、A9。

## Task 5：设置导航与用量页复用

**Files:** 新增 `src/web/Settings.tsx`、`tests/codex-settings.spec.ts`；修改 `main.tsx`、`AccountUsage.tsx`、`style.css`；复用 `tests/settings-restart.spec.ts`。

**Interfaces:** `Settings({onChanged})` 保留原入口回调；分类取 location.search。`AccountUsagePanel()` 在原 provider 内消费同一状态；原弹窗和设置页都渲染此内容，确认弹窗仍由唯一 provider 管理。不要在设置页再挂一个 provider。

- [x] 编写浏览器失败断言：直接进入各 section、刷新／后退保持分类；未知 section 回退常规；原通知、重启和改密入口保留；配置接口失败不阻止打开用量／常规；390px 无横向溢出。
- [x] 额度测试断言：设置页与徽章显示一致、同时刷新合并请求、401 保留既有退出行为；待确认期间账户切换不可消耗旧额度，结果未知沿用原 idempotencyKey。
- [x] 运行 `npx playwright test tests/codex-settings.spec.ts tests/settings-restart.spec.ts` 确认新页面断言失败。
- [x] 从 main 提取现有 Settings，增加五类导航；用量仅抽取必要的共享内容／context，不重写额度逻辑。保留快速弹窗入口。
- [x] 运行上述浏览器测试及 `node --test tests/account-usage.test.ts tests/account-usage-helpers.test.ts tests/settings-restart.test.ts`。
- [x] 提交“整合设置导航与账户用量页面”。验收 A1、A5。

## Task 6：配置、个性化与插件三个分类界面

**Files:** 新增 `ConfigSettings.tsx`、`InstructionsSettings.tsx`、`InstalledPlugins.tsx`；修改 Settings、main 的必要导航接线及 `codex-settings.spec.ts`、style.css。

**Interfaces:** 三个分类组件通过现有 api() 消费 Tasks 2—4；有表单的组件接受 `onDirtyChange(dirty:boolean)`，Settings 统一维护离开保护。切换 scope/project 时先检查当前草稿。配置比较固定字段原值／新值；指令使用原文／新文并排文本，手机上下排列。现有 `GitHistory.tsx` 的 DiffView 依赖 Git diff 数据，本任务不为指令另造 diff 引擎。

- [x] 浏览器失败断言：受管权限说明与不可编辑状态；模型不支持的强度不可保存；用户值与有效值分别显示；409 保留草稿；504 先核对，页面不自动第二次 POST。
- [x] 指令测试包含 scope 和项目切换、保存前差异、覆盖提示、缺失／只读；配置／指令的取消离开保留 URL 和输入，显式放弃才清空。覆盖侧栏跳转、分类切换、浏览器后退；刷新仅检查已注册原生 beforeunload 防护。
- [x] 插件 UI 测试分别构造成功列表、unsupported、空、partial、刷新失败保留旧值；只在成功读取后更新时间，enabled 标签不使用“已连接”；页面没有安装／启停按钮。
- [x] 运行 `npx playwright test tests/codex-settings.spec.ts` 确认失败后，实现最小表单、状态和固定字段差异。首次进入只请求本分类数据，插件搜索只筛选当前数组。
- [x] 在 390px 和 1440px 验证表单键盘访问、错误焦点、无横向滚动、保存按钮忙态防重复；运行同一测试直至通过。
- [x] 提交“实现配置指令表单与插件只读页面”。验收 A1—A4、A7—A9。

## Task 7：发送快捷键与诊断摘要

**Files:** 新增 `src/web/preferences.ts`、`tests/preferences.test.ts`；修改 main、SessionView、Settings、server/diagnostics.ts、server/app.ts；扩展 `tests/diagnostics.test.ts`、`codex-settings.spec.ts`。

**Interfaces:** `readSendShortcut(): 'enter'|'mod-enter'`、`writeSendShortcut(value): boolean`、`shouldSubmit(event, {mobile, shortcut}): boolean`；键名 `codex-web:send-shortcut:v1`。`Diagnostics.status()` 返回 `{enabled:boolean,lastWriteAt:number|null,dropped:number,writeFailures:number}`，enabled 由实例是否关闭决定；无实例时 app 返回 enabled=false 和 null 时间。

- [x] 失败断言：默认桌面 Enter 发送、Shift+Enter 不发送；mod-enter 接受 Ctrl 或 Meta；IME／手机始终不由 Enter 发送；无效存储回到默认、写失败 UI 提示未持久化；首页与会话行为一致。
- [x] 诊断测试断言：仅 append 成功更新时间；失败增加计数；读取 status 不启动原生进程、不读取日志正文；关闭实例不显示 enabled=true。
- [x] 运行 `node --test tests/preferences.test.ts tests/diagnostics.test.ts` 确认预期失败后实现。复用已有发消息状态约束，不更改发送 payload、不新增消息重试。
- [x] 常规页显示诊断摘要与现有运行信息；不新增启用开关，不修改自动重启流程。
- [x] 运行上述 Node 测试及 `npx playwright test tests/codex-settings.spec.ts tests/questions.spec.ts tests/settings-restart.spec.ts`。
- [x] 提交“增加发送偏好与当前诊断状态展示”。验收 A6、A9。

## Task 8：集成验收与交付

**Files:** 更新 `docs/guides/sessions.md` 中设置与生效范围说明，更新 `docs/verification/codex-settings-capabilities.md` 的验证记录；不记录用户配置内容、指令原文或凭据。

- [x] 逐项对照 spec A1—A10，记录通过、失败、未支持，不把 mock 用例当作本机插件／桌面能力实测。
- [x] 设置工作区临时目录后执行：
  ```powershell
  $env:TEMP = Join-Path $PWD '.local/tmp'
  $env:TMP = $env:TEMP
  npm test
  # 默认并发有环境失败；完整复验使用前置参数，不排除测试
  node --test --test-concurrency=1 tests/*.test.ts
  npx playwright test tests/codex-settings.spec.ts tests/settings-restart.spec.ts tests/questions.spec.ts
  npm run build -- --outDir .local/codex-settings-build
  git diff --check
  ```
  预期全部适用测试通过；平台跳过项单列，构建只有警告时记录警告。构建不覆盖在线 dist。
- [x] 本机只读验收：原生配置来源、用量、指令读取、插件列表与支持状态、诊断摘要；不得把“设置开关已开启”写成“电脑操控已验证”。
- [x] 真实配置／指令写入和上线由用户另外授权，执行时记录回读与生效范围；未经授权则明确标记未验证，不将其视为已上线。
- [x] 审查 diff 只涉及本需求，记录临时提交标题后按仓库规则合并；中文最终提交说明保留原信息。推送与线上重启不自动执行。

集成状态：完整单并发 Node 341 通过／5 跳过，浏览器复用 Task 7 的 43 项成功证据（产品源码及套件未变），TypeScript／构建／diff 检查和宿主只读核验通过。保留两轮默认并发失败分母及参数顺序修正，见 [设置能力记录](../../verification/codex-settings-capabilities.md)。整分支审查通过（Critical／Important／Minor 均为 0），交付提交保留原临时提交信息；未部署、未做真实配置／指令写入。

## 后续计划入口（本计划不实施）

- **P1 记忆**：只读确认原生记忆配置与 Agent Memory 插件边界 → 单独规格 → 开关与生效范围测试；删除另行授权。
- **P1 插件管理**：详情／连接状态 → 启停 → OAuth → 安装卸载 → 市场。每一步独立确认原生支持、错误和回滚语义，补该阶段 spec/plan 后实施。
- **电脑操控前置验证**：在不改变授权、不截取或操控其他应用的前提下核对 Web 原生进程是否提供桌面／浏览器能力，记录失败层；可以提前于 P1，但不阻塞五类 P0 页面。
- **P2 电脑操控**：前置验证通过后，针对已证实接口制定应用访问规则、扩展连接、真实操作与撤销验收；不把远程桌面系统扩建混入设置页。

## 自审记录

- 范围覆盖：A1→5/6，A2→2/6，A3→2/6，A4→2，A5→5，A6→7，A7→3/6，A8→4/6，A9→2/3/4/6/7，A10→8。
- 用户追加已纳入：插件已安装列表为 Task 4 和 Task 6 的 P0 必需项，管理操作只在后续入口中出现。
- 本计划没有要求 agent 自动修改真实配置、删除记忆、安装插件、开启桌面授权或重启在线服务。
