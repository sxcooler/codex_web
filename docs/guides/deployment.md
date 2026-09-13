# 源码运行与私网部署

> 公开版本中的用户名、路径、项目名称和会话标识均为示例；历史验收结果仅适用于当时的测试环境。

使用普通宿主用户，在项目目录执行。需要 Node >=24.20.0、npm、官方独立 Codex CLI，以及项目功能所需的 Git。Codex CLI 使用该环境自己的登录与默认 CODEX_HOME，无需另设 API key；Linux/WSL 不复用 Windows 二进制、node_modules 或静默复制 Windows 凭据。

```sh
npm ci
npm run build
npm run auth:setup
npm start
```

已有密码配置时跳过 setup。密码仅在本机交互终端输入（12–256 字符），不要放进命令参数或聊天。默认浏览器地址为 `http://localhost:3000`，监听固定为 `127.0.0.1`。`npm run dev` 只启动前端开发服务器；完整功能使用 build + start。

## Windows 便携包

Windows x64 可使用自带 Node 的便携包；首次配置、CLI 手动/辅助安装和构建检查集中见 [便携包指南](windows-portable.md)。Linux 本轮仅提供源码运行，不提供便携包。

## 配置与数据

`.local/web/config.json` 可设置 `origin`、`port`、`workRoot`、`codexBin`。对应环境变量 `WEB_ORIGIN`、`PORT`、`WORK_ROOT`、`CODEX_BIN` 优先；`WEB_DATA_DIR` 可更换后端数据目录。Windows/Linux 部署脚本固定使用项目的 `.local/web`，不要混用其他数据目录。部署入口按平台放在 `scripts/windows/` 与 `scripts/linux/`，见 [脚本索引](../../scripts/README.md)。

默认工作根目录是当前用户的 `~/work`（Windows 为 `%USERPROFILE%\work`），启动前须自行创建，或将 `WORK_ROOT` 设置为已有目录；服务不会自动创建它。只发现一级项目目录；无项目会话也在该根目录运行。现有原生 Thread 保留原 cwd，未关联项目时不提供 Git 操作。跨系统旧路径不会自动映射成可写项目。

