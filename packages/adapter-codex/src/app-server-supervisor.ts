import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { relative, resolve } from "node:path";

import { CodexJsonlDecoder } from "./jsonl-decoder.js";
import {
  AppServerSecurityBoundaryError,
  HostedNetworkGuard,
  PROVIDER_PROXY_ENV_KEYS,
  type HostedSandboxMode,
  type NetworkMediationAuditEvent
} from "./network-mediation.js";
import {
  ProviderEgressBoundary,
  type ProviderEgressOptions
} from "./provider-egress.js";
import { CODEX_ADAPTER_VERSION } from "./normalizer.js";

export type JsonRpcId = string | number;

export type AppServerNotification = {
  method: string;
  params?: unknown;
};

export type AppServerRequest = AppServerNotification & {
  id: JsonRpcId;
};

export type AppServerHandshake = {
  userAgent?: string;
  platformFamily?: string;
  platformOs?: string;
  raw: unknown;
};

export type AppServerThreadStartOptions = {
  cwd: string;
  sandbox?: HostedSandboxMode;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  ephemeral?: boolean;
  model?: string;
};

export type AppServerCommandExecOptions = {
  command: string[];
  cwd?: string;
  sandbox?: HostedSandboxMode;
  env?: Record<string, string | null>;
  timeoutMs?: number;
  outputBytesCap?: number;
};

export type AppServerCommandExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  raw: unknown;
};

export type AppServerThread = {
  threadId: string;
  raw: unknown;
};

export type AppServerTurn = {
  turnId: string;
  raw: unknown;
};

export type AppServerDynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
};

export type AppServerDynamicToolCall = {
  callId: string;
  threadId: string;
  turnId: string;
  tool: string;
  namespace?: string;
  arguments: unknown;
};

export type AppServerDynamicToolResponse = {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
    | { type: "inputAudio"; audioUrl: string }
  >;
};

export type AppServerExit = {
  outcome: "completed" | "failed" | "cancelled" | "interrupted";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: { text: string; byteSize: number; truncated: boolean };
  errorMessage?: string;
};

export type AppServerSupervisorOptions = {
  cwd: string;
  binary?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  hostTimeoutMs?: number;
  shutdownGraceMs?: number;
  maxLineBytes?: number;
  maxStdoutBytes?: number;
  maxMessages?: number;
  providerEgress?: ProviderEgressOptions;
  dynamicTools?: AppServerDynamicToolSpec[];
  onDynamicToolCall?: (
    call: AppServerDynamicToolCall,
    signal: AbortSignal
  ) => AppServerDynamicToolResponse | Promise<AppServerDynamicToolResponse>;
  onNotification?: (notification: AppServerNotification) => void | Promise<void>;
  onServerRequest?: (request: AppServerRequest, signal: AbortSignal) => unknown | Promise<unknown>;
  onNetworkAudit?: (event: NetworkMediationAuditEvent) => void;
};

type HostState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DISABLED_HOST_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "plugins",
  "remote_plugin",
  "skill_mcp_dependency_install"
] as const;

export const DEFAULT_APP_SERVER_RESOURCE_LIMITS = {
  maxLineBytes: 1024 * 1024,
  maxStdoutBytes: 64 * 1024 * 1024,
  maxMessages: 100_000
} as const;

export class AppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown
  ) {
    super(`App Server request ${method} failed${code === undefined ? "" : ` (${code})`}: ${message}`);
    this.name = "AppServerRpcError";
  }
}

export class AppServerRequestRejectedError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "AppServerRequestRejectedError";
  }
}

