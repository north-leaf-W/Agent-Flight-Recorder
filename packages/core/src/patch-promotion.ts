import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { EVENT_SCHEMA_VERSION, type ActionContext, type IncomingEvent } from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import { ApprovalService, type ActionEvaluation } from "./approval.js";
import { canonicalJson } from "./canonical-json.js";
import { CheckpointManager, resolveWorkspacePath } from "./checkpoint.js";
import { LocalStore, type PatchPromotionRecord } from "./local-store.js";
import { workspaceChangedPathsFromManifest, workspaceFingerprint } from "./replay.js";

export type PromotionEntryState = {
  type: "file" | "symlink";
  mode: number;
  size: number;
  contentHash: string;
  blobHash: string;
  binary: boolean;
};

export type PatchPromotionPlan = {
  schemaVersion: "1.0";
  workspaceId: string;
  runId: string;
  selectedPaths: string[];
  sourceFingerprintBefore: string;
  worktreeFingerprintBefore: string;
  entries: Array<{
    path: string;
    before?: PromotionEntryState;
    after?: PromotionEntryState;
  }>;
  createdAt: string;
};

export type PatchPromotionRequest = {
  runId: string;
  selectedPaths?: string[];
  reason?: string;
};

export type PatchPromotionRequestResult = {
  evaluation: ActionEvaluation;
  promotion: PatchPromotionRecord;
  plan: PatchPromotionPlan;
};

export type PatchPromotionErrorCode =
  | "run_not_found"
  | "workspace_not_found"
  | "workspace_not_finalized"
  | "promotion_exists"
  | "paths_required"
  | "path_not_changed"
  | "changed_paths_mismatch"
  | "source_workspace_changed"
  | "worktree_changed"
  | "unsupported_entry"
  | "sensitive_content"
  | "plan_missing"
  | "plan_invalid"
  | "approval_required"
  | "grant_missing"
  | "symlink_parent"
  | "invalid_state"
  | "apply_failed"
  | "rollback_failed";

export class PatchPromotionError extends Error {
  constructor(readonly code: PatchPromotionErrorCode, message: string) {
    super(message);
    this.name = "PatchPromotionError";
  }
}

export class PatchPromotionGateway {
  private readonly checkpoints: CheckpointManager;

  constructor(
    readonly store: LocalStore,
    readonly approvals: ApprovalService,
    private readonly now: () => Date = () => new Date()
  ) {
    this.checkpoints = new CheckpointManager(store, now);
  }

