import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import {
  AuditEventIdSchema,
  InvitationIdSchema,
  InspectionThreadIdSchema,
  ProjectIdSchema,
  SessionIdSchema
} from "./ids.js";
import { SessionCodeSchema } from "./session-code.js";

/** Envelope version for PairMesh audit events (not A2A / metadata version). */
export const PAIRMESH_AUDIT_VERSION = "1" as const;

export const AuditDirectionSchema = z.enum(["outbound", "inbound"]);
export type AuditDirection = z.infer<typeof AuditDirectionSchema>;

export const AuditAuthFailureReasonSchema = z.enum([
  "missing_credential",
  "unknown_bearer",
  "revoked_credential",
  "session_mismatch",
  "other"
]);
export type AuditAuthFailureReason = z.infer<typeof AuditAuthFailureReasonSchema>;

export const AuditEventTypeSchema = z.enum([
  "session.created",
  "invite.created",
  "invite.redeemed",
  "invite.revoked",
  "peer.joined",
  "peer.removed",
  "session.left",
  "authentication.failed",
  "inspection.requested",
  "inspection.started",
  "inspection.completed",
  "inspection.failed",
  "inspection.cancelled",
  "inspection.timed_out",
  "inspection.result_shared",
  "permission.requested",
  "permission.allowed",
  "permission.denied",
  "capability.granted",
  "capability.revoked",
  "action.requested",
  "action.authorization_required",
  "action.approved",
  "action.denied",
  "action.execution_started",
  "action.completed",
  "action.failed",
  "action.cancelled",
  "action.unknown_outcome",
  "artifact.created"
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

/** Participant/agent labels only — never credentials or absolute paths. */
export const AuditPartySchema = z
  .object({
    participantId: z
      .string()
      .regex(/^peer_[0-9a-f-]{36}$/i)
      .optional(),
    agentId: z
      .string()
      .regex(/^agt_[0-9a-f-]{36}$/i)
      .optional(),
    peerName: z.string().trim().min(1).max(120).optional()
  })
  .strict();
export type AuditParty = z.infer<typeof AuditPartySchema>;

export const AuditCorrelationSchema = z
  .object({
    requestId: z.string().trim().min(1).max(120).optional(),
    threadId: InspectionThreadIdSchema.optional()
  })
  .strict();
export type AuditCorrelation = z.infer<typeof AuditCorrelationSchema>;

const AuditEnvelopeBaseSchema = z.object({
  version: z.literal(PAIRMESH_AUDIT_VERSION),
  eventId: AuditEventIdSchema,
  timestamp: IsoUtcTimestampSchema,
  projectId: ProjectIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
  sessionCode: SessionCodeSchema.optional(),
  actor: AuditPartySchema.optional(),
  target: AuditPartySchema.optional(),
  correlation: AuditCorrelationSchema.optional()
});

/** Allow-listed reference metadata — repo-relative paths only, no snippets. */
export const AuditReferencedFileSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !value.includes("\0"), { message: "Null bytes are not allowed." })
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value), {
    message: "Absolute paths are not allowed in audit references."
  })
  .refine((value) => !value.split(/[\\/]/).includes(".."), {
    message: "Path traversal is not allowed in audit references."
  });

export const InspectionResultSharedMetadataSchema = z
  .object({
    direction: AuditDirectionSchema,
    summaryPresent: z.boolean(),
    findingCount: z.number().int().min(0).max(10_000),
    referenceCount: z.number().int().min(0).max(50),
    referencedFiles: z.array(AuditReferencedFileSchema).max(50),
    referencedSymbols: z.array(z.string().trim().min(1).max(200)).max(50).optional()
  })
  .strict();

export const AuthenticationFailedMetadataSchema = z
  .object({
    reason: AuditAuthFailureReasonSchema,
    skill: z.string().trim().min(1).max(80).optional()
  })
  .strict();

export const InspectionLifecycleMetadataSchema = z
  .object({
    direction: AuditDirectionSchema,
    durationMs: z.number().int().min(0).optional(),
    errorCode: z.string().trim().min(1).max(120).optional()
  })
  .strict();

