# Tailscale 安装接入与国际化设计验收

日期：2026-10-14。本轮交付国际化设计、Tailscale 安装接入和双语 README；不实施界面语言切换，不发布新包，不改变正在运行的服务或系统网络。

## 实现与参考

- [国际化架构方案](../../codex-drive/specs/2026-10-14-internationalization.arch.md)仅为设计：初期 `zh-CN/en`，类型安全字典、React Context 和 Intl，覆盖语言偏好、错误展示、原文边界、分阶段迁移与验收。
- 参考 t3code 的公开快照 `4d73e1d5cdd32dbfb470e9422421cc40475d5e99`，主要是 [Tailscale CLI 适配](https://github.com/pingdotgg/t3code/blob/4d73e1d5cdd32dbfb470e9422421cc40475d5e99/packages/tailscale/src/tailscale.ts)：读取 `status --json`，取实际设备域名，运行 `serve --bg --https=443 http://127.0.0.1:端口`。本项目采用同一路径，不引入其 Effect 运行库或项目方云连接。
- `scripts/tailscale.ts` 供便携启动、源码 npm 命令和 Windows/Linux 旧 configure-serve 入口共用。缺失客户端、登录状态与 Serve 配置分别检查；只有明确选择安装或 `up` 才执行对应操作。非交互模式不安装、不登录；其他映射与 Funnel 不覆盖、不 reset。
- 映射复读验证成功才原子替换 Web 配置，保留原字段、额外地址和 localhost；已建映射而落盘失败保留恢复说明。运行中受管实例在加载/修复 Codex 配置前拒绝便携配置命令。首次接入默认不启用，失败仍可本地启动；显式重跑只配置、完成退出。
- Windows 辅助安装使用 [winget 的 Tailscale 包](https://github.com/microsoft/winget-pkgs/tree/master/manifests/t/Tailscale/Tailscale)，Linux 使用[官方安装说明](https://tailscale.com/docs/install/linux)的脚本；安装权限由用户按第三方安装器要求处理，安装不等于登录。
- README 删除旧开场，突出自托管、浏览器入口与聚焦 Codex 的部署范围，明确模型请求仍到所选提供商且 t3code 也可私网自托管。新增光猫桥接、路由器 PPPoE、公网/CGNAT、IPv6、UDP 转发和直连检查，区别 Tailscale UDP 与 Web TCP 业务端口。

## 检查与历史结果

- 新 helper 的 Windows mock 检查 19/19 通过；首次集成定向检查 41/41 通过，包含 CMD、PowerShell 7/5.1、配置 Unicode 和启动偏好保留。类型检查、Node 语法检查通过。
- Linux 初轮检查 21 项中 19 通过、2 失败。一个 mock 脚本在工作区的 ESM 作用域使用 `require`；另一个在 Linux 宿主模拟 Windows 时硬编码反斜杠且缺少 ProgramFiles。修正测试夹具后 21/21 通过；不改产品的安装或重试期限。
- 独立审查发现并修复 3 项：运行实例拒绝顺序、Linux 省略端口的交互参数、架构目录导致旧便携更新器拒绝增量包。回归均先确认旧实现失败，再验证修复；Windows 修复定向检查 3/3 通过，最终 WSL 检查 23/23 通过。复审无新增阻断项。
- 架构源文档保留在 `codex-drive/specs/`；便携副本放入已有的 `docs/design/`，包内文档索引同步改写。更新器目录白名单与本轮前一致，避免要求旧更新器先升级才能解压新文件。复制与链接回归验证实际输出路径。
- 全量 Node 回归首次在沙箱内停在既有 `git-fetch.test.ts` 超时进程清理用例，未形成完整汇总，由本任务终止；沙箱外对该文件单独复核 2/2 通过。首次日志保留，不作为全量通过证据。
- 最终全量 `npm test`：772 项中 767 通过、5 跳过、0 失败、0 取消（101.97 秒）；最终 WSL 定向检查 23/23 通过。类型、脚本语法和 diff 检查通过，源码文档中代码示例以外的 125 个本地链接存在。未重建前端、便携产物或重新发布既有 0.1.8 包。

WSL 复用现有 0.1.6 Linux 包的 Node 24.20.0，解压到本任务 `.local`，SHA256 与打包脚本固定值一致；没有安装系统 Node。所有 Tailscale 外部命令均由 mock/fake CLI 替代，未执行真实 winget/curl 安装、登录、Serve、光猫/路由器配置或手机连接。检查能证明命令、状态与文件保护逻辑，不能证明某个家庭宽带一定直连。

本地日志：`.local/tailscale-setup-*.log`、`.local/tailscale-focused.log`、`.local/tailscale-review-fixes-green.log`、`.local/tailscale-linux.log`、`.local/tailscale-linux-recheck.log`、`.local/tailscale-linux-complete.log`、`.local/tailscale-node-full.log`、`.local/tailscale-git-fetch-recheck.log`、`.local/tailscale-node-complete.log`。这些隔离测试证据不纳入发布包，首次失败记录未删除。
