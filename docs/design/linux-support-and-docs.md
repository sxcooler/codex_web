# Linux 支持与文档整理方案

状态：用户已确认全部方案及 3.4 安装补充，实施中。2026-09-13。

本方案先于实施记录，现按用户确认执行代码、WSL 验证、翻译和文档迁移。实施时按本文件顺序推进，不再另建内容重复的计划文档。

## 1. 目标与范围

- 修复目前运行链路中的 Windows 假设，保留 Windows 使用体验，在本机 WSL2 Ubuntu 22.04 上验证 Linux 源码运行。
- macOS 本轮不适配、不验证，也不声明已支持；WSL 验证不能推广成所有 Linux 发行版均已验证。
- README 改为通用项目介绍和源码启动入口，新增完整对应的 README_EN.md，中文首页顶部加入 `[English](README_EN.md)`，英文首页加入中文链接。
- 用户文档中的命令统一使用 `npm`，不专门强调平台后缀；Windows 脚本内部保留确有需要的平台调用。
- Windows 便携包启动时，缺少 Codex CLI 应提供官方链接手动安装、明确同意后执行官方安装脚本两种方式，安装成功后继续配置。
- 根目录 design-qa.md 移入验证文档；按读者用途整理 docs，合并同主题的设计、计划和验收补充，更新所有仓库内引用。
- 不增加依赖，不新增跨平台部署框架；Linux 先提供源码运行方式，Windows 便携包仍是 Windows x64 专用。本轮不生成 Linux 便携包、不自动发布 GitHub、不重启现有 Windows 服务。

## 2. 已核实的现状

| 位置 | 发现 | 影响 |
| --- | --- | --- |
| src/server/main.ts | 默认 CLI 路径固定在 AppData 下的 codex.exe；已有 CODEX_BIN/config.codexBin 覆盖 | Linux 无法沿用默认路径 |
| scripts/probe.ts、scripts/generate-protocol.ts | 各自重复 Windows CLI 默认路径 | 服务启动成功也可能无法运行诊断或生成协议 |
| src/projects.ts | fold 对所有路径转小写，用于项目 ID、根目录检查和创建检查 | Linux 大小写不同的目录可能被混淆，涉及路径边界 |
| src/server/api.ts | 会话 cwd 与项目路径关联时无条件转小写 | Linux 可能关联到错误项目 |
| src/projects.ts | 目录名强制 Windows 保留名称、尾部字符规则，错误文案写死 Windows | Linux 命名能力受到无必要限制 |
| scripts/portable.ts、package-portable.ts、*.ps1、Start.cmd | Windows 启动、打包和自启流程 | 属于 Windows 发行方式，无需全部改写成通用脚本 |
| README.md | 项目定义与当前 Windows 验证环境混写，测试数停留在旧基线 | 读者容易误认为 Windows 是产品前提 |
| design-qa.md | 标题及内容实际是 2026-09-11 第二阶段验收 | 应按验收记录归档，不应留在根目录 |

已只读确认本机安装了 WSL2 Ubuntu-22.04，当前为停止状态。尚未启动发行版或确认 Linux 内的 Node、Git、Codex 版本与登录状态；这些属于实施时的环境核验。

## 3. 方案选择

采用“共享最小平台规则 + Linux 原生验证”。仅改文档不能解决实际路径问题；全面重做安装器、容器和服务管理超出本轮需要。

### 3.1 CLI 查找与启动

- 提取一个小型共享 CLI 路径解析函数，供服务入口、probe、协议生成使用；可放在新增的 src/codex/executable.ts。
- 优先级保持为 `CODEX_BIN > 配置中的 codexBin（有配置的入口） > 平台默认值`。未提供配置的诊断入口不自行引入新的配置读取机制。
- Windows 保留当前独立 CLI 默认位置；Linux 默认从 PATH 调用 `codex`。显式配置不存在时清楚报错，不悄悄切换到其他 CLI。
- 保持参数数组、shell:false、stdio JSON-RPC、子进程退出处理及宿主会话环境隔离。Linux 必须实际执行 Linux Codex，不能误用 WSL 互操作调用的 codex.exe。
- 启动错误给出可执行文件位置及 CODEX_BIN 配置提示，不输出凭据或完整环境变量。

