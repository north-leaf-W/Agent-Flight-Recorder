import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";

import {
  isNetworkHostAllowed,
  isPublicNetworkAddress,
  normalizeNetworkHostRule,
  normalizeNetworkHostname
} from "@afr/core";

import type { NetworkMediationAuditEvent } from "./network-mediation.js";

const DEFAULT_ALLOWED_PORTS = [443] as const;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;

export type ProviderEgressAddress = {
  address: string;
  family: 4 | 6;
};

export interface ProviderEgressResolver {
  resolve(hostname: string): Promise<ProviderEgressAddress[]>;
}

export type ProviderEgressOptions = {
  allowlist: string[];
  allowedPorts?: number[];
  allowSyntheticDnsRange?: boolean;
  trustedPrivateAddresses?: string[];
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  resolver?: ProviderEgressResolver;
  sandboxExecutable?: string;
};

export type ProviderEgressProxyOptions = ProviderEgressOptions & {
  onAudit?: (event: NetworkMediationAuditEvent) => void;
};

export type ProviderEgressEndpoint = {
  hostname: "127.0.0.1";
  port: number;
  proxyUrl: string;
};

export type ProviderEgressTarget = {
  hostname: string;
  port: number;
  address: ProviderEgressAddress;
};

export type ProviderEgressErrorCode =
  | "invalid_config"
  | "sandbox_unavailable"
  | "proxy_not_started"
  | "proxy_authentication_failed"
  | "method_not_allowed"
  | "authority_invalid"
  | "host_not_allowlisted"
  | "port_not_allowed"
  | "dns_resolution_failed"
  | "address_not_public"
  | "remote_address_mismatch"
  | "connect_timeout"
  | "connect_failed";

export class ProviderEgressError extends Error {
  constructor(readonly code: ProviderEgressErrorCode, message: string) {
    super(message);
    this.name = "ProviderEgressError";
  }
}

/**
 * CONNECT-only proxy used by Hosted Codex for its Provider control channel.
 * The Codex process is separately placed in a macOS sandbox that permits
 * network access only to this proxy's loopback port.
 */
export class ProviderEgressBoundary {
  private readonly allowlist: string[];
  private readonly allowedPorts: number[];
  private readonly allowSyntheticDnsRange: boolean;
  private readonly trustedPrivateAddresses: Set<string>;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly resolver: ProviderEgressResolver;
  private readonly onAudit: ((event: NetworkMediationAuditEvent) => void) | undefined;
  private readonly proxyToken = randomBytes(32).toString("base64url");
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private endpointValue: ProviderEgressEndpoint | undefined;

