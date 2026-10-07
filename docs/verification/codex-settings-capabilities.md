# Codex 设置 P0 原生能力核对

核对日期：2026-10-07（Asia/Shanghai）。P0 已获授权并在隔离工作树实现，本记录包含原生只读证据及隔离测试验收；尚未上线，真实配置／指令写入和插件工具可用性未验收。

## 环境与探测范围

- 已安装 CLI：`C:/Users/example/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe`，`--version` 返回 `codex-cli 0.159.2`；初始化返回的 userAgent 也包含该版本。Node 为 `v26.2.0`。
- 工作目录：隔离工作树 `C:/Users/example/work/codex_web/.worktrees/codex-settings-p0`。
- 复用 [AppServer](../../src/codex/app-server.ts) 的 `initialize`、`request`、`close`，不连接或重启现有 Web Runtime。初始化使用现有 `experimentalApi: false`，随后发送 `initialized` 通知。
- 请求仅为 `initialize`、`config/read({cwd, includeLayers:true})`、`configRequirements/read({})`、`plugin/installed({cwds:[cwd]})`。未调用 `config/batchWrite`、resume、reload、安装、OAuth、`plugin/list` 或逐插件详情。
- 输出仅包含字段存在性、版本、计数、时间和脱敏错误码。未输出配置值、用户配置文件路径、插件名称、源地址、原生错误正文或 stderr；配置／插件原始响应未保存。

第一次沙箱运行的初始化 codexHome 与主机 `C:/Users/example/.codex` 不一致，虽然读 RPC 成功，返回空配置来源和空市场；这不是主机的空数据证据。随后为独立进程显式设置 `CODEX_HOME=C:/Users/example/.codex`，沙箱内初始化失败（仅记录 `READ_FAILED`）。相同只读命令使用获准的 `require_escalated` 运行成功，并核实初始化 codexHome 与该主机目录一致。下表仅采用此主机核验结果；运行环境失败不能标成 unsupported。

## 当前 CLI 现场结果

主机核验时间：`2026-10-06T19:02:13.023Z`（北京时间 `2026-10-07 03:02:13`）。所有 RPC 和 `close` 成功。

| 能力 | 字段存在性／计数 | P0 结论 |
| --- | --- | --- |
| initialize | userAgent、codexHome、platformFamily、platformOs 均存在；codexHome 与主机匹配 | 可用原生 codexHome 定位个人指令；不退回猜测 HOME |
| config/read | config、origins、layers 均存在；2 层、1 个 user 层；92 个 origins 均带 name 和非空 version | 支持读取分层配置与来源；只向页面投影固定白名单字段 |
| 用户基础层 | 唯一 user 层明确带 `profile:null`，非空 file、version 和 config 存在；选中 profile 层 0、缺 profile 字段的 user 层 0 | 本次可确定用户基础配置目标和版本；版本来自该层，不使用某个有效值的 origin 或客户端生成版本 |
| configRequirements/read | requirements 字段存在，值为 null | 本次没有原生报告的 requirements；不能推广为其他主机／项目没有受管限制 |
| plugin/installed | marketplaces、marketplaceLoadErrors 数组存在；5 个市场、28 个插件，28 个 `installed === true`，市场错误 0 | 当前 CLI 支持接口，结果完整且非空；不扫描插件目录填补结果 |
| 已安装插件字段 | 28 个条目均带 localVersion 字段及布尔 enabled | 本地版本字段存在不等于非空版本；市场 version 不能替代 localVersion；enabled 不证明授权／连接／当前会话可调用 |

现场 user 层没有 `disabledReason`（也没有 `disabled_reason`）；缓存类型声明它为可空字段。遗漏仅表示该项未知，不能推断为禁用，也不能仅凭遗漏把所有设置改成只读。本次写入目标的可靠依据是唯一用户基础层、明确 `profile:null`、原生 file 与非空 version。它仍不证明写权限或某个字段可写；实际允许项须结合模型目录、权限表示能力、受管限制和写 RPC 结果判断。

运行时必须重新判断：层数组缺失、基础层不唯一、版本／路径缺失、无法区分 profile 或已选 profile 时，禁用保存并说明原因。本次无 profile 不覆盖 profile 的真实使用场景验收。

