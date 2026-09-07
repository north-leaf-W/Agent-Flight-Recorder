import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EVENT_SCHEMA_VERSION, type IncomingEvent } from "@afr/protocol";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  BlobIntegrityError,
  EventValidationError,
  IdempotencyConflictError,
  LocalStore,
  MissingBlobError,
  RunTransitionError,
  createRunCreatedEvent
} from "./index.js";

const temporaryDirectories: string[] = [];

async function temporaryDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "afr-core-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function fileEvent(runId: string, id: string, key: string, blobRef?: string): IncomingEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: id,
    runId,
    idempotencyKey: key,
    occurredAt: "2026-09-03T06:00:00Z",
    actor: { type: "tool", id: "file.write" },
    eventType: "file.modified",
    status: "success",
    payload: { path: "src/example.ts" },
    ...(blobRef === undefined ? {} : { blobRefs: [blobRef] })
  };
}

function commandCompletedEvent(
  runId: string,
  id: string,
  key: string,
  status: "success" | "error"
): IncomingEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: id,
    runId,
    idempotencyKey: key,
    occurredAt: "2026-09-03T06:00:00Z",
    actor: { type: "tool", id: "shell" },
    eventType: "shell.command_completed",
    status,
    payload: { argv: ["node", "--test"], exitCode: status === "success" ? 0 : 1 }
  };
}

