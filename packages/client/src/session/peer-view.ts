import { createPairMeshError } from "@pairmesh/protocol";
import type { LocalParticipantRecord, LocalSessionState } from "./schemas.js";
import {
  isPairedWithLocal,
  peerRelationshipStatus,
  type PeerRelationshipStatus
} from "./relationship.js";

/** Safe connectivity presentation — distinct from trust and authorization. */
export type PeerConnectivityStatus = "ready" | "reconnecting" | "offline" | "unknown" | "none";

/**
 * Safe peer row for CLI / MCP / Control.
 * Never includes bearers, invite secrets, channel ids, or absolute paths.
 */
export interface SafePeerView {
  participantId: string;
  displayName: string;
  agentName: string;
  /** Optional safe service/project label (never an absolute path). */
  service?: string;
  relationship: PeerRelationshipStatus;
  connectivity: PeerConnectivityStatus;
  agent?: "ready" | "unavailable" | "unknown";
}

/** Compact safe peer identity for inspection status / ask results. */
export interface SafePeerMeta {
  participantId: string;
  displayName: string;
  service?: string;
}

export function toSafePeerMeta(peer: LocalParticipantRecord): SafePeerMeta {
  const service = peerServiceLabel(peer);
  return {
    participantId: peer.participant.id,
    displayName: peer.developer.displayName,
    ...(service ? { service } : {})
  };
}

const SERVICE_LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export function isSafeServiceLabel(value: string): boolean {
  return SERVICE_LABEL_RE.test(value.trim());
}

export function normalizeServiceLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!isSafeServiceLabel(trimmed)) {
    throw createPairMeshError({
      code: "pairmesh.invalid_metadata",
      message:
        "Service label must be a short safe token (letters, digits, . _ -), not a filesystem path.",
      details: { field: "service" }
    });
  }
  return trimmed;
}

function peerServiceLabel(peer: LocalParticipantRecord): string | undefined {
  const fromRecord = peer.serviceLabel;
  if (typeof fromRecord === "string" && fromRecord.trim()) {
    return fromRecord.trim();
  }
  return undefined;
}

export function toSafePeerView(
  state: LocalSessionState,
  peer: LocalParticipantRecord,
  options?: {
    connectivity?: PeerConnectivityStatus;
    agent?: SafePeerView["agent"];
  }
): SafePeerView {
  const relationship = peerRelationshipStatus(state, peer);
  const connectivity =
    options?.connectivity ??
    (relationship === "unpaired" || relationship === "revoked" ? "none" : "unknown");
  const service = peerServiceLabel(peer);
  return {
    participantId: peer.participant.id,
    displayName: peer.developer.displayName,
    agentName: peer.agent.name,
    ...(service ? { service } : {}),
    relationship,
    connectivity,
    ...(options?.agent ? { agent: options.agent } : {})
  };
}

/** Remote collaboration members only (excludes local participant). */
export function listSafePeers(
  state: LocalSessionState,
  options?: {
    connectivityByParticipantId?: Record<string, PeerConnectivityStatus>;
    agentByParticipantId?: Record<string, SafePeerView["agent"]>;
  }
): SafePeerView[] {
  return state.peers.map((peer) =>
    toSafePeerView(state, peer, {
      connectivity: options?.connectivityByParticipantId?.[peer.participant.id],
      agent: options?.agentByParticipantId?.[peer.participant.id]
    })
  );
}

export interface ResolvePeerTargetResult {
  peer: LocalParticipantRecord;
  resolvedBy: "participantId" | "agentId" | "displayName" | "service";
}

/**
 * Resolve a human or machine peer selector to exactly one participant.
 * Display names and service labels are selectors only — never security principals.
 * Everyday name/service selectors skip revoked ghosts; unpaired members still resolve
 * so callers can fail closed with authentication_required (not peer_not_found).
 * When both paired and unpaired share a name, prefer the paired peer.
 */
