import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  ApprovalService,
  canonicalJson,
  type ActionEvaluation,
  type LocalStore,
  type ProviderActionRequestRecord
} from "@afr/core";
import type { ActionContext } from "@afr/protocol";

import {
  AppServerRequestRejectedError,
  type AppServerRequest
} from "./app-server-supervisor.js";

const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_APPROVAL = "item/fileChange/requestApproval";
const PERMISSION_APPROVAL = "item/permissions/requestApproval";
const MCP_ELICITATION = "mcpServer/elicitation/request";
const DYNAMIC_TOOL_CALL = "item/tool/call";
const LEGACY_COMMAND_APPROVAL = "execCommandApproval";
const LEGACY_PATCH_APPROVAL = "applyPatchApproval";

type ResponseDialect =
  | "command-v2"
  | "file-v2"
  | "permission-v2"
  | "mcp-elicitation"
  | "dynamic-tool"
  | "command-legacy"
  | "patch-legacy";

type ParsedProviderRequest = {
  context: ActionContext;
  dialect: ResponseDialect;
  reason?: string | undefined;
  threadId?: string | undefined;
  turnId?: string | undefined;
  itemId?: string | undefined;
  availableDecisions?: unknown[] | undefined;
};

export type AppServerApprovalBridgeOptions = {
  runId: string;
  providerSessionId: string;
  approvals: ApprovalService;
  store: LocalStore;
  projectPath?: string;
  approvalWaitTimeoutMs?: number;
  pollIntervalMs?: number;
  storeRaw?: boolean;
  now?: () => Date;
};

export class AppServerApprovalBridge {
  private readonly now: () => Date;
  private readonly projectPath: string;

  constructor(private readonly options: AppServerApprovalBridgeOptions) {
    const session = options.store.getProviderSession(options.providerSessionId);
    if (session === undefined || session.runId !== options.runId) {
      throw new Error("Provider session does not belong to the App Server Approval Bridge Run");
    }
    const run = options.store.getRun(options.runId);
    if (run === undefined) throw new Error(`Run not found: ${options.runId}`);
    this.projectPath = options.projectPath === undefined
      ? run.projectPath
      : resolve(options.projectPath);
    this.now = options.now ?? (() => new Date());
  }

  async handle(request: AppServerRequest, signal?: AbortSignal): Promise<unknown> {
    if (
      this.options.store.getProviderActionRequestByRpcId(
        this.options.providerSessionId,
        request.id
      ) !== undefined
    ) {
      throw new AppServerRequestRejectedError(
        -32600,
        `Duplicate Provider request id: ${String(request.id)}`
      );
    }

    let parsed: ParsedProviderRequest;
    try {
      parsed = parseProviderRequest(this.options.runId, this.projectPath, request);
    } catch (error) {
      const reason = messageOf(error);
      this.options.store.createProviderActionRequest({
        sessionId: this.options.providerSessionId,
        rpcId: request.id,
        method: request.method,
        request,
        status: "rejected",
        decisionReason: reason,
        storeRaw: this.options.storeRaw
      });
      throw new AppServerRequestRejectedError(
        isKnownMethod(request.method) ? -32602 : -32601,
        reason
      );
    }

    const evaluation = this.options.approvals.evaluate(parsed.context, parsed.reason);
    const persisted = this.options.store.createProviderActionRequest({
      sessionId: this.options.providerSessionId,
      rpcId: request.id,
      method: request.method,
      request,
      status: evaluation.decision.effect === "ask" ? "waiting_approval" : "evaluating",
      ...(parsed.threadId === undefined ? {} : { providerThreadId: parsed.threadId }),
      ...(parsed.turnId === undefined ? {} : { providerTurnId: parsed.turnId }),
      ...(parsed.itemId === undefined ? {} : { providerItemId: parsed.itemId }),
      actionDigest: evaluation.actionDigest,
      actionContext: evaluation.actionContext,
      ...(evaluation.approval === undefined ? {} : { approvalId: evaluation.approval.id }),
      storeRaw: this.options.storeRaw
    });

    if (evaluation.decision.effect === "deny") {
      return this.decline(persisted, parsed, evaluation.decision.reasonCodes.join(", "));
    }
    if (!providerOffersAccept(parsed)) {
      if (evaluation.approval !== undefined) {
        this.options.approvals.decide(
          evaluation.approval.id,
          "denied",
          "afr-host",
          "Provider did not offer a one-time accept decision",
          "system"
        );
      } else if (evaluation.grant !== undefined) {
        this.options.store.expireExecutionGrant(
          evaluation.grant.grantId,
          this.now().toISOString()
        );
      }
      return this.decline(persisted, parsed, "Provider did not offer a one-time accept decision");
    }
    if (evaluation.decision.effect === "allow") {
      if (evaluation.grant === undefined) {
        throw new Error("Allowed Provider action has no execution grant");
      }
      const consumed = this.options.approvals.consume(
        evaluation.grant.token,
        evaluation.actionContext
      );
      return this.accept(persisted, parsed, consumed.id);
    }
    return this.waitForHumanDecision(persisted, parsed, evaluation, signal);
  }

