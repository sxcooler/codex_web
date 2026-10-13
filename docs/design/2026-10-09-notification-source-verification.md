# 当前会话的真实通知路径核验

时间：2026-10-09，北京时间。先核验并发送用户授权的一条真实测试通知；现场点击失败后，在此前确认的通知定位与错误日志范围内修复。未修改全局配置、模拟原生任务完成或释放真实会话。

## 通知来源

`C:/Users/Developer/work/sample-project/AGENTS.md:21` 和 dualview-navigation 工作树 `AGENTS.md:15` 要求 Codex 在每次运行结束时执行 `tools/notify_desktop.ps1`。两处脚本内容相同，使用 WinForms `NotifyIcon`，只接收 Title/Message，调用 `ShowBalloonTip(12000)`，维持消息泵约 12 秒后 Dispose。脚本没有会话地址、threadId、`BalloonTipClicked` 或打开浏览器的处理器。主工作区脚本第 1、6、11、13–22 行可核验。这套通知不能实现点击后定位会话。

Web 路径独立：`src/server/app.ts:270` 的 runtime notification → `src/server/push.ts:45` 的 Web Push → `public/sw.js:44` 创建浏览器通知 → `sw.js:46` 处理点击并聚焦会话、发送定位目标或打开带参数的会话页。`requireInteraction` 只属于这一条浏览器路径，不会改变项目托盘脚本。

未核验用户此前那一条通知的历史调用记录，因此不能仅凭截图断言其来源。上述脚本缺少点击处理是当前源码事实。

## 浏览器权限与订阅

Chrome 地址栏“通知：允许”是浏览器权限；还需要 Web 设置的“启用通知”或“重新启用 / 同步订阅”把 PushSubscription 注册到服务端。`src/web/Notifications.tsx:6–9` 只有 enable 操作会 POST `/api/push/subscriptions`；只授予浏览器权限不会完成该步骤。

本次核验受管服务 PID 38492，根目录为 `C:/Users/Developer/work/codex_web`，运行脚本固定数据目录 `.local/web`，不是另一工作树的库。初次只读查询订阅数为 0，用户点击同步后订阅数为 1，登录有效。未记录完整推送端点、密钥、Cookie 或令牌。

## 真实发送结果

测试目标为本会话上一轮真实已完成的最终答复，标题沿用现有“任务完成”：

- threadId：`3e5fa27e-1469-40df-a78a-7f53e89c5ed9`
- turnId：`626db121-33e5-46b2-a4c4-e574b9faf41c`
- itemId：`msg_03883c7b5f46d5d7016ac7f3010da4819994d6509d5d7abcf6`
- 事件：`manual-current-session-notification-20261009-once`

第一次发送在工具沙箱内返回 sent=0、removed=0、无成功 delivery，保留失败文件。随后无凭据的 FCM HTTPS 探测在沙箱中遭 EACCES；获准网络探测收到 HTTP 404。进行了唯一一次网络恢复投递，保持相同事件和目标，未盲目无限重试。

**04:31:03 恢复投递成功，FCM 返回 HTTP 201，sent=1、removed=0，delivery ledger=1。** 复用生产 `createPushService` 默认发送实现，服务 PID 不变。HTTP 201 证明推送服务接受，不能代替 Windows 展示、点击、激活和消息定位的验收。

用户现场结果：通知激活了其他会话标签页，实际地址为 `https://device.tail-example.ts.net/sessions/76f263af-cb4d-4c7d-a965-45cc79e2e34e`。**此次端到端点击验收失败。** 发送记录与当前 rollout ID、delivery ledger 的目标均为 `3e5fa27e-1469-40df-a78a-7f53e89c5ed9`，没有捕获当时浏览器 notification.data 或客户端快照，不能把发送记录当成已经完整捕获点击链路。

本地证据在 `.local/notification-current-session-20261009/`：`send-result.json` 是首次失败；`recovery-result.json` 和 `recovery-requests.json` 是恢复结果及脱敏 HTTP 状态；`errors.jsonl` 保留有界脱敏异常；一次性工具为 `notify.ts`。这些忽略目录中的证据保留，不作为发布文件。

