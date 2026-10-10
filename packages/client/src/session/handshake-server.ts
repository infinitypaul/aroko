import {
  PAIRMESH_METADATA_VERSION,
  PAIRMESH_MAX_COLLABORATION_PARTICIPANTS,
  PAIRMESH_SECURITY_VERSION,
  PairMeshBearerTokenSchema,
  PairMeshJoinFailureResponseSchema,
  PairMeshJoinSuccessResponseSchema,
  PairMeshSessionParticipantSchema,
  createPairMeshError,
  IsoUtcTimestampSchema,
  type PairMeshBearerToken,
  type PairMeshJoinParticipantPayload,
  type PairMeshJoinParticipantRecord,
  type PairMeshJoinRequest,
  type PairMeshJoinResponse,
  type PairMeshSessionSecurity
} from "@pairmesh/protocol";
import { issueInboundCredential, registerInboundCredential } from "../auth/credentials.js";
import { markInviteUsed, validateInviteSecret } from "../auth/invites.js";
import {
  applyParticipantCapabilityPolicies,
  ensureDefaultGrants,
  resolveInviteInitialGrants
} from "../auth/capabilities.js";
import { createSessionSecurity, isAuthenticatedSession } from "../auth/session-security.js";
import { AuditLog, buildAuditEvent } from "../audit/index.js";
import { normalizeAgentCardUrl } from "../identity.js";
import { getRuntimeRelayBridge } from "../connectivity/relay-runtime.js";
import { LocalStateStore } from "../state/store.js";
import { collaborationParticipantCount } from "./relationship.js";
import {
  LOCAL_STATE_VERSION,
  type LocalParticipantRecord,
  type LocalSessionState
} from "./schemas.js";

function nowUtc(): string {
  return IsoUtcTimestampSchema.parse(new Date().toISOString());
}

function failure(error: Parameters<typeof createPairMeshError>[0]): PairMeshJoinResponse {
  return PairMeshJoinFailureResponseSchema.parse({
    metadataVersion: PAIRMESH_METADATA_VERSION,
    accepted: false,
    error: createPairMeshError(error)
  });
}

function success(
  state: LocalSessionState,
  issuedBearer: PairMeshBearerToken
): PairMeshJoinResponse {
  return PairMeshJoinSuccessResponseSchema.parse({
    metadataVersion: PAIRMESH_METADATA_VERSION,
    accepted: true,
    session: state.session,
    sessionCode: state.sessionCode,
    securityVersion: PAIRMESH_SECURITY_VERSION,
    issuedBearer,
    participants: toJoinParticipantRecords(state)
  });
}

function toJoinParticipantRecords(state: LocalSessionState): PairMeshJoinParticipantRecord[] {
  const local = toJoinParticipantRecord(state.localParticipant);
  const peers = state.peers.map((peer) => toJoinParticipantRecord(peer));
  return [local, ...peers];
}

function toJoinParticipantRecord(record: LocalParticipantRecord): PairMeshJoinParticipantRecord {
  const device = record.device ?? {
    id: record.agent.deviceId,
    developerId: record.developer.id,
    name: `${record.agent.name}-device`
  };

  return {
    participant: record.participant,
    developer: record.developer,
    device,
    agent: record.agent,
    a2aAgentUrl: record.a2aAgentUrl
  };
}

function payloadToLocalParticipant(
  sessionId: LocalSessionState["session"]["id"],
  payload: PairMeshJoinParticipantPayload,
  outboundBearer: PairMeshBearerToken
): LocalParticipantRecord {
  const participant = PairMeshSessionParticipantSchema.parse({
    id: payload.peerId,
    sessionId,
    developerId: payload.developer.id,
    agentId: payload.agent.id,
    joinedAt: nowUtc()
  });

  return {
    participant,
    agent: {
      ...payload.agent,
      a2aAgentCardUrl: payload.agent.a2aAgentCardUrl ?? normalizeAgentCardUrl(payload.a2aAgentUrl)
    },
    developer: payload.developer,
    device: payload.device,
    // Relay mode: route subsequent A2A through the runtime's encrypted egress,
    // not the joiner's advertised cleartext URL (may be unreachable / Tailscale).
    a2aAgentUrl: resolveJoinPeerTransportUrl(payload.a2aAgentUrl),
    isLocal: false,
    outboundBearer
  };
}

function resolveJoinPeerTransportUrl(advertisedUrl: string): string {
  const endpoint = getRuntimeRelayBridge()?.getLocalEndpoint();
  if (endpoint) return endpoint;
  return advertisedUrl;
}

