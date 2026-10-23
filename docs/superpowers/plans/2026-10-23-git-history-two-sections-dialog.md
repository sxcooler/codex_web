# Git 日志两区布局与文件预览弹窗实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Git 日志只保留提交与文件两区，点击文件直接打开宽预览 dialog，支持连续切换并保留列表与当前阅读状态。

**Architecture:** 在现有 GitHistory 内管理局部打开状态，复用 PreviewShell 的 native dialog、DiffView／ImageDiff、现有资源缓存及鉴权 GET。PreviewShell 的默认内嵌／全屏行为保持兼容，不改后端或外层布局。

**Tech Stack:** 现有 React／TypeScript／CSS、类型安全中英文目录、Playwright、Node test、Vite，无新依赖。

**Spec:** [已确认 spec](../../../codex-drive/specs/2026-10-23-git-history-two-sections-dialog.arch.md)。

## 全局约束

- 用户已追加明确实施指示，按计划连续执行；不重复请求同一授权。实施时先核对主分支与未提交内容，使用或复用合适的隔离 worktree，不清理其他工作。
- Git 日志内部两区，展开默认 3:2；未选提交时列表区域占满，不留第三段预览。不增加拖动或比例设置。
- 桌面 dialog 正常缩放目标宽 `min(1440px, calc(100vw - 48px))`、高 `calc(100dvh - 48px)`；≤700px 占满视口并考虑 safe-area。实现使用等效固定定位包含块百分比以兼容 CSS zoom；关闭／导航点击目标至少 44×44px。
- 关闭保留选择、列表位置、当前阅读位置与有效缓存；重挂载不自动打开。相邻文件导航不循环，切文件正文从顶部开始，不增加每文件永久阅读历史。
- 资源身份必须包含 id／repository／commit／parent／path，缓存保留 tick；取消或忽略过期响应，不显示另一资源的旧内容。
- 不改变认证、Git 与原生写入保护；不增加依赖、后端接口、浏览器历史项或全局方向键。不发布、更新 dist 或重启真实服务。
- 普通文件和“变更”标签继续采用原有内嵌／全屏行为，必须覆盖共享 PreviewShell 的兼容回归。
- 页面验收使用演示数据：1280／1440px、360／390px、中英文、200% CSS zoom、键盘与焦点、长路径／错误，实际打开入口并查看截图。
- 原生逐项执行，记录首轮失败与跳过分母，最后一次全分支独立审查。中文任务提交最终 squash 成一个实现提交，正文保留原提交信息；不推送 worktree 分支。

## Review Focus

1. 受控 dialog 的 native close／cancel 与旧 show() 路径互相调用，不能关完又开或出现两个 modal。
2. 旧持久化 path、刷新后文件消失、会话／父提交变化及迟到响应，不能自动弹窗或显示错误资源。
3. 手机抽屉、内部浮层和 Tab／Esc／返回焦点必须遵守层级；跨上下文关闭不能抢走新页面焦点。
4. 关闭重开、语言切换、折叠和滚动不能重复 GET、重建已缓存正文或扩大 localStorage 写入频率。
5. 仅一个文件、首尾禁用、快速 A→B→A、图片／二进制／重命名／截断失败时，路径、序号、按钮状态与真实内容必须一致。

## 文件分工

| 文件 | 职责 |
| --- | --- |
| `src/web/GitHistory.tsx` | 两区、dialog 打开／关闭、相邻文件、资源读取与焦点 |
| `src/web/PreviewShell.tsx` | 可选受控 modal 模式，默认模式兼容 |
| `src/web/style.css`、`src/web/i18n/catalogs/panels.ts` | 两区和局部 dialog 样式、中英文 |
| 新 `tests/git-history-dialog.html`／`tests/git-history-dialog.spec.ts` | 真实组件＋模拟接口的受控场景与浏览器行为 |
| `tests/git-history-layout.spec.ts`、`tests/git-history.html` | 替换旧比例和内嵌历史预览断言 |
| `tests/panel-collapse.html`、`tests/preview-fullscreen.browser.mjs` | 更新历史分支，保留普通文件旧行为断言 |
| `tests/preview-header.spec.ts`、`tests/i18n-panels.spec.ts` | 历史入口与复制／语言切换回归 |
| `tests/panel-state.test.ts`、`tests/i18n-panels.test.ts` | 旧状态兼容与文案完整性 |

