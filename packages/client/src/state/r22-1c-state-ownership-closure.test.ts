/**
 * R22-1C — Final closure: no stale domain overwrite; live lock not age-stolen;
 * mixed-domain stress.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ActionExecutionRecordSchema,
  ActionIdSchema,
  CollaborativeTaskIdSchema,
  CollaborativeTaskSchema,
  PeerIdSchema,
  SessionIdSchema
} from "@pairmesh/protocol";
import { getGrantPolicy, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { SessionManager } from "../session/manager.js";
import { LocalStateStore } from "./store.js";
import { acquireStateFileLock } from "./state-lock.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

function baseState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-R22CAB",
    session: {
      id: sessionId,
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-09-12T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: kelvinId,
        sessionId,
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        joinedAt: "2026-09-12T12:00:00.000Z"
      },
      agent: {
        id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        name: "kelvin-agent",
        adapter: "pairmesh.a2a-demo"
      },
      developer: {
        id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        displayName: "Kelvin"
      },
      a2aAgentUrl: "http://127.0.0.1:4502/",
      isLocal: true
    },
    peers: [
      {
        participant: {
          id: paulId,
          sessionId,
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          joinedAt: "2026-09-12T12:00:00.000Z"
        },
        agent: {
          id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          name: "paul-agent",
          adapter: "pairmesh.a2a-demo"
        },
        developer: {
          id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          displayName: "Paul"
        },
        a2aAgentUrl: "http://127.0.0.1:4501/",
        isLocal: false
      }
    ],
    inspectionThreads: [],
    inspectionExecutions: [],
    sessionSecurity: createSessionSecurity(),
    permissionRequests: [],
    actionExecutions: [],
    actionArtifacts: [],
    collaborativeTasks: [],
    inputRequests: [],
    hostToolCalls: [],
    providerTurns: [],
    continuationEvents: []
  };
}

function sampleAction(suffix: number) {
  const id = ActionIdSchema.parse(
    `act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b${String(suffix).padStart(3, "0")}`
  );
  return ActionExecutionRecordSchema.parse({
    actionId: id,
    requesterParticipantId: paulId,
    targetParticipantId: kelvinId,
    actionType: "change.propose",
    capabilityId: "change.propose",
    status: "approval_required",
    parameters: { summary: `a-${suffix}` },
    parameterDigest: "a".repeat(64),
    mutability: "none",
    createdAt: "2026-09-12T12:00:00.000Z",
    updatedAt: "2026-09-12T12:00:00.000Z",
    artifactRefs: [],
    executorInvocationCount: 0
  });
}

function sampleTask(suffix: number) {
  const id = CollaborativeTaskIdSchema.parse(
    `task_018f7b8a-4f31-7cc5-9a7c-fd3394f4b${String(suffix).padStart(3, "0")}`
  );
  return CollaborativeTaskSchema.parse({
    taskId: id,
    sessionId,
    ownerParticipantId: kelvinId,
    requesterParticipantId: paulId,
    status: "working",
    originalGoal: `goal ${suffix}`,
    childRefs: [],
    continuationSeq: 0,
    appliedEvents: [],
    createdAt: "2026-09-12T12:00:00.000Z",
    updatedAt: "2026-09-12T12:00:00.000Z"
  });
}

async function seed(path: string): Promise<LocalStateStore> {
  const store = new LocalStateStore({ stateFilePath: path });
  await store.replaceEntireDocument(baseState());
  return store;
}

describe("R22-1C adversarial stale snapshot", () => {
  it("pre-fix: stale replaceEntireDocument clobbers newer update", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-pre-"));
    const path = join(dir, "state.json");
    const store = await seed(path);
    const stale = await store.load();
    await store.update((s) => ({
      ...s,
      actionExecutions: [...(s.actionExecutions ?? []), sampleAction(1)]
    }));
    // Whole-document replace of stale snapshot (forbidden for domain; still possible as API).
    await store.replaceEntireDocument(setGrantPolicy(stale!, paulId, "repository.inspect", "deny"));
    const final = await store.load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).toBe("deny");
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("b001"))).toBe(false);
  });

  it("post-fix: SessionManager domain path preserves concurrent action (ordering A)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-dom-a-"));
    const path = join(dir, "state.json");
    const store = await seed(path);
    const manager = new SessionManager({
      stateStore: store,
      skipPeerHealthPreflight: true
    });
    // Stale snapshot held as if old production path loaded outside lock.
    await store.load();
    await store.update((s) => ({
      ...s,
      actionExecutions: [...(s.actionExecutions ?? []), sampleAction(2)]
    }));
    await manager.setPeerCapability("paul-agent", "repository.inspect", "deny");
    const final = await store.load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).toBe("deny");
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("b002"))).toBe(true);
  });

  it("post-fix: concurrent grant then domain-style update preserves grant (inverse)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-dom-b-"));
    const path = join(dir, "state.json");
    const store = await seed(path);
    const manager = new SessionManager({
      stateStore: store,
      skipPeerHealthPreflight: true
    });
    await manager.setPeerCapability("paul-agent", "repository.inspect", "deny");
    await store.update((s) => ({
      ...s,
      actionExecutions: [...(s.actionExecutions ?? []), sampleAction(3)]
    }));
    const final = await store.load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).toBe("deny");
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("b003"))).toBe(true);
  });

  it("writeExclusive outside exclusive section fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-wx-"));
    const path = join(dir, "state.json");
    const store = await seed(path);
    const state = await store.load();
    await expect(store.writeExclusive(state!)).rejects.toMatchObject({
      code: "pairmesh.internal_error"
    });
  });
});

describe("R22-1C mixed-domain concurrency stress", () => {
  it("50 interleaved permission/action/task/peer mutations — no lost updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-stress-"));
    const path = join(dir, "state.json");
    await seed(path);

    const ops = Array.from({ length: 50 }, (_, i) => {
      const store = new LocalStateStore({ stateFilePath: path });
      const kind = i % 5;
      if (kind === 0) {
        return store.update((s) =>
          setGrantPolicy(
            s,
            paulId,
            "repository.inspect",
            i % 2 === 0 ? "deny" : "approval_required"
          )
        );
      }
      if (kind === 1) {
        return store.update((s) => ({
          ...s,
          actionExecutions: [...(s.actionExecutions ?? []), sampleAction(100 + i)]
        }));
      }
      if (kind === 2) {
        return store.update((s) => ({
          ...s,
          collaborativeTasks: [...(s.collaborativeTasks ?? []), sampleTask(100 + i)]
        }));
      }
      if (kind === 3) {
        return store.update((s) => ({
          ...s,
          peers: s.peers.map((p) =>
            p.participant.id === paulId
              ? { ...p, serviceLabel: `svc-${i}` as const }
              : p
          )
        }));
      }
      // continuation-like: bump continuationSeq on tasks or append event marker via hostToolCalls count
      return store.update((s) =>
        setGrantPolicy(s, paulId, "change.propose", "approval_required")
      );
    });

    await Promise.all(ops);
    const final = await new LocalStateStore({ stateFilePath: path }).load();
    expect(final).toBeTruthy();
    // All action/task suffixes that were written must survive.
    for (let i = 0; i < 50; i++) {
      if (i % 5 === 1) {
        const suffix = String(100 + i).padStart(3, "0");
        expect(final!.actionExecutions.some((e) => e.actionId.endsWith(suffix))).toBe(true);
      }
      if (i % 5 === 2) {
        const suffix = String(100 + i).padStart(3, "0");
        expect(final!.collaborativeTasks.some((t) => t.taskId.endsWith(suffix))).toBe(true);
      }
    }
    expect(getGrantPolicy(final!, paulId, "change.propose")).toBe("approval_required");
    expect(final!.peers.find((p) => p.participant.id === paulId)?.serviceLabel).toMatch(/^svc-/);
  });
});

describe("R22-1C lock stale-recovery", () => {
  it("live owner + old timestamp is NOT stolen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-live-"));
    const path = join(dir, "state.json");
    await seed(path);
    const lockPath = `${path}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() }),
      "utf8"
    );

    const contender = new LocalStateStore({
      stateFilePath: path,
      lockAcquireTimeoutMs: 120,
      isLockProcessAlive: (pid) => pid === process.pid
    });

    await expect(
      contender.update((s) => setGrantPolicy(s, paulId, "repository.inspect", "deny"))
    ).rejects.toMatchObject({ code: "pairmesh.state_lock_timeout" });

    const lockStill = await readFile(lockPath, "utf8");
    expect(JSON.parse(lockStill).pid).toBe(process.pid);
    const final = await new LocalStateStore({ stateFilePath: path }).load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).not.toBe("deny");
    await writeFile(lockPath, "", "utf8").catch(() => undefined);
    // cleanup lock for other tests in same process — remove after asserting
    const { rm } = await import("node:fs/promises");
    await rm(lockPath, { force: true });
  });

  it("dead owner recovers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-dead-"));
    const path = join(dir, "state.json");
    await seed(path);
    const lockPath = `${path}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999_991, startedAt: new Date().toISOString() }),
      "utf8"
    );
    const store = new LocalStateStore({
      stateFilePath: path,
      lockAcquireTimeoutMs: 2000,
      isLockProcessAlive: () => false
    });
    await store.update((s) => setGrantPolicy(s, paulId, "repository.inspect", "deny"));
    expect(getGrantPolicy((await store.load())!, paulId, "repository.inspect")).toBe("deny");
  });

  it("malformed lock is cleared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-bad-"));
    const path = join(dir, "state.json");
    await seed(path);
    await writeFile(`${path}.lock`, "not-json{{{", "utf8");
    const store = new LocalStateStore({ stateFilePath: path, lockAcquireTimeoutMs: 2000 });
    await store.update((s) => setGrantPolicy(s, paulId, "repository.inspect", "deny"));
    expect(getGrantPolicy((await store.load())!, paulId, "repository.inspect")).toBe("deny");
  });

  it("timeout leaves no unlocked write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-to-"));
    const path = join(dir, "state.json");
    await seed(path);
    const release = await acquireStateFileLock({
      lockDirPath: `${path}.lock`,
      isProcessAlive: () => true
    });
    const waiter = new LocalStateStore({
      stateFilePath: path,
      lockAcquireTimeoutMs: 80,
      isLockProcessAlive: () => true
    });
    await expect(
      waiter.update((s) => setGrantPolicy(s, paulId, "repository.inspect", "deny"))
    ).rejects.toMatchObject({ code: "pairmesh.state_lock_timeout" });
    expect(
      getGrantPolicy((await new LocalStateStore({ stateFilePath: path }).load())!, paulId, "repository.inspect")
    ).not.toBe("deny");
    await release();
  });
});

describe("R22-1C performance", () => {
  it("bounded mutation latency", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221c-perf-"));
    const path = join(dir, "state.json");
    await seed(path);
    const store = new LocalStateStore({ stateFilePath: path });
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await store.update((s) =>
        setGrantPolicy(s, paulId, "repository.inspect", i % 2 ? "deny" : "approval_required")
      );
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    expect(p50).toBeLessThan(100);
    expect(p95).toBeLessThan(250);
    (globalThis as { __r221cPerf?: { p50: number; p95: number } }).__r221cPerf = {
      p50: Number(p50.toFixed(3)),
      p95: Number(p95.toFixed(3))
    };
  });
});
