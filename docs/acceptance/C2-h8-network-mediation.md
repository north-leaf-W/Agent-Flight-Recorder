# C2/H8 Codex Network Mediation 验收记录

- 状态：H8-A 默认拒绝、H8-B 只读 Gateway/MCP 失败关闭、H8-C Provider egress/动态工具桥均已通过
- 日期：2026-09-06
- Runtime：`codex-cli 0.151.0-alpha.7.2`
- Adapter：`@afr/adapter-codex 0.1.0-demo.0`
- 当前运行档位：Hosted Observed
- 最高覆盖：L2；本记录不支持 Hosted Governed 或“完整网络监控”声明

## 1. 已实现的边界

H8-A 采用 `deny-all-tools` 配置：Codex App Server 保留调用模型所需的 Provider 控制通道，本地工具进程没有网络访问。Host 固定执行以下控制：

1. `thread/start` 和 `thread/resume` 只接受 `read-only`、`workspace-write`，拒绝 `danger-full-access`；
2. 每个 `turn/start` 都重新发送结构化 `SandboxPolicy`，明确设置 `networkAccess: false`；
3. 独立 `command/exec` 只接受 argv 数组，始终设置 `networkAccess: false`；
4. `thread/start` / `resume` 固定覆盖 `web_search: "disabled"`，调用方不能打开原生无逐次审批的 Web Search；
5. App Server 启动层与 Thread 配置均固定 `shell_environment_policy.inherit="core"`，避免把任意宿主环境变量交给工具进程；`workspace-write` 同时排除 `/tmp` 和 `TMPDIR` 额外写入，并拒绝 worktree 外 writable root；
6. Supervisor 原始 JSON-RPC 请求与通知不再是公开 API，只允许 `initialize`、Thread/Turn 生命周期和受控 `command/exec`；本机 Schema 明确标注为 unsandboxed/full-access 的 `thread/shellCommand` 无法发出；
7. 带 `networkApprovalContext`、`proposedNetworkPolicyAmendments` 或额外网络权限的 Provider 请求在 AFR 审批处理器之前以 `-32020` 失败关闭，审批处理器不能误放行；
8. Runtime 返回的 Thread sandbox 类型、网络状态、临时目录开关和 writable roots 会复核；返回更宽策略时终止该操作。

H8-A 不提供“临时批准网络”或 session 级放权，不返回 `acceptForSession`、execpolicy amendment 或 network policy amendment。

## 2. 审计证据

Migration `0009_network_mediation.sql` 新增 append-only `network_mediation_records`，保存：

```text
Provider Session / Run / 到达序号
来源（host/provider/runtime/observer）
操作 / 决定
请求策略 / 实际策略 / 系统观察证据
时间
```

记录写入前执行现有敏感信息遮盖，数据库触发器禁止更新和删除。查询入口：

```text
GET /api/v1/provider-sessions/:sessionId/network-mediation
```

Provider Session control token 不能伪造这些记录；它仍只允许更新自身 Session 状态。

## 3. 自动化安全验收

自动化覆盖：

- 默认 Thread sandbox 为 `read-only`；
- `workspace-write` 只生成显式 worktree writable root，禁用 `/tmp` 与 `TMPDIR` 额外写入；
- Turn 与 `command/exec` 的 `networkAccess` 固定为 `false`；
- `danger-full-access` 在发送 RPC 前拒绝；
- `thread/shellCommand` 即使通过运行时类型绕过调用也被 RPC allowlist 拒绝；
- Provider 网络权限/策略修订在审批 handler 之前拒绝；
- Runtime 报告启用网络或错误 sandbox 类型时失败关闭；
- Runtime 报告 worktree 外 writable root 或重新开放 `/tmp` 时失败关闭；
- 网络审计记录有连续序号、持久化遮盖和 HTTP 查询覆盖。

本地 Schema 与 Runtime 曾暴露一处兼容差异：`tools.web_search: null` 通过生成 schema 的表面形状，但真实 `thread/start` 返回 `-32600`。实现未绕过该错误，而是删除此不可靠字段，仅保留 Runtime 已接受的 `web_search: "disabled"`。

