import {
  restoreRelayPath,
  startCreatorRelayPath,
  startJoinerRelayPath,
  type ActiveRelayPath,
  type RelayClientLivenessOptions
} from "./relay-bootstrap.js";
import type { PeerRouteHealthState } from "./relay/route-diagnostics.js";
import {
  clearRelayRoute,
  loadRelayRoute,
  saveRelayRoute,
  type RelayRouteState
} from "./relay-route-store.js";
import { NetworkRestoreMonitor } from "./relay/network-restore.js";
import {
  classifyRelayReconnectError,
  isImmediateReconnectTrigger,
  nextReconnectDelayMs,
  RELAY_AUTH_MAX_ATTEMPTS,
  RELAY_AUTH_RETRY_MS,
  RELAY_RECONNECT_STABLE_MS,
  type RelayReconnectTriggerReason
} from "./relay/reconnect-policy.js";
import { RelayTrafficTracer, type RelayTrafficSnapshot } from "./relay/traffic-trace.js";
import { getReliabilityTracker } from "../reliability/tracker.js";
import { newCorrelationId } from "../reliability/types.js";

export type RelayLifecycleState =
  | "idle"
  | "connecting"
  | "connected"
  | "e2e_negotiating"
  | "ready"
  | "reconnecting"
  | "offline"
  | "auth_failed"
  | "stopped";

export interface RelayBridgeStatus {
  mode: "relay";
  role: "creator" | "joiner" | "idle";
  /** @deprecated prefer lifecycle === "ready" */
  connected: boolean;
  /** Local HTTP tunnel toward peer is up (not peer A2A health). */
  peerReady: boolean;
  lifecycle: RelayLifecycleState;
  relaySessionId?: string;
  localEndpoint?: string;
  relayWsUrl?: string;
  restored?: boolean;
  reconnectAttempt?: number;
    lastReconnectReason?: RelayReconnectTriggerReason;
}

export type RelayPathReadyHandler = (localEndpoint: string) => void | Promise<void>;
export type RelayPeerEndpointHandler = (
  event: import("./relay-bootstrap.js").RelayPeerEndpointEvent
) => void | Promise<void>;

export interface RelayBridgeOptions {
  /** Absolute path to `.pairmesh/relay-route.json` (0600). */
  routeFilePath?: string;
  /** Injected clock/delay for tests. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
  /** Injected NIC counter for network-restore tests. */
  countUsableInterfaces?: () => number;
  /** Liveness / clock options forwarded to PairMeshRelayClient. */
  relayClientOptions?: RelayClientLivenessOptions;
}

interface ReconnectContext {
  sessionCode: string;
  localA2aBaseUrl: string;
  relayWsUrl?: string;
}

export class RelayBridge {
  private path: ActiveRelayPath | null = null;
  private readyPromise: Promise<void> | null = null;
  private role: "creator" | "joiner" | "idle" = "idle";
  private restored = false;
  private lifecycle: RelayLifecycleState = "idle";
  private readonly routeFilePath?: string;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly random: () => number;
  private readonly countUsableInterfaces?: () => number;
  private readonly relayClientOptions?: RelayClientLivenessOptions;
  /** Bumped on every stop/start so in-flight restore cannot clobber a newer path. */
  private epoch = 0;
  private autoReconnect = false;
  private reconnectContext: ReconnectContext | null = null;
  private reconnectAttempt = 0;
  private authFailureCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private offDisconnect: (() => void) | null = null;
  private offLiveness: (() => void) | null = null;
  private pathReadyHandler: RelayPathReadyHandler | null = null;
  private peerEndpointHandler: RelayPeerEndpointHandler | null = null;
  private reconnectInFlight = false;
  private lastReconnectReason?: RelayReconnectTriggerReason;
  private networkMonitor: NetworkRestoreMonitor | null = null;
  private readonly trafficTracer = new RelayTrafficTracer();
    private recoveryCorrelationId: string | null = null;
    private transportTeardown: Promise<void> = Promise.resolve();

  constructor(options: RelayBridgeOptions = {}) {
    this.routeFilePath = options.routeFilePath;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.random = options.random ?? Math.random;
    this.countUsableInterfaces = options.countUsableInterfaces;
    this.relayClientOptions = options.relayClientOptions;
  }

  setPathReadyHandler(handler: RelayPathReadyHandler | null): void {
    this.pathReadyHandler = handler;
  }