## Task 1：两区布局与直接打开／关闭

**Interfaces:**
- Consumes：原有 `GitHistory({id, projectRoot?, tick, visible, state, onChange, onScroll?})` 与 `PanelState.history`，不改变外部签名。
- Produces：`PreviewShell` 新可选 `modal?: {open: boolean; onClose: () => void}`；`controls` 沿用。受控模式设置 `data-presentation="dialog"` 供局部样式使用，关闭时保持内容挂载但不占布局。
- GitHistory 使用局部 `previewOpen` 与触发元素 ref；`openPreview(path: string, trigger: HTMLButtonElement)` 显式打开同文件，`closePreview(restoreFocus?: boolean)` 默认恢复触发元素，失效时回退文件区标题。上下文关闭传 false。

- [x] 新建真实 GitHistory fixture，外部测试按钮可改变 id／visible／tick／项目状态，LocaleProvider 与现有目录同源，接口统一由 Playwright route 模拟，不发真实请求。
- [x] 写 `layout fills unselected space at every viewport`：未选提交时第一列表区域高度≥history 的 95%，无第三段；选提交后两区约 3:2、可以独立滚动。将旧 layout 测试中桌面列表小于 35% 的断言替换。
- [x] 写 `file opens directly in one dialog and closes to its trigger` 和 `same file reopens from cache without rebuilding content`：点击直接 native modal；关闭后 modal 数为 0，history 无可见内嵌 preview，列表位置不变；再次点击相同 path 打开，已成功缓存的 GET 数不变、正文节点与滚动不变。
- [x] 运行 `npx playwright test tests/git-history-layout.spec.ts tests/git-history-dialog.spec.ts --grep "layout|opens directly|reopens"`。Expected：新断言因旧比例／需要二次全屏点击而 FAIL；记录真实失败。
- [x] 实现两区、受控 PreviewShell 和局部样式；默认模式继续 show()／全屏／收起，受控关闭不落回 show()。焦点、onClose 回调只结算一次，children 不因关闭重开而 remount；先补 `panels.preview.close` 中英文可访问名称。
- [x] 同命令转 GREEN，并运行 `npx playwright test tests/preview-header.spec.ts`，Expected：受影响用例全通过，普通文件复制和全屏仍通过。提交 `实现 Git 日志两区与直接文件预览`。

## Task 2：连续阅读、状态与异步边界

**Interfaces:**
- Consumes：Task 1 的受控模式和局部打开／关闭方法，现有 `currentDetail.files`、`detailKey`／`diffKey`、cacheEntry 20 项上限。
- Produces：GitHistory 局部 `movePreviewFile(delta: -1 | 1): void`，按当前文件数组取相邻项，越界无操作；更新 path／scroll=0 并保持同一 modal。无新持久化字段。
- `controls` 传入短提交 ID、文件序号与导航。新增 `panels.history.previousFile`、`nextFile`、`filePosition(index: number, total: number)`，index 使用 1-based 显示；中文“上一文件／下一文件／第 n / total 个文件”，英文“Previous file／Next file／File n of total”。

- [x] 写 `adjacent files keep one modal and enforce boundaries`：三文件依次切换、首尾禁用、不循环、单文件双禁用；相邻项包括图片、二进制、重命名，标题／序号／内容一致；切换后 scroll=0，焦点仍在可用的导航／关闭按钮。
- [x] 写 `saved selection stays closed until an explicit click`：由旧 PanelState 恢复 path／scroll，列表选中保留，modal=0 且 diff GET=0，点击已选文件后才读取。关闭重开、折叠、语言切换不增加 GET，不替换正文，滚动不导致整张提交图重新渲染。
- [x] 写 `late response cannot reopen or contaminate another context`：延迟 A→B、B 失败、关闭前完成／未完成、切换 id／项目／仓库／ref／commit／parent／visible；迟到结果不会覆盖 B、自动弹窗或聚焦旧节点。
- [x] 写 `refresh keeps only same-resource content and handles a removed file`：通过 fixture tick 显式刷新；同文件失败保留同文件，异文件失败不保留旧文件；文件消失显示不可用，不自动跳下一项，关闭可用。
- [x] 运行 `npx playwright test tests/git-history-dialog.spec.ts`。Expected：新增导航或资源生命周期断言先 FAIL，再实现到全部 PASS；每类修正记录 RED→GREEN。
- [x] 差异读取 effect 仅在 visible、previewOpen、commit、path 有效时运行，保留 tick 和全资源 key；关闭取消未完成读取，有效成功缓存不清空。相邻 path 不进入会关闭 modal 的 resetKey；会话／仓库／提交／父提交变化则关闭。
- [x] 更新中英文与 `tests/panel-state.test.ts`／`tests/i18n-panels.test.ts`，验证旧字段可加载、没有持久化 open。运行 `node --test tests/panel-state.test.ts tests/i18n-panels.test.ts` 与新浏览器用例，Expected：全部通过。提交 `完善历史预览连续阅读与状态保护`。

