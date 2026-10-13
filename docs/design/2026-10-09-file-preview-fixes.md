# 文件目录链接、源码高亮与 XML 预览修订

日期：2026-10-09。状态：用户已确认，实施与隔离验收完成，待本次部署授权。沿用当前文件面板、配色、导航及预览布局。

## 已确认的问题

| 问题 | 证据 | 修改目标 |
| --- | --- | --- |
| 点击目录链接显示 `Invalid request` | `GitPanel.openPreviewLink` 与外部 `openFile` 都直接进入 `openPanelFile`，没有辨别目录。`Projects.readFile` 强制普通文件，目录抛出 400 `Not a regular file`，HTTP 层将其转换为 `Invalid request`。隔离目录 `named.xml` 同样复现，不能依靠扩展名判断。 | 安全查询路径类型；目录进入并展开现有文件列表，文件进入原有预览。 |
| 源码没有语法颜色 | `SourcePreview` 只输出 `<pre>` / 行定位 `<mark>`。聊天 Markdown 代码块已经使用 `@streamdown/code`，但文件源码没有接入。 | 复用已安装的高亮器、主题和原文一致性检查，保留源码与行定位。 |
| XML 被识别为二进制 | 实际 `.local/web/task-before-msi-shell.xml` 为 3152 字节，首字节 `FF FE`，按 UTF-16 LE 解码以 `<?xml` 开始；原始字节含 1575 个 NUL。当前读取器先按原始 NUL 判断，再只尝试 UTF-8，因此误判。另已在内存样例复现 UTF-8 多字节字符跨 1 MiB 截断边界的误判。 | 先辨别编码并严格解码，再判真正的 NUL；显示上限截断不应造成二进制误判。 |

## 界面示意

以下仅为方案图，内容是示例，不是实际 XML 或任务输出。没有增加工具栏、编码选择器或主题设置。

点击目录链接后，文件列表自动展开，显示目标目录；沿用“上一级”，底部提示选择文件。

验证截图保存在隔离测试记录中，不随公开源码分发。

打开 XML 或代码文件后，原有预览区域显示语法颜色；文件路径、前进/后退、最近文件仍在原位置。Markdown 的预览/源码切换保留。

验证截图保存在隔离测试记录中，不随公开源码分发。

[手机目录示意](../assets/2026-10-09-file-preview-directory-mobile.png) · [手机源码示意](../assets/2026-10-09-file-preview-source-mobile.png)

## 目录链接

- 增加只读单路径查询 `GET /api/sessions/:threadId/files/entry?path=...`，只返回规范化的项目相对 `path` 与 `type: file | directory`。复用 session 绑定、相对路径校验、`Projects.#safePath(..., null)`、敏感文件与目录链接权限；不接收客户端 cwd，不读取文件正文。
- 合法链接归一化到项目根时使用 `.` 作为明确的请求目标，非法链接仍返回失败；不能将任意空字符串当根目录。路径查询必须含非空 `path`，允许 `path=.`，其响应为 `path:''` / `type:'directory'`。支持 `./`、目录内 `../` 和绝对路径恰等于项目根；Windows 比较遵循原有大小写规则，继续拒绝相似前缀的其他项目与越界路径。
- 采用单路径查询是为了避免打开一个链接时扫描整个父目录；当前父目录列表会逐项检查路径，在文件较多时增加无关开销。已知类型的文件列表条目仍走现有流程。
- 聊天中的本地链接、文件 Markdown 链接、外部 `openFile` 使用同一个打开入口。未知类型的目标查询成功后才更改选中路径与历史；类型查询失败保留当前文件和阅读状态，显示具体错误。
- `onLink` 维持同步布尔合同：识别出合法本地链接时立即返回 `true` 阻止浏览器默认打开文件 API，再异步查询类型；不能将它改成返回 Promise。合法根目录目标同样拦截，外部 HTTP/HTTPS 沿用原有打开方式。
- 类型查询成功后，内容读取或目录列表失败沿用现有目标错误提示和同资源缓存规则；不把旧文件正文显示到新文件名下面，也不新增失败后整次导航回滚机制。
- 目录设置 `files.directory`，清除文件选中项，展开列表并将列表滚动回顶部；保留上一文件的模式、行片段和内容滚动记录。目录不进入“最近文件”，不扩展为目录前进/后退历史。之后打开另一文件再后退，仍能回到原文件及阅读位置。
- 目录视图沿用当前“上一级”入口；本方案不增加“返回原文件”按钮。不存在、权限不足、链接目标变化、空目录均有相应状态。不能通过结尾斜杠或文件扩展名猜测类型。
- 快速连续点击、切换项目或会话时，取消或丢弃过期类型查询，旧响应不能把当前面板带回旧目标。

