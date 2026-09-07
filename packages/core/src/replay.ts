import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { EVENT_SCHEMA_VERSION, isTerminalRunStatus, type EventStatus, type EventType, type IncomingEvent } from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import {
  CheckpointManager,
  resolveWorkspacePath,
  type WorkspaceManifest,
  type WorkspaceManifestEntry
} from "./checkpoint.js";
import { canonicalJson } from "./canonical-json.js";
import {
  LocalStore,
  createRunCreatedEvent,
  type CheckpointRecord,
  type ReplayRecord
} from "./local-store.js";
import { compareRuns } from "./run-artifacts.js";

export type ReplayExecutionRequest = {
  worktreePath: string;
  command: string[];
  timeoutMs: number;
};

export type ReplayExecutionResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export interface ReplayExecutor {
  execute(request: ReplayExecutionRequest): ReplayExecutionResult;
}

export type ReplayRunInput = {
  checkpointId: string;
  command: string[];
  task?: string;
  timeoutMs?: number;
  overrides?: Record<string, string>;
};

export type ReplayRunResult = {
  replay: ReplayRecord;
  sourceWorkspaceHashBefore: string;
  sourceWorkspaceHashAfter: string;
};

export type ReplayErrorCode =
  | "checkpoint_not_found"
  | "invalid_command"
  | "side_effect_blocked"
  | "worktree_create_failed"
  | "checkpoint_restore_failed"
  | "checkpoint_verification_failed"
  | "sandbox_unavailable"
  | "execution_failed"
  | "workspace_limit_exceeded"
  | "source_workspace_changed";

