# C2/H3-H4 Hosted Codex 隔离与事件桥验收记录

- 状态：H3、H4 已通过
- 日期：2026-09-05
- Runtime：`codex-cli 0.151.0-alpha.7.2`
- Adapter：`@afr/adapter-codex 0.1.0-demo.0`
- 当前运行档位：Hosted Observed
- 最高覆盖：L2；不得据此标记 Hosted Governed

## 1. H3 Worktree Isolation

新增 `HostedWorkspaceManager` 和 migration `0006_hosted_workspaces_provider_events.sql`。生命周期固定为：

```text
Checkpoint → 源工作区指纹 → detached worktree → 恢复并校验 Checkpoint
→ ready → active → 捕获实际变化/diff → 复核源指纹 → finalized → 显式 cleanup
```

关键约束：

- App Server 的进程 cwd 与 `thread/start.cwd` 都指向 disposable worktree；
- dirty tracked 文件和 untracked 文件先进入 Checkpoint，再恢复到 worktree；
- 结束时相对 Checkpoint manifest 计算变化路径，避免把运行前已有 dirty 状态误算为 Codex 副作用；
- diff Blob、变化路径、源目录前后指纹和失败原因先持久化，之后才允许清理 worktree；
- 源目录发生漂移时 Workspace 进入 `failed`，并写入 `collection.gap_detected`；
- `cleaned` 仅能从 `finalized` 或 `failed` 显式进入，数据库审计记录不可删除。

## 2. H4 Provider Event Bridge

新增 App Server 专用 normalizer 与 event bridge。它不复用 CLI JSONL 的字段假设，而是处理 App Server JSON-RPC 通知：

| App Server 通知 | AFR 事件/处理 |
|---|---|
| `thread/started` | `agent.session_started` |
| `turn/started` | `agent.turn_started` |
| `turn/completed` | 按 `turn.status` 写入 `agent.turn_completed` 或 `agent.turn_failed` |
| `item/started` / `item/completed` | 命令、工具、文件声明、模型请求/响应和推理摘要 |
| 已知 delta/状态遥测 | 原始通知保留，标记 `ignored`，不伪造领域事件 |
| 未知通知/Item | `collection.gap_detected`，覆盖等级降级 |
| 缺少必需 ID/状态 | 标记 `invalid` 并生成 gap |

每条通知在 `provider_events` 中保存：到达序号、Provider 方法和关联 ID、遮盖后原文 SHA-256、可选 Blob、规范化 AFR Event ID、解析状态、gap 原因和接收时间。原文 Blob 默认关闭，只有显式 `storeRaw: true` 才保存，避免默认落盘模型正文；即使开启也先执行遮盖。`run_coverage` 保存 mapped/ignored/gap/invalid 数量、方法分布、gap 分布、覆盖百分比和等级。

查询 API：

```text
GET /api/v1/provider-sessions/:sessionId/events
GET /api/v1/runs/:runId/coverage
GET /api/v1/runs/:runId/hosted-workspace
```

Provider 原文和 AFR 事件在落盘前继续使用既有遮盖规则；测试已验证 Provider token 不进入 Blob。

## 3. 真实隔离 Hosted Turn

复现：

```bash
corepack pnpm codex:hosted-isolation-smoke
```

验收 Run：

| 项目 | 结果 |
|---|---|
| AFR Run | `01a070a4-f852-70aa-bc72-aa57e4dde7e8` |
| Checkpoint | `01a070a4-f892-7197-8ca1-5d5d63f61e03` |
| Hosted Workspace | `01a070a4-f898-712e-9a2b-ac72a50129ea` |
| Provider Session | `01a070a4-f8c9-75b0-95cf-c2cf33a99df6` |
| Provider Thread | `01a070a4-f8e0-7470-818a-fa675438318c` |
| Provider Turn | `01a070a4-f920-71d0-9b69-66a83b4c8969` |
| 隔离副本 | 测试退出码 0；仅 `dependency.json` 变化 |
| 源目录 | `dependency.json` 前后 SHA-256 相同；测试前后退出码均为 1 |
| diff 证据 | Blob `8dc04d3f358d43d3b6a4b151cd60f0c5157bf92714a981fc4a1c5a7c876520d2` |
| 清理 | 证据落库后从 `finalized` 进入 `cleaned` |
| Provider 通知 | 180 条，arrival sequence 连续 |
| AFR 事件链接 | 23 条通知链接规范化事件 |
| gaps | 0 个 unknown，0 个 invalid |
| 覆盖 | 100%，L2 |
| 哈希链 | 有效 |
| 终态 | Turn、Provider Session、AFR Run 均完成 |

其余 157 条是已识别的增量文本、Token Usage、diff 更新、限流状态、MCP 启动状态和远控状态遥测；它们作为 Provider 证据保留并标记 `ignored`，不会被错误表达为独立副作用。本次覆盖结论还包含 `workspaceEvidence=verified`；没有完成实际 worktree 复核的 Run 即使 Provider 流无 gap，也不会达到 L2。

## 4. 自动化覆盖

- H3：Checkpoint 恢复、dirty/untracked 基线、隔离修改、源目录不变、diff Blob 和显式清理；
- H4 Core：顺序、原文遮盖、Blob、AFR Event 链接、unknown/invalid gap 和覆盖计算；
- H4 Adapter：生命周期、命令、工具、文件、模型消息、失败 Turn、已知遥测和未知事件；
- HTTP：Provider 事件、Run coverage 与 Hosted workspace 查询；
- 兼容性：既有 Replay 继续使用相同的 worktree 原语并通过回归测试。

完整 `pnpm acceptance` 已通过：110 项测试、全部 TypeScript 类型检查与构建，以及 50,000 事件性能基线。最终基线写入速率为 41,605.69 events/s，时间线读取 P95 为 9.73 ms。

## 5. 当前边界与下一门槛

本阶段证明的是：AFR 可以托管真实 Codex，在隔离 worktree 中执行写任务，并把公开 App Server 通知与实际文件结果保存成 L2 证据。

它尚未证明：

- 命令和 MCP 在执行前全部经过 AFR Gateway；
- App Server 审批参数与 AFR ActionContext/grant 完整绑定；
- 已批准 patch 可安全 Promotion 回源目录；
- Provider 控制网络与工具数据网络已被强制隔离；
- 崩溃恢复和恶意仓库场景已达到发布门槛。

后续状态（2026-09-06）：H5/H6 首个控制切片、H7 Patch Promotion，以及 H8-A～H8-C 的工具网络默认拒绝、只读 Gateway、未托管 MCP 关闭、Provider egress 与模型动态工具桥均已通过。H9/H10 完成前继续保持 Hosted Observed / L2。
