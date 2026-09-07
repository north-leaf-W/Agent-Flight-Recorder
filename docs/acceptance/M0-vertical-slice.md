# M0 命令—文件—时间线纵向切片验收记录

- 日期：2026-09-03
- 模块：`afr-server`、`afr-cli`、只读 Web 控制台、固定示例 Agent
- 结论：通过 M0 阶段验收；尚不代表 Demo B 最终验收通过

## 自动化验收

- HTTP 写接口必须持有本地高熵 Token；跨 Origin 写入即使持有 Token 也会被拒绝；
- 固定示例 Agent 通过 `shell: false` 执行真实命令；
- 成功命令记录 argv、cwd、PID、退出码、耗时和 stdout/stderr 摘要；
- 失败命令使 Run 进入 `failed`，不会显示为成功；
- 文件扫描产生真实的 created/modified/deleted 事件、前后 SHA-256 和文本 diff；
- 适配器无法观察文件读取、项目外活动时写入并展示 `collection.gap_detected`。

执行 `corepack pnpm build && corepack pnpm typecheck && corepack pnpm test`：协议 10 项、存储 10 项、HTTP 3 项、CLI 纵向集成 2 项，共 25 项测试通过。

## 浏览器验收

使用固定任务“修复除数为零时的处理，运行相关测试，并说明修改了什么。”生成真实 Run：

- Run ID：`01a065f0-6d06-7168-a61a-d7060b46ae70`（临时验收数据目录）；
- 页面展示 7 个顺序事件，包括命令请求、命令结果、采集缺口、文件修改和 Run 终态；
- 命令证据显示 `exitCode: 0`，原始 TAP 输出为 2 项测试全部通过；
- 文件证据显示 `calculator.js` 的真实 unified diff、前后哈希和大小；
- 服务停止并使用同一数据目录重启后，仍可读取同一 Run 和全部 7 个事件；
- 页面控制台无 error/warn。

## 当前限制

这只是开发文档 M0 的最小纵向切片。当前只观察顶层代理命令与项目目录前后变化，不能看到子进程内部的逐条命令和文件读取；尚未实现 M1 的遮盖管线、大日志 Blob、SSE 与完整 Codex 适配器，也未达到验收手册中 Demo B 的最终退出标准。

