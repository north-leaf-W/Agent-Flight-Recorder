import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AppServerEventBridge,
  CodexAppServerSupervisor,
  detectCodexVersion
} from "../packages/adapter-codex/dist/index.js";
import { LocalStore, createRunCreatedEvent } from "../packages/core/dist/index.js";

const binary = process.env.AFR_CODEX_BIN ?? "codex";
const runtimeVersion = process.env.AFR_CODEX_VERSION ??
  await detectCodexVersion(binary, process.cwd(), process.env) ?? "unknown";
const dataDir = await mkdtemp(join(tmpdir(), "afr-hosted-network-"));
const store = new LocalStore(dataDir);
const run = store.createRun({
  projectPath: process.cwd(),
  task: "只回复 AFR_NETWORK_CONTROL_OK，不要使用任何工具。",
  agentId: "codex-app-server"
});
store.appendEvents(run.id, [createRunCreatedEvent(run)]);
store.transitionRun(run.id, "running");
const issued = store.createProviderSession({
  runId: run.id,
  provider: "openai-codex",
  adapterVersion: "0.1.0-demo.0",
  runtimeVersion,
  protocolVersion: "app-server-v2",
  mode: "hosted-observed",
  capabilities: {
    eventStream: { state: "supported", source: "local-schema-and-runtime", version: runtimeVersion },
    toolNetworkDeny: { state: "supported", source: "afr-host-network-guard", version: "H8" },
    unsafeClientMethodsBlocked: { state: "supported", source: "afr-host-rpc-allowlist", version: "H8" },
    networkMediation: {
      state: "degraded",
      source: "afr-host-deny-all-profile",
      version: "H8",
      detail: "Provider control channel available; tool network denied; read-only HTTP Gateway not implemented"
    }
  }
});
const bridge = new AppServerEventBridge(store, {
  runId: run.id,
  providerSessionId: issued.session.id,
  runtimeVersion
});

let loopbackConnections = 0;
let loopbackRequests = 0;
const loopback = createServer((_request, response) => {
  loopbackRequests += 1;
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("AFR_NETWORK_BYPASS\n");
});
loopback.on("connection", () => {
  loopbackConnections += 1;
});
await new Promise((resolvePromise, rejectPromise) => {
  loopback.once("error", rejectPromise);
  loopback.listen(0, "127.0.0.1", resolvePromise);
});
const address = loopback.address();
if (address === null || typeof address === "string") throw new Error("Loopback listener has no TCP port");

let resolveTerminal;
let rejectTerminal;
const terminal = new Promise((resolvePromise, rejectPromise) => {
  resolveTerminal = resolvePromise;
  rejectTerminal = rejectPromise;
});
const terminalTimer = setTimeout(
  () => rejectTerminal(new Error("Hosted network Turn terminal event timed out")),
  180_000
);
const supervisor = new CodexAppServerSupervisor({
  cwd: process.cwd(),
  binary,
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  hostTimeoutMs: 180_000,
  shutdownGraceMs: 1_000,
  onNotification(notification) {
    bridge.handle(notification);
    if (notification.method === "turn/completed") resolveTerminal(notification);
  },
  onNetworkAudit(event) {
    store.recordNetworkMediation({ sessionId: issued.session.id, ...event });
  }
});

