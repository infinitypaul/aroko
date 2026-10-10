import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import {
  ActionIdSchema,
  CollaborativeTaskEventIdSchema,
  CollaborativeTaskIdSchema,
  InputRequestIdSchema,
  InspectionThreadIdSchema,
  PeerIdSchema,
  ProviderTurnIdSchema,
  SessionIdSchema
} from "./ids.js";

/** Max originalGoal UTF-16 code units (untrusted remote data). */
export const COLLABORATIVE_TASK_MAX_GOAL_CHARS = 8 * 1024;

/** Max applied event ids retained per task for durable idempotency. */
export const COLLABORATIVE_TASK_MAX_APPLIED_EVENT_IDS = 200;

/** Max child refs retained per task. */
export const COLLABORATIVE_TASK_MAX_CHILD_REFS = 100;

/** Max provider_turn continuations per CollaborativeTask (R5-6 alpha rail). */
export const COLLABORATIVE_TASK_MAX_CONTINUATION_TURNS = 8;

export const CollaborativeTaskStatusSchema = z.enum([
  "working",
  "waiting_for_input",
  "blocked_on_action",
  "completed",
  "failed",
  "cancelled",
  "timed_out"
]);
export type CollaborativeTaskStatus = z.infer<typeof CollaborativeTaskStatusSchema>;

export const COLLABORATIVE_TASK_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out"
] as const satisfies readonly CollaborativeTaskStatus[];

