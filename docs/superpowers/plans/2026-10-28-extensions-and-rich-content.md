# 插件与集成、富内容展示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有设置与会话页面实现统一扩展管理和有明确合同的富内容展示，并为受限宿主能力保留可读、可核验的降级。

**Architecture:** 复用 Runtime、原生配置 CAS、受认证 API、项目文件权限、React/Streamdown 与既有控件。管理动作使用稳定 CLI/已核实 RPC；正文解析独立于工具结果；可执行预览使用专用隔离宿主，无法证明网络边界的浏览器只展示源码。

**Tech Stack:** Node 26、TypeScript、Fastify、React 19、Streamdown、现有 Node tests 与 Playwright/Chrome；不新增运行时依赖。

**Spec:** `docs/design/2026-10-28-extensions-and-rich-content.arch.md`。用户 2026-10-28 明确要求“落 plan 然后实施吧”，计划落盘后持续实施，无须重复审批。

## Global Constraints

- 保留 `/settings?section=plugins`；默认“已安装”，只有“已安装 / 发现市场”主导航，市场来源独立管理。
- 原生配置、安装结果及授权状态是管理数据源；安装、enabled、授权、连接、callable 分别呈现。
- 不调用官方标注生产客户端禁用的 `plugin/list/read/install/uninstall`；稳定替代为 `codex plugin` 与 `codex plugin marketplace` 固定 argv/JSON 命令。
- 不增加任意 RPC、任意 shell 或任意绝对路径文件读写 API；保留受管、来源层级、`expectedVersion`、敏感文件和越界保护。
- 未知写结果不重试、不假报成功；不用真实账号/安装/任务验证破坏性动作，不停止活动任务或重启 Web。
- 引用载荷上限 8 KiB，路径上限 4096 UTF-8 字节，标题上限 200 字符；HTML 上限 1 MiB；widget 状态上限 16 KiB。
- 不执行代码示例、用户/工具文本的展示标记，不全局删除私用区字符；原始消息与工具收据保持可恢复。
- iframe 不授予 same-origin、顶层导航、弹窗、表单、下载或父页面 API。CSP/沙箱不等于完整断网，必须验证自身导航、本站 API、外站与网络旁路。
- 不能满足交互边界时只提供源码/受限静态降级，该项不记作交互验收通过。
- 每次 UI 改动检查真实浏览器、截图；桌面/窄屏、中英文、焦点、Esc、触控区和相邻控件间距留证。
- 最终合成一个中文 commit，正文保留本次中间提交说明；不推送或发布，不擅自重启。

## Review Focus

1. 来源/账号/受管状态未提供时不能被投影成空列表或绿色成功（Task 1/2）。
2. CLI 超时但实际写入时不能重复安装，配置冲突不得覆盖其他设置（Task 1）。
3. 分片、代码围栏及未闭合标记不能吞后续正文，复制仍能获得原文（Task 3）。
4. 文件读取期间增长、链接越界与失效历史不能变成可执行截断内容（Task 4）。
5. 不可信脚本自身导航、伪造消息及跨会话状态不能越过预览边界（Task 4/6）。

## 文件与协作边界

在 `.worktrees/extensions-rich-content-20261028` 的 `feature/extensions-rich-content-20261028` 实施，起点 `b20533d`。复用根 checkout 的现有依赖，不重新安装。管理、正文适配、预览安全三个领域可在不写同一文件时并行；主代理负责共享入口与最终验证。

- 管理：`src/codex/extensions.ts`、`src/codex/runtime.ts` 的扩展专用方法、`src/server/codex-settings.ts`、`src/web/InstalledPlugins.tsx`、独立扩展样式/翻译、对应测试。
- 正文：`src/web/richContent.ts`、`RichMessage.tsx`、独立富内容样式/翻译、解析及 UI fixtures。
- 主代理：计划/状态、`src/projects.ts`、预览 server 模块/路由、`RichPreview.tsx`、`Conversation.tsx` 接入、共用 i18n 汇总、浏览器与安全验收。

### Task 1: 原生扩展能力适配与受限写操作

**Files:** 创建 `src/codex/extensions.ts`、`tests/extensions.test.ts`；修改 `src/codex/runtime.ts`、`src/server/codex-settings.ts`；必要时新增 CLI fixture。

**Interfaces:** 导出 `ExtensionsSnapshot` 和有限 `ExtensionMutation`，Runtime 提供 `extensions(cwd)`、`changeExtension(cwd,input)`；HTTP `GET /api/codex/extensions`、`POST /api/codex/extensions/action`，沿用 projectId 到 cwd 的授权映射。不扩展旧 settings 的任意键白名单。

