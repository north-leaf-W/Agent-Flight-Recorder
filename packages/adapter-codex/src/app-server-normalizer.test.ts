import { describe, expect, it } from "vitest";

import { CodexAppServerNormalizer } from "./app-server-normalizer.js";

const RUN_ID = "018f5e2a-1b2c-7d4e-8f90-123456789abd";

describe("CodexAppServerNormalizer", () => {
  it("maps App Server thread, turn, command, file, message, and terminal notifications", () => {
    const normalizer = new CodexAppServerNormalizer({
      runId: RUN_ID,
      runtimeVersion: "codex-cli fixture",
      now: () => new Date("2026-09-05T07:00:00.000Z")
    });
    const notifications = [
      { method: "thread/started", params: { thread: { id: "thread-1" } } },
      { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "command-1", type: "commandExecution", command: "node --test", status: "inProgress" }
        }
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "node --test",
            status: "completed",
            exitCode: 0,
            aggregatedOutput: "ok"
          }
        }
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "file-1", type: "fileChange", status: "completed", changes: [{ path: "a.ts" }] }
        }
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "message-1", type: "agentMessage", text: "done", status: "completed" }
        }
      },
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
      }
    ];
    const results = notifications.map((notification) => normalizer.normalize(notification));

    expect(results.map((result) => result.event?.eventType)).toEqual([
      "agent.session_started",
      "agent.turn_started",
      "shell.command_requested",
      "shell.command_completed",
      "artifact.created",
      "model.response",
      "agent.turn_completed"
    ]);
    expect(results[3]?.event?.parentEventId).toBe(results[2]?.event?.eventId);
    expect(results[3]?.event?.payload).toMatchObject({ exitCode: 0, providerItemId: "command-1" });
    expect(results[4]?.event?.payload).toMatchObject({ paths: ["a.ts"] });
    expect(results[5]?.event?.payload).toMatchObject({ contentStored: false, characterCount: 4 });
    expect(results[6]?.event?.status).toBe("success");
  });

  it("turns unknown and invalid notifications into explicit gaps and ignores known deltas", () => {
    const normalizer = new CodexAppServerNormalizer({ runId: RUN_ID });
    const unknown = normalizer.normalize({ method: "future/event", params: { value: 1 } });
    const invalid = normalizer.normalize({ method: "turn/completed", params: { turn: {} } });
    const ignored = normalizer.normalize({ method: "thread/tokenUsage/updated", params: {} });

    expect(unknown).toMatchObject({ parseStatus: "gap", gapReason: "unknown_provider_event" });
    expect(unknown.event?.eventType).toBe("collection.gap_detected");
    expect(invalid).toMatchObject({ parseStatus: "invalid", gapReason: "turn_id_missing" });
    expect(ignored).toEqual({ parseStatus: "ignored" });
  });

  it("maps a failed completed Turn to agent.turn_failed", () => {
    const normalizer = new CodexAppServerNormalizer({ runId: RUN_ID });
    normalizer.normalize({ method: "thread/started", params: { thread: { id: "thread-1" } } });
    normalizer.normalize({ method: "turn/started", params: { turn: { id: "turn-1" } } });
    const result = normalizer.normalize({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "failed", error: { message: "boom" } } }
    });

    expect(result.event).toMatchObject({ eventType: "agent.turn_failed", status: "error" });
  });

  it("maps the persisted user prompt to a model request without storing its content by default", () => {
    const normalizer = new CodexAppServerNormalizer({ runId: RUN_ID });
    expect(normalizer.normalize({
      method: "item/started",
      params: { item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "fix it" }] } }
    }).parseStatus).toBe("ignored");
    const completed = normalizer.normalize({
      method: "item/completed",
      params: { item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "fix it" }] } }
    });
    expect(completed.event).toMatchObject({
      eventType: "model.request",
      payload: { messageRole: "user", contentStored: false, characterCount: 6 }
    });
  });
});
