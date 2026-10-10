import type { PeerHealthResult } from "@pairmesh/protocol";
import type { RelayLifecycleState } from "../connectivity/relay-bridge.js";
import type { PeerRouteHealthState } from "../connectivity/relay/route-diagnostics.js";
import type { PeerRelationshipStatus } from "../session/relationship.js";
import type { PeerConnectivityStatus, SafePeerView } from "../session/peer-view.js";

export interface ProjectPeerConnectivityInput {
  relationship: PeerRelationshipStatus;
  relayLifecycle?: RelayLifecycleState | "idle";
  /** True when local runtime is on relay transport (not direct-url). */
  relayMode?: boolean;
  health?: PeerHealthResult;
  /**
   * Creator→joiner verified-route authority (`CreatorPeerBinding.routeHealth`).
   * When `verifiedRouteRequired`, this is the sole gate for connection=ready.
   */
  routeHealth?: PeerRouteHealthState;
  /**
   * Creator relay peers with a presence binding: READY only when routeHealth===healthy.
   * Façade /health / pairing must not independently produce ready.
   */
  verifiedRouteRequired?: boolean;
}

/**
 * Maps relay lifecycle + optional health probe into user-facing connectivity.
 * Transport reachability is distinct from pairwise trust (relationship) and authorization.
 *
 * For creator relay peers (`verifiedRouteRequired`), CreatorPeerBinding.routeHealth is
 * the sole authority for connection=ready:
 *   discovered/verifying/suspect/awaiting_fresh → reconnecting
 *   healthy → ready
 *   unavailable → offline
 */
export function projectPeerConnectivity(
  input: ProjectPeerConnectivityInput
): PeerConnectivityStatus {
  if (input.relationship === "unpaired") {
    return "none";
  }

  const relayActive =
    input.relayMode &&
    input.relayLifecycle !== undefined &&
    input.relayLifecycle !== "idle" &&
    input.relayLifecycle !== "stopped";

  if (relayActive) {
    if (
      input.relayLifecycle === "reconnecting" ||
      input.relayLifecycle === "connecting" ||
      input.relayLifecycle === "e2e_negotiating" ||
      input.relayLifecycle === "connected"
    ) {
      return "reconnecting";
    }
    if (input.relayLifecycle === "offline" || input.relayLifecycle === "auth_failed") {
      return "offline";
    }
  }

  // Creator relay peer: verified-route SM is sole connection-ready authority.
  if (input.verifiedRouteRequired) {
    const rh = input.routeHealth;
    if (rh === "healthy") {
      return "ready";
    }
    if (rh === "unavailable") {
      return "offline";
    }
    // discovered | verifying | suspect | awaiting_fresh | missing binding
    return "reconnecting";
  }

  if (!input.health) {
    if (relayActive && input.relayLifecycle === "ready") {
      return "unknown";
    }
    return input.relationship === "revoked" ? "none" : "unknown";
  }

  if (!input.health.reachable) {
    return "offline";
  }

  if (relayActive && input.relayLifecycle !== "ready") {
    return "reconnecting";
  }

  return "ready";
}

/** Coding-agent readiness from a health probe — separate from transport connectivity. */
export function projectPeerAgentStatus(
  health?: PeerHealthResult
): SafePeerView["agent"] | undefined {
  if (!health?.reachable) {
    return undefined;
  }
  if (!health.codingAgent) {
    return "unknown";
  }
  if (health.codingAgent.status === "available" || health.codingAgent.status === "busy") {
    return "ready";
  }
  if (health.codingAgent.status === "unavailable") {
    return "unavailable";
  }
  return "unknown";
}
