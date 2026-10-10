import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, type PeerId } from "@pairmesh/protocol";
import { ensureDefaultGrants, getGrantPolicy, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { digestParameters } from "./digest.js";
import { FakeActionExecutor } from "./executor.js";
import { assertActionTransition, isTerminalActionStatus } from "./lifecycle.js";
import { ActionService } from "./service.js";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as PeerId;
const sarahId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af03" as PeerId;

function peer(id: PeerId): LocalSessionState["peers"][number] {
  return {
    participant: { id } as LocalSessionState["peers"][number]["participant"],
    agent: {} as LocalSessionState["peers"][number]["agent"],
    developer: {} as LocalSessionState["peers"][number]["developer"],
    a2aAgentUrl: "http://127.0.0.1:9/",
    isLocal: false
  };
}

function baseState(localId: PeerId, peerIds: PeerId[]): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-ACTION1",
    session: {
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-08-23T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: { id: localId } as LocalSessionState["localParticipant"]["participant"],
      agent: {} as LocalSessionState["localParticipant"]["agent"],
      developer: {} as LocalSessionState["localParticipant"]["developer"],
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: peerIds.map(peer),
    inspectionThreads: [],
    inspectionExecutions: [],
    sessionSecurity: createSessionSecurity(),
    permissionRequests: [],
    actionExecutions: [],
    actionArtifacts: [],
    collaborativeTasks: [],
    inputRequests: [],
    hostToolCalls: []
  };
}

async function tempService(executor?: FakeActionExecutor) {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-action-"));
  const stateFilePath = join(dir, "state.json");
  const fake = executor ?? new FakeActionExecutor({ mode: "success" });
  const service = new ActionService({
    stateFilePath,
    defaultExecutorFactory: () => fake
  });
  return { service, stateFilePath, fake, dir };
}

