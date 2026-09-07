# C2/H7 Patch Promotion 验收记录

- 状态：已通过
- 日期：2026-09-05
- Runtime：`codex-cli 0.151.0-alpha.7.2`
- Adapter：`@afr/adapter-codex 0.1.0-demo.0`
- 当前运行档位：Hosted Observed
- 最高覆盖：L2；H9 正式 Hosted UI 与 H10 安全/恢复验收完成前不得标记 Hosted Governed

## 1. 已实现范围

新增 `PatchPromotionGateway` 和 migration `0008_patch_promotions.sql`。安全顺序固定为：

```text
finalized Hosted workspace
→ 选择全部或部分 changed paths
→ 复核 finalized change set 与源/worktree 完整指纹
→ 保存每项 source before / worktree after 精确 Blob 与 hash
→ 生成不可变 Promotion Plan 和 plan hash
→ Policy 强制 ask，人工批准绑定 plan hash
→ 再次复核源/worktree 指纹、逐项 type/mode/size/content hash
→ 消费一次性 grant
→ 同目录临时文件 + rename / unlink 精确应用
→ 逐项验证、完整源指纹、文件事件与 evidence 事件入链
```

首版每个 finalized Hosted Workspace 只能建立一个 Promotion，可全量或选择性应用。支持普通文本、二进制、删除与 symlink；不递归删除目录，不跟随 symlink 修改内容，任一父目录为 symlink 时失败关闭。文本 Blob 若因遮盖无法精确保存，则不允许创建 Promotion。批量应用中途失败时按 before Blob 逆序回滚，创建的空父目录一并清理。

## 2. 持久化与 API

`patch_promotions` 保存 Run、Hosted Workspace、Approval、规范化 ActionContext/action digest、不可变 plan hash/Blob、选定路径、源/worktree 请求时指纹、状态、结果源指纹、错误与时间戳。身份字段不可修改，记录不可删除，状态只允许：

```text
waiting_approval → applying → completed
waiting_approval → denied | failed
applying → failed
```

本地 API：

```text
POST /api/v1/runs/:runId/promotions
GET  /api/v1/runs/:runId/promotions
GET  /api/v1/promotions/:promotionId
POST /api/v1/approvals/:approvalId/decision
```

Promotion 创建需要本地 Session Token；审批决定只接受 Human Approval Session。Provider Session control token 不能创建 Promotion，也不能批准它。批准结果在同一次决定响应中返回 `patchPromotion`，但只有 grant 已消费且源文件通过结果复核后状态才是 `completed`。

## 3. 自动化安全验收

自动化覆盖：

- 全量 Promotion 和选定单文件；
- 审批前源目录保持不变；
- 源目录或 worktree 在请求后漂移均拒绝；
- 新建文件与父目录、修改、删除、二进制和 symlink；
- symlink 父目录替换不能写出源工作区；
- ActionContext 换参、审批过期和 grant 重复消费；
- 人工拒绝与同一 worktree 二次 Promotion；
- 后续 Blob 完整性失败时回滚已应用文件和已创建目录；
- HTTP 查询、权限分离和审批联动；
- migration 前向升级与最新 schema 断言。

## 4. 真实 Codex H7 smoke

复现：

```bash
corepack pnpm codex:hosted-promotion-smoke
```

真实 App Server Turn 在 Demo C detached worktree 内修复 `dependency.json` 并运行测试。脚本先证明源夹具在 Hosted 执行期间字节不变且测试仍失败，再创建只包含 `dependency.json` 的 Promotion，模拟本地验收人员核对并批准，最后验证源测试通过。

| 项目 | 结果 |
|---|---|
| AFR Run | `01a07116-5cc7-772a-a72d-555e14386556` |
| Hosted Workspace | `01a07116-5d15-70c1-9b7c-c6d9101b7b90` |
| Provider Session | `01a07116-5d45-73f9-8783-b2e316899eab` |
| Provider Thread / Turn | `01a07116-5d5e-7671-82a9-8aeaa953ca74` / `01a07116-5da5-7462-96eb-2d0c65908ad3` |
| 隔离 changed paths | `dependency.json` |
| 测试退出码 | 源初始 `1`；隔离 worktree `0`；审批前源 `1`；Promotion 后源 `0` |
| Promotion / Approval | `01a07116-be57-74b0-825f-5da782252dc8` / `01a07116-be56-76c9-a908-12a0a1b0dab2` |
| 批准 plan hash | `d4a899d62c271ab313a3fcec2198eadd4db87b7a92daa32398a50e2182c6ecb4` |
| 结果源指纹 | `7fba47fab7ab65b78ec3980081ce7eec7197e7584c8107b358a84a805b8ba15c` |
| Approval / Promotion | `consumed` / `completed` |
| Provider 事件 | 190；gap 0；coverage 100% / L2 |
| 事件哈希链 | 有效 |

结果 `evidence.attached` 事件 ID 为 `01a07116-be5f-7640-86a8-396fdf2d7b47`，其 `planHash` 与批准对象完全相同。

## 5. 尚未关闭的门槛

H7 只控制从隔离 worktree 回到源工作区的最终文件 Promotion，不等于控制所有 Codex 副作用：

- 工具数据网络尚未与 Provider 控制通道强制分离；
- Managed MCP 尚无允许路径；
- 新版不含精确 patch 的 Provider file-change 审批仍失败关闭；
- 正式 Web Hosted 启动与逐文件 diff 审核 UI 尚未完成；
- 崩溃中途恢复和恶意仓库全套红线测试属于 H10。

后续 H8-A～H8-C 的工具网络默认拒绝、只读 Gateway、未托管 MCP 关闭、Provider egress 与模型动态工具桥均已通过；下一阶段是 H9 Hosted UI，当前仍为 Hosted Observed / L2。

## 6. 全量回归

`pnpm acceptance` 已通过：126 项自动化测试全部通过，所有 workspace 构建与 TypeScript 类型检查通过，50,000 事件性能基线通过。本轮结果为 42,314.65 events/s、单次写入 P95 0.13 ms、Run 列表 P95 24.45 ms、时间线读取 P95 13.03 ms、冷启动 177.67 ms、常驻内存 265.44 MB。
