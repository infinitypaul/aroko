import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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
import { LocalStateStore } from "../state/store.js";
import { SessionManager } from "../session/manager.js";
import { OwnerPresence } from "../notify/owner-presence.js";
import {
  PROPOSAL_FORMAT_V1,
  StaticProposalGenerator,
  buildCanonicalProposalBytes,
  type ProposalArtifactV1
} from "./proposal/index.js";
import { processPairMeshActionWireRequest } from "./remote-handler.js";
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

async function cloneFixtureWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-action-wire-ws-"));
  await cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

async function wireHarness(options?: { peers?: PeerId[] }) {
  const workspace = await cloneFixtureWorkspace();
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-action-wire-state-"));
  const stateFilePath = join(dir, "state.json");
  const generator = new StaticProposalGenerator({
    summary: "Preserve original payment reference on retry rebuild.",
    providerId: "static",
    unifiedDiff: RETRY_FIX_DIFF
  });
  const service = new ActionService({
    stateFilePath,
    workspaceRoot: workspace,
    proposalGenerator: generator
  });
  const stateStore = new LocalStateStore({ stateFilePath });
  const peers = options?.peers ?? [paulId];
  let state = baseState(kelvinId, peers);
  for (const peer of peers) {
    state = grantPropose(state, peer);
  }
  await stateStore.save(state);
  return { service, stateStore, workspace, generator, stateFilePath, dir };
}

