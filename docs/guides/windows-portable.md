# Windows x64 便携包

便携包自带固定版本的 Node 和生产依赖，使用者无需安装 Node、npm 或 PowerShell 7。

## 使用

1. 将整个 ZIP 解压到可写目录，例如 `D:\Apps\CodexWeb`，不要直接在压缩包内运行。
2. 项目需要 Git 时另行安装 Git；Codex CLI 可预先安装，也可在启动菜单选择安装方式。
3. 双击 `Start.cmd`，首次填写工作目录、本地端口，并设置 12–256 位 Web 管理员密码（输入不显示）。启动流程检查已有独立 CLI，缺失时按下节处理；账户登录按官方流程单独完成。
4. 浏览器自动打开登录页。保持启动窗口打开，按 `Ctrl+C` 停止服务。`Start.cmd --no-browser` 可关闭自动打开浏览器。

默认仅监听本机 `127.0.0.1`。端口被占用时提示退出，不停止其他程序。修改端口时同步修改 `origin`；远程 HTTPS 与完整配置见 [部署指南](deployment.md)。

配置保存在 `.local/web/config.json`。更换电脑后，请检查其中工作目录和 Codex 路径。便携包不包含 Codex、任何账户或登录信息。

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
- **辅助安装**：选择 2 即同意本次联网下载并运行 `https://chatgpt.com/codex/install.ps1`。官方 PowerShell 安装器在当前用户下安装，可能更新用户 PATH；不提权、不永久改变执行策略。回车、无效输入和非交互启动都不会触发安装。
- **安装结果**：成功后从官方位置重新发现并执行 `--version`，父进程 PATH 尚未刷新也可继续。取消、下载失败、非零退出或检测失败保留已输入信息并返回选择，不保存成功状态。新 CLI 验证成功才更新已保存配置。

CLI 安装与账户登录分开；安装成功不表示已登录，按官方登录提示完成，不向 Web 提交账户凭据。脚本来源与测试范围见 [本轮方案](../design/linux-support-and-docs.md#34-便携包启动时安装-codex-cli补充需求) 和 [验收记录](../verification/2026-09-13-linux.md)。

## 数据与升级

完整数据备份与迁移见 [部署指南](deployment.md#备份升级与回滚)。分享给别人时发送原始发布 ZIP，**不要重新压缩已经使用过的目录**。

## 构建

在 Windows x64 开发机运行：

```powershell
npm ci
npm run package:portable
```

脚本校验固定 Node 二进制的 SHA-256，构建前端，安装生产依赖，保留第三方许可证，并在 `releases/` 生成便携 ZIP、不含 Git 历史的源码 ZIP 和 SHA256SUMS 文件。已下载对应版本的 Node 时，可使用：

```powershell
npm run package:portable -- --node-binary C:\path\to\node.exe
```

提供的二进制仍必须通过固定校验。构建需要访问 Node 官方下载站、其官方 GitHub 源码和 npm registry；已缓存的内容可复用。

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
