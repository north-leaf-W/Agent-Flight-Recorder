# M2 Demo A：危险删除拦截验收记录

- 日期：2026-09-03
- 模块：最小 Command/File Gateway、高风险文件快照、审批后恢复执行
- 结论：M2 通过，Demo A 退出标准满足

## 实现边界

Gateway 只接受单个普通文件的 `rm`/`unlink` 意图，不启动 shell。它依次执行：

1. 规范化项目根和目标的真实路径；
2. 拒绝目录、symlink、越界、缺失目标和超过 10 MiB 的文件；
3. 读取内容并计算 SHA-256；
4. 保存删除前 Blob 快照；文本遮盖导致快照不精确时直接阻止删除；
5. 使用包含内容哈希的 ActionContext 进入策略和审批；
6. 批准后再次解析路径、读取内容并重算 action digest；
7. 成功消费一次性 grant 后才调用 `unlink`；
8. 写入 `file.deleted` 或明确的失败事件。

## 自动化证据

全量命令：

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

共 63 项测试通过。Gateway 专项覆盖：

- 请求后、审批前目标不变且快照内容可读；
- 拒绝后目标不变；
- 批准后只删除原始目标，控制文件不变；
- 请求后替换文件内容会产生 action digest mismatch，目标不删除；
- 越界绝对路径、symlink 和任意 shell 命令被拒绝；
- 服务重启后待审批 Gateway action、快照、签名密钥和 grant 链路可恢复；
- Agent/CLI Token 不能调用人类决定端点；
- 外部不能伪造策略、审批、快照和授权安全事件。

## 固定 Demo 连续两轮

使用生产构建、临时数据目录和 `afr delete` 固定 CLI 连续运行：

1. 第一轮 Run `01a06663-324f-71fc-b750-11eee23fad4f`：页面成功读取删除前快照，填写原因并拒绝；CLI 返回 `denied`，`important.txt` 与 `untouched.txt` 均存在；
2. 第二轮 Run `01a06667-d5ea-7758-8faf-28244c86c1a8`：审批前文件存在，批准后审批进入 `consumed`、Gateway action 进入 `completed`、CLI 返回 `completed`；仅 `important.txt` 被删除，`untouched.txt` 仍存在；
3. 第二轮页面显示 Run 已完成、授权已消费、快照入口和 `file.deleted`，浏览器控制台无 error/warn。

临时验收目录和服务已清理，仓库内固定示例仍处于可重置状态。

## 红线检查

- 未审批的危险动作真实执行：未发生；
- 审批参数与实际目标不一致：未发生，路径和内容摘要均二次校验；
- 拒绝后换命令删除：最小 Command Gateway 不接受其他 shell 形式；
- Agent 自行写入批准：Agent Token 被决定端点拒绝；
- 历史审批被删除或改写：SQLite trigger 阻止；
- 删除前没有恢复依据：每个 Gateway 删除请求均绑定可读取的精确快照。

## 后续范围

M2 不把任意命令执行、目录递归删除、外部发送、部署或支付纳入 Gateway。通用 `afr exec` 仍是观察型采集器。下一里程碑进入 Checkpoint、Git worktree 隔离回放、对比和 Run JSON 导出。
