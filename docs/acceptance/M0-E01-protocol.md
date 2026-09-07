# M0-E01 协议基础验收记录

- 日期：2026-09-03
- 模块：`@afr/protocol`
- 结论：通过

## 验收范围

- Event schema 固定为 `1.0-draft`；
- `IncomingEvent` 不允许采集端提交服务端可信字段；
- Event ID、Run ID 使用 UUIDv7 格式；
- 完整 Envelope 包含顺序号、记录时间和 SHA-256 哈希链字段；
- Run 状态迁移与终态不可变约束已固化；
- API 错误响应固定为 `code/message/details/requestId`。

## 自动化证据

执行命令：

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

结果：10 个单元测试通过，类型检查通过，生产构建通过。

