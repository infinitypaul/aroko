import {
  PAIRMESH_METADATA_VERSION,
  PairMeshTaskWireRequestSchema,
  CollaborativeTaskIdSchema,
  createPairMeshError,
  type PairMeshTaskWireRequest,
  type PairMeshTaskWireResponse,
  type PeerId
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import { sendPairMeshTaskRequest } from "../a2a/task-client.js";
import type { ActionService } from "../action/service.js";
import { requireOutboundBearer } from "../auth/session-security.js";
import { configFilePath } from "../local-config/paths.js";
import { loadConfigFile } from "../local-config/resolver.js";
import type { LocalStateStore } from "../state/store.js";
import { CollaborativeTaskService } from "./collaborative-task-service.js";
import { ContinuationOrchestrator } from "./continuation-orchestrator.js";
import { createGoalTaskWorker, type GoalProviderId } from "./goal-task-worker.js";
import { HostRequestBridge } from "./host-request-service.js";
import { InputRequestService } from "./input-request-service.js";
import { FakeTaskWorker } from "./fake-task-worker.js";
import {
  buildRequesterSafeLinkedAction,
  resolveLinkedActionForTask
} from "./requester-action-mirror.js";

/** Relay ingress aborts local A2A fetch at 3s — keep wire ack well under that. */
export const TASK_WIRE_ACK_BUDGET_MS = 2_000;

/** Prefer returning a terminal/waiting wire view when the first turn finishes this quickly. */
export const TASK_WIRE_FAST_COMPLETE_MS = 750;

export interface ProcessPairMeshTaskWireContext {
  stateStore: LocalStateStore;
  participantId: PeerId;
  /** Required for task.goal first-turn start. */
  actionService?: ActionService;
  workspaceRoot?: string;
  goalProviderId?: GoalProviderId;
  /** Test-only Fake override for slow/scripted remote goal turns. */
  goalFakeWorker?: FakeTaskWorker;
}

/**
 * Resolve the receiver's goal-mode provider for remote task.goal turns.
 * Must match SessionManager.resolveGoalProviderId — otherwise Paul→Kelvin
 * goals silently run Fake and auto-complete without real host tools.
 */
export async function resolveRemoteGoalProviderId(input: {
  workspaceRoot?: string;
  override?: GoalProviderId;
}): Promise<GoalProviderId> {
  if (input.override) {
    return input.override;
  }
  const workspaceRoot = input.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return "fake";
  }
  try {
    const config = await loadConfigFile(configFilePath(workspaceRoot));
    const provider = config.codingAgent?.provider;
    if (
      provider === "claude-code" ||
      provider === "cursor" ||
      provider === "gemini-cli" ||
      provider === "fake"
    ) {
      return provider;
    }
  } catch {
    // fall through
  }
  return "fake";
}