export type WorkspaceChangeLimits = {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

export const DEFAULT_WORKSPACE_CHANGE_LIMITS = {
  maxFiles: 900,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxDiffBytes: 32 * 1024 * 1024
} as const;

export class ReplayError extends Error {
  constructor(readonly code: ReplayErrorCode, message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

export class MacOsSandboxExecutor implements ReplayExecutor {
  execute(request: ReplayExecutionRequest): ReplayExecutionResult {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
      throw new ReplayError(
        "sandbox_unavailable",
        "Isolated Live replay requires macOS sandbox-exec in the MVP"
      );
    }
    const runtimeRoot = join(request.worktreePath, ".afr", "runtime");
    const home = join(runtimeRoot, "home");
    const temporary = join(runtimeRoot, "tmp");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const profile = sandboxProfile(request.worktreePath);
    const command = request.command.map((part, index) =>
      index === 0 && basename(part) === "node" ? process.execPath : part
    );
    const startedAt = performance.now();
    const result = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "--", ...command],
      {
        cwd: request.worktreePath,
        env: minimalEnvironment(home, temporary),
        encoding: "utf8",
        timeout: request.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const stderr = `${result.stderr ?? ""}${result.error === undefined ? "" : `${result.error.name}: ${result.error.message}`}`;
    if (result.status === null && result.error !== undefined) {
      throw new ReplayError("execution_failed", stderr || "Replay process could not start");
    }
    return {
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr,
      durationMs: Math.round(performance.now() - startedAt)
    };
  }
}

export class ReplayManager {
  private readonly checkpoints: CheckpointManager;

  constructor(
    private readonly store: LocalStore,
    private readonly executor: ReplayExecutor = new MacOsSandboxExecutor(),
    private readonly now = () => new Date()
  ) {
    this.checkpoints = new CheckpointManager(store, now);
  }

  run(input: ReplayRunInput): ReplayRunResult {
    const checkpoint = this.store.getCheckpoint(input.checkpointId);
    if (checkpoint === undefined) {
      throw new ReplayError("checkpoint_not_found", `Checkpoint does not exist: ${input.checkpointId}`);
    }
    const sourceRun = this.store.getRun(checkpoint.runId);
    if (sourceRun === undefined) {
      throw new ReplayError("checkpoint_not_found", `Source Run does not exist: ${checkpoint.runId}`);
    }
    validateReplayCommandShape(input.command);
    const replayId = uuidv7();
    const forkEventId = checkpoint.sourceEventId ?? checkpoint.eventId;
    const worktreePath = join(this.store.dataDir, "replay-workspaces", replayId);
    const createdAt = this.now().toISOString();
    const targetRun = this.store.createRun({
      parentRunId: sourceRun.id,
      forkedFromEventId: forkEventId,
      projectPath: worktreePath,
      task: input.task ?? `Replay: ${sourceRun.task}`,
      agentId: "afr-replay-worker"
    });
    this.store.appendEvents(targetRun.id, [createRunCreatedEvent(targetRun)]);
    let replay = this.store.createReplay({
      id: replayId,
      checkpointId: checkpoint.id,
      sourceRunId: sourceRun.id,
      sourceEventId: forkEventId,
      targetRunId: targetRun.id,
      mode: "isolated-live",
      worktreePath,
      command: input.command,
      overrides: input.overrides ?? {},
      createdAt
    });
    const manifest = this.checkpoints.readManifest(checkpoint.id);
    const sourceWorkspaceHashBefore = workspaceFingerprint(checkpoint.workspaceRoot, manifest);

    try {
      enforceReplayCommandPolicy(input.command);
      createDetachedWorktree(checkpoint.workspaceRoot, worktreePath, checkpoint.baseCommit);
      restoreCheckpoint(this.store, worktreePath, checkpoint, manifest);
      verifyCheckpointManifest(worktreePath, manifest);
      this.store.transitionRun(targetRun.id, "running", "afr-replay-worker", `replay:${replay.id}`);
      replay = this.store.transitionReplay({ replayId, status: "running", at: this.now().toISOString() });
      this.store.appendEvents(targetRun.id, [
        replayEvent(targetRun.id, "replay.started", "success", {
          replayId,
          checkpointId: checkpoint.id,
          sourceRunId: sourceRun.id,
          sourceEventId: forkEventId,
          mode: "isolated-live",
          worktreePath,
          command: input.command,
          externalSideEffects: "denied",
          overrides: input.overrides ?? {}
        }),
        replayEvent(targetRun.id, "shell.command_requested", "pending", {
          argv: input.command,
          cwd: worktreePath,
          replayId
        })
      ]);

      const execution = this.executor.execute({
        worktreePath,
        command: input.command,
        timeoutMs: Math.max(1_000, Math.min(input.timeoutMs ?? 300_000, 900_000))
      });
      if (workspaceFingerprint(checkpoint.workspaceRoot, manifest) !== sourceWorkspaceHashBefore) {
        throw new ReplayError(
          "source_workspace_changed",
          "Original workspace changed during replay"
        );
      }
      const completedAt = this.now().toISOString();
      const stdout = this.store.putBlob(Buffer.from(execution.stdout), "text/plain; charset=utf-8");
      const stderr = this.store.putBlob(Buffer.from(execution.stderr), "text/plain; charset=utf-8");
      const changedPaths = gitChangedPaths(worktreePath);
      const diff = readWorktreeDiff(worktreePath);
      const diffBlob = diff.byteLength === 0 ? undefined : this.store.putBlob(diff, "text/x-diff");
      const commandStatus: EventStatus = execution.exitCode === 0 ? "success" : "error";
      this.store.appendEvents(targetRun.id, [
        replayEvent(
          targetRun.id,
          "shell.command_completed",
          commandStatus,
          {
            argv: input.command,
            cwd: worktreePath,
            exitCode: execution.exitCode,
            signal: execution.signal,
            durationMs: execution.durationMs,
            stdout: outputSummary(execution.stdout, stdout.hash, stdout.redactionState),
            stderr: outputSummary(execution.stderr, stderr.hash, stderr.redactionState),
            simulated: false,
            externalSideEffects: "denied"
          },
          [`sha256:${stdout.hash}`, `sha256:${stderr.hash}`]
        ),
        replayEvent(
          targetRun.id,
          "file.diff_created",
          "success",
          {
            changedPaths,
            changedFileCount: changedPaths.length,
            diffAvailable: diffBlob !== undefined,
            replayWorkspace: worktreePath
          },
          diffBlob === undefined ? [] : [`sha256:${diffBlob.hash}`]
        ),
        replayEvent(targetRun.id, "replay.completed", commandStatus, {
          replayId,
          checkpointId: checkpoint.id,
          exitCode: execution.exitCode,
          changedPaths,
          worktreePath
        })
      ]);
      this.store.transitionRun(
        targetRun.id,
        execution.exitCode === 0 ? "completed" : "failed",
        "afr-replay-worker",
        execution.exitCode === 0 ? "Isolated replay completed" : `Replay exited with ${execution.exitCode}`
      );
      replay = this.store.transitionReplay({
        replayId,
        status: execution.exitCode === 0 ? "completed" : "failed",
        at: completedAt,
        comparison: compareRuns(this.store, sourceRun.id, targetRun.id),
        ...(execution.exitCode === 0
          ? {}
          : { errorCode: "execution_failed", errorMessage: `Command exited with ${execution.exitCode}` })
      });
    } catch (error) {
      const replayError = normalizeReplayError(error);
      const currentRun = this.store.getRun(targetRun.id);
      if (currentRun !== undefined && !isTerminalRunStatus(currentRun.status)) {
        this.store.appendEvents(targetRun.id, [
          replayEvent(targetRun.id, "replay.completed", "error", {
            replayId,
            checkpointId: checkpoint.id,
            errorCode: replayError.code,
            message: replayError.message,
            worktreePath
          })
        ]);
        this.store.transitionRun(
          targetRun.id,
          "failed",
          "afr-replay-worker",
          `${replayError.code}: ${replayError.message}`
        );
      }
      replay = this.store.transitionReplay({
        replayId,
        status: "failed",
        at: this.now().toISOString(),
        comparison: compareRuns(this.store, sourceRun.id, targetRun.id),
        errorCode: replayError.code,
        errorMessage: replayError.message
      });
    }

    const sourceWorkspaceHashAfter = workspaceFingerprint(checkpoint.workspaceRoot, manifest);
    if (sourceWorkspaceHashAfter !== sourceWorkspaceHashBefore) {
      const error = new ReplayError(
        "source_workspace_changed",
        "Original workspace changed during replay"
      );
      if (replay.status === "running") {
        replay = this.store.transitionReplay({
          replayId,
          status: "failed",
          at: this.now().toISOString(),
          errorCode: error.code,
          errorMessage: error.message
        });
      }
      throw error;
    }
    return { replay, sourceWorkspaceHashBefore, sourceWorkspaceHashAfter };
  }

}

export function workspaceFingerprint(workspaceRoot: string, manifest: WorkspaceManifest): string {
  const entries: Array<{ path: string; type: string; mode: number; hash: string }> = [];
  visitWorkspace(workspaceRoot, workspaceRoot, new Set(manifest.excludedDirectories), entries);
  return sha256(Buffer.from(canonicalJson(entries.sort((left, right) => left.path.localeCompare(right.path)))));
}

export function createDetachedWorktree(
  repositoryRoot: string,
  worktreePath: string,
  baseCommit: string
): void {
  mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o700 });
  try {
    gitText(repositoryRoot, ["worktree", "add", "--detach", worktreePath, baseCommit]);
  } catch (error) {
    throw new ReplayError("worktree_create_failed", errorMessage(error));
  }
}

