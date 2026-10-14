# Windows / Linux x64 便携包

便携包自带固定版本的 Node 和生产依赖，使用者无需安装 Node、npm 或 PowerShell 7。Windows 使用 ZIP / `Start.cmd`，Linux x64 glibc 使用 tar.gz / `bash Start.sh`。Linux 需要 Bash；辅助安装 CLI 时需要 curl，无桌面环境可加 `--no-browser`。暂不支持 ARM64、Alpine/musl 和 macOS。

**Codex Web 0.1.8 要求 Codex CLI >=0.160.1（本版开发／实测基线）**，仅接受可识别的稳定版本。旧 0.1.6 安装须先独立升级 Codex CLI，运行 `codex --version` 核对版本，再执行 0.1.8 应用更新；应用更新不会升级 CLI。版本过旧、预发布或无法识别时，新服务拒绝启动，更新器按既有规则保留或回滚应用。

## 使用

1. 将整个包解压到可写目录，例如 Windows 的 `D:\Apps\CodexWeb` 或 Linux 的 `~/apps/codex-web`。Linux 使用 `tar -xzf 包名.tar.gz` 保留执行权限；不要直接在压缩包内运行。
2. 项目需要 Git 时另行安装 Git；Codex CLI 可预先安装，也可在启动菜单选择安装方式。
3. Windows 双击 `Start.cmd`，Linux 在解压目录运行 `bash Start.sh`。首次填写工作目录、本地端口和可选域名，再核对独立 CLI，可选择接入 Tailscale，随后设置 12–256 位 Web 管理员密码（输入不显示）。普通域名回车跳过，裸域名默认 HTTPS，加入访问白名单但仍需自行配置 DNS、证书或代理；Tailscale 私有 HTTPS 则由可选接入流程处理。缺少独立 CLI 时按下节处理；账户登录按官方流程单独完成。
4. 首次交互运行询问“以后启动后是否自动转入后台”，默认选择是，并保存到配置的 `background` 字段。旧配置在下一次交互启动补问；非交互启动且没有偏好时保持前台，不自动写入选择。
5. 服务就绪后显示地址并尝试打开默认浏览器。后台启动窗口可以关闭；用 `Stop.cmd` / `bash Stop.sh` 停止，`Status.cmd` / `bash Status.sh` 查看状态。前台运行保持终端打开，按 `Ctrl+C` 停止。

`--foreground`、`--background` 只覆盖本次启动；`--configure-startup` 在交互终端修改默认偏好；`--configure-tailscale` 在交互终端单独配置私网入口，完成后退出，不启动服务；`--no-browser` 禁止自动打开浏览器。重复启动会复用本包已管理的实例，其他程序占用端口则失败，不终止该程序。后台模式不安装自启。Windows 可另行运行包内 `scripts/windows/install-startup.cmd` / `uninstall-startup.cmd` 安装或移除登录自启；Linux 可使用包内用户级 systemd 入口。包移动后须重新安装自启。

启动、停止和状态共用本地管理连接验证实例身份，不根据裸 PID 杀进程；启动失败保留错误提示。Windows 日志位于 `.local/web/server.log`，运行时按约 1 MiB 轮转；Linux 后台输出到 `server.log` / `server-error.log`，启动时轮转，长时间运行需关注磁盘空间。其他入口手动运行的旧实例须在原终端停止后，才能改用这些入口。

默认仅监听本机 `127.0.0.1`。端口被占用时提示退出，不停止其他程序。修改端口时同步修改 `origin`；远程 HTTPS 与完整配置见 [部署指南](deployment.md)。

配置保存在 `.local/web/config.json`。更换电脑后，请检查其中工作目录和 Codex 路径。便携包不包含 Codex、任何账户或登录信息。

### 同时使用 localhost 和域名

0.1.4 起支持额外访问地址。已有配置可保留其他字段，按下面例子修改后用 Stop / Start 重启：

```json
"origin": "http://localhost:3000",
"allowedOrigins": ["https://device.example.ts.net"]
```

这是配置片段，不要替换整个配置文件。`origin` 是默认打开地址，`allowedOrigins` 是额外完整站点地址数组，可填写多个；不支持通配符、路径、查询或账户密码。两个不同主机地址各自登录，共用同一服务和工作目录。旧配置未设置数组时仍只允许原地址，不自动开放 localhost。代理转发目标仍为 `http://127.0.0.1:本地端口`，保留原始 Host；无需把本地端口改成 443。域名、HTTPS 和网络连通需单独配置。

## Tailscale 私有 HTTPS

首次交互配置询问是否接入 Tailscale，默认不启用；跳过或接入失败仍可本机启动，不反复弹出。已有安装先结束任务，用 Stop 入口停止服务，再运行 `Start.cmd --configure-tailscale` / `bash Start.sh --configure-tailscale`。此命令只配置网络，完成后需自行 Start；已有受管实例运行时拒绝修改，不自动停止或重启。

