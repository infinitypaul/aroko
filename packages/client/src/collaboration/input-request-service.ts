import {
  COLLABORATIVE_TASK_MAX_APPLIED_EVENT_IDS,
  CollaborativeTaskIdSchema,
  CollaborativeTaskSchema,
  ContinuationEventSchema,
  INPUT_REQUEST_DEFAULT_TTL_MS,
  INPUT_REQUEST_MAX_ANSWER_CHARS,
  INPUT_REQUEST_MAX_OPTION_CHARS,
  INPUT_REQUEST_MAX_OPTIONS,
  INPUT_REQUEST_MAX_QUESTION_CHARS,
  InputRequestIdSchema,
  InputRequestSchema,
  canTransitionCollaborativeTaskStatus,
  createPairMeshError,
  isTerminalCollaborativeTaskStatus,
  isTerminalInputRequestStatus,
  mintInputAnswerObservationKey,
  type CollaborativeTask,
  type CollaborativeTaskRequesterView,
  type InputRequest,
  type InputRequestRequesterView,
  type InputRequestStatus,
  type PeerId
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import type { LocalSessionState } from "../session/schemas.js";
import type { LocalStateStore } from "../state/store.js";
import {
  CollaborativeTaskService,
  mintCollaborativeTaskEventId
} from "./collaborative-task-service.js";

export interface CreateInputRequestInput {
  taskId: string;
  question: string;
  options?: string[];
  allowFreeText?: boolean;
  expiresAt?: string;
  now?: Date;
}

export interface AnswerInputRequestInput {
  taskId: string;
  inputRequestId: string;
  answer: string;
  /** Authenticated participant id of the answering peer. */
  answeringParticipantId: PeerId | string;
  answerEventId?: string;
  now?: Date;
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function replaceTaskInPlace(state: LocalSessionState, task: CollaborativeTask): void {
  if (!state.collaborativeTasks) {
    state.collaborativeTasks = [];
  }
  const idx = state.collaborativeTasks.findIndex((entry) => entry.taskId === task.taskId);
  if (idx >= 0) {
    state.collaborativeTasks[idx] = task;
  } else {
    state.collaborativeTasks.push(task);
  }
}

function replaceInputInPlace(state: LocalSessionState, input: InputRequest): void {
  if (!state.inputRequests) {
    state.inputRequests = [];
  }
  const idx = state.inputRequests.findIndex(
    (entry) => entry.inputRequestId === input.inputRequestId
  );
  if (idx >= 0) {
    state.inputRequests[idx] = input;
  } else {
    state.inputRequests.push(input);
  }
}

function rememberTaskEvent(
  task: CollaborativeTask,
  eventId: string,
  type: CollaborativeTask["appliedEvents"][number]["type"]
): CollaborativeTask {
  if (task.appliedEvents.some((entry) => entry.eventId === eventId)) {
    return task;
  }
  const appliedEvents = [...task.appliedEvents, { eventId, type }];
  while (appliedEvents.length > COLLABORATIVE_TASK_MAX_APPLIED_EVENT_IDS) {
    appliedEvents.shift();
  }
  return { ...task, appliedEvents, lastAppliedEventId: eventId };
}

function appendInputChild(
  task: CollaborativeTask,
  inputRequestId: string,
  at: string
): CollaborativeTask {
  const existing = task.childRefs.find((ref) => ref.id === inputRequestId);
  if (existing) {
    if (existing.kind !== "input_request") {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_child_conflict",
        message: `Child id ${inputRequestId} already registered as ${existing.kind}.`,
        details: { taskId: task.taskId, id: inputRequestId, existingKind: existing.kind }
      });
    }
    return task;
  }
  return {
    ...task,
    childRefs: [...task.childRefs, { kind: "input_request" as const, id: inputRequestId, at }]
  };
}

