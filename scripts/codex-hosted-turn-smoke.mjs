import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexAppServerSupervisor,
  detectCodexVersion
} from "../packages/adapter-codex/dist/index.js";
import { LocalStore, createRunCreatedEvent } from "../packages/core/dist/index.js";

const binary = process.env.AFR_CODEX_BIN ?? "codex";
const runtimeVersion = process.env.AFR_CODEX_VERSION ??
  await detectCodexVersion(binary, process.cwd(), process.env) ?? "unknown";
const providerEgressAllowlist = (process.env.AFR_PROVIDER_EGRESS_ALLOWLIST ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
if (process.env.AFR_PROVIDER_EGRESS_REQUIRED === "true" && providerEgressAllowlist.length === 0) {
  throw new Error("AFR_PROVIDER_EGRESS_ALLOWLIST must contain at least one reviewed Provider hostname");
}
const trustedProviderAddresses = (process.env.AFR_PROVIDER_EGRESS_TRUSTED_PRIVATE_ADDRESSES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const dataDir = await mkdtemp(join(tmpdir(), "afr-hosted-turn-"));
const store = new LocalStore(dataDir);
const run = store.createRun({
  projectPath: process.cwd(),
  task: "只回复 AFR_HOST_OK，不要使用任何工具。",
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
    cancellation: { state: "supported", source: "local-schema", version: runtimeVersion },
    approvalBridge: { state: "degraded", source: "not-wired-in-this-smoke", version: "H6" },
    workspaceIsolation: { state: "unsupported", source: "not-implemented", version: "H2" }
  }
});

const notificationCounts = new Map();
let resolveTerminal;
let terminalTimer;
const terminal = new Promise((resolve, reject) => {
  resolveTerminal = resolve;
  terminalTimer = setTimeout(() => reject(new Error("Hosted Turn terminal event timed out")), 120_000);
});
const supervisor = new CodexAppServerSupervisor({
  cwd: process.cwd(),
  binary,
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  hostTimeoutMs: 120_000,
  shutdownGraceMs: 1_000,
  ...(providerEgressAllowlist.length === 0
    ? {}
    : {
        providerEgress: {
          allowlist: providerEgressAllowlist,
          allowSyntheticDnsRange: process.env.AFR_PROVIDER_EGRESS_ALLOW_SYNTHETIC_DNS === "true",
          trustedPrivateAddresses: trustedProviderAddresses
        }
      }),
  onNetworkAudit(event) {
    store.recordNetworkMediation({ sessionId: issued.session.id, ...event });
  },
  onNotification(notification) {
    notificationCounts.set(notification.method, (notificationCounts.get(notification.method) ?? 0) + 1);
    if (notification.method === "turn/completed") resolveTerminal(notification);
  }
});

let sessionStatus = issued.session.status;
try {
  const starting = supervisor.start();
  const processId = supervisor.processId();
  store.transitionProviderSession({
    sessionId: issued.session.id,
    status: "starting",
    ...(processId === undefined ? {} : { processId })
  });
  const handshake = await starting;
  const thread = await supervisor.startThread({
    cwd: process.cwd(),
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true
  });
  store.transitionProviderSession({
    sessionId: issued.session.id,
    status: "running",
    externalSessionId: thread.threadId
  });
  const turn = await supervisor.startTurn(thread.threadId, run.task);
  const terminalNotification = await terminal;
  clearTimeout(terminalTimer);
  const turnStatus = terminalNotification?.params?.turn?.status;
  if (turnStatus !== "completed") {
    throw new Error(`Hosted Turn ended with unexpected status: ${String(turnStatus)}`);
  }
  const exit = await supervisor.stop("completed");
  store.transitionProviderSession({ sessionId: issued.session.id, status: "completed" });
  store.transitionRun(run.id, "completed", "afr-host", `provider-session:${issued.session.id}`);
  sessionStatus = "completed";
  const networkMediation = store.listNetworkMediationRecords(issued.session.id);
  process.stdout.write(`${JSON.stringify({
    runId: run.id,
    providerSessionId: issued.session.id,
    providerThreadId: thread.threadId,
    providerTurnId: turn.turnId,
    handshake: {
      userAgent: handshake.userAgent ?? null,
      platformFamily: handshake.platformFamily ?? null,
      platformOs: handshake.platformOs ?? null
    },
    terminalMethod: terminalNotification.method,
    turnStatus,
    notificationCounts: Object.fromEntries([...notificationCounts].sort()),
    networkMediation: networkMediation.map(({ operation, decision, evidence }) => ({
      operation,
      decision,
      evidence: evidence ?? null
    })),
    providerEgress: providerEgressAllowlist.length === 0
      ? { state: "degraded", reason: "not-configured" }
      : {
          state: "enforced",
          allowlist: providerEgressAllowlist,
          syntheticDnsRange: process.env.AFR_PROVIDER_EGRESS_ALLOW_SYNTHETIC_DNS === "true",
          trustedPrivateAddressCount: trustedProviderAddresses.length
        },
    runStatus: store.getRun(run.id)?.status,
    providerSessionStatus: store.getProviderSession(issued.session.id)?.status,
    eventChainValid: store.verifyRunChain(run.id),
    exit
  }, null, 2)}\n`);
} catch (error) {
  clearTimeout(terminalTimer);
  if (["created", "starting", "running", "stopping"].includes(sessionStatus)) {
    const current = store.getProviderSession(issued.session.id);
    if (current !== undefined && ["created", "starting", "running", "stopping"].includes(current.status)) {
      store.transitionProviderSession({
        sessionId: issued.session.id,
        status: "failed",
        errorCode: "hosted_turn_smoke_failed",
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const currentRun = store.getRun(run.id);
  if (currentRun !== undefined && !["completed", "failed", "cancelled"].includes(currentRun.status)) {
    store.transitionRun(run.id, "failed", "afr-host", "hosted-turn-smoke-failed");
  }
  if (["starting", "running"].includes(supervisor.state())) {
    await supervisor.stop("failed");
  }
  const networkMediation = store.listNetworkMediationRecords(issued.session.id);
  process.stderr.write(`${JSON.stringify({
    providerEgress: providerEgressAllowlist,
    trustedPrivateAddressCount: trustedProviderAddresses.length,
    networkMediation: networkMediation.map(({ operation, decision, evidence }) => ({
      operation,
      decision,
      evidence: evidence ?? null
    }))
  }, null, 2)}\n`);
  throw error;
} finally {
  store.close();
  await rm(dataDir, { recursive: true, force: true });
}
