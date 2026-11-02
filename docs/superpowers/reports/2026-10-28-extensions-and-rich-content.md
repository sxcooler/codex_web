# 插件与集成、富内容展示实施收据

用户授权：先落 plan 然后实施；`retry` 按接续处理。计划为 `docs/superpowers/plans/2026-10-28-extensions-and-rich-content.md`，规格为 `docs/design/2026-10-28-extensions-and-rich-content.arch.md`。

实施位于 `feature/extensions-rich-content-20261028` 隔离分支，基线 `b20533d`。没有新增依赖、安装真实插件、变更用户账号/原生配置、运行模型、推送、发布或重启实际 Web。

## 已落地

- 统一插件与集成页：已安装优先、owner/类型/状态/搜索、详情返回、发现与来源管理；稳定 CLI/有限原生 RPC 的管理适配，CAS、受管拒绝、秘密保留、未知结果不重放与读回。技能文件有读取、创建、覆盖、本地导入与非递归移除；MCP 有默认及逐工具审批、输出上限、HTTP 环境 Header/Bearer 引用和插件所属策略。工具/资源/模板展示有界名称与说明，owner 可返回所属插件。CLI JSON 字段按官方 `rust-v0.164.0` 源码及隔离 CODEX_HOME 的只读 list 核对，未调用生产禁用的四个插件 RPC。
- 正文分段与卡片：文件/产物引用、审查、写作、任务建议、模板、折叠、Pages 与控制/记忆收据；代码示例不升级能力，未知私有引用不猜 URL，复制保留原文。任务建议保留已有草稿且限定总长 12000 字符；超限反馈由 SessionView 确认。
- 工具文本/结构化结果、音频 MIME/头部/大小校验、资源与 widget 说明；工具正文不进入正文执行解析，图片仍走原有认证加载。
- HTML 只提供经会话授权的完整快照源码、摘要、时间与重试/复制，不执行不可信脚本；有界读取同时检查读取前与读取后的大小。
- 共用代码块增加块级布局，修复 header/复制/正文被默认 flex 横排压缩的问题。1280px 正文占代码块 97.7%，390px 占 93.4%；实际复制、横向滚动与可见焦点回归。

## 验证记录

| 验证 | 实际结果与范围 |
| --- | --- |
| `node --test --test-concurrency=4 tests/*.test.ts` | 冻结代码最终完整 908 tests：903 pass，0 fail，0 cancelled，5 skipped，84.0 秒；保留跳过分母 |
| `npm run build` | TypeScript 与 Vite 构建通过；仍有现有大 chunk 提示，没有为了本需求引入构建重构 |
| `tests/rich-content.browser.mjs` | Chrome，中英 × 1280/390，共 4/4；卡片、复制失败/重试、代码保护、被动请求为 0，截图已查看 |
| `tests/extensions.spec.ts` | Playwright 8/8；实际设置入口、默认已安装、筛选/详情、表单/确认、冲突/unknown、MCP 策略、技能文件 CRUD/导入与键盘；Edge 桌面/窄屏及中英截图已查看 |
| `tests/rich-session.browser.mjs` | 实际 SessionView/Conversation，四矩阵 4/4；草稿不发送/不覆盖、跨会话拒绝、预览按需读取/源码/复制/重试/关闭、工具说明、焦点/间距与代码块布局，截图已查看 |
| `tests/markdown-images.browser.mjs` | 1280/390 均通过：既有 Markdown、HTML 图片、流式、文档链接、图片失败/权限、代码高亮/复制与缓存 |
| `tests/rich-preview.test.ts` | 4/4：路径预检、完整快照、二进制/超限拒绝、认证/CSRF、项目绑定/敏感文件/junction 越界与请求 schema |

Browser plugin skill 不在本次可用清单，会话与 Markdown 使用已有 Playwright/Chrome，管理页沿用项目 Edge 配置。最初 localhost 测试被沙箱网络限制拒绝，获准仅测试假服务的重跑通过。图像、身份与授权数据均为 fixture，没有拿用户任务当成功分母。图片、UI 渲染和 Node 测试分别留证，不互相替代。

过程分母保留：较早完整一轮 888 tests 为 882 pass / 0 fail / 6 skipped；追加技能后默认高并发一轮 908 tests 为 902 pass / 0 fail / 1 cancelled / 5 skipped，其中未修改的后台启动用例超时 45 秒。该文件独立重跑 4/4 通过，再以 4 worker 完整重跑得到上表最终结果，没有修改用例或放大超时。最初沙箱基线的临时 Git/junction/本地子进程权限失败也单独留在 baseline 日志，不与代码失败混淆。