export function isTerminalCollaborativeTaskStatus(status: CollaborativeTaskStatus): boolean {
  return (COLLABORATIVE_TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export const COLLABORATIVE_TASK_STATUS_TRANSITIONS: Readonly<
  Record<CollaborativeTaskStatus, readonly CollaborativeTaskStatus[]>
> = {
  working: [
    "waiting_for_input",
    "blocked_on_action",
    "completed",
    "failed",
    "cancelled",
    "timed_out"
  ],
  waiting_for_input: ["working", "cancelled", "timed_out", "failed"],
  blocked_on_action: ["working", "cancelled", "timed_out", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: []
};

export function canTransitionCollaborativeTaskStatus(
  from: CollaborativeTaskStatus,
  to: CollaborativeTaskStatus
): boolean {
  return COLLABORATIVE_TASK_STATUS_TRANSITIONS[from].includes(to);
}

export const CollaborativeTaskChildKindSchema = z.enum([
  "provider_turn",
  "input_request",
  "action"
]);
export type CollaborativeTaskChildKind = z.infer<typeof CollaborativeTaskChildKindSchema>;

export const CollaborativeTaskChildRefSchema = z.strictObject({
  kind: CollaborativeTaskChildKindSchema,
  id: z.string().trim().min(1).max(80),
  at: IsoUtcTimestampSchema
});
export type CollaborativeTaskChildRef = z.infer<typeof CollaborativeTaskChildRefSchema>;

/** Requester-safe terminal result (no secrets / abs paths). */
export const CollaborativeTaskResultSchema = z.strictObject({
  summary: z.string().trim().min(1).max(8_000)
});
export type CollaborativeTaskResult = z.infer<typeof CollaborativeTaskResultSchema>;

/** Requester-safe structured failure. */
export const CollaborativeTaskFailureSchema = z.strictObject({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2_000)
});
export type CollaborativeTaskFailure = z.infer<typeof CollaborativeTaskFailureSchema>;

/**
 * Event types applied to CollaborativeTask in R5-2 (lifecycle infrastructure).
 * Provider continuation envelopes arrive in later milestones.
 */
export const CollaborativeTaskEventTypeSchema = z.enum([
  "wait_for_input",
  "resume_from_input",
  "block_on_action",
  "resume_from_action",
  "complete",
  "fail",
  "cancel",
  "timeout",
  "append_child",
  "reserve_continuation",
  "set_active_provider_turn",
  "clear_active_provider_turn"
]);
export type CollaborativeTaskEventType = z.infer<typeof CollaborativeTaskEventTypeSchema>;

export const CollaborativeTaskEventSchema = z.strictObject({
  eventId: CollaborativeTaskEventIdSchema,
  type: CollaborativeTaskEventTypeSchema,
  /** Optional correlation (input/action/turn id). */
  sourceRef: z.string().trim().min(1).max(80).optional(),
  /** When type wait_for_input — fixture or real inq id. */
  inputRequestId: InputRequestIdSchema.optional(),
  /** When type block_on_action — fixture or real act id. */
  actionId: ActionIdSchema.optional(),
  providerTurnId: ProviderTurnIdSchema.optional(),
  childKind: CollaborativeTaskChildKindSchema.optional(),
  childId: z.string().trim().min(1).max(80).optional(),
  result: CollaborativeTaskResultSchema.optional(),
  failure: CollaborativeTaskFailureSchema.optional(),
  /** When true, reserveContinuation increments continuationSeq once per eventId. */
  reserveContinuation: z.boolean().optional()
});
export type CollaborativeTaskEvent = z.infer<typeof CollaborativeTaskEventSchema>;

export const CollaborativeTaskSchema = z.strictObject({
  taskId: CollaborativeTaskIdSchema,
  sessionId: SessionIdSchema,
  requesterParticipantId: PeerIdSchema,
  ownerParticipantId: PeerIdSchema,
  threadId: InspectionThreadIdSchema.optional(),
  /** Untrusted remote goal text — persist as data only; never execute. */
  originalGoal: z.string().min(1).max(COLLABORATIVE_TASK_MAX_GOAL_CHARS),
  status: CollaborativeTaskStatusSchema,
  activeProviderTurnId: ProviderTurnIdSchema.optional(),
  pendingInputRequestId: InputRequestIdSchema.optional(),
  blockedOnActionId: ActionIdSchema.optional(),
  childRefs: z.array(CollaborativeTaskChildRefSchema).max(COLLABORATIVE_TASK_MAX_CHILD_REFS),
  continuationSeq: z.number().int().min(0),
  /** Durable idempotency log — survives restart. */
  appliedEvents: z
    .array(
      z.strictObject({
        eventId: z.string().trim().min(1).max(80),
        type: CollaborativeTaskEventTypeSchema
      })
    )
    .max(COLLABORATIVE_TASK_MAX_APPLIED_EVENT_IDS),
  lastAppliedEventId: z.string().trim().min(1).max(80).optional(),
  createdAt: IsoUtcTimestampSchema,
  updatedAt: IsoUtcTimestampSchema,
  completedAt: IsoUtcTimestampSchema.optional(),
  result: CollaborativeTaskResultSchema.optional(),
  failure: CollaborativeTaskFailureSchema.optional()
});
export type CollaborativeTask = z.infer<typeof CollaborativeTaskSchema>;

/** Requester-visible projection — no appliedEventIds / private turn wiring. */
export const CollaborativeTaskRequesterViewSchema = z.strictObject({
  taskId: CollaborativeTaskIdSchema,
  sessionId: SessionIdSchema,
  requesterParticipantId: PeerIdSchema,
  ownerParticipantId: PeerIdSchema,
  threadId: InspectionThreadIdSchema.optional(),
  originalGoal: z.string().min(1).max(COLLABORATIVE_TASK_MAX_GOAL_CHARS),
  status: CollaborativeTaskStatusSchema,
  pendingInputRequestId: InputRequestIdSchema.optional(),
  blockedOnActionId: ActionIdSchema.optional(),
  childRefs: z.array(CollaborativeTaskChildRefSchema).max(COLLABORATIVE_TASK_MAX_CHILD_REFS),
  continuationSeq: z.number().int().min(0),
  createdAt: IsoUtcTimestampSchema,
  updatedAt: IsoUtcTimestampSchema,
  completedAt: IsoUtcTimestampSchema.optional(),
  result: CollaborativeTaskResultSchema.optional(),
  failure: CollaborativeTaskFailureSchema.optional()
});
export type CollaborativeTaskRequesterView = z.infer<typeof CollaborativeTaskRequesterViewSchema>;

/** Owner-visible projection — goal is untrusted context; no appliedEventIds. */
export const CollaborativeTaskOwnerViewSchema = CollaborativeTaskRequesterViewSchema;
export type CollaborativeTaskOwnerView = CollaborativeTaskRequesterView;

/**
 * R5-R1 — requester-safe linked Action snapshot (projection only; never writable).
 * Owner ActionService remains SoT. No Control tokens, paths, env, or CoT.
 */
export const RequesterSafeLinkedActionOwnerDecisionSchema = z.enum([
  "pending_approval",
  "approved",
  "denied",
  "cancelled",
  "failed",
  "unknown_outcome",
  "completed"
]);
export type RequesterSafeLinkedActionOwnerDecision = z.infer<
  typeof RequesterSafeLinkedActionOwnerDecisionSchema
>;

/** Bound safe stdout/result chars for requester mirror (align with continuation). */
export const REQUESTER_SAFE_ACTION_RESULT_MAX_CHARS = 4_000;

export const RequesterSafeLinkedActionSchema = z.strictObject({
  actionId: ActionIdSchema,
  actionType: z.string().trim().min(1).max(120),
  status: z.string().trim().min(1).max(80),
  ownerDecision: RequesterSafeLinkedActionOwnerDecisionSchema,
  waitingMessage: z.string().trim().min(1).max(500).optional(),
  summary: z.string().trim().min(1).max(2_000).optional(),
  /** Basename-only executable when privacy-safe; omitted if absolute/unsafe. */
  executableDisplay: z.string().trim().min(1).max(80).optional(),
  argsDisplay: z.array(z.string().max(500)).max(50).optional(),
  /** Bounded safe result text (e.g. sanitized stdout). */
  resultSafe: z.string().max(REQUESTER_SAFE_ACTION_RESULT_MAX_CHARS).optional(),
  /** True when a result existed but was suppressed for safety. */
  resultSuppressed: z.boolean().optional(),
  exitCode: z.number().int().nullable().optional(),
  unknownOutcome: z.boolean().optional(),
  executorInvocationCount: z.number().int().nonnegative().optional(),
  completedAt: IsoUtcTimestampSchema.optional(),
  updatedAt: IsoUtcTimestampSchema.optional()
});
export type RequesterSafeLinkedAction = z.infer<typeof RequesterSafeLinkedActionSchema>;
