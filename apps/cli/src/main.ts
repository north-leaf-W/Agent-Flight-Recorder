#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { AfrApiClient } from "./api-client.js";
import { runCapturedCommand } from "./capture.js";
import { runCapturedCodex } from "./codex.js";

const parsed = parseArguments(process.argv.slice(2));
if (parsed.commandName === "codex" && parsed.command.length === 0) {
  const dataDir = resolve(parsed.options["data-dir"] ?? process.env.AFR_DATA_DIR ?? ".afr");
  const token = process.env.AFR_TOKEN ?? readFileSync(resolve(dataDir, "runtime/session-token"), "utf8").trim();
  const baseUrl = parsed.options.server ?? "http://127.0.0.1:4317";
  const projectPath = resolve(parsed.options.project ?? process.cwd());
  const task = parsed.options.task;
  if (task === undefined) {
    throw new Error("afr codex requires --task <description>");
  }
  const sandbox = parseCodexSandbox(parsed.options.sandbox);
  const timeoutMs = parseOptionalPositiveInteger(parsed.options["timeout-ms"], "timeout-ms");
  const result = await runCapturedCodex({
    api: new AfrApiClient(baseUrl, token),
    projectPath,
    task,
    agentId: parsed.options.agent ?? "codex-cli",
    binary: parsed.options["codex-bin"] ?? process.env.AFR_CODEX_BIN ?? "codex",
    sandbox,
    ephemeral: parsed.options.ephemeral !== "false",
    checkpointBefore: parsed.options.checkpoint === "true",
    storeModelContent:
      (parsed.options["store-model-content"] ?? process.env.AFR_STORE_MODEL_CONTENT) === "true",
    ...(parsed.options.model === undefined ? {} : { model: parsed.options.model }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  process.stdout.write(
    `${JSON.stringify({ ...result, url: `${baseUrl}/runs/${result.runId}` }, null, 2)}\n`
  );
  process.exitCode = result.status === "completed" ? 0 : (result.exitCode === null || result.exitCode === 0
    ? 1
    : result.exitCode);
} else if (parsed.commandName === "exec" && parsed.command.length > 0) {
  const dataDir = resolve(parsed.options["data-dir"] ?? process.env.AFR_DATA_DIR ?? ".afr");
  const token = process.env.AFR_TOKEN ?? readFileSync(resolve(dataDir, "runtime/session-token"), "utf8").trim();
  const baseUrl = parsed.options.server ?? "http://127.0.0.1:4317";
  const projectPath = resolve(parsed.options.project ?? process.cwd());
  const task = parsed.options.task ?? parsed.command.join(" ");
  const result = await runCapturedCommand({
    api: new AfrApiClient(baseUrl, token),
    projectPath,
    task,
    agentId: parsed.options.agent ?? "fixture-agent",
    command: parsed.command[0] as string,
    args: parsed.command.slice(1),
    checkpointBefore: parsed.options.checkpoint === "true"
  });
  process.stdout.write(
    `${JSON.stringify({ ...result, url: `${baseUrl}/runs/${result.runId}` }, null, 2)}\n`
  );
  process.exitCode = result.exitCode ?? 1;
} else if (parsed.commandName === "replay" && parsed.command.length > 0) {
  const dataDir = resolve(parsed.options["data-dir"] ?? process.env.AFR_DATA_DIR ?? ".afr");
  const token = process.env.AFR_TOKEN ?? readFileSync(resolve(dataDir, "runtime/session-token"), "utf8").trim();
  const baseUrl = parsed.options.server ?? "http://127.0.0.1:4317";
  const runId = parsed.options.run;
  if (runId === undefined) {
    throw new Error("afr replay requires --run <source-run-id>");
  }
  const client = new AfrApiClient(baseUrl, token);
  const checkpoints = await client.listCheckpoints(runId);
  const checkpointId = parsed.options.checkpoint ?? checkpoints[0]?.id;
  if (checkpointId === undefined) {
    throw new Error(`Run has no checkpoint: ${runId}`);
  }
  const result = await client.createReplay({
    checkpointId,
    command: parsed.command,
    ...(parsed.options.task === undefined ? {} : { task: parsed.options.task }),
    overrides: { initiatedBy: "afr-cli" }
  });
  process.stdout.write(`${JSON.stringify({ ...result, url: `${baseUrl}/runs/${runId}` }, null, 2)}\n`);
  process.exitCode = result.replay.status === "completed" ? 0 : 1;
} else if (parsed.commandName === "export" && parsed.command.length === 0) {
  const dataDir = resolve(parsed.options["data-dir"] ?? process.env.AFR_DATA_DIR ?? ".afr");
  const token = process.env.AFR_TOKEN ?? readFileSync(resolve(dataDir, "runtime/session-token"), "utf8").trim();
  const baseUrl = parsed.options.server ?? "http://127.0.0.1:4317";
  const runId = parsed.options.run;
  if (runId === undefined) throw new Error("afr export requires --run <run-id>");
  const output = resolve(parsed.options.output ?? `afr-run-${runId}.json`);
  const exported = await new AfrApiClient(baseUrl, token).exportRun(runId);
  writeFileSync(output, `${JSON.stringify(exported, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ runId, output }, null, 2)}\n`);
} else if (parsed.commandName === "delete" && parsed.command.length === 1) {
  const dataDir = resolve(parsed.options["data-dir"] ?? process.env.AFR_DATA_DIR ?? ".afr");
  const token = process.env.AFR_TOKEN ?? readFileSync(resolve(dataDir, "runtime/session-token"), "utf8").trim();
  const baseUrl = parsed.options.server ?? "http://127.0.0.1:4317";
  const projectPath = resolve(parsed.options.project ?? process.cwd());
  const client = new AfrApiClient(baseUrl, token);
  const run = await client.createRun({
    projectPath,
    task: parsed.options.task ?? `Delete ${parsed.command[0]}`,
    agentId: parsed.options.agent ?? "fixture-agent"
  });
  const requested = await client.requestDelete({
    runId: run.id,
    path: parsed.command[0] as string,
    reason: parsed.options.reason ?? "Fixture Agent requested a protected file deletion"
  });
  process.stdout.write(
    `${JSON.stringify({
      runId: run.id,
      approvalId: requested.approval.id,
      snapshotId: requested.approval.snapshotId,
      status: requested.approval.status,
      url: `${baseUrl}/runs/${run.id}`
    }, null, 2)}\n`
  );
  for (;;) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const approval = await client.getApproval(requested.approval.id);
    if (approval.status === "pending" || approval.status === "approved") {
      if (approval.status === "approved") {
        const action = await client.getGatewayAction(approval.id);
        if (action.status === "failed") {
          await client.setStatus(run.id, "failed", action.errorCode ?? "gateway action failed");
          process.stdout.write(`${JSON.stringify({ status: "failed", action }, null, 2)}\n`);
          process.exitCode = 1;
          break;
        }
      }
      continue;
    }
    if (approval.status === "consumed") {
      await client.setStatus(run.id, "completed", "approved gateway deletion completed");
      process.stdout.write(`${JSON.stringify({ status: "completed" }, null, 2)}\n`);
      process.exitCode = 0;
      break;
    }
    await client.setStatus(run.id, "cancelled", `approval ${approval.status}`);
    process.stdout.write(`${JSON.stringify({ status: approval.status }, null, 2)}\n`);
    process.exitCode = 0;
    break;
  }
} else {
  printUsage();
  process.exitCode = 2;
}

function parseArguments(args: string[]): {
  commandName?: string;
  options: Record<string, string>;
  command: string[];
} {
  const [commandName, ...rest] = args;
  const separator = rest.indexOf("--");
  const optionParts = separator === -1 ? rest : rest.slice(0, separator);
  const command = separator === -1 ? [] : rest.slice(separator + 1);
  const options: Record<string, string> = {};
  for (let index = 0; index < optionParts.length; index += 2) {
    const flag = optionParts[index];
    const value = optionParts[index + 1];
    if (flag?.startsWith("--") && value !== undefined) {
      options[flag.slice(2)] = value;
    }
  }
  return { ...(commandName === undefined ? {} : { commandName }), options, command };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: afr codex --project <path> --task <description> [--checkpoint true] [--sandbox read-only|workspace-write] [--model <model>] [--ephemeral true|false] [--codex-bin <path>] [--timeout-ms <ms>] [--server <url>] [--data-dir <path>]\n"
    + "       afr exec --project <path> --task <description> [--checkpoint true] [--server <url>] [--data-dir <path>] -- <command> [args...]\n"
    + "       afr delete --project <path> --task <description> [--reason <text>] [--server <url>] [--data-dir <path>] -- <file>\n"
    + "       afr replay --run <source-run-id> [--checkpoint <id>] [--task <description>] [--server <url>] [--data-dir <path>] -- node <script> [args...]\n"
    + "       afr export --run <run-id> [--output <file>] [--server <url>] [--data-dir <path>]\n"
  );
}

function parseCodexSandbox(value: string | undefined): "read-only" | "workspace-write" {
  if (value === undefined || value === "workspace-write") return "workspace-write";
  if (value === "read-only") return "read-only";
  throw new Error("afr codex --sandbox must be read-only or workspace-write");
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`afr codex --${name} must be a positive integer`);
  }
  return parsed;
}
