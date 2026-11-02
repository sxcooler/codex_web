# 重启、导航与插件页调整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 按任务核对实际证据，不将工具发现视为功能成功。

**Goal:** 手动重启等待改为 5 秒，新任务/设置使用链接，插件页仿照用户提供的官方 App 排版并隐藏 bundled 内容，核实 MCP 失败。

**Architecture:** 保留现有重启 worker、二次活动检查和扩展分节读取/写前核对。只调整手动调用参数、导航元素和扩展呈现；MCP 原始失败不改写为成功。

**Tech Stack:** TypeScript、React、PowerShell、Node test、Playwright。

**Spec:** `docs/design/2026-10-28-extensions-and-rich-content.arch.md` 第 15 节。

## Global Constraints

- 手动 Web 重启在桌面预检成功后等待 5 秒；Codex 直接调用脚本仍默认等待 90 秒；本轮不实际重启服务。
- 保留停止前活动检查、受管进程身份检查和失败关闭；后台 helper 使用 Hidden。
- 新任务/设置是带真实 href 的链接，保留浏览器新标签与修饰键行为；退出保持按钮。
- openai-bundled 仅隐藏展示，不删除插件、配置或执行能力；未知/冲突归属不冒充已确认。
- 按官方截图使用分类标签、搜索和紧凑列表；状态/权限/错误、分页和缓存语义沿用现有实现。
- 使用中文提交消息；本次完成后仅一个需求提交；不提交临时结果或凭据。

## Review Focus

- 正常/强制手动重启都传 5 秒，脚本默认 90 秒；检查路径不触发真实重启。
- Ctrl/Meta/Shift/中键不被站内导航劫持；窄屏抽屉和键盘焦点保持正常。
- bundled 来源、owner、同名冲突及混合 owner 不错误隐藏第三方内容；计数/搜索/详情保持一致。
- 未知 enabled、原生只读、加载失败不得显示可用的假开关；局部错误仍可重试。
- MCP 超时可有部分效果，原始失败和后验状态分开记录，不自动重放有副作用调用。

## Task 1：重启时间线和导航链接

**Files:** `src/server/restart.ts`、`scripts/windows/restart-server.ps1`、`src/web/main.tsx`、`src/web/PaneLayout.tsx`、相关文案/样式及测试。

- [x] 以 launcher stub 验证普通/强制 Web 调用均显式传 `-DelaySeconds 5`；先观察失败再修复。
- [x] 脚本允许最短 5 秒，保留默认 90 秒；确认立即启动的任务是预检，真正停止发生在到期 worker 中。
- [x] 新任务/设置改为 href 链接，仅普通单击接管；覆盖原生新标签、历史导航及抽屉焦点。
- [x] 运行 restart 单元测试、Windows 临时 fixture 和相关浏览器测试，禁止调用实际服务重启。

## Task 2：官方插件布局和 bundled 过滤

**Files:** `src/web/InstalledPlugins.tsx`、扩展组件/状态、扩展来源映射、`src/web/style.css`、扩展文案及测试。

- [x] 精确来源/owner 过滤先覆盖正常、bundled、未知、重名与混合归属。
- [x] 依截图实现标题/副标题、浏览目录/添加、分类数量标签、搜索及统一列表；保留现有操作入口和诊断。
- [x] 仅有可写能力与真实 enabled 证据才提供开关；保留未知/只读原因。
- [x] 跑相关 Node/API 与浏览器回归；截图比较 1440/390、中英文、200% 和键盘操作。

## Task 3：MCP 原始结果与健康检查

**Files:** 不修改产品状态映射；只在本计划记录脱敏证据。

- [x] 原始 rollout 核对两次 `cua_repl/js`：均为 failed/isError，另区分后续点击超时但实际生效。
- [x] 检查 Runtime → tool status → rich content → ToolContent：说明文档是同一错误结果的文本块，不是第二条失败。
- [x] 对当前代码索引、Node REPL、Context7、GitHub、CUA 和 Playwright 做最小只读检查，逐项标记实际结果和限制。

## Task 4：联合验收与交付

- [x] 核对共享样式/国际化及调用者，无关工作树不改动。
- [x] 完整 Node 回归、目标浏览器回归、构建、截图检查和独立代码审查。
- [x] 更新本规格与结果；以一个中文提交交付主目录，采用同源码构建 dist。
- [x] 报告未验证项；本轮不重启用户服务。

## 执行记录

