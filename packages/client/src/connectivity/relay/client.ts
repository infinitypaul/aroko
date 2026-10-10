import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { createPairMeshError } from "@pairmesh/protocol";
import type { E2ETransportSession } from "../e2e/session.js";
import {
  RelayWireFrameSchema,
  type RelayAccessToken,
  type RelayChannelId,
  type RelaySessionId,
  type RelayWireFrame
} from "./frames.js";
import { RelayLivenessWatchdog, type RelayLivenessFailureReason } from "./liveness.js";
import {
  RELAY_KEEPALIVE_INTERVAL_MS,
  RELAY_PONG_DEADLINE_MS,
  RELAY_SUSPENSION_GAP_MS
} from "./reconnect-policy.js";
import type { RelayTrafficTracer } from "./traffic-trace.js";
import { getReliabilityTracker } from "../../reliability/tracker.js";

export interface RelayClientOptions {
  relayUrl: string;
  relaySessionId: RelaySessionId;
  relayAccessToken: RelayAccessToken;
    e2e?: E2ETransportSession;
  connectionId?: string;
    fromParticipantId?: string;
  /** App-level ping interval; 0 disables. Default RELAY_KEEPALIVE_INTERVAL_MS. */
  keepaliveIntervalMs?: number;
  /** Max wait for pong after ping. Default RELAY_PONG_DEADLINE_MS. */
  pongDeadlineMs?: number;
  /** Suspension gap override (tests). Default RELAY_SUSPENSION_GAP_MS. */
  suspensionGapMs?: number;
  /** Injected monotonic clock for liveness / suspension tests. */
  nowMs?: () => number;
  /** Injected scheduler for liveness tests (fake clocks). */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface RelaySendDestination {
  toConnectionId?: string;
  toParticipantId?: string;
  channelId?: RelayChannelId | string;
  fromParticipantId?: string;
}

export type RelayClientDisconnectReason = "remote" | "error" | "intentional" | "liveness";

type PlainHandler = (
  plaintext: Uint8Array,
  meta: {
    sequence: number;
    fromConnectionId?: string;
    fromParticipantId?: string;
    channelId?: string;
  }
) => void;

type HelloHandler = (
  transportPublicKey: string,
  meta: {
    fromConnectionId?: string;
    fromParticipantId?: string;
    channelId?: string;
    e2eReady?: boolean;
    presenceGeneration?: number;
    routeRefreshRequested?: boolean;
  }
) => void;

type DisconnectHandler = (reason: RelayClientDisconnectReason) => void;
type LivenessFailureHandler = (reason: RelayLivenessFailureReason) => void;
export type RelayWireError = {
  message: string;
  toParticipantId?: string;
  toConnectionId?: string;
};
type WireErrorHandler = (error: RelayWireError) => void;

export class PairMeshRelayClient {
  private socket: WebSocket | null = null;
  private readonly handlers = new Set<PlainHandler>();
  private readonly helloHandlers = new Set<HelloHandler>();
  private readonly disconnectHandlers = new Set<DisconnectHandler>();
  private readonly livenessHandlers = new Set<LivenessFailureHandler>();
  private readonly wireErrorHandlers = new Set<WireErrorHandler>();
  private connectionId: string;
  private attached = false;
    private e2e: E2ETransportSession | undefined;
    private readonly e2eByChannel = new Map<string, E2ETransportSession>();
  private intentionalClose = false;
  /** Suppress close→disconnect when liveness already drove recovery. */
  private suppressDisconnectEmit = false;
  private liveness: RelayLivenessWatchdog | null = null;
  /** Bumped on each new socket so stale close handlers cannot notify twice incorrectly. */
  private socketGeneration = 0;
  private trafficTracer?: RelayTrafficTracer;

  constructor(private readonly options: RelayClientOptions) {
    this.connectionId = options.connectionId ?? `conn_${randomUUID()}`;
    this.e2e = options.e2e;
  }

  get id(): string {
    return this.connectionId;
  }

  get isAttached(): boolean {
    return this.attached;
  }

    setE2E(session: E2ETransportSession, channelId?: RelayChannelId | string): void {
    if (channelId) {
      this.e2eByChannel.set(channelId, session);
      return;
    }
    this.e2e = session;
  }

  clearE2EChannel(channelId: RelayChannelId | string): void {
    this.e2eByChannel.delete(channelId);
  }

  attachTrafficTracer(tracer: RelayTrafficTracer): void {
    this.trafficTracer = tracer;
  }

