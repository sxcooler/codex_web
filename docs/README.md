# 文档索引

[中文首页](../README.md) · [English README](../README_EN.md)

当前操作说明与历史证据分开维护；具体平台支持以最新验证记录为准。历史版本、测试数与环境不推断成当前机器状态。英文首页完整对应中文，详细文档本轮保持中文。

## 使用指南

- [源码运行与私网部署](guides/deployment.md)：配置、Windows/Linux 差异、HTTPS、备份和故障处理。
- [Windows x64 便携包](guides/windows-portable.md)：安装选择、启动、打包与独立产物验证。
- [会话操作](guides/sessions.md)：打开、继续、中止、释放与失败恢复。
- [公开发布](guides/publishing.md)：干净源码、新仓库与隐私审查范围。

## 当前设计

- [架构](design/architecture.md)：模块、原生 Thread 与访问边界。
- [会话工作区](design/session-workspace.md)：第二阶段流程、模型/权限、附件、报告与通知。
- [会话同步与性能](design/session-sync.md)：水位、回放、gzip、历史分页、按需输出与列表性能。
- [工作区面板](design/workspace-panels.md)：布局、项目阅读状态、Git 历史与文件预览。
- [Markdown](design/markdown.md) 与 [执行过程](design/execution-process.md)：渲染、安全、折叠和可访问性。
- [Linux 支持与文档整理](design/linux-support-and-docs.md)：已批准方案、便携安装补充和实施清单。

## 验证与归档

- [2026-09-13 Linux 验证](verification/2026-09-13-linux.md)：本轮实际环境、自动化测试、真实任务和验证边界。
- [2026-09-11 第二阶段验收](verification/2026-09-11-phase2.md)：代码/模拟浏览器通过与真实接力、手机 Push 缺口。
- [2026-09-09 MVP 验证](verification/2026-09-09-mvp.md)：协议、认证和完整 MVP 的原始版本与真实证据。
- [初始设计归档](archive/initial-design.md)：合并原始 handoff 与初始规格，保留独有约束、环境、暂缓项和早期取舍。
- [MVP 实施归档](archive/mvp-implementation.md)：协议、认证与完整 MVP 的阶段接口和完成状态。

后续已实施专项设计优先于早期规划：窗口分页取代“暂不分页”；64KiB SSE 回放与原拟 8MiB 缓存预算分别记录；Markdown 已共享外壳。历史“Windows 开发机”是原场景，当前平台定位见首页。历史审批预设、接口草案与旧模块名仅用于追溯。

## 旧路径与章节映射

以下旧路径仅用于迁移追溯，不继续保留第二套正文。`specs/`、`plans/` 均原属 `docs/superpowers/`。归档的前阶段未完成项保留原始时间，后阶段结果优先。

| 原文件 | 新位置与章节 |
| --- | --- |
| `docs/deployment.md` | [guides/deployment.md](guides/deployment.md)：正文与历史实施/验收附录 |
| `docs/portable.md` | [guides/windows-portable.md](guides/windows-portable.md)：正文与历史实施/验收附录 |
| `docs/session-lifecycle.md` | [guides/sessions.md](guides/sessions.md)：正文与历史实施/验收附录 |
| `docs/privacy-review.md` | [guides/publishing.md](guides/publishing.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-11-execution-process-design.md` | [design/execution-process.md](design/execution-process.md)：正文与历史实施/验收附录 |
| `design-qa.md` | [verification/2026-09-11-phase2.md](verification/2026-09-11-phase2.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-13-linux-support-and-docs-design.md` | [design/linux-support-and-docs.md](design/linux-support-and-docs.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-markdown-rendering.md` | [design/markdown.md](design/markdown.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-08-codex-remote-web-design.md` | [archive/initial-design.md](archive/initial-design.md)：初始设计正文 |
| `docs/codex_remote_web_handoff.md` | [archive/initial-design.md](archive/initial-design.md)：原 handoff 独有需求与差异 |
| `docs/superpowers/specs/2026-09-11-phase2-design.md` | [design/session-workspace.md](design/session-workspace.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-phase2.md` | [design/session-workspace.md](design/session-workspace.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-11-session-sync-design.md` | [design/session-sync.md](design/session-sync.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-session-sync.md` | [design/session-sync.md](design/session-sync.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-11-session-performance-design.md` | [design/session-sync.md](design/session-sync.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-session-performance.md` | [design/session-sync.md](design/session-sync.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-11-workspace-panels-design.md` | [design/workspace-panels.md](design/workspace-panels.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-workspace-panels.md` | [design/workspace-panels.md](design/workspace-panels.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-09-phase0-protocol.md` | [archive/mvp-implementation.md](archive/mvp-implementation.md)：协议实施阶段 |
| `docs/superpowers/plans/2026-09-09-phase1-auth.md` | [archive/mvp-implementation.md](archive/mvp-implementation.md)：认证阶段 |
| `docs/superpowers/plans/2026-09-09-mvp.md` | [archive/mvp-implementation.md](archive/mvp-implementation.md)：完整 MVP 阶段 |
| `docs/compatibility/2026-09-09-phase0.md` | [verification/2026-09-09-mvp.md](verification/2026-09-09-mvp.md)：Phase 0 协议与会话接力 |
| `docs/compatibility/2026-09-09-phase1-auth.md` | [verification/2026-09-09-mvp.md](verification/2026-09-09-mvp.md)：认证阶段 |
| `docs/compatibility/2026-09-09-mvp.md` | [verification/2026-09-09-mvp.md](verification/2026-09-09-mvp.md)：完整 MVP 阶段 |
