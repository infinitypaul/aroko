import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InspectionThreadIdSchema,
  PAIRMESH_MAX_COLLABORATION_PARTICIPANTS,
  PAIRMESH_METADATA_VERSION,
  PeerIdSchema,
  SessionIdSchema
} from "@pairmesh/protocol";
import { createInvite, validateInviteSecret } from "../auth/invites.js";
import { issueInboundCredential } from "../auth/credentials.js";
import { getGrantPolicy, setGrantPolicy } from "../auth/capabilities.js";
import { requireOutboundBearer } from "../auth/session-security.js";
import { generateBearerToken } from "../auth/secrets.js";
import { processPairMeshInspectionRequest } from "../inspect/handler.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { LocalStateStore } from "../state/store.js";
import { SessionManager, resolvePeerRecord } from "./manager.js";
import {
  collaborationParticipantCount,
  isPairedWithLocal,
  listCollaborationMembers,
  peerRelationshipStatus
} from "./relationship.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "./schemas.js";
import { processPairMeshJoinRequest } from "./handshake-server.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/payment-workspace"
);

async function tempStore(): Promise<{ store: LocalStateStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-multi-peer-"));
  const path = join(dir, "state.json");
  return { path, store: new LocalStateStore({ stateFilePath: path }) };
}

function id(prefix: "peer" | "agt" | "dev" | "devc" | "prj" | "ses" | "thr"): string {
  return `${prefix}_${randomUUID()}`;
}

function peerStub(
  state: LocalSessionState,
  options: {
    name: string;
    participantId: string;
    agentId: string;
    developerId: string;
    deviceId: string;
    url: string;
    outboundBearer?: string;
  }
): LocalSessionState["peers"][number] {
  return {
    participant: {
      id: PeerIdSchema.parse(options.participantId),
      sessionId: state.session.id,
      developerId: options.developerId,
      agentId: options.agentId,
      joinedAt: state.session.createdAt
    },
    agent: {
      id: options.agentId,
      developerId: options.developerId,
      deviceId: options.deviceId,
      projectId: state.localParticipant.agent.projectId,
      name: options.name,
      adapter: "pairmesh.a2a-demo"
    },
    developer: {
      id: options.developerId,
      displayName: options.name
    },
    a2aAgentUrl: options.url,
    isLocal: false,
    ...(options.outboundBearer ? { outboundBearer: options.outboundBearer as never } : {})
  };
}

