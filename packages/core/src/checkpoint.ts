import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { EVENT_SCHEMA_VERSION, type IncomingEvent } from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import { canonicalJson } from "./canonical-json.js";
import { type CheckpointRecord, LocalStore } from "./local-store.js";

export type WorkspaceManifestEntry = {
  path: string;
  type: "file" | "symlink";
  mode: number;
  size: number;
  mtimeMs: number;
  contentHash: string;
  tracked: boolean;
  blobHash?: string;
};

export type WorkspaceManifest = {
  schemaVersion: "1.0";
  baseCommit: string;
  entries: WorkspaceManifestEntry[];
  excludedDirectories: string[];
  createdAt: string;
};

export type CheckpointResult = {
  checkpoint: CheckpointRecord;
  manifest: WorkspaceManifest;
};

export type CheckpointManagerOptions = {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  additionalExcludedDirectories?: string[];
};

export type CheckpointErrorCode =
  | "run_not_found"
  | "not_git_repository"
  | "git_has_no_commit"
  | "source_event_invalid"
  | "unsupported_file_type"
  | "snapshot_too_large"
  | "sensitive_content";

export class CheckpointError extends Error {
  constructor(readonly code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

const DEFAULT_EXCLUDED_DIRECTORIES = [".git", "node_modules", "dist", "build", ".afr"];

export class CheckpointManager {
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxFiles: number;
  private readonly excludedDirectories: Set<string>;

  constructor(
    private readonly store: LocalStore,
    private readonly now = () => new Date(),
    options: CheckpointManagerOptions = {}
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 100 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 900;
    this.excludedDirectories = new Set([
      ...DEFAULT_EXCLUDED_DIRECTORIES,
      ...(options.additionalExcludedDirectories ?? [])
    ]);
  }

  create(runId: string, sourceEventId?: string): CheckpointResult {
    const run = this.store.getRun(runId);
    if (run === undefined) {
      throw new CheckpointError("run_not_found", `Run does not exist: ${runId}`);
    }
    if (sourceEventId !== undefined && this.store.getEvent(sourceEventId)?.runId !== runId) {
      throw new CheckpointError(
        "source_event_invalid",
        `Source event does not belong to Run: ${sourceEventId}`
      );
    }

    const workspaceRoot = this.resolveGitRoot(run.projectPath);
    const baseCommit = this.resolveBaseCommit(workspaceRoot);
    const trackedPaths = new Set(splitNull(gitBuffer(workspaceRoot, ["ls-files", "-z"])));
    const untrackedPaths = splitNull(
      gitBuffer(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    );
    const includedPaths = [...new Set([...trackedPaths, ...untrackedPaths])]
      .filter((path) => !this.isExcluded(path))
      .sort();

    if (includedPaths.length > this.maxFiles) {
      throw new CheckpointError(
        "snapshot_too_large",
        `Checkpoint contains ${includedPaths.length} files; limit is ${this.maxFiles}`
      );
    }

    const entries: WorkspaceManifestEntry[] = [];
    let totalBytes = 0;
    for (const path of includedPaths) {
      const absolutePath = resolveWorkspacePath(workspaceRoot, path);
      let metadata: ReturnType<typeof lstatSync>;
      try {
        metadata = lstatSync(absolutePath);
      } catch {
        continue;
      }
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        throw new CheckpointError("unsupported_file_type", `Unsupported workspace entry: ${path}`);
      }
      const content = metadata.isSymbolicLink()
        ? Buffer.from(readlinkSync(absolutePath), "utf8")
        : readFileSync(absolutePath);
      if (content.byteLength > this.maxFileBytes) {
        throw new CheckpointError(
          "snapshot_too_large",
          `Checkpoint file exceeds ${this.maxFileBytes} bytes: ${path}`
        );
      }
      totalBytes += content.byteLength;
      if (totalBytes > this.maxTotalBytes) {
        throw new CheckpointError(
          "snapshot_too_large",
          `Checkpoint exceeds total size limit of ${this.maxTotalBytes} bytes`
        );
      }

      const tracked = trackedPaths.has(path);
      let blobHash: string | undefined;
      if (!tracked) {
        const blob = this.store.putBlob(content, mediaTypeForSnapshot(content));
        if (blob.redactionState === "redacted") {
          throw new CheckpointError(
            "sensitive_content",
            `Untracked file contains sensitive content and was not checkpointed: ${path}`
          );
        }
        blobHash = blob.hash;
      }
      entries.push({
        path,
        type: metadata.isSymbolicLink() ? "symlink" : "file",
        mode: metadata.mode & 0o777,
        size: content.byteLength,
        mtimeMs: Math.trunc(metadata.mtimeMs),
        contentHash: sha256(content),
        tracked,
        ...(blobHash === undefined ? {} : { blobHash })
      });
    }

    const trackedDiff = gitBuffer(workspaceRoot, [
      "diff",
      "--binary",
      "--no-ext-diff",
      baseCommit,
      "--",
      ".",
      ...[...this.excludedDirectories].map((name) => `:(exclude)**/${name}/**`)
    ]);
    totalBytes += trackedDiff.byteLength;
    if (totalBytes > this.maxTotalBytes) {
      throw new CheckpointError(
        "snapshot_too_large",
        `Checkpoint exceeds total size limit of ${this.maxTotalBytes} bytes`
      );
    }

    let trackedDiffBlobHash: string | undefined;
    if (trackedDiff.byteLength > 0) {
      const diffBlob = this.store.putBlob(trackedDiff, "text/x-diff");
      if (diffBlob.redactionState === "redacted") {
        throw new CheckpointError(
          "sensitive_content",
          "Tracked diff contains sensitive content and was not checkpointed"
        );
      }
      trackedDiffBlobHash = diffBlob.hash;
    }

    const createdAt = this.now().toISOString();
    const manifest: WorkspaceManifest = {
      schemaVersion: "1.0",
      baseCommit,
      entries,
      excludedDirectories: [...this.excludedDirectories].sort(),
      createdAt
    };
    const manifestBlob = this.store.putBlob(Buffer.from(canonicalJson(manifest)), "application/json");
    const checkpointId = uuidv7();
    const event: IncomingEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId,
      ...(sourceEventId === undefined ? {} : { parentEventId: sourceEventId }),
      idempotencyKey: `checkpoint-created:${checkpointId}`,
      occurredAt: createdAt,
      actor: { type: "system", id: "afr-checkpoint-manager" },
      eventType: "checkpoint.created",
      status: "success",
      payload: {
        checkpointId,
        sourceEventId: sourceEventId ?? null,
        workspaceRoot,
        baseCommit,
        fileCount: entries.length,
        untrackedCount: entries.filter((entry) => !entry.tracked).length,
        totalBytes,
        excludedDirectories: manifest.excludedDirectories
      },
      blobRefs: [
        `sha256:${manifestBlob.hash}`,
        ...(trackedDiffBlobHash === undefined ? [] : [`sha256:${trackedDiffBlobHash}`]),
        ...entries.flatMap((entry) => entry.blobHash === undefined ? [] : [`sha256:${entry.blobHash}`])
      ]
    };
    const checkpoint = this.store.createCheckpoint({
      id: checkpointId,
      runId,
      ...(sourceEventId === undefined ? {} : { sourceEventId }),
      workspaceRoot,
      baseCommit,
      manifestBlobHash: manifestBlob.hash,
      ...(trackedDiffBlobHash === undefined ? {} : { trackedDiffBlobHash }),
      untrackedCount: entries.filter((entry) => !entry.tracked).length,
      totalBytes,
      createdAt,
      event
    });
    return { checkpoint, manifest };
  }

  readManifest(checkpointId: string): WorkspaceManifest {
    const checkpoint = this.store.getCheckpoint(checkpointId);
    if (checkpoint === undefined) {
      throw new CheckpointError("run_not_found", `Checkpoint does not exist: ${checkpointId}`);
    }
    const blob = this.store.getBlob(checkpoint.manifestBlobHash);
    if (blob === undefined) throw new Error(`Checkpoint manifest Blob is missing: ${checkpointId}`);
    return JSON.parse(blob.content.toString("utf8")) as WorkspaceManifest;
  }

  private resolveGitRoot(projectPath: string): string {
    try {
      const root = gitText(projectPath, ["rev-parse", "--show-toplevel"]);
      return realpathSync(root);
    } catch {
      throw new CheckpointError(
        "not_git_repository",
        `Checkpoint requires a Git repository: ${projectPath}`
      );
    }
  }

  private resolveBaseCommit(workspaceRoot: string): string {
    try {
      return gitText(workspaceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
    } catch {
      throw new CheckpointError(
        "git_has_no_commit",
        `Checkpoint requires a repository with at least one commit: ${workspaceRoot}`
      );
    }
  }

  private isExcluded(path: string): boolean {
    const segments = path.split("/");
    if (segments.some((segment) => this.excludedDirectories.has(segment))) return true;
    const basename = segments.at(-1) ?? "";
    return basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example");
  }
}

export function resolveWorkspacePath(workspaceRoot: string, path: string): string {
  if (isAbsolute(path) || path.includes("\0")) throw new Error(`Unsafe workspace path: ${path}`);
  const resolved = resolve(workspaceRoot, path);
  const prefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  if (resolved !== workspaceRoot && !resolved.startsWith(prefix)) {
    throw new Error(`Workspace path escapes root: ${path}`);
  }
  const normalized = relative(workspaceRoot, resolved).split(sep).join("/");
  if (normalized !== path) throw new Error(`Workspace path is not normalized: ${path}`);
  return resolved;
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync("git", safeGitArgs(cwd, args), {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync("git", safeGitArgs(cwd, args), {
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function safeGitArgs(cwd: string, args: string[]): string[] {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.file.allow=never",
    "-c", "protocol.ext.allow=never",
    "-C", cwd,
    ...args
  ];
}

function splitNull(buffer: Buffer): string[] {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((value) => value.length > 0);
}

function mediaTypeForSnapshot(content: Buffer): string {
  if (content.includes(0)) return "application/octet-stream";
  const text = content.toString("utf8");
  return Buffer.from(text, "utf8").equals(content) ? "text/plain" : "application/octet-stream";
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