  private async waitForHumanDecision(
    request: ProviderActionRequestRecord,
    parsed: ParsedProviderRequest,
    evaluation: ActionEvaluation,
    signal?: AbortSignal
  ): Promise<unknown> {
    const approvalId = evaluation.approval?.id;
    if (approvalId === undefined) throw new Error("Policy ask result has no Approval record");
    const deadline = this.now().getTime() + (this.options.approvalWaitTimeoutMs ?? 31 * 60 * 1000);
    const pollIntervalMs = this.options.pollIntervalMs ?? 50;

    while (this.now().getTime() <= deadline) {
      if (signal?.aborted === true) {
        const reason = "App Server stopped while waiting for human approval";
        const current = this.options.approvals.get(approvalId);
        if (current?.status === "pending") {
          this.options.approvals.decide(approvalId, "denied", "afr-host", reason, "system");
        }
        return this.reject(request, reason);
      }
      const approval = this.options.approvals.get(approvalId);
      if (approval === undefined) {
        return this.reject(request, "Approval record disappeared before Provider response");
      }
      if (approval.status === "approved") {
        const consumed = this.options.approvals.consumeApproved(
          approvalId,
          evaluation.actionContext
        );
        return this.accept(request, parsed, consumed.id);
      }
      if (approval.status === "denied") {
        return this.decline(request, parsed, approval.decisionReason ?? "Human denied the action");
      }
      if (approval.status === "expired") {
        return this.expire(request, parsed, "Approval or execution grant expired");
      }
      if (approval.status === "consumed") {
        return this.reject(request, "Approval grant was consumed outside this Provider request");
      }
      await delay(pollIntervalMs);
    }
    const reason = "Timed out waiting for a human approval decision";
    const current = this.options.approvals.get(approvalId);
    if (current?.status === "pending") {
      this.options.approvals.decide(approvalId, "denied", "afr-host", reason, "system");
    }
    return this.expire(request, parsed, reason);
  }

  private accept(
    request: ProviderActionRequestRecord,
    parsed: ParsedProviderRequest,
    grantId: string
  ): unknown {
    const response = acceptedResponse(parsed.dialect);
    this.options.store.resolveProviderActionRequest({
      requestId: request.id,
      status: "accepted",
      response,
      grantId,
      reason: "Bound one-time execution grant consumed before Provider accept",
      storeRaw: this.options.storeRaw
    });
    return response;
  }

  private decline(
    request: ProviderActionRequestRecord,
    parsed: ParsedProviderRequest,
    reason: string
  ): unknown {
    if (parsed.dialect === "permission-v2" || parsed.dialect === "dynamic-tool") {
      return this.reject(request, reason, -32010);
    }
    const response = declinedResponse(parsed.dialect, reason, parsed.availableDecisions);
    this.options.store.resolveProviderActionRequest({
      requestId: request.id,
      status: "declined",
      response,
      reason,
      storeRaw: this.options.storeRaw
    });
    return response;
  }

  private expire(
    request: ProviderActionRequestRecord,
    parsed: ParsedProviderRequest,
    reason: string
  ): unknown {
    if (parsed.dialect === "permission-v2" || parsed.dialect === "dynamic-tool") {
      return this.reject(request, reason, -32011, "expired");
    }
    const response = declinedResponse(parsed.dialect, reason, parsed.availableDecisions);
    this.options.store.resolveProviderActionRequest({
      requestId: request.id,
      status: "expired",
      response,
      reason,
      storeRaw: this.options.storeRaw
    });
    return response;
  }

  private reject(
    request: ProviderActionRequestRecord,
    reason: string,
    code = -32000,
    status: "rejected" | "expired" = "rejected"
  ): never {
    this.options.store.resolveProviderActionRequest({
      requestId: request.id,
      status,
      reason,
      storeRaw: this.options.storeRaw
    });
    throw new AppServerRequestRejectedError(code, reason);
  }
}

