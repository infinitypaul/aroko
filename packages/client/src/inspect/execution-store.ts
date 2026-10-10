import {
  InspectionExecutionRecordSchema,
  IsoUtcTimestampSchema,
  PAIRMESH_PERMISSION_REQUEST_TTL_MS,
  type InspectionExecutionRecord,
  type InspectionExecutionResult,
  type InspectionExecutionStatus,
  type InspectionLocalWaitState,
  type InspectionProgressEvent,
  type InspectionProgressPhase,
  type InspectionRemoteTaskState
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";
import type { LocalSessionState } from "../session/schemas.js";

const MAX_EXECUTIONS = 50;

/**
 * Hard ACP/remote deadline clock. Permission wait uses `startedAt` only; the
 * 120s budget starts when remote execution actually begins.
 */
export function inspectionExecutionDeadlineStartMs(
  record: InspectionExecutionRecord
): number | undefined {
  if (record.executionStartedAt) {
    return Date.parse(record.executionStartedAt);
  }
  // Legacy records: remote work already attached without an explicit clock.
  if (record.a2aTaskReference) {
    return Date.parse(record.startedAt);
  }
  return undefined;
}

export function createExecutionRecord(input: {
  threadId: string;
  peerId: string;
  peerName: string;
  turnNumber: number;
  question: string;
  requestId?: string;
  retryOfRequestId?: string;
  peerAgentUrl?: string;
}): InspectionExecutionRecord {
  const now = nowUtc();
  const requestId = input.requestId ?? `req_${randomUUID()}`;
  return InspectionExecutionRecordSchema.parse({
    requestId,
    threadId: input.threadId,
    peerId: input.peerId,
    peerName: input.peerName,
    turnNumber: input.turnNumber,
    question: input.question,
    status: "pending",
    phase: "accepted",
    message: "Inspection accepted.",
    startedAt: now,
    updatedAt: now,
    ...(input.peerAgentUrl ? { peerAgentUrl: input.peerAgentUrl } : {}),
    ...(input.retryOfRequestId ? { retryOfRequestId: input.retryOfRequestId } : {})
  });
}

export function findExecutionRecord(
  state: LocalSessionState,
  requestId: string
): InspectionExecutionRecord | undefined {
  return state.inspectionExecutions.find((record) => record.requestId === requestId);
}

export function normalizeInspectionQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

export function findRecentDuplicateExecution(
  state: LocalSessionState,
  input: {
    peerId: string;
    question: string;
    windowMs: number;
    threadId?: string;
  }
): InspectionExecutionRecord | undefined {
  const normalizedQuestion = normalizeInspectionQuestion(input.question);
  const cutoffMs = Date.now() - input.windowMs;

  for (const record of state.inspectionExecutions) {
    if (record.peerId !== input.peerId) {
      continue;
    }
    if (input.threadId && record.threadId !== input.threadId) {
      continue;
    }
    if (normalizeInspectionQuestion(record.question) !== normalizedQuestion) {
      continue;
    }
    if (Date.parse(record.startedAt) < cutoffMs) {
      continue;
    }
    if (
      record.status === "completed" ||
      record.status === "running" ||
      record.status === "pending"
    ) {
      return record;
    }
  }

  return undefined;
}

/**
 * Failed approval_required executions that should resume with the same requestId.
 * Uses the permission-request TTL (not the short duplicate-question window) so
 * human approval can take longer than 45s without minting a new requestId.
 */
export function findResumableApprovalRequiredExecution(
  state: LocalSessionState,
  input: {
    peerId: string;
    question: string;
    /** @deprecated Ignored — resume bound to permission TTL / requestId continuity. */
    windowMs?: number;
    threadId?: string;
    nowMs?: number;
    resumeWindowMs?: number;
  }
): InspectionExecutionRecord | undefined {
  const normalizedQuestion = normalizeInspectionQuestion(input.question);
  const nowMs = input.nowMs ?? Date.now();
  const resumeWindowMs = input.resumeWindowMs ?? PAIRMESH_PERMISSION_REQUEST_TTL_MS;
  const cutoffMs = nowMs - resumeWindowMs;

  for (const record of state.inspectionExecutions) {
    if (record.peerId !== input.peerId) {
      continue;
    }
    if (input.threadId && record.threadId !== input.threadId) {
      continue;
    }
    if (normalizeInspectionQuestion(record.question) !== normalizedQuestion) {
      continue;
    }
    // Prefer updatedAt (approval wait) over startedAt for the safety bound.
    const anchorMs = Date.parse(record.updatedAt ?? record.startedAt);
    if (anchorMs < cutoffMs) {
      continue;
    }
    if (record.status === "failed" && record.error?.code === "pairmesh.approval_required") {
      return record;
    }
  }

  return undefined;
}

export function upsertExecutionRecord(
  state: LocalSessionState,
  record: InspectionExecutionRecord
): InspectionExecutionRecord {
  const index = state.inspectionExecutions.findIndex(
    (candidate) => candidate.requestId === record.requestId
  );
  if (index >= 0) {
    state.inspectionExecutions[index] = record;
  } else {
    state.inspectionExecutions.unshift(record);
  }
  trimExecutions(state);
  return record;
}

export function updateExecutionProgress(
  state: LocalSessionState,
  requestId: string,
  event: InspectionProgressEvent
): InspectionExecutionRecord | undefined {
  const record = findExecutionRecord(state, requestId);
  if (!record) {
    return undefined;
  }

  const status = phaseToStatus(event.phase, record.status);
  const updated = InspectionExecutionRecordSchema.parse({
    ...record,
    status,
    phase: event.phase,
    ...(event.message ? { message: event.message } : {}),
    updatedAt: nowUtc()
  });
  upsertExecutionRecord(state, updated);
  return updated;
}

export function replaceInitiatorProgressEvents(
  state: LocalSessionState,
  requestId: string,
  progressEvents: InspectionExecutionRecord["progressEvents"]
): InspectionExecutionRecord | undefined {
  const record = findExecutionRecord(state, requestId);
  if (!record) {
    return undefined;
  }
  if (record.ownerRole === "receiver") {
    return record;
  }
  const updated = InspectionExecutionRecordSchema.parse({
    ...record,
    progressEvents: progressEvents ?? [],
    updatedAt: nowUtc()
  });
  upsertExecutionRecord(state, updated);
  return updated;
}

export function completeExecutionRecord(
  state: LocalSessionState,
  requestId: string,
  status: Exclude<InspectionExecutionStatus, "pending" | "running">,
  error?: { code: string; message: string }
): InspectionExecutionRecord | undefined {
  const record = findExecutionRecord(state, requestId);
  if (!record) {
    return undefined;
  }

  const phase = statusToPhase(status);
  const updated = InspectionExecutionRecordSchema.parse({
    ...record,
    status,
    phase,
    updatedAt: nowUtc(),
    completedAt: nowUtc(),
    ...(error ? { error } : {})
  });
  upsertExecutionRecord(state, updated);
  return updated;
}

export function attachA2ATaskReference(
  state: LocalSessionState,
  requestId: string,
  a2aTaskId: string,
  peerAgentUrl: string,
  remoteTaskState?: InspectionRemoteTaskState
): InspectionExecutionRecord | undefined {
  const record = findExecutionRecord(state, requestId);
  if (!record) {
    return undefined;
  }

  const now = nowUtc();
  const updated = InspectionExecutionRecordSchema.parse({
    ...record,
    peerAgentUrl,
    a2aTaskReference: {
      a2aTaskId,
      agent: { a2aAgentCardUrl: peerAgentUrl }
    },
    ...(remoteTaskState ? { remoteTaskState } : {}),
    // First remote dispatch starts the ACP deadline clock (post-approval resume too).
    ...(record.executionStartedAt ? {} : { executionStartedAt: now }),
    status: "running",
    updatedAt: now
  });
  upsertExecutionRecord(state, updated);
  return updated;
}

export function updateExecutionRemoteTask(
  state: LocalSessionState,
  requestId: string,
  remoteTaskState: InspectionRemoteTaskState
): InspectionExecutionRecord | undefined {
  const record = findExecutionRecord(state, requestId);
  if (!record) {
    return undefined;
  }

  const updated = InspectionExecutionRecordSchema.parse({
    ...record,
    remoteTaskState,
    updatedAt: nowUtc()
  });
  upsertExecutionRecord(state, updated);
  return updated;
}

export function setExecutionLocalWaitState(
  state: LocalSessionState,
  requestId: string,
  localWaitState: InspectionLocalWaitState
): InspectionExecutionRecord | undefined {
  const record = findExecutionRecord(state, requestId);
  if (!record) {
    return undefined;
  }

  const updated = InspectionExecutionRecordSchema.parse({
    ...record,
    localWaitState,
    updatedAt: nowUtc()
  });
  upsertExecutionRecord(state, updated);
  return updated;
}

export function cacheExecutionResult(
  state: LocalSessionState,
  requestId: string,
  result: InspectionExecutionResult,
  status: Extract<InspectionExecutionStatus, "completed"> = "completed"
): InspectionExecutionRecord | undefined {
  const record = findExecutionRecord(state, requestId);
  if (!record) {
    return undefined;
  }

  const updated = InspectionExecutionRecordSchema.parse({
    ...record,
    status,
    phase: "completed",
    result,
    completedAt: nowUtc(),
    updatedAt: nowUtc()
  });
  upsertExecutionRecord(state, updated);
  return updated;
}

export function buildElapsedProgress(
  requestId: string,
  startedAt: string,
  phase: InspectionProgressPhase,
  message: string
): InspectionProgressEvent {
  return {
    phase,
    message,
    elapsedMs: Date.now() - Date.parse(startedAt)
  };
}

function phaseToStatus(
  phase: InspectionProgressPhase,
  current: InspectionExecutionStatus
): InspectionExecutionStatus {
  switch (phase) {
    case "accepted":
    case "peer-reachable":
      return current === "pending" ? "pending" : "running";
    case "coding-agent-starting":
    case "inspecting":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    default:
      return current;
  }
}

function statusToPhase(status: InspectionExecutionStatus): InspectionProgressPhase {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    default:
      return "inspecting";
  }
}

function trimExecutions(state: LocalSessionState): void {
  if (state.inspectionExecutions.length > MAX_EXECUTIONS) {
    state.inspectionExecutions.length = MAX_EXECUTIONS;
  }
}

function nowUtc(): string {
  return IsoUtcTimestampSchema.parse(new Date().toISOString());
}