  request(input: PatchPromotionRequest): PatchPromotionRequestResult {
    const run = this.store.getRun(input.runId);
    if (run === undefined) {
      throw new PatchPromotionError("run_not_found", `Run does not exist: ${input.runId}`);
    }
    const workspace = this.store.getHostedWorkspaceByRun(run.id);
    if (workspace === undefined) {
      throw new PatchPromotionError("workspace_not_found", `Hosted workspace does not exist: ${run.id}`);
    }
    if (workspace.status !== "finalized") {
      throw new PatchPromotionError(
        "workspace_not_finalized",
        `Hosted workspace must be finalized before Promotion: ${workspace.status}`
      );
    }
    if (this.store.getPatchPromotionByWorkspace(workspace.id) !== undefined) {
      throw new PatchPromotionError(
        "promotion_exists",
        `Hosted workspace already has a Patch Promotion: ${workspace.id}`
      );
    }

    const finalizedPaths = canonicalPaths(workspace.changedPaths);
    const selectedPaths = input.selectedPaths === undefined
      ? finalizedPaths
      : canonicalPaths(input.selectedPaths);
    if (selectedPaths.length === 0) {
      throw new PatchPromotionError("paths_required", "Patch Promotion requires at least one changed path");
    }
    for (const path of selectedPaths) {
      if (!finalizedPaths.includes(path)) {
        throw new PatchPromotionError("path_not_changed", `Path is not in the finalized change set: ${path}`);
      }
      assertSafeParentChain(workspace.sourceWorkspaceRoot, path, true);
      assertSafeParentChain(workspace.worktreePath, path, false);
    }

    const manifest = this.checkpoints.readManifest(workspace.checkpointId);
    const sourceFingerprintBefore = workspaceFingerprint(workspace.sourceWorkspaceRoot, manifest);
    if (sourceFingerprintBefore !== workspace.sourceFingerprintBefore) {
      throw new PatchPromotionError(
        "source_workspace_changed",
        "Source workspace changed after Hosted finalization"
      );
    }
    const currentChangedPaths = workspaceChangedPathsFromManifest(workspace.worktreePath, manifest);
    if (canonicalJson(currentChangedPaths) !== canonicalJson(finalizedPaths)) {
      throw new PatchPromotionError(
        "changed_paths_mismatch",
        "Hosted worktree change set no longer matches its finalized evidence"
      );
    }
    const worktreeFingerprintBefore = workspaceFingerprint(workspace.worktreePath, manifest);
    const entries = selectedPaths.map((path) => ({
      path,
      ...optionalStates(
        this.captureState(workspace.sourceWorkspaceRoot, path),
        this.captureState(workspace.worktreePath, path)
      )
    }));
    const createdAt = this.now().toISOString();
    const plan: PatchPromotionPlan = {
      schemaVersion: "1.0",
      workspaceId: workspace.id,
      runId: run.id,
      selectedPaths,
      sourceFingerprintBefore,
      worktreeFingerprintBefore,
      entries,
      createdAt
    };
    const planJson = canonicalJson(plan);
    const planHash = sha256(Buffer.from(planJson));
    const planBlob = this.store.putBlob(Buffer.from(planJson), "application/octet-stream");
    if (planBlob.hash !== planHash) {
      throw new PatchPromotionError("plan_invalid", "Patch Promotion plan Blob is not exact");
    }

    const deleting = entries.some((entry) => entry.after === undefined);
    const context: ActionContext = {
      runId: run.id,
      actor: { id: run.agentId, type: "agent" },
      tool: "patch.promotion",
      action: deleting ? "delete" : "apply",
      argv: ["promote", ...selectedPaths],
      cwd: workspace.sourceWorkspaceRoot,
      targets: selectedPaths.map((path) => ({ type: "file", canonicalId: path })),
      environment: "local",
      sideEffect: deleting ? "irreversible" : "local-write",
      recoverability: "partial",
      contentHash: planHash,
      estimatedImpact: {
        files: entries.length,
        bytes: entries.reduce((total, entry) => total + (entry.after?.size ?? 0), 0)
      }
    };
    this.store.appendEvents(run.id, [{
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId: run.id,
      occurredAt: createdAt,
      actor: { type: "system", id: "afr-patch-promotion" },
      eventType: "tool.call_requested",
      status: "pending",
      payload: {
        tool: "patch.promotion",
        action: context.action,
        workspaceId: workspace.id,
        selectedPaths,
        planHash
      },
      blobRefs: [`sha256:${planBlob.hash}`, ...planBlobRefs(plan)]
    }]);
    const evaluation = this.approvals.evaluate(
      context,
      input.reason ?? `Promote ${selectedPaths.length} approved Hosted workspace change(s)`
    );
    if (evaluation.decision.effect !== "ask" || evaluation.approval === undefined) {
      throw new PatchPromotionError(
        "approval_required",
        "Patch Promotion must be bound to an explicit human approval"
      );
    }

    const promotion = this.store.createPatchPromotion({
      id: uuidv7(),
      runId: run.id,
      hostedWorkspaceId: workspace.id,
      approvalId: evaluation.approval.id,
      actionDigest: evaluation.actionDigest,
      actionContext: evaluation.actionContext,
      planHash,
      planBlobHash: planBlob.hash,
      selectedPaths,
      sourceFingerprintBefore,
      worktreeFingerprintBefore,
      requestedAt: createdAt
    });
    this.store.appendEvents(run.id, [promotionEvent(
      promotion,
      "artifact.created",
      "success",
      {
        kind: "patch_promotion_plan",
        promotionId: promotion.id,
        approvalId: promotion.approvalId,
        workspaceId: workspace.id,
        selectedPaths,
        planHash,
        sourceFingerprintBefore,
        worktreeFingerprintBefore
      },
      [`sha256:${promotion.planBlobHash}`, ...planBlobRefs(plan)]
    )]);
    return {
      evaluation: { ...evaluation, approval: this.approvals.get(evaluation.approval.id)! },
      promotion,
      plan
    };
  }