function findExistingPeer(
  state: LocalSessionState,
  payload: PairMeshJoinParticipantPayload
): LocalParticipantRecord | undefined {
  if (state.localParticipant.agent.id === payload.agent.id) {
    return state.localParticipant;
  }

  return state.peers.find(
    (peer) =>
      peer.agent.id === payload.agent.id ||
      peer.participant.id === payload.peerId ||
      peer.a2aAgentUrl === payload.a2aAgentUrl
  );
}

/**
 * Inviter-side join/pair handling. Validates the single-use invite, registers the
 * peer, records the bearer the peer offered for inbound calls, and issues a
 * fresh bearer the peer must present back. Establishes a pairwise relationship
 * with the local inviter only — never with other collaboration members.
 */
export async function processPairMeshJoinRequest(
  store: LocalStateStore,
  request: PairMeshJoinRequest
): Promise<PairMeshJoinResponse> {
  // Entire join RMW under exclusive lock so concurrent action/grant writers cannot
  // lose the new peer, and invite single-use cannot race another redeem.
  return store.enqueue(async () => processPairMeshJoinRequestExclusive(store, request));
}

async function processPairMeshJoinRequestExclusive(
  store: LocalStateStore,
  request: PairMeshJoinRequest
): Promise<PairMeshJoinResponse> {
  const state = await store.load();
  if (!state) {
    return failure({
      code: "pairmesh.session_not_found",
      message: "No PairMesh session exists on the creator agent."
    });
  }

  if (state.session.status === "closed") {
    return failure({
      code: "pairmesh.session_closed",
      message: "The PairMesh session is closed.",
      details: { sessionCode: state.sessionCode }
    });
  }

  if (state.sessionCode !== request.sessionCode) {
    return failure({
      code: "pairmesh.session_not_found",
      message: "No active PairMesh session matches the provided session code.",
      details: { sessionCode: request.sessionCode }
    });
  }

  if (!isAuthenticatedSession(state) || !state.sessionSecurity) {
    return failure({
      code: "pairmesh.session_requires_repair",
      message:
        "The creator session predates PairMesh session authentication. The creator must leave and re-create the session.",
      details: { sessionCode: state.sessionCode }
    });
  }

  const validation = validateInviteSecret(state.sessionSecurity, request.inviteSecret);
  if (!validation.ok) {
    return failure({ code: validation.code, message: validation.message });
  }

  if (state.localParticipant.a2aAgentUrl === request.participant.a2aAgentUrl) {
    return failure({
      code: "pairmesh.session_invalid_state",
      message: "Cannot register the session creator as a joining peer."
    });
  }

  const offeredInboundBearer = PairMeshBearerTokenSchema.parse(request.offeredInboundBearer);
  const existing = findExistingPeer(state, request.participant);
  if (existing && existing.participant.id === state.localParticipant.participant.id) {
    return failure({
      code: "pairmesh.session_invalid_state",
      message: "Cannot register the session creator as a joining peer."
    });
  }

  if (
    !existing &&
    collaborationParticipantCount(state) >= PAIRMESH_MAX_COLLABORATION_PARTICIPANTS
  ) {
    return failure({
      code: "pairmesh.collaboration_full",
      message: `This PairMesh collaboration already has the maximum of ${PAIRMESH_MAX_COLLABORATION_PARTICIPANTS} participants.`,
      details: {
        maxParticipants: PAIRMESH_MAX_COLLABORATION_PARTICIPANTS,
        currentParticipants: collaborationParticipantCount(state)
      }
    });
  }

  const now = new Date();

  // Re-join / re-pair refreshes identity from the request so the peer can find
  // itself in the response, but keeps the prior participant id so credentials
  // stay scoped to that peer.
  //
  // Critical: do NOT drop an existing pairwise relay binding. `payloadToLocalParticipant`
  // rebuilds `a2aAgentUrl` via `getLocalEndpoint()` (first creator egress) and omits
  // `connectivity`. That made re-pair wipe a live tunnel → peer stays "offline" until
    const rebuilt = payloadToLocalParticipant(
    state.session.id,
    request.participant,
    offeredInboundBearer
  );
  const newPeer = existing
    ? {
        ...rebuilt,
        participant: {
          ...PairMeshSessionParticipantSchema.parse({
            id: existing.participant.id,
            sessionId: state.session.id,
            developerId: request.participant.developer.id,
            agentId: request.participant.agent.id,
            joinedAt: existing.participant.joinedAt
          })
        },
        ...(existing.connectivity ? { connectivity: existing.connectivity } : {}),
        a2aAgentUrl:
          existing.connectivity?.mode === "relay" && existing.a2aAgentUrl
            ? existing.a2aAgentUrl
            : rebuilt.a2aAgentUrl
      }
    : rebuilt;

  const issued = issueInboundCredential(newPeer.participant.id, now);
  let security: PairMeshSessionSecurity = {
    ...markInviteUsed(state.sessionSecurity, validation.invite.invitationId, now),
    acceptedInbound: [
      // A re-join supersedes any earlier credential for the same participant.
      ...state.sessionSecurity.acceptedInbound.filter(
        (credential) => credential.participantId !== newPeer.participant.id
      ),
      issued.credential
    ]
  };
  // Explicit V1 grants for the joining peer (receiver-authoritative).
  // Invite template wins when present; join payload never supplies grants.
  security = applyParticipantCapabilityPolicies(
    security,
    newPeer.participant.id,
    resolveInviteInitialGrants(validation.invite.initialGrants),
    now
  );

  const nextState: LocalSessionState = {
    ...state,
    peers: existing
      ? state.peers.map((peer) =>
          peer.participant.id === existing.participant.id ? newPeer : peer
        )
      : [...state.peers, newPeer],
    sessionSecurity: security,
    permissionRequests: state.permissionRequests ?? []
  };

  await store.writeExclusive(nextState);

    // After credentials land, re-project any live creator egresses into peer state
  // and nudge joiner presence so already-running peers become ready without restart.
  void getRuntimeRelayBridge()
    ?.reconcilePeerTransports()
    .catch(() => {
      /* best-effort — asks/health surface lag */
    });

  const audit = AuditLog.fromStateFile(store.stateFilePath);
  audit.record(
    buildAuditEvent({
      eventType: "invite.redeemed",
      projectId: state.localParticipant.agent.projectId,
      sessionId: state.session.id,
      sessionCode: state.sessionCode,
      actor: {
        participantId: newPeer.participant.id,
        agentId: newPeer.agent.id,
        peerName: newPeer.agent.name
      },
      target: {
        participantId: state.localParticipant.participant.id,
        agentId: state.localParticipant.agent.id,
        peerName: state.localParticipant.agent.name
      },
      metadata: { invitationId: validation.invite.invitationId }
    })
  );
  audit.record(
    buildAuditEvent({
      eventType: "peer.joined",
      projectId: state.localParticipant.agent.projectId,
      sessionId: state.session.id,
      sessionCode: state.sessionCode,
      actor: {
        participantId: state.localParticipant.participant.id,
        agentId: state.localParticipant.agent.id,
        peerName: state.localParticipant.agent.name
      },
      target: {
        participantId: newPeer.participant.id,
        agentId: newPeer.agent.id,
        peerName: newPeer.agent.name
      },
      metadata: { peerName: newPeer.agent.name }
    })
  );
  for (const grant of security.capabilityGrants.filter(
    (entry) => entry.participantId === newPeer.participant.id
  )) {
    audit.record(
      buildAuditEvent({
        eventType: "capability.granted",
        projectId: state.localParticipant.agent.projectId,
        sessionId: state.session.id,
        sessionCode: state.sessionCode,
        actor: {
          participantId: state.localParticipant.participant.id,
          agentId: state.localParticipant.agent.id,
          peerName: state.localParticipant.agent.name
        },
        target: {
          participantId: newPeer.participant.id,
          agentId: newPeer.agent.id,
          peerName: newPeer.agent.name
        },
        metadata: {
          capabilityId: grant.capabilityId,
          policy: grant.policy,
          scope: "session"
        }
      })
    );
  }

  return success(nextState, issued.token);
}

