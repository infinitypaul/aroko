import { createHash, randomUUID } from "node:crypto";
import {
  COLLABORATIVE_TASK_MAX_APPLIED_EVENT_IDS,
  COLLABORATIVE_TASK_MAX_CONTINUATION_TURNS,
  CONTINUATION_MAX_PROCESS_OUTPUT_CHARS,
  CONTINUATION_MAX_SUMMARY_CHARS,
  CollaborativeTaskIdSchema,
  CollaborativeTaskSchema,
  ContinuationEventSchema,
  FirstTurnEnvelopeSchema,
  ProviderTurnIdSchema,
  ProviderTurnSchema,
  SafeContinuationEnvelopeSchema,
  actionStatusToContinuationType,
  canTransitionCollaborativeTaskStatus,
  createPairMeshError,
  isTerminalCollaborativeTaskStatus,
  isTerminalProviderTurnStatus,
  mintActionObservationKey,
  mintRestartObservationKey,
  type ActionExecutionRecord,
  type CollaborativeTask,
  type CollaborativeTaskProgressPhase,
  type ContinuationEvent,
  type ContinuationEventType,
  type ContinuationStructuredResult,
  type PairMeshHostRequestToolName,
  type ProviderTurn,
  type TaskWorkerEnvelope
} from "@pairmesh/protocol";
import type { ActionService } from "../action/service.js";
import type { LocalSessionState } from "../session/schemas.js";
import type { LocalStateStore } from "../state/store.js";
import { mintCollaborativeTaskEventId } from "./collaborative-task-service.js";
import { HostRequestBridge, mintHostToolCallId } from "./host-request-service.js";

export type TaskWorkerTurnResult =
  | { kind: "completed"; summary: string }
  | { kind: "failed"; code: string; message: string }
  | {
      kind: "host_request";
      toolName: PairMeshHostRequestToolName;
      args: unknown;
      checkpointSummary?: string;
    }
  | { kind: "cancelled" };

export interface TaskWorker {
  runTurn(envelope: TaskWorkerEnvelope): Promise<TaskWorkerTurnResult>;
}

export interface ContinuationOrchestratorOptions {
  stateStore: LocalStateStore;
  actionService: ActionService;
  hostBridge: HostRequestBridge;
  worker: TaskWorker;
  /** Optional opaque local provider session handle — never sent in envelopes. */
  providerSessionRef?: string | null;
}

export interface DispatchTurnResult {
  taskId: string;
  providerTurnId: string;
  continuationEventId?: string;
  turnResult: TaskWorkerTurnResult;
  taskStatus: CollaborativeTask["status"];
}