export function resolvePeerTarget(
  state: LocalSessionState,
  peerRef: string
): ResolvePeerTargetResult {
  const normalized = peerRef.trim();
  if (!normalized) {
    throw createPairMeshError({
      code: "pairmesh.peer_not_found",
      message: "Peer selector is empty.",
      details: { peerRef }
    });
  }

  const byId = state.peers.find(
    (peer) => peer.participant.id === normalized || peer.agent.id === normalized
  );
  if (byId) {
    return {
      peer: byId,
      resolvedBy: byId.participant.id === normalized ? "participantId" : "agentId"
    };
  }

  const selectable = selectablePeersForAsk(state);

  const compound = parseCompoundPeerSelector(normalized);
  if (compound) {
    const matches = selectable.filter((peer) => {
      const service = peerServiceLabel(peer);
      const nameOk =
        peer.developer.displayName === compound.name || peer.agent.name === compound.name;
      return nameOk && service === compound.service;
    });
    return pickUniqueMatch(normalized, matches, "service");
  }

  const byService = selectable.filter((peer) => peerServiceLabel(peer) === normalized);
  if (byService.length > 0) {
    return pickUniqueMatch(normalized, byService, "service");
  }

  const byDisplay = selectable.filter(
    (peer) => peer.agent.name === normalized || peer.developer.displayName === normalized
  );
  if (byDisplay.length > 0) {
    return pickUniqueMatch(normalized, byDisplay, "displayName");
  }

  throw createPairMeshError({
    code: "pairmesh.peer_not_found",
    message: "Peer not found in the active PairMesh collaboration.",
    details: { peerRef: normalized }
  });
}

/**
 * Everyday name/service pool: exclude revoked ghosts so stale duplicates do not win.
 * Unpaired collaboration members remain selectable (auth is enforced after resolve).
 */
function selectablePeersForAsk(state: LocalSessionState): LocalParticipantRecord[] {
  return state.peers.filter((peer) => peerRelationshipStatus(state, peer) !== "revoked");
}

function pickUniqueMatch(
  peerRef: string,
  matches: LocalParticipantRecord[],
  resolvedBy: "displayName" | "service"
): ResolvePeerTargetResult {
  if (matches.length === 0) {
    throw createPairMeshError({
      code: "pairmesh.peer_not_found",
      message: `No peer matches "${peerRef}".`,
      details: { peerRef }
    });
  }
  if (matches.length === 1) {
    return { peer: matches[0]!, resolvedBy };
  }
  const paired = matches.filter((peer) => isPairedWithLocal(peer));
  if (paired.length === 1) {
    return { peer: paired[0]!, resolvedBy };
  }
  if (paired.length > 1) {
    throwAmbiguous(peerRef, paired);
  }
  throwAmbiguous(peerRef, matches);
}

function throwAmbiguous(peerRef: string, matches: LocalParticipantRecord[]): never {
  throw createPairMeshError({
    code: "pairmesh.peer_ambiguous",
    message:
      "Multiple peers match that selector. Choose a unique service label or use DisplayName · service.",
    details: {
      peerRef,
      matches: matches.map((peer) => ({
        participantId: peer.participant.id,
        displayName: peer.developer.displayName,
        agentName: peer.agent.name,
        ...(peerServiceLabel(peer) ? { service: peerServiceLabel(peer) } : {})
      }))
    }
  });
}

/** Parse "Kelvin · payment-service" / "Kelvin • payment-service". */
export function parseCompoundPeerSelector(
  peerRef: string
): { name: string; service: string } | undefined {
  const match = peerRef.trim().match(/^(.+?)\s*[·•]\s*(.+)$/u);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const name = match[1].trim();
  const service = match[2].trim();
  if (!name || !service) {
    return undefined;
  }
  return { name, service };
}

export function formatPeerLabel(peer: { displayName: string; service?: string }): string {
  return peer.service ? `${peer.displayName} · ${peer.service}` : peer.displayName;
}

/** Assert paired relationship before initiating peer work. */
export function assertPairedForAsk(state: LocalSessionState, peer: LocalParticipantRecord): void {
  const relationship = peerRelationshipStatus(state, peer);
  if (relationship === "paired" && isPairedWithLocal(peer)) {
    return;
  }
  throw createPairMeshError({
    code: "pairmesh.authentication_required",
    message:
      relationship === "revoked"
        ? "The authenticated relationship with this peer was revoked. Pair again before asking."
        : "No authenticated relationship with this collaboration member. Pair explicitly before asking.",
    details: {
      participantId: peer.participant.id,
      relationship,
      reason: "relationship_not_established"
    }
  });
}