let providerThreadId;
let providerTurnId;
try {
  const starting = supervisor.start();
  store.transitionProviderSession({
    sessionId: issued.session.id,
    status: "starting",
    ...(supervisor.processId() === undefined ? {} : { processId: supervisor.processId() })
  });
  const handshake = await starting;

  const networkAttempt = await supervisor.executeCommand({
    command: [
      process.execPath,
      "-e",
      [
        "const http = require('node:http');",
        `const request = http.get('http://127.0.0.1:${address.port}/probe', () => process.exit(0));`,
        "request.on('error', () => process.exit(23));",
        "setTimeout(() => process.exit(24), 3000);"
      ].join("")
    ],
    sandbox: "read-only",
    timeoutMs: 5_000,
    outputBytesCap: 8_192
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  if (networkAttempt.exitCode === 0 || loopbackConnections !== 0 || loopbackRequests !== 0) {
    throw new Error(
      `Tool network bypassed the deny policy: exit=${networkAttempt.exitCode} ` +
      `connections=${loopbackConnections} requests=${loopbackRequests}`
    );
  }

  const thread = await supervisor.startThread({
    cwd: process.cwd(),
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true
  });
  providerThreadId = thread.threadId;
  store.transitionProviderSession({
    sessionId: issued.session.id,
    status: "running",
    externalSessionId: thread.threadId
  });
  const turn = await supervisor.startTurn(thread.threadId, run.task);
  providerTurnId = turn.turnId;
  const terminalNotification = await terminal;
  clearTimeout(terminalTimer);
  const turnStatus = terminalNotification?.params?.turn?.status;
  if (turnStatus !== "completed") {
    throw new Error(`Hosted control Turn ended with unexpected status: ${String(turnStatus)}`);
  }
  const exit = await supervisor.stop("completed");
  store.transitionProviderSession({ sessionId: issued.session.id, status: "completed" });
  store.transitionRun(run.id, "completed", "afr-host", `provider-session:${issued.session.id}`);

  const networkEvidence = store.listNetworkMediationRecords(issued.session.id);
  const requiredEvidence = [
    ["initialize", "control-allowed"],
    ["command/exec", "sandbox-enforced"],
    ["command/exec", "observed"],
    ["thread/start", "observed"],
    ["turn/start", "sandbox-enforced"]
  ];
  for (const [operation, decision] of requiredEvidence) {
    if (!networkEvidence.some((record) =>
      record.operation === operation && record.decision === decision
    )) {
      throw new Error(`Missing network mediation evidence: ${operation}/${decision}`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    runId: run.id,
    providerSessionId: issued.session.id,
    providerThreadId,
    providerTurnId,
    runtimeVersion,
    handshake: {
      userAgent: handshake.userAgent ?? null,
      platformFamily: handshake.platformFamily ?? null,
      platformOs: handshake.platformOs ?? null
    },
    toolNetworkProbe: {
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      exitCode: networkAttempt.exitCode,
      loopbackConnections,
      loopbackRequests,
      stdout: networkAttempt.stdout,
      stderr: networkAttempt.stderr
    },
    providerControlTurn: { status: turnStatus },
    networkEvidence: networkEvidence.map(({ sequenceNo, source, operation, decision, effectivePolicy, evidence }) => ({
      sequenceNo,
      source,
      operation,
      decision,
      effectivePolicy: effectivePolicy ?? null,
      evidence: evidence ?? null
    })),
    eventChainValid: store.verifyRunChain(run.id),
    runStatus: store.getRun(run.id)?.status,
    providerSessionStatus: store.getProviderSession(issued.session.id)?.status,
    appServerExit: exit
  }, null, 2)}\n`);
} catch (error) {
  clearTimeout(terminalTimer);
  if (["starting", "running"].includes(supervisor.state())) {
    await supervisor.stop("failed");
  }
  const session = store.getProviderSession(issued.session.id);
  if (session !== undefined && ["created", "starting", "running", "stopping"].includes(session.status)) {
    store.transitionProviderSession({
      sessionId: session.id,
      status: "failed",
      errorCode: "hosted_network_smoke_failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
  const currentRun = store.getRun(run.id);
  if (currentRun !== undefined && !["completed", "failed", "cancelled"].includes(currentRun.status)) {
    store.transitionRun(run.id, "failed", "afr-host", "hosted-network-smoke-failed");
  }
  throw error;
} finally {
  await new Promise((resolvePromise) => loopback.close(resolvePromise));
  store.close();
  await rm(dataDir, { recursive: true, force: true });
}
