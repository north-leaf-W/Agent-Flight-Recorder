import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import type { EventEnvelope, IncomingEvent, RunStatus } from "@afr/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../server/src/server.js";
import type { AfrRunApi, RemoteRun, UploadedBlob } from "./api-client.js";
import { runCapturedCommand } from "./capture.js";

const directories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("command and file capture vertical slice", () => {
  it("records the real command, file diff and successful result", async () => {
    const dataDir = await temporaryDirectory("afr-data-");
    const projectPath = await temporaryDirectory("afr-project-");
    const sourcePath = join(projectPath, "message.txt");
    await writeFile(sourcePath, "before\n");
    const server = await buildServer({ dataDir, webRoot: false });
    const api = inProcessApi(server.app, server.token);

    const result = await runCapturedCommand({
      api,
      projectPath,
      task: "Update the message",
      agentId: "fixture-agent",
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('message.txt', 'after\\n'); console.log('ok')"]
    });

    expect(result).toMatchObject({ status: "completed", exitCode: 0, changedFiles: 1 });
    expect(await readFile(sourcePath, "utf8")).toBe("after\n");
    const run = server.store.getRun(result.runId);
    expect(run?.status).toBe("completed");
    const events = server.store.listEvents(result.runId);
    expect(events.map((event) => event.eventType)).toEqual([
      "run.created",
      "run.status_changed",
      "shell.command_requested",
      "collection.gap_detected",
      "shell.command_completed",
      "file.modified",
      "run.status_changed"
    ]);
    const command = events.find((event) => event.eventType === "shell.command_completed");
    expect(command?.payload).toMatchObject({ exitCode: 0, cwd: projectPath });
    const changed = events.find((event) => event.eventType === "file.modified");
    expect(String(changed?.payload.diff)).toContain("-before");
    expect(String(changed?.payload.diff)).toContain("+after");
    await server.app.close();
  });

  it("marks the Run failed when the real command fails", async () => {
    const dataDir = await temporaryDirectory("afr-data-");
    const projectPath = await temporaryDirectory("afr-project-");
    const server = await buildServer({ dataDir, webRoot: false });

    const result = await runCapturedCommand({
      api: inProcessApi(server.app, server.token),
      projectPath,
      task: "Expected failure",
      agentId: "fixture-agent",
      command: process.execPath,
      args: ["-e", "console.error('expected failure'); process.exit(7)"]
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
    expect(server.store.getRun(result.runId)?.status).toBe("failed");
    const command = server.store
      .listEvents(result.runId)
      .find((event) => event.eventType === "shell.command_completed");
    expect(command?.status).toBe("error");
    expect(command?.payload).toMatchObject({ exitCode: 7 });
    await server.app.close();
  });

  it("creates a Git checkpoint before executing a requested command", async () => {
    const dataDir = await temporaryDirectory("afr-data-");
    const projectPath = await temporaryDirectory("afr-git-project-");
    await writeFile(join(projectPath, "state.txt"), "before\n");
    execFileSync("git", ["-C", projectPath, "init", "-q"]);
    execFileSync("git", ["-C", projectPath, "config", "user.email", "afr@example.invalid"]);
    execFileSync("git", ["-C", projectPath, "config", "user.name", "AFR Test"]);
    execFileSync("git", ["-C", projectPath, "add", "."]);
    execFileSync("git", ["-C", projectPath, "commit", "-qm", "fixture"]);
    const server = await buildServer({ dataDir, webRoot: false });

    const result = await runCapturedCommand({
      api: inProcessApi(server.app, server.token),
      projectPath,
      task: "checkpoint before command",
      agentId: "fixture-agent",
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('state.txt', 'after\\n')"],
      checkpointBefore: true
    });

    const checkpoint = server.store.listCheckpoints(result.runId)[0];
    expect(checkpoint).toBeDefined();
    const eventTypes = server.store.listEvents(result.runId).map((event) => event.eventType);
    expect(eventTypes.indexOf("checkpoint.created")).toBeLessThan(
      eventTypes.indexOf("shell.command_requested")
    );
    await server.app.close();
  });

  it("stores a large command output as a redacted Blob", async () => {
    const dataDir = await temporaryDirectory("afr-data-");
    const projectPath = await temporaryDirectory("afr-project-");
    const server = await buildServer({ dataDir, webRoot: false });
    const rawToken = "sk-1234567890abcdefghijkl";

    const result = await runCapturedCommand({
      api: inProcessApi(server.app, server.token),
      projectPath,
      task: "Large output",
      agentId: "fixture-agent",
      command: process.execPath,
      args: ["-e", `process.stdout.write('x'.repeat(9000) + '\\n${rawToken}')`]
    });

    const command = server.store
      .listEvents(result.runId)
      .find((event) => event.eventType === "shell.command_completed");
    const stdout = command?.payload.stdout as
      | { truncated: boolean; blobRef?: string; redactionState?: string }
      | undefined;
    expect(stdout).toMatchObject({ truncated: true, redactionState: "redacted" });
    expect(command?.blobRefs).toEqual([stdout?.blobRef]);
    const hash = stdout?.blobRef?.slice("sha256:".length);
    expect(hash).toBeDefined();
    const blob = server.store.getBlob(hash as string);
    expect(blob?.content.toString()).toContain("[REDACTED]");
    expect(blob?.content.toString()).not.toContain(rawToken);
    expect(JSON.stringify(command?.payload)).not.toContain(rawToken);
    await server.app.close();
  });
});

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
    },
    async createCheckpoint(runId: string, sourceEventId?: string) {
      return (
        await send<{ checkpoint: { id: string } }>("POST", "/api/v1/checkpoints", {
          runId,
          ...(sourceEventId === undefined ? {} : { sourceEventId })
        })
      ).checkpoint;
    }
  };
}
