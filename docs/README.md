# 文档索引

[中文首页](../README.md) · [English README](../README_EN.md)

当前操作说明与历史证据分开维护；具体平台支持以最新验证记录为准。历史版本、测试数与环境不推断成当前机器状态。英文首页完整对应中文，详细文档本轮保持中文。

## 使用指南

- [源码运行与私网部署](guides/deployment.md)：配置、Windows/Linux 差异、HTTPS、备份和故障处理。
- [Windows / Linux x64 便携包](guides/portable.md)：安装选择、启动、打包与独立产物验证；[双平台验收](verification/2026-09-13-portable.md)。
- [会话操作](guides/sessions.md)：打开、继续、中止、释放与失败恢复。
- [公开发布](guides/publishing.md)：干净源码、新仓库与隐私审查范围。

## 当前设计

- [多访问地址](design/multiple-origins.md)：localhost 与 HTTPS 白名单、Cookie/CSRF 边界和首次可选域名。

- [当前用户后台运行](design/background-running.md)：源码/便携启停、首次偏好、用户启动项及迁移。

- [Codex 用量与重置机会](design/account-usage.md)：顶栏入口、手机面板、二次确认与幂等恢复。
- [架构](design/architecture.md)：模块、原生 Thread 与访问边界。
- [会话工作区](design/session-workspace.md)：第二阶段流程、模型/权限、附件、报告与通知；2026-09-22 固定单行顶栏与输入区收起方案待确认，含 mock 原型图。
- [会话同步与性能](design/session-sync.md)：水位、回放、gzip、历史分页、按需输出与列表性能。
- [工作区面板](design/workspace-panels.md)：布局、项目阅读状态、Git 历史、三标签图片预览、忽略文件显示，以及统一刷新与异步 fetch。
- [Markdown](design/markdown.md) 与 [执行过程](design/execution-process.md)：渲染、安全、折叠和可访问性。
- [Linux 支持与文档整理](design/linux-support-and-docs.md)：已批准方案、便携安装补充和实施清单。

## 验证与归档

- [2026-09-20 功能链路性能审计](verification/2026-09-20-performance-audit.md)：全量读取、Git 统计、请求取消及阅读缓存的根因与回归。

- [2026-09-20 0.1.4 发布验证](verification/2026-09-20-release-014.md)：多地址、历史图片、文件预览性能及双平台发布检查。
- [2026-09-13 Linux 验证](verification/2026-09-13-linux.md)：本轮实际环境、自动化测试、真实任务和验证边界。
- [2026-09-11 第二阶段验收](verification/2026-09-11-phase2.md)：代码/模拟浏览器通过与真实接力、手机 Push 缺口。
- [2026-09-09 MVP 验证](verification/2026-09-09-mvp.md)：协议、认证和完整 MVP 的原始版本与真实证据。

后续已实施专项设计优先于早期规划：窗口分页取代“暂不分页”；64KiB SSE 回放与原拟 8MiB 缓存预算分别记录；Markdown 已共享外壳。历史“Windows 开发机”是原场景，当前平台定位见首页。历史审批预设、接口草案与旧模块名仅用于追溯。

## 旧路径与章节映射

以下旧路径仅用于迁移追溯，不继续保留第二套正文。`specs/`、`plans/` 均原属 `docs/superpowers/`。归档的前阶段未完成项保留原始时间，后阶段结果优先。

| 原文件 | 新位置与章节 |
| --- | --- |
| `docs/deployment.md` | [guides/deployment.md](guides/deployment.md)：正文与历史实施/验收附录 |
| `docs/portable.md` | [guides/portable.md](guides/portable.md)：正文与历史实施/验收附录 |
| `docs/session-lifecycle.md` | [guides/sessions.md](guides/sessions.md)：正文与历史实施/验收附录 |
| `docs/privacy-review.md` | [guides/publishing.md](guides/publishing.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-11-execution-process-design.md` | [design/execution-process.md](design/execution-process.md)：正文与历史实施/验收附录 |
| `design-qa.md` | [verification/2026-09-11-phase2.md](verification/2026-09-11-phase2.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-13-linux-support-and-docs-design.md` | [design/linux-support-and-docs.md](design/linux-support-and-docs.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-markdown-rendering.md` | [design/markdown.md](design/markdown.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-11-phase2-design.md` | [design/session-workspace.md](design/session-workspace.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-phase2.md` | [design/session-workspace.md](design/session-workspace.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-11-session-sync-design.md` | [design/session-sync.md](design/session-sync.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-session-sync.md` | [design/session-sync.md](design/session-sync.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-11-session-performance-design.md` | [design/session-sync.md](design/session-sync.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-session-performance.md` | [design/session-sync.md](design/session-sync.md)：正文与历史实施/验收附录 |
| `docs/superpowers/specs/2026-09-11-workspace-panels-design.md` | [design/workspace-panels.md](design/workspace-panels.md)：正文与历史实施/验收附录 |
| `docs/superpowers/plans/2026-09-11-workspace-panels.md` | [design/workspace-panels.md](design/workspace-panels.md)：正文与历史实施/验收附录 |
| `docs/compatibility/2026-09-09-phase0.md` | [verification/2026-09-09-mvp.md](verification/2026-09-09-mvp.md)：Phase 0 协议与会话接力 |
| `docs/compatibility/2026-09-09-phase1-auth.md` | [verification/2026-09-09-mvp.md](verification/2026-09-09-mvp.md)：认证阶段 |
| `docs/compatibility/2026-09-09-mvp.md` | [verification/2026-09-09-mvp.md](verification/2026-09-09-mvp.md)：完整 MVP 阶段 |
