import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const path = new URL("./calculator.js", import.meta.url);
const summaryPath = new URL("./FIX_SUMMARY.md", import.meta.url);
const before = await readFile(path, "utf8");
const expected = `export function divide(dividend, divisor) {
  return dividend / divisor;
}
`;
const fixed = `export function divide(dividend, divisor) {
  if (divisor === 0) {
    throw new RangeError("Divisor must not be zero");
  }
  return dividend / divisor;
}
`;

if (before !== expected && before !== fixed) {
  throw new Error("Demo fixture has unexpected content; run reset before retrying");
}
await writeFile(path, fixed);
await writeFile(
  summaryPath,
  `# 修复证据\n\n- 增加除数为零校验\n- 验证命令：\`node --test\`\n`
);

const test = spawnSync(process.execPath, ["--test"], {
  cwd: new URL(".", import.meta.url),
  encoding: "utf8"
});
process.stdout.write(test.stdout);
process.stderr.write(test.stderr);
process.stdout.write("Fixture Agent updated calculator.js and FIX_SUMMARY.md.\n");
process.exitCode = test.status ?? 1;
