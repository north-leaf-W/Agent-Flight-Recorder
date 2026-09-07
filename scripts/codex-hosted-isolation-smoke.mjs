import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import {
  AppServerEventBridge,
  CodexAppServerSupervisor,
  detectCodexVersion
} from "../packages/adapter-codex/dist/index.js";
import {
  ApprovalService,
  HostedWorkspaceManager,
  LocalStore,
  PatchPromotionGateway,
  createRunCreatedEvent
} from "../packages/core/dist/index.js";

const binary = process.env.AFR_CODEX_BIN ?? "codex";
const sourceRoot = resolve("examples/demo-c-project");
const runtimeVersion = process.env.AFR_CODEX_VERSION ??
  await detectCodexVersion(binary, process.cwd(), process.env) ?? "unknown";
const dataDir = await mkdtemp(join(tmpdir(), "afr-hosted-isolation-"));
const store = new LocalStore(dataDir);
const workspaces = new HostedWorkspaceManager(store);
const approvals = new ApprovalService(store, { dataDir });
const promotions = new PatchPromotionGateway(store, approvals);
const promoteToSource = process.env.AFR_PROMOTE === "true";
const sourceDependencyBefore = await readFile(join(sourceRoot, "dependency.json"));
const sourceTestBefore = runTest(sourceRoot);
if (sourceTestBefore.status === 0) {
  throw new Error("Demo C precondition failed: the source fixture must start with a failing test");
}

const run = store.createRun({
  projectPath: sourceRoot,
  task: [
    "修复 dependency.test.mjs 当前暴露的依赖配置错误。",
    "只做最小修改，不要修改测试文件或 ORIGINAL_MARKER.txt。",
    "完成后运行 node --test dependency.test.mjs，并简要说明结果。"
  ].join(" "),
  agentId: "codex-app-server"
});
store.appendEvents(run.id, [createRunCreatedEvent(run)]);
const prepared = workspaces.prepare({ runId: run.id });
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
    workspaceIsolation: { state: "supported", source: "afr-hosted-workspace", version: "H3" },
    eventPersistence: { state: "supported", source: "afr-app-server-event-bridge", version: "H4" },
    approvalBridge: { state: "degraded", source: "not-wired-in-this-smoke", version: "H6" },
    patchPromotion: {
      state: promoteToSource ? "supported" : "degraded",
      source: promoteToSource ? "afr-patch-promotion" : "not-requested-in-this-smoke",
      version: "H7"
    }
  }
});
const bridge = new AppServerEventBridge(store, {
  runId: run.id,
  providerSessionId: issued.session.id,
  runtimeVersion
});
const notificationCounts = new Map();
let resolveTerminal;
let rejectTerminal;
const terminal = new Promise((resolvePromise, rejectPromise) => {
  resolveTerminal = resolvePromise;
  rejectTerminal = rejectPromise;
});
const terminalTimer = setTimeout(
  () => rejectTerminal(new Error("Hosted isolation Turn terminal event timed out")),
  180_000
);
const supervisor = new CodexAppServerSupervisor({
  cwd: prepared.workspace.worktreePath,
  binary,
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  hostTimeoutMs: 180_000,
  shutdownGraceMs: 1_000,
  onNotification(notification) {
    bridge.handle(notification);
    notificationCounts.set(notification.method, (notificationCounts.get(notification.method) ?? 0) + 1);
    if (notification.method === "turn/completed") resolveTerminal(notification);
  }
});

