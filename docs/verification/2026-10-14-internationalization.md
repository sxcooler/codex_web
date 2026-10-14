# 国际化实施与验收

本轮按[架构方案](../../codex-drive/specs/2026-10-14-internationalization.arch.md)的推荐选项实施；[plan](../superpowers/plans/2026-10-14-internationalization.md)在修改产品代码前保存。基线提交为 `54758aa`，独立工作树与所有临时输出位于被忽略的 `.worktrees/` / `.local/`。未新增依赖。

## 实施范围

- `src/web/i18n/` 包含类型安全的中文／英文目录、Context、偏好解析与语言控件，以及 Intl 展示 helper。默认 system；仅保存 `codex-web:locale:v1`。首次 React 渲染前设置 html lang/dir。正常跨标签同步与语言变化不写回，保存失败保留临时选择和重试入口。
- 登录、Home、侧栏、布局、会话／执行／审批／附件／Fork、设置／通知、账户用量、项目与 Git、文本／图片／Markdown／Mermaid 预览均迁移语义文案和可访问名称。长期提示保存 descriptor，异常保留原 Error，在渲染时翻译。
- 原有业务 effect 依赖和 React key 保持，固定文件排序保持。Markdown 图片 renderer 移到模块级，避免文案 AST 重算重挂载已失败图片；真实回归核对同源图片 GET 不增加。
- 客户端传输异常仅附加展示 descriptor，原 Error.message/status/data/partial 和 auth-lost 行为保持。服务端通用认证／验证／禁止／NotFound／Internal 分支追加窄 code，原 error 和 HTTP 状态保持。Fork 明确拒绝允许显式重试，partial／未知 code／5xx 仍待核实。
- 390/1440px 与 CSS `zoom:2`（200%）展示的实测问题作有限 CSS 修复：设置行换行、分类下拉最小宽度、窄内容容器内诊断列堆叠、面板 tabs 换行；侧栏操作允许换行。

人工检查的目录与 UI 范围如下。两份目录 key 集合相同，静态／动态参数签名由 TypeScript 检查；数量记录实际目录，不据此声称覆盖任意未来 UI 或未知原生内容。

| 目录 | key 数 | 检查范围 |
| --- | ---: | --- |
| common | 31 | 共用按钮、偏好失败、传输提示及窄错误码 |
| app | 101 | 登录、Home、侧栏、会话菜单、全局提醒、面板开关／分隔条 |
| account | 72 | 用量控件、周期、恢复倒计时、余额、机会、确认与结果 |
| session | 235 | 历史／同步／占用、发送、执行、审批、模型权限、附件、Fork／引用 |
| settings | 252 | 分类、原生配置、指令、插件、Web、诊断／维护／密码／通知 |
| panels | 142 | 项目选择、Git／报告／文件、文本／图像／Markdown／Mermaid 预览 |

## 验证与证据

最终验证结果由本轮命令输出核对，日志和未脱敏截图保留在本地 `.local/`，不随文档发布。

| 检查 | 实际结果 | 本地证据 |
| --- | --- | --- |
| 修改前完整 Node 基线 | 772 项：767 通过、5 跳过、0 失败 | `i18n-baseline.log` |
| 首轮整合 Node | 789 项：784 通过、5 跳过、0 失败；其后补防御回归并修复 | `i18n-full-tests.log` |
| 最终完整 Node（并发 2） | 791 项：786 通过、5 跳过、0 失败、0 取消 | `i18n-full-concurrency2.log` |
| 最终完整 Playwright（冻结测试 watcher） | 179/179 通过，0 失败／跳过 | `i18n-browser-stable.log` / `i18n-browser-stable/` |
| 应用 TypeScript 与目录类型反例 | 最终源码均通过 | `tsc --noEmit` 及 `tests/i18n-types.ts` 专项 |
| 最终生产构建 | 通过；现有大块资源警告仍保留 | `i18n-build-final.log` / `i18n-dist/` |
| 独立源码审查 | 1 Important、2 Minor 均修复，复核无未解决 Important/Critical | 下述审查记录 |
| 本机静态入口 | HTTP 200；409 个文件哈希一致，新旧入口资源均 HTTP 200 | `i18n-static-verification.json`；不重启后端 |

