# 上传文件保留后缀实施计划

> **For agentic workers:** Use superpowers:executing-plans; 用户已明确要求直接修改并澄清危险类型继续拒绝，无需危险后缀改名规则。

**Goal:** 普通允许附件落盘为 `UUID + 原扩展名`，迁移当前两份 Markdown 的主路径，并保留历史 `.bin` 引用可读。

**Architecture:** 临时写 `UUID.tmp`，完成现有 MIME/扩展名/内容校验后才形成最终路径；图片继续使用既有规范扩展名，普通文件保留原扩展名大小写。不改变 API、上传白名单、内容限制和危险类型拒绝规则。既有两份已发送 Markdown 采用同目录硬链接新增 `.md`，核对大小与 SHA-256 后事务性更新 `relative_path`；旧 `.bin` 不删除，作为兼容入口。

**Tech Stack:** Node、TypeScript、SQLite、既有 Node tests；不新增依赖、不改 UI。

**Spec:** `docs/design/session-workspace.md` 第 9 节。

## 执行步骤

- [x] 补允许扩展名/大小写、危险文件仍拒绝、受控 claim 路径与批次回滚用例；先观察当前 `.bin` 行为 RED。
- [x] 只调整 `storeStreams` 的临时/最终命名顺序，运行上传/API/长粘贴定向回归及构建。
- [x] 独立核对实际数据：本次快照为两份 accepted `.md`；无链接/碰撞，大小与 SHA 一致才创建新路径，条件更新两行 DB；不改原始文件名、内容、上传ID、owner、请求和会话绑定。保留 `.bin` 硬链接的兼容成本，不做全库自动迁移。
- [x] 更新文档与验收收据，收口单个中文提交并合入主分支。
- [x] 用户已执行重启；本轮重连读取结果文件 `success` 并确认新 PID，再通过真实上传验证后缀已生效。没有再次安排或执行重启。

## 验收收据

- 主分支基线 `66c2ebd`，隔离工作树 `feature/upload-extensions-20261029`。
- 新用例先观察旧 `.bin` 与预期 `.txt` 不同的 RED；修改后 `node --test tests/uploads.test.ts tests/phase2-api.test.ts tests/pasted-text.test.ts` **15/15**，0 fail/skip。覆盖普通允许后缀、`.MD` 大小写、claim路径、`.exe/.EXE` 与 MZ/HTML 拒绝、失败回滚、既有 multipart 与长粘贴。
- 工作树 `npm run build`、`git diff --check` 通过；独立只读审查无 Mustfix / Important。没有 UI 变更，未额外运行浏览器或全仓库测试。
- 真实两份已发送 Markdown 于 2026-10-29 09:40（Asia/Shanghai）完成维护：SQLite `VACUUM INTO` 一致快照备份，备份 `integrity_check=ok`；核对全部元数据与大小/SHA后创建 `.md` 硬链接，再 `BEGIN IMMEDIATE` 条件更新两行 `relative_path`。两份新旧路径均可读、内容 SHA 不变、硬链接计数为 2。迁移可复核收据位于主目录 `.local/web/upload-extension-migration-2026-10-29T01-40-39-657Z.json`，数据库备份在 `.local/web/backups/`。
- 旧 `.bin` 是同文件的兼容名字，目录中出现 `.bin/.md` 两个名字不会复制内容。已发送的原生提示不会被改写；数据库主路径为 `.md`。新上传命名需后端重启加载源码，重启排程与实际 `success` 分别记录，不提前宣称生效。
- 后续：原自动排程曾被审批拒绝，未绕过；用户随后自行重启。2026-10-29 重连确认 09:59:53 的结果为 `success`、PID35324；真实服务的 5000 单位粘贴上传已落为 `.md` 且下载原文一致，验证附件已清理。最近各轮改动的完整通过项、来源失败与未测范围见 `docs/superpowers/reports/2026-10-29-post-restart-verification.md`。
