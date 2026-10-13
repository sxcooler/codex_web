# 文档全屏内的流程图全屏

日期：2026-10-13。用户确认将排查结论落文并实施，要求文档全屏时仍能打开流程图全屏。

## 根因

文件预览 `PreviewShell` 通过原生 `dialog.showModal()` 进入浏览器顶层；Streamdown 的 Mermaid 全屏使用 `createPortal(..., document.body)` 的普通固定定位 div。按钮已触发，SVG 也已生成，但这层位于文档弹窗下且不属于可交互的模态子树。将 z-index 提至 2147483647 仍无法覆盖原生顶层。[隔离复现](C:/Users/Developer/AppData/Local/Temp/codex-nested-mermaid-AjZFKV/rendered-result.json)；复现未修改产品或真实会话。

## 实施方案

在共用 `MermaidBlock` 内使用原生 dialog，复用同一个 Streamdown、SVG 和缩放/平移状态；停用上游挂载到 body 的全屏动作。普通状态仍为内嵌流程图，进入全屏时 `showModal()`，退出时恢复内嵌，不移动 React 节点、不复制图形、不读取文件或创建新的绘图任务。

流程图浮层保留图形/源码、复制与缩放控制，提供图标按钮“全屏查看 / 退出全屏”。用原有流程图容器保留进入前的宽高，避免顶层弹窗脱离文档流时使阅读位置跳动。还原文档滚动位置和触发按钮焦点；指针及 Esc 返回不残留焦点边，键盘导航保留可见焦点。

文档与流程图都全屏时，Esc 首先退出流程图，文档仍全屏；第二次 Esc 才收起文档。内层阻止键盘和 cancel 事件被外层处理，Tab 保持在当前模态内。切换文件、项目、会话或隐藏预览时，PreviewShell 先关闭嵌套模态，避免遗留遮挡。普通嵌入图表的滚轮/触屏用于文档滚动，全屏图表允许缩放与触屏拖动。

共享组件覆盖普通文件和对话中的图表。当前 Git 历史预览渲染文本差异，不渲染 Markdown/Mermaid；不新增历史文件渲染功能，回归其文件预览全屏及退出行为。

## 验证计划

先加入隔离 Chrome 红测：完整 SVG 已渲染，文档全屏中点击图表全屏必须真正成为最上层可交互区域；现有 body portal 应失败。覆盖 1280/390px、普通/文档全屏、两级 Esc、Tab、显式收起、SVG/缩放状态与阅读位置、无重复请求/绘图任务、隐藏和切换后的清理。

使用已有 Mermaid 功能夹具与生产 CSP 回归验证源码/复制、缩放/重置、流式与错误降级、触屏文档滚动和全屏拖动；执行文件全屏回归（包括 Git 差异）、完整 Node 测试、类型与构建检查。Browser plugin not available，沿用仓库 Playwright/Chrome；不争用真实 Native writer。构建到独立目录，合并新资源再更新 dist 首页，保留旧哈希资源；线上校验后提交单个中文 commit。

## 实施结果

`MermaidBlock` 已使用原生顶层弹窗，原有 Streamdown/SVG 留在同一节点内；关闭上游 body portal。内嵌状态声明 open，挂载图表不抢输入焦点；进入全屏保留原容器宽高，退出恢复文档位置。图标动作及源码/复制/缩放均可使用，普通触屏仍滚动文档，全屏触屏拖动图形。

内层 Tab 显式循环，当前模态明确处理 Esc 并阻止外层重复响应；同时保留原生 cancel 入口。共用文件容器在隐藏或身份切换时先关闭嵌套模态，原有最近文件 popover 的 Esc 优先级不变。

| 验证 | 结果与证据 |
| --- | --- |
| 嵌套与普通全屏 | Chrome 1280/390 × 文档/普通四组通过：最上层命中、两级 Esc、Tab、图标退出、焦点、SVG/缩放复用、精确阅读位置、无新增请求/worker/绘图任务，以及隐藏/切换后清理；另验内嵌图表挂载不抢输入焦点；[日志](../../.local/mermaid-fullscreen-accepted.log) |
| 生产 CSP 与触屏 | 独立构建、未提供真实 Runtime 的测试服务器，1280/390 均通过：深色样式、加载高度、手机文档滚动、全屏触屏平移/重置、内联脚本继续受阻；[日志](../../.local/mermaid-fullscreen-production.log) |
| 既有 Mermaid 能力 | 正常、懒加载和模块加载失败三个夹具均通过；正常覆盖中文、源码/复制、缩放/重置、全屏、滚轮、流式、语法错误、大小上限、安全降级及对话渲染；[日志](../../.local/mermaid-fullscreen-fixtures.log) |
| 文件容器回归 | 普通文件、源码、图片、Git 差异、popovers、键盘与抽屉通过；每视口 40 次切换，p95 约 34ms，新增 DOM 节点、请求、worker、绘图任务和长任务均为 0；[日志](../../.local/mermaid-file-fullscreen.log) |
| 完整 Node 与构建 | 752 项：747 通过、5 跳过、0 失败/取消；[测试日志](../../.local/mermaid-fullscreen-node.log)。TypeScript/Vite 成功，保留已有大分包警告；[构建日志](../../.local/mermaid-fullscreen-build.log) |
| dist | 新入口 `index-DoBy7uV3.js`、`index-DU-oBitM.css`；先复制资源、再原子替换首页，旧哈希资源逐字节保留。线上首页及 8 个新旧资源 HTTP 200 且等于 dist，后台 PID 32680 保持原值、未重启；[部署结果](../../.local/web/mermaid-fullscreen-deployment-result.json) |

目视检查：[桌面嵌套](C:/Users/Developer/AppData/Local/Temp/codex-mermaid-fullscreen-4f8yQa/1280-document.png)、[窄屏嵌套](C:/Users/Developer/AppData/Local/Temp/codex-mermaid-fullscreen-4f8yQa/390-document.png)。截图保留进入前主动放大的图形状态；全屏内仍可缩小、重置和拖动。

失败记录保留：原 portal 红测无法命中最上层（[日志](../../.local/mermaid-fullscreen-red.log)）；首轮原生实现 Tab 可离开内层（[日志](../../.local/mermaid-fullscreen-first.log)），增加焦点循环。随后 Chrome 原生嵌套序列在图形返回内嵌后未对父弹窗发出 cancel；非 React 最小示例也复现，最终由当前模态处理 Esc，未依赖加大 z-index（[事件记录](../../.local/mermaid-fullscreen-key-events.log)）。普通窄面板测试初次在全屏按钮不在视口时取基线，点击使浏览器自动滚动 266px；先令实际按钮可见再取基线，保留相同精度断言后四组通过（[初次日志](../../.local/mermaid-fullscreen-reading-first.log)）。

边界：未在真实手机或其他浏览器验收，未访问真实会话、修改原生配置或重启后台。同期设置问题仅做独立只读调查，不计入本需求。日志、截图和部署 JSON 是本机证据，不随 Git 分发。