完整套件后补充了空 structuredContent 不生成空工具面板的 RED→GREEN；末次正文/工具/草稿定向 21/21 和真实会话四矩阵 4/4 通过。新测试的 scratch 目录显式初始化，三组管理/技能测试从全新临时 cwd 独立运行也为 23/23，通过结果不依赖开发机已有 .local。

旧插件页的四组 browser spec 已同步到新快照，保留 dirty navigation、读取失败保留列表和时间、unsupported/partial/空列表、语言切换及独立滚动检查，共 87/87 通过。真实截图发现的 390px@200% 筛选/名称挤压，先以 56.25px 筛选宽度观察 RED，再用最小 flex-wrap 修复；受影响管理/i18n 定向 11/11，筛选宽至少 100px、列表主列占整行并保留可见焦点，7 张中英桌面/窄屏/放大截图已查看。

本地辅助证据位于 `.local/extensions/`：`verified-full-tests.log`、`final-full-tests.log`、`background-isolated.log`、`final-build.log`、`markdown-browser.log`、`rich-content-report.md`、`management-report.md`、`session-qa-report.md` 和各 viewport 截图。这些路径相对于实施工作树；从主 checkout 查看时位于 .worktrees/extensions-rich-content-20261028/.local/extensions/。它们为忽略文件，本报告保留必要结论；可复跑的测试 fixture 已随代码提交。

## 未通过的交互门槛

生产组件只显示源码。候选固定 outer shell → sandboxed srcdoc 的实验中，普通按钮脚本/DOM 与受测 HTTP/导航拦截通过；这不是完整网络隔离成功。

- 默认 Chrome `156.0.8078.48`，没有实验 flag，`HTMLIFrameElement.prototype` 没有 `connectionAllowlist` 属性。
- 无 Connection-Allowlist 的对照真实发出 4 个 UDP STUN 包；加 header 的零包结果随后证实对应 renderer/page crash，**不记为成功阻断**。
- 分阶段重测 constructor、data channel、offer 和立即 close 均没有可区分的策略异常；保持嵌套 RTC 活动可复现 header 组崩溃。不能把 constructor 或 UA 当可靠能力证明。
- DNS 没有独立受控抓包，固定 Floating UI/Lucide 文件未内嵌，widget 状态/尺寸/桥没有生产实现。没有启用未来开关、没有伪造图标 stub，也没有保留无消费者的预览 shell。

实验详情和纠正收据在 `.local/extensions/preview-proof.md`、`preview-rtc-constructor.json`。临时浏览器/HTTP/UDP 均已关闭。规格第 5.4 节的失败关闭规则已执行；完整 visualize 交互验收仍未通过。

## 追加授权、文件能力及宿主限制

直接技能文件创建/覆盖/删除的补丁被自动审批拒绝；理由为“超出已授权的原生技能工作流限制”，并含“不可轻易恢复的删除副作用”。首次补丁未应用，未触碰用户技能目录。用户随后明确追加授权：“自动审批拒绝了直接创建、覆盖和删除本地技能文件的能力，我授权”。已据此接入受限用户/项目技能文件能力，相关测试 59/59、最后定向 23/23，管理浏览器 8/8。首次创建的 wx 独占与新增技能元数据检查各经历 RED→GREEN，并经独立定向复核；原生工作流草稿不计作文件 CRUD。

插件分享/发布、完整账号连接/断开、在线 Pages/Gallery/widget 和 realtime 没有在本次核实到完整稳定宿主合同；保留具体降级，不根据 schema 猜新接口。技能根由服务器推导为 configurationHome()/skills 与授权 cwd/.agents/skills；legacy 项目目录只按原生元数据绑定。仅操作 SKILL.md；已有额外资源的目录拒绝移除，不递归删除。每次编辑/移除校验文件摘要并串行化本进程操作；外部编辑器仍可在最终检查与 rename/unlink 间竞争，因此 UI 明确提示避免同步编辑，不能宣称跨进程原子 CAS。真实安装/卸载/OAuth、声卡播放、其他浏览器与运行服务重启后生效均未验证。

## 实施判断

- 原始消息、工具收据与既有配置来源保持；派生展示不能触发 Git、归档、安装或自动模型轮次。
- 配置整单项用 replace，但先保留原用户项中未改的秘密/未知字段；Upsert 对 table 递归合并，不能用于删除旧传输字段。这一点有独立 transport-switch RED→GREEN。
- 独立全变更 review 的市场路径、服务端安装策略、嵌套代码保护三项 Important 已修复；追加技能 review 的独占创建和最小元数据验证两项也已修复。原始复现与修复后测试分开记录，不改写首次发现；定向复核没有新增 Important。
- 对宿主和安全能力的缺口继续可见；本次是支持路径落地及明确降级，不能宣称整份规格或交互功能已全部验收。
