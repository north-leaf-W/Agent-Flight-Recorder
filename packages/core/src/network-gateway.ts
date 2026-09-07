import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

import { EVENT_SCHEMA_VERSION, type ActionContext, type IncomingEvent } from "@afr/protocol";
import { v7 as uuidv7 } from "uuid";

import { ApprovalService, type ActionEvaluation } from "./approval.js";
import { canonicalJson } from "./canonical-json.js";
import { LocalStore } from "./local-store.js";
import {
  isNetworkHostAllowed,
  normalizeNetworkHostRule,
  normalizeNetworkHostname
} from "./policy.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_ALLOWED_PORTS = [80, 443] as const;
const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "range"
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type ReadOnlyNetworkMethod = "GET" | "HEAD";

export type ResolvedNetworkAddress = {
  address: string;
  family: 4 | 6;
};

export interface NetworkGatewayResolver {
  resolve(hostname: string): Promise<ResolvedNetworkAddress[]>;
}

export type NetworkGatewayTransportRequest = {
  url: string;
  method: ReadOnlyNetworkMethod;
  headers: Record<string, string>;
  address: ResolvedNetworkAddress;
  signal: AbortSignal;
};

export type NetworkGatewayTransportResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  remoteAddress: string;
  close(): void;
};

export interface NetworkGatewayTransport {
  request(input: NetworkGatewayTransportRequest): Promise<NetworkGatewayTransportResponse>;
}

export type ReadOnlyNetworkGatewayOptions = {
  allowlist: string[];
  allowedPorts?: number[];
  maxResponseBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolver?: NetworkGatewayResolver;
  transport?: NetworkGatewayTransport;
  now?: () => Date;
};

export type ReadOnlyNetworkRequest = {
  sessionId: string;
  url: string;
  method?: ReadOnlyNetworkMethod;
  headers?: Record<string, string>;
};

export type ReadOnlyNetworkResult = {
  gatewayRequestId: string;
  runId: string;
  method: ReadOnlyNetworkMethod;
  statusCode: number;
  finalUrlHash: string;
  finalOrigin: string;
  responseHash: string;
  byteSize: number;
  redirectCount: number;
  responseHeaders: Record<string, string>;
  body: Buffer;
};

export type NetworkGatewayErrorCode =
  | "invalid_config"
  | "session_not_found"
  | "session_not_running"
  | "run_not_found"
  | "run_not_running"
  | "method_not_allowed"
  | "url_invalid"
  | "scheme_not_allowed"
  | "credentials_forbidden"
  | "host_not_allowlisted"
  | "port_not_allowed"
  | "header_not_allowed"
  | "policy_denied"
  | "grant_missing"
  | "dns_resolution_failed"
  | "address_not_public"
  | "remote_address_mismatch"
  | "redirect_invalid"
  | "too_many_redirects"
  | "response_too_large"
  | "response_encoding_not_allowed"
  | "response_invalid"
  | "timeout"
  | "transport_failed";

export class NetworkGatewayError extends Error {
  constructor(
    readonly code: NetworkGatewayErrorCode,
    message: string,
    readonly gatewayRequestId?: string
  ) {
    super(message);
    this.name = "NetworkGatewayError";
  }
}

type PreparedRequest = {
  url: URL;
  method: ReadOnlyNetworkMethod;
  headers: Record<string, string>;
  requestHash: string;
  target: ReturnType<typeof summarizeUrl>;
};

type HopResult = {
  response: NetworkGatewayTransportResponse;
  address: ResolvedNetworkAddress;
};

export class ReadOnlyNetworkGateway {
  private readonly allowlist: string[];
  private readonly allowedPorts: number[];
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly resolver: NetworkGatewayResolver;
  private readonly transport: NetworkGatewayTransport;
  private readonly now: () => Date;

