import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  EVENT_SCHEMA_VERSION,
  type ActionContext,
  type ApprovalStatus,
  type IncomingEvent,
  validateActionContext
} from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import { canonicalJson } from "./canonical-json.js";
import {
  ApprovalNotFoundError,
  GrantStateError,
  LocalStore,
  type ApprovalRecord,
  type ExecutionGrantRecord,
  type PersistGrantInput
} from "./local-store.js";
import { evaluateAction, type PolicyConfig, type PolicyDecision } from "./policy.js";

const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;
const DEFAULT_GRANT_TTL_MS = 2 * 60 * 1000;

export type ExecutionGrant = {
  grantId: string;
  token: string;
  expiresAt: string;
};

export type ActionEvaluation = {
  decision: PolicyDecision;
  actionDigest: string;
  actionContext: ActionContext;
  approval?: ApprovalRecord;
  grant?: ExecutionGrant;
};

export type ApprovalServiceOptions = {
  dataDir: string;
  protectedPaths?: string[];
  networkReadAllowlist?: string[];
  networkReadAllowedPorts?: number[];
  approvalTtlMs?: number;
  grantTtlMs?: number;
  now?: () => Date;
  homeDir?: string;
};

type GrantPayload = {
  version: 1;
  grantId: string;
  approvalId?: string;
  runId: string;
  actionDigest: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};

export class GrantValidationError extends Error {
  constructor(
    readonly reason: "invalid" | "expired" | "consumed" | "action_mismatch",
    message: string
  ) {
    super(message);
    this.name = "GrantValidationError";
  }
}

export class ApprovalService {
  readonly signingKeyPath: string;
  private readonly signingKey: Buffer;
  private readonly now: () => Date;
  private readonly approvalTtlMs: number;
  private readonly grantTtlMs: number;

  constructor(readonly store: LocalStore, private readonly options: ApprovalServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    this.signingKeyPath = join(resolve(options.dataDir), "runtime", "grant-signing-key");
    this.signingKey = readOrCreateSigningKey(this.signingKeyPath);
  }