function parseProviderRequest(
  runId: string,
  projectPath: string,
  request: AppServerRequest
): ParsedProviderRequest {
  const params = requiredRecord(request.params, `${request.method} params`);
  switch (request.method) {
    case COMMAND_APPROVAL:
      return parseCommandV2(runId, projectPath, params);
    case LEGACY_COMMAND_APPROVAL:
      return parseCommandLegacy(runId, params);
    case FILE_APPROVAL:
      return parseFileV2(runId, projectPath, params);
    case LEGACY_PATCH_APPROVAL:
      return parsePatchLegacy(runId, projectPath, params);
    case PERMISSION_APPROVAL:
      return parsePermission(runId, params);
    case MCP_ELICITATION:
      return parseMcpElicitation(runId, projectPath, params);
    case DYNAMIC_TOOL_CALL:
      return parseDynamicToolCall(runId, projectPath, params);
    default:
      throw new Error(`Unsupported App Server request: ${request.method}`);
  }
}

function parseCommandV2(
  runId: string,
  projectPath: string,
  params: Record<string, unknown>
): ParsedProviderRequest {
  const threadId = requiredString(params.threadId, "threadId");
  const turnId = requiredString(params.turnId, "turnId");
  const itemId = requiredString(params.itemId, "itemId");
  requiredNumber(params.startedAtMs, "startedAtMs");
  const command = requiredString(params.command, "command");
  const cwd = optionalString(params.cwd) ?? projectPath;
  const actions = optionalRecordArray(params.commandActions);
  const networkRequested = params.networkApprovalContext != null || hasNetworkPermission(params.additionalPermissions);
  const readOnly = !networkRequested && isReadOnlyCommand(command, actions);
  return {
    dialect: "command-v2",
    threadId,
    turnId,
    itemId,
    ...(optionalString(params.reason) === undefined ? {} : { reason: optionalString(params.reason) }),
    ...(Array.isArray(params.availableDecisions)
      ? { availableDecisions: [...params.availableDecisions] }
      : {}),
    context: {
      runId,
      actor: { id: "codex-app-server", type: "agent" },
      tool: "codex.command",
      action: optionalString(params.kind) === "writeStdin" ? "write-stdin" : "execute",
      argv: ["shell", "-lc", command],
      cwd,
      targets: networkRequested
        ? [{ type: "network", canonicalId: networkTarget(params) }]
        : commandTargets(actions, cwd, command),
      environment: "local",
      sideEffect: readOnly ? "none" : "irreversible",
      recoverability: readOnly ? "easy" : "partial"
    }
  };
}

function parseCommandLegacy(runId: string, params: Record<string, unknown>): ParsedProviderRequest {
  const threadId = requiredString(params.conversationId, "conversationId");
  const itemId = requiredString(params.callId, "callId");
  const cwd = requiredString(params.cwd, "cwd");
  const command = requiredStringArray(params.command, "command");
  const actions = optionalRecordArray(params.parsedCmd);
  const displayCommand = command.join(" ");
  const readOnly = isReadOnlyCommand(displayCommand, actions);
  return {
    dialect: "command-legacy",
    threadId,
    itemId,
    ...(optionalString(params.reason) === undefined ? {} : { reason: optionalString(params.reason) }),
    context: {
      runId,
      actor: { id: "codex-app-server", type: "agent" },
      tool: "codex.command",
      action: "execute",
      argv: [...command],
      cwd,
      targets: commandTargets(actions, cwd, displayCommand),
      environment: "local",
      sideEffect: readOnly ? "none" : "irreversible",
      recoverability: readOnly ? "easy" : "partial"
    }
  };
}

function parseFileV2(
  runId: string,
  projectPath: string,
  params: Record<string, unknown>
): ParsedProviderRequest {
  const threadId = requiredString(params.threadId, "threadId");
  const turnId = requiredString(params.turnId, "turnId");
  const itemId = requiredString(params.itemId, "itemId");
  requiredNumber(params.startedAtMs, "startedAtMs");
  return {
    dialect: "file-v2",
    threadId,
    turnId,
    itemId,
    ...(optionalString(params.reason) === undefined ? {} : { reason: optionalString(params.reason) }),
    context: {
      runId,
      actor: { id: "codex-app-server", type: "agent" },
      tool: "codex.file-change",
      action: "unresolved",
      argv: [itemId],
      cwd: projectPath,
      targets: [{ type: "provider-item", canonicalId: itemId }],
      environment: "local",
      sideEffect: "irreversible",
      recoverability: "partial"
    }
  };
}