export function restoreCheckpoint(
  store: LocalStore,
  worktreePath: string,
  checkpoint: CheckpointRecord,
  manifest: WorkspaceManifest
): void {
  try {
    if (checkpoint.trackedDiffBlobHash !== undefined) {
      const diff = store.getBlob(checkpoint.trackedDiffBlobHash);
      if (diff === undefined) throw new Error("Tracked diff Blob is missing");
      gitBuffer(worktreePath, ["apply", "--binary", "--whitespace=nowarn", "-"], diff.content);
    }
    for (const entry of manifest.entries.filter((item) => item.tracked && item.type === "file")) {
      chmodSync(resolveWorkspacePath(worktreePath, entry.path), entry.mode);
    }
    for (const entry of manifest.entries.filter((item) => !item.tracked)) {
      if (entry.blobHash === undefined) throw new Error(`Untracked Blob is missing: ${entry.path}`);
      const blob = store.getBlob(entry.blobHash);
      if (blob === undefined) throw new Error(`Untracked Blob is missing: ${entry.path}`);
      const destination = resolveWorkspacePath(worktreePath, entry.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      if (entry.type === "symlink") {
        symlinkSync(blob.content.toString("utf8"), destination);
      } else {
        writeFileSync(destination, blob.content, { mode: entry.mode });
        chmodSync(destination, entry.mode);
      }
    }
  } catch (error) {
    throw new ReplayError("checkpoint_restore_failed", errorMessage(error));
  }
}

export function verifyCheckpointManifest(worktreePath: string, manifest: WorkspaceManifest): void {
  for (const entry of manifest.entries) {
    const path = resolveWorkspacePath(worktreePath, entry.path);
    if (!existsSync(path) && !lstatExists(path)) {
      throw new ReplayError("checkpoint_verification_failed", `Restored path is missing: ${entry.path}`);
    }
    const actual = readManifestEntry(path, entry.path, entry.tracked);
    if (
      actual.type !== entry.type ||
      actual.mode !== entry.mode ||
      actual.size !== entry.size ||
      actual.contentHash !== entry.contentHash
    ) {
      throw new ReplayError(
        "checkpoint_verification_failed",
        `Restored path does not match checkpoint: ${entry.path}`
      );
    }
  }
  const actualPaths = gitVisiblePaths(worktreePath).filter(
    (path) => !isExcluded(path, new Set(manifest.excludedDirectories))
  );
  const expectedPaths = manifest.entries.map((entry) => entry.path).sort();
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    throw new ReplayError(
      "checkpoint_verification_failed",
      "Restored workspace file set does not match checkpoint manifest"
    );
  }
}

