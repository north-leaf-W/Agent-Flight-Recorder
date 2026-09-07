# M3 Checkpoint 与 workspace manifest 验收

- 日期：2026-09-03
- 结果：通过
- 对应模块：`CheckpointManager`、migration `0004_replay.sql`

## 已验收行为

- 只接受具有至少一个 commit 的 Git 仓库；非 Git 项目返回稳定错误码。
- Checkpoint 保存 Git 根、基准 commit、tracked binary diff、workspace manifest 和 untracked Blob 引用。
- manifest 记录相对路径、类型、权限、大小、mtime、内容哈希和 tracked 状态。
- 默认排除 `.git`、`node_modules`、`dist`、`build`、`.afr` 与 `.env*` 敏感文件。
- untracked 文本或 tracked diff 命中秘密遮盖规则时失败关闭，不保存不可精确恢复的 Checkpoint。
- 单文件、总容量和文件数量均有上限，超限返回明确原因。
- 重启 `LocalStore` 后 Checkpoint 元数据与 manifest 仍可读取。
- `checkpoint.created` 是 core-authored 事件，外部事件批量入口不能伪造。

## 自动化证据

`packages/core/src/checkpoint.test.ts` 覆盖 Git commit 解析、tracked diff、untracked Blob、默认排除、Checkpoint 事件、重启读取和非 Git 拒绝。

模块验收时 core 共 42 项测试通过；M3 完成后的全量回归见 `M3-demo-c.md`。
