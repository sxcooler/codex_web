# 执行计划：整轮过程、通知定位与线程交接

基线 11e0521475d14bd8babe435c866a7e9dc7b856a2。用户于 2026-10-09 明确批准实施并完成后安排重启；随后修正：运行中展示过程，完成后收起。三份 docs/design/2026-10-09-* 方案与这条修正是规范。

## 全局约束

主会话设计与协调；子 agent gpt-6.1-sol/high 实施。复用干净的 shared-client-state 工作树，保留旧证据。每需求一个中文最终提交，先不提交，冻结审查后统一提交。不要改真实活动会话、全局 CODEX_HOME/代理配置或重启。无额外依赖。原生诊断只在 worktree.local 内隔离配置、存档和文件；不发真实用户任务或真实模型请求。真实系统通知仅使用无正文的隔离验证事件。

## 任务与文件所有权

1. 过程折叠：Conversation.tsx、过程样式、过程/消息浏览器回归和纯分类单测。运行中默认展示中间说明与工具；inProgress 转终态时自动收起一次；终态手动展开不被后续 SSE 重置。commentary 进入过程，final_answer 外显，旧 phase 缺失终态至少外显末条普通助手消息；用户插话/交互/结果保持顺序。保留图片、文件链接、复制、延迟命令输出。原生 duration 优先，不补造缺失时间。
2. 通知定位：public/sw.js、server/push.ts、web/main.tsx 与 SessionView.tsx、必要的目标解析辅助及通知回归。持久通知偏好、显式结构化目标、已有同会话页聚焦+消息、无同会话页开新安全本地链接、登录后继续定位。按现有历史分页最多5页、失败明确提示。定位暂时关闭自动滚底，展开目标过程后滚动/聚焦/短时高亮。旧通知仅threadId兼容。不得自动发送消息/释放另一个任务。不改 Runtime，由任务3添加通知字段。
3. 原生交接：runtime.ts、必要的只读 writer 检查及 Runtime/原生隔离测试；兼任 Runtime 的通知事件字段产生。AppServer 本身沿用原实现，只在 Runtime 自有默认子进程参数中设置 thread_unload_delay_secs=0。unsubscribe 或 thread/closed 不能单独证明释放。共享进程中的其它任务保持活动；失败/证据不足继续待释放并记原因。禁止每线程新建 AppServer/MCP 或杀共享进程；释放时的只读 Windows 检查辅助进程短暂存在并有完整清理。

## 交叉接口

| 任务 | 产生/消费 | 约定 |
| --- | --- | --- |
| 1/2 | Conversation锚点及展开 | TurnMessages支持可选 revealItemId/revealToken；稳定 data-turn-id/data-item-id；用户输入/异步交互不被折叠。Session传入属于该turn的定位item和重复点击token。审批卡片 data-request-id 由任务2的Session负责。若更小接口需先主会话裁定。 |
| 2/3 | Runtime通知→Push→SW→页面 | 保留现有threadId/eventKey/kind，增加可选 turnId/itemId/requestId 显式字段；数字requestId在Runtime产生处转换字符串。不解析eventKey，不传正文/路径。旧调用缺定位仍可打开会话。 |
| 1/3 | 释放与渲染 | Session release status不再依赖整进程退出的新假设，只有handoffReady确认证据成立才显示已释放；本轮正常同步字段和审批保护保持。 |
| 所有 | 同文件/验证 | Conversation/style只任务1；main/Session/push/SW只任务2；Runtime/AppServer只任务3。每人自己的定向RED→GREEN；源码冻结后交叉独立复核，整合全套一次，必要失败增量。 |

## 完成顺序

各任务报告精确源码哈希、差异、失败与通过证据、未实测边界；不自行spawn reviewer。独立交叉复核与整合浏览器流程通过后提交，每项一个中文commit。根目录master仍clean且基线不变才快进集成，真实root build并核对公共static字节。最后主会话调用规定的 restart-server.ps1 -RequireIdle，成功安排后告知北京时间和结果文件并立即结束回复。重连后读结果，success才代表重启验证成功。

## 执行结果与证据边界

三项实现均已通过独立交叉审查。过程最终包 `.local/turn-activity-final-v2`、通知最终包 `.local/notification-navigation-final-v3`、原生交接最终包 `.local/native-handoff-final-20261009-v2`；既有测试时序修正包 `.local/test-timing-repair-final` 另经非作者审查。过程有实际 Chrome 1280/390px 生命周期和 21 项消息回归；通知有 18 项定向及实际 Chrome/HTTP/SSE/Service Worker 定位回归；原生隔离验证 A 交接、B 同 PID 持锁和 A 恢复，无认证复制或模型请求。真实 B 为加载空闲，持续忙 B 由协议夹具覆盖。

独立审查修复了关闭失败时辅助清理遗漏、通知等待既有读取、失败通知错误定位到普通答复三处边界；实质 RED 和中间版本证据全部保留。最初沙箱全套遇到路径权限/本地夹具访问失败，提前停止，不能计完整分母。获准隔离全套首次为 547 项、540 通过、2 失败、5 跳过；两处既有测试错误耦合已查证：冷启动混进 80ms 超时、将 startTurn 接受确认误作瞬时完成。修正仅测试前提并保留不重试、目录重校验和权限边界，定向 48/48 及独立审查通过。

最终完整 Node 回归为 547 项：542 通过、0 失败、5 跳过，exit 0；日志 `.local/turn-notification-handoff-20261009/final-checks/full-suite-final.log`。没有把此前失败从分母中抹去。源码冻结后未再改生产代码；主目录快进、根目录构建/静态字节核对和规定的空闲检查重启是最终部署步骤，重启安排不等于重启成功。

真实 Windows 通知定位未确认：登记成功，但隔离探针未捕获目标焦点；用户反馈已点击但未观察，点击时刻相对探针截止未知。协议 GREEN 不当作 OS 端到端成功，不推断故障原因或系统停留时长。旧生产 500 的历史准确原因及旧真实会话恢复也不由隔离验证证明。