function validateReplayCommandShape(command: string[]): void {
  if (
    command.length < 2 ||
    command.length > 100 ||
    command.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))
  ) {
    throw new ReplayError("invalid_command", "Replay command must be a non-empty argv array");
  }
}

function enforceReplayCommandPolicy(command: string[]): void {
  const executable = basename(command[0] ?? "");
  const blocked = new Set([
    "curl", "wget", "ssh", "scp", "rsync", "nc", "mail", "rm", "rmdir", "unlink",
    "git", "npm", "pnpm", "yarn", "bun", "sh", "bash", "zsh", "fish"
  ]);
  if (blocked.has(executable)) {
    throw new ReplayError(
      "side_effect_blocked",
      `Replay command is blocked because it can cause external or destructive side effects: ${executable}`
    );
  }
  if (executable !== "node") {
    throw new ReplayError(
      "invalid_command",
      "MVP Isolated Live replay supports a repository-local Node script only"
    );
  }
  const script = command[1] ?? "";
  if (script.startsWith("-") || isAbsolute(script) || script.split(/[\\/]/).includes("..")) {
    throw new ReplayError("invalid_command", "Replay script must be a repository-local relative path");
  }
  if (command.slice(2).some((part) => /^https?:\/\//i.test(part) || isAbsolute(part))) {
    throw new ReplayError("side_effect_blocked", "URLs and absolute paths are blocked in replay arguments");
  }
}

function sandboxProfile(worktreePath: string): string {
  const escaped = sandboxString(worktreePath);
  return `(version 1)
(deny default)
(allow process*)
(allow file-read*)
(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper") (subpath "${escaped}"))
(allow sysctl-read)
(allow mach-lookup)
(deny network*)`;
}

function sandboxString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function minimalEnvironment(home: string, temporary: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: temporary,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    AFR_REPLAY_MODE: "isolated-live",
    AFR_EXTERNAL_SIDE_EFFECTS: "denied",
    NO_PROXY: "",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9"
  };
}

function replayEvent(
  runId: string,
  eventType: EventType,
  status: EventStatus,
  payload: Record<string, unknown>,
  blobRefs: string[] = []
): IncomingEvent {
  const eventId = uuidv7();
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    runId,
    idempotencyKey: `afr-replay:${eventId}`,
    occurredAt: new Date().toISOString(),
    actor: { type: "system", id: "afr-replay-worker" },
    eventType,
    status,
    payload,
    ...(blobRefs.length === 0 ? {} : { blobRefs })
  };
}

