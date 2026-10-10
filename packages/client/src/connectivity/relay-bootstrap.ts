import { randomBytes } from "node:crypto";
import {
  createRelaySessionId,
  type RelayAccessToken,
  type RelaySessionId
} from "./relay/frames.js";
import { deriveRelayAccessToken } from "./relay/access-token.js";
import {
  createRemoteRelaySession,
  lookupRemoteRendezvous,
  registerRemoteRendezvous,
  registerRemoteRelayAccessToken,
  relayWsUrlToHttpBase,
  type RemoteRendezvousRecord
} from "./relay/rendezvous-http.js";
import { PairMeshRelayClient, type RelayClientOptions } from "./relay/client.js";
import { RelayChannelManager } from "./relay/channel-manager.js";
import {
  PEER_ROUTE_NOT_VERIFIED,
  PEER_TRANSPORT_UNAVAILABLE,
  RelayHttpEgress,
  RelayHttpIngress
} from "./relay/http-tunnel.js";
import {
  bumpRouteCounter,
  createPeerRouteCounters,
  emitPeerRouteDiag,
  hashConnectionId,
  isAuthoritativeProbeEpisode,
  isRouteVerifying,
  ROUTE_REFRESH_REQUEST_COOLDOWN_MS,
  ROUTE_SAME_COOLDOWN_MS,
  ROUTE_SAME_FAIL_LIMIT,
  type PeerRouteCounters,
  type PeerRouteHealthState
} from "./relay/route-diagnostics.js";
import {
  decodePublicKey,
  deriveDirectionalKeys,
  encodePublicKey,
  generateTransportKeyPair,
  type TransportKeyPair
} from "./e2e/keys.js";
import { E2ETransportSession } from "./e2e/session.js";

export function relayBootstrapIds(sessionCode: string): {
  sessionId: string;
  creatorParticipantId: string;
  joinerParticipantId: string;
} {
  return {
    sessionId: `relay-bootstrap:${sessionCode.trim().toUpperCase()}`,
    creatorParticipantId: "relay_creator",
    joinerParticipantId: "relay_joiner"
  };
}

export interface RelayPeerEndpointEvent {
  /** Joiner's relay presence id (`join_${connectionId}`). */
  relayParticipantId: string;
  transportPublicKey: string;
  localEndpoint: string;
}

export interface ActiveRelayPath {
  relayWsUrl: string;
  relaySessionId: RelaySessionId;
  relayAccessToken: RelayAccessToken;
  /** Collaboration session code — for invite token registration, not routing. */
  sessionCode: string;
  client: PairMeshRelayClient;
  /** Local loopback URL for outbound A2A (toward the peer role). */
  localEndpoint: string;
  role: "creator" | "joiner";
  connected: boolean;
    relayPresenceId?: string;
  /** Monotonic presence generation for joiner reconciliation. */
  presenceGeneration?: number;
  stop: () => Promise<void>;
    onPeerEndpoint?: (event: RelayPeerEndpointEvent) => void | Promise<void>;
    reconcilePeerTransports?: () => Promise<void>;
  /**
   * Test hook (creator): inspect pairwise HTTP sendDest after sticky-presence retarget.
   */
  getCreatorSendDestForTest?: (
    relayParticipantId: string
  ) => import("./relay/client.js").RelaySendDestination | undefined;
  /** Test hook (creator): half-open route health state per joiner presence. */
  getCreatorRouteHealthForTest?: (relayParticipantId: string) => PeerRouteHealthState | undefined;
  /**
   * Creator production: authoritative route health for a joiner presence id.
   * Doctor / listSafePeers must use this (via RelayBridge) — not façade /health alone.
   */
  getCreatorPeerRouteHealth?: (relayParticipantId: string) => PeerRouteHealthState | undefined;
  /** Test hook (creator): whether first-time verify is still pending for this peer. */
  getCreatorPendingVerifyForTest?: (relayParticipantId: string) => boolean | undefined;
  /** Test hook (creator): inject/replace known joiner connectionId mapping. */
  setJoinerConnectionForTest?: (relayParticipantId: string, connectionId: string) => void;
  /** Client-side half-open route counters (creator). */
  getRouteCountersForTest?: () => PeerRouteCounters;
  /**
   * Test hook (joiner): inspect outbound sendDest toward creator
   * (must pin current creator connectionId after creator reconnect).
   */
  getJoinerSendDestForTest?: () => import("./relay/client.js").RelaySendDestination | undefined;
  /**
   * Joiner: creator directed `routeRefreshRequested` — remint disposable connection
   * via existing reconnect path (wired by RelayBridge).
   */
  onRouteRefreshRequested?: () => void;
}

export interface PersistedRelayRouteCredentials {
  relayWsUrl: string;
  relaySessionId: RelaySessionId;
  relayAccessToken: RelayAccessToken;
  sessionCode: string;
  role: "creator" | "joiner";
  localA2aBaseUrl: string;
    relayPresenceId?: string;
  presenceGeneration?: number;
    authorizedRelayAccessTokens?: RelayAccessToken[];
}

export type RelayClientLivenessOptions = Pick<
  RelayClientOptions,
  "keepaliveIntervalMs" | "pongDeadlineMs" | "suspensionGapMs" | "nowMs" | "schedule" | "clearTimer"
>;

export interface RelayBootstrapExtras {
  onPeerEndpoint?: (event: RelayPeerEndpointEvent) => void | Promise<void>;
  clientOptions?: RelayClientLivenessOptions;
  /** Override transport-probe timeout (tests). Production uses default 8s. */
  transportProbeTimeoutMs?: number;
}

export const RELAY_PRESENCE_KEEPALIVE_MS = 5_000;

export function mintJoinerRelayPresenceId(): string {
  return `join_conn_${randomBytes(16).toString("hex")}`;
}

/**
 * Creator: register rendezvous, attach, wait for joiner hello, enable E2E,
 * ingress for join+inbound, egress toward joiner for asks.
 */
