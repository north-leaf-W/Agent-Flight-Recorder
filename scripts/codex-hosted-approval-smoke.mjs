import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AppServerApprovalBridge,
  AppServerEventBridge,
  CodexAppServerSupervisor,
  detectCodexVersion
} from "../packages/adapter-codex/dist/index.js";
import {
  ApprovalService,
  LocalStore,
  createRunCreatedEvent
} from "../packages/core/dist/index.js";

const binary = process.env.AFR_CODEX_BIN ?? "codex";
const runtimeVersion = process.env.AFR_CODEX_VERSION ??
  await detectCodexVersion(binary, process.cwd(), process.env) ?? "unknown";
const dataDir = await mkdtemp(join(tmpdir(), "afr-hosted-approval-"));
const store = new LocalStore(dataDir);
const run = store.createRun({
  projectPath: process.cwd(),
  task: [
    "只运行一次以下命令，不要运行任何其他命令，也不要修改文件：",
    "node -e \"console.log('AFR_APPROVAL_OK')\"",
    "执行后简要报告结果。"
  ].join(" "),
  agentId: "codex-app-server"
});
store.appendEvents(run.id, [createRunCreatedEvent(run)]);
store.transitionRun(run.id, "running");
const issued = store.createProviderSession({
  runId: run.id,
  provider: "openai-codex",
  adapterVersion: "0.1.0-demo.0",
  runtimeVersion,
  protocolVersion: "app-server-experimental",
  mode: "hosted-observed",
  capabilities: {
    eventStream: { state: "supported", source: "local-schema-and-runtime", version: runtimeVersion },
    commandControl: { state: "supported", source: "afr-app-server-approval-bridge", version: "H5" },
    approvalBridge: { state: "supported", source: "afr-app-server-approval-bridge", version: "H6" },
    workspaceIsolation: { state: "degraded", source: "read-only-smoke", version: "H6" },
    networkMediation: { state: "unsupported", source: "not-implemented", version: "H8" }
  }
});
const approvals = new ApprovalService(store, { dataDir });
const eventBridge = new AppServerEventBridge(store, {
  runId: run.id,
  providerSessionId: issued.session.id,
  runtimeVersion
});
const approvalBridge = new AppServerApprovalBridge({
  runId: run.id,
  providerSessionId: issued.session.id,
  approvals,
  store,
  approvalWaitTimeoutMs: 120_000
});

let resolveTerminal;
let rejectTerminal;
const terminal = new Promise((resolvePromise, rejectPromise) => {
  resolveTerminal = resolvePromise;
  rejectTerminal = rejectPromise;
});
const terminalTimer = setTimeout(
  () => rejectTerminal(new Error("Hosted approval Turn terminal event timed out")),
  150_000
);
const supervisor = new CodexAppServerSupervisor({
  cwd: process.cwd(),
  binary,
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  hostTimeoutMs: 150_000,
  shutdownGraceMs: 1_000,
  onNotification(notification) {
    eventBridge.handle(notification);
    if (notification.method === "turn/completed") resolveTerminal(notification);
  },
  onServerRequest(request) {
    return approvalBridge.handle(request);
  }
});

let approvedId;
const approvalWatcher = setInterval(() => {
  const pending = approvals.list({ runId: run.id, status: "pending" })[0];
  if (pending === undefined || approvedId !== undefined) return;
  const command = pending.actionContext.argv?.join(" ") ?? "";
  if (!command.includes("AFR_APPROVAL_OK")) {
    approvals.decide(pending.id, "denied", "acceptance-operator", "Unexpected command");
    return;
  }
  approvedId = pending.id;
  approvals.decide(pending.id, "approved", "acceptance-operator", "Exact fixture command verified");
}, 25);

try {
  const starting = supervisor.start();
  store.transitionProviderSession({
    sessionId: issued.session.id,
    status: "starting",
    ...(supervisor.processId() === undefined ? {} : { processId: supervisor.processId() })
  });
  const handshake = await starting;
  const thread = await supervisor.startThread({
    cwd: process.cwd(),
    sandbox: "read-only",
    approvalPolicy: "untrusted",
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
  clearInterval(approvalWatcher);
  const turnStatus = terminalNotification?.params?.turn?.status;
  if (turnStatus !== "completed") {
    throw new Error(`Hosted approval Turn ended with unexpected status: ${String(turnStatus)}`);
  }
  const actionRequests = store.listProviderActionRequests(issued.session.id);
  if (actionRequests.length === 0) throw new Error("Codex did not emit an approval request");
  const accepted = actionRequests.find(({ status }) => status === "accepted");
  if (accepted === undefined || accepted.grantId === undefined) {
    throw new Error("No Provider request was accepted through a consumed grant");
  }
  const grant = store.getExecutionGrant(accepted.grantId);
  if (grant?.status !== "consumed") throw new Error("Provider accept was not bound to a consumed grant");
  if (approvedId === undefined || accepted.approvalId !== approvedId) {
    throw new Error("Provider accept was not linked to the human approval");
  }
  const exit = await supervisor.stop("completed");
  store.transitionProviderSession({ sessionId: issued.session.id, status: "completed" });
  store.transitionRun(run.id, "completed", "afr-host", `provider-session:${issued.session.id}`);

  process.stdout.write(`${JSON.stringify({
    runtimeVersion,
    runId: run.id,
    providerSessionId: issued.session.id,
    providerThreadId: thread.threadId,
    providerTurnId: turn.turnId,
    handshake: { userAgent: handshake.userAgent ?? null },
    turnStatus,
    approvalId: approvedId,
    providerActionRequest: accepted,
    grant,
    providerRequestCount: actionRequests.length,
    eventChainValid: store.verifyRunChain(run.id),
    providerSessionStatus: store.getProviderSession(issued.session.id)?.status,
    runStatus: store.getRun(run.id)?.status,
    exit
  }, null, 2)}\n`);
} catch (error) {
  clearTimeout(terminalTimer);
  clearInterval(approvalWatcher);
  if (["starting", "running"].includes(supervisor.state())) {
    await supervisor.stop("failed");
  }
  const session = store.getProviderSession(issued.session.id);
  if (session !== undefined && ["created", "starting", "running", "stopping"].includes(session.status)) {
    store.transitionProviderSession({
      sessionId: session.id,
      status: "failed",
      errorCode: "hosted_approval_smoke_failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
  throw error;
} finally {
  store.close();
  await rm(dataDir, { recursive: true, force: true });
}
