import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  PAIRMESH_METADATA_VERSION,
  PeerIdSchema,
  SessionIdSchema,
  type PeerId
} from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { SessionManager } from "../session/manager.js";
import { LocalStateStore } from "../state/store.js";
import {
  PROPOSAL_FORMAT_V1,
  StaticProposalGenerator,
  buildCanonicalProposalBytes,
  type ProposalArtifactV1
} from "./proposal/index.js";
import { processPairMeshActionWireRequest } from "./remote-handler.js";
import { ActionService } from "./service.js";
import type { PairMeshTestsConfig } from "../local-config/schema.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sarahId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af03");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

const PROPOSE_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/propose-payment-service"
);
const TESTS_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/tests-run-workspace"
);

const RETRY_FIX_DIFF = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -9,7 +9,7 @@",
  "  */",
  " export function rebuildPaymentFromRetryRecord(retryRecord: RetryRecord) {",
  "   return {",
  '-    reference: `retry:${retryRecord.customerId ?? "unknown"}`,',
  "+    reference: retryRecord.reference,",
  "     customerId: retryRecord.customerId ?? null",
  "   };",
  " }",
  ""
].join("\n");

function peerRecord(
  id: PeerId,
  suffix: string,
  displayName: string
): LocalSessionState["peers"][number] {
  const developerId = `dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${suffix}` as const;
  const agentId = `agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${suffix}` as const;
  return {
    participant: {
      id,
      sessionId,
      developerId,
      agentId,
      joinedAt: "2026-08-23T12:00:00.000Z"
    },
    agent: {
      id: agentId,
      developerId,
      deviceId: `devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${suffix}`,
      projectId: `prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${suffix}`,
      name: `${displayName.toLowerCase()}-agent`,
      adapter: "pairmesh.a2a-demo"
    },
    developer: { id: developerId, displayName },
    a2aAgentUrl: "http://127.0.0.1:9/",
    isLocal: false
  };
}

function baseState(peers: PeerId[]): LocalSessionState {
  const localDeveloperId = "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as const;
  const localAgentId = "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as const;
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-ABCDEF",
    session: {
      id: sessionId,
      createdBy: localDeveloperId,
      createdAt: "2026-08-23T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: kelvinId,
        sessionId,
        developerId: localDeveloperId,
        agentId: localAgentId,
        joinedAt: "2026-08-23T12:00:00.000Z"
      },
      agent: {
        id: localAgentId,
        developerId: localDeveloperId,
        deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        name: "kelvin-agent",
        adapter: "pairmesh.a2a-demo"
      },
      developer: { id: localDeveloperId, displayName: "Kelvin" },
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: peers.map((id) =>
      id === paulId
        ? peerRecord(paulId, "01", "Paul")
        : id === sarahId
          ? peerRecord(sarahId, "03", "Sarah")
          : peerRecord(id, "99", "Peer")
    ),
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

function grantAll(state: LocalSessionState, requester: PeerId): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, requester)
  };
  next = setGrantPolicy(next, requester, "repository.inspect", "allow_session");
  next = setGrantPolicy(next, requester, "change.propose", "allow_session");
  next = setGrantPolicy(next, requester, "repository.source_references", "allow_session");
  next = setGrantPolicy(next, requester, "repository.edit", "approval_required");
  next = setGrantPolicy(next, requester, "tests.run", "allow_session");
  return next;
}

const testsConfig = (): PairMeshTestsConfig => ({
  maxConcurrent: 1,
  sessionAllowedProfiles: ["payment-retry"],
  profiles: {
    "payment-retry": {
      executable: "node",
      args: ["src/retry.test.mjs"],
      timeoutMs: 15_000,
      maxOutputBytes: 8_192
    }
  }
});

async function e2eHarness(peers: PeerId[] = [paulId, sarahId]) {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-p6-e2e-ws-"));
  await cp(PROPOSE_FIXTURE, workspace, { recursive: true });
  // Overlay tests-run fixtures for named profile execution in the same workspace.
  await cp(join(TESTS_FIXTURE, "src"), join(workspace, "src"), { recursive: true });
  await cp(join(TESTS_FIXTURE, "scripts"), join(workspace, "scripts"), { recursive: true });

  const dir = await mkdtemp(join(tmpdir(), "pairmesh-p6-e2e-state-"));
  const stateFilePath = join(dir, "state.json");
  const generator = new StaticProposalGenerator({
    summary: "Preserve original payment reference on retry rebuild.",
    providerId: "static",
    unifiedDiff: RETRY_FIX_DIFF
  });
  const service = new ActionService({
    stateFilePath,
    workspaceRoot: workspace,
    proposalGenerator: generator,
    loadTestsConfig: () => testsConfig()
  });
  const stateStore = new LocalStateStore({ stateFilePath });
  let state = baseState(peers);
  for (const peer of peers) {
    state = grantAll(state, peer);
  }
  await stateStore.save(state);

  const manager = new SessionManager({
    stateStore,
    workspaceRoot: workspace,
    actionService: service
  });

  return { manager, service, stateStore, workspace, sessionId };
}

