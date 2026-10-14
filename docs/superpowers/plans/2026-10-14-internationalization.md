# Codex Web 国际化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 按已确认的推荐方案交付简体中文与英文界面，语言切换只改变展示，不改变会话、请求、权限或原文。

**Architecture:** 两份同步内嵌的类型安全 TypeScript 文案目录，由 React Context 提供语言与展示函数；纯 helper 显式接收 locale。错误保留原 Error/code/status/data，内部长期提示保存语义 descriptor，在渲染时翻译。现有组件结构、业务 effect 和缓存身份不变。

**Tech Stack:** React 19、TypeScript、Vite、原生 Intl、Node test、Playwright；不新增运行依赖。

**Spec:** [国际化架构方案](../../../codex-drive/specs/2026-10-14-internationalization.arch.md)。用户已授权按推荐选项实施并要求先落 plan；本计划先保存，再执行。

## Global Constraints

- 初期 `Locale = 'zh-CN' | 'en'`，`LocalePreference = 'system' | Locale`；默认跟随浏览器，无支持语言时回到 `zh-CN`。
- storage key 固定为 `codex-web:locale:v1`；只存 preference，不存消息、参数、账户或原文。
- 浏览器语言按顺序匹配；`en-*` → `en`，`zh`/`zh-CN`/`zh-SG`/`zh-Hans` 家族 → `zh-CN`；繁体不假装已经支持，继续查找支持项。
- 显式选择立即生效，写后读回；失败保留本标签页临时选择和重试入口。正常标签页接受其他标签页保存的选择；临时未保存选择不会被覆盖。
- 同步更新 html lang/dir，不改变 thread/item/route/Markdown 的 React key，不重挂载应用，不把 locale/t 加入请求、SSE、订阅、计时或业务同步 effect 的依赖。
- 模型、用户问题与选项、命令输出、文件/diff、提交消息、原生模型和插件描述保持原文；复制与下载仍返回原文。
- 日期使用当前浏览器时区；时间单位、倒计时舍入、未知值、额度精确十进制字符串不变；文件排序保留既有固定 Collator。
- 安装和部署脚本保持现有语言及协议边界；本轮不运行真实任务、原生 writer、Tailscale 安装或网络修改。
- 每一实施域先补有意义的失败回归，再实现。完成后汇总一个中文提交；不 squash 前一需求的 `54758aa`。不推送、发布或自动重启后端。

## Review Focus

1. 正在编辑新任务/会话草稿、审批答案或设置草稿时切语言：状态、焦点和未保存保护保持；任务 2/4/5/8 检查。
2. 提交已发出但响应超时，以及历史/SSE 同步中的切换：结果仍待核实、不增加请求、不重发；任务 1/3/4/8 检查。
3. storage 被禁用、读回不一致、跨标签 clear 与临时选择：不假报保存、不循环广播；任务 2/8 检查。
4. memo 历史、Markdown/Mermaid、已展开的预览/命令详情：可见标签更新而原文、滚动和展开状态保留；任务 4/6/8 检查。
5. 原生权限 reason 与宽泛错误 code：不把业务判断或未知错误替换成译文；任务 1/5/7 检查。

## 文件与实施分工

- 主会话：基础层、根入口/登录/Home/侧栏、PaneLayout、账户用量、API 错误及协议兼容、集成与验收。
- 会话域：SessionView、Conversation、TurnOptions、Attachments、Questions、MessageActions、turnActivity、submission、drafts。
- 设置域：Settings（含 BrowserGeneral）、ConfigSettings、InstructionsSettings、InstalledPlugins、WebSettings、Notifications。
- 面板域：GitPanel（含 TestReport）、GitHistory（含 DiffView）、ProjectPicker、PreviewShell、ImagePreview、SourcePreview、Markdown/MarkdownView、MermaidBlock。
- 基础接口落地后，三个组件域可按以上互不重叠的文件范围并行；文案目录分别由各域维护，主会话只汇总入口。子 agent 使用项目指定的 `gpt-6.1-sol`，不操作真实会话，不自行提交。

### Task 1：类型安全目录、展示 descriptor 与格式化

