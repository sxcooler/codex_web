# Git 日志两区与直接预览验收

日期：2026-10-23。基线 `da21751`；对应 [spec](../design/2026-10-23-git-history-two-sections-dialog.arch.md) 与 [plan](../superpowers/plans/2026-10-23-git-history-two-sections-dialog.md)。

## 最终行为

- 未选提交时列表占满可用高度；选中后提交／文件两区默认 3:2，独立滚动与折叠，无第三段内嵌历史预览。
- 点击历史文件直接打开 native modal；桌面居中宽预览，≤700px 全屏。路径复制、关闭、序号及首尾禁用的相邻文件导航复用现有预览壳与差异组件。
- 关闭重开同一文件保留正文 DOM、双轴阅读位置及成功缓存。切文件从顶部读；重载或切换会话／项目／仓库／分支／提交／父提交不自动打开，不恢复持久化 open。
- 关闭取消未完成的 diff 读取；迟到响应不能污染其他资源。刷新同资源失败可保留该资源，文件消失显示不可用并禁用导航。
- 普通文件／变更继续保留内嵌与全屏行为。无新依赖、持久化字段或后端接口；模拟接口只接受只读场景。

## 浏览器证据与范围

Browser 插件未提供，本轮使用仓库 Playwright 配置的 Edge 与既有脚本的 Chrome headless；均为本机真实 Chromium 浏览器，不是组件快照。Vite 只监听 loopback。入口 `/tests/git-fetch-notice.html`（标题“Git 刷新提示回归”）加载真实 GitPanel；`/tests/git-history-dialog.html` 加载真实 GitHistory。接口与正文为演示数据，未读取真实会话或复制用户的私有截图。

覆盖 1280×900、1440×900、360×800、390×844，中英文；另测 390px 英文／1280px 中文继承 200% CSS zoom。实际点击标签、提交、文件、上一／下一、关闭与重开，检查部分仓库提示、长路径、加载／错误／空提交、图片解码、二进制、重命名与截断状态。Tab／Shift+Tab、Enter、Esc、首尾禁用焦点、子浮层优先关闭与手机抽屉层级均有浏览器操作。断言 pageerror、框架错误覆盖层、可见性、边界和无接口写请求；普通预览兼容脚本另测 DOM／请求／worker 稳定及阅读偏移。

已查看 1440px 英文／1280px 中文两区、360px 中文两区、390px 中文／英文弹窗、未选列表、200% 缩放和键盘焦点代表截图；关闭与复制同排，导航独立一排，44px 点击目标可见，窄屏正文横向滚动留在正文区域。另查看手机抽屉中的加载态预览截图，操作验证关闭预览后抽屉仍在、焦点回到文件，下一次 Esc 再关抽屉。

本地原始日志与截图保留在实施 worktree 的 `.local/git-history-dialog/`，兼容脚本截图在 `.local/qa-temp/`；均未提交到 Git，避免引入测试产物。

## RED → GREEN 与偏差

| 阶段 | 首轮真实结果 | 修正与结果 |
| --- | --- | --- |
| 基线 | Node 10/10、既有布局／头部浏览器 13/13 | 保留普通预览兼容基线 |
| 两区／直接预览 | 新断言 12/12 失败 | 首实现 5 通过／7 失败；隐藏 dialog 的滚动归零覆盖阅读位置，增加受控切换保护后相关浏览器 19/19 |
| 导航／生命周期 | 新浏览器 13 失败／2 通过；文案单测新增 1 失败 | 绑定完整上下文、显式打开才读差异、取消与资源隔离；相关浏览器 34/34，空提交／图片解码追加 2/2，Node 11/11 |
| 旧夹具迁移 | 历史刷新断言仍依赖自动打开；旧折叠断言假定常驻预览；固定测试结果条遮住全高列表末行 | 同步为显式点击、关闭后折叠；测试结果条不拦截指针。保留普通文件原检查 |
| 200% CSS zoom | 新浏览器 2/2 失败，关闭按钮 Y=-368 越界 | viewport 单位改为等效固定包含块百分比，工具栏可换行；2/2 通过 |
| 旧全屏入口 | 切换上下文后立即读取 modal 数量得到 1 | 等待 React 提交后的可观察关闭状态；未放宽关闭目标或跳过场景 |

裁决：使用原生 Windows 命令和任务专属 ignored ledger，保留复用 worktree 与证据，代价仅本地目录布局／磁盘；头部历史入口的测试提前到 Task 1，以满足该任务的共享壳兼容门槛，代价仅任务分组；尺寸百分比在正常缩放等同 spec 目标值，并能兼容 CSS zoom，代价是实现单位与初稿不同。

## 最终验证与审查

| 检查 | 实际结果 |
| --- | --- |
| `node --test --test-concurrency=1 --test-timeout=90000 tests/*.test.ts` | 共 833 项，828 通过、5 跳过、0 失败，耗时 224.6s |
| 布局／dialog／头部／面板国际化 Playwright | 47/47；键盘 Enter 重开补充后相关 2/2 再通过 |
| `git-history.browser.mjs` | 390／1280px 各 6 类检查，全部通过 |
| `preview-fullscreen.browser.mjs --baseline` | 390／1280px 各 4 个旧夹具，全部通过 |
| `preview-fullscreen.browser.mjs` | 390／1280px 通过，40 次切换 p95 33.7／33.5ms；正文 DOM 变化、重复请求、worker 及任务增量均为 0 |
| `preview-reading-width.browser.mjs` | 退出码 0，正文／嵌套表格边界通过 |
| `source-preview.browser.mjs` | 390／1280px 源码忠实性、语言、边界、锚点、缓存、迟到回调及 Markdown 全通过 |
| `npx tsc --noEmit` | 通过 |
| `npx vite build --outDir .local/git-history-dialog-dist` | 通过；仍有既有 chunk 超过 500kB 提示，未更改打包策略 |
| `git diff --check` | 通过；工作区 CRLF 提示不影响检查结果 |

5 个跳过保留原分母：Linux 前台启停、Linux user systemd、Linux Serve helper、Linux 原生文件名，以及需要单独解包环境的 release 验证。

最终一次独立审查使用 `gpt-6.1-sol`，范围 `da21751..9d75082`，逐项检查五条 Review Focus 及 GitPanel／PaneLayout／ImageDiff／持久化连通路径。结论可合并：Critical 0、Important 0、Minor 1。审查者只读检查，不重复全量套件；审查后仅补本文档与完成状态，产品代码未变。

待办 Minor：两个列表同时折叠时，`auto auto` 轨道在固定高 grid 中拉伸，两个标题间距偏大；展开与预览不受影响。按一次审查流程记录为后续布局微调，未进入本轮重要问题修复。

审查暂不判断的两项由主会话确认边界：运行 dist／服务重启／推送留给另行部署，代价是当前运行页面尚未换版；实体手机／iOS Safari 仍未实测，代价是动态地址栏与 safe-area 的真实设备表现待验证。未将 Chromium 窄屏验收提升为实体手机通过。

## 未验证与部署边界

未使用实体手机／iOS Safari，未用真实仓库执行 Git 写入、fetch 或原生任务。未更新运行中 dist、未重启后端、未推送 GitHub。隔离测试构建不代表现有线上页面已经换版。
