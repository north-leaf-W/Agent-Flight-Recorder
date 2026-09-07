# M0-E01 本地存储验收记录

- 日期：2026-09-03
- 模块：`@afr/core` 的 SQLite Event Store 与 Blob Store
- 结论：通过

## 验收范围

- SQLite 使用 WAL、外键和事务；数据目录权限收敛为 `0700`；
- 事件只追加，数据库触发器禁止更新或删除；
- Run 内顺序号和 SHA-256 事件链由服务端分配；
- 批量事件写入失败时整体回滚；
- `idempotencyKey` 相同且内容相同的重试去重，内容冲突则拒绝；
- Blob 先原子落盘、按 SHA-256 去重，事件只能引用已登记 Blob；
- 重启后 Run/Event 保留，并执行 SQLite quick check、哈希链校验和临时 Blob 清理。

## 自动化证据

执行 `corepack pnpm test && corepack pnpm typecheck && corepack pnpm build`。截至本模块验收：协议 10 项、存储 10 项测试全部通过；类型检查和生产构建通过。
