# M4 模块 2：启动恢复与迁移保护验收

- 日期：2026-09-03
- 范围：SQLite 启动检查、事件链校验、临时 Blob 清理、升级前备份、恢复报告、启动错误

## 验收命令

```bash
corepack pnpm --filter @afr/core test
corepack pnpm --filter @afr/server test
corepack pnpm typecheck
corepack pnpm build
```

## 通过标准

- 服务对外监听前执行 SQLite `quick_check` 和所有 Run 的事件哈希链校验；
- 清理未提交的临时 Blob，并在报告中显示数量；
- 已有数据库存在待执行 migration 时，先生成权限为 `0600` 的一致性备份；
- 所有待执行 migration 位于同一事务，失败时不留下半升级 schema；
- `/api/v1/meta` 只返回非敏感恢复摘要，不返回本地 Token；
- 页面明确显示数据库健康、校验 Run 数、schema 版本、迁移和清理结果；
- 端口占用、权限错误和数据库升级失败具有可理解的启动错误。

## 结果

- Core：50 项测试通过，其中 migration 备份和事件篡改故障注入均通过；
- Server：10 项 API/集成测试通过，metadata 返回恢复摘要且不泄漏 Token；
- 类型检查与生产构建：通过；
- 真实 `.afr` 启动：SQLite `ok`，校验 1 条 Run，schema `0004_replay`；
- 浏览器检查：恢复报告可见，控制台无 error/warning；
- 模块结论：通过。
