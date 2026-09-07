import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalService,
  LocalStore,
  NetworkGatewayError,
  ReadOnlyNetworkGateway,
  isPublicNetworkAddress,
  type NetworkGatewayResolver,
  type NetworkGatewayTransport,
  type NetworkGatewayTransportRequest,
  type NetworkGatewayTransportResponse,
  type ResolvedNetworkAddress
} from "./index.js";

const directories: string[] = [];
const PUBLIC_ADDRESS = "93.184.216.34";

class FixtureResolver implements NetworkGatewayResolver {
  readonly calls: string[] = [];

  constructor(
    private readonly addresses: Record<string, ResolvedNetworkAddress[]> = {
      "api.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }]
    }
  ) {}

  async resolve(hostname: string): Promise<ResolvedNetworkAddress[]> {
    this.calls.push(hostname);
    return this.addresses[hostname] ?? [];
  }
}

class FixtureTransport implements NetworkGatewayTransport {
  readonly calls: NetworkGatewayTransportRequest[] = [];
  readonly closed: boolean[] = [];

  constructor(
    private readonly responses: Array<{
      statusCode?: number;
      headers?: Record<string, string | string[] | undefined>;
      chunks?: Array<string | Uint8Array>;
      remoteAddress?: string;
    }> = [{ chunks: ["fixture response"] }]
  ) {}

  async request(input: NetworkGatewayTransportRequest): Promise<NetworkGatewayTransportResponse> {
    const index = this.calls.length;
    this.calls.push(input);
    this.closed[index] = false;
    const response = this.responses[index] ?? this.responses.at(-1) ?? {};
    return {
      statusCode: response.statusCode ?? 200,
      headers: response.headers ?? { "content-type": "text/plain" },
      body: chunks(response.chunks ?? []),
      remoteAddress: response.remoteAddress ?? input.address.address,
      close: () => {
        this.closed[index] = true;
      }
    };
  }
}

async function* chunks(values: Array<string | Uint8Array>): AsyncIterable<Uint8Array> {
  for (const value of values) yield typeof value === "string" ? Buffer.from(value) : value;
}

