import {
  ActionIdSchema,
  COLLABORATIVE_TASK_MAX_APPLIED_EVENT_IDS,
  COLLABORATIVE_TASK_MAX_GOAL_CHARS,
  CollaborativeTaskChildKindSchema,
  CollaborativeTaskEventSchema,
  CollaborativeTaskIdSchema,
  CollaborativeTaskSchema,
  InputRequestIdSchema,
  InspectionThreadIdSchema,
  PeerIdSchema,
  ProviderTurnIdSchema,
  SessionIdSchema,
  canTransitionCollaborativeTaskStatus,
  createPairMeshError,
  isTerminalCollaborativeTaskStatus,
  type ActionId,
  type CollaborativeTask,
  type CollaborativeTaskChildKind,
  type CollaborativeTaskChildRef,
  type CollaborativeTaskEvent,
  type CollaborativeTaskFailure,
  type CollaborativeTaskOwnerView,
  type CollaborativeTaskRequesterView,
  type CollaborativeTaskResult,
  type CollaborativeTaskStatus,
  type PeerId,
  type ProviderTurnId,
  type SessionId
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import type { LocalSessionState } from "../session/schemas.js";
import type { LocalStateStore } from "../state/store.js";

export interface CreateCollaborativeTaskInput {
  sessionId: SessionId | string;
  requesterParticipantId: PeerId | string;
  ownerParticipantId: PeerId | string;
  originalGoal: string;
  threadId?: string;
  now?: Date;
}

export interface ListCollaborativeTasksFilter {
  status?: CollaborativeTaskStatus;
  requesterParticipantId?: PeerId | string;
  ownerParticipantId?: PeerId | string;
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

function assertInvariants(task: CollaborativeTask): void {
  const { status } = task;
  if (status === "waiting_for_input") {
    if (!task.pendingInputRequestId) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_invariant_violation",
        message: "waiting_for_input requires pendingInputRequestId.",
        details: { taskId: task.taskId, status }
      });
    }
    if (task.blockedOnActionId) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_invariant_violation",
        message: "waiting_for_input must not set blockedOnActionId.",
        details: { taskId: task.taskId, status }
      });
    }
  }
  if (status === "blocked_on_action") {
    if (!task.blockedOnActionId) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_invariant_violation",
        message: "blocked_on_action requires blockedOnActionId.",
        details: { taskId: task.taskId, status }
      });
    }
    if (task.pendingInputRequestId) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_invariant_violation",
        message: "blocked_on_action must not set pendingInputRequestId.",
        details: { taskId: task.taskId, status }
      });
    }
  }
  if (status === "working") {
    if (task.pendingInputRequestId || task.blockedOnActionId) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_invariant_violation",
        message: "working must clear pendingInputRequestId and blockedOnActionId.",
        details: { taskId: task.taskId, status }
      });
    }
  }
  if (isTerminalCollaborativeTaskStatus(status)) {
    if (task.activeProviderTurnId || task.pendingInputRequestId || task.blockedOnActionId) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_invariant_violation",
        message: "Terminal task must clear active turn / pending input / blocked action.",
        details: { taskId: task.taskId, status }
      });
    }
    if (!task.completedAt) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_invariant_violation",
        message: "Terminal task requires completedAt.",
        details: { taskId: task.taskId, status }
      });
    }
  }
  if (status === "completed" && !task.result) {
    throw createPairMeshError({
      code: "pairmesh.collaborative_task_invariant_violation",
      message: "completed requires result.",
      details: { taskId: task.taskId }
    });
  }
  if (status === "failed" && !task.failure) {
    throw createPairMeshError({
      code: "pairmesh.collaborative_task_invariant_violation",
      message: "failed requires failure.",
      details: { taskId: task.taskId }
    });
  }
}

function projectSafe(task: CollaborativeTask): CollaborativeTaskRequesterView {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    requesterParticipantId: task.requesterParticipantId,
    ownerParticipantId: task.ownerParticipantId,
    ...(task.threadId ? { threadId: task.threadId } : {}),
    originalGoal: task.originalGoal,
    status: task.status,
    ...(task.pendingInputRequestId ? { pendingInputRequestId: task.pendingInputRequestId } : {}),
    ...(task.blockedOnActionId ? { blockedOnActionId: task.blockedOnActionId } : {}),
    childRefs: task.childRefs,
    continuationSeq: task.continuationSeq,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.result ? { result: task.result } : {}),
    ...(task.failure ? { failure: task.failure } : {})
  };
}