function normalizeOptions(options: string[] | undefined): string[] | undefined {
  if (!options || options.length === 0) {
    return undefined;
  }
  if (options.length > INPUT_REQUEST_MAX_OPTIONS) {
    throw createPairMeshError({
      code: "pairmesh.input_request_invalid",
      message: `options must have at most ${INPUT_REQUEST_MAX_OPTIONS} entries.`,
      details: { length: options.length }
    });
  }
  const normalized = options.map((option) => {
    const trimmed = option.trim();
    if (trimmed.length < 1 || trimmed.length > INPUT_REQUEST_MAX_OPTION_CHARS) {
      throw createPairMeshError({
        code: "pairmesh.input_request_invalid",
        message: `Each option must be 1..${INPUT_REQUEST_MAX_OPTION_CHARS} characters.`,
        details: { length: trimmed.length }
      });
    }
    return trimmed;
  });
  return normalized;
}

function validateAnswerText(answer: string, input: InputRequest): string {
  const trimmed = answer.trim();
  if (trimmed.length < 1 || trimmed.length > INPUT_REQUEST_MAX_ANSWER_CHARS) {
    throw createPairMeshError({
      code: "pairmesh.input_request_invalid",
      message: `answer must be 1..${INPUT_REQUEST_MAX_ANSWER_CHARS} characters.`,
      details: { length: trimmed.length }
    });
  }
  const options = input.options;
  const allowFreeText = input.allowFreeText !== false;
  if (options && options.length > 0 && !allowFreeText) {
    if (!options.includes(trimmed)) {
      throw createPairMeshError({
        code: "pairmesh.input_request_invalid",
        message: "answer must match one of the provided options.",
        details: { options }
      });
    }
  }
  return trimmed;
}

/**
 * Receiver-authoritative InputRequest service (R5-3).
 * Mutates CollaborativeTask + InputRequest in one LocalStateStore.mutate when possible.
 * Does not construct a LocalStateStore.
 */
export class InputRequestService {
  private readonly tasks: CollaborativeTaskService;

  public constructor(private readonly stateStore: LocalStateStore) {
    this.tasks = new CollaborativeTaskService(stateStore);
  }