## 源码高亮

- 复用 `@streamdown/code` 的 token 接口和当前 `github-dark` 主题。把现有 Markdown 高亮结果的原文回拼校验共用给源码预览，保留其上游缓存防护；不增加依赖。
- 按文件扩展名及必要的特殊文件名识别已支持语言，覆盖 XML、JSON、YAML、JavaScript/TypeScript、Python、PowerShell、C/C++ 等常用文件。未知类型显示原始纯文本，不猜测或执行文件。
- 本版明确映射（后缀与特殊文件名忽略大小写）：XML `xml/xsd/xsl/xslt/svg`，JSON `json`，JSONC `jsonc`，YAML `yaml/yml`，TOML `toml`，INI `ini`；JavaScript `js/mjs/cjs`，JSX `jsx`，TypeScript `ts/mts/cts`，TSX `tsx`；HTML `html/htm`，CSS `css`，SCSS `scss`，Less `less`，Vue `vue`，Svelte `svelte`，Markdown `md/markdown`；Python `py`，PowerShell `ps1/psm1/psd1`，C `c/h`，C++ `cpp/cc/cxx/hpp/hxx`，C# `cs`，Java `java`，Go `go`，Rust `rs`，Ruby `rb`，PHP `php`，Lua `lua`，R `r`，SQL `sql`，Shell `sh/bash/zsh`，Batch `bat/cmd`，CMake `cmake`。特殊文件名为 `Dockerfile/Containerfile`（Dockerfile）、`Makefile/GNUmakefile`（Makefile）和 `CMakeLists.txt`（CMake）；其余无后缀文件仍用纯文本。
- token 以 React 文本和 span 渲染，不将源码当 HTML，也不把整个文件包进 Markdown 代码围栏。空格、换行、尾部空行与复制/选择所得文本保持一致。
- 保留现有 `#L...` 行/范围定位 `<mark>`、预览滚动与前进/后退状态。高亮加载期间先显示纯文本；旧文件的异步回调不能覆盖新文件，也不能改变其阅读位置。
- 为避免大文件的着色阻塞界面，第一版仅对已取得文本的 UTF-8 字节数不超过 262144（256 KiB）且 `text.split('\n').length` 不超过 5000 的内容着色，尾部空行计入行数；不是按磁盘原始 UTF-16 字节数判断。超过时保留纯文本和行定位，并用轻提示说明“文件较大，使用纯文本预览”。现有读取显示上限仍为 1 MiB / 20000 行，不为了高亮额外裁剪内容。
- 验收补充：安装版高亮器在上述预算内也存在同步分词卡顿。隔离 Node 对 `//` 加 262142 个 `x` 的单行样本达到 20 秒硬超时，8 KiB 单行也耗时约 2 秒；纯文本同字节量约 107 ms，排除了 React 渲染作为该次分词阻塞的原因。源码着色改在普通 Web Worker 中运行，复用同一 token 接口与原文校验；主线程设置 2 秒截止时间，超时终止 Worker，继续显示完整纯文本。每次文件切换、卸载、成功、异常都清理 Worker。保持原有字节/行数预算与界面，不另加长行阈值、依赖或设置；Markdown 消息的既有高亮路径不变。
- 本轮覆盖“文件”标签的源码，以及 Markdown 的“源码”模式；Git 差异已有增删染色，暂不改其统一/并排渲染。

## XML / 编码

- 支持现有 UTF-8、UTF-8 BOM，以及带 BOM 的 UTF-16 LE/BE 文本。先识别 BOM 再严格解码；不因 `.xml` 后缀直接放行任意字节。
- 在已解码文本中检查真正的 NUL，替代对 UTF-16 原始字节的零字节误判。完整文件的无效编码继续按不可预览内容处理。
- 当文件超过字节上限时，允许丢弃末尾不完整编码单元，并保留“已截断”标记；不得忽略文本中间的无效字节。行数截断沿用现有规则。
- 本轮不引入通用编码猜测、ANSI/GBK 选择器或无 BOM UTF-16 自动猜测。需要更多编码时再根据真实样本补充。
- 检查 `readFile` 的所有调用方，尤其 Git 未跟踪文件的行数统计；预览解码不能自动改变 `gitPatch` 的原始字节和补丁语义。JUnit 导入不是这条预览链路，本轮不改。

## 实施与验收

由子 agent 实施，三项作为同一个文件预览需求提交；保留失败证据，先复现再修正。

