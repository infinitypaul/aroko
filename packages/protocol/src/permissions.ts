import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import { PeerIdSchema, PermissionRequestIdSchema } from "./ids.js";

/**
 * Namespace-qualified capability ids. V1 implements only repository.inspect and
 * repository.source_references; other strings may parse but must not be granted
 * by the default registry.
 */
export const CapabilityIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+$/, {
    message: "Capability ID must be namespace-qualified (for example repository.inspect)."
  });
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const PAIRMESH_V1_CAPABILITIES = [
  "repository.inspect",
  "repository.source_references"
] as const;
export type PairMeshV1CapabilityId = (typeof PAIRMESH_V1_CAPABILITIES)[number];

export const PairMeshV1CapabilityIdSchema = z.enum(PAIRMESH_V1_CAPABILITIES);

export const PAIRMESH_ACTION_CAPABILITIES = [
  "change.propose",
  "repository.edit",
  "tests.run",
  "process.execute"
] as const;
export type PairMeshActionCapabilityId = (typeof PAIRMESH_ACTION_CAPABILITIES)[number];
export const PairMeshActionCapabilityIdSchema = z.enum(PAIRMESH_ACTION_CAPABILITIES);

/** Capabilities that may appear in grants / permission requests. */
export const PAIRMESH_GRANTABLE_CAPABILITIES = [
  ...PAIRMESH_V1_CAPABILITIES,
  ...PAIRMESH_ACTION_CAPABILITIES
] as const;
export type PairMeshGrantableCapabilityId = (typeof PAIRMESH_GRANTABLE_CAPABILITIES)[number];
export const PairMeshGrantableCapabilityIdSchema = z.enum(PAIRMESH_GRANTABLE_CAPABILITIES);

export const PAIRMESH_FUTURE_CAPABILITIES = [
  "repository.source_snippets",
  "repository.read_file",
  "repository.run_tests",
  "shell.execute",
  "repository.write",
  "repository.git"
] as const;

/** @deprecated Prefer PAIRMESH_V1_CAPABILITIES — kept for older tests/docs. */
export const DEFAULT_PAIRMESH_CAPABILITIES = PAIRMESH_V1_CAPABILITIES;

export const CapabilityRiskSchema = z.enum(["metadata", "read_only", "write", "destructive"]);
export type CapabilityRisk = z.infer<typeof CapabilityRiskSchema>;

/** Persistent per-participant policy for a capability (not a one-shot decision). */
export const CapabilityGrantPolicySchema = z.enum(["allow_session", "approval_required", "deny"]);
export type CapabilityGrantPolicy = z.infer<typeof CapabilityGrantPolicySchema>;

export const CapabilityDefinitionSchema = z
  .strictObject({
    id: PairMeshGrantableCapabilityIdSchema,
    risk: CapabilityRiskSchema,
    description: z.string().trim().min(1).max(240),
    defaultPolicy: CapabilityGrantPolicySchema
  })
  .describe("Authoritative capability registry entry.");
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;

export const PAIRMESH_CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = [
  {
    id: "repository.inspect",
    risk: "read_only",
    description: "Ask the local coding agent to inspect the repository.",
    defaultPolicy: "allow_session"
  },
  {
    id: "repository.source_references",
    risk: "metadata",
    description: "Return sanitized repository-relative source references.",
    defaultPolicy: "allow_session"
  },
  {
    id: "change.propose",
    risk: "read_only",
    description: "Request a non-mutating change proposal artifact (no working-tree write).",
    defaultPolicy: "deny"
  },
  {
    id: "repository.edit",
    risk: "write",
    description: "Apply an approved immutable artifact to the repository (allow-once only in V1).",
    defaultPolicy: "deny"
  },
  {
    id: "tests.run",
    risk: "write",
    description: "Run a receiver-defined named test profile (no remote command strings).",
    defaultPolicy: "deny"
  },
  {
    id: "process.execute",
    risk: "destructive",
    description:
      "Run an approved structured process (executable + argv; shell:false; allow-once only).",
    defaultPolicy: "deny"
  }
] as const;

/** Human approval / decision values (hyphenated — existing PermissionDecision wire form). */
export const PermissionDecisionValueSchema = z.enum(["allow-once", "allow-session", "deny"]);
export type PermissionDecisionValue = z.infer<typeof PermissionDecisionValueSchema>;

export const PermissionDecisionSchema = z.strictObject({
  requestId: PermissionRequestIdSchema,
  capability: CapabilityIdSchema,
  decision: PermissionDecisionValueSchema,
  decidedAt: IsoUtcTimestampSchema
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed"
]);
export type PermissionRequestStatus = z.infer<typeof PermissionRequestStatusSchema>;

/** Pending/resolved human approval for one capability + inspection request. */
export const PairMeshPermissionRequestSchema = z
  .strictObject({
    permissionRequestId: PermissionRequestIdSchema,
    participantId: PeerIdSchema,
    capabilityId: PairMeshGrantableCapabilityIdSchema,
    /** Inspection requestId this approval is bound to (required for allow-once). */
    correlationRequestId: z.string().trim().min(1).max(120),
    threadId: z.string().trim().min(1).max(120).optional(),
    status: PermissionRequestStatusSchema,
    decision: PermissionDecisionValueSchema.optional(),
    createdAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
    decidedAt: IsoUtcTimestampSchema.optional(),
    consumedAt: IsoUtcTimestampSchema.optional(),
    /** Idempotent audit markers — one semantic transition → one local audit event. */
    auditedEvents: z
      .array(z.enum(["requested", "allowed", "denied"]))
      .max(5)
      .optional()
  })
  .describe("Local permission request. Never stores questions, answers, or secrets.");
export type PairMeshPermissionRequest = z.infer<typeof PairMeshPermissionRequestSchema>;

export const ParticipantCapabilityGrantSchema = z
  .strictObject({
    participantId: PeerIdSchema,
    capabilityId: PairMeshGrantableCapabilityIdSchema,
    policy: CapabilityGrantPolicySchema,
    updatedAt: IsoUtcTimestampSchema
  })
  .describe("Per-participant capability grant for the active session.");
export type ParticipantCapabilityGrant = z.infer<typeof ParticipantCapabilityGrantSchema>;

/** Default TTL for pending human approval requests. */
export const PAIRMESH_PERMISSION_REQUEST_TTL_MS = 10 * 60 * 1000;
