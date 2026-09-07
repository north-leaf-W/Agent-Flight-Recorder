import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { HostedWorkspaceManager } from "../packages/core/dist/index.js";
import { buildServer } from "../apps/server/dist/index.js";

const projectPath = resolve(process.env.AFR_H9_PROJECT ?? "examples/demo-c-project");
const dataDir = await mkdtemp(join(tmpdir(), "afr-h9-browser-"));
const port = Number.parseInt(process.env.AFR_H9_PORT ?? "4399", 10);
let sequence = 0;

class BrowserFixtureHost {
  stateValue = "idle";
  exitPromise = new Promise((resolveExit) => { this.resolveExit = resolveExit; });

  constructor(options) {
    this.options = options;
  }

  state() { return this.stateValue; }
  processId() { return this.stateValue === "running" ? process.pid : undefined; }

  async start() {
    this.stateValue = "running";
    return { userAgent: "h9-browser-fixture", platformFamily: "fixture", raw: {} };
  }

  async startThread() {
    const threadId = `browser-thread-${Date.now()}`;
    await this.options.onNotification?.({ method: "thread/started", params: { thread: { id: threadId } } });
    return { threadId, raw: { thread: { id: threadId } } };
  }

  async resumeThread(threadId) {
    return { threadId, raw: { thread: { id: threadId } } };
  }

  async startTurn(threadId, text) {
    const turnId = `browser-turn-${++sequence}`;
    await this.options.onNotification?.({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    if (text.includes("修复") || text.includes("edit")) {
      writeFileSync(join(this.options.cwd, "dependency.json"), '{\n  "math-engine": "correct"\n}\n');
    }
    if (!text.includes("等待取消")) {
      setTimeout(() => {
        void this.options.onNotification?.({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } }
        });
      }, 120);
    }
    return { turnId, raw: { turn: { id: turnId } } };
  }

  async cancelTurn(threadId, turnId) {
    await this.options.onNotification?.({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "interrupted" } }
    });
    return this.stop("cancelled");
  }

  async stop(outcome = "completed") {
    if (this.stateValue !== "stopped") {
      this.stateValue = outcome === "failed" ? "failed" : "stopped";
      this.resolveExit({
        outcome,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: { text: "", byteSize: 0, truncated: false }
      });
    }
    return this.exitPromise;
  }

  waitForExit() { return this.exitPromise; }
}

const server = await buildServer({
  dataDir,
  logger: false,
  hosted: {
    allowedProjectRoots: [projectPath],
    runtimeVersion: "codex-h9-browser-fixture 1.0",
    platform: "darwin",
    requireProviderEgress: false,
    hostFactory: (options) => new BrowserFixtureHost(options)
  }
});

await server.app.listen({ host: "127.0.0.1", port });
process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}`, projectPath, dataDir })}\n`);

const shutdown = async () => {
  const workspaces = new HostedWorkspaceManager(server.store);
  for (const run of server.store.listRunSummaries(1_000)) {
    const workspace = server.store.getHostedWorkspaceByRun(run.id);
    if (workspace?.status === "active") {
      try { workspaces.finalize(workspace.id); } catch { /* evidence already records failure */ }
    }
    const finalWorkspace = server.store.getHostedWorkspaceByRun(run.id);
    if (finalWorkspace?.status === "finalized" || finalWorkspace?.status === "failed") {
      try { workspaces.cleanup(finalWorkspace.id); } catch { /* best-effort fixture cleanup */ }
    }
  }
  server.app.server.closeAllConnections();
  await server.app.close();
  await rm(dataDir, { recursive: true, force: true });
};

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
