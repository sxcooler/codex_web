# 会话列表与工作区偶发超时：只读调查

本轮先完成运行过程精简和通知 URL 消费，再核对追加问题的现有证据。重启前保全了受管服务 PID 38492 的脱敏日志；没有刷新真实会话、调用原生 RPC、修改后台或重启来试探原因。

## 结论

会话列表的共享状态拒绝与工作区超过读取预算是两条不同路径。这次 UI 交付和安排重启不能当作它们已修复。

| 问题 | 已确认 | 仍未知 |
| --- | --- | --- |
| 会话列表 | `/api/sessions` 多次返回 `SHARED_STATE_UNAVAILABLE`。主要 stack 对应两轮加载均发生版本变化；失败最多缓存 60 秒，后续客户端可在 1–3 ms 内直接收到同一错误。另有共享读取 30 秒 timer 来源。 | 事故时是哪类事件持续使列表失效；各 HTTP 与多页 native RPC 缺少共享 job 关联。 |
| 变更工作区 | `git/files` 存在 30,043 ms 客户端断开，也有 58,432 ms 服务端完成。长等待的多个采样中 `runtime.inFlight=0`、`native.pendingCount=0`，没有 30 秒级事件循环阻塞证据。 | 项目枚举、Git status、numstat、未跟踪文件读取、revision 等阶段各用了多久。不能断言是 Git status 或串行文件统计最慢。 |

日志保全中的 44 条列表错误包含多个客户端和缓存重放，不能视为 44 次独立故障。`statusCode=200/outcome=aborted` 只是连接关闭前的默认状态，不能当作浏览器成功收到响应。截图缺少精确请求时间，所列请求是同类问题的证据，未强行对应截图。

## 源码核对

`src/server/shared-client-state.ts` 只允许两轮 load；每轮结束校验 version，第二轮仍变化即返回 503；无可用缓存时后续请求重放错误，负缓存最长 60 秒，新的 invalidate 会清除它。不能只提高前端超时来修复这个拒绝路径。

`src/server/api.ts` 的 `saveMeta` 每次成功保存后都会 invalidate，即使是详情读取关联路径、值没有变化。这是一个具体候选触发源；现有日志没有记录 invalidation 原因，详情 GET 与失败 list 的时间关系只说明相容，尚不能认定为主要原因。

工作区调用链为 boundProject → header/cwd → project resolve/refresh → gitFiles。`src/projects.ts` 依次执行 status、必要的 numstat、逐个 untracked 文件安全读取、revision；每个 Git 命令的 30 秒预算不代表整个 HTTP 只有 30 秒。前端总读取预算为 30 秒，git/files 链目前未接入浏览器断开后的取消信号。路径、敏感文件校验和错误处理必须保留。

## 后续最小验证方案

先用离线 fake runtime 在两轮加载中注入 invalidate，复现拒绝和负缓存；检查无变化的元数据保存是否仍使共享列表失效，验证真实 title/project/fork 变化仍会通知更新。根据复现结果选择修订，保留版本校验，不能直接返回陈旧数据并称为最新。

再补诊断开启时的阶段耗时与共享 job/invalidation 关联：header、project resolve、status、numstat、untracked 读取累计与数量、revision，以及 version/尝试次数/失效原因。只记录匿名关联 key、计数和时长，不记录路径、内容、凭据。经确认的空闲窗口只读复现一次相关项目，再按实际慢阶段选择共享入口、有限并行或取消传播的最小改动。

以上是待确认的后续范围，本轮仅调查，尚未实施。当前证据不足以支持无条件延长超时或重写整个刷新机制。

## 证据与边界

完整报告与脱敏快照保存在 `.local/timeout-readonly-20261009/report.md`、`diagnostics-sanitized.jsonl`、`api-errors-sanitized.jsonl`、`source-evidence.txt` 和 `summary.json`。采集于 2026-10-09 10:35–10:42（北京时间），两个原日志各有界读取最后 6000 行；快速成功请求不一定被记录，不能据此计算总体失败率。源码片段与哈希对应调查时基线，本轮 UI 整合没有修改上述后台链路。代码图不足的部分以当前源文件核对；未重新索引或额外启动 MCP。
