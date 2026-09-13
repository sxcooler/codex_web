# 三栏工作区实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow the approved spec and track the tasks below.

**Goal:** 完成可恢复的双侧栏、只读 Git 图谱和 Markdown 文件预览。
**Architecture:** 后端扩展既有 Projects/Git 只读接口；前端复用布局和渲染组件，项目偏好与请求内容分离。
**Tech Stack:** TypeScript、React 19、Fastify、Git CLI、Streamdown、现有 Node test 与 Playwright。
**Spec:** docs/superpowers/specs/2026-09-11-workspace-panels-design.md

## Global Constraints

- 按用户确认保留“中止”；无需再次确认后续实施。
- 不新增直接依赖；不执行 Git 写操作；不持久化正文。
- 本次仅生成一个中文 commit，保留已有提交历史。

## Task 1：Git 历史接口

Files: src/projects.ts, src/server/api.ts, tests/git-history.test.ts。
接口：GET /api/sessions/:id/git/log?ref=HEAD|all|refs/…&cursor=… 返回 {repository,commits:[{id,parents,subject,author,date,refs}],branches:[{name,ref,current}],nextCursor}；GET /git/commit?commit=…&parent=… 返回 {commit:{id,parents,subject,message,author,date,refs},parent,files}；GET /git/commit/diff?commit=…&parent=…&path=… 返回既有 hunks/binary/truncated 结构。
- [x] 先用临时 Git 仓库写真实分支、合并、删除、根提交和边界断言，运行确认未实现失败。
- [x] 复用 git() 执行，解析结构化字段、校验 ref/commit/parent/path；分页冻结查询起点，分页结束不伪造连线。
- [x] 路由按既有鉴权和 session→project 解析方式接入；定向测试通过。

## Task 2：前端面板与预览

Files: src/web/PaneLayout.tsx, layout.ts, main.tsx, SessionView.tsx, GitPanel.tsx, Markdown.tsx, MarkdownView.tsx, Conversation.tsx, style.css；新增 src/web/GitHistory.tsx、gitGraph.ts、panelState.ts；删除已由共享组件替代的 MarkdownMessage.tsx。
- [x] 浏览器回归先验证重复标签点击/折叠后选择丢失，确认失败。
- [x] 共享布局增加左右可见性和抽屉状态，图标按钮对称；按钮分组靠右并保留中止文案。
- [x] 右栏按项目保存选择；各标签独立状态，保留加载内容并隔离过期响应。仅可见标签按需读取。
- [x] 日志消费 Task 1 接口，绘制真实父子 SVG 连线，分页/筛选/提交详情/父提交切换复用 diff。
- [x] Markdown 渲染提取可复用外壳，文件支持安全相对链接、源码切换；失败保留原文。

## Task 3：交付验证

Files: tests/workspace-panels.html, tests/layout.test.ts, tests/git-history.test.ts，以及现有 Markdown/发送回归。
- [x] 浏览器桌面和手机检查标签/选择/滚动恢复、刷新失败、项目隔离、重载、相对链接与图谱详情。
- [x] npm test；npm run build；生产资源验证；独立只读审查与必要修复。
- [x] 更新设计文档验收记录，git diff --check，保存一个中文提交。

## 执行记录

计划与规格先于代码写入。后端接口与前端布局可独立推进，接口形状以上述约定为准。当前 develop 工作目录为本次已授权的共享工作区，初始干净；不额外迁移工作树或改写旧提交。

## 验收记录（2026-09-11）

- `npm test`：138 项，137 通过、0 失败、1 跳过。跳过项为需独立便携发布包的运行验收，非本次功能测试。
- `npm run build`：TypeScript 与 Vite 通过。既有 Markdown/语法高亮依赖仍有大分块提示；主包约 263 kB，Markdown 按需加载；未增加依赖。
- Chrome：桌面 1600px、手机 390px 的完整页面通过折叠保留 DOM、标签选择、Markdown/源码切换、项目内相对链接、失败保留、图谱/合并父提交/diff、重载恢复、中止中状态与无横向溢出检查。
- `tests/workspace-panels.html`：通过日志/文件滚动恢复、加载中切标签、资源消失、项目隔离、消息渲染后文件链接、空格/字面百分号/井号/引用式链接与源码原样回归。
- `tests/git-history.html`、`tests/panes.html`：通过分页不重复请求、刷新不混淆资源、折叠与抽屉焦点回归；既有 Markdown 与发送页面在桌面/手机通过。模拟 Markdown/高亮模块加载失败时原文仍可读。
- 生产 `dist`：独立本机预览使用模拟 API，在实际 CSP（仅测试入口额外 script nonce）下通过桌面/手机完整流程，Markdown 与高亮分块正常加载，无页面异常。
- 独立只读审查发现并修复根提交 diff、精确历史文件路径、重命名、敏感路径、父仓库误发现、游标边界、布局极值、日志滚动、URL 解码与刷新状态问题；最终定向复核无剩余确定问题。
- 当前运行中的后端不会自动加载源码修改；新 Git 历史接口需后端重启后生效。本次未中断现有服务或会话。
