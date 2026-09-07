import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EVENT_SCHEMA_VERSION, type ActionContext } from "@afr/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  HostedWorkspaceManager,
  type NetworkGatewayTransport,
  type ReplayExecutionRequest,
  type ReplayExecutionResult,
  type ReplayExecutor
} from "@afr/core";

import { buildServer, type BuildServerOptions } from "./server.js";

const directories: string[] = [];

async function testServer(options: Partial<BuildServerOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "afr-server-test-"));
  directories.push(dataDir);
  return buildServer({ dataDir, webRoot: false, ...options });
}

class DirectReplayExecutor implements ReplayExecutor {
  execute(request: ReplayExecutionRequest): ReplayExecutionResult {
    const started = performance.now();
    const result = spawnSync(request.command[0], request.command.slice(1), {
      cwd: request.worktreePath,
      encoding: "utf8",
      timeout: request.timeoutMs,
      shell: false
    });
    return {
      exitCode: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: Math.round(performance.now() - started)
    };
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function replayFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "afr-server-replay-project-"));
  directories.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "afr@example.invalid");
  git(root, "config", "user.name", "AFR Test");
  writeFileSync(join(root, "ORIGINAL_MARKER.txt"), "original\n");
  writeFileSync(join(root, "dependency.txt"), "wrong\n");
  writeFileSync(
    join(root, "replay-agent.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync("dependency.txt", process.argv[2] + "\\n");
writeFileSync("TEST_RESULT.txt", "passed\\n");
console.log("tests passed");
`
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

async function createRun(app: Awaited<ReturnType<typeof buildServer>>["app"], token: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/runs",
    headers: { authorization: `Bearer ${token}` },
    payload: { projectPath: "/tmp/demo", task: "demo", agentId: "fixture" }
  });
  return response.json().run.id as string;
}

function protectedDelete(runId: string): ActionContext {
  return {
    runId,
    actor: { id: "fixture", type: "agent" },
    tool: "file",
    action: "delete",
    argv: ["rm", "protected/important.txt"],
    cwd: "/tmp/demo",
    targets: [{ type: "file", canonicalId: "protected/important.txt" }],
    environment: "local",
    sideEffect: "irreversible",
    recoverability: "partial"
  };
}

async function humanCookie(app: Awaited<ReturnType<typeof buildServer>>["app"], runId: string) {
  const navigation = await app.inject({
    method: "GET",
    url: `/runs/${runId}`,
    headers: {
      "sec-fetch-mode": "navigate",
      "sec-fetch-user": "?1",
      "sec-fetch-dest": "document"
    }
  });
  return String(navigation.headers["set-cookie"]).split(";")[0];
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("AFR HTTP API", () => {
  it("requires the local token for writes and never returns it in metadata", async () => {
    const { app, token, tokenPath } = await testServer();
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: { projectPath: "/tmp/demo", task: "demo", agentId: "fixture" }
    });
    expect(denied.statusCode).toBe(401);

    const metadata = await app.inject({ method: "GET", url: "/api/v1/meta" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.body).not.toContain(token);
    expect(metadata.json().startup).toMatchObject({
      quickCheck: "ok",
      schemaVersion: "0009_network_mediation",
      appliedMigrations: [
        "0001_initial",
        "0002_approvals",
        "0003_gateway",
        "0004_replay",
        "0005_provider_sessions",
        "0006_hosted_workspaces_provider_events",
        "0007_provider_action_requests",
        "0008_patch_promotions",
        "0009_network_mediation"
      ]
    });
    expect((await readFile(tokenPath, "utf8")).trim()).toBe(token);
    await app.close();
  });

  it("creates a running Run and exposes its immutable timeline", async () => {
    const { app, token } = await testServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPath: "/tmp/demo", task: "demo", agentId: "fixture" }
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id as string;
    expect(created.json().run.status).toBe("running");

    const timeline = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/events`
    });
    expect(timeline.json().events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "run.created",
      "run.status_changed"
    ]);
    const steps = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/steps` });
    expect(steps.statusCode).toBe(200);
    expect(steps.json().steps).toHaveLength(2);
    const runs = await app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(runs.json().runs[0]).toMatchObject({
      id: runId,
      eventCount: 2,
      commandCount: 0,
      fileChangeCount: 0,
      gapCount: 0,
      highRiskCount: 0,
      pendingApprovalCount: 0,
      validationStatus: "unverified"
    });
    await app.close();
  });

  it("issues a scoped Provider session token and exposes only session metadata", async () => {
    const { app, token, store, approvals } = await testServer();
    const runId = await createRun(app, token);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/provider-sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        runId,
        provider: "openai-codex",
        adapterVersion: "0.1.0-demo.0",
        runtimeVersion: "codex-cli fixture",
        protocolVersion: "app-server-v2",
        mode: "hosted-observed",
        capabilities: {
          eventStream: { state: "supported", source: "local-schema", version: "fixture" }
        }
      }
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().session.id as string;
    const controlToken = created.json().controlToken as string;
    expect(controlToken).toBeTruthy();

    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/provider-sessions/${sessionId}/status`,
      headers: { authorization: "Bearer wrong" },
      payload: { status: "starting" }
    });
    expect(denied.statusCode).toBe(401);

    const starting = await app.inject({
      method: "POST",
      url: `/api/v1/provider-sessions/${sessionId}/status`,
      headers: { authorization: `Bearer ${controlToken}` },
      payload: { status: "starting", processId: 4321 }
    });
    expect(starting.statusCode).toBe(200);
    expect(starting.json().session).toMatchObject({ status: "starting", processId: 4321 });

    const running = await app.inject({
      method: "POST",
      url: `/api/v1/provider-sessions/${sessionId}/status`,
      headers: { authorization: `Bearer ${controlToken}` },
      payload: { status: "running", externalSessionId: "thread-fixture" }
    });
    expect(running.statusCode).toBe(200);
    expect(running.json().session).toMatchObject({
      status: "running",
      externalSessionId: "thread-fixture"
    });

    const session = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/session` });
    expect(session.statusCode).toBe(200);
    expect(session.body).not.toContain(controlToken);

    store.recordProviderEvent({
      sessionId,
      method: "thread/started",
      raw: { method: "thread/started", params: { thread: { id: "thread-fixture" } } },
      parseStatus: "mapped",
      providerEventId: "thread-fixture",
      providerThreadId: "thread-fixture",
      normalizedEvent: {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: "018f5e2a-1b2c-7d4e-8f90-123456789a91",
        runId,
        idempotencyKey: "server-provider-event",
        occurredAt: "2026-09-05T07:20:00.000Z",
        actor: { type: "agent", id: "codex-app-server" },
        eventType: "agent.session_started",
        status: "success",
        payload: { providerThreadId: "thread-fixture" }
      }
    });
    const providerEvents = await app.inject({
      method: "GET",
      url: `/api/v1/provider-sessions/${sessionId}/events`
    });
    expect(providerEvents.statusCode).toBe(200);
    expect(providerEvents.json().providerEvents[0]).toMatchObject({
      arrivalSequence: 1,
      providerMethod: "thread/started",
      parseStatus: "mapped"
    });
    const actionRequest = store.createProviderActionRequest({
      sessionId,
      rpcId: "rpc-fixture",
      method: "future/request",
      request: { id: "rpc-fixture", method: "future/request", params: {} },
      status: "rejected",
      decisionReason: "unsupported request"
    });
    const actionRequests = await app.inject({
      method: "GET",
      url: `/api/v1/provider-sessions/${sessionId}/action-requests`
    });
    expect(actionRequests.statusCode).toBe(200);
    expect(actionRequests.json().actionRequests[0]).toMatchObject({
      id: actionRequest.id,
      providerRpcId: "rpc-fixture",
      status: "rejected"
    });
    const actionRequestDetail = await app.inject({
      method: "GET",
      url: `/api/v1/provider-action-requests/${actionRequest.id}?waitMs=5`
    });
    expect(actionRequestDetail.statusCode).toBe(200);
    expect(actionRequestDetail.json().actionRequest.id).toBe(actionRequest.id);
    const networkRecord = store.recordNetworkMediation({
      sessionId,
      source: "host",
      operation: "turn/start",
      decision: "sandbox-enforced",
      requestedPolicy: { type: "readOnly", networkAccess: false },
      effectivePolicy: { type: "readOnly", networkAccess: false }
    });
    const networkMediation = await app.inject({
      method: "GET",
      url: `/api/v1/provider-sessions/${sessionId}/network-mediation`
    });
    expect(networkMediation.statusCode).toBe(200);
    expect(networkMediation.json().networkMediation[0]).toMatchObject({
      id: networkRecord.id,
      sequenceNo: 1,
      operation: "turn/start",
      decision: "sandbox-enforced"
    });
    const coverage = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/coverage` });
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json().coverage).toMatchObject({
      providerEventCount: 1,
      coveragePercent: 100,
      coverageLevel: "L1",
      summary: { workspaceEvidence: "missing" }
    });
    const hostedSummary = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/hosted-summary`
    });
    expect(hostedSummary.statusCode).toBe(200);
    expect(hostedSummary.json()).toMatchObject({
      hosted: true,
      session: { id: sessionId, mode: "hosted-observed", status: "running" },
      workspace: null,
      coverage: { providerEventCount: 1, coverageLevel: "L1" },
      promotions: [],
      actionRequests: [{ id: actionRequest.id, status: "rejected" }],
      networkEvidenceCount: 1,
      networkMediation: [{ id: networkRecord.id, decision: "sandbox-enforced" }],
      eventChainValid: true
    });

    const outOfScope = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { authorization: `Bearer ${controlToken}` },
      payload: { projectPath: "/tmp/demo", task: "forbidden", agentId: "fixture" }
    });
    expect(outOfScope.statusCode).toBe(401);

    const pending = approvals.evaluate(protectedDelete(runId));
    const providerCannotApprove = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${pending.approval!.id}/decision`,
      headers: { authorization: `Bearer ${controlToken}` },
      payload: { decision: "approved" }
    });
    expect(providerCannotApprove.statusCode).toBe(401);
    expect(approvals.get(pending.approval!.id)?.status).toBe("pending");
    await app.close();
  });

  it("keeps history and unfinished Run state readable after a service restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "afr-server-restart-test-"));
    directories.push(dataDir);
    const first = await buildServer({ dataDir, webRoot: false });
    const runId = await createRun(first.app, first.token);
    await first.app.close();

    const second = await buildServer({ dataDir, webRoot: false });
    const listed = await second.app.inject({ method: "GET", url: "/api/v1/runs" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().runs[0]).toMatchObject({ id: runId, status: "running" });
    expect(second.startupReport).toMatchObject({ quickCheck: "ok", verifiedRuns: 1 });
    await second.app.close();
  });

  it("serves an allowlisted read-only Network Gateway request to its Provider session", async () => {
    const transport: NetworkGatewayTransport = {
      async request(input) {
        return {
          statusCode: 200,
          headers: { "content-type": "application/json", "set-cookie": "secret=value" },
          body: (async function* () {
            yield Buffer.from("{\"source\":\"gateway\"}");
          })(),
          remoteAddress: input.address.address,
          close() {}
        };
      }
    };
    const { app, token, store } = await testServer({
      networkRead: {
        allowlist: ["api.example.com"],
        resolver: {
          async resolve() {
            return [{ address: "93.184.216.34", family: 4 }];
          }
        },
        transport
      }
    });
    const runId = await createRun(app, token);
    const issued = store.createProviderSession({
      runId,
      provider: "fixture",
      adapterVersion: "fixture",
      runtimeVersion: "fixture",
      protocolVersion: "fixture",
      mode: "hosted-observed",
      capabilities: {
        networkMediation: { state: "degraded", source: "fixture", version: "H8-B" }
      }
    });
    store.transitionProviderSession({ sessionId: issued.session.id, status: "starting" });
    store.transitionProviderSession({
      sessionId: issued.session.id,
      status: "running",
      externalSessionId: "fixture-thread"
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/provider-sessions/${issued.session.id}/network-read`,
      headers: { authorization: `Bearer ${issued.controlToken}` },
      payload: {
        method: "GET",
        url: "https://api.example.com/data?token=not-persisted",
        headers: { accept: "application/json" }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: {
        runId,
        method: "GET",
        statusCode: 200,
        finalOrigin: "https://api.example.com",
        byteSize: 20,
        responseHeaders: { "content-type": "application/json" }
      },
      bodyBase64: Buffer.from("{\"source\":\"gateway\"}").toString("base64")
    });
    expect(response.body).not.toContain("not-persisted");
    expect(response.body).not.toContain("set-cookie");
    expect(store.listNetworkMediationRecords(issued.session.id)).toHaveLength(3);

    const unauthorized = await app.inject({
      method: "POST",
      url: `/api/v1/provider-sessions/${issued.session.id}/network-read`,
      headers: { authorization: "Bearer wrong" },
      payload: { url: "https://api.example.com/data" }
    });
    expect(unauthorized.statusCode).toBe(401);
    await app.close();
  });

  it("rejects cross-origin writes even with a valid token", async () => {
    const { app, token } = await testServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: {
        authorization: `Bearer ${token}`,
        host: "127.0.0.1:4317",
        origin: "https://malicious.example"
      },
      payload: { projectPath: "/tmp/demo", task: "demo", agentId: "fixture" }
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("supports incremental event reads and an SSE replay cursor", async () => {
    const { app, token } = await testServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPath: "/tmp/demo", task: "demo", agentId: "fixture" }
    });
    const runId = created.json().run.id as string;

    const incremental = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/events?afterSequenceNo=1`
    });
    expect(incremental.json().events.map((event: { sequenceNo: number }) => event.sequenceNo)).toEqual([2]);

    const sse = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/stream?afterSequenceNo=1&snapshot=true`
    });
    expect(sse.headers["content-type"]).toContain("text/event-stream");
    expect(sse.body).toContain("id: 2\nevent: afr-event\ndata:");
    expect(sse.body).not.toContain("id: 1\n");
    await app.close();
  });

  it("redacts a text Blob before returning its content", async () => {
    const { app, token } = await testServer();
    const rawToken = "sk-1234567890abcdefghijkl";
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/blobs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        mediaType: "text/plain",
        contentBase64: Buffer.from(`log=${rawToken}`).toString("base64")
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ redactionState: "redacted" });
    const hash = String(created.json().blobRef).slice("sha256:".length);
    const read = await app.inject({ method: "GET", url: `/api/v1/blobs/${hash}` });
    expect(read.body).toBe("log=[REDACTED]");
    expect(read.body).not.toContain(rawToken);
    await app.close();
  });

  it("creates, lists, approves and consumes a one-time grant", async () => {
    const { app, token } = await testServer();
    const runId = await createRun(app, token);
    const context = protectedDelete(runId);
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: { authorization: `Bearer ${token}` },
      payload: { actionContext: context, reason: "remove obsolete protected file" }
    });
    expect(requested.statusCode).toBe(201);
    expect(requested.json().result).toMatchObject({
      decision: { effect: "ask", riskLevel: "R4" },
      approval: {
        status: "pending",
        actionContext: {
          targets: [{ canonicalId: "/tmp/demo/protected/important.txt" }]
        }
      }
    });
    const approvalId = requested.json().result.approval.id as string;

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/approvals?runId=${runId}`
    });
    expect(listed.json().approvals).toHaveLength(1);
    expect(listed.json().approvals[0]).toMatchObject({ id: approvalId, status: "pending" });

    const metadata = await app.inject({ method: "GET", url: "/api/v1/meta" });
    const sessionCookie = String(metadata.headers["set-cookie"]).split(";")[0];
    const navigation = await app.inject({
      method: "GET",
      url: `/runs/${runId}`,
      headers: {
        "sec-fetch-mode": "navigate",
        "sec-fetch-user": "?1",
        "sec-fetch-dest": "document"
      }
    });
    const humanCookie = String(navigation.headers["set-cookie"]).split(";")[0];
    const cookie = `${sessionCookie}; ${humanCookie}`;
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      headers: { cookie, host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
      payload: { decision: "approved" }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().result).toMatchObject({
      approval: { status: "approved", decidedBy: "local-user" },
      grant: { grantId: expect.any(String), token: expect.stringContaining(".") }
    });
    const grantToken = approved.json().result.grant.token as string;

    const consumed = await app.inject({
      method: "POST",
      url: "/api/v1/execution-grants:consume",
      headers: { authorization: `Bearer ${token}` },
      payload: { token: grantToken, actionContext: context }
    });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json().grant.status).toBe("consumed");

    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/execution-grants:consume",
      headers: { authorization: `Bearer ${token}` },
      payload: { token: grantToken, actionContext: context }
    });
    expect(repeated.statusCode).toBe(403);
    expect(repeated.json().code).toBe("grant_consumed");
    await app.close();
  });

  it("rejects parameter replacement without consuming the original grant", async () => {
    const { app, token } = await testServer();
    const runId = await createRun(app, token);
    const context = protectedDelete(runId);
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/approvals",
      headers: { authorization: `Bearer ${token}` },
      payload: { actionContext: context }
    });
    const approvalId = requested.json().result.approval.id as string;
    const agentAttempt = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { decision: "approved" }
    });
    expect(agentAttempt.statusCode).toBe(401);

    const navigation = await app.inject({
      method: "GET",
      url: `/runs/${runId}`,
      headers: {
        "sec-fetch-mode": "navigate",
        "sec-fetch-user": "?1",
        "sec-fetch-dest": "document"
      }
    });
    const humanCookie = String(navigation.headers["set-cookie"]).split(";")[0];
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      headers: { cookie: humanCookie },
      payload: { decision: "approved" }
    });
    const grantToken = approved.json().result.grant.token as string;
    const changed = {
      ...context,
      argv: ["rm", "protected/other.txt"],
      targets: [{ type: "file", canonicalId: "protected/other.txt" }]
    };
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/execution-grants:consume",
      headers: { authorization: `Bearer ${token}` },
      payload: { token: grantToken, actionContext: changed }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().code).toBe("action_digest_mismatch");

    const original = await app.inject({
      method: "POST",
      url: "/api/v1/execution-grants:consume",
      headers: { authorization: `Bearer ${token}` },
      payload: { token: grantToken, actionContext: context }
    });
    expect(original.statusCode).toBe(200);
    await app.close();
  });

  it("does not let an adapter forge core policy or approval events", async () => {
    const { app, token } = await testServer();
    const runId = await createRun(app, token);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/events:batch`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        events: [{
          schemaVersion: EVENT_SCHEMA_VERSION,
          eventId: "018f5e2a-1b2c-7d4e-8f90-123456789abe",
          runId,
          occurredAt: "2026-09-03T08:00:00Z",
          actor: { type: "human", id: "fake-user" },
          eventType: "approval.decided",
          status: "success",
          payload: { decision: "approved" }
        }]
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("protected_event_type");
    const timeline = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events` });
    expect(timeline.json().events).toHaveLength(2);
    await app.close();
  });

  it("runs Demo A through the Gateway: pause, deny, approve and delete only the bound file", async () => {
    const server = await testServer();
    const { app, token } = server;
    const projectPath = await mkdtemp(join(tmpdir(), "afr-demo-a-project-"));
    directories.push(projectPath);
    const protectedPath = join(projectPath, "protected");
    mkdirSync(protectedPath, { recursive: true });
    const deniedTarget = join(protectedPath, "deny.txt");
    const approvedTarget = join(protectedPath, "approve.txt");
    const untouchedTarget = join(protectedPath, "untouched.txt");
    writeFileSync(deniedTarget, "keep denied\n");
    writeFileSync(approvedTarget, "approved snapshot\n");
    writeFileSync(untouchedTarget, "untouched\n");

    const create = async (task: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/runs",
        headers: { authorization: `Bearer ${token}` },
        payload: { projectPath, task, agentId: "fixture" }
      });
      return response.json().run.id as string;
    };
    const requestDelete = async (runId: string, path: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/gateway/commands:execute",
        headers: { authorization: `Bearer ${token}` },
        payload: { runId, argv: ["rm", "--", path], reason: "Demo A dangerous delete" }
      });

    const deniedRun = await create("deny dangerous delete");
    const deniedRequest = await requestDelete(deniedRun, "protected/deny.txt");
    expect(deniedRequest.statusCode).toBe(202);
    expect(existsSync(deniedTarget)).toBe(true);
    const deniedApprovalId = deniedRequest.json().result.evaluation.approval.id as string;
    const deniedDecision = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${deniedApprovalId}/decision`,
      headers: { cookie: await humanCookie(app, deniedRun) },
      payload: { decision: "denied", reason: "keep the protected evidence" }
    });
    expect(deniedDecision.json().result.gatewayAction.status).toBe("denied");
    expect(existsSync(deniedTarget)).toBe(true);

    const approvedRun = await create("approve exact dangerous delete");
    const approvedRequest = await requestDelete(approvedRun, "protected/approve.txt");
    expect(approvedRequest.statusCode).toBe(202);
    expect(existsSync(approvedTarget)).toBe(true);
    const approval = approvedRequest.json().result.evaluation.approval as {
      id: string;
      snapshotId: string;
    };
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/v1/snapshots/${approval.snapshotId}`
    });
    expect(snapshot.statusCode).toBe(200);
    const snapshotBlob = await app.inject({
      method: "GET",
      url: `/api/v1/blobs/${String(snapshot.json().blobRef).replace(/^sha256:/, "")}`
    });
    expect(snapshotBlob.body).toBe("approved snapshot\n");

    const approvedDecision = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approval.id}/decision`,
      headers: { cookie: await humanCookie(app, approvedRun) },
      payload: { decision: "approved" }
    });
    expect(approvedDecision.statusCode).toBe(200);
    expect(approvedDecision.json().result).toMatchObject({
      approval: { status: "consumed" },
      gatewayAction: { status: "completed", snapshotId: approval.snapshotId }
    });
    expect(existsSync(approvedTarget)).toBe(false);
    expect(existsSync(deniedTarget)).toBe(true);
    expect(existsSync(untouchedTarget)).toBe(true);
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${approvedRun}/events`
    });
    expect(events.json().events.map((event: { eventType: string }) => event.eventType)).toEqual(
      expect.arrayContaining([
        "tool.call_requested",
        "snapshot.created",
        "policy.evaluated",
        "approval.requested",
        "approval.decided",
        "approval.consumed",
        "file.deleted"
      ])
    );
    await app.close();
  });

  it("promotes an approved Hosted plan through the HTTP API and rejects Provider authority", async () => {
    const projectPath = await replayFixture();
    const server = await testServer();
    const { app, token, store } = server;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPath, task: "promote hosted fix", agentId: "codex-app-server" }
    });
    const runId = created.json().run.id as string;
    const workspaces = new HostedWorkspaceManager(store);
    const prepared = workspaces.prepare({ runId });
    workspaces.activate(prepared.workspace.id);
    writeFileSync(join(prepared.workspace.worktreePath, "dependency.txt"), "correct\n");
    const finalized = workspaces.finalize(prepared.workspace.id).workspace;
    expect(finalized.changedPaths).toEqual(["dependency.txt"]);

    const provider = store.createProviderSession({
      runId,
      provider: "openai-codex",
      adapterVersion: "fixture",
      runtimeVersion: "fixture",
      protocolVersion: "app-server-v2",
      mode: "hosted-observed",
      capabilities: { patchPromotion: { state: "supported", source: "fixture", version: "1" } }
    });
    const providerDenied = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/promotions`,
      headers: { authorization: `Bearer ${provider.controlToken}` },
      payload: { selectedPaths: ["dependency.txt"] }
    });
    expect(providerDenied.statusCode).toBe(401);

    const requested = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/promotions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedPaths: ["dependency.txt"], reason: "reviewed Hosted fix" }
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.json().result).toMatchObject({
      promotion: { status: "waiting_approval", selectedPaths: ["dependency.txt"] },
      evaluation: { decision: { effect: "ask" } },
      plan: { selectedPaths: ["dependency.txt"] }
    });
    expect(readFileSync(join(projectPath, "dependency.txt"), "utf8")).toBe("wrong\n");
    const promotionId = requested.json().result.promotion.id as string;
    const approvalId = requested.json().result.promotion.approvalId as string;

    const listed = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/promotions` });
    expect(listed.json().promotions[0].id).toBe(promotionId);
    const detail = await app.inject({ method: "GET", url: `/api/v1/promotions/${promotionId}` });
    expect(detail.json()).toMatchObject({
      promotion: { id: promotionId },
      plan: { workspaceId: prepared.workspace.id, selectedPaths: ["dependency.txt"] }
    });

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      headers: { cookie: await humanCookie(app, runId) },
      payload: { decision: "approved" }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().result).toMatchObject({
      approval: { status: "consumed" },
      patchPromotion: { id: promotionId, status: "completed" }
    });
    expect(readFileSync(join(projectPath, "dependency.txt"), "utf8")).toBe("correct\n");

    const repeated = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/promotions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedPaths: ["dependency.txt"] }
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({
      code: "conflict",
      details: { promotionCode: "promotion_exists" }
    });
    await app.close();
  });

  it("creates a checkpoint, runs an isolated fork, exposes comparison, and exports valid JSON", async () => {
    const projectPath = await replayFixture();
    const { app, token } = await testServer({ replayExecutor: new DirectReplayExecutor() });
    const rawToken = "sk-1234567890abcdefghijkl";
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPath, task: `wrong dependency ${rawToken}`, agentId: "fixture" }
    });
    const sourceRunId = created.json().run.id as string;
    const sourceEvents = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${sourceRunId}/events`
    });
    const forkEventId = sourceEvents.json().events.at(-1).eventId as string;
    const checkpointResponse = await app.inject({
      method: "POST",
      url: "/api/v1/checkpoints",
      headers: { authorization: `Bearer ${token}` },
      payload: { runId: sourceRunId, sourceEventId: forkEventId }
    });
    expect(checkpointResponse.statusCode).toBe(201);
    const checkpointId = checkpointResponse.json().checkpoint.id as string;
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${sourceRunId}/checkpoints`
    });
    expect(listed.json().checkpoints).toHaveLength(1);
    await app.inject({
      method: "POST",
      url: `/api/v1/runs/${sourceRunId}/status`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "failed", reason: "wrong dependency" }
    });

    const replayResponse = await app.inject({
      method: "POST",
      url: "/api/v1/replays",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        checkpointId,
        command: [process.execPath, "replay-agent.mjs", "correct"],
        overrides: { dependencyConstraint: "correct" }
      }
    });
    expect(replayResponse.statusCode).toBe(201);
    const replay = replayResponse.json().replay as {
      id: string;
      targetRunId: string;
      status: string;
      worktreePath: string;
      comparison: { source: { status: string }; target: { status: string } };
    };
    expect(replay).toMatchObject({
      status: "completed",
      comparison: { source: { status: "failed" }, target: { status: "completed" } }
    });
    expect(replay.worktreePath).not.toBe(projectPath);
    expect(readFileSync(join(projectPath, "dependency.txt"), "utf8")).toBe("wrong\n");
    expect(readFileSync(join(replay.worktreePath, "dependency.txt"), "utf8")).toBe("correct\n");

    const replayRead = await app.inject({ method: "GET", url: `/api/v1/replays/${replay.id}` });
    expect(replayRead.json().replay.targetRunId).toBe(replay.targetRunId);
    const comparison = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${sourceRunId}/compare/${replay.targetRunId}`
    });
    expect(comparison.json().comparison.delta.statusChanged).toBe(true);

    const exported = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${sourceRunId}/export`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("afr-run-");
    expect(exported.json()).toMatchObject({
      format: "afr-run-json",
      verification: { hashChainValid: true }
    });
    expect(exported.body).not.toContain(rawToken);
    await app.close();
  });
});
