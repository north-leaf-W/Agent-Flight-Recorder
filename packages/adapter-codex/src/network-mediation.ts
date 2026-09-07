import { relative, resolve } from "node:path";

export type HostedSandboxMode = "read-only" | "workspace-write";

export type HostedSandboxPolicy =
  | { type: "readOnly"; networkAccess: false }
  | {
      type: "workspaceWrite";
      networkAccess: false;
      writableRoots: string[];
      excludeSlashTmp: boolean;
      excludeTmpdirEnvVar: boolean;
    };

export type NetworkMediationAuditEvent = {
  source: "host" | "provider" | "runtime" | "observer";
  operation: string;
  decision: "control-allowed" | "sandbox-enforced" | "denied" | "observed" | "degraded";
  requestedPolicy?: unknown;
  effectivePolicy?: unknown;
  evidence?: unknown;
};

export type HostedNetworkGuardOptions = {
  onAudit?: (event: NetworkMediationAuditEvent) => void;
};

export const PROVIDER_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
] as const;

const SAFE_CLIENT_REQUESTS = new Set([
  "initialize",
  "config/read",
  "mcpServerStatus/list",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
  "command/exec"
]);

export class AppServerSecurityBoundaryError extends Error {
  constructor(readonly method: string, message: string) {
    super(message);
    this.name = "AppServerSecurityBoundaryError";
  }
}

export class HostedNetworkGuard {
  constructor(private readonly options: HostedNetworkGuardOptions = {}) {}

  audit(event: NetworkMediationAuditEvent): void {
    this.options.onAudit?.(event);
  }

  assertClientRequestAllowed(method: string): void {
    if (SAFE_CLIENT_REQUESTS.has(method)) return;
    this.audit({
      source: "host",
      operation: method,
      decision: "denied",
      evidence: { reason: "client_method_not_allowlisted" }
    });
    throw new AppServerSecurityBoundaryError(
      method,
      `App Server client method is outside the AFR hosted allowlist: ${method}`
    );
  }

  sandboxPolicy(mode: HostedSandboxMode, writableRoot?: string): HostedSandboxPolicy {
    if (mode !== "read-only" && mode !== "workspace-write") {
      this.audit({
        source: "host",
        operation: "sandboxPolicy",
        decision: "denied",
        requestedPolicy: { mode },
        evidence: { reason: "unsafe_sandbox_mode" }
      });
      throw new AppServerSecurityBoundaryError(
        "sandboxPolicy",
        `AFR hosted mode does not allow sandbox mode: ${String(mode)}`
      );
    }
    if (mode === "read-only") return { type: "readOnly", networkAccess: false };
    if (writableRoot === undefined) {
      throw new AppServerSecurityBoundaryError(
        "sandboxPolicy",
        "workspace-write sandbox requires an explicit writable root"
      );
    }
    return {
      type: "workspaceWrite",
      networkAccess: false,
      writableRoots: [writableRoot],
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true
    };
  }