CLI 查找优先级为 `CODEX_BIN > config.codexBin > 平台默认值`；诊断/协议生成不额外加载 Web 配置，只接受 CODEX_BIN 或默认值。Windows 默认 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`，Linux 默认 PATH 中的 `codex`。显式路径无效时修复配置，不自动切换到其他 CLI。需要设置路径时：

```powershell
$env:CODEX_BIN = 'C:\path\to\codex.exe'
```

```sh
export CODEX_BIN="$HOME/.local/bin/codex"
```

Linux 中先核对 `command -v node`、`command -v codex` 和各自 `--version`；WSL 必须调用 Linux Codex，不能经互操作运行 codex.exe。使用 Linux 文件系统中的工作目录，安装本平台依赖。当前 WSL2 Ubuntu 22.04 的具体版本与已通过项目见 [本轮验证](../verification/2026-09-13-linux.md)；尚未记录的检查不视为通过。macOS 本轮未适配、未验证。

| 位置 | 用途 |
| --- | --- |
| `.local/web/auth.json` | 管理员密码散列，禁止公开 |
| `.local/web/*.sqlite*` | 登录会话与 Web 元数据，禁止公开 |
| `.local/web/config.json` | 本机入口配置 |
| `.local/web/server.log`、`.1` | Windows 启动日志，单文件约 1 MiB 轮转；Linux 前台输出到终端，自启服务使用 journal |
| `.local/web/service.env` | 可选 Linux systemd 环境文件，不公开 |
| 默认用户 CODEX_HOME | Codex 原生历史与登录，由官方 CLI 管理 |

`.node-version` 只声明 LTS 基线，不切换 PATH。Windows 部署脚本要求 PowerShell 7（`pwsh.exe` 在用户 PATH 中），优先使用已有 `.local/node24/node.exe`，否则使用 PATH 的 `node.exe`；脚本不下载或替换系统 Node。该规则不适用于 Linux 源码命令，Linux 直接使用当前环境 Node。

## 网络访问方式

Codex Web 可以仅在本机使用，也可以通过受控网络跨设备访问，运行本身不依赖某个 VPN 产品。**不建议直接将服务暴露到公网**，也不建议只靠网页密码保护公网入口。跨设备使用时，建议使用带身份认证、加密和访问控制的虚拟网络，**以 Tailscale 为例**；设备须连接到同一局域网或获准互通的虚拟网络，并确认开发机与服务在线。

| 方法 | 适用场景与接入方式 | 需要配置 |
| --- | --- | --- |
| 本机浏览器 | 只在开发机使用，直接访问 `http://localhost:3000` | 无需虚拟网络或代理 |
| 局域网 + HTTPS 反向代理 | 同一可信局域网内使用；代理只监听局域网地址，转发到 Web 回环端口 | 受信任的证书、域名解析和防火墙；[Caddy 监听地址](https://caddyserver.com/docs/caddyfile/directives/bind)、[反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) |
| Tailscale + Serve（推荐示例） | 手机、电脑加入同一虚拟网络，Serve 提供私网 HTTPS 入口 | 安装登录、设备访问规则和 Serve；[官方示例](https://tailscale.com/docs/use-cases/application-testing/share-local-dev-server-with-team) |
| ZeroTier + HTTPS 反向代理 | 加入同一私有虚拟网络，授权设备后访问代理入口 | 网络成员授权、访问规则、HTTPS；[官方入门](https://docs.zerotier.com/quickstart/) |
| NetBird + HTTPS 反向代理 | 通过虚拟网络和访问策略控制设备互通 | 客户端、访问策略、HTTPS；[官方入门](https://docs.netbird.io/get-started) |
| WireGuard + HTTPS 反向代理 | 已有 VPN 或愿意自行维护隧道的环境 | 密钥、对端、路由、防火墙和 HTTPS；[官方快速开始](https://www.wireguard.com/quickstart/) |
| SSH 本地端口转发 | 已有可达 SSH 服务，临时从另一台电脑访问 | SSH 身份认证及本地转发；[OpenSSH `-L`](https://man.openbsd.org/ssh#L)。手机端需另有隧道客户端 |

上述为可选接入方式，除下方示例外，仓库不自动配置第三方网络、代理或证书，也不表示逐项实机验收通过。虚拟网络只解决受控互通，通常仍需 HTTPS 入口；不要把它等同于自动具备 HTTPS。

Web 固定监听 `127.0.0.1`，**仅连接同一 Wi-Fi 或安装 VPN 并不能直接访问开发机的 3000 端口**。跨设备入口应由受限地址上的代理/隧道转发到回环端口，保留原始 Host，配置 Web 的精确 `origin`，并允许 SSE 长连接。不要为了访问而取消 Host/Origin 检查。

临时 SSH 示例：在访问端执行 `ssh -N -L 127.0.0.1:3000:127.0.0.1:3000 user@dev-host`，再打开 `http://localhost:3000`。访问端端口必须空闲，Web origin 须仍为 `http://localhost:3000`；若已改成 HTTPS 域名，不能直接混用这个示例。Web Push 仍按项目要求使用 HTTPS。

### Tailscale HTTPS 示例

电脑及手机登录允许访问此机器的 tailnet。在 Windows 上执行仓库辅助脚本：

```powershell
pwsh.exe -NoProfile -File scripts/windows/configure-serve.ps1
```

脚本检查现有 Serve 配置；发现任何映射就退出，保留原配置。首次使用可能要求在 Tailscale 管理页启用 HTTPS/Serve。成功后配置私网 HTTPS → `http://127.0.0.1:3000`，将精确 HTTPS origin 写入本机配置，再重启 Web 服务。

此示例使用仅面向虚拟网络的 Serve，不使用面向公网的 Funnel。HTTPS origin 配置后应通过该 HTTPS 地址登录；直接访问 localhost 会被 Host 检查拒绝。Cookie 在 HTTPS 下设置 Secure。参考 [Tailscale Serve 官方说明](https://tailscale.com/docs/reference/tailscale-cli/serve)。

Linux 在宿主安装并登录 Tailscale、取得 Serve 操作权限后运行 `bash scripts/linux/configure-serve.sh`；可追加实际 Web 端口，例如 `bash scripts/linux/configure-serve.sh 3412`。同样拒绝覆盖已有映射，成功后保留其他 Web 配置并写入 origin 和端口。脚本不自动安装 Tailscale、不提权，也不启用 Funnel。WSL 验证覆盖命令及配置保护逻辑，未安装 Linux Tailscale，因此不代表 Linux 跨设备访问已验收。

核验：`tailscale serve status` 显示目标回环地址，在另一台 tailnet 设备访问 HTTPS 页面并登录。确认非 tailnet 设备不可访问；不要开放路由器端口或添加公网代理。手机浏览器支持时可“添加到主屏幕”；PWA 只缓存静态外壳，离线时不能提交任务，API 和会话正文不进入 PWA 缓存。

## Windows 登录后启动

确认本地密码、构建产物和 origin 配置后：

```powershell
pwsh.exe -NoProfile -File scripts/windows/install-startup.ps1 -Start
```

任务名 `Codex Remote Web`，当前用户 Interactive 登录、普通权限、隐藏 PowerShell、IgnoreNew，失败最多重试 3 次。使用绝对路径，不要求启动目录。Microsoft Store 版 PowerShell 7 优先使用当前用户的稳定应用执行别名，避免升级删除版本目录后自启失效；重跑安装脚本可迁移本项目旧任务的版本路径，以及旧的 `scripts/start-server.ps1` 路径。脚本拒绝覆盖启动参数不同或属于其他程序的同名任务。

在任务计划程序核对该任务的用户、触发器和“运行结果”；检查 `.local/web/server.log` 与浏览器登录。真正的注销/重新登录自启仍需实际操作验证。锁屏通常不影响后台任务，但游戏等 GUI 的可用性取决于交互桌面；本次没有验证锁屏/注销后的 GUI 行为。

停止 Web 前先中断/等待运行中的 Turn 并释放会话，然后执行 `pwsh.exe -NoProfile -File scripts/windows/stop-server.ps1`。Windows 任务计划程序单独停止 PowerShell 后可能留下 Node 子进程；此脚本检查任务归属，再结束仅匹配本项目入口路径的 Node，不批量结束其他 Codex 进程。自启任务会保留；要移除自启，在任务计划程序中删除此精确任务。升级先停止服务，更新依赖及构建，再运行 `Start-ScheduledTask -TaskName 'Codex Remote Web'`。

任务管理器里的 Node.js 数量不能直接视为 Web 残留：VS Code、Codex 的 MCP / 浏览器工具和 Playwright 也会启动 Node。先按启动命令、父子关系和监听端口确认归属，不要批量结束 `node.exe`。Windows 隔离回归 `tests/windows-service.test.ts` 验证停止本项目入口后其测试子进程、孙进程退出，无关 Node 保持运行；不代表任意外部工具的进程生命周期都已验证。

## Linux 启停与登录后启动

先完成上面的依赖安装、构建和密码设置。脚本需要 Bash、Linux Node >=24.20.0 和 util-linux 的 `flock`，以当前普通用户执行；不安装依赖、不读取 Windows 工具。前台运行：

```sh
bash scripts/linux/start-server.sh
# 另一终端停止，也可在前台按 Ctrl+C
bash scripts/linux/stop-server.sh
```

启动脚本使用文件锁阻止本项目重复启动；停止脚本检查 PID、启动时间、用户、入口及工作目录，只停止本脚本管理的服务。通过 `npm start` 启动的服务仍在原终端停止。运行中的任务先中止或等待完成并释放会话。

有可用的用户级 systemd 会话时，可安装登录后自启：

```sh
bash scripts/linux/install-startup.sh --start
```

不加 `--start` 仅安装/更新自启。脚本按项目绝对路径生成 `codex-web-<路径摘要>.service`，打印确切服务名及日志命令；不同目录互不覆盖。下例将 `服务名` 替换为脚本输出：

```sh
systemctl --user status 服务名
journalctl --user -u 服务名 -f
bash scripts/linux/stop-server.sh
systemctl --user start 服务名
# 停用登录后自启并停止
systemctl --user disable --now 服务名
```

服务使用安装时的 PATH，失败时有限重试，停止时由 systemd 清理整个服务进程组。Node/CLI 安装路径变化后重新运行安装脚本。systemd 不读取交互 shell 的 profile；如需代理或其他环境变量，在私有文件 `.local/web/service.env` 按 `NAME=value` 每行一项设置（不写 `export`），再重启服务。工作目录和 CLI 路径也可直接放入 Web 的 `config.json`。

脚本不启用 linger；退出用户会话后的持续运行取决于宿主配置。没有用户 systemd 会话时使用前台方式；WSL 发行版本身必须正在运行，自启安装不会让 Windows 自动启动 WSL。实际注销/登录与宿主重启仍需在部署机器验收。

## 会话接力与故障处理

Web 的 Release 先确认终态，再取消订阅。所有任务空闲时会退出自身 app-server；其他任务运行时，释放可能延迟。VS Code 完成回复后也可能保留 active writer，需关闭对应项目窗口后才能由 Web 恢复。不要强杀其他客户端或手工改写原生历史。

当前 CLI 在首条消息前尚未持久化空会话。新建/Clone 不填任务时可以打开空会话并发送第一条消息；此前释放或服务空闲退出、重启会丢失该空会话，但项目文件保留。页面明确提示这一限制；不通过发送隐藏消息来伪造持久化。

提交超时/断网时结果可能未知。先刷新原生历史核对；网页不会自动重发。确认后才解锁再次提交。服务进程重启后内存去重记录失效，因此尤其需要先核对历史。Git/项目创建失败会保留已成功的目录或 Thread，按错误中给出的部分结果继续，不盲目重复创建。

登录失败先核对密码长度与错误提示；连续尝试受速率限制。CLI 故障在 Settings 查看版本/账户状态，不复制凭据到日志。需要升级 CLI 时重新生成协议并做兼容性测试。

本机实际部署状态见 [MVP 验收记录](../verification/2026-09-09-mvp.md)，以上操作说明本身不表示部署已执行。

## 备份、升级与回滚

活动任务结束后再停止自己的 Web 服务并部署。先保留上一构建，完整备份 Web 数据目录（含 SQLite 的 WAL/SHM、uploads 目录和 VAPID 密钥），然后执行 `npm ci` 与 build；图片验证依赖 sharp 的平台包，安装不要禁用其必要安装脚本。不要只备份附件数据库而遗漏实际文件。

首次启动自动迁移 Web 元数据，并在迁移前创建包含 WAL 内容的 SQLite 备份。历史附件持续保留；未认领草稿 24 小时清理，总量满时拒绝新上传。回滚保留 Web 数据和原生历史，使用旧构建；不要删除新增数据列或附件。

Web Push 需要 HTTPS、浏览器支持及用户在设置页主动授权，VAPID 身份保存在私有数据目录。通知仅含通用状态和会话入口，注销/密码修改使订阅失效。物理手机后台投递尚需真实验收，详见 [第二阶段记录](../verification/2026-09-11-phase2.md)。本轮未重启线上服务。

## 分享源码

公开源码与历史处理统一见 [发布指南](publishing.md)。
