import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AppServerExit,
  AppServerSupervisorOptions,
  AppServerThread,
  AppServerTurn
} from "@afr/adapter-codex";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer, type BuildServerOptions } from "./server.js";
import type { HostedHost, HostedLifecycleSnapshot } from "./hosted-runs.js";

const directories: string[] = [];
let fakeTurnSequence = 0;

class FakeHostedHost implements HostedHost {
  private hostState = "idle";
  private resolveExit!: (exit: AppServerExit) => void;
  private readonly exit = new Promise<AppServerExit>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    private readonly options: AppServerSupervisorOptions,
    readonly turnInputs: string[]
  ) {}

  state(): string {
    return this.hostState;
  }

  processId(): number | undefined {
    return this.hostState === "running" ? 4242 : undefined;
  }

  async start() {
    this.hostState = "running";
    return { userAgent: "fake-codex", platformFamily: "fixture", raw: {} };
  }

  async startThread(): Promise<AppServerThread> {
    await this.options.onNotification?.({
      method: "thread/started",
      params: { thread: { id: "thread-fixture" } }
    });
    return { threadId: "thread-fixture", raw: { thread: { id: "thread-fixture" } } };
  }

  async resumeThread(threadId: string): Promise<AppServerThread> {
    return { threadId, raw: { thread: { id: threadId } } };
  }

  async startTurn(threadId: string, text: string): Promise<AppServerTurn> {
    this.turnInputs.push(text);
    fakeTurnSequence += 1;
    const turnId = `turn-${fakeTurnSequence}`;
    await this.options.onNotification?.({
      method: "turn/started",
      params: { threadId, turn: { id: turnId } }
    });
    if (text.includes("[edit]")) {
      writeFileSync(join(this.options.cwd, "dependency.txt"), "fixed\n");
    }
    if (!text.includes("[hold]")) {
      queueMicrotask(() => {
        void this.options.onNotification?.({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: text.includes("[fail]") ? "failed" : "completed" } }
        });
      });
    }
    return { turnId, raw: { turn: { id: turnId } } };
  }

  async cancelTurn(threadId: string, turnId: string): Promise<AppServerExit> {
    await this.options.onNotification?.({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "interrupted" } }
    });
    return this.stop("cancelled");
  }

  async stop(outcome: "completed" | "failed" | "cancelled" = "completed"): Promise<AppServerExit> {
    if (this.hostState !== "stopped") {
      this.hostState = outcome === "failed" ? "failed" : "stopped";
      this.resolveExit({
        outcome,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: { text: "", byteSize: 0, truncated: false }
      });
    }
    return this.exit;
  }

  waitForExit(): Promise<AppServerExit> {
    return this.exit;
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Hosted Run Web lifecycle", () => {
  it("starts, continues, finalizes, previews diff, and creates a selective Promotion plan", async () => {
    const projectPath = await gitProject();
    const turnInputs: string[] = [];
    const server = await hostedServer(projectPath, turnInputs);

    const denied = await server.app.inject({
      method: "POST",
      url: "/api/v1/hosted-runs",
      payload: { projectPath, task: "[edit] fix it", sandbox: "workspace-write" }
    });
    expect(denied.statusCode).toBe(401);

    const started = await server.app.inject({
      method: "POST",
      url: "/api/v1/hosted-runs",
      headers: { authorization: `Bearer ${server.token}` },
      payload: { projectPath, task: "[edit] fix it", sandbox: "workspace-write", timeoutMs: 60_000 }
    });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;
    await waitFor(() => server.hostedRuns.snapshot(runId).state === "idle");
    expect(server.hostedRuns.snapshot(runId)).toMatchObject({
      state: "idle",
      active: true,
      canContinue: true,
      canFinish: true
    });

    const continued = await server.app.inject({
      method: "POST",
      url: `/api/v1/hosted-runs/${runId}/turns`,
      headers: { authorization: `Bearer ${server.token}` },
      payload: { text: "verify the change" }
    });
    expect(continued.statusCode).toBe(202);
    await waitFor(() => server.hostedRuns.snapshot(runId).state === "idle" && turnInputs.length === 2);
    expect(turnInputs).toEqual(["[edit] fix it", "verify the change"]);

    const finished = await server.app.inject({
      method: "POST",
      url: `/api/v1/hosted-runs/${runId}/finish`,
      headers: { authorization: `Bearer ${server.token}` },
      payload: {}
    });
    expect(finished.statusCode).toBe(200);
    expect(finished.json().lifecycle).toMatchObject({ state: "completed", canPromote: true });
    const diff = await server.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/hosted-diff` });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({ changedPaths: ["dependency.txt"], redactionState: "scanned" });
    expect(diff.json().diff).toContain("+fixed");
    const review = await server.app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/promotion-review`
    });
    expect(review.json().review).toMatchObject({
      ready: true,
      baseline: "finalized-change-set",
      sourceDrifted: false,
      worktreeDrifted: false
    });

    const promotion = await server.app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/promotions`,
      headers: { authorization: `Bearer ${server.token}` },
      payload: { selectedPaths: ["dependency.txt"], reason: "reviewed diff" }
    });
    expect(promotion.statusCode).toBe(202);
    expect(promotion.json().result).toMatchObject({
      promotion: { status: "waiting_approval", selectedPaths: ["dependency.txt"] },
      plan: { entries: [{ path: "dependency.txt" }] }
    });
    writeFileSync(join(projectPath, "dependency.txt"), "source drift\n");
    const drifted = await server.app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/promotion-review`
    });
    expect(drifted.json().review).toMatchObject({ ready: false, sourceDrifted: true });
    await server.app.close();
  });

  it("interrupts an active Turn, stops the Host, and finalizes cancellation evidence", async () => {
    const projectPath = await gitProject();
    const server = await hostedServer(projectPath, []);
    const started = await server.app.inject({
      method: "POST",
      url: "/api/v1/hosted-runs",
      headers: { authorization: `Bearer ${server.token}` },
      payload: { projectPath, task: "[hold] wait", sandbox: "read-only" }
    });
    const runId = started.json().run.id as string;
    await waitFor(() => server.hostedRuns.snapshot(runId).currentTurnId !== undefined);

    const cancelled = await server.app.inject({
      method: "POST",
      url: `/api/v1/hosted-runs/${runId}/cancel`,
      headers: { authorization: `Bearer ${server.token}` },
      payload: {}
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().lifecycle).toMatchObject({ state: "cancelled", active: false });
    expect(server.store.getRun(runId)?.status).toBe("cancelled");
    expect(server.store.getHostedWorkspaceByRun(runId)?.status).toBe("finalized");
    await server.app.close();
  });

  it("resumes an interrupted persistent Thread after the AFR server restarts", async () => {
    const projectPath = await gitProject();
    const dataDir = await mkdtemp(join(tmpdir(), "afr-hosted-restart-"));
    directories.push(dataDir);
    const firstTurns: string[] = [];
    const first = await hostedServer(projectPath, firstTurns, { dataDir });
    const started = await first.app.inject({
      method: "POST",
      url: "/api/v1/hosted-runs",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { projectPath, task: "first turn", sandbox: "workspace-write" }
    });
    const runId = started.json().run.id as string;
    await waitFor(() => first.hostedRuns.snapshot(runId).state === "idle");
    await first.app.close();

    const resumedTurns: string[] = [];
    const second = await hostedServer(projectPath, resumedTurns, { dataDir });
    expect(second.hostedRuns.snapshot(runId)).toMatchObject({ state: "interrupted", canContinue: true });
    const resumed = await second.app.inject({
      method: "POST",
      url: `/api/v1/hosted-runs/${runId}/turns`,
      headers: { authorization: `Bearer ${second.token}` },
      payload: { text: "continue safely", sandbox: "read-only" }
    });
    expect(resumed.statusCode).toBe(202);
    await waitFor(() => second.hostedRuns.snapshot(runId).state === "idle");
    expect(resumedTurns).toEqual(["continue safely"]);
    expect(second.store.listProviderSessions(runId)).toHaveLength(2);
    await second.app.close();
  });

  it("records a failed Turn and fails closed", async () => {
    const projectPath = await gitProject();
    const server = await hostedServer(projectPath, []);
    const started = await server.app.inject({
      method: "POST",
      url: "/api/v1/hosted-runs",
      headers: { authorization: `Bearer ${server.token}` },
      payload: { projectPath, task: "[fail] fail", sandbox: "read-only" }
    });
    const runId = started.json().run.id as string;
    await waitFor(() => server.hostedRuns.snapshot(runId).state === "failed");
    expect(server.store.getRun(runId)?.status).toBe("failed");
    expect(server.store.getLatestProviderSession(runId)?.status).toBe("failed");
    await server.app.close();
  });
});

async function gitProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "afr-hosted-web-project-"));
  directories.push(root);
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "afr@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "AFR Test"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "dependency.txt"), "wrong\n");
  writeFileSync(join(root, "src", "index.js"), "export const ready = true;\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

async function hostedServer(
  projectPath: string,
  turnInputs: string[],
  options: { dataDir?: string } = {}
) {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), "afr-hosted-web-data-"));
  if (options.dataDir === undefined) directories.push(dataDir);
  const buildOptions: BuildServerOptions = {
    dataDir,
    webRoot: false,
    hosted: {
      allowedProjectRoots: [projectPath],
      runtimeVersion: "codex-fixture 1.0",
      platform: "darwin",
      requireProviderEgress: false,
      hostFactory: (hostOptions) => new FakeHostedHost(hostOptions, turnInputs)
    }
  };
  return buildServer(buildOptions);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Hosted lifecycle state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
