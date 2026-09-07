import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const selection = process.argv[2];
if (selection !== "wrong" && selection !== "correct") {
  throw new Error("Usage: node fixture-agent.mjs <wrong|correct>");
}

const dependency = selection === "correct" ? "compatible" : "incompatible";
writeFileSync(
  new URL("./dependency.json", import.meta.url),
  `${JSON.stringify({ "math-engine": dependency }, null, 2)}\n`
);
writeFileSync(
  new URL("./ATTEMPT_RESULT.txt", import.meta.url),
  `selected=${dependency}\n`
);

const testResult = spawnSync(process.execPath, ["--test", "dependency.test.mjs"], {
  cwd: new URL(".", import.meta.url),
  encoding: "utf8"
});
process.stdout.write(testResult.stdout);
process.stderr.write(testResult.stderr);
process.exitCode = testResult.status ?? 1;
