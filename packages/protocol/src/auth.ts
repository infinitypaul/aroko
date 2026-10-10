import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import { CredentialIdSchema, InvitationIdSchema, PeerIdSchema } from "./ids.js";
import {
  CapabilityGrantPolicySchema,
  ParticipantCapabilityGrantSchema,
  PairMeshV1CapabilityIdSchema
} from "./permissions.js";

export const PAIRMESH_SECURITY_VERSION = "v1" as const;
export const PairMeshSecurityVersionSchema = z.literal(PAIRMESH_SECURITY_VERSION);
export type PairMeshSecurityVersion = z.infer<typeof PairMeshSecurityVersionSchema>;

/** Agent Card `securitySchemes` key advertising PairMesh session bearer auth. */
export const PAIRMESH_BEARER_SECURITY_SCHEME = "pairmeshSessionBearer" as const;

/** Bearer format advertised on the Agent Card HTTP security scheme. */
export const PAIRMESH_BEARER_FORMAT = "opaque" as const;

/** Default invite lifetime. Invites are single-use and short-lived by design. */
export const PAIRMESH_INVITE_TTL_MS = 15 * 60 * 1000;

export const PAIRMESH_MAX_COLLABORATION_PARTICIPANTS = 8;

/** Max simultaneously redeemable invites per local collaboration member. */
export const PAIRMESH_MAX_OPEN_INVITES = 8;

/** Raw byte length of generated invite secrets and bearer tokens (256 bits). */
export const PAIRMESH_SECRET_BYTE_LENGTH = 32;

/**
 * base64url-encoded CSPRNG material. 43 characters is the unpadded encoding of
 * 32 bytes, so anything shorter cannot carry the required entropy.
 */
const OPAQUE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,171}$/;

export const PairMeshInviteSecretSchema = z
  .string()
  .regex(OPAQUE_SECRET_PATTERN, {
    message: "Invite secret must be base64url-encoded CSPRNG material of at least 256 bits."
  })
  .brand<"PairMeshInviteSecret">()
  .describe("Single-use, high-entropy invite secret required to join a PairMesh session.");
export type PairMeshInviteSecret = z.infer<typeof PairMeshInviteSecretSchema>;

export const PairMeshBearerTokenSchema = z
  .string()
  .regex(OPAQUE_SECRET_PATTERN, {
    message: "Bearer token must be base64url-encoded CSPRNG material of at least 256 bits."
  })
  .brand<"PairMeshBearerToken">()
  .describe("Opaque per-participant PairMesh session bearer token.");
export type PairMeshBearerToken = z.infer<typeof PairMeshBearerTokenSchema>;

export const PairMeshSecretHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: "Secret hash must be a lowercase SHA-256 hex digest." })
  .brand<"PairMeshSecretHash">()
  .describe("SHA-256 hex digest of a secret. Only hashes are persisted.");
export type PairMeshSecretHash = z.infer<typeof PairMeshSecretHashSchema>;

export const PairMeshInviteInitialGrantSchema = z
  .strictObject({
    capabilityId: PairMeshV1CapabilityIdSchema,
    policy: CapabilityGrantPolicySchema
  })
  .describe(
    "Inviter-selected initial policy for one V1 capability. Applied receiver-side on redeem."
  );
export type PairMeshInviteInitialGrant = z.infer<typeof PairMeshInviteInitialGrantSchema>;

export const PairMeshInviteRecordSchema = z
  .strictObject({
    invitationId: InvitationIdSchema,
    secretHash: PairMeshSecretHashSchema,
    createdAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
    usedAt: IsoUtcTimestampSchema.optional(),
    revokedAt: IsoUtcTimestampSchema.optional(),
        inviterParticipantId: PeerIdSchema.optional(),
    /**
     * Optional inviter-authored grant template. When absent, registry defaults
     * apply. Never accepted from the joining peer's join payload.
     */
    initialGrants: z.array(PairMeshInviteInitialGrantSchema).max(20).optional()
  })
  .describe("Inviter-side invite record. Stores the hash only — never the invite secret.");
export type PairMeshInviteRecord = z.infer<typeof PairMeshInviteRecordSchema>;

export const PairMeshAcceptedInboundCredentialSchema = z
  .strictObject({
    participantId: PeerIdSchema,
    credentialId: CredentialIdSchema,
    tokenHash: PairMeshSecretHashSchema,
    issuedAt: IsoUtcTimestampSchema,
    revokedAt: IsoUtcTimestampSchema.optional()
  })
  .describe("Bearer credential this agent accepts from a specific session participant.");
export type PairMeshAcceptedInboundCredential = z.infer<
  typeof PairMeshAcceptedInboundCredentialSchema
>;

export const PairMeshSessionSecuritySchema = z
  .strictObject({
    securityVersion: PairMeshSecurityVersionSchema,
    invites: z.array(PairMeshInviteRecordSchema).max(50).default([]),
    acceptedInbound: z.array(PairMeshAcceptedInboundCredentialSchema).max(50).default([]),
        capabilityGrants: z.array(ParticipantCapabilityGrantSchema).max(200).default([])
  })
  .describe("Local authorization state for an authenticated PairMesh session.");
export type PairMeshSessionSecurity = z.infer<typeof PairMeshSessionSecuritySchema>;

/** Redacted placeholder used wherever a secret would otherwise be rendered. */
export const PAIRMESH_REDACTED = "[redacted]" as const;
