import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalService,
  LocalStore,
  createRunCreatedEvent
} from "@afr/core";
import { afterEach, describe, expect, it } from "vitest";

import { AppServerApprovalBridge } from "./app-server-approval-bridge.js";
import { AppServerRequestRejectedError } from "./app-server-supervisor.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("App Server approval bridge", () => {
  it("consumes a bound grant before accepting an allow-classified read command", async () => {
    const fixture = await createFixture();
    const result = await fixture.bridge.handle(commandRequest("rpc-read", "pwd", [{
      type: "listFiles",
      command: "pwd",
      path: "."
    }]));

    expect(result).toEqual({ decision: "accept" });
    const [request] = fixture.store.listProviderActionRequests(fixture.sessionId);
    expect(request).toMatchObject({
      providerRpcId: "rpc-read",
      status: "accepted",
      actionContext: { sideEffect: "none" }
    });
    expect(fixture.store.getExecutionGrant(request!.grantId!)?.status).toBe("consumed");
    expect(request?.requestBlobHash).toBeUndefined();
    fixture.store.close();
  });

  it("waits for a human once, consumes the approval grant, then returns one-time accept", async () => {
    const fixture = await createFixture();
    const pendingResponse = fixture.bridge.handle(commandRequest("rpc-ask", "node build.mjs", [{
      type: "unknown",
      command: "node build.mjs"
    }]));
    const approval = await waitForApproval(fixture.approvals, fixture.runId);

    fixture.approvals.decide(approval.id, "approved", "local-user");
    await expect(pendingResponse).resolves.toEqual({ decision: "accept" });

    const request = fixture.store.getProviderActionRequestByApproval(approval.id);
    expect(request).toMatchObject({ status: "accepted", approvalId: approval.id });
    expect(fixture.approvals.get(approval.id)?.status).toBe("consumed");
    fixture.store.close();
  });

  it("maps a human denial to Provider decline and never creates a grant", async () => {
    const fixture = await createFixture();
    const pendingResponse = fixture.bridge.handle(commandRequest("rpc-deny", "node deploy.mjs", [{
      type: "unknown",
      command: "node deploy.mjs"
    }]));
    const approval = await waitForApproval(fixture.approvals, fixture.runId);

    fixture.approvals.decide(approval.id, "denied", "local-user", "deployment not authorized");
    await expect(pendingResponse).resolves.toEqual({ decision: "decline" });
    expect(fixture.store.getProviderActionRequestByApproval(approval.id)).toMatchObject({
      status: "declined",
      decisionReason: "deployment not authorized"
    });
    expect(fixture.approvals.get(approval.id)?.grantId).toBeUndefined();
    fixture.store.close();
  });

  it("declines an expired approval instead of returning a late accept", async () => {
    const fixture = await createFixture({ approvalTtlMs: 25 });
    const pendingResponse = fixture.bridge.handle(commandRequest("rpc-expired", "node slow.mjs", [{
      type: "unknown",
      command: "node slow.mjs"
    }]));
    const approval = await waitForApproval(fixture.approvals, fixture.runId);

    fixture.advance(26);
    await expect(pendingResponse).resolves.toEqual({ decision: "decline" });
    expect(fixture.approvals.get(approval.id)?.status).toBe("expired");
    expect(fixture.store.getProviderActionRequestByApproval(approval.id)?.status).toBe("expired");
    fixture.store.close();
  });

  it("fails closed for permission escalation, incomplete v2 file changes, MCP elicitation, and unknown methods", async () => {
    const fixture = await createFixture();

    await expect(fixture.bridge.handle({
      id: "rpc-permission",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-permission",
        startedAtMs: 1,
        cwd: fixture.projectPath,
        permissions: { network: { enabled: true } }
      }
    })).rejects.toMatchObject<Partial<AppServerRequestRejectedError>>({ code: -32010 });

    await expect(fixture.bridge.handle({
      id: "rpc-file",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file",
        startedAtMs: 1
      }
    })).resolves.toEqual({ decision: "decline" });

    await expect(fixture.bridge.handle({
      id: "rpc-mcp",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "fixture-mcp",
        mode: "form",
        message: "Enter a credential",
        requestedSchema: { type: "object" }
      }
    })).resolves.toEqual({ action: "decline" });

    await expect(fixture.bridge.handle({
      id: "rpc-tool",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "fixture",
        tool: "external-write",
        arguments: { target: "outside" }
      }
    })).rejects.toMatchObject<Partial<AppServerRequestRejectedError>>({ code: -32010 });

    await expect(fixture.bridge.handle({
      id: "rpc-future",
      method: "future/unsafeRequest",
      params: {}
    })).rejects.toMatchObject<Partial<AppServerRequestRejectedError>>({ code: -32601 });

    expect(fixture.store.listProviderActionRequests(fixture.sessionId).map(({ status }) => status))
      .toEqual(["rejected", "declined", "declined", "rejected", "rejected"]);
    fixture.store.close();
  });

  it("supports the legacy exact patch response but rejects duplicate RPC ids", async () => {
    const fixture = await createFixture();
    const request = {
      id: "rpc-patch",
      method: "applyPatchApproval",
      params: {
        conversationId: "thread-1",
        callId: "patch-1",
        fileChanges: {
          "src/new.ts": { type: "add", content: "export const value = 1;\n" }
        }
      }
    } as const;

    await expect(fixture.bridge.handle(request)).resolves.toEqual({ decision: "approved" });
    await expect(fixture.bridge.handle(request)).rejects.toMatchObject<Partial<AppServerRequestRejectedError>>({
      code: -32600
    });
    expect(fixture.store.listProviderActionRequests(fixture.sessionId)).toHaveLength(1);
    fixture.store.close();
  });
});