export const InviteAuditMetadataSchema = z
  .object({
    invitationId: InvitationIdSchema.optional()
  })
  .strict();

export const PeerAuditMetadataSchema = z
  .object({
    peerName: z.string().trim().min(1).max(120).optional(),
    revokedCredentials: z.number().int().min(0).optional()
  })
  .strict();

export const PermissionAuditMetadataSchema = z
  .object({
    capabilityId: z.string().trim().min(1).max(80),
    permissionRequestId: z.string().trim().min(1).max(80).optional(),
    decision: z.enum(["allow-once", "allow-session", "deny"]).optional(),
    scope: z.enum(["once", "session"]).optional(),
    policy: z.enum(["allow_session", "approval_required", "deny"]).optional()
  })
  .strict();

export const ActionAuditMetadataSchema = z
  .object({
    actionId: z.string().trim().min(1).max(80),
    actionType: z.string().trim().min(1).max(120).optional(),
    capabilityId: z.string().trim().min(1).max(80).optional(),
    requesterParticipantId: z.string().trim().min(1).max(80).optional(),
    targetParticipantId: z.string().trim().min(1).max(80).optional(),
    status: z.string().trim().min(1).max(40).optional(),
    artifactId: z.string().trim().min(1).max(80).optional(),
    artifactHash: z.string().trim().min(1).max(128).optional(),
    permissionRequestId: z.string().trim().min(1).max(80).optional()
  })
  .strict();
export type ActionAuditMetadata = z.infer<typeof ActionAuditMetadataSchema>;

const emptyMetadata = z.object({}).strict();

function eventSchema<T extends z.ZodTypeAny>(eventType: AuditEventType, metadata: T) {
  return AuditEnvelopeBaseSchema.extend({
    eventType: z.literal(eventType),
    metadata
  }).strict();
}

export const PairMeshAuditEventSchema = z.discriminatedUnion("eventType", [
  eventSchema("session.created", emptyMetadata),
  eventSchema("invite.created", InviteAuditMetadataSchema),
  eventSchema("invite.redeemed", InviteAuditMetadataSchema),
  eventSchema("invite.revoked", InviteAuditMetadataSchema),
  eventSchema("peer.joined", PeerAuditMetadataSchema),
  eventSchema("peer.removed", PeerAuditMetadataSchema),
  eventSchema("session.left", emptyMetadata),
  eventSchema("authentication.failed", AuthenticationFailedMetadataSchema),
  eventSchema("inspection.requested", InspectionLifecycleMetadataSchema),
  eventSchema("inspection.started", InspectionLifecycleMetadataSchema),
  eventSchema("inspection.completed", InspectionLifecycleMetadataSchema),
  eventSchema("inspection.failed", InspectionLifecycleMetadataSchema),
  eventSchema("inspection.cancelled", InspectionLifecycleMetadataSchema),
  eventSchema("inspection.timed_out", InspectionLifecycleMetadataSchema),
  eventSchema("inspection.result_shared", InspectionResultSharedMetadataSchema),
  eventSchema("permission.requested", PermissionAuditMetadataSchema),
  eventSchema("permission.allowed", PermissionAuditMetadataSchema),
  eventSchema("permission.denied", PermissionAuditMetadataSchema),
  eventSchema("capability.granted", PermissionAuditMetadataSchema),
  eventSchema("capability.revoked", PermissionAuditMetadataSchema),
  eventSchema("action.requested", ActionAuditMetadataSchema),
  eventSchema("action.authorization_required", ActionAuditMetadataSchema),
  eventSchema("action.approved", ActionAuditMetadataSchema),
  eventSchema("action.denied", ActionAuditMetadataSchema),
  eventSchema("action.execution_started", ActionAuditMetadataSchema),
  eventSchema("action.completed", ActionAuditMetadataSchema),
  eventSchema("action.failed", ActionAuditMetadataSchema),
  eventSchema("action.cancelled", ActionAuditMetadataSchema),
  eventSchema("action.unknown_outcome", ActionAuditMetadataSchema),
  eventSchema("artifact.created", ActionAuditMetadataSchema)
]);

export type PairMeshAuditEvent = z.infer<typeof PairMeshAuditEventSchema>;
