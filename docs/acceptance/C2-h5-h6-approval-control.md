# C2/H5-H6 Codex 审批与失败关闭控制验收记录

- 状态：首个控制切片已通过
- 日期：2026-09-05
- Runtime：`codex-cli 0.151.0-alpha.7.2`
- Adapter：`@afr/adapter-codex 0.1.0-demo.0`
- 当前运行档位：Hosted Observed
- 最高覆盖：L2；H9 正式 Hosted UI 与 H10 安全/恢复验收完成前不得标记 Hosted Governed

## 1. 已实现范围

新增 `AppServerApprovalBridge`，直接接入 `CodexAppServerSupervisor.onServerRequest`。处理顺序固定为：

```text
App Server JSON-RPC request
→ 校验锁定版本的请求形状
→ 构造并规范化 ActionContext
→ Policy allow / ask / deny
→ 持久化 Provider request 与 Approval 关联
→ allow: 消费自动 grant
→ ask: 等待浏览器/本地人类审批并消费一次性 grant
→ deny: 返回 Provider decline 或 JSON-RPC error
→ 仅在 grant 已消费后返回 accept/approved
```

支持矩阵：

| App Server 请求 | 当前处理 |
|---|---|
| `item/commandExecution/requestApproval` | 绑定完整 command、cwd、Thread/Turn/Item；保守只读可 allow，其余 ask；额外网络权限 deny |
| `execCommandApproval` | 兼容旧版 argv 请求与 `{ decision: "approved" }` 响应 |
| `applyPatchApproval` | 绑定完整 `fileChanges`、路径集合与内容摘要；普通隔离写可 allow，删除进入 ask |
| `item/fileChange/requestApproval` | 当前 Schema 不含具体补丁，只含 `itemId`；无法精确绑定，因此 decline |
| `item/permissions/requestApproval` | H8 前禁止扩大文件系统或网络权限；返回失败关闭错误 |
| `mcpServer/elicitation/request` | 它是用户输入征集而非工具副作用审批；返回 decline |
| `item/tool/call` | Managed MCP Gateway 尚未实现；精确记录工具与参数摘要后拒绝 |
| 未知请求 | 持久化最小审计记录并返回 JSON-RPC `-32601` |

不采用 `acceptForSession`、execpolicy amendment 或 network policy amendment。每次 Provider `accept` 只对应一个已经消费的短期 grant。

## 2. 持久化与权限边界

Migration `0007_provider_action_requests.sql` 新增 `provider_action_requests`：

```text
Provider Session / JSON-RPC ID / method / Thread / Turn / Item
request hash / optional redacted Blob
canonical ActionContext / action digest / Approval / consumed grant
status / response hash / decision reason / timestamps
```

请求身份字段不可修改，状态只允许从 `evaluating` 或 `waiting_approval` 进入终态，记录不可删除。Host 重启时未完成请求转为 `rejected`；不会在恢复后重放旧授权。Provider 请求/响应原文 Blob 默认关闭，显式 `storeRaw: true` 时仍先遮盖。

本地查询 API：

```text
GET /api/v1/provider-sessions/:sessionId/action-requests
GET /api/v1/provider-action-requests/:requestId?waitMs=30000
```

Provider Session control token 仍只能改变自己的 Session 状态，不能调用人类审批决定接口。测试已验证该 token 对 `/api/v1/approvals/:id/decision` 返回 401。

## 3. 自动化安全验收

覆盖以下路径：

- allow：只读命令和普通隔离 patch 在 grant 消费后返回 accept；
- ask：命令等待审批，批准后消费绑定 grant，拒绝则返回 decline；
- deny：权限升级、网络放权、不完整文件请求、MCP elicitation、未托管动态工具和未知方法失败关闭；
- 参数绑定：ActionContext 的 argv、cwd、targets、内容摘要和环境进入 action digest；换参被既有 grant 校验拒绝；
- grant：过期、伪造和重复消费均失败；Provider 审批过期不会迟到放行；
- 协议：新版响应为 `accept/decline`，旧版响应为 `approved/denied`，自定义 JSON-RPC 拒绝码由 Supervisor 原样返回；
- 恢复：未完成 Provider request 在重启恢复时进入 `rejected`；
- 原文：默认只有遮盖后的哈希，未启用 raw Blob。

## 4. 真实 Codex 审批 Turn

复现：

```bash
corepack pnpm codex:hosted-approval-smoke
```

验收过程使用只读 sandbox 与 `untrusted` approval policy。Codex 请求执行唯一的 fixture 命令，验收脚本模拟本地人工核对精确命令后批准；AFR 创建 Approval、签发短期 grant、消费 grant，再向 App Server 返回 `accept`。

| 项目 | 结果 |
|---|---|
| AFR Run | `01a070ca-5891-76c8-991c-f96846d951be` |
| Provider Session | `01a070ca-5893-76cb-b31d-ab8c59b27777` |
| Provider Thread | `01a070ca-58aa-70d0-b27f-5b8bb23ad78f` |
| Provider Turn | `01a070ca-58ec-7871-82a7-b38d6367fc29` |
| Provider 请求 | `item/commandExecution/requestApproval`，RPC ID `0` |
| Approval | `01a070ca-66bb-73be-8267-46e5ac3c0924` |
| action digest | `05868c8b2d30589d559536c45318f440d633baabbe2bfee9150ae0d2654b85c2` |
| grant | `01a070ca-66cd-7286-95af-951f23cbbf2b`，状态 `consumed` |
| Turn / Session / Run | 全部 `completed` |
| 事件哈希链 | 有效 |

真实 Runtime 返回的命令为完整 shell 字符串，桥接器将其整体绑定为 `shell -lc` 参数，不自行重新解释或改写；这保证审批摘要与回复对应同一个 Provider 请求。

## 5. 尚未关闭的门槛

本次证明了真实 Codex 的审批回调可以被 AFR 拦截、等待、绑定并失败关闭，但仍不是“完全监控”或 Hosted Governed：

- 命令最终仍由 Codex sandbox 执行，AFR 需要在 H8 证明不存在绕过审批的工具网络/进程路径，并继续以实际事件和系统观察器对账；
- 新版 file-change 请求缺少具体 patch，当前选择拒绝；H7 使用独立 Patch Promotion Gateway 将隔离 diff 审批后应用回源目录；
- Managed MCP Gateway 尚未提供允许路径；本阶段当时拒绝所有动态工具，H8-C 后续仅开放固定的实验性 `afr_network_read`；
- 正式 Web/API 尚未把 Hosted Run 的创建、Supervisor 生命周期和审批等待组合成一个用户入口；
- 本阶段当时尚未强制分离网络控制通道与工具数据通道；H8-C 已完成该边界的当前 Runtime 验收。

后续状态（2026-09-06）：H7 Patch Promotion，以及 H8-A～H8-C 的工具网络默认拒绝、只读 Gateway、未托管 MCP 关闭、Provider egress 与模型动态工具桥均已通过。下一阶段为 H9 Hosted UI；H10 恶意仓库/绕过/恢复测试完成前，覆盖仍保持 L2。

## 6. 全量回归

`pnpm acceptance` 已通过：117 项自动化测试全部通过，所有 workspace 构建与 TypeScript 类型检查通过，50,000 事件性能基线通过。本轮结果为 42,415.81 events/s、单次写入 P95 0.15 ms、时间线读取 P95 10.03 ms、冷启动 175.25 ms。
