# C2/H9 Hosted UI 验收记录

- 状态：H9-A/H9-B 已通过；下一阶段为 H10 Recovery & Security
- 日期：2026-09-06
- 当前运行档位：Hosted Observed
- 最高覆盖：L2；本记录不支持 Hosted Governed 或“完全监控”声明

## 1. H9-A 已实现范围

新增只读聚合接口：

```text
GET /api/v1/runs/:runId/hosted-summary
```

接口把同一 Run 的 Provider Session、能力快照、Coverage、事件哈希链、Hosted Workspace、Provider Action Requests、Patch Promotions 和最近 50 条 Network Mediation 证据组合为一个页面模型。非 Hosted Run 返回 `hosted=false`，不会因缺少 Session 产生页面错误。

Run 详情新增 Hosted Control 卡片，展示：

- Hosted Observed/Governed 档位和真实 L0～L3 覆盖等级；
- Provider、Adapter、Runtime、协议、Thread 和 Session；
- Provider 事件覆盖、gap/unknown/invalid、事件哈希链；
- 隔离 worktree 状态和 changed paths 数量；
- Provider 控制请求及 waiting 数量；
- Patch Promotion 最新状态和选择文件数量；
- 网络证据总数、最近决策、来源以及 allow/deny 状态；
- 每项能力的 `supported` / `degraded` / `unsupported` 和来源提示；
- 经既有遮盖流程生成的 Run JSON 导出入口。

页面只有同时满足 `mode=hosted-governed`、Coverage `L3` 和显式 `hostedGovernance=supported` 才显示 Hosted Governed；否则始终显示“当前不是完全监控”。

## 2. H9-B Hosted Control 已实现范围

新增正式 Hosted 生命周期接口：

```text
GET  /api/v1/hosted/preflight
POST /api/v1/hosted-runs
POST /api/v1/hosted-runs/:runId/turns
POST /api/v1/hosted-runs/:runId/cancel
POST /api/v1/hosted-runs/:runId/finish
GET  /api/v1/runs/:runId/hosted-diff
GET  /api/v1/runs/:runId/promotion-review
```

正式 Host 编排固定按以下顺序执行：

1. 验证 macOS、Codex runtime、显式 Provider egress allowlist、项目 allowlist 和 Git worktree 根目录；
2. 创建 Run、Checkpoint 和 detached worktree；
3. 创建 Hosted Observed Provider Session，接入事件、审批、网络审计和可选 `afr_network_read`；
4. 启动 App Server，再启动或恢复 Thread，最后创建 Turn；
5. Turn 完成后保持 Host/Thread 为 `idle`，允许后续输入；
6. 用户显式完成或取消后停止 Host、固化 worktree diff 并写入终态；
7. finalized workspace 才能进入逐文件 Promotion 审核。

Web 启动表单包含 Git 项目根目录、任务、`read-only`/`workspace-write`、1～30 分钟 Host 超时和模型正文保留开关。Hosted Control 卡新增：

- `starting` / `running` / `idle` / `stopping` / 终态生命周期；
- 活动 Turn 取消、同 Thread 后续输入和显式“完成并生成 diff”；
- Provider Thread → Turn → Item 元数据和 Action Request 详情；
- finalized diff、逐文件选择、源/worktree 漂移结论；
- Promotion 不可变 plan hash、选中文件数、审批与执行结果。

AFR 正常关闭时活动 Session/Run 标记为 `interrupted`，worktree 保留；重启后“继续”会创建新的 Provider Session，并对旧 external Thread ID 调用 `thread/resume`。恢复默认 `read-only`，除非用户重新显式选择 `workspace-write`。

## 3. 权限与数据边界

- `hosted-summary` 是本机只读接口，不返回 Provider control token、代理凭证、审批 Cookie或模型正文；
- 网络区域只返回既有遮盖后的 Network Mediation 记录，最多下发最近 50 条，正文仍不持久化；
- 审批决定继续使用独立 Human Approval Session；Hosted 卡片不新增越权写入口；
- 导出继续走原有 `/api/v1/runs/:runId/export`，执行二次秘密扫描；
- 所有 Hosted 写接口继续要求本机 Session Token、同源写请求和已建立的 HttpOnly Session Cookie；
- Web 启动只接受配置在 `AFR_HOSTED_PROJECT_ROOTS` 内、且路径本身就是 Git worktree root 的项目；symlink 会先解析真实路径；
- Web 启动在 Provider egress allowlist 为空时失败关闭，不加入环境特定 hostname/IP 默认值；
- `read-only` 与 `workspace-write` 之外的 sandbox、目录外 cwd 和缺失 runtime 都不能启动；
- 网页不会收到 Provider control token、代理凭证、审批 Cookie、完整环境变量或未选择保留的模型正文；
- `promotion-review` 只返回指纹和漂移布尔值；diff 来自已遮盖 Blob；Promotion 仍必须经过独立 Human Approval Session；
- `h9:browser-fixture` 只替换 Provider 进程，用于确定性页面验收；正式入口仍使用同一 API、数据库、worktree、事件桥和 Promotion Gateway。

