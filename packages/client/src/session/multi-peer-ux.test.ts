import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InspectionThreadIdSchema, PeerIdSchema } from "@pairmesh/protocol";
import { generateBearerToken } from "../auth/secrets.js";
import { setGrantPolicy } from "../auth/capabilities.js";
import { ControlPlane } from "../control/service.js";
import { LocalStateStore } from "../state/store.js";
import { SessionManager } from "./manager.js";
import type { LocalSessionState } from "./schemas.js";

async function tempStore(): Promise<{ store: LocalStateStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-multi-ux-"));
  const path = join(dir, "state.json");
  return { path, store: new LocalStateStore({ stateFilePath: path }) };
}

function id(prefix: "peer" | "agt" | "dev" | "devc"): string {
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
    serviceLabel?: string;
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
    ...(options.outboundBearer ? { outboundBearer: options.outboundBearer as never } : {}),
    ...(options.serviceLabel ? { serviceLabel: options.serviceLabel } : {})
  };
}

describe("Stage 14 multi-peer UX (client)", () => {
  it("lists invites without secrets and revokes by invitationId", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    const created = await manager.createSession({
      name: "paul",
      agentUrl: "http://127.0.0.1:6201"
    });
    const second = await manager.createSessionInvite();
    expect(created.invite.invitationId).toBeTruthy();
    expect(second.invitationId).toBeTruthy();

    const listed = await manager.listSessionInvites();
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(listed)).not.toMatch(/inviteSecret|secretHash|pmi_/i);
    expect(listed.every((row) => row.invitationId.startsWith("inv_"))).toBe(true);

    await manager.revokeSessionInvite(second.invitationId!);
    const after = await manager.listSessionInvites();
    expect(after.find((row) => row.invitationId === second.invitationId)?.status).toBe("revoked");
  });

  it("keeps follow-up on stored participant id and rejects peer mismatch", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({
      stateStore: store,
      skipPeerHealthPreflight: true
    });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:6211" });
    const state = await store.load();
    if (!state) throw new Error("expected state");

    const kelvinId = id("peer");
    const sarahId = id("peer");
    const kelvin = peerStub(state, {
      name: "kelvin",
      participantId: kelvinId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6212",
      outboundBearer: generateBearerToken()
    });
    const sarah = peerStub(state, {
      name: "sarah",
      participantId: sarahId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6213",
      outboundBearer: generateBearerToken()
    });

    const threadId = InspectionThreadIdSchema.parse(`thr_${randomUUID()}`);
    await store.save({
      ...state,
      peers: [kelvin, sarah],
      inspectionThreads: [
        {
          thread: {
            id: threadId,
            sessionId: state.session.id,
            initiatorPeerId: state.localParticipant.participant.id,
            targetPeerId: kelvinId,
            status: "active",
            createdAt: state.session.createdAt,
            updatedAt: state.session.createdAt
          },
          targetPeerName: "kelvin",
          turns: []
        }
      ]
    });

    await expect(
      manager.followUpInspection(threadId, "retry?", { peerRef: "sarah" })
    ).rejects.toMatchObject({ code: "pairmesh.invalid_metadata" });

    // Matching participant id is accepted (then fails at transport — peer unreachable).
    await expect(
      manager.followUpInspection(threadId, "retry?", { peerRef: kelvinId })
    ).rejects.not.toMatchObject({ code: "pairmesh.invalid_metadata" });
  });

  it("Control listPeers includes relationship fields; grants stay per-peer", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({
      stateStore: store,
      skipPeerHealthPreflight: true
    });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:6221" });
    const state = await store.load();
    if (!state) throw new Error("expected state");

    const kelvinId = id("peer");
    const sarahId = id("peer");
    const kelvin = peerStub(state, {
      name: "kelvin",
      participantId: kelvinId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6222",
      outboundBearer: generateBearerToken(),
      serviceLabel: "payments"
    });
    const sarah = peerStub(state, {
      name: "sarah",
      participantId: sarahId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6223",
      serviceLabel: "identity"
    });
    let next = { ...state, peers: [kelvin, sarah] };
    next = setGrantPolicy(
      next,
      PeerIdSchema.parse(kelvinId),
      "repository.inspect",
      "allow_session"
    );
    next = setGrantPolicy(next, PeerIdSchema.parse(sarahId), "repository.inspect", "deny");
    await store.save(next);

    const plane = new ControlPlane({ sessionManager: manager });
    const peers = await plane.listPeers();
    expect(peers).toHaveLength(2);
    const kelvinView = peers.find((p) => p.participantId === kelvinId);
    const sarahView = peers.find((p) => p.participantId === sarahId);
    expect(kelvinView).toMatchObject({
      displayName: "kelvin",
      service: "payments",
      relationship: "paired"
    });
    expect(sarahView).toMatchObject({
      displayName: "sarah",
      service: "identity",
      relationship: "unpaired"
    });

    const kelvinGrant = kelvinView!.grants.find((g) => g.capabilityId === "repository.inspect");
    const sarahGrant = sarahView!.grants.find((g) => g.capabilityId === "repository.inspect");
    expect(kelvinGrant?.policy).toBe("allow_session");
    expect(sarahGrant?.policy).toBe("deny");

    await manager.setPeerCapability(kelvinId, "repository.source_references", "deny");
    const after = await plane.listPeers();
    const kelvinAfter = after.find((p) => p.participantId === kelvinId)!;
    const sarahAfter = after.find((p) => p.participantId === sarahId)!;
    expect(
      kelvinAfter.grants.find((g) => g.capabilityId === "repository.source_references")?.policy
    ).toBe("deny");
    expect(
      sarahAfter.grants.find((g) => g.capabilityId === "repository.source_references")?.policy
    ).not.toBe("deny");
  });

  it("createSession persists optional local serviceLabel", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    const status = await manager.createSession({
      name: "paul",
      agentUrl: "http://127.0.0.1:6231",
      serviceLabel: "checkout"
    });
    expect(status.localParticipant.serviceLabel).toBe("checkout");
  });
});
