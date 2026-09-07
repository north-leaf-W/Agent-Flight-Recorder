import { createHash } from "node:crypto";

import {
  EVENT_SCHEMA_VERSION,
  type EventStatus,
  type EventType,
  type IncomingEvent
} from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import { CODEX_ADAPTER_VERSION } from "./normalizer.js";
import type { AppServerNotification } from "./app-server-supervisor.js";

export type AppServerNormalization = {
  parseStatus: "mapped" | "ignored" | "gap" | "invalid";
  event?: IncomingEvent;
  providerEventId?: string | undefined;
  providerThreadId?: string | undefined;
  providerTurnId?: string | undefined;
  providerItemId?: string | undefined;
  gapReason?: string;
};

export type AppServerNormalizerOptions = {
  runId: string;
  runtimeVersion?: string;
  storeModelContent?: boolean;
  now?: () => Date;
};

const KNOWN_TRANSIENT_METHODS = new Set([
  "account/rateLimits/updated",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "mcpServer/startupStatus/updated",
  "remoteControl/status/changed",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
  "turn/plan/updated"
]);

export class CodexAppServerNormalizer {
  private readonly now: () => Date;
  private readonly pendingItems = new Map<string, string>();
  private providerThreadId?: string;
  private providerTurnId?: string;
  private turnOrdinal = 0;

