# 脚本入口

部署脚本按平台分目录，均可从任意工作目录调用；服务数据固定为本项目的 `.local/web`。

| 功能 | Windows（可双击 CMD） | Linux（Bash） |
| --- | --- | --- |
| 后台启动（Windows）/ 前台启动（Linux） | `windows/start-server.cmd` | `linux/start-server.sh` |
| 停止 | `windows/stop-server.cmd` | `linux/stop-server.sh` |
| 登录后自启 | `windows/install-startup.cmd -Start` | `linux/install-startup.sh --start` |
| 私网 HTTPS（方案见部署指南） | `windows/configure-serve.cmd` | `linux/configure-serve.sh [PORT]` |

CMD 只负责选择已有 PowerShell 7 或系统内置 5.1、转交参数及显示执行结果，业务逻辑仍在同名 PS1；不要求额外安装 PowerShell。启动 CMD 默认传入 `-Background`，隐藏服务进程，关闭启动窗口不停止服务；日志位于 `.local/web/server.log`。需要前台运行可直接调用 `start-server.ps1`（不加 `-Background`）。自启双击仅安装，下次登录启动；命令行加 `-Start` 可同时立即启动。入口和计划任务的执行策略只作用于当前进程，不修改系统全局策略。

Windows 使用用户计划任务；Linux 使用用户级 systemd，也支持前台运行。前置配置、日志、停用自启及升级步骤见 [部署指南](../docs/guides/deployment.md)。旧版 Windows 用户升级后重新运行 `windows/install-startup.ps1`，迁移已有任务路径。

根目录的 TypeScript 文件保留为 npm 命令入口，包括密码设置、协议生成、探测和打包工具；不改变现有 npm 命令。`npm run package:portable` 在 Windows x64 / Linux x64 glibc 上分别生成对应平台的便携包，共用 `scripts/portable.ts` 配置流程。详见 [便携包指南](../docs/guides/portable.md)。

`node scripts/generate-icons.ts` 从 `public/icon.svg` 生成手机桌面 PNG。调整 `scale` 控制主体大小（当前 0.8，对应约 60% 图形宽度、20% 左右边距）；原 SVG 用于网页标签。修改后递增 `revision` 并同步 `index.html`、`public/manifest.webmanifest` 的版本路径，避免静态缓存继续使用旧图标；然后运行 `node --test tests/icons.test.ts` 和 `npm run build`。已安装的桌面快捷方式可能需要重新添加。
