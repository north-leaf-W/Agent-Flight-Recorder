import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EVENT_SCHEMA_VERSION, type EventStatus, type EventType, type IncomingEvent } from "@afr/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import {
  LocalStore,
  compareRuns,
  createRunCreatedEvent,
  createRunJsonExport
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function dataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "afr-artifacts-test-"));
  directories.push(path);
  return path;
}

function event(
  runId: string,
  eventType: EventType,
  status: EventStatus,
  payload: Record<string, unknown>
): IncomingEvent {
  const eventId = uuidv7();
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    runId,
    idempotencyKey: `test:${eventId}`,
    occurredAt: new Date().toISOString(),
    actor: { type: "tool", id: "fixture", model: "fixture-model" },
    eventType,
    status,
    payload
  };
}

describe("Run comparison and JSON export", () => {
  it("compares status, commands, files, failures, and replay truthfulness", async () => {
    const store = new LocalStore(await dataDir());
    const source = store.createRun({ projectPath: "/tmp/source", task: "bad", agentId: "fixture" });
    const [forkEvent] = store.appendEvents(source.id, [createRunCreatedEvent(source)]);
    store.transitionRun(source.id, "running");
    store.appendEvents(source.id, [
      event(source.id, "shell.command_completed", "error", {
        argv: ["node", "test.mjs", "wrong"], exitCode: 1, promptVersion: "v1"
      }),
      event(source.id, "file.modified", "success", { path: "dependency.txt" })
    ]);
    store.transitionRun(source.id, "failed");

    const target = store.createRun({
      parentRunId: source.id,
      forkedFromEventId: forkEvent?.eventId,
      projectPath: "/tmp/worktree",
      task: "fixed",
      agentId: "replay"
    });
    store.appendEvents(target.id, [createRunCreatedEvent(target)]);
    store.transitionRun(target.id, "running");
    store.appendEvents(target.id, [
      event(target.id, "shell.command_completed", "success", {
        argv: ["node", "test.mjs", "correct"], exitCode: 0, simulated: false, promptVersion: "v2"
      }),
      event(target.id, "file.diff_created", "success", {
        changedPaths: ["dependency.txt", "result.txt"]
      })
    ]);
    store.transitionRun(target.id, "completed");

    const comparison = compareRuns(store, source.id, target.id);
    expect(comparison).toMatchObject({
      source: {
        status: "failed",
        toolCallCount: 1,
        changedFiles: ["dependency.txt"],
        firstFailure: { eventType: "shell.command_completed", classification: "tool_failure" }
      },
      target: {
        status: "completed",
        toolCallCount: 1,
        changedFiles: ["dependency.txt", "result.txt"],
        liveActionCount: 1
      },
      delta: {
        statusChanged: true,
        filesOnlyInTarget: ["result.txt"],
        filesInBoth: ["dependency.txt"],
        testOutcomeChanged: true
      }
    });
    store.close();
  });

  it("exports an open, hash-verified JSON document and performs a final secret scan", async () => {
    const directory = await dataDir();
    const store = new LocalStore(directory);
    const rawToken = "sk-1234567890abcdefghijkl";
    const run = store.createRun({
      projectPath: "/tmp/demo",
      task: `inspect ${rawToken}`,
      agentId: "fixture"
    });
    store.appendEvents(run.id, [
      createRunCreatedEvent(run),
      event(run.id, "model.request", "success", { prompt: `TOKEN=${rawToken}` })
    ]);

    const exported = createRunJsonExport(store, run.id, "2026-09-03T09:00:00Z");
    const serialized = JSON.stringify(exported);
    expect(JSON.parse(serialized)).toMatchObject({
      format: "afr-run-json",
      formatVersion: "1.0",
      verification: { hashChainValid: true, eventCount: 2, exportHash: expect.any(String) }
    });
    expect(serialized).not.toContain(rawToken);
    expect(exported.run.task).toContain("[REDACTED]");
    store.close();

    const sqlite = await readFile(join(directory, "afr.sqlite"));
    expect(sqlite.includes(Buffer.from(rawToken))).toBe(false);
  });
});
