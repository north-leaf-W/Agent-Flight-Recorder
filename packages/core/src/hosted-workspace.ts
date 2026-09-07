import { join } from "node:path";

import { EVENT_SCHEMA_VERSION, type IncomingEvent } from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import { CheckpointManager, type CheckpointResult } from "./checkpoint.js";
import {
  ReplayError,
  createDetachedWorktree,
  readWorkspaceDiffAgainstSource,
  removeDetachedWorktree,
  restoreCheckpoint,
  verifyCheckpointManifest,
  workspaceChangedPathsFromManifest,
  workspaceFingerprint
} from "./replay.js";
import type { WorkspaceChangeLimits } from "./replay.js";
import { LocalStore, type HostedWorkspaceRecord } from "./local-store.js";

export type HostedWorkspacePrepareInput = {
  runId: string;
  checkpointId?: string;
};

export type HostedWorkspacePrepareResult = {
  workspace: HostedWorkspaceRecord;
  checkpoint: CheckpointResult["checkpoint"];
};

export type HostedWorkspaceFinalizeResult = {
  workspace: HostedWorkspaceRecord;
  sourceUnchanged: boolean;
};

export type HostedWorkspaceRecoveryReport = {
  incompleteWorkspaces: number;
  cleanedWorkspaces: number;
  cleanupFailures: number;
};

export type HostedWorkspaceErrorCode =
  | "run_not_found"
  | "workspace_exists"
  | "checkpoint_invalid"
  | "invalid_state"
  | "source_workspace_changed"
  | "workspace_limit_exceeded"
  | "workspace_prepare_failed"
  | "workspace_finalize_failed"
  | "workspace_cleanup_failed";

export class HostedWorkspaceError extends Error {
  constructor(readonly code: HostedWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "HostedWorkspaceError";
  }
}

export class HostedWorkspaceManager {
  private readonly checkpoints: CheckpointManager;

  constructor(
    private readonly store: LocalStore,
    private readonly now = () => new Date(),
    private readonly limits: WorkspaceChangeLimits & { maxDiffBytes?: number } = {}
  ) {
    this.checkpoints = new CheckpointManager(store, now);
  }

  prepare(input: HostedWorkspacePrepareInput): HostedWorkspacePrepareResult {
    const run = this.store.getRun(input.runId);
    if (run === undefined) {
      throw new HostedWorkspaceError("run_not_found", `Run does not exist: ${input.runId}`);
    }
    if (this.store.getHostedWorkspaceByRun(run.id) !== undefined) {
      throw new HostedWorkspaceError(
        "workspace_exists",
        `Run already has a Hosted workspace: ${run.id}`
      );
    }

    const checkpoint = input.checkpointId === undefined
      ? this.checkpoints.create(run.id).checkpoint
      : this.store.getCheckpoint(input.checkpointId);
    if (checkpoint === undefined || checkpoint.runId !== run.id) {
      throw new HostedWorkspaceError(
        "checkpoint_invalid",
        `Checkpoint does not belong to Run: ${input.checkpointId ?? "unknown"}`
      );
    }
    const manifest = this.checkpoints.readManifest(checkpoint.id);
    const sourceFingerprintBefore = workspaceFingerprint(checkpoint.workspaceRoot, manifest);
    const workspaceId = uuidv7();
    const worktreePath = join(this.store.dataDir, "hosted-workspaces", workspaceId);
    const createdAt = this.now().toISOString();
    let workspace = this.store.createHostedWorkspace({
      id: workspaceId,
      runId: run.id,
      checkpointId: checkpoint.id,
      sourceWorkspaceRoot: checkpoint.workspaceRoot,
      worktreePath,
      baseCommit: checkpoint.baseCommit,
      sourceFingerprintBefore,
      createdAt
    });

    try {
      createDetachedWorktree(checkpoint.workspaceRoot, worktreePath, checkpoint.baseCommit);
      restoreCheckpoint(this.store, worktreePath, checkpoint, manifest);
      verifyCheckpointManifest(worktreePath, manifest);
      workspace = this.store.transitionHostedWorkspace({
        workspaceId,
        status: "ready",
        at: this.now().toISOString()
      });
      this.store.appendEvents(run.id, [workspaceEvent(run.id, "artifact.created", "success", {
        kind: "hosted_workspace",
        workspaceId,
        checkpointId: checkpoint.id,
        worktreePath,
        baseCommit: checkpoint.baseCommit,
        sourceFingerprintBefore,
        isolation: "detached-git-worktree"
      })]);
      return { workspace, checkpoint };
    } catch (error) {
      const message = errorMessage(error);
      const current = this.store.getHostedWorkspace(workspaceId);
      if (current?.status === "preparing" || current?.status === "ready") {
        this.store.transitionHostedWorkspace({
          workspaceId,
          status: "failed",
          at: this.now().toISOString(),
          errorCode: error instanceof ReplayError ? error.code : "workspace_prepare_failed",
          errorMessage: message
        });
      }
      throw new HostedWorkspaceError("workspace_prepare_failed", message);
    }
  }