  public toRequesterView(input: InputRequest): InputRequestRequesterView {
    return {
      inputRequestId: input.inputRequestId,
      taskId: input.taskId,
      requestedFrom: input.requestedFrom,
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
      allowFreeText: input.allowFreeText !== false,
      status: input.status,
      createdAt: input.createdAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.answeredAt ? { answeredAt: input.answeredAt } : {}),
      ...(input.answer ? { answer: input.answer } : {})
    };
  }

  public async getInputRequest(inputRequestId: string): Promise<InputRequest | null> {
    const state = await this.stateStore.load();
    if (!state) {
      return null;
    }
    const id = InputRequestIdSchema.parse(inputRequestId);
    return (state.inputRequests ?? []).find((entry) => entry.inputRequestId === id) ?? null;
  }

  public async listInputRequests(
    filter: {
      taskId?: string;
      status?: InputRequestStatus;
    } = {}
  ): Promise<InputRequest[]> {
    const state = await this.stateStore.load();
    if (!state) {
      return [];
    }
    let rows = [...(state.inputRequests ?? [])];
    if (filter.taskId) {
      const taskId = CollaborativeTaskIdSchema.parse(filter.taskId);
      rows = rows.filter((entry) => entry.taskId === taskId);
    }
    if (filter.status) {
      rows = rows.filter((entry) => entry.status === filter.status);
    }
    return rows;
  }

  /**
   * Atomically create pending InputRequest and move parent working → waiting_for_input.
   */
  public async createInputRequest(input: CreateInputRequestInput): Promise<{
    task: CollaborativeTask;
    inputRequest: InputRequest;
  }> {
    const question = input.question.trim();
    if (question.length < 1 || question.length > INPUT_REQUEST_MAX_QUESTION_CHARS) {
      throw createPairMeshError({
        code: "pairmesh.input_request_invalid",
        message: `question must be 1..${INPUT_REQUEST_MAX_QUESTION_CHARS} characters.`,
        details: { length: question.length }
      });
    }
    const options = normalizeOptions(input.options);
    const taskId = CollaborativeTaskIdSchema.parse(input.taskId);
    const at = nowIso(input.now);
    const expiresAt =
      input.expiresAt ??
      new Date(new Date(at).getTime() + INPUT_REQUEST_DEFAULT_TTL_MS).toISOString();
    const inputRequestId = InputRequestIdSchema.parse(`inq_${randomUUID()}`);
    const waitEventId = mintCollaborativeTaskEventId();

    return this.stateStore.mutate(async (state) => {
      const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === taskId);
      if (!task) {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_not_found",
          message: `CollaborativeTask ${taskId} not found.`,
          details: { taskId }
        });
      }
      if (task.status !== "working") {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_invalid_transition",
          message: `Cannot create InputRequest unless task is working (got ${task.status}).`,
          details: { taskId, status: task.status }
        });
      }
      if (task.pendingInputRequestId) {
        throw createPairMeshError({
          code: "pairmesh.input_request_conflict",
          message: "Task already has a pending InputRequest.",
          details: { taskId, pendingInputRequestId: task.pendingInputRequestId }
        });
      }
      const activePending = (state.inputRequests ?? []).find(
        (entry) => entry.taskId === taskId && entry.status === "pending"
      );
      if (activePending) {
        throw createPairMeshError({
          code: "pairmesh.input_request_conflict",
          message: "Task already has a pending InputRequest.",
          details: { taskId, pendingInputRequestId: activePending.inputRequestId }
        });
      }

      const inputRequest = InputRequestSchema.parse({
        inputRequestId,
        taskId,
        requestedFrom: "requester",
        question,
        ...(options ? { options } : {}),
        allowFreeText: input.allowFreeText ?? true,
        status: "pending",
        createdAt: at,
        expiresAt
      });

      let nextTask = rememberTaskEvent(task, waitEventId, "wait_for_input");
      if (!canTransitionCollaborativeTaskStatus(nextTask.status, "waiting_for_input")) {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_invalid_transition",
          message: `Illegal CollaborativeTask transition: ${nextTask.status} -> waiting_for_input`,
          details: { taskId, from: nextTask.status, to: "waiting_for_input" }
        });
      }
      nextTask = {
        ...nextTask,
        status: "waiting_for_input",
        pendingInputRequestId: inputRequestId,
        blockedOnActionId: undefined,
        updatedAt: at
      };
      nextTask = appendInputChild(nextTask, inputRequestId, at);
      nextTask = CollaborativeTaskSchema.parse(nextTask);

      replaceInputInPlace(state, inputRequest);
      replaceTaskInPlace(state, nextTask);
      return { task: nextTask, inputRequest };
    });
  }

  /**
   * Authenticated requester answer — first valid wins; conflicting duplicate fail-closed.
   * Atomically answers InputRequest, resumes task to working, increments continuationSeq once.
   */
  public async answerInputRequest(input: AnswerInputRequestInput): Promise<{
    task: CollaborativeTask;
    inputRequest: InputRequest;
  }> {
    const taskId = CollaborativeTaskIdSchema.parse(input.taskId);
    const inputRequestId = InputRequestIdSchema.parse(input.inputRequestId);
    const answeringParticipantId = String(input.answeringParticipantId);
    const eventId =
      typeof input.answerEventId === "string" && input.answerEventId.startsWith("tevt_")
        ? input.answerEventId
        : mintCollaborativeTaskEventId();
    const at = nowIso(input.now);

    return this.stateStore.mutate(async (state) => {
      const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === taskId);
      if (!task) {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_not_found",
          message: `CollaborativeTask ${taskId} not found.`,
          details: { taskId }
        });
      }

      if (task.requesterParticipantId !== answeringParticipantId) {
        throw createPairMeshError({
          code: "pairmesh.permission_denied",
          message: "Only the task requester may answer this InputRequest.",
          details: {
            taskId,
            inputRequestId,
            answeringParticipantId,
            requesterParticipantId: task.requesterParticipantId
          }
        });
      }

      const existing = (state.inputRequests ?? []).find(
        (entry) => entry.inputRequestId === inputRequestId
      );
      if (!existing) {
        throw createPairMeshError({
          code: "pairmesh.input_request_not_found",
          message: `InputRequest ${inputRequestId} not found.`,
          details: { inputRequestId, taskId }
        });
      }
      if (existing.taskId !== taskId) {
        throw createPairMeshError({
          code: "pairmesh.input_request_invalid",
          message: "InputRequest does not belong to the given task.",
          details: { inputRequestId, taskId, owningTaskId: existing.taskId }
        });
      }
      if (existing.requestedFrom !== "requester") {
        throw createPairMeshError({
          code: "pairmesh.input_request_invalid",
          message: "InputRequest requestedFrom must be requester in V1.",
          details: { inputRequestId, requestedFrom: existing.requestedFrom }
        });
      }

      if (existing.status === "answered") {
        const answer = validateAnswerText(input.answer, existing);
        if (existing.answer === answer) {
          return { task, inputRequest: existing };
        }
        throw createPairMeshError({
          code: "pairmesh.input_already_answered",
          message: "InputRequest already answered with a different answer.",
          details: { inputRequestId, taskId }
        });
      }

      if (existing.status === "expired") {
        throw createPairMeshError({
          code: "pairmesh.input_request_expired",
          message: "InputRequest has expired and cannot be answered.",
          details: { inputRequestId, taskId }
        });
      }
      if (existing.status === "cancelled") {
        throw createPairMeshError({
          code: "pairmesh.input_request_cancelled",
          message: "InputRequest was cancelled and cannot be answered.",
          details: { inputRequestId, taskId }
        });
      }

      if (task.status !== "waiting_for_input") {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_invalid_transition",
          message: `Task must be waiting_for_input to accept an answer (got ${task.status}).`,
          details: { taskId, status: task.status }
        });
      }
      if (task.pendingInputRequestId !== inputRequestId) {
        throw createPairMeshError({
          code: "pairmesh.input_request_conflict",
          message: "Answer targets an InputRequest that is not the task pending input.",
          details: {
            taskId,
            inputRequestId,
            pendingInputRequestId: task.pendingInputRequestId ?? null
          }
        });
      }

      if (task.appliedEvents.some((entry) => entry.eventId === eventId)) {
        return { task, inputRequest: existing };
      }

      const answer = validateAnswerText(input.answer, existing);
      const answered = InputRequestSchema.parse({
        ...existing,
        status: "answered",
        answer,
        answeredAt: at,
        answerEventId: eventId
      });

      // Single authoritative continuation reservation: resume + seq+1 + ContinuationEvent.
      let nextTask = rememberTaskEvent(task, eventId, "resume_from_input");
      const nextSeq = nextTask.continuationSeq + 1;
      nextTask = {
        ...nextTask,
        continuationSeq: nextSeq,
        status: "working",
        pendingInputRequestId: undefined,
        blockedOnActionId: undefined,
        updatedAt: at
      };
      nextTask = CollaborativeTaskSchema.parse(nextTask);

      const continuation = ContinuationEventSchema.parse({
        eventId,
        taskId,
        type: "REQUESTER_INPUT_RECEIVED",
        sourceRef: inputRequestId,
        safeSummary: "Requester answered InputRequest.",
        structuredResult: {
          inputRequestId,
          answer
        },
        occurredAt: at,
        continuationSeq: nextSeq,
        observationKey: mintInputAnswerObservationKey(inputRequestId)
      });
      if (!state.continuationEvents) {
        state.continuationEvents = [];
      }
      const priorContinuation = state.continuationEvents.find(
        (entry) => entry.observationKey === continuation.observationKey
      );
      if (priorContinuation) {
        if (
          priorContinuation.type !== continuation.type ||
          priorContinuation.eventId !== continuation.eventId
        ) {
          throw createPairMeshError({
            code: "pairmesh.continuation_event_conflict",
            message: "Input answer observation key already used with a different continuation.",
            details: {
              observationKey: continuation.observationKey,
              priorEventId: priorContinuation.eventId,
              eventId: continuation.eventId
            }
          });
        }
      } else {
        state.continuationEvents.push(continuation);
        while (state.continuationEvents.length > 200) {
          state.continuationEvents.shift();
        }
      }

      replaceInputInPlace(state, answered);
      replaceTaskInPlace(state, nextTask);
      return { task: nextTask, inputRequest: answered };
    });
  }

  /** Deterministic pending → expired; parent waiting_for_input → timed_out. */
  public async expireInputRequest(
    taskId: string,
    inputRequestId: string,
    now?: Date
  ): Promise<{ task: CollaborativeTask; inputRequest: InputRequest }> {
    const tid = CollaborativeTaskIdSchema.parse(taskId);
    const iid = InputRequestIdSchema.parse(inputRequestId);
    const at = nowIso(now);
    const eventId = mintCollaborativeTaskEventId();

    return this.stateStore.mutate(async (state) => {
      const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === tid);
      const existing = (state.inputRequests ?? []).find((entry) => entry.inputRequestId === iid);
      if (!existing) {
        throw createPairMeshError({
          code: "pairmesh.input_request_not_found",
          message: `InputRequest ${iid} not found.`,
          details: { inputRequestId: iid }
        });
      }
      if (!task || existing.taskId !== tid) {
        throw createPairMeshError({
          code: "pairmesh.input_request_invalid",
          message: "InputRequest/task mismatch on expiry.",
          details: { inputRequestId: iid, taskId: tid }
        });
      }
      if (existing.status === "expired") {
        return { task, inputRequest: existing };
      }
      if (isTerminalInputRequestStatus(existing.status)) {
        throw createPairMeshError({
          code: "pairmesh.input_request_conflict",
          message: `Cannot expire InputRequest in status ${existing.status}.`,
          details: { inputRequestId: iid, status: existing.status }
        });
      }

      const expired = InputRequestSchema.parse({
        ...existing,
        status: "expired",
        answer: undefined,
        answeredAt: undefined
      });

      let nextTask = task;
      if (task.status === "waiting_for_input" && task.pendingInputRequestId === iid) {
        nextTask = rememberTaskEvent(task, eventId, "timeout");
        nextTask = {
          ...nextTask,
          status: "timed_out",
          pendingInputRequestId: undefined,
          blockedOnActionId: undefined,
          activeProviderTurnId: undefined,
          completedAt: at,
          updatedAt: at,
          failure: {
            code: "pairmesh.input_request_expired",
            message: "InputRequest expired before the requester answered."
          }
        };
        nextTask = CollaborativeTaskSchema.parse(nextTask);
      }

      replaceInputInPlace(state, expired);
      replaceTaskInPlace(state, nextTask);
      return { task: nextTask, inputRequest: expired };
    });
  }

  /** Cancel pending InputRequest when parent task is cancelled (atomic helper). */
  public async cancelPendingForTask(taskId: string, now?: Date): Promise<InputRequest | null> {
    const tid = CollaborativeTaskIdSchema.parse(taskId);
    const at = nowIso(now);
    return this.stateStore.mutate(async (state) => {
      const pending = (state.inputRequests ?? []).find(
        (entry) => entry.taskId === tid && entry.status === "pending"
      );
      if (!pending) {
        return null;
      }
      const cancelled = InputRequestSchema.parse({
        ...pending,
        status: "cancelled",
        answer: undefined,
        answeredAt: undefined
      });
      replaceInputInPlace(state, cancelled);
      // Touch updatedAt marker via no-op if task already cancelled elsewhere.
      const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === tid);
      if (
        task &&
        task.status === "waiting_for_input" &&
        task.pendingInputRequestId === pending.inputRequestId
      ) {
        // Leave task as-is; caller should apply cancel event. Prefer cancelTaskWithInput.
        void at;
      }
      return cancelled;
    });
  }

  /**
   * Cancel parent task and any pending InputRequest atomically.
   */
  public async cancelTaskWithPendingInput(
    taskId: string,
    now?: Date
  ): Promise<{ task: CollaborativeTask; inputRequest: InputRequest | null }> {
    const tid = CollaborativeTaskIdSchema.parse(taskId);
    const at = nowIso(now);
    const eventId = mintCollaborativeTaskEventId();

    return this.stateStore.mutate(async (state) => {
      const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === tid);
      if (!task) {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_not_found",
          message: `CollaborativeTask ${tid} not found.`,
          details: { taskId: tid }
        });
      }
      if (isTerminalCollaborativeTaskStatus(task.status)) {
        const pending = (state.inputRequests ?? []).find(
          (entry) =>
            entry.taskId === tid &&
            (entry.status === "pending" || isTerminalInputRequestStatus(entry.status))
        );
        return { task, inputRequest: pending ?? null };
      }

      let inputRequest: InputRequest | null = null;
      if (task.pendingInputRequestId) {
        const existing = (state.inputRequests ?? []).find(
          (entry) => entry.inputRequestId === task.pendingInputRequestId
        );
        if (existing && existing.status === "pending") {
          inputRequest = InputRequestSchema.parse({
            ...existing,
            status: "cancelled"
          });
          replaceInputInPlace(state, inputRequest);
        }
      }

      let nextTask = rememberTaskEvent(task, eventId, "cancel");
      if (!canTransitionCollaborativeTaskStatus(nextTask.status, "cancelled")) {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_invalid_transition",
          message: `Illegal CollaborativeTask transition: ${nextTask.status} -> cancelled`,
          details: { taskId: tid, from: nextTask.status, to: "cancelled" }
        });
      }
      nextTask = {
        ...nextTask,
        status: "cancelled",
        pendingInputRequestId: undefined,
        blockedOnActionId: undefined,
        activeProviderTurnId: undefined,
        completedAt: at,
        updatedAt: at
      };
      nextTask = CollaborativeTaskSchema.parse(nextTask);
      replaceTaskInPlace(state, nextTask);
      return { task: nextTask, inputRequest };
    });
  }

  /** Requester-side mirror upsert for input.deliver (safe views only). */
  public async upsertMirroredDeliver(input: {
    task: CollaborativeTaskRequesterView;
    inputRequest: InputRequestRequesterView;
  }): Promise<void> {
    await this.stateStore.mutate(async (state) => {
      const mirroredInput = InputRequestSchema.parse({
        ...input.inputRequest,
        allowFreeText: input.inputRequest.allowFreeText
      });
      replaceInputInPlace(state, mirroredInput);

      const existing = (state.collaborativeTasks ?? []).find(
        (entry) => entry.taskId === input.task.taskId
      );
      const mirroredTask = CollaborativeTaskSchema.parse({
        ...input.task,
        appliedEvents: existing?.appliedEvents ?? [],
        lastAppliedEventId: existing?.lastAppliedEventId,
        activeProviderTurnId: undefined
      });
      replaceTaskInPlace(state, mirroredTask);
    });
  }

  /**
   * R5-R1 — requester-side mirror of task.status without requiring an InputRequest.
   * Persists safe CollaborativeTask projection only (no appliedEvents / provider turn).
   */
  public async upsertMirroredTask(input: { task: CollaborativeTaskRequesterView }): Promise<void> {
    await this.stateStore.mutate(async (state) => {
      const existing = (state.collaborativeTasks ?? []).find(
        (entry) => entry.taskId === input.task.taskId
      );
      const mirroredTask = CollaborativeTaskSchema.parse({
        ...input.task,
        appliedEvents: existing?.appliedEvents ?? [],
        lastAppliedEventId: existing?.lastAppliedEventId,
        activeProviderTurnId: undefined
      });
      replaceTaskInPlace(state, mirroredTask);
    });
  }

  public async getTaskView(taskId: string): Promise<CollaborativeTaskRequesterView | null> {
    const task = await this.tasks.getTask(taskId);
    return task ? this.tasks.toRequesterView(task) : null;
  }
}

export function mintInputRequestId(): string {
  return `inq_${randomUUID()}`;
}
