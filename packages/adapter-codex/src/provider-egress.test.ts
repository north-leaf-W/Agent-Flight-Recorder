import { describe, expect, it } from "vitest";

import {
  ProviderEgressBoundary,
  ProviderEgressError,
  providerEgressSandboxProfile,
  type ProviderEgressResolver
} from "./provider-egress.js";

class FixtureResolver implements ProviderEgressResolver {
  constructor(private readonly addresses: Array<{ address: string; family: 4 | 6 }>) {}

  async resolve(): Promise<Array<{ address: string; family: 4 | 6 }>> {
    return this.addresses;
  }
}

describe("Provider egress boundary", () => {
  it("requires explicit DNS hostname rules and ports", () => {
    expect(() => new ProviderEgressBoundary({ allowlist: [] })).toThrow("at least one");
    expect(() => new ProviderEgressBoundary({ allowlist: ["127.0.0.1"] }))
      .toThrow("Invalid Provider egress hostname rule");
    expect(() => new ProviderEgressBoundary({ allowlist: ["api.openai.com"], allowedPorts: [0] }))
      .toThrow("between 1 and 65535");
  });

  it("authorizes only allowlisted HTTPS CONNECT targets with entirely public DNS", async () => {
    const boundary = new ProviderEgressBoundary({
      allowlist: ["api.openai.com", "*.chatgpt.com"],
      resolver: new FixtureResolver([{ address: "93.184.216.34", family: 4 }])
    });
    await expect(boundary.authorize("api.openai.com:443")).resolves.toMatchObject({
      hostname: "api.openai.com",
      port: 443,
      address: { address: "93.184.216.34", family: 4 }
    });
    await expect(boundary.authorize("edge.chatgpt.com:443")).resolves.toMatchObject({
      hostname: "edge.chatgpt.com"
    });
    await expect(boundary.authorize("chatgpt.com:443")).rejects.toMatchObject({
      code: "host_not_allowlisted"
    });
    await expect(boundary.authorize("api.openai.com:80")).rejects.toMatchObject({
      code: "port_not_allowed"
    });
    await expect(boundary.authorize("127.0.0.1:443")).rejects.toMatchObject({
      code: "authority_invalid"
    });
  });

  it("rejects a DNS answer set when any address is not public", async () => {
    const boundary = new ProviderEgressBoundary({
      allowlist: ["api.openai.com"],
      resolver: new FixtureResolver([
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 }
      ])
    });
    await expect(boundary.authorize("api.openai.com:443")).rejects.toMatchObject({
      code: "address_not_public"
    });
  });

  it("allows only the explicit enterprise synthetic DNS range when opted in", async () => {
    const synthetic = new ProviderEgressBoundary({
      allowlist: ["provider.example"],
      allowSyntheticDnsRange: true,
      resolver: new FixtureResolver([{ address: "198.18.0.42", family: 4 }])
    });
    await expect(synthetic.authorize("provider.example:443")).resolves.toMatchObject({
      address: { address: "198.18.0.42", family: 4 }
    });

    const privateAddress = new ProviderEgressBoundary({
      allowlist: ["provider.example"],
      allowSyntheticDnsRange: true,
      resolver: new FixtureResolver([{ address: "10.0.0.42", family: 4 }])
    });
    await expect(privateAddress.authorize("provider.example:443")).rejects.toMatchObject({
      code: "address_not_public"
    });
  });

  it("can pin one exact RFC1918 Provider address without allowing its subnet", async () => {
    const pinned = new ProviderEgressBoundary({
      allowlist: ["provider.internal"],
      trustedPrivateAddresses: ["10.23.45.67"],
      resolver: new FixtureResolver([{ address: "10.23.45.67", family: 4 }])
    });
    await expect(pinned.authorize("provider.internal:443")).resolves.toMatchObject({
      address: { address: "10.23.45.67", family: 4 }
    });

    const drifted = new ProviderEgressBoundary({
      allowlist: ["provider.internal"],
      trustedPrivateAddresses: ["10.23.45.67"],
      resolver: new FixtureResolver([{ address: "10.23.45.68", family: 4 }])
    });
    await expect(drifted.authorize("provider.internal:443")).rejects.toMatchObject({
      code: "address_not_public"
    });
    expect(() => new ProviderEgressBoundary({
      allowlist: ["provider.internal"],
      trustedPrivateAddresses: ["127.0.0.1"]
    })).toThrow("not an eligible exact RFC1918 address");
  });

  it("builds a sandbox profile that permits only the selected loopback proxy port", () => {
    const profile = providerEgressSandboxProfile(43123);
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(remote ip "localhost:43123")');
    expect(() => providerEgressSandboxProfile(0)).toThrow(ProviderEgressError);
  });
});
