import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalService,
  LocalStore,
  ReadOnlyNetworkGateway,
  createRunCreatedEvent
} from "../packages/core/dist/index.js";

const dataDir = await mkdtemp(join(tmpdir(), "afr-network-gateway-smoke-"));
const store = new LocalStore(dataDir);

try {
  const run = store.createRun({
    projectPath: process.cwd(),
    task: "Fetch the public example.com fixture through the read-only Network Gateway",
    agentId: "afr-network-gateway-smoke"
  });
  store.appendEvents(run.id, [createRunCreatedEvent(run)]);
  store.transitionRun(run.id, "running");
  const session = store.createProviderSession({
    runId: run.id,
    provider: "network-gateway-smoke",
    adapterVersion: "0.1.0-demo.0",
    runtimeVersion: process.version,
    protocolVersion: "afr-network-gateway-v1",
    mode: "hosted-observed",
    capabilities: {
      networkMediation: { state: "degraded", source: "gateway-smoke", version: "H8-B" }
    }
  }).session;
  store.transitionProviderSession({ sessionId: session.id, status: "starting" });
  store.transitionProviderSession({ sessionId: session.id, status: "running" });
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
  const result = await gateway.request({
    sessionId: session.id,
    method: "GET",
    url: "https://example.com/",
    headers: { accept: "text/html" }
  });
  const audit = store.listNetworkMediationRecords(session.id);
  process.stdout.write(`${JSON.stringify({
    runId: run.id,
    providerSessionId: session.id,
    statusCode: result.statusCode,
    finalOrigin: result.finalOrigin,
    responseHash: result.responseHash,
    byteSize: result.byteSize,
    redirectCount: result.redirectCount,
    bodyPersisted: false,
    eventChainValid: store.verifyRunChain(run.id),
    audit: audit.map(({ sequenceNo, operation, decision }) => ({ sequenceNo, operation, decision }))
  }, null, 2)}\n`);
} finally {
  store.close();
  await rm(dataDir, { recursive: true, force: true });
}
