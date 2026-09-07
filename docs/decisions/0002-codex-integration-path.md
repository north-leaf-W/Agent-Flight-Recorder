# ADR 0002：Codex 真实接入路径

- 状态：已接受
- 日期：2026-09-05

## 背景

AFR 展示版已经用固定 Fixture Agent 验证存储、审批、Checkpoint 和 Replay，但“Codex 为首发 Agent”尚未完成真实适配验收。现有 `afr exec` 可以包裹任意命令，却只能观察顶层进程和项目文件前后变化。

可选路径包括：

1. 直接包裹 `codex exec`；
2. 解析 `codex exec --json`；
3. 直接构建 Codex SDK / App Server 客户端；
4. 先实现 DeepSeek harness；
5. 仅通过 MCP 接入。

## 决策

1. C0 使用现有 `afr exec` 包裹 `codex exec`，尽快完成真实模型烟雾测试。
2. C1 以 `codex exec --json` 为首个正式 Adapter 输入，流式转换为 AFR 领域事件。
3. C2 在 C1 契约稳定后迁移到 Codex SDK / App Server，以支持线程、审批、历史和流式交互。
4. CLI Adapter 在 C2 后继续保留，作为简单部署路径、回退路径和契约测试对照组。
5. DeepSeek 放在 C3，作为第二供应商验证，不作为 Codex 首发验收替身。
6. MCP 只用于显式工具能力，不能承担完整采集或全局审批职责。
7. C2 采用 AFR Hosted Codex：AFR 拥有 Provider Session 和 Codex 子进程生命周期。
8. Hosted Run 默认在 detached Git worktree 中执行；源工作区写入只能通过 Patch Promotion Gateway。
9. Hosted Governed 对工具网络默认拒绝；无法区分 Provider 控制通道与工具数据通道时必须降级。
10. Provider 事件只作为意图证据，必须与 Gateway 和系统实际结果对账。

## 理由

- 现有 CLI 包裹能力可以最低成本验证真实用户价值；
- JSONL 提供结构化、可流式处理的公开自动化表面；
- 先稳定 AFR 事件契约，可以减少 SDK/App Server 接入时同时修改产品语义和传输层的风险；
- 第二供应商应验证抽象，而不是反向决定首发 Adapter 的数据模型；
- 单一 MCP 无法观察 Codex 直接使用的终端、文件系统或其他工具。
- 隔离工作区加最终 Patch Promotion，可以在不依赖私有文件 Hook 的情况下保护用户源目录；
- “意图、控制、结果”三类证据比单独信任 Provider 自报更符合飞行记录仪定位。

## 后果

正面：

- 可以分阶段交付，每阶段都有可运行验收；
- Codex 专属解析被限制在 Adapter 内；
- DeepSeek 等 Provider 可以复用规范化契约；
- 对未知事件和版本变化有清晰的降级路径。

代价：

- C1 仍需维护 Codex CLI JSONL 兼容性；
- CLI 包裹阶段无法完成真正的审批桥接；
- CLI 和 App Server 两条运行面需要共享契约测试；
- Codex Replay 需要单独设计，不能沿用当前仅支持 Node 脚本的 Worker。
- Hosted 模式需要额外的进程监督、worktree 生命周期、网络边界和 Promotion UI；
- 如果 App Server 能力或操作系统隔离不足，只能交付 Hosted Observed，不能宣称 Governed。

## 安全边界

- 默认 `workspace-write`，不默认使用无沙箱模式；
- Adapter 无权生成 AFR Core 的策略、审批和授权事件；
- 未识别或未观察的行为必须创建 `collection.gap_detected`；
- 任何阶段都不能把“真实 Codex 已运行”表述为“所有 Codex 行为已被 AFR 控制”。

## 关联文档

- [AFR Codex 真实接入实施计划](../codex-integration-plan.md)
- [AFR Hosted Codex 架构与控制计划](../codex-hosted-architecture.md)
- [ADR 0001：个人展示版技术基线](0001-mvp-baseline.md)
- [OpenAI Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [OpenAI Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
