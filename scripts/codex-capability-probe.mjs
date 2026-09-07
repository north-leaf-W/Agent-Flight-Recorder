import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const binary = process.env.AFR_CODEX_BIN ?? "codex";
const outputDirectory = await mkdtemp(join(tmpdir(), "afr-codex-capability-"));

try {
  const [versionResult, execHelp, handshake] = await Promise.all([
    run(binary, ["--version"]),
    run(binary, ["exec", "--help"]),
    probeAppServerHandshake(binary).catch((error) => ({
      initialized: false,
      error: error instanceof Error ? error.message : String(error)
    }))
  ]);
  await run(binary, ["app-server", "generate-json-schema", "--out", outputDirectory]);

  const [clientRequests, serverRequests, serverNotifications] = await Promise.all([
    methodsFromSchema(join(outputDirectory, "ClientRequest.json")),
    methodsFromSchema(join(outputDirectory, "ServerRequest.json")),
    methodsFromSchema(join(outputDirectory, "ServerNotification.json"))
  ]);

  const checks = {
    cliJsonl: includesAll(execHelp, ["--json", "--ephemeral", "--sandbox"]),
    appServerInitialize: handshake.initialized,
    threadLifecycle: includesAll(clientRequests, ["thread/start", "thread/resume"]),
    turnLifecycle: includesAll(clientRequests, ["turn/start", "turn/interrupt"]),
    streamingEvents: includesAll(serverNotifications, [
      "thread/started",
      "turn/started",
      "item/started",
      "item/completed",
      "turn/completed"
    ]),
    commandApprovalRequest: serverRequests.includes("item/commandExecution/requestApproval"),
    fileApprovalRequest: serverRequests.includes("item/fileChange/requestApproval"),
    permissionApprovalRequest: serverRequests.includes("item/permissions/requestApproval"),
    mcpElicitationRequest: serverRequests.includes("mcpServer/elicitation/request"),
    diffNotifications: serverNotifications.includes("turn/diff/updated")
  };

  const report = {
    generatedAt: new Date().toISOString(),
    binary,
    runtimeVersion: firstLine(versionResult),
    source: "locally generated App Server JSON Schema",
    makesModelCall: false,
    handshake,
    checks,
    gateAProtocolSurface: Object.values(checks).every(Boolean) ? "present" : "incomplete",
    governanceVerification: "unverified",
    note: "Protocol presence does not prove that commands, file writes, or tool network traffic cannot bypass AFR gateways."
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

async function probeAppServerHandshake(command) {
  const child = spawn(command, ["app-server", "--stdio"], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });

  const lines = createInterface({ input: child.stdout });
  const response = new Promise((resolveResponse, rejectResponse) => {
    const timeout = setTimeout(() => {
      rejectResponse(new Error("App Server initialize timed out"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResponse(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      rejectResponse(new Error(`App Server closed before initialize response (${code}): ${stderr}`));
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.id !== "afr-capability-probe") return;
      clearTimeout(timeout);
      if (message.error !== undefined) {
        rejectResponse(new Error(`App Server initialize failed: ${JSON.stringify(message.error)}`));
        return;
      }
      resolveResponse(message.result);
    });
  });

  child.stdin.write(`${JSON.stringify({
    id: "afr-capability-probe",
    method: "initialize",
    params: {
      clientInfo: { name: "afr-capability-probe", version: "0.1.0" },
      capabilities: { experimentalApi: false }
    }
  })}\n`);

  try {
    const result = await response;
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return {
      initialized: true,
      userAgent: typeof result?.userAgent === "string" ? result.userAgent : null,
      platformFamily: typeof result?.platformFamily === "string" ? result.platformFamily : null,
      platformOs: typeof result?.platformOs === "string" ? result.platformOs : null
    };
  } finally {
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    await closed.catch(() => undefined);
    clearTimeout(forceKill);
  }
}

async function run(command, args) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env
    });
    return `${result.stdout}\n${result.stderr}`.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to run ${command} ${args.join(" ")}: ${detail}`);
  }
}

async function methodsFromSchema(path) {
  const schema = JSON.parse(await readFile(path, "utf8"));
  const methods = new Set();
  visit(schema, (candidate) => {
    const values = candidate?.properties?.method?.enum;
    if (Array.isArray(values)) {
      for (const value of values) {
        if (typeof value === "string") methods.add(value);
      }
    }
  });
  return [...methods].sort();
}

function visit(value, callback) {
  if (value === null || typeof value !== "object") return;
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  for (const child of Object.values(value)) visit(child, callback);
}

function includesAll(value, expected) {
  return expected.every((candidate) => value.includes(candidate));
}

function firstLine(value) {
  return value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "unknown";
}
