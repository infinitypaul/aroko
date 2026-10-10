import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createRelayAccessToken,
  createRelaySessionId,
  RelayWireFrameSchema,
  type RelayAccessToken,
  type RelaySessionId,
  type RelayWireFrame
} from "./frames.js";
import { relayAccessTokenSetContains } from "./token-compare.js";

export interface MockRelaySession {
  relaySessionId: RelaySessionId;
  /** Primary attach token (also present in accessTokens). */
  relayAccessToken: RelayAccessToken;
}

interface AttachedConnection {
  connectionId: string;
  socket: WebSocket;
  relaySessionId: RelaySessionId;
  /** Opaque PairMesh participant id when announced (presence). */
  participantId?: string;
}

export class MockPairMeshRelay {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<
    RelaySessionId,
    {
      accessTokens: Set<RelayAccessToken>;
      /** @deprecated prefer accessTokens — retained for single-token call sites */
      accessToken: RelayAccessToken;
      connections: Map<string, AttachedConnection>;
      participantConnections: Map<string, string>;
    }
  >();
  private readonly observedFrames: RelayWireFrame[] = [];
  private port = 0;

  constructor() {
    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.http, path: "/relay" });
    this.wss.on("connection", (socket) => this.handleSocket(socket));
  }

  async listen(host = "127.0.0.1", port = 0): Promise<{ host: string; port: number; url: string }> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, host, () => resolve());
    });
    const address = this.http.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind mock relay");
    }
    this.port = address.port;
    return {
      host,
      port: this.port,
      url: `ws://${host}:${this.port}/relay`
    };
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      for (const conn of session.connections.values()) {
        conn.socket.close();
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.http.close((err) => (err ? reject(err) : resolve()));
    });
  }

  createSession(input?: {
    accessToken?: RelayAccessToken;
    relaySessionId?: RelaySessionId;
  }): MockRelaySession {
    const relaySessionId = input?.relaySessionId ?? createRelaySessionId(randomBytes);
    const relayAccessToken = input?.accessToken ?? createRelayAccessToken(randomBytes);
    const existing = this.sessions.get(relaySessionId);
    if (existing) {
      if (!existing || !relayAccessTokenSetContains(existing.accessTokens, relayAccessToken)) {
        throw new Error("relay_session_exists");
      }
      return { relaySessionId, relayAccessToken };
    }
    this.sessions.set(relaySessionId, {
      accessToken: relayAccessToken,
      accessTokens: new Set([relayAccessToken]),
      connections: new Map(),
      participantConnections: new Map()
    });
    return { relaySessionId, relayAccessToken };
  }

    addAccessToken(input: {
    relaySessionId: RelaySessionId;
    authorizingToken: RelayAccessToken;
    newToken: RelayAccessToken;
  }): void {
    const session = this.sessions.get(input.relaySessionId);
    if (!session || !relayAccessTokenSetContains(session.accessTokens, input.authorizingToken)) {
      throw new Error("relay_token_unauthorized");
    }
    session.accessTokens.add(input.newToken);
  }

  /** Test helper: every wire frame the relay observed (ciphertext only expected). */
  getObservedFrames(): readonly RelayWireFrame[] {
    return this.observedFrames;
  }

  getObservedRawText(): string {
    return JSON.stringify(this.observedFrames);
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, role: "pairmesh-mock-relay" }));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private handleSocket(socket: WebSocket): void {
    let attached: AttachedConnection | undefined;

    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        socket.send(JSON.stringify({ version: 1, type: "error", message: "invalid_json" }));
        return;
      }
      const frame = RelayWireFrameSchema.safeParse(parsed);
      if (!frame.success) {
        socket.send(JSON.stringify({ version: 1, type: "error", message: "invalid_frame" }));
        return;
      }
      this.observedFrames.push(frame.data);

      if (frame.data.type === "ping") {
        socket.send(JSON.stringify({ version: 1, type: "pong" }));
        return;
      }

      if (frame.data.type === "attach") {
        const sessionId = frame.data.relaySessionId;
        const token = frame.data.relayAccessToken;
        if (!sessionId || !token) {
          socket.send(JSON.stringify({ version: 1, type: "error", message: "attach_missing" }));
          return;
        }
        const session = this.sessions.get(sessionId);
        if (!session || !relayAccessTokenSetContains(session.accessTokens, token)) {
          socket.send(JSON.stringify({ version: 1, type: "error", message: "attach_denied" }));
          return;
        }
        const connectionId = frame.data.connectionId ?? `conn_${randomUUID()}`;
        attached = {
          connectionId,
          socket,
          relaySessionId: sessionId,
          participantId: frame.data.fromParticipantId
        };
        session.connections.set(connectionId, attached);
        if (frame.data.fromParticipantId) {
          this.claimParticipantPresence(session, frame.data.fromParticipantId, attached);
        }
        socket.send(
          JSON.stringify({
            version: 1,
            type: "attached",
            relaySessionId: sessionId,
            connectionId
          } satisfies RelayWireFrame)
        );
        return;
      }

      if (frame.data.type === "forward") {
        if (!attached) {
          socket.send(JSON.stringify({ version: 1, type: "error", message: "not_attached" }));
          return;
        }
        const session = this.sessions.get(attached.relaySessionId);
        if (!session) {
          socket.send(JSON.stringify({ version: 1, type: "error", message: "session_missing" }));
          return;
        }
        const destinations = resolveUnicastDestinations(session, attached.connectionId, {
          toConnectionId: frame.data.toConnectionId,
          toParticipantId: frame.data.toParticipantId
        });
        if (!destinations.ok) {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "error",
              message: destinations.error
            })
          );
          return;
        }
        for (const peer of destinations.peers) {
          if (peer.socket.readyState === peer.socket.OPEN) {
            peer.socket.send(
              JSON.stringify({
                version: 1,
                type: "forward",
                relaySessionId: attached.relaySessionId,
                connectionId: attached.connectionId,
                ...(frame.data.channelId ? { channelId: frame.data.channelId } : {}),
                ...(frame.data.fromParticipantId
                  ? { fromParticipantId: frame.data.fromParticipantId }
                  : {}),
                sequence: frame.data.sequence,
                ciphertextB64: frame.data.ciphertextB64
              } satisfies RelayWireFrame)
            );
          }
        }
        return;
      }

      if (frame.data.type === "hello") {
        if (!attached) {
          socket.send(JSON.stringify({ version: 1, type: "error", message: "not_attached" }));
          return;
        }
        const session = this.sessions.get(attached.relaySessionId);
        if (!session) return;
        if (frame.data.fromParticipantId) {
          this.claimParticipantPresence(session, frame.data.fromParticipantId, attached);
        }
        const destinations = resolveUnicastDestinations(session, attached.connectionId, {
          toConnectionId: frame.data.toConnectionId,
          toParticipantId: frame.data.toParticipantId
        });
        if (!destinations.ok) {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "error",
              message: destinations.error,
              ...(frame.data.toParticipantId
                ? { toParticipantId: frame.data.toParticipantId }
                : {}),
              ...(frame.data.toConnectionId ? { toConnectionId: frame.data.toConnectionId } : {})
            })
          );
          return;
        }
        let delivered = 0;
        for (const peer of destinations.peers) {
          if (peer.socket.readyState === peer.socket.OPEN) {
            peer.socket.send(
              JSON.stringify({
                version: 1,
                type: "hello",
                relaySessionId: attached.relaySessionId,
                connectionId: attached.connectionId,
                ...(frame.data.channelId ? { channelId: frame.data.channelId } : {}),
                ...(frame.data.fromParticipantId
                  ? { fromParticipantId: frame.data.fromParticipantId }
                  : {}),
                transportPublicKey: frame.data.transportPublicKey,
                ...(frame.data.e2eReady ? { e2eReady: true } : {}),
                ...(typeof frame.data.presenceGeneration === "number"
                  ? { presenceGeneration: frame.data.presenceGeneration }
                  : {}),
                ...(frame.data.routeRefreshRequested ? { routeRefreshRequested: true } : {})
              } satisfies RelayWireFrame)
            );
            delivered += 1;
          } else if (peer.participantId) {
            const mapped = session.participantConnections.get(peer.participantId);
            if (mapped === peer.connectionId) {
              session.participantConnections.delete(peer.participantId);
            }
            session.connections.delete(peer.connectionId);
          }
        }
        if (destinations.peers.length > 0 && delivered === 0) {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "error",
              message: "destination_unavailable",
              ...(frame.data.toParticipantId
                ? { toParticipantId: frame.data.toParticipantId }
                : {}),
              ...(frame.data.toConnectionId ? { toConnectionId: frame.data.toConnectionId } : {})
            })
          );
        }
      }
    });

    socket.on("close", () => {
      if (!attached) return;
      const session = this.sessions.get(attached.relaySessionId);
      session?.connections.delete(attached.connectionId);
      if (attached.participantId && session) {
        const mapped = session.participantConnections.get(attached.participantId);
        if (mapped === attached.connectionId) {
          session.participantConnections.delete(attached.participantId);
        }
      }
    });
  }

  private claimParticipantPresence(
    session: {
      connections: Map<string, AttachedConnection>;
      participantConnections: Map<string, string>;
    },
    participantId: string,
    next: AttachedConnection
  ): void {
    const prevConnId = session.participantConnections.get(participantId);
    if (prevConnId && prevConnId !== next.connectionId) {
      const prev = session.connections.get(prevConnId);
      if (prev) {
        session.connections.delete(prevConnId);
        try {
          prev.socket.close(4000, "presence_replaced");
        } catch {
          /* already closed */
        }
      }
    }
    session.participantConnections.set(participantId, next.connectionId);
    next.participantId = participantId;
  }
}