  evaluate(context: ActionContext, requestReason?: string): ActionEvaluation {
    assertActionContext(context);
    const now = this.now();
    this.store.expireDueApprovals(now.toISOString());
    const run = this.store.getRun(context.runId);
    if (run === undefined) throw new Error(`Run not found: ${context.runId}`);
    const policy = evaluateAction(context, this.policyConfig(run.projectPath));
    const canonicalContext = canonicalizeActionContext(context, policy.canonicalTargets, run.projectPath);
    const actionDigest = createActionDigest(canonicalContext);
    this.store.appendEvents(run.id, [policyEvent(canonicalContext, policy, actionDigest, now)]);

    if (policy.effect === "deny") {
      return { decision: policy, actionDigest, actionContext: canonicalContext };
    }
    if (policy.effect === "allow") {
      const grant = this.issueGrant({
        runId: run.id,
        actionDigest,
        issuedBy: `policy:${policy.ruleId}`,
        now
      });
      this.store.persistGrant(grant.record);
      return { decision: policy, actionDigest, actionContext: canonicalContext, grant: grant.publicGrant };
    }

    const approvalId = uuidv7();
    const requestedAt = now.toISOString();
    const requestExpiresAt = new Date(now.getTime() + this.approvalTtlMs).toISOString();
    const requestEvent: IncomingEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId: run.id,
      idempotencyKey: `approval-requested:${approvalId}`,
      occurredAt: requestedAt,
      actor: { type: "system", id: "afr-core" },
      eventType: "approval.requested",
      status: "pending",
      risk: riskFrom(policy),
      payload: {
        approvalId,
        actionDigest,
        actionContext: canonicalContext,
        reason: requestReason ?? "Agent requested a policy-protected action",
        requestExpiresAt,
        recoverability: canonicalContext.recoverability
      }
    };
    const approval = this.store.createApproval({
      id: approvalId,
      runId: run.id,
      actionDigest,
      actionContext: canonicalContext,
      riskLevel: policy.riskLevel,
      policyId: policy.policyId,
      ruleId: policy.ruleId,
      reasonCodes: policy.reasonCodes,
      ...(requestReason === undefined ? {} : { requestReason }),
      requestedBy: canonicalContext.actor,
      requestedAt,
      requestExpiresAt,
      requestEvent
    });
    return { decision: policy, actionDigest, actionContext: canonicalContext, approval };
  }

  list(options: { runId?: string; status?: ApprovalStatus } = {}): ApprovalRecord[] {
    this.store.expireDueApprovals(this.now().toISOString());
    return this.store.listApprovals(options);
  }

  get(approvalId: string): ApprovalRecord | undefined {
    this.store.expireDueApprovals(this.now().toISOString());
    return this.store.getApproval(approvalId);
  }

  decide(
    approvalId: string,
    decision: "approved" | "denied",
    decidedBy: string,
    reason?: string,
    actorType: "human" | "system" = "human"
  ): { approval: ApprovalRecord; grant?: ExecutionGrant } {
    const now = this.now();
    this.store.expireDueApprovals(now.toISOString());
    const approval = this.store.getApproval(approvalId);
    if (approval === undefined) throw new ApprovalNotFoundError(approvalId);
    let issued: ReturnType<ApprovalService["issueGrant"]> | undefined;
    if (decision === "approved") {
      issued = this.issueGrant({
        approvalId,
        runId: approval.runId,
        actionDigest: approval.actionDigest,
        issuedBy: decidedBy,
        now
      });
    }
    const event: IncomingEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId: approval.runId,
      idempotencyKey: `approval-decided:${approvalId}`,
      occurredAt: now.toISOString(),
      actor: { type: actorType, id: decidedBy },
      eventType: "approval.decided",
      status: decision === "approved" ? "success" : "cancelled",
      payload: {
        approvalId,
        decision,
        actionDigest: approval.actionDigest,
        ...(reason === undefined ? {} : { reason }),
        ...(issued === undefined ? {} : { grantId: issued.record.id, grantExpiresAt: issued.record.expiresAt })
      }
    };
    const updated = this.store.decideApproval({
      approvalId,
      decision,
      decidedBy,
      ...(reason === undefined ? {} : { reason }),
      decidedAt: now.toISOString(),
      decisionEvent: event,
      ...(issued === undefined ? {} : { grant: issued.record })
    });
    return {
      approval: updated,
      ...(issued === undefined ? {} : { grant: issued.publicGrant })
    };
  }

  consume(token: string, actualContext: ActionContext): ExecutionGrantRecord {
    assertActionContext(actualContext);
    const now = this.now();
    this.store.expireDueApprovals(now.toISOString());
    const payload = this.verifyToken(token);
    if (payload.expiresAt <= now.toISOString()) {
      this.store.expireExecutionGrant(payload.grantId, now.toISOString());
      this.recordRejection(payload, "expired", undefined, now);
      throw new GrantValidationError("expired", "Execution grant has expired");
    }
    const run = this.store.getRun(payload.runId);
    if (run === undefined || actualContext.runId !== payload.runId) {
      this.recordRejection(payload, "action_mismatch", undefined, now);
      throw new GrantValidationError("action_mismatch", "Execution grant Run does not match");
    }
    const policy = evaluateAction(actualContext, this.policyConfig(run.projectPath));
    const canonicalContext = canonicalizeActionContext(
      actualContext,
      policy.canonicalTargets,
      run.projectPath
    );
    const actualDigest = createActionDigest(canonicalContext);
    if (actualDigest !== payload.actionDigest) {
      this.recordRejection(payload, "action_mismatch", actualDigest, now);
      throw new GrantValidationError("action_mismatch", "Action parameters changed after approval");
    }
    const event: IncomingEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId: payload.runId,
      idempotencyKey: `approval-consumed:${payload.grantId}`,
      occurredAt: now.toISOString(),
      actor: { type: "system", id: "afr-gateway" },
      eventType: "approval.consumed",
      status: "success",
      payload: {
        grantId: payload.grantId,
        ...(payload.approvalId === undefined ? {} : { approvalId: payload.approvalId }),
        actionDigest: payload.actionDigest
      }
    };
    try {
      return this.store.consumeExecutionGrant({
        grantId: payload.grantId,
        runId: payload.runId,
        actionDigest: payload.actionDigest,
        nonceHash: sha256(payload.nonce),
        consumedAt: now.toISOString(),
        consumedEvent: event
      });
    } catch (error) {
      if (error instanceof GrantStateError) {
        const reason = error.reason === "consumed" ? "consumed" : error.reason === "expired" ? "expired" : "invalid";
        this.recordRejection(payload, reason, actualDigest, now);
        throw new GrantValidationError(reason, error.message);
      }
      throw error;
    }
  }

  consumeApproved(approvalId: string, actualContext: ActionContext): ExecutionGrantRecord {
    assertActionContext(actualContext);
    const now = this.now();
    this.store.expireDueApprovals(now.toISOString());
    const approval = this.store.getApproval(approvalId);
    if (approval === undefined) throw new ApprovalNotFoundError(approvalId);
    if (approval.status === "consumed") {
      throw new GrantValidationError("consumed", "Execution grant has already been consumed");
    }
    if (approval.status === "expired") {
      throw new GrantValidationError("expired", "Execution grant has expired");
    }
    if (approval.status !== "approved" || approval.grantId === undefined) {
      throw new GrantValidationError("invalid", "Approval has no active execution grant");
    }
    const grant = this.store.getExecutionGrant(approval.grantId);
    if (grant === undefined || grant.status !== "active") {
      throw new GrantValidationError(
        grant?.status === "consumed" ? "consumed" : grant?.status === "expired" ? "expired" : "invalid",
        "Approval execution grant is not active"
      );
    }
    if (grant.expiresAt <= now.toISOString()) {
      this.store.expireExecutionGrant(grant.id, now.toISOString());
      throw new GrantValidationError("expired", "Execution grant has expired");
    }
    const run = this.store.getRun(grant.runId);
    if (run === undefined || actualContext.runId !== grant.runId) {
      throw new GrantValidationError("action_mismatch", "Execution grant Run does not match");
    }
    const policy = evaluateAction(actualContext, this.policyConfig(run.projectPath));
    const canonicalContext = canonicalizeActionContext(
      actualContext,
      policy.canonicalTargets,
      run.projectPath
    );
    const actualDigest = createActionDigest(canonicalContext);
    if (actualDigest !== grant.actionDigest || actualDigest !== approval.actionDigest) {
      this.store.appendEvents(grant.runId, [grantRejectedEvent(
        grant,
        "action_mismatch",
        actualDigest,
        now
      )]);
      throw new GrantValidationError("action_mismatch", "Action parameters changed after approval");
    }
    return this.store.consumeExecutionGrant({
      grantId: grant.id,
      runId: grant.runId,
      actionDigest: grant.actionDigest,
      nonceHash: grant.nonceHash,
      consumedAt: now.toISOString(),
      consumedEvent: grantConsumedEvent(grant, now)
    });
  }

  private issueGrant(input: {
    approvalId?: string;
    runId: string;
    actionDigest: string;
    issuedBy: string;
    now: Date;
  }): { record: PersistGrantInput; publicGrant: ExecutionGrant } {
    const payload: GrantPayload = {
      version: 1,
      grantId: uuidv7(),
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      runId: input.runId,
      actionDigest: input.actionDigest,
      nonce: randomBytes(24).toString("base64url"),
      issuedAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + this.grantTtlMs).toISOString()
    };
    const encoded = Buffer.from(canonicalJson(payload)).toString("base64url");
    const signature = createHmac("sha256", this.signingKey).update(encoded).digest("base64url");
    return {
      record: {
        id: payload.grantId,
        ...(payload.approvalId === undefined ? {} : { approvalId: payload.approvalId }),
        runId: payload.runId,
        actionDigest: payload.actionDigest,
        nonceHash: sha256(payload.nonce),
        issuedBy: input.issuedBy,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt
      },
      publicGrant: { grantId: payload.grantId, token: `${encoded}.${signature}`, expiresAt: payload.expiresAt }
    };
  }

  private verifyToken(token: string): GrantPayload {
    const [encoded, suppliedSignature, extra] = token.split(".");
    if (encoded === undefined || suppliedSignature === undefined || extra !== undefined) {
      throw new GrantValidationError("invalid", "Execution grant format is invalid");
    }
    const expected = Buffer.from(
      createHmac("sha256", this.signingKey).update(encoded).digest("base64url")
    );
    const supplied = Buffer.from(suppliedSignature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new GrantValidationError("invalid", "Execution grant signature is invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new GrantValidationError("invalid", "Execution grant payload is invalid");
    }
    if (!isGrantPayload(value)) {
      throw new GrantValidationError("invalid", "Execution grant payload is invalid");
    }
    return value;
  }

  private recordRejection(
    payload: GrantPayload,
    reason: GrantValidationError["reason"],
    actualDigest: string | undefined,
    now: Date
  ): void {
    if (this.store.getRun(payload.runId) === undefined) return;
    this.store.appendEvents(payload.runId, [{
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId: payload.runId,
      occurredAt: now.toISOString(),
      actor: { type: "system", id: "afr-gateway" },
      eventType: "security.grant_rejected",
      status: "error",
      payload: {
        grantId: payload.grantId,
        reason,
        approvedActionDigest: payload.actionDigest,
        ...(actualDigest === undefined ? {} : { actualActionDigest: actualDigest })
      }
    }]);
  }

  private policyConfig(projectRoot: string): PolicyConfig {
    return {
      projectRoot,
      afrDataDir: resolve(this.options.dataDir),
      homeDir: resolve(this.options.homeDir ?? homedir()),
      protectedPaths: this.options.protectedPaths ?? ["protected"],
      networkReadAllowlist: this.options.networkReadAllowlist ?? [],
      networkReadAllowedPorts: this.options.networkReadAllowedPorts ?? [80, 443]
    };
  }
}

