# M3 隔离回放、对比与导出验收

- 日期：2026-09-03
- 结果：通过
- 模式：Isolated Live

## 隔离与真实性

- 从 Checkpoint 基准 commit 创建 detached Git worktree。
- 在 worktree 中应用 tracked diff，并从 Blob Store 恢复 untracked 文件。
- 执行前逐项校验恢复后的路径、类型、权限、大小和内容哈希。
- 新 Run 保存 `parentRunId` 与 `forkedFromEventId`，Replay 保存 source/target/checkpoint/worktree 关系。
- worker 使用 argv 启动，不经过 shell；展示版只接受仓库内 Node 脚本。
- 默认 macOS executor 使用 `sandbox-exec`：只允许 worktree 内文件写入并拒绝网络。
- `curl`、发布、Git、包管理器、shell 和删除类命令在执行前返回 `side_effect_blocked`，且失败 Replay 可审计。
- 子进程真实退出码决定 Run 状态；测试失败不会显示为成功。
- worker 执行后再次计算源工作区指纹；不一致时 Replay 失败。

## 对比与导出

新旧 Run 对比包含最终状态、首个失败、耗时、工具调用、审批数、修改文件集合、命令与退出码、模型/提示词版本、模拟/真实动作数。

Run JSON 包含 Run、原始 Event、Step、Insights、审批、Checkpoint、Replay 关系、哈希链验证和导出哈希。导出前递归执行秘密扫描；HTTP 与 CLI 导出均可直接由标准 JSON 解析器打开。

## 自动化证据

- `packages/core/src/replay.test.ts`：worktree 恢复、原目录不变、父子关联、成功/失败真实性、副作用拒绝。
- `packages/core/src/run-artifacts.test.ts`：状态/命令/文件/失败对比、JSON 结构、哈希链、最终秘密扫描。
- `apps/server/src/server.test.ts`：Checkpoint、Replay、comparison、export HTTP 纵向闭环。
- 本地浏览器验收：Replay Lab、Checkpoint 选择、目标 Run、分叉事件、worktree 路径和新旧对比均可见；浏览器控制台无错误。
