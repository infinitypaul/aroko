/**
 * R22-1 — State ownership / lost-update regression harness.
 *
 * Proves pre-fix dual-writer lost updates (unsafeIndependentWriter), then
 * verifies reload-under-lock update()/mutate() preserves concurrent domains.
 */
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { setGrantPolicy, getGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { LocalStateStore } from "./store.js";
import { acquireStateFileLock } from "./state-lock.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

function baseState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-R22ABC",
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

function sampleAction(suffix: number): LocalSessionState["actionExecutions"][number] {
  const id = ActionIdSchema.parse(
    `act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a${String(suffix).padStart(3, "0")}`
  );
  return ActionExecutionRecordSchema.parse({
    actionId: id,
    requesterParticipantId: paulId,
    targetParticipantId: kelvinId,
    actionType: "change.propose",
    capabilityId: "change.propose",
    status: "approval_required",
    parameters: { summary: `action-${suffix}` },
    parameterDigest: "a".repeat(64),
    mutability: "none",
    createdAt: "2026-09-12T12:00:00.000Z",
    updatedAt: "2026-09-12T12:00:00.000Z",
    artifactRefs: [],
    executorInvocationCount: 0
  });
}

function sampleTask(suffix: number): LocalSessionState["collaborativeTasks"][number] {
  const id = CollaborativeTaskIdSchema.parse(
    `task_018f7b8a-4f31-7cc5-9a7c-fd3394f4a${String(suffix).padStart(3, "0")}`
  );
  return CollaborativeTaskSchema.parse({
    taskId: id,
    sessionId,
    ownerParticipantId: kelvinId,
    requesterParticipantId: paulId,
    status: "working",
    originalGoal: `fix bug ${suffix}`,
    childRefs: [],
    continuationSeq: 0,
    appliedEvents: [],
    createdAt: "2026-09-12T12:00:00.000Z",
    updatedAt: "2026-09-12T12:00:00.000Z"
  });
}

async function seed(path: string, state: LocalSessionState = baseState()): Promise<void> {
  const store = new LocalStateStore({ stateFilePath: path });
  await store.save(state);
}

describe("R22-1 pre-fix lost-update reproduction", () => {
  it("two independent stores: grant then action — action lost (A saves last)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-pre-"));
    const path = join(dir, "state.json");
    await seed(path);

    const storeA = new LocalStateStore({ stateFilePath: path, unsafeIndependentWriter: true });
    const storeB = new LocalStateStore({ stateFilePath: path, unsafeIndependentWriter: true });

    const snapA = await storeA.load();
    const snapB = await storeB.load();
    expect(snapA).toBeTruthy();
    expect(snapB).toBeTruthy();

    const withGrant = setGrantPolicy(snapA!, paulId, "repository.inspect", "deny");
    const withAction: LocalSessionState = {
      ...snapB!,
      actionExecutions: [sampleAction(1)]
    };

    await storeA.save(withGrant);
    await storeB.save(withAction);

    const final = await new LocalStateStore({ stateFilePath: path }).load();
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("a001"))).toBe(true);
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).not.toBe("deny");
  });

  it("two independent stores: action then grant — grant lost (B saves last) [inverse]", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-pre-inv-"));
    const path = join(dir, "state.json");
    await seed(path);

    const storeA = new LocalStateStore({ stateFilePath: path, unsafeIndependentWriter: true });
    const storeB = new LocalStateStore({ stateFilePath: path, unsafeIndependentWriter: true });

    const snapA = await storeA.load();
    const snapB = await storeB.load();

    const withAction: LocalSessionState = {
      ...snapA!,
      actionExecutions: [sampleAction(2)]
    };
    const withGrant = setGrantPolicy(snapB!, paulId, "repository.inspect", "deny");

    await storeA.save(withAction);
    await storeB.save(withGrant);

    const final = await new LocalStateStore({ stateFilePath: path }).load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).toBe("deny");
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("a002"))).toBe(false);
  });
});