  onPlaintext(handler: PlainHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onHello(handler: HelloHandler): () => void {
    this.helloHandlers.add(handler);
    return () => this.helloHandlers.delete(handler);
  }

  /** Post-attach relay `error` frames (e.g. destination_unavailable on directed hello). */
  onWireError(handler: WireErrorHandler): () => void {
    this.wireErrorHandlers.add(handler);
    return () => this.wireErrorHandlers.delete(handler);
  }

  /** Test hook: simulate a post-attach relay error frame (sticky-presence / prune paths). */
  injectWireErrorForTest(error: RelayWireError): void {
    for (const handler of this.wireErrorHandlers) {
      handler(error);
    }
  }

  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  onLivenessFailure(handler: LivenessFailureHandler): () => void {
    this.livenessHandlers.add(handler);
    return () => this.livenessHandlers.delete(handler);
  }

  /** Test hook: drive one liveness interval tick (fake clocks). */
  tickLivenessForTest(): void {
    this.liveness?.tickForTest();
  }

  get hasOutstandingLivenessPingForTest(): boolean {
    return this.liveness?.hasOutstandingPing === true;
  }

  async connect(timeoutMs = 8_000): Promise<void> {
    if (this.socket) {
      return;
    }
    this.intentionalClose = false;
    this.suppressDisconnectEmit = false;
    const generation = ++this.socketGeneration;
    const tracker = getReliabilityTracker();
    this.socket = new WebSocket(this.options.relayUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          createPairMeshError({
            code: "pairmesh.relay_unavailable",
            message: "Timed out connecting to PairMesh relay."
          })
        );
      }, timeoutMs);
      this.socket!.once("open", () => {
        clearTimeout(timer);
        tracker.completeActive("runtime.start_to_relay_socket", {
          outcome: "success",
          phase: "socket_open"
        });
        tracker.begin("relay.socket_to_attached", {
          transport: "relay",
          replacePrior: true
        });
        resolve();
      });
      this.socket!.once("error", (err) => {
        clearTimeout(timer);
        reject(
          createPairMeshError({
            code: "pairmesh.relay_unavailable",
            message: err instanceof Error ? err.message : "Relay connection failed."
          })
        );
      });
    });

    this.socket.on("message", (data) => this.handleMessage(String(data)));
    this.socket.on("close", () => {
      if (generation !== this.socketGeneration) {
        return;
      }
      this.attached = false;
      this.socket = null;
      this.stopKeepalive();
      if (this.suppressDisconnectEmit) {
        this.suppressDisconnectEmit = false;
        return;
      }
      const reason: RelayClientDisconnectReason = this.intentionalClose ? "intentional" : "remote";
      this.emitDisconnect(reason);
    });
    this.socket.on("error", () => {
      /* close follows; avoid double reconnect scheduling */
    });

    await this.attach();
    tracker.completeActive("relay.socket_to_attached", {
      outcome: "success",
      phase: "attached"
    });
    tracker.begin("relay.attached_to_session_ready", {
      transport: "relay",
      replacePrior: true
    });
    this.startKeepalive();
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    this.attached = false;
    this.socketGeneration += 1;
    if (!socket) return;
    if (socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }

  /**
   * Abruptly drop the socket without marking intentional close (tests / fault injection).
   * Emits disconnect synchronously so callers need not wait on the `close` event.
   */
  terminateForTest(): void {
    this.intentionalClose = false;
    this.stopKeepalive();
    const socket = this.socket;
    this.attached = false;
    this.socket = null;
    this.socketGeneration += 1;
    try {
      socket?.terminate();
    } catch {
      /* ignore */
    }
    this.emitDisconnect("remote");
  }

  /**
   * Tear down a half-open socket after liveness failure without a second disconnect emit.
   */
  private terminateAfterLivenessFailure(): void {
    this.suppressDisconnectEmit = true;
    this.stopKeepalive();
    const socket = this.socket;
    this.attached = false;
    this.socket = null;
    this.socketGeneration += 1;
    try {
      socket?.terminate();
    } catch {
      /* ignore */
    }
  }

  announcePublicKey(
    transportPublicKey: string,
    options: {
      e2eReady?: boolean;
      toConnectionId?: string;
      toParticipantId?: string;
      channelId?: RelayChannelId | string;
      fromParticipantId?: string;
      presenceGeneration?: number;
      routeRefreshRequested?: boolean;
    } = {}
  ): void {
    if (!this.socket || !this.attached) {
      throw createPairMeshError({
        code: "pairmesh.relay_connection_lost",
        message: "Relay connection is not attached."
      });
    }
    const fromParticipantId = options.fromParticipantId ?? this.options.fromParticipantId;
    const wire: RelayWireFrame = {
      version: 1,
      type: "hello",
      relaySessionId: this.options.relaySessionId,
      connectionId: this.connectionId,
      transportPublicKey: transportPublicKey.toLowerCase(),
      ...(options.e2eReady ? { e2eReady: true } : {}),
      ...(options.toConnectionId ? { toConnectionId: options.toConnectionId } : {}),
      ...(options.toParticipantId ? { toParticipantId: options.toParticipantId } : {}),
      ...(options.channelId ? { channelId: options.channelId as RelayChannelId } : {}),
      ...(fromParticipantId ? { fromParticipantId } : {}),
      ...(typeof options.presenceGeneration === "number"
        ? { presenceGeneration: options.presenceGeneration }
        : {}),
      ...(options.routeRefreshRequested ? { routeRefreshRequested: true } : {})
    };
    this.socket.send(JSON.stringify(wire));
  }

  waitForPeerPublicKey(
    timeoutMs = 15 * 60_000,
    options: {
      requireE2eReady?: boolean;
      fromConnectionId?: string;
      fromParticipantId?: string;
      channelId?: string;
    } = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(
          createPairMeshError({
            code: "pairmesh.relay_unavailable",
            message: "Timed out waiting for peer transport hello."
          })
        );
      }, timeoutMs);
      const off = this.onHello((key, meta) => {
        if (options.requireE2eReady && !meta.e2eReady) {
          return;
        }
        if (options.fromConnectionId && meta.fromConnectionId !== options.fromConnectionId) {
          return;
        }
        if (options.fromParticipantId && meta.fromParticipantId !== options.fromParticipantId) {
          return;
        }
        if (options.channelId && meta.channelId !== options.channelId) {
          return;
        }
        clearTimeout(timer);
        off();
        resolve(key);
      });
    });
  }

  async sendPlaintext(plaintext: Uint8Array, dest?: RelaySendDestination): Promise<void> {
    if (!this.socket || !this.attached) {
      throw createPairMeshError({
        code: "pairmesh.relay_connection_lost",
        message: "Relay connection is not attached."
      });
    }
    const e2e = this.resolveE2E(dest?.channelId);
    if (!e2e) {
      throw createPairMeshError({
        code: "pairmesh.relay_unavailable",
        message: "E2E transport session not established."
      });
    }
    const fromParticipantId = dest?.fromParticipantId ?? this.options.fromParticipantId;
    const frame = e2e.encrypt(plaintext);
    const wire: RelayWireFrame = {
      version: 1,
      type: "forward",
      relaySessionId: this.options.relaySessionId,
      connectionId: this.connectionId,
      sequence: frame.sequence,
      ciphertextB64: Buffer.from(frame.ciphertext).toString("base64"),
      ...(dest?.toConnectionId ? { toConnectionId: dest.toConnectionId } : {}),
      ...(dest?.toParticipantId ? { toParticipantId: dest.toParticipantId } : {}),
      ...(dest?.channelId ? { channelId: dest.channelId as RelayChannelId } : {}),
      ...(fromParticipantId ? { fromParticipantId } : {})
    };
    const wireJson = JSON.stringify(wire);
    this.trafficTracer?.recordSentForward(wire, wireJson);
    this.socket.send(wireJson);
  }

  private resolveE2E(channelId?: string): E2ETransportSession | undefined {
    if (channelId) {
      return this.e2eByChannel.get(channelId);
    }
    return this.e2e;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    const interval =
      this.options.keepaliveIntervalMs === undefined
        ? RELAY_KEEPALIVE_INTERVAL_MS
        : this.options.keepaliveIntervalMs;
    if (interval <= 0) {
      return;
    }
    this.liveness = new RelayLivenessWatchdog({
      pingIntervalMs: interval,
      pongDeadlineMs: this.options.pongDeadlineMs ?? RELAY_PONG_DEADLINE_MS,
      suspensionGapMs: this.options.suspensionGapMs ?? RELAY_SUSPENSION_GAP_MS,
      nowMs: this.options.nowMs,
      schedule: this.options.schedule,
      clearTimer: this.options.clearTimer,
      sendPing: () => {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.attached) {
          throw new Error("socket_not_open");
        }
        const wire: RelayWireFrame = {
          version: 1,
          type: "ping",
          relaySessionId: this.options.relaySessionId,
          connectionId: this.connectionId
        };
        this.socket.send(JSON.stringify(wire));
      },
      onFailure: (reason) => {
        this.emitLivenessFailure(reason);
        this.terminateAfterLivenessFailure();
      }
    });
    this.liveness.start();
  }

  private stopKeepalive(): void {
    this.liveness?.stop();
    this.liveness = null;
  }

  private emitDisconnect(reason: RelayClientDisconnectReason): void {
    for (const handler of [...this.disconnectHandlers]) {
      try {
        handler(reason);
      } catch {
        /* isolate handlers */
      }
    }
  }

  private emitLivenessFailure(reason: RelayLivenessFailureReason): void {
    for (const handler of [...this.livenessHandlers]) {
      try {
        handler(reason);
      } catch {
        /* isolate handlers */
      }
    }
  }

  private async attach(): Promise<void> {
    const attach: RelayWireFrame = {
      version: 1,
      type: "attach",
      relaySessionId: this.options.relaySessionId,
      relayAccessToken: this.options.relayAccessToken,
      connectionId: this.connectionId,
      ...(this.options.fromParticipantId
        ? { fromParticipantId: this.options.fromParticipantId }
        : {})
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.off("message", onMessage);
        reject(
          createPairMeshError({
            code: "pairmesh.relay_session_not_found",
            message: "Timed out attaching to PairMesh relay session."
          })
        );
      }, 8_000);
      const onMessage = (data: WebSocket.RawData) => {
        const parsed = RelayWireFrameSchema.safeParse(JSON.parse(String(data)));
        if (!parsed.success) return;
        if (parsed.data.type === "attached") {
          clearTimeout(timer);
          this.connectionId = parsed.data.connectionId ?? this.connectionId;
          this.attached = true;
          this.socket?.off("message", onMessage);
          resolve();
        }
        if (parsed.data.type === "error") {
          clearTimeout(timer);
          this.socket?.off("message", onMessage);
          const message = parsed.data.message ?? "Relay attach denied.";
          const authDenied = /attach_denied|denied/i.test(message);
          reject(
            createPairMeshError({
              code: authDenied
                ? "pairmesh.relay_authentication_failed"
                : "pairmesh.relay_session_not_found",
              message
            })
          );
        }
      };
      this.socket!.on("message", onMessage);
      this.socket!.send(JSON.stringify(attach));
    });
  }

  private handleMessage(raw: string): void {
    const parsed = RelayWireFrameSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;

    if (parsed.data.type === "pong" || parsed.data.type === "ping") {
      if (parsed.data.type === "pong") {
        this.liveness?.onPong();
      }
      if (parsed.data.type === "ping" && this.socket?.readyState === WebSocket.OPEN) {
        const pong: RelayWireFrame = {
          version: 1,
          type: "pong",
          relaySessionId: this.options.relaySessionId,
          connectionId: this.connectionId
        };
        this.socket.send(JSON.stringify(pong));
      }
      return;
    }

    if (parsed.data.type === "hello" && parsed.data.transportPublicKey) {
      for (const handler of this.helloHandlers) {
        handler(parsed.data.transportPublicKey, {
          fromConnectionId: parsed.data.connectionId,
          fromParticipantId: parsed.data.fromParticipantId,
          channelId: parsed.data.channelId,
          e2eReady: parsed.data.e2eReady === true,
          ...(typeof parsed.data.presenceGeneration === "number"
            ? { presenceGeneration: parsed.data.presenceGeneration }
            : {}),
          ...(parsed.data.routeRefreshRequested === true ? { routeRefreshRequested: true } : {})
        });
      }
      return;
    }

    if (parsed.data.type === "error") {
      const message = parsed.data.message?.trim() || "relay_error";
      const err: RelayWireError = {
        message,
        ...(parsed.data.toParticipantId ? { toParticipantId: parsed.data.toParticipantId } : {}),
        ...(parsed.data.toConnectionId ? { toConnectionId: parsed.data.toConnectionId } : {})
      };
      for (const handler of this.wireErrorHandlers) {
        handler(err);
      }
      return;
    }

    if (parsed.data.type !== "forward" || !parsed.data.ciphertextB64) {
      return;
    }
    this.trafficTracer?.recordReceivedForward(parsed.data, raw);
    const e2e = this.resolveE2E(parsed.data.channelId);
    if (!e2e) {
      return;
    }
    const ciphertext = Buffer.from(parsed.data.ciphertextB64, "base64");
    let plaintext: Uint8Array;
    try {
      plaintext = e2e.decrypt({
        version: 1,
        sequence: parsed.data.sequence ?? 0,
        ciphertext: new Uint8Array(ciphertext)
      });
    } catch {
      return;
    }
    for (const handler of this.handlers) {
      handler(plaintext, {
        sequence: parsed.data.sequence ?? 0,
        fromConnectionId: parsed.data.connectionId,
        fromParticipantId: parsed.data.fromParticipantId,
        channelId: parsed.data.channelId
      });
    }
  }
}
