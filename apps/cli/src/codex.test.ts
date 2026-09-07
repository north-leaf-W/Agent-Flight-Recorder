import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventEnvelope, IncomingEvent, RunStatus } from "@afr/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../server/src/server.js";
import type { AfrRunApi, RemoteRun, UploadedBlob } from "./api-client.js";
import { reconcileFileChanges, runCapturedCodex } from "./codex.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("captured Codex run", () => {
  it("records provider events and independently observed file changes", async () => {
    const dataDir = await temporaryDirectory("afr-codex-data-");
    const projectPath = await temporaryDirectory("afr-codex-project-");
    const binary = join(projectPath, "fake-codex.mjs");
    await writeFile(join(projectPath, "state.txt"), "before\n");
    await writeFile(binary, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli fake");
  process.exit(0);
}
await import("node:fs/promises").then(({writeFile}) => writeFile("state.txt", "after\\n"));
console.log(JSON.stringify({type:"thread.started",thread_id:"thread-fixture"}));
console.log(JSON.stringify({type:"turn.started"}));
console.log(JSON.stringify({type:"item.started",item:{id:"file-1",type:"file_change",paths:["state.txt"],status:"in_progress"}}));
console.log(JSON.stringify({type:"item.completed",item:{id:"file-1",type:"file_change",changes:[{path:"state.txt"}],status:"completed"}}));
console.log(JSON.stringify({type:"item.completed",item:{id:"message",type:"agent_message",text:"done"}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
`);
    await chmod(binary, 0o755);
    const server = await buildServer({ dataDir, webRoot: false });

    const result = await runCapturedCodex({
      api: inProcessApi(server.app, server.token),
      projectPath,
      task: "Update state",
      binary
    });

    expect(result).toMatchObject({
      status: "completed",
      exitCode: 0,
      changedFiles: 1,
      providerEvents: 6,
      gapCount: 0,
      runtimeVersion: "codex-cli fake",
      providerThreadId: "thread-fixture"
    });
    expect(await readFile(join(projectPath, "state.txt"), "utf8")).toBe("after\n");
    const events = server.store.listEvents(result.runId);
    expect(events.map((event) => event.eventType)).toEqual([
      "run.created",
      "run.status_changed",
      "artifact.created",
      "agent.session_started",
      "agent.turn_started",
      "file.write_requested",
      "artifact.created",
      "model.response",
      "agent.turn_completed",
      "file.modified",
      "artifact.created",
      "run.status_changed"
    ]);
    const providerClaim = events.find(
      (event) => event.eventType === "artifact.created" &&
        event.payload.kind === "provider_file_change_claim"
    );
    const observedChange = events.find((event) => event.eventType === "file.modified");
    expect(observedChange?.payload).toMatchObject({
      source: "afr-file-observer",
      path: "state.txt",
      providerCorrelation: {
        status: "matched",
        matches: [{ providerItemId: "file-1", completedEventId: providerClaim?.eventId }]
      }
    });
    expect(observedChange?.parentEventId).toBe(providerClaim?.eventId);
    expect(events.find(
      (event) => event.eventType === "artifact.created" &&
        event.payload.kind === "codex_file_reconciliation"
    )?.payload).toMatchObject({
      coverage: "path-correlated",
      matchedPaths: ["state.txt"],
      observedOnlyPaths: [],
      claimedOnlyPaths: []
    });
    await server.app.close();
  });

  it("reports observed-only and out-of-workspace provider file evidence", async () => {
    const projectPath = await temporaryDirectory("afr-codex-correlation-");
    const providerEvents = [
      {
        eventId: "provider-file-event",
        eventType: "artifact.created",
        payload: {
          kind: "provider_file_change_claim",
          providerItemId: "file-outside",
          providerTurnId: "turn-1",
          paths: ["../outside.txt"]
        }
      } as IncomingEvent
    ];

    const result = reconcileFileChanges(
      projectPath,
      [{ action: "modified", path: "inside.txt" }],
      providerEvents
    );

    expect(result.observedOnlyPaths).toEqual(["inside.txt"]);
    expect(result.unresolvedClaimPaths).toEqual(["../outside.txt"]);
    expect(result.claimedOnlyPaths).toEqual([]);
  });

  it("fails the Run when Codex completes after a non-zero final command", async () => {
    const dataDir = await temporaryDirectory("afr-codex-failed-data-");
    const projectPath = await temporaryDirectory("afr-codex-failed-project-");
    const binary = join(projectPath, "fake-codex.mjs");
    await writeFile(binary, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli fake");
  process.exit(0);
}
console.log(JSON.stringify({type:"thread.started",thread_id:"thread-failed"}));
console.log(JSON.stringify({type:"turn.started"}));
console.log(JSON.stringify({type:"item.completed",item:{id:"test-command",type:"command_execution",command:"node --test",status:"completed",exit_code:1,aggregated_output:"failed"}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
`);
    await chmod(binary, 0o755);
    const server = await buildServer({ dataDir, webRoot: false });

    const result = await runCapturedCodex({
      api: inProcessApi(server.app, server.token),
      projectPath,
      task: "Run the failing test",
      binary
    });

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 0,
      finalCommandExitCode: 1,
      timedOut: false
    });
    expect(server.store.getRun(result.runId)?.status).toBe("failed");
    expect(server.store.listEvents(result.runId).find(
      (event) => event.eventType === "shell.command_completed"
    )?.status).toBe("error");
    await server.app.close();
  });

});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

function inProcessApi(
  app: Awaited<ReturnType<typeof buildServer>>["app"],
  token: string
): AfrRunApi {
  const send = async <T>(method: "POST", url: string, payload: unknown): Promise<T> => {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    if (response.statusCode >= 400) {
      throw new Error(`AFR API ${response.statusCode}: ${response.body}`);
    }
    return response.json() as T;
  };
  return {
    async createRun(input) {
      return (await send<{ run: RemoteRun }>("POST", "/api/v1/runs", input)).run;
    },
    async appendEvents(runId: string, events: IncomingEvent[]) {
      return (
        await send<{ events: EventEnvelope[] }>(
          "POST",
          `/api/v1/runs/${runId}/events:batch`,
          { events }
        )
      ).events;
    },
    async putBlob(content: string, mediaType: string) {
      return send<UploadedBlob>("POST", "/api/v1/blobs", {
        contentBase64: Buffer.from(content, "utf8").toString("base64"),
        mediaType
      });
    },
    async setStatus(runId: string, status: RunStatus, reason?: string) {
      return (
        await send<{ run: RemoteRun }>("POST", `/api/v1/runs/${runId}/status`, {
          status,
          ...(reason === undefined ? {} : { reason })
        })
      ).run;
    }
  };
}