  assertRuntimeSandbox(
    operation: string,
    expectedMode: HostedSandboxMode,
    runtimePolicy: unknown,
    writableRoot?: string
  ): void {
    const expectedType = expectedMode === "read-only" ? "readOnly" : "workspaceWrite";
    if (!isRecord(runtimePolicy) || runtimePolicy.type !== expectedType) {
      this.audit({
        source: "runtime",
        operation,
        decision: "denied",
        requestedPolicy: { mode: expectedMode, networkAccess: false },
        effectivePolicy: runtimePolicy,
        evidence: { reason: "runtime_sandbox_type_mismatch" }
      });
      throw new AppServerSecurityBoundaryError(
        operation,
        `App Server returned an unexpected sandbox policy for ${operation}`
      );
    }
    if (runtimePolicy.networkAccess === true || runtimePolicy.networkAccess === "enabled") {
      this.audit({
        source: "runtime",
        operation,
        decision: "denied",
        effectivePolicy: runtimePolicy,
        evidence: { reason: "runtime_network_access_enabled" }
      });
      throw new AppServerSecurityBoundaryError(
        operation,
        `App Server enabled tool network access for ${operation}`
      );
    }
    if (expectedMode === "workspace-write") {
      const roots = runtimePolicy.writableRoots;
      const hasUnsafeRoot = roots !== undefined && (
        !Array.isArray(roots) ||
        roots.some((root) => typeof root !== "string" || !isWithin(writableRoot, root))
      );
      if (
        writableRoot === undefined ||
        hasUnsafeRoot ||
        runtimePolicy.excludeSlashTmp !== true ||
        runtimePolicy.excludeTmpdirEnvVar !== true
      ) {
        this.audit({
          source: "runtime",
          operation,
          decision: "denied",
          effectivePolicy: runtimePolicy,
          evidence: { reason: "runtime_workspace_write_scope_too_broad" }
        });
        throw new AppServerSecurityBoundaryError(
          operation,
          `App Server returned an unsafe workspace-write policy for ${operation}`
        );
      }
    }
    this.audit({
      source: "runtime",
      operation,
      decision: "observed",
      effectivePolicy: runtimePolicy,
      evidence: {
        networkAccess: runtimePolicy.networkAccess ?? false,
        source: runtimePolicy.networkAccess === undefined ? "schema-default" : "runtime-response"
      }
    });
  }

  isNetworkPermissionRequest(method: string, params: unknown): boolean {
    if (!isRecord(params)) return false;
    if (params.networkApprovalContext !== undefined && params.networkApprovalContext !== null) return true;
    if (hasNonEmptyField(params, "proposedNetworkPolicyAmendments")) return true;
    if (containsNetworkPermission(params.additionalPermissions)) return true;
    if (method === "item/permissions/requestApproval") {
      return containsNetworkPermission(params.permissions) || containsNetworkPermission(params);
    }
    return false;
  }

  denyProviderNetworkRequest(method: string, params: unknown): void {
    this.audit({
      source: "provider",
      operation: method,
      decision: "denied",
      evidence: {
        reason: "tool_network_is_disabled",
        requestShape: summarizeNetworkRequest(params)
      }
    });
  }

  inspectHostedConfiguration(operation: string, response: unknown): string[] {
    const config = isRecord(response) && isRecord(response.config) ? response.config : undefined;
    const features = config !== undefined && isRecord(config.features) ? config.features : undefined;
    const mcpServers = config !== undefined && isRecord(config.mcp_servers)
      ? config.mcp_servers
      : undefined;
    const requiredDisabledFeatures = [
      "apps",
      "browser_use",
      "browser_use_external",
      "computer_use",
      "image_generation",
      "in_app_browser",
      "plugins",
      "remote_plugin",
      "skill_mcp_dependency_install"
    ];
    const mcpServerNames = mcpServers === undefined
      ? []
      : Object.keys(mcpServers).filter((name) => name.length > 0).sort();
    const unsafeFeatures = features === undefined
      ? ["<unverifiable>"]
      : requiredDisabledFeatures.filter((name) => features[name] !== false);
    const safe = config !== undefined && mcpServers !== undefined &&
      config.web_search === "disabled" && unsafeFeatures.length === 0 &&
      mcpServerNames.length === Object.keys(mcpServers ?? {}).length;
    if (!safe) {
      this.audit({
        source: "runtime",
        operation,
        decision: "denied",
        evidence: {
          reason: "hosted_external_tools_not_disabled",
          webSearchDisabled: config?.web_search === "disabled",
          configuredMcpServerCount: mcpServers === undefined ? null : Object.keys(mcpServers).length,
          unsafeFeatures
        }
      });
      throw new AppServerSecurityBoundaryError(
        operation,
        "App Server configuration contains unverifiable external-tool settings"
      );
    }
    this.audit({
      source: "runtime",
      operation,
      decision: "control-allowed",
      effectivePolicy: {
        webSearch: "disabled",
        externalFeatures: "disabled",
        mcpServers: "disabled-per-thread"
      },
      evidence: {
        configuredMcpServerCount: Object.keys(mcpServers ?? {}).length,
        perThreadDisableRequired: mcpServerNames.length > 0
      }
    });
    return mcpServerNames;
  }

