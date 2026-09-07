import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const baseUrl = process.env.AFR_SERVER ?? "http://127.0.0.1:4317";
const root = process.cwd();
const checks = [
  ["Demo A 受保护文件", "examples/demo-a-project/protected/important.txt"],
  ["Demo A 对照文件", "examples/demo-a-project/protected/untouched.txt"],
  ["Demo B 源文件", "examples/demo-project/calculator.js"],
  ["Demo B 测试", "examples/demo-project/calculator.test.js"],
  ["Demo C 原目录标记", "examples/demo-c-project/ORIGINAL_MARKER.txt"],
  ["Demo C 回放脚本", "examples/demo-c-project/fixture-agent.mjs"]
];

let failed = false;
for (const [label, relativePath] of checks) {
  const present = existsSync(resolve(root, relativePath));
  process.stdout.write(`${present ? "✓" : "✗"} ${label}：${relativePath}\n`);
  failed ||= !present;
}

const gitHead = resolve(root, "examples/demo-c-project/.git/HEAD");
const gitReady = existsSync(gitHead) && readFileSync(gitHead, "utf8").trim().length > 0;
process.stdout.write(`${gitReady ? "✓" : "✗"} Demo C 独立 Git 基线\n`);
failed ||= !gitReady;

try {
  const response = await fetch(`${baseUrl}/api/v1/meta`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const meta = await response.json();
  process.stdout.write(`✓ AFR 服务：${baseUrl} · ${meta.version}\n`);
} catch (error) {
  process.stderr.write(`✗ AFR 服务：${baseUrl}（${messageOf(error)}）\n`);
  failed = true;
}

if (failed) {
  process.stderr.write("\nDemo 环境未就绪。先运行 corepack pnpm demo:reset，并确认 AFR 已启动。\n");
  process.exitCode = 1;
} else {
  process.stdout.write("\nDemo 环境已就绪，可以依次运行 demo:a、demo:b、demo:c。\n");
}

function messageOf(value) {
  return value instanceof Error ? value.message : String(value);
}
