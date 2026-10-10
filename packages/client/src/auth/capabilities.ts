import {
  PAIRMESH_CAPABILITY_REGISTRY,
  PAIRMESH_PERMISSION_REQUEST_TTL_MS,
  PAIRMESH_V1_CAPABILITIES,
  PairMeshPermissionRequestSchema,
  ParticipantCapabilityGrantSchema,
  PermissionRequestIdSchema,
  createPairMeshError,
  IsoUtcTimestampSchema,
  type CapabilityGrantPolicy,
  type PairMeshPermissionRequest,
  type PairMeshSessionSecurity,
  type PairMeshV1CapabilityId,
  type PairMeshGrantableCapabilityId,
  type PairMeshActionCapabilityId,
  PAIRMESH_ACTION_CAPABILITIES,
  PAIRMESH_GRANTABLE_CAPABILITIES,
  type ParticipantCapabilityGrant,
  type PermissionDecisionValue,
  type PeerId
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import type { LocalSessionState } from "../session/schemas.js";
import { requireSessionSecurity } from "./session-security.js";

export type AuthorizationOutcome =
  | { status: "allowed"; source: "session_grant" | "allow_once" | "allow_session_decision" }
  | {
      status: "approval_required";
      permissionRequest: PairMeshPermissionRequest;
      /** True only when this call created a new pending request (audit once). */
      created: boolean;
    }
  | {
      status: "denied";
      code: "pairmesh.capability_denied";
      message: string;
      /**
       * True when deny was already decided on a permission request (CLI audited).
       * False for policy deny — caller may audit once per request.
       */
      alreadyAudited: boolean;
      permissionRequestId?: string;
    };

export function markPermissionAudited(
  state: LocalSessionState,
  permissionRequestId: string,
  event: "requested" | "allowed" | "denied"
): LocalSessionState {
  const requests = state.permissionRequests ?? [];
  return {
    ...state,
    permissionRequests: requests.map((request) => {
      if (request.permissionRequestId !== permissionRequestId) {
        return request;
      }
      const audited = new Set(request.auditedEvents ?? []);
      audited.add(event);
      return {
        ...request,
        auditedEvents: [...audited]
      };
    })
  };
}

export function permissionAlreadyAudited(
  request: PairMeshPermissionRequest,
  event: "requested" | "allowed" | "denied"
): boolean {
  return (request.auditedEvents ?? []).includes(event);
}

function nowIso(date = new Date()): string {
  return IsoUtcTimestampSchema.parse(date.toISOString());
}

export function listCapabilityRegistry() {
  return PAIRMESH_CAPABILITY_REGISTRY.map((entry) => ({ ...entry }));
}

export function defaultCapabilityGrantsForParticipant(
  participantId: PeerId,
  at: Date = new Date()
): ParticipantCapabilityGrant[] {
  const updatedAt = nowIso(at);
  return PAIRMESH_CAPABILITY_REGISTRY.map((entry) =>
    ParticipantCapabilityGrantSchema.parse({
      participantId,
      capabilityId: entry.id,
      policy: entry.defaultPolicy,
      updatedAt
    })
  );
}

/** Ensure V1 default grants exist for a participant (idempotent). */
export function ensureDefaultGrants(
  security: PairMeshSessionSecurity,
  participantId: PeerId,
  at: Date = new Date()
): PairMeshSessionSecurity {
  const existing = new Set(
    (security.capabilityGrants ?? [])
      .filter((grant) => grant.participantId === participantId)
      .map((grant) => grant.capabilityId)
  );
  const additions = defaultCapabilityGrantsForParticipant(participantId, at).filter(
    (grant) => !existing.has(grant.capabilityId)
  );
  if (additions.length === 0) {
    return security;
  }
  return {
    ...security,
    capabilityGrants: [...(security.capabilityGrants ?? []), ...additions]
  };
}

/**
 * Normalize inviter-selected grants against the V1 registry. Unknown capability
 * ids are rejected. Missing capabilities fall back to registry defaults when
 * building the full template via `resolveInviteInitialGrants`.
 */
export function normalizeInviteInitialGrants(
  grants: Array<{ capabilityId: string; policy: CapabilityGrantPolicy }>
): Array<{ capabilityId: PairMeshV1CapabilityId; policy: CapabilityGrantPolicy }> {
  const byId = new Map<PairMeshV1CapabilityId, CapabilityGrantPolicy>();
  for (const grant of grants) {
    if (!isV1Capability(grant.capabilityId)) {
      throw createPairMeshError({
        code: "pairmesh.capability_not_allowed",
        message: `Unknown or unimplemented capability: ${grant.capabilityId}`,
        details: { capabilityId: grant.capabilityId }
      });
    }
    byId.set(grant.capabilityId, grant.policy);
  }
  return [...byId.entries()].map(([capabilityId, policy]) => ({ capabilityId, policy }));
}

/** Full per-capability template: explicit selections merged over registry defaults. */
export function resolveInviteInitialGrants(
  grants: Array<{ capabilityId: string; policy: CapabilityGrantPolicy }> | undefined
): Array<{ capabilityId: PairMeshV1CapabilityId; policy: CapabilityGrantPolicy }> {
  const selected = grants ? normalizeInviteInitialGrants(grants) : [];
  const byId = new Map(selected.map((grant) => [grant.capabilityId, grant.policy]));
    // lazily via ensureDefaultGrants with registry default deny.
  return PAIRMESH_V1_CAPABILITIES.map((capabilityId) => {
    const entry = PAIRMESH_CAPABILITY_REGISTRY.find((item) => item.id === capabilityId)!;
    return {
      capabilityId,
      policy: byId.get(capabilityId) ?? entry.defaultPolicy
    };
  });
}

/**
 * Apply inviter invite template (or registry defaults) for a newly joined peer.
 * Replaces any prior grants for that participant.
 */
export function applyParticipantCapabilityPolicies(
  security: PairMeshSessionSecurity,
  participantId: PeerId,
  policies: Array<{ capabilityId: PairMeshV1CapabilityId; policy: CapabilityGrantPolicy }>,
  at: Date = new Date()
): PairMeshSessionSecurity {
  const updatedAt = nowIso(at);
  const without = (security.capabilityGrants ?? []).filter(
    (grant) => grant.participantId !== participantId
  );
  const nextGrants = policies.map((entry) =>
    ParticipantCapabilityGrantSchema.parse({
      participantId,
      capabilityId: entry.capabilityId,
      policy: entry.policy,
      updatedAt
    })
  );
  return {
    ...security,
    capabilityGrants: [...without, ...nextGrants]
  };
}

export function getGrantPolicy(
  state: LocalSessionState,
  participantId: string,
  capabilityId: PairMeshGrantableCapabilityId
): CapabilityGrantPolicy {
  const security = requireSessionSecurity(state);
  const grant = (security.capabilityGrants ?? []).find(
    (entry) => entry.participantId === participantId && entry.capabilityId === capabilityId
  );
  if (grant) {
    return grant.policy;
  }
  const definition = PAIRMESH_CAPABILITY_REGISTRY.find((entry) => entry.id === capabilityId);
  return definition?.defaultPolicy ?? "deny";
}

export function setGrantPolicy(
  state: LocalSessionState,
  participantId: PeerId,
  capabilityId: PairMeshGrantableCapabilityId,
  policy: CapabilityGrantPolicy,
  at: Date = new Date()
): LocalSessionState {
  if (capabilityId === "repository.edit" && policy === "allow_session") {
    throw createPairMeshError({
      code: "pairmesh.capability_not_allowed",
      message: "repository.edit cannot use allow_session in the current Aroko release (allow-once only).",
      details: { capabilityId, policy }
    });
  }
  if (capabilityId === "process.execute" && policy === "allow_session") {
    throw createPairMeshError({
      code: "pairmesh.capability_not_allowed",
      message: "process.execute cannot use allow_session in R4 V1 (allow-once only).",
      details: { capabilityId, policy }
    });
  }
  const security = requireSessionSecurity(state);
  const updatedAt = nowIso(at);
  const without = (security.capabilityGrants ?? []).filter(
    (entry) => !(entry.participantId === participantId && entry.capabilityId === capabilityId)
  );
  const nextGrant = ParticipantCapabilityGrantSchema.parse({
    participantId,
    capabilityId,
    policy,
    updatedAt
  });
  return {
    ...state,
    sessionSecurity: {
      ...security,
      capabilityGrants: [...without, nextGrant]
    }
  };
}

export function revokeParticipantCapabilities(
  state: LocalSessionState,
  participantId: string
): LocalSessionState {
  if (!state.sessionSecurity) {
    return state;
  }
  return {
    ...state,
    sessionSecurity: {
      ...state.sessionSecurity,
      capabilityGrants: (state.sessionSecurity.capabilityGrants ?? []).filter(
        (grant) => grant.participantId !== participantId
      )
    },
    permissionRequests: (state.permissionRequests ?? []).filter(
      (request) => request.participantId !== participantId
    )
  };
}

export function clearAllCapabilityState(state: LocalSessionState): LocalSessionState {
  if (!state.sessionSecurity) {
    return { ...state, permissionRequests: [] };
  }
  return {
    ...state,
    sessionSecurity: {
      ...state.sessionSecurity,
      capabilityGrants: []
    },
    permissionRequests: []
  };
}

function expirePermissionRequests(
  requests: PairMeshPermissionRequest[],
  now: Date
): PairMeshPermissionRequest[] {
  const nowMs = now.getTime();
  return requests.map((request) => {
    if (request.status !== "pending") {
      return request;
    }
    if (Date.parse(request.expiresAt) <= nowMs) {
      return { ...request, status: "expired" as const };
    }
    return request;
  });
}

/**
 * Authorize `repository.inspect` for an inbound inspection. Never invokes ACP —
 * caller must only proceed when status === "allowed".
 */
export function authorizeInspection(
  state: LocalSessionState,
  input: {
    participantId: PeerId;
    correlationRequestId: string;
    threadId?: string;
  },
  now: Date = new Date()
): { state: LocalSessionState; outcome: AuthorizationOutcome } {
  let nextState: LocalSessionState = {
    ...state,
    permissionRequests: expirePermissionRequests(state.permissionRequests ?? [], now)
  };

  const policy = getGrantPolicy(nextState, input.participantId, "repository.inspect");

  if (policy === "deny") {
    return {
      state: nextState,
      outcome: {
        status: "denied",
        code: "pairmesh.capability_denied",
        message: "repository.inspect is denied for this participant.",
        alreadyAudited: false
      }
    };
  }

  if (policy === "allow_session") {
    return {
      state: nextState,
      outcome: { status: "allowed", source: "session_grant" }
    };
  }

  // approval_required
  const existing = (nextState.permissionRequests ?? []).find(
    (request) =>
      request.participantId === input.participantId &&
      request.capabilityId === "repository.inspect" &&
      request.correlationRequestId === input.correlationRequestId
  );

  if (existing?.status === "approved" && existing.decision === "allow-once") {
    const consumed: PairMeshPermissionRequest = {
      ...existing,
      status: "consumed",
      consumedAt: nowIso(now)
    };
    nextState = {
      ...nextState,
      permissionRequests: (nextState.permissionRequests ?? []).map((request) =>
        request.permissionRequestId === consumed.permissionRequestId ? consumed : request
      )
    };
    return {
      state: nextState,
      outcome: { status: "allowed", source: "allow_once" }
    };
  }

  if (existing?.status === "approved" && existing.decision === "allow-session") {
    // Persist as session grant and allow.
    nextState = setGrantPolicy(
      nextState,
      input.participantId,
      "repository.inspect",
      "allow_session",
      now
    );
    return {
      state: nextState,
      outcome: { status: "allowed", source: "allow_session_decision" }
    };
  }

  if (existing?.status === "denied") {
    return {
      state: nextState,
      outcome: {
        status: "denied",
        code: "pairmesh.capability_denied",
        message: "Local developer denied repository.inspect for this request.",
        alreadyAudited: permissionAlreadyAudited(existing, "denied"),
        permissionRequestId: existing.permissionRequestId
      }
    };
  }

  if (existing?.status === "pending") {
    return {
      state: nextState,
      outcome: {
        status: "approval_required",
        permissionRequest: existing,
        created: false
      }
    };
  }

  const permissionRequest = PairMeshPermissionRequestSchema.parse({
    permissionRequestId: PermissionRequestIdSchema.parse(`perm_${randomUUID()}`),
    participantId: input.participantId,
    capabilityId: "repository.inspect",
    correlationRequestId: input.correlationRequestId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    status: "pending",
    createdAt: nowIso(now),
    expiresAt: nowIso(new Date(now.getTime() + PAIRMESH_PERMISSION_REQUEST_TTL_MS))
  });

  nextState = {
    ...nextState,
    permissionRequests: [...(nextState.permissionRequests ?? []), permissionRequest]
  };

  return {
    state: nextState,
    outcome: { status: "approval_required", permissionRequest, created: true }
  };
}

export function mayIncludeSourceReferences(
  state: LocalSessionState,
  participantId: string
): boolean {
  return getGrantPolicy(state, participantId, "repository.source_references") === "allow_session";
}

export function decidePermissionRequest(
  state: LocalSessionState,
  permissionRequestId: string,
  decision: PermissionDecisionValue,
  now: Date = new Date()
): { state: LocalSessionState; request: PairMeshPermissionRequest } {
  const requests = expirePermissionRequests(state.permissionRequests ?? [], now);
  const current = requests.find((entry) => entry.permissionRequestId === permissionRequestId);
  if (!current) {
    throw createPairMeshError({
      code: "pairmesh.permission_request_not_found",
      message: "Permission request not found."
    });
  }
  if (current.status === "expired") {
    throw createPairMeshError({
      code: "pairmesh.permission_request_expired",
      message: "Permission request has expired."
    });
  }
  if (current.status !== "pending") {
    throw createPairMeshError({
      code: "pairmesh.session_invalid_state",
      message: `Permission request is already ${current.status}.`
    });
  }

  if (current.capabilityId === "repository.edit" && decision === "allow-session") {
    throw createPairMeshError({
      code: "pairmesh.capability_not_allowed",
      message: "repository.edit approvals cannot use allow-session in the current Aroko release.",
      details: { capabilityId: current.capabilityId, decision }
    });
  }
  if (current.capabilityId === "process.execute" && decision === "allow-session") {
    throw createPairMeshError({
      code: "pairmesh.capability_not_allowed",
      message: "process.execute approvals cannot use allow-session in R4 V1.",
      details: { capabilityId: current.capabilityId, decision }
    });
  }

  let nextState: LocalSessionState = {
    ...state,
    permissionRequests: requests.map((entry) =>
      entry.permissionRequestId === permissionRequestId
        ? {
            ...entry,
            status: decision === "deny" ? ("denied" as const) : ("approved" as const),
            decision,
            decidedAt: nowIso(now),
            auditedEvents: [
              ...new Set([
                ...(entry.auditedEvents ?? []),
                ...(decision === "deny" ? (["denied"] as const) : (["allowed"] as const))
              ])
            ]
          }
        : entry
    )
  };

  if (decision === "allow-session") {
    nextState = setGrantPolicy(
      nextState,
      current.participantId,
      current.capabilityId,
      "allow_session",
      now
    );
  }

  const updated = (nextState.permissionRequests ?? []).find(
    (entry) => entry.permissionRequestId === permissionRequestId
  )!;
  return { state: nextState, request: updated };
}

export function listGrantsForPeer(
  state: LocalSessionState,
  participantId: string
): ParticipantCapabilityGrant[] {
  const security = state.sessionSecurity;
  if (!security) {
    return [];
  }
  const grants = (security.capabilityGrants ?? []).filter(
    (grant) => grant.participantId === participantId
  );
  if (grants.length > 0) {
    return grants;
  }
  return defaultCapabilityGrantsForParticipant(participantId as PeerId);
}

export function listPendingPermissionRequests(
  state: LocalSessionState,
  now: Date = new Date()
): PairMeshPermissionRequest[] {
  return expirePermissionRequests(state.permissionRequests ?? [], now).filter(
    (request) => request.status === "pending"
  );
}

export function isV1Capability(value: string): value is PairMeshV1CapabilityId {
  return (PAIRMESH_V1_CAPABILITIES as readonly string[]).includes(value);
}

export function isGrantableCapability(value: string): value is PairMeshGrantableCapabilityId {
  return (PAIRMESH_GRANTABLE_CAPABILITIES as readonly string[]).includes(value);
}

export function isActionCapability(value: string): value is PairMeshActionCapabilityId {
  return (PAIRMESH_ACTION_CAPABILITIES as readonly string[]).includes(value);
}
