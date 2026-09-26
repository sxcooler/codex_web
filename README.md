# Codex Web

[English](README_EN.md)

由于众所周知的原因，在某些国家和地区使用官方版的ChatGPT APP远程控制会有些不便，故产生了本项目。

运行在自己开发机上的轻量 Codex 网页客户端，支持本地和远程访问。通过桌面或手机浏览器管理项目、继续原生 Codex Thread、查看实时执行和 Git 变更，并处理审批。Agent 执行和聊天历史由官方独立 Codex CLI 管理，Web 使用当前宿主用户的 Codex 登录。

## 主要功能

- 选择已有项目、无项目、新建 Git 项目或 Clone，持续对话、插话、中止与释放接力。
- 实时增量同步、历史分页、按需命令输出、安全 Markdown 与原文复制。
- 可调整并记忆的三栏布局，文本 / Markdown / 图片预览、统一 / 并排 diff、只读 Git 日志和 JUnit 报告。
- 原生模型 / 推理与审批方式选择，重命名、收藏、Web 隐藏和元数据清除。
- 私有文件 / 图片附件、Web Push，以及只缓存静态外壳的 PWA。
- 顶栏查看账户额度、自动恢复时间和重置机会；使用机会需二次确认，断线后保留同一次操作供核实。

## 界面展示

**PC 端**

![Codex Web PC 端：项目列表、会话与右侧项目面板](docs/assets/screenshots/desktop.png)

**手机端**

![Codex Web 手机端：会话历史与消息输入区](docs/assets/screenshots/mobile.png)

## 平台与前置条件

| 宿主平台 | 范围 |
| --- | --- |
| Windows | 支持源码运行、Windows x64 便携包和当前用户登录自启；兼容系统 PowerShell 5.1 |
| Linux | 提供 x64 glibc 便携包；源码运行、真实任务和沙箱边界已在 WSL2 Ubuntu 22.04 普通用户下验证；不声明全部发行版已验证 |
| macOS | 本轮未适配、未验证 |

