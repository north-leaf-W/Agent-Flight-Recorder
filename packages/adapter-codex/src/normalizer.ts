import { createHash } from "node:crypto";

import {
  EVENT_SCHEMA_VERSION,
  type Actor,
  type EventStatus,
  type EventType,
  type IncomingEvent
} from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

export const CODEX_ADAPTER_VERSION = "0.1.0-demo.0";

export type CodexNormalizerOptions = {
  runId: string;
  runtimeVersion?: string;
  storeModelContent?: boolean;
  now?: () => Date;
  launch?: {
    sandbox: "read-only" | "workspace-write";
    ephemeral: boolean;
    model?: string;
  };
};

export type CodexNormalizationResult = {
  events: IncomingEvent[];
  providerThreadId?: string;
  providerTurnId?: string;
  gap: boolean;
};

export class CodexJsonlNormalizer {
  private readonly now: () => Date;
  private readonly storeModelContent: boolean;
  private readonly pendingItems = new Map<string, string>();
  private lineNumber = 0;
  private turnOrdinal = 0;
  private providerThreadId?: string;
  private providerTurnId?: string;
  private terminalOutcome: "completed" | "failed" | "unknown" = "unknown";

  constructor(private readonly options: CodexNormalizerOptions) {
    this.now = options.now ?? (() => new Date());
    this.storeModelContent = options.storeModelContent ?? false;
  }

