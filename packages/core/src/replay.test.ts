import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointManager,
  LocalStore,
  ReplayError,
  ReplayManager,
  createRunCreatedEvent,
  type ReplayExecutionRequest,
  type ReplayExecutionResult,
  type ReplayExecutor
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function fixtureRepository(): Promise<string> {
  const root = await temporaryDirectory("afr-replay-repo-");
  git(root, "init", "-q");
  git(root, "config", "user.email", "afr@example.invalid");
  git(root, "config", "user.name", "AFR Test");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "ORIGINAL_MARKER.txt"), "original\n");
  writeFileSync(join(root, "src", "dependency.txt"), "wrong\n");
  writeFileSync(
    join(root, "replay-agent.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs";
const constraint = process.argv[2];
const before = readFileSync("src/dependency.txt", "utf8").trim();
writeFileSync("src/dependency.txt", constraint + "\\n");
writeFileSync("result.txt", before + " -> " + constraint + "\\n");
console.log("test:" + (constraint === "correct" ? "pass" : "fail"));
process.exitCode = constraint === "correct" ? 0 : 1;
`
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

class DirectTestExecutor implements ReplayExecutor {
  calls = 0;

  execute(request: ReplayExecutionRequest): ReplayExecutionResult {
    this.calls += 1;
    const started = performance.now();
    const result = spawnSync(request.command[0], request.command.slice(1), {
      cwd: request.worktreePath,
      encoding: "utf8",
      timeout: request.timeoutMs,
      shell: false
    });
    return {
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: Math.round(performance.now() - started)
    };
  }
}

describe("ReplayManager", () => {
  it("restores a checkpoint, executes only in a detached worktree, and links the forked Run", async () => {
    const root = await fixtureRepository();
    writeFileSync(join(root, "checkpoint-note.txt"), "restore-me\n");
    const dataDir = await temporaryDirectory("afr-replay-data-");
    const store = new LocalStore(dataDir);
    const sourceRun = store.createRun({ projectPath: root, task: "wrong dependency", agentId: "fixture" });
    const [sourceEvent] = store.appendEvents(sourceRun.id, [createRunCreatedEvent(sourceRun)]);
    const checkpoint = new CheckpointManager(store).create(sourceRun.id, sourceEvent?.eventId);
    const executor = new DirectTestExecutor();

    const result = new ReplayManager(store, executor).run({
      checkpointId: checkpoint.checkpoint.id,
      command: [process.execPath, "replay-agent.mjs", "correct"],
      overrides: { dependencyConstraint: "correct" }
    });

    expect(result.replay.status).toBe("completed");
    expect(result.sourceWorkspaceHashAfter).toBe(result.sourceWorkspaceHashBefore);
    expect(executor.calls).toBe(1);
    expect(result.replay.worktreePath).not.toBe(root);
    expect(readFileSync(join(root, "ORIGINAL_MARKER.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(join(root, "src", "dependency.txt"), "utf8")).toBe("wrong\n");
    expect(readFileSync(join(result.replay.worktreePath, "checkpoint-note.txt"), "utf8"))
      .toBe("restore-me\n");
    expect(readFileSync(join(result.replay.worktreePath, "src", "dependency.txt"), "utf8"))
      .toBe("correct\n");
    expect(readFileSync(join(result.replay.worktreePath, "result.txt"), "utf8"))
      .toBe("wrong -> correct\n");
    expect(store.getRun(result.replay.targetRunId)).toMatchObject({
      parentRunId: sourceRun.id,
      forkedFromEventId: sourceEvent?.eventId,
      status: "completed"
    });
    expect(store.listEvents(result.replay.targetRunId).map((event) => event.eventType)).toEqual([
      "run.created",
      "run.status_changed",
      "replay.started",
      "shell.command_requested",
      "shell.command_completed",
      "file.diff_created",
      "replay.completed",
      "run.status_changed"
    ]);
    store.close();
  });

  it("keeps a real command failure as failed instead of reporting replay success", async () => {
    const root = await fixtureRepository();
    const store = new LocalStore(await temporaryDirectory("afr-replay-failure-data-"));
    const sourceRun = store.createRun({ projectPath: root, task: "failure", agentId: "fixture" });
    store.appendEvents(sourceRun.id, [createRunCreatedEvent(sourceRun)]);
    const checkpoint = new CheckpointManager(store).create(sourceRun.id);

    const result = new ReplayManager(store, new DirectTestExecutor()).run({
      checkpointId: checkpoint.checkpoint.id,
      command: [process.execPath, "replay-agent.mjs", "still-wrong"]
    });

    expect(result.replay).toMatchObject({ status: "failed", errorCode: "execution_failed" });
    expect(store.getRun(result.replay.targetRunId)?.status).toBe("failed");
    expect(store.listEvents(result.replay.targetRunId).find(
      (event) => event.eventType === "shell.command_completed"
    )).toMatchObject({ status: "error", payload: { exitCode: 1 } });
    store.close();
  });

  it("blocks external, package-publish, shell, and delete-capable commands before execution", async () => {
    const root = await fixtureRepository();
    const store = new LocalStore(await temporaryDirectory("afr-replay-policy-data-"));
    const sourceRun = store.createRun({ projectPath: root, task: "block", agentId: "fixture" });
    store.appendEvents(sourceRun.id, [createRunCreatedEvent(sourceRun)]);
    const checkpoint = new CheckpointManager(store).create(sourceRun.id);
    const executor = new DirectTestExecutor();
    const manager = new ReplayManager(store, executor);

    for (const command of [
      ["curl", "https://example.com"],
      ["npm", "publish"],
      ["rm", "ORIGINAL_MARKER.txt"],
      ["sh", "-c", "echo unsafe"]
    ]) {
      expect(manager.run({ checkpointId: checkpoint.checkpoint.id, command }).replay)
        .toMatchObject({ status: "failed", errorCode: "side_effect_blocked" });
    }
    expect(executor.calls).toBe(0);
    expect(store.listReplays(sourceRun.id)).toHaveLength(4);
    expect(readFileSync(join(root, "ORIGINAL_MARKER.txt"), "utf8")).toBe("original\n");
    store.close();
  });
});