  constructor(options: ProviderEgressProxyOptions) {
    if (options.allowlist.length === 0) {
      throw new ProviderEgressError(
        "invalid_config",
        "Provider egress requires at least one explicitly allowlisted hostname"
      );
    }
    for (const rawRule of options.allowlist) {
      const rule = normalizeNetworkHostRule(rawRule);
      if (rule === undefined || isIP(rule.hostname) !== 0) {
        throw new ProviderEgressError(
          "invalid_config",
          `Invalid Provider egress hostname rule: ${rawRule}`
        );
      }
    }
    const ports = options.allowedPorts ?? [...DEFAULT_ALLOWED_PORTS];
    if (
      ports.length === 0 ||
      ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)
    ) {
      throw new ProviderEgressError(
        "invalid_config",
        "Provider egress ports must contain integers between 1 and 65535"
      );
    }
    this.allowlist = [...options.allowlist];
    this.allowedPorts = [...new Set(ports)];
    this.allowSyntheticDnsRange = options.allowSyntheticDnsRange ?? false;
    this.trustedPrivateAddresses = new Set(
      (options.trustedPrivateAddresses ?? []).map((address) => {
        const normalized = normalizeIpAddress(address);
        if (!isEnterprisePrivateAddress(normalized)) {
          throw new ProviderEgressError(
            "invalid_config",
            `Trusted Provider private address is not an eligible exact RFC1918 address: ${address}`
          );
        }
        return normalized;
      })
    );
    this.connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs"
    );
    this.idleTimeoutMs = positiveInteger(
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      "idleTimeoutMs"
    );
    this.resolver = options.resolver ?? new SystemProviderEgressResolver();
    this.onAudit = options.onAudit;
  }

  async start(): Promise<ProviderEgressEndpoint> {
    if (this.server !== undefined || this.endpointValue !== undefined) {
      throw new ProviderEgressError("invalid_config", "Provider egress proxy has already started");
    }
    const server = createServer({ maxHeaderSize: DEFAULT_MAX_HEADER_BYTES }, (request, response) => {
      this.auditDenied("method_not_allowed", request);
      response.writeHead(405, { connection: "close", "content-length": "0" });
      response.end();
    });
    server.on("connect", (request, client, head) => {
      void this.handleConnect(request, client as Socket, head);
    });
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectStart(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveStart();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      await closeServer(server);
      throw new ProviderEgressError("connect_failed", "Provider egress proxy did not bind TCP");
    }
    this.server = server;
    this.endpointValue = {
      hostname: "127.0.0.1",
      port: address.port,
      proxyUrl: `http://afr:${encodeURIComponent(this.proxyToken)}@127.0.0.1:${address.port}`
    };
    this.audit({
      source: "host",
      operation: "provider.egress.proxy",
      decision: "control-allowed",
      effectivePolicy: {
        transport: "connect-only",
        allowlist: [...this.allowlist],
        allowedPorts: [...this.allowedPorts],
        dnsPolicy: this.allowSyntheticDnsRange
          ? "all-addresses-public-or-198.18.0.0/15"
          : "all-addresses-public",
        trustedPrivateAddressCount: this.trustedPrivateAddresses.size,
        authentication: "per-host-random"
      },
      evidence: { loopbackPort: address.port }
    });
    return this.endpointValue;
  }

  endpoint(): ProviderEgressEndpoint {
    if (this.endpointValue === undefined) {
      throw new ProviderEgressError("proxy_not_started", "Provider egress proxy is not running");
    }
    return this.endpointValue;
  }

  environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const proxyUrl = this.endpoint().proxyUrl;
    return {
      ...base,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      NO_PROXY: "",
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
      no_proxy: ""
    };
  }

  spawnSpec(
    binary: string,
    args: string[],
    platform: NodeJS.Platform = process.platform,
    sandboxExecutable = "/usr/bin/sandbox-exec"
  ): { command: string; args: string[] } {
    const endpoint = this.endpoint();
    if (platform !== "darwin" || !existsSync(sandboxExecutable)) {
      throw new ProviderEgressError(
        "sandbox_unavailable",
        "Provider egress enforcement requires macOS sandbox-exec"
      );
    }
    return {
      command: sandboxExecutable,
      args: ["-p", providerEgressSandboxProfile(endpoint.port), "--", binary, ...args]
    };
  }

  async authorize(authority: string): Promise<ProviderEgressTarget> {
    const { hostname, port } = parseConnectAuthority(authority);
    if (!isNetworkHostAllowed(hostname, this.allowlist)) {
      throw new ProviderEgressError(
        "host_not_allowlisted",
        `Provider egress host is not allowlisted: ${hostname}`
      );
    }
    if (!this.allowedPorts.includes(port)) {
      throw new ProviderEgressError(
        "port_not_allowed",
        `Provider egress port is not allowed: ${port}`
      );
    }
    let addresses: ProviderEgressAddress[];
    try {
      addresses = await this.resolver.resolve(hostname);
    } catch (error) {
      if (error instanceof ProviderEgressError) throw error;
      throw new ProviderEgressError(
        "dns_resolution_failed",
        error instanceof Error ? error.message : "Provider egress DNS resolution failed"
      );
    }
    if (addresses.length === 0) {
      throw new ProviderEgressError(
        "dns_resolution_failed",
        "Provider egress DNS resolution returned no addresses"
      );
    }
    const normalized = addresses.map(normalizeAddress);
    if (normalized.some(({ address }) => !this.addressAllowed(address))) {
      throw new ProviderEgressError(
        "address_not_public",
        "Provider egress DNS returned a non-public address"
      );
    }
    return { hostname, port, address: normalized[0]! };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpointValue = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server !== undefined) await closeServer(server);
  }

  private async handleConnect(
    request: IncomingMessage,
    client: Socket,
    head: Buffer
  ): Promise<void> {
    this.trackSocket(client);
    let target: ProviderEgressTarget;
    try {
      if (!this.authenticated(request.headers["proxy-authorization"])) {
        throw new ProviderEgressError(
          "proxy_authentication_failed",
          "Provider egress proxy authentication failed"
        );
      }
      target = await this.authorize(request.url ?? "");
    } catch (error) {
      const boundaryError = asProviderEgressError(error);
      this.auditDenied(boundaryError.code, request);
      writeProxyFailure(client, boundaryError.code === "proxy_authentication_failed" ? 407 : 403);
      return;
    }

    const upstream = connect({
      host: target.address.address,
      port: target.port,
      family: target.address.family
    });
    this.trackSocket(upstream);
    const timer = setTimeout(() => {
      upstream.destroy(new ProviderEgressError("connect_timeout", "Provider egress connect timed out"));
    }, this.connectTimeoutMs);
    try {
      await new Promise<void>((resolveConnect, rejectConnect) => {
        upstream.once("connect", resolveConnect);
        upstream.once("error", rejectConnect);
      });
      clearTimeout(timer);
      if (!addressesEqual(upstream.remoteAddress ?? "", target.address.address)) {
        throw new ProviderEgressError(
          "remote_address_mismatch",
          "Provider egress remote address did not match the verified DNS address"
        );
      }
      upstream.setTimeout(this.idleTimeoutMs, () => upstream.destroy());
      client.setTimeout(this.idleTimeoutMs, () => client.destroy());
      this.audit({
        source: "observer",
        operation: "provider.egress.connect",
        decision: "control-allowed",
        effectivePolicy: { hostname: target.hostname, port: target.port },
        evidence: {
          addressFamily: target.address.family,
          addressHash: sha256(normalizeIpAddress(target.address.address))
        }
      });
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: AFR-Provider-Egress/0.1\r\n\r\n");
      if (head.byteLength > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch (error) {
      clearTimeout(timer);
      const boundaryError = asProviderEgressError(error, "connect_failed");
      this.auditDenied(boundaryError.code, request);
      upstream.destroy();
      writeProxyFailure(client, 502);
    }
  }

  private authenticated(header: string | string[] | undefined): boolean {
    if (typeof header !== "string") return false;
    const expected = Buffer.from(`Basic ${Buffer.from(`afr:${this.proxyToken}`).toString("base64")}`);
    const actual = Buffer.from(header);
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  private addressAllowed(address: string): boolean {
    if (isPublicNetworkAddress(address)) return true;
    const normalized = normalizeIpAddress(address);
    if (this.trustedPrivateAddresses.has(normalized)) return true;
    return this.allowSyntheticDnsRange && isSyntheticDnsAddress(normalized);
  }

  private trackSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private auditDenied(code: ProviderEgressErrorCode, request: IncomingMessage): void {
    const authority = summarizeAuthority(request.url);
    this.audit({
      source: "host",
      operation: "provider.egress.connect",
      decision: "denied",
      effectivePolicy: {
        allowlist: [...this.allowlist],
        allowedPorts: [...this.allowedPorts]
      },
      evidence: { reason: code, ...authority }
    });
  }

  private audit(event: NetworkMediationAuditEvent): void {
    this.onAudit?.(event);
  }
}

export function providerEgressSandboxProfile(proxyPort: number): string {
  if (!Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) {
    throw new ProviderEgressError("invalid_config", "Provider egress proxy port is invalid");
  }
  return `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${proxyPort}"))`;
}

function parseConnectAuthority(authority: string): { hostname: string; port: number } {
  if (
    authority.length === 0 ||
    authority.length > 512 ||
    authority.includes("/") ||
    authority.includes("@") ||
    authority.includes("?") ||
    authority.includes("#")
  ) {
    throw new ProviderEgressError("authority_invalid", "Provider egress CONNECT authority is invalid");
  }
  const matched = authority.match(/^([A-Za-z0-9._-]+)(?::([0-9]{1,5}))?$/);
  if (matched === null) {
    throw new ProviderEgressError("authority_invalid", "Provider egress CONNECT authority is invalid");
  }
  const hostname = normalizeNetworkHostname(matched[1] ?? "");
  if (hostname.length === 0 || isIP(hostname) !== 0) {
    throw new ProviderEgressError("authority_invalid", "Provider egress requires a DNS hostname");
  }
  const port = matched[2] === undefined ? 443 : Number.parseInt(matched[2], 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ProviderEgressError("authority_invalid", "Provider egress CONNECT port is invalid");
  }
  return { hostname, port };
}

function normalizeAddress(address: ProviderEgressAddress): ProviderEgressAddress {
  const normalized = normalizeIpAddress(address.address);
  const family = isIP(normalized);
  if ((family !== 4 && family !== 6) || family !== address.family) {
    throw new ProviderEgressError(
      "dns_resolution_failed",
      "Provider egress DNS returned an invalid address"
    );
  }
  return { address: normalized, family };
}

function normalizeIpAddress(address: string): string {
  const withoutZone = address.includes("%") ? address.slice(0, address.indexOf("%")) : address;
  const mapped = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped?.[1] ?? withoutZone.toLowerCase();
}

function addressesEqual(left: string, right: string): boolean {
  return normalizeIpAddress(left) === normalizeIpAddress(right);
}

const syntheticDnsAddresses = new BlockList();
syntheticDnsAddresses.addSubnet("198.18.0.0", 15, "ipv4");

const enterprisePrivateAddresses = new BlockList();
enterprisePrivateAddresses.addSubnet("10.0.0.0", 8, "ipv4");
enterprisePrivateAddresses.addSubnet("172.16.0.0", 12, "ipv4");
enterprisePrivateAddresses.addSubnet("192.168.0.0", 16, "ipv4");

function isSyntheticDnsAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  return isIP(normalized) === 4 && syntheticDnsAddresses.check(normalized, "ipv4");
}

function isEnterprisePrivateAddress(address: string): boolean {
  return isIP(address) === 4 && enterprisePrivateAddresses.check(address, "ipv4");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProviderEgressError("invalid_config", `${name} must be a positive integer`);
  }
  return value;
}

