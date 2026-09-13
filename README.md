# Codex Remote Web

> 公开版本中的用户名、路径、项目名称和会话标识均为示例；历史验收结果仅适用于当时的测试环境。

运行在家中 Windows 开发机上的轻量 Codex 客户端：React 网页、原生 Thread、实时工具/审批、项目管理与 Git diff。使用官方独立 Codex CLI 和当前用户的已有登录。

[需求 handoff](docs/codex_remote_web_handoff.md) · [设计](docs/superpowers/specs/2026-09-08-codex-remote-web-design.md) · [部署说明](docs/deployment.md) · [MVP 实际验收](docs/compatibility/2026-09-09-mvp.md)

## Windows 便携包

解压运行包后双击 `Start.cmd`。首次运行会交互配置工作目录、独立 Codex CLI 路径、端口和密码；保留启动窗口，按 Ctrl+C 停止。便携包自带 Node，Codex CLI 与当前用户登录需由使用者准备。打包命令及升级、数据目录说明见 [便携包说明](docs/portable.md)。

## 启动

在本项目的 PowerShell 终端执行：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run auth:setup
npm.cmd start
```

已设置密码时跳过 setup。默认访问 `http://localhost:3000`，服务仅监听回环。完整远程入口使用 Tailscale Serve HTTPS，登录后自动启动使用 Windows 计划任务，步骤与当前验收状态见部署文档。`npm.cmd run dev` 只运行前端开发服务器，不是完整服务。

## 使用

选择已有项目、无项目、新建或 Clone 仓库后开始任务。会话页展示原生消息、工具执行、待审批交互和 Git 结果，支持继续、中止、释放并关闭。返回网页会同步列表与当前会话，也可分别手动刷新；已释放会话重新打开后，发送时恢复原有历史。刷新页面不会重发任务；结果未知时先核对原生历史。完整流程与边界见 [会话生命周期](docs/session-lifecycle.md)。

切换会话或打开新任务会自动请求释放原会话；正在运行或待审批时，任务保留并在结束后释放。也可使用“释放并关闭”，收到实际释放确认后才离开页面。切换到 VS Code 前需等待释放完成。同一 Thread 同时只能有一个写入客户端；VS Code 可能在回复完成后仍占用 Thread，需关闭对应项目窗口后再回 Web。没有强制抢占或杀死其他客户端的功能。

项目仅从 WORK_ROOT 一级 Git 目录发现，默认 `%USERPROFILE%\work`。新建和 Clone 的目录由后端约束；没有任意 shell/RPC REST 接口。Codex 自身仍可按用户任务执行 Windows 操作，审批策略保留。

## 环境与验证

- 独立官方 CLI 验证版本：0.153.4，默认路径 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`。
- Node 24.20.0 LTS 与本机 26.2.0 均通过 65 项测试。系统 Node/PATH 未修改；`.node-version` 不会自动切换版本。
- 本机 `.local/node24/node.exe` 仅为额外 LTS 验证环境，不提交到 Git。没有它也可用满足 package engines 的系统 Node。
- 使用 `npm.cmd` 避免 PowerShell 对 npm.ps1 的执行策略限制，无需修改系统策略。

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run protocol:generate
npm.cmd run probe -- doctor
```

CLI 升级后重新审阅生成协议并执行兼容性验证；生成结果位于忽略目录 `.local/`。配置和认证数据同样不提交。PWA 只缓存静态外壳，不缓存 API、聊天或登录凭据。

历史兼容性结果见 [MVP 验收记录](docs/compatibility/2026-09-09-mvp.md)。这些记录已泛化个人标识，不表示下载后的机器已完成部署或验收。

## 协议诊断

[阶段 0 兼容性记录](docs/compatibility/2026-09-09-phase0.md) 保留此前真实 VS Code 往返、审批拒绝与中断证据。[认证记录](docs/compatibility/2026-09-09-phase1-auth.md) 保留认证入口基线。

`npm.cmd run probe -- read` 只读已有测试 Thread；改变会话的 start/verify/reverse/interrupt/approval 会使用现有账户额度并留下原生历史，不应重复执行已完成的验证。verify 在已尝试后拒绝重发；先检查历史和 active writer 状态，不删除尝试记录来绕过保护。

## 第二阶段

第二阶段源码包含自动释放、可记忆的三栏宽度、模型/审批选择、会话整理、文件/diff/JUnit、附件和 Web Push。保持原配色，当前验证及尚未进行的真实设备验收见 [实施验收](design-qa.md)。构建与测试在隔离工作区完成；合入开发分支不表示线上服务已部署。

## 公开发布

发布前阅读 [隐私检查说明](docs/privacy-review.md)。当前公开文件已泛化本机标识，但原 Git 历史仍包含旧记录，不适合直接推送；请使用不含 `.git` 的干净源码包新建仓库。`.local/`、原生 Codex 数据、凭据、日志、截图和测试产物均不应上传。