function resolveUnicastDestinations(
  session: {
    connections: Map<string, AttachedConnection>;
    participantConnections: Map<string, string>;
  },
  fromConnectionId: string,
  dest: { toConnectionId?: string; toParticipantId?: string }
): { ok: true; peers: AttachedConnection[] } | { ok: false; error: string } {
  if (dest.toConnectionId) {
    const peer = session.connections.get(dest.toConnectionId);
    if (!peer || peer.connectionId === fromConnectionId) {
      return { ok: false, error: "destination_not_found" };
    }
    return { ok: true, peers: [peer] };
  }
  if (dest.toParticipantId) {
    const connectionId = session.participantConnections.get(dest.toParticipantId);
    if (!connectionId) {
      return { ok: false, error: "destination_not_found" };
    }
    const peer = session.connections.get(connectionId);
    if (!peer || peer.connectionId === fromConnectionId) {
      return { ok: false, error: "destination_not_found" };
    }
    return { ok: true, peers: [peer] };
  }
    const others = [...session.connections.values()].filter(
    (peer) => peer.connectionId !== fromConnectionId
  );
  if (others.length === 1) {
    return { ok: true, peers: others };
  }
  if (others.length === 0) {
    return { ok: true, peers: [] };
  }
  return { ok: false, error: "destination_required" };
}
