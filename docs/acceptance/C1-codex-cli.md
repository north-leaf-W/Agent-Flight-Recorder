# C1 真实 Codex CLI 验收记录

- 状态：已通过
- 日期：2026-09-05
- Runtime：`codex-cli 0.151.0-alpha.7.2`
- Adapter：`@afr/adapter-codex 0.1.0-demo.0`
- 运行档位：Instrumented

## 首轮成功场景

执行命令：

```bash
corepack pnpm start
corepack pnpm demo:codex
```

结果：

| 项目 | 结果 |
|---|---|
| AFR Run ID | `01a06fd4-75e9-720b-a066-a3306d604e5f` |
| Provider Thread ID | `01a06fd4-765a-7c71-a855-c730bc640ece` |
| 进程退出码 | `0` |
| Provider 事件 | `17` |
| 实际文件变化 | `1` |
| 采集缺口 | `0` |
| 超时 | 否 |
| 最终测试 | `node --test dependency.test.mjs` 通过 |

实际 JSONL 包含 Session、Turn、模型消息和 4 次命令执行，现有 Normalizer 未遇到未知事件。Codex 将 `dependency.json` 从失败夹具恢复为兼容值；AFR 将 Provider 文件声明与观察到的 `dependency.json` diff 成功关联。控制台正确显示 Instrumented 能力卡、Runtime 版本和事件时间线，浏览器控制台无错误。

试跑同时发现并修复了一个摘要问题：成功 Run 中，前置诊断命令可能失败，不能因此把整个 Run 标为“验证失败”。现在验证摘要以 Run 终态和最后一次命令结果为准，并有回归测试覆盖“先失败、后成功”的序列。

## 第二轮成功场景

再次执行 `corepack pnpm demo:codex`，验证相同固定夹具可以重复通过：

| 项目 | 结果 |
|---|---|
| AFR Run ID | `01a07011-a31f-71a2-8f2b-2ed2b8e79a5a` |
| Provider Thread ID | `01a07011-a380-7433-a5d4-010f595f00e5` |
| 进程退出码 | `0` |
| 最终命令退出码 | `0` |
| Provider 事件 | `24` |
| 持久化事件 | `32` |
| 实际文件变化 | `1`，`dependency.json` |
| Provider/文件关联 | `matched` |
| 采集缺口 | `0` |
| UI | 已完成 / 验证通过 |

该轮包含多次诊断命令，其中中间命令可以失败，但最终验证命令通过，Run 正确判为成功。

## 真实失败场景

```bash
corepack pnpm demo:codex:failure
```

Codex 在 `read-only` 沙箱中只运行一次预期失败的测试，不修改文件：

| 项目 | 结果 |
|---|---|
| AFR Run ID | `01a07012-4d06-7498-bfcb-6fbcb5497af6` |
| Provider Thread ID | `01a07012-4d64-76e2-a542-6369b053b467` |
| Codex 进程退出码 | `0` |
| 最终命令退出码 | `1` |
| AFR Run 状态 | `failed` |
| Provider 事件 | `7` |
| 实际文件变化 | `0` |
| 采集缺口 | `0` |
| UI | 失败 / 验证失败 |

此场景验证 Provider `turn.completed` 不会覆盖真实命令失败。AFR 使用 Provider 终态与最终命令结果联合判定 Run。

## 超时中断场景

```bash
corepack pnpm demo:codex:timeout
```

该入口把真实 Codex Run 的超时设为 500 ms：

| 项目 | 结果 |
|---|---|
| AFR Run ID | `01a07012-a174-7528-bc55-cf7eef446ab3` |
| Provider Thread ID | `01a07012-a1d1-7c31-a804-d08257343f73` |
| Run 状态 | `failed` |
| `timedOut` | `true` |
| Provider 事件 | `2` |
| 实际文件变化 | `0` |
| Gap | `provider_terminal_event_missing` |
| Warning | `codex_timeout` |
| UI | 失败 / 验证失败 / 采集范围有限 |

已收到的 Session/Turn 事件保持可读；因为没有收到 Provider 终态，系统明确创建 gap，没有错误显示完整覆盖。

## 导出、遮盖与 UI

三个 Run 均成功导出 JSON，并满足：

- 事件哈希链有效；
- AFR 本机会话 Token 未出现在导出中；
- 默认 `storeModelContent=false`，所有 `model.response` 仅保留哈希和长度，没有正文；
- 成功、失败和超时页面均显示 Adapter/Runtime 能力卡；
- 浏览器控制台无 error/warning。

## 项目级回归

在完成真实场景后执行：

```bash
corepack pnpm acceptance
```

构建、96 项测试和全部 workspace 类型检查通过。50,000 事件性能基线也通过：写入 P95 `0.16ms`、吞吐 `42,100.05 events/s`、Run 列表 P95 `23.47ms`、10,000 事件时间线 P95 `10.09ms`、冷启动 `174.79ms`、常驻内存 `265.3MB`，均低于项目门槛。验收后已运行 `corepack pnpm demo:c:reset`，Demo C 嵌套 Git 仓库工作区干净。

## 验收结论

C1 发布门槛已满足：两轮真实成功任务、真实命令失败、真实超时中断、固定 Fixture、未知事件诊断、导出遮盖和 UI 能力边界均已验证。C1 标记为完成；Hosted 审批、隔离工作区、网络控制和恢复仍属于 C2，不包含在本结论内。