## 4. 真实 Codex 网络验收

复现：

```bash
corepack pnpm codex:hosted-network-smoke
```

测试先在 `127.0.0.1` 启动临时 HTTP listener，再通过真实 App Server `command/exec` 运行 Node HTTP 请求。命令带 `{ type: "readOnly", networkAccess: false }`，随后在同一 App Server 启动真实只读模型 Turn。

| 项目 | 结果 |
|---|---|
| AFR Run | `01a0713e-c338-76cb-aeda-9d348b3e3b6d` |
| Provider Session | `01a0713e-c33a-702d-aa46-5e87f1e858ea` |
| Provider Thread | `01a0713e-c3d7-79f1-9553-7eafb963e805` |
| Provider Turn | `01a0713e-c41b-7200-bc1b-96f1127cd5f5` |
| 禁网命令退出码 | `23`（连接失败分支） |
| listener TCP 连接数 | `0` |
| listener HTTP 请求数 | `0` |
| Runtime Thread sandbox | `readOnly` / `networkAccess=false` |
| Provider 控制 Turn | `completed` |
| Run / Session | `completed` / `completed` |
| 事件哈希链 | 有效 |

新增 Turn 沙箱、环境继承和 writable-root 校验也通过 `workspace-write` 真实回归：Run `01a07145-7ed1-7033-a52b-7c7f3f5cc620` 在隔离 worktree 修复测试，worktree 测试退出 `0`，源工作区保持不变且测试退出 `1`，Provider 事件 `188`、gap `0`、覆盖 `100% / L2`。

## 5. H8-B 只读 Network Gateway

新增 `ReadOnlyNetworkGateway`，并通过以下固定边界开放显式只读网络入口：

- 只接受 `GET` / `HEAD`，外部写方法在解析阶段失败关闭；
- `ApprovalService` 仅对 `network.read`、无副作用、单一网络目标、命中显式 allowlist 且端口允许的动作签发一次性 grant，Gateway 在建立连接前消费该 grant；
- allowlist 支持精确 hostname 和显式 `*.example.com` 子域规则；通配规则不包含根域；
- 默认仅允许 80/443 端口，拒绝 URL credentials、Cookie、Authorization、Proxy-Authorization 及所有非安全请求头；
- 每一跳均重新执行域名、端口与 DNS 检查；DNS 结果只要混入 loopback、RFC1918、link-local、multicast、unspecified、metadata、文档或保留地址，就拒绝整次请求；
- 传输层直接连接已验证 IP，并保留原 hostname 的 HTTP Host 与 TLS SNI；实际 remote address 与已选择 IP 不一致时拒绝；
- 默认总时限 10 秒、最多 3 次跳转、正文上限 1 MiB；拒绝压缩响应，避免把压缩炸弹交给调用方；
- 正文只返回给当前调用方，默认不写入 SQLite 或 Blob。证据链只保存 origin、path hash、query 参数名、完整请求 hash、响应 hash、字节数、状态码和安全响应头摘要。

服务器入口：

```text
POST /api/v1/provider-sessions/:sessionId/network-read
Authorization: Bearer <local-session-token-or-matching-provider-control-token>

{
  "method": "GET",
  "url": "https://allowlisted.example/path",
  "headers": { "accept": "application/json" }
}
```

响应正文使用 `bodyBase64` 返回；服务启动时通过 `AFR_NETWORK_READ_ALLOWLIST=host.example,*.docs.example` 配置 allowlist。空配置表示全部拒绝。

Gateway 请求、每跳解析/连接和最终结果继续复用 migration `0009_network_mediation.sql`，以同一个 `gatewayRequestId` 关联。自动化覆盖方法、凭证头、端口、精确/通配域名、IPv4/IPv6 私网、本机、metadata、混合 DNS、跳转重验证、remote-address 不匹配、流式大小上限、超时、正文不落库和服务器鉴权。