  get(promotionId: string): PatchPromotionRecord | undefined {
    const promotion = this.store.getPatchPromotion(promotionId);
    return promotion === undefined ? undefined : this.reconcileExpired(promotion);
  }

  list(runId: string): PatchPromotionRecord[] {
    return this.store.listPatchPromotions(runId).map((promotion) => this.reconcileExpired(promotion));
  }

  readPlan(promotionId: string): PatchPromotionPlan {
    const promotion = this.store.getPatchPromotion(promotionId);
    if (promotion === undefined) {
      throw new PatchPromotionError("plan_missing", `Patch Promotion does not exist: ${promotionId}`);
    }
    return this.loadPlan(promotion);
  }

  resolveApproval(
    approvalId: string,
    decision: "approved" | "denied",
    grantToken?: string
  ): PatchPromotionRecord | undefined {
    const promotion = this.store.getPatchPromotionByApproval(approvalId);
    if (promotion === undefined) return undefined;
    if (promotion.status !== "waiting_approval") {
      throw new PatchPromotionError(
        "invalid_state",
        `Patch Promotion cannot resolve from ${promotion.status}: ${promotion.id}`
      );
    }
    if (decision === "denied") {
      const at = this.now().toISOString();
      const denied = this.store.transitionPatchPromotion({
        promotionId: promotion.id,
        status: "denied",
        at,
        errorCode: "approval_denied",
        errorMessage: "User denied the Patch Promotion"
      });
      this.store.appendEvents(promotion.runId, [promotionEvent(
        denied,
        "tool.call_failed",
        "cancelled",
        {
          tool: "patch.promotion",
          action: promotion.actionContext.action,
          promotionId: promotion.id,
          approvalId,
          code: "approval_denied",
          message: "User denied the Patch Promotion"
        }
      )]);
      return denied;
    }
    if (grantToken === undefined) {
      return this.failWaiting(promotion, "grant_missing", "Approved Patch Promotion has no grant");
    }
    return this.execute(promotion, grantToken);
  }

