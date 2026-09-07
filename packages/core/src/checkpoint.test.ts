import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointError,
  CheckpointManager,
  LocalStore,
  createRunCreatedEvent
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
  const root = await temporaryDirectory("afr-checkpoint-repo-");
  git(root, "init", "-q");
  git(root, "config", "user.email", "afr@example.invalid");
  git(root, "config", "user.name", "AFR Test");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "value.txt"), "before\n");
  writeFileSync(join(root, "ORIGINAL_MARKER.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

describe("CheckpointManager", () => {
  it("captures a Git manifest, tracked diff, and untracked Blob while excluding generated and sensitive paths", async () => {
    const root = await fixtureRepository();
    writeFileSync(join(root, "src", "value.txt"), "checkpoint\n");
    writeFileSync(join(root, "notes.txt"), "untracked\n");
    mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
    writeFileSync(join(root, "node_modules", "ignored", "package.js"), "ignored\n");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "bundle.js"), "ignored\n");
    writeFileSync(join(root, ".env"), "API_TOKEN=secret-value\n");

    const dataDir = await temporaryDirectory("afr-checkpoint-data-");
    const store = new LocalStore(dataDir, () => new Date("2026-09-03T08:00:00Z"));
    const run = store.createRun({ projectPath: root, task: "checkpoint", agentId: "fixture" });
    const [sourceEvent] = store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const manager = new CheckpointManager(store);
    const result = manager.create(run.id, sourceEvent?.eventId);

    expect(result.checkpoint).toMatchObject({
      runId: run.id,
      sourceEventId: sourceEvent?.eventId,
      workspaceRoot: realpathSync(root),
      baseCommit: git(root, "rev-parse", "HEAD"),
      untrackedCount: 1
    });
    expect(result.checkpoint.trackedDiffBlobHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
      "ORIGINAL_MARKER.txt",
      "notes.txt",
      "src/value.txt"
    ]);
    expect(result.manifest.entries.find((entry) => entry.path === "notes.txt")?.blobHash)
      .toMatch(/^[0-9a-f]{64}$/);
    expect(store.listEvents(run.id).at(-1)).toMatchObject({
      eventType: "checkpoint.created",
      payload: { checkpointId: result.checkpoint.id, untrackedCount: 1 }
    });
    store.close();
  });

  it("persists checkpoint metadata and manifest across restart", async () => {
    const root = await fixtureRepository();
    writeFileSync(join(root, "new.txt"), "saved\n");
    const dataDir = await temporaryDirectory("afr-checkpoint-persist-");
    let store = new LocalStore(dataDir);
    const run = store.createRun({ projectPath: root, task: "persist", agentId: "fixture" });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const created = new CheckpointManager(store).create(run.id);
    store.close();

    store = new LocalStore(dataDir);
    const manager = new CheckpointManager(store);
    expect(store.getCheckpoint(created.checkpoint.id)).toEqual(created.checkpoint);
    expect(manager.readManifest(created.checkpoint.id)).toEqual(created.manifest);
    store.close();
  });

  it("rejects non-Git projects with a stable error code", async () => {
    const root = await temporaryDirectory("afr-checkpoint-plain-");
    writeFileSync(join(root, "file.txt"), "plain\n");
    const store = new LocalStore(await temporaryDirectory("afr-checkpoint-nongit-data-"));
    const run = store.createRun({ projectPath: root, task: "reject", agentId: "fixture" });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);

    expect(() => new CheckpointManager(store).create(run.id)).toThrowError(
      expect.objectContaining<Partial<CheckpointError>>({ code: "not_git_repository" })
    );
    store.close();
  });
});
