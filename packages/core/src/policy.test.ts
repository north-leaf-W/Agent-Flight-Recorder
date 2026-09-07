import type { ActionContext } from "@afr/protocol";
import { describe, expect, it } from "vitest";

import { evaluateAction } from "./policy.js";

const config = {
  projectRoot: "/Users/demo/project",
  afrDataDir: "/Users/demo/.afr",
  homeDir: "/Users/demo",
  protectedPaths: ["protected"],
  networkReadAllowlist: ["api.example.com", "*.docs.example.com"]
};

function action(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    runId: "018f5e2a-1b2c-7d4e-8f90-123456789abd",
    actor: { id: "fixture-agent", type: "agent" },
    tool: "file",
    action: "read",
    cwd: config.projectRoot,
    targets: [{ type: "file", canonicalId: "README.md" }],
    environment: "local",
    sideEffect: "none",
    recoverability: "easy",
    ...overrides
  };
}

describe("built-in safety policy", () => {
  it("allows read-only actions and recoverable project writes", () => {
    expect(evaluateAction(action(), config)).toMatchObject({ effect: "allow", riskLevel: "R0" });
    expect(
      evaluateAction(action({ action: "write", sideEffect: "local-write" }), config)
    ).toMatchObject({ effect: "allow", riskLevel: "R1" });
  });

  it("asks before a normal delete and elevates a protected delete", () => {
    expect(
      evaluateAction(action({ action: "delete", sideEffect: "irreversible" }), config)
    ).toMatchObject({ effect: "ask", riskLevel: "R3", ruleId: "approve-delete" });
    expect(
      evaluateAction(
        action({
          action: "delete",
          sideEffect: "irreversible",
          targets: [{ type: "file", canonicalId: "protected/important.txt" }]
        }),
        config
      )
    ).toMatchObject({
      effect: "ask",
      riskLevel: "R4",
      ruleId: "approve-protected-delete",
      canonicalTargets: [
        { type: "file", canonicalId: "/Users/demo/project/protected/important.txt" }
      ]
    });
  });

  it.each([
    ["project root", "/Users/demo/project", "deny-root-delete"],
    ["home directory", "/Users/demo", "deny-root-delete"],
    ["outside project", "/Users/demo/other/file.txt", "deny-cross-boundary-delete"],
    ["AFR data", "/Users/demo/.afr/afr.sqlite", "protect-afr-data"]
  ])("denies deletion of %s", (_label, target, ruleId) => {
    expect(
      evaluateAction(
        action({
          action: "delete",
          sideEffect: "irreversible",
          targets: [{ type: "file", canonicalId: target }]
        }),
        config
      )
    ).toMatchObject({ effect: "deny", riskLevel: "R4", ruleId });
  });

  it("denies an unresolved delete and policy self-modification", () => {
    expect(
      evaluateAction(
        action({ action: "delete", sideEffect: "irreversible", targets: [] }),
        config
      )
    ).toMatchObject({ effect: "deny", ruleId: "deny-unresolved-delete" });
    expect(
      evaluateAction(
        action({ tool: "afr.policy", action: "update", sideEffect: "local-write" }),
        config
      )
    ).toMatchObject({ effect: "deny", ruleId: "protect-policy" });
  });

  it("asks before external writes and production actions", () => {
    expect(
      evaluateAction(
        action({ tool: "email.send", action: "send", targets: [], sideEffect: "external-write" }),
        config
      )
    ).toMatchObject({ effect: "ask", riskLevel: "R3" });
    expect(
      evaluateAction(action({ environment: "production", targets: [] }), config)
    ).toMatchObject({ effect: "ask", riskLevel: "R3" });
  });

  it("allows only GET/HEAD network.read actions to explicitly allowlisted hosts", () => {
    const networkAction = (target: string, method = "get") => action({
      tool: "network.read",
      action: method,
      argv: [method.toUpperCase()],
      targets: [{ type: "network", canonicalId: target }],
      sideEffect: "none"
    });
    expect(evaluateAction(networkAction("https://api.example.com/"), config)).toMatchObject({
      effect: "allow",
      riskLevel: "R1",
      ruleId: "allow-read-only-network-gateway"
    });
    expect(evaluateAction(networkAction("https://guide.docs.example.com/", "head"), config))
      .toMatchObject({ effect: "allow", ruleId: "allow-read-only-network-gateway" });
    expect(evaluateAction(networkAction("https://docs.example.com/"), config)).toMatchObject({
      effect: "deny",
      ruleId: "deny-network-target-not-allowlisted"
    });
    expect(evaluateAction(networkAction("https://api.example.com/", "post"), config)).toMatchObject({
      effect: "deny",
      ruleId: "deny-network-write-method"
    });
    expect(evaluateAction(networkAction("https://api.example.com:8443/"), config)).toMatchObject({
      effect: "deny",
      ruleId: "deny-network-target-not-allowlisted"
    });
  });

  it("continues to deny network targets outside the typed read Gateway", () => {
    expect(evaluateAction(action({
      tool: "shell",
      action: "curl",
      targets: [{ type: "network", canonicalId: "https://api.example.com/" }]
    }), config)).toMatchObject({
      effect: "deny",
      ruleId: "deny-unmediated-network"
    });
  });
});
