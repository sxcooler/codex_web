# 分支会话继承模型与推理强度实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建分支时继承父会话已保存的模型和推理强度，避免已明确的设置被全局默认覆盖。

**Architecture:** 在现有 `Runtime.fork` 中复用只读取得的父会话信息，通过原生 `thread/fork` 的 `model` 与 `config.model_reasoning_effort` 传递设置。保留现有历史截点、编号命名、权限核验、幂等与部分成功处理，不增加前端参数或依赖。

**Tech Stack:** TypeScript、原生 Codex App Server、Node test 与现有 JSON-RPC fixture。

**Spec:** 本文件的“原问题与证据”和“已确认范围”。用户已确认“同意，落文档并实施吧”，保存后连续实施。

## 原问题与证据

用户原问：`11111111-1111-4111-8111-111111111111` 分支出去的 `11111111-1111-4111-8111-111111111111` 为什么模型和推理强度不一样？

- 父会话的 5 条 `turn_context` 均为 `gpt-6-astra / max`。
- 子会话 `session_meta.forked_from_id` 指向父会话；从 2026-10-26 08:30:09（北京时间）第一轮开始，3 条执行上下文均为 `gpt-6.1-sol / ultra`。
- 两个会话的原生状态库记录与执行记录一致。当前全局配置恰为 `gpt-6.1-sol / ultra`；创建时的原生日志已不在，不能声称取得了历史 fork 返回包或完整证明当时的配置回落过程。
- 修复前的 `Runtime.fork` 仅向原生发送 `threadId / lastTurnId / excludeTurns`，直接采用原生返回的设置，漏掉了父会话设置的显式继承。
- [官方 ThreadForkParams（0.164.0）](https://raw.githubusercontent.com/openai/codex/rust-v0.164.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadForkParams.ts) 支持 `model`、`config`，不支持顶层 `effort`；[Thread](https://raw.githubusercontent.com/openai/codex/rust-v0.164.0/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts) 的模型/强度字段表示已加载会话的当前配置，或未加载会话最后保存的配置。

## 已确认范围与全局约束

- 只影响修复后新创建的分支，不修改上述两个会话或任何现有会话、标题、全局配置。
- 从父会话原生只读信息取得设置，不使用前端未发送的草稿、本地过期 state、模型目录默认值或全局配置猜测。
- `lastTurnId` 确定历史截点；继承的是创建分支时父会话当前/最后保存的设置，不追溯历史轮次设置。
- 非空字符串模型和强度显式继承。原生字段为 `null`/缺失表示未设置或不可取得，保留原生缺省行为；不能据此保证某个具体强度，也不能发送 `config.model_reasoning_effort: null` 冒充清除配置。
- 显式继承的设置若未被原生确认，沿用已有“结果未知 + 已创建 ID”路径，不能报告成功或自动再建分支。
- 不重新接续父会话，不发真实模型请求、不用用户会话作测试、不重启运行服务。
- 最终单个中文提交，本地合入 master，不推送；临时 worktree 验证后清理。

## Review Focus

1. 未加载的父会话也能继承明确设置，且不 resume 父会话。
2. Web 缓存与原生父信息不同，采用原生当前值；历史截点不改变该规则。
3. `null`/缺失字段不会被填成目录或全局默认，也不会发无效的 null 配置覆盖。
4. 原生忽略显式覆盖时保留部分结果 ID 和幂等结果，不重复创建。
5. 后代分支、编号命名、选中历史前缀及首轮未显式改设置的行为继续成立。

## Task 1：分支设置继承

**Files:** 修改 `src/codex/runtime.ts`、`tests/fork.test.ts`、`tests/fixtures/runtime-server.mjs`；文档为本文件。

**Interfaces:** 保持 Web fork 请求/返回类型；原生 fork 请求增加父会话已有的 `model` 与 `config.model_reasoning_effort`。

- [x] 调整现有 fixture，模拟原生全局默认与父设置不同、遵守显式覆盖，并提供忽略覆盖的失败模式。
- [x] 添加未加载父会话、过期缓存、空设置、返回不匹配的回归；先运行 `node --test tests/fork.test.ts`，观察预期失败。
- [x] 最小修改 `Runtime.fork`：复用 source、只传明确值、核对返回值；不改变其他路径。
- [x] 同一测试变绿；运行 `npm test` 与 `npm run build`，预期零失败、构建成功。
- [x] 独立审查文档和完整差异；记录实测结果，以单个中文提交交付并在集成后清理临时 worktree。

## 验证记录

- 沙箱基线遇到临时文件重命名 `EPERM` 等环境限制，停止该轮；未当作修复结果。
- 宿主环境基线 `npm test`：852 项，847 通过、5 跳过、0 失败。
- RED：`node --test tests/fork.test.ts`，34 项、27 通过、7 个预期失败（缺少覆盖参数、子配置仍为默认、原生忽略设置未被拒绝）。随后补充两项未知模型的兼容检查。
- GREEN：同一分支测试 36 项全部通过。
- 首次修复后全量：860 项，854 通过、5 跳过、1 失败。唯一失败为现有 `installed-plugins.test.ts` 的 `plugin API authenticates before native work and resolves only selected project IDs`；在第 91 行轮询自写 `calls.jsonl` 时读到不完整 JSON（`Unexpected end of JSON input`）。它使用独立 fixture，非本次修改的 fixture；保留失败，不修改无关插件代码或测试。
- 上述插件测试单独复跑：7/7 通过。构建结束后重新执行完整 `npm test`：860 项，855 通过、5 跳过、0 失败（82.50 秒）。
- 5 项既有跳过：4 项 Linux 专属测试，以及需提供发布包的 isolated release smoke；本轮没有这些平台/工件。
- `npm run build` 通过（包含 TypeScript 检查）；保留既有超过 500 kB 的分包警告。`git diff --check` 通过。
- 独立 `gpt-6.1-sol` 审查：Critical / Important / Minor 均无发现。5 项 Review Focus 均已核对。
- 验收边界：没有真实原生 fork / 线上服务验证；本轮不消耗模型请求或重启真实服务，原生接口兼容性仍以官方协议与隔离 fixture 为证，不能升级为线上成功。
- 未修改界面组件，不以 fixture 测试宣称真实用户会话或线上后端已验证/生效。
