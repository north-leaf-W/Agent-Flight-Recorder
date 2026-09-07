import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("./dependency.json", import.meta.url),
  `${JSON.stringify({ "math-engine": "incompatible" }, null, 2)}\n`
);
writeFileSync(
  new URL("./ATTEMPT_RESULT.txt", import.meta.url),
  "selected=incompatible\n"
);

process.stdout.write("Prepared the failing Codex fixture without running the repair.\n");
