import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalStore, createRunCreatedEvent } from "@afr/core";
import { afterEach, describe, expect, it } from "vitest";

import { AppServerEventBridge } from "./app-server-event-bridge.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("AppServerEventBridge", () => {
  it("persists each raw notification in arrival order and links normalized AFR events", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "afr-app-server-bridge-"));
    directories.push(dataDir);
    const store = new LocalStore(dataDir, () => new Date("2026-09-05T07:10:00.000Z"));
    const run = store.createRun({ projectPath: "/tmp/demo", task: "host", agentId: "codex-app-server" });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const session = store.createProviderSession({
      runId: run.id,
      provider: "openai-codex",
      adapterVersion: "0.1.0-demo.0",
      runtimeVersion: "fixture",
      protocolVersion: "app-server-v2",
      mode: "hosted-observed",
      capabilities: { eventStream: { state: "supported", source: "fixture", version: "1" } }
    }).session;
    const bridge = new AppServerEventBridge(store, {
      runId: run.id,
      providerSessionId: session.id,
      runtimeVersion: "fixture",
      storeRaw: true
    });

    bridge.handle({ method: "thread/started", params: { thread: { id: "thread-1" } } });
    bridge.handle({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    bridge.handle({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1" } });
    bridge.handle({ method: "future/event", params: { secret: "sk-1234567890abcdefghijkl" } });

    const providerEvents = store.listProviderEvents(session.id);
    expect(providerEvents.map((event) => event.arrivalSequence)).toEqual([1, 2, 3, 4]);
    expect(providerEvents.map((event) => event.parseStatus)).toEqual([
      "mapped",
      "mapped",
      "ignored",
      "gap"
    ]);
    expect(store.listEvents(run.id).map((event) => event.eventType)).toEqual([
      "run.created",
      "agent.session_started",
      "agent.turn_started",
      "collection.gap_detected"
    ]);
    expect(store.getRunCoverage(run.id)).toMatchObject({
      providerEventCount: 4,
      normalizedEventCount: 3,
      ignoredEventCount: 1,
      gapCount: 1,
      coveragePercent: 75,
      coverageLevel: "L1"
    });
    const raw = store.getBlob(providerEvents[3]?.rawBlobHash ?? "")?.content.toString("utf8") ?? "";
    expect(raw).not.toContain("sk-1234567890abcdefghijkl");
    store.close();
  });
});
