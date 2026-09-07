# M2 策略引擎验收记录

- 日期：2026-09-03
- 模块：ActionContext 协议与内置安全策略
- 结论：通过（仅策略判断模块）

## 验收范围

- `ActionContext` 固定 Run、Actor、工具、动作、argv、cwd、目标、环境、副作用和可恢复性；
- 相对文件目标在策略判断前基于 cwd/项目根目录规范化；
- 普通只读为 R0 allow，项目内可恢复写入为 R1 allow；
- 普通删除为 R3 ask，受保护路径删除为 R4 ask；
- 项目根目录、用户目录、项目外路径和 AFR 数据目录删除为 R4 deny；
- 目标无法解析的删除与 Agent 修改策略均 deny；
- 外部写入和生产环境动作均 ask。

## 自动化证据

协议新增 2 项 ActionContext 正反例，策略矩阵 8 项全部通过。策略为纯函数，无执行副作用，便于下一模块复用同一结果生成审批和一次性 execution grant。

## 边界

此记录对应当时只产生决策的子模块。后续审批、一次性 grant、Gateway、快照和 Demo A 已在 `M2-approvals-and-grants.md` 与 `M2-demo-a.md` 中分别验收。