真实传输复现：

```bash
corepack pnpm network-gateway-smoke
```

2026-09-06 的真实 `https://example.com/` 验收结果：Run `01a074d5-715b-7387-800e-43853fd633b0`，Provider Session `01a074d5-715d-738e-9d2f-4a34d7ccd08f`，HTTP `200`，正文 `559` bytes，SHA-256 `ff67a9d764d6a2367a187734e697f6a53217db9a21c101d410a113ca871a299d`，跳转 `0`，审计序列为 request/hop/result `1/2/3`，事件哈希链有效，正文未持久化。

## 6. MCP 外部通道失败关闭

本机 Runtime 探测证明 `-c 'mcp_servers={}'` 采用合并语义，不能清空用户配置；以该参数启动 Thread 时，伪造 MCP 进程仍会被执行。因此实现没有把空表覆盖误报为隔离。

Supervisor 现在执行三层控制：

1. App Server 启动参数关闭 plugins、remote plugin、Apps、browser/computer use、image generation 和 MCP dependency install 等外部工具面；
2. `initialize` 后通过本机 schema 已声明的 `config/read` 读取当前项目的有效配置，只提取 MCP 名称，不记录命令、环境或秘密；每个 `thread/start` / `thread/resume` 都注入逐服务器 `{ enabled: false }`；
3. Thread 创建后调用 `mcpServerStatus/list`，只有所有 Runtime 状态均为 `disabled` 且未遗漏配置项才允许继续；出现 `starting`、`connected`、未知形状或遗漏时终止 Host。

真实验证：

```bash
corepack pnpm codex:hosted-turn-smoke
```

Run `01a074cd-2cd2-719f-afc3-75b0d6ab0114`、Provider Session `01a074cd-2cd3-77c1-a1ec-d99d80de9aa3`、Thread `01a074cd-2ce9-77c0-9f95-366bef788965`、Turn `01a074cd-2d23-7720-a821-690e9e30ad58` 完成。`config/read` 发现 3 个已配置 MCP，Thread 覆盖后 `mcpServerStatus/list` 回读 3 个均为 `disabled`；通知流未出现 MCP startup，工具 sandbox 仍为 `networkAccess=false`，Run/Session 均完成且事件链有效。

## 7. H8-C Provider egress 与动态工具桥

### 7.1 Provider 控制通道

macOS Host 现在用两层边界限制 Codex/App Server 父进程：

1. `sandbox-exec` 拒绝父进程全部网络，只允许连接 Host 随机创建的单个 loopback 代理端口；
2. 代理只接受带每 Host 随机凭证的 CONNECT，并对 hostname allowlist、端口、完整 DNS 地址集和实际 remote address 逐项校验。

默认只允许 443，DNS 结果中混入任何非公网地址都会拒绝。企业网络可显式启用 `198.18.0.0/15` 合成 DNS，或 pin 一个精确 RFC1918 地址；后者不能写成网段，也不能放开 loopback、link-local 或 metadata 地址。代理环境变量只注入 App Server 父进程，同时通过 `shell_environment_policy.exclude` 排除出工具环境，并在 `config/read` 回读中验证。

独立验证命令：

```bash
corepack pnpm provider-egress-smoke
```

该 smoke 证明 allowlisted CONNECT 成功、非 allowlist 目标失败、`--noproxy` 直连绕过失败，并产生允许/拒绝审计。

### 7.2 模型到只读 Gateway

本机 `generate-json-schema --experimental` 暴露了 `initialize.capabilities.experimentalApi`、`thread/start.dynamicTools` 和 `item/tool/call`。Supervisor 只在注册固定工具时启用实验能力，并将 `afr_network_read` 绑定到既有 `ReadOnlyNetworkGateway`：