- 基线：`aa295bc`；隔离工作树 `.worktrees/ui-restart-mcp-20261030`。初次创建遭 sandbox Git lock 限制，授权提升后创建成功。
- 原始 MCP 证据：调用 `call_ae07e69e24c0424594c912e1da06c2e2`（北京时间 12:40:43—12:41:17，34.1165 秒）超时重置；`call_03c1e99dfce848cf918c78dc42174be9`（12:41:48—12:42:14，26.6606 秒）Debugger unattached。后者含错误文本及约 30KB 说明文档两块内容。
- 初次沙箱全量基线出现文件/子进程相关失败，保留其分母和最终结果，后续使用可写 TEMP/TMP 与隔离测试验证；未把环境失败算成通过。
- 自动审批拒绝导航 Playwright 现有 Welcome 页，未继续导航该页。CUA 原连接 id 1 已失效，库存显示当前 id 2，重新选择后新建空白临时页 DOM 读取成功。data 协议检测页被 URL 策略拒绝，未绕过协议限制；后续只用受控 HTTP(S) 页面。
- 本地预览 HTTP 在 CUA 通路超时，后改为已有受信 Web 地址：专用页 DOM 和小图截图成功；独立 Playwright 新建临时页读取新任务标题成功。Node REPL 常量计算、codebase-memory 实际搜索/片段、Context7 库识别、GitHub 公共仓库 metadata 成功。Native desktop pipe unavailable 单列未通过；未调用任何有副作用的集成工具。
- 重启相关后端 35/35，导航/抽屉/脏配置核心浏览器 8/8。另一次浏览器 25 项的 2 项新 fixture 缺字段，补齐后相应回归通过。
- 首次非沙箱完整 Node：995 项，989 通过、5 跳过、1 失败（新增图标字段测试在实现修改期间读到旧模块）；不作为最终全绿。沙箱基线及另一次沙箱全量因 loopback/CIM 限制未完成，仅停止已核实自有测试树，未操作实际服务。
- 首次联合浏览器：113 项，106 通过、7 失败。旧插件标题/市场/搜索选择器与重复隐藏标题的 6 项已同步；迟到 detail 及旧搜索同名污染已补 RED→GREEN 回归，待稳定源码下联合复跑。
- 独立审查发现并修复：迟到 bundled 归属须关闭详情；未知 enabled 的详情启停禁用；App.owner 展示名不得当作 pluginId 后缀过滤；已安装归属不受保留搜索库存污染。外站 logo 被生产 CSP 拦截，改用受限缓存内 data PNG，保留 CSP，不新增网络代理。
- 设置/国际化补充复跑 79 项：76 通过、3 失败。旧国际化 fixture 仍返回旧完整快照，改用现有 section fixture；同步分组时间文案；修复来源失败/partial 误显示空列表，保留原失败回归。200% 窄内容区搜索输入仅 75 CSS px 的 RED 已复现，使用容器查询折行操作、隐藏装饰图标后 GREEN，名称可读宽度至少 90 CSS px。
- 最终完整 Node：1002 项，997 通过、5 项平台/发布包检查跳过、0 失败；联合浏览器 8 文件 126/126，覆盖桌面/390、中英文、200%、键盘/修饰键/中键、脏配置、错误/分页/缓存及生产图片 CSP；最终构建与 diff 检查通过。独立审查最终未见遗留高/中问题，其沙箱独立测试 25 项为 23 通过、2 项 junction 创建 EPERM；实际提升权限下安全测试已纳入全绿分母。
- 本机真实图标初查 3 个：2 个可内嵌，Product Design 的 121,628 字节 PNG 因初设 64 KiB 被拒；先补 RED 回归后将单张上限调整为 256 KiB，总量仍为 1 MiB、最多 32 个候选。复查 Build Web Apps 4,049 字节、Product Design 121,628 字节、Superpowers 48,231 字节，3/3 可内嵌；不读取或输出凭据。
- 最终产物入口 `index-BOuZoQRa.js`、样式 `index-C4JGJXDC.css`；截图位于隔离工作树 `.local/extensions/`、`.local/settings/` 与 `.local/web/`，已实际查看。标准桌面/窄屏布局仿照参考；极窄 200% 只调整插件内容区，既有全局顶栏/侧栏缩放问题不扩大为本轮全局修复。
- 未执行真实服务重启、真实账号配置写入、Git fetch 或模型任务；5 秒参数及新图标后端需加载新代码后生效，首次仍由旧后端发起的手动重启可能沿用 90 秒。MCP smoke 不保证间歇性超时永久消失；原生桌面 pipe unavailable 保留为未通过。