function rememberEvent(
  task: CollaborativeTask,
  eventId: string,
  type: CollaborativeTaskEvent["type"]
): CollaborativeTask {
  if (task.appliedEvents.some((entry) => entry.eventId === eventId)) {
    return task;
  }
  const appliedEvents = [...task.appliedEvents, { eventId, type }];
  while (appliedEvents.length > COLLABORATIVE_TASK_MAX_APPLIED_EVENT_IDS) {
    appliedEvents.shift();
  }
  return {
    ...task,
    appliedEvents,
    lastAppliedEventId: eventId
  };
}

function appendChildRef(
  task: CollaborativeTask,
  kind: CollaborativeTaskChildKind,
  id: string,
  at: string
): CollaborativeTask {
  const existing = task.childRefs.find((ref) => ref.id === id);
  if (existing) {
    if (existing.kind !== kind) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_child_conflict",
        message: `Child id ${id} already registered as ${existing.kind}, not ${kind}.`,
        details: { taskId: task.taskId, id, existingKind: existing.kind, kind }
      });
    }
    return task;
  }
  const ref: CollaborativeTaskChildRef = { kind, id, at };
  return { ...task, childRefs: [...task.childRefs, ref] };
}

/**
 * Receiver-authoritative CollaborativeTask domain service (R5-2).
 * Mutates only through the injected LocalStateStore — never constructs a store.
 */
export class CollaborativeTaskService {
  public constructor(private readonly stateStore: LocalStateStore) {}

