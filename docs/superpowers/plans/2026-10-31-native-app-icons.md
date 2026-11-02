# 补齐原生应用品牌图标

**Goal:** 修复应用适配把图标写死为 null 的遗漏，保留原生品牌图和失败兜底；五类数量仍为本机快照的 10/11/4/1/2，不改应用可用性、授权或安装状态。

**Baseline:** `35d2a95`，复用干净隔离工作树，分支 `fix/native-app-icons-20261031`。本轮一个中文提交，构建并同步 dist；不重启正式服务，不调用真实写操作。

**Scope:** `extension-icons.ts`、`extensions.ts`、服务器图片 CSP、`extensionsState.ts`、`InstalledPlugins.tsx`、相关 Node/浏览器回归及 spec。无新依赖、图标代理、品牌名黑白名单或额外原生目录 RPC。

## 已确认根因与外部边界

- 原生 `app/read` 提供 `iconUrl/iconUrlDark`，当前适配却写死 `iconUrl:null`；旧 `app/list` 的 `logoUrl/logoUrlDark` 兼容入口也遗漏。
- 11 个 callable 应用中 6 个有品牌图：Hugging Face、Context7、Sites、OpenAI Platform、GitHub、ChatGPT Space；5 个原生字段为空，不猜品牌。Pets 非 callable，仍不计入应用列表。
- 原生 renderer 的应用行优先主题匹配远端图，再已知应用图，最后通用占位。已知表仅可解释 GitHub/Sites，不能把其余图声称为原生内置 fallback。
- 独立无头 Edge 实测 Hugging Face/Context7 为 200 PNG，各 256×256。其余四个 chatgpt.com 静态图响应 Cloudflare 403/challenge 和 CORP same-origin，浏览器报 `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`。Node 直连的两张 files 图也曾 403、chatgpt 静态图超时；使用现有系统代理后 files 200，但 chatgpt 仍 challenge。这些不是 CSP 或授权状态的成功证据。
- 不绕过挑战、不自动操作账号。远端失败时仅复用原生元数据明确归属的、唯一已安装插件品牌 PNG；当前六品牌都有远端或可信包内资产可用。OpenAI Platform 的插件兜底来自 OpenAI Developers，允许其自带蓝色背景，不冒称为原生远端黑白图。

## 实施与验证

- [x] App 字段接线，深色优先、无效时浅色回退；现代与旧版入口均覆盖。
- [x] URL 仅 HTTPS files.openai.com 以及 chatgpt.com 下固定应用图路径，拒绝显式端口、userinfo、其他主机/路径及控制符。插件 URL 白名单不扩大，CSP 仅图片增加 chatgpt.com。
- [x] UI 仅在 App 原生图非空、ownerNames 恰好一个、精确 displayName 唯一已安装插件且其图为规范化 data PNG 时允许兜底；使用 raw snapshot，含隐藏父插件。零/多归属及原生无图不猜。
- [x] 仅尝试远端→归属 PNG→既有占位一次；图片 key 包含原生和兜底源，迟到缓存及歧义变化重算；不替换行/按钮，保留焦点。
- [x] Node RED→GREEN、实际远端与兜底分别验收；生产 CSP 下桌面/390、中英、分类数量、键盘及截图。
- [x] 构建、独立审查、一个中文提交、主分支集成与 dist 哈希同步；记录未测范围。

## 执行结果

- 后端新增三条 RED 覆盖现代/旧版字段和 CSP 缺失，修后相关 Node 28/28；前端先复现 helper 缺失和远端 403 后仍 hidden，再完成 Node 13/13 与开发浏览器 26/26。
- 生产 dist 的相同浏览器回归 **26/26**。覆盖唯一归属→重名撤销、迟到 owner 资产、坏 PNG 终态占位且不循环、新原生 URL 恢复优先与详情/焦点；未改变分类数量或写操作。
- 自有临时原生进程只读六类来源、finally 关闭。真实库存的五类选择仍 **10/11/4/1/2**；6 个可用 App 图标字段均保留。原生数据仅在内存交给浏览器 API fixture，不持久化签名 URL。
- 生产代码 buildServer/CSP 的临时服务、独立无头 Edge 的 **1440/390 × 中英四组 4/4**：每组六图 naturalWidth>0、可见；Hugging Face/Context7 远端 200 PNG 256×256，Sites 归属 PNG 48×48、OpenAI Platform/GitHub 96×96、ChatGPT Space 60×60。每组另外四个远端均被 challenge/CORP 阻断，已分别记录，未当作远端成功。
- 五类 Tab/Enter、App 详情返回焦点通过；0 pageerror、0 action 写请求；桌面/窄屏含底部截图已查看。原生无图的五个应用保持现有字母占位，本轮未改造通用占位或长描述换行。
- 构建、类型检查、diff 检查和独立只读审查通过。入口 `index-hvRJl-Ge.js`，样式 `index-C4JGJXDC.css`；既有大 chunk 提示未扩展到拆包优化。
- 首次全仓 1029 项中 1023 通过、5 跳过、1 个既有进程强制关闭测试超时；独立复测该文件 **29/29**，未修改进程管理代码或放宽超时。随后 `node --test --test-concurrency=4 tests/*.test.ts` 全仓 **1029 项：1024 通过、5 跳过、0 失败**，保留首次失败分母。

临时探针和脱敏证据位于主工作区忽略目录 `.local/app-icons-20261031/`，测试日志位于工作树 `.local/verification/app-icons-*`，真实 UI 截图位于系统临时目录 `codex-web-app-icons-20261031/`；签名 URL 不写入诊断文件，浏览器凭据不落盘。