**Files:** 新增 `src/web/i18n/{types,messages,text,errors,format}.ts`，`src/web/i18n/catalogs/{common,app,account,session,settings,panels}.ts`；测试 `tests/i18n.test.ts`、`tests/i18n-format.test.ts`、`tests/i18n-types.ts`、`tests/web-api.test.ts`。

**Interfaces:**
- `Locale`、`LocalePreference`、`MessageSchema<T>`、`UiText = string | Error | LocalizedMessage` 在 `types.ts`。
- 各目录导出 `zh` 与 `en satisfies MessageSchema<typeof zh>`；静态值为 string，动态值为具有相同参数签名的纯函数，参数用 string/number/boolean，不自制模板语法。
- `MessageKey`、`MessageArgs<K>`、`Translator`、`createTranslator(locale)`、`msg(key,...args)` 在 `messages.ts`；后者保存 key/参数，字符串参数可嵌套 UiText，用于错误上下文的完整句子。
- `formatText(value:UiText,locale:Locale):string` 与 `formatDisplayError(error:unknown,locale:Locale):string` 在 `text.ts`/`errors.ts`；仅窄 code allowlist 与客户端 descriptor 可翻译，未知 message 原样保留。
- `formatDateTime(value:number|string,locale,options?)`、`formatNumber(value:number,locale,options?)`、`formatDuration(milliseconds:number,locale)` 在 `format.ts`，无效时间使用未知标签，保留现有时间单位。

- [x] 写失败回归：中文/英文静态及动态文案、缺失 key 防御、嵌套错误按渲染时 locale 更新、英文 0/1/2 复数、无效时间；错误 status/data/partial 和原 message 不变。
- [x] `node --test tests/i18n.test.ts tests/i18n-format.test.ts tests/web-api.test.ts` 确认缺失能力失败，再实现基础目录/展示函数；现有中文 API 错误 message 保留兼容。
- [x] 用 `tests/i18n-types.ts` 的 `@ts-expect-error` 检查不存在 key、错误参数类型、静态 key 传参；单独 tsc 编译该测试（TypeScript 7 的文件参数检查使用 `--ignoreConfig`）并运行应用 `tsc --noEmit`。
- [x] 通过测试后固定接口供后续任务使用；不把目录函数用于业务判断。

### Task 2：语言生命周期与选择入口

**Files:** 新增 `src/web/i18n/locale.ts`、`LocaleProvider.tsx`、`LanguageSelect.tsx`；修改 `main.tsx` 根渲染与登录入口；测试 `tests/locale.test.ts` 与 `tests/internationalization.spec.ts`。

**Interfaces:** `localeKey`、`resolveLocale(preference,languages)`、`readLocalePreference(storage?)`、`writeLocalePreference(preference,storage?)`；`LocaleProvider` 与 `useLocale()` 返回 `{locale,preference,persisted,setPreference,t,text}`；`LanguageSelect` 供登录和浏览器偏好共用。

- [x] 先测语言顺序、繁体 fallback、非法值、读写异常和读回失败；例如 `['zh-TW','en-US'] → en`，不支持列表 → `zh-CN`。
- [x] 在首次 createRoot 前解析初始状态并设置 html lang；Provider 监听 `languagechange`、本 key 的 storage/clear 与同标签 `locale-changed`，清理监听且同步不再写回。
- [x] 三个选择名称按方案：中文“跟随浏览器 / 简体中文 / English”，英文“Browser language / 简体中文 / English”；保存失败保留当前选择、提示和重试保存。
- [x] 浏览器先确认旧实现没有语言选择而失败，再验登录前选择、刷新恢复、双页面同步、保存失败临时选择、清除恢复 system；切换不发送任何业务请求。

### Task 3：根入口、任务创建、侧栏、布局与账户用量

**Files:** 修改 `main.tsx`、`PaneLayout.tsx`、`AccountUsage.tsx`、`accountUsage.ts`、`sessionGroups.ts`；目录 `catalogs/app.ts`、`account.ts`；测试 `tests/account-usage-helpers.test.ts`、`preferences.test.ts`、`session-groups.test.ts` 及任务 8 的浏览器回归。

