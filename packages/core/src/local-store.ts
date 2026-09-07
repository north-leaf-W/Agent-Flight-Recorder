import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  EVENT_SCHEMA_VERSION,
  canTransitionRun,
  isTerminalRunStatus,
  type EventEnvelope,
  type IncomingEvent,
  type ActionContext,
  type ApprovalStatus,
  type RunStatus,
  validateActionContext,
  validateEventEnvelope,
  validateIncomingEvent
} from "@afr/protocol";
import Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";

import { BlobStore, type StoredBlob } from "./blob-store.js";
import { canonicalJson } from "./canonical-json.js";
import { applyMigrations, LATEST_MIGRATION_VERSION } from "./migrations.js";
import { redactIncomingEvent, redactText, redactValue } from "./redaction.js";

export type RunRecord = {
  id: string;
  parentRunId?: string;
  forkedFromEventId?: string;
  projectPath: string;
  task: string;
  agentId: string;
  status: RunStatus;
  startedAt?: string;
  endedAt?: string;
  leaseExpiresAt?: string;
  lastSequenceNo: number;
  createdAt: string;
  updatedAt: string;
};

export type RunSummaryRecord = RunRecord & {
  eventCount: number;
  commandCount: number;
  fileChangeCount: number;
  gapCount: number;
  highRiskCount: number;
  pendingApprovalCount: number;
  validationStatus: "passed" | "failed" | "unverified";
};

export type CreateRunInput = {
  projectPath: string;
  task: string;
  agentId: string;
  parentRunId?: string;
  forkedFromEventId?: string;
};

export type RecoveryReport = {
  quickCheck: "ok";
  removedTemporaryBlobs: number;
  verifiedRuns: number;
  interruptedProviderSessions: number;
};

export type MigrationReport = {
  schemaVersion: string;
  appliedMigrations: string[];
  backupPath?: string;
};

export type BlobRecord = {
  hash: string;
  mediaType: string;
  byteSize: number;
  redactionState: "redacted" | "scanned" | "unscanned";
};

export type ApprovalRecord = {
  id: string;
  runId: string;
  requestEventId: string;
  actionDigest: string;
  actionContext: ActionContext;
  status: ApprovalStatus;
  riskLevel: "R0" | "R1" | "R2" | "R3" | "R4";
  policyId: string;
  ruleId: string;
  reasonCodes: string[];
  requestReason?: string;
  requestedBy: ActionContext["actor"];
  decidedBy?: string;
  decisionReason?: string;
  decisionEventId?: string;
  grantId?: string;
  snapshotId?: string;
  requestedAt: string;
  requestExpiresAt: string;
  decidedAt?: string;
  consumedAt?: string;
  updatedAt: string;
};

export type ExecutionGrantRecord = {
  id: string;
  approvalId?: string;
  runId: string;
  actionDigest: string;
  nonceHash: string;
  status: "active" | "consumed" | "expired";
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
};

export type CreateApprovalInput = Omit<
  ApprovalRecord,
  "status" | "requestEventId" | "decisionEventId" | "grantId" | "decidedBy" | "decisionReason" |
    "decidedAt" | "consumedAt" | "updatedAt"
> & { requestEvent: IncomingEvent };

export type PersistGrantInput = Omit<ExecutionGrantRecord, "status" | "consumedAt">;

export type SnapshotRecord = {
  id: string;
  runId: string;
  eventId: string;
  kind: "file";
  path: string;
  contentBlobHash: string;
  beforeHash: string;
  byteSize: number;
  exact: boolean;
  createdAt: string;
};

export type GatewayActionRecord = {
  id: string;
  runId: string;
  approvalId?: string;
  snapshotId?: string;
  kind: "file_delete";
  actionDigest: string;
  actionContext: ActionContext;
  targetPath: string;
  status: "waiting_approval" | "executing" | "completed" | "denied" | "failed";
  requestedAt: string;
  updatedAt: string;
  executedAt?: string;
  errorCode?: string;
  resultEventId?: string;
};

export type CheckpointRecord = {
  id: string;
  runId: string;
  sourceEventId?: string;
  eventId: string;
  workspaceRoot: string;
  baseCommit: string;
  manifestBlobHash: string;
  trackedDiffBlobHash?: string;
  untrackedCount: number;
  totalBytes: number;
  createdAt: string;
};

export type ReplayStatus = "queued" | "running" | "completed" | "failed";

