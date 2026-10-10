import * as z from "zod";
import { PairMeshErrorSchema } from "./errors/schema.js";
import { InspectionThreadIdSchema, SessionIdSchema } from "./ids.js";
import { PairMeshSourceReferenceListSchema } from "./source-reference.js";
import { ProgressEventSchema } from "./progress-event.js";
import { PairMeshMetadataVersionSchema } from "./version.js";

/** A2A Agent Card skill id for PairMesh read-only cross-developer inspection. */
export const PAIRMESH_INSPECT_SKILL_ID = "pairmesh.inspect" as const;

/** Max requester-safe ProgressEvents included in one A2A inspect progress snapshot. */
export const MAX_INSPECT_PROGRESS_WIRE_EVENTS = 32;

export const PairMeshInspectionRequestSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    sessionId: SessionIdSchema,
    threadId: InspectionThreadIdSchema,
    requestId: z.string().trim().min(1).max(80),
    question: z.string().trim().min(1).max(4000),
    turnNumber: z.number().int().min(1).max(1000)
  })
  .describe("PairMesh read-only inspection request carried over A2A.");
export type PairMeshInspectionRequest = z.infer<typeof PairMeshInspectionRequestSchema>;

export const PairMeshInspectionFindingSchema = z.string().trim().min(1).max(2000);
export type PairMeshInspectionFinding = z.infer<typeof PairMeshInspectionFindingSchema>;

export const PairMeshInspectionSuccessResponseSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    accepted: z.literal(true),
    requestId: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(4000),
    findings: z.array(PairMeshInspectionFindingSchema).max(50),
    references: PairMeshSourceReferenceListSchema
  })
  .describe("Successful PairMesh inspection response.");
export type PairMeshInspectionSuccessResponse = z.infer<
  typeof PairMeshInspectionSuccessResponseSchema
>;

export const PairMeshInspectionFailureResponseSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    accepted: z.literal(false),
    requestId: z.string().trim().min(1).max(80),
    error: PairMeshErrorSchema
  })
  .describe("Rejected PairMesh inspection response.");
export type PairMeshInspectionFailureResponse = z.infer<
  typeof PairMeshInspectionFailureResponseSchema
>;

export const PairMeshInspectionResponseSchema = z.discriminatedUnion("accepted", [
  PairMeshInspectionSuccessResponseSchema,
  PairMeshInspectionFailureResponseSchema
]);
export type PairMeshInspectionResponse = z.infer<typeof PairMeshInspectionResponseSchema>;

export const PairMeshInspectProgressPayloadSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    requestId: z.string().trim().min(1).max(80),
    /** Highest receiver sequence included in this snapshot (ordering authority). */
    latestSequence: z.number().int().nonnegative().max(1_000_000_000),
    events: z.array(ProgressEventSchema).max(MAX_INSPECT_PROGRESS_WIRE_EVENTS)
  })
  .describe("Requester-safe inspection progress snapshot for A2A GetTask polling.");
export type PairMeshInspectProgressPayload = z.infer<typeof PairMeshInspectProgressPayloadSchema>;

export const PairMeshInspectionRequestEnvelopeSchema = z.strictObject({
  type: z.literal("pairmesh.inspect.request"),
  payload: PairMeshInspectionRequestSchema
});

export const PairMeshInspectionResponseEnvelopeSchema = z.strictObject({
  type: z.literal("pairmesh.inspect.response"),
  payload: PairMeshInspectionResponseSchema
});

export const PairMeshInspectProgressEnvelopeSchema = z.strictObject({
  type: z.literal("pairmesh.inspect.progress"),
  payload: PairMeshInspectProgressPayloadSchema
});
