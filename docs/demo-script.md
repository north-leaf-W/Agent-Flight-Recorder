# AFR 3～5 分钟演示脚本

## 录制前

1. 使用假数据和无痕浏览器，不放入真实密钥或重要仓库。
2. 运行 `corepack pnpm quickstart`，另开终端运行 `corepack pnpm demo:reset` 和 `corepack pnpm demo:doctor`。
3. 浏览器打开 `http://127.0.0.1:4317`，录制分辨率建议 1440p。

## 00:00～00:35：产品定位与健康状态

- 画面：首页标题、版本、数据目录、恢复报告和采集范围提示。
- 旁白：AFR 在本地记录 Agent 的命令、文件证据、审批和回放；它明确标记未覆盖范围，不声称绝对完整。

## 00:35～01:35：Demo B 代码修改证据链

1. 运行 `corepack pnpm demo:b:reset && corepack pnpm demo:b`。
2. 打开新 Run，展示命令、`calculator.js` diff、`FIX_SUMMARY.md` 和测试退出码 0。
3. 使用“文件”筛选，说明页面信息与磁盘真实变化一致。

## 01:35～02:40：Demo A 危险删除审批

1. 运行 `corepack pnpm demo:a:reset && corepack pnpm demo:a`。
2. 在审批卡片出现后先展示磁盘上的 `protected/important.txt` 仍存在。
3. 展示 R4、完整目标、原始参数、影响、恢复性和删除前快照，然后点击“拒绝”。
4. 再次确认文件未变化；如时间允许，重置后演示“仅本次批准”只删除目标文件。

## 02:40～04:10：Demo C 隔离分叉

1. 运行 `corepack pnpm demo:c:reset && corepack pnpm demo:c`，原 Run 预期退出码 1。
2. 打开失败 Run，指出首个异常和执行前 Checkpoint。
3. 保留默认 argv `["node", "fixture-agent.mjs", "correct"]`，点击“创建分支并回放”。
4. 展示 worktree 路径以及新旧状态、文件和退出结果对比；强调源工作区哈希前后一致。

## 04:10～04:35：收尾

- 展示 Run JSON 导出、版本与已知限制。
- 结论：AFR 的价值是让 Agent 行为看得见、危险动作拦得住、失败后回得去。

## 素材清单

- 首页/成功 Run 全景；
- R4 审批卡片和删除前快照；
- Replay Lab 新旧 Run 对比；
- 终端中的 Run ID、真实退出码和源工作区哈希；
- README 的架构图与支持边界。
