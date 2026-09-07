import type { EventEnvelope, EventStatus } from "@afr/protocol";

export type StepType = "lifecycle" | "command" | "file" | "system" | "tool";

export type StepSummary = {
  id: string;
  runId: string;
  type: StepType;
  title: string;
  status: EventStatus;
  eventIds: string[];
  sequenceStart: number;
  sequenceEnd: number;
  startedAt: string;
  endedAt: string;
  failureClassification?: "tool_failure" | "permission_denied" | "collection_gap" | "unknown";
};

export type RunInsights = {
  eventCount: number;
  commandCount: number;
  fileChangeCount: number;
  gapCount: number;
  coverageLevel: "L1" | "L2";
  firstAnomaly?: {
    eventId: string;
    sequenceNo: number;
    classification: StepSummary["failureClassification"];
    eventType: string;
  };
};

export function deriveSteps(events: readonly EventEnvelope[]): StepSummary[] {
  const steps: StepSummary[] = [];
  let commandEvents: EventEnvelope[] = [];

  const flushCommand = () => {
    if (commandEvents.length === 0) return;
    steps.push(toCommandStep(commandEvents));
    commandEvents = [];
  };

  for (const event of events) {
    if (event.eventType === "shell.command_requested") {
      flushCommand();
      commandEvents.push(event);
      continue;
    }
    if (
      commandEvents.length > 0 &&
      (event.eventType === "shell.command_completed" ||
        event.eventType === "collection.gap_detected" ||
        event.eventType.startsWith("file."))
    ) {
      commandEvents.push(event);
      continue;
    }
    flushCommand();
    steps.push(toSingleEventStep(event));
  }
  flushCommand();
  return steps;
}

export function deriveRunInsights(events: readonly EventEnvelope[]): RunInsights {
  const firstError = events.find((event) => event.status === "error");
  const firstGap = events.find((event) => event.eventType === "collection.gap_detected");
  const anomaly = firstError ?? firstGap;
  return {
    eventCount: events.length,
    commandCount: events.filter((event) => event.eventType === "shell.command_completed").length,
    fileChangeCount: events.filter((event) =>
      ["file.created", "file.modified", "file.deleted"].includes(event.eventType)
    ).length,
    gapCount: events.filter((event) => event.eventType === "collection.gap_detected").length,
    coverageLevel: firstGap === undefined ? "L2" : "L1",
    ...(anomaly === undefined
      ? {}
      : {
          firstAnomaly: {
            eventId: anomaly.eventId,
            sequenceNo: anomaly.sequenceNo,
            classification: classifyFailure(anomaly),
            eventType: anomaly.eventType
          }
        })
  };
}

function toCommandStep(events: EventEnvelope[]): StepSummary {
  const first = events[0] as EventEnvelope;
  const last = events.at(-1) as EventEnvelope;
  const completed = [...events]
    .reverse()
    .find((event) => event.eventType === "shell.command_completed");
  const argv = Array.isArray(first.payload.argv) ? first.payload.argv.join(" ") : "command";
  const status = completed?.status ?? first.status;
  const failureClassification =
    status === "error" ? classifyFailure(completed ?? first) : undefined;
  return {
    id: first.eventId,
    runId: first.runId,
    type: "command",
    title: argv,
    status,
    eventIds: events.map((event) => event.eventId),
    sequenceStart: first.sequenceNo,
    sequenceEnd: last.sequenceNo,
    startedAt: first.occurredAt,
    endedAt: last.occurredAt,
    ...(failureClassification === undefined ? {} : { failureClassification })
  };
}

function toSingleEventStep(event: EventEnvelope): StepSummary {
  const type: StepType = event.eventType.startsWith("run.") || event.eventType.startsWith("agent.")
    ? "lifecycle"
    : event.eventType.startsWith("file.")
      ? "file"
      : event.eventType.startsWith("tool.")
        ? "tool"
        : "system";
  const failureClassification =
    event.status === "error" || event.eventType === "collection.gap_detected"
      ? classifyFailure(event)
      : undefined;
  return {
    id: event.eventId,
    runId: event.runId,
    type,
    title: event.eventType,
    status: event.status,
    eventIds: [event.eventId],
    sequenceStart: event.sequenceNo,
    sequenceEnd: event.sequenceNo,
    startedAt: event.occurredAt,
    endedAt: event.occurredAt,
    ...(failureClassification === undefined ? {} : { failureClassification })
  };
}

function classifyFailure(event: EventEnvelope): StepSummary["failureClassification"] {
  if (event.eventType === "collection.gap_detected") return "collection_gap";
  if (event.eventType === "approval.decided" || event.risk?.decision === "deny") {
    return "permission_denied";
  }
  if (event.eventType.startsWith("shell.") || event.eventType.startsWith("tool.")) {
    return "tool_failure";
  }
  return "unknown";
}