function gitVisiblePaths(worktreePath: string): string[] {
  const tracked = splitNull(gitBuffer(worktreePath, ["ls-files", "-z"]));
  const untracked = splitNull(
    gitBuffer(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])
  );
  return [...new Set([...tracked, ...untracked])]
    .filter((path) => lstatExists(resolve(worktreePath, path)))
    .sort();
}

export function gitChangedPaths(worktreePath: string): string[] {
  return splitNull(gitBuffer(worktreePath, ["status", "--porcelain=v1", "-z"]))
    .map((entry) => entry.slice(3))
    .filter((path) => path.length > 0 && !path.startsWith(".afr/"))
    .sort();
}

export function workspaceChangedPathsFromManifest(
  worktreePath: string,
  manifest: WorkspaceManifest,
  limits: WorkspaceChangeLimits = {}
): string[] {
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const actualPaths = gitVisiblePaths(worktreePath).filter(
    (path) => !isExcluded(path, new Set(manifest.excludedDirectories))
  );
  assertWorkspaceEntriesWithinLimits(worktreePath, actualPaths, limits);
  const changed = new Set<string>();
  for (const path of new Set([...expected.keys(), ...actualPaths])) {
    const entry = expected.get(path);
    const absolute = resolveWorkspacePath(worktreePath, path);
    if (entry === undefined || !lstatExists(absolute)) {
      changed.add(path);
      continue;
    }
    const actual = readManifestEntry(absolute, path, entry.tracked);
    if (
      actual.type !== entry.type ||
      actual.mode !== entry.mode ||
      actual.size !== entry.size ||
      actual.contentHash !== entry.contentHash
    ) {
      changed.add(path);
    }
  }
  return [...changed].sort();
}

