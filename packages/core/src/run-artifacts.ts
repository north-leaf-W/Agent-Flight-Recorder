import { createHash } from "node:crypto";

import type { EventEnvelope } from "@afr/protocol";

import { canonicalJson } from "./canonical-json.js";
import { LocalStore, type RunRecord } from "./local-store.js";
import { redactValue, type RedactionReport } from "./redaction.js";
import { deriveRunInsights, deriveSteps } from "./steps.js";

export type RunComparisonSide = {
  runId: string;
  status: RunRecord["status"];
  durationMs?: number;
  firstFailure?: {
    eventId: string;
    sequenceNo: number;
    eventType: string;
    classification: string;
  };
  toolCallCount: number;
  approvalCount: number;
  changedFiles: string[];
  commands: Array<{ argv: string[]; exitCode: number | null; status: string }>;
  models: string[];
  promptVersions: string[];
  simulatedActionCount: number;
  liveActionCount: number;
};

export type RunComparison = {
  source: RunComparisonSide;
  target: RunComparisonSide;
  delta: {
    statusChanged: boolean;
    durationMs?: number;
    toolCallCount: number;
    approvalCount: number;
    filesOnlyInSource: string[];
    filesOnlyInTarget: string[];
    filesInBoth: string[];
    testOutcomeChanged: boolean;
  };
};

export type RunJsonExport = {
  format: "afr-run-json";
  formatVersion: "1.0";
  exportedAt: string;
  run: RunRecord;
  verification: {
    hashChainValid: boolean;
    eventCount: number;
    exportHash: string;
  };
  events: EventEnvelope[];
  steps: ReturnType<typeof deriveSteps>;
  insights: ReturnType<typeof deriveRunInsights>;
  approvals: ReturnType<LocalStore["listApprovals"]>;
  checkpoints: ReturnType<LocalStore["listCheckpoints"]>;
  replays: {
    asSource: ReturnType<LocalStore["listReplays"]>;
    asTarget?: NonNullable<ReturnType<LocalStore["getReplayByTargetRun"]>>;
  };
  redactionReport: RedactionReport;
};

export class RunArtifactError extends Error {
  constructor(readonly code: "run_not_found", message: string) {
    super(message);
    this.name = "RunArtifactError";
  }
}

export function compareRuns(store: LocalStore, sourceRunId: string, targetRunId: string): RunComparison {
  const sourceRun = store.getRun(sourceRunId);
  const targetRun = store.getRun(targetRunId);
  if (sourceRun === undefined) throw new RunArtifactError("run_not_found", `Run does not exist: ${sourceRunId}`);
  if (targetRun === undefined) throw new RunArtifactError("run_not_found", `Run does not exist: ${targetRunId}`);
  const source = summarizeRun(sourceRun, store.listEvents(sourceRunId));
  const target = summarizeRun(targetRun, store.listEvents(targetRunId));
  const sourceFiles = new Set(source.changedFiles);
  const targetFiles = new Set(target.changedFiles);
  return {
    source,
    target,
    delta: {
      statusChanged: source.status !== target.status,
      ...(source.durationMs === undefined || target.durationMs === undefined
        ? {}
        : { durationMs: target.durationMs - source.durationMs }),
      toolCallCount: target.toolCallCount - source.toolCallCount,
      approvalCount: target.approvalCount - source.approvalCount,
      filesOnlyInSource: source.changedFiles.filter((path) => !targetFiles.has(path)),
      filesOnlyInTarget: target.changedFiles.filter((path) => !sourceFiles.has(path)),
      filesInBoth: source.changedFiles.filter((path) => targetFiles.has(path)),
      testOutcomeChanged: commandOutcome(source.commands) !== commandOutcome(target.commands)
    }
  };
}

export function createRunJsonExport(
  store: LocalStore,
  runId: string,
  exportedAt = new Date().toISOString()
): RunJsonExport {
  const run = store.getRun(runId);
  if (run === undefined) throw new RunArtifactError("run_not_found", `Run does not exist: ${runId}`);
  const events = store.listEvents(runId);
  const targetReplay = store.getReplayByTargetRun(runId);
  const raw = {
    format: "afr-run-json" as const,
    formatVersion: "1.0" as const,
    exportedAt,
    run,
    verification: {
      hashChainValid: store.verifyRunChain(runId),
      eventCount: events.length
    },
    events,
    steps: deriveSteps(events),
    insights: deriveRunInsights(events),
    approvals: store.listApprovals({ runId }),
    checkpoints: store.listCheckpoints(runId),
    replays: {
      asSource: store.listReplays(runId),
      ...(targetReplay === undefined ? {} : { asTarget: targetReplay })
    }
  };
  const redaction = redactValue(raw);
  const exportHash = createHash("sha256").update(canonicalJson(redaction.value)).digest("hex");
  return {
    ...redaction.value,
    verification: { ...redaction.value.verification, exportHash },
    redactionReport: redaction.report
  };
}

function summarizeRun(run: RunRecord, events: EventEnvelope[]): RunComparisonSide {
  const insights = deriveRunInsights(events);
  const failure = insights.firstAnomaly;
  const elapsed = durationMs(run);
  const changedFiles = new Set<string>();
  const commands: RunComparisonSide["commands"] = [];
  const models = new Set<string>();
  const promptVersions = new Set<string>();
  let simulatedActionCount = 0;
  let liveActionCount = 0;

  for (const event of events) {
    const path = typeof event.payload.path === "string" ? event.payload.path : undefined;
    if (path !== undefined && event.eventType.startsWith("file.")) changedFiles.add(path);
    if (Array.isArray(event.payload.changedPaths)) {
      for (const item of event.payload.changedPaths) {
        if (typeof item === "string") changedFiles.add(item);
      }
    }
    if (event.eventType === "shell.command_completed") {
      commands.push({
        argv: Array.isArray(event.payload.argv)
          ? event.payload.argv.filter((item): item is string => typeof item === "string")
          : [],
        exitCode: typeof event.payload.exitCode === "number" ? event.payload.exitCode : null,
        status: event.status
      });
    }
    if (event.actor.model !== undefined) models.add(event.actor.model);
    if (typeof event.payload.model === "string") models.add(event.payload.model);
    if (typeof event.payload.promptVersion === "string") promptVersions.add(event.payload.promptVersion);
    if (event.eventType === "shell.command_completed" || event.eventType === "tool.call_completed") {
      if (event.payload.simulated === true) simulatedActionCount += 1;
      else liveActionCount += 1;
    }
  }

  return {
    runId: run.id,
    status: run.status,
    ...(elapsed === undefined ? {} : { durationMs: elapsed }),
    ...(failure === undefined
      ? {}
      : {
          firstFailure: {
            eventId: failure.eventId,
            sequenceNo: failure.sequenceNo,
            eventType: failure.eventType,
            classification: failure.classification ?? "unknown"
          }
        }),
    toolCallCount: events.filter((event) =>
      event.eventType === "shell.command_completed" || event.eventType === "tool.call_completed"
    ).length,
    approvalCount: events.filter((event) => event.eventType === "approval.requested").length,
    changedFiles: [...changedFiles].sort(),
    commands,
    models: [...models].sort(),
    promptVersions: [...promptVersions].sort(),
    simulatedActionCount,
    liveActionCount
  };
}

function durationMs(run: RunRecord): number | undefined {
  if (run.startedAt === undefined || run.endedAt === undefined) return undefined;
  return Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
}

function commandOutcome(commands: RunComparisonSide["commands"]): string {
  return commands.map((command) => `${command.exitCode}:${command.status}`).join("|");
}
