import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import {
  CODEX_ADAPTER_VERSION,
  detectCodexVersion,
  runCodexCli,
  type CodexRunnerResult,
  type CodexSandbox
} from "@afr/adapter-codex";
import {
  EVENT_SCHEMA_VERSION,
  type EventStatus,
  type EventType,
  type IncomingEvent
} from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import type { AfrRunApi } from "./api-client.js";
import { compareSnapshots, snapshotFiles, type FileChange } from "./file-snapshot.js";

export type RunCapturedCodexOptions = {
  api: AfrRunApi;
  projectPath: string;
  task: string;
  agentId?: string;
  binary?: string;
  sandbox?: CodexSandbox;
  ephemeral?: boolean;
  model?: string;
  checkpointBefore?: boolean;
  storeModelContent?: boolean;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type CapturedCodexResult = {
  runId: string;
  status: "completed" | "failed";
  exitCode: number | null;
  changedFiles: number;
  providerEvents: number;
  gapCount: number;
  runtimeVersion?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  timedOut: boolean;
  finalCommandExitCode?: number;
};

type ProviderFileEvidence = {
  providerItemId: string | null;
  providerTurnId: string | null;
  rawPath: string;
  normalizedPath?: string;
  requestedEventId?: string;
  completedEventId?: string;
};

type FileReconciliation = {
  evidence: ProviderFileEvidence[];
  matchesByPath: Map<string, ProviderFileEvidence[]>;
  matchedPaths: string[];
  observedOnlyPaths: string[];
  claimedOnlyPaths: string[];
  unresolvedClaimPaths: string[];
};

export async function runCapturedCodex(
  options: RunCapturedCodexOptions
): Promise<CapturedCodexResult> {
  const agentId = options.agentId ?? "codex-cli";
  const binary = options.binary ?? "codex";
  const sandbox = options.sandbox ?? "workspace-write";
  const ephemeral = options.ephemeral ?? true;
  const run = await options.api.createRun({
    projectPath: options.projectPath,
    task: options.task,
    agentId
  });
  const before = await snapshotFiles(options.projectPath);

  if (options.checkpointBefore) {
    if (options.api.createCheckpoint === undefined) {
      throw new Error("This AFR server does not support checkpoints");
    }
    await options.api.createCheckpoint(run.id);
  }

  const runtimeVersion = await detectCodexVersion(binary, options.projectPath, options.environment);

  await options.api.appendEvents(run.id, [
    event(run.id, "artifact.created", "success", {
      kind: "agent_adapter_capabilities",
      provider: "codex",
      adapterVersion: CODEX_ADAPTER_VERSION,
      runtimeVersion: runtimeVersion ?? null,
      mode: "instrumented",
      capabilities: {
        eventStream: "supported",
        commandEvents: "supported",
        fileEvents: "degraded",
        toolEvents: "supported",
        approvalBridge: "unsupported",
        sessionResume: "unsupported",
        cancellation: "degraded",
        workspaceIsolation: "unsupported",
        networkMediation: "unsupported",
        sideEffectVerification: "project-snapshot"
      }
    })
  ]);

  let execution: CodexRunnerResult | undefined;
  let executionError: unknown;
  const providerFileEvents: IncomingEvent[] = [];
  let finalCommand: { status: EventStatus; exitCode?: number } | undefined;
  try {
    execution = await runCodexCli({
      runId: run.id,
      projectPath: options.projectPath,
      task: options.task,
      binary,
      sandbox,
      ephemeral,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
      ...(options.storeModelContent === undefined
        ? {}
        : { storeModelContent: options.storeModelContent }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onEvents: async (events: IncomingEvent[]) => {
        providerFileEvents.push(...events.filter(isProviderFileEvent));
        for (const candidate of events) {
          if (candidate.eventType !== "shell.command_completed") continue;
          const exitCode = typeof candidate.payload.exitCode === "number"
            ? candidate.payload.exitCode
            : undefined;
          finalCommand = {
            status: candidate.status,
            ...(exitCode === undefined ? {} : { exitCode })
          };
        }
        await options.api.appendEvents(run.id, events);
      }
    });
  } catch (error) {
    executionError = error;
  }

  const after = await snapshotFiles(options.projectPath);
  const changes = compareSnapshots(before, after);
  const reconciliation = reconcileFileChanges(options.projectPath, changes, providerFileEvents);
  const finalEvents: IncomingEvent[] = changes.map((change) =>
    fileChangeEvent(run.id, change, reconciliation.matchesByPath.get(change.path) ?? [])
  );
  finalEvents.push(fileReconciliationEvent(run.id, changes, reconciliation));

  if (reconciliation.observedOnlyPaths.length > 0) {
    finalEvents.push(
      gap(run.id, "observed_file_change_without_provider_claim", {
        paths: reconciliation.observedOnlyPaths,
        observedChangeCount: changes.length
      })
    );
  }
  if (
    reconciliation.claimedOnlyPaths.length > 0 ||
    reconciliation.unresolvedClaimPaths.length > 0
  ) {
    finalEvents.push(
      event(run.id, "system.warning", "unknown", {
        source: "codex-file-reconciler",
        code: "provider_file_claim_mismatch",
        claimedOnlyPaths: reconciliation.claimedOnlyPaths,
        unresolvedClaimPaths: reconciliation.unresolvedClaimPaths
      })
    );
  }

  if (runtimeVersion === undefined) {
    finalEvents.push(gap(run.id, "codex_runtime_version_unavailable", { binary }));
  }
  if (executionError !== undefined) {
    finalEvents.push(
      event(run.id, "system.warning", "error", {
        source: "codex-adapter",
        stage: "run",
        error: messageOf(executionError)
      })
    );
  } else if (execution !== undefined) {
    if (execution.stderr.text.length > 0) {
      finalEvents.push(
        event(run.id, "artifact.created", execution.exitCode === 0 ? "success" : "error", {
          kind: "codex_stderr",
          stderr: execution.stderr
        })
      );
    }
    if (execution.lineCount === 0) {
      finalEvents.push(gap(run.id, "provider_stream_empty", { binary }));
    }
    if (execution.terminalOutcome === "unknown") {
      finalEvents.push(
        gap(run.id, "provider_terminal_event_missing", {
          providerThreadId: execution.providerThreadId ?? null,
          exitCode: execution.exitCode
        })
      );
    }
    if (execution.timedOut) {
      finalEvents.push(
        event(run.id, "system.warning", "error", {
          source: "codex-adapter",
          code: "codex_timeout",
          timeoutMs: options.timeoutMs ?? null
        })
      );
    }
  }

  if (finalEvents.length > 0) {
    await options.api.appendEvents(run.id, finalEvents);
  }

  const finalCommandFailed = finalCommand?.status === "error" ||
    (finalCommand?.exitCode !== undefined && finalCommand.exitCode !== 0);
  const completed = executionError === undefined && execution !== undefined &&
    execution.exitCode === 0 && execution.terminalOutcome !== "failed" &&
    !execution.timedOut && !finalCommandFailed;
  const status = completed ? "completed" : "failed";
  await options.api.setStatus(
    run.id,
    status,
    completed
      ? "Codex completed"
      : executionError === undefined && finalCommandFailed
        ? `Codex final command failed with ${finalCommand?.exitCode ?? "an error"}`
        : executionError === undefined && execution?.terminalOutcome === "failed"
          ? "Codex reported a failed turn"
        : executionError === undefined
          ? `Codex exited with ${execution?.exitCode ?? "no exit code"}`
        : `Codex adapter failed: ${messageOf(executionError)}`
  );

  return {
    runId: run.id,
    status,
    exitCode: execution?.exitCode ?? null,
    changedFiles: changes.length,
    providerEvents: execution?.eventCount ?? 0,
    gapCount: (execution?.gapCount ?? 0) + finalEvents.filter(
      (candidate) => candidate.eventType === "collection.gap_detected"
    ).length,
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
    ...(execution?.providerThreadId === undefined
      ? {}
      : { providerThreadId: execution.providerThreadId }),
    ...(execution?.providerTurnId === undefined
      ? {}
      : { providerTurnId: execution.providerTurnId }),
    timedOut: execution?.timedOut ?? false,
    ...(finalCommand?.exitCode === undefined
      ? {}
      : { finalCommandExitCode: finalCommand.exitCode })
  };
}

function fileChangeEvent(
  runId: string,
  change: FileChange,
  matches: ProviderFileEvidence[]
): IncomingEvent {
  const parentEventId = matches.at(-1)?.completedEventId ?? matches.at(-1)?.requestedEventId;
  return event(runId, `file.${change.action}`, "success", {
    source: "afr-file-observer",
    path: change.path,
    action: change.action,
    beforeHash: change.before?.hash ?? null,
    afterHash: change.after?.hash ?? null,
    beforeSize: change.before?.byteSize ?? null,
    afterSize: change.after?.byteSize ?? null,
    diff: change.diff ?? null,
    diffUnavailableReason: change.diffUnavailableReason ?? null,
    providerCorrelation: {
      status: matches.length > 0 ? "matched" : "observed_without_provider_claim",
      matches: matches.map((match) => ({
        providerItemId: match.providerItemId,
        providerTurnId: match.providerTurnId,
        rawPath: match.rawPath,
        requestedEventId: match.requestedEventId ?? null,
        completedEventId: match.completedEventId ?? null
      }))
    }
  }, parentEventId);
}

function fileReconciliationEvent(
  runId: string,
  changes: FileChange[],
  reconciliation: FileReconciliation
): IncomingEvent {
  const completedClaimCount = reconciliation.evidence.filter(
    (candidate) => candidate.completedEventId !== undefined
  ).length;
  return event(runId, "artifact.created", "success", {
    kind: "codex_file_reconciliation",
    source: "codex-file-reconciler",
    providerEvidenceCount: reconciliation.evidence.length,
    completedClaimCount,
    observedChangeCount: changes.length,
    matchedPathCount: reconciliation.matchedPaths.length,
    matchedPaths: reconciliation.matchedPaths,
    observedOnlyPaths: reconciliation.observedOnlyPaths,
    claimedOnlyPaths: reconciliation.claimedOnlyPaths,
    unresolvedClaimPaths: reconciliation.unresolvedClaimPaths,
    coverage:
      reconciliation.observedOnlyPaths.length === 0 &&
      reconciliation.unresolvedClaimPaths.length === 0
        ? "path-correlated"
        : "degraded"
  });
}

function isProviderFileEvent(candidate: IncomingEvent): boolean {
  return candidate.eventType === "file.write_requested" ||
    (candidate.eventType === "artifact.created" &&
      candidate.payload.kind === "provider_file_change_claim");
}

export function reconcileFileChanges(
  projectPath: string,
  changes: FileChange[],
  providerEvents: IncomingEvent[]
): FileReconciliation {
  const evidenceByKey = new Map<string, ProviderFileEvidence>();

  for (const candidate of providerEvents) {
    if (!isProviderFileEvent(candidate)) continue;
    const paths = Array.isArray(candidate.payload.paths)
      ? candidate.payload.paths.filter((path): path is string => typeof path === "string")
      : [];
    const providerItemId = typeof candidate.payload.providerItemId === "string"
      ? candidate.payload.providerItemId
      : null;
    const providerTurnId = typeof candidate.payload.providerTurnId === "string"
      ? candidate.payload.providerTurnId
      : null;
    for (const rawPath of paths) {
      const normalizedPath = normalizeProviderPath(projectPath, rawPath);
      const key = `${providerItemId ?? candidate.eventId}\u0000${normalizedPath ?? rawPath}`;
      const current = evidenceByKey.get(key) ?? {
        providerItemId,
        providerTurnId,
        rawPath,
        ...(normalizedPath === undefined ? {} : { normalizedPath })
      };
      if (candidate.eventType === "file.write_requested") {
        current.requestedEventId = candidate.eventId;
      } else {
        current.completedEventId = candidate.eventId;
      }
      evidenceByKey.set(key, current);
    }
  }

  const evidence = [...evidenceByKey.values()];
  const matchesByPath = new Map<string, ProviderFileEvidence[]>();
  for (const change of changes) {
    matchesByPath.set(
      change.path,
      evidence.filter((candidate) => candidate.normalizedPath === change.path)
    );
  }
  const matchedPaths = changes
    .filter((change) => (matchesByPath.get(change.path)?.length ?? 0) > 0)
    .map((change) => change.path);
  const matched = new Set(matchedPaths);

  return {
    evidence,
    matchesByPath,
    matchedPaths,
    observedOnlyPaths: changes
      .filter((change) => !matched.has(change.path))
      .map((change) => change.path),
    claimedOnlyPaths: [...new Set(evidence
      .filter((candidate) =>
        candidate.completedEventId !== undefined &&
        candidate.normalizedPath !== undefined &&
        !matched.has(candidate.normalizedPath)
      )
      .map((candidate) => candidate.normalizedPath as string))].sort(),
    unresolvedClaimPaths: [...new Set(evidence
      .filter((candidate) => candidate.normalizedPath === undefined)
      .map((candidate) => candidate.rawPath))].sort()
  };
}

function normalizeProviderPath(projectPath: string, rawPath: string): string | undefined {
  if (rawPath.length === 0 || rawPath.includes("\u0000")) return undefined;
  const projectRoot = resolve(projectPath);
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath);
  const projectRelative = relative(projectRoot, absolutePath);
  if (
    projectRelative.length === 0 ||
    projectRelative === ".." ||
    projectRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(projectRelative)
  ) {
    return undefined;
  }
  return projectRelative.split("\\").join("/");
}

function gap(runId: string, reason: string, payload: Record<string, unknown>): IncomingEvent {
  return event(runId, "collection.gap_detected", "unknown", {
    source: "codex-adapter",
    reason,
    ...payload
  });
}

function event(
  runId: string,
  eventType: EventType,
  status: EventStatus,
  payload: Record<string, unknown>,
  parentEventId?: string
): IncomingEvent {
  const eventId = uuidv7();
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    runId,
    idempotencyKey: `codex-capture:${createHash("sha256")
      .update(`${eventType}:${eventId}`)
      .digest("hex")}`,
    occurredAt: new Date().toISOString(),
    actor: { type: "system", id: "codex-adapter", version: CODEX_ADAPTER_VERSION },
    eventType,
    status,
    payload,
    ...(parentEventId === undefined ? {} : { parentEventId })
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