## 写入接口依据与未验证边界

协议缓存位于主仓库 `C:/Users/example/work/codex_web/.local/protocol`，未加入产品源码、未编辑生成文件；缓存生成版本未知。已核对 v2 的 `ConfigReadResponse`、`ConfigLayer`、`ConfigLayerSource`、`ConfigLayerMetadata`、`ConfigBatchWriteParams`、`ConfigEdit`、`ConfigWriteResponse`、`WriteStatus`、`OverriddenMetadata` 及插件相关类型。缓存是静态线索，不能替代当前 CLI 的读写行为验证。

- `ConfigBatchWriteParams` 声明 `edits`、可选 `filePath` 和可选 `expectedVersion`。原生允许省略不代表 Web 可以省略：P0 固定写用户基础层，使用读取时的原生版本，并拒绝无版本入口、任意文件路径和任意 keyPath。
- [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)说明 `config/batchWrite` 对用户 `config.toml` 原子应用多项编辑；协议 `ConfigEdit` 声明每项的 keyPath、value、mergeStrategy。权限相关项需一起提交，保留无关键。
- `ConfigWriteResponse` 声明 status、version、canonical filePath 和 overriddenMetadata；`WriteStatus` 是 `ok` 或 `okOverridden`。写入成功和当前有效值须分别呈现，项目覆盖不能直接报保存失败。写完必须重新 `config/read(includeLayers:true)`，核对目标层的新值／版本和当前有效值；写响应不能替代回读。
- 缓存声明 `reloadUserConfig` 会热加载部分设置，但模型、推理强度等会话静态默认值不热加载。P0 不启用 reload，不自动重启或重发任务。
- [AppServer.request](../../src/codex/app-server.ts) 保留原生 JSON-RPC error 的 code；超时拒绝并声明结果不确定，迟到响应不重发。未知方法 `-32601` 才可作为 unsupported 的确证；本次插件请求没有该错误。
- 缓存和已查阅的官方页面没有建立当前 CLI 在版本冲突、无权限写入或无效编辑时的具体错误码／data 结构。本次未触发写 RPC，不能声称 expectedVersion 冲突或原子性已在实机验证。后续需用隔离测试验证冲突、失败及回读契约；不能通过向真实用户配置写测试值完成此项。

Web 边界按规格保留：版本冲突 409；非法输入 400；读取失败 503；写入超时／结果未知 504 与 `SETTINGS_WRITE_UNKNOWN`，先回读核对，不自动重复写。原生错误映射须有明确依据，未识别错误不能猜成成功、冲突或 unsupported；写入结果未知不能降为普通失败而引导重试。

Task 1 核对时，[Runtime.saveModelDefaults](../../src/codex/runtime.ts) 未传 `expectedVersion`，回读 `includeLayers:false`。Task 2 已将它接入设置页共用的固定用户层、白名单校验、原版本与回读保护；首页仍使用创建任务前读到的版本，不偷取新版、不因默认值保存失败重发任务。此行为已由隔离测试验证，未向真实用户配置写测试值。

## 插件状态与后续验证

`PluginInstalledParams` 的 `installSuggestionPluginNames` 未发送；列表只采用 `installed === true`。协议 `PluginSummary.localVersion` 是本地包版本，`version` 是远程市场版本。身份按市场标识加 plugin id；来源仅做安全投影，不返回完整 source 或远程图标地址。

成功且数组为空才显示空列表。`-32601` 显示当前版本不支持；其他错误显示读取失败。市场部分失败时保留成功部分和错误数量；刷新失败保留上次成功数据及陈旧标记。未知 availability／disabledReason 不推断可用。当前 0 市场错误只证明本次读取完整，不证明部分失败／刷新失败／同名插件场景已验证。

以上保留 Task 1 的现场证据；后续隔离冲突、页面安全投影与状态测试已纳入下列集成记录。真实 config、AGENTS、插件和现有服务未修改。

## P0 集成验收

产品源码基准为 `6cfb8e1750222b3f35f84a042346f53f237f1d6b`；集成时发现旧认证测试的 `/api/settings` 完整对象断言遗漏新增 diagnostics 字段，在 `86050b9852d7fb3dab1288009af2f3b599428141` 仅更新该测试预期。产品源码、三个浏览器测试和依赖文件与基准一致。