export async function startCreatorRelayPath(input: {
  relayWsUrl: string;
  sessionCode: string;
  inviteSecret: string;
  localA2aBaseUrl: string;
  onPeerEndpoint?: (event: RelayPeerEndpointEvent) => void | Promise<void>;
  clientOptions?: RelayClientLivenessOptions;
  /** Test override for half-open transport probe timeout. */
  transportProbeTimeoutMs?: number;
}): Promise<{
  path: ActiveRelayPath;
  keyPair: TransportKeyPair;
  /** Resolves once joiner hello arrives and E2E + tunnels are live. */
  ready: Promise<void>;
}> {
  const relayHttpBaseUrl = relayWsUrlToHttpBase(input.relayWsUrl);
  const relaySessionId = createRelaySessionId(randomBytes);
  const relayAccessToken = deriveRelayAccessToken({
    inviteSecret: input.inviteSecret,
    sessionCode: input.sessionCode,
    relaySessionId
  });
  await createRemoteRelaySession({
    relayHttpBaseUrl,
    relayAccessToken,
    relaySessionId
  });

  const keyPair = generateTransportKeyPair();
  const pub = encodePublicKey(keyPair.publicKey);
  await registerRemoteRendezvous({
    relayHttpBaseUrl,
    sessionCode: input.sessionCode,
    relaySessionId,
    relayWsUrl: input.relayWsUrl,
    creatorTransportPublicKey: pub
  });

  const ids = relayBootstrapIds(input.sessionCode);
  const client = new PairMeshRelayClient({
    relayUrl: input.relayWsUrl,
    relaySessionId,
    relayAccessToken,
    fromParticipantId: ids.creatorParticipantId,
    ...input.clientOptions
  });
  await client.connect();

  const path = createPathShell({
    relayWsUrl: input.relayWsUrl,
    relaySessionId,
    relayAccessToken,
    sessionCode: input.sessionCode,
    client,
    role: "creator",
    onPeerEndpoint: input.onPeerEndpoint,
    relayPresenceId: ids.creatorParticipantId
  });

  const ready = establishE2EAndTunnels({
    path,
    client,
    keyPair,
    sessionCode: input.sessionCode,
    role: "creator",
    localA2aBaseUrl: input.localA2aBaseUrl,
    relayHttpBaseUrl,
    updateRendezvousOnAnnounce: true,
    onPeerEndpoint: input.onPeerEndpoint,
    transportProbeTimeoutMs: input.transportProbeTimeoutMs
  });

  return { keyPair, ready, path };
}

/**
 * Joiner: lookup SessionCode, connect, hello, wait for creator ready, tunnels.
 */
export async function startJoinerRelayPath(input: {
  relayWsUrlHint?: string;
  relayHttpBaseUrl?: string;
  sessionCode: string;
  inviteSecret: string;
  localA2aBaseUrl: string;
  clientOptions?: RelayClientLivenessOptions;
}): Promise<{
  rendezvous: RemoteRendezvousRecord;
  path: ActiveRelayPath;
  keyPair: TransportKeyPair;
}> {
  const httpBase =
    input.relayHttpBaseUrl ??
    (input.relayWsUrlHint ? relayWsUrlToHttpBase(input.relayWsUrlHint) : undefined);
  if (!httpBase) {
    throw new Error("relayHttpBaseUrl or relayWsUrlHint required");
  }

  const rendezvous = await lookupRemoteRendezvous({
    relayHttpBaseUrl: httpBase,
    sessionCode: input.sessionCode
  });
  if (!rendezvous) {
    throw new Error(
      `Session ${input.sessionCode} was not found on the relay rendezvous. Confirm the creator used relay mode.`
    );
  }

  const relayAccessToken = deriveRelayAccessToken({
    inviteSecret: input.inviteSecret,
    sessionCode: input.sessionCode,
    relaySessionId: rendezvous.relaySessionId
  });

  const keyPair = generateTransportKeyPair();
  const ids = relayBootstrapIds(input.sessionCode);
  // Preliminary E2E from rendezvous public key so creator can finish its wait
  // before the joiner opens tunnels (avoids encrypt-before-peer-ready race).
  const preliminaryE2e = new E2ETransportSession(
    deriveDirectionalKeys({
      localPrivateKey: keyPair.privateKey,
      peerPublicKey: decodePublicKey(rendezvous.creatorTransportPublicKey),
      sessionId: ids.sessionId,
      localParticipantId: ids.joinerParticipantId,
      peerParticipantId: ids.creatorParticipantId
    })
  );

  const connectionId = `conn_${randomBytes(16).toString("hex")}`;
  const relayPresenceId = mintJoinerRelayPresenceId();
  const presenceGeneration = 1;
  const client = new PairMeshRelayClient({
    relayUrl: rendezvous.relayWsUrl,
    relaySessionId: rendezvous.relaySessionId,
    relayAccessToken,
    connectionId,
    fromParticipantId: relayPresenceId,
    e2e: preliminaryE2e,
    ...input.clientOptions
  });
  await client.connect();

  const path = createPathShell({
    relayWsUrl: rendezvous.relayWsUrl,
    relaySessionId: rendezvous.relaySessionId,
    relayAccessToken,
    sessionCode: input.sessionCode,
    client,
    role: "joiner",
    relayPresenceId,
    presenceGeneration
  });

  await establishE2EAndTunnels({
    path,
    client,
    keyPair,
    sessionCode: input.sessionCode,
    role: "joiner",
    localA2aBaseUrl: input.localA2aBaseUrl,
    // Wait for creator's post-E2E re-announce so join traffic is decryptable.
    requirePeerE2eReady: true
  });

  return { rendezvous, keyPair, path };
}

export async function restoreRelayPath(
  input: PersistedRelayRouteCredentials,
  options?: {
    onPeerEndpoint?: (event: RelayPeerEndpointEvent) => void | Promise<void>;
    clientOptions?: RelayClientLivenessOptions;
    /**
     * Test-only: after E2E channel open / early presence hello, await this before
     * starting HTTP ingress. Used to reproduce hello-before-ingress races.
     */
    afterEarlyPresenceAnnounce?: () => Promise<void>;
  }
): Promise<{
  path: ActiveRelayPath;
  keyPair: TransportKeyPair;
  ready: Promise<void>;
}> {
  const keyPair = generateTransportKeyPair();
  const relayHttpBaseUrl = relayWsUrlToHttpBase(input.relayWsUrl);

  // After hosted relay process restart, in-memory sessions are gone. Creator
  // re-creates the same session id + token before attach (idempotent).
  if (input.role === "creator") {
    await createRemoteRelaySession({
      relayHttpBaseUrl,
      relayAccessToken: input.relayAccessToken,
      relaySessionId: input.relaySessionId
    });
    // After wipe, createSession only restores the creator token. Re-add every
    // invite-derived joiner token we previously registered so Sarah/Kelvin can
    // attach without re-pair.
    for (const joinerToken of input.authorizedRelayAccessTokens ?? []) {
      if (joinerToken === input.relayAccessToken) {
        continue;
      }
      try {
        await registerRemoteRelayAccessToken({
          relayHttpBaseUrl,
          relaySessionId: input.relaySessionId,
          authorizingToken: input.relayAccessToken,
          newToken: joinerToken
        });
      } catch {
        /* best-effort; attach will fail closed if registration misses */
      }
    }
    await registerRemoteRendezvous({
      relayHttpBaseUrl,
      sessionCode: input.sessionCode,
      relaySessionId: input.relaySessionId,
      relayWsUrl: input.relayWsUrl,
      creatorTransportPublicKey: encodePublicKey(keyPair.publicKey)
    });
  }

  const ids = relayBootstrapIds(input.sessionCode);
  const joinerPresenceId =
    input.role === "joiner"
      ? input.relayPresenceId?.trim() || mintJoinerRelayPresenceId()
      : undefined;
  const presenceGeneration =
    input.role === "joiner" ? (input.presenceGeneration ?? 0) + 1 : undefined;
  const connectionId =
    input.role === "joiner" ? `conn_${randomBytes(16).toString("hex")}` : undefined;
  const client = new PairMeshRelayClient({
    relayUrl: input.relayWsUrl,
    relaySessionId: input.relaySessionId,
    relayAccessToken: input.relayAccessToken,
    ...(input.role === "creator"
      ? { fromParticipantId: ids.creatorParticipantId }
      : {
          connectionId,
          fromParticipantId: joinerPresenceId
        }),
    ...options?.clientOptions
  });
  await client.connect();

  const path = createPathShell({
    relayWsUrl: input.relayWsUrl,
    relaySessionId: input.relaySessionId,
    relayAccessToken: input.relayAccessToken,
    sessionCode: input.sessionCode,
    client,
    role: input.role,
    onPeerEndpoint: options?.onPeerEndpoint,
    ...(joinerPresenceId ? { relayPresenceId: joinerPresenceId } : {}),
    ...(typeof presenceGeneration === "number" ? { presenceGeneration } : {})
  });
  if (input.role === "creator") {
    path.relayPresenceId = ids.creatorParticipantId;
  }

  const ready = establishE2EAndTunnels({
    path,
    client,
    keyPair,
    sessionCode: input.sessionCode,
    role: input.role,
    localA2aBaseUrl: input.localA2aBaseUrl,
    relayHttpBaseUrl: input.role === "creator" ? relayHttpBaseUrl : undefined,
    updateRendezvousOnAnnounce: input.role === "creator",
    onPeerEndpoint: options?.onPeerEndpoint,
    ...(options?.afterEarlyPresenceAnnounce
      ? { afterEarlyPresenceAnnounce: options.afterEarlyPresenceAnnounce }
      : {})
  });

  return { path, keyPair, ready };
}