function failure(
  taskId: string | undefined,
  error: ReturnType<typeof createPairMeshError>
): PairMeshTaskWireResponse {
  const parsed = taskId ? CollaborativeTaskIdSchema.safeParse(taskId) : null;
  const id = parsed?.success
    ? parsed.data
    : CollaborativeTaskIdSchema.parse(`task_${randomUUID()}`);
  return {
    metadataVersion: PAIRMESH_METADATA_VERSION,
    accepted: false,
    taskId: id,
    error
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildWireOrchestrator(input: {
  stateStore: LocalStateStore;
  actionService: ActionService;
  workspaceRoot: string;
  providerId: GoalProviderId;
  tasks: CollaborativeTaskService;
  inputs: InputRequestService;
  goalFakeWorker?: FakeTaskWorker;
}): ContinuationOrchestrator {
  const { stateStore, actionService, workspaceRoot, providerId, tasks, inputs, goalFakeWorker } =
    input;
  const worker = createGoalTaskWorker({
    providerId,
    workspaceRoot,
    ...(providerId === "fake"
      ? {
          fakeWorker:
            goalFakeWorker ??
            new FakeTaskWorker({
              instanceId: "wire-goal",
              script: [
                {
                  kind: "completed",
                  summary: "Remote goal accepted; Fake worker completed first turn."
                }
              ]
            })
        }
      : {}),
    disableCursorSessionReuse: true
  });
  const bridge = new HostRequestBridge({
    stateStore,
    actionService,
    deliverInputRequest: async ({ taskId, inputRequestId }) => {
      const state = await stateStore.load();
      if (!state || state.session.status !== "active") {
        return;
      }
      const task = await tasks.getTask(taskId);
      const inputRequest = await inputs.getInputRequest(inputRequestId);
      if (!task || !inputRequest) {
        return;
      }
      const requesterPeer = state.peers.find(
        (peer) => peer.participant.id === task.requesterParticipantId
      );
      if (!requesterPeer) {
        return;
      }
      let bearerToken: string;
      try {
        bearerToken = requireOutboundBearer(state, requesterPeer);
      } catch {
        return;
      }
      await sendPairMeshTaskRequest(
        requesterPeer.a2aAgentUrl,
        {
          metadataVersion: PAIRMESH_METADATA_VERSION,
          sessionId: state.session.id,
          operation: "input.deliver",
          taskId: task.taskId,
          inputRequest: inputs.toRequesterView(inputRequest),
          task: tasks.toRequesterView(task)
        },
        { bearerToken }
      );
    }
  });
  return new ContinuationOrchestrator({
    stateStore,
    actionService,
    hostBridge: bridge,
    worker
  });
}

async function successTaskView(
  tasks: CollaborativeTaskService,
  taskId: string,
  message: string
): Promise<PairMeshTaskWireResponse> {
  const latest = (await tasks.getTask(taskId))!;
  return {
    metadataVersion: PAIRMESH_METADATA_VERSION,
    accepted: true,
    taskId: latest.taskId,
    status: latest.status,
    continuationSeq: latest.continuationSeq,
    pendingInputRequestId: latest.pendingInputRequestId,
    task: tasks.toRequesterView(latest),
    message
  };
}

export async function processPairMeshTaskWireRequest(
  raw: PairMeshTaskWireRequest,
  context: ProcessPairMeshTaskWireContext
): Promise<PairMeshTaskWireResponse> {
  const request = PairMeshTaskWireRequestSchema.parse(raw);
  const inputs = new InputRequestService(context.stateStore);
  const tasks = new CollaborativeTaskService(context.stateStore);

  try {
    if (request.operation === "task.goal") {
      const state = await context.stateStore.load();
      if (!state) {
        return failure(
          request.taskId,
          createPairMeshError({
            code: "pairmesh.session_not_found",
            message: "No local PairMesh session found."
          })
        );
      }
      const localId = state.localParticipant.participant.id;
      const originalGoal = request.originalGoal!.trim();
      // Authenticated caller is the requester; local runtime is the owner/receiver.
      const created = await tasks.createTask({
        sessionId: state.session.id,
        requesterParticipantId: context.participantId,
        ownerParticipantId: localId,
        originalGoal
      });

      if (!context.actionService || !context.workspaceRoot) {
        // Task is durable; first turn deferred until receiver runtime can orchestrate.
        return {
          metadataVersion: PAIRMESH_METADATA_VERSION,
          accepted: true,
          taskId: created.taskId,
          status: created.status,
          continuationSeq: created.continuationSeq,
          task: tasks.toRequesterView(created),
          message:
            "CollaborativeTask created. Receiver orchestration start deferred (no ActionService/workspace in wire context)."
        };
      }

      const providerId = context.goalFakeWorker
        ? "fake"
        : await resolveRemoteGoalProviderId({
            workspaceRoot: context.workspaceRoot,
            override: context.goalProviderId
          });
      const orchestrator = buildWireOrchestrator({
        stateStore: context.stateStore,
        actionService: context.actionService,
        workspaceRoot: context.workspaceRoot,
        providerId,
        tasks,
        inputs,
        ...(context.goalFakeWorker ? { goalFakeWorker: context.goalFakeWorker } : {})
      });

      const turnPromise = orchestrator.startTaskTurn(created.taskId);
      const raced = await Promise.race([
        turnPromise.then((turn) => ({ kind: "done" as const, turn })),
        delay(TASK_WIRE_FAST_COMPLETE_MS).then(() => ({ kind: "pending" as const }))
      ]);

      if (raced.kind === "done") {
        return successTaskView(
          tasks,
          created.taskId,
          `Goal turn started (${raced.turn.turnResult.kind}).`
        );
      }

      void turnPromise.catch(() => {
        // Background provider failure remains durable on the CollaborativeTask.
      });

      return successTaskView(
        tasks,
        created.taskId,
        "Goal accepted; provider turn continuing on receiver (async ack)."
      );
    }

    if (request.operation === "input.deliver") {
      // Requester receives a safe InputRequest projection from the receiver owner.
      if (!request.inputRequest || !request.task) {
        return failure(
          request.taskId,
          createPairMeshError({
            code: "pairmesh.input_request_invalid",
            message: "input.deliver requires inputRequest and task projections."
          })
        );
      }
      if (
        request.inputRequest.taskId !== request.taskId ||
        request.task.taskId !== request.taskId
      ) {
        return failure(
          request.taskId,
          createPairMeshError({
            code: "pairmesh.input_request_invalid",
            message: "Delivered InputRequest/task ids must match wire taskId."
          })
        );
      }
      // Authenticated caller must be the task owner (receiver delivering to requester).
      if (request.task.ownerParticipantId !== context.participantId) {
        return failure(
          request.taskId,
          createPairMeshError({
            code: "pairmesh.permission_denied",
            message: "Only the task owner may deliver an InputRequest to the requester.",
            details: {
              participantId: context.participantId,
              ownerParticipantId: request.task.ownerParticipantId
            }
          })
        );
      }
      await inputs.upsertMirroredDeliver({
        task: request.task,
        inputRequest: request.inputRequest
      });
      return {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        accepted: true,
        taskId: request.taskId!,
        status: request.task.status,
        pendingInputRequestId: request.inputRequest.inputRequestId,
        continuationSeq: request.task.continuationSeq,
        inputRequest: request.inputRequest,
        task: request.task,
        message: "InputRequest delivered."
      };
    }

    if (request.operation === "input.answer") {
      const result = await inputs.answerInputRequest({
        taskId: request.taskId!,
        inputRequestId: request.inputRequestId!,
        answer: request.answer!,
        answeringParticipantId: context.participantId,
        answerEventId: request.answerEventId
      });
      const taskView = tasks.toRequesterView(result.task);
      const inputView = inputs.toRequesterView(result.inputRequest);

      // Auto-continue after remote answer — never hold this hop across a provider turn.
      if (context.actionService && context.workspaceRoot && result.task.status === "working") {
        const providerId = await resolveRemoteGoalProviderId({
          workspaceRoot: context.workspaceRoot,
          override: context.goalProviderId
        });
        const orchestrator = buildWireOrchestrator({
          stateStore: context.stateStore,
          actionService: context.actionService,
          workspaceRoot: context.workspaceRoot,
          providerId,
          tasks,
          inputs,
          ...(context.goalFakeWorker ? { goalFakeWorker: context.goalFakeWorker } : {})
        });
        void orchestrator.continueTask(result.task.taskId).catch(() => {
          // Continuation failure is persisted on the task / next status poll.
        });
      }

      return {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        accepted: true,
        taskId: request.taskId!,
        status: result.task.status,
        continuationSeq: result.task.continuationSeq,
        inputRequest: inputView,
        task: taskView,
        message: "InputRequest answered."
      };
    }

    // task.status
    const statusTaskId = request.taskId!;
    const task = await tasks.getTask(statusTaskId);
    if (!task) {
      return failure(
        statusTaskId,
        createPairMeshError({
          code: "pairmesh.collaborative_task_not_found",
          message: `CollaborativeTask ${statusTaskId} not found.`,
          details: { taskId: statusTaskId }
        })
      );
    }
    const isParty =
      task.requesterParticipantId === context.participantId ||
      task.ownerParticipantId === context.participantId;
    if (!isParty) {
      return failure(
        statusTaskId,
        createPairMeshError({
          code: "pairmesh.permission_denied",
          message: "Only task parties may read CollaborativeTask status.",
          details: { participantId: context.participantId, taskId: statusTaskId }
        })
      );
    }
    const taskView = tasks.toRequesterView(task);
    let inputView = undefined;
    if (task.pendingInputRequestId) {
      const pending = await inputs.getInputRequest(task.pendingInputRequestId);
      if (pending) {
        inputView = inputs.toRequesterView(pending);
      }
    } else if (request.inputRequestId) {
      const named = await inputs.getInputRequest(request.inputRequestId);
      if (named) {
        inputView = inputs.toRequesterView(named);
      }
    }

    // R5-R1: attach requester-safe linked Action snapshot when available.
    let linkedAction = undefined;
    const state = await context.stateStore.load();
    if (state) {
      const linked = resolveLinkedActionForTask(state, task);
      if (linked) {
        const ownerName =
          typeof state.localParticipant?.agent?.name === "string"
            ? state.localParticipant.agent.name.trim()
            : undefined;
        linkedAction = buildRequesterSafeLinkedAction(linked, {
          ...(ownerName ? { ownerDisplayName: ownerName } : {})
        });
      }
    }

    return {
      metadataVersion: PAIRMESH_METADATA_VERSION,
      accepted: true,
      taskId: statusTaskId,
      status: task.status,
      pendingInputRequestId: task.pendingInputRequestId,
      continuationSeq: task.continuationSeq,
      ...(inputView ? { inputRequest: inputView } : {}),
      task: taskView,
      ...(linkedAction ? { linkedAction } : {})
    };
  } catch (error) {
    const pairError =
      error && typeof error === "object" && "code" in error
        ? (error as ReturnType<typeof createPairMeshError>)
        : createPairMeshError({
            code: "pairmesh.internal_error",
            message: error instanceof Error ? error.message : "Task wire request failed."
          });
    return failure(request.taskId, pairError);
  }
}
