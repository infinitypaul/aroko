import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareInstalledToRunning,
  clearDeferredRestart,
  evaluateRuntimeBusy,
  readDeferredRestart,
  readInstalledRuntimeIdentity,
  runtimeIdentityFromControlStatus,
  tryAcquireUpgradeRestartLock,
  releaseUpgradeRestartLock,
  writeDeferredRestart,
  writeUpgradeRestartLockForTests,
  upgradeRestartLockPath,
  type RuntimeIdentity
} from "./index.js";

function identity(
  partial: Partial<RuntimeIdentity> & Pick<RuntimeIdentity, "buildId">
): RuntimeIdentity {
  return {
    version: partial.version ?? "0.0.0-test",
    buildId: partial.buildId,
    buildTimestamp: partial.buildTimestamp ?? "20260828T000000Z",
    controlApiSchemaVersion: partial.controlApiSchemaVersion ?? 1
  };
}

describe("Stage 18 Prompt 4 — build compatibility", () => {
  it("exact when buildIds match", () => {
    const installed = identity({ buildId: "abc" });
    expect(compareInstalledToRunning(installed, installed).kind).toBe("exact");
  });

  it("incompatible on Control schema major mismatch", () => {
    const result = compareInstalledToRunning(
      identity({ buildId: "new", controlApiSchemaVersion: 2 }),
      identity({ buildId: "old", controlApiSchemaVersion: 1 })
    );
    expect(result.kind).toBe("incompatible");
    expect(result.reason).toMatch(/schema/i);
  });

  it("restart_required when installed build differs and is not older", () => {
    const result = compareInstalledToRunning(
      identity({ buildId: "new", buildTimestamp: "20260828T120000Z" }),
      identity({ buildId: "old", buildTimestamp: "20260827T120000Z" })
    );
    expect(result.kind).toBe("restart_required");
  });

  it("compatible_different when running runtime is newer than this CLI", () => {
    const result = compareInstalledToRunning(
      identity({ buildId: "old-cli", buildTimestamp: "20260827T120000Z" }),
      identity({ buildId: "new-rt", buildTimestamp: "20260828T120000Z" })
    );
    expect(result.kind).toBe("compatible_different");
  });

  it("buildId mismatch alone without timestamps → restart_required", () => {
    const result = compareInstalledToRunning(
      identity({ buildId: "installed", buildTimestamp: "" }),
      identity({ buildId: "running", buildTimestamp: "" })
    );
    expect(result.kind).toBe("restart_required");
  });

  it("runtimeIdentityFromControlStatus does not use PID", () => {
    const id = runtimeIdentityFromControlStatus({
      version: "1.2.3",
      buildId: "bid",
      buildTimestamp: "20260828T010203Z",
      controlApiSchemaVersion: 1
    });
    expect(id.buildId).toBe("bid");
    expect(readInstalledRuntimeIdentity().controlApiSchemaVersion).toBe(1);
  });
});

describe("Stage 18 Prompt 4 — idle / busy", () => {
  it("treats active inspect/propose/apply/test phases as busy", () => {
    const busy = evaluateRuntimeBusy({
      actions: [
        { status: "executing", terminal: false },
        { status: "approved", terminal: false },
        { status: "requested", terminal: false }
      ],
      inspections: [{ status: "running", terminal: false }]
    });
    expect(busy.idle).toBe(false);
    expect(busy.activeActionCount).toBe(3);
    expect(busy.activeInspectionCount).toBe(1);
  });

  it("does not treat peers/session/approval_required as busy", () => {
    const idle = evaluateRuntimeBusy({
      actions: [{ status: "approval_required", terminal: false }],
      inspections: [{ status: "completed", terminal: true }]
    });
    expect(idle.idle).toBe(true);
    expect(idle.busyReasons).toEqual([]);
  });

  it("safe idle boundary excludes terminal and denied work", () => {
    const idle = evaluateRuntimeBusy({
      actions: [
        { status: "succeeded", terminal: true },
        { status: "denied", terminal: true },
        { status: "failed", terminal: true }
      ],
      inspections: [{ status: "failed", terminal: true }]
    });
    expect(idle.idle).toBe(true);
  });
});

describe("Stage 18 Prompt 4 — deferred restart + lock", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-upgrade-"));
    dirs.push(dir);
    return dir;
  }

  it("persists deferred restart across read cycles (CLI exit survival)", async () => {
    const workspace = await tempWorkspace();
    await writeDeferredRestart(workspace, {
      targetBuildId: "target-build",
      targetVersion: "9.9.9",
      requestedAt: new Date().toISOString(),
      reason: "busy upgrade"
    });
    const read = await readDeferredRestart(workspace);
    expect(read?.targetBuildId).toBe("target-build");
    await clearDeferredRestart(workspace);
    expect(await readDeferredRestart(workspace)).toBeNull();
  });

  it("idempotent multiple deferred-restart triggers keep one intent", async () => {
    const workspace = await tempWorkspace();
    await writeDeferredRestart(workspace, {
      targetBuildId: "b1",
      requestedAt: new Date().toISOString(),
      reason: "first"
    });
    await writeDeferredRestart(workspace, {
      targetBuildId: "b1",
      requestedAt: new Date().toISOString(),
      reason: "second"
    });
    const read = await readDeferredRestart(workspace);
    expect(read?.reason).toBe("second");
    expect(read?.targetBuildId).toBe("b1");
  });

  it("only one upgrade restart lock wins; stale dead PID is reclaimable", async () => {
    const workspace = await tempWorkspace();
    const first = await tryAcquireUpgradeRestartLock(workspace, "build-a");
    expect(first).toBe(true);
    // Same holder may re-enter for the same target
    expect(await tryAcquireUpgradeRestartLock(workspace, "build-a")).toBe(true);
    await releaseUpgradeRestartLock(workspace);

    await writeUpgradeRestartLockForTests(workspace, {
      targetBuildId: "build-b",
      holderPid: 2_147_000_000,
      acquiredAt: new Date().toISOString()
    });
    const recovered = await tryAcquireUpgradeRestartLock(workspace, "build-c");
    expect(recovered).toBe(true);
    await releaseUpgradeRestartLock(workspace);
  });

  it("never steals a lock held by a live foreign PID", async () => {
    const workspace = await tempWorkspace();
    const foreignPid = process.ppid > 1 ? process.ppid : null;
    if (!foreignPid) {
      return;
    }
    await writeUpgradeRestartLockForTests(workspace, {
      targetBuildId: "other",
      holderPid: foreignPid,
      acquiredAt: new Date().toISOString()
    });
    expect(await tryAcquireUpgradeRestartLock(workspace, "mine")).toBe(false);
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(upgradeRestartLockPath(workspace), { force: true });
  });
});
