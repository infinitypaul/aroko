import {
  CONTINUATION_MAX_PROCESS_OUTPUT_CHARS,
  CONTINUATION_MAX_SUMMARY_CHARS,
  PAIRMESH_METADATA_VERSION,
  RequesterSafeLinkedActionSchema,
  type ActionExecutionRecord,
  type ActionId,
  type CollaborativeTask,
  type PairMeshActionWireSuccessResponse,
  type PeerId,
  type RequesterSafeLinkedAction
} from "@pairmesh/protocol";
import { projectOwnerProcessExecutionFromParameters } from "../action/process/owner-projection.js";
import { getActionTypeDefinition } from "../action/registry.js";
import { toWireActionView } from "../action/remote-handler.js";
import {
  buildActionMirrorFromWire,
  findActionExecution,
  upsertMirroredActionFromWire
} from "../action/session-bridge.js";
import type { LocalSessionState } from "../session/schemas.js";

const ABSOLUTE_PATH = /(?:^|[\s"'`=(])(\/(?:Users|home|tmp|var|etc|private)\/|[A-Za-z]:\\)/;
const SECRETISH = /\b(api[_-]?key|secret|token|password|bearer|authorization)\b/i;

function boundChars(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function mapOwnerDecision(
  status: ActionExecutionRecord["status"]
): RequesterSafeLinkedAction["ownerDecision"] {
  switch (status) {
    case "approval_required":
      return "pending_approval";
    case "denied":
      return "denied";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "unknown_outcome":
      return "unknown_outcome";
    case "completed":
    case "partially_completed":
      return "completed";
    case "authorizing":
    case "executing":
      return "approved";
    default:
      return "pending_approval";
  }
}

function waitingMessageFor(
  execution: ActionExecutionRecord,
  ownerDisplayName?: string
): string | undefined {
  if (execution.status !== "approval_required") {
    return undefined;
  }
  const name = ownerDisplayName?.trim() || "the owner";
  return `Waiting for ${name}'s approval.`;
}

function decisionMessage(execution: ActionExecutionRecord, ownerDisplayName?: string): string {
  const name = ownerDisplayName?.trim() || "The owner";
  switch (execution.status) {
    case "approval_required":
      return waitingMessageFor(execution, ownerDisplayName) ?? "Waiting for owner approval.";
    case "denied":
      return `${name} denied the requested action.`;
    case "cancelled":
      return `The requested action was cancelled.`;
    case "failed":
      return boundChars(
        execution.error?.message ?? execution.result?.summary ?? "The requested action failed.",
        CONTINUATION_MAX_SUMMARY_CHARS
      );
    case "unknown_outcome":
      return "Execution outcome is uncertain.";
    case "completed":
    case "partially_completed":
      return `${name} approved the requested action.`;
    case "authorizing":
    case "executing":
      return `${name} approved the requested action.`;
    default:
      return `Action status: ${execution.status}.`;
  }
}

function projectSafeResult(execution: ActionExecutionRecord): {
  resultSafe?: string;
  resultSuppressed?: boolean;
  exitCode?: number | null;
  unknownOutcome?: boolean;
} {
  if (execution.status === "unknown_outcome" || execution.result?.unknownOutcome === true) {
    return { unknownOutcome: true, resultSafe: "Execution outcome is uncertain." };
  }
  const outputs = execution.result?.outputs ?? {};
  const exitCode =
    typeof outputs.exitCode === "number" || outputs.exitCode === null
      ? (outputs.exitCode as number | null)
      : undefined;

  if (execution.status === "denied" || execution.status === "cancelled") {
    return { ...(exitCode !== undefined ? { exitCode } : {}) };
  }

  const stdout = typeof outputs.stdout === "string" ? outputs.stdout : undefined;
  if (!stdout) {
    if (execution.status === "completed" || execution.status === "partially_completed") {
      return {
        resultSuppressed: true,
        resultSafe: "Action completed. Technical output was not shared.",
        ...(exitCode !== undefined ? { exitCode } : {})
      };
    }
    return { ...(exitCode !== undefined ? { exitCode } : {}) };
  }

  if (ABSOLUTE_PATH.test(stdout) || SECRETISH.test(stdout)) {
    return {
      resultSuppressed: true,
      resultSafe: "Action completed. Technical output was not shared.",
      ...(exitCode !== undefined ? { exitCode } : {})
    };
  }

  return {
    resultSafe: boundChars(stdout, CONTINUATION_MAX_PROCESS_OUTPUT_CHARS),
    ...(exitCode !== undefined ? { exitCode } : {})
  };
}

/**
 * Build a requester-safe linked Action snapshot from an owner-local Action record.
 * Read-only projection — never includes Control tokens, abs paths, env, or CoT.
 */
export function buildRequesterSafeLinkedAction(
  execution: ActionExecutionRecord,
  options?: { ownerDisplayName?: string }
): RequesterSafeLinkedAction {
  const processView = projectOwnerProcessExecutionFromParameters(execution.parameters);
  const safeResult = projectSafeResult(execution);
  const summary = decisionMessage(execution, options?.ownerDisplayName);

  return RequesterSafeLinkedActionSchema.parse({
    actionId: execution.actionId,
    actionType: execution.actionType,
    status: execution.status,
    ownerDecision: mapOwnerDecision(execution.status),
    ...(execution.status === "approval_required"
      ? { waitingMessage: waitingMessageFor(execution, options?.ownerDisplayName) }
      : {}),
    summary,
    ...(processView
      ? {
          executableDisplay: processView.executable,
          argsDisplay: processView.args
        }
      : {}),
    ...safeResult,
    executorInvocationCount: execution.executorInvocationCount ?? 0,
    ...((execution.completedAt ?? execution.result?.completedAt)
      ? { completedAt: execution.completedAt ?? execution.result?.completedAt }
      : {}),
    updatedAt: execution.updatedAt
  });
}

/** Resolve the Action currently linked to a CollaborativeTask (blocked or latest child). */
export function resolveLinkedActionForTask(
  state: LocalSessionState,
  task: CollaborativeTask
): ActionExecutionRecord | undefined {
  if (task.blockedOnActionId) {
    const blocked = findActionExecution(state, task.blockedOnActionId);
    if (blocked) {
      return blocked;
    }
  }
  const actionRefs = [...(task.childRefs ?? [])].filter((ref) => ref.kind === "action").reverse();
  for (const ref of actionRefs) {
    const found = findActionExecution(state, ref.id as ActionId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Wire Action view for requester mirror upsert (sanitized outputs). */
export function toRequesterMirrorActionWire(
  execution: ActionExecutionRecord,
  ownerDisplayName?: string
): PairMeshActionWireSuccessResponse {
  return toWireActionView(execution, ownerDisplayName);
}

/**
 * Upsert a read-only Action mirror from a requester-safe linkedAction snapshot.
 * Idempotent by actionId. Never grants approve/deny/execute on the requester.
 */
export function upsertMirroredLinkedAction(
  state: LocalSessionState,
  linked: RequesterSafeLinkedAction,
  context: {
    requesterParticipantId: PeerId;
    targetParticipantId: PeerId;
    taskId: string;
  }
): { state: LocalSessionState; execution: ActionExecutionRecord } {
  const definition = getActionTypeDefinition(linked.actionType);
  const parameters: Record<string, string | number | boolean | string[] | null> =
    linked.executableDisplay && Array.isArray(linked.argsDisplay)
      ? {
          executable: linked.executableDisplay,
          args: linked.argsDisplay,
          cwd: ".",
          timeoutMs: 30_000
        }
      : {};
  const now = linked.updatedAt ?? new Date().toISOString();
  const outputs: Record<string, string | number | boolean | null> = {};
  if (typeof linked.resultSafe === "string" && !linked.resultSuppressed) {
    outputs.stdout = linked.resultSafe;
  }
  if (linked.exitCode !== undefined) {
    outputs.exitCode = linked.exitCode;
  }
  const wire: PairMeshActionWireSuccessResponse = {
    metadataVersion: PAIRMESH_METADATA_VERSION,
    accepted: true,
    actionId: linked.actionId,
    status: linked.status as ActionExecutionRecord["status"],
    summary: linked.summary,
    message: linked.waitingMessage ?? linked.summary,
    capabilityId: definition?.capabilityId ?? "process.execute",
    actionType: linked.actionType,
    requesterParticipantId: context.requesterParticipantId,
    targetParticipantId: context.targetParticipantId,
    createdAt: now,
    updatedAt: now,
    ...(linked.completedAt ? { completedAt: linked.completedAt } : {}),
    ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
    executorInvocationCount: linked.executorInvocationCount ?? 0
  };

  const record = buildActionMirrorFromWire(wire, {
    requesterParticipantId: context.requesterParticipantId,
    targetParticipantId: context.targetParticipantId,
    parameters
  });
  return upsertMirroredActionFromWire(state, {
    ...record,
    taskId: context.taskId as ActionExecutionRecord["taskId"],
    originProvenance: "receiver_agent"
  });
}
