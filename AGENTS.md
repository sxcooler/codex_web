# 协作规则

- 只有用户明确肯定的指示或确认，才可以开始实施。
- 询问语气一般视为讨论，例如“可不可以”“能不能”“是否应该”；先分析、说明方案，不能自行视为实施授权。
- 讨论阶段可以进行必要的只读检查；修改代码、配置、依赖、运行状态，以及提交、推送、发布等实施操作，应在用户明确授权的范围内进行。
- 用户已明确确认的范围可持续执行，不必反复请求同一授权；新增范围需另行确认。

## 开发规范

- 使用中文 commit message。
- 每次完成一个需求后，将本次所有 commit squash 成一个 commit，总结改动并生成 commit message，并保留原 commit message；git 分支合并等操作不需要 squash。

## 代码发现

- 优先使用 codebase-memory-mcp 的 `search_graph`、`trace_path`、`get_code_snippet`、`query_graph`、`search_code`；项目未索引时先运行 `index_repository`。
- 图工具结果不足，或查找字符串、配置、非代码文件时，再使用 `rg` 等文件搜索工具。

## 子 Agent 协作

- 子 agent 使用 `gpt-5.6-sol`、high。