### 3.2 路径身份、边界与命名

- 对路径身份使用统一规则：Windows 保持现有大小写折叠，Linux 保留大小写。复用该规则修复项目 ID、项目发现、项目创建、会话项目关联的所有调用点，不只修截图涉及的入口。
- 尽量在现有 projects 模块导出并复用小函数，不为平台创建适配器层。实施前追踪 fold 和相关路径比较的全部调用者。
- 磁盘边界仍以 realpath/relative 等原生路径操作校验，不能只比较字符串前缀；验证符号链接指向根外、大小写不同的相邻目录、`..`、绝对路径和分隔符边界。
- Windows 项目 ID 的输入归一化规则保持不变，避免已有收藏和关联失效；Linux 的 Repo 与 repo 在大小写敏感文件系统上必须拥有不同身份。
- 项目创建名称继续拒绝空名称、控制字符、路径分隔符、穿越和产品禁止的隐藏目录；Windows 保留设备名及尾部点/空格限制。Linux 解除纯 Windows 限制，错误提示按实际规则描述。
- 审查项目文件、Git 历史、附件和权限工作目录的路径处理；只调整确实依赖主机路径语义的规则。敏感文件过滤及权限范围不放宽；旧 Windows 会话的路径不得在 Linux 下猜测映射为可写项目。

### 3.3 平台定位

- 浏览器端与宿主系统分开描述，手机和桌面浏览器均连接 Web 服务。
- Windows：继续支持已验证的源码运行、现有便携包和计划任务方式。
- Linux：完成下述验证后，标注“已在 WSL2 Ubuntu 22.04 验证源码运行”，列明实际 Node/Codex 版本。
- macOS：暂未适配与验证。不要写成“所有可运行 Codex CLI 的环境都受支持”。

### 3.4 便携包启动时安装 Codex CLI（补充需求）

调整 scripts/portable.ts 的首次配置和已保存配置失效两条入口，Start.cmd 继续复用同一启动流程。

1. 先检查已配置路径、官方默认安装位置和 PATH 中可用的独立 CLI。找到可用 CLI 时继续，不要求重复安装或自动升级。配置失效时保留其他配置，允许重新选择 CLI。
2. 未找到 CLI 时显示下面的终端菜单，并完整输出官方文档 URL。终端支持链接点击时可直接点击；选择 1 时同时尝试用默认浏览器打开文档，失败则保留可复制链接。

   ```text
   未找到 Codex CLI，请选择：
   1. 打开官方安装页面，手动安装（默认）
   2. 同意下载并运行 Codex 官方安装脚本
   3. 指定已安装的 Codex 可执行文件
   0. 退出
   ```

3. 菜单旁说明选项 2 会联网下载并执行官方 PowerShell 安装脚本，在当前用户下安装 Codex，安装器可能更新用户 PATH；显示脚本来源 `https://chatgpt.com/codex/install.ps1`。选择 2 本身就是本次明确同意，不再连续弹出同义确认；回车、无效输入、非交互启动不能触发安装。
4. 复用官方安装器，不自行实现下载版本选择/解压/升级体系。实施时核对官方安装说明与脚本，使用固定官方 HTTPS 入口，在独立 PowerShell 子进程中运行并显示进度及错误；不从用户输入拼接安装命令，不永久修改执行策略，不擅自提权，也不强制关闭安装器自身的首次交互。
5. 手动安装后提供“重新检测/指定路径/退出”；自动安装成功后重新查找并执行 `--version` 验证，更新本次流程中的 CLI 绝对路径。考虑父进程 PATH 尚未刷新的情况，从官方安装位置重新检测，不要求用户退出重开。检测失败不得保存成功状态或继续启动服务。
6. 下载失败、安装器非零退出或用户取消时保留工作目录、端口等已输入内容，返回安装选择；不无限自动重试，不留下已完成首次配置的假象。已保存配置仅在新 CLI 路径验证成功后更新。
7. CLI 安装与账户登录分开反馈：安装完成不显示“已登录”；需要登录时引导用户通过 Codex 官方登录流程完成，不收集、复制或代填账户凭据。

