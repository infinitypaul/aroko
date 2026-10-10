import * as z from "zod";
import { A2ATaskReferenceSchema } from "./a2a-references.js";
import { IsoUtcTimestampSchema } from "./common.js";
import { InspectionThreadIdSchema } from "./ids.js";
import { ProgressEventSchema, MAX_PROGRESS_EVENTS } from "./progress-event.js";
import { PairMeshSourceReferenceSchema } from "./source-reference.js";

export const InspectionExecutionStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled"
]);
export type InspectionExecutionStatus = z.infer<typeof InspectionExecutionStatusSchema>;

export const InspectionProgressPhaseSchema = z.enum([
  "accepted",
  "peer-reachable",
  "coding-agent-starting",
  "inspecting",
  "completed",
  "failed",
  "timed_out",
  "cancelled"
]);
export type InspectionProgressPhase = z.infer<typeof InspectionProgressPhaseSchema>;

export const InspectionProgressEventSchema = z
  .strictObject({
    phase: InspectionProgressPhaseSchema,
    message: z.string().trim().min(1).max(500).optional(),
    elapsedMs: z.number().int().nonnegative().optional()
  })
  .describe("High-level PairMesh inspection progress — no chain-of-thought or raw ACP payloads.");
export type InspectionProgressEvent = z.infer<typeof InspectionProgressEventSchema>;

/** PairMesh-local MCP/client wait state — not equivalent to remote A2A task state. */
export const InspectionLocalWaitStateSchema = z.enum(["waiting", "expired"]);
export type InspectionLocalWaitState = z.infer<typeof InspectionLocalWaitStateSchema>;

/** Normalized A2A task state retained for status queries (official semantics, not redefined). */
export const InspectionRemoteTaskStateSchema = z.enum([
  "submitted",
  "working",
  "completed",
  "failed",
  "canceled",
  "rejected",
  "input_required",
  "auth_required",
  "unknown"
]);
export type InspectionRemoteTaskState = z.infer<typeof InspectionRemoteTaskStateSchema>;

export const InspectionExecutionResultSchema = z.strictObject({
  summary: z.string().trim().min(1).max(8000),
  findings: z.array(z.string().trim().min(1).max(2000)),
  references: z.array(PairMeshSourceReferenceSchema).optional()
});
export type InspectionExecutionResult = z.infer<typeof InspectionExecutionResultSchema>;

export const InspectionExecutionRecordSchema = z
  .strictObject({
    requestId: z.string().trim().min(1).max(80),
    threadId: InspectionThreadIdSchema,
    peerId: z.string().trim().min(1).max(80),
    peerName: z.string().trim().min(1).max(80),
    turnNumber: z.number().int().positive(),
    question: z.string().trim().min(1).max(4000),
    status: InspectionExecutionStatusSchema,
    phase: InspectionProgressPhaseSchema.optional(),
    message: z.string().trim().min(1).max(500).optional(),
    /** When the inspection request was first accepted (may include permission wait). */
    startedAt: IsoUtcTimestampSchema,
    /**
     * When remote inspection/ACP execution actually began. Hard deadline
     * (`PAIRMESH_INSPECTION_MAX_DURATION_MS`) is measured from this clock, not
     * from `startedAt`, so human approval wait does not consume ACP budget.
     */
    executionStartedAt: IsoUtcTimestampSchema.optional(),
    updatedAt: IsoUtcTimestampSchema,
    completedAt: IsoUtcTimestampSchema.optional(),
    retryOfRequestId: z.string().trim().min(1).max(80).optional(),
    a2aTaskReference: A2ATaskReferenceSchema.optional(),
    peerAgentUrl: z.url().optional(),
    localWaitState: InspectionLocalWaitStateSchema.optional(),
    remoteTaskState: InspectionRemoteTaskStateSchema.optional(),
    result: InspectionExecutionResultSchema.optional(),
    error: z
      .strictObject({
        code: z.string().trim().min(1).max(80),
        message: z.string().trim().min(1).max(500)
      })
      .optional(),
        progressEvents: z.array(ProgressEventSchema).max(MAX_PROGRESS_EVENTS).optional(),
    /**
     * Which side owns this local execution row for Control listing.
     * Receiver-created inspect rows use `"receiver"` so Kelvin watch can discover them.
     */
    ownerRole: z.enum(["initiator", "receiver"]).optional(),
        executionProviderId: z.string().trim().min(1).max(80).optional(),
    executionProviderDisplayName: z.string().trim().min(1).max(120).optional()
  })
  .describe("PairMesh-owned inspection turn execution state — separate from thread lifecycle.");
export type InspectionExecutionRecord = z.infer<typeof InspectionExecutionRecordSchema>;
