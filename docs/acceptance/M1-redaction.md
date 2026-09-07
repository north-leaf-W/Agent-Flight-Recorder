# M1 持久化前遮盖验收记录

- 日期：2026-09-03
- 模块：Core Redaction Pipeline
- 结论：通过

## 验收范围

- 结构化敏感字段在递归载荷中被替换；
- Bearer Token、常见供应商 Token、URL 凭据、密钥赋值和私钥正文被遮盖；
- 遮盖发生在幂等指纹、Event 哈希、SQLite 和文本 Blob 写入之前；
- 文本 Blob 遮盖后再计算 SHA-256，二进制 Blob 明确标记为 `unscanned`；
- Agent 传入的 `_afrRedaction` 会被移除，报告仅由核心生成且只含规则编号和计数；
- 输入对象不会被原地修改。

## 自动化证据

Core 共 15 项测试通过。安全用例将假 Token 写入 Run task、结构化事件、自由文本和文本 Blob，然后扫描数据目录中的 SQLite/WAL/Blob 文件，未发现原始值。