  setPeerEndpointHandler(handler: RelayPeerEndpointHandler | null): void {
    this.peerEndpointHandler = handler;
  }

  getStatus(): RelayBridgeStatus {
    const ready = this.lifecycle === "ready" && this.path?.connected === true;
    return {
      mode: "relay",
      role: this.role,
      connected: ready && this.path?.client.isAttached === true,
      peerReady: ready,
      lifecycle: this.lifecycle,
      relaySessionId: this.path?.relaySessionId,
      localEndpoint: this.path?.localEndpoint || undefined,
      relayWsUrl: this.path?.relayWsUrl ?? this.reconnectContext?.relayWsUrl,
      restored: this.restored || undefined,
      reconnectAttempt:
        this.lifecycle === "reconnecting" || this.lifecycle === "offline"
          ? this.reconnectAttempt
          : undefined,
      lastReconnectReason: this.lastReconnectReason
    };
  }

  getLocalEndpoint(): string | undefined {
    const endpoint = this.path?.localEndpoint;
    return endpoint && endpoint.length > 0 ? endpoint : undefined;
  }

  /**
   * Creator: authoritative per-joiner route health (verified-route SM).
   * Undefined when not creator / no binding for that presence.
   */
  getPeerRouteHealth(relayParticipantId: string): PeerRouteHealthState | undefined {
    return this.path?.getCreatorPeerRouteHealth?.(relayParticipantId);
  }

    async reconcilePeerTransports(): Promise<void> {
    await this.path?.reconcilePeerTransports?.();
  }

    getAttachCredentials(): {
    relayWsUrl: string;
    relaySessionId: string;
    relayAccessToken: string;
    sessionCode: string;
  } | null {
    if (!this.path) return null;
    return {
      relayWsUrl: this.path.relayWsUrl,
      relaySessionId: this.path.relaySessionId,
      relayAccessToken: this.path.relayAccessToken,
      sessionCode: this.path.sessionCode
    };
  }

  getTrafficTrace(): RelayTrafficSnapshot {
    return this.trafficTracer.snapshot();
  }

  resetTrafficTrace(canaries?: string[]): void {
    this.trafficTracer.reset();
    if (canaries) {
      for (const canary of canaries) {
        this.trafficTracer.registerCanary(canary);
      }
    }
  }

  /** True while transport is mid-recovery (asks should fail fast). */
  isReconnecting(): boolean {
    return (
      this.lifecycle === "reconnecting" ||
      this.lifecycle === "offline" ||
      this.lifecycle === "connecting" ||
      this.lifecycle === "e2e_negotiating"
    );
  }

