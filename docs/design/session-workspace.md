# 会话工作区设计

日期：2026-09-11。范围：会话工作区第二阶段功能。设计已实施；实际验收与差异见 [第二阶段记录](../verification/2026-09-11-phase2.md)。后续 [同步](session-sync.md)、[工作区面板](workspace-panels.md)、[Markdown](markdown.md)、[执行过程](execution-process.md) 专项规则优先。

## 1. 产品方向与参考依据

用户澄清后的约束：**保留现有配色和视觉风格，主要借鉴官方的流程体验；重连、状态同步、释放接力等问题的解决思路参考官方实现。** 不要求复制整个官方客户端，也不以“参考实现”为由更换整个客户端。

借鉴重点是操作顺序、状态反馈和失败恢复：打开/切换会话、发送与中止、等待审批、断线恢复、释放后接力、查看代码变更。用户提供的 VS Code 截图用于理解占用提示和重试入口，不作为换肤或像素还原目标。以下流程是结合官方公开行为提出的 Web 适配设计，不宣称与同版官方客户端逐步一致。

实现继续调用已安装的独立官方 `codex app-server`。不另写推理、工具执行、原生持久化、跨客户端锁，也不从 VS Code 私有 bundle 提取运行时代码。公开参考：[官方 IDE](https://learn.chatgpt.com/docs/codex/ide)、[app-server 协议](https://learn.chatgpt.com/docs/app-server)、[openai/codex](https://github.com/openai/codex)。直接移植公开源码时记录 commit、文件、许可证和修改说明；本项目不宣称为官方客户端。

本机协议生成记录：`.local/protocol-version.json`，CLI 0.153.4，生成于 2026-09-08。协议字段依据该目录 `v2/Model.ts`、`TurnStartParams.ts`、`UserInput.ts`、`ErrorNotification.ts`。它是版本基线，不保证未来 CLI 行为不变；实施相应模块前重新运行协议生成并检查差异。

### 方案选择

| 方案 | 得失 | 决定 |
| --- | --- | --- |
| 现有界面借鉴官方流程，继续使用官方 runtime | 保留现有外观、已验证认证、项目和原生 Thread；只维护 Web 适配 | 采用 |
| 完整复制官方 VS Code 私有前端 | 没有在本次核实的公共仓库中找到可直接复用的同版前端包；依赖 IDE 宿主 | 不作为交付前提 |
| 新建另一套 Agent / 会话后端 | 重复原生实现，丢失接力兼容性 | 排除 |

## 2. 当前基线与设计范围

当前已有：React/Vite、Fastify、Node SQLite Web 元数据、密码/CSRF、SSE、原生 Thread 历史分页、审批、中止、项目发现/创建/Clone、Git status/diff、私网 HTTPS 入口、登录后启动任务。

2A 已实现：发送后的受理/运行/重试/完成反馈、输入区占用与恢复入口、SSE 心跳超时恢复、原生 `willRetry` 提示、释放前自动核对完成状态、区分取消订阅和接力就绪，以及切换会话/打开新会话时自动释放原会话。保持现有聊天排版、配色、字体和图标，不将 Markdown 渲染升级或图标替换作为流程修复的前提。

阶段功能与设计验收要求（真实设备通过状态以验收记录为准）：

| 原始需求 | 界面入口 | 原生/本地责任 | 验收 |
| --- | --- | --- | --- |
| 更好的 Diff UI | 会话右上角“变更” | Git 输出 → 文件/hunk 结构 | 按文件选择，增删行、行号、二进制/重命名状态正确 |
| 文件列表 | 变更面板“文件”页签 | 项目内安全文件读取 | 相对路径、懒加载、无越界读取 |
| 测试结果结构化 | 执行记录内“测试结果” | 原始命令 + 显式报告文件 | 用例/汇总可追溯，无法解析时保留日志 |
| 模型/Reasoning | 输入框下沿 | `model/list`、`turn/start` | 选项来自能力列表，下轮生效 |
| Session rename | 会话菜单 | `thread/name/set` | VS Code 与 Web 读到相同名称 |
| Archive/Delete Web metadata | 会话菜单/已隐藏列表 | Web metadata | 不删除原生聊天或项目文件 |
| 收藏 | 会话菜单/侧栏收藏组 | Web metadata | 跨刷新保留，取消后回到普通列表 |
| Web Push | 设置/通知 | 浏览器订阅 + Node 推送 | 用户主动允许，完成/待审批去重通知 |
| 文件上传 | 输入框附件按钮/拖放 | 私有上传存储 + 原生文本引用 | 有上传状态、失败可重试、不伪造已发送 |
| 图片上传 | 同一附件入口 | `localImage` | 预览、模型能力检查、原生会话可回看 |
| 三栏宽度调整与记忆 | 导航/聊天/变更之间的两条分隔线 | 浏览器本地保存比例 | 拖动、刷新、切会话、窗口缩放与面板重开后比例正确 |
| 审批方式选择 | 输入框下沿审批方式下拉 | 原生审批策略、审查者与沙箱组合 | 四种模式含义明确，原生生效与显示一致，受限选项说明原因 |

## 3. 流程体验规格

### 3.1 沿用现有外观

沿用现有 `src/web/style.css` 的配色、绿色主按钮、字体、头像、图标和组件样式，不新增一套官方主题或更改消息气泡形状。三栏宽度允许用户调整并按比例记忆，规则见 3.4；新增功能复用现有组件外观。

手机键盘弹出后，输入操作与相关状态仍须可见；导航和变更面板都有可达的返回/关闭入口。长路径、长命令在内容区域内处理，不让页面整体横向溢出。状态同时用文字表达，不能只靠颜色。

### 3.2 关键操作流程

| 场景 | 操作与状态顺序 | 失败与恢复 |
| --- | --- | --- |
| 打开/切换会话 | 切换到另一会话或打开新会话 → 保存当前草稿并自动发起原会话释放 → 进入目标会话/新会话输入页；浏览本身不抢占写入权 | 导航不等待释放完成；原会话运行中则完成后自动释放，失败显示可重试状态；详见 4.4 |
| 发送与中止 | 发送 → 提交中 → 原生受理后运行中 → 完成；运行时提供中止入口 | 提交失败保留草稿；结果未知先核对历史，不自动再发一次；中止请求发出后等待原生终态 |
| 原生模型重试 | 收到 willRetry → 当前轮显示重试提示 → 新输出到达后继续 → 终态清除提示 | 重试期间保留中止入口；不能把临时重试显示为整轮失败 |
| 断线与返回页面 | 检测连接中断 → 明示正在重连 → 恢复连接并同步历史/当前轮 → 恢复操作 | 保留草稿和可用历史；自动恢复失败提供重试，不要求用户先刷新整页 |
| 释放并关闭 | 点击一次 → 自动核对原生状态 → 正在释放 → 确认本 Web 占用已释放后关闭会话页 | 仍运行/待审批时说明阻碍；仅取消订阅时停留在待释放状态并可重试；刷新不是前置步骤 |
| 其他客户端占用 | 可读历史，输入操作附近说明当前无法继续 → 用户在原客户端释放后点击重试 → 重新核对 | 不把重试当强制接管；无法确认占用来源时不虚构客户端名称 |
| 审批/补充输入 | 在当前任务上下文显示原生问题 → 选择或输入 → 提交中 → 原生确认后继续 | 防重复提交；切换会话仍保留待处理标记；过期请求不能再次提交 |
| 查看变更 | 打开变更 → 选择文件 → 查看 diff/相关测试结果 → 返回聊天 | 保留聊天位置和草稿；读取失败只影响对应面板，可单独重试 |
| 模型与附件 | 选择下一轮模型/推理强度 → 添加附件并等待就绪 → 发送 | 设置明确下条消息生效；附件失败单独重试，发送前校验模型能力；详见第 7、9 节 |

### 3.3 核心组件和状态

| 组件 | 交互与显示 |
| --- | --- |
| 最近会话 | 点击只读打开；菜单含重命名、收藏、从 Web 隐藏、清除 Web 元数据；沿用当前选中样式 |
| 用户消息 | 沿用现有外观；附件展示发送状态，受理前不能伪装成已发送；禁止把原始 HTML 作为 DOM |
| 助手消息 | 沿用现有外观；输出、重试和最终错误跟随同一轮，恢复后不重复追加已有内容 |
| 执行记录 | 命令摘要 + 原生状态；默认折叠，展开可看命令/输出/退出码；长输出分块/限量展示 |
| 输入框 | 附件 → 文本 → 模型/推理设置与审批方式 → 发送；运行中发送位置换中止，不能意外发送第二轮 |
| 状态提示 | 在输入操作附近清晰可见；外部占用、连接中断、模型重试、释放待完成各有独立文案，并对应实际可用操作 |
| 审批 | 保留原生问题/选项/理由；忙时防重复提交；不能因导航丢失待审批事件 |
| 空/错误状态 | 首次加载、空会话、无法读取、只读占用、结果未知分别展示；保留草稿与可用历史 |

验收重点是操作步骤是否连贯、状态是否真实、失败是否能原地恢复，以及草稿/历史是否保留；同时检查现有配色和视觉风格没有被意外改变。官方源码依据与本项目的具体适配分别记录在第 4 节。

### 3.4 三栏拖动与比例记忆

桌面三栏为左侧项目/会话导航、中间聊天、右侧文件/变更。两条分隔线均可拖动，实时调整相邻两栏，第三栏不变；只改变宽度，不改变配色和内容排版规则。

**比例模型**：以三栏实际可用总宽度（扣除外边距、边框和分隔线）为分母，保存 `{version:1,left,center,right}`，三项为正数且总和为 1。例如 20% / 55% / 25% 随窗口等比恢复，不保存固定像素。首次使用沿用现有布局的计算宽度作为默认比例，提供“重置布局”。

**约束与折叠**：设计最小宽度为左 180px、中 420px、右 240px；恢复比例时先计算再限制到可用范围。窗口缩放造成的临时限宽不覆盖保存比例，拉宽后还原。总宽不足时进入既有窄屏布局，停用横向拖动且不覆盖桌面偏好。关闭右栏时将其宽度交给聊天栏，重开还原右栏比例；隐藏导航同理。在两栏状态拖动，只在可见栏的原比例总额内重新分配，保留隐藏栏的份额。

**存储与交互**：使用同源 `localStorage` 的 `codex-web:layout:v1`，作为该浏览器的全局布局偏好，跨会话、项目、刷新和重新打开页面保留；不同设备独立。仅拖动结束/键盘调整完成时保存，非法、旧版或不可读取的数据回退默认，存储不可用时仍可在当前页面调整。不新增布局 API、数据库或拖拽依赖；复用现有网格和原生 Pointer Events，处理 pointer capture、取消拖动和 resize。

分隔线支持焦点与左右方向键，每次调整可用总宽度的 1%；使用 `role=separator`、垂直方向、名称、当前值和有效上下限。拖动期间避免误选文本；面板缩放不重挂载会话、不触发自动释放，不丢输入草稿或聊天阅读位置。

## 4. 接力与连接：第二阶段前置修复

### 4.0 官方实现证据与 Web 适配

以下源码在 2026-09-11 查阅，链接指向上游 `main`，不是本机 CLI 0.153.4 的固定版本。可用于核对思路；落地前须固定与本机兼容的 commit/tag 并复核相应测试，不能据此宣称同版 VS Code 前端也有完全相同的实现。

| 问题 | 已核对的官方做法 | 本项目设计落点 |
| --- | --- | --- |
| 模型重试没有反馈 | `bespoke_event_handling.rs` 的 `EventMsg::StreamError` 发 `ErrorNotification { will_retry: true }`，不把中间重试写成最终 turn 错误；最终错误走 `will_retry: false` | 分开保存临时重试状态和最终错误；前端显示原生事件，不能只看浏览器 SSE 是否在线 |
| 恢复时历史与新事件交错 | `thread_state.rs` 的 `ThreadListenerCommand::SendThreadResumeResponse` 在同一监听器上下文中排列历史响应与新订阅；用 listener generation 区分更换后的监听器 | 恢复历史与事件应有顺序/代际校验，旧读取不得覆盖新 turn；Web 自己的快照同步不假装是原生 resume |
| 释放请求返回后仍有尾部处理 | `thread_state.rs` 有等待旧 listener 处理 `ShutdownComplete` 的 drain waiter；`connection_cleanup.rs` 有异步清理任务和 drain | 区分“请求已接受”和“清理已完成”，完成确认后才更新接力结果；这些内部方法不是可从 Web 直接调用的新 RPC |
| unsubscribe 不立即卸载 | 官方公开协议只承诺取消该连接的订阅，并明确存在卸载宽限期 | 按公开协议确认状态；不能将 unsubscribed 等同 writer 已释放，也不能编造立即卸载接口 |

源码：[重试事件](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs#L1068)、[监听器顺序与结束确认](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/thread_state.rs)、[连接清理](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/connection_cleanup.rs)。这些证据支持状态分离、顺序处理和完成确认，不证明之前那次故障的唯一根因。

下文 SSE 的 45s/5s、读取等待 2s、Web 的 `handoffReady` 响应均是本项目的适配参数/接口，不是从官方复制的常量或协议字段。实施时优先复用官方公开能力；不能拿本项目的轮询替代官方已经提供的完成事件。

### 4.1 三种独立状态

1. 浏览器 ↔ Web：`connecting | online | reconnecting`。服务端每 15s 发 `ping`；可见页面超过 45s 没有任何 SSE 事件则重建连接并读历史；检查间隔 5s。后台标签页恢复后立即同步。任何恢复都不得重发消息。
2. Codex ↔ 模型：`retry` 来自原生 `error.willRetry`，保存 `turnId/message`，不写入最终 `turn.error`。恢复输出/该轮完成后清除。没有原生事件时只显示任务运行中，不编造重试次数或网络原因。
3. Thread 使用权：`idle | running | external | releasing | released/pending`。Turn 完成、取消订阅、原生进程退出是不同事实。Web 的取消订阅标记不得充当跨进程 writer 锁的权威。

### 4.2 当前共享运行时的最小可靠释放

前端先暂停当前页 SSE 和自动快照，再发 release。后端先设置会话操作保留标记，完整读取原生状态，复用完成轮次校正逻辑清掉漏收事件留下的活动标记；原生仍 active、状态不明或审批未结束则 409，不能抢占。然后调用 `thread/unsubscribe`；等待最多 2s 的重叠读取结束，仅在所有 Web 任务均空闲时关闭本应用拥有的 app-server。

现有响应保持兼容，新增：

```ts
type ReleaseResult = {
  threadId: string;
  status: 'released'; // 当前 Web 订阅已经取消，不保证其他应用已成功恢复
  nativeStatus: 'unsubscribed' | 'notSubscribed' | 'notLoaded' | null;
  runtimeStopped: boolean;
  handoffReady: boolean; // 当前 Web 所有者进程已确认退出
  warning?: string;
};
```

手动“释放并关闭”时，`handoffReady=true` 才关闭页面并告知已释放；它证明本 Web 进程已放开，不保证没有第三个客户端随后获得占用。false 留在页面显示“订阅已取消，仍在等待释放占用”，允许重试，不误报已可接手。失败恢复 SSE，保留错误和草稿。导航触发的自动释放复用同一后端流程，但页面行为按 4.4 处理。不能删除锁文件、杀 VS Code、归档会话来代替释放。

官方 `thread/unsubscribe` 文档存在无订阅/无活动后的卸载宽限期（当前文档为 30min）。本项目不能把这一响应当作即时交接承诺：[官方语义](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)。

### 4.3 并行会话即时交接的实现边界

如果第二阶段要求 A 会话运行时仍能立刻把空闲 B 交给 VS Code，当前共享进程方案不能保证。先核对对应版本官方对 thread 卸载、连接退出和 writer 生命周期的处理，采用其公开支持的途径；源码内部的清理方法不能直接当作公共 RPC。

“每个可写 Thread 一个 app-server”仅列为官方公开接口无法满足即时接力时的备选适配，并非已核实的官方客户端架构，也不是本阶段已决定的重构。只有确证需要且评审通过才拆分。验收始终要求“两会话一运行一释放”不影响活动任务；无法兑现时明确显示待释放，不用隐藏等待或强杀进程冒充成功。

### 4.4 切换/打开新会话时自动释放

这是用户明确新增的产品要求，不作为已核实的官方行为。默认启用，不增加设置开关，也不要求先点“释放并关闭”。

- **触发入口**：当前会话 A 切换到另一会话 B，或点击“新会话”进入新会话输入页时，自动请求释放 A；应用内会话链接、前进/后退使用相同流程。重复点击 A、打开变更面板、首次进入且没有原会话时不触发。空的新会话输入页不提前创建原生 Thread。
- **正常路径**：先保留 A 的草稿、附件引用和阅读位置，停止 A 的页面级自动读取，发起释放后立即导航。A 空闲时自动完成释放；只读浏览过且本 Web 未持有的会话跳过释放。成功不弹确认框，也不关闭新打开的页面。
- **运行/待审批**：允许切走，不中止任务、不代答审批。后端记录 A 的待释放意图，继续接收必要的运行与审批事件；本轮进入终态后自动执行同一释放流程。列表显示“运行中 · 完成后释放”或“待审批 · 完成后释放”，审批入口仍可返回 A。
- **等待/失败**：沿用 4.2、4.3 的真实释放边界；其他任务仍占用共享进程时显示“等待释放”，所有任务空闲后再自动尝试。请求失败或结果未知在原会话行保留“释放未完成”和重试入口；连接恢复后先核对再重试。不能因已导航就报成功，也不能释放失败后把用户拉回 A。
- **快速切换与返回**：释放请求绑定离开的 Thread ID，同一会话的重复请求合并；旧响应不得修改当前会话或关闭当前页面。返回 A 时取消尚未开始的待释放意图；已开始的释放先核对完成结果再允许新发送，防止迟到的释放关闭刚恢复的任务。草稿与附件始终归属原会话，不随目标切换串入下一条消息。
- **统一入口与生命周期**：导航自动释放和手动释放复用同一后端状态核对、操作互斥及完成确认，不另建一套锁。后端接受的待释放意图不依赖旧页面保持打开；若新页面仍使用共享运行时，按待释放状态处理，不能为了释放 A 关闭其他会话的活动任务。普通网页刷新/关标签页不依赖 unload 请求保证释放，不纳入本条触发承诺。

## 5. Diff 和文件浏览

复用 `Projects.resolve()` 绑定项目，不接受前端绝对目录。`GET /api/sessions/:id/git/status` 保持现状；新增 `GET .../git/files?staged=false` 返回 `{files:[{path,oldPath?,status,added,deleted,binary}],revision}`。新增 `GET .../git/diff?staged=false&path=<relative>` 返回 `{path,staged,revision,hunks:[{oldStart,oldLines,newStart,newLines,lines:[{kind:'context'|'add'|'delete',text,oldLine?,newLine?}]}],binary,truncated}`。原 text 响应先保留，旧客户端可兼容。

Git 仍用参数数组、`--no-ext-diff --no-textconv --no-color -- <path>`，不能拼命令。选择文件只读取该文件 diff；默认 unified，桌面可切 split；移动端始终 unified。未跟踪文本展示为新增预览，说明它还未进入 Git diff；二进制只显示元数据。单文件上限 1MiB / 20,000 行，截断须明确提示并可下载原始 patch；不截成“所有测试通过/完整改动”之类结论。

文件页签使用 `GET /api/sessions/:id/files?directory=<relative>`，返回一层 `{path,type,size}`；`GET .../files/content?path=<relative>` 返回 UTF-8 文本、大小、是否截断。默认遵循 Git 忽略规则；过滤 `.git`、`.env*`、凭据文件和上传私有目录。目录与文件逐层 `realpath` 后检查在项目根内，拒绝 symlink/junction 逃逸、绝对路径与 `..`；Windows 另拒绝 UNC、设备名和 ADS。跨平台命名规则见 [Linux 方案](linux-support-and-docs.md)。二进制只显示名称大小，不猜编码。不增加任意本机文件 API。

## 6. 测试结果结构化

先展示原生命令的 exit code 与日志，只有找到显式报告才生成“测试结果”卡。支持 JUnit XML 和 Node `--test-reporter=junit` 产物，pytest 使用已有 `--junitxml` 参数；不改用户测试命令、不因展示重复运行测试、不通过零退出码猜用例数量。

`POST /api/sessions/:id/test-reports` 输入 `{commandItemId,relativePath,format:'junit'}`；必须绑定同 Thread 的 commandExecution item，报告位于该项目内且满足文件读取边界。只解析最多 5MiB、10,000 个用例，禁用 DTD/外部实体。允许一个有维护的 XML 解析器，禁止手写正则解析 XML。

输出 `{reportId,commandItemId,fileHash,observedAt,summary:{passed,failed,skipped,errors,durationMs},cases:[{name,suite,status,durationMs,message?}],truncated}`；保留报告来源和命令链接。报告文件时间早于该命令开始时明确标记“可能是旧报告”，不当作本轮通过。解析失败只提示“无法结构化”，原日志仍可看。结果可在 SQLite 缓存以 `(thread_id,command_item_id,file_hash)` 去重，原日志仍属于原生 Thread。

## 7. 模型、Reasoning 与审批方式

### 7.1 模型和 Reasoning

新增 `GET /api/models`，后端分页调用 `model/list` 并返回可用模型的 `id/model/displayName/isDefault/supportedReasoningEfforts/defaultReasoningEffort/inputModalities`。每个进程 epoch 缓存 5min；失败不展示假模型，允许沿用当前配置。隐藏项不默认展示，已选模型失效则提示用户重新选择。

扩展创建/消息 body 为 `{...,model?:string,effort?:string}`。后端针对本机 catalog 验证组合；`turn/start` 原生字段为 `effort`，不要误传 `reasoning`。创建/恢复时如需设置须以生成协议的 `reasoningEffort` 字段为准。留空即省略字段，不能强塞某个模型或 high。运行中设置只改变下一轮草稿，不能改变当前轮；UI 标注“下条消息生效”。客户端幂等签名必须纳入 model/effort/附件 ID，避免误用同一提交 ID。

### 7.2 审批方式下拉

入口放在输入框下沿，与模型/推理设置并列，显示当前模式名称。沿用本项目配色，参考用户截图的菜单结构：标题“应如何批准 Codex 操作？”、“了解更多”、四个带简短说明的选项与选中标记。支持键盘选择、Escape 关闭并归还焦点，手机菜单不超出视口。

| 选项 | 用户可见含义 | 原生组合 |
| --- | --- | --- |
| 请求批准 | 需要提升文件或网络权限时由你确认 | 工作区写入沙箱 + `approvalPolicy:on-request` + `approvalsReviewer:user` |
| 帮我批准 | 由 Codex 自动审查需要批准的操作 | 同一工作区沙箱 + `approvalPolicy:on-request` + `approvalsReviewer:auto_review` |
| 完全访问权限 | 允许沙箱外文件和网络访问，关闭常规执行审批 | `danger-full-access` + `approvalPolicy:never`；仍受系统与管理员限制 |
| 自定义（config.toml） | 使用开发机配置中定义的权限 | 由原生配置解析，包含有效策略、审查者和权限范围；不硬编码成上述任意模式 |

“请求批准”不是每次编辑都问；“帮我批准”不是全部允许，原生可能拒绝或审查失败，界面保留真实结果和原因。以上组合依据 [OpenAI 官方审批说明](https://learn.chatgpt.com/docs/agent-approvals-security#automatic-approval-reviews) 与本机生成协议，菜单标签来自用户截图；不能承诺所有原生版本与托管环境均允许四项。

**生效与记忆**：选择先改变当前会话的下一轮草稿配置，显示“下条消息生效”；发送时统一提交并由原生确认，不更改正在运行的轮次或自动处理已有待审批请求。会话之间独立；已生效配置以原生状态为准，未发送的选择随该会话草稿保留。新会话从有效原生配置初始化，不直接继承另一会话的完全访问选择；已有配置匹配预设才显示对应名称，否则显示“自定义”。仅有历史、尚未恢复时无法核实时标记“待核对”，不为读取菜单抢占会话。

**能力与边界**：提供 `GET /api/permission-modes?projectId=...`，项目 ID 经现有项目解析器验证；后端调用 `config/read` 与 `configRequirements/read`，仅返回模式 ID、可用性/原因及权限摘要，不返回完整配置或密钥。模式必须符合本机协议、宿主沙箱能力与托管约束；例如自动审查不可用时保留禁用项并说明原因，不能退化为 Web 自动点击批准。启用完全访问前，在菜单内说明变化并要求一次明确选择确认；不改应用认证和文件浏览 API 的访问边界。

**协议落点**：扩展创建/消息参数为 `permissionMode?:'ask'|'auto-review'|'full-access'|'custom'`，仅接受枚举，由后端生成原生参数，不接受任意 `config`/磁盘根目录。当前 `.local/protocol/v2/ThreadStartParams.ts`、`ThreadResumeParams.ts` 支持 `approvalPolicy/approvalsReviewer/sandbox/config`，`TurnStartParams.ts` 支持 `approvalPolicy/approvalsReviewer/sandboxPolicy`；workspaceWrite 的路径由服务端按项目与受控附件目录生成，网络与临时目录设置完整传递。自定义模式须通过原生配置接口解析优先级，不直接解析或写全局 config.toml；从覆盖模式切回自定义时显式应用解析出的有效配置，不能只省略字段而残留旧覆盖。

本机 `ThreadStartResponse/ThreadResumeResponse` 返回有效 `approvalPolicy/approvalsReviewer/sandbox`，应核对实际生效结果。当前 runtime 的 `verifyPermissions` 固定核对 `on-request/user`，实施时改为核对本次所选策略，并统一更新创建、恢复、发送和诊断显示；不能只接一个前端下拉。权限选择及解析后配置签名纳入消息幂等校验，提交后配置变化不得在重试中扩大权限；不匹配或拒绝时保留草稿并显示错误，不静默换成更宽权限。自定义配置需要新协议能力才能无损表达时，明确标记不可用并要求兼容版本，不近似转换。

## 8. 重命名、收藏、Web 隐藏/清除

重命名使用 `POST /api/sessions/:id/name` `{name}`（trim 后 1–120 字符），调用原生 `thread/name/set`；成功后更新 Web fallback 名称。原生失败不先更新 UI 权威名称；支持原生先成功但 Web 元数据失败时重读原生修复。展示优先 `thread.name`，其次 Web fallback，再 preview。不会另维护不同名称。

收藏/隐藏用 `POST /api/sessions/:id/metadata` `{favorite?:boolean,hidden?:boolean}`。隐藏入口文案“从 Web 隐藏”，设置页有“已隐藏会话”可恢复。严格区分原 handoff 的 “Archive/Delete Web metadata” 与 `thread/archive/delete`：本阶段这两个菜单仅修改 Web 数据，不调用原生删除 API。若未来增加原生归档，须独立名称和确认，不能复用隐藏按钮。

`POST /api/sessions/:id/metadata/clear` 清除收藏/隐藏/fallback 标题等 Web 偏好。确认文案说明“保留原生聊天和项目文件；它可能再次出现在最近会话”。不会用 tombstone 偷偷删除原生发现结果。收藏组与普通组按最近活动排序；原生分页后再合并元数据，隐藏过滤造成一页不足时继续取下一页并保留正确 cursor。

### SQLite 迁移

在 `session_meta` 增加 `favorite INTEGER NOT NULL DEFAULT 0`、`hidden INTEGER NOT NULL DEFAULT 0`、`updated_at INTEGER`。迁移使用 `PRAGMA user_version` + transaction，重复启动不重复 ALTER。现有 `INSERT INTO session_meta VALUES(...)` 必须改为显式列名后再加列。开启 WAL；仅迁移自己的 metadata.sqlite，不写 Codex 原生数据库。升级前备份 Web DB；降级不丢新增偏好。

## 9. 附件：文件与图片

输入框附件支持选择、拖放、粘贴图片；附件列表展示缩略图/文件名/大小、上传中/失败/就绪，失败单独重试。所有附件就绪才允许发送。移除仅撤销草稿引用，不删除已经发送的历史资源。

`POST /api/uploads` 使用 multipart，返回 `{uploadId,name,mime,size,kind:'file'|'image'}`；初始限制：每文件 10MiB、每消息最多 5 个、单次合计 25MiB、私有附件总量 1GiB。流式写入临时文件并计算 SHA-256，成功后原子改名；文件名用随机 ID，用户文件名只作显示。验证扩展名、MIME 与 magic bytes；首版图片仅 PNG/JPEG/WebP，拒绝 SVG/HTML/可执行文件与压缩包。图片解码后像素上限 40MP，拒绝解码炸弹。

消息 POST 增加 `attachmentIds:string[]`。后端验证登录所有者/草稿关系、资源存在、限额与模型 inputModalities，不能接受客户端自带磁盘路径。图片转为官方 `localImage`（后端绝对路径）；普通文件在当前 UserInput 没有通用 file 类型，使用文本片段告诉 Codex 原文件名和受控保存路径，让原生工具按任务读取。不能虚构 `type:'file'`，也不自动把二进制嵌进 prompt。

SQLite `uploads(id PRIMARY KEY, original_name, mime, size, sha256, relative_path, created_at, claimed_thread_id NULL, claimed_request_id NULL)`。提交用幂等 ID 原子认领；结果未知保留附件，先读原生历史核对再重试。无引用草稿 24h 后清理；已发送附件持续保留，因为原生会话/VS Code 可能引用该本地路径。达到总量只拒绝新上传，不静默删除历史附件。备份说明同时包含上传目录。

预览走登录保护的 `GET /api/uploads/:id`，校验资源引用、`nosniff`、安全 Content-Disposition、`Cache-Control:no-store`；非图片一律下载，不能直接作为网页执行。绝对路径只传到原生 Agent，不展示成可任意访问的 HTTP 路径。

## 10. Web Push

只在用户点击“启用通知”后申请浏览器权限。若浏览器不支持或拒绝，显示实际状态和页面内通知，不不断弹请求。需 HTTPS、service worker；手机平台安装要求作为能力检测结果提示，不承诺所有手机后台可达。

`GET /api/push/public-key` 返回 VAPID 公钥；`POST /api/push/subscriptions` 保存标准 subscription，`POST .../remove` 删除当前设备。VAPID 私钥在应用私有配置内生成，不能写进前端或提交 Git。使用维护中的 Web Push 库处理加密，不自制加密。

订阅 endpoint 为客户端输入：只接受 HTTPS 的受支持 push provider 域名和默认端口，DNS/IP 拒绝 loopback、私网、链路本地和保留地址；不跟随重定向，网络超时 10s；禁止把发送器做成 SSRF。浏览器不可伪造任意通知标题/正文或 deep link；服务端按原生事件构造。

通知场景：turn 完成/失败、等待审批或用户输入。用 `(subscription_id,thread_id,event_key)` 去重；推送结果 404/410 清理失效订阅，429/5xx 有界重试且带过期时间。payload 默认仅“任务完成/需要确认”与 Thread ID，不含 prompt、路径、输出。点击只打开本站已校验的 `/sessions/:id`，未登录先登录。退出/改密码后撤销相应 Web 登录关联订阅。

私网限制针对入站访问；Web Push 需要服务器向浏览器厂商服务出站，手机点击通知打开会话时仍须与开发机连接到同一局域网或虚拟网络。无需开放公网入口，不以公共隧道替代私网。

## 11. 模块与接口边界

保持已有结构，按真实职责增加文件：`src/web/main.tsx/style.css` 负责壳与会话；复杂独立区块再提取 `DiffPanel.tsx`、`Attachments.tsx`。后端沿用 `src/server/api.ts` 和 `Projects`，附件/推送/测试报告分别放独立模块，避免继续把所有逻辑塞入单个路由函数。原生协议仍只由 `src/codex/runtime.ts` / `app-server.ts` 管理。

所有新增 API 继承现有认证、同源/CSRF、schema 的 `additionalProperties:false`、请求体限额、ID/path 校验与 no-store。GET 不恢复写入所有者、不发 turn。无法确认写入结果返回明确 outcome-unknown，不自动提交第二次。SSE 只推小事件，完整历史仍分页读取；附件和测试报告不塞进 SSE。

## 12. 实施顺序与完成定义

| 里程碑 | 工作与依赖 | 独立验收 |
| --- | --- | --- |
| 2A：流程体验与接力 | 保留现有外观，完善发送/恢复/审批/释放流程，切换或打开新会话自动释放原会话；按对应版本官方生命周期确定并行接力方案 | 无需手动释放或先刷新；运行中切走不中止、完成后自动释放；A 活动时 B 接力不影响 A；模型重试可见；不重复发送 |
| 2B：模型、审批与会话整理 | 原生模型能力、审批方式、重命名、Web 元数据迁移、收藏/隐藏/清除 | 模型与权限组合验证；审批实际行为与菜单一致；VS Code 名称同步；重复迁移无损；清除不丢原生历史 |
| 2C：代码与测试结果 | 文件边界 → diff 结构 → 报告卡 | rename/binary/untracked/大文件；junction/ADS 越界拒绝；报告来源/错误/截断明确 |
| 2D：文件与图片 | 上传存储与配额 → 消息幂等认领 → 预览/原生输入 | 上传中不能发送；失败重试；重复请求无重复轮次；跨客户端图片/文件可读 |
| 2E：通知 | HTTPS/PWA 能力 → 订阅 → 事件去重/投递 | 真实手机授权、后台收到、点击登录/接力；无私密正文；失效和撤权正确 |

每个里程碑先增加可失败的针对性回归，再做最小实现；已有 `node --test` 优先，浏览器模拟 API 验证不消耗模型额度。文件/权限/并发场景不能以只测视觉替代。

### 必测场景

- 完成事件丢失 → 直接释放成功；同时发送和释放 → 一个明确拒绝，不中断已接受任务。
- 已取消订阅但其他任务活动 → 页面留在待释放，不误报；读请求交错后仍可完成释放。
- 断 SSE、只停 ping、切后台再回来 → 状态提示与历史恢复；用户消息计数不增加。
- 原生 willRetry → 显示模型重试且中止可用；恢复输出/终态 → 提示清除。
- 切换会话或打开/关闭变更面板 → 草稿和聊天位置保留；待审批状态不丢失。
- 空闲 A → 切换 B / 打开新会话 → 自动释放 A，目标页面正常可用；同会话点击和变更面板不触发释放。
- 运行/待审批 A → 切走 → 任务与审批继续保留，终态后自动释放；共享运行时仍忙时明确待释放。
- 快速 A → B → C、返回仍在释放的 A、释放超时后重连 → 不串会话、不关闭当前页、不释放新任务；草稿与附件不丢失，结果未知先核对。
- 配色、字体、图标和消息样式沿用现状；既有内容渲染的安全边界不退化。
- 三栏两条分隔线拖动/键盘调整 → 相邻栏变化且无内容丢失；刷新/切会话/重开恢复比例；缩窄再拉宽、右栏关闭再打开均保留用户比例；坏存储、禁用存储和移动端正常回退。三栏调整纳入 2A。
- 四种审批方式分别核对原生策略、审查者及沙箱；自动审查拒绝/超时不误报批准；权限不支持或受托管限制时不可选且显示原因。
- 运行中改审批方式 → 当前轮和待审批请求不变、下一轮生效；新会话不继承另一会话的临时完全访问选择；切回自定义清除旧覆盖，刷新/接力核对实际权限；请求失败/未知结果不丢草稿、不扩大权限。
- 390×844、831×可用高度、1440×900：输入框、状态卡可见；导航/变更关闭入口可达；键盘操作有焦点。
- VS Code 真实接手同一 Thread 并回传一个标记，再由 Web 只读确认。以真实 round trip 为最终兼容性证据，不能用 mock 或 thread/read 成功冒充 writer 释放已验收。

## 13. 发布、回滚和证据

设计与前端可在模拟 API 页面验收；生产运行时变化应在活动任务结束后重启自己的 Web 服务。不能在当前对话执行中关闭宿主 app-server 来证明释放。部署前记录 Node/CLI 版本、commit、构建产物、备份 Web 元数据，保留上一构建；回滚不触碰原生 Thread store。

验收记录保存在 [第二阶段验收](../verification/2026-09-11-phase2.md)；截图放 `output/playwright/`（本地、不进 Git）。最终报告区分：代码检查、模拟页面交互、真实客户端接力。手机 Push、第二阶段功能与真实会话接力，在实际执行前均标记未验收。当前通过与未通过项以验收记录为准。


## 历史附录：2026-09-11 实施阶段与实际差异

原 phase2 计划的五项均已完成：原生生命周期/模型/审批；元数据/文件/JUnit；附件/Push；前端集成；审查与收尾。各阶段先做失败回归，再实现并复验。实现采用 TypeScript、React 19、Fastify 5、Node SQLite；新增 multipart、sharp、web-push、fast-xml-parser，未自制图片解码、XML 或推送加密。

后端复用 `models()`、`permissionModes(cwd)`、`rename(threadId,name)`、`requestRelease(threadId)`、`cancelRelease(threadId)`；创建/发送统一接收 model、effort、permissionMode 与受控附件输入。临时 Git、SQLite 与文件边界测试覆盖部分失败、旧数据库迁移和特殊路径，前端覆盖快速返回、草稿及新任务上下文。

原生 `config/read` 的默认审批字段可能为 null：未显式选择时使用 start/resume 返回的有效权限，不猜测；无法完整表达的自定义模式禁用。历史命令无准确开始时间时，JUnit 保守提示可能过期。切走中断未完成上传，返回可重试，已上传附件保留。草稿只在本次页面生命周期保留，布局比例跨刷新恢复；这与文件面板后来按项目持久化的轻量阅读状态不同。

当时未重启当前对话/生产服务，未更改全局 Codex 配置、原生历史或他方锁；开发结果合入 develop，master 保留基线，实施提交 squash 为一个中文提交并保留原信息。实际测试数和真实/模拟边界集中见第二阶段验收，不将计划复选框视为设备验收证据。

## 状态同步的补充边界

- 原生已完成、失败或中止的轮次覆盖旧的流式内容；漏收完成事件时清理对应活动标记和过期审批。
- 并发读取只允许最新发起的快照更新运行状态；读取期间发生的新操作或事件不会被旧快照解锁。状态修正通知其他页面，稳定读取不重复发通知。
- 分页期间可能完成任务：早先状态为 active、读到的轮次全部结束时，再确认一次原生状态。
- `notLoaded` 表示当前原生运行时未加载，不等于会话被删除。可恢复错误在确认无未完成工作后清除；下一次显式发送仍由原生 writer 检查决定是否能接力。
