import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EVENT_SCHEMA_VERSION } from "@afr/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { HostedWorkspaceManager, LocalStore, createRunCreatedEvent } from "./index.js";

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

describe("HostedWorkspaceManager", () => {
  it("restores a Checkpoint into a disposable worktree and preserves evidence before cleanup", async () => {
    const source = await temporaryDirectory("afr-hosted-source-");
    git(source, "init", "-q");
    git(source, "config", "user.email", "afr@example.invalid");
    git(source, "config", "user.name", "AFR Test");
    writeFileSync(join(source, "dependency.json"), "{\"engine\":\"compatible\"}\n");
    writeFileSync(join(source, "ORIGINAL_MARKER.txt"), "original\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "fixture");

    writeFileSync(join(source, "dependency.json"), "{\"engine\":\"incompatible\"}\n");
    writeFileSync(join(source, "checkpoint-note.txt"), "restore me\n");
    const sourceDependencyBefore = readFileSync(join(source, "dependency.json"));
    const dataDir = await temporaryDirectory("afr-hosted-data-");
    const store = new LocalStore(dataDir);
    const run = store.createRun({ projectPath: source, task: "fix dependency", agentId: "codex-app-server" });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const manager = new HostedWorkspaceManager(store);

    const prepared = manager.prepare({ runId: run.id });
    expect(prepared.workspace.status).toBe("ready");
    expect(prepared.workspace.worktreePath).not.toBe(source);
    expect(readFileSync(join(prepared.workspace.worktreePath, "dependency.json"), "utf8"))
      .toContain("incompatible");
    expect(readFileSync(join(prepared.workspace.worktreePath, "checkpoint-note.txt"), "utf8"))
      .toBe("restore me\n");

    const session = store.createProviderSession({
      runId: run.id,
      provider: "openai-codex",
      adapterVersion: "fixture",
      runtimeVersion: "fixture",
      protocolVersion: "app-server-v2",
      mode: "hosted-observed",
      capabilities: { workspaceIsolation: { state: "supported", source: "fixture", version: "1" } }
    }).session;
    store.recordProviderEvent({
      sessionId: session.id,
      method: "thread/started",
      raw: { method: "thread/started" },
      parseStatus: "mapped",
      normalizedEvent: {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: "018f5e2a-1b2c-7d4e-8f90-123456789a81",
        runId: run.id,
        idempotencyKey: "hosted-workspace-provider-event",
        occurredAt: "2026-09-05T07:30:00.000Z",
        actor: { type: "agent", id: "codex-app-server" },
        eventType: "agent.session_started",
        status: "success",
        payload: {}
      }
    });
    expect(store.getRunCoverage(run.id)).toMatchObject({
      coverageLevel: "L1",
      summary: { workspaceEvidence: "pending" }
    });

    manager.activate(prepared.workspace.id);
    writeFileSync(join(prepared.workspace.worktreePath, "dependency.json"), "{\"engine\":\"compatible\"}\n");
    writeFileSync(join(prepared.workspace.worktreePath, "TEST_RESULT.txt"), "passed\n");
    const finalized = manager.finalize(prepared.workspace.id);

    expect(finalized.sourceUnchanged).toBe(true);
    expect(finalized.workspace).toMatchObject({
      status: "finalized",
      changedPaths: ["TEST_RESULT.txt", "dependency.json"]
    });
    expect(finalized.workspace.diffBlobHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getRunCoverage(run.id)).toMatchObject({
      coverageLevel: "L2",
      summary: { workspaceEvidence: "verified" }
    });
    expect(readFileSync(join(source, "dependency.json"))).toEqual(sourceDependencyBefore);
    expect(store.listEvents(run.id).map((event) => event.eventType)).toEqual([
      "run.created",
      "checkpoint.created",
      "artifact.created",
      "agent.session_started",
      "file.diff_created"
    ]);

    const cleaned = manager.cleanup(prepared.workspace.id);
    expect(cleaned.status).toBe("cleaned");
    expect(existsSync(prepared.workspace.worktreePath)).toBe(false);
    expect(store.getBlob(finalized.workspace.diffBlobHash ?? "")?.content.toString("utf8"))
      .toContain("compatible");
    store.close();
  });

  it("disables repository hooks while creating a Hosted worktree", async () => {
    const source = await temporaryDirectory("afr-hosted-hook-source-");
    const markerRoot = await temporaryDirectory("afr-hosted-hook-marker-");
    const marker = join(markerRoot, "post-checkout-ran");
    git(source, "init", "-q");
    git(source, "config", "user.email", "afr@example.invalid");
    git(source, "config", "user.name", "AFR Test");
    writeFileSync(join(source, "safe.txt"), "safe\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "fixture");
    mkdirSync(join(source, ".git", "hooks"), { recursive: true });
    const hook = join(source, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\nprintf compromised > '${marker}'\n`);
    chmodSync(hook, 0o755);

    const dataDir = await temporaryDirectory("afr-hosted-hook-data-");
    const store = new LocalStore(dataDir);
    const run = store.createRun({ projectPath: source, task: "inspect safely", agentId: "codex-app-server" });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const manager = new HostedWorkspaceManager(store);
    const prepared = manager.prepare({ runId: run.id });

    expect(prepared.workspace.status).toBe("ready");
    expect(existsSync(marker)).toBe(false);
    manager.finalize(prepared.workspace.id);
    manager.cleanup(prepared.workspace.id);
    store.close();
  });

  it("fails closed when Hosted workspace output exceeds its file quota", async () => {
    const source = await temporaryDirectory("afr-hosted-quota-source-");
    git(source, "init", "-q");
    git(source, "config", "user.email", "afr@example.invalid");
    git(source, "config", "user.name", "AFR Test");
    writeFileSync(join(source, "safe.txt"), "safe\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "fixture");

    const dataDir = await temporaryDirectory("afr-hosted-quota-data-");
    const store = new LocalStore(dataDir);
    const run = store.createRun({ projectPath: source, task: "write too much", agentId: "codex-app-server" });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const manager = new HostedWorkspaceManager(store, () => new Date(), {
      maxFileBytes: 8,
      maxTotalBytes: 32,
      maxFiles: 10,
      maxDiffBytes: 32
    });
    const prepared = manager.prepare({ runId: run.id });
    manager.activate(prepared.workspace.id);
    writeFileSync(join(prepared.workspace.worktreePath, "oversized.txt"), "0123456789");

    expect(() => manager.finalize(prepared.workspace.id)).toThrowError(
      expect.objectContaining({ code: "workspace_limit_exceeded" })
    );
    expect(store.getHostedWorkspace(prepared.workspace.id)).toMatchObject({
      status: "failed",
      lastErrorCode: "workspace_limit_exceeded"
    });
    expect(existsSync(join(source, "oversized.txt"))).toBe(false);
    manager.cleanup(prepared.workspace.id);
    store.close();
  });

  it("marks and cleans an incomplete worktree after restart", async () => {
    const source = await temporaryDirectory("afr-hosted-recovery-source-");
    git(source, "init", "-q");
    git(source, "config", "user.email", "afr@example.invalid");
    git(source, "config", "user.name", "AFR Test");
    writeFileSync(join(source, "safe.txt"), "safe\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "fixture");

    const dataDir = await temporaryDirectory("afr-hosted-recovery-data-");
    const firstStore = new LocalStore(dataDir);
    const run = firstStore.createRun({ projectPath: source, task: "crash during setup", agentId: "codex-app-server" });
    firstStore.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const prepared = new HostedWorkspaceManager(firstStore).prepare({ runId: run.id });
    firstStore.close();

    const secondStore = new LocalStore(dataDir);
    const report = new HostedWorkspaceManager(secondStore).recoverIncomplete();

    expect(report).toEqual({
      incompleteWorkspaces: 1,
      cleanedWorkspaces: 1,
      cleanupFailures: 0
    });
    expect(secondStore.getHostedWorkspace(prepared.workspace.id)).toMatchObject({
      status: "cleaned"
    });
    expect(secondStore.getRun(run.id)?.status).toBe("failed");
    expect(secondStore.listEvents(run.id)).toContainEqual(expect.objectContaining({
      eventType: "collection.gap_detected",
      payload: expect.objectContaining({ reason: "host_restarted_during_workspace_setup" })
    }));
    expect(existsSync(prepared.workspace.worktreePath)).toBe(false);
    secondStore.close();
  });
});
