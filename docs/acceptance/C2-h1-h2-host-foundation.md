# C2/H1-H2 Hosted Codex Host 基础验收记录

- 状态：H1、H2 已通过
- 日期：2026-09-05
- Runtime：`codex-cli 0.151.0-alpha.7.2`
- Adapter：`@afr/adapter-codex 0.1.0-demo.0`
- 模型调用：无

## 1. H1 Provider Session 与 Token

新增 migration `0005_provider_sessions.sql`，持久化 AFR Run 与 Provider Session 的独立关联、Adapter/Runtime/协议版本、实际能力快照、外部 Thread ID、进程 ID、状态和错误摘要。

每个 Provider Session 创建时签发随机控制 Token；SQLite 只保存 SHA-256 哈希。该 Token 只允许更新自己 Session 的状态，不能创建 Run、写入通用事件或调用其他管理 API。Session 查询不会返回 Token 或 Token 哈希。

启动恢复会查找 `starting`、`running`、`stopping` Session，将孤立 Session 标记为 `interrupted`，并把仍在运行或等待审批的关联 Run 标记为 `interrupted`。控制台启动报告显示回收数量。

本地 API：

```text
POST /api/v1/provider-sessions
POST /api/v1/provider-sessions/:sessionId/status
GET  /api/v1/runs/:runId/session
```

## 2. H2 Agent Host Supervisor

Supervisor 以 argv 启动 `codex app-server --stdio`，不经过 shell，并实现：

- `initialize` / `initialized` 握手；
- JSON-RPC 请求 ID 关联、通知顺序消费和服务端请求响应；
- `thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`；
- 启动超时、请求超时、Host 总超时和 TERM/KILL 回收；
- 完成、失败、取消、意外退出四种确定结果；
- stdout 非 JSON、超大行和协议异常失败关闭；
- stderr 独立、有界采集；
- 没有注册处理器的审批/服务端请求返回 JSON-RPC 错误，不自动批准。

## 3. 真实 App Server 烟雾测试

执行：

```bash
corepack pnpm codex:host-smoke
```

结果：

| 项目 | 结果 |
|---|---|
| Runtime | `Codex Desktop/0.151.0-alpha.7.2` |
| Client | `afr-host; 0.1.0-demo.0` |
| Platform | `unix / macos` |
| 真实子进程 | 已分配 PID |
| initialize | 成功 |
| 退出 | `completed`，`SIGTERM` |
| 超时 | 否 |
| stderr | 空 |
| 模型/Turn 调用 | 无 |

随后执行首个只读真实 Hosted Turn：

```bash
corepack pnpm codex:hosted-turn-smoke
```

| 项目 | 结果 |
|---|---|
| AFR Run ID | `01a0702f-85a9-75b7-896e-52177e047e49` |
| Provider Session ID | `01a0702f-85ab-74f4-9693-51f6e3fab01c` |
| Provider Thread ID | `01a0702f-85c2-7ff3-998f-aad5056d36aa` |
| Provider Turn ID | `01a0702f-8609-7f60-b7c7-3aad8d057547` |
| 沙箱与会话 | `read-only`、`ephemeral`、`approvalPolicy=never` |
| 终态 | `turn/completed`，Turn、Session、AFR Run 均为 `completed` |
| 事件流 | 收到 `thread/started`、`turn/started`、Item 与 Token Usage 等事件，最终 `turn/completed` |
| 哈希链 | 有效 |

该脚本只输出事件类型计数，不输出模型正文。App Server stderr 出现本机插件元数据与 featured plugin cache 的非终止性 warning，但没有影响 Turn 完成；这些 warning 不应被误判为 Run 失败。

受限执行环境无法写入本机 `~/.codex` 状态时，App Server 会失败关闭；真实烟雾测试需在允许访问 Codex 本机状态目录的环境中运行。OpenAI 官方 App Server 页面本次访问返回 403，因此实现没有猜测未取得的文档字段，只使用该锁定 Runtime 生成的本地稳定 JSON Schema 和实际握手结果。

## 4. 自动化验收

- Core：52 项测试通过，包括 Session 持久化、Token 范围、重启回收和原文不落盘；
- Adapter：15 项测试通过，其中 Supervisor 5 项覆盖成功、失败、取消、超时、意外退出、协议错误和未处理服务端请求失败关闭；
- Server：12 项测试通过，包括 Session API 鉴权范围；
- 全量 `corepack pnpm acceptance` 共 103 项测试通过，并通过构建、类型检查和 50,000 事件性能基线。

## 5. 当前边界与下一门槛

本记录完成时只证明了 Host 基础设施、真实 App Server 握手和真实只读 Hosted Turn，因此当时产品状态仍是 Instrumented，不能标记 Hosted Governed。

后续 H3 Worktree Isolation 与 H4 Event Bridge 已通过，见 [C2/H3-H4 隔离与事件桥验收记录](./C2-h3-h4-isolation-event-bridge.md)。当前下一门槛是 H5 Command/MCP Control 与 H6 Approval Bridge，并继续实测真实取消、恢复和审批参数绑定。
