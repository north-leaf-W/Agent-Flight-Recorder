import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppServerRequestRejectedError,
  CodexAppServerSupervisor,
  type AppServerNotification
} from "./app-server-supervisor.js";
import type { NetworkMediationAuditEvent } from "./network-mediation.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Codex App Server supervisor", () => {
  it("handshakes, correlates requests, streams notifications, and fails closed on server requests", async () => {
    const directory = await temporaryDirectory("afr-app-server-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.on("SIGTERM", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {
      userAgent: "codex-cli fixture",
      platformFamily: "unix",
      platformOs: "fixture",
      argv: process.argv.slice(2)
    }}));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
  } else if (message.method === "mcpServerStatus/list") {
    console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
  } else if (message.method === "initialized") {
    console.log(JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-1" } } }));
    console.log(JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { argv: ["false"] } }));
  } else if (message.method === "turn/interrupt") {
    console.log(JSON.stringify({ id: message.id, result: {} }));
    console.log(JSON.stringify({ method: "fixture/interrupt", params: message.params }));
  } else if (message.method === "thread/start") {
    const workspaceWrite = message.params.sandbox === "workspace-write";
    console.log(JSON.stringify({ id: message.id, result: {
      thread: { id: "thread-1" },
      sandbox: workspaceWrite
        ? {
            type: "workspaceWrite",
            networkAccess: false,
            writableRoots: [],
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true
          }
        : { type: "readOnly", networkAccess: false }
    } }));
    console.log(JSON.stringify({ method: "fixture/threadStart", params: message.params }));
  } else if (message.method === "turn/start") {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } }));
    console.log(JSON.stringify({ method: "fixture/turnStart", params: message.params }));
  } else if (message.method === "command/exec") {
    console.log(JSON.stringify({ id: message.id, result: { exitCode: 23, stdout: "", stderr: "blocked" } }));
    console.log(JSON.stringify({ method: "fixture/commandExec", params: message.params }));
  } else if (message.id === "approval-1") {
    console.log(JSON.stringify({ method: "fixture/serverRequestResult", params: message.error }));
  }
});
`);
    const notifications: AppServerNotification[] = [];
    const networkAudit: NetworkMediationAuditEvent[] = [];
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      onNotification: (notification) => {
        notifications.push(notification);
      },
      onNetworkAudit: (event) => networkAudit.push(event)
    });

    const handshake = await supervisor.start();
    expect(handshake).toMatchObject({
      userAgent: "codex-cli fixture",
      platformFamily: "unix",
      platformOs: "fixture"
    });
    expect((handshake.raw as { argv: string[] }).argv).toEqual(expect.arrayContaining([
      "--disable",
      "plugins",
      "remote_plugin",
      "browser_use_external"
    ]));
    expect(supervisor.state()).toBe("running");
    expect(supervisor.processId()).toBeGreaterThan(0);
    await waitFor(() => notifications.some(({ method }) => method === "fixture/serverRequestResult"));
    expect(notifications.find(({ method }) => method === "fixture/serverRequestResult")?.params)
      .toMatchObject({ code: -32601 });

    await expect(supervisor.startThread({
      cwd: directory,
      sandbox: "danger-full-access"
    } as never)).rejects.toThrow("does not allow sandbox mode");
    await expect(supervisor.startThread({
      cwd: join(directory, ".."),
      sandbox: "read-only"
    })).rejects.toThrow("cwd is outside the hosted root");

    await expect(supervisor.startThread({
      cwd: directory,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      ephemeral: true
    })).resolves.toMatchObject({ threadId: "thread-1" });
    await waitFor(() => notifications.some(({ method }) => method === "fixture/threadStart"));
    expect(notifications.find(({ method }) => method === "fixture/threadStart")?.params)
      .toMatchObject({
        sandbox: "read-only",
        config: {
          web_search: "disabled",
          shell_environment_policy: { inherit: "core" },
          mcp_servers: {}
        }
      });
    await expect(supervisor.startTurn("thread-1", "inspect only")).resolves.toMatchObject({
      turnId: "turn-1"
    });
    await waitFor(() => notifications.some(({ method }) => method === "fixture/turnStart"));
    expect(notifications.find(({ method }) => method === "fixture/turnStart")?.params)
      .toEqual({
        threadId: "thread-1",
        input: [{ type: "text", text: "inspect only" }],
        sandboxPolicy: { type: "readOnly", networkAccess: false }
      });

    await expect(supervisor.executeCommand({
      command: ["node", "fixture.mjs"],
      cwd: directory,
      timeoutMs: 250
    })).resolves.toMatchObject({ exitCode: 23, stderr: "blocked" });
    await waitFor(() => notifications.some(({ method }) => method === "fixture/commandExec"));
    expect(notifications.find(({ method }) => method === "fixture/commandExec")?.params)
      .toMatchObject({
        command: ["node", "fixture.mjs"],
        cwd: directory,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: 250
      });

    const rawRequest = supervisor as unknown as {
      rawRequest(method: string, params: unknown): Promise<unknown>;
    };
    await expect(rawRequest.rawRequest("thread/shellCommand", {
      threadId: "thread-1",
      command: "curl https://example.com"
    })).rejects.toThrow("outside the AFR hosted allowlist");
    expect(networkAudit).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "initialize", decision: "control-allowed" }),
      expect.objectContaining({ operation: "config/read", decision: "control-allowed" }),
      expect.objectContaining({ operation: "sandboxPolicy", decision: "denied" }),
      expect.objectContaining({ operation: "thread/start", decision: "denied" }),
      expect.objectContaining({ operation: "thread/start", decision: "sandbox-enforced" }),
      expect.objectContaining({ operation: "thread/start", decision: "observed" }),
      expect.objectContaining({ operation: "mcpServerStatus/list", decision: "control-allowed" }),
      expect.objectContaining({ operation: "turn/start", decision: "sandbox-enforced" }),
      expect.objectContaining({ operation: "command/exec", decision: "sandbox-enforced" }),
      expect.objectContaining({ operation: "thread/shellCommand", decision: "denied" })
    ]));

    await expect(supervisor.interruptTurn("thread-1", "turn-1")).resolves.toEqual({});
    await waitFor(() => notifications.some(({ method }) => method === "fixture/interrupt"));
    expect(notifications.find(({ method }) => method === "fixture/interrupt")?.params)
      .toEqual({ threadId: "thread-1", turnId: "turn-1" });
    await expect(supervisor.stop()).resolves.toMatchObject({
      outcome: "completed",
      timedOut: false
    });
    expect(supervisor.state()).toBe("stopped");
  });

  it("rejects Provider network permissions before an approval handler can authorize them", async () => {
    const directory = await temporaryDirectory("afr-app-server-network-request-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.on("SIGTERM", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
  } else if (message.method === "mcpServerStatus/list") {
    console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
  } else if (message.method === "initialized") {
    console.log(JSON.stringify({
      id: "network-1",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "curl https://example.com",
        networkApprovalContext: {}
      }
    }));
  } else if (message.id === "network-1") {
    console.log(JSON.stringify({ method: "fixture/networkRejected", params: message.error }));
  }
});
`);
    const notifications: AppServerNotification[] = [];
    const networkAudit: NetworkMediationAuditEvent[] = [];
    let approvalHandlerCalled = false;
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      onNotification: (notification) => notifications.push(notification),
      onServerRequest: () => {
        approvalHandlerCalled = true;
        return { decision: "accept" };
      },
      onNetworkAudit: (event) => networkAudit.push(event)
    });

    await supervisor.start();
    await waitFor(() => notifications.some(({ method }) => method === "fixture/networkRejected"));
    expect(approvalHandlerCalled).toBe(false);
    expect(notifications.find(({ method }) => method === "fixture/networkRejected")?.params)
      .toEqual({
        code: -32020,
        message: "AFR hosted policy denies tool network access and network policy amendments"
      });
    expect(networkAudit).toContainEqual(expect.objectContaining({
      source: "provider",
      operation: "item/commandExecution/requestApproval",
      decision: "denied"
    }));
    await supervisor.stop();
  });

  it("fails closed when Runtime reports enabled network or a broader sandbox", async () => {
    const directory = await temporaryDirectory("afr-app-server-unsafe-runtime-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
let starts = 0;
process.on("SIGTERM", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
  } else if (message.method === "thread/start") {
    starts += 1;
    const sandbox = starts === 1
      ? { type: "readOnly", networkAccess: true }
      : starts === 2
        ? { type: "dangerFullAccess" }
        : {
            type: "workspaceWrite",
            networkAccess: false,
            writableRoots: ["/tmp"],
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true
          };
    console.log(JSON.stringify({ id: message.id, result: { thread: { id: "unsafe-" + starts }, sandbox } }));
  }
});
`);
    const networkAudit: NetworkMediationAuditEvent[] = [];
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      onNetworkAudit: (event) => networkAudit.push(event)
    });

    await supervisor.start();
    await expect(supervisor.startThread({ cwd: directory, sandbox: "read-only" }))
      .rejects.toThrow("enabled tool network access");
    await expect(supervisor.startThread({ cwd: directory, sandbox: "read-only" }))
      .rejects.toThrow("unexpected sandbox policy");
    await expect(supervisor.startThread({ cwd: directory, sandbox: "workspace-write" }))
      .rejects.toThrow("unsafe workspace-write policy");
    expect(networkAudit.filter(({ decision }) => decision === "denied")).toHaveLength(3);
    await supervisor.stop("failed");
  });

  it("preserves a fail-closed bridge JSON-RPC error code", async () => {
    const directory = await temporaryDirectory("afr-app-server-rejection-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.on("SIGTERM", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
  } else if (message.method === "initialized") {
    console.log(JSON.stringify({ id: "permission-1", method: "item/permissions/requestApproval", params: {} }));
    console.log(JSON.stringify({ method: "fixture/afterRequest", params: { streamed: true } }));
  } else if (message.id === "permission-1") {
    console.log(JSON.stringify({ method: "fixture/rejected", params: message.error }));
  }
});
`);
    const notifications: AppServerNotification[] = [];
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      onNotification: (notification) => notifications.push(notification),
      onServerRequest: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new AppServerRequestRejectedError(-32010, "permission escalation denied");
      }
    });

    await supervisor.start();
    await waitFor(() => notifications.some(({ method }) => method === "fixture/afterRequest"));
    await waitFor(() => notifications.some(({ method }) => method === "fixture/rejected"));
    expect(notifications.find(({ method }) => method === "fixture/rejected")?.params).toEqual({
      code: -32010,
      message: "permission escalation denied"
    });
    await supervisor.stop();
  });

  it("terminates and reports a host-wide timeout", async () => {
    const directory = await temporaryDirectory("afr-app-server-timeout-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
  }
});
setInterval(() => {}, 60_000);
`);
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      hostTimeoutMs: 100,
      shutdownGraceMs: 100
    });

    await supervisor.start();
    await expect(supervisor.waitForExit()).resolves.toMatchObject({
      outcome: "failed",
      timedOut: true,
      errorMessage: "App Server host timed out after 100ms"
    });
    expect(supervisor.state()).toBe("failed");
  });

  it("interrupts the bound Turn before reporting cancellation", async () => {
    const directory = await temporaryDirectory("afr-app-server-cancel-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.on("SIGTERM", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
  } else if (message.method === "turn/interrupt") {
    if (message.params.threadId !== "thread-cancel" || message.params.turnId !== "turn-cancel") {
      console.log(JSON.stringify({ id: message.id, error: { code: -32602, message: "wrong target" } }));
    } else {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    }
  }
});
`);
    const supervisor = new CodexAppServerSupervisor({ cwd: directory, binary });

    await supervisor.start();
    await expect(supervisor.cancelTurn("thread-cancel", "turn-cancel")).resolves.toMatchObject({
      outcome: "cancelled",
      timedOut: false
    });
  });

  it("reports an unexpected clean App Server exit as interrupted", async () => {
    const directory = await temporaryDirectory("afr-app-server-exit-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
  } else if (message.method === "initialized") {
    setTimeout(() => process.exit(0), 20);
  }
});
`);
    const supervisor = new CodexAppServerSupervisor({ cwd: directory, binary });

    await supervisor.start();
    await expect(supervisor.waitForExit()).resolves.toMatchObject({
      outcome: "interrupted",
      exitCode: 0,
      timedOut: false
    });
  });

  it("fails the host when stdout violates the JSON-RPC boundary", async () => {
    const directory = await temporaryDirectory("afr-app-server-invalid-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
    setTimeout(() => console.log("not-json"), 10);
  }
});
setInterval(() => {}, 60_000);
`);
    const supervisor = new CodexAppServerSupervisor({ cwd: directory, binary });

    await supervisor.start();
    await expect(supervisor.waitForExit()).resolves.toMatchObject({
      outcome: "failed",
      errorMessage: "App Server emitted invalid JSON on stdout"
    });
  });

  it("terminates a Provider that exceeds the JSON-RPC message quota", async () => {
    const directory = await temporaryDirectory("afr-app-server-message-quota-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
    console.log(JSON.stringify({ method: "fixture/overflow-1" }));
    console.log(JSON.stringify({ method: "fixture/overflow-2" }));
  }
});
setInterval(() => {}, 60_000);
`);
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      maxMessages: 3,
      shutdownGraceMs: 100
    });

    await supervisor.start();
    await expect(supervisor.waitForExit()).resolves.toMatchObject({
      outcome: "failed",
      errorMessage: "App Server exceeded the 3 message limit"
    });
  });

  it("disables every configured MCP per Thread and verifies its Runtime status", async () => {
    const directory = await temporaryDirectory("afr-app-server-mcp-boundary-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.on("SIGTERM", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    const config = hostedConfig();
    config.config.mcp_servers = { unmanaged: { command: "fixture", enabled: true } };
    console.log(JSON.stringify({ id: message.id, result: config }));
  } else if (message.method === "thread/start") {
    console.log(JSON.stringify({ id: message.id, result: {
      thread: { id: "mcp-disabled-thread" },
      sandbox: { type: "readOnly", networkAccess: false },
      receivedConfig: message.params.config
    }}));
  } else if (message.method === "mcpServerStatus/list") {
    console.log(JSON.stringify({ id: message.id, result: {
      data: [{ name: "unmanaged", runtimeStatus: "disabled" }], nextCursor: null
    }}));
  }
});
`);
    const networkAudit: NetworkMediationAuditEvent[] = [];
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      onNetworkAudit: (event) => networkAudit.push(event)
    });

    await supervisor.start();
    const thread = await supervisor.startThread({ cwd: directory, sandbox: "read-only" });
    expect(thread.raw).toMatchObject({
      receivedConfig: { mcp_servers: { unmanaged: { enabled: false } } }
    });
    expect(networkAudit).toContainEqual(expect.objectContaining({
      operation: "mcpServerStatus/list",
      decision: "control-allowed",
      evidence: { disabledMcpServerCount: 1 }
    }));
    await supervisor.stop();
  });

  it("registers an experimental dynamic tool and handles only its typed server request", async () => {
    const directory = await temporaryDirectory("afr-app-server-dynamic-tool-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.on("SIGTERM", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {
      userAgent: "fixture",
      receivedCapabilities: message.params.capabilities
    }}));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
  } else if (message.method === "thread/start") {
    console.log(JSON.stringify({ id: message.id, result: {
      thread: { id: "dynamic-thread" },
      sandbox: { type: "readOnly", networkAccess: false },
      receivedDynamicTools: message.params.dynamicTools
    }}));
  } else if (message.method === "mcpServerStatus/list") {
    console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
  } else if (message.method === "turn/start") {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: "dynamic-turn" } } }));
    console.log(JSON.stringify({ id: "tool-request", method: "item/tool/call", params: {
      callId: "call-1",
      threadId: "dynamic-thread",
      turnId: "dynamic-turn",
      tool: "afr_network_read",
      namespace: null,
      arguments: { url: "https://example.com/" }
    }}));
  } else if (message.id === "tool-request") {
    console.log(JSON.stringify({ method: "fixture/dynamicToolResult", params: message.result }));
  }
});
`);
    const notifications: AppServerNotification[] = [];
    const calls: unknown[] = [];
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      dynamicTools: [{
        type: "function",
        name: "afr_network_read",
        description: "Read through AFR",
        inputSchema: { type: "object" }
      }],
      onDynamicToolCall(call) {
        calls.push(call);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "gateway-result" }]
        };
      },
      onNotification: (notification) => notifications.push(notification)
    });

    const handshake = await supervisor.start();
    expect(handshake.raw).toMatchObject({ receivedCapabilities: { experimentalApi: true } });
    const thread = await supervisor.startThread({ cwd: directory, sandbox: "read-only" });
    expect(thread.raw).toMatchObject({
      receivedDynamicTools: [{ type: "function", name: "afr_network_read" }]
    });
    await supervisor.startTurn(thread.threadId, "read the URL");
    await waitFor(() => notifications.some(({ method }) => method === "fixture/dynamicToolResult"));
    expect(calls).toEqual([expect.objectContaining({
      callId: "call-1",
      tool: "afr_network_read",
      arguments: { url: "https://example.com/" }
    })]);
    expect(notifications.find(({ method }) => method === "fixture/dynamicToolResult")?.params)
      .toEqual({ success: true, contentItems: [{ type: "inputText", text: "gateway-result" }] });
    await supervisor.stop();
  });

  it("audits unknown, namespaced, and malformed dynamic tool requests as denied", async () => {
    const directory = await temporaryDirectory("afr-app-server-dynamic-tool-denied-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.on("SIGTERM", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: hostedConfig() }));
  } else if (message.method === "thread/start") {
    console.log(JSON.stringify({ id: message.id, result: {
      thread: { id: "dynamic-thread" },
      sandbox: { type: "readOnly", networkAccess: false }
    }}));
  } else if (message.method === "mcpServerStatus/list") {
    console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
  } else if (message.method === "turn/start") {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: "dynamic-turn" } } }));
    console.log(JSON.stringify({ id: "unknown", method: "item/tool/call", params: {
      callId: "call-unknown", threadId: "dynamic-thread", turnId: "dynamic-turn",
      tool: "not_registered", namespace: null, arguments: { token: "do-not-audit" }
    }}));
    console.log(JSON.stringify({ id: "namespaced", method: "item/tool/call", params: {
      callId: "call-namespaced", threadId: "dynamic-thread", turnId: "dynamic-turn",
      tool: "afr_network_read", namespace: "unsafe", arguments: { token: "do-not-audit" }
    }}));
    console.log(JSON.stringify({ id: "malformed", method: "item/tool/call", params: {
      threadId: "dynamic-thread", turnId: "dynamic-turn",
      tool: "afr_network_read", namespace: null, arguments: { token: "do-not-audit" }
    }}));
  } else if (["unknown", "namespaced", "malformed"].includes(message.id)) {
    console.log(JSON.stringify({
      method: "fixture/dynamicToolRejected",
      params: { requestId: message.id, error: message.error }
    }));
  }
});
`);
    const notifications: AppServerNotification[] = [];
    const networkAudit: NetworkMediationAuditEvent[] = [];
    let handlerCalls = 0;
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      dynamicTools: [{
        type: "function",
        name: "afr_network_read",
        description: "Read through AFR",
        inputSchema: { type: "object" }
      }],
      onDynamicToolCall() {
        handlerCalls += 1;
        return { success: true, contentItems: [] };
      },
      onNotification: (notification) => notifications.push(notification),
      onNetworkAudit: (event) => networkAudit.push(event)
    });

    await supervisor.start();
    const thread = await supervisor.startThread({ cwd: directory, sandbox: "read-only" });
    await supervisor.startTurn(thread.threadId, "exercise rejected tools");
    await waitFor(() => notifications.filter(({ method }) => method === "fixture/dynamicToolRejected").length === 3);

    expect(handlerCalls).toBe(0);
    const rejections = notifications
      .filter(({ method }) => method === "fixture/dynamicToolRejected")
      .map(({ params }) => params);
    expect(rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: "unknown", error: expect.objectContaining({ code: -32601 }) }),
      expect.objectContaining({ requestId: "namespaced", error: expect.objectContaining({ code: -32601 }) }),
      expect.objectContaining({ requestId: "malformed", error: expect.objectContaining({ code: -32602 }) })
    ]));
    const denied = networkAudit.filter(({ operation, decision }) =>
      operation === "item/tool/call" && decision === "denied"
    );
    expect(denied).toHaveLength(3);
    expect(denied).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence: expect.objectContaining({
        reason: "dynamic_tool_request_rejected",
        code: -32601,
        request: expect.objectContaining({ tool: "not_registered", argumentsPresent: true })
      }) }),
      expect.objectContaining({ evidence: expect.objectContaining({
        reason: "dynamic_tool_request_rejected",
        code: -32602,
        request: expect.objectContaining({ tool: "afr_network_read", argumentsPresent: true })
      }) })
    ]));
    expect(JSON.stringify(denied)).not.toContain("do-not-audit");
    await supervisor.stop();
  });

  it("terminates the Host if Runtime starts an MCP despite the per-Thread override", async () => {
    const directory = await temporaryDirectory("afr-app-server-mcp-runtime-");
    const binary = await fakeBinary(directory, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.on("SIGTERM", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }));
  } else if (message.method === "config/read") {
    const config = hostedConfig();
    config.config.mcp_servers = { unmanaged: { command: "fixture", enabled: true } };
    console.log(JSON.stringify({ id: message.id, result: config }));
  } else if (message.method === "thread/start") {
    console.log(JSON.stringify({ id: message.id, result: {
      thread: { id: "unsafe-mcp-thread" },
      sandbox: { type: "readOnly", networkAccess: false }
    }}));
  } else if (message.method === "mcpServerStatus/list") {
    console.log(JSON.stringify({ id: message.id, result: {
      data: [{ name: "unmanaged", runtimeStatus: "connected" }], nextCursor: null
    }}));
  }
});
`);
    const networkAudit: NetworkMediationAuditEvent[] = [];
    const supervisor = new CodexAppServerSupervisor({
      cwd: directory,
      binary,
      onNetworkAudit: (event) => networkAudit.push(event)
    });

    await supervisor.start();
    await expect(supervisor.startThread({ cwd: directory, sandbox: "read-only" }))
      .rejects.toThrow("did not prove that every MCP runtime is disabled");
    expect(supervisor.state()).toBe("failed");
    expect(networkAudit).toContainEqual(expect.objectContaining({
      operation: "mcpServerStatus/list",
      decision: "denied"
    }));
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

async function fakeBinary(directory: string, source: string): Promise<string> {
  const path = join(directory, "fake-codex.mjs");
  await writeFile(path, `#!/usr/bin/env node
function hostedConfig() {
  return { config: {
    web_search: "disabled",
    mcp_servers: {},
    features: {
      apps: false,
      browser_use: false,
      browser_use_external: false,
      computer_use: false,
      image_generation: false,
      in_app_browser: false,
      plugins: false,
      remote_plugin: false,
      skill_mcp_dependency_install: false
    }
  }};
}
${source}`);
  await chmod(path, 0o755);
  return path;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for fixture event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
