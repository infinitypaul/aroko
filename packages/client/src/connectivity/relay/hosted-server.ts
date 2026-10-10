import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createRelaySessionId,
  RelayWireFrameSchema,
  type RelayAccessToken,
  type RelaySessionId,
  type RelayWireFrame
} from "./frames.js";
import {
  RELAY_BACKPRESSURE_HARD_BYTES,
  RELAY_BACKPRESSURE_SOFT_BYTES,
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_MAX_CONNECTIONS,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_SESSION_CONNECTIONS,
  RELAY_MAX_UNATTACHED,
  RELAY_UNATTACHED_TIMEOUT_MS
} from "./access-token.js";
import { createRelayLogGate, type RelayLogFn } from "./log-gate.js";
import { relayAccessTokenSetContains } from "./token-compare.js";

export interface HostedRelaySession {
  relaySessionId: RelaySessionId;
  relayAccessToken: RelayAccessToken;
}

export interface RendezvousRecord {
  sessionCode: string;
  relaySessionId: RelaySessionId;
  /** Public wss/ws base used by joiners (no secrets). */
  relayWsUrl: string;
  /** Creator X25519 transport public key (hex) — public, not secret. */
  creatorTransportPublicKey: string;
  createdAt: string;
  expiresAt: string;
}

export interface HostedRelayOptions {
  /** Advertised WebSocket URL for rendezvous records (e.g. wss://relay.example/). */
  publicWsUrl?: string;
  maxConnections?: number;
  maxFrameBytes?: number;
  idleTimeoutMs?: number;
    maxUnattached?: number;
    unattachedTimeoutMs?: number;
    backpressureSoftBytes?: number;
    backpressureHardBytes?: number;
  /** Rendezvous TTL ms (default 24h). */
  rendezvousTtlMs?: number;
    respondToPing?: boolean;
  /** Minimal structured logger — never log ciphertext bodies or secrets. */
  log?: RelayLogFn;
}

export interface HostedRelayOpsSnapshot {
  ready: boolean;
  uptimeSeconds: number;
  startedAt: string;
  connections: number;
  peakConnections: number;
  totalOpened: number;
  totalClosed: number;
  unattachedConnections: number;
  sessions: number;
  rendezvous: number;
  attachAttempts: number;
  attachSuccesses: number;
  attachFailures: number;
  capacityRejections: number;
  destinationUnavailable: number;
  /** Lifetime count of forward/hello routing misses (stale/nonexistent dest). */
  destinationNotFound: number;
  /** Successful unicast forward deliveries (peer.send completed). */
  framesForwarded: number;
  /** Approximate ciphertext frame bytes accepted for forward (opaque length only). */
  encryptedBytesForwarded: number;
  invalidJson: number;
  invalidFrame: number;
  frameTooLarge: number;
  maxConnections: number;
  maxUnattached: number;
  unattachedTimeoutMs: number;
  backpressureSoftBytes: number;
  backpressureHardBytes: number;
  destinationBackpressureRejects: number;
  slowConsumerDisconnects: number;
  peakDestinationBufferedBytes: number;
  unattachedRejected: number;
  unattachedEvicted: number;
  unattachedTimedOut: number;
  logEligible: number;
  logEmitted: number;
  logSuppressed: number;
}

interface AttachedConnection {
  connectionId: string;
  socket: WebSocket;
  relaySessionId: RelaySessionId;
  lastActiveAt: number;
  /** Opaque PairMesh participant id when announced (presence). */
  participantId?: string;
}

interface OpenSocketState {
  socketId: string;
  openedAt: number;
  lastActiveAt: number;
  attached?: AttachedConnection;
}

export function isRelayWebSocketPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/relay";
}