export interface JoinResponseLocalStateInput {
  response: Extract<PairMeshJoinResponse, { accepted: true }>;
  localAgentId: string;
  /** Plaintext token this joiner offered the inviter for inbound calls. */
  offeredInboundBearer: PairMeshBearerToken | string;
}

export function joinResponseToLocalState(input: JoinResponseLocalStateInput): LocalSessionState {
  const { response, localAgentId } = input;
  const offeredInboundBearer = PairMeshBearerTokenSchema.parse(input.offeredInboundBearer);
  const issuedBearer = PairMeshBearerTokenSchema.parse(response.issuedBearer);

  let localParticipant: LocalParticipantRecord | undefined;
  const peers: LocalParticipantRecord[] = [];

  for (const record of response.participants) {
    const isLocal = record.agent.id === localAgentId;
    const localRecord: LocalParticipantRecord = {
      participant: record.participant,
      developer: record.developer,
      device: record.device,
      agent: record.agent,
      a2aAgentUrl: record.a2aAgentUrl,
      isLocal
    };

    if (isLocal) {
      localParticipant = localRecord;
    } else {
      peers.push(localRecord);
    }
  }

  if (!localParticipant) {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh join response did not include the joining participant."
    });
  }

  // Inviter is always first in the join success participant list.
  const inviterParticipantId = response.participants[0]?.participant.id;
  const inviterIndex = peers.findIndex((peer) => peer.participant.id === inviterParticipantId);
  const inviter = inviterIndex >= 0 ? peers[inviterIndex] : undefined;
  if (!inviter) {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh join response did not include the inviting participant."
    });
  }

  // Inviter-issued bearer authenticates calls to the inviter only. Other
  // participants require their own pairing before they can be called.
  peers[inviterIndex] = { ...inviter, outboundBearer: issuedBearer };

  const security = ensureDefaultGrants(
    {
      ...createSessionSecurity(),
      acceptedInbound: [registerInboundCredential(inviter.participant.id, offeredInboundBearer)]
    },
    inviter.participant.id
  );

  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: response.sessionCode,
    session: response.session,
    localParticipant,
    peers,
    inspectionThreads: [],
    inspectionExecutions: [],
    permissionRequests: [],
    actionExecutions: [],
    actionArtifacts: [],
    collaborativeTasks: [],
    inputRequests: [],
    hostToolCalls: [],
    providerTurns: [],
    continuationEvents: [],
    sessionSecurity: security
  };
}