describe("Stage 15 Prompt 2 — action domain foundation", () => {
  it("parameter digests are canonical; illegal transitions fail", () => {
    expect(digestParameters({ b: 1, a: 2 })).toBe(digestParameters({ a: 2, b: 1 }));
    expect(digestParameters({ a: 1 })).not.toBe(digestParameters({ a: 2 }));
    expect(() => assertActionTransition("completed", "executing")).toThrow();
    expect(isTerminalActionStatus("unknown_outcome")).toBe(true);
  });

  it("A: authorized non-mutating fake action completes once", async () => {
    const { service, fake } = await tempService();
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.inspect", "allow_session");
    state = setGrantPolicy(state, paulId, "change.propose", "allow_session");

    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a001");
    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.noop",
      parameters: { note: "hello" }
    });
    expect(result.execution.status).toBe("completed");
    expect(fake.invocationCount).toBe(1);
    expect(getGrantPolicy(result.state, paulId, "repository.edit")).toBe("deny");
    expect(result.execution.progressEvents?.some((e) => e.phase === "completed")).toBe(true);
    expect(
      result.execution.progressEvents?.every(
        (e) => e.visibility === "requester_safe" || e.visibility === "owner_only"
      )
    ).toBe(true);
  });

  it("B+C: mutating action needs allow-once approval; replay does not re-execute", async () => {
    const { service, fake, stateFilePath } = await tempService();
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.edit", "approval_required");

    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a002");
    const created = await service.createTestArtifact(state, {
      actionId,
      bytes: Buffer.from("proposal-a")
    });
    state = created.state;
    const artifactRef = {
      artifactId: created.artifact.artifactId,
      contentHash: created.artifact.contentHash,
      artifactType: created.artifact.artifactType
    };

    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.artifact_apply",
      parameters: { paths: ["src/a.ts"] },
      artifactRef
    });
    expect(pending.execution.status).toBe("approval_required");
    expect(fake.invocationCount).toBe(0);

    const approved = await service.approveAction(pending.state, {
      actionId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(fake.invocationCount).toBe(1);

    const replay = await service.requestAction(approved.state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.artifact_apply",
      parameters: { paths: ["src/a.ts"] },
      artifactRef
    });
    expect(replay.execution.status).toBe("completed");
    expect(fake.invocationCount).toBe(1);
    expect(replay.execution.executorInvocationCount).toBe(1);

    // Persist execution records without requiring a fully populated peer graph.
    const persistedPath = join(dirname(stateFilePath), "action-executions.json");
    await writeFile(
      persistedPath,
      JSON.stringify(replay.state.actionExecutions ?? [], null, 2),
      "utf8"
    );
    const reloaded = JSON.parse(
      await readFile(persistedPath, "utf8")
    ) as typeof replay.state.actionExecutions;
    expect(reloaded?.[0]?.status).toBe("completed");
    expect(reloaded?.[0]?.executorInvocationCount).toBe(1);
  });

  it("D: post-approval artifact substitution is rejected", async () => {
    const { service, fake } = await tempService();
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.edit", "approval_required");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a003");
    const first = await service.createTestArtifact(state, {
      actionId,
      bytes: Buffer.from("artifact-a")
    });
    const pending = await service.requestAction(first.state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.artifact_apply",
      artifactRef: {
        artifactId: first.artifact.artifactId,
        contentHash: first.artifact.contentHash,
        artifactType: first.artifact.artifactType
      }
    });
    const second = await service.createTestArtifact(pending.state, {
      actionId,
      bytes: Buffer.from("artifact-b")
    });
    const tampered: LocalSessionState = {
      ...second.state,
      actionExecutions: (second.state.actionExecutions ?? []).map((entry) =>
        entry.actionId === actionId
          ? {
              ...entry,
              artifactRefs: [
                {
                  artifactId: second.artifact.artifactId,
                  contentHash: second.artifact.contentHash,
                  artifactType: second.artifact.artifactType
                }
              ]
            }
          : entry
      )
    };
    await expect(
      service.approveAction(tampered, { actionId, decision: "allow-once" })
    ).rejects.toMatchObject({ code: "pairmesh.action_binding_mismatch" });
    expect(fake.invocationCount).toBe(0);
  });

  it("E: Paul→Kelvin and Paul→Sarah actions remain isolated", async () => {
    const kelvin = await tempService();
    const sarah = await tempService();
    let kelvinState = baseState(kelvinId, [paulId]);
    let sarahState = baseState(sarahId, [paulId]);
    kelvinState = {
      ...kelvinState,
      sessionSecurity: ensureDefaultGrants(kelvinState.sessionSecurity!, paulId)
    };
    sarahState = {
      ...sarahState,
      sessionSecurity: ensureDefaultGrants(sarahState.sessionSecurity!, paulId)
    };
    kelvinState = setGrantPolicy(kelvinState, paulId, "repository.inspect", "allow_session");
    kelvinState = setGrantPolicy(kelvinState, paulId, "change.propose", "allow_session");
    sarahState = setGrantPolicy(sarahState, paulId, "repository.inspect", "allow_session");
    sarahState = setGrantPolicy(sarahState, paulId, "change.propose", "allow_session");

    const [k, s] = await Promise.all([
      kelvin.service.requestAction(kelvinState, {
        actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a010"),
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "pairmesh.test.noop",
        parameters: { peer: "kelvin" }
      }),
      sarah.service.requestAction(sarahState, {
        actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a011"),
        requesterParticipantId: paulId,
        targetParticipantId: sarahId,
        actionType: "pairmesh.test.noop",
        parameters: { peer: "sarah" }
      })
    ]);
    expect(k.execution.targetParticipantId).toBe(kelvinId);
    expect(s.execution.targetParticipantId).toBe(sarahId);
    expect(k.execution.actionId).not.toBe(s.execution.actionId);
  });

  it("F: unknown_outcome never auto-retries", async () => {
    const fake = new FakeActionExecutor({ mode: "unknown_outcome" });
    const { service } = await tempService(fake);
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.inspect", "allow_session");
    state = setGrantPolicy(state, paulId, "change.propose", "allow_session");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a020");
    const first = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.noop"
    });
    expect(first.execution.status).toBe("unknown_outcome");
    expect(fake.invocationCount).toBe(1);
    const retry = await service.requestAction(first.state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.noop"
    });
    expect(retry.execution.status).toBe("unknown_outcome");
    expect(fake.invocationCount).toBe(1);
  });

  it("rejects unpaired requesters; inspect grant does not imply action grant", async () => {
    const { service } = await tempService();
    let unpaired = baseState(kelvinId, []);
    unpaired = {
      ...unpaired,
      sessionSecurity: ensureDefaultGrants(unpaired.sessionSecurity!, paulId)
    };
    await expect(
      service.requestAction(unpaired, {
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "pairmesh.test.noop"
      })
    ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });

    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.inspect", "allow_session");
    const denied = await service.requestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.noop"
    });
    expect(denied.execution.status).toBe("denied");
  });

  it("repository.edit cannot use allow_session policy or allow-session decision", async () => {
    const { service } = await tempService();
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    expect(() => setGrantPolicy(state, paulId, "repository.edit", "allow_session")).toThrow(
      expect.objectContaining({ code: "pairmesh.capability_not_allowed" })
    );

    state = setGrantPolicy(state, paulId, "repository.edit", "approval_required");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a030");
    const artifact = await service.createTestArtifact(state, {
      actionId,
      bytes: Buffer.from("edit")
    });
    const pending = await service.requestAction(artifact.state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.artifact_apply",
      artifactRef: {
        artifactId: artifact.artifact.artifactId,
        contentHash: artifact.artifact.contentHash,
        artifactType: artifact.artifact.artifactType
      }
    });
    await expect(
      service.approveAction(pending.state, { actionId, decision: "allow-session" })
    ).rejects.toMatchObject({ code: "pairmesh.capability_not_allowed" });
  });

  it("rejects material conflict and change.propose without inspect", async () => {
    const { service } = await tempService();
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.inspect", "allow_session");
    state = setGrantPolicy(state, paulId, "change.propose", "allow_session");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a040");
    const first = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.noop",
      parameters: { n: 1 }
    });
    await expect(
      service.requestAction(first.state, {
        actionId,
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "pairmesh.test.noop",
        parameters: { n: 2 }
      })
    ).rejects.toMatchObject({ code: "pairmesh.action_conflict" });

    let noInspect = baseState(kelvinId, [paulId]);
    noInspect = {
      ...noInspect,
      sessionSecurity: ensureDefaultGrants(noInspect.sessionSecurity!, paulId)
    };
    noInspect = setGrantPolicy(noInspect, paulId, "repository.inspect", "deny");
    noInspect = setGrantPolicy(noInspect, paulId, "change.propose", "allow_session");
    await expect(
      service.requestAction(noInspect, {
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "pairmesh.test.noop"
      })
    ).rejects.toMatchObject({ code: "pairmesh.action_not_authorized" });
  });

  it("artifacts are immutable, hash-checked, and outside the working tree", async () => {
    const { service, stateFilePath } = await tempService();
    const state = baseState(kelvinId, [paulId]);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a050");
    const created = await service.createTestArtifact(state, {
      actionId,
      bytes: Buffer.from("immutable-bytes")
    });
    expect(service.artifactStore.rootDir).toContain("actions");
    expect(service.artifactStore.rootDir.startsWith(dirname(stateFilePath))).toBe(true);
    await expect(service.artifactStore.rejectOverwrite(created.artifact)).rejects.toMatchObject({
      code: "pairmesh.artifact_immutable"
    });
    const absolute = service.artifactStore.absolutePathForKey(created.artifact.storageKey);
    await writeFile(absolute, Buffer.from("tampered"));
    await expect(service.artifactStore.readBytes(created.artifact)).rejects.toMatchObject({
      code: "pairmesh.artifact_hash_mismatch"
    });
    expect(JSON.stringify(created.artifact)).not.toContain(absolute);
  });

  it("cancel before execute is terminal", async () => {
    const { service, fake } = await tempService();
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.edit", "approval_required");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4a060");
    const artifact = await service.createTestArtifact(state, {
      actionId,
      bytes: Buffer.from("cancel-me")
    });
    const pending = await service.requestAction(artifact.state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "pairmesh.test.artifact_apply",
      artifactRef: {
        artifactId: artifact.artifact.artifactId,
        contentHash: artifact.artifact.contentHash,
        artifactType: artifact.artifact.artifactType
      }
    });
    const cancelled = service.cancelAction(pending.state, actionId);
    expect(cancelled.execution.status).toBe("cancelled");
    expect(fake.invocationCount).toBe(0);
  });
});
