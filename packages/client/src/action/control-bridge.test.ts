import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, PeerIdSchema, SessionIdSchema, type PeerId } from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { ControlPlane } from "../control/service.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { SessionManager } from "../session/manager.js";
import { LocalStateStore } from "../state/store.js";
import {
  PROPOSAL_FORMAT_V1,
  StaticProposalGenerator,
  buildCanonicalProposalBytes,
  type ProposalArtifactV1
} from "./proposal/index.js";
import { ActionService } from "./service.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sarahId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af03");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/propose-payment-service"
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
    developer: {
      id: developerId,
      displayName
    },
    a2aAgentUrl: "http://127.0.0.1:9/",
    isLocal: false
  };
}

function baseState(localId: PeerId, peers: PeerId[]): LocalSessionState {
  const localSuffix = "02";
  const localDeveloperId = `dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${localSuffix}` as const;
  const localAgentId = `agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${localSuffix}` as const;
  const peerEntries = peers.map((id) => {
    if (id === paulId) {
      return peerRecord(paulId, "01", "Paul");
    }
    if (id === sarahId) {
      return peerRecord(sarahId, "03", "Sarah");
    }
    return peerRecord(id, "99", "Peer");
  });

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
        id: localId,
        sessionId,
        developerId: localDeveloperId,
        agentId: localAgentId,
        joinedAt: "2026-08-23T12:00:00.000Z"
      },
      agent: {
        id: localAgentId,
        developerId: localDeveloperId,
        deviceId: `devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${localSuffix}`,
        projectId: `prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${localSuffix}`,
        name: "kelvin-agent",
        adapter: "pairmesh.a2a-demo"
      },
      developer: {
        id: localDeveloperId,
        displayName: "Kelvin"
      },
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: peerEntries,
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

function grantEdit(state: LocalSessionState, requester: PeerId): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, requester)
  };
  next = setGrantPolicy(next, requester, "repository.inspect", "allow_session");
  next = setGrantPolicy(next, requester, "change.propose", "allow_session");
  next = setGrantPolicy(next, requester, "repository.source_references", "allow_session");
  next = setGrantPolicy(next, requester, "repository.edit", "approval_required");
  return next;
}

async function cloneFixtureWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-bridge-ws-"));
  await cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

async function createProposalArtifact(
  service: ActionService,
  state: LocalSessionState,
  options: {
    actionId: ReturnType<typeof ActionIdSchema.parse>;
    requesterParticipantId?: PeerId;
    targetParticipantId?: PeerId;
  }
) {
  const proposal: ProposalArtifactV1 = {
    format: PROPOSAL_FORMAT_V1,
    actionId: options.actionId,
    requesterParticipantId: options.requesterParticipantId ?? paulId,
    targetParticipantId: options.targetParticipantId ?? kelvinId,
    createdAt: "2026-08-23T12:00:00.000Z",
    summary: "Preserve original payment reference on retry rebuild.",
    affectedPaths: ["src/retry.ts"],
    unifiedDiff: RETRY_FIX_DIFF,
    stats: { filesChanged: 1, additions: 1, deletions: 1 }
  };
  const bytes = buildCanonicalProposalBytes(proposal);
  return service.createTestArtifact(state, {
    actionId: options.actionId,
    bytes,
    artifactType: "patch_diff"
  });
}

async function bridgeHarness(peerIds: PeerId[] = [paulId]) {
  const workspace = await cloneFixtureWorkspace();
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-bridge-state-"));
  const stateFilePath = join(dir, "state.json");
  const stateStore = new LocalStateStore({ stateFilePath });
  const generator = new StaticProposalGenerator({
    summary: "static",
    unifiedDiff: RETRY_FIX_DIFF,
    providerId: "static"
  });
  const service = new ActionService({
    stateFilePath,
    workspaceRoot: workspace,
    proposalGenerator: generator
  });
  const manager = new SessionManager({
    stateStore,
    workspaceRoot: workspace,
    actionService: service,
    skipPeerHealthPreflight: true
  });
  let state = grantEdit(baseState(kelvinId, peerIds), paulId);
  for (const peerId of peerIds) {
    if (peerId !== paulId) {
      state = grantEdit(state, peerId);
    }
  }
  await stateStore.save(state);
  return { manager, service, stateStore, workspace, stateFilePath };
}

