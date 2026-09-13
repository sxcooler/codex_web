# Windows x64 便携包

便携包自带固定版本的 Node 和生产依赖，使用者无需安装 Node、npm 或 PowerShell 7。

## 使用

1. 将整个 ZIP 解压到可写目录，例如 `D:\Apps\CodexWeb`，不要直接在压缩包内运行。
2. 安装 Codex，并使用自己的账户登录；项目需要 Git 时另行安装 Git。
3. 双击 `Start.cmd`，首次填写工作目录、Codex `.exe` 路径、本地端口，并设置 12–256 位 Web 管理员密码（输入不显示）。
4. 浏览器自动打开登录页。保持启动窗口打开，按 `Ctrl+C` 停止服务。`Start.cmd --no-browser` 可关闭自动打开浏览器。

默认仅监听本机 `127.0.0.1`。远程访问需自行配置私网 HTTPS 代理，并将 `.local/web/config.json` 的 `origin` 改为代理地址；HTTP 下浏览器推送不可用。端口被占用时会提示退出，不会停止其他程序。修改端口时同步修改 `origin`。

配置保存在 `.local/web/config.json`。更换电脑后，请检查其中工作目录和 Codex 路径。便携包不包含 Codex、任何账户或登录信息。

## 数据与升级

`.local/web` 包含密码验证数据、数据库、上传内容和推送密钥。升级前停止服务并备份该目录，再迁移到新版本目录。分享给别人时发送原始发布 ZIP，**不要重新压缩已经使用过的目录**。

## 构建

在 Windows x64 开发机运行：

```powershell
npm.cmd ci
npm.cmd run package:portable
```

脚本校验固定 Node 二进制的 SHA-256，构建前端，安装生产依赖，保留第三方许可证，并在 `releases/` 生成便携 ZIP、不含 Git 历史的源码 ZIP 和 SHA256SUMS 文件。已下载对应版本的 Node 时，可使用：

```powershell
npm.cmd run package:portable -- --node-binary C:\path\to\node.exe
```

提供的二进制仍必须通过固定校验。构建需要访问 Node 官方下载站、其官方 GitHub 源码和 npm registry；已缓存的内容可复用。

源码导出仅包含 Git 已跟踪文件的当前内容，新文件须先 `git add`。导出排除 `.git`、本地运行数据、环境文件、构建缓存和常见密钥文件。便携程序按运行文件白名单复制，不打包开发目录。

首次公开发布建议从源码 ZIP 解压后新建仓库；原仓库历史仍有个人标识，详见 [隐私检查](privacy-review.md)。文件过滤不能代替内容审查，新增文件后仍需复查。

## 验证发布包

解压到全新测试目录后可运行产物检查（会在该测试目录创建配置和测试数据）：

```powershell
$env:PORTABLE_TEST_DIR = 'C:\temp\fresh-release'
node --test tests/portable-package.test.ts
```

检查会校验清单、清空子进程的 Node 搜索路径、检查端口冲突，并用隔离的测试密码启动和登录；不会调用模型。普通 `npm test` 会跳过这项需要真实产物的检查。