let finalized;
let promotionEvidence;
let providerThreadId;
let providerTurnId;
try {
  workspaces.activate(prepared.workspace.id);
  store.transitionRun(run.id, "running", "afr-host", `hosted-workspace:${prepared.workspace.id}`);
  const starting = supervisor.start();
  store.transitionProviderSession({
    sessionId: issued.session.id,
    status: "starting",
    ...(supervisor.processId() === undefined ? {} : { processId: supervisor.processId() })
  });
  await starting;
  const thread = await supervisor.startThread({
    cwd: prepared.workspace.worktreePath,
    sandbox: "workspace-write",
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
    throw new Error(`Hosted isolation Turn ended with unexpected status: ${String(turnStatus)}`);
  }
  const exit = await supervisor.stop("completed");
  const worktreeTest = runTest(prepared.workspace.worktreePath);
  if (worktreeTest.status !== 0) {
    throw new Error(`Codex did not repair the isolated fixture: ${worktreeTest.output}`);
  }
  finalized = workspaces.finalize(prepared.workspace.id);
  const sourceDependencyAfter = await readFile(join(sourceRoot, "dependency.json"));
  const sourceTestAfter = runTest(sourceRoot);
  if (!sourceDependencyAfter.equals(sourceDependencyBefore)) {
    throw new Error("Source dependency.json changed during isolated Hosted execution");
  }
  if (sourceTestAfter.status === 0) {
    throw new Error("Source fixture unexpectedly became passing; isolation was not preserved");
  }
  if (promoteToSource) {
    if (!finalized.workspace.changedPaths.includes("dependency.json")) {
      throw new Error("Hosted result did not include dependency.json for Patch Promotion");
    }
    const requested = promotions.request({
      runId: run.id,
      selectedPaths: ["dependency.json"],
      reason: "H7 acceptance operator reviewed the isolated dependency fix"
    });
    const planBlob = store.getBlob(requested.promotion.planBlobHash);
    if (planBlob === undefined || sha256(planBlob.content) !== requested.promotion.planHash) {
      throw new Error("Patch Promotion plan Blob does not match the approved plan hash");
    }
    const decided = approvals.decide(
      requested.promotion.approvalId,
      "approved",
      "h7-acceptance-operator",
      "Exact dependency.json plan reviewed"
    );
    const completed = promotions.resolveApproval(
      requested.promotion.approvalId,
      "approved",
      decided.grant?.token
    );
    if (completed?.status !== "completed" || completed.planHash !== requested.promotion.planHash) {
      throw new Error(`Patch Promotion failed: ${completed?.errorCode ?? "missing result"}`);
    }
    const sourceTestPromoted = runTest(sourceRoot);
    if (sourceTestPromoted.status !== 0) {
      throw new Error(`Promoted source fixture did not pass: ${sourceTestPromoted.output}`);
    }
    const evidence = store.listEvents(run.id).findLast(
      (event) => event.eventType === "evidence.attached" &&
        event.payload.promotionId === completed.id
    );
    if (evidence?.payload.planHash !== completed.planHash) {
      throw new Error("Patch Promotion result evidence is not bound to the approved plan hash");
    }
    promotionEvidence = {
      promotionId: completed.id,
      approvalId: completed.approvalId,
      selectedPaths: completed.selectedPaths,
      planHash: completed.planHash,
      resultSourceFingerprint: completed.resultSourceFingerprint,
      status: completed.status,
      approvalStatus: approvals.get(completed.approvalId)?.status,
      sourceTestExitAfterPromotion: sourceTestPromoted.status,
      evidenceEventId: evidence.eventId
    };
  }
  const providerEvents = store.listProviderEvents(issued.session.id);
  if (!providerEvents.every((event, index) => event.arrivalSequence === index + 1)) {
    throw new Error("Provider event arrival sequence is not contiguous");
  }
  if (!providerEvents.some((event) => event.normalizedEventId !== undefined)) {
    throw new Error("No Provider event was linked to a normalized AFR event");
  }
  const coverage = store.getRunCoverage(run.id);
  if (coverage === undefined) throw new Error("Run coverage was not computed");
  store.transitionProviderSession({ sessionId: issued.session.id, status: "completed" });
  store.transitionRun(run.id, "completed", "afr-host", `provider-session:${issued.session.id}`);
  const cleaned = workspaces.cleanup(prepared.workspace.id);

  process.stdout.write(`${JSON.stringify({
    runId: run.id,
    checkpointId: prepared.checkpoint.id,
    hostedWorkspaceId: prepared.workspace.id,
    providerSessionId: issued.session.id,
    providerThreadId,
    providerTurnId,
    source: {
      dependencyHashBefore: sha256(sourceDependencyBefore),
      dependencyHashAfter: sha256(sourceDependencyAfter),
      testExitBefore: sourceTestBefore.status,
      testExitAfterIsolation: sourceTestAfter.status,
      unchangedDuringHostedRun: finalized.sourceUnchanged
    },
    isolated: {
      testExit: worktreeTest.status,
      changedPaths: finalized.workspace.changedPaths,
      diffBlobHash: finalized.workspace.diffBlobHash ?? null,
      finalStatus: finalized.workspace.status,
      cleanupStatus: cleaned.status
    },
    provider: {
      eventCount: providerEvents.length,
      linkedEventCount: providerEvents.filter((event) => event.normalizedEventId !== undefined).length,
      gapDetails: providerEvents
        .filter((event) => event.parseStatus === "gap" || event.parseStatus === "invalid")
        .map((event) => ({
          method: event.providerMethod,
          reason: event.gapReason,
          normalized: event.normalizedEventId === undefined
            ? null
            : store.getEvent(event.normalizedEventId)?.payload ?? null
        })),
      notificationCounts: Object.fromEntries([...notificationCounts].sort()),
      coverage
    },
    promotion: promotionEvidence ?? null,
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
      errorCode: "hosted_isolation_smoke_failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
  const currentRun = store.getRun(run.id);
  if (currentRun !== undefined && !["completed", "failed", "cancelled"].includes(currentRun.status)) {
    store.transitionRun(run.id, "failed", "afr-host", "hosted-isolation-smoke-failed");
  }
  const workspace = store.getHostedWorkspace(prepared.workspace.id);
  if (workspace?.status === "active" || workspace?.status === "ready") {
    try {
      workspaces.finalize(workspace.id);
    } catch {
      // The failure is already recorded on the Hosted workspace.
    }
  }
  throw error;
} finally {
  const workspace = store.getHostedWorkspace(prepared.workspace.id);
  if (workspace?.status === "finalized" || workspace?.status === "failed") {
    try {
      workspaces.cleanup(workspace.id);
    } catch {
      // Preserve the primary smoke-test outcome.
    }
  }
  store.close();
  await rm(dataDir, { recursive: true, force: true });
}

function runTest(cwd) {
  const result = spawnSync(process.execPath, ["--test", "dependency.test.mjs"], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    shell: false
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