export type ReplayRecord = {
  id: string;
  checkpointId: string;
  sourceRunId: string;
  sourceEventId?: string;
  targetRunId: string;
  mode: "isolated-live";
  status: ReplayStatus;
  worktreePath: string;
  command: string[];
  overrides: Record<string, string>;
  comparison?: unknown;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type ProviderSessionMode = "hosted-observed" | "hosted-governed";

export type ProviderSessionStatus =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ProviderCapabilityState = "supported" | "unsupported" | "degraded";

export type ProviderCapability = {
  state: ProviderCapabilityState;
  source: string;
  version: string;
  detail?: string;
};

export type ProviderCapabilitySnapshot = Record<string, ProviderCapability>;

export type ProviderSessionRecord = {
  id: string;
  runId: string;
  provider: string;
  adapterVersion: string;
  runtimeVersion: string;
  protocolVersion: string;
  externalSessionId?: string;
  mode: ProviderSessionMode;
  capabilities: ProviderCapabilitySnapshot;
  status: ProviderSessionStatus;
  processId?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateProviderSessionInput = {
  runId: string;
  provider: string;
  adapterVersion: string;
  runtimeVersion: string;
  protocolVersion: string;
  mode: ProviderSessionMode;
  capabilities: ProviderCapabilitySnapshot;
};

export type HostedWorkspaceStatus =
  | "preparing"
  | "ready"
  | "active"
  | "finalized"
  | "failed"
  | "cleaned";

export type HostedWorkspaceRecord = {
  id: string;
  runId: string;
  checkpointId: string;
  sourceWorkspaceRoot: string;
  worktreePath: string;
  baseCommit: string;
  sourceFingerprintBefore: string;
  sourceFingerprintAfter?: string;
  status: HostedWorkspaceStatus;
  changedPaths: string[];
  diffBlobHash?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  readyAt?: string;
  finalizedAt?: string;
  cleanedAt?: string;
  updatedAt: string;
};

export type ProviderEventParseStatus = "mapped" | "ignored" | "gap" | "invalid";

export type ProviderEventRecord = {
  id: string;
  providerSessionId: string;
  runId: string;
  arrivalSequence: number;
  providerMethod: string;
  providerEventId?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  rawHash: string;
  rawBlobHash?: string;
  normalizedEventId?: string;
  parseStatus: ProviderEventParseStatus;
  gapReason?: string;
  receivedAt: string;
};

export type ProviderActionRequestStatus =
  | "evaluating"
  | "waiting_approval"
  | "accepted"
  | "declined"
  | "rejected"
  | "expired";

export type ProviderActionRequestRecord = {
  id: string;
  providerSessionId: string;
  runId: string;
  providerRpcId: string;
  providerMethod: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  requestHash: string;
  requestBlobHash?: string;
  actionDigest?: string;
  actionContext?: ActionContext;
  approvalId?: string;
  grantId?: string;
  status: ProviderActionRequestStatus;
  responseHash?: string;
  responseBlobHash?: string;
  decisionReason?: string;
  createdAt: string;
  resolvedAt?: string;
  updatedAt: string;
};

export type NetworkMediationSource = "host" | "provider" | "runtime" | "observer";

export type NetworkMediationDecision =
  | "control-allowed"
  | "sandbox-enforced"
  | "denied"
  | "observed"
  | "degraded";

export type NetworkMediationRecord = {
  id: string;
  providerSessionId: string;
  runId: string;
  sequenceNo: number;
  source: NetworkMediationSource;
  operation: string;
  decision: NetworkMediationDecision;
  requestedPolicy?: unknown;
  effectivePolicy?: unknown;
  evidence?: unknown;
  createdAt: string;
};

export type RecordNetworkMediationInput = {
  sessionId: string;
  source: NetworkMediationSource;
  operation: string;
  decision: NetworkMediationDecision;
  requestedPolicy?: unknown;
  effectivePolicy?: unknown;
  evidence?: unknown;
};

export type PatchPromotionStatus =
  | "waiting_approval"
  | "applying"
  | "completed"
  | "denied"
  | "failed";

export type PatchPromotionRecord = {
  id: string;
  runId: string;
  hostedWorkspaceId: string;
  approvalId: string;
  actionDigest: string;
  actionContext: ActionContext;
  planHash: string;
  planBlobHash: string;
  selectedPaths: string[];
  sourceFingerprintBefore: string;
  worktreeFingerprintBefore: string;
  status: PatchPromotionStatus;
  resultSourceFingerprint?: string;
  errorCode?: string;
  errorMessage?: string;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type CreateProviderActionRequestInput = {
  sessionId: string;
  rpcId: string | number;
  method: string;
  request: unknown;
  status: ProviderActionRequestStatus;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  actionDigest?: string;
  actionContext?: ActionContext;
  approvalId?: string;
  decisionReason?: string;
  storeRaw?: boolean | undefined;
};

export type RunCoverageRecord = {
  runId: string;
  providerSessionId?: string;
  providerEventCount: number;
  normalizedEventCount: number;
  ignoredEventCount: number;
  gapCount: number;
  unknownEventCount: number;
  invalidEventCount: number;
  coveragePercent: number;
  coverageLevel: "L0" | "L1" | "L2" | "L3";
  summary: {
    parseStatuses: Record<string, number>;
    providerMethods: Record<string, number>;
    gapReasons: Record<string, number>;
    workspaceEvidence: "verified" | "pending" | "failed" | "missing";
  };
  calculatedAt: string;
};

type RunRow = {
  id: string;
  parent_run_id: string | null;
  forked_from_event_id: string | null;
  project_path: string;
  task: string;
  agent_id: string;
  status: RunStatus;
  started_at: string | null;
  ended_at: string | null;
  lease_expires_at: string | null;
  last_sequence_no: number;
  created_at: string;
  updated_at: string;
};

type RunSummaryRow = RunRow & {
  event_count: number;
  command_count: number;
  file_change_count: number;
  gap_count: number;
  latest_command_status: string | null;
  high_risk_count: number;
  pending_approval_count: number;
};

type EventRow = {
  envelope_json: string;
  idempotency_fingerprint: string | null;
};

type ApprovalRow = {
  id: string;
  run_id: string;
  request_event_id: string;
  action_digest: string;
  action_context_json: string;
  status: ApprovalStatus;
  risk_level: ApprovalRecord["riskLevel"];
  policy_id: string;
  rule_id: string;
  reason_codes_json: string;
  request_reason: string | null;
  requested_by_actor_json: string;
  decided_by: string | null;
  decision_reason: string | null;
  decision_event_id: string | null;
  grant_id: string | null;
  snapshot_id: string | null;
  requested_at: string;
  request_expires_at: string;
  decided_at: string | null;
  consumed_at: string | null;
  updated_at: string;
};

type GrantRow = {
  id: string;
  approval_id: string | null;
  run_id: string;
  action_digest: string;
  nonce_hash: string;
  status: ExecutionGrantRecord["status"];
  issued_by: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
};

type SnapshotRow = {
  id: string;
  run_id: string;
  event_id: string;
  kind: "file";
  path: string;
  content_blob_hash: string;
  before_hash: string;
  byte_size: number;
  exact: 0 | 1;
  created_at: string;
};

type GatewayActionRow = {
  id: string;
  run_id: string;
  approval_id: string | null;
  snapshot_id: string | null;
  kind: "file_delete";
  action_digest: string;
  action_context_json: string;
  target_path: string;
  status: GatewayActionRecord["status"];
  requested_at: string;
  updated_at: string;
  executed_at: string | null;
  error_code: string | null;
  result_event_id: string | null;
};

type CheckpointRow = {
  id: string;
  run_id: string;
  source_event_id: string | null;
  event_id: string;
  workspace_root: string;
  base_commit: string;
  manifest_blob_hash: string;
  tracked_diff_blob_hash: string | null;
  untracked_count: number;
  total_bytes: number;
  created_at: string;
};

type ReplayRow = {
  id: string;
  checkpoint_id: string;
  source_run_id: string;
  source_event_id: string | null;
  target_run_id: string;
  mode: "isolated-live";
  status: ReplayStatus;
  worktree_path: string;
  command_json: string;
  overrides_json: string;
  comparison_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type ProviderSessionRow = {
  id: string;
  run_id: string;
  provider: string;
  adapter_version: string;
  runtime_version: string;
  protocol_version: string;
  external_session_id: string | null;
  mode: ProviderSessionMode;
  capabilities_json: string;
  control_token_hash: string;
  status: ProviderSessionStatus;
  process_id: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

type HostedWorkspaceRow = {
  id: string;
  run_id: string;
  checkpoint_id: string;
  source_workspace_root: string;
  worktree_path: string;
  base_commit: string;
  source_fingerprint_before: string;
  source_fingerprint_after: string | null;
  status: HostedWorkspaceStatus;
  changed_paths_json: string;
  diff_blob_hash: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  ready_at: string | null;
  finalized_at: string | null;
  cleaned_at: string | null;
  updated_at: string;
};

type ProviderEventRow = {
  id: string;
  provider_session_id: string;
  run_id: string;
  arrival_sequence: number;
  provider_method: string;
  provider_event_id: string | null;
  provider_thread_id: string | null;
  provider_turn_id: string | null;
  provider_item_id: string | null;
  raw_hash: string;
  raw_blob_hash: string | null;
  normalized_event_id: string | null;
  parse_status: ProviderEventParseStatus;
  gap_reason: string | null;
  received_at: string;
};

type ProviderActionRequestRow = {
  id: string;
  provider_session_id: string;
  run_id: string;
  provider_rpc_id: string;
  provider_method: string;
  provider_thread_id: string | null;
  provider_turn_id: string | null;
  provider_item_id: string | null;
  request_hash: string;
  request_blob_hash: string | null;
  action_digest: string | null;
  action_context_json: string | null;
  approval_id: string | null;
  grant_id: string | null;
  status: ProviderActionRequestStatus;
  response_hash: string | null;
  response_blob_hash: string | null;
  decision_reason: string | null;
  created_at: string;
  resolved_at: string | null;
  updated_at: string;
};

type PatchPromotionRow = {
  id: string;
  run_id: string;
  hosted_workspace_id: string;
  approval_id: string;
  action_digest: string;
  action_context_json: string;
  plan_hash: string;
  plan_blob_hash: string;
  selected_paths_json: string;
  source_fingerprint_before: string;
  worktree_fingerprint_before: string;
  status: PatchPromotionStatus;
  result_source_fingerprint: string | null;
  error_code: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type NetworkMediationRow = {
  id: string;
  provider_session_id: string;
  run_id: string;
  sequence_no: number;
  source: NetworkMediationSource;
  operation: string;
  decision: NetworkMediationDecision;
  requested_policy_json: string | null;
  effective_policy_json: string | null;
  evidence_json: string | null;
  created_at: string;
};

type RunCoverageRow = {
  run_id: string;
  provider_session_id: string | null;
  provider_event_count: number;
  normalized_event_count: number;
  ignored_event_count: number;
  gap_count: number;
  unknown_event_count: number;
  invalid_event_count: number;
  coverage_percent: number;
  coverage_level: RunCoverageRecord["coverageLevel"];
  summary_json: string;
  calculated_at: string;
};

export class EventValidationError extends Error {
  constructor(readonly issues: Array<{ path: string; message: string }>) {
    super(`Invalid event: ${issues.map((issue) => `${issue.path} ${issue.message}`).join(", ")}`);
    this.name = "EventValidationError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(readonly runId: string, readonly idempotencyKey: string) {
    super(`Idempotency key was already used with different content: ${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}

export class MissingBlobError extends Error {
  constructor(readonly hash: string) {
    super(`Event references a blob that is not registered: ${hash}`);
    this.name = "MissingBlobError";
  }
}

export class RunTransitionError extends Error {
  constructor(readonly runId: string, readonly from: RunStatus, readonly to: RunStatus) {
    super(`Run cannot transition from ${from} to ${to}: ${runId}`);
    this.name = "RunTransitionError";
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval does not exist: ${approvalId}`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalStateError extends Error {
  constructor(readonly approvalId: string, readonly status: ApprovalStatus) {
    super(`Approval cannot be changed from ${status}: ${approvalId}`);
    this.name = "ApprovalStateError";
  }
}

export class GrantStateError extends Error {
  constructor(
    readonly reason: "not_found" | "expired" | "consumed" | "mismatch",
    readonly grantId: string
  ) {
    super(`Execution grant rejected (${reason}): ${grantId}`);
    this.name = "GrantStateError";
  }
}

export class ProviderSessionStateError extends Error {
  constructor(
    readonly sessionId: string,
    readonly from: ProviderSessionStatus,
    readonly to: ProviderSessionStatus
  ) {
    super(`Provider session cannot transition from ${from} to ${to}: ${sessionId}`);
    this.name = "ProviderSessionStateError";
  }
}

export class LocalStore {
  readonly blobs: BlobStore;
  readonly migrationReport: MigrationReport;
  private readonly database: Database.Database;

  constructor(readonly dataDir: string, private readonly now = () => new Date()) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const databasePath = join(dataDir, "afr.sqlite");
    const existingDatabase = existsSync(databasePath) && statSync(databasePath).size > 0;
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    let backupPath: string | undefined;
    try {
      const appliedMigrations = applyMigrations(
        this.database,
        existingDatabase
          ? (pendingVersions) => {
              const backupDirectory = join(dataDir, "backups");
              mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
              const stamp = this.now().toISOString().replace(/[:.]/g, "-");
              backupPath = join(
                backupDirectory,
                `afr-before-${pendingVersions[0]}-${stamp}-${uuidv7()}.sqlite`
              );
              this.database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
              chmodSync(backupPath, 0o600);
            }
          : undefined
      );
      this.migrationReport = {
        schemaVersion: LATEST_MIGRATION_VERSION,
        appliedMigrations,
        ...(backupPath === undefined ? {} : { backupPath })
      };
    } catch (error) {
      this.database.close();
      const recoveryHint = backupPath === undefined
        ? "原数据库未被继续使用。"
        : `升级前备份保存在 ${backupPath}。`;
      throw new Error(`数据库升级失败。${recoveryHint} ${messageOf(error)}`, { cause: error });
    }
    this.blobs = new BlobStore(dataDir);
  }

  close(): void {
    this.database.close();
  }

  journalMode(): string {
    const row = this.database.pragma("journal_mode", { simple: true });
    return String(row).toLowerCase();
  }

  createRun(input: CreateRunInput): RunRecord {
    const id = uuidv7();
    const timestamp = this.now().toISOString();
    const task = redactText(input.task).value;
    this.database
      .prepare(
        `INSERT INTO runs (
          id, parent_run_id, forked_from_event_id, project_path, task, agent_id, status,
          last_sequence_no, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'created', 0, ?, ?)`
      )
      .run(
        id,
        input.parentRunId ?? null,
        input.forkedFromEventId ?? null,
        input.projectPath,
        task,
        input.agentId,
        timestamp,
        timestamp
      );

    const run = this.getRun(id);
    if (run === undefined) {
      throw new Error(`Created Run could not be read: ${id}`);
    }
    return run;
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    return row === undefined ? undefined : mapRun(row);
  }

  listRuns(limit = 200): RunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM runs
         ORDER BY COALESCE(started_at, created_at) DESC, id DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 1000))) as RunRow[];
    return rows.map(mapRun);
  }

  listRunSummaries(limit = 200): RunSummaryRecord[] {
    const rows = this.database
      .prepare(
        `SELECT r.*,
          COUNT(e.id) AS event_count,
          SUM(CASE WHEN e.event_type = 'shell.command_completed' THEN 1 ELSE 0 END) AS command_count,
          SUM(CASE WHEN e.event_type IN ('file.created', 'file.modified', 'file.deleted') THEN 1 ELSE 0 END) AS file_change_count,
          SUM(CASE WHEN e.event_type = 'collection.gap_detected' THEN 1 ELSE 0 END) AS gap_count,
          (SELECT e2.status FROM events e2
            WHERE e2.run_id = r.id AND e2.event_type = 'shell.command_completed'
            ORDER BY e2.sequence_no DESC LIMIT 1) AS latest_command_status,
          (SELECT COUNT(*) FROM approvals a
            WHERE a.run_id = r.id AND a.risk_level IN ('R3', 'R4')) AS high_risk_count,
          (SELECT COUNT(*) FROM approvals a
            WHERE a.run_id = r.id AND a.status = 'pending') AS pending_approval_count
        FROM runs r
        LEFT JOIN events e ON e.run_id = r.id
        GROUP BY r.id
        ORDER BY COALESCE(r.started_at, r.created_at) DESC, r.id DESC
        LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 1000))) as RunSummaryRow[];
    return rows.map((row) => {
      const run = mapRun(row);
      const validationStatus = run.status === "failed" || row.latest_command_status === "error"
        ? "failed"
        : run.status === "completed" && row.latest_command_status === "success"
          ? "passed"
          : "unverified";
      return {
        ...run,
        eventCount: row.event_count,
        commandCount: row.command_count,
        fileChangeCount: row.file_change_count,
        gapCount: row.gap_count,
        highRiskCount: row.high_risk_count,
        pendingApprovalCount: row.pending_approval_count,
        validationStatus
      };
    });
  }

  getEvent(eventId: string): EventEnvelope | undefined {
    const row = this.database
      .prepare("SELECT envelope_json FROM events WHERE id = ?")
      .get(eventId) as EventRow | undefined;
    return row === undefined ? undefined : JSON.parse(row.envelope_json) as EventEnvelope;
  }

  createCheckpoint(input: Omit<CheckpointRecord, "eventId"> & { event: IncomingEvent }): CheckpointRecord {
    return this.database.transaction(() => {
      const run = this.getRun(input.runId);
      if (run === undefined) throw new Error(`Run not found: ${input.runId}`);
      if (input.sourceEventId !== undefined) {
        const source = this.getEvent(input.sourceEventId);
        if (source === undefined || source.runId !== input.runId) {
          throw new Error(`Checkpoint source event does not belong to Run: ${input.sourceEventId}`);
        }
      }
      const [event] = this.appendEvents(input.runId, [input.event]);
      if (event === undefined) throw new Error("Checkpoint event was not appended");
      this.database
        .prepare(
          `INSERT INTO checkpoints (
            id, run_id, source_event_id, event_id, workspace_root, base_commit,
            manifest_blob_hash, tracked_diff_blob_hash, untracked_count, total_bytes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.runId,
          input.sourceEventId ?? null,
          event.eventId,
          input.workspaceRoot,
          input.baseCommit,
          input.manifestBlobHash,
          input.trackedDiffBlobHash ?? null,
          input.untrackedCount,
          input.totalBytes,
          input.createdAt
        );
      return this.requireCheckpoint(input.id);
    })();
  }

  getCheckpoint(checkpointId: string): CheckpointRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM checkpoints WHERE id = ?")
      .get(checkpointId) as CheckpointRow | undefined;
    return row === undefined ? undefined : mapCheckpoint(row);
  }

  listCheckpoints(runId: string): CheckpointRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at DESC, id DESC")
      .all(runId) as CheckpointRow[];
    return rows.map(mapCheckpoint);
  }

  createReplay(input: Omit<ReplayRecord, "status" | "comparison" | "errorCode" | "errorMessage" | "startedAt" | "completedAt" | "updatedAt">): ReplayRecord {
    const checkpoint = this.requireCheckpoint(input.checkpointId);
    const target = this.getRun(input.targetRunId);
    if (checkpoint.runId !== input.sourceRunId || target?.parentRunId !== input.sourceRunId) {
      throw new Error("Replay source, checkpoint, and target Run are inconsistent");
    }
    this.database
      .prepare(
        `INSERT INTO replays (
          id, checkpoint_id, source_run_id, source_event_id, target_run_id, mode,
          status, worktree_path, command_json, overrides_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.checkpointId,
        input.sourceRunId,
        input.sourceEventId ?? null,
        input.targetRunId,
        input.mode,
        input.worktreePath,
        canonicalJson(input.command),
        canonicalJson(input.overrides),
        input.createdAt,
        input.createdAt
      );
    return this.requireReplay(input.id);
  }

  getReplay(replayId: string): ReplayRecord | undefined {
    const row = this.database.prepare("SELECT * FROM replays WHERE id = ?").get(replayId) as
      | ReplayRow
      | undefined;
    return row === undefined ? undefined : mapReplay(row);
  }

  listReplays(sourceRunId: string): ReplayRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM replays WHERE source_run_id = ? ORDER BY created_at DESC, id DESC")
      .all(sourceRunId) as ReplayRow[];
    return rows.map(mapReplay);
  }

  getReplayByTargetRun(targetRunId: string): ReplayRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM replays WHERE target_run_id = ?")
      .get(targetRunId) as ReplayRow | undefined;
    return row === undefined ? undefined : mapReplay(row);
  }

  transitionReplay(input: {
    replayId: string;
    status: Exclude<ReplayStatus, "queued">;
    at: string;
    comparison?: unknown;
    errorCode?: string;
    errorMessage?: string;
  }): ReplayRecord {
    const replay = this.requireReplay(input.replayId);
    this.database
      .prepare(
        `UPDATE replays
         SET status = ?,
             started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
             completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END,
             comparison_json = ?, error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.status,
        input.at,
        input.status,
        input.at,
        input.comparison === undefined ? null : canonicalJson(input.comparison),
        input.errorCode ?? null,
        input.errorMessage === undefined ? null : redactText(input.errorMessage).value,
        input.at,
        replay.id
      );
    return this.requireReplay(replay.id);
  }

  createHostedWorkspace(input: {
    id: string;
    runId: string;
    checkpointId: string;
    sourceWorkspaceRoot: string;
    worktreePath: string;
    baseCommit: string;
    sourceFingerprintBefore: string;
    createdAt: string;
  }): HostedWorkspaceRecord {
    const checkpoint = this.requireCheckpoint(input.checkpointId);
    if (checkpoint.runId !== input.runId || checkpoint.workspaceRoot !== input.sourceWorkspaceRoot) {
      throw new Error("Hosted workspace Run, Checkpoint, and source workspace are inconsistent");
    }
    this.database
      .prepare(
        `INSERT INTO hosted_workspaces (
          id, run_id, checkpoint_id, source_workspace_root, worktree_path, base_commit,
          source_fingerprint_before, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`
      )
      .run(
        input.id,
        input.runId,
        input.checkpointId,
        input.sourceWorkspaceRoot,
        input.worktreePath,
        input.baseCommit,
        input.sourceFingerprintBefore,
        input.createdAt,
        input.createdAt
      );
    return this.requireHostedWorkspace(input.id);
  }

  getHostedWorkspace(workspaceId: string): HostedWorkspaceRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM hosted_workspaces WHERE id = ?")
      .get(workspaceId) as HostedWorkspaceRow | undefined;
    return row === undefined ? undefined : mapHostedWorkspace(row);
  }

  getHostedWorkspaceByRun(runId: string): HostedWorkspaceRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM hosted_workspaces WHERE run_id = ?")
      .get(runId) as HostedWorkspaceRow | undefined;
    return row === undefined ? undefined : mapHostedWorkspace(row);
  }

  listHostedWorkspaces(): HostedWorkspaceRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM hosted_workspaces ORDER BY created_at, id")
      .all() as HostedWorkspaceRow[];
    return rows.map(mapHostedWorkspace);
  }

  transitionHostedWorkspace(input: {
    workspaceId: string;
    status: Exclude<HostedWorkspaceStatus, "preparing">;
    at: string;
    sourceFingerprintAfter?: string;
    changedPaths?: string[];
    diffBlobHash?: string;
    errorCode?: string;
    errorMessage?: string;
  }): HostedWorkspaceRecord {
    const current = this.requireHostedWorkspace(input.workspaceId);
    if (!canTransitionHostedWorkspace(current.status, input.status)) {
      throw new Error(
        `Hosted workspace cannot transition from ${current.status} to ${input.status}: ${current.id}`
      );
    }
    if (input.diffBlobHash !== undefined && this.getBlob(input.diffBlobHash) === undefined) {
      throw new Error(`Hosted workspace diff Blob does not exist: ${input.diffBlobHash}`);
    }
    this.database
      .prepare(
        `UPDATE hosted_workspaces
         SET status = ?,
             source_fingerprint_after = COALESCE(?, source_fingerprint_after),
             changed_paths_json = COALESCE(?, changed_paths_json),
             diff_blob_hash = COALESCE(?, diff_blob_hash),
             last_error_code = ?,
             last_error_message = ?,
             ready_at = CASE WHEN ? = 'ready' THEN ? ELSE ready_at END,
             finalized_at = CASE WHEN ? IN ('finalized', 'failed') THEN ? ELSE finalized_at END,
             cleaned_at = CASE WHEN ? = 'cleaned' THEN ? ELSE cleaned_at END,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.sourceFingerprintAfter ?? null,
        input.changedPaths === undefined ? null : canonicalJson([...new Set(input.changedPaths)].sort()),
        input.diffBlobHash ?? null,
        input.errorCode ?? null,
        input.errorMessage === undefined ? null : redactText(input.errorMessage).value,
        input.status,
        input.at,
        input.status,
        input.at,
        input.status,
        input.at,
        input.at,
        current.id
      );
    return this.requireHostedWorkspace(current.id);
  }

  createPatchPromotion(input: {
    id: string;
    runId: string;
    hostedWorkspaceId: string;
    approvalId: string;
    actionDigest: string;
    actionContext: ActionContext;
    planHash: string;
    planBlobHash: string;
    selectedPaths: string[];
    sourceFingerprintBefore: string;
    worktreeFingerprintBefore: string;
    requestedAt: string;
  }): PatchPromotionRecord {
    const workspace = this.requireHostedWorkspace(input.hostedWorkspaceId);
    const approval = this.requireApproval(input.approvalId);
    const actionValidation = validateActionContext(input.actionContext);
    if (!actionValidation.ok) {
      throw new Error("Patch Promotion ActionContext is invalid");
    }
    if (
      workspace.runId !== input.runId ||
      approval.runId !== input.runId ||
      approval.actionDigest !== input.actionDigest ||
      input.actionContext.runId !== input.runId
    ) {
      throw new Error("Patch Promotion Run, workspace, Approval, and action digest are inconsistent");
    }
    if (workspace.status !== "finalized") {
      throw new Error(`Patch Promotion requires a finalized Hosted workspace: ${workspace.status}`);
    }
    if (approval.status !== "pending") {
      throw new Error(`Patch Promotion requires a pending Approval: ${approval.status}`);
    }
    if (
      approval.actionContext.tool !== "patch.promotion" ||
      input.actionContext.tool !== "patch.promotion" ||
      input.actionContext.contentHash !== input.planHash ||
      canonicalJson(approval.actionContext) !== canonicalJson(input.actionContext)
    ) {
      throw new Error("Patch Promotion Approval is not bound to the supplied plan");
    }
    if (input.selectedPaths.length === 0) {
      throw new Error("Patch Promotion requires at least one selected path");
    }
    const planBlob = this.getBlob(input.planBlobHash);
    if (planBlob === undefined) {
      throw new Error(`Patch Promotion plan Blob does not exist: ${input.planBlobHash}`);
    }
    if (planBlob.record.hash !== input.planHash) {
      throw new Error("Patch Promotion plan hash and Blob hash do not match");
    }
    this.database
      .prepare(
        `INSERT INTO patch_promotions (
          id, run_id, hosted_workspace_id, approval_id, action_digest,
          action_context_json, plan_hash, plan_blob_hash, selected_paths_json,
          source_fingerprint_before, worktree_fingerprint_before,
          status, requested_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting_approval', ?, ?)`
      )
      .run(
        input.id,
        input.runId,
        input.hostedWorkspaceId,
        input.approvalId,
        input.actionDigest,
        canonicalJson(input.actionContext),
        input.planHash,
        input.planBlobHash,
        canonicalJson([...new Set(input.selectedPaths)].sort()),
        input.sourceFingerprintBefore,
        input.worktreeFingerprintBefore,
        input.requestedAt,
        input.requestedAt
      );
    return this.requirePatchPromotion(input.id);
  }

  getPatchPromotion(promotionId: string): PatchPromotionRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM patch_promotions WHERE id = ?")
      .get(promotionId) as PatchPromotionRow | undefined;
    return row === undefined ? undefined : mapPatchPromotion(row);
  }

  getPatchPromotionByWorkspace(workspaceId: string): PatchPromotionRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM patch_promotions WHERE hosted_workspace_id = ?")
      .get(workspaceId) as PatchPromotionRow | undefined;
    return row === undefined ? undefined : mapPatchPromotion(row);
  }

  getPatchPromotionByApproval(approvalId: string): PatchPromotionRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM patch_promotions WHERE approval_id = ?")
      .get(approvalId) as PatchPromotionRow | undefined;
    return row === undefined ? undefined : mapPatchPromotion(row);
  }

  listPatchPromotions(runId: string): PatchPromotionRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM patch_promotions WHERE run_id = ? ORDER BY requested_at DESC, id DESC")
      .all(runId) as PatchPromotionRow[];
    return rows.map(mapPatchPromotion);
  }

  transitionPatchPromotion(input: {
    promotionId: string;
    status: Exclude<PatchPromotionStatus, "waiting_approval">;
    at: string;
    resultSourceFingerprint?: string;
    errorCode?: string;
    errorMessage?: string;
  }): PatchPromotionRecord {
    const current = this.requirePatchPromotion(input.promotionId);
    this.database
      .prepare(
        `UPDATE patch_promotions
         SET status = ?,
             result_source_fingerprint = COALESCE(?, result_source_fingerprint),
             error_code = ?,
             error_message = ?,
             started_at = CASE WHEN ? = 'applying' THEN ? ELSE started_at END,
             completed_at = CASE WHEN ? IN ('completed', 'denied', 'failed') THEN ? ELSE completed_at END,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.resultSourceFingerprint ?? null,
        input.errorCode ?? null,
        input.errorMessage === undefined ? null : redactText(input.errorMessage).value,
        input.status,
        input.at,
        input.status,
        input.at,
        input.at,
        current.id
      );
    return this.requirePatchPromotion(current.id);
  }

  createProviderSession(input: CreateProviderSessionInput): {
    session: ProviderSessionRecord;
    controlToken: string;
  } {
    if (this.getRun(input.runId) === undefined) {
      throw new Error(`Run not found: ${input.runId}`);
    }
    const id = uuidv7();
    const controlToken = randomBytes(32).toString("base64url");
    const timestamp = this.now().toISOString();
    this.database
      .prepare(
        `INSERT INTO provider_sessions (
          id, run_id, provider, adapter_version, runtime_version, protocol_version,
          mode, capabilities_json, control_token_hash, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`
      )
      .run(
        id,
        input.runId,
        input.provider,
        input.adapterVersion,
        input.runtimeVersion,
        input.protocolVersion,
        input.mode,
        canonicalJson(input.capabilities),
        sha256(controlToken),
        timestamp,
        timestamp
      );
    return { session: this.requireProviderSession(id), controlToken };
  }

  getProviderSession(sessionId: string): ProviderSessionRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM provider_sessions WHERE id = ?")
      .get(sessionId) as ProviderSessionRow | undefined;
    return row === undefined ? undefined : mapProviderSession(row);
  }

  getLatestProviderSession(runId: string): ProviderSessionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM provider_sessions
         WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(runId) as ProviderSessionRow | undefined;
    return row === undefined ? undefined : mapProviderSession(row);
  }

  listProviderSessions(runId: string): ProviderSessionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM provider_sessions
         WHERE run_id = ? ORDER BY created_at DESC, id DESC`
      )
      .all(runId) as ProviderSessionRow[];
    return rows.map(mapProviderSession);
  }

  verifyProviderSessionControlToken(sessionId: string, token: string): boolean {
    const row = this.database
      .prepare("SELECT control_token_hash FROM provider_sessions WHERE id = ?")
      .get(sessionId) as { control_token_hash: string } | undefined;
    if (row === undefined) return false;
    const expected = Buffer.from(row.control_token_hash, "hex");
    const actual = Buffer.from(sha256(token), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  transitionProviderSession(input: {
    sessionId: string;
    status: ProviderSessionStatus;
    externalSessionId?: string;
    processId?: number;
    errorCode?: string;
    errorMessage?: string;
  }): ProviderSessionRecord {
    const current = this.requireProviderSession(input.sessionId);
    if (!canTransitionProviderSession(current.status, input.status)) {
      throw new ProviderSessionStateError(current.id, current.status, input.status);
    }
    if (
      input.externalSessionId !== undefined &&
      current.externalSessionId !== undefined &&
      current.externalSessionId !== input.externalSessionId
    ) {
      throw new Error(`Provider external session ID cannot be replaced: ${current.id}`);
    }
    if (input.processId !== undefined && (!Number.isSafeInteger(input.processId) || input.processId <= 0)) {
      throw new Error(`Provider process ID is invalid: ${input.processId}`);
    }
    const timestamp = this.now().toISOString();
    const ended = isProviderSessionEnded(input.status);
    this.database
      .prepare(
        `UPDATE provider_sessions
         SET status = ?,
             external_session_id = COALESCE(?, external_session_id),
             process_id = CASE WHEN ? THEN NULL ELSE COALESCE(?, process_id) END,
             last_error_code = ?,
             last_error_message = ?,
             started_at = CASE
               WHEN ? IN ('starting', 'running') THEN COALESCE(started_at, ?)
               ELSE started_at
             END,
             ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.externalSessionId ?? null,
        ended ? 1 : 0,
        input.processId ?? null,
        input.errorCode ?? null,
        input.errorMessage === undefined ? null : redactText(input.errorMessage).value,
        input.status,
        timestamp,
        ended ? 1 : 0,
        timestamp,
        timestamp,
        current.id
      );
    return this.requireProviderSession(current.id);
  }

  recoverProviderSessions(): ProviderSessionRecord[] {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT * FROM provider_sessions
           WHERE status IN ('starting', 'running', 'stopping')
           ORDER BY created_at, id`
        )
        .all() as ProviderSessionRow[];
      const recovered: ProviderSessionRecord[] = [];
      for (const row of rows) {
        const session = this.transitionProviderSession({
          sessionId: row.id,
          status: "interrupted",
          errorCode: "host_restarted",
          errorMessage: "AFR restarted while the Provider session was active"
        });
        const run = this.getRun(row.run_id);
        if (run?.status === "created") {
          this.transitionRun(run.id, "failed", "afr-recovery", `provider-session:${row.id}`);
        } else if (run?.status === "running" || run?.status === "waiting_approval") {
          this.transitionRun(run.id, "interrupted", "afr-recovery", `provider-session:${row.id}`);
        }
        recovered.push(session);
      }
      return recovered;
    })();
  }

  recordProviderEvent(input: {
    sessionId: string;
    method: string;
    raw: unknown;
    parseStatus: ProviderEventParseStatus;
    providerEventId?: string;
    providerThreadId?: string;
    providerTurnId?: string;
    providerItemId?: string;
    gapReason?: string;
    normalizedEvent?: IncomingEvent;
    storeRaw?: boolean | undefined;
  }): ProviderEventRecord {
    const session = this.requireProviderSession(input.sessionId);
    if (input.method.trim().length === 0) throw new Error("Provider event method is required");
    if (input.parseStatus === "ignored" && input.normalizedEvent !== undefined) {
      throw new Error("Ignored Provider events cannot link a normalized event");
    }
    if (input.parseStatus !== "ignored" && input.normalizedEvent === undefined) {
      throw new Error(`${input.parseStatus} Provider events require a normalized event`);
    }
    if (input.normalizedEvent !== undefined && input.normalizedEvent.runId !== session.runId) {
      throw new Error("Normalized Provider event does not belong to the Provider session Run");
    }

    const sanitizedRaw = redactValue(input.raw).value;
    const rawJson = canonicalJson(sanitizedRaw);
    const rawHash = sha256(rawJson);
    const rawBlob = input.storeRaw === true
      ? this.putBlob(Buffer.from(rawJson), "application/json")
      : undefined;
    const receivedAt = this.now().toISOString();

    return this.database.transaction(() => {
      const sequenceRow = this.database
        .prepare(
          `SELECT COALESCE(MAX(arrival_sequence), 0) + 1 AS next_sequence
           FROM provider_events WHERE provider_session_id = ?`
        )
        .get(session.id) as { next_sequence: number };
      const normalized = input.normalizedEvent === undefined
        ? undefined
        : this.appendEvents(session.runId, [input.normalizedEvent])[0];
      const id = uuidv7();
      this.database
        .prepare(
          `INSERT INTO provider_events (
            id, provider_session_id, run_id, arrival_sequence, provider_method,
            provider_event_id, provider_thread_id, provider_turn_id, provider_item_id,
            raw_hash, raw_blob_hash, normalized_event_id, parse_status, gap_reason, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          session.id,
          session.runId,
          sequenceRow.next_sequence,
          redactText(input.method).value,
          redactOptional(input.providerEventId),
          redactOptional(input.providerThreadId),
          redactOptional(input.providerTurnId),
          redactOptional(input.providerItemId),
          rawHash,
          rawBlob?.hash ?? null,
          normalized?.eventId ?? null,
          input.parseStatus,
          input.gapReason === undefined ? null : redactText(input.gapReason).value,
          receivedAt
        );
      this.refreshRunCoverage(session.runId, session.id, receivedAt);
      return this.requireProviderEvent(id);
    })();
  }

  getProviderEvent(eventId: string): ProviderEventRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM provider_events WHERE id = ?")
      .get(eventId) as ProviderEventRow | undefined;
    return row === undefined ? undefined : mapProviderEvent(row);
  }

  listProviderEvents(
    sessionId: string,
    afterArrivalSequence = 0,
    limit = 50_000
  ): ProviderEventRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM provider_events
         WHERE provider_session_id = ? AND arrival_sequence > ?
         ORDER BY arrival_sequence
         LIMIT ?`
      )
      .all(
        sessionId,
        Math.max(0, afterArrivalSequence),
        Math.max(1, Math.min(limit, 50_000))
      ) as ProviderEventRow[];
    return rows.map(mapProviderEvent);
  }

  createProviderActionRequest(
    input: CreateProviderActionRequestInput
  ): ProviderActionRequestRecord {
    const session = this.requireProviderSession(input.sessionId);
    if (input.method.trim().length === 0) throw new Error("Provider request method is required");
    if (input.actionContext !== undefined && input.actionContext.runId !== session.runId) {
      throw new Error("Provider action request does not belong to the Provider session Run");
    }
    if ((input.actionContext === undefined) !== (input.actionDigest === undefined)) {
      throw new Error("Provider action context and digest must be persisted together");
    }
    if (input.actionContext !== undefined && !validateActionContext(input.actionContext).ok) {
      throw new Error("Provider action request ActionContext is invalid");
    }
    if (input.status === "waiting_approval" && input.approvalId === undefined) {
      throw new Error("Waiting Provider action requests require an Approval binding");
    }
    if (input.status === "accepted") {
      throw new Error("Provider action requests cannot be created as accepted");
    }
    if (input.approvalId !== undefined) {
      const approval = this.getApproval(input.approvalId);
      if (
        approval === undefined ||
        approval.runId !== session.runId ||
        approval.actionDigest !== input.actionDigest
      ) {
        throw new Error("Provider action request approval binding is invalid");
      }
    }

    const sanitizedRequest = redactValue(input.request).value;
    const requestJson = canonicalJson(sanitizedRequest);
    const requestBlob = input.storeRaw === true
      ? this.putBlob(Buffer.from(requestJson), "application/json")
      : undefined;
    const id = uuidv7();
    const timestamp = this.now().toISOString();
    this.database
      .prepare(
        `INSERT INTO provider_action_requests (
          id, provider_session_id, run_id, provider_rpc_id, provider_method,
          provider_thread_id, provider_turn_id, provider_item_id,
          request_hash, request_blob_hash, action_digest, action_context_json,
          approval_id, status, decision_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        session.id,
        session.runId,
        String(input.rpcId),
        redactText(input.method).value,
        redactOptional(input.providerThreadId),
        redactOptional(input.providerTurnId),
        redactOptional(input.providerItemId),
        sha256(requestJson),
        requestBlob?.hash ?? null,
        input.actionDigest ?? null,
        input.actionContext === undefined ? null : canonicalJson(input.actionContext),
        input.approvalId ?? null,
        input.status,
        input.decisionReason === undefined ? null : redactText(input.decisionReason).value,
        timestamp,
        timestamp
      );
    return this.requireProviderActionRequest(id);
  }

  getProviderActionRequest(requestId: string): ProviderActionRequestRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM provider_action_requests WHERE id = ?")
      .get(requestId) as ProviderActionRequestRow | undefined;
    return row === undefined ? undefined : mapProviderActionRequest(row);
  }

  getProviderActionRequestByRpcId(
    sessionId: string,
    rpcId: string | number
  ): ProviderActionRequestRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM provider_action_requests
         WHERE provider_session_id = ? AND provider_rpc_id = ?`
      )
      .get(sessionId, String(rpcId)) as ProviderActionRequestRow | undefined;
    return row === undefined ? undefined : mapProviderActionRequest(row);
  }

  getProviderActionRequestByApproval(approvalId: string): ProviderActionRequestRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM provider_action_requests WHERE approval_id = ?")
      .get(approvalId) as ProviderActionRequestRow | undefined;
    return row === undefined ? undefined : mapProviderActionRequest(row);
  }

  listProviderActionRequests(sessionId: string): ProviderActionRequestRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM provider_action_requests
         WHERE provider_session_id = ? ORDER BY created_at, id`
      )
      .all(sessionId) as ProviderActionRequestRow[];
    return rows.map(mapProviderActionRequest);
  }

  recordNetworkMediation(input: RecordNetworkMediationInput): NetworkMediationRecord {
    const session = this.requireProviderSession(input.sessionId);
    if (input.operation.trim().length === 0) {
      throw new Error("Network mediation operation is required");
    }
    const requestedPolicyJson = sanitizedJson(input.requestedPolicy);
    const effectivePolicyJson = sanitizedJson(input.effectivePolicy);
    const evidenceJson = sanitizedJson(input.evidence);
    const createdAt = this.now().toISOString();

    return this.database.transaction(() => {
      const sequence = this.database
        .prepare(
          `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence
           FROM network_mediation_records WHERE provider_session_id = ?`
        )
        .get(session.id) as { next_sequence: number };
      const id = uuidv7();
      this.database
        .prepare(
          `INSERT INTO network_mediation_records (
             id, provider_session_id, run_id, sequence_no, source, operation, decision,
             requested_policy_json, effective_policy_json, evidence_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          session.id,
          session.runId,
          sequence.next_sequence,
          input.source,
          redactText(input.operation).value,
          input.decision,
          requestedPolicyJson,
          effectivePolicyJson,
          evidenceJson,
          createdAt
        );
      const record = this.getNetworkMediationRecord(id);
      if (record === undefined) throw new Error(`Network mediation record not found after insert: ${id}`);
      return record;
    })();
  }

  getNetworkMediationRecord(recordId: string): NetworkMediationRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM network_mediation_records WHERE id = ?")
      .get(recordId) as NetworkMediationRow | undefined;
    return row === undefined ? undefined : mapNetworkMediation(row);
  }

  listNetworkMediationRecords(
    sessionId: string,
    afterSequenceNo = 0,
    limit = 10_000
  ): NetworkMediationRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM network_mediation_records
         WHERE provider_session_id = ? AND sequence_no > ?
         ORDER BY sequence_no LIMIT ?`
      )
      .all(
        sessionId,
        Math.max(0, afterSequenceNo),
        Math.max(1, Math.min(limit, 10_000))
      ) as NetworkMediationRow[];
    return rows.map(mapNetworkMediation);
  }

  resolveProviderActionRequest(input: {
    requestId: string;
    status: Exclude<ProviderActionRequestStatus, "evaluating" | "waiting_approval">;
    response?: unknown;
    grantId?: string;
    reason?: string;
    storeRaw?: boolean | undefined;
  }): ProviderActionRequestRecord {
    const current = this.requireProviderActionRequest(input.requestId);
    if (current.status !== "evaluating" && current.status !== "waiting_approval") {
      throw new Error(`Provider action request is already resolved: ${current.id}`);
    }
    if (input.grantId !== undefined) {
      const grant = this.getExecutionGrant(input.grantId);
      if (
        grant === undefined ||
        grant.runId !== current.runId ||
        grant.actionDigest !== current.actionDigest ||
        grant.approvalId !== current.approvalId ||
        grant.status !== "consumed"
      ) {
        throw new Error("Provider action request requires a consumed, action-bound grant");
      }
    }
    if (input.status === "accepted" && input.grantId === undefined) {
      throw new Error("Accepted Provider actions require a consumed grant");
    }
    const responseJson = input.response === undefined
      ? undefined
      : canonicalJson(redactValue(input.response).value);
    const responseBlob = responseJson !== undefined && input.storeRaw === true
      ? this.putBlob(Buffer.from(responseJson), "application/json")
      : undefined;
    const timestamp = this.now().toISOString();
    this.database
      .prepare(
        `UPDATE provider_action_requests
         SET status = ?, grant_id = ?, response_hash = ?, response_blob_hash = ?,
             decision_reason = COALESCE(?, decision_reason), resolved_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.grantId ?? null,
        responseJson === undefined ? null : sha256(responseJson),
        responseBlob?.hash ?? null,
        input.reason === undefined ? null : redactText(input.reason).value,
        timestamp,
        timestamp,
        current.id
      );
    return this.requireProviderActionRequest(current.id);
  }

  recoverProviderActionRequests(): ProviderActionRequestRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id FROM provider_action_requests
         WHERE status IN ('evaluating', 'waiting_approval') ORDER BY created_at, id`
      )
      .all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.resolveProviderActionRequest({
      requestId: id,
      status: "rejected",
      reason: "AFR restarted before the Provider request received a response"
    }));
  }

  getRunCoverage(runId: string): RunCoverageRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM run_coverage WHERE run_id = ?")
      .get(runId) as RunCoverageRow | undefined;
    return row === undefined ? undefined : mapRunCoverage(row);
  }

  recomputeRunCoverage(runId: string): RunCoverageRecord {
    if (this.getRun(runId) === undefined) throw new Error(`Run not found: ${runId}`);
    const sessionId = this.getLatestProviderSession(runId)?.id;
    this.refreshRunCoverage(runId, sessionId, this.now().toISOString());
    const coverage = this.getRunCoverage(runId);
    if (coverage === undefined) throw new Error(`Run coverage could not be computed: ${runId}`);
    return coverage;
  }

  createApproval(input: CreateApprovalInput): ApprovalRecord {
    return this.database.transaction(() => {
      if (this.getRun(input.runId) === undefined) {
        throw new Error(`Run not found: ${input.runId}`);
      }
      const [requestEvent] = this.appendEvents(input.runId, [input.requestEvent]);
      if (requestEvent === undefined) {
        throw new Error("Approval request event was not appended");
      }
      this.database
        .prepare(
          `INSERT INTO approvals (
            id, run_id, request_event_id, action_digest, action_context_json, status,
            risk_level, policy_id, rule_id, reason_codes_json, request_reason,
            requested_by_actor_json, requested_at, request_expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.runId,
          requestEvent.eventId,
          input.actionDigest,
          canonicalJson(input.actionContext),
          input.riskLevel,
          input.policyId,
          input.ruleId,
          canonicalJson(input.reasonCodes),
          input.requestReason ?? null,
          canonicalJson(input.requestedBy),
          input.requestedAt,
          input.requestExpiresAt,
          input.requestedAt
        );
      const run = this.getRun(input.runId);
      if (run?.status === "running" || run?.status === "created") {
        this.transitionRun(input.runId, "waiting_approval", "afr-core", `approval:${input.id}`);
      }
      return this.requireApproval(input.id);
    })();
  }

  listApprovals(options: { runId?: string; status?: ApprovalStatus } = {}): ApprovalRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (options.runId !== undefined) {
      clauses.push("run_id = ?");
      values.push(options.runId);
    }
    if (options.status !== undefined) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.database
      .prepare(`SELECT * FROM approvals ${where} ORDER BY requested_at DESC, id DESC`)
      .all(...values) as ApprovalRow[];
    return rows.map(mapApproval);
  }

  getApproval(approvalId: string): ApprovalRecord | undefined {
    const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as
      | ApprovalRow
      | undefined;
    return row === undefined ? undefined : mapApproval(row);
  }

  decideApproval(input: {
    approvalId: string;
    decision: "approved" | "denied";
    decidedBy: string;
    reason?: string;
    decidedAt: string;
    decisionEvent: IncomingEvent;
    grant?: PersistGrantInput;
  }): ApprovalRecord {
    return this.database.transaction(() => {
      const current = this.requireApproval(input.approvalId);
      if (current.status !== "pending") {
        throw new ApprovalStateError(current.id, current.status);
      }
      const [decisionEvent] = this.appendEvents(current.runId, [input.decisionEvent]);
      if (decisionEvent === undefined) {
        throw new Error("Approval decision event was not appended");
      }
      if (input.decision === "approved") {
        if (input.grant === undefined || input.grant.approvalId !== current.id) {
          throw new Error("An approved decision requires a matching execution grant");
        }
        this.insertGrant(input.grant);
      }
      this.database
        .prepare(
          `UPDATE approvals
           SET status = ?, decided_by = ?, decision_reason = ?, decision_event_id = ?,
               grant_id = ?, decided_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.decision,
          input.decidedBy,
          input.reason ?? null,
          decisionEvent.eventId,
          input.grant?.id ?? null,
          input.decidedAt,
          input.decidedAt,
          current.id
        );
      this.resumeRunWithoutPendingApprovals(current.runId, current.id);
      return this.requireApproval(current.id);
    })();
  }

  persistGrant(input: PersistGrantInput): ExecutionGrantRecord {
    this.insertGrant(input);
    return this.requireGrant(input.id);
  }

  getExecutionGrant(grantId: string): ExecutionGrantRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM execution_grants WHERE id = ?")
      .get(grantId) as GrantRow | undefined;
    return row === undefined ? undefined : mapGrant(row);
  }

  consumeExecutionGrant(input: {
    grantId: string;
    runId: string;
    actionDigest: string;
    nonceHash: string;
    consumedAt: string;
    consumedEvent: IncomingEvent;
  }): ExecutionGrantRecord {
    return this.database.transaction(() => {
      const grant = this.getExecutionGrant(input.grantId);
      if (grant === undefined) throw new GrantStateError("not_found", input.grantId);
      if (grant.status === "consumed") throw new GrantStateError("consumed", input.grantId);
      if (grant.status === "expired" || grant.expiresAt <= input.consumedAt) {
        throw new GrantStateError("expired", input.grantId);
      }
      if (
        grant.runId !== input.runId ||
        grant.actionDigest !== input.actionDigest ||
        grant.nonceHash !== input.nonceHash
      ) {
        throw new GrantStateError("mismatch", input.grantId);
      }
      this.database
        .prepare(
          `UPDATE execution_grants
           SET status = 'consumed', consumed_at = ?
           WHERE id = ?`
        )
        .run(input.consumedAt, grant.id);
      if (grant.approvalId !== undefined) {
        this.database
          .prepare(
            `UPDATE approvals
             SET status = 'consumed', consumed_at = ?, updated_at = ?
             WHERE id = ? AND status = 'approved'`
          )
          .run(input.consumedAt, input.consumedAt, grant.approvalId);
      }
      this.appendEvents(grant.runId, [input.consumedEvent]);
      return this.requireGrant(grant.id);
    })();
  }

  expireDueApprovals(at = this.now().toISOString()): ApprovalRecord[] {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT a.* FROM approvals a
           LEFT JOIN execution_grants g ON g.id = a.grant_id
           WHERE (a.status = 'pending' AND a.request_expires_at <= ?)
              OR (a.status = 'approved' AND g.status = 'active' AND g.expires_at <= ?)`
        )
        .all(at, at) as ApprovalRow[];
      const expired: ApprovalRecord[] = [];
      for (const row of rows) {
        if (row.grant_id !== null) {
          this.database
            .prepare(
              "UPDATE execution_grants SET status = 'expired' WHERE id = ? AND status = 'active'"
            )
            .run(row.grant_id);
        }
        this.database
          .prepare(
            `UPDATE approvals SET status = 'expired', updated_at = ?
             WHERE id = ? AND status IN ('pending', 'approved')`
          )
          .run(at, row.id);
        const event: IncomingEvent = {
          schemaVersion: EVENT_SCHEMA_VERSION,
          eventId: uuidv7(),
          runId: row.run_id,
          idempotencyKey: `approval-expired:${row.id}`,
          occurredAt: at,
          actor: { type: "system", id: "afr-core" },
          eventType: "approval.expired",
          status: "error",
          payload: { approvalId: row.id, actionDigest: row.action_digest }
        };
        this.appendEvents(row.run_id, [event]);
        this.resumeRunWithoutPendingApprovals(row.run_id, row.id);
        expired.push(this.requireApproval(row.id));
      }
      return expired;
    })();
  }

  expireExecutionGrant(grantId: string, at: string): ExecutionGrantRecord {
    return this.database.transaction(() => {
      const grant = this.requireGrant(grantId);
      if (grant.status === "active") {
        this.database
          .prepare("UPDATE execution_grants SET status = 'expired' WHERE id = ?")
          .run(grant.id);
        if (grant.approvalId !== undefined) {
          this.database
            .prepare(
              `UPDATE approvals SET status = 'expired', updated_at = ?
               WHERE id = ? AND status = 'approved'`
            )
            .run(at, grant.approvalId);
        }
      }
      return this.requireGrant(grant.id);
    })();
  }

  createSnapshot(input: {
    id: string;
    runId: string;
    path: string;
    contentBlobHash: string;
    beforeHash: string;
    byteSize: number;
    exact: boolean;
    createdAt: string;
    event: IncomingEvent;
  }): SnapshotRecord {
    return this.database.transaction(() => {
      const [event] = this.appendEvents(input.runId, [input.event]);
      if (event === undefined) throw new Error("Snapshot event was not appended");
      this.database
        .prepare(
          `INSERT INTO snapshots (
            id, run_id, event_id, kind, path, content_blob_hash,
            before_hash, byte_size, exact, created_at
          ) VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.runId,
          event.eventId,
          input.path,
          input.contentBlobHash,
          input.beforeHash,
          input.byteSize,
          input.exact ? 1 : 0,
          input.createdAt
        );
      return this.requireSnapshot(input.id);
    })();
  }

  getSnapshot(snapshotId: string): SnapshotRecord | undefined {
    const row = this.database.prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId) as
      | SnapshotRow
      | undefined;
    return row === undefined ? undefined : mapSnapshot(row);
  }

  linkApprovalSnapshot(approvalId: string, snapshotId: string): ApprovalRecord {
    const result = this.database
      .prepare(
        `UPDATE approvals SET snapshot_id = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND snapshot_id IS NULL`
      )
      .run(snapshotId, this.now().toISOString(), approvalId);
    if (result.changes !== 1) {
      const approval = this.requireApproval(approvalId);
      throw new ApprovalStateError(approvalId, approval.status);
    }
    return this.requireApproval(approvalId);
  }

  createGatewayAction(input: Omit<GatewayActionRecord, "status" | "updatedAt" | "executedAt" | "errorCode" | "resultEventId">): GatewayActionRecord {
    this.database
      .prepare(
        `INSERT INTO gateway_actions (
          id, run_id, approval_id, snapshot_id, kind, action_digest,
          action_context_json, target_path, status, requested_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting_approval', ?, ?)`
      )
      .run(
        input.id,
        input.runId,
        input.approvalId ?? null,
        input.snapshotId ?? null,
        input.kind,
        input.actionDigest,
        canonicalJson(input.actionContext),
        input.targetPath,
        input.requestedAt,
        input.requestedAt
      );
    return this.requireGatewayAction(input.id);
  }

  getGatewayAction(actionId: string): GatewayActionRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM gateway_actions WHERE id = ?")
      .get(actionId) as GatewayActionRow | undefined;
    return row === undefined ? undefined : mapGatewayAction(row);
  }

  getGatewayActionByApproval(approvalId: string): GatewayActionRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM gateway_actions WHERE approval_id = ?")
      .get(approvalId) as GatewayActionRow | undefined;
    return row === undefined ? undefined : mapGatewayAction(row);
  }

  transitionGatewayAction(input: {
    actionId: string;
    status: GatewayActionRecord["status"];
    at: string;
    errorCode?: string;
    resultEvent?: IncomingEvent;
  }): GatewayActionRecord {
    return this.database.transaction(() => {
      const current = this.requireGatewayAction(input.actionId);
      let resultEventId: string | null = null;
      if (input.resultEvent !== undefined) {
        const [event] = this.appendEvents(current.runId, [input.resultEvent]);
        if (event === undefined) throw new Error("Gateway result event was not appended");
        resultEventId = event.eventId;
      }
      this.database
        .prepare(
          `UPDATE gateway_actions
           SET status = ?, updated_at = ?,
               executed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE executed_at END,
               error_code = ?, result_event_id = COALESCE(?, result_event_id)
           WHERE id = ?`
        )
        .run(
          input.status,
          input.at,
          input.status,
          input.at,
          input.errorCode ?? null,
          resultEventId,
          current.id
        );
      return this.requireGatewayAction(current.id);
    })();
  }

  transitionRun(
    runId: string,
    to: RunStatus,
    actorId = "afr-core",
    reason?: string
  ): RunRecord {
    return this.database.transaction(() => {
      const current = this.getRun(runId);
      if (current === undefined) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (!canTransitionRun(current.status, to)) {
        throw new RunTransitionError(runId, current.status, to);
      }

      const timestamp = this.now().toISOString();
      const event: IncomingEvent = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: uuidv7(),
        runId,
        idempotencyKey: `run-transition:${runId}:${current.status}:${to}:${timestamp}`,
        occurredAt: timestamp,
        actor: { type: "system", id: actorId },
        eventType: "run.status_changed",
        status: "success",
        payload: {
          from: current.status,
          to,
          ...(reason === undefined ? {} : { reason })
        }
      };
      this.appendEvents(runId, [event]);
      this.database
        .prepare(
          `UPDATE runs
           SET status = ?,
               started_at = CASE
                 WHEN ? = 'running' THEN COALESCE(started_at, ?)
                 ELSE started_at
               END,
               ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
               updated_at = ?
           WHERE id = ?`
        )
        .run(to, to, timestamp, isTerminalRunStatus(to) ? 1 : 0, timestamp, timestamp, runId);

      const updated = this.getRun(runId);
      if (updated === undefined) {
        throw new Error(`Updated Run could not be read: ${runId}`);
      }
      return updated;
    })();
  }

  putBlob(content: Uint8Array, mediaType = "application/octet-stream"): StoredBlob {
    const blob = this.blobs.put(content, mediaType);
    this.database
      .prepare(
        `INSERT INTO blobs (
           hash, media_type, byte_size, relative_path, redaction_state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`
      )
      .run(
        blob.hash,
        mediaType,
        blob.byteSize,
        blob.relativePath,
        blob.redactionState,
        this.now().toISOString()
      );
    return blob;
  }

  appendEvents(runId: string, incomingEvents: readonly IncomingEvent[]): EventEnvelope[] {
    const sanitizedEvents: IncomingEvent[] = [];
    for (const event of incomingEvents) {
      const validation = validateIncomingEvent(event);
      if (!validation.ok) {
        throw new EventValidationError(validation.issues);
      }
      if (event.runId !== runId) {
        throw new EventValidationError([
          { path: "/runId", message: "Event Run does not match request scope" }
        ]);
      }
      const sanitized = redactIncomingEvent(event).value;
      const sanitizedValidation = validateIncomingEvent(sanitized);
      if (!sanitizedValidation.ok) {
        throw new EventValidationError(sanitizedValidation.issues);
      }
      sanitizedEvents.push(sanitized);
    }

    return this.database.transaction(() => {
      const run = this.database
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(runId) as RunRow | undefined;
      if (run === undefined) {
        throw new Error(`Run not found: ${runId}`);
      }

      let sequenceNo = run.last_sequence_no;
      let previousEventHash = this.lastEventHash(runId);
      const appended: EventEnvelope[] = [];

      for (const incoming of sanitizedEvents) {
        const fingerprint = sha256(canonicalJson(incoming));
        if (incoming.idempotencyKey !== undefined) {
          const existing = this.database
            .prepare(
              `SELECT envelope_json, idempotency_fingerprint
               FROM events WHERE run_id = ? AND idempotency_key = ?`
            )
            .get(runId, incoming.idempotencyKey) as EventRow | undefined;
          if (existing !== undefined) {
            if (existing.idempotency_fingerprint !== fingerprint) {
              throw new IdempotencyConflictError(runId, incoming.idempotencyKey);
            }
            appended.push(JSON.parse(existing.envelope_json) as EventEnvelope);
            continue;
          }
        }

        this.assertBlobsRegistered(incoming.blobRefs ?? []);
        sequenceNo += 1;
        const recordedAt = this.now().toISOString();
        const unsignedEnvelope = {
          ...incoming,
          sequenceNo,
          recordedAt,
          ...(previousEventHash === undefined ? {} : { previousEventHash })
        };
        const envelope: EventEnvelope = {
          ...unsignedEnvelope,
          contentHash: sha256(canonicalJson(unsignedEnvelope))
        };
        const envelopeValidation = validateEventEnvelope(envelope);
        if (!envelopeValidation.ok) {
          throw new EventValidationError(envelopeValidation.issues);
        }

        this.database
          .prepare(
            `INSERT INTO events (
              id, run_id, sequence_no, idempotency_key, idempotency_fingerprint,
              event_type, status, occurred_at, recorded_at, content_hash,
              previous_hash, envelope_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            envelope.eventId,
            runId,
            envelope.sequenceNo,
            envelope.idempotencyKey ?? null,
            envelope.idempotencyKey === undefined ? null : fingerprint,
            envelope.eventType,
            envelope.status,
            envelope.occurredAt,
            envelope.recordedAt,
            envelope.contentHash,
            envelope.previousEventHash ?? null,
            canonicalJson(envelope)
          );

        for (const blobRef of new Set(envelope.blobRefs ?? [])) {
          this.database
            .prepare("INSERT INTO event_blobs (event_id, blob_hash) VALUES (?, ?)")
            .run(envelope.eventId, blobRef.slice("sha256:".length));
        }

        previousEventHash = envelope.contentHash;
        appended.push(envelope);
      }

      if (sequenceNo !== run.last_sequence_no) {
        this.database
          .prepare(
            "UPDATE runs SET last_sequence_no = ?, updated_at = ? WHERE id = ?"
          )
          .run(sequenceNo, this.now().toISOString(), runId);
      }
      return appended;
    })();
  }

  listEvents(runId: string, afterSequenceNo = 0, limit = 50_000): EventEnvelope[] {
    const rows = this.database
      .prepare(
        `SELECT envelope_json FROM events
         WHERE run_id = ? AND sequence_no > ?
         ORDER BY sequence_no
         LIMIT ?`
      )
      .all(runId, Math.max(0, afterSequenceNo), Math.max(1, Math.min(limit, 50_000))) as EventRow[];
    return rows.map((row) => JSON.parse(row.envelope_json) as EventEnvelope);
  }

  getBlob(hash: string): { record: BlobRecord; content: Buffer } | undefined {
    const row = this.database
      .prepare(
        `SELECT hash, media_type, byte_size, redaction_state
         FROM blobs WHERE hash = ?`
      )
      .get(hash) as
      | {
          hash: string;
          media_type: string;
          byte_size: number;
          redaction_state: BlobRecord["redactionState"];
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      record: {
        hash: row.hash,
        mediaType: row.media_type,
        byteSize: row.byte_size,
        redactionState: row.redaction_state
      },
      content: this.blobs.read(hash)
    };
  }

  verifyRunChain(runId: string): boolean {
    const events = this.listEvents(runId);
    const run = this.getRun(runId);
    if (run === undefined || events.length !== run.lastSequenceNo) {
      return false;
    }
    let previous: string | undefined;
    for (const event of events) {
      if (event.previousEventHash !== previous) {
        return false;
      }
      const { contentHash, ...unsigned } = event;
      if (sha256(canonicalJson(unsigned)) !== contentHash) {
        return false;
      }
      previous = contentHash;
    }
    return true;
  }

  recover(): RecoveryReport {
    const quickCheck = String(this.database.pragma("quick_check", { simple: true }));
    if (quickCheck !== "ok") {
      throw new Error(`SQLite integrity check failed: ${quickCheck}`);
    }
    const runIds = this.database.prepare("SELECT id FROM runs").all() as Array<{ id: string }>;
    for (const { id } of runIds) {
      if (!this.verifyRunChain(id)) {
        throw new Error(`Event hash chain verification failed: ${id}`);
      }
    }
    this.recoverProviderActionRequests();
    const interruptedProviderSessions = this.recoverProviderSessions().length;
    return {
      quickCheck: "ok",
      removedTemporaryBlobs: this.blobs.removeTemporaryFiles(),
      verifiedRuns: runIds.length,
      interruptedProviderSessions
    };
  }

  private lastEventHash(runId: string): string | undefined {
    const row = this.database
      .prepare(
        "SELECT content_hash FROM events WHERE run_id = ? ORDER BY sequence_no DESC LIMIT 1"
      )
      .get(runId) as { content_hash: string } | undefined;
    return row?.content_hash;
  }

  private assertBlobsRegistered(blobRefs: readonly string[]): void {
    const query = this.database.prepare("SELECT 1 FROM blobs WHERE hash = ?");
    for (const ref of blobRefs) {
      const hash = ref.slice("sha256:".length);
      if (query.get(hash) === undefined || !this.blobs.has(hash)) {
        throw new MissingBlobError(hash);
      }
    }
  }

  private requireApproval(approvalId: string): ApprovalRecord {
    const approval = this.getApproval(approvalId);
    if (approval === undefined) throw new ApprovalNotFoundError(approvalId);
    return approval;
  }

  private insertGrant(input: PersistGrantInput): void {
    this.database
      .prepare(
        `INSERT INTO execution_grants (
          id, approval_id, run_id, action_digest, nonce_hash, status,
          issued_by, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(
        input.id,
        input.approvalId ?? null,
        input.runId,
        input.actionDigest,
        input.nonceHash,
        input.issuedBy,
        input.issuedAt,
        input.expiresAt
      );
  }

  private requireGrant(grantId: string): ExecutionGrantRecord {
    const grant = this.getExecutionGrant(grantId);
    if (grant === undefined) throw new GrantStateError("not_found", grantId);
    return grant;
  }

  private requireSnapshot(snapshotId: string): SnapshotRecord {
    const snapshot = this.getSnapshot(snapshotId);
    if (snapshot === undefined) throw new Error(`Snapshot does not exist: ${snapshotId}`);
    return snapshot;
  }

  private requireGatewayAction(actionId: string): GatewayActionRecord {
    const action = this.getGatewayAction(actionId);
    if (action === undefined) throw new Error(`Gateway action does not exist: ${actionId}`);
    return action;
  }

  private refreshRunCoverage(runId: string, sessionId: string | undefined, calculatedAt: string): void {
    const aggregate = this.database
      .prepare(
        `SELECT
           COUNT(*) AS provider_event_count,
           COALESCE(SUM(CASE WHEN normalized_event_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS normalized_event_count,
           COALESCE(SUM(CASE WHEN parse_status = 'ignored' THEN 1 ELSE 0 END), 0) AS ignored_event_count,
           COALESCE(SUM(CASE WHEN parse_status IN ('gap', 'invalid') THEN 1 ELSE 0 END), 0) AS gap_count,
           COALESCE(SUM(CASE WHEN gap_reason LIKE 'unknown_%' THEN 1 ELSE 0 END), 0) AS unknown_event_count,
           COALESCE(SUM(CASE WHEN parse_status = 'invalid' THEN 1 ELSE 0 END), 0) AS invalid_event_count
         FROM provider_events WHERE run_id = ?`
      )
      .get(runId) as {
        provider_event_count: number;
        normalized_event_count: number;
        ignored_event_count: number;
        gap_count: number;
        unknown_event_count: number;
        invalid_event_count: number;
      };
    const statusRows = this.database
      .prepare(
        `SELECT parse_status AS name, COUNT(*) AS count
         FROM provider_events WHERE run_id = ? GROUP BY parse_status ORDER BY parse_status`
      )
      .all(runId) as Array<{ name: string; count: number }>;
    const methodRows = this.database
      .prepare(
        `SELECT provider_method AS name, COUNT(*) AS count
         FROM provider_events WHERE run_id = ? GROUP BY provider_method ORDER BY provider_method`
      )
      .all(runId) as Array<{ name: string; count: number }>;
    const gapRows = this.database
      .prepare(
        `SELECT gap_reason AS name, COUNT(*) AS count
         FROM provider_events
         WHERE run_id = ? AND gap_reason IS NOT NULL
         GROUP BY gap_reason ORDER BY gap_reason`
      )
      .all(runId) as Array<{ name: string; count: number }>;
    const recognized = aggregate.provider_event_count - aggregate.gap_count;
    const coveragePercent = aggregate.provider_event_count === 0
      ? 0
      : Math.round((recognized / aggregate.provider_event_count) * 10_000) / 100;
    const workspace = this.getHostedWorkspaceByRun(runId);
    const workspaceEvidence: RunCoverageRecord["summary"]["workspaceEvidence"] = workspace === undefined
      ? "missing"
      : workspace.status === "finalized" || workspace.status === "cleaned"
        ? workspace.sourceFingerprintAfter === workspace.sourceFingerprintBefore ? "verified" : "failed"
        : workspace.status === "failed" ? "failed" : "pending";
    const coverageLevel: RunCoverageRecord["coverageLevel"] = aggregate.provider_event_count === 0
      ? "L0"
      : aggregate.gap_count === 0 && workspaceEvidence === "verified" ? "L2" : "L1";
    const summary = {
      parseStatuses: Object.fromEntries(statusRows.map((row) => [row.name, row.count])),
      providerMethods: Object.fromEntries(methodRows.map((row) => [row.name, row.count])),
      gapReasons: Object.fromEntries(gapRows.map((row) => [row.name, row.count])),
      workspaceEvidence
    };
    this.database
      .prepare(
        `INSERT INTO run_coverage (
           run_id, provider_session_id, provider_event_count, normalized_event_count,
           ignored_event_count, gap_count, unknown_event_count, invalid_event_count,
           coverage_percent, coverage_level, summary_json, calculated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           provider_session_id = excluded.provider_session_id,
           provider_event_count = excluded.provider_event_count,
           normalized_event_count = excluded.normalized_event_count,
           ignored_event_count = excluded.ignored_event_count,
           gap_count = excluded.gap_count,
           unknown_event_count = excluded.unknown_event_count,
           invalid_event_count = excluded.invalid_event_count,
           coverage_percent = excluded.coverage_percent,
           coverage_level = excluded.coverage_level,
           summary_json = excluded.summary_json,
           calculated_at = excluded.calculated_at`
      )
      .run(
        runId,
        sessionId ?? null,
        aggregate.provider_event_count,
        aggregate.normalized_event_count,
        aggregate.ignored_event_count,
        aggregate.gap_count,
        aggregate.unknown_event_count,
        aggregate.invalid_event_count,
        coveragePercent,
        coverageLevel,
        canonicalJson(summary),
        calculatedAt
      );
  }

  private requireCheckpoint(checkpointId: string): CheckpointRecord {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (checkpoint === undefined) throw new Error(`Checkpoint does not exist: ${checkpointId}`);
    return checkpoint;
  }

  private requireReplay(replayId: string): ReplayRecord {
    const replay = this.getReplay(replayId);
    if (replay === undefined) throw new Error(`Replay does not exist: ${replayId}`);
    return replay;
  }

  private requireHostedWorkspace(workspaceId: string): HostedWorkspaceRecord {
    const workspace = this.getHostedWorkspace(workspaceId);
    if (workspace === undefined) throw new Error(`Hosted workspace does not exist: ${workspaceId}`);
    return workspace;
  }

  private requirePatchPromotion(promotionId: string): PatchPromotionRecord {
    const promotion = this.getPatchPromotion(promotionId);
    if (promotion === undefined) throw new Error(`Patch Promotion does not exist: ${promotionId}`);
    return promotion;
  }

  private requireProviderSession(sessionId: string): ProviderSessionRecord {
    const session = this.getProviderSession(sessionId);
    if (session === undefined) throw new Error(`Provider session does not exist: ${sessionId}`);
    return session;
  }

  private requireProviderEvent(eventId: string): ProviderEventRecord {
    const event = this.getProviderEvent(eventId);
    if (event === undefined) throw new Error(`Provider event does not exist: ${eventId}`);
    return event;
  }

  private requireProviderActionRequest(requestId: string): ProviderActionRequestRecord {
    const request = this.getProviderActionRequest(requestId);
    if (request === undefined) throw new Error(`Provider action request does not exist: ${requestId}`);
    return request;
  }

  private resumeRunWithoutPendingApprovals(runId: string, approvalId: string): void {
    const pending = this.database
      .prepare("SELECT 1 FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1")
      .get(runId);
    const run = this.getRun(runId);
    if (pending === undefined && run?.status === "waiting_approval") {
      this.transitionRun(runId, "running", "afr-core", `approval-resolved:${approvalId}`);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactOptional(value: string | undefined): string | null {
  return value === undefined ? null : redactText(value).value;
}

function sanitizedJson(value: unknown): string | null {
  return value === undefined ? null : canonicalJson(redactValue(value).value);
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function canTransitionProviderSession(
  from: ProviderSessionStatus,
  to: ProviderSessionStatus
): boolean {
  const transitions: Record<ProviderSessionStatus, readonly ProviderSessionStatus[]> = {
    created: ["starting", "failed", "cancelled"],
    starting: ["running", "failed", "cancelled", "interrupted"],
    running: ["stopping", "completed", "failed", "cancelled", "interrupted"],
    stopping: ["completed", "failed", "cancelled", "interrupted"],
    completed: [],
    failed: [],
    cancelled: [],
    interrupted: []
  };
  return transitions[from].includes(to);
}

function canTransitionHostedWorkspace(
  from: HostedWorkspaceStatus,
  to: HostedWorkspaceStatus
): boolean {
  const transitions: Record<HostedWorkspaceStatus, readonly HostedWorkspaceStatus[]> = {
    preparing: ["ready", "failed"],
    ready: ["active", "finalized", "failed"],
    active: ["finalized", "failed"],
    finalized: ["cleaned"],
    failed: ["cleaned"],
    cleaned: []
  };
  return transitions[from].includes(to);
}

function isProviderSessionEnded(status: ProviderSessionStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectPath: row.project_path,
    task: row.task,
    agentId: row.agent_id,
    status: row.status,
    lastSequenceNo: row.last_sequence_no,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
    ...(row.forked_from_event_id === null ? {} : { forkedFromEventId: row.forked_from_event_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at })
  };
}

function mapCheckpoint(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    runId: row.run_id,
    eventId: row.event_id,
    workspaceRoot: row.workspace_root,
    baseCommit: row.base_commit,
    manifestBlobHash: row.manifest_blob_hash,
    untrackedCount: row.untracked_count,
    totalBytes: row.total_bytes,
    createdAt: row.created_at,
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    ...(row.tracked_diff_blob_hash === null ? {} : { trackedDiffBlobHash: row.tracked_diff_blob_hash })
  };
}

function mapReplay(row: ReplayRow): ReplayRecord {
  return {
    id: row.id,
    checkpointId: row.checkpoint_id,
    sourceRunId: row.source_run_id,
    targetRunId: row.target_run_id,
    mode: row.mode,
    status: row.status,
    worktreePath: row.worktree_path,
    command: JSON.parse(row.command_json) as string[],
    overrides: JSON.parse(row.overrides_json) as Record<string, string>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    ...(row.comparison_json === null ? {} : { comparison: JSON.parse(row.comparison_json) as unknown }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at })
  };
}

function mapProviderSession(row: ProviderSessionRow): ProviderSessionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    provider: row.provider,
    adapterVersion: row.adapter_version,
    runtimeVersion: row.runtime_version,
    protocolVersion: row.protocol_version,
    mode: row.mode,
    capabilities: JSON.parse(row.capabilities_json) as ProviderCapabilitySnapshot,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.external_session_id === null ? {} : { externalSessionId: row.external_session_id }),
    ...(row.process_id === null ? {} : { processId: row.process_id }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at })
  };
}

function mapHostedWorkspace(row: HostedWorkspaceRow): HostedWorkspaceRecord {
  return {
    id: row.id,
    runId: row.run_id,
    checkpointId: row.checkpoint_id,
    sourceWorkspaceRoot: row.source_workspace_root,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    sourceFingerprintBefore: row.source_fingerprint_before,
    status: row.status,
    changedPaths: JSON.parse(row.changed_paths_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.source_fingerprint_after === null
      ? {}
      : { sourceFingerprintAfter: row.source_fingerprint_after }),
    ...(row.diff_blob_hash === null ? {} : { diffBlobHash: row.diff_blob_hash }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
    ...(row.ready_at === null ? {} : { readyAt: row.ready_at }),
    ...(row.finalized_at === null ? {} : { finalizedAt: row.finalized_at }),
    ...(row.cleaned_at === null ? {} : { cleanedAt: row.cleaned_at })
  };
}

function mapPatchPromotion(row: PatchPromotionRow): PatchPromotionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    hostedWorkspaceId: row.hosted_workspace_id,
    approvalId: row.approval_id,
    actionDigest: row.action_digest,
    actionContext: JSON.parse(row.action_context_json) as ActionContext,
    planHash: row.plan_hash,
    planBlobHash: row.plan_blob_hash,
    selectedPaths: JSON.parse(row.selected_paths_json) as string[],
    sourceFingerprintBefore: row.source_fingerprint_before,
    worktreeFingerprintBefore: row.worktree_fingerprint_before,
    status: row.status,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    ...(row.result_source_fingerprint === null
      ? {}
      : { resultSourceFingerprint: row.result_source_fingerprint }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at })
  };
}