  constructor(
    readonly store: LocalStore,
    readonly approvals: ApprovalService,
    options: ReadOnlyNetworkGatewayOptions
  ) {
    for (const rule of options.allowlist) {
      if (normalizeNetworkHostRule(rule) === undefined) {
        throw new NetworkGatewayError("invalid_config", `Invalid network allowlist rule: ${rule}`);
      }
    }
    const allowedPorts = options.allowedPorts ?? [...DEFAULT_ALLOWED_PORTS];
    if (allowedPorts.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
      throw new NetworkGatewayError("invalid_config", "Network Gateway ports must be between 1 and 65535");
    }
    this.allowlist = [...options.allowlist];
    this.allowedPorts = [...new Set(allowedPorts)];
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes"
    );
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxRedirects = nonNegativeInteger(
      options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      "maxRedirects"
    );
    this.resolver = options.resolver ?? new SystemNetworkResolver();
    this.transport = options.transport ?? new NodeNetworkTransport();
    this.now = options.now ?? (() => new Date());
  }

  async request(input: ReadOnlyNetworkRequest): Promise<ReadOnlyNetworkResult> {
    const gatewayRequestId = uuidv7();
    const session = this.store.getProviderSession(input.sessionId);
    if (session === undefined) {
      throw new NetworkGatewayError(
        "session_not_found",
        `Provider session does not exist: ${input.sessionId}`,
        gatewayRequestId
      );
    }
    if (session.status !== "running") {
      this.auditDenied(session.id, gatewayRequestId, "session_not_running", {
        sessionStatus: session.status
      });
      throw new NetworkGatewayError(
        "session_not_running",
        `Network Gateway requires a running Provider session: ${session.status}`,
        gatewayRequestId
      );
    }
    const run = this.store.getRun(session.runId);
    if (run === undefined) {
      throw new NetworkGatewayError("run_not_found", `Run does not exist: ${session.runId}`, gatewayRequestId);
    }
    if (run.status !== "running") {
      this.auditDenied(session.id, gatewayRequestId, "run_not_running", { runStatus: run.status });
      throw new NetworkGatewayError(
        "run_not_running",
        `Network Gateway requires a running Run: ${run.status}`,
        gatewayRequestId
      );
    }

    let prepared: PreparedRequest;
    try {
      prepared = this.prepare(input);
    } catch (error) {
      const gatewayError = withRequestId(error, gatewayRequestId);
      this.auditDenied(session.id, gatewayRequestId, gatewayError.code);
      throw gatewayError;
    }

    const context = this.actionContext(run.id, run.agentId, run.projectPath, prepared);
    this.store.appendEvents(run.id, [this.requestedEvent(run.id, gatewayRequestId, prepared)]);
    const evaluation = this.approvals.evaluate(context, "Read an allowlisted external resource");
    if (evaluation.decision.effect !== "allow") {
      this.auditDenied(session.id, gatewayRequestId, "policy_denied", {
        ruleId: evaluation.decision.ruleId,
        reasonCodes: evaluation.decision.reasonCodes
      });
      this.store.appendEvents(run.id, [
        this.failedEvent(run.id, gatewayRequestId, "policy_denied", evaluation)
      ]);
      throw new NetworkGatewayError(
        "policy_denied",
        `Network Gateway request denied by ${evaluation.decision.ruleId}`,
        gatewayRequestId
      );
    }
    if (evaluation.grant === undefined) {
      this.auditDenied(session.id, gatewayRequestId, "grant_missing");
      throw new NetworkGatewayError(
        "grant_missing",
        "Allowed Network Gateway request did not receive a one-time grant",
        gatewayRequestId
      );
    }
    this.approvals.consume(evaluation.grant.token, evaluation.actionContext);
    this.store.appendEvents(run.id, [this.startedEvent(run.id, gatewayRequestId, prepared, evaluation)]);
    this.store.recordNetworkMediation({
      sessionId: session.id,
      source: "host",
      operation: "network.gateway.request",
      decision: "control-allowed",
      requestedPolicy: {
        gatewayRequestId,
        method: prepared.method,
        target: prepared.target,
        requestHash: prepared.requestHash,
        headerNames: Object.keys(prepared.headers).sort()
      },
      effectivePolicy: {
        allowlist: this.allowlist,
        allowedPorts: this.allowedPorts,
        maxResponseBytes: this.maxResponseBytes,
        timeoutMs: this.timeoutMs,
        maxRedirects: this.maxRedirects,
        credentials: "forbidden",
        methods: ["GET", "HEAD"]
      },
      evidence: {
        actionDigest: evaluation.actionDigest,
        grantId: evaluation.grant.grantId,
        grantConsumed: true
      }
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await this.execute(
        session.id,
        run.id,
        gatewayRequestId,
        prepared,
        controller.signal
      );
      this.store.appendEvents(run.id, [this.completedEvent(result)]);
      return result;
    } catch (error) {
      const gatewayError = controller.signal.aborted
        ? new NetworkGatewayError(
            "timeout",
            `Network Gateway timed out after ${this.timeoutMs}ms`,
            gatewayRequestId
          )
        : withRequestId(error, gatewayRequestId, "transport_failed");
      this.store.recordNetworkMediation({
        sessionId: session.id,
        source: "observer",
        operation: "network.gateway.result",
        decision: gatewayError.code === "transport_failed" ? "degraded" : "denied",
        evidence: { gatewayRequestId, errorCode: gatewayError.code }
      });
      this.store.appendEvents(run.id, [
        this.failedEvent(run.id, gatewayRequestId, gatewayError.code, evaluation)
      ]);
      throw gatewayError;
    } finally {
      clearTimeout(timeout);
    }
  }

  private prepare(input: ReadOnlyNetworkRequest): PreparedRequest {
    const method = (input.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw new NetworkGatewayError("method_not_allowed", "Network Gateway only supports GET and HEAD");
    }
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new NetworkGatewayError("url_invalid", "Network Gateway URL is invalid");
    }
    url.hash = "";
    this.assertUrlAllowed(url);
    const headers = canonicalRequestHeaders(input.headers ?? {});
    const requestHash = sha256(canonicalJson({ method, url: url.href, headers }));
    return { url, method, headers, requestHash, target: summarizeUrl(url) };
  }

  private actionContext(
    runId: string,
    agentId: string,
    projectPath: string,
    prepared: PreparedRequest
  ): ActionContext {
    return {
      runId,
      actor: { id: agentId, type: "agent" },
      tool: "network.read",
      action: prepared.method.toLowerCase(),
      argv: [prepared.method],
      cwd: projectPath,
      targets: [{ type: "network", canonicalId: prepared.target.origin }],
      environment: "local",
      sideEffect: "none",
      recoverability: "easy",
      contentHash: prepared.requestHash,
      estimatedImpact: {
        maxResponseBytes: this.maxResponseBytes,
        maxRedirects: this.maxRedirects
      }
    };
  }

  private async execute(
    sessionId: string,
    runId: string,
    gatewayRequestId: string,
    prepared: PreparedRequest,
    signal: AbortSignal
  ): Promise<ReadOnlyNetworkResult> {
    let current = prepared.url;
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      this.assertNotAborted(signal);
      this.assertUrlAllowed(current);
      const hop = await this.openHop(current, prepared.method, prepared.headers, signal);
      this.store.recordNetworkMediation({
        sessionId,
        source: "observer",
        operation: "network.gateway.hop",
        decision: "observed",
        requestedPolicy: {
          gatewayRequestId,
          redirectCount,
          target: summarizeUrl(current),
          urlHash: sha256(current.href)
        },
        evidence: {
          statusCode: hop.response.statusCode,
          selectedAddress: hop.address.address,
          addressFamily: hop.address.family,
          remoteAddress: hop.response.remoteAddress
        }
      });

      if (REDIRECT_STATUSES.has(hop.response.statusCode)) {
        const location = firstHeader(hop.response.headers.location);
        hop.response.close();
        if (location === undefined) {
          throw new NetworkGatewayError(
            "redirect_invalid",
            "Redirect response did not contain exactly one Location header"
          );
        }
        if (redirectCount >= this.maxRedirects) {
          throw new NetworkGatewayError("too_many_redirects", "Network Gateway redirect limit exceeded");
        }
        try {
          current = new URL(location, current);
          current.hash = "";
        } catch {
          throw new NetworkGatewayError("redirect_invalid", "Redirect Location is invalid");
        }
        continue;
      }

      const body = prepared.method === "HEAD"
        ? closeWithoutBody(hop.response)
        : await readBoundedBody(hop.response, this.maxResponseBytes, signal);
      const result: ReadOnlyNetworkResult = {
        gatewayRequestId,
        runId,
        method: prepared.method,
        statusCode: hop.response.statusCode,
        finalUrlHash: sha256(current.href),
        finalOrigin: current.origin,
        responseHash: sha256(body),
        byteSize: body.byteLength,
        redirectCount,
        responseHeaders: safeResponseHeaders(hop.response.headers),
        body
      };
      this.store.recordNetworkMediation({
        sessionId,
        source: "observer",
        operation: "network.gateway.result",
        decision: "observed",
        evidence: {
          gatewayRequestId,
          statusCode: result.statusCode,
          finalUrlHash: result.finalUrlHash,
          finalOrigin: result.finalOrigin,
          responseHash: result.responseHash,
          byteSize: result.byteSize,
          redirectCount: result.redirectCount,
          responseHeaders: result.responseHeaders,
          bodyPersisted: false
        }
      });
      return result;
    }
    throw new NetworkGatewayError("too_many_redirects", "Network Gateway redirect limit exceeded");
  }

  private async openHop(
    url: URL,
    method: ReadOnlyNetworkMethod,
    headers: Record<string, string>,
    signal: AbortSignal
  ): Promise<HopResult> {
    const hostname = normalizeNetworkHostname(url.hostname);
    let addresses: ResolvedNetworkAddress[];
    try {
      addresses = isIP(hostname) === 0
        ? await raceAbort(this.resolver.resolve(hostname), signal)
        : [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
    } catch (error) {
      if (signal.aborted) throw error;
      throw new NetworkGatewayError("dns_resolution_failed", "Network Gateway DNS resolution failed");
    }
    if (addresses.length === 0) {
      throw new NetworkGatewayError("dns_resolution_failed", "Network Gateway DNS returned no addresses");
    }
    const normalized = addresses.map(normalizeResolvedAddress);
    if (normalized.some((address) => !isPublicNetworkAddress(address.address))) {
      throw new NetworkGatewayError(
        "address_not_public",
        "Network Gateway rejected a non-public destination address"
      );
    }
    const selected = normalized[0] as ResolvedNetworkAddress;
    let response: NetworkGatewayTransportResponse;
    try {
      response = await this.transport.request({
        url: url.href,
        method,
        headers,
        address: selected,
        signal
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new NetworkGatewayError("transport_failed", "Network Gateway transport failed");
    }
    if (!Number.isSafeInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
      response.close();
      throw new NetworkGatewayError("response_invalid", "Network Gateway received an invalid HTTP status");
    }
    const remoteAddress = normalizeIpAddress(response.remoteAddress);
    if (
      !isPublicNetworkAddress(remoteAddress) ||
      !addressesEqual(remoteAddress, selected.address)
    ) {
      response.close();
      throw new NetworkGatewayError(
        "remote_address_mismatch",
        "Network Gateway connected to an address other than the validated DNS result"
      );
    }
    return { response, address: selected };
  }

  private assertUrlAllowed(url: URL): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new NetworkGatewayError("scheme_not_allowed", "Network Gateway only supports HTTP and HTTPS");
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new NetworkGatewayError("credentials_forbidden", "URL credentials are forbidden");
    }
    const hostname = normalizeNetworkHostname(url.hostname);
    if (!isNetworkHostAllowed(hostname, this.allowlist)) {
      throw new NetworkGatewayError("host_not_allowlisted", "Network destination is not allowlisted");
    }
    const port = effectivePort(url);
    if (!this.allowedPorts.includes(port)) {
      throw new NetworkGatewayError("port_not_allowed", `Network destination port is not allowed: ${port}`);
    }
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new NetworkGatewayError("timeout", `Network Gateway timed out after ${this.timeoutMs}ms`);
    }
  }

  private auditDenied(
    sessionId: string,
    gatewayRequestId: string,
    errorCode: NetworkGatewayErrorCode,
    evidence: Record<string, unknown> = {}
  ): void {
    this.store.recordNetworkMediation({
      sessionId,
      source: "host",
      operation: "network.gateway.request",
      decision: "denied",
      effectivePolicy: {
        methods: ["GET", "HEAD"],
        allowedPorts: this.allowedPorts,
        allowlist: this.allowlist
      },
      evidence: { gatewayRequestId, errorCode, ...evidence }
    });
  }

  private requestedEvent(
    runId: string,
    gatewayRequestId: string,
    prepared: PreparedRequest
  ): IncomingEvent {
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId,
      occurredAt: this.now().toISOString(),
      actor: { type: "system", id: "afr-network-gateway" },
      eventType: "tool.call_requested",
      status: "pending",
      payload: {
        tool: "network.read",
        gatewayRequestId,
        method: prepared.method,
        target: prepared.target,
        requestHash: prepared.requestHash,
        headerNames: Object.keys(prepared.headers).sort()
      }
    };
  }

  private startedEvent(
    runId: string,
    gatewayRequestId: string,
    prepared: PreparedRequest,
    evaluation: ActionEvaluation
  ): IncomingEvent {
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId,
      occurredAt: this.now().toISOString(),
      actor: { type: "system", id: "afr-network-gateway" },
      eventType: "tool.call_started",
      status: "pending",
      payload: {
        tool: "network.read",
        gatewayRequestId,
        method: prepared.method,
        target: prepared.target,
        requestHash: prepared.requestHash,
        actionDigest: evaluation.actionDigest,
        grantId: evaluation.grant?.grantId ?? null
      }
    };
  }

  private completedEvent(result: ReadOnlyNetworkResult): IncomingEvent {
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId: result.runId,
      occurredAt: this.now().toISOString(),
      actor: { type: "system", id: "afr-network-gateway" },
      eventType: "tool.call_completed",
      status: "success",
      payload: {
        tool: "network.read",
        gatewayRequestId: result.gatewayRequestId,
        method: result.method,
        statusCode: result.statusCode,
        finalUrlHash: result.finalUrlHash,
        finalOrigin: result.finalOrigin,
        responseHash: result.responseHash,
        byteSize: result.byteSize,
        redirectCount: result.redirectCount,
        responseHeaders: result.responseHeaders,
        bodyPersisted: false
      }
    };
  }

  private failedEvent(
    runId: string,
    gatewayRequestId: string,
    errorCode: NetworkGatewayErrorCode,
    evaluation?: ActionEvaluation
  ): IncomingEvent {
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: uuidv7(),
      runId,
      occurredAt: this.now().toISOString(),
      actor: { type: "system", id: "afr-network-gateway" },
      eventType: "tool.call_failed",
      status: "error",
      payload: {
        tool: "network.read",
        gatewayRequestId,
        errorCode,
        ...(evaluation === undefined ? {} : { actionDigest: evaluation.actionDigest })
      }
    };
  }
}

