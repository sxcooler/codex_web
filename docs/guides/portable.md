# Windows / Linux x64 便携包

便携包自带固定版本的 Node 和生产依赖，使用者无需安装 Node、npm 或 PowerShell 7。Windows 使用 ZIP / `Start.cmd`，Linux x64 glibc 使用 tar.gz / `bash Start.sh`。Linux 需要 Bash；辅助安装 CLI 时需要 curl，无桌面环境可加 `--no-browser`。暂不支持 ARM64、Alpine/musl 和 macOS。

## 使用

1. 将整个包解压到可写目录，例如 Windows 的 `D:\Apps\CodexWeb` 或 Linux 的 `~/apps/codex-web`。Linux 使用 `tar -xzf 包名.tar.gz` 保留执行权限；不要直接在压缩包内运行。
2. 项目需要 Git 时另行安装 Git；Codex CLI 可预先安装，也可在启动菜单选择安装方式。
3. Windows 双击 `Start.cmd`，Linux 在解压目录运行 `bash Start.sh`。首次填写工作目录、本地端口，随后可填写额外绑定域名（回车跳过，裸域名默认 HTTPS），再设置 12–256 位 Web 管理员密码（输入不显示）。默认保留 `http://localhost:端口`，域名加入访问白名单；此步骤不配置 DNS、证书或代理。启动流程检查已有独立 CLI，缺失时按下节处理；账户登录按官方流程单独完成。
4. 首次交互运行询问“以后启动后是否自动转入后台”，默认选择是，并保存到配置的 `background` 字段。旧配置在下一次交互启动补问；非交互启动且没有偏好时保持前台，不自动写入选择。
5. 服务就绪后显示地址并尝试打开默认浏览器。后台启动窗口可以关闭；用 `Stop.cmd` / `bash Stop.sh` 停止，`Status.cmd` / `bash Status.sh` 查看状态。前台运行保持终端打开，按 `Ctrl+C` 停止。

`--foreground`、`--background` 只覆盖本次启动；`--configure-startup` 在交互终端修改默认偏好；`--no-browser` 禁止自动打开浏览器。重复启动会复用本包已管理的实例，其他程序占用端口则失败，不终止该程序。后台模式不安装自启。Windows 可另行运行包内 `scripts/windows/install-startup.cmd` / `uninstall-startup.cmd` 安装或移除登录自启；Linux 可使用包内用户级 systemd 入口。包移动后须重新安装自启。

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

## 缺少 Codex CLI

启动时检查已配置路径、官方默认安装位置和 PATH 中的独立 CLI；可用时直接继续，不重复安装或自动升级。已保存路径失效时保留其余配置，重新选择 CLI。

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

源码导出仅包含 Git 已跟踪文件的当前内容，新文件须先 `git add`，包括 `README_EN.md` 和新 docs 目录。导出排除 `.git`、本地运行数据、环境文件、构建缓存和常见密钥文件；WSL 测试数据不进入源码包。便携程序按运行文件白名单复制，不打包开发目录。

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