完整 Node 使用 `npm test`。完整浏览器使用现有 Playwright spec 套件，旧中文用例显式固定 `locale:'zh-CN'`，新增 English/system 用例独立断言；24 个独立 browser 脚本也固定中文，但未将未执行脚本计入通过分母。Browser 插件未提供可用 Chrome surface，采用隔离 Chrome/Playwright，未复用真实登录会话。TEMP/TMP、Vite 与 Playwright 缓存均落在本工作树 `.local`，共享 node_modules Junction 不写入。

新增浏览器覆盖：登录前语言初始化、刷新、跨标签保存与 clear、无关 storage key、languagechange、保存失败与重试；Home 草稿／焦点／已有同步提醒；会话草稿、unknown outgoing、审批答案、旧历史、memo 命令展开；设置 dirty／离开对话框／指令／插件原文／通知权限；账户确认框与在途 mock reset；Git／Markdown／Mermaid 复制反馈、原文、滚动、图片失败状态。检查 GET、POST、EventSource、权限及订阅次数不因切语言增加。模仿重置的请求只发送到测试 route，未调用真实服务。

## 红绿回归、失败与限制

保留失败分母：基础行为缺失 4 项 RED；账户与传输 2 项 RED；认证窄 code 缺失 RED；三个组件域实际英文控件缺失 RED；设置布局 2 项尺寸 RED；面板 tabs 截断及 Markdown 失败图片重复 GET 均先观察 RED。新增错误码引发的 Fork 400/401/403 误判，三项浏览器先 RED；生产 missing-key 诊断缺失及原型名称绕过 allowlist 两项防御问题也先 RED，随后逐项验证。

临时浏览器配置／watch ignore 的失败单独保留，未计作产品行为 RED。初次会话旧专项 47 项中 46 通过、1 失败，因并行编辑触发 Vite 整页刷新污染超时用例；冻结本域 watcher 后单项及完整 47/47 复核通过。设置第三处诊断列问题有修复前截图，新增断言在修复后才运行，只观察到 GREEN，不声称 RED。纯“无水平溢出”不足以证明控件可用，最终添加控件边界、说明／选项／诊断值列宽断言并查看截图。

整合复核另保留两轮默认并发 Node 结果：791 项中 785 通过、1 失败、5 跳过（原有 startup backoff 读取次数断言）；下一轮 785 通过、1 取消、5 跳过（原有服务退出 fixture 在 10 秒超时后清理停滞）。前者测试冻结 Date，但预先捕获的 timers/promises 仍经过真实 200ms 退避，单独 16/16 复核通过；后者仅结束核实过父子关系及本工作树临时路径的测试进程，让取消结果落账。原 Runtime、预算及这些测试未修改。最终使用同一完整文件集合、限制两个测试进程并发复核。

完整浏览器首轮 178/179 通过，一项附件错误节点在切语言后消失。该项单独 trace 复核 1/1，冻结测试热更新后带 input/change 事件与 composer 状态记录再测 5/5；实际仅各派发一次六文件 input/change，错误文本和展开输入区保持。首轮没有足够状态证据确认原因，不将其归因于已证实的产品缺陷或热更新；保留失败记录，冻结 watcher 后最终完整套件 179/179 通过。一次未设置隔离 TEMP 的诊断运行有两项 mkdtemp EPERM，不计作产品行为或通过；设置工作树 TEMP 后该文件 16/16。

独立审查发现并修复：新窄 code 导致 Fork 明确拒绝被误标 unknown；missing-key 的生产一次诊断缺失；Object 原型名称绕过目录／错误码查询。诊断只记录 key，不记录参数；未知错误 code 保持原 message。

模型／用户内容、原生项目名与插件描述、权限 reason、Git 提交、命令输出、路径、引用和未知服务端 warning/message 保留原文。`stepLabels` 的中文兼容表和 `sessionGroups` 默认“无项目”输出保持；UI 使用 locale 或既有空 group key 翻译。账户余额与可用次数保留原始精确十进制字符串，不通过 Number 丢失精度；原时区、倒计时舍入和重置幂等标识保持。

本轮没有真实任务／writer／审批、Tailscale 操作、真实通知权限、真实账户重置、后端重启、推送或发布验收。新服务端 code 要等后续按受管流程安全重启才能用于当前运行后端；旧后端仍可显示原 error。便携发布包未重打。

静态复制首次目录参数不兼容 PowerShell，产生非终止错误；随后采用 .NET 路径方法及终止错误模式完整重复制。入口最后写入，旧哈希资源保留；409 个文件逐一 SHA256 核对与新旧入口资源 HTTP 核对均通过。
