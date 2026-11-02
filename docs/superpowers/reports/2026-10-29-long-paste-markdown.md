# 长文本 Markdown 附件与 1280px 文档补充实施收据

日期：2026-10-29（Asia/Shanghai）。基线 `269c689`，工作分支 `feature/long-paste-markdown-20261029`。

用户要求：“用真正的附件，但我希望是.md格式，字符数阈值就参考官方app。落到文档并实施，把上一轮1280px也补进文档。”

## 已实施

- 主输入框单次纯文本粘贴 `text.length >= 5000` 时生成 `pasted-text-*.md` / `text/markdown`，保留原有草稿和选择；不改原文或 CRLF。阈值来源为已安装官方 Codex Desktop `26.1023.6123.0`，内部 `26.1023.50603`，精确条件和资源定位保存在规格 11.2。
- 复用附件上传、草稿缓存与 attachmentIds；传给模型的是既有受控文件路径提示，未再拼入全文。图片粘贴、短文本、其他控件、忙碌状态保持原通路。
- 上传/预检失败保留 File：包括第六个失败草稿占位和 15 MiB+1 超限文件；发送被阻止，重试重新验证限制，可安全预览、完整下载和移除。
- 复用 PreviewShell 查看源码，256 KiB 上界按完整 UTF-8 字符截断，不插入截断替换符；下载不截断。关闭与 Esc 恢复焦点，对象 URL 在关闭/卸载时释放。无 HTML 执行入口。
- 规格 11.1 补记上一轮 1280px 抽屉：≤1280px 抽屉，≥1281px 分栏；1000px 输入行为与设置页、split diff 其他断点保持原值。没有重新修改这部分产品代码。

## 验证

- 基线沙箱内上传测试因临时目录 rename 权限产生 EPERM；不是功能 RED。申请仅临时 fixture 权限后，原上传/布局/偏好基线 **17/17** 通过。
- 单元功能 RED→GREEN：缺失 helper → **3/3**；随后 UTF-8 截断前缀断言 RED → 修正后 **4/4**。
- 最终 `node --test tests/pasted-text.test.ts tests/uploads.test.ts tests/i18n.test.ts tests/i18n-session.test.ts tests/i18n-panels.test.ts tests/web-api.test.ts tests/layout.test.ts tests/preferences.test.ts`：**38/38**，0 fail、0 skip。
- 真实 Fastify multipart fixture 验证 `.md` MIME、完整中文/emoji/CRLF、SHA-256、文件存储、claim 只含引用、受认证下载与 nosniff；原内容校验仍拒绝以 script 开头的伪装文件。
- 浏览器 `tests/pasted-text.spec.ts`：先观察 5000 转换未被拦截的 RED；初版 **11/11**；代码/检查增强后相关 **6/6**；新增 15 MiB+1 恢复 **1/1**。最终文件为 12 例，不将分批结果改写成一次性 12/12。
- Playwright/Edge，入口为真实 main App（`tests/session-toolbar.html` 模拟外部 API），1440px/390px、中英、新建与已有会话、普通/紧凑输入；验证附件发送 ID、预览/下载、Tab/Esc/焦点、间距/对齐、失败/重试/移除、跨会话与移除后旧响应不复活。相关截图已查看。
- `npx tsc --noEmit`、工作树 `npm run build`、`git diff --check` 通过。保留既有 large chunk 提示，未新增依赖。独立只读审查无 Must fix / Important。

截图和下载为临时 fixture 产物，不提交用户/测试原文。可复跑测试随代码提交；当前证据在 `%TEMP%/codex-pasted-text-final`、`codex-pasted-text-oversized`，初轮在 `codex-pasted-text-green`。

## 未测与交付边界

- 使用合成 ClipboardEvent/DataTransfer，未操作系统剪贴板；短文本和 disabled 的断言证明事件未被截获/未上传，不冒充系统默认插入实测。
- 无真实手机、其他浏览器平台、真实账号上传、模型自主读取或权限模式的端到端验收；存储往返为隔离服务，附件内容仍受既有配额和内容校验约束。
- 草稿保持现有进程内缓存，刷新后的持久化不在本次范围。未跑全仓库 Node 测试套件；已运行以上定向回归。
- 已收口为一个中文提交并 fast-forward 合入主分支，随后主目录 `npm run build` 通过。已核对 dist 包含 5000 阈值、`.md` 转换/预览下载、1280px 断点及上一轮插件与富内容；保留既有 large chunk 提示。最终交付收据补入同一提交，不推送、不发布、不重启运行服务。
