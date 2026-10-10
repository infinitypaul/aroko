import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PeerIdSchema } from "@pairmesh/protocol";
import { generateBearerToken } from "../auth/secrets.js";
import { issueInboundCredential } from "../auth/credentials.js";
import { LocalStateStore } from "../state/store.js";
import { SessionManager } from "./manager.js";
import type { LocalSessionState } from "./schemas.js";

async function tempStore(): Promise<{ store: LocalStateStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-presence-bind-"));
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
    joinedAt: string;
    outboundBearer?: string;
    connectivity?: LocalSessionState["peers"][number]["connectivity"];
  }
): LocalSessionState["peers"][number] {
  return {
    participant: {
      id: PeerIdSchema.parse(options.participantId),
      sessionId: state.session.id,
      developerId: options.developerId,
      agentId: options.agentId,
      joinedAt: options.joinedAt
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
    ...(options.connectivity ? { connectivity: options.connectivity } : {})
  };
}

async function listenAgentCard(agentName: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url?.includes("agent-card")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: agentName }));
      return;
    }
    if (req.url === "/health" || req.url?.endsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ready", agent: { name: agentName } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("expected tcp address");
  }
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe("bindRelayPeerTransportForRelayPresence", () => {
  it("self-heals swapped presence/pubkey bindings using agent-card identity", async () => {
    const kelvinCard = await listenAgentCard("payment-service-agent");
    const sarahCard = await listenAgentCard("sarah-identity-service-agent");
    servers.push(kelvinCard.server, sarahCard.server);

    const { store } = await tempStore();
    const manager = new SessionManager({
      stateStore: store,
      skipPeerHealthPreflight: true
    });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:5800" });
    const loaded = await store.load();
    if (!loaded?.sessionSecurity) {
      throw new Error("missing security");
    }

    const kelvinId = PeerIdSchema.parse(id("peer"));
    const sarahId = PeerIdSchema.parse(id("peer"));
    // Simulate the live bug: presence/pubkey/URL all assigned to the wrong peer.
    const kelvin = peerStub(loaded, {
      name: "payment-service-agent",
      participantId: kelvinId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: sarahCard.url,
      joinedAt: "2026-08-28T10:00:00.000Z",
      outboundBearer: generateBearerToken(),
      connectivity: {
        mode: "relay",
        relayPresenceId: "join_conn_sarah_wrongly_on_kelvin",
        peerTransportPublicKey: "aa".repeat(32)
      }
    });
    const sarah = peerStub(loaded, {
      name: "sarah-identity-service-agent",
      participantId: sarahId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: kelvinCard.url,
      joinedAt: "2026-08-28T10:01:00.000Z",
      outboundBearer: generateBearerToken(),
      connectivity: {
        mode: "relay",
        relayPresenceId: "join_conn_kelvin_wrongly_on_sarah",
        peerTransportPublicKey: "bb".repeat(32)
      }
    });

    await store.save({
      ...loaded,
      peers: [kelvin, sarah],
      sessionSecurity: {
        ...loaded.sessionSecurity,
        acceptedInbound: [
          ...loaded.sessionSecurity.acceptedInbound,
          issueInboundCredential(kelvinId).credential,
          issueInboundCredential(sarahId).credential
        ]
      }
    });

    await manager.bindRelayPeerTransportForRelayPresence({
      relayParticipantId: "join_conn_kelvin_live",
      transportPublicKey: "cc".repeat(32),
      localEndpoint: kelvinCard.url
    });
    await manager.bindRelayPeerTransportForRelayPresence({
      relayParticipantId: "join_conn_sarah_live",
      transportPublicKey: "dd".repeat(32),
      localEndpoint: sarahCard.url
    });

    const after = await store.load();
    const kelvinAfter = after?.peers.find((peer) => peer.participant.id === kelvinId);
    const sarahAfter = after?.peers.find((peer) => peer.participant.id === sarahId);

    expect(kelvinAfter?.a2aAgentUrl).toBe(kelvinCard.url);
    expect(kelvinAfter?.connectivity?.relayPresenceId).toBe("join_conn_kelvin_live");
    expect(kelvinAfter?.connectivity?.peerTransportPublicKey).toBe("cc".repeat(32));

    expect(sarahAfter?.a2aAgentUrl).toBe(sarahCard.url);
    expect(sarahAfter?.connectivity?.relayPresenceId).toBe("join_conn_sarah_live");
    expect(sarahAfter?.connectivity?.peerTransportPublicKey).toBe("dd".repeat(32));
  });

  it("does not assign both unbound peers to the most recently joined", async () => {
    const kelvinCard = await listenAgentCard("payment-service-agent");
    const sarahCard = await listenAgentCard("sarah-identity-service-agent");
    servers.push(kelvinCard.server, sarahCard.server);

    const { store } = await tempStore();
    const manager = new SessionManager({
      stateStore: store,
      skipPeerHealthPreflight: true
    });
    await manager.createSession({ name: "paul", agentUrl: "http://127.0.0.1:5801" });
    const loaded = await store.load();
    if (!loaded?.sessionSecurity) {
      throw new Error("missing security");
    }

    const kelvinId = PeerIdSchema.parse(id("peer"));
    const sarahId = PeerIdSchema.parse(id("peer"));
    const kelvin = peerStub(loaded, {
      name: "payment-service-agent",
      participantId: kelvinId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:9",
      joinedAt: "2026-08-28T10:00:00.000Z",
      outboundBearer: generateBearerToken()
    });
    const sarah = peerStub(loaded, {
      name: "sarah-identity-service-agent",
      participantId: sarahId,
      agentId: id("agt"),
      developerId: id("dev"),
      deviceId: id("devc"),
      url: "http://127.0.0.1:9",
      joinedAt: "2026-08-28T10:01:00.000Z",
      outboundBearer: generateBearerToken()
    });

    await store.save({
      ...loaded,
      peers: [kelvin, sarah],
      sessionSecurity: {
        ...loaded.sessionSecurity,
        acceptedInbound: [
          ...loaded.sessionSecurity.acceptedInbound,
          issueInboundCredential(kelvinId).credential,
          issueInboundCredential(sarahId).credential
        ]
      }
    });

    // Without card identity, the old heuristic bound both events to Sarah.
    // With cards, each tunnel binds to the matching agent.
    await Promise.all([
      manager.bindRelayPeerTransportForRelayPresence({
        relayParticipantId: "join_conn_kelvin",
        transportPublicKey: "11".repeat(32),
        localEndpoint: kelvinCard.url
      }),
      manager.bindRelayPeerTransportForRelayPresence({
        relayParticipantId: "join_conn_sarah",
        transportPublicKey: "22".repeat(32),
        localEndpoint: sarahCard.url
      })
    ]);

    const after = await store.load();
    const kelvinAfter = after?.peers.find((peer) => peer.participant.id === kelvinId);
    const sarahAfter = after?.peers.find((peer) => peer.participant.id === sarahId);

    expect(kelvinAfter?.a2aAgentUrl).toBe(kelvinCard.url);
    expect(sarahAfter?.a2aAgentUrl).toBe(sarahCard.url);
    expect(kelvinAfter?.connectivity?.relayPresenceId).toBe("join_conn_kelvin");
    expect(sarahAfter?.connectivity?.relayPresenceId).toBe("join_conn_sarah");
  });
});
