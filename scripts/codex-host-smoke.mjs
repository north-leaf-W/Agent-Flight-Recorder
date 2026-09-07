import { CodexAppServerSupervisor } from "../packages/adapter-codex/dist/index.js";

const supervisor = new CodexAppServerSupervisor({
  cwd: process.cwd(),
  binary: process.env.AFR_CODEX_BIN ?? "codex",
  startupTimeoutMs: 10_000,
  shutdownGraceMs: 1_000
});

let handshake;
try {
  handshake = await supervisor.start();
} finally {
  if (supervisor.state() === "running") {
    const exit = await supervisor.stop("completed");
    process.stdout.write(`${JSON.stringify({
      handshake: {
        userAgent: handshake?.userAgent ?? null,
        platformFamily: handshake?.platformFamily ?? null,
        platformOs: handshake?.platformOs ?? null
      },
      processIdAssigned: supervisor.processId() !== undefined,
      exit
    }, null, 2)}\n`);
  }
}