export function readWorktreeDiff(worktreePath: string): Buffer {
  return gitBuffer(worktreePath, ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."]);
}

export function readWorkspaceDiffAgainstSource(
  sourceWorkspaceRoot: string,
  worktreePath: string,
  changedPaths: readonly string[],
  maxDiffBytes = DEFAULT_WORKSPACE_CHANGE_LIMITS.maxDiffBytes
): Buffer {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (const path of changedPaths) {
    const sourcePath = resolveWorkspacePath(sourceWorkspaceRoot, path);
    const worktreeFile = resolveWorkspacePath(worktreePath, path);
    const before = lstatExists(sourcePath) ? sourcePath : "/dev/null";
    const after = lstatExists(worktreeFile) ? worktreeFile : "/dev/null";
    const result = spawnSync(
      "git",
      safeGitArgs(undefined, ["diff", "--no-index", "--binary", "--no-ext-diff", "--", before, after]),
      { encoding: "buffer", maxBuffer: maxDiffBytes + 1, stdio: ["ignore", "pipe", "pipe"] }
    );
    if (result.error !== undefined) {
      throw new ReplayError(
        "workspace_limit_exceeded",
        `Hosted workspace diff exceeded the ${maxDiffBytes} byte limit`
      );
    }
    if (result.status !== 0 && result.status !== 1) {
      throw new ReplayError(
        "execution_failed",
        `Could not capture Hosted workspace diff for ${path}: ${result.stderr?.toString("utf8") ?? "unknown error"}`
      );
    }
    if (result.stdout !== null && result.stdout.byteLength > 0) {
      totalBytes += result.stdout.byteLength;
      if (totalBytes > maxDiffBytes) {
        throw new ReplayError(
          "workspace_limit_exceeded",
          `Hosted workspace diff exceeded the ${maxDiffBytes} byte limit`
        );
      }
      chunks.push(result.stdout);
    }
  }
  return Buffer.concat(chunks);
}

export function removeDetachedWorktree(repositoryRoot: string, worktreePath: string): void {
  try {
    if (existsSync(worktreePath)) {
      gitText(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
    }
    gitText(repositoryRoot, ["worktree", "prune"]);
  } catch (error) {
    throw new ReplayError("worktree_create_failed", `Failed to clean detached worktree: ${errorMessage(error)}`);
  }
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync("git", safeGitArgs(cwd, args), {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function gitBuffer(cwd: string, args: string[], input?: Buffer): Buffer {
  return execFileSync("git", safeGitArgs(cwd, args), {
    encoding: "buffer",
    input,
    maxBuffer: 128 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });
}

function safeGitArgs(cwd: string | undefined, args: string[]): string[] {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.file.allow=never",
    "-c", "protocol.ext.allow=never",
    ...(cwd === undefined ? [] : ["-C", cwd]),
    ...args
  ];
}

function assertWorkspaceEntriesWithinLimits(
  worktreePath: string,
  paths: readonly string[],
  limits: WorkspaceChangeLimits
): void {
  const maxFiles = limits.maxFiles ?? DEFAULT_WORKSPACE_CHANGE_LIMITS.maxFiles;
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_WORKSPACE_CHANGE_LIMITS.maxFileBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_WORKSPACE_CHANGE_LIMITS.maxTotalBytes;
  if (paths.length > maxFiles) {
    throw new ReplayError(
      "workspace_limit_exceeded",
      `Hosted workspace contains ${paths.length} files; limit is ${maxFiles}`
    );
  }
  let totalBytes = 0;
  for (const path of paths) {
    const absolute = resolveWorkspacePath(worktreePath, path);
    const metadata = lstatSync(absolute);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new ReplayError(
        "workspace_limit_exceeded",
        `Hosted workspace contains an unsupported entry: ${path}`
      );
    }
    const byteSize = metadata.isSymbolicLink()
      ? Buffer.byteLength(readlinkSync(absolute), "utf8")
      : metadata.size;
    if (byteSize > maxFileBytes) {
      throw new ReplayError(
        "workspace_limit_exceeded",
        `Hosted workspace file exceeds ${maxFileBytes} bytes: ${path}`
      );
    }
    totalBytes += byteSize;
    if (totalBytes > maxTotalBytes) {
      throw new ReplayError(
        "workspace_limit_exceeded",
        `Hosted workspace exceeds the ${maxTotalBytes} byte total limit`
      );
    }
  }
}

function splitNull(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function readManifestEntry(path: string, relativePath: string, tracked: boolean): WorkspaceManifestEntry {
  const metadata = lstatSync(path);
  const content = metadata.isSymbolicLink()
    ? Buffer.from(readlinkSync(path), "utf8")
    : readFileSync(path);
  return {
    path: relativePath,
    type: metadata.isSymbolicLink() ? "symlink" : "file",
    mode: metadata.mode & 0o777,
    size: content.byteLength,
    mtimeMs: Math.trunc(metadata.mtimeMs),
    contentHash: sha256(content),
    tracked
  };
}

function visitWorkspace(
  root: string,
  directory: string,
  excluded: Set<string>,
  result: Array<{ path: string; type: string; mode: number; hash: string }>
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || excluded.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) {
      visitWorkspace(root, absolute, excluded, result);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const metadata = lstatSync(absolute);
      const content = entry.isSymbolicLink()
        ? Buffer.from(readlinkSync(absolute), "utf8")
        : readFileSync(absolute);
      result.push({
        path,
        type: entry.isSymbolicLink() ? "symlink" : "file",
        mode: metadata.mode & 0o777,
        hash: sha256(content)
      });
    }
  }
}

function isExcluded(path: string, excluded: Set<string>): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => excluded.has(segment))) return true;
  const name = segments.at(-1) ?? "";
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

function outputSummary(
  text: string,
  hash: string,
  redactionState: "redacted" | "scanned" | "unscanned"
): Record<string, unknown> {
  const limit = 8_192;
  return {
    text: text.length <= limit ? text : `${text.slice(0, limit / 2)}\n… output omitted …\n${text.slice(-limit / 2)}`,
    truncated: text.length > limit,
    byteSize: Buffer.byteLength(text),
    blobRef: `sha256:${hash}`,
    redactionState
  };
}

function normalizeReplayError(error: unknown): ReplayError {
  if (error instanceof ReplayError) return error;
  return new ReplayError("execution_failed", errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
