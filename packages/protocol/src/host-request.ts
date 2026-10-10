import * as z from "zod";
import { IsoUtcTimestampSchema } from "./common.js";
import {
  ActionIdSchema,
  CollaborativeTaskIdSchema,
  InputRequestIdSchema,
  ProviderTurnIdSchema
} from "./ids.js";
import {
  INPUT_REQUEST_MAX_OPTION_CHARS,
  INPUT_REQUEST_MAX_OPTIONS,
  INPUT_REQUEST_MAX_QUESTION_CHARS
} from "./input-request.js";

/** Max child Actions linked to one CollaborativeTask (R5-4 alpha rail). */
export const COLLABORATIVE_TASK_MAX_CHILD_ACTIONS = 5;

/** Durable host-tool invocation identity (provider/tool-call equivalent). */
export const HostToolCallIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/, {
    message: "hostToolCallId must be a stable opaque tool-call identity."
  });
export type HostToolCallId = z.infer<typeof HostToolCallIdSchema>;

export const PAIRMESH_HOST_REQUEST_TOOLS = [
  "request_requester_input",
  "request_change_proposal",
  "request_repository_edit",
  "request_tests_run",
  "request_process_execution"
] as const;
export type PairMeshHostRequestToolName = (typeof PAIRMESH_HOST_REQUEST_TOOLS)[number];
export const PairMeshHostRequestToolNameSchema = z.enum(PAIRMESH_HOST_REQUEST_TOOLS);

export const RECEIVER_AGENT_REQUEST_PROVENANCE = "receiver_agent_request" as const;

/** Trusted runtime context — never taken from provider tool args. */
export const HostRequestTrustedContextSchema = z.strictObject({
  taskId: CollaborativeTaskIdSchema,
  sessionId: z.string().trim().min(1).max(80),
  requesterParticipantId: z.string().trim().min(1).max(80),
  ownerParticipantId: z.string().trim().min(1).max(80),
  providerTurnId: ProviderTurnIdSchema.optional(),
  hostToolCallId: HostToolCallIdSchema
});
export type HostRequestTrustedContext = z.infer<typeof HostRequestTrustedContextSchema>;

export const RequestRequesterInputArgsSchema = z.strictObject({
  question: z.string().trim().min(1).max(INPUT_REQUEST_MAX_QUESTION_CHARS),
  options: z
    .array(z.string().trim().min(1).max(INPUT_REQUEST_MAX_OPTION_CHARS))
    .max(INPUT_REQUEST_MAX_OPTIONS)
    .optional(),
  allowFreeText: z.boolean().optional()
});
export type RequestRequesterInputArgs = z.infer<typeof RequestRequesterInputArgsSchema>;

export const RequestChangeProposalArgsSchema = z.strictObject({
  instruction: z.string().trim().min(1).max(8_000)
});
export type RequestChangeProposalArgs = z.infer<typeof RequestChangeProposalArgsSchema>;

export const RequestRepositoryEditArgsSchema = z.strictObject({
  artifactId: z.string().trim().min(1).max(80),
  contentHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/, { message: "contentHash must be lowercase sha256 hex." })
});
export type RequestRepositoryEditArgs = z.infer<typeof RequestRepositoryEditArgsSchema>;

export const RequestTestsRunArgsSchema = z.strictObject({
  profileName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, {
      message: "profileName must be a receiver-defined profile id."
    })
});
export type RequestTestsRunArgs = z.infer<typeof RequestTestsRunArgsSchema>;

export const RequestProcessExecutionArgsSchema = z.strictObject({
  executable: z.string().trim().min(1).max(200),
  args: z.array(z.string().max(2_000)).max(64),
  cwd: z.string().trim().min(1).max(500).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional()
});
export type RequestProcessExecutionArgs = z.infer<typeof RequestProcessExecutionArgsSchema>;

export const HostToolCallRecordSchema = z.strictObject({
  hostToolCallId: HostToolCallIdSchema,
  taskId: CollaborativeTaskIdSchema,
  toolName: PairMeshHostRequestToolNameSchema,
  argsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(["input_request", "action"]),
  inputRequestId: InputRequestIdSchema.optional(),
  actionId: ActionIdSchema.optional(),
  createdAt: IsoUtcTimestampSchema
});
export type HostToolCallRecord = z.infer<typeof HostToolCallRecordSchema>;

export const HostToolSuccessResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("waiting_for_requester"),
    inputRequestId: InputRequestIdSchema,
    taskId: CollaborativeTaskIdSchema,
    hostToolCallId: HostToolCallIdSchema
  }),
  z.strictObject({
    status: z.literal("waiting_for_owner"),
    actionId: ActionIdSchema,
    taskId: CollaborativeTaskIdSchema,
    hostToolCallId: HostToolCallIdSchema,
    actionStatus: z.string().trim().min(1).max(40).optional()
  })
]);
export type HostToolSuccessResult = z.infer<typeof HostToolSuccessResultSchema>;
