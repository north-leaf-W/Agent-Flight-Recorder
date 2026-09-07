import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { EVENT_SCHEMA_VERSION, type ActionContext, type IncomingEvent } from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import { ApprovalService, type ActionEvaluation } from "./approval.js";
import { LocalStore, type GatewayActionRecord, type SnapshotRecord } from "./local-store.js";

const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export class GatewayValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GatewayValidationError";
  }
}

export class GatewayDeniedError extends Error {
  constructor(readonly evaluation: ActionEvaluation) {
    super(`Gateway action denied by ${evaluation.decision.ruleId}`);
    this.name = "GatewayDeniedError";
  }
}

export type DeleteRequestResult = {
  evaluation: ActionEvaluation;
  snapshot: SnapshotRecord;
  action: GatewayActionRecord;
};

export class FileGateway {
  private readonly now: () => Date;

  constructor(
    readonly store: LocalStore,
    readonly approvals: ApprovalService,
    now: () => Date = () => new Date()
  ) {
    this.now = now;
  }

  requestDelete(runId: string, requestedPath: string, reason?: string): DeleteRequestResult {
    const run = this.store.getRun(runId);
    if (run === undefined) throw new GatewayValidationError("run_not_found", `Run not found: ${runId}`);
    if (run.status !== "running") {
      throw new GatewayValidationError("run_not_running", `Run is not running: ${run.status}`);
    }
    const inspected = inspectDeleteTarget(run.projectPath, requestedPath);
    const requestedAt = this.now().toISOString();
    const context: ActionContext = {
      runId,
      actor: { id: run.agentId, type: "agent" },
      tool: "file.gateway",
      action: "delete",
      argv: ["unlink", inspected.path],
      cwd: inspected.projectRoot,
      targets: [{ type: "file", canonicalId: inspected.path }],
      environment: "local",
      sideEffect: "irreversible",
      recoverability: "partial",
      contentHash: inspected.contentHash,
      estimatedImpact: { files: 1, bytes: inspected.content.byteLength }
    };
    this.store.appendEvents(runId, [{
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId,
      occurredAt: requestedAt,
      actor: { type: "system", id: "afr-gateway" },
      eventType: "tool.call_requested",
      status: "pending",
      payload: { tool: "file.gateway", action: "delete", path: inspected.path }
    }]);
    const snapshot = this.snapshotFile(runId, inspected.path, inspected.content, inspected.contentHash);
    if (!snapshot.exact) {
      throw new GatewayValidationError(
        "snapshot_not_exact",
        "Deletion is blocked because the persisted snapshot was redacted and cannot restore exact content"
      );
    }
    const evaluation = this.approvals.evaluate(context, reason);
    if (evaluation.decision.effect === "deny") {
      throw new GatewayDeniedError(evaluation);
    }
    const action = this.store.createGatewayAction({
      id: uuidv7(),
      runId,
      ...(evaluation.approval === undefined ? {} : { approvalId: evaluation.approval.id }),
      snapshotId: snapshot.id,
      kind: "file_delete",
      actionDigest: evaluation.actionDigest,
      actionContext: context,
      targetPath: inspected.path,
      requestedAt
    });
    if (evaluation.approval !== undefined) {
      this.store.linkApprovalSnapshot(evaluation.approval.id, snapshot.id);
      return {
        evaluation: { ...evaluation, approval: this.approvals.get(evaluation.approval.id)! },
        snapshot,
        action
      };
    }
    if (evaluation.grant === undefined) {
      throw new GatewayValidationError("grant_missing", "Allowed action did not receive a grant");
    }
    return {
      evaluation,
      snapshot,
      action: this.execute(action, evaluation.grant.token)
    };
  }

  requestCommand(runId: string, argv: string[], reason?: string): DeleteRequestResult {
    const target = parseSupportedDelete(argv);
    if (target === undefined) {
      throw new GatewayValidationError(
        "command_unsupported",
        "The MVP Command Gateway only supports a single-file rm/unlink request without shell expansion"
      );
    }
    return this.requestDelete(runId, target, reason);
  }

  resolveApproval(
    approvalId: string,
    decision: "approved" | "denied",
    grantToken?: string
  ): GatewayActionRecord | undefined {
    const action = this.store.getGatewayActionByApproval(approvalId);
    if (action === undefined) return undefined;
    const at = this.now().toISOString();
    if (decision === "denied") {
      return this.store.transitionGatewayAction({
        actionId: action.id,
        status: "denied",
        at,
        errorCode: "approval_denied",
        resultEvent: gatewayFailureEvent(action, "approval_denied", "User denied the action", at, "cancelled")
      });
    }
    if (grantToken === undefined) {
      throw new GatewayValidationError("grant_missing", "Approved gateway action has no grant");
    }
    return this.execute(action, grantToken);
  }