function createPathShell(input: {
  relayWsUrl: string;
  relaySessionId: RelaySessionId;
  relayAccessToken: RelayAccessToken;
  sessionCode: string;
  client: PairMeshRelayClient;
  role: "creator" | "joiner";
  onPeerEndpoint?: (event: RelayPeerEndpointEvent) => void | Promise<void>;
  relayPresenceId?: string;
  presenceGeneration?: number;
}): ActiveRelayPath {
  const path: ActiveRelayPath = {
    relayWsUrl: input.relayWsUrl,
    relaySessionId: input.relaySessionId,
    relayAccessToken: input.relayAccessToken,
    sessionCode: input.sessionCode,
    client: input.client,
    localEndpoint: "",
    role: input.role,
    connected: false,
    onPeerEndpoint: input.onPeerEndpoint,
    ...(input.relayPresenceId ? { relayPresenceId: input.relayPresenceId } : {}),
    ...(typeof input.presenceGeneration === "number"
      ? { presenceGeneration: input.presenceGeneration }
      : {}),
    // Safe immediately — establishE2EAndTunnels replaces with fuller cleanup.
    stop: async () => {
      await input.client.close();
      path.connected = false;
    }
  };
  return path;
}

async function establishE2EAndTunnels(input: {
  path: ActiveRelayPath;
  client: PairMeshRelayClient;
  keyPair: TransportKeyPair;
  sessionCode: string;
  role: "creator" | "joiner";
  localA2aBaseUrl: string;
  relayHttpBaseUrl?: string;
  updateRendezvousOnAnnounce?: boolean;
  /** Joiner initial path: wait until creator signals E2E is installed. */
  requirePeerE2eReady?: boolean;
  onPeerEndpoint?: (event: RelayPeerEndpointEvent) => void | Promise<void>;
  transportProbeTimeoutMs?: number;
  /** Test-only: pause after peer channel open, before HTTP ingress start. */
  afterEarlyPresenceAnnounce?: () => Promise<void>;
}): Promise<void> {
  const { path, client, keyPair, sessionCode, role, localA2aBaseUrl } = input;
  const ids = relayBootstrapIds(sessionCode);
  const localPub = encodePublicKey(keyPair.publicKey);
  const localPresenceId =
    path.relayPresenceId ?? (role === "creator" ? ids.creatorParticipantId : `join_${client.id}`);
  path.relayPresenceId = localPresenceId;
  const localPresenceGeneration = role === "joiner" ? (path.presenceGeneration ?? 1) : undefined;
  if (typeof localPresenceGeneration === "number") {
    path.presenceGeneration = localPresenceGeneration;
  }

  const channelManager = new RelayChannelManager(client, {
    relaySessionId: path.relaySessionId,
    sessionId: ids.sessionId,
    localKeyPair: keyPair
  });

  let stopIngress: (() => void) | null = null;
  let egress: RelayHttpEgress | null = null;
  type CreatorPeerBinding = {
    egress: RelayHttpEgress;
    localEndpoint: string;
    transportPublicKey: string;
    channelId: string;
    routeHealth: PeerRouteHealthState;
    /** Consecutive same-connection verification / half-open failures. */
    sameRouteFailures: number;
    /** Last same-route refresh attempt (anti-storm cooldown). */
    lastSameRouteRefreshMs: number;
    /**
     * True from hello_new_connection until a successful creator→joiner transport
     * probe for `verifyConnectionId` (or terminal exhaustion).
     */
    pendingVerify: boolean;
    /** ConnectionId that pendingVerify applies to (ignore stale probe outcomes). */
    verifyConnectionId?: string;
    /** Presence generation associated with verifyConnectionId. */
    verifyGeneration?: number;
  };
  const creatorPeerBindings = new Map<string, CreatorPeerBinding>();
  const knownJoinerParticipantIds = new Set<string>();
  /** transport pubkey → current joiner presence (migrate when presence id changed). */
  const presenceByTransportPub = new Map<string, string>();
  /** presence id → last accepted generation (ignore stale hellos). */
  const lastPresenceGeneration = new Map<string, number>();
  /**
   * Joiner presence → last live relay connectionId from hello `fromConnectionId`.
   * Prefer this for creator→joiner fanout/HTTP when participant presence map is stale
   * (sleep/reconnect sticky offline: destination_unavailable on join_conn_* while joiner
   * can still reach creator).
   */
  const connectionIdByJoinerPresence = new Map<string, string>();
  const routeCounters = createPeerRouteCounters();
  let offRekey: (() => void) | null = null;
  let offWireError: (() => void) | null = null;
  let peerChannelReady = false;
  let presenceKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Joiner: last known creator connectionId for pinned sendDest (route convergence). */
  let creatorConnectionId: string | undefined;

  const notifyPeerEndpoint = input.onPeerEndpoint ?? path.onPeerEndpoint;

  const joinerSendDest = (
    remoteParticipantId: string,
    channelId: string
  ): {
    toParticipantId: string;
    channelId: string;
    fromParticipantId: string;
    toConnectionId?: string;
  } => {
    const toConnectionId = connectionIdByJoinerPresence.get(remoteParticipantId);
    return {
      toParticipantId: remoteParticipantId,
      channelId,
      fromParticipantId: ids.creatorParticipantId,
      ...(toConnectionId ? { toConnectionId } : {})
    };
  };

  const creatorSendDest = (
    channelId: string
  ): {
    toParticipantId: string;
    channelId: string;
    fromParticipantId: string;
    toConnectionId?: string;
  } => ({
    toParticipantId: ids.creatorParticipantId,
    channelId,
    fromParticipantId: localPresenceId,
    ...(creatorConnectionId ? { toConnectionId: creatorConnectionId } : {})
  });

  const markRoute = (
    remoteParticipantId: string,
    next: PeerRouteHealthState,
    event: Parameters<typeof emitPeerRouteDiag>[0]["event"],
    extra?: { reason?: string; durationMs?: number }
  ): void => {
    const binding = creatorPeerBindings.get(remoteParticipantId);
    if (binding) {
      binding.routeHealth = next;
    }
    bumpRouteCounter(routeCounters, event);
    emitPeerRouteDiag({
      event,
      peerPresenceId: remoteParticipantId,
      presenceGeneration: lastPresenceGeneration.get(remoteParticipantId),
      connectionHash: hashConnectionId(connectionIdByJoinerPresence.get(remoteParticipantId)),
      routeState: next,
      ...(extra?.reason ? { reason: extra.reason } : {}),
      ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {})
    });
  };

  const failPendingOnUnavailable = (remoteParticipantId: string): void => {
    const binding = creatorPeerBindings.get(remoteParticipantId);
    binding?.egress.markRouteUnavailable(PEER_TRANSPORT_UNAVAILABLE);
  };

  /**
   * Probe result may mutate binding only when the immutable send-time episode still
   * matches the authoritative current connectionId + generation.
   */
  const probeEpisodeMatchesBinding = (
    remoteParticipantId: string,
    binding: CreatorPeerBinding,
    info: {
      sentConnectionId: string;
      presenceGeneration?: number;
    }
  ): boolean =>
    isAuthoritativeProbeEpisode({
      sentConnectionId: info.sentConnectionId,
      ...(info.presenceGeneration !== undefined
        ? { presenceGeneration: info.presenceGeneration }
        : {}),
      mappedConnectionId: connectionIdByJoinerPresence.get(remoteParticipantId),
      ...(binding.verifyConnectionId ? { verifyConnectionId: binding.verifyConnectionId } : {}),
      ...(binding.verifyGeneration !== undefined
        ? { verifyGeneration: binding.verifyGeneration }
        : {}),
      currentGeneration: lastPresenceGeneration.get(remoteParticipantId)
    });

  /** Per-peer last directed routeRefreshRequested emit (anti-spam). */
  const lastRouteRefreshRequestMs = new Map<string, number>();

  const clearRouteRefreshCooldown = (remoteParticipantId: string): void => {
    lastRouteRefreshRequestMs.delete(remoteParticipantId);
  };

  /**
   * Ask a stuck joiner to remint its disposable connection via directed hello.
   * Assigned after announcePresence is defined (stall handlers run later).
   */
  let requestPeerRouteRefresh: (remoteParticipantId: string, reason: string) => void = () =>
    undefined;

  const openCreatorPeerEgress = async (
    remoteParticipantId: string,
    channelId: string,
    transportPublicKey: string
  ): Promise<void> => {
    const existing = creatorPeerBindings.get(remoteParticipantId);
    // Preserve verification lifecycle across egress recreate (rekey / remint).
    // openCreatorPeerEgress must NEVER claim healthy or clear pendingVerify.
    const preserved = existing
      ? {
          routeHealth: existing.routeHealth,
          pendingVerify: existing.pendingVerify,
          sameRouteFailures: existing.sameRouteFailures,
          lastSameRouteRefreshMs: existing.lastSameRouteRefreshMs,
          verifyConnectionId: existing.verifyConnectionId,
          verifyGeneration: existing.verifyGeneration
        }
      : undefined;
    if (existing) {
      await existing.egress.close();
      creatorPeerBindings.delete(remoteParticipantId);
    }
    const peerEgress = new RelayHttpEgress(client, "joiner", {
      sendDest: joinerSendDest(remoteParticipantId, channelId),
      ...(typeof input.transportProbeTimeoutMs === "number"
        ? { transportProbeTimeoutMs: input.transportProbeTimeoutMs }
        : {}),
      onTransportStall: (info) => {
        const binding = creatorPeerBindings.get(remoteParticipantId);
        const nowMs = Date.now();
        // Once unavailable, wait for fresh hello/connection — do not flap.
        if (binding?.routeHealth === "unavailable") {
          return { kind: "fail" as const };
        }
        if (
          binding &&
          (binding.routeHealth === "awaiting_fresh" || binding.pendingVerify) &&
          nowMs - binding.lastSameRouteRefreshMs < ROUTE_SAME_COOLDOWN_MS
        ) {
          // Cooldown: do not emit another suspect/rebind storm.
          return { kind: "fail" as const };
        }

        markRoute(remoteParticipantId, "suspect", "peer.route.suspect", {
          reason: "transport_probe_timeout",
          durationMs: info.durationMs
        });
        const toConnectionId = connectionIdByJoinerPresence.get(remoteParticipantId);
        const record = channelManager.getChannel(remoteParticipantId);
        if (!toConnectionId || !record) {
          markRoute(remoteParticipantId, "unavailable", "peer.route.unavailable", {
            reason: toConnectionId ? "missing_channel" : "no_replacement_connection",
            durationMs: info.durationMs
          });
          failPendingOnUnavailable(remoteParticipantId);
          return { kind: "fail" as const };
        }
        const priorConn = info.sendDest?.toConnectionId;
        const sameRoute = !priorConn || priorConn === toConnectionId;

        if (sameRoute) {
          if (binding?.pendingVerify) {
            // failed_transient counting happens in onTransportProbeResult (avoid double-count
            // when stall + result both fire on the same timeout).
            return { kind: "fail" as const };
          }
          if (binding) {
            binding.lastSameRouteRefreshMs = nowMs;
            binding.sameRouteFailures += 1;
          }
          markRoute(remoteParticipantId, "awaiting_fresh", "peer.route.refresh_same", {
            reason: "same_connection_refresh",
            durationMs: info.durationMs
          });
          const failures = binding?.sameRouteFailures ?? 1;
          if (failures >= ROUTE_SAME_FAIL_LIMIT) {
            markRoute(remoteParticipantId, "unavailable", "peer.route.unavailable", {
              reason: "same_route_exhausted",
              durationMs: info.durationMs
            });
            failPendingOnUnavailable(remoteParticipantId);
            requestPeerRouteRefresh(remoteParticipantId, "same_route_exhausted");
          } else {
            markRoute(remoteParticipantId, "awaiting_fresh", "peer.route.awaiting_fresh", {
              reason: "awaiting_fresh_route",
              durationMs: info.durationMs
            });
          }
          // Same-route assignment is NOT recovery — do not emit rebind_succeeded / do not retry.
          return { kind: "fail" as const };
        }

        markRoute(remoteParticipantId, "verifying", "peer.route.rebind_started", {
          reason: "newer_connection",
          durationMs: info.durationMs
        });
        const nextDest = joinerSendDest(remoteParticipantId, record.channelId);
        const retargeted = retargetJoinerEgressToConnection(remoteParticipantId);
        if (!retargeted) {
          markRoute(remoteParticipantId, "unavailable", "peer.route.rebind_failed", {
            reason: "retarget_failed",
            durationMs: info.durationMs
          });
          failPendingOnUnavailable(remoteParticipantId);
          return { kind: "fail" as const };
        }
        if (binding) {
          binding.pendingVerify = true;
          binding.verifyConnectionId = toConnectionId;
          binding.verifyGeneration = lastPresenceGeneration.get(remoteParticipantId);
          binding.sameRouteFailures = 0;
        }
        // rebind_succeeded only after verified transport probe (onTransportProbeResult).
        return { kind: "retry" as const, sendDest: nextDest };
      },
      onTransportProbeResult: (info) => {
        const binding = creatorPeerBindings.get(remoteParticipantId);
        if (!binding) return;
        // Immutable send-time fence: A must never verify/degrade B.
        if (!probeEpisodeMatchesBinding(remoteParticipantId, binding, info)) {
          return;
        }
        const mappedConn = connectionIdByJoinerPresence.get(remoteParticipantId);
        if (info.ok) {
          if (binding.pendingVerify) {
            binding.sameRouteFailures = 0;
            binding.pendingVerify = false;
            binding.lastSameRouteRefreshMs = 0;
            binding.verifyConnectionId = mappedConn;
            binding.verifyGeneration = lastPresenceGeneration.get(remoteParticipantId);
            clearRouteRefreshCooldown(remoteParticipantId);
            markRoute(remoteParticipantId, "healthy", "peer.route.rebind_succeeded", {
              reason: "verified_new_route",
              durationMs: info.durationMs
            });
            return;
          }
          // Steady-state health — distinct from first-time verification.
          binding.sameRouteFailures = 0;
          binding.lastSameRouteRefreshMs = 0;
          clearRouteRefreshCooldown(remoteParticipantId);
          if (binding.routeHealth !== "healthy") {
            markRoute(remoteParticipantId, "healthy", "peer.route.healthy", {
              reason: "transport_probe_ok",
              durationMs: info.durationMs
            });
          } else {
            binding.routeHealth = "healthy";
          }
          return;
        }
        if (binding.pendingVerify) {
          // failed_transient: keep pendingVerify for the same connectionId.
          binding.sameRouteFailures += 1;
          binding.lastSameRouteRefreshMs = Date.now();
          markRoute(remoteParticipantId, "verifying", "peer.route.verification_failed", {
            reason: "new_route_probe_failed",
            durationMs: info.durationMs
          });
          if (binding.sameRouteFailures >= ROUTE_SAME_FAIL_LIMIT) {
            binding.pendingVerify = false;
            markRoute(remoteParticipantId, "unavailable", "peer.route.unavailable", {
              reason: "new_route_exhausted",
              durationMs: info.durationMs
            });
            failPendingOnUnavailable(remoteParticipantId);
            requestPeerRouteRefresh(remoteParticipantId, "new_route_exhausted");
          }
          return;
        }
        // Same-route stall handler already transitioned awaiting_fresh/unavailable.
        if (binding.routeHealth === "awaiting_fresh" || binding.routeHealth === "unavailable") {
          return;
        }
        binding.sameRouteFailures += 1;
        binding.lastSameRouteRefreshMs = Date.now();
        if (binding.sameRouteFailures >= ROUTE_SAME_FAIL_LIMIT) {
          markRoute(remoteParticipantId, "unavailable", "peer.route.unavailable", {
            reason: "transport_probe_failed",
            durationMs: info.durationMs
          });
          failPendingOnUnavailable(remoteParticipantId);
          requestPeerRouteRefresh(remoteParticipantId, "transport_probe_failed");
          return;
        }
        markRoute(remoteParticipantId, "awaiting_fresh", "peer.route.awaiting_fresh", {
          reason: "transport_probe_failed",
          durationMs: info.durationMs
        });
      },
      isAppTrafficAllowed: () =>
        creatorPeerBindings.get(remoteParticipantId)?.routeHealth === "healthy",
      getAppTrafficDenyReason: () => {
        const health = creatorPeerBindings.get(remoteParticipantId)?.routeHealth;
        return health === "unavailable" ? PEER_TRANSPORT_UNAVAILABLE : PEER_ROUTE_NOT_VERIFIED;
      },
      getProbePresenceGeneration: () => lastPresenceGeneration.get(remoteParticipantId)
    });
    const localEndpoint = await peerEgress.listen();
    const transportKey = transportPublicKey.toLowerCase();
    const mappedConn = connectionIdByJoinerPresence.get(remoteParticipantId);
    let routeHealth: PeerRouteHealthState;
    let pendingVerify: boolean;
    let sameRouteFailures: number;
    let lastSameRouteRefreshMs: number;
    let verifyConnectionId: string | undefined;
    let verifyGeneration: number | undefined;

    if (preserved?.pendingVerify) {
      routeHealth = isRouteVerifying(preserved.routeHealth) ? preserved.routeHealth : "verifying";
      pendingVerify = true;
      sameRouteFailures = preserved.sameRouteFailures;
      lastSameRouteRefreshMs = preserved.lastSameRouteRefreshMs;
      verifyConnectionId = preserved.verifyConnectionId ?? mappedConn;
      verifyGeneration =
        preserved.verifyGeneration ?? lastPresenceGeneration.get(remoteParticipantId);
    } else if (preserved?.routeHealth === "healthy") {
      routeHealth = "healthy";
      pendingVerify = false;
      sameRouteFailures = preserved.sameRouteFailures;
      lastSameRouteRefreshMs = preserved.lastSameRouteRefreshMs;
      verifyConnectionId = preserved.verifyConnectionId ?? mappedConn;
      verifyGeneration =
        preserved.verifyGeneration ?? lastPresenceGeneration.get(remoteParticipantId);
    } else if (preserved) {
      // suspect / awaiting_fresh / unavailable / discovered — preserve, never upgrade to healthy.
      routeHealth = preserved.routeHealth === "suspect" ? "verifying" : preserved.routeHealth;
      pendingVerify = false;
      sameRouteFailures = preserved.sameRouteFailures;
      lastSameRouteRefreshMs = preserved.lastSameRouteRefreshMs;
      verifyConnectionId = preserved.verifyConnectionId ?? mappedConn;
      verifyGeneration =
        preserved.verifyGeneration ?? lastPresenceGeneration.get(remoteParticipantId);
    } else {
      // First bind: discovered/verifying until transport probe succeeds.
      routeHealth = "verifying";
      pendingVerify = true;
      sameRouteFailures = 0;
      lastSameRouteRefreshMs = 0;
      verifyConnectionId = mappedConn;
      verifyGeneration = lastPresenceGeneration.get(remoteParticipantId);
    }

    creatorPeerBindings.set(remoteParticipantId, {
      egress: peerEgress,
      localEndpoint,
      transportPublicKey: transportKey,
      channelId,
      routeHealth,
      sameRouteFailures,
      lastSameRouteRefreshMs,
      pendingVerify,
      ...(verifyConnectionId ? { verifyConnectionId } : {}),
      ...(verifyGeneration !== undefined ? { verifyGeneration } : {})
    });
    if (!path.localEndpoint) {
      path.localEndpoint = localEndpoint;
    }
    if (notifyPeerEndpoint) {
      await notifyPeerEndpoint({
        relayParticipantId: remoteParticipantId,
        transportPublicKey: transportKey,
        localEndpoint
      });
    }
  };

  const reprojectCreatorBindings = async (): Promise<void> => {
    if (!notifyPeerEndpoint) return;
    for (const [relayParticipantId, binding] of creatorPeerBindings) {
      await notifyPeerEndpoint({
        relayParticipantId,
        transportPublicKey: binding.transportPublicKey,
        localEndpoint: binding.localEndpoint
      });
    }
  };

  path.reconcilePeerTransports = async () => {
    if (role === "joiner") {
      try {
        announcePresence(path.connected);
      } catch {
        /* closed */
      }
      return;
    }
    await reprojectCreatorBindings();
    try {
      announcePresence(true);
    } catch {
      /* closed */
    }
  };

  path.stop = async () => {
    offRekey?.();
    offWireError?.();
    offRekey = null;
    offWireError = null;
    if (presenceKeepaliveTimer) {
      clearInterval(presenceKeepaliveTimer);
      presenceKeepaliveTimer = null;
    }
    stopIngress?.();
    for (const binding of creatorPeerBindings.values()) {
      await binding.egress.close().catch(() => undefined);
    }
    creatorPeerBindings.clear();
    knownJoinerParticipantIds.clear();
    connectionIdByJoinerPresence.clear();
    await egress?.close().catch(() => undefined);
    await client.close();
    path.connected = false;
  };

  const pruneDeadJoinerPresence = (participantId: string): void => {
    if (role !== "creator" || !participantId.startsWith("join_")) {
      return;
    }
    knownJoinerParticipantIds.delete(participantId);
    lastPresenceGeneration.delete(participantId);
    connectionIdByJoinerPresence.delete(participantId);
    for (const [pub, presence] of [...presenceByTransportPub.entries()]) {
      if (presence === participantId) {
        presenceByTransportPub.delete(pub);
      }
    }
    const priorBinding = creatorPeerBindings.get(participantId);
    if (priorBinding) {
      void priorBinding.egress.close().catch(() => undefined);
      creatorPeerBindings.delete(participantId);
    }
  };

  /** Prefer live connectionId routing over stale participant presence map. */
  const retargetJoinerEgressToConnection = (participantId: string): boolean => {
    const toConnectionId = connectionIdByJoinerPresence.get(participantId);
    const binding = creatorPeerBindings.get(participantId);
    if (!toConnectionId || !binding) {
      return false;
    }
    const record = channelManager.getChannel(participantId);
    if (!record) {
      return false;
    }
    binding.egress.updateSendDest(joinerSendDest(participantId, record.channelId));
    return true;
  };

  const rememberJoinerConnection = (
    participantId: string | undefined,
    fromConnectionId: string | undefined
  ): void => {
    if (
      role !== "creator" ||
      !participantId?.startsWith("join_") ||
      !fromConnectionId ||
      fromConnectionId.length < 8
    ) {
      return;
    }
    const priorConn = connectionIdByJoinerPresence.get(participantId);
    connectionIdByJoinerPresence.set(participantId, fromConnectionId);
    const retargeted = retargetJoinerEgressToConnection(participantId);
    const binding = creatorPeerBindings.get(participantId);
    if (!retargeted || !binding) {
      return;
    }
    // Same connection hello is NOT recovery — never mark healthy from assignment alone.
    if (priorConn === fromConnectionId) {
      return;
    }
    // Fresh authenticated connection: discovered → verifying (never healthy).
    binding.sameRouteFailures = 0;
    binding.pendingVerify = true;
    binding.verifyConnectionId = fromConnectionId;
    binding.verifyGeneration = lastPresenceGeneration.get(participantId);
    binding.lastSameRouteRefreshMs = 0;
    clearRouteRefreshCooldown(participantId);
    if (!isRouteVerifying(binding.routeHealth)) {
      markRoute(participantId, "discovered", "peer.route.rebind_started", {
        reason: "hello_new_connection"
      });
    }
    // Arm verification immediately — probes may already be in flight.
    binding.routeHealth = "verifying";
  };

  const rememberCreatorConnection = (fromConnectionId: string | undefined): void => {
    if (role !== "joiner" || !fromConnectionId || fromConnectionId.length < 8) {
      return;
    }
    if (creatorConnectionId === fromConnectionId) {
      return;
    }
    creatorConnectionId = fromConnectionId;
    const record = channelManager.getChannel(ids.creatorParticipantId);
    if (!record || !egress) {
      return;
    }
    egress.updateSendDest(creatorSendDest(record.channelId));
  };

  const openPeerChannel = (remotePublicKey: string, remoteParticipantId: string) => {
    return channelManager.openChannel({
      remoteParticipantId,
      remotePublicKey,
      localParticipantId: localPresenceId,
      localPrivateKey: keyPair.privateKey
    });
  };

  const trackJoinerPresence = (
    participantId: string | undefined,
    transportPublicKey?: string
  ): void => {
    if (role !== "creator" || !participantId?.startsWith("join_")) {
      return;
    }
    if (transportPublicKey) {
      const pub = transportPublicKey.toLowerCase();
      const priorPresence = presenceByTransportPub.get(pub);
      if (priorPresence && priorPresence !== participantId) {
        knownJoinerParticipantIds.delete(priorPresence);
        connectionIdByJoinerPresence.delete(priorPresence);
        const priorBinding = creatorPeerBindings.get(priorPresence);
        if (priorBinding) {
          void priorBinding.egress.close().catch(() => undefined);
          creatorPeerBindings.delete(priorPresence);
        }
        lastPresenceGeneration.delete(priorPresence);
      }
      presenceByTransportPub.set(pub, participantId);
    }
    knownJoinerParticipantIds.add(participantId);
  };

  const acceptPresenceGeneration = (
    participantId: string | undefined,
    generation: number | undefined
  ): boolean => {
    if (!participantId) return true;
    const gen = typeof generation === "number" ? generation : 0;
    const last = lastPresenceGeneration.get(participantId);
    if (last !== undefined && gen < last) {
      return false;
    }
    lastPresenceGeneration.set(participantId, gen);
    return true;
  };

  const announcePresence = (
    e2eReady: boolean,
    directed?: {
      toConnectionId?: string;
      toParticipantId?: string;
      routeRefreshRequested?: boolean;
    }
  ): void => {
    const generationFields =
      typeof localPresenceGeneration === "number"
        ? { presenceGeneration: localPresenceGeneration }
        : {};
    if (role === "joiner") {
      client.announcePublicKey(localPub, {
        e2eReady,
        toParticipantId: ids.creatorParticipantId,
        fromParticipantId: localPresenceId,
        ...generationFields
      });
      return;
    }
    if (directed?.toConnectionId || directed?.toParticipantId) {
      client.announcePublicKey(localPub, {
        e2eReady,
        fromParticipantId: ids.creatorParticipantId,
        ...(directed.toConnectionId ? { toConnectionId: directed.toConnectionId } : {}),
        ...(directed.toParticipantId ? { toParticipantId: directed.toParticipantId } : {}),
        ...(directed.routeRefreshRequested ? { routeRefreshRequested: true } : {})
      });
      return;
    }
        // (`destination_required`). Fan out directed unicasts to every known joiner presence.
    // Prefer last live connectionId — participant presence map can lag after sleep/reconnect.
    if (knownJoinerParticipantIds.size > 0) {
      for (const joinerId of knownJoinerParticipantIds) {
        const toConnectionId = connectionIdByJoinerPresence.get(joinerId);
        client.announcePublicKey(localPub, {
          e2eReady,
          fromParticipantId: ids.creatorParticipantId,
          ...(toConnectionId ? { toConnectionId } : { toParticipantId: joinerId })
        });
      }
      return;
    }
    client.announcePublicKey(localPub, {
      e2eReady,
      fromParticipantId: ids.creatorParticipantId
    });
  };

  requestPeerRouteRefresh = (remoteParticipantId: string, reason: string): void => {
    const now = Date.now();
    const last = lastRouteRefreshRequestMs.get(remoteParticipantId) ?? 0;
    if (now - last < ROUTE_REFRESH_REQUEST_COOLDOWN_MS) {
      return;
    }
    const toConnectionId = connectionIdByJoinerPresence.get(remoteParticipantId);
    if (!toConnectionId) {
      return;
    }
    lastRouteRefreshRequestMs.set(remoteParticipantId, now);
    bumpRouteCounter(routeCounters, "peer.route.refresh_requested");
    const binding = creatorPeerBindings.get(remoteParticipantId);
    emitPeerRouteDiag({
      event: "peer.route.refresh_requested",
      peerPresenceId: remoteParticipantId,
      presenceGeneration: lastPresenceGeneration.get(remoteParticipantId),
      connectionHash: hashConnectionId(toConnectionId),
      routeState: binding?.routeHealth ?? "unavailable",
      reason
    });
    try {
      announcePresence(true, {
        toConnectionId,
        toParticipantId: remoteParticipantId,
        routeRefreshRequested: true
      });
    } catch {
      /* closed */
    }
  };

  let peerRemoteId = role === "joiner" ? ids.creatorParticipantId : ids.joinerParticipantId;
  let peerTransportPub = "";

  const peerPub = await new Promise<string>((resolve, reject) => {
    const announceTimer = setInterval(() => {
      try {
        announcePresence(peerChannelReady);
      } catch {
        /* closed */
      }
    }, 5_000);
    announceTimer.unref?.();

    const timer = setTimeout(() => {
      clearInterval(announceTimer);
      off();
      reject(new Error("Timed out waiting for peer transport hello."));
    }, 15 * 60_000);
    timer.unref?.();

    const off = client.onHello((transportPublicKey, meta) => {
      if (input.requirePeerE2eReady === true && meta.e2eReady !== true) {
        return;
      }
      if (
        role === "joiner" &&
        meta.fromParticipantId !== undefined &&
        meta.fromParticipantId !== ids.creatorParticipantId
      ) {
        return;
      }
      if (!acceptPresenceGeneration(meta.fromParticipantId, meta.presenceGeneration)) {
        return;
      }
      if (role === "creator" && meta.fromParticipantId) {
        peerRemoteId = meta.fromParticipantId;
        trackJoinerPresence(meta.fromParticipantId, transportPublicKey);
        rememberJoinerConnection(meta.fromParticipantId, meta.fromConnectionId);
      }
      if (role === "joiner") {
        // Pin creator connection before egress opens (joiner→creator convergence).
        if (meta.fromConnectionId && meta.fromConnectionId.length >= 8) {
          creatorConnectionId = meta.fromConnectionId;
        }
      }
      clearTimeout(timer);
      clearInterval(announceTimer);
      off();
      peerChannelReady = true;
      resolve(transportPublicKey);
    });

    announcePresence(false);
  });

  const peerChannel = openPeerChannel(peerPub, peerRemoteId);
  peerTransportPub = peerPub.toLowerCase();
    // egress, reconnect tests, and first joiner two-party traffic).
  client.setE2E(peerChannel.e2e);

  if (input.updateRendezvousOnAnnounce && input.relayHttpBaseUrl) {
    try {
      await registerRemoteRendezvous({
        relayHttpBaseUrl: input.relayHttpBaseUrl,
        sessionCode,
        relaySessionId: path.relaySessionId,
        relayWsUrl: path.relayWsUrl,
        creatorTransportPublicKey: localPub
      });
    } catch {
      /* best-effort refresh */
    }
  }

  const peerTransportPubByParticipant = new Map<string, string>();
  if (role === "creator") {
    peerTransportPubByParticipant.set(peerRemoteId, peerTransportPub);
  }

  offRekey = client.onHello((nextPeerPub, meta) => {
    const normalized = nextPeerPub.toLowerCase();
    if (role === "joiner") {
      if (
        meta.fromParticipantId !== undefined &&
        meta.fromParticipantId !== ids.creatorParticipantId
      ) {
        return;
      }
      if (!acceptPresenceGeneration(meta.fromParticipantId, meta.presenceGeneration)) {
        return;
      }
      // Always converge creator connectionId — same transport key after creator reconnect
      // must still pin sendDest to the new socket (Case D bilateral offline).
      rememberCreatorConnection(meta.fromConnectionId);
      if (meta.routeRefreshRequested === true) {
        try {
          path.onRouteRefreshRequested?.();
        } catch {
          /* reconnect path must never throw into hello handler */
        }
      }
      if (normalized === peerTransportPub) {
        return;
      }
      peerTransportPub = normalized;
      try {
        if (channelManager.getChannel(ids.creatorParticipantId)) {
          channelManager.closeChannel(ids.creatorParticipantId);
        }
        const record = openPeerChannel(nextPeerPub, ids.creatorParticipantId);
        client.setE2E(record.e2e);
        // Keep loopback egress, but point sends at the fresh channel + current creator conn.
        egress?.updateSendDest(creatorSendDest(record.channelId));
        announcePresence(path.connected);
      } catch {
        /* closed */
      }
      return;
    }

    if (!meta.fromParticipantId) {
      return;
    }
    if (!acceptPresenceGeneration(meta.fromParticipantId, meta.presenceGeneration)) {
      return;
    }
    trackJoinerPresence(meta.fromParticipantId, normalized);
    rememberJoinerConnection(meta.fromParticipantId, meta.fromConnectionId);
    const directedReply = meta.fromConnectionId
      ? { toConnectionId: meta.fromConnectionId }
      : meta.fromParticipantId
        ? { toParticipantId: meta.fromParticipantId }
        : undefined;
    const prevPub = peerTransportPubByParticipant.get(meta.fromParticipantId);
    if (prevPub === normalized) {
      if (role === "creator" && meta.fromParticipantId) {
        const existingBinding = creatorPeerBindings.get(meta.fromParticipantId);
        if (!existingBinding) {
          try {
            let record = channelManager.getChannel(meta.fromParticipantId);
            if (!record) {
              record = openPeerChannel(normalized, meta.fromParticipantId);
            }
            if (meta.fromParticipantId === peerRemoteId) {
              client.setE2E(record.e2e);
              peerTransportPub = normalized;
            }
            void openCreatorPeerEgress(meta.fromParticipantId, record.channelId, normalized).catch(
              () => {
                /* peer endpoint bind failures surface via health/ask */
              }
            );
          } catch {
            /* closed */
          }
        } else if (notifyPeerEndpoint) {
                    // Re-project the binding so health/asks recover without joiner restart.
          void Promise.resolve(
            notifyPeerEndpoint({
              relayParticipantId: meta.fromParticipantId,
              transportPublicKey: existingBinding.transportPublicKey,
              localEndpoint: existingBinding.localEndpoint
            })
          ).catch(() => {
            /* best-effort */
          });
        }
      }
      // Always directed-reply on joiner keepalive. After creator-only restart the joiner's
      // first hello may be missed; later keepalives hit this same-key path with e2eReady=true
      // and must still receive the creator's current transport key (Sarah stayed offline).
      try {
        announcePresence(true, directedReply);
      } catch {
        /* closed */
      }
      return;
    }
    peerTransportPubByParticipant.set(meta.fromParticipantId, normalized);
    try {
      if (channelManager.getChannel(meta.fromParticipantId)) {
        channelManager.closeChannel(meta.fromParticipantId);
      }
      const record = openPeerChannel(nextPeerPub, meta.fromParticipantId);
      if (meta.fromParticipantId === peerRemoteId) {
        client.setE2E(record.e2e);
        peerTransportPub = normalized;
      }
      if (role === "creator") {
        void openCreatorPeerEgress(meta.fromParticipantId, record.channelId, normalized).catch(
          () => {
            /* peer endpoint bind failures surface via health/ask */
          }
        );
      }
      // Always return creator hello on joiner (re)bind — joiner e2eReady does not mean it
      // already has this creator's current transport key (creator-only restart case).
      announcePresence(true, directedReply);
    } catch {
      /* closed */
    }
  });

    // Without this, knownJoinerParticipantIds keeps dead presence ids forever and
  // session health stays stuck on a hung loopback egress (Paul↔Kelvin split-brain).
  // If we still have a live fromConnectionId from recent joiner hellos, retarget
  // HTTP/keepalive to that connection instead of tearing down egress (Case D sticky
  // offline: participant map stale while joiner→creator still works).
  offWireError = client.onWireError((err) => {
    if (role !== "creator") {
      return;
    }
    if (err.message !== "destination_unavailable" && err.message !== "destination_not_found") {
      return;
    }
    const pid = err.toParticipantId?.trim();
    if (pid) {
      if (err.message === "destination_unavailable" && retargetJoinerEgressToConnection(pid)) {
        // Keep joiner in known set; fanout already prefers connectionId when mapped.
        return;
      }
      pruneDeadJoinerPresence(pid);
      return;
    }
    const deadConn = err.toConnectionId?.trim();
    if (!deadConn) {
      return;
    }
    for (const [presenceId, connId] of [...connectionIdByJoinerPresence.entries()]) {
      if (connId === deadConn) {
        pruneDeadJoinerPresence(presenceId);
      }
    }
  });

  // Early presence hello (announcePresence(false) above) already advertised this
  // connectionId. Ingress/tunnel registration happens only after this point — so
  // peers can discover the new route before HTTP is actually ready.
  if (input.afterEarlyPresenceAnnounce) {
    await input.afterEarlyPresenceAnnounce();
  }

  stopIngress = new RelayHttpIngress(client, localA2aBaseUrl, role).start();

  if (role === "joiner") {
    egress = new RelayHttpEgress(client, "creator", {
      sendDest: creatorSendDest(peerChannel.channelId)
    });
    path.localEndpoint = await egress.listen();
  } else {
    await openCreatorPeerEgress(peerRemoteId, peerChannel.channelId, peerTransportPub);
  }

  path.connected = true;
  announcePresence(true);

  if (role === "creator") {
    path.getCreatorSendDestForTest = (relayParticipantId: string) =>
      creatorPeerBindings.get(relayParticipantId)?.egress.getSendDestForTest();
    const readRouteHealth = (relayParticipantId: string) =>
      creatorPeerBindings.get(relayParticipantId)?.routeHealth;
    path.getCreatorRouteHealthForTest = readRouteHealth;
    path.getCreatorPeerRouteHealth = readRouteHealth;
    path.getCreatorPendingVerifyForTest = (relayParticipantId: string) =>
      creatorPeerBindings.get(relayParticipantId)?.pendingVerify;
    path.setJoinerConnectionForTest = (relayParticipantId: string, connectionId: string) => {
      rememberJoinerConnection(relayParticipantId, connectionId);
    };
    path.getRouteCountersForTest = () => ({ ...routeCounters });
  } else {
    path.getJoinerSendDestForTest = () => egress?.getSendDestForTest();
  }

    presenceKeepaliveTimer = setInterval(() => {
    try {
      announcePresence(path.connected);
    } catch {
      /* closed */
    }
  }, RELAY_PRESENCE_KEEPALIVE_MS);
  presenceKeepaliveTimer.unref?.();

  if (role === "joiner") {
    await warmupJoinerTunnel(path.localEndpoint);
  }
}

async function warmupJoinerTunnel(localEndpoint: string): Promise<void> {
  const url = `${localEndpoint.replace(/\/$/, "")}/.well-known/agent-card.json`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 100));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Relay tunnel to creator is not ready (${detail}). Check connectivity.relayUrl and that the creator is still running.`
  );
}

/** @deprecated use startCreatorRelayPath */
export const startCreatorRelayIngress = startCreatorRelayPath;
/** @deprecated use startJoinerRelayPath */
export const startJoinerRelayEgress = startJoinerRelayPath;