**Interfaces:** 组件使用 Task 2 Context；长期 error/notice 使用 UiText/`msg`。账户 `balanceText/windowLabel/absoluteTime/countdown` 接受末尾 `locale:Locale='zh-CN'`，计算及精确字符串不变。sessionGroups 只在 UI 按已有空 key 翻译“无项目”，group key/path/items 与默认 helper 行为保留。

- [x] 迁移 Login、Home、SessionGroup/Menu、全局提醒、侧栏范围与空态、PaneToolbar/Separator，以及账户主控件、周期、重置对话框、结果与原生数据旁的标签。
- [x] 先补失败检查：账户大整数/小数不经 Number 损失精度，倒计时不误称已恢复；中英文 Home 草稿、附件和已发提交 intent 在语言切换后保持。
- [x] 在 render 翻译 descriptor；读取与认证/账户 effect、release 重试、身份判断与所有提交参数保持原样，不新增 locale 依赖。
- [x] 单测与对应双语浏览器断言通过。

### Task 4：会话、执行、审批、附件与分支

**Files:** 会话域清单中的 9 个组件/helper 及 `submission.ts`、`drafts.ts`；目录 `catalogs/session.ts`；现有 `turn-activity`、`submission`、`session-sync`、`turn-settings` 单测与 `session-open-recovery`、`session-history-recovery`、`questions`、`message-actions` spec。

**Interfaces:** UiText 可进入 Outgoing.error、Attachment.error、ForkResult.message；纯展示 helper 末尾 locale 默认 zh-CN 或返回 descriptor，原语义算法不依赖翻译。

- [x] 迁移会话状态、历史/通知/占用/发送提示、composer、memo 消息与执行分组、命令详情、审批按钮、问题表单、附件限制/状态、分支反馈与记忆引用标签。
- [x] 不翻译模型问题/选项、原始步骤数据、模型文本、stdout/stderr、引用内容；overload 仍精确匹配 `codexErrorInfo==='serverOverloaded'`。
- [x] 先测语言切换期间保留 outgoing/unknown 状态、输入草稿、审批答案、已载历史、命令展开；GET/history/EventSource 与 POST messages/answer/respond/fork/open 次数不增加。
- [x] memo 消息组件内部消费 Context；elapsed formatter 保留原毫秒/秒转换与计时频率；所有原 effect/key 保持业务身份。
- [x] 单测及关键双语 spec 通过，保留旧中文回归作为明确的 zh-CN 基线。

### Task 5：设置与通知

**Files:** 设置域 6 个文件；目录 `catalogs/settings.ts`；`codex-settings.spec.ts`、`settings-ux.spec.ts`、`settings-restart.spec.ts` 和通知状态回归。

**Interfaces:** 使用 Task 2 LanguageSelect；设置 dirty guard、native payload、section/mode/scope、permission enum 保持原值，error/notice 改 UiText。

- [x] 迁移设置分类、字段/helper、保存与离开保护、指令 diff/返回、插件状态/筛选、Web 路径/诊断/密码/维护说明、通知状态与授权结果；在 Web 浏览器偏好放 LanguageSelect。
- [x] 原生 service tier/plugin name/description 保留原文；`reason === '网络选项仅能在 workspace-write 沙箱下编辑。'` 是现有业务判断，保留原串，展示另作翻译。
- [x] 先测有未保存设置/指令时切语言，内容和 dirty/dialog 不变；不重新发配置 GET、重启预检或通知订阅/权限请求。
- [x] scheduledAt/readAt/lastWriteAt/plugin updatedAt 使用显式 locale 的 formatter；原状态和诊断 JSON 保持原文。
- [x] 中文与英文设置回归通过，focus/beforeunload 与晚到保存结果的行为不变。

### Task 6：项目、Git、预览与 Markdown 控件

**Files:** 面板域 10 个组件；目录 `catalogs/panels.ts`；`preview-header.spec.ts`，现有 git-history、preview-fullscreen、source-preview、image-preview、markdown-images browser fixtures。

**Interfaces:** 使用 Context 与 UiText；图片/文件路径与 Git 信息原样；GitHistory Failure.message、复制 feedback 与面板错误可保存 descriptor。

