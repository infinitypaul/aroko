import * as z from "zod";

const UUID_V4_OR_V7_FRAGMENT =
  "[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function prefixedIdSchema<const Prefix extends string, const BrandName extends string>(
  prefix: Prefix
) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${UUID_V4_OR_V7_FRAGMENT}$`), {
      message: `Expected ${prefix}_<uuid-v4-or-v7>.`
    })
    .brand<BrandName>();
}

export const DeveloperIdSchema = prefixedIdSchema<"dev", "DeveloperId">("dev");
export type DeveloperId = z.infer<typeof DeveloperIdSchema>;

export const AgentIdSchema = prefixedIdSchema<"agt", "AgentId">("agt");
export type AgentId = z.infer<typeof AgentIdSchema>;

export const SessionIdSchema = prefixedIdSchema<"ses", "SessionId">("ses");
export type SessionId = z.infer<typeof SessionIdSchema>;

export const PeerIdSchema = prefixedIdSchema<"peer", "PeerId">("peer");
export type PeerId = z.infer<typeof PeerIdSchema>;

export const DeviceIdSchema = prefixedIdSchema<"devc", "DeviceId">("devc");
export type DeviceId = z.infer<typeof DeviceIdSchema>;

export const ProjectIdSchema = prefixedIdSchema<"prj", "ProjectId">("prj");
export type ProjectId = z.infer<typeof ProjectIdSchema>;

export const PermissionRequestIdSchema = prefixedIdSchema<"perm", "PermissionRequestId">("perm");
export type PermissionRequestId = z.infer<typeof PermissionRequestIdSchema>;

export const InspectionThreadIdSchema = prefixedIdSchema<"thr", "InspectionThreadId">("thr");
export type InspectionThreadId = z.infer<typeof InspectionThreadIdSchema>;

export const InspectionTurnIdSchema = prefixedIdSchema<"trn", "InspectionTurnId">("trn");
export type InspectionTurnId = z.infer<typeof InspectionTurnIdSchema>;

export const InvitationIdSchema = prefixedIdSchema<"inv", "InvitationId">("inv");
export type InvitationId = z.infer<typeof InvitationIdSchema>;

export const CredentialIdSchema = prefixedIdSchema<"cred", "CredentialId">("cred");
export type CredentialId = z.infer<typeof CredentialIdSchema>;

export const AuditEventIdSchema = prefixedIdSchema<"aud", "AuditEventId">("aud");
export type AuditEventId = z.infer<typeof AuditEventIdSchema>;

export const ActionIdSchema = prefixedIdSchema<"act", "ActionId">("act");
export type ActionId = z.infer<typeof ActionIdSchema>;

export const ArtifactIdSchema = prefixedIdSchema<"art", "ArtifactId">("art");
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const CollaborativeTaskIdSchema = prefixedIdSchema<"task", "CollaborativeTaskId">("task");
export type CollaborativeTaskId = z.infer<typeof CollaborativeTaskIdSchema>;

export const InputRequestIdSchema = prefixedIdSchema<"inq", "InputRequestId">("inq");
export type InputRequestId = z.infer<typeof InputRequestIdSchema>;

export const ProviderTurnIdSchema = prefixedIdSchema<"pturn", "ProviderTurnId">("pturn");
export type ProviderTurnId = z.infer<typeof ProviderTurnIdSchema>;

/** Idempotency key for CollaborativeTask event application (R5). */
export const CollaborativeTaskEventIdSchema = prefixedIdSchema<"tevt", "CollaborativeTaskEventId">(
  "tevt"
);
export type CollaborativeTaskEventId = z.infer<typeof CollaborativeTaskEventIdSchema>;
