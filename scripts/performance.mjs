import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { LocalStore } from "../packages/core/dist/index.js";
import { EVENT_SCHEMA_VERSION } from "../packages/protocol/dist/index.js";

const EVENT_TOTAL = 50_000;
const SINGLE_WRITE_SAMPLES = 200;
const BATCH_SIZE = 500;
const RUN_TOTAL = 200;
const thresholds = {
  singleWriteP95Ms: 50,
  eventsPerSecond: 20,
  runsListP95Ms: 1_000,
  timelineP95Ms: 2_000,
  coldStartMs: 5_000,
  residentMemoryMb: 500
};

const dataDir = mkdtempSync(join(tmpdir(), "afr-m4-performance-"));
let store;
let eventCounter = 0;

try {
  store = new LocalStore(dataDir);
  const longRun = store.createRun({
    projectPath: "/tmp/afr-performance-fixture",
    task: "M4 50k event performance baseline",
    agentId: "performance-fixture"
  });

  const singleWrites = [];
  for (let index = 0; index < SINGLE_WRITE_SAMPLES; index += 1) {
    const started = performance.now();
    store.appendEvents(longRun.id, [nextEvent(longRun.id)]);
    singleWrites.push(performance.now() - started);
  }

  const bulkStarted = performance.now();
  while (eventCounter < EVENT_TOTAL) {
    const batch = [];
    while (batch.length < BATCH_SIZE && eventCounter < EVENT_TOTAL) {
      batch.push(nextEvent(longRun.id));
    }
    store.appendEvents(longRun.id, batch);
  }
  const bulkDurationMs = performance.now() - bulkStarted;

  for (let index = 1; index < RUN_TOTAL; index += 1) {
    store.createRun({
      projectPath: `/tmp/afr-performance-fixture-${index}`,
      task: `Run list fixture ${index}`,
      agentId: "performance-fixture"
    });
  }

  const runListSamples = measure(20, () => store.listRunSummaries(RUN_TOTAL));
  const timelineSamples = measure(10, () => {
    const events = store.listEvents(longRun.id, 0, 10_000);
    if (events.length !== 10_000) throw new Error(`Expected 10000 events, received ${events.length}`);
  });

  store.close();
  store = undefined;
  const coldStarted = performance.now();
  store = new LocalStore(dataDir);
  const recovery = store.recover();
  const coldStartMs = performance.now() - coldStarted;
  const persistedEvents = store.listEvents(longRun.id, 0, EVENT_TOTAL).length;
  const residentMemoryMb = process.memoryUsage().rss / 1024 / 1024;

  const result = {
    eventTotal: EVENT_TOTAL,
    persistedEvents,
    verifiedRuns: recovery.verifiedRuns,
    singleWriteP95Ms: round(percentile(singleWrites, 0.95)),
    eventsPerSecond: round((EVENT_TOTAL - SINGLE_WRITE_SAMPLES) / (bulkDurationMs / 1_000)),
    runsListP95Ms: round(percentile(runListSamples, 0.95)),
    timelineP95Ms: round(percentile(timelineSamples, 0.95)),
    coldStartMs: round(coldStartMs),
    residentMemoryMb: round(residentMemoryMb)
  };
  process.stdout.write(`${JSON.stringify({ thresholds, result }, null, 2)}\n`);

  const failures = Object.entries(thresholds).filter(([name, maximum]) => {
    if (name === "eventsPerSecond") return result[name] < maximum;
    return result[name] > maximum;
  });
  if (persistedEvents !== EVENT_TOTAL) failures.push(["persistedEvents", EVENT_TOTAL]);
  if (failures.length > 0) {
    throw new Error(`Performance threshold failed: ${failures.map(([name]) => name).join(", ")}`);
  }
} finally {
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
}

function nextEvent(runId) {
  eventCounter += 1;
  const suffix = String(eventCounter).padStart(12, "0");
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: `00000000-0000-7000-8000-${suffix}`,
    runId,
    idempotencyKey: `performance:${eventCounter}`,
    occurredAt: "2026-09-03T12:00:00.000Z",
    actor: { type: "tool", id: "performance-fixture" },
    eventType: "tool.call_completed",
    status: "success",
    payload: { index: eventCounter, result: "ok" }
  };
}

function measure(count, operation) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    operation();
    values.push(performance.now() - started);
  }
  return values;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
