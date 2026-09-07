import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalService,
  FileGateway,
  GatewayValidationError,
  LocalStore,
  createRunCreatedEvent
} from "./index.js";

const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "afr-gateway-test-"));
  directories.push(root);
  const dataDir = join(root, "afr-data");
  const projectPath = join(root, "project");
  const protectedDir = join(projectPath, "protected");
  mkdirSync(protectedDir, { recursive: true });
  const targetPath = join(protectedDir, "important.txt");
  const otherPath = join(protectedDir, "other.txt");
  writeFileSync(targetPath, "important evidence\n");
  writeFileSync(otherPath, "other evidence\n");
  const now = () => new Date("2026-09-03T09:00:00.000Z");
  const store = new LocalStore(dataDir, now);
  const run = store.createRun({ projectPath, task: "dangerous delete", agentId: "fixture-agent" });
  store.appendEvents(run.id, [createRunCreatedEvent(run)]);
  store.transitionRun(run.id, "running");
  const approvals = new ApprovalService(store, {
    dataDir,
    homeDir: root,
    protectedPaths: ["protected"],
    now
  });
  const gateway = new FileGateway(store, approvals, now);
  return { root, dataDir, projectPath, targetPath, otherPath, now, store, run, approvals, gateway };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("FileGateway", () => {
  it("takes an exact snapshot and pauses before deleting", async () => {
    const { gateway, store, run, targetPath } = await fixture();
    const requested = gateway.requestCommand(
      run.id,
      ["rm", "--", "protected/important.txt"],
      "remove protected evidence"
    );

    expect(requested.evaluation.approval).toMatchObject({
      status: "pending",
      snapshotId: requested.snapshot.id
    });
    expect(requested.snapshot).toMatchObject({ path: realpathSync(targetPath), exact: true });
    expect(readFileSync(targetPath, "utf8")).toBe("important evidence\n");
    expect(store.getBlob(requested.snapshot.contentBlobHash)?.content.toString()).toBe(
      "important evidence\n"
    );
    expect(store.getRun(run.id)?.status).toBe("waiting_approval");
    store.close();
  });

  it("keeps the target unchanged after denial", async () => {
    const { gateway, approvals, store, run, targetPath } = await fixture();
    const requested = gateway.requestDelete(run.id, "protected/important.txt");
    const decided = approvals.decide(
      requested.evaluation.approval!.id,
      "denied",
      "local-user",
      "keep evidence"
    );
    const action = gateway.resolveApproval(decided.approval.id, "denied");

    expect(action?.status).toBe("denied");
    expect(existsSync(targetPath)).toBe(true);
    expect(store.listEvents(run.id).at(-1)?.eventType).toBe("tool.call_failed");
    store.close();
  });

  it("deletes only the approved original target after consuming the grant", async () => {
    const { gateway, approvals, store, run, targetPath, otherPath } = await fixture();
    const requested = gateway.requestDelete(run.id, "protected/important.txt");
    const decided = approvals.decide(requested.evaluation.approval!.id, "approved", "local-user");
    const action = gateway.resolveApproval(decided.approval.id, "approved", decided.grant!.token);

    expect(action?.status).toBe("completed");
    expect(existsSync(targetPath)).toBe(false);
    expect(readFileSync(otherPath, "utf8")).toBe("other evidence\n");
    expect(approvals.get(decided.approval.id)?.status).toBe("consumed");
    expect(store.listEvents(run.id).at(-1)).toMatchObject({
      eventType: "file.deleted",
      payload: { path: requested.snapshot.path, snapshotId: requested.snapshot.id }
    });
    store.close();
  });

  it("refuses execution when file content changes after approval was requested", async () => {
    const { gateway, approvals, store, run, targetPath } = await fixture();
    const requested = gateway.requestDelete(run.id, "protected/important.txt");
    writeFileSync(targetPath, "replacement content\n");
    const decided = approvals.decide(requested.evaluation.approval!.id, "approved", "local-user");
    const action = gateway.resolveApproval(decided.approval.id, "approved", decided.grant!.token);

    expect(action?.status).toBe("failed");
    expect(readFileSync(targetPath, "utf8")).toBe("replacement content\n");
    expect(approvals.get(decided.approval.id)?.status).toBe("approved");
    expect(store.listEvents(run.id).some((event) => event.eventType === "security.grant_rejected")).toBe(true);
    store.close();
  });

  it("rejects out-of-project targets, symlinks and unsupported shell commands", async () => {
    const { gateway, store, run, projectPath, root } = await fixture();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(projectPath, "protected", "link.txt"));

    expect(() => gateway.requestDelete(run.id, outside)).toThrowError(
      expect.objectContaining<Partial<GatewayValidationError>>({ code: "target_outside_project" })
    );
    expect(() => gateway.requestDelete(run.id, "protected/link.txt")).toThrowError(
      expect.objectContaining<Partial<GatewayValidationError>>({ code: "symlink_rejected" })
    );
    expect(() => gateway.requestCommand(run.id, ["sh", "-c", "rm protected/important.txt"])).toThrowError(
      expect.objectContaining<Partial<GatewayValidationError>>({ code: "command_unsupported" })
    );
    expect(existsSync(outside)).toBe(true);
    store.close();
  });

  it("restores a pending gateway action after restart and executes it once", async () => {
    const first = await fixture();
    const requested = first.gateway.requestDelete(first.run.id, "protected/important.txt");
    first.store.close();

    const reopened = new LocalStore(first.dataDir, first.now);
    const approvals = new ApprovalService(reopened, {
      dataDir: first.dataDir,
      homeDir: first.root,
      protectedPaths: ["protected"],
      now: first.now
    });
    const gateway = new FileGateway(reopened, approvals, first.now);
    const decided = approvals.decide(requested.evaluation.approval!.id, "approved", "local-user");
    expect(gateway.resolveApproval(decided.approval.id, "approved", decided.grant!.token)?.status).toBe(
      "completed"
    );
    expect(existsSync(first.targetPath)).toBe(false);
    reopened.close();
  });
});