  activate(workspaceId: string): HostedWorkspaceRecord {
    const workspace = this.requireWorkspace(workspaceId);
    if (workspace.status !== "ready") {
      throw new HostedWorkspaceError(
        "invalid_state",
        `Hosted workspace cannot be activated from ${workspace.status}: ${workspaceId}`
      );
    }
    return this.store.transitionHostedWorkspace({
      workspaceId,
      status: "active",
      at: this.now().toISOString()
    });
  }

  finalize(workspaceId: string): HostedWorkspaceFinalizeResult {
    const workspace = this.requireWorkspace(workspaceId);
    if (workspace.status !== "ready" && workspace.status !== "active") {
      throw new HostedWorkspaceError(
        "invalid_state",
        `Hosted workspace cannot be finalized from ${workspace.status}: ${workspaceId}`
      );
    }
    const checkpoint = this.store.getCheckpoint(workspace.checkpointId);
    if (checkpoint === undefined) {
      throw new HostedWorkspaceError("checkpoint_invalid", `Checkpoint is missing: ${workspace.checkpointId}`);
    }
    const manifest = this.checkpoints.readManifest(checkpoint.id);

    try {
      const changedPaths = workspaceChangedPathsFromManifest(
        workspace.worktreePath,
        manifest,
        this.limits
      );
      const diff = readWorkspaceDiffAgainstSource(
        workspace.sourceWorkspaceRoot,
        workspace.worktreePath,
        changedPaths,
        this.limits.maxDiffBytes
      );
      const diffBlob = diff.byteLength === 0
        ? undefined
        : this.store.putBlob(diff, "text/x-diff");
      const sourceFingerprintAfter = workspaceFingerprint(workspace.sourceWorkspaceRoot, manifest);
      const sourceUnchanged = sourceFingerprintAfter === workspace.sourceFingerprintBefore;
      const status = sourceUnchanged ? "finalized" : "failed";
      const finalized = this.store.transitionHostedWorkspace({
        workspaceId,
        status,
        at: this.now().toISOString(),
        sourceFingerprintAfter,
        changedPaths,
        ...(diffBlob === undefined ? {} : { diffBlobHash: diffBlob.hash }),
        ...(sourceUnchanged
          ? {}
          : {
              errorCode: "source_workspace_changed",
              errorMessage: "Original source workspace changed during Hosted execution"
            })
      });
      this.store.appendEvents(workspace.runId, [
        workspaceEvent(
          workspace.runId,
          "file.diff_created",
          sourceUnchanged ? "success" : "error",
          {
            workspaceId,
            checkpointId: checkpoint.id,
            worktreePath: workspace.worktreePath,
            changedPaths,
            changedFileCount: changedPaths.length,
            diffAvailable: diffBlob !== undefined,
            sourceUnchanged,
            sourceFingerprintBefore: workspace.sourceFingerprintBefore,
            sourceFingerprintAfter
          },
          diffBlob === undefined ? [] : [`sha256:${diffBlob.hash}`]
        ),
        ...(sourceUnchanged
          ? []
          : [workspaceEvent(workspace.runId, "collection.gap_detected", "error", {
              reason: "source_workspace_changed",
              workspaceId,
              sourceFingerprintBefore: workspace.sourceFingerprintBefore,
              sourceFingerprintAfter
            })])
      ]);
      this.store.recomputeRunCoverage(workspace.runId);
      if (!sourceUnchanged) {
        throw new HostedWorkspaceError(
          "source_workspace_changed",
          "Original source workspace changed during Hosted execution"
        );
      }
      return { workspace: finalized, sourceUnchanged };
    } catch (error) {
      if (error instanceof HostedWorkspaceError) throw error;
      const message = errorMessage(error);
      const errorCode = error instanceof ReplayError && error.code === "workspace_limit_exceeded"
        ? "workspace_limit_exceeded"
        : "workspace_finalize_failed";
      const current = this.store.getHostedWorkspace(workspaceId);
      if (current?.status === "ready" || current?.status === "active") {
        this.store.transitionHostedWorkspace({
          workspaceId,
          status: "failed",
          at: this.now().toISOString(),
          errorCode,
          errorMessage: message
        });
      }
      throw new HostedWorkspaceError(errorCode, message);
    }
  }