function grantPropose(state: LocalSessionState, requester: PeerId): LocalSessionState {
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

function wireRequest(partial: {
  operation?: "request" | "status" | "cancel";
  actionId?: string;
  actionType?: string;
  parameters?: Record<string, string | number | boolean | null | string[]>;
  artifactRef?: {
    artifactId: string;
    contentHash: string;
    artifactType: "patch_diff" | "structured_result" | "test_fixture";
  };
}) {
  return {
    metadataVersion: PAIRMESH_METADATA_VERSION,
    sessionId,
    operation: partial.operation ?? ("request" as const),
    actionId: ActionIdSchema.parse(partial.actionId ?? "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c001"),
    actionType: partial.actionType,
    parameters: partial.parameters,
    artifactRef: partial.artifactRef
  };
}

describe("Stage 15 Prompt 6 — action A2A remote handler", () => {
  it("rejects unpaired requester", async () => {
    const { service, stateStore } = await wireHarness({ peers: [] });
    const response = await processPairMeshActionWireRequest(
      wireRequest({
        actionType: "change.propose",
        parameters: { instruction: "fix retry reference reconstruction" }
      }),
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(response.accepted).toBe(false);
    if (!response.accepted) {
      expect(response.error.code).toBe("pairmesh.authentication_required");
    }
  });

  it("completes change.propose via StaticProposalGenerator", async () => {
    const { service, stateStore, generator } = await wireHarness();
    const actionId = "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c010";
    const response = await processPairMeshActionWireRequest(
      wireRequest({
        actionId,
        actionType: "change.propose",
        parameters: {
          instruction:
            "Change the retry reconstruction so the original payment reference is preserved."
        }
      }),
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(response.accepted).toBe(true);
    if (response.accepted) {
      expect(response.status).toBe("completed");
      expect(response.actionType).toBe("change.propose");
      expect(response.executorInvocationCount).toBe(1);
      expect(response.artifactRefs?.length).toBe(1);
    }
    expect(generator.invocationCount).toBe(1);
  });

  it("returns approval_required for repository.edit with waiting message", async () => {
    const { service, stateStore } = await wireHarness();
    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c020");
    const state = (await stateStore.load())!;
    const proposal: ProposalArtifactV1 = {
      format: PROPOSAL_FORMAT_V1,
      actionId: proposeId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      createdAt: "2026-08-23T12:00:00.000Z",
      summary: "Preserve original payment reference on retry rebuild.",
      affectedPaths: ["src/retry.ts"],
      unifiedDiff: RETRY_FIX_DIFF,
      stats: { filesChanged: 1, additions: 1, deletions: 1 }
    };
    const created = await service.createTestArtifact(state, {
      actionId: proposeId,
      bytes: buildCanonicalProposalBytes(proposal),
      artifactType: "patch_diff"
    });
    await stateStore.save(created.state);

    const editId = "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c021";
    const response = await processPairMeshActionWireRequest(
      wireRequest({
        actionId: editId,
        actionType: "repository.edit",
        artifactRef: {
          artifactId: created.artifact.artifactId,
          contentHash: created.artifact.contentHash,
          artifactType: "patch_diff"
        }
      }),
      { stateStore, actionService: service, participantId: paulId }
    );

    expect(response.accepted).toBe(true);
    if (response.accepted) {
      expect(response.status).toBe("approval_required");
      expect(response.message).toBe("Waiting for Kelvin to approve this exact proposal.");
      expect(response.permissionRequestId).toBeTruthy();
      // Stage 16 Prompt 2: progress stays local — not on A2A wire.
      expect("progress" in response).toBe(false);
      expect("progressEvents" in response).toBe(false);
    }
  });

  it("shared ActionService notifies OwnerPresence on remote approval_required", async () => {
    // Regression: inbound A2A used a separate ActionService, so Inbox updated
    // but OwnerPresence (hooked on SessionManager's service) never ran — no OS banner.
    const deliver = vi.fn(async () => ({
      delivered: true,
      method: "bundled-mac-notifier" as const,
      clickOpensUrl: true
    }));
    const { service, stateStore, workspace } = await wireHarness();
    const manager = new SessionManager({
      stateStore,
      workspaceRoot: workspace,
      actionService: service
    });
    manager.attachOwnerPresence(
      new OwnerPresence({
        controlBaseUrl: "http://127.0.0.1:9999",
        controlToken: "tok_test",
        deliver
      })
    );

    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c060");
    const state = (await stateStore.load())!;
    const proposal: ProposalArtifactV1 = {
      format: PROPOSAL_FORMAT_V1,
      actionId: proposeId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      createdAt: "2026-08-23T12:00:00.000Z",
      summary: "Preserve original payment reference on retry rebuild.",
      affectedPaths: ["src/retry.ts"],
      unifiedDiff: RETRY_FIX_DIFF,
      stats: { filesChanged: 1, additions: 1, deletions: 1 }
    };
    const created = await service.createTestArtifact(state, {
      actionId: proposeId,
      bytes: buildCanonicalProposalBytes(proposal),
      artifactType: "patch_diff"
    });
    await stateStore.save(created.state);

    const editId = "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c061";
    const response = await processPairMeshActionWireRequest(
      wireRequest({
        actionId: editId,
        actionType: "repository.edit",
        artifactRef: {
          artifactId: created.artifact.artifactId,
          contentHash: created.artifact.contentHash,
          artifactType: "patch_diff"
        }
      }),
      { stateStore, actionService: manager.getActionService(), participantId: paulId }
    );

    expect(response.accepted).toBe(true);
    if (response.accepted) {
      expect(response.status).toBe("approval_required");
    }

    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalled();
    });
    const payload = deliver.mock.calls[0]![0];
    expect(payload.openUrl).toContain("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c061");
  });

  it("status does not re-invoke the executor", async () => {
    const { service, stateStore, generator } = await wireHarness();
    const actionId = "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c030";
    const first = await processPairMeshActionWireRequest(
      wireRequest({
        actionId,
        actionType: "change.propose",
        parameters: { instruction: "Preserve original payment reference." }
      }),
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(first.accepted).toBe(true);
    expect(generator.invocationCount).toBe(1);

    const status = await processPairMeshActionWireRequest(
      wireRequest({ actionId, operation: "status" }),
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(status.accepted).toBe(true);
    if (status.accepted) {
      expect(status.status).toBe("completed");
      expect(status.executorInvocationCount).toBe(1);
    }
    expect(generator.invocationCount).toBe(1);
  });

  it("cancels a pending repository.edit", async () => {
    const { service, stateStore } = await wireHarness();
    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c040");
    const state = (await stateStore.load())!;
    const proposal: ProposalArtifactV1 = {
      format: PROPOSAL_FORMAT_V1,
      actionId: proposeId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      createdAt: "2026-08-23T12:00:00.000Z",
      summary: "Preserve original payment reference on retry rebuild.",
      affectedPaths: ["src/retry.ts"],
      unifiedDiff: RETRY_FIX_DIFF,
      stats: { filesChanged: 1, additions: 1, deletions: 1 }
    };
    const created = await service.createTestArtifact(state, {
      actionId: proposeId,
      bytes: buildCanonicalProposalBytes(proposal),
      artifactType: "patch_diff"
    });
    await stateStore.save(created.state);

    const editId = "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c041";
    const pending = await processPairMeshActionWireRequest(
      wireRequest({
        actionId: editId,
        actionType: "repository.edit",
        artifactRef: {
          artifactId: created.artifact.artifactId,
          contentHash: created.artifact.contentHash,
          artifactType: "patch_diff"
        }
      }),
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(pending.accepted && pending.status).toBe("approval_required");

    const cancelled = await processPairMeshActionWireRequest(
      wireRequest({ actionId: editId, operation: "cancel" }),
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(cancelled.accepted).toBe(true);
    if (cancelled.accepted) {
      expect(cancelled.status).toBe("cancelled");
    }
  });

  it("wrong requester cannot status another peer's action", async () => {
    const { service, stateStore } = await wireHarness({ peers: [paulId, sarahId] });
    const actionId = "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c050";
    const created = await processPairMeshActionWireRequest(
      wireRequest({
        actionId,
        actionType: "change.propose",
        parameters: { instruction: "Preserve original payment reference." }
      }),
      { stateStore, actionService: service, participantId: paulId }
    );
    expect(created.accepted).toBe(true);

    const status = await processPairMeshActionWireRequest(
      wireRequest({ actionId, operation: "status" }),
      { stateStore, actionService: service, participantId: sarahId }
    );
    expect(status.accepted).toBe(false);
    if (!status.accepted) {
      expect(status.error.code).toBe("pairmesh.action_not_authorized");
    }
  });
});