/**
 * Merge a successful pair/join response into an existing local collaboration
 * without wiping other pairwise relationships.
 */
export function mergeRelationshipIntoLocalState(input: {
  state: LocalSessionState;
  response: Extract<PairMeshJoinResponse, { accepted: true }>;
  offeredInboundBearer: PairMeshBearerToken | string;
  peerTransportUrl: string;
}): LocalSessionState {
  const { state, response, peerTransportUrl } = input;
  const offeredInboundBearer = PairMeshBearerTokenSchema.parse(input.offeredInboundBearer);
  const issuedBearer = PairMeshBearerTokenSchema.parse(response.issuedBearer);

  if (response.sessionCode !== state.sessionCode || response.session.id !== state.session.id) {
    throw createPairMeshError({
      code: "pairmesh.session_invalid_state",
      message:
        "Invite redemption session does not match the local collaboration. Leave before joining a different collaboration.",
      details: {
        localSessionCode: state.sessionCode,
        remoteSessionCode: response.sessionCode
      }
    });
  }

  const inviterParticipantId = response.participants[0]?.participant.id;
  if (!inviterParticipantId) {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "PairMesh join response did not include the inviting participant."
    });
  }

  let nextPeers = [...state.peers];
  let security = state.sessionSecurity ?? createSessionSecurity();

  for (const record of response.participants) {
    if (record.agent.id === state.localParticipant.agent.id) {
      continue;
    }

    const existingIndex = nextPeers.findIndex(
      (peer) => peer.participant.id === record.participant.id || peer.agent.id === record.agent.id
    );
    const isInviter = record.participant.id === inviterParticipantId;
    const base: LocalParticipantRecord = {
      participant: record.participant,
      developer: record.developer,
      device: record.device,
      agent: record.agent,
      a2aAgentUrl: isInviter ? peerTransportUrl : record.a2aAgentUrl,
      isLocal: false,
      ...(isInviter ? { outboundBearer: issuedBearer } : {}),
      ...(existingIndex >= 0 && nextPeers[existingIndex]?.connectivity
        ? { connectivity: nextPeers[existingIndex].connectivity }
        : {})
    };

    if (existingIndex >= 0) {
      const previous = nextPeers[existingIndex]!;
      nextPeers[existingIndex] = {
        ...base,
        outboundBearer: isInviter ? issuedBearer : previous.outboundBearer,
        a2aAgentUrl: isInviter ? peerTransportUrl : previous.a2aAgentUrl
      };
    } else {
      if (
        collaborationParticipantCount({ ...state, peers: nextPeers }) >=
        PAIRMESH_MAX_COLLABORATION_PARTICIPANTS
      ) {
        throw createPairMeshError({
          code: "pairmesh.collaboration_full",
          message: `This PairMesh collaboration already has the maximum of ${PAIRMESH_MAX_COLLABORATION_PARTICIPANTS} participants.`,
          details: { maxParticipants: PAIRMESH_MAX_COLLABORATION_PARTICIPANTS }
        });
      }
      nextPeers.push(base);
    }
  }

  security = ensureDefaultGrants(
    {
      ...security,
      acceptedInbound: [
        ...security.acceptedInbound.filter(
          (credential) => credential.participantId !== inviterParticipantId
        ),
        registerInboundCredential(inviterParticipantId, offeredInboundBearer)
      ]
    },
    inviterParticipantId
  );

  return {
    ...state,
    peers: nextPeers,
    sessionSecurity: security,
    inspectionThreads: state.inspectionThreads ?? [],
    inspectionExecutions: state.inspectionExecutions ?? [],
    permissionRequests: state.permissionRequests ?? [],
    actionExecutions: state.actionExecutions ?? [],
    actionArtifacts: state.actionArtifacts ?? []
  };
}
