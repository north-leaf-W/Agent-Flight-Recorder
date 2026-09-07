import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IncomingEvent } from "@afr/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { buildCodexExecArgs, detectCodexVersion, runCodexCli } from "./runner.js";

const RUN_ID = "018f5e2a-1b2c-7d4e-8f90-123456789abd";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Codex CLI runner", () => {
  it("builds a safe non-interactive JSONL invocation", () => {
    expect(buildCodexExecArgs({
      task: "fix the test",
      sandbox: "workspace-write",
      ephemeral: true,
      model: "test-model"
    })).toEqual([
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--model",
      "test-model",
      "fix the test"
    ]);
  });

  it("streams JSONL events without invoking a shell", async () => {
    const projectPath = await temporaryDirectory("afr-codex-runner-");
    const binary = join(projectPath, "fake-codex.mjs");
    await writeFile(binary, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli fake");
  process.exit(0);
}
console.log(JSON.stringify({type:"thread.started",thread_id:"thread-fixture"}));
console.log(JSON.stringify({type:"turn.started"}));
console.log(JSON.stringify({type:"item.completed",item:{id:"message",type:"agent_message",text:"done"}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
console.error("fixture progress");
`);
    await chmod(binary, 0o755);
    const events: IncomingEvent[] = [];

    expect(await detectCodexVersion(binary)).toBe("codex-cli fake");
    const result = await runCodexCli({
      runId: RUN_ID,
      projectPath,
      task: "fixture",
      binary,
      onEvents: async (batch) => {
        events.push(...batch);
      }
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      eventCount: 4,
      gapCount: 0,
      lineCount: 4,
      terminalOutcome: "completed",
      providerThreadId: "thread-fixture"
    });
    expect(result.stderr.text).toContain("fixture progress");
    expect(events.map((event) => event.eventType)).toEqual([
      "agent.session_started",
      "agent.turn_started",
      "model.response",
      "agent.turn_completed"
    ]);
  });

  it("terminates a Codex process after the configured timeout", async () => {
    const projectPath = await temporaryDirectory("afr-codex-timeout-");
    const binary = join(projectPath, "slow-codex.mjs");
    await writeFile(binary, `#!/usr/bin/env node
if (process.argv.includes("--version")) process.exit(0);
console.log(JSON.stringify({type:"thread.started",thread_id:"thread-timeout"}));
setTimeout(() => {}, 60_000);
`);
    await chmod(binary, 0o755);

    const result = await runCodexCli({
      runId: RUN_ID,
      projectPath,
      task: "wait",
      binary,
      timeoutMs: 250,
      onEvents: async () => undefined
    });

    expect(result.timedOut).toBe(true);
    expect(result.terminalOutcome).toBe("unknown");
    expect(result.signal).toBe("SIGTERM");
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}
