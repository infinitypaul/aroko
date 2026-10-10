import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import { PairMeshErrorSchema } from "./errors/schema.js";
import {
  CollaborativeTaskEventIdSchema,
  CollaborativeTaskIdSchema,
  InputRequestIdSchema,
  SessionIdSchema
} from "./ids.js";
import {
  COLLABORATIVE_TASK_MAX_GOAL_CHARS,
  CollaborativeTaskRequesterViewSchema,
  CollaborativeTaskStatusSchema,
  RequesterSafeLinkedActionSchema
} from "./collaborative-task.js";
import { PairMeshMetadataVersionSchema } from "./version.js";

export const PAIRMESH_TASK_SKILL_ID = "pairmesh.task" as const;

/** Max question UTF-16 code units (untrusted clarification text). */
export const INPUT_REQUEST_MAX_QUESTION_CHARS = 2 * 1024;

/** Max free-text / option answer UTF-16 code units. */
export const INPUT_REQUEST_MAX_ANSWER_CHARS = 4 * 1024;

/** Max options per InputRequest. */
export const INPUT_REQUEST_MAX_OPTIONS = 6;

/** Max characters per option label. */
export const INPUT_REQUEST_MAX_OPTION_CHARS = 200;

/** Default TTL from createdAt when expiresAt omitted. */
export const INPUT_REQUEST_DEFAULT_TTL_MS = 30 * 60 * 1000;

export const InputRequestStatusSchema = z.enum(["pending", "answered", "expired", "cancelled"]);
export type InputRequestStatus = z.infer<typeof InputRequestStatusSchema>;

export const INPUT_REQUEST_TERMINAL_STATUSES = [
  "answered",
  "expired",
  "cancelled"
] as const satisfies readonly InputRequestStatus[];

