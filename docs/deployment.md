# Windows 私网部署

> 公开版本中的用户名、路径、项目名称和会话标识均为示例；历史验收结果仅适用于当时的测试环境。

在项目目录执行以下命令，使用当前普通 Windows 用户。部署脚本要求 PowerShell 7（`pwsh.exe` 在用户 PATH 中）；Codex CLI 沿用此用户已有登录和默认 CODEX_HOME，无需另设 API key。

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run auth:setup
npm.cmd start
```

已有密码配置时跳过 setup。密码仅在本机交互终端输入（12–256 字符），不要放进命令参数或聊天。默认浏览器地址为 `http://localhost:3000`，监听固定为 `127.0.0.1`。`npm.cmd run dev` 只启动前端开发服务器；完整功能使用 build + start。

## Windows 便携包

解压运行包后双击 `Start.cmd`。首次运行会交互配置工作目录、独立 Codex CLI 路径、端口和密码；保留启动窗口，按 Ctrl+C 停止。便携包自带 Node，Codex CLI 与当前用户登录需由使用者准备。打包命令及升级、数据目录说明见 [便携包说明](portable.md)。

## 配置与数据

`.local/web/config.json` 可设置 `origin`、`port`、`workRoot`、`codexBin`。对应环境变量 `WEB_ORIGIN`、`PORT`、`WORK_ROOT`、`CODEX_BIN` 优先；`WEB_DATA_DIR` 可更换后端数据目录。计划任务启动脚本固定使用项目的 `.local/web`，不要混用其他数据目录。

默认工作根目录是 `%USERPROFILE%\work`，只发现一级 Git 项目；无项目会话也在该工作根目录运行。现有原生 Thread 保留原 cwd，未关联项目时不提供 Git 操作。

| 位置 | 用途 |
| --- | --- |
| `.local/web/auth.json` | 管理员密码散列，禁止公开 |
| `.local/web/*.sqlite*` | 登录会话与 Web 元数据，禁止公开 |
| `.local/web/config.json` | 本机入口配置 |
| `.local/web/server.log`、`.1` | 启动日志，单文件约 1 MiB 轮转 |
| 默认用户 CODEX_HOME | Codex 原生历史与登录，由官方 CLI 管理 |

系统 PATH 中的 Node 仍是用户安装版本。`.node-version` 只声明 LTS 基线，不切换 PATH。启动脚本优先使用已有 `.local/node24/node.exe`，否则使用 PATH 的 `node.exe`；它不下载或替换系统 Node。

## Tailscale HTTPS

电脑及手机登录允许访问此机器的 tailnet，然后执行：

```powershell
pwsh.exe -NoProfile -File scripts/configure-serve.ps1
```

脚本检查现有 Serve 配置；发现任何映射就退出，保留原配置。首次使用可能要求在 Tailscale 管理页启用 HTTPS/Serve。成功后配置私网 HTTPS → `http://127.0.0.1:3000`，将精确 HTTPS origin 写入本机配置，再重启 Web 服务。

此项目使用 Serve，不使用 Funnel。HTTPS origin 配置后应通过该 HTTPS 地址登录；直接访问 localhost 会被 Host 检查拒绝。Cookie 在 HTTPS 下设置 Secure。参考 [Tailscale Serve 官方说明](https://tailscale.com/docs/reference/tailscale-cli/serve)。

核验：`tailscale.exe serve status` 显示目标回环地址，在另一台 tailnet 设备访问 HTTPS 页面并登录。确认非 tailnet 设备不可访问；不要开放路由器端口或添加公网代理。手机浏览器支持时可“添加到主屏幕”；PWA 只缓存静态外壳，离线时不能提交任务，API 和会话正文不进入 PWA 缓存。

## 登录后启动

确认本地密码、构建产物和 origin 配置后：

```powershell
pwsh.exe -NoProfile -File scripts/install-startup.ps1 -Start
```

任务名 `Codex Remote Web`，当前用户 Interactive 登录、普通权限、隐藏 PowerShell、IgnoreNew，失败最多重试 3 次。使用绝对路径，不要求启动目录。脚本拒绝覆盖执行命令不同的同名任务。

在任务计划程序核对该任务的用户、触发器和“运行结果”；检查 `.local/web/server.log` 与浏览器登录。真正的注销/重新登录自启仍需实际操作验证。锁屏通常不影响后台任务，但游戏等 GUI 的可用性取决于交互桌面；本次没有验证锁屏/注销后的 GUI 行为。

停止 Web 前先中断/等待运行中的 Turn 并释放会话，然后执行 `pwsh.exe -NoProfile -File scripts/stop-server.ps1`。Windows 任务计划程序单独停止 PowerShell 后可能留下 Node 子进程；此脚本检查任务归属，再结束仅匹配本项目入口路径的 Node，不批量结束其他 Codex 进程。自启任务会保留；要移除自启，在任务计划程序中删除此精确任务。升级先停止服务，更新依赖及构建，再运行 `Start-ScheduledTask -TaskName 'Codex Remote Web'`。

## 会话接力与故障处理

Web 的 Release 先确认终态，再取消订阅。所有任务空闲时会退出自身 app-server；其他任务运行时，释放可能延迟。VS Code 完成回复后也可能保留 active writer，需关闭对应项目窗口后才能由 Web 恢复。不要强杀其他客户端或手工改写原生历史。

当前 CLI 在首条消息前尚未持久化空会话。新建/Clone 不填任务时可以打开空会话并发送第一条消息；此前释放或服务空闲退出、重启会丢失该空会话，但项目文件保留。页面明确提示这一限制；不通过发送隐藏消息来伪造持久化。

提交超时/断网时结果可能未知。先刷新原生历史核对；网页不会自动重发。确认后才解锁再次提交。服务进程重启后内存去重记录失效，因此尤其需要先核对历史。Git/项目创建失败会保留已成功的目录或 Thread，按错误中给出的部分结果继续，不盲目重复创建。

登录失败先核对密码长度与错误提示；连续尝试受速率限制。CLI 故障在 Settings 查看版本/账户状态，不复制凭据到日志。需要升级 CLI 时重新生成协议并做兼容性测试。

本机实际部署状态见 [MVP 验收记录](compatibility/2026-09-09-mvp.md)，以上操作说明本身不表示部署已执行。

## 第二阶段升级

活动任务结束后再停止自己的 Web 服务并部署。先保留上一构建，完整备份 Web 数据目录（含 SQLite 的 WAL/SHM、uploads 目录和 VAPID 密钥），然后执行 `npm.cmd ci` 与 build；图片验证依赖 sharp 的平台包，安装不要禁用其必要安装脚本。不要只备份附件数据库而遗漏实际文件。

首次启动自动迁移 Web 元数据，并在迁移前创建包含 WAL 内容的 SQLite 备份。历史附件持续保留；未认领草稿 24 小时清理，总量满时拒绝新上传。回滚保留 Web 数据和原生历史，使用旧构建；不要删除新增数据列或附件。

Web Push 需要 HTTPS、浏览器支持及用户在设置页主动授权，VAPID 身份保存在私有数据目录。通知仅含通用状态和会话入口，注销/密码修改使订阅失效。物理手机后台投递尚需真实验收，详见根目录 design-qa.md。本轮未重启线上服务。

## 分享源码

不要直接推送已有 Git 历史。使用经过审查且不含 `.git` 的源码包，在新目录初始化 Git 并配置自己的提交身份。禁止复制 `.local/`、默认用户 Codex 目录、附件、数据库、日志或认证文件；具体审计范围和限制见 [隐私检查说明](privacy-review.md)。
