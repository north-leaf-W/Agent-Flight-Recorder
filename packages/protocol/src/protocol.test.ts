import { describe, expect, it } from "vitest";

import {
  ERROR_CODES,
  EVENT_TYPES,
  EVENT_SCHEMA_VERSION,
  RUN_STATUSES,
  apiError,
  canTransitionRun,
  isTerminalRunStatus,
  validateActionContext,
  validateEventEnvelope,
  validateIncomingEvent
} from "./index.js";

const EVENT_ID = "018f5e2a-1b2c-7d4e-8f90-123456789abc";
const RUN_ID = "018f5e2a-1b2c-7d4e-8f90-123456789abd";
const HASH = "a".repeat(64);

function incomingEvent() {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: EVENT_ID,
    runId: RUN_ID,
    idempotencyKey: "adapter-event-42",
    occurredAt: "2026-09-03T02:00:00Z",
    actor: { type: "tool", id: "shell.exec", version: "1.0.0" },
    eventType: "shell.command_completed",
    status: "success",
    payload: {
      argv: ["pnpm", "test"],
      cwd: "/tmp/demo-project",
      exitCode: 0,
      durationMs: 8421
    }
  };
}

describe("IncomingEventSchema", () => {
  it("accepts a minimal valid adapter event", () => {
    expect(validateIncomingEvent(incomingEvent())).toEqual({
      ok: true,
      value: incomingEvent()
    });
  });

  it("rejects trusted fields supplied by a collector", () => {
    const event = { ...incomingEvent(), sequenceNo: 99, contentHash: HASH };
    const result = validateIncomingEvent(event);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("Unexpected property"))).toBe(true);
    }
  });

  it("rejects an unknown event type", () => {
    const result = validateIncomingEvent({
      ...incomingEvent(),
      eventType: "agent.claimed_success"
    });

    expect(result.ok).toBe(false);
  });

  it("declares Agent session and turn lifecycle events", () => {
    expect(EVENT_TYPES).toEqual(expect.arrayContaining([
      "agent.session_started",
      "agent.turn_started",
      "agent.turn_completed",
      "agent.turn_failed"
    ]));
  });

  it("requires UUIDv7 entity identifiers", () => {
    const result = validateIncomingEvent({ ...incomingEvent(), runId: "run_123" });
    expect(result.ok).toBe(false);
  });
});

describe("EventEnvelopeSchema", () => {
  it("accepts server-assigned sequence and hash-chain fields", () => {
    const envelope = {
      ...incomingEvent(),
      sequenceNo: 1,
      recordedAt: "2026-09-03T02:00:01.123Z",
      contentHash: HASH
    };

    expect(validateEventEnvelope(envelope)).toEqual({ ok: true, value: envelope });
  });

  it("rejects a malformed hash", () => {
    const result = validateEventEnvelope({
      ...incomingEvent(),
      sequenceNo: 1,
      recordedAt: "2026-09-03T02:00:01Z",
      contentHash: "not-a-sha256"
    });

    expect(result.ok).toBe(false);
  });
});

describe("Run state machine", () => {
  it("covers every declared run status", () => {
    for (const status of RUN_STATUSES) {
      expect(typeof isTerminalRunStatus(status)).toBe("boolean");
    }
  });

  it("allows approval pause and resume", () => {
    expect(canTransitionRun("running", "waiting_approval")).toBe(true);
    expect(canTransitionRun("waiting_approval", "running")).toBe(true);
  });

  it("allows interrupted work to resume but keeps terminal states immutable", () => {
    expect(canTransitionRun("interrupted", "running")).toBe(true);
    expect(canTransitionRun("completed", "running")).toBe(false);
    expect(canTransitionRun("failed", "completed")).toBe(false);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("interrupted")).toBe(false);
  });
});

describe("API errors", () => {
  it("uses the documented stable response shape", () => {
    expect(
      apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", "request-1", {
        runId: RUN_ID
      })
    ).toEqual({
      code: "run_not_found",
      message: "Run does not exist",
      requestId: "request-1",
      details: { runId: RUN_ID }
    });
  });
});

describe("ActionContextSchema", () => {
  it("accepts a fully scoped local file action", () => {
    expect(
      validateActionContext({
        runId: RUN_ID,
        actor: { id: "fixture-agent", type: "agent" },
        tool: "file.delete",
        action: "delete",
        cwd: "/tmp/demo",
        targets: [{ type: "file", canonicalId: "/tmp/demo/protected/important.txt" }],
        environment: "local",
        sideEffect: "irreversible",
        recoverability: "partial",
        estimatedImpact: { files: 1 }
      }).ok
    ).toBe(true);
  });

  it("rejects an unscoped action without targets", () => {
    const result = validateActionContext({
      runId: RUN_ID,
      actor: { id: "fixture-agent", type: "agent" },
      tool: "file.delete",
      action: "delete",
      environment: "local",
      sideEffect: "irreversible",
      recoverability: "none"
    });
    expect(result.ok).toBe(false);
  });
});
