# M4 模块 1：启动与固定 Demo 夹具验收

- 日期：2026-09-03
- 范围：一条命令启动、环境预检、固定任务文本、三个 Demo 的统一重置与确定性夹具

## 验收命令

```bash
node scripts/preflight.mjs
corepack pnpm demo:reset
node --test scripts/demo-fixtures.test.mjs
corepack pnpm build
corepack pnpm demo:doctor
```

## 通过标准

- Node.js、Git、监听地址和端口在启动前得到明确校验；
- `corepack pnpm quickstart` 是从锁文件安装到服务启动的单一入口；
- 三个 Demo 各有固定任务文本，`demo:reset` 可统一恢复夹具；
- Demo A 连续重置后两个受保护文件内容固定；
- Demo B 每次都修改/创建两个文件且测试通过，重置后不残留产物；
- Demo C 每次都让 `wrong` 返回 1、`correct` 返回 0，原目录标记不变；
- `demo:doctor` 能辨认夹具或服务未就绪，并在就绪时显示版本。

## 结果

- 自动化夹具测试：3/3 通过；
- 启动前检查：通过；
- 一条命令构建并启动：通过，服务监听 `http://127.0.0.1:4317`；
- `demo:doctor`：服务、六个关键夹具文件和 Demo C Git 基线全部通过；
- Demo B 真实联调：Run `01a06742-a347-71fc-8873-47f74e79add6` 完成，退出码 0，记录 2 个变更文件；
- 模块结论：通过。
