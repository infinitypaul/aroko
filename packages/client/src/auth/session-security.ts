import {
  PAIRMESH_SECURITY_VERSION,
  PairMeshSessionSecuritySchema,
  createPairMeshError,
  type PairMeshSessionSecurity
} from "@pairmesh/protocol";
import type { LocalParticipantRecord, LocalSessionState } from "../session/schemas.js";
import { credentialFingerprint } from "./secrets.js";
import { isInviteRedeemable } from "./invites.js";

export function createSessionSecurity(): PairMeshSessionSecurity {
  return PairMeshSessionSecuritySchema.parse({
    securityVersion: PAIRMESH_SECURITY_VERSION,
    invites: [],
    acceptedInbound: [],
    capabilityGrants: []
  });
}

export function isAuthenticatedSession(state: LocalSessionState): boolean {
  return (
    state.requiresRePair !== true &&
    state.sessionSecurity?.securityVersion === PAIRMESH_SECURITY_VERSION
  );
}

export function requireSessionSecurity(state: LocalSessionState): PairMeshSessionSecurity {
  if (!isAuthenticatedSession(state) || !state.sessionSecurity) {
    throw createPairMeshError({
      code: "pairmesh.session_requires_repair",
      message:
        "This PairMesh session was paired before session authentication was required. Run `pairmesh leave`, then create and join the session again.",
      details: { sessionCode: state.sessionCode }
    });
  }
  return state.sessionSecurity;
}

/**
 * Returns the bearer this agent must present when calling `peer`, failing with a
 * clear error when the pairing predates authentication or has been revoked.
 */
export function requireOutboundBearer(
  state: LocalSessionState,
  peer: LocalParticipantRecord
): string {
  requireSessionSecurity(state);

  if (!peer.outboundBearer) {
    throw createPairMeshError({
      code: "pairmesh.authentication_required",
      message: `No session credential is held for ${peer.agent.name}. Re-pair with a fresh invite.`,
      details: { peer: peer.agent.name }
    });
  }

  return peer.outboundBearer;
}

export interface SessionSecurityView {
  authenticated: boolean;
  securityVersion?: string;
  requiresRePair: boolean;
  openInvites: number;
  activeCredentials: Array<{ participantId: string; credentialId: string; fingerprint: string }>;
  revokedCredentials: number;
}

/** Human-readable security summary for `status` / `doctor`. Never includes secrets. */
export function describeSessionSecurity(
  state: LocalSessionState,
  now: Date = new Date()
): SessionSecurityView {
  const security = state.sessionSecurity;
  if (!security) {
    return {
      authenticated: false,
      requiresRePair: true,
      openInvites: 0,
      activeCredentials: [],
      revokedCredentials: 0
    };
  }

  return {
    authenticated: isAuthenticatedSession(state),
    securityVersion: security.securityVersion,
    requiresRePair: state.requiresRePair === true,
    openInvites: security.invites.filter((invite) => isInviteRedeemable(invite, now)).length,
    activeCredentials: security.acceptedInbound
      .filter((credential) => credential.revokedAt === undefined)
      .map((credential) => ({
        participantId: credential.participantId,
        credentialId: credential.credentialId,
        fingerprint: credentialFingerprint(credential.tokenHash)
      })),
    revokedCredentials: security.acceptedInbound.filter(
      (credential) => credential.revokedAt !== undefined
    ).length
  };
}