export interface ProgressPhaseRecord {
  taskId: string;
  phase: CollaborativeTaskProgressPhase;
  at: string;
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function argsDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundChars(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return value.slice(0, max);
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

function replaceTurnInPlace(state: LocalSessionState, turn: ProviderTurn): void {
  if (!state.providerTurns) {
    state.providerTurns = [];
  }
  const idx = state.providerTurns.findIndex(
    (entry) => entry.providerTurnId === turn.providerTurnId
  );
  if (idx >= 0) {
    state.providerTurns[idx] = turn;
  } else {
    state.providerTurns.push(turn);
    while (state.providerTurns.length > 200) {
      state.providerTurns.shift();
    }
  }
}

function replaceContinuationInPlace(state: LocalSessionState, event: ContinuationEvent): void {
  if (!state.continuationEvents) {
    state.continuationEvents = [];
  }
  const idx = state.continuationEvents.findIndex((entry) => entry.eventId === event.eventId);
  if (idx >= 0) {
    state.continuationEvents[idx] = event;
  } else {
    state.continuationEvents.push(event);
    while (state.continuationEvents.length > 200) {
      state.continuationEvents.shift();
    }
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

function countProviderTurnChildren(task: CollaborativeTask): number {
  return task.childRefs.filter((ref) => ref.kind === "provider_turn").length;
}

function assertContinuationTurnBudget(task: CollaborativeTask, mode: "start" | "continue"): void {
  const providerTurnCount = countProviderTurnChildren(task);
  if (providerTurnCount >= COLLABORATIVE_TASK_MAX_CONTINUATION_TURNS) {
    throw createPairMeshError({
      code: "pairmesh.collaborative_task_limit",
      message: `CollaborativeTask may have at most ${COLLABORATIVE_TASK_MAX_CONTINUATION_TURNS} provider turns.`,
      details: {
        taskId: task.taskId,
        providerTurnCount,
        maxContinuationTurns: COLLABORATIVE_TASK_MAX_CONTINUATION_TURNS
      }
    });
  }
  if (mode === "continue" && task.continuationSeq >= COLLABORATIVE_TASK_MAX_CONTINUATION_TURNS) {
    throw createPairMeshError({
      code: "pairmesh.collaborative_task_limit",
      message: `CollaborativeTask continuationSeq may not exceed ${COLLABORATIVE_TASK_MAX_CONTINUATION_TURNS}.`,
      details: {
        taskId: task.taskId,
        continuationSeq: task.continuationSeq,
        maxContinuationTurns: COLLABORATIVE_TASK_MAX_CONTINUATION_TURNS
      }
    });
  }
}

function appendProviderTurnChild(
  task: CollaborativeTask,
  providerTurnId: string,
  at: string
): CollaborativeTask {
  if (task.childRefs.some((ref) => ref.id === providerTurnId)) {
    return task;
  }
  return {
    ...task,
    childRefs: [...task.childRefs, { kind: "provider_turn" as const, id: providerTurnId, at }]
  };
}

function requireTask(state: LocalSessionState, taskId: string): CollaborativeTask {
  const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === taskId);
  if (!task) {
    throw createPairMeshError({
      code: "pairmesh.collaborative_task_not_found",
      message: `CollaborativeTask ${taskId} not found.`,
      details: { taskId }
    });
  }
  return task;
}

function buildActionStructuredResult(
  execution: ActionExecutionRecord
): ContinuationStructuredResult {
  const outputs = execution.result?.outputs ?? {};
  const structured: ContinuationStructuredResult = {
    actionId: execution.actionId,
    status: execution.status
  };
  if (typeof outputs.exitCode === "number" || outputs.exitCode === null) {
    structured.exitCode = outputs.exitCode;
  }
  if (typeof outputs.timedOut === "boolean") {
    structured.timedOut = outputs.timedOut;
  }
  if (typeof outputs.processPassed === "boolean") {
    structured.processPassed = outputs.processPassed;
  }
  if (typeof outputs.stdout === "string") {
    structured.stdoutSafe = boundChars(outputs.stdout, CONTINUATION_MAX_PROCESS_OUTPUT_CHARS);
  }
  if (typeof outputs.stderr === "string") {
    structured.stderrSafe = boundChars(outputs.stderr, CONTINUATION_MAX_PROCESS_OUTPUT_CHARS);
  }
  if (typeof execution.result?.summary === "string") {
    structured.summary = boundChars(execution.result.summary, CONTINUATION_MAX_SUMMARY_CHARS);
  }
  if (execution.result?.unknownOutcome === true || execution.status === "unknown_outcome") {
    structured.unknownOutcome = true;
  }
  const artifactId =
    execution.result?.artifactRefs?.[0]?.artifactId ?? execution.artifactRefs?.[0]?.artifactId;
  if (typeof artifactId === "string") {
    structured.artifactId = artifactId;
  }
  return structured;
}

function actionSafeSummary(type: ContinuationEventType, execution: ActionExecutionRecord): string {
  switch (type) {
    case "ACTION_COMPLETED":
      return boundChars(
        execution.result?.summary ?? `Action ${execution.actionId} completed.`,
        CONTINUATION_MAX_SUMMARY_CHARS
      );
    case "ACTION_DENIED":
      return `Action ${execution.actionId} was denied.`;
    case "ACTION_FAILED":
      return boundChars(
        execution.error?.message ??
          execution.result?.summary ??
          `Action ${execution.actionId} failed.`,
        CONTINUATION_MAX_SUMMARY_CHARS
      );
    case "ACTION_CANCELLED":
      return `Action ${execution.actionId} was cancelled.`;
    case "ACTION_UNKNOWN_OUTCOME":
      return `Action ${execution.actionId} ended with unknown_outcome; do not replay.`;
    default:
      return `Action ${execution.actionId} resolved (${type}).`;
  }
}

/**
 * Receiver-local continuation orchestrator (R5-5).
 * Does not construct a LocalStateStore. Does not wire production providers.
 */
export class ContinuationOrchestrator {
  private readonly stateStore: LocalStateStore;
  private readonly actionService: ActionService;
  private readonly hostBridge: HostRequestBridge;
  private worker: TaskWorker;
  private readonly providerSessionRef: string | null;

  /** In-memory progress phases for later R5-7 projection. */
  public readonly progressPhases: ProgressPhaseRecord[] = [];

  public constructor(options: ContinuationOrchestratorOptions) {
    this.stateStore = options.stateStore;
    this.actionService = options.actionService;
    this.hostBridge = options.hostBridge;
    this.worker = options.worker;
    this.providerSessionRef = options.providerSessionRef ?? null;
  }

  /** Swap Fake/provider worker (e.g. new process instance after restart). */
  public setWorker(worker: TaskWorker): void {
    this.worker = worker;
  }

  public recordProgress(taskId: string, phase: CollaborativeTaskProgressPhase, now?: Date): void {
    this.progressPhases.push({
      taskId: CollaborativeTaskIdSchema.parse(taskId),
      phase,
      at: nowIso(now)
    });
  }

  public async listContinuationEvents(taskId: string): Promise<ContinuationEvent[]> {
    const tid = CollaborativeTaskIdSchema.parse(taskId);
    const state = await this.stateStore.load();
    return (state?.continuationEvents ?? []).filter((entry) => entry.taskId === tid);
  }

  public async listProviderTurns(taskId: string): Promise<ProviderTurn[]> {
    const tid = CollaborativeTaskIdSchema.parse(taskId);
    const state = await this.stateStore.load();
    return (state?.providerTurns ?? []).filter((entry) => entry.taskId === tid);
  }

  /**
   * Observe a terminal Action and, when the task is blocked on it, persist one
   * ContinuationEvent + resume to working. Does not replay the Action.
   */
  public async observeActionTerminal(
    execution: ActionExecutionRecord,
    now?: Date
  ): Promise<ContinuationEvent | null> {
    const continuationType = actionStatusToContinuationType(execution.status);
    if (!continuationType) {
      return null;
    }
    if (!execution.taskId) {
      return null;
    }
    const at = nowIso(now);
    const observationKey = mintActionObservationKey(execution.actionId, execution.status);

    return this.stateStore.mutate((state) => {
      const task = (state.collaborativeTasks ?? []).find(
        (entry) => entry.taskId === execution.taskId
      );
      if (!task) {
        return null;
      }
      if (isTerminalCollaborativeTaskStatus(task.status)) {
        return null;
      }

      if (!state.continuationEvents) {
        state.continuationEvents = [];
      }

      const actionEvents = state.continuationEvents.filter(
        (entry) =>
          entry.taskId === task.taskId &&
          entry.sourceRef === execution.actionId &&
          entry.type.startsWith("ACTION_")
      );
      const conflicting = actionEvents.find((entry) => entry.type !== continuationType);
      if (conflicting) {
        throw createPairMeshError({
          code: "pairmesh.continuation_event_conflict",
          message: `Conflicting ACTION_* continuation for ${execution.actionId}.`,
          details: {
            actionId: execution.actionId,
            priorType: conflicting.type,
            observedType: continuationType
          }
        });
      }

      const priorSame = state.continuationEvents.find(
        (entry) => entry.observationKey === observationKey
      );
      if (priorSame) {
        if (priorSame.type !== continuationType) {
          throw createPairMeshError({
            code: "pairmesh.continuation_event_conflict",
            message: "Action observation key already used with a different continuation type.",
            details: {
              observationKey,
              priorType: priorSame.type,
              observedType: continuationType
            }
          });
        }
        return priorSame;
      }

      if (task.status !== "blocked_on_action" || task.blockedOnActionId !== execution.actionId) {
        return null;
      }

      const eventId = mintCollaborativeTaskEventId();
      const nextSeq = task.continuationSeq + 1;
      if (!canTransitionCollaborativeTaskStatus(task.status, "working")) {
        throw createPairMeshError({
          code: "pairmesh.collaborative_task_invalid_transition",
          message: `Cannot resume task from ${task.status} after Action terminal.`,
          details: { taskId: task.taskId, status: task.status }
        });
      }

      let nextTask = rememberTaskEvent(task, eventId, "resume_from_action");
      nextTask = CollaborativeTaskSchema.parse({
        ...nextTask,
        status: "working",
        blockedOnActionId: undefined,
        pendingInputRequestId: undefined,
        continuationSeq: nextSeq,
        updatedAt: at
      });

      const continuation = ContinuationEventSchema.parse({
        eventId,
        taskId: task.taskId,
        type: continuationType,
        sourceRef: execution.actionId,
        safeSummary: actionSafeSummary(continuationType, execution),
        structuredResult: buildActionStructuredResult(execution),
        occurredAt: at,
        continuationSeq: nextSeq,
        observationKey
      });

      state.continuationEvents.push(continuation);
      while (state.continuationEvents.length > 200) {
        state.continuationEvents.shift();
      }
      replaceTaskInPlace(state, nextTask);
      this.recordProgress(task.taskId, "owner_resolved_action", now);
      return continuation;
    });
  }

  /** Scan ActionService/store terminals and apply observeActionTerminal. */
  public async reconcileActionContinuations(now?: Date): Promise<ContinuationEvent[]> {
    const state = await this.stateStore.load();
    if (!state) {
      return [];
    }
    const applied: ContinuationEvent[] = [];
    for (const execution of state.actionExecutions ?? []) {
      if (!actionStatusToContinuationType(execution.status)) {
        continue;
      }
      // Prefer latest store record (ActionService may have an in-memory copy).
      const latest = this.actionService.findExecution(state, execution.actionId) ?? execution;
      const event = await this.observeActionTerminal(latest, now);
      if (event && !applied.some((entry) => entry.eventId === event.eventId)) {
        applied.push(event);
      }
    }
    return applied;
  }

  public async startTaskTurn(taskId: string, now?: Date): Promise<DispatchTurnResult> {
    const tid = CollaborativeTaskIdSchema.parse(taskId);
    const at = nowIso(now);
    const providerTurnId = mintProviderTurnId();

    const reserved = await this.stateStore.mutate((state) => {
      const task = requireTask(state, tid);
      if (task.status !== "working" || task.continuationSeq !== 0) {
        throw createPairMeshError({
          code: "pairmesh.provider_turn_not_allowed",
          message: "startTaskTurn requires working task with continuationSeq 0.",
          details: {
            taskId: tid,
            status: task.status,
            continuationSeq: task.continuationSeq
          }
        });
      }
      if (task.activeProviderTurnId) {
        throw createPairMeshError({
          code: "pairmesh.provider_turn_conflict",
          message: "Task already has an active ProviderTurn.",
          details: { taskId: tid, activeProviderTurnId: task.activeProviderTurnId }
        });
      }
      assertContinuationTurnBudget(task, "start");

      const turn = ProviderTurnSchema.parse({
        providerTurnId,
        taskId: tid,
        status: "running",
        startedAt: at,
        ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
      });

      let nextTask = appendProviderTurnChild(task, providerTurnId, at);
      nextTask = CollaborativeTaskSchema.parse({
        ...nextTask,
        activeProviderTurnId: providerTurnId,
        updatedAt: at
      });

      replaceTurnInPlace(state, turn);
      replaceTaskInPlace(state, nextTask);
      return { task: nextTask, turn };
    });

    this.recordProgress(tid, "working_on_request", now);

    const envelope = FirstTurnEnvelopeSchema.parse({
      taskId: tid,
      providerTurnId,
      continuationSeq: 0,
      originalGoal: reserved.task.originalGoal,
      kind: "first_turn"
    }) as TaskWorkerEnvelope;

    const turnResult = await this.worker.runTurn(envelope);
    return this.finishTurn(tid, providerTurnId, turnResult, now);
  }

  public async continueTask(
    taskId: string,
    continuationEventId?: string,
    now?: Date
  ): Promise<DispatchTurnResult> {
    const tid = CollaborativeTaskIdSchema.parse(taskId);
    const at = nowIso(now);
    const providerTurnId = mintProviderTurnId();

    const reserved = await this.stateStore.mutate((state) => {
      const task = requireTask(state, tid);
      if (isTerminalCollaborativeTaskStatus(task.status)) {
        throw createPairMeshError({
          code: "pairmesh.provider_turn_not_allowed",
          message: "Cannot continue a terminal CollaborativeTask.",
          details: { taskId: tid, status: task.status }
        });
      }
      if (task.status !== "working") {
        throw createPairMeshError({
          code: "pairmesh.provider_turn_not_allowed",
          message: `continueTask requires working status (got ${task.status}).`,
          details: { taskId: tid, status: task.status }
        });
      }
      if (task.activeProviderTurnId) {
        throw createPairMeshError({
          code: "pairmesh.provider_turn_conflict",
          message: "Task already has an active ProviderTurn.",
          details: { taskId: tid, activeProviderTurnId: task.activeProviderTurnId }
        });
      }
      assertContinuationTurnBudget(task, "continue");

      const events = (state.continuationEvents ?? []).filter((entry) => entry.taskId === tid);
      let event: ContinuationEvent | undefined;
      if (continuationEventId) {
        event = events.find((entry) => entry.eventId === continuationEventId);
        if (!event) {
          throw createPairMeshError({
            code: "pairmesh.collaborative_task_not_found",
            message: `ContinuationEvent ${continuationEventId} not found for task.`,
            details: { taskId: tid, continuationEventId }
          });
        }
      } else {
        event = events
          .filter((entry) => !entry.consumedByProviderTurnId)
          .sort((a, b) => a.continuationSeq - b.continuationSeq)[0];
      }
      if (!event) {
        throw createPairMeshError({
          code: "pairmesh.provider_turn_not_allowed",
          message: "No unconsumed ContinuationEvent available for continueTask.",
          details: { taskId: tid }
        });
      }
      if (event.consumedByProviderTurnId) {
        throw createPairMeshError({
          code: "pairmesh.continuation_already_consumed",
          message: `ContinuationEvent ${event.eventId} already consumed.`,
          details: {
            eventId: event.eventId,
            consumedByProviderTurnId: event.consumedByProviderTurnId
          }
        });
      }
      if (event.type === "TASK_CANCELLED") {
        throw createPairMeshError({
          code: "pairmesh.provider_turn_not_allowed",
          message: "TASK_CANCELLED events do not start provider turns.",
          details: { eventId: event.eventId }
        });
      }

      const consumed = ContinuationEventSchema.parse({
        ...event,
        consumedByProviderTurnId: providerTurnId
      });

      const turn = ProviderTurnSchema.parse({
        providerTurnId,
        taskId: tid,
        status: "running",
        startedAt: at,
        continuationEventId: event.eventId,
        ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
      });

      let nextTask = appendProviderTurnChild(task, providerTurnId, at);
      nextTask = CollaborativeTaskSchema.parse({
        ...nextTask,
        activeProviderTurnId: providerTurnId,
        updatedAt: at
      });

      replaceContinuationInPlace(state, consumed);
      replaceTurnInPlace(state, turn);
      replaceTaskInPlace(state, nextTask);

      const priorTurns = (state.providerTurns ?? [])
        .filter(
          (entry) =>
            entry.taskId === tid &&
            entry.providerTurnId !== providerTurnId &&
            entry.status === "completed" &&
            entry.checkpointSummary
        )
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const previousCheckpoint = priorTurns.at(-1)?.checkpointSummary;

      return {
        task: nextTask,
        turn,
        event: consumed,
        previousCheckpoint
      };
    });

    this.recordProgress(tid, "continuing_work", now);
    if (reserved.event.type === "REQUESTER_INPUT_RECEIVED") {
      this.recordProgress(tid, "requester_answered", now);
    }

    const envelope = SafeContinuationEnvelopeSchema.parse({
      taskId: tid,
      providerTurnId,
      continuationSeq: reserved.event.continuationSeq,
      originalGoal: reserved.task.originalGoal,
      ...(reserved.previousCheckpoint ? { previousCheckpoint: reserved.previousCheckpoint } : {}),
      event: {
        type: reserved.event.type,
        sourceRef: reserved.event.sourceRef,
        safeSummary: reserved.event.safeSummary,
        ...(reserved.event.structuredResult
          ? { structuredResult: reserved.event.structuredResult }
          : {})
      }
    });

    const turnResult = await this.worker.runTurn({
      ...envelope,
      kind: "continuation"
    });
    return this.finishTurn(tid, providerTurnId, turnResult, now, reserved.event.eventId);
  }

  /**
   * After process restart: reconcile Action terminals, then settle orphaned
   * active ProviderTurns (child created → complete turn; else fail + optional
   * TASK_RESUMED_AFTER_RESTART).
   */
  public async recoverAfterRestart(now?: Date): Promise<void> {
    await this.reconcileActionContinuations(now);
    const at = nowIso(now);

    await this.stateStore.mutate((state) => {
      const turns = [...(state.providerTurns ?? [])];
      for (const turn of turns) {
        if (isTerminalProviderTurnStatus(turn.status)) {
          continue;
        }
        const task = (state.collaborativeTasks ?? []).find((entry) => entry.taskId === turn.taskId);
        if (!task) {
          continue;
        }

        const childAfterTurn = task.childRefs.find(
          (ref) =>
            (ref.kind === "action" || ref.kind === "input_request") && ref.at >= turn.startedAt
        );

        if (childAfterTurn) {
          const completed = ProviderTurnSchema.parse({
            ...turn,
            status: "completed",
            endedAt: at,
            checkpointSummary: boundChars(
              `Recovered after restart; child ${childAfterTurn.kind} ${childAfterTurn.id} already created.`,
              CONTINUATION_MAX_SUMMARY_CHARS
            )
          });
          replaceTurnInPlace(state, completed);
          if (task.activeProviderTurnId === turn.providerTurnId) {
            replaceTaskInPlace(
              state,
              CollaborativeTaskSchema.parse({
                ...task,
                activeProviderTurnId: undefined,
                updatedAt: at
              })
            );
          }
          continue;
        }

        const failed = ProviderTurnSchema.parse({
          ...turn,
          status: "failed",
          endedAt: at,
          checkpointSummary: "Provider turn interrupted before durable child create."
        });
        replaceTurnInPlace(state, failed);

        let nextTask = task;
        if (task.activeProviderTurnId === turn.providerTurnId) {
          nextTask = {
            ...nextTask,
            activeProviderTurnId: undefined,
            updatedAt: at
          };
        }

        if (nextTask.status === "working" && !isTerminalCollaborativeTaskStatus(nextTask.status)) {
          const observationKey = mintRestartObservationKey(nextTask.taskId, turn.providerTurnId);
          if (!state.continuationEvents) {
            state.continuationEvents = [];
          }
          const prior = state.continuationEvents.find(
            (entry) => entry.observationKey === observationKey
          );
          if (!prior) {
            const eventId = mintCollaborativeTaskEventId();
            const nextSeq = nextTask.continuationSeq + 1;
            nextTask = rememberTaskEvent(nextTask, eventId, "reserve_continuation");
            nextTask = CollaborativeTaskSchema.parse({
              ...nextTask,
              continuationSeq: nextSeq,
              updatedAt: at
            });
            const restartEvent = ContinuationEventSchema.parse({
              eventId,
              taskId: nextTask.taskId,
              type: "TASK_RESUMED_AFTER_RESTART",
              sourceRef: turn.providerTurnId,
              safeSummary: "Provider turn interrupted; task resumed after restart.",
              structuredResult: {
                crashedProviderTurnId: turn.providerTurnId
              },
              occurredAt: at,
              continuationSeq: nextSeq,
              observationKey
            });
            state.continuationEvents.push(restartEvent);
            while (state.continuationEvents.length > 200) {
              state.continuationEvents.shift();
            }
          }
        }

        replaceTaskInPlace(state, CollaborativeTaskSchema.parse(nextTask));
      }
    });
  }

  private async finishTurn(
    taskId: string,
    providerTurnId: string,
    turnResult: TaskWorkerTurnResult,
    now?: Date,
    continuationEventId?: string
  ): Promise<DispatchTurnResult> {
    const at = nowIso(now);

    if (turnResult.kind === "host_request") {
      const state = await this.stateStore.load();
      if (!state) {
        throw createPairMeshError({
          code: "pairmesh.session_not_found",
          message: "No local PairMesh session found."
        });
      }
      const task = requireTask(state, taskId);
      const hostToolCallId = mintHostToolCallId();
      await this.hostBridge.invoke(
        turnResult.toolName,
        {
          taskId: CollaborativeTaskIdSchema.parse(taskId),
          sessionId: task.sessionId,
          requesterParticipantId: task.requesterParticipantId,
          ownerParticipantId: task.ownerParticipantId,
          providerTurnId: ProviderTurnIdSchema.parse(providerTurnId),
          hostToolCallId
        },
        turnResult.args
      );

      if (turnResult.toolName === "request_requester_input") {
        this.recordProgress(taskId, "needs_requester_input", now);
      } else {
        this.recordProgress(taskId, "waiting_for_owner_action", now);
      }

      const digest = argsDigest(turnResult.args);
      const checkpoint =
        turnResult.checkpointSummary ??
        boundChars(`Host request ${turnResult.toolName} created.`, CONTINUATION_MAX_SUMMARY_CHARS);

      const finalTask = await this.stateStore.mutate((s) => {
        const current = requireTask(s, taskId);
        const turn = (s.providerTurns ?? []).find(
          (entry) => entry.providerTurnId === providerTurnId
        );
        if (!turn) {
          throw createPairMeshError({
            code: "pairmesh.provider_turn_conflict",
            message: `ProviderTurn ${providerTurnId} missing during finish.`,
            details: { providerTurnId }
          });
        }
        if (isTerminalProviderTurnStatus(turn.status)) {
          throw createPairMeshError({
            code: "pairmesh.provider_turn_conflict",
            message: `ProviderTurn ${providerTurnId} is already terminal.`,
            details: { providerTurnId, status: turn.status }
          });
        }
        replaceTurnInPlace(
          s,
          ProviderTurnSchema.parse({
            ...turn,
            status: "completed",
            endedAt: at,
            toolRequest: { name: turnResult.toolName, argsDigest: digest },
            checkpointSummary: boundChars(checkpoint, CONTINUATION_MAX_SUMMARY_CHARS)
          })
        );
        const next = CollaborativeTaskSchema.parse({
          ...current,
          activeProviderTurnId: undefined,
          updatedAt: at
        });
        replaceTaskInPlace(s, next);
        return next;
      });

      return {
        taskId,
        providerTurnId,
        continuationEventId,
        turnResult,
        taskStatus: finalTask.status
      };
    }

    if (turnResult.kind === "completed") {
      this.recordProgress(taskId, "completed", now);
      const finalTask = await this.stateStore.mutate((s) => {
        const current = requireTask(s, taskId);
        const turn = (s.providerTurns ?? []).find(
          (entry) => entry.providerTurnId === providerTurnId
        );
        if (!turn || isTerminalProviderTurnStatus(turn.status)) {
          throw createPairMeshError({
            code: "pairmesh.provider_turn_conflict",
            message: `ProviderTurn ${providerTurnId} cannot complete.`,
            details: {
              providerTurnId,
              status: turn?.status ?? null
            }
          });
        }
        if (current.status !== "working") {
          throw createPairMeshError({
            code: "pairmesh.provider_turn_not_allowed",
            message: `Task must be working to complete (got ${current.status}).`,
            details: { taskId, status: current.status }
          });
        }
        replaceTurnInPlace(
          s,
          ProviderTurnSchema.parse({
            ...turn,
            status: "completed",
            endedAt: at,
            checkpointSummary: boundChars(turnResult.summary, CONTINUATION_MAX_SUMMARY_CHARS)
          })
        );
        const eventId = mintCollaborativeTaskEventId();
        let next = rememberTaskEvent(current, eventId, "complete");
        next = CollaborativeTaskSchema.parse({
          ...next,
          status: "completed",
          result: { summary: boundChars(turnResult.summary, 8_000) },
          failure: undefined,
          activeProviderTurnId: undefined,
          pendingInputRequestId: undefined,
          blockedOnActionId: undefined,
          completedAt: at,
          updatedAt: at
        });
        replaceTaskInPlace(s, next);
        return next;
      });
      return {
        taskId,
        providerTurnId,
        continuationEventId,
        turnResult,
        taskStatus: finalTask.status
      };
    }

    if (turnResult.kind === "failed") {
      this.recordProgress(taskId, "failed", now);
      const finalTask = await this.stateStore.mutate((s) => {
        const current = requireTask(s, taskId);
        const turn = (s.providerTurns ?? []).find(
          (entry) => entry.providerTurnId === providerTurnId
        );
        if (!turn || isTerminalProviderTurnStatus(turn.status)) {
          throw createPairMeshError({
            code: "pairmesh.provider_turn_conflict",
            message: `ProviderTurn ${providerTurnId} cannot fail.`,
            details: {
              providerTurnId,
              status: turn?.status ?? null
            }
          });
        }
        replaceTurnInPlace(
          s,
          ProviderTurnSchema.parse({
            ...turn,
            status: "failed",
            endedAt: at,
            checkpointSummary: boundChars(turnResult.message, CONTINUATION_MAX_SUMMARY_CHARS)
          })
        );
        if (current.status === "working") {
          const eventId = mintCollaborativeTaskEventId();
          let next = rememberTaskEvent(current, eventId, "fail");
          next = CollaborativeTaskSchema.parse({
            ...next,
            status: "failed",
            failure: {
              code: boundChars(turnResult.code, 120),
              message: boundChars(turnResult.message, 2_000)
            },
            result: undefined,
            activeProviderTurnId: undefined,
            pendingInputRequestId: undefined,
            blockedOnActionId: undefined,
            completedAt: at,
            updatedAt: at
          });
          replaceTaskInPlace(s, next);
          return next;
        }
        const cleared = CollaborativeTaskSchema.parse({
          ...current,
          activeProviderTurnId: undefined,
          updatedAt: at
        });
        replaceTaskInPlace(s, cleared);
        return cleared;
      });
      return {
        taskId,
        providerTurnId,
        continuationEventId,
        turnResult,
        taskStatus: finalTask.status
      };
    }

    // cancelled — clear active turn only; do not fail the task.
    this.recordProgress(taskId, "cancelled", now);
    const finalTask = await this.stateStore.mutate((s) => {
      const current = requireTask(s, taskId);
      const turn = (s.providerTurns ?? []).find((entry) => entry.providerTurnId === providerTurnId);
      if (!turn || isTerminalProviderTurnStatus(turn.status)) {
        throw createPairMeshError({
          code: "pairmesh.provider_turn_conflict",
          message: `ProviderTurn ${providerTurnId} cannot cancel.`,
          details: {
            providerTurnId,
            status: turn?.status ?? null
          }
        });
      }
      replaceTurnInPlace(
        s,
        ProviderTurnSchema.parse({
          ...turn,
          status: "cancelled",
          endedAt: at
        })
      );
      const next = CollaborativeTaskSchema.parse({
        ...current,
        activeProviderTurnId: undefined,
        updatedAt: at
      });
      replaceTaskInPlace(s, next);
      return next;
    });
    return {
      taskId,
      providerTurnId,
      continuationEventId,
      turnResult,
      taskStatus: finalTask.status
    };
  }
}

export function mintProviderTurnId(): string {
  return ProviderTurnIdSchema.parse(`pturn_${randomUUID()}`);
}
