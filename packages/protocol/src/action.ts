import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import { PairMeshErrorSchema } from "./errors/schema.js";
import {
  ActionIdSchema,
  ArtifactIdSchema,
  CollaborativeTaskIdSchema,
  PeerIdSchema,
  PermissionRequestIdSchema,
  ProviderTurnIdSchema,
  SessionIdSchema
} from "./ids.js";
import { PairMeshGrantableCapabilityIdSchema } from "./permissions.js";
import { MAX_PROGRESS_EVENTS, ProgressEventSchema } from "./progress-event.js";
import { PairMeshMetadataVersionSchema } from "./version.js";

export const PAIRMESH_ACTION_SKILL_ID = "pairmesh.action" as const;

export const ActionMutabilitySchema = z.enum(["none", "proposal", "mutation"]);
export type ActionMutability = z.infer<typeof ActionMutabilitySchema>;

export const ActionExecutionStatusSchema = z.enum([
  "requested",
  "authenticating",
  "authorizing",
  "approval_required",
  "approved",
  "executing",
  "completed",
  "denied",
  "cancelled",
  "failed",
  "expired",
  "unknown_outcome",
  "partially_completed"
]);
export type ActionExecutionStatus = z.infer<typeof ActionExecutionStatusSchema>;

export const ActionArtifactTypeSchema = z.enum([
  "patch_diff",
  "structured_result",
  "test_fixture",
  "process_execution"
]);
export type ActionArtifactType = z.infer<typeof ActionArtifactTypeSchema>;

export const ActionParametersSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]))
  .default({});
export type ActionParameters = z.infer<typeof ActionParametersSchema>;

export const ActionArtifactRefSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifactType: ActionArtifactTypeSchema
});
export type ActionArtifactRef = z.infer<typeof ActionArtifactRefSchema>;

export const ActionApprovalBindingSchema = z.strictObject({
  requesterParticipantId: PeerIdSchema,
  targetParticipantId: PeerIdSchema,
  actionId: ActionIdSchema,
  capabilityId: PairMeshGrantableCapabilityIdSchema,
  actionType: z.string().trim().min(1).max(120),
  parameterDigest: z.string().regex(/^[a-f0-9]{64}$/),
  artifactId: ArtifactIdSchema.optional(),
  artifactContentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  normalizedTargetPaths: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
  expiresAt: IsoUtcTimestampSchema
});
export type ActionApprovalBinding = z.infer<typeof ActionApprovalBindingSchema>;

