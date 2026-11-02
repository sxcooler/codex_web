# 长文本粘贴 Markdown 附件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主输入框粘贴至少 5000 UTF-16 单位的纯文本时生成真实 `.md` 附件，并补记已实施的 1280px 抽屉规则。

**Architecture:** 复用 Attachments、现有上传/claim/attachmentIds、草稿缓存及 PreviewShell；无新接口或依赖。官方桌面版阈值证据及内容/失败边界见规格 11.2，1280px 历史见 11.1。用户已授权文档与实施，持续执行并最终收口为一个中文提交。

**Tech Stack:** TypeScript、React、Fastify、现有 Node tests 与 Playwright/Edge。

**Spec:** `docs/design/2026-10-28-extensions-and-rich-content.arch.md` 第 11 节。

## Global Constraints

- `text.length >= 5000`；`.md` / `text/markdown`；不 trim、不修改原文/CRLF、不清空旧草稿、不重复发送全文。
- 沿用 15 MiB/5 件/75 MiB 与服务端信任边界；失败保留 File，预检失败也可恢复；预览源码最多 256 KiB，完整下载不截断。
- 仅主 textarea 文本粘贴；禁用时不上传；图片、短文本、其他控件保留现有行为。既有 1280px 布局及 1000px 输入规则不再修改。
- 不调用真实模型、不改真实技能/账号、不重启或发布；最终合入干净主分支后重建主目录 dist。

## Review Focus

- 中文/emoji/CRLF 的计数与 UTF-8 文件字节不同：边界与原文往返断言。
- 预检超限、服务器拒绝或网络失败不能吞长文本：失败占位/下载/重试测试。
- 表单还有其他控件、图片与文本同时出现：目标 textarea 与图片优先测试。
- 用户切会话、移除上传项、预览关闭：不回写另一草稿，不执行内容，焦点恢复。
- 紧凑输入隐藏文件列表：保留附件计数/状态，展开后可审阅及处理失败。

### Task 1: 自动转换与受控查看

**Files:** `src/web/Attachments.tsx`、`src/web/pastedText.ts`、必要的粘贴源码预览组件、`src/web/i18n/catalogs/session.ts`；`tests/pasted-text.test.ts`。

**Interfaces:** `pastedMarkdown(text:string):File|null`、`pastedTextPreview(file:Blob):Promise<string>`；复用 Attachment 的 File/状态/onChange 与 PreviewShell modal，不改发送 API。

- [x] 先写并运行阈值、Unicode/CRLF、文件名/MIME/完整内容单元测试，观察 RED。
- [x] 实现最小转换、主 textarea 粘贴接入、预检失败保留及重试校验、源码预览/下载和双语提示。
- [x] 运行 `node --test tests/pasted-text.test.ts` 与 TypeScript 检查，确认 GREEN。

### Task 2: 接入与交付验证

**Files:** `tests/pasted-text.spec.ts`、`tests/uploads.test.ts`、本计划及规格 11 节；复用 `tests/session-toolbar.html` 的真实 App 入口。

**Interfaces:** 接 Task 1 的用户粘贴交互；服务端 `createUploadService` 的 store/claim 与受认证 multipart 路由保持原合同。

- [x] 写浏览器用例并在实现前观察转换失败；覆盖新建/会话、1440/390、中英、5000 边界、预览与完整下载、原有草稿、失败/重试/超限/跨会话/紧凑输入/其他控件/图片。
- [x] 增加实际 `.md` 上传保存/claim 往返测试；运行相关上传/API/i18n/布局测试和浏览器回归，查看截图并记录真实失败及未测范围。
- [x] 独立审查并修复重要问题；执行 `npm run build`、`git diff --check`，更新实施收据。
- [x] 整理一个中文提交，确认主分支无外来修改后 fast-forward 合入，主目录 `npm run build` 并核对产物；不重启服务。

## 执行收据

- 2026-10-29：隔离工作树基线 `269c689`；官方阈值已读安装包代码确认。
- 阈值单元先因 helper 缺失 RED，再 3/3 GREEN；源码 UTF-8 截断另观察 RED，改 streaming decode 后 4/4 GREEN。Ruling：有界源码保留原文完整字符前缀，不让字节截断插入替换符；下载始终完整，计数阈值不变。
- 浏览器最小转换先 RED；初版 11/11 GREEN；修复 UTF-8 并强化焦点/几何及跨会话后相关 6/6 GREEN；新增 15 MiB+1 预检恢复 1/1 GREEN。最终文件含 12 个用例，未将这些分批运行伪记为一次全绿。
- 最终转换/上传/i18n/Web API/布局/输入偏好定向测试 38/38，通过 TypeScript、工作树生产构建及独立审查。沙箱内基线上传 rename 的 EPERM 单列为环境失败，受限临时 fixture 权限放行后原基线 17/17 通过。
- 浏览器检查与未测边界详见 `docs/superpowers/reports/2026-10-29-long-paste-markdown.md`。已 fast-forward 合入主分支；主目录 `npm run build` 通过，产物核对含本次 5000 阈值 Markdown 附件、1280px 抽屉及上一轮插件与富内容。未重启服务。
