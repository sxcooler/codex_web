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

## 界面展示

**PC 端**

![Codex Web PC 端：项目列表、会话与右侧项目面板](docs/assets/screenshots/desktop.png)

**手机端**

<img src="docs/assets/screenshots/mobile.png" alt="Codex Web 手机端：会话历史与消息输入区" width="360">

## 平台与前置条件

| 宿主平台 | 范围 |
| --- | --- |
| Windows | 已有源码运行、Windows x64 便携包和计划任务部署记录；本轮回归状态见最新验证记录 |
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

## 本地与跨设备访问

本机使用不需要虚拟网络。跨设备访问须保证设备与开发机连接到同一局域网或获准互通的虚拟网络，且开发机和服务在线。**不建议直接将服务暴露到公网；建议使用带身份认证、加密和访问控制的虚拟网络，例如 Tailscale 。**

服务仅监听回环地址，跨设备还需配置受限的代理或隧道入口。可选局域网 HTTPS 代理、Tailscale、ZeroTier、NetBird、WireGuard 或 SSH 转发；方案比较、官方文档和 Tailscale HTTPS 示例见 [部署指南](docs/guides/deployment.md#网络访问方式)。

## 便携包

从 [GitHub Releases](https://github.com/sxcooler/codex_web/releases) 下载对应平台的包，完整解压到可写目录：

| 包 | 启动方式 |
| --- | --- |
| `codex-web-版本-win-x64.zip` | 双击 `Start.cmd` |
| `codex-web-版本-linux-x64.tar.gz` | `tar -xzf 包名.tar.gz`，进入解压目录运行 `bash Start.sh` |
| `codex-web-版本-source.zip` | 通用干净源码，按上方源码启动步骤运行 |

便携包自带 Node 和当前平台的生产依赖，无需安装 Node/npm；Git 与 Codex CLI 需单独准备。首次配置工作目录、CLI、端口和密码。缺少 Codex 时，可打开官方页面手动安装，或明确同意后运行对应平台的官方安装脚本。账户登录仍须自行完成。保持终端打开，按 Ctrl+C 停止；`--no-browser` 可用于无桌面的 Linux 环境。

Linux 包面向 x64 glibc 环境，验证环境为 WSL2 Ubuntu 22.04；暂不提供 ARM64、Alpine/musl 或 macOS 包。不要跨平台复制 `node_modules`。构建时在对应平台运行 `npm ci` 和 `npm run package:portable`，产物位于 `releases/`。配置、升级、构建依赖与校验方法见 [便携包指南](docs/guides/portable.md)。

## 使用与边界

打开或刷新会话只读取历史；发送才恢复写入。切换会话或打开新任务会自动请求释放原会话，运行或待审批时延迟到结束。手动“释放并关闭”收到实际释放确认后才离开；同一 Thread 同时只使用一个写入客户端。VS Code 可能在回复结束后仍占用 Thread，需关闭对应项目窗口再回 Web；不会强制抢占。空会话在首条消息前可能未持久化，释放或重启可能丢失空会话，项目文件仍保留。

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
