
import { createHash } from "node:crypto";

export type PeerRouteDiagEvent =
  | "peer.route.suspect"
  | "peer.route.rebind_started"
  | "peer.route.rebind_succeeded"
  | "peer.route.rebind_failed"
  | "peer.route.refresh_same"
  | "peer.route.awaiting_fresh"
  | "peer.route.verification_failed"
  | "peer.route.unavailable"
  | "peer.route.refresh_requested"
  | "peer.route.healthy";

/**
 * Creator→joiner route lifecycle (single authority on CreatorPeerBinding):
 *   unbound (no binding) → discovered → verifying → healthy (verified)
 * Transient probe misses while verifying stay verifying (failed_transient).
 * Exhaustion → unavailable (failed_terminal) + refresh_requested.
 * Post-verify half-open uses suspect → awaiting_fresh → unavailable.
 * Presence hello alone never means healthy/verified.
 */
export type PeerRouteHealthState =
  "discovered" | "verifying" | "healthy" | "suspect" | "awaiting_fresh" | "unavailable";

export interface PeerRouteDiagFields {
  event: PeerRouteDiagEvent;
  /** Pseudonymous joiner presence id (truncated). */
  peerPresenceId?: string;
  presenceGeneration?: number;
  /** Short hash of connectionId — never the raw id. */
  connectionHash?: string;
  reason?: string;
  durationMs?: number;
  routeState?: PeerRouteHealthState;
}

export interface PeerRouteCounters {
  routeSuspect: number;
  routeRebindAttempt: number;
  routeRebindSuccess: number;
  routeRebindFailure: number;
  routeRefreshSame: number;
  routeAwaitingFresh: number;
  routeVerificationFailed: number;
  routeUnavailable: number;
  routeRefreshRequested: number;
}

export function createPeerRouteCounters(): PeerRouteCounters {
  return {
    routeSuspect: 0,
    routeRebindAttempt: 0,
    routeRebindSuccess: 0,
    routeRebindFailure: 0,
    routeRefreshSame: 0,
    routeAwaitingFresh: 0,
    routeVerificationFailed: 0,
    routeUnavailable: 0,
    routeRefreshRequested: 0
  };
}

export function hashConnectionId(connectionId: string | undefined): string | undefined {
  if (!connectionId || connectionId.length < 4) {
    return undefined;
  }
  return createHash("sha256").update(connectionId).digest("hex").slice(0, 12);
}

export function sanitizePresenceId(presenceId: string | undefined): string | undefined {
  if (!presenceId) {
    return undefined;
  }
  if (presenceId.length <= 24) {
    return presenceId;
  }
  return `${presenceId.slice(0, 20)}…`;
}

/**
 * Emit a single-line structured diagnostic to stderr.
 * Safe for support tickets; never includes prompts, tokens, or payloads.
 */
export function emitPeerRouteDiag(fields: PeerRouteDiagFields): void {
  const line = {
    v: 1,
    ts: new Date().toISOString(),
    ...fields,
    ...(fields.peerPresenceId ? { peerPresenceId: sanitizePresenceId(fields.peerPresenceId) } : {})
  };
  try {
    console.warn(JSON.stringify(line));
  } catch {
    /* diagnostics must never throw */
  }
}

export function bumpRouteCounter(counters: PeerRouteCounters, event: PeerRouteDiagEvent): void {
  switch (event) {
    case "peer.route.suspect":
      counters.routeSuspect += 1;
      break;
    case "peer.route.rebind_started":
      counters.routeRebindAttempt += 1;
      break;
    case "peer.route.rebind_succeeded":
      counters.routeRebindSuccess += 1;
      break;
    case "peer.route.rebind_failed":
      counters.routeRebindFailure += 1;
      break;
    case "peer.route.refresh_same":
      counters.routeRefreshSame += 1;
      break;
    case "peer.route.awaiting_fresh":
      counters.routeAwaitingFresh += 1;
      break;
    case "peer.route.verification_failed":
      counters.routeVerificationFailed += 1;
      break;
    case "peer.route.unavailable":
      counters.routeUnavailable += 1;
      break;
    case "peer.route.refresh_requested":
      counters.routeRefreshRequested += 1;
      break;
    default:
      break;
  }
}

/** True while first-time (or remint) verification is in progress for a connectionId. */
export function isRouteVerifying(state: PeerRouteHealthState | undefined): boolean {
  return state === "discovered" || state === "verifying";
}

/** Bounded same-route refresh attempts before awaiting fresh presence. */
export const ROUTE_SAME_FAIL_LIMIT = 3;
/** Minimum gap between same-route refresh diagnostics / retries (anti-storm). */
export const ROUTE_SAME_COOLDOWN_MS = 5_000;
/**
 * Per-peer minimum gap between directed `routeRefreshRequested` hellos (anti-spam).
 * Cleared when that peer's route returns to verified healthy.
 */
export const ROUTE_REFRESH_REQUEST_COOLDOWN_MS = 30_000;

/**
 * True when an immutable send-time probe episode may mutate the current binding.
 * A response for connection A must never verify or degrade connection B.
 */
export function isAuthoritativeProbeEpisode(input: {
  sentConnectionId: string;
  presenceGeneration?: number;
  mappedConnectionId?: string;
  verifyConnectionId?: string;
  verifyGeneration?: number;
  currentGeneration?: number;
}): boolean {
  if (!input.sentConnectionId || input.sentConnectionId.length < 8) {
    return false;
  }
  if (!input.mappedConnectionId || input.mappedConnectionId !== input.sentConnectionId) {
    return false;
  }
  if (input.verifyConnectionId && input.verifyConnectionId !== input.sentConnectionId) {
    return false;
  }
  if (
    input.presenceGeneration !== undefined &&
    input.currentGeneration !== undefined &&
    input.presenceGeneration !== input.currentGeneration
  ) {
    return false;
  }
  if (
    input.verifyGeneration !== undefined &&
    input.presenceGeneration !== undefined &&
    input.verifyGeneration !== input.presenceGeneration
  ) {
    return false;
  }
  return true;
}