describe("Stage 15 Prompt 6 — Control/SessionManager action bridge", () => {
  it("repository.edit request reaches approval_required with linked permission", async () => {
    const { manager, service, stateStore } = await bridgeHarness();
    let state = (await stateStore.load())!;
    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b001");
    const editId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b002");
    const created = await createProposalArtifact(service, state, { actionId: proposeId });
    state = created.state;
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

    expect(pending.execution.status).toBe("approval_required");
    expect(pending.execution.permissionRequestId).toBeTruthy();

    const listed = await manager.listPendingActions();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.actionId).toBe(editId);
    expect(listed[0]?.actionType).toBe("repository.edit");
    expect(listed[0]?.permissionRequestId).toBe(pending.execution.permissionRequestId);
  });

  it("decidePendingPermission(allow-once) applies via ActionService and syncs permission", async () => {
    const { manager, service, stateStore, workspace } = await bridgeHarness();
    let state = (await stateStore.load())!;
    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b010");
    const editId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b011");
    const created = await createProposalArtifact(service, state, { actionId: proposeId });
    state = created.state;
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

    const before = await readFile(join(workspace, "src/retry.ts"), "utf8");
    expect(before).toContain("`retry:${retryRecord.customerId");

    const request = await manager.decidePendingPermission(
      pending.execution.permissionRequestId!,
      "allow-once"
    );
    expect(request.status).toBe("approved");
    expect(request.decision).toBe("allow-once");

    const action = await manager.getAction(editId);
    expect(action.status).toBe("completed");
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(1);

    const after = await readFile(join(workspace, "src/retry.ts"), "utf8");
    expect(after).toContain("reference: retryRecord.reference");
    expect(after).not.toContain("`retry:${retryRecord.customerId");
  });

  it("deny leaves working tree unchanged and marks action denied", async () => {
    const { manager, service, stateStore, workspace } = await bridgeHarness();
    let state = (await stateStore.load())!;
    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b020");
    const editId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b021");
    const created = await createProposalArtifact(service, state, { actionId: proposeId });
    state = created.state;
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
    const before = await readFile(join(workspace, "src/retry.ts"), "utf8");

    const request = await manager.decidePendingPermission(
      pending.execution.permissionRequestId!,
      "deny"
    );
    expect(request.status).toBe("denied");
    expect(request.decision).toBe("deny");

    const action = await manager.getAction(editId);
    expect(action.status).toBe("denied");
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);
    expect(await readFile(join(workspace, "src/retry.ts"), "utf8")).toBe(before);
  });

  it("SessionManager has no remote self-approve shortcut without local state mutation path", () => {
    const proto = SessionManager.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.approveAction).toBe("function");
    expect(typeof proto.decidePendingPermission).toBe("function");
    expect(proto).not.toHaveProperty("approveRemoteAction");
    expect(proto).not.toHaveProperty("mcpApproveAction");
    expect(Object.getOwnPropertyNames(SessionManager.prototype)).not.toContain(
      "approveActionWithBearer"
    );
  });

  it("Paul action cannot be approved via Sarah's permission request id", async () => {
    const { manager, service, stateStore } = await bridgeHarness([paulId, sarahId]);
    let state = (await stateStore.load())!;

    const paulPropose = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b030");
    const paulEdit = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b031");
    const sarahPropose = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b032");
    const sarahEdit = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b033");

    const paulArtifact = await createProposalArtifact(service, state, {
      actionId: paulPropose,
      requesterParticipantId: paulId
    });
    state = paulArtifact.state;
    const paulPending = await service.requestAction(state, {
      actionId: paulEdit,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: paulArtifact.artifact.artifactId,
        contentHash: paulArtifact.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    state = paulPending.state;

    const sarahArtifact = await createProposalArtifact(service, state, {
      actionId: sarahPropose,
      requesterParticipantId: sarahId
    });
    state = sarahArtifact.state;
    const sarahPending = await service.requestAction(state, {
      actionId: sarahEdit,
      requesterParticipantId: sarahId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: sarahArtifact.artifact.artifactId,
        contentHash: sarahArtifact.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    await stateStore.save(sarahPending.state);

    await manager.decidePendingPermission(sarahPending.execution.permissionRequestId!, "deny");

    const paulStill = await manager.getAction(paulEdit);
    expect(paulStill.status).toBe("approval_required");
    expect(paulStill.permissionRequestId).toBe(paulPending.execution.permissionRequestId);

    const sarahDone = await manager.getAction(sarahEdit);
    expect(sarahDone.status).toBe("denied");
  });

  it("expired approval does not apply and syncs permission to expired", async () => {
    const { manager, service, stateStore, workspace } = await bridgeHarness();
    let state = (await stateStore.load())!;
    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b040");
    const editId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b041");
    const created = await createProposalArtifact(service, state, { actionId: proposeId });
    state = created.state;
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
    const expiredBinding = {
      ...pending.execution.approvalBinding!,
      expiresAt: "2020-01-01T00:00:00.000Z"
    };
    const expiredExecution = {
      ...pending.execution,
      approvalBinding: expiredBinding
    };
    const expiredPermission = (pending.state.permissionRequests ?? []).map((entry) =>
      entry.permissionRequestId === pending.execution.permissionRequestId
        ? { ...entry, expiresAt: "2020-01-01T00:00:00.000Z" }
        : entry
    );
    await stateStore.save({
      ...pending.state,
      actionExecutions: [expiredExecution],
      permissionRequests: expiredPermission
    });
    const before = await readFile(join(workspace, "src/retry.ts"), "utf8");

    const result = await manager.approveAction(editId, "allow-once");
    expect(result.status).toBe("expired");
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);
    expect(await readFile(join(workspace, "src/retry.ts"), "utf8")).toBe(before);

    const loaded = await stateStore.load();
    const permission = loaded?.permissionRequests?.find(
      (entry) => entry.permissionRequestId === pending.execution.permissionRequestId
    );
    expect(permission?.status).toBe("expired");
  });

  it("listPendingActions isolates multi-peer approval inbox", async () => {
    const { manager, service, stateStore } = await bridgeHarness([paulId, sarahId]);
    let state = (await stateStore.load())!;
    const paulPropose = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b050");
    const paulEdit = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b051");
    const sarahPropose = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b052");
    const sarahEdit = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b053");

    const paulArtifact = await createProposalArtifact(service, state, {
      actionId: paulPropose,
      requesterParticipantId: paulId
    });
    state = paulArtifact.state;
    const paulPending = await service.requestAction(state, {
      actionId: paulEdit,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: paulArtifact.artifact.artifactId,
        contentHash: paulArtifact.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    state = paulPending.state;

    const sarahArtifact = await createProposalArtifact(service, state, {
      actionId: sarahPropose,
      requesterParticipantId: sarahId
    });
    state = sarahArtifact.state;
    const sarahPending = await service.requestAction(state, {
      actionId: sarahEdit,
      requesterParticipantId: sarahId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: sarahArtifact.artifact.artifactId,
        contentHash: sarahArtifact.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });

    const requesterMirror = {
      ...sarahPending.execution,
      actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b054"),
      requesterParticipantId: kelvinId,
      targetParticipantId: paulId,
      permissionRequestId: undefined
    };
    await stateStore.save({
      ...sarahPending.state,
      actionExecutions: [...(sarahPending.state.actionExecutions ?? []), requesterMirror]
    });

    const pending = await manager.listPendingActions();
    expect(pending.map((entry) => entry.actionId).sort()).toEqual([paulEdit, sarahEdit].sort());
    expect(pending.every((entry) => entry.targetParticipantId === kelvinId)).toBe(true);
    expect(pending.find((entry) => entry.actionId === requesterMirror.actionId)).toBeUndefined();
  });

  it("ControlPlane surfaces pending actions and decide bridge", async () => {
    const { manager, service, stateStore } = await bridgeHarness();
    const plane = new ControlPlane({ sessionManager: manager });
    let state = (await stateStore.load())!;
    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b060");
    const editId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b061");
    const created = await createProposalArtifact(service, state, { actionId: proposeId });
    state = created.state;
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

    const listed = await plane.listPendingActions();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.actionId).toBe(editId);

    const permissions = await plane.getPermissions();
    const row = permissions.pending.find(
      (entry) => entry.permissionRequestId === pending.execution.permissionRequestId
    );
    expect(row?.actionType).toBe("repository.edit");

    await plane.decidePermission(pending.execution.permissionRequestId!, "allow-once");
    const action = await plane.getAction(editId);
    expect(action.status).toBe("completed");
  });
});
