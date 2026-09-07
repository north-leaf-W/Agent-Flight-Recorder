import type { EventEnvelope } from "@afr/protocol";
import { describe, expect, it } from "vitest";

import { deriveRunInsights, deriveSteps } from "./steps.js";

const RUN_ID = "018f5e2a-1b2c-7d4e-8f90-123456789abd";

function event(
  sequenceNo: number,
  eventType: EventEnvelope["eventType"],
  status: EventEnvelope["status"],
  payload: Record<string, unknown> = {}
): EventEnvelope {
  return {
    schemaVersion: "1.0-draft",
    eventId: `018f5e2a-1b2c-7d4e-8f90-${String(sequenceNo).padStart(12, "0")}`,
    runId: RUN_ID,
    sequenceNo,
    occurredAt: `2026-09-03T06:00:0${sequenceNo}Z`,
    recordedAt: `2026-09-03T06:00:0${sequenceNo}Z`,
    actor: { type: "tool", id: "fixture" },
    eventType,
    status,
    payload,
    contentHash: String(sequenceNo).padStart(64, "0")
  };
}

describe("Step aggregation", () => {
  it("groups a command, collection gap, result and related file changes", () => {
    const events = [
      event(1, "run.created", "success"),
      event(2, "shell.command_requested", "pending", { argv: ["node", "fix.mjs"] }),
      event(3, "collection.gap_detected", "unknown"),
      event(4, "shell.command_completed", "success"),
      event(5, "file.modified", "success", { path: "calculator.js" }),
      event(6, "run.status_changed", "success")
    ];

    const steps = deriveSteps(events);
    expect(steps).toHaveLength(3);
    expect(steps[1]).toMatchObject({
      type: "command",
      title: "node fix.mjs",
      status: "success",
      sequenceStart: 2,
      sequenceEnd: 5,
      eventIds: events.slice(1, 5).map((item) => item.eventId)
    });
  });

  it("marks the first failed command ahead of a collection gap", () => {
    const events = [
      event(1, "collection.gap_detected", "unknown"),
      event(2, "shell.command_requested", "pending", { argv: ["npm", "test"] }),
      event(3, "shell.command_completed", "error", { exitCode: 1 })
    ];

    expect(deriveRunInsights(events)).toMatchObject({
      eventCount: 3,
      commandCount: 1,
      gapCount: 1,
      coverageLevel: "L1",
      firstAnomaly: {
        sequenceNo: 3,
        classification: "tool_failure",
        eventType: "shell.command_completed"
      }
    });
  });
});