源码运行需要 Node **>=24.20.0**、npm、官方独立 Codex CLI，以及用于项目 /Git 功能的 Git。`.node-version` 声明版本基线，不会自动切换 Node。按 [Codex 官方说明](https://learn.chatgpt.com/docs/codex/cli) 安装并登录；Linux/WSL 应使用 Linux CLI 和该环境自己的登录。不要依赖 VS Code 扩展私有目录内的二进制。

## 源码启动

先创建默认工作根目录 `~/work`（Windows 为 `%USERPROFILE%\work`），或将 `WORK_ROOT` 设置为已有目录；服务不会自动创建它。然后在项目目录运行：

```sh
npm ci
npm run build
npm run auth:setup
npm start
```

已有密码时跳过 setup。密码在本机交互终端设置，长度 12–256 字符。默认访问 `http://localhost:3000`，服务仅监听 `127.0.0.1`。`npm run dev` 仅启动前端开发服务器，完整功能使用 build + start。远程入口、配置和升级见 [部署指南](docs/guides/deployment.md)。

默认工作根目录为当前用户的 `~/work`（Windows 为 `%USERPROFILE%\work`），仅发现一级项目目录。`.local/web/config.json` 配置 `origin`、`port`、`workRoot`、`codexBin`；对应 `WEB_ORIGIN`、`PORT`、`WORK_ROOT`、`CODEX_BIN` 环境变量优先，`WEB_DATA_DIR` 可更换数据目录。Windows 默认查找独立 CLI 官方安装位置，Linux 默认使用 PATH 中的 `codex`。

部署脚本按平台放在 [`scripts/windows/` 和 `scripts/linux/`](scripts/README.md)。Linux 可用 `bash scripts/linux/start-server.sh` 前台启动，或 `bash scripts/linux/install-startup.sh --start` 安装用户级 systemd 自启；先完成上述构建与密码设置。停止、日志和 Tailscale 配置见部署指南。

Windows 可双击 `scripts/windows/start-server.cmd` 后台启动源码部署的服务，日志写入 `.local/web/server.log`，关闭启动窗口不会停止服务；双击 `stop-server.cmd` 停止。CMD 入口优先调用已有 PowerShell 7，否则使用系统自带的 Windows PowerShell 5.1，无需额外安装。其他同名 CMD 分别配置自启和网络入口。

右侧“文件”“变更”和“Git 日志”均支持 PNG、JPEG、WebP、GIF、AVIF 和 SVG 图片预览，按面板宽度缩放。变更预览分别读取工作区、暂存区或提交中的实际版本，展示变更前后图片，支持新增、删除和重命名。SVG 转成静态图，动图显示首帧；文件上限 10 MiB、4000 万像素，预览最长边 2048 像素。“文件”也显示并允许读取 `.gitignore` 忽略的文件；项目目录边界、登录验证及凭据等敏感文件保护仍然生效。Git 变更列表继续遵循 Git 的跟踪规则，刷新后会清除已不在列表中的选中项。

Git 日志用图标和简短名称区分本地分支、远程跟踪分支及标签，支持选择 `origin/main` 等远程分支；“全部分支”也包含仅远程分支可达的提交。三个标签共用“项目”右侧的“刷新”：立即读取本地内容，同时在后台 fetch，完成后更新图谱。获取期间仍可查看文件、切换标签或继续会话；失败保留本地内容并提示。无远程时跳过获取。同项目并发合并，结果保留 10 秒防重复请求；单个远程最多 30 秒，整次最多 60 秒。仅更新和清理远程跟踪分支，不合并代码或修改本地分支、标签、暂存区和工作区。自动刷新及切换标签不触发 fetch，详见[工作区设计](docs/design/workspace-panels.md)。

Markdown 文档支持仓内图片及受限 `<img>`：优先使用 `![说明](相对路径)`，需要尺寸时可使用整数宽高。路径相对文档目录，`/` 表示项目根目录；图片通过现有鉴权预览读取。外部图片、脚本、事件属性和任意样式不会加载或执行。文档源文件保持 GitHub 可用的相对路径，不写入本机路径、私有域名或 Web API 地址，详见 [Markdown 兼容与安全规则](docs/design/markdown.md#仓内图片与-github-兼容2026-09-26)。

## 本地与跨设备访问

推荐的日常用法是：**Windows 开发机后台运行 Codex Web，手机通过 Tailscale 私有 HTTPS 随时接续任务**。代码、执行环境和 Codex 登录都留在开发机，手机只需 Tailscale 和浏览器。以下命令在项目或便携包根目录的 PowerShell 中运行。

### 1. 先在开发机跑通

按上方步骤源码启动，或按下方说明解压便携包、运行 `Start.cmd`。完成原生 Codex 登录、工作目录和 Web 密码设置，确认 `http://localhost:3000` 能登录并完成一个任务；自定义端口时使用实际端口。便携包选择后台运行，源码版使用 `scripts/windows/start-server.cmd`。

### 2. 给手机一个私有 HTTPS 入口

开发机和手机均[安装 Tailscale](https://tailscale.com/download)，登录同一账号加入同一 tailnet，保持连接；使用自定义访问策略时，允许手机访问开发机的 HTTPS 端口。在开发机运行：

```powershell
.\scripts\windows\configure-serve.cmd -Port 3000
```

端口应与 Web 服务一致。首次使用按提示启用 Tailscale HTTPS / Serve；完成后重新运行脚本。脚本建立 HTTPS 到本机回环服务的映射，将实际域名写入 `.local/web/config.json`，并保留原地址供本机访问。已有 Serve 配置时会停止并提示检查，不会覆盖其他服务；不要为此直接清空现有映射。

等任务结束后重启 Web（便携包 `Stop.cmd` → `Start.cmd`，源码版 `stop-server.cmd` → `start-server.cmd`）。手机打开脚本输出的 `https://设备名.tailnet名称.ts.net` 实际地址，用 **Web 密码**登录；HTTPS 与 localhost 各自登录。可在浏览器菜单中“添加到主屏幕”作为日常入口。

这里使用的 [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) 仅供 tailnet 内获准设备访问，无需路由器端口转发或开启公网 Funnel。脚本使用后台持久配置，Tailscale 重启后会恢复映射。服务仍监听 `127.0.0.1`；只输入开发机的 Tailscale IP 并不能替代这个 HTTPS 入口。

### 3. 登录自启与日常接力

```powershell
.\scripts\windows\install-startup.cmd
```

这是**当前 Windows 用户登录后自启**，不是开机未登录就启动的系统服务。启动项使用 Codex Web 名称和图标；`uninstall-startup.cmd` 可移除。开发机须保持开机、联网且不休眠，Tailscale 及所需代理也须运行。手机断开不等于任务停止，重新连接后可查看进展；离线不能发送消息。

CLI、VS Code、Codex App 和 Web 使用同一宿主用户的原生会话时，先在原客户端释放会话再接力，同一会话只保留一个写入客户端。手机无需安装 Codex，也无需复制开发机的凭据。

### 4. 需要出站代理时：让 HTTP 与 WebSocket 使用系统代理

**Tailscale 负责“手机访问开发机”；代理负责“开发机上的 Codex 访问模型服务”**，两者是不同链路。网络本来可直连模型服务时可跳过本节。

Windows 上使用 v2rayN 等代理时，先启用其“系统代理”，确认 Windows 代理指向实际监听地址，例如 `127.0.0.1:10808`（仅为示例，以自己的端口为准）。仅启动代理程序不等于设置了系统代理。

备份原生 Codex 用户配置 `%USERPROFILE%\.codex\config.toml`，在已有 `[features]` 节中加入下面这一项；没有该节时才新建，**不要覆盖整个文件或重复声明该节**：

```toml
[features]
respect_system_proxy = true
```

这是 Codex 原生配置，不是 Web 的 `config.json`。同一 Windows 用户、同一 `CODEX_HOME` 下的独立 CLI、VS Code 扩展和 Codex App 可共用；自定义 `CODEX_HOME`、其他系统用户或 WSL 需检查各自配置。先确认正在使用的 CLI 支持并读到了此选项：

```powershell
codex features list | Select-String respect_system_proxy
```

应显示 `true`；找不到命令时使用独立 CLI 的实际路径。等活动任务结束后，重启 Web 和需要生效的 VS Code / Codex App 原生进程，再发一条短消息验证。启动脚本的 `-NoProfile` 只跳过 PowerShell profile，不阻止 Codex 读取系统代理，因此无需依赖 profile 中的代理变量，也无需调整 Codex 文件访问权限或登录方式。

该开关在 CLI **0.156.1** 中仍标为 `under development`。已验证该版本及 VS Code / Codex App 所带 **0.155.0-alpha.16.3 / 0.155.0-alpha.16.4** 原生程序能经系统代理建立 WebSocket 并收到模型回复；这不代表所有版本和平台都支持，升级后应复核。实现依据见 [Codex 0.156.1 的代理选择逻辑](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/http-client/src/outbound_proxy.rs)。如有回归，仅撤销新增设置并重启相关客户端，保留其他配置及登录凭据。

### 5. 遇到问题先区分链路

| 现象 | 先检查 |
| --- | --- |
| 本机网页也打不开 | 服务状态与端口；便携包 `Status.cmd`，源码版 `scripts/windows/status-server.cmd` |
| 本机正常，手机打不开 | 两端 Tailscale、访问策略、开发机是否休眠，以及 `tailscale serve status` 的 HTTPS 地址和目标端口 |
| 页面可用，但 Codex 反复 `Reconnecting… 5/5` | 模型连接详情、系统代理是否在线、原生配置是否生效；已有 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 也可能影响实际路由 |
| 模型返回 `401 Unauthorized` | 原生账户及 provider / API key 配置；不是正常的 WebSocket 回退提示，不能靠上述代理开关修复 |

WebSocket 重试耗尽后可能回退到 HTTP 流式响应，造成“等很久又好了”；这只是重连的一种原因，不应仅凭 `5/5` 就判断为代理问题。本机使用不需要 Tailscale；Linux、其他网络方案与详细排查见 [部署指南](docs/guides/deployment.md#网络访问方式)。

## 便携包

从 [GitHub Releases](https://github.com/sxcooler/codex_web/releases) 下载对应平台的包，完整解压到可写目录：

| 包 | 启动方式 |
| --- | --- |
| `codex-web-版本-win-x64.zip` | 双击 `Start.cmd` |
| `codex-web-版本-linux-x64.tar.gz` | `tar -xzf 包名.tar.gz`，进入解压目录运行 `bash Start.sh` |
| `codex-web-版本-source.zip` | 通用干净源码，按上方源码启动步骤运行 |

便携包自带 Node 和当前平台的生产依赖，无需安装 Node/npm；Git 与 Codex CLI 需单独准备。首次配置工作目录、本地端口、可选域名、CLI 和密码。0.1.4 起可在 config.json 的 `allowedOrigins` 数组添加额外完整访问地址，让 localhost 与 HTTPS 域名同时可用、各自登录；域名和代理仍需自行配置。缺少 Codex 时，可打开官方页面手动安装，或明确同意后运行对应平台的官方安装脚本。账户登录仍须自行完成。首次交互运行还会询问是否以后默认后台运行；选择后台后，启动成功即可关闭终端，用 `Stop.cmd` / `bash Stop.sh` 停止，`Status.cmd` / `bash Status.sh` 查看状态。`--foreground` / `--background` 临时覆盖，`--configure-startup` 修改偏好，`--no-browser` 禁止自动打开浏览器。后台运行不自动启用登录自启。

Windows 源码版用 `scripts/windows/start-server.cmd` 后台启动；登录自启可选 `scripts/windows/install-startup.cmd`，使用当前用户启动项，无需计划任务、管理员权限或 PowerShell 7；`uninstall-startup.cmd` 移除自启。Linux 登录自启沿用用户级 systemd。

Linux 包面向 x64 glibc 环境，验证环境为 WSL2 Ubuntu 22.04；暂不提供 ARM64、Alpine/musl 或 macOS 包。不要跨平台复制 `node_modules`。构建时在对应平台运行 `npm ci` 和 `npm run package:portable`，产物位于 `releases/`。配置、升级、构建依赖与校验方法见 [便携包指南](docs/guides/portable.md)。

## 使用与边界

会话菜单支持原生归档，切换左栏到“已归档”可恢复；“从 Web 隐藏”仅改变 Web 偏好。用户消息靠右显示，角色名称内侧显示可用的本轮开始/完成时间；插话和缺失原生时间的历史不猜测时间戳。右侧长文件名、提交记录、源码与差异支持区域内横向滚动，Markdown 正文继续自动换行。

打开或手动刷新会话时即核对写入占用，成功后由 Web 持有；其他应用持锁时提前显示提示和“重试”，历史仍可读。占用检查不发送模型消息，自动历史同步不重复获取占用。切换会话或打开新任务会自动请求释放原会话，运行或待审批时延迟到结束。手动“释放并关闭”收到实际释放确认后才离开；同一 Thread 同时只使用一个写入客户端。VS Code 可能在回复结束后仍占用 Thread，需关闭对应项目窗口再回 Web；不会强制抢占。空会话在首条消息前可能未持久化，释放或重启可能丢失空会话，项目文件仍保留。

提交超时或断网可能结果未知；先核对原生历史，再显式重试，刷新不会重发任务。草稿在本次页面生命周期内保留，完整刷新不保证保留。项目上下文不替代 Codex 原生权限；Web 文件和 Git API 保持受控项目边界，无任意 shell/RPC REST 接口。完整操作见 [会话指南](docs/guides/sessions.md)。

Web Push 需要 HTTPS、浏览器支持与用户主动授权；物理手机后台投递及第二阶段真实 VS Code 接力尚有验收缺口。PWA 不缓存 API、聊天或凭据，离线不能提交任务。

## 文档与验证

[文档索引](docs/README.md) · [架构](docs/design/architecture.md) · [最新 Linux 验证记录](docs/verification/2026-09-13-linux.md) · [第二阶段验收](docs/verification/2026-09-11-phase2.md) · [历史 MVP 验证](docs/verification/2026-09-09-mvp.md)

```sh
npm test
npm run build
npm run protocol:generate
npm run probe -- doctor
```

CLI 升级后重新生成协议、审阅差异并验证兼容性；生成内容在忽略目录 `.local/`。`probe -- read` 只读已有测试 Thread；start/verify/reverse/interrupt/approval 会消耗现有账户额度并留下原生历史。verify 已尝试后拒绝重发，不能删除尝试记录绕过保护。历史验证保留日期和版本，不代表当前机器已完成部署；源码更新也不代表运行中的服务已更新。

## 公开发布

公开示例中的用户名、路径和会话 ID 均已泛化。源码包 **不含 `.git` 和本地运行数据**；推送仓库前还须核对准备公开的 Git 历史，删除当前文件不等于清除历史。禁止上传 `.local/`、Codex 原生数据、凭据、附件、数据库、日志、未脱敏截图和测试产物；`docs/assets/screenshots/` 中经脱敏检查的展示图可随文档发布。范围与限制见 [发布指南](docs/guides/publishing.md)。
