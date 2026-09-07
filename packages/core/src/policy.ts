import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { domainToASCII } from "node:url";

import type { ActionContext } from "@afr/protocol";

export type PolicyDecision = {
  effect: "allow" | "ask" | "deny";
  riskLevel: "R0" | "R1" | "R2" | "R3" | "R4";
  policyId: "builtin-safety";
  ruleId: string;
  reasonCodes: string[];
  canonicalTargets: Array<{ type: string; canonicalId: string }>;
};

export type PolicyConfig = {
  projectRoot: string;
  afrDataDir: string;
  homeDir: string;
  protectedPaths?: string[];
  networkReadAllowlist?: string[];
  networkReadAllowedPorts?: number[];
};

export function evaluateAction(context: ActionContext, config: PolicyConfig): PolicyDecision {
  const projectRoot = canonicalRoot(config.projectRoot);
  const afrDataDir = canonicalRoot(config.afrDataDir);
  const homeDir = canonicalRoot(config.homeDir);
  const protectedPaths = (config.protectedPaths ?? []).map((path) =>
    canonicalRoot(resolve(projectRoot, path))
  );
  const canonicalTargets = context.targets.map((target) => ({
    type: target.type,
    canonicalId:
      target.type === "file"
        ? resolve(context.cwd ?? projectRoot, target.canonicalId)
        : target.canonicalId
  }));
  const fileTargets = canonicalTargets.filter((target) => target.type === "file");
  const base = { policyId: "builtin-safety" as const, canonicalTargets };

  if (context.tool === "codex.permissions") {
    return {
      ...base,
      effect: "deny",
      riskLevel: "R4",
      ruleId: "deny-hosted-permission-escalation",
      reasonCodes: ["permission_escalation_unsupported"]
    };
  }

  if (context.tool === "patch.promotion") {
    const deleting = context.action === "delete";
    return {
      ...base,
      effect: "ask",
      riskLevel: deleting ? "R4" : "R3",
      ruleId: deleting ? "approve-source-promotion-delete" : "approve-source-promotion",
      reasonCodes: deleting
        ? ["source_workspace_write", "delete"]
        : ["source_workspace_write", "patch_promotion"]
    };
  }

  if (context.tool === "codex.mcp") {
    return {
      ...base,
      effect: "deny",
      riskLevel: "R3",
      ruleId: context.action === "elicitation" ? "deny-mcp-elicitation" : "deny-unmanaged-mcp-tool",
      reasonCodes: [
        context.action === "elicitation"
          ? "mcp_elicitation_not_action_approval"
          : "managed_mcp_gateway_unavailable"
      ]
    };
  }

  if (canonicalTargets.some((target) => target.type === "network")) {
    const networkDecision = evaluateNetworkRead(context, canonicalTargets, config);
    if (networkDecision !== undefined) return { ...base, ...networkDecision };
    return {
      ...base,
      effect: "deny",
      riskLevel: "R4",
      ruleId: "deny-unmediated-network",
      reasonCodes: ["network_mediation_unavailable"]
    };
  }

  if (context.tool === "codex.file-change" && context.action === "unresolved") {
    return {
      ...base,
      effect: "deny",
      riskLevel: "R4",
      ruleId: "deny-unresolved-file-change",
      reasonCodes: ["file_change_parameters_missing"]
    };
  }

  if (targetsPath(canonicalTargets, afrDataDir)) {
    return {
      ...base,
      effect: "deny",
      riskLevel: "R4",
      ruleId: "protect-afr-data",
      reasonCodes: ["afr_data_protected"]
    };
  }

  if (isPolicyMutation(context)) {
    return {
      ...base,
      effect: "deny",
      riskLevel: "R4",
      ruleId: "protect-policy",
      reasonCodes: ["policy_self_modification"]
    };
  }

  if (context.action === "delete") {
    if (fileTargets.length === 0) {
      return {
        ...base,
        effect: "deny",
        riskLevel: "R4",
        ruleId: "deny-unresolved-delete",
        reasonCodes: ["delete_target_unresolved"]
      };
    }
    if (
      fileTargets.some(
        (target) =>
          target.canonicalId === projectRoot ||
          target.canonicalId === homeDir ||
          target.canonicalId === resolve(homeDir, "..")
      )
    ) {
      return {
        ...base,
        effect: "deny",
        riskLevel: "R4",
        ruleId: "deny-root-delete",
        reasonCodes: ["root_delete"]
      };
    }
    if (fileTargets.some((target) => !isWithin(target.canonicalId, projectRoot))) {
      return {
        ...base,
        effect: "deny",
        riskLevel: "R4",
        ruleId: "deny-cross-boundary-delete",
        reasonCodes: ["target_outside_project"]
      };
    }
    if (fileTargets.some((target) => protectedPaths.some((path) => isWithin(target.canonicalId, path)))) {
      return {
        ...base,
        effect: "ask",
        riskLevel: "R4",
        ruleId: "approve-protected-delete",
        reasonCodes: ["protected_path", "delete"]
      };
    }
    return {
      ...base,
      effect: "ask",
      riskLevel: "R3",
      ruleId: "approve-delete",
      reasonCodes: ["delete"]
    };
  }

  if (fileTargets.some((target) => !isWithin(target.canonicalId, projectRoot))) {
    return {
      ...base,
      effect: "deny",
      riskLevel: "R4",
      ruleId: "deny-cross-boundary-file-action",
      reasonCodes: ["target_outside_project"]
    };
  }

  if (context.sideEffect === "irreversible") {
    return {
      ...base,
      effect: "ask",
      riskLevel: "R4",
      ruleId: "approve-irreversible",
      reasonCodes: ["irreversible_side_effect"]
    };
  }

  if (context.sideEffect === "external-write" || context.environment === "production") {
    return {
      ...base,
      effect: "ask",
      riskLevel: "R3",
      ruleId: "approve-external-write",
      reasonCodes: [
        context.sideEffect === "external-write" ? "external_write" : "production_environment"
      ]
    };
  }

  if (context.sideEffect === "local-write") {
    const protectedWrite = fileTargets.some((target) =>
      protectedPaths.some((path) => isWithin(target.canonicalId, path))
    );
    return protectedWrite
      ? {
          ...base,
          effect: "ask",
          riskLevel: "R3",
          ruleId: "approve-protected-write",
          reasonCodes: ["protected_path", "local_write"]
        }
      : {
          ...base,
          effect: "allow",
          riskLevel: "R1",
          ruleId: "allow-project-write",
          reasonCodes: ["recoverable_local_write"]
        };
  }

  return {
    ...base,
    effect: "allow",
    riskLevel: "R0",
    ruleId: "allow-read-only",
    reasonCodes: ["no_side_effect"]
  };
}