async function fixture(input: {
  allowlist?: string[];
  approvalAllowlist?: string[];
  resolver?: NetworkGatewayResolver;
  transport?: NetworkGatewayTransport;
  maxResponseBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "afr-network-gateway-test-"));
  directories.push(root);
  const dataDir = join(root, "afr-data");
  const now = () => new Date("2026-09-06T06:00:00.000Z");
  const store = new LocalStore(dataDir, now);
  const run = store.createRun({ projectPath: root, task: "read docs", agentId: "fixture-agent" });
  store.transitionRun(run.id, "running");
  const createdSession = store.createProviderSession({
    runId: run.id,
    provider: "fixture",
    adapterVersion: "fixture",
    runtimeVersion: "fixture",
    protocolVersion: "fixture",
    mode: "hosted-observed",
    capabilities: {
      networkMediation: { state: "degraded", source: "fixture", version: "H8-B" }
    }
  }).session;
  store.transitionProviderSession({ sessionId: createdSession.id, status: "starting" });
  const session = store.transitionProviderSession({
    sessionId: createdSession.id,
    status: "running",
    externalSessionId: "fixture-thread"
  });
  const allowlist = input.allowlist ?? ["api.example.com"];
  const approvals = new ApprovalService(store, {
    dataDir,
    homeDir: root,
    networkReadAllowlist: input.approvalAllowlist ?? allowlist,
    now
  });
  const resolver = input.resolver ?? new FixtureResolver();
  const transport = input.transport ?? new FixtureTransport();
  const gateway = new ReadOnlyNetworkGateway(store, approvals, {
    allowlist,
    resolver,
    transport,
    now,
    ...(input.maxResponseBytes === undefined ? {} : { maxResponseBytes: input.maxResponseBytes }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.maxRedirects === undefined ? {} : { maxRedirects: input.maxRedirects })
  });
  return { root, store, run, session, approvals, resolver, transport, gateway };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("ReadOnlyNetworkGateway", () => {
  it("executes an allowlisted GET with a pinned public address and one-time grant", async () => {
    const transport = new FixtureTransport([{
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=secret",
        "x-internal": "not retained"
      },
      chunks: ["{\"ok\":", "true}"]
    }]);
    const current = await fixture({ transport });
    const result = await current.gateway.request({
      sessionId: current.session.id,
      url: "https://api.example.com/v1/data?token=not-persisted",
      headers: { Accept: "application/json" }
    });

    expect(result).toMatchObject({
      runId: current.run.id,
      method: "GET",
      statusCode: 200,
      finalOrigin: "https://api.example.com",
      byteSize: 11,
      redirectCount: 0,
      responseHeaders: { "content-type": "application/json" }
    });
    expect(result.body.toString()).toBe("{\"ok\":true}");
    expect(result.responseHash).toBe(createHash("sha256").update(result.body).digest("hex"));
    expect(transport.calls[0]).toMatchObject({
      method: "GET",
      address: { address: PUBLIC_ADDRESS, family: 4 },
      headers: { accept: "application/json" }
    });
    expect(transport.closed).toEqual([true]);

    const eventTypes = current.store.listEvents(current.run.id).map((event) => event.eventType);
    expect(eventTypes).toContain("approval.consumed");
    expect(eventTypes).toContain("tool.call_completed");
    const audit = current.store.listNetworkMediationRecords(current.session.id);
    expect(audit.map((record) => [record.operation, record.decision])).toEqual([
      ["network.gateway.request", "control-allowed"],
      ["network.gateway.hop", "observed"],
      ["network.gateway.result", "observed"]
    ]);
    const persisted = JSON.stringify({ events: current.store.listEvents(current.run.id), audit });
    expect(persisted).not.toContain("not-persisted");
    expect(persisted).not.toContain("{\"ok\":true}");
    expect(persisted).not.toContain("session=secret");
    expect(persisted).toContain(result.responseHash);
    current.store.close();
  });

  it("supports HEAD without consuming or persisting a response body", async () => {
    const transport = new FixtureTransport([{
      statusCode: 204,
      headers: { etag: "fixture" },
      chunks: ["must not be read"]
    }]);
    const current = await fixture({ transport });
    const result = await current.gateway.request({
      sessionId: current.session.id,
      url: "https://api.example.com/health",
      method: "HEAD"
    });

    expect(result.body).toHaveLength(0);
    expect(result.responseHash).toBe(createHash("sha256").update("").digest("hex"));
    expect(transport.closed).toEqual([true]);
    current.store.close();
  });

  it.each([
    ["write method", { url: "https://api.example.com/", method: "POST" }, "method_not_allowed"],
    ["URL credentials", { url: "https://user:secret@api.example.com/" }, "credentials_forbidden"],
    ["unlisted host", { url: "https://other.example.com/" }, "host_not_allowlisted"],
    ["non-default port", { url: "https://api.example.com:8443/" }, "port_not_allowed"],
    ["authorization header", { url: "https://api.example.com/", headers: { Authorization: "Bearer secret" } }, "header_not_allowed"],
    ["cookie header", { url: "https://api.example.com/", headers: { Cookie: "session=secret" } }, "header_not_allowed"]
  ])("rejects %s before opening a socket", async (_label, request, code) => {
    const transport = new FixtureTransport();
    const current = await fixture({ transport });
    await expect(current.gateway.request({
      sessionId: current.session.id,
      ...request
    } as Parameters<ReadOnlyNetworkGateway["request"]>[0])).rejects.toMatchObject({ code });
    expect(transport.calls).toHaveLength(0);
    expect(current.store.listNetworkMediationRecords(current.session.id).at(-1)).toMatchObject({
      decision: "denied",
      evidence: { errorCode: code }
    });
    current.store.close();
  });

  it("requires policy configuration to independently allow the same target", async () => {
    const current = await fixture({ approvalAllowlist: [] });
    await expect(current.gateway.request({
      sessionId: current.session.id,
      url: "https://api.example.com/data"
    })).rejects.toMatchObject({ code: "policy_denied" });
    expect((current.transport as FixtureTransport).calls).toHaveLength(0);
    expect(current.store.listEvents(current.run.id).at(-1)).toMatchObject({
      eventType: "tool.call_failed",
      payload: { errorCode: "policy_denied" }
    });
    current.store.close();
  });

  it("rejects private, loopback, link-local, metadata and mixed DNS answers", async () => {
    for (const addresses of [
      [{ address: "127.0.0.1", family: 4 as const }],
      [{ address: "10.0.0.1", family: 4 as const }],
      [{ address: "169.254.169.254", family: 4 as const }],
      [{ address: "::1", family: 6 as const }],
      [
        { address: PUBLIC_ADDRESS, family: 4 as const },
        { address: "192.168.1.2", family: 4 as const }
      ]
    ]) {
      const transport = new FixtureTransport();
      const current = await fixture({
        resolver: new FixtureResolver({ "api.example.com": addresses }),
        transport
      });
      await expect(current.gateway.request({
        sessionId: current.session.id,
        url: "https://api.example.com/data"
      })).rejects.toMatchObject({ code: "address_not_public" });
      expect(transport.calls).toHaveLength(0);
      current.store.close();
    }
  });

  it("revalidates every redirect and rejects a rebinding target", async () => {
    const resolver = new FixtureResolver({
      "api.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
      "internal.example.com": [{ address: "127.0.0.1", family: 4 }]
    });
    const transport = new FixtureTransport([{
      statusCode: 302,
      headers: { location: "https://internal.example.com/admin" }
    }]);
    const current = await fixture({ allowlist: ["*.example.com"], resolver, transport });

    await expect(current.gateway.request({
      sessionId: current.session.id,
      url: "https://api.example.com/start"
    })).rejects.toMatchObject({ code: "address_not_public" });
    expect(resolver.calls).toEqual(["api.example.com", "internal.example.com"]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.closed).toEqual([true]);
    current.store.close();
  });

  it("rejects a transport whose connected peer differs from the pinned DNS address", async () => {
    const transport = new FixtureTransport([{ remoteAddress: "8.8.8.8" }]);
    const current = await fixture({ transport });
    await expect(current.gateway.request({
      sessionId: current.session.id,
      url: "https://api.example.com/data"
    })).rejects.toMatchObject({ code: "remote_address_mismatch" });
    expect(transport.closed).toEqual([true]);
    current.store.close();
  });

  it("enforces streamed response size and total timeout", async () => {
    const oversized = await fixture({
      maxResponseBytes: 5,
      transport: new FixtureTransport([{ chunks: ["123", "456"] }])
    });
    await expect(oversized.gateway.request({
      sessionId: oversized.session.id,
      url: "https://api.example.com/data"
    })).rejects.toMatchObject({ code: "response_too_large" });
    oversized.store.close();

    const timeoutTransport: NetworkGatewayTransport = {
      request: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    };
    const timedOut = await fixture({ timeoutMs: 10, transport: timeoutTransport });
    await expect(timedOut.gateway.request({
      sessionId: timedOut.session.id,
      url: "https://api.example.com/data"
    })).rejects.toMatchObject({ code: "timeout" });
    timedOut.store.close();
  });
});

describe("public network address classification", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1"
  ])("rejects %s", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("accepts %s", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(true);
  });
});