  cleanup(workspaceId: string): HostedWorkspaceRecord {
    const workspace = this.requireWorkspace(workspaceId);
    if (workspace.status !== "finalized" && workspace.status !== "failed") {
      throw new HostedWorkspaceError(
        "invalid_state",
        `Hosted workspace cannot be cleaned from ${workspace.status}: ${workspaceId}`
      );
    }
    try {
      removeDetachedWorktree(workspace.sourceWorkspaceRoot, workspace.worktreePath);
      return this.store.transitionHostedWorkspace({
        workspaceId,
        status: "cleaned",
        at: this.now().toISOString()
      });
    } catch (error) {
      throw new HostedWorkspaceError("workspace_cleanup_failed", errorMessage(error));
    }
  }

  recoverIncomplete(): HostedWorkspaceRecoveryReport {
    const incomplete = this.store.listHostedWorkspaces().filter(
      ({ status }) => status === "preparing" || status === "ready"
    );
    let cleanedWorkspaces = 0;
    let cleanupFailures = 0;
    for (const workspace of incomplete) {
      const at = this.now().toISOString();
      this.store.transitionHostedWorkspace({
        workspaceId: workspace.id,
        status: "failed",
        at,
        errorCode: "host_restarted_during_setup",
        errorMessage: "AFR restarted before the Hosted workspace became active"
      });
      this.store.appendEvents(workspace.runId, [workspaceEvent(
        workspace.runId,
        "collection.gap_detected",
        "error",
        {
          reason: "host_restarted_during_workspace_setup",
          workspaceId: workspace.id,
          previousWorkspaceStatus: workspace.status
        }
      )]);
      const run = this.store.getRun(workspace.runId);
      if (run !== undefined && !["completed", "failed", "cancelled"].includes(run.status)) {
        this.store.transitionRun(
          run.id,
          "failed",
          "afr-recovery",
          `hosted-workspace:${workspace.id}`
        );
      }
      try {
        this.cleanup(workspace.id);
        cleanedWorkspaces += 1;
      } catch {
        cleanupFailures += 1;
      }
    }
    return {
      incompleteWorkspaces: incomplete.length,
      cleanedWorkspaces,
      cleanupFailures
    };
  }

  private requireWorkspace(workspaceId: string): HostedWorkspaceRecord {
    const workspace = this.store.getHostedWorkspace(workspaceId);
    if (workspace === undefined) {
      throw new HostedWorkspaceError("invalid_state", `Hosted workspace does not exist: ${workspaceId}`);
    }
    return workspace;
  }
}

function workspaceEvent(
  runId: string,
  eventType: IncomingEvent["eventType"],
  status: IncomingEvent["status"],
  payload: Record<string, unknown>,
  blobRefs: string[] = []
): IncomingEvent {
  const eventId = uuidv7();
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    runId,
    idempotencyKey: `hosted-workspace:${eventId}`,
    occurredAt: new Date().toISOString(),
    actor: { type: "system", id: "afr-hosted-workspace-manager" },
    eventType,
    status,
    payload,
    ...(blobRefs.length === 0 ? {} : { blobRefs })
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