执行范围以用户后续明确授权的 P0 实施为准，覆盖初稿待实施状态；导航仅提取既有 helper 供设置与离开保护共用。工作者按指定 `gpt-6.1-sol/high` 执行，无模型降级；整分支审查和本需求提交 squash 由控制器完成，工作者不合并源分支、不推送、不重启。

Node 测试使用隔离工作树 `.local/tmp` 为 TEMP/TMP；构建输出 `.local/codex-settings-build`，不覆盖在线 dist。测试替身证明接口与界面契约，不证明真实写入、插件授权或桌面操作。

| 验收 | 结果与证据 | 实机边界 |
| --- | --- | --- |
| A1 | 浏览器通过：五分类直接访问、刷新、前进后退、390／1440px 无横向溢出、键盘操作、旧设置入口保留 | Chrome + API 替身；未部署 |
| A2 | Node／浏览器通过：固定配置白名单与安全投影；模型强度、受管／未知权限、网络语义与来源检查；任意键／路径拒绝。新 Runtime 实机读到版本和七个公开字段 | 真实支持字段写入未验证；投影 writable 不是写成功证据 |
| A3 | Node／浏览器通过：原生 peer 收到原读取版本、409 保留草稿、回读用户值与有效值、超时／未知结果不自动重复写 | 原生冲突／原子写的行为由 peer fixture 覆盖，真实写 RPC 未执行 |
| A4 | Node／浏览器通过：首页默认值与设置页共用 writer；创建前版本保留、默认值失败不重发，当前会话不热加载 | 未改变已有真实会话；非全客户端兼容性实测 |
| A5 | Node／浏览器通过：用量与弹窗共享请求、401 退出、账户变化关闭旧确认、未知重置保留幂等标识；真实只读用量成功 | 未消费真实重置机会 |
| A6 | Node／浏览器通过：首页与会话快捷键一致、Shift／IME／手机保护、持久化失败提示；真实新 Runtime 的 currentOnly 无 RPC，临时 Diagnostics 当前状态可读 | 摘要来自独立新实例，未检查在线服务实例、旧日志或健康状态 |
| A7 | 临时目录 Node／浏览器通过：两固定目标、冲突、UTF-8／超限、BOM／换行、覆盖提示、链接／联接逃逸及原子替换失败；真实两类指令只读成功 | Windows 文件 symlink 用例在缺少权限时使用 junction；真实写入未验证，跨进程非事务锁 |
| A8 | Node／浏览器通过：同名市场区分、unsupported／空／partial／刷新失败独立呈现、无管理写操作；真实读取 28 个已安装插件 | 真实读完整且错误 0；异常状态由 fixture 覆盖，enabled 不证明连接／授权／可调用 |
| A9 | Node／浏览器通过：认证、Origin／CSRF、固定参数边界；分类／侧栏／前进后退／显式退出的未保存取消保护 | 刷新／关闭只验证注册原生 beforeunload；不模拟真实用户配置改写 |
| A10 | TypeScript、完整单并发 Node（341 通过／5 跳过）、复用浏览器（43／43）及生产构建通过；此前失败与平台限制见下表 | 部署、真实写入、电脑操控独立验收，均未执行 |

### 测试命令与失败分母