  constructor(private readonly options: AppServerNormalizerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  normalize(notification: AppServerNotification): AppServerNormalization {
    if (notification.method.trim().length === 0) {
      return this.invalid(notification, "provider_method_missing");
    }
    if (KNOWN_TRANSIENT_METHODS.has(notification.method)) {
      return {
        parseStatus: "ignored",
        ...this.correlation(notification.params)
      };
    }
    switch (notification.method) {
      case "thread/started":
        return this.threadStarted(notification);
      case "turn/started":
        return this.turnStarted(notification);
      case "turn/completed":
        return this.turnCompleted(notification);
      case "item/started":
      case "item/completed":
        return this.itemLifecycle(notification);
      case "error":
        return this.mapped(
          notification,
          this.event("system.warning", "error", {
            source: "codex-app-server",
            code: "provider_error",
            error: safeValue(notification.params)
          })
        );
      default:
        return this.gap(notification, "unknown_provider_event", {
          providerMethod: notification.method
        });
    }
  }

  state(): { providerThreadId?: string; providerTurnId?: string; turnOrdinal: number } {
    return {
      turnOrdinal: this.turnOrdinal,
      ...(this.providerThreadId === undefined ? {} : { providerThreadId: this.providerThreadId }),
      ...(this.providerTurnId === undefined ? {} : { providerTurnId: this.providerTurnId })
    };
  }

  private threadStarted(notification: AppServerNotification): AppServerNormalization {
    const params = record(notification.params);
    const thread = record(params?.thread);
    const threadId = stringValue(thread?.id) ?? stringValue(params?.threadId);
    if (threadId === undefined) return this.invalid(notification, "thread_id_missing");
    this.providerThreadId = threadId;
    return this.mapped(
      notification,
      this.event("agent.session_started", "success", {
        provider: "openai-codex",
        providerThreadId: threadId,
        transport: "app-server-jsonrpc",
        adapterVersion: CODEX_ADAPTER_VERSION,
        ...(this.options.runtimeVersion === undefined
          ? {}
          : { runtimeVersion: this.options.runtimeVersion })
      }, `thread:${threadId}:started`),
      { providerEventId: threadId, providerThreadId: threadId }
    );
  }

  private turnStarted(notification: AppServerNotification): AppServerNormalization {
    const params = record(notification.params);
    const turn = record(params?.turn);
    const turnId = stringValue(turn?.id) ?? stringValue(params?.turnId);
    if (turnId === undefined) return this.invalid(notification, "turn_id_missing");
    const threadId = stringValue(params?.threadId) ?? this.providerThreadId;
    if (threadId !== undefined) this.providerThreadId = threadId;
    this.providerTurnId = turnId;
    this.turnOrdinal += 1;
    return this.mapped(
      notification,
      this.event("agent.turn_started", "pending", {
        provider: "openai-codex",
        providerThreadId: threadId ?? null,
        providerTurnId: turnId,
        turnOrdinal: this.turnOrdinal
      }, `turn:${turnId}:started`),
      { providerEventId: turnId, providerThreadId: threadId, providerTurnId: turnId }
    );
  }

  private turnCompleted(notification: AppServerNotification): AppServerNormalization {
    const params = record(notification.params);
    const turn = record(params?.turn);
    const turnId = stringValue(turn?.id) ?? stringValue(params?.turnId) ?? this.providerTurnId;
    if (turnId === undefined) return this.invalid(notification, "turn_id_missing");
    const threadId = stringValue(params?.threadId) ?? this.providerThreadId;
    const providerStatus = stringValue(turn?.status) ?? stringValue(params?.status);
    if (providerStatus === undefined) return this.invalid(notification, "turn_status_missing");
    const successful = providerStatus === "completed";
    const cancelled = providerStatus === "interrupted" || providerStatus === "cancelled";
    const eventType: EventType = successful ? "agent.turn_completed" : "agent.turn_failed";
    const status: EventStatus = successful ? "success" : cancelled ? "cancelled" : "error";
    return this.mapped(
      notification,
      this.event(eventType, status, {
        provider: "openai-codex",
        providerThreadId: threadId ?? null,
        providerTurnId: turnId,
        providerStatus,
        turnOrdinal: this.turnOrdinal,
        ...(turn?.error === undefined ? {} : { error: safeValue(turn.error) })
      }, `turn:${turnId}:completed:${providerStatus}`),
      { providerEventId: turnId, providerThreadId: threadId, providerTurnId: turnId }
    );
  }

  private itemLifecycle(notification: AppServerNotification): AppServerNormalization {
    const params = record(notification.params);
    const item = record(params?.item);
    if (item === undefined) return this.invalid(notification, "item_missing");
    const itemId = stringValue(item.id);
    const itemType = normalizeItemType(stringValue(item.type));
    if (itemId === undefined) return this.invalid(notification, "item_id_missing");
    if (itemType === undefined) return this.invalid(notification, "item_type_missing");
    const phase = notification.method === "item/started" ? "started" : "completed";
    const threadId = stringValue(params?.threadId) ?? this.providerThreadId;
    const turnId = stringValue(params?.turnId) ?? this.providerTurnId;
    const correlation = {
      provider: "openai-codex",
      providerThreadId: threadId ?? null,
      providerTurnId: turnId ?? null,
      providerItemId: itemId,
      providerItemType: itemType,
      providerPhase: phase
    };
    const ids = {
      providerEventId: itemId,
      providerThreadId: threadId,
      providerTurnId: turnId,
      providerItemId: itemId
    };

    if (itemType === "command_execution") {
      const command = stringValue(item.command);
      const argv = stringArray(item.argv) ?? (command === undefined ? [] : [command]);
      if (phase === "started") {
        const event = this.event("shell.command_requested", "pending", {
          ...correlation,
          argv,
          ...(command === undefined ? {} : { command }),
          argvFidelity: stringArray(item.argv) === undefined ? "provider-string" : "exact",
          ...(stringValue(item.cwd) === undefined ? {} : { cwd: stringValue(item.cwd) })
        }, `item:${itemId}:command:started`);
        this.pendingItems.set(itemId, event.eventId);
        return this.mapped(notification, event, ids);
      }
      const exitCode = numberValue(item.exitCode) ?? numberValue(item.exit_code);
      return this.mapped(
        notification,
        this.event(
          "shell.command_completed",
          itemStatus(item, exitCode),
          {
            ...correlation,
            argv,
            ...(command === undefined ? {} : { command }),
            ...(exitCode === undefined ? {} : { exitCode }),
            output: contentSummary(
              stringValue(item.aggregatedOutput) ?? stringValue(item.aggregated_output) ?? "",
              false
            )
          },
          `item:${itemId}:command:completed`,
          this.pendingItems.get(itemId)
        ),
        ids
      );
    }

    if (["mcp_tool_call", "tool_call", "web_search"].includes(itemType)) {
      const failed = itemStatus(item) === "error";
      const eventType: EventType = phase === "started"
        ? "tool.call_requested"
        : failed ? "tool.call_failed" : "tool.call_completed";
      const event = this.event(
        eventType,
        phase === "started" ? "pending" : itemStatus(item),
        {
          ...correlation,
          tool: stringValue(item.tool) ?? stringValue(item.name) ?? itemType,
          ...(item.arguments === undefined ? {} : { arguments: safeValue(item.arguments) }),
          ...(phase === "completed" && item.result !== undefined
            ? { result: safeValue(item.result) }
            : {})
        },
        `item:${itemId}:tool:${phase}`,
        phase === "completed" ? this.pendingItems.get(itemId) : undefined
      );
      if (phase === "started") this.pendingItems.set(itemId, event.eventId);
      return this.mapped(notification, event, ids);
    }

    if (itemType === "agent_message") {
      if (phase === "started") return { parseStatus: "ignored", ...ids };
      const text = itemText(item);
      return this.mapped(
        notification,
        this.event("model.response", itemStatus(item), {
          ...correlation,
          ...contentSummary(text, this.options.storeModelContent ?? false)
        }, `item:${itemId}:message:completed`),
        ids
      );
    }

    if (itemType === "user_message" || itemType === "developer_message") {
      if (phase === "started") return { parseStatus: "ignored", ...ids };
      const text = itemText(item);
      return this.mapped(
        notification,
        this.event("model.request", "success", {
          ...correlation,
          messageRole: itemType === "user_message" ? "user" : "developer",
          ...contentSummary(text, this.options.storeModelContent ?? false)
        }, `item:${itemId}:${itemType}:completed`),
        ids
      );
    }

    if (itemType === "file_change") {
      const paths = filePaths(item);
      return this.mapped(
        notification,
        this.event(
          phase === "started" ? "file.write_requested" : "artifact.created",
          phase === "started" ? "pending" : itemStatus(item),
          {
            ...correlation,
            paths,
            ...(phase === "completed" ? { kind: "provider_file_change_claim" } : {})
          },
          `item:${itemId}:file:${phase}`
        ),
        ids
      );
    }

    if (["reasoning", "plan", "todo_list"].includes(itemType)) {
      if (phase === "started") return { parseStatus: "ignored", ...ids };
      return this.mapped(
        notification,
        this.event("artifact.created", itemStatus(item), {
          ...correlation,
          kind: itemType === "reasoning" ? "reasoning_summary" : "plan_update",
          ...contentSummary(itemText(item), itemType !== "reasoning" && (this.options.storeModelContent ?? false))
        }, `item:${itemId}:${itemType}:completed`),
        ids
      );
    }

    return this.gap(notification, "unknown_provider_item", {
      ...correlation,
      itemKeys: Object.keys(item).sort()
    }, ids);
  }

  private mapped(
    notification: AppServerNotification,
    event: IncomingEvent,
    ids: Omit<AppServerNormalization, "parseStatus" | "event" | "gapReason"> = {}
  ): AppServerNormalization {
    return { parseStatus: "mapped", event, ...this.correlation(notification.params), ...defined(ids) };
  }

  private invalid(notification: AppServerNotification, reason: string): AppServerNormalization {
    return this.gap(notification, reason, { providerMethod: notification.method }, {}, "invalid");
  }

  private gap(
    notification: AppServerNotification,
    reason: string,
    detail: Record<string, unknown>,
    ids: Omit<AppServerNormalization, "parseStatus" | "event" | "gapReason"> = {},
    parseStatus: "gap" | "invalid" = "gap"
  ): AppServerNormalization {
    return {
      parseStatus,
      gapReason: reason,
      event: this.event("collection.gap_detected", "error", {
        source: "codex-app-server",
        reason,
        ...detail
      }),
      ...this.correlation(notification.params),
      ...defined(ids)
    };
  }

  private correlation(paramsValue: unknown): Partial<AppServerNormalization> {
    const params = record(paramsValue);
    const item = record(params?.item);
    const turn = record(params?.turn);
    const thread = record(params?.thread);
    const providerThreadId = stringValue(params?.threadId) ?? stringValue(thread?.id) ?? this.providerThreadId;
    const providerTurnId = stringValue(params?.turnId) ?? stringValue(turn?.id) ?? this.providerTurnId;
    const providerItemId = stringValue(item?.id);
    return defined({ providerThreadId, providerTurnId, providerItemId });
  }

  private event(
    eventType: EventType,
    status: EventStatus,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
    parentEventId?: string
  ): IncomingEvent {
    const eventId = uuidv7();
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId,
      runId: this.options.runId,
      ...(parentEventId === undefined ? {} : { parentEventId }),
      idempotencyKey: idempotencyKey ?? `codex-app-server:${eventId}`,
      occurredAt: this.now().toISOString(),
      actor: { type: "agent", id: "codex-app-server", version: CODEX_ADAPTER_VERSION },
      eventType,
      status,
      payload
    };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : undefined;
}

function normalizeItemType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function itemStatus(item: Record<string, unknown>, exitCode?: number): EventStatus {
  const status = stringValue(item.status);
  if (exitCode !== undefined) return exitCode === 0 ? "success" : "error";
  if (status === "failed" || status === "error") return "error";
  if (status === "cancelled" || status === "interrupted") return "cancelled";
  if (status === "inProgress" || status === "in_progress" || status === "pending") return "pending";
  return "success";
}

function itemText(item: Record<string, unknown>): string {
  const direct = stringValue(item.text) ?? stringValue(item.summary);
  if (direct !== undefined) return direct;
  if (!Array.isArray(item.content)) return "";
  return item.content.flatMap((part) => {
    const value = record(part);
    const text = stringValue(value?.text);
    return text === undefined ? [] : [text];
  }).join("\n");
}

function contentSummary(text: string, store: boolean): Record<string, unknown> {
  const bounded = text.length <= 16_384
    ? { text, truncated: false, byteSize: Buffer.byteLength(text) }
    : {
        text: `${text.slice(0, 8_192)}\n… content omitted …\n${text.slice(-8_192)}`,
        truncated: true,
        byteSize: Buffer.byteLength(text)
      };
  return {
    contentStored: store,
    characterCount: text.length,
    contentHash: sha256(text),
    ...(store ? { text: bounded } : {})
  };
}

function filePaths(item: Record<string, unknown>): string[] {
  if (Array.isArray(item.changes)) {
    return [...new Set(item.changes.flatMap((change) => {
      const candidate = record(change);
      const path = stringValue(candidate?.path);
      return path === undefined ? [] : [path];
    }))].sort();
  }
  const path = stringValue(item.path);
  return path === undefined ? [] : [path];
}

function safeValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