function asProviderEgressError(
  error: unknown,
  fallback: ProviderEgressErrorCode = "authority_invalid"
): ProviderEgressError {
  if (error instanceof ProviderEgressError) return error;
  return new ProviderEgressError(
    fallback,
    error instanceof Error ? error.message : "Provider egress request failed"
  );
}

function summarizeAuthority(authority: string | undefined): Record<string, unknown> {
  if (authority === undefined) return {};
  try {
    const parsed = parseConnectAuthority(authority);
    return { hostname: parsed.hostname, port: parsed.port };
  } catch {
    return { authorityHash: sha256(authority) };
  }
}

function writeProxyFailure(socket: Socket, statusCode: 400 | 403 | 407 | 502): void {
  const status = statusCode === 400
    ? "Bad Request"
    : statusCode === 403
      ? "Forbidden"
      : statusCode === 407
        ? "Proxy Authentication Required"
        : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${statusCode} ${status}\r\nConnection: close\r\nContent-Length: 0\r\n` +
    (statusCode === 407 ? 'Proxy-Authenticate: Basic realm="AFR"\r\n' : "") +
    "\r\n"
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}

class SystemProviderEgressResolver implements ProviderEgressResolver {
  async resolve(hostname: string): Promise<ProviderEgressAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => {
      if (family !== 4 && family !== 6) {
        throw new ProviderEgressError(
          "dns_resolution_failed",
          "Provider egress DNS returned an unsupported address family"
        );
      }
      return { address, family };
    });
  }
}