源码部署可运行 `npm run tailscale:setup`，按已有配置端口设置；显式覆盖示例：`npm run tailscale:setup -- --port 3412`。旧入口 `scripts/windows/configure-serve.cmd -Port 3412` 与 `bash scripts/linux/configure-serve.sh 3412` 共用同一实现，默认只使用已安装、已登录的客户端；分别加 `-Interactive` / `--interactive` 可进入安装和登录引导。修改已有部署前先停止 Web，配置完成后手动启动。

- 缺少客户端时显示[官方下载页](https://tailscale.com/download)，手动安装后输入 `retry` 重测；仅输入 `install` 才辅助安装。Windows 调用 winget 的精确 `Tailscale.Tailscale` 包，没有 winget 时手动安装；Linux 下载运行[官方安装脚本](https://tailscale.com/docs/install/linux)。这是系统级第三方客户端安装，可能需要管理员或 sudo 权限；失败可重试或取消，不伪报成功。
- 安装不等于登录。未登录或已停止时手动处理后输入 `retry`，或输入 `up` 同意执行 `tailscale up`，按客户端提示认证。Linux 需要相应权限，失败可在独立终端使用 `sudo tailscale up`，或由管理员授权 operator；脚本不保存 auth key，不切账号、不重置已有偏好。
- 读取实际 MagicDNS 主机名，建立持久私有 HTTPS → `http://127.0.0.1:本地端口`，复读映射确认成功后再更新 Web 配置；保留原字段、额外域名和 localhost。完全相同的已有私有映射可复用；其他映射、Funnel 或不能确认的结构拒绝修改，不全局 reset。
- 首次启用 HTTPS 可能需在 Tailscale 管理页确认域名/证书设置；按提示完成后重试。映射已建而 Web 配置落盘失败时，修复权限并重跑同一端口；不会清除其他映射。非交互模式不自动安装或登录。

手机仍需自行安装 Tailscale，加入同一 tailnet，并满足访问策略。配置成功后使用输出的私有 HTTPS 地址和 Web 密码；脚本不修改光猫、路由器、防火墙、UDP 端口或模型出站代理，也不承诺必然点对点直连。[家庭宽带直连建议](../../README_CN.md#3-让-tailscale-尽量走直连中国家庭宽带)

## 缺少 Codex CLI

启动时检查已配置路径、官方默认安装位置和 PATH 中的独立 CLI，并验证稳定版本 >=0.160.1；可用时直接继续，不重复安装或自动升级。已保存路径失效时保留其余配置，重新选择 CLI。

```text
未找到 Codex CLI，请选择：
1. 打开官方安装页面，手动安装（默认）
2. 同意下载并运行 Codex 官方安装脚本
3. 指定已安装的 Codex 可执行文件
0. 退出
```

- **手动安装**：显示 [官方安装页面](https://learn.chatgpt.com/docs/codex/cli)，并尝试用默认浏览器打开；失败时复制页面链接。安装后可重新检测、指定路径或退出。
- **辅助安装**：选择 2 即同意本次联网下载并运行 Windows 的 `https://chatgpt.com/codex/install.ps1` 或 Linux 的 `https://chatgpt.com/codex/install.sh`。官方安装器在当前用户下安装，可能更新用户 PATH；不提权、不永久改变执行策略。Linux 默认检测 `~/.local/bin/codex`，不使用 Windows 的 `.exe`。回车、无效输入和非交互启动都不会触发安装。
- **安装结果**：成功后从官方位置重新发现并执行 `--version`，父进程 PATH 尚未刷新也可继续。取消、下载失败、非零退出或检测失败保留已输入信息并返回选择，不保存成功状态。新 CLI 验证成功才更新已保存配置。

CLI 安装与账户登录分开；安装成功不表示已登录，按官方登录提示完成，不向 Web 提交账户凭据。脚本来源与测试范围见 [本轮方案](../design/linux-support-and-docs.md#34-便携包启动时安装-codex-cli补充需求) 和 [验收记录](../verification/2026-09-13-linux.md)。

## 数据与升级

完整数据备份与迁移见 [部署指南](deployment.md#备份升级与回滚)。分享给别人时发送原始发布压缩包，**不要重新压缩已经使用过的目录**。

**0.1.8 增量包仅用于运行环境指纹相同、安装文件校验通过的同平台官方便携安装。0.1.8 沿用 0.1.7 的运行依赖、固定 Node 24.20.0 和运行环境指纹算法；本轮验证对象为官方 0.1.7 完整包自身更新器。发布结果与证据范围见 [0.1.8 发布验收](../verification/2026-10-14-release-018.md) 和版本发布页。更早版本本轮未验证直接升级；开发源码目录、跨平台和修改过运行依赖的安装，请使用 0.1.8 完整包迁移。**

新发布流程额外生成 `codex-web-版本-win-x64-update.zip` / `codex-web-版本-linux-x64-update.zip` 应用更新包。它们不包含 Node、node_modules 和用户数据；下载对应平台的更新包及发布页 SHA256 后，在安装目录运行：

应用更新需要安装目录所在文件系统支持硬链接（如 Windows NTFS、Linux ext4），用于原子创建更新锁。FAT32/exFAT 等不支持时会在修改应用前拒绝，请使用完整包迁移；完整包的启动不受此限制。

```powershell
.\Update.cmd C:\Downloads\codex-web-版本-win-x64-update.zip 发布页中的64位SHA256
```

```sh
bash Update.sh /path/to/codex-web-版本-linux-x64-update.zip 发布页中的64位SHA256
```

运行环境不兼容或安装文件被修改时拒绝更新，改用完整包迁移。更新前结束活动任务与待处理交互；更新器验证当前实例后正常停止，更新应用文件、清除旧版已淘汰文件并验证启动，保留更新前的运行/停止状态。`.local` 和外部项目不覆盖，自启动根目录不移动。更新备份保留在 `.local/updates/backup-*`；只备份应用文件，不等于完整用户数据备份。

中断后再次启动会提示恢复，执行 `Update.cmd --recover` / `bash Update.sh --recover`。恢复会保留备份；不要手动删除 `pending.json` 或更新锁来跳过恢复。启动失败会尝试恢复旧应用；恢复失败保留记录并报错，不谎报成功。数据格式迁移不兼容的版本应使用完整包和单独备份方案。

若中断同时损坏了 Update 入口或应用脚本，在安装目录执行 `runtime\node.exe .local\updates\recover.mjs`（Windows）或 `runtime/node .local/updates/recover.mjs`（Linux）。该入口和它引用的恢复代码在修改应用前保存在保留区，不依赖正在被替换的脚本。最终更新记录写入失败时也会保留 pending；先执行恢复，再启动服务。

0.1.5 没有 Update 入口：先将应用更新 ZIP 解压到安装目录以外的新目录，用旧包的 `runtime/node.exe`（Linux 为 `runtime/node`）运行其中 `scripts/update-portable.ts 更新ZIP SHA256 --root 旧安装目录`。旧服务不支持安全更新准备接口，需要先确认无活动任务并通过旧 Stop 入口停止。指纹相同时无需重新下载运行环境。不要将更新 ZIP 直接覆盖解压到安装目录。

## 构建

在对应平台原生构建，不交叉复制依赖。共同需要 Node >=24.20.0、npm 和 Git；Windows 构建需要 PowerShell 7，Linux x64 glibc 构建需要 Bash、curl、tar/xz 和 Python 3（用于通用源码 ZIP）。在普通用户下运行：

```powershell
npm ci
npm run package:portable
```

脚本校验固定 Node 二进制的 SHA-256（Linux 下载包也先核对官方 SHA-256），构建前端，安装当前平台的生产依赖，保留第三方许可证，并在 `releases/` 生成便携 ZIP / tar.gz、不含 Git 历史的源码 ZIP 和平台 SHA256SUMS 文件。清单包含源码提交号和每个文件的散列；构建还会验证后端加载和 sharp 原生图片处理。正式发布应从干净、已提交的工作树构建。同版本再次构建会替换同名产物。已下载对应版本的 Node 时，可使用：

```powershell
npm run package:portable -- --node-binary C:\path\to\node.exe
```

提供的二进制仍必须通过固定校验。构建需要访问 Node 官方下载站、其官方 GitHub 源码和 npm registry；已缓存的内容可复用。

Linux 同样可传 `--node-binary /path/to/node`。Linux tar.gz 保留启动脚本和 Node 执行权限；源码 ZIP 通用于两个平台，但需在目标平台重新 `npm ci`。

源码导出仅包含 Git 已跟踪文件的当前内容，新文件须先 `git add`，包括 `README_CN.md` 和新 docs 目录。导出排除 `.git`、本地运行数据、环境文件、构建缓存和常见密钥文件；WSL 测试数据不进入源码包。便携程序按运行文件白名单复制，不打包开发目录。

仓库和源码包使用英文 `README.md`、中文 `README_CN.md`；便携包为兼容已有更新器，将中文说明放在其已接受的 `README_EN.md` 路径，并同步改写文档链接。包内首页仍为英文，可从顶部“中文”链接切换。

公开发布与内容复查见 [发布指南](publishing.md)。

## 验证发布包

解压到全新测试目录后可运行产物检查（会在该测试目录创建配置和测试数据）：

```powershell
$env:PORTABLE_TEST_DIR = 'C:\temp\fresh-release'
$env:PORTABLE_TEST_CODEX = 'C:\path\to\codex.exe'
node --test tests/portable-package.test.ts
```

`PORTABLE_TEST_CODEX` 指向已有的独立 CLI，检测仅执行 `--version`。检查会校验清单、清空子进程的 Node 搜索路径、检查端口冲突，并用隔离的测试密码启动和登录；不会调用模型。普通 `npm test` 会跳过这项需要真实产物的检查。

Linux 对应命令（必须使用新解压、尚无 `.local` 的目录）：

```sh
PORTABLE_TEST_DIR=/tmp/fresh-release PORTABLE_TEST_CODEX="$HOME/.local/bin/codex" \
  node --test tests/portable-package.test.ts
```

Linux 检查直接运行包内 `Start.sh`，验证启动脚本在含空格的解压路径下可用，并在检查结束时停止服务。

设置 `PORTABLE_TEST_UPDATE` 为对应应用更新 ZIP 的绝对路径，可在同一检查中追加已运行实例的升级、重启与配置/认证数据保留验证。
