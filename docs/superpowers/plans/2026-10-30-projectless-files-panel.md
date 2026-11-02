# 新任务文件侧栏与分标签刷新实施计划

> **For agentic workers:** 使用 superpowers:subagent-driven-development 或 executing-plans。用户已明确提出实施需求并澄清只开放“文件”；不得扩大为 Git 或文件编辑能力。

**Goal:** 新任务和合法无项目会话可浏览根目录文件；变更、文件、Git 各自刷新自己的数据。

**Architecture:** 复用 Projects 文件安全检查和 GitPanel 预览/导航；增加不依赖会话的文件 GET scope，Home/Session 选择合法上下文。Git 仍只在项目会话可用。

**Tech Stack:** 现有 TypeScript/Fastify/React/Node tests/独立 headless Playwright，不加依赖。

**Spec:** `docs/design/2026-10-28-extensions-and-rich-content.arch.md` 第 14 节；基线 `19abe46`，隔离工作树 `.worktrees/projectless-files-20261030`。

## Global Constraints

- 服务器只接受受信项目 ID 或固定 WORK_ROOT；不接收任意绝对根路径。不能让 root target 穿透到 Git。
- 无项目会话按真实 thread cwd 精确核对，外部 cwd/加载期不悄悄回退；沿用敏感路径、realpath、链接、正文/图片上限和响应安全头。
- 文件模式强制 files、不挂载 GitHistory、不发送 Git API，不创建/打开会话或模型。
- 变更仅重读状态/差异；文件仅重读当前目录/预览；Git 日志沿用当前仓库手动 fetch，重复点击合并，错误不丢失。
- 保留原接口默认行为、项目面板状态/预览历史和中文/英文/窄屏/焦点；根目录和文件模式用独立存储身份。
- 独立无头浏览器，不操作用户前台/剪贴板；不修改用户实际文件、仓库或运行服务。一个中文实现提交，最终更新主目录 dist。

## Review Focus

1. cached tab=changes/history 进入文件模式仍不得发 Git；见 Task 2。
2. root/project 和 Markdown/图片请求前缀须一致，跨根迟到响应不可混入；见 Task 2/3。
3. 外部 cwd 不能因为 project=null 获得错误根浏览上下文；见 Task 1/3。
4. 普通文件 GET 不能接受 Git revision/repository；越界与敏感路径不放宽；见 Task 1。
5. 刷新时切标签或仓库、重复点击和旧 fetch 完成，只更新对应上下文；见 Task 2。

## Task 1：根目录与无会话文件 API

**Files:** `src/projects.ts`、`src/server/api.ts`；`tests/project-file-preview.test.ts`，新增 `tests/projectless-files-api.test.ts`。

- [x] 写 root list/entry/text/image 与项目 ID、真实 cwd root/外部 cwd 的红测；新接口无 Runtime create/open，未知查询和 revision/repository、越界/敏感/链接均拒绝。
- [x] 文件方法及 #safePath 接受明确 root target，通用 resolve/Git 不改变；新增四类 GET 两种 scope，现有 session 文件独立 boundFiles，不放宽 boundProject。
- [x] 运行相关文件/图片/API 回归并记录 GREEN，保留 sandbox 文件权限失败分母。

## Task 2：文件模式、链接与分标签刷新

**Files:** `src/web/GitPanel.tsx`、`src/web/ImagePreview.tsx`、`src/web/fileLinks.ts`、必要的 panels i18n；`tests/file-links.test.ts`、`tests/workspace-panels.html` 和相关 browser/spec fixture。

**Contract:** GitPanel 保留原 id/projectId 默认 session scope，新增 `filesOnly?:boolean`、`fileBase?:string`（如 `/files`、`/projects/<id>/files`，均相对于 /api）。ImagePreview 同名可选 fileBase；fileLinks 的 linkedFile/fileUrl/fileImageUrl/chatFileUrl 末尾可选 fileBase，旧调用不变。新文件模式使用独立 projectId 存储身份，强制有效 files 标签且不挂载 GitHistory。

- [x] 写 file-only 恢复旧 Git tab仍只请求files、目录/正文/图片/Markdown统一prefix、越界链接与迟到旧响应的红测。
- [x] 写三标签刷新计数红测：changes/files fetch=0，history只fetch选中repository，保留重复点击/部分失败/切标签/换项目保护。
- [x] 最小复用组件与可选prefix，Files刷新只变文件revision，Changes刷新只重读状态/差异，History复用既有手动fetch。
- [x] 运行 Node/既有面板/图片/Markdown/导航相关browser，校对中英文title按标签表达。

