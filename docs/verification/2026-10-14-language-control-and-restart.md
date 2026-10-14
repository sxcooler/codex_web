# 语言控件与任务空闲重启验收

2026-10-14，基线 `d8fa1a0`。先保存[设计](../design/2026-10-14-language-control-and-restart.md)及 AGENTS.md 浏览器验证要求，再补回归、实施和审查。独立工作树为 `.worktrees/ui-restart-20261014`，共享 node_modules Junction 的缓存和临时输出均隔离到该工作树 `.local`。

## 结果

| 检查 | 实际结果 |
| --- | --- |
| 旧语言样式 RED | 1 项失败、3 项未执行：标签与控件仅 1px，达不到焦点轮廓需要的间距 |
| 旧重启规则 RED | 首轮 8 项中 4 通过、4 失败；后台列表／历史、显式原生重启和未知活动检查被读取计数提前拒绝 |
| 审查补充写入 RED | 额度重置、任务创建与默认模型验证阶段的 3 项回归均失败，确认提交保护遗漏 |
| 最终重启专项 | 11/11 通过；含后台读取、完整写入提交、额度重置、核对期间出现新任务、待审批／输入、未知原生状态及严格更新保护 |
| 最终完整 Node | 802 项：797 通过、5 跳过、0 失败、0 取消；并发 2，152.76 秒 |
| 最终浏览器 | Chrome/Playwright 37/37 通过；语言样式与交互、登录偏好、设置保存与导航、重启对话框 |
| 语言控件几何及键盘 | 390/1440px × 中英 × CSS zoom 1/2；最长 system 选项、Shift+Tab、End/Home、焦点间距、箭头空间、普通字重及无新增请求；查看截图 |
| 生产前端入口 | 实际 HTTPS 加载生产资源，API/SSE 使用隔离模拟；1440 中文／390 英文，Tab 可达、切换可用、无溢出或运行错误；正常活动续期先完成，语言切换未增加 POST |
| 类型与构建 | 最终 TypeScript 通过，独立生产构建通过；保留既有大于 500kB 分块警告 |
| 静态更新 | 409 个文件逐一 SHA256 一致，入口最后替换，新旧 JS/CSS 及图标均 HTTP 200，首页匹配构建 |
| 独立审查 | 2 项 Important 与键盘验证缺口已修正，复核无未解决问题；审查者独立重跑 11/11 通过 |

新版入口为 `index-CvUPgEWG.js` / `index-BLjRK44r.css`，旧资源保留。修改后的样式已用于当前前端；后端仍为原受管进程，新任务空闲判定必须成功重启才能加载。本次没有再次安排重启。

## 失败与环境边界

冻结 Vite watcher 的初次修复复核仍读到旧 CSS，4 项失败；重新启动隔离测试服务器后几何断言通过。随后 37 项中 33 通过、4 项在控制台健康检查失败，明确为测试 HTML 未声明图标导致 `/favicon.ico` 404；添加已有 public 图标，未忽略控制台错误，最终 37/37 通过。

首轮全量 Node 为 798 项：790 通过、3 失败、5 跳过。Git 超时测试在沙箱进程清理时停滞，仅终止核实过 PID、父进程、创建时间与本工作树路径的该测试进程；该文件未完成正常子测试汇总，不据此声称两个 Git 用例完成。另两项 Windows 宿主/重启 fixture 因沙箱下 CIM 身份读取失败。未修改这些测试或产品期限，最终在固定源码上以沙箱外隔离 fixture 完整复核。

生产 UI 辅助检查最初把正常用户活动触发的 `/api/auth/renew` 误计为语言切换 POST；核对既有续期事件代码后，先产生一次键盘活动并等待模拟续期，再比较语言切换期间 POST。等待活动事件的临时脚本已限定清理，最终两视口无新增 POST。

Browser plugin not available，采用已有 Chrome/Playwright 流程及新浏览器 context，不复用真实登录资料。浏览器窄屏不等于手机实机；本轮未发送真实 Codex 任务、执行真实审批／额度重置、改 Tailscale 网络配置、重启实际后端或发布便携包。

本地证据在该工作树 `.local/`：`runtime-red.log`、`write-review-red.log`、`runtime-final.log`、`node-full.log`、`node-final.log`、`language-red.log`、`language-green.log`、`browser-green.log`、`browser-final.log`、`language-final/`、`production-ui-verification.json`、`production-settings-*.png`、`static-verification.json`、`typecheck-final.log`、`build.log`。首次失败证据保留，不随发布包分发。
