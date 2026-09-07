import { spawnSync } from "node:child_process";

const minimumNodeMajor = 22;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

if (nodeMajor < minimumNodeMajor) {
  fail(`需要 Node.js ${minimumNodeMajor} 或更高版本，当前是 ${process.versions.node}。`);
}

const port = process.env.AFR_PORT ?? "4317";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
  fail(`AFR_PORT 必须是 1～65535 的整数，当前值是 ${JSON.stringify(port)}。`);
}

const host = process.env.AFR_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  fail(`展示版只允许绑定本机回环地址，不能使用 AFR_HOST=${JSON.stringify(host)}。`);
}

const git = spawnSync("git", ["--version"], { encoding: "utf8" });
if (git.error !== undefined || git.status !== 0) {
  fail("未找到 Git。Demo C 的隔离回放需要 Git worktree。", git.stderr);
}

process.stdout.write(
  `[AFR] 环境检查通过：Node ${process.versions.node} · ${git.stdout.trim()} · http://${host}:${port}\n`
);

function fail(message, detail) {
  process.stderr.write(`[AFR] 启动前检查失败：${message}\n`);
  if (detail?.trim()) process.stderr.write(`${detail.trim()}\n`);
  process.exit(1);
}