export function isTerminalInputRequestStatus(status: InputRequestStatus): boolean {
  return (INPUT_REQUEST_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** V1: clarification is always directed at the task requester. */
export const InputRequestRequestedFromSchema = z.literal("requester");
export type InputRequestRequestedFrom = z.infer<typeof InputRequestRequestedFromSchema>;

export const InputRequestOptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(INPUT_REQUEST_MAX_OPTION_CHARS);
export type InputRequestOption = z.infer<typeof InputRequestOptionSchema>;

export const InputRequestSchema = z.strictObject({
  inputRequestId: InputRequestIdSchema,
  taskId: CollaborativeTaskIdSchema,
  requestedFrom: InputRequestRequestedFromSchema,
  /** Untrusted clarification question — never execute / never authority. */
  question: z.string().trim().min(1).max(INPUT_REQUEST_MAX_QUESTION_CHARS),
  options: z.array(InputRequestOptionSchema).max(INPUT_REQUEST_MAX_OPTIONS).optional(),
  /** When true (default), free-text answers are accepted even if options exist. */
  allowFreeText: z.boolean().default(true),
  status: InputRequestStatusSchema,
  createdAt: IsoUtcTimestampSchema,
  expiresAt: IsoUtcTimestampSchema.optional(),
  answeredAt: IsoUtcTimestampSchema.optional(),
  answer: z.string().trim().min(1).max(INPUT_REQUEST_MAX_ANSWER_CHARS).optional(),
  /** Wire/event id that first answered — durable answer idempotency. */
  answerEventId: CollaborativeTaskEventIdSchema.optional()
});
export type InputRequest = z.infer<typeof InputRequestSchema>;

/** Requester-safe projection (no internal task journal / provider metadata). */
export const InputRequestRequesterViewSchema = z.strictObject({
  inputRequestId: InputRequestIdSchema,
  taskId: CollaborativeTaskIdSchema,
  requestedFrom: InputRequestRequestedFromSchema,
  question: z.string().trim().min(1).max(INPUT_REQUEST_MAX_QUESTION_CHARS),
  options: z.array(InputRequestOptionSchema).max(INPUT_REQUEST_MAX_OPTIONS).optional(),
  allowFreeText: z.boolean(),
  status: InputRequestStatusSchema,
  createdAt: IsoUtcTimestampSchema,
  expiresAt: IsoUtcTimestampSchema.optional(),
  answeredAt: IsoUtcTimestampSchema.optional(),
  answer: z.string().trim().min(1).max(INPUT_REQUEST_MAX_ANSWER_CHARS).optional()
});
export type InputRequestRequesterView = z.infer<typeof InputRequestRequesterViewSchema>;

export const PairMeshTaskWireOperationSchema = z.enum([
  "input.deliver",
  "input.answer",
  "task.status",
  "task.goal"
]);
export type PairMeshTaskWireOperation = z.infer<typeof PairMeshTaskWireOperationSchema>;

export const PairMeshTaskWireRequestSchema = z
  .strictObject({
    metadataVersion: PairMeshMetadataVersionSchema,
    sessionId: SessionIdSchema,
    operation: PairMeshTaskWireOperationSchema,
    /**
     * Required for input.* / task.status.
     * Optional for task.goal (receiver mints CollaborativeTask).
     */
    taskId: CollaborativeTaskIdSchema.optional(),
    /** Required for task.goal — untrusted remote goal text. */
    originalGoal: z.string().trim().min(1).max(COLLABORATIVE_TASK_MAX_GOAL_CHARS).optional(),
    /** Required for input.deliver — requester-safe InputRequest. */
    inputRequest: InputRequestRequesterViewSchema.optional(),
    /** Optional task projection on deliver / status. */
    task: CollaborativeTaskRequesterViewSchema.optional(),
    /** Required for input.answer. */
    inputRequestId: InputRequestIdSchema.optional(),
    answer: z.string().trim().min(1).max(INPUT_REQUEST_MAX_ANSWER_CHARS).optional(),
    /** Idempotency key for answer wire delivery. */
    answerEventId: CollaborativeTaskEventIdSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (value.operation !== "task.goal" && !value.taskId) {
      ctx.addIssue({
        code: "custom",
        message: "taskId is required unless operation is task.goal.",
        path: ["taskId"]
      });
    }
    if (value.operation === "task.goal" && !value.originalGoal) {
      ctx.addIssue({
        code: "custom",
        message: "originalGoal is required when operation is task.goal.",
        path: ["originalGoal"]
      });
    }
    if (value.operation === "input.deliver" && !value.inputRequest) {
      ctx.addIssue({
        code: "custom",
        message: "inputRequest is required when operation is input.deliver.",
        path: ["inputRequest"]
      });
    }
    if (value.operation === "input.answer") {
      if (!value.inputRequestId) {
        ctx.addIssue({
          code: "custom",
          message: "inputRequestId is required when operation is input.answer.",
          path: ["inputRequestId"]
        });
      }
      if (!value.answer) {
        ctx.addIssue({
          code: "custom",
          message: "answer is required when operation is input.answer.",
          path: ["answer"]
        });
      }
    }
  })
  .describe("PairMesh collaborative-task wire request (R5-3/R5-6 transport).");
export type PairMeshTaskWireRequest = z.infer<typeof PairMeshTaskWireRequestSchema>;

export const PairMeshTaskWireSuccessResponseSchema = z.strictObject({
  metadataVersion: PairMeshMetadataVersionSchema,
  accepted: z.literal(true),
  taskId: CollaborativeTaskIdSchema,
  status: CollaborativeTaskStatusSchema.optional(),
  pendingInputRequestId: InputRequestIdSchema.optional(),
  continuationSeq: z.number().int().min(0).optional(),
  inputRequest: InputRequestRequesterViewSchema.optional(),
  task: CollaborativeTaskRequesterViewSchema.optional(),
  /**
   * R5-R1 — optional requester-safe linked Action projection (read-only).
   * Never grants approve/deny/execute authority on the requester.
   */
  linkedAction: RequesterSafeLinkedActionSchema.optional(),
  message: z.string().trim().min(1).max(500).optional()
});
export type PairMeshTaskWireSuccessResponse = z.infer<typeof PairMeshTaskWireSuccessResponseSchema>;

export const PairMeshTaskWireFailureResponseSchema = z.strictObject({
  metadataVersion: PairMeshMetadataVersionSchema,
  accepted: z.literal(false),
  taskId: CollaborativeTaskIdSchema,
  error: PairMeshErrorSchema
});
export type PairMeshTaskWireFailureResponse = z.infer<typeof PairMeshTaskWireFailureResponseSchema>;

export const PairMeshTaskWireResponseSchema = z.discriminatedUnion("accepted", [
  PairMeshTaskWireSuccessResponseSchema,
  PairMeshTaskWireFailureResponseSchema
]);
export type PairMeshTaskWireResponse = z.infer<typeof PairMeshTaskWireResponseSchema>;

export const PairMeshTaskRequestEnvelopeSchema = z.strictObject({
  type: z.literal("pairmesh.task.request"),
  payload: PairMeshTaskWireRequestSchema
});

export const PairMeshTaskResponseEnvelopeSchema = z.strictObject({
  type: z.literal("pairmesh.task.response"),
  payload: PairMeshTaskWireResponseSchema
});