function evaluateNetworkRead(
  context: ActionContext,
  canonicalTargets: PolicyDecision["canonicalTargets"],
  config: PolicyConfig
): Omit<PolicyDecision, "policyId" | "canonicalTargets"> | undefined {
  if (context.tool.trim().toLowerCase() !== "network.read") return undefined;
  const method = context.action.trim().toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return {
      effect: "deny",
      riskLevel: "R4",
      ruleId: "deny-network-write-method",
      reasonCodes: ["network_method_not_read_only"]
    };
  }
  if (context.sideEffect !== "none") {
    return {
      effect: "deny",
      riskLevel: "R4",
      ruleId: "deny-network-side-effect",
      reasonCodes: ["network_read_declares_side_effect"]
    };
  }
  const targets = canonicalTargets.filter((target) => target.type === "network");
  if (targets.length !== 1 || canonicalTargets.length !== 1) {
    return {
      effect: "deny",
      riskLevel: "R4",
      ruleId: "deny-ambiguous-network-target",
      reasonCodes: ["network_target_must_be_exact"]
    };
  }
  const target = parsePolicyNetworkTarget(targets[0]?.canonicalId ?? "");
  if (target === undefined) {
    return {
      effect: "deny",
      riskLevel: "R4",
      ruleId: "deny-invalid-network-target",
      reasonCodes: ["network_target_invalid"]
    };
  }
  const allowedPorts = new Set(config.networkReadAllowedPorts ?? [80, 443]);
  if (
    !allowedPorts.has(target.port) ||
    !isNetworkHostAllowed(target.hostname, config.networkReadAllowlist ?? [])
  ) {
    return {
      effect: "deny",
      riskLevel: "R4",
      ruleId: "deny-network-target-not-allowlisted",
      reasonCodes: ["network_target_not_allowlisted"]
    };
  }
  return {
    effect: "allow",
    riskLevel: "R1",
    ruleId: "allow-read-only-network-gateway",
    reasonCodes: ["read_only_network_gateway", "network_target_allowlisted"]
  };
}

function parsePolicyNetworkTarget(value: string): { hostname: string; port: number } | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return {
      hostname: normalizeNetworkHostname(url.hostname),
      port: url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80
    };
  } catch {
    return undefined;
  }
}

export function isNetworkHostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  const candidate = normalizeNetworkHostname(hostname);
  if (candidate.length === 0) return false;
  return allowlist.some((rawRule) => {
    const rule = normalizeNetworkHostRule(rawRule);
    if (rule === undefined) return false;
    if (!rule.wildcard) return candidate === rule.hostname;
    return candidate !== rule.hostname && candidate.endsWith(`.${rule.hostname}`);
  });
}

export function normalizeNetworkHostRule(
  rawRule: string
): { hostname: string; wildcard: boolean } | undefined {
  const trimmed = rawRule.trim().toLowerCase();
  const wildcard = trimmed.startsWith("*.");
  const rawHostname = wildcard ? trimmed.slice(2) : trimmed;
  if (
    rawHostname.length === 0 ||
    rawHostname.includes("/") ||
    rawHostname.includes("@") ||
    rawHostname.includes("?") ||
    rawHostname.includes("#") ||
    rawHostname.includes("*")
  ) {
    return undefined;
  }
  const hostname = normalizeNetworkHostname(rawHostname);
  if (hostname.length === 0 || (wildcard && hostname.includes(":"))) return undefined;
  return { hostname, wildcard };
}

export function normalizeNetworkHostname(hostname: string): string {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const withoutTrailingDot = unwrapped.toLowerCase().replace(/\.+$/, "");
  return domainToASCII(withoutTrailingDot) || withoutTrailingDot;
}

function canonicalRoot(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function targetsPath(
  targets: Array<{ type: string; canonicalId: string }>,
  protectedRoot: string
): boolean {
  return targets.some(
    (target) => target.type === "file" && isWithin(target.canonicalId, protectedRoot)
  );
}

function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isPolicyMutation(context: ActionContext): boolean {
  const normalized = `${context.tool}:${context.action}`.toLowerCase();
  return normalized.includes("policy") && context.sideEffect !== "none";
}
