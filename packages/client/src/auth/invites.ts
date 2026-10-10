import {
  InvitationIdSchema,
  IsoUtcTimestampSchema,
  PAIRMESH_INVITE_TTL_MS,
  PAIRMESH_MAX_OPEN_INVITES,
  PairMeshInviteRecordSchema,
  createPairMeshError,
  type CapabilityGrantPolicy,
  type PairMeshErrorCode,
  type PairMeshInviteRecord,
  type PairMeshInviteSecret,
  type PairMeshSessionSecurity,
  type PairMeshV1CapabilityId
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { generateInviteSecret, hashSecret, secretHashesEqual } from "./secrets.js";
import { normalizeInviteInitialGrants } from "./capabilities.js";

export interface CreatedInvite {
  record: PairMeshInviteRecord;
  /** Plaintext secret — returned to the creator once, never persisted. */
  secret: PairMeshInviteSecret;
}

export interface CreateInviteOptions {
  ttlMs?: number;
  now?: Date;
  /** Local participant minting this invite (pairwise relationship target on redeem). */
  inviterParticipantId?: string;
    initialGrants?: Array<{
    capabilityId: PairMeshV1CapabilityId | string;
    policy: CapabilityGrantPolicy;
  }>;
}

export function createInvite(options: CreateInviteOptions = {}): CreatedInvite {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? PAIRMESH_INVITE_TTL_MS;
  const secret = generateInviteSecret();
  const initialGrants = options.initialGrants
    ? normalizeInviteInitialGrants(options.initialGrants)
    : undefined;

  const record = PairMeshInviteRecordSchema.parse({
    invitationId: InvitationIdSchema.parse(`inv_${randomUUID()}`),
    secretHash: hashSecret(secret),
    createdAt: IsoUtcTimestampSchema.parse(now.toISOString()),
    expiresAt: IsoUtcTimestampSchema.parse(new Date(now.getTime() + ttlMs).toISOString()),
    ...(options.inviterParticipantId ? { inviterParticipantId: options.inviterParticipantId } : {}),
    ...(initialGrants ? { initialGrants } : {})
  });

  return { record, secret };
}

export type InviteValidation =
  | { ok: true; invite: PairMeshInviteRecord }
  | { ok: false; code: PairMeshErrorCode; message: string };

/**
 * Validates a presented invite secret against stored hashes in constant time.
 * All candidates are compared so a caller cannot learn which invite matched
 * from response timing alone.
 */
export function validateInviteSecret(
  security: PairMeshSessionSecurity,
  presentedSecret: string,
  now: Date = new Date()
): InviteValidation {
  const presentedHash = hashSecret(presentedSecret);
  let matched: PairMeshInviteRecord | undefined;

  for (const invite of security.invites) {
    if (secretHashesEqual(presentedHash, invite.secretHash)) {
      matched = invite;
    }
  }

  if (!matched) {
    return {
      ok: false,
      code: "pairmesh.invite_invalid",
      message: "Invite secret is not valid for this PairMesh session."
    };
  }

  if (matched.revokedAt) {
    return {
      ok: false,
      code: "pairmesh.invite_invalid",
      message: "Invite has been revoked. Ask for a fresh invite."
    };
  }

  if (matched.usedAt) {
    return {
      ok: false,
      code: "pairmesh.invite_used",
      message: "Invite has already been used. Invites are single-use — ask for a fresh invite."
    };
  }

  if (Date.parse(matched.expiresAt) <= now.getTime()) {
    return {
      ok: false,
      code: "pairmesh.invite_expired",
      message: "Invite has expired. Ask for a fresh invite."
    };
  }

  return { ok: true, invite: matched };
}

export function markInviteUsed(
  security: PairMeshSessionSecurity,
  invitationId: string,
  now: Date = new Date()
): PairMeshSessionSecurity {
  return {
    ...security,
    invites: security.invites.map((invite) =>
      invite.invitationId === invitationId
        ? { ...invite, usedAt: IsoUtcTimestampSchema.parse(now.toISOString()) }
        : invite
    )
  };
}

export function revokeOpenInvites(
  security: PairMeshSessionSecurity,
  now: Date = new Date()
): PairMeshSessionSecurity {
  const revokedAt = IsoUtcTimestampSchema.parse(now.toISOString());
  return {
    ...security,
    invites: security.invites.map((invite) =>
      invite.usedAt || invite.revokedAt ? invite : { ...invite, revokedAt }
    )
  };
}

export function revokeInviteById(
  security: PairMeshSessionSecurity,
  invitationId: string,
  now: Date = new Date()
): PairMeshSessionSecurity {
  const revokedAt = IsoUtcTimestampSchema.parse(now.toISOString());
  let found = false;
  const invites = security.invites.map((invite) => {
    if (invite.invitationId !== invitationId) {
      return invite;
    }
    found = true;
    if (invite.usedAt || invite.revokedAt) {
      return invite;
    }
    return { ...invite, revokedAt };
  });
  if (!found) {
    throw createPairMeshError({
      code: "pairmesh.invite_invalid",
      message: "Invite was not found in local collaboration state.",
      details: { invitationId }
    });
  }
  return { ...security, invites };
}

export function countOpenInvites(
  security: PairMeshSessionSecurity,
  now: Date = new Date()
): number {
  return security.invites.filter((invite) => isInviteRedeemable(invite, now)).length;
}

export function assertCanMintOpenInvite(
  security: PairMeshSessionSecurity,
  now: Date = new Date()
): void {
  if (countOpenInvites(security, now) >= PAIRMESH_MAX_OPEN_INVITES) {
    throw createPairMeshError({
      code: "pairmesh.session_invalid_state",
      message: `Too many open invites (max ${PAIRMESH_MAX_OPEN_INVITES}). Revoke or wait for expiry before minting another.`,
      details: { maxOpenInvites: PAIRMESH_MAX_OPEN_INVITES }
    });
  }
}

export function isInviteRedeemable(invite: PairMeshInviteRecord, now: Date = new Date()): boolean {
  return (
    invite.revokedAt === undefined &&
    invite.usedAt === undefined &&
    Date.parse(invite.expiresAt) > now.getTime()
  );
}
