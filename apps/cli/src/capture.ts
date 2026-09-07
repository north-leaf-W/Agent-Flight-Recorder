import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  EVENT_SCHEMA_VERSION,
  type EventStatus,
  type EventType,
  type IncomingEvent
} from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import type { AfrRunApi, UploadedBlob } from "./api-client.js";
import { compareSnapshots, snapshotFiles, type FileChange } from "./file-snapshot.js";

export type CaptureOptions = {
  api: AfrRunApi;
  projectPath: string;
  task: string;
  agentId: string;
  command: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
  checkpointBefore?: boolean;
};

export type CaptureResult = {
  runId: string;
  exitCode: number | null;
  status: "completed" | "failed";
  changedFiles: number;
};

export async function runCapturedCommand(options: CaptureOptions): Promise<CaptureResult> {
  const run = await options.api.createRun({
    projectPath: options.projectPath,
    task: options.task,
    agentId: options.agentId
  });
  const before = await snapshotFiles(options.projectPath);
  const startedAt = new Date().toISOString();

  if (options.checkpointBefore) {
    if (options.api.createCheckpoint === undefined) {
      throw new Error("This AFR server does not support checkpoints");
    }
    await options.api.createCheckpoint(run.id);
  }

  await options.api.appendEvents(run.id, [
    event(run.id, "shell.command_requested", "pending", {
      argv: [options.command, ...options.args],
      cwd: options.projectPath
    }),
    event(run.id, "collection.gap_detected", "unknown", {
      source: "afr-cli",
      reason: "File reads and activity outside the project directory are not observed by M0 capture",
      coverage: "L2-project-scan"
    })
  ]);

  const started = performance.now();
  const execution = await execute(options);
  const durationMs = Math.round(performance.now() - started);
  const after = await snapshotFiles(options.projectPath);
  const changes = compareSnapshots(before, after);
  const completedAt = new Date().toISOString();
  const commandStatus = execution.exitCode === 0 ? "success" : "error";
  const stdout = await prepareOutput(options.api, execution.stdout);
  const stderr = await prepareOutput(options.api, execution.stderr);
  const outputBlobRefs = [stdout.blobRef, stderr.blobRef].filter(
    (value): value is string => value !== undefined
  );
  const events: IncomingEvent[] = [
    event(
      run.id,
      "shell.command_completed",
      commandStatus,
      {
        argv: [options.command, ...options.args],
        cwd: options.projectPath,
        pid: execution.pid,
        exitCode: execution.exitCode,
        signal: execution.signal,
        durationMs,
        stdout,
        stderr,
        startedAt,
        completedAt
      },
      completedAt,
      outputBlobRefs
    ),
    ...changes.map((change) => fileChangeEvent(run.id, change, completedAt))
  ];
  await options.api.appendEvents(run.id, events);

  const status = execution.exitCode === 0 ? "completed" : "failed";
  await options.api.setStatus(
    run.id,
    status,
    execution.exitCode === 0 ? "Command completed" : `Command exited with ${execution.exitCode}`
  );
  return { runId: run.id, exitCode: execution.exitCode, status, changedFiles: changes.length };
}

function event(
  runId: string,
  eventType: EventType,
  status: EventStatus,
  payload: Record<string, unknown>,
  occurredAt = new Date().toISOString(),
  blobRefs: string[] = []
): IncomingEvent {
  const eventId = uuidv7();
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    runId,
    idempotencyKey: `afr-cli:${eventId}`,
    occurredAt,
    actor: { type: "tool", id: "afr-cli", version: "0.1.0-demo.0" },
    eventType,
    status,
    payload,
    ...(blobRefs.length === 0 ? {} : { blobRefs })
  };
}

function fileChangeEvent(runId: string, change: FileChange, occurredAt: string): IncomingEvent {
  const eventType = `file.${change.action}` as const;
  return event(
    runId,
    eventType,
    "success",
    {
      path: change.path,
      action: change.action,
      beforeHash: change.before?.hash ?? null,
      afterHash: change.after?.hash ?? null,
      beforeSize: change.before?.byteSize ?? null,
      afterSize: change.after?.byteSize ?? null,
      diff: change.diff ?? null,
      diffUnavailableReason: change.diffUnavailableReason ?? null
    },
    occurredAt
  );
}

function summarizeOutput(value: string): { text: string; truncated: boolean; byteSize: number } {
  const limit = 8_192;
  const byteSize = Buffer.byteLength(value);
  if (value.length <= limit) {
    return { text: value, truncated: false, byteSize };
  }
  const half = limit / 2;
  return {
    text: `${value.slice(0, half)}\n… output omitted by M0 limit …\n${value.slice(-half)}`,
    truncated: true,
    byteSize
  };
}

async function prepareOutput(
  api: AfrRunApi,
  value: string
): Promise<
  ReturnType<typeof summarizeOutput> &
    Partial<Omit<UploadedBlob, "byteSize">> & { storedByteSize?: number }
> {
  const summary = summarizeOutput(value);
  if (!summary.truncated) {
    return summary;
  }
  const blob = await api.putBlob(value, "text/plain; charset=utf-8");
  return {
    ...summary,
    blobRef: blob.blobRef,
    storedByteSize: blob.byteSize,
    redactionState: blob.redactionState,
    ...(blob.redactionReport === undefined ? {} : { redactionReport: blob.redactionReport })
  };
}

async function execute(options: CaptureOptions): Promise<{
  pid: number | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.projectPath,
      env: options.environment ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `${error.name}: ${error.message}`;
    });
    child.on("close", (exitCode, signal) => {
      resolve({ pid: child.pid, exitCode, signal, stdout, stderr });
    });
  });
}