describe("LocalStore", () => {
  it("uses the latest command result for completed Run validation", async () => {
    const dataDir = await temporaryDataDir();
    const store = new LocalStore(dataDir);
    const run = store.createRun({
      projectPath: "/tmp/demo-project",
      task: "Fix a failing test",
      agentId: "codex-cli"
    });
    store.transitionRun(run.id, "running");
    store.appendEvents(run.id, [
      commandCompletedEvent(run.id, "018f5e2a-1b2c-7d4e-8f90-123456789ab1", "command-1", "error"),
      commandCompletedEvent(run.id, "018f5e2a-1b2c-7d4e-8f90-123456789ab2", "command-2", "success")
    ]);
    store.transitionRun(run.id, "completed");

    expect(store.listRunSummaries()[0]?.validationStatus).toBe("passed");
    store.close();
  });

  it("uses WAL and creates a private data directory", async () => {
    const dataDir = await temporaryDataDir();
    const store = new LocalStore(dataDir);

    expect(store.journalMode()).toBe("wal");
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    store.close();
  });

  it("backs up an existing database before applying pending migrations", async () => {
    const dataDir = await temporaryDataDir();
    const databasePath = join(dataDir, "afr.sqlite");
    const initialMigrationPath = fileURLToPath(new URL("../migrations/0001_initial.sql", import.meta.url));
    const initialMigration = readFileSync(initialMigrationPath, "utf8");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      );
    `);
    database.exec(initialMigration);
    database.prepare(
      "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)"
    ).run(
      "0001_initial",
      "2026-09-03T00:00:00.000Z",
      createHash("sha256").update(initialMigration).digest("hex")
    );
    database.close();

    const store = new LocalStore(dataDir, () => new Date("2026-09-03T09:00:00.000Z"));
    expect(store.migrationReport).toMatchObject({
      schemaVersion: "0009_network_mediation",
      appliedMigrations: [
        "0002_approvals",
        "0003_gateway",
        "0004_replay",
        "0005_provider_sessions",
        "0006_hosted_workspaces_provider_events",
        "0007_provider_action_requests",
        "0008_patch_promotions",
        "0009_network_mediation"
      ]
    });
    expect(store.migrationReport.backupPath).toBeDefined();
    expect(existsSync(store.migrationReport.backupPath as string)).toBe(true);

    const backup = new Database(store.migrationReport.backupPath as string, { readonly: true });
    const oldTables = backup.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    expect(oldTables.map(({ name }) => name)).not.toContain("approvals");
    backup.close();
    store.close();
  });

  it("persists a Run and verifiable event hash chain across restart", async () => {
    const dataDir = await temporaryDataDir();
    let store = new LocalStore(dataDir, () => new Date("2026-09-03T06:00:01Z"));
    const run = store.createRun({
      projectPath: "/tmp/demo-project",
      task: "Fix divide by zero",
      agentId: "fixture-agent"
    });
    const first = createRunCreatedEvent(run);
    const second = fileEvent(
      run.id,
      "018f5e2a-1b2c-7d4e-8f90-123456789abe",
      "file-change-1"
    );
    const appended = store.appendEvents(run.id, [first, second]);

    expect(appended.map((event) => event.sequenceNo)).toEqual([1, 2]);
    expect(appended[1]?.previousEventHash).toBe(appended[0]?.contentHash);
    expect(store.verifyRunChain(run.id)).toBe(true);
    store.close();

    store = new LocalStore(dataDir, () => new Date("2026-09-03T06:00:02Z"));
    expect(store.getRun(run.id)?.lastSequenceNo).toBe(2);
    expect(store.listEvents(run.id)).toEqual(appended);
    expect(store.recover()).toEqual({
      quickCheck: "ok",
      removedTemporaryBlobs: 0,
      verifiedRuns: 1,
      interruptedProviderSessions: 0
    });
    store.close();
  });

  it("fails recovery when persisted event evidence was tampered with", async () => {
    const dataDir = await temporaryDataDir();
    const databasePath = join(dataDir, "afr.sqlite");
    let store = new LocalStore(dataDir);
    const run = store.createRun({ projectPath: "/tmp/demo", task: "demo", agentId: "fixture" });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    store.close();

    const database = new Database(databasePath);
    database.exec("DROP TRIGGER events_prevent_update");
    const persisted = database.prepare("SELECT envelope_json FROM events WHERE run_id = ?").get(run.id) as {
      envelope_json: string;
    };
    const envelope = JSON.parse(persisted.envelope_json) as Record<string, unknown>;
    envelope.contentHash = "0".repeat(64);
    database.prepare("UPDATE events SET envelope_json = ? WHERE run_id = ?").run(
      JSON.stringify(envelope),
      run.id
    );
    database.close();

    store = new LocalStore(dataDir);
    expect(() => store.recover()).toThrow(`Event hash chain verification failed: ${run.id}`);
    store.close();
  });

  it("deduplicates an identical idempotent retry", async () => {
    const store = new LocalStore(await temporaryDataDir());
    const run = store.createRun({ projectPath: "/tmp/demo", task: "demo", agentId: "fixture" });
    const event = createRunCreatedEvent(run);

    const first = store.appendEvents(run.id, [event]);
    const retried = store.appendEvents(run.id, [event]);

    expect(retried).toEqual(first);
    expect(store.listEvents(run.id)).toHaveLength(1);
    store.close();
  });

  it("reads events incrementally after a known sequence", async () => {
    const store = new LocalStore(await temporaryDataDir());
    const run = store.createRun({ projectPath: "/tmp/demo", task: "demo", agentId: "fixture" });
    const first = createRunCreatedEvent(run);
    const second = fileEvent(
      run.id,
      "018f5e2a-1b2c-7d4e-8f90-123456789abe",
      "file-incremental"
    );
    store.appendEvents(run.id, [first, second]);

    expect(store.listEvents(run.id, 1).map((event) => event.sequenceNo)).toEqual([2]);
    expect(store.listEvents(run.id, 2)).toEqual([]);
    store.close();
  });

  it("rejects reuse of an idempotency key with different content", async () => {
    const store = new LocalStore(await temporaryDataDir());
    const run = store.createRun({ projectPath: "/tmp/demo", task: "demo", agentId: "fixture" });
    const event = createRunCreatedEvent(run);
    store.appendEvents(run.id, [event]);

    expect(() =>
      store.appendEvents(run.id, [{ ...event, payload: { changed: true } }])
    ).toThrow(IdempotencyConflictError);
    expect(store.listEvents(run.id)).toHaveLength(1);
    store.close();
  });

  it("rolls back a whole batch when a Blob reference is missing", async () => {
    const store = new LocalStore(await temporaryDataDir());
    const run = store.createRun({ projectPath: "/tmp/demo", task: "demo", agentId: "fixture" });
    const valid = createRunCreatedEvent(run);
    const missingHash = "b".repeat(64);
    const invalid = fileEvent(
      run.id,
      "018f5e2a-1b2c-7d4e-8f90-123456789abf",
      "file-change-missing-blob",
      `sha256:${missingHash}`
    );

    expect(() => store.appendEvents(run.id, [valid, invalid])).toThrow(MissingBlobError);
    expect(store.listEvents(run.id)).toEqual([]);
    expect(store.getRun(run.id)?.lastSequenceNo).toBe(0);
    store.close();
  });

  it("deduplicates repeated references to the same Blob within one event", async () => {
    const store = new LocalStore(await temporaryDataDir());
    const run = store.createRun({ projectPath: "/tmp/demo", task: "demo", agentId: "fixture" });
    const blob = store.putBlob(Buffer.from("shared output"), "text/plain");
    const event = fileEvent(
      run.id,
      "018f5e2a-1b2c-7d4e-8f90-123456789abf",
      "duplicate-blob-ref",
      `sha256:${blob.hash}`
    );
    event.blobRefs = [`sha256:${blob.hash}`, `sha256:${blob.hash}`];

    expect(store.appendEvents(run.id, [event])).toHaveLength(1);
    expect(store.listEvents(run.id)[0]?.blobRefs).toHaveLength(2);
    store.close();
  });

  it("rejects invalid events before writing", async () => {
    const store = new LocalStore(await temporaryDataDir());
    const run = store.createRun({ projectPath: "/tmp/demo", task: "demo", agentId: "fixture" });
    const invalid = { ...createRunCreatedEvent(run), eventId: "evt_invalid" };

    expect(() => store.appendEvents(run.id, [invalid])).toThrow(EventValidationError);
    expect(store.listEvents(run.id)).toEqual([]);
    store.close();
  });

  it("records Run transitions and refuses to reopen a terminal Run", async () => {
    const store = new LocalStore(await temporaryDataDir());
    const run = store.createRun({ projectPath: "/tmp/demo", task: "demo", agentId: "fixture" });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);

    expect(store.transitionRun(run.id, "running").status).toBe("running");
    expect(store.transitionRun(run.id, "completed").status).toBe("completed");
    expect(() => store.transitionRun(run.id, "running")).toThrow(RunTransitionError);
    expect(store.listEvents(run.id).map((event) => event.eventType)).toEqual([
      "run.created",
      "run.status_changed",
      "run.status_changed"
    ]);
    store.close();
  });

  it("persists Provider sessions, hashes per-Run tokens, and interrupts active hosts on recovery", async () => {
    const dataDir = await temporaryDataDir();
    let store = new LocalStore(dataDir, () => new Date("2026-09-05T06:00:00.000Z"));
    const run = store.createRun({
      projectPath: "/tmp/demo",
      task: "host Codex",
      agentId: "codex-app-server"
    });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    store.transitionRun(run.id, "running");
    const issued = store.createProviderSession({
      runId: run.id,
      provider: "openai-codex",
      adapterVersion: "0.1.0-demo.0",
      runtimeVersion: "codex-cli fixture",
      protocolVersion: "app-server-v2",
      mode: "hosted-observed",
      capabilities: {
        eventStream: { state: "supported", source: "local-schema", version: "fixture" },
        approvalBridge: { state: "degraded", source: "runtime-probe", version: "fixture" }
      }
    });

    expect(store.verifyProviderSessionControlToken(issued.session.id, issued.controlToken)).toBe(true);
    expect(store.verifyProviderSessionControlToken(issued.session.id, `${issued.controlToken}-wrong`)).toBe(false);
    store.transitionProviderSession({
      sessionId: issued.session.id,
      status: "starting",
      processId: 1234
    });
    const running = store.transitionProviderSession({
      sessionId: issued.session.id,
      status: "running",
      externalSessionId: "thread-fixture"
    });
    const pendingRequest = store.createProviderActionRequest({
      sessionId: issued.session.id,
      rpcId: "rpc-recovery",
      method: "item/commandExecution/requestApproval",
      request: { id: "rpc-recovery", method: "item/commandExecution/requestApproval" },
      status: "evaluating"
    });
    expect(running).toMatchObject({
      runId: run.id,
      status: "running",
      processId: 1234,
      externalSessionId: "thread-fixture"
    });
    store.close();

    store = new LocalStore(dataDir, () => new Date("2026-09-05T06:01:00.000Z"));
    expect(store.recover()).toMatchObject({ interruptedProviderSessions: 1 });
    expect(store.getLatestProviderSession(run.id)).toMatchObject({
      id: issued.session.id,
      status: "interrupted",
      lastErrorCode: "host_restarted"
    });
    expect(store.getProviderActionRequest(pendingRequest.id)).toMatchObject({
      status: "rejected",
      decisionReason: "AFR restarted before the Provider request received a response"
    });
    expect(store.getRun(run.id)?.status).toBe("interrupted");
    expect(store.verifyProviderSessionControlToken(issued.session.id, issued.controlToken)).toBe(true);
    store.close();

    const persisted = Buffer.concat(await readAllFiles(dataDir));
    expect(persisted.includes(Buffer.from(issued.controlToken))).toBe(false);
  });

  it("persists ordered and redacted network mediation evidence", async () => {
    const dataDir = await temporaryDataDir();
    const store = new LocalStore(dataDir, () => new Date("2026-09-05T07:00:00.000Z"));
    const run = store.createRun({
      projectPath: "/tmp/demo",
      task: "deny tool network access",
      agentId: "codex-app-server"
    });
    const issued = store.createProviderSession({
      runId: run.id,
      provider: "openai-codex",
      adapterVersion: "0.1.0-demo.0",
      runtimeVersion: "fixture",
      protocolVersion: "app-server-v2",
      mode: "hosted-observed",
      capabilities: {
        networkMediation: { state: "degraded", source: "deny-all-fixture", version: "H8" }
      }
    });
    const first = store.recordNetworkMediation({
      sessionId: issued.session.id,
      source: "host",
      operation: "turn/start",
      decision: "sandbox-enforced",
      requestedPolicy: { type: "readOnly", networkAccess: false },
      effectivePolicy: { type: "readOnly", networkAccess: false },
      evidence: { authorization: "Bearer abcdefghijklmnop" }
    });
    const second = store.recordNetworkMediation({
      sessionId: issued.session.id,
      source: "provider",
      operation: "item/permissions/requestApproval",
      decision: "denied",
      evidence: { reason: "tool_network_is_disabled" }
    });

    expect([first.sequenceNo, second.sequenceNo]).toEqual([1, 2]);
    expect(store.listNetworkMediationRecords(issued.session.id)).toEqual([first, second]);
    expect(JSON.stringify(first.evidence)).toContain("[REDACTED]");
    expect(JSON.stringify(first.evidence)).not.toContain("abcdefghijklmnop");
    expect(store.listNetworkMediationRecords(issued.session.id, 1)).toEqual([second]);
    store.close();
  });

  it("persists ordered Provider evidence, redacts raw payloads, and computes coverage gaps", async () => {
    const dataDir = await temporaryDataDir();
    const store = new LocalStore(dataDir, () => new Date("2026-09-05T06:10:00.000Z"));
    const run = store.createRun({
      projectPath: "/tmp/demo",
      task: "capture Provider events",
      agentId: "codex-app-server"
    });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const issued = store.createProviderSession({
      runId: run.id,
      provider: "openai-codex",
      adapterVersion: "0.1.0-demo.0",
      runtimeVersion: "fixture",
      protocolVersion: "app-server-v2",
      mode: "hosted-observed",
      capabilities: {
        eventStream: { state: "supported", source: "fixture", version: "1" }
      }
    });
    const mapped = fileEvent(
      run.id,
      "018f5e2a-1b2c-7d4e-8f90-123456789aa1",
      "provider-event-mapped"
    );
    const first = store.recordProviderEvent({
      sessionId: issued.session.id,
      method: "item/completed",
      raw: {
        method: "item/completed",
        params: { item: { id: "item-1", token: "sk-1234567890abcdefghijkl" } }
      },
      parseStatus: "mapped",
      providerEventId: "item-1",
      providerItemId: "item-1",
      normalizedEvent: mapped,
      storeRaw: true
    });
    const gap: IncomingEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: "018f5e2a-1b2c-7d4e-8f90-123456789aa2",
      runId: run.id,
      idempotencyKey: "provider-event-gap",
      occurredAt: "2026-09-05T06:10:00.000Z",
      actor: { type: "system", id: "codex-app-server" },
      eventType: "collection.gap_detected",
      status: "error",
      payload: { reason: "unknown_provider_event" }
    };
    const second = store.recordProviderEvent({
      sessionId: issued.session.id,
      method: "future/event",
      raw: { method: "future/event", params: { value: 1 } },
      parseStatus: "gap",
      gapReason: "unknown_provider_event",
      normalizedEvent: gap
    });

    expect([first.arrivalSequence, second.arrivalSequence]).toEqual([1, 2]);
    expect(store.listProviderEvents(issued.session.id)).toEqual([first, second]);
    expect(store.getEvent(first.normalizedEventId ?? "")).toMatchObject({ eventType: "file.modified" });
    expect(store.getRunCoverage(run.id)).toMatchObject({
      providerEventCount: 2,
      normalizedEventCount: 2,
      gapCount: 1,
      unknownEventCount: 1,
      invalidEventCount: 0,
      coveragePercent: 50,
      coverageLevel: "L1"
    });
    const raw = store.getBlob(first.rawBlobHash ?? "")?.content.toString("utf8") ?? "";
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("sk-1234567890abcdefghijkl");
    store.close();
  });

  it("redacts secrets before they reach SQLite or the event chain", async () => {
    const dataDir = await temporaryDataDir();
    const rawToken = "sk-1234567890abcdefghijkl";
    const store = new LocalStore(dataDir);
    const run = store.createRun({
      projectPath: "/tmp/demo",
      task: `Inspect output from ${rawToken}`,
      agentId: "fixture"
    });
    const event = fileEvent(
      run.id,
      "018f5e2a-1b2c-7d4e-8f90-123456789abf",
      "redaction-event"
    );
    event.payload = {
      path: "output.txt",
      headers: { authorization: "Bearer abcdefghijklmnop" },
      output: `API_KEY=${rawToken}`
    };
    const [stored] = store.appendEvents(run.id, [event]);

    expect(store.getRun(run.id)?.task).toBe("Inspect output from [REDACTED]");
    expect(stored?.payload).toMatchObject({
      headers: { authorization: "[REDACTED]" },
      output: "API_KEY=[REDACTED]",
      _afrRedaction: { total: 2 }
    });
    store.close();

    const persisted = Buffer.concat(await readAllFiles(dataDir));
    expect(persisted.includes(Buffer.from(rawToken))).toBe(false);
    expect(persisted.includes(Buffer.from("abcdefghijklmnop"))).toBe(false);
  });
});

describe("BlobStore", () => {
  it("writes content atomically and deduplicates by SHA-256", async () => {
    const dataDir = await temporaryDataDir();
    const store = new LocalStore(dataDir);
    const first = store.putBlob(Buffer.from("test output"), "text/plain");
    const second = store.putBlob(Buffer.from("test output"), "text/plain");

    expect(first.alreadyExisted).toBe(false);
    expect(second).toMatchObject({
      hash: first.hash,
      alreadyExisted: true,
      redactionState: "scanned"
    });
    expect(store.blobs.read(first.hash).toString()).toBe("test output");
    store.close();
  });

  it("redacts textual Blob content before hashing and writing", async () => {
    const dataDir = await temporaryDataDir();
    const store = new LocalStore(dataDir);
    const rawToken = "sk-1234567890abcdefghijkl";
    const blob = store.putBlob(Buffer.from(`output=${rawToken}`), "text/plain");

    expect(blob.redactionState).toBe("redacted");
    expect(blob.redactionReport?.total).toBe(1);
    expect(store.blobs.read(blob.hash).toString()).toBe("output=[REDACTED]");
    store.close();
    const persisted = Buffer.concat(await readAllFiles(dataDir));
    expect(persisted.includes(Buffer.from(rawToken))).toBe(false);
  });

  it("detects corrupted content", async () => {
    const dataDir = await temporaryDataDir();
    const store = new LocalStore(dataDir);
    const blob = store.putBlob(Buffer.from("original"));
    const path = join(dataDir, blob.relativePath);
    writeFileSync(path, "tampered");

    expect(() => store.blobs.read(blob.hash)).toThrow(BlobIntegrityError);
    store.close();
  });

  it("cleans abandoned temporary Blob files during recovery", async () => {
    const dataDir = await temporaryDataDir();
    const store = new LocalStore(dataDir);
    const tempDir = join(dataDir, "runtime", "blob-tmp");
    mkdirSync(tempDir, { recursive: true });
    const abandoned = join(tempDir, "abandoned.tmp");
    writeFileSync(abandoned, "partial");

    expect(store.recover().removedTemporaryBlobs).toBe(1);
    expect(existsSync(abandoned)).toBe(false);
    store.close();
  });
});

async function readAllFiles(directory: string): Promise<Buffer[]> {
  const contents: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(...(await readAllFiles(path)));
    } else if (entry.isFile()) {
      contents.push(await readFile(path));
    }
  }
  return contents;
}