export const ActionRequestSchema = z.strictObject({
  actionId: ActionIdSchema,
  requesterParticipantId: PeerIdSchema,
  targetParticipantId: PeerIdSchema,
  capabilityId: PairMeshGrantableCapabilityIdSchema,
  actionType: z.string().trim().min(1).max(120),
  parameters: ActionParametersSchema,
  createdAt: IsoUtcTimestampSchema,
  artifactRef: ActionArtifactRefSchema.optional(),
  threadId: z.string().trim().min(1).max(120).optional(),
  correlationRequestId: z.string().trim().min(1).max(120).optional()
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionResultSchema = z.strictObject({
  actionId: ActionIdSchema,
  status: ActionExecutionStatusSchema,
  summary: z.string().trim().min(1).max(2000).optional(),
  artifactRefs: z.array(ActionArtifactRefSchema).max(20).optional(),
  startedAt: IsoUtcTimestampSchema.optional(),
  completedAt: IsoUtcTimestampSchema.optional(),
  outputs: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  error: z
    .strictObject({
      code: z.string().trim().min(1).max(80),
      message: z.string().trim().min(1).max(500)
    })
    .optional(),
  partial: z.boolean().optional(),
  unknownOutcome: z.boolean().optional(),
  executorInvocationCount: z.number().int().nonnegative().optional()
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const ActionArtifactRecordSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  actionId: ActionIdSchema,
  artifactType: ActionArtifactTypeSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().nonnegative(),
  createdAt: IsoUtcTimestampSchema,
  finalizedAt: IsoUtcTimestampSchema.optional(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  storageKey: z.string().trim().min(1).max(500)
});
export type ActionArtifactRecord = z.infer<typeof ActionArtifactRecordSchema>;

export const ActionExecutionRecordSchema = z.strictObject({
  actionId: ActionIdSchema,
  requesterParticipantId: PeerIdSchema,
  targetParticipantId: PeerIdSchema,
  actionType: z.string().trim().min(1).max(120),
  capabilityId: PairMeshGrantableCapabilityIdSchema,
  status: ActionExecutionStatusSchema,
  parameters: ActionParametersSchema,
  parameterDigest: z.string().regex(/^[a-f0-9]{64}$/),
  mutability: ActionMutabilitySchema,
  createdAt: IsoUtcTimestampSchema,
  updatedAt: IsoUtcTimestampSchema,
  authorizedAt: IsoUtcTimestampSchema.optional(),
  approvedAt: IsoUtcTimestampSchema.optional(),
  executionStartedAt: IsoUtcTimestampSchema.optional(),
  completedAt: IsoUtcTimestampSchema.optional(),
  approvalBinding: ActionApprovalBindingSchema.optional(),
  permissionRequestId: PermissionRequestIdSchema.optional(),
  artifactRefs: z.array(ActionArtifactRefSchema).max(20).optional(),
  result: ActionResultSchema.optional(),
  error: z
    .strictObject({
      code: z.string().trim().min(1).max(80),
      message: z.string().trim().min(1).max(500)
    })
    .optional(),
  executorInvocationCount: z.number().int().nonnegative().default(0),
  auditedEvents: z
    .array(
      z.enum([
        "requested",
        "authorization_required",
        "approved",
        "denied",
        "execution_started",
        "completed",
        "failed",
        "cancelled",
        "unknown_outcome",
        "partially_completed"
      ])
    )
    .max(20)
    .optional(),
  cancelRequested: z.boolean().optional(),
    progressEvents: z.array(ProgressEventSchema).max(MAX_PROGRESS_EVENTS).optional(),
    executionProviderId: z.string().trim().min(1).max(80).optional(),
  executionProviderDisplayName: z.string().trim().min(1).max(120).optional(),
  /** R5 — optional CollaborativeTask linkage (absent for pre-R5 Actions). */
  taskId: CollaborativeTaskIdSchema.optional(),
  originProviderTurnId: ProviderTurnIdSchema.optional(),
  /** Stable machine-readable origin, e.g. `receiver_agent_request`. */
  originProvenance: z.string().trim().min(1).max(80).optional()
});
export type ActionExecutionRecord = z.infer<typeof ActionExecutionRecordSchema>;

export const ACTION_STATUS_TRANSITIONS: Readonly<
  Record<ActionExecutionStatus, readonly ActionExecutionStatus[]>
> = {
  requested: ["authenticating", "denied", "cancelled", "failed"],
  authenticating: ["authorizing", "denied", "cancelled", "failed"],
  authorizing: ["approval_required", "approved", "denied", "cancelled", "failed", "expired"],
  approval_required: ["approved", "denied", "cancelled", "expired", "failed"],
  approved: ["executing", "cancelled", "expired", "failed"],
  executing: ["completed", "failed", "cancelled", "unknown_outcome", "partially_completed"],
  completed: [],
  denied: [],
  cancelled: [],
  failed: [],
  expired: [],
  unknown_outcome: [],
  partially_completed: []
};

export function canTransitionActionStatus(
  from: ActionExecutionStatus,
  to: ActionExecutionStatus
): boolean {
  if (from === to) {
    return true;
  }
  return (ACTION_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// A2A wire protocol (pairmesh.action) — thin envelopes over ActionService
// ---------------------------------------------------------------------------

export const PairMeshActionWireOperationSchema = z.enum(["request", "status", "cancel"]);
export type PairMeshActionWireOperation = z.infer<typeof PairMeshActionWireOperationSchema>;

export const PairMeshActionWireRequestSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    sessionId: SessionIdSchema,
    operation: PairMeshActionWireOperationSchema,
    actionId: ActionIdSchema,
    /** Required when operation is `request`. */
    actionType: z.string().trim().min(1).max(120).optional(),
    parameters: ActionParametersSchema.optional(),
    artifactRef: ActionArtifactRefSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (value.operation === "request" && !value.actionType) {
      ctx.addIssue({
        code: "custom",
        message: "actionType is required when operation is request.",
        path: ["actionType"]
      });
    }
  })
  .describe("PairMesh controlled-action request carried over A2A.");
export type PairMeshActionWireRequest = z.infer<typeof PairMeshActionWireRequestSchema>;

export const PairMeshActionWireSuccessResponseSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    accepted: z.literal(true),
    actionId: ActionIdSchema,
    status: ActionExecutionStatusSchema,
    summary: z.string().trim().min(1).max(2000).optional(),
    message: z.string().trim().min(1).max(500).optional(),
    permissionRequestId: PermissionRequestIdSchema.optional(),
    capabilityId: PairMeshGrantableCapabilityIdSchema.optional(),
    actionType: z.string().trim().min(1).max(120).optional(),
    requesterParticipantId: PeerIdSchema.optional(),
    targetParticipantId: PeerIdSchema.optional(),
    createdAt: IsoUtcTimestampSchema.optional(),
    updatedAt: IsoUtcTimestampSchema.optional(),
    executionStartedAt: IsoUtcTimestampSchema.optional(),
    completedAt: IsoUtcTimestampSchema.optional(),
    approvalExpiresAt: IsoUtcTimestampSchema.optional(),
    artifactRefs: z.array(ActionArtifactRefSchema).max(20).optional(),
    /** SAFE result outputs only — never executableAbsolute, env, or control tokens. */
    outputs: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
    error: z
      .strictObject({
        code: z.string().trim().min(1).max(80),
        message: z.string().trim().min(1).max(500)
      })
      .optional(),
    executorInvocationCount: z.number().int().nonnegative().optional()
  })
  .describe("Successful PairMesh controlled-action wire response.");
export type PairMeshActionWireSuccessResponse = z.infer<
  typeof PairMeshActionWireSuccessResponseSchema
>;

export const PairMeshActionWireFailureResponseSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    accepted: z.literal(false),
    actionId: ActionIdSchema,
    error: PairMeshErrorSchema
  })
  .describe("Rejected PairMesh controlled-action wire response.");
export type PairMeshActionWireFailureResponse = z.infer<
  typeof PairMeshActionWireFailureResponseSchema
>;

export const PairMeshActionWireResponseSchema = z.discriminatedUnion("accepted", [
  PairMeshActionWireSuccessResponseSchema,
  PairMeshActionWireFailureResponseSchema
]);
export type PairMeshActionWireResponse = z.infer<typeof PairMeshActionWireResponseSchema>;

export const PairMeshActionRequestEnvelopeSchema = z.strictObject({
  type: z.literal("pairmesh.action.request"),
  payload: PairMeshActionWireRequestSchema
});

export const PairMeshActionResponseEnvelopeSchema = z.strictObject({
  type: z.literal("pairmesh.action.response"),
  payload: PairMeshActionWireResponseSchema
});
