# 会话前台核对、只读占用与最近对话验收

日期：2026-10-12。实施依据：[设计与最近文档核对](../design/2026-10-12-session-foreground-and-recency.md)。本次只改 Web/运行时读写边界与排序，不直接写原生数据库。

## 结果

- 只读打开、刷新、前台返回和离开不调用 open、cancel-release 或 release-on-leave；发送、审批、接续、执行目录切换等明确操作登记写入意图，与离开释放按会话串行。
- 前台核对合并在途请求，检查 epoch/revision；版本变化读快照，旧后台无版本字段也读快照。核对失败保留历史并暂停写入，不自动重发消息。
- 任务、连接和释放分开表达。运行中排队释放显示“任务结束后自动释放”，实际进入释放才显示“正在释放占用”。已确认运行的任务在单纯读取历史时允许中止，状态核对或读取失败期间仍锁定。
- 最近对话统一用 recencyAt，缺少时退回 createdAt；原生分页用 recency_at，收藏保持在前。旧请求值 updated_at 保留兼容；web2 游标使旧分页回到第一页一次。
- 晚到的新建/分支结果和连续 partial A/B 均保留释放处理。目录操作在等待历史前登记，避免快速离开漏释放；占用请求有 30 秒期限。

## 验证

| 检查 | 实际结果与证据 |
| --- | --- |
| Node 全套 | `node --test --test-concurrency=4 tests/*.test.ts`：748 项，743 通过、5 跳过、0 失败、0 取消；[日志](../../.local/session-foreground-node-final.log) |
| 既有 Playwright 场景 | 最后广泛运行 41 项：38 通过、3 失败；三项均为旧夹具/定位假设，修正后定点重跑 3/3 通过。未另跑一次单次 41/41。[广泛日志](../../.local/session-foreground-playwright-final.log)、[重跑日志](../../.local/session-foreground-playwright-recheck.log) |
| 新前台/只读/排序 Chrome | 通过；覆盖旧后台兼容、旧游标、核对门控、失败保留历史、浏览不改占用、明确写入、晚到目录写入及连续 partial 释放。[日志](../../.local/session-foreground-browser-final.log) |
| 新任务启动 Chrome | 通过；含延迟 5.2 秒历史读取、即时快照/SSE、去重、读取历史期间中止、10/12 秒 resync 总预算、晚到/partial、1280/390 宽度。[日志](../../.local/session-foreground-new-task-final.log) |
| 多会话运行时/HTTP/SSE | 真实 Runtime + HTTP/SSE + 模拟 Native 的 Chrome 回归通过；含原生页安静、忙任务保护、退出交接、只读重入。[日志](../../.local/session-foreground-runtime-browser.log) |
| 原生项目与目录超时 | 自动目录项目、删除手动入口、目录交接、预览桌面/手机回归通过；cwd 和 open 两种人工超时均能恢复且不重试写入。[项目日志](../../.local/session-foreground-native-projects.log)、[超时日志](../../.local/session-foreground-cwd-browser.log) |
| 类型/构建 | `npx tsc --noEmit`、生产 Vite 构建、`git diff --check` 通过。[构建日志](../../.local/session-foreground-build.log)。构建保留已有 hashed 资源，避免已打开页面的旧分块 404；仍有既存大分块警告。 |
| 独立审查 | 已修复目录登记过晚、核对时审批未锁、占用请求无期限、连续 partial 覆盖及历史读取误禁中止。最后只读定点复核未发现明确余项。 |

保留失败分母：最初 Node 运行出现两项旧排序夹具不匹配及 Windows 高并发夹具超时；调整夹具后，Windows 单独通过，最终使用并发 4 的完整运行通过。最初广泛浏览器运行 22 通过/19 失败，含旧自动 open 假设、夹具缺项、定位与冷启动问题；修正后结果如表。人工期限测试缩短请求期限以验证恢复路径，不能视为真实服务超时验收。

## dist 与后台

线上 `https://device.tail-example.ts.net/` 首页返回 200，SHA256 为 `d89e59b0a65faae8e2154cd9f645dea1f809b0e2f1caf3003bb703b13b91182d`，与 dist/index.html 相同。引用的 `index-CvvwuDBm.js`、`rolldown-runtime-hePW80VL.js`、`index-fbiRxS-v.css` 及图标均返回 200，字节与磁盘产物一致。直接 127.0.0.1 请求被既有 host 校验拒绝为 403，改用已配置线上域名验证通过。

15:48:05（北京时间）只读诊断样本仍为 Web PID 11252 / Native PID 26592，记录两条 RUNNING、一条 IDLE。样本是后台状态，不额外证明原生所有任务空闲。因此未强制重启，也未再次安排已知忙时重启。前端 dist 生效；新后台接口、recency_at 原生分页及此前自动项目维护尚未激活，仍待受管 RequireIdle 重启。旧后台兼容分支已覆盖。

此前 07:34 重启结果为 failed，原因为 shutdown refused or unconfirmed，newPid 为 0；[原始重启结果](../../.local/web/CodexWeb-Restart-4a2eb4faccc34163b75ff9bb0138c822.json.result.json)。本轮构建/部署边界见 [结果 JSON](../../.local/web/session-foreground-deployment-result.json)。调度成功不能代替读取结果为 success 后的验收。

## 用户追问：“本轮失败”是否真实

只读核对原生会话 `d3e15291-b60e-4d6d-a9f0-f263bec27a06` 的完整 rollout，共 9,179 条可解析记录（核对时）。原生存储文件为 `C:/Users/Developer/.codex/sessions/2026/10/11/rollout-2026-10-11T10-44-35-d3e15291-b60e-4d6d-a9f0-f263bec27a06.jsonl`；不是通过重新 resume 生成的结果，也未修改原生状态。

| 原生记录位置 | 北京时间 | turn_id | 原生结束事件 |
| --- | --- | --- | --- |
| 第 9,136 行 | 15:29:09.224 | 83c0bc17-e7bd-4501-abb7-4758a627c810 | task_complete，error.message = Selected model is at capacity. Please try a different model.；codex_error_info = server_overloaded |
| 第 9,145 行 | 15:35:17.159 | 96d42bd2-ad4a-45dd-accf-1d6f4b203803 | 同一错误，运行 15.244 秒后结束 |

第一条 duration_ms 为 6,770,101，即 1 小时 52 分 50 秒，与截图相符。Web `Conversation.tsx` 的 ExecutionGroup 使用所在 turn.status：failed 显示“本轮失败”；同一轮拆成多个执行过程块时，每块都显示这一轮的结束状态，因此不能把多个标签当成多次独立失败。这个标签未展示错误原因，截图本身无法区分服务故障和工作结果。

结论：原生模型执行确实因过载结束；不是根据测试输出推测，也不表示已经落盘的代码、构建或全部工具过程失败。原生错误与本地测试结果是两个维度。官方 [OpenAI 错误说明](https://developers.openai.com/api/docs/guides/error-codes) 将模型过载列为暂时服务故障；本次记录未提供 HTTP 状态码，不能由文档反推具体响应码。本轮只核对原因，未另改执行过程 UI；没有查看官方桌面窗口，证据来自它共享的原生会话记录。

## 边界

真实运行会话没有作为写入、审批或接管试验对象；未进行实体手机验收。线上后台版本尚未切换，不能把夹具通过表述成线上端到端部署完成。与本任务无关的未跟踪文档 `2026-10-09-git-files-performance-investigation.md` 保持不变且不提交。
