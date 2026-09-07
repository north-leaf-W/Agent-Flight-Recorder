import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  AppServerApprovalBridge,
  AppServerEventBridge,
  CODEX_ADAPTER_VERSION,
  CodexAppServerSupervisor,
  DEFAULT_APP_SERVER_RESOURCE_LIMITS,
  NETWORK_READ_DYNAMIC_TOOL,
  createNetworkReadDynamicToolHandler,
  detectCodexVersion,
  type AppServerExit,
  type AppServerHandshake,
  type AppServerNotification,
  type AppServerSupervisorOptions,
  type AppServerThread,
  type AppServerTurn,
  type HostedSandboxMode
} from "@afr/adapter-codex";
import {
  DEFAULT_WORKSPACE_CHANGE_LIMITS,
  HostedWorkspaceManager,
  type ApprovalService,
  type LocalStore,
  type ProviderCapabilitySnapshot,
  type ReadOnlyNetworkGateway
} from "@afr/core";
import { createRunCreatedEvent } from "@afr/core";

export type HostedLifecycleState =
  | "starting"
  | "running"
  | "idle"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unavailable";

export type HostedLifecycleSnapshot = {
  state: HostedLifecycleState;
  active: boolean;
  canCancel: boolean;
  canContinue: boolean;
  canFinish: boolean;
  canPromote: boolean;
  currentTurnId?: string;
  processId?: number;
  lastError?: string;
  updatedAt?: string;
};

export type HostedPreflight = {
  ready: boolean;
  mode: "hosted-observed";
  runtimeVersion?: string;
  projectPath?: string;
  repositoryRoot?: string;
  checks: {
    platform: "passed" | "failed";
    codexRuntime: "passed" | "failed";
    providerEgress: "passed" | "failed";
    projectAllowlist: "passed" | "failed" | "not-checked";
    gitWorkspace: "passed" | "failed" | "not-checked";
  };
  reasons: string[];
  constraints: {
    sandboxes: HostedSandboxMode[];
    providerEgressAllowlistCount: number;
    networkReadAllowlistCount: number;
    maximumTimeoutMs: number;
    maximumProviderLineBytes: number;
    maximumProviderStdoutBytes: number;
    maximumProviderMessages: number;
    maximumWorkspaceFiles: number;
    maximumWorkspaceFileBytes: number;
    maximumWorkspaceTotalBytes: number;
    maximumDiffBytes: number;
  };
};

export type HostedRunStartInput = {
  projectPath: string;
  task: string;
  sandbox: HostedSandboxMode;
  timeoutMs?: number;
  model?: string;
  storeModelContent?: boolean;
};

export type HostedRunContinueInput = {
  text: string;
  sandbox?: HostedSandboxMode;
  timeoutMs?: number;
  model?: string;
  storeModelContent?: boolean;
};

export type HostedHost = {
  state(): string;
  processId(): number | undefined;
  start(): Promise<AppServerHandshake>;
  startThread(options: {
    cwd: string;
    sandbox?: HostedSandboxMode;
    approvalPolicy?: "untrusted" | "on-request" | "never";
    ephemeral?: boolean;
    model?: string;
  }): Promise<AppServerThread>;
  resumeThread(threadId: string, options: {
    cwd: string;
    sandbox?: HostedSandboxMode;
    approvalPolicy?: "untrusted" | "on-request" | "never";
    model?: string;
  }): Promise<AppServerThread>;
  startTurn(threadId: string, text: string): Promise<AppServerTurn>;
  cancelTurn(threadId: string, turnId: string): Promise<AppServerExit>;
  stop(outcome?: "completed" | "failed" | "cancelled"): Promise<AppServerExit>;
  waitForExit(): Promise<AppServerExit>;
};

export type HostedRunManagerOptions = {
  store: LocalStore;
  approvals: ApprovalService;
  networkGateway: ReadOnlyNetworkGateway;
  allowedProjectRoots?: string[];
  binary?: string;
  environment?: NodeJS.ProcessEnv;
  providerEgressAllowlist?: string[];
  providerEgressTrustedPrivateAddresses?: string[];
  allowSyntheticProviderDns?: boolean;
  networkReadEnabled?: boolean;
  requireProviderEgress?: boolean;
  platform?: NodeJS.Platform;
  runtimeVersion?: string;
  hostFactory?: (options: AppServerSupervisorOptions) => HostedHost;
  publish?: (runId: string, afterSequenceNo: number) => void;
};

