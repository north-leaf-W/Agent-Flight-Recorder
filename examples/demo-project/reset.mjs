import { rm, writeFile } from "node:fs/promises";

await writeFile(
  new URL("./calculator.js", import.meta.url),
  `export function divide(dividend, divisor) {
  return dividend / divisor;
}
`
);
await rm(new URL("./FIX_SUMMARY.md", import.meta.url), { force: true });
process.stdout.write("Demo B fixture reset.\n");
