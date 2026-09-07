# C2/H0 App Server 能力探测记录

- 状态：进行中
- 日期：2026-09-05
- 本机 Runtime：`codex-cli 0.151.0-alpha.7.2`
- 运行环境：macOS arm64
- 探测方式：本机稳定 JSON Schema + 探测器/Supervisor 两次 App Server `initialize` 握手
- 模型调用：无

## 1. 已执行验证

```bash
corepack pnpm codex:capabilities
corepack pnpm codex:host-smoke
```

探测器使用 `AFR_CODEX_BIN` 或 `PATH` 中的 `codex`，执行以下只读/临时操作：

1. 读取 `codex --version` 与 `codex exec --help`；
2. 将稳定 App Server JSON Schema 生成到系统临时目录；
3. 启动 `codex app-server --stdio`；
4. 发送 `initialize`，收到响应后发送 `initialized`；
5. 终止 App Server 并删除临时 Schema；
6. 使用 H2 Host Supervisor 再执行一次真实进程握手、PID 分配和受控退出。

探测器不调用 `turn/start`，不会发起模型请求。输出为机器可读 JSON，能力缺失时退出码非零。

## 2. 当前结果

| 能力 | 本机协议证据 | 当前结论 |
|---|---|---|
| CLI JSONL | `codex exec --json`、`--ephemeral`、`--sandbox` | 可用于 C1 |
| App Server 握手 | 探测器与 H2 Supervisor 的 `initialize` / `initialized` 均实测成功 | 已验证 |
| Thread 生命周期 | `thread/start`、`thread/resume` | `thread/start` 实测成功；恢复待测 |
| Turn 生命周期 | `turn/start`、`turn/interrupt` | `turn/start` / `turn/completed` 实测成功；真实中断待测 |
| 流式事件 | `thread/started`、`turn/started`、`item/started`、`item/completed`、`turn/completed` | 首个只读真实 Turn 连续收到；持久化与完整性对账归入 H4 |
| 命令审批 | `item/commandExecution/requestApproval` | 请求面存在，参数绑定与失败关闭待测 |
| 文件审批 | `item/fileChange/requestApproval` | 请求面存在，内部编辑覆盖范围待测 |
| 权限审批 | `item/permissions/requestApproval` | 请求面存在，授权范围待测 |
| MCP 交互 | `mcpServer/elicitation/request` | 请求面存在，外部副作用控制待测 |
| Diff | `turn/diff/updated` | 事件存在，仍须与系统文件观察对账 |
| 工作区隔离 | Schema 不能证明 | 未验证 |
| 工具网络隔离 | Schema 不能证明 | 未验证 |
| Patch Promotion | H7 已实现并通过真实 Codex smoke | 已通过；仍受 H8/H9 发布门槛约束 |

## 3. Gate A 阶段结论

协议表面和本地握手已满足 Host 原型的最低进入条件，可以开始 H1/H2 的 Provider Session 与 Host Supervisor 设计。但 H0 还不能标记完成，因为 Schema 只能证明接口存在，不能证明运行时语义和安全边界。

以下测试完成前，产品仍为 Instrumented C1，不得标记 Hosted Governed：

- 对真实 Turn 的事件序列完成持久化、序号检查和断流测试；
- 在审批请求中核对 argv、cwd、目标、Thread、Turn、Item 是否足够绑定 AFR `ActionContext`；
- 验证拒绝、过期、取消和 App Server 异常退出均失败关闭；
- 验证 `thread/resume` 不重复执行未确认副作用；
- 证明 Codex 只能写 disposable worktree，源工作区在 Promotion 前保持不变；
- 区分 Provider 控制通道与工具数据通道，并验证工具无法绕过网络策略。

## 4. 可复现性

Runtime 升级后必须重新执行探测。报告不能只记录“支持”，还必须保存 Runtime 版本和实际缺失项；任何必需方法消失时，Hosted 模式应拒绝启动或回退到 Instrumented 模式。
