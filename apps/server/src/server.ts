import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApprovalNotFoundError,
  ApprovalService,
  ApprovalStateError,
  CheckpointError,
  CheckpointManager,
  EventValidationError,
  FileGateway,
  GatewayDeniedError,
  GatewayValidationError,
  GrantValidationError,
  HostedWorkspaceManager,
  IdempotencyConflictError,
  LocalStore,
  MissingBlobError,
  NetworkGatewayError,
  PatchPromotionError,
  PatchPromotionGateway,
  ProviderSessionStateError,
  ReplayError,
  ReplayManager,
  RunArtifactError,
  RunTransitionError,
  ReadOnlyNetworkGateway,
  compareRuns,
  createRunCreatedEvent,
  createRunJsonExport,
  deriveRunInsights,
  deriveSteps,
  type ReadOnlyNetworkGatewayOptions,
  type ReplayExecutor,
  workspaceChangedPathsFromManifest,
  workspaceFingerprint
} from "@afr/core";
import type {
  MigrationReport,
  ProviderActionRequestRecord,
  ProviderCapabilitySnapshot,
  ProviderSessionMode,
  ProviderSessionStatus,
  RecoveryReport
} from "@afr/core";
import {
  ERROR_CODES,
  APPROVAL_STATUSES,
  RUN_STATUSES,
  apiError,
  validateActionContext,
  type ActionContext,
  type ApprovalStatus,
  type IncomingEvent,
  type RunStatus
} from "@afr/protocol";
import type { HostedSandboxMode } from "@afr/adapter-codex";
import fastify, { LogController, type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

import { EventStreamBroker, serializeSseEvent } from "./event-stream.js";
import {
  HostedRunError,
  HostedRunManager,
  type HostedRunManagerOptions
} from "./hosted-runs.js";

export const AFR_VERSION = "0.1.0-demo.0";

export type BuildServerOptions = {
  dataDir: string;
  webRoot?: string | false;
  logger?: boolean;
  protectedPaths?: string[];
  approvalTtlMs?: number;
  grantTtlMs?: number;
  now?: () => Date;
  replayExecutor?: ReplayExecutor;
  networkRead?: Omit<ReadOnlyNetworkGatewayOptions, "now">;
  hosted?: Omit<
    HostedRunManagerOptions,
    "store" | "approvals" | "networkGateway" | "publish" | "networkReadEnabled"
  >;
};

export type AfrServer = {
  app: FastifyInstance;
  store: LocalStore;
  token: string;
  tokenPath: string;
  approvalTokenPath: string;
  eventStream: EventStreamBroker;
  approvals: ApprovalService;
  gateway: FileGateway;
  networkGateway: ReadOnlyNetworkGateway;
  promotions: PatchPromotionGateway;
  checkpoints: CheckpointManager;
  replays: ReplayManager;
  hostedRuns: HostedRunManager;
  startupReport: StartupReport;
};

export type StartupReport = RecoveryReport & MigrationReport & {
  checkedAt: string;
  incompleteHostedWorkspaces: number;
  cleanedHostedWorkspaces: number;
  hostedWorkspaceCleanupFailures: number;
};

export async function buildServer(options: BuildServerOptions): Promise<AfrServer> {
  const dataDir = resolve(options.dataDir);
  const store = new LocalStore(dataDir, options.now);
  const storeRecovery = store.recover();
  const workspaceRecovery = new HostedWorkspaceManager(
    store,
    options.now ?? (() => new Date())
  ).recoverIncomplete();
  const startupReport: StartupReport = {
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
    ...store.migrationReport,
    ...storeRecovery,
    incompleteHostedWorkspaces: workspaceRecovery.incompleteWorkspaces,
    cleanedHostedWorkspaces: workspaceRecovery.cleanedWorkspaces,
    hostedWorkspaceCleanupFailures: workspaceRecovery.cleanupFailures
  };
  const eventStream = new EventStreamBroker();
  const { token, tokenPath } = readOrCreateToken(dataDir, "session-token");
  const { token: approvalToken, tokenPath: approvalTokenPath } = readOrCreateToken(
    dataDir,
    "human-approval-token"
  );
  const networkRead = options.networkRead ?? { allowlist: [] };
  const approvals = new ApprovalService(store, {
    dataDir,
    ...(options.protectedPaths === undefined ? {} : { protectedPaths: options.protectedPaths }),
    ...(options.approvalTtlMs === undefined ? {} : { approvalTtlMs: options.approvalTtlMs }),
    ...(options.grantTtlMs === undefined ? {} : { grantTtlMs: options.grantTtlMs }),
    networkReadAllowlist: networkRead.allowlist,
    networkReadAllowedPorts: networkRead.allowedPorts ?? [80, 443],
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const gateway = new FileGateway(store, approvals, options.now);
  const networkGateway = new ReadOnlyNetworkGateway(store, approvals, {
    ...networkRead,
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const promotions = new PatchPromotionGateway(store, approvals, options.now);
  const checkpoints = options.now === undefined
    ? new CheckpointManager(store)
    : new CheckpointManager(store, options.now);
  const replays = options.replayExecutor === undefined
    ? options.now === undefined
      ? new ReplayManager(store)
      : new ReplayManager(store, undefined, options.now)
    : options.now === undefined
      ? new ReplayManager(store, options.replayExecutor)
      : new ReplayManager(store, options.replayExecutor, options.now);
  const app = fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024 * 1024
  });
  const hostedRuns = new HostedRunManager({
    store,
    approvals,
    networkGateway,
    ...(options.hosted ?? {}),
    networkReadEnabled: networkRead.allowlist.length > 0,
    publish: (runId, afterSequenceNo) => {
      eventStream.publish(store.listEvents(runId, afterSequenceNo));
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      request.method === "GET" &&
      !request.url.startsWith("/api/") &&
      request.headers["sec-fetch-mode"] === "navigate" &&
      request.headers["sec-fetch-user"] === "?1" &&
      request.headers["sec-fetch-dest"] === "document"
    ) {
      reply.header(
        "set-cookie",
        `afr_human=${approvalToken}; Path=/api/v1/approvals; HttpOnly; SameSite=Strict`
      );
    }
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const expected = `http://${request.headers.host}`;
      if (origin !== expected) {
        return reply
          .code(403)
          .send(apiError(ERROR_CODES.FORBIDDEN, "Origin is not allowed", request.id));
      }
    }
    const humanDecision = /^\/api\/v1\/approvals\/[^/]+\/decision(?:\?|$)/.test(request.url);
    const providerScopedOperation = request.url.match(
      /^\/api\/v1\/provider-sessions\/([^/?]+)\/(?:status|network-read)(?:\?|$)/
    );
    const localSessionAuthorized = request.headers.authorization === `Bearer ${token}` ||
      readCookie(request.headers.cookie, "afr_session") === token;
    const authorized = humanDecision
      ? readCookie(request.headers.cookie, "afr_human") === approvalToken
      : providerScopedOperation === null
        ? localSessionAuthorized
        : localSessionAuthorized || store.verifyProviderSessionControlToken(
            providerScopedOperation[1] ?? "",
            readBearerToken(request.headers.authorization) ?? ""
          );
    if (!authorized) {
      return reply
        .code(401)
        .send(
          apiError(
            ERROR_CODES.UNAUTHORIZED,
            humanDecision
              ? "A human approval session is required"
              : "A valid local session token is required",
            request.id
          )
        );
    }
  });

  app.get("/api/v1/meta", async (_request, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("set-cookie", `afr_session=${token}; Path=/api/v1; HttpOnly; SameSite=Strict`);
    return {
      version: AFR_VERSION,
      dataDir,
      support: {
        operatingSystem: "macOS",
        agent: "Codex / fixture agent",
        coverage: "L2 when all commands use afr-cli; direct activity may be missing",
        networkReadGateway: networkRead.allowlist.length === 0
          ? "deny-all"
          : `configured:${networkRead.allowlist.length}`
      },
      startup: startupReport
    };
  });

  app.get("/api/v1/runs", async (request) => {
    const query = request.query as { limit?: string };
    const limit = query.limit === undefined ? 200 : Number.parseInt(query.limit, 10);
    return { runs: store.listRunSummaries(Number.isFinite(limit) ? limit : 200) };
  });

  app.get("/api/v1/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = store.getRun(runId);
    if (run === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    const events = store.listEvents(runId);
    return { run, insights: deriveRunInsights(events) };
  });

  app.get("/api/v1/runs/:runId/steps", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    return { steps: deriveSteps(store.listEvents(runId)) };
  });

  app.get("/api/v1/runs/:runId/session", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    const session = store.getLatestProviderSession(runId);
    if (session === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Provider session does not exist", request.id, { runId }));
    }
    return { session };
  });

  app.get("/api/v1/runs/:runId/hosted-workspace", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    const workspace = store.getHostedWorkspaceByRun(runId);
    if (workspace === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Hosted workspace does not exist", request.id, { runId }));
    }
    return { workspace };
  });

  app.get("/api/v1/runs/:runId/hosted-summary", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    const session = store.getLatestProviderSession(runId);
    const workspace = store.getHostedWorkspaceByRun(runId);
    const coverage = store.getRunCoverage(runId) ?? emptyRunCoverage(runId);
    const actionRequests = session === undefined
      ? []
      : store.listProviderActionRequests(session.id);
    const providerEvents = session === undefined
      ? []
      : store.listProviderEvents(session.id);
    const networkMediation = session === undefined
      ? []
      : store.listNetworkMediationRecords(session.id);
    return {
      hosted: session !== undefined || workspace !== undefined,
      session: session ?? null,
      workspace: workspace ?? null,
      coverage,
      promotions: promotions.list(runId),
      actionRequests,
      providerEvents: providerEvents.slice(-200),
      networkEvidenceCount: networkMediation.length,
      networkMediation: networkMediation.slice(-50),
      lifecycle: hostedRuns.snapshot(runId),
      eventChainValid: store.verifyRunChain(runId)
    };
  });

  app.get("/api/v1/runs/:runId/hosted-diff", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const workspace = store.getHostedWorkspaceByRun(runId);
    if (workspace === undefined) {
      return reply.code(404).send(
        apiError(ERROR_CODES.NOT_FOUND, "Hosted workspace does not exist", request.id, { runId })
      );
    }
    if (workspace.status !== "finalized") {
      return reply.code(409).send(
        apiError(ERROR_CODES.CONFLICT, "Hosted workspace diff is not finalized", request.id, {
          workspaceStatus: workspace.status
        })
      );
    }
    const diff = workspace.diffBlobHash === undefined
      ? undefined
      : store.getBlob(workspace.diffBlobHash);
    if (workspace.diffBlobHash !== undefined && diff === undefined) {
      return reply.code(409).send(
        apiError(ERROR_CODES.CONFLICT, "Hosted workspace diff evidence is missing", request.id)
      );
    }
    return reply.header("cache-control", "no-store").send({
      workspaceId: workspace.id,
      changedPaths: workspace.changedPaths,
      diff: diff?.content.toString("utf8") ?? "",
      diffBlobHash: workspace.diffBlobHash ?? null,
      redactionState: diff?.record.redactionState ?? "scanned"
    });
  });

  app.get("/api/v1/runs/:runId/promotion-review", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const workspace = store.getHostedWorkspaceByRun(runId);
    if (workspace === undefined) {
      return reply.code(404).send(
        apiError(ERROR_CODES.NOT_FOUND, "Hosted workspace does not exist", request.id, { runId })
      );
    }
    if (workspace.status !== "finalized") {
      return reply.code(409).send(
        apiError(ERROR_CODES.CONFLICT, "Hosted workspace is not finalized", request.id, {
          workspaceStatus: workspace.status
        })
      );
    }
    const manifest = checkpoints.readManifest(workspace.checkpointId);
    const sourceFingerprint = workspaceFingerprint(workspace.sourceWorkspaceRoot, manifest);
    const worktreeFingerprint = workspaceFingerprint(workspace.worktreePath, manifest);
    const changedPaths = workspaceChangedPathsFromManifest(workspace.worktreePath, manifest);
    const promotion = promotions.list(runId)[0];
    const plan = promotion === undefined ? undefined : promotions.readPlan(promotion.id);
    const sourceDrifted = sourceFingerprint !== (plan?.sourceFingerprintBefore ?? workspace.sourceFingerprintBefore);
    const worktreeDrifted = plan === undefined
      ? JSON.stringify(changedPaths) !== JSON.stringify([...workspace.changedPaths].sort())
      : worktreeFingerprint !== plan.worktreeFingerprintBefore;
    return {
      review: {
        ready: !sourceDrifted && !worktreeDrifted,
        baseline: plan === undefined ? "finalized-change-set" : "immutable-plan",
        sourceDrifted,
        worktreeDrifted,
        changedPaths,
        sourceFingerprint,
        worktreeFingerprint,
        planHash: promotion?.planHash ?? null
      }
    };
  });

  app.get("/api/v1/hosted/preflight", async (request) => {
    const query = request.query as { projectPath?: string };
    return { preflight: await hostedRuns.preflight(query.projectPath) };
  });

  app.post("/api/v1/hosted-runs", async (request, reply) => {
    const body = request.body as Partial<{
      projectPath: string;
      task: string;
      sandbox: HostedSandboxMode;
      timeoutMs: number;
      model: string;
      storeModelContent: boolean;
    }>;
    if (
      !isNonEmpty(body.projectPath) ||
      !isNonEmpty(body.task) ||
      (body.sandbox !== "read-only" && body.sandbox !== "workspace-write") ||
      (body.timeoutMs !== undefined && typeof body.timeoutMs !== "number") ||
      (body.model !== undefined && !isNonEmpty(body.model)) ||
      (body.storeModelContent !== undefined && typeof body.storeModelContent !== "boolean")
    ) {
      return reply.code(400).send(apiError(
        ERROR_CODES.VALIDATION_FAILED,
        "projectPath, task, and read-only/workspace-write sandbox are required",
        request.id
      ));
    }
    const result = await hostedRuns.start({
      projectPath: body.projectPath,
      task: body.task,
      sandbox: body.sandbox,
      ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.storeModelContent === undefined ? {} : { storeModelContent: body.storeModelContent })
    });
    return reply.code(202).send(result);
  });

  app.post("/api/v1/hosted-runs/:runId/turns", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as Partial<{
      text: string;
      sandbox: HostedSandboxMode;
      timeoutMs: number;
      model: string;
      storeModelContent: boolean;
    }>;
    if (
      !isNonEmpty(body.text) ||
      (body.sandbox !== undefined && body.sandbox !== "read-only" && body.sandbox !== "workspace-write") ||
      (body.timeoutMs !== undefined && typeof body.timeoutMs !== "number") ||
      (body.model !== undefined && !isNonEmpty(body.model)) ||
      (body.storeModelContent !== undefined && typeof body.storeModelContent !== "boolean")
    ) {
      return reply.code(400).send(apiError(
        ERROR_CODES.VALIDATION_FAILED,
        "text and optional Hosted resume settings are invalid",
        request.id
      ));
    }
    const lifecycle = await hostedRuns.continue(runId, {
      text: body.text,
      ...(body.sandbox === undefined ? {} : { sandbox: body.sandbox }),
      ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.storeModelContent === undefined ? {} : { storeModelContent: body.storeModelContent })
    });
    return reply.code(202).send({ lifecycle });
  });

  app.post("/api/v1/hosted-runs/:runId/cancel", async (request) => {
    const { runId } = request.params as { runId: string };
    return { lifecycle: await hostedRuns.cancel(runId) };
  });

  app.post("/api/v1/hosted-runs/:runId/finish", async (request) => {
    const { runId } = request.params as { runId: string };
    return { lifecycle: await hostedRuns.finish(runId) };
  });

  app.post("/api/v1/runs/:runId/promotions", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as Partial<{ selectedPaths: unknown; reason: string }>;
    if (
      body.selectedPaths !== undefined &&
      (!Array.isArray(body.selectedPaths) ||
        !body.selectedPaths.every((path) => typeof path === "string" && path.length > 0))
    ) {
      return reply.code(400).send(
        apiError(
          ERROR_CODES.VALIDATION_FAILED,
          "selectedPaths must be a non-empty string array when provided",
          request.id
        )
      );
    }
    const before = store.getRun(runId)?.lastSequenceNo ?? 0;
    const result = promotions.request({
      runId,
      ...(body.selectedPaths === undefined ? {} : { selectedPaths: body.selectedPaths as string[] }),
      ...(isNonEmpty(body.reason) ? { reason: body.reason } : {})
    });
    eventStream.publish(store.listEvents(runId, before));
    return reply.code(202).send({ result });
  });

  app.get("/api/v1/runs/:runId/promotions", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    return { promotions: promotions.list(runId) };
  });

  app.get("/api/v1/promotions/:promotionId", async (request, reply) => {
    const { promotionId } = request.params as { promotionId: string };
    const promotion = promotions.get(promotionId);
    if (promotion === undefined) {
      return reply.code(404).send(
        apiError(ERROR_CODES.NOT_FOUND, "Patch Promotion does not exist", request.id, { promotionId })
      );
    }
    return { promotion, plan: promotions.readPlan(promotion.id) };
  });

  app.get("/api/v1/provider-sessions/:sessionId/events", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const query = request.query as { afterArrivalSequence?: string; limit?: string };
    if (store.getProviderSession(sessionId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Provider session does not exist", request.id, { sessionId }));
    }
    const afterArrivalSequence = Number.parseInt(query.afterArrivalSequence ?? "0", 10);
    const limit = Number.parseInt(query.limit ?? "50000", 10);
    return {
      providerEvents: store.listProviderEvents(
        sessionId,
        Number.isFinite(afterArrivalSequence) ? afterArrivalSequence : 0,
        Number.isFinite(limit) ? limit : 50_000
      )
    };
  });

  app.get("/api/v1/provider-sessions/:sessionId/action-requests", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    if (store.getProviderSession(sessionId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Provider session does not exist", request.id, { sessionId }));
    }
    return { actionRequests: store.listProviderActionRequests(sessionId) };
  });

  app.get("/api/v1/provider-sessions/:sessionId/network-mediation", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const query = request.query as { afterSequenceNo?: string; limit?: string };
    if (store.getProviderSession(sessionId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Provider session does not exist", request.id, { sessionId }));
    }
    const afterSequenceNo = parseNonNegativeInteger(query.afterSequenceNo, 0);
    const limit = parseNonNegativeInteger(query.limit, 10_000);
    return {
      networkMediation: store.listNetworkMediationRecords(sessionId, afterSequenceNo, limit)
    };
  });

  app.post("/api/v1/provider-sessions/:sessionId/network-read", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as Partial<{
      url: string;
      method: "GET" | "HEAD";
      headers: unknown;
    }>;
    if (
      !isNonEmpty(body.url) ||
      (body.method !== undefined && body.method !== "GET" && body.method !== "HEAD") ||
      (body.headers !== undefined && !isStringRecord(body.headers))
    ) {
      return reply.code(400).send(
        apiError(
          ERROR_CODES.VALIDATION_FAILED,
          "url, optional GET/HEAD method, and optional string headers are required",
          request.id
        )
      );
    }
    const session = store.getProviderSession(sessionId);
    const before = session === undefined ? 0 : store.getRun(session.runId)?.lastSequenceNo ?? 0;
    try {
      const result = await networkGateway.request({
        sessionId,
        url: body.url,
        ...(body.method === undefined ? {} : { method: body.method }),
        ...(body.headers === undefined ? {} : { headers: body.headers as Record<string, string> })
      });
      const { body: responseBody, ...metadata } = result;
      return reply
        .header("cache-control", "no-store")
        .send({ result: metadata, bodyBase64: responseBody.toString("base64") });
    } finally {
      if (session !== undefined) eventStream.publish(store.listEvents(session.runId, before));
    }
  });

  app.get("/api/v1/provider-action-requests/:requestId", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const query = request.query as { waitMs?: string };
    const waitMs = Math.min(parseNonNegativeInteger(query.waitMs, 0), 30_000);
    const actionRequest = waitMs === 0
      ? store.getProviderActionRequest(requestId)
      : await waitForProviderActionRequest(store, requestId, waitMs);
    if (actionRequest === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Provider action request does not exist", request.id, { requestId }));
    }
    return { actionRequest };
  });

  app.get("/api/v1/runs/:runId/coverage", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    return { coverage: store.getRunCoverage(runId) ?? emptyRunCoverage(runId) };
  });

  app.get("/api/v1/runs/:runId/events", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { afterSequenceNo?: string; limit?: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    const afterSequenceNo = parseNonNegativeInteger(query.afterSequenceNo, 0);
    const limit = parseNonNegativeInteger(query.limit, 10_000);
    return { events: store.listEvents(runId, afterSequenceNo, limit) };
  });

  app.get("/api/v1/runs/:runId/stream", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { afterSequenceNo?: string; snapshot?: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    const headerSequence = Array.isArray(request.headers["last-event-id"])
      ? request.headers["last-event-id"][0]
      : request.headers["last-event-id"];
    const afterSequenceNo = parseNonNegativeInteger(query.afterSequenceNo ?? headerSequence, 0);
    const replay = store.listEvents(runId, afterSequenceNo);
    const replayText = replay.map(serializeSseEvent).join("");

    if (query.snapshot === "true") {
      return reply
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache")
        .send(replayText);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    reply.raw.write(replayText);
    const unsubscribe = eventStream.subscribe(runId, (event) => {
      reply.raw.write(serializeSseEvent(event));
    });
    const keepAlive = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return reply;
  });

  app.post("/api/v1/blobs", async (request, reply) => {
    const body = request.body as { contentBase64?: string; mediaType?: string };
    if (!isNonEmpty(body.contentBase64) || !isNonEmpty(body.mediaType)) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "contentBase64 and mediaType are required", request.id));
    }
    const content = decodeBase64(body.contentBase64);
    if (content === undefined) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "contentBase64 is invalid", request.id));
    }
    const blob = store.putBlob(content, body.mediaType);
    return reply.code(201).send({
      blobRef: `sha256:${blob.hash}`,
      byteSize: blob.byteSize,
      redactionState: blob.redactionState,
      ...(blob.redactionReport === undefined ? {} : { redactionReport: blob.redactionReport })
    });
  });

  app.get("/api/v1/blobs/:hash", async (request, reply) => {
    const { hash } = request.params as { hash: string };
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "Blob hash is invalid", request.id));
    }
    const blob = store.getBlob(hash);
    if (blob === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Blob does not exist", request.id));
    }
    return reply.type(blob.record.mediaType).send(blob.content);
  });

  app.get("/api/v1/snapshots/:snapshotId", async (request, reply) => {
    const { snapshotId } = request.params as { snapshotId: string };
    const snapshot = store.getSnapshot(snapshotId);
    if (snapshot === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Snapshot does not exist", request.id));
    }
    return { snapshot, blobRef: `sha256:${snapshot.contentBlobHash}` };
  });

  app.get("/api/v1/runs/:runId/checkpoints", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    return { checkpoints: store.listCheckpoints(runId) };
  });

  app.post("/api/v1/checkpoints", async (request, reply) => {
    const body = request.body as { runId?: string; sourceEventId?: string };
    if (!isNonEmpty(body.runId)) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "runId is required", request.id));
    }
    const before = store.getRun(body.runId)?.lastSequenceNo ?? 0;
    const result = checkpoints.create(
      body.runId,
      isNonEmpty(body.sourceEventId) ? body.sourceEventId : undefined
    );
    eventStream.publish(store.listEvents(body.runId, before));
    return reply.code(201).send(result);
  });

  app.post("/api/v1/replays", async (request, reply) => {
    const body = request.body as {
      checkpointId?: string;
      command?: unknown;
      task?: string;
      timeoutMs?: number;
      overrides?: unknown;
    };
    if (
      !isNonEmpty(body.checkpointId) ||
      !Array.isArray(body.command) ||
      !body.command.every((item) => typeof item === "string") ||
      (body.overrides !== undefined && !isStringRecord(body.overrides))
    ) {
      return reply.code(400).send(
        apiError(
          ERROR_CODES.VALIDATION_FAILED,
          "checkpointId, string command argv, and string overrides are required",
          request.id
        )
      );
    }
    const result = replays.run({
      checkpointId: body.checkpointId,
      command: body.command as string[],
      ...(isNonEmpty(body.task) ? { task: body.task } : {}),
      ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.overrides === undefined ? {} : { overrides: body.overrides })
    });
    eventStream.publish(store.listEvents(result.replay.targetRunId));
    return reply.code(201).send(result);
  });

  app.get("/api/v1/replays/:replayId", async (request, reply) => {
    const { replayId } = request.params as { replayId: string };
    const replay = store.getReplay(replayId);
    if (replay === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.REPLAY_NOT_FOUND, "Replay does not exist", request.id, { replayId }));
    }
    return { replay };
  });

  app.get("/api/v1/runs/:runId/replays", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (store.getRun(runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId }));
    }
    return { replays: store.listReplays(runId) };
  });

  app.get("/api/v1/runs/:runId/compare/:targetRunId", async (request, reply) => {
    const { runId, targetRunId } = request.params as { runId: string; targetRunId: string };
    return { comparison: compareRuns(store, runId, targetRunId) };
  });

  app.post("/api/v1/runs/:runId/export", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const exported = createRunJsonExport(store, runId);
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="afr-run-${runId}.json"`)
      .send(exported);
  });

  app.post("/api/v1/runs", async (request, reply) => {
    const body = request.body as Partial<{
      projectPath: string;
      task: string;
      agentId: string;
      parentRunId: string;
    }>;
    if (!isNonEmpty(body.projectPath) || !isNonEmpty(body.task) || !isNonEmpty(body.agentId)) {
      return reply.code(400).send(
        apiError(
          ERROR_CODES.VALIDATION_FAILED,
          "projectPath, task and agentId are required",
          request.id
        )
      );
    }
    const run = store.createRun({
      projectPath: resolve(body.projectPath),
      task: body.task,
      agentId: body.agentId,
      ...(isNonEmpty(body.parentRunId) ? { parentRunId: body.parentRunId } : {})
    });
    store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const running = store.transitionRun(run.id, "running");
    eventStream.publish(store.listEvents(run.id));
    return reply.code(201).send({ run: running });
  });

  app.post("/api/v1/provider-sessions", async (request, reply) => {
    const body = request.body as Partial<{
      runId: string;
      provider: string;
      adapterVersion: string;
      runtimeVersion: string;
      protocolVersion: string;
      mode: ProviderSessionMode;
      capabilities: unknown;
    }>;
    const capabilities = parseCapabilitySnapshot(body.capabilities);
    if (
      !isNonEmpty(body.runId) ||
      !isNonEmpty(body.provider) ||
      !isNonEmpty(body.adapterVersion) ||
      !isNonEmpty(body.runtimeVersion) ||
      !isNonEmpty(body.protocolVersion) ||
      (body.mode !== "hosted-observed" && body.mode !== "hosted-governed") ||
      capabilities === undefined
    ) {
      return reply.code(400).send(
        apiError(
          ERROR_CODES.VALIDATION_FAILED,
          "runId, Provider versions, mode, and a valid capability snapshot are required",
          request.id
        )
      );
    }
    if (store.getRun(body.runId) === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.RUN_NOT_FOUND, "Run does not exist", request.id, { runId: body.runId }));
    }
    const issued = store.createProviderSession({
      runId: body.runId,
      provider: body.provider,
      adapterVersion: body.adapterVersion,
      runtimeVersion: body.runtimeVersion,
      protocolVersion: body.protocolVersion,
      mode: body.mode,
      capabilities
    });
    return reply.code(201).send(issued);
  });

  app.post("/api/v1/provider-sessions/:sessionId/status", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as Partial<{
      status: ProviderSessionStatus;
      externalSessionId: string;
      processId: number;
      errorCode: string;
      errorMessage: string;
    }>;
    if (!isProviderSessionStatus(body.status)) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "A valid Provider session status is required", request.id));
    }
    const session = store.getProviderSession(sessionId);
    if (session === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Provider session does not exist", request.id, { sessionId }));
    }
    const updated = store.transitionProviderSession({
      sessionId,
      status: body.status,
      ...(isNonEmpty(body.externalSessionId) ? { externalSessionId: body.externalSessionId } : {}),
      ...(typeof body.processId === "number" ? { processId: body.processId } : {}),
      ...(isNonEmpty(body.errorCode) ? { errorCode: body.errorCode } : {}),
      ...(isNonEmpty(body.errorMessage) ? { errorMessage: body.errorMessage } : {})
    });
    return { session: updated };
  });

  app.post("/api/v1/runs/:runId/events:batch", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as { events?: IncomingEvent[] };
    if (!Array.isArray(body.events) || body.events.length === 0) {
      throw new EventValidationError([{ path: "/events", message: "At least one event is required" }]);
    }
    const protectedEvent = body.events.find((event) => isCoreAuthoredEvent(event.eventType));
    if (protectedEvent !== undefined) {
      return reply.code(403).send(
        apiError(
          ERROR_CODES.PROTECTED_EVENT_TYPE,
          `Only AFR core may append ${protectedEvent.eventType}`,
          request.id
        )
      );
    }
    const before = store.getRun(runId)?.lastSequenceNo ?? 0;
    const events = store.appendEvents(runId, body.events);
    eventStream.publish(events.filter((event) => event.sequenceNo > before));
    return { events };
  });

  app.post("/api/v1/actions:evaluate", async (request, reply) => {
    const body = request.body as { actionContext?: unknown; reason?: string };
    const context = parseActionContext(body.actionContext);
    if (context === undefined) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "A valid actionContext is required", request.id));
    }
    const before = store.getRun(context.runId)?.lastSequenceNo ?? 0;
    const result = approvals.evaluate(context, isNonEmpty(body.reason) ? body.reason : undefined);
    eventStream.publish(store.listEvents(context.runId, before));
    return { result };
  });

  app.post("/api/v1/gateway/files:delete", async (request, reply) => {
    const body = request.body as { runId?: string; path?: string; reason?: string };
    if (!isNonEmpty(body.runId) || !isNonEmpty(body.path)) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "runId and path are required", request.id));
    }
    const before = store.getRun(body.runId)?.lastSequenceNo ?? 0;
    const result = gateway.requestDelete(
      body.runId,
      body.path,
      isNonEmpty(body.reason) ? body.reason : undefined
    );
    eventStream.publish(store.listEvents(body.runId, before));
    return reply.code(result.action.status === "waiting_approval" ? 202 : 200).send({ result });
  });

  app.post("/api/v1/gateway/commands:execute", async (request, reply) => {
    const body = request.body as { runId?: string; argv?: unknown; reason?: string };
    if (
      !isNonEmpty(body.runId) ||
      !Array.isArray(body.argv) ||
      body.argv.length === 0 ||
      !body.argv.every((item) => typeof item === "string")
    ) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "runId and string argv are required", request.id));
    }
    const before = store.getRun(body.runId)?.lastSequenceNo ?? 0;
    const result = gateway.requestCommand(
      body.runId,
      body.argv as string[],
      isNonEmpty(body.reason) ? body.reason : undefined
    );
    eventStream.publish(store.listEvents(body.runId, before));
    return reply.code(result.action.status === "waiting_approval" ? 202 : 200).send({ result });
  });

  app.post("/api/v1/approvals", async (request, reply) => {
    const body = request.body as { actionContext?: unknown; reason?: string };
    const context = parseActionContext(body.actionContext);
    if (context === undefined) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "A valid actionContext is required", request.id));
    }
    const before = store.getRun(context.runId)?.lastSequenceNo ?? 0;
    const result = approvals.evaluate(context, isNonEmpty(body.reason) ? body.reason : undefined);
    eventStream.publish(store.listEvents(context.runId, before));
    return reply.code(result.approval === undefined ? 200 : 201).send({ result });
  });

  app.get("/api/v1/approvals", async (request, reply) => {
    const query = request.query as { runId?: string; status?: string };
    if (query.status !== undefined && !APPROVAL_STATUSES.includes(query.status as ApprovalStatus)) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "Approval status is invalid", request.id));
    }
    return {
      approvals: approvals.list({
        ...(isNonEmpty(query.runId) ? { runId: query.runId } : {}),
        ...(query.status === undefined ? {} : { status: query.status as ApprovalStatus })
      })
    };
  });

  app.get("/api/v1/approvals/:approvalId", async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const approval = approvals.get(approvalId);
    if (approval === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.APPROVAL_NOT_FOUND, "Approval does not exist", request.id));
    }
    return { approval };
  });

  app.get("/api/v1/gateway/actions", async (request, reply) => {
    const query = request.query as { approvalId?: string };
    if (!isNonEmpty(query.approvalId)) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "approvalId is required", request.id));
    }
    const action = store.getGatewayActionByApproval(query.approvalId);
    if (action === undefined) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Gateway action does not exist", request.id));
    }
    return { action };
  });

  app.post("/api/v1/approvals/:approvalId/decision", async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = request.body as { decision?: string; reason?: string };
    if (body.decision !== "approved" && body.decision !== "denied") {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "decision must be approved or denied", request.id));
    }
    const existing = approvals.get(approvalId);
    const before = existing === undefined ? 0 : store.getRun(existing.runId)?.lastSequenceNo ?? 0;
    const result = approvals.decide(
      approvalId,
      body.decision,
      "local-user",
      isNonEmpty(body.reason) ? body.reason : undefined
    );
    const gatewayAction = gateway.resolveApproval(
      approvalId,
      body.decision,
      result.grant?.token
    );
    const patchPromotion = promotions.resolveApproval(
      approvalId,
      body.decision,
      result.grant?.token
    );
    const currentApproval = approvals.get(approvalId) ?? result.approval;
    eventStream.publish(store.listEvents(result.approval.runId, before));
    return {
      result: {
        ...result,
        approval: currentApproval,
        ...(gatewayAction === undefined ? {} : { gatewayAction }),
        ...(patchPromotion === undefined ? {} : { patchPromotion })
      }
    };
  });

  app.post("/api/v1/execution-grants:consume", async (request, reply) => {
    const body = request.body as { token?: string; actionContext?: unknown };
    const context = parseActionContext(body.actionContext);
    if (!isNonEmpty(body.token) || context === undefined) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "token and actionContext are required", request.id));
    }
    const before = store.getRun(context.runId)?.lastSequenceNo ?? 0;
    const grant = approvals.consume(body.token, context);
    eventStream.publish(store.listEvents(context.runId, before));
    return { grant };
  });

  app.post("/api/v1/runs/:runId/status", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as { status?: RunStatus; reason?: string };
    if (!RUN_STATUSES.includes(body.status as RunStatus)) {
      return reply
        .code(400)
        .send(apiError(ERROR_CODES.VALIDATION_FAILED, "A valid status is required", request.id));
    }
    const before = store.getRun(runId)?.lastSequenceNo ?? 0;
    const run = store.transitionRun(runId, body.status as RunStatus, "afr-cli", body.reason);
    eventStream.publish(store.listEvents(runId, before));
    return { run };
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof EventValidationError) {
      return reply.code(400).send(
        apiError(ERROR_CODES.VALIDATION_FAILED, error.message, request.id, {
          issues: error.issues
        })
      );
    }
    if (error instanceof IdempotencyConflictError) {
      return reply
        .code(409)
        .send(apiError(ERROR_CODES.IDEMPOTENCY_CONFLICT, error.message, request.id));
    }
    if (error instanceof MissingBlobError) {
      return reply
        .code(409)
        .send(apiError(ERROR_CODES.CONFLICT, error.message, request.id));
    }
    if (error instanceof RunTransitionError) {
      return reply.code(409).send(
        apiError(ERROR_CODES.INVALID_RUN_TRANSITION, error.message, request.id, {
          from: error.from,
          to: error.to
        })
      );
    }
    if (error instanceof ProviderSessionStateError) {
      return reply.code(409).send(
        apiError(ERROR_CODES.CONFLICT, error.message, request.id, {
          from: error.from,
          to: error.to
        })
      );
    }
    if (error instanceof ApprovalNotFoundError) {
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.APPROVAL_NOT_FOUND, error.message, request.id));
    }
    if (error instanceof ApprovalStateError) {
      return reply.code(409).send(
        apiError(ERROR_CODES.APPROVAL_STATE_INVALID, error.message, request.id, {
          status: error.status
        })
      );
    }
    if (error instanceof GrantValidationError) {
      const code =
        error.reason === "expired"
          ? ERROR_CODES.GRANT_EXPIRED
          : error.reason === "consumed"
            ? ERROR_CODES.GRANT_CONSUMED
            : error.reason === "action_mismatch"
              ? ERROR_CODES.ACTION_DIGEST_MISMATCH
              : ERROR_CODES.GRANT_INVALID;
      return reply.code(403).send(apiError(code, error.message, request.id));
    }
    if (error instanceof GatewayDeniedError) {
      return reply.code(403).send(
        apiError(ERROR_CODES.FORBIDDEN, error.message, request.id, {
          ruleId: error.evaluation.decision.ruleId,
          reasonCodes: error.evaluation.decision.reasonCodes
        })
      );
    }
    if (error instanceof GatewayValidationError) {
      const forbidden = ["target_outside_project", "symlink_rejected"].includes(error.code);
      return reply.code(forbidden ? 403 : 400).send(
        apiError(
          forbidden ? ERROR_CODES.FORBIDDEN : ERROR_CODES.VALIDATION_FAILED,
          error.message,
          request.id,
          { gatewayCode: error.code }
        )
      );
    }
    if (error instanceof NetworkGatewayError) {
      const status = error.code === "session_not_found" || error.code === "run_not_found"
        ? 404
        : error.code === "timeout"
          ? 504
          : error.code === "transport_failed" || error.code === "dns_resolution_failed"
            ? 502
            : error.code === "response_too_large"
              ? 413
              : [
                  "host_not_allowlisted",
                  "port_not_allowed",
                  "credentials_forbidden",
                  "policy_denied",
                  "address_not_public",
                  "remote_address_mismatch"
                ].includes(error.code)
                ? 403
                : error.code === "run_not_running" || error.code === "session_not_running"
                  ? 409
                  : 400;
      const code = status === 404 ? ERROR_CODES.NOT_FOUND
        : status === 403 ? ERROR_CODES.FORBIDDEN
          : status === 409 ? ERROR_CODES.CONFLICT
            : ERROR_CODES.VALIDATION_FAILED;
      return reply.code(status).send(
        apiError(code, error.message, request.id, {
          networkGatewayCode: error.code,
          gatewayRequestId: error.gatewayRequestId
        })
      );
    }
    if (error instanceof CheckpointError) {
      const notFound = error.code === "run_not_found";
      return reply.code(notFound ? 404 : 422).send(
        apiError(
          notFound ? ERROR_CODES.RUN_NOT_FOUND : ERROR_CODES.CHECKPOINT_INVALID,
          error.message,
          request.id,
          { checkpointCode: error.code }
        )
      );
    }
    if (error instanceof ReplayError) {
      const status = error.code === "checkpoint_not_found" ? 404
        : error.code === "side_effect_blocked" ? 403 : 400;
      const code = error.code === "checkpoint_not_found" ? ERROR_CODES.CHECKPOINT_NOT_FOUND
        : error.code === "side_effect_blocked" ? ERROR_CODES.REPLAY_BLOCKED
          : ERROR_CODES.VALIDATION_FAILED;
      return reply.code(status).send(apiError(code, error.message, request.id, { replayCode: error.code }));
    }
    if (error instanceof PatchPromotionError) {
      const notFound = error.code === "run_not_found" || error.code === "workspace_not_found" ||
        error.code === "plan_missing";
      const forbidden = error.code === "symlink_parent";
      const validation = error.code === "paths_required" || error.code === "path_not_changed" ||
        error.code === "unsupported_entry";
      const status = notFound ? 404 : forbidden ? 403 : validation ? 400 : error.code === "sensitive_content" ? 422 : 409;
      const code = error.code === "run_not_found" ? ERROR_CODES.RUN_NOT_FOUND
        : notFound ? ERROR_CODES.NOT_FOUND
          : forbidden ? ERROR_CODES.FORBIDDEN
            : validation ? ERROR_CODES.VALIDATION_FAILED
              : ERROR_CODES.CONFLICT;
      return reply.code(status).send(
        apiError(code, error.message, request.id, { promotionCode: error.code })
      );
    }
    if (error instanceof HostedRunError) {
      const status = error.code === "run_not_found" ? 404
        : error.code === "project_not_allowed" ? 403
          : error.code === "not_ready" ? 503
            : 409;
      const code = status === 404 ? ERROR_CODES.RUN_NOT_FOUND
        : status === 403 ? ERROR_CODES.FORBIDDEN
          : status === 503 ? ERROR_CODES.CONFLICT
            : ERROR_CODES.CONFLICT;
      return reply.code(status).send(apiError(code, error.message, request.id, {
        hostedRunCode: error.code
      }));
    }
    if (error instanceof RunArtifactError) {
      return reply.code(404).send(apiError(ERROR_CODES.RUN_NOT_FOUND, error.message, request.id));
    }
    request.log.error(error);
    return reply
      .code(500)
      .send(apiError(ERROR_CODES.INTERNAL_ERROR, "Internal server error", request.id));
  });

  const webRoot =
    options.webRoot === undefined
      ? fileURLToPath(new URL("../../web/dist", import.meta.url))
      : options.webRoot;
  if (webRoot !== false && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply
        .code(404)
        .send(apiError(ERROR_CODES.NOT_FOUND, "Route does not exist", request.id));
    });
  }

  app.addHook("onClose", async () => {
    await hostedRuns.shutdown();
    store.close();
  });

  return {
    app,
    store,
    token,
    tokenPath,
    approvalTokenPath,
    eventStream,
    approvals,
    gateway,
    networkGateway,
    promotions,
    checkpoints,
    replays,
    hostedRuns,
    startupReport
  };
}

function readOrCreateToken(
  dataDir: string,
  filename: "session-token" | "human-approval-token"
): { token: string; tokenPath: string } {
  const runtimeDir = join(dataDir, "runtime");
  const tokenPath = join(runtimeDir, filename);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, randomBytes(32).toString("base64url"), { mode: 0o600 });
  }
  return { token: readFileSync(tokenPath, "utf8").trim(), tokenPath };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function emptyRunCoverage(runId: string) {
  return {
    runId,
    providerEventCount: 0,
    normalizedEventCount: 0,
    ignoredEventCount: 0,
    gapCount: 0,
    unknownEventCount: 0,
    invalidEventCount: 0,
    coveragePercent: 0,
    coverageLevel: "L0" as const,
    summary: {
      parseStatuses: {},
      providerMethods: {},
      gapReasons: {},
      workspaceEvidence: "missing" as const
    },
    calculatedAt: null
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

function parseCapabilitySnapshot(value: unknown): ProviderCapabilitySnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value).length === 0) return undefined;
  const snapshot: ProviderCapabilitySnapshot = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!isNonEmpty(name) || candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return undefined;
    }
    const capability = candidate as Record<string, unknown>;
    if (
      !["supported", "unsupported", "degraded"].includes(String(capability.state)) ||
      !isNonEmpty(capability.source) ||
      !isNonEmpty(capability.version) ||
      (capability.detail !== undefined && typeof capability.detail !== "string")
    ) {
      return undefined;
    }
    snapshot[name] = {
      state: capability.state as "supported" | "unsupported" | "degraded",
      source: capability.source,
      version: capability.version,
      ...(capability.detail === undefined ? {} : { detail: capability.detail })
    };
  }
  return snapshot;
}

function isProviderSessionStatus(value: unknown): value is ProviderSessionStatus {
  return typeof value === "string" && [
    "created",
    "starting",
    "running",
    "stopping",
    "completed",
    "failed",
    "cancelled",
    "interrupted"
  ].includes(value);
}

function readBearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  const value = header.slice("Bearer ".length);
  return value.length === 0 ? undefined : value;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function waitForProviderActionRequest(
  store: LocalStore,
  requestId: string,
  waitMs: number
): Promise<ProviderActionRequestRecord | undefined> {
  const deadline = Date.now() + waitMs;
  let current = store.getProviderActionRequest(requestId);
  while (
    current !== undefined &&
    (current.status === "evaluating" || current.status === "waiting_approval") &&
    Date.now() < deadline
  ) {
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(50, waitMs)));
    current = store.getProviderActionRequest(requestId);
  }
  return current;
}

function decodeBase64(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const content = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/, "");
  return content.toString("base64").replace(/=+$/, "") === normalizedInput ? content : undefined;
}

function parseActionContext(value: unknown): ActionContext | undefined {
  const validation = validateActionContext(value);
  return validation.ok ? validation.value : undefined;
}

function isCoreAuthoredEvent(eventType: unknown): boolean {
  return typeof eventType === "string" && (eventType === "policy.evaluated" ||
    eventType.startsWith("approval.") ||
    eventType === "security.grant_rejected" ||
    eventType === "snapshot.created" ||
    eventType === "checkpoint.created" ||
    eventType.startsWith("replay."));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}
