# 重启关闭失败导致 502

2026-10-09。用户报告重启后 502，并明确授权本次修复完成后安排重启。

## 现场证据

11:45:30 的重启结果为 failed、newPid=0，原因为 `Shutdown is taking longer than expected; inspect server.log. No process was forcibly killed.`，不能视为新服务启动成功。

11:45:18 的 server.log 保留原异常：`App-server shutdown timed out after 5000 ms; attempted to stop owned child`，对应 `src/codex/app-server.ts:214`。现场受管原服务 PID 38492 仍以 `scripts/server-control.ts --worker --diagnostics` 存活，只有私有控制端口 58059，Web 端口 3000 已无监听。

错误沿原生关闭、Runtime.close、API onClose 传到 app.close。scripts/server-control.ts 的 shutdown 将控制端口关闭和受管记录删除放在 await app.close 之后，因此被拒绝跳过。控制口仍回应状态，停止命令等待十五秒失败，重启 worker 未进入启动步骤。这是已证实的半关闭状态。

已有原生关闭超时测试正确验证拒绝与 owned-child 处理，却没有把该错误传到真实受管 worker，检验控制口、记录和进程退出。此前通知测试和浏览器验证不能代替这项关闭生命周期验证。

## 最小修复

- scripts/server-control.ts：app.close 使用 try/finally，无论关闭成功或失败都结束本实例控制口，并只删除 token 仍匹配的本实例记录。保留关闭原异常和非零退出码。
- src/server/api.ts：runtime.close 使用 try/finally，保证 metadata.close 执行。保留原错误，不把原生关闭失败记录成正常退出。
- 不更改原生五秒期限，不增加正常重启中的主服务强杀回退，不处理其他项目或其他 Node 进程。

## 验证

先新增真实隔离 worker 回归：fixture Web 端口关闭后 close 拒绝，要求控制口关闭、匹配记录删除、worker 有界失败退出且 stderr 保留原错误。旧代码必须复现 Web 已关但控制口仍活。保留正常关闭、空闲拒绝与身份/token 校验回归，并验证 API 关闭异常仍释放 metadata。

修复后运行相关测试和构建，实际 Windows 服务恢复必须核验新 PID、端口、HTTP；本机 HTTP 和用户访问域名都要检查，不能只检查控制口或只看测试数。

当前半关闭旧进程不能通过修改磁盘代码加载修复。现场恢复必须再次校验原受管控制身份、创建时间、命令路径和 Web 无监听；限定处理本次已停止接单的原服务，不扩大到进程树或其他 Node。恢复和正常重启的每一步记录实际结果；安排成功后立即结束回复，后续只以结果文件 success 判定重启成功。

## 实施验证

两处 finally 已实施，未改原生五秒超时与正常重启的安全门。

新增两项回归在旧代码上均失败、修正后均通过。真实隔离 worker 的旧状态为 Web 无监听、控制仍监听、记录仍存在、未退出；修正后 Web 与控制均无监听、记录删除、进程以 1 有界退出，stderr 保留原 native-close-failure。API 回归先实际查询 SQLite 成功，再验证关闭传播同一原异常且数据库已关闭。

background-server、shared-client-state、api 三个相关测试文件共 39 项全部通过、零失败、零取消、零跳过。正常启停、空闲拒绝、跨源拒绝与 token 身份验证回归保留。`npm run build`、`git diff --check` 通过，独立源码审查无阻塞。

证据：`.local/restart-close-audit-20261009/regression-before.txt`、`regression-after.txt`、`related-tests.txt`、`build.log`。

现场原 PID 的创建时间按 UTC ticks 与原重启请求匹配；JSON 时间字符串尾随零不同，不能按文本判定进程变化。即时证据在 `.local/restart-close-failure-20261009/pre-recovery.json`：原 PID 仅有控制监听，本机 Web 拒连，实际用户域名 HTTP 502。先前 request 的 requireIdle=true，控制停止已被接受后才发生关闭超时。

此半关闭旧实例已不能通过常规重启预检；本次恢复限定再次验证后的确切原 PID，使用正式受管启动脚本。该现场恢复本身完成本次授权重启，不重复安排另一轮重启。

## 实际恢复结果

12:05:37 即时复核受管认证、项目路径、UTC 创建时间、原空闲停止已接受、Web 无监听后，仅停止半关闭原 PID 38492；原 PID 和控制端口 58059 均消失。此动作是对既有故障实例的一次性恢复，不是向正常重启脚本增加强杀回退；没有处理其他 Node 或任何子进程树。

正式隐藏后台启动返回退出码 0，12:05:39 新受管 PID 13772 就绪，Web 端口 3000 与控制端口 57589 均属于新 PID，诊断模式开启。12:07:08 最终 HTTP 验证：本机原生 http.request 明确发送配置 Host，认证端点 200；实际用户域名认证端点 200。主会话独立检查原域名首页和认证端点均 200。

[recovery.json](../../.local/restart-close-failure-20261009/recovery.json) 记录 success 和完整动作。原 RequireIdle 失败结果保留未改。辅助脚本首次相对导入错误、fetch 未正确发送自定义 Host 导致本机 403 的探测失败均保留；改用原生明确 Host 请求验证，未加入转发头或弱化同源校验，也没有因此重启新服务。

原生五秒关闭超时的上游原因尚未修复；本次保证其异常不会跳过上述 Web 生命周期清理，不能据此宣称原生进程正常退出。未重跑无关全量测试，也未重做真实 OS 通知点击。