export function canonicalizeActionContext(
  context: ActionContext,
  canonicalTargets: PolicyDecision["canonicalTargets"],
  projectRoot: string
): ActionContext {
  return {
    runId: context.runId,
    actor: { id: context.actor.id.trim(), type: context.actor.type.trim().toLowerCase() },
    tool: context.tool.trim().toLowerCase(),
    action: context.action.trim().toLowerCase(),
    ...(context.argv === undefined ? {} : { argv: [...context.argv] }),
    cwd: resolve(context.cwd ?? projectRoot),
    targets: [...canonicalTargets].sort((left, right) =>
      `${left.type}\u0000${left.canonicalId}`.localeCompare(`${right.type}\u0000${right.canonicalId}`)
    ),
    environment: context.environment,
    sideEffect: context.sideEffect,
    recoverability: context.recoverability,
    ...(context.contentHash === undefined ? {} : { contentHash: context.contentHash.toLowerCase() }),
    ...(context.estimatedImpact === undefined ? {} : { estimatedImpact: context.estimatedImpact })
  };
}

export function createActionDigest(context: ActionContext): string {
  return sha256(canonicalJson({
    canonicalTool: context.tool,
    canonicalAction: context.action,
    canonicalArguments: context.argv ?? [],
    canonicalTargets: context.targets,
    cwd: context.cwd ?? "",
    selectedEnvironment: context.environment,
    sideEffect: context.sideEffect,
    recoverability: context.recoverability,
    contentHash: context.contentHash ?? null,
    estimatedImpact: context.estimatedImpact ?? {}
  }));
}