## 4. 自动化与浏览器验收

新增 4 个 Hosted Web 生命周期集成测试，覆盖：

- 未授权启动拒绝；授权后完成预检、创建 Run/Session/worktree/Thread/Turn；
- 同一活动 Host 上后续 input；
- `turn/interrupt` 后 Host 取消、Run/Session 终态和 diff 固化；
- AFR 重启后 interrupted Session → 新 Session → 原 Thread resume；
- Provider Turn 失败时 Run/Session 失败关闭；
- finalized diff、逐文件 Promotion plan、源目录漂移检测。

服务器测试当前为 18 项通过；Adapter 39 项测试通过，包括 Supervisor 请求关联、取消、超时、Runtime sandbox 回读、MCP 关闭、动态工具和失败关闭。Web TypeScript 与 Vite production build 通过。

浏览器验收使用临时数据目录创建 Hosted Observed Fixture，并在本机 AFR 页面核对：

| 项目 | 结果 |
|---|---|
| 顶部覆盖摘要 | `Hosted L1`，不再误显示“等待采集声明” |
| Provider 事件 | `1/1 normalized`，Coverage `100.0%` |
| 事件哈希链 | 有效 |
| 能力矩阵 | 4 supported、1 degraded |
| 网络证据 | 3 条，依次展示 sandbox、Provider egress、dynamic tool |
| 完整性文案 | 明确显示“当前不是完全监控” |
| 非 Hosted 功能 | 原 Run 列表、Timeline、Evidence、Replay Lab 均保持可用 |

临时预览数据库和本机服务已在验收后清理。

H9-B 浏览器验收使用 `h9:browser-fixture` 和正式 production Web build 完成以下真实页面操作：

| 项目 | 结果 |
|---|---|
| 启动预检 | Git root/runtime/sandbox 通过后按钮才可用 |
| Hosted 启动 | 创建隔离 Run，页面显示 `idle`、Thread/Session 和 100% Provider event metadata |
| 继续 Thread | 后续输入生成第二组 Turn started/completed，Thread ID 保持不变 |
| 显式完成 | Run completed、workspace finalized、Coverage 升至 L2 |
| Diff 审核 | 展示 `dependency.json` 文本 diff、逐文件 checkbox 和“未检测到漂移” |
| Promotion | 生成 1 entry 不可变 plan，页面出现独立审批卡 |
| 取消 | 活动 Turn 显示取消按钮；操作后 Run、Session 均为 cancelled |
| 完整性文案 | 始终显示 Hosted Observed 与“当前不是完全监控” |

夹具退出路径已独立复验：发送 `SIGINT` 后进程以退出码 0 结束，HTTP 端口关闭，临时数据目录删除，没有留下活动 fixture 服务或验收数据。

真实 Codex App Server 的 Thread/Turn、命令审批、隔离、Promotion 和 Provider egress 已由 H2～H8 的独立真实 smoke 验证。H9 浏览器使用确定性 Provider 是为了可重复覆盖交互状态；在当前环境没有可移植、经审核的 Provider hostname 默认值，因此未伪造 allowlist 来运行真实 Provider 浏览器路径。正式 Web 预检会在该配置缺失时失败关闭。

OpenAI 官方 App Server 页面在本次环境通过命令行和内置浏览器访问均返回 HTTP 403，因此 H9 没有把无法取得的页面内容当成稳定契约；`thread/start`、`thread/resume`、`turn/start` 与 `turn/interrupt` 继续以锁定 Runtime 的本地 experimental schema 和真实 H2～H8 运行证据为兼容面，版本漂移归 H10 Gate。

## 5. H10 剩余门槛

H9 已完成，但仍不能升级为 Hosted Governed。H10 必须补齐：

1. 崩溃、kill -9、断流、磁盘满、Blob/SQLite 写失败和孤儿 worktree 回收；
2. 恶意 Git hook、symlink race、超大 diff、二进制、权限变化和目录逃逸；
3. Runtime schema/version 漂移与不兼容降级；
4. CPU、内存、进程数、输出和磁盘配额；
5. Managed MCP 允许路径与外部副作用红线复验。

H10 通过前继续使用 Hosted Observed / L2。

## 6. 全量回归

`corepack pnpm acceptance` 已通过：170 项 workspace 测试与 4 项 fixture 测试全部通过，所有 workspace build 与 TypeScript 类型检查通过。50,000 事件性能结果为 42,298.55 events/s、单次写入 P95 0.12 ms、Run 列表 P95 22.29 ms、时间线读取 P95 9.89 ms、冷启动 175.10 ms、常驻内存 273.28 MB。