- [x] 先写缺失行为测试并观察失败：稳定 CLI argv、JSON 校验、部分目录失败、秘密脱敏、受管拒绝、CAS 冲突、未知写结果不重放。
- [x] 实现已安装/可发现插件与市场、skills/list、apps、MCP 状态的有界投影，分别保留 owner/范围/支持与错误。
- [x] 实现核实过的插件安装/移除/启停、市场添加/移除/升级、独立 MCP 配置/删除/认证/退出认证/重载、技能启停、应用本地启停；每项按真实宿主路径读回。
- [x] 技能创建/编辑/本地导入/移除仅限可验证的用户或项目技能目录、版本和链接保护；未核实的远程安装/插件分享发布与账户连接采用有原因的原生流程交接，不伪造 API。
- [x] 运行 `node --test tests/extensions.test.ts tests/installed-plugins.test.ts tests/codex-settings.test.ts`；预期新增用例通过且既有权限/脱敏用例不退化。

### Task 2: 统一插件与集成中心

**Files:** 修改 `InstalledPlugins.tsx`、`Settings.tsx` 的标题/入口和相关测试；创建独立 `extensions.css`、翻译目录 `catalogs/extensions.ts` 与浏览器 fixture。

**Interfaces:** 消费 Task 1 的 snapshot/mutation；保留旧 URL，列表/详情返回保留筛选和滚动。独立翻译交由主代理汇入 catalogs。

- [x] 默认已安装，类型/状态/搜索筛选，包内能力关联 owner；详情、添加菜单、发现与来源管理可操作。
- [x] 所有写动作有 busy/错误/未知结果与读回反馈；移除前显示实际影响，受管/宿主限制具体说明。应用授权仅交接可信原生 URL 后刷新，不将启用当连接。
- [x] 表单覆盖 MCP STDIO/HTTP 互斥字段、超时/工具策略和秘密保留；创建/分享等无稳定宿主路径时显示明确原因及可行交接，不隐藏模型任务。
- [x] 浏览器 fixture 测默认入口、类型/状态/搜索、详情返回、添加 MCP/市场、移除影响、冲突/unknown/部分失败；真实点击与截图由 Task 6 汇总。

### Task 3: 正文解析与声明式富内容

**Files:** 创建 `richContent.ts`、`RichMessage.tsx`、`richContent.css`、`catalogs/richContent.ts`、`tests/rich-content.test.ts` 和 UI fixture；主代理修改 Conversation 接入。

**Interfaces:** `parseRichContent(text,streaming?)` 返回有类型分段；`RichMessage` 接受现有 MarkdownView 展示 props，并加 `threadId,itemId,onDraft?`。`RichPreview` 由 Task 4 提供，props 为 `{threadId,itemId,index,path,title?,mode?,live?}`。

- [x] RED→GREEN 测正文顺序、多引用、代码围栏/行内代码、流式未闭合/损坏 JSON、8 KiB/4096 bytes/200 chars 上限、未知 PUA 与隐藏收据不吞正文。
- [x] 实现 visualize/inline/live 的验证与预览入口、文件/产物/旧式行引用、code-comment、writing、task-stub、artifact-template、github-details、Pages 的展示或有原因降级。
- [x] 隐藏控制指令只作状态/原文查看，不能触发归档/Git/安装。来源元数据缺失的 cite/entity/map 等卡片明确未解析，不猜 URL。
- [x] 原文/复制保留；复用安全 Markdown/文件链接。task-stub 和 follow-up 仅经用户动作写入可审阅草稿。
- [x] 运行 `node --test tests/rich-content.test.ts`，预期所有协议边界用例通过；随后执行类型检查。

### Task 4: 授权快照与隔离预览

**Files:** 创建 `src/server/rich-preview.ts`、`src/web/RichPreview.tsx`、必要的固定运行时资源和 `tests/rich-preview.test.ts`；修改 `src/server/api.ts`、`app.ts` 与 `src/projects.ts` 的有界读取。

**Interfaces:** 会话绑定的 snapshot 请求仅接受正文路径；返回完整 UTF-8 源码、摘要及身份。用户打开后加载受认证固定 outer shell，inner srcdoc 执行片段；preview shell 的策略不被全局 CSP 覆盖。