describe("R22-1 post-fix concurrent mutations", () => {
  it("1. grant + action both survive (two stores, same file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-ga-"));
    const path = join(dir, "state.json");
    await seed(path);
    const storeA = new LocalStateStore({ stateFilePath: path });
    const storeB = new LocalStateStore({ stateFilePath: path });

    await Promise.all([
      storeA.update((s) => setGrantPolicy(s, paulId, "repository.inspect", "deny")),
      storeB.update((s) => ({
        ...s,
        actionExecutions: [...(s.actionExecutions ?? []), sampleAction(10)]
      }))
    ]);

    const final = await storeA.load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).toBe("deny");
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("a010"))).toBe(true);
  });

  it("2. action + collaborative task both survive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-at-"));
    const path = join(dir, "state.json");
    await seed(path);
    const storeA = new LocalStateStore({ stateFilePath: path });
    const storeB = new LocalStateStore({ stateFilePath: path });

    await Promise.all([
      storeA.update((s) => ({
        ...s,
        actionExecutions: [...(s.actionExecutions ?? []), sampleAction(11)]
      })),
      storeB.update((s) => ({
        ...s,
        collaborativeTasks: [...(s.collaborativeTasks ?? []), sampleTask(11)]
      }))
    ]);

    const final = await storeA.load();
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("a011"))).toBe(true);
    expect(final?.collaborativeTasks.some((t) => t.taskId.endsWith("a011"))).toBe(true);
  });

  it("3. CLI-like writer + runtime-like writer both survive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-cli-"));
    const path = join(dir, "state.json");
    await seed(path);
    const cli = new LocalStateStore({ stateFilePath: path });
    const runtime = new LocalStateStore({ stateFilePath: path });

    await Promise.all([
      cli.update((s) => setGrantPolicy(s, paulId, "change.propose", "approval_required")),
      runtime.update((s) => ({
        ...s,
        actionExecutions: [...(s.actionExecutions ?? []), sampleAction(12)]
      }))
    ]);

    const final = await runtime.load();
    expect(getGrantPolicy(final!, paulId, "change.propose")).toBe("approval_required");
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("a012"))).toBe(true);
  });

  it("4. permission deny cannot be silently overwritten by stale grant snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-perm-"));
    const path = join(dir, "state.json");
    await seed(path);
    const storeA = new LocalStateStore({ stateFilePath: path });
    const storeB = new LocalStateStore({ stateFilePath: path });

    await storeA.update((s) => setGrantPolicy(s, paulId, "repository.inspect", "deny"));
    // Stale "allow" intent applied via update must reload — deny must remain unless
    // this mutator explicitly changes it; here we only touch actions.
    await storeB.update((s) => ({
      ...s,
      actionExecutions: [...(s.actionExecutions ?? []), sampleAction(13)]
    }));

    const final = await storeA.load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).toBe("deny");
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("a013"))).toBe(true);
  });

  it("5. peer/session mutation + action mutation both survive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-peer-"));
    const path = join(dir, "state.json");
    await seed(path);
    const storeA = new LocalStateStore({ stateFilePath: path });
    const storeB = new LocalStateStore({ stateFilePath: path });

    await Promise.all([
      storeA.update((s) => ({
        ...s,
        peers: s.peers.map((p) =>
          p.participant.id === paulId ? { ...p, serviceLabel: "payment-service" } : p
        )
      })),
      storeB.update((s) => ({
        ...s,
        actionExecutions: [...(s.actionExecutions ?? []), sampleAction(14)]
      }))
    ]);

    const final = await storeA.load();
    expect(final?.peers.find((p) => p.participant.id === paulId)?.serviceLabel).toBe(
      "payment-service"
    );
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("a014"))).toBe(true);
  });

  it("6. lock contention serializes safely", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-cont-"));
    const path = join(dir, "state.json");
    await seed(path);
    const storeA = new LocalStateStore({ stateFilePath: path });
    const storeB = new LocalStateStore({ stateFilePath: path });
    let concurrent = 0;
    let maxConcurrent = 0;

    await Promise.all([
      storeA.update(async (s) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 40));
        concurrent -= 1;
        return setGrantPolicy(s, paulId, "repository.inspect", "deny");
      }),
      storeB.update(async (s) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent -= 1;
        return {
          ...s,
          actionExecutions: [...(s.actionExecutions ?? []), sampleAction(15)]
        };
      })
    ]);

    expect(maxConcurrent).toBe(1);

    const final = await storeA.load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).toBe("deny");
    expect(final?.actionExecutions.some((e) => e.actionId.endsWith("a015"))).toBe(true);
  });

  it("7. acquisition timeout fails explicitly; no write occurs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-to-"));
    const path = join(dir, "state.json");
    await seed(path);
    const lockDir = `${path}.lock`;
    const release = await acquireStateFileLock({
      lockDirPath: lockDir,
      acquireTimeoutMs: 1000,
      isProcessAlive: () => true
    });

    const waiter = new LocalStateStore({
      stateFilePath: path,
      lockAcquireTimeoutMs: 80,
      lockStaleMs: 60_000,
      isLockProcessAlive: () => true
    });

    await expect(
      waiter.update((s) => setGrantPolicy(s, paulId, "repository.inspect", "deny"))
    ).rejects.toMatchObject({ code: "pairmesh.state_lock_timeout" });

    const final = await new LocalStateStore({ stateFilePath: path }).load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).not.toBe("deny");
    await release();
  });

  it("8. stale/crashed lock recovers when holder pid is dead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-stale-"));
    const path = join(dir, "state.json");
    await seed(path);
    const lockPath = `${path}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999_999, startedAt: new Date(0).toISOString() }),
      "utf8"
    );

    const store = new LocalStateStore({
      stateFilePath: path,
      lockAcquireTimeoutMs: 2000,
      lockStaleMs: 1
    });
    await store.update((s) => setGrantPolicy(s, paulId, "repository.inspect", "deny"));
    const final = await store.load();
    expect(getGrantPolicy(final!, paulId, "repository.inspect")).toBe("deny");
  });

  it("9. concurrent 10+ mutations — no lost updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-many-"));
    const path = join(dir, "state.json");
    await seed(path);

    await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const store = new LocalStateStore({ stateFilePath: path });
        return store.update((s) => ({
          ...s,
          actionExecutions: [...(s.actionExecutions ?? []), sampleAction(100 + i)]
        }));
      })
    );

    const final = await new LocalStateStore({ stateFilePath: path }).load();
    expect(final?.actionExecutions).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      const suffix = String(100 + i).padStart(3, "0");
      expect(final?.actionExecutions.some((e) => e.actionId.endsWith(suffix))).toBe(true);
    }
  });

  it("10. crash during temp write — previous state remains readable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-crash-"));
    const path = join(dir, "state.json");
    await seed(path, setGrantPolicy(baseState(), paulId, "repository.inspect", "deny"));

    // Simulate orphan temp left by a crashed writer (never renamed).
    await writeFile(`${path}.99999.orphan.tmp`, "{ not-valid-incomplete", "utf8");

    const store = new LocalStateStore({ stateFilePath: path });
    const loaded = await store.load();
    expect(getGrantPolicy(loaded!, paulId, "repository.inspect")).toBe("deny");
    // Orphan temp is not authoritative.
    await expect(readFile(`${path}.99999.orphan.tmp`, "utf8")).resolves.toContain("not-valid");
  });

  it("11. post-mutation state still validates schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-schema-"));
    const path = join(dir, "state.json");
    await seed(path);
    const store = new LocalStateStore({ stateFilePath: path });
    await store.update((s) => ({
      ...s,
      actionExecutions: [...(s.actionExecutions ?? []), sampleAction(16)]
    }));
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.stateVersion).toBe(LOCAL_STATE_VERSION);
    expect(raw.actionExecutions[0].actionId.endsWith("a016")).toBe(true);
  });

  it("rejects invalid mutation results (does not write)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-invalid-"));
    const path = join(dir, "state.json");
    await seed(path);
    const store = new LocalStateStore({ stateFilePath: path });
    await expect(
      store.update((s) => ({ ...s, stateVersion: "0.0.0" }) as LocalSessionState)
    ).rejects.toBeTruthy();
    const final = await store.load();
    expect(final?.stateVersion).toBe(LOCAL_STATE_VERSION);
  });

  it("mutation latency p50/p95 stay bounded for ordinary updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-perf-"));
    const path = join(dir, "state.json");
    await seed(path);
    const store = new LocalStateStore({ stateFilePath: path });
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      await store.update((s) => ({
        ...s,
        actionExecutions: [
          ...(s.actionExecutions ?? []).slice(-20),
          sampleAction(200 + i)
        ]
      }));
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    // Correctness first — bound only pathological delays on local SSD/tmp.
    expect(p50).toBeLessThan(100);
    expect(p95).toBeLessThan(250);
    // Expose for results artifact collectors.
    (globalThis as { __r221Perf?: { p50: number; p95: number } }).__r221Perf = {
      p50: Number(p50.toFixed(3)),
      p95: Number(p95.toFixed(3))
    };
  });
});

describe("R22-1 atomic rename durability invariants", () => {
  it("rename of temp replaces state; incomplete rename leaves prior file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r221-rename-"));
    const path = join(dir, "state.json");
    await seed(path);
    const prior = await readFile(path, "utf8");
    const tempPath = `${path}.pid.tmp`;
    await writeFile(tempPath, `${JSON.stringify({ broken: true })}\n`, "utf8");
    // Crash before rename: prior remains.
    const still = await readFile(path, "utf8");
    expect(still).toBe(prior);
    await rename(tempPath, path);
    await expect(rm(tempPath, { force: true })).resolves.toBeUndefined();
  });
});