  private execute(action: GatewayActionRecord, grantToken: string): GatewayActionRecord {
    const executingAt = this.now().toISOString();
    const executing = this.store.transitionGatewayAction({
      actionId: action.id,
      status: "executing",
      at: executingAt
    });
    try {
      const inspected = inspectDeleteTarget(executing.actionContext.cwd!, executing.targetPath);
      const actualContext: ActionContext = {
        ...executing.actionContext,
        cwd: inspected.projectRoot,
        argv: ["unlink", inspected.path],
        targets: [{ type: "file", canonicalId: inspected.path }],
        contentHash: inspected.contentHash,
        estimatedImpact: { files: 1, bytes: inspected.content.byteLength }
      };
      this.approvals.consume(grantToken, actualContext);
      unlinkSync(inspected.path);
      const completedAt = this.now().toISOString();
      return this.store.transitionGatewayAction({
        actionId: executing.id,
        status: "completed",
        at: completedAt,
        resultEvent: {
          schemaVersion: EVENT_SCHEMA_VERSION,
          eventId: uuidv7(),
          runId: executing.runId,
          occurredAt: completedAt,
          actor: { type: "system", id: "afr-gateway" },
          eventType: "file.deleted",
          status: "success",
          payload: {
            path: inspected.path,
            beforeHash: inspected.contentHash,
            gatewayActionId: executing.id,
            approvalId: executing.approvalId,
            snapshotId: executing.snapshotId
          },
          ...(executing.snapshotId === undefined ? {} : { snapshotBefore: executing.snapshotId })
        }
      });
    } catch (error) {
      const failedAt = this.now().toISOString();
      return this.store.transitionGatewayAction({
        actionId: executing.id,
        status: "failed",
        at: failedAt,
        errorCode: error instanceof GatewayValidationError ? error.code : "execution_rejected",
        resultEvent: gatewayFailureEvent(
          executing,
          error instanceof GatewayValidationError ? error.code : "execution_rejected",
          error instanceof Error ? error.message : String(error),
          failedAt,
          "error"
        )
      });
    }
  }

  private snapshotFile(
    runId: string,
    path: string,
    content: Buffer,
    beforeHash: string
  ): SnapshotRecord {
    const mediaType = isUtf8(content) ? "text/plain; charset=utf-8" : "application/octet-stream";
    const blob = this.store.putBlob(content, mediaType);
    const snapshotId = uuidv7();
    const createdAt = this.now().toISOString();
    return this.store.createSnapshot({
      id: snapshotId,
      runId,
      path,
      contentBlobHash: blob.hash,
      beforeHash,
      byteSize: content.byteLength,
      exact: blob.hash === beforeHash,
      createdAt,
      event: {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: uuidv7(),
        runId,
        occurredAt: createdAt,
        actor: { type: "system", id: "afr-gateway" },
        eventType: "snapshot.created",
        status: "success",
        payload: {
          snapshotId,
          kind: "file",
          path,
          beforeHash,
          contentBlobRef: `sha256:${blob.hash}`,
          byteSize: content.byteLength,
          exact: blob.hash === beforeHash
        },
        blobRefs: [`sha256:${blob.hash}`]
      }
    });
  }
}

function inspectDeleteTarget(projectPath: string, requestedPath: string): {
  projectRoot: string;
  path: string;
  content: Buffer;
  contentHash: string;
} {
  if (requestedPath.trim() === "") {
    throw new GatewayValidationError("target_missing", "Delete target is required");
  }
  const projectRoot = realpathSync(resolve(projectPath));
  const candidate = resolve(projectRoot, requestedPath);
  if (!isWithin(candidate, projectRoot) || candidate === projectRoot) {
    throw new GatewayValidationError("target_outside_project", "Delete target is outside the project");
  }
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch {
    throw new GatewayValidationError("target_missing", "Delete target does not exist");
  }
  if (stat.isSymbolicLink()) {
    throw new GatewayValidationError("symlink_rejected", "Deleting symlinks is not supported by the MVP Gateway");
  }
  if (!stat.isFile()) {
    throw new GatewayValidationError("target_not_file", "The MVP Gateway only deletes regular files");
  }
  if (stat.size > MAX_SNAPSHOT_BYTES) {
    throw new GatewayValidationError("snapshot_too_large", "File is too large for the MVP snapshot limit");
  }
  const realTarget = realpathSync(candidate);
  if (!isWithin(realTarget, projectRoot)) {
    throw new GatewayValidationError("target_outside_project", "Resolved target is outside the project");
  }
  const content = readFileSync(realTarget);
  return {
    projectRoot,
    path: realTarget,
    content,
    contentHash: createHash("sha256").update(content).digest("hex")
  };
}

function parseSupportedDelete(argv: string[]): string | undefined {
  if (argv[0] === "unlink" && argv.length === 2 && argv[1] !== undefined) return argv[1];
  if (argv[0] !== "rm") return undefined;
  if (argv.length === 2 && argv[1] !== undefined && !argv[1].startsWith("-")) return argv[1];
  if (argv.length === 3 && argv[1] === "--" && argv[2] !== undefined) return argv[2];
  return undefined;
}

function gatewayFailureEvent(
  action: GatewayActionRecord,
  code: string,
  message: string,
  at: string,
  status: "cancelled" | "error"
): IncomingEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: uuidv7(),
    runId: action.runId,
    occurredAt: at,
    actor: { type: "system", id: "afr-gateway" },
    eventType: "tool.call_failed",
    status,
    payload: {
      tool: "file.gateway",
      action: "delete",
      path: action.targetPath,
      gatewayActionId: action.id,
      code,
      message
    }
  };
}

function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
