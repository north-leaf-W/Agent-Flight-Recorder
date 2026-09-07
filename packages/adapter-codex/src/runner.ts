import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { IncomingEvent } from "@afr/protocol";

import {
  CODEX_ADAPTER_VERSION,
  CodexJsonlNormalizer,
  type CodexNormalizerOptions
} from "./normalizer.js";
import { CodexJsonlDecoder } from "./jsonl-decoder.js";

const execFileAsync = promisify(execFile);

export type CodexSandbox = "read-only" | "workspace-write";

export type CodexRunnerOptions = {
  runId: string;
  projectPath: string;
  task: string;
  binary?: string;
  sandbox?: CodexSandbox;
  ephemeral?: boolean;
  model?: string;
  runtimeVersion?: string;
  storeModelContent?: boolean;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
  onEvents: (events: IncomingEvent[]) => Promise<void>;
};

export type CodexRunnerResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: { text: string; truncated: boolean; byteSize: number };
  eventCount: number;
  gapCount: number;
  lineCount: number;
  terminalOutcome: "completed" | "failed" | "unknown";
  providerThreadId?: string;
  providerTurnId?: string;
};

export function buildCodexExecArgs(options: {
  task: string;
  sandbox?: CodexSandbox;
  ephemeral?: boolean;
  model?: string;
}): string[] {
  const sandbox = options.sandbox ?? "workspace-write";
  const args = ["exec", "--json", "--color", "never", "--sandbox", sandbox];
  if (options.ephemeral ?? true) args.push("--ephemeral");
  if (options.model !== undefined) args.push("--model", options.model);
  args.push(options.task);
  return args;
}

export async function detectCodexVersion(
  binary = "codex",
  cwd?: string,
  environment?: NodeJS.ProcessEnv
): Promise<string | undefined> {
  try {
    const result = await execFileAsync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      ...(cwd === undefined ? {} : { cwd }),
      ...(environment === undefined ? {} : { env: environment })
    });
    const output = result.stdout.trim() || result.stderr.trim();
    return output.length === 0 ? undefined : output.split(/\r?\n/, 1)[0]?.slice(0, 100);
  } catch {
    return undefined;
  }
}

export async function runCodexCli(options: CodexRunnerOptions): Promise<CodexRunnerResult> {
  const binary = options.binary ?? "codex";
  const sandbox = options.sandbox ?? "workspace-write";
  const ephemeral = options.ephemeral ?? true;
  const normalizerOptions: CodexNormalizerOptions = {
    runId: options.runId,
    ...(options.runtimeVersion === undefined ? {} : { runtimeVersion: options.runtimeVersion }),
    ...(options.storeModelContent === undefined
      ? {}
      : { storeModelContent: options.storeModelContent }),
    ...(options.now === undefined ? {} : { now: options.now }),
    launch: {
      sandbox,
      ephemeral,
      ...(options.model === undefined ? {} : { model: options.model })
    }
  };
  const normalizer = new CodexJsonlNormalizer(normalizerOptions);
  const child = spawn(binary, buildCodexExecArgs(options), {
    cwd: options.projectPath,
    env: options.environment ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  let stderrBytes = 0;
  let stderrTruncated = false;
  let eventCount = 0;
  let gapCount = 0;
  let timedOut = false;
  let spawnError: Error | undefined;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBytes += Buffer.byteLength(chunk);
    stderr = appendBounded(stderr, chunk);
    stderrTruncated ||= stderrBytes > 16_384;
  });

  const exit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      }, options.timeoutMs);

  const decoder = new CodexJsonlDecoder();
  const handleLine = async (line: string) => {
    const normalized = normalizer.normalizeLine(line);
    if (normalized.events.length === 0) return;
    eventCount += normalized.events.length;
    gapCount += normalized.events.filter(
      (event) => event.eventType === "collection.gap_detected"
    ).length;
    await options.onEvents(normalized.events);
  };
  const consume = async () => {
    for await (const chunk of child.stdout) {
      for (const line of decoder.push(chunk)) {
        await handleLine(line);
      }
    }
    for (const line of decoder.finish()) {
      await handleLine(line);
    }
  };

  let exitResult: { exitCode: number | null; signal: NodeJS.Signals | null };
  try {
    const [, completed] = await Promise.all([consume(), exit]);
    exitResult = completed;
  } catch (error) {
    child.kill("SIGKILL");
    await exit;
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (forceKill !== undefined) clearTimeout(forceKill);
  }
  if (spawnError !== undefined) throw spawnError;

  const state = normalizer.state();
  return {
    ...exitResult,
    timedOut,
    stderr: {
      text: stderr,
      truncated: stderrTruncated,
      byteSize: stderrBytes
    },
    eventCount,
    gapCount,
    lineCount: state.lineCount,
    terminalOutcome: state.terminalOutcome,
    ...(state.providerThreadId === undefined ? {} : { providerThreadId: state.providerThreadId }),
    ...(state.providerTurnId === undefined ? {} : { providerTurnId: state.providerTurnId })
  };
}

function appendBounded(existing: string, chunk: string, limit = 16_384): string {
  const combined = existing + chunk;
  if (combined.length <= limit) return combined;
  const half = Math.floor(limit / 2);
  return `${combined.slice(0, half)}\n… stderr omitted by Codex adapter …\n${combined.slice(-half)}`;
}

export { CODEX_ADAPTER_VERSION };