type ActiveHostedRun = {
  runId: string;
  sessionId: string;
  workspaceId: string;
  sourceProjectPath: string;
  worktreePath: string;
  runtimeVersion: string;
  sandbox: HostedSandboxMode;
  model?: string;
  storeModelContent: boolean;
  timeoutMs: number;
  host?: HostedHost;
  threadId?: string;
  currentTurnId?: string;
  state: "starting" | "running" | "idle" | "stopping";
  finalizing: boolean;
  updatedAt: string;
  lastError?: string;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAXIMUM_TIMEOUT_MS = 30 * 60 * 1000;

export class HostedRunError extends Error {
  constructor(
    readonly code:
      | "not_ready"
      | "project_not_allowed"
      | "project_not_git_root"
      | "run_not_found"
      | "session_not_resumable"
      | "invalid_state",
    message: string
  ) {
    super(message);
    this.name = "HostedRunError";
  }
}

export class HostedRunManager {
  private readonly workspaces: HostedWorkspaceManager;
  private readonly contexts = new Map<string, ActiveHostedRun>();
  private readonly allowedRoots: string[];
  private readonly binary: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly providerEgressAllowlist: string[];
  private readonly platform: NodeJS.Platform;
  private runtimeVersion: string | undefined;

  constructor(private readonly options: HostedRunManagerOptions) {
    this.workspaces = new HostedWorkspaceManager(options.store);
    this.allowedRoots = (options.allowedProjectRoots ?? [])
      .filter((path) => existsSync(path))
      .map((path) => realpathSync(resolve(path)));
    this.binary = options.binary ?? "codex";
    this.environment = options.environment ?? process.env;
    this.providerEgressAllowlist = [...(options.providerEgressAllowlist ?? [])];
    this.platform = options.platform ?? process.platform;
    this.runtimeVersion = options.runtimeVersion;
  }

  async preflight(projectPath?: string): Promise<HostedPreflight> {
    const reasons: string[] = [];
    const platformReady = this.platform === "darwin";
    if (!platformReady) reasons.push("Hosted Web launch currently requires the macOS sandbox boundary");
    const runtimeVersion = await this.detectRuntimeVersion();
    if (runtimeVersion === undefined) reasons.push("Codex CLI is unavailable or did not report a version");
    const providerEgressReady = this.options.requireProviderEgress === false ||
      this.providerEgressAllowlist.length > 0;
    if (!providerEgressReady) {
      reasons.push("A reviewed Provider egress allowlist is required for Web-launched Hosted Runs");
    }

    let canonicalProject: string | undefined;
    let repositoryRoot: string | undefined;
    let projectAllowed: HostedPreflight["checks"]["projectAllowlist"] = "not-checked";
    let gitWorkspace: HostedPreflight["checks"]["gitWorkspace"] = "not-checked";
    if (projectPath !== undefined && projectPath.trim().length > 0) {
      try {
        canonicalProject = realpathSync(resolve(projectPath));
        projectAllowed = this.isAllowedProject(canonicalProject) ? "passed" : "failed";
        if (projectAllowed === "failed") reasons.push("Project is outside the configured Hosted project roots");
        repositoryRoot = execFileSync("git", ["-C", canonicalProject, "rev-parse", "--show-toplevel"], {
          encoding: "utf8",
          timeout: 5_000,
          stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        repositoryRoot = realpathSync(repositoryRoot);
        gitWorkspace = repositoryRoot === canonicalProject ? "passed" : "failed";
        if (gitWorkspace === "failed") reasons.push("Project path must be the root of a tracked Git worktree");
      } catch {
        gitWorkspace = "failed";
        reasons.push("Project path is unavailable or is not a tracked Git worktree root");
      }
    }

    return {
      ready: platformReady && runtimeVersion !== undefined && providerEgressReady &&
        (projectPath === undefined || projectPath.trim().length === 0 ||
          (projectAllowed === "passed" && gitWorkspace === "passed")),
      mode: "hosted-observed",
      ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
      ...(canonicalProject === undefined ? {} : { projectPath: canonicalProject }),
      ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
      checks: {
        platform: platformReady ? "passed" : "failed",
        codexRuntime: runtimeVersion === undefined ? "failed" : "passed",
        providerEgress: providerEgressReady ? "passed" : "failed",
        projectAllowlist: projectAllowed,
        gitWorkspace
      },
      reasons,
      constraints: {
        sandboxes: ["read-only", "workspace-write"],
        providerEgressAllowlistCount: this.providerEgressAllowlist.length,
        networkReadAllowlistCount: this.options.networkReadEnabled === true ? 1 : 0,
        maximumTimeoutMs: MAXIMUM_TIMEOUT_MS,
        maximumProviderLineBytes: DEFAULT_APP_SERVER_RESOURCE_LIMITS.maxLineBytes,
        maximumProviderStdoutBytes: DEFAULT_APP_SERVER_RESOURCE_LIMITS.maxStdoutBytes,
        maximumProviderMessages: DEFAULT_APP_SERVER_RESOURCE_LIMITS.maxMessages,
        maximumWorkspaceFiles: DEFAULT_WORKSPACE_CHANGE_LIMITS.maxFiles,
        maximumWorkspaceFileBytes: DEFAULT_WORKSPACE_CHANGE_LIMITS.maxFileBytes,
        maximumWorkspaceTotalBytes: DEFAULT_WORKSPACE_CHANGE_LIMITS.maxTotalBytes,
        maximumDiffBytes: DEFAULT_WORKSPACE_CHANGE_LIMITS.maxDiffBytes
      }
    };
  }

  async start(input: HostedRunStartInput) {
    const preflight = await this.preflight(input.projectPath);
    if (!preflight.ready || preflight.projectPath === undefined || preflight.runtimeVersion === undefined) {
      throw new HostedRunError("not_ready", preflight.reasons.join("; ") || "Hosted preflight failed");
    }
    const timeoutMs = normalizeTimeout(input.timeoutMs);
    const run = this.options.store.createRun({
      projectPath: preflight.projectPath,
      task: input.task,
      agentId: "codex-app-server"
    });
    this.options.store.appendEvents(run.id, [createRunCreatedEvent(run)]);
    const prepared = this.workspaces.prepare({ runId: run.id });
    const issued = this.options.store.createProviderSession({
      runId: run.id,
      provider: "openai-codex",
      adapterVersion: CODEX_ADAPTER_VERSION,
      runtimeVersion: preflight.runtimeVersion,
      protocolVersion: this.options.networkReadEnabled === true
        ? "app-server-v2-experimental-dynamic-tools"
        : "app-server-v2",
      mode: "hosted-observed",
      capabilities: this.capabilities(preflight.runtimeVersion)
    });
    this.workspaces.activate(prepared.workspace.id);
    this.options.store.transitionRun(run.id, "running", "afr-host", `hosted-workspace:${prepared.workspace.id}`);
    const context: ActiveHostedRun = {
      runId: run.id,
      sessionId: issued.session.id,
      workspaceId: prepared.workspace.id,
      sourceProjectPath: preflight.projectPath,
      worktreePath: prepared.workspace.worktreePath,
      runtimeVersion: preflight.runtimeVersion,
      sandbox: input.sandbox,
      ...(input.model === undefined ? {} : { model: input.model }),
      storeModelContent: input.storeModelContent ?? false,
      timeoutMs,
      state: "starting",
      finalizing: false,
      updatedAt: new Date().toISOString()
    };
    this.contexts.set(run.id, context);
    this.publish(run.id, 0);
    void this.launch(context, input.task).catch((error: unknown) => this.fail(context, error));
    return { run: this.options.store.getRun(run.id)!, lifecycle: this.snapshot(run.id), preflight };
  }

  async continue(runId: string, input: HostedRunContinueInput): Promise<HostedLifecycleSnapshot> {
    const current = this.contexts.get(runId);
    if (current !== undefined) {
      if (current.state !== "idle" || current.finalizing) {
        throw new HostedRunError("invalid_state", `Hosted Run cannot continue while ${current.state}`);
      }
      current.state = "running";
      current.updatedAt = new Date().toISOString();
      try {
        await this.beginTurn(current, input.text);
      } catch (error) {
        await this.fail(current, error);
        throw error;
      }
      return this.snapshot(runId);
    }

    const run = this.options.store.getRun(runId);
    if (run === undefined) throw new HostedRunError("run_not_found", `Run does not exist: ${runId}`);
    const previous = this.options.store.getLatestProviderSession(runId);
    const workspace = this.options.store.getHostedWorkspaceByRun(runId);
    if (
      run.status !== "interrupted" || previous?.status !== "interrupted" ||
      previous.externalSessionId === undefined || workspace?.status !== "active"
    ) {
      throw new HostedRunError("session_not_resumable", "Hosted Run has no interrupted Thread and active worktree to resume");
    }
    const preflight = await this.preflight(run.projectPath);
    if (!preflight.ready || preflight.runtimeVersion === undefined) {
      throw new HostedRunError("not_ready", preflight.reasons.join("; ") || "Hosted preflight failed");
    }
    const sandbox = input.sandbox ?? "read-only";
    const issued = this.options.store.createProviderSession({
      runId,
      provider: "openai-codex",
      adapterVersion: CODEX_ADAPTER_VERSION,
      runtimeVersion: preflight.runtimeVersion,
      protocolVersion: this.options.networkReadEnabled === true
        ? "app-server-v2-experimental-dynamic-tools"
        : "app-server-v2",
      mode: "hosted-observed",
      capabilities: this.capabilities(preflight.runtimeVersion)
    });
    this.options.store.transitionRun(runId, "running", "afr-host", `resume-thread:${previous.externalSessionId}`);
    const resumed: ActiveHostedRun = {
      runId,
      sessionId: issued.session.id,
      workspaceId: workspace.id,
      sourceProjectPath: run.projectPath,
      worktreePath: workspace.worktreePath,
      runtimeVersion: preflight.runtimeVersion,
      sandbox,
      ...(input.model === undefined ? {} : { model: input.model }),
      storeModelContent: input.storeModelContent ?? false,
      timeoutMs: normalizeTimeout(input.timeoutMs),
      state: "starting",
      finalizing: false,
      updatedAt: new Date().toISOString()
    };
    this.contexts.set(runId, resumed);
    this.publish(runId, 0);
    void this.launch(resumed, input.text, previous.externalSessionId)
      .catch((error: unknown) => this.fail(resumed, error));
    return this.snapshot(runId);
  }

  async cancel(runId: string): Promise<HostedLifecycleSnapshot> {
    const context = this.requireActive(runId);
    if (context.finalizing) throw new HostedRunError("invalid_state", "Hosted Run is already stopping");
    context.finalizing = true;
    context.state = "stopping";
    context.updatedAt = new Date().toISOString();
    const before = this.options.store.getRun(runId)?.lastSequenceNo ?? 0;
    const session = this.options.store.getProviderSession(context.sessionId);
    if (session?.status === "running") {
      this.options.store.transitionProviderSession({ sessionId: session.id, status: "stopping" });
    }
    try {
      const exit = context.host === undefined
        ? undefined
        : context.threadId !== undefined && context.currentTurnId !== undefined
          ? await context.host.cancelTurn(context.threadId, context.currentTurnId)
          : await context.host.stop("cancelled");
      if (exit !== undefined && exit.outcome === "failed") {
        throw new Error(exit.errorMessage ?? "App Server failed while cancelling");
      }
      this.finalizeWorkspace(context);
      this.transitionSessionIfActive(context.sessionId, "cancelled");
      this.transitionRunIfActive(runId, "cancelled", `provider-session:${context.sessionId}`);
      this.contexts.delete(runId);
      this.publish(runId, before);
      return this.snapshot(runId);
    } catch (error) {
      await this.fail(context, error);
      return this.snapshot(runId);
    }
  }

  async finish(runId: string): Promise<HostedLifecycleSnapshot> {
    const context = this.requireActive(runId);
    if (context.state !== "idle" || context.finalizing) {
      throw new HostedRunError("invalid_state", `Hosted Run can only finish while idle, not ${context.state}`);
    }
    context.finalizing = true;
    context.state = "stopping";
    context.updatedAt = new Date().toISOString();
    const before = this.options.store.getRun(runId)?.lastSequenceNo ?? 0;
    const session = this.options.store.getProviderSession(context.sessionId);
    if (session?.status === "running") {
      this.options.store.transitionProviderSession({ sessionId: session.id, status: "stopping" });
    }
    try {
      const exit = await context.host!.stop("completed");
      if (exit.outcome !== "completed") throw new Error(exit.errorMessage ?? `App Server exited as ${exit.outcome}`);
      this.finalizeWorkspace(context);
      this.transitionSessionIfActive(context.sessionId, "completed");
      this.transitionRunIfActive(runId, "completed", `provider-session:${context.sessionId}`);
      this.contexts.delete(runId);
      this.publish(runId, before);
      return this.snapshot(runId);
    } catch (error) {
      await this.fail(context, error);
      return this.snapshot(runId);
    }
  }

  snapshot(runId: string): HostedLifecycleSnapshot {
    const context = this.contexts.get(runId);
    const workspace = this.options.store.getHostedWorkspaceByRun(runId);
    const promotion = this.options.store.listPatchPromotions(runId)[0];
    if (context !== undefined) {
      const processId = context.host?.processId();
      return {
        state: context.state,
        active: true,
        canCancel: !context.finalizing,
        canContinue: context.state === "idle" && !context.finalizing,
        canFinish: context.state === "idle" && !context.finalizing,
        canPromote: false,
        ...(context.currentTurnId === undefined ? {} : { currentTurnId: context.currentTurnId }),
        ...(processId === undefined ? {} : { processId }),
        ...(context.lastError === undefined ? {} : { lastError: context.lastError }),
        updatedAt: context.updatedAt
      };
    }
    const session = this.options.store.getLatestProviderSession(runId);
    const state: HostedLifecycleState = session === undefined
      ? "unavailable"
      : session.status === "created"
        ? "starting"
        : session.status;
    return {
      state,
      active: false,
      canCancel: false,
      canContinue: state === "interrupted" && session?.externalSessionId !== undefined && workspace?.status === "active",
      canFinish: false,
      canPromote: workspace?.status === "finalized" && workspace.changedPaths.length > 0 && promotion === undefined,
      ...(session?.lastErrorMessage === undefined ? {} : { lastError: session.lastErrorMessage }),
      ...(session?.updatedAt === undefined ? {} : { updatedAt: session.updatedAt })
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.contexts.values()].map(async (context) => {
      context.finalizing = true;
      try {
        if (context.host !== undefined && ["starting", "running", "stopping"].includes(context.host.state())) {
          await context.host.stop("cancelled");
        }
      } catch {
        // Shutdown still records an interrupted session below.
      }
      this.transitionSessionIfActive(context.sessionId, "interrupted", "server_shutdown", "AFR stopped while the Hosted Run was active");
      this.transitionRunIfActive(context.runId, "interrupted", `provider-session:${context.sessionId}`);
    }));
    this.contexts.clear();
  }

  private async launch(context: ActiveHostedRun, text: string, resumeThreadId?: string): Promise<void> {
    const host = this.createHost(context);
    context.host = host;
    this.options.store.transitionProviderSession({ sessionId: context.sessionId, status: "starting" });
    await host.start();
    const thread = resumeThreadId === undefined
      ? await host.startThread({
          cwd: context.worktreePath,
          sandbox: context.sandbox,
          approvalPolicy: "on-request",
          ephemeral: false,
          ...(context.model === undefined ? {} : { model: context.model })
        })
      : await host.resumeThread(resumeThreadId, {
          cwd: context.worktreePath,
          sandbox: context.sandbox,
          approvalPolicy: "on-request",
          ...(context.model === undefined ? {} : { model: context.model })
        });
    context.threadId = thread.threadId;
    const processId = host.processId();
    this.options.store.transitionProviderSession({
      sessionId: context.sessionId,
      status: "running",
      externalSessionId: thread.threadId,
      ...(processId === undefined ? {} : { processId })
    });
    context.state = "running";
    context.updatedAt = new Date().toISOString();
    void host.waitForExit().then((exit) => {
      if (!context.finalizing && this.contexts.get(context.runId) === context) {
        void this.fail(context, new Error(exit.errorMessage ?? `App Server exited as ${exit.outcome}`));
      }
    });
    await this.beginTurn(context, text);
  }

  private async beginTurn(context: ActiveHostedRun, text: string): Promise<void> {
    if (context.host === undefined || context.threadId === undefined) {
      throw new HostedRunError("invalid_state", "Hosted Thread is not ready");
    }
    delete context.currentTurnId;
    const turn = await context.host.startTurn(context.threadId, text);
    if (context.state === "running" && !context.finalizing) context.currentTurnId = turn.turnId;
    context.updatedAt = new Date().toISOString();
  }

  private createHost(context: ActiveHostedRun): HostedHost {
    const eventBridge = new AppServerEventBridge(this.options.store, {
      runId: context.runId,
      providerSessionId: context.sessionId,
      runtimeVersion: context.runtimeVersion,
      storeModelContent: context.storeModelContent
    });
    const approvalBridge = new AppServerApprovalBridge({
      runId: context.runId,
      providerSessionId: context.sessionId,
      approvals: this.options.approvals,
      store: this.options.store,
      projectPath: context.worktreePath
    });
    const networkTool = this.options.networkReadEnabled === true
      ? createNetworkReadDynamicToolHandler({ gateway: this.options.networkGateway, sessionId: context.sessionId })
      : undefined;
    const hostOptions: AppServerSupervisorOptions = {
      cwd: context.worktreePath,
      binary: this.binary,
      environment: this.environment,
      startupTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
      hostTimeoutMs: context.timeoutMs,
      shutdownGraceMs: 1_000,
      ...(this.providerEgressAllowlist.length === 0
        ? {}
        : {
            providerEgress: {
              allowlist: this.providerEgressAllowlist,
              trustedPrivateAddresses: this.options.providerEgressTrustedPrivateAddresses ?? [],
              allowSyntheticDnsRange: this.options.allowSyntheticProviderDns ?? false
            }
          }),
      ...(networkTool === undefined
        ? {}
        : { dynamicTools: [NETWORK_READ_DYNAMIC_TOOL], onDynamicToolCall: networkTool }),
      onNetworkAudit: (event) => {
        const before = this.options.store.getRun(context.runId)?.lastSequenceNo ?? 0;
        this.options.store.recordNetworkMediation({ sessionId: context.sessionId, ...event });
        this.publish(context.runId, before);
      },
      onServerRequest: async (request, signal) => {
        const before = this.options.store.getRun(context.runId)?.lastSequenceNo ?? 0;
        try {
          return await approvalBridge.handle(request, signal);
        } finally {
          this.publish(context.runId, before);
        }
      },
      onNotification: async (notification) => {
        const before = this.options.store.getRun(context.runId)?.lastSequenceNo ?? 0;
        eventBridge.handle(notification);
        this.publish(context.runId, before);
        this.handleNotification(context, notification);
      }
    };
    return this.options.hostFactory?.(hostOptions) ?? new CodexAppServerSupervisor(hostOptions);
  }

  private handleNotification(context: ActiveHostedRun, notification: AppServerNotification): void {
    if (notification.method !== "turn/completed" || context.finalizing) return;
    const status = terminalTurnStatus(notification);
    delete context.currentTurnId;
    context.updatedAt = new Date().toISOString();
    if (status === "completed") {
      context.state = "idle";
      return;
    }
    void this.fail(context, new Error(`Hosted Turn ended as ${status ?? "unknown"}`));
  }

  private async fail(context: ActiveHostedRun, error: unknown): Promise<void> {
    if (this.contexts.get(context.runId) !== context) return;
    context.finalizing = true;
    context.state = "stopping";
    context.lastError = messageOf(error);
    context.updatedAt = new Date().toISOString();
    const before = this.options.store.getRun(context.runId)?.lastSequenceNo ?? 0;
    try {
      if (context.host !== undefined && ["starting", "running", "stopping"].includes(context.host.state())) {
        await context.host.stop("failed");
      }
    } catch {
      // Preserve the first failure below.
    }
    try {
      this.finalizeWorkspace(context);
    } catch {
      // Workspace manager records its own finalization failure.
    }
    this.transitionSessionIfActive(
      context.sessionId,
      "failed",
      "hosted_run_failed",
      context.lastError
    );
    this.transitionRunIfActive(context.runId, "failed", `provider-session:${context.sessionId}`);
    this.contexts.delete(context.runId);
    this.publish(context.runId, before);
  }

  private finalizeWorkspace(context: ActiveHostedRun): void {
    const workspace = this.options.store.getHostedWorkspace(context.workspaceId);
    if (workspace?.status === "ready" || workspace?.status === "active") {
      this.workspaces.finalize(workspace.id);
    }
  }

  private transitionSessionIfActive(
    sessionId: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    errorCode?: string,
    errorMessage?: string
  ): void {
    const session = this.options.store.getProviderSession(sessionId);
    if (session !== undefined && ["created", "starting", "running", "stopping"].includes(session.status)) {
      this.options.store.transitionProviderSession({
        sessionId,
        status,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(errorMessage === undefined ? {} : { errorMessage })
      });
    }
  }

  private transitionRunIfActive(
    runId: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    reason: string
  ): void {
    const run = this.options.store.getRun(runId);
    if (run !== undefined && ["created", "running", "waiting_approval", "interrupted"].includes(run.status)) {
      this.options.store.transitionRun(runId, status, "afr-host", reason);
    }
  }

  private requireActive(runId: string): ActiveHostedRun {
    const context = this.contexts.get(runId);
    if (context === undefined) throw new HostedRunError("invalid_state", "Hosted Run is not active in this AFR process");
    return context;
  }

  private publish(runId: string, afterSequenceNo: number): void {
    this.options.publish?.(runId, afterSequenceNo);
  }

  private async detectRuntimeVersion(): Promise<string | undefined> {
    if (this.runtimeVersion !== undefined) return this.runtimeVersion;
    this.runtimeVersion = await detectCodexVersion(this.binary, process.cwd(), this.environment);
    return this.runtimeVersion;
  }

  private isAllowedProject(projectPath: string): boolean {
    return this.allowedRoots.some((root) => {
      const child = relative(root, projectPath);
      return child === "" || (!child.startsWith("..") && !child.includes("/../"));
    });
  }

  private capabilities(runtimeVersion: string): ProviderCapabilitySnapshot {
    return {
      eventStream: { state: "supported", source: "local-schema-and-runtime", version: runtimeVersion },
      cancellation: { state: "supported", source: "app-server-turn-interrupt", version: runtimeVersion },
      sessionResume: { state: "supported", source: "app-server-thread-resume", version: runtimeVersion },
      workspaceIsolation: { state: "supported", source: "afr-hosted-workspace", version: "H3" },
      eventPersistence: { state: "supported", source: "afr-app-server-event-bridge", version: "H4" },
      approvalBridge: { state: "supported", source: "afr-app-server-approval-bridge", version: "H6" },
      patchPromotion: { state: "supported", source: "afr-patch-promotion", version: "H7" },
      networkMediation: this.providerEgressAllowlist.length > 0
        ? { state: "supported", source: "afr-provider-egress-boundary", version: "H8-C" }
        : { state: "degraded", source: "provider-egress-not-configured", version: "H8-C" },
      hostedGovernance: {
        state: "degraded",
        source: "afr-hosted-h9-b",
        version: "H9-B",
        detail: "Hosted lifecycle is controlled, but comprehensive side-effect mediation remains incomplete"
      }
    };
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAXIMUM_TIMEOUT_MS) {
    throw new HostedRunError(
      "invalid_state",
      `timeoutMs must be an integer between 1000 and ${MAXIMUM_TIMEOUT_MS}`
    );
  }
  return value;
}

function terminalTurnStatus(notification: AppServerNotification): string | undefined {
  if (notification.params === null || typeof notification.params !== "object" || Array.isArray(notification.params)) {
    return undefined;
  }
  const turn = (notification.params as Record<string, unknown>).turn;
  if (turn === null || typeof turn !== "object" || Array.isArray(turn)) return undefined;
  const status = (turn as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
