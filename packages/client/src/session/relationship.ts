import type { LocalParticipantRecord, LocalSessionState } from "../session/schemas.js";

export type PeerRelationshipStatus = "paired" | "unpaired" | "revoked";

/** True when local holds an outbound bearer for calling this peer. */
export function isPairedWithLocal(peer: LocalParticipantRecord): boolean {
  return peer.outboundBearer !== undefined;
}

/**
 * Local view of collaboration membership: self + every known peer record,
 * including unpaired / relationship-revoked members.
 */
export function listCollaborationMembers(state: LocalSessionState): Array<{
  participantId: string;
  displayName: string;
  agentName: string;
  isLocal: boolean;
  relationship: PeerRelationshipStatus;
}> {
  const local = {
    participantId: state.localParticipant.participant.id,
    displayName: state.localParticipant.developer.displayName,
    agentName: state.localParticipant.agent.name,
    isLocal: true,
    relationship: "paired" as const
  };

  const remotes = state.peers.map((peer) => ({
    participantId: peer.participant.id,
    displayName: peer.developer.displayName,
    agentName: peer.agent.name,
    isLocal: false,
    relationship: peerRelationshipStatus(state, peer)
  }));

  return [local, ...remotes];
}

export function peerRelationshipStatus(
  state: LocalSessionState,
  peer: LocalParticipantRecord
): PeerRelationshipStatus {
  const inbound = state.sessionSecurity?.acceptedInbound.find(
    (credential) => credential.participantId === peer.participant.id
  );
  if (inbound?.revokedAt) {
    return "revoked";
  }
  if (isPairedWithLocal(peer)) {
    return "paired";
  }
  return "unpaired";
}

/** Unique participant count for collaboration-full checks (local + remotes). */
export function collaborationParticipantCount(state: LocalSessionState): number {
  return 1 + state.peers.length;
}