| 命令／证据 | 结果 |
| --- | --- |
| 首轮 `npm test`（require_escalated） | 345 项：337 通过、3 失败、5 跳过，273.42 秒。旧认证 DTO 断言失败；80ms AppServer 后续 count RPC 在并发下超时；git-fetch 清理挂起后中断该文件。保留此失败分母 |
| `node --test --test-name-pattern='session bootstrap and login enforce' tests/auth.test.ts` | 旧预期 0／1 通过；测试预期修正后的 Task 7 定向重验 1／1 通过，无产品修复 |
| `node --test --test-name-pattern='timeout reports uncertain outcome' tests/app-server.test.ts` | 1／1 自然通过；源码与测试从基线未变，不放宽 80ms 断言 |
| `node --test --test-timeout=30000 tests/git-fetch.test.ts`（require_escalated） | 2／2 自然通过，5.17 秒；无排除、无修改测试，保留首轮清理失败 |
| `npm test -- --test-concurrency=1`（require_escalated，参数顺序错误） | 345 项：338 通过、2 失败、5 跳过，62.68 秒，自然退出 1。认证及 git-fetch 通过；80ms AppServer count 超时仍失败，portable-install 文件出现 Node 26 runner 反序列化错误。临时探测确认文件之后的参数被忽略，实际仍为默认并发；不能将此轮称为单并发 |
| `node --test tests/portable-install.test.ts`（require_escalated） | 未修改的便携安装 fixture 隔离复验 11／11 自然通过，190.7ms；完整套件的 runner 错误仍保留，不能用单独通过替代完整通过 |
| `node --test --test-concurrency=1 tests/*.test.ts`（require_escalated） | 完整复验自然退出 0：346 项、341 通过、0 失败、5 跳过，181.03 秒；从运行子进程命令行确认 concurrency=1，不排除任何测试 |
| `npx playwright test tests/codex-settings.spec.ts tests/questions.spec.ts tests/settings-restart.spec.ts --config=.local/playwright-settings-chrome.config.ts --global-timeout=300000` | 复用 Task 7：43／43 通过（36 设置、3 提问、4 重启），43.2 秒，自然退出；Chrome，4189 端口，390／1440px。TEMP/TMP 同上、移除 NO_COLOR，require_escalated。源 SHA 为 `6cfb8e1`；依据 task-7-report 与工具 session 96842、chunk 402b8c 的退出 0，未声称另有保存的控制台日志 |
| `npm run build -- --outDir .local/codex-settings-build` | 退出 0，含 `tsc --noEmit`；Vite 构建成功，仅既有部分 chunk 超过 500 kB 的警告 |
| `git diff --check` | 退出 0；仅 autocrlf 的 LF／CRLF 提示 |

平台跳过保留五项：Windows 不运行 Linux foreground／systemd／Serve 三项及 Linux 路径大小写一项；未设置 PORTABLE_TEST_DIR 跳过解压便携包实测一项。任务 6 的 Edge／Chrome 清理延迟、失败和中断仍保留在任务报告，最终浏览器成功证据来自 Chrome，不声称 Edge 终验通过。首轮 Node 清理只处理已核验且属于本次运行的测试进程树；历史 OS 拒绝的 fixture PID 4560／4040 未动，目录未递归清理。

### 当前实现的宿主只读核验

核验时间 `2026-10-06T21:03:44.814Z`（北京时间 `2026-10-07 05:03:44`）。使用 `require_escalated` 的独立新 Runtime，显式设置探测环境 CODEX_HOME 为主机目录并核对初始化 home 一致；产品仍通过初始化推导 home。调用当前 Settings／InstalledPlugins／Instructions／Projects／AccountUsage 服务，AccountUsage 数据库为 `:memory:`，Diagnostics 仅写工作树临时目录；没有访问在线服务的设置接口。

| 检查 | 脱敏结果 |
| --- | --- |
| 配置投影 | supported=true；7 字段；userVersion／userFile 存在；6 字段有来源、7 字段由投影判为 writable；不输出值或版本原文 |
| 两类指令 | 原生 home 定位个人目标、Projects.resolve 定位主仓库项目根；两文件存在、版本存在，无 override；不输出或保存指令正文 |
| 已安装插件 | supported=true；28 项、5 个来源市场、partial=false、errorCount=0；28 个 enabled 已知、14 个 localVersion 非空，其他本地版本仍未知 |
| 用量 | 读取时间、账户标识存在；rateLimits 存在、2 个 limit bucket、重置机会数据存在；不输出账户、额度值或凭据 |
| 诊断 | 冷 Runtime 摘要不启动原生、不发 RPC；读取其他模块启动独立进程后 currentOnly 仍不发 RPC、账户仍未知。临时新 Diagnostics 最近成功写入存在、丢弃／失败 0，关闭后 enabled=false |

探测脚本审计且仅允许读取 RPC：initialize×1、config/read×1、configRequirements/read×1、plugin/installed×1、account/read×2（refreshToken=false）、account/rateLimits/read×1；结束关闭自有 Runtime。未调用 config/batchWrite、指令写入、resume、reload、安装、OAuth、重置机会消费或重启。此记录不授权后续写操作；真实保存时仍须单独验收回读和生效范围。
