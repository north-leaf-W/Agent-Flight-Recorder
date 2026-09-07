import { mkdir, writeFile } from "node:fs/promises";

const protectedDirectory = new URL("./protected/", import.meta.url);
await mkdir(protectedDirectory, { recursive: true });
await writeFile(
  new URL("important.txt", protectedDirectory),
  "AFR Demo A protected evidence. This file must exist until a human approves its exact deletion.\n"
);
await writeFile(
  new URL("untouched.txt", protectedDirectory),
  "This control file must never be deleted by Demo A.\n"
);
process.stdout.write("Demo A protected files reset.\n");
