# Codex Web

[English](README_EN.md)

运行在自己开发机上的轻量 Codex 网页客户端，支持本地和远程访问。通过桌面或手机浏览器管理项目、继续原生 Codex Thread、查看实时执行和 Git 变更，并处理审批。Agent 执行和聊天历史由官方独立 Codex CLI 管理，Web 使用当前宿主用户的 Codex 登录。

## 主要功能

- 选择已有项目、无项目、新建 Git 项目或 Clone，持续对话、插话、中止与释放接力。
- 实时增量同步、历史分页、按需命令输出、安全 Markdown 与原文复制。
- 可调整并记忆的三栏布局，文件预览、统一 / 并排 diff、只读 Git 日志和 JUnit 报告。
- 原生模型 / 推理与审批方式选择，重命名、收藏、Web 隐藏和元数据清除。
- 私有文件 / 图片附件、Web Push，以及只缓存静态外壳的 PWA。

## 平台与前置条件

| 宿主平台 | 范围 |
| --- | --- |
| Windows | 已有源码运行、Windows x64 便携包和计划任务部署记录；本轮回归状态见最新验证记录 |
| Linux | 已在 WSL2 Ubuntu 22.04 普通用户下验证源码运行、真实任务和沙箱边界；不声明全部发行版已验证 |
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

## Windows 便携包

解压到可写目录后双击 `Start.cmd`；包内自带 Node 和运行依赖。首次交互配置工作目录、CLI、端口和密码。缺少 Codex 时，可打开官方页面手动安装，或明确选择同意后运行官方安装脚本；也可指定已有 CLI。安装完成后重新检测并继续配置，账户登录仍须自行完成。保持启动窗口打开，按 Ctrl+C 停止。此包仅适用于 Windows x64，详见 [便携包指南](docs/guides/windows-portable.md)。

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

公开示例中的用户名、路径和会话 ID 均已泛化。原 Git 历史仍有个人环境记录，公开发布应使用 **不含 `.git` 的干净源码包新建仓库**。禁止上传 `.local/`、Codex 原生数据、凭据、附件、数据库、日志、未脱敏截图和测试产物；`docs/assets/screenshots/` 中经脱敏检查的展示图可随文档发布。范围与限制见 [发布指南](docs/guides/publishing.md)。
