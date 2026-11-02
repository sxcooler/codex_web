# 已完成轮次误报中止验收报告

日期：2026-11-01。基线 `62e5c0f`，隔离分支 `fix/turn-completion-20261101`。实现与隔离验收已收口为一个中文需求提交；尚未合并、推送、部署或重启运行服务。

## 用户要求与文档先行

用户要求：“你先解决本轮已中止的问题吧，记得先落文档”。[设计](../../design/2026-11-01-turn-completion-reconciliation.md)和[计划](../plans/2026-11-01-turn-completion-reconciliation.md)先以 `e6d597e` 提交，随后才增加回归和产品修改。最终合并为一个中文需求提交时保留阶段提交说明。

原案例的 539,168 ms 轮次在页面显示中止，但持久化历史及独立原生 `thread/turns/list` 均确认 completed；只读探针没有调用 resume、发送或停止。此证据确认两端结果不一致，不证明首次错误 interrupted 的唯一生产来源。

## 实现与证据边界

- 完成通知与后续终态历史页冲突时，复用既有有界、single-flight 只读核对；失败期间保留原证据，不宣告完成或解锁发送。
- 已确认终态之后的迟到终态通知只要求重新同步，不直接覆盖页面结果；旧 started/item/delta 的终态保护继续保留。
- 用户明确重新同步时可以重新核对此前的失败；普通轮询不重置预算，不形成自动重试循环。
- 并发快照中，较旧读取若与较新已接受快照的终态头部不同，复用可重试同步错误；普通重叠读取继续成功。
- 真实 interrupted/failed 即使含 final_answer 也不变成 completed；不直接读取 SQLite 参与产品状态判定，不修改用户历史、依赖或写入接口。

## 验证结果

| 检查 | 实际结果 |
| --- | --- |
| 原始完整基线 | 1032 项：1027 通过、5 跳过、0 失败 |
| 新增 Node 回归 | 7 项均有对应 RED→GREEN；覆盖旧中止覆盖完成、迟到终态、真实失败/中止、核对失败、新轮活动、明确重试与并发快照 |
| 相关完整状态回归 | 174/174 通过，包含 `runtime.test.ts` 既有重叠读取、历史、接续、释放、客户端同步与结果判定 |
| 最终完整 Node | **1039 项：1034 通过、5 跳过、0 失败、0 取消** |
| SessionView/接续浏览器回归 | **45/45 通过**，其中 8 项为本次新增组合；初次 focused 4 项属于同一集合，不重复计数 |
| 类型与生产构建 | `npm run build -- --outDir .local/turn-completion-20261101/dist` 通过；保留既有超过 500 kB 的分块警告 |
| 独立审查 | 1 轮，2 项 Important 均复现并修复；无 Critical/Minor。修复通过 RED→GREEN 和全量回归验证，未做第二轮独审 |
| 差异检查 | `git diff --check` 通过；产品修改限定为 `src/codex/runtime.ts` |

### 浏览器入口与截图

Browser 访问 host 与原生管道不可用，因此使用项目现有 Playwright、独立 headless Edge、本机 fixture 服务；没有控制用户前台浏览器或向真实会话发送任务。

实际走过真实 SessionView 的初始中止显示 → SSE 要求重同步 → 权威完成，以及读取失败 → 键盘 Enter 点击“重新同步” → 带 restartHistory 的只读 GET → 完成恢复。检查最终回答、中止横幅、顶部空闲状态、发送锁定/恢复、草稿保留、历史真实中止和写请求不增加。

1440×900、390×900 × 简体中文/英文，两条新路径共 8 张截图均已查看。已完成结果不再显示中止，历史真实中止仍可见；操作菜单 Escape 返回焦点、手动重试键盘入口、控件可操作及相邻排列通过。窄屏保留既有标题和选择值截断，本次没有修改布局或文案。

### 首轮失败与暂停记录

审查修复后的首次完整 Node 为 1039 项：1033 通过、5 跳过、1 失败。失败用例 `overlapping snapshots retain the latest read in either completion order` 揭示并发保护过宽；随后只对终态头部差异拒绝旧快照，174 项相关回归及最终全量均通过。

其后用户要求暂停，正在运行的最终全量被 Ctrl+C 停止、退出 1；该次仅为中断运行，未计为通过，也没有补成完整分母。收到“继续”后单独重跑最终完整套件，得到上述 1034/5/0 结果。所有原始日志保留。

## 本机回执与未验证范围

忽略目录 `.local/turn-completion-20261101/` 保留 `progress.md`、`native-read.json`、各 RED/GREEN 日志、`baseline-full.log`、`review-full.log`、暂停中断的 `final-verified-full.log`、最终 `resumed-full.log`、`resumed-build.log`、`browser-full.log`、`browser-report.json` 及 `browser/` 截图。

未部署或重启线上服务，尚无“生产目标线程在新代码上恢复”的验收结论；首次错误 interrupted 的来源、真实通知频率、手机实机以及 Chrome/Firefox 未验证。压缩链路失败与泛化 UNKNOWN 权限提示均不在本次修复范围。