describe("Stage 14 multi-peer state/trust", () => {
  it("represents third and fourth participants with duplicate display names", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:5101" });
    const state = await store.load();
    if (!state?.sessionSecurity) throw new Error("expected security");

    const alexA = peerStub(state, {
      name: "Alex",
      participantId: id("peer"),
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:5102",
      outboundBearer: generateBearerToken()
    });
    const alexB = peerStub(state, {
      name: "Alex",
      participantId: id("peer"),
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:5103",
      outboundBearer: generateBearerToken()
    });
    const david = peerStub(state, {
      name: "david",
      participantId: id("peer"),
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:5104"
    });

    await store.save({
      ...state,
      peers: [alexA, alexB, david]
    });

    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");
    expect(collaborationParticipantCount(loaded)).toBe(4);
    expect(listCollaborationMembers(loaded)).toHaveLength(4);
    expect(isPairedWithLocal(alexA)).toBe(true);
    expect(isPairedWithLocal(david)).toBe(false);
    expect(peerRelationshipStatus(loaded, david)).toBe("unpaired");

    expect(() => resolvePeerRecord(loaded, "Alex")).toThrow(/Multiple peers match/);
    expect(resolvePeerRecord(loaded, alexA.participant.id)?.agent.id).toBe(alexA.agent.id);
  });

  it("isolates outbound credentials across relationships", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:5201" });
    const state = await store.load();
    if (!state?.sessionSecurity) throw new Error("expected security");

    const kelvinBearer = generateBearerToken();
    const sarahBearer = generateBearerToken();
    const kelvin = peerStub(state, {
      name: "kelvin",
      participantId: id("peer"),
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:5202",
      outboundBearer: kelvinBearer
    });
    const sarah = peerStub(state, {
      name: "sarah",
      participantId: id("peer"),
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:5203",
      outboundBearer: sarahBearer
    });
    await store.save({ ...state, peers: [kelvin, sarah] });
    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");

    expect(requireOutboundBearer(loaded, kelvin)).toBe(kelvinBearer);
    expect(requireOutboundBearer(loaded, sarah)).toBe(sarahBearer);
    expect(kelvinBearer).not.toBe(sarahBearer);
  });

  it("keeps invite initialGrants scoped to the inviter receiver participant", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({
      name: "paul",
      agentUrl: "http://127.0.0.1:5301",
      initialGrants: [
        { capabilityId: "repository.inspect", policy: "allow_session" },
        { capabilityId: "repository.source_references", policy: "deny" }
      ]
    });

    const invite = (await store.load())?.sessionSecurity?.invites[0];
    expect(invite?.initialGrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityId: "repository.inspect", policy: "allow_session" }),
        expect.objectContaining({
          capabilityId: "repository.source_references",
          policy: "deny"
        })
      ])
    );
    expect(invite?.inviterParticipantId).toBeDefined();
  });

  it("supports multiple outstanding invites with independent revoke/redeem isolation", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    const created = await manager.createSession({
      name: "paul",
      agentUrl: "http://127.0.0.1:5401"
    });
    const second = await manager.createSessionInvite();
    expect(created.invite.invitationId).toBeDefined();
    expect(second.invitationId).toBeDefined();
    expect(second.invitationId).not.toBe(created.invite.invitationId);

    await manager.revokeSessionInvite(second.invitationId!);
    const security = (await store.load())?.sessionSecurity;
    if (!security) throw new Error("expected security");
    expect(validateInviteSecret(security, created.invite.inviteSecret).ok).toBe(true);
    expect(validateInviteSecret(security, second.inviteSecret)).toMatchObject({
      ok: false,
      code: "pairmesh.invite_invalid"
    });
    expect((await manager.getSessionStatus()).security.openInvites).toBe(1);
  });

  it("isolates Stage 10 grants and approvals per remote participant", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "kelvin", agentUrl: "http://127.0.0.1:5501" });
    let state = await store.load();
    if (!state?.sessionSecurity) throw new Error("expected security");

    const paulId = id("peer");
    const sarahId = id("peer");
    const paul = peerStub(state, {
      name: "paul",
      participantId: paulId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:5502",
      outboundBearer: generateBearerToken()
    });
    const sarah = peerStub(state, {
      name: "sarah",
      participantId: sarahId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:5503",
      outboundBearer: generateBearerToken()
    });

    state = setGrantPolicy(
      { ...state, peers: [paul, sarah] },
      paulId,
      "repository.inspect",
      "allow_session"
    );
    state = setGrantPolicy(state, sarahId, "repository.inspect", "approval_required");
    state = setGrantPolicy(state, sarahId, "repository.source_references", "deny");
    await store.save(state);

    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");
    expect(getGrantPolicy(loaded, paulId, "repository.inspect")).toBe("allow_session");
    expect(getGrantPolicy(loaded, sarahId, "repository.inspect")).toBe("approval_required");
    expect(getGrantPolicy(loaded, sarahId, "repository.source_references")).toBe("deny");
    expect(getGrantPolicy(loaded, paulId, "repository.source_references")).not.toBe("deny");
  });

  it("attributes inspection threads to authenticated participant independent of peers order", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "kelvin", agentUrl: "http://127.0.0.1:5601" });
    const state = await store.load();
    if (!state) throw new Error("expected state");

    const paulId = id("peer");
    const sarahId = id("peer");
    const sarah = peerStub(state, {
      name: "sarah",
      participantId: sarahId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:5603",
      outboundBearer: generateBearerToken()
    });
    const paul = peerStub(state, {
      name: "paul",
      participantId: paulId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:5602",
      outboundBearer: generateBearerToken()
    });
    await store.save({ ...state, peers: [sarah, paul] });

    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const request = {
      metadataVersion: PAIRMESH_METADATA_VERSION,
      sessionId: state.session.id,
      threadId: InspectionThreadIdSchema.parse(id("thr")),
      requestId: "req_attr_paul",
      question: "Where is customerId reconstructed?",
      turnNumber: 1
    };

    const withoutAuth = await processPairMeshInspectionRequest(request, adapter, store);
    expect(withoutAuth.accepted).toBe(false);
    if (!withoutAuth.accepted) {
      expect(withoutAuth.error.code).toBe("pairmesh.authentication_required");
    }

    const withPaul = await processPairMeshInspectionRequest(request, adapter, store, {
      participantId: paulId
    });
    if (!withPaul.accepted) {
      throw new Error(
        `expected accepted inspection, got ${withPaul.error.code}: ${withPaul.error.message}`
      );
    }
    expect(withPaul.accepted).toBe(true);
    const after = await store.load();
    expect(after?.inspectionThreads[0]?.thread.initiatorPeerId).toBe(paulId);

    const followAsSarah = await processPairMeshInspectionRequest(
      { ...request, requestId: "req_attr_sarah", turnNumber: 2, question: "follow-up" },
      adapter,
      store,
      { participantId: sarahId }
    );
    expect(followAsSarah.accepted).toBe(false);
    if (!followAsSarah.accepted) {
      expect(followAsSarah.error.code).toBe("pairmesh.permission_denied");
    }
  });

  it("rejects collaboration growth beyond alpha max participants", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:5701" });
    const state = await store.load();
    if (!state?.sessionSecurity) throw new Error("expected security");

    const peers = Array.from({ length: PAIRMESH_MAX_COLLABORATION_PARTICIPANTS - 1 }, (_, i) =>
      peerStub(state, {
        name: `peer${i}`,
        participantId: id("peer"),
        agentId: id("agt"),
        developerId: id("dev"),
        deviceId: id("devc"),
        url: `http://127.0.0.1:${5800 + i}`
      })
    );
    await store.save({ ...state, peers });
    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");
    expect(collaborationParticipantCount(loaded)).toBe(PAIRMESH_MAX_COLLABORATION_PARTICIPANTS);

    const invite = createInvite({
      inviterParticipantId: loaded.localParticipant.participant.id
    });
    await store.save({
      ...loaded,
      sessionSecurity: {
        ...loaded.sessionSecurity!,
        invites: [...(loaded.sessionSecurity?.invites ?? []), invite.record]
      }
    });

    const ninthDev = id("dev");
    const ninthDevice = id("devc");
    const response = await processPairMeshJoinRequest(store, {
      metadataVersion: PAIRMESH_METADATA_VERSION,
      sessionCode: loaded.sessionCode,
      inviteSecret: invite.secret,
      offeredInboundBearer: generateBearerToken(),
      participant: {
        peerId: PeerIdSchema.parse(id("peer")),
        developer: { id: ninthDev, displayName: "ninth" },
        device: { id: ninthDevice, developerId: ninthDev, name: "ninth-device" },
        agent: {
          id: id("agt"),
          developerId: ninthDev,
          deviceId: ninthDevice,
          projectId: loaded.localParticipant.agent.projectId,
          name: "ninth",
          adapter: "pairmesh.a2a-demo"
        },
        a2aAgentUrl: "http://127.0.0.1:5999"
      }
    });
    expect(response.accepted).toBe(false);
    if (!response.accepted) {
      expect(response.error.code).toBe("pairmesh.collaboration_full");
    }
  });

  it("keeps creator departure local without mutating surviving relationship state files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-creator-leave-"));
    const kelvinStore = new LocalStateStore({ stateFilePath: join(dir, "kelvin.json") });

    const sessionId = SessionIdSchema.parse(id("ses"));
    const kelvinDev = id("dev");
    const kelvinAgent = id("agt");
    const kelvinDevice = id("devc");
    const kelvinPeer = id("peer");
    const sarahDev = id("dev");
    const sarahAgent = id("agt");
    const sarahDevice = id("devc");
    const sarahPeer = id("peer");
    const kelvinBearer = generateBearerToken();

    const baseState: LocalSessionState = {
      stateVersion: LOCAL_STATE_VERSION,
      sessionCode: "PM-TEAM42",
      session: {
        id: sessionId,
        createdBy: id("dev"),
        createdAt: "2026-08-21T00:00:00.000Z",
        status: "active"
      },
      localParticipant: {
        participant: {
          id: PeerIdSchema.parse(kelvinPeer),
          sessionId,
          developerId: kelvinDev,
          agentId: kelvinAgent,
          joinedAt: "2026-08-21T00:00:00.000Z"
        },
        agent: {
          id: kelvinAgent,
          developerId: kelvinDev,
          deviceId: kelvinDevice,
          projectId: id("prj"),
          name: "kelvin",
          adapter: "pairmesh.a2a-demo"
        },
        developer: { id: kelvinDev, displayName: "kelvin" },
        a2aAgentUrl: "http://127.0.0.1:5901",
        isLocal: true
      },
      peers: [],
      inspectionThreads: [],
      inspectionExecutions: [],
      permissionRequests: [],
      sessionSecurity: {
        securityVersion: "v1",
        invites: [],
        acceptedInbound: [],
        capabilityGrants: []
      }
    };

    const sarah = peerStub(baseState, {
      name: "sarah",
      participantId: sarahPeer,
      agentId: sarahAgent,
      developerId: sarahDev,
      deviceId: sarahDevice,
      url: "http://127.0.0.1:5902",
      outboundBearer: kelvinBearer
    });

    await kelvinStore.save({
      ...baseState,
      peers: [sarah],
      sessionSecurity: {
        securityVersion: "v1",
        invites: [],
        acceptedInbound: [issueInboundCredential(sarah.participant.id).credential],
        capabilityGrants: []
      }
    });

    const paulStore = new LocalStateStore({ stateFilePath: join(dir, "paul.json") });
    const paulManager = new SessionManager({ stateStore: paulStore });
    await paulManager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:5900" });
    await paulManager.leaveSession();
    expect(await paulStore.load()).toBeNull();

    const kelvinAfter = await kelvinStore.load();
    expect(kelvinAfter?.peers).toHaveLength(1);
    expect(kelvinAfter?.peers[0]?.outboundBearer).toBe(kelvinBearer);
  });

  it("re-pair preserves existing relay connectivity and pairwise a2aAgentUrl", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    const created = await manager.createSession({
      name: "paul",
      agentUrl: "http://127.0.0.1:5800"
    });
    const loaded = await store.load();
    if (!loaded?.sessionSecurity) throw new Error("missing security");

    const kelvinDev = id("dev");
    const kelvinDevice = id("devc");
    const kelvinPeerId = PeerIdSchema.parse(id("peer"));
    const kelvinAgentId = id("agt");
    const tunnelUrl = "http://127.0.0.1:48111";

    const peerWithRelay = peerStub(loaded, {
      name: "kelvin-agent",
      participantId: kelvinPeerId,
      agentId: kelvinAgentId,
      developerId: kelvinDev,
      deviceId: kelvinDevice,
      url: tunnelUrl,
      outboundBearer: generateBearerToken()
    });
    peerWithRelay.connectivity = {
      mode: "relay",
      relayPresenceId: "join_repair_test",
      peerTransportPublicKey: "ab".repeat(32)
    };

    const invite = createInvite({
      inviterParticipantId: loaded.localParticipant.participant.id
    });
    await store.save({
      ...loaded,
      peers: [peerWithRelay],
      sessionSecurity: {
        ...loaded.sessionSecurity,
        invites: [...(loaded.sessionSecurity.invites ?? []), invite.record],
        acceptedInbound: [
          ...loaded.sessionSecurity.acceptedInbound,
          issueInboundCredential(kelvinPeerId).credential
        ]
      }
    });

    const response = await processPairMeshJoinRequest(store, {
      metadataVersion: PAIRMESH_METADATA_VERSION,
      sessionCode: created.sessionCode,
      inviteSecret: invite.secret,
      offeredInboundBearer: generateBearerToken(),
      participant: {
        peerId: kelvinPeerId,
        developer: { id: kelvinDev, displayName: "kelvin" },
        device: { id: kelvinDevice, developerId: kelvinDev, name: "kelvin-device" },
        agent: {
          id: kelvinAgentId,
          developerId: kelvinDev,
          deviceId: kelvinDevice,
          projectId: loaded.localParticipant.agent.projectId,
          name: "kelvin-agent",
          adapter: "pairmesh.a2a-demo"
        },
        // Different advertised URL must not replace the live pairwise tunnel.
        a2aAgentUrl: "http://127.0.0.1:59999"
      }
    });
    expect(response.accepted).toBe(true);

    const after = await store.load();
    const kelvin = after?.peers.find((peer) => peer.participant.id === kelvinPeerId);
    expect(kelvin?.connectivity?.mode).toBe("relay");
    expect(kelvin?.connectivity?.relayPresenceId).toBe("join_repair_test");
    expect(kelvin?.a2aAgentUrl).toBe(tunnelUrl);
    expect(kelvin?.outboundBearer).toBeDefined();
  });
});
