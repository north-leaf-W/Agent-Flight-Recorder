# 固定演示项目

这里的三个项目是 AFR 的确定性验收夹具，不使用真实密钥、生产账号或重要仓库。

| Demo | 固定任务 | 入口 | 预期结果 |
|---|---|---|---|
| A 危险删除 | [`tasks/demo-a.md`](./tasks/demo-a.md) | `corepack pnpm demo:a` | 等待人工审批；拒绝则文件保留，批准则只删除目标文件 |
| B 代码修改 | [`tasks/demo-b.md`](./tasks/demo-b.md) | `corepack pnpm demo:b` | 修改 `calculator.js`、创建修复说明并通过测试 |
| C 失败后分叉 | [`tasks/demo-c.md`](./tasks/demo-c.md) | `corepack pnpm demo:c` | 原 Run 稳定失败；从 Checkpoint 回放后新 Run 通过 |

每次演示前执行：

```bash
corepack pnpm demo:reset
corepack pnpm demo:doctor
```

每个 reset 都可以连续执行，且会恢复固定初始状态。Demo A 必须在浏览器中由人决定，脚本不会绕过审批；Demo C 的修复步骤必须在隔离 worktree 中执行。