  private execute(promotion: PatchPromotionRecord, grantToken: string): PatchPromotionRecord {
    let applying: PatchPromotionRecord | undefined;
    let plan: PatchPromotionPlan | undefined;
    const applied: PatchPromotionPlan["entries"] = [];
    const createdDirectories: string[] = [];
    try {
      plan = this.loadPlan(promotion);
      this.verifyPlanIdentity(promotion, plan);
      const workspace = this.store.getHostedWorkspace(promotion.hostedWorkspaceId);
      if (workspace === undefined || workspace.status !== "finalized") {
        throw new PatchPromotionError(
          "workspace_not_finalized",
          "Hosted workspace is unavailable or no longer finalized"
        );
      }
      for (const entry of plan.entries) {
        assertSafeParentChain(workspace.sourceWorkspaceRoot, entry.path, true);
        assertSafeParentChain(workspace.worktreePath, entry.path, false);
      }
      const manifest = this.checkpoints.readManifest(workspace.checkpointId);
      if (workspaceFingerprint(workspace.sourceWorkspaceRoot, manifest) !== plan.sourceFingerprintBefore) {
        throw new PatchPromotionError(
          "source_workspace_changed",
          "Source workspace changed after Patch Promotion approval was requested"
        );
      }
      if (workspaceFingerprint(workspace.worktreePath, manifest) !== plan.worktreeFingerprintBefore) {
        throw new PatchPromotionError(
          "worktree_changed",
          "Hosted worktree changed after Patch Promotion approval was requested"
        );
      }
      for (const entry of plan.entries) {
        assertStateMatches(workspace.sourceWorkspaceRoot, entry.path, entry.before, "source_workspace_changed");
        assertStateMatches(workspace.worktreePath, entry.path, entry.after, "worktree_changed");
      }
      this.approvals.consume(grantToken, promotion.actionContext);
      applying = this.store.transitionPatchPromotion({
        promotionId: promotion.id,
        status: "applying",
        at: this.now().toISOString()
      });
      for (const entry of plan.entries) {
        createdDirectories.push(...ensureSafeParentDirectories(workspace.sourceWorkspaceRoot, entry.path));
        applyState(this.store, workspace.sourceWorkspaceRoot, entry.path, entry.after);
        applied.push(entry);
      }
      for (const entry of plan.entries) {
        assertStateMatches(workspace.sourceWorkspaceRoot, entry.path, entry.after, "apply_failed");
      }
      const resultSourceFingerprint = workspaceFingerprint(workspace.sourceWorkspaceRoot, manifest);
      const completedAt = this.now().toISOString();
      const completed = this.store.transitionPatchPromotion({
        promotionId: promotion.id,
        status: "completed",
        at: completedAt,
        resultSourceFingerprint
      });
      this.store.appendEvents(promotion.runId, [
        ...plan.entries.map((entry) => promotionFileEvent(completed, entry, completedAt)),
        promotionEvent(
          completed,
          "evidence.attached",
          "success",
          {
            kind: "patch_promotion_result",
            promotionId: completed.id,
            approvalId: completed.approvalId,
            workspaceId: completed.hostedWorkspaceId,
            planHash: completed.planHash,
            selectedPaths: completed.selectedPaths,
            resultSourceFingerprint
          },
          [`sha256:${completed.planBlobHash}`, ...planBlobRefs(plan)]
        )
      ]);
      return completed;
    } catch (error) {
      const normalized = normalizePromotionError(error);
      if (applying !== undefined && plan !== undefined) {
        try {
          for (const entry of [...applied].reverse()) {
            applyState(this.store, this.sourceRoot(promotion), entry.path, entry.before);
          }
          removeCreatedDirectories(createdDirectories);
        } catch (rollbackError) {
          const message = `${normalized.message}; rollback failed: ${messageOf(rollbackError)}`;
          return this.failApplying(promotion, "rollback_failed", message);
        }
        return this.failApplying(promotion, normalized.code, normalized.message);
      }
      return this.failWaiting(promotion, normalized.code, normalized.message);
    }
  }

