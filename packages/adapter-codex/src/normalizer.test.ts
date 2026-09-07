import { describe, expect, it } from "vitest";

import { CodexJsonlNormalizer } from "./normalizer.js";

const RUN_ID = "018f5e2a-1b2c-7d4e-8f90-123456789abd";

describe("CodexJsonlNormalizer", () => {
  it("maps a Codex thread, turn, command and response into AFR events", () => {
    const normalizer = new CodexJsonlNormalizer({
      runId: RUN_ID,
      runtimeVersion: "codex-cli test",
      now: () => new Date("2026-09-05T01:00:00Z")
    });
    const events = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "item-command",
          type: "command_execution",
          command: "node --test",
          status: "in_progress"
        }
      },
      {
        type: "item.completed",
        item: {
          id: "item-command",
          type: "command_execution",
          command: "node --test",
          status: "completed",
          exit_code: 0,
          aggregated_output: "ok"
        }
      },
      {
        type: "item.completed",
        item: { id: "item-message", type: "agent_message", text: "Fixed the test." }
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    ].flatMap((event) => normalizer.normalizeLine(JSON.stringify(event)).events);

    expect(events.map((event) => event.eventType)).toEqual([
      "agent.session_started",
      "agent.turn_started",
      "shell.command_requested",
      "shell.command_completed",
      "model.response",
      "agent.turn_completed"
    ]);
    expect(events[3]?.parentEventId).toBe(events[2]?.eventId);
    expect(events[3]?.payload).toMatchObject({ exitCode: 0, providerItemId: "item-command" });
    expect(events[4]?.payload).toMatchObject({ contentStored: false, characterCount: 15 });
    expect(events[4]?.payload).not.toHaveProperty("text");
    expect(normalizer.state()).toMatchObject({
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
      terminalOutcome: "completed",
      lineCount: 6
    });
  });

  it("keeps model content only when explicitly enabled", () => {
    const normalizer = new CodexJsonlNormalizer({
      runId: RUN_ID,
      storeModelContent: true
    });
    const [event] = normalizer.normalizeLine(JSON.stringify({
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: "hello" }
    })).events;

    expect(event?.payload).toMatchObject({
      contentStored: true,
      text: { text: "hello", truncated: false, byteSize: 5 }
    });
  });

  it("turns malformed and unknown input into explicit collection gaps", () => {
    const normalizer = new CodexJsonlNormalizer({ runId: RUN_ID });
    const malformed = normalizer.normalizeLine("not-json");
    const unknown = normalizer.normalizeLine(JSON.stringify({ type: "future.event", value: 1 }));
    const unknownItem = normalizer.normalizeLine(JSON.stringify({
      type: "item.completed",
      item: { id: "future-item", type: "future_item" }
    }));

    expect(malformed.events[0]?.eventType).toBe("collection.gap_detected");
    expect(malformed.events[0]?.payload.reason).toBe("invalid_jsonl");
    expect(unknown.events[0]?.payload).toMatchObject({
      reason: "unknown_provider_event",
      providerType: "future.event"
    });
    expect(unknownItem.events[0]?.payload).toMatchObject({
      reason: "unknown_provider_item",
      providerItemType: "future_item"
    });
  });

  it("maps MCP and web search items as tool calls", () => {
    const normalizer = new CodexJsonlNormalizer({ runId: RUN_ID });
    const requested = normalizer.normalizeLine(JSON.stringify({
      type: "item.started",
      item: { id: "tool-1", type: "mcp_tool_call", tool: "search", arguments: { q: "AFR" } }
    })).events[0];
    const completed = normalizer.normalizeLine(JSON.stringify({
      type: "item.completed",
      item: { id: "tool-1", type: "mcp_tool_call", tool: "search", status: "completed", result: "ok" }
    })).events[0];

    expect(requested?.eventType).toBe("tool.call_requested");
    expect(completed?.eventType).toBe("tool.call_completed");
    expect(completed?.parentEventId).toBe(requested?.eventId);
  });
});
