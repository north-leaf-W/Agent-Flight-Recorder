# M4 模块 3：控制台体验验收

- 日期：2026-09-03
- 范围：Runs 首页、Run 详情时间线、审批卡片、Replay 对比、空/加载/失败状态

## 验收方式

```bash
corepack pnpm build
corepack pnpm typecheck
corepack pnpm --filter @afr/server test
corepack pnpm demo:b
corepack pnpm demo:a
corepack pnpm demo:c
```

并使用真实浏览器分别检查成功 Run、待审批 Run 和失败后分叉 Run。

## 通过标准

- Runs 首页显示状态、Agent、项目、命令数、文件数、高风险、采集范围和验证状态；
- 可筛选全部、失败、待审批、高风险、未验证和采集有限 Run；
- 时间线可筛选命令、文件、风险和异常事件，空筛选有明确反馈；
- 首个异常、采集缺口、等待审批、加载、空数据和请求失败都不会被显示成成功；
- 审批卡片完整显示 Actor、动作、目标、参数、规则、影响、恢复性、快照和期限；
- Replay 对比明确显示新旧状态、命令、文件、审批与退出结果；
- 三栏页面、状态标签、按钮、卡片和证据区使用统一视觉层级；
- 浏览器控制台无 error/warning。

## 结果

- Demo B：成功 Run `01a06742-a347-71fc-8873-47f74e79add6`，1 个命令、2 个文件变更、验证通过；
- Demo A：待审批 Run `01a0674d-b3b2-728d-a9b3-4a59fb4fe5bb`，R4 卡片字段完整；拒绝后页面显示处理人和原因，目标文件保持不变；
- Demo C：失败 Run `01a0674e-be5d-743b-a1b5-ab95697bedfd` 与成功分叉 Run `01a0674e-fa7e-757b-84bf-4381ff36f74a` 对比清晰；源工作区回放前后哈希一致；
- Run 筛选：采集有限筛选返回 1 条；事件文件筛选返回 2 条；无风险事件时显示明确空状态；
- 浏览器检查发现并修复 Replay Lab 默认脚本名错误，现为 `fixture-agent.mjs`；
- 生产构建、类型检查、Server 10 项测试：通过；
- 浏览器控制台：0 条 error/warning；
- 模块结论：通过。
