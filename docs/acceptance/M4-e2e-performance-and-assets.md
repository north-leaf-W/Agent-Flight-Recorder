# M4 模块 4：E2E、性能与展示素材验收

- 日期：2026-09-03
- 版本：`0.1.0-demo.0`
- 环境：macOS 26.4、Node.js 22.23.2、pnpm 10.34.5、Apple Git 2.50.1

## 关键 E2E

执行：

```bash
corepack pnpm test:e2e
```

结果：

- 三个固定 Demo 夹具测试 3/3 通过；
- Server 关键 API/集成测试 11/11 通过，覆盖服务重启、审批与 grant、换参拒绝、Agent 伪造审批拒绝、危险删除、Checkpoint、隔离回放、比较与导出；
- CLI 真实命令/文件采集测试 4/4 通过；
- 生产构建通过。

symlink 越界、路径穿越、秘密遮盖、Event/Blob 原子持久化等安全用例继续由 Core 全量测试覆盖。

## 50k 事件性能基线

执行：

```bash
corepack pnpm benchmark
```

临时数据在测试结束后自动删除。2026-09-03 实测：

| 指标 | 目标 | 实测 |
|---|---:|---:|
| 单事件写入 p95 | ≤ 50 ms | 0.15 ms |
| 批量持续写入 | ≥ 20 events/s | 42,812.76 events/s |
| 200 Run 摘要列表 p95 | ≤ 1 s | 15.48 ms |
| 10,000 事件读取 p95 | ≤ 2 s | 11.08 ms |
| 50k 事件恢复冷启动 | ≤ 5 s | 172.34 ms |
| 进程 RSS | ≤ 500 MB | 264.58 MB |
| 持久化完整性 | 50,000/50,000 | 50,000/50,000 |

这些数字是当前开发机上的可重复工程基线，不代表所有硬件上的承诺。

## 展示素材

- README 包含架构图、支持版本、快速开始和已知限制；
- `docs/architecture.md` 说明组件和信任边界；
- `docs/demo-script.md` 提供 3～5 分钟录制分镜、命令和旁白；
- `docs/assets/afr-approval.png` 与 `docs/assets/afr-replay-lab.png` 为 1280×720 固定 Demo 截图；
- 截图和演示只使用无价值夹具数据，不含 Token。

## 结论

模块通过。