class SystemNetworkResolver implements NetworkGatewayResolver {
  async resolve(hostname: string): Promise<ResolvedNetworkAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => {
      if (family !== 4 && family !== 6) {
        throw new NetworkGatewayError(
          "dns_resolution_failed",
          "System DNS returned an unsupported address family"
        );
      }
      return { address, family };
    });
  }
}

class NodeNetworkTransport implements NetworkGatewayTransport {
  async request(input: NetworkGatewayTransportRequest): Promise<NetworkGatewayTransportResponse> {
    const url = new URL(input.url);
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: input.address.address,
      family: input.address.family,
      port: effectivePort(url),
      path: `${url.pathname}${url.search}`,
      method: input.method,
      headers: {
        ...input.headers,
        host: url.host,
        "user-agent": "AFR-ReadOnly-Network-Gateway/0.1",
        "accept-encoding": "identity",
        connection: "close"
      },
      signal: input.signal,
      maxHeaderSize: 16 * 1024,
      ...(url.protocol === "https:" && isIP(normalizeNetworkHostname(url.hostname)) === 0
        ? { servername: normalizeNetworkHostname(url.hostname) }
        : {})
    };
    return new Promise((resolveRequest, rejectRequest) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(options, (response) => {
        resolveRequest({
          statusCode: response.statusCode ?? 0,
          headers: normalizeIncomingHeaders(response.headers),
          body: response,
          remoteAddress: response.socket.remoteAddress ?? "",
          close: () => response.destroy()
        });
      });
      request.once("error", rejectRequest);
      request.end();
    });
  }
}