function parsePatchLegacy(
  runId: string,
  projectPath: string,
  params: Record<string, unknown>
): ParsedProviderRequest {
  const threadId = requiredString(params.conversationId, "conversationId");
  const itemId = requiredString(params.callId, "callId");
  const fileChanges = requiredRecord(params.fileChanges, "fileChanges");
  const paths = Object.keys(fileChanges);
  if (paths.length === 0) throw new Error("fileChanges must not be empty");
  for (const [path, change] of Object.entries(fileChanges)) {
    if (path.length === 0 || !isRecord(change)) throw new Error("fileChanges contains an invalid entry");
    if (
      (change.type === "add" || change.type === "delete") && typeof change.content === "string"
    ) {
      continue;
    }
    if (
      change.type === "update" &&
      typeof change.unified_diff === "string" &&
      (change.move_path === undefined || change.move_path === null || typeof change.move_path === "string")
    ) {
      continue;
    }
    throw new Error(`fileChanges contains an invalid change for ${path}`);
  }
  const hasDelete = Object.values(fileChanges).some(
    (change) => isRecord(change) && change.type === "delete"
  );
  const movedPaths = Object.values(fileChanges).flatMap((change) => {
    if (!isRecord(change) || typeof change.move_path !== "string") return [];
    return [change.move_path];
  });
  const cwd = projectPath;
  return {
    dialect: "patch-legacy",
    threadId,
    itemId,
    ...(optionalString(params.reason) === undefined ? {} : { reason: optionalString(params.reason) }),
    context: {
      runId,
      actor: { id: "codex-app-server", type: "agent" },
      tool: "codex.patch",
      action: hasDelete ? "delete" : "apply",
      argv: [itemId],
      cwd,
      targets: [...new Set([...paths, ...movedPaths])].map((path) => ({
        type: "file",
        canonicalId: resolve(cwd, path)
      })),
      environment: "local",
      sideEffect: hasDelete ? "irreversible" : "local-write",
      recoverability: hasDelete ? "partial" : "easy",
      contentHash: sha256(canonicalJson(fileChanges)),
      estimatedImpact: { files: paths.length }
    }
  };
}

function parsePermission(runId: string, params: Record<string, unknown>): ParsedProviderRequest {
  const threadId = requiredString(params.threadId, "threadId");
  const turnId = requiredString(params.turnId, "turnId");
  const itemId = requiredString(params.itemId, "itemId");
  requiredNumber(params.startedAtMs, "startedAtMs");
  const cwd = requiredString(params.cwd, "cwd");
  const permissions = requiredRecord(params.permissions, "permissions");
  return {
    dialect: "permission-v2",
    threadId,
    turnId,
    itemId,
    ...(optionalString(params.reason) === undefined ? {} : { reason: optionalString(params.reason) }),
    context: {
      runId,
      actor: { id: "codex-app-server", type: "agent" },
      tool: "codex.permissions",
      action: "escalate",
      argv: [canonicalJson(permissions)],
      cwd,
      targets: permissionTargets(permissions),
      environment: "local",
      sideEffect: "irreversible",
      recoverability: "none",
      contentHash: sha256(canonicalJson(permissions))
    }
  };
}

function parseMcpElicitation(
  runId: string,
  projectPath: string,
  params: Record<string, unknown>
): ParsedProviderRequest {
  const threadId = requiredString(params.threadId, "threadId");
  const serverName = requiredString(params.serverName, "serverName");
  const mode = requiredString(params.mode, "mode");
  const message = requiredString(params.message, "message");
  return {
    dialect: "mcp-elicitation",
    threadId,
    ...(optionalString(params.turnId) === undefined ? {} : { turnId: optionalString(params.turnId) }),
    reason: message,
    context: {
      runId,
      actor: { id: "codex-app-server", type: "agent" },
      tool: "codex.mcp",
      action: "elicitation",
      argv: [mode, serverName],
      cwd: projectPath,
      targets: [{ type: "mcp-server", canonicalId: serverName }],
      environment: "local",
      sideEffect: "external-write",
      recoverability: "none",
      contentHash: sha256(canonicalJson(params))
    }
  };
}