function mapProviderEvent(row: ProviderEventRow): ProviderEventRecord {
  return {
    id: row.id,
    providerSessionId: row.provider_session_id,
    runId: row.run_id,
    arrivalSequence: row.arrival_sequence,
    providerMethod: row.provider_method,
    rawHash: row.raw_hash,
    parseStatus: row.parse_status,
    receivedAt: row.received_at,
    ...(row.provider_event_id === null ? {} : { providerEventId: row.provider_event_id }),
    ...(row.provider_thread_id === null ? {} : { providerThreadId: row.provider_thread_id }),
    ...(row.provider_turn_id === null ? {} : { providerTurnId: row.provider_turn_id }),
    ...(row.provider_item_id === null ? {} : { providerItemId: row.provider_item_id }),
    ...(row.raw_blob_hash === null ? {} : { rawBlobHash: row.raw_blob_hash }),
    ...(row.normalized_event_id === null ? {} : { normalizedEventId: row.normalized_event_id }),
    ...(row.gap_reason === null ? {} : { gapReason: row.gap_reason })
  };
}

function mapProviderActionRequest(row: ProviderActionRequestRow): ProviderActionRequestRecord {
  return {
    id: row.id,
    providerSessionId: row.provider_session_id,
    runId: row.run_id,
    providerRpcId: row.provider_rpc_id,
    providerMethod: row.provider_method,
    requestHash: row.request_hash,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.provider_thread_id === null ? {} : { providerThreadId: row.provider_thread_id }),
    ...(row.provider_turn_id === null ? {} : { providerTurnId: row.provider_turn_id }),
    ...(row.provider_item_id === null ? {} : { providerItemId: row.provider_item_id }),
    ...(row.request_blob_hash === null ? {} : { requestBlobHash: row.request_blob_hash }),
    ...(row.action_digest === null ? {} : { actionDigest: row.action_digest }),
    ...(row.action_context_json === null
      ? {}
      : { actionContext: JSON.parse(row.action_context_json) as ActionContext }),
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    ...(row.grant_id === null ? {} : { grantId: row.grant_id }),
    ...(row.response_hash === null ? {} : { responseHash: row.response_hash }),
    ...(row.response_blob_hash === null ? {} : { responseBlobHash: row.response_blob_hash }),
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at })
  };
}