  assertProxyEnvironmentExcluded(operation: string, response: unknown): void {
    const config = isRecord(response) && isRecord(response.config) ? response.config : undefined;
    const policy = config !== undefined && isRecord(config.shell_environment_policy)
      ? config.shell_environment_policy
      : undefined;
    const exclude = policy !== undefined && Array.isArray(policy.exclude)
      ? policy.exclude.filter((value): value is string => typeof value === "string")
      : [];
    const missing = PROVIDER_PROXY_ENV_KEYS.filter((name) => !exclude.includes(name));
    if (missing.length > 0) {
      this.audit({
        source: "runtime",
        operation,
        decision: "denied",
        evidence: { reason: "provider_proxy_environment_not_excluded", missing }
      });
      throw new AppServerSecurityBoundaryError(
        operation,
        "App Server did not exclude Provider proxy credentials from tool environments"
      );
    }
    this.audit({
      source: "runtime",
      operation,
      decision: "control-allowed",
      effectivePolicy: { providerProxyEnvironment: "excluded-from-tools" },
      evidence: { excludedVariableCount: PROVIDER_PROXY_ENV_KEYS.length }
    });
  }

  assertMcpRuntimeDisabled(
    operation: string,
    response: unknown
  ): { names: string[]; nextCursor?: string } {
    const data = isRecord(response) && Array.isArray(response.data) ? response.data : undefined;
    const statuses = data?.map((value) => isRecord(value) ? value : undefined);
    const invalid = statuses === undefined || statuses.some((value) =>
      value === undefined || typeof value.name !== "string" || value.runtimeStatus !== "disabled"
    );
    if (invalid) {
      this.audit({
        source: "runtime",
        operation,
        decision: "denied",
        evidence: {
          reason: "mcp_runtime_not_disabled",
          statusCount: statuses?.length ?? null,
          activeStatusCount: statuses?.filter((value) => value?.runtimeStatus !== "disabled").length ?? null
        }
      });
      throw new AppServerSecurityBoundaryError(
        operation,
        "App Server did not prove that every MCP runtime is disabled"
      );
    }
    const nextCursor = isRecord(response) && typeof response.nextCursor === "string"
      ? response.nextCursor
      : undefined;
    const names = statuses.map((value) => String(value?.name));
    this.audit({
      source: "runtime",
      operation,
      decision: "control-allowed",
      evidence: { disabledMcpServerCount: names.length }
    });
    return { names, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }
}

function isWithin(root: string | undefined, candidate: string): boolean {
  if (root === undefined) return false;
  const canonicalRoot = resolve(root);
  const canonicalCandidate = resolve(candidate);
  const child = relative(canonicalRoot, canonicalCandidate);
  return child === "" || (!child.startsWith("..") && !child.includes("/../"));
}

function summarizeNetworkRequest(value: unknown): Record<string, boolean> {
  const params = isRecord(value) ? value : {};
  return {
    networkApprovalContext:
      params.networkApprovalContext !== undefined && params.networkApprovalContext !== null,
    proposedNetworkPolicyAmendments: hasNonEmptyField(params, "proposedNetworkPolicyAmendments"),
    additionalNetworkPermissions: containsNetworkPermission(params.additionalPermissions),
    permissionRequestContainsNetwork: containsNetworkPermission(params.permissions)
  };
}

function hasNonEmptyField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function containsNetworkPermission(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string") return value.toLowerCase().includes("network");
  if (Array.isArray(value)) return value.some((item) => containsNetworkPermission(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    key.toLowerCase().includes("network") || containsNetworkPermission(nested, depth + 1)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