- [x] RED→GREEN 测路径纯字符串预检、UNC/协议/根外/敏感/链接拒绝、超限/二进制/读取期间增长、完整快照与摘要，错误不得执行。
- [x] 复用 boundProject/readReportFile，读取后再次硬性检查字节数；不依赖预览截断文本，不增加任意路径读取。
- [ ] outer 固定 shell 与 inner sandbox 分离，父 CSP `frame-src 'none'`、子 CSP 禁止网络；完整网络策略必须有受验证浏览器能力。未经验证的浏览器 fail closed 源码降级。
- [ ] 固定主题、静态 Lucide 与普通脚本运行合同；状态/尺寸/草稿消息验证 source、窗口、身份、类型和大小，卸载释放；同消息多引用和内容变化不串状态。
- [ ] 恶意导航/请求测试使用假 API 计数，不触及真实管理端点；自导航、本站/外站、重定向、伪造消息与跨会话状态必须有实际 Chrome 证据。

### Task 5: 工具结果富内容与既有图片回归

**Files:** 创建有界工具内容展示组件/测试；修改 Conversation 的 Step 分派；复用 NativeImages 和授权图片 API。

**Interfaces:** 严格区别 MCP content、dynamic `inputText/inputImage/inputAudio` 与兼容 `input_text/input_image/input_audio`；传入现有 thread/turn/item 身份，不能从纯资源 ID 构造链接。

- [x] RED→GREEN 测文本/结构化数据、音频 MIME/上限、资源描述、缺字段/旧历史/未知类型；保留原始 JSON 详情且不把工具文本升级成正文执行入口。
- [x] 已验证且有界音频支持用户显式播放；不可信 URI、缺宿主的 widget、实时音频仅明确降级。工具 `_meta` 不赋予 API 或自动轮次能力。
- [x] 回归 imageGeneration/result、imageView 项目内路径和 MCP/data 图片通路；fileId/远程形态保留明确缺预览说明。

### Task 6: 集成、浏览器验收和交付收据

**Files:** 集成共享入口/翻译，更新 spec 状态与本计划进度；提交简洁验收收据，测试 fixture 与截图按需放 `.local/extensions/`。

- [x] 运行新增测试、受影响原有测试、`npm run build`。基线全量测试已出现 Windows 托管启动测试失败，保留原始日志，先区分环境/既有失败，不以新增代码覆盖其原因。
- [x] 用 Playwright/Chrome 走设置与消息入口；桌面/390px，中英文、键盘/焦点/Esc、触控、长路径、对齐与截图；检查控制台错误。Browser plugin skill 未安装，使用现有 Playwright。
- [x] 真实 CLI/认证写操作只用隔离 fixture/CODEX_HOME；账号/策略限制、未测平台、unsupported 与安全静态降级逐项列出。交互未通过不得宣称 visualize 完整验收。
- [x] 新鲜独立 reviewer 检查整个变更与 spec；修复重要问题并重跑相关验证。最终将本次提交 squash 为一个中文提交，保留中间说明；不推送、不发布、不重启运行服务。

## 执行状态

- [x] 只读研究：管理支持路径与隔离预览候选方案已保存根 checkout `.local/extensions-management-capabilities.md`、`.local/extensions-preview-boundary.md`。
- [x] 隔离分支已创建，尚无生产实现改动；起点 `b20533d`。
- [x] Task 1/2：支持路径的适配/API/管理页已落地并通过fixture验证；直接技能文件CRUD曾被自动审批阻止，用户随后明确追加授权后已实现；原生工作流入口不计作CRUD。
- [x] Task 3/5：正文与工具内容适配、草稿/复制、授权引用和明确宿主降级已落地。
- [x] Task 4：完整有界快照与源码降级已落地；路径/认证/链接边界4/4验证。
- [ ] Task 4交互门槛：Chrome156的Connection-Allowlist与活动RTC复现页面崩溃，保守源码降级；不启用未验证脚本、widget桥或Lucide stub。
- [x] Task 6已执行部分：最终完整测试908总/903pass/0fail/0cancelled/5skip；build通过；富内容4/4、会话4/4、管理8/8及既有Markdown两viewport浏览器回归，截图已查看。
- [x] 最终独立 review：市场路径、安装策略、代码围栏及追加技能两项安全发现已修复，定向红绿/受影响浏览器通过。
- [x] 最后完整验证：4 worker 全量908总/903pass/0fail/0cancelled/5skip，build与浏览器矩阵通过；收据保留原始超时及其独立复测分母；后续正文定向21/21、全新cwd管理23/23、旧UI87/87及200%布局定向11/11通过。
- [x] 中文单提交收口；最终提交保留完整实施说明，不推送/发布/重启。
