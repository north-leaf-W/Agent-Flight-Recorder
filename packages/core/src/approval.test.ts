import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActionContext } from "@afr/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalService,
  ApprovalStateError,
  GrantValidationError,
  LocalStore,
  createActionDigest,
  createRunCreatedEvent
} from "./index.js";

const directories: string[] = [];

async function fixture(options: { approvalTtlMs?: number; grantTtlMs?: number } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "afr-approval-test-"));
  directories.push(dataDir);
  let current = new Date("2026-09-03T08:00:00.000Z");
  const now = () => new Date(current);
  const store = new LocalStore(dataDir, now);
  const run = store.createRun({
    projectPath: "/tmp/demo-project",
    task: "protect deletion",
    agentId: "fixture-agent"
  });
  store.appendEvents(run.id, [createRunCreatedEvent(run)]);
  store.transitionRun(run.id, "running");
  const service = new ApprovalService(store, {
    dataDir,
    homeDir: "/tmp/home",
    protectedPaths: ["protected"],
    now,
    ...options
  });
  return {
    dataDir,
    store,
    run,
    service,
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
    now
  };
}

function protectedDelete(runId: string): ActionContext {
  return {
    runId,
    actor: { id: "fixture-agent", type: "agent" },
    tool: "file",
    action: "delete",
    argv: ["rm", "protected/important.txt"],
    cwd: "/tmp/demo-project",
    targets: [{ type: "file", canonicalId: "protected/important.txt" }],
    environment: "local",
    sideEffect: "irreversible",
    recoverability: "partial"
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("approval and execution grants", () => {
  it("persists pending → approved → consumed and resumes the Run", async () => {
    const { service, store, run } = await fixture();
    const context = protectedDelete(run.id);

    const evaluated = service.evaluate(context, "remove obsolete protected fixture");
    expect(evaluated).toMatchObject({
      decision: { effect: "ask", riskLevel: "R4" },
      approval: { status: "pending", requestedBy: context.actor }
    });
    expect(store.getRun(run.id)?.status).toBe("waiting_approval");

    const decided = service.decide(evaluated.approval!.id, "approved", "local-user");
    expect(decided.approval.status).toBe("approved");
    expect(decided.grant?.token).toContain(".");
    expect(store.getRun(run.id)?.status).toBe("running");

    expect(service.consume(decided.grant!.token, context)).toMatchObject({ status: "consumed" });
    expect(service.get(evaluated.approval!.id)?.status).toBe("consumed");
    expect(store.listEvents(run.id).map((event) => event.eventType)).toContain("approval.consumed");
    store.close();
  });

  it("rejects changed parameters and permits only the originally approved action", async () => {
    const { service, store, run } = await fixture();
    const context = protectedDelete(run.id);
    const evaluated = service.evaluate(context);
    const { grant } = service.decide(evaluated.approval!.id, "approved", "local-user");
    const changed = {
      ...context,
      targets: [{ type: "file", canonicalId: "protected/other.txt" }],
      argv: ["rm", "protected/other.txt"]
    } satisfies ActionContext;

    expect(() => service.consume(grant!.token, changed)).toThrowError(
      expect.objectContaining<Partial<GrantValidationError>>({ reason: "action_mismatch" })
    );
    expect(service.get(evaluated.approval!.id)?.status).toBe("approved");
    expect(store.listEvents(run.id).at(-1)?.eventType).toBe("security.grant_rejected");
    expect(service.consume(grant!.token, context).status).toBe("consumed");
    store.close();
  });

  it("rejects a second consumption and a forged signature", async () => {
    const { service, store, run } = await fixture();
    const context = protectedDelete(run.id);
    const evaluated = service.evaluate(context);
    const { grant } = service.decide(evaluated.approval!.id, "approved", "local-user");
    service.consume(grant!.token, context);

    expect(() => service.consume(grant!.token, context)).toThrowError(
      expect.objectContaining<Partial<GrantValidationError>>({ reason: "consumed" })
    );
    const forged = `${grant!.token.slice(0, -1)}${grant!.token.endsWith("a") ? "b" : "a"}`;
    expect(() => service.consume(forged, context)).toThrowError(
      expect.objectContaining<Partial<GrantValidationError>>({ reason: "invalid" })
    );
    store.close();
  });

  it("keeps denied actions blocked and records the human decision", async () => {
    const { service, store, run } = await fixture();
    const evaluated = service.evaluate(protectedDelete(run.id));
    const denied = service.decide(
      evaluated.approval!.id,
      "denied",
      "local-user",
      "protected evidence must remain"
    );

    expect(denied).toMatchObject({
      approval: {
        status: "denied",
        decidedBy: "local-user",
        decisionReason: "protected evidence must remain"
      }
    });
    expect(denied.grant).toBeUndefined();
    expect(store.getRun(run.id)?.status).toBe("running");
    store.close();
  });

  it("expires pending approvals and approved grants without auto-allowing", async () => {
    const pendingFixture = await fixture({ approvalTtlMs: 1000, grantTtlMs: 1000 });
    const pending = pendingFixture.service.evaluate(protectedDelete(pendingFixture.run.id));
    pendingFixture.advance(1001);
    expect(pendingFixture.service.get(pending.approval!.id)?.status).toBe("expired");
    expect(() =>
      pendingFixture.service.decide(pending.approval!.id, "approved", "local-user")
    ).toThrow(ApprovalStateError);
    expect(pendingFixture.store.getRun(pendingFixture.run.id)?.status).toBe("running");
    pendingFixture.store.close();

    const grantFixture = await fixture({ grantTtlMs: 1000 });
    const context = protectedDelete(grantFixture.run.id);
    const approved = grantFixture.service.evaluate(context);
    const { grant } = grantFixture.service.decide(approved.approval!.id, "approved", "local-user");
    grantFixture.advance(1001);
    expect(() => grantFixture.service.consume(grant!.token, context)).toThrowError(
      expect.objectContaining<Partial<GrantValidationError>>({ reason: "expired" })
    );
    expect(grantFixture.service.get(approved.approval!.id)?.status).toBe("expired");
    grantFixture.store.close();
  });

  it("keeps grants valid across a service restart because the signing key is persistent", async () => {
    const first = await fixture();
    const context = protectedDelete(first.run.id);
    const evaluated = first.service.evaluate(context);
    const { grant } = first.service.decide(evaluated.approval!.id, "approved", "local-user");
    first.store.close();

    const reopened = new LocalStore(first.dataDir, first.now);
    const resumedService = new ApprovalService(reopened, {
      dataDir: first.dataDir,
      homeDir: "/tmp/home",
      protectedPaths: ["protected"],
      now: first.now
    });
    expect(resumedService.consume(grant!.token, context).status).toBe("consumed");
    expect(resumedService.get(evaluated.approval!.id)?.status).toBe("consumed");
    reopened.close();
  });

  it("changes the digest when an execution-relevant field changes", () => {
    const base = protectedDelete("018f5e2a-1b2c-7d4e-8f90-123456789abd");
    expect(createActionDigest(base)).not.toBe(
      createActionDigest({ ...base, argv: ["rm", "protected/other.txt"] })
    );
    expect(createActionDigest(base)).not.toBe(
      createActionDigest({ ...base, contentHash: "a".repeat(64) })
    );
  });
});
