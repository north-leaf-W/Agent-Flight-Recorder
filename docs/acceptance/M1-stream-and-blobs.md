# M1 实时事件与大日志验收记录

- 日期：2026-09-03
- 模块：增量 Event API、SSE、日志 Blob 与按需查看
- 结论：通过

## 验收范围

- Event API 支持 `afterSequenceNo` 增量读取；
- SSE 使用 Run 内 `sequenceNo` 作为事件 ID，连接或断线后可从游标补拉；
- UI 初次加载历史事件后通过 SSE 接收新事件并按 Event ID 去重；
- 超过 8 KiB 的 stdout/stderr 仅内联前后摘要，完整内容写入 SHA-256 Blob；
- 文本日志写 Blob 前经过遮盖，事件同时记录原始字节数、存储字节数和遮盖报告；
- 控制台默认折叠含大输出的 Payload，完整日志由用户按需加载。

## 自动化与浏览器证据

- 自动化覆盖增量游标、SSE replay、Blob API、日志截断、Blob 引用和 Token 遮盖；
- 浏览器中启动一个持续 15 秒的 Run，页面先显示 `running` 与 4 个事件；不刷新页面，随后自动显示 `completed` 与 6 个事件；
- 9 KiB 日志显示按需加载入口；加载后的完整文本包含 `[REDACTED]`，不含原始假 Token；
- 命令 argv、内联摘要和 Blob 三处均未显示原始假 Token。