export class HostedPairMeshRelay {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<
    RelaySessionId,
    {
            accessTokens: Set<RelayAccessToken>;
      /** @deprecated prefer accessTokens — retained for single-token call sites */
      accessToken: RelayAccessToken;
      connections: Map<string, AttachedConnection>;
      /** Opaque participantId → current connectionId (presence). */
      participantConnections: Map<string, string>;
    }
  >();
  private readonly rendezvous = new Map<string, RendezvousRecord>();
  private readonly observedMeta: Array<{ type: string; bytes: number; at: string }> = [];
  private readonly lookupHits = new Map<string, { count: number; windowStart: number }>();
    private readonly openSockets = new Map<WebSocket, OpenSocketState>();
  private peakConnections = 0;
  private totalOpened = 0;
  private totalClosed = 0;
  private capacityRejections = 0;
  private attachAttempts = 0;
  private attachSuccesses = 0;
  private port = 0;
  private listening = false;
  private shuttingDown = false;
  private readonly startedAtMs = Date.now();
  private readonly startedAtIso = new Date().toISOString();
  private attachFailures = 0;
  private destinationUnavailable = 0;
  private destinationNotFound = 0;
  private framesForwarded = 0;
  private encryptedBytesForwarded = 0;
  private invalidJson = 0;
  private invalidFrame = 0;
  private frameTooLarge = 0;
  private destinationBackpressureRejects = 0;
  private slowConsumerDisconnects = 0;
  private peakDestinationBufferedBytes = 0;
  private unattachedRejected = 0;
  private unattachedEvicted = 0;
  private unattachedTimedOut = 0;
  private readonly opts: Required<
    Pick<
      HostedRelayOptions,
      | "maxConnections"
      | "maxFrameBytes"
      | "idleTimeoutMs"
      | "rendezvousTtlMs"
      | "maxUnattached"
      | "unattachedTimeoutMs"
      | "backpressureSoftBytes"
      | "backpressureHardBytes"
    >
  > &
    HostedRelayOptions;
  private idleTimer: NodeJS.Timeout | null = null;
  private logGate: ReturnType<typeof createRelayLogGate>;

