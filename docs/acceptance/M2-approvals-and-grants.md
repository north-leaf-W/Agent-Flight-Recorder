# M2 审批与一次性授权验收记录

- 日期：2026-09-03
- 模块：审批持久化、action digest、execution grant、审批 HTTP API、Run 详情审批卡片
- 结论：本子模块通过；完整 M2 结果见 `M2-demo-a.md`

## 已验证行为

- SQLite migration 持久化审批和授权，审批记录禁止删除，请求身份字段禁止改写；
- 状态机覆盖 `pending → approved → consumed`、`pending → denied/expired` 和 `approved → expired`；
- action digest 绑定规范化工具、动作、参数、目标、cwd、环境、副作用、恢复性和内容哈希；
- 本地 HMAC 密钥签发短期 grant，grant 绑定 Run、action digest、nonce 和有效期；
- 换参、过期、伪造签名和重复消费全部拒绝，拒绝会写入安全事件；
- Agent/CLI 会话 Token 无权批准，批准端点只接受浏览器导航建立的人类审批会话；
- 通用 Event API 拒绝适配器伪造策略、审批和 grant 安全事件；
- 服务重启后审批投影、签名密钥和未消费 grant 均可恢复；
- Run 详情卡片展示 Actor、动作、完整目标、原始参数、风险、规则、影响、理由、恢复性、快照状态、期限和摘要；
- 页面可填写决定说明，完成“仅本次批准”或“拒绝”，历史决定只读展示。

## 自动化证据

执行：

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

覆盖审批正常流、拒绝、请求超时、grant 超时、参数换包、重复消费、签名伪造、重启恢复、跨 Origin、Agent Token 越权批准和外部伪造审批事件。

## 真实页面验收

使用临时数据目录启动生产构建，在本地浏览器完成两条独立 Run：

1. 待审批卡片完整显示 R4 删除目标，点击“仅本次批准”后记录 `approval.decided`，Run 从 `waiting_approval` 恢复为 `running`；
2. 填写“该文件仍是验收证据，禁止删除”并拒绝，卡片只读显示审批者、原因和 `denied`，时间线记录拒绝事件；
3. 分离人类审批凭证后再次从真实浏览器批准成功；页面控制台无 error/warn。

## 当前边界

本记录只证明审批决定和授权不可被普通适配器伪造、篡改或重复使用。随后实现的 Gateway、快照和 Demo A 在独立验收记录中验证，避免用后续结果反向覆盖本子模块当时的边界。
