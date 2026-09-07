# M3 Demo C：失败后创建隔离分支验收

- 日期：2026-09-03
- 系统：macOS
- 执行器：默认 `MacOsSandboxExecutor`
- 结果：通过

## 固定案例

示例项目：`examples/demo-c-project`

源 Agent 将 `dependency.json` 改为不兼容依赖并运行真实 Node 测试，测试退出码为 1。`afr exec --checkpoint true` 在命令执行前创建 Checkpoint。分叉从该 Checkpoint 恢复，改用 `correct` 约束，真实测试退出码为 0。

## 实际验收证据

- 原 Run：`01a06688-0391-7459-a4a8-99530dbb99e3`（failed）
- Checkpoint：`01a06688-03e0-769c-89a5-93562383c071`
- 分叉 Run：`01a0668d-24e9-761f-b067-68bc72f8696e`（completed）
- Replay：`01a0668d-24e9-761f-b067-670b1d4112b6`
- worktree：`/private/tmp/afr-m3-acceptance.VhNJ9z/replay-workspaces/01a0668d-24e9-761f-b067-670b1d4112b6`
- 源目录回放前哈希：`177f9cb7dc8b158d5424f04faf4c4baf61740cc4049c30a7dc8e8028b02a1005`
- 源目录回放后哈希：`177f9cb7dc8b158d5424f04faf4c4baf61740cc4049c30a7dc8e8028b02a1005`
- 原命令：`node fixture-agent.mjs wrong`，退出码 1
- 分叉命令：`node fixture-agent.mjs correct`，退出码 0
- 外部副作用反例：Replay `01a0668e-ebc1-727c-af7b-742587e68485` 在执行 `curl` 前以 `side_effect_blocked` 失败；源目录哈希仍相同。

## 导出证据

- 格式：`afr-run-json` / `1.0`
- Event 数：9
- `hashChainValid`：`true`
- 导出哈希：`d9c7ef6e7a92a1639dd01d96a55564a231ed14d13e1a39f5c67e706403e15dc4`
- JSON 大小：20,866 bytes
- 秘密模式扫描：未发现

## 验收手册判定

- [x] 新 Run 明确关联原 Run 和分叉点。
- [x] 回放发生在独立 worktree。
- [x] 原工作目录前后哈希一致。
- [x] 新旧状态、命令、文件和测试结果可见。
- [x] 外部副作用默认阻止。
- [x] 页面没有把测试失败显示为成功。
- [x] Run JSON 可打开，哈希链有效且未发现秘密。

## 最终回归

- `corepack pnpm typecheck`：通过。
- `corepack pnpm test`：74 项测试通过（Protocol 12、Core 48、Server 10、CLI 4）。
- `corepack pnpm build`：Protocol、Core、Server、CLI 与 Web 生产构建全部通过。
- 当前最终构建再次使用默认 macOS executor 完成分叉；源目录前后哈希均为 `a0fd1d0bd031a09811219dab48ee903853eb40945042ab0dba3aae38fc3b53c6`。

未实现且不阻塞 M3：Recorded、非 Git 回放、任意本地二进制、完整 `.afr-run.zip` 导入导出。