describe("Stage 15 Prompt 6 — local end-to-end propose → approve → apply → test", () => {
  it("Paul propose → Kelvin review → Paul apply waits → Kelvin approve-once → tests.run → replay safe", async () => {
    const { manager, service, stateStore, workspace, sessionId: sid } = await e2eHarness([paulId]);

    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e001");
    const propose = await processPairMeshActionWireRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: sid,
        operation: "request",
        actionId: proposeId,
        actionType: "change.propose",
        parameters: { instruction: "Fix duplicate payment retries." }
      },
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(propose.accepted).toBe(true);
    if (!propose.accepted) return;
    expect(propose.status).toBe("completed");
    expect(propose.artifactRefs?.[0]?.artifactId).toBeTruthy();
    const artifactId = propose.artifactRefs![0]!.artifactId;
    const contentHash = propose.artifactRefs![0]!.contentHash;

    const before = await readFile(join(workspace, "src/retry.ts"), "utf8");
    expect(before).toContain("`retry:${retryRecord.customerId");

    const editId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e002");
    const applyReq = await processPairMeshActionWireRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: sid,
        operation: "request",
        actionId: editId,
        actionType: "repository.edit",
        artifactRef: { artifactId, contentHash, artifactType: "patch_diff" }
      },
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(applyReq.accepted).toBe(true);
    if (!applyReq.accepted) return;
    expect(applyReq.status).toBe("approval_required");
    expect(applyReq.message).toMatch(/Waiting for Kelvin to approve this exact proposal/i);
    expect(await readFile(join(workspace, "src/retry.ts"), "utf8")).toBe(before);
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);

    const reviewed = await manager.reviewActionProposal(editId);
    expect(reviewed.summary).toContain("payment reference");
    expect(reviewed.affectedPaths).toContain("src/retry.ts");
    expect(reviewed.unifiedDiff).toContain("retryRecord.reference");
    expect(JSON.stringify(reviewed)).not.toMatch(/\/Users\//);

    const approved = await manager.approveAction(editId, "allow-once");
    expect(approved.status).toBe("completed");
    expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);
    const after = await readFile(join(workspace, "src/retry.ts"), "utf8");
    expect(after).toContain("reference: retryRecord.reference");

    // Replay edit actionId — no second apply
    const replayEdit = await processPairMeshActionWireRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: sid,
        operation: "request",
        actionId: editId,
        actionType: "repository.edit",
        artifactRef: { artifactId, contentHash, artifactType: "patch_diff" }
      },
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(replayEdit.accepted).toBe(true);
    if (replayEdit.accepted) {
      expect(replayEdit.status).toBe("completed");
    }
    expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);

    const testId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e003");
    const testRun = await processPairMeshActionWireRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: sid,
        operation: "request",
        actionId: testId,
        actionType: "tests.run",
        parameters: { profile: "payment-retry" }
      },
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(testRun.accepted).toBe(true);
    if (!testRun.accepted) return;
    expect(testRun.status).toBe("completed");
    expect(testRun.outputs?.testPassed).toBe(true);
    expect(JSON.stringify(testRun)).not.toMatch(/executableAbsolute|\/usr\/bin\/node/);
    expect(service.testsRunExecutorInstance?.processInvocationCount).toBe(1);

    const replayTest = await processPairMeshActionWireRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId: sid,
        operation: "status",
        actionId: testId
      },
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(replayTest.accepted).toBe(true);
    expect(service.testsRunExecutorInstance?.processInvocationCount).toBe(1);
  });

  it("approving Kelvin artifact A cannot execute artifact B; Sarah pending stays isolated", async () => {
    const { manager, service, stateStore, workspace } = await e2eHarness([paulId, sarahId]);
    let state = (await stateStore.load())!;

    const bodyA: ProposalArtifactV1 = {
      format: PROPOSAL_FORMAT_V1,
      actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e010"),
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      createdAt: "2026-08-23T12:00:00.000Z",
      summary: "Fix A",
      affectedPaths: ["src/retry.ts"],
      unifiedDiff: RETRY_FIX_DIFF,
      stats: { filesChanged: 1, additions: 1, deletions: 1 }
    };
    const bytesA = buildCanonicalProposalBytes(bodyA);
    const artA = await service.createTestArtifact(state, {
      actionId: bodyA.actionId,
      bytes: bytesA
    });
    state = artA.state;

    const bodyB: ProposalArtifactV1 = {
      ...bodyA,
      actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e011"),
      summary: "Fix B — different",
      unifiedDiff: RETRY_FIX_DIFF.replace("reference: retryRecord.reference,", 'reference: "B",')
    };
    const artB = await service.createTestArtifact(state, {
      actionId: bodyB.actionId,
      bytes: buildCanonicalProposalBytes(bodyB)
    });
    state = artB.state;

    const editA = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e012");
    const editB = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e013");
    const pendingA = await service.requestAction(state, {
      actionId: editA,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: artA.artifact.artifactId,
        contentHash: artA.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    state = pendingA.state;
    const pendingB = await service.requestAction(state, {
      actionId: editB,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: artB.artifact.artifactId,
        contentHash: artB.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    state = pendingB.state;

    const sarahEdit = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e014");
    const pendingSarah = await service.requestAction(state, {
      actionId: sarahEdit,
      requesterParticipantId: sarahId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: artA.artifact.artifactId,
        contentHash: artA.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    await stateStore.save(pendingSarah.state);

    const before = await readFile(join(workspace, "src/retry.ts"), "utf8");
    await manager.approveAction(editA, "allow-once");
    expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);
    expect(await readFile(join(workspace, "src/retry.ts"), "utf8")).not.toBe(before);

    // Approving A must not complete B
    const stillB = await manager.getAction(editB);
    expect(stillB.status).toBe("approval_required");

    const stillSarah = await manager.getAction(sarahEdit);
    expect(stillSarah.status).toBe("approval_required");
    expect(stillSarah.requesterParticipantId).toBe(sarahId);
  });

  it("hash mismatch / revoke before execute / completed cannot re-approve", async () => {
    const { manager, service, stateStore } = await e2eHarness([paulId]);
    let state = (await stateStore.load())!;
    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e020");
    const body: ProposalArtifactV1 = {
      format: PROPOSAL_FORMAT_V1,
      actionId: proposeId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      createdAt: "2026-08-23T12:00:00.000Z",
      summary: "Fix",
      affectedPaths: ["src/retry.ts"],
      unifiedDiff: RETRY_FIX_DIFF,
      stats: { filesChanged: 1, additions: 1, deletions: 1 }
    };
    const created = await service.createTestArtifact(state, {
      actionId: proposeId,
      bytes: buildCanonicalProposalBytes(body)
    });
    state = created.state;

    const editId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e021");
    const pending = await service.requestAction(state, {
      actionId: editId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    await stateStore.save(pending.state);

    // Tamper artifact bytes after pending → approve must fail
    const absolute = service.artifactStore.absolutePathForKey(created.artifact.storageKey);
    await writeFile(absolute, Buffer.from('{"format":"pairmesh.proposal.v1","tampered":true}'));

    await expect(manager.approveAction(editId, "allow-once")).rejects.toMatchObject({
      code: expect.stringMatching(/artifact_hash_mismatch|proposal_conflict|action_binding/)
    });
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);

    // Fresh pending then revoke peer before approve
    const { manager: m2, service: s2, stateStore: store2 } = await e2eHarness([paulId]);
    let st2 = (await store2.load())!;
    const c2 = await s2.createTestArtifact(st2, {
      actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e022"),
      bytes: buildCanonicalProposalBytes(body)
    });
    st2 = c2.state;
    const edit2 = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e023");
    const p2 = await s2.requestAction(st2, {
      actionId: edit2,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: c2.artifact.artifactId,
        contentHash: c2.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    st2 = setGrantPolicy(p2.state, paulId, "repository.edit", "deny");
    await store2.save(st2);
    await expect(m2.approveAction(edit2, "allow-once")).rejects.toMatchObject({
      code: "pairmesh.action_not_authorized"
    });
    expect(s2.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);

    // Unknown actionId
    await expect(
      manager.approveAction("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4dead", "allow-once")
    ).rejects.toBeTruthy();

    // Completed cannot re-approve
    const {
      manager: m3,
      service: s3,
      stateStore: store3,
      workspace: ws3
    } = await e2eHarness([paulId]);
    let st3 = (await store3.load())!;
    const c3 = await s3.createTestArtifact(st3, {
      actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e024"),
      bytes: buildCanonicalProposalBytes(body)
    });
    st3 = c3.state;
    const edit3 = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4e025");
    const p3 = await s3.requestAction(st3, {
      actionId: edit3,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: c3.artifact.artifactId,
        contentHash: c3.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    await store3.save(p3.state);
    await m3.approveAction(edit3, "allow-once");
    expect(s3.repositoryEditExecutor?.applyInvocationCount).toBe(1);
    await expect(m3.approveAction(edit3, "allow-once")).rejects.toMatchObject({
      code: "pairmesh.action_invalid_transition"
    });
    expect(s3.repositoryEditExecutor?.applyInvocationCount).toBe(1);
    void ws3;
  });
});
