import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexAppServerSupervisor,
  NETWORK_READ_DYNAMIC_TOOL,
  createNetworkReadDynamicToolHandler,
  detectCodexVersion
} from "../packages/adapter-codex/dist/index.js";
import {
  ApprovalService,
  LocalStore,
  ReadOnlyNetworkGateway,
  createRunCreatedEvent
} from "../packages/core/dist/index.js";

const binary = process.env.AFR_CODEX_BIN ?? "codex";
const runtimeVersion = process.env.AFR_CODEX_VERSION ??
  await detectCodexVersion(binary, process.cwd(), process.env) ?? "unknown";
const providerEgressAllowlist = requiredList("AFR_PROVIDER_EGRESS_ALLOWLIST");
const trustedProviderAddresses = optionalList("AFR_PROVIDER_EGRESS_TRUSTED_PRIVATE_ADDRESSES");
const dataDir = await mkdtemp(join(tmpdir(), "afr-hosted-network-tool-"));
const store = new LocalStore(dataDir);
const run = store.createRun({
  projectPath: process.cwd(),
  task: "必须调用 afr_network_read 一次读取 https://example.com/，然后只回复 HTTP 状态码。不要运行任何其他工具。",
  agentId: "codex-app-server"
});
store.appendEvents(run.id, [createRunCreatedEvent(run)]);
store.transitionRun(run.id, "running");
const issued = store.createProviderSession({
  runId: run.id,
  provider: "openai-codex",
  adapterVersion: "0.1.0-demo.0",
  runtimeVersion,
  protocolVersion: "app-server-v2-experimental-dynamic-tools",
  mode: "hosted-observed",
  capabilities: {
    eventStream: { state: "supported", source: "local-schema-and-runtime", version: runtimeVersion },
    networkMediation: { state: "degraded", source: "afr-gateway-dynamic-tool", version: "H8-C" }
  }
});
const approvals = new ApprovalService(store, {
  dataDir,
  networkReadAllowlist: ["example.com"]
});
const gateway = new ReadOnlyNetworkGateway(store, approvals, {
  allowlist: ["example.com"],
  maxResponseBytes: 128 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 2
});
const networkTool = createNetworkReadDynamicToolHandler({
  gateway,
  sessionId: issued.session.id
});

let dynamicToolCalls = 0;
let resolveTerminal;
let terminalTimer;
const terminal = new Promise((resolve, reject) => {
  resolveTerminal = resolve;
  terminalTimer = setTimeout(() => reject(new Error("Hosted network tool Turn timed out")), 120_000);
});
const supervisor = new CodexAppServerSupervisor({
  cwd: process.cwd(),
  binary,
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  hostTimeoutMs: 120_000,
  shutdownGraceMs: 1_000,
  providerEgress: {
    allowlist: providerEgressAllowlist,
    allowSyntheticDnsRange: process.env.AFR_PROVIDER_EGRESS_ALLOW_SYNTHETIC_DNS === "true",
    trustedPrivateAddresses: trustedProviderAddresses
  },
  dynamicTools: [NETWORK_READ_DYNAMIC_TOOL],
  async onDynamicToolCall(call, signal) {
    dynamicToolCalls += 1;
    return networkTool(call, signal);
  },
  onNetworkAudit(event) {
    store.recordNetworkMediation({ sessionId: issued.session.id, ...event });
  },
  onNotification(notification) {
    if (notification.method === "turn/completed") resolveTerminal(notification);
  }
});

try {
  const starting = supervisor.start();
  store.transitionProviderSession({
    sessionId: issued.session.id,
    status: "starting",
    ...(supervisor.processId() === undefined ? {} : { processId: supervisor.processId() })
  });
  await starting;
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
  const completed = await terminal;
  clearTimeout(terminalTimer);
  if (completed?.params?.turn?.status !== "completed") {
    throw new Error(`Hosted network tool Turn ended as ${String(completed?.params?.turn?.status)}`);
  }
  if (dynamicToolCalls !== 1) {
    throw new Error(`Expected one AFR dynamic network tool call, received ${dynamicToolCalls}`);
  }
  const networkMediation = store.listNetworkMediationRecords(issued.session.id);
  for (const operation of [
    "provider.egress.connect",
    "item/tool/call",
    "network.gateway.request",
    "network.gateway.hop",
    "network.gateway.result"
  ]) {
    if (!networkMediation.some((record) => record.operation === operation)) {
      throw new Error(`Missing network mediation evidence: ${operation}`);
    }
  }
  const exit = await supervisor.stop("completed");
  store.transitionProviderSession({ sessionId: issued.session.id, status: "completed" });
  store.transitionRun(run.id, "completed", "afr-host", `provider-session:${issued.session.id}`);
  process.stdout.write(`${JSON.stringify({
    runId: run.id,
    providerSessionId: issued.session.id,
    providerThreadId: thread.threadId,
    providerTurnId: turn.turnId,
    dynamicToolCalls,
    networkMediation: networkMediation.map(({ sequenceNo, operation, decision, evidence }) => ({
      sequenceNo,
      operation,
      decision,
      evidence: evidence ?? null
    })),
    runStatus: store.getRun(run.id)?.status,
    providerSessionStatus: store.getProviderSession(issued.session.id)?.status,
    eventChainValid: store.verifyRunChain(run.id),
    exit
  }, null, 2)}\n`);
} catch (error) {
  clearTimeout(terminalTimer);
  const session = store.getProviderSession(issued.session.id);
  if (session !== undefined && ["created", "starting", "running", "stopping"].includes(session.status)) {
    store.transitionProviderSession({
      sessionId: issued.session.id,
      status: "failed",
      errorCode: "hosted_network_tool_smoke_failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
  const currentRun = store.getRun(run.id);
  if (currentRun !== undefined && !["completed", "failed", "cancelled"].includes(currentRun.status)) {
    store.transitionRun(run.id, "failed", "afr-host", "hosted-network-tool-smoke-failed");
  }
  if (["starting", "running"].includes(supervisor.state())) await supervisor.stop("failed");
  process.stderr.write(`${JSON.stringify({
    dynamicToolCalls,
    networkMediation: store.listNetworkMediationRecords(issued.session.id).map(
      ({ sequenceNo, operation, decision, evidence }) => ({
        sequenceNo,
        operation,
        decision,
        evidence: evidence ?? null
      })
    )
  }, null, 2)}\n`);
  throw error;
} finally {
  store.close();
  await rm(dataDir, { recursive: true, force: true });
}

function requiredList(name) {
  const values = optionalList(name);
  if (values.length === 0) throw new Error(`${name} must contain at least one hostname`);
  return values;
}

function optionalList(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
