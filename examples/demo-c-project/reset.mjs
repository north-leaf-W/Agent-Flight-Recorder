import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });

if (existsSync(new URL("./ATTEMPT_RESULT.txt", import.meta.url))) {
  rmSync(new URL("./ATTEMPT_RESULT.txt", import.meta.url));
}
writeFileSync(
  new URL("./dependency.json", import.meta.url),
  `${JSON.stringify({ "math-engine": "compatible" }, null, 2)}\n`
);
git("init", "-q");
git("config", "user.email", "afr-demo@example.invalid");
git("config", "user.name", "AFR Demo");
git(
  "add",
  "ORIGINAL_MARKER.txt",
  "dependency.json",
  "dependency.test.mjs",
  "fixture-agent.mjs",
  "prepare-codex.mjs",
  "reset.mjs"
);
git("commit", "-qm", "Reset Demo C fixture", "--allow-empty");
process.stdout.write(`Demo C Git fixture reset at ${root}\n`);