function normalizeIncomingHeaders(headers: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) normalized[name.toLowerCase()] = value;
  return normalized;
}

function canonicalRequestHeaders(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.trim().toLowerCase();
    if (!SAFE_REQUEST_HEADERS.has(name)) {
      throw new NetworkGatewayError("header_not_allowed", `Network request header is not allowed: ${rawName}`);
    }
    if (rawValue.includes("\r") || rawValue.includes("\n")) {
      throw new NetworkGatewayError("header_not_allowed", "Network request header contains a newline");
    }
    output[name] = rawValue;
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function summarizeUrl(url: URL): {
  origin: string;
  pathHash: string;
  queryParameterNames: string[];
} {
  return {
    origin: url.origin,
    pathHash: sha256(url.pathname),
    queryParameterNames: [...new Set(url.searchParams.keys())].sort()
  };
}

function effectivePort(url: URL): number {
  return url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
}

function normalizeResolvedAddress(address: ResolvedNetworkAddress): ResolvedNetworkAddress {
  const normalized = normalizeIpAddress(address.address);
  const family = isIP(normalized);
  if (family !== 4 && family !== 6) {
    throw new NetworkGatewayError("dns_resolution_failed", "Network Gateway DNS returned an invalid address");
  }
  if (family !== address.family) {
    throw new NetworkGatewayError("dns_resolution_failed", "Network Gateway DNS returned a mismatched address family");
  }
  return { address: normalized, family };
}

function normalizeIpAddress(address: string): string {
  const withoutZone = address.includes("%") ? address.slice(0, address.indexOf("%")) : address;
  const mapped = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped?.[1] ?? withoutZone.toLowerCase();
}

const nonPublicAddresses = createNonPublicBlockList();

export function isPublicNetworkAddress(address: string): boolean {
  if (address.toLowerCase().startsWith("::ffff:")) return false;
  const normalized = normalizeIpAddress(address);
  const family = isIP(normalized);
  if (family === 4) return !nonPublicAddresses.check(normalized, "ipv4");
  if (family === 6) return !nonPublicAddresses.check(normalized, "ipv6");
  return false;
}

function createNonPublicBlockList(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001:2::", 48],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8]
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
}

function addressesEqual(left: string, right: string): boolean {
  return normalizeIpAddress(left) === normalizeIpAddress(right);
}

async function readBoundedBody(
  response: NetworkGatewayTransportResponse,
  maxResponseBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  const contentEncoding = firstHeader(response.headers["content-encoding"]);
  if (contentEncoding !== undefined && contentEncoding.trim().toLowerCase() !== "identity") {
    response.close();
    throw new NetworkGatewayError(
      "response_encoding_not_allowed",
      "Encoded network responses are not allowed"
    );
  }
  const declaredLength = firstHeader(response.headers["content-length"]);
  if (declaredLength !== undefined) {
    const parsed = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsed) && parsed > maxResponseBytes) {
      response.close();
      throw new NetworkGatewayError("response_too_large", "Network response exceeds the configured size limit");
    }
  }
  const chunks: Buffer[] = [];
  let byteSize = 0;
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw new NetworkGatewayError("timeout", "Network Gateway request timed out");
      const buffer = Buffer.from(chunk);
      byteSize += buffer.byteLength;
      if (byteSize > maxResponseBytes) {
        throw new NetworkGatewayError("response_too_large", "Network response exceeds the configured size limit");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, byteSize);
  } finally {
    response.close();
  }
}

function closeWithoutBody(response: NetworkGatewayTransportResponse): Buffer {
  response.close();
  return Buffer.alloc(0);
}

function safeResponseHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const allowed = ["cache-control", "content-length", "content-type", "etag", "last-modified"];
  const output: Record<string, string> = {};
  for (const name of allowed) {
    const value = firstHeader(headers[name]);
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1) return value[0];
  return undefined;
}

function withRequestId(
  error: unknown,
  gatewayRequestId: string,
  fallback: NetworkGatewayErrorCode = "url_invalid"
): NetworkGatewayError {
  if (error instanceof NetworkGatewayError) {
    return new NetworkGatewayError(error.code, error.message, gatewayRequestId);
  }
  return new NetworkGatewayError(fallback, error instanceof Error ? error.message : String(error), gatewayRequestId);
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("aborted");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NetworkGatewayError("invalid_config", `${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NetworkGatewayError("invalid_config", `${name} must be a non-negative integer`);
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
