# C2/H10 Recovery & Security 验收记录

- 状态：H10-A 已通过；H10 仍在进行
- 日期：2026-09-06
- 当前运行档位：Hosted Observed
- 最高覆盖：L2；本记录不支持 Hosted Governed 或“完全监控”声明

## 1. H10-A 已实现范围

### Git 与恶意仓库边界

- AFR 所有 Checkpoint、detached worktree、diff、apply 和 cleanup 内部 Git 命令都强制使用 `core.hooksPath=/dev/null`；
- 同时禁用 Git `file` 和 `ext` protocol，防止内部 Git 操作意外触发本地输送或外部 helper；
- 恶意 `post-checkout` hook 验收证明：创建 Hosted worktree 时 hook 不执行，外部 marker 不会被写入。

### Worktree 产物配额

Hosted finalize 和 Promotion 重新对账共享以下默认限制：

| 项目 | 默认上限 |
|---|---:|
| worktree 可见文件数 | 900 |
| 单文件 | 10 MiB |
| 可见文件总量 | 100 MiB |
| 最终 diff | 32 MiB |

超限时不会产生可 Promotion 的 finalized workspace；Workspace 转为 `failed`，记录 `workspace_limit_exceeded`，源工作区保持不变。文件类型会在读取前检查，非普通文件和非 symlink 条目失败关闭。

### Provider 输出配额

App Server Supervisor 现在同时限制：

| 项目 | 默认上限 |
|---|---:|
| 单条 JSONL | 1 MiB |
| stdout 累计量 | 64 MiB |
| JSON-RPC 消息数 | 100,000 |
| stderr 存储 | 16 KiB 头尾截断 |

任一上限被突破时 Supervisor 终止 Provider，拒绝继续处理未受控消息，Run 通过既有 Host 失败路径收束。

### 崩溃后恢复

- SQLite quick check、事件哈希链、临时 Blob 和活动 Provider Session 恢复保持不变；
- 启动时额外扫描停在 `preparing` / `ready` 的不完整 Hosted workspace；
- 这类 workspace 被标记 `host_restarted_during_setup`，追加 `collection.gap_detected`，Run 失败关闭，再尝试安全移除 detached worktree；
- `active` workspace 不会被自动删除，继续保留给 H9 的 `thread/resume` 路径；
- 启动报告会显示发现数、成功清理数和待人工回收数。

## 2. 自动化证据

H10-A 新增回归覆盖：

- 恶意 `post-checkout` hook 不执行；
- 超大 worktree 文件失败关闭，源目录不变；
- 未完成 worktree 在重启后标记、记录 gap 并清理；
- Provider JSON-RPC 消息洪泛超额后 Host 终止。

`corepack pnpm acceptance` 全量通过：174 项 workspace 测试和 4 项 fixture 测试全部通过；50,000 事件性能为 42,277.21 events/s，单次写入 P95 0.12 ms，冷启动 178.08 ms，常驻内存 272.81 MB。

## 3. H10 剩余门槛

H10-A 尚未关闭整个 H10。后续必须继续验收：

1. SQLite/Blob 写失败、磁盘满和强制 `kill -9` 故障注入；
2. symlink race、超大文件数、二进制、权限位和目录逃逸的组合恶意仓库矩阵；
3. Runtime 版本/schema 锁定、漂移拒绝和可观测降级；
4. CPU、内存、子进程数和 worktree 总磁盘配额；
5. Managed MCP 允许路径与外部副作用红线复验。

上述项目关闭前，仍使用 Hosted Observed / L2。