## Task 3：既有入口回归、浏览器验收与交付

**Interfaces:** 消费前两项最终行为；本任务只更新受影响 fixture／断言、验证及文档。现有 Git API、普通 PreviewShell 模式和持久化格式保持兼容。

- [x] 更新 `tests/git-history.html`、`tests/panel-collapse.html`、`tests/preview-fullscreen.browser.mjs` 的历史分支：点击历史文件直接 modal，关闭不显示内嵌 preview；折叠测试先关闭 modal 再操作列表，恢复选中项时不自动弹窗。保留原普通文件／变更分支，不把旧回归删成空检查。
- [x] 更新 `tests/preview-header.spec.ts` 与 `tests/i18n-panels.spec.ts` 中需要点击文件的历史入口，核对复制路径含仓库前缀、关闭文案、语言切换、滚动与原始 Git 内容。
- [x] 在真实 GitPanel fixture 的 `变更／文件 → Git 日志 → 提交 → 文件 → dialog → 相邻文件 → 关闭` 走完整流程。1280×900、1440×900、360×800、390×844，中英文及 200% CSS zoom；覆盖部分仓库提示、长路径／错误、多文件、Tab／Shift+Tab／Enter／Esc 和抽屉分层。查看每组代表截图，记录 URL、标题、非空、无框架覆盖层、pageerror／console、按钮和间距，不仅断言无溢出。
- [x] 运行 `npx playwright test tests/git-history-layout.spec.ts tests/git-history-dialog.spec.ts tests/preview-header.spec.ts tests/i18n-panels.spec.ts`。Expected：全部通过。
- [x] 依次运行 `node tests/git-history.browser.mjs`、`node tests/preview-fullscreen.browser.mjs --baseline`、`node tests/preview-fullscreen.browser.mjs`、`node tests/preview-reading-width.browser.mjs`、`node tests/source-preview.browser.mjs`。这些脚本各自启动并关闭 Vite，不另占固定端口。Expected：所有自检 PASS／退出码 0，查看产生的相关截图。
- [x] 新功能完成后做一次全分支独立审查，重点覆盖 Review Focus；重要问题一轮补失败回归并修正，记录其余发现与范围。
- [x] 最终运行 `node --test --test-concurrency=1 --test-timeout=90000 tests/*.test.ts`、上述受影响浏览器、`npx tsc --noEmit`、`npx vite build --outDir .local/git-history-dialog-dist` 和 `git diff --check`。Expected：无失败；保留跳过分母及已有构建警告，构建不覆盖当前 dist。
- [x] 新增 `docs/verification/2026-10-23-git-history-two-sections-dialog.md`，更新 spec／plan／索引和旧面板设计的实施状态。单个中文实现提交保留原任务提交信息；本轮不推送或更新运行服务。提交 `补齐历史预览弹窗回归与验收记录` 后按项目规范 squash。

## 本轮文档检查与实施状态

Task 1／2／3 已完成。共享壳和调用方由主会话原生逐项实施，一个独立审查会话覆盖全分支，0 个阻断问题；同时折叠时标题间距的 Minor 已留档。实际测试计数、跳过项、裁决与部署边界见[验收记录](../../verification/2026-10-23-git-history-two-sections-dialog.md)。运行服务的 dist、后端进程和真实会话不在本轮实施范围；测试构建写入隔离目录。