    requestReconnect(
    reason: RelayReconnectTriggerReason,
    options: { immediate?: boolean } = {}
  ): void {
    if (!this.autoReconnect || !this.reconnectContext) {
      if (this.lifecycle !== "stopped" && this.lifecycle !== "idle") {
        this.lifecycle = "offline";
      }
      return;
    }
    const epoch = this.epoch;
    this.lastReconnectReason = reason;
    this.beginRecoveryMetrics(reason);
    this.teardownPathForReconnect(epoch);

    const immediate = options.immediate === true || isImmediateReconnectTrigger(reason);

    if (this.reconnectInFlight) {
      this.lifecycle = "reconnecting";
      this.ensureNetworkMonitor();
      return;
    }

    this.lifecycle = "reconnecting";
    this.ensureNetworkMonitor();

    if (immediate) {
      if (this.reconnectTimer) {
        this.clearTimer(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectTimer = this.schedule(() => {
        this.reconnectTimer = null;
        void this.runReconnectAttempt(epoch);
      }, 0);
      return;
    }

    this.scheduleReconnect(epoch);
  }

  /** Correlation id for in-flight recovery (peer-ready completion). */
  getRecoveryCorrelationId(): string | null {
    return this.recoveryCorrelationId;
  }

  getLastReconnectReason(): RelayReconnectTriggerReason | undefined {
    return this.lastReconnectReason;
  }

  private beginRecoveryMetrics(reason: RelayReconnectTriggerReason): void {
    const tracker = getReliabilityTracker();
    const correlationId = newCorrelationId("rec");
    this.recoveryCorrelationId = correlationId;
    tracker.begin("recovery.trigger_to_local_ready", {
      correlationId,
      transport: "relay",
      reason,
      replacePrior: true
    });
    tracker.begin("recovery.trigger_to_peer_ready", {
      correlationId,
      transport: "relay",
      reason,
      replacePrior: true
    });
  }

  async startCreator(input: {
    relayWsUrl: string;
    sessionCode: string;
    inviteSecret: string;
    localA2aBaseUrl: string;
  }): Promise<RelayBridgeStatus> {
    await this.stop({ clearPersisted: false, intentional: true });
    this.lifecycle = "connecting";
    this.autoReconnect = true;
    this.reconnectContext = {
      sessionCode: input.sessionCode,
      localA2aBaseUrl: input.localA2aBaseUrl,
      relayWsUrl: input.relayWsUrl
    };
    const epoch = this.epoch;
    const started = await startCreatorRelayPath({
      ...input,
      onPeerEndpoint: this.peerEndpointHandler ?? undefined,
      clientOptions: this.relayClientOptions
    });
    if (epoch !== this.epoch) {
      await started.path.stop();
      throw new Error("Relay creator start superseded");
    }
    this.adoptPath(started.path, {
      role: "creator",
      restored: false,
      ready: started.ready,
      epoch
    });
    await this.persistRoute(input.sessionCode);
    return this.getStatus();
  }

  async awaitCreatorReady(timeoutMs = 120_000): Promise<void> {
    if (!this.readyPromise) {
      throw new Error("Creator relay path not started");
    }
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for relay peer")), timeoutMs);
      })
    ]);
  }

  async startJoiner(input: {
    relayWsUrl: string;
    sessionCode: string;
    inviteSecret: string;
    localA2aBaseUrl: string;
  }): Promise<RelayBridgeStatus> {
    await this.stop({ clearPersisted: false, intentional: true });
    this.lifecycle = "connecting";
    this.autoReconnect = true;
    this.reconnectContext = {
      sessionCode: input.sessionCode,
      localA2aBaseUrl: input.localA2aBaseUrl,
      relayWsUrl: input.relayWsUrl
    };
    const epoch = this.epoch;
    const started = await startJoinerRelayPath({
      relayWsUrlHint: input.relayWsUrl,
      sessionCode: input.sessionCode,
      inviteSecret: input.inviteSecret,
      localA2aBaseUrl: input.localA2aBaseUrl,
      clientOptions: this.relayClientOptions
    });
    if (epoch !== this.epoch) {
      await started.path.stop();
      throw new Error("Relay joiner start superseded");
    }
    this.adoptPath(started.path, {
      role: "joiner",
      restored: false,
      ready: Promise.resolve(),
      epoch
    });
    this.lifecycle = "ready";
    this.armStableReset();
    await this.persistRoute(input.sessionCode);
    await this.notifyPathReady();
    return this.getStatus();
  }

    async restoreIfNeeded(input: {
    sessionCode: string;
    localA2aBaseUrl: string;
    relayWsUrl?: string;
  }): Promise<RelayBridgeStatus | null> {
    if (!this.routeFilePath) {
      return null;
    }
    const route = await loadRelayRoute(this.routeFilePath);
    if (!route) {
      return null;
    }
    if (route.sessionCode.trim().toUpperCase() !== input.sessionCode.trim().toUpperCase()) {
      await clearRelayRoute(this.routeFilePath);
      return null;
    }
    if (
      input.relayWsUrl &&
      normalizeRelayUrl(input.relayWsUrl) !== normalizeRelayUrl(route.relayWsUrl)
    ) {
      return null;
    }

    await this.stop({ clearPersisted: false, intentional: true });
    this.lifecycle = "connecting";
    this.autoReconnect = true;
    this.reconnectContext = {
      sessionCode: route.sessionCode,
      localA2aBaseUrl: input.localA2aBaseUrl,
      relayWsUrl: route.relayWsUrl
    };
    const epoch = this.epoch;
    try {
      const started = await restoreRelayPath(
        {
          relayWsUrl: route.relayWsUrl,
          relaySessionId: route.relaySessionId,
          relayAccessToken: route.relayAccessToken,
          sessionCode: route.sessionCode,
          role: route.role,
          localA2aBaseUrl: input.localA2aBaseUrl,
          ...("relayPresenceId" in route && route.relayPresenceId
            ? { relayPresenceId: route.relayPresenceId }
            : {}),
          ...("presenceGeneration" in route && typeof route.presenceGeneration === "number"
            ? { presenceGeneration: route.presenceGeneration }
            : {}),
          ...(route.version === 3 &&
          route.role === "creator" &&
          Array.isArray(route.authorizedRelayAccessTokens)
            ? { authorizedRelayAccessTokens: route.authorizedRelayAccessTokens }
            : {})
        },
        {
          onPeerEndpoint: this.peerEndpointHandler ?? undefined,
          clientOptions: this.relayClientOptions
        }
      );
      if (epoch !== this.epoch) {
        await started.path.stop();
        return null;
      }
      this.adoptPath(started.path, {
        role: route.role,
        restored: true,
        ready: started.ready,
        epoch
      });
      await this.persistRoute(route.sessionCode);
      return this.getStatus();
    } catch (error) {
      const kind = classifyRelayReconnectError(error);
      if (kind === "auth") {
        this.lifecycle = "auth_failed";
        this.authFailureCount += 1;
        this.autoReconnect = this.authFailureCount < RELAY_AUTH_MAX_ATTEMPTS;
        if (this.autoReconnect) {
          this.scheduleReconnect(this.epoch);
        }
        return this.getStatus();
      }
      this.lifecycle = "offline";
      this.scheduleReconnect(this.epoch);
      return this.getStatus();
    }
  }

  async awaitRestoredReady(timeoutMs = 120_000): Promise<void> {
    if (!this.readyPromise) {
      throw new Error("Restored relay path not started");
    }
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error("Timed out waiting for relay peer after restore")),
          timeoutMs
        );
      })
    ]);
  }

  /**
   * Intentional stop: cancels reconnect loop.
   * `clearPersisted` true on leave; false on runtime stop (route kept for next start).
   */
  async stop(options: { clearPersisted?: boolean; intentional?: boolean } = {}): Promise<void> {
    const intentional = options.intentional !== false;
    if (intentional) {
      this.autoReconnect = false;
      this.clearReconnectTimers();
      this.stopNetworkMonitor();
      this.lifecycle = "stopped";
      const tracker = getReliabilityTracker();
      tracker.completeActive("recovery.trigger_to_local_ready", {
        outcome: "aborted",
        reason: "shutdown"
      });
      tracker.completeActive("recovery.trigger_to_peer_ready", {
        outcome: "aborted",
        reason: "shutdown"
      });
      tracker.completeActive("relay.attached_to_session_ready", {
        outcome: "aborted",
        reason: "shutdown"
      });
      this.recoveryCorrelationId = null;
    }
    this.epoch += 1;
    this.offDisconnect?.();
    this.offDisconnect = null;
    this.offLiveness?.();
    this.offLiveness = null;
    const current = this.path;
    this.path = null;
    this.role = "idle";
    this.readyPromise = null;
    this.restored = false;
    this.reconnectInFlight = false;
    await current?.stop();
    if (options.clearPersisted && this.routeFilePath) {
      await clearRelayRoute(this.routeFilePath);
      this.reconnectContext = null;
      this.autoReconnect = false;
    }
    if (intentional && !options.clearPersisted) {
      this.lifecycle = "stopped";
    } else if (options.clearPersisted) {
      this.lifecycle = "idle";
    }
  }

  /** Test hook: drop current WS unexpectedly (should schedule reconnect). */
  terminateActiveSocketForTest(): void {
    this.path?.client.terminateForTest();
  }

  /** Test hook: drive client liveness tick (requires injected short intervals). */
  tickLivenessForTest(): void {
    this.path?.client.tickLivenessForTest();
  }

  /** Test hook: one network-restore poll. */
  pollNetworkRestoreForTest(): void {
    this.networkMonitor?.pollForTest();
  }

  private adoptPath(
    path: ActiveRelayPath,
    input: {
      role: "creator" | "joiner";
      restored: boolean;
      ready: Promise<void>;
      epoch: number;
    }
  ): void {
    this.offDisconnect?.();
    this.offLiveness?.();
    this.path = path;
    path.client.attachTrafficTracer(this.trafficTracer);
    this.role = input.role;
    this.restored = input.restored;
    this.readyPromise = input.ready;
    this.lifecycle = "e2e_negotiating";
    this.stopNetworkMonitor();

    this.offDisconnect = path.client.onDisconnect((reason) => {
      if (reason === "intentional" || reason === "liveness") {
        return;
      }
      if (input.epoch !== this.epoch) {
        return;
      }
      this.requestReconnect("ws_disconnect");
    });

    this.offLiveness = path.client.onLivenessFailure((reason) => {
      if (input.epoch !== this.epoch) {
        return;
      }
      this.requestReconnect(reason === "suspension_gap" ? "suspension_gap" : "pong_timeout", {
        immediate: true
      });
    });

    if (input.role === "joiner") {
      path.onRouteRefreshRequested = () => {
        if (input.epoch !== this.epoch) {
          return;
        }
        this.requestReconnect("peer_route_refresh", { immediate: true });
      };
    }

    void input.ready
      .then(async () => {
        if (input.epoch !== this.epoch || this.path !== path) {
          getReliabilityTracker().completeActive("relay.attached_to_session_ready", {
            outcome: "aborted",
            reason: "superseded"
          });
          return;
        }
        this.lifecycle = "ready";
        getReliabilityTracker().completeActive("relay.attached_to_session_ready", {
          outcome: "success",
          phase: "session_ready"
        });
        if (this.recoveryCorrelationId) {
          getReliabilityTracker().completeActive("recovery.trigger_to_local_ready", {
            outcome: "success",
            correlationId: this.recoveryCorrelationId,
            reason: this.lastReconnectReason
          });
        }
        this.armStableReset();
        await this.persistRoute(this.reconnectContext?.sessionCode ?? "");
        await this.notifyPathReady();
      })
      .catch(() => {
        if (input.epoch !== this.epoch) {
          return;
        }
        getReliabilityTracker().completeActive("relay.attached_to_session_ready", {
          outcome: "failed",
          reason: "ready_rejected"
        });
        if (this.autoReconnect) {
          this.requestReconnect("explicit", { immediate: false });
        } else {
          this.lifecycle = "offline";
        }
      });
  }

  private teardownPathForReconnect(epoch: number): void {
    if (epoch !== this.epoch) {
      return;
    }
    this.offDisconnect?.();
    this.offDisconnect = null;
    this.offLiveness?.();
    this.offLiveness = null;
    const dying = this.path;
    this.path = null;
    this.readyPromise = null;
    if (dying) {
      this.transportTeardown = this.transportTeardown.then(() =>
        dying.stop().catch(() => {
          /* already torn down */
        })
      );
    }
  }

  private scheduleReconnect(epoch: number): void {
    if (epoch !== this.epoch || !this.autoReconnect) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.lifecycle = "reconnecting";
    this.ensureNetworkMonitor();
    const useAuthBackoff = this.authFailureCount > 0;
    const delay = useAuthBackoff
      ? RELAY_AUTH_RETRY_MS
      : nextReconnectDelayMs(this.reconnectAttempt, { random: this.random });
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      void this.runReconnectAttempt(epoch);
    }, delay);
  }

  private async runReconnectAttempt(epoch: number): Promise<void> {
    await this.transportTeardown;
    if (epoch !== this.epoch || !this.autoReconnect || !this.reconnectContext) {
      return;
    }
    if (this.reconnectInFlight) {
      return;
    }
    if (!this.routeFilePath) {
      this.lifecycle = "offline";
      return;
    }
    const route = await loadRelayRoute(this.routeFilePath);
    if (!route) {
      this.lifecycle = "idle";
      this.autoReconnect = false;
      this.stopNetworkMonitor();
      return;
    }

    this.reconnectInFlight = true;
    this.lifecycle = "reconnecting";
    this.reconnectAttempt += 1;
    try {
      // Bump epoch only for the restore adoption — cancel prior timers without clearing route.
      this.epoch += 1;
      const adoptEpoch = this.epoch;
      this.lifecycle = "connecting";
      const started = await restoreRelayPath(
        {
          relayWsUrl: route.relayWsUrl,
          relaySessionId: route.relaySessionId,
          relayAccessToken: route.relayAccessToken,
          sessionCode: route.sessionCode,
          role: route.role,
          localA2aBaseUrl: this.reconnectContext.localA2aBaseUrl,
          ...("relayPresenceId" in route && route.relayPresenceId
            ? { relayPresenceId: route.relayPresenceId }
            : {}),
          ...("presenceGeneration" in route && typeof route.presenceGeneration === "number"
            ? { presenceGeneration: route.presenceGeneration }
            : {}),
          ...(route.version === 3 &&
          route.role === "creator" &&
          Array.isArray(route.authorizedRelayAccessTokens)
            ? { authorizedRelayAccessTokens: route.authorizedRelayAccessTokens }
            : {})
        },
        {
          onPeerEndpoint: this.peerEndpointHandler ?? undefined,
          clientOptions: this.relayClientOptions
        }
      );
      if (adoptEpoch !== this.epoch) {
        await started.path.stop().catch(() => undefined);
        return;
      }
      this.adoptPath(started.path, {
        role: route.role,
        restored: true,
        ready: started.ready,
        epoch: adoptEpoch
      });
      await this.persistRoute(route.sessionCode);
      this.authFailureCount = 0;
    } catch (error) {
      const kind = classifyRelayReconnectError(error);
      if (kind === "terminal") {
        this.autoReconnect = false;
        this.lifecycle = "stopped";
        this.stopNetworkMonitor();
        return;
      }
      if (kind === "auth") {
        this.authFailureCount += 1;
        this.lifecycle = "auth_failed";
        if (this.authFailureCount >= RELAY_AUTH_MAX_ATTEMPTS) {
          this.autoReconnect = false;
          this.stopNetworkMonitor();
          return;
        }
      } else {
        this.lifecycle = "offline";
      }
      // Clear in-flight before scheduling so the next attempt is not dropped.
      this.reconnectInFlight = false;
      this.scheduleReconnect(this.epoch);
    } finally {
      this.reconnectInFlight = false;
    }
  }

  private ensureNetworkMonitor(): void {
    if (!this.autoReconnect) {
      return;
    }
    if (this.networkMonitor) {
      return;
    }
    try {
      this.networkMonitor = new NetworkRestoreMonitor({
        schedule: this.schedule,
        clearTimer: this.clearTimer,
        countInterfaces: this.countUsableInterfaces,
        onRestore: () => {
          this.requestReconnect("network_restored", { immediate: true });
        }
      });
      this.networkMonitor.start();
    } catch {
      this.networkMonitor = null;
    }
  }

  private stopNetworkMonitor(): void {
    this.networkMonitor?.stop();
    this.networkMonitor = null;
  }

  private armStableReset(): void {
    if (this.stableTimer) {
      this.clearTimer(this.stableTimer);
    }
    this.stableTimer = this.schedule(() => {
      this.stableTimer = null;
      if (this.lifecycle === "ready") {
        this.reconnectAttempt = 0;
        this.lastReconnectReason = undefined;
      }
    }, RELAY_RECONNECT_STABLE_MS);
  }

  private clearReconnectTimers(): void {
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stableTimer) {
      this.clearTimer(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private async notifyPathReady(): Promise<void> {
    if (!this.pathReadyHandler || this.role !== "joiner") {
      return;
    }
    const endpoint = this.getLocalEndpoint();
    if (!endpoint) {
      return;
    }
    try {
      await this.pathReadyHandler(endpoint);
    } catch {
      /* bind failures surface via peer health */
    }
  }

  private async persistRoute(sessionCode: string): Promise<void> {
    if (!this.routeFilePath || !this.path || this.role === "idle" || !sessionCode) {
      return;
    }
    const prior = await loadRelayRoute(this.routeFilePath);
    const priorAuthorized =
      prior &&
      prior.version === 3 &&
      prior.role === "creator" &&
      Array.isArray(prior.authorizedRelayAccessTokens)
        ? prior.authorizedRelayAccessTokens
        : undefined;
    const state: RelayRouteState = {
      version: 3,
      sessionCode,
      role: this.role,
      relayWsUrl: this.path.relayWsUrl,
      relaySessionId: this.path.relaySessionId,
      relayAccessToken: this.path.relayAccessToken,
      ...(this.role === "joiner" && this.path.relayPresenceId
        ? {
            relayPresenceId: this.path.relayPresenceId,
            presenceGeneration: this.path.presenceGeneration ?? 1
          }
        : {}),
      ...(this.role === "creator" && priorAuthorized && priorAuthorized.length > 0
        ? { authorizedRelayAccessTokens: priorAuthorized }
        : {})
    };
    await saveRelayRoute(this.routeFilePath, state);
  }
}

function normalizeRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}