- Runtime 请求必须是严格的 `item/tool/call` 结构，工具名必须已注册且不得携带 namespace；
- 工具参数继续经过 Gateway 的 GET/HEAD、allowlist、DNS/IP、header、grant、大小、跳转与超时检查；
- 未知工具、namespace、非法结构、非法参数和缺少 handler 均失败关闭；未知/非法请求额外写入 `decision: denied`，只保存 call/tool 等结构摘要，不保存 arguments 正文；
- 正文只回给当前模型调用，SQLite/Blob 只记录响应 hash、字节数、状态和 hop 证据。

动态工具仍是当前 Runtime 的实验性 schema，不作为稳定官方契约。2026-09-06 复核时官方 App Server 页面在当前网络返回 403，因此这里的兼容结论来自锁定版本的本机 schema 和真实 Runtime，而不是推断未公开字段。

### 7.3 环境配置与真实验收

Provider 目标取决于账户、区域和企业网络，仓库不提供 hostname/IP 默认值：

| 环境变量 | 含义 | 默认 |
|---|---|---|
| `AFR_PROVIDER_EGRESS_ALLOWLIST` | 逗号分隔、经审核的 Provider hostname 规则 | 空；egress smoke 拒绝启动 |
| `AFR_PROVIDER_EGRESS_TRUSTED_PRIVATE_ADDRESSES` | 可选、逗号分隔的精确 RFC1918 Provider IP pin | 空 |
| `AFR_PROVIDER_EGRESS_ALLOW_SYNTHETIC_DNS` | 是否接受 `198.18.0.0/15` 企业合成 DNS | `false` |

真实复现：

```bash
export AFR_PROVIDER_EGRESS_ALLOWLIST="your-reviewed-provider-host.example"
# 仅按当前环境二选一配置下面的例外；公网 DNS 不需要：
# export AFR_PROVIDER_EGRESS_TRUSTED_PRIVATE_ADDRESSES="10.0.0.42"
# export AFR_PROVIDER_EGRESS_ALLOW_SYNTHETIC_DNS=true

corepack pnpm codex:hosted-egress-smoke
corepack pnpm codex:hosted-network-tool-smoke
```

2026-09-06 的真实 Provider egress Run 为 `01a07599-a1e4-748e-bf6f-61e11705bf23`：使用当前机器实际 Provider hostname 和一个精确企业 RFC1918 pin，Turn、Session、Run 与事件链均完成。hostname/IP 属于环境证据，不写入默认配置。

真实动态工具 Run 为 `01a075a3-f6ff-726c-856e-aaeda3c37ee9`：模型调用 `afr_network_read` 恰好 1 次，形成 15 条连续网络证据；`https://example.com/` 返回 HTTP `200`、`559` bytes，Provider egress、`item/tool/call`、一次性 grant、Gateway hop/result 全部关联，响应正文未持久化。

### 7.4 H8 结论与剩余边界

H8 在当前锁定 Runtime 与 macOS 上验收通过。能力快照可写为：`toolNetworkDeny=supported`、`unsafeClientMethodsBlocked=supported`、`readOnlyNetworkGateway=supported`、`unmanagedMcpDisabled=supported`、`providerEgressAllowlist=supported`、`dynamicNetworkToolBridge=experimental-supported`。

这仍不是“完全监控”：动态工具是实验性兼容面，Managed MCP 允许路径尚未实现，H9 正式 Hosted UI 尚未把启动与证据查询组成产品入口，H10 也尚未完成恶意仓库、进程派生、恢复和版本漂移验收。因此当前 Run 继续使用 Hosted Observed / L2，`networkMediation` 保持 `degraded`，不宣称 Hosted Governed。

## 8. 全量回归

`corepack pnpm acceptance` 已通过：166 项 workspace 测试与 4 项 fixture 测试全部通过，所有 workspace 构建与 TypeScript 类型检查通过，50,000 事件性能基线通过。本轮结果为 42,628.79 events/s、单次写入 P95 0.12 ms、Run 列表 P95 23.70 ms、时间线读取 P95 9.96 ms、冷启动 175.42 ms、常驻内存 273.02 MB。`@afr/adapter-codex` 单独为 39 项测试通过，其中包括未知、namespaced 和 malformed 动态工具请求的 `denied` 审计回归。
