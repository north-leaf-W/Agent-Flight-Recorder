import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalService,
  GrantValidationError,
  HostedWorkspaceManager,
  LocalStore,
  PatchPromotionError,
  PatchPromotionGateway,
  createRunCreatedEvent
} from "./index.js";

const directories: string[] = [];

type Fixture = Awaited<ReturnType<typeof fixture>>;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function fixture() {
  const source = await temporaryDirectory("afr-promotion-source-");
  git(source, "init", "-q");
  git(source, "config", "user.email", "afr@example.invalid");
  git(source, "config", "user.name", "AFR Test");
  mkdirSync(join(source, "nested"));
  writeFileSync(join(source, "a.txt"), "before a\n");
  writeFileSync(join(source, "delete.txt"), "delete me\n");
  writeFileSync(join(source, "nested", "child.txt"), "before child\n");
  writeFileSync(join(source, "stable.txt"), "stable\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "fixture");

  const dataDir = await temporaryDirectory("afr-promotion-data-");
  let currentTime = new Date("2026-09-05T08:00:00.000Z");
  const now = () => new Date(currentTime);
  const store = new LocalStore(dataDir, now);
  const run = store.createRun({ projectPath: source, task: "promote changes", agentId: "codex-app-server" });
  store.appendEvents(run.id, [createRunCreatedEvent(run)]);
  const workspaces = new HostedWorkspaceManager(store, now);
  const prepared = workspaces.prepare({ runId: run.id });
  workspaces.activate(prepared.workspace.id);
  const worktree = prepared.workspace.worktreePath;
  writeFileSync(join(worktree, "a.txt"), "after a\n");
  writeFileSync(join(worktree, "created.txt"), "created\n");
  unlinkSync(join(worktree, "delete.txt"));
  writeFileSync(join(worktree, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  mkdirSync(join(worktree, "newdir"));
  writeFileSync(join(worktree, "newdir", "new.txt"), "nested created\n");
  writeFileSync(join(worktree, "nested", "child.txt"), "after child\n");
  symlinkSync("a.txt", join(worktree, "link.txt"));
  const finalized = workspaces.finalize(prepared.workspace.id).workspace;
  const approvals = new ApprovalService(store, {
    dataDir,
    homeDir: source,
    approvalTtlMs: 1_000,
    grantTtlMs: 1_000,
    now
  });
  const promotions = new PatchPromotionGateway(store, approvals, now);
  return {
    source,
    dataDir,
    worktree,
    store,
    run,
    finalized,
    approvals,
    promotions,
    advance(ms: number) {
      currentTime = new Date(currentTime.getTime() + ms);
    }
  };
}

function approveAndApply(test: Fixture, selectedPaths?: string[]) {
  const requested = test.promotions.request({ runId: test.run.id, selectedPaths });
  const decided = test.approvals.decide(requested.promotion.approvalId, "approved", "local-user");
  const promotion = test.promotions.resolveApproval(
    requested.promotion.approvalId,
    "approved",
    decided.grant?.token
  );
  return { requested, decided, promotion };
}

describe("PatchPromotionGateway", () => {
  it("promotes a finalized full change set only after a one-time human grant", async () => {
    const test = await fixture();
    const requested = test.promotions.request({ runId: test.run.id });

    expect(requested.evaluation.decision).toMatchObject({ effect: "ask", riskLevel: "R4" });
    expect(requested.promotion).toMatchObject({
      status: "waiting_approval",
      planHash: requested.promotion.planBlobHash
    });
    expect(requested.plan.selectedPaths).toEqual(test.finalized.changedPaths);
    expect(readFileSync(join(test.source, "a.txt"), "utf8")).toBe("before a\n");
    expect(existsSync(join(test.source, "created.txt"))).toBe(false);

    const decided = test.approvals.decide(requested.promotion.approvalId, "approved", "local-user");
    const completed = test.promotions.resolveApproval(
      requested.promotion.approvalId,
      "approved",
      decided.grant?.token
    );

    expect(completed).toMatchObject({ status: "completed", planHash: requested.promotion.planHash });
    expect(completed?.resultSourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(test.approvals.get(requested.promotion.approvalId)?.status).toBe("consumed");
    expect(readFileSync(join(test.source, "a.txt"), "utf8")).toBe("after a\n");
    expect(readFileSync(join(test.source, "created.txt"), "utf8")).toBe("created\n");
    expect(readFileSync(join(test.source, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(readFileSync(join(test.source, "newdir", "new.txt"), "utf8")).toBe("nested created\n");
    expect(existsSync(join(test.source, "delete.txt"))).toBe(false);
    expect(readlinkSync(join(test.source, "link.txt"))).toBe("a.txt");
    expect(test.store.listEvents(test.run.id).map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["file.created", "file.modified", "file.deleted", "evidence.attached"])
    );
    test.store.close();
  });

  it("supports a selected subset and prevents a second Promotion from the same worktree", async () => {
    const test = await fixture();
    const { promotion } = approveAndApply(test, ["a.txt"]);

    expect(promotion?.status).toBe("completed");
    expect(readFileSync(join(test.source, "a.txt"), "utf8")).toBe("after a\n");
    expect(existsSync(join(test.source, "created.txt"))).toBe(false);
    expect(readFileSync(join(test.source, "delete.txt"), "utf8")).toBe("delete me\n");
    expect(() => test.promotions.request({ runId: test.run.id, selectedPaths: ["created.txt"] }))
      .toThrowError(expect.objectContaining<Partial<PatchPromotionError>>({ code: "promotion_exists" }));
    test.store.close();
  });

  it("fails closed when the source workspace drifts after the approval request", async () => {
    const test = await fixture();
    const requested = test.promotions.request({ runId: test.run.id, selectedPaths: ["a.txt"] });
    writeFileSync(join(test.source, "stable.txt"), "drifted\n");
    const decided = test.approvals.decide(requested.promotion.approvalId, "approved", "local-user");
    const failed = test.promotions.resolveApproval(
      requested.promotion.approvalId,
      "approved",
      decided.grant?.token
    );

    expect(failed).toMatchObject({ status: "failed", errorCode: "source_workspace_changed" });
    expect(readFileSync(join(test.source, "a.txt"), "utf8")).toBe("before a\n");
    expect(test.approvals.get(requested.promotion.approvalId)?.status).toBe("approved");
    test.store.close();
  });

  it("fails closed when the Hosted worktree drifts after the approval request", async () => {
    const test = await fixture();
    const requested = test.promotions.request({ runId: test.run.id, selectedPaths: ["a.txt"] });
    writeFileSync(join(test.worktree, "a.txt"), "changed after request\n");
    const decided = test.approvals.decide(requested.promotion.approvalId, "approved", "local-user");
    const failed = test.promotions.resolveApproval(
      requested.promotion.approvalId,
      "approved",
      decided.grant?.token
    );

    expect(failed).toMatchObject({ status: "failed", errorCode: "worktree_changed" });
    expect(readFileSync(join(test.source, "a.txt"), "utf8")).toBe("before a\n");
    test.store.close();
  });

  it("rejects a symlink parent replacement without writing outside the source workspace", async () => {
    const test = await fixture();
    const outside = await temporaryDirectory("afr-promotion-outside-");
    writeFileSync(join(outside, "child.txt"), "outside\n");
    const requested = test.promotions.request({
      runId: test.run.id,
      selectedPaths: ["nested/child.txt"]
    });
    renameSync(join(test.source, "nested"), join(test.source, "nested-original"));
    symlinkSync(outside, join(test.source, "nested"));
    const decided = test.approvals.decide(requested.promotion.approvalId, "approved", "local-user");
    const failed = test.promotions.resolveApproval(
      requested.promotion.approvalId,
      "approved",
      decided.grant?.token
    );

    expect(failed).toMatchObject({ status: "failed", errorCode: "symlink_parent" });
    expect(readFileSync(join(outside, "child.txt"), "utf8")).toBe("outside\n");
    test.store.close();
  });

  it("records denial and approval expiry without changing source files", async () => {
    const deniedTest = await fixture();
    const deniedRequest = deniedTest.promotions.request({
      runId: deniedTest.run.id,
      selectedPaths: ["a.txt"]
    });
    deniedTest.approvals.decide(deniedRequest.promotion.approvalId, "denied", "local-user");
    expect(deniedTest.promotions.resolveApproval(deniedRequest.promotion.approvalId, "denied"))
      .toMatchObject({ status: "denied", errorCode: "approval_denied" });
    expect(readFileSync(join(deniedTest.source, "a.txt"), "utf8")).toBe("before a\n");
    deniedTest.store.close();

    const expiredTest = await fixture();
    const expiredRequest = expiredTest.promotions.request({
      runId: expiredTest.run.id,
      selectedPaths: ["a.txt"]
    });
    expiredTest.advance(1_001);
    expect(expiredTest.promotions.get(expiredRequest.promotion.id)).toMatchObject({
      status: "failed",
      errorCode: "approval_expired"
    });
    expect(readFileSync(join(expiredTest.source, "a.txt"), "utf8")).toBe("before a\n");
    expiredTest.store.close();
  });

  it("binds the grant to the immutable plan and rejects duplicate consumption", async () => {
    const test = await fixture();
    const requested = test.promotions.request({ runId: test.run.id, selectedPaths: ["a.txt"] });
    const decided = test.approvals.decide(requested.promotion.approvalId, "approved", "local-user");
    expect(() => test.approvals.consume(decided.grant!.token, {
      ...requested.promotion.actionContext,
      argv: ["promote", "created.txt"]
    })).toThrowError(expect.objectContaining<Partial<GrantValidationError>>({ reason: "action_mismatch" }));

    expect(test.promotions.resolveApproval(
      requested.promotion.approvalId,
      "approved",
      decided.grant?.token
    )).toMatchObject({ status: "completed" });
    expect(() => test.approvals.consume(decided.grant!.token, requested.promotion.actionContext))
      .toThrowError(expect.objectContaining<Partial<GrantValidationError>>({ reason: "consumed" }));
    test.store.close();
  });

  it("rolls back already-applied paths when a later exact Blob fails integrity verification", async () => {
    const test = await fixture();
    const requested = test.promotions.request({
      runId: test.run.id,
      selectedPaths: ["a.txt", "newdir/new.txt"]
    });
    const createdEntry = requested.plan.entries.find((entry) => entry.path === "newdir/new.txt")!;
    const hash = createdEntry.after!.blobHash;
    writeFileSync(join(test.dataDir, "blobs", "sha256", hash.slice(0, 2), hash), "tampered");
    const decided = test.approvals.decide(requested.promotion.approvalId, "approved", "local-user");
    const failed = test.promotions.resolveApproval(
      requested.promotion.approvalId,
      "approved",
      decided.grant?.token
    );

    expect(failed).toMatchObject({ status: "failed", errorCode: "apply_failed" });
    expect(readFileSync(join(test.source, "a.txt"), "utf8")).toBe("before a\n");
    expect(existsSync(join(test.source, "newdir"))).toBe(false);
    test.store.close();
  });
});