官方依据：[CLI 安装说明](https://learn.chatgpt.com/docs/codex/cli)、[官方安装器变量与默认安装目录](https://learn.chatgpt.com/docs/config-file/environment-variables)。实施时重新核对当前安装器，不以第三方脚本替代。

补充测试在 tests/portable.test.ts / tests/portable-package.test.ts 中复用现有测试方式，替换外部浏览器和安装器进程调用：覆盖已安装跳过、两种安装选择、默认不安装、取消/失败、成功后重新发现、失效配置修复及未刷新 PATH。自动测试不在开发机反复执行真实安装器。打包到隔离目录验证 Start.cmd 使用更新后的流程；真实安装验证如需进行，使用隔离的用户级安装位置，记录与正式默认安装路径验证的区别。

## 4. WSL 验证设计

### 4.1 环境与隔离

- 确认后启动现有 Ubuntu-22.04；检查发行版、CPU 架构、Node/npm/Git/Codex 路径和版本。
- Node 满足 package.json 的 `>=24.20.0`，采用 Linux 版本的依赖和 Codex；不复用 Windows node_modules。
- 将待验证源码复制到 WSL 自己的 Linux 文件系统独立目录，在大小写敏感文件系统上测试，不直接以 /mnt/c 工作树作为主要验收环境。
- 若缺少工具，优先复用用户已有安装；补齐工具限定在用户级测试环境，记录安装版本。不更改 Windows PATH、全局 Codex 配置或已有会话存储。
- 独立 WORK_ROOT、WEB_DATA_DIR 和空闲端口，服务仍监听回环；只结束本次启动的进程。日志不记录登录凭据，验证工作区不进入源码包。
- Codex 凭据不从 Windows 静默复制到 Linux。若 Linux 没有有效登录，先完成构建、自动测试及无需认证的协议检查，真实任务验证等待用户在 WSL 登录；在验收记录中准确区分已通过与待验证。

### 4.2 验证层次

| 层次 | 检查内容 | 通过条件 |
| --- | --- | --- |
| Windows 回归 | 现有测试、构建；CLI 显式配置与默认值；项目 ID 和路径边界 | 原 Windows 行为保留，测试无新增失败 |
| Linux 自动检查 | npm ci、npm test、npm run build；真实临时 Git、SQLite、sharp、子进程与退出 | 在 Linux 运行通过；Windows 发行包专项测试只能以明确平台原因跳过 |
| Linux 路径专项 | Repo/repo、Windows 保留名称在 Linux 创建、根外符号链接、目录穿越、会话关联 | 不串项目，不越界；合法 Linux 名称可用 |
| Linux 真实协议 | Linux codex app-server 初始化、模型/配置与会话列表读取、协议生成 | 使用真实 Linux 二进制，返回可解析结果，无模拟替代 |
| Web 集成 | Windows 浏览器访问 WSL 测试服务，登录、项目/文件/Git、Markdown、历史与刷新 | 浏览器连接的后端确实是 WSL 服务，主要流程可用 |
| 真实任务烟测 | 在专用临时项目创建小任务、发送、SSE 输出、完成、释放关闭、再次打开继续 | 真实会话可持续使用；只写专用测试项目，不操作已有用户会话 |

运行中插话、中止、审批的稳定回归复用现有模拟 app-server 与浏览器用例；真实任务遇到对应状态时补充核验，不用大量长任务强行制造场景。保留真实烟测产生的会话记录，不以删除原生历史清理测试。

真实任务验证包含少量模型调用，作为用户本次要求的 Linux 验证的一部分执行；仅缺少交互登录等必要输入时暂停相应步骤。最终记录实际命令、版本、测试数、跳过理由及真实/模拟边界。

## 5. 文档分类和合并

不引入文档站点工具；使用 Markdown 和一个 docs/README.md 索引，区分当前操作说明、设计和历史证据。

```text
README.md
README_EN.md
docs/
  README.md
  guides/
    deployment.md
    windows-portable.md
    sessions.md
    publishing.md
  design/
    architecture.md
    session-workspace.md
    session-sync.md
    workspace-panels.md
    markdown.md
    execution-process.md
    linux-support-and-docs.md
  verification/
    2026-09-09-mvp.md
    2026-09-11-phase2.md
    2026-09-13-linux.md
  archive/
    initial-design.md
    mvp-implementation.md
```

Linux 验证记录文件使用实际执行日期；上面日期为本方案预期，不提前写通过结论。

### 5.1 原文档到目标文档

| 原文件/文件组 | 处理与目标 |
| --- | --- |
| docs/deployment.md | 改写为 guides/deployment.md；合并通用配置、源码启动、Windows/Linux 差异、远程 HTTPS、备份与排障；Windows 计划任务保留为平台小节 |
| docs/portable.md | 移入 guides/windows-portable.md；保留 Windows 包使用/构建/验证，通用配置和备份改为引用部署文档 |
| docs/session-lifecycle.md | 整理成 guides/sessions.md；保留用户操作流程，协议细节指向设计文档 |
| docs/privacy-review.md | 移入 guides/publishing.md；集中公开发布、干净源码、新仓库与隐私检查；其他指南不再重复整段说明，保留历史扫描范围和限制 |
| docs/codex_remote_web_handoff.md + specs/2026-09-08-codex-remote-web-design.md | 提炼当前架构到 design/architecture.md；原始需求和初始设计的独有约束、暂缓范围、历史环境合并到 archive/initial-design.md，明确后续设计优先，不继续把 Windows 历史环境当作通用要求 |
| specs/2026-09-11-phase2-design.md + plans/2026-09-11-phase2.md | 合并为 design/session-workspace.md；正文描述实际流程和边界，阶段计划及差异放历史附录，后续专项设计用链接引用 |
| session-sync 的 spec/plan + session-performance 的 spec/plan | 四份合并为 design/session-sync.md；按最终实现统一水位、回放、gzip、分页、按需输出、列表性能；保留历史测量日期及条件 |
| workspace-panels 的 spec/plan | 合并为 design/workspace-panels.md，保留交互、Git 约束及验证记录 |
| plans/2026-09-11-markdown-rendering.md | 整理为 design/markdown.md；保留消息渲染与安全约束，文件预览引用面板设计 |
| specs/2026-09-11-execution-process-design.md | 移入 design/execution-process.md |
| plans 下 phase0-protocol、phase1-auth、mvp 三份 | 合并为 archive/mvp-implementation.md，标注历史阶段和已完成/未验证状态 |
| compatibility 下 phase0、phase1-auth、mvp 三份 | 合并为 verification/2026-09-09-mvp.md，以阶段小节保留原始版本、结果和未验证项 |
| 根目录 design-qa.md | 移为 verification/2026-09-11-phase2.md；明确它是第二阶段验收，修正内部相对链接 |
| 本方案 | 确认并整理目录时移为 design/linux-support-and-docs.md，追加执行结果 |

specs/plans 指原 docs/superpowers 下对应目录。迁移完成后移除已合并的旧文件与空目录，不同时维护两套正文。

### 5.2 合并规则

- 以源码与最近已确认实现为当前行为；例如旧同步设计里的缓存预算、暂不分页等被后续方案替代的描述，不能与最终规则并列呈现。
- 保留独有设计理由、明确不做项、协议约束、失败边界及验收证据；去掉重复步骤、重复背景和已无用途的代理分工提示。
- 历史测试结果保留日期与实际版本，不把 65/121 等旧测试数改成看似当前的结论。README 只链接最近验证记录，不堆历史跑分。
- 旧文档路径/标题到新路径/章节的映射记在 docs 索引归档说明中；同步修正文档、测试、脚本、打包说明中的链接和路径引用。
- 不因整理文档重新扫描或导出私人原生会话；公开示例继续使用泛化数据。

### 5.3 双语 README

两份 README 对齐以下内容：项目定位、主要功能、平台支持、前置条件、源码启动、Windows 便携包（包含 CLI 手动/辅助安装选择）、配置入口、文档索引、验证边界、公开发布说明。安装菜单的详细流程集中在 guides/windows-portable.md。

通用命令使用 `npm ci`、`npm run build`、`npm run auth:setup`、`npm start`。环境变量示例仅在确实需要时区分 PowerShell 与 Linux shell。其他 docs 本轮保持中文；英文 README 清楚标注链接到中文详细文档。

英文翻译以整理后的中文版为准，完整翻译而非缩减版，不承诺尚未验收的平台或设备功能。

## 6. 实施顺序与验收清单

- [x] 读取本方案及当前调用链，在独立工作区修复 CLI 解析；补充默认值、显式覆盖、路径含空格和缺失 CLI 的最小回归测试。
- [x] 修复路径规则及全部调用者，补充真实临时目录、符号链接和 Git 仓库回归；Windows 已有项目 ID 保持一致。
- [x] 实施便携启动安装选择及失效配置恢复，核对官方安装器，测试同意、手动、取消、失败和成功后继续配置分支。
- [x] 在 Windows 跑相关专项测试、全量测试与构建；不重启现有服务。
- [x] 在 Ubuntu-22.04 的 Linux 文件系统准备隔离环境，跑安装、全量测试、构建、真实协议和浏览器/任务烟测；遇到问题先修复再复验。
- [x] 按上表迁移合并文档，先整理中文 README，再翻译 README_EN.md；依实际验证结果填写支持矩阵。
- [x] 检查全部仓库内 Markdown 相对链接、图片链接和章节锚点，扫描旧路径引用；确认 README 英文链接、返回中文链接及 docs 索引可达。
- [x] 检查源码导出文件清单包含 README_EN.md 和新 docs 路径，不包含 WSL 测试数据；因补充需求修改了便携启动流程，生成隔离 Windows 便携产物完成启动验证，正式发布包在最终交付时按用户要求生成。
- [x] 汇总改动与测试结果，本次实施提交最终 squash 为一个中文 commit，原提交信息保留在最终提交说明中；方案文档的提交独立留存，不改写此前历史。

完成标准：Windows 回归通过；Linux 以真实 WSL 环境证据验收，未完成项明确列出；文档目录无重复主文档、无失效内部引用；中英文 README 内容对应，macOS 明确未处理。


## 7. 执行记录

文档已按第 5 节迁移合并，新增完整英文首页与双向语言链接；本方案完整保留在新目录，原路径映射见 [文档索引](../README.md#旧路径与章节映射)。同步旧规则的替代、阶段测试数、真实/模拟验收边界及初始独有约束均保留说明。

Linux 实测版本、代码回归和便携安装检查集中记录到 [2026-09-13 验证](../verification/2026-09-13-linux.md)；代码、文档、普通用户自动化回归和已登录真实任务验收均已完成。真实浏览器验证了创建、插话、增量输出、中止、刷新、释放重开及继续；工作区外写入被 Linux 沙箱拒绝。macOS 和其他 Linux 发行版不在本轮验证范围内。