  private captureState(root: string, path: string): PromotionEntryState | undefined {
    const absolute = resolveWorkspacePath(root, path);
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(absolute);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new PatchPromotionError("unsupported_entry", `Only files and symlinks can be promoted: ${path}`);
    }
    const content = metadata.isSymbolicLink()
      ? Buffer.from(readlinkSync(absolute), "utf8")
      : readFileSync(absolute);
    const binary = !metadata.isSymbolicLink() && !isUtf8(content);
    const blob = this.store.putBlob(
      content,
      binary ? "application/octet-stream" : "text/plain; charset=utf-8"
    );
    const contentHash = sha256(content);
    if (blob.redactionState === "redacted" || blob.hash !== contentHash) {
      throw new PatchPromotionError(
        "sensitive_content",
        `Exact content could not be persisted for Patch Promotion: ${path}`
      );
    }
    return {
      type: metadata.isSymbolicLink() ? "symlink" : "file",
      mode: metadata.mode & 0o777,
      size: content.byteLength,
      contentHash,
      blobHash: blob.hash,
      binary
    };
  }

  private loadPlan(promotion: PatchPromotionRecord): PatchPromotionPlan {
    const blob = this.store.getBlob(promotion.planBlobHash);
    if (blob === undefined) {
      throw new PatchPromotionError("plan_missing", `Patch Promotion plan Blob is missing: ${promotion.id}`);
    }
    if (sha256(blob.content) !== promotion.planHash) {
      throw new PatchPromotionError("plan_invalid", "Patch Promotion plan hash does not match its Blob");
    }
    let value: unknown;
    try {
      value = JSON.parse(blob.content.toString("utf8"));
    } catch {
      throw new PatchPromotionError("plan_invalid", "Patch Promotion plan is not valid JSON");
    }
    if (!isPatchPromotionPlan(value)) {
      throw new PatchPromotionError("plan_invalid", "Patch Promotion plan schema is invalid");
    }
    if (canonicalJson(value) !== blob.content.toString("utf8")) {
      throw new PatchPromotionError("plan_invalid", "Patch Promotion plan is not canonical JSON");
    }
    return value;
  }

  private verifyPlanIdentity(promotion: PatchPromotionRecord, plan: PatchPromotionPlan): void {
    if (
      plan.workspaceId !== promotion.hostedWorkspaceId ||
      plan.runId !== promotion.runId ||
      canonicalJson(plan.selectedPaths) !== canonicalJson(promotion.selectedPaths) ||
      plan.sourceFingerprintBefore !== promotion.sourceFingerprintBefore ||
      plan.worktreeFingerprintBefore !== promotion.worktreeFingerprintBefore
    ) {
      throw new PatchPromotionError("plan_invalid", "Patch Promotion plan does not match its audit record");
    }
  }

  private reconcileExpired(promotion: PatchPromotionRecord): PatchPromotionRecord {
    if (promotion.status !== "waiting_approval") return promotion;
    const approval = this.approvals.get(promotion.approvalId);
    if (approval?.status !== "expired") return promotion;
    return this.failWaiting(promotion, "approval_expired", "Patch Promotion approval expired");
  }

  private sourceRoot(promotion: PatchPromotionRecord): string {
    const workspace = this.store.getHostedWorkspace(promotion.hostedWorkspaceId);
    if (workspace === undefined) {
      throw new PatchPromotionError("workspace_not_found", "Hosted workspace disappeared during rollback");
    }
    return workspace.sourceWorkspaceRoot;
  }

  private failWaiting(
    promotion: PatchPromotionRecord,
    code: string,
    message: string
  ): PatchPromotionRecord {
    const failed = this.store.transitionPatchPromotion({
      promotionId: promotion.id,
      status: "failed",
      at: this.now().toISOString(),
      errorCode: code,
      errorMessage: message
    });
    this.recordFailure(failed, code, message);
    return failed;
  }

  private failApplying(
    promotion: PatchPromotionRecord,
    code: string,
    message: string
  ): PatchPromotionRecord {
    const failed = this.store.transitionPatchPromotion({
      promotionId: promotion.id,
      status: "failed",
      at: this.now().toISOString(),
      errorCode: code,
      errorMessage: message
    });
    this.recordFailure(failed, code, message);
    return failed;
  }

  private recordFailure(promotion: PatchPromotionRecord, code: string, message: string): void {
    this.store.appendEvents(promotion.runId, [promotionEvent(
      promotion,
      "tool.call_failed",
      "error",
      {
        tool: "patch.promotion",
        action: promotion.actionContext.action,
        promotionId: promotion.id,
        approvalId: promotion.approvalId,
        code,
        message
      }
    )]);
  }
}

function optionalStates(
  before: PromotionEntryState | undefined,
  after: PromotionEntryState | undefined
): { before?: PromotionEntryState; after?: PromotionEntryState } {
  return {
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after })
  };
}

function canonicalPaths(paths: readonly string[]): string[] {
  if (!paths.every((path) => typeof path === "string" && path.length > 0)) {
    throw new PatchPromotionError("paths_required", "Patch Promotion paths must be non-empty strings");
  }
  return [...new Set(paths)].sort();
}

