# 会话性能优化实施计划

Spec: ../specs/2026-09-11-session-performance-design.md

## 全局约束

不新增依赖，不重启运行服务，不改原生执行与权限语义。当前 develop 工作目录为本次授权改动位置。基线 bc156cc，最终合并为一个中文 commit，保留已有 commit。先写设计，再写实现。接口以设计文档为准。

### Task 1: 服务端窗口历史与输出按需读取

修改 src/codex/runtime.ts、src/server/api.ts 及相关测试。保留内部全量 snapshot 调用语义，增加供 GET 会话使用的窗口选项/方法。全量轻量头用于状态基线，正文只读取最近 20 轮；history.before 使用轮次 ID，每次向前 20 轮。GET history 返回 turns/nextCursor，不改变基线；output 返回指定 commandExecution 的原文，不回退加载整个对话。已完成大命令裁剪应用于浏览器快照、历史页、SSE，内部快照合并 journal 仍使用完整数据。标记 outputDeferred/outputChars/outputBytes，预览2048字符，阈值8192字节。路由参数严格校验。维护 epoch、水位、活动状态与未持久化空会话行为。最小测试覆盖分页、非法游标、按需输出、状态稳定和大终态事件。

### Task 2: HTTP 压缩与指标

修改 src/server/app.ts，必要时添加 src/server/response.ts；使用 zlib 异步 gzip。1KiB 阈值，明确协商、禁用与排除规则，保留缓存/CSP/no-store。Server-Timing 提供 app/gzip 时长，字节指标应等于真实发送体。添加独立 Node 测试覆盖压缩还原及边界。

### Task 3: 前端分页与输出交互

修改 SessionView.tsx、Conversation.tsx、sessionSync.ts（如需）及 CSS。首次最近窗口；顶部加载更早按钮，合并旧页不覆盖实时事件，保持滚动锚点，阻止并发与过期响应。Message 接收 turnId，展开延迟加载并缓存命令原文，提供加载/错误重试状态，切换卸载取消请求。无 descriptor 的已有小输出按现状显示。增加生产资源浏览器模拟测试覆盖上述行为及增量同步兼容。

### Task 4: 验证与复核

执行 npm test、npm run build；桌面/移动 Chrome 浏览器测试；独立只读审查实现与设计，修复发现。回填设计验收记录，检查 git diff，提交一个中文 commit。若产物重生成，应在最终提交后打包并验证归档与解压运行。
