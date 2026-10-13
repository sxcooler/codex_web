# 文件预览标题栏与复制路径验证

日期：2026-10-13。对应[确认后的设计](../design/2026-10-13-preview-header-and-copy-path.md)，基线为 `05f0a1c`。

## 已交付行为

普通文件、工作区差异、Git 历史使用统一标题栏。第一行保留文件名，目录单行省略；右侧为复制路径及全屏图标。第二行安排已有模式切换及文件导航，无路径横向滚动条。复制完整主机绝对路径，覆盖 worktree 和历史子仓库；根路径缺失时禁用。

复制成功只显示短暂对勾，并提供悬停及读屏提示；失败反馈浮签跟随整个工具栏的实际高度，避免遮住按钮。迟到的复制结果不属于新文件。正文 DOM、缓存、滚动位置及全屏/Esc 焦点处理保留。

## 最终验证

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| `node --test tests/file-links.test.ts tests/panel-state.test.ts tests/project-file-preview.test.ts` | 18 通过，0 失败、取消、跳过 | [Node 日志](../../.local/preview-header-unit-verified.log) |
| `npx playwright test --config .local/qa-temp/foreground-playwright.config.mts tests/preview-header.spec.ts --reporter=line` | Chrome 7 通过，0 失败 | [标题栏日志](../../.local/preview-header-browser-accepted.log) |
| `node tests/preview-fullscreen.browser.mjs` | 1280、390 两档均通过 | [全屏日志](../../.local/preview-header-fullscreen-accepted.log) |
| `npx tsc --noEmit`，随后 Vite 生产构建 | 均成功；保留原有大于 500k 的分包警告 | [构建日志](../../.local/preview-header-build-final.log) |
| 独立源码审查 | 最终无未解决问题；审查者仅只读，没有运行服务或真实 Native | 本会话 `foreground_readonly_review` 最终复核 |
| 线上静态资源 | 首页和 4 个入口资源均 HTTP 200，与本地文件逐字节一致 | [部署结果 JSON](../../.local/web/preview-header-deployment-result.json) |

Chrome 标题栏场景覆盖桌面/窄屏两行布局、纯图标、28px/44px 操作区域、绝对路径成功/失败、旧文件迟到反馈、Git 历史主仓库/子仓库、根路径缺失、工作区差异，以及反馈恢复。复制时没有额外文件读取或正文重建，各场景无 pageerror。

全屏回归覆盖 Markdown/源码、图片、慢请求与缺失文件、工作区并排差异、历史差异、键盘/指针/触屏、Esc/弹出框/抽屉优先级、焦点及阅读位置。展开/收起期间两档正文 mutations 均为 0，重复请求、worker、worker task 均为 0，无 long task；切换 p95 分别约 33.5ms、33.8ms。这是本机隔离浏览器测量，不是所有设备的性能承诺。

最终截图位于 `C:\Users\Developer\AppData\Local\Temp\codex-preview-header-eRMeTM`：

- [1280 桌面截图](C:/Users/Developer/AppData/Local/Temp/codex-preview-header-eRMeTM/header-1280.png)
- [390 窄屏截图](C:/Users/Developer/AppData/Local/Temp/codex-preview-header-eRMeTM/header-390.png)

两张均已目视检查：标题无滚动条，目录与文件名有清晰分隔，操作分行，对勾不遮挡导航，无页面横向溢出。

## 过程中的失败与修正

以下保留失败记录，不将初始失败合并到最终通过结果：

1. [初始 Node 红测](../../.local/preview-header-unit-red.log)：7 项中 6 通过、1 失败，复制路径辅助函数尚未实现。
2. [初始浏览器红测](../../.local/preview-header-browser-red.log)：6 项全部失败，产品尚无复制按钮。
3. [首次浏览器集成](../../.local/preview-header-browser-green.log)：3 通过、3 失败。宽泛 `role=status` 定位器同时匹配复制反馈和现有 Markdown 状态；改为定位具体复制反馈，保留值、DOM、滚动及请求断言。此后先 6 项通过，再加入工作区差异场景。
4. 首次三文件 Node 套件在受限环境中因系统 Temp 的 `mkdtemp EPERM` 未完成。对同一套件使用授权隔离执行后 18 项通过。最初失败日志被成功重试覆盖，未保存完整失败分母；不将权限失败算成产品通过。
5. [首次全屏回归](../../.local/preview-header-fullscreen.log)：1280 导航冷启动超过 30 秒，390 通过。测试服务先预热样式转换，交互、焦点、性能及无重复请求阈值不变；随后两档通过。
6. 目视检查发现成功浮签遮挡最近文件按钮；[新反馈红测](../../.local/preview-header-feedback-red.log)的 2 项断言均失败。成功改为对勾、悬停及读屏反馈，失败浮签下移。
7. 独立审查发现按固定按钮高度定位浮签仍会覆盖较高的差异切换按钮。[实际差异反馈检查](../../.local/preview-header-diff-feedback-check.log) 1 项失败：浮签 top 为 414.5px，控制行 bottom 为 418.6875px。最终相对完整工具栏定位，移除固定高度推算；最终 7 项及两档全屏均通过。

## dist 与边界

2026-10-13 12:25:05 +08 完成前端部署核对。线上首页 SHA256 为 `0abdd6811b95c59425a006e1a6741e07c055c0c13112b797d450cf8705eb2dab`，入口 JS 为 `index-6B_th38J.js`，CSS 为 `index-BaQErlHn.css`。构建使用 `emptyOutDir:false` 保留旧哈希资源，避免已打开页面缺少旧的延迟加载文件；刷新页面载入新版。

本次只改前端，未修改后台或执行服务重启。浏览器测试使用隔离 Vite 页面、真实组件和模拟接口/Clipboard API；没有触碰系统剪贴板或原生会话。不代表已完成真实手机、真实 OS 剪贴板权限或真实 Native 写入验证。`.local` 日志、部署结果及 Temp 截图属于本机证据，不随 Git 提交分发。