  normalizeLine(line: string): CodexNormalizationResult {
    this.lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return this.result([]);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return this.result([
        this.gap("invalid_jsonl", {
          lineNumber: this.lineNumber,
          rawHash: sha256(trimmed),
          byteSize: Buffer.byteLength(trimmed)
        })
      ]);
    }

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return this.result([
        this.gap("invalid_event_shape", {
          lineNumber: this.lineNumber,
          rawHash: sha256(trimmed)
        })
      ]);
    }

    const rawHash = sha256(trimmed);
    return this.result(this.normalizeEvent(parsed, rawHash));
  }

  state(): {
    providerThreadId?: string;
    providerTurnId?: string;
    terminalOutcome: "completed" | "failed" | "unknown";
    lineCount: number;
  } {
    return {
      ...(this.providerThreadId === undefined ? {} : { providerThreadId: this.providerThreadId }),
      ...(this.providerTurnId === undefined ? {} : { providerTurnId: this.providerTurnId }),
      terminalOutcome: this.terminalOutcome,
      lineCount: this.lineNumber
    };
  }

  private normalizeEvent(event: Record<string, unknown>, rawHash: string): IncomingEvent[] {
    switch (event.type) {
      case "thread.started":
        return this.threadStarted(event, rawHash);
      case "turn.started":
        return this.turnStarted(event, rawHash);
      case "turn.completed":
        return this.turnCompleted(event, rawHash);
      case "turn.failed":
        return this.turnFailed(event, rawHash);
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.itemEvent(event.type, event, rawHash);
      case "error":
        this.terminalOutcome = "failed";
        return [
          this.createEvent(
            "system.warning",
            "error",
            {
              source: "codex-jsonl",
              code: stringField(event, "code") ?? "provider_error",
              message: boundedText(stringField(event, "message") ?? "Codex reported an error"),
              rawHash
            },
            `error:${rawHash}`,
            { type: "system", id: "codex-adapter", version: CODEX_ADAPTER_VERSION }
          )
        ];
      default:
        return [
          this.gap("unknown_provider_event", {
            providerType: event.type,
            lineNumber: this.lineNumber,
            rawHash,
            keys: Object.keys(event).sort()
          })
        ];
    }
  }

  private threadStarted(event: Record<string, unknown>, rawHash: string): IncomingEvent[] {
    const providerThreadId = stringField(event, "thread_id") ?? stringField(event, "threadId");
    if (providerThreadId === undefined) {
      return [this.gap("thread_id_missing", { rawHash, lineNumber: this.lineNumber })];
    }
    this.providerThreadId = providerThreadId;
    return [
      this.createEvent(
        "agent.session_started",
        "success",
        {
          provider: "codex",
          providerThreadId,
          adapterVersion: CODEX_ADAPTER_VERSION,
          ...(this.options.runtimeVersion === undefined
            ? {}
            : { runtimeVersion: this.options.runtimeVersion }),
          ...(this.options.launch === undefined ? {} : { launch: this.options.launch }),
          transport: "jsonl",
          rawHash
        },
        `thread:${providerThreadId}:started`,
        versionedActor("agent", "codex-cli", this.options.runtimeVersion)
      )
    ];
  }

  private turnStarted(event: Record<string, unknown>, rawHash: string): IncomingEvent[] {
    this.turnOrdinal += 1;
    this.providerTurnId =
      stringField(event, "turn_id") ?? stringField(event, "turnId") ?? `turn-${this.turnOrdinal}`;
    this.terminalOutcome = "unknown";
    return [
      this.createEvent(
        "agent.turn_started",
        "pending",
        {
          provider: "codex",
          providerThreadId: this.providerThreadId ?? null,
          providerTurnId: this.providerTurnId,
          turnOrdinal: this.turnOrdinal,
          rawHash
        },
        `turn:${this.providerThreadId ?? "unknown"}:${this.turnOrdinal}:started`,
        versionedActor("agent", "codex-cli", this.options.runtimeVersion)
      )
    ];
  }

  private turnCompleted(event: Record<string, unknown>, rawHash: string): IncomingEvent[] {
    this.terminalOutcome = "completed";
    return [
      this.createEvent(
        "agent.turn_completed",
        "success",
        {
          provider: "codex",
          providerThreadId: this.providerThreadId ?? null,
          providerTurnId: this.providerTurnId ?? null,
          turnOrdinal: this.turnOrdinal,
          ...(isRecord(event.usage) ? { usage: event.usage } : {}),
          rawHash
        },
        `turn:${this.providerThreadId ?? "unknown"}:${this.turnOrdinal}:completed`,
        versionedActor("agent", "codex-cli", this.options.runtimeVersion)
      )
    ];
  }

  private turnFailed(event: Record<string, unknown>, rawHash: string): IncomingEvent[] {
    this.terminalOutcome = "failed";
    return [
      this.createEvent(
        "agent.turn_failed",
        "error",
        {
          provider: "codex",
          providerThreadId: this.providerThreadId ?? null,
          providerTurnId: this.providerTurnId ?? null,
          turnOrdinal: this.turnOrdinal,
          error: safeError(event.error),
          rawHash
        },
        `turn:${this.providerThreadId ?? "unknown"}:${this.turnOrdinal}:failed`,
        versionedActor("agent", "codex-cli", this.options.runtimeVersion)
      )
    ];
  }

  private itemEvent(
    phase: "item.started" | "item.updated" | "item.completed",
    event: Record<string, unknown>,
    rawHash: string
  ): IncomingEvent[] {
    if (!isRecord(event.item)) {
      return [this.gap("item_missing", { providerType: phase, rawHash })];
    }
    const item = event.item;
    const itemType = stringField(item, "type") ?? "unknown";
    const itemId = stringField(item, "id") ?? `${itemType}-${this.lineNumber}`;
    const correlation = {
      provider: "codex",
      providerThreadId: this.providerThreadId ?? null,
      providerTurnId: this.providerTurnId ?? null,
      providerItemId: itemId,
      providerItemType: itemType,
      providerPhase: phase,
      rawHash
    };

    if (itemType === "command_execution") {
      return this.commandItem(phase, item, itemId, correlation);
    }
    if (["mcp_tool_call", "tool_call", "web_search"].includes(itemType)) {
      return this.toolItem(phase, item, itemId, correlation);
    }
    if (itemType === "agent_message") {
      if (phase !== "item.completed") return [];
      const text = stringField(item, "text") ?? "";
      return [
        this.createEvent(
          "model.response",
          statusForItem(item),
          {
            ...correlation,
            ...contentPayload(text, this.storeModelContent)
          },
          `item:${itemId}:message:completed`,
          { type: "model", id: "codex" }
        )
      ];
    }
    if (itemType === "file_change") {
      if (phase === "item.started") {
        return [
          this.createEvent(
            "file.write_requested",
            "pending",
            { ...correlation, paths: filePaths(item) },
            `item:${itemId}:file:requested`,
            { type: "tool", id: "codex-file" }
          )
        ];
      }
      if (phase !== "item.completed") return [];
      return [
        this.createEvent(
          "artifact.created",
          statusForItem(item),
          { ...correlation, kind: "provider_file_change_claim", paths: filePaths(item) },
          `item:${itemId}:file:completed`,
          { type: "tool", id: "codex-file" }
        )
      ];
    }
    if (["reasoning", "plan_update", "todo_list"].includes(itemType)) {
      if (phase !== "item.completed") return [];
      const text = stringField(item, "text") ?? stringField(item, "summary") ?? "";
      return [
        this.createEvent(
          "artifact.created",
          statusForItem(item),
          {
            ...correlation,
            kind: itemType === "reasoning" ? "reasoning_summary" : "plan_update",
            ...contentPayload(text, itemType !== "reasoning" && this.storeModelContent),
            ...(itemType === "todo_list" && Array.isArray(item.items)
              ? { itemCount: item.items.length }
              : {})
          },
          `item:${itemId}:${itemType}:completed`,
          versionedActor("agent", "codex-cli", this.options.runtimeVersion)
        )
      ];
    }

    return [
      this.gap("unknown_provider_item", {
        ...correlation,
        itemKeys: Object.keys(item).sort()
      })
    ];
  }

  private commandItem(
    phase: "item.started" | "item.updated" | "item.completed",
    item: Record<string, unknown>,
    itemId: string,
    correlation: Record<string, unknown>
  ): IncomingEvent[] {
    if (phase === "item.updated") return [];
    const command = stringField(item, "command");
    const argv = stringArrayField(item, "argv") ?? (command === undefined ? [] : [command]);
    if (phase === "item.started") {
      const event = this.createEvent(
        "shell.command_requested",
        "pending",
        {
          ...correlation,
          argv,
          ...(command === undefined ? {} : { command }),
          argvFidelity: stringArrayField(item, "argv") === undefined ? "provider-string" : "exact",
          ...(stringField(item, "cwd") === undefined ? {} : { cwd: stringField(item, "cwd") })
        },
        `item:${itemId}:command:started`,
        { type: "tool", id: "codex-shell" }
      );
      this.pendingItems.set(itemId, event.eventId);
      return [event];
    }

    const output = stringField(item, "aggregated_output") ?? stringField(item, "output") ?? "";
    return [
      this.createEvent(
        "shell.command_completed",
        statusForItem(item),
        {
          ...correlation,
          argv,
          ...(command === undefined ? {} : { command }),
          argvFidelity: stringArrayField(item, "argv") === undefined ? "provider-string" : "exact",
          ...(numberField(item, "exit_code") === undefined
            ? {}
            : { exitCode: numberField(item, "exit_code") }),
          output: boundedText(output)
        },
        `item:${itemId}:command:completed`,
        { type: "tool", id: "codex-shell" },
        this.pendingItems.get(itemId)
      )
    ];
  }

  private toolItem(
    phase: "item.started" | "item.updated" | "item.completed",
    item: Record<string, unknown>,
    itemId: string,
    correlation: Record<string, unknown>
  ): IncomingEvent[] {
    const tool = stringField(item, "tool") ?? stringField(item, "name") ?? stringField(item, "type") ?? "tool";
    const payload = {
      ...correlation,
      tool,
      ...(stringField(item, "server") === undefined ? {} : { server: stringField(item, "server") }),
      ...(stringField(item, "query") === undefined ? {} : { query: stringField(item, "query") }),
      ...(isRecord(item.arguments) || Array.isArray(item.arguments) || typeof item.arguments === "string"
        ? { arguments: item.arguments }
        : {}),
      ...(phase === "item.completed" && item.result !== undefined
        ? { result: boundedUnknown(item.result) }
        : {}),
      ...(item.error === undefined ? {} : { error: safeError(item.error) })
    };

    if (phase === "item.started") {
      const event = this.createEvent(
        "tool.call_requested",
        "pending",
        payload,
        `item:${itemId}:tool:requested`,
        { type: "tool", id: boundedIdentifier(tool) }
      );
      this.pendingItems.set(itemId, event.eventId);
      return [event];
    }
    if (phase === "item.updated") {
      return [
        this.createEvent(
          "tool.call_started",
          "pending",
          payload,
          `item:${itemId}:tool:started`,
          { type: "tool", id: boundedIdentifier(tool) },
          this.pendingItems.get(itemId)
        )
      ];
    }
    const failed = statusForItem(item) === "error";
    return [
      this.createEvent(
        failed ? "tool.call_failed" : "tool.call_completed",
        failed ? "error" : "success",
        payload,
        `item:${itemId}:tool:completed`,
        { type: "tool", id: boundedIdentifier(tool) },
        this.pendingItems.get(itemId)
      )
    ];
  }

  private gap(reason: string, payload: Record<string, unknown>): IncomingEvent {
    return this.createEvent(
      "collection.gap_detected",
      "unknown",
      { source: "codex-jsonl", reason, ...payload },
      `gap:${this.lineNumber}:${reason}:${String(payload.rawHash ?? "")}`,
      { type: "system", id: "codex-adapter", version: CODEX_ADAPTER_VERSION }
    );
  }

  private createEvent(
    eventType: EventType,
    status: EventStatus,
    payload: Record<string, unknown>,
    idempotencySource: string,
    actor: Actor,
    parentEventId?: string
  ): IncomingEvent {
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId: this.options.runId,
      idempotencyKey: `codex:${sha256(idempotencySource)}`,
      occurredAt: this.now().toISOString(),
      actor,
      eventType,
      status,
      payload,
      ...(parentEventId === undefined ? {} : { parentEventId })
    };
  }

  private result(events: IncomingEvent[]): CodexNormalizationResult {
    return {
      events,
      ...(this.providerThreadId === undefined ? {} : { providerThreadId: this.providerThreadId }),
      ...(this.providerTurnId === undefined ? {} : { providerTurnId: this.providerTurnId }),
      gap: events.some((event) => event.eventType === "collection.gap_detected")
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] | undefined {
  const candidate = value[key];
  return Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
    ? candidate
    : undefined;
}

function statusForItem(item: Record<string, unknown>): EventStatus {
  const status = stringField(item, "status");
  const exitCode = numberField(item, "exit_code");
  return status === "failed" || status === "error" || item.error !== undefined ||
    (exitCode !== undefined && exitCode !== 0)
    ? "error"
    : "success";
}

function filePaths(item: Record<string, unknown>): string[] {
  const paths = stringArrayField(item, "paths");
  if (paths !== undefined) return paths;
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((change) => {
    if (!isRecord(change)) return [];
    const path = stringField(change, "path");
    return path === undefined ? [] : [path];
  });
}

function contentPayload(text: string, storeContent: boolean): Record<string, unknown> {
  return {
    contentStored: storeContent,
    textHash: sha256(text),
    characterCount: text.length,
    ...(storeContent ? { text: boundedText(text) } : {})
  };
}

function boundedText(value: string, limit = 8_192): { text: string; truncated: boolean; byteSize: number } {
  const byteSize = Buffer.byteLength(value);
  if (value.length <= limit) return { text: value, truncated: false, byteSize };
  const half = Math.floor(limit / 2);
  return {
    text: `${value.slice(0, half)}\n… output omitted by Codex adapter …\n${value.slice(-half)}`,
    truncated: true,
    byteSize
  };
}

function boundedUnknown(value: unknown): unknown {
  if (typeof value === "string") return boundedText(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= 8_192) return value;
  return {
    truncated: true,
    byteSize: Buffer.byteLength(serialized),
    contentHash: sha256(serialized)
  };
}

function safeError(value: unknown): unknown {
  if (typeof value === "string") return boundedText(value);
  if (!isRecord(value)) return value ?? null;
  return {
    ...(stringField(value, "code") === undefined ? {} : { code: stringField(value, "code") }),
    ...(stringField(value, "message") === undefined
      ? {}
      : { message: boundedText(stringField(value, "message") as string) })
  };
}

function boundedIdentifier(value: string): string {
  return value.length <= 255 ? value : `${value.slice(0, 190)}:${sha256(value).slice(0, 32)}`;
}

function versionedActor(type: Actor["type"], id: string, version?: string): Actor {
  return { type, id, ...(version === undefined ? {} : { version }) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