## Task 3：新任务和无项目会话入口

**Files:** `src/web/main.tsx`、`src/web/SessionView.tsx`、必要局部布局；新增 `tests/projectless-panel.spec.ts`，保持 `tests/home-options.spec.ts`、`tests/native-projects.browser.mjs` 外部 cwd 保护。

- [x] 写新任务root/所选项目、new/clone未创建、projectless root session、外部cwd与加载中禁用、root切换取消旧内容的红测。
- [x] App传workRoot给Home，复用session-layout与PaneSeparator/抽屉；Home仅文件scope，项目切换key重挂载。Session在snapshot项目正常或真实cwd===workRoot时开启，后一种仅文件。
- [x] 桌面1440/390、中英文、键盘开闭/焦点、抽屉、Markdown/图片/路径/导航/刷新走入口并查看截图；断言根外会话清旧context且不发文件/Git/模型写请求。

## Task 4：统一验证与交付

- [x] 独立审查 scope安全、上下文切换、三标签请求隔离；运行相关 Node与browser及必要全量回归。
- [x] `npm run build`、`git diff --check`；补齐spec/plan结果、失败/跳过/未测范围。
- [x] 一个中文提交，干净master快进合入、重建主目录dist并核对入口；不自动重启服务。

## 实施结果（2026-10-30）

已按 Task 1—4 完成实现。新增行为均复用现有 Projects 路径检查、GitPanel、预览/导航及 PaneLayout，不新增依赖或会话占位。

- 后端新增 8 个 GET，并让原 session 文件 GET 按真实 cwd 支持 WORK_ROOT；Git 的 boundProject/resolve 不变。API 新测4项及文件/图片/native/fetch相关回归共26/26通过。普通sandbox新测3/4、原回归13/22的失败为junction/Git fixture权限；保留首次分母，精确提权26/26通过，不把环境失败当功能RED。
- 文件组件新增9例scope/刷新回归，连预览头部/i18n共26/26通过；Node file-links/i18n/panel-state19/19。修复刷新时disabled导致键盘焦点丢失，保留原fetch去重/部分失败/换仓库晚到/上下文提示反例。旧workspace、repository、fetch-notice fixture按新标签语义迁移到History触发fetch。
- Root入口新10例加后续本地关联未确认1例，以及既有home-options4例；最终与组件相关合并5文件41/41通过。覆盖桌面1440/390、中英文、Files-only旧tab、new/clone、root切换迟到、空/外部cwd、epoch+cwd更换恢复项目三标签；已查看入口和组件截图。文件模式不发Git，浏览不创建会话或模型。
- 首次入口红测明确右栏disabled；后续14例汇总13通过/1失败，原因是测试对不存在的select选项值作了假设。改为等待已知选项加载后验证禁用/零文件调用，精确1/1通过。新增关联状态解耦用例先RED（文件被native状态门控），最小区分文件目标与任务selectionReady后GREEN，任务按钮仍禁用且零POST sessions。
- 既有native项目外部cwd专项和完整流程通过。完整脚本初次失败是1280px被旧fixture当作桌面，改桌面初始化1440，保留后续1280/390检查及失败日志，不改产品断点或放松断言。
- 全量 `node --test --test-concurrency=4 tests/*.test.ts`：992项，987通过、5跳过、0失败。跳过仍为4项Linux平台检查和1项缺PORTABLE_TEST_DIR的发布包测试。
- `npx tsc --noEmit`（现有前端tsconfig）、`npm run build`、`git diff --check`通过。额外尝试的服务端临时tsc受未修改位置的既有nativeTitle/runtime/Projects诊断阻挡，不能据前端检查声称服务端全量类型通过；完整Node/API回归已覆盖本轮后端。
- 独立审查及追加文件关联状态复核未发现已确认高/中优先级问题。原未测epoch/root替换已补浏览器用例；多页History刷新未独立新增专项，保留现有按tick重读已加载页面逻辑。

证据保留在隔离worktree的 `.local/implementation-projectless/`：node-final.log、browser-delivery.log、backend-green-elevated.txt、native-projects-recheck.log、native-external-cwd.log、build-final.log。截图为 home-files-{1440,390}-{zh-CN,en}.png 与 panels/files-{zh-CN,en}-{1440,390}.png；均为独立headless测试，未使用用户前台/系统剪贴板或真实账号写操作。

最终入口为 `/assets/index-DzWWTZNt.js` 与 `/assets/index-DRkyA5s8.css`，合入master后按同源码重建并核对资源。服务不自动重启。

- [ ] 重启后实际运行服务的新文件接口、真实目录与在线会话验收（未在本轮自动执行）。