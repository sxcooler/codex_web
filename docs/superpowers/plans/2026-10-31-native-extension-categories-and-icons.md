# 本机原生扩展分类与图标修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 原生字段、真实读取与界面验收分别记录，不能用固定数字替代分类。

**Goal:** 修正五类管理列表，按用户本机截图核对插件 10、应用 11、MCP 4、技能 1、市场 2，并修复真实原生图标全部为空。

**Architecture:** 原始库存和写前身份核对保留，管理页单独按类别选择，列表/徽章/搜索/详情使用一致规则。图标消费真实 native logo/URL，并优先使用已核实缓存中的包图标；不新增图标代理或放宽任意外站图片。

**Tech Stack:** TypeScript、React、Node test、Playwright、现有 sharp。

**Spec:** `docs/design/2026-10-28-extensions-and-rich-content.arch.md` 第 16 节。

## Global Constraints

- 基线 b9eece8，隔离 `.worktrees/native-extensions-parity-20261031`；保留已有原始 4K 文件改动。
- 不删除插件、集成、技能或市场，不调用真实写操作/模型任务，不重启正式服务。
- 本机截图为验收快照，数量随配置改变；不硬编码数字或按显示名模糊排除。
- 图标仅允许原生提供的本地资产、已校验包缓存及精确 `https://files.openai.com`；签名 query 不日志落盘、不发给其他主机；其他 CSP 保持。
- 未读取/首读失败/unsupported 不冒充成功空库存；推荐技能目录失败不得阻塞无关写结果对账。
- 一个中文需求提交，统一构建并同步 dist。

## Review Focus

- 内部运行时、隐式应用包装与用户可管理插件区分；不能删掉所属能力。
- Apps callable 与 enabled/授权/连接区分；配置 MCP 与运行时桥区分。
- 推荐目录缺失时技能数未知，不能让原生配置写对账永久锁定。
- 缓存目录有多个版本、manifest 身份不符、路径链接逃逸及 SVG 外部资源均安全降级。
- 原生图标 URL 的签名有效性、Cloudflare 拦截、本地兜底与浏览器真实加载分别验证。

## Task 1：分类、数量与能力入口

- [x] adapter 保留 installPolicySource、configured、recommended 等白名单分类证据。
- [x] 用户管理插件不列 bundled、primary-runtime 与隐式 canonical App 包装；App 只计 callable；MCP 只计配置定义。
- [x] 独立用户技能按 name 去重，排除插件所属、系统及推荐技能；市场只计配置定义并排内建来源。
- [x] 首屏独立加载市场，计数保留未知/partial/stale；可见插件的所属能力继续可从详情访问。
- [x] RED→GREEN 回归选择、计数、迟到详情、未知写结果锁及分节失效。

## Task 2：推荐技能匹配

- [x] 固定读取 `$CODEX_HOME/vendor_imports/skills-curated-cache.json`，2 MiB 有界句柄读取及结构校验。
- [x] 根据 ID/name/路径目录及 displayName 规范化匹配；空目录与缺失/损坏区分，不硬编码 Playwright。
- [x] 单元回归 3/3；先缺模块 RED，再实现 GREEN。

## Task 3：真实图标

- [x] 当前深色页按 logoDark/logoUrlDark/logo/logoUrl 顺序候选；URL仅精确 provider 且保留签名参数。
- [x] 本地 PNG/JPEG/WebP/GIF/SVG 有界读入、限制像素并规范化 96px PNG；禁止 SVG 外部资源及脚本。
- [x] 通过原生 market/name/version 核对缓存包；未提供版本时仅接受唯一候选且 manifest 身份完全匹配，不猜最新。
- [x] 包内路径、文件身份、读前后变化、输入/输出预算和多版本歧义 RED→GREEN。
- [x] 浏览器生产 CSP、图片 naturalWidth 及失效 src 恢复验证。

## Task 4：真实数据、联合验收与交付

- [x] 使用自有临时 AppServer 只读目录核对五类结果与十个品牌图标，不影响运行服务。
- [x] 完整 Node、相关浏览器、桌面/窄屏中英/键盘/截图、构建及独立审查。
- [x] 记录结果与限制，单中文提交交付并更新 dist；不重启正式服务。

## 已有取证

