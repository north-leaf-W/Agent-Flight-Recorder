import { spawn } from "node:child_process";

import { ProviderEgressBoundary } from "../packages/adapter-codex/dist/index.js";

const audit = [];
const boundary = new ProviderEgressBoundary({
  allowlist: ["example.com"],
  onAudit: (event) => audit.push(event),
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 30_000
});

try {
  const endpoint = await boundary.start();
  const allowed = await runSandboxedCurl(boundary, [
    "--silent",
    "--show-error",
    "--max-time",
    "15",
    "https://example.com/"
  ]);
  if (allowed.exitCode !== 0 || Buffer.byteLength(allowed.stdout) === 0) {
    throw new Error(`Allowlisted proxy request failed: ${allowed.stderr}`);
  }

  const denied = await runSandboxedCurl(boundary, [
    "--silent",
    "--show-error",
    "--max-time",
    "5",
    "https://www.iana.org/"
  ]);
  if (denied.exitCode === 0) throw new Error("Non-allowlisted proxy request unexpectedly succeeded");

  const bypassed = await runSandboxedCurl(boundary, [
    "--silent",
    "--show-error",
    "--max-time",
    "5",
    "--noproxy",
    "*",
    "https://example.com/"
  ]);
  if (bypassed.exitCode === 0) throw new Error("Direct network bypass unexpectedly succeeded");

  const allowedConnects = audit.filter(
    (event) => event.operation === "provider.egress.connect" && event.decision === "control-allowed"
  );
  const deniedConnects = audit.filter(
    (event) => event.operation === "provider.egress.connect" && event.decision === "denied"
  );
  if (allowedConnects.length !== 1 || deniedConnects.length < 1) {
    throw new Error("Provider egress audit evidence was incomplete");
  }

  process.stdout.write(`${JSON.stringify({
    proxy: { hostname: endpoint.hostname, port: endpoint.port, authentication: "per-host-random" },
    allowlistedRequest: { exitCode: allowed.exitCode, byteSize: Buffer.byteLength(allowed.stdout) },
    nonAllowlistedRequest: { exitCode: denied.exitCode },
    directBypass: { exitCode: bypassed.exitCode },
    audit: audit.map(({ operation, decision, effectivePolicy, evidence }) => ({
      operation,
      decision,
      effectivePolicy: effectivePolicy ?? null,
      evidence: evidence ?? null
    }))
  }, null, 2)}\n`);
} finally {
  await boundary.stop();
}

async function runSandboxedCurl(boundary, curlArgs) {
  const spec = boundary.spawnSpec("/usr/bin/curl", curlArgs);
  const child = spawn(spec.command, spec.args, {
    env: boundary.environment(process.env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  return { exitCode, stdout, stderr };
}