async function createFixture(options: { approvalTtlMs?: number } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "afr-approval-bridge-"));
  directories.push(dataDir);
  const projectPath = join(dataDir, "project");
  let current = new Date("2026-09-05T08:00:00.000Z");
  const now = () => new Date(current);
  const store = new LocalStore(join(dataDir, "data"), now);
  const run = store.createRun({
    projectPath,
    task: "exercise Provider approvals",
    agentId: "codex-app-server"
  });
  store.appendEvents(run.id, [createRunCreatedEvent(run)]);
  store.transitionRun(run.id, "running");
  const { session } = store.createProviderSession({
    runId: run.id,
    provider: "openai-codex",
    adapterVersion: "fixture",
    runtimeVersion: "codex-cli 0.151.0-alpha.7.2",
    protocolVersion: "app-server-experimental",
    mode: "hosted-observed",
    capabilities: {
      approvalBridge: { state: "supported", source: "fixture", version: "1" }
    }
  });
  const approvals = new ApprovalService(store, {
    dataDir: join(dataDir, "data"),
    homeDir: join(dataDir, "home"),
    protectedPaths: ["protected"],
    now,
    ...(options.approvalTtlMs === undefined ? {} : { approvalTtlMs: options.approvalTtlMs })
  });
  const bridge = new AppServerApprovalBridge({
    runId: run.id,
    providerSessionId: session.id,
    approvals,
    store,
    approvalWaitTimeoutMs: 2_000,
    pollIntervalMs: 5,
    now
  });
  return {
    approvals,
    bridge,
    projectPath,
    runId: run.id,
    sessionId: session.id,
    store,
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    }
  };
}

function commandRequest(id: string, command: string, commandActions: unknown[]) {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: `item-${id}`,
      startedAtMs: 1,
      command,
      commandActions,
      cwd: undefined,
      availableDecisions: ["accept", "decline", "cancel"]
    }
  };
}

async function waitForApproval(approvals: ApprovalService, runId: string) {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    const approval = approvals.list({ runId, status: "pending" })[0];
    if (approval !== undefined) return approval;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Provider approval");
}