function assertSafeParentChain(root: string, path: string, allowMissing: boolean): void {
  const absolute = resolveWorkspacePath(root, path);
  const parentRelative = relative(root, dirname(absolute));
  if (parentRelative === "") return;
  let current = root;
  for (const segment of parentRelative.split(sep)) {
    current = join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        throw new PatchPromotionError("symlink_parent", `Patch Promotion parent is a symlink: ${path}`);
      }
      if (!metadata.isDirectory()) {
        throw new PatchPromotionError("unsupported_entry", `Patch Promotion parent is not a directory: ${path}`);
      }
    } catch (error) {
      if (allowMissing && isMissing(error)) return;
      throw error;
    }
  }
}

function ensureSafeParentDirectories(root: string, path: string): string[] {
  const absolute = resolveWorkspacePath(root, path);
  const parentRelative = relative(root, dirname(absolute));
  if (parentRelative === "") return [];
  const created: string[] = [];
  let current = root;
  for (const segment of parentRelative.split(sep)) {
    current = join(current, segment);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        throw new PatchPromotionError("symlink_parent", `Patch Promotion parent is a symlink: ${path}`);
      }
      if (!metadata.isDirectory()) {
        throw new PatchPromotionError("unsupported_entry", `Patch Promotion parent is not a directory: ${path}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      mkdirSync(current, { mode: 0o700 });
      created.push(current);
    }
  }
  return created;
}

function applyState(
  store: LocalStore,
  root: string,
  path: string,
  state: PromotionEntryState | undefined
): void {
  const destination = resolveWorkspacePath(root, path);
  if (state === undefined) {
    try {
      const metadata = lstatSync(destination);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        throw new PatchPromotionError("unsupported_entry", `Refusing to delete non-file entry: ${path}`);
      }
      unlinkSync(destination);
      return;
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
  const blob = store.getBlob(state.blobHash);
  if (blob === undefined || blob.record.redactionState === "redacted") {
    throw new PatchPromotionError("plan_missing", `Exact Patch Promotion content is missing: ${path}`);
  }
  if (sha256(blob.content) !== state.contentHash || blob.content.byteLength !== state.size) {
    throw new PatchPromotionError("plan_invalid", `Patch Promotion content does not match its plan: ${path}`);
  }
  const temporary = join(dirname(destination), `.afr-promote-${randomUUID()}.tmp`);
  try {
    if (state.type === "symlink") {
      symlinkSync(blob.content.toString("utf8"), temporary);
    } else {
      const descriptor = openSync(temporary, "wx", state.mode);
      try {
        writeFileSync(descriptor, blob.content);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(temporary, state.mode);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertStateMatches(
  root: string,
  path: string,
  expected: PromotionEntryState | undefined,
  code: "source_workspace_changed" | "worktree_changed" | "apply_failed"
): void {
  const absolute = resolveWorkspacePath(root, path);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(absolute);
  } catch (error) {
    if (isMissing(error) && expected === undefined) return;
    throw new PatchPromotionError(code, `Patch Promotion path existence changed: ${path}`);
  }
  if (expected === undefined) {
    throw new PatchPromotionError(code, `Patch Promotion path unexpectedly exists: ${path}`);
  }
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new PatchPromotionError(code, `Patch Promotion path has an unsupported type: ${path}`);
  }
  const type = metadata.isSymbolicLink() ? "symlink" : "file";
  const content = metadata.isSymbolicLink()
    ? Buffer.from(readlinkSync(absolute), "utf8")
    : readFileSync(absolute);
  if (
    type !== expected.type ||
    (metadata.mode & 0o777) !== expected.mode ||
    content.byteLength !== expected.size ||
    sha256(content) !== expected.contentHash
  ) {
    throw new PatchPromotionError(code, `Patch Promotion path changed: ${path}`);
  }
}

function removeCreatedDirectories(paths: readonly string[]): void {
  for (const path of [...new Set(paths)].sort((left, right) => right.length - left.length)) {
    try {
      rmdirSync(path);
    } catch (error) {
      if (!isMissing(error) && !isDirectoryNotEmpty(error)) throw error;
    }
  }
}

function promotionFileEvent(
  promotion: PatchPromotionRecord,
  entry: PatchPromotionPlan["entries"][number],
  occurredAt: string
): IncomingEvent {
  const eventType = entry.before === undefined
    ? "file.created"
    : entry.after === undefined ? "file.deleted" : "file.modified";
  return promotionEvent(
    promotion,
    eventType,
    "success",
    {
      path: entry.path,
      promotionId: promotion.id,
      approvalId: promotion.approvalId,
      planHash: promotion.planHash,
      beforeHash: entry.before?.contentHash ?? null,
      afterHash: entry.after?.contentHash ?? null,
      entryType: entry.after?.type ?? entry.before?.type
    },
    [...new Set([
      ...(entry.before === undefined ? [] : [`sha256:${entry.before.blobHash}`]),
      ...(entry.after === undefined ? [] : [`sha256:${entry.after.blobHash}`])
    ])],
    occurredAt
  );
}

function promotionEvent(
  promotion: PatchPromotionRecord,
  eventType: IncomingEvent["eventType"],
  status: IncomingEvent["status"],
  payload: Record<string, unknown>,
  blobRefs: string[] = [],
  occurredAt = new Date().toISOString()
): IncomingEvent {
  const eventId = uuidv7();
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    runId: promotion.runId,
    idempotencyKey: `patch-promotion:${eventId}`,
    occurredAt,
    actor: { type: "system", id: "afr-patch-promotion" },
    eventType,
    status,
    payload,
    ...(blobRefs.length === 0 ? {} : { blobRefs })
  };
}

function planBlobRefs(plan: PatchPromotionPlan): string[] {
  return [...new Set(plan.entries.flatMap((entry) => [
    ...(entry.before === undefined ? [] : [`sha256:${entry.before.blobHash}`]),
    ...(entry.after === undefined ? [] : [`sha256:${entry.after.blobHash}`])
  ]))];
}

function isPatchPromotionPlan(value: unknown): value is PatchPromotionPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<PatchPromotionPlan>;
  return plan.schemaVersion === "1.0" &&
    typeof plan.workspaceId === "string" &&
    typeof plan.runId === "string" &&
    typeof plan.sourceFingerprintBefore === "string" &&
    typeof plan.worktreeFingerprintBefore === "string" &&
    typeof plan.createdAt === "string" &&
    Array.isArray(plan.selectedPaths) &&
    plan.selectedPaths.every((path) => typeof path === "string") &&
    Array.isArray(plan.entries) &&
    plan.entries.length === plan.selectedPaths.length &&
    plan.entries.every((entry, index) => isPlanEntry(entry, plan.selectedPaths?.[index]));
}

function isPlanEntry(value: unknown, expectedPath: string | undefined): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as { path?: unknown; before?: unknown; after?: unknown };
  if (typeof entry.path !== "string" || entry.path !== expectedPath) return false;
  if (entry.before === undefined && entry.after === undefined) return false;
  return (entry.before === undefined || isEntryState(entry.before)) &&
    (entry.after === undefined || isEntryState(entry.after));
}

function isEntryState(value: unknown): value is PromotionEntryState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<PromotionEntryState>;
  return (state.type === "file" || state.type === "symlink") &&
    Number.isInteger(state.mode) &&
    typeof state.size === "number" && Number.isInteger(state.size) && state.size >= 0 &&
    typeof state.binary === "boolean" &&
    isHash(state.contentHash) &&
    isHash(state.blobHash);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function normalizePromotionError(error: unknown): PatchPromotionError {
  return error instanceof PatchPromotionError
    ? error
    : new PatchPromotionError("apply_failed", messageOf(error));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOTEMPTY";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