function grantConsumedEvent(grant: ExecutionGrantRecord, at: Date): IncomingEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: uuidv7(),
    runId: grant.runId,
    idempotencyKey: `approval-consumed:${grant.id}`,
    occurredAt: at.toISOString(),
    actor: { type: "system", id: "afr-gateway" },
    eventType: "approval.consumed",
    status: "success",
    payload: {
      grantId: grant.id,
      ...(grant.approvalId === undefined ? {} : { approvalId: grant.approvalId }),
      actionDigest: grant.actionDigest
    }
  };
}

function grantRejectedEvent(
  grant: ExecutionGrantRecord,
  reason: GrantValidationError["reason"],
  actualDigest: string | undefined,
  at: Date
): IncomingEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: uuidv7(),
    runId: grant.runId,
    occurredAt: at.toISOString(),
    actor: { type: "system", id: "afr-gateway" },
    eventType: "security.grant_rejected",
    status: "error",
    payload: {
      grantId: grant.id,
      reason,
      approvedActionDigest: grant.actionDigest,
      ...(actualDigest === undefined ? {} : { actualActionDigest: actualDigest })
    }
  };
}

function policyEvent(
  context: ActionContext,
  decision: PolicyDecision,
  actionDigest: string,
  at: Date
): IncomingEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: uuidv7(),
    runId: context.runId,
    occurredAt: at.toISOString(),
    actor: { type: "system", id: "afr-policy" },
    eventType: "policy.evaluated",
    status: decision.effect === "deny" ? "error" : "success",
    risk: riskFrom(decision),
    payload: { actionDigest, actionContext: context }
  };
}

function riskFrom(decision: PolicyDecision) {
  return {
    level: decision.riskLevel,
    decision: decision.effect,
    policyId: decision.policyId,
    ruleId: decision.ruleId,
    reasonCodes: decision.reasonCodes
  } as const;
}

function assertActionContext(context: ActionContext): void {
  const validation = validateActionContext(context);
  if (!validation.ok) {
    throw new Error(
      `Invalid ActionContext: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join(", ")}`
    );
  }
}

function readOrCreateSigningKey(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString("base64url"), { mode: 0o600 });
  }
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
  if (key.length < 32) throw new Error("Grant signing key is invalid");
  return key;
}

function isGrantPayload(value: unknown): value is GrantPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<GrantPayload>;
  return payload.version === 1 &&
    typeof payload.grantId === "string" &&
    (payload.approvalId === undefined || typeof payload.approvalId === "string") &&
    typeof payload.runId === "string" &&
    typeof payload.actionDigest === "string" && /^[0-9a-f]{64}$/.test(payload.actionDigest) &&
    typeof payload.nonce === "string" && payload.nonce.length >= 16 &&
    typeof payload.issuedAt === "string" &&
    typeof payload.expiresAt === "string";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