function mapNetworkMediation(row: NetworkMediationRow): NetworkMediationRecord {
  return {
    id: row.id,
    providerSessionId: row.provider_session_id,
    runId: row.run_id,
    sequenceNo: row.sequence_no,
    source: row.source,
    operation: row.operation,
    decision: row.decision,
    createdAt: row.created_at,
    ...(row.requested_policy_json === null
      ? {}
      : { requestedPolicy: JSON.parse(row.requested_policy_json) as unknown }),
    ...(row.effective_policy_json === null
      ? {}
      : { effectivePolicy: JSON.parse(row.effective_policy_json) as unknown }),
    ...(row.evidence_json === null
      ? {}
      : { evidence: JSON.parse(row.evidence_json) as unknown })
  };
}

function mapRunCoverage(row: RunCoverageRow): RunCoverageRecord {
  return {
    runId: row.run_id,
    providerEventCount: row.provider_event_count,
    normalizedEventCount: row.normalized_event_count,
    ignoredEventCount: row.ignored_event_count,
    gapCount: row.gap_count,
    unknownEventCount: row.unknown_event_count,
    invalidEventCount: row.invalid_event_count,
    coveragePercent: row.coverage_percent,
    coverageLevel: row.coverage_level,
    summary: JSON.parse(row.summary_json) as RunCoverageRecord["summary"],
    calculatedAt: row.calculated_at,
    ...(row.provider_session_id === null ? {} : { providerSessionId: row.provider_session_id })
  };
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    requestEventId: row.request_event_id,
    actionDigest: row.action_digest,
    actionContext: JSON.parse(row.action_context_json) as ActionContext,
    status: row.status,
    riskLevel: row.risk_level,
    policyId: row.policy_id,
    ruleId: row.rule_id,
    reasonCodes: JSON.parse(row.reason_codes_json) as string[],
    requestedBy: JSON.parse(row.requested_by_actor_json) as ActionContext["actor"],
    requestedAt: row.requested_at,
    requestExpiresAt: row.request_expires_at,
    updatedAt: row.updated_at,
    ...(row.request_reason === null ? {} : { requestReason: row.request_reason }),
    ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    ...(row.decision_event_id === null ? {} : { decisionEventId: row.decision_event_id }),
    ...(row.grant_id === null ? {} : { grantId: row.grant_id }),
    ...(row.snapshot_id === null ? {} : { snapshotId: row.snapshot_id }),
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at })
  };
}