- 当前官方 App 26.1027.3384.0，随附 CLI 0.166.0-alpha.5.1；Web 独立 CLI 0.166.0。两种自有诊断进程均已关闭，读取目录均为 26 插件，没有因切换 binary 消失。
- 原生 26 插件中 bundled 6、primary-runtime 5、IMPLICIT_CANONICAL_APP 5，剩 10 与用户截图逐项对应。官方 renderer 另有账号内存态动态 hidden_plugin_ids，当前值禁用持久缓存，未读取进程内存；本轮不声称复制全部私有 gate，仅实现用户指定的本机管理列表口径。
- Apps 12 中 callable 11；Pets enabled=false/callable=false。MCP 运行时 9，配置定义 4；Web 原先只隐藏 2 个 bundled，故错误显示 7。
- 原生技能 94＝87 插件所属、2 独立 user、5 system；本机推荐缓存 39 项包含 Playwright，按匹配排除后独立用户技能 1。市场配置键 4，排内建 bundled/primary 后为 2。
- 13 remote 的本地 logo 显式 null，而 signed logoUrl 有值；7 PNG 在旧 cache 根外，3 SVG 被拒，Ponytail 567655 B 超旧 256 KiB。全部 26 null 得到解释，不能把三张手动 cache PNG 可读升级为原生显示成功。
- 三个代表 remote URL 的只读 GET 均 403，无跳转；Superpowers 有 cloudflare/challenge 证据，无签名过期证据。没有更改 Cookie、凭据或重放挑战。
- 每个 remote 包在本机 cache 都只有一个版本且 manifest 身份匹配；Context7 原生 name 与 cache 目录均 app-69ef18c674308191a2f952431f91ea61，不靠显示名猜测。
- 初始三次沙箱自有进程在 initialize 前失败，未发送目录 RPC；正常权限下 PID14196/8788/27080 的只读诊断成功且已关闭。失败分母不覆盖为成功。

## 最终验证（2026-10-31）

- 真实 adapter 最终读取约 1.11 秒，原始 plugins 26、Apps 12、MCP runtime 7、MCP definitions 4、skills 21、CLI markets 5；管理选择结果为 **10/11/4/1/2**。技能 21 是服务 WORK_ROOT 下该次读取，不把另一 cwd 的 94 当同一库存。十个目标插件均输出有效 PNG（64–96px），诊断进程 finally 关闭。
- 全仓 Node 最终 **1025 项：1020 通过、5 跳过、0 失败**。此前全仓 1023 项为 1018 通过、5 跳过；新增两个 MCP 证据/合并回归后重新执行全仓。
- 设置与国际化浏览器 **79/79**；开发插件 **24/24**；生产 dist + 真实 buildServer CSP 插件 **24/24**；脱敏本机快照在生产 **4/4**，覆盖 1440/390、中英文、五类 Tab/Enter 与详情返回焦点。十张真实品牌图逐一滚动检查 naturalWidth>0，无账号写请求或页面异常，六张截图已查看。
- 图标恢复回归覆盖坏 HTTP→有效 HTTPS 及 data PNG。生产首轮 23/24，发现测试误用 files.oaiusercontent.com，被精确 CSP 正确拒绝；fixture 改为真实 files.openai.com 后 24/24，没有扩大 CSP。
- 独立审查发现并修复搜索遗漏 policy、同名技能详情关闭、MCP 状态失败时定义数未知、显式 MCP 被插件 overlay 覆盖、绝对路径绕过 cacheIdentity；随后补上定义未读不冒充 0、成功空定义清除旧 configured membership 两个回归，均先 RED 后 GREEN。
- 前期相关 Node 20/24、51/55，浏览器 16/20、21/22 的失败分别为新规则/fixture、推荐目录耦合、沙箱 junction 权限与 owned 返回守卫，已修复并复测；首个真实 adapter Apps 10（primary 所属 App 被误隐藏）和插件 source count 66（并发误取全部 items）均保留失败记录，最终为 Apps 11 / plugins source 26。
- 首次设置浏览器启动因 4178 被占用而未执行测试，改独立 4191；生产 harness 首次 cwd 错误未执行测试，修配置后运行。真实快照开发 harness 首轮四例误记同源 favicon 为外部品牌请求，后续扫描临时 tmp 又遇 ENOENT；隔离 testDir 后 4/4。这些均不计作产品通过。
- 构建、类型与 diff 检查通过；入口 `index-DDoynYJO.js`、样式 `index-C4JGJXDC.css`。构建仍有已有的大 chunk 提示，未扩展到拆包优化。
- 证据保存在工作区忽略目录 `.local/visibility-icons-20261031/` 及隔离工作树 `.local/verification/`、`.local/extensions-real/`。无签名 URL 落盘，真实账号写入和正式服务重启未执行；Superpowers 原品牌黑图在暗底对比偏低，未篡改品牌色。