1. 后端隔离文件与 API 回归：单路径类型查询、`path=.` 项目根与缺 query / 空 query 的区别、无末尾斜杠目录、名为 `.xml` 的目录、空目录、缺失路径、鉴权、敏感路径、越界与目录链接权限；原文件读取仍拒绝目录。
2. 编码回归：实际 UTF-16 LE 形态、UTF-16 BE、UTF-8 BOM、真实二进制、无效编码、字节上限切到 UTF-8 / UTF-16 字符、行数截断；核对未跟踪文件统计与 patch 未被转码。
3. Chrome 桌面与 390px：聊天目录链接、Markdown 目录链接、相对/绝对根目录链接与非法链接分离、慢类型查询仍立即阻止默认跳转、文件列表折叠后跳目录、快速连续跳转、类型查询失败保留旧预览、文件历史与滚动恢复。
4. 源码回归：常用语言着色、原文完全一致、未知/大型文件回退（262144/262145 字节及 5000/5001 行边界）、Markdown 源码切换、行/范围锚点、高亮异步加载后仍停在正确位置、长行在预览区滚动；保留预算内病理长行样本，验证 UI 在着色期间仍响应、截止后纯文本保持一致，旧 Worker 的延迟消息不能影响新文件。
5. 构建最终页面，并在实际编译版复测；核对服务返回的入口与资源 hash。新页面依赖新增后端接口，先构建到隔离目录验收；涉及后端部署需要重启时，单独取得这一次的授权。

## 验证记录

- 后端新增用例先复现类型查询缺失、UTF-16 误判和 UTF-8 截断边界问题；修复后相关后端回归为 22 项、21 通过、0 失败、1 项平台跳过。实际 XML 只读验证为文本且未截断；没有修改该文件。
- 文件导航和阅读状态的现有浏览器回归 16/16、锚点与问题 Markdown 8/8、读取拥塞与取消 2/2；新增桌面与 390px 导航验收覆盖目录、项目根、历史与滚动、失败保留、连续点击及切换失效。
- 源码浏览器验收覆盖 13 种语言、CRLF 原文、多色 token、大小边界与 Worker 生命周期。预算内病理长行着色期间，25ms 心跳在 2 秒内执行 80 次；截止后保留完整纯文本，没有阻塞页面。
- 最终串行完整回归命令为 `node --test --test-concurrency=1 --test-timeout=120000 tests/*.test.ts`：589 项、584 通过、0 失败、5 跳过，退出码 0。日志为 `.local/file-preview-verification/full-tests-serial.log`。
- 较早的并发完整运行出现 Windows 辅助程序断言与 Node 安装器测试反序列化错误；原始日志保留在 `.local/file-preview-verification/full-tests-bounded.log`。HEAD 基线及当前单独重跑均通过，相关文件与 HEAD 相同；串行完整回归通过，尚不能据此确定并发失败的原因。
- 旧 `interaction-followup.html` 在文件导航前的共享会话列表断言仍报 `List request not started`，没有将它计为通过，也没有为此改动本轮之外的列表产品逻辑；该夹具中消息选择器已改为按消息 ID 定位，保留原有时间断言。
- 构建使用隔离输出 `.local/file-preview-fixes-build`；真实 Chrome 加载编译资源，沿用服务原有 CSP，检查 Worker 的 200 响应、JavaScript MIME、nosniff 和磁盘 SHA。API 使用隔离样例，不操作真实会话任务；真实服务的部署验收需要另行授权重启。
- 最终 `npm run build -- --outDir .local/file-preview-fixes-build` 退出码 0；编译浏览器脚本 `node tests/file-entry-navigation.browser.mjs --production-fixture --dist-dir=.local/file-preview-fixes-build` 退出码 0，1280px 与 390px 均通过，无页面异常或 CSP 违规。证据目录 `.local/file-preview-fixes-20261009/navigation-1791548890975`；主资源 `/assets/index-CNhgoxOO.js` 的 SHA256 为 `8aafa86f8ffbc944daaba7b7608a214100482c9543956f4a98fa5ec37d1b46f6`。
- 编译截图复核发现 token 颜色会覆盖已有行定位 mark 黑字。只增加 `.source-preview mark span{color:inherit!important}`，复现后在双宽专项与最终编译页验证选中 span 均继承 mark 字色，未选中行仍有语法颜色，CRLF 与尾空行原文保持一致。该 CSS 修正之后没有重复整套 Node 测试；已重新构建并复验受影响的真实浏览器渲染。
- 没有改动线上 `dist` 或安排重启。旧完整源码浏览器脚本在最后颜色专项之前的初始化/语言等待失败日志也已保留；颜色回归使用独立专项及最终编译页面，不将未完成的运行计为通过。