  constructor(options: HostedRelayOptions = {}) {
    this.opts = {
      maxConnections: options.maxConnections ?? RELAY_MAX_CONNECTIONS,
      maxFrameBytes: options.maxFrameBytes ?? RELAY_MAX_FRAME_BYTES,
      idleTimeoutMs: options.idleTimeoutMs ?? RELAY_IDLE_TIMEOUT_MS,
      rendezvousTtlMs: options.rendezvousTtlMs ?? 24 * 60 * 60_000,
      maxUnattached: options.maxUnattached ?? RELAY_MAX_UNATTACHED,
      unattachedTimeoutMs: options.unattachedTimeoutMs ?? RELAY_UNATTACHED_TIMEOUT_MS,
      backpressureSoftBytes: options.backpressureSoftBytes ?? RELAY_BACKPRESSURE_SOFT_BYTES,
      backpressureHardBytes: options.backpressureHardBytes ?? RELAY_BACKPRESSURE_HARD_BYTES,
      ...options
    };
    this.logGate = createRelayLogGate(this.opts.log);
    this.http = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.opts.maxFrameBytes
    });
    this.wss.on("connection", (socket) => this.handleSocket(socket));
    this.http.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
        .pathname;
      if (!isRelayWebSocketPath(pathname)) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
  }

  async listen(host = "0.0.0.0", port = 0): Promise<{ host: string; port: number; url: string }> {
    this.shuttingDown = false;
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, host, () => resolve());
    });
    const address = this.http.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind hosted relay");
    }
    this.port = address.port;
    this.listening = true;
    this.idleTimer = setInterval(() => this.reapIdle(), 2_000);
    this.idleTimer.unref?.();
    this.log("process_listen", {
      port: this.port,
      ready: true
    });
    const localWs = `ws://127.0.0.1:${this.port}/`;
    return { host, port: this.port, url: this.opts.publicWsUrl ?? localWs };
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    this.listening = false;
    this.log("process_shutdown", {
      connections: this.openSockets.size,
      sessions: this.sessions.size
    });
    if (this.idleTimer) clearInterval(this.idleTimer);
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

  /** True when accepting PairMesh WebSocket attaches (no external DB dependency). */
  isReady(): boolean {
    return this.listening && !this.shuttingDown;
  }

  getOpsSnapshot(): HostedRelayOpsSnapshot {
    let unattachedConnections = 0;
    for (const state of this.openSockets.values()) {
      if (!state.attached) {
        unattachedConnections += 1;
      }
    }
    return {
      ready: this.isReady(),
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000)),
      startedAt: this.startedAtIso,
      connections: this.openSockets.size,
      peakConnections: this.peakConnections,
      totalOpened: this.totalOpened,
      totalClosed: this.totalClosed,
      unattachedConnections,
      sessions: this.sessions.size,
      rendezvous: this.rendezvous.size,
      attachAttempts: this.attachAttempts,
      attachSuccesses: this.attachSuccesses,
      attachFailures: this.attachFailures,
      capacityRejections: this.capacityRejections,
      destinationUnavailable: this.destinationUnavailable,
      destinationNotFound: this.destinationNotFound,
      framesForwarded: this.framesForwarded,
      encryptedBytesForwarded: this.encryptedBytesForwarded,
      invalidJson: this.invalidJson,
      invalidFrame: this.invalidFrame,
      frameTooLarge: this.frameTooLarge,
      maxConnections: this.opts.maxConnections,
      maxUnattached: this.opts.maxUnattached,
      unattachedTimeoutMs: this.opts.unattachedTimeoutMs,
      backpressureSoftBytes: this.opts.backpressureSoftBytes,
      backpressureHardBytes: this.opts.backpressureHardBytes,
      destinationBackpressureRejects: this.destinationBackpressureRejects,
      slowConsumerDisconnects: this.slowConsumerDisconnects,
      peakDestinationBufferedBytes: this.peakDestinationBufferedBytes,
      unattachedRejected: this.unattachedRejected,
      unattachedEvicted: this.unattachedEvicted,
      unattachedTimedOut: this.unattachedTimedOut,
      ...this.logGate.stats()
    };
  }

  createSession(input: {
    accessToken: RelayAccessToken;
    relaySessionId?: RelaySessionId;
  }): HostedRelaySession {
    const relaySessionId = input.relaySessionId ?? createRelaySessionId(randomBytes);
    const existing = this.sessions.get(relaySessionId);
    if (existing) {
      if (!existing || !relayAccessTokenSetContains(existing.accessTokens, input.accessToken)) {
        throw new Error("relay_session_exists");
      }
      // Idempotent recreate after process restart / duplicate ensure.
      return { relaySessionId, relayAccessToken: input.accessToken };
    }
    this.sessions.set(relaySessionId, {
      accessToken: input.accessToken,
      accessTokens: new Set([input.accessToken]),
      connections: new Map(),
      participantConnections: new Map()
    });
    this.log("session_created", { relaySessionId });
    return { relaySessionId, relayAccessToken: input.accessToken };
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
    this.log("access_token_added", { relaySessionId: input.relaySessionId });
  }

  registerRendezvous(input: {
    sessionCode: string;
    relaySessionId: RelaySessionId;
    relayWsUrl?: string;
    creatorTransportPublicKey: string;
  }): RendezvousRecord {
    const sessionCode = input.sessionCode.trim().toUpperCase();
    if (!this.sessions.has(input.relaySessionId)) {
      throw new Error("Unknown relay session");
    }
    if (!/^[0-9a-f]{64}$/i.test(input.creatorTransportPublicKey)) {
      throw new Error("Invalid transport public key");
    }
    const now = Date.now();
    const record: RendezvousRecord = {
      sessionCode,
      relaySessionId: input.relaySessionId,
      relayWsUrl: input.relayWsUrl ?? this.opts.publicWsUrl ?? `ws://127.0.0.1:${this.port}/`,
      creatorTransportPublicKey: input.creatorTransportPublicKey.toLowerCase(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.opts.rendezvousTtlMs).toISOString()
    };
    this.rendezvous.set(sessionCode, record);
    this.log("rendezvous_registered", { sessionCode });
    return record;
  }

  lookupRendezvous(sessionCode: string): RendezvousRecord | undefined {
    const key = sessionCode.trim().toUpperCase();
    if (!this.allowLookup(key)) {
      return undefined;
    }
    const record = this.rendezvous.get(key);
    if (!record) return undefined;
    if (Date.parse(record.expiresAt) < Date.now()) {
      this.rendezvous.delete(key);
      return undefined;
    }
    return record;
  }

  /** Test helper — metadata only (type + byte size), never ciphertext bodies. */
  getObservedMeta(): readonly { type: string; bytes: number; at: string }[] {
    return this.observedMeta;
  }

  private allowLookup(sessionCode: string): boolean {
    const now = Date.now();
    const hit = this.lookupHits.get(sessionCode) ?? { count: 0, windowStart: now };
    if (now - hit.windowStart > 60_000) {
      hit.count = 0;
      hit.windowStart = now;
    }
    hit.count += 1;
    this.lookupHits.set(sessionCode, hit);
    return hit.count <= 30;
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [socket, state] of this.openSockets) {
      const idleLimit = state.attached
        ? this.opts.idleTimeoutMs
        : this.opts.unattachedTimeoutMs;
      const lastActive = state.attached?.lastActiveAt ?? state.lastActiveAt;
      if (now - lastActive > idleLimit) {
        if (!state.attached) {
          this.unattachedTimedOut += 1;
        }
        this.log("connection_idle_closed", {
          socketId: state.socketId,
          attached: Boolean(state.attached)
        });
        socket.close();
      }
    }
  }

  /** Remove socket from registry; only clears session maps owned by this exact socket. */
  private removeSocket(socket: WebSocket, reason = "close"): void {
    const state = this.openSockets.get(socket);
    if (!state) {
      return;
    }
    this.openSockets.delete(socket);
    this.totalClosed += 1;
    const attached = state.attached;
    if (attached) {
      const session = this.sessions.get(attached.relaySessionId);
      if (session) {
        const mapped = session.connections.get(attached.connectionId);
        if (mapped?.socket === socket) {
          session.connections.delete(attached.connectionId);
        }
        if (attached.participantId) {
          const pid = session.participantConnections.get(attached.participantId);
          if (pid === attached.connectionId && mapped?.socket === socket) {
            session.participantConnections.delete(attached.participantId);
          }
        }
      }
    }
    this.log("connection_closed", { connections: this.openSockets.size, reason });
  }

  private log(event: string, fields?: Record<string, string | number | boolean>): void {
    this.logGate.log(event, fields);
  }

  private countUnattached(): number {
    let n = 0;
    for (const state of this.openSockets.values()) {
      if (!state.attached) n += 1;
    }
    return n;
  }

    private evictOldestUnattached(reason: string): boolean {
    let oldest: { socket: WebSocket; openedAt: number } | null = null;
    for (const [socket, state] of this.openSockets) {
      if (state.attached) continue;
      if (!oldest || state.openedAt < oldest.openedAt) {
        oldest = { socket, openedAt: state.openedAt };
      }
    }
    if (!oldest) return false;
    this.unattachedEvicted += 1;
    this.log("connection_rejected_unattached", {
      action: "evict_oldest",
      reason,
      unattachedEvicted: this.unattachedEvicted
    });
    try {
      oldest.socket.close(4001, "unattached_budget");
    } catch {
      /* ignore */
    }
    // Synchronously free the slot — close event may be deferred.
    this.removeSocket(oldest.socket, "unattached_evict");
    return true;
  }

  private noteBufferedAmount(ba: number): void {
    if (ba > this.peakDestinationBufferedBytes) {
      this.peakDestinationBufferedBytes = ba;
    }
  }

    private applyDestinationBackpressure(
    sender: WebSocket,
    peer: AttachedConnection
  ): "ok" | "rejected" | "disconnected" {
    const ba = peer.socket.bufferedAmount ?? 0;
    this.noteBufferedAmount(ba);
    if (ba >= this.opts.backpressureHardBytes) {
      this.slowConsumerDisconnects += 1;
      this.log("slow_consumer_disconnect", {
        bufferedAmount: ba,
        hardBytes: this.opts.backpressureHardBytes,
        slowConsumerDisconnects: this.slowConsumerDisconnects
      });
      try {
        peer.socket.close(4002, "slow_consumer");
      } catch {
        /* ignore */
      }
      try {
        sender.send(
          JSON.stringify({
            version: 1,
            type: "error",
            message: "destination_backpressure",
            detail: "hard_disconnect"
          })
        );
      } catch {
        /* ignore */
      }
      return "disconnected";
    }
    if (ba >= this.opts.backpressureSoftBytes) {
      this.destinationBackpressureRejects += 1;
      this.log("destination_backpressure", {
        bufferedAmount: ba,
        softBytes: this.opts.backpressureSoftBytes,
        destinationBackpressureRejects: this.destinationBackpressureRejects
      });
      try {
        sender.send(
          JSON.stringify({
            version: 1,
            type: "error",
            message: "destination_backpressure",
            detail: "soft_reject"
          })
        );
      } catch {
        /* ignore */
      }
      return "rejected";
    }
    return "ok";
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ role: "pairmesh-relay", websocket: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      // Process alive — does not imply ready to accept PairMesh sessions.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          role: "pairmesh-relay",
          version: "0.1.0-alpha.2"
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/ready") {
      // Ready = listening and not shutting down. No database invented.
      if (!this.isReady()) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "not_ready",
            role: "pairmesh-relay",
            ready: false
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          role: "pairmesh-relay",
          ready: true
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      // Content-blind operational counters — not client reliability latency.
      const snap = this.getOpsSnapshot();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snap));
      return;
    }

    if (req.method === "PUT" && url.pathname === "/v1/rendezvous") {
      const body = await readJsonBody(req, 8_192);
      const sessionCode = typeof body.sessionCode === "string" ? body.sessionCode : "";
      const relaySessionId = typeof body.relaySessionId === "string" ? body.relaySessionId : "";
      const relayWsUrl = typeof body.relayWsUrl === "string" ? body.relayWsUrl : undefined;
      const creatorTransportPublicKey =
        typeof body.creatorTransportPublicKey === "string" ? body.creatorTransportPublicKey : "";
      try {
        const record = this.registerRendezvous({
          sessionCode,
          relaySessionId: relaySessionId as RelaySessionId,
          relayWsUrl,
          creatorTransportPublicKey
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionCode: record.sessionCode,
            relaySessionId: record.relaySessionId,
            relayWsUrl: record.relayWsUrl,
            creatorTransportPublicKey: record.creatorTransportPublicKey,
            expiresAt: record.expiresAt
          })
        );
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_rendezvous" }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/rendezvous/")) {
      const sessionCode = decodeURIComponent(url.pathname.slice("/v1/rendezvous/".length));
      const record = this.lookupRendezvous(sessionCode);
      if (!record) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          sessionCode: record.sessionCode,
          relaySessionId: record.relaySessionId,
          relayWsUrl: record.relayWsUrl,
          creatorTransportPublicKey: record.creatorTransportPublicKey,
          expiresAt: record.expiresAt
        })
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/sessions") {
      const body = await readJsonBody(req, 4_096);
      const token = typeof body.relayAccessToken === "string" ? body.relayAccessToken : "";
      const requestedId = typeof body.relaySessionId === "string" ? body.relaySessionId : undefined;
      if (!/^rat_[0-9a-f]{48}$/i.test(token)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      if (requestedId && !/^rly_[0-9a-f]{32}$/i.test(requestedId)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_session_id" }));
        return;
      }
      try {
        const created = this.createSession({
          accessToken: token as RelayAccessToken,
          relaySessionId: requestedId as RelaySessionId | undefined
        });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ relaySessionId: created.relaySessionId }));
      } catch {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "session_conflict" }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/sessions/tokens") {
      const body = await readJsonBody(req, 4_096);
      const relaySessionId = typeof body.relaySessionId === "string" ? body.relaySessionId : "";
      const authorizingToken =
        typeof body.authorizingToken === "string" ? body.authorizingToken : "";
      const newToken = typeof body.newToken === "string" ? body.newToken : "";
      if (
        !/^rly_[0-9a-f]{32}$/i.test(relaySessionId) ||
        !/^rat_[0-9a-f]{48}$/i.test(authorizingToken) ||
        !/^rat_[0-9a-f]{48}$/i.test(newToken)
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token_request" }));
        return;
      }
      try {
        this.addAccessToken({
          relaySessionId: relaySessionId as RelaySessionId,
          authorizingToken: authorizingToken as RelayAccessToken,
          newToken: newToken as RelayAccessToken
        });
        res.writeHead(204);
        res.end();
      } catch {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "token_unauthorized" }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handleSocket(socket: WebSocket): void {
    if (this.openSockets.size >= this.opts.maxConnections) {
      // Prefer freeing an unattached slot over rejecting an attached-capacity user.
      if (!this.evictOldestUnattached("capacity_full")) {
        this.capacityRejections += 1;
        socket.close(1013, "capacity");
        this.log("connection_rejected_capacity", {
          capacityRejections: this.capacityRejections
        });
        return;
      }
    }
    while (this.countUnattached() >= this.opts.maxUnattached) {
      if (!this.evictOldestUnattached("unattached_budget")) {
        this.unattachedRejected += 1;
        socket.close(1013, "unattached_capacity");
        this.log("connection_rejected_unattached", {
          action: "reject",
          unattachedRejected: this.unattachedRejected
        });
        return;
      }
    }
    const socketState: OpenSocketState = {
      socketId: randomUUID(),
      openedAt: Date.now(),
      lastActiveAt: Date.now()
    };
    this.openSockets.set(socket, socketState);
    this.totalOpened += 1;
    if (this.openSockets.size > this.peakConnections) {
      this.peakConnections = this.openSockets.size;
    }
    this.log("connection_opened", { connections: this.openSockets.size });

    const attachedRef = (): AttachedConnection | undefined => socketState.attached;

    socket.on("message", (data) => {
      const raw = typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
      socketState.lastActiveAt = Date.now();
      if (Buffer.byteLength(raw) > this.opts.maxFrameBytes) {
        this.frameTooLarge += 1;
        socket.send(JSON.stringify({ version: 1, type: "error", message: "frame_too_large" }));
        socket.close();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.invalidJson += 1;
        socket.send(JSON.stringify({ version: 1, type: "error", message: "invalid_json" }));
        return;
      }
      const frame = RelayWireFrameSchema.safeParse(parsed);
      if (!frame.success) {
        this.invalidFrame += 1;
        socket.send(JSON.stringify({ version: 1, type: "error", message: "invalid_frame" }));
        return;
      }

      this.observedMeta.push({
        type: frame.data.type,
        bytes: Buffer.byteLength(raw),
        at: new Date().toISOString()
      });
      const attached = attachedRef();
      if (attached) {
        attached.lastActiveAt = Date.now();
      }

      if (frame.data.type === "ping") {
        if (this.opts.respondToPing !== false) {
          socket.send(JSON.stringify({ version: 1, type: "pong" }));
        }
        return;
      }

      if (frame.data.type === "attach") {
        this.attachAttempts += 1;
        const sessionId = frame.data.relaySessionId;
        const token = frame.data.relayAccessToken;
        if (!sessionId || !token) {
          socket.send(JSON.stringify({ version: 1, type: "error", message: "attach_missing" }));
          socket.close();
          return;
        }
        const session = this.sessions.get(sessionId);
        if (!session || !relayAccessTokenSetContains(session.accessTokens, token)) {
          this.attachFailures += 1;
          this.log("attach_denied", { attachFailures: this.attachFailures });
          socket.send(JSON.stringify({ version: 1, type: "error", message: "attach_denied" }));
          socket.close();
          return;
        }
        if (session.connections.size >= RELAY_MAX_SESSION_CONNECTIONS) {
          this.attachFailures += 1;
          this.log("attach_session_full", { attachFailures: this.attachFailures });
          socket.send(JSON.stringify({ version: 1, type: "error", message: "session_full" }));
          socket.close();
          return;
        }
        const connectionId = frame.data.connectionId ?? `conn_${randomUUID()}`;
        const attachedConn: AttachedConnection = {
          connectionId,
          socket,
          relaySessionId: sessionId,
          lastActiveAt: Date.now(),
          participantId: frame.data.fromParticipantId
        };
        socketState.attached = attachedConn;
        session.connections.set(connectionId, attachedConn);
        if (frame.data.fromParticipantId) {
          this.claimParticipantPresence(session, frame.data.fromParticipantId, attachedConn);
        }
        this.attachSuccesses += 1;
        this.log("attach_success", {
          relaySessionId: sessionId,
          connections: this.openSockets.size,
          sessions: this.sessions.size
        });
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
          if (destinations.error === "destination_not_found") {
            this.destinationNotFound += 1;
          }
          socket.send(
            JSON.stringify({
              version: 1,
              type: "error",
              message: destinations.error
            })
          );
          return;
        }
        let delivered = 0;
        const cipherBytes =
          typeof frame.data.ciphertextB64 === "string"
            ? Buffer.byteLength(frame.data.ciphertextB64, "utf8")
            : 0;
        for (const peer of destinations.peers) {
          if (peer.socket.readyState === peer.socket.OPEN) {
            const bp = this.applyDestinationBackpressure(socket, peer);
            if (bp !== "ok") {
              continue;
            }
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
            delivered += 1;
            this.framesForwarded += 1;
            this.encryptedBytesForwarded += cipherBytes;
            this.noteBufferedAmount(peer.socket.bufferedAmount ?? 0);
          } else {
            this.pruneStalePeer(session, peer);
          }
        }
        if (destinations.peers.length > 0 && delivered === 0) {
          // Backpressure already notified sender; only emit unavailable if peers were dead.
          const anyOpen = destinations.peers.some((p) => p.socket.readyState === p.socket.OPEN);
          if (!anyOpen) {
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
            this.destinationUnavailable += 1;
            this.log("forward_destination_unavailable", {
              connectionId: attached.connectionId,
              destinationUnavailable: this.destinationUnavailable,
              ...(frame.data.toParticipantId
                ? { toParticipantId: frame.data.toParticipantId }
                : {}),
              ...(frame.data.toConnectionId ? { toConnectionId: frame.data.toConnectionId } : {})
            });
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
          if (destinations.error === "destination_not_found") {
            this.destinationNotFound += 1;
          }
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
          } else {
            this.pruneStalePeer(session, peer);
          }
        }
        if (destinations.peers.length > 0 && delivered === 0) {
          this.destinationUnavailable += 1;
          this.log("forward_destination_unavailable", {
            connectionId: attached.connectionId,
            destinationUnavailable: this.destinationUnavailable,
            kind: "hello",
            ...(frame.data.toParticipantId ? { toParticipantId: frame.data.toParticipantId } : {})
          });
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
      this.removeSocket(socket);
    });
    socket.on("error", () => {
      /* close event follows */
    });
  }

  private pruneStalePeer(
    session: {
      connections: Map<string, AttachedConnection>;
      participantConnections: Map<string, string>;
    },
    peer: AttachedConnection
  ): void {
    const mapped = session.connections.get(peer.connectionId);
    if (mapped?.socket !== peer.socket) {
      return;
    }
    session.connections.delete(peer.connectionId);
    if (peer.participantId) {
      const pid = session.participantConnections.get(peer.participantId);
      if (pid === peer.connectionId) {
        session.participantConnections.delete(peer.participantId);
      }
    }
  }

  /**
   * Presence takeover: a live re-attach/hello with the same participantId must
   * displace any prior connection. Without this, half-open zombies keep the
   * routing map (or stay in session.connections) and directed hellos never
   * reach the new socket — joiners sit forever in e2e_negotiating.
   */
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
        this.log("presence_takeover", {
          participantId,
          connections: this.openSockets.size
        });
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

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("body_too_large");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
