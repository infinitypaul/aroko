import { type Message, type Task, TaskState } from "@a2a-js/sdk";
import {
  type InspectionRemoteTaskState,
  type PairMeshInspectProgressPayload,
  type PairMeshInspectionResponse
} from "@pairmesh/protocol";
import { parsePairMeshPayloadFromMessage } from "./pairing-messages.js";

const TERMINAL_TASK_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED
]);

const WORKING_TASK_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_SUBMITTED,
  TaskState.TASK_STATE_WORKING,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED
]);

export function normalizeA2ATaskState(state: TaskState | undefined): InspectionRemoteTaskState {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "submitted";
    case TaskState.TASK_STATE_WORKING:
      return "working";
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input_required";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "auth_required";
    default:
      return "unknown";
  }
}

export function isTerminalA2ATaskState(state: TaskState | undefined): boolean {
  return state !== undefined && TERMINAL_TASK_STATES.has(state);
}

export function isWorkingA2ATaskState(state: TaskState | undefined): boolean {
  return state === undefined || WORKING_TASK_STATES.has(state);
}

export function extractTaskId(result: Message | Task): string | undefined {
  if ("id" in result && typeof result.id === "string" && result.id.length > 0) {
    return result.id;
  }
  if ("taskId" in result && typeof result.taskId === "string" && result.taskId.length > 0) {
    return result.taskId;
  }
  return undefined;
}

export function extractInspectionResponseFromTask(
  task: Task
): PairMeshInspectionResponse | undefined {
  const candidates: Message[] = [];
  if (task.status?.message) {
    candidates.push(task.status.message);
  }
  if (task.history) {
    candidates.push(...task.history);
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    if (!message) {
      continue;
    }
    const envelope = parsePairMeshPayloadFromMessage(message);
    if (envelope?.type === "pairmesh.inspect.response") {
      return envelope.payload;
    }

    for (const part of message.parts ?? []) {
      if (part.content?.$case !== "text") {
        continue;
      }
      try {
        const parsedJson = JSON.parse(part.content.value) as unknown;
        if (
          typeof parsedJson === "object" &&
          parsedJson !== null &&
          "type" in parsedJson &&
          (parsedJson as { type?: string }).type === "pairmesh.inspect.response" &&
          "payload" in parsedJson
        ) {
          return (parsedJson as { payload: PairMeshInspectionResponse }).payload;
        }
      } catch {
        // try next part
      }
    }
  }

  return undefined;
}

export function extractInspectProgressFromTask(
  task: Task
): PairMeshInspectProgressPayload | undefined {
  const candidates: Message[] = [];
  if (task.status?.message) {
    candidates.push(task.status.message);
  }
  if (task.history) {
    candidates.push(...task.history);
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    if (!message) {
      continue;
    }
    const envelope = parsePairMeshPayloadFromMessage(message);
    if (envelope?.type === "pairmesh.inspect.progress") {
      return envelope.payload;
    }
  }
  return undefined;
}

export function mapRemoteTaskStateToExecutionStatus(
  remoteState: InspectionRemoteTaskState
): "running" | "completed" | "failed" | "timed_out" | "cancelled" {
  switch (remoteState) {
    case "completed":
      return "completed";
    case "failed":
    case "rejected":
      return "failed";
    case "canceled":
      return "cancelled";
    default:
      return "running";
  }
}