- [x] 迁移项目选择、tab、fetch/刷新、文件/提交/报告计数、仓库和分支标签、预览导航与全屏/复制、图片状态、源码大文件提示、Markdown 限制与 Mermaid 控件。
- [x] 保留固定文件 Collator、fetch/worker/image 的 effect 与 key、Git/文件内容和原文复制；Markdown AST 限制提示可以重算展示，但不把 locale 加入 Streamdown key。
- [x] 先测切语言后 memo/Mermaid 与复制反馈更新、原文复制相同、预览滚动/展开保持，且不重新 fetch/读取文件；保留 unknown 错误原 message。
- [x] 双语桌面/窄屏与 200% 缩放检查，无水平溢出、遮挡或对话框焦点回退；必要布局修复仅针对实际发现的问题。

### Task 7：稳定错误码与 API 兼容

**Files:** `src/web/api.ts`、`i18n/errors.ts`、`src/server/app.ts`；`tests/web-api.test.ts`、`auth.test.ts`、`api-error-logging.test.ts`。

**Interfaces:** 客户端传输错误附加 `i18n` descriptor，保留现有 Error.message/status/data 与 auth-lost 行为；服务端只补认证、请求验证、NotFound/Internal 等现有通用分支的窄 code，旧 error 字段及状态码不变。

- [x] 先测试读取超时与提交结果待核实在两种语言下不同，HTTP/无效 JSON/断线不隐藏 status/data/partial，不自动重试；raw 未知错误、宽 PROJECT_ERROR/RUNTIME_ERROR 原样。
- [x] 增加明确的认证失败/限流/认证服务忙、请求禁止/未认证、验证失败、路由不存在、内部错误代码；不将一个 HTTP 状态猜成具体故障原因，不改鉴权或日志。
- [x] API 与认证单测通过；locale 不进入服务端缓存 key，不发送用户选择来修改原生 Codex 配置。
- [x] 旧后端无 code 时继续显示原 error；新 code 可在下次安全后端重启后生效，不为文案强制中断活动会话。

### Task 8：完整集成、中文基线与交付

**Files:** `playwright.config.ts`；现有 browser fixtures 的 context locale；`tests/internationalization.spec.ts`、`locale.test.ts`；更新架构状态、文档索引、双语 README/会话或部署指南，新增 `docs/verification/2026-10-14-internationalization.md`。

- [x] 原有中文测试显式固定 `locale:'zh-CN'`，不把名称断言改成宽泛正则；新增英语 navigator/system 和显式 English 选择路径。
- [x] 逐域扫描 UI 字符串并人工区分已迁移标签、原始协议/模型内容与异常 fallback，记录文案清单，不以一次 rg 或 key 数量声称全仓无遗漏。
- [x] 跑 locale/目录/格式化/API 和各域有意义的单测，再跑完整 `npm test`；保留失败、跳过、未执行分母，必要时按实际环境复核。
- [x] 跑双语 mock 真实浏览器回归：保存/跨标签/存储失败/locale switch 请求计数；登录、Home、会话、设置、项目预览的桌面与窄屏可见状态；独立审查与类型/生产构建通过。
- [x] 无可用 Browser 插件时沿用已验证 Chrome/Playwright 路径，隔离 TEMP/cache/输出到 `.local`；不复用真实已登录会话做写入验收。
- [x] 独立构建到 `.local`，保留旧 dist 哈希资源，更新 index 最后，HTTP 核对新旧入口；不重启后端、不重发便携发布包。
- [x] 完成后勾选本 plan，记录实际证据和剩余 raw 错误边界，所有本轮改动汇总一个中文提交。

## 实施结果

2026-10-14 完成。共享基础接口先落地后并行迁移；账户域追加交由面板域完成，主会话整合。最终完整 Node 791 项（786 通过、5 跳过），完整 Chrome/Playwright 179/179，通过应用／类型反例检查及生产构建。独立审查发现的错误码分类、生产 missing-key 诊断与自有属性防御均已修复；早期失败／取消／环境错误保留于[验收记录](../../verification/2026-10-14-internationalization.md)。本机仅更新静态前端，旧资源保留；后端未重启，便携包未重打。所有本轮改动汇总一个中文提交。