export class CodexAppServerSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private hostState: HostState = "idle";
  private readonly pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private consumePromise?: Promise<void>;
  private exitPromise?: Promise<AppServerExit>;
  private resolveExit?: (result: AppServerExit) => void;
  private runtimeTimer?: ReturnType<typeof setTimeout>;
  private forceKillTimer?: ReturnType<typeof setTimeout>;
  private requestedOutcome?: AppServerExit["outcome"];
  private timedOut = false;
  private failure?: Error;
  private stderrText = "";
  private stderrBytes = 0;
  private stderrTruncated = false;
  private stdoutBytes = 0;
  private messageCount = 0;
  private readonly serverRequestAbort = new AbortController();
  private readonly serverRequestTasks = new Set<Promise<void>>();
  private readonly threadSandboxes = new Map<string, { mode: HostedSandboxMode; cwd: string }>();
  private readonly networkGuard: HostedNetworkGuard;
  private providerEgressBoundary: ProviderEgressBoundary | undefined;
  private mcpServerNames: string[] = [];

  constructor(private readonly options: AppServerSupervisorOptions) {
    assertPositiveLimit("maxLineBytes", options.maxLineBytes);
    assertPositiveLimit("maxStdoutBytes", options.maxStdoutBytes);
    assertPositiveLimit("maxMessages", options.maxMessages);
    this.networkGuard = new HostedNetworkGuard(
      options.onNetworkAudit === undefined ? {} : { onAudit: options.onNetworkAudit }
    );
    validateDynamicTools(options.dynamicTools, options.onDynamicToolCall);
  }

  state(): HostState {
    return this.hostState;
  }

  processId(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<AppServerHandshake> {
    if (this.hostState !== "idle") {
      throw new Error(`App Server host cannot start from ${this.hostState}`);
    }
    this.hostState = "starting";
    const binary = this.options.binary ?? "codex";
    const appServerArgs = [
      "app-server",
      "--stdio",
      ...DISABLED_HOST_FEATURES.flatMap((feature) => ["--disable", feature]),
      "-c",
      'web_search="disabled"',
      "-c",
      'shell_environment_policy.inherit="core"',
      "-c",
      `shell_environment_policy.exclude=${JSON.stringify(PROVIDER_PROXY_ENV_KEYS)}`
    ];
    let command = binary;
    let args = appServerArgs;
    let environment = this.options.environment ?? process.env;
    if (this.options.providerEgress !== undefined) {
      const boundary = new ProviderEgressBoundary({
        ...this.options.providerEgress,
        onAudit: (event) => this.networkGuard.audit(event)
      });
      this.providerEgressBoundary = boundary;
      try {
        const endpoint = await boundary.start();
        const spawnSpec = boundary.spawnSpec(
          binary,
          appServerArgs,
          process.platform,
          this.options.providerEgress.sandboxExecutable ?? "/usr/bin/sandbox-exec"
        );
        command = spawnSpec.command;
        args = spawnSpec.args;
        environment = boundary.environment(environment);
        this.networkGuard.audit({
          source: "host",
          operation: "provider.egress.boundary",
          decision: "sandbox-enforced",
          effectivePolicy: {
            directNetwork: "denied",
            allowedDestination: `localhost:${endpoint.port}`,
            proxy: "authenticated-connect"
          },
          evidence: { platform: process.platform, sandbox: "sandbox-exec" }
        });
      } catch (error) {
        await boundary.stop().catch(() => undefined);
        this.providerEgressBoundary = undefined;
        this.hostState = "failed";
        throw error;
      }
    }
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.captureStderr(chunk));
    child.once("error", (error) => {
      this.failure = error;
    });
    child.once("close", (exitCode, signal) => {
      void this.finishExit(exitCode, signal);
    });
    this.consumePromise = this.consumeStdout(child).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.terminateChild();
    });
    try {
      const raw = await this.rawRequest(
        "initialize",
        {
          clientInfo: { name: "afr-host", version: CODEX_ADAPTER_VERSION },
          capabilities: { experimentalApi: (this.options.dynamicTools?.length ?? 0) > 0 }
        },
        this.options.startupTimeoutMs ?? 5_000
      );
      this.networkGuard.audit({
        source: "host",
        operation: "initialize",
        decision: "control-allowed",
        evidence: { channel: "provider-control", toolNetworkAccess: false }
      });
      await this.rawNotify("initialized");
      const effectiveConfig = await this.rawRequest("config/read", {
        cwd: this.options.cwd,
        includeLayers: false
      });
      this.mcpServerNames = this.networkGuard.inspectHostedConfiguration("config/read", effectiveConfig);
      if (this.providerEgressBoundary !== undefined) {
        this.networkGuard.assertProxyEnvironmentExcluded("config/read", effectiveConfig);
      }
      this.hostState = "running";
      if (this.options.hostTimeoutMs !== undefined) {
        this.runtimeTimer = setTimeout(() => {
          this.timedOut = true;
          this.requestedOutcome = "failed";
          this.failure = new Error(`App Server host timed out after ${this.options.hostTimeoutMs}ms`);
          this.terminateChild();
        }, this.options.hostTimeoutMs);
      }
      return mapHandshake(raw);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      await this.stop("failed");
      throw this.failure;
    }
  }

  private async rawRequest(method: string, params: unknown = {}, timeoutMs?: number): Promise<unknown> {
    if (this.child === undefined || !["starting", "running"].includes(this.hostState)) {
      throw new Error(`App Server request cannot be sent while host is ${this.hostState}`);
    }
    this.networkGuard.assertClientRequestAllowed(method);
    const id = `afr-host-${++this.requestSequence}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server request timed out: ${method}`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 10_000);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    try {
      await this.send({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }

  private async rawNotify(method: string, params?: unknown): Promise<void> {
    if (this.child === undefined || !["starting", "running"].includes(this.hostState)) {
      throw new Error(`App Server notification cannot be sent while host is ${this.hostState}`);
    }
    if (method !== "initialized") {
      throw new AppServerSecurityBoundaryError(
        method,
        `App Server client notification is outside the AFR hosted allowlist: ${method}`
      );
    }
    await this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.rawRequest("turn/interrupt", { threadId, turnId });
  }

  async startThread(options: AppServerThreadStartOptions): Promise<AppServerThread> {
    this.assertHostedCwd(options.cwd, "thread/start", true);
    const sandbox = options.sandbox ?? "read-only";
    const sandboxPolicy = this.networkGuard.sandboxPolicy(sandbox, options.cwd);
    this.networkGuard.audit({
      source: "host",
      operation: "thread/start",
      decision: "sandbox-enforced",
      requestedPolicy: sandboxPolicy,
      effectivePolicy: sandboxPolicy,
      evidence: {
        cwd: options.cwd,
        networkAccess: false,
        nativeWebSearch: "disabled",
        environmentInheritance: "core"
      }
    });
    const raw = await this.rawRequest("thread/start", {
      cwd: options.cwd,
      sandbox,
      config: hostedThreadConfig(sandbox, this.mcpServerNames),
      ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
      ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(this.options.dynamicTools === undefined ? {} : { dynamicTools: this.options.dynamicTools })
    });
    this.networkGuard.assertRuntimeSandbox("thread/start", sandbox, nestedValue(raw, "sandbox"), options.cwd);
    const threadId = requiredNestedId(raw, "thread", "thread/start");
    try {
      await this.verifyMcpServersDisabled(threadId);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      await this.stop("failed");
      throw this.failure;
    }
    this.threadSandboxes.set(threadId, { mode: sandbox, cwd: options.cwd });
    return { threadId, raw };
  }

  async resumeThread(threadId: string, options: Omit<AppServerThreadStartOptions, "ephemeral">): Promise<AppServerThread> {
    this.assertHostedCwd(options.cwd, "thread/resume", true);
    const sandbox = options.sandbox ?? "read-only";
    const sandboxPolicy = this.networkGuard.sandboxPolicy(sandbox, options.cwd);
    this.networkGuard.audit({
      source: "host",
      operation: "thread/resume",
      decision: "sandbox-enforced",
      requestedPolicy: sandboxPolicy,
      effectivePolicy: sandboxPolicy,
      evidence: {
        cwd: options.cwd,
        networkAccess: false,
        nativeWebSearch: "disabled",
        environmentInheritance: "core"
      }
    });
    const raw = await this.rawRequest("thread/resume", {
      threadId,
      cwd: options.cwd,
      sandbox,
      config: hostedThreadConfig(sandbox, this.mcpServerNames),
      ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(this.options.dynamicTools === undefined ? {} : { dynamicTools: this.options.dynamicTools })
    });
    this.networkGuard.assertRuntimeSandbox("thread/resume", sandbox, nestedValue(raw, "sandbox"), options.cwd);
    const resumedThreadId = requiredNestedId(raw, "thread", "thread/resume");
    try {
      await this.verifyMcpServersDisabled(resumedThreadId);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      await this.stop("failed");
      throw this.failure;
    }
    this.threadSandboxes.set(resumedThreadId, { mode: sandbox, cwd: options.cwd });
    return { threadId: resumedThreadId, raw };
  }

  async startTurn(threadId: string, text: string): Promise<AppServerTurn> {
    const threadSandbox = this.threadSandboxes.get(threadId);
    if (threadSandbox === undefined) {
      throw new AppServerSecurityBoundaryError(
        "turn/start",
        `Cannot start a Turn for an unbound App Server thread: ${threadId}`
      );
    }
    const sandboxPolicy = this.networkGuard.sandboxPolicy(
      threadSandbox.mode,
      threadSandbox.cwd
    );
    this.networkGuard.audit({
      source: "host",
      operation: "turn/start",
      decision: "sandbox-enforced",
      requestedPolicy: sandboxPolicy,
      effectivePolicy: sandboxPolicy,
      evidence: { threadId, networkAccess: false }
    });
    const raw = await this.rawRequest("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      sandboxPolicy
    });
    return { turnId: requiredNestedId(raw, "turn", "turn/start"), raw };
  }

  async executeCommand(options: AppServerCommandExecOptions): Promise<AppServerCommandExecResult> {
    if (options.command.length === 0 || options.command.some((argument) => typeof argument !== "string")) {
      throw new Error("App Server command/exec requires a non-empty argv vector");
    }
    const sandbox = options.sandbox ?? "read-only";
    const cwd = options.cwd ?? this.options.cwd;
    this.assertHostedCwd(cwd, "command/exec", false);
    const sandboxPolicy = this.networkGuard.sandboxPolicy(sandbox, cwd);
    this.networkGuard.audit({
      source: "host",
      operation: "command/exec",
      decision: "sandbox-enforced",
      requestedPolicy: sandboxPolicy,
      effectivePolicy: sandboxPolicy,
      evidence: { argvLength: options.command.length, cwd, networkAccess: false }
    });
    const raw = await this.rawRequest("command/exec", {
      command: options.command,
      cwd,
      sandboxPolicy,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.outputBytesCap === undefined ? {} : { outputBytesCap: options.outputBytesCap })
    }, options.timeoutMs === undefined ? undefined : options.timeoutMs + 1_000);
    const result = requiredCommandExecResult(raw);
    this.networkGuard.audit({
      source: "runtime",
      operation: "command/exec",
      decision: "observed",
      effectivePolicy: sandboxPolicy,
      evidence: { exitCode: result.exitCode, networkAccess: false }
    });
    return { ...result, raw };
  }

  async cancelTurn(threadId: string, turnId: string): Promise<AppServerExit> {
    try {
      await this.interruptTurn(threadId, turnId);
      return this.stop("cancelled");
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      return this.stop("failed");
    }
  }

  async stop(outcome: "completed" | "failed" | "cancelled" = "completed"): Promise<AppServerExit> {
    if (this.exitPromise === undefined || this.child === undefined) {
      throw new Error("App Server host has not been started");
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return this.exitPromise;
    }
    if (this.hostState !== "stopped" && this.hostState !== "failed") {
      this.hostState = "stopping";
      this.requestedOutcome = outcome;
      if (this.runtimeTimer !== undefined) clearTimeout(this.runtimeTimer);
      this.child.stdin.end();
      this.terminateChild();
    }
    return this.exitPromise;
  }

  async waitForExit(): Promise<AppServerExit> {
    if (this.exitPromise === undefined) throw new Error("App Server host has not been started");
    return this.exitPromise;
  }

  private assertHostedCwd(cwd: string, operation: string, exact: boolean): void {
    const hostedRoot = resolve(this.options.cwd);
    const candidate = resolve(cwd);
    const child = relative(hostedRoot, candidate);
    const allowed = exact
      ? child === ""
      : child === "" || (!child.startsWith("..") && !child.includes("/../"));
    if (allowed) return;
    this.networkGuard.audit({
      source: "host",
      operation,
      decision: "denied",
      evidence: { reason: "cwd_outside_hosted_root", hostedRoot, requestedCwd: candidate }
    });
    throw new AppServerSecurityBoundaryError(
      operation,
      `App Server ${operation} cwd is outside the hosted root`
    );
  }

  private async verifyMcpServersDisabled(threadId: string): Promise<void> {
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.rawRequest("mcpServerStatus/list", {
        cursor: cursor ?? null,
        limit: 100,
        detail: "toolsAndAuthOnly",
        threadId
      });
      const verified = this.networkGuard.assertMcpRuntimeDisabled(
        "mcpServerStatus/list",
        response
      );
      for (const name of verified.names) names.add(name);
      cursor = verified.nextCursor;
      if (cursor === undefined) break;
      if (page === 99) {
        throw new AppServerSecurityBoundaryError(
          "mcpServerStatus/list",
          "App Server MCP status pagination exceeded the hosted verification limit"
        );
      }
    }
    if (this.mcpServerNames.some((name) => !names.has(name))) {
      this.networkGuard.audit({
        source: "runtime",
        operation: "mcpServerStatus/list",
        decision: "denied",
        evidence: { reason: "configured_mcp_status_missing" }
      });
      throw new AppServerSecurityBoundaryError(
        "mcpServerStatus/list",
        "App Server MCP status omitted a configured server"
      );
    }
  }

  private async consumeStdout(child: ChildProcessWithoutNullStreams): Promise<void> {
    const decoder = new CodexJsonlDecoder(
      this.options.maxLineBytes ?? DEFAULT_APP_SERVER_RESOURCE_LIMITS.maxLineBytes
    );
    for await (const chunk of child.stdout) {
      this.stdoutBytes += Buffer.byteLength(chunk);
      const maxStdoutBytes = this.options.maxStdoutBytes ??
        DEFAULT_APP_SERVER_RESOURCE_LIMITS.maxStdoutBytes;
      if (this.stdoutBytes > maxStdoutBytes) {
        throw new Error(`App Server stdout exceeded the ${maxStdoutBytes} byte limit`);
      }
      for (const line of decoder.push(chunk)) {
        await this.dispatchLine(line);
      }
    }
    for (const line of decoder.finish()) {
      await this.dispatchLine(line);
    }
  }

  private async dispatchLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;
    this.messageCount += 1;
    const maxMessages = this.options.maxMessages ?? DEFAULT_APP_SERVER_RESOURCE_LIMITS.maxMessages;
    if (this.messageCount > maxMessages) {
      throw new Error(`App Server exceeded the ${maxMessages} message limit`);
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error("App Server emitted invalid JSON on stdout");
    }
    await this.dispatch(message);
  }

  private async dispatch(message: unknown): Promise<void> {
    if (!isRecord(message)) throw new Error("App Server emitted a non-object JSON-RPC message");
    if ((typeof message.id === "string" || typeof message.id === "number") &&
        ("result" in message || "error" in message) && typeof message.method !== "string") {
      const id = String(message.id);
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if ("error" in message && message.error !== undefined) {
        const rpcError = isRecord(message.error) ? message.error : {};
        pending.reject(new AppServerRpcError(
          pending.method,
          typeof rpcError.code === "number" ? rpcError.code : undefined,
          typeof rpcError.message === "string" ? rpcError.message : "Unknown App Server error",
          rpcError.data
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") {
      throw new Error("App Server emitted a JSON-RPC message without a method or response result");
    }
    if (typeof message.id === "string" || typeof message.id === "number") {
      const task = this.handleServerRequest({
        id: message.id,
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params })
      });
      this.serverRequestTasks.add(task);
      void task
        .catch((error: unknown) => {
          if (this.hostState === "running" || this.hostState === "starting") {
            this.failure = error instanceof Error ? error : new Error(String(error));
            this.terminateChild();
          }
        })
        .finally(() => this.serverRequestTasks.delete(task));
      return;
    }
    await this.options.onNotification?.({
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params })
    });
  }

  private async handleServerRequest(request: AppServerRequest): Promise<void> {
    if (this.networkGuard.isNetworkPermissionRequest(request.method, request.params)) {
      this.networkGuard.denyProviderNetworkRequest(request.method, request.params);
      await this.send({
        id: request.id,
        error: {
          code: -32020,
          message: "AFR hosted policy denies tool network access and network policy amendments"
        }
      });
      return;
    }
    if (request.method === "item/tool/call") {
      await this.handleDynamicToolCall(request);
      return;
    }
    if (this.options.onServerRequest === undefined) {
      await this.send({
        id: request.id,
        error: {
          code: -32601,
          message: `AFR host has no handler for App Server request: ${request.method}`
        }
      });
      return;
    }
    try {
      const result = await this.options.onServerRequest(request, this.serverRequestAbort.signal);
      await this.send({ id: request.id, result: result ?? {} });
    } catch (error) {
      await this.send({
        id: request.id,
        error: {
          code: error instanceof AppServerRequestRejectedError ? error.code : -32000,
          message: error instanceof Error ? error.message : "AFR host rejected the App Server request",
          ...(error instanceof AppServerRequestRejectedError && error.data !== undefined
            ? { data: error.data }
            : {})
        }
      });
    }
  }

  private async handleDynamicToolCall(request: AppServerRequest): Promise<void> {
    const handler = this.options.onDynamicToolCall;
    if (handler === undefined) {
      this.networkGuard.audit({
        source: "provider",
        operation: "item/tool/call",
        decision: "denied",
        evidence: {
          reason: "dynamic_tool_handler_missing",
          request: summarizeDynamicToolRequest(request.params)
        }
      });
      await this.send({
        id: request.id,
        error: { code: -32601, message: "AFR host has no dynamic tool handler" }
      });
      return;
    }
    try {
      const call = requiredDynamicToolCall(request.params);
      const registered = this.options.dynamicTools?.some(({ name }) => name === call.tool) === true;
      if (!registered || call.namespace !== undefined) {
        throw new AppServerRequestRejectedError(
          -32601,
          `AFR host rejected an unregistered dynamic tool: ${call.tool}`
        );
      }
      this.networkGuard.audit({
        source: "provider",
        operation: "item/tool/call",
        decision: "control-allowed",
        evidence: { tool: call.tool, callId: call.callId }
      });
      const result = await handler(call, this.serverRequestAbort.signal);
      await this.send({ id: request.id, result });
    } catch (error) {
      this.networkGuard.audit({
        source: "provider",
        operation: "item/tool/call",
        decision: "denied",
        evidence: {
          reason: "dynamic_tool_request_rejected",
          code: error instanceof AppServerRequestRejectedError ? error.code : -32000,
          request: summarizeDynamicToolRequest(request.params)
        }
      });
      await this.send({
        id: request.id,
        error: {
          code: error instanceof AppServerRequestRejectedError ? error.code : -32000,
          message: error instanceof Error ? error.message : "AFR host rejected the dynamic tool call",
          ...(error instanceof AppServerRequestRejectedError && error.data !== undefined
            ? { data: error.data }
            : {})
        }
      });
    }
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (child === undefined || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error("App Server stdin is not writable");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private terminateChild(): void {
    const child = this.child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (this.forceKillTimer !== undefined) clearTimeout(this.forceKillTimer);
    this.forceKillTimer = setTimeout(
      () => child.kill("SIGKILL"),
      this.options.shutdownGraceMs ?? 1_000
    );
  }

  private async finishExit(exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.serverRequestAbort.abort();
    if (this.runtimeTimer !== undefined) clearTimeout(this.runtimeTimer);
    if (this.forceKillTimer !== undefined) clearTimeout(this.forceKillTimer);
    await this.consumePromise?.catch(() => undefined);
    await this.providerEgressBoundary?.stop().catch(() => undefined);
    this.providerEgressBoundary = undefined;
    const stderrDetail = this.stderrText.trim();
    const failure = this.failure ?? new Error(
      `App Server exited before completing the host lifecycle (${exitCode ?? signal ?? "unknown"})` +
      (stderrDetail.length === 0 ? "" : `: ${stderrDetail}`)
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    const outcome = this.requestedOutcome ?? (exitCode === 0 && this.failure === undefined
      ? "interrupted"
      : "failed");
    this.hostState = outcome === "failed" ? "failed" : "stopped";
    this.resolveExit?.({
      outcome,
      exitCode,
      signal,
      timedOut: this.timedOut,
      stderr: {
        text: this.stderrText,
        byteSize: this.stderrBytes,
        truncated: this.stderrTruncated
      },
      ...(this.failure === undefined ? {} : { errorMessage: this.failure.message })
    });
  }

  private captureStderr(chunk: string): void {
    this.stderrBytes += Buffer.byteLength(chunk);
    this.stderrText = appendBounded(this.stderrText, chunk);
    this.stderrTruncated ||= this.stderrBytes > 16_384;
  }
}

function mapHandshake(value: unknown): AppServerHandshake {
  const record = isRecord(value) ? value : {};
  return {
    raw: value,
    ...(typeof record.userAgent === "string" ? { userAgent: record.userAgent } : {}),
    ...(typeof record.platformFamily === "string" ? { platformFamily: record.platformFamily } : {}),
    ...(typeof record.platformOs === "string" ? { platformOs: record.platformOs } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredNestedId(value: unknown, key: string, method: string): string {
  if (!isRecord(value) || !isRecord(value[key]) || typeof value[key].id !== "string") {
    throw new Error(`App Server response for ${method} did not contain ${key}.id`);
  }
  return value[key].id;
}

function nestedValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function requiredCommandExecResult(value: unknown): Omit<AppServerCommandExecResult, "raw"> {
  if (
    !isRecord(value) ||
    typeof value.exitCode !== "number" ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  ) {
    throw new Error("App Server response for command/exec was invalid");
  }
  return { exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr };
}

function requiredDynamicToolCall(value: unknown): AppServerDynamicToolCall {
  if (
    !isRecord(value) ||
    typeof value.callId !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.tool !== "string" ||
    (value.namespace !== undefined && value.namespace !== null && typeof value.namespace !== "string")
  ) {
    throw new AppServerRequestRejectedError(-32602, "App Server dynamic tool request was invalid");
  }
  return {
    callId: value.callId,
    threadId: value.threadId,
    turnId: value.turnId,
    tool: value.tool,
    ...(typeof value.namespace === "string" ? { namespace: value.namespace } : {}),
    arguments: value.arguments
  };
}

function summarizeDynamicToolRequest(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { shape: "non-object" };
  return {
    shape: "object",
    ...(typeof value.callId === "string" ? { callId: value.callId } : {}),
    ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    ...(typeof value.tool === "string" ? { tool: value.tool } : {}),
    namespaced: value.namespace !== undefined && value.namespace !== null,
    argumentsPresent: value.arguments !== undefined
  };
}

function validateDynamicTools(
  tools: AppServerDynamicToolSpec[] | undefined,
  handler: AppServerSupervisorOptions["onDynamicToolCall"]
): void {
  if ((tools?.length ?? 0) === 0) {
    if (handler !== undefined) throw new Error("Dynamic tool handler requires at least one tool spec");
    return;
  }
  if (handler === undefined) throw new Error("Dynamic tool specs require a dynamic tool handler");
  const names = new Set<string>();
  for (const tool of tools ?? []) {
    if (
      tool.type !== "function" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name) ||
      tool.description.trim().length === 0 ||
      tool.inputSchema === undefined ||
      names.has(tool.name)
    ) {
      throw new Error(`Invalid or duplicate App Server dynamic tool spec: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

function hostedThreadConfig(
  sandbox: HostedSandboxMode,
  mcpServerNames: readonly string[]
): Record<string, unknown> {
  const base = {
    web_search: "disabled",
    shell_environment_policy: { inherit: "core", exclude: [...PROVIDER_PROXY_ENV_KEYS] },
    mcp_servers: Object.fromEntries(
      mcpServerNames.map((name) => [name, { enabled: false }])
    )
  };
  return sandbox === "read-only"
    ? base
    : {
        ...base,
        sandbox_workspace_write: {
          network_access: false,
          writable_roots: [],
          exclude_slash_tmp: true,
          exclude_tmpdir_env_var: true
        }
      };
}

function appendBounded(existing: string, chunk: string, limit = 16_384): string {
  const combined = existing + chunk;
  if (combined.length <= limit) return combined;
  const half = Math.floor(limit / 2);
  return `${combined.slice(0, half)}\n… stderr omitted by App Server host …\n${combined.slice(-half)}`;
}

function assertPositiveLimit(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`${name} must be a positive integer`);
  }
}
