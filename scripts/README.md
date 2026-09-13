# 脚本入口

部署脚本按平台分目录，均可从任意工作目录调用；服务数据固定为本项目的 `.local/web`。

| 功能 | Windows（PowerShell 7） | Linux（Bash） |
| --- | --- | --- |
| 启动 | `windows/start-server.ps1` | `linux/start-server.sh` |
| 停止 | `windows/stop-server.ps1` | `linux/stop-server.sh` |
| 登录后自启 | `windows/install-startup.ps1 -Start` | `linux/install-startup.sh --start` |
| 私网 HTTPS（方案见部署指南） | `windows/configure-serve.ps1` | `linux/configure-serve.sh [PORT]` |

Windows 使用用户计划任务；Linux 使用用户级 systemd，也支持前台运行。前置配置、日志、停用自启及升级步骤见 [部署指南](../docs/guides/deployment.md)。旧版 Windows 用户升级后重新运行 `windows/install-startup.ps1`，迁移已有任务路径。

根目录的 TypeScript 文件保留为 npm 命令入口，包括密码设置、协议生成、探测和打包工具；不改变现有 npm 命令。`npm run package:portable` 在 Windows x64 / Linux x64 glibc 上分别生成对应平台的便携包，共用 `scripts/portable.ts` 配置流程。详见 [便携包指南](../docs/guides/portable.md)。