## 已复现缺陷与修正方案

隔离 Chrome 154.0.8037.98 实测：页面先打开会话 A，再通过 `history.pushState` 切到 B，页面 `location` 为 B，而 `clients.matchAll` 得到的 `WindowClient.url` 仍为 A，clientId 不变；反向切换同样会漏掉真实目标。完整文档导航才产生新的 clientId 并使两者重新一致。证据为 `spa-client-url-probe.json` 与一次性探测脚本。此行为与 [W3C Client.url 定义](https://www.w3.org/TR/service-workers/#client-url)一致。

`src/web/navigation.ts` 使用 pushState；`public/sw.js` 按 Client.url 选标签页且先 focus，随后 `main.tsx` 用真实 location 检查并拒绝错误线程。当前 SW 的隔离模拟已复现“先激活错误会话，再等 5 秒尝试打开正确会话”。这证明有实际代码缺陷，但没有事故时刻的完整客户端状态，现场是否还有其他原因须保留未知。

该修正属于此前已确认的“通知激活对应会话、定位对应消息”范围：

1. Client.url 只用于同源边界，不能用于判断页面当前会话。SW 通过有界 MessageChannel 查询页面当前 threadId；页面校验发送方是本应用同源 `/sw.js`，按真实 location 回答。并行查询保持总等待有界，不逐页积累 5 秒。
2. 只向确认当前会话匹配的一个页面发送定位，收到目标接受确认后再激活；无匹配或页面已切走时打开带安全定位参数的目标新页，不导航或释放其他会话。
3. 保留最新点击优先、加载中 ready 补交付、端口与计时器清理、旧通知兼容。不同会话的连续点击也要验证最终焦点，不能只检查消息投递顺序。
4. 回归必须覆盖创建地址与当前 SPA 路由不一致的两个方向、多个标签、没有目标标签、目标页无响应和跨会话异步激活。先保留旧代码失败证据，再验证修正后的真实 Chrome/React 路由场景。

改动限定 `public/sw.js`、`src/web/main.tsx` 接收处理及通知相关测试/夹具，不新增后端接口或模型调用。运行过程精简方案尚待确认，不能混入本次通知修正。

## 发现的日志缺口与未做事项

`push.ts` 默认发送器把异常归为 statusCode，外层 catch 也只保留状态，现有 API 返回 sent/removed；此次首次失败无法由生产返回值复原原始异常。本次工具已补充脱敏请求观察和异常证据。按用户此前明确要求“哪怕正常模式也应该保留错误日志”，此次同时补齐产品 Push 错误日志：正常模式输出已有服务日志路径，诊断模式再写现有 Diagnostics，不要求开启诊断才有异常；保留有界、脱敏的异常 message/code/stack、线程 ID、provider HTTP 状态及尝试次数，禁止记录完整订阅端点、密钥、授权头和正文。

这项改动限定 `src/server/push.ts`、`src/server/app.ts` 的 Diagnostics 接入及相应 Push 测试，不改变推送去重、重试、过期订阅清理、DNS pin 与同源校验。日志写入本身失败不能改变投递结果。回归须覆盖真实发送器异常保留、普通模式、诊断模式、脱敏、有界输出和日志回调失败。

## 实施与验证结果

通知路由和 Push 日志已按上述范围完成。SW 并行查询同源顶层页面当前路由，先接受定位再聚焦；focus/openWindow 串行执行，避免旧点击的迟到激活覆盖新点击。默认发送器保留原异常，普通模式写 stderr，受管 Windows host 将其持久化到 `.local/web/server.log`；诊断模式同时写现有 Diagnostics。两个日志出口独立容错，异常字段有界且脱敏。

验证证据：

- 旧 SW 在新增的三个回归中全部失败；修正后 SW 相关测试 27/27，独立 VM 审查 4/4。
- Push 错误日志的旧实现在七个新增回归中全部失败；修正后 Push 相关测试 17/17，独立 VM 审查 3/3。包括真实默认发送器的受控 HTTPS 异常、普通日志、Diagnostics 写入读回、脱敏和日志出口失败。
- `npm run build` 成功；普通 Windows 权限下完整 `npm test`：563 项，558 通过、0 失败、0 取消、5 跳过，退出码 0。跳过项为四个 Linux 专用测试及一个已打包发布环境测试。
- 隔离真实 Chrome、React、HTTP、SSE、Service Worker 使用最终 `dist` 构建验证通过，退出码 0。覆盖 SPA 创建地址与当前路由错位、准确消息 DOM 定位、手动历史与刷新、登录恢复、加载中 ready 和移动端；错误标签仍保持原会话，通知探测前后 POST 数均为 10。该夹具调用实际 SW 的路由探测和目标交付函数，没有调用 notificationclick 或验证 Windows 最终活动窗口；异步激活由 SW/VM 测试验证，系统点击仍须现场验收。

最终浏览器结果在 `.local/notification-route-fix-20261009/browser-1791493540161/result.json`，完整测试在同目录 `full-normal-windows.log` 与 `.exit.txt`。独立审查分别保存在该目录及 `.local/push-error-log-20261009/independent-review.md`。

失败记录保留：沙箱中的完整测试为 562 项，549 通过、7 失败、1 取消、5 跳过，不计为通过；涉及 Windows 权限、启动与超时，详见 `full-summary.json` 和 `suite-intervention.json`。其中两个隔离 Git fetch helper（PID 38064、2604，04:46:14 创建）精确清理被 Windows 拒绝访问，未扩大杀进程范围。三次开发模式浏览器启动超时仍未通过，跟踪捕获到入口资源响应约 51–53 秒；发布构建验证没有替代或抹去这些失败。四次发布测试夹具前提失败（初始 POST 未完成一次、缓存导致 slow 模拟未命中三次）也保留在 `browser-attempts.json`，修正的是测试前提，最终没有放宽产品验收断言。

构建后的前端资源已在根工作区可用；现有服务 PID 38492 的后端日志改动须重启才加载。此前计划的重启结果文件 `.local/web/CodexWeb-Restart-f02bd0a2d7664b5dac233ee4881246f1.json.result.json` 在 **05:18:47** 记录 `status=failed`、`newPid=0`，原始原因字段为 `Shutdown refused or unconfirmed. Check for active sessions; no other process was stopped.`。没有验证新服务启动，也没有原生现场证据能把失败直接归因为活动任务；该结果未证明后端新日志代码已加载。

随后只读核验该次 worker 日志，只有预检 ready 与最终 failed，没有 HTTP 状态、原始异常或活动线程快照。`scripts/server-control.ts` 的停止请求 helper 会将网络错误、超时、非 200 及响应校验失败统一返回 null，再使用上述同一文案。因此当时原因无法从现有记录补回；这次没有为诊断重触发停止或 RPC，也没有更改停止 helper。

### 用户刷新后的真实通知复测

用户明确回复“已刷新，可以再测”后，使用新事件 `manual-current-session-notification-route-fix-20261009-retest-once`，仍定位上述稳定 threadId / turnId / itemId 的上一条已完成最终答复，没有模拟当前任务完成。发送前只读核验受管 PID 38492、数据目录 `.local/web`；服务返回的 `/sw.js` 与 `dist/sw.js`、`public/sw.js` SHA256 均为 `53371b1bea47069001b069eca0b47089cea039023b995ce220d929695ef57262`，线上 HTML 与 dist 均引用 `/assets/index-BI1YDWhH.js`。

**09:47:05 复测投递：两条有效订阅均返回 HTTP 201，sent=2、removed=0、delivery ledger=2。** 一次性工具复用生产 `createPushService` 默认发送器，实际捕获的安全 payload 字段与既定目标一致。两条订阅被推送服务接受只证明投递接受，不代表两个订阅都完成现场点击验收。

用户现场反馈“会话正确，高亮如图”。[现场截图](../../.local/web/uploads/085d4b13-b24c-432b-8d2a-3f995d2a2a1a.png)显示 Codex **2026/10/09 03:46:13** 的既定最终答复被绿色边框高亮，上方执行过程折叠。结合用户确认，本次用户浏览器现场的会话与指定答复定位验收通过；不推广为两个订阅、所有浏览器或所有平台均通过。证据保存在 `.local/notification-route-retest-20261009/` 的 `deployment-preflight.json`、`preflight.json`、`send-attempt.json`、`send-result.json`、`send-requests.json` 和 `manual-acceptance.json`。

之前 **04:31:03 的现场点击仍为失败**，原始失败证据继续保留，不能由后续成功改写。未修改游戏项目托盘脚本，未在未知结果下自动重发；本次结果记录更新没有发送通知或安排重启。运行展示另见 [精简展示方案](2026-10-09-running-process-compact.md)，不属于本次通知现场验收范围。

### 通知定位参数的一次性消费

用户确认定位成功后补充：URL 参数残留导致刷新再次定位。已复现实际 React 页面正确 focus 后仍留有 `notification/turnId/itemId/kind`；失败证据在 `.worktrees/compact-running/.local/notification-url-20261009/browser-1791511772960/failure.json`。

修正位于现有 App 与 Session 接口：定位成功、穷尽未找到或明确失败后，由 Session 通知 App 消费；等待登录、快照、旧历史或 SSE 时保留。App 核验当前 token、线程和所有位置字段，使用 `history.replaceState` 删除本次通知参数，不产生导航、popstate 或会话操作，其他 query/hash/history.state 保留。内存目标保留，清 URL 不会提前取消三秒高亮或收起已展开记录；旧异步处理不能删除新通知。

target 单测 2/2；最终源码的 dev 浏览器与最终 `dist` production fixture 均 PASS、退出 0，pageerror 为空。覆盖刷新不重新定位、内层工具目标、登录/快照/历史等待、定位失败终结、新旧通知竞争、旧高亮 timer，以及 query/hash/嵌套 state 与窄屏。证据为 `.worktrees/compact-running/.local/notification-url-20261009/browser-1791512632149/result.json`（dev）与 `browser-1791512828470/result.json`（production）。没有重复发送 Windows 系统通知；此前用户现场通过只说明那次通知选页和定位，不能作为此次 URL 消费的原生点击验收。

修复没有新增依赖、后台接口或通知发送路径；游戏项目的通知脚本保持原来的独立路径。环境及施工期失败保留：最初 TEMP 权限错误、施工中 UI 临时解析错误、一次 state 断言误将 App 自带字段也视为必须相等；最终断言验证原 state 的每个嵌套值保留，未删除产品行为验收。

### 主目录整合和实际构建验证

界面和 URL 两项各收为一个中文提交，快进整合到主目录；主目录 `npm run build` 退出 0。两个目录独立构建的资源哈希不同，因此另外验证实际 root dist，不能拿工作树结果代替部署验收。最终 root production fixture PASS、退出 0、pageerror 为空，证据 `.local/notification-url-20261009/browser-1791514323538/result.json`。

该测试的延迟加载场景原来给入口加查询参数以绕过缓存；实际 root 的懒加载模块会反向导入不带参数的入口，导致测试页面挂载两次。保持入口 URL，只对隔离 slow 页使用 Chrome 的资源缓存/SW fetch 绕过；原 SW 客户端枚举、ready、MessageChannel 交付和 ACK 仍实际执行。验证实际入口网络被 hold、加载前零快照读取、排队通知精确 focus、URL 已消费以及只读取一次快照。前五次 root 夹具前提失败全部留存在同证据目录，没有放宽产品行为断言。

运行中的受管服务 PID 38492 返回的 HTML、主 JS、runtime JS、CSS、SW 均 HTTP 200，SHA-256 与实际根目录新构建一致；证据 `.local/compact-deployment-20261009/served.json`。静态核验使用原生 HTTP 的 Host 请求；最初 Node fetch 的 Host 请求 403、最初跨目录哈希一致性假设失败分别保留，不更改服务的 Host 校验。未重复 Windows 新通知点击；已有现场定位成功与本次 URL/构建浏览器验证各自保留边界。

新增会话列表与工作区超时检查见 [只读调查](2026-10-09-session-and-git-timeout-investigation.md)，本次界面和 URL 修改没有修复其后台链路。重启安排成功不等于新进程启动成功，仍须重连后读取该次结果文件确认 `success`。
