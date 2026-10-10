import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import {
  CollaborativeTaskEventIdSchema,
  CollaborativeTaskIdSchema,
  ProviderTurnIdSchema
} from "./ids.js";
import { COLLABORATIVE_TASK_MAX_GOAL_CHARS } from "./collaborative-task.js";
import { PAIRMESH_HOST_REQUEST_TOOLS } from "./host-request.js";

/** Max safe checkpoint / summary characters (not chain-of-thought). */
export const CONTINUATION_MAX_SUMMARY_CHARS = 2_000;

/** Max structured result string fields. */
export const CONTINUATION_MAX_RESULT_FIELD_CHARS = 4_000;

/** Max process output retained in continuation envelopes (R4 already sanitizes). */
export const CONTINUATION_MAX_PROCESS_OUTPUT_CHARS = 4_000;

export const ProviderTurnStatusSchema = z.enum([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled"
]);
export type ProviderTurnStatus = z.infer<typeof ProviderTurnStatusSchema>;

export const PROVIDER_TURN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled"
] as const satisfies readonly ProviderTurnStatus[];

export function isTerminalProviderTurnStatus(status: ProviderTurnStatus): boolean {
  return (PROVIDER_TURN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export const ProviderTurnToolRequestSchema = z.strictObject({
  name: z.enum(PAIRMESH_HOST_REQUEST_TOOLS),
  argsDigest: z.string().regex(/^[a-f0-9]{64}$/)
});
export type ProviderTurnToolRequest = z.infer<typeof ProviderTurnToolRequestSchema>;

/**
 * Receiver-local ProviderTurn record (R5-5).
 * `providerSessionRef` is LOCAL/PRIVATE — never project to requester/wire.
 */
export const ProviderTurnSchema = z.strictObject({
  providerTurnId: ProviderTurnIdSchema,
  taskId: CollaborativeTaskIdSchema,
  status: ProviderTurnStatusSchema,
  startedAt: IsoUtcTimestampSchema,
  endedAt: IsoUtcTimestampSchema.optional(),
  /** Continuation event that reserved this turn (absent for first turn). */
  continuationEventId: CollaborativeTaskEventIdSchema.optional(),
  toolRequest: ProviderTurnToolRequestSchema.optional(),
  /** Local-only opaque provider session handle — never A2A / requester. */
  providerSessionRef: z.string().trim().min(1).max(200).optional(),
  checkpointSummary: z.string().trim().min(1).max(CONTINUATION_MAX_SUMMARY_CHARS).optional(),
  /** Explicit recovery turn after crash with no child created. */
  recoveryOfProviderTurnId: ProviderTurnIdSchema.optional()
});
export type ProviderTurn = z.infer<typeof ProviderTurnSchema>;

export const ContinuationEventTypeSchema = z.enum([
  "REQUESTER_INPUT_RECEIVED",
  "ACTION_COMPLETED",
  "ACTION_DENIED",
  "ACTION_FAILED",
  "ACTION_UNKNOWN_OUTCOME",
  "ACTION_CANCELLED",
  "TASK_RESUMED_AFTER_RESTART",
  "TASK_CANCELLED"
]);
export type ContinuationEventType = z.infer<typeof ContinuationEventTypeSchema>;

/** Bounded structured payload for next provider turn (no authority records). */
export const ContinuationStructuredResultSchema = z
  .record(
    z.string().trim().min(1).max(80),
    z.union([
      z.string().max(CONTINUATION_MAX_RESULT_FIELD_CHARS),
      z.number(),
      z.boolean(),
      z.null()
    ])
  )
  .refine((value) => Object.keys(value).length <= 32, {
    message: "structuredResult may have at most 32 keys."
  });
export type ContinuationStructuredResult = z.infer<typeof ContinuationStructuredResultSchema>;

/**
 * Durable ContinuationEvent (R5-5).
 * `observationKey` fences duplicate external observations.
 * `consumedByProviderTurnId` fences turn reservation (exactly-once dispatch).
 */
export const ContinuationEventSchema = z.strictObject({
  eventId: CollaborativeTaskEventIdSchema,
  taskId: CollaborativeTaskIdSchema,
  type: ContinuationEventTypeSchema,
  sourceRef: z.string().trim().min(1).max(80),
  safeSummary: z.string().trim().min(1).max(CONTINUATION_MAX_SUMMARY_CHARS),
  structuredResult: ContinuationStructuredResultSchema.optional(),
  occurredAt: IsoUtcTimestampSchema,
  continuationSeq: z.number().int().min(0),
  /** Stable observation fence: e.g. input_answer:inq_… / action_terminal:act_…:completed */
  observationKey: z.string().trim().min(1).max(160),
  consumedByProviderTurnId: ProviderTurnIdSchema.optional()
});
export type ContinuationEvent = z.infer<typeof ContinuationEventSchema>;

/** Trust-separated continuation envelope for provider-neutral workers. */
export const SafeContinuationEnvelopeSchema = z.strictObject({
  taskId: CollaborativeTaskIdSchema,
  providerTurnId: ProviderTurnIdSchema,
  continuationSeq: z.number().int().min(0),
  /** UNTRUSTED remote goal text — data only. */
  originalGoal: z.string().min(1).max(COLLABORATIVE_TASK_MAX_GOAL_CHARS),
  previousCheckpoint: z.string().trim().min(1).max(CONTINUATION_MAX_SUMMARY_CHARS).optional(),
  /** AROKO SYSTEM CONTINUATION FACTS */
  event: z.strictObject({
    type: ContinuationEventTypeSchema,
    sourceRef: z.string().trim().min(1).max(80),
    safeSummary: z.string().trim().min(1).max(CONTINUATION_MAX_SUMMARY_CHARS),
    structuredResult: ContinuationStructuredResultSchema.optional()
  })
});
export type SafeContinuationEnvelope = z.infer<typeof SafeContinuationEnvelopeSchema>;

/** First provider turn — no continuation event yet. */
export const FirstTurnEnvelopeSchema = z.strictObject({
  taskId: CollaborativeTaskIdSchema,
  providerTurnId: ProviderTurnIdSchema,
  continuationSeq: z.literal(0),
  originalGoal: z.string().min(1).max(COLLABORATIVE_TASK_MAX_GOAL_CHARS),
  kind: z.literal("first_turn")
});
export type FirstTurnEnvelope = z.infer<typeof FirstTurnEnvelopeSchema>;

export type TaskWorkerEnvelope =
  | (FirstTurnEnvelope & { kind: "first_turn" })
  | (SafeContinuationEnvelope & { kind: "continuation" });

/** Provider-neutral progress phases (R5-7 human projection; derived from SoT). */
export const CollaborativeTaskProgressPhaseSchema = z.enum([
  "working_on_request",
  "needs_requester_input",
  "requester_answered",
  "waiting_for_owner_action",
  "owner_resolved_action",
  "running_approved_work",
  "continuing_work",
  "completed",
  "failed",
  "cancelled"
]);
export type CollaborativeTaskProgressPhase = z.infer<typeof CollaborativeTaskProgressPhaseSchema>;

/** Who the human collaboration is waiting on (derived; not a second state machine). */
export const CollaborativeTaskWaitingOnSchema = z.enum(["none", "requester", "owner", "provider"]);
export type CollaborativeTaskWaitingOn = z.infer<typeof CollaborativeTaskWaitingOnSchema>;

export function actionStatusToContinuationType(
  status: string
): Extract<
  ContinuationEventType,
  | "ACTION_COMPLETED"
  | "ACTION_DENIED"
  | "ACTION_FAILED"
  | "ACTION_UNKNOWN_OUTCOME"
  | "ACTION_CANCELLED"
> | null {
  switch (status) {
    case "completed":
    case "partially_completed":
      return "ACTION_COMPLETED";
    case "denied":
      return "ACTION_DENIED";
    case "failed":
    case "expired":
      return "ACTION_FAILED";
    case "cancelled":
      return "ACTION_CANCELLED";
    case "unknown_outcome":
      return "ACTION_UNKNOWN_OUTCOME";
    default:
      return null;
  }
}

export function mintActionObservationKey(actionId: string, status: string): string {
  return `action_terminal:${actionId}:${status}`;
}

export function mintInputAnswerObservationKey(inputRequestId: string): string {
  return `input_answer:${inputRequestId}`;
}

export function mintRestartObservationKey(taskId: string, crashedTurnId: string): string {
  return `task_restart:${taskId}:${crashedTurnId}`;
}