function mapGrant(row: GrantRow): ExecutionGrantRecord {
  return {
    id: row.id,
    runId: row.run_id,
    actionDigest: row.action_digest,
    nonceHash: row.nonce_hash,
    status: row.status,
    issuedBy: row.issued_by,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at })
  };
}

function mapSnapshot(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    runId: row.run_id,
    eventId: row.event_id,
    kind: row.kind,
    path: row.path,
    contentBlobHash: row.content_blob_hash,
    beforeHash: row.before_hash,
    byteSize: row.byte_size,
    exact: row.exact === 1,
    createdAt: row.created_at
  };
}

function mapGatewayAction(row: GatewayActionRow): GatewayActionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    actionDigest: row.action_digest,
    actionContext: JSON.parse(row.action_context_json) as ActionContext,
    targetPath: row.target_path,
    status: row.status,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    ...(row.snapshot_id === null ? {} : { snapshotId: row.snapshot_id }),
    ...(row.executed_at === null ? {} : { executedAt: row.executed_at }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.result_event_id === null ? {} : { resultEventId: row.result_event_id })
  };
}

export function createRunCreatedEvent(run: RunRecord): IncomingEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: uuidv7(),
    runId: run.id,
    idempotencyKey: `run-created:${run.id}`,
    occurredAt: run.createdAt,
    actor: { type: "system", id: "afr-core" },
    eventType: "run.created",
    status: "success",
    payload: {
      task: run.task,
      projectPath: run.projectPath,
      agentId: run.agentId,
      ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      ...(run.forkedFromEventId === undefined ? {} : { forkedFromEventId: run.forkedFromEventId })
    }
  };
}
