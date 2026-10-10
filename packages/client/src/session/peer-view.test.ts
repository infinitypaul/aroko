import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PeerIdSchema } from "@pairmesh/protocol";
import { generateBearerToken } from "../auth/secrets.js";
import { LocalStateStore } from "../state/store.js";
import { SessionManager, resolvePeerRecord } from "./manager.js";
import {
  formatPeerLabel,
  parseCompoundPeerSelector,
  assertPairedForAsk,
  listSafePeers,
  normalizeServiceLabel,
  resolvePeerTarget,
  toSafePeerView
} from "./peer-view.js";
import type { LocalSessionState } from "./schemas.js";

async function tempStore(): Promise<{ store: LocalStateStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-peer-view-"));
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

describe("Stage 14 peer-view / safe targeting", () => {
  it("lists 3+ safe peers without secrets", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:6101" });
    const state = await store.load();
    if (!state) throw new Error("expected state");

    const peers = [
      peerStub(state, {
        name: "kelvin",
        participantId: id("peer"),
        agentId: id("agt"),
        developerId: id("dev"),
        deviceId: id("devc"),
        url: "http://127.0.0.1:6102",
        outboundBearer: generateBearerToken(),
        serviceLabel: "payments"
      }),
      peerStub(state, {
        name: "sarah",
        participantId: id("peer"),
        agentId: id("agt"),
        developerId: id("dev"),
        deviceId: id("devc"),
        url: "http://127.0.0.1:6103",
        outboundBearer: generateBearerToken(),
        serviceLabel: "identity"
      }),
      peerStub(state, {
        name: "david",
        participantId: id("peer"),
        agentId: id("agt"),
        developerId: id("dev"),
        deviceId: id("devc"),
        url: "http://127.0.0.1:6104",
        serviceLabel: "ledger"
      })
    ];
    await store.save({ ...state, peers });

    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");
    const view = listSafePeers(loaded);
    expect(view).toHaveLength(3);
    expect(view.map((p) => p.service).sort()).toEqual(["identity", "ledger", "payments"]);
    expect(view.find((p) => p.service === "ledger")?.relationship).toBe("unpaired");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(/outboundBearer|inviteSecret|secretHash|Bearer /i);
    expect(serialized).not.toMatch(/\/Users\/|a2aAgentUrl/);

    const viaManager = await manager.listSafePeers({ skipHealthProbe: true });
    expect(viaManager).toHaveLength(3);
  });

  it("resolves unique displayName, participantId, and serviceLabel", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({ stateStore: store });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:6111" });
    const state = await store.load();
    if (!state) throw new Error("expected state");

    const kelvinId = id("peer");
    const sarahId = id("peer");
    const peers = [
      peerStub(state, {
        name: "kelvin",
        participantId: kelvinId,
        agentId: id("agt"),
        developerId: id("dev"),
        deviceId: id("devc"),
        url: "http://127.0.0.1:6112",
        outboundBearer: generateBearerToken(),
        serviceLabel: "payments"
      }),
      peerStub(state, {
        name: "sarah",
        participantId: sarahId,
        agentId: id("agt"),
        developerId: id("dev"),
        deviceId: id("devc"),
        url: "http://127.0.0.1:6113",
        outboundBearer: generateBearerToken(),
        serviceLabel: "identity"
      })
    ];
    await store.save({ ...state, peers });
    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");

    expect(resolvePeerTarget(loaded, "kelvin").resolvedBy).toBe("displayName");
    expect(resolvePeerTarget(loaded, kelvinId).resolvedBy).toBe("participantId");
    expect(resolvePeerTarget(loaded, "payments").resolvedBy).toBe("service");
    expect(resolvePeerRecord(loaded, "identity")?.participant.id).toBe(sarahId);
  });

  it("fails unknown peer and reports peer_ambiguous with safe candidates", async () => {
    const { store } = await tempStore();
    await new SessionManager({ stateStore: store }).createSession({
      name: "paul",
      agentUrl: "http://127.0.0.1:6121"
    });
    const state = await store.load();
    if (!state) throw new Error("expected state");

    const alexA = peerStub(state, {
      name: "Alex",
      participantId: id("peer"),
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6122",
      outboundBearer: generateBearerToken(),
      serviceLabel: "checkout"
    });
    const alexB = peerStub(state, {
      name: "Alex",
      participantId: id("peer"),
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6123",
      outboundBearer: generateBearerToken(),
      serviceLabel: "billing"
    });
    await store.save({ ...state, peers: [alexA, alexB] });
    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");

    expect(() => resolvePeerTarget(loaded, "nobody")).toThrow(
      expect.objectContaining({ code: "pairmesh.peer_not_found" })
    );
    expect(resolvePeerRecord(loaded, "nobody")).toBeUndefined();

    try {
      resolvePeerTarget(loaded, "Alex");
      throw new Error("expected ambiguous");
    } catch (error) {
      expect(error).toMatchObject({ code: "pairmesh.peer_ambiguous" });
      const details = (error as { details: { matches: Array<Record<string, string>> } }).details;
      expect(details.matches).toHaveLength(2);
      expect(JSON.stringify(details)).not.toMatch(/outboundBearer|secret/i);
      expect(details.matches.map((m) => m.service).sort()).toEqual(["billing", "checkout"]);
    }
  });

  it("rejects unpaired ask with authentication_required", async () => {
    const { store } = await tempStore();
    const manager = new SessionManager({
      stateStore: store,
      skipPeerHealthPreflight: true
    });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:6131" });
    const state = await store.load();
    if (!state) throw new Error("expected state");

    const david = peerStub(state, {
      name: "david",
      participantId: id("peer"),
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6132"
    });
    await store.save({ ...state, peers: [david] });
    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");

    expect(() => assertPairedForAsk(loaded, david)).toThrow(
      expect.objectContaining({ code: "pairmesh.authentication_required" })
    );
    await expect(manager.askPeer("david", "what is retry?")).rejects.toMatchObject({
      code: "pairmesh.authentication_required"
    });
  });

  it("resolves DisplayName · service compound selectors", async () => {
    const { store } = await tempStore();
    await new SessionManager({ stateStore: store }).createSession({
      name: "paul",
      agentUrl: "http://127.0.0.1:6151"
    });
    const state = await store.load();
    if (!state) throw new Error("expected state");

    const paymentId = id("peer");
    const billingId = id("peer");
    const peers = [
      peerStub(state, {
        name: "Kelvin",
        participantId: paymentId,
        agentId: id("agt"),
        developerId: id("dev"),
        deviceId: id("devc"),
        url: "http://127.0.0.1:6152",
        outboundBearer: generateBearerToken(),
        serviceLabel: "payment-service"
      }),
      peerStub(state, {
        name: "Kelvin",
        participantId: billingId,
        agentId: id("agt"),
        developerId: id("dev"),
        deviceId: id("devc"),
        url: "http://127.0.0.1:6153",
        outboundBearer: generateBearerToken(),
        serviceLabel: "billing-service"
      })
    ];
    await store.save({ ...state, peers });
    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");

    expect(resolvePeerTarget(loaded, "Kelvin · payment-service").peer.participant.id).toBe(
      paymentId
    );
    expect(resolvePeerTarget(loaded, "Kelvin • billing-service").peer.participant.id).toBe(
      billingId
    );
    expect(() => resolvePeerTarget(loaded, "Kelvin")).toThrow(
      expect.objectContaining({ code: "pairmesh.peer_ambiguous" })
    );
  });

  it("ignores revoked duplicate names when resolving everyday selectors", async () => {
    const { store } = await tempStore();
    await new SessionManager({ stateStore: store }).createSession({
      name: "paul",
      agentUrl: "http://127.0.0.1:6161"
    });
    const state = await store.load();
    if (!state) throw new Error("expected state");

    const liveId = id("peer");
    const ghostId = id("peer");
    const ghost = peerStub(state, {
      name: "payment-service-agent",
      participantId: ghostId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6162"
    });
    const live = peerStub(state, {
      name: "payment-service-agent",
      participantId: liveId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6163",
      outboundBearer: generateBearerToken()
    });
    await store.save({ ...state, peers: [ghost, live] });
    const loaded = await store.load();
    if (!loaded) throw new Error("expected state");

    expect(resolvePeerTarget(loaded, "payment-service-agent").peer.participant.id).toBe(liveId);
  });

  it("normalizes service labels and rejects paths", () => {
    expect(normalizeServiceLabel("payment-service")).toBe("payment-service");
    expect(() => normalizeServiceLabel("/Users/me/repo")).toThrow(
      expect.objectContaining({ code: "pairmesh.invalid_metadata" })
    );
  });

  it("parses compound selectors and formats peer labels", () => {
    expect(parseCompoundPeerSelector("Kelvin · payment-service")).toEqual({
      name: "Kelvin",
      service: "payment-service"
    });
    expect(formatPeerLabel({ displayName: "Kelvin", service: "payment-service" })).toBe(
      "Kelvin · payment-service"
    );
    expect(formatPeerLabel({ displayName: "Kelvin" })).toBe("Kelvin");
  });

  it("toSafePeerView omits secrets", async () => {
    const { store } = await tempStore();
    await new SessionManager({ stateStore: store }).createSession({
      name: "paul",
      agentUrl: "http://127.0.0.1:6141"
    });
    const state = await store.load();
    if (!state) throw new Error("expected state");
    const peer = peerStub(state, {
      name: "kelvin",
      participantId: id("peer"),
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:6142",
      outboundBearer: generateBearerToken(),
      serviceLabel: "payments"
    });
    const view = toSafePeerView({ ...state, peers: [peer] }, peer);
    expect(view).toMatchObject({
      displayName: "kelvin",
      service: "payments",
      relationship: "paired"
    });
    expect(view).not.toHaveProperty("outboundBearer");
  });
});