  public async createTask(input: CreateCollaborativeTaskInput): Promise<CollaborativeTask> {
    const goal = input.originalGoal;
    if (
      typeof goal !== "string" ||
      goal.length < 1 ||
      goal.length > COLLABORATIVE_TASK_MAX_GOAL_CHARS
    ) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_goal_invalid",
        message: `originalGoal must be 1..${COLLABORATIVE_TASK_MAX_GOAL_CHARS} characters.`,
        details: { length: typeof goal === "string" ? goal.length : null }
      });
    }

    const createdAt = nowIso(input.now);
    const task = CollaborativeTaskSchema.parse({
      taskId: CollaborativeTaskIdSchema.parse(`task_${randomUUID()}`),
      sessionId: SessionIdSchema.parse(input.sessionId),
      requesterParticipantId: PeerIdSchema.parse(input.requesterParticipantId),
      ownerParticipantId: PeerIdSchema.parse(input.ownerParticipantId),
      ...(input.threadId ? { threadId: InspectionThreadIdSchema.parse(input.threadId) } : {}),
      originalGoal: goal,
      status: "working",
      childRefs: [],
      continuationSeq: 0,
      appliedEvents: [],
      createdAt,
      updatedAt: createdAt
    });
    assertInvariants(task);

    return this.stateStore.mutate(async (state) => {
      replaceTaskInPlace(state, task);
      return task;
    });
  }

  public async getTask(taskId: string): Promise<CollaborativeTask | null> {
    const state = await this.stateStore.load();
    if (!state) {
      return null;
    }
    const id = CollaborativeTaskIdSchema.parse(taskId);
    return (state.collaborativeTasks ?? []).find((entry) => entry.taskId === id) ?? null;
  }

  public async listTasks(filter: ListCollaborativeTasksFilter = {}): Promise<CollaborativeTask[]> {
    const state = await this.stateStore.load();
    if (!state) {
      return [];
    }
    let tasks = [...(state.collaborativeTasks ?? [])];
    if (filter.status) {
      tasks = tasks.filter((task) => task.status === filter.status);
    }
    if (filter.requesterParticipantId) {
      const peer = PeerIdSchema.parse(filter.requesterParticipantId);
      tasks = tasks.filter((task) => task.requesterParticipantId === peer);
    }
    if (filter.ownerParticipantId) {
      const peer = PeerIdSchema.parse(filter.ownerParticipantId);
      tasks = tasks.filter((task) => task.ownerParticipantId === peer);
    }
    return tasks;
  }

  public toRequesterView(task: CollaborativeTask): CollaborativeTaskRequesterView {
    return projectSafe(task);
  }

  public toOwnerView(task: CollaborativeTask): CollaborativeTaskOwnerView {
    return projectSafe(task);
  }

  /**
   * Apply a durable task event. Duplicate eventId is a no-op (returns stored task).
   * Conflicting payload for an already-applied eventId fails closed when outcome differs.
   */
  public async applyEvent(
    taskId: string,
    rawEvent: CollaborativeTaskEvent
  ): Promise<CollaborativeTask> {
    const event = CollaborativeTaskEventSchema.parse(rawEvent);
    const id = CollaborativeTaskIdSchema.parse(taskId);

    return this.stateStore.mutate(async (state) => {
      const existing = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === id);
      if (!existing) {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_not_found",
          message: `CollaborativeTask ${id} not found.`,
          details: { taskId: id }
        });
      }

      if (existing.appliedEvents.some((entry) => entry.eventId === event.eventId)) {
        this.assertReplayCompatible(existing, event);
        return existing;
      }

      const next = this.applyEventToTask(existing, event, nowIso());
      assertInvariants(next);
      const parsed = CollaborativeTaskSchema.parse(next);
      replaceTaskInPlace(state, parsed);
      return parsed;
    });
  }

  private assertReplayCompatible(task: CollaborativeTask, event: CollaborativeTaskEvent): void {
    const prior = task.appliedEvents.find((entry) => entry.eventId === event.eventId);
    if (prior && prior.type !== event.type) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_event_conflict",
        message: "Event id was previously applied with a different type.",
        details: {
          taskId: task.taskId,
          eventId: event.eventId,
          priorType: prior.type,
          type: event.type
        }
      });
    }
    if (event.type === "complete" && task.status !== "completed") {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_event_conflict",
        message: "Event id was applied with a different terminal outcome.",
        details: { taskId: task.taskId, eventId: event.eventId, status: task.status }
      });
    }
    if (event.type === "fail" && task.status !== "failed") {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_event_conflict",
        message: "Event id was applied with a different terminal outcome.",
        details: { taskId: task.taskId, eventId: event.eventId, status: task.status }
      });
    }
    if (event.type === "cancel" && task.status !== "cancelled") {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_event_conflict",
        message: "Event id was applied with a different terminal outcome.",
        details: { taskId: task.taskId, eventId: event.eventId, status: task.status }
      });
    }
    if (event.type === "timeout" && task.status !== "timed_out") {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_event_conflict",
        message: "Event id was applied with a different terminal outcome.",
        details: { taskId: task.taskId, eventId: event.eventId, status: task.status }
      });
    }
  }

  private transition(
    task: CollaborativeTask,
    to: CollaborativeTaskStatus,
    at: string
  ): CollaborativeTask {
    if (!canTransitionCollaborativeTaskStatus(task.status, to)) {
      throw createPairMeshError({
        code: "pairmesh.collaborative_task_invalid_transition",
        message: `Illegal CollaborativeTask transition: ${task.status} -> ${to}`,
        details: { taskId: task.taskId, from: task.status, to }
      });
    }
    const terminal = isTerminalCollaborativeTaskStatus(to);
    return {
      ...task,
      status: to,
      updatedAt: at,
      ...(terminal
        ? {
            completedAt: task.completedAt ?? at,
            activeProviderTurnId: undefined,
            pendingInputRequestId: undefined,
            blockedOnActionId: undefined
          }
        : {})
    };
  }

  private applyEventToTask(
    task: CollaborativeTask,
    event: CollaborativeTaskEvent,
    at: string
  ): CollaborativeTask {
    let next = rememberEvent(task, event.eventId, event.type);

    // continuationSeq increments at most once per applied eventId (idempotency via appliedEvents).
    if (event.type === "reserve_continuation" || event.reserveContinuation === true) {
      next = { ...next, continuationSeq: next.continuationSeq + 1, updatedAt: at };
    }

    switch (event.type) {
      case "wait_for_input": {
        const inputRequestId = InputRequestIdSchema.parse(event.inputRequestId ?? event.sourceRef);
        next = this.transition(next, "waiting_for_input", at);
        next = {
          ...next,
          pendingInputRequestId: inputRequestId,
          blockedOnActionId: undefined,
          updatedAt: at
        };
        next = appendChildRef(next, "input_request", inputRequestId, at);
        break;
      }
      case "resume_from_input": {
        next = this.transition(next, "working", at);
        next = {
          ...next,
          pendingInputRequestId: undefined,
          blockedOnActionId: undefined,
          updatedAt: at
        };
        break;
      }
      case "block_on_action": {
        const actionId = ActionIdSchema.parse(event.actionId ?? event.sourceRef) as ActionId;
        next = this.transition(next, "blocked_on_action", at);
        next = {
          ...next,
          blockedOnActionId: actionId,
          pendingInputRequestId: undefined,
          updatedAt: at
        };
        next = appendChildRef(next, "action", actionId, at);
        break;
      }
      case "resume_from_action": {
        next = this.transition(next, "working", at);
        next = {
          ...next,
          blockedOnActionId: undefined,
          pendingInputRequestId: undefined,
          updatedAt: at
        };
        break;
      }
      case "complete": {
        if (!event.result) {
          throw createPairMeshError({
            code: "pairmesh.collaborative_task_invariant_violation",
            message: "complete event requires result.",
            details: { taskId: task.taskId, eventId: event.eventId }
          });
        }
        next = this.transition(next, "completed", at);
        next = { ...next, result: event.result as CollaborativeTaskResult, failure: undefined };
        break;
      }
      case "fail": {
        if (!event.failure) {
          throw createPairMeshError({
            code: "pairmesh.collaborative_task_invariant_violation",
            message: "fail event requires failure.",
            details: { taskId: task.taskId, eventId: event.eventId }
          });
        }
        next = this.transition(next, "failed", at);
        next = { ...next, failure: event.failure as CollaborativeTaskFailure, result: undefined };
        break;
      }
      case "cancel": {
        next = this.transition(next, "cancelled", at);
        break;
      }
      case "timeout": {
        next = this.transition(next, "timed_out", at);
        break;
      }
      case "append_child": {
        const kind = CollaborativeTaskChildKindSchema.parse(event.childKind);
        const childId = event.childId ?? event.sourceRef;
        if (!childId) {
          throw createPairMeshError({
            code: "pairmesh.collaborative_task_invariant_violation",
            message: "append_child requires childId.",
            details: { taskId: task.taskId, eventId: event.eventId }
          });
        }
        // Fail-closed conflict / same-kind idempotency before kind-specific id schemas,
        // so reuse of an id string under an incompatible kind is rejected even when
        // prefixes would otherwise fail validation.
        const existingChild = next.childRefs.find((ref) => ref.id === childId);
        if (existingChild) {
          next = appendChildRef(next, kind, childId, at);
          next = { ...next, updatedAt: at };
          break;
        }
        if (kind === "provider_turn") {
          ProviderTurnIdSchema.parse(childId);
        } else if (kind === "input_request") {
          InputRequestIdSchema.parse(childId);
        } else if (kind === "action") {
          ActionIdSchema.parse(childId);
        }
        next = appendChildRef(next, kind, childId, at);
        next = { ...next, updatedAt: at };
        break;
      }
      case "reserve_continuation": {
        break;
      }
      case "set_active_provider_turn": {
        const turnId = ProviderTurnIdSchema.parse(
          event.providerTurnId ?? event.sourceRef
        ) as ProviderTurnId;
        if (isTerminalCollaborativeTaskStatus(next.status)) {
          throw createPairMeshError({
            code: "pairmesh.collaborative_task_invalid_transition",
            message: "Cannot set active provider turn on a terminal task.",
            details: { taskId: task.taskId, status: next.status }
          });
        }
        next = {
          ...next,
          activeProviderTurnId: turnId,
          updatedAt: at
        };
        next = appendChildRef(next, "provider_turn", turnId, at);
        break;
      }
      case "clear_active_provider_turn": {
        next = { ...next, activeProviderTurnId: undefined, updatedAt: at };
        break;
      }
      default: {
        const _exhaustive: never = event.type;
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_invariant_violation",
          message: `Unsupported event type: ${String(_exhaustive)}`
        });
      }
    }

    return next;
  }
}

export function mintCollaborativeTaskEventId(): string {
  return `tevt_${randomUUID()}`;
}
