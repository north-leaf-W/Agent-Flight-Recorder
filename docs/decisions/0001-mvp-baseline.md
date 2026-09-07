# ADR 0001：个人展示版技术基线

- 状态：已接受
- 日期：2026-09-03

## 决策

1. 首发 Agent 为 Codex，同时保留固定示例 Agent 作为验收夹具。
2. 首发系统只保证 macOS，Linux 仅保持开发期兼容。
3. 后端使用 Node.js 22、TypeScript、Fastify；前端使用 React、TypeScript、Vite。
4. 使用 SQLite WAL 和本地 SHA-256 内容寻址 Blob Store。
5. 控制台使用浏览器页面，服务只监听 loopback。
6. 回放只支持 Git worktree；非 Git 与真实外部副作用回放不进入展示版。
7. 模型正文在本地持久化前遮盖，并允许切换为仅保存元数据。
8. 静态加密与开源许可证在公开展示前另行决定，不阻塞 M0。

## 边界

当前产品不能被描述为绝对安全沙箱。采集能力不足或适配器不兼容时必须写入并展示 `collection.gap_detected`，不能继续声称记录完整。