function parseDynamicToolCall(
  runId: string,
  projectPath: string,
  params: Record<string, unknown>
): ParsedProviderRequest {
  const threadId = requiredString(params.threadId, "threadId");
  const turnId = requiredString(params.turnId, "turnId");
  const itemId = requiredString(params.callId, "callId");
  const tool = requiredString(params.tool, "tool");
  const namespace = optionalString(params.namespace);
  if (!("arguments" in params)) throw new Error("arguments is required");
  const argumentsJson = canonicalJson(params.arguments);
  return {
    dialect: "dynamic-tool",
    threadId,
    turnId,
    itemId,
    context: {
      runId,
      actor: { id: "codex-app-server", type: "agent" },
      tool: "codex.mcp",
      action: "dynamic-tool-call",
      argv: [namespace ?? "", tool, argumentsJson],
      cwd: projectPath,
      targets: [{ type: "mcp-tool", canonicalId: namespace === undefined ? tool : `${namespace}/${tool}` }],
      environment: "local",
      sideEffect: "external-write",
      recoverability: "none",
      contentHash: sha256(argumentsJson)
    }
  };
}

function commandTargets(
  actions: Record<string, unknown>[],
  cwd: string,
  command: string
): ActionContext["targets"] {
  const paths = actions.flatMap((action) => {
    const path = optionalString(action.path);
    return path === undefined ? [] : [resolve(cwd, path)];
  });
  if (paths.length > 0) {
    return [...new Set(paths)].map((path) => ({ type: "file", canonicalId: path }));
  }
  return [{ type: "command", canonicalId: sha256(command) }];
}

function permissionTargets(permissions: Record<string, unknown>): ActionContext["targets"] {
  const targets: ActionContext["targets"] = [];
  if (isRecord(permissions.network) && permissions.network.enabled !== false) {
    targets.push({ type: "network", canonicalId: "unmediated-network" });
  }
  const fileSystem = isRecord(permissions.fileSystem) ? permissions.fileSystem : undefined;
  for (const path of [...stringArray(fileSystem?.read), ...stringArray(fileSystem?.write)]) {
    targets.push({ type: "file", canonicalId: path });
  }
  if (targets.length === 0) {
    targets.push({ type: "permission-profile", canonicalId: sha256(canonicalJson(permissions)) });
  }
  return targets;
}

function isReadOnlyCommand(command: string, actions: Record<string, unknown>[]): boolean {
  if (actions.length === 0 || /[;&|><`$()\n\r]/.test(command)) return false;
  if (!/^(?:\/bin\/)?pwd\s*$/.test(command.trim())) return false;
  return actions.every((action) => {
    const type = optionalString(action.type);
    return type === "read" || type === "listFiles" || type === "list_files" || type === "search";
  });
}

function providerOffersAccept(parsed: ParsedProviderRequest): boolean {
  if (parsed.dialect !== "command-v2" || parsed.availableDecisions === undefined) return true;
  return parsed.availableDecisions.includes("accept");
}

function acceptedResponse(dialect: ResponseDialect): unknown {
  switch (dialect) {
    case "command-v2":
    case "file-v2":
      return { decision: "accept" };
    case "command-legacy":
    case "patch-legacy":
      return { decision: "approved" };
    default:
      throw new Error(`Provider request dialect cannot be accepted: ${dialect}`);
  }
}

function declinedResponse(
  dialect: ResponseDialect,
  reason: string,
  availableDecisions?: unknown[]
): unknown {
  switch (dialect) {
    case "command-v2":
      return { decision: availableDecisions?.includes("decline") === false ? "cancel" : "decline" };
    case "file-v2":
      return { decision: "decline" };
    case "command-legacy":
    case "patch-legacy":
      return { decision: { denied: { rejection: reason } } };
    case "mcp-elicitation":
      return { action: "decline" };
    default:
      throw new Error(`Provider request dialect has no decline response: ${dialect}`);
  }
}

function networkTarget(params: Record<string, unknown>): string {
  const context = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : {};
  return optionalString(context.host) ?? optionalString(context.hostname) ?? "unmediated-network";
}

function hasNetworkPermission(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.network)) return false;
  return value.network.enabled !== false;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is required`);
  return value;
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return [...value];
}

function optionalRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isKnownMethod(method: string): boolean {
  return [
    COMMAND_APPROVAL,
    FILE_APPROVAL,
    PERMISSION_APPROVAL,
    MCP_ELICITATION,
    DYNAMIC_TOOL_CALL,
    LEGACY_COMMAND_APPROVAL,
    LEGACY_PATCH_APPROVAL
  ].includes(method);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
